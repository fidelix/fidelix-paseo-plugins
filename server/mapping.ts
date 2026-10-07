import type {
  ProviderConfigState,
  ProviderError,
  ProviderModel,
  ProviderTimelineItem,
  ProviderToolCallDetail,
} from "@getpaseo/plugin/server/provider";
import type { JsonValue } from "./json.js";
import type {
  CursorModelListItem,
  CursorModelParameter,
  CursorSDKMessage,
  CursorToolName,
  CursorTokenUsage,
} from "./cursor-sdk-types.js";
import { randomUUID } from "node:crypto";

export const CURSOR_MODES = [
  {
    id: "agent",
    label: "Agent",
    description: "Implements changes directly",
    icon: "Shield",
    colorTier: "moderate",
  },
  {
    id: "plan",
    label: "Plan",
    description: "Explores and plans first, read-only",
    icon: "ShieldEllipsis",
    colorTier: "planning",
  },
] as const;

export const DEFAULT_CURSOR_MODEL = "composer-2.5";
export const DEFAULT_CURSOR_MODE = "agent";

/**
 * Tool allowlist for `Agent.create` / `Agent.resume`.
 *
 * - toolPolicy present (daemon sends exact MCP preapprovals): `["mcp"]`.
 *   The policy grants specific MCP server tools, but the SDK only gates the
 *   whole `mcp` capability group (per-server/per-tool gating does not exist),
 *   so honoring it means MCP-only: the model can call MCP tools, nothing else.
 *   Non-MCP preapprovals cannot map to SDK tools (the policy schema only
 *   carries `kind: "mcp"` grants). MCP server injection is untouched —
 *   `toMcpServers` still passes every configured server; `tools` only
 *   restricts which built-ins the model may call. Fail-closed by construction:
 *   omitting `"mcp"` would disable MCP entirely.
 * - Ask-like mode (config.mode is not "agent"/"plan" and contains "ask"):
 *   read-only builtins `["read", "grep", "glob", "ls"]` — no writes, no shell,
 *   no MCP, no subagents (`"task"` gated, so no Task children either).
 * - toolPolicy + ask both present: ask wins (read-only, MCP disabled).
 * - Neither: undefined (SDK default toolset).
 */
export function resolveCursorTools(args: {
  toolPolicy?: { preapproved: Array<{ kind: string; server: string; tool: string }> };
  mode?: string;
}): CursorToolName[] | undefined {
  if (isAskLikeMode(args.mode)) return [...CURSOR_READ_ONLY_TOOLS];
  if (args.toolPolicy && args.toolPolicy.preapproved.length > 0) return ["mcp"];
  return undefined;
}

/** Read-only SDK builtins used for ask-like modes. */
export const CURSOR_READ_ONLY_TOOLS: readonly ["read", "grep", "glob", "ls"] = [
  "read",
  "grep",
  "glob",
  "ls",
];

/** Ask-like mode: anything that is not agent/plan but reads like "ask". */
export function isAskLikeMode(mode: string | undefined): boolean {
  if (!mode) return false;
  if (mode === "agent" || mode === "plan") return false;
  return mode.toLowerCase().includes("ask");
}

/** Settings rendered in the composer. autoReview maps to Cursor's classifier-backed Auto mode. */
export const CURSOR_SETTING_AUTO_REVIEW = "autoReview";
/** Fast toggle: when true, appends/overrides the fast param on models that offer one. */
export const CURSOR_SETTING_FAST = "fast";

export function findCursorModel(
  models: ProviderModel[],
  modelId: string | undefined,
): ProviderModel | undefined {
  if (!modelId) return undefined;
  return models.find((model) => model.id === modelId || model.aliases?.includes(modelId));
}

/**
 * Resolve the SDK `{ id, params }` selection for a model id against the
 * published catalog. Starts from the catalog entry's default variant params
 * (isDefault), applies per-model stored thinking params (a known parameter id
 * for this model, recorded by applyConfigure), then applies the fast toggle
 * when the model exposes a `fast` parameter. Returns undefined when the model
 * is unknown or has no params to send.
 */
