import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { REPO_ROOT } from "../../_support/paths.js";

/**
 * Asset-priority doc guard (`Docs/Design/AssetRegistryOssBoundary.md` §3 + §4).
 *
 * This file used to enforce the OPPOSITE stance: it asserted the docs named a specific PaaS
 * deployment hostname, and that the priority order read "hosted Loomtide registry FIRST".
 * Both claims are now wrong.
 *
 *   - `Docs/Design/Positioning.md` lists "no cloud requirement ... the hosted asset catalog is
 *     an optional, read-only convenience" as a PERMANENT non-goal. A doc set that mandates
 *     hosted-first makes that non-goal aspirational instead of true.
 *   - An endpoint is CONFIGURATION. Naming a deployment in public prose couples an Apache-2.0
 *     product to one company's infrastructure bill and leaks where that infrastructure lives.
 *
 * So the guard is inverted, not deleted, and it stays non-vacuous in BOTH directions:
 *
 *   1. no deployment hostname may reappear anywhere in the public doc/source surface;
 *   2. the priority language may not regress to mandating hosted-first;
 *   3. the docs must positively state the new stance (committed registry is the default, the
 *      hosted catalog is an optional accelerator) rather than merely omitting the old one.
 *
 * Every detector has a LITMUS that plants the broken input and requires the detector to fire,
 * plus (for the hostname scan) a negative control proving it does not swallow the brand-owned
 * product URL it must tolerate.
 */

const repoRoot = REPO_ROOT;

// Literal substring (NOT regex): compared with String.includes so dots are not wildcards.
// A brand-owned PRODUCT url, not a deployment detail: it may stay in the docs.
const HOSTED_STORE = "https://assetstore.loomtide.ai";

function read(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf-8");
}

/** Collapse every run of whitespace so a match window is not defeated by markdown wrapping. */
function flatten(text: string): string {
  return text.replace(/\s+/g, " ");
}

const PLAN = "commands/loombridge/plan.md";
const BUILD = "commands/loombridge/build.md";
const SKILL = ".skills/asset-layer/SKILL.md";
const DOC = "Docs/Assets/AssetPriority.md";

// ---------------------------------------------------------------------------------------------
// 1. No deployment hostname anywhere in the public surface
// ---------------------------------------------------------------------------------------------

/**
 * Ephemeral PaaS / preview-deployment host families. Object-storage hosts are deliberately NOT
 * in this list: a catalog record legitimately pins the public URL of an asset byte, and that is
 * data about an asset, not a Loombridge endpoint.
 *
 * The pattern is written with escaped slashes (`\/\/`) for the same reason `asset-registry-
 * boundary.test.ts` does: this file is itself inside the scanned tree, and a literal `//` here
 * would make the guard report itself.
 */
const DEPLOYMENT_HOST_RE =
  /\/\/[^/\s"'`]*\.(?:railway\.app|vercel\.app|fly\.dev|onrender\.com|herokuapp\.com|workers\.dev|netlify\.app|ngrok\.io|ngrok-free\.app|azurewebsites\.net|appspot\.com)(?=[:/\s"'`)\]]|$)/i;

/**
 * The public surface a reader (or a scraper) actually sees. Explicit roots rather than a whole
 * -repo walk, so the guard cannot be quietly hollowed out by a generated or vendored directory
 * appearing under an excluded name.
 */
const SCAN_ROOTS = [
  "README.md",
  "ARCHITECTURE.md",
  "AGENTS.md",
  "CONTRIBUTING.md",
  "mcp-server/README.md",
  "Docs",
  "commands",
  ".skills",
  "asset-layer/schemas",
  "packages",
  "mcp-server/src",
  "scripts",
];

const SCAN_EXTS = new Set([".md", ".ts", ".cs", ".json", ".mjs", ".sh", ".yml", ".yaml", ".txt"]);
const SCAN_SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  ".git",
  "agent-surface",
  "Library",
  "Temp",
  "Logs",
  "obj",
  "bin",
]);

function* walkFiles(absDir: string): Generator<string> {
  for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SCAN_SKIP_DIRS.has(entry.name)) continue;
      yield* walkFiles(path.join(absDir, entry.name));
    } else if (entry.isFile() && SCAN_EXTS.has(path.extname(entry.name))) {
      yield path.join(absDir, entry.name);
    }
  }
}

