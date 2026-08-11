/**
 * `loombridge trace` — Replay Verification product surface.
 *
 *   loombridge trace replay [--id <id>] [--root <dir>] [--trace <path>] [--no-html]
 *   loombridge trace report --id <id> [--root <dir>]
 *   loombridge trace tolerance --id <id> --set <fraction>
 *
 * `replay` reads `.loombridge/replays/traces/<id>.trace.json`, drives it against the
 * running editor, and writes `.loombridge/replays/reports/<id>.report.{json,html}`
 * plus the captured PNGs under `.loombridge/replays/reports/<id>/actual/`.
 * `report` re-renders the self-contained HTML from an existing report JSON.
 *
 * The verb is the `.loombridge/` integration layer over the replay engine; all
 * decision logic lives in the engine, and the live wiring in `run-live`.
 */

import fs from "node:fs/promises";
import path from "node:path";

import {
  comparePerceptual,
  isSafePathSegment,
  parseTrace,
  renderFleetReportHtml,
  renderReplayReportHtml,
  summarizeFleet,
  type CaptureImage,
  type FleetTraceResult,
  type ObserveTraceMeta,
  type OutcomeSpec,
  type ReplayRunArtifact,
} from "./index.js";
import { observeRecordLive } from "./observe-record-live.js";
import {
  ALIGNED_RESIDUAL_SENTENCE,
  DEFAULT_ALIGNED_CAPTURE_FPS,
  MAX_ALIGNED_CAPTURE_FPS,
  MIN_ALIGNED_CAPTURE_FPS,
  alignedCaptureFpsRefusal,
  alignedFloorMs,
  alignedSettleFrames,
} from "./aligned-capture.js";
import {
  TRACE_BASELINE_MANIFEST,
  carryForward,
  isTraceBaselineManifestError,
  loadTraceBaselineManifest,
  MIN_SCALED_SETTLE_MS,
  nextApprovalLedger,
  replaySpeedRefusal,
  resolveDriftTolerance,
  resolveMaskRects,
  sha256,
  traceBaselineManifestPath,
  toleranceRefusal,
  verifyTraceBaseline,
  writeTraceBaselineManifest,
  type TraceBaselineManifest,
  type TraceBaselinePng,
} from "./trace-baseline-manifest.js";
import {
  DEFAULT_DRIFT_FRACTION,
  MAX_DRIFT_TOLERANCE,
  MAX_MASKED_FRACTION,
  REPRODUCED_DRIFT_SIMILARITY,
  anchorTermsSentence,
  deriveMaskSuggestion,
  driftPercentText,
  driftRegressionLine,
  driftSuggestionLines,
  formatRectGeometry,
  maskAnchorTerms,
  maskRefusal,
  maskSuggestionLines,
  masksForCapture,
  rectKey,
  toleranceConsentSentence,
  type AnchorTerms,
  type CaptureDriftEvidence,
  type DriftFacts,
  type MaskRect,
  type MaskSuggestion,
} from "./visual-diff.js";
import { isScenePath } from "../minigame/profiles/types.js";
import { runLiveReplay, type RunLiveReplayOptions } from "./run-live.js";
import { resolveCliProjectPin } from "../setup/cli-project-pin.js";
import {
  flatReplayLayout,
  standardReplayLayout,
  type ReplayLayout,
} from "../../domain/state.js";
import { unityConnectionHint, unityConnectionLostHint } from "../../shared/cli-ui.js";
import { printNextStep } from "../minigame/minigame-next.js";
import { readPng } from "../verification/analyze-frames.js";

interface TraceArgs {
  sub: "replay" | "report" | "approve" | "replay-all" | "record" | "tolerance" | "mask";
  /**
   * Trace id. Empty when none was given, which only `record`, `replay` and `approve` allow:
   * `record` derives one from the recorded scene, `replay` falls back to the most recent
   * trace (see {@link resolveReplayTargetId}), and `approve` to the most recent REPORT (see
   * {@link resolveApproveTargetId}). Every other subcommand still requires it.
   */
  id: string;
  root: string;
  /** Override the trace input path (default `.loombridge/replays/traces/<id>.trace.json`). */
  tracePath?: string;
  /**
   * Use the FLAT workspace layout — replay artifacts directly under `--root`
   * (`<root>/traces|reports|baseline`), no nested `.loombridge/`. Default false
   * (standard `<root>/.loombridge/replays/`). The mini-game workspace passes this.
   */
  flat: boolean;
  /** Emit the HTML report (default true). */
  html: boolean;
  /** Make a visual drift from baseline a failure (exit 1), not just a warning. */
  strictVisual: boolean;
  /**
   * `tolerance --set <fraction>`: the pixel allowance to stamp onto the EXISTING
   * approved baseline. Parsed and range-checked in `parseArgs`, and REFUSED on every
   * other subcommand (A6), so approve can never grow a tolerance argument and
   * re-freeze drifted frames in the same breath.
   */
  driftTolerance?: number;
  /**
   * `mask --set <captureId?>:<x>,<y>,<w>x<h>@<reason>` (repeatable). THE WHOLE LIST, every
   * stamp (Q4): a `--add` that appended would make each stamp a local edit to a set
   * nobody was looking at, which is how a mask list grows to cover the frame one
   * reasonable-looking rect at a time. Restating it means the operator sees, and consents
   * to, the total every single time.
   */
  maskSet?: MaskRect[];
  /** `mask --clear`: stamp an EMPTY mask list (the whole frame goes back to being graded). */
  maskClear: boolean;
  /** `mask --list`: print the approved masks and their terms. Touches nothing. */
  maskList: boolean;
  /** Replay pacing multiplier (replay only): divides recorded settles, floored. */
  speed?: number;
  /**
   * `--aligned` / `--aligned-fps <n>` (replay only): capture each settle through the
   * bridge's pinned tick loop at this fps instead of sleeping here and screenshotting after.
   * Absent = the legacy wall-clock settle, unchanged.
   */
  alignedCaptureFps?: number;
  // ── record --observe ──
  /** Scene to reset to + record from (record only; optional: absent resolves the editor's current scene). */
  scene?: string;
  /**
   * `--observe`: accepted and IGNORED. Observing a human session is the only recording mode
   * there has ever been, so the flag selects nothing; it stays parseable (with no deprecation
   * noise) because docs, scripts and muscle memory are full of it.
   */
  observe?: boolean;
  /** Optional human-readable trace title/intent (record only). */
  title?: string;
  intent?: string;
  /** Auto-stop after N seconds instead of waiting for Enter (record only). */
  durationSec?: number;
  /** Path to a JSON `OutcomeSpec[]` to pin as end-state assertions (record only). */
  outcomesPath?: string;
  /**
   * Declared STATE SIGNAL (record only): `<path>:<Component>:<property>`. The observer
   * samples this field per gesture so the recorded trace gates each gesture on the game
   * reaching the consumable state (a `wait-for-condition`), not just on the target being
   * visible. Already validated/split into the meta shape in parseArgs.
   */
  stateSignal?: ObserveTraceMeta["stateSignal"];
  /**
   * Whether the observer AUTO-DETECTS each scene's state signal live and switches on
   * scene-change (Phase 2 / D1-B). The hands-off path for multi-gesture-scene games. ALREADY
   * RESOLVED here (record only): default ON, OFF when `--state-signal` was declared, and
   * whatever `--auto-state-signal` / `--no-auto-state-signal` said when either was typed. See
   * {@link resolveAutoStateSignal} for the table.
   */
  autoStateSignal: boolean;
}

/**
 * Parse `--state-signal <path>:<Component>:<property>` into the `ObserveTraceMeta`
 * state-signal shape `{ locator: { path }, component, property }`. Splits on ':' and
 * REFUSES (returns null) unless EXACTLY three non-empty colon-delimited parts are
 * present — a malformed value is rejected at the CLI (exit 2), never silently
 * dropped. The GameObject path uses no scene prefix (no embedded ':'). Pure;
 * exported for unit tests.
 */
export function parseStateSignal(
  raw: string,
): ObserveTraceMeta["stateSignal"] | null {
  const parts = raw.split(":");
  if (parts.length !== 3) return null;
  const [path, component, property] = parts;
  if (!path || !component || !property) return null;
  return { locator: { path }, component, property };
}

/**
 * Decide whether the observer AUTO-DETECTS each scene's state signal (`record` only).
 *
 * Auto detection is additive and best-effort: when it finds nothing the gesture is simply
 * not phase-gated, which is exactly the pre-flag behaviour. So it defaults ON, which fixes
 * the hub→game multi-scene recording with no flag typed. The one thing a default must never
 * do is beat something the developer stated out loud, hence the table:
 *
 * | typed                                        | auto detection |
 * |----------------------------------------------|----------------|
 * | nothing                                      | ON (default)   |
 * | `--state-signal <spec>`                      | OFF (the declared signal wins) |
 * | `--auto-state-signal` (with or without the above) | ON (explicit, and it still takes precedence over a declared signal, as documented) |
 * | `--no-auto-state-signal`                     | OFF (the explicit opt out, whatever else was typed) |
 *
 * `flag` is `undefined` when NEITHER auto flag was typed, and that absence is the whole point:
 * so it must not be collapsed to `false` before it gets here. Pure; exported for unit tests.
 */
export function resolveAutoStateSignal(
  flag: boolean | undefined,
  hasDeclaredStateSignal: boolean,
): boolean {
  if (flag !== undefined) return flag; // an explicit flag wins in BOTH directions
  return !hasDeclaredStateSignal; // the default never overrides a declaration
}

/**
 * Derive a trace id from a scene path: basename without `.unity`, kebab-cased.
 * `Assets/Scenes/KidsChef.unity` → `kids-chef`, `Assets/Scenes/CountTheFruits.unity` →
 * `count-the-fruits`, `Assets/Scenes/HUDTest.unity` → `hud-test`.
 *
 * A CamelCase hump IS a word boundary, because Unity scene names are conventionally
 * PascalCase and this id is not internal: it becomes the trace filename, the baseline
 * directory name and a row in the fleet roll-up. Splitting only on stated separators would
 * mint `countthefruits` and `kidsadventure` there. The goal is the id a developer would have
 * typed by hand, which is the whole reason for deriving instead of asking.
 *
 * Two boundary patterns, in this order, then the separator pass:
 *   1. lower-or-digit followed by upper (`KidsChef` → `Kids Chef`, `Level2Boss` → `Level2 Boss`)
 *   2. an ACRONYM RUN followed by a capitalised word (`HUDTest` → `HUD Test`). Without this,
 *      pattern 1 alone leaves `HUDTest` intact and the result is `hudtest`; splitting every
 *      capital instead would give `h-u-d-test`. An acronym is one word until a real word starts.
 * Everything then lower-cases, runs of non-alphanumerics collapse to a single `-`, and leading
 * or trailing `-` is trimmed, so an already-kebab name survives byte for byte.
 *
 * Returns null when nothing usable survives (e.g. a scene named entirely in non-ASCII), so
 * the caller can REFUSE and ask for an explicit `--id`. There is deliberately no generic
 * fallback name: the id becomes a filename and an anchor, and "recording" or "trace-1" would
 * be a name nobody chose sitting on a verdict. The result is checked against the SAME
 * `isSafePathSegment` the trace parser and `--id` use, so the sanitiser can never quietly
 * emit something the validator would reject. Pure; exported for unit tests.
 */
export function traceIdFromScenePath(scenePath: string): string | null {
  const base = path.basename(scenePath).replace(/\.unity$/i, "");
  const id = base
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return id.length > 0 && isSafePathSegment(id) ? id : null;
}

/**
 * The honest notice lines for gestures the observer saw but did NOT record. Both counts
 * are losses the human would otherwise have to guess at:
 *
 * - `droppedNoTarget`: the tap hit no interactive element (backdrop / decoration), so the
 *   game had nothing to run.
 * - `droppedUnfocused`: the Game view did not have input focus, so the EDITOR swallowed the
 *   tap and the game never received it. Recording it would mint a phantom step that replay
 *   (clean reset + focus-independent virtual input) cannot reproduce.
 * - `droppedOsModifier`: a Cmd/Meta/Win key edge — window-manager input (focusing the Game view,
 *   alt-tabbing), not gameplay. Replaying it would inject a HELD Cmd into the game. Ctrl, Alt and
 *   Shift are never dropped: real games bind them.
 *
 * A zero count prints nothing. A bridge older than the focus backstop reports no
 * `droppedUnfocused` at all, which reads as 0, so its output is unchanged. Pure;
 * exported for unit tests.
 */
export function observeDropNotices(counts: {
  droppedNoTarget: number;
  droppedUnfocused?: number;
  droppedOsModifier?: number;
}): string[] {
  const lines: string[] = [];
  if (counts.droppedNoTarget > 0) {
    lines.push(
      `[loombridge trace] ignored ${counts.droppedNoTarget} inert tap(s) (no interactive target — backdrop/empty space).`,
    );
  }
  const unfocused = counts.droppedUnfocused ?? 0;
  if (unfocused > 0) {
    lines.push(
      `[loombridge trace] ignored ${unfocused} tap(s) while the Game view was unfocused (the game never received them).`,
    );
  }
  const osModifier = counts.droppedOsModifier ?? 0;
  if (osModifier > 0) {
    lines.push(
      `[loombridge trace] ignored ${osModifier} Cmd/Win key edge(s) — OS window-manager input (focusing the Game view), not gameplay. Ctrl/Alt/Shift are always kept.`,
    );
  }
  return lines;
}

/**
 * WHAT A RECORDING ACTUALLY DEMONSTRATED, read back off the built trace rather than
 * off the transform that built it.
 *
 * The summary line used to report `trace.segments.length`, which is a count of the
 * transform's internal packaging and not of anything the human did. The pointer
 * transform emits one segment per gesture, so the two happened to agree; the merged
 * keyboard transform emits ONE segment carrying the whole timeline, so a 62-action
 * demonstration printed "1 step(s)". Counting the gestures and key edges IN THE
 * TRACE is accurate for both, because both transforms emit the same action
 * vocabulary and only differ in how they group it.
 *
 * `captures` is the number of frames a replay of this trace will take. It is counted
 * from the trace too, so it tracks whatever the transforms do next without this
 * function being told.
 */
export interface TraceDemonstration {
  /** Pointer gestures: taps, drags, and world taps. */
  gestures: number;
  /** Keyboard edges: `key-down` / `key-up` (a `key-tap`/`key-hold` counts as one). */
  keyEdges: number;
  /** Frames a replay will capture. */
  captures: number;
}

export function traceDemonstration(trace: {
  segments: { actions: { do: string }[]; captures?: unknown[] }[];
}): TraceDemonstration {
  let gestures = 0;
  let keyEdges = 0;
  let captures = 0;
  for (const segment of trace.segments) {
    captures += segment.captures?.length ?? 0;
    for (const action of segment.actions) {
      // An INTERLEAVED capture is a frame the replay will take, exactly like a trailing one.
      // Counting it here is what makes the under-capture warning silence itself once the
      // merged keyboard transform starts emitting one per gesture.
      if (action.do === "capture") captures += 1;
      else if (action.do === "tap" || action.do === "drag" || action.do === "world-tap") gestures += 1;
      else if (
        action.do === "key-down" ||
        action.do === "key-up" ||
        action.do === "key-tap" ||
        action.do === "key-hold"
      ) {
        keyEdges += 1;
      }
    }
  }
  return { gestures, keyEdges, captures };
}

/**
 * THE HONEST WARNING FOR A RECORDING THAT WILL BE UNDER-CAPTURED, bound to the
 * observable fact and nothing else: this trace takes FEWER frames than the human
 * demonstrated gestures.
 *
 * Why it matters beyond ergonomics. Approving such a trace freezes a baseline of
 * however many frames it takes, so the pixel ratchet guards nothing about the
 * gestures that produced them. A human who recorded 14 gestures and got 1 frame has
 * a green trace that would stay green through a regression in 13 of them.
 *
 * Deliberately NOT keyed on "which transform ran". The keyboard timeline is the
 * reason today, and the key-edge count is mentioned only when the trace actually
 * carries key edges, but the CONDITION is the count comparison — so the warning
 * disappears on its own the moment a transform starts emitting a frame per gesture,
 * and would reappear for any future path that under-captures for a different reason.
 * Pure; exported for unit tests.
 */
export function captureCoverageNotices(shape: TraceDemonstration): string[] {
  if (shape.captures >= shape.gestures) return [];
  const uncaptured = shape.gestures - shape.captures;
  const lines = [
    `[loombridge trace] WARNING: ${shape.gestures} gesture(s) were demonstrated but this trace takes only ` +
      `${shape.captures} capture(s) — ${uncaptured} gesture(s) get no frame of their own.`,
    "[loombridge trace]   Approving it freezes a baseline over those few frames, so the pixel ratchet guards " +
      "nothing about the gestures that produced them.",
  ];
  if (shape.keyEdges > 0) {
    lines.push(
      `[loombridge trace]   Cause: the ${shape.keyEdges} recorded key edge(s) put this recording on the merged ` +
        "keyboard timeline, which is captured as one continuous run.",
    );
    lines.push(
      "[loombridge trace]   If the keys were incidental, re-record the flow without touching the keyboard and " +
        "each gesture gets its own capture.",
    );
  }
  return lines;
}

/** Resolve the replay layout from `--root` + the `--flat` flag. */
function layoutFor(args: TraceArgs): ReplayLayout {
  return args.flat ? flatReplayLayout(args.root) : standardReplayLayout(args.root);
}

/**
 * Non-argv dependencies of the `trace` verb (the `feel snapshot` / `assets` precedent for a
 * `run(args, opts)` door). Empty in production; a test uses it to drive the WHOLE verb,
 * including this function's own error tiering, against a scripted bridge. Nothing here can
 * be typed on a command line, so the argv shape stays the one contract users have.
 */
export interface TraceRunOpts {
  clientFactory?: RunLiveReplayOptions["clientFactory"];
}

