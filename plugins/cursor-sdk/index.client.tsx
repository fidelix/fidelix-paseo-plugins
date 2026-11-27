import type { PluginClientContext } from "@getpaseo/plugin/client";
import { CursorSettingsScreen } from "./client/cursor-settings";

export default function contribute(client: PluginClientContext) {
  client.addSettingsScreen({
    id: "cursor-sdk",
    title: "Cursor",
    icon: "KeyRound",
    Component: CursorSettingsScreen,
  });
  return () => {};
}
