/**
 * THE ROLL-UP DOOR (stage 4): evidence shas in the verdict, re-grading, contract
 * coverage, run binding, and the anchoring decision.
 *
 * Every test here is a LITMUS in the repo's sense: break one thing, observe the exact
 * refusal, restore it, observe green. A guard that only ever sees the broken state
 * proves the message exists; a guard that only ever sees the green state proves
 * nothing at all.
 *
 * The fixture is a REAL end-to-end slice: a minimal-but-valid acceptance contract, a
 * real `loombridge verify --slice` run that mints the verdict (including its evidence
 * ledger), a human approval stamped on the proof, and then the roll-up reading exactly
 * what that run left on disk. Nothing hand-writes a verdict, so the tests cannot drift
 * from the shape the product actually produces.
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runVerify } from "../../../../capabilities/verification/verify.js";
import { evaluateSliceRollup } from "../../../../capabilities/verification/slice-rollup.js";
import { runUnifiedVerify } from "../../../../capabilities/verification/unified/orchestrator.js";
import { assertValidAcceptanceContract } from "../../../../capabilities/verification/validator.js";
import {
  getSliceVerdictPath,
  getSliceVerifyDir,
  readSlicePlan,
  writeSlicePlan,
  type SlicePlan,
} from "../../../../capabilities/verification/slices.js";
import {
  ensureScaffold,
  loombridgePaths,
  nowIso,
  readState,
  writeState,
  type LoombridgePaths,
} from "../../../../domain/state.js";
import { producedPlayabilityEvidence } from "../../../_support/playability-fixture.js";

const RUN_ID = "run-rollup-1";
const STARTED_AT = "2026-07-29T00:00:00.000Z";
const SESSION = "editor-session-A";

/**
 * The smallest contract the validator accepts that still declares four sections with
 * REQUIRED CONTENT: `manifest` (elements are mandatory in every valid contract),
 * `framing`, `feel`, and `win`. Four sections, four covering gates — which is what
 * makes the coverage LITMUS below a one-line change rather than a rewrite.
 */
function minimalContract(): Record<string, unknown> {
  return {
    schemaVersion: "1",
    game: "rollup-fixture",
    fonts: {},
    palette: { entries: [] },
    hud: { elements: [] },
    framing: {
      aspect: { w: 16, h: 9 },
      cameraMode: "static",
      playerAnchor: { centerXFraction: 0.4, tolerance: 0.1 },
    },
    feel: { runSpeed: { target: 8, unit: "u/s", band: { percent: 10 } } },
    juice: {},
    manifest: { matching: "exact", elements: [{ name: "Player", type: "GameObject", required: true }] },
    win: { rule: "all-fruit" },
    // The observer's seam (M14): how the recipe REACHES this game. Required for the
    // playability gate to re-check the win rule against the recording.
    harness: {
      playability: {
        playerLocator: "Level:/Player",
        stateLocator: "Level:/GameManager",
        stateComponent: "GameManager",
        fields: { win: "isWin", score: "score", lives: "lives" },
        winRule: "all-collectibles",
        collectibles: { namePattern: "Apple" },
        keys: { moveRight: "D", restart: "R" },
      },
    },
  };
}

const GREEN_GATES = ["manifest", "framing", "feel", "playability"];

function evidenceFiles(opts: {
  contract: unknown;
  playabilityRunId?: string;
  playabilitySession?: string;
  feelProducerSession?: string;
}): Record<string, unknown> {
  const files: Record<string, unknown> = {
    "verify-manifest.json": { missing: [], placeholders: [], extras: [], all_ok: true },
    "screen-rects.json": {
      camera: { name: "Main Camera", orthographic: true },
      objects: [{ name: "Player", centerXFraction: 0.4, isPartiallyClipped: false }],
    },
    "feel.json": opts.feelProducerSession
      ? {
          runSpeed: 8,
          _provenance: {
            writer: "loombridge-capture",
            recipe: "feel",
            runId: RUN_ID,
            editorSessionId: opts.feelProducerSession,
          },
        }
      : { runSpeed: 8 },
    "playability.json": producedPlayabilityEvidence({
      contract: opts.contract,
      contractWinRule: "all-fruit",
      runId: opts.playabilityRunId ?? RUN_ID,
      editorSessionId: opts.playabilitySession ?? SESSION,
    }),
  };
  return files;
}

