// Zero-spend unit tests for server/diagnostics.ts. Exercises the real hooks:
// node:sqlite, a local HTTP/2 server, and the OTel global the SDK reads.
// Run: node --test server/diagnostics.test.ts
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import http2 from "node:http2";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  beginTurnDiagnostics,
  closeDiagnostics,
  describeError,
  diagnosticsFileName,
  expiredDiagnosticsFiles,
  h2CodeName,
  installDiagnostics,
  // @ts-expect-error: `.ts` specifier required so node --test type-stripping resolves it (tsc Bundler mode maps extensionless/`.js`)
} from "./diagnostics.ts";

type Json = Record<string, unknown>;

const OTEL_SPAN = Symbol.for("OpenTelemetry Context Key SPAN");

function otelTracer(): {
  startSpan(name: string, options?: unknown, context?: unknown): {
    setAttribute(key: string, value: unknown): unknown;
    recordException(error: unknown): void;
    setStatus(status: { code: number; message?: string }): unknown;
    end(): void;
  };
} {
  const api = (globalThis as Record<symbol, { trace?: { getTracer(name: string): never } }>)[
    Symbol.for("opentelemetry.js.api.1")
  ];
  assert.ok(api?.trace, "tracer provider registered");
  return api.trace.getTracer("context-tracer");
}

