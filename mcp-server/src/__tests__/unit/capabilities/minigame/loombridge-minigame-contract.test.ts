import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { REPO_ROOT as REPO_ROOT_SUPPORT } from "../../../_support/paths.js";

import {
  validateMinigameContract,
  assertValidMinigameContract,
} from "../../../../capabilities/minigame/profiles/validator.js";
import {
  EXAMPLE_MINIGAME_IDS,
  loadAllExampleMinigames,
  loadExampleMinigame,
} from "../../../../capabilities/minigame/profiles/profiles.js";
import {
  AGE_BANDS,
  MINIGAME_ADVISORY_CHECKS,
  MINIGAME_CONTRACT_SCHEMA_VERSION,
  MINIGAME_DETERMINISTIC_CHECKS,
  MINIGAME_DETERMINISTIC_CHECK_SET,
  VISUAL_PROFILES,
  resolveDevices,
  type DeviceSpec,
  type MinigameContract,
} from "../../../../capabilities/minigame/profiles/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.resolve(
  REPO_ROOT_SUPPORT,
  "mcp-server/src/domain/schemas/minigame-contract.schema.json",
);

// A minimal VALID contract we clone and corrupt for the negative tests.
function baseContract(): Record<string, unknown> {
  return {
    schemaVersion: MINIGAME_CONTRACT_SCHEMA_VERSION,
    id: "alphabet-pop",
    type: "2d-kids-minigame",
    scenes: ["Assets/Scenes/Game.unity"],
    ageBand: "3-5", // floor 80dp
    visualProfile: "tablet-landscape",
    requiredInFrame: [
      { id: "tile", locator: "Game:/Canvas/Tile" },
      { id: "home", locator: "Game:/Canvas/HUD/Home" },
    ],
    states: [
      { id: "start", kind: "start" },
      { id: "play", kind: "active", requiredInFrame: ["tile"] },
      { id: "win", kind: "success_reward" },
      { id: "back", kind: "home_back" },
    ],
    uiSafeAreas: { maxOverflowFraction: 0, insets: { top: 0.05, bottom: 0.05 } },
    tapTargets: { minSizeDp: 90 },
    interactionFlow: { happyPath: ["start", "play", "win", "back"] },
    artifactThresholds: { maxBorderFraction: 0.02, minContentCoverage: 0.9 },
    checks: { deterministic: ["required-in-frame", "safe-area"], advisory: ["vlm-readability"] },
  };
}

function codes(input: unknown): string[] {
  return validateMinigameContract(input).issues.map((i) => i.code);
}

function expectRefusal(input: unknown, code: string): void {
  const result = validateMinigameContract(input);
  assert.equal(result.valid, false, `expected contract to be refused with ${code}`);
  assert.ok(
    result.issues.some((i) => i.code === code),
    `expected a [${code}] issue; got: ${result.issues.map((i) => i.code).join(", ") || "(none)"}`,
  );
}

// ── happy path ────────────────────────────────────────────────────────────────

test("a minimal well-formed contract validates", () => {
  const result = validateMinigameContract(baseContract());
  assert.equal(result.valid, true, JSON.stringify(result.issues));
  assert.deepEqual(result.issues, []);
});

test("assertValidMinigameContract returns the contract for a valid input and throws otherwise", () => {
  const c = assertValidMinigameContract(baseContract());
  assert.equal(c.id, "alphabet-pop");
  assert.throws(() => assertValidMinigameContract({ schemaVersion: "1" }), /validation failed/i);
});

test("accepts a boolean state.outcomeGated; refuses a non-boolean", () => {
  const ok = baseContract();
  (ok.states as Array<Record<string, unknown>>)[2].outcomeGated = true; // the success_reward state
  assert.equal(validateMinigameContract(ok).valid, true, JSON.stringify(validateMinigameContract(ok).issues));

  const bad = baseContract();
  (bad.states as Array<Record<string, unknown>>)[2].outcomeGated = "yes";
  expectRefusal(bad, "INVALID_FIELD");
});

test("accepts a valid state.inputResponse; refuses unknown tap/observe ids + bad expect", () => {
  const ok = baseContract();
  (ok.checks as Record<string, unknown>).deterministic = ["required-in-frame", "input-response"];
  (ok.states as Array<Record<string, unknown>>)[1].inputResponse = { tap: "tile", observe: ["home"] };
  assert.equal(validateMinigameContract(ok).valid, true, JSON.stringify(validateMinigameContract(ok).issues));

  const badTap = baseContract();
  (badTap.states as Array<Record<string, unknown>>)[1].inputResponse = { tap: "nope", observe: ["home"] };
  expectRefusal(badTap, "UNKNOWN_STATE_OBJECT");

  const badObserve = baseContract();
  (badObserve.states as Array<Record<string, unknown>>)[1].inputResponse = { tap: "tile", observe: ["ghost"] };
  expectRefusal(badObserve, "UNKNOWN_STATE_OBJECT");

  const emptyObserve = baseContract();
  (emptyObserve.states as Array<Record<string, unknown>>)[1].inputResponse = { tap: "tile", observe: [] };
  expectRefusal(emptyObserve, "INVALID_FIELD");

  const badExpect = baseContract();
  (badExpect.states as Array<Record<string, unknown>>)[1].inputResponse = { tap: "tile", observe: ["home"], expect: "appeared" };
  expectRefusal(badExpect, "INVALID_FIELD");
});

