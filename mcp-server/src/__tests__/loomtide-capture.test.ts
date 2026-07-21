import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  captureKindForSlice,
  runCapture,
  type CaptureArgs,
  type CaptureDeps,
} from "../loomtide/capture.js";
import {
  clearExpectedTileOutputs,
  stampExpectedTileCaptures,
  stampProvenance,
} from "../verification/capture-tiles.js";

// ── captureKindForSlice (pure dispatch from gates) ───────────────────────────

test("captureKindForSlice: a framing gate ⇒ framing", () => {
  assert.equal(captureKindForSlice(["framing", "console-clean"]), "framing");
});

test("captureKindForSlice: a platform-tiles/tile-render gate ⇒ tiles", () => {
  assert.equal(captureKindForSlice(["platform-tiles", "tile-render", "placement", "console-clean"]), "tiles");
  assert.equal(captureKindForSlice(["tile-render"]), "tiles");
});

test("captureKindForSlice: tiles wins even if framing is also present", () => {
  assert.equal(captureKindForSlice(["framing", "platform-tiles"]), "tiles");
});

test("captureKindForSlice: a console-clean gate (no framing/tiles) ⇒ console", () => {
  assert.equal(captureKindForSlice(["coverage", "parallax-motion", "render-frame", "visual-artifacts", "console-clean"]), "console");
  assert.equal(captureKindForSlice(["console-clean"]), "console");
});

test("captureKindForSlice: framing/tiles win over console-clean", () => {
  assert.equal(captureKindForSlice(["framing", "console-clean"]), "framing");
  assert.equal(captureKindForSlice(["platform-tiles", "console-clean"]), "tiles");
});

test("captureKindForSlice: no recognized gate ⇒ null (caller refuses)", () => {
  assert.equal(captureKindForSlice(["manifest", "feel"]), null);
});

// ── stampProvenance (we never fabricate capture content) ─────────────────────

test("stampProvenance: preserves the raw gate content, only adds _provenance", () => {
  const raw = { platforms: [{ name: "Ground", widthTiles: 16, rows: [{ index: 0, role: "top_cap" }] }] };
  const out = stampProvenance(raw, { writer: "loomtide capture (ground-tiling)", method: "WriteTileCaptures" });
  assert.deepEqual(out.platforms, raw.platforms); // content untouched
  assert.equal((out._provenance as Record<string, unknown>).method, "WriteTileCaptures");
});

test("clearExpectedTileOutputs: removes stale expected tile captures before invoke", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "loomtide-capture-stale-"));
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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "loomtide-capture-stamp-"));
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

async function scaffold(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "loomtide-capture-"));
  await fs.mkdir(path.join(root, ".loomtide"), { recursive: true });
  await fs.writeFile(path.join(root, ".loomtide", "SLICES.json"), JSON.stringify(SLICES, null, 2), "utf-8");
  return root;
}

function recordingDeps(): { deps: CaptureDeps; calls: string[]; throwTiles?: () => void } {
  const calls: string[] = [];
  const deps: CaptureDeps = {
    captureFraming: async () => {
      calls.push("framing");
      return { screenRectsPath: "sr.json", consolePath: "c.json", pixelPerfectCaptured: true, objectCount: 1, logCount: 3 };
    },
    captureTiles: async () => {
      calls.push("tiles");
      return { outDir: "out", wrote: ["platform-tiles.json", "tile-render.json"], provenancedFiles: ["platform-tiles.json", "tile-render.json"], consolePath: "c.json", logCount: 3, playMode: false };
    },
    captureConsole: async () => {
      calls.push("console");
      return { consolePath: "c.json", logCount: 0, startupCount: 0, steadyCount: 0 };
    },
  };
  return { deps, calls };
}

function baseArgs(root: string, slice: string): CaptureArgs {
  return { root, slice, locators: ["/Player"] };
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
    captureTiles: async () => {
      return {
        outDir: "out",
        wrote: ["platform-tiles.json"],
        provenancedFiles: ["platform-tiles.json"],
        consolePath: "c.json",
        logCount: 0,
        playMode: false,
      };
    },
    captureConsole: async () => {
      throw new Error("should not be called");
    },
  };
  const code = await runCapture(baseArgs(root, "ground-tiling"), deps);
  assert.equal(code, 1);
  await fs.rm(root, { recursive: true, force: true });
});

test("runCapture: parallax slice (console-clean, no framing/tiles) dispatches to the console capture", async () => {
  const root = await scaffold();
  const { deps, calls } = recordingDeps();
  const code = await runCapture(baseArgs(root, "parallax"), deps);
  assert.equal(code, 0);
  assert.deepEqual(calls, ["console"]);
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
  const deps: CaptureDeps = {
    captureFraming: async (a) => {
      seen.framing = a.project;
      return { screenRectsPath: "sr.json", consolePath: "c.json", pixelPerfectCaptured: true, objectCount: 1, logCount: 3 };
    },
    captureTiles: async (a) => {
      seen.tiles = a.project;
      return { outDir: "out", wrote: ["platform-tiles.json", "tile-render.json"], provenancedFiles: ["platform-tiles.json", "tile-render.json"], consolePath: "c.json", logCount: 3, playMode: false };
    },
    captureConsole: async (a) => {
      seen.console = a.project;
      return { consolePath: "c.json", logCount: 0, startupCount: 0, steadyCount: 0 };
    },
  };
  return { deps, seen };
}

test("runCapture: --project is threaded into the dispatched capture helper", async () => {
  const root = await scaffold();
  for (const [slice, key] of [["framing", "framing"], ["ground-tiling", "tiles"], ["parallax", "console"]] as const) {
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

test("runCapture: a slice with no capture-recipe gate is refused (exit 2)", async () => {
  const root = await scaffold();
  const { deps, calls } = recordingDeps();
  const code = await runCapture(baseArgs(root, "feel-only"), deps);
  assert.equal(code, 2);
  assert.deepEqual(calls, []);
  await fs.rm(root, { recursive: true, force: true });
});

test("runCapture: missing SLICES.json is refused (exit 2)", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "loomtide-capture-noplan-"));
  await fs.mkdir(path.join(root, ".loomtide"), { recursive: true });
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
    captureTiles: async () => {
      throw new Error(
        "capture.invoke_static failed: Capture component type 'GroundTiling' not found in any loaded assembly.",
      );
    },
    captureConsole: async () => {
      throw new Error("should not be called");
    },
  };
  const code = await runCapture(baseArgs(root, "ground-tiling"), deps);
  assert.equal(code, 1); // surfaced, not swallowed — and nothing was hand-authored
  await fs.rm(root, { recursive: true, force: true });
});
