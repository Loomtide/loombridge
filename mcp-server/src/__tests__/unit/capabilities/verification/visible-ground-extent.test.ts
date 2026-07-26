import assert from "node:assert/strict";
import test from "node:test";

import {
  computeVisibleGroundExtent,
  orthographicGroundWidthM,
  type BoundedGroundExtent,
} from "../../../../capabilities/verification/visible-ground-extent.js";

const ASPECT_16_9 = 16 / 9;

function bounded(r: ReturnType<typeof computeVisibleGroundExtent>): BoundedGroundExtent {
  assert.equal(r.bounded, true, r.bounded ? "" : `expected bounded, got refusal: ${(r as { reason: string }).reason}`);
  return r as BoundedGroundExtent;
}

// ---------------------------------------------------------------------------
// The dogfood repro: the over-wide 54m frame vs the corrected in-band 31m frame.
// Values derived from visibleGroundWidthM = 2·(h/sinθ)·aspect·tan(fovV/2).
// ---------------------------------------------------------------------------

test("dogfood BROKEN rig (h=26, pitch=80°, FOV=60°, 16:9) → ~54.2m centre width", () => {
  const r = bounded(
    computeVisibleGroundExtent({ heightAboveGroundM: 26, pitchDownDeg: 80, fieldOfViewDeg: 60, aspect: ASPECT_16_9 }),
  );
  // 2·(26/sin80°)·(16/9)·tan30° = 54.20m — the frame that read as a speck-character.
  assert.ok(Math.abs(r.visibleGroundWidthM - 54.2) < 0.1, `got ${r.visibleGroundWidthM}`);
});

test("dogfood FIXED rig (h=12, pitch=52°, FOV=60°, 16:9) → ~31.3m centre width (in 24-32 band)", () => {
  const r = bounded(
    computeVisibleGroundExtent({ heightAboveGroundM: 12, pitchDownDeg: 52, fieldOfViewDeg: 60, aspect: ASPECT_16_9 }),
  );
  assert.ok(Math.abs(r.visibleGroundWidthM - 31.26) < 0.05, `got ${r.visibleGroundWidthM}`);
  assert.ok(r.visibleGroundWidthM >= 24 && r.visibleGroundWidthM <= 32, "corrected rig is inside the 24-32m band");
});

test("straight-down (pitch=90°): near and far widths are symmetric about a finite depth", () => {
  const r = bounded(
    computeVisibleGroundExtent({ heightAboveGroundM: 20, pitchDownDeg: 90, fieldOfViewDeg: 40, aspect: ASPECT_16_9 }),
  );
  // Looking straight down: axis-ground distance = h, width = 2·h·aspect·tan(fovV/2).
  const expected = 2 * 20 * ASPECT_16_9 * Math.tan((20 * Math.PI) / 180);
  assert.ok(Math.abs(r.visibleGroundWidthM - expected) < 1e-6, `got ${r.visibleGroundWidthM}, expected ${expected}`);
  // near/far distances are symmetric about the nadir (±) at straight-down.
  assert.ok(Math.abs(r.nearEdgeDistM + r.farEdgeDistM) < 1e-6, "near/far distances symmetric about nadir");
  // at exactly 90° the frustum is symmetric, so near and far widths are EQUAL.
  assert.ok(Math.abs(r.farWidthM - r.nearWidthM) < 1e-6, "near/far widths equal at straight-down");
});

test("high (not vertical) angle: far edge is wider than near edge (perspective foreshortening)", () => {
  const r = bounded(
    computeVisibleGroundExtent({ heightAboveGroundM: 20, pitchDownDeg: 65, fieldOfViewDeg: 40, aspect: ASPECT_16_9 }),
  );
  assert.ok(r.farWidthM > r.nearWidthM, "far edge wider than near edge");
});

