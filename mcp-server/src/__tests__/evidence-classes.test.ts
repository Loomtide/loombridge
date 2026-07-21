/**
 * Evidence-class verification reporting (dogfood learnings §6 / backlog High #7).
 *
 * Covers the three additive layers:
 *  1. `deriveEvidenceClasses` — the fixed-enum block is ALWAYS emitted; an unwired
 *     class reads `absent` / `no-producer`; a wired class reads its gate's signal
 *     (present / absent-on-degraded / partial), never omitted.
 *  2. `evidenceClassRefusals` — the doneness anti-compression gate: a
 *     contract-declared required class that is not `present` (absent / partial /
 *     omitted / no-block / unknown) is a REFUSAL, not a skip.
 *  3. validator — an unknown `verification.requiredEvidenceClasses` name is a
 *     validation refusal; the fixed enum is accepted; backward compat holds.
 *  + an end-to-end `runVerify` → `wholeGameDonenessReasons` integration proving the
 *    block reaches build-verdict.json and gates doneness only when the contract asks.
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  EVIDENCE_CLASSES,
  EVIDENCE_CLASS_PRODUCERS,
  deriveEvidenceClasses,
  type EvidenceVerdictView,
} from "../verification/gates/evidence-classes.js";
import {
  evidenceClassRefusals,
  isProjectDone,
  readRequiredEvidenceClasses,
  runDoneness,
  wholeGameDonenessReasons,
  type VerdictLike,
} from "../loombridge/doneness.js";
import { validateAcceptanceContract } from "../verification/validator.js";
import { runPlan } from "../loombridge/plan.js";
import { runVerify } from "../loombridge/verify.js";
import { loombridgePaths } from "../loombridge/state.js";
import type { GateCheck, CheckStatus } from "../verification/gates/types.js";

async function tmpRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "loombridge-evidence-"));
}

/** Build a minimal verdict view: a real check per gate + a status map. */
function viewFrom(gates: Record<string, CheckStatus>, checks: GateCheck[] = []): EvidenceVerdictView {
  return { gates, checks };
}

function check(id: string, actual: string, status: CheckStatus = "warn"): GateCheck {
  return { id, expected: "x", actual, status, detail: "d" };
}

// ── 1. deriveEvidenceClasses ─────────────────────────────────────────────────

test("deriveEvidenceClasses ALWAYS emits every class (refuse-not-skip: absence is visible)", () => {
  // An empty verdict — no gates ran at all.
  const block = deriveEvidenceClasses(viewFrom({}));
  assert.deepEqual(Object.keys(block).sort(), [...EVIDENCE_CLASSES].sort());
  for (const cls of EVIDENCE_CLASSES) {
    assert.ok(block[cls], `class ${cls} present in block`);
    assert.ok(typeof block[cls].status === "string");
    assert.ok(typeof block[cls].source === "string");
  }
});

test("an unwired class reads absent / no-producer (never omitted)", () => {
  const block = deriveEvidenceClasses(viewFrom({ "console-clean": "pass" }));
  for (const cls of ["compile_import", "telemetry", "human_notes"] as const) {
    assert.equal(EVIDENCE_CLASS_PRODUCERS[cls].length, 0, `${cls} has no producer wired`);
    assert.deepEqual(block[cls], { status: "absent", source: "no-producer" });
  }
});

test("a wired class reads present when its producing gate gathered real evidence", () => {
  const block = deriveEvidenceClasses(
    viewFrom({ "console-clean": "pass", manifest: "warn", playability: "fail", feel: "pass" }),
  );
  assert.deepEqual(block.console_clean, { status: "present", source: "gate:console-clean" });
  // scene_validation <- manifest (a WARN still means the signal was gathered).
  assert.deepEqual(block.scene_validation, { status: "present", source: "gate:manifest" });
  // play_trace <- playability (a FAIL still means the play trace RAN — evidence exists).
  assert.deepEqual(block.play_trace, { status: "present", source: "gate:playability" });
  assert.deepEqual(block.input_exercised, { status: "present", source: "gate:feel" });
});

