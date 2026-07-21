import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { proposeFeelCaptureContract, writeFeelCaptureContract } from "../loomtide/feel-capture/setup.js";
import { SHORT_HOP_CANONICAL_TAP_TICKS } from "../loomtide/genre-packs/platformer-2d/measure-recipe.js";

test("setup proposal writes a generic uGUI capture contract for mobile/pointer games", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "loomtide-feel-setup-"));
  const outputPath = path.join(root, ".loomtide", "feel", "capture-contract.json");
  const contract = proposeFeelCaptureContract({
    root,
    game: "MobilePointerFixture",
    scene: "Gameplay",
    playerPath: "/Avatar",
    jumpButtonPath: "/Canvas/ButtonJump",
    joystickPath: "/Canvas/Fixed Joystick",
  });

  await writeFeelCaptureContract(contract, outputPath);
  const persisted = JSON.parse(await fs.readFile(outputPath, "utf-8"));

  assert.equal(persisted.schemaVersion, "1");
  assert.deepEqual(
    persisted.interactions.map((i: { id: string; kind: string }) => [i.id, i.kind]),
    [
      ["jump-tap", "ugui-tap"],
      ["short-hop-hold", "ugui-hold"],
      ["double-jump-taps", "ugui-multitap"],
      ["run-joystick", "ugui-hold-drag"],
    ],
  );
  const shortHop = persisted.interactions.find((i: { id: string }) => i.id === "short-hop-hold");
  assert.equal(shortHop?.holdFixedTicks, SHORT_HOP_CANONICAL_TAP_TICKS);
  assert.equal(shortHop?.settle?.kind, "settle-until-rest");
  assert.deepEqual(shortHop?.settle?.measure, { scene: "Gameplay", path: "/Avatar" });
  assert.ok(persisted.metrics.some((m: { metric: string }) => m.metric === "doubleJumpApex"));
  assert.ok(persisted.metrics.some((m: { metric: string }) => m.metric === "fallGravityMultiplier"));
  assert.ok(persisted.metrics.some((m: { metric: string }) => m.metric === "runDeceleration"));
  assert.ok(persisted.metrics.some((m: { metric: string }) => m.metric === "inputLatency"));
  assert.ok(persisted.metrics.some((m: { metric: string; derivation: string }) =>
    m.metric === "dashDistance" && m.derivation === "unsupported"));
  assert.ok(persisted.metrics.some((m: { metric: string; derivation: string; reason?: string }) =>
    m.metric === "coyoteTime" && m.derivation === "unsupported" && /ledge/i.test(m.reason ?? "")));
  assert.ok(persisted.metrics.some((m: { metric: string; derivation: string; reason?: string }) =>
    m.metric === "jumpBuffer" && m.derivation === "unsupported" && /landing/i.test(m.reason ?? "")));
  assert.ok(persisted.metrics.some((m: { metric: string; derivation: string; interactionId?: string }) =>
    m.metric === "shortHopApex" && m.derivation === "trajectory" && m.interactionId === "short-hop-hold"));
  assert.deepEqual(persisted.preconditions, [
    {
      kind: "scene-set-active",
      locator: { scene: "Gameplay", path: "/Canvas" },
      active: true,
      restore: true,
    },
  ]);
});

test("setup proposal supports explicit activation paths and disabling inferred uGUI root activation", () => {
  const contract = proposeFeelCaptureContract({
    root: "/tmp/game",
    scene: "Scene_1",
    playerPath: "/Player",
    jumpButtonPath: "/Controls/ButtonJump",
    joystickPath: "/Controls/Stick",
    activatePaths: ["/MobileControls"],
    autoActivateUiRoot: false,
  });

  assert.deepEqual(contract.preconditions, [
    {
      kind: "scene-set-active",
      locator: { scene: "Scene_1", path: "/MobileControls" },
      active: true,
      restore: true,
    },
  ]);
});

