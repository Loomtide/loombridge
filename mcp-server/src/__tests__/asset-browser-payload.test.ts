import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildAssetBrowserPayload,
  buildAssetBrowserPayloadFromPrepareReport,
} from "../asset-layer/browser-payload.js";
import type { CatalogFetch } from "../asset-layer/catalog-source.js";
import { loadRegistryPack } from "../asset-layer/registry.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../../..");
const registryPath = path.join(repoRoot, "asset-layer/registry/platformer-2d.json");
const profilePath = path.join(repoRoot, "asset-layer/profiles/2d-platformer.json");
const catalogPath = path.join(repoRoot, "asset-layer/catalog-fixtures/platformer-catalog.json");

test("buildAssetBrowserPayload maps the real platformer registry without fabricating rich metadata", async () => {
  const registry = await loadRegistryPack(registryPath);
  const payload = await buildAssetBrowserPayload({
    registryPath,
    profilePath,
    preferredLicense: "CC0-1.0",
  });

  assert.equal(payload.assets.length, registry.entries.length);
  assert.equal(payload.registry.name, registry.name);
  assert.ok(payload.categories.some((category) => category.id === "characters"));
  assert.ok(payload.categories.some((category) => category.id === "audio"));
  assert.deepEqual(payload.inventory, []);

  const player = payload.assets.find((asset) => asset.id === "kenney.pixel-platformer.player.sheet");
  assert.ok(player);
  assert.equal(player.placeholder, false);
  assert.equal(player.license, "CC0-1.0");
  assert.equal(player.reviewStatus, "verified");
  assert.equal(player.policyStatus, "trusted-default");
  assert.equal(player.badges?.includes("VERIFIED"), true);
  assert.equal(player.category, "characters");
  assert.ok(player.imagePath?.endsWith("asset-layer/fixtures/platformer/kenney-pixel-platformer/tilemap-characters.png"));
  assert.equal(player.badges?.includes("PLACEHOLDER"), false);
  assert.equal(player.sourceLinks?.source, "https://www.kenney.nl/assets/pixel-platformer");
  assert.equal(player.actionIntents?.includes("select"), true);
  assert.equal("rating" in player, false);
  assert.equal("downloads" in player, false);
  assert.equal("style" in player, false);

  const httpCandidate = payload.assets.find((asset) => asset.id === "opengameart.simple.tile.vvvvvv");
  assert.ok(httpCandidate);
  assert.equal(httpCandidate.imagePath, undefined);
  assert.equal(httpCandidate.placeholder, false);

  const enemy = payload.assets.find((asset) => asset.id === "kenney.new-platformer.enemy.sheet");
  assert.ok(enemy);
  assert.equal(enemy.category, "characters");
  assert.ok(enemy.imagePath?.endsWith("asset-layer/fixtures/platformer/kenney-new-platformer/enemies.png"));

  const parallax = payload.assets.find((asset) => asset.id === "opengameart.sunnyland-tall-forest.parallax.middle");
  assert.ok(parallax);
  assert.equal(parallax.category, "environments");
  assert.ok(parallax.imagePath?.endsWith("asset-layer/fixtures/platformer/sunnyland-tall-forest/middle.png"));

  const vfx = payload.assets.find((asset) => asset.id === "kenney.smoke-particles.vfx.explosion");
  assert.ok(vfx);
  assert.equal(vfx.category, "vfx");
  assert.ok(vfx.imagePath?.endsWith("asset-layer/fixtures/platformer/kenney-smoke-particles/explosion00.png"));

  assert.ok(payload.facets.category.includes("characters"));
  assert.ok(payload.facets.primitive.includes("player"));
  assert.ok(payload.facets.kind.includes("sprite"));
  assert.ok(payload.facets.license.includes("CC0-1.0"));
  assert.ok(payload.facets.provider.includes("Kenney"));
  assert.ok(payload.facets.verificationStatus.includes("verified"));
  assert.ok(payload.facets.trustTier.includes("trusted-default"));
  assert.ok(payload.facets.tags.includes("cc0"));
});

