/**
 * S8a — live scene scan role discovery.
 *
 * The pure classifier generalizes background discovery's "scan then propose"
 * pattern to controls/text, while the draft builder must emit a valid starting
 * contract that a developer edits before capture/finalize.
 */

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  classifyRoleCandidates,
  draftContractFromCandidates,
  reorderStatesByTrace,
  nearestVisualProfile,
  panelVisitOrder,
  segmentStates,
  type RoleCandidates,
} from "../loomtide/minigame-role-discover.js";
import { validateMinigameContract } from "../loomtide/minigame-profiles/validator.js";
import { buildScaffoldContract } from "../loomtide/minigame-scaffold.js";
import type { RawScreenRects } from "../loomtide/minigame-capture-plan.js";
import type { MinigameContract } from "../loomtide/minigame-profiles/types.js";
import type { ReplayTrace } from "../loomtide/replay/types.js";
import { parseScanArgs, idFromScene } from "../loomtide/minigame-scan.js";
import { normalizeWorkspaceId } from "../loomtide/workspace-paths.js";
import { run as minigameRun } from "../loomtide/minigame.js";

function fixtureRects(): RawScreenRects {
  return {
    viewport: { width: 1280, height: 720, aspect: 16 / 9 },
    objects: [
      {
        locator: { path: "/Canvas/HUD/Button" },
        name: "Button",
        role: "button",
        isVisible: true,
        raycastTarget: true,
        interactable: true,
        viewportRect: { x: 0.05, y: 0.05, width: 0.12, height: 0.08 },
      },
      {
        locator: { path: "/Canvas/Dialog/Button" },
        name: "Button",
        role: "button",
        isVisible: true,
        raycastTarget: true,
        viewportRect: { x: 0.2, y: 0.7, width: 0.12, height: 0.08 },
      },
      {
        locator: { path: "/Canvas/Question/Label" },
        name: "Label",
        role: "text",
        isVisible: true,
        raycastTarget: false,
        text: "Pick the red shape",
        viewportRect: { x: 0.2, y: 0.1, width: 0.4, height: 0.06 },
      },
      {
        locator: { path: "/Canvas/UntypedTapTarget" },
        name: "UntypedTapTarget",
        isVisible: true,
        raycastTarget: true,
        viewportRect: { x: 0.7, y: 0.6, width: 0.1, height: 0.1 },
      },
      {
        locator: { path: "/Canvas/Panel" },
        name: "Panel",
        role: "container",
        isVisible: true,
        raycastTarget: true,
        viewportRect: { x: 0.1, y: 0.1, width: 0.6, height: 0.6 },
      },
      {
        locator: { path: "/Canvas/HiddenButton" },
        name: "HiddenButton",
        role: "button",
        isVisible: false,
        raycastTarget: true,
        viewportRect: { x: 0.1, y: 0.1, width: 0.1, height: 0.1 },
      },
      {
        locator: { path: "/Canvas/Backdrop" },
        name: "Backdrop",
        role: "image",
        isVisible: true,
        raycastTarget: true,
        text: "decor",
        viewportRect: { x: 0, y: 0, width: 1, height: 1 },
      },
      {
        locator: { path: "/Canvas/EmptyText" },
        name: "EmptyText",
        role: "text",
        isVisible: true,
        text: "   ",
        viewportRect: { x: 0.1, y: 0.4, width: 0.2, height: 0.05 },
      },
    ],
  };
}

