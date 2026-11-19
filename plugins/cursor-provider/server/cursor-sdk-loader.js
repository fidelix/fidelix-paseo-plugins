// Anchor file: lets the bundled server code load @cursor/sdk (and its
// lazily-loaded chunks) from THIS plugin installation at runtime, without
// esbuild or the plugin type-walker ever traversing the SDK's broken .d.ts
// graph (see getpaseo/paseo#6257).
//
// This file is plain CommonJS (not ESM) on purpose: the daemon wraps the
// compiled server bundle as `(function(require) { ... })` and evaluates it,
// so top-level `import` syntax and `import.meta` do not exist here. Plain
// `require` calls survive the bundler untouched. `__dirname`/`__filename`
// are NOT defined inside the evaluated bundle, so the loader cannot ask
// Node where it lives — it discovers the install instead:
//
//  1. $CURSOR_PROVIDER_PLUGIN_DIR (explicit override, walks up) — needed
//     for directory installs outside the plugin store.
//  2. Walk up from the daemon process cwd (covers dev checkouts).
//  3. Scan $PASEO_HOME/plugins for an installed copy (covers Git installs
//     on any OS — this is the normal case; the store layout is
//     <id>/<version>/checkout[/<pluginPath>]).
//
// There are no baked-in absolute paths: a hardcoded checkout path breaks on
// every machine except the one it was written on.
const path = require("node:path");
const os = require("node:os");
const { readFileSync, existsSync, readdirSync, statSync } = require("node:fs");

let cached = null;
let cachedSqlite = null;
let cachedRequire = null;

function dirHasCursorSdk(dir) {
  // Fast path: the SDK is installed (the manifest `build` step runs
  // `npm ci` in the plugin directory at install/update time).
  try {
    if (existsSync(path.join(dir, "node_modules", "@cursor", "sdk", "package.json"))) return true;
  } catch {
    // ignore and fall through to the manifest check
  }
  try {
    const manifest = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
    if (!manifest || typeof manifest.name !== "string") return false;
    return Boolean(
      (manifest.dependencies && manifest.dependencies["@cursor/sdk"]) ||
        (manifest.devDependencies && manifest.devDependencies["@cursor/sdk"]),
    );
  } catch {
    return false;
  }
}

function walkUpForSdk(startDir) {
  let dir = startDir;
  for (;;) {
    if (dirHasCursorSdk(dir)) return path.join(dir, "package.json");
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// Mirrors the daemon's resolvePaseoHome (PASEO_HOME, else ~/.paseo).
function paseoHomeDir() {
  const raw = process.env["PASEO_HOME"];
  let expanded;
  if (raw === undefined || raw.length === 0) {
    expanded = path.join(os.homedir(), ".paseo");
  } else if (raw === "~") {
    expanded = os.homedir();
  } else if (raw.startsWith("~/")) {
    expanded = path.join(os.homedir(), raw.slice(2));
  } else {
    expanded = raw;
  }
  return path.resolve(expanded);
}

// Bounded scan of the managed plugin store for an installed copy of this
// plugin. Depth covers <id>/<version>/checkout[/<nested pluginPath>].
// Skips node_modules/.git/.staging; capped so a huge store can't hang init.
function findInPluginsStore() {
  let pluginsRoot;
  try {
    pluginsRoot = path.join(paseoHomeDir(), "plugins");
  } catch {
    return null;
  }
  const MAX_DEPTH = 8;
  const MAX_DIRS = 500;
  const matches = [];
  const seen = new Set();
  const stack = [{ dir: pluginsRoot, depth: 0 }];
  let visited = 0;
  while (stack.length > 0 && visited < MAX_DIRS) {
    const { dir, depth } = stack.pop();
    if (seen.has(dir)) continue;
    seen.add(dir);
    visited += 1;
    if (dir !== pluginsRoot && dirHasCursorSdk(dir)) {
      matches.push(dir);
      continue;
    }
    if (depth >= MAX_DEPTH) continue;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name === ".staging") {
        continue;
      }
      stack.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
    }
  }
  if (matches.length === 0) return null;
  // Several copies exist while an update runs: the daemon installs the new
  // revision before it removes the old one, and this process can start in
  // between. Binding to the old copy breaks once it is deleted (the SDK loads
  // chunks lazily), so prefer the canonical package, then copies with the SDK
  // actually installed, then the newest install.
  const ranked = matches
    .map((dir) => ({ dir, ...rankInstall(dir) }))
    .sort(
      (a, b) =>
        Number(b.canonical) - Number(a.canonical) ||
        Number(b.installed) - Number(a.installed) ||
        b.installedAt - a.installedAt,
    );
  return path.join(ranked[0].dir, "package.json");
}