test("stateSignal (G1): optional — absent valid; accepts a well-formed signal; refuses a malformed one", () => {
  // Absent ⇒ valid (the base contract has no stateSignal).
  assert.equal(validateMinigameContract(baseContract()).valid, true);

  // Well-formed (bare locator, component + property) ⇒ valid.
  const ok = baseContract();
  ok.stateSignal = { locator: "/Canvas/GameManager", component: "GameManager", property: "phase" };
  assert.equal(validateMinigameContract(ok).valid, true, JSON.stringify(validateMinigameContract(ok).issues));

  // Component is optional ⇒ valid without it.
  const noComp = baseContract();
  noComp.stateSignal = { locator: "/Canvas/GM", property: "phase" };
  assert.equal(validateMinigameContract(noComp).valid, true, JSON.stringify(validateMinigameContract(noComp).issues));

  // A locator containing ':' (a scene prefix) corrupts the --state-signal split ⇒ refused.
  const sceneLocator = baseContract();
  sceneLocator.stateSignal = { locator: "Game:/Canvas/GameManager", property: "phase" };
  expectRefusal(sceneLocator, "INVALID_STATE_SIGNAL");

  // Missing property ⇒ refused.
  const noProp = baseContract();
  noProp.stateSignal = { locator: "/Canvas/GM" };
  expectRefusal(noProp, "INVALID_STATE_SIGNAL");

  // Empty locator / non-object ⇒ refused.
  const emptyLoc = baseContract();
  emptyLoc.stateSignal = { locator: "", property: "phase" };
  expectRefusal(emptyLoc, "INVALID_STATE_SIGNAL");
  const notObject = baseContract();
  notObject.stateSignal = "phase";
  expectRefusal(notObject, "INVALID_STATE_SIGNAL");
});

test("accepts a valid state.reached condition; refuses malformed reached declarations", () => {
  const ok = baseContract();
  (ok.states as Array<Record<string, unknown>>)[1].reached = {
    locator: "Game:/Canvas/GameManager",
    component: "ChefGameManager",
    property_path: "phase",
    operator: "equals",
    expected: "Decorate",
    tolerance: 0.01,
    timeoutMs: 2500,
  };
  assert.equal(validateMinigameContract(ok).valid, true, JSON.stringify(validateMinigameContract(ok).issues));

  const missingPath = baseContract();
  (missingPath.states as Array<Record<string, unknown>>)[1].reached = {
    locator: "Game:/Canvas/GameManager",
    operator: "equals",
    expected: "Decorate",
  };
  expectRefusal(missingPath, "INVALID_REACHED_CONDITION");

  const badOperator = baseContract();
  (badOperator.states as Array<Record<string, unknown>>)[1].reached = {
    locator: "Game:/Canvas/GameManager",
    property_path: "phase",
    operator: "approximately",
    expected: "Decorate",
  };
  expectRefusal(badOperator, "INVALID_REACHED_CONDITION");

  const emptyLocator = baseContract();
  (emptyLocator.states as Array<Record<string, unknown>>)[1].reached = {
    locator: "",
    property_path: "phase",
    operator: "equals",
    expected: "Decorate",
  };
  expectRefusal(emptyLocator, "INVALID_REACHED_CONDITION");
});

test("refuses 'input-response' enabled but no state declares inputResponse (decides nothing)", () => {
  const c = baseContract();
  (c.checks as Record<string, unknown>).deterministic = ["required-in-frame", "input-response"];
  expectRefusal(c, "INPUT_RESPONSE_NO_BINDINGS");
  // ...and accepts once a state declares it.
  (c.states as Array<Record<string, unknown>>)[1].inputResponse = { tap: "tile", observe: ["home"] };
  assert.equal(validateMinigameContract(c).valid, true, JSON.stringify(validateMinigameContract(c).issues));
});

