// Zero-spend unit tests for checkpoint context-window decoding.
// Run: node --test server/context-window.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error: `.ts` specifier required so node --test type-stripping resolves it (tsc Bundler mode maps extensionless/`.js`)
import { contextWindowFromCheckpoint, readAgentContextWindow } from "./context-window.ts";
import type { CursorLocalAgentStore } from "./cursor-sdk-loader.js";

function varint(value: number): number[] {
  const bytes: number[] = [];
  let rest = value;
  while (rest > 0x7f) {
    bytes.push((rest & 0x7f) | 0x80);
    rest = Math.floor(rest / 128);
  }
  bytes.push(rest);
  return bytes;
}

function tag(field: number, wire: number): number[] {
  return varint((field << 3) | wire);
}

function varintField(field: number, value: number): Uint8Array {
  return Uint8Array.from([...tag(field, 0), ...varint(value)]);
}

function bytesField(field: number, payload: Uint8Array): Uint8Array {
  return Uint8Array.from([...tag(field, 2), ...varint(payload.length), ...payload]);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

describe("contextWindowFromCheckpoint", () => {
  it("reads used and max from token_details, ignoring the hash list and breakdown", () => {
    const details = concat(
      varintField(1, 171_670),
      varintField(2, 300_000),
      bytesField(3, Uint8Array.from([0x0a, 0x04, 0x6d, 0x63, 0x70, 0x00])),
    );
    const checkpoint = concat(
      bytesField(1, new Uint8Array(32)),
      bytesField(1, new Uint8Array(32)),
      bytesField(5, details),
      varintField(10, 1),
    );
    assert.deepEqual(contextWindowFromCheckpoint(checkpoint), { usedTokens: 171_670, maxTokens: 300_000 });
  });

  it("uses the last token_details if a checkpoint repeats the field", () => {
    const first = concat(varintField(1, 10), varintField(2, 300_000));
    const second = concat(varintField(1, 50_000), varintField(2, 256_000));
    const checkpoint = concat(bytesField(5, first), bytesField(5, second));
    assert.deepEqual(contextWindowFromCheckpoint(checkpoint), { usedTokens: 50_000, maxTokens: 256_000 });
  });

  it("returns undefined when the checkpoint has no token details", () => {
    assert.equal(contextWindowFromCheckpoint(concat(bytesField(1, new Uint8Array(32)))), undefined);
    assert.equal(contextWindowFromCheckpoint(Uint8Array.from([0xff, 0xff, 0xff])), undefined);
    assert.equal(contextWindowFromCheckpoint(new Uint8Array()), undefined);
  });

  it("rejects a zero max", () => {
    const details = concat(varintField(1, 10), varintField(2, 0));
    assert.equal(contextWindowFromCheckpoint(bytesField(5, details)), undefined);
  });
});

describe("readAgentContextWindow", () => {
  it("prefers the run checkpoint over the agent row", async () => {
    const runBlob = bytesField(5, concat(varintField(1, 80_000), varintField(2, 300_000)));
    const agentBlob = bytesField(5, concat(varintField(1, 1), varintField(2, 300_000)));
    const blobs = new Map<string, Uint8Array>([
      ["run-blob", runBlob],
      ["agent-blob", agentBlob],
    ]);
    const store = {
      agents: {
        get: async () => ({
          agentId: "a",
          cwd: "/w",
          status: "idle" as const,
          updatedAt: 1,
          latestCheckpoint: { rootBlobId: "agent-blob" },
        }),
        update: async () => undefined,
      },
      runs: {
        get: async () => ({
          runId: "r",
          agentId: "a",
          status: "finished" as const,
          updatedAt: 1,
          latestCheckpointRef: { rootBlobId: "run-blob" },
        }),
        update: async () => undefined,
      },
      checkpoints: {
        get: async ({ blobId }: { agentId: string; blobId: string }) => blobs.get(blobId) ?? null,
      },
    } as CursorLocalAgentStore;
    assert.deepEqual(await readAgentContextWindow(store, "a", "r"), { usedTokens: 80_000, maxTokens: 300_000 });
    assert.deepEqual(await readAgentContextWindow(store, "a"), { usedTokens: 1, maxTokens: 300_000 });
  });

  it("falls back to the agent checkpoint when the run blob has no token details", async () => {
    const agentBlob = bytesField(5, concat(varintField(1, 4_000), varintField(2, 300_000)));
    const store = {
      agents: {
        get: async () => ({
          agentId: "a",
          cwd: "/w",
          status: "idle" as const,
          updatedAt: 1,
          latestCheckpoint: { rootBlobId: "agent-blob" },
        }),
        update: async () => undefined,
      },
      runs: {
        get: async () => ({
          runId: "r",
          agentId: "a",
          status: "finished" as const,
          updatedAt: 1,
          latestCheckpointRef: { rootBlobId: "empty" },
        }),
        update: async () => undefined,
      },
      checkpoints: {
        get: async ({ blobId }: { agentId: string; blobId: string }) =>
          blobId === "agent-blob" ? agentBlob : bytesField(1, new Uint8Array(4)),
      },
    } as CursorLocalAgentStore;
    assert.deepEqual(await readAgentContextWindow(store, "a", "r"), { usedTokens: 4_000, maxTokens: 300_000 });
  });

  it("accepts the on-disk blobId shape", async () => {
    const blob = bytesField(5, concat(varintField(1, 12), varintField(2, 128_000)));
    const store = {
      agents: {
        get: async () => ({
          agentId: "a",
          cwd: "/w",
          status: "idle" as const,
          updatedAt: 1,
          latestCheckpoint: { blobId: "disk" },
        }),
        update: async () => undefined,
      },
      runs: { get: async () => null, update: async () => undefined },
      checkpoints: {
        get: async () => blob,
      },
    } as CursorLocalAgentStore;
    assert.deepEqual(await readAgentContextWindow(store, "a"), { usedTokens: 12, maxTokens: 128_000 });
  });
});
