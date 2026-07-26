import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runFeelCaptureLive, type FeelCaptureLiveClient } from "../capabilities/feel/live.js";
import type { FeelCaptureContract } from "../capabilities/feel/types.js";
import type { BridgeResponse } from "../shared/types.js";

function success(data: unknown): BridgeResponse {
  return { id: crypto.randomUUID(), status: "success", data, timestamp: Date.now() };
}

class FakeClient implements FeelCaptureLiveClient {
  public connected = false;
  public calls: string[] = [];
  public params: Record<string, unknown>[] = [];
  public sent: { command: string; params: Record<string, unknown> }[] = [];
  public failDisconnect = false;
  // Names of scenes the editor currently reports as loaded via scene.get_hierarchy.
  // Empty by default so existing tests keep exercising the open-by-path path.
  public loadedScenes: string[] = [];

  get isConnected(): boolean {
    return this.connected;
  }

  async connect(): Promise<void> {
    this.calls.push("connect");
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.calls.push("disconnect");
    if (this.failDisconnect) throw new Error("disconnect broke");
    this.connected = false;
  }

  async waitForReconnect(): Promise<boolean> {
    this.calls.push("waitForReconnect");
    return this.connected;
  }

  async send(command: string, params: Record<string, unknown> = {}): Promise<BridgeResponse> {
    this.calls.push(command);
    this.params.push(params);
    this.sent.push({ command, params });
    if (command === "scene.get_hierarchy") {
      return success({ scenes: this.loadedScenes.map((name) => ({ name, rootObjects: [] })) });
    }
    if (command === "runtime.get_snapshot") {
      return success({ activeSelf: false, activeInHierarchy: false });
    }
    if (command === "runtime.capture_pointer_motion") {
      return success({
        dispatch: { actuated: true },
        samples: [
          { tMs: 0, x: 0, y: 0 },
          { tMs: 100, x: 0, y: 1 },
          { tMs: 200, x: 0, y: 2 },
        ],
      });
    }
    if (command === "runtime.capture_input_motion") {
      return success({
        samples: [
          { tMs: 0, x: 0, y: 0, phase: 0 },
          { tMs: 100, x: 0, y: 0, phase: 0 },
          { tMs: 200, x: 1, y: 0, phase: 1 },
          { tMs: 300, x: 2, y: 0, phase: 1 },
        ],
        phases: [
          { index: 0, keys: [], sampleCount: 2, deltaX: 0, deltaY: 0 },
          { index: 1, keys: ["D"], sampleCount: 2, deltaX: 1, deltaY: 0 },
        ],
      });
    }
    return success({});
  }
}

test("live feel capture enters Play, runs the generic contract, writes measurements, and stops", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "loombridge-feel-live-"));
  const contractPath = path.join(root, "capture-contract.json");
  const outputPath = path.join(root, "profile-measurements.json");
  const artifactsDir = path.join(root, "capture-artifacts");
  const contract: FeelCaptureContract = {
    schemaVersion: "1",
    subjects: [{ id: "player", locator: { path: "/Player" } }],
    interactions: [{ id: "jump", kind: "ugui-tap", measure: { path: "/Player" }, target: { path: "/Jump" } }],
    metrics: [{ metric: "jumpApex", interactionId: "jump", derivation: "trajectory" }],
  };
  await fs.writeFile(contractPath, JSON.stringify(contract), "utf-8");

  const fake = new FakeClient();
  const result = await runFeelCaptureLive({
    contractPath,
    outputPath,
    artifactsDir,
    clientFactory: () => ({
      client: fake,
      disconnect: () => fake.disconnect(),
      routing: () => ({ projectTarget: "Fixture", routeReason: "target" }),
    }),
  });

  assert.equal(result.measurements.metrics.jumpApex, 2);
  assert.deepEqual(
    fake.calls.filter((c) => c !== "waitForReconnect"),
    [
      "connect",
      "editor.play",
      "editor.wait_for",
      "runtime.capture_pointer_motion",
      "editor.stop",
      "editor.wait_for",
      "disconnect",
    ],
  );
  const written = JSON.parse(await fs.readFile(outputPath, "utf-8"));
  assert.equal(written.metrics.jumpApex, 2);
  assert.equal(written.captureCoverage[0].status, "measured");
  assert.equal(written.provenance.unityRouting.projectTarget, "Fixture");
  assert.equal(result.artifactsDir, artifactsDir);

  const raw = JSON.parse(await fs.readFile(path.join(artifactsDir, "raw-captures.json"), "utf-8"));
  assert.equal(raw[0].interactionId, "jump");
  assert.equal(raw[0].data.dispatch.actuated, true);

  const copiedContract = JSON.parse(await fs.readFile(path.join(artifactsDir, "capture-contract.json"), "utf-8"));
  assert.equal(copiedContract.metrics[0].metric, "jumpApex");

  const summary = JSON.parse(await fs.readFile(path.join(artifactsDir, "capture-summary.json"), "utf-8"));
  assert.deepEqual(summary.measuredMetrics, ["jumpApex"]);
  assert.equal(summary.captureCoverage[0].status, "measured");
  assert.equal(summary.unityRouting.projectTarget, "Fixture");
});

