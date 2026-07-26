/**
 * `loombridge minigame setup` — guided onboarding wrapper.
 *
 * It must: lay out the external workspace, scaffold a VALID contract pointed at the
 * supplied scene/visual-profile, refuse to clobber a contract without
 * --force, refuse (exit 2) when required values are missing in a non-TTY (never
 * hang on a prompt), and print the exact follow-up commands a partner runs next.
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { run as minigameRun } from "../capabilities/minigame/minigame.js";
import {
  WORKSPACE_SUBDIRS,
  buildNextStepsChecklist,
  defaultWorkspace,
  isInside,
  resolveSetupConfig,
  runSetup,
  sanitizeToId,
} from "../capabilities/minigame/minigame-setup.js";
import { validateMinigameContract } from "../capabilities/minigame/profiles/validator.js";

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "minigame-setup-"));
}

const ALL_FLAGS = (id: string, project: string) => [
  "--id", id,
  "--project", project,
  "--scene", `Assets/Scenes/${id}.unity`,
  "--visual-profile", "tablet-landscape",
];

/** Capture console.log so we can assert on the printed checklist. */
async function captureStdout(fn: () => Promise<number>): Promise<{ code: number; out: string }> {
  const original = console.log;
  let out = "";
  console.log = (...args: unknown[]) => {
    out += args.map(String).join(" ") + "\n";
  };
  try {
    const code = await fn();
    return { code, out };
  } finally {
    console.log = original;
  }
}

test("setup with all flags lays out the workspace and writes a VALID contract", async () => {
  const root = await tmpDir();
  const ws = path.join(root, "ws");
  const code = await runSetup(
    [...ALL_FLAGS("count-the-fruits", "/some/unity/project"), "--workspace", ws],
    root,
  );
  assert.equal(code, 0);

  // All five subdirectories exist.
  for (const sub of WORKSPACE_SUBDIRS) {
    const stat = await fs.stat(path.join(ws, sub));
    assert.ok(stat.isDirectory(), `${sub}/ must exist`);
  }

  // The contract is valid and reflects the supplied scene/visual-profile.
  const contract = JSON.parse(await fs.readFile(path.join(ws, "count-the-fruits.minigame.json"), "utf-8"));
  assert.equal(validateMinigameContract(contract).valid, true, JSON.stringify(contract));
  assert.equal(contract.id, "count-the-fruits");
  assert.equal(contract.ageBand, "5-7");
  assert.equal(contract.visualProfile, "tablet-landscape");
  assert.equal(contract.scenes[0], "Assets/Scenes/count-the-fruits.unity");
  assert.ok(contract.tapTargets.minSizeDp >= 64);
  // Default (no --gated-outcome, non-TTY): the win/return states are NOT gated.
  const byId = Object.fromEntries(contract.states.map((s: { id: string; outcomeGated?: boolean }) => [s.id, s.outcomeGated]));
  assert.equal(byId.success_reward, undefined);
  assert.equal(byId.home_back, undefined);

  await fs.rm(root, { recursive: true, force: true });
});

test("setup --gated-outcome marks the win + return states outcome-gated in the scaffold", async () => {
  const root = await tmpDir();
  const ws = path.join(root, "ws");
  const { code, out } = await captureStdout(() =>
    runSetup([...ALL_FLAGS("g", "/p"), "--workspace", ws, "--gated-outcome"], root),
  );
  assert.equal(code, 0);
  const contract = JSON.parse(await fs.readFile(path.join(ws, "g.minigame.json"), "utf-8"));
  assert.equal(validateMinigameContract(contract).valid, true);
  const byId = Object.fromEntries(contract.states.map((s: { id: string; outcomeGated?: boolean }) => [s.id, s.outcomeGated]));
  assert.equal(byId.success_reward, true);
  assert.equal(byId.home_back, true);
  // start/active stay verifiable (never gated).
  assert.equal(byId.start, undefined);
  assert.equal(byId.active, undefined);
  // The checklist tells the partner it's gated + the win is optional to record.
  assert.match(out, /Outcome-gated/);
  assert.match(out, /optional/i);

  await fs.rm(root, { recursive: true, force: true });
});

