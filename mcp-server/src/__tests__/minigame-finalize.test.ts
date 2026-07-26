/**
 * `loombridge minigame finalize` — fill a placeholder contract from REAL captures.
 *
 * It must: infer real role→object bindings from a capture pack, rewrite the
 * contract's requiredInFrame + per-state bindings to real ids/locators, keep the
 * result valid, and REFUSE (exit 2) — never emit placeholder/invented locators —
 * when captures are absent or a role can't be inferred.
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { run as minigameRun } from "../capabilities/minigame/minigame.js";
import { buildScaffoldContract } from "../capabilities/minigame/minigame-scaffold.js";
import {
  applyBackgroundFlag,
  applyInputResponseFlag,
  buildFinalizeSummary,
  buildLocator,
  deriveSceneName,
  inferFinalizedContract,
  parseArgs,
  resolveCapturedObject,
  runFinalize,
  traceDemonstratedControls,
  type CapturePack,
} from "../capabilities/minigame/minigame-finalize.js";
import type { MinigameContract } from "../capabilities/minigame/profiles/types.js";
import type { Action, ReplayTrace } from "../capabilities/replay/types.js";
import { validateMinigameContract } from "../capabilities/minigame/profiles/validator.js";
import type { BackgroundCandidates, MinigameCaptureObject } from "../capabilities/minigame/types.js";

// Fixtures live under src/ and tsc does not copy them into dist — resolve from the
// compiled test (dist/__tests__) up to the repo root, then into src/ (same pattern
// as verify-minigame.test.ts).
const FIXTURE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
  "mcp-server/src/__tests__/fixtures/minigame-count-the-fruits-fixed",
);

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "minigame-finalize-"));
}

/** Write a draft scaffold contract (states: start/active/success_reward/home_back). */
async function writeDraft(dir: string, id = "count-the-fruits"): Promise<string> {
  const draft = buildScaffoldContract(id, { scene: `Assets/Scenes/${id}.unity` });
  const p = path.join(dir, `${id}.minigame.json`);
  await fs.writeFile(p, JSON.stringify(draft, null, 2), "utf-8");
  return p;
}

/** A minimal capture object that PASSES required-in-frame (active+visible+fully in frame). */
function obj(o: Partial<MinigameCaptureObject> & { id: string; path: string }): MinigameCaptureObject {
  return {
    role: "image",
    active: true,
    isVisible: true,
    isFullyVisible: true,
    raycastTarget: true,
    screenRect: { x: 0, y: 0, width: 100, height: 100 },
    ...o,
  } as MinigameCaptureObject;
}

/** Write a synthetic capture pack: { stateId: objects[] } → <state>.ui-rects.json. */
async function writePack(dir: string, pack: Record<string, MinigameCaptureObject[]>): Promise<void> {
  for (const [state, objects] of Object.entries(pack)) {
    await fs.writeFile(
      path.join(dir, `${state}.ui-rects.json`),
      JSON.stringify({ state, objects }, null, 2),
      "utf-8",
    );
  }
}

async function captureStdout(fn: () => Promise<number>): Promise<{ code: number; out: string }> {
  const original = console.log;
  let out = "";
  console.log = (...args: unknown[]) => {
    out += args.map(String).join(" ") + "\n";
  };
  try {
    return { code: await fn(), out };
  } finally {
    console.log = original;
  }
}

test("finalize rewrites a draft from the REAL CountTheFruits capture pack", async () => {
  const dir = await tmpDir();
  const contractPath = await writeDraft(dir);
  const out = path.join(dir, "finalized.minigame.json");

  const { code, out: stdout } = await captureStdout(() =>
    runFinalize(["--contract", contractPath, "--captures", FIXTURE, "--output", out], dir),
  );
  assert.equal(code, 0, stdout);

  const contract = JSON.parse(await fs.readFile(out, "utf-8"));
  // Valid, and every locator points at a REAL captured object path — none of the
  // scaffold placeholders (`/Canvas/...` paths, `playArea`/`scoreDisplay` ids, `TODO:`).
  assert.equal(validateMinigameContract(contract).valid, true, JSON.stringify(contract));
  const json = JSON.stringify(contract);
  assert.ok(!json.includes("/Canvas/"), `placeholder Canvas path leaked: ${json}`);
  assert.ok(!json.includes("playArea") && !json.includes("scoreDisplay"), "placeholder ids must be gone");
  assert.ok(!json.includes("TODO:"), "TODO placeholders must be gone");

  // Inferred the real roles → real capture ids.
  const ids = new Set(contract.requiredInFrame.map((o: { id: string }) => o.id));
  assert.ok(ids.has("startButton"), "start control");
  assert.ok(ids.has("homeButton"), "home control");
  assert.ok(ids.has("answerButton0"), "active play area");
  // Reward object resolves to one of the real reward-screen objects.
  assert.ok(
    [...ids].some((id) => ["endSummary", "endCard", "scoreText", "replayButton"].includes(id as string)),
    `reward object missing: ${[...ids].join(",")}`,
  );

  // State bindings only reference objects VISIBLE in that state (home not on start).
  const start = contract.states.find((s: { id: string }) => s.id === "start");
  assert.deepEqual(start.requiredInFrame, ["startButton"]);
  const active = contract.states.find((s: { id: string }) => s.id === "active");
  assert.ok(active.requiredInFrame.includes("homeButton") && active.requiredInFrame.includes("answerButton0"));

  // Summary names the bound objects. The guided next-step footer is SUPPRESSED here because
  // the captures aren't in the standard <ws>/captures — a footer resolved against the wrong
  // dir would mislead (e.g. say "capture" right after capture succeeded), so we don't print it.
  assert.ok(stdout.includes("Bound real objects"), stdout);
  assert.equal(/\nNext: /.test(stdout), false, `footer must be suppressed for a non-standard --captures:\n${stdout}`);

  await fs.rm(dir, { recursive: true, force: true });
});

test("finalize writes in place when no --output is given", async () => {
  const dir = await tmpDir();
  const contractPath = await writeDraft(dir);
  const before = await fs.readFile(contractPath, "utf-8");

  const code = await runFinalize(["--contract", contractPath, "--captures", FIXTURE], dir);
  assert.equal(code, 0);
  const after = JSON.parse(await fs.readFile(contractPath, "utf-8"));
  assert.notEqual(before, JSON.stringify(after));
  assert.equal(validateMinigameContract(after).valid, true);
  await fs.rm(dir, { recursive: true, force: true });
});

test("finalize refuses (exit 2) when the capture pack is absent", async () => {
  const dir = await tmpDir();
  const contractPath = await writeDraft(dir);
  const emptyCaptures = path.join(dir, "captures"); // no files
  await fs.mkdir(emptyCaptures, { recursive: true });

  const code = await runFinalize(["--contract", contractPath, "--captures", emptyCaptures], dir);
  assert.equal(code, 2);
  await fs.rm(dir, { recursive: true, force: true });
});

test("finalize refuses (exit 2) when a required state capture is missing", async () => {
  const dir = await tmpDir();
  const contractPath = await writeDraft(dir);
  const captures = path.join(dir, "captures");
  await fs.mkdir(captures, { recursive: true });
  // Provide only some states → partial pack → refuse.
  await writePack(captures, {
    start: [obj({ id: "playBtn", path: "/UI/PlayButton" })],
    active: [obj({ id: "homeBtn", path: "/UI/HomeButton" }), obj({ id: "tile", path: "/UI/AnswerTile" })],
  });

  const code = await runFinalize(["--contract", contractPath, "--captures", captures], dir);
  assert.equal(code, 2);
  await fs.rm(dir, { recursive: true, force: true });
});

test("finalize refuses (exit 2) and names a role it cannot infer", async () => {
  const dir = await tmpDir();
  const contractPath = await writeDraft(dir);
  const captures = path.join(dir, "captures");
  await fs.mkdir(captures, { recursive: true });
  // start/active/home_back resolve, but success_reward has NO reward-like object.
  await writePack(captures, {
    start: [obj({ id: "playBtn", path: "/UI/PlayButton" })],
    active: [obj({ id: "homeBtn", path: "/UI/HomeButton" }), obj({ id: "tile", path: "/UI/AnswerTile" })],
    success_reward: [obj({ id: "homeBtn", path: "/UI/HomeButton" })], // only home; no reward
    home_back: [obj({ id: "playBtn", path: "/UI/PlayButton" })],
  });

  const errs: string[] = [];
  const origErr = console.error;
  console.error = (...a: unknown[]) => { errs.push(a.map(String).join(" ")); };
  let code: number;
  try {
    code = await runFinalize(["--contract", contractPath, "--captures", captures], dir);
  } finally {
    console.error = origErr;
  }
  assert.equal(code, 2);
  // The draft contract was NOT overwritten with an invalid/placeholder result.
  const stillDraft = JSON.parse(await fs.readFile(contractPath, "utf-8"));
  assert.ok(JSON.stringify(stillDraft).includes("TODO:"), "draft must be left intact on refusal");
  // It NUDGES toward gating the unresolvable screen (success_reward) instead of faking it.
  const out = errs.join("\n");
  assert.match(out, /--outcome-gated/);
  assert.match(out, /success_reward/);
  // ...but NEVER suggests gating the deterministic start/active screens.
  assert.doesNotMatch(out, /--outcome-gated[^\n]*\bactive\b/);
  assert.doesNotMatch(out, /--outcome-gated[^\n]*\bstart\b/);
  await fs.rm(dir, { recursive: true, force: true });
});