function chefCandidates(): RoleCandidates {
  return {
    controls: [
      { id: "homeButton", locator: "/Canvas/HomeButton", name: "HomeButton", role: "button" },
      { id: "mixZone", locator: "/Canvas/MixPanel/MixZone", name: "MixZone", role: "image" },
      { id: "ingredientTomato", locator: "/Canvas/MixPanel/Ingredients/Tomato", name: "IngredientTomato", role: "image" },
      { id: "powerButton", locator: "/Canvas/CookPanel/PowerButton", name: "PowerButton", role: "button" },
      { id: "sprayBottle", locator: "/Canvas/CookPanel/SprayBottle", name: "SprayBottle", role: "image" },
      { id: "toppingStar", locator: "/Canvas/DecorPanel/TrayGroup/ToppingStar", name: "ToppingStar", role: "image" },
      { id: "doneButton", locator: "/Canvas/DecorPanel/DoneButton", name: "DoneButton", role: "button" },
      { id: "playAgain", locator: "/Canvas/FinaleGroup/PlayAgainButton", name: "PlayAgainButton", role: "button" },
      { id: "homePill", locator: "/Canvas/FinaleGroup/HomePill", name: "HomePill", role: "button" },
      { id: "arrow", locator: "/Canvas/HintLayer/Arrow", name: "Arrow", role: "image" },
    ],
    texts: [
      { id: "mixInstruction", locator: "/Canvas/MixPanel/Instruction", name: "Instruction", role: "text" },
      { id: "cookInstruction", locator: "/Canvas/CookPanel/Instruction", name: "Instruction", role: "text" },
      { id: "decorInstruction", locator: "/Canvas/DecorPanel/Instruction", name: "Instruction", role: "text" },
      { id: "rewardTitle", locator: "/Canvas/FinaleGroup/RewardTitle", name: "RewardTitle", role: "text" },
    ],
  };
}

function traceFixture(): ReplayTrace {
  return {
    schemaVersion: "0.1",
    id: "chef-happy-path",
    start: { scene: "Assets/Scenes/StarChef.unity", reset: "scene-load" },
    input: { backend: "ui-events" },
    segments: [
      {
        id: "play",
        actions: [
          { do: "tap", locator: { path: "/Canvas/HomeButton" } },
          { do: "drag", from: { path: "/Canvas/MixPanel/Ingredients/Tomato" }, to: { path: "/Canvas/MixPanel/MixZone" } },
          { do: "tap", locator: { path: "/Canvas/CookPanel/PowerButton" } },
          { do: "drag", from: { path: "/Canvas/DecorPanel/TrayGroup/ToppingStar" }, to: { path: "/Canvas/DecorPanel/Plate" } },
          { do: "tap", locator: { path: "/Canvas/FinaleGroup/PlayAgainButton" } },
          { do: "tap", locator: { path: "/Canvas/CookPanel/PowerButton" } },
        ],
      },
    ],
    outcome: { expected: "success" },
  };
}

test("classifyRoleCandidates picks tappable controls and text; excludes containers, hidden objects, and large backdrops", () => {
  const result = classifyRoleCandidates(fixtureRects());

  assert.equal(result.controls.length, 3);
  assert.equal(result.texts.length, 1);
  assert.deepEqual(result.controls.map((c) => c.locator).sort(), [
    "/Canvas/Dialog/Button",
    "/Canvas/HUD/Button",
    "/Canvas/UntypedTapTarget",
  ]);
  assert.deepEqual(result.texts.map((t) => t.locator), ["/Canvas/Question/Label"]);

  assert.ok(result.controls.every((c) => c.locator !== "/Canvas/Panel"));
  assert.ok(result.controls.every((c) => c.locator !== "/Canvas/HiddenButton"));
  assert.ok(result.controls.every((c) => c.locator !== "/Canvas/Backdrop"));
  assert.ok(result.texts.every((t) => t.locator !== "/Canvas/Backdrop"));

  const buttonIds = result.controls
    .filter((c) => c.locator.endsWith("/Button"))
    .map((c) => c.id);
  assert.equal(new Set(buttonIds).size, 2, "same leaf-name controls get run-wide disambiguated ids");
  assert.ok(buttonIds.every((id) => /^button-[0-9a-f]{6}$/.test(id)), `expected hashed button ids, got ${buttonIds.join(", ")}`);
});

test("draftContractFromCandidates emits a valid contract with the discovered roster bound to active", () => {
  const candidates = classifyRoleCandidates(fixtureRects());
  const contract = draftContractFromCandidates("shape-match", "Assets/Scenes/ShapeMatch.unity", candidates);
  const validation = validateMinigameContract(contract);

  assert.equal(validation.valid, true, `draft must validate; issues: ${JSON.stringify(validation.issues)}`);
  assert.equal(contract.id, "shape-match");
  assert.deepEqual(contract.scenes, ["Assets/Scenes/ShapeMatch.unity"]);
  assert.deepEqual(contract.interactionFlow.happyPath, ["active", "success_reward"]);
  assert.equal(contract.states[0].id, "active");
  assert.deepEqual(contract.states[0].requiredInFrame, contract.requiredInFrame.map((r) => r.id));
  assert.ok(contract.requiredInFrame.some((r) => r.locator === "/Canvas/Question/Label"));
  assert.ok(contract.checks.deterministic.includes("safe-area-sweep"));
  assert.ok(contract.checks.deterministic.includes("interaction-flow"));
});

