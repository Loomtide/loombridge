import assert from "node:assert/strict";
import test from "node:test";

import {
  applyGeneratedAssetExportsToManifest,
  buildGeneratedAssetPlan,
  generatedAssetCacheKey,
  redactGeneratedAssetSecrets,
  resolveGeneratedAssetsForSlices,
  type GeneratedAssetAnnotation,
  type GeneratedAssetExportInput,
} from "../asset-layer/generated-assets.js";
import { createDraftAssetManifest, validateAssetManifest } from "../loombridge/asset-manifest.js";

const HASH = "c".repeat(64);
const PRODUCED_AT = "2026-06-05T00:00:00.000Z";

function manifest() {
  return createDraftAssetManifest({
    mode: "generated",
    heroShot: {
      path: ".loombridge/design/hero-shot.png",
      sha256: HASH,
    },
  });
}

function annotations(): GeneratedAssetAnnotation[] {
  return manifest().assets.map((asset, i) => ({
    annotationId: `ann-${asset.id}`,
    role: asset.role as GeneratedAssetAnnotation["role"],
    heroRegion: { x: i * 8, y: i * 4, w: 32, h: 32 },
    requiredOutputs: asset.role === "parallax-background" ? ["back", "middle", "front"] : ["main"],
    prompt: `Export ${asset.role} from the approved hero shot.`,
    styleLock: `match annotation ${asset.id}`,
  }));
}

function exportsFor(plan = buildGeneratedAssetPlan(manifest(), annotations())): GeneratedAssetExportInput[] {
  return plan.slots.map((slot) => ({
    assetId: slot.assetId,
    paths: slot.requiredOutputs.map((output) => `Assets/Art/Generated/${slot.assetId}-${output}.png`),
    generator: "manual-export",
    producedAt: PRODUCED_AT,
    license: "project-generated",
    provenance: {
      origin: "hero-shot-annotation",
      tool: "test-exporter",
      notes: `exported ${slot.role}`,
    },
  }));
}

test("generated asset plan maps approved hero-shot annotations to every generated manifest role", () => {
  const draft = manifest();
  const plan = buildGeneratedAssetPlan(draft, annotations(), { producedFromHash: HASH });

  assert.deepEqual(plan.issues, []);
  assert.equal(plan.generatedSetId, "generated_set_needed");
  assert.equal(plan.producedFromHash, HASH);
  assert.equal(plan.slots.length, draft.assets.length);

  const parallax = plan.slots.find((slot) => slot.assetId === "parallax_background");
  assert.ok(parallax);
  assert.deepEqual(parallax.requiredOutputs, ["back", "middle", "front"]);
  assert.equal(parallax.annotationId, "ann-parallax_background");
  assert.match(parallax.styleLock, /match annotation/);
});

test("generated asset plan rejects missing annotations instead of falling back to registry", () => {
  const draft = manifest();
  const incomplete = annotations().filter((annotation) => annotation.role !== "hazard");

  const plan = buildGeneratedAssetPlan(draft, incomplete, { producedFromHash: HASH });

  assert.ok(plan.issues.some((issue) => issue.code === "MISSING_ANNOTATION" && issue.role === "hazard"));
  assert.equal(plan.slots.some((slot) => slot.role === "hazard"), false);
});

test("applying generated exports records game-ready paths and generation provenance", () => {
  const draft = manifest();
  const ann = annotations();
  const plan = buildGeneratedAssetPlan(draft, ann, { producedFromHash: HASH });
  const approved = applyGeneratedAssetExportsToManifest({
    manifest: draft,
    annotations: ann,
    exports: exportsFor(plan),
    producedFromHash: HASH,
    approvedAt: PRODUCED_AT,
  });

  const validation = validateAssetManifest(approved);
  assert.equal(validation.valid, true, JSON.stringify(validation.issues, null, 2));
  assert.equal(approved.status, "approved");
  assert.equal(approved.assetSources[0]?.kind, "generated-set");
  assert.equal(approved.assetSources[0]?.approved, true);
  assert.equal(approved.assets.every((asset) => asset.source === "generated"), true);
  assert.equal(approved.assets.every((asset) => asset.status === "approved"), true);

  const player = approved.assets.find((asset) => asset.id === "player_character");
  assert.equal(player?.sourceId, "generated_set_needed");
  assert.deepEqual(player?.resolvedPaths, ["Assets/Art/Generated/player_character-main.png"]);
  assert.equal(player?.generatedExport?.sourceImageSha256, HASH);
  assert.equal(player?.generatedExport?.provenance.origin, "hero-shot-annotation");
  assert.equal(player?.generatedExport?.provenance.annotationId, "ann-player_character");
});

