/**
 * `loomtide capture` — write a slice's verification evidence straight from raw
 * Unity bridge ops, with a `_provenance` block, instead of the agent
 * hand-authoring capture files. It DISPATCHES BY SLICE (from the slice's
 * `acceptance.gates`), so the developer needs no per-slice flag:
 *
 *   - framing-style slice (gate `framing`)              → screen-rects.json + console.json
 *   - tiling slice (gate `platform-tiles`/`tile-render`) → platform-tiles.json +
 *       tile-render.json (via the allowlisted `GroundTiling.WriteTileCaptures`) + console.json
 *   - console-only slice (gate `console-clean`, no framing/tiles, e.g. `parallax`)
 *       → console.json (play-enter startup + steady soak logs, phase-tagged;
 *         nothing cleared after play, so real startup errors are still graded)
 *
 * Captures land under the slice's verify dir (`.loomtide/verify/<slice>/`) — the
 * same place `loomtide verify --slice` reads from. All judgment stays in the
 * agent layer; this CLI only composes ops and writes files (plan §3b).
 */

import path from "node:path";

import { captureConsoleEvidence } from "../verification/capture-console.js";
import { captureFramingEvidence } from "../verification/capture-framing.js";
import { captureTileEvidence, TILE_CAPTURE_FILES } from "../verification/capture-tiles.js";
import { loomtidePaths, readState } from "./state.js";
import { getSliceVerifyDir, readSlicePlan, type SliceEntry } from "./slices.js";
import { captureKindForSlice, type CaptureKind } from "./capture-recipes.js";
export { captureKindForSlice, type CaptureKind } from "./capture-recipes.js";

export interface CaptureArgs {
  root: string;
  /** Slice id — determines the output dir AND the capture recipe (from its gates). */
  slice?: string;
  /** Explicit output dir override. */
  outDir?: string;
  /** Objects to project (framing capture), default ["/Player"]. */
  locators: string[];
  /** Camera GameObject path (framing capture), default "/Main Camera". */
  cameraPath?: string;
  /** boundsMode for screen rects (framing capture). */
  boundsMode?: string;
  /** Capture kind override (when --out is used without --slice). */
  kind?: CaptureKind;
  /** Routing target for multi-editor setups (projectPathCanonical or unique projectName). */
  project?: string;
}

/** Injectable capture impls so dispatch + refusal are unit-testable without a live editor. */
export interface CaptureDeps {
  captureFraming: typeof captureFramingEvidence;
  captureTiles: typeof captureTileEvidence;
  captureConsole: typeof captureConsoleEvidence;
}

const defaultDeps: CaptureDeps = {
  captureFraming: captureFramingEvidence,
  captureTiles: captureTileEvidence,
  captureConsole: captureConsoleEvidence,
};

type ParseHelp = { help: true; usageError?: boolean };

