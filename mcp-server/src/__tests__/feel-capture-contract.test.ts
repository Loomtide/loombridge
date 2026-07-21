import assert from "node:assert/strict";
import test from "node:test";

import { proposeFeelCaptureContract } from "../loomtide/feel-capture/setup.js";
import {
  assertValidFeelCaptureContract,
  validateFeelCaptureContract,
} from "../loomtide/feel-capture/validator.js";

const player = { scene: "Scene_1", path: "/Player" };

test("feel capture contract validates keyboard, uGUI, trace, world, and unsupported primitives", () => {
  const contract = {
    schemaVersion: "1",
    subjects: [{ id: "player", locator: player }],
    preconditions: [
      { kind: "scene-set-active", locator: { scene: "Scene_1", path: "/ControllesMobiles" }, active: true, restore: true },
    ],
    interactions: [
      { id: "run-key", kind: "keyboard", measure: player, phases: [{ keys: ["RightArrow"], durationMs: 500 }] },
      { id: "short-hop-key", kind: "keyboard", measure: player, phases: [{ keys: ["Space"], fixedTicks: 6 }] },
      { id: "jump", kind: "ugui-tap", measure: player, target: { path: "/Canvas/Jump" } },
      { id: "double", kind: "ugui-multitap", measure: player, target: { path: "/Canvas/Jump" }, taps: [{ atMs: 400 }, { atMs: 580 }] },
      { id: "short-hop-hold", kind: "ugui-hold", measure: player, target: { path: "/Canvas/Jump" }, holdFixedTicks: 6 },
      { id: "stick", kind: "ugui-hold-drag", measure: player, target: { path: "/Canvas/Stick" }, dragTo: { dx: 220, dy: 0 } },
      { id: "world", kind: "world-pointer", measure: player, x: 10, y: 20 },
      { id: "trace", kind: "trace-replay", traceId: "happy-path" },
      { id: "legacy", kind: "unsupported", reason: "legacy Input.GetKey without UI cannot be driven." },
    ],
    metrics: [
      { metric: "runSpeed", interactionId: "run-key", derivation: "trajectory" },
      { metric: "shortHopApex", interactionId: "short-hop-key", derivation: "trajectory", stimulus: { metric: "shortHopApex", tapTicks: 6, phases: "[jump 6t][jumpCut]" } },
      { metric: "shortHopApexMobile", interactionId: "short-hop-hold", derivation: "trajectory", deriveAs: "shortHopApex", stimulus: { metric: "shortHopApexMobile", tapTicks: 6, phases: "[pointerDown 6t][pointerUp]" } },
      { metric: "jumpApex", interactionId: "jump", derivation: "trajectory" },
      { metric: "dashDistance", interactionId: "run-key", derivation: "phase-delta", phaseIndex: 0, axis: "x" },
      { metric: "legacyRun", derivation: "unsupported", reason: "requires app-level legacy input injection." },
    ],
    signals: [
      { id: "anim-jumping", locator: player, type_name: "Animator", method_name: "GetBool", args: ["jumping"] },
    ],
  };

  assert.equal(validateFeelCaptureContract(contract).valid, true);
  assert.equal(assertValidFeelCaptureContract(contract).preconditions?.length, 1);
  assert.equal(assertValidFeelCaptureContract(contract).interactions.length, 9);
});

test("feel capture contract refuses missing metric interactions and signal reader ambiguity", () => {
  const result = validateFeelCaptureContract({
    schemaVersion: "1",
    subjects: [{ id: "player", locator: player }],
    interactions: [{ id: "jump", kind: "ugui-tap", measure: player, target: { path: "/Jump" } }],
    signals: [
      { id: "bad", locator: player, type_name: "Animator", property_path: "x", method_name: "GetBool" },
    ],
    metrics: [{ metric: "runSpeed", interactionId: "missing", derivation: "trajectory" }],
  });
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((i) => i.code === "UNKNOWN_INTERACTION"));
  assert.ok(result.issues.some((i) => i.code === "INVALID_SIGNAL_READER"));
});

