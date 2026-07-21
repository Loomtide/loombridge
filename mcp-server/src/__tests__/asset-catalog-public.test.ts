import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { LocalCatalogSource } from "../asset-layer/catalog-source.js";
import {
  normalizeCatalogRecord,
  validatePublicCatalogRecord,
} from "../asset-layer/catalog.js";
import type { AssetCatalogRecord } from "../asset-layer/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../../..");
const seedPath = path.join(repoRoot, "asset-layer/catalog-public/2d-platformer/part-00000.jsonl");

const EXPECTED_PRIMITIVES = ["tile", "player", "background", "collectible"];

async function loadSeed(): Promise<AssetCatalogRecord[]> {
  return new LocalCatalogSource(seedPath).load();
}

test("public seed loads, validates, and is queryable through LocalCatalogSource", async () => {
  // Load THROUGH the enforced public-policy gate — this proves the gate actually RUNS on
  // the seed (not just in a standalone unit test) and that the seed passes it.
  const source = new LocalCatalogSource(seedPath, { enforcePublicPolicy: true });
  const records = await source.load();

  assert.equal(records.length, 4, "seed must declare one record per primitive");

  const primitives = records.map((record) => record.primitive).sort();
  assert.deepEqual(primitives, [...EXPECTED_PRIMITIVES].sort());

  // Queryable by profile genre + primitive + tags through the same CatalogSource path.
  const tiles = await source.query({
    genre: "platformer-2d",
    primitive: "tile",
    kind: "sprite",
    tags: ["cc0", "kenney", "verified"],
    license: "CC0-1.0",
    provider: "kenney",
    verificationStatus: "verified",
  });
  assert.deepEqual(tiles.map((record) => record.id), ["kenney.public.tile.grass"]);

  // Every primitive is independently queryable.
  for (const primitive of EXPECTED_PRIMITIVES) {
    const hits = await source.query({ genre: "platformer-2d", primitive });
    assert.equal(hits.length, 1, `primitive ${primitive} must be queryable`);
  }
});

test("public seed records carry public R2 urls, no private-mirror refs", async () => {
  const records = await loadSeed();
  for (const record of records) {
    const file = record.files[0]!;
    assert.ok(
      file.url?.startsWith("https://assets.loomtide.ai/kenney/2d-platformer/"),
      `${record.id} must resolve from a public assets.loomtide.ai url`,
    );
    assert.equal(file.githubRawUrl, undefined, `${record.id} must not carry a githubRawUrl`);
    assert.equal(file.githubBlobUrl, undefined, `${record.id} must not carry a githubBlobUrl`);
    assert.equal((record.source.provenance as Record<string, unknown>).fixture, undefined,
      `${record.id} public provenance must not carry a test-only fixture path`);
    assert.equal(typeof (record.source.provenance as Record<string, unknown>).url, "string");
    assert.equal((record.source.provenance as Record<string, unknown>).origin !== undefined, true);
  }
});

test("validatePublicCatalogRecord ACCEPTS every seed record", async () => {
  const records = await loadSeed();
  for (const record of records) {
    const result = validatePublicCatalogRecord(record);
    assert.equal(
      result.status,
      "accepted",
      `${record.id} should validate but got: ${JSON.stringify(result.issues)}`,
    );
    assert.equal(result.issues.length, 0);
  }
});

async function baseRecord(): Promise<AssetCatalogRecord> {
  const records = await loadSeed();
  // Deep clone the tile record so per-test mutations are isolated.
  return normalizeCatalogRecord(JSON.parse(JSON.stringify({
    ...records[0],
  })));
}

test("REJECTS a record whose only file url is a private raw.githubusercontent.com url", async () => {
  const record = await baseRecord();
  record.files[0]!.url = "https://raw.githubusercontent.com/Loomtide/LoomtideAssetRegistry/main/tile.png";
  const result = validatePublicCatalogRecord(record);
  assert.equal(result.status, "rejected");
  assert.ok(
    result.issues.some((issue) => issue.code === "PRIVATE_URL"),
    `expected a PRIVATE_URL issue, got ${JSON.stringify(result.issues)}`,
  );
});

test("REJECTS a record with no checksum", async () => {
  const record = await baseRecord();
  delete record.files[0]!.checksum;
  delete record.files[0]!.sha256;
  const result = validatePublicCatalogRecord(record);
  assert.equal(result.status, "rejected");
  assert.ok(
    result.issues.some((issue) => issue.code === "MISSING_CHECKSUM"),
    `expected a MISSING_CHECKSUM issue, got ${JSON.stringify(result.issues)}`,
  );
});

test("REJECTS an image record missing technical.width", async () => {
  const record = await baseRecord();
  delete record.technical.width;
  const result = validatePublicCatalogRecord(record);
  assert.equal(result.status, "rejected");
  assert.ok(
    result.issues.some((issue) => issue.code === "MISSING_TECHNICAL" && issue.path.endsWith(".technical.width")),
    `expected a MISSING_TECHNICAL width issue, got ${JSON.stringify(result.issues)}`,
  );
});

