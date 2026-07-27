import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  allSlicesApproved,
  assertValidSlicePlan,
  assertSafeSliceId,
  awaitingApprovalSlices,
  getSliceVerdictPath,
  getSliceVerifyDir,
  instantiateSlicePlan,
  markDependentStale,
  nextUnblockedSlice,
  planDispatchMode,
  SLICES_SCHEMA_VERSION,
  type SliceEntry,
  type SlicePlan,
} from "../../../../capabilities/verification/slices.js";
import { loombridgePaths } from "../../../../domain/state.js";
// Depth-independent: never count `..` to find a root (CLAUDE.md).
import { PKG_ROOT as REPO_PKG_ROOT } from "../../../_support/paths.js";

// The shipped platformer template, read from the source tree. `test:unit` runs
// under npm with cwd = the mcp-server package dir, so this anchors at the JSON
// the decomposer ships regardless of whether the build copies it into dist.
const TEMPLATE_PATH = path.join(
  process.cwd(),
  "src",
  "capabilities",
  "genre",
  "genre-packs",
  "platformer-2d",
  "slices.json",
);

async function loadPlatformerTemplate(): Promise<SlicePlan> {
  const raw = await fs.readFile(TEMPLATE_PATH, "utf-8");
  return JSON.parse(raw) as SlicePlan;
}

/** A tiny valid 3-slice plan: a → b → c. */
function smallPlan(): SlicePlan {
  return {
    schemaVersion: SLICES_SCHEMA_VERSION,
    genre: "platformer-2d",
    slices: [
      { id: "a", title: "A", dependsOn: [], skill: "s", feelIntent: "f", acceptance: { gates: ["manifest"] }, state: "pending" },
      { id: "b", title: "B", dependsOn: ["a"], skill: "s", feelIntent: "f", acceptance: { gates: ["manifest"] }, state: "pending" },
      { id: "c", title: "C", dependsOn: ["b"], skill: "s", feelIntent: "f", acceptance: { gates: ["manifest"] }, state: "pending" },
    ],
  };
}

// ── assertValidSlicePlan ─────────────────────────────────────────────────────

test("assertValidSlicePlan — accepts the shipped platformer template", async () => {
  const template = await loadPlatformerTemplate();
  const plan = assertValidSlicePlan(template);
  assert.equal(plan.slices.length, 9);
});

test("assertValidSlicePlan — accepts a well-formed small plan", () => {
  assert.doesNotThrow(() => assertValidSlicePlan(smallPlan()));
});

test("assertValidSlicePlan — rejects an unknown dependsOn id", () => {
  const plan = smallPlan();
  plan.slices[1]!.dependsOn = ["nope"];
  assert.throws(() => assertValidSlicePlan(plan), /unknown slice id 'nope'/);
});

test("assertValidSlicePlan — rejects a dependency cycle", () => {
  const plan = smallPlan();
  plan.slices[0]!.dependsOn = ["c"]; // a -> c -> b -> a
  assert.throws(() => assertValidSlicePlan(plan), /cycle/);
});

test("assertValidSlicePlan — rejects duplicate ids", () => {
  const plan = smallPlan();
  plan.slices[1]!.id = "a";
  assert.throws(() => assertValidSlicePlan(plan), /duplicated/);
});

test("assertValidSlicePlan — rejects a missing required field", () => {
  // Was asserted on `skill`, which is now OPTIONAL (see the next test). `feelIntent` is still
  // required, so the missing-required-field rule is still covered — the rule did not go away, only
  // the field this test happened to use.
  const plan = smallPlan() as unknown as { slices: Array<Record<string, unknown>> };
  delete plan.slices[0]!.feelIntent;
  assert.throws(() => assertValidSlicePlan(plan), /feelIntent/);
});

