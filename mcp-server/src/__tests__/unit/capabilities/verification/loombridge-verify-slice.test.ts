/**
 * `loombridge verify --slice <id>` (S2a) — data-driven gate selection from the
 * slice's `acceptance.gates` + a PER-SLICE verdict at
 * `.loombridge/run/reports/slices/<id>.verdict.json`.
 *
 * The harness mirrors verification-run-gates.test.ts: write the gate-input JSON
 * captures into a tmp `.loombridge/verify/<id>/`, write a SLICES.json + an
 * ACCEPTANCE.json, then drive `runVerify` and assert ONLY the slice's gates ran,
 * the per-slice verdict carries the stamps, and the whole-game state is untouched.
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { runVerify, sliceVerdictOutcome } from "../../../../capabilities/verification/verify.js";
import { REPO_ROOT as REPO_ROOT_SUPPORT } from "../../../_support/paths.js";
import {
  ensureScaffold,
  loombridgePaths,
  writeState,
  fileExists,
  nowIso,
  type LoombridgeState,
} from "../../../../domain/state.js";
import {
  readSlicePlan,
  writeSlicePlan,
  getSliceDiagnosticPath,
  getSliceFixtureDir,
  getSliceVerdictPath,
  getSliceVerifyDir,
  type SlicePlan,
} from "../../../../capabilities/verification/slices.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const acceptancePath = path.resolve(
  REPO_ROOT_SUPPORT,
  "mcp-server/src/capabilities/verification/tiderunner.acceptance.json",
);

async function tmpRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "loombridge-verify-slice-"));
}

/** A two-slice plan: slice "s1-hud" selects manifest+ui-conformance gates. */
function planWith(gates: string[], id = "s1-hud"): SlicePlan {
  return {
    schemaVersion: "1",
    genre: "platformer-2d",
    slices: [
      {
        id,
        title: "HUD slice",
        dependsOn: [],
        skill: "game-polish-2d",
        feelIntent: "crisp HUD readout",
        acceptance: { gates },
        state: "pending",
      },
      {
        id: "s2-feel",
        title: "Feel slice",
        dependsOn: [id],
        skill: "game-polish-2d",
        feelIntent: "snappy run + jump",
        acceptance: { gates: ["feel"] },
        state: "pending",
      },
    ],
  };
}

function builtPlanWith(gates: string[], runId = "run-s1-hud-1", id = "s1-hud"): SlicePlan {
  const plan = planWith(gates, id);
  plan.slices[0]!.state = "built";
  plan.slices[0]!.proof = {
    runId,
    startedAt: "2026-01-01T00:00:00.000Z",
    verdictPath: `.loombridge/run/reports/slices/${id}.verdict.json`,
    captureManifest: gates.map((g) => `${id}/${g}.json`),
    checkpointId: null,
    approvedAt: null,
  };
  return plan;
}

/** Conformant manifest + ui-conformance captures (so the slice's gates pass). */
function passingHudCaptures(): Record<string, unknown> {
  return {
    "verify-manifest.json": { missing: [], placeholders: [], extras: [], all_ok: true },
    "ui-scan.json": {
      components: [
        { name: "ScoreLabel", fontName: "Press Start 2P SDF", color: { r: 1, g: 209 / 255, b: 102 / 255, a: 1 } },
        { name: "LivesLabel", fontName: "Press Start 2P SDF", color: { r: 1, g: 77 / 255, b: 141 / 255, a: 1 } },
      ],
      canvas: { renderMode: "Screen Space - Camera", cameraName: "UICamera", cameraHasPixelPerfect: true, cameraUpscaleRT: false },
    },
  };
}

/** Run `fn` with console.error captured, returning the exit code and the emitted lines. */
async function captureStderr(fn: () => Promise<number>): Promise<{ code: number; lines: string[] }> {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  try {
    return { code: await fn(), lines };
  } finally {
    console.error = original;
  }
}

async function writeCaptures(dir: string, files: Record<string, unknown>): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  for (const [name, data] of Object.entries(files)) {
    await fs.writeFile(path.join(dir, name), JSON.stringify(data, null, 2), "utf-8");
  }
}

/** Scaffold .loombridge/ + copy the real acceptance contract into place. */
async function scaffold(root: string): Promise<void> {
  const paths = loombridgePaths(root);
  await ensureScaffold(paths);
  await fs.copyFile(acceptancePath, paths.acceptance);
}