test("refuses a declared inputResponse when the input-response check is NOT enabled (silent skip)", () => {
  // The defined-but-not-wired footgun: declaring the liveness without enabling the check
  // would silently never grade it. Refuse both directions symmetrically.
  const c = baseContract(); // checks.deterministic has NO 'input-response'
  (c.states as Array<Record<string, unknown>>)[1].inputResponse = { tap: "tile", observe: ["home"] };
  expectRefusal(c, "INPUT_RESPONSE_DECLARED_NOT_ENABLED");
  // ...and accepts once the check is enabled.
  (c.checks as Record<string, unknown>).deterministic = ["required-in-frame", "input-response"];
  assert.equal(validateMinigameContract(c).valid, true, JSON.stringify(validateMinigameContract(c).issues));
});

// ── required refusals (S6a definition of done) ─────────────────────────────────

test("refuses missing states", () => {
  const c = baseContract();
  delete c.states;
  expectRefusal(c, "MISSING_STATES");
  expectRefusal({ ...baseContract(), states: [] }, "MISSING_STATES");
});

test("refuses missing required objects", () => {
  const c = baseContract();
  delete c.requiredInFrame;
  expectRefusal(c, "MISSING_REQUIRED_OBJECTS");
  expectRefusal({ ...baseContract(), requiredInFrame: [] }, "MISSING_REQUIRED_OBJECTS");
});

test("refuses an impossible age-band / tap-target setting", () => {
  // 3-5 requires a 80dp floor; 40dp is impossible for that age.
  const c = baseContract();
  c.tapTargets = { minSizeDp: 40 };
  expectRefusal(c, "IMPOSSIBLE_TAP_TARGET");
  // exactly at the floor is allowed.
  assert.equal(
    validateMinigameContract({ ...baseContract(), tapTargets: { minSizeDp: AGE_BANDS["3-5"].minTapTargetDp } }).valid,
    true,
  );
});

test("refuses unsupported deterministic AND advisory check names", () => {
  expectRefusal({ ...baseContract(), checks: { deterministic: ["safe-area", "teleport-check"] } }, "UNSUPPORTED_CHECK");
  expectRefusal(
    { ...baseContract(), checks: { deterministic: ["safe-area"], advisory: ["vibes-only"] } },
    "UNSUPPORTED_CHECK",
  );
});

test("refuses duplicate state ids", () => {
  const c = baseContract();
  c.states = [
    { id: "start", kind: "start" },
    { id: "start", kind: "active" },
    { id: "win", kind: "success_reward" },
  ];
  c.interactionFlow = { happyPath: ["start", "win"] };
  expectRefusal(c, "DUPLICATE_STATE_ID");
});

test("refuses invalid scene paths", () => {
  expectRefusal({ ...baseContract(), scenes: ["Assets/Scenes/Game.txt"] }, "INVALID_SCENE_PATH");
  expectRefusal({ ...baseContract(), scenes: ["../secrets/Game.unity"] }, "INVALID_SCENE_PATH");
  expectRefusal({ ...baseContract(), scenes: [] }, "MISSING_SCENES");
});

test("refuses scene paths with '..' traversal or backslashes (path safety)", () => {
  // The contract later drives scene loading/capture — a traversal path must not pass.
  expectRefusal({ ...baseContract(), scenes: ["Assets/../Game.unity"] }, "INVALID_SCENE_PATH");
  expectRefusal({ ...baseContract(), scenes: ["Assets/Foo/../Game.unity"] }, "INVALID_SCENE_PATH");
  expectRefusal({ ...baseContract(), scenes: ["Assets/Foo/../../etc/passwd.unity"] }, "INVALID_SCENE_PATH");
  expectRefusal({ ...baseContract(), scenes: ["Assets\\Scenes\\Game.unity"] }, "INVALID_SCENE_PATH");
  expectRefusal({ ...baseContract(), scenes: ["Assets/Scenes/./Game.unity"] }, "INVALID_SCENE_PATH");
});

test("refuses a contract with no deterministic checks", () => {
  expectRefusal({ ...baseContract(), checks: { deterministic: [] } }, "NO_DETERMINISTIC_CHECKS");
  const c = baseContract();
  delete c.checks;
  expectRefusal(c, "NO_DETERMINISTIC_CHECKS");
  // advisory-only is not enough — advisory never decides CI.
  expectRefusal({ ...baseContract(), checks: { deterministic: [], advisory: ["vlm-readability"] } }, "NO_DETERMINISTIC_CHECKS");
});

