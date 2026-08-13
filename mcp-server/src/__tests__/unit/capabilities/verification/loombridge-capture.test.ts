import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  captureRecipesForFiles,
  recipeOutputs,
  runCapture,
  type CaptureArgs,
  type CaptureDeps,
} from "../../../../capabilities/verification/capture.js";
import {
  clearExpectedTileOutputs,
  stampExpectedTileCaptures,
  stampProvenance,
} from "../../../../capabilities/verification/capture-tiles.js";
import { CAPTURE_REPORT_FILE } from "../../../../domain/capture-manifest.js";
import { loombridgePaths, writeState } from "../../../../domain/state.js";
import { REPO_ROOT } from "../../../_support/paths.js";
import { resolveVisualArtifactsScenario } from "../../../../capabilities/verification/capture-visual-artifacts.js";

// ── captureRecipesForFiles (dispatch on the manifest FILE LIST, not gate names) ──
//
// The single source of truth is `gateInputFiles`, the map `build` mints a slice's
// captureManifest from, so dispatch and the verifier's demand cannot drift.

test("captureRecipesForFiles: screen-rects.json selects the framing recipe", () => {
  const d = captureRecipesForFiles(["screen-rects.json", "console.json"]);
  assert.deepEqual(d.recipes, ["framing"]);
  assert.deepEqual(d.unproduced, []);
});

test("captureRecipesForFiles: the tile capture files select the tiles recipe", () => {
  const d = captureRecipesForFiles(["platform-tiles.json", "tile-render.json", "console.json"]);
  assert.deepEqual(d.recipes, ["tiles"]);
  assert.deepEqual(d.unproduced, []);
});

test("captureRecipesForFiles: console.json alone selects the console-only recipe", () => {
  const d = captureRecipesForFiles(["console.json"]);
  assert.deepEqual(d.recipes, ["console"]);
});

test("captureRecipesForFiles: a slice needing BOTH gets BOTH recipes (the old single-kind dispatch lost one)", () => {
  // LITMUS for the regression this replaces: `captureKindForSlice` returned one
  // kind by positional precedence, so a slice declaring framing AND tiling
  // silently captured tiles only and screen-rects.json was never written.
  const d = captureRecipesForFiles(["screen-rects.json", "platform-tiles.json", "tile-render.json", "console.json"]);
  assert.deepEqual(d.recipes, ["tiles", "framing"]);
  assert.deepEqual(d.unproduced, []);
  assert.equal(d.files.find((f) => f.file === "screen-rects.json")?.recipe, "framing");
  assert.equal(d.files.find((f) => f.file === "platform-tiles.json")?.recipe, "tiles");
});

test("captureRecipesForFiles: entries no recipe writes are named as unproduced (never silently dropped)", () => {
  const d = captureRecipesForFiles(["asset-manifest.json", "verify-manifest.json", "console.json"]);
  assert.deepEqual(d.recipes, ["console"]);
  assert.deepEqual(d.unproduced, ["asset-manifest.json", "verify-manifest.json"]);
  assert.equal(d.files.find((f) => f.file === "asset-manifest.json")?.recipe, null);
  assert.equal(d.files.find((f) => f.file === "console.json")?.recipe, "console");
});

test("captureRecipesForFiles: a manifest with nothing producible selects no recipe", () => {
  const d = captureRecipesForFiles(["asset-manifest.json", "verify-manifest.json"]);
  assert.deepEqual(d.recipes, []);
  assert.deepEqual(d.unproduced, ["asset-manifest.json", "verify-manifest.json"]);
});

test("captureRecipesForFiles: feel.json selects the feel recipe (evidence arc stage 2)", () => {
  const d = captureRecipesForFiles(["feel.json", "console.json"]);
  assert.deepEqual(d.recipes, ["feel"]);
  assert.deepEqual(d.unproduced, []);
  // The feel session holds play mode for the whole run, so its own console snapshot
  // covers it: the console-only recipe must NOT also be selected.
  assert.equal(d.files.find((f) => f.file === "console.json")?.recipe, "feel");
});

test("captureRecipesForFiles: a slice needing framing AND feel runs both, in run order", () => {
  const d = captureRecipesForFiles(["screen-rects.json", "feel.json", "console.json"]);
  assert.deepEqual(d.recipes, ["framing", "feel"]);
  assert.deepEqual(d.unproduced, []);
});

test("captureRecipesForFiles: playability.json selects the observer (evidence arc stage 3)", () => {
  const d = captureRecipesForFiles(["playability.json", "console.json"]);
  assert.deepEqual(d.recipes, ["playability"]);
  assert.deepEqual(d.unproduced, [], "playability.json is no longer agent-assembly-required");
  // The observer holds play mode across the whole hand-driven completion, so its
  // console snapshot is the one covering the session the verdict describes
  // (ledger L106: console.json used to come from a soak BEFORE the played run).
  assert.equal(d.files.find((f) => f.file === "console.json")?.recipe, "playability");
});

test("captureRecipesForFiles: the observer runs LAST, after every recipe the CLI can run alone", () => {
  const d = captureRecipesForFiles(["screen-rects.json", "feel.json", "playability.json", "console.json"]);
  assert.deepEqual(d.recipes, ["framing", "feel", "playability"]);
  assert.deepEqual(d.unproduced, []);
});

test("recipeOutputs: every recipe writes console.json on its way past", () => {
  assert.ok(recipeOutputs("framing").includes("console.json"));
  assert.ok(recipeOutputs("tiles").includes("console.json"));
  assert.ok(recipeOutputs("feel").includes("console.json"));
  assert.ok(recipeOutputs("feel").includes("feel.json"));
  assert.ok(recipeOutputs("playability").includes("console.json"));
  assert.ok(recipeOutputs("playability").includes("playability.json"));
  assert.deepEqual(recipeOutputs("console"), ["console.json"]);
});

