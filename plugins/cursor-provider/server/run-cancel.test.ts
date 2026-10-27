// Run: node --test server/run-cancel.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error: `.ts` specifier required so node --test type-stripping resolves it (tsc Bundler mode maps extensionless/`.js`)
import { cancelRun } from "./run-cancel.ts";

/** Mirrors the SDK local run: status flips sync, the store write lands later. */
function fakeRun() {
  const run = {
    status: "running",
    stored: "RUNNING",
    calls: 0,
    async cancel() {
      run.calls += 1;
      if (run.status !== "running") return;
      run.status = "cancelled";
      await new Promise((resolve) => setTimeout(resolve, 20));
      run.stored = "CANCELLED";
    },
  };
  return run;
}

describe("cancelRun", () => {
  it("makes every caller wait for the store write", async () => {
    const run = fakeRun();
    const first = cancelRun(run);
    const second = cancelRun(run);
    await second;
    assert.equal(run.stored, "CANCELLED");
    await first;
    assert.equal(run.calls, 1);
  });

  it("swallows cancel failures", async () => {
    const run = { cancel: () => Promise.reject(new Error("boom")) };
    assert.equal(await cancelRun(run), undefined);
  });
});
