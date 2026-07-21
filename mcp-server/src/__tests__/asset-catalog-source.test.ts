import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  ApiCatalogSource,
  catalogUrlFromEnv,
  type CatalogFetch,
  type CatalogSource,
  HttpCatalogSource,
  LocalCatalogSource,
  queryCatalogRecords,
  selectAssetsFromCatalog,
  sortCatalogCandidates,
} from "../asset-layer/catalog-source.js";
import { catalogRecordToRegistryEntry, normalizeCatalogRecord } from "../asset-layer/catalog.js";
import { selectCatalogAssets } from "../asset-layer/registry.js";
import { trustTierForEntry } from "../asset-layer/trust.js";
import type { AssetCatalogRecord } from "../asset-layer/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../../..");
const fixturePath = path.join(repoRoot, "asset-layer/catalog-fixtures/platformer-catalog.json");

function candidate(overrides: Partial<AssetCatalogRecord>): AssetCatalogRecord {
  return normalizeCatalogRecord({
    id: "fixture.asset",
    genre: "platformer-2d",
    primitive: "tile",
    kind: "sprite",
    priority: 0,
    source: {
      title: "Fixture",
      url: "https://example.invalid/fixture",
      author: "Fixture",
      provenance: {
        verifiedAt: "2026-06-05T00:00:00.000Z",
        origin: "test",
        fixture: "fixture",
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
      url: "https://example.invalid/",
      acquisitionLane: "mirror-index",
    },
    files: [
      {
        role: "sprite",
        format: "png",
        url: "https://example.invalid/fixture.png",
        checksum: {
          algorithm: "sha256",
          value: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        },
      },
    ],
    technical: { width: 16, height: 16, pixelsPerUnit: 100 },
    tags: ["fixture"],
    unity: { path: "Assets/Art/fixture.png", pixelsPerUnit: 100 },
    review: {
      status: "verified",
      verifiedBy: "developer",
      verifiedAt: "2026-06-05T00:00:00.000Z",
      reviewer: "test",
    },
    ...overrides,
  });
}

test("asset catalog source loads local JSON fixture and preserves provider metadata", async () => {
  const source = new LocalCatalogSource(fixturePath);
  const records = await source.load();

  assert.equal(records.length, 3);
  assert.equal(records[0]?.provider.acquisitionLane, "mirror-index");
  assert.equal(records[0]?.trustTier, "trusted-default");
  assert.equal(records[1]?.provider.termsNotes, "Attribution required; visible candidate only.");
  assert.equal(records[2]?.review.status, "needs-review");
});

test("asset catalog source filters by genre, primitive, kind, tags, license, provider, verification, and text", async () => {
  const source = new LocalCatalogSource(fixturePath);

  const tiles = await source.query({
    genre: "platformer-2d",
    primitive: "tile",
    kind: "sprite",
    tags: ["grass"],
    license: "CC0-1.0",
    provider: "kenney",
    verificationStatus: "verified",
    text: "pixel",
  });
  assert.deepEqual(tiles.map((record) => record.id), ["kenney.fixture.tile.grass"]);

  const unreviewed = await source.query({ verificationStatus: "needs-review" });
  assert.deepEqual(unreviewed.map((record) => record.id), ["scraped.fixture.background.candidate"]);
});

test("asset catalog source treats generic game-asset records as browseable for profile genres", () => {
  const records = [
    candidate({ id: "a.generic.asset", genre: "game-asset" }),
    candidate({ id: "b.platformer.asset", genre: "platformer-2d" }),
    candidate({ id: "c.topdown.asset", genre: "topdown-2d" }),
  ];

  const result = queryCatalogRecords(records, { genre: "platformer-2d" });

  assert.deepEqual(result.map((record) => record.id), ["a.generic.asset", "b.platformer.asset"]);
});

test("asset catalog sorting is deterministic: verified, preferred license, priority, id", () => {
  const records = [
    candidate({
      id: "z.needs-review.high-priority",
      priority: 100,
      review: { status: "needs-review" },
    }),
    candidate({
      id: "b.verified.cc0.low-priority",
      priority: 1,
      license: {
        name: "Creative Commons CC0 1.0 Universal",
        spdx: "CC0-1.0",
        url: "https://creativecommons.org/publicdomain/zero/1.0/",
        requiresAttribution: false,
      },
    }),
    candidate({
      id: "a.verified.ccby.high-priority",
      priority: 99,
      license: {
        name: "Creative Commons Attribution 4.0 International",
        spdx: "CC-BY-4.0",
        url: "https://creativecommons.org/licenses/by/4.0/",
        requiresAttribution: true,
      },
    }),
  ];

  const sorted = [...records].sort((a, b) => sortCatalogCandidates(a, b, "CC0-1.0"));

  assert.deepEqual(sorted.map((record) => record.id), [
    "b.verified.cc0.low-priority",
    "a.verified.ccby.high-priority",
    "z.needs-review.high-priority",
  ]);
});

test("asset catalog source supports mocked HTTP JSONL without live network", async () => {
  const jsonlRecord = candidate({
    id: "kenney.http.fixture.tile",
    acquisitionLane: "mirror-index",
    trustTier: "trusted-default",
  });
  const source = new HttpCatalogSource("https://example.invalid/catalog/part-0001.jsonl", async () => ({
    ok: true,
    status: 200,
    async text() {
      return `${JSON.stringify(jsonlRecord)}\n`;
    },
  }));

  const records = await source.query({ provider: "Fixture", verificationStatus: "verified" });

  assert.deepEqual(records.map((record) => record.id), ["kenney.http.fixture.tile"]);
});

test("asset catalog source loads sharded HTTP catalog roots until first missing part", async () => {
  const first = candidate({ id: "kenney.http.fixture.tile.a" });
  const second = candidate({ id: "kenney.http.fixture.tile.b" });
  const fetched: string[] = [];
  const source = new HttpCatalogSource("https://raw.githubusercontent.com/example-org/example-asset-mirror/main/catalog/assets/kenney-all-in-one-3.5.0", async (url) => {
    fetched.push(url);
    if (url.endsWith("/part-00000.jsonl")) {
      return {
        ok: true,
        status: 200,
        async text() {
          return `${JSON.stringify(first)}\n`;
        },
      };
    }
    if (url.endsWith("/part-00001.jsonl")) {
      return {
        ok: true,
        status: 200,
        async text() {
          return `${JSON.stringify(second)}\n`;
        },
      };
    }
    return {
      ok: false,
      status: 404,
      async text() {
        return "";
      },
    };
  });

  const records = await source.load();

  assert.deepEqual(records.map((record) => record.id), [
    "kenney.http.fixture.tile.a",
    "kenney.http.fixture.tile.b",
  ]);
  assert.equal(fetched.some((url) => url.endsWith("/part-00002.jsonl")), true);
  assert.equal(fetched.at(-1)?.endsWith("/part-00010.jsonl"), true);
});

test("asset catalog source rejects non-contiguous shard roots", async () => {
  const first = candidate({ id: "kenney.http.fixture.tile.a" });
  const third = candidate({ id: "kenney.http.fixture.tile.c" });
  const source = new HttpCatalogSource("https://example.invalid/catalog/assets/gap", async (url) => {
    if (url.endsWith("/part-00000.jsonl")) {
      return {
        ok: true,
        status: 200,
        async text() {
          return `${JSON.stringify(first)}\n`;
        },
      };
    }
    if (url.endsWith("/part-00002.jsonl")) {
      return {
        ok: true,
        status: 200,
        async text() {
          return `${JSON.stringify(third)}\n`;
        },
      };
    }
    return {
      ok: false,
      status: 404,
      async text() {
        return "";
      },
    };
  });

  await assert.rejects(() => source.load(), /non-contiguous/);
});

test("asset catalog source skips unsupported inventory records without dropping usable assets", async () => {
  const image = candidate({ id: "kenney.http.fixture.preview" });
  const instruction = {
    ...candidate({ id: "kenney.http.fixture.instructions" }),
    kind: undefined,
    files: [{
      role: "decor",
      format: "url",
      url: "https://example.invalid/Instructions.url",
      checksum: {
        algorithm: "sha256",
        value: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      },
    }],
  };
  const source = new HttpCatalogSource("https://example.invalid/catalog/part-0001.jsonl", async () => ({
    ok: true,
    status: 200,
    async text() {
      return `${JSON.stringify(instruction)}\n${JSON.stringify(image)}\n`;
    },
  }));

  const records = await source.load();

  assert.deepEqual(records.map((record) => record.id), ["kenney.http.fixture.preview"]);
});

test("asset catalog source falls back to one-based four-digit shard roots", async () => {
  const first = candidate({ id: "legacy.http.fixture.tile.a" });
  const fetched: string[] = [];
  const source = new HttpCatalogSource("https://example.invalid/catalog/assets/legacy", async (url) => {
    fetched.push(url);
    if (url.endsWith("/part-0001.jsonl")) {
      return {
        ok: true,
        status: 200,
        async text() {
          return `${JSON.stringify(first)}\n`;
        },
      };
    }
    return {
      ok: false,
      status: 404,
      async text() {
        return "";
      },
    };
  });

  const records = await source.load();

  assert.deepEqual(records.map((record) => record.id), ["legacy.http.fixture.tile.a"]);
  assert.equal(fetched.some((url) => url.endsWith("/part-00000.jsonl")), true);
  assert.equal(fetched.some((url) => url.endsWith("/part-0001.jsonl")), true);
});

test("asset catalog source sends auth only to GitHub catalog URLs", async () => {
  const jsonlRecord = candidate({ id: "kenney.private.fixture.tile" });
  let githubAuth: string | undefined;
  let externalAuth: string | undefined;
  const response = {
    ok: true,
    status: 200,
    async text() {
      return `${JSON.stringify(jsonlRecord)}\n`;
    },
  };

  await new HttpCatalogSource(
    "https://raw.githubusercontent.com/example-org/example-asset-mirror/main/catalog/assets/part-0001.jsonl",
    async (_url, init) => {
      githubAuth = init?.headers?.Authorization;
      return response;
    },
    "github-secret",
  ).load();
  await new HttpCatalogSource(
    "https://example.invalid/catalog/part-0001.jsonl",
    async (_url, init) => {
      externalAuth = init?.headers?.Authorization;
      return response;
    },
    "github-secret",
  ).load();

  assert.equal(githubAuth, "Bearer github-secret");
  assert.equal(externalAuth, undefined);
});

test("asset catalog env REFUSES when unset (no private-mirror default) and honors an explicit URL", () => {
  assert.throws(
    () => catalogUrlFromEnv({}),
    /LOOMTIDE_ASSET_CATALOG_URL/,
    "an unset catalog env must refuse with actionable guidance, never fall back to a private mirror",
  );
  assert.equal(
    catalogUrlFromEnv({ LOOMTIDE_ASSET_CATALOG_URL: "https://example.invalid/catalog" }),
    "https://example.invalid/catalog",
  );
});

test("asset registry compatibility path selects verified hosted catalog candidates as registry entries", async () => {
  const source = new LocalCatalogSource(fixturePath);
  const selected = await selectCatalogAssets(source, {
    genre: "platformer-2d",
    primitives: ["tile", "background"],
    preferredLicense: "CC0-1.0",
  });

  assert.deepEqual(selected.map((entry) => entry.id), ["kenney.fixture.tile.grass"]);
  assert.equal(selected[0]?.files[0]?.githubRawUrl?.includes("example-asset-mirror"), true);
});

test("asset catalog source can query in-memory records with text search", () => {
  const records = [
    candidate({ id: "a.robot", primitive: "player", source: { ...candidate({}).source, title: "Helpful Robot" } }),
    candidate({ id: "b.tile", primitive: "tile", source: { ...candidate({}).source, title: "Grass Tile" } }),
  ];

  const result = queryCatalogRecords(records, { text: "robot" });

  assert.deepEqual(result.map((record) => record.id), ["a.robot"]);
});

test("selectAssetsFromCatalog only auto-selects locally-derived trusted-default records", async () => {
  const source = new LocalCatalogSource(fixturePath);
  const selected = await selectAssetsFromCatalog(source, {
    genre: "platformer-2d",
    primitives: ["tile", "player", "background"],
    preferredLicense: "CC0-1.0",
  });

  const ids = selected.map((entry) => entry.id);
  assert.deepEqual(ids, ["kenney.fixture.tile.grass"]);
  // The CC-BY attribution-required robot must NOT be auto-selected for `player`.
  assert.equal(ids.includes("poly-pizza.fixture.player.robot"), false);
  // The unreviewed scraped background candidate must NOT be auto-selected.
  assert.equal(ids.includes("scraped.fixture.background.candidate"), false);
});

test("trustTierForEntry refuses to honor an asserted trusted-default on an attribution-required asset", async () => {
  // Hand-crafted hostile catalog record: asserts trusted-default + verified, but the license
  // is CC-BY-4.0 with requiresAttribution. The asserted tier must NOT elevate it.
  const hostile = normalizeCatalogRecord({
    id: "hostile.fixture.player.attribution",
    genre: "platformer-2d",
    primitive: "player",
    kind: "sprite",
    priority: 100,
    source: {
      title: "Hostile Attribution Asset",
      url: "https://example.invalid/hostile",
      author: "Example Artist",
      verified: true,
      provenance: {
        verifiedAt: "2026-06-05T00:00:00.000Z",
        origin: "test",
        fixture: "hostile",
      },
    },
    license: {
      name: "Creative Commons Attribution 4.0 International",
      spdx: "CC-BY-4.0",
      url: "https://creativecommons.org/licenses/by/4.0/",
      requiresAttribution: true,
    },
    provider: {
      name: "Hostile",
      url: "https://example.invalid/",
      acquisitionLane: "api",
    },
    files: [
      {
        role: "sprite",
        format: "png",
        url: "https://example.invalid/hostile.png",
        checksum: {
          algorithm: "sha256",
          value: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        },
      },
    ],
    technical: { width: 64, height: 64, pixelsPerUnit: 100 },
    tags: ["player", "hostile"],
    unity: { path: "Assets/Art/hostile.png", pixelsPerUnit: 100 },
    trustTier: "trusted-default",
    review: {
      status: "verified",
      verifiedBy: "developer",
      verifiedAt: "2026-06-05T00:00:00.000Z",
      reviewer: "test",
    },
  });

  // The locally derived tier downgrades the asserted trusted-default to attribution-required.
  assert.equal(trustTierForEntry(catalogRecordToRegistryEntry(hostile)), "attribution-required");

  // And it is NOT auto-selected by selectAssetsFromCatalog.
  const source: CatalogSource = {
    async load() {
      return [hostile];
    },
    async query(options) {
      return queryCatalogRecords([hostile], options);
    },
  };
  const selected = await selectAssetsFromCatalog(source, {
    genre: "platformer-2d",
    primitives: ["player"],
  });
  assert.deepEqual(selected.map((entry) => entry.id), []);
});

test("ApiCatalogSource maps a DB-backed search response to AssetCatalogRecord[] (injected fetch, network-free)", async () => {
  const record = candidate({ id: "api.search.tile.grass", primitive: "tile" });
  let requestedUrl: string | undefined;
  const fetcher: CatalogFetch = async (url) => {
    requestedUrl = url;
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({ records: [record] });
      },
    };
  };

  const source = new ApiCatalogSource("https://api.example.invalid", fetcher);
  const records = await source.query({
    genre: "platformer-2d",
    primitive: "tile",
    kind: "sprite",
    tags: ["grass", "ground"],
    text: "pixel art",
  });

  assert.deepEqual(records.map((r) => r.id), ["api.search.tile.grass"]);
  // Every query param is URL-encoded and mapped to the API contract.
  assert.ok(requestedUrl);
  const url = new URL(requestedUrl!);
  assert.equal(url.pathname, "/v1/assets/search");
  assert.equal(url.searchParams.get("profile"), "platformer-2d");
  assert.equal(url.searchParams.get("primitive"), "tile");
  assert.equal(url.searchParams.get("kind"), "sprite");
  assert.equal(url.searchParams.get("tags"), "grass,ground");
  assert.equal(url.searchParams.get("text"), "pixel art");
  // The raw query string must be percent-encoded (space -> %20 or +).
  assert.match(url.search, /text=pixel(\+|%20)art/);
});

