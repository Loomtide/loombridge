/**
 * Pure core of `loombridge minigame capture` — the op→capture transform, the stable
 * per-object id, the trace-anchored state plan, and the honest flow.json assembly.
 * (The live bridge drive is exercised by hand against a running editor.)
 */

import assert from "node:assert/strict";
import test from "node:test";

import { buildScaffoldContract } from "../capabilities/minigame/minigame-scaffold.js";
import { buildCaptureSummary } from "../capabilities/minigame/minigame-capture.js";
import {
  actionSceneSlugs,
  assignObjectIds,
  buildFlowEvidence,
  objectIdFromPath,
  perDeviceKey,
  planCaptureFromTrace,
  planResponseStimulus,
  requiredVisibleStatus,
  summarizeChangedIds,
  toCaptureObject,
  toCaptureState,
  toResponseDoc,
  type CapturePlan,
  type RawScreenObject,
  type RawScreenRects,
} from "../capabilities/minigame/minigame-capture-plan.js";
import type { DeviceSpec, MinigameContract } from "../capabilities/minigame/profiles/types.js";
import type { BackgroundCandidates } from "../capabilities/minigame/types.js";
import { changedObjectIds } from "../capabilities/minigame/input-response.js";
import type { Action, ReplayTrace } from "../capabilities/replay/types.js";

const tap = (path: string): Action => ({ do: "tap", locator: { path } });
const wait = (path: string): Action => ({ do: "wait-for-visible", locator: { path } });
const worldTap = (path: string): Action => ({ do: "world-tap", locator: { path } });
const drag = (from: string, to: string): Action => ({ do: "drag", from: { path: from }, to: { path: to } });
const wcond = (expected: string, scene?: string): Action => ({
  do: "wait-for-condition",
  locator: scene ? { scene, path: "/Canvas/GM" } : { path: "/Canvas/GM" },
  component: "GM",
  property_path: "phase",
  operator: "equals",
  expected,
});

function trace(actions: Action[]): ReplayTrace {
  return {
    schemaVersion: "0.1",
    id: "g-happy-path",
    start: { scene: "Assets/Scenes/G.unity", reset: "scene-load" },
    input: { backend: "ui-events" },
    segments: actions.map((a, i) => ({ id: `step-${i + 1}`, actions: [a] })),
    outcome: { expected: "success" },
  };
}

test("objectIdFromPath: leaf for meaningful names, parent-qualified for generic leaves", () => {
  assert.equal(objectIdFromPath("/HUD/StartScreen/StartButton"), "startButton");
  assert.equal(objectIdFromPath("/HUD/HomeButton"), "homeButton");
  assert.equal(objectIdFromPath("/HUD/AnswerButton1"), "answerButton1");
  // Generic leaves ("Label") are qualified with the parent so they stay distinct.
  assert.equal(objectIdFromPath("/HUD/AnswerButton1/Label"), "answerButton1Label");
  assert.notEqual(
    objectIdFromPath("/HUD/AnswerButton1/Label"),
    objectIdFromPath("/HUD/StartButton/Label"),
  );
  assert.equal(objectIdFromPath("/Player"), "player");
});

test("assignObjectIds: distinct paths sharing a leaf get distinct, stable ids", () => {
  const a = "/Canvas/StartScreen/Button";
  const b = "/Canvas/EndScreen/Button"; // same leaf as `a` → both base `button`
  // `a` repeated (it shows in more than one state) must not change anything.
  const ids = assignObjectIds([a, b, a]);
  assert.equal(objectIdFromPath(a), "button");
  assert.equal(objectIdFromPath(b), "button");
  // Collision resolved: distinct objects never share an id (gates bind by id).
  assert.notEqual(ids.get(a), ids.get(b));
  assert.ok(ids.get(a)?.startsWith("button-"), ids.get(a));
  assert.ok(ids.get(b)?.startsWith("button-"), ids.get(b));
  // Stable across order / repetition (same path → same id in every state).
  assert.equal(assignObjectIds([b, a]).get(a), ids.get(a));
  // A base owned by a single path keeps the clean readable id (no needless suffix).
  assert.equal(assignObjectIds([a, b, "/HUD/StartButton"]).get("/HUD/StartButton"), "startButton");
});

test("toCaptureState uses the run-wide id map to disambiguate colliding leaves", () => {
  const idMap = assignObjectIds(["/HUD/StartScreen/Button", "/HUD/EndScreen/Button"]);
  const idFor = (p: string): string => idMap.get(p) ?? objectIdFromPath(p);
  const doc = toCaptureState(
    "start",
    { objects: [{ locator: { path: "/HUD/StartScreen/Button" }, role: "button", active: true, isVisible: true }] },
    idFor,
  );
  // The id matches what the OTHER state's capture will use for the same path.
  assert.equal(doc.objects[0].id, idMap.get("/HUD/StartScreen/Button"));
  assert.notEqual(doc.objects[0].id, idMap.get("/HUD/EndScreen/Button"));
});

test("toCaptureObject maps the raw op fields + derives id from path", () => {
  const raw: RawScreenObject = {
    locator: { path: "/HUD/StartScreen/StartButton" },
    name: "StartButton",
    role: "button",
    active: true,
    isVisible: true,
    isFullyVisible: true,
    raycastTarget: true,
    canvasScaleFactor: 1,
    screenRect: { x: 1, y: 2, width: 3, height: 4 },
    viewportRect: { x: 0, y: 0, width: 0.1, height: 0.1 },
  };
  const o = toCaptureObject(raw);
  assert.equal(o.id, "startButton");
  assert.equal(o.path, "/HUD/StartScreen/StartButton");
  assert.equal(o.role, "button");
  assert.equal(o.active, true);
  assert.equal(o.isFullyVisible, true);
  assert.equal(o.raycastTarget, true);
  assert.equal(o.canvasScaleFactor, 1);
  assert.deepEqual(o.screenRect, { x: 1, y: 2, width: 3, height: 4 });
});

test("toCaptureState builds the <state>.ui-rects.json doc shape", () => {
  const doc = toCaptureState("start", {
    viewport: { width: 1280, height: 720, aspect: 1.7778 },
    objects: [{ locator: { path: "/HUD/StartScreen/StartButton" }, role: "button", active: true, isVisible: true }],
  });
  assert.equal(doc.state, "start");
  assert.ok(doc.source.includes("minigame capture"));
  assert.deepEqual(doc.viewport, { width: 1280, height: 720, aspect: 1.7778 });
  assert.equal(doc.objects[0].id, "startButton");
});