test("live feel capture opens the contract scene and restores activation preconditions", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "loombridge-feel-live-preflight-"));
  const contractPath = path.join(root, "capture-contract.json");
  const outputPath = path.join(root, "profile-measurements.json");
  const contract: FeelCaptureContract = {
    schemaVersion: "1",
    subjects: [{ id: "player", locator: { scene: "Assets/Scenes/Scene_1.unity", path: "/Player" } }],
    preconditions: [
      { kind: "scene-set-active", locator: { scene: "Assets/Scenes/Scene_1.unity", path: "/Controls" }, active: true, restore: true },
    ],
    interactions: [
      {
        id: "jump",
        kind: "ugui-tap",
        measure: { scene: "Assets/Scenes/Scene_1.unity", path: "/Player" },
        target: { scene: "Assets/Scenes/Scene_1.unity", path: "/Controls/ButtonJump" },
      },
    ],
    metrics: [{ metric: "jumpApex", interactionId: "jump", derivation: "trajectory" }],
  };
  await fs.writeFile(contractPath, JSON.stringify(contract), "utf-8");

  const fake = new FakeClient();
  await runFeelCaptureLive({
    contractPath,
    outputPath,
    clientFactory: () => ({
      client: fake,
      disconnect: () => fake.disconnect(),
      routing: () => ({ projectTarget: "Fixture", routeReason: "target" }),
    }),
  });

  assert.deepEqual(
    fake.calls.filter((c) => c !== "waitForReconnect"),
    [
      "connect",
      "editor.stop",
      "editor.wait_for",
      "scene.open_scene",
      "editor.wait_for",
      "runtime.get_snapshot",
      "scene.set_active",
      "editor.play",
      "editor.wait_for",
      "runtime.capture_pointer_motion",
      "editor.stop",
      "editor.wait_for",
      "scene.set_active",
      "disconnect",
    ],
  );
  assert.deepEqual(fake.sent.find((entry) => entry.command === "scene.open_scene")?.params, {
    path: "Assets/Scenes/Scene_1.unity",
    mode: "Single",
  });
  const setActiveCalls = fake.sent
    .filter((entry) => entry.command === "scene.set_active")
    .map((entry) => entry.params);
  assert.deepEqual(setActiveCalls, [
    { locator: { scene: "Scene_1", path: "/Controls" }, active: true },
    { locator: { scene: "Scene_1", path: "/Controls" }, active: false },
  ]);
});

