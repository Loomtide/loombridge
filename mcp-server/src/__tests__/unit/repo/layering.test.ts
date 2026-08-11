import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { PKG_ROOT as PKG_ROOT_SUPPORT } from "../../_support/paths.js";

/**
 * Enforces the dependency DIRECTION between the source layers.
 *
 * The reorganisation that created `domain/` and `capabilities/` is only worth anything if
 * it stays true. Directory names alone don't stop the next contributor re-creating the
 * 168-file bin this replaced, so the rule is checked, not just documented:
 *
 *     surfaces  ->  capabilities  ->  domain  ->  shared
 *
 * Each layer may import from the ones to its right, never to its left.
 *  - `shared/`       leaf helpers: no domain vocabulary, no capability logic.
 *  - `domain/`       the shared nouns only — schemas, capture paths, workspace layout,
 *                    contract presence. Deliberately small: this check is what proved the
 *                    first cut too generous. Genre packs, sfx cue-maps and mini-game
 *                    profiles all LOOK like vocabulary but import gate implementations,
 *                    so they are capabilities, not domain.
 *  - `capabilities/` one directory per area (verification, replay, minigame, feel, genre,
 *                    assets, sfx, telemetry, setup, mobile), including that area's CLI
 *                    verb entrypoint.
 *
 *  - `bridge/`       Unity transport and editor routing.
 *  - `surfaces/`     the MCP server and CLI entrypoints.
 *
 * `src/` no longer holds loose `.ts` files, so the `"root"` layer is a defensive default
 * for anything that appears there in future rather than a live exemption — it is
 * unconstrained precisely so a stray new file is visible rather than silently blessed.
 */

const SRC = path.join(PKG_ROOT_SUPPORT, "src");

type Layer = "shared" | "domain" | "bridge" | "capabilities" | "surfaces" | "root";

/**
 * Layers a file may NOT import from.
 *
 *   surfaces -> capabilities -> { bridge, domain } -> shared
 *
 * `bridge` (Unity transport, editor discovery/registry) and `domain` (the shared nouns)
 * are siblings: neither needs the other, and keeping them independent is what stops the
 * wire protocol leaking into contract vocabulary.
 */
const FORBIDDEN: Record<Layer, Layer[]> = {
  shared: ["domain", "bridge", "capabilities", "surfaces"],
  domain: ["bridge", "capabilities", "surfaces"],
  bridge: ["domain", "capabilities", "surfaces"],
  capabilities: ["surfaces"],
  surfaces: [],
  root: [],
};

export function layerOf(relPath: string): Layer {
  const top = relPath.split("/")[0];
  if (top === "shared") return "shared";
  if (top === "domain") return "domain";
  if (top === "bridge") return "bridge";
  if (top === "capabilities") return "capabilities";
  if (top === "surfaces") return "surfaces";
  return "root";
}

/**
 * Every shape a module specifier can take here. The first version matched only
 * `from "..."` with double quotes, so it was blind to dynamic `import()` — which is the
 * established cross-module idiom in this codebase (doctor, verify, minigame-finalize,
 * genre-registry all use it) — as well as single quotes, bare side-effect imports and
 * createRequire. A layering rule that any lazy import can walk through is not a rule.
 */
/** Quote characters a specifier can be wrapped in — including backticks. */
const Q = "[\"'`]";
const NOT_Q = "[^\"'`]";

const SPECIFIER_RE = new RegExp(
  [
    // from "x" | import("x") | import 'x' | await import(`x`)
    `(?:from|import)\\s*\\(?\\s*${Q}(${NOT_Q}+)${Q}`,
    `require\\s*\\(\\s*${Q}(${NOT_Q}+)${Q}`,
    `export\\s+(?:\\*|\\{[^}]*\\})\\s+from\\s*${Q}(${NOT_Q}+)${Q}`,
    `import\\s+type\\s+${NOT_Q}*from\\s*${Q}(${NOT_Q}+)${Q}`,
  ].join("|"),
  "g",
);

