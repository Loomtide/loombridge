/**
 * Multi-scene contract fusion (Phase 1 D2-A/D/E). The correctness-critical part: namespacing every id by
 * scene AND rewriting every field that references an id, with a referential-integrity NET that refuses a
 * dangling reference (a missed rename) rather than silently mis-bind. Synthetic per-scene contracts.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  namespaceContract,
  mergeSceneContracts,
  validateContractReferentialIntegrity,
  type ScenePart,
} from "../../../../capabilities/minigame/minigame-scene-merge.js";
import type { MinigameContract } from "../../../../capabilities/minigame/profiles/types.js";

/** A minimal-but-valid contract with a `start`→`active` flow, one tap-target object, and an
 *  input-response binding — enough to exercise every id-reference field. */
function contract(over: Partial<MinigameContract> = {}): MinigameContract {
  return {
    schemaVersion: "1",
    id: "scene-game",
    type: "2d-kids-minigame",
    scenes: ["Assets/Scenes/Game.unity"],
    ageBand: "5-7",
    visualProfile: "phone-portrait",
    states: [
      { id: "start", kind: "start", requiredInFrame: ["playButton"] },
      {
        id: "active",
        kind: "active",
        requiredInFrame: ["playButton"],
        inputResponse: { tap: "playButton", observe: ["scoreLabel"] },
      },
    ],
    requiredInFrame: [
      { id: "playButton", locator: "Game:/Canvas/Play" },
      { id: "scoreLabel", locator: "Game:/Canvas/Score" },
    ],
    uiSafeAreas: { maxOverflowFraction: 0 },
    tapTargets: { minSizeDp: 44 },
    interactionFlow: { happyPath: ["start", "active"] },
    artifactThresholds: {},
    checks: { deterministic: ["required-in-frame"] },
    ...over,
  };
}

test("namespaceContract: rewrites the id AND every reference to it (state + object ids), stamps scene", () => {
  const ns = namespaceContract({ prefix: "star-chef", sceneName: "StarChef", contract: contract({ scenes: ["Assets/Scenes/StarChef.unity"] }) });

  // State ids namespaced + scene stamped.
  assert.deepEqual(ns.states.map((s) => s.id), ["star-chef__start", "star-chef__active"]);
  assert.ok(ns.states.every((s) => s.scene === "StarChef"));
  // Object ids namespaced in the declaration list.
  assert.deepEqual(ns.requiredInFrame.map((o) => o.id), ["star-chef__playButton", "star-chef__scoreLabel"]);
  // EVERY reference rewritten in lockstep:
  assert.deepEqual(ns.states[0].requiredInFrame, ["star-chef__playButton"]);
  assert.equal(ns.states[1].inputResponse!.tap, "star-chef__playButton");
  assert.deepEqual(ns.states[1].inputResponse!.observe, ["star-chef__scoreLabel"]);
  assert.deepEqual(ns.interactionFlow.happyPath, ["star-chef__start", "star-chef__active"]);
  // Locators are NOT namespaced (already scene-qualified).
  assert.equal(ns.requiredInFrame[0].locator, "Game:/Canvas/Play");
  // Referentially sound after namespacing.
  assert.deepEqual(validateContractReferentialIntegrity(ns), []);
});

test("namespaceContract: rewrites container/baseline-mask/safeAreaExempt object refs; leaves a path in safeAreaExempt alone", () => {
  const ns = namespaceContract({
    prefix: "home",
    sceneName: "Home",
    contract: contract({
      scenes: ["Assets/Scenes/Home.unity"],
      containers: [{ background: "playButton", content: ["scoreLabel"] }],
      baseline: { ref: "baselines/home", masks: ["scoreLabel"] },
      safeAreaExempt: ["playButton", "/Canvas/Decoration"],
    }),
  });
  assert.equal(ns.containers![0].background, "home__playButton");
  assert.deepEqual(ns.containers![0].content, ["home__scoreLabel"]);
  assert.deepEqual(ns.baseline!.masks, ["home__scoreLabel"]);
  // The id is renamed; the scene PATH passes through untouched.
  assert.deepEqual(ns.safeAreaExempt, ["home__playButton", "/Canvas/Decoration"]);
  assert.deepEqual(validateContractReferentialIntegrity(ns), []);
});

test("namespaceContract: does not mutate the input contract", () => {
  const c = contract();
  namespaceContract({ prefix: "x", sceneName: "X", contract: c });
  assert.equal(c.states[0].id, "start", "input untouched");
  assert.equal(c.states[0].scene, undefined);
});