export async function run(args: string[], opts: TraceRunOpts = {}): Promise<number> {
  const parsed = parseArgs(args);
  if ("help" in parsed) {
    printUsage();
    return parsed.usageError ? 2 : 0;
  }
  try {
    if (parsed.sub === "replay") return await runReplay(parsed, opts);
    if (parsed.sub === "replay-all") return await runReplayAll(parsed);
    if (parsed.sub === "approve") return await runApprove(parsed);
    if (parsed.sub === "tolerance") return await runTolerance(parsed);
    if (parsed.sub === "mask") return await runMask(parsed);
    if (parsed.sub === "record") return await runRecord(parsed, opts);
    return await runReport(parsed);
  } catch (error) {
    const hint = unityConnectionHint(error) ?? unityConnectionLostHint(error);
    if (hint) {
      // An unreachable editor is a HARNESS fault, never a game verdict: exit 2, the same
      // tier a blocked replay reports. (S1 final test flagged this verb as the one trace
      // door still mapping the condition to 1.)
      //
      // A CONNECTION LOST MID-RUN IS THE SAME TIER, and used to miss this branch entirely:
      // `unity-client` rejects every in-flight op with a plain `Error("CONNECTION_LOST: …")`
      // that carries no `UnityConnectionError` name, so a domain reload or a closed editor
      // fell through to `fatal` and exited 1: a harness fault reported as a game defect,
      // which is the one mapping this product refuses to make. The message shape is the
      // contract `resilientSend` already matches on, so both doors read one predicate.
      console.error(hint.join("\n"));
      return 2;
    }
    console.error(`[loombridge trace] fatal: ${message(error)}`);
    return 1;
  }
}

async function runReplay(args: TraceArgs, opts: TraceRunOpts = {}): Promise<number> {
  const paths = layoutFor(args);
  const id = await resolveReplayTargetId(paths, args);
  // Nothing to replay, and the refusal has already been printed. Exit 2, NOT 1: the tier
  // is the one `--id <id> is required` used to exit with on this exact argv, and no game
  // was ever driven, so the game-defect tier (1) would be a verdict about nothing.
  if (id === null) return 2;
  const { artifact, reportJson, htmlPath } = await replayOneTrace(paths, id, {
    tracePath: args.tracePath,
    html: args.html,
    projectPathCanonical: resolveCliProjectPin({ root: args.root }),
    speed: args.speed,
    alignedCaptureFps: args.alignedCaptureFps,
    ...(opts.clientFactory ? { clientFactory: opts.clientFactory } : {}),
  });
  printSummary(args.root, id, artifact, reportJson, htmlPath, args.strictVisual);
  // In the mini-game workspace flow (--flat), print the EXACT next command to run.
  if (args.flat) await printNextStep(args.root);
  return replayExitCode(artifact, args.strictVisual);
}

/**
 * Which trace this `replay` drives. An EXPLICIT `--id` is returned untouched, so every
 * existing invocation walks the same path it always did; everything below is reached only
 * when nobody named a trace. Returns null after printing the refusal when there is nothing
 * to pick.
 *
 * WHY `replay` AND `approve` DEFAULT AND `tolerance` / `mask` NEVER WILL. `tolerance` and
 * `mask` WIDEN the gate on an existing anchor, which is the most dangerous class of change
 * this tool makes: it leaves a verdict standing that nobody consented to and that no later
 * output ever contradicts, so it should always name its target. `replay` and `approve` are
 * different in kind. Both act on the run the operator just produced, both announce the pick
 * out loud before doing anything, and both are re-runnable against an explicit `--id` if the
 * pick was wrong. Do NOT "simplify" this asymmetry away by extending the default to the two
 * widening verbs: it is the point, not an oversight.
 *
 * The two defaults select from DIFFERENT directories, deliberately: see
 * {@link resolveApproveTargetId}.
 *
 * Precedence, and `--trace` comes FIRST for a reason: it names an exact file, which is the
 * strongest statement of intent available, so the most-recent search must not run at all.
 */
async function resolveReplayTargetId(
  paths: ReplayLayout,
  args: TraceArgs,
): Promise<string | null> {
  if (args.id) return args.id;

  if (args.tracePath !== undefined) {
    // With `--trace` and no `--id`, the trace NAMES ITSELF: its own `id` field becomes the
    // output name, which is exactly what `--id <that id>` would have produced (and
    // `parseTrace` has already proven it is a safe path segment). Deriving from the FILENAME
    // instead would let a copied file write its report under a name the trace disagrees with.
    // The file is read again by `replayOneTrace`; a trace is small, and the alternative is
    // threading an already-parsed trace through the path `replay-all` shares.
    const trace = parseTrace(JSON.parse(await fs.readFile(args.tracePath, "utf8")));
    console.error(
      `[loombridge trace] no --id given, replaying "${trace.id}" from ${args.tracePath}.`,
    );
    return trace.id;
  }

  const recent = await mostRecentTraceId(paths.replayTraces);
  if (recent === null) {
    // REFUSE HERE, not in the loader. Falling through with an empty id would read
    // `traces/.trace.json` and report "no such file", which names a path nobody typed and
    // says nothing about what to do next.
    console.error(
      `[loombridge trace] no --id given and no traces in ` +
        `${path.relative(args.root, paths.replayTraces)}/: there is nothing to replay.`,
    );
    console.error(
      "[loombridge trace]   record one first: `loombridge trace record` (then bare `loombridge trace " +
        "replay` replays it), or point at an existing trace with --id <id> / --trace <path>.",
    );
    return null;
  }
  console.error(`[loombridge trace] no --id given, replaying the most recent trace "${recent}".`);
  return recent;
}

/**
 * The most recently recorded trace under `dir`, or null when there is none.
 *
 * "Most recent" is the newest FILE MTIME among `<id>.trace.json`, because that is what
 * "the one I just recorded" means to the human typing this: `record` wrote it seconds ago.
 * Ties break by NAME, and only ids `discoverTraces` accepts are candidates: see
 * {@link mostRecentIdByMtime}, which both defaults share. Exported for unit tests.
 */
export async function mostRecentTraceId(dir: string): Promise<string | null> {
  return await mostRecentIdByMtime(dir, await discoverTraces(dir), ".trace.json");
}

/**
 * The most recently REPLAYED run under `dir`, or null when there is none: the `approve`
 * half of the same idea, and the ONE place the two defaults differ (see
 * {@link resolveApproveTargetId} for why it is reports rather than traces).
 *
 * Same recency rule and the same explicit name tie-break as {@link mostRecentTraceId},
 * because they are the same rule: both call {@link mostRecentIdByMtime} rather than
 * restating it, so "ties break by name" cannot come to mean two things in one file.
 * Exported for unit tests.
 */
export async function mostRecentReportId(dir: string): Promise<string | null> {
  return await mostRecentIdByMtime(dir, await discoverReports(dir), ".report.json");
}

/**
 * The newest of `ids` by the mtime of `<dir>/<id><suffix>`, or null when none can be
 * stat'ed. Shared by the `replay` and `approve` defaults.
 *
 * TIES BREAK BY NAME, and that is a correctness requirement rather than tidiness. A fresh
 * `git clone` (or a copied workspace) writes every file in one burst, so identical mtimes are
 * the normal case, not the exotic one. An arbitrary pick that varies between two runs of the
 * same command would be worse than a wrong-but-stable one: it makes "replay, then look at the
 * report" unreproducible for the operator AND for whoever reads the report afterwards. Name
 * order is stable, so the same directory always yields the same choice.
 *
 * Only ids the caller's discovery accepted are candidates, and both discoveries filter on
 * `isSafePathSegment`, so the winner is always a safe path segment.
 */
async function mostRecentIdByMtime(
  dir: string,
  ids: string[],
  suffix: string,
): Promise<string | null> {
  const stamped: { id: string; mtimeMs: number }[] = [];
  for (const id of ids) {
    try {
      const stat = await fs.stat(path.join(dir, `${id}${suffix}`));
      stamped.push({ id, mtimeMs: stat.mtimeMs });
    } catch {
      // Unreadable or gone between the listing and the stat: not a candidate. A file
      // whose mtime cannot be read has no claim to being the most recent one.
    }
  }
  if (stamped.length === 0) return null;
  // The name comparison is the EXPLICIT tie-break, not a side effect of the input order:
  // relying on the discovery's sorting plus a stable sort would make this correct by
  // coincidence, and one refactor of the discovery order away from being correct at all.
  stamped.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return stamped[0]!.id;
}

/**
 * Pick the trace id for a recording that was given no `--id`, from the scene the recorder
 * RESOLVED (so the id names what was actually recorded).
 *
 * A DERIVED id never overwrites: on `<derived>.trace.json` already existing it takes
 * `<derived>-2`, `-3`, … and says so, loudly, because nobody typed this name and a silent
 * overwrite of a trace someone recorded earlier is the one outcome that cannot be undone.
 * An EXPLICIT `--id` is untouched by this and still overwrites: that is the developer
 * saying which trace they mean, and `approve` binds `traceSha256` so a stale baseline
 * cannot grade a changed trace anyway.
 */
async function deriveRecordId(paths: ReplayLayout, scenePath: string): Promise<string> {
  const base = traceIdFromScenePath(scenePath);
  if (base === null) {
    throw new Error(
      `record: cannot derive a trace id from scene "${scenePath}". Pass --id <name> explicitly.`,
    );
  }
  let chosen = base;
  for (let n = 2; await fileExists(path.join(paths.replayTraces, `${chosen}.trace.json`)); n += 1) {
    chosen = `${base}-${n}`;
  }
  console.error(`[loombridge trace] no --id given, recording as "${chosen}" (from ${scenePath}).`);
  if (chosen !== base) {
    console.error(
      `[loombridge trace] "${base}" already exists and was left untouched; ` +
        `re-record it with: --id ${base}`,
    );
  }
  return chosen;
}

async function fileExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Record a human demonstration into a replayable trace. Resets to a clean
 * Play-Mode start at `--scene` (or the editor's current scene), observes the human's
 * clicks/drags until they signal done (press Enter, or `--duration <sec>`), captures any
 * `--outcomes`, and writes `.loombridge/replays/traces/<id>.trace.json` (green by
 * construction). With no `--id`, the id is derived from the recorded scene.
 */
async function runRecord(args: TraceArgs, opts: TraceRunOpts = {}): Promise<number> {
  const paths = layoutFor(args);
  const meta: ObserveTraceMeta = {
    // Empty when no --id was given ⇒ observeRecordLive calls `resolveId` below with the
    // RESOLVED scene (the only place both facts exist at once).
    id: args.id,
    // Empty when no --scene was given ⇒ recordObservedTrace resolves the editor's active scene (#295).
    scene: args.scene ?? "",
    ...(args.title ? { title: args.title } : {}),
    ...(args.intent ? { intent: args.intent } : {}),
    // The declared state signal (already validated/split in parseArgs): observe_start
    // samples it per gesture and the transform gates each gesture on it.
    ...(args.stateSignal ? { stateSignal: args.stateSignal } : {}),
    // Phase 2 / D1-B: auto-detect each scene's signal live. Default ON, and it overrides a
    // declared signal only when the developer asked for it (see `resolveAutoStateSignal`).
    ...(args.autoStateSignal ? { autoDetectStateSignal: true } : {}),
  };
  const outcomes = await loadOutcomes(args.outcomesPath);

  const timed = args.durationSec !== undefined;
  const baseStop = timed
    ? async () => {
        console.error(`[loombridge trace] recording for ${args.durationSec}s — play your flow now…`);
        await sleep(args.durationSec! * 1000);
      }
    : () =>
        // "then press Enter" only, because by the time this prints the recorder has already told
        // the human to click Unity and confirmed that recording actually started (see the
        // onNotice wiring below). Telling them to switch to Unity here as well would repeat an
        // instruction they have already acted on to get this far.
        readEnter(
          "[loombridge trace] ▶ Play your flow in Unity, then press Enter here to stop… ",
        );
  // Race the stop signal against Ctrl-C so a cancel still runs cleanup (the
  // `finally` in observeRecordLive stops Play and returns the editor to edit mode)
  // rather than stranding the editor in Play Mode.
  const waitForStop = withSigintCancel(baseStop);

  // State intent, not a completed action: the connection has not been attempted yet, and
  // announcing "resetting" before it exists reads as a step that never happened when the
  // editor is unreachable (S1 final test, LOW-3).
  console.error(
    `[loombridge trace] recording ${args.id ? `"${args.id}"` : "(id derived from the recorded scene)"}: connecting to Unity, then resetting ${args.scene ?? "the current scene"} to a clean Play-Mode start…`,
  );
  const { trace, droppedNoTarget, droppedUnfocused, droppedOsModifier } = await observeRecordLive(meta, {
    waitForStop,
    outcomes,
    projectPathCanonical: resolveCliProjectPin({ root: args.root }),
    // The recorder's own human-facing lines ("click the Unity window now", then whether
    // recording really started), prefixed like every other line this verb prints.
    onNotice: (message: string) => console.error(`[loombridge trace] ${message}`),
    // Passed ONLY when no --id was typed, so the explicit path provably never reaches the
    // derivation (and never gets collision-suffixed).
    ...(args.id ? {} : { resolveId: (scenePath: string) => deriveRecordId(paths, scenePath) }),
    ...(opts.clientFactory ? { client: opts.clientFactory() } : {}),
  });
  // The id the trace was actually built with: `args.id` when one was typed, the derived one
  // otherwise. Reading it back off the trace means the file name and the trace's own `id`
  // can never disagree.
  const traceId = trace.id;

  await fs.mkdir(paths.replayTraces, { recursive: true });
  const traceFile = path.join(paths.replayTraces, `${traceId}.trace.json`);
  await fs.writeFile(traceFile, `${JSON.stringify(trace, null, 2)}\n`, "utf-8");

  // WHAT WAS DEMONSTRATED, not how the transform packaged it. `trace.segments.length`
  // is the segment count, which equals the gesture count only on the pointer path; the
  // merged keyboard timeline is one segment, so it reported "1 step(s)" for a 62-action
  // recording. See `traceDemonstration`.
  const shape = traceDemonstration(trace);
  const outcomeCount = trace.assertions?.length ?? 0;
  // Honest, not silent: input the observer saw but did not record (inert target, a tap the editor
  // swallowed while the Game view was unfocused, or a Cmd/Win press that was window-manager input)
  // is reported, not a mystery.
  for (const notice of observeDropNotices({ droppedNoTarget, droppedUnfocused, droppedOsModifier })) {
    console.error(notice);
  }
  // Loud, before the success line: a trace that captures fewer frames than the human
  // demonstrated gestures freezes a baseline that guards almost none of them.
  for (const notice of captureCoverageNotices(shape)) {
    console.error(notice);
  }
  console.error(
    `[loombridge trace] recorded "${traceId}": ${shape.gestures} gesture(s), ${shape.keyEdges} key edge(s), ` +
      `${shape.captures} capture(s), ${outcomeCount} outcome(s) → ${path.relative(args.root, traceFile)}`,
  );
  // In the mini-game workspace flow (--flat), print the EXACT next command to run (capture).
  // Otherwise give the generic replay hint (the standard-layout trace flow).
  if (args.flat) {
    await printNextStep(args.root);
  } else {
    // `traceId`, never `args.id`: with no --id typed the latter is EMPTY, and this line was
    // printing `trace replay --id ` with nothing after it. Bare `trace replay` now replays
    // the most recent trace, which is this one, so both halves of the hint are runnable.
    console.error(
      `[loombridge trace] replay it: loombridge trace replay (or --id ${traceId} to name it).`,
    );
  }
  return 0;
}

/** Load + validate an `OutcomeSpec[]` JSON file (record `--outcomes`). */
async function loadOutcomes(outcomesPath?: string): Promise<OutcomeSpec[]> {
  if (!outcomesPath) return [];
  const parsed = JSON.parse(await fs.readFile(outcomesPath, "utf8")) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`record: --outcomes file must be a JSON array of outcome specs (${outcomesPath})`);
  }
  // Shape-check the required fields here for a clear error, rather than a confusing
  // bridge round-trip (captureOutcomes still enforces readability at capture time).
  return parsed.map((spec, i) => {
    const s = spec as Partial<OutcomeSpec> | null;
    if (!s || typeof s !== "object" || typeof s.id !== "string" || !s.locator?.path || typeof s.property_path !== "string") {
      throw new Error(
        `record: --outcomes[${i}] must have { id, locator.path, property_path } (${outcomesPath})`,
      );
    }
    return s as OutcomeSpec;
  });
}

/** Wrap a stop signal so Ctrl-C rejects it — the caller's `finally` then cleans up. */
function withSigintCancel(signal: () => Promise<void>): () => Promise<void> {
  return () =>
    new Promise<void>((resolve, reject) => {
      const onSigint = () => {
        cleanup();
        reject(
          new Error("record: cancelled (Ctrl-C) — stopping the recorder and returning to edit mode."),
        );
      };
      const cleanup = () => process.off("SIGINT", onSigint);
      // A SECOND Ctrl-C (no handler installed) hard-terminates as usual — escape hatch.
      process.once("SIGINT", onSigint);
      signal().then(
        () => {
          cleanup();
          resolve();
        },
        (err) => {
          cleanup();
          reject(err);
        },
      );
    });
}

/**
 * Resolve when the human presses Enter — the CLI's first interactive pause.
 * REFUSES a non-TTY stdin (CI / `< /dev/null`): there's no human to press Enter,
 * and listening for `data` alone would hang forever holding Play Mode open — use
 * `--duration` for non-interactive recording. Also resolves on EOF (`end`).
 */