function parseArgs(args: string[]): CaptureArgs | ParseHelp {
  let root = process.cwd();
  let slice: string | undefined;
  let outDir: string | undefined;
  let locators: string[] = [];
  let cameraPath: string | undefined;
  let boundsMode: string | undefined;
  let project: string | undefined;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--root") root = path.resolve(args[(i += 1)] ?? root);
    else if (arg === "--slice") slice = args[(i += 1)] ?? "";
    else if (arg === "--out") outDir = path.resolve(args[(i += 1)] ?? "");
    else if (arg === "--locators") {
      locators = (args[(i += 1)] ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (arg === "--camera") cameraPath = args[(i += 1)] ?? "";
    else if (arg === "--bounds-mode") boundsMode = args[(i += 1)] ?? "";
    else if (arg === "--project") project = args[(i += 1)] ?? "";
    else if (arg === "--help" || arg === "-h") return { help: true };
    else {
      console.error(`[loomtide capture] unknown argument "${arg}".`);
      return { help: true, usageError: true };
    }
  }

  if (!slice && !outDir) {
    console.error("[loomtide capture] pass --slice <id> (or --out <dir>) to choose where the captures land.");
    return { help: true, usageError: true };
  }

  return {
    root,
    slice,
    outDir,
    locators: locators.length > 0 ? locators : ["/Player"],
    cameraPath,
    boundsMode,
    ...(project ? { project } : {}),
  };
}

export async function runCapture(args: CaptureArgs, deps: CaptureDeps = defaultDeps): Promise<number> {
  const paths = loomtidePaths(args.root);

  // Resolve the output dir AND the capture kind. With --slice, both come from
  // SLICES.json (kind from the slice's acceptance.gates); --out always wins for the dir.
  let outDir = args.outDir;
  let kind: CaptureKind | undefined = args.kind;
  if (args.slice) {
    const plan = await readSlicePlan(paths);
    if (!plan) {
      console.error("[loomtide capture] no .loomtide/SLICES.json — run `loomtide plan` to scaffold the roadmap first.");
      return 2;
    }
    const slice: SliceEntry | undefined = plan.slices.find((s) => s.id === args.slice);
    if (!slice) {
      const known = plan.slices.map((s) => s.id).join(", ") || "(none)";
      console.error(`[loomtide capture] unknown slice "${args.slice}". Known ids: ${known}.`);
      return 2;
    }
    outDir = args.outDir ?? getSliceVerifyDir(paths, args.slice);
    const resolved = captureKindForSlice(slice.acceptance.gates);
    if (!resolved) {
      console.error(
        `[loomtide capture] no capture recipe for slice "${args.slice}" (gates: ${slice.acceptance.gates.join(", ")}). ` +
          "Supported: a `framing` gate (screen-rects+console), `platform-tiles`/`tile-render` (GroundTiling tile " +
          "captures), or a `console-clean` gate (console.json steady play-soak).",
      );
      return 2;
    }
    kind = resolved;
  }
  if (!outDir) {
    console.error("[loomtide capture] could not resolve an output dir.");
    return 2;
  }
  // --out without --slice defaults to the framing recipe (back-compat escape hatch).
  kind = kind ?? "framing";

  const state = await readState(paths);
  const runId = state?.currentBuild?.runId;
  const rel = (p: string) => path.relative(args.root, p);

  try {
    if (kind === "tiles") {
      const result = await deps.captureTiles({ outDir, ...(args.project ? { project: args.project } : {}), ...(runId ? { runId } : {}) });
      const missing = TILE_CAPTURE_FILES.filter((file) => !result.provenancedFiles.includes(file));
      console.error(
        `[loomtide capture] tiles: invoked GroundTiling.WriteTileCaptures → wrote [${result.provenancedFiles.join(", ") || "(none)"}] ` +
          `+ ${rel(result.consolePath)} (${result.logCount} log(s)) under ${rel(result.outDir)}`,
      );
      if (missing.length > 0) {
        console.error(
          `[loomtide capture] missing required tile capture(s): ${missing.join(", ")}. ` +
            "GroundTiling.WriteTileCaptures must produce both platform-tiles.json and tile-render.json.",
        );
        return 1;
      }
      return 0;
    }

    if (kind === "console") {
      const result = await deps.captureConsole({ outDir, ...(args.project ? { project: args.project } : {}), ...(runId ? { runId } : {}) });
      console.error(
        `[loomtide capture] console: wrote ${rel(result.consolePath)} ` +
          `(${result.logCount} log(s): ${result.startupCount} startup + ${result.steadyCount} steady — ` +
          "play-enter logs preserved, graded by console-clean)",
      );
      return 0;
    }

    const result = await deps.captureFraming({
      locators: args.locators,
      outDir,
      ...(args.cameraPath ? { cameraPath: args.cameraPath } : {}),
      ...(args.boundsMode ? { boundsMode: args.boundsMode } : {}),
      ...(args.project ? { project: args.project } : {}),
      ...(runId ? { runId } : {}),
    });
    console.error(
      `[loomtide capture] framing: wrote ${rel(result.screenRectsPath)} (${result.objectCount} object(s), pixelPerfect=${result.pixelPerfectCaptured}) ` +
        `+ ${rel(result.consolePath)} (${result.logCount} log(s))`,
    );
    if (!result.pixelPerfectCaptured) {
      console.error(
        "[loomtide capture] note: no PixelPerfectCamera found on the camera — the framing gate's pixel-perfect check will WARN (degraded).",
      );
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[loomtide capture] fatal: ${message}`);
    return 1;
  }
}

function printUsage(): void {
  console.log(
    [
      "Usage: loomtide capture --slice <id> [options]",
      "",
      "Write a slice's verification evidence from raw Unity bridge ops, with a",
      "_provenance block — instead of hand-authoring them. The capture recipe is",
      "chosen from the slice's acceptance.gates:",
      "  framing gate              → screen-rects.json + console.json (play mode)",
      "  platform-tiles/tile-render → platform-tiles.json + tile-render.json",
      "                               (GroundTiling.WriteTileCaptures) + console.json",
      "  console-clean gate        → console.json only (steady play-soak; e.g. parallax)",
      "",
      "Options:",
      "  --root <dir>         Project root (default: cwd)",
      "  --slice <id>         Slice id — captures land in .loomtide/verify/<id>/",
      "  --out <dir>          Explicit output dir (overrides --slice's default; framing recipe)",
      "  --locators <a,b,c>   Comma-separated object paths to project (framing; default: /Player)",
      "  --camera <path>      Camera GameObject path (framing; default: /Main Camera)",
      "  --bounds-mode <m>    Screen-rects bounds mode (opaque | renderer | collider)",
      "  --project <p>        Route to a specific Unity editor (projectPathCanonical or",
      "                       unique projectName). Omit to honor LOOMTIDE_UNITY_PROJECT,",
      "                       then single-editor auto-selection.",
      "  -h, --help           Show this help",
      "",
      "Exit: 0 on success, 1 on capture failure, 2 on usage/dispatch error.",
    ].join("\n"),
  );
}

export async function run(args: string[]): Promise<number> {
  const parsed = parseArgs(args);
  if ("help" in parsed) {
    printUsage();
    return parsed.usageError ? 2 : 0;
  }
  return runCapture(parsed);
}
