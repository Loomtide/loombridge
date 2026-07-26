import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { REPO_ROOT } from "./_support/paths.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = REPO_ROOT;

// Literal substrings (NOT regex) — compared with String.includes so dots are not wildcards.
const HOSTED_STORE = "https://assetstore.loomtide.ai";
const CATALOG_API_BASE = "https://asset-api-production-59d9.up.railway.app";

function read(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf-8");
}

const PLAN = "commands/loombridge/plan.md";
const BUILD = "commands/loombridge/build.md";
const SKILL = ".skills/asset-layer/SKILL.md";
const DOC = "Docs/Assets/AssetPriority.md";

test("canonical asset-priority doc states the hosted-first ordering and primitive ban", () => {
  const doc = read(DOC);

  assert.ok(doc.includes(HOSTED_STORE), "must name the human web store");
  assert.ok(doc.includes(CATALOG_API_BASE), "must name the CLI catalog-api base");
  // The four-tier priority order is spelled out.
  assert.match(doc, /hosted Loomtide registry/i);
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
  // status — the docs MUST say so, or an agent writes an invalid status and the validator
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

test("plan command makes the hosted catalog the default asset flow", () => {
  const plan = read(PLAN);

  assert.match(plan, /Docs\/Assets\/AssetPriority\.md/);
  assert.ok(plan.includes(HOSTED_STORE), "plan must name the human web store");
  // The hosted search API is the documented --catalog-api default.
  assert.ok(
    plan.includes(`--catalog-api ${CATALOG_API_BASE}`),
    "plan must show --catalog-api pointing at the railway base"
  );
  // registry-first fallback rule: local registry only for offline/test.
  assert.match(plan, /offline/i);
  assert.match(plan, /--registry/);
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

test("asset-layer skill is hosted-first, documents the 3D path, web-search evidence, and the manifest precondition", () => {
  const skill = read(SKILL);

  assert.match(skill, /Docs\/Assets\/AssetPriority\.md/);
  assert.ok(skill.includes(HOSTED_STORE), "skill must name the human web store");
  assert.ok(skill.includes(CATALOG_API_BASE), "skill must name the CLI catalog-api base");
  // hosted-first wording
  assert.match(skill, /hosted registry first|hosted Loomtide registry/i);
  // 3D game path
  assert.match(skill, /3D (games|shooter)/i);
  // web-search fallback evidence
  assert.match(skill, /web-?search fallback|Online discovery \/ web search/i);
  assert.match(skill, /sha256/i);
  // precondition: registry-plan/apply need a draft manifest first (omitting it makes the
  // copy-paste 3D block error). Guards the second adversarial finding.
  assert.match(skill, /--asset-mode/, "skill 3D block must state the loombridge plan --asset-mode precondition");
});

// Cross-cutting invariant: the whole point of the change. The web-store domain serves /api/...,
// the CLI --catalog-api needs /v1/...; using the store as the catalog-api base 404s. A future
// edit that "simplifies" the docs to pass the store URL to --catalog-api MUST fail this test.
test("no doc ever passes the web store as the --catalog-api base", () => {
  for (const rel of [PLAN, BUILD, SKILL, DOC]) {
    const text = read(rel);
    assert.ok(
      !text.includes(`--catalog-api ${HOSTED_STORE}`),
      `${rel} must NOT pass the human web store (${HOSTED_STORE}) to --catalog-api — it serves /api, not /v1`
    );
  }
  // ...and the warning that explains the pitfall is present where the default is documented.
  for (const rel of [PLAN, SKILL, DOC]) {
    const text = read(rel);
    assert.match(
      text,
      /\/api\b[\s\S]{0,80}\/v1\b|not the `?--catalog-api`? base|do not pass it (to --catalog-api|there)/i,
      `${rel} should explain why the web store is not the --catalog-api base`
    );
  }
});
