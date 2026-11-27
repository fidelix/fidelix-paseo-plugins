// Run: node --test server/cursor-remote-commands.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createRemoteCommandSource,
  fetchRemoteCommands,
  insideGitRepo,
  resolveRemoteCredentials,
  toRemoteSlashEntries,
  // @ts-expect-error: `.ts` specifier required so node --test type-stripping resolves it
} from "./cursor-remote-commands.ts";
// @ts-expect-error: `.ts` specifier required so node --test type-stripping resolves it
import { mergeRemoteSlashEntries, renderSlashPrompt } from "./cursor-commands.ts";
import type { CursorSlashEntry } from "./cursor-commands.js";

const credentials = { apiKey: "key_test", backendUrl: "https://backend.test/" };

function fakeFetch(routes: Record<string, (body: unknown) => { status?: number; json: unknown }>) {
  const calls: Array<{ url: string; auth: string | null; body: unknown }> = [];
  const impl = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    calls.push({ url, auth: new Headers(init.headers).get("authorization"), body });
    const route = routes[new URL(url).pathname];
    if (!route) return new Response("not found", { status: 404 });
    const result = route(body);
    return new Response(JSON.stringify(result.json), { status: result.status ?? 200 });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const backend = {
  "/auth/exchange_user_api_key": () => ({ json: { accessToken: "tok" } }),
  "/aiserver.v1.DashboardService/GetTeamCommands": () => ({
    json: { commands: [{ name: "Ship It", content: "Ship $ARGUMENTS", description: "Team ship", isActive: true }] },
  }),
  "/aiserver.v1.DashboardService/GetGlobalCommands": () => ({
    json: { commands: [{ name: "code-review", content: "Review the code.", description: "Review", availability: "GLOBAL_COMMAND_AVAILABILITY_ALL_AGENTS" }] },
  }),
};

describe("fetchRemoteCommands", () => {
  it("exchanges the key, then asks for team and classic-surface commands", async () => {
    const { impl, calls } = fakeFetch(backend);
    const result = await fetchRemoteCommands(credentials, impl);
    assert.equal(result.team.length, 1);
    assert.equal(result.global.length, 1);
    assert.equal(calls[0]?.url, "https://backend.test/auth/exchange_user_api_key");
    assert.equal(calls[0]?.auth, "Bearer key_test");
    const team = calls.find((call) => call.url.endsWith("/GetTeamCommands"));
    const global = calls.find((call) => call.url.endsWith("/GetGlobalCommands"));
    assert.equal(team?.auth, "Bearer tok");
    assert.deepEqual(team?.body, { activeOnly: true });
    assert.deepEqual(global?.body, { surface: "GLOBAL_COMMAND_SURFACE_CLASSIC" });
  });

  it("keeps one list when the other call fails, and fails when both do", async () => {
    const { impl } = fakeFetch({
      ...backend,
      "/aiserver.v1.DashboardService/GetTeamCommands": () => ({ status: 403, json: {} }),
    });
    const result = await fetchRemoteCommands(credentials, impl);
    assert.equal(result.team.length, 0);
    assert.equal(result.global.length, 1);

    const { impl: broken } = fakeFetch({ "/auth/exchange_user_api_key": () => ({ status: 401, json: {} }) });
    await assert.rejects(fetchRemoteCommands(credentials, broken), /HTTP 401/);
  });
});

describe("toRemoteSlashEntries", () => {
  it("applies cursor-agent's filters and precedence", () => {
    const entries = toRemoteSlashEntries(
      {
        team: [
          { name: "Ship It", content: "Ship $ARGUMENTS", description: "Team ship", isActive: true },
          { name: "old", content: "Old", isActive: false },
          { name: "explain", content: "Team explain" },
        ],
        global: [
          { name: "explain", content: "Global explain", availability: "GLOBAL_COMMAND_AVAILABILITY_ALL_AGENTS" },
          { name: "debug", content: "Debug", availability: "GLOBAL_COMMAND_AVAILABILITY_CLOUD_ONLY" },
          { name: "glass-only", content: "x", disabledSurfaces: ["GLOBAL_COMMAND_SURFACE_CLASSIC"] },
          { name: "worktree", content: "Worktree", argumentHint: "[branch=<name>]", requiresAllWorkspaceFoldersAreGitRepos: true },
          { name: "empty", content: "  " },
        ],
      },
      { insideGitRepo: false },
    );
    const byName = new Map((entries as CursorSlashEntry[]).map((entry) => [entry.name, entry]));
    assert.deepEqual([...byName.keys()].sort(), ["explain", "ship-it"]);
    assert.equal(byName.get("explain")?.body, "Team explain");
    assert.equal(byName.get("ship-it")?.description, "Team command: Team ship");
    assert.equal(renderSlashPrompt(byName.get("ship-it")!, "now"), "Ship now");

    const inRepo = toRemoteSlashEntries(
      { team: [], global: [{ name: "worktree", content: "Worktree", argumentHint: "[branch=<name>]", requiresAllWorkspaceFoldersAreGitRepos: true }] },
      { insideGitRepo: true },
    );
    assert.equal(inRepo[0]?.argumentHint, "[branch=<name>]");
    assert.equal(inRepo[0]?.description, "Cursor command: Worktree");
  });

  it("lets local entries keep their names but replaces fallback helpers", () => {
    const merged = mergeRemoteSlashEntries(
      [
        { name: "explain", description: "mine", argumentHint: "", kind: "skill", body: "x" },
        { name: "review", description: "helper", argumentHint: "", kind: "builtin" },
      ],
      [
        { name: "explain", description: "remote", argumentHint: "", kind: "command", body: "y" },
        { name: "review", description: "remote review", argumentHint: "", kind: "command", body: "z" },
        { name: "simplify", description: "remote simplify", argumentHint: "", kind: "command", body: "s" },
      ],
    );
    const byName = new Map((merged as CursorSlashEntry[]).map((entry) => [entry.name, entry]));
    assert.equal(byName.get("explain")?.description, "mine");
    assert.equal(byName.get("review")?.description, "remote review");
    assert.equal(byName.get("simplify")?.kind, "command");
  });
});

describe("resolveRemoteCredentials", () => {
  it("prefers an explicit key, then a live stored login", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "cursor-remote-"));
    assert.equal(await resolveRemoteCredentials(undefined, { home }), null);
    assert.equal((await resolveRemoteCredentials("explicit", { home }))?.apiKey, "explicit");

    await mkdir(path.join(home, ".cursor", "sdk"), { recursive: true });
    const file = path.join(home, ".cursor", "sdk", "auth.json");
    await writeFile(file, JSON.stringify({ version: 1, backendUrl: "https://stored.test", apiKey: "stored", createdAtMs: 1 }));
    assert.deepEqual(await resolveRemoteCredentials(undefined, { home }), { apiKey: "stored", backendUrl: "https://stored.test" });

    await writeFile(file, JSON.stringify({ version: 1, backendUrl: "https://stored.test", apiKey: "stored", createdAtMs: 1, apiKeyExpiresAtMs: 5 }));
    assert.equal(await resolveRemoteCredentials(undefined, { home, now: 10 }), null);
  });
});