export function readEnter(prompt: string): Promise<void> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    return Promise.reject(
      new Error("record: stdin is not a TTY — pass --duration <sec> for non-interactive recording."),
    );
  }
  return new Promise((resolve) => {
    process.stderr.write(prompt);
    const done = () => {
      stdin.off("data", done);
      stdin.off("end", done);
      try {
        stdin.pause(); // let the process exit after we're done reading
      } catch {
        /* best-effort */
      }
      resolve();
    };
    stdin.once("data", done);
    stdin.once("end", done); // EOF stops rather than hanging
    try {
      stdin.resume();
    } catch {
      /* best-effort */
    }
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Replay one trace and write its per-trace report + html. Shared by replay + replay-all. */
/**
 * Scale a trace's capture settles for a paced replay: each recorded human inter-action
 * gap divides by `speed`, floored at {@link MIN_SCALED_SETTLE_MS} so the game still
 * renders a stable frame before capture. Pure; exported for unit tests. Non-capture
 * actions and wait-for-visible timeouts are NOT scaled: readiness gates are about the
 * game, not the human's pacing.
 *
 * BOTH PLACES A SETTLE CAN LIVE are scaled, and they have to be: a settle is a settle
 * whether it sits on a segment's trailing `captures` or on an INTERLEAVED `{ do: "capture" }`
 * action in the middle of a merged keyboard timeline. Scaling only the first would leave a
 * `--speed 4` run holding every interleaved settle at its recorded length while the report
 * stamped `replaySpeed: 4`, and a baseline approved from it would claim a pacing the frames
 * were never taken at.
 */
export function scaleTraceSettles<
  T extends {
    segments: {
      actions?: { do: string; settleMs?: number }[];
      captures?: { settleMs?: number }[];
    }[];
  },
>(trace: T, speed: number): T {
  if (speed <= 1) return trace;
  const scale = (holder: { settleMs?: number }): void => {
    if (typeof holder.settleMs === "number") {
      holder.settleMs = Math.max(MIN_SCALED_SETTLE_MS, holder.settleMs / speed);
    }
  };
  for (const segment of trace.segments) {
    for (const action of segment.actions ?? []) {
      if (action.do === "capture") scale(action);
    }
    for (const capture of segment.captures ?? []) scale(capture);
  }
  return trace;
}

/**
 * The pacing a replay must run at: the EXPLICIT `--speed` when given, else the pacing the
 * baseline was approved at (its frames were captured at that pacing, and comparing across
 * pacings reads animation phase skew as drift), else 1. An explicit speed that CONTRADICTS
 * a stamped baseline refuses before the editor is touched: the operator asked for a
 * comparison the anchor cannot honestly make. Re-approve at the new pacing instead.
 */
async function resolveReplaySpeed(
  paths: ReplayLayout,
  id: string,
  explicit: number | undefined,
): Promise<{ speed: number }> {
  const baselineDir = path.join(paths.replayBaselines, id);
  const manifest = await loadTraceBaselineManifest(baselineDir);
  const stamped =
    manifest !== null && !isTraceBaselineManifestError(manifest) ? (manifest.replaySpeed ?? 1) : undefined;
  if (explicit !== undefined && stamped !== undefined && explicit !== stamped) {
    // An explicit pacing that contradicts the stamped baseline still RUNS (the replay is
    // how a report at the new pacing comes to exist, and refusing here would make
    // re-pacing impossible without hand-deleting the baseline), but the pixel gate for
    // this run is a harness fault, announced up front and again by applyVisualDiff.
    // The mismatch is ANNOUNCED HERE and nowhere else: `applyVisualDiff` re-derives it from
    // the manifest and the artifact at grade time, so a `mismatchWith` field on the way out
    // would be a second copy of the same fact that no caller reads. (It was exactly that: a
    // returned field nothing consumed, which reads to the next author like a wired signal.)
    console.error(
      `[loombridge trace] pacing differs from the baseline (approved ${stamped}x, running ${explicit}x): ` +
        `the pixel gate is NOT graded this run; approve from this report to re-anchor at ${explicit}x.`,
    );
    return { speed: explicit };
  }
  return { speed: explicit ?? stamped ?? 1 };
}

/**
 * The CLOCK DISCIPLINE a replay must run under, resolved exactly the way the pacing is: the
 * EXPLICIT flag when given, else the discipline the baseline was approved under, else the
 * legacy wall-clock settle. Frames captured under different disciplines sit at different
 * animation phases, so a baseline stamped `alignedCaptureFps: 60` asks for its replays to be
 * aligned at 60 and gets them without the operator having to remember.
 *
 * An explicit value that CONTRADICTS the stamp still RUNS (the replay is how a report under
 * the new discipline comes to exist, and refusing here would make re-anchoring impossible
 * without hand-deleting the baseline), but this run's pixel gate is a harness fault,
 * announced up front and again by `applyVisualDiff`.
 *
 * EXPORTED FOR TESTS. The inheritance rule ("default: the baseline's stamped capture clock")
 * is a claim the `--aligned` help makes to operators, and the only other way to reach it is a
 * live replay against a running editor.
 */
export async function resolveAlignedCaptureFps(
  paths: ReplayLayout,
  id: string,
  explicit: number | undefined,
): Promise<{ fps?: number }> {
  const baselineDir = path.join(paths.replayBaselines, id);
  const manifest = await loadTraceBaselineManifest(baselineDir);
  const stamped = manifest !== null && !isTraceBaselineManifestError(manifest) ? manifest : null;
  // A manifest that EXISTS pins a discipline even when the field is absent: absent means
  // wall-clock, which is a real answer and not "no opinion".
  const stampedFps = stamped === null ? undefined : (stamped.alignedCaptureFps ?? "wall-clock");
  if (explicit === undefined) {
    return typeof stampedFps === "number" ? { fps: stampedFps } : {};
  }
  if (stampedFps !== undefined && stampedFps !== explicit) {
    // Announced here, re-derived at grade time from the manifest and the artifact. The
    // mismatch is deliberately NOT returned: a second copy of a fact `applyVisualDiff`
    // computes for itself would be a field nothing reads, dressed as a wired signal.
    const stampedText = stampedFps === "wall-clock" ? "wall-clock (unaligned)" : `aligned ${stampedFps} fps`;
    console.error(
      `[loombridge trace] capture clock differs from the baseline (approved ${stampedText}, running aligned ` +
        `${explicit} fps): the pixel gate is NOT graded this run; approve from this report to re-anchor.`,
    );
    return { fps: explicit };
  }
  return { fps: explicit };
}

async function replayOneTrace(
  paths: ReplayLayout,
  id: string,
  opts: {
    tracePath?: string;
    html: boolean;
    projectPathCanonical?: string;
    speed?: number;
    alignedCaptureFps?: number;
    /** Test seam: the live client this replay drives (see `RunLiveReplayOptions`). */
    clientFactory?: RunLiveReplayOptions["clientFactory"];
  },
): Promise<{ artifact: ReplayRunArtifact; reportJson: string; htmlPath?: string }> {
  await fs.mkdir(paths.replayTraces, { recursive: true });
  await fs.mkdir(paths.replayReports, { recursive: true });

  const traceFile = opts.tracePath ?? path.join(paths.replayTraces, `${id}.trace.json`);
  const trace = parseTrace(JSON.parse(await fs.readFile(traceFile, "utf8")));
  if (trace.id !== id) {
    console.error(
      `[loombridge trace] warning: trace id "${trace.id}" != "${id}"; using "${id}" for output paths.`,
    );
  }

  const resolved = await resolveReplaySpeed(paths, id, opts.speed);
  const speed = resolved.speed;
  // RESOLVED BEFORE THE PACING LINE PRINTS, applied after: the clock decides what the floor
  // in that line actually means, and the CONVERSION to frames still happens in the driver,
  // AFTER scaleTraceSettles. So `--speed` divides the milliseconds exactly once. Converting
  // first and scaling after (or scaling both) would settle for a quarter of the stated time
  // at 4x while the report claimed the trace's own settle.
  const aligned = await resolveAlignedCaptureFps(paths, id, opts.alignedCaptureFps);
  if (speed > 1) {
    scaleTraceSettles(trace, speed);
    // THE FLOOR IS PRINTED AS THE RUN WILL EXPERIENCE IT. Under an aligned clock the floor
    // is a frame count, so its game-time cost is quantized to 1/fps and only equals the
    // wall-clock constant when the constant divides evenly by a frame (250ms is exactly 15
    // frames at 60 fps, but 8 frames at 30 fps: 266.7ms). Printing the constant there would
    // state a number this run never used.
    const floorText =
      aligned.fps === undefined
        ? `floor ${MIN_SCALED_SETTLE_MS}ms`
        : `floor ${alignedSettleFrames(MIN_SCALED_SETTLE_MS, aligned.fps)} frame(s) = ` +
          `${round1(alignedFloorMs(MIN_SCALED_SETTLE_MS, aligned.fps))}ms of game time at ${aligned.fps} fps`;
    console.error(`[loombridge trace] replaying at ${speed}x pacing (recorded settles scaled, ${floorText}).`);
  }

  if (aligned.fps !== undefined) {
    console.error(
      `[loombridge trace] capture-aligned replay at ${aligned.fps} fps: each settle runs inside the bridge's ` +
        "pinned tick loop and the frame is taken on the frame the settle completes.",
    );
  }

  const captureDir = path.join(paths.replayReports, id, "actual");
  const artifact = await runLiveReplay(trace, {
    captureDir,
    projectPathCanonical: opts.projectPathCanonical,
    ...(opts.clientFactory ? { clientFactory: opts.clientFactory } : {}),
    ...(aligned.fps !== undefined ? { alignedCaptureFps: aligned.fps } : {}),
  });
  // The pacing is part of the evidence: a baseline approved from this report inherits it,
  // and applyVisualDiff refuses a pacing mismatch instead of grading phase skew.
  artifact.replaySpeed = speed;
  // The clock discipline is part of the evidence, exactly as the pacing is: a baseline
  // approved from this report inherits it, and applyVisualDiff refuses a mismatch instead of
  // grading frames captured under two different clocks.
  if (aligned.fps !== undefined) artifact.alignedCaptureFps = aligned.fps;
  // Visual regression: compare each capture to its approved baseline (if any).
  await applyVisualDiff(paths, id, artifact);

  const reportJson = path.join(paths.replayReports, `${id}.report.json`);
  const body = `${JSON.stringify(artifact, null, 2)}\n`;
  await fs.writeFile(reportJson, body, "utf-8");
  // THE PAIR ON DISK ALWAYS DESCRIBES ONE RUN, and the rule lives HERE, at the single
  // place `<id>.report.json` is written, rather than in each caller.
  //
  // The defect this closes, observed on a real project: `verify --live` re-drove a trace,
  // graded it red and rewrote the JSON, but rendered no HTML, so the `.report.html` beside
  // it was still the GREEN page an earlier `trace replay` had left. Nothing on that page
  // said it was stale, and it is the artifact a human actually opens: the reader sees green
  // frames under a failing verdict and concludes the failure was spurious. A missing file
  // is a dead end; a stale one is a wrong answer.
  //
  // So either this run RE-RENDERS the page (bound to the bytes just written), or the older
  // page is REMOVED. There is no third branch in which a page from another run survives.
  const htmlPath = opts.html
    ? await writeHtmlReport(paths, id, artifact, sha256(body))
    : await removeStaleHtmlReport(paths, id);
  return { artifact, reportJson, htmlPath };
}

/**
 * Delete the previous run's `<id>.report.html`, and SAY SO.
 *
 * `--no-html` is a request to spend no time rendering, never a request to leave the last
 * run's verdict standing next to this one's JSON. The line is printed here rather than by
 * a caller so no future call site can drop it: a silent deletion would surprise a human who
 * had that page open, and a silent SKIP would be the original bug wearing a flag.
 *
 * Returns `undefined` always (this path renders nothing); the removal is announced, not
 * returned, because no caller has anything to point a reader at afterwards.
 */
async function removeStaleHtmlReport(paths: ReplayLayout, id: string): Promise<undefined> {
  const htmlPath = path.join(paths.replayReports, `${id}.report.html`);
  try {
    await fs.rm(htmlPath, { force: false });
  } catch {
    return undefined; // Nothing there (the common case), or nothing we may remove.
  }
  console.error(
    `[loombridge trace] removed the stale ${id}.report.html: it rendered the PREVIOUS run, and ` +
      `--no-html means none was rendered for this one. Re-render with: loombridge trace report --id ${id}`,
  );
  return undefined;
}

/** Replay every trace under `.loombridge/replays/traces/` and write a roll-up report. */
async function runReplayAll(args: TraceArgs): Promise<number> {
  const paths = layoutFor(args);
  if (args.id) {
    console.error(`[loombridge trace] note: replay-all ignores --id (it runs the whole fleet).`);
  }
  const ids = await discoverTraces(paths.replayTraces);
  if (ids.length === 0) {
    console.error(
      `[loombridge trace] no traces in ${path.relative(args.root, paths.replayTraces)}/ — record or author one first.`,
    );
    return 1;
  }

  console.error(`[loombridge trace] replaying ${ids.length} trace(s)…`);
  const results: FleetTraceResult[] = [];
  // Worst tier across the fleet, computed by the SAME `replayExitCode` the single
  // replay door uses, so the two doors cannot disagree about what blocked or an
  // unreadable capture means (2 beats 1 beats 0).
  let worstExit = 0;
  for (const id of ids) {
    try {
      const { artifact, reportJson, htmlPath } = await replayOneTrace(paths, id, {
        html: args.html,
        projectPathCanonical: resolveCliProjectPin({ root: args.root }),
      });
      worstExit = Math.max(worstExit, replayExitCode(artifact, args.strictVisual));
      results.push({
        id,
        status: artifact.status,
        blockedReason: artifact.blockedReason,
        visualDrift: artifact.visualDrift ?? false,
        visualHarnessFault: artifact.visualHarnessFault ?? false,
        firstDivergence: artifact.firstDivergence
          ? { kind: artifact.firstDivergence.kind, segment: artifact.firstDivergence.segment }
          : undefined,
        durationMs: artifact.durationMs,
        report: path.relative(paths.replays, htmlPath ?? reportJson),
      });
      const drift = artifact.visualDrift ? " +drift" : "";
      console.error(`[loombridge trace]   ${id}: ${artifact.status.toUpperCase()}${drift}`);
    } catch (error) {
      // A bad trace (malformed JSON) or a bridge hiccup must NOT abort the fleet
      // and discard the roll-up — record it as a failed trace and carry on. (A
      // dead bridge will recur per trace; short-circuiting that is a follow-on.)
      const detail = message(error);
      results.push({ id, status: "fail", visualDrift: false, error: detail, durationMs: 0, report: "" });
      worstExit = Math.max(worstExit, 1);
      console.error(`[loombridge trace]   ${id}: ERROR — ${detail}`);
    }
  }

  const fleet = summarizeFleet(results, new Date().toISOString());
  const fleetJson = path.join(paths.replays, "fleet.report.json");
  await fs.writeFile(fleetJson, `${JSON.stringify(fleet, null, 2)}\n`, "utf-8");
  let fleetReport = fleetJson;
  if (args.html) {
    const fleetHtml = path.join(paths.replays, "fleet.report.html");
    await fs.writeFile(fleetHtml, renderFleetReportHtml(fleet), "utf-8");
    fleetReport = fleetHtml;
  }

  const c = fleet.counts;
  const unreadable = results.filter((r) => r.visualHarnessFault).length;
  console.error(
    `[loombridge trace] fleet: ${fleet.status.toUpperCase()}: ${c.pass}/${c.total} pass, ${c.fail} fail, ${c.blocked} blocked, ${c.drift} drift` +
      (unreadable > 0 ? `, ${unreadable} unreadable capture(s)` : ""),
  );
  console.error(`[loombridge trace] fleet report → ${path.relative(args.root, fleetReport)}`);

  return worstExit;
}

/** Discover trace ids from `<dir>/<id>.trace.json` (safe ids only). Exported for tests. */
export async function discoverTraces(dir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  return entries
    .filter((f) => f.endsWith(".trace.json"))
    .map((f) => f.slice(0, -".trace.json".length))
    .filter((id) => isSafePathSegment(id))
    .sort();
}

/**
 * Discover replayed-run ids from `<dir>/<id>.report.json` (safe ids only), the `approve`
 * counterpart of {@link discoverTraces}.
 *
 * The suffix is the whole filter, and it is enough: `<id>.report.json` under the reports
 * directory is written by exactly one thing, `replayOneTrace`. The fleet roll-up lives one
 * level up (`<replays>/fleet.report.json`, never inside `reports/`), and the flat mini-game
 * workspace shares this directory with `minigame-verification.json`, which the suffix
 * excludes. Exported for tests.
 */
export async function discoverReports(dir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  return entries
    .filter((f) => f.endsWith(".report.json"))
    .map((f) => f.slice(0, -".report.json".length))
    .filter((id) => isSafePathSegment(id))
    .sort();
}

/**
 * Exit code for a replay run, in the product's three tiers: 0 pass, 1 game defect,
 * 2 harness fault / capture gap.
 *
 * `blocked` is the HARNESS tier, not the game tier: it means replay could not drive
 * the trace at all (an unsupported input backend, a reset it could not perform), so
 * it never produced an opinion about the game, so reporting it as 1 miscasts a missing
 * capability as a regression. A PNG that could not be decoded
 * (`visualHarnessFault`) is the same shape and tiers the same way.
 *
 * A real perceptual drift keeps its meaning: a WARNING by default (GPU/AA noise
 * shouldn't fail CI), promoted to a game-tier failure (1) by `--strict-visual`.
 *
 * Pure + exported for unit tests; the fleet door calls this same function so the two
 * doors cannot drift apart.
 */
export function replayExitCode(
  artifact: Pick<ReplayRunArtifact, "status" | "visualDrift" | "visualHarnessFault">,
  strictVisual: boolean,
): number {
  if (artifact.status === "blocked") return 2;
  if (artifact.visualHarnessFault) return 2;
  if (artifact.status !== "pass") return 1;
  if (artifact.visualDrift && strictVisual) return 1;
  return 0;
}

/**
 * Which RUN this `approve` freezes. An EXPLICIT `--id` is returned untouched, so every
 * existing invocation walks the same path it always did; the search below is reached only
 * when nobody named a run. Returns null after printing the refusal when there is nothing
 * to pick.
 *
 * THE SEARCH IS OVER REPORTS, NOT TRACES, and that is the whole difference from
 * {@link resolveReplayTargetId}. `approve` promotes the captures of a COMPLETED RUN, so the
 * referent of "the one I mean" is "the thing I just replayed", and a report is the only
 * evidence that a replay happened at all. Reusing the trace-based search would happily pick
 * a trace that was recorded and never replayed, and then fail with "no report at
 * reports/<id>.report.json" for an id nobody typed: a confusing answer to a question the
 * operator never asked. Do NOT collapse the two searches into one.
 */
async function resolveApproveTargetId(
  paths: ReplayLayout,
  args: TraceArgs,
): Promise<string | null> {
  if (args.id) return args.id;

  const recent = await mostRecentReportId(paths.replayReports);
  if (recent === null) {
    // REFUSE HERE, not in the loader. Falling through with an empty id would read
    // `reports/.report.json` and report "no such file", which names a path nobody typed and
    // says nothing about what to do next.
    console.error(
      `[loombridge trace] no --id given and no replay reports in ` +
        `${path.relative(args.root, paths.replayReports)}/: there is nothing to approve.`,
    );
    console.error(
      "[loombridge trace]   replay one first: `loombridge trace replay` (then bare `loombridge trace " +
        "approve` freezes that run), or name a run with --id <id>.",
    );
    return null;
  }
  console.error(`[loombridge trace] no --id given, approving the most recent run "${recent}".`);
  return recent;
}

/** Promote the latest run's captures to the approved baseline for this trace. */
async function runApprove(args: TraceArgs): Promise<number> {
  const paths = layoutFor(args);
  const id = await resolveApproveTargetId(paths, args);
  // Nothing to approve, and the refusal has already been printed. Exit 2, NOT 1: the tier
  // is the one `--id <id> is required` used to exit with on this exact argv, and no anchor
  // was touched, so the game-defect tier (1) would be a verdict about nothing. A report
  // MISSING for an id the operator NAMED is a different fact and keeps its own tier below.
  if (id === null) return 2;
  const reportJson = path.join(paths.replayReports, `${id}.report.json`);
  const rel = path.relative(args.root, reportJson);

  let raw: string;
  try {
    raw = await fs.readFile(reportJson, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      console.error(`[loombridge trace] no report at ${rel} — run 'trace replay --id ${id}' first.`);
      return 1;
    }
    throw error;
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!isReplayRunArtifact(parsed)) {
    console.error(`[loombridge trace] ${rel} is not a valid replay report.`);
    return 1;
  }

  // WHAT IS ABOUT TO BE FROZEN, not just its name. This is the consent moment for an
  // anchor, and a name alone does not tell the operator the SIZE of what they are freezing:
  // "the most recent run" reads the same whether it holds one frame or forty. Printed only
  // on the DEFAULTED path, because that is the path where the tool chose the target rather
  // than the human; an explicit `--id` prints exactly what it always did.
  if (!args.id) {
    const promotable = parsed.segments
      .flatMap((s) => s.captures)
      .filter((c) => c.artifact !== undefined).length;
    console.error(
      `[loombridge trace]   that run holds ${promotable} capture(s), and approving freezes them as the ` +
        `approved baseline for "${id}".`,
    );
  }

  // An approval is a PROVENANCE record, not just a file copy: it has to say which
  // demonstration these frames belong to. Read the trace bytes first and refuse
  // (harness tier) if they are gone: a baseline that cannot name its trace is not
  // an anchor, and unified `verify` would have to treat it as unstamped anyway.
  const traceFile = path.join(paths.replayTraces, `${id}.trace.json`);
  let traceSha256: string;
  try {
    traceSha256 = sha256(await fs.readFile(traceFile));
  } catch (error) {
    console.error(
      `[loombridge trace] cannot approve "${id}": its trace is unreadable at ` +
        `${path.relative(args.root, traceFile)} (${message(error)}). An approved baseline must bind to the demonstration it froze.`,
    );
    return 2;
  }

  const baselineDir = path.join(paths.replayBaselines, id);

  // The approved TOLERANCE survives a re-freeze (A1). Approve replaces frames, and the
  // tolerance is a separate human decision about this trace's animation, so silently
  // resetting it to the default here would mean every re-approve quietly re-tightened a
  // gate the operator had consented to widen, and the next replay would fail with a
  // suggestion to widen it again. An UNREADABLE previous manifest carries nothing
  // forward and says so: a tolerance nobody can read is not a tolerance anybody approved.
  const previousLoaded = await loadTraceBaselineManifest(baselineDir);
  let previous: TraceBaselineManifest | null = null;
  if (isTraceBaselineManifestError(previousLoaded)) {
    // NAME EVERY TERM THAT IS BEING DROPPED, not just the tolerance (BX4). An unreadable
    // manifest carries NOTHING forward, and the note used to mention one of the four things
    // being lost, which reads as "only the tolerance resets". A mask set an operator
    // approved, a pacing, and a capture clock all vanish in the same breath, and the next
    // replay will grade (or refuse) on terms nobody restated.
    console.error(
      `[loombridge trace] note: the existing ${TRACE_BASELINE_MANIFEST} is unreadable ` +
        `(${previousLoaded.error}); re-stamping from scratch. NOTHING is carried forward: the drift ` +
        "tolerance resets to the default, every approved mask is dropped, and the pacing and capture " +
        "clock are re-derived from this report alone. Re-state any of them you still want.",
    );
  } else {
    previous = previousLoaded;
  }

  // F13: NEVER PROMOTE A RUN WITH A CAPTURE GAP. `unreadable` is the harness tier (a PNG
  // that could not be decoded says nothing about the game), and freezing that run's frames
  // would mint an anchor from evidence the tool itself could not read. Refused as a whole
  // rather than per-capture: promoting the readable subset would prune the rest and quietly
  // shrink the baseline, which reads as "approved" while covering less than it did before.
  const unreadable = parsed.segments
    .flatMap((s) => s.captures)
    .filter((c) => c.visualStatus === "unreadable")
    .map((c) => c.id);
  if (unreadable.length > 0) {
    console.error(
      `[loombridge trace] cannot approve "${id}": ${unreadable.length} capture(s) in the latest run ` +
        `could not be decoded (${unreadable.join(", ")}). A capture gap is a harness fault, never an anchor.`,
    );
    console.error(
      `[loombridge trace]   re-run \`loombridge trace replay --id ${id}\`; if the APPROVED BASELINE is the ` +
        `unreadable half (the replay output names which), remove ${path.relative(args.root, baselineDir)} and approve again.`,
    );
    return 2;
  }

  // BX1: A RUN WITH A CAPTURE-LEVEL HARNESS FAULT IS NOT AN ANCHOR, whole-run, the F13
  // shape. THE PRUNE-TO-PERMANENT-GREEN path: a capture whose settle never completed has no
  // artifact, so the copy loop below skips it and `pruneUndeclaredBaselines` then DELETES
  // its approved baseline. The next replay finds no anchor for that capture, reports
  // `no-baseline`, and the trace is green forever over a frame nobody grades. Whole-run,
  // never per-capture: promoting the healthy subset is exactly how a baseline quietly
  // shrinks while the word "approved" stays the same.
  const faultedCaptures = parsed.segments
    .flatMap((s) => s.captures)
    .filter((c) => c.harnessFault !== undefined);
  if (faultedCaptures.length > 0) {
    const named = faultedCaptures.map((c) => `${c.id} (${c.harnessFault})`).join("; ");
    console.error(
      `[loombridge trace] cannot approve "${id}": the latest run carries a HARNESS FAULT, so its evidence ` +
        `includes frames nothing could compare: ${named}. A run the harness could not complete is never an anchor.`,
    );
    console.error(
      `[loombridge trace]   fix the harness condition and re-run \`loombridge trace replay --id ${id}\`. ` +
        "Approving here would freeze a partial run: the captures with no frame are pruned from the baseline, " +
        "so the trace would go permanently green over the very frames that failed.",
    );
    return 2;
  }

  // A REFUSED COMPARISON is NOT a capture fault, and refusing to approve it would lock the
  // operator out of the one door the refusal itself names. When the pixel gate declines to
  // grade (a clock or pacing mismatch, a broken anchor), every frame in the run is still a
  // complete, decodable capture: the F13 check above proved it, and the capture-fault check
  // proved every settle completed. Re-anchoring from exactly such a run is the DESIGNED
  // escape (found live in the pacing wave: the mismatch refusal pointed at approve, and an
  // earlier version of this rule refused the very report it pointed at, twice). The consent
  // is loud, not silent: this note, plus the pacing/clock/tolerance/mask lines below, state
  // that the new anchor is minted WITHOUT any comparison against the old one.
  if (parsed.visualHarnessFault === true) {
    console.error(
      `[loombridge trace] note: this run's pixel comparison was REFUSED at grade time (the replay output ` +
        "names the term). Approving re-anchors from these frames WITHOUT any comparison against the previous " +
        "baseline: every capture decodes and every settle completed, but nothing graded them. The terms the " +
        "new anchor takes are stated below.",
    );
  }

  // BX5: AN ALIGNED STAMP HAS TO CARRY FRAME EVIDENCE. `alignedCaptureFps` on a report is a
  // claim that every capture's settle ran inside the bridge's pinned tick loop, and
  // `framesElapsed` is the bridge's own count of the frames it advanced: the only thing in
  // the report that distinguishes a real aligned run from a hand-typed field on a wall-clock
  // one. The bound field is checked for PRESENCE and refused when absent, never skipped.
  if (parsed.alignedCaptureFps !== undefined) {
    const unevidenced = parsed.segments
      .flatMap((s) => s.captures)
      .filter((c) => c.artifact !== undefined)
      .filter((c) => typeof c.framesElapsed !== "number" || !(c.framesElapsed > 0))
      .map((c) => c.id);
    if (unevidenced.length > 0) {
      console.error(
        `[loombridge trace] cannot approve "${id}": the report claims a capture-aligned clock ` +
          `(${parsed.alignedCaptureFps} fps) but ${unevidenced.length} capture(s) carry no frame evidence ` +
          `(${unevidenced.join(", ")}). The aligned stamp is the anchor's promise that these frames were ` +
          "taken inside the pinned tick loop; without the bridge's own frame count nothing binds it to a run.",
      );
      console.error(
        `[loombridge trace]   re-run \`loombridge trace replay --id ${id} --aligned-fps ${parsed.alignedCaptureFps}\` ` +
          "against a bridge that reports framesElapsed, or approve a wall-clock run instead.",
      );
      return 2;
    }
  }

  // BX4: THE WRITE SIDE REFUSES WHAT THE READ SIDE WOULD. `approve` re-derives the pacing and
  // the capture clock from the report, and report.json is semi-trusted (hand-edited, or
  // written by an older/newer tool). Minting an anchor holding a value the ONE reader will
  // refuse produces a baseline that is permanently a harness fault: every later replay
  // reports a broken anchor and nothing in the approve output ever said why. Same predicates,
  // same message, at the door where the value enters.
  for (const [field, value, refusal] of [
    ["replaySpeed", (parsed as ReplayRunArtifact).replaySpeed, replaySpeedRefusal],
    ["alignedCaptureFps", (parsed as ReplayRunArtifact).alignedCaptureFps, alignedCaptureFpsRefusal],
  ] as const) {
    const bad = refusal(value);
    if (bad !== null) {
      console.error(
        `[loombridge trace] cannot approve "${id}": the report's ${field} is not a value an anchor can hold: ` +
          `${bad}. Approving it would mint a baseline the grade-time reader refuses on every later run.`,
      );
      return 2;
    }
  }

  // MASKS ARE RE-VALIDATED AGAINST THE FRAMES THIS APPROVE IS FREEZING (Q1), BEFORE a
  // single byte is written. A re-freeze at a new resolution leaves every approved rect
  // pointing at pixels that are no longer where the human put them, and the two silent
  // options are both wrong: dropping the masks un-blinds a region an operator consented
  // to hide (the next replay fails, and the suggestion tells them to mask it again),
  // while keeping them re-interprets a human decision against a frame they never saw.
  // Refuse instead, and name the verb that owns the decision.
  const carried = carryForward(previous);
  // The masked fraction this approve is re-affirming, appended to the ledger below so the
  // history has one entry PER APPROVAL EVENT (MX2). A history that only mask stamps wrote
  // reads as "nothing happened to the masks between stamp #1 and stamp #7", when in fact
  // five re-freezes each re-consented to the same blindness against new frames.
  let approvedMaskedFraction: number | undefined;
  if ((carried.maskRects?.length ?? 0) > 0) {
    const dims = await captureFrameDims(parsed, paths);
    if ("error" in dims) {
      console.error(
        `[loombridge trace] cannot approve "${id}" while masks are stamped: ${dims.error}. ` +
          `Clear them first (\`loombridge trace mask --id ${id} --clear\`) or fix the capture.`,
      );
      return 2;
    }
    // A RESOLUTION CHANGE REFUSES, IT NEVER REINTERPRETS (M2/M3, MX2). The rects still
    // "fit" a bigger frame, and that is exactly the trap: the same 20x20 rect hides 4% of a
    // 100x100 frame and 1% of a 200x200 one, so a silent re-freeze at a new resolution
    // would move a human's stated blindness AND every number printed about it, with no
    // event anywhere saying so. The bound field is checked for presence first and refused
    // when absent, never skipped: masks with no stamped dimensions were never measurable.
    if (
      typeof carried.frameWidth !== "number" ||
      typeof carried.frameHeight !== "number" ||
      carried.frameWidth !== dims.width ||
      carried.frameHeight !== dims.height
    ) {
      const stamped =
        typeof carried.frameWidth === "number" && typeof carried.frameHeight === "number"
          ? `${carried.frameWidth}x${carried.frameHeight}`
          : "an unrecorded size";
      console.error(
        `[loombridge trace] cannot approve "${id}": the game's resolution changed ` +
          `(${stamped} to ${dims.width}x${dims.height}): masks were approved against the old frames; ` +
          `re-stamp with \`loombridge trace mask --id ${id} --set ...\` against the new frames (or --clear).`,
      );
      console.error(
        `[loombridge trace]   the ${carried.maskRects!.length} rect(s) would hide a different share of the new ` +
          "frame than the one their approver consented to, so a re-freeze never reinterprets them.",
      );
      return 2;
    }
    // NO SECOND `maskRefusal` CALL HERE, and that is deliberate rather than an omission.
    // It would be unreachable: `loadTraceBaselineManifest` already ran the SAME predicate
    // over these rects against these stamped dims (a manifest that failed it never becomes
    // `previous` at all, so nothing is carried), and the branch above has just proven the
    // new frames are that same size. An unreachable guard is a vacuous guard, and this repo
    // has paid for those. The dims equality IS the check.
    //
    // The dims travel with the frames: the masks were just proven against THESE, and the
    // fraction is unchanged BY CONSTRUCTION (same rects, same dims) rather than by luck.
    carried.frameWidth = dims.width;
    carried.frameHeight = dims.height;
    approvedMaskedFraction = maskAnchorTerms(
      carried.maskRects!,
      dims.width,
      dims.height,
      previous === null ? DEFAULT_DRIFT_FRACTION : resolveDriftTolerance(previous),
    ).maskedFraction;
  }

  await fs.mkdir(baselineDir, { recursive: true });
  const pngs: TraceBaselinePng[] = [];
  for (const segment of parsed.segments) {
    for (const capture of segment.captures) {
      if (!capture.artifact) continue;
      // report.json is semi-trusted: never let a hand-edited capture.id escape
      // the baseline dir, nor copy a source from outside the replay artifact dirs.
      if (!isSafePathSegment(capture.id) || !isReplayArtifact(capture.artifact, paths)) {
        console.error(`[loombridge trace] skipping unsafe capture "${capture.id}".`);
        continue;
      }
      const dest = path.join(baselineDir, `${capture.id}.png`);
      try {
        const bytes = await fs.readFile(capture.artifact);
        await fs.writeFile(dest, bytes);
        pngs.push({ captureId: capture.id, sha256: sha256(bytes) });
      } catch {
        console.error(`[loombridge trace] could not approve capture "${capture.id}" (missing actual).`);
      }
    }
  }

  // Drop baselines this approval did NOT promote. A stale PNG left behind would
  // still be picked up as the comparison anchor for its capture id while sitting
  // outside the manifest: an unapproved frame silently grading a later run.
  const pruned = await pruneUndeclaredBaselines(baselineDir, pngs);

  const manifest: TraceBaselineManifest = {
    kind: "trace-baseline",
    schemaVersion: "1",
    traceId: id,
    traceSha256,
    approvedAt: new Date().toISOString(),
    sourceReportSha256: sha256(raw),
    pngs,
    // Q6: ONE helper names every preserved field, for all three writers.
    ...carried,
    ...nextApprovalLedger(
      previous,
      approvedMaskedFraction !== undefined ? { maskedFraction: approvedMaskedFraction } : {},
    ),
  };
  // The pacing the promoted frames were captured at rides the REPORT into the anchor, so
  // approve re-derives it rather than carrying the old value: these frames really were
  // captured at this pacing, and inheriting the previous one would mislabel them and
  // break the "approve from this report to re-anchor at 1x" escape hatch.
  const promotedSpeed = (parsed as ReplayRunArtifact).replaySpeed ?? 1;
  if (promotedSpeed !== 1) manifest.replaySpeed = promotedSpeed;
  else delete manifest.replaySpeed;
  // Same rule for the CLOCK the promoted frames were captured under, and the same reason:
  // carrying the previous value forward would mislabel these frames and break the "approve
  // from this report to re-anchor" escape hatch that a discipline change needs.
  const promotedClock = (parsed as ReplayRunArtifact).alignedCaptureFps;
  if (promotedClock !== undefined) manifest.alignedCaptureFps = promotedClock;
  else delete manifest.alignedCaptureFps;
  await writeTraceBaselineManifest(baselineDir, manifest);

  console.error(
    `[loombridge trace] approved ${pngs.length} baseline(s) → ${path.relative(args.root, baselineDir)}` +
      (pruned > 0 ? ` (pruned ${pruned} stale baseline(s))` : ""),
  );
  console.error(
    `[loombridge trace] stamped ${path.relative(args.root, traceBaselineManifestPath(baselineDir))}: approvedAt ${manifest.approvedAt}, bound to trace ${traceSha256.slice(0, 12)}…`,
  );
  // A tolerance carried through a re-freeze is stated out loud, with its consent
  // sentence: an allowance a human approved once must not become invisible later.
  if (manifest.driftTolerance !== undefined) {
    console.error(
      `[loombridge trace] drift tolerance ${driftPercentText(manifest.driftTolerance)}% preserved from the previous ` +
        `approval: ${toleranceConsentSentence(manifest.driftTolerance)}.`,
    );
  }
  // Same rule for masks, and for the stronger version of the same reason: a preserved
  // mask is a region of the new frames that will never be graded, and it was approved
  // against the OLD ones. It survives the re-freeze (re-validated above), and it says so.
  if ((manifest.maskRects?.length ?? 0) > 0) {
    console.error(
      `[loombridge trace] ${manifest.maskRects!.length} mask(s) preserved and re-validated against the new frames: ` +
        `${anchorTermsSentence(manifestAnchorTerms(manifest))}.`,
    );
  }
  // BX1: THE CAPTURE CLOCK IS ANNOUNCED WHEN IT CHANGES, exactly as a tolerance and a mask
  // set are. It is a term of every future comparison: after this approval, a replay under the
  // OLD discipline stops grading and reports a harness fault instead. That is the right
  // behaviour and a surprising one, so the change is never silent. Both directions, including
  // the drop back to wall-clock, because losing alignment is as consequential as gaining it.
  if (previous !== null && previous.alignedCaptureFps !== manifest.alignedCaptureFps) {
    const from = clockDisciplineText(previous.alignedCaptureFps);
    const to = clockDisciplineText(manifest.alignedCaptureFps);
    console.error(
      `[loombridge trace] the anchor's capture clock changes: ${from} to ${to}. Every later replay of ` +
        `"${id}" must run under ${to}; one under the old clock refuses the pixel comparison as a ` +
        "harness fault rather than grading two different animation phases against each other.",
    );
  }
  return pngs.length > 0 ? 0 : 1;
}

/**
 * The ONE frame size a report's captures were taken at, decoded from the PNGs
 * themselves (Q1). REFUSES a mixed-size run rather than picking one: masks are measured
 * against a frame, and "the frame" has to be a single thing for the cap to mean anything.
 */
async function captureFrameDims(
  artifact: ReplayRunArtifact,
  paths: ReplayLayout,
): Promise<{ width: number; height: number } | { error: string }> {
  let dims: { width: number; height: number } | null = null;
  let seen = 0;
  for (const segment of artifact.segments) {
    for (const capture of segment.captures) {
      if (!capture.artifact || !isReplayArtifact(capture.artifact, paths)) continue;
      let image: { width: number; height: number };
      try {
        image = await readPng(capture.artifact);
      } catch (error) {
        return { error: `capture '${capture.id}' could not be decoded (${message(error)})` };
      }
      seen += 1;
      if (dims === null) {
        dims = { width: image.width, height: image.height };
      } else if (dims.width !== image.width || dims.height !== image.height) {
        return {
          error:
            `the captures are not all one size (${dims.width}x${dims.height} and ` +
            `${image.width}x${image.height} at '${capture.id}')`,
        };
      }
    }
  }
  if (dims === null || seen === 0) return { error: "the run captured no readable frame" };
  return dims;
}

/** The ONE frame size the APPROVED baseline PNGs decode to, or a named refusal. */
async function baselineFrameDims(
  dir: string,
  pngs: readonly TraceBaselinePng[],
): Promise<{ width: number; height: number } | { error: string }> {
  let dims: { width: number; height: number } | null = null;
  for (const png of pngs) {
    let image: { width: number; height: number };
    try {
      image = await readPng(path.join(dir, `${png.captureId}.png`));
    } catch (error) {
      return { error: `approved baseline '${png.captureId}.png' could not be decoded (${message(error)})` };
    }
    if (dims === null) {
      dims = { width: image.width, height: image.height };
    } else if (dims.width !== image.width || dims.height !== image.height) {
      return {
        error:
          `the approved frames are not all one size (${dims.width}x${dims.height} and ` +
          `${image.width}x${image.height} at '${png.captureId}')`,
      };
    }
  }
  if (dims === null) return { error: "the baseline declares no frames" };
  return dims;
}

/**
 * `trace tolerance --id <id> --set <fraction>`: stamp the human-approved pixel
 * allowance onto an EXISTING approved baseline.
 *
 * A SEPARATE VERB FROM `approve`, and that split is the whole point (A1). The natural
 * design, `approve --drift-tolerance`, hands an operator staring at a drift failure one
 * command that both widens the gate AND re-freezes the drifted frames as the new truth.
 * That is the anchor destroyed by the very act of trying to keep it. This verb touches
 * no PNG and no sha: it edits the terms of the comparison, leaves the frames a human
 * approved exactly where they are, and records the change in the F6 ledger.
 *
 * Tiers: 1 when there is no baseline manifest to stamp (approve frames first, an
 * ordinary state error), 2 when a manifest exists but cannot be trusted (a broken
 * anchor is the harness tier, and re-stamping it would launder it).
 */
async function runTolerance(args: TraceArgs): Promise<number> {
  const paths = layoutFor(args);
  const baselineDir = path.join(paths.replayBaselines, args.id);
  const manifestRel = path.relative(args.root, traceBaselineManifestPath(baselineDir));

  // Range-checked in parseArgs; the assertion states the invariant rather than
  // re-deriving it, so the cap is enforced in exactly one place per side.
  const tolerance = args.driftTolerance;
  if (tolerance === undefined) {
    console.error("[loombridge trace] tolerance requires --set <fraction> (e.g. --set 0.015).");
    return 2;
  }

  const loaded = await loadTraceBaselineManifest(baselineDir);
  if (loaded === null) {
    console.error(
      `[loombridge trace] no approved baseline for "${args.id}" (${manifestRel} is absent): approve frames first: ` +
        `loombridge trace replay --id ${args.id} && loombridge trace approve --id ${args.id}`,
    );
    return 1;
  }
  if (isTraceBaselineManifestError(loaded)) {
    console.error(
      `[loombridge trace] cannot stamp a tolerance onto "${args.id}": ${loaded.error}. ` +
        "A baseline that cannot be read is not an anchor; re-approve it.",
    );
    return 2;
  }

  const stamped: TraceBaselineManifest = {
    ...loaded,
    // Q6: the preserved half goes through the one helper, so a field this verb never
    // heard of (a mask, a frame size) cannot be dropped by a spread that predates it.
    ...carryForward(loaded),
    driftTolerance: tolerance,
    approvedAt: new Date().toISOString(),
    ...nextApprovalLedger(loaded),
  };
  await writeTraceBaselineManifest(baselineDir, stamped);

  const previousText =
    loaded.driftTolerance === undefined
      ? `${driftPercentText(DEFAULT_DRIFT_FRACTION)}% (default)`
      : `${driftPercentText(loaded.driftTolerance)}%`;
  console.error(
    `[loombridge trace] stamped ${manifestRel}: drift tolerance ${previousText} → ` +
      `${driftPercentText(tolerance)}% (approval #${stamped.approvalCount}, ${stamped.pngs.length} frame(s) untouched).`,
  );
  // THE COMBINED CONSENT (Q4): masks and tolerance in ONE sentence, because they are one
  // decision about how much of this frame is still being graded.
  console.error(
    `[loombridge trace] ${anchorTermsSentence(manifestAnchorTerms(stamped)) ?? toleranceConsentSentence(tolerance)}.`,
  );
  console.error(
    `[loombridge trace] re-run \`loombridge trace replay --id ${args.id}\` to grade against the new terms.`,
  );
  return 0;
}

/**
 * `trace mask --id <id> --set <captureId?>:<x>,<y>,<w>x<h>@<reason> | --clear | --list`:
 * stamp the human-approved EXCLUDED REGIONS onto an EXISTING approved baseline.
 *
 * The tolerance's twin, and deliberately the same shape (P1): it lives in the anchor, it
 * is a separate verb from `approve` so nobody can widen the gate and re-freeze the frames
 * in one command, it touches no PNG and no sha, and it appends to the same approval
 * ledger. What is different is what it buys: a tolerance is a hole of a stated size
 * ANYWHERE in the frame, while a mask is a NAMED region, so the rest of the frame keeps
 * grading at full strictness. That is why it exists at all, and why every rect must
 * carry a reason.
 *
 * Tiers, mirroring `tolerance` exactly: 1 when there is no baseline to stamp (an ordinary
 * state error: approve frames first), 2 when one exists but cannot be trusted, or when
 * the rects are refused (re-stamping a broken anchor would launder it).
 */
async function runMask(args: TraceArgs): Promise<number> {
  const paths = layoutFor(args);
  const baselineDir = path.join(paths.replayBaselines, args.id);
  const manifestRel = path.relative(args.root, traceBaselineManifestPath(baselineDir));

  const loaded = await loadTraceBaselineManifest(baselineDir);
  if (loaded === null) {
    console.error(
      `[loombridge trace] no approved baseline for "${args.id}" (${manifestRel} is absent): approve frames first: ` +
        `loombridge trace replay --id ${args.id} && loombridge trace approve --id ${args.id}`,
    );
    return 1;
  }
  if (isTraceBaselineManifestError(loaded)) {
    console.error(
      `[loombridge trace] cannot stamp masks onto "${args.id}": ${loaded.error}. ` +
        "A baseline that cannot be read is not an anchor; re-approve it.",
    );
    return 2;
  }

  const current = resolveMaskRects(loaded);
  const tolerance = resolveDriftTolerance(loaded);
  if (args.maskList) {
    // READ-ONLY, and it touches nothing: no re-stamp, no ledger entry, no approvedAt. A
    // verb that mutated the anchor just to show it would make "look before you trust"
    // impossible to do safely.
    //
    // THE VERIFIER RUNS FIRST (MX3). Everything below is a fraction, and every fraction is
    // computed against the manifest's own `frameWidth`/`frameHeight`. Until the integrity
    // check decodes a real frame and cross-checks those two numbers, "4% masked" is the
    // manifest quoting itself: inflate the stamped dims by hand and 40% of the frame prints
    // as 4%. This surface exists to be LOOKED at before trusting an anchor, so it is the
    // last place that may print a number it has not checked.
    const integrity = await verifyTraceBaseline(baselineDir);
    if (!integrity.unstamped && !integrity.ok) {
      console.error(
        `[loombridge trace] the approved baseline for "${args.id}" cannot be trusted: ` +
          `${integrity.failures.join("; ")}.`,
      );
      console.error(
        "[loombridge trace] refusing to quote this anchor's terms: a masked fraction measured against a " +
          "denominator nothing checked is not a disclosure.",
      );
      return 2;
    }
    console.error(`[loombridge trace] ${manifestRel}: ${current.length} approved mask(s).`);
    for (const rect of current) {
      console.error(
        `[loombridge trace]   ${rect.captureId ?? "(every capture)"} ${formatRectGeometry(rect)} reason: ${rect.reason}`,
      );
    }
    console.error(
      `[loombridge trace] ${anchorTermsSentence(manifestAnchorTerms(loaded)) ?? NO_MASKS_DEFAULT_TERMS}.`,
    );
    // THE LEDGER'S OTHER HALF (MX13). `previousMaskRects` was written and never read back
    // by anything a human sees, which makes it a record kept for nobody: the question
    // "what did this anchor hide BEFORE the last stamp" is exactly the one an auditor
    // arrives with, and the fraction history alone answers "how much", never "where".
    if (loaded.previousMaskRects?.length) {
      console.error(
        `[loombridge trace] previously: ${loaded.previousMaskRects
          .map((r) => `${r.captureId ?? "(every capture)"} ${formatRectGeometry(r)}@${r.reason}`)
          .join(", ")} at ${loaded.previousApprovedAt ?? "an unrecorded time"}.`,
      );
    }
    if (loaded.maskedFractionHistory?.length) {
      console.error(
        `[loombridge trace] mask history: ${loaded.maskedFractionHistory.map((f) => `${driftPercentText(f)}%`).join(" → ")} ` +
          `(one entry per approval event, mask stamps and mask-bearing re-freezes alike).`,
      );
    }
    return 0;
  }

  // The frame size comes from DECODING the approved PNGs, never from a flag: the cap is a
  // fraction of a real frame, and a caller-supplied denominator is a caller-supplied cap.
  const dims = await baselineFrameDims(baselineDir, loaded.pngs);
  if ("error" in dims) {
    console.error(
      `[loombridge trace] cannot stamp masks onto "${args.id}": ${dims.error}. ` +
        "A mask is measured against the approved frame, so an unreadable frame is a harness fault, not a mask.",
    );
    return 2;
  }

  const rects = args.maskClear ? [] : (args.maskSet ?? []);
  // ONE PREDICATE, BOTH SIDES (Q1). This is the manifest READER's own refusal, called
  // here rather than restated: a second bounds/cap check against the same constants is
  // exactly how a stamp-time cap and a read-time cap drift apart, and the read side is
  // the one that has to hold, because the manifest is a file an operator can edit.
  const refusal = maskRefusal(rects, dims.width, dims.height);
  if (refusal !== null) {
    console.error(`[loombridge trace] ${refusal}.`);
    console.error(
      `[loombridge trace] nothing was stamped; the approved baseline for "${args.id}" is unchanged.`,
    );
    return 2;
  }

  const before = maskAnchorTerms(current, loaded.frameWidth ?? dims.width, loaded.frameHeight ?? dims.height, tolerance)
    .maskedFraction;
  const after = maskAnchorTerms(rects, dims.width, dims.height, tolerance).maskedFraction;
  const stamped: TraceBaselineManifest = {
    ...loaded,
    ...carryForward(loaded),
    maskRects: rects,
    frameWidth: dims.width,
    frameHeight: dims.height,
    approvedAt: new Date().toISOString(),
    ...nextApprovalLedger(loaded, { maskedFraction: after }),
  };
  if (rects.length === 0) delete stamped.maskRects;
  await writeTraceBaselineManifest(baselineDir, stamped);

  // WHAT THIS STAMP TOOK AWAY, BY NAME (M6/MX5). `--set` restates the whole list, so a
  // stamp that swaps one rect for another is a REMOVAL and an addition, and the counts
  // alone hide it perfectly: "2 to 2 mask(s)" reads as "nothing happened" while a region a
  // human approved has silently gone back to being graded (or, in the other direction, a
  // typo'd re-stamp has quietly un-masked the thing the operator was protecting). The
  // removed rects are printed with their reasons, because the reason is the only record of
  // what that region was, and it is about to stop existing.
  const kept = new Set(rects.map(rectKey));
  const removed = current.filter((r) => !kept.has(rectKey(r)));
  const previouslyStamped = new Set(current.map(rectKey));
  const added = rects.filter((r) => !previouslyStamped.has(rectKey(r)));
  const churn =
    removed.length > 0 || added.length > 0
      ? ` (${removed.length} removed, ${added.length} added)`
      : " (unchanged)";
  console.error(
    `[loombridge trace] stamped ${manifestRel}: ${current.length} to ${rects.length} mask(s)${churn}, masked ` +
      `${driftPercentText(before)}% to ${driftPercentText(after)}% of the frame ` +
      `(approval #${stamped.approvalCount}, ${stamped.pngs.length} frame(s) untouched).`,
  );
  if (removed.length > 0) {
    console.error(
      `[loombridge trace] ${removed.length} mask(s) REMOVED: ${removed
        .map((r) => `${r.captureId === undefined ? "" : `${r.captureId}:`}${formatRectGeometry(r)}@${r.reason}`)
        .join(", ")}. Those regions are GRADED again.`,
    );
  }
  for (const rect of rects) {
    console.error(
      `[loombridge trace]   ${rect.captureId ?? "(every capture)"} ${formatRectGeometry(rect)} reason: ${rect.reason}`,
    );
  }
  if (rects.length === 0) {
    console.error(
      "[loombridge trace] the mask list is now EMPTY: the whole frame is graded again.",
    );
  }
  console.error(
    `[loombridge trace] ${anchorTermsSentence(manifestAnchorTerms(stamped)) ?? NO_MASKS_DEFAULT_TERMS}.`,
  );
  console.error(
    `[loombridge trace] re-run \`loombridge trace replay --id ${args.id}\` to grade against the new terms.`,
  );
  return 0;
}

/** What this anchor concedes, as the ONE sentence function takes it. */
function manifestAnchorTerms(manifest: TraceBaselineManifest): AnchorTerms {
  return maskAnchorTerms(
    resolveMaskRects(manifest),
    manifest.frameWidth ?? 0,
    manifest.frameHeight ?? 0,
    resolveDriftTolerance(manifest),
  );
}

/** What an anchor with nothing to concede says, once, for the verbs that state it. */
const NO_MASKS_DEFAULT_TERMS = `no masks; the whole frame grades at the ${driftPercentText(DEFAULT_DRIFT_FRACTION)}% default`;

/** Remove `*.png` in a baseline dir that this approval did not promote. Returns the count. */
async function pruneUndeclaredBaselines(dir: string, pngs: TraceBaselinePng[]): Promise<number> {
  const keep = new Set(pngs.map((p) => `${p.captureId}.png`));
  let removed = 0;
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return 0;
  }
  for (const entry of entries.filter((e) => e.endsWith(".png")).sort()) {
    if (keep.has(entry)) continue;
    try {
      await fs.rm(path.join(dir, entry));
      removed += 1;
    } catch {
      /* best-effort: a PNG we cannot remove is reported by verifyTraceBaseline as undeclared */
    }
  }
  return removed;
}

/**
 * The programmatic seam unified `verify` drives a trace through: one replay, its
 * per-trace JSON and HTML reports, and the tier that replay earns. No argv and no
 * `TraceArgs` (the verb's argv shape stays private so the orchestrator cannot grow a
 * second, drifting CLI).
 *
 * THIS PATH RENDERS THE HTML. It used to pass `html: false`, on the reasoning that "the
 * unified report links the JSON": true, and beside the point: the two doors write into
 * the SAME `reports/` directory, so a verify that rewrote only the JSON left whatever page
 * an earlier `trace replay` had rendered sitting next to it, describing a different run.
 * Observed on a real project: a red `verify --live` next to a green page from 4 minutes
 * earlier. The JSON is what the roll-up binds; the HTML is what a human opens, and both
 * have to be this run's.
 *
 * The unified flow always passes `strictVisual: true` (S1 amendment A5: pixel-drift
 * gating is the DEFAULT there: an approved pixel baseline that a human froze is an
 * anchor, so drifting from it is a result, not a warning). The `trace` verb's own
 * default is unchanged.
 */
export async function replayTraceForVerify(
  layout: ReplayLayout,
  id: string,
  opts: {
    strictVisual: boolean;
    projectPathCanonical?: string;
    /**
     * The live client this replay drives (see `RunLiveReplayOptions.clientFactory`). Absent
     * in production, where a real `UnityClient` is discovered. It is threaded through THIS
     * seam rather than a private one so a test walks the whole composition an operator gets:
     * the manifest read that resolves the clock, the driver that turns a settle into an op,
     * and the report that stamps what happened.
     */
    clientFactory?: RunLiveReplayOptions["clientFactory"];
  },
): Promise<{
  artifact: ReplayRunArtifact;
  reportJson: string;
  /** The page rendered for THIS run, so the unified summary can name it (never a stale one). */
  htmlPath: string;
  exitTier: number;
  /** A3: the drift facts, so the unified section reports numbers instead of a bare tier. */
  drift: DriftFacts;
  /**
   * Q3: the mask verdict for this run, derived once in `applyVisualDiff` and carried to
   * whichever door is printing. Absent when nothing drifted.
   */
  maskSuggestion?: MaskSuggestion;
}> {
  const { artifact, reportJson, htmlPath } = await replayOneTrace(layout, id, {
    html: true,
    projectPathCanonical: opts.projectPathCanonical,
    ...(opts.clientFactory ? { clientFactory: opts.clientFactory } : {}),
  });
  return {
    artifact,
    reportJson,
    // `replayOneTrace` returns this whenever it was asked to render, and it was; the throw
    // states the invariant rather than letting an `undefined` become a summary line that
    // silently stops naming the page.
    htmlPath: htmlPath ?? unreachableHtmlPath(id),
    exitTier: replayExitCode(artifact, opts.strictVisual),
    drift: driftFacts(artifact),
    ...(artifact.maskSuggestion ? { maskSuggestion: artifact.maskSuggestion } : {}),
  };
}

function unreachableHtmlPath(id: string): never {
  throw new Error(
    `[loombridge trace] internal: the verify replay of "${id}" rendered no HTML report despite asking for one.`,
  );
}

/**
 * Annotate each capture with its perceptual diff vs the approved baseline.
 *
 * Exported for tests: the tier a run earns depends on this function distinguishing
 * real drift from an undecodable file, and the only other way in is a live replay.
 *
 * THE ANCHOR IS RE-VERIFIED HERE, AT GRADE TIME (A4). Discovery's opinion about the
 * baseline was formed before the replay ran and is a plan, not evidence; and the `trace`
 * verb has no discovery step at all, so without this the terms of the comparison would be
 * read from a file nothing checked. A manifest that is malformed, carries an out-of-cap
 * tolerance, or no longer matches its own frames is a HARNESS FAULT (tier 2) for every
 * capture. Never a fall back to the default tolerance, which would be the tool grading a
 * run against terms it just proved it could not read.
 *
 * An ABSENT manifest is the legacy case, not a fault: those baselines predate stamping,
 * they grade at the default (the strictest tolerance there is), and the unified door
 * already refuses to treat them as anchors at all.
 */
/**
 * How a run's capture clock READS in a refusal sentence. `undefined` is the legacy
 * wall-clock settle and is spelled out rather than printed as "undefined": an operator
 * staring at a refusal needs to know which of the two disciplines each side used, and the
 * absent one is the easiest to misread as "not recorded".
 */
export function clockDisciplineText(fps: number | undefined): string {
  return fps === undefined
    ? "a wall-clock settle (unaligned)"
    : `a capture-aligned settle at ${fps} fps`;
}

export async function applyVisualDiff(
  paths: ReplayLayout,
  id: string,
  artifact: ReplayRunArtifact,
): Promise<void> {
  const baselineDir = path.join(paths.replayBaselines, id);
  const integrity = await verifyTraceBaseline(baselineDir);
  let tolerance = DEFAULT_DRIFT_FRACTION;
  let maskRects: MaskRect[] = [];
  let frameWidth = 0;
  let frameHeight = 0;
  // ACCUMULATING (finding 20). The anchor can be untrustworthy in more than one way at
  // once, and a single `baselineFault` slot meant the LAST check to run silently overwrote
  // the earlier ones: a run whose masks pointed at a frame size that no longer exists AND
  // whose pacing did not match printed only the pacing, so the operator fixed one fault,
  // re-ran, and met the next. Every reason is collected and printed together.
  const baselineFaults: string[] = [];
  if (integrity.unstamped) {
    // Legacy baseline (or none yet): default terms, no fault.
  } else if (!integrity.ok) {
    baselineFaults.push(integrity.failures.join("; "));
  } else {
    tolerance = resolveDriftTolerance(integrity.manifest!);
    maskRects = resolveMaskRects(integrity.manifest!);
    frameWidth = integrity.manifest!.frameWidth ?? 0;
    frameHeight = integrity.manifest!.frameHeight ?? 0;
    // A DIMS MISMATCH IS A MANIFEST-LEVEL FAULT (Q6), the pacing precedent exactly: the
    // masks were approved against a frame of a stated size, and if the frozen frames are
    // no longer that size then every rect points somewhere its approver never looked. The
    // fault belongs to the ANCHOR, so the captures are left ungraded rather than stamped
    // `unreadable` (they decode fine, and calling them unreadable would make `approve`
    // refuse the very report that re-anchors at the new size).
    if (maskRects.length > 0) {
      const dims = await baselineFrameDims(baselineDir, integrity.manifest!.pngs);
      if ("error" in dims) {
        baselineFaults.push(`masks are stamped but ${dims.error}`);
      } else if (dims.width !== frameWidth || dims.height !== frameHeight) {
        baselineFaults.push(
          `the masks were approved against a ${frameWidth}x${frameHeight} frame but the approved frames are ` +
            `${dims.width}x${dims.height}; re-state them with \`loombridge trace mask --id ${id} --set ...\`, ` +
            `or drop them with \`--clear\``,
        );
      }
    }
    // Pacing mismatch is a HARNESS refusal, not drift: frames captured at different
    // pacings sit at different animation phases, and grading them against each other
    // reads phase skew as drift (or hides real drift behind it).
    const stampedSpeed = integrity.manifest!.replaySpeed ?? 1;
    const runSpeed = artifact.replaySpeed ?? 1;
    if (stampedSpeed !== runSpeed) {
      baselineFaults.push(
        `the baseline was approved at ${stampedSpeed}x pacing but this run replayed at ` +
          `${runSpeed}x; re-run at ${stampedSpeed}x, or approve from this run's report to re-anchor at ${runSpeed}x`,
      );
    }
    // THE CLOCK DISCIPLINE IS A COMPARISON TERM (S3), the pacing precedent exactly. Frames
    // captured under a pinned settle clock and frames captured after a wall-clock sleep sit
    // at different animation phases, so grading one against the other reads phase skew as
    // drift (or hides real drift behind it). Absent on either side means WALL-CLOCK, which
    // is a real value and not a missing one: the refusal fires on the MISMATCH of two known
    // disciplines, never on an absence that would let an unaligned run grade against an
    // aligned anchor.
    const stampedClock = integrity.manifest!.alignedCaptureFps;
    const runClock = artifact.alignedCaptureFps;
    if (stampedClock !== runClock) {
      baselineFaults.push(
        `the baseline was approved under ${clockDisciplineText(stampedClock)} but this run captured under ` +
          `${clockDisciplineText(runClock)}; frames taken under different capture clocks are phase-incomparable. ` +
          `Re-run under ${clockDisciplineText(stampedClock)}, or approve from this run's report to re-anchor`,
      );
    }
  }
  const baselineFault = baselineFaults.length > 0 ? baselineFaults.join("; ") : null;
  if (baselineFault !== null) {
    console.error(
      `[loombridge trace] the approved baseline for "${id}" cannot be trusted at grade time ` +
        `(harness fault, not a game defect): ${baselineFault}`,
    );
  }

  // THE PREVIOUS RUN, read BEFORE this one overwrites it (Q3). The two-run discriminator
  // is the whole safety property of the mask suggestion, and the only place the previous
  // run's evidence still exists is the report this replay is about to replace.
  const previousEvidence = await readPreviousDriftEvidence(paths, id);

  let anyDrift = false;
  let anyUnreadable = false;
  let anyCaptureFault = false;
  let anyCompared = false;
  const evidence: CaptureDriftEvidence[] = [];
  for (const segment of artifact.segments) {
    for (const capture of segment.captures) {
      // THE CAPTURE STEP ITSELF FAILED IN THE HARNESS (the aligned settle could not be
      // delivered), so there is no frame to grade and never a drift verdict. Checked BEFORE
      // the `!capture.artifact` skip, which would otherwise drop the whole event from the
      // run's tier: a starved editor would read as "one fewer comparison" and the run would
      // come out green.
      if (capture.harnessFault) {
        anyCaptureFault = true;
        console.error(
          `[loombridge trace] capture "${capture.id}" is a HARNESS FAULT (no comparable frame, ` +
            `not drift): ${capture.harnessFault}`,
        );
        continue;
      }
      if (!capture.artifact) continue;
      // BX5: THE ALIGNED STAMP IS BOUND TO EVIDENCE, OR IT IS A HARNESS FAULT. `framesElapsed`
      // is the bridge's own count of the frames it advanced inside the pinned loop, and it is
      // the only thing in the report that separates a frame really taken under an aligned
      // settle from one that merely carries the label (an older bridge that never reported it,
      // a hand-edited report, a capture path that fell back to the wall-clock screenshot).
      // Grading such a frame against an aligned anchor would compare two disciplines while
      // both sides claimed one. Refuse the comparison; never guess, and never grade.
      if (artifact.alignedCaptureFps !== undefined && !(typeof capture.framesElapsed === "number" && capture.framesElapsed > 0)) {
        anyCaptureFault = true;
        capture.harnessFault ??=
          `the aligned stamp carries no frame evidence (framesElapsed ${capture.framesElapsed ?? "absent"})`;
        console.error(
          `[loombridge trace] capture "${capture.id}" is a HARNESS FAULT (no comparable frame, not drift): ` +
            `the run claims a capture-aligned clock at ${artifact.alignedCaptureFps} fps, but this capture ` +
            "carries no framesElapsed, so nothing binds the frame to the settle the report claims for it.",
        );
        continue;
      }
      const baselinePath = path.join(baselineDir, `${capture.id}.png`);
      if (baselineFault !== null) {
        // The anchor as a whole is untrusted, so no capture under it is GRADED. The
        // fault lives on the ARTIFACT (visualHarnessFault below), not on the captures:
        // these PNGs decode fine, and stamping them "unreadable" would make approve
        // refuse the very report that re-anchors at a new pacing (found live: the
        // pacing-mismatch escape hatch was refused by the capture-gap rule it tripped).
        continue;
      }
      let baselineExists = true;
      try {
        await fs.access(baselinePath);
      } catch {
        baselineExists = false;
      }
      if (!baselineExists) {
        capture.visualStatus = "no-baseline";
        continue;
      }
      try {
        const [actual, baseline] = await Promise.all([
          readPng(capture.artifact),
          readPng(baselinePath),
        ]);
        // THE MASKS ARE APPLIED HERE, in the ONE reader path (P3), for every capture of
        // the trace. Both doors (the verb and the unified flow) come through this
        // function, so neither can grade a run on different terms from the other.
        const diff = comparePerceptual(actual, baseline, {
          driftFraction: tolerance,
          maskRects,
          captureId: capture.id,
        });
        capture.baseline = baselinePath;
        capture.diffFraction = diff.diffFraction;
        capture.visualStatus = diff.status;
        // Stamped where the comparison HAPPENED, so the report says on what terms.
        capture.toleranceUsed = tolerance;
        if (diff.maskedFraction > 0) capture.maskedFraction = diff.maskedFraction;
        if (diff.driftDiffSha !== undefined) capture.driftDiffSha = diff.driftDiffSha;
        if (diff.driftBounds !== undefined) capture.driftBounds = diff.driftBounds;
        // MX1: THE STRUCTURAL FINGERPRINT GOES ON DISK. The discriminator's bar is measured
        // between two RUNS, and the only place run one still exists when run two grades is
        // this report. A grid that lived only in memory would leave the next run with the
        // sha alone, which one flipped pixel defeats.
        if (diff.driftGrid !== undefined) capture.driftGrid = diff.driftGrid;
        evidence.push({
          captureId: capture.id,
          drifted: diff.status === "drift",
          ...(diff.driftDiffSha !== undefined ? { driftDiffSha: diff.driftDiffSha } : {}),
          ...(diff.driftBounds !== undefined ? { driftBounds: diff.driftBounds } : {}),
          ...(diff.driftGrid !== undefined ? { driftGrid: diff.driftGrid } : {}),
          ...(diff.driftClusters !== undefined ? { driftClusters: diff.driftClusters } : {}),
          ...(diff.driftClusterRefusal !== undefined
            ? { driftClusterRefusal: diff.driftClusterRefusal }
            : {}),
        });
        anyCompared = true;
        if (diff.status === "drift") anyDrift = true;
      } catch (error) {
        // Unreadable actual/baseline → the comparison could not be made. Never a
        // silent match, and never DRIFT either: a corrupt/truncated PNG is a capture
        // gap (harness tier 2), and calling it drift would report a harness fault as a
        // game defect. `replayExitCode` reads `visualHarnessFault` for the tier.
        capture.baseline = baselinePath;
        capture.visualStatus = "unreadable";
        anyUnreadable = true;
        console.error(
          `[loombridge trace] visual diff UNREADABLE for "${capture.id}" (capture gap, not drift): ${message(error)}`,
        );
      }
    }
  }
  if (anyDrift) artifact.visualDrift = true;
  if (anyUnreadable || anyCaptureFault || baselineFault !== null) artifact.visualHarnessFault = true;
  if (anyCompared) artifact.toleranceUsed = tolerance;
  if (anyCompared && maskRects.length > 0) {
    artifact.maskRects = maskRects;
    artifact.maskedFraction = maskAnchorTerms(maskRects, frameWidth, frameHeight, tolerance).maskedFraction;
  }
  // Derived even when nothing is printed, so the report records WHY a suggestion did or
  // did not appear. The dims fall back to the compared frame when the anchor never
  // stamped any (an unmasked baseline), because the suggestion's own cap still needs a
  // denominator, and an anchor with no masks has no stamped one.
  if (anyDrift) {
    const dims = frameWidth > 0 && frameHeight > 0 ? { frameWidth, frameHeight } : await comparedFrameDims(artifact);
    // MX5: the ALREADY STAMPED rects go in, so the command the suggestion prints restates
    // them. `--set` replaces the whole list, so a suggestion naming only the new rects
    // would be an instruction to delete every mask the operator previously approved.
    const suggestion = deriveMaskSuggestion(
      evidence,
      previousEvidence,
      dims.frameWidth,
      dims.frameHeight,
      maskRects,
    );
    if (suggestion) artifact.maskSuggestion = suggestion;
  }
}

/** The frame size the captures were compared at, for a baseline that stamped none. */
async function comparedFrameDims(
  artifact: ReplayRunArtifact,
): Promise<{ frameWidth: number; frameHeight: number }> {
  for (const segment of artifact.segments) {
    for (const capture of segment.captures) {
      if (!capture.artifact || capture.visualStatus === undefined) continue;
      try {
        const image = await readPng(capture.artifact);
        return { frameWidth: image.width, frameHeight: image.height };
      } catch {
        /* the unreadable case is already tiered above; keep looking */
      }
    }
  }
  return { frameWidth: 0, frameHeight: 0 };
}

/**
 * The PREVIOUS run's per-capture drift evidence, off the report this replay is about to
 * overwrite. Missing, unreadable or pre-field reports all read as "no evidence", which
 * lands the suggestion on `first-run`: the branch that asks for another run rather than
 * naming a rect. Absence never invents agreement.
 */
async function readPreviousDriftEvidence(
  paths: ReplayLayout,
  id: string,
): Promise<CaptureDriftEvidence[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(path.join(paths.replayReports, `${id}.report.json`), "utf8"));
  } catch {
    return [];
  }
  if (!isReplayRunArtifact(parsed)) return [];
  return parsed.segments.flatMap((segment) =>
    segment.captures
      .filter((capture) => capture.visualStatus === "drift")
      .map((capture) => ({
        captureId: capture.id,
        drifted: true,
        ...(capture.driftDiffSha !== undefined ? { driftDiffSha: capture.driftDiffSha } : {}),
        ...(capture.driftBounds !== undefined ? { driftBounds: capture.driftBounds } : {}),
        // Semi-trusted, and deliberately NOT validated here: `deriveMaskSuggestion` runs
        // every grid through `asDriftGrid`, so one validator decides what a fingerprint is,
        // and a malformed one lands on "ask for another run" rather than on a rect.
        ...(capture.driftGrid !== undefined ? { driftGrid: capture.driftGrid } : {}),
      })),
  );
}