test("slices.schema.json `required` agrees with what the validator actually enforces", async () => {
  // The schema is DOCUMENTATION — nothing loads it at runtime, and the hand-rolled validator in
  // slices.ts is the real gate. So the two can silently disagree, and a reader trusting the schema
  // would be wrong. This binds them: every field the schema calls required must actually be refused
  // when missing.
  //
  // It is the check that would have caught this change if only ONE side had been edited: `skill` was
  // dropped from `required` here and made present-only in the validator, and nothing else connected
  // those two edits.
  const schema = JSON.parse(
    await fs.readFile(path.join(REPO_PKG_ROOT, "src/domain/schemas/slices.schema.json"), "utf-8"),
  ) as { $defs: { slice: { required: string[] } } };

  const required = schema.$defs.slice.required;
  assert.ok(required.length > 0, "the slice schema must declare required fields");
  assert.ok(!required.includes("skill"), "`skill` is optional — a slice with no shipped pack omits it");

  for (const field of required) {
    const plan = smallPlan() as unknown as { slices: Array<Record<string, unknown>> };
    delete plan.slices[0]![field];
    assert.throws(
      () => assertValidSlicePlan(plan),
      new RegExp(field),
      `schema calls "${field}" required, but the validator accepts a slice without it`,
    );
  }
});

test("assertValidSlicePlan — `skill` is optional, but a present-but-blank one is refused", () => {
  // "No shipped skill pack covers this slice" is a REAL answer: 18 slices across the two 3D packs
  // are in exactly that position, and the alternative was naming skills that exist nowhere, which
  // `plan` then printed to the agent as the thing to build with.
  const omitted = smallPlan() as unknown as { slices: Array<Record<string, unknown>> };
  delete omitted.slices[0]!.skill;
  assert.doesNotThrow(() => assertValidSlicePlan(omitted));

  // But `""` is not "no binding" — it reads as a binding while naming nothing, which is the same
  // failure in a different costume. Refuse it, so "honest" can never decay into "blank".
  const blank = smallPlan() as unknown as { slices: Array<Record<string, unknown>> };
  blank.slices[0]!.skill = "";
  assert.throws(() => assertValidSlicePlan(blank), /skill/);
});

test("instantiateSlicePlan — an absent skill stays absent (no `undefined` key)", () => {
  // A plain `skill: slice.skill` copy would put a present-but-undefined key on every unbound slice:
  // JSON.stringify drops it on the way to disk, but every in-memory reader still sees the key, so
  // "is this slice bound?" would answer differently depending on who asked.
  const template = smallPlan() as unknown as { slices: Array<Record<string, unknown>> };
  delete template.slices[0]!.skill;
  const instantiated = instantiateSlicePlan(assertValidSlicePlan(template));
  assert.equal("skill" in instantiated.slices[0]!, false);
});

test("assertValidSlicePlan — rejects a non-object document", () => {
  assert.throws(() => assertValidSlicePlan(null), /must be an object/);
});

test("assertValidSlicePlan — rejects an unsupported gate id (the false-green hole)", () => {
  // A typo'd gate id selects NO real gate at verify time → every gate
  // not_applicable → exit 0 having graded nothing. Refuse it at rest.
  const plan = smallPlan();
  plan.slices[0]!.acceptance.gates = ["ui-conformnace"]; // typo of ui-conformance
  assert.throws(() => assertValidSlicePlan(plan), /not a supported gate id/);
});

test("assertValidSlicePlan — accepts every real gate id, incl. frame-integrity", () => {
  const plan = smallPlan();
  plan.slices[0]!.acceptance.gates = ["manifest", "feel", "frame-integrity", "tile-render"];
  assert.doesNotThrow(() => assertValidSlicePlan(plan));
});

test("assertValidSlicePlan — rejects unsafe signoffArtifact paths", () => {
  const plan = smallPlan();
  plan.slices[0]!.proof = {
    runId: "run-a",
    startedAt: "2026-05-31T00:00:00.000Z",
    verdictPath: ".loombridge/reports/slices/a.verdict.json",
    captureManifest: ["a/verify-manifest.json"],
    checkpointId: "a",
    approvedAt: "2026-05-31T01:00:00.000Z",
    signoffArtifact: "../escape.png",
  };
  assert.throws(() => assertValidSlicePlan(plan), /proof\.signoffArtifact/);
});

