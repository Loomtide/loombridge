import assert from "node:assert/strict";
import test from "node:test";

import { resolveStartingParams } from "../loomtide/genre-packs/platformer-2d/solve-params.js";
import { loadProfile } from "../loomtide/genre-packs/platformer-2d/profiles.js";
import type { PlatformerFeelProfile } from "../loomtide/genre-packs/platformer-2d/types.js";

// A minimal profile with a `build` block and the three solve bands, plus shortHopApex
// so the stored jumpCutMultiplier is verifiable. Used to exercise the pure math
// without depending on a shipped profile's exact numbers.
function buildable(overrides: Partial<PlatformerFeelProfile> = {}): PlatformerFeelProfile {
  return {
    schemaVersion: "1",
    id: "precision",
    title: "Test",
    summary: "Test profile.",
    metrics: {
      runSpeed: { target: 9, unit: "u/s", band: { percent: 15 } },
      jumpApex: { target: 3, unit: "u", band: { percent: 12 } },
      timeToApex: { target: 280, unit: "ms", band: { abs: 60 } },
      shortHopApex: { target: 1.1, unit: "u", band: { percent: 20 } },
    },
    build: {
      fixedTimestep: 0.0166667,
      stored: { jumpCutMultiplier: 0.08 },
    },
    ...overrides,
  } as PlatformerFeelProfile;
}

// ── the analytic derivation is correct ───────────────────────────────────────

test("resolveStartingParams derives v0/gravityScale/moveSpeed from the band targets", () => {
  const p = resolveStartingParams(buildable());
  // v0 = 2*3 / (0.28) = 21.428...
  assert.ok(Math.abs(p.jumpSpeed - 21.4286) < 0.01, `jumpSpeed=${p.jumpSpeed}`);
  // gravityScale = v0 / (0.28 * 9.81) = 21.4286 / 2.7468 = 7.802...
  assert.ok(Math.abs(p.gravityScale - 7.802) < 0.01, `gravityScale=${p.gravityScale}`);
  assert.equal(p.moveSpeed, 9);
  // stored, exact
  assert.equal(p.jumpCutMultiplier, 0.08);
  assert.equal(p.fixedTimestep, 0.0166667);
});

// ── F1-reproduction: precision profile reproduces the converged start ─────────

test("resolveStartingParams(precision) reproduces F1's converged precision params", async () => {
  const precision = await loadProfile("precision");
  const p = resolveStartingParams(precision);
  // F1-converged analytic start: jumpSpeed ≈ 21.4, gravityScale ≈ 7.8, moveSpeed 9, jumpCut 0.08.
  assert.ok(Math.abs(p.jumpSpeed - 21.4) < 0.1, `jumpSpeed=${p.jumpSpeed}`);
  assert.ok(Math.abs(p.gravityScale - 7.8) < 0.1, `gravityScale=${p.gravityScale}`);
  assert.equal(p.moveSpeed, 9); // stored exactly = runSpeed.target
  assert.equal(p.jumpCutMultiplier, 0.08); // stored exactly
  assert.equal(p.fixedTimestep, 0.0166667);
});

test("resolveStartingParams(classic) carries classic's stored jumpCutMultiplier (0.3)", async () => {
  const classic = await loadProfile("classic");
  const p = resolveStartingParams(classic);
  assert.equal(p.jumpCutMultiplier, 0.3);
  assert.equal(p.moveSpeed, 7);
  assert.equal(p.fixedTimestep, 0.0166667);
});

test("resolveStartingParams(momentum) omits jumpCutMultiplier (no shortHopApex band)", async () => {
  const momentum = await loadProfile("momentum");
  const p = resolveStartingParams(momentum);
  assert.equal(p.jumpCutMultiplier, undefined);
  assert.equal(p.moveSpeed, 14);
  assert.equal(p.fixedTimestep, 0.0166667);
});

// ── the resolver REFUSES a profile that cannot be solved ─────────────────────

test("resolveStartingParams refuses a profile with no build block", () => {
  const p = buildable();
  delete (p as { build?: unknown }).build;
  assert.throws(() => resolveStartingParams(p), /build/i);
});

test("resolveStartingParams refuses a profile missing a solve band", () => {
  const p = buildable();
  delete (p.metrics as Record<string, unknown>).jumpApex;
  assert.throws(() => resolveStartingParams(p), /jumpApex/);
});
