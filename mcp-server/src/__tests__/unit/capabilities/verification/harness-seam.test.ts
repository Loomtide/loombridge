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
import { FEEL_SEAM_TEMPLATE, resolveFeelSeam } from "../../../../domain/harness-seam.js";

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
