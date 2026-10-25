// Records what the Cursor SDK hides when a turn goes wrong. Local runs log
// through a no-op backend and `run.wait()` keeps only `{message, code}`, so the
// cause behind "resume attempts made no progress" never reaches stderr. This
// collects it from outside the SDK:
//
// - the SDK's own OpenTelemetry spans (attempts, RPC failures, transcript
//   rewrites), through a tracer in the global OTel API slot
// - HTTP/2 sessions and streams opened through `http2.connect` (connect-node)
// - `node:sqlite` statement time; the SDK store runs synchronously on this thread
// - event-loop stalls and GC pauses
//
// One JSON object per line in `<dir>/cursor-diag-YYYY-MM-DD.jsonl`. Failed or
// flagged turns and transport trouble are echoed to stderr (the daemon log).
// Prompts, output, and headers other than request ids are never recorded.

import { createWriteStream, mkdirSync, statSync, type WriteStream } from "node:fs";
import { readdir, stat, unlink } from "node:fs/promises";
import type { ClientHttp2Session, ClientHttp2Stream } from "node:http2";
import { homedir } from "node:os";
import path from "node:path";
import { performance, PerformanceObserver } from "node:perf_hooks";

type Json = Record<string, unknown>;
type Primitive = string | number | boolean;

export interface DiagnosticsOptions {
  dir: string;
  /** Echo failed or flagged turns and transport trouble to stderr. */
  stderr: boolean;
  loopTickMs: number;
  /** Event-loop lag that counts as a stall. */
  loopStallMs: number;
  sqliteSlowMs: number;
  heartbeatMs: number;
  /** Per-day file cap; later records that day are dropped. */
  maxFileBytes: number;
  retentionDays: number;
}

export interface TurnInfo {
  sessionId: string;
  turnId: string;
  agentId?: string;
  model?: string;
  /** Label to SQLite file. Sized (with `-wal`) when a turn ends badly. */
  storeFiles?: Record<string, string>;
}

export interface TurnOutcome {
  status: "completed" | "failed" | "canceled";
  error?: { message: string; code?: string };
}

export interface TurnDiagnostics {
  /**
   * The run `Agent.send` returned. Its `requestId` is the `x-original-request-id`
   * of every SDK attempt, known before the stream's `request` event (which never
   * comes when the first attempts fail).
   */
  run(run: { id: string; requestId?: string }): void;
  /** Every `run.stream()` event, before the provider filters it. */
  event(event: { type: string; run_id?: string; request_id?: string }): void;
  /** Every `send` onDelta update type. */
  delta(type: string): void;
  /** Provider-level `Agent.send` attempt number. */
  attempt(attempt: number): void;
  note(kind: string, detail?: Json): void;
  end(outcome: TurnOutcome): void;
}

export const DEFAULT_DIAGNOSTICS_OPTIONS: Omit<DiagnosticsOptions, "dir"> = {
  stderr: true,
  loopTickMs: 100,
  loopStallMs: 500,
  sqliteSlowMs: 100,
  heartbeatMs: 5 * 60_000,
  maxFileBytes: 64 * 1024 * 1024,
  retentionDays: 14,
};

const NOOP_TURN: TurnDiagnostics = {
  run() {},
  event() {},
  delta() {},
  attempt() {},
  note() {},
  end() {},
};

/** Spans that always go on a turn's timeline. Others need an error or SLOW_SPAN_MS. */
const TIMELINE_SPANS = new Set(["sdk.run", "networkPhase", "agent.request.attempt", "handshakeEstablishment"]);
const SLOW_SPAN_MS = 250;
/** Per-attempt stream controllers live exactly as long as the attempt; slow says nothing. */
const ATTEMPT_LIFETIME_SPAN = /(Controller|Manager)\.run$/;
const MAX_TIMELINE = 80;
const MAX_SPAN_NAMES = 64;
const MAX_TRACKED_REQUESTS = 300;
const MAX_NOTES = 50;
const STDERR_PER_MINUTE = 20;
const GC_RING_MIN_MS = 5;

const H2_CODES = [
  "NO_ERROR",
  "PROTOCOL_ERROR",
  "INTERNAL_ERROR",
  "FLOW_CONTROL_ERROR",
  "SETTINGS_TIMEOUT",
  "STREAM_CLOSED",
  "FRAME_SIZE_ERROR",
  "REFUSED_STREAM",
  "CANCEL",
  "COMPRESSION_ERROR",
  "CONNECT_ERROR",
  "ENHANCE_YOUR_CALM",
  "INADEQUATE_SECURITY",
  "HTTP_1_1_REQUIRED",
];

// The SDK bundles @opentelemetry/api 1.9.0. It reads the provider from this
// global on every span and accepts a registration at its own version.
const OTEL_API = Symbol.for("opentelemetry.js.api.1");
const OTEL_API_VERSION = "1.9.0";
const OTEL_SPAN = Symbol.for("OpenTelemetry Context Key SPAN");
const OTEL_STATUS_ERROR = 2;
// All-zero ids are what the SDK sends today with no tracer, so request
// headers stay unchanged.
const INVALID_SPAN_CONTEXT = Object.freeze({ traceId: "0".repeat(32), spanId: "0".repeat(16), traceFlags: 0 });

// Patches outlive a plugin module reload in the same process; they look up the
// live instance here instead of closing over one.
const HUB = Symbol.for("cursor-provider.diagnostics");

interface Hub {
  current: Diagnostics | null;
  attempted: Set<string>;
  hooks: Set<string>;
}

function hub(): Hub {
  const scope = globalThis as typeof globalThis & { [HUB]?: Hub };
  return (scope[HUB] ??= { current: null, attempted: new Set(), hooks: new Set() });
}

export function defaultDiagnosticsDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env["CURSOR_PROVIDER_DIAGNOSTICS_DIR"]) return env["CURSOR_PROVIDER_DIAGNOSTICS_DIR"];
  const base = env["CURSOR_SDK_STATE_ROOT"] || path.join(homedir(), ".cursor", "sdk");
  return path.join(base, "paseo-plugin", "diagnostics");
}

/** Idempotent. `CURSOR_PROVIDER_DIAGNOSTICS=0` turns it off. Call before the SDK loads. */
export function installDiagnostics(overrides: Partial<DiagnosticsOptions> = {}): Diagnostics | null {
  const state = hub();
  if (state.current) return state.current;
  if (process.env["CURSOR_PROVIDER_DIAGNOSTICS"] === "0") return null;
  const diagnostics = new Diagnostics({
    ...DEFAULT_DIAGNOSTICS_OPTIONS,
    dir: defaultDiagnosticsDir(),
    ...overrides,
  });
  state.current = diagnostics;
  installHooks(state);
  diagnostics.start([...state.hooks]);
  return diagnostics;
}