test("ApiCatalogSource also accepts an { assets: [...] } response and load() returns all", async () => {
  const record = candidate({ id: "api.search.player.robot", primitive: "player" });
  const fetcher: CatalogFetch = async () => ({
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify({ assets: [record] });
    },
  });

  const source = new ApiCatalogSource("https://api.example.invalid/", fetcher);
  const records = await source.load();
  assert.deepEqual(records.map((r) => r.id), ["api.search.player.robot"]);
});

test("ApiCatalogSource re-validates returned records — a malformed record from the API is rejected", async () => {
  // The API returns a record with NO files and NO license — the client must NOT trust it; the
  // existing validateLoadedRecords gate rejects it just as it would a shard-loaded record.
  const malformed = {
    ...candidate({ id: "api.malformed.record" }),
    files: [],
    license: undefined,
  };
  const fetcher: CatalogFetch = async () => ({
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify({ records: [malformed] });
    },
  });

  const source = new ApiCatalogSource("https://api.example.invalid", fetcher);
  await assert.rejects(() => source.query({ genre: "platformer-2d" }), /Invalid catalog record/);
});

test("ApiCatalogSource surfaces a non-200 search response as an error", async () => {
  const fetcher: CatalogFetch = async () => ({
    ok: false,
    status: 503,
    async text() {
      return "";
    },
  });
  const source = new ApiCatalogSource("https://api.example.invalid", fetcher);
  await assert.rejects(() => source.query({}), /HTTP 503/);
});

test("selectAssetsFromCatalog gates select but browse (source.query) still surfaces every tier", async () => {
  const source = new LocalCatalogSource(fixturePath);
  const browsed = await source.query({ genre: "platformer-2d" });
  assert.deepEqual(
    browsed.map((record) => record.id).sort(),
    [
      "kenney.fixture.tile.grass",
      "poly-pizza.fixture.player.robot",
      "scraped.fixture.background.candidate",
    ],
  );
});