export function resolveCursorModelParams(args: {
  modelId: string | undefined;
  rawModels: CursorModelListItem[] | undefined;
  thinkingSelections: Record<string, string>;
  fast: boolean;
}): { id: string; params: Array<{ id: string; value: string }> } | undefined {
  const { modelId, rawModels, thinkingSelections, fast } = args;
  if (!modelId) return undefined;
  const raw = rawModels?.find(
    (item) => item.id === modelId || item.aliases?.includes(modelId),
  );
  if (!raw) return undefined;
  const byId = new Map((raw.parameters ?? []).map((parameter) => [parameter.id, parameter]));
  const merged = new Map<string, string>();
  for (const variant of raw.variants ?? []) {
    if (!variant.isDefault) continue;
    for (const param of variant.params ?? []) merged.set(param.id, param.value);
    break;
  }
  const thinking = thinkingSelections[raw.id] ?? thinkingSelections[modelId];
  if (thinking !== undefined && modelId !== undefined) {
    const known = [...byId.keys()].find(
      (id) => id === thinking || id.toLowerCase() === thinking.toLowerCase(),
    );
    if (known) {
      merged.set(
        known,
        thinkingIncludesValue(byId.get(known), thinking) ?? merged.get(known) ?? thinking,
      );
    }
  }
  if (fast) {
    const fastParam = [...byId.keys()].find((id) => id.toLowerCase() === "fast");
    if (fastParam) {
      const values = byId.get(fastParam)?.values?.map((entry) => entry.value) ?? [];
      const fastValue =
        values.find((value) => value.toLowerCase() === "true") ??
        values.find((value) => value.length > 0);
      if (fastValue !== undefined) merged.set(fastParam, fastValue);
    }
  }
  if (merged.size === 0) return undefined;
  return { id: modelId, params: [...merged.entries()].map(([id, value]) => ({ id, value })) };
}

/**
 * Validate a thinking-option change for the current model: the id must match a
 * known parameter id of that model (case-insensitive on the parameter id).
 * Returns the stored `{ paramId, value }` pair, where value resolves against
 * the parameter's known values (exact match, then case-insensitive fallback,
 * else the id verbatim). Unknown ids throw so the
 * daemon surfaces an invalid selection instead of silently dropping it.
 */
export function resolveThinkingParam(args: {
  thinkingOption: string;
  modelId: string | undefined;
  rawModels: CursorModelListItem[] | undefined;
}): { paramId: string; value: string } {
  const raw = args.modelId
    ? args.rawModels?.find(
        (item) => item.id === args.modelId || item.aliases?.includes(args.modelId ?? ""),
      )
    : undefined;
  const params = raw?.parameters ?? [];
  const match = params.find(
    (parameter) =>
      parameter.id === args.thinkingOption ||
      parameter.id.toLowerCase() === args.thinkingOption.toLowerCase(),
  );
  if (!match) {
    const known = params.map((parameter) => parameter.id).join(", ") || "none";
    throw new Error(
      `Unknown thinking option "${args.thinkingOption}" for model "${args.modelId ?? "?"}". Known: ${known}`,
    );
  }
  const values = match.values?.map((entry: { value: string }) => entry.value) ?? [];
  const value =
    values.find((entry: string) => entry === args.thinkingOption) ??
    values.find((entry: string) => entry.toLowerCase() === args.thinkingOption.toLowerCase()) ??
    args.thinkingOption;
  return { paramId: match.id, value };
}

function thinkingIncludesValue(
  parameter: CursorModelParameter | undefined,
  thinking: string,
): string | undefined {
  const values = parameter?.values?.map((entry: { value: string }) => entry.value) ?? [];
  if (values.length === 0) return thinking;
  return (
    values.find((entry: string) => entry === thinking) ??
    values.find((entry: string) => entry.toLowerCase() === thinking.toLowerCase())
  );
}

export function toProviderModels(items: CursorModelListItem[]): ProviderModel[] {
  return items.map((item) => ({
    id: item.id,
    label: item.displayName || item.id,
    description: item.description,
    aliases: item.aliases,
    thinkingOptions: (item.parameters ?? []).map((parameter) => ({
      id: parameter.id,
      label: parameter.displayName || parameter.id,
    })),
    defaultThinkingOptionId: defaultVariantParamId(item),
  }));
}

/** Thinking default for the catalog: the default variant's first param id. */
function defaultVariantParamId(item: CursorModelListItem): string | undefined {
  for (const variant of item.variants ?? []) {
    if (!variant.isDefault) continue;
    return variant.params[0]?.id;
  }
  return undefined;
}

