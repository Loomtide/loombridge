/**
 * The any-genre authoring documentation, and every path it declares.
 *
 * The RFC's finding was that `--genre-contract` / `--brief` were undocumented on the agent
 * surface, so agents force-fit an unregistered genre into the nearest pack and got a `graded`
 * stamp over gates the game was never designed for. Prose is the fix, which makes the prose
 * load-bearing: this walks it.
 *
 * It also resolves every repo-relative path the new docs and the `genre` verb's help text name.
 * A doc pointing at a file that does not exist is the same failure shape as a declared path
 * nothing walks: invisible to a green suite, and discovered by a partner.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { REPO_ROOT } from "../../_support/paths.js";
import { loombridgeCli } from "../../../surfaces/cli.js";
import { formatDesignHardeningAdvisory } from "../../../capabilities/genre/genre-contract/design-hardening.js";
import {
  isScaffoldError,
  scaffoldGenreContract,
} from "../../../capabilities/genre/genre-contract/scaffold.js";

const GUIDE = "Docs/Profiles/GenreContractAuthoring.md";
const PLAN = "commands/loombridge/plan.md";

function read(rel: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, rel), "utf-8");
}

/**
 * Repo-relative paths a document points at: markdown link targets, and backticked paths that
 * name a real repo directory. Shared with the litmus below so the extractor cannot be tuned to
 * pass by finding nothing.
 */