test("refuses an object-scoped check that binds no per-state object (anti-vacuous-pass)", () => {
  // required-in-frame (and its object-scoped siblings) grade objects taken from
  // each state's per-state requiredInFrame. A contract that enables them but binds
  // NO object to ANY state would emit only vacuous "nothing to check here" passes —
  // an authoritative green that verified nothing. Refuse it.
  const noBindings = (): Record<string, unknown> => ({
    ...baseContract(),
    // declare objects, but no state references any of them per-state.
    states: [
      { id: "start", kind: "start" },
      { id: "win", kind: "success_reward" },
    ],
    interactionFlow: { happyPath: ["start", "win"] },
  });
  for (const check of ["required-in-frame", "safe-area", "tap-target-size", "text-clipping", "control-overlap"]) {
    expectRefusal({ ...noBindings(), checks: { deterministic: [check] } }, "OBJECT_CHECK_NO_BINDINGS");
  }
  // A frame/console check with no per-state bindings is fine (it grades the
  // frame/console, not per-state objects) — not refused for this reason.
  assert.ok(
    !codes({ ...noBindings(), checks: { deterministic: ["console-clean"] } }).includes("OBJECT_CHECK_NO_BINDINGS"),
    "console-clean must not trip the object-binding rule",
  );
  // safe-area-sweep grades EVERY visible element (not declared bindings), so it must NOT
  // require requiredInFrame, and an optional safeAreaExempt list is accepted.
  assert.ok(
    !codes({ ...noBindings(), checks: { deterministic: ["safe-area-sweep"] } }).includes("OBJECT_CHECK_NO_BINDINGS"),
    "safe-area-sweep must not trip the object-binding rule (it sweeps all visible elements)",
  );
  assert.deepEqual(
    codes({ ...baseContract(), safeAreaExempt: ["/HUD/Logo", "scoreLabel"], checks: { deterministic: ["safe-area-sweep"] } }),
    [],
    "a contract with safe-area-sweep + safeAreaExempt validates",
  );
  // And as long as ONE state binds an object, an object check is accepted even if
  // other states bind nothing (a legitimate loading/transition state).
  assert.ok(
    !codes({
      ...baseContract(),
      states: [
        { id: "loading", kind: "start" },
        { id: "play", kind: "active", requiredInFrame: ["tile"] },
        { id: "win", kind: "success_reward" },
      ],
      interactionFlow: { happyPath: ["loading", "play", "win"] },
      checks: { deterministic: ["required-in-frame", "safe-area"] },
    }).includes("OBJECT_CHECK_NO_BINDINGS"),
    "one binding state is enough",
  );
});

test("refuses interaction-flow with a happyPath that has no gradeable transition (S6d)", () => {
  // FLOW_NO_TRANSITIONS: enabled but happyPath has <2 states → nothing to grade.
  expectRefusal(
    {
      ...baseContract(),
      states: [{ id: "win", kind: "success_reward", requiredInFrame: ["tile"] }],
      interactionFlow: { happyPath: ["win"] },
      checks: { deterministic: ["interaction-flow"] },
    },
    "FLOW_NO_TRANSITIONS",
  );
  // FLOW_INDISTINCT_TRANSITION: an adjacent-duplicate state is an ungradeable self-transition.
  expectRefusal(
    {
      ...baseContract(),
      interactionFlow: { happyPath: ["start", "play", "play", "win"] },
      checks: { deterministic: ["interaction-flow"] },
    },
    "FLOW_INDISTINCT_TRANSITION",
  );
  // A normal multi-state happyPath with interaction-flow is accepted.
  assert.ok(
    validateMinigameContract({
      ...baseContract(),
      checks: { deterministic: ["interaction-flow"] },
    }).valid,
    "a >=2-state distinct happyPath with interaction-flow must validate",
  );
});

// ── supporting refusals ────────────────────────────────────────────────────────

test("refuses the wrong contract type", () => {
  expectRefusal({ ...baseContract(), type: "2d-platformer" }, "UNSUPPORTED_TYPE");
});

test("refuses an unknown age band and unknown visual profile", () => {
  expectRefusal({ ...baseContract(), ageBand: "13-99" }, "UNKNOWN_AGE_BAND");
  expectRefusal({ ...baseContract(), visualProfile: "ultrawide-32-9" }, "UNKNOWN_VISUAL_PROFILE");
});

test("refuses an unknown state kind and a state scene not in scenes[]", () => {
  expectRefusal(
    { ...baseContract(), states: [{ id: "s", kind: "victory-dance" }, { id: "w", kind: "success_reward" }], interactionFlow: { happyPath: ["s", "w"] } },
    "UNKNOWN_STATE_KIND",
  );
  const c = baseContract();
  (c.states as any[])[0].scene = "Assets/Scenes/Other.unity";
  expectRefusal(c, "STATE_SCENE_NOT_DECLARED");
});

test("refuses a state requiredInFrame id that is not a declared object", () => {
  const c = baseContract();
  (c.states as any[])[1].requiredInFrame = ["ghost"];
  expectRefusal(c, "UNKNOWN_STATE_OBJECT");
});

