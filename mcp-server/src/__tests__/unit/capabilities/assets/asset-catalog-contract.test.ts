import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  adaptRegistryPackToCatalog,
  catalogRecordToRegistryEntry,
  normalizeCatalogRecord,
  parseCatalogJsonl,
  validateCatalogRecord,
} from "../../../../capabilities/assets/catalog.js";
import type { AssetCatalogRecord, AssetRegistryPack } from "../../../../capabilities/assets/types.js";
import { REPO_ROOT } from "../../../_support/paths.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = REPO_ROOT;

function readJson<T>(relativePath: string): T {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, relativePath), "utf-8")) as T;
}

function kenneyHostedRecord(overrides: Partial<AssetCatalogRecord> = {}): unknown {
  return {
    id: "kenney.all-in-one.3.5.0.pixel-platformer.tilemap",
    genre: "platformer-2d",
    primitive: "tile",
    kind: "sprite",
    category: "tiles",
    source: {
      title: "Kenney Game Assets All-in-1 3.5.0",
      url: "https://kenney.nl/data/product-assets",
      downloadPage: "https://kenney.nl/data/product-assets",
      author: "Kenney",
      verified: true,
      provenance: {
        verifiedAt: "2026-06-05T00:00:00.000Z",
        origin: "Kenney All-in-1 3.5.0 bytes (CC0) mirrored into the asset registry.",
        fixture: "assets/providers/kenney/all-in-one/3.5.0/2D assets/Pixel Platformer/Tiles/tilemap.png",
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
      termsNotes: "Private mirror of purchased pack bytes; catalog records preserve source and license metadata.",
    },
    localPath: "assets/providers/kenney/all-in-one/3.5.0/2D assets/Pixel Platformer/Tiles/tilemap.png",
    githubRawUrl: "https://raw.githubusercontent.com/example-org/example-asset-mirror/main/assets/providers/kenney/all-in-one/3.5.0/2D%20assets/Pixel%20Platformer/Tiles/tilemap.png",
    githubBlobUrl: "https://github.com/example-org/example-asset-mirror/blob/main/assets/providers/kenney/all-in-one/3.5.0/2D%20assets/Pixel%20Platformer/Tiles/tilemap.png",
    file: {
      role: "spritesheet",
      format: "png",
      sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      sizeBytes: 12345,
    },
    technical: {
      width: 384,
      height: 384,
      pixelsPerUnit: 100,
      transparent: true,
    },
    tags: ["cc0", "kenney", "sprite", "verified", "tile", "platformer"],
    unity: {
      path: "Assets/Art/Sprites/Tiles/kenney-pixel-platformer-tilemap.png",
      pixelsPerUnit: 100,
      spriteMode: "multiple",
      filterMode: "Point",
    },
    acquisitionLane: "mirror-index",
    trustTier: "trusted-default",
    review: {
      status: "verified",
      verifiedBy: "developer",
      verifiedAt: "2026-06-05T00:00:00.000Z",
      reviewer: "Loombridge",
    },
    pack: {
      packId: "kenney-all-in-one-3.5.0",
      name: "Kenney Game Assets All-in-1",
      version: "3.5.0",
      catalogPath: "catalog/assets/kenney-all-in-one-3.5.0/part-0001.jsonl",
    },
    ...overrides,
  };
}

test("asset catalog schema declares review metadata and hosted URL fields", () => {
  const schema = readJson<{
    $defs: Record<string, { required?: string[]; properties?: Record<string, unknown> }>;
  }>("asset-layer/schemas/asset-catalog.schema.json");

  assert.deepEqual(schema.$defs.review.required, ["status"]);
  assert.ok(schema.$defs.review.properties?.verifiedBy);
  assert.ok(schema.$defs.review.properties?.verifiedAt);
  assert.ok(schema.$defs.review.properties?.reviewer);
  assert.ok(schema.$defs.catalogRecord.properties?.githubRawUrl);
  assert.ok(schema.$defs.catalogRecord.properties?.githubBlobUrl);
  assert.ok(schema.$defs.catalogRecord.properties?.acquisitionLane);
  assert.ok(schema.$defs.catalogRecord.properties?.trustTier);
});

test("legacy registry packs adapt into verified catalog records without losing registry compatibility", () => {
  const registry = readJson<AssetRegistryPack>("asset-layer/registry/platformer-2d.json");
  const catalog = adaptRegistryPackToCatalog(registry, {
    reviewedAt: "2026-06-05T00:00:00.000Z",
    reviewer: "Loombridge",
  });

  assert.equal(catalog.length, registry.entries.length);
  assert.equal(catalog[0]?.review.status, "verified");
  assert.equal(catalog[0]?.review.verifiedBy, "developer");
  assert.equal(catalog[0]?.review.reviewer, "Loombridge");
  assert.equal(catalog[0]?.pack?.packId, registry.packId);

  const validation = validateCatalogRecord(catalog[0]!);
  assert.deepEqual(validation.issues, []);

  const roundTrip = catalogRecordToRegistryEntry(catalog[0]!);
  const { review, trustTier, policyStatus, acquisitionLane, ...legacyRoundTrip } = roundTrip;
  assert.deepEqual(legacyRoundTrip, registry.entries[0]);
  assert.equal(review?.status, "verified");
  assert.equal(trustTier, "trusted-default");
  assert.equal(policyStatus, "trusted-default");
  assert.equal(acquisitionLane, undefined);
});

test("source.verified is legacy metadata and review.status is the authoritative verification signal", () => {
  const registry = readJson<AssetRegistryPack>("asset-layer/registry/platformer-2d.json");
  const [first] = adaptRegistryPackToCatalog({
    ...registry,
    entries: [
      {
        ...registry.entries[0]!,
        source: { ...registry.entries[0]!.source, verified: false },
      },
    ],
  });

  assert.equal(first?.source.verified, false);
  assert.equal(first?.review.status, "needs-review");

  const manuallyVerified = normalizeCatalogRecord({
    ...first,
    review: {
      status: "verified",
      verifiedBy: "loombridge",
      verifiedAt: "2026-06-05T00:00:00.000Z",
      reviewer: "loombridge-core",
    },
  });
  const validation = validateCatalogRecord(manuallyVerified);
  assert.equal(validation.status, "accepted");
});

test("source.verified cannot contradict review.status or mint trusted-default", () => {
  const base = normalizeCatalogRecord(kenneyHostedRecord());
  const record = normalizeCatalogRecord(kenneyHostedRecord({
    source: { ...base.source, verified: true },
    review: {
      status: "needs-review",
      notes: "Legacy verified flag is stale.",
    },
    trustTier: "trusted-default",
    policyStatus: "trusted-default",
  }));

  const validation = validateCatalogRecord(record);

  assert.equal(validation.status, "rejected");
  assert.ok(validation.issues.some((issue) => issue.code === "INVALID_VERIFICATION"));
  assert.ok(validation.issues.some((issue) => issue.code === "INVALID_TRUST_TIER"));
});

test("catalog records propagate review and trust metadata into registry entries", () => {
  const record = normalizeCatalogRecord(kenneyHostedRecord({
    review: {
      status: "needs-review",
      notes: "Candidate only.",
    },
    trustTier: "unverified-discovery",
    policyStatus: "unverified-discovery",
  }));

  const entry = catalogRecordToRegistryEntry(record);

  assert.equal(entry.review?.status, "needs-review");
  assert.equal(entry.trustTier, "unverified-discovery");
  assert.equal(entry.policyStatus, "unverified-discovery");
});

test("blocked catalog records are rejected", () => {
  const record = normalizeCatalogRecord(kenneyHostedRecord({
    trustTier: "blocked",
    policyStatus: "blocked",
  }));

  const validation = validateCatalogRecord(record);

  assert.equal(validation.status, "rejected");
  assert.ok(validation.issues.some((issue) => issue.code === "INVALID_TRUST_TIER"));
});

test("Kenney sharded JSONL catalog records normalize and validate", () => {
  const [record] = parseCatalogJsonl(`${JSON.stringify(kenneyHostedRecord())}\n`);

  assert.ok(record);
  assert.equal(record.review.status, "verified");
  assert.equal(record.acquisitionLane, "mirror-index");
  assert.equal(record.trustTier, "trusted-default");
  assert.equal(record.files[0]?.localPath, "assets/providers/kenney/all-in-one/3.5.0/2D assets/Pixel Platformer/Tiles/tilemap.png");
  assert.equal(record.files[0]?.githubRawUrl?.startsWith("https://raw.githubusercontent.com/example-org/example-asset-mirror/"), true);
  assert.equal(record.files[0]?.githubBlobUrl?.startsWith("https://github.com/example-org/example-asset-mirror/"), true);
  assert.equal(record.files[0]?.checksum?.value, "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");

  const validation = validateCatalogRecord(record);
  assert.deepEqual(validation.issues, []);

  const registryEntry = catalogRecordToRegistryEntry(record);
  assert.equal(registryEntry.files[0]?.url, record.files[0]?.githubRawUrl);
  assert.equal(registryEntry.files[0]?.checksum?.algorithm, "sha256");
});

test("compact Kenney seed records backfill source, provider, license, and generic genre", () => {
  const record = normalizeCatalogRecord({
    schemaVersion: "1",
    id: "kenney.2d.assets.1.bit.pack.preview",
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
  });
  const validation = validateCatalogRecord(record);

  assert.equal(validation.status, "accepted");
  assert.equal(record.genre, "game-asset");
  assert.equal(record.source.title, "Preview");
  assert.equal(record.source.author, "kenney");
  assert.equal(record.source.provenance.verifiedAt, "2026-06-05T00:00:00.000Z");
  assert.equal(record.source.provenance.origin, "loomtide-asset-store:kenney-all-in-one-3.5.0");
  assert.equal(record.source.provenance.fixture, "assets/providers/kenney/all-in-one/3.5.0/2D assets/1-Bit Pack/Preview.png");
  assert.equal(record.provider.name, "kenney");
  assert.equal(record.license.name, "Creative Commons CC0 1.0 Universal");
});

test("validateCatalogRecord ACCEPTS a file.format:'ogg' (audio) record", () => {
  const record = normalizeCatalogRecord(
    kenneyHostedRecord({
      id: "kenney.audio.impact.jump",
      kind: "audio",
      primitive: "sfx",
      file: {
        role: "audio",
        format: "ogg",
        sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        sizeBytes: 4096,
      },
    } as Partial<AssetCatalogRecord>),
  );
  assert.equal(record.files[0]?.format, "ogg");
  const validation = validateCatalogRecord(record);
  assert.equal(
    validation.status,
    "accepted",
    `ogg should now validate, got ${JSON.stringify(validation.issues)}`,
  );
});

test("validateCatalogRecord ACCEPTS a file.format:'glb' (model) record", () => {
  const record = normalizeCatalogRecord(
    kenneyHostedRecord({
      id: "kenney.model.crate",
      kind: "model",
      primitive: "model",
      file: {
        role: "model",
        format: "glb",
        sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        sizeBytes: 8192,
      },
    } as Partial<AssetCatalogRecord>),
  );
  assert.equal(record.files[0]?.format, "glb");
  const validation = validateCatalogRecord(record);
  assert.equal(
    validation.status,
    "accepted",
    `glb should now validate, got ${JSON.stringify(validation.issues)}`,
  );
});

test("validateCatalogRecord ACCEPTS a file.format:'svg' + kind:'vector' record", () => {
  const record = normalizeCatalogRecord(
    kenneyHostedRecord({
      id: "kenney.vector.icon.heart",
      kind: "vector",
      primitive: "ui",
      file: {
        role: "vector",
        format: "svg",
        sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        sizeBytes: 512,
      },
    } as Partial<AssetCatalogRecord>),
  );
  assert.equal(record.files[0]?.format, "svg");
  assert.equal(record.kind, "vector");
  const validation = validateCatalogRecord(record);
  assert.equal(
    validation.status,
    "accepted",
    `svg + vector should now validate, got ${JSON.stringify(validation.issues)}`,
  );
});

test("validateCatalogRecord STILL REJECTS an unknown kind:'hologram' (allowlist not blown open)", () => {
  // Feed the validator a record carrying an unknown kind directly — normalize
  // would drop it to undefined, so we cast to exercise the kind allowlist gate.
  const record = normalizeCatalogRecord(
    kenneyHostedRecord({
      id: "kenney.bad.hologram",
      file: {
        role: "sprite",
        format: "png",
        sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        sizeBytes: 4096,
      },
    } as Partial<AssetCatalogRecord>),
  );
  (record as { kind: string }).kind = "hologram";
  const validation = validateCatalogRecord(record);
  assert.equal(validation.status, "rejected");
  assert.ok(
    validation.issues.some(
      (issue) => issue.code === "MISSING_FIELD" && issue.path.endsWith(".kind"),
    ),
    `expected a MISSING_FIELD kind issue, got ${JSON.stringify(validation.issues)}`,
  );
});

test("validateCatalogRecord STILL REJECTS an unknown file.format:'exe' (allowlist not blown open)", () => {
  const record = normalizeCatalogRecord(
    kenneyHostedRecord({
      id: "kenney.bad.exe",
      file: {
        role: "sprite",
        format: "exe",
        sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        sizeBytes: 4096,
      },
    } as Partial<AssetCatalogRecord>),
  );
  const validation = validateCatalogRecord(record);
  assert.equal(validation.status, "rejected");
  assert.ok(
    validation.issues.some(
      (issue) => issue.code === "INVALID_FILE" && issue.path.endsWith(".format"),
    ),
    `expected an INVALID_FILE format issue, got ${JSON.stringify(validation.issues)}`,
  );
});

test("compact Kenney seed records infer profile primitives from path and tags", () => {
  const base = {
    schemaVersion: "1",
    sourceId: "kenney-all-in-one-3.5.0",
    providerId: "kenney",
    acquisitionLane: "mirror-index",
    trustTier: "trusted-default",
    primitive: "asset",
    kind: "sprite",
    githubRawUrl: "https://raw.githubusercontent.com/example-org/example-asset-mirror/main/assets/fixture.png",
    file: {
      format: "png",
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
    tags: ["2d-assets", "cc0", "kenney", "sprite", "verified"],
    unity: {
      path: "Assets/Art/Kenney/Sprites/fixture.png",
    },
  };

  assert.equal(normalizeCatalogRecord({
    ...base,
    id: "kenney.coin.gold",
    title: "Gold Coin",
    localPath: "assets/providers/kenney/all-in-one/3.5.0/2D assets/Platformer/Items/coin_gold.png",
  }).primitive, "collectible");
  assert.equal(normalizeCatalogRecord({
    ...base,
    id: "kenney.background.sky",
    title: "Blue Sky Background",
    localPath: "assets/providers/kenney/all-in-one/3.5.0/2D assets/Background Elements/sky.png",
  }).primitive, "background");
  assert.equal(normalizeCatalogRecord({
    ...base,
    id: "kenney.ui.button",
    title: "Button",
    primitive: "ui",
    localPath: "assets/providers/kenney/all-in-one/3.5.0/UI assets/button.png",
  }).primitive, "decor");
  const hazard = normalizeCatalogRecord({
    ...base,
    id: "kenney.spike.hazard",
    title: "Spikes",
    localPath: "assets/providers/kenney/all-in-one/3.5.0/2D assets/Platformer/Enemies/spikes.png",
  });
  assert.equal(hazard.primitive, "enemy");
  assert.equal(hazard.tags.includes("hazard"), true);
});

test("malformed review metadata is rejected", () => {
  const bad = normalizeCatalogRecord(kenneyHostedRecord({
    review: {
      status: "verified",
      verifiedBy: "bot" as "developer",
      verifiedAt: "",
      reviewer: "",
    },
  }));

  const validation = validateCatalogRecord(bad);
  const codes = validation.issues.map((issue) => issue.code);

  assert.equal(validation.status, "rejected");
  assert.ok(codes.includes("INVALID_REVIEW"));
  assert.ok(codes.includes("INVALID_VERIFICATION"));
});

test("verified tag alone does not make an asset verified", () => {
  const candidate = normalizeCatalogRecord(kenneyHostedRecord({
    source: { ...normalizeCatalogRecord(kenneyHostedRecord()).source, verified: false },
    review: { status: "needs-review" },
    trustTier: "unverified-discovery",
    tags: ["cc0", "kenney", "verified"],
  }));

  const validation = validateCatalogRecord(candidate);

  assert.equal(validation.status, "accepted");
  assert.equal(candidate.review.status, "needs-review");
  assert.equal(candidate.tags.includes("verified"), true);
});
