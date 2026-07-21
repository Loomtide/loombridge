import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test, { after, before, describe } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// dist/__tests__ -> repo root is three levels up.
const REPO_ROOT = resolve(__dirname, "../../..");
const CHECKPOINT = resolve(REPO_ROOT, "scripts/loomtide-checkpoint.sh");
const RESTORE = resolve(REPO_ROOT, "scripts/loomtide-restore.sh");

async function read(p: string): Promise<string> {
  return fsp.readFile(p, "utf-8");
}
async function exists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

describe("loomtide-checkpoint / restore (stage-fixture harness)", { timeout: 30000 }, () => {
  let tmp = "";

  before(async () => {
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "loomtide-stage-"));
  });
  after(async () => {
    if (tmp) await fsp.rm(tmp, { recursive: true, force: true });
  });

  async function makeProject(name: string): Promise<string> {
    const project = path.join(tmp, name);
    await fsp.mkdir(path.join(project, ".loomtide", "verify", "spawn"), { recursive: true });
    await fsp.mkdir(path.join(project, "Assets", "Scenes"), { recursive: true });
    await fsp.writeFile(path.join(project, ".loomtide", "ACCEPTANCE.json"), JSON.stringify({ v: 1 }), "utf-8");
    await fsp.writeFile(path.join(project, ".loomtide", "verify", "spawn", "marker.json"), "{}", "utf-8");
    await fsp.writeFile(path.join(project, "Assets", "Scenes", "Game.unity"), "SCENE-v1", "utf-8");
    await fsp.writeFile(path.join(project, "Assets", "Scenes", "Game.unity.meta"), "META-v1", "utf-8");
    return project;
  }

  test("checkpoint -> mutate -> restore round-trips .loomtide/ and the named scene (+ .meta)", async () => {
    const project = await makeProject("consumer");

    const cp = spawnSync(
      "bash",
      [CHECKPOINT, "--project", project, "--stage", "construct", "--scene", "Assets/Scenes/Game.unity"],
      { encoding: "utf-8" },
    );
    assert.equal(cp.status, 0, `checkpoint failed: ${cp.stderr}`);
    assert.ok(await exists(path.join(project, ".loomtide-fixtures", "construct", "loomtide", "ACCEPTANCE.json")));

    // Mutate both the state and the scene.
    await fsp.writeFile(path.join(project, ".loomtide", "ACCEPTANCE.json"), JSON.stringify({ v: 999 }), "utf-8");
    await fsp.writeFile(path.join(project, "Assets", "Scenes", "Game.unity"), "SCENE-MUTATED", "utf-8");

    const rs = spawnSync("bash", [RESTORE, "--project", project, "--stage", "construct"], { encoding: "utf-8" });
    assert.equal(rs.status, 0, `restore failed: ${rs.stderr}`);

    assert.equal(await read(path.join(project, ".loomtide", "ACCEPTANCE.json")), JSON.stringify({ v: 1 }));
    assert.equal(await read(path.join(project, "Assets", "Scenes", "Game.unity")), "SCENE-v1");
    assert.equal(await read(path.join(project, "Assets", "Scenes", "Game.unity.meta")), "META-v1");
    // The captured per-state capture survived the round-trip too.
    assert.ok(await exists(path.join(project, ".loomtide", "verify", "spawn", "marker.json")));
  });

  test("checkpoint rejects an unknown stage and a project without .loomtide/", async () => {
    const project = await makeProject("bad");
    const badStage = spawnSync("bash", [CHECKPOINT, "--project", project, "--stage", "nope"], { encoding: "utf-8" });
    assert.notEqual(badStage.status, 0);
    assert.match(badStage.stderr, /invalid --stage/);

    const noState = path.join(tmp, "no-loomtide");
    await fsp.mkdir(noState, { recursive: true });
    const r = spawnSync("bash", [CHECKPOINT, "--project", noState, "--stage", "construct"], { encoding: "utf-8" });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /no \.loomtide\//);
  });

  test("restore fails clearly when no fixture exists for the stage", async () => {
    const project = await makeProject("nofixture");
    const r = spawnSync("bash", [RESTORE, "--project", project, "--stage", "level"], { encoding: "utf-8" });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /no fixture for stage/);
  });
});
