// Types for the runtime loader (cursor-sdk-loader.js). Kept separate so the
// daemon's plugin compiler never sees an @cursor/sdk type import in TS
// sources. Values flowing through loadCursorSdk() are typed structurally via
// cursor-sdk-types.ts, not via the SDK's own .d.ts.
export interface CursorSdkModule {
  Agent: {
    create(options: Record<string, unknown>): Promise<unknown>;
    resume(agentId: string, options?: Record<string, unknown>): Promise<unknown>;
    messages: {
      list(
        agentId: string,
        options?: Record<string, unknown>,
      ): Promise<Array<{ type: string; message: unknown }>>;
    };
  };
  Cursor: {
    models: {
      list(options?: Record<string, unknown>): Promise<unknown>;
    };
    auth: {
      login(options?: Record<string, unknown>): Promise<{
        apiKey?: string;
        email?: string;
        apiKeyExpiresAtMs?: number;
      }>;
      status(options?: Record<string, unknown>): Promise<
        | { status: "logged-out" }
        | { status: "logged-in"; backendUrl?: string; email?: string; apiKeyExpiresAtMs?: number }
      >;
      logout(options?: Record<string, unknown>): Promise<void>;
    };
  };
}

export interface CursorSdkSqliteModule {
  SqliteLocalAgentStore: {
    open(options: { workspaceRef: string; stateRoot?: string }): Promise<CursorLocalAgentStore>;
  };
}

/**
 * Structural subset of the SDK's `LocalAgentStore` (store/local-agent-store.d.ts)
 * used by local-store.ts for orphaned-run recovery.
 */
export interface CursorLocalAgentStore {
  agents: {
    get(input: { agentId: string }): Promise<CursorLocalAgentDocument | null>;
    update(input: { agent: CursorLocalAgentDocument }): Promise<unknown>;
  };
  runs: {
    get(input: { agentId: string; runId: string }): Promise<CursorLocalAgentRunDocument | null>;
    update(input: { run: CursorLocalAgentRunDocument }): Promise<unknown>;
  };
  dispose?(): Promise<void>;
}

export interface CursorLocalAgentDocument {
  agentId: string;
  cwd: string;
  status: "idle" | "running" | "error" | "archived";
  activeRunId?: string | null;
  updatedAt: number;
  [key: string]: unknown;
}

export interface CursorLocalAgentRunDocument {
  runId: string;
  agentId: string;
  status: "queued" | "running" | "finished" | "error" | "cancelled" | "expired";
  updatedAt: number;
  endedAt?: number | null;
  [key: string]: unknown;
}

declare const loadCursorSdk: () => CursorSdkModule;
declare const loadCursorSdkSqlite: () => CursorSdkSqliteModule;

export { loadCursorSdk, loadCursorSdkSqlite };
