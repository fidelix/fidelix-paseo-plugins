// Run: node --test server/cursor-commands.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
// @ts-expect-error: `.ts` specifier required so node --test type-stripping resolves it
import { discoverCursorSlashCatalog, expandCommandBody, renderSlashPrompt } from "./cursor-commands.ts";

async function write(file: string, body: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, body);
}

describe("discoverCursorSlashCatalog", () => {
  it("publishes skills and commands, with later sources winning", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cursor-commands-"));
    const home = path.join(root, "home");
    const cwd = path.join(root, "proj");

    await write(
      path.join(cwd, ".cursor", "skills", "beta", "SKILL.md"),
      "---\nname: beta\ndescription: project beta\n---\n# Beta\n",
    );
    await write(
      path.join(home, ".cursor", "skills", "beta", "SKILL.md"),
      "---\nname: beta\ndescription: >-\n  user beta\n  continued\nuser-invocable: true\nargument-hint: \"[goal]\"\n---\n# Beta\n",
    );
    await write(
      path.join(home, ".cursor", "skills", "hidden", "SKILL.md"),
      "---\nname: hidden\ndescription: no\nuser-invocable: false\n---\n# Hidden\n",
    );
    await write(
      path.join(home, ".cursor", "skills", ".trash", "secret", "SKILL.md"),
      "---\ndescription: secret\n---\n# Secret\n",
    );
    await write(
      path.join(home, ".codex", "skills", "skill-creator", "SKILL.md"),
      "---\ndescription: denied\n---\n# Denied\n",
    );
    await write(
      path.join(home, ".codex", "skills", "brainstorming", "SKILL.md"),
      "---\ndescription: think\n---\n# Think\n",
    );
    await write(
      path.join(home, ".claude", "skills", "paseo", "SKILL.md"),
      "---\nname: paseo\ndescription: Paseo reference\n---\n# Paseo\n",
    );
    await write(
      path.join(cwd, ".cursor", "commands", "ship.md"),
      "---\ndescription: Ship it\nargument-hint: \"[note]\"\n---\nShip $ARGUMENTS\n",
    );
    await write(path.join(home, ".cursor", "commands", "alpha.md"), "# Alpha command\n\nDo the command.\n");

    const oldSkill = path.join(home, ".cursor", "plugins", "cache", "pub", "plug", "old", "skills", "old-skill", "SKILL.md");
    const newSkill = path.join(home, ".cursor", "plugins", "cache", "pub", "plug", "new", "skills", "new-skill", "SKILL.md");
    await write(oldSkill, "---\ndescription: old\n---\n# Old\n");
    await write(newSkill, "---\ndescription: new\n---\n# New\n");
    const oldTime = new Date("2020-01-01T00:00:00Z");
    const newTime = new Date("2024-01-01T00:00:00Z");
    await utimes(path.join(home, ".cursor", "plugins", "cache", "pub", "plug", "old"), oldTime, oldTime);
    await utimes(path.join(home, ".cursor", "plugins", "cache", "pub", "plug", "new"), newTime, newTime);

    const entries = await discoverCursorSlashCatalog(cwd, { home });
    const byName = new Map(entries.map((entry) => [entry.name, entry]));

    assert.equal(byName.get("alpha")?.kind, "command");
    assert.equal(byName.get("alpha")?.description, "Alpha command");
    assert.equal(byName.get("beta")?.kind, "skill");
    assert.equal(byName.get("beta")?.description, "user beta continued");
    assert.equal(byName.get("beta")?.argumentHint, "[goal]");
    assert.equal(byName.get("paseo")?.kind, "skill");
    assert.equal(byName.get("paseo")?.description, "Paseo reference");
    assert.equal(byName.has("hidden"), false);
    assert.equal(byName.has("secret"), false);
    assert.equal(byName.has("skill-creator"), false);
    assert.equal(byName.get("brainstorming")?.description, "think");
    assert.equal(byName.get("ship")?.kind, "command");
    assert.equal(byName.get("ship")?.argumentHint, "[note]");
    assert.equal(byName.get("ship")?.description, "Ship it");
    assert.match(renderSlashPrompt(byName.get("ship")!, "now"), /Ship now/);
    assert.equal(byName.has("old-skill"), false);
    assert.equal(byName.get("new-skill")?.description, "new");
    assert.equal(byName.get("plan")?.kind, "builtin");
    assert.equal(byName.has("review"), true);
    assert.match(renderSlashPrompt(byName.get("plan")!, "widgets"), /widgets/);
    assert.equal(expandCommandBody("run $1 then $ARGUMENTS", "a b"), "run a then a b");
  });
});