test("a wired class reads absent when its capture is MISSING (degraded gate = timed-out trace)", () => {
  // console-clean present in the report as a degraded WARN with the input-missing marker.
  const block = deriveEvidenceClasses(
    viewFrom({ "console-clean": "warn" }, [check("console-clean.input", "(missing)")]),
  );
  assert.equal(block.console_clean.status, "absent");
  assert.match(block.console_clean.source, /capture missing/);
});

test("a not_applicable producer reads absent (deliberately N/A, NOT partial)", () => {
  const block = deriveEvidenceClasses(viewFrom({ manifest: "not_applicable" }));
  assert.equal(block.scene_validation.status, "absent");
  assert.match(block.scene_validation.source, /not_applicable/);
});

test("a class with a MIX of gathered + capture-missing producers reads partial", () => {
  // frame_evidence <- [render-frame, frame-integrity]: one gathered, one missing.
  const block = deriveEvidenceClasses(
    viewFrom(
      { "render-frame": "pass", "frame-integrity": "warn" },
      [check("frame-integrity.input", "(missing)")],
    ),
  );
  assert.equal(block.frame_evidence.status, "partial");
  assert.match(block.frame_evidence.source, /gate:render-frame/);
  assert.match(block.frame_evidence.source, /capture missing/);
});

test("frame_evidence is present on render-frame alone when frame-integrity was not run (no --vlm)", () => {
  const block = deriveEvidenceClasses(viewFrom({ "render-frame": "pass" }));
  assert.equal(block.frame_evidence.status, "present");
  assert.match(block.frame_evidence.source, /gate:frame-integrity \(not run\)/);
});

// ── 2. evidenceClassRefusals (the doneness anti-compression gate) ─────────────

// A COHERENT verdict: the stored block AGREES with its own gates (re-derivation).
const presentBlockVerdict: VerdictLike = {
  status: "pass",
  gates: { "console-clean": "pass", manifest: "pass" },
  checks: [],
  evidenceClasses: {
    console_clean: { status: "present", source: "gate:console-clean" },
    scene_validation: { status: "present", source: "gate:manifest" },
  },
};

test("no required classes ⇒ no refusals (backward compat)", () => {
  assert.deepEqual(evidenceClassRefusals([], presentBlockVerdict), []);
});

test("all required classes present ⇒ no refusals", () => {
  assert.deepEqual(evidenceClassRefusals(["console_clean", "scene_validation"], presentBlockVerdict), []);
});

test("a required class reported absent ⇒ refuse", () => {
  const v: VerdictLike = { evidenceClasses: { play_trace: { status: "absent", source: "gate:playability (capture missing)" } } };
  const reasons = evidenceClassRefusals(["play_trace"], v);
  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /play_trace/);
  assert.match(reasons[0], /`absent`/);
});

test("a required class reported partial ⇒ refuse", () => {
  const v: VerdictLike = { evidenceClasses: { frame_evidence: { status: "partial", source: "x" } } };
  const reasons = evidenceClassRefusals(["frame_evidence"], v);
  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /partial/);
});

test("a required class OMITTED from the block ⇒ refuse (absent binding, not skip)", () => {
  const reasons = evidenceClassRefusals(["telemetry"], presentBlockVerdict);
  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /omits it/);
});

test("required classes but NO evidenceClasses block at all ⇒ refuse", () => {
  const reasons = evidenceClassRefusals(["console_clean"], { status: "pass" });
  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /NO `evidenceClasses` block/);
});

test("an unknown required class name ⇒ refuse (can never be satisfied)", () => {
  const reasons = evidenceClassRefusals(["not_a_class"], presentBlockVerdict);
  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /unknown evidence class/);
});

test("evidenceClassRefusals de-dups repeated required class names", () => {
  const reasons = evidenceClassRefusals(["telemetry", "telemetry"], presentBlockVerdict);
  assert.equal(reasons.length, 1);
});

// ── 2b. anti-self-attestation (D1): stored block must match its own evidence ──

test("a HAND-EDITED `present` that re-derives to absent/no-producer is refused (block cannot self-attest)", () => {
  // The exact D1 scenario: a fresh verdict with ONE forged evidenceClasses field.
  const v: VerdictLike = {
    status: "pass",
    gates: { "console-clean": "pass", manifest: "pass" },
    checks: [],
    evidenceClasses: {
      telemetry: { status: "present", source: "telemetry-gate" }, // forged — no producer exists
    },
  };
  const reasons = evidenceClassRefusals(["telemetry"], v);
  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /evidenceClasses\.telemetry claims `present`/);
  assert.match(reasons[0], /re-derivation from this verdict's own gates yields `absent`/);
  assert.match(reasons[0], /no-producer/);
});

