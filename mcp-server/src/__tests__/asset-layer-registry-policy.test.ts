import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadAssetProfile, loadRegistryPack, validateRegistryPolicy } from "../capabilities/assets/registry.js";
import type { AssetProfile, AssetRegistryEntry, AssetRegistryPack } from "../capabilities/assets/types.js";
import { REPO_ROOT } from "./_support/paths.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = REPO_ROOT;

const profilePath = path.join(repoRoot, "asset-layer/profiles/2d-platformer.json");
const registryPath = path.join(repoRoot, "asset-layer/registry/platformer-2d.json");

async function loadBaseline(): Promise<{ profile: AssetProfile; registry: AssetRegistryPack; entry: AssetRegistryEntry }> {
  const profile = await loadAssetProfile(profilePath);
  const registry = await loadRegistryPack(registryPath);
  const entry = registry.entries[0];
  assert.ok(entry);
  return { profile, registry, entry };
}

function packWith(entries: AssetRegistryEntry[]): AssetRegistryPack {
  return {
    schemaVersion: "1",
    packId: "policy-test",
    name: "Policy Test",
    entries,
  };
}

test("validateRegistryPolicy accepts the curated platformer registry", async () => {
  const { profile, registry } = await loadBaseline();

  assert.deepEqual(validateRegistryPolicy(registry, profile), []);
});

test("validateRegistryPolicy emits deterministic duplicate id, metadata, license, source, kind, and checksum issues", async () => {
  const { profile, entry } = await loadBaseline();
  const invalid: AssetRegistryEntry = {
    ...entry,
    kind: "sprite",
    source: {
      ...entry.source,
      title: "",
      verified: false,
      provenance: {
        ...entry.source.provenance,
        verifiedAt: "",
      },
    },
    license: {
      ...entry.license,
      spdx: "CC-BY-NC-4.0",
    },
    provider: {
      ...entry.provider,
      name: "",
    },
    files: [
      {
        ...entry.files[0],
        checksum: {
          algorithm: "sha256",
          value: "not-a-sha",
        },
      },
    ],
  };
  const duplicate = { ...entry };
  const registry = packWith([invalid, duplicate]);

  const issues = validateRegistryPolicy(registry, profile).map((issue) => ({
    code: issue.code,
    path: issue.path,
  }));

  assert.deepEqual(issues, [
    { code: "INVALID_CHECKSUM_DECLARATION", path: "entries[0].files[0].checksum" },
    { code: "DENIED_LICENSE", path: "entries[0].license.spdx" },
    { code: "DISALLOWED_LICENSE", path: "entries[0].license.spdx" },
    { code: "MISSING_PROVIDER", path: "entries[0].provider" },
    { code: "MISSING_SOURCE", path: "entries[0].source" },
    { code: "MISSING_PROVENANCE", path: "entries[0].source.provenance.verifiedAt" },
    { code: "SOURCE_UNVERIFIED", path: "entries[0].source.verified" },
    { code: "DUPLICATE_ID", path: "entries[1].id" },
  ]);
});

test("validateRegistryPolicy rejects unknown kinds and unsupported primitive/kind pairings", async () => {
  const { profile, entry } = await loadBaseline();
  const unknownKind = {
    ...entry,
    id: "policy.unknown-kind",
    kind: "texture" as "sprite",
  };
  const unsupportedPair = {
    ...entry,
    id: "policy.unsupported-pair",
    kind: "audio" as "sprite",
  };

  const issues = validateRegistryPolicy(packWith([unknownKind, unsupportedPair]), profile).map((issue) => ({
    code: issue.code,
    path: issue.path,
  }));

  assert.deepEqual(issues, [
    { code: "UNKNOWN_KIND", path: "entries[0].kind" },
    { code: "UNSUPPORTED_PRIMITIVE_KIND", path: "entries[1].primitive" },
  ]);
});