test("segmentStates clusters a chef-like roster by screen panel and merges depth-2 chrome into every cluster", () => {
  const clusters = segmentStates(chefCandidates(), { order: ["MixPanel", "CookPanel", "DecorPanel", "FinaleGroup"] });

  assert.equal(clusters.length, 4);
  assert.deepEqual(clusters.map((c) => c.container), ["MixPanel", "CookPanel", "DecorPanel", "FinaleGroup"]);
  assert.deepEqual(clusters.map((c) => c.kind), ["active", "active", "active", "success_reward"]);
  for (const cluster of clusters) {
    assert.ok(cluster.objectIds.includes("homeButton"), `${cluster.container} includes persistent HomeButton chrome`);
    assert.ok(!cluster.objectIds.includes("arrow"), `${cluster.container} excludes HintLayer decoration`);
  }
  assert.ok(clusters[0].objectIds.includes("mixZone"));
  assert.ok(clusters[1].objectIds.includes("powerButton"));
  assert.ok(clusters[2].objectIds.includes("toppingStar"));
  assert.ok(clusters[3].objectIds.includes("playAgain"));
});

test("panelVisitOrder returns first-touch panel order from a trace and ignores depth-2 chrome taps", () => {
  assert.deepEqual(panelVisitOrder(traceFixture()), ["MixPanel", "CookPanel", "DecorPanel", "FinaleGroup"]);
});

test("reorderStatesByTrace (G5): a statically-ordered draft is re-ordered to the demonstrated play order", () => {
  // A draft built WITHOUT a trace orders states by static scan encounter (can be backwards).
  const staticDraft = draftContractFromCandidates("star-chef", "Assets/Scenes/StarChef.unity", chefCandidates(), {});
  const before = staticDraft.interactionFlow.happyPath;
  const reordered = reorderStatesByTrace(staticDraft, traceFixture());
  // The trace visits MixPanel → CookPanel → DecorPanel → FinaleGroup, so the played order is mix→cook→decorate→success.
  assert.deepEqual(reordered.interactionFlow.happyPath, ["mix", "cook", "decorate", "success_reward"]);
  assert.deepEqual(reordered.states.map((s) => s.id), ["mix", "cook", "decorate", "success_reward"]);
  // Pure permutation — same set of states, success_reward stays terminal.
  assert.deepEqual([...before].sort(), [...reordered.interactionFlow.happyPath].sort());
  assert.equal(reordered.states.at(-1)?.kind, "success_reward");
  // An empty/orderless trace is a no-op (returns the same object).
  assert.equal(reorderStatesByTrace(staticDraft, { schemaVersion: "1", segments: [] } as never), staticDraft);

  // Already in play order → same-object return (no needless rewrite/persist).
  const ordered = reorderStatesByTrace(staticDraft, traceFixture());
  assert.equal(reorderStatesByTrace(ordered, traceFixture()), ordered);

  // NOT scan-fresh (a hand-edited happyPath: a repeat, or a subset) → left UNTOUCHED, not silently
  // rebuilt to the full one-entry-per-state list (that would add/drop graded transitions).
  const repeat = { ...staticDraft, interactionFlow: { ...staticDraft.interactionFlow, happyPath: ["mix", "cook", "mix"] } };
  assert.equal(reorderStatesByTrace(repeat, traceFixture()), repeat);
  const subset = { ...staticDraft, interactionFlow: { ...staticDraft.interactionFlow, happyPath: ["mix", "cook"] } };
  assert.equal(reorderStatesByTrace(subset, traceFixture()), subset);
});

