/**
 * The `visual-artifacts` capture recipe.
 *
 * WHY THIS EXISTS. `visual-artifacts.json` was the last manifest entry no recipe produced, so
 * `loombridge capture --slice <id>` reported it as agent-assembly and exited 0. A real 3d-shooter
 * session did exactly what that invites: it wrote a scratchpad driver, scraped base64 screenshots
 * out of a JSONL stream (against `unity_editor_screenshot`'s own instruction to pass `outputPath`),
 * and labelled the frames POSITIONALLY with `zip(["aim","scoped","unscoped"], shots)`. That last
 * part is the dangerous one: a dropped or reordered capture silently mislabels the evidence, and
 * `analyze-frames --baseline aim --stress unscoped` then renders a confident verdict about the
 * wrong pair. A verdict not bound to the run it claims.
 *
 * IT DELEGATES, IT DOES NOT REIMPLEMENT. `capture-runner` already drives the whole session (play
 * mode, drivers, timed/triggered captures) and writes frames + `visual-artifacts.json` +
 * `console.json` from a declarative scenario. Duplicating that here would be a second producer of
 * the same evidence, which is how the two drift. This recipe resolves a scenario and hands off.
 *
 * THE SCENARIO MUST BE NAMED, NOT GUESSED. Bundled pack selection matches on game kind and only
 * `platformer-2d-basic` ships, so a 3D contract matches nothing. Rather than invent a genre frame
 * grammar from a single run, this takes an explicit `--scenario <path>`, and when neither that nor
 * a bundled pack resolves it REFUSES with the exact thing to author. Refusing loudly is the point:
 * silently falling back to "agent-assembly required" is what produced the hand-rolled pipeline.
 */
import fs from "node:fs/promises";
import path from "node:path";

import { runCaptureRunner, knownScenarioPacks, selectScenarioPack } from "./capture-runner.js";
import { stampProvenance } from "./capture-tiles.js";
import type { AcceptanceContract } from "./types.js";

export interface CaptureVisualArtifactsArgs {
  /** Slice evidence dir; frames and visual-artifacts.json land here. */
  outDir: string;
  /** Path to the acceptance contract (capture-runner reads and validates it). */
  acceptancePath: string;
  /** The parsed contract, for pack selection and the refusal message. */
  acceptance: unknown;
  /** Explicit scenario path (`--scenario`). Wins over bundled pack selection. */
  scenarioPath?: string;
  /** Route to a specific Unity editor. */
  project?: string;
  /**
   * The minted run id. REQUIRED, and stamped onto the produced file.
   *
   * `capture-runner` writes no `_provenance` block and takes no runId: it predates capture's E13
   * rule ("a present entry that cannot name the run that wrote it is a producer failure"). So a
   * bare delegation would produce a file capture itself rejects, and this recipe would exit 1 on
   * every run. The recipe stamps it, which is an honest claim: this run did produce this file.
   */
  runId: string;
}

export interface CaptureVisualArtifactsResult {
  visualArtifactsPath: string;
  framesDir: string;
  /** Which scenario drove the session, for the report line. */
  scenarioPath: string;
}

/**
 * Resolve the scenario, or throw a refusal that says exactly what to do.
 *
 * Exported so the refusal is unit-testable without a live editor: the message IS the feature for
 * every genre that has no bundled pack, which today is every genre except 2D platformer.
 */
export function resolveVisualArtifactsScenario(args: {
  acceptance: unknown;
  scenarioPath?: string;
}): string {
  if (args.scenarioPath) return args.scenarioPath;
  try {
    return selectScenarioPack(args.acceptance as AcceptanceContract).path;
  } catch {
    const known = knownScenarioPacks()
      .map((pack) => `${pack.id} (${pack.gameKind})`)
      .join(", ");
    throw new Error(
      "visual-artifacts needs a capture scenario and none resolved. No bundled pack matches this " +
        `contract (bundled: ${known || "none"}), so pass \`--scenario <path>\` pointing at a ` +
        "project-local scenario JSON.\n" +
        "A scenario declares WHICH frames to capture and which is the baseline, e.g.\n" +
        '  "sequences": [{ "id": "<name>", "captures": [\n' +
        '      { "id": "aim",      "trigger": "start",       "view": "game" },\n' +
        '      { "id": "unscoped", "trigger": "atMs", "atMs": 400, "view": "game" }\n' +
        "  ] }],\n" +
        '  "analysis": { "baselineFrameId": "aim" }\n' +
        "Declaring the ids is what binds each frame to its state. Capturing them by hand and " +
        "labelling them positionally silently mislabels the evidence when a capture drops.",
    );
  }
}

/** Run the scenario session into `outDir`, producing frames + visual-artifacts.json. */
export async function captureVisualArtifactsEvidence(
  args: CaptureVisualArtifactsArgs,
): Promise<CaptureVisualArtifactsResult> {
  const scenarioPath = resolveVisualArtifactsScenario({
    acceptance: args.acceptance,
    ...(args.scenarioPath ? { scenarioPath: args.scenarioPath } : {}),
  });

  const code = await runCaptureRunner({
    acceptancePath: args.acceptancePath,
    scenarioPath,
    outDir: args.outDir,
    ...(args.project ? { project: args.project } : {}),
  });
  if (code !== 0) {
    throw new Error(`capture-runner exited ${code} while producing visual-artifacts evidence`);
  }

  const visualArtifactsPath = path.join(args.outDir, "visual-artifacts.json");
  // Producer-ran-but-file-missing is capture's exit-1 contract, so check rather than assume.
  const raw = await fs.readFile(visualArtifactsPath, "utf-8").catch(() => {
    throw new Error(
      `capture-runner reported success but ${visualArtifactsPath} is missing. ` +
        "The scenario may declare no PNG captures: visual-artifacts needs at least a baseline and one stress frame.",
    );
  });

  // Stamp WITHOUT altering content: `stampProvenance` passes gate-shaped keys through untouched,
  // so the frames/comparisons the analyzer produced are exactly what the gate grades.
  const stamped = stampProvenance(JSON.parse(raw) as unknown, {
    writer: "loombridge capture (visual-artifacts recipe)",
    runId: args.runId,
    scenario: scenarioPath,
    producedBy: "capture-runner scenario session",
  });
  await fs.writeFile(visualArtifactsPath, `${JSON.stringify(stamped, null, 2)}\n`, "utf-8");

  return { visualArtifactsPath, framesDir: path.join(args.outDir, "frames"), scenarioPath };
}
