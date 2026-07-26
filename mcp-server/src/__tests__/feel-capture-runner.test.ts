import assert from "node:assert/strict";
import test from "node:test";

import { runFeelCaptureContract, type FeelCaptureSend } from "../capabilities/feel/run.js";
import { evaluateFeelCaptureRuntimeGuard } from "../capabilities/feel/runtime-guard.js";
import type { FeelCaptureContract } from "../capabilities/feel/types.js";
import { SHORT_HOP_CANONICAL_TAP_TICKS } from "../capabilities/genre/genre-packs/platformer-2d/measure-recipe.js";
import { evaluateFeelProvenance } from "../capabilities/verification/gates/feel-provenance.js";
import { rederiveFromSources } from "../capabilities/verification/gates/feel-rederive.js";

const player = { scene: "Scene_1", path: "/Player" };
const dashAcceptance = {
  feel: {
    dashDistance: { target: 4, unit: "u", band: { percent: 15 } },
  },
} as any;

function success(data: unknown) {
  return { id: "1", status: "success" as const, data, timestamp: Date.now() };
}

const arc = [
  { tMs: 0, x: 0, y: 0 },
  { tMs: 100, x: 0, y: 1 },
  { tMs: 200, x: 0, y: 2 },
  { tMs: 300, x: 0, y: 1 },
];

test("runner dispatches uGUI tap and assembles trajectory metrics with coverage", async () => {
  const calls: { command: string; params: Record<string, unknown> }[] = [];
  const send: FeelCaptureSend = async (command, params) => {
    calls.push({ command, params });
    return success({
      samples: arc,
      dispatch: { actuated: true },
      sampleCount: arc.length,
    });
  };
  const contract: FeelCaptureContract = {
    schemaVersion: "1",
    subjects: [{ id: "player", locator: player }],
    interactions: [{ id: "jump", kind: "ugui-tap", measure: player, target: { path: "/Jump" } }],
    metrics: [
      { metric: "jumpApex", interactionId: "jump", derivation: "trajectory" },
      { metric: "timeToApex", interactionId: "jump", derivation: "trajectory" },
    ],
  };
  const result = await runFeelCaptureContract(contract, send);
  assert.equal(calls[0].command, "runtime.capture_pointer_motion");
  assert.equal(result.measurements.metrics.jumpApex, 2);
  assert.equal(result.measurements.metrics.timeToApex, 200);
  assert.deepEqual(
    result.measurements.captureCoverage.map((c) => [c.metric, c.status]),
    [["jumpApex", "measured"], ["timeToApex", "measured"]],
  );
  assert.equal(result.measurements.provenance.sources[0].derivation, "trajectory");
  assert.deepEqual(result.measurements.provenance.sources[0].measuredMetrics, ["jumpApex", "timeToApex"]);
});

test("runner maps keyboard no-actuation to attempted-blocked instead of idle metrics", async () => {
  const send: FeelCaptureSend = async () => success({
    samples: [
      { tMs: 0, x: 0, y: 0, phase: 0 },
      { tMs: 100, x: 0, y: 0, phase: 0 },
      { tMs: 200, x: 0, y: 0, phase: 1 },
      { tMs: 300, x: 0, y: 0, phase: 1 },
    ],
    phases: [
      { index: 0, keys: [], sampleCount: 2, deltaX: 0, deltaY: 0 },
      { index: 1, keys: ["RightArrow"], sampleCount: 2, deltaX: 0, deltaY: 0 },
    ],
  });
  const contract: FeelCaptureContract = {
    schemaVersion: "1",
    subjects: [{ id: "player", locator: player }],
    interactions: [
      {
        id: "run",
        kind: "keyboard",
        measure: player,
        phases: [{ durationMs: 100 }, { keys: ["RightArrow"], durationMs: 300 }],
      },
    ],
    metrics: [{ metric: "runSpeed", interactionId: "run", derivation: "trajectory" }],
  };

  const result = await runFeelCaptureContract(contract, send);
  assert.equal(result.measurements.metrics.runSpeed, undefined);
  assert.equal(result.measurements.captureCoverage[0].status, "attempted-blocked");
  assert.match(result.measurements.captureCoverage[0].reason ?? "", /did not move/);
});

test("runner accepts keyboard captures with active-phase movement and records input onset", async () => {
  const send: FeelCaptureSend = async () => success({
    samples: [
      { tMs: 0, x: 0, y: 0, phase: 0 },
      { tMs: 100, x: 0, y: 0, phase: 0 },
      { tMs: 200, x: 1, y: 0, phase: 1 },
      { tMs: 300, x: 2, y: 0, phase: 1 },
    ],
    phases: [
      { index: 0, keys: [], sampleCount: 2, deltaX: 0, deltaY: 0 },
      { index: 1, keys: ["RightArrow"], sampleCount: 2, deltaX: 1, deltaY: 0 },
    ],
  });
  const contract: FeelCaptureContract = {
    schemaVersion: "1",
    subjects: [{ id: "player", locator: player }],
    interactions: [
      {
        id: "run",
        kind: "keyboard",
        measure: player,
        phases: [{ durationMs: 100 }, { keys: ["RightArrow"], durationMs: 300 }],
      },
    ],
    metrics: [
      { metric: "runSpeed", interactionId: "run", derivation: "trajectory" },
      { metric: "inputLatency", interactionId: "run", derivation: "trajectory" },
    ],
  };

  const result = await runFeelCaptureContract(contract, send);
  assert.equal(result.measurements.captureCoverage[0].status, "measured");
  assert.equal(result.measurements.metrics.inputLatency, 100);
  assert.equal(result.measurements.provenance.sources[0].derivation, "trajectory");
  assert.equal(result.measurements.provenance.sources[0].inputOnsetMs, 100);
  assert.deepEqual(result.measurements.provenance.sources[0].measuredMetrics, ["runSpeed", "inputLatency"]);
  assert.deepEqual(
    rederiveFromSources(result.measurements.provenance.sources, result.measurements.metrics)
      .filter((v) => v.metric === "inputLatency")
      .map((v) => v.status),
    ["pass"],
  );
});

test("runner derives keyboard dashDistance from the declared dash phase delta", async () => {
  const send: FeelCaptureSend = async () => success({
    samples: [
      { tMs: 0, x: 0, y: 0, phase: 0 },
      { tMs: 200, x: 0, y: 0, phase: 1 },
      { tMs: 500, x: 2.7, y: 0, phase: 2 },
      { tMs: 720, x: 6.7, y: 0, phase: 3 },
      { tMs: 1020, x: 9.4, y: 0, phase: 3 },
    ],
    phases: [
      { index: 0, keys: [], sampleCount: 1, deltaX: 0, deltaY: 0 },
      { index: 1, keys: ["D"], sampleCount: 1, deltaX: 2.7, deltaY: 0 },
      { index: 2, keys: ["D", "LeftShift"], sampleCount: 1, deltaX: 4, deltaY: 0 },
      { index: 3, keys: ["D"], sampleCount: 2, deltaX: 2.7, deltaY: 0 },
    ],
    projectFixedTimestepBeforeMeasurement: 0.016667,
    measurementFixedTimestep: 0.016667,
  });
  const contract: FeelCaptureContract = {
    schemaVersion: "1",
    subjects: [{ id: "player", locator: player }],
    interactions: [
      {
        id: "dash-key",
        kind: "keyboard",
        measure: player,
        phases: [
          { keys: [], durationMs: 200 },
          { keys: ["D"], durationMs: 300 },
          { keys: ["D", "LeftShift"], durationMs: 150 },
          { keys: ["D"], durationMs: 300 },
        ],
      },
    ],
    metrics: [
      { metric: "dashDistance", interactionId: "dash-key", derivation: "phase-delta", phaseIndex: 2, axis: "x", requiredKeys: ["D", "LeftShift"] },
    ],
  };

  const result = await runFeelCaptureContract(contract, send);
  assert.equal(result.measurements.metrics.dashDistance, 4);
  assert.equal(result.measurements.captureCoverage[0].status, "measured");
  const source = result.measurements.provenance.sources[0];
  assert.equal(source.derivation, "phase-delta");
  assert.equal(source.phaseIndex, 2);
  assert.equal(source.axis, "x");
  assert.deepEqual(source.phaseKeys, ["D", "LeftShift"]);
  assert.deepEqual(source.requiredKeys, ["D", "LeftShift"]);
  const verdicts = rederiveFromSources(result.measurements.provenance.sources, result.measurements.metrics);
  assert.equal(verdicts.find((v) => v.metric === "dashDistance")?.status, "pass");
  const provenance = evaluateFeelProvenance(
    { ...result.measurements.metrics, provenance: result.measurements.provenance },
    dashAcceptance,
  );
  assert.equal(provenance.verdict, "pass");
});

test("runner matches phase-delta requiredKeys case-insensitively against canonical bridge keys", async () => {
  // Regression: setup emits the developer's typed key casing ("d", "leftShift"), but the
  // bridge canonicalizes captured phase keys to the InputSystem Key enum names ("D", "LeftShift").
  // A case-sensitive comparison wrongly demoted a genuinely-captured dash to "not measured"
  // ("phase 2 did not hold required key(s): d, leftShift") even though the raw phase clearly
  // held D + LeftShift with a real deltaX. Provenance must measure it.
  const send: FeelCaptureSend = async () => success({
    samples: [
      { tMs: 0, x: 0, y: 0, phase: 0 },
      { tMs: 500, x: 2.7, y: 0, phase: 2 },
    ],
    phases: [
      { index: 0, keys: [], sampleCount: 1, deltaX: 0, deltaY: 0 },
      { index: 1, keys: ["D"], sampleCount: 1, deltaX: 2.1, deltaY: 0 },
      { index: 2, keys: ["D", "LeftShift"], sampleCount: 1, deltaX: 4, deltaY: 0 },
      { index: 3, keys: ["D"], sampleCount: 2, deltaX: 0, deltaY: 0 },
    ],
    projectFixedTimestepBeforeMeasurement: 0.016667,
    measurementFixedTimestep: 0.016667,
  });
  const contract: FeelCaptureContract = {
    schemaVersion: "1",
    subjects: [{ id: "player", locator: player }],
    interactions: [
      {
        id: "dash-key",
        kind: "keyboard",
        measure: player,
        phases: [
          { keys: [], durationMs: 200 },
          { keys: ["d"], durationMs: 300 },
          { keys: ["d", "leftShift"], durationMs: 150 },
          { keys: ["d"], durationMs: 300 },
        ],
      },
    ],
    // requiredKeys in the DEVELOPER's casing, exactly as setup emits them.
    metrics: [
      { metric: "dashDistance", interactionId: "dash-key", derivation: "phase-delta", phaseIndex: 2, axis: "x", requiredKeys: ["d", "leftShift"] },
    ],
  };

  const result = await runFeelCaptureContract(contract, send);
  assert.equal(result.measurements.metrics.dashDistance, 4);
  assert.equal(result.measurements.captureCoverage[0].status, "measured");
  const verdicts = rederiveFromSources(result.measurements.provenance.sources, result.measurements.metrics);
  assert.equal(verdicts.find((v) => v.metric === "dashDistance")?.status, "pass");
});

