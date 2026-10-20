// Local agent persistence for the Cursor SDK runtime.
//
// Sessions use the SDK's SQLite store (`@cursor/sdk/sqlite`): indexed rows
// plus one blob database per agent, so a read or write touches only the rows
// it needs. The plugin used to pass a `JsonlLocalAgentStore`, which re-reads,
// re-parses and rewrites a whole NDJSON file on every operation. One store was
// shared by every agent and grew without bound (185 MB of checkpoints after a
// day), so each checkpoint write cost ~1 GB of transient heap and five
// concurrent checkpoint reads ~2 GB: the plugin process died with
// "JavaScript heap out of memory" once a few agents ran at the same time.
//
// Agents created before the switch still live in the legacy JSONL files. They
// are imported into the SQLite store on first resume by streaming the files
// line by line, so memory stays bounded by the largest single row. The legacy
// files are only read, never modified or deleted.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { loadCursorSdkSqlite } from "./cursor-sdk-loader.js";
import type {
  CursorLocalAgentDocument,
  CursorLocalAgentRunDocument,
  CursorLocalAgentStore,
} from "./cursor-sdk-loader.js";

/** File names of the legacy `JsonlLocalAgentStore` layout (SDK JSONL_LOCAL_AGENT_STORE_FILES). */
const LEGACY_FILES = {
  agents: "agents.ndjson",
  runs: "runs.ndjson",
  checkpoints: "checkpoints.ndjson",
} as const;

const TERMINAL_RUN_STATUSES = new Set(["finished", "error", "cancelled", "expired"]);

/** One open store per state root, shared by every session in that workspace. */
const openStores = new Map<string, Promise<CursorLocalAgentStore>>();
/** In-flight legacy imports keyed by `${stateRoot}\0${agentId}`. */
const imports = new Map<string, Promise<LegacyImportResult>>();

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
 * Streams NDJSON rows without reading the file into one string. `keep` sees
 * the raw line first so rows of other agents are skipped without parsing.
 * Missing files yield nothing; a truncated final line (interrupted append) is
 * ignored, matching the SDK reader.
 */
export async function* readNdjson<T>(
  file: string,
  keep: (line: string) => boolean = () => true,
): AsyncGenerator<T> {
  const stream = createReadStream(file, { encoding: "utf8" });
  const opened = await new Promise<boolean>((resolve, reject) => {
    stream.once("open", () => resolve(true));
    stream.once("error", (error: NodeJS.ErrnoException) =>
      error.code === "ENOENT" ? resolve(false) : reject(error),
    );
  });
  if (!opened) return;
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let pending: string | null = null;
  try {
    for await (const line of lines) {
      if (pending !== null) yield JSON.parse(pending) as T;
      pending = line.trim().length > 0 && keep(line) ? line : null;
    }
    if (pending !== null) {
      try {
        yield JSON.parse(pending) as T;
      } catch {
        // Truncated tail from an interrupted write.
      }
    }
  } finally {
    lines.close();
    stream.destroy();
  }
}

/** Raw-line prefilter: legacy rows are `JSON.stringify`d with `agentId` as a top-level string. */
function mentionsAgent(agentId: string): (line: string) => boolean {
  const needle = `"agentId":${JSON.stringify(agentId)}`;
  return (line) => line.includes(needle);
}

export async function findLegacyAgent(
  legacyRoot: string,
  agentId: string,
): Promise<CursorLocalAgentDocument | null> {
  let found: CursorLocalAgentDocument | null = null;
  for await (const row of readNdjson<CursorLocalAgentDocument>(
    path.join(legacyRoot, LEGACY_FILES.agents),
    mentionsAgent(agentId),
  )) {
    if (row.agentId === agentId) found = row;
  }
  return found;
}

/** Legacy agents for a cwd, for the sessions list before they are imported. */
export async function listLegacyAgents(
  legacyRoot: string,
  cwd: string,
): Promise<CursorLocalAgentDocument[]> {
  const out: CursorLocalAgentDocument[] = [];
  try {
    for await (const row of readNdjson<CursorLocalAgentDocument>(
      path.join(legacyRoot, LEGACY_FILES.agents),
    )) {
      if (row.cwd === cwd && row.status !== "archived") out.push(row);
    }
  } catch {
    // Unreadable legacy store: list nothing from it.
  }
  return out;
}

export type LegacyImportResult = "present" | "imported" | "absent";

/**
 * Copies one agent (agent row, runs, checkpoint blobs) from the legacy JSONL
 * layout into `store`, unless the store already has it. Run events are not
 * copied: they only back live run streams, and every legacy run is over.
 * An orphaned active run is settled on the way in (see settleOrphanedRun).
 */
export function importLegacyAgent(
  store: CursorLocalAgentStore,
  stateRoot: string,
  legacyRoot: string,
  agentId: string,
): Promise<LegacyImportResult> {
  const key = `${stateRoot}\0${agentId}`;
  let pending = imports.get(key);
  if (!pending) {
    pending = runLegacyImport(store, legacyRoot, agentId).finally(() => imports.delete(key));
    imports.set(key, pending);
  }
  return pending;
}

async function runLegacyImport(
  store: CursorLocalAgentStore,
  legacyRoot: string,
  agentId: string,
): Promise<LegacyImportResult> {
  if (await store.agents.get({ agentId })) return "present";
  const legacyAgent = await findLegacyAgent(legacyRoot, agentId);
  if (!legacyAgent) return "absent";
  // No legacy run can still be live: the JSONL store is never opened anymore.
  const now = Date.now();
  const runs: CursorLocalAgentRunDocument[] = [];
  for await (const run of readNdjson<CursorLocalAgentRunDocument>(
    path.join(legacyRoot, LEGACY_FILES.runs),
    mentionsAgent(agentId),
  )) {
    if (run.agentId === agentId) runs.push(settledRun(run, now));
  }
  await store.agents.create({ agent: settledAgent(legacyAgent, now) });
  try {
    for (const run of runs) await store.runs.create({ run });
    for await (const row of readNdjson<{ agentId: string; blobId: string; dataBase64: string }>(
      path.join(legacyRoot, LEGACY_FILES.checkpoints),
      mentionsAgent(agentId),
    )) {
      if (row.agentId !== agentId) continue;
      await store.checkpoints.create({
        agentId,
        blobId: row.blobId,
        data: Buffer.from(row.dataBase64, "base64"),
      });
    }
  } catch (error) {
    // Leave no half-imported agent behind: the next resume starts over.
    await store.checkpoints.delete({ filter: { agentIds: [agentId] } }).catch(() => undefined);
    await store.runs.delete({ filter: { agentIds: [agentId] } }).catch(() => undefined);
    await store.agents.delete({ filter: { agentIds: [agentId] } }).catch(() => undefined);
    throw error;
  }
  return "imported";
}

function settledRun(run: CursorLocalAgentRunDocument, now: number): CursorLocalAgentRunDocument {
  if (TERMINAL_RUN_STATUSES.has(run.status)) return run;
  return { ...run, status: "cancelled", updatedAt: now, endedAt: now };
}

function settledAgent(agent: CursorLocalAgentDocument, now: number): CursorLocalAgentDocument {
  if (!agent.activeRunId && agent.status !== "running") return agent;
  return {
    ...agent,
    activeRunId: null,
    status: agent.status === "running" ? "idle" : agent.status,
    updatedAt: now,
  };
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
