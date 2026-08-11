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
  reopenSlicePlan,
  SLICES_SCHEMA_VERSION,
  SLICE_FIELDS,
  SLICE_HISTORY_FIELDS,
  SLICE_PROOF_FIELDS,
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

test("slices.schema.json and the TS validator declare the SAME property sets, both directions", async () => {
  // The `required` test above binds one direction of one field list. This binds the whole
  // SHAPE, both ways, for all three objects: and it is the guard that was missing when
  // `history` was added: a field present in the schema and unknown to the validator is
  // accepted by a reader trusting the schema and refused at runtime; a field the validator
  // knows and the schema omits is refused by every schema-aware tool, since `slice`,
  // `proof` and `sliceHistoryEntry` all declare `additionalProperties: false`.
  const schema = JSON.parse(
    await fs.readFile(path.join(REPO_PKG_ROOT, "src/domain/schemas/slices.schema.json"), "utf-8"),
  ) as { $defs: Record<string, { properties: Record<string, unknown> }> };

  const pairs: Array<[string, readonly string[], string]> = [
    ["slice", SLICE_FIELDS, "SLICE_FIELDS"],
    ["proof", SLICE_PROOF_FIELDS, "SLICE_PROOF_FIELDS"],
    ["sliceHistoryEntry", SLICE_HISTORY_FIELDS, "SLICE_HISTORY_FIELDS"],
  ];

  for (const [def, tsFields, name] of pairs) {
    const schemaProps = Object.keys(schema.$defs[def]!.properties).sort();
    assert.deepEqual(
      [...tsFields].sort(),
      schemaProps,
      `${name} and slices.schema.json $defs.${def}.properties disagree: a field was added to ` +
        "one home and not the other (the TS interface, the TS validator, and the schema are three homes; all three or none).",
    );
  }
});

test("assertValidSlicePlan: an unknown slice field is REFUSED (closed keys, like proof)", () => {
  // The positive control for the guard above: a hand-edited SLICES.json carrying an
  // invented field (a mistyped `histroy`, a fabricated `approved: true`) must not read as
  // valid while every consumer ignores it.
  const plan = smallPlan() as unknown as { slices: Array<Record<string, unknown>> };
  plan.slices[0]!.histroy = [];
  assert.throws(() => assertValidSlicePlan(plan), /unknown field 'histroy'/);
});

test("assertValidSlicePlan: `history` shape: closed action set, cascade ids, closed keys", () => {
  const ok = smallPlan() as unknown as { slices: Array<Record<string, unknown>> };
  ok.slices[0]!.history = [{ at: "2026-01-01T00:00:00.000Z", action: "reopen", cascade: ["b", "c"] }];
  assert.doesNotThrow(() => assertValidSlicePlan(ok));

  const badAction = smallPlan() as unknown as { slices: Array<Record<string, unknown>> };
  badAction.slices[0]!.history = [{ at: "2026-01-01T00:00:00.000Z", action: "approved-by-hand", cascade: [] }];
  assert.throws(() => assertValidSlicePlan(badAction), /history\[0\]\.action/);

  const badCascade = smallPlan() as unknown as { slices: Array<Record<string, unknown>> };
  badCascade.slices[0]!.history = [{ at: "2026-01-01T00:00:00.000Z", action: "reopen", cascade: ["../escape"] }];
  assert.throws(() => assertValidSlicePlan(badCascade), /not a safe slice id/);

  const missingAt = smallPlan() as unknown as { slices: Array<Record<string, unknown>> };
  missingAt.slices[0]!.history = [{ action: "reopen", cascade: [] }];
  assert.throws(() => assertValidSlicePlan(missingAt), /history\[0\]\.at/);

  const extraKey = smallPlan() as unknown as { slices: Array<Record<string, unknown>> };
  extraKey.slices[0]!.history = [{ at: "2026-01-01T00:00:00.000Z", action: "reopen", cascade: [], by: "me" }];
  assert.throws(() => assertValidSlicePlan(extraKey), /history\[0\]: unknown field 'by'/);
});

