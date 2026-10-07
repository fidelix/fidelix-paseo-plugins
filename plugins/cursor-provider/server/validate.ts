import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { PluginSettings } from "@getpaseo/plugin/server";
import type { cursorSettings } from "../shared/settings.js";
import type { validateCursorKeyRpc } from "../shared/validate.js";
import { loadCursorSdk } from "./cursor-sdk-loader.js";

type CursorPluginSettings = PluginSettings<(typeof cursorSettings)["schema"]>;

type ValidateInput = RpcInput<typeof validateCursorKeyRpc>;
type ValidateOutput = RpcOutput<typeof validateCursorKeyRpc>;

// Key resolution mirrors server/provider.ts (kept duplicated on purpose so
// provider.ts stays untouched): explicit input wins, then host-scoped stored
// settings, then the daemon process environment.
function readProcessApiKey(): string | undefined {
  const fromProcess = process.env["CURSOR_API_KEY"];
  return fromProcess && fromProcess.length > 0 ? fromProcess : undefined;
}

async function readStoredApiKey(
  settings: CursorPluginSettings | undefined,
): Promise<string | undefined> {
  if (!settings) return undefined;
  try {
    const state = await settings.read();
    if (state.status !== "ready") return undefined;
    const key = state.values.apiKey;
    return key && key.length > 0 ? key : undefined;
  } catch {
    return undefined;
  }
}

export function createValidateKeyHandler(
  settings?: CursorPluginSettings,
): (input: ValidateInput) => Promise<ValidateOutput> {
  return async (input) => {
    const explicit = input.apiKey?.trim();
    const apiKey = explicit || (await readStoredApiKey(settings)) || readProcessApiKey();
    if (!apiKey) {
      return {
        ok: false,
        message: "No API key to check — paste one above or export CURSOR_API_KEY on the daemon host.",
      };
    }
    try {
      const { Cursor } = loadCursorSdk();
      const raw = (await Cursor.models.list({ apiKey })) as Array<{ id?: string }>;
      const count = Array.isArray(raw) ? raw.length : 0;
      return {
        ok: true,
        message:
          count > 0
            ? `Key is valid — ${count} model${count === 1 ? "" : "s"} available.`
            : "Key is valid.",
      };
    } catch (error) {
      return {
        ok: false,
        message: `Key check failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  };
}
