/**
 * `loombridge adopt` — build-then-verify on-ramp (RCL-P02) + `plan --brief`
 * design-doc bundle (RCL-P03).
 *
 * The honesty crux: `adopt` PROPOSES a contract for a build that started raw, but
 * it is structurally incapable of emitting a green/approved state — a later
 * verify/doneness still REFUSES until the project is properly planned + verified.
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runAdopt, type AdoptionReport } from "../../../../capabilities/verification/adopt.js";
import { runDoneness } from "../../../../capabilities/verification/doneness.js";
import { loombridgePaths, readState, writeState, fileExists } from "../../../../domain/state.js";
import { validateAcceptanceContract } from "../../../../capabilities/verification/validator.js";

const EXAMPLE_CONTRACT = path.join(
  process.cwd(),
  "src",
  "capabilities",
  "genre",
  "genre-contract",
  "examples",
  "2d-shooter.contract.json",
);

async function tmpRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "loombridge-adopt-"));
}

async function readJson<T>(p: string): Promise<T> {
  return JSON.parse(await fs.readFile(p, "utf-8")) as T;
}

// ── (a) adopt emits a PROPOSED contract that validates but is unverified ──────

test("adopt — emits a proposed ACCEPTANCE that validates but is marked proposal/unverified, and doneness still refuses", async () => {
  const root = await tmpRoot();
  const docs = path.join(root, "docs");
  await fs.mkdir(docs);
  await fs.writeFile(path.join(docs, "GameDesign.md"), "# Spec\nA top-down shooter.\n");
  const scene = path.join(root, "Main.unity");
  await fs.writeFile(scene, "%YAML 1.1\n");

  const code = await runAdopt({ root, genre: "2d-shooter", engine: "unity", docsPath: docs, scenePath: scene, force: false });
  assert.equal(code, 0);

  const paths = loombridgePaths(root);

  // The proposed contract validates against the acceptance schema.
  const contract = await readJson<Record<string, unknown>>(paths.acceptance);
  const validation = validateAcceptanceContract(contract);
  assert.equal(validation.valid, true, JSON.stringify(validation.issues, null, 2));

  // ...but it is clearly marked a PROPOSAL (not a verdict).
  assert.match(String((contract.source as { note?: string })?.note ?? ""), /PROPOSED by `loombridge adopt`/);
  assert.match(String((contract.source as { note?: string })?.note ?? ""), /UNVERIFIED/);

  // ADOPTION.json records the unverified status + the ingested signals.
  const report = await readJson<AdoptionReport>(path.join(paths.dir, "ADOPTION.json"));
  assert.equal(report.status, "proposed-unverified");
  assert.equal(report.verified, false);
  assert.ok(report.signals.some((s) => s.kind === "design-docs" && s.present));
  assert.ok(report.signals.some((s) => s.kind === "scene" && s.present));

  // A later doneness REFUSES — adopt minted no build run / verdict (Epic-0 refuse semantics).
  const doneness = await runDoneness({ root });
  assert.equal(doneness, 1);
});

// ── (b) adopt NEVER emits an approved/green state ─────────────────────────────

test("adopt — never produces a green/approved state (planned phase, no verdict, no build run)", async () => {
  const root = await tmpRoot();
  const code = await runAdopt({ root, genre: "2d-shooter", engine: "unity", force: false });
  assert.equal(code, 0);

  const paths = loombridgePaths(root);
  const state = await readState(paths);
  assert.ok(state, "adopt wrote STATE.md");
  assert.equal(state!.phase, "planned");
  assert.notEqual(state!.phase, "verified-green");
  // No build run minted, no verdict claimed.
  assert.ok(!state!.currentBuild, "adopt mints no currentBuild");
  assert.equal(state!.lastVerdict ?? null, null);
  // No build verdict file fabricated.
  assert.equal(await fileExists(paths.verdict), false, "adopt writes no build-verdict.json");
  // The report invariants are not just data — they are typed literals.
  const report = await readJson<AdoptionReport>(path.join(paths.dir, "ADOPTION.json"));
  assert.equal(report.status, "proposed-unverified");
  assert.equal(report.verified, false);
});

test("adopt — a docs bundle carrying a structured brief is promoted (richer than the template seed)", async () => {
  const root = await tmpRoot();
  const docs = path.join(root, "docs");
  await fs.mkdir(docs);
  await fs.copyFile(EXAMPLE_CONTRACT, path.join(docs, "brief.json"));
  await fs.writeFile(path.join(docs, "notes.md"), "# Notes\n");

  // --genre omitted: the structured brief declares its own genre (2d-shooter).
  const code = await runAdopt({ root, genre: "", engine: "unity", docsPath: docs, force: false });
  assert.equal(code, 0);

  const paths = loombridgePaths(root);
  const report = await readJson<AdoptionReport>(path.join(paths.dir, "ADOPTION.json"));
  assert.equal(report.seededFrom, "structured-brief");
  assert.equal(report.genre, "2d-shooter");
  assert.ok(report.signals.some((s) => s.kind === "structured-brief" && s.present));

  const state = await readState(paths);
  assert.equal(state!.genre, "2d-shooter");
  assert.equal(state!.phase, "planned");
});

test("adopt — refuses to clobber an existing contract without --force", async () => {
  const root = await tmpRoot();
  assert.equal(await runAdopt({ root, genre: "2d-shooter", engine: "unity", force: false }), 0);
  // Second run without --force is refused (exit 1); with --force it succeeds.
  assert.equal(await runAdopt({ root, genre: "2d-shooter", engine: "unity", force: false }), 1);
  assert.equal(await runAdopt({ root, genre: "2d-shooter", engine: "unity", force: true }), 0);
});

test("adopt --force resets to UNVERIFIED — a forced re-adopt over a previously-VERIFIED state carries NO stale verdict (P2)", async () => {
  const root = await tmpRoot();
  const paths = loombridgePaths(root);

  // First adopt → a proposed, planned, unverified contract.
  assert.equal(await runAdopt({ root, genre: "2d-shooter", engine: "unity", force: false }), 0);

  // Simulate the project later being built + verified GREEN (a sticky verdict on disk).
  await writeState(paths, {
    genre: "2d-shooter",
    engine: "unity",
    phase: "verified-green",
    designTarget: "approved",
    currentBuild: { runId: "old-run", startedAt: "2026-06-01T00:00:00.000Z" },
    lastVerdict: { status: "pass", at: "2026-06-01T00:00:00.000Z", verdictPath: ".loombridge/build-verdict.json" },
    updatedAt: "2026-06-01T00:00:00.000Z",
  });

  // A forced re-adopt must RESET to an unverified planned proposal — preserve NOTHING of the run.
  assert.equal(await runAdopt({ root, genre: "2d-shooter", engine: "unity", force: true }), 0);
  const state = await readState(paths);
  assert.equal(state!.phase, "planned");
  assert.equal(state!.currentBuild ?? null, null, "no stale build run carried over");
  assert.equal(
    state!.lastVerdict ?? null,
    null,
    "a forced re-adopt must NOT surface a stale pass verdict next to a fresh unverified proposal",
  );
  // And doneness still refuses (no fresh verdict).
  assert.equal(await runDoneness({ root }), 1);
});

// ── (d) malformed / missing docs → clear error, no partial fabricated contract ─

test("adopt — a malformed structured brief is refused (exit 2), nothing written", async () => {
  const root = await tmpRoot();
  const bad = path.join(root, "brief.json");
  await fs.writeFile(bad, "{ not valid json");
  const code = await runAdopt({ root, genre: "2d-shooter", engine: "unity", docsPath: bad, force: false });
  assert.equal(code, 2);
  // No contract fabricated from the malformed brief.
  assert.equal(await fileExists(loombridgePaths(root).acceptance), false);
});

test("adopt — a missing --docs path is refused (exit 2), nothing written", async () => {
  const root = await tmpRoot();
  const code = await runAdopt({ root, genre: "2d-shooter", engine: "unity", docsPath: path.join(root, "nope"), force: false });
  assert.equal(code, 2);
  assert.equal(await fileExists(loombridgePaths(root).acceptance), false);
});