test("buildAssetBrowserPayload can present hosted catalog records directly", async () => {
  const payload = await buildAssetBrowserPayload({
    catalogPath,
    profilePath,
    preferredLicense: "CC0-1.0",
  });

  assert.equal(payload.registry.name, "Kenney Game Assets All-in-1");
  assert.equal(payload.assets.length, 3);
  assert.ok(payload.facets.acquisitionLane.includes("mirror-index"));
  assert.ok(payload.facets.acquisitionLane.includes("scraped-discovery"));
  assert.ok(payload.facets.trustTier.includes("trusted-default"));
  assert.ok(payload.facets.trustTier.includes("unverified-discovery"));
  assert.ok(payload.facets.verificationStatus.includes("verified"));
  assert.ok(payload.facets.verificationStatus.includes("needs-review"));

  const tile = payload.assets.find((asset) => asset.id === "kenney.fixture.tile.grass");
  assert.ok(tile);
  assert.equal(tile.reviewStatus, "verified");
  assert.equal(tile.policyStatus, "trusted-default");
  assert.equal(tile.acquisitionLane, "mirror-index");
  assert.equal(tile.badges?.includes("VERIFIED"), true);
  assert.equal(tile.sourceLinks?.githubBlob?.includes("github.com/example-org/example-asset-mirror"), true);
  assert.equal(tile.directDownloadUrl?.includes("raw.githubusercontent.com/example-org/example-asset-mirror"), true);
  assert.equal(tile.actionIntents?.includes("select"), true);

  const discovery = payload.assets.find((asset) => asset.id === "scraped.fixture.background.candidate");
  assert.ok(discovery);
  assert.equal(discovery.reviewStatus, "needs-review");
  assert.equal(discovery.policyStatus, "unverified-discovery");
  assert.equal(discovery.actionIntents?.includes("request-explicit-approval"), true);
});

test("buildAssetBrowserPayload can present hosted DB-backed search API records via catalogApiUrl", async () => {
  // A valid trusted-default 2d-platformer record the search API returns over its public r2.dev url.
  const apiRecord = {
    id: "api.platformer.tile.grass",
    genre: "platformer-2d",
    primitive: "tile",
    kind: "sprite",
    priority: 20,
    source: {
      title: "Pixel Platformer",
      url: "https://kenney.nl/assets/pixel-platformer",
      author: "Kenney",
      provenance: {
        verifiedAt: "2026-06-05T00:00:00.000Z",
        origin: "Kenney Pixel Platformer (CC0) public pack",
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
      checksum: {
        algorithm: "sha256",
        value: "893280193cadeffc34efe9d474a50ab86de5f0f927ffd69f5575c3832237b095",
      },
    }],
    technical: { width: 18, height: 18, pixelsPerUnit: 100, transparent: true },
    tags: ["platformer", "tile", "grass", "kenney", "cc0", "verified"],
    unity: { path: "Assets/Art/Sprites/Tiles/api-grass.png", pixelsPerUnit: 100 },
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

  const payload = await buildAssetBrowserPayload({
    catalogApiUrl: "https://api.test",
    catalogFetch,
    profilePath,
    preferredLicense: "CC0-1.0",
  });

  // The browser hit the hosted search endpoint with the profile genre.
  assert.ok(requestedUrl);
  const url = new URL(requestedUrl!);
  assert.equal(url.pathname, "/v1/assets/search");
  assert.equal(url.searchParams.get("profile"), "platformer-2d");

  // The API record is surfaced with its PUBLIC url + locally-derived trusted-default tier.
  assert.deepEqual(payload.assets.map((asset) => asset.id), ["api.platformer.tile.grass"]);
  const tile = payload.assets[0]!;
  assert.equal(tile.directDownloadUrl, "https://pub-test.r2.dev/kenney/2d-platformer/tile/grass-tile.png");
  assert.equal(tile.trustTier, "trusted-default");
  assert.equal(tile.policyStatus, "trusted-default");
  assert.equal(tile.reviewStatus, "verified");
  assert.ok(tile.actionIntents?.includes("select"));
  assert.ok(payload.facets.trustTier.includes("trusted-default"));
});

test("buildAssetBrowserPayload rejects passing both catalogApiUrl and catalogPath", async () => {
  await assert.rejects(
    () => buildAssetBrowserPayload({
      catalogApiUrl: "https://api.test",
      catalogPath,
      profilePath,
    }),
    /exactly one of --registry, --catalog, or --catalog-api/,
  );
});

test("buildAssetBrowserPayload filters hosted catalog records by required tags", async () => {
  const payload = await buildAssetBrowserPayload({
    catalogPath,
    profilePath,
    tags: ["grass"],
  });

  assert.deepEqual(payload.assets.map((asset) => asset.id), ["kenney.fixture.tile.grass"]);
});

test("buildAssetBrowserPayload presents compact generic catalog records for profile browsing", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "loombridge-browser-compact-catalog-"));
  const compactCatalogPath = path.join(tempDir, "catalog.json");
  await fs.writeFile(compactCatalogPath, `${JSON.stringify({
    schemaVersion: "1",
    assets: [{
      schemaVersion: "1",
      id: "kenney.fixture.preview",
      title: "Preview",
      sourceId: "kenney-all-in-one-3.5.0",
      providerId: "kenney",
      acquisitionLane: "mirror-index",
      trustTier: "trusted-default",
      category: "2D assets",
      primitive: "asset",
      kind: "sprite",
      localPath: "assets/providers/kenney/all-in-one/3.5.0/2D assets/1-Bit Pack/Preview.png",
      githubRawUrl: "https://raw.githubusercontent.com/example-org/example-asset-mirror/main/assets/providers/kenney/all-in-one/3.5.0/2D%20assets/1-Bit%20Pack/Preview.png",
      file: {
        format: "png",
        bytes: 99808,
        sha256: "54fb9d7ccc07e0451f5734c9df1fe052a6ab0272bad2ba33ff3c350866b2b9cd",
      },
      license: {
        spdx: "CC0-1.0",
        requiresAttribution: false,
      },
      review: {
        status: "verified",
        verifiedBy: "developer",
        verifiedAt: "2026-06-05T00:00:00.000Z",
        reviewer: "Loombridge",
      },
      tags: ["2d-assets", "cc0", "kenney", "preview", "sprite", "verified"],
      unity: {
        path: "Assets/Art/Kenney/Sprites/Preview.png",
      },
    }],
  }, null, 2)}\n`);

  const payload = await buildAssetBrowserPayload({
    catalogPath: compactCatalogPath,
    profilePath,
    tags: ["preview"],
  });

  assert.deepEqual(payload.assets.map((asset) => asset.id), ["kenney.fixture.preview"]);
  assert.equal(payload.assets[0]?.reviewStatus, "verified");
  assert.equal(payload.assets[0]?.directDownloadUrl?.includes("raw.githubusercontent.com/example-org/example-asset-mirror"), true);
});

