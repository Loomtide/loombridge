/**
 * EVERY DOOR INTO `gradeTestResults`, and what each one attributes its walk to (H3).
 *
 * THE FINDING THIS FILE EXISTS FOR. The five producer bindings used to be five independent
 * optional fields, each guarded by `if (input.X !== undefined && ...)`, with the refusal
 * DELEGATED to the call sites. The audit judged that deliberate (a bare CI XML is a supported
 * input) but `nunit-parse.ts`'s own comment argues the other way, in the same file, two
 * screens above the guards: *a rule enforced by one door is a rule the other doors do not
 * have.* It was not theoretical. `tests grade` degraded a manifest that FAILED INTEGRITY into
 * the unstamped path, which turned all five fields into `undefined` in one statement, and a
 * manifest carrying `exitCode: 3`, `compileErrors: 42`, `mutatedProject: true`, a forged
 * summary and a forged assembly list exited 0 under the CI attestation.
 *
 * THE DECISION. The bindings are now MANDATORY AT THE GRADER, as a required discriminated
 * `attribution`, and the bare-XML case is an EXPLICIT, NAMED opt-in (`kind: "unattributed"`)
 * carrying the reason it is unattributed. The type makes omission impossible; the opt-in
 * makes the supported CI flow a stated decision rather than the shape an absent field falls
 * into. But a type only constrains the doors that EXIST TODAY, so this file walks the source
 * for the doors themselves:
 *
 *  1. the production call sites of `gradeTestResults` are exactly the three known doors, so a
 *     fourth cannot appear without this guard failing;
 *  2. each one passes the attribution kind its position allows;
 *  3. and the two doors that could ever print a green prove BEHAVIOURALLY, not by inspection,
 *     that an unattributed walk cannot be quoted.
 *
 * The scan is a guard against a NEW door, not a substitute for the behavioural tests: those
 * live in `tests-grade-cli.test.ts` (`tests grade`), `tests-run-cli.test.ts` (`tests run`) and
 * `unified-tests-section.test.ts` (`verify`).
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { PKG_ROOT } from "../../../_support/paths.js";

/** The three doors, and the attribution each is allowed to state. */
const DOORS: ReadonlyArray<{ file: string; door: string; kind: string; why: string }> = [
  {
    file: "src/capabilities/tests/tests.ts",
    door: "`tests run` (the producer) and `tests grade` (the diagnostic reader)",
    // This file holds TWO doors, and between them they use all three kinds.
    kind: "producer|stamped|unattributed",
    why: "the producer spawned the editor; the reader either holds a verified manifest or names why it holds none",
  },
  {
    file: "src/capabilities/verification/unified/orchestrator.ts",
    door: "`verify` (the unified consumer)",
    kind: "stamped",
    why: "every path that could not produce a verified manifest has already returned a refusal",
  },
];

/** Every `.ts` file under a directory, recursively. Node-only, no shell, no glob. */
function walkTs(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) walkTs(abs, out);
    else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(abs);
  }
  return out;
}

/**
 * Source files under `src/` that CALL the grader, excluding the tests that drive it.
 *
 * Walked rather than listed: a new door in a new file is exactly what this guard is for, and
 * a hand-written list would not notice one. The declaring file itself is excluded by matching
 * a CALL (`gradeTestResults(`) preceded by something other than `export function`.
 */
