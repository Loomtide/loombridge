import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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

/** Remove line/block comments so a specifier quoted in prose is not read as an import. */
export function stripCommentary(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
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
});

test("layering: the layer classifier maps each top-level directory", () => {
  assert.equal(layerOf("shared/build-stamp.ts"), "shared");
  assert.equal(layerOf("domain/capture-paths.ts"), "domain");
  assert.equal(layerOf("capabilities/replay/engine.ts"), "capabilities");
  assert.equal(layerOf("index.ts"), "root");
  assert.equal(layerOf("verification-legacy/x.ts"), "root");
});
