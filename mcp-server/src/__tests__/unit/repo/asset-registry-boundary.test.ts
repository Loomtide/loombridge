import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { builtinModules } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CLI_DIST, PKG_ROOT } from "../../_support/paths.js";
import { ASSET_CATALOG_URL_ENV_VAR, catalogUrlFromEnv } from "../../../capabilities/assets/catalog-source.js";
import { loadRegistryOrCatalog } from "../../../capabilities/assets/assets.js";

/**
 * The hosted asset registry is READ-ONLY from this open build, and every property that makes
 * that true used to be true by accident: nothing walked any of them.
 *
 * That is this repo's most expensive recurring failure shape (a declared path nothing walks),
 * except here it guards a SECURITY boundary rather than a report. Each defeated property is a way
 * an OSS consumer, or a consumer's agent, gains write access to infrastructure they should only
 * ever read. See `Docs/Design/AssetRegistryOssBoundary.md`.
 *
 * SHAPE, and why it changed. The first version of this file searched `capabilities/assets/**` for
 * bad strings (`method: "POST"`, a verb token, a network import). An adversarial review shipped a
 * WORKING `loombridge assets catalog-push` against all of it: put the `method` key one directory
 * up in `shared/`, shell out to `curl -XPOST`, assemble the verb from fragments, or add the
 * private module as an npm dependency. A denylist of bad strings inside one directory is a search
 * for the attacks someone already thought of. So the guards are now ALLOWLISTS over the whole
 * package:
 *
 *   1. the private authoring sources are absent, and the set of PRIVATE SEAMS is allowlisted by
 *      shape (a relative module specifier that resolves to nothing in this tree), not by the name
 *      of one constant;
 *   2. no literal, resolvable edge into a private tree exists in ANY code file, and no dependency
 *      edge either: the package's declared dependencies are allowlisted, and every bare import in
 *      `src/` must resolve to one of them or to a Node builtin;
 *   3. the authoring verbs refuse, proven by driving the REAL built CLI, not a mock, and `--help`
 *      neither advertises them nor executes private code;
 *   4. NETWORK EGRESS IS AN ALLOWLIST. Every site in `src/` that can put a byte on a socket is
 *      enumerated with a reason; a write verb may not be spelled anywhere; a request `method`
 *      field may not appear anywhere the assets code can REACH (its transitive import closure,
 *      not its directory); and `capabilities/assets/**` may not read `process.env` off-allowlist;
 *   5. no source file hardcodes a catalog endpoint, and the behavioural half is asserted against
 *      the REAL verb: with nothing configured, `registry-plan` refuses by name without touching
 *      the network.
 *
 * Every detector carries a LITMUS that plants the reviewer's actual attack and requires the
 * detector to fire, and every scanner asserts non-vacuity (files walked, allowlist entries
 * consumed) so it cannot silently degrade to scanning an empty set.
 *
 * LIMITS, stated the way this repo's other scanners state them:
 *   - Everything here is lexical, not a type-aware program analysis. An allowlisted network site
 *     handed a request-init object built by allowlisted code is only as safe as prongs B/C/D make
 *     that code.
 *   - The import closure follows RELATIVE specifiers only. A private edge through a bare
 *     specifier is prong 2's remit, not prong 4's.
 *   - Prong C's `method`-key detector is per-line text. A property named through a computed key
 *     whose text is assembled at runtime is not visible to it; the fragments would still have to
 *     survive prong B, and the surrounding site prong A.
 */

const SRC = path.join(PKG_ROOT, "src");
const ASSETS_SRC = path.join(SRC, "capabilities", "assets");
const PACKAGE_JSON = path.join(PKG_ROOT, "package.json");
/** Every extension a module edge can hide in. `.ts` alone let a private import sit in a `.mts`. */
const CODE_EXTS = [".ts", ".mts", ".cts", ".js", ".mjs", ".cjs"];
/** Where a seam specifier is resolved FROM, in both `src/` and `dist/`. */
const SEAM_HOST_DIR_PARTS = ["capabilities", "assets"];
const SEAM_HOST = path.join(ASSETS_SRC, "assets.ts");

// ---------------------------------------------------------------------------------------------
// Shared scanning helpers
// ---------------------------------------------------------------------------------------------

/**
 * ONE lexer, two views of the same source, offsets and line breaks preserved throughout.
 *
 *   `code`: comments blanked, string/template/regex contents KEPT. What the `method`-key, verb
 *            and `process.env` prongs read, and what the specifier walk reads.
 *   `bare`: comments AND every string / template / regex content blanked. What the network-site
 *            prong reads, so `"Catalog fetch failed"` and `/WebSocket is not open/` are prose
 *            about the network rather than a call to it.
 *
 * It is one lexer rather than two regex passes because two regex passes were WRONG, measured on
 * this tree while the guard was being written:
 *
 *   - a comment blanker with a `[^:]` guard in front of `//` (to protect `https://`) still ate the
 *     rest of the line on `target.startsWith("//")`, unbalancing the file's quotes;
 *   - a string blanker with no regex state hit
 *     `/Cannot find module '[^']*assets-authoring-cli\.js'/` in `assets.ts`, an ODD number of
 *     apostrophes, opened a quote that never closed, and silently blanked EVERY REMAINING LINE of
 *     the file the boundary is supposed to be guarding;
 *   - neither handled a nested template inside `${...}`, which seven source files use.
 *
 * Each of those is a scanner going blind while reporting nothing, which is the exact failure this
 * suite exists to prevent. `terminated` is the self-check: a file the lexer could not finish is a
 * FINDING, never a silent pass.
 */
export interface LexedSource {
  code: string;
  bare: string;
  terminated: boolean;
}

const REGEX_PRECEDERS = new Set([..."(,=:[!&|?{};+-*%~^<>"]);
const REGEX_KEYWORDS = /(?:^|[^\w$])(?:return|typeof|case|in|of|new|delete|void|do|else|yield|await|instanceof)$/;

export function lexSource(source: string): LexedSource {
  let code = "";
  let bare = "";
  let mode = "code";
  let significant = "";
  let braceDepth = 0;
  const tplStack: number[] = [];
  const push = (a: string, b: string): void => { code += a; bare += b; };
  const sp = (ch: string): string => (ch === "\n" ? "\n" : " ");

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i]!;
    const next = source[i + 1];
    if (mode === "code") {
      if (ch === "/" && next === "/") { mode = "line"; push(" ", " "); continue; }
      if (ch === "/" && next === "*") { mode = "block"; push(" ", " "); continue; }
      push(ch, ch);
      if (ch === "'") mode = "sq";
      else if (ch === "\"") mode = "dq";
      else if (ch === "`") mode = "tpl";
      else if (ch === "{") { braceDepth += 1; significant = ch; }
      else if (ch === "}") {
        braceDepth -= 1;
        if (tplStack.length > 0 && braceDepth === tplStack[tplStack.length - 1]) { tplStack.pop(); mode = "tpl"; }
        significant = ch;
      } else if (
        ch === "/"
        && (significant === "" || REGEX_PRECEDERS.has(significant) || REGEX_KEYWORDS.test(code.slice(0, -1)))
      ) {
        mode = "regex";
      } else if (!/\s/.test(ch)) significant = ch;
      continue;
    }
    if (mode === "line") {
      if (ch === "\n") { mode = "code"; push("\n", "\n"); } else push(" ", " ");
      continue;
    }
    if (mode === "block") {
      if (ch === "*" && next === "/") { mode = "code"; push("  ", "  "); i += 1; continue; }
      push(sp(ch), sp(ch));
      continue;
    }
    if (ch === "\\") { push(source.slice(i, i + 2).replace(/[^\n]/g, " "), "  "); i += 1; continue; }
    if (mode === "sq" || mode === "dq") {
      const quote = mode === "sq" ? "'" : "\"";
      if (ch === quote) { push(ch, ch); mode = "code"; significant = ch; continue; }
      push(ch, sp(ch));
      continue;
    }
    if (mode === "tpl") {
      if (ch === "`") { push(ch, ch); mode = "code"; significant = ch; continue; }
      if (ch === "$" && next === "{") {
        push("${", "${");
        tplStack.push(braceDepth);
        braceDepth += 1;
        mode = "code";
        i += 1;
        significant = "{";
        continue;
      }
      push(ch, sp(ch));
      continue;
    }
    if (mode === "regex") {
      if (ch === "\n") { mode = "code"; push("\n", "\n"); continue; }
      if (ch === "[") { push(ch, " "); mode = "regexClass"; continue; }
      if (ch === "/") { push(ch, ch); mode = "code"; significant = ch; continue; }
      push(ch, " ");
      continue;
    }
    if (mode === "regexClass") {
      if (ch === "\n") { mode = "code"; push("\n", "\n"); continue; }
      if (ch === "]") { push(ch, " "); mode = "regex"; continue; }
      push(ch, " ");
      continue;
    }
  }
  return { code, bare, terminated: mode === "code" && tplStack.length === 0 };
}

