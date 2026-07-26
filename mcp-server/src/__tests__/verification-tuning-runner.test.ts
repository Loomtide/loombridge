import assert from "node:assert/strict";
import test from "node:test";

import {
  assertValidTuningSessionConfig,
  buildTuningReport,
  extractMeasuredValue,
  getMetricTarget,
  parseTuningRunnerArgs,
  planTuningTrialOperations,
  scoreMeasuredValue,
  selectBestCandidate,
  validateTuningSessionConfig,
  type TuningSessionConfig,
  type TuningTrialResult,
} from "../capabilities/verification/tuning-runner.js";
import type { AcceptanceContract, NumericTarget } from "../capabilities/verification/types.js";

function validConfig(): TuningSessionConfig {
  return {
    schemaVersion: "1",
    id: "platformer-run-speed",
    metricId: "runSpeed",
    mutation: {
      locator: { scene: "Game", path: "/Player" },
      type_name: "PlayerController",
      property_path: "moveSpeed",
    },
    candidates: [6.5, 7, 7.5],
    measurement: {
      params: {
        locator: { scene: "Game", path: "/Player" },
        durationMs: 800,
        captureFps: 120,
      },
      resultPath: "avgRunSpeed",
      timeoutMs: 5000,
    },
    reset: {
      beforeEach: {
        command: "scene.set_transform",
        params: { locator: { scene: "Game", path: "/Player" }, position: { x: 0, y: 1, z: 0 } },
        timeoutMs: 2000,
      },
      waitFramesAfterReset: 2,
      waitFramesAfterSet: 3,
    },
    replay: {
      beforeMeasure: [
        {
          command: "component.set_property",
          params: {
            locator: { scene: "Game", path: "/Player" },
            type_name: "PlayerController",
            property_path: "forceHorizontal",
            value: 1,
          },
        },
      ],
      waitFramesAfterReplay: 2,
    },
  };
}

test("tuning-runner: parses backend runner args with project target", () => {
  const args = parseTuningRunnerArgs([
    "node",
    "tuning-runner.js",
    "--acceptance",
    "../trace/verify/acceptance.json",
    "--config",
    "../trace/verify/tuning-config.json",
    "--out",
    "../trace/verify/tuning-trials.json",
    "--project",
    "GameA",
  ]);

  assert.ok(args.acceptancePath.endsWith("trace/verify/acceptance.json"));
  assert.ok(args.configPath.endsWith("trace/verify/tuning-config.json"));
  assert.ok(args.outPath.endsWith("trace/verify/tuning-trials.json"));
  assert.equal(args.project, "GameA");
});

test("tuning-runner: validates a platformer-friendly session config", () => {
  const config = validConfig();
  const result = validateTuningSessionConfig(config);

  assert.equal(result.valid, true, JSON.stringify(result.issues, null, 2));
  assert.equal(assertValidTuningSessionConfig(config).id, "platformer-run-speed");
});

test("tuning-runner: rejects malformed configs before Play Mode", () => {
  const config = validConfig() as unknown as Record<string, unknown>;
  config.id = "";
  config.candidates = [6, Number.NaN, "fast"];
  config.mutation = { locator: {}, type_name: "", property_path: "" };
  config.measurement = {
    command: "runtime.capture_sequence",
    params: { locator: {} },
    timeoutMs: 0,
  };
  config.reset = { beforeEach: { command: "runtime.reset_object", params: [] }, waitFramesAfterSet: -1 };
  config.replay = { beforeMeasure: [{ command: "runtime.reset_object", params: {} }], waitFramesAfterReplay: -1 };

  const result = validateTuningSessionConfig(config);

  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) => issue.path === "id"));
  assert.ok(result.issues.some((issue) => issue.path === "candidates[1]"));
  assert.ok(result.issues.some((issue) => issue.path === "candidates[2]"));
  assert.ok(result.issues.some((issue) => issue.path === "mutation.locator"));
  assert.ok(result.issues.some((issue) => issue.path === "measurement.command"));
  assert.ok(result.issues.some((issue) => issue.path === "measurement.params.locator"));
  assert.ok(result.issues.some((issue) => issue.path === "reset.beforeEach.command"));
  assert.ok(result.issues.some((issue) => issue.path === "reset.beforeEach.params"));
  assert.ok(result.issues.some((issue) => issue.path === "reset.waitFramesAfterSet"));
  assert.ok(result.issues.some((issue) => issue.path === "replay.beforeMeasure[0].command"));
  assert.ok(result.issues.some((issue) => issue.path === "replay.waitFramesAfterReplay"));
  assert.throws(() => assertValidTuningSessionConfig(config), /Invalid tuning config: .*candidates\[1\]/);
});