test("live feel capture opens explicit scene paths but resolves locators by loaded scene name", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "loombridge-feel-live-scene-path-"));
  const contractPath = path.join(root, "capture-contract.json");
  const outputPath = path.join(root, "profile-measurements.json");
  const contract: FeelCaptureContract = {
    schemaVersion: "1",
    subjects: [{ id: "player", locator: { scene: "Assets/PC2D/Example/Platformer/Platformer.unity", path: "/Player" } }],
    preconditions: [
      {
        kind: "scene-set-active",
        locator: { scene: "Assets/PC2D/Example/Platformer/Platformer.unity", path: "/Controls" },
        active: true,
        restore: true,
      },
    ],
    interactions: [
      {
        id: "jump",
        kind: "ugui-tap",
        measure: { scene: "Assets/PC2D/Example/Platformer/Platformer.unity", path: "/Player" },
        target: { scene: "Assets/PC2D/Example/Platformer/Platformer.unity", path: "/Controls/ButtonJump" },
      },
    ],
    metrics: [{ metric: "jumpApex", interactionId: "jump", derivation: "trajectory" }],
  };
  await fs.writeFile(contractPath, JSON.stringify(contract), "utf-8");

  const fake = new FakeClient();
  await runFeelCaptureLive({
    contractPath,
    outputPath,
    clientFactory: () => ({
      client: fake,
      disconnect: () => fake.disconnect(),
      routing: () => ({ projectTarget: "Fixture", routeReason: "target" }),
    }),
  });

  assert.deepEqual(fake.sent.find((entry) => entry.command === "scene.open_scene")?.params, {
    path: "Assets/PC2D/Example/Platformer/Platformer.unity",
    mode: "Single",
  });
  assert.deepEqual(fake.sent.find((entry) => entry.command === "runtime.get_snapshot")?.params, {
    locator: { scene: "Platformer", path: "/Controls" },
  });
  assert.deepEqual(fake.sent.find((entry) => entry.command === "runtime.capture_pointer_motion")?.params, {
    measure: { scene: "Platformer", path: "/Player" },
    target: { scene: "Platformer", path: "/Controls/ButtonJump" },
    settleMs: undefined,
    captureMs: undefined,
    includeSamples: true,
    sampledFields: undefined,
  });
});

test("live feel capture wraps keyboard contracts in an Input System session", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "loombridge-feel-live-keyboard-"));
  const contractPath = path.join(root, "capture-contract.json");
  const outputPath = path.join(root, "profile-measurements.json");
  const contract: FeelCaptureContract = {
    schemaVersion: "1",
    subjects: [{ id: "player", locator: { scene: "Platformer", path: "/Player" } }],
    interactions: [
      {
        id: "run-key",
        kind: "keyboard",
        measure: { scene: "Platformer", path: "/Player" },
        phases: [{ keys: [], durationMs: 100 }, { keys: ["D"], durationMs: 300 }],
      },
    ],
    metrics: [{ metric: "runSpeed", interactionId: "run-key", derivation: "trajectory" }],
  };
  await fs.writeFile(contractPath, JSON.stringify(contract), "utf-8");

  const fake = new FakeClient();
  fake.loadedScenes = ["Platformer"];
  await runFeelCaptureLive({
    contractPath,
    outputPath,
    clientFactory: () => ({
      client: fake,
      disconnect: () => fake.disconnect(),
      routing: () => ({ projectTarget: "Fixture", routeReason: "target" }),
    }),
  });

  assert.deepEqual(
    fake.calls.filter((c) => c !== "waitForReconnect"),
    [
      "connect",
      "scene.get_hierarchy",
      "editor.stop",
      "editor.wait_for",
      "editor.play",
      "editor.wait_for",
      "input.begin_session",
      "runtime.capture_input_motion",
      "input.end_session",
      "editor.stop",
      "editor.wait_for",
      "disconnect",
    ],
  );
  assert.deepEqual(fake.sent.find((entry) => entry.command === "input.begin_session")?.params, {
    backend: "InputSystem",
  });
});

test("live feel capture preserves measurements and artifacts when disconnect cleanup fails", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "loombridge-feel-live-disconnect-"));
  const contractPath = path.join(root, "capture-contract.json");
  const outputPath = path.join(root, "profile-measurements.json");
  const artifactsDir = path.join(root, "capture-artifacts");
  const contract: FeelCaptureContract = {
    schemaVersion: "1",
    subjects: [{ id: "player", locator: { path: "/Player" } }],
    interactions: [{ id: "jump", kind: "ugui-tap", measure: { path: "/Player" }, target: { path: "/Jump" } }],
    metrics: [{ metric: "jumpApex", interactionId: "jump", derivation: "trajectory" }],
  };
  await fs.writeFile(contractPath, JSON.stringify(contract), "utf-8");

  const fake = new FakeClient();
  fake.failDisconnect = true;
  const result = await runFeelCaptureLive({
    contractPath,
    outputPath,
    artifactsDir,
    clientFactory: () => ({
      client: fake,
      disconnect: () => fake.disconnect(),
      routing: () => ({ projectTarget: "Fixture", routeReason: "target" }),
    }),
  });

  assert.match(result.warnings.join("\n"), /Failed to disconnect Unity client cleanly/);
  const written = JSON.parse(await fs.readFile(outputPath, "utf-8"));
  assert.equal(written.metrics.jumpApex, 2);
  const raw = JSON.parse(await fs.readFile(path.join(artifactsDir, "raw-captures.json"), "utf-8"));
  assert.equal(raw[0].interactionId, "jump");
  const summary = JSON.parse(await fs.readFile(path.join(artifactsDir, "capture-summary.json"), "utf-8"));
  assert.match(summary.warnings.join("\n"), /disconnect broke/);
});

