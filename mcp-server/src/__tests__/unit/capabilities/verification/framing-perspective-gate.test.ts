import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateFraming,
  TRUSTED_PITCH_PRODUCER,
  type ScreenRectsResult,
} from "../../../../capabilities/verification/gates/framing.js";
import type { GateCheck, GateReport } from "../../../../capabilities/verification/gates/types.js";
import type { AcceptanceContract, PerspectiveFramingSection } from "../../../../capabilities/verification/types.js";
import { validateAcceptanceContract } from "../../../../capabilities/verification/validator.js";

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

// --- Direct perspective pin: the 3d-shooter pack shape --------------------------------------
//
// The pack's own template is `{projection: "perspective", fieldOfViewDeg: 60}` with no band and
// no pitchDownDeg. It used to route into the 2D orthographic branch and THROW on the absent
// worldPosition, so the gate crashed on the pack it ships.

const FOV_PIN: PerspectiveFramingSection = { projection: "perspective", fieldOfViewDeg: 60 };
const FOV_PIN_UNBOUNDED: PerspectiveFramingSection = { ...FOV_PIN, groundExtent: "unbounded" };

test("REGRESSION: a perspective FOV-pin contract does not crash the gate", () => {
  const report = evaluateFraming(rects({ orthographic: false, fieldOfView: 60 }), acceptanceWith(FOV_PIN));
  assert.ok(report.checks.length > 0, "the gate must produce checks, not throw");
  assert.equal(checkById(report, "camera.projection").status, "pass");
  assert.equal(checkById(report, "camera.fieldOfView").status, "pass");
});

test("the FOV pin is ENFORCED: a mismatched capture fails, an orthographic rig fails", () => {
  const offFov = evaluateFraming(rects({ orthographic: false, fieldOfView: 75 }), acceptanceWith(FOV_PIN));
  assert.equal(checkById(offFov, "camera.fieldOfView").status, "fail", "75 deg against a 60 deg pin must fail");

  const ortho = evaluateFraming(rects({ orthographic: true, fieldOfView: 60 }), acceptanceWith(FOV_PIN));
  assert.equal(checkById(ortho, "camera.projection").status, "fail", "an orthographic rig flattens a pinned 3D frame");
});

test("refuse-on-absent: an unknown projection or missing FOV is never a silent pass", () => {
  const noProjection = evaluateFraming(rects({ fieldOfView: 60 } as never), acceptanceWith(FOV_PIN));
  assert.equal(checkById(noProjection, "camera.projection").status, "fail", "absent `orthographic` must refuse");

  const noFov = evaluateFraming(rects({ orthographic: false } as never), acceptanceWith(FOV_PIN));
  assert.notEqual(checkById(noFov, "camera.fieldOfView").status, "pass", "a missing captured FOV may never pass");
});

// --- The extent gate may not be disarmed by omission -----------------------------------------
//
// THE HOLE THIS CLOSES. The first cut treated a bare `fieldOfViewDeg` as "this rig makes no
// ground-extent claim" and returned PASS. But the validator's band requirement keys off
// pitchDownDeg/perspectiveFallback, NOT fieldOfViewDeg, so a top-down contract that swapped its
// shape for a bare FOV pin lost the band requirement AND got a clean pass, on exactly the ~54m
// over-wide frame the band was added to catch.

/** The dogfood failure: camera 40m up, straight down, player a speck. FOV matches the pin. */
const OVER_WIDE = stamped({ orthographic: false, fieldOfView: 60, worldPosition: { x: 0, y: 40, z: 0 }, worldPitchDownDeg: 90 });

test("LITMUS: a bare FOV pin does NOT silence the ground-extent check", () => {
  const report = evaluateFraming(rects(OVER_WIDE), acceptanceWith(FOV_PIN));
  const extent = checkById(report, "camera.visibleGroundWidth");
  assert.notEqual(extent.status, "pass", "omitting the band must never buy a pass: opt-out with noise, never by omission");
  assert.equal(extent.status, "warn");
});

test("only the EXPLICIT opt-out passes, and it says so", () => {
  const report = evaluateFraming(rects(OVER_WIDE), acceptanceWith(FOV_PIN_UNBOUNDED));
  const extent = checkById(report, "camera.visibleGroundWidth");
  assert.equal(extent.status, "pass");
  assert.match(extent.expected, /groundExtent/, "the pass must name the declaration that earned it");
});

test("LITMUS: a declared band still ARMS the extent check against the same capture", () => {
  // Guards the opt-out from the other side: if the band path were broken, the two tests above
  // would pass while the gate graded nothing.
  const report = evaluateFraming(rects(OVER_WIDE), acceptanceWith(BAND));
  assert.equal(checkById(report, "camera.visibleGroundWidth").status, "fail", "a ~54m frame against a 24-32m band must fail");
});

test("validator: groundExtent is refused alongside a band, and refused on a typo", () => {
  const both = validateAcceptanceContract(acceptanceWith({ ...BAND, groundExtent: "unbounded" }));
  assert.ok(
    both.issues.some((i) => String(i.path).includes("groundExtent")),
    "declaring both the band and the opt-out is a contradiction and must refuse",
  );
  const typo = validateAcceptanceContract(acceptanceWith({ ...FOV_PIN, groundExtent: "unbound" as never }));
  assert.ok(
    typo.issues.some((i) => String(i.path).includes("groundExtent")),
    "a typo'd value must refuse, never read as an opt-out",
  );
});

// --- Static camera must not swallow a capture gap ---------------------------------------------

test("LITMUS: a MISSING player rect warns even on a static camera", () => {
  // The reorder that made the static branch first turned "the capture produced no rect" into a
  // silent green for every static-camera game. A capture gap is never a pass.
  const noRect: ScreenRectsResult = {
    camera: { orthographic: false, fieldOfView: 60 } as never,
    viewport: { width: 1920, height: 1080, aspect: 16 / 9 },
    objects: [{ name: "player", isPartiallyClipped: false } as never],
  };
  assert.equal(evaluateFraming(noRect, acceptanceWith(FOV_PIN)).checks.find((c) => c.id === "anchor.player")?.status, "warn");
});

test("a MEASURABLE rect on a static camera stays informational", () => {
  // The other side: the static-camera exemption is real, it just may not cover a missing rect.
  const report = evaluateFraming(rects({ orthographic: false, fieldOfView: 60 }), acceptanceWith(FOV_PIN));
  const anchor = checkById(report, "anchor.player");
  assert.equal(anchor.status, "pass");
  assert.match(anchor.expected, /N\/A: static camera/);
});
