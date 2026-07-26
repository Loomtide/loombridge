import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  applyRegistrySelectionsToManifest,
  buildAssetPickerSlotsFromRegistrySelectionPlan,
  buildRegistryHeroShotInputs,
  buildRegistrySelectionPlan,
} from "../capabilities/assets/manifest-selection.js";
import { loadAssetProfile, loadRegistryPack } from "../capabilities/assets/registry.js";
import { createDraftAssetManifest, validateAssetManifest } from "../capabilities/assets/asset-manifest.js";
import { evaluateAssetSourceFidelity } from "../capabilities/verification/gates/asset-source-fidelity.js";
import { REPO_ROOT } from "./_support/paths.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = REPO_ROOT;
const HASH = "b".repeat(64);

async function fixture() {
  const registry = await loadRegistryPack(path.join(repoRoot, "asset-layer/registry/platformer-2d.json"));
  const profile = await loadAssetProfile(path.join(repoRoot, "asset-layer/profiles/2d-platformer.json"));
  const manifest = createDraftAssetManifest({
    mode: "registry",
    heroShot: {
      path: ".loombridge/design/hero-shot.png",
      sha256: HASH,
    },
    registry: registry.packId,
  });
  return { registry, profile, manifest };
}

async function fixture3dShooter() {
  const registry = await loadRegistryPack(path.join(repoRoot, "asset-layer/registry/3d-shooter.json"));
  const profile = await loadAssetProfile(path.join(repoRoot, "asset-layer/profiles/3d-shooter.json"));
  const manifest = createDraftAssetManifest({
    mode: "registry",
    heroShot: { path: ".loombridge/design/hero-shot.png", sha256: HASH },
    registry: registry.packId,
    genre: "3d-shooter",
  });
  return { registry, profile, manifest };
}

test("3d-shooter registry manifest drafts, selects, applies, and approves with source-bound model paths", async () => {
  const { registry, profile, manifest } = await fixture3dShooter();
  assert.equal(manifest.genre, "3d-shooter");

  const plan = buildRegistrySelectionPlan(manifest, registry, profile, { preferredLicense: "CC0-1.0" });
  assert.deepEqual(plan.issues, []);
  assert.equal(plan.pack.id, "3d-shooter");
  assert.equal(plan.slots.length, manifest.assets.length);

  // The model roles select a real, source-bound glb candidate with full provenance.
  const player = plan.slots.find((slot) => slot.assetId === "player_model");
  assert.ok(player);
  assert.equal(player.selectedId, "quaternius.shooter.player.robot");
  assert.ok(player.candidates.length > 1, "player_model should also offer the primitive fallback");
  assert.equal(player.candidates[0]?.license.spdx, "CC0-1.0");
  assert.ok(player.candidates[0]?.source.provenance.verifiedAt);
  assert.ok(player.candidates[0]?.unityPath.startsWith("Assets/Models/"));
  assert.equal(player.candidates[0]?.kind, "model");

  const selections = Object.fromEntries(plan.slots.map((slot) => [slot.assetId, slot.selectedId ?? slot.candidates[0]!.id]));
  const approved = applyRegistrySelectionsToManifest({
    manifest,
    registry,
    profile,
    selections,
    approvedAt: "2026-06-26T00:00:00.000Z",
    preferredLicense: "CC0-1.0",
  });

  const validation = validateAssetManifest(approved);
  assert.equal(validation.valid, true, JSON.stringify(validation.issues, null, 2));
  assert.equal(approved.status, "approved");
  assert.equal(approved.genre, "3d-shooter", "genre is preserved through approval");
  assert.equal(approved.assetSources.find((source) => source.kind === "registry-pack")?.approved, true);

  // Every approved asset is source-bound: a resolved Unity path + registrySelection provenance/license/source.
  for (const asset of approved.assets) {
    assert.equal(asset.source, "registry", `${asset.id} should be registry-sourced`);
    assert.equal(asset.status, "approved", `${asset.id} should be approved (real candidate)`);
    assert.ok(asset.resolvedPaths?.[0]?.startsWith("Assets/"), `${asset.id} resolvedPath under Assets/`);
    assert.ok(asset.registrySelection, `${asset.id} carries registrySelection`);
    assert.equal(asset.registrySelection?.license.spdx, "CC0-1.0");
    assert.ok(asset.registrySelection?.source.title, `${asset.id} carries source title`);
    assert.ok(asset.registrySelection?.source.provenance.verifiedAt, `${asset.id} carries provenance`);
    assert.equal(asset.registrySelection?.placeholder, false);
  }

  // Hero-shot inputs enumerate every 3d-shooter role in manifest order.
  const inputs = buildRegistryHeroShotInputs(approved);
  assert.equal(inputs.length, approved.assets.length);
  assert.deepEqual(inputs.map((input) => input.role), approved.assets.map((asset) => asset.role));
  assert.ok(inputs.every((input) => input.path.startsWith("Assets/")));
  assert.ok(inputs.every((input) => input.license === "CC0-1.0"));
});