async function tmpRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "loombridge-rollup-"));
}

function planWith(gates: string[], state: "built" | "approved"): SlicePlan {
  return {
    schemaVersion: "1",
    genre: "platformer-2d",
    slices: [
      {
        id: "core",
        title: "Core slice",
        dependsOn: [],
        feelIntent: "runs, collects, wins",
        acceptance: { gates },
        state,
        proof: {
          runId: RUN_ID,
          startedAt: STARTED_AT,
          verdictPath: ".loombridge/run/reports/slices/core.verdict.json",
          captureManifest: ["core/verify-manifest.json", "core/screen-rects.json", "core/feel.json", "core/playability.json"],
          checkpointId: state === "approved" ? "core" : null,
          approvedAt: state === "approved" ? "2026-07-30T00:00:00.000Z" : null,
        },
      },
    ],
  };
}

interface Fixture {
  root: string;
  paths: LoombridgePaths;
  contract: Record<string, unknown>;
  sliceDir: string;
}

/**
 * Build a project, run the REAL `verify --slice`, then stamp the human approval. The
 * roll-up under test therefore reads a verdict the product minted, ledger and all.
 */
async function approvedFixture(
  opts: {
    gates?: string[];
    manifestElements?: unknown[];
    playabilityRunId?: string;
    playabilitySession?: string;
    feelProducerSession?: string;
    expectVerifyExit?: number;
  } = {},
): Promise<Fixture> {
  const root = await tmpRoot();
  const paths = loombridgePaths(root);
  await ensureScaffold(paths);
  const contract = minimalContract();
  if (opts.manifestElements) {
    (contract.manifest as Record<string, unknown>).elements = opts.manifestElements;
  }
  assertValidAcceptanceContract(contract);
  await fs.writeFile(paths.acceptance, `${JSON.stringify(contract, null, 2)}\n`, "utf-8");

  const gates = opts.gates ?? GREEN_GATES;
  await writeSlicePlan(paths, planWith(gates, "built"));
  await writeState(paths, {
    genre: "platformer-2d",
    engine: "unity",
    phase: "built-unverified",
    currentBuild: { runId: RUN_ID, startedAt: STARTED_AT },
    lastVerdict: null,
    updatedAt: nowIso(),
  });

  const sliceDir = getSliceVerifyDir(paths, "core");
  await fs.mkdir(sliceDir, { recursive: true });
  for (const [name, data] of Object.entries(evidenceFiles({ contract, ...opts }))) {
    await fs.writeFile(path.join(sliceDir, name), `${JSON.stringify(data, null, 2)}\n`, "utf-8");
  }

  const code = await runVerify({
    root,
    inputsDir: paths.verifyInputs,
    inputsExplicit: false,
    acceptancePath: paths.acceptance,
    outputPath: paths.verdict,
    strict: false,
    slice: "core",
  });
  assert.equal(code, opts.expectVerifyExit ?? 0, "the fixture slice verify must land where the test expects");
  if ((opts.expectVerifyExit ?? 0) === 0) {
    // The human checkpoint: this is the frozen anchor the roll-up compares against.
    const plan = (await readSlicePlan(paths))!;
    plan.slices[0]!.state = "approved";
    plan.slices[0]!.proof!.approvedAt = "2026-07-30T00:00:00.000Z";
    await writeSlicePlan(paths, plan);
  }
  return { root, paths, contract, sliceDir };
}

async function rollUp(fixture: Fixture) {
  const plan = (await readSlicePlan(fixture.paths))!;
  return evaluateSliceRollup({
    root: fixture.root,
    paths: fixture.paths,
    acceptance: assertValidAcceptanceContract(
      JSON.parse(await fs.readFile(fixture.paths.acceptance, "utf-8")),
    ),
    plan,
  });
}

async function cleanup(fixture: Fixture): Promise<void> {
  await fs.rm(fixture.root, { recursive: true, force: true });
}

// ── S4a: the verdict records what it graded ──────────────────────────────────

