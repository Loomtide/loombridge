/**
 * The shared DRAFT detection (`minigame-draft`) — the ONE rule the finalize-vs-verify routing,
 * capture's reorder guard, and finalize's strip all now share. Pure; exhaustively unit-tested.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { isDraftContract, isDraftDescription } from "../../../../capabilities/minigame/minigame-draft.js";

test("isDraftDescription: matches the scan `DRAFT:` and scaffold `TODO:` PREFIXES (case-insensitive), nothing else", () => {
  assert.equal(isDraftDescription("DRAFT: live-scanned screen roster."), true);
  assert.equal(isDraftDescription("TODO: the button that starts a round."), true);
  assert.equal(isDraftDescription("  draft: leading whitespace tolerated"), true);
  assert.equal(isDraftDescription("Todo: mixed case"), true);
  // NOT a placeholder: real finalize/scan descriptions, or the token appearing elsewhere.
  assert.equal(isDraftDescription("active screen."), false);
  assert.equal(isDraftDescription("Discovered tappable control (MusicButton)."), false);
  assert.equal(isDraftDescription("Finalized 2D kids mini-game verification contract."), false);
  assert.equal(isDraftDescription("drafting the next level"), false, "must be the prefix + : or space, not 'drafting'");
  assert.equal(isDraftDescription("a TODO: noted mid-sentence"), false, "anchored at the START only");
  assert.equal(isDraftDescription(undefined), false);
  assert.equal(isDraftDescription(123 as unknown), false, "a non-string is never a draft");
});

test("isDraftContract: a draft TOP-LEVEL description ⇒ draft", () => {
  assert.equal(isDraftContract({ description: "DRAFT: generated from a live scene scan." }), true);
});

test("isDraftContract: a clean top-level but a draft STATE description ⇒ draft (the multi-scene case that skipped finalize)", () => {
  // A fused multi-scene contract's top-level can read finalized while a per-scene SCAN state is DRAFT:.
  const c = {
    description: "Finalized contract.",
    states: [
      { id: "star-chef__mix", description: "DRAFT: discovered MixPanel screen." },
      { id: "game-hub__active", description: "active screen." },
    ],
  };
  assert.equal(isDraftContract(c), true);
});

test("isDraftContract: a draft requiredInFrame / allowedOffscreen object description ⇒ draft", () => {
  assert.equal(isDraftContract({ requiredInFrame: [{ id: "x", description: "DRAFT: control used during the demonstration." }] }), true);
  assert.equal(isDraftContract({ allowedOffscreen: [{ id: "y", description: "TODO: off-screen spawn." }] }), true);
});

test("isDraftContract: a fully finalized contract (no placeholder descriptions anywhere) ⇒ NOT draft", () => {
  const finalized = {
    description: "Finalized 2D kids mini-game verification contract (locators inferred from captures).",
    states: [
      { id: "active", description: "active screen." },
      { id: "success_reward", description: "success_reward screen." },
    ],
    requiredInFrame: [{ id: "ingredientSugar", description: "Inferred from capture (/Canvas/MixPanel/Ingredient_sugar)." }],
  };
  assert.equal(isDraftContract(finalized), false);
});

test("isDraftContract: tolerates a loosely-typed / malformed JSON object without throwing", () => {
  assert.equal(isDraftContract({}), false);
  assert.equal(isDraftContract({ states: "not-an-array" as unknown }), false);
  assert.equal(isDraftContract({ states: [null, 5, { description: "DRAFT: x" }] as unknown }), true);
  assert.equal(isDraftContract(JSON.parse('{"description":"DRAFT: from disk","states":[]}')), true);
});
