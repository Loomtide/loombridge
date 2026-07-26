import assert from "node:assert/strict";
import test from "node:test";

import {
  buildTuningPersistReport,
  parseTuningPersistArgs,
  planTuningPersistOperations,
  selectedCandidateValue,
  validateTuningPersistInput,
  valuesEquivalent,
  type TuningPersistInput,
} from "../capabilities/verification/tuning-persist.js";
import type { TuningSessionConfig, TuningTrialsReport } from "../capabilities/verification/tuning-runner.js";

function config(): TuningSessionConfig {
  return {
    schemaVersion: "1",
    id: "platformer-run-speed",
    metricId: "runSpeed",
    mutation: {
      locator: { scene: "Game", path: "/Player" },
      type_name: "PlayerController",
      property_path: "moveSpeed",
    },
    candidates: [5, 7, 9],
    measurement: {
      params: { locator: { scene: "Game", path: "/Player" }, durationMs: 700 },
      resultPath: "avgRunSpeed",
    },
  };
}

function report(status: "pass" | "warn" | "fail" = "pass"): TuningTrialsReport {
  return {
    sessionId: "platformer-run-speed",
    metricId: "runSpeed",
    target: 7,
    unit: "u/s",
    band: { percent: 5 },
    trials: [
      { candidateValue: 5, measuredValue: 5, errorFromTarget: -2, status: "fail" },
      { candidateValue: 7, measuredValue: 7, errorFromTarget: 0, status },
    ],
    bestCandidate: { candidateValue: 7, measuredValue: 7, errorFromTarget: 0, status },
    recommendation: "Use candidate 7.",
  };
}

test("tuning-persist: rejects reports without a best candidate", () => {
  const input: TuningPersistInput = { config: config(), report: { ...report(), bestCandidate: undefined } };
  const result = validateTuningPersistInput(input);

  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) => issue.code === "MISSING_BEST_CANDIDATE"));
  assert.throws(() => selectedCandidateValue(input), /Report has no bestCandidate/);
});

test("tuning-persist: rejects non-passing best candidate by default", () => {
  const result = validateTuningPersistInput({ config: config(), report: report("fail") });

  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) => issue.code === "NON_PASSING_CANDIDATE"));
});

test("tuning-persist: allows non-passing best candidate only with explicit override", () => {
  const input = { config: config(), report: report("fail"), allowNonPassingCandidate: true };
  const result = validateTuningPersistInput(input);

  assert.equal(result.valid, true, JSON.stringify(result.issues, null, 2));
  assert.equal(selectedCandidateValue(input), 7);
});

test("tuning-persist: plans Edit Mode persist operations from config and report", () => {
  const ops = planTuningPersistOperations({ config: config(), report: report() });

  assert.equal(ops[0]!.command, "editor.stop");
  assert.equal(ops[1]!.command, "editor.wait_for");
  assert.deepEqual(ops[1]!.params, { playMode: "stopped", timeoutMs: 30000 });
  assert.equal(ops[2]!.command, "component.set_property");
  assert.deepEqual(ops[2]!.params, {
    locator: { scene: "Game", path: "/Player" },
    type_name: "PlayerController",
    property_path: "moveSpeed",
    value: 7,
  });
  assert.equal(ops[3]!.command, "component.get_properties");
  assert.deepEqual(ops[3]!.params, {
    locator: { scene: "Game", path: "/Player" },
    type_name: "PlayerController",
    include_paths: ["moveSpeed"],
  });
});

test("tuning-persist: serializes pass and fail persist reports", () => {
  const pass = buildTuningPersistReport({ config: config(), report: report(), actualValue: 7.00001 });
  assert.equal(pass.status, "pass");
  assert.equal(pass.persistedValue, 7);
  assert.equal(pass.verification.actualValue, 7.00001);
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(pass)));

  const fail = buildTuningPersistReport({ config: config(), report: report(), actualValue: 6.9 });
  assert.equal(fail.status, "fail");
  assert.equal(fail.verification.status, "fail");
});

test("tuning-persist: value comparison tolerates numeric precision", () => {
  assert.equal(valuesEquivalent(7, 7.00001), true);
  assert.equal(valuesEquivalent(7, 7.01), false);
  assert.equal(valuesEquivalent("7", "7"), true);
  assert.equal(valuesEquivalent("7", 7), false);
});

test("tuning-persist: parses backend runner args", () => {
  const args = parseTuningPersistArgs([
    "node",
    "tuning-persist.js",
    "--config",
    "../trace/verify/tuning-config.json",
    "--report",
    "../trace/verify/tuning-trials.json",
    "--out",
    "../trace/verify/tuning-persist.json",
    "--allow-non-passing-candidate",
    "--project",
    "GameA",
  ]);

  assert.ok(args.configPath.endsWith("trace/verify/tuning-config.json"));
  assert.ok(args.reportPath.endsWith("trace/verify/tuning-trials.json"));
  assert.ok(args.outPath.endsWith("trace/verify/tuning-persist.json"));
  assert.equal(args.allowNonPassingCandidate, true);
  assert.equal(args.project, "GameA");
});