// ── stampProvenance (we never fabricate capture content) ─────────────────────

test("stampProvenance: preserves the raw gate content, only adds _provenance", () => {
  const raw = { platforms: [{ name: "Ground", widthTiles: 16, rows: [{ index: 0, role: "top_cap" }] }] };
  const out = stampProvenance(raw, { writer: "loombridge capture (ground-tiling)", method: "WriteTileCaptures" });
  assert.deepEqual(out.platforms, raw.platforms); // content untouched
  assert.equal((out._provenance as Record<string, unknown>).method, "WriteTileCaptures");
});

test("clearExpectedTileOutputs: removes stale expected tile captures before invoke", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "loombridge-capture-stale-"));
  await fs.writeFile(path.join(root, "platform-tiles.json"), JSON.stringify({ stale: true }), "utf-8");
  await fs.writeFile(path.join(root, "tile-render.json"), JSON.stringify({ stale: true }), "utf-8");
  await fs.writeFile(path.join(root, "unrelated.json"), JSON.stringify({ keep: true }), "utf-8");

  await clearExpectedTileOutputs(root);

  await assert.rejects(fs.stat(path.join(root, "platform-tiles.json")));
  await assert.rejects(fs.stat(path.join(root, "tile-render.json")));
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, "unrelated.json"), "utf-8")), { keep: true });
  await fs.rm(root, { recursive: true, force: true });
});

test("stampExpectedTileCaptures: does not provenance stale files that were not freshly reported", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "loombridge-capture-stamp-"));
  await fs.writeFile(path.join(root, "platform-tiles.json"), JSON.stringify({ platforms: [] }), "utf-8");
  await fs.writeFile(path.join(root, "tile-render.json"), JSON.stringify({ platforms: [] }), "utf-8");

  const provenanced = await stampExpectedTileCaptures(root, ["platform-tiles.json"], { writer: "test" });

  assert.deepEqual(provenanced, ["platform-tiles.json"]);
  const platform = JSON.parse(await fs.readFile(path.join(root, "platform-tiles.json"), "utf-8"));
  const tile = JSON.parse(await fs.readFile(path.join(root, "tile-render.json"), "utf-8"));
  assert.equal(platform._provenance.writer, "test");
  assert.equal(tile._provenance, undefined);
  await fs.rm(root, { recursive: true, force: true });
});

// ── runCapture dispatch + refusals (DI fakes, no live editor) ────────────────

const SLICES = {
  schemaVersion: "1",
  genre: "platformer-2d",
  slices: [
    {
      id: "framing",
      title: "Frame the level",
      dependsOn: [],
      skill: "platformer-level-design",
      feelIntent: "static frame",
      acceptance: { gates: ["framing", "console-clean"] },
      state: "verified",
    },
    {
      id: "ground-tiling",
      title: "Ground + platform tiling",
      dependsOn: ["framing"],
      skill: "platformer-level-design",
      feelIntent: "solid capped tiles",
      acceptance: { gates: ["platform-tiles", "tile-render", "placement", "console-clean"] },
      state: "built",
    },
    {
      id: "parallax",
      title: "Parallax background",
      dependsOn: ["framing"],
      skill: "parallax-2d",
      feelIntent: "seamless parallax",
      acceptance: { gates: ["coverage", "parallax-motion", "render-frame", "visual-artifacts", "console-clean"] },
      state: "built",
    },
    {
      id: "player-feel",
      title: "Player feel",
      dependsOn: [],
      skill: "game-polish-2d",
      feelIntent: "numbers",
      acceptance: { gates: ["feel", "feel-provenance", "feel-rederive", "physics-timestep", "console-clean"] },
      state: "built",
    },
    {
      id: "manifest-only",
      title: "Asset manifest",
      dependsOn: [],
      skill: "unity-2d-game",
      feelIntent: "nothing driveable",
      acceptance: { gates: ["manifest"] },
      state: "pending",
    },
    {
      id: "feel-only",
      title: "Feel",
      dependsOn: [],
      skill: "game-polish-2d",
      feelIntent: "numbers",
      acceptance: { gates: ["manifest", "feel"] },
      state: "pending",
    },
  ],
};

/** A project with SLICES.json AND a minted run (the door `capture` refuses without). */
async function scaffold(options: { runId?: string | null } = {}): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "loombridge-capture-"));
  await fs.mkdir(path.join(root, ".loombridge"), { recursive: true });
  await fs.writeFile(path.join(root, ".loombridge", "SLICES.json"), JSON.stringify(SLICES, null, 2), "utf-8");
  const runId = options.runId === undefined ? "run-test-0001" : options.runId;
  await writeState(loombridgePaths(root), {
    genre: "platformer-2d",
    engine: "unity",
    phase: "built-unverified",
    ...(runId ? { currentBuild: { runId, startedAt: "2026-07-01T00:00:00.000Z" } } : {}),
    updatedAt: "2026-07-01T00:00:00.000Z",
  });
  return root;
}

async function writeJson(file: string, body: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(body, null, 2), "utf-8");
}

/**
 * A fake producer's write. It stamps `_provenance.runId` because every REAL producer
 * does (framing/console/tiles/feel/playability all declare `runId: string` as required
 * and stamp it unconditionally, H11). Before E13 the fakes wrote bare JSON and the diff
 * still called it fresh, which is precisely the hole: an unprovenanced file must be
 * indistinguishable from a wrong-run one, so the fakes have to be as honest as the
 * producers they stand in for.
 */
