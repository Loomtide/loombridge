import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { readWavMetadata } from "../asset-layer/audio-metadata.js";
import { prepareAssets } from "../asset-layer/prepare-cli.js";
import { loadAssetProfile, loadRegistryPack } from "../asset-layer/registry.js";
import { validatePreparedAudio } from "../asset-layer/validator.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../../..");
const profilePath = path.join(repoRoot, "asset-layer/profiles/2d-platformer.json");
const registryPath = path.join(repoRoot, "asset-layer/registry/platformer-2d.json");
const audioPath = path.join(repoRoot, "asset-layer/fixtures/platformer/sfx/fupi-plingy-coin/coin.wav");

test("readWavMetadata parses deterministic PCM WAV metadata", async () => {
  const metadata = await readWavMetadata(audioPath);

  assert.deepEqual(metadata, {
    format: "wav",
    sampleRate: 44100,
    channels: 2,
    bitDepth: 16,
    durationMs: 904,
  });
});

test("validatePreparedAudio accepts profile-compliant optional audio", async () => {
  const profile = await loadAssetProfile(profilePath);
  const registry = await loadRegistryPack(registryPath);
  const entry = registry.entries.find((candidate) => candidate.primitive === "sfx_collect");
  assert.ok(entry);

  const result = await validatePreparedAudio({
    entry,
    profile,
    sourcePath: audioPath,
    unityPath: entry.unity.path,
  });

  assert.equal(result.status, "accepted");
  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.metadata, {
    format: "wav",
    sampleRate: 44100,
    channels: 2,
    bitDepth: 16,
    durationMs: 904,
  });
});

test("prepareAssets reports accepted audio separately from sprite imports", async () => {
  const report = await prepareAssets({
    profilePath,
    registryPath,
    outputPath: path.join(repoRoot, "demo/.artifacts/platformer-assets.audio-test.json"),
    cacheDir: path.join(repoRoot, "demo/.artifacts/asset-cache-audio-test"),
    genre: "platformer-2d",
    primitives: ["sfx_collect"],
  });

  assert.equal(report.status, "pass");
  assert.equal(report.assets[0]?.kind, "audio");
  assert.equal(report.assets[0]?.metadata?.format, "wav");
  assert.equal(report.diagnostics.byKind?.audio?.accepted, 1);
  assert.deepEqual(report.diagnostics.acceptedImports, []);
});