test("planCaptureFromTrace (no Home tap): start/active captured, success=final, home_back unreached", () => {
  const contract = buildScaffoldContract("g");
  const t = trace([
    wait("/HUD/StartScreen/StartButton"),
    tap("/HUD/StartScreen/StartButton"), // index 1 = first tap → active boundary
    worldTap("/Spawner/Apple_0"),
    tap("/HUD/AnswerButton1"),
  ]);
  const plan = planCaptureFromTrace(contract, t);
  const byId = Object.fromEntries(plan.states.map((s) => [s.stateId, s.trigger]));
  assert.deepEqual(byId.start, { kind: "initial" });
  assert.deepEqual(byId.active, { kind: "after-action", index: 1 });
  assert.deepEqual(byId.success_reward, { kind: "final" });
  assert.equal(byId.home_back.kind, "unreached");
  assert.ok(plan.unreached.some((u) => u.stateId === "home_back"));
});

test("planCaptureFromTrace (with Home tap): success before Home, home_back after Home", () => {
  const contract = buildScaffoldContract("g");
  const t = trace([
    wait("/HUD/StartScreen/StartButton"),
    tap("/HUD/StartScreen/StartButton"), // 1: first tap → active
    tap("/HUD/AnswerButton0"), // 2
    tap("/HUD/HomeButton"), // 3: home tap
  ]);
  const plan = planCaptureFromTrace(contract, t);
  const byId = Object.fromEntries(plan.states.map((s) => [s.stateId, s.trigger]));
  assert.deepEqual(byId.active, { kind: "after-action", index: 1 });
  assert.deepEqual(byId.success_reward, { kind: "before-action", index: 3 });
  assert.deepEqual(byId.home_back, { kind: "after-action", index: 3 });
  assert.equal(plan.unreached.length, 0);
});

// A multi-active-screen contract (mix/cook-style): two ACTIVE states on distinct panels,
// success_reward last. State ids deliberately DON'T match their panel names (mirrors a
// hand-edited contract, e.g. `DecorPanel` → `decorate`), so the gesture→state join must be
// by PANEL of the requiredInFrame objects, not by id.
function multiActiveContract(): MinigameContract {
  const base = buildScaffoldContract("g");
  return {
    ...base,
    requiredInFrame: [
      { id: "ctrlA", locator: "/Canvas/PanelA/CtrlA", description: "" },
      { id: "ctrlB", locator: "/Canvas/PanelB/CtrlB", description: "" },
      { id: "home", locator: "/Canvas/HomeButton", description: "" },
    ],
    states: [
      { id: "screenA", kind: "active", scene: base.scenes[0], requiredInFrame: ["ctrlA", "home"], description: "" },
      { id: "screenB", kind: "active", scene: base.scenes[0], requiredInFrame: ["ctrlB", "home"], description: "" },
      { id: "success_reward", kind: "success_reward", scene: base.scenes[0], requiredInFrame: ["home"], description: "" },
    ],
    interactionFlow: { happyPath: ["screenA", "screenB", "success_reward"] },
  };
}

// ── requiredVisibleStatus (the loop's moment-selection visibility check) ──────

const rects = (objects: RawScreenObject[]): RawScreenRects => ({ objects });

test("requiredVisibleStatus: all required objects visible → visible === total, no missing", () => {
  const objLoc = new Map([
    ["ctrlA", "/Canvas/PanelA/CtrlA"],
    ["done", "/Canvas/PanelA/DoneButton"],
  ]);
  const r = rects([
    { locator: { path: "/Canvas/PanelA/CtrlA" }, isVisible: true },
    { locator: { path: "/Canvas/PanelA/DoneButton" }, isVisible: true },
  ]);
  assert.deepEqual(requiredVisibleStatus(["ctrlA", "done"], objLoc, r), { total: 2, visible: 2, missing: [] });
});

test("requiredVisibleStatus: a present-but-not-visible object and an absent object both count as missing", () => {
  const objLoc = new Map([
    ["ctrlA", "/Canvas/PanelA/CtrlA"],
    ["done", "/Canvas/PanelA/DoneButton"], // SetActive-d only later → absent from this dump
  ]);
  const r = rects([
    { locator: { path: "/Canvas/PanelA/CtrlA" }, isVisible: true },
    { locator: { path: "/Canvas/PanelA/Other" }, isVisible: false },
  ]);
  const out = requiredVisibleStatus(["ctrlA", "done"], objLoc, r);
  assert.equal(out.total, 2);
  assert.equal(out.visible, 1);
  assert.deepEqual(out.missing, ["done"]); // absent from the dump entirely
});

test("requiredVisibleStatus: an object present but isVisible !== true is missing", () => {
  const objLoc = new Map([["ctrlA", "/Canvas/PanelA/CtrlA"]]);
  const r = rects([{ locator: { path: "/Canvas/PanelA/CtrlA" }, isVisible: false }]);
  assert.deepEqual(requiredVisibleStatus(["ctrlA"], objLoc, r), { total: 1, visible: 0, missing: ["ctrlA"] });
});

test("requiredVisibleStatus: none visible → visible 0, all missing (scene prefix on either side is stripped)", () => {
  const objLoc = new Map([
    ["a", "StarChef:/Canvas/PanelA/A"], // contract locator carries a scene
    ["b", "/Canvas/PanelA/B"],
  ]);
  const r = rects([
    { locator: { path: "StarChef:/Canvas/PanelA/A" }, isVisible: false }, // dump path also scene-prefixed
    { locator: { path: "/Canvas/PanelA/B" }, isVisible: false },
  ]);
  const out = requiredVisibleStatus(["a", "b"], objLoc, r);
  assert.equal(out.visible, 0);
  assert.deepEqual(out.missing, ["a", "b"]);
  // And when they ARE visible, the scene-stripped paths match regardless of prefix on either side.
  const rVis = rects([
    { locator: { path: "/Canvas/PanelA/A" }, isVisible: true }, // dump path bare, contract prefixed
    { locator: { path: "StarChef:/Canvas/PanelA/B" }, isVisible: true }, // dump prefixed, contract bare
  ]);
  assert.deepEqual(requiredVisibleStatus(["a", "b"], objLoc, rVis), { total: 2, visible: 2, missing: [] });
});