test("a stored `present` over a capture-missing (degraded) gate is refused (degraded ≠ gathered)", () => {
  const v: VerdictLike = {
    status: "warn",
    gates: { playability: "warn" },
    checks: [{ id: "playability.input", status: "warn", actual: "(missing)" }],
    evidenceClasses: { play_trace: { status: "present", source: "gate:playability" } }, // forged over a degraded gate
  };
  const reasons = evidenceClassRefusals(["play_trace"], v);
  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /re-derivation/);
});

test("a stored `present` with NO gates block to re-derive from is refused (refuse, not skip)", () => {
  const v: VerdictLike = {
    status: "pass",
    evidenceClasses: { console_clean: { status: "present", source: "gate:console-clean" } },
  };
  const reasons = evidenceClassRefusals(["console_clean"], v);
  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /no usable `gates` block/);
});

test("a stored `present` that AGREES with re-derivation earns no refusal (stricter-union, both green)", () => {
  assert.deepEqual(evidenceClassRefusals(["console_clean", "scene_validation"], presentBlockVerdict), []);
});

// ── 2c. fail-closed contract read (D2): malformed contract cannot disarm ─────

test("readRequiredEvidenceClasses: ENOENT ⇒ [] (absent contract stays other layers' refusal, no gate here)", async () => {
  const read = await readRequiredEvidenceClasses(path.join(os.tmpdir(), "loombridge-evidence-nonexistent", "ACCEPTANCE.json"));
  assert.deepEqual(read, []);
});

