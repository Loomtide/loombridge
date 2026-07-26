import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateFraming,
  TRUSTED_PITCH_PRODUCER,
  type ScreenRectsResult,
} from "../capabilities/verification/gates/framing.js";
import type { GateCheck, GateReport } from "../capabilities/verification/gates/types.js";
import type { AcceptanceContract, PerspectiveFramingSection } from "../capabilities/verification/types.js";
import { validateAcceptanceContract } from "../capabilities/verification/validator.js";

function checkById(report: GateReport, id: string): GateCheck {
  const c = report.checks.find((x) => x.id === id);
  assert.ok(c, `expected a check with id "${id}" — got [${report.checks.map((x) => x.id).join(", ")}]`);
  return c;
}
function maybeCheck(report: GateReport, id: string): GateCheck | undefined {
  return report.checks.find((x) => x.id === id);
}

/** Minimal AcceptanceContract carrying just the framing the gate reads. */
function acceptanceWith(camera: PerspectiveFramingSection): AcceptanceContract {
  return {
    framing: {
      aspect: { w: 16, h: 9 },
      cameraMode: "static",
      camera,
      playerAnchor: { centerXFraction: 0.5, tolerance: 0.35 },
    },
  } as unknown as AcceptanceContract;
}

// A clean scene: a centered player (static camera → informational pass), plus the
// captured camera + viewport aspect the perspective branch reads.
function rects(camera: ScreenRectsResult["camera"], aspect = 16 / 9): ScreenRectsResult {
  return {
    camera,
    viewport: { width: 1920, height: 1080, aspect },
    objects: [{ name: "player", centerXFraction: 0.5, isPartiallyClipped: false }],
  };
}

/** A bridge-stamped perspective capture: the only pitch evidence the gate trusts. */
function stamped(cam: Record<string, unknown>): ScreenRectsResult["camera"] {
  return { ...cam, worldPitchDownDegProducedBy: TRUSTED_PITCH_PRODUCER } as ScreenRectsResult["camera"];
}

// Perspective-only contract (no orthographicSize pinned → an ortho capture is a
// projection mismatch).
const BAND: PerspectiveFramingSection = {
  projection: "high-angle",
  pitchDownDeg: { min: 55, max: 90 },
  perspectiveFallback: { fieldOfViewDeg: 40 },
  visibleGroundWidthM: { min: 24, max: 32 },
  groundPlaneY: 0,
};

// Either-rig contract (mirrors 3d-topdown-arena: orthographicSize pinned too, so
// an ortho capture is contract-sanctioned).
const BAND_ORTHO: PerspectiveFramingSection = { ...BAND, orthographicSize: 9 };

// ---------------------------------------------------------------------------
// Band PASS
// ---------------------------------------------------------------------------

test("perspective (in band): stamped FOV 40, pitch 70, h=20 → ~27.5m PASSES the 24-32 band", () => {
  const r = evaluateFraming(
    rects(stamped({ orthographic: false, fieldOfView: 40, worldPitchDownDeg: 70, position: { x: 0, y: 20, z: 0 } })),
    acceptanceWith(BAND),
  );
  const c = checkById(r, "camera.visibleGroundWidth");
  assert.equal(c.status, "pass", c.detail);
  assert.match(c.actual, /27\.5/);
  assert.equal(checkById(r, "camera.pitchDown").status, "pass"); // 70 ∈ [55,90]
});

test("orthographic (contract-sanctioned, in band): size 9, 16:9 → 32m at the band edge PASSES; pitch is a noisy WARN", () => {
  const r = evaluateFraming(
    rects({ orthographic: true, authoredOrthographicSize: 9, position: { x: 0, y: 20, z: 0 } }),
    acceptanceWith(BAND_ORTHO),
  );
  const c = checkById(r, "camera.visibleGroundWidth");
  assert.equal(c.status, "pass", c.detail);
  assert.match(c.actual, /32/);
  assert.equal(checkById(r, "camera.orthographicSize").status, "pass");
  // Pitch is unverifiable on the ortho path (bridge gap) → WARN, never silent.
  const pitch = checkById(r, "camera.pitchDown");
  assert.equal(pitch.status, "warn");
  assert.match(pitch.detail, /bridge|rotation/i);
});

