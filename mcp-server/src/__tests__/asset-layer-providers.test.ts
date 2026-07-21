import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { LocalAssetProvider } from "../asset-layer/providers/local-provider.js";
import { HttpAssetProvider } from "../asset-layer/providers/http-provider.js";
import { StubGenerationProvider } from "../asset-layer/providers/stub-generation-provider.js";
import type { AssetFile, AssetRegistryEntry } from "../asset-layer/types.js";

const publicResolver = async () => [{ address: "93.184.216.34" }];

function entry(overrides: Partial<AssetRegistryEntry> = {}): AssetRegistryEntry {
  return {
    id: "provider.test.asset",
    genre: "platformer-2d",
    primitive: "tile",
    kind: "sprite",
    source: {
      title: "Provider Test",
      url: "https://example.com/source",
      author: "Example",
      verified: true,
      provenance: { verifiedAt: "2026-05-21", origin: "test", fixture: "fixture" },
    },
    license: {
      name: "Creative Commons CC0 1.0 Universal",
      spdx: "CC0-1.0",
      url: "https://creativecommons.org/publicdomain/zero/1.0/",
      requiresAttribution: false,
    },
    provider: {
      name: "Test Provider",
      url: "https://example.com",
      type: "local",
    },
    files: [],
    technical: { width: 1, height: 1, pixelsPerUnit: 100 },
    tags: ["test"],
    unity: {
      path: "Assets/Art/Sprites/Tiles/test.png",
      pixelsPerUnit: 100,
      spriteMode: "single",
      filterMode: "Bilinear",
    },
    ...overrides,
  };
}

test("LocalAssetProvider copies once and reports cache reuse", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "loomtide-provider-local-"));
  const registryRoot = path.join(tempDir, "repo");
  const sourcePath = path.join(registryRoot, "fixtures", "asset.bin");
  const cachePath = path.join(tempDir, "cache", "asset.bin");
  await fs.mkdir(path.dirname(sourcePath), { recursive: true });
  await fs.writeFile(sourcePath, "local-provider-fixture");
  const provider = new LocalAssetProvider();
  const file: AssetFile = { role: "sprite", format: "png", localPath: "fixtures/asset.bin" };
  const request = { entry: entry({ files: [file] }), file, cachePath, registryRoot };

  const first = await provider.resolve(request);
  const second = await provider.resolve(request);

  assert.equal(first.status, "resolved");
  assert.equal(first.cacheStatus, "miss");
  assert.equal(second.status, "resolved");
  assert.equal(second.cacheStatus, "hit");
  assert.equal(await fs.readFile(cachePath, "utf-8"), "local-provider-fixture");
});

test("LocalAssetProvider rejects paths outside the registry root", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "loomtide-provider-local-block-"));
  const provider = new LocalAssetProvider();
  const file: AssetFile = { role: "sprite", format: "png", localPath: "../outside.bin" };

  const result = await provider.resolve({
    entry: entry({ files: [file] }),
    file,
    cachePath: path.join(tempDir, "cache", "outside.bin"),
    registryRoot: path.join(tempDir, "repo"),
  });

  assert.equal(result.status, "rejected");
  assert.deepEqual(result.diagnostics.map((diagnostic) => diagnostic.code), ["PROVIDER_SOURCE_MISSING"]);
});

test("LocalAssetProvider rejects symlinks that escape the registry root", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "loomtide-provider-local-symlink-"));
  const registryRoot = path.join(tempDir, "repo");
  const outside = path.join(tempDir, "outside");
  await fs.mkdir(path.join(registryRoot, "fixtures"), { recursive: true });
  await fs.mkdir(outside, { recursive: true });
  await fs.writeFile(path.join(outside, "secret.bin"), "secret");
  await fs.symlink(path.join(outside, "secret.bin"), path.join(registryRoot, "fixtures", "secret.bin"));
  const provider = new LocalAssetProvider();
  const file: AssetFile = { role: "sprite", format: "png", localPath: "fixtures/secret.bin" };

  const result = await provider.resolve({
    entry: entry({ files: [file] }),
    file,
    cachePath: path.join(tempDir, "cache", "secret.bin"),
    registryRoot,
  });

  assert.equal(result.status, "rejected");
  assert.deepEqual(result.diagnostics.map((diagnostic) => diagnostic.code), ["PROVIDER_SOURCE_MISSING"]);
});

test("HttpAssetProvider emits deterministic diagnostics for download failures", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "loomtide-provider-http-"));
  const file: AssetFile = { role: "sprite", format: "png", url: "https://example.com/missing.png" };
  const provider = new HttpAssetProvider(async () => ({
    ok: false,
    status: 503,
    arrayBuffer: async () => new ArrayBuffer(0),
  }), undefined, publicResolver);

  const result = await provider.resolve({
    entry: entry({ provider: { name: "Remote", url: "https://example.com", type: "http" }, files: [file] }),
    file,
    cachePath: path.join(tempDir, "missing.png"),
    registryRoot: tempDir,
  });

  assert.equal(result.status, "rejected");
  assert.equal(result.cacheStatus, "miss");
  assert.deepEqual(result.diagnostics.map((diagnostic) => diagnostic.code), ["PROVIDER_DOWNLOAD_FAILED"]);
  assert.match(result.diagnostics[0]?.message ?? "", /HTTP 503/);
});

