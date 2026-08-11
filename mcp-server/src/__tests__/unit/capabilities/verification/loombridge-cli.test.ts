import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runPlan } from "../../../../capabilities/verification/plan.js";
import { exitCodeForVerdict, runVerify } from "../../../../capabilities/verification/verify.js";
import { fileExists, loombridgePaths, readState } from "../../../../domain/state.js";

async function tmpRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "loombridge-cli-"));
}

// ── Enforcement rule (the single most important behaviour) ───────────────────

test("exitCodeForVerdict enforces the build gate", () => {
  assert.equal(exitCodeForVerdict("pass", { strict: false }), 0);
  assert.equal(exitCodeForVerdict("pass", { strict: true }), 0);
  assert.equal(exitCodeForVerdict("warn", { strict: false }), 0);
  assert.equal(exitCodeForVerdict("warn", { strict: true }), 1);
  assert.equal(exitCodeForVerdict("fail", { strict: false }), 1);
  assert.equal(exitCodeForVerdict("fail", { strict: true }), 1);
});

test("BARE verify tiers are UNTOUCHED by the slice warn split: a partially-graded warn still exits 0", async () => {
  // The B4 three-way split is scoped to `--slice`. Bare `verify` has a documented,
  // consumed 0/1/2 contract (CI users read it), and changing it silently is the exact
  // class this repo refuses. This pins the boundary: one gate graded, another degraded to
  // warn on an absent capture, and the bare run still exits 0 with no `approvable` field.
  const root = await tmpRoot();
  await runPlan({ root, genre: "platformer-2d", engine: "unity", force: false, allowMissingDesignTarget: true });
  const paths = loombridgePaths(root);
  await fs.mkdir(paths.verifyInputs, { recursive: true });
  await fs.writeFile(
    path.join(paths.verifyInputs, "verify-manifest.json"),
    JSON.stringify({ missing: [], placeholders: [], extras: [], all_ok: true }),
    "utf-8",
  );

  const { result: code } = await captureStderr(() =>
    runVerify({
      root,
      inputsDir: paths.verifyInputs,
      acceptancePath: paths.acceptance,
      outputPath: paths.verdict,
      strict: false,
    }),
  );
  assert.equal(code, 0, "bare verify still tolerates a warn without --strict");

  const verdict = JSON.parse(await fs.readFile(paths.verdict, "utf-8"));
  assert.equal(verdict.status, "warn");
  assert.equal("approvable" in verdict, false, "`approvable` is a SLICE verdict field only");

  // …and --strict still upgrades it to 1, exactly as documented.
  const strict = await captureStderr(() =>
    runVerify({
      root,
      inputsDir: paths.verifyInputs,
      acceptancePath: paths.acceptance,
      outputPath: paths.verdict,
      strict: true,
    }),
  );
  assert.equal(strict.result, 1);
  await fs.rm(root, { recursive: true, force: true });
});

// ── plan ─────────────────────────────────────────────────────────────────────

test("plan scaffolds .loombridge/ for the platformer genre", async () => {
  const root = await tmpRoot();
  const code = await runPlan({ root, genre: "platformer-2d", engine: "unity", force: false, allowMissingDesignTarget: true });
  assert.equal(code, 0);

  const paths = loombridgePaths(root);
  for (const f of [paths.acceptance, paths.feelSpec, paths.gameSpec, paths.state]) {
    assert.ok(await fileExists(f), `${f} should exist`);
  }
  // `paths.traces` (`.loombridge/traces/`) used to be asserted here. The slot was DEAD:
  // `ensureScaffold` was its only non-test reference, no writer ever put a file in it, and
  // replay traces go to `.loombridge/replays/traces/`. Asserting a directory nothing uses is
  // not coverage, so both the slot and the assertion are gone.
  for (const d of [paths.design, paths.reports, paths.verifyInputs]) {
    assert.ok((await fs.stat(d)).isDirectory(), `${d} should be a directory`);
  }

  // The seeded contract must be valid JSON with a feel section, and FEEL_SPEC
  // must be derived from it.
  const contract = JSON.parse(await fs.readFile(paths.acceptance, "utf-8"));
  assert.ok(contract.feel, "seeded contract has a feel section");
  const feelSpec = JSON.parse(await fs.readFile(paths.feelSpec, "utf-8"));
  assert.deepEqual(feelSpec.metrics, contract.feel, "FEEL_SPEC.metrics derived from contract.feel");

  const state = await readState(paths);
  assert.equal(state?.phase, "planned");
  assert.equal(state?.genre, "platformer-2d");
  assert.equal(state?.engine, "unity");
});

test("plan is idempotent — re-running does not clobber ACCEPTANCE.json", async () => {
  const root = await tmpRoot();
  await runPlan({ root, genre: "platformer-2d", engine: "unity", force: false, allowMissingDesignTarget: true });
  const paths = loombridgePaths(root);

  const before = await fs.readFile(paths.acceptance, "utf-8");
  const code = await runPlan({ root, genre: "platformer-2d", engine: "unity", force: false, allowMissingDesignTarget: true });
  assert.equal(code, 0);
  const after = await fs.readFile(paths.acceptance, "utf-8");
  assert.equal(after, before, "second plan run must leave the contract untouched");
});