test("runner emits separate phase-delta provenance for metrics with different selectors", async () => {
  const send: FeelCaptureSend = async () => success({
    samples: [
      { tMs: 0, x: 0, y: 0 },
      { tMs: 100, x: 3, y: 2 },
    ],
    phases: [
      { index: 0, keys: ["D"], sampleCount: 1, deltaX: 1, deltaY: 0 },
      { index: 1, keys: ["D", "LeftShift"], sampleCount: 1, deltaX: 3, deltaY: 2 },
    ],
    projectFixedTimestepBeforeMeasurement: 0.016667,
    measurementFixedTimestep: 0.016667,
  });
  const contract: FeelCaptureContract = {
    schemaVersion: "1",
    subjects: [{ id: "player", locator: player }],
    interactions: [
      {
        id: "dash-key",
        kind: "keyboard",
        measure: player,
        phases: [
          { keys: ["D"], durationMs: 100 },
          { keys: ["D", "LeftShift"], durationMs: 150 },
        ],
      },
    ],
    metrics: [
      { metric: "dashDistance", interactionId: "dash-key", derivation: "phase-delta", phaseIndex: 1, axis: "x", requiredKeys: ["D", "LeftShift"] },
      { metric: "dashLift", interactionId: "dash-key", derivation: "phase-delta", phaseIndex: 1, axis: "y", requiredKeys: ["D", "LeftShift"] },
    ],
  };

  const result = await runFeelCaptureContract(contract, send);
  assert.equal(result.measurements.metrics.dashDistance, 3);
  assert.equal(result.measurements.metrics.dashLift, 2);
  const sources = result.measurements.provenance.sources.filter((s) => s.derivation === "phase-delta");
  assert.equal(sources.length, 2);
  assert.deepEqual(sources.map((s) => s.measuredMetrics), [["dashDistance"], ["dashLift"]]);
  assert.deepEqual(sources.map((s) => s.axis), ["x", "y"]);
});

test("runner omits inputLatency when the capture has no input onset provenance", async () => {
  const send: FeelCaptureSend = async () => success({
    samples: [
      { tMs: 0, x: 0, y: 0 },
      { tMs: 100, x: 0, y: 0 },
      { tMs: 200, x: 1, y: 0 },
      { tMs: 300, x: 2, y: 0 },
    ],
    dispatch: { actuated: true },
  });
  const contract: FeelCaptureContract = {
    schemaVersion: "1",
    subjects: [{ id: "player", locator: player }],
    interactions: [{ id: "run", kind: "ugui-hold-drag", measure: player, target: { path: "/Stick" }, dragTo: { dx: 220, dy: 0 } }],
    metrics: [{ metric: "inputLatency", interactionId: "run", derivation: "trajectory" }],
  };

  const result = await runFeelCaptureContract(contract, send);
  assert.equal(result.measurements.metrics.inputLatency, undefined);
  assert.equal(result.measurements.captureCoverage[0].status, "not-measured");
  assert.match(result.measurements.captureCoverage[0].reason ?? "", /inputLatency could not be derived/);
  assert.deepEqual(result.measurements.provenance.sources[0].measuredMetrics, []);
});

test("runner preserves fixed-tick short-hop phases and emits canonical stimulus provenance", async () => {
  const calls: { command: string; params: Record<string, unknown> }[] = [];
  const send: FeelCaptureSend = async (command, params) => {
    calls.push({ command, params });
    return success({
      samples: arc,
      phases: [
        { index: 0, keys: [], sampleCount: 1, deltaX: 0, deltaY: 0 },
        {
          index: 1,
          keys: ["Space"],
          requestedFixedTicks: SHORT_HOP_CANONICAL_TAP_TICKS,
          actualFixedTicks: SHORT_HOP_CANONICAL_TAP_TICKS,
          sampleCount: 2,
          deltaX: 0,
          deltaY: 1,
        },
        { index: 2, keys: [], sampleCount: 1, deltaX: 0, deltaY: 1 },
      ],
    });
  };
  const contract: FeelCaptureContract = {
    schemaVersion: "1",
    subjects: [{ id: "player", locator: player }],
    interactions: [
      {
        id: "short-hop",
        kind: "keyboard",
        measure: player,
        phases: [
          { keys: [], durationMs: 200 },
          { keys: ["Space"], fixedTicks: SHORT_HOP_CANONICAL_TAP_TICKS },
          { keys: [], durationMs: 1100 },
        ],
      },
    ],
    metrics: [
      {
        metric: "shortHopApex",
        interactionId: "short-hop",
        derivation: "trajectory",
        stimulus: {
          metric: "shortHopApex",
          tapTicks: SHORT_HOP_CANONICAL_TAP_TICKS,
          phases: `[jump ${SHORT_HOP_CANONICAL_TAP_TICKS}t][jumpCut]`,
        },
      },
    ],
  };

  const result = await runFeelCaptureContract(contract, send);
  assert.deepEqual(calls[0].params.phases, contract.interactions[0].kind === "keyboard" ? contract.interactions[0].phases : undefined);
  assert.equal(result.measurements.metrics.shortHopApex, 2);
  const source = result.measurements.provenance.sources[0];
  assert.equal(source.derivation, "trajectory");
  assert.deepEqual(source.measuredMetrics, ["shortHopApex"]);
  assert.deepEqual(source.stimulus, {
    metric: "shortHopApex",
    tapTicks: SHORT_HOP_CANONICAL_TAP_TICKS,
    phases: `[jump ${SHORT_HOP_CANONICAL_TAP_TICKS}t][jumpCut]`,
  });
  assert.deepEqual(
    rederiveFromSources(result.measurements.provenance.sources, result.measurements.metrics)
      .filter((v) => v.metric === "shortHopApex")
      .map((v) => v.status),
    ["pass"],
  );
});

test("runner does not certify short-hop stimulus without matching fixed-tick evidence", async () => {
  const send: FeelCaptureSend = async () => success({
    samples: arc,
    phases: [
      { index: 0, keys: [], sampleCount: 1, deltaX: 0, deltaY: 0 },
      {
        index: 1,
        keys: ["Space"],
        requestedFixedTicks: SHORT_HOP_CANONICAL_TAP_TICKS,
        actualFixedTicks: SHORT_HOP_CANONICAL_TAP_TICKS + 1,
        sampleCount: 2,
        deltaX: 0,
        deltaY: 1,
      },
      { index: 2, keys: [], sampleCount: 1, deltaX: 0, deltaY: 1 },
    ],
  });
  const contract: FeelCaptureContract = {
    schemaVersion: "1",
    subjects: [{ id: "player", locator: player }],
    interactions: [
      {
        id: "short-hop",
        kind: "keyboard",
        measure: player,
        phases: [
          { keys: [], durationMs: 200 },
          { keys: ["Space"], fixedTicks: SHORT_HOP_CANONICAL_TAP_TICKS },
          { keys: [], durationMs: 1100 },
        ],
      },
    ],
    metrics: [
      {
        metric: "shortHopApex",
        interactionId: "short-hop",
        derivation: "trajectory",
        stimulus: {
          metric: "shortHopApex",
          tapTicks: SHORT_HOP_CANONICAL_TAP_TICKS,
          phases: `[jump ${SHORT_HOP_CANONICAL_TAP_TICKS}t][jumpCut]`,
        },
      },
    ],
  };

  const result = await runFeelCaptureContract(contract, send);
  assert.equal(result.measurements.metrics.shortHopApex, 2);
  assert.equal(result.measurements.provenance.sources[0].stimulus, undefined);
});

test("runner does not certify short-hop stimulus from an idle fixed-tick phase", async () => {
  const send: FeelCaptureSend = async () => success({
    samples: arc,
    phases: [
      {
        index: 0,
        keys: [],
        requestedFixedTicks: SHORT_HOP_CANONICAL_TAP_TICKS,
        actualFixedTicks: SHORT_HOP_CANONICAL_TAP_TICKS,
        sampleCount: 1,
        deltaX: 0,
        deltaY: 0,
      },
      { index: 1, keys: ["Space"], sampleCount: 2, deltaX: 0, deltaY: 1 },
    ],
  });
  const contract: FeelCaptureContract = {
    schemaVersion: "1",
    subjects: [{ id: "player", locator: player }],
    interactions: [
      {
        id: "short-hop",
        kind: "keyboard",
        measure: player,
        phases: [
          { keys: [], fixedTicks: SHORT_HOP_CANONICAL_TAP_TICKS },
          { keys: ["Space"], durationMs: 300 },
        ],
      },
    ],
    metrics: [
      {
        metric: "shortHopApex",
        interactionId: "short-hop",
        derivation: "trajectory",
        stimulus: {
          metric: "shortHopApex",
          tapTicks: SHORT_HOP_CANONICAL_TAP_TICKS,
          phases: `[jump ${SHORT_HOP_CANONICAL_TAP_TICKS}t][jumpCut]`,
        },
      },
    ],
  };

  const result = await runFeelCaptureContract(contract, send);
  assert.equal(result.measurements.metrics.shortHopApex, 2);
  assert.equal(result.measurements.provenance.sources[0].stimulus, undefined);
});

