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

// ── plan ─────────────────────────────────────────────────────────────────────

test("plan scaffolds .loombridge/ for the platformer genre", async () => {
  const root = await tmpRoot();
  const code = await runPlan({ root, genre: "platformer-2d", engine: "unity", force: false, allowMissingDesignTarget: true });
  assert.equal(code, 0);

  const paths = loombridgePaths(root);
  for (const f of [paths.acceptance, paths.feelSpec, paths.gameSpec, paths.state]) {
    assert.ok(await fileExists(f), `${f} should exist`);
  }
  for (const d of [paths.design, paths.reports, paths.traces, paths.verifyInputs]) {
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

test("plan rejects an unknown genre with a usage exit code", async () => {
  const root = await tmpRoot();
  const code = await runPlan({ root, genre: "no-such-genre", engine: "unity", force: false });
  assert.equal(code, 2);
});

// ── verify ───────────────────────────────────────────────────────────────────

test("verify writes a verdict, updates STATE, and enforces strict on warn", async () => {
  const root = await tmpRoot();
  await runPlan({ root, genre: "platformer-2d", engine: "unity", force: false, allowMissingDesignTarget: true });
  const paths = loombridgePaths(root);

  // No captures in .loombridge/verify -> every gate degrades to WARN -> status warn.
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
  assert.equal(verdict.status, "warn", "empty captures degrade every gate to warn");

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