test("instantiateSlicePlan: carries `history` through (it rebuilds field by field)", () => {
  // The trap this function has: it reconstructs every entry explicitly, so a field it does
  // not name is silently dropped. An audit trail is the worst kind of field to lose that way.
  const template = smallPlan();
  template.slices[0]!.history = [{ at: "2026-01-01T00:00:00.000Z", action: "reopen", cascade: ["b"] }];
  const fresh = instantiateSlicePlan(template);
  assert.deepEqual(fresh.slices[0]!.history, [{ at: "2026-01-01T00:00:00.000Z", action: "reopen", cascade: ["b"] }]);
  // …by value, not by reference: mutating the copy must not reach back into the template.
  fresh.slices[0]!.history![0]!.cascade.push("c");
  assert.deepEqual(template.slices[0]!.history![0]!.cascade, ["b"]);
});

// ── reopenSlicePlan (the pure transition behind `loombridge reopen`) ──────────

/** a -> b -> c, all approved with full approval artifacts (a TideRunner-shaped chain). */
function approvedPlan(): SlicePlan {
  const plan = smallPlan();
  for (const slice of plan.slices) {
    slice.state = "approved";
    slice.proof = {
      runId: `run-${slice.id}-1`,
      startedAt: "2026-01-01T00:00:00.000Z",
      verdictPath: `.loombridge/run/reports/slices/${slice.id}.verdict.json`,
      captureManifest: [`${slice.id}/verify-manifest.json`],
      checkpointId: slice.id,
      approvedAt: "2026-01-02T00:00:00.000Z",
      approvalNote: "looked right",
      signoffArtifact: `.loombridge/run/reports/slices/${slice.id}/signoff.png`,
      signoffSha256: "a".repeat(64),
    };
  }
  return plan;
}

test("reopenSlicePlan: target goes stale, approval artifacts are CLEARED, cascade follows", () => {
  const before = approvedPlan();
  const result = reopenSlicePlan(before, "a", "2026-02-01T00:00:00.000Z");
  assert.ok(result.ok);

  const byId = new Map(result.plan.slices.map((s) => [s.id, s]));
  for (const id of ["a", "b", "c"]) {
    assert.equal(byId.get(id)!.state, "stale", `${id} must be stale`);
    const proof = byId.get(id)!.proof!;
    // A stale slice carrying approval artifacts is a RE-APPROVAL SHORTCUT: these are
    // exactly the fields `plan --go` and `isSliceDone` read to conclude it was signed off.
    for (const field of ["checkpointId", "approvedAt", "approvalNote", "signoffArtifact", "signoffSha256"] as const) {
      assert.equal(proof[field], undefined, `${id}.proof.${field} must be cleared by a reopen`);
    }
    // The BUILD identity survives: reopening withdraws an approval, it does not forge a
    // new run, and `runId`/`startedAt` are what a later reader binds the old evidence to.
    assert.equal(proof.runId, `run-${id}-1`);
  }

  // The input plan is untouched (pure function).
  assert.equal(before.slices[0]!.state, "approved");
  assert.equal(before.slices[0]!.proof!.approvedAt, "2026-01-02T00:00:00.000Z");
});

test("reopenSlicePlan: records history{at, action, cascade} on the TARGET only", () => {
  const result = reopenSlicePlan(approvedPlan(), "a", "2026-02-01T00:00:00.000Z");
  assert.ok(result.ok);
  const byId = new Map(result.plan.slices.map((s) => [s.id, s]));
  assert.deepEqual(byId.get("a")!.history, [
    { at: "2026-02-01T00:00:00.000Z", action: "reopen", cascade: ["b", "c"] },
  ]);
  assert.equal(byId.get("b")!.history, undefined, "a cascaded slice is not the subject of the event");
  // The written plan must still validate (the schema/validator accept what we emit).
  assert.doesNotThrow(() => assertValidSlicePlan(result.plan));
});