test("feel capture contract rejects duplicate interaction ids before runner map overwrite", () => {
  const result = validateFeelCaptureContract({
    schemaVersion: "1",
    subjects: [{ id: "player", locator: player }],
    interactions: [
      { id: "jump", kind: "ugui-tap", measure: player, target: { path: "/Jump" } },
      { id: "jump", kind: "ugui-hold-drag", measure: player, target: { path: "/Stick" }, dragTo: { dx: 220, dy: 0 } },
    ],
    metrics: [{ metric: "jumpApex", interactionId: "jump", derivation: "trajectory" }],
  });

  assert.equal(result.valid, false);
  assert.ok(result.issues.some((i) => i.code === "DUPLICATE_INTERACTION_ID"));
});

test("feel capture contract rejects duplicate sampled signal ids before sync series ambiguity", () => {
  const result = validateFeelCaptureContract({
    schemaVersion: "1",
    subjects: [{ id: "player", locator: player }],
    interactions: [
      {
        id: "jump",
        kind: "ugui-tap",
        measure: player,
        target: { path: "/Jump" },
        sampledFields: [
          { id: "anim", locator: player, type_name: "Animator", method_name: "GetBool", args: ["jumping"] },
          { id: "anim", locator: player, type_name: "Animator", method_name: "GetBool", args: ["falling"] },
        ],
      },
    ],
    metrics: [{ metric: "inputToAnimStateLatency", interactionId: "jump", derivation: "sync", seriesId: "anim" }],
  });

  assert.equal(result.valid, false);
  assert.ok(result.issues.some((i) => i.code === "DUPLICATE_SIGNAL_ID"));
});

test("feel capture contract validates fixed-tick keyboard phases and stimulus shape", () => {
  const result = validateFeelCaptureContract({
    schemaVersion: "1",
    subjects: [{ id: "player", locator: player }],
    interactions: [
      { id: "both", kind: "keyboard", measure: player, phases: [{ keys: ["Space"], durationMs: 100, fixedTicks: 6 }] },
      { id: "neither", kind: "keyboard", measure: player, phases: [{ keys: ["Space"] }] },
      { id: "fractional", kind: "keyboard", measure: player, phases: [{ keys: ["Space"], fixedTicks: 6.5 }] },
    ],
    metrics: [
      {
        metric: "shortHopApex",
        interactionId: "fractional",
        derivation: "trajectory",
        stimulus: { metric: "jumpApex", tapTicks: 6.5, phases: "" },
      },
    ],
  });

  assert.equal(result.valid, false);
  assert.ok(result.issues.some((i) => i.path === "interactions.0.phases.0" && /exactly one/.test(i.message)));
  assert.ok(result.issues.some((i) => i.path === "interactions.1.phases.0" && /exactly one/.test(i.message)));
  assert.ok(result.issues.some((i) => i.path === "interactions.2.phases.0.fixedTicks" && /positive integer/.test(i.message)));
  assert.ok(result.issues.some((i) => i.path === "metrics.0.stimulus.metric" && /must match/.test(i.message)));
  assert.ok(result.issues.some((i) => i.path === "metrics.0.stimulus.tapTicks" && /positive integer/.test(i.message)));
  assert.ok(result.issues.some((i) => i.path === "metrics.0.stimulus.phases" && /non-empty/.test(i.message)));
});

test("setup proposal is generic and marks missing drive recipes unsupported", () => {
  const contract = proposeFeelCaptureContract({
    root: "/tmp/game",
    game: "Example",
    scene: "Scene_1",
    playerPath: "/Avatar",
  });
  assert.deepEqual(contract.subjects[0].locator, { scene: "Scene_1", path: "/Avatar" });
  assert.ok(contract.metrics.some((m) => m.metric === "jumpApex" && m.derivation === "unsupported"));
  assert.ok(contract.metrics.some((m) => m.metric === "runSpeed" && m.derivation === "unsupported"));
});

test("feel capture contract validates a grounded-settle precondition on a short-hop interaction", () => {
  const result = validateFeelCaptureContract({
    schemaVersion: "1",
    subjects: [{ id: "player", locator: player }],
    interactions: [
      {
        id: "short-hop-key",
        kind: "keyboard",
        measure: player,
        settle: {
          kind: "settle-until-rest",
          measure: player,
          timeoutMs: 3000,
          pollMs: 200,
          minStableSamples: 6,
          minStableMs: 100,
          restThreshold: 0.02,
        },
        phases: [{ keys: [], durationMs: 200 }, { keys: ["Space"], fixedTicks: 6 }, { keys: [], durationMs: 1100 }],
      },
    ],
    metrics: [{ metric: "shortHopApex", interactionId: "short-hop-key", derivation: "trajectory" }],
  });
  assert.equal(result.valid, true);
});