/**
 * The run's drift facts, derived from the artifact the run actually wrote (A3).
 *
 * Pure and shared: the `trace` verb summary, the suggestion loop and the unified flow
 * section all read THIS, so the three cannot disagree about how many captures drifted
 * or by how much. `maxDiffFraction` spans every COMPARED capture, not only the drifting
 * ones, which is the same number when anything drifted and an honest "worst observed"
 * when nothing did.
 */
export function driftFacts(
  artifact: Pick<ReplayRunArtifact, "segments" | "toleranceUsed">,
): DriftFacts {
  const captures = artifact.segments.flatMap((s) => s.captures);
  const masked = captures.reduce((max, c) => Math.max(max, c.maskedFraction ?? 0), 0);
  return {
    driftCaptures: captures.filter((c) => c.visualStatus === "drift").length,
    maxDiffFraction: captures.reduce((max, c) => Math.max(max, c.diffFraction ?? 0), 0),
    toleranceUsed: artifact.toleranceUsed ?? DEFAULT_DRIFT_FRACTION,
    // Carried ONLY when something was actually masked, so an unmasked run's facts are
    // byte-identical to what they were before masks existed, and every line about it
    // reads exactly as it did.
    ...(masked > 0 ? { maskedFraction: masked } : {}),
  };
}

