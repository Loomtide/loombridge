import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { packageRoot } from "../../../shared/pkg-root.js";

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

/**
 * Every dist/ or src/ path an npm script names must exist. The earlier version of this
 * test pattern-matched two renamed prefixes and therefore missed `docs:tools`
 * (src/tools-doc-gen.ts), `spike:ws` (src/spike-ws-client.ts) and `asset:handoff:check`
 * (dist/asset-layer/…) — one of which runs in CI, so main was red while this test was
 * green. Checking EXISTENCE instead of enumerating known-bad prefixes cannot go stale.
 */
test("package entrypoints: every dist/ or src/ path named by an npm script exists", () => {
  const referenced: string[] = [];
  for (const [name, cmd] of Object.entries(pkg.scripts ?? {})) {
    for (const m of String(cmd).matchAll(/(?:^|[\s"'([])((?:dist|src)\/[\w./-]+\.(?:js|mjs|ts|json))/g)) {
      if (!fs.existsSync(path.join(PKG_ROOT, m[1]))) referenced.push(`${name}: ${m[1]}`);
    }
  }
  assert.deepEqual(
    referenced,
    [],
    `npm script(s) name a path that does not exist:\n  ${referenced.join("\n  ")}`,
  );
});

test("package entrypoints LITMUS: the npm-script path check fires on a bogus path", () => {
  const bogus = "dist/definitely/not/here.js";
  assert.ok(!fs.existsSync(path.join(PKG_ROOT, bogus)), "fixture path must not exist");
  const hits = [...`node ${bogus}`.matchAll(/(?:^|[\s"'([])((?:dist|src)\/[\w./-]+\.(?:js|mjs|ts|json))/g)];
  assert.equal(hits.length, 1, "the extractor must find the path the check would test");
});

test("package entrypoints LITMUS: the check fires on a bogus bin target", () => {
  const missing = Object.entries({ "fake-bin": "dist/definitely/not/here.js" }).filter(
    ([, rel]) => !fs.existsSync(path.join(PKG_ROOT, rel)),
  );
  assert.equal(missing.length, 1, "the existence check must actually detect a missing target");
});
