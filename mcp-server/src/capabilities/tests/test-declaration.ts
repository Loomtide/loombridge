/**
 * "Does this project DECLARE tests?" (amendment G6).
 *
 * WHY THIS EXISTS. Every other verification asset is discovered by the presence of a file
 * an approve/init step wrote, so its absence honestly means "nobody set this up". The test
 * asset is different in one dangerous way: the results are produced by a verb an agent can
 * run, so `rm -rf .loombridge/tests/` would turn a red suite into no row at all, and a run
 * that silently stopped checking the tests would still print a clean plan. Presence has to
 * be DECLARED by the project itself, not by the evidence, or deletion silences the gate.
 *
 * The declaration signals are the two ways a Unity project says "I have EditMode tests",
 * checked in this order, both cheap:
 *
 *  1. `Packages/manifest.json` has a non-empty `testables` array. This is how a project
 *     opts a UPM package's test assemblies into its own Test Runner, and it is the signal
 *     `unity-dev-project` uses.
 *  2. Any `Assets/**\/*.asmdef` whose `references` include the Test Runner assemblies, in
 *     EITHER form Unity writes them (a name or a `GUID:` reference). That reference is what
 *     makes an assembly a test assembly; an asmdef without it cannot host NUnit tests at all.
 *
 * The scan is DETERMINISTIC (every directory listing is sorted) and stops at the first hit,
 * so the common case costs a handful of `readdir` calls. It reads only files it was told
 * about by the directory walk: nothing is inferred from a filename pattern, and a malformed
 * JSON file is skipped rather than thrown, because "one asmdef is unreadable" must not
 * abort discovery of every other asset.
 *
 * EVASION HARDENING (FXE). Every one of these is a real file Unity accepts and an earlier cut
 * of this scan silently missed, which would have turned "the project declares tests" into
 * "no row at all" and let a deleted results pair go unnoticed:
 *   - the `GUID:` reference form, which is what Unity writes when the asmdef is edited in the
 *     Inspector rather than by hand;
 *   - a leading UTF-8 BOM, which `JSON.parse` rejects outright (the whole file then read as
 *     "unparseable", i.e. as no declaration);
 *   - an uppercase or mixed-case `.ASMDEF` extension, which Unity's own importer accepts on a
 *     case-insensitive filesystem;
 *   - trailing or leading whitespace inside a reference string.
 *
 * `Packages/`-EMBEDDED TEST ASMDEFS ARE OUT OF SCOPE, deliberately. A test assembly inside an
 * embedded or referenced package does not compile as a test at all unless the consuming
 * project lists that package in `Packages/manifest.json` `testables`, which is signal 1. So
 * the embedded case is already covered by the cheaper check, and walking `Packages/` (which
 * can contain a full package cache) would cost far more for no additional coverage.
 */

import fs from "node:fs/promises";
import path from "node:path";

/** The assembly reference that makes a Unity assembly a test assembly. */
const TEST_RUNNER_REFERENCE = "UnityEditor.TestRunner";

/**
 * Every reference spelling that means "this assembly can host NUnit tests" (FXE).
 *
 * The two NAMES are the hand-authored form. The two `GUID:` values are Unity's own, taken
 * from the `com.unity.test-framework` package's asmdef `.meta` files; the Inspector writes
 * that form, so a project whose asmdef was created by clicking rather than typing carries
 * GUIDs and nothing else. They are hard-coded because they are Unity's constants, not this
 * repo's, and there is no file in this repository to re-derive them from; a wrong GUID costs
 * a missed row (a false negative, never a false green), which is why hard-coding is
 * acceptable here and a matching heuristic would not be.
 *
 *   27619889b8ba8c24980f49ee34dbb44a  UnityEditor.TestRunner
 *   0acc523941302664db1f4e527237feb3  UnityEngine.TestRunner
 */
const TEST_RUNNER_REFERENCES: readonly string[] = [
  TEST_RUNNER_REFERENCE,
  "UnityEngine.TestRunner",
  "GUID:27619889b8ba8c24980f49ee34dbb44a",
  "GUID:0acc523941302664db1f4e527237feb3",
];

