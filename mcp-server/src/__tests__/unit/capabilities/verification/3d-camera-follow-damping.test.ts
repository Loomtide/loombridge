/**
 * 3D top-down / twin-stick camera-follow-damping substrate (dogfood findings RCL-F01/RCL-F02).
 *
 * The 3d-shooter pack hard-codes an OVER-SHOULDER THIRD-PERSON rig; the 3D top-down /
 * twin-stick quadrant was empty and the dogfood "camera half-life 0.10-0.18s, look-ahead
 * 2-4m" dial had no calculator. This file is the synthetic-trace unit suite for:
 *
 *   deriveCameraFollowDamping — given the player's {x,y,z} trajectory AND the camera's
 *     {x,y,z} trajectory over the same window, measure the follow DAMPING: the catch-up
 *     HALF-LIFE (time to close half the gap to the settled pose, via a log-linear fit of the
 *     exponential residual decay) + the steady-state LOOK-AHEAD lead toward the movement
 *     vector. Honest-or-omit: refuses on a static camera / no player motion / malformed
 *     capture; an instant-snap (zero-damping) camera reports halfLifeMs = 0, not a refusal.
 *
 * Plus a contract test: the new `3d-topdown-arena` framing profile VALIDATES against the
 * production validateAcceptanceContract and declares TOP-DOWN framing (not over-shoulder).
 *
 * LIVE Unity capture is DEFERRED (no committed demo-bundles/* transcript yet — like the
 * hold-channel / move-speed / extraction substrates): a real twin-stick follow capture needs
 * a built top-down scene. The calculator + these synthetic tests are the slice deliverable.
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  deriveCameraFollowDamping,
  type CameraFollowDampingResult,
} from "../../../../capabilities/verification/feel-derive.js";
import type { FeelTrajectorySample } from "../../../../capabilities/verification/gates/feel.js";
import { validateAcceptanceContract } from "../../../../capabilities/verification/validator.js";
import type { AcceptanceContract } from "../../../../capabilities/verification/types.js";
import { REPO_ROOT } from "../../../_support/paths.js";

const DT_MS = 1000 / 60; // 60 fps capture
const HALF_LIFE_MS = 140; // target catch-up half-life (in the dogfood 0.10-0.18s band)
const TAU_MS = HALF_LIFE_MS / Math.LN2; // exp time-constant: half-life = tau * ln2

/**
 * Build a paired player/camera capture where the player STEPS along +X at index `plateau`
 * (from `pStart` to `pEnd` and holds) and the camera eases EXPONENTIALLY from `cStart` to a
 * settled `cEnd` with time-constant `TAU_MS`, then CLAMPS exactly at `cEnd` for a settled tail.
 * Camera Y/Z are constant (a top-down overhead rig); the follow lives in X.
 */
function buildStepAndEase(opts: {
  plateau: number;
  decay: number;
  clamp: number;
  pEnd: number;
  cStart: number;
  cEnd: number;
}): { player: FeelTrajectorySample[]; camera: FeelTrajectorySample[] } {
  const { plateau, decay, clamp, pEnd, cStart, cEnd } = opts;
  const player: FeelTrajectorySample[] = [];
  const camera: FeelTrajectorySample[] = [];
  const total = plateau + decay + clamp;
  for (let i = 0; i < total; i += 1) {
    const tMs = i * DT_MS;
    const px = i < plateau ? 0 : pEnd;
    player.push({ tMs, x: px, y: 0, z: 0 });

    let cx: number;
    if (i < plateau) {
      cx = cStart;
    } else if (i < plateau + decay) {
      // ease toward cEnd from cStart; at i==plateau the exponent is 0 → cx == cStart
      cx = cEnd - (cEnd - cStart) * Math.exp(-((i - plateau) * DT_MS) / TAU_MS);
    } else {
      cx = cEnd; // settled clamp (so camFinal == cEnd exactly → a CLEAN exponential residual)
    }
    camera.push({ tMs, x: cx, y: 12, z: 0 }); // overhead Y; follow is in X
  }
  return { player, camera };
}

