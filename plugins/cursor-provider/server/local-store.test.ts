// Zero-spend unit tests for server/local-store.ts orphaned-run recovery.
// Run: node --test server/local-store.test.ts
// Uses an in-memory store; no SDK, no network.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import type {
  CursorLocalAgentDocument,
  CursorLocalAgentRunDocument,
  CursorLocalAgentStore,
} from "./cursor-sdk-loader.js";
// @ts-expect-error: `.ts` specifier required so node --test type-stripping resolves it (tsc Bundler mode maps extensionless/`.js`)
import { settleOrphanedRun, sqliteStateRoot } from "./local-store.ts";

function memoryStore() {
  const agents = new Map<string, CursorLocalAgentDocument>();
  const runs = new Map<string, CursorLocalAgentRunDocument>();
  const store: CursorLocalAgentStore = {
    agents: {
      get: async ({ agentId }) => agents.get(agentId) ?? null,
      update: async ({ agent }) => void agents.set(agent.agentId, agent),
    },
    runs: {
      get: async ({ agentId, runId }) => runs.get(`${agentId}/${runId}`) ?? null,
      update: async ({ run }) => void runs.set(`${run.agentId}/${run.runId}`, run),
    },
  };
  return { store, agents, runs };
}

describe("settleOrphanedRun", () => {
  it("cancels a non-terminal active run and frees the agent", async () => {
    const { store, agents, runs } = memoryStore();
    agents.set("a", { agentId: "a", cwd: "/w", status: "running", activeRunId: "r", updatedAt: 1 });
    runs.set("a/r", { agentId: "a", runId: "r", status: "queued", updatedAt: 1 });
    assert.equal(await settleOrphanedRun(store, "a"), "r");
    assert.equal(runs.get("a/r")!.status, "cancelled");
    assert.equal(typeof runs.get("a/r")!.endedAt, "number");
    assert.equal(agents.get("a")!.activeRunId, null);
    assert.equal(agents.get("a")!.status, "idle");
    assert.equal(await settleOrphanedRun(store, "a"), null);
  });

  it("frees the agent when its active run row is missing", async () => {
    const { store, agents } = memoryStore();
    agents.set("a", { agentId: "a", cwd: "/w", status: "idle", activeRunId: "gone", updatedAt: 1 });
    assert.equal(await settleOrphanedRun(store, "a"), "gone");
    assert.equal(agents.get("a")!.activeRunId, null);
  });

  it("leaves terminal runs and unknown agents alone", async () => {
    const { store, agents, runs } = memoryStore();
    agents.set("a", { agentId: "a", cwd: "/w", status: "idle", activeRunId: "r", updatedAt: 1 });
    runs.set("a/r", { agentId: "a", runId: "r", status: "finished", updatedAt: 1 });
    assert.equal(await settleOrphanedRun(store, "a"), null);
    assert.equal(agents.get("a")!.activeRunId, "r");
    assert.equal(await settleOrphanedRun(store, "missing"), null);
  });
});

describe("sqliteStateRoot", () => {
  it("is stable per cwd and distinct across cwds", () => {
    assert.equal(sqliteStateRoot("/s", "/w/a"), sqliteStateRoot("/s", "/w/a/"));
    assert.notEqual(sqliteStateRoot("/s", "/w/a"), sqliteStateRoot("/s", "/w/b"));
    assert.ok(sqliteStateRoot("/s", "/w/a").startsWith(path.join("/s", "sqlite")));
  });
});