export async function closeDiagnostics(): Promise<void> {
  const state = hub();
  const current = state.current;
  state.current = null;
  await current?.stop();
}

export function beginTurnDiagnostics(info: TurnInfo): TurnDiagnostics {
  return hub().current?.beginTurn(info) ?? NOOP_TURN;
}

export function diagnosticsFileName(at: Date): string {
  const day = `${at.getFullYear()}-${pad2(at.getMonth() + 1)}-${pad2(at.getDate())}`;
  return `cursor-diag-${day}.jsonl`;
}

export function expiredDiagnosticsFiles(names: string[], now: Date, retentionDays: number): string[] {
  const cutoff = diagnosticsFileName(new Date(now.getTime() - retentionDays * 86_400_000));
  return names.filter((name) => /^cursor-diag-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name) && name < cutoff);
}

/** `Name[code]: message <- cause`, clipped. */
export function describeError(error: unknown): string {
  return clip(describeErrorChain(error, 0), 600);
}

function describeErrorChain(error: unknown, depth: number): string {
  if (error === null || typeof error !== "object") return String(error);
  const name = String(Reflect.get(error, "name") ?? "Error");
  const code = Reflect.get(error, "code");
  const message = String(Reflect.get(error, "message") ?? "");
  const head = `${name}${code !== undefined && code !== null && code !== "" ? `[${String(code)}]` : ""}: ${message}`;
  const cause = Reflect.get(error, "cause");
  return cause !== undefined && depth < 2 ? `${head} <- ${describeErrorChain(cause, depth + 1)}` : head;
}

export function h2CodeName(code: number | undefined): string | undefined {
  if (code === undefined) return undefined;
  return H2_CODES[code] ?? `0x${code.toString(16)}`;
}

interface Stat {
  count: number;
  ms: number;
  maxMs: number;
  errors: number;
}

interface SpanEntry {
  at: number;
  name: string;
  ms: number;
  error?: string;
  attrs?: Record<string, Primitive>;
}

interface SpanRoot {
  requestIds: Set<string>;
  byName: Map<string, Stat>;
  timeline: SpanEntry[];
}

interface Stall {
  at: number;
  ms: number;
  sqliteMs: number;
  sqliteCalls: number;
  slowestSql?: { ms: number; sql: string };
  gcMs?: number;
  spansEnded: Json[];
  spansOpen: string[];
  heapUsedMb: number;
  activeTurns: number;
}

interface SlowSql {
  at: number;
  ms: number;
  sql: string;
}

interface H2Event extends Json {
  at: number;
  kind: string;
}

interface H2Session {
  id: number;
  authority: string;
  openedAt: number;
  open: number;
  streams: number;
  pings: number;
  maxPingMs: number;
  failedPings: number;
  goaway?: Json;
  error?: string;
}

interface StreamState {
  path: string;
  requestId?: string;
  originalRequestId?: string;
  startedAt: number;
  responseAt: number;
  lastDataAt: number;
  lastWriteAt: number;
  bytesIn: number;
  chunksIn: number;
  chunksOut: number;
  status?: number;
  grpcStatus?: string;
  grpcMessage?: string;
  clientCloseCode?: number;
  aborted: boolean;
  error?: string;
}

export interface StreamSummary extends Json {
  path: string;
  requestId?: string;
  session: number;
  startedAt: number;
  ms: number;
  closedBy: "clean" | "client" | "peer" | "session" | "error";
  silentMs: number;
}

interface Window {
  startedAt: number;
  maxLagMs: number;
  stalls: number;
  stallMs: number;
  gcCount: number;
  gcMs: number;
  gcMaxMs: number;
  sqlCalls: number;
  sqlMs: number;
  sqlShapes: Map<string, Stat>;
  spans: Map<string, Stat>;
  spanErrors: number;
  streams: number;
  abnormalStreams: number;
  goaways: number;
  sessionErrors: number;
  turns: number;
  failedTurns: number;
}

function freshWindow(): Window {
  return {
    startedAt: Date.now(),
    maxLagMs: 0,
    stalls: 0,
    stallMs: 0,
    gcCount: 0,
    gcMs: 0,
    gcMaxMs: 0,
    sqlCalls: 0,
    sqlMs: 0,
    sqlShapes: new Map(),
    spans: new Map(),
    spanErrors: 0,
    streams: 0,
    abnormalStreams: 0,
    goaways: 0,
    sessionErrors: 0,
    turns: 0,
    failedTurns: 0,
  };
}

export class Diagnostics {
  readonly options: DiagnosticsOptions;
  private readonly sink: JsonlSink;
  private stopped = false;
  private timers: NodeJS.Timeout[] = [];
  private gcObserver: PerformanceObserver | null = null;
  private readonly stderrBudget = new Map<string, { since: number; count: number }>();

  readonly sqlTotal = { calls: 0, ms: 0 };
  readonly gcTotal = { count: 0, ms: 0 };
  private tickSql = { calls: 0, ms: 0 };
  private tickSlowestSql: { ms: number; sql: string } | undefined;
  private readonly tickSpans = new Map<string, Stat>();
  private readonly openSpans = new Map<string, number>();
  private expectedTick = 0;
  private pendingStall: Stall | null = null;
  private window = freshWindow();

  private readonly stalls = new Ring<Stall>(500);
  private readonly slowSql = new Ring<SlowSql>(500);
  private readonly gcPauses = new Ring<{ at: number; ms: number }>(2000);
  private readonly h2Events = new Ring<H2Event>(500);
  private readonly streamsByRequest = new Map<string, StreamSummary[]>();
  private readonly rootsByRequest = new Map<string, SpanRoot>();
  private readonly activeTurns = new Set<TurnRecorder>();
  private readonly h2Open = { sessions: 0, streams: 0 };
  private sessionSeq = 0;

  constructor(options: DiagnosticsOptions) {
    this.options = options;
    this.sink = new JsonlSink(options.dir, options.maxFileBytes, () => void this.prune());
  }

  get file(): string {
    return path.join(this.options.dir, diagnosticsFileName(new Date()));
  }

