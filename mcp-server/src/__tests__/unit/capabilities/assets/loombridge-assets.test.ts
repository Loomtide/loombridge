import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { run as runAssets } from "../../../../capabilities/assets/assets.js";
import { readAssetManifest, type AssetManifest, type RequiredAssetRole } from "../../../../capabilities/assets/asset-manifest.js";
import { setDesignTarget } from "../../../../capabilities/verification/design.js";
import { runPlan } from "../../../../capabilities/verification/plan.js";
import { loombridgePaths } from "../../../../domain/state.js";
import type { GeneratedAssetAnnotation, GeneratedAssetExportInput } from "../../../../capabilities/assets/generated-assets.js";
import { adaptRegistryPackToCatalog } from "../../../../capabilities/assets/catalog.js";
import type { AssetCatalogRecord } from "../../../../capabilities/assets/types.js";
import type { CatalogFetch } from "../../../../capabilities/assets/catalog-source.js";
import { buildRegistrySelectionPlan } from "../../../../capabilities/assets/manifest-selection.js";
import { loadAssetProfile, loadRegistryPack } from "../../../../capabilities/assets/registry.js";
import { evaluateAssetSourceFidelity } from "../../../../capabilities/verification/gates/asset-source-fidelity.js";
import { REPO_ROOT } from "../../../_support/paths.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = REPO_ROOT;
const APPROVED_AT = "2026-06-05T00:00:00.000Z";

async function tmpRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "loombridge-assets-"));
}

async function fakeImage(dir: string): Promise<string> {
  const p = path.join(dir, "src-hero.png");
  await fs.writeFile(p, "hero", "utf-8");
  return p;
}

async function draftManifest(root: string, mode: "registry" | "generated"): Promise<AssetManifest> {
  await runPlan({ root, genre: "platformer-2d", engine: "unity", force: false, allowMissingDesignTarget: true });
  await setDesignTarget({ root, imagePath: await fakeImage(root), mode: "generated", kind: "rendered-unity-frame", approve: true });
  assert.equal(await runPlan({ root, genre: "platformer-2d", engine: "unity", force: false, assetMode: mode }), 1);
  const manifest = await readAssetManifest(loombridgePaths(root));
  assert.ok(manifest);
  assert.equal(manifest.status, "draft");
  return manifest;
}

async function draftManifest3dShooter(root: string): Promise<AssetManifest> {
  await runPlan({ root, genre: "3d-shooter", engine: "unity", force: false, allowMissingDesignTarget: true });
  await setDesignTarget({ root, imagePath: await fakeImage(root), mode: "generated", kind: "rendered-unity-frame", approve: true });
  assert.equal(await runPlan({ root, genre: "3d-shooter", engine: "unity", force: false, assetMode: "registry" }), 1);
  const manifest = await readAssetManifest(loombridgePaths(root));
  assert.ok(manifest);
  assert.equal(manifest.status, "draft");
  assert.equal(manifest.genre, "3d-shooter");
  return manifest;
}

async function captureStderr(fn: () => Promise<number>): Promise<{ code: number; err: string }> {
  const original = console.error;
  const lines: string[] = [];
  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    return { code: await fn(), err: lines.join("\n") };
  } finally {
    console.error = original;
  }
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

async function webSelectionForPlan(root: string, overrides: Record<string, Partial<{ role: string; primitive: string; registryId: string }>> = {}): Promise<{
  registryPath: string;
  profilePath: string;
  selectionPath: string;
  items: Array<{ registryId: string; role: string; primitive: string; kind: "sprite"; title: string }>;
}> {
  const registryPath = path.join(repoRoot, "asset-layer/registry/platformer-2d.json");
  const profilePath = path.join(repoRoot, "asset-layer/profiles/2d-platformer.json");
  const manifest = await readAssetManifest(loombridgePaths(root));
  assert.ok(manifest);
  const registry = await loadRegistryPack(registryPath);
  const profile = await loadAssetProfile(profilePath);
  const plan = buildRegistrySelectionPlan(manifest, registry, profile, { preferredLicense: "CC0-1.0" });
  assert.equal(plan.issues.length, 0);
  const items = plan.slots.map((slot) => {
    const selected = slot.candidates[0]!;
    const override = overrides[slot.assetId] ?? {};
    return {
      registryId: override.registryId ?? selected.id,
      role: override.role ?? slot.role,
      primitive: override.primitive ?? selected.primitive,
      kind: "sprite" as const,
      title: selected.label,
    };
  });
  const selectionPath = path.join(root, ".loombridge/run/reports/web-selection.json");
  await writeJson(selectionPath, {
    schemaVersion: "1",
    kind: "loombridge-asset-selection",
    generatedBy: "asset-web",
    items,
  });
  return { registryPath, profilePath, selectionPath, items };
}