test("mergeSceneContracts: identically-named states across two scenes fuse WITHOUT collision", () => {
  const parts: ScenePart[] = [
    { prefix: "home", sceneName: "Home", contract: contract({ scenes: ["Assets/Scenes/Home.unity"] }) },
    { prefix: "star-chef", sceneName: "StarChef", contract: contract({ scenes: ["Assets/Scenes/StarChef.unity"] }) },
  ];
  const merged = mergeSceneContracts(parts, "game-hub");

  assert.equal(merged.id, "game-hub");
  assert.deepEqual(merged.scenes, ["Assets/Scenes/Home.unity", "Assets/Scenes/StarChef.unity"]);
  // Both scenes' `start`/`active` survive as distinct namespaced states.
  assert.deepEqual(merged.states.map((s) => s.id), [
    "home__start", "home__active", "star-chef__start", "star-chef__active",
  ]);
  // The happy path is the concatenated cross-scene flow.
  assert.deepEqual(merged.interactionFlow.happyPath, [
    "home__start", "home__active", "star-chef__start", "star-chef__active",
  ]);
  // Sound by construction — no dangling references.
  assert.deepEqual(validateContractReferentialIntegrity(merged), []);
});

test("mergeSceneContracts: a NON-terminal scene's placeholder outcome (empty requiredInFrame) is dropped; the terminal scene's real reward is kept", () => {
  // The hub (non-terminal) emits a scaffold success_reward with no bound objects — no real screen, so
  // capture leaves it unreached and finalize would refuse. Merge drops it; the terminal game's reward
  // (with bound objects) survives and stays enforced.
  const hub = contract({
    scenes: ["Assets/Scenes/Home.unity"],
    states: [
      { id: "active", kind: "active", requiredInFrame: ["playButton"] },
      { id: "success_reward", kind: "success_reward" }, // placeholder: no requiredInFrame
    ],
    interactionFlow: { happyPath: ["active", "success_reward"] },
  });
  const game = contract({
    scenes: ["Assets/Scenes/StarChef.unity"],
    states: [
      { id: "active", kind: "active", requiredInFrame: ["playButton"] },
      { id: "success_reward", kind: "success_reward", requiredInFrame: ["scoreLabel"] }, // real reward
    ],
    interactionFlow: { happyPath: ["active", "success_reward"] },
  });
  const merged = mergeSceneContracts(
    [
      { prefix: "home", sceneName: "Home", contract: hub },
      { prefix: "star-chef", sceneName: "StarChef", contract: game },
    ],
    "game-hub",
  );
  assert.deepEqual(merged.states.map((s) => s.id), ["home__active", "star-chef__active", "star-chef__success_reward"]);
  assert.deepEqual(merged.interactionFlow.happyPath, ["home__active", "star-chef__active", "star-chef__success_reward"]);
  assert.deepEqual(validateContractReferentialIntegrity(merged), []);
});

test("mergeSceneContracts: a SINGLE-scene merge keeps its placeholder outcome (it IS the terminal scene)", () => {
  const only = contract({
    states: [
      { id: "active", kind: "active", requiredInFrame: ["playButton"] },
      { id: "success_reward", kind: "success_reward" }, // placeholder, but this is the terminal scene
    ],
    interactionFlow: { happyPath: ["active", "success_reward"] },
  });
  const merged = mergeSceneContracts([{ prefix: "g", sceneName: "Game", contract: only }], "g");
  assert.deepEqual(merged.states.map((s) => s.id), ["g__active", "g__success_reward"]);
});

test("mergeSceneContracts: unions checks across scenes (a check any scene needs runs for all)", () => {
  const parts: ScenePart[] = [
    { prefix: "home", sceneName: "Home", contract: contract({ scenes: ["Assets/Scenes/Home.unity"], checks: { deterministic: ["required-in-frame"] } }) },
    { prefix: "star-chef", sceneName: "StarChef", contract: contract({ scenes: ["Assets/Scenes/StarChef.unity"], checks: { deterministic: ["required-in-frame", "safe-area"] } }) },
  ];
  const merged = mergeSceneContracts(parts, "g");
  assert.deepEqual(merged.checks.deterministic, ["required-in-frame", "safe-area"]);
});