test("runner does not certify short-hop stimulus from the wrong fixed-tick key phase", async () => {
  const send: FeelCaptureSend = async () => success({
    samples: arc,
    phases: [
      {
        index: 0,
        keys: ["LeftShift"],
        requestedFixedTicks: SHORT_HOP_CANONICAL_TAP_TICKS,
        actualFixedTicks: SHORT_HOP_CANONICAL_TAP_TICKS,
        sampleCount: 1,
        deltaX: 0,
        deltaY: 0.2,
      },
      { index: 1, keys: ["Space"], sampleCount: 2, deltaX: 0, deltaY: 1 },
      { index: 2, keys: [], sampleCount: 1, deltaX: 0, deltaY: 1 },
    ],
  });
  const contract: FeelCaptureContract = {
    schemaVersion: "1",
    subjects: [{ id: "player", locator: player }],
    interactions: [
      {
        id: "short-hop",
        kind: "keyboard",
        measure: player,
        phases: [
          { keys: ["LeftShift"], fixedTicks: SHORT_HOP_CANONICAL_TAP_TICKS },
          { keys: ["Space"], durationMs: 300 },
          { keys: [], durationMs: 700 },
        ],
      },
    ],
    metrics: [
      {
        metric: "shortHopApex",
        interactionId: "short-hop",
        derivation: "trajectory",
        stimulus: {
          metric: "shortHopApex",
          tapTicks: SHORT_HOP_CANONICAL_TAP_TICKS,
          phases: `[jump ${SHORT_HOP_CANONICAL_TAP_TICKS}t][jumpCut]`,
        },
      },
    ],
  };

  const result = await runFeelCaptureContract(contract, send);
  assert.equal(result.measurements.metrics.shortHopApex, 2);
  assert.equal(result.measurements.provenance.sources[0].stimulus, undefined);
});

test("runner does not certify short-hop stimulus when another active phase can cause the motion", async () => {
  const send: FeelCaptureSend = async () => success({
    samples: arc,
    phases: [
      { index: 0, keys: ["Space"], sampleCount: 2, deltaX: 0, deltaY: 1 },
      {
        index: 1,
        keys: ["LeftShift"],
        requestedFixedTicks: SHORT_HOP_CANONICAL_TAP_TICKS,
        actualFixedTicks: SHORT_HOP_CANONICAL_TAP_TICKS,
        sampleCount: 1,
        deltaX: 0,
        deltaY: 0.2,
      },
      { index: 2, keys: [], sampleCount: 1, deltaX: 0, deltaY: 1 },
    ],
  });
  const contract: FeelCaptureContract = {
    schemaVersion: "1",
    subjects: [{ id: "player", locator: player }],
    interactions: [
      {
        id: "short-hop",
        kind: "keyboard",
        measure: player,
        phases: [
          { keys: ["Space"], durationMs: 300 },
          { keys: ["LeftShift"], fixedTicks: SHORT_HOP_CANONICAL_TAP_TICKS },
          { keys: [], durationMs: 700 },
        ],
      },
    ],
    metrics: [
      {
        metric: "shortHopApex",
        interactionId: "short-hop",
        derivation: "trajectory",
        stimulus: {
          metric: "shortHopApex",
          tapTicks: SHORT_HOP_CANONICAL_TAP_TICKS,
          phases: `[jump ${SHORT_HOP_CANONICAL_TAP_TICKS}t][jumpCut]`,
        },
      },
    ],
  };

  const result = await runFeelCaptureContract(contract, send);
  assert.equal(result.measurements.metrics.shortHopApex, 2);
  assert.equal(result.measurements.provenance.sources[0].stimulus, undefined);
});

test("runner captures uGUI fixed-tick hold short-hop and emits verified stimulus", async () => {
  const calls: { command: string; params: Record<string, unknown> }[] = [];
  const send: FeelCaptureSend = async (command, params) => {
    calls.push({ command, params });
    return success({
      samples: arc,
      dispatch: { actuated: true, raycastHit: true, handlersFired: ["pointerDown", "pointerUp"] },
      holdDispatchMs: 400,
      releaseMs: 520,
      requestedFixedTicks: SHORT_HOP_CANONICAL_TAP_TICKS,
      actualFixedTicks: SHORT_HOP_CANONICAL_TAP_TICKS,
    });
  };
  const contract: FeelCaptureContract = {
    schemaVersion: "1",
    subjects: [{ id: "player", locator: player }],
    interactions: [
      {
        id: "short-hop-hold",
        kind: "ugui-hold",
        measure: player,
        target: { path: "/Jump" },
        holdFixedTicks: SHORT_HOP_CANONICAL_TAP_TICKS,
      },
    ],
    metrics: [
      {
        metric: "shortHopApex",
        interactionId: "short-hop-hold",
        derivation: "trajectory",
        stimulus: {
          metric: "shortHopApex",
          tapTicks: SHORT_HOP_CANONICAL_TAP_TICKS,
          phases: `[pointerDown ${SHORT_HOP_CANONICAL_TAP_TICKS}t][pointerUp]`,
        },
      },
    ],
  };

  const result = await runFeelCaptureContract(contract, send);
  assert.equal(calls[0].command, "runtime.capture_pointer_hold_motion");
  assert.equal(calls[0].params.releaseFixedTicks, SHORT_HOP_CANONICAL_TAP_TICKS);
  assert.equal(calls[0].params.dragTo, undefined);
  assert.equal(result.measurements.metrics.shortHopApex, 2);
  assert.deepEqual(result.measurements.provenance.sources[0].stimulus, {
    metric: "shortHopApex",
    tapTicks: SHORT_HOP_CANONICAL_TAP_TICKS,
    phases: `[pointerDown ${SHORT_HOP_CANONICAL_TAP_TICKS}t][pointerUp]`,
  });
});

test("runner gates uGUI fixed-tick short-hop on no-input settle observation", async () => {
  const calls: { command: string; params: Record<string, unknown> }[] = [];
  const send: FeelCaptureSend = async (command, params) => {
    calls.push({ command, params });
    if (command === "runtime.capture_input_motion") {
      throw new Error("uGUI settle must not use keyboard/Input-System capture");
    }
    if (command === "runtime.measure_motion") {
      return success(restingObservation);
    }
    if (command === "runtime.capture_pointer_hold_motion") {
      return success({
        samples: arc,
        dispatch: { actuated: true, raycastHit: true, handlersFired: ["pointerDown", "pointerUp"] },
        requestedFixedTicks: SHORT_HOP_CANONICAL_TAP_TICKS,
        actualFixedTicks: SHORT_HOP_CANONICAL_TAP_TICKS,
      });
    }
    throw new Error(`unexpected command ${command}`);
  };
  const contract: FeelCaptureContract = {
    schemaVersion: "1",
    subjects: [{ id: "player", locator: player }],
    interactions: [
      {
        id: "short-hop-hold",
        kind: "ugui-hold",
        measure: player,
        target: { path: "/Jump" },
        holdFixedTicks: SHORT_HOP_CANONICAL_TAP_TICKS,
        settle: {
          kind: "settle-until-rest",
          measure: player,
          timeoutMs: 1200,
          pollMs: 300,
          minStableSamples: 4,
          minStableMs: 100,
          restThreshold: 0.05,
        },
      },
    ],
    metrics: [
      {
        metric: "shortHopApex",
        interactionId: "short-hop-hold",
        derivation: "trajectory",
        stimulus: {
          metric: "shortHopApex",
          tapTicks: SHORT_HOP_CANONICAL_TAP_TICKS,
          phases: `[pointerDown ${SHORT_HOP_CANONICAL_TAP_TICKS}t][pointerUp]`,
        },
      },
    ],
  };

  const result = await runFeelCaptureContract(contract, send);
  assert.deepEqual(calls.map((c) => c.command), ["runtime.measure_motion", "runtime.capture_pointer_hold_motion"]);
  assert.deepEqual(calls[0].params, {
    locator: player,
    durationMs: 300,
    includeSamples: true,
  });
  assert.equal(result.measurements.metrics.shortHopApex, 2);
  assert.equal(result.measurements.captureCoverage[0].status, "measured");
  const settle = (result.raw[0].data as Record<string, unknown>).settle as Record<string, unknown>;
  assert.equal(settle.status, "rested");
  assert.deepEqual(result.measurements.provenance.sources[0].stimulus, {
    metric: "shortHopApex",
    tapTicks: SHORT_HOP_CANONICAL_TAP_TICKS,
    phases: `[pointerDown ${SHORT_HOP_CANONICAL_TAP_TICKS}t][pointerUp]`,
  });
});

test("runner blocks uGUI short-hop when no-input settle times out", async () => {
  const calls: { command: string; params: Record<string, unknown> }[] = [];
  const send: FeelCaptureSend = async (command, params) => {
    calls.push({ command, params });
    if (command === "runtime.measure_motion") {
      return success(fallingObservation);
    }
    throw new Error("pointer hold must not run when uGUI settle is blocked");
  };
  const contract: FeelCaptureContract = {
    schemaVersion: "1",
    subjects: [{ id: "player", locator: player }],
    interactions: [
      {
        id: "short-hop-hold",
        kind: "ugui-hold",
        measure: player,
        target: { path: "/Jump" },
        holdFixedTicks: SHORT_HOP_CANONICAL_TAP_TICKS,
        settle: {
          kind: "settle-until-rest",
          measure: player,
          timeoutMs: 600,
          pollMs: 300,
          minStableSamples: 4,
          minStableMs: 100,
          restThreshold: 0.05,
        },
      },
    ],
    metrics: [
      {
        metric: "shortHopApex",
        interactionId: "short-hop-hold",
        derivation: "trajectory",
        stimulus: {
          metric: "shortHopApex",
          tapTicks: SHORT_HOP_CANONICAL_TAP_TICKS,
          phases: `[pointerDown ${SHORT_HOP_CANONICAL_TAP_TICKS}t][pointerUp]`,
        },
      },
    ],
  };

  const result = await runFeelCaptureContract(contract, send);
  assert.deepEqual(calls.map((c) => c.command), ["runtime.measure_motion", "runtime.measure_motion"]);
  assert.equal(result.measurements.metrics.shortHopApex, undefined);
  assert.equal(result.measurements.captureCoverage[0].status, "attempted-blocked");
  assert.equal(result.measurements.captureCoverage[0].source, "runtime.measure_motion");
  const settle = (result.raw[0].data as Record<string, unknown>).settle as Record<string, unknown>;
  assert.equal(settle.status, "timeout");
});