// ---------------------------------------------------------------------------
// Band FAIL — the dogfood 54m over-wide frame
// ---------------------------------------------------------------------------

test("perspective (over-wide): the dogfood rig FOV 60, pitch 80, h=26 → ~54m FAILS the band", () => {
  const r = evaluateFraming(
    rects(stamped({ orthographic: false, fieldOfView: 60, worldPitchDownDeg: 80, position: { x: 0, y: 26, z: 0 } })),
    acceptanceWith(BAND),
  );
  const c = checkById(r, "camera.visibleGroundWidth");
  assert.equal(c.status, "fail");
  assert.match(c.actual, /54/);
  assert.match(c.detail, /too WIDE|speck|dogfood/i);
  assert.equal(r.verdict, "fail");
  // pitch itself is in band — the width is what fails (isolated).
  assert.equal(checkById(r, "camera.pitchDown").status, "pass");
});

test("orthographic (over-wide): size 18 vs pinned 9 → size mismatch FAILS and 64m band FAILS", () => {
  const r = evaluateFraming(
    rects({ orthographic: true, authoredOrthographicSize: 18, position: { x: 0, y: 20, z: 0 } }),
    acceptanceWith(BAND_ORTHO),
  );
  assert.equal(checkById(r, "camera.visibleGroundWidth").status, "fail");
  assert.equal(checkById(r, "camera.orthographicSize").status, "fail");
});

test("orthographic (off-contract size, width coincidentally in band): size check still FAILS", () => {
  // size 8 → width 28.4m (in band) but the rig is off the pinned size 9: the band
  // passes, the size check fails — no laundering via a tuned in-band size.
  const r = evaluateFraming(
    rects({ orthographic: true, authoredOrthographicSize: 8, position: { x: 0, y: 20, z: 0 } }),
    acceptanceWith(BAND_ORTHO),
  );
  assert.equal(checkById(r, "camera.visibleGroundWidth").status, "pass");
  assert.equal(checkById(r, "camera.orthographicSize").status, "fail");
  assert.equal(r.verdict, "fail");
});

// ---------------------------------------------------------------------------
// REFUSAL (hard fail) on a missing bound field — never a silent skip / warn
// ---------------------------------------------------------------------------

test("refuse: perspective camera with NO captured pitch → hard FAIL (bridge gap named)", () => {
  const r = evaluateFraming(
    rects({ orthographic: false, fieldOfView: 40, position: { x: 0, y: 20, z: 0 } }), // no worldPitchDownDeg
    acceptanceWith(BAND),
  );
  const c = checkById(r, "camera.visibleGroundWidth");
  assert.equal(c.status, "fail");
  assert.match(c.detail, /pitch/i);
  assert.match(c.detail, /BRIDGE GAP/);
  assert.equal(r.verdict, "fail");
});

test("refuse: pitch PRESENT but unstamped → hand-authored pitch is not trusted evidence", () => {
  const r = evaluateFraming(
    rects({ orthographic: false, fieldOfView: 40, worldPitchDownDeg: 70, position: { x: 0, y: 20, z: 0 } }),
    acceptanceWith(BAND),
  );
  const c = checkById(r, "camera.visibleGroundWidth");
  assert.equal(c.status, "fail");
  assert.match(c.detail, /no bridge op emits camera pitch|not trusted evidence/i);
  assert.match(c.detail, /bridge gap/i);
});

test("refuse: pitch stamped with a WRONG producer id → still refused", () => {
  const r = evaluateFraming(
    rects({
      orthographic: false,
      fieldOfView: 40,
      worldPitchDownDeg: 70,
      worldPitchDownDegProducedBy: "hand-authored",
      position: { x: 0, y: 20, z: 0 },
    }),
    acceptanceWith(BAND),
  );
  const c = checkById(r, "camera.visibleGroundWidth");
  assert.equal(c.status, "fail");
  assert.match(c.detail, /"hand-authored"/);
});