  start(hooks: string[]): void {
    this.write({
      kind: "start",
      node: process.versions.node,
      electron: process.versions["electron"],
      platform: process.platform,
      arch: process.arch,
      hooks,
      loopStallMs: this.options.loopStallMs,
      sqliteSlowMs: this.options.sqliteSlowMs,
    });
    this.expectedTick = performance.now() + this.options.loopTickMs;
    this.timers.push(setInterval(() => this.tick(), this.options.loopTickMs));
    this.timers.push(setInterval(() => this.heartbeat(), this.options.heartbeatMs));
    for (const timer of this.timers) timer.unref();
    try {
      this.gcObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) this.recordGc(performance.timeOrigin + entry.startTime, entry.duration);
      });
      this.gcObserver.observe({ entryTypes: ["gc"] });
    } catch {
      this.gcObserver = null;
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    this.gcObserver?.disconnect();
    this.gcObserver = null;
    this.heartbeat();
    this.stopped = true;
    await this.sink.close();
  }

  flush(): Promise<void> {
    return this.sink.flush();
  }

  beginTurn(info: TurnInfo): TurnDiagnostics {
    const turn = new TurnRecorder(this, info);
    this.activeTurns.add(turn);
    return turn;
  }

  write(record: Json): void {
    if (this.stopped) return;
    this.sink.write({ ts: new Date().toISOString(), pid: process.pid, ...record });
  }

  private notable(record: Json, loud: boolean): void {
    this.write(record);
    if (loud) this.loud(record);
  }

  private loud(record: Json): void {
    if (!this.options.stderr || this.stopped) return;
    const kind = String(record["kind"]);
    const now = Date.now();
    const budget = this.stderrBudget.get(kind);
    if (!budget || now - budget.since >= 60_000) this.stderrBudget.set(kind, { since: now, count: 1 });
    else if (++budget.count > STDERR_PER_MINUTE) return;
    console.error(`cursor-sdk diag: ${clip(JSON.stringify(record), 4000)}`);
  }

  // ---- node:sqlite ----

  recordSql(ms: number, sql: () => string): void {
    this.sqlTotal.calls += 1;
    this.sqlTotal.ms += ms;
    this.tickSql.calls += 1;
    this.tickSql.ms += ms;
    this.window.sqlCalls += 1;
    this.window.sqlMs += ms;
    const text = sql();
    const shapes = this.window.sqlShapes;
    const key = shapes.has(text) || shapes.size < 100 ? text : "(other)";
    bumpStat(shapes, key, ms, false);
    if (!this.tickSlowestSql || ms > this.tickSlowestSql.ms) this.tickSlowestSql = { ms: round(ms), sql: clipSql(text) };
    if (ms < this.options.sqliteSlowMs) return;
    const slow = { at: Date.now() - Math.round(ms), ms: round(ms), sql: clipSql(text) };
    this.slowSql.push(slow);
    this.notable({ kind: "sqlite_slow", ...slow, at: new Date(slow.at).toISOString() }, ms >= 1000);
  }

  // ---- event loop and GC ----

  private recordGc(at: number, ms: number): void {
    this.gcTotal.count += 1;
    this.gcTotal.ms += ms;
    this.window.gcCount += 1;
    this.window.gcMs += ms;
    if (ms > this.window.gcMaxMs) this.window.gcMaxMs = ms;
    if (ms >= GC_RING_MIN_MS) this.gcPauses.push({ at, ms });
  }

  private tick(): void {
    const now = performance.now();
    const lag = now - this.expectedTick;
    this.expectedTick = now + this.options.loopTickMs;
    // GC entries for a stall arrive after it; finish the previous one a tick late.
    if (this.pendingStall) {
      this.finishStall(this.pendingStall);
      this.pendingStall = null;
    }
    if (lag > this.window.maxLagMs) this.window.maxLagMs = lag;
    if (lag >= this.options.loopStallMs) {
      this.pendingStall = {
        at: Date.now() - Math.round(lag),
        ms: Math.round(lag),
        sqliteMs: round(this.tickSql.ms),
        sqliteCalls: this.tickSql.calls,
        ...(this.tickSlowestSql ? { slowestSql: this.tickSlowestSql } : {}),
        spansEnded: topStats(this.tickSpans, 5),
        spansOpen: [...this.openSpans].filter(([, open]) => open > 0).map(([name]) => name).slice(0, 12),
        heapUsedMb: mb(process.memoryUsage().heapUsed),
        activeTurns: this.activeTurns.size,
      };
    }
    this.tickSql = { calls: 0, ms: 0 };
    this.tickSlowestSql = undefined;
    this.tickSpans.clear();
  }

  private finishStall(stall: Stall): void {
    const end = stall.at + stall.ms;
    const gcMs = this.gcPauses
      .since(stall.at - this.options.loopTickMs, (pause) => pause.at)
      .filter((pause) => pause.at <= end)
      .reduce((sum, pause) => sum + pause.ms, 0);
    const finished = { ...stall, gcMs: round(gcMs) };
    this.stalls.push(finished);
    this.window.stalls += 1;
    this.window.stallMs += stall.ms;
    this.notable({ kind: "loop_stall", ...finished, at: new Date(stall.at).toISOString() }, stall.ms >= 2000);
  }

  private heartbeat(): void {
    if (this.stopped) return;
    const w = this.window;
    const memory = process.memoryUsage();
    this.write({
      kind: "process",
      windowS: Math.round((Date.now() - w.startedAt) / 1000),
      rssMb: mb(memory.rss),
      heapUsedMb: mb(memory.heapUsed),
      heapTotalMb: mb(memory.heapTotal),
      externalMb: mb(memory.external),
      arrayBuffersMb: mb(memory.arrayBuffers),
      activeTurns: this.activeTurns.size,
      http2Open: { ...this.h2Open },
      loop: { maxLagMs: Math.round(w.maxLagMs), stalls: w.stalls, stallMs: w.stallMs },
      gc: { count: w.gcCount, ms: round(w.gcMs), maxMs: round(w.gcMaxMs) },
      sqlite: { calls: w.sqlCalls, ms: round(w.sqlMs), top: topStats(w.sqlShapes, 8, "sql") },
      spans: { errors: w.spanErrors, top: topStats(w.spans, 12) },
      http2: { streams: w.streams, abnormalStreams: w.abnormalStreams, goaways: w.goaways, sessionErrors: w.sessionErrors },
      turns: { finished: w.turns, failed: w.failedTurns },
    });
    this.window = freshWindow();
  }

  // ---- OpenTelemetry spans ----

  startSpan(name: string, parent: DiagSpan | null): DiagSpan {
    this.openSpans.set(name, (this.openSpans.get(name) ?? 0) + 1);
    return new DiagSpan(this, name, parent);
  }

  spanAttribute(span: DiagSpan, key: string, value: unknown): void {
    if ((key === "agent.original_request_id" || key === "agent.request_id") && typeof value === "string") {
      if (!span.root.requestIds.has(value)) {
        span.root.requestIds.add(value);
        remember(this.rootsByRequest, value, span.root, MAX_TRACKED_REQUESTS);
      }
    }
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") return;
    span.attrs ??= {};
    if (!(key in span.attrs) && Object.keys(span.attrs).length >= 24) return;
    span.attrs[key] = typeof value === "string" ? clip(value, 200) : value;
  }

  spanEnded(span: DiagSpan, ms: number): void {
    const open = (this.openSpans.get(span.startName) ?? 1) - 1;
    if (open > 0) this.openSpans.set(span.startName, open);
    else this.openSpans.delete(span.startName);
    const failed = span.error !== undefined;
    bumpStat(this.tickSpans, span.name, ms, failed);
    if (this.window.spans.has(span.name) || this.window.spans.size < 200) bumpStat(this.window.spans, span.name, ms, failed);
    if (span.root.byName.has(span.name) || span.root.byName.size < MAX_SPAN_NAMES) {
      bumpStat(span.root.byName, span.name, ms, failed);
    }
    if (failed) this.window.spanErrors += 1;
    const slow = ms >= SLOW_SPAN_MS && !ATTEMPT_LIFETIME_SPAN.test(span.name);
    if (!failed && !TIMELINE_SPANS.has(span.name) && !slow) return;
    if (span.root.timeline.length >= MAX_TIMELINE) return;
    const attrs = compactAttrs(span);
    span.root.timeline.push({
      at: span.startedAt,
      name: span.name,
      ms: round(ms),
      ...(failed ? { error: span.error } : {}),
      ...(attrs ? { attrs } : {}),
    });
  }

  // ---- HTTP/2 ----

  watchSession(session: ClientHttp2Session, authority: unknown): void {
    const record: H2Session = {
      id: ++this.sessionSeq,
      authority: authorityOf(authority),
      openedAt: Date.now(),
      open: 0,
      streams: 0,
      pings: 0,
      maxPingMs: 0,
      failedPings: 0,
    };
    this.h2Open.sessions += 1;
    const age = () => Date.now() - record.openedAt;
    session.on("goaway", (errorCode: number, lastStreamID: number, opaqueData?: Buffer) => {
      record.goaway = {
        errorCode,
        code: h2CodeName(errorCode),
        lastStreamID,
        ...(opaqueData && opaqueData.length > 0 ? { debug: clip(opaqueData.toString("utf8"), 200) } : {}),
      };
      this.window.goaways += 1;
      this.h2Event(
        { kind: "http2_goaway", session: record.id, authority: record.authority, ageMs: age(), openStreams: record.open, ...record.goaway },
        errorCode !== 0 || record.open > 0,
      );
    });
    session.on("frameError", (type: number, code: number, streamId: number) => {
      this.h2Event({ kind: "http2_frame_error", session: record.id, frameType: type, code: h2CodeName(code), streamId }, true);
    });
    session.on("error", (error: unknown) => {
      record.error = describeError(error);
      this.window.sessionErrors += 1;
      this.h2Event(
        { kind: "http2_session_error", session: record.id, authority: record.authority, ageMs: age(), openStreams: record.open, error: record.error },
        true,
      );
    });
    session.once("close", () => {
      this.h2Open.sessions -= 1;
      if (record.open === 0 && !record.goaway && !record.error && record.failedPings === 0) return;
      this.h2Event(
        {
          kind: "http2_session_close",
          session: record.id,
          authority: record.authority,
          ageMs: age(),
          streams: record.streams,
          openStreams: record.open,
          pings: record.pings,
          maxPingMs: round(record.maxPingMs),
          failedPings: record.failedPings,
        },
        record.open > 0,
      );
    });

    const owner = this;
    const request = session.request;
    session.request = function requestWithDiagnostics(this: ClientHttp2Session, ...args: unknown[]) {
      const stream = (request as (...a: unknown[]) => ClientHttp2Stream).apply(this, args);
      quietly(() => owner.watchStream(stream, args[0], record));
      return stream;
    } as typeof session.request;

    const ping = session.ping;
    session.ping = function pingWithDiagnostics(this: ClientHttp2Session, ...args: unknown[]) {
      const index = args.findIndex((arg) => typeof arg === "function");
      if (index >= 0) {
        const callback = args[index] as (error: Error | null, duration: number, payload: Buffer) => void;
        const sent = performance.now();
        args[index] = (error: Error | null, duration: number, payload: Buffer) => {
          quietly(() => owner.pinged(record, error, performance.now() - sent));
          callback(error, duration, payload);
        };
      }
      return (ping as (...a: unknown[]) => boolean).apply(this, args);
    } as typeof session.ping;
  }

  private pinged(session: H2Session, error: Error | null, ms: number): void {
    session.pings += 1;
    if (ms > session.maxPingMs) session.maxPingMs = ms;
    if (error) {
      session.failedPings += 1;
      this.h2Event({ kind: "http2_ping_failed", session: session.id, ms: round(ms), error: describeError(error) }, true);
    } else if (ms >= 5000) {
      this.h2Event({ kind: "http2_slow_ping", session: session.id, ms: round(ms) }, true);
    }
  }

  watchStream(stream: ClientHttp2Stream, headers: unknown, session: H2Session): void {
    const h = (headers !== null && typeof headers === "object" ? headers : {}) as Record<string, unknown>;
    const state: StreamState = {
      path: String(h[":path"] ?? ""),
      requestId: stringOf(h["x-request-id"]),
      originalRequestId: stringOf(h["x-original-request-id"]),
      startedAt: Date.now(),
      responseAt: 0,
      lastDataAt: 0,
      lastWriteAt: 0,
      bytesIn: 0,
      chunksIn: 0,
      chunksOut: 0,
      aborted: false,
    };
    session.streams += 1;
    session.open += 1;
    this.h2Open.streams += 1;
    stream.once("response", (response: Record<string, unknown>) => {
      state.responseAt = Date.now();
      state.status = Number(response[":status"]);
      readGrpc(state, response);
    });
    stream.once("trailers", (trailers: Record<string, unknown>) => readGrpc(state, trailers));
    stream.once("aborted", () => {
      state.aborted = true;
    });
    stream.on("error", (error: unknown) => {
      state.error ??= describeError(error);
    });
    const emit = stream.emit;
    stream.emit = function emitWithDiagnostics(this: ClientHttp2Stream, event: string | symbol, ...args: unknown[]) {
      if (event === "data") {
        state.chunksIn += 1;
        state.bytesIn += byteLength(args[0]);
        state.lastDataAt = Date.now();
      }
      return (emit as (...a: unknown[]) => boolean).call(this, event, ...args);
    } as typeof stream.emit;
    const write = stream.write;
    stream.write = function writeWithDiagnostics(this: ClientHttp2Stream, ...args: unknown[]) {
      state.chunksOut += 1;
      state.lastWriteAt = Date.now();
      return (write as (...a: unknown[]) => boolean).apply(this, args);
    } as typeof stream.write;
    const close = stream.close;
    stream.close = function closeWithDiagnostics(this: ClientHttp2Stream, ...args: unknown[]) {
      state.clientCloseCode ??= typeof args[0] === "number" ? args[0] : 0;
      return (close as (...a: unknown[]) => void).apply(this, args);
    } as typeof stream.close;
    stream.once("close", () => {
      session.open -= 1;
      this.h2Open.streams -= 1;
      quietly(() => this.streamClosed(state, stream.rstCode, session));
    });
  }

  private streamClosed(state: StreamState, rstCode: number | undefined, session: H2Session): void {
    const now = Date.now();
    const reset = rstCode !== undefined && rstCode !== 0;
    const closedBy: StreamSummary["closedBy"] =
      state.clientCloseCode !== undefined && state.clientCloseCode !== 0
        ? "client"
        : !reset
          ? state.error
            ? "error"
            : "clean"
          : session.error || session.goaway
            ? "session"
            : "peer";
    const summary: StreamSummary = {
      path: state.path,
      ...(state.requestId ? { requestId: state.requestId } : {}),
      ...(state.originalRequestId && state.originalRequestId !== state.requestId
        ? { originalRequestId: state.originalRequestId }
        : {}),
      session: session.id,
      startedAt: state.startedAt,
      ms: now - state.startedAt,
      ...(state.responseAt ? { responseMs: state.responseAt - state.startedAt } : {}),
      ...(state.status !== undefined ? { status: state.status } : {}),
      ...(state.grpcStatus !== undefined ? { grpcStatus: state.grpcStatus } : {}),
      ...(state.grpcMessage ? { grpcMessage: state.grpcMessage } : {}),
      ...(rstCode !== undefined ? { rstCode, rst: h2CodeName(rstCode) } : {}),
      closedBy,
      ...(state.clientCloseCode !== undefined ? { clientCloseCode: state.clientCloseCode } : {}),
      ...(state.aborted ? { aborted: true } : {}),
      ...(state.error ? { error: state.error } : {}),
      bytesIn: state.bytesIn,
      chunksIn: state.chunksIn,
      chunksOut: state.chunksOut,
      silentMs: now - (state.lastDataAt || state.startedAt),
      ...(state.lastWriteAt ? { sinceWriteMs: now - state.lastWriteAt } : {}),
    };
    this.window.streams += 1;
    const abnormal =
      closedBy !== "clean" ||
      state.aborted ||
      (state.status !== undefined && state.status !== 200) ||
      (state.grpcStatus !== undefined && state.grpcStatus !== "0");
    if (abnormal) this.window.abnormalStreams += 1;
    // Only agent attempts carry x-original-request-id; that is the turn join key.
    if (state.originalRequestId) {
      const list = this.streamsByRequest.get(state.originalRequestId) ?? [];
      if (list.length < 40) list.push(summary);
      remember(this.streamsByRequest, state.originalRequestId, list, MAX_TRACKED_REQUESTS);
    } else if (abnormal) {
      this.write({ kind: "http2_stream", ...summary, startedAt: new Date(summary.startedAt).toISOString() });
    }
  }

  private h2Event(event: Omit<H2Event, "at">, loud: boolean): void {
    const record = { at: Date.now(), ...event } as H2Event;
    this.h2Events.push(record);
    this.notable({ ...record, at: new Date(record.at).toISOString() }, loud);
  }

  // ---- turns ----

  finishTurn(turn: TurnRecorder, outcome: TurnOutcome): void {
    this.activeTurns.delete(turn);
    const from = turn.startedAt;
    const to = Date.now();
    this.window.turns += 1;
    if (outcome.status === "failed") this.window.failedTurns += 1;

    const requestIds = [...turn.requestIds];
    const attempts = requestIds.flatMap((id) => this.streamsByRequest.get(id) ?? []);
    const roots = [...new Set(requestIds.map((id) => this.rootsByRequest.get(id)).filter((root) => root !== undefined))];
    const spanStats = new Map<string, Stat>();
    for (const root of roots) for (const [name, stat] of root.byName) mergeStat(spanStats, name, stat);
    const timeline = roots
      .flatMap((root) => root.timeline)
      .sort((a, b) => a.at - b.at)
      .slice(0, MAX_TIMELINE)
      .map(({ at, ...entry }) => ({ atMs: at - from, ...entry }));
    const sdkAttempts = spanStats.get("agent.request.attempt")?.count ?? 0;
    const spanErrors = [...spanStats.values()].reduce((sum, stat) => sum + stat.errors, 0);

    const stalls = this.stalls.since(from, (stall) => stall.at).filter((stall) => stall.at <= to);
    const slowSql = this.slowSql.since(from, (entry) => entry.at).filter((entry) => entry.at <= to);
    const h2 = this.h2Events.since(from, (event) => event.at).filter((event) => event.at <= to);
    const maxStallMs = stalls.reduce((max, stall) => Math.max(max, stall.ms), 0);

    const flags: string[] = [];
    if (turn.usageAt.length > 1) flags.push("multiple_turn_ended");
    if (outcome.error && /no progress/i.test(outcome.error.message)) flags.push("no_progress");
    if (turn.notes.some((note) => note["kind"] === "error_after_answer")) flags.push("error_after_answer");
    if (turn.sendAttempts > 1) flags.push("plugin_retry");
    if (sdkAttempts > Math.max(1, turn.sendAttempts) || attempts.length > Math.max(1, turn.sendAttempts)) {
      flags.push("sdk_retry");
    }
    if (attempts.some((attempt) => attempt.closedBy === "peer")) flags.push("stream_reset_by_peer");
    if (attempts.some((attempt) => attempt.closedBy === "session")) flags.push("stream_lost_with_session");
    if (attempts.some((attempt) => attempt.closedBy === "client")) flags.push("stream_cancelled_by_client");
    if (h2.some((event) => event.kind === "http2_goaway")) flags.push("http2_goaway");
    if (h2.some((event) => event.kind === "http2_session_error" || event.kind === "http2_ping_failed")) {
      flags.push("http2_session_error");
    }
    if (maxStallMs >= 5000) flags.push("loop_stall_5s");
    else if (maxStallMs >= 1000) flags.push("loop_stall_1s");
    if (spanErrors > 0) flags.push("sdk_span_errors");
    const cancel = turn.notes.find((note) => note["kind"] === "cancel");
    if (cancel) flags.push(`cancel:${String(cancel["reason"])}`);

    const record: Json = {
      kind: "turn",
      sessionId: turn.info.sessionId,
      turnId: turn.info.turnId,
      ...(turn.info.agentId ? { agentId: turn.info.agentId } : {}),
      ...(turn.info.model ? { model: turn.info.model } : {}),
      status: outcome.status,
      ...(outcome.error ? { error: outcome.error } : {}),
      flags,
      durationMs: to - from,
      ...(turn.firstEventAt ? { firstEventMs: turn.firstEventAt - from } : {}),
      sendAttempts: turn.sendAttempts,
      sdkAttempts,
      requestIds,
      runIds: [...turn.runIds],
      events: turn.events,
      ...(Object.keys(turn.afterUsage).length > 0 ? { eventsAfterTurnEnded: turn.afterUsage } : {}),
      usageAtMs: turn.usageAt,
      stream: gapSummary(turn.streamGap, to),
      deltas: { counts: turn.deltas, ...gapSummary(turn.deltaGap, to) },
      notes: turn.notes,
      attempts: attempts.map(({ startedAt, ...attempt }) => ({ startMs: startedAt - from, ...attempt })),
      sdk: { spans: topStats(spanStats, 15), timeline },
      // Process-wide: other agents share this process, so these are context, not cause.
      process: {
        activeTurns: this.activeTurns.size + 1,
        sqlite: {
          calls: this.sqlTotal.calls - turn.sqlAtStart.calls,
          ms: round(this.sqlTotal.ms - turn.sqlAtStart.ms),
          slow: slowSql.length,
          worst: [...slowSql].sort((a, b) => b.ms - a.ms).slice(0, 3).map(({ at, ...entry }) => ({ atMs: at - from, ...entry })),
        },
        gc: { count: this.gcTotal.count - turn.gcAtStart.count, ms: round(this.gcTotal.ms - turn.gcAtStart.ms) },
        loop: {
          stalls: stalls.length,
          stallMs: stalls.reduce((sum, stall) => sum + stall.ms, 0),
          maxMs: maxStallMs,
          worst: [...stalls].sort((a, b) => b.ms - a.ms).slice(0, 3).map(({ at, ...stall }) => ({ atMs: at - from, ...stall })),
        },
        http2: h2.slice(0, 20).map(({ at, ...event }) => ({ atMs: at - from, ...event })),
      },
    };
    const troubled = outcome.status === "failed" || flags.some((flag) => !flag.startsWith("cancel:"));
    if (!troubled || !turn.info.storeFiles) {
      this.finishTurnRecord(record, troubled);
      return;
    }
    void fileSizes(turn.info.storeFiles).then((sizes) => this.finishTurnRecord({ ...record, storeBytes: sizes }, true));
  }

  private finishTurnRecord(record: Json, troubled: boolean): void {
    this.write(record);
    if (!troubled) return;
    const proc = record["process"] as { loop: { maxMs: number } };
    this.loud({
      kind: "turn",
      turnId: record["turnId"],
      agentId: record["agentId"],
      status: record["status"],
      error: record["error"],
      flags: record["flags"],
      durationMs: record["durationMs"],
      sendAttempts: record["sendAttempts"],
      sdkAttempts: record["sdkAttempts"],
      maxStallMs: proc.loop.maxMs,
      file: this.file,
    });
  }

  private async prune(): Promise<void> {
    try {
      const names = await readdir(this.options.dir);
      for (const name of expiredDiagnosticsFiles(names, new Date(), this.options.retentionDays)) {
        await unlink(path.join(this.options.dir, name)).catch(() => undefined);
      }
    } catch {
      // Retention is best effort.
    }
  }
}

