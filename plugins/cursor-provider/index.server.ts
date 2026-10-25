import type { PluginServerContext } from "@getpaseo/plugin/server";
import { closeDiagnostics, installDiagnostics } from "./server/diagnostics.js";
import { installProviderProcessGuard } from "./server/process-guard.js";
import { createCursorProvider } from "./server/provider.js";
import { createValidateKeyHandler } from "./server/validate.js";
import { createLoginManager } from "./server/login.js";
import { closeLocalStores } from "./server/local-store.js";
import { cursorSettings } from "./shared/settings.js";
import { cursorLoginStatusRpc, startCursorLoginRpc, validateCursorKeyRpc } from "./shared/validate.js";

export default function contribute(server: PluginServerContext) {
  // Before any SDK call. An uncaught throw in the one-line executor bundle
  // otherwise dumps that file to stderr and exits, which drops every session.
  installProviderProcessGuard();
  // Hooks `http2.connect`, `node:sqlite` and the OTel global before the SDK
  // loads, so its first session is already covered.
  installDiagnostics();
  const settings = server.registerSettings(cursorSettings);
  server.handle(validateCursorKeyRpc, createValidateKeyHandler(settings));
  const login = createLoginManager(settings);
  server.handle(startCursorLoginRpc, () => login.start());
  server.handle(cursorLoginStatusRpc, () => login.status());
  server.registerProvider(createCursorProvider({ settings }));
  return async () => {
    await login.shutdown();
    await closeLocalStores();
    await closeDiagnostics();
  };
}