test("refuses an invalid object locator and a duplicate object id", () => {
  expectRefusal(
    { ...baseContract(), requiredInFrame: [{ id: "x", locator: "" }] },
    "INVALID_LOCATOR",
  );
  expectRefusal(
    {
      ...baseContract(),
      requiredInFrame: [
        { id: "dup", locator: "Game:/A" },
        { id: "dup", locator: "Game:/B" },
      ],
    },
    "DUPLICATE_OBJECT_ID",
  );
});

test("refuses an object that is both requiredInFrame and allowedOffscreen", () => {
  const c = baseContract();
  c.allowedOffscreen = [{ id: "tile", locator: "Game:/Canvas/Tile" }];
  expectRefusal(c, "CONTRADICTORY_OFFSCREEN");
});

test("refuses an interaction flow that references an unknown state or never reaches a reward", () => {
  expectRefusal(
    { ...baseContract(), interactionFlow: { happyPath: ["start", "nope"] } },
    "FLOW_UNKNOWN_STATE",
  );
  // a flow with no success_reward state in it.
  const c = baseContract();
  c.states = [
    { id: "start", kind: "start" },
    { id: "play", kind: "active" },
  ];
  c.interactionFlow = { happyPath: ["start", "play"] };
  expectRefusal(c, "FLOW_NO_REWARD");
});

test("refuses an unknown artifact threshold key and an out-of-range threshold / safe area", () => {
  expectRefusal({ ...baseContract(), artifactThresholds: { wobble: 0.1 } }, "UNKNOWN_THRESHOLD");
  expectRefusal({ ...baseContract(), artifactThresholds: { maxBorderFraction: 1.5 } }, "INVALID_THRESHOLD");
  expectRefusal({ ...baseContract(), uiSafeAreas: { maxOverflowFraction: 2 } }, "INVALID_SAFE_AREA");
});

test("accepts the S6e baseline threshold keys (closed vocab extended)", () => {
  assert.deepEqual(
    codes({ ...baseContract(), artifactThresholds: { maxBaselineDiffFraction: 0.02, maxRectDriftFraction: 0.03 } }),
    [],
  );
  // still closed: an out-of-range baseline threshold is refused.
  expectRefusal({ ...baseContract(), artifactThresholds: { maxBaselineDiffFraction: 1.5 } }, "INVALID_THRESHOLD");
});

test("baseline is optional, but its masks must reference declared object ids", () => {
  // valid: a mask that names a declared requiredInFrame object id.
  assert.equal(
    validateMinigameContract({ ...baseContract(), baseline: { ref: "baselines/v1", masks: ["tile"] } }).valid,
    true,
  );
  // unknown mask id → refused (a typo can't silently disable a baseline mask).
  expectRefusal({ ...baseContract(), baseline: { ref: "baselines/v1", masks: ["ghost"] } }, "UNKNOWN_MASK_OBJECT");
  // non-string mask entry → refused.
  expectRefusal({ ...baseContract(), baseline: { ref: "baselines/v1", masks: [42] } }, "UNKNOWN_MASK_OBJECT");
  // a mask may reference an allowedOffscreen id too.
  assert.equal(
    validateMinigameContract({
      ...baseContract(),
      allowedOffscreen: [{ id: "spawner", locator: "Game:/Spawner" }],
      baseline: { ref: "baselines/v1", masks: ["spawner"] },
    }).valid,
    true,
  );
  // a baseline without masks is fine.
  assert.equal(validateMinigameContract({ ...baseContract(), baseline: { ref: "baselines/v1" } }).valid, true);
});

test("a malformed document is refused, not thrown, by the non-throwing validator", () => {
  assert.deepEqual(codes("not an object"), ["INVALID_DOCUMENT"]);
  assert.equal(validateMinigameContract(null).valid, false);
});

// ── shipped example ─────────────────────────────────────────────────────────────

test("the shipped example mini-game(s) load and validate", async () => {
  const all = await loadAllExampleMinigames();
  assert.equal(all.length, EXAMPLE_MINIGAME_IDS.length);
  const ap = await loadExampleMinigame("alphabet-pop");
  assert.equal(ap.type, "2d-kids-minigame");
  assert.equal(ap.id, "alphabet-pop");
  // self-consistency: every declared deterministic check is in the closed vocab,
  // and the happy path reaches a declared success_reward state.
  for (const name of ap.checks.deterministic) {
    assert.ok(MINIGAME_DETERMINISTIC_CHECK_SET.has(name), `example uses unknown check ${name}`);
  }
  const rewardIds = ap.states.filter((s) => s.kind === "success_reward").map((s) => s.id);
  assert.ok(ap.interactionFlow.happyPath.some((id) => rewardIds.includes(id)));
});

test("loadExampleMinigame throws a helpful error for an unknown id", async () => {
  await assert.rejects(() => loadExampleMinigame("does-not-exist"), /Unknown example mini-game/);
});