class TurnRecorder implements TurnDiagnostics {
  readonly startedAt = Date.now();
  readonly requestIds = new Set<string>();
  readonly runIds = new Set<string>();
  readonly events: Record<string, number> = {};
  readonly afterUsage: Record<string, number> = {};
  readonly deltas: Record<string, number> = {};
  readonly usageAt: number[] = [];
  readonly notes: Json[] = [];
  readonly streamGap = newGap();
  readonly deltaGap = newGap();
  readonly sqlAtStart: { calls: number; ms: number };
  readonly gcAtStart: { count: number; ms: number };
  readonly info: TurnInfo;
  firstEventAt = 0;
  sendAttempts = 0;
  private readonly owner: Diagnostics;
  private done = false;

  constructor(owner: Diagnostics, info: TurnInfo) {
    this.owner = owner;
    this.info = info;
    this.sqlAtStart = { ...owner.sqlTotal };
    this.gcAtStart = { ...owner.gcTotal };
  }

  run(run: { id: string; requestId?: string }): void {
    this.runIds.add(run.id);
    if (run.requestId) this.requestIds.add(run.requestId);
  }

  event(event: { type: string; run_id?: string; request_id?: string }): void {
    const now = Date.now();
    this.firstEventAt ||= now;
    bump(this.events, event.type);
    if (event.type === "usage") this.usageAt.push(now - this.startedAt);
    else if (this.usageAt.length > 0) bump(this.afterUsage, event.type);
    if (event.type === "request" && event.request_id) this.requestIds.add(event.request_id);
    if (event.run_id) this.runIds.add(event.run_id);
    trackGap(this.streamGap, now, event.type);
  }