test("generated asset provenance rejects and redacts provider secrets", () => {
  const draft = manifest();
  const ann = annotations();
  const plan = buildGeneratedAssetPlan(draft, ann, { producedFromHash: HASH });
  const exported = exportsFor(plan);

  assert.deepEqual(
    redactGeneratedAssetSecrets({
      provider: "meshy",
      apiKey: "sk-abc123456789012345678901234567890",
      nested: { bearerToken: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789" },
    }),
    {
      provider: "meshy",
      apiKey: "[REDACTED]",
      nested: { bearerToken: "[REDACTED]" },
    },
  );

  assert.throws(
    () => applyGeneratedAssetExportsToManifest({
      manifest: draft,
      annotations: ann,
      exports: exported.map((entry, i) => i === 0
        ? { ...entry, provenance: { ...entry.provenance, apiKey: "sk-abc123456789012345678901234567890" } }
        : entry),
      producedFromHash: HASH,
      approvedAt: PRODUCED_AT,
    }),
    /must not include secret field/,
  );
});

test("generated asset provenance allows content hashes and rejects value secrets deterministically", () => {
  const draft = manifest();
  const ann = annotations();
  const plan = buildGeneratedAssetPlan(draft, ann, { producedFromHash: HASH });
  const exported = exportsFor(plan);
  const resultSha256 = "a".repeat(64);

  const approved = applyGeneratedAssetExportsToManifest({
    manifest: draft,
    annotations: ann,
    exports: exported.map((entry, i) => i === 0
      ? { ...entry, provenance: { ...entry.provenance, resultSha256, providerResultId: "abc123".repeat(12) } }
      : entry),
    producedFromHash: HASH,
    approvedAt: PRODUCED_AT,
  });
  const player = approved.assets.find((asset) => asset.id === "player_character");
  assert.equal(player?.generatedExport?.provenance.resultSha256, resultSha256);
  assert.equal(
    (redactGeneratedAssetSecrets({ resultSha256 }) as { resultSha256: string }).resultSha256,
    resultSha256,
  );

  const valueSecret = "AbcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const secretExport = exported.map((entry, i) => i === 0
    ? { ...entry, provenance: { ...entry.provenance, notes: valueSecret } }
    : entry);
  for (let i = 0; i < 2; i++) {
    assert.throws(
      () => applyGeneratedAssetExportsToManifest({
        manifest: draft,
        annotations: ann,
        exports: secretExport,
        producedFromHash: HASH,
        approvedAt: PRODUCED_AT,
      }),
      /appears to contain a secret/,
    );
  }
  assert.deepEqual(redactGeneratedAssetSecrets({ notes: valueSecret }), { notes: "[REDACTED]" });
});

test("generated asset cache keys are stable across parameter order", () => {
  const a = generatedAssetCacheKey({
    provider: "meshy",
    model: "meshy-6",
    sourceImageSha256: HASH,
    promptSha256: "d".repeat(64),
    parameters: { targetPolycount: 20000, enablePbr: true },
  });
  const b = generatedAssetCacheKey({
    provider: "meshy",
    model: "meshy-6",
    sourceImageSha256: HASH,
    promptSha256: "d".repeat(64),
    parameters: { enablePbr: true, targetPolycount: 20000 },
  });

  assert.equal(a, b);
  assert.match(a, /^[a-f0-9]{64}$/);
});

test("applying generated exports rejects unsafe paths and missing exports", () => {
  const draft = manifest();
  const ann = annotations();
  const plan = buildGeneratedAssetPlan(draft, ann, { producedFromHash: HASH });
  const exported = exportsFor(plan);

  assert.throws(
    () => applyGeneratedAssetExportsToManifest({
      manifest: draft,
      annotations: ann,
      exports: exported.map((entry, i) => i === 0 ? { ...entry, paths: ["../escape.png"] } : entry),
      producedFromHash: HASH,
      approvedAt: PRODUCED_AT,
    }),
    /must use safe relative paths/,
  );

  assert.throws(
    () => applyGeneratedAssetExportsToManifest({
      manifest: draft,
      annotations: ann,
      exports: exported.slice(1),
      producedFromHash: HASH,
      approvedAt: PRODUCED_AT,
    }),
    /Missing generated export for asset 'player_character'/,
  );
});

test("generated slice bindings resolve manifest paths without registry lookup", () => {
  const draft = manifest();
  const ann = annotations();
  const plan = buildGeneratedAssetPlan(draft, ann, { producedFromHash: HASH });
  const approved = applyGeneratedAssetExportsToManifest({
    manifest: draft,
    annotations: ann,
    exports: exportsFor(plan),
    producedFromHash: HASH,
    approvedAt: PRODUCED_AT,
  });

  const bindings = resolveGeneratedAssetsForSlices(approved);
  const framing = bindings.find((binding) => binding.sliceId === "framing");

  assert.ok(framing);
  assert.ok(framing.assets.some((asset) => asset.assetId === "player_character"));
  assert.ok(framing.assets.every((asset) => asset.paths.every((p) => p.startsWith("Assets/Art/Generated/"))));
  assert.ok(framing.assets.every((asset) => asset.provenance.origin === "hero-shot-annotation"));
});