test("assertValidSlicePlan — rejects an unsafe slice id (path traversal)", () => {
  const plan = smallPlan();
  plan.slices[0]!.id = "../escape";
  // dependsOn 'a' no longer resolves either, but the unsafe-id message must fire.
  assert.throws(() => assertValidSlicePlan(plan), /not a safe slice id/);
});

test("assertValidSlicePlan — rejects an unsafe dependsOn id (path traversal)", () => {
  const plan = smallPlan();
  plan.slices[1]!.dependsOn = ["../escape"];
  assert.throws(() => assertValidSlicePlan(plan), /not a safe slice id/);
});

test("per-slice path builders refuse an unsafe id (backstop below the validator)", () => {
  const paths = loombridgePaths("/tmp/whatever");
  for (const bad of ["../escape", "a/b", "/abs", "..", ""]) {
    assert.throws(() => assertSafeSliceId(bad), /unsafe slice id/);
    assert.throws(() => getSliceVerdictPath(paths, bad), /unsafe slice id/);
    assert.throws(() => getSliceVerifyDir(paths, bad), /unsafe slice id/);
  }
  // A safe id resolves to a path UNDER .loombridge/.
  assert.ok(getSliceVerdictPath(paths, "ground-tiling").endsWith("/reports/slices/ground-tiling.verdict.json"));
  assert.ok(getSliceVerifyDir(paths, "ground-tiling").endsWith("/verify/ground-tiling"));
});

// ── instantiateSlicePlan ─────────────────────────────────────────────────────

test("instantiateSlicePlan — yields 9 pending slices in order, no proof", async () => {
  const template = await loadPlatformerTemplate();
  const plan = instantiateSlicePlan(template);
  assert.equal(plan.slices.length, 9);
  assert.ok(plan.slices.every((s) => s.state === "pending"));
  assert.ok(plan.slices.every((s) => s.proof === undefined));
  assert.deepEqual(
    plan.slices.map((s) => s.id),
    ["framing", "ground-tiling", "player-feel", "parallax", "collectibles", "hazards", "hud", "juice", "end-state"],
  );
});

test("instantiateSlicePlan — deep-copies; mutating the result does not touch the template", async () => {
  const template = await loadPlatformerTemplate();
  const plan = instantiateSlicePlan(template);
  plan.slices[0]!.dependsOn.push("tampered");
  plan.slices[0]!.acceptance.gates.push("tampered");
  assert.ok(!template.slices[0]!.dependsOn.includes("tampered"));
  assert.ok(!template.slices[0]!.acceptance.gates.includes("tampered"));
});

// ── nextUnblockedSlice ───────────────────────────────────────────────────────

test("nextUnblockedSlice — a fresh plan returns the first (framing)", async () => {
  const plan = instantiateSlicePlan(await loadPlatformerTemplate());
  assert.equal(nextUnblockedSlice(plan)?.id, "framing");
});

test("nextUnblockedSlice — after approving framing, returns the next dep-satisfied slice", async () => {
  const plan = instantiateSlicePlan(await loadPlatformerTemplate());
  approve(plan, "framing");
  // ground-tiling (deps: framing ✓) and parallax (deps: framing ✓) both unblock;
  // ground-tiling comes first in DAG order.
  assert.equal(nextUnblockedSlice(plan)?.id, "ground-tiling");
});

test("nextUnblockedSlice — skips a slice whose deps are not all approved", () => {
  const plan = smallPlan();
  // b depends on a (pending) → not unblocked; a itself is the only candidate.
  assert.equal(nextUnblockedSlice(plan)?.id, "a");
});

test("nextUnblockedSlice — a stale slice with approved deps is eligible again", () => {
  const plan = smallPlan();
  approve(plan, "a");
  plan.slices[1]!.state = "stale"; // b was approved then invalidated
  assert.equal(nextUnblockedSlice(plan)?.id, "b");
});

