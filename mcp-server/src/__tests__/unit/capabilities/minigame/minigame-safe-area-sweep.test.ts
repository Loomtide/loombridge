/**
 * Phase 1 — `safe-area-sweep` deterministic gate.
 *
 * The sweep grades EVERY visible rendered uGUI element against the safe area, not
 * just the contract's `requiredInFrame`. It catches HUD chrome (a score chip, a star
 * row) that sits in the unsafe margin even though it was never declared a required
 * object. Only full-frame backgrounds (and an explicit `safeAreaExempt` list) may
 * bleed past the safe area.
 *
 * Style mirrors minigame-gates.test.ts (node:test + node:assert/strict, hand-built
 * MinigameCaptureState fixtures). A CountFruits-shaped frame: viewport 1280×720,
 * insets top/bottom 0.05, left/right 0.04, tol 0.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateSafeAreaSweep,
  safeAreaOverflow,
  type MinigameCaptureObject,
  type MinigameCaptureState,
} from "../../../../capabilities/minigame/index.js";
import type { MinigameContract, MinigameState } from "../../../../capabilities/minigame/profiles/types.js";

// CountFruits-shaped safe area: 5% top/bottom, 4% left/right, zero tolerance.
const INSETS = { top: 0.05, bottom: 0.05, left: 0.04, right: 0.04 };

/** A single-state CountFruits-shaped contract for sweep unit tests. */
function sweepContract(
  requiredInFrame: string[] = [],
  safeAreaExempt?: string[],
  safeAreaBackground?: string[],
): MinigameContract {
  const states: MinigameState[] = [{ id: "active", kind: "active", requiredInFrame }];
  return {
    schemaVersion: "1",
    id: "count-fruits",
    type: "2d-kids-minigame",
    scenes: ["Assets/Scenes/CountFruits.unity"],
    ageBand: "3-5",
    visualProfile: "phone-landscape",
    requiredInFrame: requiredInFrame.map((id) => ({ id, locator: `CountFruits:/HUD/${id}` })),
    states,
    uiSafeAreas: { maxOverflowFraction: 0, insets: INSETS },
    tapTargets: { minSizeDp: 96 },
    interactionFlow: { happyPath: ["active"] },
    artifactThresholds: {},
    ...(safeAreaExempt ? { safeAreaExempt } : {}),
    ...(safeAreaBackground ? { safeAreaBackground } : {}),
    checks: { deterministic: ["safe-area-sweep"] },
  } as MinigameContract;
}

/** A visible HUD element with a normalized viewportRect (bottom-left origin). */
function el(o: Partial<MinigameCaptureObject> & { id: string; viewportRect: MinigameCaptureObject["viewportRect"] }): MinigameCaptureObject {
  return {
    path: `/HUD/${o.id}`,
    role: "image",
    active: true,
    isVisible: true,
    visibilityReason: null,
    isFullyVisible: true,
    isPartiallyClipped: false,
    screenRect: { x: 0, y: 0, width: 1, height: 1 },
    ...o,
  };
}

function state(objects: MinigameCaptureObject[]): MinigameCaptureState {
  return { state: "active", viewport: { width: 1280, height: 720, aspect: 16 / 9 }, objects };
}

// A rect that pokes into the TOP inset: top edge at 0.97 > safeTop (1 - 0.05 = 0.95).
const POKES_TOP = { x: 0.4, y: 0.85, width: 0.12, height: 0.12 };
// A rect fully inside the safe area.
const INSIDE = { x: 0.4, y: 0.4, width: 0.1, height: 0.1 };

// ── 0. the shared overflow helper (locks the extraction reused by safe-area + sweep) ──

test("safeAreaOverflow: each edge + the left→right→bottom→top tie-break", () => {
  const safe = { left: 0.04, right: 0.96, bottom: 0.05, top: 0.95 };
  const expect = (rect: { x: number; y: number; width: number; height: number }, edge: string, worst: number) => {
    const r = safeAreaOverflow(rect, safe, 0);
    assert.equal(r.edge, edge);
    assert.ok(Math.abs(r.worst - worst) < 1e-9, `worst ${r.worst} ≈ ${worst}`);
  };
  expect({ x: 0.0, y: 0.4, width: 0.02, height: 0.1 }, "left", 0.04);
  expect({ x: 0.97, y: 0.4, width: 0.02, height: 0.1 }, "right", 0.03);
  expect({ x: 0.4, y: 0.0, width: 0.1, height: 0.02 }, "bottom", 0.05);
  expect({ x: 0.4, y: 0.9, width: 0.1, height: 0.08 }, "top", 0.03);
  assert.equal(safeAreaOverflow({ x: 0.4, y: 0.4, width: 0.1, height: 0.1 }, safe, 0).worst, 0);
  // An EQUAL left/bottom overflow (both 0.04) resolves to the EARLIER edge (left).
  expect({ x: 0.0, y: 0.01, width: 0.02, height: 0.02 }, "left", 0.04);
});