test("3d-shooter primitive fallback is recorded as a placeholder, never approved-green", async () => {
  const { registry, profile, manifest } = await fixture3dShooter();
  const plan = buildRegistrySelectionPlan(manifest, registry, profile, { preferredLicense: "CC0-1.0" });
  const selections = Object.fromEntries(plan.slots.map((slot) => [slot.assetId, slot.selectedId ?? slot.candidates[0]!.id]));
  // Deliberately pick the honest capsule fallback for the player model.
  selections.player_model = "loombridge.fallback.player.capsule";

  const result = applyRegistrySelectionsToManifest({
    manifest,
    registry,
    profile,
    selections,
    approvedAt: "2026-06-26T00:00:00.000Z",
    preferredLicense: "CC0-1.0",
  });

  const player = result.assets.find((asset) => asset.id === "player_model");
  assert.ok(player);
  // A fallback resolves a real path + provenance but is marked placeholder — NOT approved.
  assert.equal(player.status, "placeholder");
  assert.equal(player.registrySelection?.placeholder, true);
  assert.ok(player.resolvedPaths?.[0]?.includes("fallback"));
  // The manifest stays valid (placeholders are allowed) but the asset is not certified-green.
  assert.equal(validateAssetManifest(result).valid, true);

  // The asset-source fidelity gate REFUSES the placeholder binding — proving the
  // fallback is never laundered into an approved-green asset, while the all-real
  // siblings still pass.
  const report = evaluateAssetSourceFidelity({ manifest: result });
  const playerBinding = report.checks.find((check) => check.id === "asset-source.binding.player_model");
  assert.equal(playerBinding?.status, "fail", "placeholder player binding must fail the fidelity gate");
  const enemyBinding = report.checks.find((check) => check.id === "asset-source.binding.enemy_model");
  assert.equal(enemyBinding?.status, "pass", "a real sibling asset still passes");
});

test("registry selection plan presents explicit candidates for every registry-first manifest role", async () => {
  const { registry, profile, manifest } = await fixture();

  const plan = buildRegistrySelectionPlan(manifest, registry, profile, { preferredLicense: "CC0-1.0" });

  assert.deepEqual(plan.issues, []);
  assert.equal(plan.pack.id, "platformer-2d");
  assert.equal(plan.slots.length, manifest.assets.length);

  const player = plan.slots.find((slot) => slot.assetId === "player_character");
  assert.ok(player);
  assert.equal(player.selectedId, "kenney.pixel-platformer.player.sheet");
  assert.ok(player.candidates.length > 1, "player role should show alternatives rather than silently selecting one");
  assert.equal(player.candidates[0]?.license.spdx, "CC0-1.0");
  assert.ok(player.candidates[0]?.source.provenance.verifiedAt);
  assert.ok(player.candidates[0]?.unityPath.startsWith("Assets/"));

  const hazard = plan.slots.find((slot) => slot.assetId === "hazard");
  assert.ok(hazard);
  assert.deepEqual(hazard.requiredTags, ["hazard"]);
  assert.equal(hazard.candidates[0]?.id, "kenney.new-platformer.enemy.sheet");
  assert.ok(hazard.candidates.every((candidate) => candidate.tags.includes("hazard")));
});