test("tuning-runner: resolves targets from config before acceptance feel targets", () => {
  const config = validConfig();
  config.target = { target: 9, unit: "units/s", band: { abs: 0.5 } };
  const acceptance = {
    schemaVersion: "1",
    game: "demo",
    feel: { runSpeed: { target: 7, unit: "units/s", band: { percent: 10 } } },
  } as AcceptanceContract;

  assert.equal(getMetricTarget(acceptance, config)?.target, 9);
  delete config.target;
  assert.equal(getMetricTarget(acceptance, config)?.target, 7);
});

test("tuning-runner: scores percent bands as pass, warn, and fail", () => {
  const target: NumericTarget = { target: 100, unit: "px/s", band: { percent: 10 } };

  assert.deepEqual(scoreMeasuredValue(105, target), { measuredValue: 105, errorFromTarget: 5, status: "pass" });
  assert.deepEqual(scoreMeasuredValue(115, target), { measuredValue: 115, errorFromTarget: 15, status: "warn" });
  assert.deepEqual(scoreMeasuredValue(130, target), { measuredValue: 130, errorFromTarget: 30, status: "fail" });
});

test("tuning-runner: scores absolute bands as pass, warn, and fail", () => {
  const target: NumericTarget = { target: 2, unit: "units", band: { abs: 0.2 } };

  assert.deepEqual(scoreMeasuredValue(2.1, target), {
    measuredValue: 2.1,
    errorFromTarget: 0.10000000000000009,
    status: "pass",
  });
  assert.deepEqual(scoreMeasuredValue(2.3, target), {
    measuredValue: 2.3,
    errorFromTarget: 0.2999999999999998,
    status: "warn",
  });
  assert.deepEqual(scoreMeasuredValue(2.6, target), {
    measuredValue: 2.6,
    errorFromTarget: 0.6000000000000001,
    status: "fail",
  });
});

test("tuning-runner: selects the best measured candidate by status then error", () => {
  const trials: TuningTrialResult[] = [
    { candidateValue: 4, measuredValue: 99, errorFromTarget: -1, status: "fail" },
    { candidateValue: 5, measuredValue: 88, errorFromTarget: -12, status: "pass" },
    { candidateValue: 6, measuredValue: 95, errorFromTarget: -5, status: "pass" },
    { candidateValue: 7, status: "fail", error: "measurement failed" },
  ];

  assert.equal(selectBestCandidate(trials)?.candidateValue, 6);
  assert.equal(selectBestCandidate([{ candidateValue: 1, status: "fail", error: "boom" }]), undefined);
});

test("tuning-runner: renders a compact serializable trial report", () => {
  const config = validConfig();
  const target: NumericTarget = { target: 7, unit: "units/s", band: { percent: 10 } };
  const report = buildTuningReport({
    config,
    target,
    trials: [
      { candidateValue: 6.5, measuredValue: 6.4, errorFromTarget: -0.6, status: "pass" },
      { candidateValue: 7.5, measuredValue: 8.3, errorFromTarget: 1.3, status: "warn" },
    ],
  });

  assert.equal(report.sessionId, "platformer-run-speed");
  assert.equal(report.metricId, "runSpeed");
  assert.equal(report.bestCandidate?.candidateValue, 6.5);
  assert.match(report.recommendation, /Persist this value in Edit Mode/);
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(report)));
});

test("tuning-runner: extracts measured values by explicit and default result paths", () => {
  const config = validConfig();

  assert.equal(extractMeasuredValue({ avgRunSpeed: 7.2 }, config), 7.2);
  delete config.measurement.resultPath;
  assert.equal(extractMeasuredValue({ avgRunSpeed: 7.1 }, config), 7.1);
  assert.throws(() => extractMeasuredValue({ deltaX: 12 }, config), /avgRunSpeed/);
});

test("tuning-runner: plans live trial operations without command UX", () => {
  const ops = planTuningTrialOperations(validConfig());

  assert.equal(ops[0]!.command, "scene.set_transform");
  assert.equal(ops[1]!.command, "component.set_property");
  assert.equal(ops[1]!.params.value, "<candidate>");
  assert.equal(ops[2]!.command, "component.set_property");
  assert.equal(ops[2]!.params.property_path, "forceHorizontal");
  assert.equal(ops[3]!.command, "runtime.measure_motion");
  assert.equal(ops[3]!.timeoutMs, 5000);
});