async function writeProduced(file: string, body: Record<string, unknown>, runId: string): Promise<void> {
  await writeJson(file, { ...body, _provenance: { writer: "loombridge capture (test fake)", runId } });
}

interface RecordedDeps {
  deps: CaptureDeps;
  calls: string[];
  runIds: string[];
}

/**
 * Fakes that behave like the real producers: they WRITE the files they claim.
 * A fake that only returned paths would make the manifest diff vacuous, so every
 * positive control here really lands its evidence on disk.
 */
function recordingDeps(options: { writeFiles?: boolean } = {}): RecordedDeps {
  const writeFiles = options.writeFiles !== false;
  const calls: string[] = [];
  const runIds: string[] = [];
  const deps: CaptureDeps = {
    captureFraming: async (a) => {
      calls.push("framing");
      runIds.push(a.runId);
      const screenRectsPath = path.join(a.outDir, "screen-rects.json");
      const consolePath = path.join(a.outDir, "console.json");
      if (writeFiles) {
        await writeProduced(screenRectsPath, { objects: [] }, a.runId);
        await writeProduced(consolePath, { logs: [] }, a.runId);
      }
      return { screenRectsPath, consolePath, pixelPerfectCaptured: true, objectCount: 1, logCount: 3 };
    },
    captureFeel: async (a) => {
      calls.push("feel");
      runIds.push(a.runId);
      const feelPath = path.join(a.outDir, "feel.json");
      const consolePath = path.join(a.outDir, "console.json");
      if (writeFiles) {
        await writeProduced(feelPath, { runSpeed: 7 }, a.runId);
        await writeProduced(consolePath, { logs: [] }, a.runId);
      }
      return {
        feelPath,
        consolePath,
        measured: ["runSpeed"],
        omitted: [],
        gaps: [],
        logCount: 0,
        unmeasuredAcceptedTargets: [],
        outOfScopeAcceptedTargets: [],
      };
    },
    capturePlayability: async (a) => {
      calls.push("playability");
      runIds.push(a.runId);
      const playabilityPath = path.join(a.outDir, "playability.json");
      const consolePath = path.join(a.outDir, "console.json");
      if (writeFiles) {
        await writeProduced(playabilityPath, { completable: true }, a.runId);
        await writeProduced(consolePath, { logs: [] }, a.runId);
      }
      return {
        playabilityPath,
        consolePath,
        completionMethod: "played",
        sampleCount: 120,
        driveSeconds: 12,
        logCount: 0,
      };
    },
    captureTiles: async (a) => {
      calls.push("tiles");
      runIds.push(a.runId);
      const consolePath = path.join(a.outDir, "console.json");
      if (writeFiles) {
        await writeProduced(path.join(a.outDir, "platform-tiles.json"), { platforms: [] }, a.runId);
        await writeProduced(path.join(a.outDir, "tile-render.json"), { platforms: [] }, a.runId);
        await writeProduced(consolePath, { logs: [] }, a.runId);
      }
      return {
        outDir: a.outDir,
        wrote: ["platform-tiles.json", "tile-render.json"],
        provenancedFiles: ["platform-tiles.json", "tile-render.json"],
        consolePath,
        logCount: 3,
        playMode: false,
      };
    },
    captureVisualArtifacts: async (a) => {
      calls.push("visual-artifacts");
      runIds.push(a.runId);
      const visualArtifactsPath = path.join(a.outDir, "visual-artifacts.json");
      if (writeFiles) {
        await writeProduced(visualArtifactsPath, { frames: [], comparisons: [] }, a.runId);
        // The scenario session holds play mode for the whole sweep, so it writes console.json
        // too (RECIPE_INCIDENTAL_OUTPUTS). Omitting it here made the console recipe unnecessary
        // while nothing wrote the file: producer-ran-but-file-missing, exit 1.
        await writeProduced(path.join(a.outDir, "console.json"), { logs: [] }, a.runId);
      }
      return { visualArtifactsPath, framesDir: path.join(a.outDir, "frames"), scenarioPath: "/fixture/scenario.json" };
    },
    captureConsole: async (a) => {
      calls.push("console");
      runIds.push(a.runId);
      const consolePath = path.join(a.outDir, "console.json");
      if (writeFiles) await writeProduced(consolePath, { logs: [] }, a.runId);
      return { consolePath, logCount: 0, startupCount: 0, steadyCount: 0 };
    },
  };
  return { deps, calls, runIds };
}

function baseArgs(root: string, slice: string): CaptureArgs {
  return { root, slice, locators: ["/Player"] };
}

async function readReport(root: string, slice: string): Promise<Record<string, unknown>> {
  const file = path.join(root, ".loombridge", "verify", slice, CAPTURE_REPORT_FILE);
  return JSON.parse(await fs.readFile(file, "utf-8")) as Record<string, unknown>;
}

/** Run `capture` capturing stderr, so the named-refusal assertions see real output. */
async function runCapturing(args: CaptureArgs, deps: CaptureDeps): Promise<{ code: number; errors: string[] }> {
  const errors: string[] = [];
  const original = console.error;
  console.error = (...parts: unknown[]) => void errors.push(parts.map((p) => String(p)).join(" "));
  try {
    const code = await runCapture(args, deps);
    return { code, errors };
  } finally {
    console.error = original;
  }
}

