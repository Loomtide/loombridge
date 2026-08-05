/**
 * genre-contract.schema.json <-> validator.ts BINDING.
 *
 * The schema is the ergonomics layer (editor completion, standalone lint); `validateGenreContract`
 * is the gate. That split only holds while the two AGREE about the things a schema can express:
 * the closed enum sets and which fields are required. A schema that silently disagrees with the
 * validator is this repo's most expensive failure shape, a declared artifact nothing walks, so
 * both halves are derived from the RUNNING code here rather than eyeballed.
 *
 *  - the enum halves are compared against the exported constants themselves;
 *  - the `required` halves are DERIVED BY MUTATION: delete a field from a valid contract, ask the
 *    real validator whether it refuses, and require the schema to say the same thing. Nothing is
 *    read off a second hand-written list that could drift alongside the first.
 *
 * Both checks carry a LITMUS proving they fail on a disagreeing schema, so this file cannot
 * degrade into a green that means nothing.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { PKG_ROOT } from "../../../_support/paths.js";
import { validateGenreContract, IMPLEMENTED_CALCULATOR_IDS } from "../../../../capabilities/genre/genre-contract/validator.js";
import {
  CONTRACT_CONFIDENCE,
  EVIDENCE_KINDS,
  GENRE_CLASSES,
  GENRE_CONTRACT_SCHEMA_VERSION,
  MEASURABILITY_TAGS,
  NETWORK_MODES,
  SLICE_BUCKETS,
} from "../../../../capabilities/genre/genre-contract/types.js";
import { SUPPORTED_GATE_IDS } from "../../../../capabilities/verification/run-gates.js";
import { SUPPORTED_PROFILE_UNITS } from "../../../../domain/feel-primitives.js";
import { EVIDENCE_CLASSES } from "../../../../capabilities/verification/gates/evidence-classes.js";
import { VLM_REVIEW_CRITERION_IDS } from "../../../../capabilities/verification/gates/vlm-criteria.js";

const SCHEMA_PATH = path.join(
  PKG_ROOT,
  "src/capabilities/genre/genre-contract/genre-contract.schema.json",
);

type Json = Record<string, unknown>;

function readSchema(): Json {
  return JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf-8")) as Json;
}

/** Resolve a slash-separated path through the schema, failing loudly on a missing hop. */
function at(schema: Json, pointer: string): Json {
  let node: unknown = schema;
  for (const key of pointer.split("/")) {
    assert.ok(
      node && typeof node === "object" && key in (node as Json),
      `schema has no node at "${pointer}" (missing "${key}"): the schema and this binding drifted`,
    );
    node = (node as Json)[key];
  }
  return node as Json;
}

/** The comparison BOTH the real checks and the litmus self-test use, so they cannot diverge. */
function enumDiff(schemaEnum: unknown, expected: Iterable<string>): string | null {
  if (!Array.isArray(schemaEnum)) return "schema node has no enum array";
  const got = [...schemaEnum].map(String).sort();
  const want = [...expected].sort();
  return got.join("|") === want.join("|") ? null : `schema [${got.join(", ")}] vs code [${want.join(", ")}]`;
}

/* ------------------------------------------------------------------ enum binding */

/** Every closed set the schema republishes, and the RUNNING constant it must equal. */
const ENUM_BINDINGS: Array<{ pointer: string; expected: Iterable<string> }> = [
  { pointer: "properties/confidence/enum", expected: CONTRACT_CONFIDENCE },
  { pointer: "$defs/sliceNode/properties/confidence/enum", expected: CONTRACT_CONFIDENCE },
  { pointer: "properties/coreLoop/properties/genreClass/enum", expected: GENRE_CLASSES },
  { pointer: "properties/networkModel/properties/mode/enum", expected: NETWORK_MODES },
  { pointer: "$defs/measurabilityEntry/properties/tag/enum", expected: MEASURABILITY_TAGS },
  { pointer: "$defs/measurabilityEntry/properties/evidenceKind/enum", expected: EVIDENCE_KINDS },
  { pointer: "$defs/measurabilityEntry/properties/bucket/enum", expected: SLICE_BUCKETS },
  { pointer: "$defs/profileUnit/enum", expected: SUPPORTED_PROFILE_UNITS },
  { pointer: "$defs/implementedCalculatorId/enum", expected: IMPLEMENTED_CALCULATOR_IDS },
  { pointer: "$defs/sliceNode/properties/gates/items/enum", expected: SUPPORTED_GATE_IDS },
  { pointer: "properties/requiredEvidenceClasses/items/enum", expected: EVIDENCE_CLASSES },
  { pointer: "properties/fidelityCriteria/items/enum", expected: VLM_REVIEW_CRITERION_IDS },
];

