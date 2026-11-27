import type { ProviderConnection } from "@getpaseo/plugin/server/provider";
import { closeDiagnostics, installDiagnostics } from "./diagnostics.js";
import { closeLocalStores } from "./local-store.js";
import { installProviderProcessGuard } from "./process-guard.js";
import { createCursorProvider, type CursorPluginSettings } from "./provider.js";
import type {
  ConnectionInfo,
  HostMessage,
  SettingsState,
  WorkerMessage,
  WorkerRequest,
} from "./provider-worker-protocol.js";

installProviderProcessGuard();
installDiagnostics();

let nextSettingsReadId = 0;
const settingsReads = new Map<number, (state: SettingsState | null) => void>();
const settingsListeners = new Set<Parameters<CursorPluginSettings["subscribe"]>[0]>();
const connections = new Map<number, ProviderConnection>();
const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
let shuttingDown = false;

function send(message: WorkerMessage): void {
  if (process.connected) process.send?.(message, () => undefined);
}

const settings: CursorPluginSettings = {
  read() {
    return new Promise<SettingsState>((resolve, reject) => {
      const id = ++nextSettingsReadId;
      settingsReads.set(id, (state) => {
        if (state) resolve(state);
        else reject(new Error("Could not read Cursor plugin settings"));
      });
      send({ type: "settings.read", id });
    });
  },
  subscribe(listener) {
    settingsListeners.add(listener);
    return () => {
      settingsListeners.delete(listener);
    };
  },
};

const provider = createCursorProvider({ settings });

function connectionFor(id: number): ProviderConnection {
  const connection = connections.get(id);
  if (!connection) throw new Error("Cursor connection is closed");
  return connection;
}

async function dispatch(request: WorkerRequest): Promise<ConnectionInfo | void> {
  if (shuttingDown) throw new Error("Cursor worker is shutting down");
  switch (request.type) {
    case "connect": {
      if (process.versions.electron || nodeMajor < 22 || (nodeMajor === 22 && nodeMinor < 13)) {
        throw new Error(
          "Cursor needs standalone Node.js 22.13 or later. Set CURSOR_PROVIDER_NODE to its executable or make it available on the Paseo daemon PATH.",
        );
      }
      const { connectionId, input } = request;
      const connection = await provider.connect(input);
      connections.set(connectionId, connection);
      connection.onEvent((event) => send({ type: "event", connectionId, event }));
      return { version: connection.version, capabilities: connection.capabilities };
    }
    case "send":
      await connectionFor(request.connectionId).send(request.input);
      break;
    case "close": {
      const connection = connectionFor(request.connectionId);
      connections.delete(request.connectionId);
      await connection.close();
      break;
    }
    case "shutdown":
      shuttingDown = true;
      await Promise.allSettled([...connections.values()].map((connection) => connection.close()));
      await closeLocalStores();
      await closeDiagnostics();
      break;
  }
}

process.on("message", (message: HostMessage) => {
  switch (message.type) {
    case "settings.result": {
      const resolve = settingsReads.get(message.id);
      settingsReads.delete(message.id);
      resolve?.(message.state);
      break;
    }
    case "settings.changed":
      for (const listener of settingsListeners) void listener(message.state);
      break;
    case "request":
      void dispatch(message.request).then(
        (value) => send({ type: "result", id: message.id, value: value ?? undefined }),
        (error) =>
          send({
            type: "result",
            id: message.id,
            error: error instanceof Error ? error.message : String(error),
          }),
      );
      break;
  }
});

process.once("disconnect", () => process.exit(0));