test("reorderStatesByTrace (multi-scene): groups states by scene (first-touch) and never interleaves them", () => {
  // A scrambled, scan-fresh fused draft. Without scene-awareness the global success-last rule sinks
  // home's reward behind the game's screens (interleaving). The per-scene reorder must keep each
  // scene's states contiguous, in first-touch scene order, with success_reward last WITHIN its scene.
  const base = buildScaffoldContract("g", { scene: "Assets/Scenes/Home.unity" });
  const scrambled: MinigameContract = {
    ...base,
    scenes: ["Assets/Scenes/Home.unity", "Assets/Scenes/StarChef.unity"],
    requiredInFrame: [
      { id: "home__tile", locator: "Home:/Canvas/Tiles/Tile", description: "" },
      { id: "starChef__mix", locator: "StarChef:/Canvas/MixPanel/Mix", description: "" },
      { id: "starChef__score", locator: "StarChef:/Canvas/RewardPanel/Score", description: "" },
    ],
    states: [
      { id: "starChef__active", kind: "active", scene: "StarChef", requiredInFrame: ["starChef__mix"], description: "" },
      { id: "home__active", kind: "active", scene: "Home", requiredInFrame: ["home__tile"], description: "" },
      { id: "home__success_reward", kind: "success_reward", scene: "Home", description: "" },
      { id: "starChef__success_reward", kind: "success_reward", scene: "StarChef", requiredInFrame: ["starChef__score"], description: "" },
    ],
    interactionFlow: { happyPath: ["starChef__active", "home__active", "home__success_reward", "starChef__success_reward"] },
  };
  const trace: ReplayTrace = {
    schemaVersion: "0.1",
    id: "ms",
    start: { scene: "Assets/Scenes/Home.unity", reset: "scene-load" },
    input: { backend: "ui-events" },
    segments: [
      { id: "s1", scene: "Home", actions: [{ do: "tap", locator: { path: "/Canvas/Tiles/Tile" } }] },
      { id: "s2", scene: "StarChef", actions: [{ do: "tap", locator: { path: "/Canvas/MixPanel/Mix" } }, { do: "tap", locator: { path: "/Canvas/RewardPanel/Score" } }] },
    ],
    outcome: { expected: "success" },
  } as ReplayTrace;
  const reordered = reorderStatesByTrace(scrambled, trace);
  assert.deepEqual(reordered.interactionFlow.happyPath, [
    "home__active",
    "home__success_reward",
    "starChef__active",
    "starChef__success_reward",
  ]);
});

test("draftContractFromCandidates writes an auto-detected stateSignal onto the draft (phase-2)", () => {
  const withSig = draftContractFromCandidates("star-chef", "Assets/Scenes/StarChef.unity", chefCandidates(), {
    panelOrder: panelVisitOrder(traceFixture()),
    stateSignal: { locator: "/Canvas/ChefGameManager", component: "ChefGameManager", property: "phase" },
  });
  assert.equal(validateMinigameContract(withSig).valid, true);
  assert.deepEqual(withSig.stateSignal, { locator: "/Canvas/ChefGameManager", component: "ChefGameManager", property: "phase" });

  // No component → the draft serializes only locator+property (auto-detection always supplies a
  // component, so this is just the omission behavior; the recorder itself requires the component).
  const noComp = draftContractFromCandidates("star-chef", "Assets/Scenes/StarChef.unity", chefCandidates(), {
    stateSignal: { locator: "/Canvas/GM", property: "phase" },
  });
  assert.deepEqual(noComp.stateSignal, { locator: "/Canvas/GM", property: "phase" });

  // Absent option → no stateSignal field at all (back-compat with single-screen games).
  const none = draftContractFromCandidates("star-chef", "Assets/Scenes/StarChef.unity", chefCandidates(), {});
  assert.equal(none.stateSignal, undefined);
});

test("draftContractFromCandidates builds a valid multi-state chef draft ordered by demonstration panels", () => {
  const contract = draftContractFromCandidates("star-chef", "Assets/Scenes/StarChef.unity", chefCandidates(), {
    panelOrder: panelVisitOrder(traceFixture()),
  });
  const validation = validateMinigameContract(contract);

  assert.equal(validation.valid, true, `chef draft must validate; issues: ${JSON.stringify(validation.issues)}`);
  assert.deepEqual(contract.interactionFlow.happyPath, ["mix", "cook", "decorate", "success_reward"]);
  assert.equal(contract.states.length, 4);
  assert.equal(contract.states.at(-1)?.kind, "success_reward");
  for (const state of contract.states) {
    assert.ok(state.requiredInFrame?.includes("homeButton"), `${state.id} includes persistent HomeButton chrome`);
  }
  assert.deepEqual(contract.requiredInFrame.map((r) => r.id).sort(), [
    "cookInstruction",
    "decorInstruction",
    "doneButton",
    "homeButton",
    "homePill",
    "mixInstruction",
    "mixZone",
    "playAgain",
    "powerButton",
    "rewardTitle",
    "sprayBottle",
    "toppingStar",
    "ingredientTomato",
    "arrow",
  ].sort());
});

