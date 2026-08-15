import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createDraftAssetManifest,
  manifestGenreProfile,
  readAssetManifest,
  readPromotedAssetProfile,
  validateAssetManifest,
  writeAssetManifest,
  type AssetManifest,
} from "../../../../capabilities/assets/asset-manifest.js";
import { contractAssetGenreProfile } from "../../../../capabilities/assets/asset-genre-profile.js";
import { buildGeneratedAssetPlan } from "../../../../capabilities/assets/generated-assets.js";
import { promoteGenreContract } from "../../../../capabilities/genre/genre-contract/promote.js";
import { validateGenreContract } from "../../../../capabilities/genre/genre-contract/validator.js";
import type { GenreContract } from "../../../../capabilities/genre/genre-contract/types.js";
import { loombridgePaths } from "../../../../domain/state.js";

const HASH = "b".repeat(64);
const GENRE = "pen-fight-duel";
const ROLES = ["player-pen", "rival-pen", "desk"];

function contractFixture(): GenreContract {
  return {
    schemaVersion: "0.1.0",
    genreId: GENRE,
    confidence: "experimental",
    targetPlatform: { device: "mobile", inputScheme: "touch" },
    networkModel: { mode: "single-player", spPlayable: true },
    coreLoop: { description: "flick a pen to knock the rival pen off a desk", genreClass: "hybrid" },
    artDirection: { style: "classroom", assetRoles: [...ROLES] },
    verticalSliceBudget: { coreVerticalContent: { "core-mechanic": 1 }, deferred: ["roster"] },
    feedbackChains: [
      { verb: "aim", input: "drag", response: "aim line", feedback: "power meter" },
      { verb: "flick", input: "release", response: "impulse", feedback: "clack sfx" },
    ],
    tunables: [{ id: "inputToSfxLatency", unit: "ms", description: "release to sound" }],
    measurabilityMap: [
      { target: "inputToSfxLatency", tag: "measurable-now", calculator: "inputToSfxLatency", bucket: "coreVertical" },
      { target: "flick-feel", tag: "judgment-only", bucket: "coreVertical" },
    ],
    referenceAnchor: { notes: "fixture" },
    sliceDag: {
      coreVertical: [
        {
          id: "scene",
          title: "Desk scene",
          dependsOn: [],
          confidence: "experimental",
          gates: ["manifest", "console-clean"],
          assets: ["desk"],
        },
        {
          id: "core-mechanic",
          title: "Flick loop",
          dependsOn: ["scene"],
          confidence: "experimental",
          gates: ["manifest", "console-clean"],
          gaps: ["core-mechanic-measurement"],
          assets: ["player-pen", "rival-pen"],
        },
      ],
      deferredMeta: [
        { id: "roster", title: "More pens", dependsOn: [], confidence: "experimental", kind: "roster", gaps: ["deferred-meta"] },
      ],
    },
    refusalConditions: [
      { condition: "judgment-only targets: flick-feel", reason: "bound to a humanOracleCheck" },
    ],
    humanOracleChecks: [{ check: "does the flick feel fair?", appliesTo: "flick-feel" }],
    fidelityCriteria: ["composition-match"],
  };
}

function contractDraft(): AssetManifest {
  return createDraftAssetManifest({
    mode: "generated",
    heroShot: { path: ".loombridge/design/hero-shot.png", sha256: HASH },
    genre: GENRE,
    contractProfile: {
      id: GENRE,
      requiredRoles: [...ROLES],
      sliceBindings: [{ sliceId: "scene", assetIds: ["desk"] }],
    },
  });
}

test("contract validator: slice assets must reference declared artDirection.assetRoles", () => {
  const good = validateGenreContract(contractFixture());
  assert.equal(good.valid, true, JSON.stringify(good.issues, null, 2));

  const bad = contractFixture();
  bad.sliceDag.coreVertical[0]!.assets = ["not-a-role"];
  const result = validateGenreContract(bad);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) => issue.code === "SLICE_ASSET_UNKNOWN"));
});

test("promoteGenreContract: derives assetProfile with slice bindings; omits it without assetRoles", () => {
  const { report } = promoteGenreContract(contractFixture());
  assert.deepEqual(report.assetProfile, {
    id: GENRE,
    requiredRoles: ROLES,
    sliceBindings: [
      { sliceId: "scene", assetIds: ["desk"] },
      { sliceId: "core-mechanic", assetIds: ["player_pen", "rival_pen"] },
    ],
  });

  const bare = contractFixture();
  delete bare.artDirection.assetRoles;
  bare.sliceDag.coreVertical.forEach((slice) => delete slice.assets);
  const { report: bareReport } = promoteGenreContract(bare);
  // LITMUS: absent stays absent, never an empty profile.
  assert.equal("assetProfile" in bareReport, false);
});

test("createDraftAssetManifest: contract genre drafts generated roles and persists contractRoles", () => {
  const draft = contractDraft();
  assert.equal(draft.genre, GENRE);
  assert.deepEqual(draft.contractRoles, ROLES);
  assert.deepEqual(draft.assets.map((asset) => asset.role), ROLES);
  assert.ok(draft.assets.every((asset) => asset.source === "generated"));
  assert.deepEqual(draft.sliceBindings, [{ sliceId: "scene", assetIds: ["desk"] }]);
});

