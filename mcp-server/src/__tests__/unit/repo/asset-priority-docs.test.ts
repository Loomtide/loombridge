import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
// 1. No deployment hostname anywhere in the TRACKED tree
// ---------------------------------------------------------------------------------------------

/**
 * Ephemeral PaaS / preview-deployment host families, plus the serverless families an adversarial
 * review confirmed were missing (`*.a.run.app`, `*.deno.dev`, `*.pages.dev`, `*.supabase.co`).
 * Object-storage hosts are deliberately NOT in this list: a catalog record legitimately pins the
 * public URL of an asset byte, and that is data about an asset, not a Loombridge endpoint.
 *
 * The pattern is written with escaped slashes (`\/\/`) for the same reason `asset-registry-
 * boundary.test.ts` does: this file is itself inside the scanned tree, and a literal `//` here
 * would make the guard report itself.
 */
const DEPLOYMENT_HOST_RE =
  /\/\/[^/\s"'`]*\.(?:railway\.app|vercel\.app|fly\.dev|onrender\.com|herokuapp\.com|workers\.dev|netlify\.app|ngrok\.io|ngrok-free\.app|azurewebsites\.net|appspot\.com|a\.run\.app|deno\.dev|pages\.dev|supabase\.co)(?=[:/\s"'`)\]]|$)/i;

/**
 * Loomtide-owned hostnames that may appear, each with the reason it is not a Loombridge ENDPOINT
 * this repo is naming. Anything else under `loomtide.ai` is a finding, which is what makes the
 * "this repo does not name a deployment" claim enforceable: `catalog.loomtide.ai` is not a PaaS
 * family, so the host-family scan above never saw it, and six runnable commands in the quickstart
 * pointed at it while the same doc said no deployment was named.
 */
const ALLOWED_LOOMTIDE_HOSTS = new Map<string, string>([
  ["loomtide.ai", "the product homepage"],
  ["assetstore.loomtide.ai", "the brand-owned human web store, a product URL"],
  ["get.loomtide.ai", "the documented install channel"],
  ["assets.loomtide.ai", "object storage for asset BYTES pinned by catalog records (data, not an endpoint)"],
  // `registry.loomtide.ai` was here for a scoped-registry example in the bridge-distribution doc.
  // The host does not resolve, so the example named a registry nobody could add; the doc now shows
  // OpenUPM's real URL instead. Re-add this entry only alongside a registry that actually serves.
]);
const LOOMTIDE_HOST_RE = /\/\/([a-z0-9.-]*\bloomtide\.ai)\b/gi;

/**
 * The scan walks the whole TRACKED tree with a small skip list, rather than an enumerated set of
 * roots. Roots were the wrong shape: a real hostname planted in `demos/`, `unity-dev-project/`,
 * `templates/`, `.claude-plugin/`, `mcp-server/TOOLS.md`, `.github/workflows/*.yml` (the most
 * plausible home for a real deploy URL), an extensionless `scripts/` file, `Docs/**\/*.mdx`, or
 * anything under a directory named `bin` at any depth all SURVIVED, because none of those was a
 * scanned root or a scanned extension. `git ls-files` is the authority on what ships.
 *
 * LIMITS: only tracked files are scanned (an untracked file is not published), and binary
 * extensions are skipped by extension. Both are stated rather than hidden.
 */
const BINARY_EXTS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".bmp", ".tif", ".tiff",
  ".wav", ".ogg", ".mp3", ".aiff", ".glb", ".gltf", ".fbx", ".blend",
  ".ttf", ".otf", ".woff", ".woff2", ".zip", ".gz", ".tgz", ".pdf", ".unitypackage", ".dll", ".so", ".dylib",
]);
const SCAN_SKIP_PREFIXES = ["node_modules/", "dist/", "Library/", "Temp/", "Logs/"];