test("near edge wraps behind the nadir when the bottom ray passes vertical (pitch=80°, FOV=60°)", () => {
  // pitch + FOV/2 = 110° > 90°, so the bottom (near) ray looks slightly backward:
  // the near-edge horizontal distance is NEGATIVE (straddles the nadir).
  const r = bounded(
    computeVisibleGroundExtent({ heightAboveGroundM: 26, pitchDownDeg: 80, fieldOfViewDeg: 60, aspect: ASPECT_16_9 }),
  );
  assert.ok(r.nearEdgeDistM < 0, `expected near edge behind nadir, got ${r.nearEdgeDistM}`);
  assert.ok(r.farEdgeDistM > 0, "far edge ahead of nadir");
  assert.ok(r.depthM > 0, "depth is positive");
});

test("orthographic ground width = 2·size·aspect (height/pitch independent)", () => {
  // acceptance.json orthographicSize 9, 16:9 → 2·9·(16/9) = 32m.
  assert.equal(orthographicGroundWidthM(9, ASPECT_16_9), 32);
  assert.equal(orthographicGroundWidthM(4.5, ASPECT_16_9), 16);
});

// ---------------------------------------------------------------------------
// Honest degeneracy: refusal-shaped results, never Infinity/NaN.
// ---------------------------------------------------------------------------

test("top ray at/above horizon (pitch ≤ FOV/2) → UNBOUNDED refusal, not Infinity", () => {
  // pitch 25° with FOV 60° → top ray at 25 − 30 = −5° (above horizon): horizon in frame.
  const r = computeVisibleGroundExtent({ heightAboveGroundM: 20, pitchDownDeg: 25, fieldOfViewDeg: 60, aspect: ASPECT_16_9 });
  assert.equal(r.bounded, false);
  assert.match((r as { reason: string }).reason, /unbounded|horizon/i);
});

test("top ray exactly at horizon (pitch == FOV/2) → UNBOUNDED refusal", () => {
  const r = computeVisibleGroundExtent({ heightAboveGroundM: 20, pitchDownDeg: 30, fieldOfViewDeg: 60, aspect: ASPECT_16_9 });
  assert.equal(r.bounded, false);
});

test("not pitched down (pitch = 0) → refusal", () => {
  const r = computeVisibleGroundExtent({ heightAboveGroundM: 20, pitchDownDeg: 0, fieldOfViewDeg: 40, aspect: ASPECT_16_9 });
  assert.equal(r.bounded, false);
  assert.match((r as { reason: string }).reason, /not pitched down/i);
});

test("camera at/below ground (height ≤ 0) → refusal", () => {
  const r = computeVisibleGroundExtent({ heightAboveGroundM: 0, pitchDownDeg: 80, fieldOfViewDeg: 40, aspect: ASPECT_16_9 });
  assert.equal(r.bounded, false);
  assert.match((r as { reason: string }).reason, /ground plane|> 0/i);
});

test("invalid FOV / aspect → refusal", () => {
  assert.equal(
    computeVisibleGroundExtent({ heightAboveGroundM: 20, pitchDownDeg: 80, fieldOfViewDeg: 0, aspect: ASPECT_16_9 }).bounded,
    false,
  );
  assert.equal(
    computeVisibleGroundExtent({ heightAboveGroundM: 20, pitchDownDeg: 80, fieldOfViewDeg: 200, aspect: ASPECT_16_9 }).bounded,
    false,
  );
  assert.equal(
    computeVisibleGroundExtent({ heightAboveGroundM: 20, pitchDownDeg: 80, fieldOfViewDeg: 40, aspect: 0 }).bounded,
    false,
  );
});

test("all bounded outputs are finite (never NaN/Infinity)", () => {
  const r = bounded(
    computeVisibleGroundExtent({ heightAboveGroundM: 15, pitchDownDeg: 65, fieldOfViewDeg: 45, aspect: ASPECT_16_9 }),
  );
  for (const v of [
    r.visibleGroundWidthM,
    r.nearWidthM,
    r.farWidthM,
    r.nearEdgeDistM,
    r.farEdgeDistM,
    r.depthM,
    r.centerDistM,
  ]) {
    assert.ok(Number.isFinite(v), `non-finite output: ${v}`);
  }
});