test("live feel capture runs trace-replay contracts through the replay driver", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "loombridge-feel-live-trace-"));
  const traceDir = path.join(root, ".loombridge", "replays", "traces");
  await fs.mkdir(traceDir, { recursive: true });
  await fs.writeFile(
    path.join(traceDir, "start-game.json"),
    JSON.stringify({
      schemaVersion: "0.1",
      id: "start-game",
      start: { scene: "Assets/Scenes/Fake.unity", reset: "scene-load" },
      input: { backend: "ui-events" },
      segments: [{ id: "start", actions: [{ do: "wait", durationMs: 1 }] }],
      outcome: { expected: "success" },
    }),
    "utf-8",
  );

  const contractPath = path.join(root, "capture-contract.json");
  const outputPath = path.join(root, "profile-measurements.json");
  const artifactsDir = path.join(root, "capture-artifacts");
  const contract: FeelCaptureContract = {
    schemaVersion: "1",
    subjects: [{ id: "game", locator: { path: "/" } }],
    interactions: [{ id: "replay-start", kind: "trace-replay", traceId: "start-game" }],
    metrics: [{ metric: "traceDurationMs", interactionId: "replay-start", derivation: "trace" }],
  };
  await fs.writeFile(contractPath, JSON.stringify(contract), "utf-8");

  const fake = new FakeClient();
  const result = await runFeelCaptureLive({
    root,
    contractPath,
    outputPath,
    artifactsDir,
    clientFactory: () => ({
      client: fake,
      disconnect: () => fake.disconnect(),
      routing: () => ({ projectTarget: "Fixture", routeReason: "target" }),
    }),
  });

  assert.equal(result.measurements.captureCoverage[0].status, "measured");
  assert.equal(typeof result.measurements.metrics.traceDurationMs, "number");
  const openSceneCalls = fake.sent.filter((entry) => entry.command === "scene.open_scene").map((entry) => entry.params);
  assert.deepEqual(openSceneCalls, [{ path: "Assets/Scenes/Fake.unity", mode: "Single" }]);
  const raw = JSON.parse(await fs.readFile(path.join(artifactsDir, "raw-captures.json"), "utf-8"));
  assert.equal(raw[0].source, "replay.trace");
  assert.equal(raw[0].data.replay.status, "pass");
});

test("live feel capture reuses the already-loaded scene by name instead of guessing a path", async () => {
  // Regression: a bare scene name (e.g. PC2D's "Platformer", stored at
  // Assets/PC2D/Example/Platformer/Platformer.unity, NOT Assets/Scenes/) used to be
  // forced through scenePathFor → "Assets/Scenes/Platformer.unity" → NOT_FOUND.
  // When that scene is already the loaded scene, we must NOT re-open it by a guessed path.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "loombridge-feel-live-loaded-"));
  const contractPath = path.join(root, "capture-contract.json");
  const outputPath = path.join(root, "profile-measurements.json");
  const contract: FeelCaptureContract = {
    schemaVersion: "1",
    subjects: [{ id: "player", locator: { scene: "Platformer", path: "/Basic Player Controller" } }],
    interactions: [
      {
        id: "run-key",
        kind: "keyboard",
        measure: { scene: "Platformer", path: "/Basic Player Controller" },
        phases: [{ keys: [], durationMs: 100 }, { keys: ["d"], durationMs: 300 }],
      },
    ],
    metrics: [{ metric: "runSpeed", interactionId: "run-key", derivation: "trajectory" }],
  };
  await fs.writeFile(contractPath, JSON.stringify(contract), "utf-8");

  const fake = new FakeClient();
  fake.loadedScenes = ["Platformer"];
  await runFeelCaptureLive({
    contractPath,
    outputPath,
    clientFactory: () => ({
      client: fake,
      disconnect: () => fake.disconnect(),
      routing: () => ({ projectTarget: "Fixture", routeReason: "target" }),
    }),
  });

  // No guessed-path open: the loaded scene already matches the contract scene name.
  assert.equal(fake.sent.find((entry) => entry.command === "scene.open_scene"), undefined);
  // Capture still ran (keyboard session + motion) so measurements are produced.
  assert.ok(fake.calls.includes("runtime.capture_input_motion"));
});