  delta(type: string): void {
    bump(this.deltas, type);
    trackGap(this.deltaGap, Date.now(), type);
  }

  attempt(attempt: number): void {
    this.sendAttempts = attempt;
  }

  note(kind: string, detail: Json = {}): void {
    if (this.done || this.notes.length >= MAX_NOTES) return;
    this.notes.push({ kind, atMs: Date.now() - this.startedAt, ...detail });
  }

  end(outcome: TurnOutcome): void {
    if (this.done) return;
    this.done = true;
    quietly(() => this.owner.finishTurn(this, outcome));
  }
}

class DiagSpan {
  readonly startedAt = Date.now();
  private readonly startedPerf = performance.now();
  readonly root: SpanRoot;
  readonly startName: string;
  name: string;
  attrs: Record<string, Primitive> | undefined;
  error: string | undefined;
  private readonly owner: Diagnostics;
  private ended = false;

  constructor(owner: Diagnostics, name: string, parent: DiagSpan | null) {
    this.owner = owner;
    this.name = name;
    this.startName = name;
    this.root = parent?.root ?? { requestIds: new Set(), byName: new Map(), timeline: [] };
  }

  spanContext() {
    return INVALID_SPAN_CONTEXT;
  }

  isRecording(): boolean {
    return !this.ended;
  }

