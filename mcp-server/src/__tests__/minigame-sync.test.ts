/**
 * S8d — `loombridge minigame sync` structural drift proposal.
 *
 * Pure tests only: scene/contract diff and contract migration application.
 * Live Unity wiring stays a thin IO shell.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  applyContractDiff,
  diffContractVsScene,
  type ContractDiff,
} from "../capabilities/minigame/minigame-sync.js";
import { assertValidMinigameContract, validateMinigameContract } from "../capabilities/minigame/profiles/validator.js";
import type { MinigameContract } from "../capabilities/minigame/profiles/types.js";
import type { RoleCandidates } from "../capabilities/minigame/minigame-role-discover.js";

function baseContract(): MinigameContract {
  return assertValidMinigameContract({
    schemaVersion: "1",
    id: "shape-match",
    type: "2d-kids-minigame",
    scenes: ["Assets/Scenes/ShapeMatch.unity"],
    ageBand: "3-5",
    visualProfile: "phone-landscape",
    requiredInFrame: [
      { id: "playButton", locator: "ShapeMatch:/Canvas/StartPanel/PlayButton" },
      { id: "scoreText", locator: "ShapeMatch:/Canvas/HUD/ScoreText" },
      { id: "goneButton", locator: "ShapeMatch:/Canvas/GamePanel/GoneButton" },
      { id: "ambiguousButton", locator: "ShapeMatch:/Canvas/OldPanel/AmbiguousButton" },
      { id: "rewardBanner", locator: "ShapeMatch:/Canvas/RewardPanel/RewardBanner" },
    ],
    states: [
      { id: "active", kind: "active", scene: "Assets/Scenes/ShapeMatch.unity", requiredInFrame: ["playButton", "scoreText", "goneButton", "ambiguousButton"] },
      { id: "success_reward", kind: "success_reward", scene: "Assets/Scenes/ShapeMatch.unity", requiredInFrame: ["rewardBanner"] },
    ],
    uiSafeAreas: { maxOverflowFraction: 0, insets: { top: 0.05, bottom: 0.05, left: 0.04, right: 0.04 } },
    tapTargets: { minSizeDp: 90 },
    interactionFlow: { happyPath: ["active", "success_reward"] },
    artifactThresholds: {},
    checks: { deterministic: ["required-in-frame", "safe-area", "tap-target-size", "interaction-flow"] },
  });
}

function candidates(): RoleCandidates {
  return {
    controls: [
      { id: "playButton", locator: "/Canvas/MainPanel/PlayButton", name: "PlayButton", role: "button" },
      { id: "newControl", locator: "/Canvas/GamePanel/NewControl", name: "NewControl", role: "button" },
      { id: "ambiguousA", locator: "/Canvas/A/AmbiguousButton", name: "AmbiguousButton", role: "button" },
      { id: "ambiguousB", locator: "/Canvas/B/AmbiguousButton", name: "AmbiguousButton", role: "button" },
    ],
    texts: [
      { id: "scoreText", locator: "/Canvas/HUD/ScoreText", name: "ScoreText", role: "text" },
    ],
  };
}

test("diffContractVsScene detects relocated, removed, added, present non-control, and ambiguous leaf safely", () => {
  const diff = diffContractVsScene(
    baseContract(),
    [
      "/Canvas/MainPanel/PlayButton",
      "/Canvas/HUD/ScoreText",
      "/Canvas/RewardPanel/RewardBanner",
      "/Canvas/GamePanel/NewControl",
      "/Canvas/A/AmbiguousButton",
      "/Canvas/B/AmbiguousButton",
    ],
    candidates(),
  );

  assert.deepEqual(diff.present.map((r) => r.id).sort(), ["rewardBanner", "scoreText"]);
  assert.deepEqual(diff.relocated.map((r) => [r.ref.id, r.fromLocator, r.toLocator]), [
    ["playButton", "ShapeMatch:/Canvas/StartPanel/PlayButton", "/Canvas/MainPanel/PlayButton"],
  ]);
  assert.deepEqual(diff.removed.map((r) => r.id).sort(), ["ambiguousButton", "goneButton"]);
  assert.deepEqual(diff.added.map((a) => a.candidate.locator).sort(), [
    "/Canvas/A/AmbiguousButton",
    "/Canvas/B/AmbiguousButton",
    "/Canvas/GamePanel/NewControl",
  ]);
});

test("applyContractDiff applies relocations and remains schema-valid", () => {
  const contract = baseContract();
  const diff: ContractDiff = {
    present: [],
    relocated: [{ ref: contract.requiredInFrame[0], fromLocator: contract.requiredInFrame[0].locator, toLocator: "/Canvas/MainPanel/PlayButton" }],
    removed: [],
    added: [],
  };
  const next = applyContractDiff(contract, diff, {});

  assert.equal(validateMinigameContract(next).valid, true);
  assert.equal(next.requiredInFrame.find((r) => r.id === "playButton")?.locator, "/Canvas/MainPanel/PlayButton");
});

test("applyContractDiff refuses a removal that would empty a state's bindings", () => {
  const contract = assertValidMinigameContract({
    ...baseContract(),
    requiredInFrame: [
      { id: "onlyActive", locator: "ShapeMatch:/Canvas/GamePanel/OnlyActive" },
      { id: "rewardBanner", locator: "ShapeMatch:/Canvas/RewardPanel/RewardBanner" },
    ],
    states: [
      { id: "active", kind: "active", scene: "Assets/Scenes/ShapeMatch.unity", requiredInFrame: ["onlyActive"] },
      { id: "success_reward", kind: "success_reward", scene: "Assets/Scenes/ShapeMatch.unity", requiredInFrame: ["rewardBanner"] },
    ],
  });
  const diff: ContractDiff = {
    present: [contract.requiredInFrame[1]],
    relocated: [],
    removed: [contract.requiredInFrame[0]],
    added: [],
  };
  const next = applyContractDiff(contract, diff, { remove: true });

  assert.equal(validateMinigameContract(next).valid, true);
  assert.ok(next.requiredInFrame.some((r) => r.id === "onlyActive"), "unsafe removal is kept");
  assert.deepEqual(next.states.find((s) => s.id === "active")?.requiredInFrame, ["onlyActive"]);
});

test("applyContractDiff can add new controls to the first active state and stay valid", () => {
  const contract = baseContract();
  const diff: ContractDiff = {
    present: [],
    relocated: [],
    removed: [],
    added: [{ candidate: { id: "newControl", locator: "/Canvas/GamePanel/NewControl", name: "NewControl", role: "button" } }],
  };
  const next = applyContractDiff(contract, diff, { add: true });

  assert.equal(validateMinigameContract(next).valid, true);
  assert.ok(next.requiredInFrame.some((r) => r.id === "newControl" && r.locator === "/Canvas/GamePanel/NewControl"));
  assert.ok(next.states.find((s) => s.id === "active")?.requiredInFrame?.includes("newControl"));
});