test("registry selection plan accepts generic hosted catalog assets after primitive inference", async () => {
  const { registry, profile, manifest } = await fixture();
  const genericRegistry = {
    ...registry,
    entries: [{
      ...registry.entries.find((entry) => entry.primitive === "collectible")!,
      id: "kenney.generic.coin",
      genre: "game-asset",
      primitive: "collectible",
      source: {
        ...registry.entries.find((entry) => entry.primitive === "collectible")!.source,
        title: "Generic Hosted Coin",
      },
    }],
  };

  const plan = buildRegistrySelectionPlan(manifest, genericRegistry, profile, { preferredLicense: "CC0-1.0" });
  const collectible = plan.slots.find((slot) => slot.assetId === "collectible");

  assert.ok(collectible);
  assert.equal(collectible.selectedId, "kenney.generic.coin");
  assert.deepEqual(plan.issues.filter((issue) => issue.assetId === "collectible"), []);
});

test("registry selection plan converts to Unity asset picker slots without applying choices", async () => {
  const { registry, profile, manifest } = await fixture();
  const plan = buildRegistrySelectionPlan(manifest, registry, profile);

  const pickerSlots = buildAssetPickerSlotsFromRegistrySelectionPlan(plan);

  assert.equal(pickerSlots.length, plan.slots.length);
  assert.equal(pickerSlots[0]?.slot, "player_character");
  assert.ok(pickerSlots[0]?.selectedId);
  assert.ok(pickerSlots[0]?.options[0]?.badges.includes("CC0-1.0"));
  assert.ok(pickerSlots[0]?.options[0]?.imagePath?.startsWith("Assets/"));
  assert.equal(manifest.assets.every((asset) => asset.status === "needed"), true);
});

test("registry selection plan does not silently default unverified candidates", async () => {
  const { registry, profile, manifest } = await fixture();
  const unverifiedPlayerRegistry = {
    ...registry,
    entries: registry.entries.map((entry) => entry.primitive === "player"
      ? { ...entry, source: { ...entry.source, verified: false } }
      : entry),
  };

  const plan = buildRegistrySelectionPlan(manifest, unverifiedPlayerRegistry, profile, { preferredLicense: "CC0-1.0" });
  const player = plan.slots.find((slot) => slot.assetId === "player_character");

  assert.ok(player);
  assert.equal(player.selectedId, null);
  assert.ok(player.candidates.length > 0);
  assert.ok(player.candidates.every((candidate) => candidate.policyStatus === "unverified-discovery"));

  const pickerSlots = buildAssetPickerSlotsFromRegistrySelectionPlan(plan);
  const playerPicker = pickerSlots.find((slot) => slot.slot === "player_character");
  assert.ok(playerPicker);
  assert.equal(playerPicker.selectedId, undefined);
  assert.ok(playerPicker.options[0]?.badges.includes("NEEDS REVIEW"));
});

test("registry selection plan treats review.status as authoritative over source.verified", async () => {
  const { registry, profile, manifest } = await fixture();
  const playerEntry = registry.entries.find((entry) => entry.primitive === "player")!;
  const reviewPendingRegistry = {
    ...registry,
    entries: [{
      ...playerEntry,
      source: { ...playerEntry.source, verified: true },
      review: { status: "needs-review" as const, notes: "Legacy source.verified must not auto-select." },
      trustTier: "unverified-discovery" as const,
      policyStatus: "unverified-discovery" as const,
    }],
  };

  const plan = buildRegistrySelectionPlan(manifest, reviewPendingRegistry, profile, { preferredLicense: "CC0-1.0" });
  const player = plan.slots.find((slot) => slot.assetId === "player_character");

  assert.ok(player);
  assert.equal(player.selectedId, null);
  assert.equal(player.candidates[0]?.reviewStatus, "needs-review");
  assert.equal(player.candidates[0]?.policyStatus, "unverified-discovery");
});