export function toProviderError(error: unknown): ProviderError {
  const message = error instanceof Error ? error.message : String(error);
  const code =
    error !== null && typeof error === "object" && "code" in error
      ? String(Reflect.get(error, "code") ?? "")
      : undefined;
  return code ? { message, code } : { message };
}

/**
 * Task-tool argument/result helpers. The SDK's task tool args carry the
 * subagent prompt/description; results carry nested conversation steps.
 * Shapes are defensive: Cursor documents the envelope, not the payloads.
 */
interface TaskArgs {
  description?: string;
  prompt?: string;
  subagentType?: string;
}

function recordOf(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function textOf(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function taskArgsOf(args: unknown): TaskArgs {
  const record = recordOf(args);
  return {
    description: textOf(record["description"]),
    prompt: textOf(record["prompt"]),
    subagentType: textOf(record["subagentType"]) ?? textOf(record["subagent_type"]),
  };
}

export function describeTaskArgs(args: unknown): string | null {
  const parsed = taskArgsOf(args);
  const head = parsed.description ?? "subagent";
  const prompt = parsed.prompt;
  if (prompt && prompt !== head) return `${head}: ${truncate(prompt, 240)}`;
  return head;
}

export function describeTaskResult(result: unknown, failed: boolean): string | null {
  const record = recordOf(result);
  const status = recordOf(record["status"]);
  const value = record["value"];
  const steps = Array.isArray(recordOf(value)["conversationSteps"])
    ? (recordOf(value)["conversationSteps"] as unknown[])
    : null;
  if (steps) {
    const lastText = [...steps]
      .reverse()
      .map((step) => recordOf(recordOf(step)["assistantMessage"])["text"])
      .find((text): text is string => typeof text === "string" && text.length > 0);
    if (lastText) return `${failed ? "Subagent failed" : "Subagent result"}: ${truncate(lastText, 500)}`;
  }
  const nested = textOf(status["value"] ?? record["value"] ?? record["text"]);
  if (nested) return `${failed ? "Subagent failed" : "Subagent result"}: ${truncate(nested, 500)}`;
  const flat = textOf(result);
  if (flat) return `${failed ? "Subagent failed" : "Subagent result"}: ${truncate(flat, 500)}`;
  return failed ? "Subagent failed" : "Subagent finished";
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function toJsonValue(value: unknown): JsonValue {
  return toJson(value);
}

function toJson(value: unknown): JsonValue {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value)) as JsonValue;
  } catch {
    return String(value);
  }
}

export function applySettings(
  current: Record<string, unknown>,
  changes: Record<string, unknown> | undefined,
): void {
  if (changes) Object.assign(current, changes);
}

export function publishableConfig(args: {
  model?: string;
  mode?: string;
  settings: Record<string, unknown>;
  models: ProviderModel[];
}): ProviderConfigState {
  return {
    model: args.model,
    mode: args.mode ?? DEFAULT_CURSOR_MODE,
    models: args.models,
    modes: [...CURSOR_MODES],
    thinkingOptions: thinkingOptionsForModel(args.models, args.model),
    settings: [
      {
        type: "toggle",
        id: CURSOR_SETTING_AUTO_REVIEW,
        label: "Auto-review",
        description: "Classifier-backed Auto mode for tool calls when the backend supports it",
        value: args.settings[CURSOR_SETTING_AUTO_REVIEW] === true,
      },
      {
        type: "toggle",
        id: CURSOR_SETTING_FAST,
        label: "Fast",
        description: "Fast mode for models that expose a fast parameter",
        value: args.settings[CURSOR_SETTING_FAST] === true,
      },
    ],
  };
}

/** Per-model thinking options: only the selected model's parameter ids. */
function thinkingOptionsForModel(
  models: ProviderModel[],
  modelId: string | undefined,
): ProviderConfigState["thinkingOptions"] {
  const model = findCursorModel(models, modelId);
  return [...(model?.thinkingOptions ?? [])];
}

