import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { AddressInfo } from "node:net";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { prepareAssets } from "../asset-layer/prepare-cli.js";
import { regeneratePublicSeed } from "../asset-layer/public-seed-source.js";
import {
  buildAssetBrowserPayload,
  type AssetBrowserAsset,
} from "../asset-layer/browser-payload.js";
import { HttpAssetProvider } from "../asset-layer/providers/http-provider.js";
import { LocalAssetProvider } from "../asset-layer/providers/local-provider.js";
import { StubGenerationProvider } from "../asset-layer/providers/stub-generation-provider.js";
import { HttpCatalogSource, selectAssetsFromCatalog } from "../asset-layer/catalog-source.js";
import type { AssetCatalogRecord } from "../asset-layer/types.js";
import { LocalCatalogSource } from "../asset-layer/catalog-source.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../../..");

const catalogPath = path.join(repoRoot, "asset-layer/catalog-public/2d-platformer/part-00000.jsonl");
const profilePath = path.join(repoRoot, "asset-layer/profiles/2d-platformer.json");
const assetsDir = path.join(repoRoot, "asset-layer/catalog-public/assets");
const fixtureCatalogPath = path.join(repoRoot, "asset-layer/catalog-fixtures/platformer-catalog.json");

const PRIMITIVES = ["tile", "player", "background", "collectible"] as const;

// Public byte host the seed records resolve from in production. It is a PUBLIC-looking
// hostname so the SSRF guard's literal-host check passes; we never make a real request to
// it because both fetch and the DNS resolver are injected (see fakeFetch / FAKE_PUBLIC_IP).
const PUBLIC_ASSET_HOST = "assets.loomtide.ai";
// A FIXED public IP the injected resolver returns for any hostname. The guard then sees a
// public host AND a public resolved IP, so it stays fully intact (no real DNS, no real HTTP).
const FAKE_PUBLIC_IP = "93.184.216.34";

async function seedRecords(): Promise<AssetCatalogRecord[]> {
  return new LocalCatalogSource(catalogPath).load();
}

test("public seed prepares OFFLINE (no network, no private mirror) with all 4 assets accepted + checksum-matched", async () => {
  // Map each primitive to the checksum the COMMITTED seed pins, so we can assert
  // the prepared bytes (resolved offline via the bundled localPath) match it.
  const records = await seedRecords();
  const expectedChecksumByPrimitive = new Map<string, string>();
  for (const record of records) {
    const value = record.files[0]?.checksum?.value;
    assert.ok(value, `seed record ${record.id} must pin a checksum`);
    expectedChecksumByPrimitive.set(record.primitive, value);
  }

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "loomtide-public-e2e-"));
  const outputPath = path.join(workDir, "assets.json");
  const cacheDir = path.join(workDir, "cache");

  // Offline guard: any network access during prepare is a hard failure.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("network access is forbidden in the offline public-seed e2e");
  }) as typeof fetch;

  try {
    const report = await prepareAssets({
      profilePath,
      catalogPath,
      outputPath,
      cacheDir,
      primitives: [...PRIMITIVES],
    });

    assert.equal(
      report.status,
      "pass",
      `expected pass, got ${report.status}; assets: ${JSON.stringify(
        report.assets.map((a) => ({ id: a.id, status: a.status, rejections: a.rejections })),
        null,
        2,
      )}`,
    );

    assert.equal(report.assets.length, PRIMITIVES.length, "exactly one asset per requested primitive");

    for (const primitive of PRIMITIVES) {
      const asset = report.assets.find((candidate) => candidate.primitive === primitive);
      assert.ok(asset, `primitive ${primitive} must prepare`);
      // If a real CC0 byte fails sprite validation, surface WHICH and WHY — do not mask it.
      assert.equal(
        asset.status,
        "accepted",
        `primitive ${primitive} (${asset.id}) failed sprite validation: ${JSON.stringify(asset.rejections)}`,
      );
      assert.ok(
        asset.checksum?.value && asset.checksum.value.length > 0,
        `primitive ${primitive} must report a non-empty checksum`,
      );
      assert.equal(
        asset.checksum!.value,
        expectedChecksumByPrimitive.get(primitive),
        `primitive ${primitive} prepared-byte checksum must equal the seed's pinned checksum`,
      );
    }
  } finally {
    globalThis.fetch = realFetch;
    await fs.rm(workDir, { recursive: true, force: true });
  }
});

