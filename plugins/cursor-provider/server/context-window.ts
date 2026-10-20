// Context-window fill for the Paseo indicator.
//
// Cursor's public run usage (`result.usage`, the `usage` stream event) is a
// billed sum across every model call in the turn. Compaction makes that sum
// meaningless as a window fill: calls from before the summary are counted in
// full, then the conversation shrinks. The SDK docs and Cursor staff both say
// per-step context size is not on the public API.
//
// The local runtime does persist the real fill. Each agent checkpoint is a
// ConversationStateStructure protobuf, and field 5 is ConversationTokenDetails
// (`used_tokens`, `max_tokens`), the same accounting as the IDE context ring,
// rewritten whenever the conversation state changes, including after a summary.
// Field numbers are from @cursor/sdk 1.0.36 (agent.v1.ConversationTokenDetails).
import type { CursorLocalAgentStore } from "./cursor-sdk-loader.js";

export interface ContextWindow {
  usedTokens: number;
  maxTokens: number;
}

const TOKEN_DETAILS_FIELD = 5;
const USED_TOKENS_FIELD = 1;
const MAX_TOKENS_FIELD = 2;

/** Decode `used_tokens` / `max_tokens` from a checkpoint blob. */
export function contextWindowFromCheckpoint(bytes: Uint8Array): ContextWindow | undefined {
  const details = lastLengthField(bytes, TOKEN_DETAILS_FIELD);
  if (!details) return undefined;
  const used = lastVarintField(details, USED_TOKENS_FIELD);
  const max = lastVarintField(details, MAX_TOKENS_FIELD);
  if (used === undefined || max === undefined || max <= 0) return undefined;
  return { usedTokens: used, maxTokens: max };
}

/**
 * Latest checkpoint for an agent. A just-finished run's ref wins over the
 * agent row: that blob is the conversation state after this turn, summary
 * included.
 */
export async function readAgentContextWindow(
  store: CursorLocalAgentStore,
  agentId: string,
  runId?: string,
): Promise<ContextWindow | undefined> {
  if (!store.checkpoints) return undefined;
  if (runId) {
    const run = await store.runs.get({ agentId, runId });
    const fromRun = await windowFromRef(store, agentId, run?.latestCheckpointRef);
    if (fromRun) return fromRun;
  }
  const agent = await store.agents.get({ agentId });
  return windowFromRef(store, agentId, agent?.latestCheckpoint);
}

async function windowFromRef(
  store: CursorLocalAgentStore,
  agentId: string,
  ref: { rootBlobId?: string; blobId?: string } | null | undefined,
): Promise<ContextWindow | undefined> {
  const blobId = checkpointBlobId(ref);
  if (!blobId || !store.checkpoints) return undefined;
  const bytes = await store.checkpoints.get({ agentId, blobId });
  if (!bytes || bytes.byteLength === 0) return undefined;
  return contextWindowFromCheckpoint(bytes);
}

function checkpointBlobId(ref: { rootBlobId?: string; blobId?: string } | null | undefined): string | undefined {
  if (!ref) return undefined;
  if (typeof ref.rootBlobId === "string" && ref.rootBlobId.length > 0) return ref.rootBlobId;
  if (typeof ref.blobId === "string" && ref.blobId.length > 0) return ref.blobId;
  return undefined;
}

function lastLengthField(buf: Uint8Array, field: number): Uint8Array | undefined {
  let found: Uint8Array | undefined;
  forEachField(buf, (number, wire, value) => {
    if (number === field && wire === 2 && value instanceof Uint8Array) found = value;
  });
  return found;
}

function lastVarintField(buf: Uint8Array, field: number): number | undefined {
  let found: number | undefined;
  forEachField(buf, (number, wire, value) => {
    if (number !== field || typeof value !== "number") return;
    if (wire === 0 || wire === 1) found = value;
  });
  return found;
}

function forEachField(
  buf: Uint8Array,
  visit: (field: number, wire: number, value: number | Uint8Array) => void,
): void {
  let i = 0;
  while (i < buf.length) {
    const key = readVarint(buf, i);
    if (!key) return;
    i = key.next;
    const field = Number(key.value >> 3n);
    const wire = Number(key.value & 7n);
    if (field <= 0) return;
    if (wire === 0) {
      const val = readVarint(buf, i);
      if (!val) return;
      i = val.next;
      const asNumber = toSafeNumber(val.value);
      if (asNumber === undefined) return;
      visit(field, wire, asNumber);
      continue;
    }
    if (wire === 1) {
      if (i + 8 > buf.length) return;
      const asNumber = toSafeNumber(readFixed64(buf, i));
      i += 8;
      if (asNumber === undefined) return;
      visit(field, wire, asNumber);
      continue;
    }
    if (wire === 5) {
      if (i + 4 > buf.length) return;
      i += 4;
      continue;
    }
    if (wire === 2) {
      const len = readVarint(buf, i);
      if (!len) return;
      i = len.next;
      const size = Number(len.value);
      if (!Number.isSafeInteger(size) || size < 0 || i + size > buf.length) return;
      visit(field, wire, buf.subarray(i, i + size));
      i += size;
      continue;
    }
    return;
  }
}

function readVarint(buf: Uint8Array, offset: number): { value: bigint; next: number } | undefined {
  let value = 0n;
  let shift = 0n;
  let i = offset;
  while (i < buf.length && shift <= 63n) {
    const byte = buf[i]!;
    i += 1;
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value, next: i };
    shift += 7n;
  }
  return undefined;
}

function readFixed64(buf: Uint8Array, offset: number): bigint {
  let value = 0n;
  for (let i = 0; i < 8; i += 1) value |= BigInt(buf[offset + i]!) << BigInt(i * 8);
  return value;
}

function toSafeNumber(value: bigint): number | undefined {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
  return Number(value);
}