test("draftContractFromCandidates de-duplicates derived state ids when panel names collapse", () => {
  const candidates: RoleCandidates = {
    controls: [
      { id: "btnA", locator: "/Canvas/GamePanel/BtnA", name: "BtnA", role: "button" },
      { id: "btnB", locator: "/Canvas/GameRoot/BtnB", name: "BtnB", role: "button" },
      { id: "playAgain", locator: "/Canvas/WinPanel/PlayAgain", name: "PlayAgain", role: "button" },
    ],
    texts: [],
  };

  const contract = draftContractFromCandidates("collision-game", "Assets/Scenes/CollisionGame.unity", candidates);
  const ids = contract.states.map((s) => s.id);

  assert.equal(validateMinigameContract(contract).valid, true);
  assert.equal(new Set(ids).size, ids.length, `state ids must be unique; got ${ids.join(", ")}`);
  assert.deepEqual(ids, ["game", "game-2", "success_reward"]);
});

test("draftContractFromCandidates falls back to the valid sparse scaffold shape for a one-panel scan", () => {
  const sparse: RoleCandidates = {
    controls: [{ id: "answerButton", locator: "/Canvas/GamePanel/AnswerButton", name: "AnswerButton", role: "button" }],
    texts: [{ id: "questionText", locator: "/Canvas/GamePanel/QuestionText", name: "QuestionText", role: "text" }],
  };
  const contract = draftContractFromCandidates("one-screen", "Assets/Scenes/OneScreen.unity", sparse);
  const validation = validateMinigameContract(contract);

  assert.equal(validation.valid, true, `sparse fallback must validate; issues: ${JSON.stringify(validation.issues)}`);
  assert.deepEqual(contract.interactionFlow.happyPath, ["active", "success_reward"]);
  assert.deepEqual(contract.states.map((s) => s.id), ["active", "success_reward"]);
  assert.deepEqual(contract.states[0].requiredInFrame, ["answerButton", "questionText"]);
});

test("draftContractFromCandidates can carry advisory background recommendations without enabling new gates", () => {
  const candidates: RoleCandidates = {
    controls: [{ id: "playButton", locator: "/Canvas/PlayButton", name: "PlayButton", role: "button" }],
    texts: [],
  };
  const contract = draftContractFromCandidates(
    "chef-game",
    "Assets/Scenes/ChefGame.unity",
    candidates,
    { backgroundCandidates: {
      camera: { locator: "ChefGame:/Main Camera", name: "Main Camera", orthographic: true, orthoSize: 5, position: { x: 0, y: 0 } },
      cameras: [],
      recommended: [{ locator: "ChefGame:/Background/Sky", name: "Sky", aabb: { min: { x: -10, y: -5 }, max: { x: 10, y: 5 } }, widestFraction: 1, fullWidthBand: true }],
      excluded: [],
      allLayers: [],
      coverageByDevice: [],
      warnings: [],
    } },
  );

  assert.equal(validateMinigameContract(contract).valid, true);
  assert.deepEqual(contract.backgroundLayers, ["ChefGame:/Background/Sky"]);
  assert.equal(contract.backgroundCamera, "ChefGame:/Main Camera");
  assert.ok(!contract.checks.deterministic.includes("background-coverage"));
});

test("nearestVisualProfile maps a measured aspect to the closest profile; bad aspects fall back to phone-portrait", () => {
  assert.equal(nearestVisualProfile(0.5625), "phone-portrait"); // 9:16
  assert.equal(nearestVisualProfile(1.777), "phone-landscape"); // 16:9
  assert.equal(nearestVisualProfile(0.75), "tablet-portrait"); // 3:4
  assert.equal(nearestVisualProfile(1.333), "tablet-landscape"); // 4:3

  // Refuse-to-guess → safe default for missing/zero/NaN/negative.
  assert.equal(nearestVisualProfile(0), "phone-portrait");
  assert.equal(nearestVisualProfile(Number.NaN), "phone-portrait");
  assert.equal(nearestVisualProfile(undefined as unknown as number), "phone-portrait");
  assert.equal(nearestVisualProfile(-1.5), "phone-portrait");
});