/**
 * Should the re-tolerance suggestion be printed for this run? (A6)
 *
 * NEVER on a harness fault. An unreadable capture is not drift, and offering "widen the
 * tolerance" as the remedy for it would be advice to paper over a broken capture with a
 * consented allowance: the exact laundering of a harness fault into a game-tier
 * allowance that the tiering rules exist to prevent. Also never when the actuation itself
 * failed: the drift is not the story, and pointing at it would be misdirection.
 */
export function shouldSuggestTolerance(
  artifact: Pick<ReplayRunArtifact, "status" | "visualDrift" | "visualHarnessFault">,
): boolean {
  if (artifact.visualHarnessFault) return false;
  if (artifact.status !== "pass") return false;
  return artifact.visualDrift === true;
}

async function runReport(args: TraceArgs): Promise<number> {
  const paths = layoutFor(args);
  const reportJson = path.join(paths.replayReports, `${args.id}.report.json`);
  const rel = path.relative(args.root, reportJson);

  let raw: string;
  try {
    raw = await fs.readFile(reportJson, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      console.error(
        `[loombridge trace] no report at ${rel} — run 'trace replay --id ${args.id}' first.`,
      );
      return 1;
    }
    throw error;
  }

  let artifact: unknown;
  try {
    artifact = JSON.parse(raw);
  } catch {
    console.error(`[loombridge trace] ${rel} is not valid JSON.`);
    return 1;
  }
  if (!isReplayRunArtifact(artifact)) {
    console.error(`[loombridge trace] ${rel} is not a valid replay report.`);
    return 1;
  }

  // Bound to the bytes just READ, not to a re-serialization of the parsed object: this
  // verb renders whatever is on disk, including a hand-edited file, and the stamp has to
  // name those bytes so the page and the JSON beside it can be compared at all.
  const htmlPath = await writeHtmlReport(paths, args.id, artifact, sha256(raw));
  console.error(`[loombridge trace] html → ${path.relative(args.root, htmlPath)}`);
  return 0;
}