/**
 * Remove line/block comments so a specifier quoted in prose is not read as an import.
 *
 * TOKENISED, NOT REGEXED. The first version was two regexes over raw text, which is
 * string-unaware in both directions and silently ATE REAL CODE:
 *
 *   - `const a = "/*";`  opened a block strip that ran to the next `*` + `/` anywhere later
 *     in the file, deleting every line in between. Anything declared in that window became
 *     invisible to every caller of this function.
 *   - `const re = /\/\//;` put two adjacent slashes in a regex literal, which the line-comment
 *     regex read as `//` and stripped to end of line, taking any real declaration sharing
 *     that line with it.
 *
 * Both holes are silent: the caller sees a shorter string and reports nothing, which is the
 * "reads as enforcement while enforcing nothing" failure this file exists to prevent. Two
 * guards rest an EXHAUSTIVENESS claim on this function (the layering scan below and the
 * write-path guard's one-spelling walk), so the stripper has to understand string literals,
 * template literals and regex literals, not just `/*` and `//`.
 *
 * The TypeScript parser already does. Comments are trivia attached to tokens, so parsing and
 * blanking exactly the trivia ranges is correct by construction rather than by heuristic.
 * Comments are replaced with SPACES (newlines kept) rather than deleted, so offsets and line
 * numbers survive and two tokens can never be glued together by the removal.
 *
 * Memoised on the EXACT source text (not the filename, so a planted string is still parsed):
 * parsing costs far more than the old regex pair, and the litmus tests below re-scan the whole
 * tree eight times over identical bytes.
 */
const STRIP_CACHE = new Map<string, string>();

export function stripCommentary(source: string): string {
  const cached = STRIP_CACHE.get(source);
  if (cached !== undefined) return cached;
  const stripped = stripCommentaryUncached(source);
  STRIP_CACHE.set(source, stripped);
  return stripped;
}

function stripCommentaryUncached(source: string): string {
  const sourceFile = ts.createSourceFile(
    "stripCommentary.ts",
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  );
  const chars = [...source];
  const blank = (from: number, to: number): void => {
    for (let i = from; i < to && i < chars.length; i++) {
      if (chars[i] !== "\n" && chars[i] !== "\r") chars[i] = " ";
    }
  };

  // Every comment is either LEADING trivia of the token that follows it or TRAILING trivia of
  // the token before it on the same line. Visiting both for every node covers the file; a
  // comment at EOF is leading trivia of the EndOfFileToken, which is a child of the source
  // file, so it is covered too. `seen` only avoids repeated work; blanking is idempotent.
  const seen = new Set<number>();
  const visit = (node: ts.Node): void => {
    const fullStart = node.getFullStart();
    if (!seen.has(fullStart)) {
      seen.add(fullStart);
      for (const range of ts.getLeadingCommentRanges(source, fullStart) ?? []) blank(range.pos, range.end);
    }
    const end = node.getEnd();
    if (!seen.has(-end - 1)) {
      seen.add(-end - 1);
      for (const range of ts.getTrailingCommentRanges(source, end) ?? []) blank(range.pos, range.end);
    }
    for (const child of node.getChildren(sourceFile)) visit(child);
  };
  visit(sourceFile);
  return chars.join("");
}

function tsFiles(dir: string, acc: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "__tests__" || e.name === "node_modules") continue;
      tsFiles(abs, acc);
    } else if (e.name.endsWith(".ts")) {
      acc.push(abs);
    }
  }
  return acc;
}