test("planCaptureFromTrace: visibility-windowed per-state capture — each active state gets a WINDOW over its OWN screen's gated gestures (no derived reached)", () => {
  const contract = multiActiveContract();
  const t = trace([
    wcond("Phase1"), // 0
    drag("/Canvas/PanelA/CtrlA", "/Canvas/PanelA/Zone"), // 1 → screenA (panel /Canvas/PanelA)
    wcond("Phase2"), // 2
    drag("/Canvas/PanelB/CtrlB", "/Canvas/PanelB/Zone"), // 3 → screenB (panel /Canvas/PanelB)
  ]);
  const plan = planCaptureFromTrace(contract, t);
  const byId = Object.fromEntries(plan.states.map((s) => [s.stateId, s]));
  // Each active state gets a window over ITS panel's gated gestures — a single-gesture panel
  // collapses to start === end. NOT a single shared trigger.
  assert.deepEqual(byId.screenA.trigger, { kind: "window", start: 1, end: 1 });
  assert.deepEqual(byId.screenB.trigger, { kind: "window", start: 3, end: 3 });
  assert.notDeepEqual(byId.screenA.trigger, byId.screenB.trigger);
  // Window states use VISIBILITY (decided live), not a derived phase reached — they keep the
  // contract's (here unset) state.reached.
  assert.equal(byId.screenA.reached, undefined);
  assert.equal(byId.screenB.reached, undefined);
  // requiredInFrame is carried for the loop's visibility scan.
  assert.deepEqual(byId.screenA.requiredInFrame, ["ctrlA", "home"]);
});

test("planCaptureFromTrace: a multi-gesture screen gets a window spanning its FIRST and LAST gated gestures", () => {
  // decorate-shape: two gated gestures on the SAME panel (doneButton appears mid-screen) → the
  // window spans first..last so the loop can find the moment all required objects are co-visible.
  const contract = multiActiveContract();
  const t = trace([
    wcond("Phase1"), // 0
    drag("/Canvas/PanelA/CtrlA", "/Canvas/PanelA/Zone"), // 1 → screenA first gated gesture
    wcond("Phase1b"), // 2
    drag("/Canvas/PanelA/CtrlA", "/Canvas/PanelA/Zone2"), // 3 → screenA again (same panel)
    wcond("Phase2"), // 4
    drag("/Canvas/PanelB/CtrlB", "/Canvas/PanelB/Zone"), // 5 → screenB
  ]);
  const byId = Object.fromEntries(planCaptureFromTrace(contract, t).states.map((s) => [s.stateId, s]));
  assert.deepEqual(byId.screenA.trigger, { kind: "window", start: 1, end: 3 });
  assert.deepEqual(byId.screenB.trigger, { kind: "window", start: 5, end: 5 });
});

test("planCaptureFromTrace: persistent chrome never outvotes a single-control screen's panel (tie-break hardening)", () => {
  const base = buildScaffoldContract("g");
  const contract: MinigameContract = {
    ...base,
    requiredInFrame: [
      { id: "home", locator: "/Canvas/HomeButton", description: "" }, // chrome (depth 2) listed FIRST
      { id: "ctrlA", locator: "/Canvas/PanelA/CtrlA", description: "" }, // the only real screen control
    ],
    states: [
      { id: "only", kind: "active", scene: base.scenes[0], requiredInFrame: ["home", "ctrlA"], description: "" },
      { id: "success_reward", kind: "success_reward", scene: base.scenes[0], requiredInFrame: ["home"], description: "" },
    ],
    interactionFlow: { happyPath: ["only", "success_reward"] },
  };
  const t = trace([wcond("P"), drag("/Canvas/PanelA/CtrlA", "/Canvas/PanelA/Zone")]);
  const only = planCaptureFromTrace(contract, t).states.find((s) => s.stateId === "only")!;
  // Chrome at /Canvas/HomeButton (depth 2) must NOT win the tie and strand the state on the
  // legacy fallback — the real panel gives the state a visibility window.
  assert.deepEqual(only.trigger, { kind: "window", start: 1, end: 1 });
});

test("planCaptureFromTrace: no state-signal gates → active states keep the legacy single activeTrigger (regression)", () => {
  const contract = multiActiveContract();
  const t = trace([
    drag("/Canvas/PanelA/CtrlA", "/Canvas/PanelA/Zone"),
    drag("/Canvas/PanelB/CtrlB", "/Canvas/PanelB/Zone"),
  ]);
  const plan = planCaptureFromTrace(contract, t);
  const byId = Object.fromEntries(plan.states.map((s) => [s.stateId, s]));
  // Without gates the per-state windowing never kicks in: both active states share the one
  // legacy activeTrigger and carry no derived reached — byte-for-byte the old behavior.
  assert.equal(byId.screenA.trigger.kind, "after-action");
  assert.deepEqual(byId.screenA.trigger, byId.screenB.trigger);
  assert.equal(byId.screenA.reached, undefined);
  assert.equal(byId.screenB.reached, undefined);
});

test("planCaptureFromTrace (hub→game start-screen PRELUDE): active anchors on the gameplay-entering tap, start on the game's own screen — not the hub", () => {
  // The hub-and-minigames shape (e.g. GameHub / ShapeMatch): hub-tile tap → the game's start screen → gameplay.
  // The OLD planner anchored active on the first tap (the hub tile) and start on {initial} (the
  // hub), so both collapsed onto the hub mid-transition (the P0 bug). The (wait,tap) pairing per
  // segment mirrors the real recorder so the start anchor lands on the screen-confirming wait.
  const contract = buildScaffoldContract("g");
  const t = trace([
    wait("/Canvas/Tiles/Tile_ShapeMatch"),       // 0
    tap("/Canvas/Tiles/Tile_ShapeMatch"),         // 1: hub→game NAV (skip)
    wait("/Canvas/StartScreen/StartButton"),      // 2: confirms the game's start screen loaded
    tap("/Canvas/StartScreen/StartButton"),       // 3: ENTERS gameplay (active anchor)
    wait("/Canvas/GameplayRoot/Answers/AnswerButton2"), // 4
    tap("/Canvas/GameplayRoot/Answers/AnswerButton2"),  // 5: gameplay tap
  ]);
  const plan = planCaptureFromTrace(contract, t);
  const byId = Object.fromEntries(plan.states.map((s) => [s.stateId, s.trigger]));
  // start = after the wait that confirms the StartScreen (index 2), NOT {initial} (the hub).
  assert.deepEqual(byId.start, { kind: "after-action", index: 2 });
  // active = after the StartButton tap (index 3), NOT after the hub-tile tap (index 1).
  assert.deepEqual(byId.active, { kind: "after-action", index: 3 });
  // The liveness stimulus is the first gameplay tap AFTER the active anchor (the answer tap).
  const stim = planResponseStimulus(contract, plan);
  assert.equal(stim?.stimulusIndex, 5);
  assert.equal(stim?.stimulusTarget, "/Canvas/GameplayRoot/Answers/AnswerButton2");
});