async function catalogApiFetchForSelection(registryPath: string): Promise<{ fetcher: CatalogFetch; requestedPaths: string[] }> {
  const registry = await loadRegistryPack(registryPath);
  const records = new Map<string, AssetCatalogRecord>(
    adaptRegistryPackToCatalog(registry, {
      reviewedAt: APPROVED_AT,
      reviewer: "Loombridge",
    }).map((record) => [record.id, record]),
  );
  const requestedPaths: string[] = [];
  const fetcher: CatalogFetch = async (url) => {
    const parsed = new URL(url);
    requestedPaths.push(parsed.pathname);
    const prefix = "/v1/assets/";
    if (!parsed.pathname.startsWith(prefix)) {
      throw new Error(`unexpected catalog API path ${parsed.pathname}`);
    }
    const id = decodeURIComponent(parsed.pathname.slice(prefix.length));
    const record = records.get(id);
    if (!record) {
      return { ok: false, status: 404, async text() { return ""; } };
    }
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({ record });
      },
    };
  };
  return { fetcher, requestedPaths };
}

async function catalogApiFetchForPack(registryPath: string, packId: string, count: number): Promise<{
  fetcher: CatalogFetch;
  records: AssetCatalogRecord[];
  requestedUrls: string[];
}> {
  const registry = await loadRegistryPack(registryPath);
  const seed = adaptRegistryPackToCatalog(registry, {
    reviewedAt: APPROVED_AT,
    reviewer: "Loombridge",
  });
  const records = Array.from({ length: count }, (_, index) => {
    const base = JSON.parse(JSON.stringify(seed[index % seed.length]!)) as AssetCatalogRecord;
    return {
      ...base,
      id: `${packId}.asset-${String(index).padStart(3, "0")}`,
      pack: { packId, name: "Blaster Kit" },
      source: {
        ...base.source,
        title: `${base.source.title} ${index}`,
      },
    };
  });
  const requestedUrls: string[] = [];
  const fetcher: CatalogFetch = async (url) => {
    const parsed = new URL(url);
    requestedUrls.push(`${parsed.pathname}?${parsed.searchParams.toString()}`);
    const expectedPath = `/v1/packs/${encodeURIComponent(packId)}/assets`;
    if (parsed.pathname !== expectedPath) {
      throw new Error(`unexpected catalog API path ${parsed.pathname}`);
    }
    const limit = Number(parsed.searchParams.get("limit") ?? "500");
    const offset = Number(parsed.searchParams.get("offset") ?? "0");
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({
          records: records.slice(offset, offset + limit),
          total: records.length,
        });
      },
    };
  };
  return { fetcher, records, requestedUrls };
}

async function catalogApiFetchForSelectionAndPack(args: {
  registryPath: string;
  packId: string;
  packCount: number;
}): Promise<{ fetcher: CatalogFetch; packRecords: AssetCatalogRecord[] }> {
  const selectionApi = await catalogApiFetchForSelection(args.registryPath);
  const packApi = await catalogApiFetchForPack(args.registryPath, args.packId, args.packCount);
  const fetcher: CatalogFetch = async (url, init) => {
    const parsed = new URL(url);
    if (parsed.pathname.startsWith(`/v1/packs/${encodeURIComponent(args.packId)}/assets`)) {
      return packApi.fetcher(url, init);
    }
    return selectionApi.fetcher(url, init);
  };
  return { fetcher, packRecords: packApi.records };
}

test("loombridge assets registry-plan/apply approves the manifest without hand-editing JSON", async () => {
  const root = await tmpRoot();
  await draftManifest(root, "registry");
  const registryPath = path.join(repoRoot, "asset-layer/registry/platformer-2d.json");
  const profilePath = path.join(repoRoot, "asset-layer/profiles/2d-platformer.json");
  const planPath = path.join(root, ".loombridge/run/reports/registry-plan.json");
  const selectionsPath = path.join(root, ".loombridge/run/reports/registry-selections.json");

  assert.equal(await runAssets([
    "registry-plan",
    "--root", root,
    "--registry", registryPath,
    "--profile", profilePath,
    "--preferred-license", "CC0-1.0",
    "--output", planPath,
  ]), 0);

  const payload = JSON.parse(await fs.readFile(planPath, "utf-8")) as {
    plan: { slots: Array<{ assetId: string; selectedId?: string; candidates: Array<{ id: string }> }> };
    pickerSlots: unknown[];
  };
  assert.equal(payload.plan.slots.length > 0, true);
  assert.equal(payload.pickerSlots.length, payload.plan.slots.length);
  const selections = Object.fromEntries(
    payload.plan.slots.map((slot) => [slot.assetId, slot.selectedId ?? slot.candidates[0]!.id]),
  );
  await fs.writeFile(selectionsPath, `${JSON.stringify({ selections }, null, 2)}\n`, "utf-8");

  assert.equal(await runAssets([
    "registry-apply",
    "--root", root,
    "--registry", registryPath,
    "--profile", profilePath,
    "--selections", selectionsPath,
    "--approved-at", APPROVED_AT,
    "--preferred-license", "CC0-1.0",
  ]), 0);

  const approved = await readAssetManifest(loombridgePaths(root));
  assert.equal(approved?.status, "approved");
  assert.equal(approved?.approvedAt, APPROVED_AT);
  assert.ok(approved?.assets.every((asset) => asset.source === "registry"));
  assert.ok(approved?.assets.every((asset) => asset.registrySelection));
});

