import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CLI_DIST, PKG_ROOT } from "../../_support/paths.js";
import { ASSET_CATALOG_URL_ENV_VAR, catalogUrlFromEnv } from "../../../capabilities/assets/catalog-source.js";

/**
 * The hosted asset registry is READ-ONLY from this open build, and every property that makes
 * that true is currently true by accident: nothing walks any of them.
 *
 * That is this repo's most expensive recurring failure shape (a declared path nothing walks),
 * except here it guards a SECURITY boundary rather than a report. Nothing fails today if someone
 * vendors the private authoring module, converts the seam to a literal import, adds a POST to the
 * catalog client, or bakes a deployment endpoint into a source default. Each of those is a way an
 * OSS consumer, or a consumer's agent, gains write access to infrastructure they should only ever
 * read. See `Docs/Design/AssetRegistryOssBoundary.md`.
 *
 * Five properties are guarded, each with a LITMUS proving the detector fires on the broken input:
 *
 *   1. the private authoring sources are absent from this repo;
 *   2. the authoring seam is not a resolvable literal import, so no bundler, `tsc`, or dependency
 *      walker can follow an edge into the private side;
 *   3. the authoring verbs refuse, proven by driving the REAL built CLI, not a mock;
 *   4. no non-GET HTTP method appears anywhere in `capabilities/assets/`;
 *   5. no source file hardcodes a catalog endpoint; the env var or an explicit flag stays the
 *      only way to name one.
 */

const SRC = path.join(PKG_ROOT, "src");
const ASSETS_SRC = path.join(SRC, "capabilities", "assets");
/** The seam constant lives here; the guards read the specifier out rather than duplicating it. */
const SEAM_HOST = path.join(ASSETS_SRC, "assets.ts");
/** Where the seam specifier is resolved FROM, in both `src/` and `dist/`. */
const SEAM_HOST_DIR_PARTS = ["capabilities", "assets"];

// ---------------------------------------------------------------------------------------------
// Shared scanning helpers
// ---------------------------------------------------------------------------------------------

/**
 * Blank out comments while PRESERVING every byte offset and line break, so a specifier or an HTTP
 * verb quoted in prose is not read as code while reported line numbers still point at the source.
 * (`layering.test.ts` strips comments outright; it does not report positions, this does.)
 *
 * Limit: this is lexical, not a parser. A `/*` or `//` inside a string literal confuses it. The
 * `[^:]` guard in front of `//` is what keeps `https://` inside a string from being eaten.
 */
export function blankComments(source: string): string {
  const blank = (text: string): string => text.replace(/[^\n]/g, " ");
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => blank(m))
    .replace(/(^|[^:])(\/\/[^\n]*)/g, (_m, lead: string, comment: string) => lead + blank(comment));
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

