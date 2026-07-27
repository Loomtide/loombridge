import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "../../_support/paths.js";

/**
 * Every Unity `file:` package dependency must resolve to a real directory.
 *
 * These are declared paths that nothing imports and no test walks — the same blind spot
 * that shipped broken `bin` targets and a mis-aimed doc generator. Moving a Unity project
 * one directory shallower silently invalidated `file:../../../packages/...`: it resolved
 * ABOVE the repo root, so Unity could not find the bridge and the EditMode CI job would
 * fail, while the whole TypeScript suite stayed green. A `..`-count encodes how deep a
 * project sits; this check is what notices when that stops being true.
 */

function unityProjects(): string[] {
  const found: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 3) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      if (["node_modules", ".git", "Library", "Temp", "dist"].includes(e.name)) continue;
      const abs = path.join(dir, e.name);
      if (fs.existsSync(path.join(abs, "Packages", "manifest.json"))) found.push(abs);
      else walk(abs, depth + 1);
    }
  };
  walk(REPO_ROOT, 0);
  return found;
}

test("unity projects: every file: package dependency resolves", () => {
  const projects = unityProjects();
  assert.ok(projects.length >= 2, `expected to find the Unity projects, found ${projects.length}`);

  const broken: string[] = [];
  for (const project of projects) {
    const packagesDir = path.join(project, "Packages");
    for (const file of ["manifest.json", "packages-lock.json"]) {
      const abs = path.join(packagesDir, file);
      if (!fs.existsSync(abs)) continue;
      const raw = fs.readFileSync(abs, "utf-8");
      for (const m of raw.matchAll(/"file:([^"]+)"/g)) {
        const target = path.resolve(packagesDir, m[1]!);
        if (!fs.existsSync(target)) {
          broken.push(`${path.relative(REPO_ROOT, abs)}: file:${m[1]} -> ${target}`);
        }
      }
    }
  }

  assert.deepEqual(broken, [], `Unity file: dependency does not resolve:\n  ${broken.join("\n  ")}`);
});

test("unity projects LITMUS: the resolver check fires on a bad file: path", () => {
  // A check that cannot fail is worse than none — prove this one detects a bad depth.
  const packagesDir = path.join(REPO_ROOT, "unity-dev-project", "Packages");
  const bogus = path.resolve(packagesDir, "../../../packages/com.loomtide.loombridge");
  assert.ok(
    !fs.existsSync(bogus),
    "the pre-fix (one-too-many '..') path must NOT resolve, or this check proves nothing",
  );
});

test("unity projects: the EditMode project is the one that declares the package testable", () => {
  // This is what makes unity-dev-project test infrastructure rather than a demo, and why it
  // lives outside demos/. If the roles ever swap, the topology in ARCHITECTURE.md is wrong.
  const read = (rel: string) =>
    JSON.parse(fs.readFileSync(path.join(REPO_ROOT, rel, "Packages", "manifest.json"), "utf-8"));

  assert.deepEqual(read("unity-dev-project").testables, ["com.loomtide.loombridge"]);
  assert.equal(read("demos/unity-platformer").testables, undefined);
});