test("runCapture: ground-tiling slice dispatches to the tiles capture (not framing)", async () => {
  const root = await scaffold();
  const { deps, calls } = recordingDeps();
  const code = await runCapture(baseArgs(root, "ground-tiling"), deps);
  assert.equal(code, 0);
  assert.deepEqual(calls, ["tiles"]);
  await fs.rm(root, { recursive: true, force: true });
});

test("runCapture: tile capture requires both expected gate files to be provenanced", async () => {
  const root = await scaffold();
  const deps: CaptureDeps = {
    captureFraming: async () => {
      throw new Error("should not be called");
    },
    captureFeel: async () => {
      throw new Error("should not be called");
    },
    capturePlayability: async () => {
      throw new Error("should not be called");
    },
    captureTiles: async (a) => {
      await writeJson(path.join(a.outDir, "platform-tiles.json"), { platforms: [] });
      return {
        outDir: a.outDir,
        wrote: ["platform-tiles.json"],
        provenancedFiles: ["platform-tiles.json"],
        consolePath: path.join(a.outDir, "console.json"),
        logCount: 0,
        playMode: false,
      };
    },
    captureVisualArtifacts: async () => { throw new Error("visual-artifacts not exercised by this fixture"); },
    captureConsole: async () => {
      throw new Error("should not be called");
    },
  };
  const code = await runCapture(baseArgs(root, "ground-tiling"), deps);
  assert.equal(code, 1);
  await fs.rm(root, { recursive: true, force: true });
});

test("runCapture: parallax slice dispatches visual-artifacts + console (no framing/tiles)", async () => {
  // This slice carries the `visual-artifacts` gate. Before the recipe existed, that entry was
  // agent-assembly and only `console` ran; now the file has a producer, so it is captured.
  const root = await scaffold();
  const { deps, calls } = recordingDeps();
  const code = await runCapture(baseArgs(root, "parallax"), deps);
  assert.equal(code, 0);
  // console.json comes from the visual-artifacts session itself, so the console-only recipe
  // is not also needed (RECIPE_INCIDENTAL_OUTPUTS).
  assert.deepEqual(calls, ["visual-artifacts"]);
  await fs.rm(root, { recursive: true, force: true });
});

test("runCapture: framing slice dispatches to the framing capture (not tiles)", async () => {
  const root = await scaffold();
  const { deps, calls } = recordingDeps();
  const code = await runCapture(baseArgs(root, "framing"), deps);
  assert.equal(code, 0);
  assert.deepEqual(calls, ["framing"]);
  await fs.rm(root, { recursive: true, force: true });
});

function projectRecordingDeps(): { deps: CaptureDeps; seen: Record<string, unknown> } {
  const seen: Record<string, unknown> = {};
  const base = recordingDeps();
  const deps: CaptureDeps = {
    captureFraming: async (a) => {
      seen.framing = a.project;
      return base.deps.captureFraming(a);
    },
    captureTiles: async (a) => {
      seen.tiles = a.project;
      return base.deps.captureTiles(a);
    },
    captureVisualArtifacts: async (a) => {
      seen.visualArtifacts = a.project;
      return base.deps.captureVisualArtifacts(a);
    },
    captureConsole: async (a) => {
      seen.console = a.project;
      return base.deps.captureConsole(a);
    },
    captureFeel: async (a) => {
      seen.feel = a.project;
      return base.deps.captureFeel(a);
    },
    capturePlayability: async (a) => {
      seen.playability = a.project;
      return base.deps.capturePlayability(a);
    },
  };
  return { deps, seen };
}

test("runCapture: --project is threaded into the dispatched capture helper", async () => {
  const root = await scaffold();
  for (const [slice, key] of [["framing", "framing"], ["ground-tiling", "tiles"], ["parallax", "visualArtifacts"]] as const) {
    const { deps, seen } = projectRecordingDeps();
    const code = await runCapture({ ...baseArgs(root, slice), project: "/Users/dev/GameB" }, deps);
    assert.equal(code, 0);
    assert.equal(seen[key], "/Users/dev/GameB", `expected ${key} helper to receive project`);
  }
  await fs.rm(root, { recursive: true, force: true });
});

test("runCapture: unknown slice is refused (exit 2), no capture invoked", async () => {
  const root = await scaffold();
  const { deps, calls } = recordingDeps();
  const code = await runCapture(baseArgs(root, "nope"), deps);
  assert.equal(code, 2);
  assert.deepEqual(calls, []);
  await fs.rm(root, { recursive: true, force: true });
});

test("runCapture: a slice whose manifest no recipe can produce is refused (exit 2)", async () => {
  const root = await scaffold();
  const { deps, calls } = recordingDeps();
  const code = await runCapture(baseArgs(root, "manifest-only"), deps);
  assert.equal(code, 2);
  assert.deepEqual(calls, []);
  await fs.rm(root, { recursive: true, force: true });
});

test("runCapture: missing SLICES.json is refused (exit 2)", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "loombridge-capture-noplan-"));
  await fs.mkdir(path.join(root, ".loombridge"), { recursive: true });
  await writeState(loombridgePaths(root), {
    genre: "platformer-2d",
    engine: "unity",
    phase: "built-unverified",
    currentBuild: { runId: "run-test-0001", startedAt: "2026-07-01T00:00:00.000Z" },
    updatedAt: "2026-07-01T00:00:00.000Z",
  });
  const { deps, calls } = recordingDeps();
  const code = await runCapture(baseArgs(root, "ground-tiling"), deps);
  assert.equal(code, 2);
  assert.deepEqual(calls, []);
  await fs.rm(root, { recursive: true, force: true });
});