test("verify --slice mints an evidence sha + a re-derived origin per graded file (H3/M18)", async () => {
  const fixture = await approvedFixture();
  try {
    const verdict = JSON.parse(await fs.readFile(getSliceVerdictPath(fixture.paths, "core"), "utf-8"));
    const ledger = verdict.evidence;
    assert.ok(ledger, "the verdict carries an evidence ledger");
    assert.deepEqual(
      ledger.files.map((f: { file: string }) => f.file).sort(),
      ["feel.json", "playability.json", "screen-rects.json", "verify-manifest.json"],
      "every file the gates read is ledgered",
    );
    for (const file of ledger.files) {
      assert.match(file.sha256, /^[a-f0-9]{64}$/, `${file.file} carries a real sha`);
    }
    const playability = ledger.files.find((f: { file: string }) => f.file === "playability.json");
    assert.equal(playability.evidenceOrigin, "observed", "the observer's own recording makes it OBSERVED, not produced");
    assert.equal(playability.runId, RUN_ID);
    assert.equal(playability.editorSessionId, SESSION);
    const manifest = ledger.files.find((f: { file: string }) => f.file === "verify-manifest.json");
    assert.equal(manifest.evidenceOrigin, "agent-assembled", "no producer marker: stated, never omitted");
    assert.equal(manifest.writer, null);
  } finally {
    await cleanup(fixture);
  }
});

test("a verdict with NO evidence ledger is REFUSED by the roll-up; no legacy path (H3)", async () => {
  const fixture = await approvedFixture();
  try {
    // POSITIVE CONTROL first: the untouched verdict rolls up green.
    assert.equal((await rollUp(fixture)).exit, 0, "control: the minted verdict rolls up green");

    // BREAK: strip the ledger, exactly as a verdict minted before stage 4 would read.
    const verdictPath = getSliceVerdictPath(fixture.paths, "core");
    const verdict = JSON.parse(await fs.readFile(verdictPath, "utf-8"));
    const ledger = verdict.evidence;
    delete verdict.evidence;
    await fs.writeFile(verdictPath, `${JSON.stringify(verdict, null, 2)}\n`, "utf-8");

    const broken = await rollUp(fixture);
    assert.equal(broken.exit, 2, "harness tier: a statement about the evidence, not a game defect");
    assert.ok(
      broken.refusals.some((r) => r.includes("records NO evidence shas") && r.includes("verify --root")),
      broken.refusals.join(" | "),
    );

    // RESTORE.
    verdict.evidence = ledger;
    await fs.writeFile(verdictPath, `${JSON.stringify(verdict, null, 2)}\n`, "utf-8");
    assert.equal((await rollUp(fixture)).exit, 0, "restored: green again");
  } finally {
    await cleanup(fixture);
  }
});

// ── L107: the stale-approval refusal, at door level ──────────────────────────

test("LITMUS L107: one mutated evidence byte makes the roll-up REFUSE, naming the file and the slice", async () => {
  const fixture = await approvedFixture();
  try {
    const before = await rollUp(fixture);
    assert.equal(before.exit, 0, "control: approved and green");
    assert.equal(before.anchored, true, "M17: a re-graded green with full coverage IS an anchored comparison");

    // BREAK: one byte. `runSpeed: 8` -> `runSpeed: 8.0001` still passes the feel band,
    // so ONLY the sha binding can notice — which is the whole point.
    const feelPath = path.join(fixture.sliceDir, "feel.json");
    const original = await fs.readFile(feelPath, "utf-8");
    await fs.writeFile(feelPath, original.replace('"runSpeed": 8', '"runSpeed": 8.0001'), "utf-8");

    const stale = await rollUp(fixture);
    assert.equal(stale.exit, 2);
    assert.equal(stale.anchored, false);
    const refusal = stale.refusals.find((r) => r.includes("feel.json") && r.includes("CHANGED"));
    assert.ok(refusal, stale.refusals.join(" | "));
    assert.ok(refusal!.includes("slice core"), "the refusal names the SLICE, not just the file");
    assert.ok(refusal!.includes("--slice core"), "…and the exact re-verify command");

    // RESTORE.
    await fs.writeFile(feelPath, original, "utf-8");
    const after = await rollUp(fixture);
    assert.equal(after.exit, 0, "restored byte: the approval binds again");
  } finally {
    await cleanup(fixture);
  }
});

