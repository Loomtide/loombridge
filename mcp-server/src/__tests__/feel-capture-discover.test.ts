import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyFeelControlCandidates,
  discoverUiControls,
  proposeAnimatorBool,
  proposeRoleControl,
  resolveDiscoveredRoles,
} from "../capabilities/feel/discover.js";
import { discoverFeelSetup } from "../capabilities/feel/discover-live.js";
import { proposeFeelCaptureContract } from "../capabilities/feel/setup.js";
import { run as runVerifyCli } from "../capabilities/verification/verify.js";
import type { BridgeResponse } from "../types.js";

/** Run the verify CLI with stderr usage noise suppressed. */
async function quietRun(args: string[]): Promise<number> {
  const original = console.error;
  console.error = () => {};
  try {
    return await runVerifyCli(args);
  } finally {
    console.error = original;
  }
}

function control(path: string, name: string, over: Record<string, unknown> = {}) {
  return {
    locator: { path },
    name,
    role: "button",
    isVisible: true,
    raycastTarget: true,
    viewportRect: { x: 0.1, y: 0.1, width: 0.1, height: 0.1 },
    ...over,
  };
}

test("classifier keeps visible raycast controls and drops containers/backdrops/hidden/non-raycast", () => {
  const rects = {
    objects: [
      control("/Canvas/ButtonJump", "ButtonJump"),
      control("/Canvas/Panel", "Panel", { role: "container" }),
      control("/Canvas/Backdrop", "Backdrop", { viewportRect: { x: 0, y: 0, width: 1, height: 1 } }),
      control("/Canvas/Hidden", "Hidden", { isVisible: false }),
      control("/Canvas/Label", "Label", { raycastTarget: false }),
    ],
  };
  const candidates = classifyFeelControlCandidates(rects);
  assert.deepEqual(candidates.map((c) => c.path), ["/Canvas/ButtonJump"]);
});

test("proposeRoleControl distinguishes proposed / ambiguous / none", () => {
  const one = [{ path: "/Canvas/ButtonJump", name: "ButtonJump" }];
  const two = [
    { path: "/Canvas/JumpA", name: "JumpA" },
    { path: "/Canvas/JumpB", name: "JumpB" },
  ];
  assert.equal(proposeRoleControl(one, /jump/i).kind, "proposed");
  const amb = proposeRoleControl(two, /jump/i);
  assert.equal(amb.kind, "ambiguous");
  assert.equal(proposeRoleControl(one, /dash/i).kind, "none");
});

test("discoverUiControls proposes generic jump + joystick names (no project-specific paths)", () => {
  const rects = {
    objects: [
      control("/Mobile/ButtonJump", "ButtonJump"),
      control("/Mobile/Fixed Joystick", "Fixed Joystick"),
      control("/Mobile/Pause", "Pause"),
    ],
  };
  const ui = discoverUiControls(rects);
  assert.equal(ui.jump.kind, "proposed");
  assert.equal(ui.jump.kind === "proposed" && ui.jump.candidate.path, "/Mobile/ButtonJump");
  assert.equal(ui.joystick.kind, "proposed");
  assert.equal(ui.joystick.kind === "proposed" && ui.joystick.candidate.path, "/Mobile/Fixed Joystick");
});

test("ambiguous jump candidates are surfaced, never silently bound", () => {
  const rects = {
    objects: [control("/Mobile/JumpLeft", "JumpLeft"), control("/Mobile/JumpRight", "JumpRight")],
  };
  const ui = discoverUiControls(rects);
  assert.equal(ui.jump.kind, "ambiguous");
  const resolved = resolveDiscoveredRoles({ ui });
  assert.equal(resolved.jumpButtonPath, undefined); // not bound
  assert.ok(resolved.notes.some((n) => /jump: ambiguous/.test(n) && /--jump-button/.test(n)));
});

test("explicit drive flags win over a discovered proposal", () => {
  const rects = { objects: [control("/Mobile/ButtonJump", "ButtonJump")] };
  const ui = discoverUiControls(rects);
  const resolved = resolveDiscoveredRoles({
    ui,
    explicit: { jumpButtonPath: "/Custom/MyJump" },
  });
  assert.equal(resolved.jumpButtonPath, "/Custom/MyJump");
  assert.ok(resolved.notes.some((n) => /using explicit --jump-button/.test(n)));
});

test("explicit keyboard drive flags prevent discovery from binding pointer controls for the same role", () => {
  const rects = {
    objects: [
      control("/Mobile/ButtonJump", "ButtonJump"),
      control("/Mobile/Fixed Joystick", "Fixed Joystick"),
    ],
  };
  const resolved = resolveDiscoveredRoles({
    ui: discoverUiControls(rects),
    explicit: { jumpKey: "Space", moveRightKey: "D" },
  });
  assert.equal(resolved.jumpButtonPath, undefined);
  assert.equal(resolved.joystickPath, undefined);
  assert.ok(resolved.notes.some((n) => /using explicit --jump-key Space/.test(n)));
  assert.ok(resolved.notes.some((n) => /using explicit --move-right-key D/.test(n)));
});