test("runner does not certify uGUI short-hop without matching fixed-tick hold evidence", async () => {
  const send: FeelCaptureSend = async () => success({
    samples: arc,
    dispatch: { actuated: true, raycastHit: true, handlersFired: ["pointerDown", "pointerUp"] },
    requestedFixedTicks: SHORT_HOP_CANONICAL_TAP_TICKS,
    actualFixedTicks: SHORT_HOP_CANONICAL_TAP_TICKS + 1,
  });
  const contract: FeelCaptureContract = {
    schemaVersion: "1",
    subjects: [{ id: "player", locator: player }],
    interactions: [
      {
        id: "short-hop-hold",
        kind: "ugui-hold",
        measure: player,
        target: { path: "/Jump" },
        holdFixedTicks: SHORT_HOP_CANONICAL_TAP_TICKS,
      },
    ],
    metrics: [
      {
        metric: "shortHopApex",
        interactionId: "short-hop-hold",
        derivation: "trajectory",
        stimulus: {
          metric: "shortHopApex",
          tapTicks: SHORT_HOP_CANONICAL_TAP_TICKS,
          phases: `[pointerDown ${SHORT_HOP_CANONICAL_TAP_TICKS}t][pointerUp]`,
        },
      },
    ],
  };

  const result = await runFeelCaptureContract(contract, send);
  assert.equal(result.measurements.metrics.shortHopApex, 2);
  assert.equal(result.measurements.provenance.sources[0].stimulus, undefined);
});

test("runner does not certify uGUI short-hop when pointer hold missed the raycast target", async () => {
  const send: FeelCaptureSend = async () => success({
    samples: arc,
    dispatch: { actuated: true, raycastHit: false, handlersFired: ["pointerDown", "pointerUp"] },
    requestedFixedTicks: SHORT_HOP_CANONICAL_TAP_TICKS,
    actualFixedTicks: SHORT_HOP_CANONICAL_TAP_TICKS,
  });
  const contract: FeelCaptureContract = {
    schemaVersion: "1",
    subjects: [{ id: "player", locator: player }],
    interactions: [
      {
        id: "short-hop-hold",
        kind: "ugui-hold",
        measure: player,
        target: { path: "/Jump" },
        holdFixedTicks: SHORT_HOP_CANONICAL_TAP_TICKS,
      },
    ],
    metrics: [
      {
        metric: "shortHopApex",
        interactionId: "short-hop-hold",
        derivation: "trajectory",
        stimulus: {
          metric: "shortHopApex",
          tapTicks: SHORT_HOP_CANONICAL_TAP_TICKS,
          phases: `[pointerDown ${SHORT_HOP_CANONICAL_TAP_TICKS}t][pointerUp]`,
        },
      },
    ],
  };

  const result = await runFeelCaptureContract(contract, send);
  assert.equal(result.measurements.metrics.shortHopApex, 2);
  assert.equal(result.measurements.provenance.sources[0].stimulus, undefined);
});

test("runner scopes stimulus provenance to the measured interaction", async () => {
  const send: FeelCaptureSend = async () => success({
      samples: arc,
      phases: [
        { index: 0, keys: [], sampleCount: 1, deltaX: 0, deltaY: 0 },
        {
          index: 1,
          keys: ["Space"],
          requestedFixedTicks: SHORT_HOP_CANONICAL_TAP_TICKS,
          actualFixedTicks: SHORT_HOP_CANONICAL_TAP_TICKS,
          sampleCount: 2,
          deltaX: 0,
          deltaY: 1,
        },
      ],
    });
  const contract: FeelCaptureContract = {
    schemaVersion: "1",
    subjects: [{ id: "player", locator: player }],
    interactions: [
      {
        id: "other-short-hop",
        kind: "keyboard",
        measure: { scene: "Scene_1", path: "/OtherPlayer" },
        phases: [{ keys: ["Space"], fixedTicks: SHORT_HOP_CANONICAL_TAP_TICKS }],
      },
      {
        id: "jump",
        kind: "keyboard",
        measure: player,
        phases: [{ keys: ["Space"], durationMs: 300 }],
      },
    ],
    metrics: [
      {
        metric: "shortHopApex",
        interactionId: "other-short-hop",
        derivation: "trajectory",
        stimulus: {
          metric: "shortHopApex",
          tapTicks: SHORT_HOP_CANONICAL_TAP_TICKS,
          phases: `[jump ${SHORT_HOP_CANONICAL_TAP_TICKS}t][jumpCut]`,
        },
      },
      { metric: "jumpApex", interactionId: "jump", derivation: "trajectory" },
    ],
  };

  const result = await runFeelCaptureContract(contract, send);
  const jumpSource = result.measurements.provenance.sources.find((s) =>
    Array.isArray(s.measuredMetrics) && s.measuredMetrics.includes("jumpApex")
  );
  assert.equal(jumpSource?.stimulus, undefined);
});

test("runner refuses pointer captures without positive actuation evidence", async () => {
  const tapContract: FeelCaptureContract = {
    schemaVersion: "1",
    subjects: [{ id: "player", locator: player }],
    interactions: [{ id: "jump", kind: "ugui-tap", measure: player, target: { path: "/Jump" } }],
    metrics: [{ metric: "jumpApex", interactionId: "jump", derivation: "trajectory" }],
  };
  const tapResult = await runFeelCaptureContract(tapContract, async () => success({ samples: arc }));
  assert.equal(tapResult.measurements.metrics.jumpApex, undefined);
  assert.equal(tapResult.measurements.captureCoverage[0].status, "attempted-blocked");

  const multitapContract: FeelCaptureContract = {
    schemaVersion: "1",
    subjects: [{ id: "player", locator: player }],
    interactions: [
      { id: "double", kind: "ugui-multitap", measure: player, target: { path: "/Jump" }, taps: [{ atMs: 400 }, { atMs: 580 }] },
    ],
    metrics: [{ metric: "doubleJumpApex", interactionId: "double", derivation: "trajectory", deriveAs: "jumpApex" }],
  };
  const multitapResult = await runFeelCaptureContract(multitapContract, async () => success({
    samples: arc,
    taps: [{ actuated: true }],
  }));
  assert.equal(multitapResult.measurements.metrics.doubleJumpApex, undefined);
  assert.equal(multitapResult.measurements.captureCoverage[0].status, "attempted-blocked");
});

test("runner maps hold-drag no-actuation to attempted-blocked, not a fabricated run speed", async () => {
  const send: FeelCaptureSend = async () => success({
    samples: arc,
    dispatch: { actuated: false },
  });
  const contract: FeelCaptureContract = {
    schemaVersion: "1",
    subjects: [{ id: "player", locator: player }],
    interactions: [
      { id: "run", kind: "ugui-hold-drag", measure: player, target: { path: "/Stick" }, dragTo: { dx: 220, dy: 0 } },
    ],
    metrics: [{ metric: "runSpeed", interactionId: "run", derivation: "trajectory" }],
  };
  const result = await runFeelCaptureContract(contract, send);
  assert.equal(result.measurements.metrics.runSpeed, undefined);
  assert.equal(result.measurements.captureCoverage[0].status, "attempted-blocked");
  assert.match(result.measurements.captureCoverage[0].reason ?? "", /positive actuation evidence/);
});

test("runner executes world-pointer in-loop and requires movement evidence", async () => {
  const calls: { command: string; params: Record<string, unknown> }[] = [];
  const send: FeelCaptureSend = async (command, params) => {
    calls.push({ command, params });
    if (command === "editor.focus_game_view") {
      return success({ gameViewAvailable: true, gameViewFocused: true });
    }
    return success({
      samples: [
        { tMs: 0, x: 0, y: 0 },
        { tMs: 300, x: 0, y: 0 },
        { tMs: 400, x: 0, y: 1 },
        { tMs: 500, x: 0, y: 2 },
      ],
      dispatch: {
        atMs: 300,
        dispatchedMs: 300,
        actuated: null,
        mode: "world-input-system",
        world: { x: 10, y: 20, z: 0 },
        screen: { x: 400, y: 200, z: 10 },
      },
    });
  };
  const contract: FeelCaptureContract = {
    schemaVersion: "1",
    subjects: [{ id: "player", locator: player }],
    interactions: [{ id: "world", kind: "world-pointer", measure: player, x: 10, y: 20, captureMs: 900 }],
    metrics: [{ metric: "jumpApex", interactionId: "world", derivation: "trajectory" }],
  };

  const result = await runFeelCaptureContract(contract, send);
  assert.deepEqual(calls.map((c) => c.command), ["editor.focus_game_view", "runtime.capture_pointer_motion"]);
  assert.deepEqual(calls[0].params, {});
  assert.deepEqual(calls[1].params, {
    measure: player,
    world: { x: 10, y: 20 },
    settleMs: 300,
    captureMs: 900,
    includeSamples: true,
    sampledFields: undefined,
  });
  assert.equal(result.measurements.metrics.jumpApex, 2);
  assert.equal(result.measurements.captureCoverage[0].status, "measured");
  assert.equal(result.measurements.provenance.sources[0].source, "runtime.capture_pointer_motion");
  assert.equal(result.raw[0].data?.dispatch && (result.raw[0].data.dispatch as { actuated?: boolean | null }).actuated, null);
});