// ── 1. HUD overflow is caught ─────────────────────────────────────────────────────

test("safe-area-sweep: a visible image HUD chip poking into the top inset is FLAGGED on the top edge", () => {
  const report = evaluateSafeAreaSweep(
    state([el({ id: "CountChip", role: "image", viewportRect: POKES_TOP })]),
    sweepContract(),
  );
  assert.equal(report.verdict, "fail");
  const c = report.checks.find((x) => x.id === "safe-area-sweep.CountChip");
  assert.ok(c && c.status === "fail", "CountChip should be flagged");
  assert.equal(c!.annotation?.overflow?.edge, "top");
  // POKES_TOP top edge 0.97 vs safeTop 0.95 → the drawn/reported magnitude must be 0.02.
  assert.ok(Math.abs((c!.annotation!.overflow!.fraction) - 0.02) < 1e-9, "overflow fraction is the true poke-out");
});

test("safe-area-sweep: a role:button and a role:graphic in the unsafe margin are BOTH swept (rendered roles)", () => {
  const report = evaluateSafeAreaSweep(
    state([
      el({ id: "homeBtn", role: "button", viewportRect: POKES_TOP }),
      el({ id: "maskFx", role: "graphic", viewportRect: POKES_TOP }),
    ]),
    sweepContract(),
  );
  assert.ok(report.checks.some((c) => c.id === "safe-area-sweep.homeBtn" && c.status === "fail"), "button is swept");
  assert.ok(report.checks.some((c) => c.id === "safe-area-sweep.maskFx" && c.status === "fail"), "graphic is swept");
});

test("safe-area-sweep: a visible text element poking into the top inset is FLAGGED", () => {
  const report = evaluateSafeAreaSweep(
    state([el({ id: "scoreText", role: "text", viewportRect: POKES_TOP })]),
    sweepContract(),
  );
  assert.equal(report.verdict, "fail");
  assert.ok(report.checks.some((c) => c.id === "safe-area-sweep.scoreText" && c.status === "fail"));
});

// ── 2. A full-frame backdrop is exempt ────────────────────────────────────────────

test("safe-area-sweep: a full-bleed backdrop (reaches all edges, even exceeding) is NOT flagged", () => {
  for (const bg of [{ x: 0, y: 0, width: 1, height: 1 }, { x: -0.1, y: -0.1, width: 1.2, height: 1.2 }]) {
    const report = evaluateSafeAreaSweep(state([el({ id: "Backdrop", role: "image", viewportRect: bg })]), sweepContract());
    assert.equal(report.verdict, "not_applicable", `bg ${JSON.stringify(bg)} exempt`);
    assert.ok(!report.checks.some((c) => c.id === "safe-area-sweep.Backdrop"));
  }
});

test("safe-area-sweep: backdrop exemption is EDGE-reach, not area — area-≥0.85 non-backgrounds are still swept", () => {
  // A 0.95x0.95 panel anchored bottom-left: AREA 0.9 (≥ the old 0.85 threshold → would have been wrongly
  // exempted) but it does NOT reach the right/top edges → not a full-bleed background → swept.
  const modal = evaluateSafeAreaSweep(
    state([el({ id: "Modal", role: "image", viewportRect: { x: 0, y: 0, width: 0.95, height: 0.95 } })]),
    sweepContract(),
  );
  assert.ok(modal.checks.some((c) => c.id === "safe-area-sweep.Modal" && c.status === "fail"), "0.9-area non-full-bleed panel is swept");
  // A NARROW rail bleeding far past top+bottom: UNCLAMPED area 0.5*1.8 = 0.9 (≥0.85 → old test exempts it,
  // the very bleed being the defect) but it reaches top/bottom only, NOT left/right → swept.
  const bleeder = evaluateSafeAreaSweep(
    state([el({ id: "Rail", role: "image", viewportRect: { x: 0.25, y: -0.4, width: 0.5, height: 1.8 } })]),
    sweepContract(),
  );
  assert.ok(bleeder.checks.some((c) => c.id === "safe-area-sweep.Rail" && c.status === "fail"), "a tall narrow bleeder is not a backdrop");
});

