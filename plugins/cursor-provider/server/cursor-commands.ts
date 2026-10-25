import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { ProviderCommand } from "@getpaseo/plugin/server/provider";

/**
 * Slash entries published as `session.commands`.
 *
 * `@cursor/sdk` has no command-list API. cursor-agent builds the same menu by
 * reading command markdown and `SKILL.md` files off disk (`loadCommands` with
 * `includeSkills`). Omitting that scan is why Paseo only ever showed the four
 * hardcoded helpers.
 */
export interface CursorSlashEntry {
  name: string;
  description: string;
  argumentHint: string;
  kind: "command" | "skill" | "builtin";
  /** Command or skill body. Builtins render from `name` instead. */
  body?: string;
  path?: string;
}

const DESCRIPTION_LIMIT = 400;
const BODY_LIMIT = 80_000;

/** Codex ships a few skills Cursor's own loader refuses to surface. */
const CODEX_SKILL_DENYLIST = new Set([
  "imagegen",
  "openai-docs",
  "opneai-docs",
  "plugin-creator",
  "skill-creator",
  "skill-installer",
]);

const SKILL_ROOTS: ReadonlyArray<{ configDir: string; subdir: string }> = [
  { configDir: ".cursor", subdir: "skills" },
  { configDir: ".claude", subdir: "skills" },
  { configDir: ".codex", subdir: "skills" },
  { configDir: ".grok", subdir: "skills" },
  { configDir: ".agents", subdir: "skills" },
];

const COMMAND_DIRS: ReadonlyArray<{ configDir: string; subdir: string }> = [
  { configDir: ".claude", subdir: "commands" },
  { configDir: ".cursor", subdir: "commands" },
];

const BUILTIN_ENTRIES: readonly CursorSlashEntry[] = [
  {
    name: "plan",
    description: "Explore and propose a plan without making edits",
    argumentHint: "[goal]",
    kind: "builtin",
  },
  {
    name: "compact",
    description: "Summarize this conversation so far",
    argumentHint: "",
    kind: "builtin",
  },
  {
    name: "review",
    description: "Review the current uncommitted changes",
    argumentHint: "",
    kind: "builtin",
  },
  {
    name: "commit",
    description: "Commit staged changes with a generated message",
    argumentHint: "[hint]",
    kind: "builtin",
  },
];

export function fallbackSlashCatalog(): CursorSlashEntry[] {
  return BUILTIN_ENTRIES.map((entry) => ({ ...entry }));
}

export function toProviderCommands(entries: readonly CursorSlashEntry[]): ProviderCommand[] {
  return entries.map((entry) => ({
    name: entry.name,
    description: entry.description,
    argumentHint: entry.argumentHint,
  }));
}

/**
 * Plugin skills, then builtin / project / user skills, then command files.
 * Later sources overwrite the same slash name, so a command file wins over a
 * skill and a user file wins over a project file. Helpers fill names nothing
 * else claimed.
 */