// ── containers / background-fit (S6c+) ──────────────────────────────────────────

test("containers: a valid background-fit binding validates", () => {
  const c = baseContract();
  c.containers = [{ background: "tile", content: ["home"], bgColor: "#FFFFFF", minBgFillFraction: 0.6 }];
  (c.checks as { deterministic: string[] }).deterministic = ["required-in-frame", "background-fit"];
  const result = validateMinigameContract(c);
  assert.equal(result.valid, true, JSON.stringify(result.issues));
});

test("containers: enabling background-fit with NO containers is refused (decides nothing)", () => {
  const c = baseContract();
  (c.checks as { deterministic: string[] }).deterministic = ["required-in-frame", "background-fit"];
  expectRefusal(c, "BACKGROUND_FIT_NO_CONTAINERS");
});

test("containers: a background that is not a declared object id is refused", () => {
  const c = baseContract();
  c.containers = [{ background: "ghost" }];
  expectRefusal(c, "UNKNOWN_CONTAINER_BACKGROUND");
});

test("containers: content referencing an undeclared object id is refused", () => {
  const c = baseContract();
  c.containers = [{ background: "tile", content: ["ghost"] }];
  expectRefusal(c, "UNKNOWN_CONTAINER_CONTENT");
});

test("containers: minBgFillFraction of 0 is refused (it would make background-fit always pass)", () => {
  const c = baseContract();
  c.containers = [{ background: "tile", minBgFillFraction: 0 }];
  expectRefusal(c, "INVALID_CONTAINER_FILL");
});

test("containers: a malformed bgColor and an out-of-range fill fraction are refused", () => {
  const c = baseContract();
  c.containers = [{ background: "tile", bgColor: "white", minBgFillFraction: 1.5 }];
  const cs = codes(c);
  assert.ok(cs.includes("INVALID_CONTAINER_COLOR"), cs.join(","));
  assert.ok(cs.includes("INVALID_CONTAINER_FILL"), cs.join(","));
});

test("containers: a background listed in its own content is refused", () => {
  const c = baseContract();
  c.containers = [{ background: "tile", content: ["tile"] }];
  expectRefusal(c, "CONTAINER_SELF_CONTENT");
});

// ── background-coverage (Phase 5) ─────────────────────────────────────────────────

test("background-coverage: a valid contract with backgroundLayers + backgroundCamera validates", () => {
  const c = baseContract();
  (c.checks as { deterministic: string[] }).deterministic = ["required-in-frame", "background-coverage"];
  c.backgroundLayers = ["Game:/Background/Sky", "Game:/Background/Ground"];
  c.backgroundCamera = "Game:/Main Camera";
  const result = validateMinigameContract(c);
  assert.equal(result.valid, true, JSON.stringify(result.issues));
});

test("background-coverage: enabling it without backgroundLayers is refused (decides nothing)", () => {
  const c = baseContract();
  (c.checks as { deterministic: string[] }).deterministic = ["required-in-frame", "background-coverage"];
  c.backgroundCamera = "Game:/Main Camera"; // camera present, layers absent
  expectRefusal(c, "MISSING_BACKGROUND_BINDING");
});

test("background-coverage: enabling it without backgroundCamera is refused (decides nothing)", () => {
  const c = baseContract();
  (c.checks as { deterministic: string[] }).deterministic = ["required-in-frame", "background-coverage"];
  c.backgroundLayers = ["Game:/Background/Sky"]; // layers present, camera absent
  expectRefusal(c, "MISSING_BACKGROUND_BINDING");
});

test("background-coverage: a non-locator backgroundLayer is refused", () => {
  const c = baseContract();
  (c.checks as { deterministic: string[] }).deterministic = ["required-in-frame", "background-coverage"];
  c.backgroundLayers = ["not-a-path"]; // no '/'
  c.backgroundCamera = "Game:/Main Camera";
  expectRefusal(c, "INVALID_LOCATOR");
});

test("background-coverage: the bindings are optional when the check is OFF", () => {
  const c = baseContract(); // checks.deterministic does NOT include background-coverage
  // No backgroundLayers / backgroundCamera — must still validate (fields are optional).
  assert.equal(validateMinigameContract(c).valid, true);
});

// ── state-id pattern (Low-1 fix) ──────────────────────────────────────────────────

test("state id: an '@' in a state id is refused (it is the device delimiter)", () => {
  const c = baseContract();
  (c.states as Array<Record<string, unknown>>)[0].id = "start@base"; // '@' corrupts <state>@<device>
  expectRefusal(c, "INVALID_STATE_ID");
});

test("state id: an uppercase / spaced state id is refused (not filename-safe)", () => {
  const c = baseContract();
  (c.states as Array<Record<string, unknown>>)[0].id = "Start Screen";
  expectRefusal(c, "INVALID_STATE_ID");
});