/** `.asmdef`, matched case-insensitively: Unity's importer accepts `.ASMDEF` too (FXE). */
const ASMDEF_EXTENSION = ".asmdef";

export interface TestDeclaration {
  declared: boolean;
  /** WHICH signal declared it, as a sentence the plan row can print. Set iff `declared`. */
  how?: string;
}

/**
 * Strip a leading UTF-8 BOM (FXE).
 *
 * Unity, Visual Studio and Rider all happily write one, and `JSON.parse` throws on it. Read
 * without this, a BOM'd asmdef is indistinguishable from a corrupt one, so the scan silently
 * concludes "no test assembly here" for a file that plainly declares one.
 */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

async function readJsonOrNull(file: string): Promise<unknown> {
  try {
    return JSON.parse(stripBom(await fs.readFile(file, "utf-8")));
  } catch {
    return null;
  }
}

/** `Packages/manifest.json` `testables`, non-empty. */
async function declaredByTestables(root: string): Promise<string | null> {
  const manifest = await readJsonOrNull(path.join(root, "Packages", "manifest.json"));
  if (typeof manifest !== "object" || manifest === null) return null;
  const testables = (manifest as { testables?: unknown }).testables;
  if (!Array.isArray(testables) || testables.length === 0) return null;
  return `Packages/manifest.json declares ${testables.length} testable(s)`;
}

/**
 * Does this asmdef reference the Test Runner? (exported for the evasion tests)
 *
 * `references` entries are either assembly NAMES ("UnityEditor.TestRunner") or GUID refs
 * ("GUID:27619889b8ba8c24980f49ee34dbb44a"). BOTH forms are matched (FXE): the GUID form is
 * what Unity writes when the asmdef is edited in the Inspector, and a scan that only knew the
 * name form would report "this project declares no tests" for a perfectly ordinary project.
 * Entries are TRIMMED before comparison, because a trailing space in a hand-edited file is
 * not a different assembly.
 *
 * The comparison is exact (after trimming) rather than a substring match: a loose match would
 * fire on an unrelated assembly whose name happens to contain the token, and a guard that
 * cries wolf gets relaxed until it protects nothing.
 */
export function asmdefReferencesTestRunner(doc: unknown): boolean {
  if (typeof doc !== "object" || doc === null) return false;
  const references = (doc as { references?: unknown }).references;
  if (!Array.isArray(references)) return false;
  return references.some(
    (entry) => typeof entry === "string" && TEST_RUNNER_REFERENCES.includes(entry.trim()),
  );
}

/**
 * Walk `Assets/` for the first asmdef that references the Test Runner, in sorted order.
 *
 * No depth or entry cap. A cap would be a silencer: "the project is big enough that we gave
 * up looking" is indistinguishable, in the plan, from "this project has no tests", and the
 * whole point of G6 is that the gate cannot be quietly turned off. Early exit on the first
 * hit keeps the common case cheap.
 */
async function declaredByAsmdef(root: string): Promise<string | null> {
  const stack = [path.join(root, "Assets")];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    const subdirs: string[] = [];
    for (const entry of entries) {
      if (entry.isDirectory()) {
        subdirs.push(path.join(dir, entry.name));
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(ASMDEF_EXTENSION)) {
        const file = path.join(dir, entry.name);
        if (asmdefReferencesTestRunner(await readJsonOrNull(file))) {
          return `${path.relative(root, file).split(path.sep).join("/")} references ${TEST_RUNNER_REFERENCE}`;
        }
      }
    }
    // Reverse-push so the sorted order is preserved through the LIFO stack.
    for (let i = subdirs.length - 1; i >= 0; i -= 1) stack.push(subdirs[i]!);
  }
  return null;
}

/** Does this project declare EditMode tests? Never throws. */
export async function projectDeclaresTests(root: string): Promise<TestDeclaration> {
  const testables = await declaredByTestables(root);
  if (testables !== null) return { declared: true, how: testables };
  const asmdef = await declaredByAsmdef(root);
  if (asmdef !== null) return { declared: true, how: asmdef };
  return { declared: false };
}