test("runCapture: a missing-GroundTiling bridge error surfaces as exit 1 (not a hand-authored file)", async () => {
  const root = await scaffold();
  const deps: CaptureDeps = {
    captureFraming: async () => {
      throw new Error("should not be called");
    },
    captureFeel: async () => {
      throw new Error("should not be called");
    },
    capturePlayability: async () => {
      throw new Error("should not be called");
    },
    captureTiles: async () => {
      throw new Error(
        "capture.invoke_static failed: Capture component type 'GroundTiling' not found in any loaded assembly.",
      );
    },
    captureVisualArtifacts: async () => { throw new Error("visual-artifacts not exercised by this fixture"); },
    captureConsole: async () => {
      throw new Error("should not be called");
    },
  };
  const code = await runCapture(baseArgs(root, "ground-tiling"), deps);
  assert.equal(code, 1); // surfaced, not swallowed, and nothing was hand-authored
  await fs.rm(root, { recursive: true, force: true });
});

// ── H11: the run binding is a DOOR, not an optional stamp ────────────────────

test("runCapture: no currentBuild.runId REFUSES at the door (exit 2), naming `loombridge build`", async () => {
  const root = await scaffold({ runId: null });
  const { deps, calls } = recordingDeps();
  const { code, errors } = await runCapturing(baseArgs(root, "ground-tiling"), deps);
  assert.equal(code, 2);
  assert.deepEqual(calls, [], "nothing may be captured before the run binding exists");
  assert.ok(errors.some((line) => /REFUSED/.test(line) && /loombridge build/.test(line)), errors.join("\n"));
  await fs.rm(root, { recursive: true, force: true });
});

test("runCapture: every producer receives the minted runId unconditionally", async () => {
  const root = await scaffold();
  const { deps, runIds } = recordingDeps();
  assert.equal(await runCapture(baseArgs(root, "framing"), deps), 0);
  assert.equal(await runCapture(baseArgs(root, "ground-tiling"), deps), 0);
  assert.equal(await runCapture(baseArgs(root, "parallax"), deps), 0);
  assert.deepEqual(runIds, ["run-test-0001", "run-test-0001", "run-test-0001"]);
  await fs.rm(root, { recursive: true, force: true });
});

