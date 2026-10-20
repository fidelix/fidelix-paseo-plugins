// Zero-spend unit tests for server/local-store.ts legacy import and orphaned-run recovery.
// Run: node --test server/local-store.test.ts
// Uses an in-memory store; no SDK, no network.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  CursorLocalAgentDocument,
  CursorLocalAgentRunDocument,
  CursorLocalAgentStore,
} from "./cursor-sdk-loader.js";
// @ts-expect-error: `.ts` specifier required so node --test type-stripping resolves it (tsc Bundler mode maps extensionless/`.js`)
import { importLegacyAgent, listLegacyAgents, readNdjson, settleOrphanedRun, sqliteStateRoot } from "./local-store.ts";

function memoryStore(options: { failCheckpoint?: boolean } = {}) {
  const agents = new Map<string, CursorLocalAgentDocument>();
  const runs = new Map<string, CursorLocalAgentRunDocument>();
  const blobs = new Map<string, Uint8Array>();
  const store: CursorLocalAgentStore = {
    agents: {
      get: async ({ agentId }) => agents.get(agentId) ?? null,
      create: async ({ agent }) => {
        if (agents.has(agent.agentId)) throw new Error("exists");
        agents.set(agent.agentId, agent);
      },
      update: async ({ agent }) => void agents.set(agent.agentId, agent),
      delete: async ({ filter }) => filter.agentIds?.forEach((id) => agents.delete(id)),
    },
    runs: {
      get: async ({ agentId, runId }) => runs.get(`${agentId}/${runId}`) ?? null,
      create: async ({ run }) => void runs.set(`${run.agentId}/${run.runId}`, run),
      update: async ({ run }) => void runs.set(`${run.agentId}/${run.runId}`, run),
      delete: async ({ filter }) => {
        for (const key of [...runs.keys()]) {
          if (filter.agentIds?.some((id) => key.startsWith(`${id}/`))) runs.delete(key);
        }
      },
    },
    checkpoints: {
      create: async ({ agentId, blobId, data }) => {
        if (options.failCheckpoint) throw new Error("disk full");
        blobs.set(`${agentId}/${blobId}`, data);
      },
      delete: async ({ filter }) => {
        for (const key of [...blobs.keys()]) {
          if (filter.agentIds?.some((id) => key.startsWith(`${id}/`))) blobs.delete(key);
        }
      },
    },
  };
  return { store, agents, runs, blobs };
}

function ndjson(rows: unknown[], tail = ""): string {
  return rows.map((row) => JSON.stringify(row)).join("\n") + "\n" + tail;
}

function legacyRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "cursor-legacy-"));
  const agent = (agentId: string, extra: Record<string, unknown> = {}) => ({
    agentId,
    cwd: "/work/a",
    status: "idle",
    activeRunId: null,
    createdAt: 1,
    updatedAt: 1,
    ...extra,
  });
  writeFileSync(
    path.join(root, "agents.ndjson"),
    ndjson([
      agent("agent-1", { status: "running", activeRunId: "run-2" }),
      agent("agent-2"),
      agent("agent-3", { cwd: "/work/b" }),
      agent("agent-4", { status: "archived" }),
    ]),
  );
  writeFileSync(
    path.join(root, "runs.ndjson"),
    ndjson([
      { runId: "run-1", agentId: "agent-1", status: "finished", turnNumber: 1, createdAt: 1, updatedAt: 1 },
      { runId: "run-2", agentId: "agent-1", status: "running", turnNumber: 2, createdAt: 2, updatedAt: 2 },
      { runId: "run-9", agentId: "agent-2", status: "queued", turnNumber: 1, createdAt: 2, updatedAt: 2 },
    ]),
  );
  writeFileSync(
    path.join(root, "checkpoints.ndjson"),
    ndjson(
      [
        { agentId: "agent-1", blobId: "b1", dataBase64: Buffer.from("one").toString("base64") },
        { agentId: "agent-2", blobId: "b2", dataBase64: Buffer.from("two").toString("base64") },
        { agentId: "agent-1", blobId: "b3", dataBase64: Buffer.from("three").toString("base64") },
      ],
      '{"agentId":"agent-1","blobId":"b4","dataBa', // interrupted append
    ),
  );
  return root;
}

describe("readNdjson", () => {
  it("yields nothing for a missing file", async () => {
    const rows = [];
    for await (const row of readNdjson(path.join(tmpdir(), "missing-cursor-store.ndjson"))) rows.push(row);
    assert.deepEqual(rows, []);
  });

  it("skips a truncated tail but rejects a corrupt middle row", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "cursor-ndjson-"));
    const ok = path.join(root, "ok.ndjson");
    writeFileSync(ok, '{"a":1}\n\n{"a":2}\n{"a":');
    const rows = [];
    for await (const row of readNdjson(ok)) rows.push(row);
    assert.deepEqual(rows, [{ a: 1 }, { a: 2 }]);
    const bad = path.join(root, "bad.ndjson");
    writeFileSync(bad, '{"a":1}\n{"a":\n{"a":3}\n');
    await assert.rejects(async () => {
      for await (const _ of readNdjson(bad)) void _;
    });
  });
});

describe("importLegacyAgent", () => {
  it("copies only the requested agent and settles its orphaned run", async () => {
    const root = legacyRoot();
    const { store, agents, runs, blobs } = memoryStore();
    assert.equal(await importLegacyAgent(store, "state", root, "agent-1"), "imported");
    assert.deepEqual([...agents.keys()], ["agent-1"]);
    const agent = agents.get("agent-1")!;
    assert.equal(agent.status, "idle");
    assert.equal(agent.activeRunId, null);
    assert.equal(runs.get("agent-1/run-1")!.status, "finished");
    assert.equal(runs.get("agent-1/run-2")!.status, "cancelled");
    assert.equal(runs.has("agent-2/run-9"), false);
    assert.deepEqual([...blobs.keys()].sort(), ["agent-1/b1", "agent-1/b3"]);
    assert.equal(Buffer.from(blobs.get("agent-1/b3")!).toString(), "three");
    assert.equal(await importLegacyAgent(store, "state", root, "agent-1"), "present");
  });

  it("reports absent agents and shares one import between concurrent callers", async () => {
    const root = legacyRoot();
    const { store, blobs } = memoryStore();
    assert.equal(await importLegacyAgent(store, "state", root, "agent-x"), "absent");
    const results = await Promise.all([
      importLegacyAgent(store, "state", root, "agent-2"),
      importLegacyAgent(store, "state", root, "agent-2"),
    ]);
    assert.deepEqual(results, ["imported", "imported"]);
    assert.deepEqual([...blobs.keys()], ["agent-2/b2"]);
  });

  it("rolls back a failed import so the next resume retries", async () => {
    const root = legacyRoot();
    const { store, agents, runs } = memoryStore({ failCheckpoint: true });
    await assert.rejects(importLegacyAgent(store, "state", root, "agent-1"), /disk full/);
    assert.equal(agents.size, 0);
    assert.equal(runs.size, 0);
  });
});

describe("listLegacyAgents", () => {
  it("lists unarchived agents of one cwd", async () => {
    const root = legacyRoot();
    const listed = await listLegacyAgents(root, "/work/a");
    assert.deepEqual(listed.map((agent: CursorLocalAgentDocument) => agent.agentId), ["agent-1", "agent-2"]);
    assert.deepEqual(await listLegacyAgents(path.join(root, "nope"), "/work/a"), []);
  });
});

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