test("planCaptureFromTrace (hub→gameplay, NO start screen — the chef shape): active after the hub-tile tap, start stays {initial}", () => {
  // One nav tap straight into gameplay (a drag). Gameplay scope differs from the tile's, so the
  // tile IS the entry tap — identical to the pre-prelude behaviour (no regression for chef).
  const contract = buildScaffoldContract("g");
  const t: ReplayTrace = {
    schemaVersion: "0.1",
    id: "chef-happy-path",
    start: { scene: "Assets/Scenes/GameHub.unity", reset: "scene-load" },
    input: { backend: "ui-events" },
    segments: [
      { id: "s1", actions: [wait("/Canvas/Tiles/Tile_StarChef"), tap("/Canvas/Tiles/Tile_StarChef")] },
      { id: "s2", actions: [{ do: "drag", from: { path: "/Canvas/MixPanel/Ingredient_milk" }, to: { path: "/Canvas/MixPanel/MixZone" } } as Action] },
    ],
    outcome: { expected: "success" },
  };
  const plan = planCaptureFromTrace(contract, t);
  const byId = Object.fromEntries(plan.states.map((s) => [s.stateId, s.trigger]));
  assert.deepEqual(byId.start, { kind: "initial" }, "no own start screen → the hub IS the start frame");
  assert.deepEqual(byId.active, { kind: "after-action", index: 1 }, "after the hub-tile tap (the drag enters gameplay)");
});

// ── multi-scene (D3 — graded entry scene) ────────────────────────────────────

/** A trace whose segments carry per-segment scene evidence (a runtime scene name, or none). */
function mtrace(
  segs: { scene?: string; actions: Action[] }[],
  startScene = "Assets/Scenes/Home.unity",
): ReplayTrace {
  return {
    schemaVersion: "0.1",
    id: "ms-happy-path",
    start: { scene: startScene, reset: "scene-load" },
    input: { backend: "ui-events" },
    segments: segs.map((s, i) => ({ id: `seg-${i + 1}`, actions: s.actions, ...(s.scene ? { scene: s.scene } : {}) })),
    outcome: { expected: "success" },
  };
}

/** A fused hub→game contract shape (as `mergeSceneContracts` produces): scene-tagged, namespaced
 *  ids, two `active` states (the hub + the game) plus per-scene `success_reward`. */
function fusedHubGameContract(): MinigameContract {
  const base = buildScaffoldContract("g");
  return {
    ...base,
    scenes: ["Assets/Scenes/Home.unity", "Assets/Scenes/StarChef.unity"],
    requiredInFrame: [
      { id: "home__tileStarChef", locator: "Home:/Canvas/Tiles/Tile_StarChef", description: "" },
      { id: "home__homeBtn", locator: "Home:/Canvas/HomeButton", description: "" },
      { id: "starChef__mixZone", locator: "StarChef:/Canvas/MixPanel/MixZone", description: "" },
      { id: "starChef__homeBtn", locator: "StarChef:/Canvas/HomeButton", description: "" },
      { id: "starChef__score", locator: "StarChef:/Canvas/RewardPanel/Score", description: "" },
    ],
    states: [
      { id: "home__active", kind: "active", scene: "Home", requiredInFrame: ["home__tileStarChef", "home__homeBtn"], description: "" },
      { id: "home__success_reward", kind: "success_reward", scene: "Home", description: "" },
      { id: "starChef__active", kind: "active", scene: "StarChef", requiredInFrame: ["starChef__mixZone", "starChef__homeBtn"], description: "" },
      { id: "starChef__success_reward", kind: "success_reward", scene: "StarChef", requiredInFrame: ["starChef__score"], description: "" },
    ],
    interactionFlow: { happyPath: ["home__active", "home__success_reward", "starChef__active", "starChef__success_reward"] },
  };
}

/** The canonical linear home → StarChef playthrough (per-segment scene evidence). */
function hubGameTrace(): ReplayTrace {
  return mtrace([
    { scene: "Home", actions: [wait("/Canvas/Tiles/Tile_StarChef"), tap("/Canvas/Tiles/Tile_StarChef")] }, // 0,1 (1 = scene-exit)
    {
      scene: "StarChef",
      actions: [
        wait("/Canvas/MixPanel/MixZone"), // 2: confirms StarChef loaded
        drag("/Canvas/MixPanel/Ingredient", "/Canvas/MixPanel/MixZone"), // 3: enters gameplay
        tap("/Canvas/MixPanel/CookButton"), // 4: gameplay tap
        tap("/Canvas/HomeButton"), // 5: home/back
      ],
    },
  ]);
}

test("actionSceneSlugs: per-action slugs, carry-forward across an evidence-less middle segment", () => {
  const t = mtrace([
    { scene: "Home", actions: [tap("/a")] }, // 0 → home
    { actions: [tap("/b")] }, // 1 → carry-forward home
    { scene: "StarChef", actions: [tap("/c")] }, // 2 → star-chef
  ]);
  assert.deepEqual(actionSceneSlugs(t), ["home", "home", "star-chef"]);
});

test("actionSceneSlugs: a multi-action segment expands to N identical slugs", () => {
  const t = mtrace([{ scene: "StarChef", actions: [tap("/a"), tap("/b"), tap("/c")] }]);
  assert.deepEqual(actionSceneSlugs(t), ["star-chef", "star-chef", "star-chef"]);
});

test("actionSceneSlugs: no evidence anywhere → every action falls back to the start.scene slug", () => {
  const t = mtrace([{ actions: [tap("/a")] }, { actions: [tap("/b")] }], "Assets/Scenes/G.unity");
  assert.deepEqual(actionSceneSlugs(t), ["g", "g"]);
});

test("actionSceneSlugs: leading evidence-less actions take the first EVIDENCED runtime name, not the start.scene PATH basename", () => {
  // start.scene basename slug is `home-scene`, but the recorded runtime name is `Home` → the entry
  // actions must reconcile to `home` (the space `state.scene` lives in), closing the name↔path hole.
  const t = mtrace(
    [
      { actions: [tap("/Canvas/Tiles/Tile_StarChef")] }, // 0: evidence-less leading action
      { scene: "Home", actions: [tap("/Canvas/Tiles/Tile_StarChef")] }, // 1
      { scene: "StarChef", actions: [drag("/Canvas/MixPanel/I", "/Canvas/MixPanel/MixZone")] }, // 2
    ],
    "Assets/Scenes/HomeScene.unity",
  );
  assert.equal(actionSceneSlugs(t)[0], "home");
});

