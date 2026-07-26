import assert from "node:assert/strict";
import test from "node:test";
import { validateOpArguments } from "../../../shared/arg-validation.js";

/** The real shape shared by scene.get_bounds / component.list and friends. */
const LOCATOR_SCHEMA = {
  type: "object",
  properties: {
    locator: {
      type: "object",
      description: "Entity locator identifying a GameObject",
      properties: {
        scene: { type: "string" },
        path: { type: "string" },
        globalObjectId: { type: "string" },
        instanceId: { type: "string" },
      },
      required: ["path"],
    },
    debug: { type: "boolean" },
  },
  required: ["locator"],
};

test("arg validation: a string locator is rejected instead of reaching Unity", () => {
  const problems = validateOpArguments({ locator: "Level_02_Meltdown:/Arena" }, LOCATOR_SCHEMA);

  assert.equal(problems.length, 1);
  assert.match(problems[0], /'locator' must be object, got string/);
  // Regression guard: this exact input previously produced
  // "[INTERNAL_ERROR] Invalid cast from 'System.String' to 'Newtonsoft.Json.Linq.JObject'".
});

test("arg validation: a well-formed locator passes untouched", () => {
  assert.deepEqual(
    validateOpArguments({ locator: { scene: "Main", path: "/Player" } }, LOCATOR_SCHEMA),
    [],
  );
});

test("arg validation: a missing required top-level property is reported", () => {
  const problems = validateOpArguments({ debug: true }, LOCATOR_SCHEMA);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /'locator' is required/);
});

test("arg validation: a nested required property is reported with its dotted path", () => {
  const problems = validateOpArguments({ locator: { scene: "Main" } }, LOCATOR_SCHEMA);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /'locator\.path' is required/);
});

test("arg validation: a nested wrong type is reported", () => {
  const problems = validateOpArguments({ locator: { path: 42 } }, LOCATOR_SCHEMA);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /'locator\.path' must be string, got number/);
});

test("arg validation: unknown extra properties are allowed", () => {
  assert.deepEqual(
    validateOpArguments({ locator: { path: "/Player" }, futureFlag: true }, LOCATOR_SCHEMA),
    [],
  );
});

test("arg validation: integer vs number is distinguished, and number accepts both", () => {
  const schema = { type: "object", properties: { frames: { type: "integer" }, ratio: { type: "number" } } };

  assert.deepEqual(validateOpArguments({ frames: 60, ratio: 0.5 }, schema), []);
  assert.deepEqual(validateOpArguments({ ratio: 2 }, schema), []);
  assert.match(validateOpArguments({ frames: 1.5 }, schema)[0], /'frames' must be integer, got number/);
});

test("arg validation: a union type declaration accepts every member", () => {
  const schema = { type: "object", properties: { value: { type: ["string", "number"] } } };

  assert.deepEqual(validateOpArguments({ value: "a" }, schema), []);
  assert.deepEqual(validateOpArguments({ value: 1 }, schema), []);
  assert.match(validateOpArguments({ value: true }, schema)[0], /must be string \| number, got boolean/);
});

test("arg validation: never throws on a malformed or absent schema", () => {
  assert.deepEqual(validateOpArguments({ anything: 1 }, undefined), []);
  assert.deepEqual(validateOpArguments({ anything: 1 }, "not-a-schema"), []);
  assert.deepEqual(validateOpArguments({ anything: 1 }, { type: "object", properties: null }), []);
  assert.deepEqual(validateOpArguments(null, LOCATOR_SCHEMA), []);
});

test("arg validation: null is treated as absent, not as a type error", () => {
  // Ops routinely receive explicit nulls for optional fields from JSON clients.
  const schema = { type: "object", properties: { debug: { type: "boolean" } } };
  assert.deepEqual(validateOpArguments({ debug: null }, schema), []);
});