test("feel capture contract refuses grounded-settle on a different object than the measured subject", () => {
  const result = validateFeelCaptureContract({
    schemaVersion: "1",
    subjects: [{ id: "player", locator: player }],
    interactions: [
      {
        id: "short-hop-key",
        kind: "keyboard",
        measure: player,
        settle: {
          kind: "settle-until-rest",
          measure: { path: "/StaticMarker" },
        },
        phases: [{ keys: [], durationMs: 200 }, { keys: ["Space"], fixedTicks: 6 }, { keys: [], durationMs: 1100 }],
      },
    ],
    metrics: [{ metric: "shortHopApex", interactionId: "short-hop-key", derivation: "trajectory" }],
  });

  assert.equal(result.valid, false);
  assert.ok(result.issues.some((i) => i.code === "INVALID_SETTLE_MEASURE"));
});

test("feel capture contract refuses a malformed grounded-settle precondition", () => {
  const result = validateFeelCaptureContract({
    schemaVersion: "1",
    subjects: [{ id: "player", locator: player }],
    interactions: [
      {
        id: "short-hop-key",
        kind: "keyboard",
        measure: player,
        // unknown kind, non-positive timeout, zero stable samples, negative duration, negative threshold
        settle: { kind: "settle-magically", timeoutMs: 0, minStableSamples: 0, minStableMs: -1, restThreshold: -1 },
        phases: [{ keys: ["Space"], fixedTicks: 6 }],
      },
    ],
    metrics: [{ metric: "shortHopApex", interactionId: "short-hop-key", derivation: "trajectory" }],
  });
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((i) => i.code === "UNKNOWN_SETTLE_KIND"));
});

test("feel capture contract refuses malformed grounded-settle tunables", () => {
  const result = validateFeelCaptureContract({
    schemaVersion: "1",
    subjects: [{ id: "player", locator: player }],
    interactions: [
      {
        id: "short-hop-key",
        kind: "keyboard",
        measure: player,
        settle: {
          kind: "settle-until-rest",
          measure: player,
          timeoutMs: 0,
          pollMs: -1,
          minStableSamples: 0,
          minStableMs: -1,
          restThreshold: -1,
        },
        phases: [{ keys: ["Space"], fixedTicks: 6 }],
      },
    ],
    metrics: [{ metric: "shortHopApex", interactionId: "short-hop-key", derivation: "trajectory" }],
  });
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((i) => i.path.endsWith(".timeoutMs")));
  assert.ok(result.issues.some((i) => i.path.endsWith(".pollMs")));
  assert.ok(result.issues.some((i) => i.path.endsWith(".minStableSamples")));
  assert.ok(result.issues.some((i) => i.path.endsWith(".minStableMs")));
  assert.ok(result.issues.some((i) => i.path.endsWith(".restThreshold")));
});

test("feel capture contract validates semantic coyote and jump-buffer probes", () => {
  const contract = {
    schemaVersion: "1",
    subjects: [{ id: "player", locator: player }],
    interactions: [
      {
        id: "coyote-semantic",
        kind: "semantic-probe",
        metric: "coyoteTime",
        measure: player,
        anchors: [
          { id: "leave", kind: "ground-lost", phaseIndex: 0 },
          { id: "jump", kind: "jump-input", phaseIndex: 1 },
        ],
        trials: [
          {
            delayMs: 80,
            phases: [
              { durationMs: 80, drivers: [{ locator: player, type_name: "TestDriver", property_path: "jump", value: false }] },
              { durationMs: 500, drivers: [{ locator: player, type_name: "TestDriver", property_path: "jump", value: true }] },
            ],
          },
          {
            delayMs: 140,
            phases: [
              { durationMs: 140, drivers: [{ locator: player, type_name: "TestDriver", property_path: "jump", value: false }] },
              { durationMs: 500, drivers: [{ locator: player, type_name: "TestDriver", property_path: "jump", value: true }] },
            ],
          },
        ],
        jumpEvidence: { kind: "trajectory-rise", afterAnchorId: "jump", minRise: 0.05 },
      },
      {
        id: "buffer-semantic",
        kind: "semantic-probe",
        metric: "jumpBuffer",
        measure: player,
        anchors: [
          { id: "buffered-jump", kind: "pre-jump-buffered-input", phaseIndex: 0 },
          { id: "land", kind: "grounded-ready", phaseIndex: 1 },
        ],
        trials: [
          {
            delayMs: 70,
            phases: [
              { durationMs: 70, drivers: [{ locator: player, type_name: "TestDriver", property_path: "jump", value: true }] },
              { durationMs: 500, drivers: [{ locator: player, type_name: "TestDriver", property_path: "jump", value: false }] },
            ],
          },
          {
            delayMs: 130,
            phases: [
              { durationMs: 130, drivers: [{ locator: player, type_name: "TestDriver", property_path: "jump", value: true }] },
              { durationMs: 500, drivers: [{ locator: player, type_name: "TestDriver", property_path: "jump", value: false }] },
            ],
          },
        ],
        jumpEvidence: { kind: "trajectory-rise", afterAnchorId: "land" },
      },
    ],
    metrics: [
      { metric: "coyoteTime", interactionId: "coyote-semantic", derivation: "bisection" },
      { metric: "jumpBuffer", interactionId: "buffer-semantic", derivation: "bisection" },
    ],
  };

  assert.equal(validateFeelCaptureContract(contract).valid, true);
});

