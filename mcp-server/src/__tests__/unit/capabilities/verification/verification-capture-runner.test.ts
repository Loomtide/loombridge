import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

import {
  analyzeRenderFrames,
  augmentCaptureFailure,
  buildFixList,
  buildScreenRectsParams,
  buildCaptureSequenceParams,
  collectScenarioDriverProps,
  decodeCapturedFrames,
  knownScenarioPacks,
  parseCaptureRunnerArgs,
  planCaptureRunnerOutputs,
  redactCaptureSequenceResult,
  renderVerificationSummary,
  resolveScenarioPath,
  selectScenarioPack,
} from "../../../../capabilities/verification/capture-runner.js";
import type { AcceptanceContract } from "../../../../capabilities/verification/types.js";
import type { VerificationScenario } from "../../../../capabilities/verification/scenario.js";
import { REPO_ROOT as REPO_ROOT_SUPPORT } from "../../../_support/paths.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const fixturePath = path.resolve(
  REPO_ROOT_SUPPORT,
  "mcp-server/src/capabilities/verification/scenarios/platformer-2d-basic.json",
);

async function loadFixture(): Promise<VerificationScenario> {
  return JSON.parse(await fs.readFile(fixturePath, "utf-8")) as VerificationScenario;
}

test("capture-runner: parses required backend CLI args", () => {
  const args = parseCaptureRunnerArgs([
    "node",
    "capture-runner.js",
    "--acceptance",
    "src/capabilities/verification/tiderunner.acceptance.json",
    "--scenario",
    "src/capabilities/verification/scenarios/platformer-2d-basic.json",
    "--out",
    "../trace/verify",
    "--project",
    "GameA",
  ]);

  assert.ok(args.acceptancePath.endsWith("src/capabilities/verification/tiderunner.acceptance.json"));
  assert.ok(args.scenarioPath?.endsWith("src/capabilities/verification/scenarios/platformer-2d-basic.json"));
  assert.ok(args.outDir.endsWith("trace/verify"));
  assert.equal(args.project, "GameA");
});

test("capture-runner: allows omitted scenario for bundled pack auto-selection", () => {
  const args = parseCaptureRunnerArgs([
    "node",
    "capture-runner.js",
    "--acceptance",
    "src/capabilities/verification/tiderunner.acceptance.json",
    "--out",
    "../trace/verify",
  ]);

  assert.ok(args.acceptancePath.endsWith("src/capabilities/verification/tiderunner.acceptance.json"));
  assert.equal(args.scenarioPath, undefined);
  assert.ok(args.outDir.endsWith("trace/verify"));
});

test("capture-runner: plans all outputs under the supplied trace/verify dir", () => {
  const out = planCaptureRunnerOutputs("/tmp/example/trace/verify");

  assert.equal(out.framesDir, "/tmp/example/trace/verify/frames");
  assert.equal(out.captureSequencePath, "/tmp/example/trace/verify/capture-sequence.json");
  assert.equal(out.visualArtifactsPath, "/tmp/example/trace/verify/visual-artifacts.json");
  assert.equal(out.renderFramePath, "/tmp/example/trace/verify/render-frame.json");
  assert.equal(out.screenRectsPath, "/tmp/example/trace/verify/screen-rects.json");
  assert.equal(out.runtimeAssertionsPath, "/tmp/example/trace/verify/runtime-assertions.json");
  assert.equal(out.consolePath, "/tmp/example/trace/verify/console.json");
  assert.equal(out.buildVerdictPath, "/tmp/example/trace/verify/build-verdict.json");
  assert.equal(out.fixListPath, "/tmp/example/trace/verify/fix-list.json");
});

test("capture-runner: explicit scenario path takes precedence over bundled selection", () => {
  const acceptance = { schemaVersion: "1", game: "x", platformer: {} } as AcceptanceContract & { platformer: unknown };
  const scenarioPath = path.resolve("/tmp/custom-scenario.json");

  assert.equal(
    resolveScenarioPath({ acceptancePath: "/tmp/acceptance.json", scenarioPath, outDir: "/tmp/out" }, acceptance),
    scenarioPath,
  );
});

test("capture-runner: auto-selects the platformer bundled scenario from acceptance shape", () => {
  const acceptance = { schemaVersion: "1", game: "x", platformer: {} } as AcceptanceContract & { platformer: unknown };
  const selected = selectScenarioPack(acceptance);

  assert.equal(selected.id, "platformer-2d-basic");
  assert.equal(selected.gameKind, "platformer-2d");
  assert.ok(selected.path.endsWith("verification/scenarios/platformer-2d-basic.json"));
});