test("buildAssetBrowserPayload can cache HTTP image previews into local imagePath values", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "loombridge-browser-previews-"));
  const previewCacheDir = path.join(tempDir, "browser-previews");
  const fixturePath = path.join(repoRoot, "asset-layer/fixtures/platformer/player-blue.png");
  const bytes = await fs.readFile(fixturePath);
  const checksum = crypto.createHash("sha256").update(bytes).digest("hex");
  const registry = {
    schemaVersion: "1",
    packId: "test-browser-previews",
    name: "Test Browser Previews",
    entries: [{
      id: "test.http.player",
      genre: "platformer-2d",
      primitive: "player",
      kind: "sprite",
      priority: 1,
      source: {
        title: "HTTP Player",
        url: "https://example.test/player",
        author: "Fixture",
        verified: true,
        provenance: {
          verifiedAt: "2026-05-23",
          origin: "unit test fixture",
          fixture: "https://example.test/player.png",
        },
      },
      license: {
        name: "Creative Commons CC0 1.0 Universal",
        spdx: "CC0-1.0",
        url: "https://creativecommons.org/publicdomain/zero/1.0/",
        requiresAttribution: false,
      },
      provider: {
        name: "Example",
        url: "https://example.test/",
        type: "http",
      },
      files: [{
        role: "sprite",
        format: "png",
        url: "https://example.test/player.png",
        checksum: {
          algorithm: "sha256",
          value: checksum,
        },
      }],
      technical: {
        width: 64,
        height: 64,
        pixelsPerUnit: 100,
        transparent: true,
      },
      tags: ["platformer", "player", "cc0", "http"],
      unity: {
        path: "Assets/Art/Sprites/Characters/test-http-player.png",
        pixelsPerUnit: 100,
        spriteMode: "single",
      },
    }],
  };
  const tempRegistryPath = path.join(tempDir, "registry.json");
  await fs.writeFile(tempRegistryPath, `${JSON.stringify(registry, null, 2)}\n`);

  const payload = await buildAssetBrowserPayload({
    registryPath: tempRegistryPath,
    profilePath,
    previewCacheDir,
    cacheImagePreviews: true,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      async arrayBuffer() {
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      },
    }),
  });

  const asset = payload.assets.find((candidate) => candidate.id === "test.http.player");
  assert.ok(asset?.imagePath);
  assert.ok(asset.imagePath.startsWith(previewCacheDir));
  assert.ok(asset.imagePath.endsWith(".png"));
  assert.equal(await fs.readFile(asset.imagePath, "hex"), bytes.toString("hex"));
});