test("finalize nudge NEVER suggests gating a deterministic screen (unresolved active play area)", async () => {
  // An unresolvable `active play area` role (its object has an obscure, non-keyword name) is a
  // real "capture it / name the control" problem — it must NOT advise gating `active`, which
  // would silently un-verify the core gameplay screen (anti-gaming invariant).
  const dir = await tmpDir();
  const contractPath = await writeDraft(dir, "g");
  const captures = path.join(dir, "captures");
  await fs.mkdir(captures, { recursive: true });
  await writePack(captures, {
    start: [obj({ id: "playBtn", path: "/UI/PlayButton" })], // "play" → start control
    active: [obj({ id: "homeBtn", path: "/UI/HomeButton" }), obj({ id: "widget", path: "/UI/Widget" })], // no play-area match
    success_reward: [obj({ id: "card", path: "/UI/EndCard" })], // "card" → reward
    home_back: [obj({ id: "playBtn", path: "/UI/PlayButton" })],
  });

  const errs: string[] = [];
  const origErr = console.error;
  console.error = (...a: unknown[]) => { errs.push(a.map(String).join(" ")); };
  let code: number;
  try {
    code = await runFinalize(["--contract", contractPath, "--captures", captures], dir);
  } finally {
    console.error = origErr;
  }
  assert.equal(code, 2);
  const out = errs.join("\n");
  assert.match(out, /active play area/, "it names the unresolved role");
  // The active play area is deterministic — gating it is never the right advice.
  assert.doesNotMatch(out, /--outcome-gated[^\n]*\bactive\b/, "must NOT suggest gating active");
  assert.doesNotMatch(out, /--outcome-gated[^\n]*\bstart\b/, "must NOT suggest gating start");
  await fs.rm(dir, { recursive: true, force: true });
});

test("finalize does NOT require a capture for an outcome-gated state (capture skips them)", async () => {
  // The real `setup --gated-outcome` → capture → finalize flow: capture skips gated states,
  // so finalize must not refuse on their missing capture.
  const dir = await tmpDir();
  const draft = buildScaffoldContract("g", { scene: "Assets/Scenes/G.unity" });
  (draft.states.find((s) => s.kind === "success_reward") as { outcomeGated?: boolean }).outcomeGated = true;
  (draft.states.find((s) => s.kind === "home_back") as { outcomeGated?: boolean }).outcomeGated = true;
  const cp = path.join(dir, "g.minigame.json");
  await fs.writeFile(cp, JSON.stringify(draft, null, 2), "utf-8");
  const captures = path.join(dir, "captures");
  await fs.mkdir(captures, { recursive: true });
  // Only the verifiable screens are captured — success_reward + home_back are NOT.
  await writePack(captures, {
    start: [obj({ id: "startButton", path: "/HUD/StartScreen/StartButton" })],
    active: [obj({ id: "homeButton", path: "/HUD/HomeButton" }), obj({ id: "answerButton0", path: "/HUD/AnswerButton0" })],
  });
  const out = path.join(dir, "final.json");
  const code = await runFinalize(["--contract", cp, "--captures", captures, "--output", out], dir);
  assert.equal(code, 0, "must finalize without the gated states' captures");
  await fs.rm(dir, { recursive: true, force: true });
});

test("finalize --input-response (CLI): writes the declaration, enables the check, exits 0", async () => {
  const dir = await tmpDir();
  const cp = await writeDraft(dir, "g");
  const captures = path.join(dir, "captures");
  await fs.mkdir(captures, { recursive: true });
  await writePack(captures, {
    start: [obj({ id: "startButton", path: "/HUD/StartScreen/StartButton" })],
    active: [obj({ id: "homeButton", path: "/HUD/HomeButton" }), obj({ id: "answerButton0", path: "/HUD/AnswerButton0" }), obj({ id: "question", path: "/HUD/Question" })],
    success_reward: [obj({ id: "homeButton", path: "/HUD/HomeButton" }), obj({ id: "card", path: "/HUD/EndSummary/Card", screenRect: { x: 340, y: 120, width: 600, height: 480 } })],
    home_back: [obj({ id: "startButton", path: "/HUD/StartScreen/StartButton" })],
  });
  const out = path.join(dir, "finalized.json");
  const code = await runFinalize(
    ["--contract", cp, "--captures", captures, "--input-response", "active:answerButton0:question", "--output", out],
    dir,
  );
  assert.equal(code, 0);
  const c = JSON.parse(await fs.readFile(out, "utf-8"));
  assert.ok(c.checks.deterministic.includes("input-response"));
  assert.deepEqual(c.states.find((s: { id: string }) => s.id === "active").inputResponse, { tap: "answerButton0", observe: ["question"] });
  await fs.rm(dir, { recursive: true, force: true });
});

test("finalize --safe-area-insets: sets the declared margin (uniform + keyed-merge); refuses bad values", async () => {
  const dir = await tmpDir();
  const cp = await writeDraft(dir, "g");
  const captures = path.join(dir, "captures");
  await fs.mkdir(captures, { recursive: true });
  await writePack(captures, {
    start: [obj({ id: "startButton", path: "/HUD/StartScreen/StartButton" })],
    active: [obj({ id: "homeButton", path: "/HUD/HomeButton" }), obj({ id: "answerButton0", path: "/HUD/AnswerButton0" })],
    success_reward: [obj({ id: "homeButton", path: "/HUD/HomeButton" }), obj({ id: "card", path: "/HUD/EndSummary/Card", screenRect: { x: 340, y: 120, width: 600, height: 480 } })],
    home_back: [obj({ id: "startButton", path: "/HUD/StartScreen/StartButton" })],
  });
  // Uniform: all four edges set.
  const u = path.join(dir, "u.json");
  assert.equal(await runFinalize(["--contract", cp, "--captures", captures, "--safe-area-insets", "0.02", "--output", u], dir), 0);
  assert.deepEqual(JSON.parse(await fs.readFile(u, "utf-8")).uiSafeAreas.insets, { top: 0.02, bottom: 0.02, left: 0.02, right: 0.02 });
  // Keyed partial: merges over the scaffold default (top stays 0.05).
  const k = path.join(dir, "k.json");
  assert.equal(await runFinalize(["--contract", cp, "--captures", captures, "--safe-area-insets", "bottom=0.03,left=0.01", "--output", k], dir), 0);
  const ins = JSON.parse(await fs.readFile(k, "utf-8")).uiSafeAreas.insets;
  assert.equal(ins.bottom, 0.03);
  assert.equal(ins.left, 0.01);
  assert.equal(ins.top, 0.05, "an un-named edge keeps the scaffold default");
  // Out-of-range / unknown edge → exit 2.
  assert.equal(await runFinalize(["--contract", cp, "--captures", captures, "--safe-area-insets", "0.9"], dir), 2);
  assert.equal(await runFinalize(["--contract", cp, "--captures", captures, "--safe-area-insets", "wobble=0.1"], dir), 2);
  await fs.rm(dir, { recursive: true, force: true });
});

test("finalize --input-response: malformed value → exit 2", async () => {
  const dir = await tmpDir();
  const cp = await writeDraft(dir, "g");
  const code = await runFinalize(["--contract", cp, "--captures", FIXTURE, "--input-response", "bad-format"], dir);
  assert.equal(code, 2);
  await fs.rm(dir, { recursive: true, force: true });
});