function toolDetail(name: string, args: unknown, result: unknown): ProviderToolCallDetail {
  const record = (value: unknown): Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const input = record(args);
  const stringField = (key: string): string | undefined => {
    const value = input[key];
    return typeof value === "string" ? value : undefined;
  };
  const text = (value: unknown): string | undefined => {
    if (typeof value === "string") return value;
    try {
      return value === undefined ? undefined : JSON.stringify(value);
    } catch {
      return undefined;
    }
  };
  switch (name) {
    case "shell":
      return { type: "shell", command: stringField("command") ?? "", output: text(result) };
    case "read":
      return {
        type: "read",
        filePath: stringField("path") ?? stringField("filePath") ?? "",
        content: text(result),
      };
    case "edit":
      return {
        type: "edit",
        filePath: stringField("path") ?? stringField("filePath") ?? "",
        oldString: stringField("oldString") ?? stringField("find"),
        newString: stringField("newString") ?? stringField("replace"),
      };
    case "write":
      return {
        type: "write",
        filePath: stringField("path") ?? stringField("filePath") ?? "",
        content: stringField("content"),
      };
    case "grep":
    case "glob":
    case "ls":
      return {
        type: "search",
        query: stringField("query") ?? stringField("pattern") ?? stringField("path") ?? name,
        toolName: name === "grep" ? "grep" : "glob",
        content: text(result),
      };
    case "webSearch":
      return {
        type: "search",
        query:
          stringField("query") ??
          stringField("q") ??
          stringField("searchQuery") ??
          stringField("prompt") ??
          name,
        toolName: "web_search",
        content: text(result),
      };
    case "semSearch": {
      // Semantic code search carries a query like grep; "search" (not
      // "web_search") because the results are code, not URLs.
      const rawDirs = input["targetDirectories"];
      const filePaths = Array.isArray(rawDirs)
        ? rawDirs.filter((dir): dir is string => typeof dir === "string")
        : undefined;
      return {
        type: "search",
        query: stringField("query") ?? stringField("prompt") ?? name,
        toolName: "search",
        content: text(result),
        ...(filePaths && filePaths.length > 0 ? { filePaths } : {}),
      };
    }
    case "webFetch": {
      const prompt = stringField("prompt") ?? stringField("query") ?? stringField("question");
      return {
        type: "fetch",
        url: stringField("url") ?? stringField("URL") ?? stringField("link") ?? "",
        ...(prompt !== undefined ? { prompt } : {}),
        result: text(result),
      };
    }
    case "task": {
      // Subagent launch. provider.ts rewrites this card with the child
      // session link once trackTaskToolCall runs; the log carries the
      // prompt while running and the nested result once finished.
      const parsed = taskArgsOf(args);
      const subagentTypeRecord = record(input["subagentType"]);
      const subAgentType =
        parsed.subagentType ??
        textOf(subagentTypeRecord["name"]) ??
        textOf(subagentTypeRecord["kind"]);
      const log =
        result !== undefined
          ? (describeTaskResult(result, false) ?? describeTaskArgs(args) ?? "")
          : (describeTaskArgs(args) ?? "");
      return {
        type: "sub_agent",
        ...(subAgentType ? { subAgentType } : {}),
        ...(parsed.description ? { description: parsed.description } : {}),
        log,
      };
    }
    case "createPlan":
      return { type: "plan", text: stringField("plan") ?? text(result) ?? name };
    case "updateTodos":
    case "readTodos": {
      // ProviderToolCallDetail has no todo variant (todos only exist as a
      // timeline item), so render the list as labelled plain text. Look in
      // args, the result envelope, and a nested value envelope defensively.
      const candidates = [
        input["todos"],
        record(result)["todos"],
        record(record(result)["value"])["todos"],
      ];
      const raw = candidates.find((candidate) => Array.isArray(candidate));
      const items = Array.isArray(raw)
        ? raw.flatMap((entry) => {
            const entryRecord = record(entry);
            const content =
              typeof entryRecord["content"] === "string"
                ? entryRecord["content"]
                : typeof entryRecord["text"] === "string"
                  ? entryRecord["text"]
                  : undefined;
            if (content === undefined) return [];
            const status = typeof entryRecord["status"] === "string" ? entryRecord["status"] : undefined;
            return [{ content, status }];
          })
        : [];
      const summary = items
        .map((item) =>
          item.status === "completed"
            ? `✓ ${item.content}`
            : item.status === "inProgress"
              ? `… ${item.content}`
              : item.status === "cancelled"
                ? `✕ ${item.content}`
                : `○ ${item.content}`,
        )
        .join("\n");
      const body = summary.length > 0 ? summary : text(result);
      return { type: "plain_text", label: "todos", ...(body !== undefined ? { text: body } : {}) };
    }
    case "askQuestion": {
      const question =
        stringField("question") ??
        stringField("prompt") ??
        stringField("text") ??
        stringField("message") ??
        text(args);
      const nestedAnswer = record(record(result)["value"])["answer"];
      const answer =
        textOf(record(result)["answer"]) ??
        textOf(record(result)["response"]) ??
        textOf(record(result)["selected"]) ??
        textOf(nestedAnswer) ??
        text(result);
      const body =
        question !== undefined && answer !== undefined && result !== undefined
          ? `${question}\nAnswer: ${answer}`
          : (question ?? answer);
      return { type: "plain_text", label: "question", ...(body !== undefined ? { text: body } : {}) };
    }
    case "generateImage": {
      const description = stringField("description") ?? stringField("prompt") ?? name;
      const target =
        stringField("filePath") ??
        stringField("path") ??
        textOf(record(record(result)["value"])["filePath"]) ??
        textOf(record(result)["filePath"]);
      return {
        type: "plain_text",
        label: "image",
        text: target ? `${description} → ${target}` : description,
      };
    }
    case "mcp": {
      // MCP fans out to arbitrary server tools with no dedicated variant;
      // keep the server/tool identity in the label and the payload in text.
      const provider =
        stringField("providerIdentifier") ?? stringField("provider") ?? stringField("server");
      const tool = stringField("toolName") ?? stringField("tool");
      const parts = [provider, tool].filter(
        (part): part is string => typeof part === "string" && part.length > 0,
      );
      const body = text(result) ?? text(input["args"]) ?? text(args);
      return {
        type: "plain_text",
        label: parts.length > 0 ? `mcp ${parts.join(" ")}` : "mcp",
        ...(body !== undefined ? { text: body } : {}),
      };
    }
    case "applyAgentDiff": {
      // Shape is undocumented in the SDK shared types and may span files,
      // so edit (single filePath) could misattribute it; keep the diff text.
      const diff =
        stringField("diff") ??
        stringField("unifiedDiff") ??
        stringField("patch") ??
        stringField("content");
      return {
        type: "plain_text",
        label: "diff",
        text: diff ?? text(result) ?? text(args),
      };
    }
    default:
      return { type: "unknown", input: toJson({ args }), output: toJson({ result }) };
  }
}