/** Minimal structural check before rendering an on-disk report. */
function isReplayRunArtifact(value: unknown): value is ReplayRunArtifact {
  if (typeof value !== "object" || value === null) return false;
  const a = value as Record<string, unknown>;
  return (
    typeof a.traceId === "string" &&
    typeof a.status === "string" &&
    Array.isArray(a.segments) &&
    Array.isArray(a.assertions) &&
    typeof a.console === "object" &&
    a.console !== null
  );
}

/**
 * Load the capture PNGs and render the self-contained HTML next to the JSON.
 *
 * `sourceReportSha256` is the sha256 of the `<id>.report.json` BYTES this page renders,
 * and it is a required argument on purpose: an optional one would default to "unbound",
 * and a page that declines to name the verdict it came from is exactly the artifact a
 * later run can silently outdate. Both call sites hold those bytes already (one just
 * wrote them, the other just read them).
 */
async function writeHtmlReport(
  paths: ReplayLayout,
  id: string,
  artifact: ReplayRunArtifact,
  sourceReportSha256: string,
): Promise<string> {
  // The masks the run graded with, so the report can DRAW them on the thumbnails: a
  // reader looking at two frames that "match" has no way to know a region was blanked
  // unless the picture says so.
  const manifest = await loadTraceBaselineManifest(path.join(paths.replayBaselines, id));
  const anchor = manifest !== null && !isTraceBaselineManifestError(manifest) ? manifest : null;
  const maskRects = artifact.maskRects ?? (anchor ? resolveMaskRects(anchor) : []);
  const captures: CaptureImage[] = [];
  for (const segment of artifact.segments) {
    for (const capture of segment.captures) {
      captures.push({
        id: capture.id,
        segment: segment.id,
        base64: await readBase64(capture.artifact, paths),
        baselineBase64: await readBase64(capture.baseline, paths),
        visualStatus: capture.visualStatus,
        diffFraction: capture.diffFraction,
        ...(capture.maskedFraction !== undefined ? { maskedFraction: capture.maskedFraction } : {}),
        masks: masksForCapture(maskRects, capture.id),
      });
    }
  }
  const htmlPath = path.join(paths.replayReports, `${id}.report.html`);
  await fs.writeFile(
    htmlPath,
    renderReplayReportHtml(artifact, captures, {
      sourceReportSha256,
      ...(anchor?.frameWidth !== undefined ? { frameWidth: anchor.frameWidth } : {}),
      ...(anchor?.frameHeight !== undefined ? { frameHeight: anchor.frameHeight } : {}),
      anchorTerms: anchorTermsSentence(
        maskAnchorTerms(
          maskRects,
          anchor?.frameWidth ?? 0,
          anchor?.frameHeight ?? 0,
          // THE TOLERANCE FALLS BACK TO THE ANCHOR, EXACTLY AS THE MASKS DO (V3/MX9).
          // `toleranceUsed` is stamped only where a comparison actually HAPPENED, so a run
          // whose captures were left ungraded (a pacing mismatch, a dims fault: the harness
          // tier) carries none, and defaulting to 0.5% there would print a STRICTER anchor
          // than the one on disk. The report of a refused run is exactly when a reader needs
          // the real terms, and the report must not be the surface that flatters them.
          artifact.toleranceUsed ??
            (anchor ? resolveDriftTolerance(anchor) : DEFAULT_DRIFT_FRACTION),
        ),
      ),
    }),
    "utf-8",
  );
  return htmlPath;
}