test("nextUnblockedSlice — returns null when all slices are approved", async () => {
  const plan = instantiateSlicePlan(await loadPlatformerTemplate());
  for (const s of plan.slices) s.state = "approved";
  assert.equal(nextUnblockedSlice(plan), null);
});

test("markDependentStale — marks transitive dependents stale and leaves upstream/unrelated alone", () => {
  const plan: SlicePlan = {
    schemaVersion: SLICES_SCHEMA_VERSION,
    genre: "platformer-2d",
    slices: [
      { id: "a", title: "A", dependsOn: [], skill: "s", feelIntent: "f", acceptance: { gates: ["manifest"] }, state: "approved" },
      { id: "b", title: "B", dependsOn: ["a"], skill: "s", feelIntent: "f", acceptance: { gates: ["manifest"] }, state: "approved" },
      { id: "c", title: "C", dependsOn: ["b"], skill: "s", feelIntent: "f", acceptance: { gates: ["manifest"] }, state: "approved" },
      { id: "d", title: "D", dependsOn: ["a"], skill: "s", feelIntent: "f", acceptance: { gates: ["manifest"] }, state: "pending" },
      { id: "x", title: "X", dependsOn: [], skill: "s", feelIntent: "f", acceptance: { gates: ["manifest"] }, state: "approved" },
    ],
  };
  const original = JSON.stringify(plan);

  const next = markDependentStale(plan, "b");

  assert.equal(JSON.stringify(plan), original, "helper is pure");
  assert.equal(next.slices.find((s) => s.id === "a")!.state, "approved", "upstream untouched");
  assert.equal(next.slices.find((s) => s.id === "b")!.state, "approved", "rebuilt slice itself untouched");
  assert.equal(next.slices.find((s) => s.id === "c")!.state, "stale", "transitive dependent stale");
  assert.equal(next.slices.find((s) => s.id === "d")!.state, "pending", "non-dependent untouched");
  assert.equal(next.slices.find((s) => s.id === "x")!.state, "approved", "unrelated untouched");
});

function approve(plan: SlicePlan, id: string): void {
  const slice = plan.slices.find((s) => s.id === id);
  assert.ok(slice, `no slice ${id}`);
  slice.state = "approved";
}

// ── planDispatchMode ─────────────────────────────────────────────────────────

const aSlice: SliceEntry = {
  id: "x", title: "X", dependsOn: [], skill: "s", feelIntent: "f", acceptance: { gates: ["manifest"] }, state: "pending",
};

test("planDispatchMode — no roadmap → design", () => {
  assert.equal(planDispatchMode({ hasRoadmap: false, designApproved: false, nextSlice: aSlice , awaitingApproval: false }), "design");
});

test("planDispatchMode — roadmap exists but design NOT approved → design (A10 tamper guard)", () => {
  // A roadmap + an available next slice, but the design target is unapproved/tampered.
  // Must route back to design, NOT march ahead building against an invalid target.
  assert.equal(planDispatchMode({ hasRoadmap: true, designApproved: false, nextSlice: aSlice , awaitingApproval: false }), "design");
});

test("planDispatchMode — roadmap + a next unblocked slice → plan-slice", () => {
  assert.equal(planDispatchMode({ hasRoadmap: true, designApproved: true, nextSlice: aSlice , awaitingApproval: false }), "plan-slice");
});

test("planDispatchMode — roadmap + no next slice → all-approved", () => {
  assert.equal(planDispatchMode({ hasRoadmap: true, designApproved: true, nextSlice: null , awaitingApproval: false }), "all-approved");
});

// ── rollupDone ───────────────────────────────────────────────────────────────

test("rollupDone — false until all approved, true when all approved", async () => {
  const plan = instantiateSlicePlan(await loadPlatformerTemplate());
  assert.equal(allSlicesApproved(plan), false);
  for (const s of plan.slices.slice(0, -1)) s.state = "approved";
  assert.equal(allSlicesApproved(plan), false, "one slice still pending");
  for (const s of plan.slices) s.state = "approved";
  assert.equal(allSlicesApproved(plan), true);
});

