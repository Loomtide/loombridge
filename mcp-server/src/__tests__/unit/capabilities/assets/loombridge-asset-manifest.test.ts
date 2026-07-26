import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ASSET_MANIFEST_SCHEMA_PATH,
  ASSET_MANIFEST_MODES,
  ASSET_MANIFEST_VERSION,
  ASSET_SOURCE_KINDS,
  ASSET_SOURCE_TYPES,
  ASSET_STATUSES,
  REQUIRED_ASSET_ROLES,
  assertValidAssetManifest,
  createDraftAssetManifest,
  readAssetManifest,
  validateAssetManifest,
  writeAssetManifest,
  type AssetManifest,
  type AssetManifestMode,
  type AssetSourceType,
  type ManifestGeneratedExport,
  type ManifestRegistrySelection,
} from "../../../../capabilities/assets/asset-manifest.js";
import { loombridgePaths } from "../../../../domain/state.js";

const HASH = "a".repeat(64);

function sorted(values: Iterable<unknown> | undefined): unknown[] {
  return [...(values ?? [])].sort((a, b) => String(a).localeCompare(String(b)));
}

function registrySelection(role: string): ManifestRegistrySelection {
  return {
    registryAssetId: `registry.${role}`,
    packId: "platformer-2d",
    primitive: "tile",
    license: {
      name: "Creative Commons Zero v1.0 Universal",
      spdx: "CC0-1.0",
      url: "https://creativecommons.org/publicdomain/zero/1.0/",
      requiresAttribution: false,
    },
    source: {
      title: `Registry ${role}`,
      url: "https://example.test/source",
      author: "Example",
      provenance: {
        verifiedAt: "2026-06-05",
        origin: "fixture",
        fixture: "test",
      },
    },
    provider: {
      name: "Fixture",
      url: "https://example.test/provider",
    },
    placeholder: false,
  };
}

function generatedExport(role: string): ManifestGeneratedExport {
  return {
    generatedSetId: "generated_set",
    generator: "fixture-generator",
    sourceImageSha256: HASH,
    producedAt: "2026-06-05T00:00:00.000Z",
    license: "project-generated",
    provenance: {
      origin: "hero-shot-annotation",
      annotationId: `ann-${role}`,
      prompt: `Generate ${role}`,
      tool: "test",
    },
  };
}

function sourceForMode(mode: AssetManifestMode): AssetSourceType {
  if (mode === "registry") return "registry";
  if (mode === "generated") return "generated";
  return "registry";
}

function manifest(mode: AssetManifestMode): AssetManifest {
  const source = sourceForMode(mode);
  const sourceId = source === "registry" ? "kenney_pixel_platformer" : undefined;
  const generatedSourceId = "generated_set";
  return {
    version: ASSET_MANIFEST_VERSION,
    mode,
    status: "approved",
    approvedAt: "2026-06-05T00:00:00.000Z",
    heroShot: {
      path: ".loombridge/design/hero-shot.png",
      sha256: HASH,
    },
    assetSources: mode === "generated"
      ? [{ id: "generated_set", kind: "generated-set", approved: true }]
      : [
          { id: "kenney_pixel_platformer", kind: "registry-pack", registry: "platformer-2d", license: "CC0-1.0", approved: true },
          ...(mode === "hybrid" ? [{ id: "generated_set", kind: "generated-set" as const, approved: true }] : []),
        ],
    assets: REQUIRED_ASSET_ROLES.map((role, i) => {
      const assetSource = mode === "hybrid" && role === "parallax-background" ? "generated" : source;
      return {
        id: role.replaceAll("-", "_"),
        role,
        source: assetSource,
        ...(assetSource === "registry" && sourceId ? { sourceId } : {}),
        ...(assetSource === "generated" ? { sourceId: generatedSourceId } : {}),
        status: "approved",
        requiredOutputs: ["main"],
        resolvedPaths: [`Assets/Art/${i}-${role}.png`],
        ...(assetSource === "registry" ? { registrySelection: registrySelection(role) } : {}),
        ...(assetSource === "generated" ? { generatedExport: generatedExport(role) } : {}),
      };
    }),
    sliceBindings: [
      { sliceId: "framing", assetIds: ["player_character", "parallax_background"] },
      { sliceId: "ground-tiling", assetIds: ["platform_tiles", "one_way_platform"] },
      { sliceId: "hazards", assetIds: ["hazard"] },
    ],
    replacementPolicy: {
      allowUnapprovedRegistryFallback: false,
      allowPlaceholders: true,
      requiresUserApprovalForSourceChange: true,
    },
  };
}

test("asset manifest validator accepts registry/generated/hybrid modes", () => {
  for (const mode of ["registry", "generated", "hybrid"] as const) {
    const result = validateAssetManifest(manifest(mode));
    assert.equal(result.valid, true, `${mode}: ${JSON.stringify(result.issues, null, 2)}`);
  }
});

