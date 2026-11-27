import type {
  ProviderConnectRequest,
  ProviderConnection,
  ProviderEvent,
  ProviderInput,
} from "@getpaseo/plugin/server/provider";
import type { CursorPluginSettings } from "./provider.js";

export type SettingsState = Awaited<ReturnType<CursorPluginSettings["read"]>>;
export type ConnectionInfo = Pick<ProviderConnection, "version" | "capabilities">;

export type WorkerRequest =
  | { type: "connect"; connectionId: number; input: ProviderConnectRequest }
  | { type: "send"; connectionId: number; input: ProviderInput }
  | { type: "close"; connectionId: number }
  | { type: "shutdown" };

export type HostMessage =
  | { type: "request"; id: number; request: WorkerRequest }
  | { type: "settings.result"; id: number; state: SettingsState | null }
  | { type: "settings.changed"; state: SettingsState };

export type WorkerMessage =
  | { type: "result"; id: number; value?: ConnectionInfo; error?: string }
  | { type: "event"; connectionId: number; event: ProviderEvent }
  | { type: "settings.read"; id: number };