test("refuse: perspective camera with NO captured FOV → hard FAIL", () => {
  const r = evaluateFraming(
    rects(stamped({ orthographic: false, worldPitchDownDeg: 70, position: { x: 0, y: 20, z: 0 } })), // no fieldOfView
    acceptanceWith(BAND),
  );
  assert.equal(checkById(r, "camera.visibleGroundWidth").status, "fail");
});

test("refuse: NO captured camera height (position.y) → hard FAIL", () => {
  const r = evaluateFraming(
    rects(stamped({ orthographic: false, fieldOfView: 40, worldPitchDownDeg: 70 })), // no position
    acceptanceWith(BAND),
  );
  const c = checkById(r, "camera.visibleGroundWidth");
  assert.equal(c.status, "fail");
  assert.match(c.detail, /height/i);
});

test("refuse: band declared but NO camera block at all → hard FAIL (not a skip)", () => {
  const r = evaluateFraming(
    { viewport: { aspect: 16 / 9 }, objects: [{ name: "player", centerXFraction: 0.5 }] },
    acceptanceWith(BAND),
  );
  const c = checkById(r, "camera.visibleGroundWidth");
  assert.equal(c.status, "fail");
  assert.match(c.detail, /REFUSAL|no `camera` block/i);
});

test("refuse: orthographic but NO orthographicSize captured → hard FAIL", () => {
  const r = evaluateFraming(
    rects({ orthographic: true, position: { x: 0, y: 20, z: 0 } }),
    acceptanceWith(BAND_ORTHO),
  );
  assert.equal(checkById(r, "camera.visibleGroundWidth").status, "fail");
});

test("refuse: projection flag not captured → hard FAIL", () => {
  const r = evaluateFraming(
    rects(stamped({ fieldOfView: 40, worldPitchDownDeg: 70, position: { x: 0, y: 20, z: 0 } })),
    acceptanceWith(BAND),
  );
  const c = checkById(r, "camera.visibleGroundWidth");
  assert.equal(c.status, "fail");
  assert.match(c.detail, /orthographic.*flag|projection/i);
});

// ---------------------------------------------------------------------------
// Projection mismatch (D3): the ortho formula belongs only to an ortho-sanctioned
// contract — an ortho capture cannot reroute a perspective-declared band.
// ---------------------------------------------------------------------------

test("refuse: contract declares a perspective rig (no orthographicSize); capture reports orthographic → projection mismatch", () => {
  const r = evaluateFraming(
    rects({ orthographic: true, authoredOrthographicSize: 9, position: { x: 0, y: 20, z: 0 } }),
    acceptanceWith(BAND), // BAND pins NO orthographicSize
  );
  const c = checkById(r, "camera.visibleGroundWidth");
  assert.equal(c.status, "fail");
  assert.match(c.detail, /projection mismatch/i);
  assert.equal(r.verdict, "fail");
});

// ---------------------------------------------------------------------------
// groundPlaneY laundering guards (D4)
// ---------------------------------------------------------------------------

test("refuse: implausible groundPlaneY (|y| > 100) → hard FAIL naming the value", () => {
  const r = evaluateFraming(
    rects(stamped({ orthographic: false, fieldOfView: 40, worldPitchDownDeg: 70, position: { x: 0, y: 170, z: 0 } })),
    acceptanceWith({ ...BAND, groundPlaneY: 150 }),
  );
  const c = checkById(r, "camera.visibleGroundWidth");
  assert.equal(c.status, "fail");
  assert.match(c.detail, /implausible ground plane/i);
  assert.match(c.detail, /150/);
});