test("regeneratePublicSeed over the committed bundled bytes reproduces the committed shard (idempotent, network-free)", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("network access is forbidden in the offline seed-regeneration test");
  }) as typeof fetch;

  try {
    const committed = await fs.readFile(catalogPath, "utf-8");
    const regenerated = await regeneratePublicSeed({ shardPath: catalogPath, assetsDir });

    // Per-record byte-derived metadata must match what the committed shard pins.
    const records = await seedRecords();
    for (const record of records) {
      const derived = regenerated.records.find((r) => r.id === record.id);
      assert.ok(derived, `regeneration must cover record ${record.id}`);
      assert.equal(
        derived.file.checksum.value,
        record.files[0]?.checksum?.value,
        `${record.id} regenerated checksum must equal committed checksum`,
      );
      assert.equal(derived.file.sizeBytes, record.files[0]?.sizeBytes, `${record.id} sizeBytes must match`);
      assert.equal(derived.file.width, record.technical.width, `${record.id} width must match`);
      assert.equal(derived.file.height, record.technical.height, `${record.id} height must match`);
    }

    // Full-shard idempotency: regenerated text round-trips to the same records as
    // the committed shard (compare parsed objects to be insensitive to trailing whitespace).
    const committedObjs = committed.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
    const regenObjs = regenerated.text.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
    assert.deepEqual(regenObjs, committedObjs, "regenerated shard must be byte-metadata-identical to the committed shard");
  } finally {
    globalThis.fetch = realFetch;
  }
});

// --- Shared helpers for the HTTP/url-path public catalog e2e -----------------------------

/** The bundled CC0 bytes for each public-seed primitive, keyed by primitive. */
async function seedBytesByPrimitive(): Promise<Map<string, Buffer>> {
  const records = await new LocalCatalogSource(catalogPath).load();
  const map = new Map<string, Buffer>();
  for (const record of records) {
    const localPath = record.files[0]?.localPath;
    assert.ok(localPath, `seed record ${record.id} must bundle a localPath byte`);
    map.set(record.primitive, await fs.readFile(path.join(repoRoot, localPath)));
  }
  return map;
}

/** The fixture's attribution-required robot + unverified background records (verbatim). */
async function fixtureNonTrustedRecords(): Promise<unknown[]> {
  const raw = JSON.parse(await fs.readFile(fixtureCatalogPath, "utf-8")) as {
    assets: Array<{ id: string }>;
  };
  return raw.assets.filter((asset) =>
    asset.id === "poly-pizza.fixture.player.robot" ||
    asset.id === "scraped.fixture.background.candidate"
  );
}

