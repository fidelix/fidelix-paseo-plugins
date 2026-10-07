import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createCursorProvider } from "./server/provider.js";
import { createValidateKeyHandler } from "./server/validate.js";
import { createLoginManager } from "./server/login.js";
import { cursorSettings } from "./shared/settings.js";
import { cursorLoginStatusRpc, startCursorLoginRpc, validateCursorKeyRpc } from "./shared/validate.js";

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(cursorSettings);
  server.handle(validateCursorKeyRpc, createValidateKeyHandler(settings));
  const login = createLoginManager(settings);
  server.handle(startCursorLoginRpc, () => login.start());
  server.handle(cursorLoginStatusRpc, () => login.status());
  server.registerProvider(createCursorProvider({ settings }));
  return async () => {
    await login.shutdown();
  };
}
