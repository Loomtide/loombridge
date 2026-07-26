/**
 * Shared mobile-touch gates (RCL-F03/RCL-F04) — the dimension-agnostic layer that
 * lets a 3D top-down build reuse the 2D minigame's safe-area-sweep + tap-target +
 * multi-aspect grading.
 *
 * These tests cover the SHARED module directly (`mobile-touch-gates.ts`) and the 3D
 * top-down entry point (`runTopDownTouchGates`). The companion proof that the 2D
 * minigame path is behavior-preserving lives in `minigame-safe-area-sweep.test.ts`
 * and `minigame-gates.test.ts` (both still green after the refactor) — that is the
 * "graded by the SAME shared gate" guarantee: the 2D evaluators now delegate here.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  gradeSafeAreaSweep,
  gradeTapTarget,
  resolveSafeBounds,
  runTopDownTouchGates,
  safeAreaOverflow,
  type SweepElement,
  type TopDownTouchCapture,
  type TopDownTouchElement,
} from "../../../../capabilities/verification/mobile-touch-gates.js";

// A phone-landscape-ish safe area: 5% top/bottom, 4% left/right, zero tolerance.
const INSETS = { top: 0.05, bottom: 0.05, left: 0.04, right: 0.04 };
const SAFE = resolveSafeBounds(INSETS);

// A rect poking into the TOP inset: top edge 0.97 > safeTop 0.95.
const POKES_TOP = { x: 0.4, y: 0.85, width: 0.12, height: 0.12 };
const INSIDE = { x: 0.4, y: 0.4, width: 0.1, height: 0.1 };

function sweepEl(o: Partial<SweepElement> & { id: string; rect: SweepElement["rect"] }): SweepElement {
  return { path: `/HUD/${o.id}`, role: "image", isVisible: true, ...o };
}

// ── primitive: safeAreaOverflow (the moved shared math) ───────────────────────────

test("safeAreaOverflow: per-edge magnitude + left→right→bottom→top tie-break", () => {
  assert.equal(safeAreaOverflow({ x: 0, y: 0.4, width: 0.02, height: 0.1 }, SAFE, 0).edge, "left");
  assert.ok(Math.abs(safeAreaOverflow(POKES_TOP, SAFE, 0).worst - 0.02) < 1e-9, "POKES_TOP overflows top by 0.02");
  assert.equal(safeAreaOverflow(INSIDE, SAFE, 0).worst, 0);
});

// ── (a) the shared safe-area sweep flags a HUD element outside the safe area ───────

test("(a) gradeSafeAreaSweep flags a HUD element outside the safe area (mirrors the 2D coverage)", () => {
  const result = gradeSafeAreaSweep([sweepEl({ id: "CountChip", rect: POKES_TOP })], { safe: SAFE, tol: 0 });
  assert.equal(result.flagged.length, 1);
  assert.equal(result.flagged[0].id, "CountChip");
  assert.equal(result.flagged[0].edge, "top");
  assert.ok(Math.abs(result.flagged[0].fraction - 0.02) < 1e-9);
});

test("gradeSafeAreaSweep: a full-bleed background is NOT flagged; an inside element passes", () => {
  const bg = gradeSafeAreaSweep([sweepEl({ id: "Backdrop", rect: { x: 0, y: 0, width: 1, height: 1 } })], { safe: SAFE, tol: 0 });
  assert.equal(bg.flagged.length, 0);
  assert.equal(bg.candidateCount, 0);
  const inside = gradeSafeAreaSweep([sweepEl({ id: "Chip", rect: INSIDE })], { safe: SAFE, tol: 0 });
  assert.equal(inside.flagged.length, 0);
  assert.equal(inside.candidateCount, 1);
});

test("gradeSafeAreaSweep: an interactive element declared background is STILL flagged (no silent control exempt)", () => {
  const result = gradeSafeAreaSweep(
    [
      sweepEl({ id: "Deco", path: "/Canvas/Background/Deco", raycastTarget: false, rect: POKES_TOP }),
      sweepEl({ id: "FireBtn", path: "/Canvas/Background/FireBtn", role: "button", raycastTarget: true, rect: POKES_TOP }),
    ],
    { safe: SAFE, tol: 0, isBackground: (el) => (el.path ?? "").startsWith("/Canvas/Background") },
  );
  const ids = result.flagged.map((f) => f.id);
  assert.deepEqual(ids, ["FireBtn"], "the control breaks the exemption; the decoration stays exempt");
  assert.equal(result.flagged[0].interactive, true);
  assert.deepEqual(result.backgroundExempt, ["Deco"]);
});

// ── (b) tap-target below min size fails ───────────────────────────────────────────

test("(b) gradeTapTarget: a tap target below the dp floor grades 'below'", () => {
  const frameArea = 1280 * 720;
  // 80px min edge ÷ scale 1.0 = 80dp < the 96dp floor.
  const grade = gradeTapTarget(
    { id: "small", role: "button", active: true, raycastTarget: true, screenRect: { x: 0, y: 0, width: 80, height: 120 }, canvasScaleFactor: 1 },
    frameArea,
    96,
  );
  assert.equal(grade.kind, "below");
  if (grade.kind === "below") assert.ok(Math.abs(grade.dp - 80) < 1e-9);
});

test("gradeTapTarget: a sufficiently large control grades 'ok'; a non-target is 'not-a-target'", () => {
  const frameArea = 1280 * 720;
  const ok = gradeTapTarget(
    { id: "big", role: "button", active: true, raycastTarget: true, screenRect: { x: 0, y: 0, width: 140, height: 140 }, canvasScaleFactor: 1 },
    frameArea,
    96,
  );
  assert.equal(ok.kind, "ok");
  // role:text is not a tap target.
  const nt = gradeTapTarget(
    { id: "label", role: "text", active: true, raycastTarget: true, screenRect: { x: 0, y: 0, width: 200, height: 40 }, canvasScaleFactor: 1 },
    frameArea,
    96,
  );
  assert.equal(nt.kind, "not-a-target");
});

test("gradeTapTarget: an absent canvasScaleFactor REFUSES (no density basis assumed)", () => {
  const grade = gradeTapTarget(
    { id: "btn", role: "button", active: true, raycastTarget: true, screenRect: { x: 0, y: 0, width: 140, height: 140 } },
    1280 * 720,
    96,
  );
  assert.equal(grade.kind, "no-scale-factor");
});

// ── helpers for the 3D top-down entry point ───────────────────────────────────────

const DEVICES = [
  { id: "landscape-16x9", label: "16:9", width: 1280, height: 720 },
  { id: "landscape-tall", label: "20:9", width: 2400, height: 1080 },
];

function tdEl(o: Partial<TopDownTouchElement> & { id: string }): TopDownTouchElement {
  return { path: `/HUD/${o.id}`, role: "button", active: true, isVisible: true, raycastTarget: true, ...o };
}

function capture(elements: TopDownTouchElement[], width = 1280, height = 720): TopDownTouchCapture {
  return { viewport: { width, height, aspect: width / height }, elements };
}

// ── (c) multi-aspect grading runs across device aspects ───────────────────────────

test("(c) runTopDownTouchGates grades the thumb layout across every device aspect", () => {
  // A FireButton that pokes into the top inset on both devices → flagged on each device.
  const fire = tdEl({ id: "FireButton", rect: POKES_TOP, screenRect: { x: 512, y: 612, width: 153, height: 86 }, canvasScaleFactor: 1 });
  const verdict = runTopDownTouchGates({
    safeArea: { insets: INSETS, maxOverflowFraction: 0 },
    tapTargets: { minSizeDp: 96 },
    devices: DEVICES,
    capturesByDevice: {
      "landscape-16x9": capture([fire], 1280, 720),
      "landscape-tall": capture([fire], 2400, 1080),
    },
  });
  assert.equal(verdict.blocked, false);
  assert.deepEqual(verdict.gradedDevices.sort(), ["landscape-16x9", "landscape-tall"]);
  // Each device produced a safe-area-sweep report that flagged FireButton on the top edge.
  for (const dev of DEVICES) {
    const sweep = verdict.reports[dev.id].find((r) => r.gate === "safe-area-sweep");
    assert.ok(sweep, `${dev.id} has a sweep report`);
    assert.equal(sweep!.verdict, "fail", `${dev.id} sweep fails`);
    assert.ok(sweep!.checks.some((c) => c.id === "safe-area-sweep.FireButton" && c.status === "fail"));
  }
  assert.equal(verdict.status, "fail");
});

// ── (d) a 3D top-down HUD is graded by the SAME shared gate ────────────────────────

test("(d) a 3D top-down thumb layout is graded by the SAME shared safe-area + tap-target gates", () => {
  // A thumb layout: a move stick safely inside, plus an undersized reload button.
  const moveStick = tdEl({ id: "MoveStick", rect: { x: 0.06, y: 0.1, width: 0.18, height: 0.32 }, screenRect: { x: 76, y: 72, width: 230, height: 230 }, canvasScaleFactor: 1 });
  // ReloadButton: 70px ÷ scale 1.0 = 70dp < 96dp floor → tap-target fail.
  const reload = tdEl({ id: "ReloadButton", rect: { x: 0.8, y: 0.1, width: 0.1, height: 0.1 }, screenRect: { x: 1024, y: 72, width: 70, height: 70 }, canvasScaleFactor: 1 });
  const verdict = runTopDownTouchGates({
    safeArea: { insets: INSETS, maxOverflowFraction: 0 },
    tapTargets: { minSizeDp: 96 },
    devices: [DEVICES[0]],
    capturesByDevice: { "landscape-16x9": capture([moveStick, reload], 1280, 720) },
  });
  assert.equal(verdict.blocked, false);
  const tap = verdict.reports["landscape-16x9"].find((r) => r.gate === "tap-target-size");
  assert.ok(tap, "the 3D path produced a tap-target report");
  // Same gate, same finding shape as the 2D path: a 70.0dp control below the floor.
  const fail = tap!.checks.find((c) => c.id === "tap-target-size.ReloadButton");
  assert.ok(fail && fail.status === "fail", "the undersized reload button fails");
  assert.ok(/70\.0dp/.test(fail!.actual), "px→dp conversion matches the shared 2D math");
  assert.equal(fail!.annotation?.tapTarget?.minDp, 96);
  // The safely-placed, well-sized move stick passes its tap-target check.
  assert.ok(tap!.checks.some((c) => c.id === "tap-target-size.MoveStick" && c.status === "pass"));
  assert.equal(verdict.status, "fail");
});

test("(d') a clean 3D thumb layout (inside + well-sized) is GREEN across the shared gates", () => {
  const moveStick = tdEl({ id: "MoveStick", rect: { x: 0.06, y: 0.1, width: 0.18, height: 0.32 }, screenRect: { x: 76, y: 72, width: 230, height: 230 }, canvasScaleFactor: 1 });
  const fire = tdEl({ id: "FireButton", rect: { x: 0.78, y: 0.12, width: 0.14, height: 0.25 }, screenRect: { x: 998, y: 86, width: 180, height: 180 }, canvasScaleFactor: 1 });
  const verdict = runTopDownTouchGates({
    safeArea: { insets: INSETS, maxOverflowFraction: 0 },
    tapTargets: { minSizeDp: 96 },
    devices: [DEVICES[0]],
    capturesByDevice: { "landscape-16x9": capture([moveStick, fire], 1280, 720) },
  });
  assert.equal(verdict.blocked, false);
  assert.equal(verdict.status, "pass");
});

// ── (e) absent touch/HUD capture → REFUSE, never a silent pass ─────────────────────

test("(e) no device aspects declared → BLOCKED (unsupported), never a pass", () => {
  const verdict = runTopDownTouchGates({ devices: [], capturesByDevice: {} });
  assert.equal(verdict.blocked, true);
  assert.notEqual(verdict.status, "pass");
  assert.ok(verdict.reports["__unsupported__"][0].checks[0].detail.includes("never a silent pass"));
});

test("(e') a device with NO capture is a refuse marker, never a pass", () => {
  const verdict = runTopDownTouchGates({
    safeArea: { insets: INSETS },
    devices: DEVICES,
    // Only one device captured; the other is absent.
    capturesByDevice: { "landscape-16x9": capture([tdEl({ id: "Fire", rect: INSIDE, screenRect: { x: 0, y: 0, width: 200, height: 200 }, canvasScaleFactor: 1 })]) },
  });
  assert.deepEqual(verdict.absentDevices, ["landscape-tall"]);
  const absent = verdict.reports["landscape-tall"][0];
  assert.equal(absent.verdict, "not_applicable");
  assert.ok(absent.checks[0].detail.includes("refuse-on-absent"));
  assert.ok(!absent.checks.some((c) => c.status === "pass"), "an absent device never reports a pass");
});

test("(e'') ALL devices absent → BLOCKED; an empty-HUD capture is also a refuse, never a pass", () => {
  const verdict = runTopDownTouchGates({
    safeArea: { insets: INSETS },
    devices: DEVICES,
    capturesByDevice: {
      "landscape-16x9": null, // no capture
      "landscape-tall": capture([]), // capture present but no HUD elements
    },
  });
  assert.equal(verdict.blocked, true);
  assert.notEqual(verdict.status, "pass");
  assert.deepEqual(verdict.gradedDevices, []);
  assert.deepEqual(verdict.absentDevices.sort(), ["landscape-16x9", "landscape-tall"]);
});
