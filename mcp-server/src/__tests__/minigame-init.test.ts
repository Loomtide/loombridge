/**
 * S7b — `loombridge minigame init` contract scaffold.
 *
 * The scaffold must ALWAYS validate (a partner never starts from a broken contract),
 * carry the requested id, and the CLI must write it safely (no silent clobber).
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildScaffoldContract } from "../loombridge/minigame-scaffold.js";
import { validateMinigameContract } from "../loombridge/minigame-profiles/validator.js";
import { run as minigameRun } from "../loombridge/minigame.js";

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "minigame-init-"));
}

test("buildScaffoldContract produces a VALID contract carrying the id", () => {
  const contract = buildScaffoldContract("count-the-fruits");
  const result = validateMinigameContract(contract);
  assert.equal(result.valid, true, `scaffold must validate; issues: ${JSON.stringify(result.issues)}`);
  assert.equal(contract.id, "count-the-fruits");
  assert.equal(contract.title, "Count The Fruits");
  assert.ok(contract.scenes[0].includes("count-the-fruits"));
  // Enables real object-scoped + flow checks, and every state binds objects.
  assert.ok(contract.checks.deterministic.includes("required-in-frame"));
  assert.ok(contract.checks.deterministic.includes("interaction-flow"));
  // safe-area-sweep is on by default so every HUD element is checked against the safe area.
  assert.ok(contract.checks.deterministic.includes("safe-area-sweep"));
  assert.equal(contract.interactionFlow.happyPath.at(-1), "home_back");
});

test("the scaffold validates across several ids (incl. digits and multi-hyphen)", () => {
  for (const id of ["a", "shape-match", "level-2-boss", "abc123-xyz"]) {
    const result = validateMinigameContract(buildScaffoldContract(id));
    assert.equal(result.valid, true, `id '${id}' must scaffold valid; issues: ${JSON.stringify(result.issues)}`);
  }
});

test("minigame init --output writes a parseable, valid contract file", async () => {
  const dir = await tmpDir();
  const out = path.join(dir, "nested", "my-game.minigame.json");
  const code = await minigameRun(["init", "--id", "my-game", "--output", out]);
  assert.equal(code, 0);
  const written = JSON.parse(await fs.readFile(out, "utf-8"));
  assert.equal(written.id, "my-game");
  assert.equal(validateMinigameContract(written).valid, true);
  await fs.rm(dir, { recursive: true, force: true });
});

test("minigame init refuses to clobber an existing file unless --force", async () => {
  const dir = await tmpDir();
  const out = path.join(dir, "g.minigame.json");
  await fs.writeFile(out, "DO NOT OVERWRITE", "utf-8");

  // Without --force: refuse (exit 1) and leave the file untouched.
  assert.equal(await minigameRun(["init", "--id", "g", "--output", out]), 1);
  assert.equal(await fs.readFile(out, "utf-8"), "DO NOT OVERWRITE");

  // With --force: overwrite with the scaffold.
  assert.equal(await minigameRun(["init", "--id", "g", "--output", out, "--force"]), 0);
  assert.equal(JSON.parse(await fs.readFile(out, "utf-8")).id, "g");
  await fs.rm(dir, { recursive: true, force: true });
});

test("minigame init: a MISSING id is a usage error (exit 2), but a non-kebab id is NORMALIZED, not rejected", async () => {
  assert.equal(await minigameRun(["init"]), 2); // missing --id → usage error
  // A non-canonical id is canonicalized (zero friction) and the written contract carries the clean id.
  const dir = await tmpDir();
  const out1 = path.join(dir, "a.json");
  assert.equal(await minigameRun(["init", "--id", "Bad_Id", "--output", out1]), 0);
  assert.equal(JSON.parse(await fs.readFile(out1, "utf-8")).id, "bad-id");
  const out2 = path.join(dir, "b.json");
  assert.equal(await minigameRun(["init", "--id", "1leading", "--output", out2]), 0);
  assert.equal(JSON.parse(await fs.readFile(out2, "utf-8")).id, "game-1leading");
  await fs.rm(dir, { recursive: true, force: true });
});