export async function discoverCursorSlashCatalog(
  cwd: string,
  options: { home?: string } = {},
): Promise<CursorSlashEntry[]> {
  const home = options.home ?? homedir();
  const byName = new Map<string, CursorSlashEntry>();

  const pluginRoots = await pluginSkillDirs(home);
  for (const root of pluginRoots) {
    for (const entry of await readSkills(root, false)) byName.set(entry.name, entry);
  }
  for (const entry of await readSkills(path.join(home, ".cursor", "skills-cursor"), false)) {
    byName.set(entry.name, entry);
  }
  for (const root of skillDirs(cwd)) {
    for (const entry of await readSkills(root, root.includes(`${path.sep}.codex${path.sep}`))) {
      byName.set(entry.name, entry);
    }
  }
  for (const root of skillDirs(home)) {
    for (const entry of await readSkills(root, root.includes(`${path.sep}.codex${path.sep}`))) {
      byName.set(entry.name, entry);
    }
  }

  // Commands are loaded after skills so a project/user command file replaces
  // a skill of the same name. Within commands, user overrides project, and
  // `.cursor/commands` overrides `.claude/commands` (cursor-agent's order).
  for (const root of [...commandDirs(cwd), ...commandDirs(home)]) {
    for (const entry of await readCommands(root)) byName.set(entry.name, entry);
  }

  for (const builtin of BUILTIN_ENTRIES) {
    if (!byName.has(builtin.name)) byName.set(builtin.name, { ...builtin });
  }

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function renderSlashPrompt(entry: CursorSlashEntry, rawArgs: string): string {
  const args = rawArgs.trim();
  if (entry.kind === "builtin") return builtinPrompt(entry.name, args);
  if (entry.kind === "command") return expandCommandBody(entry.body ?? "", args);
  return skillPrompt(entry, args);
}

function builtinPrompt(name: string, args: string): string {
  switch (name) {
    case "plan":
      return args
        ? `Explore the codebase and propose a concrete implementation plan for the following goal. Do not make any edits, only research and plan:\n\n${args}`
        : "Explore the current state of the codebase and propose what to work on next. Do not make any edits, only research and plan.";
    case "compact":
      return "Summarize this conversation so far: what was asked, what was done, what changed on disk, and what is still pending. Keep it concise.";
    case "review":
      return "Review the current uncommitted changes (git status and git diff). Report what changed, likely risks, and anything that looks wrong. Do not commit.";
    case "commit":
      return args
        ? `Commit the staged changes with a clear message incorporating this hint: ${args}. Show the resulting commit hash.`
        : "Commit the staged changes with a clear generated message and show the resulting commit hash.";
    default:
      return args ? `/${name} ${args}` : `/${name}`;
  }
}

/** `$ARGUMENTS` and `$1`…`$99`, matching cursor-agent's command expansion. */
export function expandCommandBody(content: string, args: string): string {
  const parts = args.length > 0 ? args.split(/\s+/) : [];
  let hadPlaceholder = false;
  let text = content;
  if (text.includes("$ARGUMENTS")) {
    hadPlaceholder = true;
    text = text.replaceAll("$ARGUMENTS", args);
  }
  text = text.replace(/(?<!\w)\$(\d{1,2})\b/g, (match, raw: string) => {
    const index = Number(raw);
    if (!Number.isInteger(index) || index <= 0) return match;
    hadPlaceholder = true;
    return index <= parts.length ? (parts[index - 1] ?? "") : "";
  });
  if (!hadPlaceholder && args.length > 0) return `${content}\n\n${args}`;
  return text;
}

function skillPrompt(entry: CursorSlashEntry, args: string): string {
  const body = truncate(entry.body ?? "", BODY_LIMIT);
  const where = entry.path ? `Skill file: ${entry.path}\n\n` : "";
  const tail =
    (entry.body?.length ?? 0) > BODY_LIMIT && entry.path
      ? `\n\n[truncated; read the rest from ${entry.path}]`
      : "";
  const request = args.length > 0 ? args : "Follow this skill.";
  return `The user invoked the /${entry.name} skill. Follow it.\n\n${request}\n\n${where}${body}${tail}`;
}

function skillDirs(root: string): string[] {
  return SKILL_ROOTS.map((entry) => path.join(root, entry.configDir, entry.subdir));
}

function commandDirs(root: string): string[] {
  return COMMAND_DIRS.map((entry) => path.join(root, entry.configDir, entry.subdir));
}

async function pluginSkillDirs(home: string): Promise<string[]> {
  const roots: string[] = [];
  const cache = path.join(home, ".cursor", "plugins", "cache");
  for (const publisher of await directories(cache)) {
    for (const plugin of await directories(publisher)) {
      const version = await newestDirectory(plugin);
      if (version) roots.push(path.join(version, "skills"));
    }
  }
  for (const plugin of await directories(path.join(home, ".cursor", "plugins", "local"))) {
    roots.push(path.join(plugin, "skills"));
  }
  return roots;
}

async function readCommands(dir: string): Promise<CursorSlashEntry[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const commands: CursorSlashEntry[] = [];
  for (const entry of entries) {
    if (entry.isDirectory() || entry.name.startsWith(".") || !entry.name.endsWith(".md")) continue;
    const name = entry.name.slice(0, -".md".length).trim();
    if (!name || name.includes("/") || /\s/.test(name)) continue;
    const file = path.join(dir, entry.name);
    let raw = "";
    try {
      raw = await readFile(file, "utf8");
    } catch {
      continue;
    }
    const body = raw.trim();
    const parsed = parseFrontmatter(raw);
    const first = (parsed.body || body).split("\n")[0] ?? "";
    const heading = /^#+\s*(.+)$/.exec(first)?.[1]?.trim();
    commands.push({
      name,
      description: clip(parsed.data["description"]?.trim() || heading || first.trim() || name),
      argumentHint: parsed.data["argument-hint"]?.trim() || parsed.data["argumentHint"]?.trim() || "",
      kind: "command",
      body,
      path: file,
    });
  }
  return commands;
}

async function readSkills(root: string, codexDenylist: boolean): Promise<CursorSlashEntry[]> {
  let realRoot: string;
  try {
    realRoot = await realpath(root);
  } catch {
    return [];
  }
  const files: string[] = [];
  await walkSkills(root, realRoot, 0, files);
  const folderCounts = new Map<string, number>();
  for (const file of files) {
    const folder = path.basename(path.dirname(file));
    folderCounts.set(folder, (folderCounts.get(folder) ?? 0) + 1);
  }
  const used = new Set<string>();
  const skills: CursorSlashEntry[] = [];
  for (const file of files) {
    const folder = path.basename(path.dirname(file));
    if (codexDenylist && CODEX_SKILL_DENYLIST.has(folder)) continue;
    let raw = "";
    try {
      raw = await readFile(file, "utf8");
    } catch {
      continue;
    }
    const parsed = parseFrontmatter(raw);
    if (isFalse(parsed.data["user-invocable"])) continue;
    const duplicate = (folderCounts.get(folder) ?? 0) > 1;
    const relative = duplicate ? relativeSkillId(realRoot, file) : folder;
    const name = uniqueName(relative || folder, used);
    const description =
      parsed.data["description"]?.trim() ||
      firstBodyLine(parsed.body) ||
      (typeof parsed.data["name"] === "string" ? parsed.data["name"] : "") ||
      name;
    skills.push({
      name,
      description: clip(description),
      argumentHint: parsed.data["argument-hint"]?.trim() || parsed.data["argumentHint"]?.trim() || "",
      kind: "skill",
      body: raw.trim(),
      path: file,
    });
  }
  return skills;
}

async function walkSkills(dir: string, realRoot: string, depth: number, files: string[]): Promise<void> {
  if (depth > 8) return;
  let here: string;
  try {
    here = await realpath(dir);
  } catch {
    return;
  }
  if (here !== realRoot && !here.startsWith(realRoot + path.sep)) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (await isDirectory(entry, full)) {
      await walkSkills(full, realRoot, depth + 1, files);
    } else if (entry.name === "SKILL.md") {
      files.push(full);
    }
  }
}