test("readRequiredEvidenceClasses: PRESENT-but-unparseable contract ⇒ unreadable sentinel ⇒ explicit refusal", async () => {
  const root = await tmpRoot();
  try {
    const p = path.join(root, "ACCEPTANCE.json");
    await fs.writeFile(p, "{ truncated-not-json", "utf-8");
    const read = await readRequiredEvidenceClasses(p);
    assert.ok(!Array.isArray(read), "malformed contract must NOT read as an empty (disarmed) gate");
    assert.match((read as { unreadable: string }).unreadable, /does not parse/);
    const reasons = evidenceClassRefusals(read, presentBlockVerdict);
    assert.equal(reasons.length, 1);
    assert.match(reasons[0], /contract unreadable — cannot determine required evidence classes/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("readRequiredEvidenceClasses: declared-but-malformed field (non-array / non-string entries) ⇒ unreadable sentinel", async () => {
  const root = await tmpRoot();
  try {
    const p = path.join(root, "ACCEPTANCE.json");
    // key present but wrong type — a hand-edit that would otherwise disarm the gate.
    await fs.writeFile(p, JSON.stringify({ verification: { requiredEvidenceClasses: "console_clean" } }), "utf-8");
    let read = await readRequiredEvidenceClasses(p);
    assert.ok(!Array.isArray(read));
    assert.match((read as { unreadable: string }).unreadable, /declared but malformed/);
    // non-string entries are also malformed, never silently dropped.
    await fs.writeFile(p, JSON.stringify({ verification: { requiredEvidenceClasses: [123] } }), "utf-8");
    read = await readRequiredEvidenceClasses(p);
    assert.ok(!Array.isArray(read));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("readRequiredEvidenceClasses: VALID contract without the key ⇒ [] (by-design opt-out unchanged)", async () => {
  const root = await tmpRoot();
  try {
    const p = path.join(root, "ACCEPTANCE.json");
    await fs.writeFile(p, JSON.stringify({ verification: { gates: {} } }), "utf-8");
    assert.deepEqual(await readRequiredEvidenceClasses(p), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ── 3. validator ─────────────────────────────────────────────────────────────

function baseContractWith(verification: unknown): Record<string, unknown> {
  return {
    schemaVersion: 1,
    game: "evidence-fixture",
    fonts: { minPx: 10 },
    palette: { entries: [] },
    hud: { elements: [] },
    framing: {},
    feel: {},
    juice: {},
    manifest: { elements: [] },
    win: {},
    verification,
  };
}

test("validator ACCEPTS a requiredEvidenceClasses list of known enum members", () => {
  const result = validateAcceptanceContract(
    baseContractWith({ requiredEvidenceClasses: ["console_clean", "scene_validation"] }),
  );
  assert.equal(
    result.issues.some((i) => i.path.startsWith("verification.requiredEvidenceClasses")),
    false,
    "no evidence-class validation issue for known members",
  );
});

test("validator REFUSES an unknown evidence-class name", () => {
  const result = validateAcceptanceContract(
    baseContractWith({ requiredEvidenceClasses: ["console_clean", "made_up_class"] }),
  );
  const issue = result.issues.find((i) => i.path === "verification.requiredEvidenceClasses[1]");
  assert.ok(issue, "an unknown class name is flagged");
  assert.equal(issue!.code, "INVALID_VERIFICATION");
  assert.match(issue!.message, /not a known evidence class/);
});

test("validator REFUSES a non-array requiredEvidenceClasses", () => {
  const result = validateAcceptanceContract(
    baseContractWith({ requiredEvidenceClasses: "console_clean" }),
  );
  assert.ok(
    result.issues.some(
      (i) => i.path === "verification.requiredEvidenceClasses" && i.code === "INVALID_VERIFICATION",
    ),
  );
});

test("validator: absent requiredEvidenceClasses is fine (backward compat)", () => {
  const withGatesOnly = validateAcceptanceContract(baseContractWith({ gates: { feel: "not_applicable" } }));
  assert.equal(
    withGatesOnly.issues.some((i) => i.path.startsWith("verification.requiredEvidenceClasses")),
    false,
  );
});

// ── 4. end-to-end: block in build-verdict.json + doneness gating ─────────────

/** Inject requiredEvidenceClasses into the runPlan-seeded ACCEPTANCE.json. */
async function injectRequired(root: string, classes: string[]): Promise<void> {
  const paths = loombridgePaths(root);
  const contract = JSON.parse(await fs.readFile(paths.acceptance, "utf-8")) as Record<string, unknown>;
  const verification = (contract.verification as Record<string, unknown> | undefined) ?? {};
  verification.requiredEvidenceClasses = classes;
  contract.verification = verification;
  await fs.writeFile(paths.acceptance, `${JSON.stringify(contract, null, 2)}\n`, "utf-8");
}

test("runVerify writes the evidenceClasses block into build-verdict.json (all classes, honest sources)", async () => {
  const root = await tmpRoot();
  try {
    await runPlan({ root, genre: "platformer-2d", engine: "unity", force: false, allowMissingDesignTarget: true });
    const paths = loombridgePaths(root);
    // Stage a CLEAN console capture so console_clean reads present.
    await fs.mkdir(paths.verifyInputs, { recursive: true });
    await fs.writeFile(path.join(paths.verifyInputs, "console.json"), JSON.stringify({ logs: [] }), "utf-8");

    await runVerify({
      root,
      inputsDir: paths.verifyInputs,
      acceptancePath: paths.acceptance,
      outputPath: paths.verdict,
      strict: false,
    });

    const verdict = JSON.parse(await fs.readFile(paths.verdict, "utf-8"));
    assert.ok(verdict.evidenceClasses, "verdict carries an evidenceClasses block");
    assert.deepEqual(Object.keys(verdict.evidenceClasses).sort(), [...EVIDENCE_CLASSES].sort());
    assert.equal(verdict.evidenceClasses.console_clean.status, "present");
    // Unwired classes are honestly absent / no-producer — never omitted.
    assert.deepEqual(verdict.evidenceClasses.telemetry, { status: "absent", source: "no-producer" });
    assert.deepEqual(verdict.evidenceClasses.compile_import, { status: "absent", source: "no-producer" });
    assert.deepEqual(verdict.evidenceClasses.human_notes, { status: "absent", source: "no-producer" });
    // reads back from disk exactly what doneness would consume.
    const required = await readRequiredEvidenceClasses(paths.acceptance);
    assert.deepEqual(required, [], "no requiredEvidenceClasses seeded ⇒ empty");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("doneness REFUSES when the contract requires an ABSENT evidence class, PASSES the gate when present", async () => {
  const root = await tmpRoot();
  try {
    await runPlan({ root, genre: "platformer-2d", engine: "unity", force: false, allowMissingDesignTarget: true });
    const paths = loombridgePaths(root);
    await fs.mkdir(paths.verifyInputs, { recursive: true });
    await fs.writeFile(path.join(paths.verifyInputs, "console.json"), JSON.stringify({ logs: [] }), "utf-8");
    await runVerify({
      root,
      inputsDir: paths.verifyInputs,
      acceptancePath: paths.acceptance,
      outputPath: paths.verdict,
      strict: false,
    });

    const evidenceRefusal = /evidence class/;

    // (a) require a class the pipeline has no producer for → doneness must refuse.
    await injectRequired(root, ["telemetry"]);
    let out = await wholeGameDonenessReasons(paths);
    assert.ok(
      out.reasons.some((r) => evidenceRefusal.test(r) && /telemetry/.test(r)),
      `expected a telemetry evidence refusal, got: ${JSON.stringify(out.reasons)}`,
    );

    // (b) require ONLY a present class → NO evidence-class refusal is added.
    await injectRequired(root, ["console_clean"]);
    out = await wholeGameDonenessReasons(paths);
    assert.equal(
      out.reasons.some((r) => evidenceRefusal.test(r)),
      false,
      `console_clean is present ⇒ no evidence refusal, got: ${JSON.stringify(out.reasons)}`,
    );

    // (c) backward compat: no requiredEvidenceClasses → no evidence-class refusal.
    await injectRequired(root, []);
    out = await wholeGameDonenessReasons(paths);
    assert.equal(out.reasons.some((r) => evidenceRefusal.test(r)), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("doneness REFUSES a real verdict whose evidenceClasses block was hand-edited to claim `present` (D1, end-to-end)", async () => {
  const root = await tmpRoot();
  try {
    await runPlan({ root, genre: "platformer-2d", engine: "unity", force: false, allowMissingDesignTarget: true });
    const paths = loombridgePaths(root);
    await fs.mkdir(paths.verifyInputs, { recursive: true });
    await fs.writeFile(path.join(paths.verifyInputs, "console.json"), JSON.stringify({ logs: [] }), "utf-8");
    await runVerify({
      root,
      inputsDir: paths.verifyInputs,
      acceptancePath: paths.acceptance,
      outputPath: paths.verdict,
      strict: false,
    });
    await injectRequired(root, ["telemetry"]);

    // Forge ONE field of the freshly-written verdict: telemetry → present.
    const verdict = JSON.parse(await fs.readFile(paths.verdict, "utf-8"));
    verdict.evidenceClasses.telemetry = { status: "present", source: "telemetry-gate" };
    await fs.writeFile(paths.verdict, `${JSON.stringify(verdict, null, 2)}\n`, "utf-8");

    const out = await wholeGameDonenessReasons(paths);
    assert.ok(
      out.reasons.some((r) => /evidenceClasses\.telemetry claims `present` but re-derivation/.test(r)),
      `expected the self-attestation divergence refusal, got: ${JSON.stringify(out.reasons)}`,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a truncated ACCEPTANCE.json refuses on BOTH doneness surfaces (runDoneness CLI + isProjectDone) — D2", async () => {
  const root = await tmpRoot();
  try {
    await runPlan({ root, genre: "platformer-2d", engine: "unity", force: false, allowMissingDesignTarget: true });
    const paths = loombridgePaths(root);
    await injectRequired(root, ["console_clean"]);
    // Corrupt the contract AFTER the gate was declared — this must not disarm it.
    await fs.writeFile(paths.acceptance, "{ \"schemaVersion\": 1, \"game\": \"trunc", "utf-8");

    const code = await runDoneness({ root });
    assert.equal(code, 1, "runDoneness must refuse on a malformed contract (fail-closed)");
    const done = await isProjectDone(paths);
    assert.equal(done, false, "isProjectDone must agree with runDoneness on a malformed contract");

    // And the refusal is explicit about the evidence gate being un-determinable.
    const { reasons } = await wholeGameDonenessReasons(paths);
    assert.ok(
      reasons.some((r) => /contract unreadable — cannot determine required evidence classes/.test(r)),
      `expected the unreadable-contract evidence refusal, got: ${JSON.stringify(reasons)}`,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