describe("createRemoteCommandSource", () => {
  it("shares in-flight fetches, caches results, and cools down after a failure", async () => {
    let clock = 0;
    const { impl, calls } = fakeFetch(backend);
    const source = createRemoteCommandSource({ fetch: impl, ttlMs: 100, cooldownMs: 50, now: () => clock });
    assert.equal(source.peek(credentials), null);
    await Promise.all([source.get(credentials), source.get(credentials)]);
    assert.equal(calls.filter((call) => call.url.endsWith("/exchange_user_api_key")).length, 1);
    assert.equal(source.peek(credentials)?.global.length, 1);
    clock = 150;
    assert.equal(source.peek(credentials), null);

    let attempts = 0;
    const failing = createRemoteCommandSource({
      fetch: (async () => {
        attempts += 1;
        return new Response("", { status: 500 });
      }) as unknown as typeof fetch,
      cooldownMs: 50,
      now: () => clock,
    });
    await assert.rejects(failing.get(credentials));
    await assert.rejects(failing.get(credentials));
    assert.equal(attempts, 1);
    clock = 300;
    await assert.rejects(failing.get(credentials));
    assert.equal(attempts, 2);
  });
});

describe("insideGitRepo", () => {
  it("finds .git in the folder or a parent", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cursor-git-"));
    await mkdir(path.join(root, "repo", ".git"), { recursive: true });
    await mkdir(path.join(root, "repo", "src", "deep"), { recursive: true });
    assert.equal(await insideGitRepo(path.join(root, "repo", "src", "deep")), true);
    assert.equal(await insideGitRepo(root), false);
  });
});