function relativeSkillId(root: string, file: string): string {
  const relative = path.relative(root, path.dirname(file));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return "";
  return relative.split(path.sep).filter(Boolean).join("-");
}

function uniqueName(base: string, used: Set<string>): string {
  let name = base;
  let n = 2;
  while (used.has(name)) {
    name = `${base}-${n}`;
    n += 1;
  }
  used.add(name);
  return name;
}

function firstBodyLine(body: string): string {
  for (const line of body.split("\n")) {
    const heading = /^#+\s*(.+)$/.exec(line)?.[1]?.trim();
    if (heading) return heading;
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("---")) return trimmed;
  }
  return "";
}

async function isDirectory(entry: { isDirectory(): boolean; isSymbolicLink(): boolean }, full: string): Promise<boolean> {
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;
  try {
    return (await stat(full)).isDirectory();
  } catch {
    return false;
  }
}

function parseFrontmatter(raw: string): { data: Record<string, string>; body: string } {
  const text = raw.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  if (!text.startsWith("---")) return { data: {}, body: text };
  const end = text.indexOf("\n---", 3);
  if (end < 0) return { data: {}, body: text };
  const block = text.slice(4, end);
  const body = text.slice(end + 4).replace(/^\n/, "");
  const data: Record<string, string> = {};
  const lines = block.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[i] ?? "");
    if (!match) continue;
    const key = match[1] ?? "";
    let value = (match[2] ?? "").trim();
    if (value === "" || value === ">" || value === ">-" || value === "|" || value === "|-") {
      const folded = value.startsWith(">");
      const chunks: string[] = [];
      while (i + 1 < lines.length && /^[ \t]/.test(lines[i + 1] ?? "")) {
        i += 1;
        chunks.push((lines[i] ?? "").trim());
      }
      value = folded ? chunks.join(" ") : chunks.join("\n");
    } else {
      value = unquote(value);
    }
    if (key) data[key] = value.trim();
  }
  return { data, body };
}

function unquote(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
    (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function isFalse(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "false" || normalized === "no";
}

function clip(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= DESCRIPTION_LIMIT) return flat;
  return `${flat.slice(0, DESCRIPTION_LIMIT - 1)}…`;
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return text.slice(0, limit);
}

async function directories(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith(".")).map((entry) => path.join(dir, entry.name));
}

async function newestDirectory(dir: string): Promise<string | null> {
  const children = await directories(dir);
  let best: { path: string; mtimeMs: number } | null = null;
  for (const child of children) {
    try {
      const info = await stat(child);
      if (!best || info.mtimeMs > best.mtimeMs) best = { path: child, mtimeMs: info.mtimeMs };
    } catch {
      // skip unreadable version dirs
    }
  }
  return best?.path ?? null;
}