test("draftContractFromCandidates honors an explicit visualProfile opt and still validates", () => {
  const candidates = classifyRoleCandidates(fixtureRects());
  const contract = draftContractFromCandidates("shape-match", "Assets/Scenes/ShapeMatch.unity", candidates, {
    visualProfile: "tablet-landscape",
  });

  assert.equal(contract.visualProfile, "tablet-landscape");
  assert.equal(validateMinigameContract(contract).valid, true, "explicit-profile draft must validate");

  // Absent opt keeps the safe default.
  const defaulted = draftContractFromCandidates("shape-match", "Assets/Scenes/ShapeMatch.unity", candidates);
  assert.equal(defaulted.visualProfile, "phone-portrait");
  assert.equal(validateMinigameContract(defaulted).valid, true);
});

test("draftContractFromCandidates proposes a DRAFT state for a trace-only panel the static scan can't see", () => {
  // Static scan sees only the MixPanel + the FinaleGroup reward (both ACTIVE at scene-load).
  const staticOnly: RoleCandidates = {
    controls: [
      { id: "homeButton", locator: "/Canvas/HomeButton", name: "HomeButton", role: "button" },
      { id: "mixZone", locator: "/Canvas/MixPanel/MixZone", name: "MixZone", role: "image" },
      { id: "playAgain", locator: "/Canvas/FinaleGroup/PlayAgainButton", name: "PlayAgainButton", role: "button" },
    ],
    texts: [
      { id: "mixInstruction", locator: "/Canvas/MixPanel/Instruction", name: "Instruction", role: "text" },
      { id: "rewardTitle", locator: "/Canvas/FinaleGroup/RewardTitle", name: "RewardTitle", role: "text" },
    ],
  };
  // The human demonstrably used MixPanel, then DecorPanel (INACTIVE at scene-load → invisible to the
  // static scan), then the FinaleGroup reward.
  const trace: ReplayTrace = {
    schemaVersion: "0.1",
    id: "chef-happy-path",
    start: { scene: "Assets/Scenes/StarChef.unity", reset: "scene-load" },
    input: { backend: "ui-events" },
    segments: [
      {
        id: "play",
        actions: [
          { do: "drag", from: { path: "/Canvas/MixPanel/Ingredients/Tomato" }, to: { path: "/Canvas/MixPanel/MixZone" } },
          { do: "drag", from: { path: "/Canvas/DecorPanel/TrayGroup/ToppingStar" }, to: { path: "/Canvas/DecorPanel/Plate" } },
          { do: "tap", locator: { path: "/Canvas/FinaleGroup/PlayAgainButton" } },
        ],
      },
    ],
    outcome: { expected: "success" },
  };

  const contract = draftContractFromCandidates("star-chef", "Assets/Scenes/StarChef.unity", staticOnly, {
    panelOrder: panelVisitOrder(trace),
    trace,
  });

  assert.equal(validateMinigameContract(contract).valid, true, `trace-derived draft must validate; issues: ${JSON.stringify(validateMinigameContract(contract).issues)}`);
  // mix (static) → decorate (trace-only, absent from the static scan) → success_reward (static), in visit order.
  assert.deepEqual(contract.states.map((s) => s.id), ["mix", "decorate", "success_reward"]);
  assert.deepEqual(contract.interactionFlow.happyPath, ["mix", "decorate", "success_reward"]);
  assert.equal(contract.states.at(-1)?.kind, "success_reward");

  const decorate = contract.states.find((s) => s.id === "decorate");
  assert.ok(decorate, "decorate state proposed from the demonstration");
  assert.equal(decorate?.kind, "active");
  assert.ok((decorate?.requiredInFrame?.length ?? 0) > 0, "trace-derived state has a non-empty (thin) requiredInFrame");
  assert.ok(decorate?.requiredInFrame?.includes("homeButton"), "trace-derived state still receives persistent chrome");
  assert.ok((decorate?.description ?? "").toLowerCase().includes("draft"), "trace-derived state is marked DRAFT");
  assert.ok(/not visible at scene-load|demonstration/i.test(decorate?.description ?? ""), "describes its provenance");

  // Every state requiredInFrame id resolves to a declared top-level object (the trace-only objects joined the roster).
  const declared = new Set(contract.requiredInFrame.map((r) => r.id));
  for (const id of decorate?.requiredInFrame ?? []) assert.ok(declared.has(id), `${id} declared in top-level requiredInFrame`);
});