test("runner blocks world-pointer when Game View focus cannot be acquired", async () => {
  const calls: string[] = [];
  const send: FeelCaptureSend = async (command) => {
    calls.push(command);
    if (command === "editor.focus_game_view") {
      return {
        id: "1",
        status: "error" as const,
        error: { code: "FOCUS_REQUIRED", message: "Game View focus unavailable" },
        data: null,
        timestamp: Date.now(),
      };
    }
    throw new Error("world pointer dispatch should not run without focus");
  };
  const contract: FeelCaptureContract = {
    schemaVersion: "1",
    subjects: [{ id: "player", locator: player }],
    interactions: [{ id: "world", kind: "world-pointer", measure: player, x: 10, y: 20 }],
    metrics: [{ metric: "jumpApex", interactionId: "world", derivation: "trajectory" }],
  };

  const result = await runFeelCaptureContract(contract, send);
  assert.deepEqual(calls, ["editor.focus_game_view"]);
  assert.equal(result.measurements.metrics.jumpApex, undefined);
  assert.equal(result.raw[0].source, "editor.focus_game_view");
  assert.equal(result.measurements.captureCoverage[0].status, "attempted-blocked");
  assert.match(result.measurements.captureCoverage[0].reason ?? "", /FOCUS_REQUIRED|focus unavailable/i);
});

test("runner blocks world-pointer when dispatch has no measured motion", async () => {
  const calls: string[] = [];
  const contract: FeelCaptureContract = {
    schemaVersion: "1",
    subjects: [{ id: "player", locator: player }],
    interactions: [{ id: "world", kind: "world-pointer", measure: player, x: 10, y: 20 }],
    metrics: [{ metric: "jumpApex", interactionId: "world", derivation: "trajectory" }],
  };

  const result = await runFeelCaptureContract(contract, async (command) => {
    calls.push(command);
    if (command === "editor.focus_game_view") {
      return success({ gameViewAvailable: true, gameViewFocused: true });
    }
    return success({
      samples: [
        { tMs: 300, x: 0, y: 0 },
        { tMs: 400, x: 0, y: 0 },
      ],
      dispatch: { atMs: 300, dispatchedMs: 300, actuated: null, mode: "world-input-system" },
    });
  });
  assert.deepEqual(calls, ["editor.focus_game_view", "runtime.capture_pointer_motion"]);
  assert.equal(result.measurements.metrics.jumpApex, undefined);
  assert.equal(result.measurements.captureCoverage[0].status, "attempted-blocked");
  assert.match(result.measurements.captureCoverage[0].reason ?? "", /no measured subject motion/);
});

test("runner preserves semantic-probe trials but blocks coyoteTime until anchors are observed", async () => {
  const calls: { command: string; params: Record<string, unknown> }[] = [];
  const send: FeelCaptureSend = async (command, params) => {
    calls.push({ command, params });
    const trialIndex = calls.length - 1;
    return success({
      samples: trialIndex === 0
        ? [
            { tMs: 0, x: 0, y: 0 },
            { tMs: 80, x: 0, y: 0 },
            { tMs: 180, x: 0, y: 0.2 },
          ]
        : [
            { tMs: 0, x: 0, y: 0 },
            { tMs: 140, x: 0, y: 0 },
            { tMs: 240, x: 0, y: 0 },
          ],
      captureFps: 120,
      projectFixedTimestepBeforeMeasurement: 0.016667,
      measurementFixedTimestep: 0.016667,
    });
  };
  const contract: FeelCaptureContract = {
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
              { durationMs: 400, drivers: [{ locator: player, type_name: "TestDriver", property_path: "jump", value: true }] },
            ],
          },
          {
            delayMs: 140,
            phases: [
              { durationMs: 140, drivers: [{ locator: player, type_name: "TestDriver", property_path: "jump", value: false }] },
              { durationMs: 400, drivers: [{ locator: player, type_name: "TestDriver", property_path: "jump", value: true }] },
            ],
          },
        ],
        jumpEvidence: { kind: "trajectory-rise", afterAnchorId: "jump", minRise: 0.05 },
      },
    ],
    metrics: [{ metric: "coyoteTime", interactionId: "coyote-semantic", derivation: "bisection" }],
  };

  const result = await runFeelCaptureContract(contract, send);
  assert.deepEqual(calls.map((c) => c.command), ["runtime.probe", "runtime.probe"]);
  assert.equal(result.measurements.metrics.coyoteTime, undefined);
  assert.equal(result.measurements.captureCoverage[0].status, "attempted-blocked");
  assert.equal(result.measurements.captureCoverage[0].source, "runtime.probe");
  assert.match(result.measurements.captureCoverage[0].reason ?? "", /anchors are declared phase labels/i);
  assert.deepEqual(result.measurements.provenance.sources[0].measuredMetrics, []);
  const trials = (result.raw[0].data as Record<string, unknown>).trials as Array<{
    delayMs: number;
    requestedDelayMs: number;
    jumped: boolean;
  }>;
  assert.deepEqual(trials.map((t) => [t.delayMs, t.requestedDelayMs, t.jumped]), [
    [80, 80, true],
    [140, 140, false],
  ]);
});

test("runner blocks semantic probes when declared delay does not match anchor timing", async () => {
  const contract: FeelCaptureContract = {
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
            delayMs: 500,
            phases: [
              { durationMs: 80, drivers: [{ locator: player, type_name: "TestDriver", property_path: "jump", value: false }] },
              { durationMs: 400, drivers: [{ locator: player, type_name: "TestDriver", property_path: "jump", value: true }] },
            ],
          },
          {
            delayMs: 600,
            phases: [
              { durationMs: 140, drivers: [{ locator: player, type_name: "TestDriver", property_path: "jump", value: false }] },
              { durationMs: 400, drivers: [{ locator: player, type_name: "TestDriver", property_path: "jump", value: true }] },
            ],
          },
        ],
        jumpEvidence: { kind: "trajectory-rise", afterAnchorId: "jump", minRise: 0.05 },
      },
    ],
    metrics: [{ metric: "coyoteTime", interactionId: "coyote-semantic", derivation: "bisection" }],
  };

  const result = await runFeelCaptureContract(contract, async () => success({
    samples: [
      { tMs: 0, x: 0, y: 0 },
      { tMs: 80, x: 0, y: 0 },
      { tMs: 180, x: 0, y: 0.2 },
    ],
  }));

  assert.equal(result.measurements.metrics.coyoteTime, undefined);
  assert.equal(result.measurements.captureCoverage[0].status, "attempted-blocked");
  assert.match(result.measurements.captureCoverage[0].reason ?? "", /declared delayMs 500 but anchor timing is 80ms/);
});

test("runner blocks semantic probes when a trial has no raw trajectory samples", async () => {
  const contract: FeelCaptureContract = {
    schemaVersion: "1",
    subjects: [{ id: "player", locator: player }],
    interactions: [
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
              { durationMs: 400, drivers: [{ locator: player, type_name: "TestDriver", property_path: "jump", value: false }] },
            ],
          },
          {
            delayMs: 130,
            phases: [
              { durationMs: 130, drivers: [{ locator: player, type_name: "TestDriver", property_path: "jump", value: true }] },
              { durationMs: 400, drivers: [{ locator: player, type_name: "TestDriver", property_path: "jump", value: false }] },
            ],
          },
        ],
        jumpEvidence: { kind: "trajectory-rise", afterAnchorId: "land" },
      },
    ],
    metrics: [{ metric: "jumpBuffer", interactionId: "buffer-semantic", derivation: "bisection" }],
  };

  const result = await runFeelCaptureContract(contract, async () => success({ samples: [] }));
  assert.equal(result.measurements.metrics.jumpBuffer, undefined);
  assert.equal(result.measurements.captureCoverage[0].status, "attempted-blocked");
  assert.equal(result.measurements.captureCoverage[0].source, "runtime.probe");
  assert.match(result.measurements.captureCoverage[0].reason ?? "", /no trajectory samples/);
});

test("runner preserves unsupported legacy input as unsupported coverage", async () => {
  const send: FeelCaptureSend = async () => {
    throw new Error("should not call bridge for unsupported recipes");
  };
  const contract: FeelCaptureContract = {
    schemaVersion: "1",
    subjects: [{ id: "player", locator: player }],
    interactions: [{ id: "legacy", kind: "unsupported", reason: "legacy Input.GetKey without UI" }],
    metrics: [{ metric: "runSpeed", interactionId: "legacy", derivation: "trajectory" }],
  };
  const result = await runFeelCaptureContract(contract, send);
  assert.equal(result.measurements.metrics.runSpeed, undefined);
  assert.equal(result.measurements.captureCoverage[0].status, "unsupported");
});

test("runner derives input-to-anim sync from sampled fieldTimeline", async () => {
  const send: FeelCaptureSend = async () => success({
    dispatch: { actuated: true, dispatchedMs: 100 },
    samples: arc,
    fieldTimeline: [
      {
        id: "anim-jumping",
        samples: [
          { tMs: 0, value: false },
          { tMs: 100, value: false },
          { tMs: 140, value: true },
        ],
      },
    ],
  });
  const contract: FeelCaptureContract = {
    schemaVersion: "1",
    subjects: [{ id: "player", locator: player }],
    interactions: [
      {
        id: "jump",
        kind: "ugui-tap",
        measure: player,
        target: { path: "/Jump" },
        sampledFields: [
          {
            id: "anim-jumping",
            locator: player,
            type_name: "Animator",
            method_name: "GetBool",
            args: ["jumping"],
          },
        ],
      },
    ],
    metrics: [
      { metric: "jumpApex", interactionId: "jump", derivation: "trajectory" },
      {
        metric: "inputToAnimStateLatency",
        interactionId: "jump",
        derivation: "sync",
        seriesId: "anim-jumping",
        targetValue: true,
      },
    ],
  };

  const result = await runFeelCaptureContract(contract, send);
  assert.equal(result.measurements.metrics.jumpApex, 2);
  assert.equal(result.measurements.metrics.inputToAnimStateLatency, 40);
  assert.deepEqual(
    result.measurements.provenance.sources.map((s) => [s.derivation, s.measuredMetrics, s.inputOnsetMs]),
    [["trajectory", ["jumpApex"], 100], ["sync", ["inputToAnimStateLatency"], 100]],
  );
});

