// Local agent persistence for the Cursor SDK runtime.
//
// Sessions use the SDK's SQLite store (`@cursor/sdk/sqlite`): indexed rows
// plus one blob database per agent, so a read or write touches only the rows
// it needs. Do not switch to `JsonlLocalAgentStore`: it re-reads, re-parses
// and rewrites a whole NDJSON file on every operation, and with every agent
// sharing one store the plugin process ran out of heap within minutes.
import { createHash } from "node:crypto";
import path from "node:path";
import { loadCursorSdkSqlite } from "./cursor-sdk-loader.js";
import type {
  CursorLocalAgentDocument,
  CursorLocalAgentRunDocument,
  CursorLocalAgentStore,
} from "./cursor-sdk-loader.js";

const TERMINAL_RUN_STATUSES = new Set(["finished", "error", "cancelled", "expired"]);

/** One open store per state root, shared by every session in that workspace. */
const openStores = new Map<string, Promise<CursorLocalAgentStore>>();

/**
 * SQLite state root for a workspace: `<root>/sqlite/<sha256(cwd)>`. Scoped per
 * cwd because the SDK store filters agents by its `workspaceRef`.
 */
export function sqliteStateRoot(root: string, cwd: string): string {
  const digest = createHash("sha256").update(path.resolve(cwd)).digest("hex").slice(0, 32);
  return path.join(root, "sqlite", digest);
}

export function openLocalStore(root: string, cwd: string): Promise<CursorLocalAgentStore> {
  const stateRoot = sqliteStateRoot(root, cwd);
  let store = openStores.get(stateRoot);
  if (!store) {
    const { SqliteLocalAgentStore } = loadCursorSdkSqlite();
    store = SqliteLocalAgentStore.open({ workspaceRef: cwd, stateRoot });
    // A failed open must not be cached: the next session retries it.
    store.catch(() => {
      if (openStores.get(stateRoot) === store) openStores.delete(stateRoot);
    });
    openStores.set(stateRoot, store);
  }
  return store;
}

export async function closeLocalStores(): Promise<void> {
  const stores = [...openStores.values()];
  openStores.clear();
  await Promise.all(
    stores.map((store) => store.then((opened) => opened.dispose?.()).catch(() => undefined)),
  );
}

/**
 * A run the store still marks queued/running after the process that owned it
 * died (plugin crash, reload) blocks every later send with "Agent … already
 * has active run". Callers must only use this when no run for the agent is
 * live in this process. Marks the run cancelled and frees the agent; returns
 * the settled run id, or null when there was nothing to settle.
 */
export async function settleOrphanedRun(
  store: CursorLocalAgentStore,
  agentId: string,
): Promise<string | null> {
  const agent = await store.agents.get({ agentId });
  if (!agent?.activeRunId) return null;
  const run = await store.runs.get({ agentId, runId: agent.activeRunId });
  if (run && TERMINAL_RUN_STATUSES.has(run.status)) return null;
  const now = Date.now();
  if (run) await store.runs.update({ run: settledRun(run, now) });
  await store.agents.update({ agent: settledAgent(agent, now) });
  return agent.activeRunId;
}

function settledRun(run: CursorLocalAgentRunDocument, now: number): CursorLocalAgentRunDocument {
  return { ...run, status: "cancelled", updatedAt: now, endedAt: now };
}

function settledAgent(agent: CursorLocalAgentDocument, now: number): CursorLocalAgentDocument {
  return {
    ...agent,
    activeRunId: null,
    status: agent.status === "running" ? "idle" : agent.status,
    updatedAt: now,
  };
}
