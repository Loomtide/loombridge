/**
 * DECLARED PATHS NOTHING WALKS: the commands the CLI PRINTS AT PEOPLE.
 *
 * Every refusal, plan row and next-step line in this product ends in "…now run this". Those
 * strings are executable content that no test executes, which is the exact shape CLAUDE.md
 * names as this repo's most expensive failure class: a full green suite proves nothing about
 * them, because nothing walks them.
 *
 * It had already cost us. Two shipped, both found by a human reading the terminal:
 *
 *   discovery.ts  "loombridge minigame init --id <kebab>, then `capture`, then
 *                 `minigame baseline approve`"
 *                 Bare `capture` is not that command (`minigame capture` is), and
 *                 `baseline approve` refuses without --contract and --captures. Two of the
 *                 three steps could not be pasted.
 *   visual-diff.ts "re-run replay once more to characterize the drift before masking."
 *                 Named no command at all: the one actionable sentence in the suggestion,
 *                 and the operator had to work out which of three doors it meant.
 *
 * THE TRUTH IS DERIVED, NEVER LISTED. Both halves come from HEAD, through the SAME functions
 * the shipped-examples guard uses, so a rename moves them together:
 *   - the verbs, from the dispatch switch in `surfaces/cli.ts` (`cliVerbs`/`topLevelTokens`);
 *   - each verb's module, from the `import()` specifier in that same switch (`verbModules`);
 *   - each verb's flags, from the flag comparisons in that module AND in every module it
 *     imports inside its own capability directory, because a verb's sub-commands
 *     (`minigame capture`, `feel snapshot approve`) parse their own flags in their own files.
 * A hand-maintained list of verbs or flags would drift the moment the CLI changed, and a
 * guard that drifts is a guard that passes.
 *
 * WHAT THIS CANNOT SEE, stated plainly so nobody reads it as wider than it is:
 *
 *  1. **It is a STATIC SCAN of string literals.** A command assembled at runtime escapes it:
 *     `` `loombridge ${verb} --id ${id}` `` reduces to `loombridge <value> --id <value>` and
 *     is skipped, and a line built by concatenating a variable head onto a flag tail is not
 *     reassembled here. What it sees is what is spelled in the source.
 *  2. **It does not check SUB-VERBS.** `loombridge trace replay` and `loombridge feel
 *     snapshot approve` are validated only as far as `trace` and `feel`. Each verb module
 *     dispatches its sub-tokens in its own shape (a `switch` here, an `if (parsed.sub === …)`
 *     chain there, `argv[0] === …` elsewhere), and a heuristic that tried to derive them
 *     produced false positives on real commands (`feel snapshot`, `tests run`, `genre init`).
 *     A guard that cries wolf gets deleted, so this one does not try.
 *  3. **It does not check REQUIRED flags, or whether a command would SUCCEED.** It proves the
 *     verb and every flag exist at HEAD. `minigame baseline approve` with no `--contract`
 *     passes this guard; it is `plan-next-step-surfaces.test.ts` that walks the "would this
 *     command exit 2" question, for the surfaces where that was known to bite.
 *  4. **Only `mcp-server/src`.** Docs and skills are covered elsewhere
 *     (`profile-examples.test.ts` for the shipped CI examples, `routing-doc.test.ts` for the
 *     LOOMBRIDGE.md template).
 *
 * What it DOES prove is the thing that decays: rename a verb, rename or drop a flag, and every
 * printed string still naming the old one fails here instead of reaching an operator.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import test, { describe } from "node:test";

import { PKG_ROOT, CLI_SRC } from "../../_support/paths.js";
import { acceptedFlags } from "../capabilities/verification/unified-verify-flags.test.js";
import { cliVerbs, topLevelTokens, verbModules } from "./profile-examples.test.js";

const SRC = path.join(PKG_ROOT, "src");

/** Every shipped source file, i.e. everything the CLI can actually print from. */
function sourceFiles(dir: string = SRC): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      out.push(...sourceFiles(full));
    } else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

