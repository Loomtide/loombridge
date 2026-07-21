/**
 * S6c-3 — `loomtide verify --minigame` CLI + exit-code contract.
 *
 * The verify-FIRST loop made real: contract + per-state captures → CLI verify →
 * JSON report + exit code. Coverage:
 *  - PASS (exit 0): the real FIXED CountTheFruits captures pass the gradeable
 *    deterministic checks; a synthetic density pack also passes tap-target-size
 *    (the check that awaits the S6c-3 live re-capture on the real pack).
 *  - FAIL (exit 1): a PRESENT-but-off-screen required object fails the visibility
 *    check and the report names the state/object id (the committed negative
 *    fixture). True refuse-on-absent (a missing capture file) is covered by the
 *    missing-/empty-captures-dir cases below.
 *  - INCOMPLETE (exit 2): nothing graded — every check not_applicable, a missing
 *    captures dir, an unloadable/invalid contract, or an object-check that binds
 *    nothing. Never a silent green.
 *  - The PURE status/exit mapping is unit-tested exhaustively.
 *
 * Style mirrors minigame-gates.test.ts / verification-gates.test.ts (node:test +
 * node:assert/strict; source fixtures resolved via import.meta.url).
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildCrGroups,
  buildMinigameReport,
  exitCodeForMinigame,
  minigameReportStatus,
  nextActionFor,
  runVerifyMinigame,
  splitStateDevice,
  summarize,
  type MinigameDeviceTag,
  type MinigameFinding,
  type MinigameFlatCheck,
  type MinigameVerifyReport,
} from "../loomtide/verify-minigame.js";
import type { FlowReport } from "../loomtide/minigame-gates/interaction-flow.js";
import { run as verifyRun } from "../loomtide/verify.js";
import { assertValidMinigameContract } from "../loomtide/minigame-profiles/validator.js";
import type { MinigameContract } from "../loomtide/minigame-profiles/types.js";
import { makeGateReport, type GateReport } from "../verification/gates/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXED_FIXTURES_DIR = path.resolve(
  __dirname,
  "../../..",
  "mcp-server/src/__tests__/fixtures/minigame-count-the-fruits-fixed",
);
const NEGATIVE_FIXTURE_DIR = path.resolve(
  __dirname,
  "../../..",
  "mcp-server/src/__tests__/fixtures/minigame-offscreen-negative",
);

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "verify-minigame-"));
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value, null, 2), "utf-8");
}

async function readReport(file: string): Promise<MinigameVerifyReport> {
  return JSON.parse(await fs.readFile(file, "utf-8")) as MinigameVerifyReport;
}

/** A capture object with sensible all-visible defaults. */
function obj(o: Record<string, unknown> & { id: string }): Record<string, unknown> {
  return {
    path: `/HUD/${o.id}`,
    role: "image",
    active: true,
    isVisible: true,
    visibilityReason: null,
    isFullyVisible: true,
    isPartiallyClipped: false,
    isOffScreen: false,
    clipSide: null,
    screenRect: { x: 100, y: 100, width: 158, height: 140 },
    ...o,
  };
}

function uiRects(state: string, objects: Array<Record<string, unknown>>): unknown {
  return { state, viewport: { width: 1280, height: 720, aspect: 16 / 9 }, objects };
}

// ── PASS: real FIXED CountTheFruits captures grade green ───────────────────────

/** The FIXED-pack contract for the gradeable deterministic checks (no density). */
function fixedPackContract(): MinigameContract {
  const ref = (id: string) => ({ id, locator: `CountTheFruits:/HUD/${id}` });
  return {
    schemaVersion: "1",
    id: "count-the-fruits",
    type: "2d-kids-minigame",
    title: "Count the Fruits",
    scenes: ["Assets/Scenes/CountTheFruits.unity"],
    ageBand: "3-5",
    visualProfile: "phone-landscape",
    requiredInFrame: [
      "startButton",
      "homeButton",
      "questionText",
      "countChip",
      "progress",
      "answerButton0",
      "answerButton1",
      "answerButton2",
      "endSummary",
      "endCard",
      "scoreText",
      "rewardStars",
      "replayButton",
    ].map(ref),
    states: [
      { id: "start", kind: "start", requiredInFrame: ["startButton"] },
      {
        id: "active",
        kind: "active",
        requiredInFrame: ["questionText", "answerButton0", "answerButton1", "answerButton2", "homeButton", "countChip", "progress"],
      },
      {
        id: "success_reward",
        kind: "success_reward",
        requiredInFrame: ["endSummary", "endCard", "scoreText", "rewardStars", "replayButton"],
      },
      { id: "home_back", kind: "home_back", requiredInFrame: ["startButton"] },
    ],
    uiSafeAreas: { maxOverflowFraction: 0 },
    tapTargets: { minSizeDp: 96 },
    interactionFlow: { happyPath: ["start", "active", "success_reward", "home_back"] },
    artifactThresholds: {},
    // The two white HUD cards are the background-fit subjects (proven green on the
    // 9-sliced FIXED captures). tap-target-size is intentionally OMITTED — it awaits
    // the S6c-3 live re-capture that carries canvasScaleFactor (the fixtures predate it).
    containers: [
      { background: "countChip", bgColor: "#FFFFFF" },
      { background: "progress", bgColor: "#FFFFFF" },
    ],
    checks: {
      deterministic: ["required-in-frame", "safe-area", "control-overlap", "text-clipping", "console-clean", "background-fit"],
    },
  };
}

