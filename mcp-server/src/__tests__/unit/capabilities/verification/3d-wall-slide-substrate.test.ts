/**
 * 3D wall-slide feel substrate (dogfood learnings §2 "Wall-Slide Is A Feel Gate, Not A Bugfix Detail",
 * backlog High #2 — the wall-slide movement gate).
 *
 * Pure, synthetic-trajectory unit tests for `deriveWallSlideTangentRatio` in
 * `verification/feel-derive.ts`, mirroring the move-speed substrate's style
 * (hand-authored ground-plane XZ trajectories, honest-or-refuse, no live capture).
 *
 * THE INCIDENT (durable rule under test): the dogfood project's controller FROZE when diagonal input
 * pushed the player into a wall. The fix was a zero-friction collider material + a
 * collide-and-slide projection that removes only the into-wall velocity component, and the
 * VERIFICATION measured tangential movement WHILE PINNED against the wall. A movement
 * controller must NOT pass because walls block — it must PROVE diagonal-into-obstacle input
 * preserves tangent motion. `deriveWallSlideTangentRatio` measures exactly that ratio.
 *
 * RAW EVIDENCE / GEOMETRY (documented so the hand-computed expectations are auditable):
 *   Wall outward normal  n = {x: 1, z: 0}  (points +X into the open space; wall face at x=const).
 *   Input drive vector   i = {x: -3, z: 4} (magnitude 5 u/s; the −X component drives INTO the wall,
 *                            the +Z component is the along-wall / tangential push).
 *   i·n = −3  →  into-wall cos = −3/5 = −0.6  (< 0, a valid into-wall diagonal).
 *   tangent component = i − (i·n)·n = {x: −3−(−3)(1), z: 4} = {x: 0, z: 4}  →  expected tangential
 *   speed |tangent| = 4 u/s, unit tangent t̂ = {0, 1}. So a character that slides along +Z at S u/s
 *   while its x stays pinned reads tangentRatio = S / 4.
 *
 * Z IS LOAD-BEARING (the RCL-T02 Z-blindness family): n and t̂ are orthogonal so they span the
 * XZ plane — z is always needed by the pin axis or the tangent axis. The calculator refuses a
 * heterogeneous/NaN z (an absent z would score as 0 and fabricate displacement) and a z-less
 * planar-x-only trajectory (the measurement is impossible). `tangentRatio` is a WINDOW-AVERAGE
 * (net displacement / duration); the per-step `tangentialStallFraction` carries the
 * freeze-then-snap evidence a 1.0 average would hide.
 *
 * LIVE Unity capture evidence is DEFERRED (no committed demos/evidence-bundles/* transcript yet, like the
 * hold-channel / move-speed substrate): the calculator + these synthetic-trajectory tests are the
 * slice deliverable. The capture producer is the existing bridge motion ops (a {x,y,z} position
 * trajectory from runtime.capture_input_motion / measure_motion); this slice documents the minimal
 * capture-shape it must additionally DECLARE (wall normal, input drive vector, pinned window, and
 * the optional collider PhysicMaterial friction) — see WallSlideCapture in feel-derive.ts.
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { deriveWallSlideTangentRatio } from "../../../../capabilities/verification/feel-derive.js";
import type { FeelTrajectorySample } from "../../../../capabilities/verification/gates/feel.js";
import { validateAcceptanceContract } from "../../../../capabilities/verification/validator.js";
import { REPO_ROOT } from "../../../_support/paths.js";

// The canonical wall + diagonal-input geometry all cases share (see file header).
const WALL_NORMAL = { x: 1, z: 0 } as const; // outward normal, +X
const INPUT_DIAG = { x: -3, z: 4 } as const; // into-wall (−X) + along-wall (+Z), |i| = 5, tangential = 4
const EXPECTED_TANGENTIAL = 4; // |i − (i·n)·n|

/**
 * A ground-plane wall-slide track: pinned normal coordinate `wallX` (character's x pressed at the
 * wall face), sliding along +Z at `tangentSpeed` u/s, optionally drifting `normalDrift` u per step
 * along +X (0 = perfectly pinned). Produces `steps+1` samples at `stepMs` spacing (t = 0..steps·stepMs).
 */