// ── 3. A pure container is skipped ────────────────────────────────────────────────

test("safe-area-sweep: a role:container overflowing is NOT flagged (no Graphic to render)", () => {
  const report = evaluateSafeAreaSweep(
    state([el({ id: "HUD", role: "container", viewportRect: POKES_TOP })]),
    sweepContract(),
  );
  assert.equal(report.verdict, "not_applicable");
  assert.ok(!report.checks.some((c) => c.id === "safe-area-sweep.HUD"));
});

// ── 4. requiredInFrame objects are owned by `safe-area`, not double-reported ───────

test("safe-area-sweep: an object IN this state's requiredInFrame is NOT in the sweep findings (safe-area owns it)", () => {
  const report = evaluateSafeAreaSweep(
    state([el({ id: "homeButton", role: "image", viewportRect: POKES_TOP })]),
    sweepContract(["homeButton"]),
  );
  assert.ok(!report.checks.some((c) => c.id === "safe-area-sweep.homeButton"));
  // It was the only object → no other candidate → not graded.
  assert.equal(report.verdict, "not_applicable");
});

test("safe-area-sweep: a child INSIDE a requiredInFrame widget is skipped too (safe-area owns the whole widget)", () => {
  const report = evaluateSafeAreaSweep(
    state([
      el({ id: "homeButton", path: "/HUD/homeButton", role: "image", viewportRect: POKES_TOP }),
      el({ id: "homeButtonIcon", path: "/HUD/homeButton/Icon", role: "image", viewportRect: POKES_TOP }),
    ]),
    sweepContract(["homeButton"]),
  );
  // The icon child must NOT be a separate sweep finding (safe-area already reports homeButton).
  assert.ok(!report.checks.some((c) => c.status === "fail"), "no sweep fail for a required widget's child");
  assert.equal(report.verdict, "not_applicable");
});

// ── 5. Hierarchy dedup ────────────────────────────────────────────────────────────

test("safe-area-sweep: a flagged child overflowing the SAME edge as its flagged parent is suppressed (report the outermost only)", () => {
  const report = evaluateSafeAreaSweep(
    state([
      el({ id: "CountChip", path: "/HUD/CountChip", role: "image", viewportRect: POKES_TOP }),
      el({ id: "Basket", path: "/HUD/CountChip/Basket", role: "image", viewportRect: POKES_TOP }),
    ]),
    sweepContract(),
  );
  assert.equal(report.verdict, "fail");
  const ids = report.checks.filter((c) => c.status === "fail").map((c) => c.id);
  assert.deepEqual(ids, ["safe-area-sweep.CountChip"], "only the outermost widget is reported");
});

// ── 6. Explicit exempt list ───────────────────────────────────────────────────────

test("safe-area-sweep: an exempt (by path) element that WOULD fail is WAIVED + surfaced, never a silent fail", () => {
  const report = evaluateSafeAreaSweep(
    state([el({ id: "CountChip", path: "/HUD/CountChip", role: "image", viewportRect: POKES_TOP })]),
    sweepContract([], ["/HUD/CountChip"]),
  );
  // Not a failure (the exemption holds) ...
  assert.ok(!report.checks.some((c) => c.status === "fail"), "exempt element is not a fail");
  // ... but it IS surfaced as a visible na note so the exemption can never silently green a real overflow.
  const waived = report.checks.find((c) => c.id === "safe-area-sweep.CountChip");
  assert.ok(waived && waived.status === "not_applicable", "exempt overflow surfaced as na");
  assert.match(waived.detail, /waived by .*safeAreaExempt/i);
});

test("safe-area-sweep: an exempt (by id) element that WOULD fail is waived + surfaced", () => {
  const report = evaluateSafeAreaSweep(
    state([el({ id: "CountChip", role: "image", viewportRect: POKES_TOP })]),
    sweepContract([], ["CountChip"]),
  );
  assert.ok(!report.checks.some((c) => c.status === "fail"));
  assert.ok(report.checks.some((c) => c.id === "safe-area-sweep.CountChip" && c.status === "not_applicable"));
});

test("safe-area-sweep: an exempt element that's INSIDE the safe area is fully skipped (no waived note)", () => {
  const report = evaluateSafeAreaSweep(
    state([el({ id: "CountChip", role: "image", viewportRect: INSIDE })]),
    sweepContract([], ["CountChip"]),
  );
  assert.equal(report.verdict, "not_applicable"); // sole element exempt + inside → nothing to grade
  assert.ok(!report.checks.some((c) => c.id === "safe-area-sweep.CountChip"));
});