/** Every scannable file in the public surface, as repo-relative paths. */
export function publicSurfaceFiles(): string[] {
  const files: string[] = [];
  for (const root of SCAN_ROOTS) {
    const abs = path.join(repoRoot, root);
    if (!fs.existsSync(abs)) continue;
    if (fs.statSync(abs).isDirectory()) {
      for (const file of walkFiles(abs)) files.push(path.relative(repoRoot, file));
    } else {
      files.push(root);
    }
  }
  return files.sort();
}

/** Report `<file>:<line>` for every deployment hostname in the supplied texts. */
export function deploymentHostFindings(texts: Array<{ file: string; text: string }>): string[] {
  const findings: string[] = [];
  for (const { file, text } of texts) {
    text.split("\n").forEach((line, index) => {
      if (DEPLOYMENT_HOST_RE.test(line)) findings.push(`${file}:${index + 1}`);
    });
  }
  return findings;
}

test("no deployment hostname appears anywhere in the public doc/source surface", () => {
  const scanned = publicSurfaceFiles().map((file) => ({ file, text: read(file) }));
  assert.ok(scanned.length > 200, `scan looks vacuous: only ${scanned.length} files walked`);

  const findings = deploymentHostFindings(scanned);
  assert.deepEqual(
    findings,
    [],
    "endpoints are configuration, named by env var or flag, never baked into public prose or code:\n  " +
      findings.join("\n  "),
  );
});

test("LITMUS: the deployment-host scan reports a planted hostname", () => {
  // Assembled so this source file does not itself contain the literal host.
  const host = ["asset-api-production-59d9", "up", "railway", "app"].join(".");
  const planted = [
    { file: "fake/doc.md", text: `see the search API at https:${"//"}${host}/v1/assets/search\n` },
  ];
  assert.deepEqual(deploymentHostFindings(planted), ["fake/doc.md:1"]);
});

test("LITMUS: the deployment-host scan tolerates the brand-owned product URL", () => {
  // Negative control. An over-broad detector that flagged the asset store would push the docs
  // into naming nothing at all, which is a worse doc, not a safer one.
  const allowed = [
    { file: "fake/doc.md", text: `browse at ${HOSTED_STORE}/ and pick candidates\n` },
    { file: "fake/two.md", text: "assets download from https://assets.loomtide.ai/pack/a.png\n" },
  ];
  assert.deepEqual(deploymentHostFindings(allowed), []);
});

// ---------------------------------------------------------------------------------------------
// 2. The priority language may not regress to mandating hosted-first
// ---------------------------------------------------------------------------------------------

/**
 * Each pattern is a phrasing the docs ACTUALLY carried before this change, kept tight (short
 * match windows on whitespace-flattened text) so it fires on a mandate and not on prose that
 * merely mentions the hosted catalog and the word "default" in the same paragraph.
 */
const HOSTED_FIRST_PATTERNS: Array<[string, RegExp]> = [
  ["hosted ... FIRST", /hosted[\s\S]{0,30}\bFIRST\b/i],
  ["hosted registry first", /hosted\s+registry\s+first/i],
  ["hosted-first", /\bhosted-first\b/i],
  ["hosted ... is the default", /hosted[\s\S]{0,40}\bis\s+the\s+default\b/i],
  ["hosted ... the canonical source", /hosted[\s\S]{0,40}\bthe\s+canonical\s+source\b/i],
  ["default ... hosted registry", /\bdefault\b[\s\S]{0,20}hosted\s+(?:Loomtide\s+)?registry/i],
];

/** Report `<file>: <label>` for every hosted-first mandate found. */
export function hostedFirstMandateFindings(texts: Array<{ file: string; text: string }>): string[] {
  const findings: string[] = [];
  for (const { file, text } of texts) {
    const flat = flatten(text);
    for (const [label, pattern] of HOSTED_FIRST_PATTERNS) {
      if (pattern.test(flat)) findings.push(`${file}: ${label}`);
    }
  }
  return findings;
}

test("the asset-priority doc set never mandates hosted-first", () => {
  const texts = [DOC, PLAN, BUILD, SKILL, "ARCHITECTURE.md", "mcp-server/README.md", "README.md"]
    .map((file) => ({ file, text: read(file) }));
  const findings = hostedFirstMandateFindings(texts);
  assert.deepEqual(
    findings,
    [],
    "Positioning.md makes the hosted catalog an OPTIONAL, read-only convenience; " +
      `these docs mandate it as the default:\n  ${findings.join("\n  ")}`,
  );
});