test("validateContractReferentialIntegrity: a DANGLING reference is caught (the MOAT net for a missed rename)", () => {
  // Simulate a merge bug: a happyPath entry whose state was renamed but the reference wasn't.
  const broken = contract({ interactionFlow: { happyPath: ["start", "ACTIVE_TYPO"] } });
  const problems = validateContractReferentialIntegrity(broken);
  assert.ok(problems.some((p) => /unknown state 'ACTIVE_TYPO'/.test(p)), problems.join("; "));
});

test("validateContractReferentialIntegrity: a dangling object reference and a duplicate id are both caught", () => {
  const danglingObj = contract({
    states: [{ id: "start", kind: "start", requiredInFrame: ["ghostObject"] }],
    interactionFlow: { happyPath: ["start"] },
  });
  assert.ok(validateContractReferentialIntegrity(danglingObj).some((p) => /unknown object 'ghostObject'/.test(p)));

  const dupState = contract({
    states: [{ id: "start", kind: "start" }, { id: "start", kind: "active" }],
    interactionFlow: { happyPath: ["start"] },
  });
  assert.ok(validateContractReferentialIntegrity(dupState).some((p) => /duplicate state id 'start'/.test(p)));
});

test("mergeSceneContracts: baseline.masks from a NON-FIRST scene survive (unioned, not dropped)", () => {
  const home = contract({ scenes: ["Assets/Scenes/Home.unity"] }); // no baseline
  const chef = contract({
    scenes: ["Assets/Scenes/StarChef.unity"],
    baseline: { ref: "baselines/g", masks: ["scoreLabel"] }, // masks namespaced to star-chef__scoreLabel
  });
  const merged = mergeSceneContracts(
    [{ prefix: "home", sceneName: "Home", contract: home }, { prefix: "star-chef", sceneName: "StarChef", contract: chef }],
    "g",
  );
  assert.deepEqual(merged.baseline!.masks, ["star-chef__scoreLabel"], "scene-2 masks survive the merge");
  assert.equal(merged.baseline!.ref, "baselines/g");
});

test("mergeSceneContracts: scenes that disagree on a state-signal REFUSE (never silently keep scene 0's)", () => {
  const home = contract({ scenes: ["Assets/Scenes/Home.unity"], stateSignal: { locator: "/HomeMgr", property: "phase" } });
  const chef = contract({ scenes: ["Assets/Scenes/StarChef.unity"], stateSignal: { locator: "/ChefMgr", property: "phase" } });
  assert.throws(
    () => mergeSceneContracts([{ prefix: "home", sceneName: "Home", contract: home }, { prefix: "star-chef", sceneName: "StarChef", contract: chef }], "g"),
    /different state signal|cannot fuse/i,
  );
});

test("mergeSceneContracts: ONE shared state-signal across scenes is kept; a different backgroundCamera refuses", () => {
  const sig = { locator: "/GM", property: "phase" };
  const a = contract({ scenes: ["Assets/Scenes/Home.unity"], stateSignal: sig, backgroundCamera: "Home:/Main Camera" });
  const b = contract({ scenes: ["Assets/Scenes/StarChef.unity"], stateSignal: sig, backgroundCamera: "StarChef:/Main Camera" });
  // Same signal is fine; the differing camera is the conflict.
  assert.throws(
    () => mergeSceneContracts([{ prefix: "home", sceneName: "Home", contract: a }, { prefix: "star-chef", sceneName: "StarChef", contract: b }], "g"),
    /different background camera|cannot fuse/i,
  );
});

test("mergeSceneContracts: scenes that disagree on age band / visual profile REFUSE (game-wide config)", () => {
  const a = contract({ scenes: ["Assets/Scenes/Home.unity"], ageBand: "5-7" });
  const b = contract({ scenes: ["Assets/Scenes/StarChef.unity"], ageBand: "8-10" });
  assert.throws(
    () => mergeSceneContracts([{ prefix: "home", sceneName: "Home", contract: a }, { prefix: "star-chef", sceneName: "StarChef", contract: b }], "g"),
    /different age band|cannot fuse/i,
  );
});

test("mergeSceneContracts: a merge that would produce a dangling reference THROWS, never ships mis-bound", () => {
  // A part whose happyPath references a state id that isn't declared → after namespacing it stays dangling
  // → the integrity net must refuse.
  const bad = contract({ interactionFlow: { happyPath: ["start", "missing"] } });
  assert.throws(
    () => mergeSceneContracts([{ prefix: "home", sceneName: "Home", contract: bad }], "g"),
    /referential integrity failed/,
  );
});