function declaredPaths(text: string, fromDir: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\]\((\.{1,2}\/[^)#]+)\)/g)) {
    out.add(path.normalize(path.join(fromDir, m[1]!)));
  }
  for (const m of text.matchAll(/`((?:Docs|commands|mcp-server|scripts|\.skills)\/[^`\s]+)`/g)) {
    out.add(m[1]!);
  }
  return [...out];
}

test("the authoring guide exists and every path it declares resolves", () => {
  const text = read(GUIDE);
  const paths = declaredPaths(text, path.dirname(GUIDE));
  assert.ok(paths.length >= 4, `expected the guide to point at the schema, the example, and the RFC; found ${paths.length}`);
  for (const rel of paths) {
    assert.ok(fs.existsSync(path.join(REPO_ROOT, rel)), `${GUIDE} points at a missing path: ${rel}`);
  }
});

test("the authoring guide covers the decisions, not the field list", () => {
  const text = read(GUIDE);
  for (const required of [
    "loombridge genre init",
    "partially-graded",
    "fidelityCriteria",
    "genreClass",
    "measurable-now",
    "gateBand",
  ]) {
    assert.ok(text.includes(required), `${GUIDE} must cover "${required}"`);
  }
  // The schema is the ergonomics layer, never the gate. A guide that implies otherwise teaches a
  // reader that a schema-clean file is an accepted one.
  assert.match(text, /schema is not the gate/i);
});

test("plan.md documents the any-genre path it used to omit entirely", () => {
  const text = read(PLAN);
  for (const required of ["--genre-contract", "--brief", "loombridge genre init", "partially-graded", "fidelityCriteria"]) {
    assert.ok(text.includes(required), `${PLAN} must document "${required}"`);
  }
  // The cost of the missing field, stated where the agent will read it: absent fidelityCriteria
  // means doneness REFUSES a design-targeted build, which is the whole reason to seed it.
  assert.match(text, /fidelityCriteria[\s\S]{0,600}?doneness[\s\S]{0,120}?REFUSES/i);
});

test("plan.md's paths resolve, and no dangling link ships to a consumer project", () => {
  const text = read(PLAN);
  for (const rel of declaredPaths(text, path.dirname(PLAN))) {
    assert.ok(fs.existsSync(path.join(REPO_ROOT, rel)), `${PLAN} points at a missing path: ${rel}`);
  }
  // The command bodies are scrubbed and installed into partner repos where `Docs/` does not
  // exist, so a Docs reference is a code span (a pointer) and never a markdown link (a promise).
  assert.doesNotMatch(text, /\]\([^)]*Docs\//, `${PLAN} must not link into Docs/: the installed copy has no Docs/ tree`);
});

test("`genre --help` points only at references a CONSUMER actually has", async () => {
  // The npm package's `files` is ["dist","src","bridge","agent-surface","NOTICE"], no `Docs/`. A
  // bare `Docs/...` pointer in CLI output is therefore dangling on every machine that installed
  // from npm. The same reasoning `plan.md` already encodes for its own Docs references.
  const origLog = console.log;
  const lines: string[] = [];
  console.log = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  let code: number;
  try {
    code = await loombridgeCli(["node", "cli.js", "genre", "--help"]);
  } finally {
    console.log = origLog;
  }
  const help = lines.join("\n");
  assert.equal(code, 0);

  const shipped = new Set((JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, "mcp-server", "package.json"), "utf-8"),
  ) as { files: string[] }).files);

  // Every bare repo-relative pointer must live under a shipped top-level directory AND exist.
  const referenced = [...help.matchAll(/(?:^|\s)((?:Docs|mcp-server|commands|scripts|src)\/[^\s`)]+)/g)]
    .map((m) => m[1]!);
  assert.ok(referenced.length > 0, "the help text should point somewhere for the full reference");
  for (const rel of referenced) {
    const top = rel.split("/")[0]!;
    assert.ok(
      shipped.has(top) || shipped.has(rel.replace(/^mcp-server\//, "").split("/")[0]!),
      `genre --help points at "${rel}", which the npm package does not ship (files: ${[...shipped].join(", ")})`,
    );
    const onDisk = fs.existsSync(path.join(REPO_ROOT, rel)) ||
      fs.existsSync(path.join(REPO_ROOT, "mcp-server", rel));
    assert.ok(onDisk, `genre --help points at a missing path: ${rel}`);
  }
  // A Docs/ reference is allowed ONLY as a full URL, which resolves for everyone.
  const bareDocs = [...help.matchAll(/(?<!\/)\bDocs\/[^\s`)]+/g)]
    .map((m) => m[0])
    .filter((ref) => !help.includes(`https://github.com/Loomtide/loombridge/blob/main/${ref}`));
  assert.deepEqual(bareDocs, [], `genre --help must link Docs/ by URL, not by a path npm does not ship`);
});

/* ------------------------------------------------------- the advisory both docs describe */

/**
 * The advisory codes `plan` ACTUALLY emits for a freshly scaffolded contract, derived by running the
 * real formatter over the real scaffold rather than read off a hand-written list.
 *
 * Both docs listed `requiredEvidenceClasses` among the advisories `plan` prints. It does not warn
 * for that at all: the coverage item falls back to the per-slice `gates` proxy and reports
 * `[OK] proxied`, while the advisory that DOES fire, `COVERAGE_ACCEPTANCE_PROTOCOL_PARTIAL`, was in
 * neither doc. Prose about what a tool prints is checkable, so it is checked.
 */
function emittedAdvisoryCodes(): string[] {
  const scaffold = scaffoldGenreContract({ genreId: "docs-fixture-genre", genreClass: "twitch" });
  assert.ok(!isScaffoldError(scaffold), isScaffoldError(scaffold) ? scaffold.error : "");
  const codes = new Set<string>();
  for (const line of formatDesignHardeningAdvisory(scaffold.contract)) {
    for (const m of line.matchAll(/WARN ([A-Z0-9_]+):/g)) codes.add(m[1]!);
  }
  return [...codes].sort();
}

test("both docs name exactly the advisories `plan` really prints", () => {
  const codes = emittedAdvisoryCodes();
  assert.ok(codes.length > 0, "the scaffold must emit at least one advisory, or this guard is vacuous");
  assert.ok(
    codes.includes("COVERAGE_ACCEPTANCE_PROTOCOL_PARTIAL"),
    `expected the acceptance-protocol advisory to fire on a scaffold; got ${codes.join(", ")}`,
  );
  for (const doc of [GUIDE, PLAN]) {
    const text = read(doc);
    for (const code of codes) {
      assert.ok(text.includes(code), `${doc} does not name the advisory \`plan\` prints: ${code}`);
    }
  }
});

test("neither doc claims `plan` warns about requiredEvidenceClasses, because it does not", () => {
  assert.ok(
    !emittedAdvisoryCodes().some((c) => /EVIDENCE/.test(c)),
    "premise: an absent requiredEvidenceClasses must not produce a WARN",
  );
  for (const doc of [GUIDE, PLAN]) {
    const text = read(doc);
    // The claim being guarded against is "plan prints an advisory naming each absence" over a list
    // that INCLUDES requiredEvidenceClasses. Require the doc to state the opposite explicitly.
    assert.match(
      text,
      /requiredEvidenceClasses[\s\S]{0,600}?(NOT warned|not warned|\[OK\] proxied|`\[OK\] proxied`|reports `\[OK\] proxied`)/,
      `${doc} must say an absent requiredEvidenceClasses is NOT warned (it reports [OK] proxied)`,
    );
  }
});

/* ------------------------------------------------------- the human-in-the-loop skill */

test("the skill both docs route humans to actually covers the contract's highest-value field", () => {
  // Both docs frame `.skills/genre-pack-authoring/` as "the better path when a human is in the
  // loop". It contained zero occurrences of `fidelityCriteria`, `partially-graded`, `doneness`, or
  // `plan`, so the routed-to path could not produce the field this whole wave calls highest-value.
  const skill = "\.skills/genre-pack-authoring/SKILL.md".replace(/\\/g, "");
  for (const doc of [GUIDE, PLAN]) {
    assert.ok(read(doc).includes("genre-pack-authoring"), `${doc} must still route to the skill`);
  }
  const text = read(skill);
  for (const required of ["fidelityCriteria", "partially-graded", "doneness", "loombridge plan --brief"]) {
    assert.ok(text.includes(required), `${skill} must cover "${required}"`);
  }
  // The cost of the missing field, stated where the interviewer will read it.
  assert.match(text, /fidelityCriteria[\s\S]{0,900}?doneness[\s\S]{0,120}?REFUSES/i);
});

test("LITMUS: the path extractor finds real references and rejects broken ones", () => {
  // A doc-path guard that extracts nothing passes forever. Prove the extractor sees both shapes
  // it is written for, and that a missing target would actually be caught.
  const sample = "see [the schema](../foo/bar.json) and `Docs/Profiles/Nope.md` and `not/a/repo/path`.";
  const found = declaredPaths(sample, "Docs/Profiles");
  assert.deepEqual(found.sort(), ["Docs/Profiles/Nope.md", "Docs/foo/bar.json"]);
  assert.ok(!fs.existsSync(path.join(REPO_ROOT, "Docs/Profiles/Nope.md")), "the litmus target must not exist");
  assert.deepEqual(declaredPaths("prose with no paths at all", "Docs"), []);
});
