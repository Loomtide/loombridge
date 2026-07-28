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
 *  2. Any `Assets/**\/*.asmdef` whose `references` include `UnityEditor.TestRunner`. That
 *     reference is what makes an assembly a test assembly; an asmdef without it cannot host
 *     NUnit tests at all.
 *
 * The scan is DETERMINISTIC (every directory listing is sorted) and stops at the first hit,
 * so the common case costs a handful of `readdir` calls. It reads only files it was told
 * about by the directory walk: nothing is inferred from a filename pattern, and a malformed
 * JSON file is skipped rather than thrown, because "one asmdef is unreadable" must not
 * abort discovery of every other asset.
 */

import fs from "node:fs/promises";
import path from "node:path";

/** The assembly reference that makes a Unity assembly a test assembly. */
const TEST_RUNNER_REFERENCE = "UnityEditor.TestRunner";

export interface TestDeclaration {
  declared: boolean;
  /** WHICH signal declared it, as a sentence the plan row can print. Set iff `declared`. */
  how?: string;
}

async function readJsonOrNull(file: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(file, "utf-8"));
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
 * Does this asmdef reference the Test Runner?
 *
 * `references` entries are either assembly NAMES ("UnityEditor.TestRunner") or GUID refs
 * ("GUID:27619889b8ba8c24980f49ee34dbb44a", the Test Runner's well-known guid). Only the
 * name form is matched here, deliberately: matching a guid would mean hard-coding a value
 * from Unity's own package that nothing in this repo can re-derive or keep honest. The name
 * form is what every scaffolded asmdef in this repo and in Unity's own templates uses, and
 * a false NEGATIVE here costs a missing row, never a false green.
 */
function asmdefReferencesTestRunner(doc: unknown): boolean {
  if (typeof doc !== "object" || doc === null) return false;
  const references = (doc as { references?: unknown }).references;
  if (!Array.isArray(references)) return false;
  return references.some((entry) => typeof entry === "string" && entry === TEST_RUNNER_REFERENCE);
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
      } else if (entry.isFile() && entry.name.endsWith(".asmdef")) {
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