/**
 * Read a PNG as base64, but only when it resolves under a replay-artifact dir — a
 * hand-edited report.json must not make the HTML inline an arbitrary file.
 */
async function readBase64(
  pngPath: string | undefined,
  paths: ReplayLayout,
): Promise<string | undefined> {
  if (!pngPath || !isReplayArtifact(pngPath, paths)) return undefined;
  try {
    return (await fs.readFile(pngPath)).toString("base64");
  } catch {
    return undefined;
  }
}

/** True if `child` resolves to `parent` or a path inside it. */
function isUnderDir(child: string, parent: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * True if `child` resolves under a real replay-artifact dir — the captured reports
 * (`replayReports`) or approved baselines (`replayBaselines`). This is the confinement
 * for copy/inline of report-referenced PNGs: it is tight in BOTH layouts (standard:
 * `.loombridge/replays/{reports,baselines}`; flat: `<ws>/{reports,baseline}`), so the
 * flat layout's `replays === workspace` can't widen it to the whole workspace (a
 * hand-edited report.json can't reach the contract, captures, or raw/ as a source).
 */
function isReplayArtifact(child: string, paths: ReplayLayout): boolean {
  return isUnderDir(child, paths.replayReports) || isUnderDir(child, paths.replayBaselines);
}

/**
 * The `trace replay` verb's own summary block: the tier, the terms it graded on, and the
 * suggestion loop.
 *
 * EXPORTED FOR TESTS, and for a specific reason (V1/MX8): the only other way to reach it
 * is a live replay against a running editor, so every rule enforced here (above all, that
 * the mask suggestion is gated behind {@link shouldSuggestTolerance} and therefore never
 * answers a capture gap with "mask this region") was pinned only through the pure helpers
 * it calls. A gate that no test drives through the code that applies it is a gate that can
 * be hoisted out of its `if` by a refactor, with a green suite.
 */
export function printSummary(
  root: string,
  id: string,
  artifact: ReplayRunArtifact,
  reportJson: string,
  htmlPath: string | undefined,
  strictVisual: boolean,
): void {
  const blocked = artifact.blockedReason ? ` (${artifact.blockedReason})` : "";
  // BX2: THE HEADLINE REFLECTS THE WORST TIER, not the engine's word for one layer of it.
  // `artifact.status` answers "did the actuation diverge?", and it is honestly PASS for a run
  // whose captures could not be compared at all: the game did everything the trace asked. But
  // that run exits 2, and a summary reading "PASS" above a non-zero exit teaches a reader to
  // trust the word over the code. The JSON keeps the engine's word (that layer's answer is
  // still true and other tools read it); the human line states the tier the run earned and
  // names the actuation result inside it, in that order.
  if (artifact.visualHarnessFault) {
    console.error(
      `[loombridge trace] ${id}: HARNESS FAULT (exit 2): actuation ${artifact.status}${blocked}. ` +
        "No comparable frames, so this run holds NO opinion about the pixels: never a pass, never drift.",
    );
  } else {
    console.error(`[loombridge trace] ${id}: ${artifact.status.toUpperCase()}${blocked}`);
  }
  if (artifact.blockedDetail) {
    console.error(`[loombridge trace]   cause: ${artifact.blockedDetail}`);
  }
  if (artifact.firstDivergence) {
    const d = artifact.firstDivergence;
    console.error(
      `[loombridge trace] first divergence: ${d.kind} @ segment=${d.segment} step=${d.step ?? "-"}`,
    );
    console.error(`[loombridge trace]   expected: ${d.expected}`);
    console.error(`[loombridge trace]   actual:   ${d.actual}`);
  }
  const drifted = artifact.segments
    .flatMap((s) => s.captures)
    .filter((c) => c.visualStatus === "drift");
  if (drifted.length) {
    console.error(
      `[loombridge trace] visual drift: ${drifted
        .map((c) => `${c.id} (${((c.diffFraction ?? 0) * 100).toFixed(2)}%)`)
        .join(", ")}`,
    );
  }
  const facts = driftFacts(artifact);
  // R3/A3: DRIFT NAMES ITSELF, at the tier this invocation actually earns. The old
  // summary printed the artifact's own word ("PASS") and left the reader to reconcile it
  // with a non-zero exit; the run really did actuate, and the pixels really did move, so
  // the line says both in that order.
  if (facts.driftCaptures > 0) {
    console.error(
      `[loombridge trace] ${driftRegressionLine({ ...facts, exitTier: replayExitCode(artifact, strictVisual) })}`,
    );
    // S6, THE HONEST RESIDUAL. Drift that survives an aligned run is the single most
    // over-readable result this tool produces ("we pinned the clock and it still moved,
    // so the game is nondeterministic"). It is not proof of that: the settle is aligned,
    // the action round trips and the anchor polling are not. Say so, every time, right
    // under the number that invites the conclusion.
    if (artifact.alignedCaptureFps !== undefined) {
      console.error(`[loombridge trace] ${ALIGNED_RESIDUAL_SENTENCE}`);
    }
  }
  // P5: the terms this run graded on are never silent. With masks it is the ONE combined
  // sentence (a green run with 4% of every frame blanked is a different claim from a green
  // run, and both halves have to be read together); without them it is the tolerance line
  // exactly as it has always read.
  const masks = artifact.maskRects ?? [];
  if (masks.length > 0) {
    console.error(
      `[loombridge trace] ${anchorTermsSentence({
        maskCount: masks.length,
        maskedFraction: artifact.maskedFraction ?? 0,
        scopedCount: masks.filter((m) => m.captureId !== undefined).length,
        tolerance: artifact.toleranceUsed ?? DEFAULT_DRIFT_FRACTION,
      })}.`,
    );
  } else if (artifact.toleranceUsed !== undefined && artifact.toleranceUsed !== DEFAULT_DRIFT_FRACTION) {
    console.error(
      `[loombridge trace] graded at the approved drift tolerance ${driftPercentText(artifact.toleranceUsed)}%: ` +
        `${toleranceConsentSentence(artifact.toleranceUsed)}.`,
    );
  }
  if (shouldSuggestTolerance(artifact)) {
    // THE MASK VERDICT LEADS. Masks for CONCENTRATED drift, tolerance for diffuse: both are
    // printed when both could help (P4), and the mask branch is the one that can refuse
    // outright. It goes FIRST because it is the stronger signal: it either names the region
    // and the command, or it says in so many words that no honest mask exists here, which
    // is what decides whether a tolerance is the remaining option at all. Led by the
    // tolerance line, an operator reads "widen it" and never gets to the reason.
    if (artifact.maskSuggestion) {
      for (const line of maskSuggestionLines(artifact.maskSuggestion, id)) {
        console.error(`[loombridge trace] ${line}`);
      }
    }
    for (const line of driftSuggestionLines({ ...facts, traceId: id })) {
      console.error(`[loombridge trace] ${line}`);
    }
  }
  console.error(`[loombridge trace] report → ${path.relative(root, reportJson)}`);
  if (htmlPath) console.error(`[loombridge trace] html   → ${path.relative(root, htmlPath)}`);
}

function parseArgs(args: string[]): TraceArgs | { help: true; usageError?: boolean } {
  if (args.length === 0) return { help: true, usageError: true };
  const sub = args[0];
  if (sub === "--help" || sub === "-h") return { help: true };
  if (
    sub !== "replay" &&
    sub !== "report" &&
    sub !== "approve" &&
    sub !== "replay-all" &&
    sub !== "record" &&
    sub !== "tolerance" &&
    sub !== "mask"
  ) {
    console.error(`[loombridge trace] unknown subcommand "${sub}".`);
    return { help: true, usageError: true };
  }

  let id: string | undefined;
  let root = process.cwd();
  let tracePath: string | undefined;
  let flat = false;
  let html = true;
  let strictVisual = false;
  let scene: string | undefined;
  let observe = false;
  let title: string | undefined;
  let intent: string | undefined;
  let durationSec: number | undefined;
  let outcomesPath: string | undefined;
  let stateSignal: ObserveTraceMeta["stateSignal"] | undefined;
  /** undefined ⇒ NEITHER auto flag was typed (see `resolveAutoStateSignal`). */
  let autoStateSignalFlag: boolean | undefined;
  let driftTolerance: number | undefined;
  let maskSet: MaskRect[] | undefined;
  let maskClear = false;
  let maskList = false;
  let speed: number | undefined;
  let alignedCaptureFps: number | undefined;

  /** Read a required string value for `flag`, rejecting a missing/flag-like value. */
  const value = (i: number, flag: string): string | undefined => {
    const v = args[i];
    if (v === undefined || v.startsWith("--")) {
      console.error(`[loombridge trace] ${flag} requires a value.`);
      return undefined;
    }
    return v;
  };

  for (let i = 1; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--id") {
      const v = value((i += 1), "--id");
      if (v === undefined) return { help: true, usageError: true };
      id = v;
    } else if (arg === "--root") root = path.resolve(args[(i += 1)] ?? root);
    else if (arg === "--trace") tracePath = path.resolve(args[(i += 1)] ?? "");
    else if (arg === "--flat") flat = true;
    else if (arg === "--no-html") html = false;
    else if (arg === "--strict-visual") strictVisual = true;
    else if (arg === "--observe") observe = true;
    else if (arg === "--scene") {
      const v = value((i += 1), "--scene");
      if (v === undefined) return { help: true, usageError: true };
      scene = v;
    } else if (arg === "--title") {
      const v = value((i += 1), "--title");
      if (v === undefined) return { help: true, usageError: true };
      title = v;
    } else if (arg === "--intent") {
      const v = value((i += 1), "--intent");
      if (v === undefined) return { help: true, usageError: true };
      intent = v;
    } else if (arg === "--outcomes") {
      const v = value((i += 1), "--outcomes");
      if (v === undefined) return { help: true, usageError: true };
      outcomesPath = path.resolve(v);
    } else if (arg === "--state-signal") {
      const v = value((i += 1), "--state-signal");
      if (v === undefined) return { help: true, usageError: true };
      const parsed = parseStateSignal(v);
      if (parsed === null) {
        console.error(
          `[loombridge trace] --state-signal must be <path>:<Component>:<property> (got "${v}").`,
        );
        return { help: true, usageError: true };
      }
      stateSignal = parsed;
    } else if (arg === "--auto-state-signal") {
      autoStateSignalFlag = true;
    } else if (arg === "--no-auto-state-signal") {
      autoStateSignalFlag = false;
    } else if (arg === "--speed") {
      // Replay pacing only: record observes a HUMAN whose pacing IS the demonstration,
      // approve/tolerance/report never drive the editor at all.
      if (sub !== "replay") {
        console.error(
          `[loombridge trace] --speed is only valid on \`trace replay\` (got "${sub}"). ` +
            "replay-all runs each trace at its baseline's stamped pacing.",
        );
        return { help: true, usageError: true };
      }
      const v = value((i += 1), "--speed");
      if (v === undefined) return { help: true, usageError: true };
      const n = Number(v);
      const bad = replaySpeedRefusal(Number.isFinite(n) ? n : v);
      if (bad !== null) {
        console.error(`[loombridge trace] ${bad}`);
        return { help: true, usageError: true };
      }
      speed = n;
    } else if (arg === "--aligned" || arg === "--aligned-fps") {
      // Capture clock only, and only where a capture actually happens: record observes a
      // human (whose own pacing IS the demonstration), and approve/tolerance/mask/report
      // never drive the editor. replay-all deliberately takes neither: it runs each trace
      // under the discipline its own baseline was approved under.
      if (sub !== "replay") {
        console.error(
          `[loombridge trace] ${arg} is only valid on \`trace replay\` (got "${sub}"). ` +
            "replay-all runs each trace under its baseline's stamped capture clock.",
        );
        return { help: true, usageError: true };
      }
      if (arg === "--aligned") {
        alignedCaptureFps = DEFAULT_ALIGNED_CAPTURE_FPS;
      } else {
        const v = value((i += 1), "--aligned-fps");
        if (v === undefined) return { help: true, usageError: true };
        const n = Number(v);
        // NON-COERCING at the boundary too: a value that is not a clean number is handed to
        // the refusal as the raw string, so `--aligned-fps sixty` is refused by type rather
        // than becoming NaN and slipping into a range check.
        const bad = alignedCaptureFpsRefusal(Number.isFinite(n) ? n : v);
        if (bad !== null) {
          console.error(`[loombridge trace] ${bad}`);
          return { help: true, usageError: true };
        }
        alignedCaptureFps = n;
      }
    } else if (arg === "--set" || arg === "--drift-tolerance") {
      // A6, THE VERB GUARD. These flags belong to the two ANCHOR-TERM verbs and to
      // nothing else. The parse loop is SHARED across subcommands, so without this branch
      // `--set` typed on `approve` would be accepted by the loop and silently ignored by
      // the handler: an operator would believe they had widened the gate (or masked a
      // region) while approve re-froze the drifted frames. Refuse loudly, and name the
      // verbs that do take it. `--drift-tolerance` stays tolerance-only: it names one
      // term, and accepting it on `mask` would let the two terms be typed at the verb
      // that does not stamp them.
      const owners = arg === "--set" ? ["tolerance", "mask"] : ["tolerance"];
      if (!owners.includes(sub)) {
        console.error(
          `[loombridge trace] ${arg} is only valid on \`trace tolerance\`` +
            `${owners.includes("mask") ? " or `trace mask`" : ""} (got "${sub}"). ` +
            "approve NEVER takes a tolerance or a mask: it re-freezes frames, and doing both in one " +
            "command would promote the drifted frames it was meant to keep.",
        );
        return { help: true, usageError: true };
      }
      const v = value((i += 1), arg);
      if (v === undefined) return { help: true, usageError: true };
      if (sub === "mask") {
        const rect = parseMaskRectSpec(v);
        if (rect === null) return { help: true, usageError: true };
        // --set RESTATES THE WHOLE LIST (Q4), so repeated flags in ONE invocation build
        // the list, and the next invocation starts from empty rather than appending to
        // what is already stamped.
        maskSet = [...(maskSet ?? []), rect];
      } else {
        const parsed = parseDriftTolerance(v);
        if (parsed === null) return { help: true, usageError: true };
        driftTolerance = parsed;
      }
    } else if (arg === "--clear" || arg === "--list") {
      // Same guard, same reason: on any other verb these would be accepted and ignored,
      // and "I cleared the masks" is exactly the belief that must never be wrong.
      if (sub !== "mask") {
        console.error(
          `[loombridge trace] ${arg} is only valid on \`trace mask\` (got "${sub}").`,
        );
        return { help: true, usageError: true };
      }
      if (arg === "--clear") maskClear = true;
      else maskList = true;
    } else if (arg === "--duration") {
      const v = value((i += 1), "--duration");
      if (v === undefined) return { help: true, usageError: true };
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) {
        console.error(`[loombridge trace] --duration must be a positive number of seconds (got "${v}").`);
        return { help: true, usageError: true };
      }
      durationSec = n;
    } else if (arg === "--help" || arg === "-h") return { help: true };
    else {
      console.error(`[loombridge trace] unknown argument "${arg}".`);
      return { help: true, usageError: true };
    }
  }

  // `replay-all` runs every trace, `record` DERIVES one from the scene it ends up recording
  // (see `traceIdFromScenePath`), `replay` falls back to the most recent trace (see
  // `resolveReplayTargetId`) and `approve` to the most recent REPORT (see
  // `resolveApproveTargetId`), so none of those four needs --id. The rest still require one,
  // deliberately: `tolerance` and `mask` WIDEN the gate on an existing anchor, which is the
  // most dangerous class of change this tool makes and the one that should always name its
  // target. (`report` requires one because it re-renders exactly what it is pointed at.)
  if (
    sub !== "replay-all" &&
    sub !== "record" &&
    sub !== "replay" &&
    sub !== "approve" &&
    !id
  ) {
    console.error("[loombridge trace] --id <id> is required.");
    return { help: true, usageError: true };
  }
  // `--id` becomes directory and file names (and the trace READ path) — never
  // let it traverse outside `.loombridge/replays/`.
  if (id !== undefined && !isSafePathSegment(id)) {
    console.error(
      `[loombridge trace] --id must not contain path separators or '..' (got "${id}").`,
    );
    return { help: true, usageError: true };
  }
  // `tolerance` without a value has nothing to stamp: refuse rather than write a manifest
  // whose terms the operator never stated.
  if (sub === "tolerance" && driftTolerance === undefined) {
    console.error(
      "[loombridge trace] tolerance requires --set <fraction> (e.g. --set 0.015; 0 demands pixel exactness).",
    );
    return { help: true, usageError: true };
  }
  // `mask` takes EXACTLY ONE mode. Combining them is ambiguous in the dangerous
  // direction: `--set A --clear` would either stamp A or stamp nothing, and an operator
  // who guessed wrong ends up believing a region is masked when it is graded, or graded
  // when it is masked.
  if (sub === "mask") {
    const modes = [maskSet !== undefined, maskClear, maskList].filter(Boolean).length;
    if (modes === 0) {
      console.error(
        "[loombridge trace] mask requires exactly one of --set <captureId?>:<x>,<y>,<w>x<h>@<reason> " +
          "(repeatable; it restates the WHOLE list), --clear, or --list.",
      );
      return { help: true, usageError: true };
    }
    if (modes > 1) {
      console.error(
        "[loombridge trace] mask takes exactly one of --set, --clear or --list, never a combination.",
      );
      return { help: true, usageError: true };
    }
  }
  // `record` takes NOTHING mandatory. `--observe` used to be required as "the only recording
  // mode in v1", which is ceremony documenting an alternative nobody built; it is still
  // ACCEPTED (every doc, script and muscle-memory invocation keeps working) and simply
  // ignored, with no deprecation noise on the happy path.
  if (sub === "record") {
    // `--scene` is OPTIONAL: when omitted, the recorder resolves the editor's CURRENT scene and resets to
    // it (the scene-agnostic flow), or refuses if it's unsaved. When given, it must be a real scene path.
    if (scene !== undefined && !isScenePath(scene)) {
      console.error(`[loombridge trace] --scene '${scene}' must be an Assets/**.unity path.`);
      return { help: true, usageError: true };
    }
  }
  return {
    sub,
    id: id ?? "",
    root,
    tracePath,
    flat,
    html,
    strictVisual,
    scene,
    observe,
    title,
    intent,
    durationSec,
    outcomesPath,
    stateSignal,
    // Only `record` observes anything, so only `record` gets the default-ON resolution;
    // everywhere else the field is a literal reading of what was typed.
    autoStateSignal:
      sub === "record"
        ? resolveAutoStateSignal(autoStateSignalFlag, stateSignal !== undefined)
        : autoStateSignalFlag === true,
    driftTolerance,
    maskSet,
    maskClear,
    maskList,
    speed,
    alignedCaptureFps,
  };
}