test("state id: underscores are allowed (existing kinds use them, e.g. success_reward)", () => {
  const c = baseContract();
  (c.states as Array<Record<string, unknown>>)[0].id = "start_screen";
  // Keep the happy path referencing the renamed state so the flow stays valid.
  (c.interactionFlow as { happyPath: string[] }).happyPath = ["start_screen", "play", "win", "back"];
  assert.equal(validateMinigameContract(c).valid, true, JSON.stringify(validateMinigameContract(c).issues));
});

// ── schema ↔ runtime parity (guards the drift that hid background-fit/containers) ─

test("JSON schema check enums stay in sync with the runtime closed vocabularies", async () => {
  const schema = JSON.parse(await fs.readFile(SCHEMA_PATH, "utf-8"));
  const detEnum: string[] = schema.properties.checks.properties.deterministic.items.enum;
  const advEnum: string[] = schema.properties.checks.properties.advisory.items.enum;
  assert.deepEqual(
    [...detEnum].sort(),
    [...MINIGAME_DETERMINISTIC_CHECKS].sort(),
    "schema deterministic enum drifted from MINIGAME_DETERMINISTIC_CHECKS",
  );
  assert.deepEqual(
    [...advEnum].sort(),
    [...MINIGAME_ADVISORY_CHECKS].sort(),
    "schema advisory enum drifted from MINIGAME_ADVISORY_CHECKS",
  );
});

test("JSON schema documents the containers field for the background-fit gate", async () => {
  const schema = JSON.parse(await fs.readFile(SCHEMA_PATH, "utf-8"));
  const containers = schema.properties.containers;
  assert.ok(containers, "schema is missing the 'containers' property");
  assert.equal(containers.type, "array");
  const props = containers.items.properties;
  for (const key of ["background", "content", "bgColor", "minBgFillFraction"]) {
    assert.ok(props[key], `schema container binding is missing '${key}'`);
  }
  // minBgFillFraction must reject 0 (exclusiveMinimum), mirroring the validator.
  assert.equal(props.minBgFillFraction.exclusiveMinimum, 0);
});

// ── device sets (Phase 2: schema + override + validation) ───────────────────────

test("every VISUAL_PROFILES entry has a non-empty device bracket with unique ids, base first", () => {
  for (const [id, profile] of Object.entries(VISUAL_PROFILES)) {
    assert.ok(profile.devices.length > 0, `${id} has no devices`);
    const ids = profile.devices.map((d) => d.id);
    assert.equal(new Set(ids).size, ids.length, `${id} has duplicate device ids`);
    // The BASE device is first and matches the profile's aspectRatio.
    const base = profile.devices[0];
    const baseAspect = base.width / base.height;
    assert.ok(
      Math.abs(baseAspect - profile.aspectRatio) < 1e-6,
      `${id} base device aspect ${baseAspect} != profile aspectRatio ${profile.aspectRatio}`,
    );
    for (const d of profile.devices) {
      assert.match(d.id, /^[a-z0-9][a-z0-9-]*$/, `${id} device id '${d.id}' not filename-safe`);
      assert.ok(d.width >= 16 && d.width <= 8192, `${id} device '${d.id}' width out of range`);
      assert.ok(d.height >= 16 && d.height <= 8192, `${id} device '${d.id}' height out of range`);
    }
  }
});

test("resolveDevices returns the profile default with no override, the override when present", () => {
  const noOverride = baseContract() as unknown as MinigameContract; // visualProfile: tablet-landscape
  assert.deepEqual(resolveDevices(noOverride), VISUAL_PROFILES["tablet-landscape"].devices);

  const override: DeviceSpec[] = [
    { id: "custom-square", label: "Square", width: 1024, height: 1024 },
  ];
  const withOverride = { ...baseContract(), devices: override } as unknown as MinigameContract;
  assert.deepEqual(resolveDevices(withOverride), override);

  // An empty override falls back to the profile default.
  const emptyOverride = { ...baseContract(), devices: [] } as unknown as MinigameContract;
  assert.deepEqual(resolveDevices(emptyOverride), VISUAL_PROFILES["tablet-landscape"].devices);

  // An unknown profile (shouldn't happen post-validation) yields [].
  const unknown = { ...baseContract(), visualProfile: "nope" } as unknown as MinigameContract;
  assert.deepEqual(resolveDevices(unknown), []);
});

test("a contract with no devices override still validates (additive field)", () => {
  const c = baseContract();
  assert.equal("devices" in c, false);
  assert.equal(validateMinigameContract(c).valid, true, JSON.stringify(validateMinigameContract(c).issues));
});