test("feel capture contract refuses malformed semantic probes", () => {
  const result = validateFeelCaptureContract({
    schemaVersion: "1",
    subjects: [{ id: "player", locator: player }],
    interactions: [
      {
        id: "bad-coyote",
        kind: "semantic-probe",
        metric: "coyoteTime",
        measure: player,
        anchors: [{ id: "leave", kind: "ground-lost", phaseIndex: 3 }],
        trials: [
          { delayMs: 0, phases: [{ durationMs: -1 }] },
          { delayMs: 100, phases: [{ durationMs: 100 }] },
        ],
        jumpEvidence: { kind: "trajectory-rise", afterAnchorId: "missing", minRise: 0 },
      },
    ],
    metrics: [{ metric: "coyoteTime", interactionId: "bad-coyote", derivation: "bisection" }],
  });

  assert.equal(result.valid, false);
  assert.ok(result.issues.some((i) => i.code === "MISSING_SEMANTIC_ANCHOR"));
  assert.ok(result.issues.some((i) => i.code === "SEMANTIC_ANCHOR_OUT_OF_RANGE"));
  assert.ok(result.issues.some((i) => i.code === "INVALID_SEMANTIC_TRIAL"));
  assert.ok(result.issues.some((i) => i.code === "UNKNOWN_SEMANTIC_ANCHOR"));
});

test("feel capture contract refuses semantic probe phases that runtime.probe cannot execute", () => {
  const result = validateFeelCaptureContract({
    schemaVersion: "1",
    subjects: [{ id: "player", locator: player }],
    interactions: [
      {
        id: "coyote-no-drivers",
        kind: "semantic-probe",
        metric: "coyoteTime",
        measure: player,
        anchors: [
          { id: "leave", kind: "ground-lost", phaseIndex: 0 },
          { id: "jump", kind: "jump-input", phaseIndex: 1 },
        ],
        trials: [
          { delayMs: 80, phases: [{ durationMs: 80 }, { durationMs: 500, drivers: [] }] },
          { delayMs: 140, phases: [{ durationMs: 140 }, { durationMs: 500, drivers: [] }] },
        ],
        jumpEvidence: { kind: "trajectory-rise", afterAnchorId: "jump" },
      },
    ],
    metrics: [{ metric: "coyoteTime", interactionId: "coyote-no-drivers", derivation: "bisection" }],
  });

  assert.equal(result.valid, false);
  assert.ok(result.issues.some((i) => i.code === "MISSING_SEMANTIC_DRIVER"));
  assert.ok(result.issues.some((i) => i.code === "INVALID_SEMANTIC_DRIVER"));
});

test("feel capture contract refuses bisection metrics bound to non-semantic interactions", () => {
  const result = validateFeelCaptureContract({
    schemaVersion: "1",
    subjects: [{ id: "player", locator: player }],
    interactions: [
      {
        id: "jump-key",
        kind: "keyboard",
        measure: player,
        phases: [{ keys: ["Space"], durationMs: 500 }],
      },
    ],
    metrics: [{ metric: "coyoteTime", interactionId: "jump-key", derivation: "bisection" }],
  });

  assert.equal(result.valid, false);
  assert.ok(result.issues.some((i) => i.code === "INVALID_METRIC" && /semantic-probe/.test(i.message)));
});