test("applying approved registry selections records license source and provenance in the manifest", async () => {
  const { registry, profile, manifest } = await fixture();
  const plan = buildRegistrySelectionPlan(manifest, registry, profile, { preferredLicense: "CC0-1.0" });
  const selections = Object.fromEntries(plan.slots.map((slot) => [slot.assetId, slot.selectedId ?? slot.candidates[0]!.id]));

  const approved = applyRegistrySelectionsToManifest({
    manifest,
    registry,
    profile,
    selections,
    approvedAt: "2026-06-05T00:00:00.000Z",
    preferredLicense: "CC0-1.0",
  });

  const validation = validateAssetManifest(approved);
  assert.equal(validation.valid, true, JSON.stringify(validation.issues, null, 2));
  assert.equal(approved.status, "approved");
  assert.equal(approved.assetSources.find((source) => source.kind === "registry-pack")?.approved, true);
  assert.equal(approved.assetSources.find((source) => source.kind === "registry-pack")?.license, "CC0-1.0");

  const player = approved.assets.find((asset) => asset.id === "player_character");
  assert.equal(player?.status, "approved");
  assert.equal(player?.source, "registry");
  assert.equal(player?.registrySelection?.registryAssetId, "kenney.pixel-platformer.player.sheet");
  assert.equal(player?.registrySelection?.license.spdx, "CC0-1.0");
  assert.ok(player?.registrySelection?.source.title);
  assert.ok(player?.registrySelection?.source.provenance.verifiedAt);
  assert.deepEqual(player?.resolvedPaths, ["Assets/Art/Sprites/Characters/kenney-pixel-platformer-characters.png"]);
});

test("applying registry selections to a hybrid manifest keeps it draft until generated roles are resolved", async () => {
  const registry = await loadRegistryPack(path.join(repoRoot, "asset-layer/registry/platformer-2d.json"));
  const profile = await loadAssetProfile(path.join(repoRoot, "asset-layer/profiles/2d-platformer.json"));
  const manifest = createDraftAssetManifest({
    mode: "hybrid",
    heroShot: {
      path: ".loombridge/design/hero-shot.png",
      sha256: HASH,
    },
    registry: registry.packId,
  });
  const plan = buildRegistrySelectionPlan(manifest, registry, profile);
  const selections = Object.fromEntries(plan.slots.map((slot) => [slot.assetId, slot.selectedId ?? slot.candidates[0]!.id]));

  const partiallyResolved = applyRegistrySelectionsToManifest({
    manifest,
    registry,
    profile,
    selections,
    approvedAt: "2026-06-05T00:00:00.000Z",
  });

  const validation = validateAssetManifest(partiallyResolved);
  assert.equal(validation.valid, true, JSON.stringify(validation.issues, null, 2));
  assert.equal(partiallyResolved.status, "draft");
  assert.equal(partiallyResolved.approvedAt, null);
  assert.ok(partiallyResolved.assets.some((asset) => asset.source === "generated" && asset.status === "needed"));
  assert.ok(partiallyResolved.assets.some((asset) => asset.source === "registry" && asset.status === "approved"));
});

test("applying registry selections rejects unknown or missing choices", async () => {
  const { registry, profile, manifest } = await fixture();
  const plan = buildRegistrySelectionPlan(manifest, registry, profile);
  const selections = Object.fromEntries(plan.slots.map((slot) => [slot.assetId, slot.candidates[0]!.id]));

  assert.throws(
    () => applyRegistrySelectionsToManifest({
      manifest,
      registry,
      profile,
      selections: { ...selections, player_character: "not.in.presented.candidates" },
      approvedAt: "2026-06-05T00:00:00.000Z",
    }),
    /Unknown registry selection 'not\.in\.presented\.candidates'/,
  );

  const missingPlayer = { ...selections };
  delete missingPlayer.player_character;
  assert.throws(
    () => applyRegistrySelectionsToManifest({
      manifest,
      registry,
      profile,
      selections: missingPlayer,
      approvedAt: "2026-06-05T00:00:00.000Z",
    }),
    /Missing registry selection for asset 'player_character'/,
  );
});

test("approved registry manifest exposes deterministic hero shot inputs", async () => {
  const { registry, profile, manifest } = await fixture();
  const plan = buildRegistrySelectionPlan(manifest, registry, profile);
  const selections = Object.fromEntries(plan.slots.map((slot) => [slot.assetId, slot.candidates[0]!.id]));
  const approved = applyRegistrySelectionsToManifest({
    manifest,
    registry,
    profile,
    selections,
    approvedAt: "2026-06-05T00:00:00.000Z",
  });

  const inputs = buildRegistryHeroShotInputs(approved);

  assert.equal(inputs.length, approved.assets.length);
  assert.deepEqual(
    inputs.map((input) => input.role),
    approved.assets.map((asset) => asset.role),
  );
  assert.ok(inputs.every((input) => input.path.startsWith("Assets/")));
  assert.ok(inputs.every((input) => input.license === "CC0-1.0"));
  assert.ok(inputs.every((input) => input.provenance.verifiedAt));
});
