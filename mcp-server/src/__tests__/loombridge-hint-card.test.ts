import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  validateHintCard,
  assertValidHintCard,
  type GenrePackManifest,
  type GenreHintCard,
} from "../loombridge/genre-contract/hint-card.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(__dirname, "..", ".."); // dist/__tests__ -> mcp-server
const PACK_ROOT = path.join(PKG_ROOT, "src", "loombridge", "genre-contract", "genre-packs");

function readJson(genreId: string, file: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(PACK_ROOT, genreId, file), "utf8"));
}

function readPack(genreId: string): { manifest: unknown; hintCard: GenreHintCard } {
  return {
    manifest: readJson(genreId, "pack.json"),
    hintCard: readJson(genreId, "hint-card.json") as GenreHintCard,
  };
}

/** A minimal valid manifest used as the base for mutation-based negative tests. */
function validManifest(): GenrePackManifest {
  return {
    genreId: "2d-shooter",
    subGenres: ["top-down", "twin-stick"],
    genreClass: "twitch",
    slots: ["hint-card"],
  };
}

/** A minimal valid hint-card used as the base for mutation-based negative tests. */
function validCard(): GenreHintCard {
  return {
    genreId: "2d-shooter",
    genreClass: "twitch",
    subGenres: ["top-down", "twin-stick"],
    perspectives: ["top-down", "twin-stick"],
    canonicalTunables: [{ id: "fireIntervalMs", unit: "ms" }],
    assetRoles: ["player-character", "weapon", "enemy", "arena-floor", "hit-vfx"],
    coreHooks: [
      {
        id: "minimal-upgrade-choice",
        triggerTerms: ["upgrade choice"],
        coreContentKind: "upgradeChoice",
        coreSliceTitle: "Minimal upgrade choice",
        deferredRemainder: ["upgrade-tree"],
      },
    ],
    defaultBands: [
      {
        target: "inputToSfxLatency",
        band: { max: 50, unit: "ms" },
        evidenceKind: "pack-default",
        measurabilityTag: "measurable-now",
        calculator: "inputToSfxLatency",
      },
    ],
    exemplars: ["Enter the Gungeon"],
  };
}

function codes(input: unknown): string[] {
  return validateHintCard(input).issues.map((i) => i.code);
}

/* ------------------------------------------------------------------ positive — the shipped pack */