function filesUnder(dir: string, extensions: string[], acc: string[] = []): string[] {
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

// ---------------------------------------------------------------------------------------------
// 1 + 2. The authoring seam
// ---------------------------------------------------------------------------------------------

export interface SeamDeclaration {
  /** The module specifier handed to the dynamic `import()`. */
  specifier: string;
  /** The declared type annotation, or "" when TypeScript is left to infer one. */
  annotation: string;
}

/**
 * Read the seam declaration out of the source. Returning null (rather than throwing) lets the
 * tests fail with "the seam moved or was renamed" instead of silently passing on a tree where
 * this guard no longer has anything to check.
 */
export function readSeamDeclaration(text: string): SeamDeclaration | null {
  const m = /const\s+ASSET_AUTHORING_CLI_MODULE\s*(?::\s*([^=]+?))?\s*=\s*["'`]([^"'`]+)["'`]/
    .exec(blankComments(text));
  if (!m) return null;
  return { specifier: m[2]!, annotation: (m[1] ?? "").trim() };
}

/** Absolute directories that must NOT exist in an open build, derived from the seam specifier. */
function privateAuthoringDirs(srcRoot: string, specifier: string): string[] {
  const resolved = path.dirname(path.resolve(path.join(srcRoot, ...SEAM_HOST_DIR_PARTS), specifier));
  // The specifier's own target, plus the location the RFC and the historical comment name. Both
  // are checked so the guard does not depend on which of the two the private side actually uses.
  return [...new Set([resolved, path.join(srcRoot, "asset-authoring")])];
}

export function presentAuthoringDirs(srcRoot: string, specifier: string): string[] {
  return privateAuthoringDirs(srcRoot, specifier)
    .filter((dir) => fs.existsSync(dir))
    .map((dir) => relative(srcRoot, dir))
    .sort();
}

/**
 * Every LITERAL module specifier in `src/` that names the private authoring tree, in any import
 * shape. This is the property that makes the seam safe: not "the constant is spelled a certain
 * way", but "no tool that resolves specifiers can see an edge into the private side", because
 * there is no literal for `tsc`, a bundler, or a dependency walker to read. A dynamic
 * `import(IDENT)` is opaque to all three; `import("../asset-authoring/...")` is not.
 */
export function literalAuthoringImports(
  srcRoot: string,
  specifier: string,
  readFile: ReadFile = readFromDisk,
): string[] {
  const privateDirs = privateAuthoringDirs(srcRoot, specifier);
  const findings: string[] = [];
  for (const abs of filesUnder(srcRoot, [".ts"])) {
    const rel = relative(srcRoot, abs);
    for (const spec of specifiersIn(blankComments(readFile(abs)))) {
      if (spec.startsWith(".")) {
        const target = path.resolve(path.dirname(abs), spec);
        if (privateDirs.some((dir) => target === dir || target.startsWith(dir + path.sep))) {
          findings.push(`${rel}: ${spec}`);
        }
      } else if (spec.includes("asset-authoring")) {
        findings.push(`${rel}: ${spec}`);
      }
    }
  }
  return findings.sort();
}

test("asset boundary: the seam declaration is still where the guards look", () => {
  const seam = readSeamDeclaration(readFromDisk(SEAM_HOST));
  assert.ok(seam, "ASSET_AUTHORING_CLI_MODULE not found in capabilities/assets/assets.ts");
  assert.ok(seam.specifier.length > 0);
});

test("asset boundary: the private authoring sources are absent from this repo", () => {
  const seam = readSeamDeclaration(readFromDisk(SEAM_HOST))!;
  assert.deepEqual(
    presentAuthoringDirs(SRC, seam.specifier),
    [],
    "the private asset-authoring sources must never be vendored into the open repo",
  );
});

test("asset boundary LITMUS: a vendored private directory is reported", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "loombridge-seam-"));
  try {
    const seam = readSeamDeclaration(readFromDisk(SEAM_HOST))!;
    for (const dir of privateAuthoringDirs(root, seam.specifier)) fs.mkdirSync(dir, { recursive: true });
    const present = presentAuthoringDirs(root, seam.specifier);
    assert.equal(present.length, 2, `both candidate locations must be reported, got ${present.join(", ")}`);
    assert.ok(present.includes("asset-authoring"));
    assert.ok(present.some((rel) => rel.endsWith("/asset-authoring")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("asset boundary: the seam is not a resolvable literal import anywhere in src/", () => {
  const seam = readSeamDeclaration(readFromDisk(SEAM_HOST))!;
  assert.deepEqual(
    literalAuthoringImports(SRC, seam.specifier),
    [],
    "a literal specifier naming the private tree lets tsc, a bundler, or a dependency walker " +
      "follow an edge into it. The seam must stay a dynamic import of a string-typed constant",
  );
});

test("asset boundary LITMUS: every literal import shape into the private tree is reported", () => {
  const seam = readSeamDeclaration(readFromDisk(SEAM_HOST))!;
  const planted = SEAM_HOST;
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
    const findings = literalAuthoringImports(SRC, seam.specifier, (p) =>
      p === planted ? source : readFromDisk(p),
    );
    assert.equal(findings.length, 1, `${shape}: expected exactly the planted literal import`);
    assert.match(findings[0]!, /assets\.ts: \.\.\/asset-authoring\//, shape);
  }
});

test("asset boundary LITMUS: a specifier MENTIONED in a comment is documentation, not an edge", () => {
  const seam = readSeamDeclaration(readFromDisk(SEAM_HOST))!;
  const target = `${".."}/asset-authoring/assets-authoring-cli.js`;
  for (const commentary of [`// see import("${target}")`, `/** was: from "${target}" */`]) {
    assert.deepEqual(
      literalAuthoringImports(SRC, seam.specifier, (p) => (p === SEAM_HOST ? commentary : readFromDisk(p))),
      [],
      `a commented specifier must not fire: ${commentary}`,
    );
  }
});