// ── shipped template is schema-valid (the data file the decomposer reads) ─────

test("platformer template — every slice dep resolves + the file is schema-valid", async () => {
  const template = await loadPlatformerTemplate();
  const plan = assertValidSlicePlan(template);
  assert.equal(plan.schemaVersion, SLICES_SCHEMA_VERSION);
  assert.equal(plan.genre, "platformer-2d");
  const ids = new Set(plan.slices.map((s) => s.id));
  for (const s of plan.slices) {
    for (const dep of s.dependsOn) assert.ok(ids.has(dep), `${s.id} -> unknown ${dep}`);
    assert.ok(s.acceptance.gates.includes("console-clean"), `${s.id} lacks console-clean gate`);
  }
});

// ── S1a-review fixes: approval seam, proof-aware naming, proof validation ─────

test("planDispatchMode — a verified-but-unapproved slice blocking the frontier → await-approval (not all-approved)", () => {
  // The HIGH finding: framing verified but not approved makes nextUnblockedSlice
  // null (deps unsatisfied), which previously misread as all-approved and skipped
  // the human approval seam. awaitingApproval must take precedence.
  assert.equal(
    planDispatchMode({ hasRoadmap: true, designApproved: true, nextSlice: null, awaitingApproval: true }),
    "await-approval",
  );
});

test("planDispatchMode — await-approval takes precedence even when a next slice exists", () => {
  assert.equal(
    planDispatchMode({ hasRoadmap: true, designApproved: true, nextSlice: aSlice, awaitingApproval: true }),
    "await-approval",
  );
});

test("awaitingApprovalSlices — returns built/verified slices, not pending/approved/stale", () => {
  const plan = smallPlan();
  plan.slices[0]!.state = "verified";
  plan.slices[1]!.state = "built";
  plan.slices[2]!.state = "approved";
  const ids = awaitingApprovalSlices(plan).map((s) => s.id).sort();
  assert.deepEqual(ids, ["a", "b"]);
});

test("allSlicesApproved — structural only (renamed from rollupDone); true iff every slice approved", () => {
  const plan = smallPlan();
  assert.equal(allSlicesApproved(plan), false);
  for (const s of plan.slices) s.state = "approved";
  assert.equal(allSlicesApproved(plan), true);
});

test("assertValidSlicePlan — validates the proof block: rejects malformed proof", () => {
  // unknown field
  let p = smallPlan() as unknown as { slices: Array<Record<string, unknown>> };
  p.slices[0]!.proof = { runId: "r", bogus: 1 };
  assert.throws(() => assertValidSlicePlan(p), /unknown field 'bogus'/);

  // wrong type
  p = smallPlan() as unknown as { slices: Array<Record<string, unknown>> };
  p.slices[0]!.proof = { runId: 123 };
  assert.throws(() => assertValidSlicePlan(p), /proof\.runId: must be a string/);

  // unsafe capture path (absolute / traversal)
  p = smallPlan() as unknown as { slices: Array<Record<string, unknown>> };
  p.slices[0]!.proof = { captureManifest: ["../escape.json"] };
  assert.throws(() => assertValidSlicePlan(p), /not a safe relative path/);

  // proof not an object
  p = smallPlan() as unknown as { slices: Array<Record<string, unknown>> };
  p.slices[0]!.proof = "nope";
  assert.throws(() => assertValidSlicePlan(p), /proof: must be an object/);
});

test("assertValidSlicePlan — accepts a well-formed proof block", () => {
  const p = smallPlan();
  p.slices[0]!.proof = {
    runId: "run-framing-x",
    startedAt: "2026-05-31T00:00:00.000Z",
    verdictPath: ".loombridge/reports/slices/framing.verdict.json",
    captureManifest: ["framing/verify-manifest.json"],
    checkpointId: "framing",
    approvedAt: null,
  };
  assert.doesNotThrow(() => assertValidSlicePlan(p));
});
