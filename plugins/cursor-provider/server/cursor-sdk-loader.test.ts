// Run: node --test server/cursor-sdk-loader.test.ts
// Loads the installed @cursor/sdk; no network.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";

const pluginDir = path.resolve(import.meta.dirname, "..");
process.env["CURSOR_PROVIDER_PLUGIN_DIR"] = pluginDir;
const loader = createRequire(path.join(pluginDir, "package.json"))("./server/cursor-sdk-loader.js") as {
  loadCursorSdk(): { Agent: { create: unknown } };
  cursorSummarizeSupported(): boolean;
  CURSOR_SUMMARIZE_PROMPT: string;
};

describe("cursor-sdk loader", () => {
  it("rewrites the local executor so /compact sends summarizeAction", () => {
    assert.equal(typeof loader.loadCursorSdk().Agent.create, "function");
    // Fails on an SDK upgrade that moves the action site; re-derive the patch.
    assert.equal(loader.cursorSummarizeSupported(), true);
    assert.match(loader.CURSOR_SUMMARIZE_PROMPT, /^\u0000.+\u0000$/);
  });
});