test("createDraftAssetManifest records each strategy as a valid draft contract", () => {
  for (const mode of ["registry", "generated", "hybrid"] as const) {
    const draft = createDraftAssetManifest({
      mode,
      heroShot: { path: ".loombridge/design/hero-shot.png", sha256: HASH },
    });
    const result = validateAssetManifest(draft);
    assert.equal(result.valid, true, `${mode}: ${JSON.stringify(result.issues, null, 2)}`);
    assert.equal(draft.status, "draft");
    assert.equal(draft.mode, mode);
    assert.ok(draft.assets.every((asset) => asset.status === "needed"));
  }
});

test("createDraftAssetManifest drafts genre-parametric 3d-shooter roles, not platformer defaults", () => {
  for (const mode of ["registry", "generated", "hybrid"] as const) {
    const draft = createDraftAssetManifest({
      mode,
      heroShot: { path: ".loombridge/design/hero-shot.png", sha256: HASH },
      genre: "3d-shooter",
    });
    const result = validateAssetManifest(draft);
    assert.equal(result.valid, true, `${mode}: ${JSON.stringify(result.issues, null, 2)}`);
    assert.equal(draft.genre, "3d-shooter", `${mode}: genre persisted on the draft`);
    assert.equal(draft.status, "draft");
    assert.ok(draft.assets.every((asset) => asset.status === "needed"));

    const roles = draft.assets.map((asset) => asset.role);
    // 3d-shooter vertical roles present…
    for (const role of ["player-model", "enemy-model", "arena", "cover-prop", "weapon-model", "projectile", "reticle", "impact-vfx"]) {
      assert.ok(roles.includes(role), `${mode}: missing 3d role '${role}'`);
    }
    // …and NONE of the platformer roles leaked in.
    for (const role of REQUIRED_ASSET_ROLES) {
      assert.ok(!roles.includes(role), `${mode}: platformer role '${role}' leaked into 3d-shooter draft`);
    }
    // Slice bindings use the 3d-shooter slice DAG, not the platformer one.
    const sliceIds = draft.sliceBindings.map((binding) => binding.sliceId);
    assert.ok(sliceIds.includes("weapon") && sliceIds.includes("enemy-target"));
  }
});

test("createDraftAssetManifest omits the genre field for the platformer default (byte-compat)", () => {
  const explicit = createDraftAssetManifest({
    mode: "registry",
    heroShot: { path: ".loombridge/design/hero-shot.png", sha256: HASH },
    genre: "platformer-2d",
  });
  const implicit = createDraftAssetManifest({
    mode: "registry",
    heroShot: { path: ".loombridge/design/hero-shot.png", sha256: HASH },
  });
  assert.equal(explicit.genre, undefined);
  assert.deepEqual(explicit, implicit);
});

test("asset manifest validator enforces the 3d-shooter required roles for a 3d-shooter manifest", () => {
  const draft = createDraftAssetManifest({
    mode: "registry",
    heroShot: { path: ".loombridge/design/hero-shot.png", sha256: HASH },
    genre: "3d-shooter",
  });
  // Dropping a 3d role is a MISSING_REQUIRED_ROLE refusal — the gate is genre-parametric, not skipped.
  draft.assets = draft.assets.filter((asset) => asset.role !== "arena");
  const result = validateAssetManifest(draft);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) => issue.code === "MISSING_REQUIRED_ROLE" && issue.message.includes("arena")));
});

test("asset manifest validator rejects an empty genre field", () => {
  const draft = createDraftAssetManifest({
    mode: "registry",
    heroShot: { path: ".loombridge/design/hero-shot.png", sha256: HASH },
    genre: "3d-shooter",
  }) as unknown as Record<string, unknown>;
  draft.genre = "";
  const result = validateAssetManifest(draft);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) => issue.path === "genre"), JSON.stringify(result.issues));
});

test("asset manifest validator refuses an unregistered genre (refuse, don't silently downgrade)", () => {
  const draft = createDraftAssetManifest({
    mode: "registry",
    heroShot: { path: ".loombridge/design/hero-shot.png", sha256: HASH },
    genre: "3d-shooter",
  }) as unknown as Record<string, unknown>;
  draft.genre = "halo-killer";
  const result = validateAssetManifest(draft);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) => issue.code === "UNKNOWN_GENRE" && issue.path === "genre"), JSON.stringify(result.issues));
});

test("createDraftAssetManifest refuses explicit unregistered asset genres", () => {
  assert.throws(
    () => createDraftAssetManifest({
      mode: "registry",
      heroShot: { path: ".loombridge/design/hero-shot.png", sha256: HASH },
      genre: "2d-shooter",
    }),
    /No asset genre profile is registered for '2d-shooter'/,
  );
});

test("asset manifest schema file exists and mirrors runtime enum constants", async () => {
  const raw = await fs.readFile(ASSET_MANIFEST_SCHEMA_PATH, "utf-8");
  const schema = JSON.parse(raw) as {
    title?: string;
    properties?: Record<string, { const?: unknown; enum?: unknown[] }>;
    $defs?: Record<string, { properties?: Record<string, { enum?: unknown[] }> }>;
  };
  assert.match(schema.title ?? "", /Asset Manifest/);
  assert.ok(schema.properties?.mode);
  assert.equal(schema.properties?.version?.const, ASSET_MANIFEST_VERSION);
  assert.deepEqual(sorted(schema.properties?.mode?.enum), sorted(ASSET_MANIFEST_MODES));
  assert.deepEqual(schema.properties?.status?.enum, ["draft", "approved"]);
  assert.deepEqual(sorted(schema.$defs?.assetSource?.properties?.kind?.enum), sorted(ASSET_SOURCE_KINDS));
  assert.deepEqual(sorted(schema.$defs?.asset?.properties?.source?.enum), sorted(ASSET_SOURCE_TYPES));
  assert.deepEqual(sorted(schema.$defs?.asset?.properties?.status?.enum), sorted(ASSET_STATUSES));
});