/**
 * The `: string` annotation is the second half of the property. Without it TypeScript infers the
 * LITERAL type, and a literal-typed constant is exactly the shape a bundler or dependency walker
 * constant-folds back into a static edge into the private tree.
 *
 * This one is guarded because nothing else notices: removing the annotation was measured NOT to
 * fail `tsc --noEmit`, so the whole open/private split would keep compiling green while quietly
 * becoming foldable. The assertion is therefore on the declared TYPE being the widened `string`,
 * not on the constant's value or its spelling.
 */
test("asset boundary: the seam specifier is widened to `string`, not a literal type", () => {
  const seam = readSeamDeclaration(readFromDisk(SEAM_HOST))!;
  assert.equal(
    seam.annotation,
    "string",
    "ASSET_AUTHORING_CLI_MODULE must carry an explicit `: string` annotation; an inferred or " +
      "literal type makes the dynamic import statically resolvable again",
  );
});

test("asset boundary LITMUS: an un-widened seam declaration is reported", () => {
  const inferred = readSeamDeclaration(`const ASSET_AUTHORING_CLI_MODULE = "../asset-authoring/x.js";`);
  assert.equal(inferred?.annotation, "", "an inferred literal type must not read as widened");
  const literalType = readSeamDeclaration(
    `const ASSET_AUTHORING_CLI_MODULE: "../asset-authoring/x.js" = "../asset-authoring/x.js";`,
  );
  assert.notEqual(literalType?.annotation, "string", "an explicit literal type must not read as widened");
  assert.equal(
    readSeamDeclaration(`const ASSET_AUTHORING_CLI_MODULE: string = "../a/b.js";`)?.annotation,
    "string",
  );
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
 * LITMUS for both the refusal guard and the help gate, and the only one that plants executable
 * code: a stub authoring module makes the verbs succeed and the help block appear. If the
 * refusal assertions still pass with the private side "installed", they were never bound to it.
 *
 * The plant is under try/finally and removes only what it created, so a crashed run cannot leave
 * a stub module in `dist/` for the rest of the suite (or a later `loombridge assets pack-ingest`)
 * to pick up.
 */
test("asset boundary LITMUS: a planted authoring stub breaks the refusal and reveals the help", () => {
  const seam = readSeamDeclaration(readFromDisk(SEAM_HOST))!;
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
// 4. No non-GET HTTP method anywhere in capabilities/assets/
// ---------------------------------------------------------------------------------------------

/**
 * A naive grep for `method: "POST"` misses `method: verb`, a computed string, and a helper that
 * defaults elsewhere, so this is three independent prongs over the comment-blanked code:
 *
 *   A. VERB TOKENS. Any non-GET write verb spelled anywhere in the directory, in any case. This
 *      catches `method: "POST"`, `const verb = "PUT"` used indirectly, and `client.delete(url)`.
 *   B. `method` KEYS. Any `method` property or member, whatever its value. This catches the
 *      computed-verb case, where the verb string itself lives outside this directory. Exactly one
 *      non-HTTP `method` field exists here and is allowlisted BY ITS TEXT, so any other one is a
 *      finding by construction rather than by the detector's opinion.
 *   C. NETWORK MODULES. Any import of a module that can issue a request or open a socket without
 *      `fetch` (`node:https`, `node:net`, `undici`, `axios`, ...). Network egress here goes
 *      through the injected `CatalogFetch` seam or nothing. The one legitimate exception is
 *      allowlisted with its USED MEMBERS pinned, so the import cannot later grow a socket.
 *
 * LIMITS, stated the way this repo's other scanners state them:
 *   - It is textual, not type-aware. A verb assembled from fragments ("PO" + "ST"), read from an
 *     env var, or supplied by a `fetcher` implementation injected from OUTSIDE this directory is
 *     not visible to prong A. Prongs B and C are what narrow that gap, not close it.
 *   - Scope is `capabilities/assets/**` only. A write path added in another capability is out of
 *     this guard's remit and needs its own.
 *   - HEAD/OPTIONS/TRACE/CONNECT are not in the verb list: none is a write method, and `options`
 *     collides with a ubiquitous identifier here, which would make prong A vacuous through noise.
 *     Prong B still refuses them, since it refuses ANY method.
 *   - Comments are blanked, so prose about POST is fine and a verb hidden in a comment is inert.
 *   - Prong C's member pinning is per-binding text matching. Aliasing the allowlisted binding
 *     (`const s = net; s.connect(...)`) defeats it.
 */
const NON_GET_VERB_RE = /\b(post|put|patch|delete)\b/gi;
/**
 * The JS `delete` operator, which can only ever be applied to a member expression. Carved out by
 * FORM, so `client.delete(url)`, `"DELETE"` and `method: DELETE` all still fire.
 */
const DELETE_OPERATOR_RE = /(?<![\w.$])delete\s+[A-Za-z_$][\w$]*\s*[.[]/g;
const METHOD_KEY_RE = /\bmethod\s*[:=]/;
const NETWORK_MODULES = new Set([
  "http", "https", "http2", "net", "tls", "dgram",
  "node:http", "node:https", "node:http2", "node:net", "node:tls", "node:dgram",
  "undici", "axios", "node-fetch", "got", "superagent", "request", "needle", "phin",
]);
/**
 * `method` occurrences that are provably not an HTTP verb, keyed by `<file>:<trimmed line>` so a
 * change to the line re-opens the question. `AssetIngestProvenanceMethod` is
 * `"api" | "crawler" | "mirror-index"`: how a catalog record was DISCOVERED, never a request verb.
 */
const ALLOWED_METHOD_LINES = new Set([
  "types.ts:method: AssetIngestProvenanceMethod;",
]);
/**
 * Network-capable imports that are allowed, keyed by `<file>:<specifier>`, with the members that
 * may be used off the binding PINNED. `node:net` is imported by the download provider only for
 * `net.isIP()`, a pure string classifier in its SSRF host guard; every other member of `net`
 * opens a socket, so pinning the members is what stops the allowlist entry becoming a hole.
 */
const ALLOWED_NETWORK_IMPORTS = new Map<string, { binding: string; members: Set<string> }>([
  ["providers/http-provider.ts:node:net", { binding: "net", members: new Set(["isIP"]) }],
]);

export function nonGetHttpFindings(dir: string, readFile: ReadFile = readFromDisk): string[] {
  const findings: string[] = [];
  for (const abs of filesUnder(dir, [".ts"])) {
    const rel = relative(dir, abs);
    const code = blankComments(readFile(abs));

    code.split("\n").forEach((line, index) => {
      const where = `${rel}:${index + 1}`;
      const operatorSpans = [...line.matchAll(DELETE_OPERATOR_RE)].map((m) => [
        m.index!,
        m.index! + m[0].length,
      ] as const);
      for (const m of line.matchAll(NON_GET_VERB_RE)) {
        const inOperator = operatorSpans.some(([start, end]) => m.index! >= start && m.index! < end);
        if (!inOperator) findings.push(`${where}: non-GET verb "${m[0]}" in ${line.trim()}`);
      }
      if (METHOD_KEY_RE.test(line) && !ALLOWED_METHOD_LINES.has(`${rel}:${line.trim()}`)) {
        findings.push(`${where}: request method field in ${line.trim()}`);
      }
    });

    for (const spec of specifiersIn(code)) {
      if (!NETWORK_MODULES.has(spec)) continue;
      const allowed = ALLOWED_NETWORK_IMPORTS.get(`${rel}:${spec}`);
      if (!allowed) {
        findings.push(`${rel}: network-capable import "${spec}"`);
        continue;
      }
      const memberRe = new RegExp(`\\b${allowed.binding}\\s*\\.\\s*([A-Za-z_$][\\w$]*)`, "g");
      for (const m of code.matchAll(memberRe)) {
        if (!allowed.members.has(m[1]!)) {
          findings.push(`${rel}: "${spec}" used beyond its pinned members: ${allowed.binding}.${m[1]}`);
        }
      }
    }
  }
  return findings.sort();
}

test("asset boundary: no non-GET HTTP method anywhere in capabilities/assets/", () => {
  const findings = nonGetHttpFindings(ASSETS_SRC);
  assert.deepEqual(
    findings,
    [],
    "the open build's catalog client is read-only; a write path must not appear unnoticed:\n  " +
      findings.join("\n  "),
  );
});

test("asset boundary LITMUS: each write-path shape is reported", () => {
  const planted = path.join(ASSETS_SRC, "catalog-source.ts");
  const shapes: Record<string, string> = {
    "literal verb": `await fetch(url, { method: "POST", body });`,
    "lowercase verb": `await fetch(url, { method: "post" });`,
    "computed verb": `const verb = pickVerb(); await fetch(url, { method: verb });`,
    "client helper": `await client.delete(url);`,
    "verb constant": `const WRITE = "PUT";`,
    "network module": `import https from "node:https";`,
  };
  for (const [shape, source] of Object.entries(shapes)) {
    const findings = nonGetHttpFindings(ASSETS_SRC, (p) => (p === planted ? source : readFromDisk(p)));
    assert.ok(findings.length > 0, `${shape}: the detector must fire`);
    assert.ok(findings.every((f) => f.startsWith("catalog-source.ts")), `${shape}: ${findings.join(", ")}`);
  }
});

test("asset boundary LITMUS: an allowlisted network import cannot grow a socket", () => {
  // The allowlist entry exists so `net.isIP` (a pure classifier) does not trip prong C. If the
  // pinning were decorative, the same file could open a connection and stay green.
  const planted = path.join(ASSETS_SRC, "providers", "http-provider.ts");
  const source = `import net from "node:net";\nconst socket = net.connect(443, host);\n`;
  const findings = nonGetHttpFindings(ASSETS_SRC, (p) => (p === planted ? source : readFromDisk(p)));
  assert.ok(
    findings.some((f) => f.includes("pinned members") && f.includes("net.connect")),
    `expected a pinned-member finding, got: ${findings.join(", ")}`,
  );
});

test("asset boundary LITMUS: the detector does not fire on read-only code it must tolerate", () => {
  const planted = path.join(ASSETS_SRC, "catalog-source.ts");
  const benign: Record<string, string> = {
    "delete operator": `delete record.tags;\ndelete record["pack"];`,
    "GET fetch": `await fetch(url, fetchAuthOptionsForUrl(url, token));`,
    "prose about POST": `// never POST here\n/* no PUT, no PATCH */\nconst x = 1;`,
    "output identifier": `const outputPath = parsed.output;`,
  };
  for (const [shape, source] of Object.entries(benign)) {
    assert.deepEqual(
      nonGetHttpFindings(ASSETS_SRC, (p) => (p === planted ? source : readFromDisk(p))),
      [],
      `${shape} must not fire`,
    );
  }
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
 */
const ALLOWED_URL_PREFIXES = [
  "http://json-schema.org/",
  "https://json-schema.org/",
  "https://loombridge.dev/schemas/",
  "https://creativecommons.org/",
  "https://github.com/Loomtide/",
  "https://fonts.googleapis.com",
  "https://fonts.gstatic.com",
];
/**
 * Deployment hostnames, refused even if some future edit allowlists one. Endpoints are
 * CONFIGURATION, named by env var or flag; baking one in couples the OSS product to one
 * company's infrastructure and leaks where that infrastructure lives.
 */
const DEPLOYMENT_HOST_RE =
  /\/\/[^/\s]*\.(?:railway\.app|vercel\.app|fly\.dev|onrender\.com|herokuapp\.com|workers\.dev|netlify\.app|ngrok\.io|ngrok-free\.app|cloudflarestorage\.com|amazonaws\.com|azurewebsites\.net|appspot\.com)(?=[:/]|$)/i;

export function hardcodedEndpointFindings(srcRoot: string, readFile: ReadFile = readFromDisk): string[] {
  const findings: string[] = [];
  for (const abs of filesUnder(srcRoot, [".ts", ".js", ".mjs", ".json"])) {
    const rel = relative(srcRoot, abs);
    for (const m of readFile(abs).matchAll(URL_RE)) {
      const url = m[0];
      if (DEPLOYMENT_HOST_RE.test(url)) {
        findings.push(`${rel}: deployment host ${url}`);
      } else if (!ALLOWED_URL_PREFIXES.some((prefix) => url.startsWith(prefix))) {
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
  const host = ["asset-api", "example", "up", "railway", "app"].join(".");
  const shapes: Record<string, string> = {
    "deployment default": `const DEFAULT_CATALOG = "https://${host}/v1/assets";`,
    "unallowlisted host": `const DEFAULT_CATALOG = "https://catalog.example.com/v1/assets";`,
  };
  for (const [shape, source] of Object.entries(shapes)) {
    const findings = hardcodedEndpointFindings(SRC, (p) => (p === planted ? source : readFromDisk(p)));
    assert.equal(findings.length, 1, `${shape}: expected exactly the planted endpoint`);
    assert.match(findings[0]!, /^capabilities\/assets\/catalog-source\.ts: /, shape);
  }
});

/**
 * The behavioural half of the same property: with nothing configured the catalog resolver must
 * REFUSE by name rather than fall back to some default host. A guard on source text alone would
 * miss a default reintroduced through, say, a config file read at runtime.
 */
test("asset boundary: the catalog URL comes only from the env var or an explicit flag", () => {
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