test("refuse: implausible camera height (camY − groundPlaneY < 1m) → hard FAIL naming both values", () => {
  // groundPlaneY raised toward camY to shrink h (the laundering shape): 20 − 19.5 = 0.5m.
  const r = evaluateFraming(
    rects(stamped({ orthographic: false, fieldOfView: 40, worldPitchDownDeg: 70, position: { x: 0, y: 20, z: 0 } })),
    acceptanceWith({ ...BAND, groundPlaneY: 19.5 }),
  );
  const c = checkById(r, "camera.visibleGroundWidth");
  assert.equal(c.status, "fail");
  assert.match(c.detail, /implausible camera height/i);
  assert.match(c.detail, /19\.5/);
});

// ---------------------------------------------------------------------------
// UNBOUNDED horizon → refusal
// ---------------------------------------------------------------------------

test("refuse: unbounded frame (pitch below FOV/2, horizon in view) → hard FAIL", () => {
  const r = evaluateFraming(
    rects(stamped({ orthographic: false, fieldOfView: 60, worldPitchDownDeg: 25, position: { x: 0, y: 20, z: 0 } })),
    acceptanceWith(BAND),
  );
  const c = checkById(r, "camera.visibleGroundWidth");
  assert.equal(c.status, "fail");
  assert.match(c.detail, /UNBOUNDED|horizon/i);
});

// ---------------------------------------------------------------------------
// Not-armed (D1a: WARN, never pass) + back-compat
// ---------------------------------------------------------------------------

test("no visibleGroundWidthM band declared → WARN naming the undeclared band (never a pass)", () => {
  const noBand: PerspectiveFramingSection = { pitchDownDeg: { min: 55, max: 90 } };
  const r = evaluateFraming(
    rects(stamped({ orthographic: false, fieldOfView: 40, worldPitchDownDeg: 70, position: { x: 0, y: 20, z: 0 } })),
    acceptanceWith(noBand),
  );
  const c = checkById(r, "camera.visibleGroundWidth");
  assert.equal(c.status, "warn");
  assert.match(c.detail, /without a visibleGroundWidthM band/i);
  assert.match(c.detail, /UNENFORCED/);
  assert.equal(r.verdict, "warn");
});

test("aspect falls back to contract framing.aspect when viewport aspect absent", () => {
  const r = evaluateFraming(
    { camera: { orthographic: true, authoredOrthographicSize: 9, position: { x: 0, y: 20, z: 0 } }, objects: [] },
    acceptanceWith(BAND_ORTHO),
  );
  // 2·9·(16/9) = 32 via the contract's 16:9 fallback aspect.
  assert.equal(checkById(r, "camera.visibleGroundWidth").status, "pass");
});

test("back-compat: a 2D pixel-perfect camera block does NOT trigger the perspective branch", () => {
  const twoD = {
    framing: {
      aspect: { w: 16, h: 9 },
      cameraMode: "static",
      camera: {
        worldPosition: { x: 8, y: 4.5, z: -10 },
        orthographicSize: 4.5,
        backgroundColorHex: "#000000",
        pixelPerfect: { assetsPPU: 16, refResolutionX: 256, refResolutionY: 144, upscaleRT: false },
      },
      playerAnchor: { centerXFraction: 0.4, tolerance: 0.05 },
    },
  } as unknown as AcceptanceContract;
  const r = evaluateFraming(
    rects({ orthographic: true, authoredOrthographicSize: 4.5, position: { x: 8, y: 4.5, z: -10 } }),
    twoD,
  );
  assert.ok(maybeCheck(r, "camera.projection"), "2D block should run the ortho camera checks");
  assert.equal(maybeCheck(r, "camera.visibleGroundWidth"), undefined, "2D block must not run the perspective extent check");
});

// ---------------------------------------------------------------------------
// Validator: framing.camera perspective fields (D1b/D4/D5/D6)
// ---------------------------------------------------------------------------

/** Issues the validator raised under framing.camera for a contract with this camera block. */
function cameraIssues(camera: Record<string, unknown>): string[] {
  const contract = { framing: { aspect: { w: 16, h: 9 }, playerAnchor: { centerXFraction: 0.5, tolerance: 0.3 }, camera } };
  return validateAcceptanceContract(contract)
    .issues.filter((i) => i.path.startsWith("framing.camera"))
    .map((i) => `${i.code} ${i.path} ${i.message}`);
}

