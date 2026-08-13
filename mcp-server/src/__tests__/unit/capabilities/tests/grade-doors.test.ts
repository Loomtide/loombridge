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
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

/** The grader's declaring module, by path segments, so the specifier match cannot drift. */
const DECLARING_MODULE = ["capabilities", "tests", "nunit-parse.ts"] as const;
const GRADER = "gradeTestResults";

/**
 * Does this specifier name the module that declares the grader?
 *
 * Suffix-matched on the basename rather than resolved, because the guard reads SOURCE (`.js`
 * specifiers pointing at `.ts` files under NodeNext) and a resolver here would be a second
 * implementation of module resolution that could disagree with the compiler's.
 */
function isDeclaringSpecifier(specifier: string): boolean {
  const base = specifier.split("/").pop() ?? "";
  return base === "nunit-parse.js" || base === "nunit-parse";
}

/**
 * Every import/export-from statement in a source file, as `{ clause, specifier }`.
 *
 * Deliberately syntactic and small: this is a guard, not a compiler. It sees the four shapes
 * that can carry a binding across a module boundary (named import, namespace import,
 * re-export, `export *`) plus dynamic `import(...)`, which is handled separately below.
 */
function moduleBindings(source: string): Array<{ clause: string; specifier: string; isExport: boolean }> {
  const out: Array<{ clause: string; specifier: string; isExport: boolean }> = [];
  const re = /\b(import|export)\b([\s\S]*?)\bfrom\s*["']([^"']+)["']/g;
  for (const m of source.matchAll(re)) {
    out.push({ clause: m[2]!, specifier: m[3]!, isExport: m[1] === "export" });
  }
  return out;
}

/**
 * WHY THE SCAN IS SEMANTIC AND NOT TEXTUAL (the fourth-door finding).
 *
 * The first cut of this guard tested `/\bgradeTestResults\(/` against the file's text. That
 * catches a door written the naive way and NOTHING else. The reviewer planted a real fourth
 * production door on disk, grading an unattributed walk, and the whole guard file reported
 * `tests 4 / pass 4 / fail 0`:
 *
 *   import { gradeTestResults as gradeIt, ... } from "../tests/nunit-parse.js";
 *   return gradeIt({ run, strict: false, attribution: { kind: "unattributed", why: "shortcut" } }).tier;
 *
 * `const g = gradeTestResults; g(...)` is the same class, and so is a namespace import. H3's
 * entire "a fourth door cannot appear" claim rested on that one regex.
 *
 * THE FIX RESOLVES THE BINDING RATHER THAN THE CALL. A module cannot use the grader without
 * naming it in an import statement, and ALIASING DOES NOT HIDE THE NAME: `import { X as y }`
 * still contains `X`. So a file is a door when it imports `gradeTestResults` from the declaring
 * module under any spelling. Three shapes that would launder the name out of the import clause
 * are refused outright rather than resolved, because none of them has an honest use here:
 *
 *   - a NAMESPACE import (`import * as np from "…/nunit-parse.js"`), which puts every export
 *     behind a property access this scan would have to model;
 *   - a RE-EXPORT of the grader, which would make some other module the declaring module and
 *     move the doors out of this scan's reach entirely;
 *   - a DYNAMIC import of the declaring module, same reason as the namespace import.
 *
 * What remains uncovered is stated rather than papered over: a door that obtains the function
 * without any module binding at all (via `globalThis`, `eval`, or a compiled artifact) is not
 * visible to a source scan. The belt-and-braces textual check below catches the plain form of
 * that; the honest close is the type, which no door can satisfy without stating an attribution
 * and a surface.
 */
export function graderDoorScan(srcRoot: string = path.join(PKG_ROOT, "src")): {
  doors: string[];
  violations: string[];
} {
  const testsRoot = path.join(srcRoot, "__tests__");
  const declaring = path.join(srcRoot, ...DECLARING_MODULE);
  const doors: string[] = [];
  const violations: string[] = [];

  for (const abs of walkTs(srcRoot)) {
    if (abs.startsWith(testsRoot) || abs === declaring) continue;
    const source = readFileSync(abs, "utf-8");
    const rel = path.relative(srcRoot, abs).split(path.sep).join("/");
    let bound = false;

    for (const { clause, specifier, isExport } of moduleBindings(source)) {
      if (!isDeclaringSpecifier(specifier)) continue;
      if (/\*\s*as\s+\w+/.test(clause) || /^\s*\*\s*$/.test(clause)) {
        violations.push(`${rel} takes a namespace binding on the grader's module: import/export * from ${specifier}`);
        continue;
      }
      if (isExport) {
        violations.push(`${rel} RE-EXPORTS from the grader's module (${clause.trim()}); a re-export moves the doors`);
        continue;
      }
      // An alias (`{ gradeTestResults as gradeIt }`) still names the export it aliases.
      if (new RegExp(`\\b${GRADER}\\b`).test(clause)) bound = true;
    }

    if (new RegExp(`import\\s*\\(\\s*["'][^"']*nunit-parse(\\.js)?["']`).test(source)) {
      violations.push(`${rel} dynamically imports the grader's module; a door must bind it statically`);
    }
    // Belt and braces: a call with no import at all is not a door this scan can resolve, and
    // saying so is better than reporting a clean list.
    if (!bound && new RegExp(`\\b${GRADER}\\s*\\(`).test(source)) {
      violations.push(`${rel} calls ${GRADER} without importing it from the declaring module`);
    }
    if (bound) doors.push(path.relative(PKG_ROOT, abs));
  }
  return { doors: doors.sort(), violations: violations.sort() };
}

/** The door list alone, for the assertion that names the known doors. */
function productionCallSites(): string[] {
  return graderDoorScan().doors;
}