test("applyInputResponseFlag: adds the observed object, sets inputResponse, enables the check", () => {
  const draft = buildScaffoldContract("g", { scene: "Assets/Scenes/G.unity" });
  const pack: CapturePack = new Map([
    ["start", [obj({ id: "startButton", path: "/HUD/StartScreen/StartButton" })]],
    ["active", [obj({ id: "homeButton", path: "/HUD/HomeButton" }), obj({ id: "answerButton0", path: "/HUD/AnswerButton0" }), obj({ id: "question", path: "/HUD/Question" })]],
    ["success_reward", [obj({ id: "homeButton", path: "/HUD/HomeButton" }), obj({ id: "card", path: "/HUD/EndSummary/Card", screenRect: { x: 340, y: 120, width: 600, height: 480 } })]],
    ["home_back", [obj({ id: "startButton", path: "/HUD/StartScreen/StartButton" })]],
  ]);
  const fin = inferFinalizedContract(draft, pack, {});
  assert.ok(fin.contract, JSON.stringify(fin.unresolved));
  const applied = applyInputResponseFlag(fin.contract as MinigameContract, pack, { state: "active", tap: "answerButton0", observe: ["question"] });
  assert.ok("contract" in applied, JSON.stringify(applied));
  const c = (applied as { contract: MinigameContract }).contract;
  // `question` (not a role) was resolved from the pack and added to the object registry.
  assert.ok(c.requiredInFrame.some((o) => o.id === "question" && /Question/.test(o.locator)));
  const active = c.states.find((s) => s.id === "active");
  assert.deepEqual(active?.inputResponse, { tap: "answerButton0", observe: ["question"] });
  assert.ok(c.checks.deterministic.includes("input-response"), "the check is enabled");
  // ANTI-GAMING: the observed object goes into the GLOBAL registry only — it must NOT be
  // forced into any state's per-state requiredInFrame (which would make other gates demand
  // it visible somewhere it shouldn't be). An appearing feedback element isn't required-in-frame.
  assert.ok(
    c.states.every((s) => !(s.requiredInFrame ?? []).includes("question")),
    "the observed object must not be force-required-visible per-state",
  );
  // It validates (the gate would otherwise refuse a dangling reference).
  assert.equal(validateMinigameContract(c).valid, true, JSON.stringify(validateMinigameContract(c).issues));
});

test("applyInputResponseFlag: errors on an unknown state or an unresolvable id (exit-2 paths)", () => {
  const draft = buildScaffoldContract("g", { scene: "Assets/Scenes/G.unity" });
  const pack: CapturePack = new Map([
    ["start", [obj({ id: "startButton", path: "/HUD/StartScreen/StartButton" })]],
    ["active", [obj({ id: "homeButton", path: "/HUD/HomeButton" }), obj({ id: "answerButton0", path: "/HUD/AnswerButton0" })]],
    ["success_reward", [obj({ id: "homeButton", path: "/HUD/HomeButton" }), obj({ id: "card", path: "/HUD/EndSummary/Card", screenRect: { x: 340, y: 120, width: 600, height: 480 } })]],
    ["home_back", [obj({ id: "startButton", path: "/HUD/StartScreen/StartButton" })]],
  ]);
  const c = inferFinalizedContract(draft, pack, {}).contract as MinigameContract;
  assert.ok("error" in applyInputResponseFlag(c, pack, { state: "nope", tap: "answerButton0", observe: ["answerButton0"] }));
  assert.ok("error" in applyInputResponseFlag(c, pack, { state: "active", tap: "answerButton0", observe: ["ghost"] }));
});

test("inferFinalizedContract: reward binds the prominent win card, NOT a HUD progress pip or a full-frame backdrop", () => {
  // Reproduces CountTheFruits: the success screen has a tiny persistent-HUD progress pip
  // (/HUD/Progress/Star3, 38px), a full-frame dimming overlay (/HUD/EndSummary), and the
  // real reward (/HUD/EndSummary/Card). The reward must bind the card — binding the 38px
  // pip made the tap-target gate falsely flag "too small to tap".
  const draft = buildScaffoldContract("g", { scene: "Assets/Scenes/G.unity" });
  const pack: CapturePack = new Map([
    ["start", [obj({ id: "startButton", path: "/HUD/StartScreen/StartButton" })]],
    ["active", [obj({ id: "homeButton", path: "/HUD/HomeButton" }), obj({ id: "answerButton0", path: "/HUD/AnswerButton0" })]],
    ["success_reward", [
      obj({ id: "homeButton", path: "/HUD/HomeButton" }),
      obj({ id: "star3", path: "/HUD/Progress/Star3", screenRect: { x: 1155, y: 641, width: 38, height: 38 } }),
      obj({ id: "endSummary", path: "/HUD/EndSummary", screenRect: { x: 0, y: 0, width: 1280, height: 720 } }),
      obj({ id: "card", path: "/HUD/EndSummary/Card", screenRect: { x: 340, y: 120, width: 600, height: 480 } }),
    ]],
    ["home_back", [obj({ id: "startButton", path: "/HUD/StartScreen/StartButton" })]],
  ]);
  const result = inferFinalizedContract(draft, pack, {});
  assert.ok(result.contract, `should finalize: ${JSON.stringify(result.unresolved)}`);
  const reward = result.resolved.find((r) => r.role === "reward object");
  assert.equal(reward?.id, "card", `reward should bind the win card, got ${reward?.id}`);
  assert.notEqual(reward?.id, "star3"); // the HUD progress pip
  assert.notEqual(reward?.id, "endSummary"); // the full-frame backdrop
  // The reward-only fields (excludePath/excludeBackdrops/preferLargest) must NOT alter
  // the other roles — they still bind exactly as before.
  const byRole = Object.fromEntries(result.resolved.map((r) => [r.role, r.id]));
  assert.equal(byRole["start control"], "startButton");
  assert.equal(byRole["home/back control"], "homeButton");
  assert.equal(byRole["active play area"], "answerButton0");
});

test("finalize --outcome-gated marks the states + finalizes without their roles (exit 0)", async () => {
  const dir = await tmpDir();
  const contractPath = await writeDraft(dir, "g");
  const captures = path.join(dir, "captures");
  await fs.mkdir(captures, { recursive: true });
  // start/active/home reachable; success_reward NOT reached (no reward object) — gated.
  await writePack(captures, {
    start: [obj({ id: "startButton", path: "/HUD/StartScreen/StartButton" })],
    active: [obj({ id: "homeButton", path: "/HUD/HomeButton" }), obj({ id: "answerButton0", path: "/HUD/AnswerButton0" })],
    success_reward: [obj({ id: "homeButton", path: "/HUD/HomeButton" })],
    home_back: [obj({ id: "startButton", path: "/HUD/StartScreen/StartButton" })],
  });

  const out = path.join(dir, "finalized.json");
  const code = await runFinalize(
    ["--contract", contractPath, "--captures", captures, "--outcome-gated", "success_reward,home_back", "--output", out],
    dir,
  );
  assert.equal(code, 0);
  const contract = JSON.parse(await fs.readFile(out, "utf-8"));
  const gated = Object.fromEntries(contract.states.map((s: { id: string; outcomeGated?: boolean }) => [s.id, s.outcomeGated]));
  assert.equal(gated.success_reward, true);
  assert.equal(gated.home_back, true);
  assert.equal(gated.start, undefined, "non-gated states are untouched");
  await fs.rm(dir, { recursive: true, force: true });
});

test("finalize --outcome-gated refuses (exit 2) an unknown state id", async () => {
  const dir = await tmpDir();
  const contractPath = await writeDraft(dir, "g");
  const code = await runFinalize(
    ["--contract", contractPath, "--captures", FIXTURE, "--outcome-gated", "no-such-state"],
    dir,
  );
  assert.equal(code, 2);
  await fs.rm(dir, { recursive: true, force: true });
});

test("inferFinalizedContract: an outcome-gated success_reward makes the reward role optional (no refusal)", () => {
  // CountTheFruits case: the win/reward is gated by correct answers on a re-randomizing
  // game, so success_reward is outcomeGated and a read-only verifier never reaches it.
  // Finalize must NOT refuse for a missing reward — it binds the verifiable roles and
  // leaves the gated reward unbound.
  const draft = buildScaffoldContract("g", { scene: "Assets/Scenes/G.unity" });
  const sr = draft.states.find((s) => s.kind === "success_reward")!;
  (sr as { outcomeGated?: boolean }).outcomeGated = true;
  const pack: CapturePack = new Map([
    ["start", [obj({ id: "startButton", path: "/HUD/StartScreen/StartButton" })]],
    ["active", [obj({ id: "homeButton", path: "/HUD/HomeButton" }), obj({ id: "answerButton0", path: "/HUD/AnswerButton0" })]],
    // success_reward intentionally has NO reward-like object (the win was never reached).
    ["success_reward", [obj({ id: "homeButton", path: "/HUD/HomeButton" })]],
    ["home_back", [obj({ id: "startButton", path: "/HUD/StartScreen/StartButton" })]],
  ]);
  const result = inferFinalizedContract(draft, pack, {});
  assert.ok(result.contract, `should finalize despite the gated reward: ${JSON.stringify(result.unresolved)}`);
  assert.ok(!result.resolved.some((r) => r.role === "reward object"), "the gated reward role is not bound");
  // The verifiable roles still resolve.
  const roles = new Set(result.resolved.map((r) => r.role));
  assert.ok(roles.has("start control") && roles.has("home/back control") && roles.has("active play area"));
});