test("browse from a CATALOG URL: public seed assets are trusted-default + selectable; fixture attribution/unverified are not", async () => {
  // Serve a JSONL shard over a real 127.0.0.1 HTTP server. HttpCatalogSource has NO host
  // block (the SSRF guard lives only in the BYTE provider), so 127.0.0.1 is fine here, and
  // this proves the browse path against an actual catalog URL — fully network-free.
  const seedLines = (await fs.readFile(catalogPath, "utf-8")).split("\n").filter((line) => line.trim());
  const fixtureLines = (await fixtureNonTrustedRecords()).map((record) => JSON.stringify(record));
  const shardBody = `${[...seedLines, ...fixtureLines].join("\n")}\n`;

  const server = http.createServer((req, res) => {
    if (req.url === "/catalog/2d-platformer/part-00000.jsonl") {
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.end(shardBody);
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const { port } = server.address() as AddressInfo;
    const catalogUrl = `http://127.0.0.1:${port}/catalog/2d-platformer/part-00000.jsonl`;

    const payload = await buildAssetBrowserPayload({ catalogPath: catalogUrl, profilePath });
    const byId = new Map<string, AssetBrowserAsset>(payload.assets.map((asset) => [asset.id, asset]));

    // The 4 trusted-default public-seed assets: correct trustTier/policyStatus + `select`.
    for (const id of [
      "kenney.public.tile.grass",
      "kenney.public.player.character",
      "kenney.public.background.clouds",
      "kenney.public.collectible.coin",
    ]) {
      const asset = byId.get(id);
      assert.ok(asset, `seed asset ${id} must appear in the browse payload`);
      assert.equal(asset.trustTier, "trusted-default", `${id} trustTier`);
      assert.equal(asset.policyStatus, "trusted-default", `${id} policyStatus`);
      assert.ok(asset.actionIntents?.includes("select"), `${id} must allow select`);
      assert.ok(
        !asset.actionIntents?.includes("request-explicit-approval"),
        `${id} must NOT require explicit approval`,
      );
    }

    // Trust boundary in the BROWSE payload: attribution-required + unverified are visible
    // but non-selectable (request-explicit-approval, never auto-select).
    const robot = byId.get("poly-pizza.fixture.player.robot");
    assert.ok(robot, "attribution-required robot must be browseable");
    assert.equal(robot.trustTier, "attribution-required", "robot trustTier");
    assert.equal(robot.policyStatus, "attribution-required", "robot policyStatus");
    assert.ok(
      robot.actionIntents?.includes("request-explicit-approval"),
      "robot must require explicit approval",
    );
    assert.ok(!robot.actionIntents?.includes("select"), "robot must NOT be auto-selectable");

    const background = byId.get("scraped.fixture.background.candidate");
    assert.ok(background, "unverified background must be browseable");
    assert.equal(background.trustTier, "unverified-discovery", "background trustTier");
    assert.equal(background.policyStatus, "unverified-discovery", "background policyStatus");
    assert.ok(
      background.actionIntents?.includes("request-explicit-approval"),
      "background must require explicit approval",
    );
    assert.ok(!background.actionIntents?.includes("select"), "background must NOT be auto-selectable");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("prepare via HTTP byte-download (no localPath): trusted-default assets download, checksum-verify, and cache", async () => {
  const bytesByPrimitive = await seedBytesByPrimitive();
  const records = await new LocalCatalogSource(catalogPath).load();

  // Build a tmp catalog where each trusted-default record points its file at a PUBLIC
  // https URL and carries NO localPath — forcing the HTTP byte-download path. The pinned
  // sha256 is kept verbatim from the bundled bytes so the checksum gate is real.
  const urlByPrimitive = new Map<string, string>();
  const httpRecords = records.map((record) => {
    const file = record.files[0]!;
    const url = `https://${PUBLIC_ASSET_HOST}/${record.primitive}/${path.basename(file.localPath!)}`;
    urlByPrimitive.set(record.primitive, url);
    const { localPath: _localPath, ...fileRest } = file;
    return { ...record, files: [{ ...fileRest, url }] };
  });

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "loomtide-public-http-e2e-"));
  const httpCatalogPath = path.join(workDir, "catalog/2d-platformer/part-00000.jsonl");
  await fs.mkdir(path.dirname(httpCatalogPath), { recursive: true });
  await fs.writeFile(httpCatalogPath, `${httpRecords.map((r) => JSON.stringify(r)).join("\n")}\n`);
  const outputPath = path.join(workDir, "assets.json");
  const cacheDir = path.join(workDir, "cache");

  // fakeFetch serves the bundled byte for each url — no real socket is ever opened.
  const requestedUrls: string[] = [];
  const fakeFetch = (async (url: string) => {
    requestedUrls.push(url);
    const primitive = [...urlByPrimitive.entries()].find(([, value]) => value === url)?.[0];
    assert.ok(primitive, `fakeFetch received an unexpected url: ${url}`);
    const body = bytesByPrimitive.get(primitive)!;
    return {
      ok: true,
      status: 200,
      headers: { get: (name: string) => (name.toLowerCase() === "content-length" ? String(body.byteLength) : null) },
      arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
    };
  }) as unknown as ConstructorParameters<typeof HttpAssetProvider>[0];

  // fakeResolver returns a FIXED PUBLIC ip for every hostname, so the SSRF guard sees a
  // public host AND a public resolved ip — it stays intact, with zero real DNS.
  const fakeResolver = async () => [{ address: FAKE_PUBLIC_IP }];

  // Offline guard: any real network use is a hard failure.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("network access is forbidden in the HTTP public-seed e2e");
  }) as typeof fetch;

  try {
    const report = await prepareAssets(
      {
        profilePath,
        catalogPath: httpCatalogPath,
        outputPath,
        cacheDir,
        primitives: [...PRIMITIVES],
      },
      {
        providers: [
          new StubGenerationProvider(),
          new LocalAssetProvider(),
          new HttpAssetProvider(fakeFetch, undefined, fakeResolver),
        ],
      },
    );

    assert.equal(
      report.status,
      "pass",
      `expected pass; assets: ${JSON.stringify(report.assets.map((a) => ({ id: a.id, status: a.status, rejections: a.rejections })), null, 2)}`,
    );
    assert.equal(report.assets.length, PRIMITIVES.length, "one asset per requested primitive");
    assert.equal(requestedUrls.length, PRIMITIVES.length, "each asset must be downloaded over HTTP");

    for (const primitive of PRIMITIVES) {
      const asset = report.assets.find((candidate) => candidate.primitive === primitive)!;
      assert.equal(asset.status, "accepted", `${primitive} (${asset.id}): ${JSON.stringify(asset.rejections)}`);
      // Downloaded over the http provider (no localPath), so cacheStatus is a fresh miss.
      assert.equal(asset.cacheStatus, "miss", `${primitive} must be a fresh HTTP download`);
      // The DOWNLOADED byte's sha256 must equal the record's pinned checksum (checksum-verified).
      const expected = records.find((r) => r.primitive === primitive)!.files[0]!.checksum!.value;
      assert.equal(asset.checksum?.value, expected, `${primitive} downloaded-byte checksum must match the pinned value`);
      // Independently re-hash the cache file to prove the verified byte is what was written.
      const cacheBytes = await fs.readFile(asset.cachePath);
      assert.equal(
        crypto.createHash("sha256").update(cacheBytes).digest("hex"),
        expected,
        `${primitive} cache file sha256 must match the pinned value`,
      );
      assert.equal((await fs.stat(asset.cachePath)).isFile(), true, `${primitive} cache file must exist`);
    }
  } finally {
    globalThis.fetch = realFetch;
    await fs.rm(workDir, { recursive: true, force: true });
  }
});

test("trust boundary: select/prepare admit ONLY trusted-default; attribution/unverified are never selected", async () => {
  // Serve seed (trusted-default) + fixture (attribution-required robot, unverified background)
  // from one 127.0.0.1 shard, then prove select/prepare ignore the non-trusted records.
  const seedLines = (await fs.readFile(catalogPath, "utf-8")).split("\n").filter((line) => line.trim());
  const fixtureLines = (await fixtureNonTrustedRecords()).map((record) => JSON.stringify(record));
  const shardBody = `${[...seedLines, ...fixtureLines].join("\n")}\n`;

  const server = http.createServer((req, res) => {
    if (req.url === "/catalog/2d-platformer/part-00000.jsonl") {
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.end(shardBody);
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const { port } = server.address() as AddressInfo;
    const catalogUrl = `http://127.0.0.1:${port}/catalog/2d-platformer/part-00000.jsonl`;

    // selectAssetsFromCatalog must pick the trusted-default seed records and NOT the
    // attribution-required robot (player) or the unverified background.
    const selected = await selectAssetsFromCatalog(new HttpCatalogSource(catalogUrl), {
      genre: "platformer-2d",
      primitives: ["tile", "player", "background", "collectible"],
    });
    const selectedIds = new Set(selected.map((entry) => entry.id));
    assert.ok(selectedIds.has("kenney.public.player.character"), "trusted player must be selected");
    assert.ok(selectedIds.has("kenney.public.background.clouds"), "trusted background must be selected");
    assert.ok(
      !selectedIds.has("poly-pizza.fixture.player.robot"),
      "attribution-required robot must NEVER be auto-selected",
    );
    assert.ok(
      !selectedIds.has("scraped.fixture.background.candidate"),
      "unverified background must NEVER be auto-selected",
    );

    // The same is true through the full prepare path: the prepared output contains only
    // the trusted-default records, one per primitive. Use a LOCAL catalog (seed + fixture
    // records) under asset-layer/ so localPath resolves against the repo root and prepare
    // stays offline (the bundled seed bytes resolve via LocalAssetProvider; the fixture
    // robot/background are filtered out by the trust gate before any HTTP is attempted).
    const trustDir = path.join(repoRoot, "asset-layer/catalog-public/.tmp-trust-boundary");
    const trustCatalogPath = path.join(trustDir, "2d-platformer/part-00000.jsonl");
    await fs.mkdir(path.dirname(trustCatalogPath), { recursive: true });
    const seedRecordObjs = seedLines.map((line) => JSON.parse(line));
    const fixtureRecordObjs = await fixtureNonTrustedRecords();
    await fs.writeFile(
      trustCatalogPath,
      `${[...seedRecordObjs, ...fixtureRecordObjs].map((r) => JSON.stringify(r)).join("\n")}\n`,
    );
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "loomtide-trust-boundary-e2e-"));
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("network access is forbidden in the trust-boundary prepare e2e");
    }) as typeof fetch;
    try {
      const report = await prepareAssets(
        {
          profilePath,
          catalogPath: trustCatalogPath,
          outputPath: path.join(workDir, "assets.json"),
          cacheDir: path.join(workDir, "cache"),
          primitives: ["tile", "player", "background", "collectible"],
        },
        // Local provider resolves the bundled seed bytes; the non-trusted fixture records
        // are dropped by the trust gate, so the http provider is never exercised here.
        { providers: [new StubGenerationProvider(), new LocalAssetProvider(), new HttpAssetProvider()] },
      );
      const preparedIds = new Set(report.assets.map((asset) => asset.id));
      assert.ok(!preparedIds.has("poly-pizza.fixture.player.robot"), "robot must not be prepared");
      assert.ok(!preparedIds.has("scraped.fixture.background.candidate"), "unverified bg must not be prepared");
      assert.equal(report.assets.length, 4, "exactly the 4 trusted-default seed assets prepare");
      assert.ok(report.assets.every((asset) => asset.id.startsWith("kenney.public.")), "only trusted seed records prepared");
    } finally {
      globalThis.fetch = realFetch;
      await fs.rm(workDir, { recursive: true, force: true });
      await fs.rm(trustDir, { recursive: true, force: true });
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