test("proposeAnimatorBool: explicit wins, single proposes, multiple ambiguous, none gives a reason", () => {
  assert.deepEqual(proposeAnimatorBool([], "jumping"), { kind: "proposed", bool: "jumping" });
  assert.deepEqual(
    proposeAnimatorBool([{ name: "jumping", type: "Bool" }, { name: "speed", type: "Float" }]),
    { kind: "proposed", bool: "jumping" },
  );
  const amb = proposeAnimatorBool([{ name: "jumping", type: "Bool" }, { name: "grounded", type: "Bool" }]);
  assert.equal(amb.kind, "ambiguous");
  const none = proposeAnimatorBool([{ name: "speed", type: "Float" }]);
  assert.equal(none.kind, "none");
});

test("setup attaches a proposed Animator bool as a measure-only sync signal on the jump interaction", () => {
  const contract = proposeFeelCaptureContract({
    root: "/tmp/g",
    scene: "Scene_1",
    playerPath: "/Player",
    jumpButtonPath: "/Canvas/ButtonJump",
    animatorBoolSignal: { bool: "jumping" },
  });
  const jump = contract.interactions.find((i) => i.id === "jump-tap");
  assert.ok(jump && "sampledFields" in jump && jump.sampledFields?.length === 1);
  const signal = (jump as { sampledFields: { method_name?: string; args?: unknown[]; type_name: string }[] }).sampledFields[0];
  assert.equal(signal.type_name, "Animator");
  assert.equal(signal.method_name, "GetBool");
  assert.deepEqual(signal.args, ["jumping"]);
  const sync = contract.metrics.find((m) => m.metric === "inputToAnimStateLatency");
  assert.equal(sync?.derivation, "sync");
  assert.equal(sync?.interactionId, "jump-tap");
});

test("a proposed sync signal is NOT invented when there is no jump interaction to carry it", () => {
  const contract = proposeFeelCaptureContract({
    root: "/tmp/g",
    playerPath: "/Player",
    animatorBoolSignal: { bool: "jumping" },
  });
  assert.equal(contract.metrics.some((m) => m.metric === "inputToAnimStateLatency"), false);
  assert.equal(contract.interactions.length, 0);
});

function ok(data: unknown): BridgeResponse {
  return { id: "1", status: "success", data, timestamp: 0 } as unknown as BridgeResponse;
}
function err(message: string): BridgeResponse {
  return { id: "1", status: "error", error: { message }, timestamp: 0 } as unknown as BridgeResponse;
}

test("discoverFeelSetup (online shell) classifies a live rect dump and animator params via an injected send", async () => {
  const calls: { command: string; params?: Record<string, unknown> }[] = [];
  const send = async (command: string, params?: Record<string, unknown>): Promise<BridgeResponse> => {
    calls.push({ command, params });
    if (command === "ui.get_screen_rects") {
      return ok({ objects: [control("/Mobile/ButtonJump", "ButtonJump"), control("/Mobile/Joystick", "Joystick")] });
    }
    if (command === "animator.get_state_machine") {
      return ok({ parameters: [{ name: "jumping", type: "Bool" }, { name: "speed", type: "Float" }] });
    }
    return ok({});
  };
  const result = await discoverFeelSetup({ send, scene: "Scene_1", animatorControllerPath: "Assets/Player.controller" });
  assert.equal(result.ui.jump.kind, "proposed");
  assert.equal(result.ui.joystick.kind, "proposed");
  assert.deepEqual(result.animatorBool, { kind: "proposed", bool: "jumping" });
  assert.ok(calls.some((c) => c.command === "ui.get_screen_rects"));
  assert.ok(calls.some((c) => c.command === "animator.get_state_machine"));
  assert.deepEqual(calls.find((c) => c.command === "scene.open_scene")?.params, {
    path: "Assets/Scenes/Scene_1.unity",
    mode: "Single",
  });
});

test("discoverFeelSetup degrades to nothing-proposed when the rect dump errors (never invents)", async () => {
  const send = async (command: string): Promise<BridgeResponse> =>
    command === "ui.get_screen_rects" ? err("bridge down") : ok({});
  const result = await discoverFeelSetup({ send });
  assert.deepEqual(result.ui, { controls: [], jump: { kind: "none" }, joystick: { kind: "none" } });
  assert.equal(result.animatorBool, undefined);
});

test("CLI: --discover without --setup-capture is a usage error (exit 2, no live call)", async () => {
  assert.equal(await quietRun(["--profile", "precision", "--discover"]), 2);
});

test("CLI: --animator-* without --discover is a usage error (exit 2, no live call)", async () => {
  assert.equal(
    await quietRun(["--profile", "precision", "--setup-capture", "--player", "/Player", "--animator-bool", "jumping"]),
    2,
  );
});
