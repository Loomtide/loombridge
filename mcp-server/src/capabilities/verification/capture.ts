/**
 * `loombridge capture` — write a slice's verification evidence straight from raw
 * Unity bridge ops, with a `_provenance` block, instead of the agent
 * hand-authoring capture files. It DISPATCHES BY SLICE, from the slice's minted
 * `captureManifest` (the same gate→file map `build` mints it from), so the
 * developer needs no per-slice flag and the dispatch cannot drift from what the
 * verifier will demand:
 *
 *   - `screen-rects.json`                     → framing recipe (+ console.json)
 *   - `platform-tiles.json` / `tile-render.json` → tiles recipe, via the
 *       allowlisted `GroundTiling.WriteTileCaptures` (+ console.json)
 *   - `feel.json`                             → feel recipe (drives the canonical
 *       feel measurements over the bridge and writes the file from the op echoes;
 *       needs `acceptance.harness.feelSeam`) (+ console.json)
 *   - `playability.json`                      → playability OBSERVER: opens an
 *       in-game-loop recording window, prints a machine-readable DRIVE NOW line for
 *       the agent to play the level, then derives every headline field from the
 *       recorded buffers plus its own post-win probes (needs
 *       `acceptance.harness.playability`) (+ console.json)
 *   - `console.json` alone                    → console recipe (play-enter startup
 *       + steady soak logs, phase-tagged; nothing cleared after play, so real
 *       startup errors are still graded)
 *
 * A slice needing several of these runs SEVERAL recipes (the old dispatch picked
 * exactly one by positional precedence).
 *
 * IT ALSO SAYS WHAT IT DID NOT WRITE. Every run ends by diffing the files on disk
 * against the minted manifest (ledger L1/L34/L65: five slices got `console.json`
 * and an exit 0 that named none of the four missing entries):
 *   - a manifest entry whose producer RAN and did not land it  → exit 1;
 *   - a manifest entry NO recipe produces                      → exit 0 plus a
 *     named "agent-assembly required" list, printed and written into the
 *     capture report (`CAPTURE_REPORT_FILE`, declared once in domain/capture-manifest.ts);
 *   - an unsafe manifest entry                                 → exit 2.
 * The last line always carries `exit=N` in-band (ledger L6/L33/C6: `${PIPESTATUS[0]}`
 * came back empty three times and the run was saved only by verify printing its
 * own exit).
 *
 * Captures land under the slice's verify dir (`.loombridge/verify/<slice>/`) — the
 * same place `loombridge verify --slice` reads from. All judgment stays in the
 * agent layer; this CLI only composes ops and writes files (plan §3b).
 */

import fs from "node:fs/promises";
import path from "node:path";

import { captureConsoleEvidence } from "./capture-console.js";
import { captureFeelEvidence } from "./capture-feel.js";
import { capturePlayabilityEvidence } from "./capture-playability.js";
import { captureFramingEvidence } from "./capture-framing.js";
import { captureTileEvidence, TILE_CAPTURE_FILES } from "./capture-tiles.js";
import { loombridgePaths, readState } from "../../domain/state.js";
import { getSliceVerifyDir, readSlicePlan, type SliceEntry } from "./slices.js";
import { deriveSliceCaptureManifest } from "./build.js";
import {
  CAPTURE_REPORT_FILE,
  captureReportPath,
  checkCaptureManifest,
} from "../../domain/capture-manifest.js";
import {
  captureRecipesForFiles,
  type CaptureKind,
  type CaptureRecipeDispatch,
} from "../../domain/capture-recipes.js";
export { captureRecipesForFiles, recipeOutputs, type CaptureKind } from "../../domain/capture-recipes.js";

export interface CaptureArgs {
  root: string;
  /** Slice id: determines the output dir AND the capture recipes (from its manifest). */
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
  captureFeel: typeof captureFeelEvidence;
  capturePlayability: typeof capturePlayabilityEvidence;
}

