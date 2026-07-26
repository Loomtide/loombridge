/**
 * `plan --brief` — design-doc bundle as the brief source (RCL-P03).
 *
 * `plan` historically took its inputs only from the interactive interview (whose
 * machine output is a GenreContract). A build with an existing written spec had no
 * front door; `--brief` resolves a docs bundle to the SAME structured GenreContract
 * the interview emits and promotes it identically — so the brief path is equivalent
 * to the interview path, never a second, divergent contract shape.
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runPlan } from "../../../capabilities/verification/plan.js";
import { resolveBriefBundle } from "../../../domain/brief-bundle.js";
import { loombridgePaths, fileExists } from "../../../domain/state.js";

const EXAMPLE_CONTRACT = path.join(
  process.cwd(),
  "src",
  "capabilities",
  "genre",
  "genre-contract",
  "examples",
  "2d-shooter.contract.json",
);

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "loombridge-brief-"));
}

/** A root whose basename is deterministic, so the basename-derived game name matches across roots. */
async function namedRoot(name: string): Promise<string> {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "loombridge-brief-named-"));
  const root = path.join(parent, name);
  await fs.mkdir(root);
  return root;
}

async function readJson<T>(p: string): Promise<T> {
  return JSON.parse(await fs.readFile(p, "utf-8")) as T;
}

// ── (c) plan --brief == plan --genre-contract (interview-equivalent) ──────────

test("plan --brief <bundle> — produces a contract equivalent to the --genre-contract interview path", async () => {
  // Same basename → same basename-derived game name across both roots.
  const briefRoot = await namedRoot("acme-game");
  const contractRoot = await namedRoot("acme-game");

  const bundle = path.join(briefRoot, "design");
  await fs.mkdir(bundle);
  await fs.copyFile(EXAMPLE_CONTRACT, path.join(bundle, "genre-contract.json"));

  const a = await runPlan({ root: briefRoot, genre: "2d-shooter", engine: "unity", briefPath: bundle, force: true, allowMissingDesignTarget: true });
  const b = await runPlan({ root: contractRoot, genre: "2d-shooter", engine: "unity", genreContractPath: EXAMPLE_CONTRACT, force: true, allowMissingDesignTarget: true });
  assert.equal(a, b, "the two paths follow the same dispatch / exit");

  const briefContract = await readJson<unknown>(loombridgePaths(briefRoot).acceptance);
  const directContract = await readJson<unknown>(loombridgePaths(contractRoot).acceptance);
  assert.deepEqual(briefContract, directContract, "brief-seeded contract equals the interview-seeded contract");

  const briefSlices = await readJson<unknown>(loombridgePaths(briefRoot).slices);
  const directSlices = await readJson<unknown>(loombridgePaths(contractRoot).slices);
  assert.deepEqual(briefSlices, directSlices, "brief-seeded slices equal the interview-seeded slices");
});

test("plan — --brief and --genre-contract are mutually exclusive", async () => {
  const root = await namedRoot("dup");
  const bundle = path.join(root, "design");
  await fs.mkdir(bundle);
  await fs.copyFile(EXAMPLE_CONTRACT, path.join(bundle, "brief.json"));
  const code = await runPlan({ root, genre: "2d-shooter", engine: "unity", briefPath: bundle, genreContractPath: EXAMPLE_CONTRACT, force: true });
  assert.equal(code, 2);
});

// ── (d) malformed / missing bundle → clear error, no partial fabricated contract ─

test("plan --brief — a docs bundle with no structured brief is a clear error (exit 2), nothing written", async () => {
  const root = await namedRoot("nobrief");
  const bundle = path.join(root, "docs");
  await fs.mkdir(bundle);
  await fs.writeFile(path.join(bundle, "README.md"), "# just prose, no structured brief\n");
  const code = await runPlan({ root, genre: "2d-shooter", engine: "unity", briefPath: bundle, force: true });
  assert.equal(code, 2);
  assert.equal(await fileExists(loombridgePaths(root).acceptance), false);
});

test("plan --brief — a malformed structured brief is refused (exit 2), nothing written", async () => {
  const root = await namedRoot("badbrief");
  const bundle = path.join(root, "docs");
  await fs.mkdir(bundle);
  await fs.writeFile(path.join(bundle, "brief.json"), "{ not valid json");
  const code = await runPlan({ root, genre: "2d-shooter", engine: "unity", briefPath: bundle, force: true });
  assert.equal(code, 2);
  assert.equal(await fileExists(loombridgePaths(root).acceptance), false);
});

// ── brief-bundle resolver unit coverage ──────────────────────────────────────

test("resolveBriefBundle — discovers brief.json by priority, then *.contract.json, else errors", async () => {
  const dir = await tmpDir();
  await fs.copyFile(EXAMPLE_CONTRACT, path.join(dir, "brief.json"));
  const r1 = resolveBriefBundle(dir);
  assert.ok(!("error" in r1) && r1.matchedFile === "brief.json");

  const dir2 = await tmpDir();
  await fs.copyFile(EXAMPLE_CONTRACT, path.join(dir2, "shooter.contract.json"));
  const r2 = resolveBriefBundle(dir2);
  assert.ok(!("error" in r2) && r2.matchedFile === "shooter.contract.json");

  const dir3 = await tmpDir();
  await fs.writeFile(path.join(dir3, "notes.md"), "x");
  assert.ok("error" in resolveBriefBundle(dir3), "no structured brief → error");

  const file = path.join(await tmpDir(), "brief.md");
  await fs.writeFile(file, "x");
  assert.ok("error" in resolveBriefBundle(file), "non-json file → error");

  assert.ok("error" in resolveBriefBundle(path.join(dir, "does-not-exist")), "missing path → error");
});
