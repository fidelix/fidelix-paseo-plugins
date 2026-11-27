import type { PluginServerContext } from "@getpaseo/plugin/server";
import { closeDiagnostics, installDiagnostics } from "./server/diagnostics.js";
import { installProviderProcessGuard } from "./server/process-guard.js";
import { createCursorProvider } from "./server/provider.js";
import { createProviderWorker } from "./server/provider-worker-client.js";
import { createValidateKeyHandler } from "./server/validate.js";
import { createLoginManager } from "./server/login.js";
import { closeLocalStores } from "./server/local-store.js";
import { cursorSettings } from "./shared/settings.js";
import { cursorLoginStatusRpc, startCursorLoginRpc, validateCursorKeyRpc } from "./shared/validate.js";

export default function contribute(server: PluginServerContext) {
  installProviderProcessGuard();
  const settings = server.registerSettings(cursorSettings);
  const provider = createCursorProvider({ settings });
  // macOS Desktop's signed Electron helper rejects Cursor's native modules.
  // A standalone Node process loads them under its own runtime policy.
  const worker =
    process.platform === "darwin" && process.versions.electron
      ? createProviderWorker(settings)
      : null;
  if (!worker) installDiagnostics();
  server.handle(validateCursorKeyRpc, createValidateKeyHandler(settings));
  const login = createLoginManager(settings);
  server.handle(startCursorLoginRpc, () => login.start());
  server.handle(cursorLoginStatusRpc, () => login.status());
  server.registerProvider(worker ? { ...provider, connect: worker.connect } : provider);
  return async () => {
    await login.shutdown();
    await worker?.close();
    await closeLocalStores();
    await closeDiagnostics();
  };
}