test("(a) player steps, camera eases in → correct catch-up half-life", () => {
  // camera eases 0 → 10 (offset 0: it converges onto the player), half-life 140ms.
  const { player, camera } = buildStepAndEase({
    plateau: 10,
    decay: 100,
    clamp: 10,
    pEnd: 10,
    cStart: 0,
    cEnd: 10,
  });
  const r = deriveCameraFollowDamping(player, camera);
  assert.equal(r.measured, true, r.reason);
  assert.equal(r.evidence?.instant, false);
  // A perfect exponential residual recovers the half-life to float precision.
  assert.ok(
    r.halfLifeMs !== null && Math.abs(r.halfLifeMs - HALF_LIFE_MS) < 0.5,
    `halfLifeMs ${r.halfLifeMs} should be ~${HALF_LIFE_MS}`,
  );
  // Offset 0 → the camera ends on the player → ~zero steady look-ahead.
  assert.ok(
    r.lookAheadOffset !== null && Math.abs(r.lookAheadOffset) < 0.5,
    `lookAheadOffset ${r.lookAheadOffset} should be ~0`,
  );
});

test("(b) instant-snap camera (no damping) → half-life 0, honest (not a refusal)", () => {
  // camera == player every frame (rigid track): the residual collapses within one frame.
  const total = 40;
  const player: FeelTrajectorySample[] = [];
  const camera: FeelTrajectorySample[] = [];
  for (let i = 0; i < total; i += 1) {
    const tMs = i * DT_MS;
    const px = i < 10 ? 0 : 10;
    player.push({ tMs, x: px, y: 0, z: 0 });
    camera.push({ tMs, x: px, y: 12, z: 0 }); // tracks the player instantly (offset 0)
  }
  const r = deriveCameraFollowDamping(player, camera);
  assert.equal(r.measured, true, r.reason);
  assert.equal(r.halfLifeMs, 0);
  assert.equal(r.evidence?.instant, true);
});

test("(c) camera that never moves → refuse (camera-static)", () => {
  const total = 40;
  const player: FeelTrajectorySample[] = [];
  const camera: FeelTrajectorySample[] = [];
  for (let i = 0; i < total; i += 1) {
    const tMs = i * DT_MS;
    player.push({ tMs, x: i < 10 ? 0 : 10, y: 0, z: 0 });
    camera.push({ tMs, x: 5, y: 12, z: 0 }); // fixed overhead camera — never follows
  }
  const r = deriveCameraFollowDamping(player, camera);
  assert.equal(r.measured, false);
  assert.equal(r.reason, "camera-static");
  assert.equal(r.halfLifeMs, null);
});

test("(c') no player motion → refuse (no-player-motion)", () => {
  const total = 40;
  const player: FeelTrajectorySample[] = [];
  const camera: FeelTrajectorySample[] = [];
  for (let i = 0; i < total; i += 1) {
    const tMs = i * DT_MS;
    player.push({ tMs, x: 0, y: 0, z: 0 }); // player stands still — no follow stimulus
    camera.push({ tMs, x: i * 0.1, y: 12, z: 0 }); // camera drifts (irrelevant)
  }
  const r = deriveCameraFollowDamping(player, camera);
  assert.equal(r.measured, false);
  assert.equal(r.reason, "no-player-motion");
  assert.equal(r.halfLifeMs, null);
});

test("(d) steady look-ahead offset toward the movement vector is measured", () => {
  // player steps 0 → 10 (+X); camera leads by 3 along +X and eases, settling at 13.
  const { player, camera } = buildStepAndEase({
    plateau: 10,
    decay: 100,
    clamp: 10,
    pEnd: 10,
    cStart: 3, // camera already leads by 3 at rest
    cEnd: 13, // settles 3 ahead of the player's final x=10
  });
  const r = deriveCameraFollowDamping(player, camera);
  assert.equal(r.measured, true, r.reason);
  assert.deepEqual(r.evidence?.movementUnit, { x: 1, y: 0, z: 0 }); // net move is +X
  assert.ok(
    r.lookAheadOffset !== null && Math.abs(r.lookAheadOffset - 3) < 0.5,
    `lookAheadOffset ${r.lookAheadOffset} should be ~3 (lead toward +X)`,
  );
  // half-life still recovered alongside the look-ahead.
  assert.ok(r.halfLifeMs !== null && Math.abs(r.halfLifeMs - HALF_LIFE_MS) < 0.5);
});