test("planCaptureFromTrace (multi-scene): the entry/hub active anchors on its OWN idle frame, NOT the gameplay frame (D3 core)", () => {
  const plan = planCaptureFromTrace(fusedHubGameContract(), hubGameTrace());
  const byId = Object.fromEntries(plan.states.map((s) => [s.stateId, s.trigger]));
  // The hub is graded at its settled idle frame ({initial}); gameplay active is anchored inside the
  // StarChef range — the two NEVER collapse onto one trigger (the bug this fixes).
  assert.deepEqual(byId.home__active, { kind: "initial" });
  assert.deepEqual(byId.starChef__active, { kind: "after-action", index: 3 });
  assert.notDeepEqual(byId.home__active, byId.starChef__active);
});

test("planCaptureFromTrace (multi-scene): the scene-exit nav tap's after-frame is never an anchor for an entry-scene state", () => {
  const plan = planCaptureFromTrace(fusedHubGameContract(), hubGameTrace());
  const homeStates = plan.states.filter((s) => s.stateId.startsWith("home__"));
  // index 1 is the hub-tile tap that LEAVES Home (the scene-load transition) — no Home state may
  // anchor on its after-frame.
  for (const s of homeStates) {
    assert.ok(
      !(s.trigger.kind === "after-action" && s.trigger.index === 1),
      `${s.stateId} must not anchor on the scene-load transition tap`,
    );
  }
});

test("planCaptureFromTrace (multi-scene): an entry-scene reward placeholder with no in-scene anchor is unreached, never on a game frame", () => {
  const plan = planCaptureFromTrace(fusedHubGameContract(), hubGameTrace());
  const byId = Object.fromEntries(plan.states.map((s) => [s.stateId, s.trigger]));
  // Home has no Home/Back tap and isn't the final screen → its scaffold success_reward is honestly
  // unreached (NOT before-action 5, which is StarChef's home tap).
  assert.equal(byId.home__success_reward.kind, "unreached");
  assert.ok(plan.unreached.some((u) => u.stateId === "home__success_reward"));
  // The GAME's reward still anchors before the in-scene home tap (index 5).
  assert.deepEqual(byId.starChef__success_reward, { kind: "before-action", index: 5 });
});

test("planResponseStimulus (multi-scene): picks the GAMEPLAY active's first tap, not the {initial}-anchored hub (BUG-1 guard)", () => {
  const contract = fusedHubGameContract();
  const plan = planCaptureFromTrace(contract, hubGameTrace());
  const stim = planResponseStimulus(contract, plan);
  assert.equal(stim?.stateId, "starChef__active");
  assert.equal(stim?.stimulusIndex, 4); // the gameplay CookButton tap after the active anchor (3)
  assert.equal(stim?.stimulusTarget, "/Canvas/MixPanel/CookButton");
});

test("planCaptureFromTrace (multi-scene): a state whose scene the trace never visited is unreached, never mis-anchored", () => {
  const contract = fusedHubGameContract();
  contract.scenes = [...contract.scenes, "Assets/Scenes/ShapeMatch.unity"];
  contract.states = [
    ...contract.states,
    { id: "shapeMatch__active", kind: "active", scene: "ShapeMatch", requiredInFrame: ["starChef__mixZone"], description: "" },
  ];
  contract.interactionFlow.happyPath = [...contract.interactionFlow.happyPath, "shapeMatch__active"];
  const byId = Object.fromEntries(planCaptureFromTrace(contract, hubGameTrace()).states.map((s) => [s.stateId, s.trigger]));
  assert.equal(byId.shapeMatch__active.kind, "unreached");
});

test("planCaptureFromTrace: a single-scene contract with one scene + no segment evidence keeps the legacy global path (regression)", () => {
  // state.scene set (one slug) and no per-segment evidence → NOT multi → byte-identical to pre-D3.
  const contract = buildScaffoldContract("g");
  const t = trace([wait("/HUD/StartScreen/StartButton"), tap("/HUD/StartScreen/StartButton"), tap("/HUD/HomeButton")]);
  const byId = Object.fromEntries(planCaptureFromTrace(contract, t).states.map((s) => [s.stateId, s.trigger]));
  assert.deepEqual(byId.active, { kind: "after-action", index: 1 });
  assert.deepEqual(byId.home_back, { kind: "after-action", index: 2 });
});

test("planCaptureFromTrace: an outcome-gated state is NOT captured — surfaced as unreached (by design)", () => {
  const contract = buildScaffoldContract("g");
  // Mark success_reward outcome-gated (read-only can't drive the win on a randomized game).
  const sr = contract.states.find((s) => s.kind === "success_reward")!;
  (sr as { outcomeGated?: boolean }).outcomeGated = true;
  const t = trace([
    wait("/HUD/StartScreen/StartButton"),
    tap("/HUD/StartScreen/StartButton"),
    tap("/HUD/AnswerButton0"),
  ]);
  const plan = planCaptureFromTrace(contract, t);
  const byId = Object.fromEntries(plan.states.map((s) => [s.stateId, s.trigger]));
  assert.equal(byId.success_reward.kind, "unreached");
  const u = plan.unreached.find((x) => x.stateId === "success_reward");
  assert.ok(u, "success_reward is in unreached");
  assert.equal(u!.outcomeGated, true, "flagged outcome-gated, not a trace gap");
  assert.match(u!.reason, /outcome-gated/i);
});

test("planCaptureFromTrace carries optional state.reached conditions without changing states that omit it", () => {
  const contract = buildScaffoldContract("g");
  const active = contract.states.find((s) => s.id === "active")!;
  active.reached = {
    locator: "G:/Canvas/GameManager",
    component: "GameManager",
    property_path: "phase",
    operator: "equals",
    expected: "Active",
    timeoutMs: 1234,
  };
  const t = trace([
    wait("/HUD/StartScreen/StartButton"),
    tap("/HUD/StartScreen/StartButton"),
  ]);
  const plan = planCaptureFromTrace(contract, t);
  assert.equal(plan.states.find((s) => s.stateId === "start")?.reached, undefined);
  assert.deepEqual(plan.states.find((s) => s.stateId === "active")?.reached, active.reached);
});