/** Every (importer, imported) layer pair produced by relative imports in the tree. */
export function collectViolations(
  srcRoot: string,
  readFile: (p: string) => string = (p) => fs.readFileSync(p, "utf-8"),
): string[] {
  const violations: string[] = [];
  for (const abs of tsFiles(srcRoot)) {
    const rel = path.relative(srcRoot, abs).split(path.sep).join("/");
    const from = layerOf(rel);
    const forbidden = FORBIDDEN[from];
    if (forbidden.length === 0) continue;

    // Strip comments and template-literal noise first: a specifier MENTIONED in a comment
    // ("historically re-exported from ...") is documentation, not a dependency, and firing
    // on it would punish writing things down. Stripping is cheap and removes the whole
    // class of false positives without weakening detection of real imports.
    const text = stripCommentary(readFile(abs));
    for (const m of text.matchAll(SPECIFIER_RE)) {
      const spec = m[1] ?? m[2] ?? m[3] ?? m[4];
      if (!spec) continue;
      if (!spec.startsWith(".")) continue;
      const resolved = path
        .relative(srcRoot, path.resolve(path.dirname(abs), spec))
        .split(path.sep)
        .join("/");
      const to = layerOf(resolved);
      if (forbidden.includes(to)) {
        violations.push(`${rel} (${from}) imports ${resolved} (${to})`);
      }
    }
  }
  return violations.sort();
}

test("layering: no import points backwards through the layers", () => {
  const violations = collectViolations(SRC);
  assert.deepEqual(
    violations,
    [],
    `dependency direction violated — a layer may only import layers to its right\n` +
      `(surfaces -> capabilities -> domain -> shared):\n  ${violations.join("\n  ")}`,
  );
});