test("runner derives shooter fireIntervalMs from sampled shot counter", async () => {
  const send: FeelCaptureSend = async () => success({
    dispatch: { actuated: true, dispatchedMs: 100 },
    samples: arc,
    phases: [{ index: 0, keys: ["Mouse0"], sampleCount: 3, deltaX: 0, deltaY: 0 }],
    fieldTimeline: [
      {
        id: "weapon-fire-count",
        samples: [
          { tMs: 0, value: 0 },
          { tMs: 100, value: 1 },
          { tMs: 220, value: 2 },
          { tMs: 340, value: 3 },
        ],
      },
    ],
  });
  const contract: FeelCaptureContract = {
    schemaVersion: "1",
    subjects: [{ id: "player", locator: player }],
    interactions: [
      {
        id: "hold-fire",
        kind: "keyboard",
        measure: player,
        phases: [{ keys: ["Mouse0"], durationMs: 420 }],
        sampledFields: [
          {
            id: "weapon-fire-count",
            locator: { path: "/Player/Weapon" },
            type_name: "Weapon",
            property_path: "FireCount",
          },
        ],
      },
    ],
    metrics: [
      {
        metric: "fireIntervalMs",
        interactionId: "hold-fire",
        derivation: "sync",
        seriesId: "weapon-fire-count",
      },
    ],
  };

  const result = await runFeelCaptureContract(contract, send);
  assert.equal(result.measurements.metrics.fireIntervalMs, 120);
  assert.deepEqual(result.measurements.captureCoverage, [
    {
      metric: "fireIntervalMs",
      status: "measured",
      interactionId: "hold-fire",
      source: "runtime.capture_input_motion",
    },
  ]);
  assert.deepEqual(
    result.measurements.provenance.sources.map((s) => [s.derivation, s.measuredMetrics, s.inputOnsetMs]),
    [["sync", ["fireIntervalMs"], 0]],
  );
});

test("runner derives projectileSpeed from sampled projectile trajectory", async () => {
  const send: FeelCaptureSend = async () => success({
    dispatch: { actuated: true, dispatchedMs: 100 },
    samples: [
      { tMs: 0, x: 0, y: 0 },
      { tMs: 50, x: 0, y: 0 },
      { tMs: 100, x: 0, y: 0 },
      { tMs: 150, x: 0.9, y: 0 },
      { tMs: 200, x: 1.8, y: 0 },
      { tMs: 250, x: 2.7, y: 0 },
    ],
    phases: [{ index: 0, keys: ["Mouse0"], sampleCount: 6, deltaX: 2.7, deltaY: 0 }],
  });
  const contract: FeelCaptureContract = {
    schemaVersion: "1",
    subjects: [{ id: "projectile", locator: { path: "/Projectile" } }],
    interactions: [
      {
        id: "fire-projectile",
        kind: "keyboard",
        measure: { path: "/Projectile" },
        phases: [{ keys: ["Mouse0"], durationMs: 300 }],
      },
    ],
    metrics: [
      {
        metric: "projectileSpeed",
        interactionId: "fire-projectile",
        derivation: "trajectory",
      },
    ],
  };

  const result = await runFeelCaptureContract(contract, send);
  assert.equal(result.measurements.metrics.projectileSpeed, 18);
  assert.deepEqual(result.measurements.captureCoverage, [
    {
      metric: "projectileSpeed",
      status: "measured",
      interactionId: "fire-projectile",
      source: "runtime.capture_input_motion",
    },
  ]);
  assert.deepEqual(
    result.measurements.provenance.sources.map((s) => [s.derivation, s.measuredMetrics]),
    [["trajectory", ["projectileSpeed"]]],
  );
});

test("runner derives fireInputToSpawnLatency from sampled projectile spawn signal", async () => {
  const send: FeelCaptureSend = async () => success({
    dispatch: { actuated: true, dispatchedMs: 100 },
    samples: arc,
    phases: [{ index: 0, keys: ["Mouse0"], sampleCount: 3, deltaX: 0, deltaY: 0 }],
    fieldTimeline: [
      {
        id: "projectile-spawn-count",
        samples: [
          { tMs: 0, value: 0 },
          { tMs: 100, value: 0 },
          { tMs: 145, value: 1 },
          { tMs: 220, value: 1 },
        ],
      },
    ],
  });
  const contract: FeelCaptureContract = {
    schemaVersion: "1",
    subjects: [{ id: "player", locator: player }],
    interactions: [
      {
        id: "fire-once",
        kind: "keyboard",
        measure: player,
        phases: [{ keys: ["Mouse0"], durationMs: 250 }],
        sampledFields: [
          {
            id: "projectile-spawn-count",
            locator: { path: "/Player/Weapon" },
            type_name: "Weapon",
            property_path: "ProjectileSpawnCount",
          },
        ],
      },
    ],
    metrics: [
      {
        metric: "fireInputToSpawnLatency",
        interactionId: "fire-once",
        derivation: "sync",
        seriesId: "projectile-spawn-count",
      },
    ],
  };

  const result = await runFeelCaptureContract(contract, send);
  assert.equal(result.measurements.metrics.fireInputToSpawnLatency, 145);
  assert.deepEqual(result.measurements.captureCoverage, [
    {
      metric: "fireInputToSpawnLatency",
      status: "measured",
      interactionId: "fire-once",
      source: "runtime.capture_input_motion",
    },
  ]);
  assert.deepEqual(
    result.measurements.provenance.sources.map((s) => [s.derivation, s.measuredMetrics, s.inputOnsetMs]),
    [["sync", ["fireInputToSpawnLatency"], 0]],
  );
});

test("runner omits fireInputToSpawnLatency when no projectile spawn edge is observed", async () => {
  const send: FeelCaptureSend = async () => success({
    dispatch: { actuated: true, dispatchedMs: 100 },
    samples: arc,
    phases: [{ index: 0, keys: ["Mouse0"], sampleCount: 3, deltaX: 0, deltaY: 0 }],
    fieldTimeline: [
      {
        id: "projectile-spawn-count",
        samples: [
          { tMs: 0, value: 0 },
          { tMs: 100, value: 0 },
          { tMs: 220, value: 0 },
        ],
      },
    ],
  });
  const contract: FeelCaptureContract = {
    schemaVersion: "1",
    subjects: [{ id: "player", locator: player }],
    interactions: [
      {
        id: "fire-once",
        kind: "keyboard",
        measure: player,
        phases: [{ keys: ["Mouse0"], durationMs: 250 }],
        sampledFields: [
          {
            id: "projectile-spawn-count",
            locator: { path: "/Player/Weapon" },
            type_name: "Weapon",
            property_path: "ProjectileSpawnCount",
          },
        ],
      },
    ],
    metrics: [
      {
        metric: "fireInputToSpawnLatency",
        interactionId: "fire-once",
        derivation: "sync",
        seriesId: "projectile-spawn-count",
      },
    ],
  };

  const result = await runFeelCaptureContract(contract, send);
  assert.equal(result.measurements.metrics.fireInputToSpawnLatency, undefined);
  assert.equal(result.measurements.captureCoverage[0].status, "not-measured");
  assert.match(result.measurements.captureCoverage[0].reason ?? "", /spawn edge/i);
});

test("runner derives ttkMs from a reference-enemy first-hit series and death series (series→series)", async () => {
  const send: FeelCaptureSend = async () => success({
    dispatch: { actuated: true, dispatchedMs: 100 },
    samples: arc,
    phases: [{ index: 0, keys: ["Mouse0"], sampleCount: 3, deltaX: 0, deltaY: 0 }],
    fieldTimeline: [
      {
        id: "enemy-hit-count",
        samples: [
          { tMs: 0, value: 0 },
          { tMs: 200, value: 1 },
          { tMs: 400, value: 2 },
        ],
      },
      {
        id: "enemy-is-dead",
        samples: [
          { tMs: 0, value: false },
          { tMs: 400, value: false },
          { tMs: 500, value: true },
        ],
      },
    ],
  });
  const contract: FeelCaptureContract = {
    schemaVersion: "1",
    subjects: [{ id: "player", locator: player }],
    interactions: [
      {
        id: "fire-once",
        kind: "keyboard",
        measure: player,
        phases: [{ keys: ["Mouse0"], durationMs: 600 }],
        sampledFields: [
          {
            id: "enemy-hit-count",
            locator: { path: "/Enemy" },
            type_name: "Enemy",
            property_path: "HitCount",
          },
          {
            id: "enemy-is-dead",
            locator: { path: "/Enemy" },
            type_name: "Enemy",
            property_path: "IsDead",
          },
        ],
      },
    ],
    metrics: [
      {
        metric: "ttkMs",
        interactionId: "fire-once",
        derivation: "sync",
        seriesId: "enemy-is-dead",
        referenceSeriesId: "enemy-hit-count",
      },
    ],
  };

  const result = await runFeelCaptureContract(contract, send);
  // death edge (500) − first-hit edge (200) = 300, independent of input onset.
  assert.equal(result.measurements.metrics.ttkMs, 300);
  assert.equal(result.measurements.captureCoverage[0].status, "measured");
  assert.deepEqual(
    result.measurements.provenance.sources.map((s) => [s.derivation, s.measuredMetrics]),
    [["sync", ["ttkMs"]]],
  );
});

test("runner omits ttkMs when the reference enemy never dies in-window", async () => {
  const send: FeelCaptureSend = async () => success({
    dispatch: { actuated: true, dispatchedMs: 100 },
    samples: arc,
    phases: [{ index: 0, keys: ["Mouse0"], sampleCount: 3, deltaX: 0, deltaY: 0 }],
    fieldTimeline: [
      {
        id: "enemy-hit-count",
        samples: [
          { tMs: 0, value: 0 },
          { tMs: 200, value: 1 },
        ],
      },
      {
        id: "enemy-is-dead",
        samples: [
          { tMs: 0, value: false },
          { tMs: 500, value: false },
        ],
      },
    ],
  });
  const contract: FeelCaptureContract = {
    schemaVersion: "1",
    subjects: [{ id: "player", locator: player }],
    interactions: [
      {
        id: "fire-once",
        kind: "keyboard",
        measure: player,
        phases: [{ keys: ["Mouse0"], durationMs: 600 }],
        sampledFields: [
          { id: "enemy-hit-count", locator: { path: "/Enemy" }, type_name: "Enemy", property_path: "HitCount" },
          { id: "enemy-is-dead", locator: { path: "/Enemy" }, type_name: "Enemy", property_path: "IsDead" },
        ],
      },
    ],
    metrics: [
      {
        metric: "ttkMs",
        interactionId: "fire-once",
        derivation: "sync",
        seriesId: "enemy-is-dead",
        referenceSeriesId: "enemy-hit-count",
      },
    ],
  };

  const result = await runFeelCaptureContract(contract, send);
  assert.equal(result.measurements.metrics.ttkMs, undefined);
  assert.equal(result.measurements.captureCoverage[0].status, "not-measured");
  assert.match(result.measurements.captureCoverage[0].reason ?? "", /never died/i);
});