test("finalize refuses (exit 2) a draft carrying a placeholder allowedOffscreen", async () => {
  const dir = await tmpDir();
  const id = "count-the-fruits";
  const draft = buildScaffoldContract(id, { scene: `Assets/Scenes/${id}.unity` });
  // A hand-added allowedOffscreen with a PLACEHOLDER locator must not survive finalize.
  (draft as { allowedOffscreen?: unknown }).allowedOffscreen = [
    { id: "secret", locator: `${id}:/Canvas/SecretPanel`, description: "placeholder" },
  ];
  const contractPath = path.join(dir, `${id}.minigame.json`);
  await fs.writeFile(contractPath, JSON.stringify(draft, null, 2), "utf-8");

  const code = await runFinalize(["--contract", contractPath, "--captures", FIXTURE], dir);
  assert.equal(code, 2);
  // Draft left intact — its placeholder was never laundered into a "finalized" file.
  assert.ok((await fs.readFile(contractPath, "utf-8")).includes("/Canvas/SecretPanel"));
  await fs.rm(dir, { recursive: true, force: true });
});

test("finalize refuses (exit 2) a contract with an unsafe (traversal) state id", async () => {
  const dir = await tmpDir();
  const id = "g";
  const draft = buildScaffoldContract(id, { scene: `Assets/Scenes/${id}.unity` });
  // Tamper a state id to a traversal path — it must never be read off disk.
  draft.states[0].id = "../../etc/passwd";
  draft.interactionFlow.happyPath[0] = "../../etc/passwd";
  const contractPath = path.join(dir, `${id}.minigame.json`);
  await fs.writeFile(contractPath, JSON.stringify(draft, null, 2), "utf-8");

  const captures = path.join(dir, "captures");
  await fs.mkdir(captures, { recursive: true });
  await writePack(captures, {
    active: [obj({ id: "homeBtn", path: "/UI/HomeButton" }), obj({ id: "tile", path: "/UI/AnswerTile" })],
    success_reward: [obj({ id: "card", path: "/UI/EndCard" })],
    home_back: [obj({ id: "playBtn", path: "/UI/PlayButton" })],
  });

  const code = await runFinalize(["--contract", contractPath, "--captures", captures], dir);
  assert.equal(code, 2); // unsafe id treated as a missing capture → refuse, no traversal read
  await fs.rm(dir, { recursive: true, force: true });
});

test("inferFinalizedContract: a partially-clipped object is NOT bindable", () => {
  const draft = buildScaffoldContract("g", { scene: "Assets/Scenes/G.unity" });
  // The only start-screen candidate is partially clipped → start control unresolved.
  const pack: CapturePack = new Map([
    ["start", [obj({ id: "playClipped", path: "/UI/StartButton", isFullyVisible: false })]],
    ["active", [obj({ id: "home", path: "/UI/Home" }), obj({ id: "tile", path: "/UI/AnswerTile" })]],
    ["success_reward", [obj({ id: "home", path: "/UI/Home" }), obj({ id: "card", path: "/UI/EndCard" })]],
    ["home_back", [obj({ id: "playClipped", path: "/UI/StartButton", isFullyVisible: false })]],
  ]);
  const result = inferFinalizedContract(draft, pack, {});
  assert.equal(result.contract, undefined);
  assert.ok(result.unresolved.some((u) => u.role === "start control"), JSON.stringify(result.unresolved));
});

test("inferFinalizedContract: a real observed click overrides the start heuristic", () => {
  const draft = buildScaffoldContract("g", { scene: "Assets/Scenes/G.unity" });
  // Two start-screen objects both match the keyword; the observed click disambiguates.
  const pack: CapturePack = new Map([
    ["start", [
      obj({ id: "playA", path: "/UI/PlayDecoy" }),
      obj({ id: "playB", path: "/UI/StartButton" }),
    ]],
    ["active", [obj({ id: "home", path: "/UI/Home" }), obj({ id: "tile", path: "/UI/AnswerTile" })]],
    ["success_reward", [obj({ id: "home", path: "/UI/Home" }), obj({ id: "card", path: "/UI/EndCard" })]],
    ["home_back", [obj({ id: "playB", path: "/UI/StartButton" })]],
  ]);

  const withClick = inferFinalizedContract(draft, pack, { traceStartPath: "/UI/StartButton" });
  assert.equal(withClick.resolved.find((r) => r.role === "start control")?.id, "playB");

  const noClick = inferFinalizedContract(draft, pack, {});
  // Without the hint, the first keyword match (capture order) wins → playA.
  assert.equal(noClick.resolved.find((r) => r.role === "start control")?.id, "playA");
});

// ── trace-driven (demonstrated) role binding ─────────────────────────────────

/** A minimal `ReplayTrace` from a flat action list (one segment, ui-events backend). */
function traceOf(actions: Action[]): ReplayTrace {
  return {
    schemaVersion: "0.1",
    id: "t",
    start: { scene: "G", reset: "scene-load" },
    input: { backend: "ui-events" },
    segments: [{ id: "s", actions }],
    outcome: { expected: "success" },
  };
}

const tap = (path: string): Action => ({ do: "tap", locator: { path } });
const drag = (from: string, to: string): Action => ({ do: "drag", from: { path: from }, to: { path: to } });

/**
 * The headline: a CHEF-shaped game whose controls don't match the CountFruits keyword set.
 * The dev demonstrated each role in the trace, so finalize binds them with NO keyword match:
 *   start  → a NON-raycast custom-tap hub tile (/Canvas/Tiles/Tile_StarChef)
 *   active → a drag onto /Canvas/MixPanel/MixZone (no keyword, no raycast)
 *   home   → /Canvas/HomePillButton ("home" happens to match, but the trace proves it)
 */
test("inferFinalizedContract: binds chef-shaped roles from the demonstrated trace (no keyword match)", () => {
  const draft = buildScaffoldContract("g", { scene: "Assets/Scenes/G.unity" });
  const pack: CapturePack = new Map([
    ["start", [
      // The tapped tile is a custom-tap container (raycastTarget:false) → not a keyword/raycast pick…
      obj({ id: "tileStarChef", path: "/Canvas/Tiles/Tile_StarChef", raycastTarget: false }),
      obj({ id: "tileStarChefLabel", path: "/Canvas/Tiles/Tile_StarChef/Label", raycastTarget: false, role: "text", text: "Star Chef" }),
      obj({ id: "homePillButton", path: "/Canvas/HomePillButton" }),
    ]],
    ["active", [
      obj({ id: "mixZone", path: "/Canvas/MixPanel/MixZone", raycastTarget: false, role: "container", screenRect: { x: 200, y: 200, width: 400, height: 400 } }),
      obj({ id: "ingredientMilk", path: "/Canvas/Ingredients/Ingredient_milk" }),
      obj({ id: "homePillButton", path: "/Canvas/HomePillButton" }),
    ]],
    ["success_reward", [
      obj({ id: "homePillButton", path: "/Canvas/HomePillButton" }),
      obj({ id: "winCard", path: "/Canvas/EndSummary/Card", screenRect: { x: 340, y: 120, width: 600, height: 480 } }),
    ]],
    ["home_back", [obj({ id: "homePillButton", path: "/Canvas/HomePillButton" })]],
  ]);

  const trace = traceOf([
    tap("/Canvas/Tiles/Tile_StarChef"), // enters active
    drag("/Canvas/Ingredients/Ingredient_milk", "/Canvas/MixPanel/MixZone"), // gameplay
    tap("/Canvas/HomePillButton"), // home
  ]);
  const traceControls = traceDemonstratedControls(draft, trace);

  const result = inferFinalizedContract(draft, pack, { traceControls });
  assert.ok(result.contract, `should finalize: ${JSON.stringify(result.unresolved)}`);
  const byRole = Object.fromEntries(result.resolved.map((r) => [r.role, r.id]));
  // Start control = the tile itself (exact path match), bound despite raycastTarget:false.
  assert.equal(byRole["start control"], "tileStarChef");
  // Active play area = MixZone (no keyword "zone"? it does match — but bound from the drag's drop target).
  assert.equal(byRole["active play area"], "mixZone");
  // Home/back = the pill button, proven by the trace's final tap.
  assert.equal(byRole["home/back control"], "homePillButton");
  assert.equal(validateMinigameContract(result.contract).valid, true);
});

