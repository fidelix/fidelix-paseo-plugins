import { homedir } from "node:os";
import path from "node:path";
import type {
  ProviderCatalog,
  ProviderConfigChanges,
  ProviderEvent,
  ProviderInput,
  ProviderModel,
  ProviderPersistence,
  ProviderPrompt,
  ProviderSessionConfig,
} from "@getpaseo/plugin/server/provider";
import type { PluginSettings } from "@getpaseo/plugin/server";
import type { cursorSettings } from "../shared/settings.js";

export type CursorPluginSettings = PluginSettings<(typeof cursorSettings)["schema"]>;

import { z } from "zod";
import { loadCursorSdk } from "./cursor-sdk-loader.js";
import type {
  CursorAgent,
  CursorAgentUsage,
  CursorModelListItem,
  CursorRun,
  CursorSDKMessage,
} from "./cursor-sdk-types.js";
import type {
  ProviderCommand,
  ProviderTimelineItem,
  ProviderUsage,
} from "@getpaseo/plugin/server/provider";
import {
  applySettings,
  CURSOR_SETTING_AUTO_REVIEW,
  DEFAULT_CURSOR_MODE,
  DEFAULT_CURSOR_MODEL,
  describeTaskArgs,
  describeTaskResult,
  findRawModel,
  newId,
  publishableConfig,
  resolveCursorModelParams,
  resolveCursorTools,
  resolveThinkingParam,
  selectedThinkingOption,
  stepToSDKMessage,
  taskArgsOf,
  toJsonValue,
  toProviderError,
  toProviderModels,
  toTimelineItem,
  toUsage,
  toUsageWithCost,
} from "./mapping.js";
import {
  classifyCursorError,
  DEFAULT_RETRY_POLICY,
  retryDelayMs,
  sleep,
  type RetryPolicy,
} from "./retry.js";

const CAPABILITIES = [
  "prompt.message",
  "prompt.image",
  "prompt.command",
  "prompt.steer",
  "session.configure",
  "session.list",
  "session.persistence",
  "session.archive",
  "session.unarchive",
  "session.revert.conversation",
  "session.subsession",
  "permission",
  // Advertises exact-MCP-preapproval support: `session.open` with a
  // toolPolicy requires this capability (see requiredProviderCapabilities in
  // @getpaseo/plugin). Honoring means MCP-only tools:["mcp"] — the SDK has
  // no per-server/per-tool gating. Without this, the daemon rejects
  // toolPolicy sessions before they reach openSession.
  "permission.tool_policy",
] as const;

const persistenceSchema = z
  .object({ version: z.literal(1), data: z.object({ agentId: z.string().min(1) }) })
  .strict();

interface SessionState {
  id: string;
  config: ProviderSessionConfig;
  model?: string;
  settings: Record<string, unknown>;
  models: ProviderModel[];
  /** Raw SDK catalog entries, for variant/parameter resolution (params/fast). */
  rawModels: CursorModelListItem[];
  /** Per-model stored thinking param values: raw model id -> param value. */
  thinkingSelections: Record<string, string>;
  agent: CursorAgent | null;
  activeTurnId: string | null;
  activeRun: CursorRun | null;
  closed: boolean;
  /** AbortController for the active turn's retry wait; aborted on interrupt/close. */
  turnAbort: AbortController | null;
  /** Monotonic turn counter feeding message ids and revert tokens. */
  turnSeq: number;
  /** user_message timeline ids in order, for revert targeting. */
  userMessageIds: string[];
}

interface ChildState {
  id: string;
  parentSessionId: string;
  toolCallId: string | null;
  description: string | null;
  subAgentType: string | null;
  logLines: string[];
  status: "running" | "completed" | "failed";
  items: number;
}

interface ProviderOptions {
  retry?: Partial<RetryPolicy>;
  settings?: CursorPluginSettings;
}

function readProcessApiKey(): string | undefined {
  const fromProcess = process.env["CURSOR_API_KEY"];
  return fromProcess && fromProcess.length > 0 ? fromProcess : undefined;
}

async function readStoredApiKey(
  settings: CursorPluginSettings | undefined,
): Promise<string | undefined> {
  if (!settings) return undefined;
  try {
    const state = await settings.read();
    if (state.status !== "ready") return undefined;
    const key = state.values.apiKey;
    return key && key.length > 0 ? key : undefined;
  } catch {
    return undefined;
  }
}

function storeRoot(config: Pick<ProviderSessionConfig, "env">): string {
  const base =
    config.env["CURSOR_SDK_STATE_ROOT"] || process.env["CURSOR_SDK_STATE_ROOT"] || path.join(homedir(), ".cursor", "sdk");
  return path.join(base, "paseo-plugin");
}

