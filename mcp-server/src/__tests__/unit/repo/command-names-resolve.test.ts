import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { REPO_ROOT } from "../../_support/paths.js";

/**
 * Guard: every `loombridge-*` command an agent is told to run must exist AND must exec a file
 * that exists.
 *
 * WHY THIS EXISTS, and the first draft of it got the cause backwards. A builder agent hand-rolled
 * a screenshot pipeline instead of using the shipped runner. The obvious read was that
 * `loombridge-capture` is a typo for the `loombridge-capture-runner` bin. It is not: the local
 * installer deliberately creates `loombridge-capture`, `loombridge-handoff-check` and
 * `loombridge-tune` as wrappers, with a comment saying it does so precisely "so agent-facing
 * command/skill content never has to spell out a node path".
 *
 * The real defect is one layer down. All three wrappers exec PRE-LAYERING paths:
 *
 *     dist/verification/capture-runner.js       (real: dist/capabilities/verification/...)
 *     dist/asset-layer/handoff-consistency.js   (real: dist/capabilities/assets/...)
 *     dist/verification/tuning-runner.js        (real: dist/capabilities/verification/...)
 *
 * The command was on PATH and died on exec. Renaming the docs would have "fixed" the symptom on
 * the npm channel and broken the frozen-runtime channel, which is what the first attempt did.
 *
 * THREE DIRECTIONS, because the name can be wrong in any of them:
 *   1. names shipped docs REFERENCE
 *   2. names the scrubber can MINT into consumer docs
 *   3. the FILE each installer wrapper execs
 * `package-entrypoints.test.ts` covers package bin targets; it cannot see (2) or (3).
 */

const INSTALLER = path.join(REPO_ROOT, "scripts", "loombridge-install-locally.sh");
const SCRUBBER = path.join(REPO_ROOT, "scripts", "agent-surface-lib.mjs");

function declaredBins(): Set<string> {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, "mcp-server", "package.json"), "utf-8"),
  ) as { bin?: Record<string, string> };
  return new Set(Object.keys(pkg.bin ?? {}));
}

/**
 * Commands the local installer writes as wrappers. Real for the frozen-runtime channel even
 * though they are not package bins.
 *
 * The installer builds most of these from SHELL VARIABLES, not literals, so a naive
 * `$BIN_DIR/loombridge-<letters>` scan sees 2 of 7 and misses the interesting ones. That is not
 * cosmetic: the first version of this guard asserted `loombridge-capture` "does NOT exist" and
 * passed, laundering a false premise into a LITMUS.
 */
export function installerShims(sh: string = fs.readFileSync(INSTALLER, "utf-8")): Set<string> {
  const names = new Set<string>();
  for (const m of sh.matchAll(/\$BIN_DIR\/(loombridge-[a-z][a-z-]*)\b/g)) names.add(m[1]!);
  for (const m of sh.matchAll(/for\s+verb\s+in\s+([a-z\s-]+?);\s*do/g)) {
    for (const verb of m[1]!.trim().split(/\s+/)) names.add(`loombridge-${verb}`);
  }
  for (const m of sh.matchAll(/for\s+wname\s+in\s+([a-z:\s-]+?);\s*do/g)) {
    for (const pair of m[1]!.trim().split(/\s+/)) names.add(`loombridge-${pair.split(":")[1]}`);
  }
  return names;
}

/**
 * Each wrapper's exec TARGET, so a moved file cannot silently break the command.
 *
 * Returns [] once the `for wname in src:name` loop is gone, which is the current state: those
 * three verbs became package bins, so `package-entrypoints.test.ts` walks their targets instead.
 * Kept because the loop is the shape a future aux verb would reuse.
 */
export function shimExecTargets(sh: string = fs.readFileSync(INSTALLER, "utf-8")): Array<{ bin: string; target: string }> {
  const out: Array<{ bin: string; target: string }> = [];
  const rule = /\[ "\$src_basename" = "([a-z-]+)" \] && src_subdir="([a-z/]+)" \|\| src_subdir="([a-z/]+)"/.exec(sh);
  if (!rule) return out;
  const [, specialBasename, specialDir, defaultDir] = rule;
  for (const m of sh.matchAll(/for\s+wname\s+in\s+([a-z:\s-]+?);\s*do/g)) {
    for (const pair of m[1]!.trim().split(/\s+/)) {
      const [basename, name] = pair.split(":");
      out.push({
        bin: `loombridge-${name}`,
        target: `dist/${basename === specialBasename ? specialDir : defaultDir}/${basename}.js`,
      });
    }
  }
  return out;
}