test("capture writers declare runId REQUIRED and stamp it with no conditional spread (H11)", async () => {
  // The behavioural test above can only prove the runId that IS passed arrives.
  // The property that matters is that the field cannot be OMITTED: an optional
  // `runId?` plus a `...(args.runId ? { runId } : {})` spread is how an
  // unbindable capture got written and looked normal. Both shapes are pinned
  // here at the source level, where the type is the enforcement.
  //
  // LITMUS: change any of the three back to `runId?: string` and this fails.
  const writers = [
    "mcp-server/src/capabilities/verification/capture-console.ts",
    "mcp-server/src/capabilities/verification/capture-framing.ts",
    "mcp-server/src/capabilities/verification/capture-tiles.ts",
  ];
  for (const rel of writers) {
    const source = await fs.readFile(path.join(REPO_ROOT, rel), "utf-8");
    assert.match(source, /^\s*runId: string;$/m, `${rel} must declare runId as REQUIRED`);
    assert.equal(/runId\?: string/.test(source), false, `${rel} must not make runId optional again`);
    assert.equal(
      /\.\.\.\(\s*args\.runId\s*\?/.test(source),
      false,
      `${rel} must stamp runId unconditionally, not through a conditional spread`,
    );
  }
});

// ── E3/M16: the manifest diff is loud, and the exit is in-band ───────────────

test("runCapture: the last line carries exit=N in band", async () => {
  const root = await scaffold();
  const { deps } = recordingDeps();
  const { code, errors } = await runCapturing(baseArgs(root, "framing"), deps);
  assert.equal(code, 0);
  assert.equal(errors[errors.length - 1], "[loombridge capture] exit=0");
  await fs.rm(root, { recursive: true, force: true });
});

test("runCapture: a complete capture reports every manifest entry produced (positive control)", async () => {
  const root = await scaffold();
  const { deps } = recordingDeps();
  const code = await runCapture(baseArgs(root, "ground-tiling"), deps);
  assert.equal(code, 0);
  const report = await readReport(root, "ground-tiling");
  assert.deepEqual(report.manifest, [
    "ground-tiling/placement.json",
    "ground-tiling/platform-tiles.json",
    "ground-tiling/tile-render.json",
    "ground-tiling/console.json",
  ]);
  assert.deepEqual(report.producerFailed, []);
  // `placement.json` has no CLI producer: named, not silently dropped, exit stays 0.
  assert.deepEqual(report.agentAssemblyRequired, ["ground-tiling/placement.json"]);
  assert.deepEqual(report.produced, [
    "ground-tiling/platform-tiles.json",
    "ground-tiling/tile-render.json",
    "ground-tiling/console.json",
  ]);
  assert.equal(report.exit, 0);
  assert.equal(report.runId, "run-test-0001");
  await fs.rm(root, { recursive: true, force: true });
});

test("runCapture: a producer that reports success but lands NOTHING is exit 1, and the report names the entries", async () => {
  // LITMUS: the same slice and the same deps as the positive control above, with
  // only the file writes removed. The recipe "succeeds"; the disk disagrees.
  const root = await scaffold();
  const { deps } = recordingDeps({ writeFiles: false });
  const { code, errors } = await runCapturing(baseArgs(root, "ground-tiling"), deps);
  assert.equal(code, 1);
  const report = await readReport(root, "ground-tiling");
  assert.deepEqual(report.producerFailed, [
    "ground-tiling/platform-tiles.json",
    "ground-tiling/tile-render.json",
    "ground-tiling/console.json",
  ]);
  assert.deepEqual(report.produced, []);
  assert.equal(report.exit, 1);
  assert.ok(errors.some((line) => /PRODUCER FAILED/.test(line)), errors.join("\n"));
  assert.equal(errors[errors.length - 1], "[loombridge capture] exit=1");
  await fs.rm(root, { recursive: true, force: true });
});

test("runCapture: the L34 player-feel shape is now PRODUCED (stage 2: the feel recipe writes feel.json)", async () => {
  // The ledger case: `capture --slice player-feel` wrote console.json, exited 0, and
  // said nothing about feel.json, which the agent then hand-authored (L45). The feel
  // recipe now produces it, so the slice's whole manifest comes from the CLI and the
  // agent-assembly list is empty.
  const root = await scaffold();
  const { deps, calls } = recordingDeps();
  const { code } = await runCapturing(baseArgs(root, "player-feel"), deps);
  assert.equal(code, 0);
  assert.deepEqual(calls, ["feel"]);
  const report = await readReport(root, "player-feel");
  assert.deepEqual(report.agentAssemblyRequired, []);
  assert.deepEqual(report.produced, ["player-feel/feel.json", "player-feel/console.json"]);
  assert.deepEqual(report.producerFailed, []);
  await fs.rm(root, { recursive: true, force: true });
});

test("runCapture E6: a feel capture that leaves BANDED metrics unmeasured exits 1, and still writes the evidence", async () => {
  // Run 2's live shape: the game was frozen in its modal end state, five of seven
  // banded metrics came back unmeasured, feel.json was written, and `capture` exited
  // 0, so the operator's first signal that anything was wrong was a verify FAIL two
  // steps later. A capture that cannot feed its own gate is not a successful capture.
  const root = await scaffold();
  const { deps } = recordingDeps();
  const unmeasured = ["runSpeed", "shortHopApex", "dashDistance", "coyoteTime", "jumpBuffer"];
  const partial: CaptureDeps = {
    ...deps,
    captureFeel: async (a) => ({ ...(await deps.captureFeel(a)), measured: ["jumpApex", "timeToApex"], unmeasuredAcceptedTargets: unmeasured }),
  };
  const { code, errors } = await runCapturing(baseArgs(root, "player-feel"), partial);
  assert.equal(code, 1);
  assert.ok(
    errors.some((line) => /the contract bands 5 metric\(s\) this capture did not measure/.test(line)),
    errors.join("\n"),
  );
  assert.equal(errors[errors.length - 1], "[loombridge capture] exit=1");

  // The evidence is still on disk and still in the report: the file is WHY the run
  // failed, so losing it would be the wrong kind of strict.
  const report = await readReport(root, "player-feel");
  assert.deepEqual(report.produced, ["player-feel/feel.json", "player-feel/console.json"]);
  assert.deepEqual(report.producerFailed, [], "the file landed; it is the recipe outcome that failed");
  assert.equal((report.recipes as { recipe: string; ok: boolean }[]).find((r) => r.recipe === "feel")!.ok, false);
  await fs.rm(root, { recursive: true, force: true });
});

test("runCapture E6 LITMUS: the SAME capture with nothing unmeasured exits 0 (the positive control)", async () => {
  const root = await scaffold();
  const { deps } = recordingDeps();
  const { code, errors } = await runCapturing(baseArgs(root, "player-feel"), deps);
  assert.equal(code, 0);
  assert.equal(errors.some((line) => /did not measure/.test(line)), false);
  const report = await readReport(root, "player-feel");
  assert.equal((report.recipes as { recipe: string; ok: boolean }[]).find((r) => r.recipe === "feel")!.ok, true);
  await fs.rm(root, { recursive: true, force: true });
});

test("runCapture: agent-assembly-required entries are still named when a recipe covers only part of the manifest", async () => {
  // `feel-only` owes verify-manifest.json AND feel.json. The feel recipe produces one
  // of them; the other is named on stderr and in the report, and the exit stays 0
  // because nothing was asked to write it.
  const root = await scaffold();
  const { deps, calls } = recordingDeps();
  const { code, errors } = await runCapturing(baseArgs(root, "feel-only"), deps);
  assert.equal(code, 0);
  assert.deepEqual(calls, ["feel"]);
  const report = await readReport(root, "feel-only");
  assert.deepEqual(report.agentAssemblyRequired, ["feel-only/verify-manifest.json"]);
  assert.ok((report.produced as string[]).includes("feel-only/feel.json"));
  assert.ok(
    errors.some((line) => /agent-assembly required/.test(line) && /feel-only\/verify-manifest\.json/.test(line)),
    errors.join("\n"),
  );
  await fs.rm(root, { recursive: true, force: true });
});

test("runCapture: a minted manifest entry outside the slice's own verify dir is UNSAFE (exit 2)", async () => {
  // A path-safe entry that escapes the slice scope is its own refusal class, so
  // it can never be laundered through the "missing" list.
  const root = await scaffold();
  const plan = JSON.parse(JSON.stringify(SLICES)) as typeof SLICES;
  const slice = plan.slices.find((s) => s.id === "parallax") as Record<string, unknown>;
  slice.proof = { runId: "run-test-0001", captureManifest: ["other-slice/console.json"] };
  await fs.writeFile(path.join(root, ".loombridge", "SLICES.json"), JSON.stringify(plan, null, 2), "utf-8");

  const { deps } = recordingDeps();
  const { code, errors } = await runCapturing(baseArgs(root, "parallax"), deps);
  assert.equal(code, 2);
  const report = await readReport(root, "parallax");
  assert.deepEqual(report.unsafe, ["other-slice/console.json"]);
  assert.deepEqual(report.producerFailed, []);
  assert.ok(errors.some((line) => /unsafe captureManifest/.test(line)), errors.join("\n"));
  await fs.rm(root, { recursive: true, force: true });
});

test("runCapture: the minted proof manifest wins over re-derivation, and the report says which", async () => {
  const root = await scaffold();
  const plan = JSON.parse(JSON.stringify(SLICES)) as typeof SLICES;
  const slice = plan.slices.find((s) => s.id === "parallax") as Record<string, unknown>;
  slice.proof = { runId: "run-test-0001", captureManifest: ["parallax/console.json"] };
  await fs.writeFile(path.join(root, ".loombridge", "SLICES.json"), JSON.stringify(plan, null, 2), "utf-8");

  const { deps } = recordingDeps();
  assert.equal(await runCapture(baseArgs(root, "parallax"), deps), 0);
  const report = await readReport(root, "parallax");
  assert.equal(report.manifestSource, "slice.proof.captureManifest");
  assert.deepEqual(report.manifest, ["parallax/console.json"]);
  await fs.rm(root, { recursive: true, force: true });
});

// ── E13: refuse-on-absent for the run binding of a PRESENT file ──────────────
//
// The falsy-skip: the wrong-run branch read `typeof fileRun === "string" && … !== runId`,
// so a leftover carrying NO `_provenance` at all fell through every arm and was counted
// as produced with exit 0. Absence must fail the check, never skip it.

test("runCapture E13: a present manifest entry with NO _provenance is stale-equivalent (agent-assembly re-entry)", async () => {
  const root = await scaffold();
  const outDir = path.join(root, ".loombridge", "verify", "ground-tiling");
  // placement.json is the slice's agent-assembled entry. Written by nobody this run,
  // and carrying no provenance at all: exactly the leftover E13 describes.
  await writeJson(path.join(outDir, "placement.json"), { platforms: [] });

  const { deps } = recordingDeps();
  const { code, errors } = await runCapturing(baseArgs(root, "ground-tiling"), deps);
  assert.equal(code, 0, "an agent-assembly entry is not a producer failure");

  const report = await readReport(root, "ground-tiling");
  assert.deepEqual(
    report.agentAssemblyRequired,
    ["ground-tiling/placement.json"],
    "an unprovenanced leftover must re-enter the agent-assembly list exactly like a wrong-run file",
  );
  assert.equal(
    (report.produced as string[]).includes("ground-tiling/placement.json"),
    false,
    "an unbindable file may never be reported as produced",
  );
  assert.ok(
    errors.some((line) => /UNPROVENANCED/.test(line) && /placement\.json/.test(line)),
    errors.join("\n"),
  );
  await fs.rm(root, { recursive: true, force: true });
});

test("runCapture E13 LITMUS: the SAME entry stamped with the MINTED runId is accepted (positive control)", async () => {
  const root = await scaffold();
  const outDir = path.join(root, ".loombridge", "verify", "ground-tiling");
  await writeJson(path.join(outDir, "placement.json"), {
    platforms: [],
    _provenance: { writer: "agent", runId: "run-test-0001" },
  });

  const { deps } = recordingDeps();
  const { code, errors } = await runCapturing(baseArgs(root, "ground-tiling"), deps);
  assert.equal(code, 0);
  const report = await readReport(root, "ground-tiling");
  assert.deepEqual(report.agentAssemblyRequired, [], "a run-bound agent file is assembled, not required");
  assert.equal(errors.some((line) => /UNPROVENANCED/.test(line)), false, errors.join("\n"));
  await fs.rm(root, { recursive: true, force: true });
});

test("runCapture E13: an unprovenanced entry with a PRODUCER is a producer failure (exit 1)", async () => {
  // Same shape on the other side of the producer/agent split: a producer-owned entry
  // that exists but cannot name its run counts as not landed, which is exit 1.
  const root = await scaffold();
  const outDir = path.join(root, ".loombridge", "verify", "parallax");
  await writeJson(path.join(outDir, "console.json"), { logs: [] });

  const deps: CaptureDeps = {
    ...recordingDeps().deps,
    // The recipe "succeeds" and writes nothing: the leftover above is all that is on disk.
    // The recipe "succeeds" and writes nothing: the leftover on disk is all there is.
    captureVisualArtifacts: async (a) => ({
      visualArtifactsPath: path.join(a.outDir, "visual-artifacts.json"),
      framesDir: path.join(a.outDir, "frames"),
      scenarioPath: "/fixture/scenario.json",
    }),
  };
  const { code, errors } = await runCapturing(baseArgs(root, "parallax"), deps);
  assert.equal(code, 1);
  const report = await readReport(root, "parallax");
  assert.deepEqual((report.producerFailed as string[]).slice().sort(), ["parallax/console.json", "parallax/visual-artifacts.json"]);
  assert.deepEqual(report.produced, []);
  assert.ok(errors.some((line) => /UNPROVENANCED/.test(line)), errors.join("\n"));
  await fs.rm(root, { recursive: true, force: true });
});

// ── E14: `produced` means "a recipe of THIS run wrote it" ────────────────────

test("runCapture E14: a file this run's recipes did not write is presentFromOtherSources, never produced", async () => {
  // The live shape: a drive-connection-written file sitting in the slice dir was
  // credited to the CLI because the report copied `completeness.present` wholesale.
  // It carries THIS run's runId (so it is not stale) and still was not produced here.
  const root = await scaffold();
  const outDir = path.join(root, ".loombridge", "verify", "ground-tiling");
  await writeJson(path.join(outDir, "placement.json"), {
    platforms: [],
    _provenance: { writer: "agent (other connection)", runId: "run-test-0001" },
  });

  const { deps } = recordingDeps();
  const { code, errors } = await runCapturing(baseArgs(root, "ground-tiling"), deps);
  assert.equal(code, 0);
  const report = await readReport(root, "ground-tiling");
  assert.deepEqual(report.produced, [
    "ground-tiling/platform-tiles.json",
    "ground-tiling/tile-render.json",
    "ground-tiling/console.json",
  ]);
  assert.deepEqual(report.presentFromOtherSources, ["ground-tiling/placement.json"]);
  assert.ok(
    errors.some((line) => /present but NOT written by this run's recipes/.test(line)),
    errors.join("\n"),
  );
  await fs.rm(root, { recursive: true, force: true });
});

test("runCapture E14 LITMUS: a recipe whose file was written by an EARLIER run is not credited to this one", async () => {
  // The producer runs but lands nothing; the file on disk is a previous run's. The
  // pre-E14 report called it `produced`. It is neither produced NOR bindable.
  const root = await scaffold();
  const outDir = path.join(root, ".loombridge", "verify", "parallax");
  await writeJson(path.join(outDir, "console.json"), {
    logs: [],
    _provenance: { writer: "loombridge capture (console)", runId: "run-YESTERDAY" },
  });

  const deps: CaptureDeps = {
    ...recordingDeps().deps,
    // The recipe "succeeds" and writes nothing: the leftover on disk is all there is.
    captureVisualArtifacts: async (a) => ({
      visualArtifactsPath: path.join(a.outDir, "visual-artifacts.json"),
      framesDir: path.join(a.outDir, "frames"),
      scenarioPath: "/fixture/scenario.json",
    }),
  };
  const { code, errors } = await runCapturing(baseArgs(root, "parallax"), deps);
  assert.equal(code, 1);
  const report = await readReport(root, "parallax");
  assert.deepEqual(report.produced, []);
  assert.deepEqual(report.presentFromOtherSources, ["parallax/console.json"]);
  // visual-artifacts.json is producer-owned and never landed, so it fails alongside the stale one.
  assert.deepEqual((report.producerFailed as string[]).slice().sort(), ["parallax/console.json", "parallax/visual-artifacts.json"]);
  assert.ok(errors.some((line) => /STALE/.test(line)), errors.join("\n"));
  await fs.rm(root, { recursive: true, force: true });
});

// --- visual-artifacts recipe -------------------------------------------------------------------
//
// `visual-artifacts.json` was the last manifest entry NO recipe produced, so capture reported it
// as agent-assembly and exited 0. A real 3d-shooter session answered that invitation by writing a
// scratchpad driver, scraping base64 screenshots out of a JSONL stream, and labelling frames with
// `zip(["aim","scoped","unscoped"], shots)`. Positional labelling silently mislabels the evidence
// whenever a capture drops or arrives out of order.

test("visual-artifacts.json now selects a recipe instead of agent-assembly", () => {
  const dispatch = captureRecipesForFiles(["visual-artifacts.json"]);
  const entry = dispatch.files.find((file) => file.file === "visual-artifacts.json");
  assert.ok(entry, "visual-artifacts.json must appear in the producer map");
  assert.equal(entry.recipe, "visual-artifacts", "it must have a producer, not null (null = agent-assembly)");
  assert.deepEqual(dispatch.unproduced, [], "it must no longer be an agent-assembly entry");
  assert.ok(dispatch.recipes.includes("visual-artifacts"), "the recipe must be selected to run");
});

test("the recipe writes console.json too, so a slice needing both runs one recipe", () => {
  assert.deepEqual(recipeOutputs("visual-artifacts").sort(), ["console.json", "visual-artifacts.json"]);
});

test("LITMUS: an unresolvable scenario REFUSES and names what to author", () => {
  // The refusal IS the feature for every genre with no bundled pack, which is every genre except
  // 2D platformer. Degrading to "agent-assembly required" here is exactly what produced the
  // hand-rolled pipeline, so it must throw rather than return.
  assert.throws(
    () => resolveVisualArtifactsScenario({ acceptance: { game: "SniperShooter", genre: "3d-shooter" } }),
    (error: Error) => {
      assert.match(error.message, /--scenario/, "must name the flag that fixes it");
      assert.match(error.message, /baselineFrameId/, "must show the shape to author");
      assert.match(error.message, /captures/, "must show that frame ids are declared, not positional");
      return true;
    },
  );
});

test("an explicit --scenario wins over bundled pack selection", () => {
  // A project-local scenario is the supported path for a genre with no pack, so it must not be
  // second-guessed by game-kind matching.
  assert.equal(
    resolveVisualArtifactsScenario({
      acceptance: { game: "SniperShooter", genre: "3d-shooter" },
      scenarioPath: "/tmp/project-scenario.json",
    }),
    "/tmp/project-scenario.json",
  );
});

test("LITMUS: a contract WITH a bundled pack still resolves without --scenario", () => {
  // Guards the refusal from the other side: if pack selection were broken, the test above would
  // pass while every genre refused.
  const resolved = resolveVisualArtifactsScenario({
    // The bundled pack matches on the CONTRACT SHAPE (a `platformer` section), not on genre id.
    acceptance: { game: "demo-platformer", genre: "platformer-2d", platformer: { tiles: {} } },
  });
  assert.match(resolved, /platformer-2d-basic\.json$/);
});