test("loombridge assets registry-plan/apply approves a 3d-shooter manifest with source-bound model paths", async () => {
  const root = await tmpRoot();
  await draftManifest3dShooter(root);
  const registryPath = path.join(repoRoot, "asset-layer/registry/3d-shooter.json");
  const profilePath = path.join(repoRoot, "asset-layer/profiles/3d-shooter.json");
  const planPath = path.join(root, ".loombridge/run/reports/registry-plan.json");
  const selectionsPath = path.join(root, ".loombridge/run/reports/registry-selections.json");

  assert.equal(await runAssets([
    "registry-plan",
    "--root", root,
    "--registry", registryPath,
    "--profile", profilePath,
    "--preferred-license", "CC0-1.0",
    "--output", planPath,
  ]), 0);

  const payload = JSON.parse(await fs.readFile(planPath, "utf-8")) as {
    plan: { slots: Array<{ assetId: string; selectedId?: string; candidates: Array<{ id: string }> }> };
  };
  assert.equal(payload.plan.slots.length, 8);
  const selections = Object.fromEntries(
    payload.plan.slots.map((slot) => [slot.assetId, slot.selectedId ?? slot.candidates[0]!.id]),
  );
  await fs.writeFile(selectionsPath, `${JSON.stringify({ selections }, null, 2)}\n`, "utf-8");

  assert.equal(await runAssets([
    "registry-apply",
    "--root", root,
    "--registry", registryPath,
    "--profile", profilePath,
    "--selections", selectionsPath,
    "--approved-at", APPROVED_AT,
    "--preferred-license", "CC0-1.0",
  ]), 0);

  const approved = await readAssetManifest(loombridgePaths(root));
  assert.equal(approved?.status, "approved");
  assert.equal(approved?.genre, "3d-shooter");
  assert.ok(approved?.assets.every((asset) => asset.source === "registry" && asset.registrySelection));
  // registrySelection provenance/license/source is present on every approved asset.
  assert.ok(approved?.assets.every((asset) => asset.registrySelection?.license.spdx === "CC0-1.0"));
  assert.ok(approved?.assets.every((asset) => Boolean(asset.registrySelection?.source.provenance.verifiedAt)));
  // Source-bound resolved Unity paths (models under Assets/Models, UI/VFX under Assets/Art).
  const models = approved!.assets.filter((asset) => asset.registrySelection?.primitive.endsWith("_model") || ["arena", "cover_prop", "projectile"].includes(asset.registrySelection?.primitive ?? ""));
  assert.ok(models.length > 0);
  assert.ok(models.every((asset) => asset.resolvedPaths?.[0]?.startsWith("Assets/Models/")));

  // The asset-source fidelity gate passes on the approved, manifest-bound 3d-shooter manifest.
  const report = evaluateAssetSourceFidelity({ manifest: approved! });
  assert.ok(report.checks.every((check) => check.status === "pass"), JSON.stringify(report.checks.filter((c) => c.status !== "pass"), null, 2));
});

