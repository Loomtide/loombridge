/**
 * S6c-1 + S6c-2 — deterministic mini-game UI gate evaluators + standalone runner.
 *
 * S6c-1 checks: required-in-frame, safe-area, control-overlap, text-clipping,
 * console-clean. S6c-2 checks: tap-target-size (px→dp via canvasScaleFactor),
 * no-black-bars + render-frame (frame facts from <state>.png).
 *
 * POSITIVE: the real CountTheFruits S6b captures (4 states) are green for every
 * check EXCEPT tap-target-size, which honestly REFUSES because the S6b captures
 * predate the canvasScaleFactor density basis (wired live in S6c-3) — no fudge.
 * NEGATIVES: a crafted defect per check fails for the intended reason; missing /
 * malformed capture files and a missing <state>.png fail (refuse-on-absent).
 *
 * Style mirrors verification-gates.test.ts (node:test + node:assert/strict, source
 * fixtures resolved via import.meta.url since tsc does not copy them into dist).
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  computeFrameFacts,
  evaluateBackgroundFit,
  evaluateConsoleClean,
  evaluateControlOverlap,
  evaluateNoBlackBars,
  evaluateRenderFrame,
  evaluateRequiredInFrame,
  evaluateSafeArea,
  evaluateTapTargetSize,
  evaluateTextClipping,
  loadFrameFacts,
  runMinigameGates,
  type DecodedImage,
  type MinigameCaptureObject,
  type MinigameCaptureState,
  type MinigameFrameFacts,
} from "../../../../capabilities/minigame/index.js";
import type { GateReport } from "../../../../capabilities/verification/gates/types.js";
import { assertValidMinigameContract } from "../../../../capabilities/minigame/profiles/validator.js";
import { REPO_ROOT as REPO_ROOT_SUPPORT } from "../../../_support/paths.js";
import type {
  MinigameContainerBinding,
  MinigameContract,
  MinigameSafeAreas,
  MinigameState,
} from "../../../../capabilities/minigame/profiles/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURES_DIR = path.resolve(
  REPO_ROOT_SUPPORT,
  "mcp-server/src/__tests__/fixtures/minigame-count-the-fruits",
);
const FRAME_FIXTURES_DIR = path.resolve(
  REPO_ROOT_SUPPORT,
  "mcp-server/src/__tests__/fixtures/minigame-frame-facts",
);
// The CountTheFruits captures AFTER the builder's 9-slice + field-clear fix (S7).
const FIXED_FIXTURES_DIR = path.resolve(
  REPO_ROOT_SUPPORT,
  "mcp-server/src/__tests__/fixtures/minigame-count-the-fruits-fixed",
);

/** Clean frame facts (no border, full coverage) — a frame that fills the screen. */
const CLEAN_FRAME_FACTS: MinigameFrameFacts = {
  borderFraction: 0,
  uniformBorderFraction: 0,
  contentCoverage: 1,
  dominantBorderColor: { r: 120, g: 220, b: 180 },
};

// ── builders ────────────────────────────────────────────────────────────────────

/** The real CountTheFruits contract (matches the S6b capture fixtures). */
function countTheFruitsContract(): MinigameContract {
  const obj = (id: string) => ({ id, locator: `CountTheFruits:/HUD/${id}` });
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
    ].map(obj),
    states: [
      { id: "start", kind: "start", requiredInFrame: ["startButton"] },
      {
        id: "active",
        kind: "active",
        requiredInFrame: [
          "questionText",
          "answerButton0",
          "answerButton1",
          "answerButton2",
          "homeButton",
          "countChip",
          "progress",
        ],
      },
      {
        id: "success_reward",
        kind: "success_reward",
        requiredInFrame: ["endSummary", "endCard", "scoreText", "rewardStars", "replayButton"],
      },
      { id: "home_back", kind: "home_back", requiredInFrame: ["startButton"] },
    ],
    // Full-frame safe area: the real captures place some chrome flush to the edges
    // (countChip x≈0.019), which is by design — grade against the full frame.
    uiSafeAreas: { maxOverflowFraction: 0 },
    tapTargets: { minSizeDp: 96 },
    interactionFlow: { happyPath: ["start", "active", "success_reward", "home_back"] },
    artifactThresholds: {},
    checks: {
      deterministic: [
        "required-in-frame",
        "safe-area",
        "control-overlap",
        "text-clipping",
        "console-clean",
        "tap-target-size",
        "no-black-bars",
        "render-frame",
        "interaction-flow",
      ],
    },
  };
}

/** A loose single-state contract for evaluator unit tests (not full-validated). */
function contractWith(
  states: MinigameState[],
  uiSafeAreas: MinigameSafeAreas = { maxOverflowFraction: 0 },
  deterministic: string[] = ["required-in-frame"],
  containers?: MinigameContainerBinding[],
): MinigameContract {
  return {
    schemaVersion: "1",
    id: "scratch",
    type: "2d-kids-minigame",
    scenes: ["Assets/Scenes/Scratch.unity"],
    ageBand: "3-5",
    visualProfile: "phone-landscape",
    requiredInFrame: [{ id: "x", locator: "Scratch:/x" }],
    states,
    uiSafeAreas,
    tapTargets: { minSizeDp: 96 },
    interactionFlow: { happyPath: states.map((s) => s.id) },
    artifactThresholds: {},
    containers,
    checks: { deterministic },
  } as MinigameContract;
}