test("live feel capture opens explicit scene paths instead of reusing basename matches", async () => {
  // Explicit asset paths are unambiguous. Do not reuse a loaded scene by basename only:
  // projects can contain multiple scenes named Platformer in different folders, and a
  // basename match would silently capture the wrong scene.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "loombridge-feel-live-explicit-path-"));
  const contractPath = path.join(root, "capture-contract.json");
  const outputPath = path.join(root, "profile-measurements.json");
  const contract: FeelCaptureContract = {
    schemaVersion: "1",
    subjects: [{ id: "player", locator: { scene: "Assets/PC2D/Example/Platformer/Platformer.unity", path: "/Basic Player Controller" } }],
    interactions: [
      {
        id: "run-key",
        kind: "keyboard",
        measure: { scene: "Assets/PC2D/Example/Platformer/Platformer.unity", path: "/Basic Player Controller" },
        phases: [{ keys: [], durationMs: 100 }, { keys: ["d"], durationMs: 300 }],
      },
    ],
    metrics: [{ metric: "runSpeed", interactionId: "run-key", derivation: "trajectory" }],
  };
  await fs.writeFile(contractPath, JSON.stringify(contract), "utf-8");

  const fake = new FakeClient();
  fake.loadedScenes = ["Platformer"];
  await runFeelCaptureLive({
    contractPath,
    outputPath,
    clientFactory: () => ({
      client: fake,
      disconnect: () => fake.disconnect(),
      routing: () => ({ projectTarget: "Fixture", routeReason: "target" }),
    }),
  });

  const open = fake.sent.find((entry) => entry.command === "scene.open_scene");
  assert.deepEqual(open?.params, { path: "Assets/PC2D/Example/Platformer/Platformer.unity", mode: "Single" });
  assert.equal(fake.sent.find((entry) => entry.command === "scene.get_hierarchy"), undefined);
});

test("live feel capture surfaces an actionable error when a bare-name scene is not loaded", async () => {
  // When the contract scene is a bare name AND that scene is not currently loaded, the
  // runner cannot resolve its asset path generically. It must say so clearly rather than
  // failing deep inside scene.open_scene with "Scene file not found: Assets/Scenes/...".
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "loombridge-feel-live-unloaded-"));
  const contractPath = path.join(root, "capture-contract.json");
  const outputPath = path.join(root, "profile-measurements.json");
  const contract: FeelCaptureContract = {
    schemaVersion: "1",
    subjects: [{ id: "player", locator: { scene: "Platformer", path: "/Basic Player Controller" } }],
    interactions: [
      {
        id: "run-key",
        kind: "keyboard",
        measure: { scene: "Platformer", path: "/Basic Player Controller" },
        phases: [{ keys: [], durationMs: 100 }, { keys: ["d"], durationMs: 300 }],
      },
    ],
    metrics: [{ metric: "runSpeed", interactionId: "run-key", derivation: "trajectory" }],
  };
  await fs.writeFile(contractPath, JSON.stringify(contract), "utf-8");

  const fake = new FakeClient();
  fake.loadedScenes = ["SomeOtherScene"];
  await assert.rejects(
    runFeelCaptureLive({
      contractPath,
      outputPath,
      clientFactory: () => ({
        client: fake,
        disconnect: () => fake.disconnect(),
        routing: () => ({ projectTarget: "Fixture", routeReason: "target" }),
      }),
    }),
    /Platformer.*not loaded|not loaded.*Platformer|explicit scene (path|asset path)/i,
  );
  // It must NOT have blindly guessed an Assets/Scenes/ path.
  assert.equal(fake.sent.find((entry) => entry.command === "scene.open_scene"), undefined);
});
