import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { readImageMetadata } from "../asset-layer/image-metadata.js";
import { loadAssetProfile, loadRegistryPack, selectAssets } from "../asset-layer/registry.js";
import { prepareAssets } from "../asset-layer/prepare-cli.js";
import type { CatalogFetch } from "../asset-layer/catalog-source.js";
import type { AssetProviderAdapter } from "../asset-layer/providers/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../../..");

test("asset resolver selects deterministic platformer entries by primitive and license", async () => {
  const registry = await loadRegistryPack(path.join(repoRoot, "asset-layer/registry/platformer-2d.json"));
  const selected = selectAssets(registry, {
    genre: "platformer-2d",
    primitives: ["tile", "player", "collectible"],
    preferredLicense: "CC0-1.0",
    tags: ["platformer"],
  });

  assert.deepEqual(
    selected.map((entry) => entry.primitive),
    ["tile", "player", "collectible"],
  );
  assert.deepEqual(
    selected.map((entry) => entry.id),
    [
      "kenney.pixel-platformer.tile.sheet",
      "kenney.pixel-platformer.player.sheet",
      "kenney.pixel-platformer.collectible.sheet",
    ],
  );
});

test("asset resolver can select scanned HTTP CC0 alternatives by tags", async () => {
  const registry = await loadRegistryPack(path.join(repoRoot, "asset-layer/registry/platformer-2d.json"));
  const simple = selectAssets(registry, {
    genre: "platformer-2d",
    primitives: ["tile", "collectible"],
    preferredLicense: "CC0-1.0",
    tags: ["simple"],
  });
  const scifi = selectAssets(registry, {
    genre: "platformer-2d",
    primitives: ["tile"],
    preferredLicense: "CC0-1.0",
    tags: ["scifi"],
  });

  assert.deepEqual(
    simple.map((entry) => entry.id),
    [
      "opengameart.simple.tile.vvvvvv",
      "opengameart.simple.collectible.coin",
    ],
  );
  assert.deepEqual(scifi.map((entry) => entry.id), ["opengameart.scifi.tile.sheet"]);
  assert.equal(simple.every((entry) => entry.provider.type === "http"), true);
  assert.equal(scifi.every((entry) => entry.provider.type === "http"), true);
});

test("image metadata parser reads PNG dimensions without image dependencies", async () => {
  const metadata = await readImageMetadata(path.join(repoRoot, "asset-layer/fixtures/platformer/grass-tile.png"));

  assert.deepEqual(metadata, {
    format: "png",
    width: 64,
    height: 64,
  });
});

test("prepareAssets writes deterministic cache files and report metadata", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "loombridge-asset-prepare-"));
  const cacheDir = path.join(tempDir, "cache");
  const outputPath = path.join(tempDir, "platformer-assets.json");

  const report = await prepareAssets({
    profilePath: path.join(repoRoot, "asset-layer/profiles/2d-platformer.json"),
    registryPath: path.join(repoRoot, "asset-layer/registry/platformer-2d.json"),
    cacheDir,
    outputPath,
    genre: "platformer-2d",
    primitives: ["player", "tile", "collectible"],
    preferredLicense: "CC0-1.0",
  });

  const profile = await loadAssetProfile(path.join(repoRoot, "asset-layer/profiles/2d-platformer.json"));
  const written = JSON.parse(await fs.readFile(outputPath, "utf-8")) as typeof report;

  assert.equal(report.status, "pass");
  assert.equal(written.status, "pass");
  assert.equal(written.profile.id, profile.id);
  assert.equal(written.assets.length, 3);
  assert.equal(report.diagnostics.placeholder, 0);
  assert.deepEqual(
    written.assets.map((asset) => asset.id),
    [
      "kenney.pixel-platformer.player.sheet",
      "kenney.pixel-platformer.tile.sheet",
      "kenney.pixel-platformer.collectible.sheet",
    ],
  );
  assert.ok(written.assets.every((asset) => asset.placeholder === false));

  for (const asset of written.assets) {
    assert.equal(asset.status, "accepted");
    assert.ok(asset.cachePath.startsWith(cacheDir), `cache path should be under ${cacheDir}`);
    assert.ok(asset.unityPath.startsWith("Assets/Art/"), "unity path should be organized under Assets/Art");
    assert.ok(asset.import, "sprite asset should include a Unity import plan");
    assert.ok(asset.import.toolArguments.source_path, "source_path should be present for unity_asset_create_sprite");
    assert.equal(asset.import.toolArguments.path, asset.unityPath);
    assert.equal(asset.import.toolArguments.sprite_mode, "multiple");
    assert.ok(asset.import.toolArguments.slicing, "real platformer sheets should include Unity slicing metadata");
    assert.equal(asset.license.spdx, "CC0-1.0");
    assert.ok(asset.source.url.startsWith("https://"));
    assert.equal((await fs.stat(asset.cachePath)).isFile(), true);
  }
});

