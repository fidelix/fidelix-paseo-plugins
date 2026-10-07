// Local structural types for the @cursor/sdk surface this provider uses.
// Declared here (instead of importing the SDK's own .d.ts) so neither tsc
// nor the daemon's plugin compiler walks the SDK's broken declaration graph
// (unpublished @anysphere/*, vendor/cursor-sdk-shared/*,
// @connectrpc/connect-node type imports — see getpaseo/paseo#6257).
// The runtime loader (cursor-sdk-loader.js) returns the real SDK; these
// types only need to be structurally compatible with it.

export interface CursorModelSelection {
  id: string;
  params?: Array<{ id: string; value: string }>;
}

/**
 * Public SDK tool names accepted by `Agent.create` / `Agent.resume`
 * `tools` (mirrors the SDK's `ToolName` vocabulary; the `(string & {})`
 * member keeps it open for future proto tools). `"shell"` and `"mcp"` are
 * capability groups; `"task"` gates subagents.
 */
export type CursorToolName =
  | "shell"
  | "read"
  | "edit"
  | "grep"
  | "glob"
  | "ls"
  | "task"
  | "mcp"
  | "webSearch"
  | "delete"
  | "readLints"
  | "webFetch"
  | "semSearch"
  | "updateTodos"
  | "readTodos"
  | "askQuestion"
  | "await"
  | "generateImage"
  | "applyAgentDiff"
  | (string & {});

/**
 * Subset of `AgentOptions` the provider sets at create/resume time.
 * Declared for documentation; the runtime loader passes these through as
 * `Record<string, unknown>` so the daemon never walks the SDK's own .d.ts.
 * Note `tools` is create/resume-only: it is not persisted and `send()` does
 * not accept it, so restrictions must be re-passed on every resume.
 */
export interface CursorAgentCreateShape {
  apiKey?: string;
  model?: CursorModelSelection;
  tools?: CursorToolName[];
  systemPrompt?: string;
}

export interface CursorModelListItem {
  id: string;
  displayName: string;
  description?: string;
  aliases?: string[];
  parameters?: CursorModelParameter[];
  variants?: Array<{
    params: Array<{ id: string; value: string }>;
    displayName: string;
    description?: string;
    isDefault?: boolean;
  }>;
}

export interface CursorModelParameter {
  id: string;
  displayName?: string;
  values: Array<{ value: string; displayName?: string }>;
}

export interface CursorTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  reasoningTokens?: number;
}

export interface CursorRunError {
  message: string;
  code?: string;
}

export interface CursorRunResult {
  id: string;
  requestId?: string;
  status: "finished" | "error" | "cancelled";
  result?: string;
  error?: CursorRunError;
  model?: CursorModelSelection;
  durationMs?: number;
  usage?: CursorTokenUsage;
}

export interface CursorRun {
  readonly id: string;
  readonly requestId?: string;
  readonly agentId: string;
  stream(): AsyncGenerator<CursorSDKMessage, void>;
  wait(): Promise<CursorRunResult>;
  cancel(): Promise<void>;
  steer?(text: string): Promise<"complete_delivered" | "revert_to_followup">;
  conversation(): Promise<unknown>;
  readonly status: string;
}

export interface CursorAgent {
  readonly agentId: string;
  readonly model: CursorModelSelection | undefined;
  // Note: the SDK's SendOptions is { model, mcpServers, mode, ... } — it has
  // no `tools` field, so tool restrictions can only be set at Agent.create /
  // Agent.resume (which also do not persist them; every resume re-passes them).
  send(
    message: string | { text: string; images?: Array<{ data: string; mimeType: string }> },
    options?: {
      model?: CursorModelSelection;
      mode?: "agent" | "plan";
      mcpServers?: Record<string, CursorMcpServerConfig>;
    },
  ): Promise<CursorRun>;
  close(): void;
  getUsage(options?: { runId?: string }): Promise<CursorAgentUsage>;
}

export type CursorMcpServerConfig =
  | { type?: "stdio"; command: string; args?: string[]; env?: Record<string, string>; cwd?: string }
  | { type?: "http" | "sse"; url: string; headers?: Record<string, string> };

export type CursorSDKMessage =
  | { type: "system"; agent_id: string; run_id: string; model?: CursorModelSelection; tools?: string[]; subtype?: string }
  | { type: "user"; agent_id: string; run_id: string; message: { role: "user"; content: Array<{ type: "text"; text: string }> } }
  | {
      type: "assistant";
      agent_id: string;
      run_id: string;
      message: { role: "assistant"; content: Array<{ type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: unknown }> };
    }
  | { type: "thinking"; agent_id: string; run_id: string; text: string; thinking_duration_ms?: number }
  | {
      type: "tool_call";
      agent_id: string;
      run_id: string;
      call_id: string;
      name: string;
      status: "running" | "completed" | "error";
      args?: unknown;
      result?: unknown;
      truncated?: { args?: boolean; result?: boolean };
    }
  | { type: "status"; agent_id: string; run_id: string; status: string; message?: string }
  | { type: "task"; agent_id: string; run_id: string; status?: string; text?: string }
  | { type: "request"; agent_id: string; run_id: string; request_id: string }
  | { type: "usage"; agent_id: string; run_id: string; usage: CursorTokenUsage };

export interface CursorAgentMessage {
  type: "user" | "assistant";
  uuid: string;
  agent_id: string;
  message: unknown;
}

/**
 * Billed usage for a local agent, returned by the key-only read APIs
 * `agent.getUsage()` / `Agent.getUsage(agentId)` (see agent.d.ts).
 * Cost is eventually consistent and absent until billing events land.
 */
export interface CursorAgentUsageCost {
  rawCostCents: number;
  chargedCents: number;
}

export interface CursorAgentUsage {
  usage: CursorTokenUsage;
  cost?: CursorAgentUsageCost;
  runs: Array<{ runId: string; usage: CursorTokenUsage; cost?: CursorAgentUsageCost }>;
}

export interface CursorSdkErrorShape {
  message: string;
  code?: string;
  status?: number;
  isRetryable?: boolean;
}
