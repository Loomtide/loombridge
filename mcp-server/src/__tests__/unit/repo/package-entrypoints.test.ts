import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { packageRoot } from "../../../shared/pkg-root.js";

/**
 * Every path package.json advertises must actually exist in the built output.
 *
 * `bin` entries are declared paths that nothing imports, so no unit test walks them: the
 * source reorganisation moved `dist/capabilities/verification/**` to `dist/capabilities/verification/**`
 * and the whole suite stayed green while three published executables
 * (loombridge-run-gates, loombridge-capture-runner, loombridge-analyze-frames) pointed at
 * files that no longer existed. That breaks only for whoever installs the package.
 */

const PKG_ROOT = packageRoot(import.meta.url);

/**
 * Any relative path an npm script names. Deliberately NOT limited to `dist/` and `src/`:
 * five scripts here reach outside the package (`../scripts/write-build-info.mjs`,
 * `../scripts/loombridge-pack-bridge.sh` and `../scripts/build-agent-surface.mjs` are in
 * `prepack`, so moving one breaks `npm pack` itself), and a leading `./` or `../` was
 * previously unmatched entirely. Glob patterns are skipped — they are checked by the
 * suite actually running.
 */
const SCRIPT_PATH_RE =
  /(?:^|[\s"'(=])((?:\.{1,2}\/)?(?:[\w.@-]+\/)*[\w.@-]+\.(?:js|mjs|cjs|ts|sh|json))/g;
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
 * (dist/capabilities/assets/…) — one of which runs in CI, so main was red while this test was
 * green. Checking EXISTENCE instead of enumerating known-bad prefixes cannot go stale.
 */
test("package entrypoints: every dist/ or src/ path named by an npm script exists", () => {
  const referenced: string[] = [];
  for (const [name, cmd] of Object.entries(pkg.scripts ?? {})) {
    for (const m of String(cmd).matchAll(SCRIPT_PATH_RE)) {
      const rel = m[1]!;
      if (!fs.existsSync(path.resolve(PKG_ROOT, rel))) referenced.push(`${name}: ${rel}`);
    }
  }
  assert.deepEqual(
    referenced,
    [],
    `npm script(s) name a path that does not exist:\n  ${referenced.join("\n  ")}`,
  );
});

test("package entrypoints: test scripts avoid runner features CI's Node lacks", () => {
  // CI pins Node 20; local dev is often newer. Node 22+ treats a positional as a GLOB,
  // Node 20 treats it as a DIRECTORY — so `"dist/**/*.test.js"` passes locally and fails
  // on CI with "Could not find ...", and `dist/<dir>` does the reverse. main's CI was red
  // for two commits because of exactly that. Letting the SHELL expand the file list works
  // on every version, so keep glob metacharacters out of the runner's arguments.
  for (const name of ["test:unit", "test:integration"]) {
    const cmd = String((pkg.scripts ?? {})[name] ?? "");
    assert.ok(cmd, `${name} must exist`);
    const positional = cmd.replace(/\$\([^)]*\)/g, ""); // drop $(find ...) — the shell handles it
    assert.doesNotMatch(
      positional,
      /\*/,
      `${name} passes a glob to node --test; Node 20 cannot expand it. Let the shell build the list.`,
    );
  }
});

/**
 * `dist/shared/bridge-source-digest.js` is a declared path with NO importer: only
 * `scripts/loombridge-pack-bridge.sh` names it, by shelling to it. Nothing in the suite
 * would notice it moving, and the failure would land on whoever next packs a bridge
 * tarball, which is the release path. Read the declaration out of the script rather than
 * restating it here, so the two cannot drift.
 */
const PACK_SCRIPT = path.join(path.dirname(PKG_ROOT), "scripts", "loombridge-pack-bridge.sh");

test("package entrypoints: the digest builder the pack script shells to exists in dist", () => {
  const script = fs.readFileSync(PACK_SCRIPT, "utf-8");
  const declared = script.match(/^DIGEST_BUILDER_REL="([^"]+)"$/m);
  assert.ok(declared, "loombridge-pack-bridge.sh must declare DIGEST_BUILDER_REL for this guard to walk");
  const rel = declared![1]!;
  assert.ok(
    fs.existsSync(path.join(path.dirname(PKG_ROOT), rel)),
    `the pack script shells to ${rel}, which does not exist in the build output`,
  );
});

test("package entrypoints LITMUS: the digest-builder check fires on a bogus declared path", () => {
  const bogus = "mcp-server/dist/shared/definitely-not-here.js";
  const declared = `DIGEST_BUILDER_REL="${bogus}"\n`.match(/^DIGEST_BUILDER_REL="([^"]+)"$/m);
  assert.ok(declared, "the extractor must find the declaration the check would test");
  assert.equal(fs.existsSync(path.join(path.dirname(PKG_ROOT), declared![1]!)), false);
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