test("setup --no-gated-outcome (or default in non-TTY) leaves the contract ungated", async () => {
  const root = await tmpDir();
  const ws = path.join(root, "ws");
  const code = await runSetup([...ALL_FLAGS("g", "/p"), "--workspace", ws, "--no-gated-outcome"], root);
  assert.equal(code, 0);
  const contract = JSON.parse(await fs.readFile(path.join(ws, "g.minigame.json"), "utf-8"));
  assert.ok(!JSON.stringify(contract).includes("outcomeGated"), "no state is gated");
  await fs.rm(root, { recursive: true, force: true });
});

test("setup does not expose age-band as a first-time setup flag", async () => {
  const root = await tmpDir();
  const ws = path.join(root, "ws");
  const code = await runSetup(
    ["--id", "toddler-game", "--project", "/p", "--scene", "Assets/Scenes/t.unity",
     "--age-band", "2-4", "--visual-profile", "phone-portrait", "--workspace", ws],
    root,
  );
  assert.equal(code, 2);
  await fs.rm(root, { recursive: true, force: true });
});

test("setup refuses to overwrite an existing contract without --force, exit 2", async () => {
  const root = await tmpDir();
  const ws = path.join(root, "ws");
  for (const sub of WORKSPACE_SUBDIRS) await fs.mkdir(path.join(ws, sub), { recursive: true });
  const contractPath = path.join(ws, "g.minigame.json");
  await fs.writeFile(contractPath, "DO NOT OVERWRITE", "utf-8");

  const code = await runSetup([...ALL_FLAGS("g", "/p"), "--workspace", ws], root);
  assert.equal(code, 2);
  assert.equal(await fs.readFile(contractPath, "utf-8"), "DO NOT OVERWRITE");

  await fs.rm(root, { recursive: true, force: true });
});

test("setup --force overwrites the existing contract", async () => {
  const root = await tmpDir();
  const ws = path.join(root, "ws");
  for (const sub of WORKSPACE_SUBDIRS) await fs.mkdir(path.join(ws, sub), { recursive: true });
  const contractPath = path.join(ws, "g.minigame.json");
  await fs.writeFile(contractPath, "DO NOT OVERWRITE", "utf-8");

  const code = await runSetup([...ALL_FLAGS("g", "/p"), "--workspace", ws, "--force"], root);
  assert.equal(code, 0);
  const contract = JSON.parse(await fs.readFile(contractPath, "utf-8"));
  assert.equal(contract.id, "g");
  assert.equal(validateMinigameContract(contract).valid, true);

  await fs.rm(root, { recursive: true, force: true });
});

test("setup with a missing required value in a non-TTY exits 2 (never hangs)", async () => {
  const root = await tmpDir();
  // Omit --scene; stdin in the test runner is not a TTY, so it must refuse, not prompt.
  const code = await runSetup(
    ["--id", "g", "--project", "/p", "--visual-profile", "phone-portrait",
     "--workspace", path.join(root, "ws")],
    root,
  );
  assert.equal(code, 2);
  await fs.rm(root, { recursive: true, force: true });
});

test("setup rejects age-band flag with exit 2", async () => {
  const root = await tmpDir();
  const code = await runSetup(
    ["--id", "g", "--project", "/p", "--scene", "Assets/Scenes/g.unity",
     "--age-band", "3-5", "--visual-profile", "phone-portrait", "--workspace", path.join(root, "ws")],
    root,
  );
  assert.equal(code, 2);
  await fs.rm(root, { recursive: true, force: true });
});

test("setup prints just the FIRST command (record) + the guided-next pointer, not a stale 5-step list", async () => {
  const root = await tmpDir();
  const ws = path.join(root, "ws"); // a tmp dir (not under $HOME) → shown absolute
  const { code, out } = await captureStdout(() =>
    runSetup([...ALL_FLAGS("count-the-fruits", "/some/unity/project"), "--workspace", ws], root),
  );
  assert.equal(code, 0);

  // The single first step: record (flat workspace layout).
  assert.ok(
    out.includes(
      `loombridge trace record --observe --flat --id count-the-fruits-happy-path --scene Assets/Scenes/count-the-fruits.unity --root ${ws}`,
    ),
    `record line missing:\n${out}`,
  );
  // ...and a pointer to the guided resolver for every later step.
  assert.ok(out.includes("loombridge minigame next --id count-the-fruits"), `next pointer missing:\n${out}`);
  // NOT a static dump of the downstream steps (those are resolved one at a time now).
  assert.equal(out.includes("loombridge minigame capture"), false, `must not dump the capture step up front:\n${out}`);
  assert.equal(out.includes("loombridge minigame finalize"), false, out);
  assert.equal(out.includes("baseline approve"), false, out);

  await fs.rm(root, { recursive: true, force: true });
});