test("layering LITMUS: the detector actually fires on a planted violation", () => {
  // A checker that cannot fail is worse than no checker: it reads as enforcement while
  // enforcing nothing. Plant a domain -> capabilities import and require a report.
  const planted = path.join(SRC, "domain", "capture-paths.ts");
  assert.ok(fs.existsSync(planted), "fixture file for the litmus must exist");

  // Assembled rather than written as a literal: a bulk import-rewriter treats a literal
  // specifier here as a real import and "fixes" it when this file moves, silently
  // defusing the litmus. Keeping it out of that shape is what stops the check rotting.
  const plantedImport = `import { runVerify } from "${".."}/capabilities/verification/verify.js";`;
  const violations = collectViolations(SRC, (p) =>
    p === planted ? plantedImport : fs.readFileSync(p, "utf-8"),
  );

  assert.equal(violations.length, 1, "exactly the planted violation should be reported");
  assert.match(violations[0], /^domain\/capture-paths\.ts \(domain\) imports capabilities\//);
});

test("layering LITMUS: every import shape is detected, not just a static double-quoted one", () => {
  // The matcher previously saw only `from "x"`. Each shape below is a real way this
  // codebase imports across modules — dynamic import() especially — so each must trip
  // the rule. A litmus that plants one shape only proves that shape.
  const planted = path.join(SRC, "domain", "capture-paths.ts");
  const target = `${".."}/capabilities/verification/verify.js`;
  const shapes: Record<string, string> = {
    "double-quoted static": `import { x } from "${target}";`,
    "single-quoted static": `import { x } from '${target}';`,
    "dynamic import()": `const m = await import("${target}");`,
    "side-effect import": `import "${target}";`,
    "re-export": `export { x } from "${target}";`,
    "type-only": `import type { X } from "${target}";`,
    "require()": `const m = require("${target}");`,
    "template-literal import()": `const m = await import(\`${target}\`);`,
  };

  for (const [shape, source] of Object.entries(shapes)) {
    const violations = collectViolations(SRC, (p) => (p === planted ? source : fs.readFileSync(p, "utf-8")));
    assert.equal(violations.length, 1, `${shape}: expected exactly the planted violation`);
    assert.match(violations[0], /^domain\/capture-paths\.ts \(domain\) imports capabilities\//, shape);
  }
});

test("layering: a specifier MENTIONED in a comment is documentation, not a dependency", () => {
  // Firing on prose would punish writing things down — and an earlier version did exactly
  // that, flagging a historical note as a live violation.
  const planted = path.join(SRC, "domain", "capture-paths.ts");
  const target = `${".."}/capabilities/verification/verify.js`;
  const commentary = [
    `// historically re-exported from "${target}"`,
    `/** see import("${target}") for the old shape */`,
  ];

  for (const source of commentary) {
    const violations = collectViolations(SRC, (p) => (p === planted ? source : fs.readFileSync(p, "utf-8")));
    assert.deepEqual(violations, [], `a commented specifier must not fire: ${source}`);
  }
});

test("layering: stripCommentary removes comments without eating real code", () => {
  assert.equal(stripCommentary('import x from "a";\n// import y from "b";').includes('"b"'), false);
  assert.equal(stripCommentary('import x from "a";\n/* import y from "b"; */').includes('"b"'), false);
  // A URL inside real code must survive — the `//` in https:// is not a comment.
  assert.ok(stripCommentary('const u = "https://example.com/x";').includes("example.com"));
  // A trailing comment on the same line as real code is still a comment.
  assert.equal(stripCommentary('const x = a / b; // import y from "b";').includes('"b"'), false);
});

test("stripCommentary LITMUS: a `/*` inside a STRING must not open a strip", () => {
  // OBSERVED with the previous regex-only stripper. Reverting `stripCommentary` to
  //   source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1")
  // and re-running this file fails, verbatim:
  //
  //   ✖ stripCommentary LITMUS: a `/*` inside a STRING must not open a strip
  //     AssertionError [ERR_ASSERTION]: a `/*` inside a string literal opened a comment strip and ate the declaration between it and the next `*/`
  //     + actual - expected
  //
  //     + 'const open = "";'
  //     - 'const open = "/*";\n' +
  //     -   'const dest = ".loombridge/orphaned-anchors";\n' +
  //     -   'const close = "*/";'
  //
  // The eaten line is exactly the shape the write-path guard exists to see: a project-local
  // destination, invisible because the STRIPPER deleted it before the scan ever ran.
  const source = ['const open = "/*";', 'const dest = ".loombridge/orphaned-anchors";', 'const close = "*/";'].join(
    "\n",
  );
  assert.equal(
    stripCommentary(source),
    source,
    "a `/*` inside a string literal opened a comment strip and ate the declaration between it and the next `*/`",
  );
});

test("stripCommentary LITMUS: a regex literal with escaped slashes must not open a line strip", () => {
  // OBSERVED with the previous regex-only stripper, same revert, verbatim:
  //
  //   ✖ stripCommentary LITMUS: a regex literal with escaped slashes must not open a line strip
  //     AssertionError [ERR_ASSERTION]: an escaped `//` inside a regex literal was read as a line comment and ate the rest of the line
  //     + actual - expected
  //
  //     + 'const re = /\\/\\'
  //     - 'const re = /\\/\\//; const dest = ".loombridge/orphaned-anchors";'
  //
  // Assembled from pieces so a formatter cannot "tidy" the escapes back into a shape that
  // happens to pass (CLAUDE.md: a bulk rewriter once silently defused this file's other
  // assembled-string self-test).
  const slash = "/";
  const source = `const re = ${slash}\\${slash}\\${slash}${slash}; const dest = "${".loombridge"}/orphaned-anchors";`;
  assert.equal(
    stripCommentary(source),
    source,
    "an escaped `//` inside a regex literal was read as a line comment and ate the rest of the line",
  );
});

test("stripCommentary LITMUS: a template literal keeps its comment-shaped contents", () => {
  const source = "const t = `x /* y */ z`;";
  assert.equal(stripCommentary(source), source);
});

test("stripCommentary: blanking preserves offsets, so nothing is glued together", () => {
  // Comments are replaced by spaces rather than deleted. Deleting them can join two tokens
  // that were only separated by the comment, inventing an identifier that was never written.
  const source = "const a = 1;/* gap */const b = 2;";
  const stripped = stripCommentary(source);
  assert.equal(stripped.length, source.length);
  assert.equal(stripped.includes("gap"), false);
  assert.equal(stripped.includes(";const b"), false, "the removal must leave whitespace, not join the tokens");
});

test("layering: the layer classifier maps each top-level directory", () => {
  assert.equal(layerOf("shared/build-stamp.ts"), "shared");
  assert.equal(layerOf("domain/capture-paths.ts"), "domain");
  assert.equal(layerOf("capabilities/replay/engine.ts"), "capabilities");
  assert.equal(layerOf("index.ts"), "root");
  assert.equal(layerOf("verification-legacy/x.ts"), "root");
});
