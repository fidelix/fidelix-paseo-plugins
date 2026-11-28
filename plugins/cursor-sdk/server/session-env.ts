// Session env for an agent's shells. Every Cursor session shares this
// process, so the session env cannot go through `process.env`; it goes
// through the SDK's per-agent shell env provider instead.
//
// `shellExtraEnvProvider` is private SDK API: the SDK spreads
// `local.resourceProviderOptions` into its local executor options, and the
// shell executor merges the provider's result into every command's env.
// `@cursor/sdk` is pinned to an exact version for this; session-env.test.ts
// checks the wiring on the installed SDK.

/** Plugin settings the session env carries that the agent's shells must not see. */
const WITHHELD_KEYS = new Set(["CURSOR_API_KEY", "CURSOR_SDK_STATE_ROOT"]);

export function shellEnv(env: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !WITHHELD_KEYS.has(key)));
}

export function sessionResourceProviderOptions(env: Readonly<Record<string, string>>): {
  shellExtraEnvProvider: () => Record<string, string>;
} {
  const shell = shellEnv(env);
  return { shellExtraEnvProvider: () => shell };
}