/**
 * Parse ONE `--set` mask spec: `[<captureId>:]<x>,<y>,<w>x<h>@<reason>`. Returns null
 * (after printing the refusal) when the shape is wrong.
 *
 * The `@reason` is MANDATORY and parsed here rather than defaulted, because a default
 * reason is a reason nobody typed, and the whole audit value of a mask is that a human
 * said why. Geometry validity (positive, in bounds, under the cap) is NOT decided here:
 * that is {@link maskRefusal}'s job, called once at the stamp with the frame dimensions
 * it needs, so this parser can never grow a second, laxer copy of the rules.
 */
export function parseMaskRectSpec(raw: string): MaskRect | null {
  const at = raw.indexOf("@");
  if (at < 0) {
    console.error(
      `[loombridge trace] --set needs a reason: <captureId?>:<x>,<y>,<w>x<h>@<reason> (got "${raw}"). ` +
        "A masked region is never graded again, so the anchor records why in the operator's own words.",
    );
    return null;
  }
  const geometry = raw.slice(0, at);
  const reason = raw.slice(at + 1).trim();
  if (reason.length === 0) {
    console.error(`[loombridge trace] --set has an empty reason (got "${raw}").`);
    return null;
  }
  const colon = geometry.indexOf(":");
  const captureId = colon < 0 ? undefined : geometry.slice(0, colon);
  const rect = colon < 0 ? geometry : geometry.slice(colon + 1);
  if (captureId !== undefined && (captureId.length === 0 || !isSafePathSegment(captureId))) {
    console.error(
      `[loombridge trace] --set has an unusable capture id "${captureId}" (it names a capture, so it must be a plain id).`,
    );
    return null;
  }
  const match = /^(\d+),(\d+),(\d+)x(\d+)$/.exec(rect.trim());
  if (match === null) {
    console.error(
      `[loombridge trace] --set geometry must be <x>,<y>,<w>x<h> in whole pixels (got "${rect}").`,
    );
    return null;
  }
  return {
    x: Number(match[1]),
    y: Number(match[2]),
    w: Number(match[3]),
    h: Number(match[4]),
    reason,
    ...(captureId !== undefined ? { captureId } : {}),
  };
}

/**
 * Parse + range-check a `--set` value, printing the refusal itself. Returns null when
 * the value is refused (the caller exits 2).
 *
 * NON-COERCING (F9), because `Number()` is generous in all the wrong directions:
 * `Number("")` and `Number(" ")` are 0 (a silent "demand pixel exactness" the operator
 * never typed), `Number("2%")` is NaN, and `Number("1e400")` is Infinity. Every one of
 * those is a refusal here. Exact 0 typed deliberately IS valid: it is stricter than the
 * default, so it can only ever cause more refusals.
 */
function parseDriftTolerance(raw: string): number | null {
  if (raw.trim().length === 0 || !/^\d+(\.\d+)?$/.test(raw.trim())) {
    console.error(
      `[loombridge trace] --set must be a fraction between 0 and ${MAX_DRIFT_TOLERANCE} ` +
        `(e.g. 0.015 for 1.5%), got "${raw}".`,
    );
    return null;
  }
  const n = Number(raw.trim());
  // ONE PREDICATE, BOTH SIDES. The range refusal is the manifest READER's own
  // (`toleranceRefusal`), called here rather than restated: a second comparison against
  // the same constant is how a stamp-time cap and a read-time cap drift apart, and the
  // read side is the one that has to hold, because the manifest is a file an operator can
  // edit. Refusing with the same sentence also means the CLI and a broken-row report say
  // the same thing about the same number.
  const refusal = toleranceRefusal(n, "--set");
  if (refusal !== null) {
    console.error(`[loombridge trace] ${refusal}.`);
    return null;
  }
  return n;
}

function printUsage(): void {
  console.error(
    [
      "Usage: loombridge trace <record|replay|replay-all|approve|tolerance|mask|report> [--id <id>] [options]",
      "",
      "  record      Record a human demonstration into a replayable trace: reset to --scene",
      "              (or the editor's CURRENT scene), observe your clicks/drags until you",
      "              press Enter (or --duration <sec>), and write",
      "              .loombridge/replays/traces/<id>.trace.json. Takes no required flags:",
      "              bare `trace record` records the current scene under an id kebab-cased",
      "              from its name (Assets/Scenes/KidsChef.unity → kids-chef), and a DERIVED",
      "              id never overwrites: an existing kids-chef becomes kids-chef-2, printed.",
      "  replay      Drive .loombridge/replays/traces/<id>.trace.json against the running",
      "              editor and write .loombridge/replays/reports/<id>.report.{json,html},",
      "              diffing each capture against its approved baseline. Takes no required",
      "              flags: bare `trace replay` replays the MOST RECENT trace (newest mtime,",
      "              ties broken by name), announced before it drives, so `trace record` then",
      "              `trace replay` is the whole loop; --trace <path> wins over that search.",
      "              --speed <1..8> replays faster than the demonstration (recorded settles",
      "              divided, floored at 250ms); the pacing is stamped into the report and, at",
      "              approve, into the baseline, and a replay at a pacing other than the",
      "              baseline's REFUSES the pixel comparison (phase skew is not drift).",
      "  replay-all  Replay EVERY trace under .loombridge/replays/traces/ and write a",
      "              roll-up .loombridge/replays/fleet.report.{json,html}. Exit by worst tier.",
      "  approve     Promote the latest run's captures to the approved baseline",
      "              (.loombridge/replays/baselines/<id>/). Never takes a tolerance, and",
      "              refuses a run with an unreadable capture (a capture gap is not an anchor).",
      "              Takes no required flags: bare `trace approve` freezes the MOST RECENT",
      "              RUN, i.e. the newest <id>.report.json (ties broken by name), announced",
      "              with the number of captures it is about to freeze. It searches REPORTS,",
      "              not traces: the referent is the run you just replayed, and a trace that",
      "              was never replayed has nothing to promote.",
      "  tolerance   Stamp the human-approved pixel drift tolerance onto the EXISTING",
      "              approved baseline (--set <fraction>). Touches no frame and no sha: it",
      "              changes the terms of the comparison, not the thing being compared.",
      "  mask        Stamp the human-approved EXCLUDED REGIONS onto the EXISTING approved",
      "              baseline (--set <captureId?>:<x>,<y>,<w>x<h>@<reason>, repeatable;",
      "              --clear; --list). The localized fix a tolerance cannot be: the masked",
      "              rects are blanked in BOTH images so they cannot differ, while the rest",
      "              of the frame keeps grading at full strictness. Touches no frame and no",
      `              sha, capped at ${driftPercentText(MAX_MASKED_FRACTION)}% of any one frame, and every rect needs a`,
      "              @reason (a region nobody grades again has to say why in the anchor).",
      "  report      Re-render the HTML report from an existing <id>.report.json.",
      "",
      "Options:",
      "  --id <id>         Trace id. Required except for replay-all (runs every trace),",
      "                    record (derives one from the recorded scene when omitted), replay",
      "                    (replays the most recent trace when omitted) and approve (freezes",
      "                    the most recent RUN when omitted). A given --id records over that",
      "                    trace; a DERIVED one never does. tolerance and mask ALWAYS require",
      "                    it: they WIDEN the gate on an existing anchor, which is the most",
      "                    dangerous change here and the one that must name its target.",
      "  --root <dir>      Project root containing .loombridge/ (default: cwd).",
      "  --trace <path>    Override the trace input path (replay only). It names an exact",
      "                    file, so it wins over the most-recent search; with no --id the",
      "                    trace's own id names the report.",
      "  --flat            Lay replay artifacts directly under --root (traces/, reports/,",
      "                    baseline/) with no nested .loombridge/ — the mini-game workspace layout.",
      "  --no-html         Skip the HTML report. Any page from an earlier run is REMOVED",
      "                    rather than left beside this run's verdict; `trace report --id`",
      "                    renders one from the report on disk whenever you want it.",
      "  --strict-visual   Make a visual drift from baseline a failure.",
      "  --speed <n>       replay only: pacing multiplier, 1 to 8 (default: the baseline's",
      "                    stamped pacing, else 1).",
      "  --aligned         replay only: CAPTURE-ALIGNED settles at 60 fps. Each settle runs",
      "                    inside the bridge's pinned tick loop and the frame is taken on the",
      "                    frame the settle completes, so the capture lands at the same GAME",
      "                    TIME every run instead of wherever a wall-clock sleep left it.",
      `  --aligned-fps <n> replay only: the same, at n fps (${MIN_ALIGNED_CAPTURE_FPS} to ${MAX_ALIGNED_CAPTURE_FPS}, integer).`,
      "                    Default: the baseline's stamped capture clock, else wall-clock.",
      "                    A run whose clock differs from the baseline's REFUSES the pixel",
      "                    comparison (phase skew is not drift). Alignment covers the SETTLE",
      "                    only: action round trips, anchor polling, unseeded randomness and",
      "                    realtime-driven animation are all still unaligned.",
      `  --set <fraction>  tolerance: the approved pixel drift allowance, 0 to ${MAX_DRIFT_TOLERANCE}`,
      `                    (${driftPercentText(MAX_DRIFT_TOLERANCE)}% cap; default when never stamped is ` +
        `${driftPercentText(DEFAULT_DRIFT_FRACTION)}%). At N%, anything covering`,
      "                    ~sqrt(N)% of frame width by ~sqrt(N)% of height can change undetected,",
      "                    so it is a consented hole of a stated size, not a knob. A tolerance is a",
      "                    hole ANYWHERE in the frame; `trace mask` is the localized alternative.",
      "  --set <captureId?>:<x>,<y>,<w>x<h>@<reason>",
      "                    mask: one excluded region, repeatable. Each invocation RESTATES the whole",
      "                    list, so a mask set can never grow one unnoticed rect at a time; an absent",
      "                    captureId means every capture in the trace. The reason is mandatory.",
      "  --clear           mask ONLY: stamp an empty list (the whole frame is graded again).",
      "  --list            mask ONLY: print the approved masks and their terms. Touches nothing.",
      "                    --set/--clear/--list are refused on every other subcommand: approve",
      "                    re-freezes frames, so widening the gate and re-approving in one command",
      "                    would destroy the anchor.",
      "  --observe         record: accepted and ignored. Observing a human session is the only",
      "                    recording mode, so there is nothing to select; older invocations",
      "                    that pass it keep working unchanged.",
      "  --scene <path>    record: scene to reset to and record from (optional: when omitted,",
      "                    the recorder resolves the editor's CURRENT scene, refusing if unsaved).",
      "  --duration <sec>  record: auto-stop after N seconds instead of waiting for Enter.",
      "  --outcomes <file> record: JSON OutcomeSpec[] to pin as end-state assertions.",
      "  --state-signal <path>:<Component>:<property>",
      "                    record: gate each gesture on this game state field (e.g.",
      "                    /Canvas/GM:ChefGameManager:phase) so replay waits for the game",
      "                    to reach the consumable state, not just for the target to appear.",
      "                    Declaring one turns auto-detection OFF (see below).",
      "  --auto-state-signal / --no-auto-state-signal",
      "                    record: AUTO-DETECT each scene's state signal live and switch on",
      "                    scene-change (per-scene gates for a hub→game recording, no manual",
      "                    --state-signal). Detection is additive: finding nothing leaves the",
      "                    gesture ungated, exactly as before. Precedence:",
      "                      neither flag, no --state-signal  → auto detection ON (default)",
      "                      --state-signal alone             → the declared signal wins, auto OFF",
      "                      --auto-state-signal              → auto ON, and it still takes",
      "                                                         precedence over --state-signal",
      "                      --no-auto-state-signal           → auto OFF, whatever else is typed",
      "  --title <text>    record: human-readable trace title.",
      "  --intent <text>   record: what the trace is meant to verify.",
      "",
      "Exit: 0 pass · 1 game defect: fail/error (or drift with --strict-visual)",
      "      2 harness fault: blocked (undrivable), an unreadable capture/baseline PNG,",
      "        a baseline manifest that cannot be trusted at grade time (including one",
      "        carrying an over-cap drift tolerance), an unreachable editor, or a usage",
      "        error. A harness fault is never reported as a game defect.",
      "      tolerance/mask: 0 stamped, or (for the read-only `mask --list`) printed: it",
      "        stamps nothing and still exits 0 · 1 no approved baseline to stamp (approve",
      "        frames first) · 2 the baseline manifest exists but cannot be trusted, the",
      "        approved frames cannot be decoded, or the rects are refused (out of bounds,",
      `        no reason, or over the ${driftPercentText(MAX_MASKED_FRACTION)}% masked-area cap). A refused stamp writes`,
      "        nothing, and `--list` refuses to quote the terms of an untrusted anchor.",
      "      A run that failed ONLY on pixel drift prints the observed max drift and the",
      "      exact `trace tolerance` command to consent to it. That suggestion never",
      "      appears for an unreadable capture: a harness fault is not drift.",
      "      The same run may also print a MASK suggestion, but only after TWO runs whose",
      "      drift lands in the same region and does NOT reproduce between them",
      "      (nondeterministic ambient animation). Reproduction is structural, not byte",
      `      equality: at or above ${driftPercentText(REPRODUCED_DRIFT_SIMILARITY)}% of the drifted pixels landing in the same cells`,
      "      of a 16x16 grid, the drift is called deterministic and the tool says so instead",
      "      of naming a rect, so re-running until the bitmaps differ buys nothing. A",
      "      diffuse drift says masks cannot cover it honestly, naming which of the three",
      "      bounds it broke. Nothing is ever applied.",
    ].join("\n"),
  );
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One decimal place, with a whole number printed whole (250, not 250.0). */
function round1(ms: number): number {
  return Math.round(ms * 10) / 10;
}