const baseArgs = (root: string) => {
  const paths = loombridgePaths(root);
  return {
    root,
    inputsDir: paths.verifyInputs,
    inputsExplicit: false,
    acceptancePath: paths.acceptance,
    outputPath: paths.verdict,
    strict: false,
  };
};

test("verify --slice grades ONLY the slice's acceptance.gates; out-of-set gates are excluded", async () => {
  const root = await tmpRoot();
  try {
    await scaffold(root);
    const paths = loombridgePaths(root);
    await writeSlicePlan(paths, planWith(["manifest", "ui-conformance"]));
    // Feed the per-slice capture dir.
    await writeCaptures(path.join(paths.verifyInputs, "s1-hud"), passingHudCaptures());

    const code = await runVerify({ ...baseArgs(root), slice: "s1-hud" });
    assert.equal(code, 0);

    const verdict = JSON.parse(await fs.readFile(getSliceVerdictPath(paths, "s1-hud"), "utf-8"));
    // The selected gates ran.
    assert.equal(verdict.gates["manifest"], "pass");
    assert.equal(verdict.gates["ui-conformance"], "pass");
    // A gate NOT in the slice's set is excluded (not_applicable), NOT graded —
    // even though it would have degraded to warn on a missing capture.
    assert.equal(verdict.gates["feel"], "not_applicable");
    assert.equal(verdict.gates["playability"], "not_applicable");
    assert.equal(verdict.gates["reachability"], "not_applicable");
    // The excluded gate never warns on a missing capture.
    assert.ok(!verdict.warnings.some((c: { id: string }) => c.id === "feel.input"));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("verify --slice writes the per-slice verdict with producedAt + slice{id,gates} + runId from currentBuild", async () => {
  const root = await tmpRoot();
  try {
    await scaffold(root);
    const paths = loombridgePaths(root);
    await writeSlicePlan(paths, planWith(["manifest", "ui-conformance"]));
    await writeCaptures(path.join(paths.verifyInputs, "s1-hud"), passingHudCaptures());

    // A currentBuild in flight — the per-slice verdict must bind its runId.
    const state: LoombridgeState = {
      genre: "platformer-2d",
      engine: "unity",
      phase: "built-unverified",
      currentBuild: { runId: "run-XYZ", startedAt: nowIso() },
      lastVerdict: null,
      updatedAt: nowIso(),
    };
    await writeState(paths, state);

    const code = await runVerify({ ...baseArgs(root), slice: "s1-hud" });
    assert.equal(code, 0);

    const verdictPath = getSliceVerdictPath(paths, "s1-hud");
    assert.ok(verdictPath.endsWith(path.join("reports", "slices", "s1-hud.verdict.json")));
    const verdict = JSON.parse(await fs.readFile(verdictPath, "utf-8"));
    assert.ok(typeof verdict.producedAt === "string" && verdict.producedAt.length > 0);
    assert.deepEqual(verdict.slice, { id: "s1-hud", gates: ["manifest", "ui-conformance"] });
    assert.equal(verdict.runId, "run-XYZ");
    // Frozen Design Target metadata is stamped (advisory) like the full run.
    assert.ok(verdict.designTarget);
    assert.equal(verdict.designTarget.status, "missing");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("verify --slice fresh pass commits built -> verified and records a checkpoint", async () => {
  const root = await tmpRoot();
  try {
    await scaffold(root);
    const paths = loombridgePaths(root);
    const runId = "run-s1-hud-fresh";
    await writeSlicePlan(paths, builtPlanWith(["manifest", "ui-conformance"], runId));
    await writeCaptures(path.join(paths.verifyInputs, "s1-hud"), passingHudCaptures());
    await writeState(paths, {
      genre: "platformer-2d",
      engine: "unity",
      phase: "built-unverified",
      currentBuild: { runId, startedAt: nowIso() },
      lastVerdict: null,
      updatedAt: nowIso(),
    });

    const code = await runVerify({ ...baseArgs(root), slice: "s1-hud" });
    assert.equal(code, 0);

    const plan = (await readSlicePlan(paths))!;
    const slice = plan.slices.find((s) => s.id === "s1-hud")!;
    assert.equal(slice.state, "verified");
    assert.equal(slice.proof?.runId, runId);
    assert.equal(slice.proof?.checkpointId, "s1-hud");
    assert.equal(slice.proof?.approvedAt, null);
    assert.equal(await fileExists(path.join(getSliceFixtureDir(paths, "s1-hud"), "loombridge", "SLICES.json")), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("verify --slice stale pass writes verdict but does NOT flip when runIds do not bind", async () => {
  const root = await tmpRoot();
  try {
    await scaffold(root);
    const paths = loombridgePaths(root);
    await writeSlicePlan(paths, builtPlanWith(["manifest", "ui-conformance"], "run-s1-hud-proof"));
    await writeCaptures(path.join(paths.verifyInputs, "s1-hud"), passingHudCaptures());
    await writeState(paths, {
      genre: "platformer-2d",
      engine: "unity",
      phase: "built-unverified",
      currentBuild: { runId: "run-s1-hud-different", startedAt: nowIso() },
      lastVerdict: null,
      updatedAt: nowIso(),
    });

    const code = await runVerify({ ...baseArgs(root), slice: "s1-hud" });
    assert.equal(code, 0);
    assert.equal(await fileExists(getSliceVerdictPath(paths, "s1-hud")), true);

    const plan = (await readSlicePlan(paths))!;
    const slice = plan.slices.find((s) => s.id === "s1-hud")!;
    assert.equal(slice.state, "built");
    assert.equal(slice.proof?.checkpointId, null);
    assert.equal(await fileExists(getSliceFixtureDir(paths, "s1-hud")), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("verify --slice failing verdict stays built even when runIds bind", async () => {
  const root = await tmpRoot();
  try {
    await scaffold(root);
    const paths = loombridgePaths(root);
    const runId = "run-s1-hud-fail";
    await writeSlicePlan(paths, builtPlanWith(["manifest", "ui-conformance"], runId));
    await writeCaptures(path.join(paths.verifyInputs, "s1-hud"), {
      ...passingHudCaptures(),
      "verify-manifest.json": { missing: ["Player"], placeholders: [], extras: [], all_ok: false },
    });
    await writeState(paths, {
      genre: "platformer-2d",
      engine: "unity",
      phase: "built-unverified",
      currentBuild: { runId, startedAt: nowIso() },
      lastVerdict: null,
      updatedAt: nowIso(),
    });

    const code = await runVerify({ ...baseArgs(root), slice: "s1-hud" });
    assert.equal(code, 1);

    const plan = (await readSlicePlan(paths))!;
    const slice = plan.slices.find((s) => s.id === "s1-hud")!;
    assert.equal(slice.state, "built");
    assert.equal(slice.proof?.checkpointId, null);
    assert.equal(await fileExists(getSliceFixtureDir(paths, "s1-hud")), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("verify --slice on a settled non-binding slice writes diagnostic and preserves canonical verdict/state", async () => {
  const root = await tmpRoot();
  try {
    await scaffold(root);
    const paths = loombridgePaths(root);
    const plan = builtPlanWith(["manifest", "ui-conformance"], "run-s1-hud-proof");
    plan.slices[0]!.state = "approved";
    plan.slices[0]!.proof = {
      ...plan.slices[0]!.proof!,
      checkpointId: "s1-hud",
      approvedAt: "2026-01-01T00:00:01.000Z",
    };
    await writeSlicePlan(paths, plan);
    await writeCaptures(path.join(paths.verifyInputs, "s1-hud"), passingHudCaptures());
    await writeState(paths, {
      genre: "platformer-2d",
      engine: "unity",
      phase: "built-unverified",
      currentBuild: { runId: "run-other-slice", startedAt: nowIso() },
      lastVerdict: null,
      updatedAt: nowIso(),
    });

    const canonicalPath = getSliceVerdictPath(paths, "s1-hud");
    const canonical = { status: "pass", runId: "run-s1-hud-proof", producedAt: "2026-01-01T00:00:02.000Z" };
    await fs.mkdir(path.dirname(canonicalPath), { recursive: true });
    await fs.writeFile(canonicalPath, `${JSON.stringify(canonical, null, 2)}\n`, "utf-8");
    const beforeCanonical = await fs.readFile(canonicalPath, "utf-8");

    const code = await runVerify({ ...baseArgs(root), slice: "s1-hud" });
    assert.equal(code, 0);

    assert.equal(await fs.readFile(canonicalPath, "utf-8"), beforeCanonical);
    const diagnostic = JSON.parse(await fs.readFile(getSliceDiagnosticPath(paths, "s1-hud"), "utf-8"));
    assert.equal(diagnostic.diagnostic, true);
    assert.equal(diagnostic.runId, "run-other-slice");
    const after = (await readSlicePlan(paths))!;
    assert.equal(after.slices[0]!.state, "approved");
    assert.equal(after.slices[0]!.proof?.approvedAt, "2026-01-01T00:00:01.000Z");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("verify --slice is null-safe for runId when no currentBuild is set (pre-S2b)", async () => {
  const root = await tmpRoot();
  try {
    await scaffold(root);
    const paths = loombridgePaths(root);
    await writeSlicePlan(paths, planWith(["manifest", "ui-conformance"]));
    await writeCaptures(path.join(paths.verifyInputs, "s1-hud"), passingHudCaptures());
    // No STATE.md written at all.

    const code = await runVerify({ ...baseArgs(root), slice: "s1-hud" });
    assert.equal(code, 0);

    const verdict = JSON.parse(await fs.readFile(getSliceVerdictPath(paths, "s1-hud"), "utf-8"));
    assert.equal(verdict.runId, null);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("verify --slice does NOT touch the whole-game build-verdict.json or STATE", async () => {
  const root = await tmpRoot();
  try {
    await scaffold(root);
    const paths = loombridgePaths(root);
    await writeSlicePlan(paths, planWith(["manifest", "ui-conformance"]));
    await writeCaptures(path.join(paths.verifyInputs, "s1-hud"), passingHudCaptures());

    // A pre-existing STATE.md with a sentinel lastVerdict + phase + slice state.
    const before: LoombridgeState = {
      genre: "platformer-2d",
      engine: "unity",
      phase: "built-unverified",
      lastVerdict: { status: "SENTINEL", at: "2026-01-01T00:00:00.000Z", verdictPath: "sentinel" },
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    await writeState(paths, before);
    const stateBefore = await fs.readFile(paths.state, "utf-8");
    const planBefore = await fs.readFile(paths.slices, "utf-8");

    const code = await runVerify({ ...baseArgs(root), slice: "s1-hud" });
    assert.equal(code, 0);

    // build-verdict.json was never written.
    assert.equal(await fileExists(paths.verdict), false);
    // STATE.md is byte-identical (no lastVerdict/phase mutation).
    assert.equal(await fs.readFile(paths.state, "utf-8"), stateBefore);
    // SLICES.json is byte-identical (no slice `state` flip — that's S2b).
    assert.equal(await fs.readFile(paths.slices, "utf-8"), planBefore);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("verify --slice + --stage together → exit 2 usage error", async () => {
  const root = await tmpRoot();
  try {
    await scaffold(root);
    const paths = loombridgePaths(root);
    await writeSlicePlan(paths, planWith(["manifest"]));
    const { run } = await import("../../../../capabilities/verification/verify.js");
    const code = await run(["--root", root, "--slice", "s1-hud", "--stage", "construct"]);
    assert.equal(code, 2);
    // No per-slice verdict was produced.
    assert.equal(await fileExists(getSliceVerdictPath(paths, "s1-hud")), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("verify --slice with no SLICES.json → exit 2 with the scaffold message", async () => {
  const root = await tmpRoot();
  try {
    await scaffold(root); // .loombridge/ exists but NO SLICES.json
    const code = await runVerify({ ...baseArgs(root), slice: "s1-hud" });
    assert.equal(code, 2);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("verify --slice <unknown> → exit 2", async () => {
  const root = await tmpRoot();
  try {
    await scaffold(root);
    const paths = loombridgePaths(root);
    await writeSlicePlan(paths, planWith(["manifest"]));
    const code = await runVerify({ ...baseArgs(root), slice: "does-not-exist" });
    assert.equal(code, 2);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("verify --slice — an unsafe slice id cannot even be persisted (rejected at rest)", async () => {
  const root = await tmpRoot();
  try {
    await scaffold(root);
    const paths = loombridgePaths(root);
    // The slice-plan validator (writeSlicePlan → assertValidSlicePlan) now refuses
    // an unsafe id, so a traversal id can never reach `verify --slice` at all.
    // The path builders (getSliceVerdictPath/getSliceVerifyDir) also assert as a
    // backstop — covered by a unit test in loombridge-slices.test.ts.
    await assert.rejects(
      () =>
        writeSlicePlan(paths, {
          schemaVersion: "1",
          genre: "platformer-2d",
          slices: [
            { id: "../escape", title: "x", dependsOn: [], skill: "s", feelIntent: "f", acceptance: { gates: ["manifest"] }, state: "pending" },
          ],
        } as SlicePlan),
      /not a safe slice id/,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("verify --slice exit code reflects the gate status (failing selected gate → non-zero)", async () => {
  const root = await tmpRoot();
  try {
    await scaffold(root);
    const paths = loombridgePaths(root);
    await writeSlicePlan(paths, planWith(["manifest", "ui-conformance"]));
    // Break manifest (an in-slice gate) → the slice verdict fails.
    await writeCaptures(path.join(paths.verifyInputs, "s1-hud"), {
      ...passingHudCaptures(),
      "verify-manifest.json": { missing: ["Player"], placeholders: [], extras: [], all_ok: false },
    });

    const code = await runVerify({ ...baseArgs(root), slice: "s1-hud" });
    assert.equal(code, 1);
    const verdict = JSON.parse(await fs.readFile(getSliceVerdictPath(paths, "s1-hud"), "utf-8"));
    assert.equal(verdict.gates["manifest"], "fail");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ── the three-way warn split (ledger L64/L113; B4) ───────────────────────────
//
// This test CHANGED deliberately. It used to assert `lenient === 0`: a slice verify
// whose gates never ran exited with the same code a PASS returns, so exit 0 covered
// approved, blocked-on-warn and never-evaluated at once. The three tests below pin the
// replacement contract: 0 pass / 1 game defect / 2 harness gap, with `--strict` reduced
// to a no-op because slice verify is now strict by default.

test("verify --slice: a warn whose ONLY failing checks are absent gate inputs is HARNESS tier (exit 2)", async () => {
  const root = await tmpRoot();
  try {
    await scaffold(root);
    const paths = loombridgePaths(root);
    await writeSlicePlan(paths, planWith(["manifest", "ui-conformance"]));
    // Only manifest present → ui-conformance degrades to warn: that gate never ran, so
    // this verdict says NOTHING about the game. Never a pass, never a game defect.
    await writeCaptures(path.join(paths.verifyInputs, "s1-hud"), {
      "verify-manifest.json": { missing: [], placeholders: [], extras: [], all_ok: true },
    });

    const { code, lines } = await captureStderr(() => runVerify({ ...baseArgs(root), slice: "s1-hud" }));
    assert.equal(code, 2, "a capture gap is a harness fault: exit 2, never 0 and never 1");
    assert.ok(
      lines.some((l) => /NOT GRADED/.test(l) && /harness\/capture gap/.test(l)),
      lines.join("\n"),
    );
    // The message NAMES the evidence file, because producing it is the fix.
    assert.ok(lines.some((l) => l.includes("ui-scan.json")), "the refusal must name the missing evidence file");

    // --strict cannot change a thing (kept for compatibility, announced as a no-op).
    const strictRun = await captureStderr(() => runVerify({ ...baseArgs(root), slice: "s1-hud", strict: true }));
    assert.equal(strictRun.code, 2, "--strict is a no-op for --slice");
    assert.ok(strictRun.lines.some((l) => /--strict is a NO-OP/.test(l)), strictRun.lines.join("\n"));

    const verdict = JSON.parse(await fs.readFile(getSliceVerdictPath(paths, "s1-hud"), "utf-8"));
    assert.equal(verdict.approvable, false, "an ungraded slice is not approvable");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("verify --slice: a warn over evidence that WAS graded is a game defect (exit 1)", async () => {
  const root = await tmpRoot();
  try {
    await scaffold(root);
    const paths = loombridgePaths(root);
    await writeSlicePlan(paths, planWith(["manifest", "console-clean"]));
    // Both inputs PRESENT. console-clean grades a real capture and warns on a benign
    // gameplay warning: a statement about the game, not about the harness.
    await writeCaptures(path.join(paths.verifyInputs, "s1-hud"), {
      "verify-manifest.json": { missing: [], placeholders: [], extras: [], all_ok: true },
      "console.json": { logs: [{ type: "warning", message: "Player sprite reimported at runtime" }] },
    });

    const { code, lines } = await captureStderr(() => runVerify({ ...baseArgs(root), slice: "s1-hud" }));
    assert.equal(code, 1, "a graded warn does not advance the slice, so it must not exit 0");
    assert.ok(
      lines.some((l) => /NOT green/.test(l) && /strict by default/.test(l)),
      lines.join("\n"),
    );
    assert.ok(!lines.some((l) => /harness\/capture gap/.test(l)), "a graded warn is NOT the harness tier");

    const verdict = JSON.parse(await fs.readFile(getSliceVerdictPath(paths, "s1-hud"), "utf-8"));
    assert.equal(verdict.status, "warn");
    assert.equal(verdict.gates["console-clean"], "warn");
    assert.equal(verdict.approvable, false);

    // Same run under --strict: identical code. The flag is inert here.
    const strictCode = await runVerify({ ...baseArgs(root), slice: "s1-hud", strict: true });
    assert.equal(strictCode, 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("verify --slice: a pass exits 0 and records `approvable: true` in the verdict", async () => {
  // The C6/PIPESTATUS lesson: three live runs lost this verb's exit code to a pipe. The
  // verdict must answer "may this be approved?" on its own, in a machine-readable field.
  const root = await tmpRoot();
  try {
    await scaffold(root);
    const paths = loombridgePaths(root);
    await writeSlicePlan(paths, planWith(["manifest", "ui-conformance"]));
    await writeCaptures(path.join(paths.verifyInputs, "s1-hud"), passingHudCaptures());

    const { code, lines } = await captureStderr(() => runVerify({ ...baseArgs(root), slice: "s1-hud" }));
    assert.equal(code, 0);
    const verdict = JSON.parse(await fs.readFile(getSliceVerdictPath(paths, "s1-hud"), "utf-8"));
    assert.equal(verdict.status, "pass");
    assert.equal(verdict.approvable, true);
    // …and the printed summary line states it, for the reader who has only the log.
    assert.ok(lines.some((l) => /exit=0 approvable=true/.test(l)), lines.join("\n"));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("verify --slice: a DIAGNOSTIC verdict is never approvable, however green", async () => {
  // A diagnostic run is not bound to the slice's proof: that is why it is written to a
  // different path. `approvable` must not read `true` off its `pass` status alone.
  const root = await tmpRoot();
  try {
    await scaffold(root);
    const paths = loombridgePaths(root);
    const plan = builtPlanWith(["manifest", "ui-conformance"], "run-s1-hud-proof");
    plan.slices[0]!.state = "approved";
    plan.slices[0]!.proof = { ...plan.slices[0]!.proof!, checkpointId: "s1-hud", approvedAt: "2026-01-01T00:00:01.000Z" };
    await writeSlicePlan(paths, plan);
    await writeCaptures(path.join(paths.verifyInputs, "s1-hud"), passingHudCaptures());
    await writeState(paths, {
      genre: "platformer-2d",
      engine: "unity",
      phase: "built-unverified",
      currentBuild: { runId: "run-other-slice", startedAt: nowIso() },
      lastVerdict: null,
      updatedAt: nowIso(),
    });

    const code = await runVerify({ ...baseArgs(root), slice: "s1-hud" });
    assert.equal(code, 0);
    const diagnostic = JSON.parse(await fs.readFile(getSliceDiagnosticPath(paths, "s1-hud"), "utf-8"));
    assert.equal(diagnostic.status, "pass");
    assert.equal(diagnostic.diagnostic, true);
    assert.equal(diagnostic.approvable, false, "a diagnostic verdict can never approve a slice");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("sliceVerdictOutcome: the pure three-way rule, off the assembled report alone", () => {
  const absentCheck = (gate: string) => ({
    id: `${gate}.input`,
    expected: `captured op output at "${gate}.json"`,
    actual: "(missing)",
    status: "warn" as const,
    detail: "Gate not evaluated.",
  });
  const gradedWarn = {
    id: "console-clean.warnings",
    expected: "no warnings",
    actual: "1 warning",
    status: "warn" as const,
    detail: "benign",
  };

  const pass = sliceVerdictOutcome({ status: "pass", gates: { manifest: "pass" }, checks: [] });
  assert.deepEqual({ code: pass.code, tier: pass.tier, approvable: pass.approvable }, { code: 0, tier: "pass", approvable: true });

  const harness = sliceVerdictOutcome({
    status: "warn",
    gates: { manifest: "pass", "ui-conformance": "warn" },
    checks: [absentCheck("ui-conformance")],
  });
  assert.equal(harness.code, 2);
  assert.equal(harness.tier, "harness");
  assert.deepEqual(harness.missingEvidence, ["ui-scan.json"], "the tier names the file it was missing");

  // MIXED: one gate never ran, another warned over real evidence. A graded warning is
  // present, so this is a defect, not a harness gap: the harness tier must not absorb it.
  const mixed = sliceVerdictOutcome({
    status: "warn",
    gates: { "console-clean": "warn", "ui-conformance": "warn" },
    checks: [absentCheck("ui-conformance"), gradedWarn],
  });
  assert.equal(mixed.code, 1);
  assert.equal(mixed.tier, "defect");

  const fail = sliceVerdictOutcome({ status: "fail", gates: { manifest: "fail" }, checks: [] });
  assert.equal(fail.code, 1);
  assert.equal(fail.approvable, false);

  // Refuse-not-skip: a `warn` status with NO warning checks is a self-contradictory
  // report. It must fall to the defect tier, never be read as "no graded warns → harness".
  const empty = sliceVerdictOutcome({ status: "warn", gates: { manifest: "warn" }, checks: [] });
  assert.equal(empty.code, 1);
  assert.equal(empty.tier, "defect");
});

test("verify --inputs override survives a --slice run (explicit beats the per-slice default)", async () => {
  const root = await tmpRoot();
  try {
    await scaffold(root);
    const paths = loombridgePaths(root);
    await writeSlicePlan(paths, planWith(["manifest", "ui-conformance"]));
    // Put the captures somewhere OTHER than .loombridge/verify/s1-hud and point
    // --inputs at it. The per-slice default dir is left empty.
    const customDir = path.join(root, "custom-captures");
    await writeCaptures(customDir, passingHudCaptures());

    const code = await runVerify({
      ...baseArgs(root),
      inputsDir: customDir,
      inputsExplicit: true,
      slice: "s1-hud",
    });
    assert.equal(code, 0);
    const verdict = JSON.parse(await fs.readFile(getSliceVerdictPath(paths, "s1-hud"), "utf-8"));
    assert.equal(verdict.gates["manifest"], "pass");
    assert.equal(verdict.gates["ui-conformance"], "pass");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("verify --slice REFUSES (no green verdict) when every requested gate is not_applicable", async () => {
  // The §3a backstop: a slice whose gates are all excluded by the acceptance
  // contract grades NOTHING. worstStatus collapses all-not_applicable to
  // not_applicable, which exitCodeForVerdict would treat as 0 — a false-green.
  // runVerifySlice must refuse (exit 1) and write NO per-slice verdict.
  const root = await tmpRoot();
  try {
    await scaffold(root);
    const paths = loombridgePaths(root);
    // Mark the slice's gates not_applicable in the acceptance contract.
    const contract = JSON.parse(await fs.readFile(paths.acceptance, "utf-8"));
    contract.verification = {
      ...(contract.verification ?? {}),
      gates: { ...(contract.verification?.gates ?? {}), manifest: "not_applicable", "ui-conformance": "not_applicable" },
    };
    await fs.writeFile(paths.acceptance, JSON.stringify(contract, null, 2), "utf-8");
    await writeSlicePlan(paths, planWith(["manifest", "ui-conformance"]));
    await writeCaptures(getSliceVerifyDir(paths, "s1-hud"), passingHudCaptures());

    const code = await runVerify({ ...baseArgs(root), slice: "s1-hud" });
    assert.equal(code, 1, "graded-nothing must refuse, not certify green");
    assert.equal(
      await fileExists(getSliceVerdictPath(paths, "s1-hud")),
      false,
      "a refused per-slice run must NOT write a verdict file",
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("verify --slice REFUSES when any requested gate is absent, even if another gate passes", async () => {
  // Regression: frame-integrity is VLM-derived and only appears when --vlm is
  // supplied. A slice requesting manifest+frame-integrity must not pass just
  // because manifest passed; the requested fidelity gate did not grade.
  const root = await tmpRoot();
  try {
    await scaffold(root);
    const paths = loombridgePaths(root);
    await writeSlicePlan(paths, planWith(["manifest", "frame-integrity"]));
    await writeCaptures(getSliceVerifyDir(paths, "s1-hud"), {
      "verify-manifest.json": { missing: [], placeholders: [], extras: [], all_ok: true },
    });

    const code = await runVerify({ ...baseArgs(root), slice: "s1-hud" });
    assert.equal(code, 1, "missing requested frame-integrity gate must refuse");
    assert.equal(
      await fileExists(getSliceVerdictPath(paths, "s1-hud")),
      false,
      "a refused mixed-gate run must NOT write a per-slice verdict",
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
