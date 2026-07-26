import assert from "node:assert/strict";
import test from "node:test";
import {
  OpRegistry,
  INPUT_CAPABILITY_BLOCKER_CODE,
  buildInputCapabilityBlockedPayload,
} from "../../../surfaces/op-registry.js";

const registry = new OpRegistry();

test("input capability gate: supported path is surfaced on unity_input_get_capabilities", () => {
  const op = registry.getByCommand("input.get_capabilities");
  assert.ok(op, "Missing input.get_capabilities op");
  assert.match(
    op!.description,
    /input capability status.*supported\/unsupported.*reason/i,
  );
});

test("input capability gate: unsupported path is documented on gated input tools", () => {
  const gatedCommands = [
    "input.begin_session",
    "input.key_down",
    "input.key_up",
    "input.key_tap",
    "input.click_ui",
  ];

  for (const command of gatedCommands) {
    const op = registry.getByCommand(command);
    assert.ok(op, `Missing op for ${command}`);
    assert.match(
      op!.description,
      new RegExp(`\\[${INPUT_CAPABILITY_BLOCKER_CODE}\\]`),
      `${command} should advertise deterministic blocker code`,
    );
  }
});

test("input capability gate: deterministic blocked payload shape is stable", () => {
  const payload = buildInputCapabilityBlockedPayload(
    "input.key_tap",
    "Input capability blocked: no available input backend.",
  );

  assert.deepEqual(payload, {
    deterministic: true,
    blockerType: "input capability",
    blockerCode: INPUT_CAPABILITY_BLOCKER_CODE,
    command: "input.key_tap",
    supported: false,
    reason: "Input capability blocked: no available input backend.",
  });
});
