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
const { readFileSync, existsSync, readdirSync } = require("node:fs");

let cached = null;

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
  // Prefer the canonical package when several installs exist.
  for (const dir of matches) {
    try {
      const manifest = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
      if (manifest && manifest.name === "cursor-provider-plugin") {
        return path.join(dir, "package.json");
      }
    } catch {
      // ignore
    }
  }
  return path.join(matches[0], "package.json");
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

function loadCursorSdk() {
  if (!cached) {
    const { createRequire } = require("node:module");
    cached = createRequire(findAnchor())("@cursor/sdk");
  }
  return cached;
}

module.exports = { loadCursorSdk };