test("createDraftAssetManifest: contract genre refuses registry and hybrid modes by name", () => {
  for (const mode of ["registry", "hybrid"] as const) {
    assert.throws(
      () =>
        createDraftAssetManifest({
          mode,
          heroShot: { path: ".loombridge/design/hero-shot.png", sha256: HASH },
          genre: GENRE,
          contractProfile: { id: GENRE, requiredRoles: [...ROLES] },
        }),
      /generated only/,
    );
  }
});

test("createDraftAssetManifest: refuses a contractProfile whose id disagrees with the genre", () => {
  assert.throws(
    () =>
      createDraftAssetManifest({
        mode: "generated",
        heroShot: { path: ".loombridge/design/hero-shot.png", sha256: HASH },
        genre: GENRE,
        contractProfile: { id: "some-other-genre", requiredRoles: [...ROLES] },
      }),
    /does not match genre/,
  );
});

test("validateAssetManifest: contract genre needs contractRoles; contractRoles need a contract genre", () => {
  const draft = contractDraft();
  assert.equal(validateAssetManifest(draft).valid, true);

  // LITMUS: dropping contractRoles must refuse, never fall back to another profile.
  const { contractRoles: _dropped, ...withoutRoles } = draft;
  const missing = validateAssetManifest(withoutRoles);
  assert.equal(missing.valid, false);
  assert.ok(missing.issues.some((issue) => issue.code === "UNKNOWN_GENRE"));

  // A registered genre can never be shadowed by self-declared roles.
  const shadowing = validateAssetManifest({ ...draft, genre: "3d-shooter" });
  assert.equal(shadowing.valid, false);
  assert.ok(shadowing.issues.some((issue) => issue.code === "INVALID_FIELD" && issue.path === "contractRoles"));

  // Roles without a genre id have no promotion to bind to.
  const { genre: _genre, ...noGenre } = draft;
  const detached = validateAssetManifest(noGenre);
  assert.equal(detached.valid, false);
  assert.ok(detached.issues.some((issue) => issue.code === "INVALID_FIELD" && issue.path === "contractRoles"));

  const duplicated = validateAssetManifest({ ...draft, contractRoles: ["desk", "desk", "player-pen", "rival-pen"] });
  assert.equal(duplicated.valid, false);
  assert.ok(duplicated.issues.some((issue) => issue.code === "INVALID_FIELD" && issue.path === "contractRoles"));
});

test("manifestGenreProfile + buildGeneratedAssetPlan resolve roles from the manifest's contractRoles", () => {
  const draft = contractDraft();
  const profile = manifestGenreProfile(draft);
  assert.equal(profile.id, GENRE);
  assert.deepEqual([...profile.requiredRoles], ROLES);
  assert.deepEqual(profile.roleSelectionRules, {});

  const plan = buildGeneratedAssetPlan(draft, [
    { annotationId: "a1", role: "player-pen" },
    { annotationId: "a2", role: "rival-pen" },
    { annotationId: "a3", role: "desk" },
  ]);
  // Contract roles are known to the annotation validator; an undeclared one is refused.
  assert.deepEqual(plan.issues, []);
  const badPlan = buildGeneratedAssetPlan(draft, [
    { annotationId: "a1", role: "weapon-model" },
  ]);
  assert.ok(badPlan.issues.some((issue) => issue.code === "UNKNOWN_ROLE"));
});

test("readAssetManifest: binds contractRoles to the promoted assetProfile on disk", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "loombridge-contract-manifest-"));
  try {
    const paths = loombridgePaths(root);
    await fs.mkdir(paths.dir, { recursive: true });
    const draft = contractDraft();

    // No GENRE_PROMOTION.json at all: refuse, never skip.
    await fs.writeFile(paths.assetManifest, `${JSON.stringify(draft, null, 2)}\n`, "utf-8");
    await assert.rejects(() => readAssetManifest(paths), /declares no promoted assetProfile/);

    // Promotion present but roles drifted: refuse.
    const { report } = promoteGenreContract(contractFixture());
    const drifted = {
      ...report,
      assetProfile: { ...report.assetProfile!, requiredRoles: ["player-pen", "rival-pen"] },
    };
    await fs.writeFile(paths.genrePromotion, `${JSON.stringify(drifted, null, 2)}\n`, "utf-8");
    await assert.rejects(() => readAssetManifest(paths), /do not match the promoted assetProfile/);

    // Matching promotion: reads clean, and writeAssetManifest round-trips.
    await fs.writeFile(paths.genrePromotion, `${JSON.stringify(report, null, 2)}\n`, "utf-8");
    const read = await readAssetManifest(paths);
    assert.ok(read);
    assert.deepEqual(read.contractRoles, ROLES);
    await writeAssetManifest(paths, read);

    const promoted = await readPromotedAssetProfile(paths);
    assert.deepEqual(promoted, report.assetProfile);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("contractAssetGenreProfile: hybrid roles cover every role and selection rules stay empty", () => {
  const profile = contractAssetGenreProfile(GENRE, ROLES, [{ sliceId: "scene", assetIds: ["desk"] }]);
  assert.deepEqual([...profile.hybridGeneratedRoles].sort(), [...ROLES].sort());
  assert.deepEqual(profile.defaultSliceBindings, [{ sliceId: "scene", assetIds: ["desk"] }]);
});