/*
 * THE COUNTING GUARD (the audit's Finding 6), and WHY THE TEST ABOVE MISSED IT.
 *
 * The L107 test above mutates a byte and watches `staleEvidenceRefusals` catch it. That
 * proves the check works ON THE FILES THE LEDGER NAMES. Nothing asked how many files the
 * ledger was supposed to name: `readEvidenceLedger` refuses an ABSENT `evidence` block but
 * accepts `files: []`, and `staleEvidenceRefusals` iterates `ledger.files`, so a ledger
 * with no entries re-hashed nothing, refused nothing, and certified. The rule the module
 * documents ("An ABSENT ledger is a REFUSAL, not a legacy path") was implemented for the
 * block and not for its contents.
 *
 * Same suite-wide pattern as the screen-contract hole: the tests ask "does this check
 * produce the right refusal when it runs?" and never "over how many files did it run?".
 *
 * This is the audit's demonstration exactly: mutate a graded evidence byte INSIDE the
 * passing band (so the re-grade still reproduces the stored verdict and the only thing
 * that could notice is the sha binding), then trim `evidence.files` from 4 to 0. Before
 * the fix the roll-up went from `exit 2 / refused` to `exit 0 / pass / anchored: true`.
 *
 * LITMUS, run 2026-08-12. The `evidenceCoverageRefusals` push deleted from
 * `rollUpOneSlice` (the real path, driven through `evaluateSliceRollup`), rebuilt,
 * re-run:
 *
 *   ✖ MOAT: an EMPTY evidence ledger cannot certify a mutated slice (the counting guard)
 *     AssertionError [ERR_ASSERTION]: `files: []` means NOTHING was re-hashed: that is a harness refusal, never exit 0
 *
 *     0 !== 2
 *
 *   ℹ pass 16
 *   ℹ fail 1
 *
 * Restored: 17 pass, 0 fail.
 */
test("MOAT: an EMPTY evidence ledger cannot certify a mutated slice (the counting guard)", async () => {
  const fixture = await approvedFixture();
  try {
    assert.equal((await rollUp(fixture)).exit, 0, "control: the minted verdict rolls up green");

    // BREAK 1: the same in-band byte the L107 test uses. The re-grade still passes, so
    // only the evidence binding can object.
    const feelPath = path.join(fixture.sliceDir, "feel.json");
    const originalFeel = await fs.readFile(feelPath, "utf-8");
    await fs.writeFile(feelPath, originalFeel.replace('"runSpeed": 8', '"runSpeed": 8.0001'), "utf-8");
    const stale = await rollUp(fixture);
    assert.equal(stale.exit, 2, "control: with the shas present, the mutation is caught");

    // BREAK 2: hand-trim the ledger so there is nothing left to re-hash. Everything else
    // about the verdict is untouched: same status, same gates, same runId.
    const verdictPath = getSliceVerdictPath(fixture.paths, "core");
    const verdict = JSON.parse(await fs.readFile(verdictPath, "utf-8"));
    const files = verdict.evidence.files;
    assert.equal(files.length, 4, "the fixture really does declare four evidence files");
    verdict.evidence.files = [];
    await fs.writeFile(verdictPath, `${JSON.stringify(verdict, null, 2)}\n`, "utf-8");

    const laundered = await rollUp(fixture);
    assert.equal(
      laundered.exit,
      2,
      "`files: []` means NOTHING was re-hashed: that is a harness refusal, never exit 0",
    );
    assert.equal(laundered.anchored, false, "…and an approval bound to no bytes is not an anchor");
    assert.ok(
      laundered.refusals.some((r) => r.includes("declare 4 evidence file(s)") && r.includes("accounts for 0")),
      `the refusal must state the denominator: ${laundered.refusals.join(" | ")}`,
    );
    for (const name of ["feel.json", "playability.json", "screen-rects.json", "verify-manifest.json"]) {
      assert.ok(
        laundered.refusals.some((r) => r.includes(name) && r.includes("records NO sha")),
        `every unaccounted file must be NAMED, missing ${name}: ${laundered.refusals.join(" | ")}`,
      );
    }

    // THE OTHER WAY AROUND THE SAME COUNT: move the names into `missing` instead of
    // deleting them. A file the run recorded as absent at grade time graded no bytes, so
    // it counts as not performed too, or `missing` would simply become the new hiding place.
    verdict.evidence.missing = files.map((f: { file: string }) => f.file);
    await fs.writeFile(verdictPath, `${JSON.stringify(verdict, null, 2)}\n`, "utf-8");
    const viaMissing = await rollUp(fixture);
    assert.equal(viaMissing.exit, 2);
    assert.ok(
      viaMissing.refusals.some((r) => r.includes("feel.json") && r.includes("recorded as MISSING at grade time")),
      viaMissing.refusals.join(" | "),
    );

    // RESTORE both halves: the ledger comes back, the byte comes back, and the roll-up
    // certifies again. A guard that made everything refuse would prove nothing.
    verdict.evidence.files = files;
    verdict.evidence.missing = [];
    await fs.writeFile(verdictPath, `${JSON.stringify(verdict, null, 2)}\n`, "utf-8");
    await fs.writeFile(feelPath, originalFeel, "utf-8");
    const restored = await rollUp(fixture);
    assert.equal(restored.exit, 0, "restored: green again");
    assert.equal(restored.anchored, true);
  } finally {
    await cleanup(fixture);
  }
});