/** Comments blanked, strings kept: the default view for every text prong. */
export function blankComments(source: string): string {
  return lexSource(source).code;
}

/**
 * Every shape a module specifier can take. Deliberately the same set `layering.test.ts` uses:
 * a boundary that only sees `from "x"` is walked straight through by a dynamic `import()`, which
 * is the established cross-module idiom here. Duplicated rather than imported because importing
 * another `*.test.ts` would register its tests a second time under this file.
 */
const Q = "[\"'`]";
const NOT_Q = "[^\"'`]";
const SPECIFIER_RE = new RegExp(
  [
    `(?:from|import)\\s*\\(?\\s*${Q}(${NOT_Q}+)${Q}`,
    `require\\s*\\(\\s*${Q}(${NOT_Q}+)${Q}`,
    `export\\s+(?:\\*|\\{[^}]*\\})\\s+from\\s*${Q}(${NOT_Q}+)${Q}`,
    `import\\s+type\\s+${NOT_Q}*from\\s*${Q}(${NOT_Q}+)${Q}`,
  ].join("|"),
  "g",
);

function specifiersIn(text: string): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(SPECIFIER_RE)) {
    const spec = m[1] ?? m[2] ?? m[3] ?? m[4];
    if (spec) found.push(spec);
  }
  return found;
}

/**
 * The narrow, unambiguous import forms, used where a FALSE POSITIVE would be fatal to the guard's
 * usefulness (the bare-specifier walk). `SPECIFIER_RE` above is deliberately over-eager, which is
 * right for "is there an edge into the private tree" and wrong for "is this a declared package".
 */
const STRICT_IMPORT_RE =
  /(?:\bfrom\s*(["'])([^"'\n]+)\1)|(?:\bimport\s*\(\s*(["'])([^"'\n]+)\3\s*\))|(?:\brequire\s*\(\s*(["'])([^"'\n]+)\5\s*\))|(?:^[ \t]*import\s*(["'])([^"'\n]+)\7)/gm;

function strictSpecifiersIn(text: string): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(STRICT_IMPORT_RE)) {
    const spec = m[2] ?? m[4] ?? m[6] ?? m[8];
    if (spec) found.push(spec);
  }
  return found;
}

function filesUnder(dir: string, extensions: string[], acc: string[] = []): string[] {
  if (!fs.existsSync(dir)) return acc;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      filesUnder(abs, extensions, acc);
    } else if (extensions.some((ext) => entry.name.endsWith(ext))) {
      acc.push(abs);
    }
  }
  return acc;
}

function relative(root: string, abs: string): string {
  return path.relative(root, abs).split(path.sep).join("/");
}

type ReadFile = (p: string) => string;
const readFromDisk: ReadFile = (p) => fs.readFileSync(p, "utf-8");