test("setup proposal adds canonical fixed-tick short hop for keyboard jump games", () => {
  const contract = proposeFeelCaptureContract({
    root: "/tmp/game",
    game: "KeyboardPlatformer",
    playerPath: "/Player",
    jumpKey: "Space",
    moveRightKey: "D",
  });

  const shortHop = contract.interactions.find((i) => i.id === "short-hop-key");
  assert.equal(shortHop?.kind, "keyboard");
  assert.deepEqual(shortHop && "phases" in shortHop ? shortHop.phases : undefined, [
    { keys: [], durationMs: 200 },
    { keys: ["Space"], fixedTicks: SHORT_HOP_CANONICAL_TAP_TICKS },
    { keys: [], durationMs: 1100 },
  ]);
  const metric = contract.metrics.find((m) => m.metric === "shortHopApex");
  assert.equal(metric?.interactionId, "short-hop-key");
  assert.equal(metric?.derivation, "trajectory");
  assert.equal(metric?.stimulus?.tapTicks, SHORT_HOP_CANONICAL_TAP_TICKS);

  // The generated keyboard short-hop must request a generic grounded-settle precondition
  // before the fixed-tick jump-cut probe, using only observable subject motion evidence.
  const settle = shortHop && "settle" in shortHop ? shortHop.settle : undefined;
  assert.ok(settle, "short-hop-key must carry a settle precondition");
  assert.equal(settle?.kind, "settle-until-rest");
  assert.deepEqual(settle?.measure, contract.subjects[0].locator);
  assert.ok((settle?.timeoutMs ?? 0) > 0);
  assert.ok((settle?.minStableSamples ?? 0) >= 1);
  assert.ok((settle?.minStableMs ?? 0) > 0);
  assert.ok((settle?.restThreshold ?? -1) > 0);
});

test("setup proposal attaches pointer-safe settle to uGUI fixed-tick short hops", () => {
  const contract = proposeFeelCaptureContract({
    root: "/tmp/game",
    game: "MobilePlatformer",
    scene: "Scene_1",
    playerPath: "/Avatar",
    jumpButtonPath: "/Canvas/ButtonJump",
  });
  const shortHop = contract.interactions.find((i) => i.id === "short-hop-hold");
  const settle = shortHop && "settle" in shortHop ? shortHop.settle : undefined;
  assert.ok(settle, "short-hop-hold must carry a settle precondition once no-input observation is available");
  assert.equal(settle?.kind, "settle-until-rest");
  assert.deepEqual(settle?.measure, contract.subjects[0].locator);
  assert.ok((settle?.timeoutMs ?? 0) > 0);
  assert.ok((settle?.minStableSamples ?? 0) >= 1);
  assert.ok((settle?.minStableMs ?? 0) > 0);
  assert.ok((settle?.restThreshold ?? -1) > 0);
});

test("setup proposal does not invent a short-hop settle for unsupported jump games", () => {
  const contract = proposeFeelCaptureContract({
    root: "/tmp/game",
    game: "NoJump",
    scene: "Scene_1",
    playerPath: "/Avatar",
  });
  // No jump button and no jump key: shortHopApex stays unsupported, with no fabricated interaction/settle.
  assert.ok(contract.interactions.every((i) => i.id !== "short-hop-key" && i.id !== "short-hop-hold"));
  assert.ok(contract.metrics.some((m) => m.metric === "shortHopApex" && m.derivation === "unsupported"));
});

test("setup proposal adds keyboard dash distance when move and dash keys are declared", () => {
  const contract = proposeFeelCaptureContract({
    root: "/tmp/game",
    game: "KeyboardPlatformer",
    playerPath: "/Player",
    moveRightKey: "D",
    dashKey: "LeftShift",
  });

  const dash = contract.interactions.find((i) => i.id === "dash-key");
  assert.equal(dash?.kind, "keyboard");
  assert.deepEqual(dash && "phases" in dash ? dash.phases : undefined, [
    { keys: [], durationMs: 200 },
    { keys: ["D"], durationMs: 300 },
    { keys: ["D", "LeftShift"], durationMs: 150 },
    { keys: ["D"], durationMs: 300 },
  ]);
  const metric = contract.metrics.find((m) => m.metric === "dashDistance");
  assert.equal(metric?.interactionId, "dash-key");
  assert.equal(metric?.derivation, "phase-delta");
  assert.equal(metric?.phaseIndex, 2);
  assert.equal(metric?.axis, "x");
  assert.deepEqual(metric?.requiredKeys, ["D", "LeftShift"]);
});