test("(f) malformed / misaligned captures → refuse", () => {
  const ok: FeelTrajectorySample[] = [
    { tMs: 0, x: 0, y: 0, z: 0 },
    { tMs: DT_MS, x: 1, y: 0, z: 0 },
  ];
  // single-sample trajectory is not a valid trajectory
  const single = deriveCameraFollowDamping([{ tMs: 0, x: 0, y: 0, z: 0 }], ok);
  assert.equal(single.measured, false);
  assert.equal(single.reason, "malformed-trajectory");

  // non-finite coordinate
  const nan = deriveCameraFollowDamping(
    [
      { tMs: 0, x: 0, y: 0, z: 0 },
      { tMs: DT_MS, x: Number.NaN, y: 0, z: 0 },
    ],
    ok,
  );
  assert.equal(nan.measured, false);
  assert.equal(nan.reason, "malformed-trajectory");

  // mismatched lengths (un-paired capture)
  const mismatched = deriveCameraFollowDamping(ok, [
    ...ok,
    { tMs: 2 * DT_MS, x: 2, y: 0, z: 0 },
  ]);
  assert.equal(mismatched.measured, false);
  assert.equal(mismatched.reason, "misaligned-capture");

  // same length, misaligned timestamps
  const offTime = deriveCameraFollowDamping(ok, [
    { tMs: 0, x: 0, y: 0, z: 0 },
    { tMs: DT_MS + 5, x: 1, y: 0, z: 0 },
  ]);
  assert.equal(offTime.measured, false);
  assert.equal(offTime.reason, "misaligned-capture");
});

test("(extra) player returns home (no net direction) → refuse (no look-ahead axis)", () => {
  // player moves out then back to origin: it MOVED (stimulus) but has zero net displacement,
  // so there is no movement vector to project the look-ahead onto → honest refusal.
  const total = 40;
  const player: FeelTrajectorySample[] = [];
  const camera: FeelTrajectorySample[] = [];
  for (let i = 0; i < total; i += 1) {
    const tMs = i * DT_MS;
    const px = i < 20 ? i * 0.5 : (total - 1 - i) * 0.5; // out then back to ~0
    player.push({ tMs, x: px, y: 0, z: 0 });
    camera.push({ tMs, x: px * 0.8, y: 12, z: 0 });
  }
  const r = deriveCameraFollowDamping(player, camera);
  assert.equal(r.measured, false);
  assert.equal(r.reason, "no-net-movement-direction");
});

test("(e) 3d-topdown-arena framing profile validates and declares TOP-DOWN (not over-shoulder)", async () => {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const repoRoot = REPO_ROOT;
  const acceptancePath = path.join(
    repoRoot,
    "mcp-server/src/capabilities/genre/genre-packs/3d-topdown-arena/acceptance.json",
  );
  const text = await fs.readFile(acceptancePath, "utf-8");
  const contract = JSON.parse(text) as AcceptanceContract & Record<string, unknown>;

  // 1. validates against the SAME production contract validator the other packs use.
  const result = validateAcceptanceContract(contract);
  assert.equal(result.valid, true, JSON.stringify(result.issues, null, 2));

  // 2. declares TOP-DOWN framing, not the 3d-shooter over-shoulder third-person rig.
  const framing = (contract as Record<string, unknown>).framing as Record<string, unknown>;
  assert.equal(framing.cameraMode, "top-down-follow");
  assert.equal(framing.perspective, "top-down");

  const camera = framing.camera as Record<string, unknown>;
  // NOT a 60-FOV perspective over-shoulder rig.
  assert.notEqual(camera.projection, "perspective");
  assert.equal(camera.projection, "orthographic-or-high-angle");
  assert.notEqual(framing.cameraMode, "third-person-follow");

  // downward tilt range present (high-angle / straight-down).
  const pitch = camera.pitchDownDeg as { min: number; max: number };
  assert.ok(pitch.min >= 45 && pitch.max <= 90 && pitch.min < pitch.max, "downward tilt range");

  // look-ahead bias toward the aim/movement vector is declared.
  const lookAhead = framing.lookAhead as { bias: string; targetOffsetMeters: { min: number; max: number } };
  assert.match(lookAhead.bias, /aim|movement/);
  assert.ok(lookAhead.targetOffsetMeters.min >= 2 && lookAhead.targetOffsetMeters.max <= 4);

  // the over-shoulder "player parked at screen-center" assertion is NOT made: the player rides
  // behind the look-ahead point, reflected by a loose anchor tolerance.
  const anchor = framing.playerAnchor as { tolerance: number };
  assert.ok(anchor.tolerance >= 0.25, "twin-stick look-ahead → loose (not center-locked) anchor");

  // sanity: the result type is shaped as expected (compile-time + runtime).
  const probe: CameraFollowDampingResult = deriveCameraFollowDamping(
    [{ tMs: 0, x: 0, y: 0, z: 0 }],
    [{ tMs: 0, x: 0, y: 0, z: 0 }],
  );
  assert.equal(probe.measured, false);
});