test("minigame setup routes through the minigame verb", async () => {
  const root = await tmpDir();
  const ws = path.join(root, "ws");
  // `run` uses process.cwd() for root; pass an absolute --workspace so it lands here.
  const code = await minigameRun(["setup", ...ALL_FLAGS("routed-game", "/p"), "--workspace", ws]);
  assert.equal(code, 0);
  assert.equal(
    JSON.parse(await fs.readFile(path.join(ws, "routed-game.minigame.json"), "utf-8")).id,
    "routed-game",
  );
  await fs.rm(root, { recursive: true, force: true });
});

test("the interactive path prompts only for missing values (injected asker)", async () => {
  const root = await tmpDir();
  const asked: string[] = [];
  // Supply id/project/scene as flags; visual-profile + gated-outcome remain → 2 prompts.
  const answers = ["phone-portrait", "y"];
  const ask = async (prompt: string): Promise<string> => {
    asked.push(prompt);
    return answers.shift() ?? "";
  };
  const result = await resolveSetupConfig(
    { id: "g", project: "/p", scene: "Assets/Scenes/g.unity", force: false },
    { root, interactive: true, ask },
  );
  assert.ok("config" in result, JSON.stringify(result));
  assert.equal(asked.length, 2, `expected 2 prompts, got: ${JSON.stringify(asked)}`);
  assert.equal(result.config.visualProfile, "phone-portrait");
  assert.equal(result.config.gatedOutcome, true, "answered 'y' to the gated-outcome question");
  assert.match(asked[1], /gated by gameplay OUTCOME/i);
  await fs.rm(root, { recursive: true, force: true });
});

test("sanitizeToId / defaultWorkspace helpers", () => {
  assert.equal(sanitizeToId("Count The Fruits"), "count-the-fruits");
  assert.equal(sanitizeToId("my_game42"), "my-game42");
  assert.equal(sanitizeToId("123"), undefined); // cannot start with a digit
  assert.equal(sanitizeToId("!!!"), undefined);
  // Default workspace lives under the user's HOME, never cwd — so running from the
  // Unity project can't drop artifacts into the game repo.
  assert.equal(
    defaultWorkspace("g"),
    path.join(os.homedir(), ".loombridge", "projects", "g"),
  );
});

test("setup refuses a workspace inside the Unity project (exit 2, keeps repo clean)", async () => {
  const root = await tmpDir();
  const project = path.join(root, "UnityProject");
  await fs.mkdir(project, { recursive: true });
  // --workspace pointed INSIDE the project must be refused before anything is written.
  const code = await runSetup(
    ["--id", "g", "--project", project, "--scene", "Assets/Scenes/g.unity",
     "--visual-profile", "phone-portrait",
     "--workspace", path.join(project, ".loombridge", "g")],
    root,
  );
  assert.equal(code, 2);
  // Nothing scaffolded under the project.
  await assert.rejects(fs.stat(path.join(project, ".loombridge", "g", "g.minigame.json")));
  await fs.rm(root, { recursive: true, force: true });
});

test("isInside detects project containment (incl. exact match)", () => {
  assert.equal(isInside("/proj/.loombridge/g", "/proj"), true);
  assert.equal(isInside("/proj", "/proj"), true);
  assert.equal(isInside("/elsewhere/ws", "/proj"), false);
  assert.equal(isInside("/proj-sibling", "/proj"), false); // prefix, not contained
});

test("buildNextStepsChecklist prints only the first command (record) + the guided-next pointer", () => {
  const lines = buildNextStepsChecklist(
    {
      id: "g",
      project: "/p",
      scene: "Assets/Scenes/g.unity",
      workspace: "/root/ws",
      visualProfile: "phone-portrait",
      gatedOutcome: false,
    },
    "/root",
  );
  const joined = lines.join("\n");
  assert.match(joined, /loombridge trace record .*--root \/root\/ws/);
  assert.match(joined, /loombridge minigame next --id g/);
  // Single first step — the downstream commands are resolved one at a time, not dumped here.
  assert.equal(joined.includes("loombridge minigame capture"), false, joined);
});