test("verify --minigame: the FIXED CountTheFruits captures PASS the gradeable gates (exit 0)", async () => {
  const root = await tmpDir();
  try {
    const contractPath = path.join(root, "count-the-fruits.minigame.json");
    await writeJson(contractPath, assertValidMinigameContract(fixedPackContract()));
    const outputPath = path.join(root, "report.json");

    const code = await runVerifyMinigame({
      root,
      contractPath,
      capturesDir: FIXED_FIXTURES_DIR,
      outputPath,
      strict: true,
    });
    assert.equal(code, 0, "fixed pack should pass the gradeable deterministic gates");

    const report = await readReport(outputPath);
    assert.equal(report.status, "pass");
    assert.equal(report.summary.fail, 0);
    assert.equal(report.summary.statesGraded, 4);
    assert.ok(report.summary.pass > 0);
    // background-fit graded on the state where the cards are shown.
    assert.equal(report.gatesByState.active["background-fit"], "pass");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ── PASS: synthetic density pack passes tap-target-size through the CLI ─────────

/** Mirrors what the S6c-3 LIVE re-capture yields: tap targets carry canvasScaleFactor. */
test("verify --minigame: a synthetic density pack PASSES including tap-target-size (exit 0)", async () => {
  const root = await tmpDir();
  const captures = path.join(root, "captures");
  try {
    const contract: MinigameContract = assertValidMinigameContract({
      schemaVersion: "1",
      id: "density-pass",
      type: "2d-kids-minigame",
      title: "Density Pass",
      scenes: ["Assets/Scenes/Density.unity"],
      ageBand: "3-5",
      visualProfile: "phone-landscape",
      requiredInFrame: [
        { id: "playBtn", locator: "Density:/HUD/PlayBtn" },
        { id: "homeBtn", locator: "Density:/HUD/HomeBtn" },
        { id: "rewardBtn", locator: "Density:/HUD/RewardBtn" },
      ],
      states: [
        { id: "active", kind: "active", requiredInFrame: ["playBtn", "homeBtn"] },
        { id: "success_reward", kind: "success_reward", requiredInFrame: ["rewardBtn"] },
      ],
      uiSafeAreas: { maxOverflowFraction: 0 },
      tapTargets: { minSizeDp: 96 },
      interactionFlow: { happyPath: ["active", "success_reward"] },
      artifactThresholds: {},
      checks: {
        deterministic: ["required-in-frame", "safe-area", "control-overlap", "text-clipping", "console-clean", "tap-target-size"],
      },
    });
    const contractPath = path.join(root, "density.minigame.json");
    await writeJson(contractPath, contract);

    // canvasScaleFactor 1.0 at native 1280×720: min edge 140px / 1.0 = 140dp ≥ 96dp.
    await writeJson(
      path.join(captures, "active.ui-rects.json"),
      uiRects("active", [
        obj({ id: "playBtn", raycastTarget: true, canvasScaleFactor: 1.0, screenRect: { x: 100, y: 100, width: 158, height: 140 } }),
        obj({ id: "homeBtn", raycastTarget: true, canvasScaleFactor: 1.0, screenRect: { x: 900, y: 100, width: 158, height: 140 } }),
      ]),
    );
    await writeJson(path.join(captures, "active.console.json"), { errorCount: 0 });
    await writeJson(
      path.join(captures, "success_reward.ui-rects.json"),
      uiRects("success_reward", [
        obj({ id: "rewardBtn", raycastTarget: true, canvasScaleFactor: 1.0, screenRect: { x: 500, y: 280, width: 280, height: 120 } }),
      ]),
    );
    await writeJson(path.join(captures, "success_reward.console.json"), { errorCount: 0 });

    const outputPath = path.join(root, "report.json");
    const code = await runVerifyMinigame({ root, contractPath, capturesDir: captures, outputPath, strict: true });
    assert.equal(code, 0);

    const report = await readReport(outputPath);
    assert.equal(report.status, "pass");
    assert.equal(report.gatesByState.active["tap-target-size"], "pass");
    assert.equal(report.gatesByState.success_reward["tap-target-size"], "pass");
    assert.equal(report.summary.fail, 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ── FAIL: a present-but-off-screen required object fails (visibility), exit 1 ────

test("verify --minigame: the negative offscreen fixture FAILS naming the state/object id (exit 1)", async () => {
  const root = await tmpDir();
  try {
    const outputPath = path.join(root, "report.json");
    const code = await runVerifyMinigame({
      root,
      contractPath: path.join(NEGATIVE_FIXTURE_DIR, "contract.minigame.json"),
      capturesDir: NEGATIVE_FIXTURE_DIR,
      outputPath,
      strict: false,
    });
    assert.equal(code, 1, "an off-screen required object must FAIL");

    const report = await readReport(outputPath);
    assert.equal(report.status, "fail");
    // The failure names the offending state + object id.
    const offending = report.failures.find((f) => f.id === "required-in-frame.targetButton");
    assert.ok(offending, `expected a failure for required-in-frame.targetButton; got ${JSON.stringify(report.failures.map((f) => f.id))}`);
    assert.equal(offending.state, "active");
    assert.match(offending.detail, /not visible|offScreen/i);
    // The clean state is NOT dragged down — the failure is localized.
    assert.equal(report.gatesByState.success_reward["required-in-frame"], "pass");
    assert.equal(report.gatesByState.active["required-in-frame"], "fail");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ── INCOMPLETE (exit 2): nothing graded, never a silent green ───────────────────

test("verify --minigame: interaction-flow enabled but no flow.json is INCOMPLETE (missing_evidence), never green (exit 2)", async () => {
  const root = await tmpDir();
  const captures = path.join(root, "captures");
  try {
    // interaction-flow is the only enabled check; with present captures but NO flow.json
    // it grades as missing_evidence → incomplete, NOT pass (and NOT a game fail).
    const contract = assertValidMinigameContract({
      schemaVersion: "1",
      id: "flow-only",
      type: "2d-kids-minigame",
      scenes: ["Assets/Scenes/D.unity"],
      ageBand: "3-5",
      visualProfile: "phone-landscape",
      requiredInFrame: [{ id: "x", locator: "D:/HUD/x" }],
      states: [
        { id: "active", kind: "active" },
        { id: "success_reward", kind: "success_reward" },
      ],
      uiSafeAreas: { maxOverflowFraction: 0 },
      tapTargets: { minSizeDp: 96 },
      interactionFlow: { happyPath: ["active", "success_reward"] },
      artifactThresholds: {},
      checks: { deterministic: ["interaction-flow"] },
    });
    const contractPath = path.join(root, "flow-only.minigame.json");
    await writeJson(contractPath, contract);
    // Both states captured (so NOT captureAbsent) — but no flow.json.
    await writeJson(path.join(captures, "active.ui-rects.json"), uiRects("active", []));
    await writeJson(path.join(captures, "active.console.json"), { errorCount: 0 });
    await writeJson(path.join(captures, "success_reward.ui-rects.json"), uiRects("success_reward", []));
    await writeJson(path.join(captures, "success_reward.console.json"), { errorCount: 0 });

    const outputPath = path.join(root, "report.json");
    const code = await runVerifyMinigame({ root, contractPath, capturesDir: captures, outputPath, strict: false });
    assert.equal(code, 2, "interaction-flow with no evidence must be incomplete, not green");

    const report = await readReport(outputPath);
    assert.equal(report.status, "incomplete");
    assert.equal(report.summary.fail, 0);
    assert.equal(report.summary.pass, 0);
    assert.equal(report.flow?.outcome, "missing_evidence");
    assert.deepEqual(report.captureAbsent, []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// Per-CHECK vacuity (round-2 review): a single object-scoped check that binds an
// object the check finds nothing gradeable in (control-overlap with one control,
// tap-target-size on a non-tap-target, text-clipping on a non-text object) must
// resolve to incomplete (exit 2) — the evaluators emit not_applicable, never a
// vacuous pass. This is the residual false-green the round-2 review caught.
for (const vac of [
  { check: "control-overlap", obj: { id: "o", role: "button", raycastTarget: true } },
  { check: "tap-target-size", obj: { id: "o", role: "text", raycastTarget: true, canvasScaleFactor: 1.0 } },
  { check: "text-clipping", obj: { id: "o", role: "image", raycastTarget: true } },
]) {
  test(`verify --minigame: '${vac.check}' alone with nothing gradeable is INCOMPLETE, never a vacuous green (exit 2)`, async () => {
    const root = await tmpDir();
    const captures = path.join(root, "caps");
    try {
      const contract = assertValidMinigameContract({
        schemaVersion: "1",
        id: "vac",
        type: "2d-kids-minigame",
        scenes: ["Assets/Scenes/V.unity"],
        ageBand: "3-5",
        visualProfile: "phone-landscape",
        requiredInFrame: [{ id: "o", locator: "V:/HUD/o" }],
        // The state DOES bind an object (so OBJECT_CHECK_NO_BINDINGS doesn't fire) —
        // the check simply finds nothing gradeable in it.
        states: [{ id: "win", kind: "success_reward", requiredInFrame: ["o"] }],
        uiSafeAreas: { maxOverflowFraction: 0 },
        tapTargets: { minSizeDp: 96 },
        interactionFlow: { happyPath: ["win"] },
        artifactThresholds: {},
        checks: { deterministic: [vac.check] },
      });
      const contractPath = path.join(root, "c.minigame.json");
      await writeJson(contractPath, contract);
      await writeJson(path.join(captures, "win.ui-rects.json"), uiRects("win", [obj(vac.obj)]));
      await writeJson(path.join(captures, "win.console.json"), { errorCount: 0 });

      const outputPath = path.join(root, "report.json");
      const code = await runVerifyMinigame({ root, contractPath, capturesDir: captures, outputPath, strict: true });
      assert.equal(code, 2, `${vac.check} graded nothing → must be incomplete, not green`);
      const report = await readReport(outputPath);
      assert.equal(report.status, "incomplete");
      assert.equal(report.summary.pass, 0, "no substantive pass — the check was not_applicable");
      assert.equal(report.gatesByState.win[vac.check], "not_applicable");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
}

test("verify --minigame: present captures dir with MISSING state files is INCOMPLETE (capture/harness gap, exit 2), NOT a game fail (S6d)", async () => {
  const root = await tmpDir();
  const captures = path.join(root, "caps");
  try {
    await fs.mkdir(captures, { recursive: true });
    // The dir exists but is EMPTY — every declared state's ui-rects.json is absent.
    const contract = assertValidMinigameContract({
      schemaVersion: "1",
      id: "absent",
      type: "2d-kids-minigame",
      scenes: ["Assets/Scenes/A.unity"],
      ageBand: "3-5",
      visualProfile: "phone-landscape",
      requiredInFrame: [{ id: "btn", locator: "A:/HUD/btn" }],
      states: [
        { id: "play", kind: "active", requiredInFrame: ["btn"] },
        { id: "win", kind: "success_reward", requiredInFrame: ["btn"] },
      ],
      uiSafeAreas: { maxOverflowFraction: 0 },
      tapTargets: { minSizeDp: 96 },
      interactionFlow: { happyPath: ["play", "win"] },
      artifactThresholds: {},
      checks: { deterministic: ["required-in-frame"] },
    });
    const contractPath = path.join(root, "c.minigame.json");
    await writeJson(contractPath, contract);

    const outputPath = path.join(root, "report.json");
    const code = await runVerifyMinigame({ root, contractPath, capturesDir: captures, outputPath, strict: false });
    // S6d reclassification: a wholly-absent capture is a capture/harness gap → incomplete,
    // NOT a game fail. Exit 2, never exit 1, never green.
    assert.equal(code, 2, "an empty captures dir is a capture/harness gap (incomplete), NOT a game fail");

    const report = await readReport(outputPath);
    assert.equal(report.status, "incomplete");
    // Each missing state is tracked in captureAbsent (not a `fail`).
    assert.deepEqual([...report.captureAbsent].sort(), ["play", "win"]);
    assert.equal(report.failures.length, 0, "a missing capture is never a game-defect failure");
    // UX: the next action names the absent screens (in product language), flags it is
    // NOT a game result, and leaks no gate-id jargon.
    assert.doesNotMatch(report.nextAction, /minigame-capture/, "next action must not leak the gate id");
    assert.match(report.nextAction, /play/i);
    assert.match(report.nextAction, /win/i);
    assert.match(report.nextAction, /not a game result/i);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("verify --minigame: a missing captures dir is INCOMPLETE (exit 2), no report written", async () => {
  const root = await tmpDir();
  try {
    const contractPath = path.join(root, "c.minigame.json");
    await writeJson(contractPath, assertValidMinigameContract(fixedPackContract()));
    const outputPath = path.join(root, "report.json");
    const code = await runVerifyMinigame({
      root,
      contractPath,
      capturesDir: path.join(root, "does-not-exist"),
      outputPath,
      strict: false,
    });
    assert.equal(code, 2);
    // Nothing to grade → no report file is written.
    await assert.rejects(fs.access(outputPath));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("verify --minigame: a contract whose object-checks bind nothing cannot exit 0 (anti-vacuous-pass)", async () => {
  // Regression for the vacuous false-green: object-scoped checks enabled, but no
  // state binds a per-state requiredInFrame object, fed an empty-objects capture.
  // The engine would emit only vacuous "nothing to check here" passes; the contract
  // is now refused at validation, so the CLI reports incomplete (exit 2) — NEVER 0.
  const root = await tmpDir();
  const captures = path.join(root, "caps");
  try {
    const contractPath = path.join(root, "vacuous.minigame.json");
    // Hand-write the (now-invalid) contract directly — assertValid would reject it.
    await writeJson(contractPath, {
      schemaVersion: "1",
      id: "vacuous",
      type: "2d-kids-minigame",
      scenes: ["Assets/Scenes/V.unity"],
      ageBand: "3-5",
      visualProfile: "phone-landscape",
      requiredInFrame: [{ id: "ghost", locator: "V:/HUD/ghost" }],
      states: [{ id: "win", kind: "success_reward" }],
      uiSafeAreas: { maxOverflowFraction: 0 },
      tapTargets: { minSizeDp: 96 },
      interactionFlow: { happyPath: ["win"] },
      artifactThresholds: {},
      checks: { deterministic: ["required-in-frame", "safe-area", "control-overlap", "text-clipping", "tap-target-size"] },
    });
    await writeJson(path.join(captures, "win.ui-rects.json"), uiRects("win", []));
    await writeJson(path.join(captures, "win.console.json"), { errorCount: 0 });

    const outputPath = path.join(root, "report.json");
    const code = await runVerifyMinigame({ root, contractPath, capturesDir: captures, outputPath, strict: true });
    assert.equal(code, 2, "object-checks that bind nothing must be incomplete, never a green");
    await assert.rejects(fs.access(outputPath), "no authoritative report for an ungradeable contract");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("verify --minigame: an invalid/unloadable contract is INCOMPLETE (exit 2)", async () => {
  const root = await tmpDir();
  try {
    const contractPath = path.join(root, "bad.minigame.json");
    // Valid JSON, invalid contract (no deterministic checks, no states).
    await writeJson(contractPath, { schemaVersion: "1", id: "bad", type: "2d-kids-minigame" });
    const code = await runVerifyMinigame({
      root,
      contractPath,
      capturesDir: FIXED_FIXTURES_DIR,
      outputPath: path.join(root, "report.json"),
      strict: false,
    });
    assert.equal(code, 2);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ── CLI arg-parsing through the real `verify` entrypoint ────────────────────────

test("verify --minigame: full CLI path writes the default report and exits 1 on the negative fixture", async () => {
  const root = await tmpDir();
  try {
    const code = await verifyRun([
      "--minigame",
      "--contract",
      path.join(NEGATIVE_FIXTURE_DIR, "contract.minigame.json"),
      "--captures",
      NEGATIVE_FIXTURE_DIR,
      "--root",
      root,
    ]);
    assert.equal(code, 1);
    // Default report location under .loomtide/reports/.
    const report = await readReport(path.join(root, ".loomtide", "reports", "minigame-verification.json"));
    assert.equal(report.status, "fail");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("verify --minigame: --output forwards through the real CLI to a custom report path", async () => {
  const root = await tmpDir();
  try {
    const custom = path.join(root, "nested", "custom-report.json");
    const code = await verifyRun([
      "--minigame",
      "--contract",
      path.join(NEGATIVE_FIXTURE_DIR, "contract.minigame.json"),
      "--captures",
      NEGATIVE_FIXTURE_DIR,
      "--root",
      root,
      "--output",
      custom,
    ]);
    assert.equal(code, 1);
    const report = await readReport(custom);
    assert.equal(report.status, "fail");
    // The default location must NOT be written when --output is explicit.
    await assert.rejects(fs.access(path.join(root, ".loomtide", "reports", "minigame-verification.json")));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("verify --minigame: --captures pointing at a FILE (not a dir) is INCOMPLETE (exit 2)", async () => {
  const root = await tmpDir();
  try {
    const notADir = path.join(root, "captures.txt");
    await fs.writeFile(notADir, "not a directory", "utf-8");
    const contractPath = path.join(root, "c.minigame.json");
    await writeJson(contractPath, assertValidMinigameContract(fixedPackContract()));
    const code = await runVerifyMinigame({
      root,
      contractPath,
      capturesDir: notADir,
      outputPath: path.join(root, "report.json"),
      strict: false,
    });
    assert.equal(code, 2);
    await assert.rejects(fs.access(path.join(root, "report.json")));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("verify --minigame: missing --contract/--captures is a usage error (exit 2)", async () => {
  assert.equal(await verifyRun(["--minigame"]), 2);
  assert.equal(await verifyRun(["--minigame", "--contract", "/x.json"]), 2);
});

test("verify: --contract/--captures without --minigame is a usage error (exit 2)", async () => {
  assert.equal(await verifyRun(["--contract", "/x.json"]), 2);
  assert.equal(await verifyRun(["--captures", "/x"]), 2);
});

test("verify --minigame: mixing contract/profile flags is refused (exit 2)", async () => {
  assert.equal(
    await verifyRun(["--minigame", "--contract", "/x.json", "--captures", "/d", "--profile", "precision"]),
    2,
  );
  assert.equal(
    await verifyRun(["--minigame", "--contract", "/x.json", "--captures", "/d", "--acceptance", "/a.json"]),
    2,
  );
  assert.equal(
    await verifyRun(["--minigame", "--contract", "/x.json", "--captures", "/d", "--id", "feel-id"]),
    2,
  );
  assert.equal(
    await verifyRun(["--minigame", "--contract", "/x.json", "--captures", "/d", "--workspace", "/tmp/feel-ws"]),
    2,
  );
});

// ── PURE status/exit mapping ────────────────────────────────────────────────────

function reports(...specs: Array<[string, Array<{ id: string; status: "pass" | "warn" | "fail" | "not_applicable" }>]>): Record<string, GateReport[]> {
  const states: Record<string, GateReport[]> = {};
  for (const [state, checks] of specs) {
    states[state] = [
      makeGateReport(
        "g",
        checks.map((c) => ({ id: c.id, expected: "e", actual: "a", status: c.status, detail: "d" })),
      ),
    ];
  }
  return states;
}

test("verify --minigame: outcome-gated states are NOT-VERIFIABLE (not a fail), verifiable envelope passes (exit 0)", async () => {
  const root = await tmpDir();
  try {
    const r = (id: string) => ({ id, locator: `G:/HUD/${id}` });
    const contract = assertValidMinigameContract({
      schemaVersion: "1",
      id: "g",
      type: "2d-kids-minigame",
      scenes: ["Assets/Scenes/G.unity"],
      ageBand: "3-5",
      visualProfile: "phone-landscape",
      requiredInFrame: ["startButton", "answerButton0"].map(r),
      states: [
        { id: "start", kind: "start", requiredInFrame: ["startButton"] },
        { id: "active", kind: "active", requiredInFrame: ["answerButton0"] },
        // The win/reward + return are gated by correct answers on a re-randomizing game.
        { id: "success_reward", kind: "success_reward", requiredInFrame: ["startButton"], outcomeGated: true },
        { id: "home_back", kind: "home_back", requiredInFrame: ["startButton"], outcomeGated: true },
      ],
      uiSafeAreas: { maxOverflowFraction: 0 },
      tapTargets: { minSizeDp: 96 },
      interactionFlow: { happyPath: ["start", "active", "success_reward", "home_back"] },
      artifactThresholds: {},
      checks: { deterministic: ["required-in-frame", "interaction-flow"] },
    } as unknown);
    const contractPath = path.join(root, "g.minigame.json");
    await writeJson(contractPath, contract);
    const captures = path.join(root, "captures");
    // Only the verifiable envelope is captured — the gated screens are NOT (read-only can't reach them).
    await writeJson(path.join(captures, "start.ui-rects.json"), uiRects("start", [obj({ id: "startButton", path: "/HUD/startButton" })]));
    await writeJson(path.join(captures, "active.ui-rects.json"), uiRects("active", [obj({ id: "answerButton0", path: "/HUD/answerButton0" })]));
    await writeJson(path.join(captures, "flow.json"), {
      schemaVersion: "1",
      transitions: [
        { from: "start", to: "active", trigger: { kind: "ui-dispatch", target: "/HUD/startButton" },
          actuation: { actuated: true, handlerTarget: "/HUD/startButton", raycastHit: true, handlersFired: ["pointerClick"] } },
      ],
    });

    const outputPath = path.join(root, "report.json");
    const termLines: string[] = [];
    const origErr = console.error;
    console.error = (...a: unknown[]) => { termLines.push(a.map(String).join(" ")); };
    let code: number;
    try {
      code = await runVerifyMinigame({ root, contractPath, capturesDir: captures, outputPath, strict: true, verbose: true });
    } finally {
      console.error = origErr;
    }
    assert.equal(code, 0, "outcome-gated states must NOT fail or block the exit code");

    const report = await readReport(outputPath);
    assert.equal(report.status, "pass");
    assert.deepEqual([...report.outcomeGated].sort(), ["home_back", "success_reward"]);
    assert.deepEqual(report.captureAbsent, [], "gated states are NOT capture-absent (incomplete)");
    assert.ok(report.cr.notAssertedOutcomeGated.length >= 2, "gated states surface in their own CR tier");
    assert.ok(/outcome-gated/i.test(report.nextAction), "the next-action names the gated, not-asserted screens");

    // The terminal Screens section lists ONLY captured screens — a gated state has no .png on
    // disk, so listing its expected path would imply a capture that doesn't exist.
    const term = termLines.join("\n");
    assert.match(term, /start\.png/);
    assert.match(term, /active\.png/);
    assert.doesNotMatch(term, /success_reward\.png/, "uncaptured gated screen must not appear under 🖼 Screens");
    assert.doesNotMatch(term, /home_back\.png/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("verify --minigame: input-response grades liveness end-to-end (pass / game_fail / missing)", async () => {
  const r = (id: string) => ({ id, locator: `G:/HUD/${id}` });
  const baseContract = {
    schemaVersion: "1", id: "g", type: "2d-kids-minigame", scenes: ["Assets/Scenes/G.unity"],
    ageBand: "3-5", visualProfile: "phone-landscape",
    requiredInFrame: ["answer0", "question"].map(r),
    states: [
      { id: "active", kind: "active", requiredInFrame: ["answer0"], inputResponse: { tap: "answer0", observe: ["question"] } },
      { id: "success_reward", kind: "success_reward", requiredInFrame: ["answer0"], outcomeGated: true },
    ],
    uiSafeAreas: { maxOverflowFraction: 0 }, tapTargets: { minSizeDp: 96 },
    interactionFlow: { happyPath: ["active", "success_reward"] }, artifactThresholds: {},
    checks: { deterministic: ["required-in-frame", "input-response"] },
  };
  const writeCommon = async (captures: string) => {
    await writeJson(path.join(captures, "active.ui-rects.json"), uiRects("active", [obj({ id: "answer0", path: "/HUD/answer0" })]));
  };
  const response = (q0: string, q1: string) => ({
    tap: "answer0",
    before: { objects: [obj({ id: "question", path: "/HUD/question", text: q0 })] },
    after: { objects: [obj({ id: "question", path: "/HUD/question", text: q1 })] },
  });

  // (1) PASS — the question text changed after the tap.
  {
    const root = await tmpDir();
    try {
      const cp = path.join(root, "g.minigame.json");
      await writeJson(cp, assertValidMinigameContract(baseContract as unknown));
      const captures = path.join(root, "captures");
      await writeCommon(captures);
      await writeJson(path.join(captures, "active.response.json"), response("How many apples?", "How many pears?"));
      const out = path.join(root, "report.json");
      const code = await runVerifyMinigame({ root, contractPath: cp, capturesDir: captures, outputPath: out, strict: false });
      assert.equal(code, 0, "responded → pass");
      assert.equal((await readReport(out)).inputResponse?.outcome, "pass");
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  }
  // (2) GAME_FAIL — nothing changed after the tap (inert control).
  {
    const root = await tmpDir();
    try {
      const cp = path.join(root, "g.minigame.json");
      await writeJson(cp, assertValidMinigameContract(baseContract as unknown));
      const captures = path.join(root, "captures");
      await writeCommon(captures);
      await writeJson(path.join(captures, "active.response.json"), response("Same", "Same"));
      const out = path.join(root, "report.json");
      const code = await runVerifyMinigame({ root, contractPath: cp, capturesDir: captures, outputPath: out, strict: false });
      assert.equal(code, 1, "no response → fail (exit 1)");
      assert.equal((await readReport(out)).inputResponse?.outcome, "game_fail");
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  }
  // (3) MISSING_EVIDENCE — no response.json (capture gap → incomplete, exit 2, NOT a game fail).
  {
    const root = await tmpDir();
    try {
      const cp = path.join(root, "g.minigame.json");
      await writeJson(cp, assertValidMinigameContract(baseContract as unknown));
      const captures = path.join(root, "captures");
      await writeCommon(captures);
      const out = path.join(root, "report.json");
      const code = await runVerifyMinigame({ root, contractPath: cp, capturesDir: captures, outputPath: out, strict: false });
      assert.equal(code, 2, "no evidence → incomplete (exit 2)");
      assert.equal((await readReport(out)).inputResponse?.outcome, "missing_evidence");
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  }
});

test("minigameReportStatus: empty / all-not_applicable → incomplete", () => {
  assert.equal(minigameReportStatus({}, { strict: false }), "incomplete");
  assert.equal(
    minigameReportStatus(reports(["s", [{ id: "a", status: "not_applicable" }]]), { strict: false }),
    "incomplete",
  );
});

test("minigameReportStatus: any graded fail → fail (even amid passes)", () => {
  assert.equal(
    minigameReportStatus(
      reports(["s1", [{ id: "a", status: "pass" }]], ["s2", [{ id: "b", status: "fail" }]]),
      { strict: false },
    ),
    "fail",
  );
});

test("minigameReportStatus: all pass → pass; warn → pass unless --strict", () => {
  assert.equal(minigameReportStatus(reports(["s", [{ id: "a", status: "pass" }]]), { strict: false }), "pass");
  assert.equal(minigameReportStatus(reports(["s", [{ id: "a", status: "warn" }]]), { strict: false }), "pass");
  assert.equal(minigameReportStatus(reports(["s", [{ id: "a", status: "warn" }]]), { strict: true }), "fail");
});

test("minigameReportStatus (G8 MOAT): a sequential-sub-screen state forces incomplete — never laundered into a pass", () => {
  const passing = reports(["s", [{ id: "a", status: "pass" }]]);
  // All per-state checks pass, but a state collapses sequential sub-screens (cook) → can't verify it
  // as one frame → incomplete. This is the moat: a `not_applicable` downgrade on the sequential object
  // must NOT let an otherwise-green run ship; the sequentialStates signal forces incomplete.
  assert.equal(minigameReportStatus(passing, { strict: false }), "pass"); // control
  assert.equal(minigameReportStatus(passing, { strict: false, sequentialStates: ["cook"] }), "incomplete");
  // A REAL fail still outranks the sequential incomplete (a defect is never hidden by it).
  const failing = reports(["s", [{ id: "a", status: "fail" }]]);
  assert.equal(minigameReportStatus(failing, { strict: false, sequentialStates: ["cook"] }), "fail");
});

test("minigameReportStatus: a baseline regression → fail, and OUTRANKS a harness/capture incomplete (S6e)", () => {
  const passing = reports(["s", [{ id: "a", status: "pass" }]]);
  const harness = { outcome: "harness_fault", transitions: [] } as unknown as FlowReport;
  // Regression alone → fail.
  assert.equal(minigameReportStatus(passing, { strict: false, regressions: ["s"] }), "fail");
  // Regression + a harness fault → STILL fail (the regression is computed from present
  // captures; `fail` outranks the harness `incomplete` — never laundered to incomplete).
  assert.equal(minigameReportStatus(passing, { strict: false, regressions: ["s"], flow: harness }), "fail");
  // Regression + a captureAbsent state → still fail.
  assert.equal(minigameReportStatus(passing, { strict: false, regressions: ["s"], captureAbsent: ["other"] }), "fail");
});

test("minigameReportStatus: a baseline-incomplete (unreadable baseline) → incomplete, never a silent pass (S6e)", () => {
  const passing = reports(["s", [{ id: "a", status: "pass" }]]);
  assert.equal(minigameReportStatus(passing, { strict: false, baselineIncomplete: ["s"] }), "incomplete");
  // A real game fail still outranks a baseline-incomplete.
  assert.equal(
    minigameReportStatus(reports(["s", [{ id: "a", status: "fail" }]]), { strict: false, baselineIncomplete: ["s"] }),
    "fail",
  );
});

test("exitCodeForMinigame: pass=0, fail=1, incomplete=2", () => {
  assert.equal(exitCodeForMinigame("pass"), 0);
  assert.equal(exitCodeForMinigame("fail"), 1);
  assert.equal(exitCodeForMinigame("incomplete"), 2);
});

test("buildCrGroups: a baseline regression lands in its OWN group, never blocking/incomplete (S6e)", () => {
  const states: Record<string, GateReport[]> = {
    win: [makeGateReport("required-in-frame", [{ id: "required-in-frame.btn", expected: "e", actual: "a", status: "pass", detail: "ok" }])],
  };
  const baselineRegression: MinigameFinding = { source: "baseline", state: "win", detail: "drifted 18% vs baseline" };
  const baselineIncomplete: MinigameFinding = { source: "baseline", state: "lose", detail: "baseline missing" };
  const cr = buildCrGroups(states, [], [], [], undefined, {
    regressions: [baselineRegression],
    incomplete: [baselineIncomplete],
  });
  assert.deepEqual(cr.baselineRegressions, [baselineRegression]);
  assert.ok(!cr.blockingFailures.some((f) => f.source === "baseline"), "a regression is not a game defect");
  // The baseline-INCOMPLETE (can't compare) belongs to the harness/incomplete bucket, not regressions.
  assert.ok(cr.incompleteHarness.some((f) => f === baselineIncomplete));
  assert.ok(!cr.baselineRegressions.includes(baselineIncomplete));
});

test("buildMinigameReport: relativizes captures dir + stamps contract metadata", async () => {
  const root = await tmpDir();
  const captures = path.join(root, "caps");
  try {
    await writeJson(path.join(captures, "success_reward.ui-rects.json"), uiRects("success_reward", []));
    await writeJson(path.join(captures, "success_reward.console.json"), { errorCount: 0 });
    const contract = assertValidMinigameContract({
      schemaVersion: "1",
      id: "meta",
      type: "2d-kids-minigame",
      title: "Meta",
      scenes: ["Assets/Scenes/M.unity"],
      ageBand: "5-7",
      visualProfile: "tablet-portrait",
      requiredInFrame: [{ id: "x", locator: "M:/HUD/x" }],
      states: [{ id: "success_reward", kind: "success_reward" }],
      uiSafeAreas: { maxOverflowFraction: 0 },
      tapTargets: { minSizeDp: 64 },
      interactionFlow: { happyPath: ["success_reward"] },
      artifactThresholds: {},
      checks: { deterministic: ["console-clean"] },
    });
    const report = await buildMinigameReport(contract, { root, contractPath: "x", capturesDir: captures, strict: false });
    assert.equal(report.capturesDir, "caps");
    assert.equal(report.contract.ageBandLabel, "Early elementary (5–7)");
    assert.equal(report.contract.visualProfileLabel, "Tablet portrait (3:4)");
    assert.equal(report.status, "pass");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ── S6f: partner-facing CR grouping ──────────────────────────────────────────────

test("buildCrGroups: sorts results into blocking / incomplete-harness / passed / advisory (harness != game defect)", () => {
  const states: Record<string, GateReport[]> = {
    start: [makeGateReport("required-in-frame", [{ id: "required-in-frame.btn", expected: "e", actual: "a", status: "pass", detail: "ok" }])],
    active: [
      makeGateReport("required-in-frame", [{ id: "required-in-frame.ghost", expected: "e", actual: "absent", status: "fail", detail: "absent from capture" }]),
      makeGateReport("control-overlap", [{ id: "control-overlap.active", expected: "e", actual: "a", status: "not_applicable", detail: "too few to overlap" }]),
    ],
  };
  const failures = [{ state: "active", gate: "required-in-frame", id: "required-in-frame.ghost", expected: "e", actual: "absent", detail: "absent from capture" }];
  const notApplicable = [{ state: "active", gate: "control-overlap", id: "control-overlap.active", expected: "e", actual: "a", detail: "too few to overlap" }];
  const captureAbsent = ["home_back"];
  const flow: FlowReport = {
    outcome: "game_fail",
    transitions: [
      { transition: "start → active", from: "start", to: "active", expectedState: "active", status: "game_fail", actualEvidence: "e", detail: "did not reach", nextAction: "fix game" },
      { transition: "active → win", from: "active", to: "win", expectedState: "win", status: "harness_fault", actualEvidence: "e", detail: "actuated=false", nextAction: "re-capture" },
    ],
  };

  const cr = buildCrGroups(states, failures, notApplicable, captureAbsent, flow);

  // BLOCKING = the gate fail + the flow game_fail (real game defects).
  assert.equal(cr.blockingFailures.length, 2);
  assert.ok(cr.blockingFailures.some((f) => f.source === "gate" && f.id === "required-in-frame.ghost"));
  assert.ok(cr.blockingFailures.some((f) => f.source === "flow" && f.transition === "start → active"));

  // INCOMPLETE/HARNESS = captureAbsent + the flow harness_fault; NEVER in blocking.
  assert.ok(cr.incompleteHarness.some((f) => f.source === "capture" && f.state === "home_back"));
  assert.ok(cr.incompleteHarness.some((f) => f.source === "flow" && f.transition === "active → win"));
  assert.ok(!cr.blockingFailures.some((f) => f.transition === "active → win" || f.state === "home_back"), "harness/capture gaps must never be blocking failures");

  // PASSED grouped by state; ADVISORY = the vacuous n/a (capture-absent marker excluded).
  assert.deepEqual(cr.passedGates.start, ["required-in-frame"]);
  assert.equal(cr.advisoryNotes.length, 1);
  assert.equal(cr.advisoryNotes[0].gate, "control-overlap");
});

test("buildCrGroups: a background-seam blocking failure resolves seamAnnotation.screenshotKey to the gameplay <state>@<device>", () => {
  const states: Record<string, GateReport[]> = {};
  // The seam fail carries a seamAnnotation (one bottom segment) + a device tag; the
  // gameplayStateId ("active") + device id form the `active@<device>` screenshot key.
  const failures: MinigameFlatCheck[] = [
    {
      state: "__background-seam__",
      gate: "background-seam",
      id: "background-seam",
      expected: "e",
      actual: "1 visible seam(s)",
      detail: "A background layer's cut edge is visible inside the frame.",
      device: { id: "wide-20x9", label: "Tall Android (20:9)" },
      seamAnnotation: {
        viewport: { width: 2400, height: 1080 },
        segments: [
          { edge: "bottom", layerLocator: "Scene:/Background/Ground", line: { x0: 0, y0: 0.78, x1: 1, y1: 0.78 }, strip: { x: 0, y: 0.78, width: 1, height: 0.22 }, exposedFraction: 0.22 },
        ],
      },
    },
  ];

  const cr = buildCrGroups(states, failures, [], [], undefined, undefined, [], undefined, undefined, "active");
  assert.equal(cr.blockingFailures.length, 1);
  const f = cr.blockingFailures[0];
  assert.ok(f.seamAnnotation, "the seam annotation is carried onto the blocking failure");
  assert.equal(f.seamAnnotation.screenshotKey, "active@wide-20x9");
  // The segments survive the copy.
  assert.equal(f.seamAnnotation.segments.length, 1);

  // No gameplay state → no screenshotKey (renderer falls back to a plain card; no crash).
  const crNone = buildCrGroups(states, failures, [], [], undefined, undefined, [], undefined, undefined, undefined);
  assert.equal(crNone.blockingFailures[0].seamAnnotation?.screenshotKey, undefined);
});

test("verify --minigame: report carries cr groups + per-state capture paths (pass case)", async () => {
  const root = await tmpDir();
  try {
    const contractPath = path.join(root, "ctf.minigame.json");
    await writeJson(contractPath, assertValidMinigameContract(fixedPackContract()));
    const outputPath = path.join(root, "report.json");
    const code = await runVerifyMinigame({ root, contractPath, capturesDir: FIXED_FIXTURES_DIR, outputPath, strict: true });
    assert.equal(code, 0);

    const report = await readReport(outputPath);
    // CR grouping present and coherent for an all-green run.
    assert.equal(report.cr.blockingFailures.length, 0);
    assert.equal(report.cr.incompleteHarness.length, 0);
    // These FIXED fixtures predate Phase 3 (no `<state>@<device>` files on disk), so grading
    // falls back to the legacy `<state>` key — passedGates stays keyed by the logical states.
    assert.deepEqual(Object.keys(report.cr.passedGates).sort(), ["active", "home_back", "start", "success_reward"]);
    assert.ok(report.cr.passedGates.active.includes("required-in-frame"));
    // Per-state capture paths: the LEGACY `<state>` entries are still present (Phase 4 keeps
    // them) for every declared state; statePaths ALSO carries per-device `<state>@<device>`
    // entries (built from the contract's device set), but those are additive.
    for (const s of ["start", "active", "success_reward", "home_back"]) {
      assert.match(report.statePaths[s].png, new RegExp(`${s}\\.png$`));
      assert.match(report.statePaths[s].uiRects, new RegExp(`${s}\\.ui-rects\\.json$`));
      assert.match(report.statePaths[s].console, new RegExp(`${s}\\.console\\.json$`));
    }
    // The per-device entries point at `<state>@<device>` artifacts; console reuses base.
    assert.match(report.statePaths["start@landscape-16x9"].png, /start@landscape-16x9\.png$/);
    assert.match(report.statePaths["start@landscape-16x9"].uiRects, /start@landscape-16x9\.ui-rects\.json$/);
    assert.match(report.statePaths["start@landscape-16x9"].console, /start\.console\.json$/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("verify --minigame: a blocking object failure lands in cr.blockingFailures, not incompleteHarness", async () => {
  const root = await tmpDir();
  try {
    const outputPath = path.join(root, "report.json");
    await runVerifyMinigame({
      root,
      contractPath: path.join(NEGATIVE_FIXTURE_DIR, "contract.minigame.json"),
      capturesDir: NEGATIVE_FIXTURE_DIR,
      outputPath,
      strict: false,
    });
    const report = await readReport(outputPath);
    assert.equal(report.status, "fail");
    assert.ok(report.cr.blockingFailures.some((f) => f.id === "required-in-frame.targetButton"));
    assert.equal(report.cr.incompleteHarness.length, 0, "a present-but-offscreen object is a game defect, not a harness gap");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("verify --minigame: a wholly-absent capture lands in cr.incompleteHarness (NOT blocking)", async () => {
  const root = await tmpDir();
  const captures = path.join(root, "caps");
  try {
    await fs.mkdir(captures, { recursive: true });
    const contract = assertValidMinigameContract({
      schemaVersion: "1",
      id: "absent-cr",
      type: "2d-kids-minigame",
      scenes: ["Assets/Scenes/A.unity"],
      ageBand: "3-5",
      visualProfile: "phone-landscape",
      requiredInFrame: [{ id: "btn", locator: "A:/HUD/btn" }],
      states: [
        { id: "play", kind: "active", requiredInFrame: ["btn"] },
        { id: "win", kind: "success_reward", requiredInFrame: ["btn"] },
      ],
      uiSafeAreas: { maxOverflowFraction: 0 },
      tapTargets: { minSizeDp: 96 },
      interactionFlow: { happyPath: ["play", "win"] },
      artifactThresholds: {},
      checks: { deterministic: ["required-in-frame"] },
    });
    const contractPath = path.join(root, "c.minigame.json");
    await writeJson(contractPath, contract);
    const outputPath = path.join(root, "report.json");
    const code = await runVerifyMinigame({ root, contractPath, capturesDir: captures, outputPath, strict: false });
    assert.equal(code, 2);
    const report = await readReport(outputPath);
    assert.equal(report.cr.blockingFailures.length, 0, "a missing capture is never a blocking game defect");
    const states = new Set(report.cr.incompleteHarness.filter((f) => f.source === "capture").map((f) => f.state));
    assert.deepEqual([...states].sort(), ["play", "win"]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("buildCrGroups: a graded warn check surfaces in cr.warnings (never invisible)", () => {
  const states: Record<string, GateReport[]> = {
    s: [makeGateReport("g", [{ id: "g.w", expected: "e", actual: "a", status: "warn", detail: "soft issue" }])],
  };
  const cr = buildCrGroups(states, [], [], [], undefined);
  assert.equal(cr.warnings.length, 1);
  assert.equal(cr.warnings[0].id, "g.w");
  assert.equal(cr.blockingFailures.length, 0);
  assert.equal(cr.advisoryNotes.length, 0);
  assert.deepEqual(cr.passedGates, {}, "a warn gate is not 'passed'");
});

test("verify --minigame: a game_fail and a captureAbsent in the SAME run split into blocking vs incomplete (end-to-end)", async () => {
  const root = await tmpDir();
  const captures = path.join(root, "caps");
  try {
    const contract = assertValidMinigameContract({
      schemaVersion: "1",
      id: "split",
      type: "2d-kids-minigame",
      scenes: ["Assets/Scenes/S.unity"],
      ageBand: "3-5",
      visualProfile: "phone-landscape",
      requiredInFrame: [
        { id: "startBtn", locator: "S:/HUD/StartBtn" },
        { id: "winObj", locator: "S:/HUD/WinObj" },
      ],
      states: [
        { id: "start", kind: "start", requiredInFrame: ["startBtn"] },
        { id: "win", kind: "success_reward", requiredInFrame: ["winObj"] },
        { id: "lose", kind: "failure_timeout" },
      ],
      uiSafeAreas: { maxOverflowFraction: 0 },
      tapTargets: { minSizeDp: 96 },
      interactionFlow: { happyPath: ["start", "win"] },
      artifactThresholds: {},
      checks: { deterministic: ["required-in-frame", "interaction-flow"] },
    });
    await writeJson(path.join(root, "c.minigame.json"), contract);
    // start present; win present but MISSING winObj (→ game_fail on start→win + required-in-frame fail);
    // lose has NO capture (→ captureAbsent).
    await writeJson(path.join(captures, "start.ui-rects.json"), uiRects("start", [obj({ id: "startBtn", path: "/HUD/StartBtn" })]));
    await writeJson(path.join(captures, "start.console.json"), { errorCount: 0 });
    await writeJson(path.join(captures, "win.ui-rects.json"), uiRects("win", []));
    await writeJson(path.join(captures, "win.console.json"), { errorCount: 0 });
    await writeJson(path.join(captures, "flow.json"), {
      schemaVersion: "1",
      transitions: [
        { from: "start", to: "win", trigger: { kind: "ui-dispatch", target: "/HUD/StartBtn" },
          actuation: { actuated: true, handlerTarget: "/HUD/StartBtn", raycastHit: true, handlersFired: ["pointerClick"] } },
      ],
    });

    const outputPath = path.join(root, "report.json");
    const code = await runVerifyMinigame({ root, contractPath: path.join(root, "c.minigame.json"), capturesDir: captures, outputPath, strict: false });
    assert.equal(code, 1, "a real game defect (fail) outranks the capture gap (exit 1)");
    const report = await readReport(outputPath);
    // Game defects → blocking (the missing required object AND the flow game_fail).
    assert.ok(report.cr.blockingFailures.some((f) => f.id === "required-in-frame.winObj"));
    assert.ok(report.cr.blockingFailures.some((f) => f.source === "flow" && f.transition === "start → win"));
    // The capture gap → incomplete, NEVER blocking.
    assert.ok(report.cr.incompleteHarness.some((f) => f.source === "capture" && f.state === "lose"));
    assert.ok(!report.cr.blockingFailures.some((f) => f.state === "lose"), "a capture gap is never a blocking game defect");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("verify --minigame: statePaths fall back to ABSOLUTE when the captures dir is outside root", async () => {
  const root = await tmpDir();
  const captures = await tmpDir(); // a SEPARATE dir, not under root
  try {
    const contractPath = path.join(root, "c.minigame.json");
    await writeJson(contractPath, assertValidMinigameContract(fixedPackContract()));
    const outputPath = path.join(root, "report.json");
    await runVerifyMinigame({ root, contractPath, capturesDir: FIXED_FIXTURES_DIR, outputPath, strict: false });
    // FIXED_FIXTURES_DIR is in the repo, not under the tmp root → absolute paths, no `..` leak.
    const report = await readReport(outputPath);
    for (const s of Object.values(report.statePaths)) {
      assert.ok(path.isAbsolute(s.png), `expected an absolute png path, got ${s.png}`);
      assert.doesNotMatch(s.png, /\.\./, "no '..' traversal in the path");
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(captures, { recursive: true, force: true });
  }
});

test("verify --minigame: the terminal render is partner-clean (S7b) — no dev prefix, humanized line, raw id demoted", async () => {
  const root = await tmpDir();
  const lines: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  try {
    // The negative offscreen fixture → a blocking game defect.
    await runVerifyMinigame({
      root,
      contractPath: path.join(NEGATIVE_FIXTURE_DIR, "contract.minigame.json"),
      capturesDir: NEGATIVE_FIXTURE_DIR,
      outputPath: path.join(root, "report.json"),
      strict: false,
      verbose: true,
    });
  } finally {
    console.error = orig;
    await fs.rm(root, { recursive: true, force: true });
  }
  const out = lines.join("\n");
  // Partner-language banner + section headers, now in the icon (emoji) style.
  assert.match(out, /❌ .*: NOT READY/, "status icon + label header");
  assert.match(out, /🔴 Must fix before release/);
  assert.match(out, /🖼 Screens/);
  // The finding leads with a plain-language sentence, marked with ✗…
  assert.match(out, /✗ .*off-screen or hidden/);
  // …and the raw check id is DEMOTED to a trailing detail, not the headline.
  assert.match(out, /\[active, check: required-in-frame\.targetButton\]/);
  // The dev prefix is gone.
  assert.doesNotMatch(out, /\[loomtide verify\]/);
  // The Next line speaks in product names — the raw `<screen>/<gate>.<id>` slash form
  // is gone (the demoted bracket detail above is the only place the id appears).
  assert.match(out, /👉 Next: fix Target Button/);
  assert.doesNotMatch(out, /active\/required-in-frame\.targetButton/);
});

test("verify --minigame: the terminal is SLIM by default — scorecard + report link only; --verbose restores the breakdown", async () => {
  const root = await tmpDir();
  const run = async (verbose: boolean): Promise<string> => {
    const lines: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
    try {
      await runVerifyMinigame({
        root,
        contractPath: path.join(NEGATIVE_FIXTURE_DIR, "contract.minigame.json"),
        capturesDir: NEGATIVE_FIXTURE_DIR,
        outputPath: path.join(root, "report.json"),
        strict: false,
        verbose,
      });
    } finally {
      console.error = orig;
    }
    return lines.join("\n");
  };
  try {
    const slim = await run(false);
    // Slim ALWAYS shows the scorecard + a one-line "open" report command…
    assert.match(slim, /📊 .* pass · .* fail/, "scorecard stays");
    assert.match(slim, /📄 Report: open \S+\.html$/m, "report link is just the open command (no md/json tail)");
    // …and DROPS the per-finding breakdown (it lives in the HTML/MD/JSON report now).
    assert.doesNotMatch(slim, /🔴 Must fix before release/, "no must-fix dump in slim");
    assert.doesNotMatch(slim, /🖼 Screens/, "no screens dump in slim");
    assert.doesNotMatch(slim, /✗ .*off-screen or hidden/, "no per-finding sentences in slim");
    // MOAT safety net: at a non-standard --output the footer is skipped, so a FAIL still gets a
    // one-line verdict — it must never read green just because the breakdown is hidden.
    assert.match(slim, /NOT READY \(exit 1\)/, "slim FAIL prints a one-line verdict when there's no footer");

    const verbose = await run(true);
    assert.match(verbose, /🔴 Must fix before release/, "verbose restores the breakdown");
    assert.match(verbose, /🖼 Screens/);
    assert.match(verbose, /👉 Next: fix Target Button/, "verbose keeps the findings-specific next line");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("verify --minigame (slim): prints the resolved next-step footer at the standard report path; --quiet-next suppresses it (wrapper owns it)", async () => {
  // The footer fires only when the report we write IS the workspace's standard report
  // (`<dirname(contract)>/reports/minigame-verification.json`) — so place the contract IN a
  // workspace and write there. nextStepLinesFor then resolves a real next step for that workspace.
  const ws = await tmpDir();
  await fs.copyFile(path.join(NEGATIVE_FIXTURE_DIR, "contract.minigame.json"), path.join(ws, "g.minigame.json"));
  const outputPath = path.join(ws, "reports", "minigame-verification.json");
  const run = async (quietNext: boolean): Promise<string> => {
    const lines: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
    try {
      await runVerifyMinigame({
        root: ws,
        contractPath: path.join(ws, "g.minigame.json"),
        capturesDir: NEGATIVE_FIXTURE_DIR, // real captures (grading inputs) live in the fixture
        outputPath,
        strict: false,
        quietNext,
      });
    } finally {
      console.error = orig;
    }
    return lines.join("\n");
  };
  try {
    const withFooter = await run(false);
    assert.match(withFooter, /👉 Next —/, "slim mode prints the resolved next-step footer when --output is the standard report path");
    // When the footer prints, the verdict it carries ("Not ready: …") is enough — no redundant
    // standalone verdict line (keeps the standard-path output to the three minimal blocks).
    assert.doesNotMatch(withFooter, /NOT READY \(exit/, "footer present ⇒ no redundant safety-net verdict line");

    const suppressed = await run(true);
    // --quiet-next defers ALL trailing messaging to the caller (the run/check wrapper): no footer
    // AND no safety-net verdict line — the wrapper prints the single verdict+next itself.
    assert.doesNotMatch(suppressed, /👉 Next —/, "--quiet-next removes the footer (the run/check wrapper prints it instead)");
    assert.doesNotMatch(suppressed, /NOT READY \(exit/, "--quiet-next also defers the verdict line to the wrapper");
    // …but the scorecard + report link always survive.
    assert.match(suppressed, /📊 .* pass · .* fail/);
    assert.match(suppressed, /📄 Report: open/);
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
});

// ── Phase 4: summarize counts LOGICAL states, not state@device keys ─────────────────

test("Phase 4: summarize counts LOGICAL screens (strips @device); per-device multiplies CHECKS, not screens", () => {
  const pass = (id: string): GateReport =>
    makeGateReport("required-in-frame", [{ id: `required-in-frame.${id}`, expected: "visible", actual: "visible", status: "pass", detail: "ok" }]);
  // 2 logical states (start, active), each graded at 3 devices → 6 composite keys.
  const states: Record<string, GateReport[]> = {
    "start@d1": [pass("x")], "start@d2": [pass("x")], "start@d3": [pass("x")],
    "active@d1": [pass("x")], "active@d2": [pass("x")], "active@d3": [pass("x")],
  };
  const s = summarize(states);
  assert.equal(s.statesTotal, 2, "2 LOGICAL screens, not 6 state@device keys");
  assert.equal(s.statesGraded, 2, "both logical screens graded");
  assert.equal(s.checksTotal, 6, "checks DO multiply per device (one per composite key here)");
});

test("Phase 4: splitStateDevice splits <state>@<device>, and leaves a bare state alone", () => {
  assert.deepEqual(splitStateDevice("active@landscape-iphone"), { state: "active", deviceId: "landscape-iphone" });
  assert.deepEqual(splitStateDevice("start"), { state: "start" });
});

test("nextActionFor: the 'fix' list counts GROUPED distinct issues and EXCLUDES likely-background (not raw per-device checks)", () => {
  const dev = (id: string, label: string): MinigameDeviceTag => ({ id, label });
  const D = [dev("d1", "16:9"), dev("d2", "iPhone"), dev("d3", "Tall Android")];
  const safeArea = (d: MinigameDeviceTag): MinigameFinding => ({
    source: "gate", state: "active", gate: "safe-area", id: "safe-area.homeButton", detail: "home overflow", device: d,
    annotation: { rect: { x: 0.02, y: 0.84, width: 0.07, height: 0.12 }, viewport: { width: 1280, height: 720 }, overflow: { edge: "left", fraction: 0.02 }, locator: "/Canvas/HomeButton" },
  });
  // Real captures key the sweep check by the short object id; the full path lives in annotation.locator.
  const sweep = (objId: string, locator: string, d: MinigameDeviceTag): MinigameFinding => ({
    source: "gate", state: "active", gate: "safe-area-sweep", id: `safe-area-sweep.${objId}`, detail: "bleeds", device: d,
    annotation: { rect: { x: 0, y: 0, width: 0.1, height: 0.1 }, viewport: { width: 1280, height: 720 }, overflow: { edge: "top", fraction: 0.02 }, locator },
  });
  const blocking: MinigameFinding[] = [
    ...D.map(safeArea),                                                  // HUD control on 3 devices → ONE grouped issue
    sweep("scoreChip", "/Canvas/HUD/ScoreChip", D[0]),                  // lone HUD sweep (no candidate parent) → must-fix
    ...D.flatMap((d) => [                                               // decoration cluster → likely-background
      sweep("cloud1", "/Canvas/Background/Cloud1", d),
      sweep("cloud2", "/Canvas/Background/Cloud2", d),
    ]),
  ];
  const action = nextActionFor("fail", blocking, [], { captureAbsent: [] }, ["/Canvas/HomeButton"]);

  // The "fix" list names the real HUD controls ONCE each — Home Button counted once across 3 devices,
  // not 3× (the old raw count), and the decoration is NOT in it.
  assert.match(action, /fix Home Button, Score Chip \(see the report/, "grouped must-fix subjects, no per-device inflation, no background");
  assert.doesNotMatch(action, /\+\d+ more/, "no inflated +N more from raw per-device / background counting");
  // The background containers are still SUGGESTED for declaration (a separate clause, never 'fix').
  assert.match(action, /safeAreaBackground/, "the declare suggestion still appears");
  assert.match(action, /\/Canvas\/Background/, "names the background container to declare");
});