/**
 * THE STRING LITERALS OF A SOURCE FILE, with comments removed.
 *
 * COMMENTS MUST GO FIRST, and this is the whole reason the scan is a small lexer rather than
 * a regex. This codebase's comments discuss commands constantly (this header does it eight
 * times), and a scan that read them would be checking prose about history instead of output.
 * Interpolations collapse to the literal `<value>`: a `${root}` is a VALUE in the command,
 * and leaving the expression in would make it parse as flags.
 *
 * Exported so the LITMUS drives the same lexer the guard runs on, rather than a copy.
 */
export function stringLiterals(source: string): string[] {
  const bodies: string[] = [];
  let i = 0;
  while (i < source.length) {
    const c = source[i]!;
    if (c === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") i += 1;
      continue;
    }
    if (c === "/" && source[i + 1] === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    if (c !== '"' && c !== "'" && c !== "`") {
      i += 1;
      continue;
    }
    const quote = c;
    i += 1;
    let body = "";
    while (i < source.length) {
      const ch = source[i]!;
      if (ch === "\\") {
        // `\n` becomes a real newline so a multi-line usage block splits into lines the way
        // it prints; every other escape keeps its character.
        body += source[i + 1] === "n" ? "\n" : source[i + 1];
        i += 2;
        continue;
      }
      if (quote === "`" && ch === "$" && source[i + 1] === "{") {
        i += 2;
        let depth = 1;
        while (i < source.length && depth > 0) {
          if (source[i] === "{") depth += 1;
          else if (source[i] === "}") depth -= 1;
          i += 1;
        }
        body += "<value>";
        continue;
      }
      if (ch === quote) {
        i += 1;
        break;
      }
      body += ch;
      i += 1;
    }
    bodies.push(body);
  }
  return bodies;
}

/**
 * COMMAND POSITION: is this `loombridge …` an INSTRUCTION, or is it prose about the product?
 *
 * The distinction is real and the corpus forces it. `Installed loombridge runtime is 0.2.0`,
 * `a newer loombridge is published`, and `they MAY be loombridge servers` are sentences, and
 * treating them as commands would report `runtime`, `is` and `servers` as unknown verbs
 * forever. An instruction sits at the start of its line (optionally after a `[tag]`, a list
 * marker or a step number), or straight after a colon (`Usage: `, `next: `, `run: `), or
 * inside backticks, which is how this codebase quotes a command in prose.
 */
const COMMAND_POSITION = /^\s*(?:<value>)?\s*(?:\[[^\]]*\]\s*)?(?:[-*>]\s*)?(?:[0-9]+[.)]\s*)?$|:\s+$/;

/** One `loombridge …` instruction found in a printable string. */
export interface PrintedCommand {
  file: string;
  /** The first token after `loombridge`. */
  head: string;
  /** Every `--flag` token on the command. */
  flags: string[];
  /** The command as it reads, for the failure message. */
  text: string;
}

/**
 * THE SCAN. Both the real checks and the LITMUS call this, so the LITMUS cannot pass against
 * a walk that ships differently.
 *
 * `loombridge` must not be preceded by a word or path character, so `…/loombridge-src` and a
 * repo URL ending in `/loombridge` are not commands. The tail is cut at the first shell
 * operator, at a parenthetical (`  (drives the editor)`), at a trailing `# comment`, and at a
 * `, ` (prose continues after a comma: `loombridge record, then \`loombridge verify\`` is two
 * commands, and the second is found on its own by the backtick rule).
 */