/**
 * Conversation-step → SDK-message adapter for history replay.
 *
 * Stored local conversations (Agent.messages.list / run.conversation())
 * use `{ type: "agentConversationTurn", turn: { userMessage, steps } }`
 * with proto-case steps: `{ thinkingMessage: { text } }`,
 * `{ assistantMessage: { text } }`, and
 * `{ toolCall: { "<case>ToolCall": { args, result }, toolCallId } }`.
 * The adapter converts each step to the live-stream CursorSDKMessage shape
 * ({ type: "assistant" | "thinking" | "tool_call", ... }) so the existing
 * toTimelineItem helper renders both paths identically.
 *
 * Tool-name mapping: the ToolCall union's type literal ("shell", "read",
 * "glob", "grep", "edit", "write", "delete", "ls", "mcp", "task", ...)
 * is also the SDKMessage tool_call `name`, which toolDetail already maps.
 * Args carry the raw proto args verbatim ({ command } for shell, { path }
 * for read, { pattern } for grep, ...); results carry the { status, value }
 * envelope (or { error } on error), and only error envelopes flip the
 * timeline status to failed — matching live tool_call semantics where a
 * completed tool with an empty result is still "completed".
 *
 * Unknown tool cases are skipped (null), not rendered as "unknown" cards:
 * replay only resurfaces tools the provider knows how to render.
 */