function wallTrack(opts: {
  tangentSpeed: number;
  wallX?: number;
  normalDrift?: number;
  stepMs?: number;
  steps?: number;
  y?: number;
}): FeelTrajectorySample[] {
  const { tangentSpeed, wallX = 2, normalDrift = 0, stepMs = 100, steps = 5, y = 1 } = opts;
  const out: FeelTrajectorySample[] = [];
  for (let k = 0; k <= steps; k += 1) {
    const t = k * stepMs;
    out.push({ tMs: t, x: wallX + normalDrift * k, y, z: (tangentSpeed * t) / 1000 });
  }
  return out;
}

const FULL_WINDOW = { startMs: 0, endMs: 500 } as const; // covers all 6 samples of a default 5-step track

// ── the three headline ratios (perfect / frozen / partial) ─────────────────────

test("(a) PERFECT projected slide reads tangentRatio ≈ 1.0 — the collide-and-slide fix", () => {
  // Slides along +Z at the full tangential input speed (4 u/s), x pinned at the wall.
  const r = deriveWallSlideTangentRatio({
    samples: wallTrack({ tangentSpeed: 4 }),
    wallNormal: WALL_NORMAL,
    inputVector: INPUT_DIAG,
    window: FULL_WINDOW,
  });
  assert.equal(r.ok, true, r.ok ? "" : r.reason);
  if (!r.ok) return;
  assert.ok(Math.abs(r.tangentRatio - 1.0) < 1e-9, `expected 1.0, got ${r.tangentRatio}`);
  assert.ok(Math.abs(r.measuredTangentialSpeedUPerS - 4) < 1e-9);
  assert.ok(Math.abs(r.expectedTangentialSpeedUPerS - EXPECTED_TANGENTIAL) < 1e-9);
  assert.ok(Math.abs(r.pinnedDriftU) < 1e-9, "perfectly pinned → zero normal drift");
  assert.equal(r.tangentialStallFraction, 0, "a smooth slide never stalls");
});

test("(b) FROZEN controller reads tangentRatio = 0 — THE dogfood bug (pinned but not sliding)", () => {
  // No movement at all: x pinned, z never changes. This is the exact bug — the wall blocked the
  // player and the controller froze. It stays PINNED (drift 0) so it is a VALID sample, and honestly
  // reads a 0 ratio rather than being fudged or refused.
  const r = deriveWallSlideTangentRatio({
    samples: wallTrack({ tangentSpeed: 0 }),
    wallNormal: WALL_NORMAL,
    inputVector: INPUT_DIAG,
    window: FULL_WINDOW,
  });
  assert.equal(r.ok, true, r.ok ? "" : r.reason);
  if (!r.ok) return;
  assert.equal(r.tangentRatio, 0);
  assert.equal(r.measuredTangentialSpeedUPerS, 0);
  assert.ok(Math.abs(r.pinnedDriftU) < 1e-9);
  assert.equal(r.tangentialStallFraction, 1, "fully frozen → the whole window is a stall");
});

test("(c) PARTIAL slide reads the hand-computed mid ratio (2 u/s of 4 → 0.5)", () => {
  const r = deriveWallSlideTangentRatio({
    samples: wallTrack({ tangentSpeed: 2 }),
    wallNormal: WALL_NORMAL,
    inputVector: INPUT_DIAG,
    window: FULL_WINDOW,
  });
  assert.equal(r.ok, true, r.ok ? "" : r.reason);
  if (!r.ok) return;
  assert.ok(Math.abs(r.tangentRatio - 0.5) < 1e-9, `expected 0.5, got ${r.tangentRatio}`);
});

test("(d) FULL-SPEED arcade redirect can exceed 1.0 (keeps whole input magnitude along the wall)", () => {
  // An arcade slide redirects the full 5 u/s input magnitude along +Z, not just the 4 u/s tangential
  // component → ratio 5/4 = 1.25. This is the 'projected vs full-speed arcade slide' design choice the
  // pack band exposes (default band abs 0.4 → [0.6, 1.4] admits it).
  const r = deriveWallSlideTangentRatio({
    samples: wallTrack({ tangentSpeed: 5 }),
    wallNormal: WALL_NORMAL,
    inputVector: INPUT_DIAG,
    window: FULL_WINDOW,
  });
  assert.equal(r.ok, true, r.ok ? "" : r.reason);
  if (!r.ok) return;
  assert.ok(Math.abs(r.tangentRatio - 1.25) < 1e-9, `expected 1.25, got ${r.tangentRatio}`);
});

// ── collider-material evidence (optional; absence is a stated limit, not a refusal) ─────