test("prepareAssets selects + prepares a trusted-default record from the hosted search API (network-free)", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "loombridge-api-prepare-"));
  const cacheDir = path.join(tempDir, "cache");
  const outputPath = path.join(tempDir, "api-assets.json");

  // Real CC0 bytes for a trusted-default tile, pinned by sha256 so the checksum gate is real.
  const sourceImage = path.join(repoRoot, "asset-layer/fixtures/platformer/grass-tile.png");
  const sourceBytes = await fs.readFile(sourceImage);
  const sourceSha = crypto.createHash("sha256").update(sourceBytes).digest("hex");

  // The hosted DB-backed search API returns this trusted-default tile record over a public url.
  const apiRecord = {
    id: "api.trusted.tile.grass",
    genre: "platformer-2d",
    primitive: "tile",
    kind: "sprite",
    priority: 20,
    source: {
      title: "Pixel Platformer Grass",
      url: "https://kenney.nl/assets/pixel-platformer",
      author: "Kenney",
      verified: true,
      provenance: {
        verifiedAt: "2026-06-05T00:00:00.000Z",
        origin: "Hosted search API trusted-default tile.",
        fixture: "api-search",
      },
    },
    license: {
      name: "Creative Commons CC0 1.0 Universal",
      spdx: "CC0-1.0",
      url: "https://creativecommons.org/publicdomain/zero/1.0/",
      requiresAttribution: false,
    },
    provider: {
      name: "Kenney",
      url: "https://kenney.nl/",
      type: "http",
      acquisitionLane: "mirror-index",
    },
    files: [{
      role: "sprite",
      format: "png",
      url: "https://pub-test.r2.dev/kenney/2d-platformer/tile/grass-tile.png",
      checksum: { algorithm: "sha256", value: sourceSha },
    }],
    technical: { width: 64, height: 64, pixelsPerUnit: 100, transparent: true },
    tags: ["platformer", "tile", "grass", "cc0"],
    unity: { path: "Assets/Art/Sprites/Tiles/api-grass.png", pixelsPerUnit: 100, spriteMode: "single", filterMode: "Point" },
    acquisitionLane: "mirror-index",
    trustTier: "trusted-default",
    review: {
      status: "verified",
      verifiedBy: "loombridge",
      verifiedAt: "2026-06-05T00:00:00.000Z",
      reviewer: "loombridge-core",
    },
  };

  let requestedUrl: string | undefined;
  const catalogFetch: CatalogFetch = async (url) => {
    requestedUrl = url;
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({ records: [apiRecord] });
      },
    };
  };

  // Injected provider resolves the record's bytes (the real CC0 fixture) without any network —
  // reuses the Task-7 injected-provider seam so the byte download stays network-free.
  const byteProvider: AssetProviderAdapter = {
    name: "test-api-bytes",
    canResolve: (_entry, file) => Boolean(file.url),
    async resolve({ cachePath }) {
      await fs.mkdir(path.dirname(cachePath), { recursive: true });
      await fs.writeFile(cachePath, sourceBytes);
      return { status: "resolved", cachePath, cacheStatus: "miss", diagnostics: [] };
    },
  };

  const report = await prepareAssets(
    {
      profilePath: path.join(repoRoot, "asset-layer/profiles/2d-platformer.json"),
      catalogApiUrl: "https://api.test",
      catalogFetch,
      cacheDir,
      outputPath,
      primitives: ["tile"],
      preferredLicense: "CC0-1.0",
    },
    { providers: [byteProvider] },
  );
  const written = JSON.parse(await fs.readFile(outputPath, "utf-8")) as typeof report;

  // The catalog came from the search API endpoint.
  assert.ok(requestedUrl);
  assert.equal(new URL(requestedUrl!).pathname, "/v1/assets/search");

  // The trusted-default API record was selected + prepared (checksum-verified) from the API source.
  assert.equal(report.status, "pass");
  assert.deepEqual(written.assets.map((asset) => asset.id), ["api.trusted.tile.grass"]);
  assert.equal(written.assets[0]?.status, "accepted");
  assert.equal(written.assets[0]?.checksum?.value, sourceSha);
  assert.equal((await fs.stat(written.assets[0]!.cachePath)).isFile(), true);

  await fs.rm(tempDir, { recursive: true, force: true });
});

