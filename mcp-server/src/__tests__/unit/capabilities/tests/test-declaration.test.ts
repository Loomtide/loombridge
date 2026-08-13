/**
 * THE ONE FACT FROM OUTSIDE THE PAIR (H4): the project's own declared test surface.
 *
 * WHY THIS FILE EXISTS. Every binding the test-results wave added reads bytes the graded run
 * wrote, so a self-consistent forged pair satisfied all of them at once and flipped the
 * test-results section of `verify` from `fail`/exit 1 to `pass (unanchored)`/exit 0 with no
 * Unity anywhere in the loop. `projectTestSurface` reads the assemblies the GAME declares, in
 * `Packages/manifest.json` `testables` and in the Test-Runner `.asmdef` files, which is a
 * denominator the run does not author.
 *
 * THE FALSE-FAILURE BAR IS THE POINT OF THE FIRST TEST. A gate that reds out ordinary projects
 * gets relaxed, and this repo's own known-open said the asmdef-to-suite-name mapping had real
 * false-failure surface. So the first assertion below is not synthetic: it holds the COMMITTED
 * REAL Unity result document against THIS REPOSITORY'S REAL `unity-dev-project`, resolved
 * through a `file:` dependency exactly as Unity resolves it, and requires an exact match.
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { isNUnitParseError, parseNUnitResults } from "../../../../capabilities/tests/nunit-parse.js";
import { projectDeclaresTests, projectTestSurface } from "../../../../capabilities/tests/test-declaration.js";
import { REPO_ROOT } from "../../../_support/paths.js";
import { readNUnitFixture } from "../../../_support/test-results-fixture.js";

async function tmpProject(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "surface-"));
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(root, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, body, "utf-8");
  }
  return root;
}

test("FALSE-FAILURE, on REAL bytes: the committed Unity fixture's assemblies are exactly what unity-dev-project declares", async () => {
  // `unity-dev-project` declares tests ONLY through `testables`, and the testable resolves
  // through `"com.loomtide.loombridge": "file:../../packages/com.loomtide.loombridge"`. If the
  // resolution or the asmdef `name` reading were wrong in any way, this project would grade
  // its own committed results as "not about this project", which is precisely the false
  // failure that gets a moat fix relaxed.
  const surface = await projectTestSurface(path.join(REPO_ROOT, "unity-dev-project"));
  assert.equal(surface.kind, "declared", `expected a declared surface, got ${JSON.stringify(surface)}`);
  assert.equal(surface.complete, true, "the file: testable resolves on any checkout of this repo");

  const parsed = parseNUnitResults(await readNUnitFixture());
  if (isNUnitParseError(parsed)) assert.fail(parsed.error);

  // EXACT, both ways: every assembly the real run produced is declared, and the declaration
  // names nothing the run did not produce. An intersection assertion would pass on a surface
  // that had drifted to one lucky name.
  assert.deepEqual(
    parsed.assemblies.map((a) => a.replace(/\.dll$/i, "")).sort(),
    [...surface.assemblies].sort(),
  );
});

test("a project declaring tests only through Assets/ asmdefs yields those assembly names", async () => {
  const root = await tmpProject({
    "Packages/manifest.json": JSON.stringify({ dependencies: {} }),
    "Assets/Tests/Game.Tests.asmdef": JSON.stringify({
      name: "Game.Tests",
      references: ["UnityEditor.TestRunner", "UnityEngine.TestRunner"],
    }),
    // A non-test asmdef must NOT enter the surface: it can host no NUnit case.
    "Assets/Runtime/Game.asmdef": JSON.stringify({ name: "Game", references: [] }),
  });
  try {
    const surface = await projectTestSurface(root);
    assert.equal(surface.kind, "declared");
    assert.deepEqual(surface.assemblies, ["Game.Tests"]);
    assert.equal(surface.complete, true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("an EMBEDDED testable package is resolved, and its test asmdefs join the surface", async () => {
  const root = await tmpProject({
    "Packages/manifest.json": JSON.stringify({ dependencies: {}, testables: ["com.example.pkg"] }),
    "Packages/com.example.pkg/Tests/Editor/pkg.tests.asmdef": JSON.stringify({
      name: "com.example.pkg.tests",
      references: ["UnityEngine.TestRunner"],
    }),
  });
  try {
    const surface = await projectTestSurface(root);
    assert.equal(surface.kind, "declared");
    assert.deepEqual(surface.assemblies, ["com.example.pkg.tests"]);
    assert.equal(surface.complete, true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("an UNRESOLVABLE testable makes the surface INCOMPLETE rather than absent", async () => {
  // A registry package on a checkout with no `Library/` is the ordinary case, not an attack.
  // Reporting it as "declares nothing" would silently drop the check; reporting it as complete
  // would red out the project for naming assemblies this checkout cannot see.
  const root = await tmpProject({
    "Packages/manifest.json": JSON.stringify({ dependencies: {}, testables: ["com.unity.somewhere"] }),
    "Assets/Tests/Game.Tests.asmdef": JSON.stringify({ name: "Game.Tests", references: ["UnityEditor.TestRunner"] }),
  });
  try {
    const surface = await projectTestSurface(root);
    assert.equal(surface.kind, "declared");
    assert.equal(surface.complete, false, "an unresolved testable cannot be enumerated, and the surface says so");
    assert.match(surface.how, /com\.unity\.somewhere/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("FALSE-FAILURE: a project with NO declared test surface answers `none`, never an empty `declared`", async () => {
  // The difference is load-bearing: an empty `declared` list would make every XML disjoint
  // from it and refuse, which would red out every project that keeps its EditMode tests in the
  // predefined assemblies. `none` is a note.
  const root = await tmpProject({ "Packages/manifest.json": JSON.stringify({ dependencies: {} }) });
  try {
    const surface = await projectTestSurface(root);
    assert.equal(surface.kind, "none");
    assert.equal((await projectDeclaresTests(root)).declared, false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a non-existent root is `none`, and never throws", async () => {
  const surface = await projectTestSurface(path.join(os.tmpdir(), "loombridge-no-such-project-h4"));
  assert.equal(surface.kind, "none");
});
