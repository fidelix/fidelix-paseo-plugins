import { fork, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import type {
  ProviderConnection,
  ProviderRegistration,
} from "@getpaseo/plugin/server/provider";
import { cursorPluginDirectory } from "./cursor-sdk-loader.js";
import type { CursorPluginSettings } from "./provider.js";
import type {
  ConnectionInfo,
  HostMessage,
  WorkerMessage,
  WorkerRequest,
} from "./provider-worker-protocol.js";

export function createProviderWorker(settings: CursorPluginSettings): {
  connect: ProviderRegistration["connect"];
  close(): Promise<void>;
} {
  type Listener = Parameters<ProviderConnection["onEvent"]>[0];
  type Pending = {
    resolve(value: ConnectionInfo | undefined): void;
    reject(error: Error): void;
  };
  const pending = new Map<number, Pending>();
  const connections = new Map<number, Set<Listener>>();
  let nextId = 0;
  let child: ChildProcess | undefined;
  let unsubscribe: (() => void) | undefined;
  let closing = false;

  function post(worker: ChildProcess, message: HostMessage): void {
    if (worker.connected) worker.send(message, () => undefined);
  }

  function start(): ChildProcess {
    const pluginDir = cursorPluginDirectory();
    const entry = path.join(pluginDir, "dist", "provider-worker.cjs");
    if (!existsSync(entry)) {
      throw new Error("Cursor provider worker is missing. Run npm run build:worker in the plugin directory.");
    }
    const env: NodeJS.ProcessEnv = { ...process.env, CURSOR_PROVIDER_PLUGIN_DIR: pluginDir };
    delete env["ELECTRON_RUN_AS_NODE"];
    const worker = fork(entry, [], {
      execPath: env["CURSOR_PROVIDER_NODE"] || "node",
      execArgv: [],
      env,
      // Provider messages are JSON. V8's binary format can differ between the
      // desktop helper and the standalone Node version on the daemon PATH.
      serialization: "json",
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    });
    child = worker;
    const fail = (error: Error) => {
      if (child !== worker) return;
      child = undefined;
      unsubscribe?.();
      unsubscribe = undefined;
      for (const request of pending.values()) request.reject(error);
      pending.clear();
      if (!closing && connections.size > 0) {
        // The daemon treats plugin exit as a disconnect for every live session.
        console.error(error.message);
        process.exit(1);
      }
    };
    worker.once("error", (error) => {
      fail(new Error(
        `Could not start the Cursor provider worker: ${error.message}. Set CURSOR_PROVIDER_NODE to a standalone Node.js 22.13+ executable or check the Paseo daemon PATH.`,
      ));
    });
    worker.once("exit", (code, signal) => {
      fail(new Error(`Cursor provider worker exited (${signal ?? code})`));
    });
    worker.on("message", (message: WorkerMessage) => {
      switch (message.type) {
        case "result": {
          const request = pending.get(message.id);
          pending.delete(message.id);
          if (message.error !== undefined) request?.reject(new Error(message.error));
          else request?.resolve(message.value);
          break;
        }
        case "event":
          for (const listener of connections.get(message.connectionId) ?? []) listener(message.event);
          break;
        case "settings.read":
          void settings.read().then(
            (state) => post(worker, { type: "settings.result", id: message.id, state }),
            () => post(worker, { type: "settings.result", id: message.id, state: null }),
          );
          break;
      }
    });
    unsubscribe = settings.subscribe((state) => post(worker, { type: "settings.changed", state }));
    return worker;
  }

  async function request(worker: ChildProcess, input: WorkerRequest): Promise<ConnectionInfo | undefined> {
    if (worker !== child || !worker.connected) throw new Error("Cursor provider worker is disconnected");
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      const message: HostMessage = { type: "request", id, request: input };
      worker.send(message, (error) => {
        if (!error) return;
        pending.delete(id);
        reject(error);
      });
    });
  }

  return {
    async connect(input) {
      if (closing) throw new Error("Cursor provider worker is shutting down");
      const worker = child ?? start();
      const connectionId = ++nextId;
      const info = await request(worker, { type: "connect", connectionId, input });
      if (!info) throw new Error("Cursor provider worker did not return connection information");
      const listeners = new Set<Listener>();
      connections.set(connectionId, listeners);
      return {
        ...info,
        async send(input) {
          if (!connections.has(connectionId)) throw new Error("Cursor connection is closed");
          await request(worker, { type: "send", connectionId, input });
        },
        onEvent(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        async close() {
          if (!connections.has(connectionId)) return;
          try {
            await request(worker, { type: "close", connectionId });
          } finally {
            connections.delete(connectionId);
            listeners.clear();
          }
        },
      };
    },
    async close() {
      closing = true;
      const worker = child;
      if (!worker) return;
      const stop = setTimeout(() => worker.kill(), 3_000);
      stop.unref();
      try {
        await request(worker, { type: "shutdown" });
      } catch {
        // A dead worker has already released its resources.
      } finally {
        clearTimeout(stop);
        worker.kill();
      }
    },
  };
}