test("prepareAssets accepts a source-bound local GLB model without sprite validation", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "loombridge-model-prepare-"));
  const registryDir = path.join(tempDir, "asset-layer/registry");
  const fixtureDir = path.join(tempDir, "asset-layer/fixtures/3d-shooter");
  const cacheDir = path.join(tempDir, "cache");
  const outputPath = path.join(tempDir, "model-assets.json");
  const glbPath = path.join(fixtureDir, "player.glb");
  await fs.mkdir(fixtureDir, { recursive: true });
  await fs.writeFile(glbPath, Buffer.from("glTF-binary-fixture"));

  const registryPath = path.join(registryDir, "3d-shooter-local.json");
  await fs.mkdir(registryDir, { recursive: true });
  await fs.writeFile(registryPath, `${JSON.stringify({
    schemaVersion: "1",
    packId: "3d-shooter-local",
    name: "3D Shooter Local Model",
    entries: [{
      id: "fixture.player.model",
      genre: "3d-shooter",
      primitive: "player_model",
      kind: "model",
      priority: 10,
      source: {
        title: "Fixture Player Model",
        url: "https://example.test/player-model",
        author: "Fixture",
        verified: true,
        provenance: {
          verifiedAt: "2026-06-26T00:00:00.000Z",
          origin: "unit-test local GLB fixture",
        },
      },
      license: {
        name: "Creative Commons CC0 1.0 Universal",
        spdx: "CC0-1.0",
        url: "https://creativecommons.org/publicdomain/zero/1.0/",
        requiresAttribution: false,
      },
      provider: {
        name: "Fixture",
        url: "https://example.test/provider",
        type: "local",
      },
      files: [{
        role: "model",
        format: "glb",
        localPath: "asset-layer/fixtures/3d-shooter/player.glb",
      }],
      technical: {},
      tags: ["3d-shooter", "player", "model", "verified"],
      unity: {
        path: "Assets/Models/Player/fixture-player.glb",
        pixelsPerUnit: 1,
      },
    }],
  }, null, 2)}\n`, "utf-8");

  const report = await prepareAssets({
    profilePath: path.join(repoRoot, "asset-layer/profiles/3d-shooter.json"),
    registryPath,
    cacheDir,
    outputPath,
    genre: "3d-shooter",
    primitives: ["player_model"],
    preferredLicense: "CC0-1.0",
  });
  const written = JSON.parse(await fs.readFile(outputPath, "utf-8")) as typeof report;

  assert.equal(report.status, "pass");
  assert.equal(written.assets.length, 1);
  const [asset] = written.assets;
  assert.equal(asset?.id, "fixture.player.model");
  assert.equal(asset?.kind, "model");
  assert.equal(asset?.status, "accepted");
  assert.equal(asset?.unityPath, "Assets/Models/Player/fixture-player.glb");
  assert.equal(asset?.import, undefined, "model assets are path-bound but do not use sprite import tooling");
  assert.equal(asset?.rejections.length, 0);
  assert.equal((await fs.stat(asset!.cachePath)).isFile(), true);

  await fs.rm(tempDir, { recursive: true, force: true });
});

test("prepareAssets rejects passing both catalogApiUrl and catalogPath", async () => {
  await assert.rejects(
    () => prepareAssets({
      profilePath: path.join(repoRoot, "asset-layer/profiles/2d-platformer.json"),
      catalogApiUrl: "https://api.test",
      catalogPath: path.join(repoRoot, "asset-layer/catalog-fixtures/platformer-catalog.json"),
      cacheDir: path.join(os.tmpdir(), "loombridge-mutex-cache"),
      outputPath: path.join(os.tmpdir(), "loombridge-mutex-out.json"),
      primitives: ["tile"],
    }),
    /exactly one of --registry, --catalog, or --catalog-api/,
  );
});