test("accepts a valid devices override", () => {
  const c = baseContract();
  c.devices = [
    { id: "tablet-l-4x3", label: "iPad (4:3)", width: 2048, height: 1536 },
    { id: "wide", label: "16:9", width: 1920, height: 1080 },
  ];
  assert.equal(validateMinigameContract(c).valid, true, JSON.stringify(validateMinigameContract(c).issues));
});

test("refuses an empty devices override", () => {
  const c = baseContract();
  c.devices = [];
  expectRefusal(c, "INVALID_DEVICE");
});

test("refuses a device with a zero / negative / oversize dimension", () => {
  for (const bad of [
    { id: "zero", label: "z", width: 0, height: 720 },
    { id: "neg", label: "n", width: -100, height: 720 },
    { id: "huge", label: "h", width: 9000, height: 720 },
    { id: "fractional", label: "f", width: 1280.5, height: 720 },
  ]) {
    const c = baseContract();
    c.devices = [bad];
    expectRefusal(c, "INVALID_DEVICE");
  }
});

test("refuses a device with a bad-char or empty id, or non-string label", () => {
  const badId = baseContract();
  badId.devices = [{ id: "Bad_Id", label: "x", width: 1280, height: 720 }];
  expectRefusal(badId, "INVALID_DEVICE");

  const emptyId = baseContract();
  emptyId.devices = [{ id: "", label: "x", width: 1280, height: 720 }];
  expectRefusal(emptyId, "INVALID_DEVICE");

  const badLabel = baseContract();
  badLabel.devices = [{ id: "ok", label: "", width: 1280, height: 720 }];
  expectRefusal(badLabel, "INVALID_DEVICE");
});

test("refuses duplicate device ids within the set", () => {
  const c = baseContract();
  c.devices = [
    { id: "dup", label: "a", width: 1280, height: 720 },
    { id: "dup", label: "b", width: 1920, height: 1080 },
  ];
  expectRefusal(c, "DUPLICATE_DEVICE_ID");
});

test("JSON schema documents the optional devices override", async () => {
  const schema = JSON.parse(await fs.readFile(SCHEMA_PATH, "utf-8"));
  const devices = schema.properties.devices;
  assert.ok(devices, "schema is missing the 'devices' property");
  assert.equal(devices.type, "array");
  const props = schema.definitions.deviceSpec.properties;
  for (const key of ["id", "label", "width", "height"]) {
    assert.ok(props[key], `schema deviceSpec is missing '${key}'`);
  }
  assert.equal(props.width.minimum, 16);
  assert.equal(props.width.maximum, 8192);
});

// --- state.scene name↔path reconciliation (regression for the scene-agnostic fusion contract) ---

/** baseContract + a `scene` stamped on every state (the rest stays valid: keeps requiredInFrame + flow). */
function contractWithStateScenes(scenes: string[], stateScenes: [string, string, string, string]): Record<string, unknown> {
  const c = baseContract();
  c.scenes = scenes;
  c.states = [
    { id: "start", kind: "start", scene: stateScenes[0] },
    { id: "play", kind: "active", requiredInFrame: ["tile"], scene: stateScenes[1] },
    { id: "win", kind: "success_reward", scene: stateScenes[2] },
    { id: "back", kind: "home_back", scene: stateScenes[3] },
  ];
  return c;
}

test("STATE_SCENE_NOT_DECLARED: a state.scene runtime NAME reconciles to its declared asset PATH by slug", () => {
  // The scene-agnostic fusion stamps state.scene with the runtime NAME ('Game') while scenes[] holds
  // the asset PATH ('Assets/Scenes/Game.unity'); they must reconcile by slug, not be rejected.
  const c = contractWithStateScenes(["Assets/Scenes/Game.unity"], ["Game", "Game", "Game", "Game"]);
  const result = validateMinigameContract(c);
  assert.equal(result.valid, true, JSON.stringify(result.issues));
});

test("STATE_SCENE_NOT_DECLARED: an exact asset-path state.scene also validates", () => {
  const p = "Assets/Scenes/Game.unity";
  const c = contractWithStateScenes([p], [p, p, p, p]);
  assert.equal(validateMinigameContract(c).valid, true, JSON.stringify(validateMinigameContract(c).issues));
});

test("STATE_SCENE_NOT_DECLARED: a genuinely undeclared scene still REFUSES (the gate isn't weakened)", () => {
  // Reconciliation must not become a free pass — a state in a scene that was never declared is still
  // a dangling reference and must be caught (MOAT: a missed rename can't slip through).
  const c = contractWithStateScenes(
    ["Assets/Scenes/Game.unity"],
    ["Game", "Game", "SomeOtherUndeclaredScene", "Game"],
  );
  assert.ok(codes(c).includes("STATE_SCENE_NOT_DECLARED"), "an undeclared scene must still be refused");
});