test("a DELETED evidence file is refused the same way (absent is never a skipped check)", async () => {
  const fixture = await approvedFixture();
  try {
    await fs.rm(path.join(fixture.sliceDir, "screen-rects.json"));
    const result = await rollUp(fixture);
    assert.equal(result.exit, 2);
    assert.ok(
      result.refusals.some((r) => r.includes("screen-rects.json") && r.includes("GONE")),
      result.refusals.join(" | "),
    );
  } finally {
    await cleanup(fixture);
  }
});

// ── H2: re-grading catches a hand-edited verdict ─────────────────────────────

test("LITMUS H2: a hand-edited verdict headline (shas untouched) is caught by RE-GRADING", async () => {
  const fixture = await approvedFixture();
  try {
    const verdictPath = getSliceVerdictPath(fixture.paths, "core");
    const original = await fs.readFile(verdictPath, "utf-8");
    assert.equal((await rollUp(fixture)).exit, 0, "control: green");

    // BREAK: flip ONE gate's stored word. Every sha stays valid, every evidence file
    // is byte-identical, and `isSliceDone` still passes: only re-running the gates over
    // the same inputs can notice.
    const verdict = JSON.parse(original);
    assert.equal(verdict.gates.feel, "pass");
    verdict.gates.feel = "warn";
    await fs.writeFile(verdictPath, `${JSON.stringify(verdict, null, 2)}\n`, "utf-8");

    const diverged = await rollUp(fixture);
    assert.equal(diverged.exit, 2);
    const refusal = diverged.refusals.find((r) => r.includes("DIVERGES"));
    assert.ok(refusal, diverged.refusals.join(" | "));
    assert.match(refusal!, /gate `feel` stored `warn`, re-graded `pass`/);

    // RESTORE.
    await fs.writeFile(verdictPath, original, "utf-8");
    assert.equal((await rollUp(fixture)).exit, 0, "restored: green again");
  } finally {
    await cleanup(fixture);
  }
});

test("a verdict whose evidence no longer grades green is refused even when it never claimed otherwise", async () => {
  const fixture = await approvedFixture();
  try {
    // Rewrite feel.json out of band AND re-point the stored sha at the new bytes, i.e.
    // the strongest forgery available to someone who has read this file: byte binding
    // intact, headline intact, and the game itself now out of band.
    const { createHash } = await import("node:crypto");
    const feelPath = path.join(fixture.sliceDir, "feel.json");
    const mutated = `${JSON.stringify({ runSpeed: 40 }, null, 2)}\n`;
    await fs.writeFile(feelPath, mutated, "utf-8");
    const verdictPath = getSliceVerdictPath(fixture.paths, "core");
    const verdict = JSON.parse(await fs.readFile(verdictPath, "utf-8"));
    for (const file of verdict.evidence.files) {
      if (file.file === "feel.json") {
        file.sha256 = createHash("sha256").update(Buffer.from(mutated, "utf-8")).digest("hex");
        file.evidenceOrigin = "agent-assembled";
        file.runId = null;
        file.editorSessionId = null;
      }
    }
    await fs.writeFile(verdictPath, `${JSON.stringify(verdict, null, 2)}\n`, "utf-8");

    const result = await rollUp(fixture);
    assert.equal(result.exit, 2, "the sha check passes and the RE-GRADE is what refuses");
    assert.ok(
      result.refusals.some((r) => r.includes("DIVERGES") && r.includes("feel")),
      result.refusals.join(" | "),
    );
  } finally {
    await cleanup(fixture);
  }
});