test("buildAssetBrowserPayloadFromPrepareReport seeds inventory from accepted prepared assets", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "loombridge-browser-report-"));
  const spritePath = path.join(tempDir, "player.png");
  const audioPath = path.join(tempDir, "jump.wav");
  await fs.writeFile(spritePath, Buffer.from([1, 2, 3]));
  await fs.writeFile(audioPath, Buffer.from([4, 5]));

  const reportPath = path.join(tempDir, "prepare-report.json");
  await fs.writeFile(reportPath, `${JSON.stringify({
    schemaVersion: "1",
    status: "pass",
    registry: { packId: "test-pack", path: "/tmp/test-registry.json" },
    profile: { id: "test-profile", path: "/tmp/test-profile.json" },
    assets: [{
      id: "test.player",
      primitive: "player",
      kind: "sprite",
      placeholder: false,
      status: "accepted",
      cachePath: spritePath,
      unityPath: "Assets/Art/Sprites/player.png",
      source: {
        title: "Test Hero",
        url: "https://example.test/hero",
        author: "Fixture",
        verified: true,
        provenance: { verifiedAt: "2026-05-26", origin: "unit test", fixture: "fixture" },
      },
      license: {
        name: "Creative Commons CC0 1.0 Universal",
        spdx: "CC0-1.0",
        url: "https://creativecommons.org/publicdomain/zero/1.0/",
        requiresAttribution: false,
      },
      provider: { name: "Fixture", url: "https://example.test/", type: "local" },
      file: { role: "sprite", format: "png" },
      metadata: { format: "png", width: 32, height: 32 },
      import: {
        tool: "unity_asset_create_sprite",
        toolArguments: {
          source_path: spritePath,
          path: "Assets/Art/Sprites/player.png",
          pixels_per_unit: 100,
        },
      },
      rejections: [],
    }, {
      id: "test.jump",
      primitive: "sfx_jump",
      kind: "audio",
      placeholder: false,
      status: "accepted",
      cachePath: audioPath,
      unityPath: "Assets/Audio/jump.wav",
      source: {
        title: "Jump Cue",
        url: "https://example.test/jump",
        author: "Fixture",
        verified: true,
        provenance: { verifiedAt: "2026-05-26", origin: "unit test", fixture: "fixture" },
      },
      license: {
        name: "Creative Commons CC0 1.0 Universal",
        spdx: "CC0-1.0",
        url: "https://creativecommons.org/publicdomain/zero/1.0/",
        requiresAttribution: false,
      },
      provider: { name: "Fixture", url: "https://example.test/", type: "local" },
      file: { role: "audio", format: "wav" },
      metadata: { format: "wav", sampleRate: 44100, channels: 1, bitDepth: 16, durationMs: 120 },
      rejections: [],
    }, {
      id: "test.rejected",
      primitive: "tile",
      kind: "sprite",
      status: "rejected",
      cachePath: path.join(tempDir, "missing.png"),
      unityPath: "Assets/Art/Sprites/missing.png",
      source: {
        title: "Rejected",
        url: "https://example.test/rejected",
        author: "Fixture",
        verified: true,
        provenance: { verifiedAt: "2026-05-26", origin: "unit test", fixture: "fixture" },
      },
      license: {
        name: "Creative Commons CC0 1.0 Universal",
        spdx: "CC0-1.0",
        url: "https://creativecommons.org/publicdomain/zero/1.0/",
        requiresAttribution: false,
      },
      provider: { name: "Fixture", url: "https://example.test/", type: "local" },
      file: { role: "sprite", format: "png" },
      rejections: ["MISSING_FILE"],
    }],
    diagnostics: { selected: 3, accepted: 2, rejected: 1, placeholder: 0 },
  }, null, 2)}\n`);

  const payload = await buildAssetBrowserPayloadFromPrepareReport({ prepareReportPath: reportPath });

  assert.equal(payload.title, "Loombridge Asset Confirmation");
  assert.equal(payload.registry.name, "test-pack");
  assert.deepEqual(payload.inventory, ["test.player", "test.jump"]);
  assert.equal(payload.assets.length, 2);

  const player = payload.assets.find((asset) => asset.id === "test.player");
  assert.ok(player);
  assert.equal(player.category, "characters");
  assert.equal(player.imagePath, spritePath);
  assert.equal(player.width, 32);
  assert.equal(player.pixelsPerUnit, 100);
  assert.equal(player.reviewStatus, "verified");
  assert.equal(player.policyStatus, "trusted-default");
  assert.equal(player.badges?.includes("VERIFIED"), true);

  const audio = payload.assets.find((asset) => asset.id === "test.jump");
  assert.ok(audio);
  assert.equal(audio.category, "audio");
  assert.equal(audio.imagePath, undefined);
  assert.equal(audio.fileFormat, "wav");
  assert.ok(payload.facets.category.includes("audio"));
  assert.ok(payload.facets.verificationStatus.includes("verified"));
});