test("a trace-only panel matching the success signal becomes a success_reward state sorted last", () => {
  const staticOnly: RoleCandidates = {
    controls: [{ id: "playButton", locator: "/Canvas/StartPanel/PlayButton", name: "PlayButton", role: "button" }],
    texts: [{ id: "title", locator: "/Canvas/StartPanel/Title", name: "Title", role: "text" }],
  };
  const trace: ReplayTrace = {
    schemaVersion: "0.1",
    id: "g-happy-path",
    start: { scene: "Assets/Scenes/G.unity", reset: "scene-load" },
    input: { backend: "ui-events" },
    segments: [
      {
        id: "play",
        actions: [
          { do: "tap", locator: { path: "/Canvas/StartPanel/PlayButton" } },
          { do: "tap", locator: { path: "/Canvas/RewardPanel/ReplayButton" } },
        ],
      },
    ],
    outcome: { expected: "success" },
  };
  const contract = draftContractFromCandidates("g", "Assets/Scenes/G.unity", staticOnly, {
    panelOrder: panelVisitOrder(trace),
    trace,
  });

  assert.equal(validateMinigameContract(contract).valid, true);
  // RewardPanel matches the success signal → its derived state is success_reward and sorts LAST.
  assert.equal(contract.states.at(-1)?.kind, "success_reward");
  const rewardDerived = contract.states.find((s) => s.kind === "success_reward" && s.requiredInFrame?.includes("replayButton"));
  assert.ok(rewardDerived, "the trace-only RewardPanel produced a success_reward state");
});

test("duplicate-leaf trace panels get unique, contiguously-numbered ids without throwing", () => {
  const staticOnly: RoleCandidates = {
    controls: [
      { id: "startBtn", locator: "/Canvas/StartPanel/StartButton", name: "StartButton", role: "button" },
      { id: "playAgain", locator: "/Canvas/WinPanel/PlayAgain", name: "PlayAgain", role: "button" },
    ],
    texts: [],
  };
  // Two distinct trace-only panels whose names collapse to the same base state id ("StagePanel"/"Stage"→"stage").
  const trace: ReplayTrace = {
    schemaVersion: "0.1",
    id: "dup-happy-path",
    start: { scene: "Assets/Scenes/Dup.unity", reset: "scene-load" },
    input: { backend: "ui-events" },
    segments: [
      {
        id: "play",
        actions: [
          { do: "tap", locator: { path: "/Canvas/StagePanel/Tap1" } },
          { do: "tap", locator: { path: "/Canvas/Stage/Tap2" } },
        ],
      },
    ],
    outcome: { expected: "success" },
  };

  assert.doesNotThrow(() => {
    draftContractFromCandidates("dup", "Assets/Scenes/Dup.unity", staticOnly, {
      panelOrder: panelVisitOrder(trace),
      trace,
    });
  });
  const contract = draftContractFromCandidates("dup", "Assets/Scenes/Dup.unity", staticOnly, {
    panelOrder: panelVisitOrder(trace),
    trace,
  });
  const ids = contract.states.map((s) => s.id);
  assert.equal(validateMinigameContract(contract).valid, true, `dup draft must validate; issues: ${JSON.stringify(validateMinigameContract(contract).issues)}`);
  assert.equal(new Set(ids).size, ids.length, `state ids must be unique; got ${ids.join(", ")}`);
  // Both collapsing trace panels are present (contiguous numbering, base then base-2).
  assert.ok(ids.includes("stage"), `ids: ${ids.join(", ")}`);
  assert.ok(ids.includes("stage-2"), `ids: ${ids.join(", ")}`);
});