test("plan accepts an unknown genre as free-form (no usage refusal at the door)", async () => {
  // Was exit 2. A genre with no registered pack now seeds the genre-neutral `_generic` template and
  // verifies as `ungraded` — the closed set governs what `verify` CLAIMS, not what `plan` ACCEPTS
  // (CommandSurfaceRedesign W1/D). Exit 1 here is the ordinary design-target readiness gate, which
  // every genre hits; the point is that 2 (usage refusal) is gone.
  const root = await tmpRoot();
  const code = await runPlan({ root, genre: "no-such-genre", engine: "unity", force: false });
  assert.notEqual(code, 2, "an unknown genre must not be a usage error any more");
});

// ── verify ───────────────────────────────────────────────────────────────────

/** Run `fn` with console.error captured, returning the emitted lines. */
async function captureStderr<T>(fn: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  try {
    return { result: await fn(), lines };
  } finally {
    console.error = original;
  }
}

test("verify REFUSES (exit 2) when NOTHING graded, and leaves STATE untouched", async () => {
  // The motivating defect (RFC UnifiedVerify): a planned-but-uncaptured project used
  // to exit 0 here with every gate at `warn` and STATE flipped to `verified-warn`,
  // an artifact an agent could quote as "verify passed". The refusal lives in the
  // ENGINE, so the bare CLI, every --inputs form, and the MCP tool all inherit it.
  const root = await tmpRoot();
  await runPlan({ root, genre: "platformer-2d", engine: "unity", force: false, allowMissingDesignTarget: true });
  const paths = loombridgePaths(root);

  const { result: code, lines } = await captureStderr(() =>
    runVerify({
      root,
      inputsDir: paths.verifyInputs,
      acceptancePath: paths.acceptance,
      outputPath: paths.verdict,
      strict: false,
    }),
  );
  assert.equal(code, 2, "a run that graded nothing is a refusal, never a pass");
  assert.ok(
    lines.some((l) => /REFUSED/.test(l) && /nothing was graded/.test(l)),
    lines.join("\n"),
  );
  assert.ok(lines.some((l) => l.includes(paths.verifyInputs)), "the refusal names the resolved inputs dir");
  assert.ok(lines.some((l) => /loombridge capture/.test(l)), "the refusal names the capture command");

  // The verdict is still written (the run is auditable: its warns name every missing
  // capture). What must not happen is the phase flip.
  assert.ok(await fileExists(paths.verdict), "build-verdict.json written for auditability");
  const verdict = JSON.parse(await fs.readFile(paths.verdict, "utf-8"));
  assert.equal(verdict.status, "warn", "empty captures degrade every gate to warn");

  const state = await readState(paths);
  assert.equal(state?.phase, "planned", "a run that graded nothing must NOT flip the phase");
  assert.equal(state?.lastVerdict ?? null, null, "no verdict is recorded on STATE");

  // --strict does not rescue it either: still the refusal tier, never 1.
  const strictCode = await captureStderr(() =>
    runVerify({
      root,
      inputsDir: paths.verifyInputs,
      acceptancePath: paths.acceptance,
      outputPath: paths.verdict,
      strict: true,
    }),
  );
  assert.equal(strictCode.result, 2);
});

test("verify writes a verdict, updates STATE, and enforces strict on warn (PARTIALLY graded)", async () => {
  // The engine semantics the build loop and the MCP tool rely on: once at least ONE
  // gate consumed a real capture, a warn verdict is a real result over a real subset:
  // exit 0 without --strict, 1 with it, STATE flipped. Only the ZERO-graded case is a
  // refusal, so this is where the boundary is pinned.
  const root = await tmpRoot();
  await runPlan({ root, genre: "platformer-2d", engine: "unity", force: false, allowMissingDesignTarget: true });
  const paths = loombridgePaths(root);

  // A real captured input for exactly one gate: console-clean reads console.json.
  await fs.mkdir(paths.verifyInputs, { recursive: true });
  await fs.writeFile(path.join(paths.verifyInputs, "console.json"), JSON.stringify({ logs: [] }), "utf-8");

  const code = await runVerify({
    root,
    inputsDir: paths.verifyInputs,
    acceptancePath: paths.acceptance,
    outputPath: paths.verdict,
    strict: false,
  });
  assert.equal(code, 0, "a warn verdict is not a hard failure without --strict");

  assert.ok(await fileExists(paths.verdict), "build-verdict.json written");
  const verdict = JSON.parse(await fs.readFile(paths.verdict, "utf-8"));
  assert.equal(verdict.status, "warn", "the ungraded gates still degrade the verdict to warn");
  assert.equal(verdict.gates["console-clean"], "pass", "the staged capture really graded a gate");

  const state = await readState(paths);
  assert.equal(state?.phase, "verified-warn");
  assert.equal(state?.lastVerdict?.status, "warn");
  assert.equal(state?.genre, "platformer-2d", "verify preserves genre from plan");

  // Strict: the same warn verdict must now block (exit 1).
  const strictCode = await runVerify({
    root,
    inputsDir: paths.verifyInputs,
    acceptancePath: paths.acceptance,
    outputPath: paths.verdict,
    strict: true,
  });
  assert.equal(strictCode, 1, "--strict turns warn into a hard failure");
});