export function stepToSDKMessage(step: unknown): CursorSDKMessage | null {
  // Stored steps arrive as live proto objects (class instances with
  // enumerable own fields — NOT plain objects, so recordOf() rejects them)
  // or as proto-JSON after a JSON round-trip ({ thinkingMessage: {...} }).
  // field() reads either shape: own/enumerable props on instances plus
  // proto-JSON keys. Never throws: getters on SDK classes are plain data
  // accessors, but any exotic shape still yields undefined, not an error.
  const field = (value: unknown, key: string): unknown => {
    if (value === null || value === undefined) return undefined;
    if (typeof value !== "object" && typeof value !== "function") return undefined;
    try {
      const own = (value as Record<string, unknown>)[key];
      if (own !== undefined) return own;
      return Reflect.get(value as object, key);
    } catch {
      return undefined;
    }
  };
  const asRecord = (value: unknown): Record<string, unknown> => {
    if (value === null || value === undefined) return {};
    if (typeof value !== "object" && typeof value !== "function") return {};
    const out: Record<string, unknown> = {};
    try {
      for (const key of Object.keys(value)) out[key] = (value as Record<string, unknown>)[key];
    } catch {
      return {};
    }
    return out;
  };
  // Flat SDK-shape steps from run.conversation(): { type, message }.
  // These already match CursorSDKMessage (minus agent/run ids); accept the
  // renderable ones directly. The conversation() accumulator emits
  // { type: "assistantMessage" | "thinkingMessage" | "toolCall", message }
  // inserts whose message payload is the checkout/proto payload, so only the
  // already-live shapes (assistant/thinking/tool_call) pass through here.
  const flatType = field(step, "type");
  if (
    flatType === "assistant" ||
    flatType === "thinking" ||
    flatType === "tool_call" ||
    flatType === "user"
  ) {
    return { agent_id: "", run_id: "", ...asRecord(step) } as CursorSDKMessage;
  }
  const message = field(field(step, "message"), "case") !== undefined ? field(step, "message") : (field(step, "message") ?? step);
  const caseName = field(message, "case");
  const messageValue = caseName !== undefined ? field(message, "value") : message;
  const pick = (name: string): unknown => {
    if (caseName === name) return messageValue;
    return field(message, name) ?? field(messageValue, name);
  };
  const thinkingText = field(pick("thinkingMessage"), "text");
  if (typeof thinkingText === "string") {
    if (!thinkingText) return null;
    return { type: "thinking", agent_id: "", run_id: "", text: thinkingText };
  }
  const assistantText = field(pick("assistantMessage"), "text");
  if (typeof assistantText === "string") {
    if (!assistantText) return null;
    return {
      type: "assistant",
      agent_id: "",
      run_id: "",
      message: {
        role: "assistant",
        content: [{ type: "text", text: assistantText }],
      },
    };
  }
  const toolCall = pick("toolCall");
  const toolCallRecord = asRecord(toolCall);
  if (Object.keys(toolCallRecord).length > 0 || field(toolCall, "tool") !== undefined) {
    const callId = field(toolCall, "toolCallId");
    // The payload is { "<camel>ToolCall": { args, result } } after a JSON
    // round-trip, or { tool: { case, value } } on live proto objects.
    // Prefer the named *ToolCall key; fall back to the proto tool wrapper.
    const named = Object.entries(toolCallRecord).find(
      ([key, value]) =>
        key !== "toolCallId" &&
        key !== "hookAdditionalContexts" &&
        key !== "startedAtMs" &&
        key !== "completedAtMs" &&
        key.endsWith("ToolCall") &&
        value !== null &&
        typeof value === "object",
    );
    const protoTool = field(toolCall, "tool");
    const toolCase = field(protoTool, "case");
    const toolValue = field(protoTool, "value");
    const payload = named ? asRecord(named[1]) : asRecord(toolValue);
    // Named JSON keys may be raw tool names without the suffix (e.g. the
    // checkout shape { type: "shell", args }); suffix-strip only when present.
    const rawName = named
      ? named[0].endsWith("ToolCall")
        ? named[0].slice(0, -"ToolCall".length)
        : named[0]
      : typeof toolCase === "string" && toolCase.endsWith("ToolCall")
        ? toolCase.slice(0, -"ToolCall".length)
        : toolCase;
    const name = toolCaseNameToSdkName(typeof rawName === "string" ? rawName : undefined);
    if (!name || Object.keys(payload).length === 0) return null;
    const args = field(payload, "args");
    const result = field(payload, "result");
    const failed = isErrorResult(result);
    return {
      type: "tool_call",
      agent_id: "",
      run_id: "",
      call_id: typeof callId === "string" ? callId : "",
      name,
      status: failed ? "error" : "completed",
      ...(args !== undefined ? { args } : {}),
      ...(result !== undefined ? { result } : {}),
    };
  }
  return null;
}