test("collider material: ZERO friction present → reported with NO finding (the dogfood fix)", () => {
  const r = deriveWallSlideTangentRatio({
    samples: wallTrack({ tangentSpeed: 4 }),
    wallNormal: WALL_NORMAL,
    inputVector: INPUT_DIAG,
    window: FULL_WINDOW,
    colliderMaterial: { dynamicFriction: 0, staticFriction: 0 },
  });
  assert.equal(r.ok, true, r.ok ? "" : r.reason);
  if (!r.ok) return;
  assert.equal(r.colliderMaterial.present, true);
  if (r.colliderMaterial.present) assert.equal(r.colliderMaterial.frictionFinding, null);
});

test("collider material: NON-ZERO friction present → FLAGGED as a finding", () => {
  const r = deriveWallSlideTangentRatio({
    samples: wallTrack({ tangentSpeed: 4 }),
    wallNormal: WALL_NORMAL,
    inputVector: INPUT_DIAG,
    window: FULL_WINDOW,
    colliderMaterial: { dynamicFriction: 0.6, staticFriction: 0.6 },
  });
  assert.equal(r.ok, true, r.ok ? "" : r.reason);
  if (!r.ok) return;
  assert.equal(r.colliderMaterial.present, true);
  if (r.colliderMaterial.present) {
    assert.ok(r.colliderMaterial.frictionFinding, "non-zero friction must produce a finding");
    assert.match(r.colliderMaterial.frictionFinding ?? "", /NON-ZERO friction/);
  }
});

test("collider material: ABSENT → a stated LIMIT, not a refusal (optional evidence)", () => {
  const r = deriveWallSlideTangentRatio({
    samples: wallTrack({ tangentSpeed: 4 }),
    wallNormal: WALL_NORMAL,
    inputVector: INPUT_DIAG,
    window: FULL_WINDOW,
  });
  assert.equal(r.ok, true, r.ok ? "" : r.reason);
  if (!r.ok) return;
  assert.equal(r.colliderMaterial.present, false);
  if (!r.colliderMaterial.present) assert.match(r.colliderMaterial.limit, /not captured/);
});

// ── refusals (never a fudged ratio when the sample is not a valid wall-slide test) ──────

test("refuses a missing / zero-length wall normal", () => {
  const base = { samples: wallTrack({ tangentSpeed: 4 }), inputVector: INPUT_DIAG, window: FULL_WINDOW };
  assert.equal(deriveWallSlideTangentRatio({ ...base, wallNormal: null }).ok, false);
  assert.equal(deriveWallSlideTangentRatio({ ...base, wallNormal: { x: 0, z: 0 } }).ok, false);
});

test("refuses a missing / zero-length input vector", () => {
  const base = { samples: wallTrack({ tangentSpeed: 4 }), wallNormal: WALL_NORMAL, window: FULL_WINDOW };
  assert.equal(deriveWallSlideTangentRatio({ ...base, inputVector: null }).ok, false);
  assert.equal(deriveWallSlideTangentRatio({ ...base, inputVector: { x: 0, z: 0 } }).ok, false);
});