test("inferFinalizedContract: a demonstrated container resolves to its captured child (descendant fallback)", () => {
  // The dev taps the tile container, but ONLY its child Label is a captured uGUI object.
  const draft = buildScaffoldContract("g", { scene: "Assets/Scenes/G.unity" });
  const pack: CapturePack = new Map([
    ["start", [
      obj({ id: "tileLabel", path: "/Canvas/Tiles/Tile_StarChef/Label", raycastTarget: false, role: "text", text: "Star Chef" }),
      obj({ id: "home", path: "/Canvas/HomePillButton" }),
    ]],
    ["active", [obj({ id: "mixZone", path: "/Canvas/MixPanel/MixZone", raycastTarget: false }), obj({ id: "home", path: "/Canvas/HomePillButton" })]],
    ["success_reward", [obj({ id: "home", path: "/Canvas/HomePillButton" }), obj({ id: "card", path: "/Canvas/EndCard", screenRect: { x: 340, y: 120, width: 600, height: 480 } })]],
    ["home_back", [obj({ id: "home", path: "/Canvas/HomePillButton" })]],
  ]);
  const trace = traceOf([
    tap("/Canvas/Tiles/Tile_StarChef"), // container — only its Label is captured
    drag("/Canvas/Ingredients/Ingredient_milk", "/Canvas/MixPanel/MixZone"),
    tap("/Canvas/HomePillButton"),
  ]);
  const result = inferFinalizedContract(draft, pack, { traceControls: traceDemonstratedControls(draft, trace) });
  assert.ok(result.contract, JSON.stringify(result.unresolved));
  assert.equal(result.resolved.find((r) => r.role === "start control")?.id, "tileLabel", "tile → its captured child Label");
});

test("traceDemonstratedControls: returns the 3 demonstrated paths from a chef-shaped trace", () => {
  const draft = buildScaffoldContract("g", { scene: "Assets/Scenes/G.unity" });
  const trace = traceOf([
    tap("/Canvas/Tiles/Tile_StarChef"),
    drag("/Canvas/Ingredients/Ingredient_milk", "/Canvas/MixPanel/MixZone"),
    tap("/Canvas/HomePillButton"),
  ]);
  // Each role yields ORDERED candidate paths; a DRAG yields [drop-zone, dragged-object] so the
  // visible source binds when the zone is invisible.
  assert.deepEqual(traceDemonstratedControls(draft, trace), {
    startControl: ["/Canvas/Tiles/Tile_StarChef"],
    activePlayArea: ["/Canvas/MixPanel/MixZone", "/Canvas/Ingredients/Ingredient_milk"],
    homeBack: ["/Canvas/HomePillButton"],
  });
});

test("traceDemonstratedControls: a trace with no Home tap leaves homeBack empty (defensive)", () => {
  const draft = buildScaffoldContract("g", { scene: "Assets/Scenes/G.unity" });
  // Only a start tap + a gameplay tap; never navigates Home.
  const trace = traceOf([tap("/Canvas/Tiles/Tile_StarChef"), tap("/Canvas/Ingredients/Ingredient_milk")]);
  const controls = traceDemonstratedControls(draft, trace);
  assert.deepEqual(controls.startControl, ["/Canvas/Tiles/Tile_StarChef"]);
  assert.deepEqual(controls.activePlayArea, ["/Canvas/Ingredients/Ingredient_milk"]);
  assert.deepEqual(controls.homeBack ?? [], [], "no Home/Back tap was demonstrated");
});

test("traceDemonstratedControls (multi-scene): binds startControl from the GAMEPLAY scene's tap, not the {initial}-anchored hub (BUG-2 guard)", () => {
  // A fused hub→game contract: the FIRST `active` is the hub (anchored {initial}); role binding must
  // skip it and bind from the StarChef gameplay active's entering action — not silently fall back.
  const base = buildScaffoldContract("g", { scene: "Assets/Scenes/Home.unity" });
  const draft: MinigameContract = {
    ...base,
    scenes: ["Assets/Scenes/Home.unity", "Assets/Scenes/StarChef.unity"],
    requiredInFrame: [
      { id: "home__tile", locator: "Home:/Canvas/Tiles/Tile_StarChef", description: "" },
      { id: "starChef__mixZone", locator: "StarChef:/Canvas/MixPanel/MixZone", description: "" },
    ],
    states: [
      { id: "home__active", kind: "active", scene: "Home", requiredInFrame: ["home__tile"], description: "" },
      { id: "starChef__active", kind: "active", scene: "StarChef", requiredInFrame: ["starChef__mixZone"], description: "" },
    ],
    interactionFlow: { happyPath: ["home__active", "starChef__active"] },
  };
  const trace: ReplayTrace = {
    schemaVersion: "0.1",
    id: "ms",
    start: { scene: "Assets/Scenes/Home.unity", reset: "scene-load" },
    input: { backend: "ui-events" },
    segments: [
      { id: "s1", scene: "Home", actions: [tap("/Canvas/Tiles/Tile_StarChef")] },
      { id: "s2", scene: "StarChef", actions: [drag("/Canvas/Ingredients/Ingredient_milk", "/Canvas/MixPanel/MixZone"), tap("/Canvas/MixPanel/CookButton")] },
    ],
    outcome: { expected: "success" },
  };
  const controls = traceDemonstratedControls(draft, trace);
  // startControl = the StarChef gameplay-entering drag (NOT undefined, NOT the hub tile tap).
  assert.deepEqual(controls.startControl, ["/Canvas/MixPanel/MixZone", "/Canvas/Ingredients/Ingredient_milk"]);
  // activePlayArea = the gameplay tap after the active anchor.
  assert.deepEqual(controls.activePlayArea, ["/Canvas/MixPanel/CookButton"]);
});

test("resolveCapturedObject: exact, LARGEST-descendant, bounded-ancestor, root-guard, boundary", () => {
  // 1. exact.
  const tile = obj({ id: "tile", path: "/HUD/Tile" });
  assert.equal(resolveCapturedObject([tile, obj({ id: "l", path: "/HUD/Tile/Label" })], "/HUD/Tile")?.id, "tile");

  // 2. nearest DESCENDANT = the LARGEST child (the widget body), NOT a tiny badge — so the
  //    safe-area/tap-target gates measure the control.
  const body = obj({ id: "body", path: "/HUD/Tile/Body", screenRect: { x: 0, y: 0, width: 80, height: 60 } });
  const badge = obj({ id: "badge", path: "/HUD/Tile/NewBadge", screenRect: { x: 0, y: 0, width: 12, height: 12 } });
  assert.equal(resolveCapturedObject([badge, body], "/HUD/Tile")?.id, "body", "largest child binds, not the badge");
  // …same-area children tie-break lexicographically (deterministic, order-invariant).
  const aa = obj({ id: "aa", path: "/HUD/Tile/AA" });
  const bb = obj({ id: "bb", path: "/HUD/Tile/BB" });
  assert.equal(resolveCapturedObject([bb, aa], "/HUD/Tile")?.id, "aa");

  // 3. nearest ANCESTOR (realistic pool: a small tile container + a frame backdrop) → the container,
  //    never the frame-defining backdrop (which isn't an ancestor of the tapped tile anyway).
  const container = obj({ id: "container", path: "/Canvas/Tiles/Tile", screenRect: { x: 0, y: 0, width: 30, height: 30 } });
  const backdrop = obj({ id: "backdrop", path: "/Canvas/Background", screenRect: { x: 0, y: 0, width: 100, height: 100 } });
  assert.equal(resolveCapturedObject([container, backdrop], "/Canvas/Tiles/Tile/Icon")?.id, "container");

  // 4. ROOT GUARD: a near-full-frame ancestor (the canvas root) is NEVER bound — that would
  //    launder a frame-filling object as the control, defeating the honest refusal.
  const canvas = obj({ id: "canvas", path: "/Canvas", screenRect: { x: 0, y: 0, width: 100, height: 100 } });
  assert.equal(resolveCapturedObject([canvas], "/Canvas/Deep/Nested/Tile"), null, "never bind the frame-filling root");

  // 5. boundary: /HUD/Home is NOT an ancestor of /HUD/HomeBar; and no match → null.
  const home = obj({ id: "home", path: "/HUD/Home" });
  assert.equal(resolveCapturedObject([home], "/HUD/HomeBar"), null, "/HUD/Home must not match /HUD/HomeBar");
  assert.equal(resolveCapturedObject([obj({ id: "hb", path: "/HUD/HomeBar" })], "/HUD/Home"), null);
  assert.equal(resolveCapturedObject([home], "/HUD/Other"), null);
});

