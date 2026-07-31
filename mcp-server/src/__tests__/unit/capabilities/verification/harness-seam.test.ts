/**
 * THE HARNESS BLOCK (evidence arc stage 2, S2a; review M14).
 *
 * A new OPTIONAL top-level `harness` section declares how a measurement recipe
 * reaches a game: the controller seam, the input reader to disable, the keys to
 * inject. It is deliberately not inside `feel`: `feel` states what the game must
 * feel like and is graded; this states how the test rig is wired and is not.
 *
 * Three ends have to stay bound, and each is checked here:
 *   1. the JSON schema declares it (a contract carrying it is not "additional");
 *   2. the validator checks its SHAPE when present (a half-declared seam is refused
 *      at contract time, long before a live editor is involved);
 *   3. absence is legal at contract time and REFUSED at run time by the recipe, with
 *      the exact JSON to add.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { PKG_ROOT } from "../../../_support/paths.js";
import { validateAcceptanceContract } from "../../../../capabilities/verification/validator.js";
import {
  FEEL_SEAM_GROUNDED_NOTE,
  FEEL_SEAM_RUNLEG_NOTE,
  FEEL_SEAM_TEMPLATE,
  RUN_LEG_MAX_TICKS,
  RUN_LEG_MIN_TICKS,
  resolveFeelSeam,
} from "../../../../domain/harness-seam.js";

const acceptancePath = path.join(
  PKG_ROOT,
  "src/capabilities/verification/tiderunner.acceptance.json",
);
const schemaPath = path.join(PKG_ROOT, "src/capabilities/verification/acceptance.schema.json");

function contract(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(acceptancePath, "utf-8")) as Record<string, unknown>;
}

const SEAM = {
  playerLocator: "TideRunner:/Player",
  controllerComponent: "PlayerController",
  inputReaderComponent: "PlayerInputReader",
  fields: { moveX: "moveX", jumpHeld: "jumpHeld", dashHeld: "dashHeld" },
  keys: { jump: "Space", moveRight: "D", jumpCut: "Space", dash: "LeftShift" },
};

// ── 1. the schema knows the section ─────────────────────────────────────────

test("the acceptance SCHEMA declares harness.feelSeam with its required fields", () => {
  const schema = JSON.parse(fs.readFileSync(schemaPath, "utf-8")) as {
    additionalProperties: boolean;
    properties: Record<string, { properties?: Record<string, { required?: string[] }> }>;
  };
  // The schema is closed, so an undeclared section would make every contract
  // carrying the block invalid against the published schema while the hand-written
  // validator happily accepted it: the two ends drifting apart in silence.
  assert.equal(schema.additionalProperties, false);
  const harness = schema.properties.harness;
  assert.ok(harness, "the schema declares no harness section");
  const seam = harness.properties?.feelSeam;
  assert.ok(seam, "the schema declares no harness.feelSeam");
  assert.deepEqual(seam.required, [
    "playerLocator",
    "controllerComponent",
    "inputReaderComponent",
    "fields",
    "keys",
  ]);
});

test("every field the RESOLVER requires is also required by the schema (the two ends agree)", () => {
  // The resolver's refusal list is derived by deletion, not by reading a constant:
  // drop each field from a valid seam and see which ones the resolver refuses.
  const refusedByResolver: string[] = [];
  for (const field of ["playerLocator", "controllerComponent", "inputReaderComponent", "fields", "keys"]) {
    const partial = { ...SEAM } as Record<string, unknown>;
    delete partial[field];
    const result = resolveFeelSeam({ harness: { feelSeam: partial } });
    if (!result.ok) refusedByResolver.push(field);
  }
  const schema = JSON.parse(fs.readFileSync(schemaPath, "utf-8")) as {
    properties: { harness: { properties: { feelSeam: { required: string[] } } } };
  };
  assert.deepEqual(refusedByResolver.sort(), [...schema.properties.harness.properties.feelSeam.required].sort());
});

// ── 2. contract validation of the shape ─────────────────────────────────────

test("a contract with NO harness section stays valid (absence is legal, M14)", () => {
  const base = contract();
  delete base.harness;
  assert.equal(validateAcceptanceContract(base).valid, true);
});

test("a contract with a complete harness.feelSeam validates", () => {
  assert.equal(validateAcceptanceContract({ ...contract(), harness: { feelSeam: SEAM } }).valid, true);
});

test("a half-declared seam is REFUSED at contract time, naming the missing field", () => {
  const partial = { ...SEAM } as Record<string, unknown>;
  delete partial.inputReaderComponent;
  const result = validateAcceptanceContract({ ...contract(), harness: { feelSeam: partial } });
  assert.equal(result.valid, false);
  assert.ok(
    result.issues.some((i) => i.path === "harness.feelSeam.inputReaderComponent"),
    JSON.stringify(result.issues),
  );
});

test("an empty-string field is refused too (a blank name is not a declaration)", () => {
  const blank = { ...SEAM, fields: { moveX: "  " } };
  const result = validateAcceptanceContract({ ...contract(), harness: { feelSeam: blank } });
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((i) => i.path === "harness.feelSeam.fields.moveX"));
});

test("a missing keyed binding is refused: the keyed captures cannot be composed without it", () => {
  const noJump = { ...SEAM, keys: { moveRight: "D" } };
  const result = validateAcceptanceContract({ ...contract(), harness: { feelSeam: noJump } });
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((i) => i.path === "harness.feelSeam.keys.jump"));
});

test("a non-object harness is refused rather than ignored", () => {
  assert.equal(validateAcceptanceContract({ ...contract(), harness: "yes" }).valid, false);
  assert.equal(validateAcceptanceContract({ ...contract(), harness: { feelSeam: 7 } }).valid, false);
});

// ── 3. the run-time refusal names the JSON to add ───────────────────────────

test("the refusal text carries the copy-pasteable block, not a documentation pointer", () => {
  const result = resolveFeelSeam({ feel: {} });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.refusal, /\.loombridge\/ACCEPTANCE\.json/);
  assert.ok(result.refusal.includes(FEEL_SEAM_TEMPLATE));
  // The template must itself be a valid seam, or the refusal routes an operator into
  // a second refusal.
  const parsed = JSON.parse(`{${FEEL_SEAM_TEMPLATE}}`) as Record<string, unknown>;
  assert.equal(resolveFeelSeam(parsed).ok, true);
});

// ── fields.grounded: the exact coyote anchor (E6 session three) ─────────────

test("fields.grounded round-trips through the SCHEMA, the VALIDATOR and the RESOLVER, and stays optional", () => {
  const seam = { ...SEAM, fields: { ...SEAM.fields, grounded: " grounded " } };
  assert.equal(validateAcceptanceContract({ ...contract(), harness: { feelSeam: seam } }).valid, true);
  const result = resolveFeelSeam({ harness: { feelSeam: seam } });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.seam.fields.grounded, "grounded");

  // Optional: absent stays absent rather than materialising as a declared field, so a
  // contract that never declared it cannot look like one that did.
  const without = resolveFeelSeam({ harness: { feelSeam: SEAM } });
  assert.equal(without.ok, true);
  if (!without.ok) return;
  assert.equal(without.seam.fields.grounded, undefined);
  assert.equal(validateAcceptanceContract({ ...contract(), harness: { feelSeam: SEAM } }).valid, true);

  // The SCHEMA knows it too, or a contract carrying it fails against the published
  // schema while the hand-written validator accepts it.
  const schema = JSON.parse(fs.readFileSync(schemaPath, "utf-8")) as {
    properties: {
      harness: { properties: { feelSeam: { properties: { fields: { properties: Record<string, unknown> } } } } };
    };
  };
  assert.ok(schema.properties.harness.properties.feelSeam.properties.fields.properties.grounded);
});

test("a BLANK fields.grounded is refused by both ends, never read as 'not declared'", () => {
  // An empty string would resolve to "no ground flag", which silently drops the coyote
  // sweep back onto the rig-dependent descent anchor on a contract that meant to
  // declare one. Refuse at contract time.
  const blank = { ...SEAM, fields: { ...SEAM.fields, grounded: "   " } };
  const result = validateAcceptanceContract({ ...contract(), harness: { feelSeam: blank } });
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((i) => i.path === "harness.feelSeam.fields.grounded"), JSON.stringify(result.issues));
});

test("the refusal TEACHES fields.grounded: the template carries it and the note says what it buys", () => {
  const result = resolveFeelSeam({ feel: {} });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.refusal.includes(FEEL_SEAM_GROUNDED_NOTE));
  assert.match(FEEL_SEAM_GROUNDED_NOTE, /declare it when the controller exposes its ground probe/);
  assert.match(FEEL_SEAM_GROUNDED_NOTE, /makes the coyote anchor exact/);
  // The template stays a VALID seam with the field in it.
  const parsed = JSON.parse(`{${FEEL_SEAM_TEMPLATE}}`) as Record<string, unknown>;
  const resolved = resolveFeelSeam(parsed);
  assert.equal(resolved.ok, true);
  if (!resolved.ok) return;
  assert.equal(resolved.seam.fields.grounded, "grounded");
  assert.equal(validateAcceptanceContract({ ...contract(), ...parsed }).valid, true);
});

test("the runway note no longer claims runLeg bounds the coyote calibration walk", () => {
  // The two legs want opposite things on the same number (E6 session three), and an
  // operator who reads the old sentence sets a runway that refuses the coyote sweep.
  assert.match(FEEL_SEAM_RUNLEG_NOTE, /bounds how far the RUN LEG drives the player/);
  assert.match(FEEL_SEAM_RUNLEG_NOTE, /does NOT bound[\s\S]*coyote calibration walk/);
});

test("the resolver returns the trimmed seam, and optional fields stay optional", () => {
  const result = resolveFeelSeam({
    harness: {
      feelSeam: {
        playerLocator: " Level:/Player ",
        controllerComponent: "PlayerController",
        inputReaderComponent: "PlayerInputReader",
        fields: { moveX: "moveX" },
        keys: { jump: "Space", moveRight: "D" },
      },
    },
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.seam.playerLocator, "Level:/Player");
  assert.equal(result.seam.fields.dashHeld, undefined);
  assert.equal(result.seam.keys.dash, undefined);
});

// ── 4. THE RUNWAY (E6): harness.feelSeam.runLeg ─────────────────────────────

test("runLeg is OPTIONAL and its absence keeps today's behaviour", () => {
  const result = resolveFeelSeam({ harness: { feelSeam: SEAM } });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.seam.runLeg, undefined, "an absent runLeg must not materialise as a declared bound");
  assert.equal(validateAcceptanceContract({ ...contract(), harness: { feelSeam: SEAM } }).valid, true);
});

test("runLeg { ticks, direction } round-trips through the schema AND the resolver", () => {
  const seam = { ...SEAM, keys: { ...SEAM.keys, moveLeft: "A" }, runLeg: { ticks: 34, direction: -1 } };
  assert.equal(validateAcceptanceContract({ ...contract(), harness: { feelSeam: seam } }).valid, true);
  const result = resolveFeelSeam({ harness: { feelSeam: seam } });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.seam.runLeg, { ticks: 34, direction: -1 });
});

test("runLeg.ticks outside [12, 600] is REFUSED, never clamped", () => {
  for (const ticks of [11, 601, 0, -30]) {
    const result = resolveFeelSeam({ harness: { feelSeam: { ...SEAM, runLeg: { ticks } } } });
    assert.equal(result.ok, false, `ticks ${ticks} must refuse`);
    if (result.ok) continue;
    assert.match(result.refusal, /outside \[12, 600\]/);
  }
  // POSITIVE CONTROL: both bounds themselves are accepted, so the refusal is the range.
  for (const ticks of [12, 600, 90]) {
    assert.equal(resolveFeelSeam({ harness: { feelSeam: { ...SEAM, runLeg: { ticks } } } }).ok, true);
  }
  // A non-integer tick count is a refusal too: the leg is composed in whole ticks.
  assert.equal(resolveFeelSeam({ harness: { feelSeam: { ...SEAM, runLeg: { ticks: 34.5 } } } }).ok, false);
});

test("runLeg.direction -1 REQUIRES keys.moveLeft: the keyed legs have to have a key to inject", () => {
  const withoutLeft = resolveFeelSeam({ harness: { feelSeam: { ...SEAM, runLeg: { direction: -1 } } } });
  assert.equal(withoutLeft.ok, false);
  if (withoutLeft.ok) return;
  assert.match(withoutLeft.refusal, /keys\.moveLeft/);

  // POSITIVE CONTROL: declare the key and the same runLeg resolves.
  const withLeft = resolveFeelSeam({
    harness: { feelSeam: { ...SEAM, keys: { ...SEAM.keys, moveLeft: "A" }, runLeg: { direction: -1 } } },
  });
  assert.equal(withLeft.ok, true);

  // …and direction 1 never needed it.
  assert.equal(resolveFeelSeam({ harness: { feelSeam: { ...SEAM, runLeg: { direction: 1 } } } }).ok, true);
  // Anything other than 1 / -1 is refused rather than coerced.
  assert.equal(resolveFeelSeam({ harness: { feelSeam: { ...SEAM, runLeg: { direction: 0 } } } }).ok, false);
  assert.equal(resolveFeelSeam({ harness: { feelSeam: { ...SEAM, runLeg: { direction: "left" } } } }).ok, false);
});

test("the SCHEMA and the RESOLVER agree on runLeg's bounds (the two ends cannot drift)", () => {
  const schema = JSON.parse(fs.readFileSync(schemaPath, "utf-8")) as {
    properties: { harness: { properties: { feelSeam: { properties: Record<string, { properties?: Record<string, { minimum?: number; maximum?: number; enum?: unknown[] }> }> } } } };
  };
  const runLeg = schema.properties.harness.properties.feelSeam.properties.runLeg;
  assert.ok(runLeg, "the schema declares no harness.feelSeam.runLeg");
  assert.equal(runLeg.properties?.ticks.minimum, RUN_LEG_MIN_TICKS);
  assert.equal(runLeg.properties?.ticks.maximum, RUN_LEG_MAX_TICKS);
  assert.deepEqual(runLeg.properties?.direction.enum, [1, -1]);
  // A contract carrying an out-of-range value must be refused by BOTH ends, not one.
  const outOfRange = { ...contract(), harness: { feelSeam: { ...SEAM, runLeg: { ticks: 601 } } } };
  assert.equal(validateAcceptanceContract(outOfRange).valid, false);
  assert.equal(resolveFeelSeam(outOfRange).ok, false);
});