test("all shipped genre packs are valid JSON and pass validateHintCard", () => {
  const genreIds = fs
    .readdirSync(PACK_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(genreIds, ["2d-shooter", "3d-shooter", "hybrid-rungun", "systems-rts"]);

  for (const genreId of genreIds) {
    const { manifest, hintCard } = readPack(genreId);
    const res = validateHintCard({ manifest, hintCard });
    assert.deepEqual(res.issues, [], `${genreId} issues: ${JSON.stringify(res.issues)}`);
    assert.equal(res.valid, true);
  }
});

test("the shipped 2d-shooter hint-card seeds twitch defaults honestly", () => {
  const { hintCard: card } = readPack("2d-shooter");
  assert.equal(card.genreClass, "twitch");
  assert.ok(card.assetRoles?.includes("reticle"));
  assert.ok(card.assetRoles?.includes("hit-vfx"));
  assert.ok(card.assetRoles?.includes("wave-score-hud"));
  const measurableNow = card.defaultBands.filter((b) => b.measurabilityTag === "measurable-now");
  assert.deepEqual(
    measurableNow.map((b) => b.target),
    ["inputToSfxLatency", "fireIntervalMs", "fireInputToSpawnLatency", "ttkMs", "projectileSpeed"],
    "inputToSfxLatency, fireIntervalMs, fireInputToSpawnLatency, ttkMs, and projectileSpeed should be measurable-now today",
  );
  assert.equal(card.defaultBands.find((b) => b.target === "fireIntervalMs")?.calculator, "fireIntervalMs");
  assert.equal(card.defaultBands.find((b) => b.target === "fireInputToSpawnLatency")?.calculator, "fireInputToSpawnLatency");
  assert.equal(card.defaultBands.find((b) => b.target === "ttkMs")?.calculator, "ttkMs");
  assert.equal(card.defaultBands.find((b) => b.target === "projectileSpeed")?.calculator, "projectileSpeed");
  // hit-stop and screen-shake must still be honestly tagged needs-new-calculator (no calculator yet)
  for (const target of ["screenShakeMag", "hitstopMs"]) {
    const row = card.defaultBands.find((b) => b.target === target);
    assert.ok(row, `expected a default band for ${target}`);
    assert.equal(row!.measurabilityTag, "needs-new-calculator");
  }
});

test("the shipped 3d-shooter hint-card claims only honest measurable-now metrics and keeps 3D specifics as gaps", () => {
  const { manifest, hintCard: card } = readPack("3d-shooter");
  assert.deepEqual(validateHintCard({ manifest, hintCard: card }).issues, []);
  assert.equal(card.genreClass, "twitch");
  assert.ok(card.perspectives.includes("first-person"));
  assert.ok(card.assetRoles?.includes("reticle"));
  assert.ok(card.assetRoles?.includes("arena-backstop"));

  // Core-loop counters plus every live-proven 3D metric (substrates + the productization phases:
  // 3C controller/camera, hitscan, AI reaction, impact feedback) are measurable-now. Recoil and ADS stay gaps.
  const measurableNow = card.defaultBands.filter((b) => b.measurabilityTag === "measurable-now");
  assert.deepEqual(
    measurableNow.map((b) => b.target),
    [
      "fireIntervalMs",
      "fireInputToSpawnLatency",
      "ttkMs",
      "projectileSpeed",
      "aimTurnRateDegPerSec",
      "lookInputToYawLatencyMs",
      "shotAimAlignmentDeg",
      "hitscanImpactLatencyMs",
      "enemyReactionLatencyMs",
      "screenShakeMag",
      "hitstopMs",
    ],
    "only proven 3D shooter metrics are measurable-now for the 3D seed",
  );
  // Every measurable-now band binds its implemented calculator id (== the target id here; also
  // checked structurally by validateHintCard against IMPLEMENTED_CALCULATOR_IDS).
  for (const b of measurableNow) {
    assert.equal(b.calculator, b.target, `${b.target} must bind its implemented calculator`);
  }

  const byTarget = new Map(card.defaultBands.map((b) => [b.target, b]));
  // ADS still needs new bridge/semantic bindings.
  for (const target of ["adsTransitionMs"]) {
    assert.equal(byTarget.get(target)?.measurabilityTag, "needs-new-bridge-capability", `${target} must stay a bridge gap`);
  }
  // Recoil still needs a kick-then-recover pulse calculator (NOT ported blind).
  assert.equal(byTarget.get("recoilKickDeg")?.measurabilityTag, "needs-new-calculator", "recoil must stay a calculator gap");
  assert.equal(byTarget.get("aiming-feel")?.measurabilityTag, "judgment-only");
});

test("the shipped hybrid-rungun hint-card carries platforming measurable-now plus shooting gaps", () => {
  const { hintCard: card } = readPack("hybrid-rungun");
  assert.equal(card.genreClass, "hybrid");
  assert.ok(card.assetRoles?.includes("parallax-backdrop"));
  assert.ok(card.assetRoles?.includes("current-weapon-hud"));
  assert.ok(card.assetRoles?.includes("upgrade-choice-ui"));
  assert.ok(card.assetRoles?.includes("combat-sfx"));
  const hook = card.coreHooks?.find((h) => h.id === "minimal-between-level-weapon-upgrade");
  assert.ok(hook, "hybrid pack should preserve a minimal core representative for the brief-defining upgrade hook");
  assert.equal(hook!.coreContentKind, "upgradeChoice");
  assert.ok(hook!.triggerTerms.some((term) => term.includes("upgrade")));
  assert.ok(hook!.deferredRemainder.includes("weapon-upgrade-tree"));
  assert.ok(!["progression", "unlocks", "economy", "shop"].includes(hook!.coreContentKind));

  const byTarget = new Map(card.defaultBands.map((b) => [b.target, b]));
  for (const target of ["runSpeed", "runAcceleration", "runDeceleration", "jumpApex", "timeToApex", "inputLatency"]) {
    assert.equal(byTarget.get(target)?.measurabilityTag, "measurable-now", `${target} should use an implemented calculator`);
  }
  assert.equal(byTarget.get("fireIntervalMs")?.measurabilityTag, "measurable-now");
  assert.equal(byTarget.get("fireIntervalMs")?.calculator, "fireIntervalMs");
  assert.equal(byTarget.get("projectileSpeed")?.measurabilityTag, "measurable-now");
  assert.equal(byTarget.get("projectileSpeed")?.calculator, "projectileSpeed");
  assert.equal(byTarget.get("fireInputToSpawnLatency")?.measurabilityTag, "measurable-now");
  assert.equal(byTarget.get("fireInputToSpawnLatency")?.calculator, "fireInputToSpawnLatency");
  for (const target of ["hitstopMs", "screenShakeMag"]) {
    assert.equal(byTarget.get(target)?.measurabilityTag, "needs-new-calculator", `${target} must stay honest`);
  }
  assert.equal(byTarget.get("knockbackImpulse")?.measurabilityTag, "needs-new-bridge-capability");
  assert.equal(byTarget.get("upgrade-choice-meaningfulness")?.measurabilityTag, "judgment-only");
  assert.equal(byTarget.get("minimal-upgrade-choice-presence")?.measurabilityTag, "judgment-only");
});

test("the shipped systems-rts hint-card carries rich role defaults without false measurable-now claims", () => {
  const { hintCard: card } = readPack("systems-rts");
  assert.equal(card.genreClass, "systems");
  assert.ok(card.assetRoles?.includes("selection-marker"));
  assert.ok(card.assetRoles?.includes("build-footprint-invalid"));
  assert.ok(card.assetRoles?.includes("resource-hud"));

  const measurableNow = card.defaultBands.filter((b) => b.measurabilityTag === "measurable-now");
  assert.deepEqual(measurableNow, [], "RTS pack must not claim implemented calculators yet");
  for (const target of ["commandAckLatencyMs", "selectionFeedbackLatencyMs", "unitMoveSpeed", "engagementTtkSeconds"]) {
    const row = card.defaultBands.find((b) => b.target === target);
    assert.ok(row, `expected a default band for ${target}`);
    assert.equal(row!.measurabilityTag, "needs-new-calculator");
    assert.equal(row!.evidenceKind, "pack-default");
  }
  for (const target of ["macro-economy-tension", "battlefield-legibility", "ai-opponent-believability"]) {
    assert.equal(card.defaultBands.find((b) => b.target === target)?.measurabilityTag, "judgment-only");
  }
});

test("the minimal valid base manifest + card validate", () => {
  assert.deepEqual(validateHintCard({ manifest: validManifest(), hintCard: validCard() }).issues, []);
  assert.deepEqual(validateHintCard(validCard()).issues, []); // bare card form
});

test("assertValidHintCard throws on an invalid card", () => {
  assert.doesNotThrow(() => assertValidHintCard({ manifest: validManifest(), hintCard: validCard() }));
  assert.throws(() => assertValidHintCard({ hintCard: { genreId: "x" } }), /invalid genre hint-card/);
});

/* ------------------------------------------------------------------ refusals */

test("an unknown genreClass is refused (manifest + card)", () => {
  const m = validManifest() as unknown as Record<string, unknown>;
  m.genreClass = "puzzle";
  assert.ok(codes({ manifest: m }).includes("MANIFEST_GENRE_CLASS"));

  const c = validCard() as unknown as Record<string, unknown>;
  c.genreClass = "puzzle";
  assert.ok(codes({ hintCard: c }).includes("CARD_GENRE_CLASS"));
});

test("a default band whose unit is not a supported unit is refused", () => {
  const c = validCard();
  c.defaultBands[0].band = { max: 50, unit: "deg" }; // deg is not a supported profile unit
  assert.ok(codes({ hintCard: c }).includes("CARD_BAND_UNIT"));
});

test("a canonical tunable with an unsupported unit is refused", () => {
  const c = validCard();
  c.canonicalTunables = [{ id: "recoilKickDeg", unit: "deg" }];
  assert.ok(codes({ hintCard: c }).includes("CARD_TUNABLE_UNIT"));
});

test("assetRoles, when present, must be a non-empty string array", () => {
  const c = validCard() as unknown as Record<string, unknown>;
  c.assetRoles = ["player", ""];
  assert.ok(codes({ hintCard: c }).includes("CARD_ASSET_ROLES"));
});

test("coreHooks, when present, must use a non-meta core content kind", () => {
  const c = validCard();
  c.coreHooks![0].coreContentKind = "progression";
  assert.ok(codes({ hintCard: c }).includes("CARD_CORE_HOOK_META_KIND"));
});

test("a measurabilityTag outside the closed set is refused", () => {
  const c = validCard() as unknown as { defaultBands: Array<Record<string, unknown>> };
  c.defaultBands[0].measurabilityTag = "kinda-measurable";
  assert.ok(codes({ hintCard: c }).includes("CARD_BAND_TAG"));
});

test("an evidenceKind outside the closed set is refused", () => {
  const c = validCard() as unknown as { defaultBands: Array<Record<string, unknown>> };
  c.defaultBands[0].evidenceKind = "vibes";
  assert.ok(codes({ hintCard: c }).includes("CARD_BAND_EVIDENCE"));
});

test("a measurable-now default bound to an UNIMPLEMENTED calculator is refused (no false-green)", () => {
  const c = validCard();
  // hitStopMs is in the banded vocabulary but has no implemented calculator
  c.defaultBands[0] = {
    target: "hitstop",
    band: { max: 90, unit: "ms" },
    evidenceKind: "pack-default",
    measurabilityTag: "measurable-now",
    calculator: "hitStopMs",
  };
  assert.ok(codes({ hintCard: c }).includes("CARD_MEASURABLE_NOW_UNIMPLEMENTED"));
});

test("a measurable-now default with no calculator is refused", () => {
  const c = validCard();
  delete (c.defaultBands[0] as Partial<GenreHintCard["defaultBands"][number]>).calculator;
  assert.ok(codes({ hintCard: c }).includes("CARD_MEASURABLE_NOW_NO_CALC"));
});

test("a missing required manifest field is refused (genreId / subGenres / slots)", () => {
  const noId = validManifest() as unknown as Record<string, unknown>;
  delete noId.genreId;
  assert.ok(codes({ manifest: noId }).includes("MANIFEST_GENRE_ID"));

  const noSub = validManifest() as unknown as Record<string, unknown>;
  delete noSub.subGenres;
  assert.ok(codes({ manifest: noSub }).includes("MANIFEST_SUBGENRES"));

  const noSlots = validManifest() as unknown as Record<string, unknown>;
  delete noSlots.slots;
  assert.ok(codes({ manifest: noSlots }).includes("MANIFEST_SLOTS"));
});

test("an empty band is refused", () => {
  const c = validCard();
  c.defaultBands[0].band = {};
  assert.ok(codes({ hintCard: c }).includes("CARD_BAND_EMPTY"));
});

test("an inverted numeric band is refused", () => {
  const c = validCard();
  c.defaultBands[0].band = { min: 140, max: 90, unit: "ms" };
  assert.ok(codes({ hintCard: c }).includes("CARD_BAND_RANGE"));
});

test("a bare empty object is treated as a hint-card and refused for its missing fields", () => {
  const got = codes({});
  assert.ok(got.includes("CARD_GENRE_ID"));
  assert.ok(got.includes("CARD_DEFAULT_BANDS"));
});

test("a pair with neither manifest nor hintCard is refused (EMPTY_INPUT)", () => {
  assert.ok(codes({ manifest: undefined, hintCard: undefined }).includes("EMPTY_INPUT"));
});