test("inferFinalizedContract: a drag whose drop TARGET is an invisible zone binds the dragged SOURCE", () => {
  // The chef live case: MixZone (drop target) is an invisible zone NOT in the captured pool, so the
  // [to, from] candidate list falls through to the visible dragged source.
  const draft = buildScaffoldContract("g", { scene: "Assets/Scenes/G.unity" });
  const pack: CapturePack = new Map([
    ["start", [obj({ id: "tile", path: "/Canvas/Tiles/Tile_StarChef", raycastTarget: false }), obj({ id: "home", path: "/Canvas/HomePillButton" })]],
    // NOTE: MixZone is NOT captured (invisible drop zone); the ingredient SOURCE is.
    ["active", [obj({ id: "ingredientMilk", path: "/Canvas/Ingredients/Ingredient_milk" }), obj({ id: "home", path: "/Canvas/HomePillButton" })]],
    ["success_reward", [obj({ id: "home", path: "/Canvas/HomePillButton" }), obj({ id: "card", path: "/Canvas/EndCard", screenRect: { x: 340, y: 120, width: 600, height: 480 } })]],
    ["home_back", [obj({ id: "home", path: "/Canvas/HomePillButton" })]],
  ]);
  const trace = traceOf([
    tap("/Canvas/Tiles/Tile_StarChef"),
    drag("/Canvas/Ingredients/Ingredient_milk", "/Canvas/MixPanel/MixZone"), // to=MixZone (absent) → from=ingredient
    tap("/Canvas/HomePillButton"),
  ]);
  const result = inferFinalizedContract(draft, pack, { traceControls: traceDemonstratedControls(draft, trace) });
  assert.ok(result.contract, JSON.stringify(result.unresolved));
  assert.equal(result.resolved.find((r) => r.role === "active play area")?.id, "ingredientMilk", "binds the visible dragged source");
});

test("traceDemonstratedControls: home/back stays keyword-anchored — a non-keyword home control (Lobby) is NOT demonstrated", () => {
  // Documents the v1 limitation: home_back's trace anchor uses HOME_BACK_RE, so a home control
  // named outside that set yields no homeBack (falls back to the role keyword downstream).
  const draft = buildScaffoldContract("g", { scene: "Assets/Scenes/G.unity" });
  const trace = traceOf([tap("/Canvas/Tiles/Tile"), tap("/Canvas/Gameplay/Piece"), tap("/Canvas/Lobby")]);
  const controls = traceDemonstratedControls(draft, trace);
  assert.deepEqual(controls.homeBack ?? [], [], "a 'Lobby' final tap is not recognized as home (keyword-gated)");
});

test("inferFinalizedContract: reward still binds by KEYWORD (the trace demonstrates no reward control)", () => {
  // The trace demonstrates start/active/home, but never a reward control — reward must still
  // resolve via its keyword heuristic (the trace-first path is start/active/home only).
  const draft = buildScaffoldContract("g", { scene: "Assets/Scenes/G.unity" });
  const pack: CapturePack = new Map([
    ["start", [obj({ id: "tile", path: "/Canvas/Tiles/Tile_StarChef", raycastTarget: false }), obj({ id: "home", path: "/Canvas/HomePillButton" })]],
    ["active", [obj({ id: "mixZone", path: "/Canvas/MixPanel/MixZone", raycastTarget: false }), obj({ id: "home", path: "/Canvas/HomePillButton" })]],
    ["success_reward", [obj({ id: "home", path: "/Canvas/HomePillButton" }), obj({ id: "winSummary", path: "/Canvas/WinSummary", screenRect: { x: 300, y: 120, width: 600, height: 460 } })]],
    ["home_back", [obj({ id: "home", path: "/Canvas/HomePillButton" })]],
  ]);
  const trace = traceOf([
    tap("/Canvas/Tiles/Tile_StarChef"),
    drag("/Canvas/Ingredients/Ingredient_milk", "/Canvas/MixPanel/MixZone"),
    tap("/Canvas/HomePillButton"),
  ]);
  const result = inferFinalizedContract(draft, pack, { traceControls: traceDemonstratedControls(draft, trace) });
  assert.ok(result.contract, JSON.stringify(result.unresolved));
  // "winSummary" matches the reward keyword (/win|summary/) → bound, even though undemonstrated.
  assert.equal(result.resolved.find((r) => r.role === "reward object")?.id, "winSummary");
});

test("inferFinalizedContract: with NO trace, the keyword heuristic still binds (back-compat)", () => {
  // The original CountFruits-style path: no traceControls → keyword + raycast resolves every role.
  const draft = buildScaffoldContract("g", { scene: "Assets/Scenes/G.unity" });
  const pack: CapturePack = new Map([
    ["start", [obj({ id: "playBtn", path: "/UI/PlayButton" })]],
    ["active", [obj({ id: "homeBtn", path: "/UI/HomeButton" }), obj({ id: "answerTile", path: "/UI/AnswerTile" })]],
    ["success_reward", [obj({ id: "homeBtn", path: "/UI/HomeButton" }), obj({ id: "endCard", path: "/UI/EndCard", screenRect: { x: 340, y: 120, width: 600, height: 480 } })]],
    ["home_back", [obj({ id: "playBtn", path: "/UI/PlayButton" })]],
  ]);
  const result = inferFinalizedContract(draft, pack, {}); // no traceControls
  assert.ok(result.contract, JSON.stringify(result.unresolved));
  const byRole = Object.fromEntries(result.resolved.map((r) => [r.role, r.id]));
  assert.equal(byRole["start control"], "playBtn");
  assert.equal(byRole["home/back control"], "homeBtn");
  assert.equal(byRole["active play area"], "answerTile");
  assert.equal(byRole["reward object"], "endCard");
});

test("deriveSceneName / buildLocator helpers", () => {
  assert.equal(deriveSceneName("Assets/Scenes/CountTheFruits.unity"), "CountTheFruits");
  assert.equal(deriveSceneName(undefined), undefined);
  assert.equal(buildLocator("CountTheFruits", "/HUD/StartButton"), "CountTheFruits:/HUD/StartButton");
  assert.equal(buildLocator(undefined, "/HUD/StartButton"), "/HUD/StartButton");
});

test("minigame finalize routes through the minigame verb", async () => {
  const dir = await tmpDir();
  const contractPath = await writeDraft(dir);
  const out = path.join(dir, "out.minigame.json");
  const code = await minigameRun(["finalize", "--contract", contractPath, "--captures", FIXTURE, "--output", out]);
  assert.equal(code, 0);
  assert.equal(validateMinigameContract(JSON.parse(await fs.readFile(out, "utf-8"))).valid, true);
  await fs.rm(dir, { recursive: true, force: true });
});

// ── --background confirm (Phase 3) ───────────────────────────────────────────────────────

/** A finalized, validating contract (start/active/reward/home roles resolved). */
function finalizedContract(): MinigameContract {
  const draft = buildScaffoldContract("g", { scene: "Assets/Scenes/G.unity" });
  const pack: CapturePack = new Map([
    ["start", [obj({ id: "startButton", path: "/HUD/StartScreen/StartButton" })]],
    ["active", [obj({ id: "homeButton", path: "/HUD/HomeButton" }), obj({ id: "answerButton0", path: "/HUD/AnswerButton0" })]],
    ["success_reward", [obj({ id: "homeButton", path: "/HUD/HomeButton" }), obj({ id: "card", path: "/HUD/EndSummary/Card", screenRect: { x: 340, y: 120, width: 600, height: 480 } })]],
    ["home_back", [obj({ id: "startButton", path: "/HUD/StartScreen/StartButton" })]],
  ]);
  const fin = inferFinalizedContract(draft, pack, {});
  assert.ok(fin.contract, JSON.stringify(fin.unresolved));
  return fin.contract as MinigameContract;
}

const aabb = (minX: number, maxX: number): BackgroundCandidates["recommended"][number]["aabb"] =>
  ({ min: { x: minX, y: -5 }, max: { x: maxX, y: 5 } });
const order = (sortingOrder: number): BackgroundCandidates["recommended"][number]["order"] =>
  ({ sortingOrder, z: 0, sortingLayerName: "Default" });

/** Candidates: a Main Camera + 2 recommended bands (Sky, Hills) + 1 excluded decorative (Cloud). */
function bgCandidates(): BackgroundCandidates {
  return {
    camera: { locator: "G:/Main Camera", name: "Main Camera", orthographic: true, orthoSize: 5, position: { x: 0, y: 0 } },
    cameras: [{ locator: "G:/Main Camera", name: "Main Camera", orthographic: true, orthoSize: 5, position: { x: 0, y: 0 } }],
    recommended: [
      { locator: "G:/Sky", name: "Sky", aabb: aabb(-12, 12), widestFraction: 1, fullWidthBand: true, order: order(0) },
      { locator: "G:/Hills", name: "Hills", aabb: aabb(-12, 12), widestFraction: 1, fullWidthBand: true, order: order(1) },
    ],
    excluded: [{ locator: "G:/Cloud", name: "Cloud", reason: "decorative: covers 10% of the frame, not a full-width band" }],
    allLayers: [
      { locator: "G:/Sky", aabb: aabb(-12, 12), order: order(0) },
      { locator: "G:/Hills", aabb: aabb(-12, 12), order: order(1) },
      { locator: "G:/Cloud", aabb: aabb(-2, 2), order: order(2) },
    ],
    coverageByDevice: [{ deviceId: "landscape-16x9", label: "16:9", fraction: 1, gapEdges: [] }],
    warnings: [],
  };
}