test("runner omits projectileSpeed when the projectile never moves enough", async () => {
  const send: FeelCaptureSend = async () => success({
    dispatch: { actuated: true, dispatchedMs: 100 },
    samples: [
      { tMs: 0, x: 0, y: 0 },
      { tMs: 50, x: 0, y: 0 },
      { tMs: 100, x: 0, y: 0 },
      { tMs: 150, x: 0.5, y: 0 },
    ],
    phases: [{ index: 0, keys: ["Mouse0"], sampleCount: 4, deltaX: 0.5, deltaY: 0 }],
  });
  const contract: FeelCaptureContract = {
    schemaVersion: "1",
    subjects: [{ id: "projectile", locator: { path: "/Projectile" } }],
    interactions: [
      {
        id: "fire-projectile",
        kind: "keyboard",
        measure: { path: "/Projectile" },
        phases: [{ keys: ["Mouse0"], durationMs: 200 }],
      },
    ],
    metrics: [{ metric: "projectileSpeed", interactionId: "fire-projectile", derivation: "trajectory" }],
  };

  const result = await runFeelCaptureContract(contract, send);
  assert.equal(result.measurements.metrics.projectileSpeed, undefined);
  assert.equal(result.measurements.captureCoverage[0].status, "not-measured");
  assert.match(result.measurements.captureCoverage[0].reason ?? "", /could not be derived/);
});

test("runner refuses shooter fireIntervalMs when fewer than two shot edges are observed", async () => {
  const send: FeelCaptureSend = async () => success({
    dispatch: { actuated: true, dispatchedMs: 100 },
    samples: arc,
    phases: [{ index: 0, keys: ["Mouse0"], sampleCount: 3, deltaX: 0, deltaY: 0 }],
    fieldTimeline: [
      {
        id: "weapon-fire-count",
        samples: [
          { tMs: 0, value: 0 },
          { tMs: 100, value: 1 },
          { tMs: 220, value: 1 },
        ],
      },
    ],
  });
  const contract: FeelCaptureContract = {
    schemaVersion: "1",
    subjects: [{ id: "player", locator: player }],
    interactions: [
      {
        id: "hold-fire",
        kind: "keyboard",
        measure: player,
        phases: [{ keys: ["Mouse0"], durationMs: 300 }],
        sampledFields: [
          {
            id: "weapon-fire-count",
            locator: { path: "/Player/Weapon" },
            type_name: "Weapon",
            property_path: "FireCount",
          },
        ],
      },
    ],
    metrics: [
      {
        metric: "fireIntervalMs",
        interactionId: "hold-fire",
        derivation: "sync",
        seriesId: "weapon-fire-count",
      },
    ],
  };

  const result = await runFeelCaptureContract(contract, send);
  assert.equal(result.measurements.metrics.fireIntervalMs, undefined);
  assert.equal(result.measurements.captureCoverage[0].status, "not-measured");
  assert.match(result.measurements.captureCoverage[0].reason ?? "", /at least two observed fire events/);
});

test("runner refuses shooter fireIntervalMs when keyboard phase lacks the requested fire key", async () => {
  const send: FeelCaptureSend = async () => success({
    dispatch: { actuated: true, dispatchedMs: 100 },
    samples: arc,
    phases: [{ index: 0, keys: ["Space"], sampleCount: 3, deltaX: 0, deltaY: 0 }],
    fieldTimeline: [
      {
        id: "weapon-fire-count",
        samples: [
          { tMs: 0, value: 0 },
          { tMs: 100, value: 1 },
          { tMs: 220, value: 2 },
          { tMs: 340, value: 3 },
        ],
      },
    ],
  });
  const contract: FeelCaptureContract = {
    schemaVersion: "1",
    subjects: [{ id: "player", locator: player }],
    interactions: [
      {
        id: "hold-fire",
        kind: "keyboard",
        measure: player,
        phases: [{ keys: ["Mouse0"], durationMs: 420 }],
        sampledFields: [
          {
            id: "weapon-fire-count",
            locator: { path: "/Player/Weapon" },
            type_name: "Weapon",
            property_path: "FireCount",
          },
        ],
      },
    ],
    metrics: [
      {
        metric: "fireIntervalMs",
        interactionId: "hold-fire",
        derivation: "sync",
        seriesId: "weapon-fire-count",
      },
    ],
  };

  const result = await runFeelCaptureContract(contract, send);
  assert.equal(result.measurements.metrics.fireIntervalMs, undefined);
  assert.equal(result.measurements.captureCoverage[0].status, "attempted-blocked");
  assert.match(result.measurements.captureCoverage[0].reason ?? "", /did not hold requested key/);
});

test("runner refuses shooter fireIntervalMs when keyboard active phase is missing", async () => {
  const send: FeelCaptureSend = async () => success({
    dispatch: { actuated: true, dispatchedMs: 100 },
    samples: arc,
    phases: [{ index: 1, keys: ["Mouse0"], sampleCount: 3, deltaX: 0, deltaY: 0 }],
    fieldTimeline: [
      {
        id: "weapon-fire-count",
        samples: [
          { tMs: 0, value: 0 },
          { tMs: 100, value: 1 },
          { tMs: 220, value: 2 },
        ],
      },
    ],
  });
  const contract: FeelCaptureContract = {
    schemaVersion: "1",
    subjects: [{ id: "player", locator: player }],
    interactions: [
      {
        id: "hold-fire",
        kind: "keyboard",
        measure: player,
        phases: [{ keys: ["Mouse0"], durationMs: 300 }],
        sampledFields: [
          {
            id: "weapon-fire-count",
            locator: { path: "/Player/Weapon" },
            type_name: "Weapon",
            property_path: "FireCount",
          },
        ],
      },
    ],
    metrics: [
      {
        metric: "fireIntervalMs",
        interactionId: "hold-fire",
        derivation: "sync",
        seriesId: "weapon-fire-count",
      },
    ],
  };

  const result = await runFeelCaptureContract(contract, send);
  assert.equal(result.measurements.metrics.fireIntervalMs, undefined);
  assert.equal(result.measurements.captureCoverage[0].status, "attempted-blocked");
  assert.match(result.measurements.captureCoverage[0].reason ?? "", /did not report active phase 0/);
});

test("runner refuses sync derivation when sampled series is degraded", async () => {
  const send: FeelCaptureSend = async () => success({
    dispatch: { actuated: true, dispatchedMs: 100 },
    samples: arc,
    fieldTimeline: [
      {
        id: "anim-jumping",
        samples: [],
        unresolved: "component 'Animator' not present on GameObject",
      },
    ],
  });
  const contract: FeelCaptureContract = {
    schemaVersion: "1",
    subjects: [{ id: "player", locator: player }],
    interactions: [{ id: "jump", kind: "ugui-tap", measure: player, target: { path: "/Jump" } }],
    metrics: [
      {
        metric: "inputToAnimStateLatency",
        interactionId: "jump",
        derivation: "sync",
        seriesId: "anim-jumping",
        targetValue: true,
      },
    ],
  };

  const result = await runFeelCaptureContract(contract, send);
  assert.equal(result.measurements.metrics.inputToAnimStateLatency, undefined);
  assert.equal(result.measurements.captureCoverage[0].status, "not-measured");
  assert.match(result.measurements.captureCoverage[0].reason ?? "", /unresolved/);
});

test("runner executes trace-replay interactions and assembles trace duration evidence", async () => {
  const send: FeelCaptureSend = async () => {
    throw new Error("trace replay test uses injected replay adapter");
  };
  const contract: FeelCaptureContract = {
    schemaVersion: "1",
    subjects: [{ id: "player", locator: player }],
    interactions: [{ id: "replay-start", kind: "trace-replay", traceId: "start-game" }],
    metrics: [{ metric: "traceDurationMs", interactionId: "replay-start", derivation: "trace" }],
  };

  const result = await runFeelCaptureContract(contract, send, {
    runTraceReplay: async () => ({
      traceId: "start-game",
      status: "pass",
      resetTier: "scene-load",
      segments: [{ id: "start", status: "pass", anchorsReached: [], captures: [] }],
      assertions: [],
      console: { status: "pass", errorCount: 0, errors: [] },
      durationMs: 432,
    }),
  });

  assert.equal(result.measurements.metrics.traceDurationMs, 432);
  assert.equal(result.measurements.captureCoverage[0].status, "measured");
  assert.equal(result.measurements.provenance.sources[0].derivation, "trace");
  assert.equal(result.measurements.provenance.sources[0].durationMs, 432);
  assert.equal((result.measurements.provenance.sources[0].replay as { status?: string }).status, "pass");
});

test("runner maps blocked trace replay to attempted-blocked coverage", async () => {
  const contract: FeelCaptureContract = {
    schemaVersion: "1",
    subjects: [{ id: "player", locator: player }],
    interactions: [{ id: "replay-start", kind: "trace-replay", traceId: "start-game" }],
    metrics: [{ metric: "traceDurationMs", interactionId: "replay-start", derivation: "trace" }],
  };

  const result = await runFeelCaptureContract(contract, async () => success({}), {
    runTraceReplay: async () => ({
      traceId: "start-game",
      status: "blocked",
      resetTier: null,
      blockedReason: "world-input-unsupported",
      segments: [{ id: "start", status: "blocked", anchorsReached: [], captures: [] }],
      assertions: [],
      console: { status: "pass", errorCount: 0, errors: [] },
      durationMs: 50,
    }),
  });

  assert.equal(result.measurements.metrics.traceDurationMs, undefined);
  assert.equal(result.measurements.captureCoverage[0].status, "attempted-blocked");
  assert.match(result.measurements.captureCoverage[0].reason ?? "", /trace replay blocked: world-input-unsupported/);
});