test("ACCEPTS an audio (ogg) record with NO technical width/height (audio needs no dims)", async () => {
  const record = await baseRecord();
  // Convert the cloned tile record into an audio record: kind audio, ogg file,
  // and strip ALL image dimensions. The public gate only requires width/height
  // for a sprite/undefined kind, so an audio record must still validate.
  record.kind = "audio";
  record.primitive = "sfx";
  record.files[0]!.role = "audio";
  record.files[0]!.format = "ogg";
  record.technical = {};
  const result = validatePublicCatalogRecord(record);
  assert.equal(
    result.status,
    "accepted",
    `audio record should validate without dims, got ${JSON.stringify(result.issues)}`,
  );
  // And it must NOT have skipped any OTHER required check — sanity: removing the
  // checksum still rejects it (the gate is still active for audio).
  const noChecksum = await baseRecord();
  noChecksum.kind = "audio";
  noChecksum.files[0]!.format = "ogg";
  noChecksum.technical = {};
  delete noChecksum.files[0]!.checksum;
  delete noChecksum.files[0]!.sha256;
  assert.equal(validatePublicCatalogRecord(noChecksum).status, "rejected");
});

test("ACCEPTS a model (glb) record with NO technical width/height (model needs no dims)", async () => {
  const record = await baseRecord();
  // Convert the cloned tile record into a model record: kind model, glb file,
  // and strip ALL image dimensions. The public gate only requires width/height
  // for a sprite/undefined kind, so a model record must still validate.
  record.kind = "model";
  record.primitive = "model";
  record.files[0]!.role = "model";
  record.files[0]!.format = "glb";
  record.technical = {};
  const result = validatePublicCatalogRecord(record);
  assert.equal(
    result.status,
    "accepted",
    `model record should validate without dims, got ${JSON.stringify(result.issues)}`,
  );
  // Sanity: the gate is still active for a model — removing the checksum rejects it.
  const noChecksum = await baseRecord();
  noChecksum.kind = "model";
  noChecksum.files[0]!.format = "glb";
  noChecksum.technical = {};
  delete noChecksum.files[0]!.checksum;
  delete noChecksum.files[0]!.sha256;
  assert.equal(validatePublicCatalogRecord(noChecksum).status, "rejected");
});

test("ACCEPTS a vector (svg) record with NO technical width/height (vector needs no dims)", async () => {
  const record = await baseRecord();
  // Convert the cloned tile record into a vector record: kind vector, svg file,
  // and strip ALL image dimensions. The public gate only requires width/height
  // for a sprite/undefined kind, so a vector record must still validate.
  record.kind = "vector";
  record.files[0]!.role = "vector";
  record.files[0]!.format = "svg";
  record.technical = {};
  const result = validatePublicCatalogRecord(record);
  assert.equal(
    result.status,
    "accepted",
    `vector record should validate without dims, got ${JSON.stringify(result.issues)}`,
  );
  // Sanity: the gate is still active for a vector — removing the checksum rejects it.
  const noChecksum = await baseRecord();
  noChecksum.kind = "vector";
  noChecksum.files[0]!.format = "svg";
  noChecksum.technical = {};
  delete noChecksum.files[0]!.checksum;
  delete noChecksum.files[0]!.sha256;
  assert.equal(validatePublicCatalogRecord(noChecksum).status, "rejected");
});

test("REJECTS a SPRITE record missing technical.height (format-awareness did not bypass dims)", async () => {
  // Guards against a regression where audio routing accidentally loosened the
  // image dims requirement: a kind:"sprite" record with no height MUST still reject.
  const record = await baseRecord();
  record.kind = "sprite";
  delete record.technical.height;
  const result = validatePublicCatalogRecord(record);
  assert.equal(result.status, "rejected");
  assert.ok(
    result.issues.some((issue) => issue.code === "MISSING_TECHNICAL" && issue.path.endsWith(".technical.height")),
    `expected a MISSING_TECHNICAL height issue, got ${JSON.stringify(result.issues)}`,
  );
});

test("REJECTS trustTier trusted-default with review.status needs-review", async () => {
  const record = await baseRecord();
  record.review = { status: "needs-review", notes: "not yet reviewed" };
  const result = validatePublicCatalogRecord(record);
  assert.equal(result.status, "rejected");
  assert.ok(
    result.issues.some((issue) => issue.code === "TRUST_POLICY_INCONSISTENT" && issue.path.endsWith(".review.status")),
    `expected a review-status trust inconsistency, got ${JSON.stringify(result.issues)}`,
  );
});