test("refuses an input that is NOT driving into the wall (dot ≥ 0)", () => {
  // Input points AWAY from the wall (+X, same side as the outward normal) → not a wall-slide test.
  const r = deriveWallSlideTangentRatio({
    samples: wallTrack({ tangentSpeed: 4 }),
    wallNormal: WALL_NORMAL,
    inputVector: { x: 3, z: 4 },
    window: FULL_WINDOW,
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /not driving into the wall/);
  // A purely PARALLEL input (no into-wall component at all) is likewise not a wall-slide test.
  const par = deriveWallSlideTangentRatio({
    samples: wallTrack({ tangentSpeed: 4 }),
    wallNormal: WALL_NORMAL,
    inputVector: { x: 0, z: 4 },
    window: FULL_WINDOW,
  });
  assert.equal(par.ok, false);
});

test("refuses a HEAD-ON input (no tangential component to preserve)", () => {
  // Input straight into the wall (−X only): tangent component is zero → nothing to slide.
  const r = deriveWallSlideTangentRatio({
    samples: wallTrack({ tangentSpeed: 0, wallX: 2 }),
    wallNormal: WALL_NORMAL,
    inputVector: { x: -5, z: 0 },
    window: FULL_WINDOW,
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /head-on/);
});

test("refuses an UNPINNED sample — character drifted off the wall (drift > epsilon)", () => {
  // Character drifts +0.15u/step along the normal (x: 2 → 2.75 over the window, drift 0.75u > 0.15u):
  // it was NOT actually pinned, so the tangential reading is invalid → REFUSE, never fudge.
  const r = deriveWallSlideTangentRatio({
    samples: wallTrack({ tangentSpeed: 4, normalDrift: 0.15 }),
    wallNormal: WALL_NORMAL,
    inputVector: INPUT_DIAG,
    window: FULL_WINDOW,
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /not pinned/);
});

test("refuses a window TOO SHORT (fewer than the minimum in-window samples)", () => {
  // Full 6-sample track, but a window [0,150]ms captures only t=0,100 → 2 samples (< 4) → refuse.
  const r = deriveWallSlideTangentRatio({
    samples: wallTrack({ tangentSpeed: 4 }),
    wallNormal: WALL_NORMAL,
    inputVector: INPUT_DIAG,
    window: { startMs: 0, endMs: 150 },
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /window too short/);
});

test("refuses an invalid window (missing / non-increasing bounds)", () => {
  const base = { samples: wallTrack({ tangentSpeed: 4 }), wallNormal: WALL_NORMAL, inputVector: INPUT_DIAG };
  assert.equal(deriveWallSlideTangentRatio({ ...base, window: null }).ok, false);
  assert.equal(deriveWallSlideTangentRatio({ ...base, window: { startMs: 500, endMs: 0 } }).ok, false);
});

test("refuses a malformed / empty / too-short trajectory", () => {
  const base = { wallNormal: WALL_NORMAL, inputVector: INPUT_DIAG, window: FULL_WINDOW };
  assert.equal(deriveWallSlideTangentRatio({ ...base, samples: [] }).ok, false);
  assert.equal(deriveWallSlideTangentRatio({ ...base, samples: [{ tMs: 0, x: 2, y: 1, z: 0 }] }).ok, false);
  // Non-monotonic time (scrambled / non-causal) → isValidTrajectory refuses.
  assert.equal(
    deriveWallSlideTangentRatio({
      ...base,
      samples: [
        { tMs: 100, x: 2, y: 1, z: 0 },
        { tMs: 100, x: 2, y: 1, z: 1 },
        { tMs: 50, x: 2, y: 1, z: 2 },
      ],
    }).ok,
    false,
  );
});

// ── freeze-then-snap (window-average blindness → tangentialStallFraction, D2) ───────────

test("FREEZE-THEN-SNAP: endpoint-average ratio reads ≈1.0 but stallFraction exposes the 80% freeze", () => {
  // Frozen for t=0..400ms (4 steps, zero tangential progress), then SNAPS to z=2 at t=500ms.
  // Net displacement 2u over 0.5s = 4 u/s → tangentRatio 1.0 — indistinguishable from a smooth
  // slide by the average alone. The per-step stall detector reads 400ms/500ms = 0.8.
  const samples: FeelTrajectorySample[] = [
    { tMs: 0, x: 2, y: 1, z: 0 },
    { tMs: 100, x: 2, y: 1, z: 0 },
    { tMs: 200, x: 2, y: 1, z: 0 },
    { tMs: 300, x: 2, y: 1, z: 0 },
    { tMs: 400, x: 2, y: 1, z: 0 },
    { tMs: 500, x: 2, y: 1, z: 2 }, // the snap
  ];
  const r = deriveWallSlideTangentRatio({
    samples,
    wallNormal: WALL_NORMAL,
    inputVector: INPUT_DIAG,
    window: FULL_WINDOW,
  });
  assert.equal(r.ok, true, r.ok ? "" : r.reason);
  if (!r.ok) return;
  assert.ok(Math.abs(r.tangentRatio - 1.0) < 1e-9, `average ratio still 1.0, got ${r.tangentRatio}`);
  assert.ok(Math.abs(r.tangentialStallFraction - 0.8) < 1e-9, `expected stall 0.8, got ${r.tangentialStallFraction}`);
});

test("PARTIAL-but-smooth slide has ZERO stall (stall measures freezes, not slowness)", () => {
  // A steady 2 u/s crawl (ratio 0.5) is SLOW but never stalls — every step makes real progress.
  const r = deriveWallSlideTangentRatio({
    samples: wallTrack({ tangentSpeed: 2 }),
    wallNormal: WALL_NORMAL,
    inputVector: INPUT_DIAG,
    window: FULL_WINDOW,
  });
  assert.equal(r.ok, true, r.ok ? "" : r.reason);
  if (r.ok) assert.equal(r.tangentialStallFraction, 0);
});

// ── z degeneracy (the RCL-T02 Z-blindness family, D1) ───────────────────────────────────

test("refuses a NaN z on an endpoint — never {ok:true, tangentRatio:NaN} (the D1 repro)", () => {
  const samples = wallTrack({ tangentSpeed: 4 });
  samples[samples.length - 1] = { ...samples[samples.length - 1], z: Number.NaN };
  const r = deriveWallSlideTangentRatio({
    samples,
    wallNormal: WALL_NORMAL,
    inputVector: INPUT_DIAG,
    window: FULL_WINDOW,
  });
  assert.equal(r.ok, false, "a NaN z must refuse, not return a NaN measurement");
  if (!r.ok) assert.match(r.reason, /heterogeneous z/);
});

test("refuses a HETEROGENEOUS trajectory (some samples carry z, others absent)", () => {
  const samples = wallTrack({ tangentSpeed: 4 });
  // One sample silently loses z — `?? 0` would fabricate a backwards step.
  samples[3] = { tMs: samples[3].tMs, x: samples[3].x, y: samples[3].y };
  const r = deriveWallSlideTangentRatio({
    samples,
    wallNormal: WALL_NORMAL,
    inputVector: INPUT_DIAG,
    window: FULL_WINDOW,
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /heterogeneous z/);
});

test("refuses a Z-LESS trajectory outright — whichever axis needs z would read a fabricated 0", () => {
  // No sample carries z (planar-x-only capture). n ⊥ t̂ span the XZ plane, so z is ALWAYS
  // load-bearing for one of the two measurement axes:
  const noZ: FeelTrajectorySample[] = [];
  for (let k = 0; k <= 5; k += 1) noZ.push({ tMs: k * 100, x: 2, y: 1 });
  // (1) x-normal wall → the TANGENT axis is z: a real slide would read FROZEN (fabricated 0 ratio).
  const xWall = deriveWallSlideTangentRatio({
    samples: noZ,
    wallNormal: WALL_NORMAL,
    inputVector: INPUT_DIAG,
    window: FULL_WINDOW,
  });
  assert.equal(xWall.ok, false);
  if (!xWall.ok) assert.match(xWall.reason, /carries no z/);
  // (2) z-normal wall → the PIN axis is z: an unpinned character would read falsely PINNED.
  const zWall = deriveWallSlideTangentRatio({
    samples: noZ,
    wallNormal: { x: 0, z: 1 },
    inputVector: { x: 4, z: -3 },
    window: FULL_WINDOW,
  });
  assert.equal(zWall.ok, false);
  if (!zWall.ok) assert.match(zWall.reason, /carries no z/);
});

// ── boundary behavior at the geometric thresholds (D3) ──────────────────────────────────

test("boundary: into-wall cos brackets the −0.05 threshold (above refuses, below measures)", () => {
  // The threshold is STRICTLY below −0.05. Exact-boundary equality is FP-fragile (hypot(0.05,
  // √(1−0.0025)) lands ulps under 1, nudging the cos across), so the bounded behavior is asserted
  // by BRACKETING the threshold on both sides instead of pinning the unrepresentable boundary.
  // cos ≈ −0.04 (above the threshold): grazing contact, not a wall-slide test → refuse.
  const above = deriveWallSlideTangentRatio({
    samples: wallTrack({ tangentSpeed: 1 }),
    wallNormal: WALL_NORMAL,
    inputVector: { x: -0.04, z: Math.sqrt(1 - 0.0016) },
    window: FULL_WINDOW,
  });
  assert.equal(above.ok, false);
  if (!above.ok) assert.match(above.reason, /not driving into the wall/);
  // cos ≈ −0.06 (below the threshold): into-wall holds, tangential fraction ≈ 0.998 → measures.
  // Expected tangential speed = sqrt(1−0.0036); drive the track at exactly that speed → ratio 1.0.
  const expected = Math.sqrt(1 - 0.0036);
  const past = deriveWallSlideTangentRatio({
    samples: wallTrack({ tangentSpeed: expected }),
    wallNormal: WALL_NORMAL,
    inputVector: { x: -0.06, z: expected },
    window: FULL_WINDOW,
  });
  assert.equal(past.ok, true, past.ok ? "" : past.reason);
  if (past.ok) assert.ok(Math.abs(past.tangentRatio - 1.0) < 1e-9);
});

test("boundary: NEAR-HEAD-ON tangential fraction below 0.05 refuses; just above measures", () => {
  // Input {−1, 0.045}: tangential fraction = 0.045/|i| ≈ 0.04495 < 0.05 → head-on refusal.
  const below = deriveWallSlideTangentRatio({
    samples: wallTrack({ tangentSpeed: 0.045 }),
    wallNormal: WALL_NORMAL,
    inputVector: { x: -1, z: 0.045 },
    window: FULL_WINDOW,
  });
  assert.equal(below.ok, false);
  if (!below.ok) assert.match(below.reason, /head-on/);
  // Input {−1, 0.07}: fraction ≈ 0.0698 > 0.05 → measurable; a perfect slide at the expected
  // tangential speed (0.07 u/s along +Z) reads ratio 1.0.
  const above = deriveWallSlideTangentRatio({
    samples: wallTrack({ tangentSpeed: 0.07 }),
    wallNormal: WALL_NORMAL,
    inputVector: { x: -1, z: 0.07 },
    window: FULL_WINDOW,
  });
  assert.equal(above.ok, true, above.ok ? "" : above.reason);
  if (above.ok) assert.ok(Math.abs(above.tangentRatio - 1.0) < 1e-9);
});

// ── minimum window duration (D4) ────────────────────────────────────────────────────────

test("refuses a window whose in-window samples SPAN under 100ms (enough samples, too brief)", () => {
  // 6 samples at 10ms spacing: ≥4 samples inside, but the effective span is 50ms < 100ms.
  const r = deriveWallSlideTangentRatio({
    samples: wallTrack({ tangentSpeed: 4, stepMs: 10 }),
    wallNormal: WALL_NORMAL,
    inputVector: INPUT_DIAG,
    window: { startMs: 0, endMs: 50 },
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /span .*ms, need ≥100ms/);
});

// ── genre-pack wiring validates through the production acceptance validator ─────────────

test("edited genre packs (3d-topdown-arena + 3d-shooter) validate; arena carries the wall-slide band", async () => {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = REPO_ROOT;
  const load = async (rel: string) =>
    JSON.parse(await fs.readFile(path.join(repoRoot, rel), "utf-8")) as Record<string, unknown>;

  const arena = await load("mcp-server/src/capabilities/genre/genre-packs/3d-topdown-arena/acceptance.json");
  const shooter = await load("mcp-server/src/capabilities/genre/genre-packs/3d-shooter/acceptance.json");
  for (const [name, contract] of [["3d-topdown-arena", arena], ["3d-shooter", shooter]] as const) {
    const result = validateAcceptanceContract(contract as never);
    assert.equal(result.valid, true, `${name}: ${JSON.stringify(result.issues, null, 2)}`);
  }

  // The arena pack declares the wall-slide band (target 1.0 ratio, the projected-vs-arcade tunable).
  const feel = arena.feel as { extra: Record<string, { target: number; unit: string; band: { abs: number } }> };
  const band = feel.extra.wallSlideTangentRatio;
  assert.ok(band, "3d-topdown-arena must carry feel.extra.wallSlideTangentRatio");
  assert.equal(band.target, 1);
  assert.equal(band.unit, "ratio");
  assert.equal(band.band.abs, 0.4);
  // The shooter pack enumerates it as a measure-only capability.
  const note = (shooter.source as { note: string }).note;
  assert.match(note, /wallSlideTangentRatio/);
});

// ── dimension / axis agnosticism (a wall on a different axis reads the same) ────────────

test("axis-agnostic: the same slide against a +Z-normal wall reads an identical ratio", () => {
  // Rotate the whole setup 90°: wall normal points +Z, the character slides along +X. A perfect slide
  // still reads 1.0 — the calculator is planar-XZ, not hard-coded to one axis.
  const samples: FeelTrajectorySample[] = [];
  for (let k = 0; k <= 5; k += 1) samples.push({ tMs: k * 100, x: (4 * (k * 100)) / 1000, y: 1, z: 2 });
  const r = deriveWallSlideTangentRatio({
    samples,
    wallNormal: { x: 0, z: 1 }, // outward normal +Z; wall face at z=const
    inputVector: { x: 4, z: -3 }, // into-wall (−Z) + along-wall (+X), tangential = 4 along +X
    window: FULL_WINDOW,
  });
  assert.equal(r.ok, true, r.ok ? "" : r.reason);
  if (r.ok) assert.ok(Math.abs(r.tangentRatio - 1.0) < 1e-9, `expected 1.0, got ${r.tangentRatio}`);
});
