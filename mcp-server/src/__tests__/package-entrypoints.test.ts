import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { packageRoot } from "../shared/pkg-root.js";

/**
 * Every path package.json advertises must actually exist in the built output.
 *
 * `bin` entries are declared paths that nothing imports, so no unit test walks them: the
 * source reorganisation moved `dist/verification/**` to `dist/capabilities/verification/**`
 * and the whole suite stayed green while three published executables
 * (loombridge-run-gates, loombridge-capture-runner, loombridge-analyze-frames) pointed at
 * files that no longer existed. That breaks only for whoever installs the package.
 */

const PKG_ROOT = packageRoot(import.meta.url);
const pkg = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, "package.json"), "utf-8"));

test("package entrypoints: every bin target exists in dist", () => {
  const missing = Object.entries(pkg.bin ?? {})
    .filter(([, rel]) => !fs.existsSync(path.join(PKG_ROOT, rel as string)))
    .map(([name, rel]) => `${name} -> ${rel}`);

  assert.deepEqual(missing, [], `package.json bin points at missing file(s):\n  ${missing.join("\n  ")}`);
});

test("package entrypoints: main exists in dist", () => {
  assert.ok(pkg.main, "package.json must declare main");
  assert.ok(
    fs.existsSync(path.join(PKG_ROOT, pkg.main)),
    `package.json main points at a missing file: ${pkg.main}`,
  );
});

test("package entrypoints: npm scripts do not reference a stale dist layout", () => {
  // The reorg renamed these prefixes; a script still naming them would fail only when run.
  const stale = Object.entries(pkg.scripts ?? {})
    .filter(([, cmd]) => /dist\/(verification|loombridge)\//.test(cmd as string))
    .map(([name, cmd]) => `${name}: ${cmd}`);

  assert.deepEqual(stale, [], `npm script(s) reference a pre-reorg dist path:\n  ${stale.join("\n  ")}`);
});

test("package entrypoints LITMUS: the check fires on a bogus bin target", () => {
  const missing = Object.entries({ "fake-bin": "dist/definitely/not/here.js" }).filter(
    ([, rel]) => !fs.existsSync(path.join(PKG_ROOT, rel)),
  );
  assert.equal(missing.length, 1, "the existence check must actually detect a missing target");
});