test("applyBackgroundFlag auto: binds the recommendation, enables the gate, freezes background.json geometry", () => {
  const applied = applyBackgroundFlag(finalizedContract(), bgCandidates(), { mode: "auto" });
  assert.ok("contract" in applied, JSON.stringify(applied));
  const { contract: c, backgroundData } = applied as { contract: MinigameContract; backgroundData: import("../capabilities/minigame/types.js").BackgroundData };
  assert.equal(c.backgroundCamera, "G:/Main Camera");
  assert.deepEqual(c.backgroundLayers, ["G:/Sky", "G:/Hills"]);
  assert.ok(c.checks.deterministic.includes("background-coverage"), "coverage gate enabled");
  assert.ok(c.checks.deterministic.includes("background-seam"), "seam gate enabled");
  assert.equal(validateMinigameContract(c).valid, true, JSON.stringify(validateMinigameContract(c).issues));
  // background.json geometry comes from the REAL recommended AABBs + camera.
  assert.ok(backgroundData, "auto returns frozen geometry");
  assert.deepEqual(backgroundData.camera, { orthographic: true, orthoSize: 5, position: { x: 0, y: 0 } });
  assert.equal(backgroundData.layers.length, 2);
  assert.deepEqual(backgroundData.layers[0], { locator: "G:/Sky", min: { x: -12, y: -5 }, max: { x: 12, y: 5 }, order: order(0) });
  assert.deepEqual(backgroundData.layers[1], { locator: "G:/Hills", min: { x: -12, y: -5 }, max: { x: 12, y: 5 }, order: order(1) });
});

test("applyBackgroundFlag auto: refuses with no candidates / no camera / empty recommended (no mutation)", () => {
  const base = finalizedContract();
  for (const cand of [null, { ...bgCandidates(), camera: undefined }, { ...bgCandidates(), recommended: [] }] as (BackgroundCandidates | null)[]) {
    const applied = applyBackgroundFlag(base, cand, { mode: "auto" });
    assert.ok("error" in applied, `expected refusal for ${JSON.stringify(cand)?.slice(0, 40)}`);
    assert.match((applied as { error: string }).error, /--background-camera|--background-layers/);
  }
  // The base contract was not mutated and never had the gate.
  assert.ok(!base.checks.deterministic.includes("background-coverage"));
});

test("applyBackgroundFlag explicit: matched-by-locator camera+layers synthesize geometry; gate enabled", () => {
  const applied = applyBackgroundFlag(finalizedContract(), bgCandidates(), {
    mode: "explicit",
    camera: "G:/Main Camera",
    layers: ["G:/Sky", "G:/Cloud"], // Cloud is EXCLUDED but present in allLayers → still resolvable
  });
  assert.ok("contract" in applied, JSON.stringify(applied));
  const { contract: c, backgroundData } = applied as { contract: MinigameContract; backgroundData: import("../capabilities/minigame/types.js").BackgroundData };
  assert.equal(c.backgroundCamera, "G:/Main Camera");
  assert.deepEqual(c.backgroundLayers, ["G:/Sky", "G:/Cloud"]);
  assert.ok(c.checks.deterministic.includes("background-coverage"));
  assert.ok(c.checks.deterministic.includes("background-seam"));
  assert.equal(validateMinigameContract(c).valid, true);
  assert.ok(backgroundData, "explicit with all locators matched freezes geometry");
  assert.deepEqual(backgroundData.layers.map((l) => l.locator), ["G:/Sky", "G:/Cloud"]);
  assert.deepEqual(backgroundData.layers[1], { locator: "G:/Cloud", min: { x: -2, y: -5 }, max: { x: 2, y: 5 }, order: order(2) });
});

test("applyBackgroundFlag explicit: an unmatched layer (or null candidates) binds the gate but withholds geometry (re-capture)", () => {
  // A layer not in candidates → no fabricated box, but the binding + gate are set.
  const unmatched = applyBackgroundFlag(finalizedContract(), bgCandidates(), {
    mode: "explicit",
    camera: "G:/Main Camera",
    layers: ["G:/Sky", "G:/Ghost"],
  });
  assert.ok("contract" in unmatched, JSON.stringify(unmatched));
  const u = unmatched as { contract: MinigameContract; backgroundData?: unknown };
  assert.equal(u.contract.backgroundCamera, "G:/Main Camera");
  assert.deepEqual(u.contract.backgroundLayers, ["G:/Sky", "G:/Ghost"]);
  assert.ok(u.contract.checks.deterministic.includes("background-coverage"), "gate still enabled");
  assert.equal(u.backgroundData, undefined, "no geometry fabricated for an unmatched locator");
  assert.equal(validateMinigameContract(u.contract).valid, true);

  // null candidates → same: bind the gate, withhold geometry.
  const noCand = applyBackgroundFlag(finalizedContract(), null, { mode: "explicit", camera: "G:/Main Camera", layers: ["G:/Sky"] });
  assert.ok("contract" in noCand);
  assert.equal((noCand as { backgroundData?: unknown }).backgroundData, undefined);
  assert.ok((noCand as { contract: MinigameContract }).contract.checks.deterministic.includes("background-coverage"));
});

test("applyBackgroundFlag off: removes the gate + bindings, contract still validates", () => {
  // Start from an auto-bound contract, then turn it off.
  const auto = applyBackgroundFlag(finalizedContract(), bgCandidates(), { mode: "auto" }) as { contract: MinigameContract };
  assert.ok(auto.contract.backgroundCamera);
  const off = applyBackgroundFlag(auto.contract, null, { mode: "off" });
  assert.ok("contract" in off, JSON.stringify(off));
  const c = (off as { contract: MinigameContract }).contract;
  assert.ok(!c.checks.deterministic.includes("background-coverage"), "coverage gate removed");
  assert.ok(!c.checks.deterministic.includes("background-seam"), "seam gate removed");
  assert.equal(c.backgroundCamera, undefined, "camera binding deleted");
  assert.equal(c.backgroundLayers, undefined, "layers binding deleted");
  assert.equal((off as { backgroundData?: unknown }).backgroundData, undefined);
  assert.equal(validateMinigameContract(c).valid, true);
});

test("parseArgs: --background family produces the right shape, and rejects bad/mixed/half combinations", () => {
  const base = ["--contract", "c.json", "--captures", "caps"];
  const ok = (extra: string[]) => {
    const r = parseArgs([...base, ...extra]);
    assert.ok(!("error" in r), `expected ok for ${extra.join(" ")}, got ${JSON.stringify(r)}`);
    return r as Exclude<ReturnType<typeof parseArgs>, { error: string }>;
  };
  assert.deepEqual(ok(["--background", "auto"]).background, { mode: "auto" });
  assert.deepEqual(ok(["--background", "off"]).background, { mode: "off" });
  assert.deepEqual(
    ok(["--background-camera", "G:/Cam", "--background-layers", "G:/A, G:/B"]).background,
    { mode: "explicit", camera: "G:/Cam", layers: ["G:/A", "G:/B"] },
  );
  assert.equal(ok([]).background, undefined, "no flags → no background work");

  const err = (extra: string[], re: RegExp) => {
    const r = parseArgs([...base, ...extra]);
    assert.ok("error" in r, `expected error for ${extra.join(" ")}`);
    assert.match((r as { error: string }).error, re);
  };
  err(["--background", "bogus"], /--background must be 'auto' or 'off'/);
  err(["--background", "auto", "--background-camera", "G:/Cam", "--background-layers", "G:/A"], /cannot mix/);
  err(["--background-camera", "G:/Cam"], /must be used together/);
  err(["--background-layers", "G:/A"], /must be used together/);
  // --background-layers PRESENT-but-empty must ERROR, not silently no-op (would exit 0 with the
  // coverage gate quietly absent). Empty string AND a comma-only string both resolve to [].
  err(["--background-layers", ""], /at least one non-empty locator/);
  err(["--background-layers", " , ,"], /at least one non-empty locator/);
  // Present-but-empty layers WITH a camera still errors (the empty-check fires before "used together").
  err(["--background-camera", "G:/Cam", "--background-layers", ""], /at least one non-empty locator/);
});