test("LITMUS: the hosted-first detector fires on each historical mandate wording", () => {
  // Verbatim shapes this repo shipped before the demotion.
  const regressions = [
    "1. **Hosted Loomtide registry (FIRST, the default).**",
    "## Asset priority - hosted registry first (canonical: `Docs/Assets/AssetPriority.md`)",
    "Follow the canonical asset priority - hosted registry\n   FIRST.",
    "the plan-time asset stage (hosted Loomtide registry first; local fixtures only for offline)",
    "The hosted catalog is the canonical source for every role.",
  ];
  for (const text of regressions) {
    const findings = hostedFirstMandateFindings([{ file: "fake/doc.md", text }]);
    assert.ok(findings.length > 0, `detector missed a real regression:\n${text}`);
  }
});

test("LITMUS: the hosted-first detector accepts the current (optional) wording", () => {
  // Negative control: the demoted phrasing must not be reported, or the guard is unusable and
  // the next author deletes it.
  const accepted = [DOC, PLAN, BUILD, SKILL].map((file) => ({ file, text: read(file) }));
  assert.deepEqual(hostedFirstMandateFindings(accepted), []);
});

// ---------------------------------------------------------------------------------------------
// 3. The docs must positively state the new stance
// ---------------------------------------------------------------------------------------------

/** The committed/local registry (or generated assets) is named as the default path. */
const LOCAL_DEFAULT_RE =
  /(?:local registry|checked-in|committed)[\s\S]{0,90}\bdefault\b|\bdefault\b[\s\S]{0,90}(?:local registry|checked-in|committed)/i;

/** The hosted catalog is named as optional. */
const HOSTED_OPTIONAL_RE = /hosted[\s\S]{0,80}\boptional\b|\boptional\b[\s\S]{0,80}hosted/i;

/** The endpoint is reachable by flag and env var, and no deployment is named. */
const CONFIGURABLE_ENDPOINT_RE = /--catalog-api/;
const ENDPOINT_ENV_VAR = "LOOMBRIDGE_ASSET_CATALOG_URL";

/** Report which of the required NEW claims a text is missing. */
export function missingNewStanceClaims(text: string): string[] {
  const flat = flatten(text);
  const missing: string[] = [];
  if (!LOCAL_DEFAULT_RE.test(flat)) missing.push("local/committed registry is the default path");
  if (!HOSTED_OPTIONAL_RE.test(flat)) missing.push("hosted catalog is optional");
  if (!CONFIGURABLE_ENDPOINT_RE.test(flat)) missing.push("--catalog-api flag");
  if (!flat.includes(ENDPOINT_ENV_VAR)) missing.push(ENDPOINT_ENV_VAR);
  return missing;
}

test("canonical doc, plan wizard, and skill all state the new stance", () => {
  for (const rel of [DOC, PLAN, SKILL]) {
    const missing = missingNewStanceClaims(read(rel));
    assert.deepEqual(missing, [], `${rel} is missing: ${missing.join(", ")}`);
  }
});

test("LITMUS: the new-stance detector reports each claim when it is absent", () => {
  const complete = [
    "The checked-in asset-layer/registry packs are the default path.",
    "The hosted catalog is an optional accelerator.",
    `Pass --catalog-api <baseUrl> or set ${ENDPOINT_ENV_VAR}.`,
  ].join("\n");
  assert.deepEqual(missingNewStanceClaims(complete), []);

  const drops: Array<[string, string]> = [
    ["local/committed registry is the default path", "The checked-in asset-layer/registry packs are the default path."],
    ["hosted catalog is optional", "The hosted catalog is an optional accelerator."],
    ["--catalog-api flag", "Pass --catalog-api <baseUrl> or set " + ENDPOINT_ENV_VAR + "."],
  ];
  for (const [claim, line] of drops) {
    const mutated = complete.replace(line, "");
    assert.ok(
      missingNewStanceClaims(mutated).includes(claim),
      `dropping "${line}" should have reported: ${claim}`,
    );
  }
  assert.ok(
    missingNewStanceClaims(complete.replace(ENDPOINT_ENV_VAR, "")).includes(ENDPOINT_ENV_VAR),
    "dropping the env var name should have been reported",
  );
});

// ---------------------------------------------------------------------------------------------
// 4. Claims that survive the demotion unchanged
// ---------------------------------------------------------------------------------------------