test("loombridge assets registry-plan/apply can use a hosted catalog source instead of a registry pack", async () => {
  const root = await tmpRoot();
  await draftManifest(root, "registry");
  const registryPath = path.join(repoRoot, "asset-layer/registry/platformer-2d.json");
  const profilePath = path.join(repoRoot, "asset-layer/profiles/2d-platformer.json");
  const catalogPath = path.join(root, "catalog.json");
  const planPath = path.join(root, ".loombridge/run/reports/catalog-plan.json");
  const selectionsPath = path.join(root, ".loombridge/run/reports/catalog-selections.json");
  const registry = await loadRegistryPack(registryPath);
  const catalog = {
    schemaVersion: "1",
    catalogId: "platformer-catalog-test",
    assets: adaptRegistryPackToCatalog(registry, {
      reviewedAt: APPROVED_AT,
      reviewer: "Loombridge",
    }),
  };
  await fs.writeFile(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`, "utf-8");

  assert.equal(await runAssets([
    "registry-plan",
    "--root", root,
    "--catalog", catalogPath,
    "--profile", profilePath,
    "--preferred-license", "CC0-1.0",
    "--output", planPath,
  ]), 0);

  const payload = JSON.parse(await fs.readFile(planPath, "utf-8")) as {
    plan: { pack: { id: string }; slots: Array<{ assetId: string; selectedId?: string; candidates: Array<{ id: string }> }> };
  };
  assert.equal(payload.plan.pack.id, "platformer-2d");
  assert.ok(payload.plan.slots.every((slot) => slot.selectedId));

  const selections = Object.fromEntries(
    payload.plan.slots.map((slot) => [slot.assetId, slot.selectedId ?? slot.candidates[0]!.id]),
  );
  await fs.writeFile(selectionsPath, `${JSON.stringify({ selections }, null, 2)}\n`, "utf-8");

  assert.equal(await runAssets([
    "registry-apply",
    "--root", root,
    "--catalog", catalogPath,
    "--profile", profilePath,
    "--selections", selectionsPath,
    "--approved-at", APPROVED_AT,
    "--preferred-license", "CC0-1.0",
  ]), 0);

  const approved = await readAssetManifest(loombridgePaths(root));
  assert.equal(approved?.status, "approved");
  assert.equal(approved?.assetSources.find((source) => source.kind === "registry-pack")?.registry, "platformer-2d");
  assert.ok(approved?.assets.every((asset) => asset.source === "registry"));
});

test("loombridge assets registry-apply --from-selection maps role-keyed web selections", async () => {
  const root = await tmpRoot();
  await draftManifest(root, "registry");
  const { registryPath, profilePath, selectionPath } = await webSelectionForPlan(root);

  assert.equal(await runAssets([
    "registry-apply",
    "--root", root,
    "--registry", registryPath,
    "--profile", profilePath,
    "--from-selection", selectionPath,
    "--approved-at", APPROVED_AT,
    "--preferred-license", "CC0-1.0",
  ]), 0);

  const approved = await readAssetManifest(loombridgePaths(root));
  assert.equal(approved?.status, "approved");
  assert.equal(approved?.approvedAt, APPROVED_AT);
  assert.ok(approved?.assets.every((asset) => asset.source === "registry"));
  assert.ok(approved?.assets.every((asset) => asset.registrySelection?.registryAssetId));
});

test("loombridge assets registry-apply --from-selection --catalog-api resolves exact selection ids", async () => {
  const root = await tmpRoot();
  await draftManifest(root, "registry");
  const { registryPath, profilePath, selectionPath, items } = await webSelectionForPlan(root);
  const { fetcher, requestedPaths } = await catalogApiFetchForSelection(registryPath);

  assert.equal(await runAssets([
    "registry-apply",
    "--root", root,
    "--catalog-api", "https://api.example.invalid",
    "--profile", profilePath,
    "--from-selection", selectionPath,
    "--approved-at", APPROVED_AT,
    "--preferred-license", "CC0-1.0",
  ], { catalogFetch: fetcher }), 0);

  const approved = await readAssetManifest(loombridgePaths(root));
  assert.equal(approved?.status, "approved");
  assert.ok(approved?.assets.every((asset) => asset.source === "registry"));
  assert.ok(requestedPaths.every((requestPath) => requestPath.startsWith("/v1/assets/")));
  assert.equal(requestedPaths.some((requestPath) => requestPath === "/v1/assets/search"), false);
  assert.deepEqual(
    [...new Set(requestedPaths)].sort(),
    [...new Set(items.map((item) => `/v1/assets/${encodeURIComponent(item.registryId)}`))].sort(),
  );
});

test("loombridge assets registry-apply --from-selection accepts schema v2 asset-only selections", async () => {
  const root = await tmpRoot();
  await draftManifest(root, "registry");
  const { registryPath, profilePath, selectionPath, items } = await webSelectionForPlan(root);
  await writeJson(selectionPath, {
    schemaVersion: "2",
    kind: "loombridge-asset-selection",
    generatedBy: "asset-web",
    items: items.map((item) => ({ type: "asset", ...item })),
  });

  assert.equal(await runAssets([
    "registry-apply",
    "--root", root,
    "--registry", registryPath,
    "--profile", profilePath,
    "--from-selection", selectionPath,
    "--approved-at", APPROVED_AT,
    "--preferred-license", "CC0-1.0",
  ]), 0);

  const approved = await readAssetManifest(loombridgePaths(root));
  assert.equal(approved?.status, "approved");
  assert.ok(approved?.assets.every((asset) => asset.source === "registry"));
});

test("loombridge assets registry-apply --from-selection imports schema v2 pack items with paged catalog assets idempotently", async () => {
  const root = await tmpRoot();
  await draftManifest(root, "registry");
  const registryPath = path.join(repoRoot, "asset-layer/registry/platformer-2d.json");
  const profilePath = path.join(repoRoot, "asset-layer/profiles/2d-platformer.json");
  const selectionPath = path.join(root, ".loombridge/run/reports/web-selection.json");
  const packId = "kenney.3d-assets.blaster-kit";
  await writeJson(selectionPath, {
    schemaVersion: "2",
    kind: "loombridge-asset-selection",
    generatedBy: "asset-web",
    items: [{ type: "pack", packId, name: "Blaster Kit", genre: "3d-assets", assetCount: 501 }],
  });
  const { fetcher, records, requestedUrls } = await catalogApiFetchForPack(registryPath, packId, 501);
  const registryPackPath = path.join(root, ".loombridge/registry", `${packId}.json`);

  const args = [
    "registry-apply",
    "--root", root,
    "--catalog-api", "https://api.example.invalid",
    "--profile", profilePath,
    "--from-selection", selectionPath,
    "--approved-at", APPROVED_AT,
  ];
  assert.equal(await runAssets(args, { catalogFetch: fetcher }), 0);
  const first = await fs.readFile(registryPackPath, "utf-8");
  assert.equal(await runAssets(args, { catalogFetch: fetcher }), 0);
  const second = await fs.readFile(registryPackPath, "utf-8");
  assert.equal(second, first);

  const imported = JSON.parse(first) as { packId: string; name: string; entries: Array<{ id: string }> };
  assert.equal(imported.packId, packId);
  assert.equal(imported.name, "Blaster Kit");
  assert.equal(imported.entries.length, records.length);
  assert.deepEqual(imported.entries.map((entry) => entry.id), records.map((record) => record.id).sort());
  assert.ok(requestedUrls.includes(`/v1/packs/${packId}/assets?limit=500&offset=0`));
  assert.ok(requestedUrls.includes(`/v1/packs/${packId}/assets?limit=500&offset=500`));
});

test("loombridge assets registry-apply --from-selection pack-only skips manifest slot fill", async () => {
  const root = await tmpRoot();
  await draftManifest(root, "registry");
  const manifestPath = path.join(root, ".loombridge/ASSET_MANIFEST.json");
  const before = await fs.readFile(manifestPath, "utf-8");
  const registryPath = path.join(repoRoot, "asset-layer/registry/platformer-2d.json");
  const profilePath = path.join(repoRoot, "asset-layer/profiles/2d-platformer.json");
  const selectionPath = path.join(root, ".loombridge/run/reports/web-selection.json");
  const packId = "kenney.ui-space-shooter";
  await writeJson(selectionPath, {
    schemaVersion: "2",
    kind: "loombridge-asset-selection",
    generatedBy: "asset-web",
    items: [{ type: "pack", packId }],
  });
  const { fetcher } = await catalogApiFetchForPack(registryPath, packId, 3);

  assert.equal(await runAssets([
    "registry-apply",
    "--root", root,
    "--catalog-api", "https://api.example.invalid",
    "--profile", profilePath,
    "--from-selection", selectionPath,
    "--approved-at", APPROVED_AT,
  ], { catalogFetch: fetcher }), 0);

  assert.equal(await fs.readFile(manifestPath, "utf-8"), before);
  const imported = JSON.parse(await fs.readFile(path.join(root, ".loombridge/registry", `${packId}.json`), "utf-8")) as { entries: unknown[] };
  assert.equal(imported.entries.length, 3);
});

test("loombridge assets registry-apply --from-selection mixed v2 applies asset selections and imports packs atomically", async () => {
  const root = await tmpRoot();
  await draftManifest(root, "registry");
  const { registryPath, profilePath, selectionPath, items } = await webSelectionForPlan(root);
  const packId = "kenney.3d-assets.blaster-kit";
  await writeJson(selectionPath, {
    schemaVersion: "2",
    kind: "loombridge-asset-selection",
    generatedBy: "asset-web",
    items: [
      ...items,
      { type: "pack", packId, name: "Blaster Kit" },
    ],
  });
  const { fetcher, packRecords } = await catalogApiFetchForSelectionAndPack({ registryPath, packId, packCount: 4 });

  assert.equal(await runAssets([
    "registry-apply",
    "--root", root,
    "--catalog-api", "https://api.example.invalid",
    "--profile", profilePath,
    "--from-selection", selectionPath,
    "--approved-at", APPROVED_AT,
    "--preferred-license", "CC0-1.0",
  ], { catalogFetch: fetcher }), 0);

  const approved = await readAssetManifest(loombridgePaths(root));
  assert.equal(approved?.status, "approved");
  const imported = JSON.parse(await fs.readFile(path.join(root, ".loombridge/registry", `${packId}.json`), "utf-8")) as { entries: unknown[] };
  assert.equal(imported.entries.length, packRecords.length);
});

test("loombridge assets registry-apply --from-selection aborts mixed v2 without partial writes on invalid pack", async () => {
  const root = await tmpRoot();
  await draftManifest(root, "registry");
  const manifestPath = path.join(root, ".loombridge/ASSET_MANIFEST.json");
  const before = await fs.readFile(manifestPath, "utf-8");
  const { registryPath, profilePath, selectionPath, items } = await webSelectionForPlan(root);
  const badPackId = "kenney.missing-pack";
  await writeJson(selectionPath, {
    schemaVersion: "2",
    kind: "loombridge-asset-selection",
    generatedBy: "asset-web",
    items: [
      ...items,
      { type: "pack", packId: badPackId },
    ],
  });
  const selectionApi = await catalogApiFetchForSelection(registryPath);
  const fetcher: CatalogFetch = async (url, init) => {
    const parsed = new URL(url);
    if (parsed.pathname.startsWith(`/v1/packs/${badPackId}/assets`)) {
      return { ok: false, status: 404, async text() { return ""; } };
    }
    return selectionApi.fetcher(url, init);
  };

  const result = await captureStderr(() => runAssets([
    "registry-apply",
    "--root", root,
    "--catalog-api", "https://api.example.invalid",
    "--profile", profilePath,
    "--from-selection", selectionPath,
    "--approved-at", APPROVED_AT,
    "--preferred-license", "CC0-1.0",
  ], { catalogFetch: fetcher }));

  assert.equal(result.code, 1);
  assert.match(result.err, /Catalog pack 'kenney\.missing-pack' not found/);
  assert.equal(await fs.readFile(manifestPath, "utf-8"), before);
  await assert.rejects(fs.stat(path.join(root, ".loombridge/registry", `${badPackId}.json`)), /ENOENT/);
});

test("loombridge assets registry-apply --from-selection rejects pack items under schema v1", async () => {
  const root = await tmpRoot();
  await draftManifest(root, "registry");
  const before = await fs.readFile(path.join(root, ".loombridge/ASSET_MANIFEST.json"), "utf-8");
  const registryPath = path.join(repoRoot, "asset-layer/registry/platformer-2d.json");
  const profilePath = path.join(repoRoot, "asset-layer/profiles/2d-platformer.json");
  const selectionPath = path.join(root, ".loombridge/run/reports/web-selection.json");
  await writeJson(selectionPath, {
    schemaVersion: "1",
    kind: "loombridge-asset-selection",
    generatedBy: "asset-web",
    items: [{ type: "pack", packId: "kenney.3d-assets.blaster-kit" }],
  });

  const result = await captureStderr(() => runAssets([
    "registry-apply",
    "--root", root,
    "--catalog-api", "https://api.example.invalid",
    "--profile", profilePath,
    "--from-selection", selectionPath,
    "--approved-at", APPROVED_AT,
  ]));

  assert.equal(result.code, 1);
  assert.match(result.err, /pack.*require schemaVersion '2'/);
  assert.equal(await fs.readFile(path.join(root, ".loombridge/ASSET_MANIFEST.json"), "utf-8"), before);
  await assert.rejects(fs.stat(path.join(root, ".loombridge/registry")), /ENOENT/);
});

test("loombridge assets registry-apply --from-selection rejects invalid pack ids without writing", async () => {
  const root = await tmpRoot();
  await draftManifest(root, "registry");
  const before = await fs.readFile(path.join(root, ".loombridge/ASSET_MANIFEST.json"), "utf-8");
  const registryPath = path.join(repoRoot, "asset-layer/registry/platformer-2d.json");
  const profilePath = path.join(repoRoot, "asset-layer/profiles/2d-platformer.json");
  const selectionPath = path.join(root, ".loombridge/run/reports/web-selection.json");
  await writeJson(selectionPath, {
    schemaVersion: "2",
    kind: "loombridge-asset-selection",
    generatedBy: "asset-web",
    items: [{ type: "pack", packId: "../bad" }],
  });

  const result = await captureStderr(() => runAssets([
    "registry-apply",
    "--root", root,
    "--catalog-api", "https://api.example.invalid",
    "--profile", profilePath,
    "--from-selection", selectionPath,
    "--approved-at", APPROVED_AT,
  ]));

  assert.equal(result.code, 1);
  assert.match(result.err, /packId must match/);
  assert.equal(await fs.readFile(path.join(root, ".loombridge/ASSET_MANIFEST.json"), "utf-8"), before);
  await assert.rejects(fs.stat(path.join(root, ".loombridge/registry")), /ENOENT/);
});

test("loombridge assets registry-apply --from-selection --catalog-api refuses unresolved selection ids without writing", async () => {
  const root = await tmpRoot();
  await draftManifest(root, "registry");
  const before = await fs.readFile(path.join(root, ".loombridge/ASSET_MANIFEST.json"), "utf-8");
  const { registryPath, profilePath, selectionPath, items } = await webSelectionForPlan(root);
  items[0] = { ...items[0]!, registryId: "missing.hosted.catalog.id" };
  await writeJson(selectionPath, {
    schemaVersion: "1",
    kind: "loombridge-asset-selection",
    generatedBy: "asset-web",
    items,
  });
  const { fetcher } = await catalogApiFetchForSelection(registryPath);

  const result = await captureStderr(() => runAssets([
    "registry-apply",
    "--root", root,
    "--catalog-api", "https://api.example.invalid",
    "--profile", profilePath,
    "--from-selection", selectionPath,
    "--approved-at", APPROVED_AT,
    "--preferred-license", "CC0-1.0",
  ], { catalogFetch: fetcher }));

  assert.equal(result.code, 1);
  assert.match(result.err, /Unknown registryId 'missing\.hosted\.catalog\.id'/);
  assert.equal(await fs.readFile(path.join(root, ".loombridge/ASSET_MANIFEST.json"), "utf-8"), before);
});

test("loombridge assets registry-apply --from-selection falls back from primitive role to manifest slot", async () => {
  const root = await tmpRoot();
  const manifest = await draftManifest(root, "registry");
  const player = manifest.assets.find((asset) => asset.role === "player-character");
  assert.ok(player);
  const { registryPath, profilePath, selectionPath } = await webSelectionForPlan(root, {
    [player.id]: { role: "player" },
  });

  assert.equal(await runAssets([
    "registry-apply",
    "--root", root,
    "--registry", registryPath,
    "--profile", profilePath,
    "--from-selection", selectionPath,
    "--approved-at", APPROVED_AT,
    "--preferred-license", "CC0-1.0",
  ]), 0);

  const approved = await readAssetManifest(loombridgePaths(root));
  assert.equal(approved?.status, "approved");
  assert.equal(approved?.assets.find((asset) => asset.id === player.id)?.registrySelection?.primitive, "player");
});

test("loombridge assets registry-apply --from-selection refuses ambiguous primitive mappings without writing", async () => {
  const root = await tmpRoot();
  await draftManifest(root, "registry");
  const before = await fs.readFile(path.join(root, ".loombridge/ASSET_MANIFEST.json"), "utf-8");
  const { registryPath, profilePath, selectionPath, items } = await webSelectionForPlan(root);
  const tileItem = items.find((item) => item.primitive === "tile");
  assert.ok(tileItem);
  await writeJson(selectionPath, {
    schemaVersion: "1",
    kind: "loombridge-asset-selection",
    generatedBy: "asset-web",
    items: [{ ...tileItem, role: "tile" }],
  });

  const result = await captureStderr(() => runAssets([
    "registry-apply",
    "--root", root,
    "--registry", registryPath,
    "--profile", profilePath,
    "--from-selection", selectionPath,
    "--approved-at", APPROVED_AT,
    "--preferred-license", "CC0-1.0",
  ]));

  assert.equal(result.code, 1);
  assert.match(result.err, /Ambiguous web selection/);
  assert.match(result.err, /platform_tiles/);
  assert.equal(await fs.readFile(path.join(root, ".loombridge/ASSET_MANIFEST.json"), "utf-8"), before);
});

test("loombridge assets registry-apply --from-selection refuses unknown registryId", async () => {
  const root = await tmpRoot();
  await draftManifest(root, "registry");
  const before = await fs.readFile(path.join(root, ".loombridge/ASSET_MANIFEST.json"), "utf-8");
  const { registryPath, profilePath, selectionPath, items } = await webSelectionForPlan(root);
  items[0] = { ...items[0]!, registryId: "missing.registry.entry" };
  await writeJson(selectionPath, {
    schemaVersion: "1",
    kind: "loombridge-asset-selection",
    generatedBy: "asset-web",
    items,
  });

  const result = await captureStderr(() => runAssets([
    "registry-apply",
    "--root", root,
    "--registry", registryPath,
    "--profile", profilePath,
    "--from-selection", selectionPath,
    "--approved-at", APPROVED_AT,
    "--preferred-license", "CC0-1.0",
  ]));

  assert.equal(result.code, 1);
  assert.match(result.err, /Unknown registryId 'missing\.registry\.entry'/);
  assert.equal(await fs.readFile(path.join(root, ".loombridge/ASSET_MANIFEST.json"), "utf-8"), before);
});

test("loombridge assets registry-apply --from-selection rejects malformed selection JSON before writing", async () => {
  const root = await tmpRoot();
  await draftManifest(root, "registry");
  const before = await fs.readFile(path.join(root, ".loombridge/ASSET_MANIFEST.json"), "utf-8");
  const registryPath = path.join(repoRoot, "asset-layer/registry/platformer-2d.json");
  const profilePath = path.join(repoRoot, "asset-layer/profiles/2d-platformer.json");
  const selectionPath = path.join(root, ".loombridge/run/reports/web-selection.json");
  await writeJson(selectionPath, {
    schemaVersion: "1",
    kind: "not-loombridge",
    items: [{ registryId: "kenney.pixel-platformer.player.sheet" }],
  });

  const result = await captureStderr(() => runAssets([
    "registry-apply",
    "--root", root,
    "--registry", registryPath,
    "--profile", profilePath,
    "--from-selection", selectionPath,
    "--approved-at", APPROVED_AT,
  ]));

  assert.equal(result.code, 1);
  assert.match(result.err, /kind must be 'loombridge-asset-selection'/);
  assert.equal(await fs.readFile(path.join(root, ".loombridge/ASSET_MANIFEST.json"), "utf-8"), before);
});

test("loombridge assets registry-apply --from-selection --strict-roles refuses primitive-only unfilled slots", async () => {
  const root = await tmpRoot();
  const manifest = await draftManifest(root, "registry");
  const player = manifest.assets.find((asset) => asset.role === "player-character");
  assert.ok(player);
  const before = await fs.readFile(path.join(root, ".loombridge/ASSET_MANIFEST.json"), "utf-8");
  const { registryPath, profilePath, selectionPath } = await webSelectionForPlan(root, {
    [player.id]: { role: "player" },
  });

  const result = await captureStderr(() => runAssets([
    "registry-apply",
    "--root", root,
    "--registry", registryPath,
    "--profile", profilePath,
    "--from-selection", selectionPath,
    "--approved-at", APPROVED_AT,
    "--preferred-license", "CC0-1.0",
    "--strict-roles",
  ]));

  assert.equal(result.code, 1);
  assert.match(result.err, /No manifest slot matches/);
  assert.match(result.err, /Unfilled manifest slot\(s\): player_character \(player-character\)/);
  assert.equal(await fs.readFile(path.join(root, ".loombridge/ASSET_MANIFEST.json"), "utf-8"), before);
});

test("loombridge assets registry-apply --from-selection is deterministic for identical inputs", async () => {
  const root = await tmpRoot();
  await draftManifest(root, "registry");
  const manifestPath = path.join(root, ".loombridge/ASSET_MANIFEST.json");
  const before = await fs.readFile(manifestPath, "utf-8");
  const { registryPath, profilePath, selectionPath } = await webSelectionForPlan(root);
  const args = [
    "registry-apply",
    "--root", root,
    "--registry", registryPath,
    "--profile", profilePath,
    "--from-selection", selectionPath,
    "--approved-at", APPROVED_AT,
    "--preferred-license", "CC0-1.0",
  ];

  assert.equal(await runAssets(args), 0);
  const first = await fs.readFile(manifestPath, "utf-8");
  await fs.writeFile(manifestPath, before, "utf-8");
  assert.equal(await runAssets(args), 0);
  const second = await fs.readFile(manifestPath, "utf-8");
  assert.equal(second, first);
});

test("loombridge assets generated-plan/apply approves generated exports with provenance", async () => {
  const root = await tmpRoot();
  const manifest = await draftManifest(root, "generated");
  const annotationsPath = path.join(root, ".loombridge/run/reports/generated-annotations.json");
  const planPath = path.join(root, ".loombridge/run/reports/generated-plan.json");
  const exportsPath = path.join(root, ".loombridge/run/reports/generated-exports.json");

  const annotations: GeneratedAssetAnnotation[] = manifest.assets.map((asset, i) => ({
    annotationId: `ann-${asset.id}`,
    role: asset.role as RequiredAssetRole,
    heroRegion: { x: i * 4, y: i * 4, w: 32, h: 32 },
    requiredOutputs: asset.role === "parallax-background" ? ["back", "middle", "front"] : ["main"],
    prompt: `Export ${asset.role}.`,
    styleLock: `match ${asset.role}`,
  }));
  await fs.mkdir(path.dirname(annotationsPath), { recursive: true });
  await fs.writeFile(annotationsPath, `${JSON.stringify({ annotations }, null, 2)}\n`, "utf-8");

  assert.equal(await runAssets([
    "generated-plan",
    "--root", root,
    "--annotations", annotationsPath,
    "--output", planPath,
  ]), 0);

  const plan = JSON.parse(await fs.readFile(planPath, "utf-8")) as {
    slots: Array<{ assetId: string; role: string; requiredOutputs: string[] }>;
    producedFromHash: string;
  };
  const exports: GeneratedAssetExportInput[] = plan.slots.map((slot) => ({
    assetId: slot.assetId,
    paths: slot.requiredOutputs.map((output) => `Assets/Art/Generated/${slot.assetId}-${output}.png`),
    generator: "test-exporter",
    producedAt: APPROVED_AT,
    license: "project-generated",
    provenance: {
      origin: "hero-shot-annotation",
      tool: "test",
      notes: `exported ${slot.role}`,
    },
  }));
  await fs.writeFile(exportsPath, `${JSON.stringify({ exports }, null, 2)}\n`, "utf-8");

  assert.equal(await runAssets([
    "generated-apply",
    "--root", root,
    "--annotations", annotationsPath,
    "--exports", exportsPath,
    "--approved-at", APPROVED_AT,
  ]), 0);

  const approved = await readAssetManifest(loombridgePaths(root));
  assert.equal(approved?.status, "approved");
  assert.equal(approved?.approvedAt, APPROVED_AT);
  assert.ok(approved?.assets.every((asset) => asset.source === "generated"));
  assert.ok(approved?.assets.every((asset) => asset.generatedExport?.provenance.origin === "hero-shot-annotation"));
});

test("loombridge assets resolves path flags against --root even when --root is last", async () => {
  const root = await tmpRoot();
  const manifest = await draftManifest(root, "generated");
  const annotationsPath = path.join(root, ".loombridge/run/reports/generated-annotations.json");
  const outputRel = ".loombridge/run/reports/generated-plan-root-last.json";

  const annotations: GeneratedAssetAnnotation[] = manifest.assets.map((asset) => ({
    annotationId: `ann-${asset.id}`,
    role: asset.role as RequiredAssetRole,
    requiredOutputs: ["main"],
    prompt: `Export ${asset.role}.`,
  }));
  await fs.mkdir(path.dirname(annotationsPath), { recursive: true });
  await fs.writeFile(annotationsPath, `${JSON.stringify({ annotations }, null, 2)}\n`, "utf-8");

  assert.equal(await runAssets([
    "generated-plan",
    "--annotations", ".loombridge/run/reports/generated-annotations.json",
    "--output", outputRel,
    "--root", root,
  ]), 0);

  const plan = JSON.parse(await fs.readFile(path.join(root, outputRel), "utf-8")) as { slots: unknown[] };
  assert.equal(plan.slots.length, manifest.assets.length);
});