// ── H1/L108: contract coverage ───────────────────────────────────────────────

test("LITMUS H1: manifest.elements declared while NO slice gate walks `manifest` REFUSES, naming it", async () => {
  // BREAK: the exact L108 shape — a fully approved, fully green project whose gate
  // union never walks the `manifest` section its own contract requires.
  const uncovered = await approvedFixture({ gates: ["framing", "feel", "playability"] });
  try {
    const result = await rollUp(uncovered);
    assert.equal(result.exit, 2, "9/9 green is not a pass when the contract itself is unwalked");
    assert.equal(result.regradedGreen, 1, "the slice itself IS green: coverage is a separate, additional refusal");
    assert.equal(result.anchored, false, "M17: coverage must pass before this comparison counts as anchored");
    const refusal = result.coverageRefusals.find((r) => r.includes("`manifest`"));
    assert.ok(refusal, result.coverageRefusals.join(" | "));
    assert.match(refusal!, /1 required scene element/);
    assert.match(refusal!, /gates that would: manifest/);
  } finally {
    await cleanup(uncovered);
  }

  // RESTORE: add the covering gate to the slice's list; the same project passes.
  const covered = await approvedFixture({ gates: GREEN_GATES });
  try {
    const result = await rollUp(covered);
    assert.deepEqual(result.coverageRefusals, []);
    assert.equal(result.exit, 0);
  } finally {
    await cleanup(covered);
  }
});

test("an EMPTY optional section declares nothing, so it is never an uncovered refusal", async () => {
  const fixture = await approvedFixture();
  try {
    const result = await rollUp(fixture);
    // `juice`, `palette`, `hud` and `fonts` are all present-but-empty in the fixture
    // contract: a section that asks for nothing cannot be a section nothing walks.
    for (const section of ["juice", "palette", "hud", "fonts"]) {
      assert.ok(
        !result.coverageRefusals.some((r) => r.includes(`\`${section}\``)),
        `${section} must not be reported as uncovered: ${result.coverageRefusals.join(" | ")}`,
      );
    }
  } finally {
    await cleanup(fixture);
  }
});

// ── S4c: run binding at grade time ───────────────────────────────────────────

test("LITMUS E4: produced evidence from a FOREIGN run refuses at verify time; the same file under the minted run passes", async () => {
  // BREAK: the playability observation was recorded under another build.
  const foreign = await approvedFixture({ playabilityRunId: "run-somewhere-else", expectVerifyExit: 2 });
  try {
    assert.equal(
      await fs
        .access(getSliceVerdictPath(foreign.paths, "core"))
        .then(() => true)
        .catch(() => false),
      false,
      "a refused run writes NO verdict: an absent verdict reads as not-done downstream",
    );
  } finally {
    await cleanup(foreign);
  }

  // RESTORE: the identical file stamped with the run actually in flight.
  const bound = await approvedFixture({ playabilityRunId: RUN_ID });
  try {
    const verdict = JSON.parse(await fs.readFile(getSliceVerdictPath(bound.paths, "core"), "utf-8"));
    assert.equal(verdict.status, "pass");
  } finally {
    await cleanup(bound);
  }
});

test("E15 (was LITMUS L106): two different editorSessionIds NOTE the limitation instead of refusing", async () => {
  // WHAT CHANGED AND WHY. This case used to refuse: feel.json produced under session B,
  // playability.json observed under session A, same runId on both. The E6 sessions then
  // proved the premise wrong. `editorSessionId` is a bridge SERVER-GENERATION id, and a
  // domain reload (which every play-mode entry causes) re-mints it, so ONE editor sitting
  // routinely hands two ids to a slice's CLI-plus-agent evidence. Refusing on that alone
  // walled off honest runs, so the weak binder now notes and only
  // `observation.recorderEditorSessionId` (read inside the running editor) refuses
  // (pinned directly, both ways, in run-binding.test.ts).
  const mixed = await approvedFixture({ feelProducerSession: "editor-session-B" });
  try {
    const verdict = JSON.parse(await fs.readFile(getSliceVerdictPath(mixed.paths, "core"), "utf-8"));
    assert.equal(verdict.status, "pass", "a bridge restart is not proof of two sittings");
    const notes: string[] = verdict.runBindingNotes ?? [];
    assert.ok(
      notes.some((n) => /different `editorSessionId`s/.test(n) && /SERVER GENERATION/.test(n)),
      `the limitation must be SAID, not silently dropped: ${JSON.stringify(notes)}`,
    );
  } finally {
    await cleanup(mixed);
  }

  const single = await approvedFixture({ feelProducerSession: SESSION });
  try {
    const verdict = JSON.parse(await fs.readFile(getSliceVerdictPath(single.paths, "core"), "utf-8"));
    assert.equal(verdict.status, "pass");
    const feel = verdict.evidence.files.find((f: { file: string }) => f.file === "feel.json");
    assert.equal(feel.evidenceOrigin, "produced", "a producer marker with no observation block is PRODUCED");
    assert.equal(feel.editorSessionId, SESSION);
  } finally {
    await cleanup(single);
  }
});