test("capture-runner: unknown genre fails with known packs and --scenario guidance", () => {
  const acceptance = { schemaVersion: "1", game: "topdown-demo" } as AcceptanceContract;

  assert.throws(
    () => selectScenarioPack(acceptance),
    /Known packs: platformer-2d-basic \(platformer-2d\).*--scenario/,
  );
  assert.deepEqual(knownScenarioPacks(), [{ id: "platformer-2d-basic", gameKind: "platformer-2d" }]);
});

test("capture-runner: builds runtime.capture_sequence params from scenario sequence", async () => {
  const scenario = await loadFixture();
  const params = buildCaptureSequenceParams(scenario, scenario.sequences[0]!);

  assert.deepEqual(params.measure, { path: "/Player" });
  assert.deepEqual(params.driver, {
    locator: { path: "/Player" },
    type_name: "PlayerController",
    property_path: "forceJump",
  });
  assert.equal((params.phases as unknown[]).length, 2);
  assert.equal((params.captures as unknown[]).length, 4);
  assert.equal(params.captureFps, 120);
  assert.equal(params.includeSamples, true);
  assert.equal(params.resetDriversOnEnd, true);
});

test("capture-runner: bundled platformer scenario is portable (no hardcoded scene, canonical force* drivers)", async () => {
  const scenario = await loadFixture();
  const canonical = new Set(["forceHorizontal", "forceJump", "forceDash"]);

  // RUN-1 #65: the bundled scenario must not pin a scene name (the skills build
  // <game>.unity, not "Game") and must drive the skills' real PlayerController API.
  const props = collectScenarioDriverProps(scenario);
  assert.ok(props.length > 0, "scenario should declare at least one driver property");
  for (const prop of props) {
    assert.ok(
      canonical.has(prop),
      `scenario driver property "${prop}" is not a canonical PlayerController driver (forceHorizontal/forceJump/forceDash)`,
    );
  }

  const serialized = JSON.stringify(scenario);
  assert.ok(!/"scene"\s*:\s*"Game"/.test(serialized), 'scenario must not hardcode scene:"Game"');
  assert.equal(scenario.measure.scene, undefined, "measure locator should omit scene (resolve active scene)");
});

test("capture-runner: collects distinct driver property paths from defaults + sequences", async () => {
  const scenario = await loadFixture();
  assert.deepEqual(collectScenarioDriverProps(scenario), ["forceHorizontal", "forceJump"]);
});

test("capture-runner: augments locator-resolution failures with fix-pointing guidance", async () => {
  const scenario = await loadFixture();
  const augmented = augmentCaptureFailure(
    new Error("Could not resolve locator {scene:\"Game\",path:\"/Player\"}"),
    scenario,
  );

  assert.match(augmented.message, /could not drive the player/i);
  assert.match(augmented.message, /forceHorizontal\/forceJump\/forceDash/);
  assert.match(augmented.message, /forceHorizontal, forceJump/); // the scenario's actual drivers
  assert.match(augmented.message, /--scenario/);
});

test("capture-runner: passes non-locator failures through unchanged", async () => {
  const scenario = await loadFixture();
  const original = new Error("Play Mode failed to enter");
  assert.equal(augmentCaptureFailure(original, scenario), original);
});

test("capture-runner: builds optional screen rect params from scenario collection config", async () => {
  const scenario = await loadFixture();
  scenario.collect = {
    screenRects: [{ scene: "Game", path: "/Player" }],
    screenRectCamera: { scene: "Game", path: "/Main Camera" },
    screenRectBoundsMode: "renderer",
  };

  assert.deepEqual(buildScreenRectsParams(scenario), {
    locators: [{ scene: "Game", path: "/Player" }],
    camera: { scene: "Game", path: "/Main Camera" },
    boundsMode: "renderer",
  });

  scenario.collect.screenRects = [];
  assert.equal(buildScreenRectsParams(scenario), null);
});