test("canonical asset-priority doc keeps the four-tier order and the primitive ban", () => {
  const doc = read(DOC);

  assert.ok(doc.includes(HOSTED_STORE), "must name the human web store");
  // The four-tier priority order is spelled out.
  assert.match(doc, /local registry ?\/ ?profile fixtures/i);
  assert.match(doc, /offline/i);
  assert.match(doc, /online discovery|web search/i);
  // Primitives are never final.
  assert.match(doc, /\bnever\b/i);
  assert.match(doc, /primitive/i);
  // Promotion evidence for a discovered asset.
  assert.match(doc, /sha256/i);
  assert.match(doc, /license/i);
});

test("docs reject `registry-missing` as a manifest status value", () => {
  // The manifest schema's status enum is the closed set approved|needed|placeholder
  // (asset-manifest.ts INVALID_ASSET_STATUS). "registry-missing" is a rationale note, not a
  // status, and the docs MUST say so, or an agent writes an invalid status and the validator
  // rejects it. Guards the exact fiction the adversarial review caught.
  for (const rel of [DOC, SKILL]) {
    const text = read(rel);
    if (!/registry-missing/i.test(text)) continue; // fine if the doc drops the term entirely
    assert.match(
      text,
      /\bnot\b[^.]{0,20}`?status`?/i,
      `${rel} mentions registry-missing but never clarifies it is not a status value`
    );
    assert.match(text, /approved ?\| ?needed ?\| ?placeholder/, `${rel} should cite the real status enum`);
  }
});

test("plan command keeps the asset stage, its three modes, and the approval checkpoint", () => {
  const plan = read(PLAN);

  assert.match(plan, /Docs\/Assets\/AssetPriority\.md/);
  assert.ok(plan.includes(HOSTED_STORE), "plan must name the human web store");
  // All three wizard choices survive the demotion; only the recommendation changed.
  for (const mode of [/\*\*Registry:\*\*/, /\*\*Generated:\*\*/, /\*\*Hybrid:\*\*/]) {
    assert.match(plan, mode, "the plan wizard must still offer all three asset modes");
  }
  // The local-registry path is shown as a runnable default, not just described.
  assert.match(plan, /--registry/);
  assert.match(plan, /offline/i);
  // Show candidates / approval before applying.
  assert.match(plan, /approval BEFORE\s+applying|get explicit approval/i);
});

test("build command forbids primitive fallback and points back to the asset stage", () => {
  const build = read(BUILD);

  assert.match(build, /Docs\/Assets\/AssetPriority\.md/);
  assert.match(build, /ASSET_MANIFEST\.json/);
  assert.match(build, /go\s+back to `?loombridge assets`?/i);
  assert.match(build, /Do NOT substitute a Unity primitive|primitives are construction\s+scaffolding only/i);
});

test("asset-layer skill documents the 3D path, web-search evidence, and the manifest precondition", () => {
  const skill = read(SKILL);

  assert.match(skill, /Docs\/Assets\/AssetPriority\.md/);
  assert.ok(skill.includes(HOSTED_STORE), "skill must name the human web store");
  // 3D game path
  assert.match(skill, /3D (games|shooter)/i);
  // web-search fallback evidence
  assert.match(skill, /web-?search fallback|Online discovery \/ web search/i);
  assert.match(skill, /sha256/i);
  // precondition: registry-plan/apply need a draft manifest first (omitting it makes the
  // copy-paste 3D block error). Guards the second adversarial finding.
  assert.match(skill, /--asset-mode/, "skill 3D block must state the loombridge plan --asset-mode precondition");
});

// Cross-cutting invariant: the web-store domain serves /api/..., the CLI --catalog-api needs
// /v1/...; using the store as the catalog-api base 404s. A future edit that "simplifies" the
// docs to pass the store URL to --catalog-api MUST fail this test.
test("no doc ever passes the web store as the --catalog-api base", () => {
  for (const rel of [PLAN, BUILD, SKILL, DOC]) {
    const text = read(rel);
    assert.ok(
      !text.includes(`--catalog-api ${HOSTED_STORE}`),
      `${rel} must NOT pass the human web store (${HOSTED_STORE}) to --catalog-api: it serves /api, not /v1`
    );
  }
  // ...and the warning that explains the pitfall is present where the endpoint is documented.
  for (const rel of [PLAN, SKILL, DOC]) {
    const text = read(rel);
    assert.match(
      text,
      /\/api\b[\s\S]{0,80}\/v1\b|not the `?--catalog-api`? base|do not pass it (to --catalog-api|there)/i,
      `${rel} should explain why the web store is not the --catalog-api base`
    );
  }
});