function rankInstall(dir) {
  let canonical = false;
  try {
    const manifest = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
    canonical = Boolean(manifest && manifest.name === "cursor-provider-plugin");
  } catch {
    // ignore
  }
  if (!existsSync(path.join(dir, "node_modules", "@cursor", "sdk", "package.json"))) {
    return { canonical, installed: false, installedAt: 0 };
  }
  // npm stamps extracted package files with a fixed 1985 mtime; its own
  // lockfile copy is written at install time.
  let installedAt = 0;
  for (const marker of [path.join("node_modules", ".package-lock.json"), "node_modules"]) {
    try {
      installedAt = statSync(path.join(dir, marker)).mtimeMs;
      break;
    } catch {
      // try the next marker
    }
  }
  return { canonical, installed: true, installedAt };
}

function findAnchor() {
  const searched = [];
  const override = process.env["CURSOR_PROVIDER_PLUGIN_DIR"];
  if (override && override.trim().length > 0) {
    const hit = walkUpForSdk(override);
    if (hit) return hit;
    searched.push(`CURSOR_PROVIDER_PLUGIN_DIR=${override}`);
  }
  try {
    const cwd = process.cwd();
    const hit = walkUpForSdk(cwd);
    if (hit) return hit;
    searched.push(`cwd ${cwd}`);
  } catch {
    // ignore
  }
  const storeHit = findInPluginsStore();
  if (storeHit) return storeHit;
  try {
    searched.push(`plugins store under ${paseoHomeDir()}`);
  } catch {
    searched.push("plugins store");
  }
  throw new Error(
    "cursor-sdk loader: could not locate the plugin installation " +
      `(checked ${searched.join("; ")}). ` +
      "For directory installs outside the plugin store, set CURSOR_PROVIDER_PLUGIN_DIR to the plugin directory.",
  );
}

function sdkRequire() {
  if (!cachedRequire) {
    const { createRequire } = require("node:module");
    cachedRequire = createRequire(findAnchor());
  }
  return cachedRequire;
}

// Cursor compacts a conversation with a `summarizeAction` (cursor-agent's
// /compress), but the SDK's local runs only ever build a `userMessageAction`.
// Rewrite that one site in the local-executor chunk so a run whose prompt is
// CURSOR_SUMMARIZE_PROMPT sends the summarize action instead. The rewrite is
// exact-match: on any other SDK build it does not apply and compaction reports
// itself unavailable rather than sending the sentinel to the model.
const CURSOR_SUMMARIZE_PROMPT = "\u0000cursor-provider:summarize\u0000";
const EXECUTOR_CHUNK = /[\\/]@cursor[\\/]sdk[\\/]dist[\\/]cjs[\\/]867\.js$/;
const ACTION_SITE = 'S=new vr.QFf({action:{case:"userMessageAction",value:new vr.Vtf({userMessage:new vr.RGk({text:e.text,';
const SUMMARIZE_STATE = Symbol.for("cursor-provider.summarize");

function summarizeState() {
  const holder = globalThis;
  holder[SUMMARIZE_STATE] ??= { hooked: false, patched: false };
  return holder[SUMMARIZE_STATE];
}

function installSummarizePatch() {
  const state = summarizeState();
  if (state.hooked) return;
  state.hooked = true;
  const Module = require("node:module");
  const compile = Module.prototype._compile;
  Module.prototype._compile = function (content, filename) {
    if (typeof content === "string" && EXECUTOR_CHUNK.test(String(filename))) {
      const first = content.indexOf(ACTION_SITE);
      if (first >= 0 && content.indexOf(ACTION_SITE, first + 1) < 0) {
        const rewritten =
          `S=e.text===${JSON.stringify(CURSOR_SUMMARIZE_PROMPT)}?vr.QFf.fromJson({summarizeAction:{}}):` +
          ACTION_SITE.slice(2);
        content = content.slice(0, first) + rewritten + content.slice(first + ACTION_SITE.length);
        state.patched = true;
      }
    }
    return compile.call(this, content, filename);
  };
}

function loadCursorSdk() {
  if (!cached) {
    installSummarizePatch();
    const load = sdkRequire();
    cached = load("@cursor/sdk");
    // Chunks are lazy; compiling this one now (webpack later reuses the
    // require-cache entry) tells us up front whether the rewrite applied.
    try {
      load(path.join(path.dirname(load.resolve("@cursor/sdk")), "867.js"));
    } catch {
      // Missing chunk: a different SDK build, so compaction stays unavailable.
    }
  }
  return cached;
}

function cursorSummarizeSupported() {
  return summarizeState().patched;
}

// Separate entry so the sqlite driver (node:sqlite) only loads when a
// session actually opens a store.
function loadCursorSdkSqlite() {
  if (!cachedSqlite) cachedSqlite = sdkRequire()("@cursor/sdk/sqlite");
  return cachedSqlite;
}

module.exports = { loadCursorSdk, loadCursorSdkSqlite, cursorSummarizeSupported, CURSOR_SUMMARIZE_PROMPT };
