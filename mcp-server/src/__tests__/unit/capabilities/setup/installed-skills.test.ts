import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { readInstalledSkills } from "../../../../capabilities/setup/installed-skills.js";
import { renderSliceSkill } from "../../../../capabilities/verification/slices.js";

function tmpProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "loombridge-skills-"));
}

function plantSkill(root: string, agentDir: string, name: string, withDoc = true): void {
  const dir = path.join(root, agentDir, "skills", name);
  fs.mkdirSync(dir, { recursive: true });
  if (withDoc) fs.writeFileSync(path.join(dir, "SKILL.md"), "---\nname: x\n---\n", "utf-8");
}

// --- the inventory reader --------------------------------------------------------------------

test("reads skills from .claude/skills, sorted", () => {
  const root = tmpProject();
  plantSkill(root, ".claude", "ui-polish-pack");
  plantSkill(root, ".claude", "generated-3d-art-integration");
  assert.deepEqual(readInstalledSkills(root), ["generated-3d-art-integration", "ui-polish-pack"]);
});

test("unions .codex/skills, because a Codex-only project still has skills its agent can open", () => {
  const root = tmpProject();
  plantSkill(root, ".claude", "asset-layer");
  plantSkill(root, ".codex", "sfx-integration-pack");
  plantSkill(root, ".codex", "asset-layer"); // same skill in both roots must not double up
  assert.deepEqual(readInstalledSkills(root), ["asset-layer", "sfx-integration-pack"]);
});

test("a project with no install-agent reads as empty, and does NOT throw", () => {
  // The supported configuration whose correct rendering is the generic-ops wording.
  assert.deepEqual(readInstalledSkills(tmpProject()), []);
  assert.deepEqual(readInstalledSkills(path.join(os.tmpdir(), "loombridge-does-not-exist-xyz")), []);
});

test("a directory without SKILL.md is not a skill", () => {
  // Keeps stray dirs out of a list the agent is TOLD it can open.
  const root = tmpProject();
  plantSkill(root, ".claude", "real-skill");
  plantSkill(root, ".claude", "empty-dir", false);
  assert.deepEqual(readInstalledSkills(root), ["real-skill"]);
});

test("LITMUS: the inventory is read from DISK, not hardcoded", () => {
  // A hardcoded list would pass every other test in this file. Plant, read, remove, read again.
  const root = tmpProject();
  assert.deepEqual(readInstalledSkills(root), []);
  plantSkill(root, ".claude", "invented-skill-name");
  assert.deepEqual(readInstalledSkills(root), ["invented-skill-name"]);
  fs.rmSync(path.join(root, ".claude", "skills", "invented-skill-name"), { recursive: true });
  assert.deepEqual(readInstalledSkills(root), []);
});

// --- the rendering decision -------------------------------------------------------------------

test("REGRESSION: never claims absence while the project holds skills", () => {
  // The defect: with 13 skills installed, plan printed "(none ships for this slice)" for all 18
  // slices of both 3D packs. An agent told nothing exists does not go looking.
  const rendered = renderSliceSkill(undefined, ["generated-3d-art-integration", "ui-polish-pack"]);
  assert.doesNotMatch(rendered, /none ships/, "the false-absence sentence must be gone");
});

test("LITMUS: it does NOT enumerate the skills, and asks nobody to choose", () => {
  // Routing is already automatic: Claude and Codex surface `.claude/skills` / `.codex/skills`
  // with their descriptions, which are written as trigger conditions. Printing the inventory here
  // would be redundant with what the agent already has, and would reframe an automatic match as a
  // choice. This line's only job is to stop suppressing that match.
  const installed = ["asset-layer", "generated-3d-art-integration", "ui-polish-pack"];
  const rendered = renderSliceSkill(undefined, installed);
  for (const name of installed) {
    assert.doesNotMatch(rendered, new RegExp(name), `must not enumerate "${name}"`);
  }
  assert.doesNotMatch(rendered, /match one|choose|pick|select|installed here/i);
  assert.equal(rendered, "none pinned for this slice");
});

test("the degrade path is intact: no skills installed still gets the generic-ops wording", () => {
  // Here the sentence is TRUE, so it stays.
  const rendered = renderSliceSkill(undefined, []);
  assert.match(rendered, /none ships for this slice/);
  assert.match(rendered, /unity_\*/);
});

test("an explicit pack binding still wins, unchanged, inventory or not", () => {
  assert.equal(renderSliceSkill("parallax-2d", []), "parallax-2d");
  assert.equal(renderSliceSkill("parallax-2d", ["ui-polish-pack", "asset-layer"]), "parallax-2d");
});