/** What the bundled API passes as the parent: a context whose span key holds the parent. */
function contextWith(span: unknown): { getValue(key: symbol): unknown } {
  return { getValue: (key) => (key === OTEL_SPAN ? span : undefined) };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("diagnostics helpers", () => {
  it("names files by local day and expires them by name", () => {
    assert.equal(diagnosticsFileName(new Date(2026, 9, 5, 23, 59)), "cursor-diag-2026-10-05.jsonl");
    const names = [
      "cursor-diag-2026-10-01.jsonl",
      "cursor-diag-2026-10-10.jsonl",
      "cursor-diag-2026-10-11.jsonl",
      "notes.txt",
    ];
    assert.deepEqual(expiredDiagnosticsFiles(names, new Date(2026, 9, 25, 12), 14), [
      "cursor-diag-2026-10-01.jsonl",
      "cursor-diag-2026-10-10.jsonl",
    ]);
  });

  it("describes an error with its code and cause", () => {
    const cause = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    const error = Object.assign(new Error("[unavailable] stream failed", { cause }), { name: "ConnectError", code: 14 });
    assert.equal(
      describeError(error),
      "ConnectError[14]: [unavailable] stream failed <- Error[ECONNRESET]: socket hang up",
    );
    assert.equal(describeError("plain"), "plain");
  });

  it("names HTTP/2 error codes", () => {
    assert.equal(h2CodeName(0), "NO_ERROR");
    assert.equal(h2CodeName(8), "CANCEL");
    assert.equal(h2CodeName(0x20), "0x20");
    assert.equal(h2CodeName(undefined), undefined);
  });
});

describe("diagnostics hooks", () => {
  let dir = "";
  let diagnostics: { flush(): Promise<void>; file: string } | null = null;

  async function records(kind?: string): Promise<Json[]> {
    await diagnostics!.flush();
    const text = await readFile(diagnostics!.file, "utf8");
    const all = text
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Json);
    return kind ? all.filter((record) => record["kind"] === kind) : all;
  }

  async function turnRecord(turnId: string): Promise<Json> {
    for (let i = 0; i < 20; i += 1) {
      const found = (await records("turn")).find((record) => record["turnId"] === turnId);
      if (found) return found;
      await sleep(10);
    }
    throw new Error(`no turn record for ${turnId}`);
  }

  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "cursor-diag-"));
    diagnostics = installDiagnostics({
      dir,
      stderr: false,
      loopTickMs: 20,
      loopStallMs: 150,
      sqliteSlowMs: 0,
      heartbeatMs: 3_600_000,
    });
    assert.ok(diagnostics);
  });

  after(async () => {
    await closeDiagnostics();
    await rm(dir, { recursive: true, force: true });
  });

  it("writes a start record listing the installed hooks", async () => {
    const [start] = await records("start");
    assert.ok(start);
    assert.deepEqual(start["hooks"], ["sqlite", "http2", "otel"]);
  });

  it("times node:sqlite statements", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB)");
    db.prepare("INSERT INTO blobs (id, data) VALUES (?, ?)").run("a", new Uint8Array(16));
    const row = db.prepare("SELECT data FROM blobs WHERE id = ?").get("a");
    db.close();
    assert.ok(row);
    const sql = (await records("sqlite_slow")).map((record) => String(record["sql"]));
    assert.ok(sql.includes("CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB)"));
    assert.ok(sql.includes("SELECT data FROM blobs WHERE id = ?"));
  });

  it("records an event-loop stall with the SQLite time inside it", async () => {
    const db = new DatabaseSync(":memory:");
    const until = Date.now() + 300;
    while (Date.now() < until) db.prepare("SELECT 1").get();
    db.close();
    await sleep(80);
    const stalls = await records("loop_stall");
    assert.ok(stalls.length > 0, "stall recorded");
    const stall = stalls.at(-1)!;
    assert.ok(Number(stall["ms"]) >= 150);
    assert.ok(Number(stall["sqliteCalls"]) > 0);
    assert.equal(typeof stall["gcMs"], "number");
  });

  it("attributes SDK spans to the turn by request id and flags the failure", async () => {
    const tracer = otelTracer();
    const run = tracer.startSpan("sdk.run");
    const attempt = tracer.startSpan("agent.request.attempt", undefined, contextWith(run));
    attempt.setAttribute("agent.attempt", 1);
    attempt.setAttribute("agent.request_id", "attempt-1");
    attempt.setAttribute("agent.original_request_id", "req-span");
    const rpc = tracer.startSpan("agent.v1.AgentService/Run", undefined, contextWith(attempt));
    rpc.recordException(Object.assign(new Error("stream stalled"), { name: "ConnectError", code: "deadline_exceeded" }));
    rpc.setStatus({ code: 2, message: "stream stalled" });
    rpc.end();
    attempt.end();
    run.end();

    const turn = beginTurnDiagnostics({ sessionId: "s1", turnId: "turn-span", agentId: "agent-1" });
    turn.attempt(1);
    turn.event({ type: "request", run_id: "run-1", request_id: "req-span" });
    turn.event({ type: "assistant", run_id: "run-1" });
    turn.event({ type: "usage", run_id: "run-1" });
    turn.event({ type: "assistant", run_id: "run-1" });
    turn.event({ type: "usage", run_id: "run-1" });
    turn.delta("text-delta");
    turn.note("cancel", { reason: "interrupt" });
    turn.end({
      status: "failed",
      error: { message: "Agent turn stopped after repeated resume attempts made no progress" },
    });

    const record = await turnRecord("turn-span");
    const flags = record["flags"] as string[];
    for (const flag of ["multiple_turn_ended", "no_progress", "sdk_span_errors", "cancel:interrupt"]) {
      assert.ok(flags.includes(flag), `flag ${flag}`);
    }
    assert.deepEqual(record["requestIds"], ["req-span"]);
    assert.deepEqual(record["eventsAfterTurnEnded"], { assistant: 1 });
    assert.equal(record["sdkAttempts"], 1);
    const timeline = (record["sdk"] as { timeline: Json[] }).timeline;
    const failed = timeline.find((entry) => entry["name"] === "agent.v1.AgentService/Run");
    assert.match(String(failed?.["error"]), /ConnectError\[deadline_exceeded\]: stream stalled/);
    const attemptEntry = timeline.find((entry) => entry["name"] === "agent.request.attempt");
    assert.equal((attemptEntry?.["attrs"] as Json)["agent.original_request_id"], "req-span");
  });

  it("records a peer stream reset and GOAWAY on the turn's agent stream", async () => {
    const server = http2.createServer();
    server.on("stream", (stream: http2.ServerHttp2Stream) => {
      stream.on("error", () => undefined);
      stream.respond({ ":status": 200 });
      stream.write("partial");
      setTimeout(() => {
        stream.close(http2.constants.NGHTTP2_INTERNAL_ERROR);
        stream.session?.goaway(http2.constants.NGHTTP2_ENHANCE_YOUR_CALM);
      }, 30);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    const client = http2.connect(`http://127.0.0.1:${port}`);
    client.on("error", () => undefined);
    const stream = client.request({
      ":method": "POST",
      ":path": "/agent.v1.AgentService/Run",
      "x-request-id": "attempt-h2",
      "x-original-request-id": "req-h2",
    });
    // Write side stays open like an agent bidi stream; a half-closed stream
    // ends with END_STREAM instead of the reset under test.
    stream.on("error", () => undefined);
    stream.on("data", () => undefined);
    await new Promise<void>((resolve) => stream.once("close", () => resolve()));
    await sleep(30);
    client.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));

    const turn = beginTurnDiagnostics({ sessionId: "s1", turnId: "turn-h2" });
    turn.attempt(1);
    turn.event({ type: "request", run_id: "run-2", request_id: "req-h2" });
    turn.end({ status: "failed", error: { message: "[unavailable] stream reset" } });

    const record = await turnRecord("turn-h2");
    const [attempt] = record["attempts"] as Json[];
    assert.ok(attempt);
    assert.equal(attempt["path"], "/agent.v1.AgentService/Run");
    assert.equal(attempt["requestId"], "attempt-h2");
    assert.equal(attempt["originalRequestId"], "req-h2");
    assert.equal(attempt["rst"], "INTERNAL_ERROR");
    assert.equal(attempt["closedBy"], "peer");
    assert.equal(attempt["aborted"], true);
    assert.equal(attempt["status"], 200);
    assert.equal(attempt["bytesIn"], "partial".length);
    const goaways = await records("http2_goaway");
    assert.ok(goaways.some((event) => event["code"] === "ENHANCE_YOUR_CALM"));
  });

  it("returns a no-op tracker when diagnostics are off", async () => {
    await closeDiagnostics();
    const turn = beginTurnDiagnostics({ sessionId: "s2", turnId: "turn-off" });
    turn.event({ type: "usage" });
    turn.end({ status: "completed" });
    diagnostics = installDiagnostics({ dir, stderr: false, heartbeatMs: 3_600_000 });
    assert.ok(diagnostics);
    assert.equal((await records("turn")).some((record) => record["turnId"] === "turn-off"), false);
  });
});
