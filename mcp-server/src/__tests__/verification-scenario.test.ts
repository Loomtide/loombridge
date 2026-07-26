import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertValidVerificationScenario,
  getVerificationResetPolicy,
  validateVerificationScenario,
  type VerificationScenario,
} from "../capabilities/verification/scenario.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const fixturePath = path.resolve(
  __dirname,
  "../../..",
  "mcp-server/src/capabilities/verification/scenarios/platformer-2d-basic.json",
);

async function loadFixture(): Promise<VerificationScenario> {
  return JSON.parse(await fs.readFile(fixturePath, "utf-8")) as VerificationScenario;
}

test("verification scenario: platformer fixture validates", async () => {
  const scenario = await loadFixture();
  const result = validateVerificationScenario(scenario);
  assert.equal(result.valid, true, JSON.stringify(result.issues, null, 2));
  assert.equal(assertValidVerificationScenario(scenario).id, "platformer-2d-basic");
  assert.equal(getVerificationResetPolicy(scenario).type, "spawn-before-sequence");
});

test("verification scenario: rejects missing required capture timing", async () => {
  const scenario = await loadFixture();
  const invalid = structuredClone(scenario);
  invalid.sequences[0]!.captures[1] = { id: "bad", trigger: "atMs" };

  const result = validateVerificationScenario(invalid);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) => issue.code === "MISSING_FIELD" && issue.path.endsWith(".atMs")));
});

test("verification scenario: reload-scene reset requires explicit scenePath", async () => {
  const scenario = await loadFixture();
  const invalid = structuredClone(scenario);
  invalid.playMode.resetPolicy = { type: "reload-scene" };

  const result = validateVerificationScenario(invalid);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) => issue.code === "MISSING_RESET_CONFIG"));
});

test("verification scenario: duplicate sequence ids are rejected", async () => {
  const scenario = await loadFixture();
  const invalid = structuredClone(scenario);
  invalid.sequences.push(structuredClone(invalid.sequences[0]!));

  const result = validateVerificationScenario(invalid);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) => issue.code === "DUPLICATE_SEQUENCE_ID"));
});

test("verification scenario: rejects phases without drivers or a single-driver value", async () => {
  const scenario = await loadFixture();
  const noDriver = structuredClone(scenario);
  delete noDriver.driverDefaults;
  delete noDriver.sequences[0]!.driver;

  let result = validateVerificationScenario(noDriver);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) => issue.code === "MISSING_DRIVER"));

  const noValue = structuredClone(scenario);
  delete noValue.sequences[0]!.phases[0]!.value;
  result = validateVerificationScenario(noValue);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) => issue.code === "MISSING_PHASE_VALUE"));
});

test("verification scenario: allows per-phase multi-driver phases without single-driver values", async () => {
  const scenario = await loadFixture();
  const multiDriver = structuredClone(scenario);
  delete multiDriver.driverDefaults;
  delete multiDriver.sequences[0]!.driver;
  multiDriver.sequences[0]!.phases = [
    {
      durationMs: 100,
      drivers: [
        {
          locator: { scene: "Game", path: "/Player" },
          type_name: "PlayerController",
          property_path: "forceJump",
          value: true,
        },
      ],
    },
  ];

  const result = validateVerificationScenario(multiDriver);
  assert.equal(result.valid, true, JSON.stringify(result.issues, null, 2));
});

test("verification scenario: validates optional gate collection inputs", async () => {
  const scenario = await loadFixture();
  scenario.collect = {
    screenRects: [{ scene: "Game", path: "/Player" }],
    screenRectCamera: { scene: "Game", path: "/Main Camera" },
    screenRectBoundsMode: "collider",
    runtimeAssertions: [
      {
        id: "player-grounded",
        locator: { scene: "Game", path: "/Player" },
        component: "PlayerController",
        property_path: "isGrounded",
        operator: "equals",
        expected: true,
        timeoutMs: 1000,
      },
    ],
    console: true,
  };

  const result = validateVerificationScenario(scenario);
  assert.equal(result.valid, true, JSON.stringify(result.issues, null, 2));
});

test("verification scenario: rejects malformed collection inputs before Play Mode", async () => {
  const scenario = await loadFixture();
  scenario.collect = {
    screenRects: [{} as never],
    screenRectBoundsMode: "sprite" as "collider",
    runtimeAssertions: [
      {
        id: "",
        locator: {} as never,
        property_path: "",
        operator: "" as never,
        expected: true,
        timeoutMs: 0,
      },
    ],
    console: "yes" as unknown as boolean,
  };

  const result = validateVerificationScenario(scenario);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) => issue.path === "collect.screenRects[0]"));
  assert.ok(result.issues.some((issue) => issue.path === "collect.screenRectBoundsMode"));
  assert.ok(result.issues.some((issue) => issue.path === "collect.runtimeAssertions[0].id"));
  assert.ok(result.issues.some((issue) => issue.path === "collect.runtimeAssertions[0].locator"));
  assert.ok(result.issues.some((issue) => issue.path === "collect.runtimeAssertions[0].timeoutMs"));
  assert.ok(result.issues.some((issue) => issue.path === "collect.console"));
});