function resolvableNames(): Set<string> {
  return new Set([...declaredBins(), ...installerShims()]);
}

/**
 * Every `loombridge-*` literal the scrubber can rewrite TO. Single quotes, double quotes and
 * template literals: matching only double quotes meant re-adding a deleted rule in single quotes
 * reinstated a dangling name with the guard green.
 */
export function mintedByScrubber(src: string = fs.readFileSync(SCRUBBER, "utf-8")): Set<string> {
  return new Set([...src.matchAll(/["'`](loombridge-[a-z][a-z0-9-]*)["'`]/g)].map((m) => m[1]!));
}

/**
 * `file::name` pairs allowed to name a non-resolving command. PER PAIR, not per file: a whole-file
 * exemption let the ledger name any command at all, including in its prescriptive "Fix" column.
 */
/**
 * Aux commands that exist ONLY on the frozen-runtime channel (installer wrappers backed by shell
 * scripts, not dist entrypoints), yet are named in shipped docs.
 *
 * THIS LIST IS A KNOWN GAP, NOT A BLESSING. An npm-only user following a doc that names one of
 * these gets command-not-found, which is precisely the bug that made a builder agent hand-roll a
 * capture pipeline. Each entry is a debt with a reason. The fix for any of them is the same fix
 * applied to capture/handoff-check/tune here: make it a package bin so both channels agree. Do
 * not add to this list to silence a failure.
 */
const INSTALLER_ONLY_DOC_COMMANDS = new Map<string, string>([
  ["loombridge-asset-prep", "wraps scripts/prepare-project-assets.sh (a shell script, not a dist entrypoint); npm-only users cannot run it"],
  ["loombridge-embed-bridge", "wraps scripts/loombridge-embed-bridge.sh; `loombridge install-bridge --embedded` is the supported CLI path, so the doc should prefer that"],
]);

const ALLOWED_DOC_NAMES = new Set<string>([
  "Docs/Design/SniperShooterPlanLedger.md::loombridge-capture",
  // Not a command: the Unity PROJECT name in the phase-2.6 validation report. The broadened scan
  // (fenced blocks, all tracked markdown) is what surfaced it, which is the cost of the wider net.
  "VALIDATION-2.6.md::loombridge-dev",
]);

/**
 * `loombridge-*` names an agent could read as a command.
 *
 * Deliberately NOT backtick-only. Commands live in fenced blocks, and the line that caused this
 * incident was fenced; a backtick-only scan would have missed the very thing it exists for.
 */
export function referencedInDocs(files?: Array<{ file: string; text: string }>): string[] {
  const walked = files ?? trackedDocs();
  assert.ok(walked.length > 10, `doc walk looks vacuous: ${walked.length} files`);
  const findings: string[] = [];
  for (const { file, text } of walked) {
    const names = new Set<string>();
    for (const m of text.matchAll(/`(loombridge-[a-z][a-z0-9-]*)`/g)) names.add(m[1]!);
    for (const m of text.matchAll(/(?:^\s*|[|&]\s*|\$\(\s*)(loombridge-[a-z][a-z0-9-]*)\b/gm)) names.add(m[1]!);
    for (const name of names) {
      if (!ALLOWED_DOC_NAMES.has(`${file}::${name}`)) findings.push(`${file}: ${name}`);
    }
  }
  return findings.sort();
}

function trackedDocs(): Array<{ file: string; text: string }> {
  const r = spawnSync("git", ["ls-files", "-z"], { cwd: REPO_ROOT, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });
  assert.equal(r.status, 0, `git ls-files failed: ${r.stderr}`);
  return (r.stdout ?? "")
    .split("\0")
    .filter((f) => f.endsWith(".md") || f.endsWith(".mdx"))
    .filter((f) => !f.startsWith("node_modules/") && !f.includes("/node_modules/"))
    .map((file) => ({ file, text: fs.readFileSync(path.join(REPO_ROOT, file), "utf-8") }));
}

test("every loombridge-* command NAMED in a shipped doc resolves ON THE NPM CHANNEL", () => {
  // CHANNEL-AWARE, and the first version was not. It accepted a name if EITHER channel provided
  // it, so `loombridge-capture` passed as an installer wrapper while being command-not-found for
  // every npm user, which is the exact population that hit the bug.
  const bins = declaredBins();
  const dangling = referencedInDocs()
    .map((f) => f.split(": ")[1]!)
    .filter((n) => !bins.has(n) && !INSTALLER_ONLY_DOC_COMMANDS.has(n))
    .filter((n, i, a) => a.indexOf(n) === i)
    .sort();
  assert.deepEqual(
    dangling,
    [],
    "a doc names a command that is not a package bin, so an npm-installed user gets " +
      "command-not-found. Make it a bin (both channels then agree), or record it in " +
      `INSTALLER_ONLY_DOC_COMMANDS with the reason:\n  ${dangling.join("\n  ")}`,
  );
});

test("every loombridge-* command the SCRUBBER can mint resolves", () => {
  const resolvable = resolvableNames();
  const dangling = [...mintedByScrubber()].filter((n) => !resolvable.has(n)).sort();
  assert.deepEqual(
    dangling,
    [],
    `the scrubber would rewrite a dev path into a command that does not exist:\n  ${dangling.join("\n  ")}`,
  );
});

test("every installer wrapper EXECS a file that exists", () => {
  // The defect the first draft missed: the command resolved on PATH and died on exec, because the
  // src layering moved its target and nothing walked it.
  // No wrapper loop today (see shimExecTargets). This stays so reintroducing one is guarded.
  const targets = shimExecTargets();
  const missing = targets
    .filter(({ target }) => !fs.existsSync(path.join(REPO_ROOT, "mcp-server", target)))
    .map(({ bin, target }) => `${bin} -> ${target}`)
    .sort();
  assert.deepEqual(
    missing,
    [],
    `an installer wrapper execs a path that does not exist, so the command is on PATH and broken:\n  ${missing.join("\n  ")}`,
  );
});

test("LITMUS: each scan fires on its own defect, and clears the healthy tree", () => {
  const resolvable = resolvableNames();

  // 1. the wrapper names the naive parse missed must all be seen as REAL.
  for (const name of ["loombridge-capture", "loombridge-handoff-check", "loombridge-tune", "loombridge-checkpoint"]) {
    assert.equal(resolvable.has(name), true, `${name} is an installer wrapper and must resolve`);
  }

  // 2. a FENCED command with no backticks is caught: the shape the first version could not see.
  assert.deepEqual(
    referencedInDocs(Array.from({ length: 11 }, (_, i) =>
      i === 0 ? { file: "f.md", text: "```bash\nloombridge-totally-fake --now\n```" } : { file: `p${i}.md`, text: "" },
    )).filter((f) => !resolvable.has(f.split(": ")[1]!)),
    ["f.md: loombridge-totally-fake"],
  );

  // 3. minted names in SINGLE quotes and template literals are caught.
  assert.deepEqual(
    [...mintedByScrubber("[/x/g, 'loombridge-bogus-a'], [/y/g, `loombridge-bogus-b`]")].sort(),
    ["loombridge-bogus-a", "loombridge-bogus-b"],
  );

  // 4. a moved exec target is caught.
  const moved = shimExecTargets(
    'for wname in capture-runner:capture; do\n[ "$src_basename" = "handoff-consistency" ] && src_subdir="nowhere/a" || src_subdir="nowhere/b"',
  );
  assert.deepEqual(moved, [{ bin: "loombridge-capture", target: "dist/nowhere/b/capture-runner.js" }]);
  assert.equal(fs.existsSync(path.join(REPO_ROOT, "mcp-server", moved[0]!.target)), false);

  // 5. the ledger exemption is per PAIR: another name in that same file still fails.
  assert.deepEqual(
    referencedInDocs(Array.from({ length: 11 }, (_, i) =>
      i === 0
        ? { file: "Docs/Design/SniperShooterPlanLedger.md", text: "`loombridge-capture` and `loombridge-imaginary`" }
        : { file: `p${i}.md`, text: "" },
    )),
    ["Docs/Design/SniperShooterPlanLedger.md: loombridge-imaginary"],
  );
});