test("reopenSlicePlan: history is APPEND-ONLY across repeated reopens", () => {
  const first = reopenSlicePlan(approvedPlan(), "a", "2026-02-01T00:00:00.000Z");
  assert.ok(first.ok);
  // Re-approve `a` by hand-rolling the state a second build+verify+approve would produce.
  const rebuilt: SlicePlan = {
    ...first.plan,
    slices: first.plan.slices.map((s) =>
      s.id === "a" ? { ...s, state: "approved" as const, proof: { ...s.proof, checkpointId: "a", approvedAt: "2026-02-02T00:00:00.000Z" } } : s,
    ),
  };
  const second = reopenSlicePlan(rebuilt, "a", "2026-02-03T00:00:00.000Z");
  assert.ok(second.ok);
  const history = second.plan.slices.find((s) => s.id === "a")!.history!;
  assert.equal(history.length, 2, "the first reopen must survive the second");
  assert.deepEqual(history.map((h) => h.at), ["2026-02-01T00:00:00.000Z", "2026-02-03T00:00:00.000Z"]);
});

test("reopenSlicePlan: reports every touched slice with its PRIOR state, target first", () => {
  const plan = approvedPlan();
  plan.slices[1]!.state = "built"; // b is mid-flight when a is reopened
  const result = reopenSlicePlan(plan, "a", "2026-02-01T00:00:00.000Z");
  assert.ok(result.ok);
  assert.deepEqual(
    result.touched.map((t) => ({ id: t.id, priorState: t.priorState, target: t.target })),
    [
      { id: "a", priorState: "approved", target: true },
      { id: "b", priorState: "built", target: false },
      { id: "c", priorState: "approved", target: false },
    ],
  );
  // Dependencies before dependents, so the operator never re-verifies against evidence
  // that does not exist yet.
  assert.deepEqual(result.reverifyChain, ["a", "b", "c"]);
});

test("reopenSlicePlan: the re-verify chain is DAG order, not array order", () => {
  // Same graph, authored out of order. A chain read off the array would print c before a.
  const plan: SlicePlan = {
    schemaVersion: SLICES_SCHEMA_VERSION,
    genre: "platformer-2d",
    slices: [
      { id: "c", title: "C", dependsOn: ["b"], feelIntent: "f", acceptance: { gates: ["manifest"] }, state: "approved" },
      { id: "b", title: "B", dependsOn: ["a"], feelIntent: "f", acceptance: { gates: ["manifest"] }, state: "approved" },
      { id: "a", title: "A", dependsOn: [], feelIntent: "f", acceptance: { gates: ["manifest"] }, state: "approved" },
    ],
  };
  const result = reopenSlicePlan(plan, "a", "2026-02-01T00:00:00.000Z");
  assert.ok(result.ok);
  assert.deepEqual(result.reverifyChain, ["a", "b", "c"]);
});

test("reopenSlicePlan: refuses an unknown slice, and states 'nothing to reopen' for stale/pending", () => {
  const unknown = reopenSlicePlan(approvedPlan(), "nope", "2026-02-01T00:00:00.000Z");
  assert.equal(unknown.ok, false);
  assert.equal(unknown.ok === false ? unknown.reason : null, "unknown-slice");
  assert.deepEqual(unknown.ok === false && unknown.reason === "unknown-slice" ? unknown.knownIds : [], ["a", "b", "c"]);

  for (const state of ["stale", "pending"] as const) {
    const plan = approvedPlan();
    plan.slices[0]!.state = state;
    const result = reopenSlicePlan(plan, "a", "2026-02-01T00:00:00.000Z");
    assert.equal(result.ok, false, `${state} has nothing to reopen`);
    assert.equal(result.ok === false ? result.reason : null, "nothing-to-reopen");
  }
});

test("reopenSlicePlan: a `built` target IS reopenable (in-flight work is a state to withdraw)", () => {
  const plan = approvedPlan();
  plan.slices[0]!.state = "built";
  const result = reopenSlicePlan(plan, "a", "2026-02-01T00:00:00.000Z");
  assert.ok(result.ok);
  assert.equal(result.touched[0]!.priorState, "built");
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
    verdictPath: ".loombridge/run/reports/slices/a.verdict.json",
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
    verdictPath: ".loombridge/run/reports/slices/framing.verdict.json",
    captureManifest: ["framing/verify-manifest.json"],
    checkpointId: "framing",
    approvedAt: null,
  };
  assert.doesNotThrow(() => assertValidSlicePlan(p));
});