  setAttribute(key: string, value: unknown): this {
    quietly(() => this.owner.spanAttribute(this, key, value));
    return this;
  }

  setAttributes(attributes: Record<string, unknown> | undefined): this {
    for (const [key, value] of Object.entries(attributes ?? {})) this.setAttribute(key, value);
    return this;
  }

  addEvent(): this {
    return this;
  }

  addLink(): this {
    return this;
  }

  addLinks(): this {
    return this;
  }

  setStatus(status: { code?: number; message?: string } | undefined): this {
    if (status?.code === OTEL_STATUS_ERROR) this.error ??= clip(status.message || "error", 600);
    return this;
  }

  updateName(name: string): this {
    this.name = name;
    return this;
  }

  recordException(exception: unknown): void {
    this.error = describeError(exception);
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    quietly(() => this.owner.spanEnded(this, performance.now() - this.startedPerf));
  }
}

const NOOP_SPAN = {
  spanContext: () => INVALID_SPAN_CONTEXT,
  isRecording: () => false,
  setAttribute() {
    return NOOP_SPAN;
  },
  setAttributes() {
    return NOOP_SPAN;
  },
  addEvent() {
    return NOOP_SPAN;
  },
  addLink() {
    return NOOP_SPAN;
  },
  addLinks() {
    return NOOP_SPAN;
  },
  setStatus() {
    return NOOP_SPAN;
  },
  updateName() {
    return NOOP_SPAN;
  },
  recordException() {},
  end() {},
};