test("schema enums equal the closed sets the validator binds against", () => {
  const schema = readSchema();
  const drift: string[] = [];
  for (const { pointer, expected } of ENUM_BINDINGS) {
    const diff = enumDiff(at(schema, pointer), expected);
    if (diff) drift.push(`${pointer}: ${diff}`);
  }
  assert.deepEqual(
    drift,
    [],
    `genre-contract.schema.json drifted from the code it documents:\n${drift.join("\n")}`,
  );
});

test("schemaVersion is pinned to the frozen constant", () => {
  assert.equal(at(readSchema(), "properties/schemaVersion").const, GENRE_CONTRACT_SCHEMA_VERSION);
});

test("LITMUS: the enum comparison actually fires on a schema that disagrees", () => {
  // A binding test that cannot fail is worse than none: it certifies drift. Prove the comparison
  // catches a value dropped from the schema, a value invented in the schema, and a missing enum.
  const truth = [...GENRE_CLASSES];
  assert.equal(enumDiff(truth, GENRE_CLASSES), null, "identical sets must compare equal");
  assert.notEqual(enumDiff(truth.slice(1), GENRE_CLASSES), null, "a dropped value must be caught");
  assert.notEqual(enumDiff([...truth, "arcade"], GENRE_CLASSES), null, "an invented value must be caught");
  assert.notEqual(enumDiff(undefined, GENRE_CLASSES), null, "a missing enum must be caught");
});

/* ------------------------------------------------------------------ required binding */

/**
 * A valid contract with EVERY optional top-level section present, so the derivation below can ask
 * the validator about each one. Any field the validator refuses on absence must be in the schema's
 * `required`; any field it tolerates must not be.
 */
function fullyPopulatedContract(): Json {
  return {
    schemaVersion: GENRE_CONTRACT_SCHEMA_VERSION,
    genreId: "binding-fixture",
    subGenres: ["one"],
    confidence: "experimental",
    targetPlatform: { device: "pc", inputScheme: "kb-mouse", aspect: "16:9", session: "short" },
    networkModel: {
      mode: "single-player",
      netcode: "photon-fusion",
      authority: "host",
      tick: "fixed",
      prediction: "none",
      spPlayable: true,
    },
    coreLoop: { description: "do the thing", perspective: "top-down", subGenre: "one", genreClass: "twitch" },
    artDirection: {
      style: "flat",
      palette: "muted",
      assetRoles: ["player"],
      theme: "sea",
      heroShotMock: "design/hero.png",
    },
    verticalSliceBudget: { coreVerticalContent: { thing: 1 }, deferred: ["roster"] },
    feedbackChains: [{ verb: "move", input: "stick", response: "walks", feedback: "dust" }],
    tunables: [{ id: "moveSpeed", description: "run speed", unit: "u/s" }],
    measurabilityMap: [
      // Deliberately BAND-FREE: `evidenceKind` and `signoff` are required only WHEN a band is
      // present (R6), which is a cross-field rule the schema does not claim. A banded fixture would
      // derive them as unconditionally required and demand the schema lie about it.
      { target: "reload-cadence", tag: "needs-new-calculator", calculator: "a sampler", bucket: "coreVertical" },
    ],
    referenceAnchor: { clips: ["a.mp4"], exemplars: ["Game"], notes: "hand-set" },
    sliceDag: {
      coreVertical: [
        { id: "scene", title: "Scene", dependsOn: [], confidence: "experimental", gates: ["manifest"] },
      ],
      // The node the slice derivation mutates lives HERE, carrying both gates and gaps: R3 requires
      // at least one of them, so a gates-only node would derive `gates` as required and misreport a
      // rule that is genuinely an either-or.
      deferredMeta: [
        {
          id: "meta",
          title: "Meta",
          dependsOn: ["scene"],
          confidence: "experimental",
          gates: ["manifest"],
          gaps: ["deferred-meta"],
          kind: "roster",
        },
      ],
    },
    refusalConditions: [{ condition: "x", reason: "y" }],
    humanOracleChecks: [{ check: "is it fun?", appliesTo: "reload-cadence" }],
    productThesis: {
      statement: "a small thing",
      notThisGame: ["a big thing"],
      deferredFeatures: ["shop"],
      feelDamagingAdditions: ["loading screens"],
    },
    scaleModel: { playerSpeedMps: 5, targetRunSeconds: 120, arenaWidthM: 40 },
    requiredEvidenceClasses: ["console_clean"],
    fidelityCriteria: ["composition-match"],
  };
}

/** Walk a slash-separated path into a contract object (arrays addressed by numeric segment). */
function objectAt(contract: Json, pointer: string): Json {
  if (pointer === "") return contract;
  let node: unknown = contract;
  for (const key of pointer.split("/")) {
    node = Array.isArray(node) ? node[Number(key)] : (node as Json)[key];
  }
  return node as Json;
}

/**
 * The fields the REAL validator refuses on absence at `pointer`, derived by deleting each present
 * key in turn. `unconditional` guards the derivation itself: the fixture must be valid to start
 * with, or "deleting a field caused an issue" would mean nothing.
 */