test("prepareAssets can prepare verified records from a hosted catalog source", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "loombridge-catalog-prepare-"));
  const cacheDir = path.join(tempDir, "cache");
  const outputPath = path.join(tempDir, "catalog-assets.json");
  const sourceImage = path.join(repoRoot, "asset-layer/fixtures/platformer/grass-tile.png");
  const fixtureLocalPath = "fixtures/grass-tile.png";
  await fs.mkdir(path.join(tempDir, "fixtures"), { recursive: true });
  await fs.copyFile(sourceImage, path.join(tempDir, fixtureLocalPath));
  const catalogPath = path.join(tempDir, "catalog/assets/platformer.json");
  await fs.mkdir(path.dirname(catalogPath), { recursive: true });
  await fs.writeFile(catalogPath, `${JSON.stringify({
    schemaVersion: "1",
    catalogId: "prepare-catalog-fixture",
    assets: [{
      id: "catalog.fixture.tile.grass",
      genre: "platformer-2d",
      primitive: "tile",
      kind: "sprite",
      priority: 10,
      source: {
        title: "Catalog Fixture Grass Tile",
        url: "https://example.invalid/catalog-fixture",
        author: "Loombridge Fixture",
        verified: true,
        provenance: {
          verifiedAt: "2026-06-05T00:00:00.000Z",
          origin: "Local hosted catalog prepare test fixture.",
          fixture: "asset-layer/fixtures/platformer/grass-tile.png",
        },
      },
      license: {
        name: "Creative Commons CC0 1.0 Universal",
        spdx: "CC0-1.0",
        url: "https://creativecommons.org/publicdomain/zero/1.0/",
        requiresAttribution: false,
      },
      provider: {
        name: "Local Fixture Catalog",
        url: "https://example.invalid/",
        type: "local",
        acquisitionLane: "mirror-index",
      },
      files: [{
        role: "sprite",
        format: "png",
        localPath: fixtureLocalPath,
      }],
      technical: {
        width: 64,
        height: 64,
        pixelsPerUnit: 100,
        transparent: true,
      },
      tags: ["platformer", "tile", "grass", "cc0"],
      unity: {
        path: "Assets/Art/Sprites/Tiles/catalog-fixture-grass.png",
        pixelsPerUnit: 100,
        spriteMode: "single",
        filterMode: "Point",
      },
      acquisitionLane: "mirror-index",
      trustTier: "trusted-default",
      review: {
        status: "verified",
        verifiedBy: "developer",
        verifiedAt: "2026-06-05T00:00:00.000Z",
        reviewer: "Loombridge Test",
      },
      pack: {
        packId: "hosted-catalog-fixture-pack",
        name: "Hosted Catalog Fixture Pack",
      },
    }],
  }, null, 2)}\n`);

  const report = await prepareAssets({
    profilePath: path.join(repoRoot, "asset-layer/profiles/2d-platformer.json"),
    catalogPath,
    cacheDir,
    outputPath,
    primitives: ["tile"],
    preferredLicense: "CC0-1.0",
  });
  const written = JSON.parse(await fs.readFile(outputPath, "utf-8")) as typeof report;

  assert.equal(report.status, "pass");
  assert.equal(written.registry.packId, "platformer");
  assert.equal(written.registry.path, catalogPath);
  assert.deepEqual(written.assets.map((asset) => asset.id), ["catalog.fixture.tile.grass"]);
  assert.equal(written.assets[0]?.status, "accepted");
  assert.equal(written.assets[0]?.cacheStatus, "miss");
  assert.equal((await fs.stat(written.assets[0]!.cachePath)).isFile(), true);
});