// ── 6b. safeAreaBackground: declared decorative subtrees are SILENTLY exempt ────────

test("safe-area-sweep: a safeAreaBackground ANCESTOR exempts every descendant SILENTLY (no fail, no waived)", () => {
  const report = evaluateSafeAreaSweep(
    state([
      el({ id: "Sky", path: "/Canvas/Background/Sky", role: "image", viewportRect: POKES_TOP }),
      el({ id: "Cloud3", path: "/Canvas/Background/Cloud3", role: "image", viewportRect: POKES_TOP }),
      el({ id: "Hill", path: "/Canvas/Background/HillFar", role: "image", viewportRect: POKES_TOP }),
    ]),
    sweepContract([], undefined, ["/Canvas/Background"]),
  );
  assert.equal(report.verdict, "not_applicable", "all declared decoration → nothing graded");
  assert.ok(!report.checks.some((c) => c.status === "fail"), "decoration is not a fail");
  // Silent — unlike safeAreaExempt, declared background does NOT surface a waived note per element.
  assert.ok(!report.checks.some((c) => /Background/.test(c.id) && c.status === "not_applicable" && /waived/i.test(c.detail ?? "")));
});

test("safe-area-sweep: an INTERACTIVE (raycastTarget) element is FLAGGED even when safeAreaBackground covers it — a control is never silently exempted", () => {
  // The false-green guard: declaring a tappable control (or a container over it) as background must
  // NOT silently exempt it — that's the one verdict-level false green a persisted/hand-edited
  // safeAreaBackground could create. A decorative (raycast-off) sibling under the SAME declared
  // container stays exempt; only the interactive one is graded.
  const report = evaluateSafeAreaSweep(
    state([
      el({ id: "Cloud3", path: "/Canvas/Background/Cloud3", role: "image", raycastTarget: false, viewportRect: POKES_TOP }), // decoration → exempt
      el({ id: "PlayButton", path: "/Canvas/Background/PlayButton", role: "button", raycastTarget: true, viewportRect: POKES_TOP }), // control → STILL flagged
    ]),
    sweepContract([], undefined, ["/Canvas/Background"]),
  );
  assert.equal(report.verdict, "fail", "the interactive control breaks the clean pass");
  const ctrl = report.checks.find((c) => c.id === "safe-area-sweep.PlayButton");
  assert.ok(ctrl && ctrl.status === "fail", "an interactive control declared as background is still flagged");
  assert.equal(ctrl!.annotation?.interactive, true);
  assert.ok(!report.checks.some((c) => c.id === "safe-area-sweep.Cloud3" && c.status === "fail"), "the decorative sibling stays exempt");
});

test("safe-area-sweep: a trailing-* glob exempts bracketed sibling decoration (/Canvas/Sparkle[0]…)", () => {
  const report = evaluateSafeAreaSweep(
    state([
      el({ id: "Sparkle0", path: "/Canvas/Sparkle[0]", role: "image", viewportRect: POKES_TOP }),
      el({ id: "Sparkle4", path: "/Canvas/Sparkle[4]", role: "image", viewportRect: POKES_TOP }),
    ]),
    sweepContract([], undefined, ["/Canvas/Sparkle*"]),
  );
  assert.ok(!report.checks.some((c) => c.status === "fail"), "globbed sparkles exempt");
});

test("safe-area-sweep: declared background does NOT leak to a real HUD element (the score chip is STILL caught)", () => {
  const report = evaluateSafeAreaSweep(
    state([
      el({ id: "Cloud3", path: "/Canvas/Background/Cloud3", role: "image", viewportRect: POKES_TOP }), // decoration → exempt
      el({ id: "CountChip", path: "/Canvas/HUD/CountChip", role: "image", viewportRect: POKES_TOP }), // HUD → still flagged
    ]),
    sweepContract([], undefined, ["/Canvas/Background"]),
  );
  assert.equal(report.verdict, "fail");
  const fails = report.checks.filter((c) => c.status === "fail").map((c) => c.id);
  assert.deepEqual(fails, ["safe-area-sweep.CountChip"], "only the HUD chip fails; the cloud is exempt");
});

test("safe-area-sweep: /Canvas/Background must NOT match /Canvas/BackgroundPanelHud (segment-safe ancestor)", () => {
  const report = evaluateSafeAreaSweep(
    state([el({ id: "Hud", path: "/Canvas/BackgroundPanelHud", role: "image", viewportRect: POKES_TOP })]),
    sweepContract([], undefined, ["/Canvas/Background"]),
  );
  assert.ok(report.checks.some((c) => c.id === "safe-area-sweep.Hud" && c.status === "fail"), "prefix-sibling is NOT exempt");
});