function validatorRequiredAt(pointer: string): string[] {
  const base = fullyPopulatedContract();
  const baseResult = validateGenreContract(base);
  assert.ok(baseResult.valid, `fixture must be valid: ${JSON.stringify(baseResult.issues)}`);

  const required: string[] = [];
  for (const key of Object.keys(objectAt(base, pointer))) {
    const mutated = fullyPopulatedContract();
    delete objectAt(mutated, pointer)[key];
    if (!validateGenreContract(mutated).valid) required.push(key);
  }
  return required.sort();
}

/** Every object the schema declares a `required` list for, paired with where it lives in a contract. */
const REQUIRED_BINDINGS: Array<{ schemaPointer: string; contractPointer: string }> = [
  { schemaPointer: "", contractPointer: "" },
  { schemaPointer: "properties/targetPlatform", contractPointer: "targetPlatform" },
  { schemaPointer: "properties/networkModel", contractPointer: "networkModel" },
  { schemaPointer: "properties/coreLoop", contractPointer: "coreLoop" },
  { schemaPointer: "properties/artDirection", contractPointer: "artDirection" },
  { schemaPointer: "properties/verticalSliceBudget", contractPointer: "verticalSliceBudget" },
  { schemaPointer: "properties/refusalConditions/items", contractPointer: "refusalConditions/0" },
  { schemaPointer: "properties/humanOracleChecks/items", contractPointer: "humanOracleChecks/0" },
  { schemaPointer: "properties/feedbackChains/items", contractPointer: "feedbackChains/0" },
  { schemaPointer: "properties/tunables/items", contractPointer: "tunables/0" },
  { schemaPointer: "$defs/measurabilityEntry", contractPointer: "measurabilityMap/0" },
  { schemaPointer: "$defs/sliceNode", contractPointer: "sliceDag/deferredMeta/0" },
  { schemaPointer: "properties/productThesis", contractPointer: "productThesis" },
  { schemaPointer: "properties/scaleModel", contractPointer: "scaleModel" },
];

test("schema `required` says exactly what the validator refuses on absence", () => {
  const schema = readSchema();
  const drift: string[] = [];
  for (const { schemaPointer, contractPointer } of REQUIRED_BINDINGS) {
    const node = schemaPointer === "" ? schema : at(schema, schemaPointer);
    const declared = [...((node.required as string[] | undefined) ?? [])].sort();
    const derived = validatorRequiredAt(contractPointer);
    if (declared.join("|") !== derived.join("|")) {
      drift.push(
        `${schemaPointer || "<root>"}: schema requires [${declared.join(", ")}], ` +
          `validator refuses on absence of [${derived.join(", ")}]`,
      );
    }
  }
  assert.deepEqual(drift, [], `genre-contract.schema.json required lists drifted:\n${drift.join("\n")}`);
});

test("LITMUS: the required derivation fires on a schema that under- or over-declares", () => {
  // Prove the derivation is real by disagreeing with it in both directions, in memory.
  const derived = validatorRequiredAt("");
  assert.ok(derived.includes("genreId"), "the validator must refuse a contract with no genreId");
  assert.ok(!derived.includes("fidelityCriteria"), "fidelityCriteria is optional and must derive as such");

  const declared = [...((readSchema().required as string[]) ?? [])].sort();
  assert.equal(declared.join("|"), derived.join("|"), "the shipped schema must already agree");
  assert.notEqual(
    declared.filter((k) => k !== "genreId").join("|"),
    derived.join("|"),
    "dropping a genuinely-required field from the schema must be detected",
  );
  assert.notEqual(
    [...declared, "fidelityCriteria"].sort().join("|"),
    derived.join("|"),
    "promoting an optional field to required in the schema must be detected",
  );
});

/* ------------------------------------------------------------------ structural sanity */

test("every $ref in the schema resolves inside the schema", () => {
  const schema = readSchema();
  const refs: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== "object") return;
    for (const [k, v] of Object.entries(node as Json)) {
      if (k === "$ref" && typeof v === "string") refs.push(v);
      else walk(v);
    }
  };
  walk(schema);
  assert.ok(refs.length > 0, "expected the schema to use $defs");
  for (const ref of refs) {
    assert.ok(ref.startsWith("#/"), `external $ref "${ref}": the schema must be self-contained`);
    at(schema, ref.slice(2));
  }
});

test("the schema documents every property the contract may carry, and no more", () => {
  // additionalProperties:false makes the schema stricter than the validator on purpose (a typo'd
  // field name is otherwise accepted here and only bites at doneness). That is only safe while the
  // property list is complete, so a field the scaffolder or a legacy contract can emit must appear.
  const schema = readSchema();
  assert.equal(schema.additionalProperties, false);
  const documented = new Set(Object.keys(schema.properties as Json));
  for (const key of Object.keys(fullyPopulatedContract())) {
    assert.ok(documented.has(key), `schema does not document the "${key}" field`);
  }
});
