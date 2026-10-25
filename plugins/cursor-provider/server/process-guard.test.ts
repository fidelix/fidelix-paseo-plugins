// Zero-spend unit tests for server/process-guard.ts.
// Run: node --test server/process-guard.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error: `.ts` specifier required so node --test type-stripping resolves it (tsc Bundler mode maps extensionless/`.js`)
import { summarizeProcessError } from "./process-guard.ts";

describe("summarizeProcessError", () => {
  it("keeps the message and short frames and drops the executor source line", () => {
    const error = new Error("Invalid string length");
    error.name = "RangeError";
    error.stack = [
      "RangeError: Invalid string length",
      "    at writeTurn (/plugin/node_modules/@cursor/sdk/dist/cjs/867.js:1:120)",
      "/plugin/node_modules/@cursor/sdk/dist/cjs/867.js:1",
      `exports.id=867,${"x".repeat(2000)}`,
      "    at replay (provider.ts:10:5)",
    ].join("\n");
    const summary = summarizeProcessError(error);
    assert.match(summary, /^RangeError: Invalid string length/);
    assert.match(summary, /867\.js:1:120/);
    assert.match(summary, /provider\.ts:10:5/);
    assert.equal(summary.includes("exports.id=867"), false);
    assert.ok(summary.length < 1000);
  });

  it("clips a non-error value", () => {
    assert.equal(summarizeProcessError("boom"), "boom");
    assert.equal(summarizeProcessError("y".repeat(800)).length, 501);
  });
});