const TRACER = {
  startSpan(name: string, _options?: unknown, context?: unknown): unknown {
    return hub().current?.startSpan(name, parentSpan(context)) ?? NOOP_SPAN;
  },
  startActiveSpan(name: string, ...rest: unknown[]): unknown {
    const fn = rest.pop() as (span: unknown) => unknown;
    return fn(TRACER.startSpan(name, rest[0], rest[1]));
  },
};

function parentSpan(context: unknown): DiagSpan | null {
  if (context === null || typeof context !== "object") return null;
  const getValue = Reflect.get(context, "getValue");
  if (typeof getValue !== "function") return null;
  const parent: unknown = getValue.call(context, OTEL_SPAN);
  return parent instanceof DiagSpan ? parent : null;
}

// ---- hooks ----

function installHooks(state: Hub): void {
  const hooks: Array<[string, () => boolean]> = [
    ["sqlite", hookSqlite],
    ["http2", hookHttp2],
    ["otel", hookTracer],
  ];
  for (const [name, install] of hooks) {
    if (state.attempted.has(name)) continue;
    state.attempted.add(name);
    try {
      if (install()) state.hooks.add(name);
    } catch (error) {
      console.error(`cursor-sdk diag: ${name} hook failed: ${describeError(error)}`);
    }
  }
}