/** Resolve a relative specifier to the source file it names, or null when nothing is there. */
function resolveRelative(fromFile: string, specifier: string): string | null {
  const abs = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [
    abs,
    abs.replace(/\.js$/, ".ts"),
    abs.replace(/\.js$/, ".mts"),
    abs.replace(/\.js$/, ".cts"),
    abs.replace(/\.mjs$/, ".mts"),
    abs.replace(/\.cjs$/, ".cts"),
    `${abs}.ts`,
    path.join(abs, "index.ts"),
    abs.replace(/\.js$/, "/index.ts"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile()) ?? null;
}

// ---------------------------------------------------------------------------------------------
// 1. The private seams
// ---------------------------------------------------------------------------------------------

export interface SeamDeclaration {
  /** `<file>` the declaration lives in, relative to `src/`. */
  file: string;
  /** The constant's name. */
  name: string;
  /** The module specifier handed to the dynamic `import()`. */
  specifier: string;
  /** The declared type annotation, or "" when TypeScript is left to infer one. */
  annotation: string;
}

/**
 * A PRIVATE SEAM, found by SHAPE rather than by name: a constant holding a relative module
 * specifier that resolves to nothing in this tree. That is exactly what an open-build seam into a
 * private sibling looks like, and it is the only definition that survives someone adding a second
 * one. The previous guard was bound to the single identifier `ASSET_AUTHORING_CLI_MODULE`, so a
 * `PUBLISH_CLI_MODULE` pointing at `../asset-publish/publish-cli.js` got ZERO coverage: not the
 * absence of its target directory, not its type widening, not its literal-import ban.
 */
export function privateSeamDeclarations(srcRoot: string, readFile: ReadFile = readFromDisk): SeamDeclaration[] {
  const seams: SeamDeclaration[] = [];
  const DECL_RE =
    /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::\s*([^=;]+?))?\s*=\s*["'`](\.{1,2}\/[^"'`]*\.(?:js|mjs|cjs|ts|mts|cts))["'`]/g;
  for (const abs of filesUnder(srcRoot, CODE_EXTS)) {
    const code = blankComments(readFile(abs));
    for (const m of code.matchAll(DECL_RE)) {
      const specifier = m[3]!;
      if (resolveRelative(abs, specifier)) continue; // a real, in-tree module: not a seam
      seams.push({
        file: relative(srcRoot, abs),
        name: m[1]!,
        specifier,
        annotation: (m[2] ?? "").trim(),
      });
    }
  }
  return seams.sort((a, b) => `${a.file}:${a.name}`.localeCompare(`${b.file}:${b.name}`));
}

/**
 * The seams that are ALLOWED to exist, by `<file>:<name>`. A new one is a finding, which is the
 * point: registering it here is what subjects it to the absence, widening and literal-import
 * guards below.
 */
const ALLOWED_SEAMS = new Set(["capabilities/assets/assets.ts:ASSET_AUTHORING_CLI_MODULE"]);

/** Absolute directories that must NOT exist in an open build, derived from the seam specifiers. */
function privateDirsFor(srcRoot: string, seams: SeamDeclaration[]): string[] {
  const dirs = seams.map((seam) =>
    path.dirname(path.resolve(path.join(srcRoot, ...path.dirname(seam.file).split("/")), seam.specifier)),
  );
  // Plus the location the RFC and the historical comment name, so the guard does not depend on
  // which of the two the private side actually uses.
  return [...new Set([...dirs, path.join(srcRoot, "asset-authoring")])];
}

export function presentPrivateDirs(srcRoot: string, seams: SeamDeclaration[]): string[] {
  return privateDirsFor(srcRoot, seams)
    .filter((dir) => fs.existsSync(dir))
    .map((dir) => relative(srcRoot, dir))
    .sort();
}

test("asset boundary: the set of private seams is exactly the allowlisted one", () => {
  assert.ok(filesUnder(SRC, CODE_EXTS).length > 200, "the seam walk looks vacuous");
  const seams = privateSeamDeclarations(SRC);
  assert.ok(seams.length > 0, "no private seam found at all: the detector or the seam moved");
  assert.deepEqual(
    seams.map((seam) => `${seam.file}:${seam.name}`).filter((key) => !ALLOWED_SEAMS.has(key)),
    [],
    "a NEW dynamic seam into a tree that does not exist here: register it in ALLOWED_SEAMS so the " +
      "absence, widening and literal-import guards apply to it",
  );
  assert.deepEqual(
    [...ALLOWED_SEAMS].filter((key) => !seams.some((seam) => `${seam.file}:${seam.name}` === key)),
    [],
    "an allowlisted seam no longer exists: the allowlist has gone stale and the guard is vacuous",
  );
});

test("asset boundary LITMUS: a SECOND seam constant is reported, whatever it is called", () => {
  // The reviewer's exact survivor: a differently-named constant pointing at a different private
  // tree. The old guard, bound to one identifier, saw nothing.
  const planted = `const PUBLISH_CLI_MODULE: string = "${".."}/asset-publish/publish-cli.js";\n`;
  const seams = privateSeamDeclarations(SRC, (p) => (p === SEAM_HOST ? planted : readFromDisk(p)));
  const keys = seams.map((seam) => `${seam.file}:${seam.name}`);
  assert.ok(
    keys.includes("capabilities/assets/assets.ts:PUBLISH_CLI_MODULE"),
    `the second seam must be reported, got: ${keys.join(", ")}`,
  );
  assert.ok(keys.some((key) => !ALLOWED_SEAMS.has(key)), "and it must not be allowlisted");
});

test("asset boundary LITMUS: an in-tree relative constant is NOT a seam", () => {
  // Negative control. Plenty of constants hold real relative paths; a detector that called them
  // all private seams would be unusable.
  const benign = `const REAL: string = "./catalog-source.js";\n`;
  const seams = privateSeamDeclarations(SRC, (p) => (p === SEAM_HOST ? benign : readFromDisk(p)));
  assert.deepEqual(
    seams.filter((seam) => seam.file === "capabilities/assets/assets.ts"),
    [],
    "a specifier that resolves in this tree is not a private seam",
  );
});

test("asset boundary: the private authoring sources are absent from this repo", () => {
  assert.deepEqual(
    presentPrivateDirs(SRC, privateSeamDeclarations(SRC)),
    [],
    "the private asset-authoring sources must never be vendored into the open repo",
  );
});

test("asset boundary LITMUS: a vendored private directory is reported", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "loombridge-seam-"));
  try {
    const seams = privateSeamDeclarations(SRC);
    for (const dir of privateDirsFor(root, seams)) fs.mkdirSync(dir, { recursive: true });
    const present = presentPrivateDirs(root, seams);
    assert.equal(present.length, 2, `both candidate locations must be reported, got ${present.join(", ")}`);
    assert.ok(present.includes("asset-authoring"));
    assert.ok(present.some((rel) => rel.endsWith("/asset-authoring")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/**
 * The `: string` annotation is the second half of the property. Without it TypeScript infers the
 * LITERAL type, and a literal-typed constant is exactly the shape a bundler or dependency walker
 * constant-folds back into a static edge into the private tree.
 *
 * This one is guarded because nothing else notices: removing the annotation was measured NOT to
 * fail `tsc --noEmit`, so the whole open/private split would keep compiling green while quietly
 * becoming foldable. The assertion is on the declared TYPE being the widened `string`.
 */
test("asset boundary: every private seam is widened to `string`, not a literal type", () => {
  for (const seam of privateSeamDeclarations(SRC)) {
    assert.equal(
      seam.annotation,
      "string",
      `${seam.file}:${seam.name} must carry an explicit \`: string\` annotation; an inferred or ` +
        "literal type makes the dynamic import statically resolvable again",
    );
  }
});

test("asset boundary LITMUS: an un-widened seam declaration is reported", () => {
  const at = (source: string) =>
    privateSeamDeclarations(SRC, (p) => (p === SEAM_HOST ? source : readFromDisk(p)))
      .find((seam) => seam.file === "capabilities/assets/assets.ts");
  assert.equal(
    at(`const X = "${".."}/asset-authoring/x.js";`)?.annotation,
    "",
    "an inferred literal type must not read as widened",
  );
  assert.notEqual(
    at(`const X: "${".."}/asset-authoring/x.js" = "${".."}/asset-authoring/x.js";`)?.annotation,
    "string",
    "an explicit literal type must not read as widened",
  );
  assert.equal(at(`const X: string = "${".."}/asset-authoring/x.js";`)?.annotation, "string");
});

// ---------------------------------------------------------------------------------------------
// 2. No resolvable edge into the private side: neither a literal import nor a dependency
// ---------------------------------------------------------------------------------------------

/** Path segments that name a private sibling tree; a bare specifier containing one is a finding. */
const PRIVATE_TREE_NAMES = ["asset-authoring", "asset-publish", "asset-layer-private", "registry-scale"];

/**
 * Every LITERAL module specifier in `src/` that names a private tree, in any import shape and in
 * ANY code extension. This is the property that makes a seam safe: not "the constant is spelled a
 * certain way", but "no tool that resolves specifiers can see an edge into the private side".
 */
export function literalPrivateImports(
  srcRoot: string,
  seams: SeamDeclaration[],
  readFile: ReadFile = readFromDisk,
): string[] {
  const privateDirs = privateDirsFor(srcRoot, seams);
  const findings: string[] = [];
  for (const abs of filesUnder(srcRoot, CODE_EXTS)) {
    const rel = relative(srcRoot, abs);
    for (const spec of specifiersIn(blankComments(readFile(abs)))) {
      if (spec.startsWith(".")) {
        const target = path.resolve(path.dirname(abs), spec);
        if (privateDirs.some((dir) => target === dir || target.startsWith(dir + path.sep))) {
          findings.push(`${rel}: ${spec}`);
        }
      } else if (PRIVATE_TREE_NAMES.some((name) => spec.includes(name))) {
        findings.push(`${rel}: ${spec}`);
      }
    }
  }
  return findings.sort();
}

test("asset boundary: no literal import into a private tree exists anywhere in src/", () => {
  // Non-vacuity: every scanner in this file returns `[]` on an empty directory, so each one has to
  // prove it walked a real tree before its empty result means anything.
  assert.ok(filesUnder(SRC, CODE_EXTS).length > 200, "the specifier walk looks vacuous");
  const findings = literalPrivateImports(SRC, privateSeamDeclarations(SRC));
  assert.deepEqual(
    findings,
    [],
    "a literal specifier naming a private tree lets tsc, a bundler, or a dependency walker follow " +
      `an edge into it:\n  ${findings.join("\n  ")}`,
  );
});

