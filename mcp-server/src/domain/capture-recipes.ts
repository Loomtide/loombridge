/**
 * Which deterministic capture recipes a slice needs.
 *
 * THE SOURCE OF TRUTH IS THE FILE LIST, NOT THE GATE NAMES. `loombridge build`
 * mints a slice's `captureManifest` from `gateInputFiles(slice.acceptance.gates)`
 * (the verifier-owned gate to evidence-filename map in `run-gates.ts`). Dispatch
 * therefore takes THAT SAME file list and answers two questions per entry:
 * which recipe writes it, and (the question the CLI never used to ask) which
 * entries NOTHING writes (ledger L1/L34/L65: `capture` wrote 1 of 5 manifest
 * entries and exited 0 in silence).
 *
 * Because the mapping is file-keyed, adding a producer is a one-line change here
 * (its outputs) and the dispatch, the manifest diff and the "agent-assembly
 * required" list all move at once. The old `captureKindForSlice` returned ONE
 * kind by positional precedence, so a slice needing two recipes silently got the
 * higher-precedence one only; this returns the SET.
 */

/** A deterministic capture recipe the CLI can run itself. */
export type CaptureKind = "framing" | "tiles" | "feel" | "playability" | "console";

/**
 * Files each recipe writes as its REASON FOR EXISTING. A manifest entry listed
 * here selects its recipe.
 */
const RECIPE_PRIMARY_OUTPUTS: Record<CaptureKind, readonly string[]> = {
  // Ordered by run precedence (see RECIPE_ORDER).
  tiles: ["platform-tiles.json", "tile-render.json"],
  framing: ["screen-rects.json"],
  // Stage 2 (evidence arc E1): the feel producer. `feel.json` was the moat's worst
  // case: 100 percent agent-authored, every provenance field a typed literal
  // (ledger L45/L46/L75/L76/L77): and is now written from the bridge's own echoes.
  feel: ["feel.json"],
  // Stage 3 (evidence arc E2): the playability observer. `playability.json` carried
  // seven hard-coded literals and a self-declared `completionMethod`, the gate's own
  // anti-teleport control (ledger L97/L98): and is now derived from a continuous
  // in-game-loop recording of the play session plus CLI-driven post-win probes.
  playability: ["playability.json"],
  console: [],
};

/**
 * Files a recipe ALSO writes on its way past. `console.json` is written by every
 * recipe (framing and tiles both snapshot the console), so a slice that needs
 * console evidence plus a primary recipe does NOT also need the console-only
 * recipe, but a slice that needs console evidence and nothing else does.
 */
const RECIPE_INCIDENTAL_OUTPUTS: Record<CaptureKind, readonly string[]> = {
  tiles: ["console.json"],
  framing: ["console.json"],
  // The feel recipe holds play mode for a long, input-driven session, so its own
  // console snapshot is the one that covers the run that produced the measurements.
  feel: ["console.json"],
  // The observer holds play mode for the whole hand-driven completion, so its
  // console snapshot is the one that covers the session the verdict describes
  // (ledger L106: console.json came from a play-enter soak BEFORE the played run,
  // so console-clean certified a session in which the game was never played).
  playability: ["console.json"],
  console: ["console.json"],
};

/**
 * Run order. Primary recipes first; the console-only recipe is the fallback.
 * `playability` runs LAST of all: it is the only recipe that hands control to a
 * human or agent for minutes at a time, so everything the CLI can do alone is
 * already done when the drive-now line prints, and its console snapshot then
 * covers the whole run including the played completion.
 */
const RECIPE_ORDER: readonly CaptureKind[] = ["tiles", "framing", "feel", "playability", "console"];

/** Every file a recipe writes (primary + incidental). */
export function recipeOutputs(kind: CaptureKind): string[] {
  return [...RECIPE_PRIMARY_OUTPUTS[kind], ...RECIPE_INCIDENTAL_OUTPUTS[kind]];
}

/** One manifest entry and the recipe that produces it (or `null` for none). */
export interface CaptureFileProducer {
  /** The manifest entry, as `build` minted it (e.g. `"feel.json"`). */
  file: string;
  /** The recipe that writes it, or `null` when nothing in the CLI does. */
  recipe: CaptureKind | null;
}

/** The recipe SET a set of capture files resolves to. */
export interface CaptureRecipeDispatch {
  /** Recipes to run, in run order, deduplicated. */
  recipes: CaptureKind[];
  /** Per-file producer resolution, in the order the files were given. */
  files: CaptureFileProducer[];
  /**
   * Files no recipe writes. These are the "agent-assembly required" entries:
   * NOT a capture failure (nothing was asked to write them), but never silent
   * either: `capture` names them and records them in its report.
   */
  unproduced: string[];
}

/**
 * Resolve the recipe SET for a slice's capture files (its minted
 * `captureManifest` entries, basenames; see `gateInputFiles`).
 */
export function captureRecipesForFiles(files: Iterable<string>): CaptureRecipeDispatch {
  const requested = [...files];
  const requestedSet = new Set(requested);

  // 1. Every recipe whose PRIMARY output is requested is selected.
  const selected = RECIPE_ORDER.filter((kind) =>
    RECIPE_PRIMARY_OUTPUTS[kind].some((file) => requestedSet.has(file)),
  );

  // 2. Anything still uncovered that the console-only recipe can write selects it.
  const covered = new Set(selected.flatMap((kind) => recipeOutputs(kind)));
  if (!selected.includes("console") && requested.some((file) => !covered.has(file) && RECIPE_INCIDENTAL_OUTPUTS.console.includes(file))) {
    selected.push("console");
  }

  // 3. Resolve each requested file to the FIRST selected recipe that writes it.
  const resolved: CaptureFileProducer[] = requested.map((file) => {
    const recipe = selected.find((kind) => recipeOutputs(kind).includes(file)) ?? null;
    return { file, recipe };
  });

  return {
    recipes: RECIPE_ORDER.filter((kind) => selected.includes(kind)),
    files: resolved,
    unproduced: resolved.filter((entry) => entry.recipe === null).map((entry) => entry.file),
  };
}