const defaultDeps: CaptureDeps = {
  captureFraming: captureFramingEvidence,
  captureTiles: captureTileEvidence,
  captureConsole: captureConsoleEvidence,
  captureFeel: captureFeelEvidence,
  capturePlayability: capturePlayabilityEvidence,
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
      console.error(`[loombridge capture] unknown argument "${arg}".`);
      return { help: true, usageError: true };
    }
  }

  if (!slice && !outDir) {
    console.error("[loombridge capture] pass --slice <id> (or --out <dir>) to choose where the captures land.");
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

/** One recipe's outcome, for the report. */
interface RecipeOutcome {
  recipe: CaptureKind;
  ok: boolean;
  /** Refusal/error text when `ok` is false. */
  error?: string;
}

/** The machine-readable capture report (`CAPTURE_REPORT_FILE`). */
interface CaptureReport {
  writer: string;
  slice: string | null;
  runId: string;
  capturedAt: string;
  /** Where the manifest came from: the minted proof, the gate→file map, or nothing to diff. */
  manifestSource:
    | "slice.proof.captureManifest"
    | "deriveSliceCaptureManifest(slice) [build's own minting]"
    | "none (--out override / no --slice)";
  manifest: string[];
  recipes: RecipeOutcome[];
  /** Manifest entries a recipe produced and that are on disk. */
  produced: string[];
  /** Manifest entries whose producer RAN but did not land the file (exit 1). */
  producerFailed: string[];
  /**
   * Manifest entries NO recipe produces. Not a capture failure: the agent must
   * assemble them before `verify --slice` can grade them (exit stays 0).
   */
  agentAssemblyRequired: string[];
  /** Manifest entries that failed a containment rule (exit 2). */
  unsafe: string[];
  exit: number;
}

/**
 * The FINAL line of every `capture` run. `exit=N` is in-band because
 * `${PIPESTATUS[0]}` demonstrably does not survive the pipelines agents write
 * (ledger L6, L33, C6: three occurrences, one of which reported EXIT=0 for a
 * run that really exited 2).
 */
function printExit(code: number): number {
  console.error(`[loombridge capture] exit=${code}`);
  return code;
}

async function writeCaptureReport(outDir: string, report: CaptureReport): Promise<string> {
  const file = captureReportPath(outDir);
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(report, null, 2)}\n`, "utf-8");
  return file;
}

export async function runCapture(args: CaptureArgs, deps: CaptureDeps = defaultDeps): Promise<number> {
  const paths = loombridgePaths(args.root);
  const rel = (p: string) => path.relative(args.root, p);

  // ── The run binding, before anything is captured ────────────────────────────
  // Every producer stamps `runId` UNCONDITIONALLY (H11): evidence that cannot be
  // tied to the run that minted it is exactly the "verdict not bound to the run
  // it claims" shape the moat exists to stop. A conditional stamp made absence
  // invisible, so the door refuses here instead, naming the verb that fixes it.
  const state = await readState(paths);
  const runId = state?.currentBuild?.runId;
  if (!runId) {
    console.error(
      "[loombridge capture] REFUSED: no `currentBuild.runId` in .loombridge/STATE.md, so captures would be written with no run binding " +
        "and a gate cannot tell fresh evidence from a leftover file. Run `loombridge build` (or `loombridge build --slice <id>`) first.",
    );
    return printExit(2);
  }

  // Resolve the output dir AND the recipe SET. With --slice, both come from
  // SLICES.json (recipes from the slice's minted captureManifest); --out always
  // wins for the dir.
  let outDir = args.outDir;
  let slice: SliceEntry | undefined;
  /** Manifest entries exactly as `build` mints them, relative to `.loombridge/verify/`. */
  let manifest: string[] = [];
  let manifestSource: CaptureReport["manifestSource"] = "none (--out override / no --slice)";
  let dispatch: CaptureRecipeDispatch | null = null;

  if (args.slice) {
    const plan = await readSlicePlan(paths);
    if (!plan) {
      console.error("[loombridge capture] no .loombridge/SLICES.json — run `loombridge plan` to scaffold the roadmap first.");
      return printExit(2);
    }
    slice = plan.slices.find((s) => s.id === args.slice);
    if (!slice) {
      const known = plan.slices.map((s) => s.id).join(", ") || "(none)";
      console.error(`[loombridge capture] unknown slice "${args.slice}". Known ids: ${known}.`);
      return printExit(2);
    }
    outDir = args.outDir ?? getSliceVerifyDir(paths, args.slice);

    // The manifest `build` minted is the authority. When the slice has not been
    // built yet (no proof), fall back to the SAME map build mints it from, so the
    // two can never disagree about which files the slice owes.
    const minted = slice.proof?.captureManifest;
    if (minted && minted.length > 0) {
      manifest = [...minted];
      manifestSource = "slice.proof.captureManifest";
    } else {
      // `deriveSliceCaptureManifest` is the function `build` itself calls, not a
      // re-implementation of it: capture cannot own a second opinion about which
      // files a slice owes.
      try {
        manifest = deriveSliceCaptureManifest(slice);
      } catch (error) {
        console.error(`[loombridge capture] REFUSED: ${error instanceof Error ? error.message : String(error)}`);
        return printExit(2);
      }
      manifestSource = "deriveSliceCaptureManifest(slice) [build's own minting]";
    }

    // Recipes dispatch on the FILENAME; the manifest carries slice-relative paths.
    dispatch = captureRecipesForFiles(manifest.map((entry) => path.posix.basename(entry)));
    if (dispatch.recipes.length === 0) {
      console.error(
        `[loombridge capture] no capture recipe for slice "${args.slice}" (gates: ${slice.acceptance.gates.join(", ")}; ` +
          `manifest: ${manifest.join(", ") || "(empty)"}). ` +
          "Recipes exist for screen-rects.json (framing), platform-tiles.json/tile-render.json (GroundTiling tile captures), " +
          "feel.json (the feel producer), playability.json (the playability observer), and console.json (steady play-soak). " +
          "Every other entry is agent-assembled evidence today.",
      );
      return printExit(2);
    }
  }

  if (!outDir) {
    console.error("[loombridge capture] could not resolve an output dir.");
    return printExit(2);
  }
  // --out without --slice runs a single recipe with no manifest to diff against
  // (back-compat escape hatch; defaults to framing).
  if (!dispatch) {
    dispatch = captureRecipesForFiles(recipeSelectionForKind(args.kind ?? "framing"));
  }
  // An explicit --out redirects the evidence away from the place the manifest
  // declares, so there is nothing honest to diff it against. Say so rather than
  // reporting every entry as a producer failure.
  const canonicalSliceDir = args.slice ? getSliceVerifyDir(paths, args.slice) : null;
  const diffable = manifest.length > 0 && canonicalSliceDir !== null && path.resolve(outDir) === path.resolve(canonicalSliceDir);
  if (!diffable) {
    manifest = [];
    manifestSource = "none (--out override / no --slice)";
  }

  const outcomes: RecipeOutcome[] = [];
  for (const recipe of dispatch.recipes) {
    try {
      if (recipe === "tiles") {
        const result = await deps.captureTiles({ outDir, ...(args.project ? { project: args.project } : {}), runId });
        const missing = TILE_CAPTURE_FILES.filter((file) => !result.provenancedFiles.includes(file));
        console.error(
          `[loombridge capture] tiles: invoked GroundTiling.WriteTileCaptures → wrote [${result.provenancedFiles.join(", ") || "(none)"}] ` +
            `+ ${rel(result.consolePath)} (${result.logCount} log(s)) under ${rel(result.outDir)}`,
        );
        if (missing.length > 0) {
          const error =
            `missing required tile capture(s): ${missing.join(", ")}. ` +
            "GroundTiling.WriteTileCaptures must produce both platform-tiles.json and tile-render.json.";
          console.error(`[loombridge capture] ${error}`);
          outcomes.push({ recipe, ok: false, error });
          continue;
        }
        outcomes.push({ recipe, ok: true });
        continue;
      }

      if (recipe === "feel") {
        // The feel recipe needs the CONTRACT (its `harness.feelSeam` block, M14).
        // A missing/unreadable contract is a refusal with the JSON to add, raised by
        // the recipe itself so the message is one message wherever it is reached.
        let contract: unknown = undefined;
        try {
          contract = JSON.parse(await fs.readFile(paths.acceptance, "utf-8"));
        } catch (error) {
          contract = undefined;
          void error;
        }
        const result = await deps.captureFeel({
          outDir,
          contract,
          runId,
          ...(args.project ? { project: args.project } : {}),
        });
        console.error(
          `[loombridge capture] feel: wrote ${rel(result.feelPath)} (measured ${result.measured.join(", ") || "(nothing)"}) ` +
            `+ ${rel(result.consolePath)} (${result.logCount} log(s))`,
        );
        for (const entry of result.omitted) {
          console.error(`[loombridge capture] feel: ${entry.metric} NOT measured: ${entry.reason}`);
        }
        for (const gap of result.gaps) {
          console.error(`[loombridge capture] feel: provenance gap: ${gap}`);
        }
        outcomes.push({ recipe, ok: true });
        continue;
      }

      if (recipe === "playability") {
        // The observer needs the CONTRACT for both halves of its binding: the
        // `harness.playability` seam (which component carries win/score/lives) and
        // the `feel` targets the kinematic bound is derived from. Both refusals are
        // raised by the recipe itself, before play mode, with the JSON to add.
        let contract: unknown = undefined;
        try {
          contract = JSON.parse(await fs.readFile(paths.acceptance, "utf-8"));
        } catch (error) {
          contract = undefined;
          void error;
        }
        const result = await deps.capturePlayability({
          outDir,
          contract,
          runId,
          ...(args.project ? { project: args.project } : {}),
        });
        console.error(
          `[loombridge capture] playability: wrote ${rel(result.playabilityPath)} ` +
            `(completionMethod=${result.completionMethod}, ${result.sampleCount} sample(s) over ${result.driveSeconds}s of drive) ` +
            `+ ${rel(result.consolePath)} (${result.logCount} log(s))`,
        );
        outcomes.push({ recipe, ok: true });
        continue;
      }

      if (recipe === "console") {
        const result = await deps.captureConsole({ outDir, ...(args.project ? { project: args.project } : {}), runId });
        console.error(
          `[loombridge capture] console: wrote ${rel(result.consolePath)} ` +
            `(${result.logCount} log(s): ${result.startupCount} startup + ${result.steadyCount} steady, ` +
            "play-enter logs preserved, graded by console-clean)",
        );
        outcomes.push({ recipe, ok: true });
        continue;
      }

      const result = await deps.captureFraming({
        locators: args.locators,
        outDir,
        ...(args.cameraPath ? { cameraPath: args.cameraPath } : {}),
        ...(args.boundsMode ? { boundsMode: args.boundsMode } : {}),
        ...(args.project ? { project: args.project } : {}),
        runId,
      });
      console.error(
        `[loombridge capture] framing: wrote ${rel(result.screenRectsPath)} (${result.objectCount} object(s), pixelPerfect=${result.pixelPerfectCaptured}) ` +
          `+ ${rel(result.consolePath)} (${result.logCount} log(s))`,
      );
      if (!result.pixelPerfectCaptured) {
        console.error(
          "[loombridge capture] note: no PixelPerfectCamera found on the camera, so the framing gate's pixel-perfect check will WARN (degraded).",
        );
      }
      outcomes.push({ recipe, ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[loombridge capture] fatal (${recipe} recipe): ${message}`);
      outcomes.push({ recipe, ok: false, error: message });
    }
  }

  // ── The manifest diff: what was declared vs what is on disk ────────────────
  // THE shared predicate (`checkCaptureManifest`), the same one status and both
  // doneness paths use, so "the file is there" can never mean two things.
  const completeness = await checkCaptureManifest({
    manifest,
    verifyRoot: paths.verifyInputs,
    ...(canonicalSliceDir && diffable ? { scopeRoot: canonicalSliceDir } : {}),
  });
  const producerFor = new Map(dispatch.files.map((entry) => [entry.file, entry.recipe]));
  const producerOf = (entry: string): CaptureKind | null => producerFor.get(path.posix.basename(entry)) ?? null;
  const producerFailed = completeness.missing.filter((entry) => producerOf(entry) !== null);
  const agentAssemblyRequired = completeness.missing.filter((entry) => producerOf(entry) === null);
  const recipeFailed = outcomes.filter((o) => !o.ok);

  let exit = 0;
  if (completeness.unsafe.length > 0) exit = 2;
  else if (recipeFailed.length > 0 || producerFailed.length > 0) exit = 1;

  const report: CaptureReport = {
    writer: "loombridge capture",
    slice: args.slice ?? null,
    runId,
    capturedAt: new Date().toISOString(),
    manifestSource,
    manifest,
    recipes: outcomes,
    produced: completeness.present,
    producerFailed,
    agentAssemblyRequired,
    unsafe: completeness.unsafe,
    exit,
  };
  let reportPath: string | null = null;
  try {
    reportPath = await writeCaptureReport(outDir, report);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[loombridge capture] could not write ${CAPTURE_REPORT_FILE}: ${message}`);
  }

  if (completeness.unsafe.length > 0) {
    console.error(
      `[loombridge capture] REFUSED: unsafe captureManifest entr(ies): ${completeness.unsafe.join(", ")}. ` +
        "A capture path must be a normalized relative path inside the slice's verify dir.",
    );
  }
  if (producerFailed.length > 0) {
    console.error(
      `[loombridge capture] PRODUCER FAILED: ${producerFailed.map((f) => `${f} (${producerOf(f)} recipe)`).join(", ")}. ` +
        "The recipe ran and the file is not on disk.",
    );
  }
  if (agentAssemblyRequired.length > 0) {
    console.error(
      `[loombridge capture] agent-assembly required (no CLI recipe produces these): ${agentAssemblyRequired.join(", ")}. ` +
        `verify --slice ${args.slice ?? "<id>"} cannot grade their gates until they exist.`,
    );
  }
  console.error(
    `[loombridge capture] manifest ${completeness.present.length}/${manifest.length} present` +
      (manifest.length === 0 ? " (no manifest to diff)" : "") +
      (reportPath ? ` → ${rel(reportPath)}` : ""),
  );
  return printExit(exit);
}

/** The single-recipe selection behind `--out` without `--slice` (no manifest). */
function recipeSelectionForKind(kind: CaptureKind): string[] {
  return kind === "tiles"
    ? ["platform-tiles.json", "tile-render.json"]
    : kind === "console"
      ? ["console.json"]
      : kind === "feel"
        ? ["feel.json"]
        : kind === "playability"
          ? ["playability.json"]
          : ["screen-rects.json"];
}

function printUsage(): void {
  console.log(
    [
      "Usage: loombridge capture --slice <id> [options]",
      "",
      "Write a slice's verification evidence from raw Unity bridge ops, with a",
      "_provenance block, instead of hand-authoring them. The recipes are chosen",
      "from the slice's MINTED captureManifest (the same gate→file map build uses):",
      "  screen-rects.json           → framing recipe (+ console.json)",
      "  platform-tiles.json /       → tiles recipe (GroundTiling.WriteTileCaptures)",
      "  tile-render.json               (+ console.json)",
      "  feel.json                   → feel recipe (drives the canonical feel",
      "                                 measurements; needs acceptance.harness.feelSeam)",
      "  playability.json            → playability OBSERVER (opens a recorded play",
      "                                 window, prints a machine-readable DRIVE NOW",
      "                                 line and BLOCKS while you play the level from",
      "                                 your own connection, then derives the verdict",
      "                                 from the recording; needs harness.playability.",
      "                                 Give up after harness.playability.driveTimeoutSeconds)",
      "  console.json (alone)        → console recipe (steady play-soak; e.g. parallax)",
      "A slice needing several of these runs several recipes.",
      "",
      "Every run ends with a manifest diff and an in-band exit line:",
      "  producer ran but the file is missing        → exit 1",
      "  entry no recipe produces (agent-assembly)   → exit 0, named in the report",
      "  unsafe manifest entry                       → exit 2",
      `  the diff is written to <verify dir>/${CAPTURE_REPORT_FILE}`,
      "",
      "Requires a minted run: `loombridge build` first (captures stamp its runId).",
      "",
      "Options:",
      "  --root <dir>         Project root (default: cwd)",
      "  --slice <id>         Slice id — captures land in .loombridge/verify/<id>/",
      "  --out <dir>          Explicit output dir (overrides --slice's default; framing recipe)",
      "  --locators <a,b,c>   Comma-separated object paths to project (framing; default: /Player)",
      "  --camera <path>      Camera GameObject path (framing; default: /Main Camera)",
      "  --bounds-mode <m>    Screen-rects bounds mode (opaque | renderer | collider)",
      "  --project <p>        Route to a specific Unity editor (projectPathCanonical or",
      "                       unique projectName). Omit to honor LOOMBRIDGE_UNITY_PROJECT,",
      "                       then single-editor auto-selection.",
      "  -h, --help           Show this help",
      "",
      "Exit: 0 on success (including agent-assembly-required entries), 1 on capture",
      "failure, 2 on usage/dispatch/no-run refusal. The last line prints exit=N.",
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