test("REJECTS a CC-BY requiresAttribution=true record claiming trusted-default", async () => {
  const record = await baseRecord();
  record.license = {
    name: "Creative Commons Attribution 4.0 International",
    spdx: "CC-BY-4.0",
    url: "https://creativecommons.org/licenses/by/4.0/",
    requiresAttribution: true,
  };
  // trustTier stays "trusted-default" (the smuggled-in claim under test).
  const result = validatePublicCatalogRecord(record);
  assert.equal(result.status, "rejected");
  const codes = result.issues.map((issue) => issue.code);
  assert.ok(codes.includes("TRUST_POLICY_INCONSISTENT"),
    `expected a TRUST_POLICY_INCONSISTENT issue, got ${JSON.stringify(result.issues)}`);
  // Specifically: an attribution-required license cannot be trusted-default.
  assert.ok(
    result.issues.some((issue) =>
      issue.code === "TRUST_POLICY_INCONSISTENT" &&
      (issue.path.endsWith(".license.requiresAttribution") || issue.path.endsWith(".license.spdx"))),
    `expected a license-based trust inconsistency, got ${JSON.stringify(result.issues)}`,
  );
});

// --- Fix 2: trailing-dot FQDN bypass --------------------------------------------------
for (const host of [
  "https://raw.githubusercontent.com./x/y.png",
  "https://github.com./Loombridge/x/y.png",
  "http://localhost./x/y.png",
]) {
  test(`REJECTS trailing-dot FQDN bypass for files[].url '${host}'`, async () => {
    const record = await baseRecord();
    record.files[0]!.url = host;
    const result = validatePublicCatalogRecord(record);
    assert.equal(result.status, "rejected");
    assert.ok(
      result.issues.some((issue) => issue.code === "PRIVATE_URL" && issue.path.endsWith(".url")),
      `expected a PRIVATE_URL issue for ${host}, got ${JSON.stringify(result.issues)}`,
    );
  });
}

// --- Fix 3: private githubRawUrl/githubBlobUrl survive (foreign repo) ------------------
test("REJECTS a record with public url but a foreign-repo githubRawUrl", async () => {
  const record = await baseRecord();
  // files[0].url stays the seed's public assets.loomtide.ai url (accepted on its own)...
  record.files[0]!.githubRawUrl = "https://raw.githubusercontent.com/other/repo/main/x.png";
  const result = validatePublicCatalogRecord(record);
  assert.equal(result.status, "rejected");
  assert.ok(
    result.issues.some((issue) => issue.code === "PRIVATE_URL" && issue.path.endsWith(".githubRawUrl")),
    `expected a PRIVATE_URL githubRawUrl issue, got ${JSON.stringify(result.issues)}`,
  );
});

test("REJECTS a record with a foreign-repo githubBlobUrl", async () => {
  const record = await baseRecord();
  record.files[0]!.githubBlobUrl = "https://github.com/other/repo/blob/main/x.png";
  const result = validatePublicCatalogRecord(record);
  assert.equal(result.status, "rejected");
  assert.ok(
    result.issues.some((issue) => issue.code === "PRIVATE_URL" && issue.path.endsWith(".githubBlobUrl")),
    `expected a PRIVATE_URL githubBlobUrl issue, got ${JSON.stringify(result.issues)}`,
  );
});

// --- Fix 4: gate must REJECT (not throw) on a missing files array ----------------------
test("REJECTS (does not throw) a record with no files array", async () => {
  const record = await baseRecord();
  delete (record as { files?: unknown }).files;
  let result: ReturnType<typeof validatePublicCatalogRecord> | undefined;
  assert.doesNotThrow(() => {
    result = validatePublicCatalogRecord(record);
  });
  assert.equal(result!.status, "rejected");
  assert.ok(
    result!.issues.some((issue) => issue.code === "MISSING_PUBLIC_URL" && issue.path.endsWith(".files")),
    `expected a MISSING_PUBLIC_URL files issue, got ${JSON.stringify(result!.issues)}`,
  );
});

// --- Fix 1: the gate actually RUNS on a public load (throws on a hostile shard) --------
test("LocalCatalogSource(enforcePublicPolicy:true) THROWS on a hostile shard", async () => {
  const records = await loadSeed();
  const hostile = JSON.parse(JSON.stringify(records[0]));
  hostile.id = "hostile.private.tile";
  hostile.files[0].url = "https://raw.githubusercontent.com/Loomtide/LoomtideAssetRegistry/main/tile.png";

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "loombridge-hostile-shard-"));
  const shardPath = path.join(dir, "part-00000.jsonl");
  await fs.writeFile(shardPath, `${JSON.stringify(hostile)}\n`, "utf-8");
  try {
    const source = new LocalCatalogSource(shardPath, { enforcePublicPolicy: true });
    await assert.rejects(
      source.load(),
      /Public catalog policy gate rejected/,
      "hostile shard with a private url must throw under enforcePublicPolicy",
    );
    // ...and WITHOUT the gate it loads fine (default behavior unchanged).
    const lenient = await new LocalCatalogSource(shardPath).load();
    assert.equal(lenient.length, 1);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