test("validator: well-formed perspective camera block raises no framing.camera issues", () => {
  const issues = cameraIssues({
    pitchDownDeg: { min: 55, max: 90 },
    perspectiveFallback: { fieldOfViewDeg: 40 },
    visibleGroundWidthM: { min: 24, max: 32 },
    groundPlaneY: 0,
  });
  assert.deepEqual(issues, []);
});

test("validator: perspective-shaped block WITHOUT visibleGroundWidthM is refused (arming is not opt-in)", () => {
  const issues = cameraIssues({ pitchDownDeg: { min: 55, max: 90 } });
  assert.ok(
    issues.some((i) => i.includes("framing.camera.visibleGroundWidthM") && /without a visibleGroundWidthM/.test(i)),
    issues.join("\n"),
  );
  // perspectiveFallback alone is also perspective-shaped.
  const issues2 = cameraIssues({ perspectiveFallback: { fieldOfViewDeg: 40 } });
  assert.ok(issues2.some((i) => i.includes("framing.camera.visibleGroundWidthM")), issues2.join("\n"));
});

test("validator: band with min > max is refused", () => {
  const issues = cameraIssues({ visibleGroundWidthM: { min: 32, max: 24 } });
  assert.ok(issues.some((i) => /min must be ≤/.test(i)), issues.join("\n"));
});

test("validator: negative band values are refused (min ≥ 0, max > 0)", () => {
  const neg = cameraIssues({ visibleGroundWidthM: { min: -5, max: 30 } });
  assert.ok(neg.some((i) => /non-negative/.test(i)), neg.join("\n"));
  const zeroMax = cameraIssues({ visibleGroundWidthM: { min: 0, max: 0 } });
  assert.ok(zeroMax.some((i) => /non-negative/.test(i)), zeroMax.join("\n"));
});

test("validator: band missing min or max is refused", () => {
  const issues = cameraIssues({ visibleGroundWidthM: { min: 24 } });
  assert.ok(issues.some((i) => /numeric min and max/.test(i)), issues.join("\n"));
});

test("validator: perspectiveFallback.fieldOfViewDeg must be a number in (0,180)", () => {
  const nonNum = cameraIssues({ perspectiveFallback: { fieldOfViewDeg: "wide" }, visibleGroundWidthM: { min: 24, max: 32 } });
  assert.ok(nonNum.some((i) => /fieldOfViewDeg must be a number/.test(i)), nonNum.join("\n"));
  const outOfRange = cameraIssues({ perspectiveFallback: { fieldOfViewDeg: 200 }, visibleGroundWidthM: { min: 24, max: 32 } });
  assert.ok(outOfRange.some((i) => /must be in \(0,180\)/.test(i)), outOfRange.join("\n"));
});

test("validator: groundPlaneY must be a finite number", () => {
  const nan = cameraIssues({ visibleGroundWidthM: { min: 24, max: 32 }, groundPlaneY: Number.NaN });
  assert.ok(nan.some((i) => /groundPlaneY must be a finite number/.test(i)), nan.join("\n"));
  const str = cameraIssues({ visibleGroundWidthM: { min: 24, max: 32 }, groundPlaneY: "0" });
  assert.ok(str.some((i) => /groundPlaneY must be a finite number/.test(i)), str.join("\n"));
});

test("validator: a 2D pixel-perfect camera block raises no framing.camera issues (back-compat)", () => {
  const issues = cameraIssues({
    worldPosition: { x: 8, y: 4.5, z: -10 },
    orthographicSize: 4.5,
    backgroundColorHex: "#2a1f4d",
    pixelPerfect: { assetsPPU: 16, refResolutionX: 256, refResolutionY: 144, upscaleRT: false },
  });
  assert.deepEqual(issues, []);
});
