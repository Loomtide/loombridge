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

test("`genre --help` points at documentation that exists", async () => {
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
  const referenced = [...help.matchAll(/(Docs\/[^\s`]+\.md)/g)].map((m) => m[1]!);
  assert.ok(referenced.length > 0, "the help text should point somewhere for the full guide");
  for (const rel of referenced) {
    assert.ok(fs.existsSync(path.join(REPO_ROOT, rel)), `genre --help points at a missing doc: ${rel}`);
  }
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