test("asset boundary LITMUS: every literal import shape into the private tree is reported", () => {
  const seams = privateSeamDeclarations(SRC);
  // Assembled, never written as a literal specifier: a bulk import-rewriter treats a literal
  // here as a real import and "fixes" it, silently defusing the litmus. `layering.test.ts`
  // carries the same note after that happened to it.
  const target = `${".."}/asset-authoring/assets-authoring-cli.js`;
  const shapes: Record<string, string> = {
    "static import": `import { runPackIngest } from "${target}";`,
    "single-quoted": `import { runPackIngest } from '${target}';`,
    "dynamic import()": `const m = await import("${target}");`,
    "template import()": `const m = await import(\`${target}\`);`,
    "side-effect": `import "${target}";`,
    "re-export": `export { runPackIngest } from "${target}";`,
    "type-only": `import type { X } from "${target}";`,
    "require()": `const m = require("${target}");`,
  };

  for (const [shape, source] of Object.entries(shapes)) {
    const findings = literalPrivateImports(SRC, seams, (p) => (p === SEAM_HOST ? source : readFromDisk(p)));
    assert.equal(findings.length, 1, `${shape}: expected exactly the planted literal import`);
    assert.match(findings[0]!, /assets\.ts: \.\.\/asset-authoring\//, shape);
  }
});

test("asset boundary LITMUS: a private import in a `.mts` file is reported", () => {
  // The old walker visited `.ts` only. A `.mts` sibling was a free, static, bundler-followable
  // edge into the private side.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loombridge-mts-"));
  try {
    fs.mkdirSync(path.join(dir, "capabilities", "assets"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "capabilities", "assets", "shim.mts"),
      `import { runPackIngest } from "${".."}/asset-authoring/assets-authoring-cli.js";\n`,
      "utf-8",
    );
    const seams: SeamDeclaration[] = [{
      file: "capabilities/assets/assets.ts",
      name: "ASSET_AUTHORING_CLI_MODULE",
      specifier: `${".."}/asset-authoring/assets-authoring-cli.js`,
      annotation: "string",
    }];
    const findings = literalPrivateImports(dir, seams);
    assert.deepEqual(findings, ["capabilities/assets/shim.mts: ../asset-authoring/assets-authoring-cli.js"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("asset boundary LITMUS: a specifier MENTIONED in a comment is documentation, not an edge", () => {
  const seams = privateSeamDeclarations(SRC);
  const target = `${".."}/asset-authoring/assets-authoring-cli.js`;
  for (const commentary of [`// see import("${target}")`, `/** was: from "${target}" */`]) {
    assert.deepEqual(
      literalPrivateImports(SRC, seams, (p) => (p === SEAM_HOST ? commentary : readFromDisk(p))),
      [],
      `a commented specifier must not fire: ${commentary}`,
    );
  }
});

/**
 * The dependency half of the same property, and the reviewer's cleanest defeat of the old guard:
 * add `@loomtide/authoring-cli` to `dependencies` and `import` it literally. `tsc --noEmit`
 * returned 0 and every guard stayed green, because the old scan only understood RELATIVE
 * specifiers into two known directories, or bare specifiers whose TEXT said "asset-authoring".
 *
 * An allowlist of declared packages, plus "every bare import must be one of them", closes it
 * without having to guess what a private package might be called.
 */
const ALLOWED_DEPENDENCIES = new Set([
  "@modelcontextprotocol/sdk",
  "pngjs",
  "ws",
  "@types/node",
  "@types/pngjs",
  "@types/ws",
  "tsx",
  "typescript",
]);

export function undeclaredDependencies(manifest: Record<string, unknown>): string[] {
  const fields = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
  const found: string[] = [];
  for (const field of fields) {
    const block = manifest[field];
    if (!block || typeof block !== "object") continue;
    for (const name of Object.keys(block as Record<string, unknown>)) {
      if (!ALLOWED_DEPENDENCIES.has(name)) found.push(`${field}: ${name}`);
    }
  }
  return found.sort();
}

test("asset boundary: the package declares only allowlisted dependencies", () => {
  const manifest = JSON.parse(readFromDisk(PACKAGE_JSON)) as Record<string, unknown>;
  const findings = undeclaredDependencies(manifest);
  assert.deepEqual(
    findings,
    [],
    "a new dependency is a new, static, bundler-followable edge out of this package. Add it here " +
      `deliberately or not at all:\n  ${findings.join("\n  ")}`,
  );
  // Non-vacuity: the allowlist must actually describe this package, not a package that moved on.
  const declared = new Set(
    ["dependencies", "devDependencies"].flatMap((field) =>
      Object.keys((manifest[field] ?? {}) as Record<string, unknown>)),
  );
  assert.deepEqual(
    [...ALLOWED_DEPENDENCIES].filter((name) => !declared.has(name)),
    [],
    "the dependency allowlist has entries this package no longer declares",
  );
});

test("asset boundary LITMUS: a private npm dependency is reported", () => {
  assert.deepEqual(
    undeclaredDependencies({ dependencies: { ws: "^8", "@loomtide/authoring-cli": "^1" } }),
    ["dependencies: @loomtide/authoring-cli"],
  );
  assert.deepEqual(
    undeclaredDependencies({ devDependencies: { "@loomtide/asset-registry-admin": "*" } }),
    ["devDependencies: @loomtide/asset-registry-admin"],
  );
});

const NODE_BUILTINS = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);

/** Bare specifiers in `src/` that are neither a Node builtin nor a declared dependency. */
export function undeclaredBareImports(srcRoot: string, readFile: ReadFile = readFromDisk): string[] {
  const findings: string[] = [];
  for (const abs of filesUnder(srcRoot, CODE_EXTS)) {
    const rel = relative(srcRoot, abs);
    for (const spec of strictSpecifiersIn(blankComments(readFile(abs)))) {
      if (spec.startsWith(".") || spec.startsWith("/")) continue;
      // Limit: `from` also appears as an object key in front of a template literal, so anything
      // that is not shaped like a package specifier is skipped rather than reported. A private
      // package name has to be a legal package name to be importable, so nothing an attacker can
      // actually use hides in the skipped set.
      if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+(?:\/[a-zA-Z0-9._-]+)*$/i.test(spec)) continue;
      if (NODE_BUILTINS.has(spec)) continue;
      const packageName = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]!;
      if (!ALLOWED_DEPENDENCIES.has(packageName)) findings.push(`${rel}: ${spec}`);
    }
  }
  return [...new Set(findings)].sort();
}

test("asset boundary: every bare import in src/ resolves to a builtin or a declared dependency", () => {
  assert.ok(NODE_BUILTINS.size > 20, "the Node builtin list looks vacuous");
  assert.ok(filesUnder(SRC, CODE_EXTS).length > 200, "the bare-import walk looks vacuous");
  const findings = undeclaredBareImports(SRC);
  assert.deepEqual(
    findings,
    [],
    `an import of something this package never declared:\n  ${findings.join("\n  ")}`,
  );
});

test("asset boundary LITMUS: an undeclared bare import is reported", () => {
  const planted = `import { publish } from "@loomtide/authoring-cli";\n`;
  const findings = undeclaredBareImports(SRC, (p) => (p === SEAM_HOST ? planted : readFromDisk(p)));
  assert.deepEqual(findings, ["capabilities/assets/assets.ts: @loomtide/authoring-cli"]);
});

// ---------------------------------------------------------------------------------------------
// 3. The authoring verbs refuse, proven against the shipped CLI
// ---------------------------------------------------------------------------------------------

const AUTHORING_VERBS = ["pack-ingest", "cover-build", "discover"] as const;
const REFUSAL_RE =
  /require the private asset-authoring tooling, which is not present in this build/;

function runAssets(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CLI_DIST, "assets", ...args], { encoding: "utf-8" });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** The refusal assertions, factored out so the planted-stub LITMUS can require them to FAIL. */
function assertAuthoringVerbsRefuse(): void {
  for (const verb of AUTHORING_VERBS) {
    const result = runAssets([verb]);
    assert.notEqual(result.status, 0, `assets ${verb} must exit non-zero in an open build`);
    assert.match(result.stderr, REFUSAL_RE, `assets ${verb} must print the refusal`);
  }
  // The byte-publishing path specifically: `--apply --source-root` is the one that would push
  // bytes to the hosted registry, so it is asserted separately from the dry-run default.
  const apply = runAssets(["pack-ingest", "--manifest", "x.json", "--apply", "--source-root", "."]);
  assert.notEqual(apply.status, 0, "the --apply publish path must exit non-zero in an open build");
  assert.match(apply.stderr, REFUSAL_RE);
}

test("asset boundary: every authoring verb refuses in the shipped CLI", () => {
  assertAuthoringVerbsRefuse();
});

test("asset boundary: the refusal names no private path", () => {
  // The refusal is the ONE message an OSS consumer sees about the private side. It used to quote
  // the resolver's ERR_MODULE_NOT_FOUND text, i.e. the absolute path of the private module,
  // strictly more than the help block this branch removed to avoid exactly that leak.
  const stderr = runAssets(["pack-ingest"]).stderr;
  assert.match(stderr, REFUSAL_RE);
  for (const leak of [/assets-authoring-cli/, /Cannot find module/, /\/dist\//, /file:\/\//, /\.js\b/]) {
    assert.doesNotMatch(stderr, leak, `the refusal must not disclose ${leak}`);
  }
  // ...and it must not re-list the verb names the help block deliberately stopped advertising.
  for (const verb of AUTHORING_VERBS) {
    assert.doesNotMatch(stderr, new RegExp(verb), `the refusal must not enumerate ${verb}`);
  }
});

/** `assets --help` output, which change 2 gates on the same seam resolution. */
function assetsHelp(): string {
  const result = runAssets(["--help"]);
  assert.equal(result.status, 0, "assets --help must exit 0");
  return result.stdout;
}

test("asset boundary: --help does not advertise the private authoring verbs", () => {
  const help = assetsHelp();
  assert.match(help, /registry-plan/, "the consumer verbs must still be documented");
  for (const verb of AUTHORING_VERBS) {
    assert.doesNotMatch(help, new RegExp(verb), `assets --help must not name ${verb} in an open build`);
  }
  assert.doesNotMatch(help, /R2/, "assets --help must not describe the private publish mechanic");
});

/**
 * `--help` must never EXECUTE the private side. Gating the help text on `await import(seam)` moved
 * a dynamic import of private code onto the pure help path, where `resolveAssetsAuthoringCli`
 * deliberately rethrows anything that is not the seam module itself being absent: a private module
 * with one missing transitive import turned `assets --help` into a raw ERR_MODULE_NOT_FOUND stack
 * and exit 1. Presence is now answered by a file-existence check, which this proves by planting a
 * seam module that THROWS on import.
 */
test("asset boundary: --help never executes private top-level code", () => {
  const seams = privateSeamDeclarations(SRC);
  const seam = seams.find((s) => ALLOWED_SEAMS.has(`${s.file}:${s.name}`))!;
  const stubFile = path.resolve(path.join(PKG_ROOT, "dist", ...SEAM_HOST_DIR_PARTS), seam.specifier);
  const stubDir = path.dirname(stubFile);
  assert.ok(!fs.existsSync(stubFile), "refusing to clobber an existing authoring module");
  const dirExisted = fs.existsSync(stubDir);
  try {
    fs.mkdirSync(stubDir, { recursive: true });
    fs.writeFileSync(
      stubFile,
      // A private module whose own transitive dependency is missing: exactly the case
      // `resolveAssetsAuthoringCli` is required to rethrow.
      `import "./definitely-not-here.js";\nexport async function runPackIngest() { return 0; }\n`,
      "utf-8",
    );
    const result = runAssets(["--help"]);
    assert.equal(result.status, 0, `assets --help must still exit 0, got ${result.status}: ${result.stderr}`);
    assert.doesNotMatch(result.stderr, /ERR_MODULE_NOT_FOUND|Cannot find module/, result.stderr);
    assert.match(result.stdout, /registry-plan/);
  } finally {
    fs.rmSync(stubFile, { force: true });
    if (!dirExisted) fs.rmSync(stubDir, { recursive: true, force: true });
  }
});

/**
 * LITMUS for both the refusal guard and the help gate, and the only one that plants executable
 * code: a stub authoring module makes the verbs succeed and the help block appear. If the
 * refusal assertions still pass with the private side "installed", they were never bound to it.
 *
 * The plant is under try/finally and removes only what it created, so a crashed run cannot leave
 * a stub module in `dist/` for the rest of the suite (or a later `loombridge assets pack-ingest`)
 * to pick up.
 */
test("asset boundary LITMUS: a planted authoring stub breaks the refusal and reveals the help", () => {
  const seams = privateSeamDeclarations(SRC);
  const seam = seams.find((s) => ALLOWED_SEAMS.has(`${s.file}:${s.name}`))!;
  const stubFile = path.resolve(path.join(PKG_ROOT, "dist", ...SEAM_HOST_DIR_PARTS), seam.specifier);
  const stubDir = path.dirname(stubFile);
  assert.ok(!fs.existsSync(stubFile), "refusing to clobber an existing authoring module");
  const dirExisted = fs.existsSync(stubDir);

  try {
    fs.mkdirSync(stubDir, { recursive: true });
    fs.writeFileSync(
      stubFile,
      [
        "export async function runPackIngest() { return 0; }",
        "export async function runCoverBuild() { return 0; }",
        "export async function runDiscover() { return 0; }",
        "",
      ].join("\n"),
      "utf-8",
    );

    assert.throws(
      () => assertAuthoringVerbsRefuse(),
      /must exit non-zero|must print the refusal/,
      "the refusal assertions must FAIL once the private side is present",
    );

    const help = assetsHelp();
    for (const verb of AUTHORING_VERBS) {
      assert.match(help, new RegExp(verb), `--help must advertise ${verb} when the seam is present`);
    }
    assert.match(help, /R2/, "--help must print the authoring block verbatim when the seam is present");
  } finally {
    fs.rmSync(stubFile, { force: true });
    if (!dirExisted) fs.rmSync(stubDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------
// 4. Network egress is an allowlist, and every allowed site is read-only
// ---------------------------------------------------------------------------------------------

/**
 * PRONG A: every site in `src/` that can put a byte on a socket.
 *
 * This is an ALLOWLIST, and that is the whole point of the redesign. The previous guard searched
 * `capabilities/assets/**` for bad strings, so moving the verb one directory up into `shared/`
 * left the scanned directory containing nothing but a function call. Enumerating the CALL SITES
 * instead is defeated only by adding a new one, which is the finding.
 *
 * A site is `<file>: import <specifier>` or `<file>: global <name>`, deduped per file, so an
 * allowlist entry pins WHICH FILE may touch the network and by WHAT MEANS, and a refactor that
 * moves egress into a new file fails here regardless of how the request is spelled.
 */
const NETWORK_MODULES = new Set([
  "http", "https", "http2", "net", "tls", "dgram",
  "node:http", "node:https", "node:http2", "node:net", "node:tls", "node:dgram",
  "undici", "axios", "node-fetch", "got", "superagent", "request", "needle", "phin", "ws",
  // A shell is a network client the moment it can run curl; `node:child_process` was not in the
  // old list at all, which is how `execFile("curl", ["-XPOST", ...])` walked straight through.
  "child_process", "node:child_process",
]);
const NETWORK_GLOBAL_RE = /(?<![\w$])fetch\b(?!\s*:)|new\s+(?:WebSocket|XMLHttpRequest|EventSource)\s*\(|\bsendBeacon\s*\(/g;

/**
 * The sites that may exist, with the reason each is not a write path. Keys are `<file>: <site>`
 * relative to `src/`.
 */
const ALLOWED_NETWORK_SITES = new Map<string, string>([
  ["bridge/unity-client.ts: import ws", "the Unity bridge transport; localhost only, not the catalog"],
  ["bridge/unity-client.ts: global WebSocket", "the Unity bridge transport"],
  ["bridge/spike-ws-client.ts: import ws", "manual bridge spike harness"],
  ["bridge/spike-ws-client.ts: global WebSocket", "manual bridge spike harness"],
  ["capabilities/assets/catalog-source.ts: global fetch", "READ-ONLY catalog client; GET only"],
  ["capabilities/assets/browser-payload.ts: global fetch", "preview image download; GET only"],
  ["capabilities/assets/providers/http-provider.ts: global fetch", "asset byte download; GET only"],
  ["capabilities/assets/providers/http-provider.ts: import node:net", "net.isIP() in the SSRF host guard"],
  ["bridge/editor-discovery.ts: import node:child_process", "runs the local Unity Hub/editor discovery"],
  ["shared/diagnostics.ts: import node:child_process", "local diagnostics commands"],
  ["shared/child-stdio.ts: import node:child_process", "types only; stdio plumbing helper"],
  ["capabilities/setup/cli-self-update.ts: import node:child_process", "runs the local package manager"],
  ["capabilities/tests/tests.ts: import node:child_process", "runs the local Unity test runner"],
  ["capabilities/minigame/minigame-run.ts: import node:child_process", "re-invokes this CLI locally"],
  ["capabilities/minigame/minigame-scene-entry.ts: import node:child_process", "re-invokes this CLI locally"],
  ["capabilities/feel/runtime-guard.ts: import node:child_process", "runs local git"],
]);

/**
 * PRONG B: no non-GET HTTP verb may be SPELLED anywhere in `src/`.
 *
 * Whole-package, and restricted to a string literal whose ENTIRE content is a write verb, which is
 * why it can be whole-package: there are zero such literals today, so it is a bright line rather
 * than a noisy heuristic. `-XPOST` and `--request` are matched separately because curl spells the
 * verb inside an argv token, which the old `\b(post)\b` scan missed entirely.
 */
const WRITE_VERB_LITERAL_RE = /(["'`])\s*(post|put|patch|delete)\s*\1/gi;
const CURL_VERB_RE = /-X\s*["'`]?\s*(?:POST|PUT|PATCH|DELETE)|--request\b/i;
const NETWORK_TOOL_RE = /(["'`])(curl|wget|nc|netcat|ncat|socat|aria2c|xh|httpie|powershell|Invoke-WebRequest)\1/i;

/**
 * PRONG C: no request `method` field anywhere the assets code can REACH.
 *
 * Scope is the transitive import closure of `capabilities/assets/**` over RELATIVE specifiers, not
 * the directory: `shared/` is where the reviewer put `method: "POST"` to defeat the directory
 * scan, and `shared/` is in the closure. Exactly one non-HTTP `method` field exists in the closure
 * and is allowlisted BY ITS TEXT, so any other is a finding by construction.
 */
const METHOD_KEY_RE = /\bmethod\s*[:=]|\[\s*["'`]method["'`]\s*\]/;
const ALLOWED_METHOD_LINES = new Set([
  "capabilities/assets/types.ts:method: AssetIngestProvenanceMethod;",
]);

/**
 * PRONG D: `capabilities/assets/**` may not read `process.env` off-allowlist.
 *
 * The reviewer's subtlest survivor was `JSON.parse(process.env.X)` spread into a fetch init: no
 * verb literal, no `method` key, just an attacker-supplied object handed to an allowlisted call
 * site. Environment reads in the catalog client are security-relevant input, so they are named.
 */
const ALLOWED_ENV_LINES = new Set([
  "catalog-source.ts:export function optionalCatalogUrlFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {",
  "catalog-source.ts:export function catalogUrlFromEnv(env: NodeJS.ProcessEnv = process.env): string {",
  "http-auth.ts:function githubTokenFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {",
]);

/** Files reachable from `capabilities/assets/**` by following relative specifiers. */
export function assetsImportClosure(srcRoot: string, readFile: ReadFile = readFromDisk): string[] {
  const seen = new Set(filesUnder(path.join(srcRoot, "capabilities", "assets"), CODE_EXTS));
  const queue = [...seen];
  while (queue.length > 0) {
    const file = queue.pop()!;
    for (const spec of specifiersIn(blankComments(readFile(file)))) {
      if (!spec.startsWith(".")) continue;
      const target = resolveRelative(file, spec);
      if (target && !seen.has(target)) {
        seen.add(target);
        queue.push(target);
      }
    }
  }
  return [...seen].sort();
}

export interface EgressReport {
  /** Findings, most specific first. */
  findings: string[];
  /** Allowlist keys that matched nothing: a stale allowlist is a vacuous guard. */
  unusedAllowlistEntries: string[];
  /** How many files the whole-package prongs walked. */
  filesScanned: number;
  /** How many files the closure prongs walked. */
  closureSize: number;
}

export function egressReport(srcRoot: string, readFile: ReadFile = readFromDisk): EgressReport {
  const findings: string[] = [];
  const used = new Set<string>();
  const all = filesUnder(srcRoot, CODE_EXTS);

  // Prongs A + B: whole package.
  for (const abs of all) {
    const rel = relative(srcRoot, abs);
    const lexed = lexSource(readFile(abs));
    const code = lexed.code;
    const codeNoStrings = lexed.bare;
    if (!lexed.terminated) {
      // The lexer lost track, so everything after that point is blanked and this file's egress
      // sites are INVISIBLE. That is exactly the silent-blindness failure this suite exists to
      // prevent, so it is a finding rather than a shrug.
      findings.push(`${rel}: source lexer did not terminate; the egress scan for this file is BLIND`);
    }

    const sites = new Set<string>();
    for (const spec of specifiersIn(code)) {
      if (NETWORK_MODULES.has(spec)) sites.add(`import ${spec}`);
    }
    for (const m of codeNoStrings.matchAll(NETWORK_GLOBAL_RE)) {
      const token = m[0].startsWith("new") ? m[0].replace(/^new\s+/, "").replace(/\s*\($/, "") : m[0].trim();
      sites.add(`global ${token.replace(/\s*\($/, "")}`);
    }
    for (const site of [...sites].sort()) {
      const key = `${rel}: ${site}`;
      if (ALLOWED_NETWORK_SITES.has(key)) used.add(key);
      else findings.push(`network egress site not on the allowlist -> ${key}`);
    }

    code.split("\n").forEach((line, index) => {
      const where = `${rel}:${index + 1}`;
      for (const m of line.matchAll(WRITE_VERB_LITERAL_RE)) {
        findings.push(`${where}: write verb literal ${m[0]} in ${line.trim()}`);
      }
      if (CURL_VERB_RE.test(line)) findings.push(`${where}: shell write verb in ${line.trim()}`);
      if (NETWORK_TOOL_RE.test(line)) findings.push(`${where}: network CLI tool in ${line.trim()}`);
    });
  }

  // Prongs C + D: the assets import closure, and `capabilities/assets/**` itself.
  const closure = assetsImportClosure(srcRoot, readFile);
  for (const abs of closure) {
    const rel = relative(srcRoot, abs);
    blankComments(readFile(abs)).split("\n").forEach((line, index) => {
      if (METHOD_KEY_RE.test(line) && !ALLOWED_METHOD_LINES.has(`${rel}:${line.trim()}`)) {
        findings.push(`${rel}:${index + 1}: request method field in ${line.trim()}`);
      }
    });
  }
  for (const abs of filesUnder(path.join(srcRoot, "capabilities", "assets"), CODE_EXTS)) {
    const rel = relative(path.join(srcRoot, "capabilities", "assets"), abs);
    blankComments(readFile(abs)).split("\n").forEach((line, index) => {
      if (/process\s*\.\s*env/.test(line) && !ALLOWED_ENV_LINES.has(`${rel}:${line.trim()}`)) {
        findings.push(`capabilities/assets/${rel}:${index + 1}: process.env read in ${line.trim()}`);
      }
    });
  }

  return {
    findings: findings.sort(),
    unusedAllowlistEntries: [...ALLOWED_NETWORK_SITES.keys()].filter((key) => !used.has(key)).sort(),
    filesScanned: all.length,
    closureSize: closure.length,
  };
}

test("asset boundary: network egress is exactly the allowlist, and read-only", () => {
  const report = egressReport(SRC);
  // Non-vacuity first: a scanner that walked nothing reports nothing.
  assert.ok(report.filesScanned > 200, `whole-package scan looks vacuous: ${report.filesScanned} files`);
  assert.ok(report.closureSize > 100, `assets import closure looks vacuous: ${report.closureSize} files`);
  assert.deepEqual(
    report.unusedAllowlistEntries,
    [],
    "an allowlisted network site no longer exists. A stale allowlist is a guard that stopped " +
      `describing this package:\n  ${report.unusedAllowlistEntries.join("\n  ")}`,
  );
  assert.deepEqual(
    report.findings,
    [],
    "the open build's catalog client is read-only; a write path must not appear unnoticed:\n  " +
      report.findings.join("\n  "),
  );
});

/** Plant `source` at `<rel>` under `src/` and report what the egress scan says. */
function egressWith(rel: string, source: string): string[] {
  const planted = path.join(SRC, rel);
  assert.ok(fs.existsSync(planted), `${rel} must exist for the plant to be realistic`);
  return egressReport(SRC, (p) => (p === planted ? source : readFromDisk(p))).findings;
}

test("asset boundary LITMUS: the reviewer's `catalog-push` attacks are all reported", () => {
  // Every one of these was CONFIRMED to leave the previous guard 130/130 green.
  const attacks: Array<[string, string, string, RegExp]> = [
    [
      "method key moved one directory up into shared/",
      "shared/cli-ui.ts",
      `export const WRITE_INIT = { method: "POST" };\n`,
      /shared\/cli-ui\.ts:1: (request method field|write verb literal)/,
    ],
    [
      "method key in shared/, verb supplied elsewhere",
      "shared/cli-ui.ts",
      `export const WRITE_INIT = { method: verb };\n`,
      /shared\/cli-ui\.ts:1: request method field/,
    ],
    [
      "curl shell-out from capabilities/assets",
      "capabilities/assets/catalog.ts",
      `import { execFile } from "node:child_process";\nexecFile("curl", ["-XPOST", url]);\n`,
      /network egress site not on the allowlist -> capabilities\/assets\/catalog\.ts: import node:child_process/,
    ],
    [
      "fragment-assembled verb",
      "capabilities/assets/catalog.ts",
      `const verb = ["P","O","S","T"].join("");\nawait send(url, { method: verb });\n`,
      /capabilities\/assets\/catalog\.ts:2: request method field/,
    ],
    [
      "env-supplied request init",
      "capabilities/assets/catalog.ts",
      `const init = JSON.parse(process.env.LB_INIT ?? "{}");\n`,
      /capabilities\/assets\/catalog\.ts:1: process\.env read/,
    ],
    [
      "a brand-new network client anywhere in src/",
      "shared/cli-ui.ts",
      `import https from "node:https";\n`,
      /network egress site not on the allowlist -> shared\/cli-ui\.ts: import node:https/,
    ],
    [
      "a bare verb constant",
      "domain/state.ts",
      `const WRITE = "PUT";\n`,
      /domain\/state\.ts:1: write verb literal/,
    ],
    [
      "an undici client in a capability that never had one",
      "capabilities/genre/genre.ts",
      `import { request } from "undici";\n`,
      /network egress site not on the allowlist -> capabilities\/genre\/genre\.ts: import undici/,
    ],
  ];

  for (const [label, rel, source, expected] of attacks) {
    const findings = egressWith(rel, source);
    assert.ok(
      findings.some((finding) => expected.test(finding)),
      `${label}: expected ${expected}, got:\n  ${findings.join("\n  ")}`,
    );
  }
});

test("asset boundary LITMUS: the egress scan does not fire on read-only code it must tolerate", () => {
  const benign: Array<[string, string, string]> = [
    ["delete operator", "capabilities/assets/catalog.ts", `delete record.tags;\ndelete record["pack"];`],
    ["GET fetch", "capabilities/assets/catalog.ts", `await send(url, fetchAuthOptionsForUrl(url, token));`],
    ["prose about POST", "capabilities/assets/catalog.ts", `// never POST here\n/* no PUT, no PATCH */\nconst x = 1;`],
    ["output identifier", "capabilities/assets/catalog.ts", `const outputPath = parsed.output;`],
    ["error text naming the transport", "shared/cli-ui.ts", `const re = /WebSocket is not open/;\nconst m = "Catalog fetch failed";`],
    ["a Map delete", "domain/state.ts", `pending.delete(id);`],
  ];
  for (const [label, rel, source] of benign) {
    assert.deepEqual(egressWith(rel, source), [], `${label} must not fire`);
  }
});

test("asset boundary LITMUS: the lexer does not go blind on the shapes that blinded it", () => {
  // Each of these silently blanked the REST OF THE FILE in an earlier version of this scanner,
  // which is a guard reporting green because it stopped looking.
  const shapes: Record<string, string> = {
    "regex with an odd number of apostrophes":
      "const re = /Cannot find module '[^']*x\\.js'/;\nawait fetch(url);\n",
    "a string containing a double slash": `const rel = target.startsWith("//");\nawait fetch(url);\n`,
    "a nested template inside an interpolation":
      "const m = `a ${ids.map((d) => `\\`${d}\\``).join(\", \")} b`;\nawait fetch(url);\n",
    "a division that is not a regex": "const half = total / 2;\nawait fetch(url);\n",
  };
  for (const [label, source] of Object.entries(shapes)) {
    const lexed = lexSource(source);
    assert.ok(lexed.terminated, `${label}: the lexer must terminate`);
    assert.equal(lexed.code.length, source.length, `${label}: offsets must be preserved`);
    assert.match(lexed.bare, /(?<![\w$])fetch\b/, `${label}: code AFTER the shape must stay visible`);
  }
  // And the self-check must FIRE on genuinely unterminated source, rather than pass quietly.
  assert.equal(lexSource("const s = \"never closed\n").terminated, false);
});

test("asset boundary LITMUS: a blinded file is a finding, not a silent pass", () => {
  const findings = egressWith("shared/cli-ui.ts", `const s = "never closed;\n`);
  assert.ok(
    findings.some((f) => /shared\/cli-ui\.ts: source lexer did not terminate/.test(f)),
    `expected a blind-scan finding, got:\n  ${findings.join("\n  ")}`,
  );
});

test("asset boundary LITMUS: a stale network allowlist entry is reported", () => {
  // Prove the non-vacuity assertion is load-bearing: an entry that matches no real file must be
  // reported, or the allowlist could quietly describe a package that no longer exists.
  const report = egressReport(SRC, (p) =>
    p === path.join(SRC, "bridge", "unity-client.ts") ? "export const nothing = 1;\n" : readFromDisk(p));
  assert.ok(
    report.unusedAllowlistEntries.includes("bridge/unity-client.ts: import ws"),
    `expected the stale entry to be reported, got: ${report.unusedAllowlistEntries.join(", ")}`,
  );
});

// ---------------------------------------------------------------------------------------------
// 5. No hardcoded catalog endpoint
// ---------------------------------------------------------------------------------------------

const URL_RE = /https?:\/\/[^\s"'`)\\<>]+/g;
/**
 * Absolute URLs allowed to appear in `src/`. This is an ALLOWLIST on purpose: a denylist of
 * known-bad hosts goes stale the day the catalog moves, whereas any NEW absolute URL added to
 * source has to be justified here first. None of these is an endpoint the tool calls with data:
 * they are schema `$id`s, a licence URL, doc pointers, and the report renderer's font hosts.
 *
 * `https://github.com/Loomtide/` used to be here as a WHOLE-ORG prefix, which permitted the exact
 * default this guard exists to prevent: the historical bad default WAS a GitHub mirror repo that
 * is not public, and a live fallback of that shape passed both halves of the guard. NO GitHub
 * mirror prefix is allowlisted any more, so any such URL is now a finding by construction.
 *
 * The provenance BROWSE link a compact catalog record falls back to is the human asset store's
 * ROOT (`ASSET_STORE_URL` in `capabilities/assets/catalog.ts`): an HTML page a person opens, never
 * a fetchable catalog. The load-bearing half of this property is behavioural and lives at the
 * bottom of this file: the real resolver must refuse with nothing configured.
 */
const ALLOWED_URL_PREFIXES = [
  "http://json-schema.org/",
  "https://json-schema.org/",
  "https://loombridge.dev/schemas/",
  "https://creativecommons.org/",
  "https://github.com/Loomtide/loombridge/blob/",
  "https://fonts.googleapis.com",
  "https://fonts.gstatic.com",
];
/**
 * Allowed WHOLE, not as a prefix. The asset store's root is a browse link; every path UNDER it is
 * an API shape (`/v1/assets/search`), so admitting it as a prefix would allowlist the very thing
 * this guard exists to refuse: a baked-in catalog endpoint. Exact match keeps the browse link and
 * refuses the endpoint. The LITMUS below plants a deep store path and requires it to be reported.
 */
const ALLOWED_EXACT_URLS = new Set(["https://assetstore.loomtide.ai/"]);
/**
 * Deployment hostnames, refused even if some future edit allowlists one. Endpoints are
 * CONFIGURATION, named by env var or flag; baking one in couples the OSS product to one
 * company's infrastructure and leaks where that infrastructure lives.
 */
const DEPLOYMENT_HOST_RE =
  /\/\/[^/\s]*\.(?:railway\.app|vercel\.app|fly\.dev|onrender\.com|herokuapp\.com|workers\.dev|netlify\.app|ngrok\.io|ngrok-free\.app|cloudflarestorage\.com|amazonaws\.com|azurewebsites\.net|appspot\.com|a\.run\.app|deno\.dev|pages\.dev|supabase\.co)(?=[:/]|$)/i;

export function hardcodedEndpointFindings(srcRoot: string, readFile: ReadFile = readFromDisk): string[] {
  const findings: string[] = [];
  const files = filesUnder(srcRoot, [".ts", ".mts", ".cts", ".js", ".mjs", ".cjs", ".json"]);
  assert.ok(files.length > 200, `endpoint scan looks vacuous: ${files.length} files`);
  for (const abs of files) {
    const rel = relative(srcRoot, abs);
    for (const m of readFile(abs).matchAll(URL_RE)) {
      const url = m[0];
      if (DEPLOYMENT_HOST_RE.test(url)) {
        findings.push(`${rel}: deployment host ${url}`);
      } else if (
        !ALLOWED_EXACT_URLS.has(url) &&
        !ALLOWED_URL_PREFIXES.some((prefix) => url.startsWith(prefix))
      ) {
        findings.push(`${rel}: unallowlisted URL ${url}`);
      }
    }
  }
  return findings.sort();
}

test("asset boundary: no source file hardcodes a catalog endpoint", () => {
  const findings = hardcodedEndpointFindings(SRC);
  assert.deepEqual(
    findings,
    [],
    `endpoints are configuration, never a source default:\n  ${findings.join("\n  ")}`,
  );
});

test("asset boundary LITMUS: a hardcoded endpoint is reported", () => {
  const planted = path.join(SRC, "capabilities", "assets", "catalog-source.ts");
  // Assembled from parts so the guard's own fixture never puts a deployment hostname in the tree.
  const shapes: Record<string, string> = {
    "deployment default": `const D = "https://${["asset-api", "example", "up", "railway", "app"].join(".")}/v1/assets";`,
    "serverless deployment": `const D = "https://${["catalog", "example", "a", "run", "app"].join(".")}/v1";`,
    "unallowlisted host": `const D = "https://catalog.example.com/v1/assets";`,
    "non-public GitHub mirror": `const D = "https://github.com/example-org/private-asset-mirror/raw/main/catalog";`,
    "brand catalog host": `const D = "https://${["catalog", "loomtide", "ai"].join(".")}/v1/catalog/public/x";`,
    // The asset store ROOT is allowlisted as a browse link. A PATH under it is an endpoint, and
    // must still be reported: this is what makes `ALLOWED_EXACT_URLS` non-vacuous, and it is the
    // cheapest way to turn a browse link back into a baked-in deployment.
    "deep path under the asset store": `const D = "https://${["assetstore", "loomtide", "ai"].join(".")}/v1/assets/search";`,
  };
  for (const [shape, source] of Object.entries(shapes)) {
    const findings = hardcodedEndpointFindings(SRC, (p) => (p === planted ? source : readFromDisk(p)));
    assert.equal(findings.length, 1, `${shape}: expected exactly the planted endpoint, got ${findings.join(", ")}`);
    assert.match(findings[0]!, /^capabilities\/assets\/catalog-source\.ts: /, shape);
  }
});

/**
 * The BEHAVIOURAL half, bound to the real verb rather than to a helper.
 *
 * The previous behavioural assertion tested `catalogUrlFromEnv` directly, which at the time had
 * ZERO production callers: it could not have caught a live fallback added inside
 * `loadRegistryOrCatalog`, which is precisely the attack that landed. These drive
 * `assets registry-plan` and assert (a) with nothing configured it refuses BY NAME and never
 * touches the network, and (b) the env var is what configures it.
 */
async function withTempProject<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "loombridge-catalog-"));
  try {
    return await fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("asset boundary: with nothing configured the REAL resolver refuses by name and never reaches the network", async () => {
  await withTempProject(async (root) => {
    const calls: string[] = [];
    await assert.rejects(
      () => loadRegistryOrCatalog({ root }, "platformer-2d", {
        env: {},
        catalogFetch: async (url: string) => {
          calls.push(url);
          throw new Error("the tool must not reach the network with nothing configured");
        },
      }),
      (error: Error) => error.message.includes(ASSET_CATALOG_URL_ENV_VAR),
      `the resolver must refuse by naming ${ASSET_CATALOG_URL_ENV_VAR}, never fall back to a host`,
    );
    assert.deepEqual(calls, [], `no network call may be made; got ${calls.join(", ")}`);
  });
});

test("asset boundary: the env var is WIRED into the real resolver, so its promise is true", async () => {
  await withTempProject(async (root) => {
    const catalog = path.join(root, "catalog.json");
    fs.writeFileSync(catalog, JSON.stringify({ assets: [] }), "utf-8");
    const calls: string[] = [];
    const pack = await loadRegistryOrCatalog({ root }, "platformer-2d", {
      env: { [ASSET_CATALOG_URL_ENV_VAR]: catalog },
      catalogFetch: async (url: string) => {
        calls.push(url);
        throw new Error("a local catalog path must not be fetched over the network");
      },
    });
    assert.deepEqual(pack.entries, [], "the env-configured catalog must be the source that was read");
    assert.deepEqual(calls, [], "a local path must not be fetched");
  });
});

test("asset boundary: an unset catalog URL still refuses by name at the helper", () => {
  assert.throws(
    () => catalogUrlFromEnv({}),
    (error: Error) => error.message.includes(ASSET_CATALOG_URL_ENV_VAR),
    "an unset catalog URL must refuse by name, never resolve to a built-in host",
  );
  assert.equal(
    catalogUrlFromEnv({ [ASSET_CATALOG_URL_ENV_VAR]: "https://catalog.example.com" }),
    "https://catalog.example.com",
  );
});