test("prepareAssets prepares the checked-in hosted catalog tile fixture offline", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "loombridge-checked-in-catalog-"));
  const cacheDir = path.join(tempDir, "cache");
  const outputPath = path.join(tempDir, "checked-in-catalog-assets.json");
  const catalogPath = path.join(repoRoot, "asset-layer/catalog-fixtures/platformer-catalog.json");
  const expectedChecksum = "e9d0ffd21f343c24544b6f779d4d662ac35193f3ef4b194c6225248aeeb4c823";

  // No network, no private mirror: fail loudly if either is touched.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("offline prepare must not hit the network");
  }) as unknown as typeof fetch;
  let report: Awaited<ReturnType<typeof prepareAssets>>;
  try {
    report = await prepareAssets({
      profilePath: path.join(repoRoot, "asset-layer/profiles/2d-platformer.json"),
      catalogPath,
      cacheDir,
      outputPath,
      genre: "platformer-2d",
      primitives: ["tile"],
      preferredLicense: "CC0-1.0",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  const written = JSON.parse(await fs.readFile(outputPath, "utf-8")) as typeof report;

  assert.equal(report.status, "pass");
  assert.equal(written.status, "pass");
  assert.deepEqual(written.assets.map((asset) => asset.id), ["kenney.fixture.tile.grass"]);
  const tile = written.assets[0]!;
  assert.equal(tile.status, "accepted");
  assert.ok(tile.checksum && tile.checksum.value.length > 0, "tile should carry a non-empty checksum");
  assert.equal(tile.checksum!.value, expectedChecksum);
  assert.equal((await fs.stat(tile.cachePath)).isFile(), true);
});

test("prepareAssets falls back from missing local mirrors to hosted file URLs", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "loombridge-provider-fallback-"));
  const cacheDir = path.join(tempDir, "cache");
  const outputPath = path.join(tempDir, "fallback-assets.json");
  const sourceImage = path.join(repoRoot, "asset-layer/fixtures/platformer/grass-tile.png");
  const sourceBytes = await fs.readFile(sourceImage);
  const sourceSha = crypto.createHash("sha256").update(sourceBytes).digest("hex");
  const registryPath = path.join(tempDir, "registry/fallback-pack.json");
  await fs.mkdir(path.dirname(registryPath), { recursive: true });
  await fs.writeFile(registryPath, `${JSON.stringify({
    schemaVersion: "1",
    packId: "fallback-pack",
    name: "Provider Fallback Pack",
    entries: [{
      id: "fallback.fixture.tile.grass",
      genre: "platformer-2d",
      primitive: "tile",
      kind: "sprite",
      priority: 10,
      source: {
        title: "Fallback Fixture Grass Tile",
        url: "https://example.invalid/fallback-fixture",
        author: "Loombridge Fixture",
        verified: true,
        provenance: {
          verifiedAt: "2026-06-05T00:00:00.000Z",
          origin: "Local provider fallback test fixture.",
          fixture: "asset-layer/fixtures/platformer/grass-tile.png",
        },
      },
      license: {
        name: "Creative Commons CC0 1.0 Universal",
        spdx: "CC0-1.0",
        url: "https://creativecommons.org/publicdomain/zero/1.0/",
        requiresAttribution: false,
      },
      provider: {
        name: "Fallback Fixture Catalog",
        url: "https://example.invalid/",
        type: "local",
        acquisitionLane: "mirror-index",
      },
      files: [{
        role: "sprite",
        format: "png",
        localPath: "assets/providers/missing/grass-tile.png",
        url: "https://raw.githubusercontent.com/example-org/example-asset-mirror/main/assets/grass-tile.png",
        checksum: {
          algorithm: "sha256",
          value: sourceSha,
        },
      }],
      technical: {
        width: 64,
        height: 64,
        pixelsPerUnit: 100,
        transparent: true,
      },
      tags: ["platformer", "tile", "grass", "cc0"],
      unity: {
        path: "Assets/Art/Sprites/Tiles/fallback-fixture-grass.png",
        pixelsPerUnit: 100,
        spriteMode: "single",
        filterMode: "Point",
      },
      acquisitionLane: "mirror-index",
      trustTier: "trusted-default",
      review: {
        status: "verified",
        verifiedBy: "developer",
        verifiedAt: "2026-06-05T00:00:00.000Z",
        reviewer: "Loombridge Test",
      },
    }],
  }, null, 2)}\n`);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    arrayBuffer: async () => sourceBytes.buffer.slice(sourceBytes.byteOffset, sourceBytes.byteOffset + sourceBytes.byteLength),
  })) as unknown as typeof fetch;
  let report: Awaited<ReturnType<typeof prepareAssets>>;
  try {
    report = await prepareAssets({
      profilePath: path.join(repoRoot, "asset-layer/profiles/2d-platformer.json"),
      registryPath,
      cacheDir,
      outputPath,
      genre: "platformer-2d",
      primitives: ["tile"],
      preferredLicense: "CC0-1.0",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  const written = JSON.parse(await fs.readFile(outputPath, "utf-8")) as typeof report;

  assert.equal(report.status, "pass");
  assert.deepEqual(written.assets.map((asset) => asset.id), ["fallback.fixture.tile.grass"]);
  assert.equal(written.assets[0]?.status, "accepted");
  assert.equal(written.assets[0]?.cacheStatus, "miss");
  assert.deepEqual(written.assets[0]?.providerDiagnostics, []);
  assert.equal((await fs.stat(written.assets[0]!.cachePath)).isFile(), true);
});