test("capture-runner: decodes returned frame base64 into namespaced png files", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "loombridge-capture-runner-"));
  try {
    const written = await decodeCapturedFrames({
      sequenceId: "jump-burst",
      framesDir: dir,
      result: {
        frames: [
          {
            id: "spawn",
            format: "png",
            width: 2,
            height: 1,
            image_base64: Buffer.from("fake-png-bytes").toString("base64"),
          },
        ],
      },
    });

    assert.equal(written.length, 1);
    assert.equal(written[0]!.id, "jump-burst:spawn");
    assert.equal(path.basename(written[0]!.path), "jump-burst-spawn.png");
    assert.equal(await fs.readFile(written[0]!.path, "utf-8"), "fake-png-bytes");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("capture-runner: redacts image payloads from capture-sequence metadata", () => {
  const result = redactCaptureSequenceResult({
    sequenceId: "jump-burst",
    frames: [{ id: "jump-burst:spawn", path: "frames/jump-burst-spawn.png", width: 2, height: 1 }],
    result: {
      captureCount: 1,
      frames: [
        {
          id: "spawn",
          trigger: "start",
          elapsedMs: 0,
          width: 2,
          height: 1,
          format: "png",
          image_base64: Buffer.from("large-image-payload").toString("base64"),
        },
      ],
    },
  }) as { frames: Array<Record<string, unknown>> };

  assert.equal(result.frames[0]!.id, "jump-burst:spawn");
  assert.equal(result.frames[0]!.path, "frames/jump-burst-spawn.png");
  assert.equal(result.frames[0]!.width, 2);
  assert.ok(!("image_base64" in result.frames[0]!));
});

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function writeTestPng(
  width: number,
  height: number,
  pixel: (x: number, y: number) => [number, number, number, number],
): Buffer {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;

  const raw = Buffer.alloc(height * (1 + width * 4));
  let offset = 0;
  for (let y = 0; y < height; y += 1) {
    raw[offset++] = 0;
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a] = pixel(x, y);
      raw[offset++] = r;
      raw[offset++] = g;
      raw[offset++] = b;
      raw[offset++] = a;
    }
  }

  return Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

test("capture-runner: analyzes captured PNGs into render-frame gate input", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "loombridge-render-frame-"));
  const framePath = path.join(dir, "boxed.png");
  try {
    await fs.writeFile(
      framePath,
      writeTestPng(10, 10, (_x, y) => (y < 2 || y > 8 ? [0, 0, 0, 255] : [80, 120, 160, 255])),
    );

    const result = await analyzeRenderFrames([{ id: "jump:boxed", path: framePath }]);
    const frame = result.frames?.[0];

    assert.equal(frame?.id, "jump:boxed");
    assert.equal(frame?.width, 10);
    assert.equal(frame?.height, 10);
    assert.equal(frame?.edgeBlackFraction?.top, 0.2);
    assert.equal(frame?.edgeBlackFraction?.bottom, 0.1);
    assert.deepEqual(frame?.contentRect, { x: 0, y: 2, width: 10, height: 7 });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("capture-runner: builds concise fail-first fix-list items from build verdict checks", () => {
  const fixList = buildFixList({
    status: "fail",
    failures: [
      {
        id: "render-frame.viewport.spawn",
        status: "fail",
        detail: "Frame appears boxed/letterboxed: edge border 10.0% exceeds 2.0%.",
      },
    ],
    warnings: [
      {
        id: "manifest.input",
        status: "warn",
        detail: 'No "verify-manifest.json" in --inputs; run unity_scene_verify_manifest and save its output there.',
      },
    ],
  });

  assert.equal(fixList.status, "fail");
  assert.equal(fixList.items.length, 2);
  assert.deepEqual(fixList.items[0], {
    gate: "render-frame",
    checkId: "render-frame.viewport.spawn",
    status: "fail",
    detail: "Frame appears boxed/letterboxed: edge border 10.0% exceeds 2.0%.",
    suggestedNextAction: "Fix the camera/Game-view viewport fill, or declare intentional letterbox in the contract.",
  });
  assert.equal(fixList.items[1]!.gate, "manifest");
  assert.equal(fixList.items[1]!.status, "warn");
  assert.equal(
    fixList.items[1]!.suggestedNextAction,
    "Capture the missing gate input under the runner's --out directory (.loombridge/verify/<state>/ in the canonical flow) and rerun.",
  );
});

test("capture-runner: renders fix-list section in verification summary", async () => {
  const scenario = await loadFixture();
  const summary = renderVerificationSummary({
    scenario,
    frameCount: 4,
    warnings: ["screen-rect collection failed: offline"],
    verdictStatus: "fail",
    fixList: {
      status: "fail",
      items: [
        {
          gate: "render-frame",
          checkId: "render-frame.viewport.spawn",
          status: "fail",
          detail: "Frame appears boxed.",
          suggestedNextAction: "Fix the camera/Game-view viewport fill.",
        },
      ],
    },
  });

  assert.match(summary, /## Fix List/);
  assert.match(summary, /\[fail\] render-frame\/render-frame\.viewport\.spawn: Frame appears boxed\./);
  assert.match(summary, /Next: Fix the camera\/Game-view viewport fill\./);
});
