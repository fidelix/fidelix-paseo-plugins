import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { CursorSlashEntry } from "./cursor-commands.js";

/**
 * Team commands (Cursor dashboard) and Cursor's own global commands
 * (`/code-review`, `/simplify`, ...). `@cursor/sdk` never fetches either;
 * cursor-agent and the editor call `aiserver.v1.DashboardService` directly.
 * This is an undocumented endpoint, so every failure degrades to "no remote
 * commands" and the local catalog stands alone.
 */

const DEFAULT_BACKEND_URL = "https://api2.cursor.sh";
/** Whole fetch: key exchange plus both command lists. */
const REQUEST_TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 10 * 60_000;
const FAILURE_COOLDOWN_MS = 60_000;
const DESCRIPTION_LIMIT = 400;

/** Paseo is a chat UI on a local agent, closest to the editor's classic surface. */
const SURFACE = "GLOBAL_COMMAND_SURFACE_CLASSIC";

export interface RemoteCommandCredentials {
  apiKey: string;
  backendUrl: string;
}

interface TeamCommand {
  name?: string;
  content?: string;
  description?: string;
  isActive?: boolean;
}

interface GlobalCommand {
  name?: string;
  content?: string;
  description?: string;
  argumentHint?: string;
  availability?: string;
  disabledSurfaces?: string[];
  requiresAllWorkspaceFoldersAreGitRepos?: boolean;
}

export interface RemoteCommands {
  team: TeamCommand[];
  global: GlobalCommand[];
}

type Fetch = typeof fetch;

/**
 * Key for the dashboard calls, in the SDK's own order: an explicit key, then
 * the `Cursor.auth.login()` key in `~/.cursor/sdk/auth.json`.
 */
export async function resolveRemoteCredentials(
  explicitKey: string | undefined,
  options: { home?: string; now?: number } = {},
): Promise<RemoteCommandCredentials | null> {
  const envBackend = process.env["CURSOR_BACKEND_URL"];
  if (explicitKey) return { apiKey: explicitKey, backendUrl: envBackend || DEFAULT_BACKEND_URL };
  const file = path.join(options.home ?? homedir(), ".cursor", "sdk", "auth.json");
  try {
    const stored = JSON.parse(await readFile(file, "utf8")) as {
      apiKey?: unknown;
      backendUrl?: unknown;
      apiKeyExpiresAtMs?: unknown;
    };
    if (typeof stored.apiKey !== "string" || stored.apiKey.length === 0) return null;
    if (typeof stored.apiKeyExpiresAtMs === "number" && stored.apiKeyExpiresAtMs <= (options.now ?? Date.now())) {
      return null;
    }
    const backendUrl =
      envBackend || (typeof stored.backendUrl === "string" && stored.backendUrl) || DEFAULT_BACKEND_URL;
    return { apiKey: stored.apiKey, backendUrl };
  } catch {
    return null;
  }
}