/** Every tracked, text-ish file, as repo-relative paths. */
export function trackedTextFiles(): string[] {
  const result = spawnSync("git", ["ls-files", "-z"], { cwd: repoRoot, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });
  assert.equal(result.status, 0, `git ls-files failed: ${result.stderr}`);
  return (result.stdout ?? "")
    .split("\0")
    .filter((file) => file.length > 0)
    .filter((file) => !BINARY_EXTS.has(path.extname(file).toLowerCase()))
    .filter((file) => !SCAN_SKIP_PREFIXES.some((prefix) => file.startsWith(prefix) || file.includes(`/${prefix}`)))
    // `lstat`, not `exists`: a tracked SYMLINK (`.claude/skills` -> `.skills`) resolves to a
    // directory, and its target is tracked in its own right, so following it would both crash the
    // read and double-report.
    .filter((file) => {
      const abs = path.join(repoRoot, file);
      return fs.existsSync(abs) && fs.lstatSync(abs).isFile();
    })
    .sort();
}

/** Report `<file>:<line>` for every deployment hostname in the supplied texts. */
export function deploymentHostFindings(texts: Array<{ file: string; text: string }>): string[] {
  const findings: string[] = [];
  for (const { file, text } of texts) {
    text.split("\n").forEach((line, index) => {
      if (DEPLOYMENT_HOST_RE.test(line)) findings.push(`${file}:${index + 1}`);
      for (const m of line.matchAll(LOOMTIDE_HOST_RE)) {
        const host = m[1]!.toLowerCase();
        if (!ALLOWED_LOOMTIDE_HOSTS.has(host)) findings.push(`${file}:${index + 1} (${host})`);
      }
    });
  }
  return findings;
}

test("no deployment hostname appears anywhere in the tracked tree", () => {
  const files = trackedTextFiles();
  // Non-vacuity, in both directions: the walk must be broad, and it must include the places the
  // enumerated-roots version could not see.
  assert.ok(files.length > 800, `scan looks vacuous: only ${files.length} files walked`);
  for (const required of [".github/workflows", "demos/", "templates/", "mcp-server/TOOLS.md"]) {
    assert.ok(
      files.some((file) => file.startsWith(required) || file === required),
      `the tracked-tree scan must cover ${required}`,
    );
  }

  const findings = deploymentHostFindings(files.map((file) => ({ file, text: read(file) })));
  assert.deepEqual(
    findings,
    [],
    "endpoints are configuration, named by env var or flag, never baked into public prose or code:\n  " +
      findings.join("\n  "),
  );
});

test("LITMUS: the deployment-host scan reports a planted hostname in every host family", () => {
  // Assembled so this source file does not itself contain a literal host.
  const families = [
    ["asset-api-production-59d9", "up", "railway", "app"],
    ["catalog", "example", "a", "run", "app"],
    ["catalog", "example", "deno", "dev"],
    ["catalog", "example", "pages", "dev"],
    ["catalog", "example", "supabase", "co"],
  ];
  for (const parts of families) {
    const host = parts.join(".");
    const planted = [{ file: "fake/doc.md", text: `see the search API at https:${"//"}${host}/v1/assets/search\n` }];
    assert.deepEqual(deploymentHostFindings(planted), ["fake/doc.md:1"], host);
  }
  // ...and a brand host that is NOT an allowlisted product URL.
  const brand = ["catalog", "loomtide", "ai"].join(".");
  assert.deepEqual(
    deploymentHostFindings([{ file: "fake/doc.md", text: `--catalog https:${"//"}${brand}/v1/catalog/public/x\n` }]),
    [`fake/doc.md:1 (${brand})`],
  );
});

test("LITMUS: the deployment-host scan tolerates the brand-owned product URLs", () => {
  // Negative control. An over-broad detector that flagged the asset store would push the docs
  // into naming nothing at all, which is a worse doc, not a safer one.
  const allowed = [
    { file: "fake/doc.md", text: `browse at ${HOSTED_STORE}/ and pick candidates\n` },
    { file: "fake/two.md", text: "assets download from https://assets.loomtide.ai/pack/a.png\n" },
    { file: "fake/three.md", text: "curl https://get.loomtide.ai/install.sh\n" },
  ];
  assert.deepEqual(deploymentHostFindings(allowed), []);
});

test("LITMUS: the tracked-tree scan actually reaches a workflow file", () => {
  // The most plausible home for a real deploy URL, and the one the enumerated-roots scan missed
  // entirely. Proven by finding a known string in a file only this walk can see.
  const files = trackedTextFiles();
  const workflow = files.find((file) => file.startsWith(".github/workflows/") && file.endsWith(".yml"));
  assert.ok(workflow, "no tracked workflow file was walked");
  assert.match(read(workflow), /\bon\b|\bjobs\b/, `${workflow} was not readable as a workflow`);
});

