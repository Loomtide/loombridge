import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { PKG_ROOT, REPO_ROOT } from "../../_support/paths.js";

/**
 * `mcp-server/README.md` IS the npm landing page, and nothing walked it.
 *
 * npm renders the README found at the PACKAGE root, which is `mcp-server/` — not the repository
 * root. So the file a visitor to npmjs.com/package/loombridge reads is not the one every other
 * README guard in this suite walks. It drifted for months behind a fully green suite and shipped
 * that way in `0.1.0`, the first public release: it told anyone who had just installed the package
 * to build it from source (`cd mcp-server && npm install && npm run build`), pointed at
 * `unity-dev-project` and `demos/unity-platformer` (repo-internal directories a consumer does not
 * have), pinned Unity `6000.3 LTS` against a support matrix that says `6000.x`, and never mentioned
 * `loombridge setup` or the record/verify/approve surface at all. Fixed in `0.1.1`.
 *
 * This is the repo's signature failure shape — a declared, SHIPPED path that no test walks — so the
 * fix does not count without the guard.
 *
 * The rules below are not style preferences. Each one encodes a way npm's renderer differs from
 * GitHub's, where the failure is silent and only visible on the published page:
 *
 *   1. RELATIVE LINKS RESOLVE AGAINST `repository.directory`. That field is `mcp-server`, so a
 *      relative `ROADMAP.md` resolves to `.../tree/HEAD/mcp-server/ROADMAP.md` and 404s, because
 *      ROADMAP.md lives at the repo root. Absolute URLs only.
 *   2. npm SANITIZES RAW HTML. The root README opens with a `<div align="center">` masthead; copied
 *      here, the layout silently collapses to left-aligned.
 *   3. A CONSUMER IS NOT A CONTRIBUTOR. Repo-internal paths and build-from-source instructions are
 *      the specific rot that shipped, and they read as authoritative on the package page.
 *
 * Deliberately NOT asserted: that the two READMEs agree in wording. They are different documents for
 * different audiences by design (the root page carries a video and a mermaid diagram, neither of
 * which npm renders). Only the SUPPORT CLAIM is cross-checked, because two pages naming different
 * supported Unity versions is a contradiction rather than a difference in voice.
 */

const NPM_README = path.join(PKG_ROOT, "README.md");
const ROOT_README = path.join(REPO_ROOT, "README.md");

function read(file: string): string {
  return readFileSync(file, "utf-8");
}

/**
 * Every markdown link target in `md` that npm would resolve against `repository.directory`.
 *
 * Matches on `](target` rather than a full `[text](target)` pair on purpose: badge links nest
 * (`[![CI](img)](href)`), and a bracket-balancing regex silently skips the outer href of every one
 * of them — which is exactly the kind of hole that makes a guard look green while walking nothing.
 */
function relativeLinkTargets(md: string): string[] {
  const targets = [...md.matchAll(/\]\(([^)\s]+)/g)].map((m) => m[1]!);
  return targets.filter(
    (t) => !/^(https?:\/\/|#|mailto:)/.test(t),
  );
}

test("LITMUS: relativeLinkTargets actually catches the link shape that 404s on npm", () => {
  // Runs the REAL function used by the assertions below. If this file's checker were ever loosened
  // into a no-op, this fails first and names why — rather than every assertion passing vacuously.
  assert.deepEqual(
    relativeLinkTargets("see [the roadmap](ROADMAP.md) and [license](../LICENSE)"),
    ["ROADMAP.md", "../LICENSE"],
    "a relative link must be reported: under repository.directory=mcp-server it 404s on npm",
  );
  assert.deepEqual(
    relativeLinkTargets("[docs](https://github.com/Loomtide/loombridge) and [top](#install)"),
    [],
    "absolute URLs and in-page anchors are the two safe forms and must not be flagged",
  );
  // The nested-badge shape that a bracket-balancing regex drops on the floor.
  assert.deepEqual(
    relativeLinkTargets("[![CI](https://img.example/b.svg)](workflows/ci.yml)"),
    ["workflows/ci.yml"],
    "a badge's outer href must be walked too, not skipped as nested brackets",
  );
});

test("the npm landing page is the package README, and repository.directory is why", () => {
  // The entire relative-link hazard is downstream of this field. If it is ever dropped or changed,
  // the reasoning in this file's header stops being true and the rules need rethinking, so pin it.
  const pkg = JSON.parse(read(path.join(PKG_ROOT, "package.json"))) as {
    name: string;
    repository?: { directory?: string };
  };
  assert.equal(
    pkg.repository?.directory,
    "mcp-server",
    "repository.directory must stay 'mcp-server': npm resolves README relative links against it",
  );
  assert.equal(pkg.name, "loombridge", "the published package name is quoted in the README install line");
});

test("the npm README carries no relative links (they 404 on the published page)", () => {
  const offenders = relativeLinkTargets(read(NPM_README));
  assert.deepEqual(
    offenders,
    [],
    `mcp-server/README.md must use absolute URLs. npm resolves relative targets against `
      + `repository.directory ("mcp-server"), so these 404 on the package page: ${offenders.join(", ")}`,
  );
});

test("the npm README carries no raw HTML (npm sanitizes it)", () => {
  const md = read(NPM_README);
  const tags = [...md.matchAll(/<(div|img|em|strong|p|br|center|picture|video|source)\b[^>]*>/gi)].map(
    (m) => m[0]!,
  );
  assert.deepEqual(
    tags,
    [],
    `mcp-server/README.md must be plain markdown. npm strips raw HTML, so the root README's `
      + `centered masthead collapses if copied here. Found: ${tags.join(", ")}`,
  );
});

test("the npm README addresses a consumer, not a contributor", () => {
  const md = read(NPM_README);

  // The exact rot that shipped in 0.1.0. Each of these told someone who had just run
  // `npm install -g loombridge` to act as though they had cloned the repo.
  const repoInternal = [
    "unity-dev-project",
    "demos/unity-platformer",
    "cd mcp-server",
    "npm run build",
  ];
  for (const needle of repoInternal) {
    assert.ok(
      !md.includes(needle),
      `mcp-server/README.md must not reference "${needle}": it is the npm landing page, and a `
        + `consumer who installed the package has no repo checkout. Contributor setup belongs in `
        + `CONTRIBUTING.md.`,
    );
  }

  assert.ok(
    md.includes("npm install -g loombridge"),
    "the npm landing page must open with the install command for the package it is the page for",
  );
  assert.ok(
    md.includes("loombridge setup"),
    "the npm landing page must name `loombridge setup`, the one command that wires a Unity project",
  );
});

test("the npm README's Unity support claim does not contradict the root README", () => {
  const npm = read(NPM_README);
  const root = read(ROOT_README);

  // 0.1.0 shipped "Unity 6000.3 LTS (primary target)" here while the root support matrix said
  // `6000.x`. A visitor comparing the two pages got two different answers about what is supported.
  for (const [label, md] of [["mcp-server/README.md", npm], ["README.md", root]] as const) {
    assert.ok(md.includes("2022.3"), `${label} must name 2022.3 as the compatibility floor`);
    assert.ok(md.includes("6000.x"), `${label} must name the 6000.x range, not a single minor`);
  }

  const overSpecific = [...npm.matchAll(/6000\.\d+/g)].map((m) => m[0]!);
  assert.deepEqual(
    overSpecific,
    [],
    `mcp-server/README.md must not pin a specific Unity 6000 minor (${overSpecific.join(", ")}). `
      + `Support runs across 6000.x; naming one minor is the drift that shipped in 0.1.0.`,
  );
});