test("HttpAssetProvider rejects private and non-http URLs before fetching", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "loomtide-provider-http-block-"));
  let fetchCalls = 0;
  const provider = new HttpAssetProvider(async () => {
    fetchCalls += 1;
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => new ArrayBuffer(0),
    };
  }, undefined, publicResolver);
  const localFile: AssetFile = { role: "sprite", format: "png", url: "http://127.0.0.1/metadata.png" };
  const dataFile: AssetFile = { role: "sprite", format: "png", url: "data:image/png;base64,AA==" };

  const local = await provider.resolve({
    entry: entry({ provider: { name: "Remote", url: "https://example.com", type: "http" }, files: [localFile] }),
    file: localFile,
    cachePath: path.join(tempDir, "local.png"),
    registryRoot: tempDir,
  });
  const data = await provider.resolve({
    entry: entry({ provider: { name: "Remote", url: "https://example.com", type: "http" }, files: [dataFile] }),
    file: dataFile,
    cachePath: path.join(tempDir, "data.png"),
    registryRoot: tempDir,
  });

  assert.equal(local.status, "rejected");
  assert.equal(data.status, "rejected");
  assert.equal(fetchCalls, 0);
});

test("HttpAssetProvider rejects DNS names that resolve to private addresses", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "loomtide-provider-http-dns-block-"));
  let fetchCalls = 0;
  const provider = new HttpAssetProvider(async () => {
    fetchCalls += 1;
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => new ArrayBuffer(0),
    };
  }, undefined, async () => [{ address: "169.254.169.254" }]);
  const file: AssetFile = { role: "sprite", format: "png", url: "https://metadata.google.internal/asset.png" };

  const result = await provider.resolve({
    entry: entry({ provider: { name: "Remote", url: "https://example.com", type: "http" }, files: [file] }),
    file,
    cachePath: path.join(tempDir, "metadata.png"),
    registryRoot: tempDir,
  });

  assert.equal(result.status, "rejected");
  assert.equal(fetchCalls, 0);
});

test("HttpAssetProvider rejects redirects and oversized downloads", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "loomtide-provider-http-redirect-size-"));
  const provider = new HttpAssetProvider(async (url) => {
    if (url.includes("redirect")) {
      return {
        ok: false,
        status: 302,
        headers: { get: () => "http://127.0.0.1/metadata" },
        arrayBuffer: async () => new ArrayBuffer(0),
      };
    }
    return {
      ok: true,
      status: 200,
      headers: { get: (name: string) => name.toLowerCase() === "content-length" ? String(51 * 1024 * 1024) : null },
      arrayBuffer: async () => new ArrayBuffer(0),
    };
  }, undefined, publicResolver);
  const redirectFile: AssetFile = { role: "sprite", format: "png", url: "https://example.com/redirect.png" };
  const largeFile: AssetFile = { role: "sprite", format: "png", url: "https://example.com/large.png" };

  const redirect = await provider.resolve({
    entry: entry({ provider: { name: "Remote", url: "https://example.com", type: "http" }, files: [redirectFile] }),
    file: redirectFile,
    cachePath: path.join(tempDir, "redirect.png"),
    registryRoot: tempDir,
  });
  const large = await provider.resolve({
    entry: entry({ provider: { name: "Remote", url: "https://example.com", type: "http" }, files: [largeFile] }),
    file: largeFile,
    cachePath: path.join(tempDir, "large.png"),
    registryRoot: tempDir,
  });

  assert.equal(redirect.status, "rejected");
  assert.match(redirect.diagnostics[0]?.message ?? "", /redirect/i);
  assert.equal(large.status, "rejected");
  assert.match(large.diagnostics[0]?.message ?? "", /too large/i);
});

test("HttpAssetProvider sends GitHub auth without leaking it to provider URLs", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "loomtide-provider-http-auth-"));
  let githubAuth: string | undefined;
  let externalAuth: string | undefined;
  const response = {
    ok: true,
    status: 200,
    arrayBuffer: async () => Buffer.from("downloaded-fixture").buffer,
  };
  const provider = new HttpAssetProvider(async (url, init) => {
    if (url.includes("raw.githubusercontent.com")) {
      githubAuth = init?.headers?.Authorization;
    } else {
      externalAuth = init?.headers?.Authorization;
    }
    return response;
  }, "github-secret", publicResolver);

  const githubFile: AssetFile = {
    role: "sprite",
    format: "png",
    url: "https://raw.githubusercontent.com/example-org/example-asset-mirror/main/assets/fixture.png",
  };
  const externalFile: AssetFile = {
    role: "sprite",
    format: "png",
    url: "https://example.invalid/assets/fixture.png",
  };

  await provider.resolve({
    entry: entry({ provider: { name: "Remote", url: "https://github.com", type: "http" }, files: [githubFile] }),
    file: githubFile,
    cachePath: path.join(tempDir, "github.png"),
    registryRoot: tempDir,
  });
  await provider.resolve({
    entry: entry({ provider: { name: "Remote", url: "https://example.invalid", type: "http" }, files: [externalFile] }),
    file: externalFile,
    cachePath: path.join(tempDir, "external.png"),
    registryRoot: tempDir,
  });

  assert.equal(githubAuth, "Bearer github-secret");
  assert.equal(externalAuth, undefined);
});

test("StubGenerationProvider rejects generation entries without calling services", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "loomtide-provider-generation-"));
  const file: AssetFile = { role: "sprite", format: "png", url: "https://generation.example/request" };
  const provider = new StubGenerationProvider();

  const result = await provider.resolve({
    entry: entry({ provider: { name: "Scenario", url: "https://scenario.example", type: "generation" }, files: [file] }),
    file,
    cachePath: path.join(tempDir, "generated.png"),
    registryRoot: tempDir,
  });

  assert.equal(result.status, "rejected");
  assert.equal(result.cacheStatus, "skipped");
  assert.deepEqual(result.diagnostics.map((diagnostic) => diagnostic.code), ["PROVIDER_NOT_CONFIGURED"]);
});