test("draftContractFromCandidates is byte-identical with no trace (regression guard)", () => {
  // The pre-S8b code path: a draft built WITHOUT a trace must be unchanged.
  const candidates = chefCandidates();
  const omitted = draftContractFromCandidates("star-chef", "Assets/Scenes/StarChef.unity", candidates, {
    panelOrder: ["MixPanel", "CookPanel", "DecorPanel", "FinaleGroup"],
  });
  // No trace ⇒ states/order driven solely by the static scan + panelOrder.
  assert.deepEqual(omitted.interactionFlow.happyPath, ["mix", "cook", "decorate", "success_reward"]);
  // Passing `trace: undefined` must be identical to omitting it entirely.
  const explicitUndefined = draftContractFromCandidates("star-chef", "Assets/Scenes/StarChef.unity", candidates, {
    panelOrder: ["MixPanel", "CookPanel", "DecorPanel", "FinaleGroup"],
    trace: undefined,
  });
  assert.equal(JSON.stringify(explicitUndefined), JSON.stringify(omitted), "trace:undefined must equal omitting trace");

  // The sparse fallback shape is also untouched without a trace.
  const sparse: RoleCandidates = {
    controls: [{ id: "answerButton", locator: "/Canvas/GamePanel/AnswerButton", name: "AnswerButton", role: "button" }],
    texts: [{ id: "questionText", locator: "/Canvas/GamePanel/QuestionText", name: "QuestionText", role: "text" }],
  };
  const sparseDraft = draftContractFromCandidates("one-screen", "Assets/Scenes/OneScreen.unity", sparse);
  assert.deepEqual(sparseDraft.states.map((s) => s.id), ["active", "success_reward"]);
  assert.deepEqual(sparseDraft.states[0].requiredInFrame, ["answerButton", "questionText"]);
});

test("scan arg parsing derives ids and rejects invalid scene/id shapes", async () => {
  assert.equal(idFromScene("Assets/Scenes/StarChef.unity"), "star-chef");
  // normalizeWorkspaceId canonicalizes any user id the SAME way the scene-derive does (always valid).
  assert.equal(normalizeWorkspaceId("StarChef"), "star-chef");        // camelCase split
  assert.equal(normalizeWorkspaceId("Star Chef!!"), "star-chef");     // spaces/punct → single hyphen
  assert.equal(normalizeWorkspaceId("star-chef"), "star-chef");       // already canonical → unchanged (idempotent)
  assert.equal(normalizeWorkspaceId("9lives"), "game-9lives");        // leading digit → game- prefix
  assert.equal(normalizeWorkspaceId("ALLCAPS"), "allcaps");
  // Degenerate inputs always yield a VALID id (never empty / never starts with a digit/hyphen).
  for (const junk of ["", "   ", "---", "___", "!!!"]) assert.equal(normalizeWorkspaceId(junk), "game-minigame");
  // Many-to-one is intentional for case/separator variants — they MUST resolve the same workspace…
  for (const v of ["StarChef", "star chef", "Star_Chef", "star-chef", "STAR  CHEF"]) assert.equal(normalizeWorkspaceId(v), "star-chef");
  // …and the result is always pattern-valid (no trailing/double hyphen) + idempotent.
  for (const v of ["StarChef", "9lives", "a--b__c", "  Trim Me  "]) {
    const out = normalizeWorkspaceId(v);
    assert.match(out, /^[a-z][a-z0-9-]*$/);
    assert.doesNotMatch(out, /--|-$/);
    assert.equal(normalizeWorkspaceId(out), out, "idempotent");
  }
  assert.deepEqual(parseScanArgs(["--scene", "Assets/Scenes/StarChef.unity"]), {
    scene: "Assets/Scenes/StarChef.unity",
    id: "star-chef",
    output: undefined,
    traceId: undefined,
    traceRoot: undefined,
    quietNext: false,
  });
  assert.deepEqual(parseScanArgs(["--scene", "Assets/Scenes/StarChef.unity", "--id", "chef", "--output", "out.json", "--trace", "chef-happy", "--trace-root", "ws", "--quiet-next"]), {
    scene: "Assets/Scenes/StarChef.unity",
    id: "chef",
    output: path.resolve("out.json"),
    traceId: "chef-happy",
    traceRoot: path.resolve("ws"),
    quietNext: true,
  });
  assert.ok("error" in parseScanArgs(["--scene", "../Bad.unity"]));
  // A non-canonical --id is NORMALIZED (StarChef → star-chef, Bad_Id → bad-id), not rejected — zero friction.
  const norm = parseScanArgs(["--scene", "Assets/Scenes/StarChef.unity", "--id", "Bad_Id"]);
  assert.equal("error" in norm ? norm.error : (norm as { id: string }).id, "bad-id");
  assert.equal((parseScanArgs(["--scene", "Assets/Scenes/G.unity", "--id", "StarChef"]) as { id: string }).id, "star-chef");
  assert.equal(await minigameRun(["scan"]), 2);
});
