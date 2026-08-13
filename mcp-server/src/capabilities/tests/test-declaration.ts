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

import type { DeclaredTestSurface } from "./nunit-parse.js";

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

/* -------------------------------------------------------------------------- */
/* The declared test SURFACE: which assemblies, not merely whether any (H4)    */
/* -------------------------------------------------------------------------- */

/**
 * WHY THIS EXISTS, and exactly what it buys (H4).
 *
 * Everything the test-results wave bound was written by the run being graded. `resultsSha256`
 * binds the XML to the manifest, the manifest's summary and assembly list are re-derived from
 * that same XML, and the roll-up cross-check walks the one byte stream. So a SELF-CONSISTENT
 * FORGED PAIR satisfied every one of them at once: the reviewer flipped the test-results section of `verify`
 * from `fail`/exit 1 to `pass (unanchored)`/exit 0 with a thirty-line script, no Unity, and
 * `createHash` for the sha. Nothing in the pair could catch it, because every reading came
 * from bytes the forger wrote.
 *
 * This is the one fact in reach that the run does NOT author: the project's own declared test
 * surface. `Packages/manifest.json` `testables` and the Test-Runner `.asmdef` files are
 * authored by the GAME, are what Unity actually compiles, and name the assemblies a real run
 * can possibly produce. `projectDeclaresTests` above already reads that surface as a boolean;
 * this reads WHICH assemblies it names, so the XML's assembly set has something outside itself
 * to be held against.
 *
 * WHAT IT DOES NOT BUY, stated plainly so nobody quotes this as more than it is:
 *  - It does not make forgery impossible. The declared surface is READABLE, so a forger who
 *    opens one `.asmdef` can name a real assembly and satisfy the check. What it costs is that
 *    the forgery must now agree with a file the run did not write, and a project that has no
 *    such file at all cannot be forged INTO having tests without also editing the game.
 *  - It does not bind the CASES. An assembly name is not a test list; a forger naming a real
 *    assembly can still invent its contents. Binding the cases needs an artifact a run leaves
 *    that the run cannot rewrite, which none of today's files is.
 *  - A forger who ALSO edits `Packages/manifest.json` (adding an unresolvable testable) can
 *    downgrade the strict half of the check to a note, by making the surface incomplete. That
 *    edit is to the game's build input, not to the evidence, which is the point of moving the
 *    fact outside the pair rather than a claim that the move is airtight.
 */

/** `.asmdef` `name` fields, from every Test-Runner-referencing asmdef under `dir`. */
async function collectTestAsmdefNames(dir: string, out: Set<string>): Promise<void> {
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.isDirectory()) {
        stack.push(path.join(current, entry.name));
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(ASMDEF_EXTENSION)) {
        const doc = await readJsonOrNull(path.join(current, entry.name));
        if (!asmdefReferencesTestRunner(doc)) continue;
        const name = (doc as { name?: unknown }).name;
        // An asmdef with no `name` compiles to nothing Unity can call an assembly, so there is
        // no assembly name to add. Skipping it (rather than inventing one from the filename)
        // keeps the set to names the XML could really carry.
        if (typeof name === "string" && name.trim().length > 0) out.add(name.trim());
      }
    }
  }
}

/**
 * Where a `testables` entry's sources live, or `null` when this checkout cannot say.
 *
 * The three resolutions are the three places Unity itself looks, cheapest first: an EMBEDDED
 * package (`Packages/<id>/`), a `file:` dependency (resolved relative to `Packages/`, which is
 * how Unity resolves it), and the resolved package cache (`Library/PackageCache/<id>@…`). A
 * registry package on a checkout with no `Library/` resolves to nothing, which is a legitimate
 * and common state (a fresh clone), and is reported as INCOMPLETE rather than as absence.
 */
async function resolveTestablePackageDir(root: string, id: string): Promise<string | null> {
  const packagesDir = path.join(root, "Packages");
  const embedded = path.join(packagesDir, id);
  if (await isDirectory(embedded)) return embedded;

  const manifest = await readJsonOrNull(path.join(packagesDir, "manifest.json"));
  const deps = (manifest as { dependencies?: unknown } | null)?.dependencies;
  if (typeof deps === "object" && deps !== null) {
    const spec = (deps as Record<string, unknown>)[id];
    if (typeof spec === "string" && spec.startsWith("file:")) {
      const resolved = path.resolve(packagesDir, spec.slice("file:".length));
      if (await isDirectory(resolved)) return resolved;
    }
  }

  const cache = path.join(root, "Library", "PackageCache");
  try {
    const entries = await fs.readdir(cache, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.isDirectory() && (entry.name === id || entry.name.startsWith(`${id}@`))) {
        return path.join(cache, entry.name);
      }
    }
  } catch {
    /* no package cache on this checkout */
  }
  return null;
}

async function isDirectory(dir: string): Promise<boolean> {
  try {
    return (await fs.stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The assemblies this PROJECT declares it can run EditMode tests in. Never throws.
 *
 * Returns the discriminated {@link DeclaredTestSurface} the grader consumes, so the three
 * genuinely different answers stay three different answers rather than collapsing into an
 * empty array: "the project names these assemblies", "the project names none", and (at the
 * bare-XML door, which has no project to read) "nobody asked a project".
 *
 * `complete` is false when a `testables` entry could not be resolved to sources on this
 * checkout. The grader uses it for exactly one thing: an incomplete surface cannot support a
 * REFUSAL that the XML names nothing declared, because the assemblies it names may be the ones
 * this checkout could not enumerate.
 */
export async function projectTestSurface(root: string): Promise<DeclaredTestSurface> {
  const names = new Set<string>();
  const sources: string[] = [];
  const unresolved: string[] = [];

  await collectTestAsmdefNames(path.join(root, "Assets"), names);
  if (names.size > 0) sources.push(`${names.size} Test-Runner asmdef(s) under Assets/`);

  const manifest = await readJsonOrNull(path.join(root, "Packages", "manifest.json"));
  const testables = (manifest as { testables?: unknown } | null)?.testables;
  if (Array.isArray(testables)) {
    let resolvedCount = 0;
    for (const entry of testables) {
      if (typeof entry !== "string" || entry.trim().length === 0) continue;
      const id = entry.trim();
      const dir = await resolveTestablePackageDir(root, id);
      if (dir === null) {
        unresolved.push(id);
        continue;
      }
      resolvedCount += 1;
      await collectTestAsmdefNames(dir, names);
    }
    if (resolvedCount > 0) sources.push(`${resolvedCount} resolved testable package(s)`);
  }

  const complete = unresolved.length === 0;
  if (names.size === 0) {
    return {
      kind: "none",
      why:
        unresolved.length > 0
          ? `this project declares no Test-Runner asmdef this checkout can read; unresolved testable(s): ${unresolved.join(", ")}`
          : "this project declares no Test-Runner asmdef and no resolvable testable package",
    };
  }
  return {
    kind: "declared",
    assemblies: [...names].sort(),
    complete,
    how:
      `${names.size} assembly name(s) from ${sources.join(" and ")}` +
      (complete ? "" : `; ${unresolved.length} testable(s) could not be resolved: ${unresolved.join(", ")}`),
  };
}