// ── M17: the anchoring decision, at the door ─────────────────────────────────

test("LITMUS M17: per-slice dirs present + empty flat dir + no re-graded slice = exit stays 2", async () => {
  const fixture = await approvedFixture();
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "loombridge-rollup-ws-"));
  try {
    // The flat `.loombridge/verify/` holds ONLY the per-slice subdir: this is the exact
    // L109 project shape.
    const flat = await fs.readdir(fixture.paths.verifyInputs);
    assert.deepEqual(flat, ["core"], "the flat dir has no gate inputs of its own");

    // Control: with the approval intact, the door greens.
    assert.equal(await runUnifiedVerify({ root: fixture.root, strict: false, live: false, workspace }), 0);
    const green = JSON.parse(await fs.readFile(path.join(fixture.paths.reports, "verify.json"), "utf-8"));
    assert.equal(green.status, "pass");
    assert.equal(green.sections.slices.exit, 0);
    assert.equal(green.sections.slices.anchored, true);
    assert.deepEqual(green.anchoredSections, ["slices"]);
    assert.equal(green.sections.contract, undefined, "the contract is graded THROUGH the slices, not over the empty flat dir");

    // BREAK: nothing re-grades green any more (one mutated evidence byte).
    const feelPath = path.join(fixture.sliceDir, "feel.json");
    await fs.writeFile(feelPath, (await fs.readFile(feelPath, "utf-8")).replace('"runSpeed": 8', '"runSpeed": 8.5'), "utf-8");

    const code = await runUnifiedVerify({ root: fixture.root, strict: false, live: false, workspace });
    assert.equal(code, 2, "the roll-up's mere existence must never improve the exit");
    const red = JSON.parse(await fs.readFile(path.join(fixture.paths.reports, "verify.json"), "utf-8"));
    assert.equal(red.status, "harness-fault");
    assert.equal(red.sections.slices.anchored, false);
    assert.deepEqual(red.anchoredSections, []);
    assert.equal(red.sections.slices.assets[0].reportSha256.length, 64, "the roll-up still binds to the slice verdict sha");
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
    await cleanup(fixture);
  }
});

test("doneness prints the per-slice evidence ORIGIN mix, and never gates on it (M18)", async () => {
  const fixture = await approvedFixture();
  try {
    const { evaluateSliceDoneness } = await import("../../../../capabilities/verification/doneness.js");
    const plan = (await readSlicePlan(fixture.paths))!;
    const ev = await evaluateSliceDoneness(plan, fixture.paths);
    assert.equal(ev.slices[0]!.originSummary, "produced 0, observed 1, agent-assembled 3");

    // Stripping the ledger changes the SUMMARY but never the pass/refuse decision: the
    // origin axis is a report, and the ledger refusal belongs to the roll-up door.
    const verdictPath = getSliceVerdictPath(fixture.paths, "core");
    const verdict = JSON.parse(await fs.readFile(verdictPath, "utf-8"));
    const before = ev.slices[0]!.passed;
    delete verdict.evidence;
    await fs.writeFile(verdictPath, `${JSON.stringify(verdict, null, 2)}\n`, "utf-8");
    const after = await evaluateSliceDoneness(plan, fixture.paths);
    assert.match(after.slices[0]!.originSummary, /no evidence ledger/);
    assert.equal(after.slices[0]!.passed, before, "the origin axis is reported, never wired into a gate");
  } finally {
    await cleanup(fixture);
  }
});