// ---------------------------------------------------------------------------------------------
// 2. The priority language may not regress to mandating hosted-first
// ---------------------------------------------------------------------------------------------

/**
 * LIMIT, stated honestly because an adversarial review defeated the previous version of this
 * detector: a phrase denylist locks VOCABULARY, not STANCE. Prepending "Always start with the
 * hosted Loomtide catalog. Reach for a committed pack only when the run is explicitly offline."
 * left every required phrase present and every banned phrase absent, and the suite stayed green.
 *
 * Two things narrow that, and neither closes it:
 *
 *   - the denylist now includes the SHAPES of a demotion, not only the historical wordings: an
 *     imperative to start hosted, an ordering that puts hosted before the committed packs, and
 *     the "committed packs are for offline only" reframing;
 *   - `priorityOrderFindings` reads the canonical doc's numbered `## The order` list POSITIONALLY
 *     and requires item 1 to be the committed/local path. Prose elsewhere can still contradict a
 *     correct list; the list is what the rest of the doc set points at.
 */
const HOSTED_FIRST_PATTERNS: Array<[string, RegExp]> = [
  ["hosted ... FIRST", /hosted[\s\S]{0,30}\bFIRST\b/i],
  ["hosted registry first", /hosted\s+registry\s+first/i],
  ["hosted-first", /\bhosted-first\b/i],
  ["hosted ... is the default", /hosted[\s\S]{0,40}\bis\s+the\s+default\b/i],
  ["hosted ... the canonical source", /hosted[\s\S]{0,40}\bthe\s+canonical\s+source\b/i],
  ["default ... hosted registry", /\bdefault\b[\s\S]{0,20}hosted\s+(?:Loomtide\s+)?registry/i],
  ["start with the hosted ...", /\b(?:start|begin)\s+(?:with|at|from)\s+the\s+hosted\b/i],
  ["prefer the hosted ...", /\b(?:prefer|favour|favor)\s+the\s+hosted\b/i],
  ["hosted ... before ... committed/local", /hosted[\s\S]{0,60}\bbefore\b[\s\S]{0,40}(?:committed|checked-in|local registry)/i],
  ["committed/local ... only ... offline", /(?:committed|checked-in|local registry)[\s\S]{0,60}\bonly\b[\s\S]{0,40}\boffline\b/i],
  ["fall back to ... committed/local", /\bfall(?:s|ing)?\s+back\s+to\s+(?:the\s+)?(?:committed|checked-in|local registry)/i],
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

/**
 * The POSITIONAL half: the canonical doc's `## The order` section is a numbered list, and which
 * item is number 1 is the stance. Reading the ordinal is not defeated by rewording.
 */
export function priorityOrderFindings(doc: string): string[] {
  const section = doc.split(/^##\s+The order\s*$/m)[1];
  if (section === undefined) return ["canonical doc has no `## The order` section to read"];
  const items = [...section.split(/^##\s/m)[0]!.matchAll(/^(\d+)\.\s+\*\*(.+?)\*\*/gm)]
    .map((m) => ({ ordinal: Number(m[1]), title: m[2]! }));
  if (items.length < 3) return [`the priority list has ${items.length} numbered items; expected at least 3`];
  const first = items.find((item) => item.ordinal === 1);
  if (!first) return ["the priority list has no item 1"];
  const findings: string[] = [];
  if (!/local registry|checked-in|committed|generated/i.test(first.title)) {
    findings.push(`priority item 1 is not the committed/local path: "${first.title}"`);
  }
  if (/hosted/i.test(first.title)) findings.push(`priority item 1 is the hosted catalog: "${first.title}"`);
  const hosted = items.find((item) => /hosted/i.test(item.title));
  if (hosted && hosted.ordinal <= 1) findings.push(`the hosted catalog is item ${hosted.ordinal}`);
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

test("the canonical priority list puts the committed/local path first, by ordinal", () => {
  const findings = priorityOrderFindings(read(DOC));
  assert.deepEqual(findings, [], findings.join("\n  "));
});

test("LITMUS: the positional prong fires when the list is reordered", () => {
  const doc = read(DOC);
  const swapped = doc
    .replace("1. **Local registry / profile fixtures and generated assets (the default path).**",
      "1. **Hosted Loomtide catalog (start here).**")
    .replace("2. **Hosted Loomtide catalog (OPTIONAL accelerator, read-only).**",
      "2. **Local registry / profile fixtures and generated assets.**");
  const findings = priorityOrderFindings(swapped);
  assert.ok(findings.length > 0, "swapping items 1 and 2 must be reported");
  assert.ok(findings.some((f) => /item 1 is the hosted catalog/.test(f)), findings.join("; "));
  // ...and a doc whose list has been deleted outright must not read as compliant.
  assert.ok(priorityOrderFindings("# no list here\n").length > 0, "a missing list is a finding");
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

test("LITMUS: the hosted-first detector fires on the reviewer's re-mandate", () => {
  // The exact paragraph an adversarial review prepended to AssetPriority.md, which left the old
  // phrase-presence detector 14/14 green.
  const attack =
    "Always start with the hosted Loomtide catalog. Reach for a committed pack only when the run " +
    "is explicitly offline.";
  const findings = hostedFirstMandateFindings([{ file: "fake/doc.md", text: attack }]);
  assert.ok(findings.length > 0, "the re-mandate must be reported");
  assert.ok(findings.some((f) => /start with the hosted/.test(f)), findings.join("; "));
  assert.ok(findings.some((f) => /only \.\.\. offline/.test(f)), findings.join("; "));
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

// ---------------------------------------------------------------------------------------------
// 5. The README's licence counts are derived, not remembered
// ---------------------------------------------------------------------------------------------

/**
 * A number in prose is a claim, and this one was wrong: the README said "the asset layer committed
 * in this repo records 80 assets as CC0-1.0", but 80 is the count for `asset-layer/registry/**`
 * alone, while the whole of `asset-layer/` records 85 CC0 plus one CC-BY-4.0 and one
 * LicenseRef-Unknown. Either scope the claim or drop it; this guard makes the scoped claim true by
 * deriving both numbers from the tree.
 */
export function spdxCounts(prefix: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const file of trackedTextFiles()) {
    if (!file.startsWith(prefix)) continue;
    for (const m of read(file).matchAll(/"spdx"\s*:\s*"([^"]+)"/g)) {
      counts.set(m[1]!, (counts.get(m[1]!) ?? 0) + 1);
    }
  }
  return counts;
}

test("the asset-priority doc's CC0 counts match what the tree actually records", () => {
  const registry = spdxCounts("asset-layer/registry/");
  const all = spdxCounts("asset-layer/");
  const registryCc0 = registry.get("CC0-1.0") ?? 0;
  const allCc0 = all.get("CC0-1.0") ?? 0;
  assert.ok(registryCc0 > 0, "the licence scan found nothing: it is vacuous");

  // The counts live in the asset-priority DOC, not the landing README: they describe the 80
  // test/demo assets committed here, which is not landing-page material. The hosted catalog is a
  // separate set this repo cannot verify, so no count for it is guarded anywhere.
  const readme = read(DOC);
  assert.ok(
    readme.includes(`**${registryCc0} assets as \`CC0-1.0\`**`),
    `Docs/Assets/AssetPriority.md must state the derived registry count (${registryCc0} CC0 in asset-layer/registry/**)`,
  );
  assert.ok(
    readme.includes(`**${allCc0} \`CC0-1.0\`**`),
    `Docs/Assets/AssetPriority.md must state the derived tree-wide count (${allCc0} CC0 across asset-layer/)`,
  );
  // Every non-CC0 licence the tree records must be named, so "predominantly CC0" is checkable.
  for (const spdx of [...all.keys()].filter((key) => key !== "CC0-1.0")) {
    assert.ok(readme.includes(spdx), `Docs/Assets/AssetPriority.md must name the non-CC0 licence ${spdx} it records`);
  }
});

test("LITMUS: the licence scan is bound to the tree, not to a constant", () => {
  const registry = spdxCounts("asset-layer/registry/");
  const all = spdxCounts("asset-layer/");
  assert.ok((all.get("CC0-1.0") ?? 0) >= (registry.get("CC0-1.0") ?? 0), "the tree-wide count must include the registry");
  assert.ok(all.size > 1, "the tree records more than one licence; the scan must see all of them");
  assert.deepEqual(spdxCounts("no-such-directory/"), new Map(), "an empty prefix must count nothing");
});
