import assert from "node:assert/strict";
import test from "node:test";
import { validateScenarioDocument } from "../capabilities/scenario/validator.js";

test("Scenario validator: accepts valid generic scenario", () => {
  const result = validateScenarioDocument({
    schemaVersion: "1",
    name: "generic-smoke",
    steps: [
      {
        id: "s1",
        name: "Get editor state",
        kind: "tool_call",
        tool: "unity_editor_get_state",
        arguments: {},
      },
      {
        id: "s2",
        name: "Assert active self",
        kind: "runtime_assert",
        locator: { path: "/Player" },
        property_path: "activeSelf",
        operator: "equals",
        expected: true,
      },
    ],
  });

  assert.equal(result.valid, true);
  assert.equal(result.issues.length, 0);
});

test("Scenario validator: rejects missing required fields", () => {
  const result = validateScenarioDocument({
    schemaVersion: "1",
    steps: [],
  });

  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) => issue.code === "MISSING_FIELD" && issue.path === "name"));
  assert.ok(result.issues.some((issue) => issue.code === "MISSING_STEPS"));
});

test("Scenario validator: rejects unknown step kinds", () => {
  const result = validateScenarioDocument({
    schemaVersion: "1",
    name: "unknown-kind",
    steps: [
      {
        id: "s1",
        name: "Do thing",
        kind: "spawn_enemy",
      },
    ],
  });

  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) => issue.code === "UNKNOWN_STEP_KIND"));
});

test("Scenario validator: rejects disallowed game-specific tool names", () => {
  const result = validateScenarioDocument({
    schemaVersion: "1",
    name: "disallowed-tools",
    steps: [
      {
        id: "s1",
        name: "Platformer specific call",
        kind: "tool_call",
        tool: "unity_platformer_spawn_enemy",
      },
    ],
  });

  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) => issue.code === "DISALLOWED_GAME_SPECIFIC_NAME"));
});