export async function fetchRemoteCommands(
  credentials: RemoteCommandCredentials,
  fetchImpl: Fetch = fetch,
): Promise<RemoteCommands> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  timer.unref();
  try {
    return await requestRemoteCommands(credentials, fetchImpl, controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

async function requestRemoteCommands(
  credentials: RemoteCommandCredentials,
  fetchImpl: Fetch,
  signal: AbortSignal,
): Promise<RemoteCommands> {
  const base = credentials.backendUrl.replace(/\/+$/, "");
  const exchange = await fetchImpl(`${base}/auth/exchange_user_api_key`, {
    method: "POST",
    headers: { Authorization: `Bearer ${credentials.apiKey}`, "Content-Type": "application/json" },
    body: "{}",
    signal,
  });
  if (!exchange.ok) throw new Error(`API key exchange failed (HTTP ${exchange.status})`);
  const { accessToken } = (await exchange.json()) as { accessToken?: unknown };
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw new Error("API key exchange returned no access token");
  }

  const call = async <T>(method: string, body: unknown, field: string): Promise<T[]> => {
    const response = await fetchImpl(`${base}/aiserver.v1.DashboardService/${method}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "Connect-Protocol-Version": "1",
      },
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) throw new Error(`${method} failed (HTTP ${response.status})`);
    const list = ((await response.json()) as Record<string, unknown>)[field];
    return Array.isArray(list) ? (list as T[]) : [];
  };

  const [team, global] = await Promise.allSettled([
    call<TeamCommand>("GetTeamCommands", { activeOnly: true }, "commands"),
    call<GlobalCommand>("GetGlobalCommands", { surface: SURFACE }, "commands"),
  ]);
  if (team.status === "rejected" && global.status === "rejected") throw team.reason;
  return {
    team: team.status === "fulfilled" ? team.value : [],
    global: global.status === "fulfilled" ? global.value : [],
  };
}

/**
 * Same filtering and precedence as cursor-agent's loader: team commands claim
 * a name first, then global commands. Cloud-only globals are dropped because
 * this is a local agent, and git-only globals need a repository at `cwd`.
 */
export function toRemoteSlashEntries(
  commands: RemoteCommands,
  options: { insideGitRepo: boolean },
): CursorSlashEntry[] {
  const byName = new Map<string, CursorSlashEntry>();
  for (const command of commands.team) {
    if (command.isActive === false) continue;
    const entry = toEntry(command.name, command.description, "", command.content, "Team command");
    if (entry && !byName.has(entry.name)) byName.set(entry.name, entry);
  }
  for (const command of commands.global) {
    if (command.availability === "GLOBAL_COMMAND_AVAILABILITY_CLOUD_ONLY") continue;
    if (command.disabledSurfaces?.includes(SURFACE)) continue;
    if (command.requiresAllWorkspaceFoldersAreGitRepos && !options.insideGitRepo) continue;
    const entry = toEntry(command.name, command.description, command.argumentHint ?? "", command.content, "Cursor command");
    if (entry && !byName.has(entry.name)) byName.set(entry.name, entry);
  }
  return [...byName.values()];
}

function toEntry(
  rawName: string | undefined,
  description: string | undefined,
  argumentHint: string,
  content: string | undefined,
  label: string,
): CursorSlashEntry | null {
  const name = slugify(rawName ?? "");
  const body = (content ?? "").trim();
  if (!name || !body) return null;
  const summary = (description?.trim() || body).replace(/\s+/g, " ");
  const clipped = summary.length <= DESCRIPTION_LIMIT ? summary : `${summary.slice(0, DESCRIPTION_LIMIT - 1)}…`;
  return {
    name,
    description: `${label}: ${clipped}`,
    argumentHint: argumentHint.trim(),
    kind: "command",
    body,
  };
}

/** cursor-agent's slug rule for remote command names. */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^\w-]+/g, "")
    .replace(/--+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
}

export async function insideGitRepo(cwd: string): Promise<boolean> {
  let dir = path.resolve(cwd);
  for (;;) {
    try {
      await stat(path.join(dir, ".git"));
      return true;
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) return false;
      dir = parent;
    }
  }
}

/**
 * One fetch per credential at a time, cached for 10 minutes. A daemon restart
 * reopens every agent at once; they share the same in-flight request.
 */
export function createRemoteCommandSource(
  options: { fetch?: Fetch; ttlMs?: number; cooldownMs?: number; now?: () => number } = {},
): {
  get(credentials: RemoteCommandCredentials): Promise<RemoteCommands>;
  peek(credentials: RemoteCommandCredentials): RemoteCommands | null;
} {
  const ttlMs = options.ttlMs ?? CACHE_TTL_MS;
  const cooldownMs = options.cooldownMs ?? FAILURE_COOLDOWN_MS;
  const now = options.now ?? Date.now;
  const cache = new Map<string, { value: RemoteCommands; at: number }>();
  const failures = new Map<string, { error: unknown; at: number }>();
  const pending = new Map<string, Promise<RemoteCommands>>();
  const keyOf = (credentials: RemoteCommandCredentials) => `${credentials.backendUrl}\n${credentials.apiKey}`;

  function peek(credentials: RemoteCommandCredentials): RemoteCommands | null {
    const hit = cache.get(keyOf(credentials));
    return hit && now() - hit.at < ttlMs ? hit.value : null;
  }

  function get(credentials: RemoteCommandCredentials): Promise<RemoteCommands> {
    const key = keyOf(credentials);
    const hit = peek(credentials);
    if (hit) return Promise.resolve(hit);
    const failed = failures.get(key);
    if (failed && now() - failed.at < cooldownMs) return Promise.reject(failed.error);
    let inFlight = pending.get(key);
    if (!inFlight) {
      inFlight = fetchRemoteCommands(credentials, options.fetch)
        .then((value) => {
          cache.set(key, { value, at: now() });
          failures.delete(key);
          return value;
        })
        .catch((error: unknown) => {
          failures.set(key, { error, at: now() });
          throw error;
        })
        .finally(() => pending.delete(key));
      pending.set(key, inFlight);
    }
    return inFlight;
  }

  return { get, peek };
}