/**
 * Maps a stored ToolCall union case ("shellToolCall", "task", ...) to the
 * live-stream tool_call `name` ("shell", "read", "task", ...). The union's
 * type literals (shell, write, delete, glob, grep, read, edit, ls, mcp,
 * task, ...) are the SDK tool names toolDetail already renders; the only
 * renames are MCP-ish wrappers: getMcpToolsToolCall lists tools (skip) and
 * taskToolCall is the subagent tool ("task"). Returns null for unknown or
 * render-skipped cases.
 */
function toolCaseNameToSdkName(raw: string | undefined): string | null {
  if (!raw) return null;
  const lower = raw.toLowerCase();
  if (lower === "getmcptools") return null;
  if (lower === "tasktoolcall" || lower === "task") return "task";
  const known = new Set([
    "shell",
    "write",
    "delete",
    "glob",
    "grep",
    "read",
    "edit",
    "ls",
    "readlints",
    "mcp",
    "generateimage",
    "recordscreen",
    "semsearch",
    "createplan",
    "updatetodos",
    "task",
  ]);
  const found = [...known].find((name) => name === lower);
  return found ?? null;
}

/** True when a stored tool result envelope carries { status: "error" } or { error }. */
function isErrorResult(result: unknown): boolean {
  const record = recordOf(result);
  if (Object.keys(record).length === 0) return false;
  const status = record["status"];
  if (status === "error") return true;
  if (status === "success") return false;
  const nested = recordOf(record["result"]);
  if (nested["case"] === "error") return true;
  if (Object.keys(nested).length > 0 && nested["case"] !== "success") {
    return "error" in record || "error" in nested;
  }
  return "error" in record;
}

export function toTimelineItem(
  event: CursorSDKMessage,
  ids: { itemId: string },
): ProviderTimelineItem | null {
  switch (event.type) {
    case "assistant": {
      const text = event.message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
      if (!text) return null;
      return { type: "assistant_message", id: ids.itemId, messageId: ids.itemId, text };
    }
    case "thinking":
      if (!event.text) return null;
      return { type: "reasoning", id: ids.itemId, text: event.text };
    case "tool_call": {
      const callId = event.call_id || ids.itemId;
      if (event.status === "running") {
        return {
          type: "tool_call",
          id: ids.itemId,
          callId,
          name: event.name,
          detail: toolDetail(event.name, event.args, undefined),
          status: "running",
          error: null,
        };
      }
      if (event.status === "error") {
        return {
          type: "tool_call",
          id: ids.itemId,
          callId,
          name: event.name,
          detail: toolDetail(event.name, event.args, event.result),
          status: "failed",
          error: toJson(event.result ?? "Tool call failed"),
        };
      }
      return {
        type: "tool_call",
        id: ids.itemId,
        callId,
        name: event.name,
        detail: toolDetail(event.name, event.args, event.result),
        status: "completed",
        error: null,
      };
    }
    case "task":
      if (!event.text) return null;
      return { type: "notification", id: ids.itemId, level: "info", message: event.text };
    case "status":
      if (event.status === "ERROR") {
        return { type: "error", id: ids.itemId, message: event.message || "Cursor run failed" };
      }
      return null;
    default:
      return null;
  }
}

export function toUsage(usage: CursorTokenUsage | undefined): {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
} {
  if (!usage) return {};
  const out: { inputTokens?: number; cachedInputTokens?: number; outputTokens?: number } = {};
  if (typeof usage.inputTokens === "number") out.inputTokens = usage.inputTokens;
  if (typeof usage.cacheReadTokens === "number") out.cachedInputTokens = usage.cacheReadTokens;
  if (typeof usage.outputTokens === "number") out.outputTokens = usage.outputTokens;
  return out;
}

export function toUsageWithCost(
  usage: CursorTokenUsage | undefined,
  totalCostUsd?: number,
): {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  totalCostUsd?: number;
} {
  const out = toUsage(usage) as {
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
    totalCostUsd?: number;
  };
  if (typeof totalCostUsd === "number") out.totalCostUsd = totalCostUsd;
  return out;
}

export function newId(prefix: string): string {
  return `${prefix}:${randomUUID()}`;
}