function openStore(config: ProviderSessionConfig): unknown {
  const { JsonlLocalAgentStore } = loadCursorSdk();
  const root = storeRoot(config);
  try {
    return new JsonlLocalAgentStore(root);
  } catch (error) {
    throw new Error(
      `Cursor local store is unusable at ${root}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Open the local store for a cwd without a full session config (sessions list). */
function openStoreForCwd(cwd: string): unknown {
  return openStore({ env: {}, cwd, mcpServers: {}, settings: {}, persist: false });
}

function promptText(prompt: ProviderPrompt): {
  text: string;
  images: Array<{ data: string; mimeType: string }>;
} {
  if (prompt.input.type === "command") {
    const text = commandPromptText(prompt.input);
    if (text === null) throw new Error(`Unknown Cursor command: ${prompt.input.name}`);
    return { text, images: [] };
  }
  const text: string[] = [];
  const images: Array<{ data: string; mimeType: string }> = [];
  for (const part of prompt.input.content) {
    if (part.type === "text") text.push(part.text);
    else if (part.type === "image") images.push({ data: part.data, mimeType: part.mimeType });
    else throw new Error("Cursor provider supports text and image content only");
  }
  return { text: text.join("\n"), images };
}

function promptLabel(prompt: ProviderPrompt): string {
  if (prompt.input.type === "command") {
    const args = prompt.input.arguments.trim();
    return args ? `/${prompt.input.name} ${args}` : `/${prompt.input.name}`;
  }
  return promptText(prompt).text;
}

export function createCursorProvider(options: ProviderOptions = {}): {
  id: string;
  label: string;
  description: string;
  icon: string;
  connect: (request: {
    versions: readonly number[];
    capabilities: readonly string[];
  }) => Promise<{
    version: number;
    capabilities: readonly string[];
    send: (input: ProviderInput) => Promise<void>;
    onEvent: (listener: (event: ProviderEvent) => void) => () => void;
    close: () => Promise<void>;
  }>;
} {
  const retry: RetryPolicy = { ...DEFAULT_RETRY_POLICY, ...options.retry };
  const settings = options.settings;
  // Catalog cache lives at provider scope (not per connection) so a key
  // saved in the settings UI invalidates the keyless fallback everywhere.
  // Subscribe once per provider, not per connection.
  let settingsUnsubscribe: (() => void) | null = null;
  function watchSettings(): void {
    if (settingsUnsubscribe || !settings) return;
    settingsUnsubscribe = settings.subscribe(() => {
      discoveredModels = null;
    });
  }
  function unwatchSettings(): void {
    settingsUnsubscribe?.();
    settingsUnsubscribe = null;
  }
  let discoveredModels: { models: ProviderModel[]; raw: CursorModelListItem[] } | null = null;
  return {
    id: "cursor-sdk",
    label: "Cursor SDK",
    description: "Cursor coding agent via the official Cursor SDK (local runtime)",
    icon: "icon.svg",
    async connect(request) {
      if (!request.versions.includes(1)) {
        throw new Error("Provider protocol version 1 is required");
      }
      // Auth resolution is async (host-scoped settings); warn instead of
      // failing here so sessions can still open once a key is saved. Note
      // the SDK also falls back to a stored Cursor.auth.login() key on its
      // own, which this check cannot see — absence of a warning is not a
      // guarantee, and presence of one is not fatal if login exists.
      void readStoredApiKey(settings).then((key) => {
        if (!key) {
          console.error(
            "cursor-sdk provider: no API key in plugin settings; save one in the Cursor settings screen, sign in there, or export CURSOR_API_KEY",
          );
        }
      });
      watchSettings();
      const catalogStore = {
        read: () => discoveredModels,
        write: (models: ProviderModel[], raw: CursorModelListItem[]) =>
          (discoveredModels = { models, raw }),
        clear: () => {
          discoveredModels = null;
        },
      };
      const connection = createConnection(retry, settings, catalogStore);
      const originalClose = connection.close.bind(connection);
      return {
        ...connection,
        close: async () => {
          // Last connection out stops watching; a fresh connect re-subscribes.
          unwatchSettings();
          await originalClose();
        },
      };
    },
  };
}

function createConnection(
  retry: RetryPolicy,
  settings: CursorPluginSettings | undefined,
  invalidateCatalog: {
    read: () => { models: ProviderModel[]; raw: CursorModelListItem[] } | null;
    write: (
      models: ProviderModel[],
      raw: CursorModelListItem[],
    ) => { models: ProviderModel[]; raw: CursorModelListItem[] };
    clear: () => void;
  },
): {
  version: number;
  capabilities: readonly string[];
  send: (input: ProviderInput) => Promise<void>;
  onEvent: (listener: (event: ProviderEvent) => void) => () => void;
  close: () => Promise<void>;
} {
  const sessions = new Map<string, SessionState>();
  /** Provider-owned child sessions keyed by child session id. */
  const children = new Map<string, ChildState>();
  const listeners = new Set<(event: ProviderEvent) => void>();
  const permissions = new Map<string, { sessionId: string; requestId: string }>();
  let closed = false;
  let pending = Promise.resolve();

  function emit(event: ProviderEvent): void {
    if (closed) return;
    for (const listener of listeners) listener(event);
  }

  function session(id: string): SessionState {
    const found = sessions.get(id);
    if (!found) throw new Error(`Unknown Cursor session: ${id}`);
    return found;
  }

  /** Raw catalog id for a model reference (follows aliases); falls back to the reference. */
  function canonicalKey(
    rawModels: CursorModelListItem[],
    modelId: string | undefined,
  ): string {
    if (!modelId) return "default";
    return (
      rawModels.find((item) => item.id === modelId || item.aliases?.includes(modelId))?.id ??
      modelId
    );
  }

  interface StoredAgentInfo {
    agentId: string;
    name?: string;
    summary?: string;
    lastModified?: number;
    cwd?: string;
  }

  function safeCwd(): string {
    try {
      return process.cwd();
    } catch {
      return "";
    }
  }

  /**
   * Sessions list: live connections first, then persisted local agents from
   * Agent.list merged in. Live sessions win on persistence agentId so a
   * resumed runtime is never duplicated by its own JSONL record.
   *
   * Agent.list is a key-only store read (no inference). Failures fall back
   * to live-only rather than failing the request: the daemon still gets a
   * usable session list when the store is unreadable.
   */
  async function listSessions(input: { query?: string; cwd?: string; limit?: number }): Promise<
    Array<{
      persistence: ProviderPersistence;
      cwd: string;
      title?: string;
      description?: string;
      updatedAt?: string;
    }>
  > {
    const query = input.query?.trim().toLowerCase() || undefined;
    const matches = (text: string | undefined): boolean => {
      if (!query) return true;
      return (text ?? "").toLowerCase().includes(query);
    };
    const seen = new Set<string>();
    const out: Array<{
      persistence: ProviderPersistence;
      cwd: string;
      title?: string;
      description?: string;
      updatedAt?: string;
    }> = [];
    for (const state of sessions.values()) {
      if (input.cwd && state.config.cwd !== input.cwd) continue;
      const agentId = state.agent?.agentId ?? state.id;
      seen.add(agentId);
      const title = state.config.title;
      if (!matches(title) && !matches(agentId)) continue;
      out.push({
        persistence: { version: 1, data: { agentId } },
        cwd: state.config.cwd,
        ...(title ? { title } : {}),
      });
    }
    if (input.limit !== undefined && out.length >= input.limit) return out.slice(0, input.limit);
    try {
      const { Agent } = loadCursorSdk();
      // The daemon fans this request out per provider AND per cwd (the
      // import dialog sends request.cwd), so the common case is a single
      // exact-cwd query. Without input.cwd, fall back to live-known cwds plus
      // the process cwd: an unfiltered Agent.list call only returns
      // store-wide records when the backend supports it, and the JSONL store
      // requires an exact cwd match (it returns none otherwise).
      const cwds = input.cwd
        ? [input.cwd]
        : [...new Set([...[...sessions.values()].map((state) => state.config.cwd), safeCwd()])];
      // Agent.list is untyped on the loader (loader/types pattern only, no
      // static SDK imports), so cast to the structural list surface here.
      // Signature verified against agent.d.ts ListAgentsOptions/list return.
      const listable = Agent as unknown as {
        list(options?: Record<string, unknown>): Promise<{
          items: StoredAgentInfo[];
          nextCursor?: string;
        }>;
      };
      const listed = (
        await Promise.all(
          cwds.map((cwd) =>
            listable.list({ runtime: "local", cwd, store: openStoreForCwd(cwd) }).catch(() => ({
              items: [] as StoredAgentInfo[],
            })),
          ),
        )
      ).flatMap((result) => result.items ?? []);
      const stored = [...listed].sort(
        (a, b) => (b.lastModified ?? 0) - (a.lastModified ?? 0),
      );
      for (const item of stored) {
        if (seen.has(item.agentId)) continue;
        seen.add(item.agentId);
        const cwd = item.cwd ?? input.cwd ?? process.cwd();
        if (input.cwd && cwd !== input.cwd) continue;
        const title = item.name && item.name !== "New Agent" ? item.name : undefined;
        if (!matches(title) && !matches(item.summary) && !matches(item.agentId)) continue;
        out.push({
          persistence: { version: 1, data: { agentId: item.agentId } },
          cwd,
          ...(title ? { title } : {}),
          ...(item.summary ? { description: item.summary } : {}),
          ...(typeof item.lastModified === "number"
            ? { updatedAt: new Date(item.lastModified).toISOString() }
            : {}),
        });
        if (input.limit !== undefined && out.length >= input.limit) break;
      }
    } catch {
      // Store read failures fall back to the live-only list above.
    }
    return out;
  }

  async function readKey(config: ProviderSessionConfig): Promise<string | undefined> {
    // Explicit overrides only. When nothing is configured, callers omit
    // apiKey so the SDK falls back to CURSOR_API_KEY / stored login itself.
    // (Daemon process env is NOT read here: explicit empty env would bypass
    // the SDK fallback, and the daemon env belongs to the daemon host, not
    // the provider session.)
    const fromEnv = config.env["CURSOR_API_KEY"];
    if (fromEnv && fromEnv.length > 0) return fromEnv;
    return readStoredApiKey(settings);
  }

  function readCache(): { models: ProviderModel[]; raw: CursorModelListItem[] } | null {
    return invalidateCatalog.read();
  }

  function writeCache(
    models: ProviderModel[],
    raw: CursorModelListItem[],
  ): { models: ProviderModel[]; raw: CursorModelListItem[] } {
    return invalidateCatalog.write(models, raw);
  }

  async function ensureCatalog(
    config: ProviderSessionConfig,
  ): Promise<{ models: ProviderModel[]; raw: CursorModelListItem[] }> {
    const cached = readCache();
    if (cached) return { models: cached.models, raw: cached.raw };
    // No explicit key required: the SDK falls back to CURSOR_API_KEY and
    // then the stored Cursor.auth.login() key by itself. Pass it through
    // only when the user configured one explicitly (env override, plugin
    // settings); otherwise omit it so the SDK's own fallback chain runs.
    const apiKey = await readKey(config);
    const { Cursor } = loadCursorSdk();
    const raw = (await Cursor.models.list(
      apiKey ? { apiKey } : {},
    )) as CursorModelListItem[];
    const written = writeCache(toProviderModels(raw), raw);
    return { models: written.models, raw: written.raw };
  }

  async function dispatch(input: ProviderInput): Promise<void> {
    if (isRevertInput(input)) {
      await revertSession(session(input.sessionId), input);
      emit({ type: "request.completed", requestId: input.requestId });
      return;
    }
    switch (input.type) {
      case "catalog": {
        // Same fallback as ensureCatalog: explicit key when configured,
        // otherwise let the SDK use CURSOR_API_KEY / stored login itself.
        // No key anywhere just fails the list call, which falls back below.
        const apiKey = (await readStoredApiKey(settings)) ?? readProcessApiKey();
        try {
          const { Cursor } = loadCursorSdk();
          const raw = (await Cursor.models.list(
            apiKey ? { apiKey } : {},
          )) as CursorModelListItem[];
          const cached = writeCache(toProviderModels(raw), raw);
          emit({
            type: "catalog",
            requestId: input.requestId,
            catalog: toCatalog(cached.models),
          });
        } catch {
          emit({ type: "catalog", requestId: input.requestId, catalog: fallbackCatalog() });
        }
        return;
      }
      case "sessions": {
        emit({
          type: "sessions",
          requestId: input.requestId,
          sessions: await listSessions(input),
        });
        return;
      }
      case "session.open": {
        if (sessions.has(input.sessionId)) {
          throw new Error(`Session already exists: ${input.sessionId}`);
        }
        const { models, raw } = await ensureCatalog(input.config);
        const state: SessionState = {
          id: input.sessionId,
          config: input.config,
          model: input.config.model,
          settings: { ...(input.config.settings ?? {}) },
          models,
          rawModels: raw,
          // Seed from the daemon's launch config so a restored draft
          // (model + thinking + fast feature values) applies from the first
          // turn, not only after a configure round-trip.
          thinkingSelections:
            input.config.thinkingOption !== undefined
              ? { [canonicalKey(raw, input.config.model)]: input.config.thinkingOption }
              : {},
          agent: null,
          activeTurnId: null,
          activeRun: null,
          closed: false,
          turnAbort: null,
          turnSeq: 0,
          userMessageIds: [],
        };
        sessions.set(input.sessionId, state);
        try {
          await openSession(state, input.config, input.persistence, input.requestId);
        } catch (error) {
          sessions.delete(input.sessionId);
          await closeAgent(state).catch(() => undefined);
          throw error;
        }
        return;
      }
      case "session.prompt":
        await runPrompt(session(input.sessionId), input.prompt);
        return;
      case "session.configure": {
        const state = session(input.sessionId);
        applyConfigure(state, input.changes);
        emit({ type: "request.completed", requestId: input.requestId });
        return;
      }
      case "session.interrupt": {
        const state = session(input.sessionId);
        state.turnAbort?.abort();
        await state.activeRun?.cancel().catch(() => undefined);
        emit({ type: "request.completed", requestId: input.requestId });
        return;
      }
      case "session.permission": {
        const pendingPermission = permissions.get(input.permissionId);
        if (!pendingPermission || pendingPermission.sessionId !== input.sessionId) {
          throw new Error(`Unknown Cursor permission: ${input.permissionId}`);
        }
        permissions.delete(input.permissionId);
        // The Cursor SDK local runtime runs headless: tool calls execute
        // without interactive approval. Deny interrupts the active run.
        if (input.response.behavior === "deny") {
          const state = sessions.get(input.sessionId);
          await state?.activeRun?.cancel().catch(() => undefined);
        }
        emit({
          type: "session.permission_resolved",
          sessionId: input.sessionId,
          permissionId: input.permissionId,
        });
        return;
      }
      case "session.archive":
        await archiveSession(input.persistence);
        emit({ type: "request.completed", requestId: input.requestId });
        return;
      case "session.unarchive":
        await unarchiveSession(input.persistence);
        emit({ type: "request.completed", requestId: input.requestId });
        return;
      case "session.close": {
        const state = sessions.get(input.sessionId);
        if (state) {
          state.closed = true;
          state.turnAbort?.abort();
          await state.activeRun?.cancel().catch(() => undefined);
          await closeAgent(state).catch(() => undefined);
          sessions.delete(input.sessionId);
        }
        emit({ type: "session.closed", sessionId: input.sessionId });
        return;
      }
      default: {
        const kind: string = (input as { type: string }).type;
        throw new Error(`Unsupported Cursor operation: ${kind}`);
      }
    }
  }

  function isRevertInput(
    value: ProviderInput,
  ): value is Extract<ProviderInput, { type: "session.revert" }> {
    return (value as { type: string }).type === "session.revert";
  }

  function failed(input: ProviderInput, error: unknown): void {
    const providerError = toProviderError(error);
    if (input.type === "session.prompt") {
      emit({
        type: "session.prompt_result",
        sessionId: input.sessionId,
        clientMessageId: input.prompt.clientMessageId,
        result: { type: "failed", error: providerError },
      });
    } else if ("requestId" in input) {
      emit({ type: "request.failed", requestId: input.requestId, error: providerError });
    }
  }

  function resolveModelSelection(state: SessionState): { id: string } | { id: string; params: Array<{ id: string; value: string }> } {
    const modelId = state.model ?? DEFAULT_CURSOR_MODEL;
    const resolved = resolveCursorModelParams({
      modelId: state.model,
      rawModels: state.rawModels,
      thinkingSelections: state.thinkingSelections,
      fast: state.settings["fast"],
    });
    if (resolved) return resolved;
    return { id: modelId };
  }

  /**
   * Tool allowlist for this session. The daemon only sends exact MCP
   * preapprovals, so a non-empty toolPolicy means MCP-only (`["mcp"]`); an
   * ask-like mode means read-only. Never persisted by the SDK — re-passed on
   * every create/resume. Returns undefined for the SDK default toolset.
   * Documented in mapping.resolveCursorTools.
   */
  function sessionTools(state: SessionState): ["mcp"] | ["read", "grep", "glob", "ls"] | undefined {
    return resolveCursorTools({
      toolPolicy: state.config.toolPolicy,
      mode: state.config.mode,
    }) as ["mcp"] | ["read", "grep", "glob", "ls"] | undefined;
  }

  async function openSession(
    state: SessionState,
    config: ProviderSessionConfig,
    persistence: ProviderPersistence | undefined,
    requestId: string,
  ): Promise<void> {
    const { Agent } = loadCursorSdk();
    // Explicit key when configured; otherwise omit so the SDK falls back to
    // CURSOR_API_KEY / stored login itself.
    const apiKey = await readKey(config);
    const store = openStore(config);
    const persistedAgentId = persistence
      ? persistenceSchema.parse(persistence).data.agentId
      : undefined;
    const tools = sessionTools(state);
    const agent = (
      persistedAgentId
        ? await Agent.resume(persistedAgentId, {
            ...(apiKey ? { apiKey } : {}),
            model: resolveModelSelection(state),
            ...(tools ? { tools } : {}),
            local: { cwd: config.cwd, store },
          })
        : await Agent.create({
            ...(apiKey ? { apiKey } : {}),
            model: resolveModelSelection(state),
            ...(tools ? { tools } : {}),
            local: {
              cwd: config.cwd,
              store,
              autoReview: state.settings[CURSOR_SETTING_AUTO_REVIEW] === true,
            },
            ...(config.systemPrompt ? { systemPrompt: config.systemPrompt } : {}),
            mcpServers: toMcpServers(config),
          })
    ) as CursorAgent;
    state.agent = agent;
    if (config.persist) {
      const value = { version: 1, data: { agentId: agent.agentId } } as ProviderPersistence;
      emit({ type: "session.persistence", sessionId: state.id, persistence: value });
    }
    emit({
      type: "session.opened",
      requestId,
      sessionId: state.id,
      capabilities: [...CAPABILITIES],
      restoration: "core",
      ...(config.persist
        ? { persistence: { version: 1, data: { agentId: agent.agentId } } as ProviderPersistence }
        : {}),
      cwd: config.cwd,
      ...(config.title ? { title: config.title } : {}),
    });
    emit({
      type: "session.config",
      sessionId: state.id,
      config: publishableConfig(currentConfig(state)),
    });
    emit({
      type: "session.commands",
      sessionId: state.id,
      commands: [...BUILTIN_COMMANDS],
    });
    if (persistence && persistedAgentId) {
      await replayHistory(state, agent, config);
    }
    emit({ type: "session.ready", requestId, sessionId: state.id });
  }

  function applyConfigure(state: SessionState, changes: ProviderConfigChanges): void {
    if (changes.model !== undefined) {
      // Model switches apply on the next prompt; the SDK resolves per-send.
      // Re-key the thinking dropdown to the new model (stored selection if
      // valid, else the new model's default) so a stale value from the old
      // model never leaks into params or selection.
      state.model = changes.model ?? undefined;
    }
    if (changes.thinkingOption !== undefined && changes.thinkingOption !== null) {
      // Thinking ids are thinking-param *values* (low/medium/high/…) for the
      // current model; resolveThinkingParam throws for unknown ids. Stored
      // per raw model id so switching models keeps each model's own value.
      const { value } = resolveThinkingParam({
        thinkingOption: changes.thinkingOption,
        modelId: state.model,
        rawModels: state.rawModels,
      });
      const key = findRawModel(state.rawModels, state.model)?.id ?? state.model ?? "default";
      state.thinkingSelections[key] = value;
    }
    if (changes.thinkingOption === null) {
      const key = findRawModel(state.rawModels, state.model)?.id ?? state.model ?? "default";
      delete state.thinkingSelections[key];
    }
    applySettings(state.settings, changes.settings as Record<string, unknown> | undefined);
    if (changes.mode !== undefined) {
      state.config = {
        ...state.config,
        mode: changes.mode ?? undefined,
      };
    }
    emit({
      type: "session.config",
      sessionId: state.id,
      config: publishableConfig(currentConfig(state)),
    });
  }

  /** Emit the current session config: selected model, its thinking value, per-model dropdown, settings. */
  function currentConfig(state: SessionState): Parameters<typeof publishableConfig>[0] {
    return {
      model: state.model,
      mode: state.config.mode,
      thinkingOption: selectedThinkingOption({
        rawModels: state.rawModels,
        modelId: state.model,
        thinkingSelections: state.thinkingSelections,
      }),
      settings: state.settings,
      models: state.models,
      rawModels: state.rawModels,
      thinkingSelections: state.thinkingSelections,
    };
  }

  async function runPrompt(state: SessionState, prompt: ProviderPrompt): Promise<void> {
    if (!state.agent) throw new Error("Cursor session is not open");
    if (prompt.input.type === "command" && commandPromptText(prompt.input) === null) {
      emit({
        type: "session.prompt_result",
        sessionId: state.id,
        clientMessageId: prompt.clientMessageId,
        result: { type: "failed", error: { message: `Unknown Cursor command: ${prompt.input.name}` } },
      });
      return;
    }
    if (state.activeTurnId) {
      if (prompt.delivery === "steer") {
        const outcome = await state.activeRun?.steer?.(promptText(prompt).text).catch(
          () => undefined,
        );
        if (outcome === "complete_delivered" && state.activeTurnId) {
          emit({
            type: "session.prompt_result",
            sessionId: state.id,
            clientMessageId: prompt.clientMessageId,
            result: { type: "steer", turnId: state.activeTurnId },
          });
          return;
        }
      }
      throw new Error("Cursor already has an active turn; wait for it to finish");
    }
    if (prompt.delivery === "steer") {
      emit({
        type: "session.prompt_result",
        sessionId: state.id,
        clientMessageId: prompt.clientMessageId,
        result: { type: "failed", error: { message: "There is no active turn to steer" } },
      });
      return;
    }
    const { text, images } = promptText(prompt);
    const turnId = newId("turn");
    state.activeTurnId = turnId;
    state.turnAbort = new AbortController();
    state.turnSeq += 1;
    const messageId = `user:${state.turnSeq}`;
    emit({
      type: "session.prompt_result",
      sessionId: state.id,
      clientMessageId: prompt.clientMessageId,
      result: { type: "turn", turnId },
    });
    emit({ type: "session.turn", sessionId: state.id, turnId, state: "started" });
    emit({
      type: "timeline.item",
      sessionId: state.id,
      item: {
        type: "user_message",
        id: messageId,
        text,
        clientMessageId: prompt.clientMessageId,
        revertToken: { messageId },
      },
    });
    state.userMessageIds.push(messageId);
    try {
      const result = await sendWithRetry(state, text, images, turnId);
      state.activeTurnId = null;
      state.activeRun = null;
      state.turnAbort = null;
      if (result.status === "cancelled") {
        emit({ type: "session.turn", sessionId: state.id, turnId, state: "canceled" });
        return;
      }
      if (result.status === "error") {
        emit({
          type: "session.turn",
          sessionId: state.id,
          turnId,
          state: "failed",
          error: result.error ?? { message: "Cursor run failed" },
        });
        return;
      }
      emit({ type: "session.turn", sessionId: state.id, turnId, state: "completed" });
    } catch (error) {
      state.activeTurnId = null;
      state.activeRun = null;
      state.turnAbort = null;
      emit({
        type: "session.turn",
        sessionId: state.id,
        turnId,
        state: "failed",
        error: toProviderError(error),
      });
    }
  }

  async function sendWithRetry(
    state: SessionState,
    text: string,
    images: Array<{ data: string; mimeType: string }>,
    turnId: string,
  ): Promise<
    { status: "finished" | "cancelled" } | { status: "error"; error: { message: string; code?: string } }
  > {
    let attempt = 0;
    for (;;) {
      attempt += 1;
      try {
        const run = (await state.agent!.send(images.length > 0 ? { text, images } : text, {
          model: resolveModelSelection(state),
          mode: toAgentMode(state.config.mode),
          mcpServers: toMcpServers(state.config),
        })) as CursorRun;
        state.activeRun = run;
        await drainRun(state, run, turnId);
        const result = await run.wait();
        emitTurnUsage(state, turnId, toUsageWithCost(result.usage, await readTurnCostUsd(state)));
        if (result.status === "finished") return { status: "finished" };
        if (result.status === "cancelled") return { status: "cancelled" };
        const classified = classifyCursorError(
          result.error
            ? { message: result.error.message, code: result.error.code }
            : result.error,
        );
        if (classified.retryable && attempt < retry.maxAttempts) {
          emitRetryNotice(state, turnId, attempt, classified.message);
          const signal = state.turnAbort?.signal;
          try {
            await sleep(retryDelayMs(attempt, retry), signal);
          } catch {
            if (signal?.aborted) return { status: "cancelled" };
            throw new Error(classified.message);
          }
          continue;
        }
        return { status: "error", error: { message: classified.message, code: classified.code } };
      } catch (error) {
        const classified = classifyCursorError(error);
        if (classified.retryable && attempt < retry.maxAttempts) {
          emitRetryNotice(state, turnId, attempt, classified.message);
          const signal = state.turnAbort?.signal;
          try {
            await sleep(retryDelayMs(attempt, retry), signal);
          } catch {
            if (signal?.aborted) return { status: "cancelled" };
            throw error;
          }
          continue;
        }
        throw error;
      }
    }
  }

  function emitRetryNotice(
    state: SessionState,
    turnId: string,
    attempt: number,
    message: string,
  ): void {
    emit({
      type: "session.notice",
      sessionId: state.id,
      notice: {
        id: `${turnId}:retry-${attempt}`,
        severity: "warning",
        title: `Cursor retry ${attempt}/${retry.maxAttempts - 1}`,
        description: message,
      },
    });
  }

  /**
   * Best-effort billed cost for the just-finished turn. agent.getUsage() is
   * a key-only API read (no inference); totalCostUsd is eventually
   * consistent and may lag right after a run, so absence is normal and never
   * fails the turn. Emits nothing when there is neither usage nor cost.
   */
  async function readTurnCostUsd(state: SessionState): Promise<number | undefined> {
    try {
      const agent = state.agent;
      if (!agent) return undefined;
      const billed = (await agent.getUsage()) as CursorAgentUsage | null | undefined;
      const cost = billed?.cost;
      const cents =
        cost && typeof cost.chargedCents === "number"
          ? cost.chargedCents
          : cost && typeof cost.rawCostCents === "number"
            ? cost.rawCostCents
            : undefined;
      return typeof cents === "number" && Number.isFinite(cents) ? cents / 100 : undefined;
    } catch {
      return undefined;
    }
  }

  function emitTurnUsage(
    state: SessionState,
    turnId: string,
    usage: ProviderUsage,
  ): void {
    if (Object.keys(usage).length === 0) return;
    emit({ type: "session.usage", sessionId: state.id, turnId, usage });
  }

  async function drainRun(state: SessionState, run: CursorRun, turnId: string): Promise<void> {
    let assistantText = "";
    let assistantId: string | null = null;
    const toolItems = new Map<string, string>();
    // Provider-owned child sessions keyed by SDK call id for this turn.
    const turnChildren = new Map<string, string>();
    for await (const event of run.stream()) {
      if (state.closed) break;
      if (event.type === "assistant") {
        const text = event.message.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("");
        if (!text) continue;
        assistantText += text;
        assistantId ??= newId("assistant");
        emit({
          type: "timeline.item",
          sessionId: state.id,
          item: {
            type: "assistant_message",
            id: assistantId,
            messageId: assistantId,
            text: assistantText,
          },
        });
        continue;
      }
      if (event.type === "usage") {
        emit({ type: "session.usage", sessionId: state.id, turnId, usage: toUsage(event.usage) });
        continue;
      }
      if (event.type === "request") {
        const permissionId = newId("permission");
        permissions.set(permissionId, { sessionId: state.id, requestId: event.request_id });
        emit({
          type: "session.permission",
          sessionId: state.id,
          request: {
            id: permissionId,
            name: "cursor-input",
            kind: "question",
            title: "Cursor is waiting for input",
            description: `Request ${event.request_id}`,
          },
        });
        continue;
      }
      const item = toTimelineItem(event, {
        itemId:
          event.type === "tool_call" ? (toolItems.get(event.call_id) ?? newId("tool")) : newId("item"),
      });
      if (event.type === "tool_call" && item) {
        toolItems.set(event.call_id, item.id);
        trackTaskToolCall(state, turnChildren, event, item);
      }
      if (item) {
        emit({ type: "timeline.item", sessionId: state.id, item });
      }
    }
    // Any child still marked running when the stream ends finished with the turn.
    for (const childId of turnChildren.values()) {
      finishChild(childId, "completed");
    }
  }

  /**
   * Maps SDK `task` tool calls to provider-owned child sessions. The SDK
   * runs subagents in-process with no separate session handle; Paseo's
   * subagents track needs explicit session.opened (restoration "parent") +
   * timeline rows, so the provider owns that mapping. Each SDK call id gets
   * one child session; the running tool card carries the childSessionId.
   */
  function trackTaskToolCall(
    state: SessionState,
    turnChildren: Map<string, string>,
    event: Extract<CursorSDKMessage, { type: "tool_call" }>,
    item: ProviderTimelineItem,
  ): void {
    if (event.name !== "task") return;
    if (item.type !== "tool_call") return;
    const key = `${state.activeTurnId ?? "turn"}:${event.call_id}`;
    let childId = turnChildren.get(key);
    if (!childId) {
      childId = newId("cursor-child");
      turnChildren.set(key, childId);
      const taskArgs = taskArgsOf(event.args);
      const child: ChildState = {
        id: childId,
        parentSessionId: state.id,
        toolCallId: item.callId,
        description: taskArgs.description ?? null,
        subAgentType: taskArgs.subagentType ?? null,
        logLines: [],
        status: "running",
        items: 0,
      };
      children.set(childId, child);
      emit({
        type: "session.opened",
        sessionId: childId,
        parentSessionId: state.id,
        toolCallId: item.callId,
        capabilities: [],
        restoration: "parent",
        title: taskArgs.description ?? "Cursor subagent",
        description: taskArgs.prompt ?? undefined,
        cwd: state.config.cwd,
      });
      emit({ type: "session.ready", sessionId: childId });
      // Rewrite the parent tool card with the child link once the child exists.
      const subAgentDetail = {
        type: "sub_agent" as const,
        ...(taskArgs.subagentType ? { subAgentType: taskArgs.subagentType } : {}),
        ...(taskArgs.description ? { description: taskArgs.description } : {}),
        childSessionId: childId,
        log: "",
      };
      if (event.status === "error") {
        emit({
          type: "timeline.item",
          sessionId: state.id,
          item: {
            type: "tool_call",
            id: item.id,
            callId: item.callId,
            name: item.name,
            detail: subAgentDetail,
            status: "failed",
            error: toJsonValue(event.result),
          },
        });
      } else {
        emit({
          type: "timeline.item",
          sessionId: state.id,
          item: {
            type: "tool_call",
            id: item.id,
            callId: item.callId,
            name: item.name,
            detail: subAgentDetail,
            status: "running",
            error: null,
          },
        });
      }
    }
    const child = children.get(childId);
    if (!child) return;
    if (event.status !== "running" && child.status === "running") {
      finishChild(childId, event.status === "error" ? "failed" : "completed");
    }
    if (event.status === "running") {
      appendChildLog(childId, describeTaskArgs(event.args));
    } else {
      appendChildLog(childId, describeTaskResult(event.result, event.status === "error"));
    }
  }

  function finishChild(childId: string, status: "completed" | "failed"): void {
    const child = children.get(childId);
    if (!child || child.status !== "running") return;
    child.status = status;
    emit({
      type: "timeline.item",
      sessionId: childId,
      item: {
        type: "notification",
        id: newId("child-end"),
        level: status === "completed" ? "info" : "error",
        message: status === "completed" ? "Subagent finished" : "Subagent failed",
      },
    });
    children.delete(childId);
    emit({ type: "session.closed", sessionId: childId });
  }

  function appendChildLog(childId: string, line: string | null): void {
    if (!line) return;
    const child = children.get(childId);
    if (!child || child.status !== "running") return;
    child.items += 1;
    child.logLines.push(line);
    emit({
      type: "timeline.item",
      sessionId: childId,
      item: {
        type: "assistant_message",
        id: `${childId}:log:${child.items}`,
        text: line,
      },
    });
  }

  async function replayHistory(
    state: SessionState,
    agent: CursorAgent,
    config: ProviderSessionConfig,
  ): Promise<void> {
    void agent;
    try {
      const { Agent } = loadCursorSdk();
      const store = openStore(config);
      const messages = (await Agent.messages.list(state.agent?.agentId ?? "", {
        runtime: "local",
        cwd: config.cwd,
        store,
      })) as Array<{ type: string; message: unknown }>;
      // Stored local turns are { agentConversationTurn: { userMessage, steps } }
      // (proto JSON shape) — expand to one timeline row per user message and
      // per step, preserving order, then cap at the last 20 rows. Steps go
      // through stepToSDKMessage → toTimelineItem so tool calls replay with
      // the same cards as live turns. Images attached to the user message
      // surface as a text path hint (provider timeline has no image row).
      const rows: ProviderTimelineItem[] = [];
      const push = (item: ProviderTimelineItem | null): void => {
        if (item) rows.push(item);
      };
      for (const message of messages) {
        const turn = turnOf(message.message);
        const userText = userTextOf(turn?.user);
        if (userText) {
          state.turnSeq += 1;
          const messageId = `user:${state.turnSeq}`;
          state.userMessageIds.push(messageId);
          push({
            type: "user_message",
            id: newId("user"),
            text: userText,
            revertToken: { messageId },
          });
          for (const hint of imageHintsOf(turn?.user)) {
            push({ type: "assistant_message", id: newId("image-hint"), text: hint });
          }
        } else {
          // Legacy shape: bare { text } user envelope.
          const text = readMessageText(message.message);
          if (text && message.type === "user") {
            state.turnSeq += 1;
            const messageId = `user:${state.turnSeq}`;
            state.userMessageIds.push(messageId);
            push({ type: "user_message", id: newId("user"), text, revertToken: { messageId } });
          }
        }
        for (const step of turn?.steps ?? []) {
          const event = stepToSDKMessage(step);
          if (!event) continue;
          push(toTimelineItem(event, { itemId: newId("history") }));
        }
        // Legacy shape: bare-text assistant envelope without turn structure.
        if (!turn && message.type !== "user") {
          const text = readMessageText(message.message);
          if (text) push({ type: "assistant_message", id: newId("history"), text });
        }
      }
      for (const item of rows.slice(-20)) {
        emit({ type: "timeline.item", sessionId: state.id, item });
      }
    } catch {
      // History replay is best-effort; the session still opens.
    }
  }

  async function closeAgent(state: SessionState): Promise<void> {
    try {
      const agent = state.agent as (CursorAgent & { [Symbol.asyncDispose]?: () => Promise<void> }) | null;
      await agent?.[Symbol.asyncDispose]?.();
    } catch {
      state.agent?.close();
    }
    state.agent = null;
  }

  /**
   * Stored-turn accessors for history replay. Agent.messages.list returns
   * proto-JSON turns ({ agentConversationTurn: { userMessage, steps } });
   * run.conversation() returns flat SDK-shape steps. Both are accepted
   * defensively — unknown shapes yield no rows rather than throwing.
   */
  function turnOf(message: unknown): { user: unknown; steps: unknown[] } | null {
    if (message === null || typeof message !== "object" || Array.isArray(message)) return null;
    const record = message as Record<string, unknown>;
    const nested =
      (record["agentConversationTurn"] as Record<string, unknown> | undefined) ??
      (record["turn"] as Record<string, unknown> | undefined);
    const turn =
      nested !== null && typeof nested === "object" && !Array.isArray(nested)
        ? ((nested["value"] as Record<string, unknown> | undefined) ?? nested)
        : undefined;
    if (!turn || typeof turn !== "object" || Array.isArray(turn)) return null;
    const steps = Array.isArray(turn["steps"]) ? (turn["steps"] as unknown[]) : [];
    return { user: turn["userMessage"], steps };
  }

  function userTextOf(user: unknown): string | null {
    if (user === null || typeof user !== "object" || Array.isArray(user)) return null;
    const text = Reflect.get(user, "text");
    return typeof text === "string" && text.length > 0 ? text : null;
  }

  /** Image attachments on a stored user message surface as text path hints. */
  function imageHintsOf(user: unknown): string[] {
    if (user === null || typeof user !== "object" || Array.isArray(user)) return [];
    const context = Reflect.get(user, "selectedContext");
    if (context === null || typeof context !== "object" || Array.isArray(context)) return [];
    const images = Reflect.get(context, "selectedImages");
    if (!Array.isArray(images)) return [];
    const hints: string[] = [];
    for (const image of images) {
      if (typeof image === "string" && image.length > 0) {
        hints.push(`[image: ${image}]`);
        continue;
      }
      if (image !== null && typeof image === "object" && !Array.isArray(image)) {
        const record = image as Record<string, unknown>;
        const path =
          (typeof record["path"] === "string" && record["path"]) ||
          (typeof record["filePath"] === "string" && record["filePath"]) ||
          (typeof record["url"] === "string" && record["url"]) ||
          null;
        hints.push(path ? `[image: ${path}]` : "[image]");
      }
    }
    return hints;
  }

  /**
   * Revert truncates the daemon-visible timeline to the referenced user
   * message by reopening the native agent around the surviving prefix.
   * The SDK has no rewind API; conversation history is append-only in the
   * JSONL store. So: resolve the token to a message count, replay the
   * surviving prefix as a fresh native agent via follow-up sends is wrong
   * (it would re-execute), therefore the honest implementation is to close
   * the live runtime and resume a fresh agent, then replay only the prefix
   * history rows. Only "conversation" scope is supported; "files"/"both"
   * throw because the provider cannot restore file state.
   */
  async function revertSession(
    state: SessionState,
    input: Extract<ProviderInput, { type: "session.revert" }>,
  ): Promise<void> {
    if (input.scope !== "conversation") {
      throw new Error(`Cursor provider supports conversation revert only, not "${input.scope}"`);
    }
    const token = revertTokenOf(input.token);
    if (!token) throw new Error("Cursor revert token is missing or malformed");
    const keep = state.userMessageIds.indexOf(token.messageId);
    if (keep === -1) throw new Error("Cursor revert target message is not in this session");
    // Drop the target message and everything after it from the daemon view.
    state.userMessageIds = state.userMessageIds.slice(0, keep);
    // The SDK cannot delete turns; close the live runtime so subsequent
    // prompts start from a resumed agent whose replayed history ends at the
    // surviving prefix. Provider-owned children of dropped turns are closed.
    for (const [childId, child] of [...children.entries()]) {
      if (child.parentSessionId === state.id) {
        children.delete(childId);
        emit({ type: "session.closed", sessionId: childId });
      }
    }
    await state.activeRun?.cancel().catch(() => undefined);
    state.turnAbort?.abort();
    state.activeRun = null;
    state.activeTurnId = null;
    state.turnAbort = null;
    await closeAgent(state);
    // Re-create the native agent so the next prompt resumes cleanly; the
    // daemon replays prefix history from its own timeline store.
    const { Agent } = loadCursorSdk();
    const apiKey = await readKey(state.config);
    const store = openStore(state.config);
    // Re-create honors the same tool restriction as openSession (tools are
    // not persisted by the SDK; the reverted runtime must re-apply them).
    const tools = sessionTools(state);
    state.agent = (await Agent.create({
      ...(apiKey ? { apiKey } : {}),
      model: resolveModelSelection(state),
      ...(tools ? { tools } : {}),
      local: {
        cwd: state.config.cwd,
        store,
        autoReview: state.settings[CURSOR_SETTING_AUTO_REVIEW] === true,
      },
      ...(state.config.systemPrompt ? { systemPrompt: state.config.systemPrompt } : {}),
      mcpServers: toMcpServers(state.config),
    })) as CursorAgent;
    if (state.config.persist) {
      emit({
        type: "session.persistence",
        sessionId: state.id,
        persistence: { version: 1, data: { agentId: state.agent.agentId } },
      });
    }
  }

  function revertTokenOf(token: unknown): { messageId: string } | null {
    if (token !== null && typeof token === "object" && !Array.isArray(token)) {
      const messageId = Reflect.get(token, "messageId");
      if (typeof messageId === "string" && messageId.length > 0) return { messageId };
    }
    return null;
  }

  /**
   * Archive closes the live runtime for every session persisted under the
   * given native agent id and drops provider-owned children. The durable
   * JSONL record stays resumable via Agent.resume on unarchive/restore.
   */
  async function archiveSession(persistence: ProviderPersistence): Promise<void> {
    const parsed = persistenceSchema.safeParse(persistence);
    if (!parsed.success) throw new Error("Cursor archive persistence is malformed");
    const agentId = parsed.data.data.agentId;
    for (const [childId, child] of [...children.entries()]) {
      const parent = sessions.get(child.parentSessionId);
      if (parent?.agent?.agentId === agentId) {
        children.delete(childId);
        emit({ type: "session.closed", sessionId: childId });
      }
    }
    for (const [sessionId, state] of [...sessions.entries()]) {
      if (state.agent?.agentId !== agentId) continue;
      state.closed = true;
      state.turnAbort?.abort();
      await state.activeRun?.cancel().catch(() => undefined);
      await closeAgent(state).catch(() => undefined);
      sessions.delete(sessionId);
      emit({ type: "session.closed", sessionId });
    }
  }

  async function unarchiveSession(persistence: ProviderPersistence): Promise<void> {
    const parsed = persistenceSchema.safeParse(persistence);
    if (!parsed.success) throw new Error("Cursor unarchive persistence is malformed");
    // No-op by design: local JSONL records are never deleted, so the next
    // session.open with this persistence resumes via Agent.resume.
  }

  return {
    version: 1,
    capabilities: [...CAPABILITIES],
    async send(input) {
      if (closed) throw new Error("Cursor connection is closed");
      pending = pending
        .then(async () => {
          if (!closed) await dispatch(input);
          return undefined;
        })
        .catch((error) => failed(input, error));
      await pending;
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async close() {
      if (closed) return;
      // Abort retry waits so the pending drain below is not stalled, and
      // close provider-owned children while listeners still receive events
      // (emit() is suppressed once `closed` is set).
      for (const state of sessions.values()) state.turnAbort?.abort();
      for (const childId of [...children.keys()]) {
        children.delete(childId);
        emit({ type: "session.closed", sessionId: childId });
      }
      closed = true;
      await pending.catch(() => undefined);
      await Promise.all(
        [...sessions.values()].map(async (state) => {
          state.closed = true;
          await state.activeRun?.cancel().catch(() => undefined);
          await closeAgent(state).catch(() => undefined);
        }),
      );
      sessions.clear();
      children.clear();
      listeners.clear();
    },
  };
}

/**
 * Slash commands published via session.commands. The SDK has no command
 * listing, so these mirror cursor-agent's built-in skills plus compact and
 * review helpers. Command prompts are executed as normal turns.
 */
const BUILTIN_COMMANDS: ReadonlyArray<ProviderCommand> = [
  { name: "plan", description: "Explore and propose a plan without making edits", argumentHint: "[goal]" },
  { name: "compact", description: "Summarize this conversation so far", argumentHint: "" },
  { name: "review", description: "Review the current uncommitted changes", argumentHint: "" },
  { name: "commit", description: "Commit staged changes with a generated message", argumentHint: "[hint]" },
];

function commandPromptText(input: { name: string; arguments: string }): string | null {
  const args = input.arguments.trim();
  switch (input.name) {
    case "plan":
      return args
        ? `Explore the codebase and propose a concrete implementation plan for the following goal. Do not make any edits, only research and plan:\n\n${args}`
        : "Explore the current state of the codebase and propose what to work on next. Do not make any edits, only research and plan.";
    case "compact":
      return "Summarize this conversation so far: what was asked, what was done, what changed on disk, and what is still pending. Keep it concise.";
    case "review":
      return "Review the current uncommitted changes (git status and git diff). Report what changed, likely risks, and anything that looks wrong. Do not commit.";
    case "commit":
      return args
        ? `Commit the staged changes with a clear message incorporating this hint: ${args}. Show the resulting commit hash.`
        : "Commit the staged changes with a clear generated message and show the resulting commit hash.";
    default:
      return null;
  }
}

/**
 * Archive/unarchive operate on the provider's own session records, not the
 * daemon's agent record (which the daemon already handles). Local SDK
 * sessions live in the JSONL store; the SDK exposes archive/unarchive as
 * cloud-only statics, so for local agents archive closes the live runtime
 * (sessions map entry + SDK handle) and persists the native agent id for
 * later restore. Unarchive is a no-op validation: the durable record is
 * still resumable via Agent.resume.
 */
function toCatalog(models: ProviderModel[]): ProviderCatalog {
  const fallback = models.length > 0 ? models : fallbackCatalog().models;
  return {
    models: fallback,
    modes: [
      { id: "agent", label: "Agent", description: "Implements changes directly" },
      { id: "plan", label: "Plan", description: "Explores and plans first, read-only" },
    ],
    defaultModel: DEFAULT_CURSOR_MODEL,
    defaultMode: DEFAULT_CURSOR_MODE,
  };
}

function fallbackCatalog(): ProviderCatalog {
  return {
    models: [{ id: DEFAULT_CURSOR_MODEL, label: "Composer 2.5" }],
    modes: [
      { id: "agent", label: "Agent", description: "Implements changes directly" },
      { id: "plan", label: "Plan", description: "Explores and plans first, read-only" },
    ],
    defaultModel: DEFAULT_CURSOR_MODEL,
    defaultMode: DEFAULT_CURSOR_MODE,
  };
}

function toAgentMode(mode: string | undefined): "agent" | "plan" {
  return mode === "plan" ? "plan" : "agent";
}

function toMcpServers(
  config: ProviderSessionConfig,
):
  | Record<string, { command: string; args?: string[]; env?: Record<string, string> } | { url: string; headers?: Record<string, string> }>
  | undefined {
  const entries = Object.entries(config.mcpServers ?? {});
  if (entries.length === 0) return undefined;
  const servers: Record<
    string,
    { command: string; args?: string[]; env?: Record<string, string> } | { url: string; headers?: Record<string, string> }
  > = {};
  for (const [name, server] of entries) {
    if (server.type === "stdio") {
      servers[name] = {
        command: server.command,
        ...(server.args ? { args: [...server.args] } : {}),
        ...(server.env ? { env: { ...server.env } } : {}),
      };
    } else {
      servers[name] = {
        url: server.url,
        ...(server.headers ? { headers: { ...server.headers } } : {}),
      };
    }
  }
  return servers;
}

function readMessageText(message: unknown): string | null {
  if (typeof message === "string") return message;
  if (message !== null && typeof message === "object") {
    const text = Reflect.get(message, "text");
    if (typeof text === "string") return text;
  }
  return null;
}
