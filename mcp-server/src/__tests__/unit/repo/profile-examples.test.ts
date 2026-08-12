/**
 * DECLARED PATHS NOTHING WALKS: the shipped CI workflow examples.
 *
 * `Docs/Profiles/examples/` holds files we tell game teams to COPY into their own
 * repos. They are executable content that this repo never executes, which is exactly
 * the shape CLAUDE.md names as this project's most expensive failure class: a full
 * green suite proves nothing about them because no test walks them.
 *
 * It already cost us. The shipped GitHub Actions example ran
 *
 *     loombridge verify --minigame --contract "$CONTRACT" --captures "$CAPTURES" --strict
 *
 * against `.loombridge/minigame/contracts/…` and `.loombridge/minigame/captures/…`.
 * Nothing in the source writes those directories, and `--minigame` is a deprecated
 * alias whose engine only compares against a baseline when the contract happens to
 * declare `baseline.ref`. With no baseline declared it grades a contract against the
 * capture pack the contract was FINALIZED FROM and exits 0. Observed, on identical
 * inputs: the alias printed "38 pass, 0 fail" and exited 0 where the unified door
 * exited 2 with "a contract graded against captures of itself is not a human anchor".
 * We shipped a reference workflow demonstrating the one thing this product exists to
 * refuse, in a product whose central claim is that a done claim cannot be self-graded.
 *
 * THE TRUTH IS DERIVED, NEVER LISTED. Every fact below comes from HEAD:
 *   - the verbs, from the dispatch switch in `surfaces/cli.ts`;
 *   - each verb's module, from the `import()` specifier in that same switch;
 *   - each verb's flags, from the `arg === "--flag"` comparisons in that module,
 *     via the SAME exported scan `unified-verify-flags.test.ts` uses;
 *   - "is this the anchored door?", by CALLING the real router
 *     `classifyOrchestratorArgs` on the example's own argv.
 * A hand-maintained list of verbs or flags would drift the moment the CLI changed,
 * and a guard that drifts is a guard that passes. This one cannot: rename a verb,
 * rename a flag, or relax the router, and the example stops validating against the
 * code it is teaching people to run.
 *
 * WHAT THIS DOES NOT COVER, stated so nobody reads it as wider than it is:
 *   - Only `Docs/Profiles/examples/`. The prose pages that quote the same commands
 *     (MiniGameVerifyCI.md and friends) are not walked; extending the scan there means
 *     teaching it that a `>` blockquote warning people OFF a mode is not an invocation.
 *   - Not the PATHS an example names. A game repo's own layout is arbitrary, so there is
 *     nothing at HEAD to check `verification/screens` against. The fictional
 *     `.loombridge/minigame/contracts/` that shipped alongside the self-graded green would
 *     not be caught by this guard; what would have caught it is the anchor rule, because a
 *     bundle at a path nothing writes has no approved baseline either.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test, { describe } from "node:test";

import { PKG_ROOT, REPO_ROOT, CLI_SRC } from "../../_support/paths.js";
import { acceptedFlags } from "../capabilities/verification/unified-verify-flags.test.js";
import { classifyOrchestratorArgs } from "../../../capabilities/verification/verify.js";

const EXAMPLES_DIR = path.join(REPO_ROOT, "Docs", "Profiles", "examples");
const SRC = path.join(PKG_ROOT, "src");

/** Every shipped example file, by absolute path. */
function exampleFiles(): string[] {
  return readdirSync(EXAMPLES_DIR)
    .filter((e) => e.endsWith(".yml") || e.endsWith(".yaml") || e.endsWith(".sh"))
    .sort()
    .map((e) => path.join(EXAMPLES_DIR, e));
}

/** Every verb the CLI dispatch actually handles, parsed from the switch so it can't drift. */
export function cliVerbs(source: string): Set<string> {
  return new Set([...source.matchAll(/case\s+"([a-z][a-z0-9-]*)":/g)].map((m) => m[1]!));
}