test("runner maps failed trace replay to attempted-blocked coverage", async () => {
  const contract: FeelCaptureContract = {
    schemaVersion: "1",
    subjects: [{ id: "player", locator: player }],
    interactions: [{ id: "replay-start", kind: "trace-replay", traceId: "start-game" }],
    metrics: [{ metric: "traceDurationMs", interactionId: "replay-start", derivation: "trace" }],
  };

  const result = await runFeelCaptureContract(contract, async () => success({}), {
    runTraceReplay: async () => ({
      traceId: "start-game",
      status: "fail",
      resetTier: "scene-load",
      firstDivergence: {
        segment: "start",
        kind: "anchor-missed",
        expected: "reach start",
        actual: "start button never appeared",
      },
      segments: [{ id: "start", status: "fail", anchorsReached: [], captures: [] }],
      assertions: [],
      console: { status: "pass", errorCount: 0, errors: [] },
      durationMs: 50,
    }),
  });

  assert.equal(result.measurements.metrics.traceDurationMs, undefined);
  assert.equal(result.measurements.captureCoverage[0].status, "attempted-blocked");
  assert.match(result.measurements.captureCoverage[0].reason ?? "", /trace replay failed: start button never appeared/);
});

const restingObservation = {
  samples: [
    { tMs: 0, x: 5, y: -5.015 },
    { tMs: 60, x: 5, y: -5.015 },
    { tMs: 120, x: 5, y: -5.015 },
    { tMs: 180, x: 5, y: -5.015 },
    { tMs: 240, x: 5, y: -5.015 },
    { tMs: 300, x: 5, y: -5.015 },
  ],
  phases: [{ index: 0, keys: [], sampleCount: 6, deltaX: 0, deltaY: 0 }],
};

const fallingObservation = {
  samples: [
    { tMs: 0, x: 5, y: 1.2 },
    { tMs: 60, x: 5, y: 0.6 },
    { tMs: 120, x: 5, y: -0.1 },
    { tMs: 180, x: 5, y: -0.9 },
    { tMs: 240, x: 5, y: -1.8 },
    { tMs: 300, x: 5, y: -2.8 },
  ],
  phases: [{ index: 0, keys: [], sampleCount: 6, deltaX: 0, deltaY: -4 }],
};

const briefStillnessObservation = {
  samples: [
    { tMs: 0, x: 5, y: 2.000 },
    { tMs: 5, x: 5, y: 2.004 },
    { tMs: 10, x: 5, y: 2.006 },
    { tMs: 15, x: 5, y: 2.007 },
    { tMs: 20, x: 5, y: 2.006 },
    { tMs: 25, x: 5, y: 2.004 },
  ],
  phases: [{ index: 0, keys: [], sampleCount: 6, deltaX: 0, deltaY: 0.004 }],
};

const measuredShortHop = {
  samples: arc,
  phases: [
    { index: 0, keys: [], sampleCount: 1, deltaX: 0, deltaY: 0 },
    {
      index: 1,
      keys: ["Space"],
      requestedFixedTicks: SHORT_HOP_CANONICAL_TAP_TICKS,
      actualFixedTicks: SHORT_HOP_CANONICAL_TAP_TICKS,
      sampleCount: 2,
      deltaX: 0,
      deltaY: 1,
    },
    { index: 2, keys: [], sampleCount: 1, deltaX: 0, deltaY: 1 },
  ],
};

function shortHopWithSettle(): FeelCaptureContract {
  return {
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
          timeoutMs: 1200,
          pollMs: 300,
          minStableSamples: 4,
          minStableMs: 100,
          restThreshold: 0.05,
        },
        phases: [
          { keys: [], durationMs: 200 },
          { keys: ["Space"], fixedTicks: SHORT_HOP_CANONICAL_TAP_TICKS },
          { keys: [], durationMs: 1100 },
        ],
      },
    ],
    metrics: [
      {
        metric: "shortHopApex",
        interactionId: "short-hop-key",
        derivation: "trajectory",
        stimulus: {
          metric: "shortHopApex",
          tapTicks: SHORT_HOP_CANONICAL_TAP_TICKS,
          phases: `[jump ${SHORT_HOP_CANONICAL_TAP_TICKS}t][jumpCut]`,
        },
      },
    ],
  };
}

test("runner settles to rest before the short-hop tap and preserves fixed-tick evidence", async () => {
  const calls: { command: string; params: Record<string, unknown> }[] = [];
  let observeCount = 0;
  const send: FeelCaptureSend = async (command, params) => {
    calls.push({ command, params });
    if (command === "runtime.measure_motion") {
      observeCount += 1;
      return success(restingObservation);
    }
    return success(measuredShortHop);
  };

  const result = await runFeelCaptureContract(shortHopWithSettle(), send);
  // Settle observation ran before the drive: first call is the no-key observation.
  assert.equal(calls[0].command, "runtime.measure_motion");
  assert.deepEqual(calls[0].params, {
    locator: player,
    durationMs: 300,
    includeSamples: true,
  });
  assert.equal(calls[1].command, "runtime.capture_input_motion");
  assert.ok(observeCount >= 1, "settle must observe the subject before the tap");
  assert.equal(result.measurements.metrics.shortHopApex, 2);
  assert.equal(result.measurements.captureCoverage[0].status, "measured");
  const settleRaw = result.raw.find((r) => r.interactionId === "short-hop-key");
  const settle = (settleRaw?.data as Record<string, unknown> | undefined)?.settle as Record<string, unknown> | undefined;
  assert.equal(settle?.status, "rested");
  assert.equal(typeof settle?.stableSampleCount, "number");
  assert.equal(typeof settle?.stableDurationMs, "number");
});

test("runner blocks short-hop when the subject never settles before its timeout", async () => {
  const send: FeelCaptureSend = async (command) => {
    if (command === "runtime.measure_motion") {
      return success(fallingObservation); // always falling -> never rests
    }
    throw new Error("short-hop drive must not run when settle is blocked");
  };

  const result = await runFeelCaptureContract(shortHopWithSettle(), send);
  assert.equal(result.measurements.metrics.shortHopApex, undefined);
  assert.equal(result.measurements.captureCoverage[0].status, "attempted-blocked");
  assert.match(result.measurements.captureCoverage[0].reason ?? "", /settle|grounded|rest/i);
  const blockedRaw = result.raw.find((r) => r.interactionId === "short-hop-key");
  assert.equal(blockedRaw?.status, "attempted-blocked");
  const settle = (blockedRaw?.data as Record<string, unknown> | undefined)?.settle as Record<string, unknown> | undefined;
  assert.equal(settle?.status, "timeout");
});

test("runner does not treat brief mid-air stillness as grounded settle", async () => {
  const send: FeelCaptureSend = async (command) => {
    if (command === "runtime.measure_motion") {
      return success(briefStillnessObservation); // enough samples, but only 25ms of stillness
    }
    throw new Error("short-hop drive must not run after brief stillness only");
  };

  const result = await runFeelCaptureContract(shortHopWithSettle(), send);
  assert.equal(result.measurements.metrics.shortHopApex, undefined);
  assert.equal(result.measurements.captureCoverage[0].status, "attempted-blocked");
  const blockedRaw = result.raw.find((r) => r.interactionId === "short-hop-key");
  const settle = (blockedRaw?.data as Record<string, unknown> | undefined)?.settle as Record<string, unknown> | undefined;
  assert.equal(settle?.status, "timeout");
  assert.ok(Number(settle?.stableDurationMs ?? 0) < 100);
});

test("runner refuses to certify short-hop when settle evidence is absent", async () => {
  const send: FeelCaptureSend = async (command) => {
    if (command === "runtime.measure_motion") {
      // Bridge returns no samples for the settle observation -> evidence absent, must refuse.
      return success({});
    }
    throw new Error("short-hop drive must not run when settle evidence is absent");
  };

  const result = await runFeelCaptureContract(shortHopWithSettle(), send);
  assert.equal(result.measurements.metrics.shortHopApex, undefined);
  assert.equal(result.measurements.captureCoverage[0].status, "attempted-blocked");
  const blockedRaw = result.raw.find((r) => r.interactionId === "short-hop-key");
  assert.equal(blockedRaw?.status, "attempted-blocked");
  const settle = (blockedRaw?.data as Record<string, unknown> | undefined)?.settle as Record<string, unknown> | undefined;
  assert.equal(settle?.status, "not-observed");
});

test("runner stamps and warns on stale installed runtime before capture", async () => {
  const warnings: string[] = [];
  const contract: FeelCaptureContract = {
    schemaVersion: "1",
    subjects: [{ id: "player", locator: player }],
    interactions: [{ id: "legacy", kind: "unsupported", reason: "unsupported fixture" }],
    metrics: [{ metric: "runSpeed", interactionId: "legacy", derivation: "trajectory" }],
  };
  const result = await runFeelCaptureContract(contract, async () => success({}), {
    sourceCommit: "abcdef1",
    warn: (message) => warnings.push(message),
  });

  assert.equal(result.measurements.provenance.runtimeGuard?.status, "warn");
  assert.equal(result.measurements.provenance.runtimeGuard?.sourceCommit, "abcdef1");
  assert.match(warnings[0] ?? "", /loombridge-install-locally\.sh/);
});

test("runtime guard does not warn when installed and source commits match", () => {
  const guard = evaluateFeelCaptureRuntimeGuard({
    sourceCommit: "abcdef1",
    installed: {
      tool: "loombridge",
      version: "0.1.0",
      commit: "abcdef1+dirty",
      builtAt: "2026-06-17T00:00:00.000Z",
      stampStatus: "stamped",
    },
  });

  assert.equal(guard.status, "ok");
});

test("runtime guard warns when the build stamp is incomplete", () => {
  const guard = evaluateFeelCaptureRuntimeGuard({
    installed: {
      tool: "loombridge",
      version: "0.1.0",
      commit: "unknown",
      builtAt: null,
      stampStatus: "dev",
      note: "fixture",
    },
  });

  assert.equal(guard.status, "warn");
  assert.match(guard.message, /build stamp is incomplete/);
});
