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
// Node where it lives — it probes upward from the daemon process cwd
// instead, accepting the first directory whose dependency tree contains
// @cursor/sdk. Last resort is the baked-in default from the last successful
// local install.
const path = require("node:path");
const { readFileSync, existsSync } = require("node:fs");

let cached = null;

function dirHasCursorSdk(dir) {
  try {
    const manifest = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
    if (!manifest || typeof manifest.name !== "string") return false;
    return (
      existsSync(path.join(dir, "node_modules", "@cursor", "sdk", "package.json")) ||
      (manifest.dependencies && manifest.dependencies["@cursor/sdk"]) ||
      (manifest.devDependencies && manifest.devDependencies["@cursor/sdk"])
    );
  } catch {
    return false;
  }
}

function findAnchor() {
  const roots = [];
  if (process.env["CURSOR_PROVIDER_PLUGIN_DIR"]) roots.push(process.env["CURSOR_PROVIDER_PLUGIN_DIR"]);
  try {
    roots.push(process.cwd());
  } catch {
    // ignore
  }
  for (const root of roots) {
    let dir = root;
    for (;;) {
      if (dirHasCursorSdk(dir)) return path.join(dir, "package.json");
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  const fallback = "/home/fidelix/dev/cursor-provider-plugin/package.json";
  if (dirHasCursorSdk(path.dirname(fallback))) return fallback;
  throw new Error(
    "cursor-sdk loader: could not locate plugin package.json; set CURSOR_PROVIDER_PLUGIN_DIR",
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