test("setup proposal leaves dash unsupported without a dash key", () => {
  const contract = proposeFeelCaptureContract({
    root: "/tmp/game",
    game: "KeyboardPlatformer",
    playerPath: "/Player",
    moveRightKey: "D",
  });

  const metric = contract.metrics.find((m) => m.metric === "dashDistance");
  assert.equal(metric?.derivation, "unsupported");
  assert.match(metric?.reason ?? "", /dash/i);
});

test("setup proposal marks absent drive recipes unsupported instead of inventing keyboard defaults", () => {
  const contract = proposeFeelCaptureContract({
    root: "/tmp/game",
    game: "LegacyNoUI",
    playerPath: "/Hero",
  });

  assert.equal(contract.interactions.length, 0);
  assert.deepEqual(
    contract.metrics.map((m) => [m.metric, m.derivation]),
    [
      ["jumpApex", "unsupported"],
      ["timeToApex", "unsupported"],
      ["fallGravityMultiplier", "unsupported"],
      ["shortHopApex", "unsupported"],
      ["runSpeed", "unsupported"],
      ["runAcceleration", "unsupported"],
      ["runDeceleration", "unsupported"],
      ["inputLatency", "unsupported"],
      ["dashDistance", "unsupported"],
      ["coyoteTime", "unsupported"],
      ["jumpBuffer", "unsupported"],
    ],
  );
});

test("setup proposal includes coyote/jump-buffer only from explicit semantic probes", () => {
  const coyoteProbe = {
    id: "coyote-semantic",
    kind: "semantic-probe" as const,
    metric: "coyoteTime" as const,
    measure: { path: "/Player" },
    anchors: [
      { id: "leave", kind: "ground-lost" as const, phaseIndex: 0 },
      { id: "jump", kind: "jump-input" as const, phaseIndex: 1 },
    ],
    trials: [
      {
        delayMs: 80,
        phases: [
          { durationMs: 80, drivers: [{ locator: { path: "/Player" }, type_name: "TestDriver", property_path: "jump", value: false }] },
          { durationMs: 500, drivers: [{ locator: { path: "/Player" }, type_name: "TestDriver", property_path: "jump", value: true }] },
        ],
      },
      {
        delayMs: 140,
        phases: [
          { durationMs: 140, drivers: [{ locator: { path: "/Player" }, type_name: "TestDriver", property_path: "jump", value: false }] },
          { durationMs: 500, drivers: [{ locator: { path: "/Player" }, type_name: "TestDriver", property_path: "jump", value: true }] },
        ],
      },
    ],
    jumpEvidence: { kind: "trajectory-rise" as const, afterAnchorId: "jump", minRise: 0.05 },
  };
  const contract = proposeFeelCaptureContract({
    root: "/tmp/game",
    playerPath: "/Player",
    jumpKey: "Space",
    semanticProbes: [coyoteProbe],
  });

  assert.ok(contract.interactions.some((i) => i.id === "coyote-semantic" && i.kind === "semantic-probe"));
  assert.ok(contract.metrics.some((m) =>
    m.metric === "coyoteTime" && m.derivation === "bisection" && m.interactionId === "coyote-semantic"));
  assert.ok(contract.metrics.some((m) => m.metric === "jumpBuffer" && m.derivation === "unsupported"));
});

test("setup writer refuses to overwrite without --force", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "loomtide-feel-setup-"));
  const outputPath = path.join(root, "capture-contract.json");
  const contract = proposeFeelCaptureContract({
    root,
    playerPath: "/Player",
    jumpKey: "Space",
    moveRightKey: "D",
  });

  await writeFeelCaptureContract(contract, outputPath);
  await assert.rejects(() => writeFeelCaptureContract(contract, outputPath), /already exists/);
  await writeFeelCaptureContract(contract, outputPath, { force: true });
});
