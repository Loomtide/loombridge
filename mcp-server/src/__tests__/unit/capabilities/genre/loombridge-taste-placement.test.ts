import assert from "node:assert/strict";
import test from "node:test";

import { computeTastePlacement } from "../../../../capabilities/genre/genre-packs/platformer-2d/taste-placement.js";
import { loadAllProfiles, loadProfile } from "../../../../capabilities/genre/genre-packs/platformer-2d/profiles.js";

// Placement is descriptive vocabulary over the SHIPPED profiles, so these tests
// run against the real band files (like the profile-pin suite), not synthetics.

test("placement: a fast runSpeed on precision reads nearest momentum", async () => {
  const precision = await loadProfile("precision");
  const all = await loadAllProfiles();
  // precision targets 9 u/s; momentum targets 14 u/s +/-20% -> 13.2 is IN momentum's band.
  const block = computeTastePlacement(precision, all, { runSpeed: 13.2 }, new Map());
  assert.equal(block.status, "computed");
  const entry = block.entries.find((e) => e.id === "runSpeed");
  assert.ok(entry);
  assert.equal(entry.nearest, "momentum");
  const momentum = entry.distances.find((d) => d.profileId === "momentum");
  assert.ok(momentum && momentum.inBand);
  assert.equal(block.overallNearest, "momentum");
  assert.match(entry.detail, /nearest momentum/);
});

test("placement: a metric is only compared against profiles that band it", async () => {
  const momentum = await loadProfile("momentum");
  const all = await loadAllProfiles();
  // maxFallSpeed is banded ONLY by momentum: exactly one distance row, honestly asymmetric.
  const block = computeTastePlacement(momentum, all, { maxFallSpeed: 24 }, new Map());
  const entry = block.entries.find((e) => e.id === "maxFallSpeed");
  assert.ok(entry);
  assert.deepEqual(
    entry.distances.map((d) => d.profileId),
    ["momentum"],
  );
});

test("placement: a rejected value earns NO placement and is stamped with its reason", async () => {
  const precision = await loadProfile("precision");
  const all = await loadAllProfiles();
  const block = computeTastePlacement(
    precision,
    all,
    { runSpeed: 13.2, jumpApex: 3.0 },
    new Map([["jumpApex", "reported value != raw samples"]]),
  );
  assert.ok(!block.entries.some((e) => e.id === "jumpApex"));
  assert.deepEqual(block.excluded, [{ id: "jumpApex", reason: "reported value != raw samples" }]);
  // The untainted metric still places.
  assert.ok(block.entries.some((e) => e.id === "runSpeed"));
});

test("placement: unmeasured taste ids are stamped, never silently skipped", async () => {
  const precision = await loadProfile("precision");
  const all = await loadAllProfiles();
  const block = computeTastePlacement(precision, all, { runSpeed: 9 }, new Map());
  assert.ok(block.notMeasured.includes("jumpApex"));
  assert.ok(block.notMeasured.includes("dashDistance"));
  assert.ok(!block.notMeasured.includes("runSpeed"));
});

test("placement: no taste measured -> explicit no_taste_measured status, not an empty computed", async () => {
  const precision = await loadProfile("precision");
  const all = await loadAllProfiles();
  // coyoteTime is grammar; measuring only it leaves zero placeable taste values.
  const block = computeTastePlacement(precision, all, { coyoteTime: 0.1 }, new Map());
  assert.equal(block.status, "no_taste_measured");
  assert.equal(block.entries.length, 0);
  assert.equal(block.overallNearest, undefined);
});

test("placement: dead-center on the selected profile places on the selected profile", async () => {
  const classic = await loadProfile("classic");
  const all = await loadAllProfiles();
  const targets: Record<string, number> = {};
  for (const [id, t] of Object.entries(classic.metrics)) {
    targets[id] = (t as { target: number }).target;
  }
  const block = computeTastePlacement(classic, all, targets, new Map());
  assert.equal(block.status, "computed");
  assert.equal(block.overallNearest, "classic");
});