function builtin<T>(id: string): T | undefined {
  const get = (process as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule;
  return typeof get === "function" ? (get.call(process, id) as T | undefined) : undefined;
}

function hookSqlite(): boolean {
  const sqlite = builtin<{ DatabaseSync?: { prototype: object }; StatementSync?: { prototype: object } }>("node:sqlite");
  if (!sqlite?.StatementSync || !sqlite.DatabaseSync) return false;
  const statementSql = (self: unknown): string => {
    try {
      return String(Reflect.get(self as object, "sourceSQL") ?? "?");
    } catch {
      return "?";
    }
  };
  for (const method of ["run", "get", "all"]) timeMethod(sqlite.StatementSync.prototype, method, statementSql);
  for (const method of ["exec", "prepare"]) {
    timeMethod(sqlite.DatabaseSync.prototype, method, (_self, args) => String(args[0] ?? "?"));
  }
  return true;
}

function timeMethod(target: object, method: string, sql: (self: unknown, args: unknown[]) => string): void {
  const original: unknown = Reflect.get(target, method);
  if (typeof original !== "function") return;
  Reflect.set(target, method, function timed(this: unknown, ...args: unknown[]) {
    const started = performance.now();
    try {
      return original.apply(this, args);
    } finally {
      const ms = performance.now() - started;
      quietly(() => hub().current?.recordSql(ms, () => sql(this, args)));
    }
  });
}

function hookHttp2(): boolean {
  const http2 = builtin<Record<string, unknown>>("node:http2");
  const connect = http2?.["connect"];
  if (!http2 || typeof connect !== "function") return false;
  http2["connect"] = function connectWithDiagnostics(this: unknown, ...args: unknown[]) {
    const session = connect.apply(this, args) as ClientHttp2Session;
    quietly(() => hub().current?.watchSession(session, args[0]));
    return session;
  };
  builtin<{ syncBuiltinESMExports?: () => void }>("node:module")?.syncBuiltinESMExports?.();
  return true;
}

function hookTracer(): boolean {
  const scope = globalThis as typeof globalThis & { [OTEL_API]?: Record<string, unknown> };
  const api = (scope[OTEL_API] ??= { version: OTEL_API_VERSION });
  if (api["trace"]) return false;
  api["trace"] = { getTracer: () => TRACER };
  return true;
}

// ---- helpers ----

class JsonlSink {
  private stream: WriteStream | null = null;
  private file = "";
  private bytes = 0;
  private failed = false;
  private readonly dir: string;
  private readonly maxBytes: number;
  private readonly onOpen: () => void;

  constructor(dir: string, maxBytes: number, onOpen: () => void) {
    this.dir = dir;
    this.maxBytes = maxBytes;
    this.onOpen = onOpen;
  }

  write(record: Json): void {
    if (this.failed) return;
    let line: string;
    try {
      line = `${JSON.stringify(record)}\n`;
    } catch (error) {
      line = `${JSON.stringify({ ts: record["ts"], kind: "unserializable", of: record["kind"], error: describeError(error) })}\n`;
    }
    const file = path.join(this.dir, diagnosticsFileName(new Date()));
    if (file !== this.file && !this.open(file)) return;
    if (this.bytes >= this.maxBytes) return;
    this.bytes += Buffer.byteLength(line);
    if (this.bytes >= this.maxBytes) {
      line += `${JSON.stringify({ ts: record["ts"], kind: "capped", maxBytes: this.maxBytes })}\n`;
    }
    this.stream!.write(line);
  }

  flush(): Promise<void> {
    const stream = this.stream;
    if (!stream) return Promise.resolve();
    return new Promise((resolve) => stream.write("", () => resolve()));
  }

  close(): Promise<void> {
    const stream = this.stream;
    this.stream = null;
    this.file = "";
    if (!stream) return Promise.resolve();
    return new Promise((resolve) => stream.end(() => resolve()));
  }

  private open(file: string): boolean {
    try {
      this.stream?.end();
      mkdirSync(this.dir, { recursive: true });
      let size = 0;
      try {
        size = statSync(file).size;
      } catch {
        size = 0;
      }
      const stream = createWriteStream(file, { flags: "a" });
      stream.on("error", (error) => {
        this.failed = true;
        console.error(`cursor-sdk diag: writing ${file} failed: ${describeError(error)}`);
      });
      this.stream = stream;
      this.file = file;
      this.bytes = size;
      this.onOpen();
      return true;
    } catch (error) {
      this.failed = true;
      console.error(`cursor-sdk diag: cannot open ${file}: ${describeError(error)}`);
      return false;
    }
  }
}

class Ring<T> {
  private readonly items: T[] = [];
  private readonly size: number;

  constructor(size: number) {
    this.size = size;
  }

  push(item: T): void {
    this.items.push(item);
    if (this.items.length > this.size) this.items.shift();
  }

  since(from: number, at: (item: T) => number): T[] {
    return this.items.filter((item) => at(item) >= from);
  }
}

interface Gap {
  lastAt: number;
  lastType: string;
  maxMs: number;
  maxAfter: string;
}

function newGap(): Gap {
  return { lastAt: 0, lastType: "", maxMs: 0, maxAfter: "" };
}

function trackGap(gap: Gap, now: number, type: string): void {
  if (gap.lastAt) {
    const ms = now - gap.lastAt;
    if (ms > gap.maxMs) {
      gap.maxMs = ms;
      gap.maxAfter = gap.lastType;
    }
  }
  gap.lastAt = now;
  gap.lastType = type;
}

function gapSummary(gap: Gap, end: number): Json {
  if (!gap.lastAt) return {};
  return {
    maxGapMs: gap.maxMs,
    ...(gap.maxAfter ? { maxGapAfter: gap.maxAfter } : {}),
    last: gap.lastType,
    sinceLastMs: end - gap.lastAt,
  };
}

function remember<K, V>(map: Map<K, V>, key: K, value: V, max: number): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > max) map.delete(map.keys().next().value as K);
}

function bump(counts: Record<string, number>, key: string): void {
  if (key in counts || Object.keys(counts).length < 64) counts[key] = (counts[key] ?? 0) + 1;
}

function bumpStat(stats: Map<string, Stat>, name: string, ms: number, failed: boolean): void {
  const stat = stats.get(name);
  if (stat) {
    stat.count += 1;
    stat.ms += ms;
    if (ms > stat.maxMs) stat.maxMs = ms;
    if (failed) stat.errors += 1;
  } else {
    stats.set(name, { count: 1, ms, maxMs: ms, errors: failed ? 1 : 0 });
  }
}

function mergeStat(stats: Map<string, Stat>, name: string, add: Stat): void {
  const stat = stats.get(name);
  if (!stat) {
    stats.set(name, { ...add });
    return;
  }
  stat.count += add.count;
  stat.ms += add.ms;
  stat.maxMs = Math.max(stat.maxMs, add.maxMs);
  stat.errors += add.errors;
}

function topStats(stats: Map<string, Stat>, limit: number, label = "name"): Json[] {
  return [...stats]
    .sort(([, a], [, b]) => b.ms - a.ms)
    .slice(0, limit)
    .map(([name, stat]) => ({
      [label]: label === "sql" ? clipSql(name) : name,
      count: stat.count,
      ms: round(stat.ms),
      maxMs: round(stat.maxMs),
      ...(stat.errors > 0 ? { errors: stat.errors } : {}),
    }));
}

function compactAttrs(span: DiagSpan): Record<string, Primitive> | undefined {
  if (!span.attrs) return undefined;
  const keepIds = span.name === "agent.request.attempt";
  const entries = Object.entries(span.attrs).filter(
    ([key]) => keepIds || (key !== "agent.request_id" && key !== "agent.original_request_id"),
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function readGrpc(state: StreamState, headers: Record<string, unknown>): void {
  const status = headers["grpc-status"];
  if (status !== undefined) state.grpcStatus = String(status);
  const message = headers["grpc-message"];
  if (typeof message !== "string" || message.length === 0) return;
  let decoded = message;
  try {
    decoded = decodeURIComponent(message);
  } catch {
    decoded = message;
  }
  state.grpcMessage = clip(decoded, 300);
}

async function fileSizes(files: Record<string, string>): Promise<Record<string, number | null>> {
  const sizeOf = (file: string) => stat(file).then((info) => info.size, () => null);
  const entries = await Promise.all(
    Object.entries(files).flatMap(([label, file]) => [
      sizeOf(file).then((bytes) => [label, bytes] as const),
      sizeOf(`${file}-wal`).then((bytes) => [`${label}Wal`, bytes] as const),
    ]),
  );
  return Object.fromEntries(entries);
}

function authorityOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof URL) return value.origin;
  return String(value ?? "");
}

function stringOf(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return undefined;
}

function byteLength(chunk: unknown): number {
  if (typeof chunk === "string") return Buffer.byteLength(chunk);
  if (chunk instanceof Uint8Array) return chunk.byteLength;
  return 0;
}

function quietly(fn: () => void): void {
  try {
    fn();
  } catch {
    // Diagnostics must never break the SDK call they observe.
  }
}

function clip(text: string, max = 300): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function clipSql(sql: string): string {
  return clip(sql.replace(/\s+/g, " ").trim(), 160);
}

function round(ms: number): number {
  return Math.round(ms * 10) / 10;
}

function mb(bytes: number): number {
  return Math.round(bytes / 1024 / 1024);
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}
