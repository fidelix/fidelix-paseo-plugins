import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createCursorProvider } from "./server/provider.js";
import { createValidateKeyHandler } from "./server/validate.js";
import { cursorSettings } from "./shared/settings.js";
import { validateCursorKeyRpc } from "./shared/validate.js";

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(cursorSettings);
  server.handle(validateCursorKeyRpc, createValidateKeyHandler(settings));
  server.registerProvider(createCursorProvider({ settings }));
  return () => {};
}