/** Build an in-memory RGBA image; `paint(x,y)` returns [r,g,b] (top-left origin). */
function makeImage(
  width: number,
  height: number,
  paint: (x: number, y: number) => [number, number, number],
): DecodedImage {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = paint(x, y);
      const i = (y * width + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
  return { width, height, data };
}

const SKY: [number, number, number] = [150, 205, 240];
const WHITE: [number, number, number] = [255, 255, 255];

function mkState(
  stateId: string,
  objects: MinigameCaptureObject[],
  console: { errorCount: number } | undefined = { errorCount: 0 },
): MinigameCaptureState {
  return {
    state: stateId,
    viewport: { width: 1280, height: 720, aspect: 16 / 9 },
    objects,
    console,
  };
}

/** A visible, fully-in-frame object with sensible defaults. */
function visible(o: Partial<MinigameCaptureObject> & { id: string }): MinigameCaptureObject {
  return {
    path: `/HUD/${o.id}`,
    role: "image",
    active: true,
    isVisible: true,
    visibilityReason: null,
    isFullyVisible: true,
    isPartiallyClipped: false,
    screenRect: { x: 100, y: 100, width: 120, height: 120 },
    ...o,
  };
}

function reportFor(reports: GateReport[], gate: string): GateReport {
  const r = reports.find((x) => x.gate === gate);
  assert.ok(r, `expected a "${gate}" report; got: ${reports.map((x) => x.gate).join(", ")}`);
  return r;
}

// ── POSITIVE: real CountTheFruits captures are green ─────────────────────────────

test("the CountTheFruits contract is well-formed", () => {
  const result = assertValidMinigameContract(countTheFruitsContract());
  assert.equal(result.id, "count-the-fruits");
});

test("runMinigameGates: real CountTheFruits captures pass every check across 4 states EXCEPT tap-target (no density basis yet)", async () => {
  const verdict = await runMinigameGates(countTheFruitsContract(), FIXTURES_DIR);

  for (const stateId of ["start", "active", "success_reward", "home_back"]) {
    const reports = verdict.states[stateId];
    assert.ok(reports, `expected reports for state '${stateId}'`);
    // Substantive on every state (each binds objects / has a frame): these PASS.
    for (const gate of [
      "required-in-frame",
      "safe-area",
      "console-clean",
      "no-black-bars",
      "render-frame",
    ]) {
      assert.equal(reportFor(reports, gate).verdict, "pass", `${stateId}/${gate} should pass`);
    }
    // control-overlap / text-clipping are per-check vacuity-prone: on a state with
    // <2 interactive controls (start/home_back) or no required text object they are
    // NOT graded (not_applicable, never a vacuous pass) — but they must never FAIL.
    for (const gate of ["control-overlap", "text-clipping"]) {
      const v = reportFor(reports, gate).verdict;
      assert.ok(v === "pass" || v === "not_applicable", `${stateId}/${gate} should pass or be n/a, not ${v}`);
    }
    // interaction-flow is now a CROSS-state gate (S6d) — NOT emitted per state.
    assert.equal(reports.find((r) => r.gate === "interaction-flow"), undefined, `${stateId}/interaction-flow is graded at the flow level, not per-state`);
    // tap-target-size HONESTLY refuses: the S6b captures carry no canvasScaleFactor,
    // so the px→dp density basis is missing (captured live in S6c-3). This is the
    // real outcome, not a fudge — every state with a tap target refuses.
    const tap = reportFor(reports, "tap-target-size");
    assert.equal(tap.verdict, "fail", `${stateId}/tap-target-size should refuse (no canvasScaleFactor)`);
    assert.ok(
      tap.checks.some((c) => c.status === "fail" && /no canvasScaleFactor/.test(c.actual)),
      `${stateId}/tap-target-size should fail specifically on the absent density basis`,
    );
  }

  // The 'active' state genuinely GRADES control-overlap (3 answer buttons + home =
  // ≥2 interactive controls) and text-clipping (questionText is role:text) — proving
  // those gates substantively pass on real geometry, not merely via not_applicable.
  assert.equal(reportFor(verdict.states.active, "control-overlap").verdict, "pass");
  assert.equal(reportFor(verdict.states.active, "text-clipping").verdict, "pass");

  // Overall per-state verdict is fail, and the ONLY failing gate anywhere is tap-target-size.
  assert.equal(verdict.status, "fail");
  const failingGates = new Set(
    Object.values(verdict.states)
      .flat()
      .filter((r) => r.verdict === "fail")
      .map((r) => r.gate),
  );
  assert.deepEqual([...failingGates], ["tap-target-size"]);
  // The contract enables interaction-flow but there is no flow.json → missing_evidence (S6d).
  assert.equal(verdict.flow?.outcome, "missing_evidence");
  assert.deepEqual(verdict.captureAbsent, []);
});

test("runMinigameGates: with canvasScaleFactor present, the real CountTheFruits geometry passes tap-target — fully green", async () => {
  // The honest green: inject the density basis the S6b capture lacked. Mirror the
  // real active-state geometry (answer buttons 158×140px, home 142×108px) and a
  // Canvas scaleFactor of 1.0 (1280×720 == reference). The buttons are genuinely
  // large for a kids game — this is a real pass, not a forced one.
  const sf = 1.0;
  const contract = contractWith(
    [{ id: "active", kind: "active", requiredInFrame: ["answerButton0", "homeButton"] }],
    undefined,
    ["tap-target-size"],
  );
  const state = mkState("active", [
    visible({ id: "answerButton0", role: "image", raycastTarget: true, canvasScaleFactor: sf, screenRect: { x: 371, y: 21, width: 158, height: 140 } }),
    visible({ id: "homeButton", role: "image", raycastTarget: true, canvasScaleFactor: sf, screenRect: { x: 28, y: 28, width: 142, height: 108 } }),
  ]);
  const report = evaluateTapTargetSize(state, contract);
  assert.equal(report.verdict, "pass");
  // min edge 140px / 1.0 = 140dp ≥ 96dp; home 108px / 1.0 = 108dp ≥ 96dp.
  assert.ok(report.checks.some((c) => c.id === "tap-target-size.answerButton0" && c.status === "pass" && /140\.0dp/.test(c.actual)));
  assert.ok(report.checks.some((c) => c.id === "tap-target-size.homeButton" && c.status === "pass" && /108\.0dp/.test(c.actual)));
});

// ── NEGATIVE (a): a required id absent from the capture ──────────────────────────

test("required-in-frame: an absent required object FAILS (refuse-on-absent)", () => {
  const contract = contractWith([{ id: "s", kind: "active", requiredInFrame: ["ghost"] }]);
  const state = mkState("s", [visible({ id: "present" })]);
  const report = evaluateRequiredInFrame(state, contract);
  assert.equal(report.verdict, "fail");
  assert.ok(report.checks.some((c) => c.id === "required-in-frame.ghost" && c.status === "fail"));
});

// ── NEGATIVE (b): a required object inactive / not visible ───────────────────────

test("required-in-frame: an inactive required object FAILS", () => {
  const contract = contractWith([{ id: "s", kind: "active", requiredInFrame: ["btn"] }]);
  const state = mkState("s", [visible({ id: "btn", active: false, isVisible: false, visibilityReason: "inactive" })]);
  const report = evaluateRequiredInFrame(state, contract);
  assert.equal(report.verdict, "fail");
  assert.ok(report.checks.some((c) => c.id === "required-in-frame.btn" && c.status === "fail"));
});

test("required-in-frame: a not-fully-visible required object FAILS", () => {
  const contract = contractWith([{ id: "s", kind: "active", requiredInFrame: ["btn"] }]);
  const state = mkState("s", [visible({ id: "btn", isFullyVisible: false, clipSide: "top" })]);
  assert.equal(evaluateRequiredInFrame(state, contract).verdict, "fail");
});

// ── G8: sequential sub-screen objects downgrade to not_applicable (not a game FAIL) ─────────

test("required-in-frame (G8): an object the capture marks SEQUENTIAL downgrades to not_applicable, not fail", () => {
  // cook collapses Spray→Pour→Power: spray is shown, but never in the same frame as pour. A single-
  // frame "not visible" is a contract-granularity gap, not a game defect → not_applicable (the report
  // separately forces incomplete for the state, so this never launders into a pass).
  const contract = contractWith([{ id: "cook", kind: "active", requiredInFrame: ["spray", "pour", "power"] }]);
  const state = mkState("cook", [visible({ id: "spray" }), visible({ id: "power" })]); // pour absent this frame
  state.sequential = { missing: ["pour"] };
  const report = evaluateRequiredInFrame(state, contract);
  const pour = report.checks.find((c) => c.id === "required-in-frame.pour");
  assert.equal(pour?.status, "not_applicable", "a sequential-missing object is can't-verify, never a game fail");
  assert.match(pour?.detail ?? "", /sequential sub-screens|split/i);
  // A genuinely-absent object NOT marked sequential still FAILS (the downgrade is narrow).
  const contract2 = contractWith([{ id: "cook", kind: "active", requiredInFrame: ["spray", "ghost"] }]);
  const state2 = mkState("cook", [visible({ id: "spray" })]);
  state2.sequential = { missing: ["pour"] }; // ghost is NOT in the sequential set
  assert.ok(evaluateRequiredInFrame(state2, contract2).checks.some((c) => c.id === "required-in-frame.ghost" && c.status === "fail"));
});

// ── NEGATIVE (c): a text object partially clipped ────────────────────────────────

test("text-clipping: a partially-clipped required text object FAILS", () => {
  const contract = contractWith([{ id: "s", kind: "active", requiredInFrame: ["label"] }]);
  const state = mkState("s", [
    visible({ id: "label", role: "text", text: "Hi", isPartiallyClipped: true, clipSide: "right" }),
  ]);
  const report = evaluateTextClipping(state, contract);
  assert.equal(report.verdict, "fail");
  assert.ok(report.checks.some((c) => c.id === "text-clipping.label" && c.status === "fail"));
});

test("text-clipping: a state with no required text objects is NOT graded (not_applicable, never a vacuous pass)", () => {
  const contract = contractWith([{ id: "s", kind: "active", requiredInFrame: ["btn"] }]);
  const state = mkState("s", [visible({ id: "btn", role: "image" })]);
  assert.equal(evaluateTextClipping(state, contract).verdict, "not_applicable");
});

test("text-clipping: an absent required id FAILS (refuse-on-absent, not a silent role-filter drop)", () => {
  // Independent soundness: even with required-in-frame NOT co-enabled, text-clipping
  // must not let an absent required object slip through as a vacuous pass.
  const contract = contractWith(
    [{ id: "s", kind: "active", requiredInFrame: ["label"] }],
    undefined,
    ["text-clipping"],
  );
  const state = mkState("s", [visible({ id: "other", role: "text", text: "hi" })]);
  const report = evaluateTextClipping(state, contract);
  assert.equal(report.verdict, "fail");
  assert.ok(report.checks.some((c) => c.id === "text-clipping.label" && c.status === "fail"));
});

// ── NEGATIVE (d): two required controls overlap ──────────────────────────────────

test("control-overlap: two overlapping required interactive controls FAIL", () => {
  const contract = contractWith([{ id: "s", kind: "active", requiredInFrame: ["a", "b"] }]);
  const state = mkState("s", [
    visible({ id: "a", raycastTarget: true, screenRect: { x: 100, y: 100, width: 200, height: 100 } }),
    visible({ id: "b", raycastTarget: true, screenRect: { x: 250, y: 120, width: 200, height: 100 } }),
  ]);
  const report = evaluateControlOverlap(state, contract);
  assert.equal(report.verdict, "fail");
  assert.ok(report.checks.some((c) => c.id === "control-overlap.a~b" && c.status === "fail"));
});

test("control-overlap: disjoint required controls PASS; non-interactive overlap is ignored", () => {
  const contract = contractWith([{ id: "s", kind: "active", requiredInFrame: ["a", "b", "panel"] }]);
  const state = mkState("s", [
    visible({ id: "a", raycastTarget: true, screenRect: { x: 0, y: 0, width: 100, height: 100 } }),
    visible({ id: "b", raycastTarget: true, screenRect: { x: 200, y: 0, width: 100, height: 100 } }),
    // A non-interactive panel overlapping both controls must NOT trip the gate.
    visible({ id: "panel", raycastTarget: false, screenRect: { x: 0, y: 0, width: 400, height: 100 } }),
  ]);
  assert.equal(evaluateControlOverlap(state, contract).verdict, "pass");
});

test("control-overlap: an ancestor/backdrop stack (scrim ⊇ card ⊇ button, hierarchy paths) is EXEMPT", () => {
  const contract = contractWith([{ id: "s", kind: "active", requiredInFrame: ["scrim", "card", "btn"] }]);
  const state = mkState("s", [
    // Full-frame scrim, card inside it, button inside the card — and the PATHS are nested.
    visible({ id: "scrim", path: "/HUD/EndSummary", raycastTarget: true, screenRect: { x: 0, y: 0, width: 1280, height: 720 } }),
    visible({ id: "card", path: "/HUD/EndSummary/Card", raycastTarget: true, screenRect: { x: 340, y: 120, width: 600, height: 480 } }),
    visible({ id: "btn", path: "/HUD/EndSummary/Card/Replay", raycastTarget: true, screenRect: { x: 480, y: 126, width: 320, height: 104 } }),
  ]);
  // All three pairs are ancestor relationships → exempt; nothing else overlaps → pass.
  assert.equal(evaluateControlOverlap(state, contract).verdict, "pass");
});

test("control-overlap: an UNRELATED control fully containing another still FAILS (bare containment is not stacking)", () => {
  const contract = contractWith([{ id: "s", kind: "active", requiredInFrame: ["panelA", "panelB"] }]);
  const state = mkState("s", [
    // panelA fully contains panelB, but they are siblings in different subtrees and
    // panelA is NOT full-frame → this is a real hit-area collision, must FAIL.
    visible({ id: "panelA", path: "/HUD/PanelA", raycastTarget: true, screenRect: { x: 0, y: 0, width: 400, height: 400 } }),
    visible({ id: "panelB", path: "/HUD/PanelB", raycastTarget: true, screenRect: { x: 100, y: 100, width: 80, height: 80 } }),
  ]);
  const report = evaluateControlOverlap(state, contract);
  assert.equal(report.verdict, "fail");
  assert.ok(report.checks.some((c) => c.id === "control-overlap.panelA~panelB" && c.status === "fail"));
});

test("control-overlap: PARTIAL overlap between siblings still FAILS (containment exemption doesn't mask it)", () => {
  const contract = contractWith([{ id: "s", kind: "active", requiredInFrame: ["a", "b"] }]);
  const state = mkState("s", [
    // ~20% of the smaller rect overlaps — below the containment threshold → real collision.
    visible({ id: "a", raycastTarget: true, screenRect: { x: 100, y: 100, width: 200, height: 100 } }),
    visible({ id: "b", raycastTarget: true, screenRect: { x: 250, y: 120, width: 200, height: 100 } }),
  ]);
  assert.equal(evaluateControlOverlap(state, contract).verdict, "fail");
});

test("control-overlap: an absent required id FAILS (refuse-on-absent, not a silent drop)", () => {
  const contract = contractWith(
    [{ id: "s", kind: "active", requiredInFrame: ["a", "b"] }],
    undefined,
    ["control-overlap"],
  );
  // 'a' present and interactive, 'b' absent — the overlap check cannot clear 'b'.
  const state = mkState("s", [
    visible({ id: "a", raycastTarget: true, screenRect: { x: 0, y: 0, width: 100, height: 100 } }),
  ]);
  const report = evaluateControlOverlap(state, contract);
  assert.equal(report.verdict, "fail");
  assert.ok(report.checks.some((c) => c.id === "control-overlap.b" && c.status === "fail"));
});

// ── NEGATIVE (e): a required object outside the safe inset beyond tolerance ───────

test("safe-area: a required object outside the safe inset beyond maxOverflowFraction FAILS", () => {
  const contract = contractWith(
    [{ id: "s", kind: "active", requiredInFrame: ["panel"] }],
    { maxOverflowFraction: 0, insets: { left: 0.1 } },
  );
  const state = mkState("s", [
    visible({ id: "panel", viewportRect: { x: 0, y: 0.4, width: 0.2, height: 0.1 } }),
  ]);
  const report = evaluateSafeArea(state, contract);
  assert.equal(report.verdict, "fail");
  assert.ok(report.checks.some((c) => c.id === "safe-area.panel" && c.status === "fail"));
});

test("safe-area: an overflow within maxOverflowFraction tolerance PASSES", () => {
  const contract = contractWith(
    [{ id: "s", kind: "active", requiredInFrame: ["panel"] }],
    { maxOverflowFraction: 0.05, insets: { left: 0.1 } },
  );
  // Left edge 0.08 is 0.02 inside the 0.1 inset — within the 0.05 tolerance.
  const state = mkState("s", [
    visible({ id: "panel", viewportRect: { x: 0.08, y: 0.4, width: 0.2, height: 0.1 } }),
  ]);
  assert.equal(evaluateSafeArea(state, contract).verdict, "pass");
});

// ── NEGATIVE (f): console errorCount > 0 ─────────────────────────────────────────

test("console-clean: errorCount > 0 FAILS", () => {
  const contract = contractWith([{ id: "s", kind: "active" }], undefined, ["console-clean"]);
  const state = mkState("s", [], { errorCount: 2 });
  const report = evaluateConsoleClean(state, contract);
  assert.equal(report.verdict, "fail");
  assert.ok(report.checks.some((c) => c.status === "fail" && /2 errors/.test(c.actual)));
});

test("console-clean: an absent console summary FAILS (refuse-on-absent)", () => {
  const contract = contractWith([{ id: "s", kind: "active" }], undefined, ["console-clean"]);
  // Build the capture WITHOUT a `console` field (mkState's default would supply one).
  const state: MinigameCaptureState = {
    state: "s",
    viewport: { width: 1280, height: 720, aspect: 16 / 9 },
    objects: [],
  };
  assert.equal(evaluateConsoleClean(state, contract).verdict, "fail");
});

// ── NEGATIVE (g): a declared state with no capture file ──────────────────────────

test("runMinigameGates: a declared state with no capture file is captureAbsent (INCOMPLETE), not a game fail (S6d)", async () => {
  const contract = contractWith(
    [
      { id: "start", kind: "start", requiredInFrame: ["startButton"] },
      { id: "failure_timeout", kind: "failure_timeout", requiredInFrame: [] },
    ],
    undefined,
    ["required-in-frame", "console-clean"],
  );
  // requiredInFrame must declare 'startButton' so the 'start' state resolves.
  contract.requiredInFrame = [{ id: "startButton", locator: "CountTheFruits:/HUD/startButton" }];

  const verdict = await runMinigameGates(contract, FIXTURES_DIR);
  // start has a real capture → its gates pass.
  assert.equal(reportFor(verdict.states.start, "required-in-frame").verdict, "pass");
  // failure_timeout has NO capture → tracked in captureAbsent, surfaced as a NON-fail
  // not_applicable marker (a wholly-absent capture is a capture/harness gap, never a game fail).
  assert.deepEqual(verdict.captureAbsent, ["failure_timeout"]);
  const missing = verdict.states.failure_timeout;
  assert.equal(missing.length, 1);
  assert.equal(missing[0].gate, "minigame-capture");
  assert.equal(missing[0].verdict, "not_applicable");
});

test("runMinigameGates: a malformed (unparseable) capture file is captureAbsent (INCOMPLETE), not a fail, without crashing", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "minigame-gates-"));
  try {
    // A truncated/corrupt capture — must be captureAbsent (incomplete), never throw out of the runner.
    await fs.writeFile(path.join(dir, "s.ui-rects.json"), "{ this is not valid json ", "utf-8");
    const contract = contractWith(
      [{ id: "s", kind: "active", requiredInFrame: ["startButton"] }],
      undefined,
      ["required-in-frame", "console-clean"],
    );
    contract.requiredInFrame = [{ id: "startButton", locator: "CountTheFruits:/HUD/startButton" }];

    const verdict = await runMinigameGates(contract, dir);
    assert.deepEqual(verdict.captureAbsent, ["s"]);
    assert.equal(verdict.states.s.length, 1);
    assert.equal(verdict.states.s[0].gate, "minigame-capture");
    assert.equal(verdict.states.s[0].verdict, "not_applicable");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ── S6c-2: tap-target-size ───────────────────────────────────────────────────────

function tapContract(requiredInFrame: string[]): MinigameContract {
  return contractWith([{ id: "s", kind: "active", requiredInFrame }], undefined, ["tap-target-size"]);
}

test("tap-target-size (neg a): a tap target below the dp floor FAILS, and carries a tap-target annotation", () => {
  // 80px min edge ÷ scale 1.0 = 80dp < the 96dp floor.
  const state = mkState("s", [
    visible({ id: "small", role: "button", raycastTarget: true, canvasScaleFactor: 1.0, screenRect: { x: 10, y: 10, width: 80, height: 80 } }),
  ]);
  const report = evaluateTapTargetSize(state, tapContract(["small"]));
  assert.equal(report.verdict, "fail");
  const failed = report.checks.find((c) => c.id === "tap-target-size.small" && c.status === "fail");
  assert.ok(failed && /80\.0dp/.test(failed.actual));
  // The finding carries a TAP-TARGET annotation (rect + measured-vs-floor dp) so the report can
  // draw the size issue instead of a safe-area box. NOT a safe-area annotation (no safeInsets/overflow).
  assert.ok(failed!.annotation?.tapTarget, "fail carries a tapTarget annotation");
  assert.equal(failed!.annotation!.tapTarget!.minDp, 96);
  assert.ok(Math.abs(failed!.annotation!.tapTarget!.actualDp - 80) < 0.1, "actualDp ≈ 80");
  assert.equal(failed!.annotation!.safeInsets, undefined, "not a safe-area annotation");
  assert.equal(failed!.annotation!.overflow, undefined, "not a safe-area annotation");
});

test("tap-target-size (neg a'): a large scale factor shrinks dp below the floor", () => {
  // 140px ÷ scale 2.0 = 70dp < 96dp.
  const state = mkState("s", [
    visible({ id: "btn", role: "image", raycastTarget: true, canvasScaleFactor: 2.0, screenRect: { x: 10, y: 10, width: 158, height: 140 } }),
  ]);
  assert.equal(evaluateTapTargetSize(state, tapContract(["btn"])).verdict, "fail");
});

test("tap-target-size (neg b): an absent canvasScaleFactor REFUSES (no density basis assumed)", () => {
  const state = mkState("s", [
    visible({ id: "btn", role: "image", raycastTarget: true, screenRect: { x: 10, y: 10, width: 158, height: 140 } }),
  ]);
  const report = evaluateTapTargetSize(state, tapContract(["btn"]));
  assert.equal(report.verdict, "fail");
  assert.ok(report.checks.some((c) => c.id === "tap-target-size.btn" && /no canvasScaleFactor/.test(c.actual)));
});

test("tap-target-size: an absent required id FAILS (refuse-on-absent)", () => {
  const state = mkState("s", [visible({ id: "present", role: "button", raycastTarget: true, canvasScaleFactor: 1 })]);
  const report = evaluateTapTargetSize(state, tapContract(["ghost"]));
  assert.equal(report.verdict, "fail");
  assert.ok(report.checks.some((c) => c.id === "tap-target-size.ghost" && c.status === "fail"));
});

test("tap-target-size: non-tap-target required objects are not graded (text / non-raycast / full-frame backdrop)", () => {
  const state = mkState("s", [
    // role text → not a tap target
    visible({ id: "label", role: "text", text: "Hi", raycastTarget: true, canvasScaleFactor: 1, screenRect: { x: 0, y: 0, width: 40, height: 40 } }),
    // not raycastable → not a tap target
    visible({ id: "chip", role: "image", raycastTarget: false, canvasScaleFactor: 1, screenRect: { x: 0, y: 0, width: 40, height: 40 } }),
    // full-frame backdrop (area ≥ 0.9 frame) → excluded even though raycastable
    visible({ id: "backdrop", role: "image", raycastTarget: true, canvasScaleFactor: 1, screenRect: { x: 0, y: 0, width: 1280, height: 720 } }),
  ]);
  // None are graded tap targets → NOT graded (not_applicable, never a vacuous pass;
  // no refuse either, since all are present).
  const report = evaluateTapTargetSize(state, tapContract(["label", "chip", "backdrop"]));
  assert.equal(report.verdict, "not_applicable");
});

// ── S6c-2: no-black-bars ─────────────────────────────────────────────────────────

function aspectState(aspect: number): MinigameCaptureState {
  return { state: "s", viewport: { width: 1280, height: 1280 / aspect, aspect }, objects: [], console: { errorCount: 0 } };
}

test("no-black-bars: a clean full-frame capture with matching aspect PASSES", () => {
  const contract = contractWith([{ id: "s", kind: "active" }], undefined, ["no-black-bars"]);
  const report = evaluateNoBlackBars(aspectState(16 / 9), CLEAN_FRAME_FACTS, contract);
  assert.equal(report.verdict, "pass");
});

test("no-black-bars (neg c): a 4:3 viewport for a phone-landscape (16:9) contract FAILS the aspect check", () => {
  const contract = contractWith([{ id: "s", kind: "active" }], undefined, ["no-black-bars"]);
  const report = evaluateNoBlackBars(aspectState(4 / 3), CLEAN_FRAME_FACTS, contract);
  assert.equal(report.verdict, "fail");
  assert.ok(report.checks.some((c) => c.id === "no-black-bars.aspect.s" && c.status === "fail"));
});

test("no-black-bars (neg d): a dark border band FAILS the border check", async () => {
  const contract = contractWith([{ id: "s", kind: "active" }], undefined, ["no-black-bars"]);
  const facts = await loadFrameFacts(path.join(FRAME_FIXTURES_DIR, "black-bars.png"));
  const report = evaluateNoBlackBars(aspectState(16 / 9), facts, contract);
  assert.equal(report.verdict, "fail");
  assert.ok(report.checks.some((c) => c.id === "no-black-bars.border.s" && c.status === "fail"));
});

test("no-black-bars: absent frame facts REFUSE (missing/unreadable PNG)", () => {
  const contract = contractWith([{ id: "s", kind: "active" }], undefined, ["no-black-bars"]);
  const report = evaluateNoBlackBars(aspectState(16 / 9), null, contract);
  assert.equal(report.verdict, "fail");
  assert.ok(report.checks.some((c) => c.id === "no-black-bars.border.s" && /no frame facts/.test(c.actual)));
});

// ── S6c-2: render-frame ──────────────────────────────────────────────────────────

test("render-frame: a clean full-frame capture PASSES border + coverage", () => {
  const contract = contractWith([{ id: "s", kind: "active" }], undefined, ["render-frame"]);
  // minContentCoverage 0.85 per the reconciled contract thresholds.
  contract.artifactThresholds = { maxBorderFraction: 0.02, minContentCoverage: 0.85 };
  assert.equal(evaluateRenderFrame(mkState("s", []), CLEAN_FRAME_FACTS, contract).verdict, "pass");
});

test("render-frame (neg d): a border-band frame FAILS border + coverage", async () => {
  const contract = contractWith([{ id: "s", kind: "active" }], undefined, ["render-frame"]);
  contract.artifactThresholds = { maxBorderFraction: 0.02, minContentCoverage: 0.85 };
  const facts = await loadFrameFacts(path.join(FRAME_FIXTURES_DIR, "black-bars.png"));
  const report = evaluateRenderFrame(mkState("s", []), facts, contract);
  assert.equal(report.verdict, "fail");
  assert.ok(report.checks.some((c) => c.id === "render-frame.border.s" && c.status === "fail"));
  assert.ok(report.checks.some((c) => c.id === "render-frame.coverage.s" && c.status === "fail"));
});

test("render-frame: absent frame facts REFUSE", () => {
  const contract = contractWith([{ id: "s", kind: "active" }], undefined, ["render-frame"]);
  assert.equal(evaluateRenderFrame(mkState("s", []), null, contract).verdict, "fail");
});

// ── S6c-2: frame-facts producer ──────────────────────────────────────────────────

test("computeFrameFacts: a clean fill has no border and full coverage; a black-bar frame does not", async () => {
  const clean = await loadFrameFacts(path.join(FRAME_FIXTURES_DIR, "clean-fill.png"));
  assert.equal(clean.borderFraction, 0);
  assert.equal(clean.uniformBorderFraction, 0);
  assert.equal(clean.contentCoverage, 1);

  const bars = await loadFrameFacts(path.join(FRAME_FIXTURES_DIR, "black-bars.png"));
  assert.ok(bars.borderFraction > 0.02, `border ${bars.borderFraction}`);
  assert.ok(bars.uniformBorderFraction > 0.02, `uniform ${bars.uniformBorderFraction}`);
  assert.ok(bars.contentCoverage < 0.85, `coverage ${bars.contentCoverage}`);
  // dominant border colour is dark (a real letterbox), not the bright fill.
  const { r, g, b } = bars.dominantBorderColor;
  assert.ok(0.2126 * r + 0.7152 * g + 0.0722 * b < 120, `border luma ${0.2126 * r + 0.7152 * g + 0.0722 * b}`);
});

test("computeFrameFacts: a 0×0 image degrades to all-border / no-coverage (never a false clean)", () => {
  const facts = computeFrameFacts({ width: 0, height: 0, data: new Uint8Array(0) });
  assert.equal(facts.contentCoverage, 0);
  assert.equal(facts.borderFraction, 1);
});

// ── S6c-2 (neg e): a missing <state>.png fails both frame gates via the runner ─────

test("runMinigameGates: a missing <state>.png fails no-black-bars + render-frame (refuse-on-absent)", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "minigame-frame-"));
  try {
    // A valid ui-rects + console capture, but NO <state>.png.
    const uiRects = {
      state: "s",
      viewport: { width: 1280, height: 720, aspect: 16 / 9 },
      objects: [
        { id: "startButton", path: "/HUD/StartButton", role: "image", active: true, isVisible: true, visibilityReason: null, isFullyVisible: true, raycastTarget: true, screenRect: { x: 100, y: 100, width: 200, height: 120 } },
      ],
    };
    await fs.writeFile(path.join(dir, "s.ui-rects.json"), JSON.stringify(uiRects), "utf-8");
    await fs.writeFile(path.join(dir, "s.console.json"), JSON.stringify({ errorCount: 0 }), "utf-8");

    const contract = contractWith(
      [{ id: "s", kind: "active", requiredInFrame: ["startButton"] }],
      undefined,
      ["required-in-frame", "no-black-bars", "render-frame"],
    );
    contract.requiredInFrame = [{ id: "startButton", locator: "Scene:/HUD/StartButton" }];

    const verdict = await runMinigameGates(contract, dir);
    // required-in-frame still passes (ui-rects present); both frame gates refuse.
    assert.equal(reportFor(verdict.states.s, "required-in-frame").verdict, "pass");
    assert.equal(reportFor(verdict.states.s, "no-black-bars").verdict, "fail");
    assert.equal(reportFor(verdict.states.s, "render-frame").verdict, "fail");
    assert.equal(verdict.status, "fail");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ── background-fit (pixel-based) ──────────────────────────────────────────────────

/** A shown background card object covering a 100×100 image. */
function cardState(active = true): MinigameCaptureState {
  return mkState("s", [
    visible({ id: "card", role: "image", active, isVisible: active, screenRect: { x: 0, y: 0, width: 100, height: 100 } }),
  ]);
}
function fitContract(containers: MinigameContainerBinding[]): MinigameContract {
  return contractWith([{ id: "s", kind: "active" }], undefined, ["background-fit"], containers);
}

test("background-fit: a fill that covers its rect PASSES (BG envelops content)", () => {
  const image = makeImage(100, 100, () => WHITE);
  const report = evaluateBackgroundFit(cardState(), image, fitContract([{ background: "card" }]));
  assert.equal(report.verdict, "pass");
});

test("background-fit: a small fill on a mostly-bare rect FAILS (under-scaled BG, content on bare frame)", () => {
  // 30×30 white pill in a 100×100 sky rect → ~9% fill (< 60% floor) — the real defect shape.
  const image = makeImage(100, 100, (x, y) => (x >= 35 && x < 65 && y >= 35 && y < 65 ? WHITE : SKY));
  const report = evaluateBackgroundFit(cardState(), image, fitContract([{ background: "card" }]));
  assert.equal(report.verdict, "fail");
  assert.ok(report.checks.some((c) => c.id === "background-fit.card" && c.status === "fail"));
});

test("background-fit: a background not shown in this state is NOT graded (not_applicable, not a false pass)", () => {
  const image = makeImage(100, 100, () => SKY);
  const report = evaluateBackgroundFit(cardState(false), image, fitContract([{ background: "card" }]));
  assert.equal(report.verdict, "not_applicable");
});

test("background-fit: a shown background with no frame image REFUSES (refuse-on-absent)", () => {
  const report = evaluateBackgroundFit(cardState(), null, fitContract([{ background: "card" }]));
  assert.equal(report.verdict, "fail");
  assert.ok(report.checks.some((c) => c.id === "background-fit.card" && /no frame image/.test(c.actual)));
});

test("background-fit: a custom bgColor is honored", () => {
  const MINT: [number, number, number] = [120, 220, 180];
  const image = makeImage(100, 100, () => MINT);
  // Default white would read ~0% fill (FAIL); the declared mint reads 100% (PASS).
  assert.equal(evaluateBackgroundFit(cardState(), image, fitContract([{ background: "card" }])).verdict, "fail");
  assert.equal(
    evaluateBackgroundFit(cardState(), image, fitContract([{ background: "card", bgColor: "#78DCB4" }])).verdict,
    "pass",
  );
});

test("background-fit: visible content with an ABSENT background FAILS (locator/capture omission, not a silent skip)", () => {
  const state = mkState("s", [visible({ id: "label", role: "text", screenRect: { x: 10, y: 10, width: 40, height: 20 } })]);
  const report = evaluateBackgroundFit(state, null, fitContract([{ background: "card", content: ["label"] }]));
  assert.equal(report.verdict, "fail");
  assert.ok(report.checks.some((c) => c.id === "background-fit.card" && c.status === "fail" && /absent from capture/.test(c.actual)));
});

test("background-fit: visible content with a HIDDEN background FAILS (content on bare frame)", () => {
  const state = mkState("s", [
    visible({ id: "card", role: "image", active: false, isVisible: false, screenRect: { x: 0, y: 0, width: 100, height: 100 } }),
    visible({ id: "label", role: "text", screenRect: { x: 10, y: 10, width: 40, height: 20 } }),
  ]);
  const report = evaluateBackgroundFit(state, null, fitContract([{ background: "card", content: ["label"] }]));
  assert.equal(report.verdict, "fail");
  assert.ok(report.checks.some((c) => c.id === "background-fit.card" && /inactive\/hidden/.test(c.actual)));
});

test("background-fit: an absent background with NO visible content is not_applicable (legitimately not on screen)", () => {
  const state = mkState("s", []); // neither card nor its content present
  const report = evaluateBackgroundFit(state, null, fitContract([{ background: "card", content: ["label"] }]));
  assert.equal(report.verdict, "not_applicable");
});

// VERIFY-FIRST PROOF: the gate must FAIL on the CURRENT captures before any game fix.
function backgroundFitRealContract(): MinigameContract {
  const c = countTheFruitsContract();
  // The v1 pixel metric grades each background's own rect fill (content ids are
  // documentary), so bind the two white HUD cards as backgrounds.
  c.containers = [
    { background: "countChip", bgColor: "#FFFFFF" },
    { background: "progress", bgColor: "#FFFFFF" },
  ];
  c.checks = { deterministic: ["required-in-frame", "background-fit"] };
  return c;
}

test("background-fit: FAILS on the CURRENT CountTheFruits captures — white cards under-fill their rects (verify-first proof, pre-fix)", async () => {
  const contract = assertValidMinigameContract(backgroundFitRealContract());
  const verdict = await runMinigameGates(contract, FIXTURES_DIR);

  // active: countChip + progress ARE shown, but their white fill covers only ~31%
  // of their layout rects → FAIL (the real spill the screenshot shows).
  const active = reportFor(verdict.states.active, "background-fit");
  assert.equal(active.verdict, "fail");
  assert.ok(active.checks.some((c) => c.id === "background-fit.countChip" && c.status === "fail"));
  assert.ok(active.checks.some((c) => c.id === "background-fit.progress" && c.status === "fail"));

  // other states: the cards aren't on screen → not graded (never a false pass).
  for (const s of ["start", "success_reward", "home_back"]) {
    assert.equal(reportFor(verdict.states[s], "background-fit").verdict, "not_applicable");
  }
  assert.equal(verdict.status, "fail");
});

test("background-fit: PASSES on the FIXED CountTheFruits captures — 9-sliced cards now envelop their content (fix proof)", async () => {
  // Same contract, the post-fix captures: the white cards now fill their rects
  // (independently measured ~69% countChip / ~75% progress ≥ the 60% floor).
  const contract = assertValidMinigameContract(backgroundFitRealContract());
  const verdict = await runMinigameGates(contract, FIXED_FIXTURES_DIR);
  const active = reportFor(verdict.states.active, "background-fit");
  assert.equal(active.verdict, "pass");
  assert.ok(active.checks.every((c) => c.status === "pass"));
  for (const s of ["start", "success_reward", "home_back"]) {
    assert.equal(reportFor(verdict.states[s], "background-fit").verdict, "not_applicable");
  }
  assert.equal(verdict.status, "pass");
});

test("control-overlap: PASSES on the FIXED success_reward modal (backdrop exemption holds on the real capture)", async () => {
  // The fix made the EndSummary scrim + card raycast-blocking (correct modal UX);
  // the backdrop/containment exemption means the scrim-behind-card stacking is not
  // flagged as a collision. (Before the exemption this state failed with 5 pairs.)
  const c = countTheFruitsContract();
  c.checks = { deterministic: ["required-in-frame", "control-overlap"] };
  const verdict = await runMinigameGates(assertValidMinigameContract(c), FIXED_FIXTURES_DIR);
  assert.equal(reportFor(verdict.states.success_reward, "control-overlap").verdict, "pass");
  assert.equal(verdict.status, "pass");
});

// ── Phase 4: per-device grading ───────────────────────────────────────────────────

/** A 2-device override contract graded on `safe-area` + `required-in-frame`. */
function perDeviceContract(safeAreas: MinigameSafeAreas): MinigameContract {
  const c = contractWith(
    [{ id: "start", kind: "start", requiredInFrame: ["x"] }],
    safeAreas,
    ["required-in-frame", "safe-area"],
  );
  c.requiredInFrame = [{ id: "x", locator: "Scratch:/HUD/x" }];
  // A 2-device override so the per-device loop grades exactly two aspects. (Left
  // un-`assertValid`'d like the other gate-unit contracts — the runner needs no flow.)
  c.devices = [
    { id: "base-16x9", label: "16:9", width: 1280, height: 720 },
    { id: "tall-phone", label: "Tall phone (9:20)", width: 1080, height: 2400 },
  ];
  return c;
}

/** Write one `<state>@<device>.ui-rects.json` capture with a single object at `rect`. */
async function writePerDeviceRects(
  dir: string,
  stateId: string,
  deviceId: string,
  rect: { x: number; y: number; width: number; height: number },
): Promise<void> {
  const doc = {
    state: `${stateId}@${deviceId}`,
    viewport: { width: 1280, height: 720, aspect: 16 / 9 },
    objects: [visible({ id: "x", path: "/HUD/x", screenRect: rect })],
  };
  await fs.writeFile(
    path.join(dir, `${stateId}@${deviceId}.ui-rects.json`),
    JSON.stringify(doc, null, 2),
    "utf-8",
  );
}

// PIXEL rects in the 1280×720 viewport (the evaluator divides screenRect by the viewport).
// A centered rect is well inside any inset; a bottom-left-corner rect overflows a 0.1 inset
// (128px left / 72px bottom) on the left + bottom edges.
const INSIDE_RECT = { x: 512, y: 288, width: 128, height: 128 };
const CORNER_RECT = { x: 0, y: 0, width: 96, height: 48 };

test("runMinigameGates (Phase 4): a state is graded at EVERY device → N composite-key reports, none under the bare state", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "minigame-perdev-"));
  try {
    // Both devices: object well inside the frame → both pass.
    await writePerDeviceRects(dir, "start", "base-16x9", INSIDE_RECT);
    await writePerDeviceRects(dir, "start", "tall-phone", INSIDE_RECT);

    const verdict = await runMinigameGates(perDeviceContract({ maxOverflowFraction: 0 }), dir);

    // One report set per (state, device) composite key — and NO bare `start` key.
    assert.ok(verdict.states["start@base-16x9"], "graded at the base device");
    assert.ok(verdict.states["start@tall-phone"], "graded at the tall phone");
    assert.equal(verdict.states.start, undefined, "no bare-state key when a per-device pack is present");
    assert.equal(reportFor(verdict.states["start@base-16x9"], "safe-area").verdict, "pass");
    assert.equal(reportFor(verdict.states["start@tall-phone"], "safe-area").verdict, "pass");
    assert.equal(verdict.status, "pass");
    assert.deepEqual(verdict.captureAbsent, []);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("runMinigameGates (Phase 4): a safe-area fail at ONE device fails the build (aspect-dependent bug)", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "minigame-perdev-"));
  try {
    // Safe inset of 0.1 on every edge. The base device sits inside it; the tall-phone
    // capture pushes the object hard into the bottom-left corner so it overflows the inset.
    await writePerDeviceRects(dir, "start", "base-16x9", INSIDE_RECT);
    await writePerDeviceRects(dir, "start", "tall-phone", CORNER_RECT);

    const safeAreas: MinigameSafeAreas = {
      maxOverflowFraction: 0,
      insets: { top: 0.1, bottom: 0.1, left: 0.1, right: 0.1 },
    };
    const verdict = await runMinigameGates(perDeviceContract(safeAreas), dir);

    assert.equal(reportFor(verdict.states["start@base-16x9"], "safe-area").verdict, "pass", "base device is safe");
    assert.equal(reportFor(verdict.states["start@tall-phone"], "safe-area").verdict, "fail", "tall phone is unsafe");
    // A per-device fail at ANY device fails the overall verdict.
    assert.equal(verdict.status, "fail");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("runMinigameGates (Phase 4): a missing capture for ONE device is captureAbsent under its composite key (per-aspect harness gap)", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "minigame-perdev-"));
  try {
    // Base device present; the tall-phone aspect was never captured.
    await writePerDeviceRects(dir, "start", "base-16x9", INSIDE_RECT);

    const verdict = await runMinigameGates(perDeviceContract({ maxOverflowFraction: 0 }), dir);

    assert.equal(reportFor(verdict.states["start@base-16x9"], "safe-area").verdict, "pass");
    assert.deepEqual(verdict.captureAbsent, ["start@tall-phone"], "the missing aspect is captureAbsent per composite key");
    assert.equal(verdict.states["start@tall-phone"][0].gate, "minigame-capture");
    assert.equal(verdict.states["start@tall-phone"][0].verdict, "not_applicable");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("runMinigameGates (Phase 4): the device-INVARIANT base console is injected into EVERY per-device capture (console-clean passes, not a false fail per device)", async () => {
  // Regression for the per-device console bug: Phase 3 writes one device-invariant
  // `<state>.console.json`, never `<state>@<device>.console.json`. The per-device grading
  // loop loads each `<state>@<device>` capture whose `.console` (from the absent
  // `<state>@<device>.console.json`) is undefined; without injecting the logical base
  // console, the refuse-on-absent `console-clean` gate FAILED once per device.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "minigame-perdev-console-"));
  try {
    // Contract grades `console-clean` across a multi-device profile.
    const contract = perDeviceContract({ maxOverflowFraction: 0 });
    contract.checks = { deterministic: ["required-in-frame", "safe-area", "console-clean"] };

    // A faithful Phase 3 pack: per-device `<state>@<device>.ui-rects.json` for each device,
    // PLUS the base-device mirrors `<state>.ui-rects.json` + `<state>.console.json` (Phase 3
    // writes these too — see minigame-capture.ts). Crucially there is a SINGLE base-only
    // `<state>.console.json` (errorCount 0) and NO `<state>@<device>.console.json`.
    await writePerDeviceRects(dir, "start", "base-16x9", INSIDE_RECT);
    await writePerDeviceRects(dir, "start", "tall-phone", INSIDE_RECT);
    await fs.writeFile(
      path.join(dir, "start.ui-rects.json"),
      JSON.stringify({
        state: "start",
        viewport: { width: 1280, height: 720, aspect: 16 / 9 },
        objects: [visible({ id: "x", path: "/HUD/x", screenRect: INSIDE_RECT })],
      }),
      "utf-8",
    );
    await fs.writeFile(
      path.join(dir, "start.console.json"),
      JSON.stringify({ errorCount: 0 }),
      "utf-8",
    );

    const verdict = await runMinigameGates(contract, dir);

    // The base console is injected per device → console-clean PASSES at EVERY composite key
    // (before the fix this was a `fail` per device with "no console summary").
    for (const key of ["start@base-16x9", "start@tall-phone"]) {
      assert.ok(verdict.states[key], `graded at ${key}`);
      assert.equal(
        reportFor(verdict.states[key], "console-clean").verdict,
        "pass",
        `${key}/console-clean should pass (device-invariant base console injected)`,
      );
    }
    assert.equal(verdict.status, "pass");
    assert.deepEqual(verdict.captureAbsent, []);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("runMinigameGates (Phase 4): an OLD single-aspect pack (no @device files) falls back to the legacy <state> key", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "minigame-legacy-"));
  try {
    // No `<state>@<device>` files — only the legacy `<state>.ui-rects.json`.
    const doc = {
      state: "start",
      viewport: { width: 1280, height: 720, aspect: 16 / 9 },
      objects: [visible({ id: "x", path: "/HUD/x", screenRect: INSIDE_RECT })],
    };
    await fs.writeFile(path.join(dir, "start.ui-rects.json"), JSON.stringify(doc, null, 2), "utf-8");

    const verdict = await runMinigameGates(perDeviceContract({ maxOverflowFraction: 0 }), dir);

    // Graded once, under the bare `start` key — no per-device keys, no captureAbsent.
    assert.ok(verdict.states.start, "legacy fallback grades under the bare state key");
    assert.equal(verdict.states["start@base-16x9"], undefined);
    assert.equal(reportFor(verdict.states.start, "safe-area").verdict, "pass");
    assert.deepEqual(verdict.captureAbsent, []);
    assert.equal(verdict.status, "pass");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
