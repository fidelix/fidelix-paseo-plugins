// Zero-spend unit tests for server/session-env.ts.
// Run: node --test server/session-env.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
// @ts-expect-error: `.ts` specifier required so node --test type-stripping resolves it (tsc Bundler mode maps extensionless/`.js`)
import { sessionResourceProviderOptions, shellEnv } from "./session-env.ts";

describe("shellEnv", () => {
  it("passes the session env through without the plugin's own settings", () => {
    assert.deepEqual(
      shellEnv({
        PASEO_AGENT_ID: "9ff4f488",
        PASEO_WORKSPACE_ID: "wks_1",
        CURSOR_API_KEY: "secret",
        CURSOR_SDK_STATE_ROOT: "/state",
      }),
      { PASEO_AGENT_ID: "9ff4f488", PASEO_WORKSPACE_ID: "wks_1" },
    );
  });
});

describe("sessionResourceProviderOptions", () => {
  it("gives the shell executor the session env on every command", () => {
    const options = sessionResourceProviderOptions({ PASEO_AGENT_ID: "a", CURSOR_API_KEY: "secret" });
    assert.deepEqual(options.shellExtraEnvProvider(), { PASEO_AGENT_ID: "a" });
    assert.deepEqual(options.shellExtraEnvProvider(), { PASEO_AGENT_ID: "a" });
  });

  it("still reaches the installed SDK's shell executor", () => {
    const entry = createRequire(import.meta.url).resolve("@cursor/sdk");
    const dist = path.dirname(entry);
    const wired = readdirSync(dist)
      .filter((file) => file.endsWith(".js"))
      .some((file) => /extraEnvProvider:\w+\.shellExtraEnvProvider\b/.test(readFileSync(path.join(dist, file), "utf8")));
    assert.ok(wired, "@cursor/sdk no longer reads shellExtraEnvProvider; sessions would lose PASEO_AGENT_ID");
  });
});