test("asset manifest validator rejects unknown modes", () => {
  const bad = manifest("registry") as unknown as Record<string, unknown>;
  bad.mode = "surprise";
  const result = validateAssetManifest(bad);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) => issue.code === "INVALID_MODE"), JSON.stringify(result.issues));
});

test("asset manifest validator rejects unsafe paths", () => {
  const bad = manifest("generated");
  bad.heroShot.path = "../escape.png";
  bad.assets[0]!.resolvedPaths = ["/tmp/absolute.png"];
  const result = validateAssetManifest(bad);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) => issue.code === "UNSAFE_PATH" && issue.path === "heroShot.path"));
  assert.ok(result.issues.some((issue) => issue.code === "UNSAFE_PATH" && issue.path.includes("resolvedPaths")));
});

test("asset manifest validator rejects missing required asset roles", () => {
  const bad = manifest("generated");
  bad.assets = bad.assets.filter((asset) => asset.role !== "hazard");
  const result = validateAssetManifest(bad);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) => issue.code === "MISSING_REQUIRED_ROLE" && issue.message.includes("hazard")));
});

test("asset manifest validator rejects unknown asset ids in slice bindings", () => {
  const bad = manifest("registry");
  bad.sliceBindings[0]!.assetIds.push("missing_asset");
  const result = validateAssetManifest(bad);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) => issue.code === "UNKNOWN_ASSET_ID"), JSON.stringify(result.issues));
});

test("asset manifest validator rejects unapproved registry fallback policy", () => {
  const bad = manifest("hybrid");
  bad.replacementPolicy.allowUnapprovedRegistryFallback = true;
  const result = validateAssetManifest(bad);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) => issue.code === "UNAPPROVED_POLICY"));
});

test("asset manifest validator rejects policies that allow source changes without user approval", () => {
  const bad = manifest("hybrid");
  bad.replacementPolicy.requiresUserApprovalForSourceChange = false;
  const result = validateAssetManifest(bad);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) => issue.code === "UNAPPROVED_POLICY"));
});

test("asset manifest validator rejects unapproved registry source use", () => {
  const bad = manifest("registry");
  bad.assetSources[0]!.approved = false;
  const result = validateAssetManifest(bad);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) => issue.code === "UNAPPROVED_SOURCE_CHANGE"), JSON.stringify(result.issues));
});

test("asset manifest validator rejects mode/source mismatches", () => {
  const bad = manifest("generated");
  bad.assets[0]!.source = "registry";
  bad.assets[0]!.sourceId = "generated_set";
  const result = validateAssetManifest(bad);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) => issue.code === "MODE_SOURCE_MISMATCH"), JSON.stringify(result.issues));
});

test("asset manifest validator rejects hybrid manifests without a source mix", () => {
  const bad = manifest("hybrid");
  for (const asset of bad.assets) {
    asset.source = "registry";
    asset.sourceId = "kenney_pixel_platformer";
  }
  const result = validateAssetManifest(bad);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) => issue.code === "MODE_SOURCE_MISMATCH" && issue.path === "assets"), JSON.stringify(result.issues));
});

test("asset manifest validator rejects needed assets in approved manifests", () => {
  const bad = manifest("generated");
  bad.assets[0]!.status = "needed";
  const result = validateAssetManifest(bad);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) => issue.code === "UNAPPROVED_ASSET"), JSON.stringify(result.issues));
});

test("asset manifest validator rejects placeholders when policy disallows them", () => {
  const bad = manifest("generated");
  bad.replacementPolicy.allowPlaceholders = false;
  bad.assets[0]!.status = "placeholder";
  const result = validateAssetManifest(bad);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) => issue.code === "UNAPPROVED_PLACEHOLDER"), JSON.stringify(result.issues));
});

test("assertValidAssetManifest throws a summarised validation error", () => {
  const bad = manifest("registry") as unknown as Record<string, unknown>;
  bad.mode = "nope";
  assert.throws(() => assertValidAssetManifest(bad), /INVALID_MODE/);
});

test("read/write asset manifest helpers round-trip .loombridge/ASSET_MANIFEST.json", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "loombridge-manifest-"));
  const paths = loombridgePaths(root);
  const value = manifest("hybrid");

  await writeAssetManifest(paths, value);

  const raw = await fs.readFile(path.join(root, ".loombridge", "ASSET_MANIFEST.json"), "utf-8");
  assert.equal(raw.endsWith("\n"), true);
  const read = await readAssetManifest(paths);
  assert.deepEqual(read, value);
});