test("a project whose roadmap is only PARTLY approved is not a whole-project verdict", async () => {
  const fixture = await approvedFixture();
  try {
    const plan = (await readSlicePlan(fixture.paths))!;
    plan.slices.push({
      id: "later",
      title: "A later slice",
      dependsOn: ["core"],
      feelIntent: "not built yet",
      acceptance: { gates: ["manifest"] },
      state: "pending",
    });
    await writeSlicePlan(fixture.paths, plan);

    const result = await rollUp(fixture);
    assert.equal(result.exit, 2);
    assert.ok(
      result.refusals.some((r) => r.includes("later=pending") && r.includes("not a whole-project verdict")),
      result.refusals.join(" | "),
    );
  } finally {
    await cleanup(fixture);
  }
});

// ── E16: a green roll-up is recorded in STATE, like the flat door records its own ──
//
// Observed live: nine slices re-graded green through this exact door and STATE.md still
// read `built-unverified` / `lastVerdict: null`. The only writer of that block was
// `runVerify`, which on a slice-planned project has no flat row to grade at all (see
// discovery's "ONE ASSET, ONE GRADER"), so the path that DID the grading was the path
// that never said so.

test("E16: a green slices roll-up records the verdict in STATE.md (the flat door's contract, mirrored)", async () => {
  const fixture = await approvedFixture();
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "loombridge-rollup-ws-"));
  try {
    const before = await readState(fixture.paths);
    assert.equal(before?.phase, "built-unverified", "the fixture starts unverified, as a real project does");
    assert.equal(before?.lastVerdict ?? null, null);

    assert.equal(await runUnifiedVerify({ root: fixture.root, strict: false, live: false, workspace }), 0);

    const after = await readState(fixture.paths);
    assert.equal(after?.phase, "verified-green");
    assert.equal(after?.lastVerdict?.status, "pass");
    assert.equal(
      after?.lastVerdict?.verdictPath,
      path.join(".loombridge", "run", "reports", "verify.json"),
      "the roll-up's verdict is the unified report, and STATE must point at the document that decided",
    );
    // A verdict record is not a re-mint: the run binding is carried through untouched.
    assert.equal(after?.currentBuild?.runId, RUN_ID);
    assert.equal(after?.genre, before?.genre);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
    await cleanup(fixture);
  }
});

test("E16 LITMUS: a roll-up that could not measure (harness fault) leaves STATE untouched", async () => {
  // The same fixture and the same door as the green case, with ONE evidence byte moved
  // so nothing re-grades. `harness-fault` is not a verdict about the game, so it must
  // not become a `verified-*` phase an agent can quote.
  const fixture = await approvedFixture();
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "loombridge-rollup-ws-"));
  try {
    const feelPath = path.join(fixture.sliceDir, "feel.json");
    await fs.writeFile(feelPath, (await fs.readFile(feelPath, "utf-8")).replace('"runSpeed": 8', '"runSpeed": 8.5'), "utf-8");

    const lines: string[] = [];
    const origError = console.error;
    console.error = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
    let code: number;
    try {
      code = await runUnifiedVerify({ root: fixture.root, strict: false, live: false, workspace });
    } finally {
      console.error = origError;
    }
    assert.equal(code, 2);

    const after = await readState(fixture.paths);
    assert.equal(after?.phase, "built-unverified", "a harness fault may never move the phase");
    assert.equal(after?.lastVerdict ?? null, null);
    assert.ok(
      lines.some((line) => /STATE not updated/.test(line) && /harness-fault/.test(line)),
      lines.join("\n"),
    );
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
    await cleanup(fixture);
  }
});

test("E16: a SCOPED (--only) run never writes the single-slot state", async () => {
  const fixture = await approvedFixture();
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "loombridge-rollup-ws-"));
  try {
    const code = await runUnifiedVerify({
      root: fixture.root,
      strict: false,
      live: false,
      workspace,
      only: "slices",
    });
    assert.equal(code, 0);
    const after = await readState(fixture.paths);
    assert.equal(after?.phase, "built-unverified", "a scoped run reports on a subset and certifies nothing");
    assert.equal(after?.lastVerdict ?? null, null);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
    await cleanup(fixture);
  }
});
