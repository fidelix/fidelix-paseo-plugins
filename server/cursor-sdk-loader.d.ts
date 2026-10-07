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
  };
  JsonlLocalAgentStore: new (rootDir: string) => unknown;
}

declare const loadCursorSdk: () => CursorSdkModule;

export { loadCursorSdk };