/** The bare tokens the dispatcher answers before any verb (`--version`, `-h`, …). */
export function topLevelTokens(source: string): Set<string> {
  return new Set([...source.matchAll(/sub === "([^"]+)"/g)].map((m) => m[1]!));
}

/**
 * verb -> the capability module the dispatcher imports for it.
 *
 * Resolved by taking the FIRST `import("…")` at or after each `case`, which is what
 * makes a fallthrough (`case "target": case "design":`) resolve to the module both
 * labels really run rather than looking flagless and being silently skipped.
 */
export function verbModules(source: string): Map<string, string> {
  const out = new Map<string, string>();
  // The switch's OWN `default:`, matched at its indentation. A bare `indexOf("default:")`
  // finds the word inside the usage banner ("Skipping is the default: do nothing"), which
  // sits ABOVE every case and would silently exclude all of them: the map would come back
  // empty and every flag check would report "no module" instead of checking anything.
  const end = source.search(/\n {4}default:/);
  for (const m of source.matchAll(/case\s+"([a-z][a-z0-9-]*)":/g)) {
    const at = m.index!;
    if (end !== -1 && at > end) continue;
    const rest = source.slice(at, end === -1 ? undefined : end);
    const imp = rest.match(/import\("([^"]+)"\)/);
    if (!imp) continue;
    const abs = path.resolve(SRC, "surfaces", imp[1]!).replace(/\.js$/, ".ts");
    out.set(m[1]!, abs);
  }
  return out;
}

/** One `loombridge …` invocation found in an example. */
interface Invocation {
  file: string;
  line: number;
  /** True when the whole (continued) command sat on YAML/shell comment lines. */
  comment: boolean;
  /** The first token after `loombridge`. */
  head: string;
  /** Every `--flag` token on the command. */
  flags: string[];
  /** Every token after the verb, for the router. */
  argv: string[];
}

/**
 * THE SCAN. Both the real checks and their LITMUS call this; `text` is a parameter so
 * the LITMUS can feed it the exact broken example that shipped, and prove the walk sees
 * it rather than re-implementing the walk inline.
 *
 * `loombridge` must not be preceded by a word/path character, so a clone URL ending in
 * `…/loombridge ` and a wrapper path `…/loombridge-src` are not mistaken for commands.
 * Only HORIZONTAL whitespace may follow it, so a YAML step named "… loombridge" does not
 * swallow the next line's key as its verb.
 */
export function scanInvocations(text: string, file = "<inline>"): Invocation[] {
  const rawLines = text.split("\n");
  // Join shell line-continuations, carrying the FIRST line's comment-ness and number:
  // a `#`-led line is documentation, and documentation is allowed to name the mode CI
  // must not run (this file's own header does exactly that).
  const joined: { text: string; line: number; comment: boolean }[] = [];
  for (let i = 0; i < rawLines.length; i += 1) {
    const start = i;
    let acc = rawLines[i]!;
    while (acc.trimEnd().endsWith("\\") && i + 1 < rawLines.length) {
      acc = `${acc.trimEnd().slice(0, -1)} ${rawLines[i + 1]!}`;
      i += 1;
    }
    joined.push({ text: acc, line: start + 1, comment: rawLines[start]!.trim().startsWith("#") });
  }

  const out: Invocation[] = [];
  for (const entry of joined) {
    for (const m of entry.text.matchAll(/(?<![\w/.\-])loombridge[^\S\n]+(.*)$/g)) {
      // Stop at a shell operator: everything past it belongs to another command.
      const tail = m[1]!.split(/[|;&>)]/)[0]!;
      const tokens = tail
        .split(/\s+/)
        .map((t) => t.replace(/^["'`]+|["'`]+$/g, ""))
        .filter((t) => t.length > 0);
      if (tokens.length === 0) continue;
      // The head must have COMMAND SHAPE (a bare lowercase word, or a flag). Prose like
      // "install loombridge (CLI only)" is not an invocation, and treating it as one turns
      // this guard into a style checker nobody can keep green. A typo'd verb still has
      // command shape, so `verifyy` is caught; the cost is that `loombridge $VERB` is not
      // checked, which no example does.
      if (!/^(--?[a-z][a-z0-9-]*|[a-z][a-z0-9-]*)$/.test(tokens[0]!)) continue;
      out.push({
        file,
        line: entry.line,
        comment: entry.comment,
        head: tokens[0]!,
        flags: tokens.filter((t) => /^--[a-z][a-z0-9-]*$/.test(t)),
        argv: tokens.slice(1),
      });
    }
  }
  return out;
}

const CLI_SOURCE = readFileSync(CLI_SRC, "utf-8");
const VERBS = cliVerbs(CLI_SOURCE);
const TOP_LEVEL = topLevelTokens(CLI_SOURCE);
const MODULES = verbModules(CLI_SOURCE);
const EXAMPLES = exampleFiles();

const ALL_INVOCATIONS: Invocation[] = EXAMPLES.flatMap((f) =>
  scanInvocations(readFileSync(f, "utf-8"), path.relative(REPO_ROOT, f)),
);

describe("shipped Docs/Profiles/examples (REALITY CHECK against HEAD)", () => {
  test("there is at least one example, and every one of them invokes loombridge", () => {
    // A scan that found nothing is indistinguishable from a defused one, so the
    // preconditions every check below rests on are asserted rather than assumed.
    assert.ok(EXAMPLES.length > 0, `no example files under ${EXAMPLES_DIR}`);
    const withInvocations = new Set(ALL_INVOCATIONS.map((i) => i.file));
    assert.deepEqual(
      EXAMPLES.map((f) => path.relative(REPO_ROOT, f)).filter((f) => !withInvocations.has(f)),
      [],
      "an example under Docs/Profiles/examples that never invokes `loombridge` is either dead or the scan is broken",
    );
    assert.ok(VERBS.size >= 15, `parsed only ${VERBS.size} verbs from cli.ts; the switch scan has drifted`);
    // Every verb must resolve to a module, or the flag check silently degrades into a
    // string of "no module" refusals that read like example defects rather than a broken
    // scan. `mcp` is the one case that boots the server in-process instead of a capability.
    assert.deepEqual(
      [...VERBS].filter((v) => v !== "mcp" && !MODULES.has(v)),
      [],
      "the cli.ts dispatch scan failed to resolve a module for a verb; the flag check would be vacuous",
    );
  });

  test("every `loombridge <verb>` in an example is a real verb at HEAD", () => {
    const unknown = ALL_INVOCATIONS.filter(
      (i) => !VERBS.has(i.head) && !TOP_LEVEL.has(i.head),
    ).map((i) => `${i.file}:${i.line} -> "${i.head}"`);
    assert.deepEqual(
      unknown,
      [],
      "an example (or its prose) names a `loombridge` command that is not a case in the cli.ts dispatch",
    );
  });

  test("every flag an example passes is a real flag for that verb at HEAD", () => {
    const bad: string[] = [];
    for (const inv of ALL_INVOCATIONS) {
      if (inv.flags.length === 0) continue;
      if (TOP_LEVEL.has(inv.head)) continue; // `loombridge --version` takes no verb flags
      const module = MODULES.get(inv.head);
      // REFUSE, never skip. An unresolvable module means we cannot prove the flags are
      // real, and "could not check" must not read the same as "checked and fine" (the
      // absent-field-is-a-refusal rule).
      if (module === undefined) {
        bad.push(`${inv.file}:${inv.line} -> no dispatch module resolved for verb "${inv.head}"`);
        continue;
      }
      const accepted = new Set(acceptedFlags(readFileSync(module, "utf-8")));
      if (accepted.size === 0) {
        bad.push(`${inv.file}:${inv.line} -> the flag scan found NO flags in ${path.relative(SRC, module)}`);
        continue;
      }
      for (const flag of inv.flags) {
        if (!accepted.has(flag)) {
          bad.push(`${inv.file}:${inv.line} -> \`loombridge ${inv.head} ${flag}\` is not accepted by ${path.relative(SRC, module)}`);
        }
      }
    }
    assert.deepEqual(bad, [], "an example passes a flag the verb's parser does not accept");
  });

  /**
   * THE MOAT CHECK. An example that CI executes must go through the unified `verify`
   * door, which refuses to run the screens section without an approved layout baseline
   * and refuses to exit 0 for a run in which nothing human-approved was compared.
   *
   * It is decided by CALLING the real router. `classifyOrchestratorArgs` returns null
   * for any argv carrying a token outside `ORCHESTRATOR_FLAGS`, and every mode flag
   * (`--minigame`, `--snapshot`, `--profile`) plus their companions (`--contract`,
   * `--captures`, `--layout`, …) are outside it by construction. So "the router adopts
   * this argv" IS "this invocation cannot be a self-graded green", derived rather than
   * pattern-matched, and it moves with the router if the router ever moves.
   *
   * COMMENTS ARE EXEMPT ON PURPOSE. A comment warning readers off the deprecated alias
   * has to be able to spell it; the rule is about what the workflow runs.
   */
  test("no example RUNS a verify mode that skips the approved-anchor rule", () => {
    const executed = ALL_INVOCATIONS.filter((i) => !i.comment && i.head === "verify");
    assert.ok(executed.length > 0, "no executable `loombridge verify` found in the examples");
    const offenders = executed
      .filter((i) => classifyOrchestratorArgs(i.argv) === null)
      .map((i) => `${i.file}:${i.line} -> loombridge verify ${i.argv.join(" ")}`);
    assert.deepEqual(
      offenders,
      [],
      "an example runs a `verify` argv the unified router will not adopt, so it falls through to a legacy "
        + "mode with no approved-anchor rule. Use the bare door (--root/--workspace/--strict/--only/--report/--live).",
    );
  });

  /**
   * LITMUS, on the REAL functions above, fed the exact content that shipped at 2645b12.
   *
   * PERFORMED against the real file, not only inline: the pre-fix example was restored
   * with `git show 2645b12:Docs/Profiles/examples/minigame-verify.github-actions.yml`,
   * the suite was rebuilt and run, and the guard failed. Observed VERBATIM:
   *
   *   ✖ no example RUNS a verify mode that skips the approved-anchor rule (0.561333ms)
   *     AssertionError [ERR_ASSERTION]: an example runs a `verify` argv the unified router
   *     will not adopt, so it falls through to a legacy mode with no approved-anchor rule.
   *     Use the bare door (--root/--workspace/--strict/--only/--report/--live).
   *     + actual - expected
   *     + [
   *     +   'Docs/Profiles/examples/minigame-verify.github-actions.yml:72 -> loombridge verify
   *     +    --minigame --contract $CONTRACT --captures $CAPTURES --strict --output
   *     +    $RUNNER_TEMP/minigame-verification.json'
   *     + ]
   *     - []
   *
   *   ✖ LITMUS: the moat check really fires on the self-grading invocation that shipped
   *     AssertionError [ERR_ASSERTION]:
   *     Docs/Profiles/examples/minigame-verify.github-actions.yml:72 is not adopted by the router
   *
   * Restoring the fixed example returned all 14 to green.
   */
  test("LITMUS: the moat check really fires on the self-grading invocation that shipped", () => {
    const shipped = [
      "      - name: Verify mini-game (--strict)",
      "        run: |",
      "          set +e",
      '          loombridge verify --minigame --contract "$CONTRACT" --captures "$CAPTURES" --strict \\',
      '            --output "$RUNNER_TEMP/minigame-verification.json"',
      "          CODE=$?",
    ].join("\n");

    const found = scanInvocations(shipped, "SHIPPED");
    assert.equal(found.length, 1, "the scan must see the invocation at all");
    const inv = found[0]!;
    assert.equal(inv.comment, false, "it was executable, not a comment");
    assert.equal(inv.head, "verify");
    // The continuation was joined, so `--output` is part of the SAME command.
    assert.deepEqual(inv.flags, ["--minigame", "--contract", "--captures", "--strict", "--output"]);
    // …and the REAL router refuses to adopt it: this is the legacy engine, no anchor rule.
    assert.equal(
      classifyOrchestratorArgs(inv.argv),
      null,
      "if the router adopted this argv the moat check would be decorative",
    );

    // The same router, on the argv the example carries TODAY, must be adopted, otherwise
    // the check above would pass for every possible input and prove nothing.
    const today = ALL_INVOCATIONS.filter((i) => !i.comment && i.head === "verify");
    for (const inv2 of today) {
      assert.notEqual(
        classifyOrchestratorArgs(inv2.argv),
        null,
        `${inv2.file}:${inv2.line} is not adopted by the router`,
      );
    }
  });

  /**
   * LITMUS for the flag walk. `--captures` is a REAL verify flag (it belongs to the
   * legacy `--minigame` mode), so an unreal one has to be planted to prove the walk is
   * not vacuous.
   */
  test("LITMUS: the flag walk really fires on a flag no parser accepts", () => {
    const planted = scanInvocations("run: loombridge verify --root . --not-a-real-flag", "PLANTED");
    assert.equal(planted.length, 1);
    const module = MODULES.get("verify");
    assert.ok(module !== undefined, "the dispatch scan must resolve verify's module");
    const accepted = new Set(acceptedFlags(readFileSync(module, "utf-8")));
    assert.ok(accepted.has("--root"), "the scan must find the real flags");
    assert.ok(
      planted[0]!.flags.some((f) => !accepted.has(f)),
      "the flag walk missed a planted unreal flag; it cannot be protecting anything",
    );
  });

  /**
   * LITMUS for the verb walk, and for the two false positives that made a naive scan
   * unusable: a clone URL that ENDS in `loombridge`, and a YAML step whose name ends in
   * `loombridge`. Both appear in the real example.
   */
  test("LITMUS: the verb walk fires on an unreal verb, and not on a URL or a step name", () => {
    const bad = scanInvocations("run: loombridge verifyy --root .", "PLANTED");
    assert.equal(bad.length, 1);
    assert.ok(!VERBS.has(bad[0]!.head) && !TOP_LEVEL.has(bad[0]!.head), "a typo'd verb must be caught");

    const url = 'git clone https://github.com/Loomtide/loombridge "$RUNNER_TEMP/loombridge-src"';
    assert.deepEqual(scanInvocations(url, "URL"), [], "a clone URL is not an invocation");

    const stepName = "      - name: Install loombridge\n        run: |\n          npm ci";
    assert.deepEqual(scanInvocations(stepName, "STEP"), [], "a step name must not swallow the next line");

    const prose = "# --- install loombridge (CLI only, no ~/.claude) ---";
    assert.deepEqual(scanInvocations(prose, "PROSE"), [], "prose after the product name is not an invocation");
  });
});