test("safe-area-sweep: a trailing-* glob is SEGMENT-SAFE — /Canvas/Score* exempts Score[0] but NOT the sibling HUD ScoreChip", () => {
  const report = evaluateSafeAreaSweep(
    state([
      el({ id: "Score0", path: "/Canvas/Score[0]", role: "image", viewportRect: POKES_TOP }), // bracket sibling → exempt
      el({ id: "ScoreSub", path: "/Canvas/Score/Glow", role: "image", viewportRect: POKES_TOP }), // sub-path → exempt
      el({ id: "ScoreChip", path: "/Canvas/ScoreChip", role: "image", viewportRect: POKES_TOP }), // SIBLING HUD → still caught
    ]),
    sweepContract([], undefined, ["/Canvas/Score*"]),
  );
  assert.equal(report.verdict, "fail");
  const fails = report.checks.filter((c) => c.status === "fail").map((c) => c.id);
  assert.deepEqual(fails, ["safe-area-sweep.ScoreChip"], "the raw-prefix sibling is NOT silently exempted by the glob");
});

test("safe-area-sweep: a too-broad safeAreaBackground that hides real overflows is NEVER silent (one summary na count)", () => {
  // `/Canvas` swallows the WHOLE HUD; both elements overflow. The gate must not return a clean,
  // signal-free not_applicable — it surfaces a single na count so the over-broad decl is visible.
  const report = evaluateSafeAreaSweep(
    state([
      el({ id: "Cloud3", path: "/Canvas/Background/Cloud3", role: "image", viewportRect: POKES_TOP }),
      el({ id: "CountChip", path: "/Canvas/HUD/CountChip", role: "image", viewportRect: POKES_TOP }),
    ]),
    sweepContract([], undefined, ["/Canvas"]),
  );
  assert.equal(report.verdict, "not_applicable", "all exempted → not graded, but…");
  const summary = report.checks.find((c) => c.id === "safe-area-sweep.active.background");
  assert.ok(summary && summary.status === "not_applicable", "a background summary note is surfaced");
  assert.ok(/2 .*element.* exempted/i.test(summary.detail ?? ""), "it counts the 2 hidden overflows");
  assert.ok(/safeAreaBackground/.test(summary.detail ?? ""), "it names the field so the dev sees the over-broad decl");
});

test("safe-area-sweep: declared background that's INSIDE the safe area emits NO summary note (nothing hidden)", () => {
  // Background decoration that does not overflow hides nothing → no count, no noise.
  const report = evaluateSafeAreaSweep(
    state([el({ id: "Cloud3", path: "/Canvas/Background/Cloud3", role: "image", viewportRect: INSIDE })]),
    sweepContract([], undefined, ["/Canvas/Background"]),
  );
  assert.ok(!report.checks.some((c) => c.id === "safe-area-sweep.active.background"), "no summary when nothing overflowed");
});

// ── 7. All inside → pass; no candidates → not_applicable ──────────────────────────

test("safe-area-sweep: every candidate inside the safe area → a single PASS", () => {
  const report = evaluateSafeAreaSweep(
    state([
      el({ id: "CountChip", role: "image", viewportRect: INSIDE }),
      el({ id: "scoreText", role: "text", viewportRect: { x: 0.6, y: 0.5, width: 0.1, height: 0.1 } }),
    ]),
    sweepContract(),
  );
  assert.equal(report.verdict, "pass");
  assert.equal(report.checks.length, 1);
  assert.equal(report.checks[0].id, "safe-area-sweep.active");
  assert.ok(/2 swept HUD/.test(report.checks[0].detail ?? report.checks[0].actual));
});

test("safe-area-sweep: no sweepable elements at all → not_applicable (never a vacuous pass)", () => {
  const report = evaluateSafeAreaSweep(state([]), sweepContract());
  assert.equal(report.verdict, "not_applicable");
  assert.equal(report.checks[0].id, "safe-area-sweep.active");
});

test("safe-area-sweep: an invisible element is not a candidate (skipped, not refused)", () => {
  const report = evaluateSafeAreaSweep(
    state([
      el({ id: "Hidden", role: "image", isVisible: false, viewportRect: POKES_TOP }),
    ]),
    sweepContract(),
  );
  assert.equal(report.verdict, "not_applicable");
});