test("H3: the ONLY production callers of gradeTestResults are the three known doors", () => {
  const scan = graderDoorScan();
  assert.deepEqual(
    scan.violations,
    [],
    "a production file reaches the test-results grader through a binding this guard cannot resolve",
  );
  assert.deepEqual(
    scan.doors,
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
 * LITMUS, driving the REAL scanner over REAL planted doors on disk.
 *
 * THE PREVIOUS LITMUS DID NOT COVER THE BUG IT CLAIMED TO. It fed a hand-made list to
 * `assert.deepEqual` and asserted that `deepEqual` notices a longer list, which is a fact about
 * `node:assert`. It never called `productionCallSites()`, so the textual scan inside it could
 * be, and was, blind to an aliased import while this test stayed green.
 *
 * `graderDoorScan` therefore takes the source root as a parameter, so the LITMUS can point the
 * SHIPPING function at a temp tree instead of mutating `src/`. Each case below plants a real
 * file, runs the real scan, and asserts on what the scan says.
 */
function plantTree(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), "grade-doors-litmus-"));
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  return root;
}

/** A stand-in for the declaring module, so the scan has the file it excludes. */
const DECLARING_STUB = "capabilities/tests/nunit-parse.ts";
const DECLARING_BODY = "export function gradeTestResults(input: unknown): unknown { return input; }\n";

test("LITMUS: the door scan catches an ALIASED fourth door (the textual scan did not)", () => {
  const aliased =
    'import { gradeTestResults as gradeIt, type NUnitRun } from "../tests/nunit-parse.js";\n' +
    "export function fourthDoor(run: NUnitRun): number {\n" +
    '  return gradeIt({ run, strict: false, attribution: { kind: "unattributed", why: "shortcut" } }).tier;\n' +
    "}\n";
  const root = plantTree({
    [DECLARING_STUB]: DECLARING_BODY,
    "capabilities/scratchdoor/new-door.ts": aliased,
  });
  try {
    // NON-VACUITY, and the whole point: the OLD predicate is blind to this exact file. If this
    // assertion ever fails, the planted door stopped being the shape the finding was about.
    assert.equal(/\bgradeTestResults\(/.test(aliased), false, "the planted door must evade the textual scan");

    const scan = graderDoorScan(root);
    assert.deepEqual(scan.doors, ["capabilities/scratchdoor/new-door.ts"].map((f) => path.join(path.relative(PKG_ROOT, root), f)));
    // …and the assertion the guard actually makes fails on it.
    assert.throws(() => assert.deepEqual(scan.doors, []));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("LITMUS: `const g = gradeTestResults; g(...)` is the same class, and is caught", () => {
  const root = plantTree({
    [DECLARING_STUB]: DECLARING_BODY,
    "capabilities/scratchdoor/indirect.ts":
      'import { gradeTestResults } from "../tests/nunit-parse.js";\n' +
      "const g = gradeTestResults;\n" +
      "export const call = (input: unknown) => g(input);\n",
  });
  try {
    assert.equal(graderDoorScan(root).doors.length, 1, "an indirect call through a local alias is still a door");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("LITMUS: a namespace import, a re-export and a dynamic import are each a VIOLATION", () => {
  for (const [name, body] of [
    ["namespace", 'import * as np from "../tests/nunit-parse.js";\nexport const t = (r: unknown) => np.gradeTestResults(r);\n'],
    ["re-export", 'export { gradeTestResults } from "../tests/nunit-parse.js";\n'],
    ["star-re-export", 'export * from "../tests/nunit-parse.js";\n'],
    ["dynamic", 'export async function t(r: unknown) {\n  const m = await import("../tests/nunit-parse.js");\n  return m.gradeTestResults(r);\n}\n'],
  ] as const) {
    const root = plantTree({ [DECLARING_STUB]: DECLARING_BODY, [`capabilities/scratchdoor/${name}.ts`]: body });
    try {
      const scan = graderDoorScan(root);
      assert.ok(
        scan.violations.length > 0,
        `${name} must be refused: it moves the grader binding somewhere this scan cannot resolve`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

/**
 * F5: `TestsGrade.attributed` shipped WRITE-ONLY, under a docstring claiming otherwise.
 *
 * The field was set at the grader, described as the thing "every door that could quote a green
 * reads … rather than re-deriving its own idea", and had no consumer and no test at all, while
 * `tests grade` re-derived the same fact into a local variable beside it. A field nothing reads
 * is a claim nothing keeps true, and the two derivations were free to drift apart. This guard
 * is why it cannot go back to being write-only: it is the "declared path nothing walks" rule
 * that this repo keeps paying for, applied to a field instead of a path.
 */
test("F5: `grade.attributed` has a PRODUCTION reader, and is not write-only", () => {
  const srcRoot = path.join(PKG_ROOT, "src");
  const testsRoot = path.join(srcRoot, "__tests__");
  const declaring = path.join(srcRoot, ...DECLARING_MODULE);
  const readers = walkTs(srcRoot)
    .filter((abs) => !abs.startsWith(testsRoot) && abs !== declaring)
    .filter((abs) => /\.attributed\b/.test(readFileSync(abs, "utf-8")))
    .map((abs) => path.relative(PKG_ROOT, abs))
    .sort();
  assert.deepEqual(
    readers,
    ["src/capabilities/tests/tests.ts"],
    "`attributed` must be READ by the door that decides whether a green is quotable; a field " +
      "nothing reads is a claim nothing keeps true",
  );
});

test("LITMUS: the allowed-kind check fires on a door that states a kind it may not", () => {
  const allowed = ["stamped"];
  assert.throws(() => {
    for (const k of ["stamped", "unattributed"]) {
      assert.ok(allowed.includes(k), `the unified door may not state '${k}'`);
    }
  });
});