export function printedCommands(source: string, file = "<inline>"): PrintedCommand[] {
  const out: PrintedCommand[] = [];
  for (const body of stringLiterals(source)) {
    for (const m of body.matchAll(/(?<![\w/.\-])loombridge[^\S\n]+([^\n]*)/g)) {
      const lineStart = body.lastIndexOf("\n", m.index) + 1;
      const before = body.slice(lineStart, m.index);
      const backticked = before.endsWith("`");
      if (!backticked && !COMMAND_POSITION.test(before)) continue;
      let tail = m[1]!;
      if (backticked) tail = tail.split("`")[0]!;
      tail = tail.split(/[|;&>)]/)[0]!.split(/\s\(/)[0]!.split(/,\s/)[0]!.split(/\s+#\s/)[0]!;
      const tokens = tail
        .split(/\s+/)
        .map((t) => t.replace(/^["'`,.]+|["'`,.]+$/g, ""))
        .filter((t) => t.length > 0);
      if (tokens.length === 0) continue;
      // COMMAND SHAPE for the head: a bare lowercase word, or a flag. A typo'd verb still has
      // command shape, so `verifyy` is caught; the cost is that `loombridge <value>` (a head
      // built from an interpolation) is skipped, which is limit 1 in the header.
      if (!/^(--?[a-z][a-z0-9-]*|[a-z][a-z0-9-]*)$/.test(tokens[0]!)) continue;
      out.push({
        file,
        head: tokens[0]!,
        flags: tokens.filter((t) => /^--[a-z][a-z0-9-]*$/.test(t)),
        text: `loombridge ${tail.trim()}`,
      });
    }
  }
  return out;
}

/**
 * EVERY FLAG SHAPE THE CLI PARSES, from one module's source.
 *
 * `acceptedFlags` (shared with the two other guards) reads `arg === "--flag"`, which is what
 * `verify` and its neighbours use. Two more shapes exist at HEAD and had to be added or this
 * guard would have derived ZERO flags for `target`, `design`, `mobile-audit` and
 * `tuning-report`, and an empty inventory turns every flag check into a refusal that reads
 * like a defect in the string rather than a hole in the scan:
 *   - `a === "--flag"` / `argv[0] === "--flag"`: the same test under another variable name;
 *   - `case "--flag":`: a switch-based parser.
 */
export function flagTokens(source: string): string[] {
  return [
    ...new Set([
      ...acceptedFlags(source),
      ...[...source.matchAll(/[\w$]+(?:\[\d+\]|\.[\w$]+)*\s*===\s*"(-{1,2}[a-z0-9-]+)"/g)].map((m) => m[1]!),
      ...[...source.matchAll(/case\s+"(-{1,2}[a-z0-9-]+)"\s*:/g)].map((m) => m[1]!),
    ]),
  ];
}

/**
 * The modules that make up ONE verb's flag surface: its dispatch module, plus everything it
 * imports (transitively) inside that module's own directory.
 *
 * A verb's sub-commands live beside it (`minigame.ts` -> `minigame-capture.ts`,
 * `trace.ts` -> the replay modules), and they parse their own flags. Without the closure,
 * `loombridge minigame baseline approve --contract <path>` would fail this guard because
 * `--contract` is parsed one file over. The closure is DIRECTORY-SCOPED rather than repo-wide
 * on purpose: repo-wide would eventually reach every flag in the product from every verb, and
 * an inventory that accepts everything accepts a typo too.
 */
const FLAG_SURFACE_CACHE = new Map<string, Set<string>>();

export function verbFlagSurface(entry: string): Set<string> {
  const cached = FLAG_SURFACE_CACHE.get(entry);
  if (cached) return cached;
  const area = path.dirname(entry);
  const seen = new Set<string>();
  const stack = [entry];
  const flags = new Set<string>();
  while (stack.length > 0) {
    const file = stack.pop()!;
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    const source = readFileSync(file, "utf-8");
    for (const flag of flagTokens(source)) flags.add(flag);
    for (const m of source.matchAll(/(?:from\s+|import\()\s*"(\.[^"]+)"/g)) {
      const abs = path.resolve(path.dirname(file), m[1]!).replace(/\.js$/, ".ts");
      if (abs === entry || abs.startsWith(`${area}${path.sep}`)) stack.push(abs);
    }
  }
  FLAG_SURFACE_CACHE.set(entry, flags);
  return flags;
}

const CLI_SOURCE = readFileSync(CLI_SRC, "utf-8");
const VERBS = cliVerbs(CLI_SOURCE);
const TOP_LEVEL = topLevelTokens(CLI_SOURCE);
const MODULES = verbModules(CLI_SOURCE);
const FILES = sourceFiles();

const ALL: PrintedCommand[] = FILES.flatMap((f) =>
  printedCommands(readFileSync(f, "utf-8"), path.relative(SRC, f)),
);

describe("printed next-action commands (REALITY CHECK against HEAD)", () => {
  test("the scan is non-vacuous: it reads real files and finds real commands", () => {
    // A scan that found nothing is indistinguishable from a defused one, so every
    // precondition the checks below rest on is asserted rather than assumed.
    assert.ok(FILES.length > 100, `walked only ${FILES.length} source files; the walk is broken`);
    assert.ok(ALL.length > 100, `found only ${ALL.length} printed commands; the scan is broken`);
    assert.ok(VERBS.size >= 15, `parsed only ${VERBS.size} verbs from cli.ts; the switch scan has drifted`);
    assert.ok(
      new Set(ALL.map((c) => c.file)).size > 20,
      "the commands all came from a handful of files; the walk is not reaching the codebase",
    );
    // The two families the defects lived in must actually be walked, by name: they are the
    // reason this guard exists, and a walk that stopped reaching them would still pass
    // everything else.
    for (const f of ["capabilities/verification/unified/discovery.ts", "capabilities/replay/visual-diff.ts"]) {
      assert.ok(ALL.some((c) => c.file === f), `the scan no longer reads ${f}`);
    }
  });

  test("every printed `loombridge <verb>` is a real verb at HEAD", () => {
    const unknown = ALL.filter((c) => !VERBS.has(c.head) && !TOP_LEVEL.has(c.head)).map(
      (c) => `${c.file} -> "${c.head}"   in: ${c.text}`,
    );
    assert.deepEqual(
      unknown,
      [],
      "the CLI prints a command whose verb is not a case in the cli.ts dispatch, so an operator who "
        + "pastes it gets `unknown command`",
    );
  });

  test("every flag on a printed command is a real flag for that verb at HEAD", () => {
    const bad: string[] = [];
    for (const cmd of ALL) {
      if (cmd.flags.length === 0) continue;
      if (TOP_LEVEL.has(cmd.head)) continue; // `loombridge --version` takes no verb flags
      const module = MODULES.get(cmd.head);
      // REFUSE, never skip. "Could not check" must not read the same as "checked and fine"
      // (the absent-field-is-a-refusal rule).
      if (module === undefined) {
        bad.push(`${cmd.file} -> no dispatch module for verb "${cmd.head}"   in: ${cmd.text}`);
        continue;
      }
      const accepted = verbFlagSurface(module);
      if (accepted.size === 0) {
        bad.push(`${cmd.file} -> the flag scan found NO flags for "${cmd.head}"   in: ${cmd.text}`);
        continue;
      }
      for (const flag of cmd.flags) {
        if (!accepted.has(flag)) {
          bad.push(`${cmd.file} -> \`loombridge ${cmd.head} ${flag}\` is not a flag that verb parses   in: ${cmd.text}`);
        }
      }
    }
    assert.deepEqual(bad, [], "the CLI prints a command carrying a flag its own parser would reject");
  });

  /**
   * LITMUS, on the REAL scan and the REAL inventories, with both defect shapes planted.
   *
   * PERFORMED against the REAL file, not only inline. Two strings were pasted into
   * `capabilities/verification/unified/discovery.ts`:
   *
   *     const LITMUS_A = "next: loombridge verifyy --root .";
   *     const LITMUS_B = "next: loombridge verify --not-a-real-flag";
   *
   * the suite was rebuilt, and BOTH real checks above failed. Observed VERBATIM:
   *
   *   ✖ every printed `loombridge <verb>` is a real verb at HEAD (0.589291ms)
   *     AssertionError [ERR_ASSERTION]: the CLI prints a command whose verb is not a case in
   *     the cli.ts dispatch, so an operator who pastes it gets `unknown command`
   *     + actual - expected
   *
   *     + [
   *     +   'capabilities/verification/unified/discovery.ts -> "verifyy"   in: loombridge verifyy --root .'
   *     + ]
   *     - []
   *
   *   ✖ every flag on a printed command is a real flag for that verb at HEAD (138.725333ms)
   *     AssertionError [ERR_ASSERTION]: the CLI prints a command carrying a flag its own parser would reject
   *     + actual - expected
   *
   *     + [
   *     +   'capabilities/verification/unified/discovery.ts -> no dispatch module for verb "verifyy"   in: loombridge verifyy --root .',
   *     +   'capabilities/verification/unified/discovery.ts -> `loombridge verify --not-a-real-flag` is not a flag that verb parses   in: loombridge verify --not-a-real-flag'
   *     + ]
   *     - []
   *
   * Removing the two planted lines returned this file to `ℹ pass 20 / ℹ fail 0`.
   */
  test("LITMUS: a bogus verb and a bogus flag on a REAL verb are both reported", () => {
    const planted = printedCommands('const x = "next: loombridge verifyy --root .";', "PLANTED");
    assert.equal(planted.length, 1, "the scan must see the planted command at all");
    assert.equal(planted[0]!.head, "verifyy");
    assert.ok(
      !VERBS.has(planted[0]!.head) && !TOP_LEVEL.has(planted[0]!.head),
      "a typo'd verb must not be in the derived inventory",
    );

    const badFlag = printedCommands('const x = "next: loombridge verify --not-a-real-flag";', "PLANTED");
    assert.equal(badFlag.length, 1);
    assert.ok(VERBS.has(badFlag[0]!.head), "the head must be a REAL verb, or this proves nothing about flags");
    const surface = verbFlagSurface(MODULES.get("verify")!);
    assert.ok(surface.has("--root") && surface.has("--offline"), "the flag scan must find the real flags");
    assert.deepEqual(
      badFlag[0]!.flags.filter((f) => !surface.has(f)),
      ["--not-a-real-flag"],
      "the flag walk missed a planted unreal flag; it cannot be protecting anything",
    );
  });

  /**
   * LITMUS for the two false positives that made a naive scan unusable, and for the comment
   * stripping without which this guard would be reading prose about history.
   */
  test("LITMUS: prose, paths and comments are not commands", () => {
    assert.deepEqual(
      printedCommands('const x = "Installed loombridge runtime is 0.2.0.";', "P"),
      [],
      "a sentence containing the product name is not an instruction",
    );
    assert.deepEqual(
      printedCommands('const x = "they MAY be loombridge servers or unrelated node apps";', "P"),
      [],
      "prose mid-sentence is not an instruction",
    );
    assert.deepEqual(
      printedCommands('const x = "clone https://github.com/Loomtide/loombridge into /tmp";', "P"),
      [],
      "a URL ending in the product name is not an invocation",
    );
    assert.deepEqual(
      printedCommands("// run loombridge verifyy --root .\nconst x = 1;", "P"),
      [],
      "a COMMENT is not printed; a scan that read comments would be checking prose",
    );
    assert.deepEqual(
      printedCommands("/* loombridge verifyy */\nconst x = 1;", "P"),
      [],
      "a block comment is not printed either",
    );

    // …and the shapes it MUST see, or the checks above are decorative.
    assert.equal(printedCommands('const x = "Usage: loombridge verify [options]";', "P").length, 1);
    assert.equal(printedCommands('const x = "  loombridge verify --offline";', "P").length, 1);
    assert.equal(printedCommands("const x = `${TAG}   2. loombridge verify --strict`;", "P").length, 1);
    assert.equal(printedCommands('const x = "re-run `loombridge verify --offline` first";', "P").length, 1);
    // A template value is a VALUE, never a flag: `--root <value>` must not read as two flags.
    assert.deepEqual(printedCommands("const x = `run: loombridge verify --root ${root}`;", "P")[0]!.flags, [
      "--root",
    ]);
  });
});