test("buildFinalizeSummary: appends the 🎨 background block (camera + layers + re-capture warning), and the disabled line", () => {
  const resolved = [{ role: "start control", id: "s", path: "/S", locator: "G:/S" }];
  // Enabled with geometry frozen → no warning.
  const enabled = buildFinalizeSummary(resolved, "/tmp/out.json", "/tmp", {
    camera: "G:/Main Camera",
    layers: ["G:/Sky", "G:/Hills"],
    wroteData: true,
  }).join("\n");
  assert.match(enabled, /🎨 background/);
  assert.match(enabled, /camera: G:\/Main Camera/);
  assert.match(enabled, /layers: G:\/Sky, G:\/Hills/);
  assert.doesNotMatch(enabled, /re-run `minigame capture`/);

  // Enabled but geometry NOT frozen → re-capture warning present.
  const needsRecap = buildFinalizeSummary(resolved, "/tmp/out.json", "/tmp", {
    camera: "G:/Main Camera",
    layers: ["G:/Sky"],
    wroteData: false,
  }).join("\n");
  assert.match(needsRecap, /⚠️ re-run `minigame capture` to produce background\.json before verify\./);

  // Disabled.
  const disabled = buildFinalizeSummary(resolved, "/tmp/out.json", "/tmp", { disabled: true }).join("\n");
  assert.match(disabled, /🎨 background-coverage disabled\./);

  // No background arg → no 🎨 line at all (back-compat).
  assert.doesNotMatch(buildFinalizeSummary(resolved, "/tmp/out.json", "/tmp").join("\n"), /🎨/);
});

test("inferFinalizedContract: a fused hub→game contract with NO start state finalizes (start-control role is N/A)", () => {
  // The live GameHub→StarChef case: the fused multi-scene contract has only `active` and
  // `success_reward` kinds (the scans never produced a `start` state). Finalize must NOT refuse for
  // the absent start control — the game has no start screen — and must bind the roles that DO exist.
  const draft = buildScaffoldContract("g", { scene: "Assets/Scenes/G.unity" });
  draft.states = draft.states.filter((s) => s.kind === "active" || s.kind === "success_reward");
  // Keep interactionFlow consistent with the surviving states.
  draft.interactionFlow = { happyPath: draft.states.map((s) => s.id) };
  const pack: CapturePack = new Map([
    ["active", [obj({ id: "homeButton", path: "/HUD/HomeButton" }), obj({ id: "answerButton0", path: "/HUD/AnswerButton0" })]],
    ["success_reward", [
      obj({ id: "homeButton", path: "/HUD/HomeButton" }),
      obj({ id: "card", path: "/HUD/EndSummary/Card", screenRect: { x: 340, y: 120, width: 600, height: 480 } }),
    ]],
  ]);
  const result = inferFinalizedContract(draft, pack, {});
  assert.ok(result.contract, `should finalize without a start state: ${JSON.stringify(result.unresolved)}`);
  assert.ok(!result.resolved.some((r) => r.role === "start control"), "the absent start-control role is not bound");
  // The roles that DO have states still resolve.
  const roles = new Set(result.resolved.map((r) => r.role));
  assert.ok(roles.has("home/back control") && roles.has("active play area") && roles.has("reward object"),
    `roles bound: ${[...roles].join(", ")}`);
});

test("inferFinalizedContract: a MULTI-SCENE contract preserves each phase's distinctive objects (distinguishable states)", () => {
  // Fused hub→game: distinctive object ids are NAMESPACED (game__powerButton) but their locators are bare
  // paths, while the capture pack keys by BARE id — so resolution is by PATH. Two `active` phases (mix/cook)
  // must NOT collapse to the shared home button; each keeps its distinctive object so the flow check can
  // tell them apart. Single-scene contracts keep role-only binding (covered by the other tests).
  const draft = buildScaffoldContract("g", { scene: "Assets/Scenes/Hub.unity" });
  draft.scenes = ["Assets/Scenes/Hub.unity", "Assets/Scenes/Game.unity"];
  draft.states = [
    { id: "hub__active", kind: "active", scene: "Hub", requiredInFrame: ["hub__homeButton"] },
    { id: "game__mix", kind: "active", scene: "Game", requiredInFrame: ["game__homeButton", "game__ingredientEgg"] },
    { id: "game__cook", kind: "active", scene: "Game", requiredInFrame: ["game__homeButton", "game__powerButton"] },
    { id: "game__win", kind: "success_reward", scene: "Game", requiredInFrame: ["game__homeButton", "game__winCard"] },
  ] as typeof draft.states;
  draft.interactionFlow = { happyPath: draft.states.map((s) => s.id) };
  draft.requiredInFrame = [
    { id: "hub__homeButton", locator: "/Canvas/HomeButton" },
    { id: "game__homeButton", locator: "/Canvas/HomeButton" },
    { id: "game__ingredientEgg", locator: "/Canvas/Mix/Egg" },
    { id: "game__powerButton", locator: "/Canvas/Cook/PowerButton" },
    { id: "game__winCard", locator: "/Canvas/Finale/WinCard" },
  ];
  const pack: CapturePack = new Map([
    ["hub__active", [obj({ id: "homeButton", path: "/Canvas/HomeButton" })]],
    ["game__mix", [obj({ id: "homeButton", path: "/Canvas/HomeButton" }), obj({ id: "ingredientEgg", path: "/Canvas/Mix/Egg" })]],
    ["game__cook", [obj({ id: "homeButton", path: "/Canvas/HomeButton" }), obj({ id: "powerButton", path: "/Canvas/Cook/PowerButton" })]],
    ["game__win", [obj({ id: "homeButton", path: "/Canvas/HomeButton" }), obj({ id: "winCard", path: "/Canvas/Finale/WinCard", screenRect: { x: 100, y: 100, width: 400, height: 300 } })]],
  ]);
  const result = inferFinalizedContract(draft, pack, {});
  assert.ok(result.contract, `should finalize: ${JSON.stringify(result.unresolved)}`);
  const byId = new Map(result.contract.states.map((s) => [s.id, s.requiredInFrame ?? []]));
  const mix = byId.get("game__mix") ?? [];
  const cook = byId.get("game__cook") ?? [];
  // The egg is NOT a role (no keyword match), so it can only be present via the distinctive-object
  // preservation. It resolves by PATH (namespaced draft id → bare pack object) and is bound under the
  // PACK's BARE id so it MATCHES the captures the verify gates read (a namespaced id would never match).
  assert.ok(mix.includes("ingredientEgg"), `mix keeps its distinctive ingredient (bare id): ${JSON.stringify(mix)}`);
  assert.ok(!mix.includes("game__ingredientEgg"), "the namespaced draft id is NOT used (captures key by bare id)");
  // Each phase carries a distinctive object beyond the shared home button, and the two differ → the
  // flow check can tell mix from cook (previously both collapsed to just [homeButton]).
  assert.ok(mix.length >= 2 && cook.length >= 2, `each phase distinguishable: mix=${JSON.stringify(mix)} cook=${JSON.stringify(cook)}`);
  assert.notDeepEqual(mix, cook);
  // The bound object carries the Game scene prefix (not the entry scene Hub) — the multi-scene
  // locator-prefix fix — under its bare id.
  const egg = result.contract.requiredInFrame.find((o) => o.id === "ingredientEgg");
  assert.ok(egg, "the distinctive ingredient resolved into the registry under its bare id");
  assert.match(egg!.locator, /^Game:/, `Game object carries the Game prefix, not Hub: ${egg!.locator}`);
});

test("inferFinalizedContract: a SINGLE-scene contract stays role-only — a resolvable distinctive object is NOT bound", () => {
  // The scaffold stamps `scene` on EVERY state even with one scene, so the multi-scene guard must count
  // DISTINCT scenes, not "any state has a scene" — else single-scene finalize would silently start binding
  // distinctive objects. Here `sparkle` is visible in the active capture but is NOT a role; single-scene
  // must keep the role-only binding (byte-identical) and leave it unbound.
  const draft = buildScaffoldContract("g", { scene: "Assets/Scenes/G.unity" });
  const active = draft.states.find((s) => s.kind === "active")!;
  (active as { requiredInFrame?: string[] }).requiredInFrame = [...(active.requiredInFrame ?? []), "sparkle"];
  draft.requiredInFrame = [...draft.requiredInFrame, { id: "sparkle", locator: "/HUD/Sparkle" }];
  const pack: CapturePack = new Map([
    ["start", [obj({ id: "startButton", path: "/HUD/StartScreen/StartButton" })]],
    ["active", [obj({ id: "homeButton", path: "/HUD/HomeButton" }), obj({ id: "answerButton0", path: "/HUD/AnswerButton0" }), obj({ id: "sparkle", path: "/HUD/Sparkle" })]],
    ["success_reward", [obj({ id: "homeButton", path: "/HUD/HomeButton" }), obj({ id: "card", path: "/HUD/EndSummary/Card", screenRect: { x: 340, y: 120, width: 600, height: 480 } })]],
    ["home_back", [obj({ id: "startButton", path: "/HUD/StartScreen/StartButton" })]],
  ]);
  const result = inferFinalizedContract(draft, pack, {});
  assert.ok(result.contract, JSON.stringify(result.unresolved));
  assert.ok(!result.contract.requiredInFrame.some((o) => o.id === "sparkle"), "single-scene stays role-only — distinctive object not bound");
  const activeOut = result.contract.states.find((s) => s.kind === "active")!;
  assert.ok(!(activeOut.requiredInFrame ?? []).includes("sparkle"), "active state does not require the non-role distinctive object");
});
