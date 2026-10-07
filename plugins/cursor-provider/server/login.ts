import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { PluginSettings } from "@getpaseo/plugin/server";
import type { cursorSettings } from "../shared/settings.js";
import type {
  cursorLoginStatusRpc,
  startCursorLoginRpc,
} from "../shared/validate.js";
import { loadCursorSdk } from "./cursor-sdk-loader.js";

type CursorPluginSettings = PluginSettings<(typeof cursorSettings)["schema"]>;

type LoginStartOutput = RpcOutput<typeof startCursorLoginRpc>;
type LoginStatusOutput = RpcOutput<typeof cursorLoginStatusRpc>;

// Browser sign-in window: matches the SDK's own login UX expectations. After
// this long without completion the daemon stops polling; the user can start
// the flow again from the settings screen.
export const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

interface LoginAttempt {
  loginUrl: string;
  startedAt: number;
  timer: ReturnType<typeof setTimeout>;
  /** Resolves when the background poll settles (success, failure, expiry). */
  done: Promise<void>;
  cancel: () => void;
}

export interface LoginManager {
  start(): Promise<LoginStartOutput>;
  status(): Promise<LoginStatusOutput>;
  shutdown(): Promise<void>;
}

export function createLoginManager(_settings?: CursorPluginSettings): LoginManager {
  void _settings;
  let attempt: LoginAttempt | null = null;

  async function storeApiKey(apiKey: string): Promise<void> {
    void apiKey;
    // Nothing to do: login() already persisted to ~/.cursor/sdk/auth.json,
    // and every SDK call falls back to it (explicit apiKey → CURSOR_API_KEY
    // → stored login key).
  }

  function clearAttempt(): void {
    attempt = null;
  }

  async function start(): Promise<LoginStartOutput> {
    if (attempt) {
      return {
        ok: true,
        loginUrl: attempt.loginUrl,
        message: "Sign-in already in progress — open the link to continue.",
      };
    }
    const { Cursor } = loadCursorSdk();
    let loginUrl = "";
    let aborted = false;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
      if (attempt?.loginUrl === loginUrl) clearAttempt();
    }, LOGIN_TIMEOUT_MS);
    // Avoid an unref'd timer keeping the plugin subprocess alive; fall back
    // gracefully on runtimes where unref is unavailable.
    (timer as unknown as { unref?: () => void }).unref?.();

    const run = (async (): Promise<void> => {
      try {
        const result = (await Cursor.auth.login({
          openBrowser: false,
          apiKeyName: "Paseo",
          signal: controller.signal,
          onLoginUrl: (url: string) => {
            loginUrl = url;
          },
        })) as { apiKey?: string; email?: string };
        if (!result?.apiKey) throw new Error("Sign-in completed without an API key.");
        await storeApiKey(result.apiKey);
        clearAttempt();
      } catch (error) {
        clearAttempt();
        if (!aborted) {
          console.error(
            `cursor login failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    })();

    // Wait briefly for onLoginUrl so the first response already carries the
    // URL; the poll continues in the background regardless.
    const startedAt = Date.now();
    while (!loginUrl && Date.now() - startedAt < 15000) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      if (controller.signal.aborted) break;
    }
    if (!loginUrl) {
      aborted = true;
      controller.abort();
      clearTimeout(timer);
      try {
        await run;
      } catch {
        // Error already logged in run(); fall through to the failure below.
      }
      return { ok: false, message: "Could not start Cursor sign-in. Try again." };
    }

    const done = run.then(
      () => undefined,
      () => undefined,
    );
    attempt = {
      loginUrl,
      startedAt,
      timer,
      done,
      cancel: () => {
        aborted = true;
        controller.abort();
        clearTimeout(timer);
        clearAttempt();
      },
    };
    // Surface background failures in logs, not as unhandled rejections.
    // (The run() body already logs and clears; this just awaits settlement.)
    void done;
    return { ok: true, loginUrl, message: "Open the link to sign in with Cursor." };
  }

  async function status(): Promise<LoginStatusOutput> {
    // Fast path first: the SDK's own login store is the source of truth.
    // A completed login flips here even if our in-memory attempt already
    // cleared (e.g. after the 5-minute timer or a reload mid-flow).
    try {
      const { Cursor } = loadCursorSdk();
      const state = (await Cursor.auth.status()) as
        | { status: "logged-out" }
        | { status: "logged-in"; email?: string };
      if (state.status === "logged-in") {
        if (attempt) attempt.cancel();
        return {
          phase: "done",
          email: state.email,
          message: state.email ? `Signed in as ${state.email}.` : "Signed in.",
        };
      }
    } catch {
      // Fall through: a status probe failure is not a login state.
    }
    if (attempt) {
      const remainingMs = LOGIN_TIMEOUT_MS - (Date.now() - attempt.startedAt);
      if (remainingMs <= 0) {
        attempt.cancel();
        return {
          phase: "expired",
          message: "Sign-in timed out after 5 minutes. Start again from the settings screen.",
        };
      }
      return {
        phase: "waiting",
        loginUrl: attempt.loginUrl,
        message: "Waiting for browser sign-in…",
      };
    }
    return { phase: "idle", message: "Not signed in." };
  }

  async function shutdown(): Promise<void> {
    attempt?.cancel();
    attempt = null;
  }

  return { start, status, shutdown };
}

export type StartLoginInput = RpcInput<typeof startCursorLoginRpc>;