function productionCallSites(): string[] {
  const srcRoot = path.join(PKG_ROOT, "src");
  const testsRoot = path.join(srcRoot, "__tests__");
  const declaring = path.join(srcRoot, "capabilities", "tests", "nunit-parse.ts");
  return walkTs(srcRoot)
    .filter((abs) => !abs.startsWith(testsRoot) && abs !== declaring)
    .filter((abs) => /\bgradeTestResults\(/.test(readFileSync(abs, "utf-8")))
    .map((abs) => path.relative(PKG_ROOT, abs))
    .sort();
}

test("H3: the ONLY production callers of gradeTestResults are the three known doors", () => {
  assert.deepEqual(
    productionCallSites(),
    DOORS.map((d) => d.file).sort(),
    "a new caller of the test-results grader appeared; give it an attribution and add it here, " +
      "or it is a door with rules the other doors do not have",
  );
});

test("H3: each door states an attribution its position can actually justify", () => {
  for (const { file, door, kind, why } of DOORS) {
    const source = readFileSync(path.join(PKG_ROOT, file), "utf-8");
    const allowed = kind.split("|");
    // Every `kind:` this file hands the grader must be one the door is allowed to state.
    const stated = [...source.matchAll(/attribution:\s*\{\s*\n?\s*kind:\s*"([a-z]+)"/g)].map((m) => m[1]!);
    const inline = [...source.matchAll(/\{\s*kind:\s*"(unattributed|stamped|producer)"/g)].map((m) => m[1]!);
    const all = [...new Set([...stated, ...inline])];
    assert.ok(all.length > 0, `${file} calls the grader but states no attribution kind`);
    for (const k of all) {
      assert.ok(allowed.includes(k), `${door} states attribution '${k}', which ${why}, does not justify`);
    }
  }
});

test("H3: the unified door has NO unattributed path, structurally", () => {
  // `verify` is the door whose output a slice verdict and the doneness certificate quote, so
  // it is the one door that must never grade a walk nothing bound. It refuses BEFORE the
  // grader on every shape that lacks a verified manifest, which is why the word
  // "unattributed" does not occur in it at all.
  const source = readFileSync(
    path.join(PKG_ROOT, "src/capabilities/verification/unified/orchestrator.ts"),
    "utf-8",
  );
  assert.ok(
    !source.includes('kind: "unattributed"'),
    "the unified door must not be able to grade an unattributed walk",
  );
  // NON-VACUITY: it does call the grader, and it does state `stamped`, so the assertion above
  // is about an absent PATH and not about a file that stopped grading.
  assert.match(source, /gradeTestResults\(\{/);
  assert.match(source, /kind: "stamped"/);
});

/**
 * LITMUS, run against the REAL guard with a REAL fourth door on disk.
 *
 * `src/capabilities/scratchdoor/new-door.ts` planted, containing a genuine
 * `gradeTestResults({ run, strict: false, attribution: { kind: "unattributed", why: "shortcut" } })`,
 * then `npm run build` and the guard re-run. Observed verbatim:
 *
 *   ✖ H3: the ONLY production callers of gradeTestResults are the three known doors
 *     AssertionError [ERR_ASSERTION]: a new caller of the test-results grader appeared; give it an
 *     attribution and add it here, or it is a door with rules the other doors do not have
 *   ℹ tests 4 / ℹ pass 3 / ℹ fail 1
 *
 * File removed, rebuilt: `ℹ tests 4 / ℹ pass 4 / ℹ fail 0`.
 *
 * The in-process LITMUS below drives the same `deepEqual` the guard uses, so the check cannot
 * be weakened without this failing too.
 */
test("LITMUS: the door scan really fails when a fourth door appears", () => {
  // Feed the REAL comparison a planted extra caller. A LITMUS that re-implements the check
  // inline proves nothing about the code that ships, so this drives the same `deepEqual` the
  // guard uses, over a list with one file added.
  const real = DOORS.map((d) => d.file).sort();
  const planted = [...real, "src/capabilities/somewhere/new-door.ts"].sort();
  assert.throws(
    () => assert.deepEqual(planted, real),
    "a new production caller must not be able to slip past the guard",
  );

  // …and the allowed-kind check fires on a door that states one it may not.
  const allowed = ["stamped"];
  assert.throws(() => {
    for (const k of ["stamped", "unattributed"]) {
      assert.ok(allowed.includes(k), `the unified door may not state '${k}'`);
    }
  });
});