test("buildCaptureSummary: splits OUTCOME-GATED (by design) from trace-gap; nudge gates ONLY gateable kinds", () => {
  const sp = (stateId: string, kind: string): { stateId: string; kind: string; trigger: { kind: "unreached"; reason: string } } =>
    ({ stateId, kind, trigger: { kind: "unreached", reason: "x" } });
  const plan: CapturePlan = {
    states: [sp("success_reward", "success_reward"), sp("home_back", "home_back"), sp("active", "active")] as CapturePlan["states"],
    flatActions: [],
    unreached: [
      { stateId: "success_reward", reason: "outcome-gated — read-only can't drive its outcome", outcomeGated: true },
      { stateId: "home_back", reason: "the recorded trace never taps a Home/Back control" }, // gateable kind
      { stateId: "active", reason: "the recorded trace never taps a control to start the game" }, // NOT gateable
    ],
  };
  const out = buildCaptureSummary(["start"], plan, "captures", "g.minigame.json", ".").join("\n");
  // Gated bucket (by design), trace-gap bucket (fix the recording) — both present.
  assert.match(out, /outcome-gated \(by design/i);
  assert.match(out, /not asserted .* outcome-gated/i);
  assert.match(out, /never reaches these screens \(fix the recording/);
  // The gating nudge suggests home_back (gateable kind) but NEVER active (deterministic).
  assert.match(out, /--outcome-gated home_back\b/);
  assert.doesNotMatch(out, /--outcome-gated[^\n]*\bactive\b/, "must NOT suggest gating the deterministic active screen");
});

test("planResponseStimulus: the first gameplay UI tap after the active anchor is the stimulus", () => {
  const contract = buildScaffoldContract("g");
  const t = trace([
    wait("/HUD/StartScreen/StartButton"),
    tap("/HUD/StartScreen/StartButton"), // 1: active anchor (first tap)
    worldTap("/Spawner/Apple_0"), // 2: world-tap (not a ui-dispatch) — skipped
    tap("/HUD/AnswerButton1"), // 3: first gameplay UI tap → stimulus
  ]);
  const stim = planResponseStimulus(contract, planCaptureFromTrace(contract, t));
  assert.equal(stim?.stateId, "active");
  assert.equal(stim?.stimulusIndex, 3);
  assert.equal(stim?.stimulusTarget, "/HUD/AnswerButton1");
});

test("planResponseStimulus: null when no gameplay tap follows the active anchor", () => {
  const contract = buildScaffoldContract("g");
  const t = trace([wait("/HUD/StartScreen/StartButton"), tap("/HUD/StartScreen/StartButton")]);
  assert.equal(planResponseStimulus(contract, planCaptureFromTrace(contract, t)), null);
});

test("toResponseDoc + changedObjectIds: builds before/after with stable ids; detects the change", () => {
  const before: RawScreenObject[] = [{ locator: { path: "/HUD/Question" }, role: "text", active: true, isVisible: true, isFullyVisible: true, text: "How many apples?" }];
  const after: RawScreenObject[] = [{ locator: { path: "/HUD/Question" }, role: "text", active: true, isVisible: true, isFullyVisible: true, text: "How many pears?" }];
  const doc = toResponseDoc({ objects: before }, { objects: after }, "/HUD/AnswerButton0");
  assert.equal(doc.tap, "/HUD/AnswerButton0");
  assert.equal(doc.before.objects[0].id, objectIdFromPath("/HUD/Question"));
  assert.deepEqual(changedObjectIds(doc.before.objects, doc.after.objects), [objectIdFromPath("/HUD/Question")]);
});

test("buildCaptureSummary: SUGGESTS an input-response from what changed (honest, never auto-applied)", () => {
  const plan: CapturePlan = { states: [], flatActions: [], unreached: [] };
  const out = buildCaptureSummary(
    ["start", "active"], plan, "captures", "g.minigame.json", ".",
    { stateId: "active", tap: "/HUD/AnswerButton0", changed: ["question", "score"] },
  ).join("\n");
  assert.match(out, /Liveness/);
  // tapId = objectIdFromPath("/HUD/AnswerButton0") = "answerButton0"; observe = the changed ids.
  assert.match(out, /--input-response active:answerButton0:question,score/);
  assert.match(out, /PERSISTENT claim/); // it's a persistent claim, re-checked every capture
  assert.match(out, /KEEP only what SHOULD change/); // tells the dev to trim — not a rubber-stamp
});

test("summarizeChangedIds: a big same-base set collapses to one representative (never dropped)", () => {
  const confetti = Array.from({ length: 44 }, (_, i) => `confetti${i}`);
  const { suggested, collapsed } = summarizeChangedIds(["check-9c644a", ...confetti, "question"]);
  // Singletons in full + ONE confetti representative — the signal is kept, not dropped.
  assert.deepEqual(suggested, ["check-9c644a", "confetti0", "question"]);
  assert.deepEqual(collapsed, [{ base: "confetti", count: 44, rep: "confetti0" }]);
});

test("summarizeChangedIds: a SMALL same-base set (a 4-choice quiz) stays fully expanded", () => {
  // The canonical kids-game shape — answer buttons changing IS the response; must NOT collapse.
  const { suggested, collapsed } = summarizeChangedIds(["answerButton0", "answerButton1", "answerButton2", "answerButton3"]);
  assert.deepEqual(suggested, ["answerButton0", "answerButton1", "answerButton2", "answerButton3"]);
  assert.equal(collapsed.length, 0);
});

test("buildCaptureSummary: liveness suggestion compacts a confetti burst (no 44-item wall, signal kept)", () => {
  const plan: CapturePlan = { states: [], flatActions: [], unreached: [] };
  const confetti = Array.from({ length: 44 }, (_, i) => `confetti${i}`);
  const out = buildCaptureSummary(
    ["active"], plan, "captures", "g.minigame.json", ".",
    { stateId: "active", tap: "/HUD/AnswerButton1", changed: ["check-9c644a", ...confetti] },
  ).join("\n");
  // Command carries the meaningful singleton + ONE confetti representative — NOT all 44.
  assert.match(out, /--input-response active:answerButton1:check-9c644a,confetti0\b/);
  assert.doesNotMatch(out, /confetti43/);
  // The collapse is disclosed (count + representative), not silently dropped or mislabeled.
  assert.match(out, /44×'confetti…' shown as confetti0/);
});

test("buildCaptureSummary: a large bulk response (16 tiles) is collapsed to a rep, still SUGGESTED (not called incidental)", () => {
  const plan: CapturePlan = { states: [], flatActions: [], unreached: [] };
  const tiles = Array.from({ length: 16 }, (_, i) => `tile${i}`);
  const out = buildCaptureSummary(
    ["active"], plan, "captures", "g.minigame.json", ".",
    { stateId: "active", tap: "/HUD/Board", changed: tiles },
  ).join("\n");
  // A real bulk response must still produce a usable command (representative), and must NOT be
  // mislabeled "only incidental particles" (the old behavior that dropped it).
  assert.match(out, /--input-response active:board:tile0\b/);
  assert.match(out, /16×'tile…' shown as tile0/);
  assert.doesNotMatch(out, /only incidental particles/);
});

test("buildCaptureSummary: no observable change → flags a possible liveness issue, NO suggestion", () => {
  const plan: CapturePlan = { states: [], flatActions: [], unreached: [] };
  const out = buildCaptureSummary(
    ["active"], plan, "captures", "g.minigame.json", ".",
    { stateId: "active", tap: "/HUD/AnswerButton0", changed: [] },
  ).join("\n");
  assert.match(out, /changed nothing observable/);
  assert.doesNotMatch(out, /--input-response/);
});

// ── perDeviceKey + multi-aspect summary (Phase 3) ────────────────────────────

test("perDeviceKey: builds the filename-safe `<state>@<device>` artifact stem", () => {
  assert.equal(perDeviceKey("start", "landscape-16x9"), "start@landscape-16x9");
  assert.equal(perDeviceKey("round-1-active", "portrait-iphone"), "round-1-active@portrait-iphone");
  // The key is the stem the live drive uses for both `<key>.png` and `<key>.ui-rects.json`.
  assert.equal(`${perDeviceKey("active", "tablet-l-4x3")}.png`, "active@tablet-l-4x3.png");
});

test("buildCaptureSummary: a multi-device capture notes the device breadth + per-device stems, keeps legacy artifacts", () => {
  const plan: CapturePlan = { states: [], flatActions: [], unreached: [] };
  const devices: DeviceSpec[] = [
    { id: "landscape-16x9", label: "16:9", width: 1280, height: 720 },
    { id: "landscape-iphone", label: "iPhone (19.5:9)", width: 2556, height: 1179 },
    { id: "landscape-android-tall", label: "Tall Android (20:9)", width: 2400, height: 1080 },
  ];
  const out = buildCaptureSummary(["start", "active"], plan, "captures", "g.minigame.json", ".", undefined, devices).join("\n");
  // Header notes the per-device breadth.
  assert.match(out, /Captured 2 screen\(s\) × 3 devices/);
  // The LEGACY single-aspect artifacts are still listed (verify reads them until Phase 4).
  assert.match(out, /start\.png, start\.ui-rects\.json, start\.console\.json/);
  // …alongside the per-device stems (`<state>@<device>.png`) for every device.
  assert.match(out, /start@landscape-16x9\.png/);
  assert.match(out, /active@landscape-android-tall\.png/);
});

test("buildCaptureSummary: with no devices passed, falls back to the single-aspect listing (no device note)", () => {
  const plan: CapturePlan = { states: [], flatActions: [], unreached: [] };
  const out = buildCaptureSummary(["start"], plan, "captures", "g.minigame.json", ".").join("\n");
  assert.match(out, /Captured 1 screen\(s\) →/);
  assert.doesNotMatch(out, /× \d+ devices/);
  assert.doesNotMatch(out, /start@/);
});

// ── background-coverage suggest-and-confirm (Phase 2) ─────────────────────────

const aabb = (minX: number, maxX: number): BackgroundCandidates["recommended"][number]["aabb"] =>
  ({ min: { x: minX, y: -5 }, max: { x: maxX, y: 5 } });

test("buildCaptureSummary: SUGGESTS the background binding (camera + layers + per-device coverage + decorative excluded), gate not yet bound", () => {
  const plan: CapturePlan = { states: [], flatActions: [], unreached: [] };
  const candidates: BackgroundCandidates = {
    camera: { locator: "Game:/Main Camera", name: "Main Camera", orthographic: true, orthoSize: 5, position: { x: 0, y: 0 } },
    cameras: [{ locator: "Game:/Main Camera", name: "Main Camera", orthographic: true, orthoSize: 5, position: { x: 0, y: 0 } }],
    recommended: [
      { locator: "Game:/Sky", name: "Sky", aabb: aabb(-12, 12), widestFraction: 1, fullWidthBand: true },
      { locator: "Game:/Hills", name: "Hills", aabb: aabb(-12, 12), widestFraction: 1, fullWidthBand: true },
    ],
    excluded: [
      { locator: "Game:/Cloud", name: "Cloud", reason: "decorative: covers 20% of the frame, not a full-width band" },
      { locator: "Game:/Bird", name: "Bird", reason: "decorative: covers 5% of the frame, not a full-width band" },
    ],
    allLayers: [
      { locator: "Game:/Sky", aabb: aabb(-12, 12) },
      { locator: "Game:/Hills", aabb: aabb(-12, 12) },
      { locator: "Game:/Cloud", aabb: aabb(-2, 2) },
      { locator: "Game:/Bird", aabb: aabb(-1, 1) },
    ],
    coverageByDevice: [
      { deviceId: "landscape-16x9", label: "16:9", fraction: 1, gapEdges: [] },
      { deviceId: "landscape-android-tall", label: "Tall Android (20:9)", fraction: 0.92, gapEdges: ["top"] },
    ],
    warnings: [],
  };
  const out = buildCaptureSummary(["start", "active"], plan, "captures", "g.minigame.json", ".", undefined, undefined, candidates, false).join("\n");
  // Names the camera + lists the recommended layer names. Wording must NOT claim depth ("behind"):
  // the classification is width/coverage-based with no sortingOrder/Z signal.
  assert.match(out, /Background — found 2 full-frame layer\(s\) covering Main Camera's view \(Sky, Hills\)/);
  assert.doesNotMatch(out, /behind Main Camera/);
  // Per-device coverage including a "(gap …)" for the <100% device.
  assert.match(out, /16:9 100%/);
  assert.match(out, /Tall Android \(20:9\) 92% \(gap top\)/);
  // Decorative excluded are listed.
  assert.match(out, /Decorative excluded: Cloud, Bird\./);
  // Emits the --background auto confirm command.
  assert.match(out, /loombridge minigame finalize --contract g\.minigame\.json --captures captures --background auto/);
});

test("buildCaptureSummary: a recommended set that's <100% on the wide device warns the gate will FAIL there, still shows --background auto", () => {
  const plan: CapturePlan = { states: [], flatActions: [], unreached: [] };
  const candidates: BackgroundCandidates = {
    camera: { locator: "Game:/Main Camera", name: "Main Camera", orthographic: true, orthoSize: 5, position: { x: 0, y: 0 } },
    cameras: [{ locator: "Game:/Main Camera", name: "Main Camera", orthographic: true, orthoSize: 5, position: { x: 0, y: 0 } }],
    recommended: [{ locator: "Game:/Sky", name: "Sky", aabb: aabb(-9.6, 9.6), widestFraction: 0.86, fullWidthBand: false }],
    excluded: [],
    allLayers: [{ locator: "Game:/Sky", aabb: aabb(-9.6, 9.6) }],
    coverageByDevice: [
      { deviceId: "landscape-16x9", label: "16:9", fraction: 1, gapEdges: [] },
      { deviceId: "landscape-android-tall", label: "Tall Android (20:9)", fraction: 0.86, gapEdges: ["left", "right"] },
    ],
    warnings: [],
  };
  const out = buildCaptureSummary(["start"], plan, "captures", "g.minigame.json", ".", undefined, undefined, candidates, false).join("\n");
  // The honest reframe: enabling the gate will FAIL on the gapped device(s) until the art covers the frame.
  assert.match(out, /These layers leave a gap on Tall Android \(20:9\) — enabling the gate will FAIL until the background art covers the frame \(that is the check doing its job\)\./);
  // Only the <100% device is named (16:9 is fully covered).
  assert.doesNotMatch(out, /gap on .*16:9/);
  // The recommendation is NOT suppressed — the --background auto command still shows.
  assert.match(out, /--background auto/);
});

test("buildCaptureSummary: gate ALREADY bound → NO 🎨 background block (capture wrote real background.json instead)", () => {
  const plan: CapturePlan = { states: [], flatActions: [], unreached: [] };
  const candidates: BackgroundCandidates = {
    camera: { locator: "Game:/Main Camera", name: "Main Camera", orthographic: true, orthoSize: 5, position: { x: 0, y: 0 } },
    cameras: [{ locator: "Game:/Main Camera", name: "Main Camera", orthographic: true, orthoSize: 5, position: { x: 0, y: 0 } }],
    recommended: [{ locator: "Game:/Sky", name: "Sky", aabb: aabb(-12, 12), widestFraction: 1, fullWidthBand: true }],
    excluded: [],
    allLayers: [{ locator: "Game:/Sky", aabb: aabb(-12, 12) }],
    coverageByDevice: [{ deviceId: "landscape-16x9", label: "16:9", fraction: 1, gapEdges: [] }],
    warnings: [],
  };
  const out = buildCaptureSummary(["start"], plan, "captures", "g.minigame.json", ".", undefined, undefined, candidates, true).join("\n");
  assert.doesNotMatch(out, /Background — found/);
  assert.doesNotMatch(out, /--background auto/);
});

test("buildCaptureSummary: candidates with no camera but >1 orthographic cameras → one-line --background-camera advisory", () => {
  const plan: CapturePlan = { states: [], flatActions: [], unreached: [] };
  const candidates: BackgroundCandidates = {
    camera: undefined,
    cameras: [
      { locator: "Game:/CamA", name: "CamA", orthographic: true, orthoSize: 5, position: { x: 0, y: 0 } },
      { locator: "Game:/CamB", name: "CamB", orthographic: true, orthoSize: 5, position: { x: 0, y: 0 } },
    ],
    recommended: [],
    excluded: [],
    allLayers: [],
    coverageByDevice: [],
    warnings: ["2 orthographic cameras found"],
  };
  const out = buildCaptureSummary(["start"], plan, "captures", "g.minigame.json", ".", undefined, undefined, candidates, false).join("\n");
  assert.match(out, /2 orthographic cameras found; pass --background-camera <locator>/);
  assert.match(out, /Game:\/CamA, Game:\/CamB/);
  // It's only the disambiguation advisory — never the --background auto confirm.
  assert.doesNotMatch(out, /--background auto/);
});

test("buildCaptureSummary: NO 🎨 block when discovery is undefined, has no recommended layers, or found ≤1 camera (no-background game isn't nagged)", () => {
  const plan: CapturePlan = { states: [], flatActions: [], unreached: [] };
  // undefined candidates (discovery skipped).
  const noneOut = buildCaptureSummary(["start"], plan, "captures", "g.minigame.json", ".", undefined, undefined, undefined, false).join("\n");
  assert.doesNotMatch(noneOut, /Background —/);
  // A camera but no recommended layers, single orthographic camera → nothing to suggest.
  const emptyRec: BackgroundCandidates = {
    camera: { locator: "Game:/Main Camera", name: "Main Camera", orthographic: true, orthoSize: 5, position: { x: 0, y: 0 } },
    cameras: [{ locator: "Game:/Main Camera", name: "Main Camera", orthographic: true, orthoSize: 5, position: { x: 0, y: 0 } }],
    recommended: [],
    excluded: [],
    allLayers: [],
    coverageByDevice: [],
    warnings: ["no background layer qualified as a coverage band"],
  };
  const emptyOut = buildCaptureSummary(["start"], plan, "captures", "g.minigame.json", ".", undefined, undefined, emptyRec, false).join("\n");
  assert.doesNotMatch(emptyOut, /Background —/);
  // No camera at all, only a single orthographic candidate → not ambiguous, nothing to nag.
  const oneCam: BackgroundCandidates = {
    camera: undefined,
    cameras: [{ locator: "Game:/Cam", name: "Cam", orthographic: true, orthoSize: 5, position: { x: 0, y: 0 } }],
    recommended: [],
    excluded: [],
    allLayers: [],
    coverageByDevice: [],
    warnings: ["no background layer qualified"],
  };
  const oneCamOut = buildCaptureSummary(["start"], plan, "captures", "g.minigame.json", ".", undefined, undefined, oneCam, false).join("\n");
  assert.doesNotMatch(oneCamOut, /Background —/);
});

test("buildFlowEvidence: single actuation → actuation; multi → steps; trigger target set", () => {
  const flow = buildFlowEvidence([
    { from: "start", to: "active", actuations: [{ actuated: true, handlerTarget: "/HUD/StartButton" }] },
    {
      from: "active",
      to: "success_reward",
      actuations: [
        { actuated: true, handlerTarget: "/HUD/AnswerButton1" },
        { actuated: true, handlerTarget: "/HUD/AnswerButton0" },
      ],
    },
  ]);
  assert.equal(flow.transitions.length, 2);
  assert.equal(flow.transitions[0].trigger?.kind, "ui-dispatch");
  assert.equal(flow.transitions[0].trigger?.target, "/HUD/StartButton");
  assert.ok(flow.transitions[0].actuation, "single tap → actuation");
  assert.equal(flow.transitions[0].steps, undefined);
  assert.equal(flow.transitions[1].steps?.length, 2, "multi tap → steps[]");
  assert.equal(flow.transitions[1].actuation, undefined);
});
