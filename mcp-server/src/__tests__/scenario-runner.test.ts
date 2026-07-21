import assert from "node:assert/strict";
import test from "node:test";
import { ScenarioRunner } from "../scenario/runner.js";
import type { ScenarioDocument, ScenarioToolCallRequest, ScenarioToolResult } from "../scenario/types.js";

function textResult(payload: Record<string, unknown>): ScenarioToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
  };
}

test("ScenarioRunner: executes scenario successfully", async () => {
  const calls: ScenarioToolCallRequest[] = [];
  const runner = new ScenarioRunner(async (request) => {
    calls.push(request);
    if (request.name === "unity_runtime_assert_condition") {
      return textResult({ passed: true, operator: "equals" });
    }
    return textResult({ ok: true });
  });

  const scenario: ScenarioDocument = {
    schemaVersion: "1",
    name: "success",
    steps: [
      {
        id: "s1",
        name: "state",
        kind: "tool_call",
        tool: "unity_editor_get_state",
        arguments: {},
      },
      {
        id: "s2",
        name: "assert",
        kind: "runtime_assert",
        locator: { scene: "", path: "/Player" },
        property_path: "activeSelf",
        operator: "equals",
        expected: true,
      },
    ],
  };

  const result = await runner.run(scenario);
  assert.equal(result.status, "pass");
  assert.equal(result.deterministic, true);
  assert.equal(result.steps.length, 2);
  assert.equal(result.diagnostics.passedSteps, 2);
  assert.equal(result.diagnostics.blockedSteps, 0);
  assert.equal(calls[0]?.name, "unity_editor_get_state");
  assert.equal(calls[1]?.name, "unity_runtime_assert_condition");
});

test("ScenarioRunner: fails when runtime assertion payload reports passed=false", async () => {
  const runner = new ScenarioRunner(async (request) => {
    if (request.name === "unity_runtime_assert_condition") {
      return textResult({
        passed: false,
        classification: "fail",
        failure_code: "ASSERTION_FAILED",
        message: "deterministic assertion mismatch",
      });
    }
    return textResult({ ok: true });
  });

  const scenario: ScenarioDocument = {
    schemaVersion: "1",
    name: "expected-failure",
    steps: [
      {
        id: "s1",
        name: "assert",
        kind: "runtime_assert",
        locator: { scene: "", path: "/Player" },
        property_path: "activeSelf",
        operator: "equals",
        expected: true,
      },
    ],
  };

  const result = await runner.run(scenario);
  assert.equal(result.status, "fail");
  assert.equal(result.failedStepIndex, 0);
  assert.equal(result.failedStepStatus, "fail");
  assert.equal(result.steps[0]?.error?.code, "ASSERTION_FAILED");
  assert.match(result.steps[0]?.error?.message ?? "", /deterministic assertion mismatch/i);
});

test("ScenarioRunner: returns timeout failure for slow step", async () => {
  const runner = new ScenarioRunner(
    () => new Promise(() => undefined),
    { defaultStepTimeoutMs: 25 },
  );

  const scenario: ScenarioDocument = {
    schemaVersion: "1",
    name: "timeout",
    steps: [
      {
        id: "s1",
        name: "slow",
        kind: "tool_call",
        tool: "unity_editor_get_state",
        arguments: {},
      },
    ],
  };

  const result = await runner.run(scenario);
  assert.equal(result.status, "fail");
  assert.equal(result.steps[0]?.error?.code, "TIMEOUT");
  assert.equal(result.failedStepStatus, "fail");
});

test("ScenarioRunner: preserves deterministic error details for invalid dispatch", async () => {
  const runner = new ScenarioRunner(async () => ({
    isError: true,
    content: [{ type: "text", text: "[NOT_FOUND] Unknown tool: unity_fake_tool" }],
  }));

  const scenario: ScenarioDocument = {
    schemaVersion: "1",
    name: "invalid-dispatch",
    steps: [
      {
        id: "s1",
        name: "bad tool",
        kind: "tool_call",
        tool: "unity_fake_tool",
        arguments: {},
      },
    ],
  };

  const result = await runner.run(scenario);
  assert.equal(result.status, "fail");
  assert.equal(result.failedStepStatus, "fail");
  assert.equal(result.steps[0]?.error?.code, "NOT_FOUND");
  assert.match(result.steps[0]?.error?.message ?? "", /Unknown tool/);
});

test("ScenarioRunner: propagates deterministic blocked status from preflight gate", async () => {
  const runner = new ScenarioRunner(async () => ({
    isError: true,
    content: [{
      type: "text",
      text: "[PREFLIGHT_BLOCKED] deterministic scenario preflight blocked: {\"blockerSignature\":\"EPERM_LOOPBACK\"}",
    }],
  }));

  const scenario: ScenarioDocument = {
    schemaVersion: "1",
    name: "preflight-blocked",
    steps: [
      {
        id: "s1",
        name: "runtime wait",
        kind: "runtime_wait",
        locator: { scene: "", path: "/Player" },
        property_path: "activeSelf",
        operator: "equals",
        expected: true,
      },
    ],
  };

  const result = await runner.run(scenario);
  assert.equal(result.status, "blocked");
  assert.equal(result.failedStepStatus, "blocked");
  assert.equal(result.failedStepId, "s1");
  assert.equal(result.diagnostics.blockedSteps, 1);
  assert.equal(result.steps[0]?.status, "blocked");
  assert.equal(result.steps[0]?.error?.code, "PREFLIGHT_BLOCKED");
});

test("ScenarioRunner: propagates deterministic blocked status from input capability gate", async () => {
  const runner = new ScenarioRunner(async () => ({
    isError: true,
    content: [{
      type: "text",
      text: "[INPUT_CAPABILITY_BLOCKED] Input capability blocked for 'key_tap'.",
    }],
  }));

  const scenario: ScenarioDocument = {
    schemaVersion: "1",
    name: "input-blocked",
    steps: [
      {
        id: "s1",
        name: "tap",
        kind: "tool_call",
        tool: "unity_input_key_tap",
        arguments: { key: "Space" },
      },
    ],
  };

  const result = await runner.run(scenario);
  assert.equal(result.status, "blocked");
  assert.equal(result.failedStepStatus, "blocked");
  assert.equal(result.diagnostics.blockedSteps, 1);
  assert.equal(result.steps[0]?.status, "blocked");
  assert.equal(result.steps[0]?.error?.code, "INPUT_CAPABILITY_BLOCKED");
});
