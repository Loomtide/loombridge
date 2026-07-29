/**
 * `loombridge trace` — Replay Verification product surface.
 *
 *   loombridge trace replay --id <id> [--root <dir>] [--trace <path>] [--no-html]
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
  toleranceConsentSentence,
  type AnchorTerms,
  type CaptureDriftEvidence,
  type DriftFacts,
  type MaskRect,
  type MaskSuggestion,
} from "./visual-diff.js";
import { isScenePath } from "../minigame/profiles/types.js";
import { runLiveReplay } from "./run-live.js";
import { resolveCliProjectPin } from "../setup/cli-project-pin.js";
import {
  flatReplayLayout,
  standardReplayLayout,
  type ReplayLayout,
} from "../../domain/state.js";
import { unityConnectionHint } from "../../shared/cli-ui.js";
import { printNextStep } from "../minigame/minigame-next.js";
import { readPng } from "../verification/analyze-frames.js";

interface TraceArgs {
  sub: "replay" | "report" | "approve" | "replay-all" | "record" | "tolerance" | "mask";
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
  // ── record --observe ──
  /** Scene to reset to + record from (record only; optional: absent resolves the editor's current scene). */
  scene?: string;
  /** Recording mode flag — v1 records by observing a human session. */
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
   * `--auto-state-signal`: ask the observer to AUTO-DETECT each scene's state signal live and switch
   * on scene-change (Phase 2 / D1-B). The hands-off path for multi-gesture-scene games (e.g. the
   * scene-agnostic `minigame check` passes it). Takes precedence over `--state-signal`.
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
 * The honest notice lines for gestures the observer saw but did NOT record. Both counts
 * are losses the human would otherwise have to guess at:
 *
 * - `droppedNoTarget`: the tap hit no interactive element (backdrop / decoration), so the
 *   game had nothing to run.
 * - `droppedUnfocused`: the Game view did not have input focus, so the EDITOR swallowed the
 *   tap and the game never received it. Recording it would mint a phantom step that replay
 *   (clean reset + focus-independent virtual input) cannot reproduce.
 *
 * A zero count prints nothing. A bridge older than the focus backstop reports no
 * `droppedUnfocused` at all, which reads as 0, so its output is unchanged. Pure;
 * exported for unit tests.
 */
export function observeDropNotices(counts: {
  droppedNoTarget: number;
  droppedUnfocused?: number;
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
  return lines;
}

/** Resolve the replay layout from `--root` + the `--flat` flag. */
function layoutFor(args: TraceArgs): ReplayLayout {
  return args.flat ? flatReplayLayout(args.root) : standardReplayLayout(args.root);
}

export async function run(args: string[]): Promise<number> {
  const parsed = parseArgs(args);
  if ("help" in parsed) {
    printUsage();
    return parsed.usageError ? 2 : 0;
  }
  try {
    if (parsed.sub === "replay") return await runReplay(parsed);
    if (parsed.sub === "replay-all") return await runReplayAll(parsed);
    if (parsed.sub === "approve") return await runApprove(parsed);
    if (parsed.sub === "tolerance") return await runTolerance(parsed);
    if (parsed.sub === "mask") return await runMask(parsed);
    if (parsed.sub === "record") return await runRecord(parsed);
    return await runReport(parsed);
  } catch (error) {
    const hint = unityConnectionHint(error);
    if (hint) {
      // An unreachable editor is a HARNESS fault, never a game verdict: exit 2, the same
      // tier a blocked replay reports. (S1 final test flagged this verb as the one trace
      // door still mapping the condition to 1.)
      console.error(hint.join("\n"));
      return 2;
    }
    console.error(`[loombridge trace] fatal: ${message(error)}`);
    return 1;
  }
}

async function runReplay(args: TraceArgs): Promise<number> {
  const paths = layoutFor(args);
  const { artifact, reportJson, htmlPath } = await replayOneTrace(paths, args.id, {
    tracePath: args.tracePath,
    html: args.html,
    projectPathCanonical: resolveCliProjectPin({ root: args.root }),
    speed: args.speed,
  });
  printSummary(args.root, args.id, artifact, reportJson, htmlPath, args.strictVisual);
  // In the mini-game workspace flow (--flat), print the EXACT next command to run.
  if (args.flat) await printNextStep(args.root);
  return replayExitCode(artifact, args.strictVisual);
}

/**
 * Record a human demonstration into a replayable trace. Resets to a clean
 * Play-Mode start at `--scene`, observes the human's clicks/drags until they
 * signal done (press Enter, or `--duration <sec>`), captures any `--outcomes`,
 * and writes `.loombridge/replays/traces/<id>.trace.json` (green by construction).
 */
async function runRecord(args: TraceArgs): Promise<number> {
  const paths = layoutFor(args);
  const meta: ObserveTraceMeta = {
    id: args.id,
    // Empty when no --scene was given ⇒ recordObservedTrace resolves the editor's active scene (#295).
    scene: args.scene ?? "",
    ...(args.title ? { title: args.title } : {}),
    ...(args.intent ? { intent: args.intent } : {}),
    // The declared state signal (already validated/split in parseArgs): observe_start
    // samples it per gesture and the transform gates each gesture on it.
    ...(args.stateSignal ? { stateSignal: args.stateSignal } : {}),
    // Phase 2 / D1-B: auto-detect each scene's signal live (overrides a declared signal).
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
        readEnter(
          "[loombridge trace] ▶ Switch to Unity, play your flow, then press Enter here to stop… ",
        );
  // Race the stop signal against Ctrl-C so a cancel still runs cleanup (the
  // `finally` in observeRecordLive stops Play and returns the editor to edit mode)
  // rather than stranding the editor in Play Mode.
  const waitForStop = withSigintCancel(baseStop);

  // State intent, not a completed action: the connection has not been attempted yet, and
  // announcing "resetting" before it exists reads as a step that never happened when the
  // editor is unreachable (S1 final test, LOW-3).
  console.error(
    `[loombridge trace] recording "${args.id}": connecting to Unity, then resetting ${args.scene ?? "the current scene"} to a clean Play-Mode start…`,
  );
  const { trace, droppedNoTarget, droppedUnfocused } = await observeRecordLive(meta, {
    waitForStop,
    outcomes,
    projectPathCanonical: resolveCliProjectPin({ root: args.root }),
  });

  await fs.mkdir(paths.replayTraces, { recursive: true });
  const traceFile = path.join(paths.replayTraces, `${args.id}.trace.json`);
  await fs.writeFile(traceFile, `${JSON.stringify(trace, null, 2)}\n`, "utf-8");

  const steps = trace.segments.length;
  const outcomeCount = trace.assertions?.length ?? 0;
  // Honest, not silent: gestures the observer saw but did not record (inert target, or a
  // tap the editor swallowed while the Game view was unfocused) are reported, not a mystery.
  for (const notice of observeDropNotices({ droppedNoTarget, droppedUnfocused })) {
    console.error(notice);
  }
  console.error(
    `[loombridge trace] recorded "${args.id}": ${steps} step(s), ${outcomeCount} outcome(s) → ${path.relative(args.root, traceFile)}`,
  );
  // In the mini-game workspace flow (--flat), print the EXACT next command to run (capture).
  // Otherwise give the generic replay hint (the standard-layout trace flow).
  if (args.flat) {
    await printNextStep(args.root);
  } else {
    console.error(`[loombridge trace] replay it: loombridge trace replay --id ${args.id}`);
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
 * renders a stable frame before capture. Pure; exported for unit tests. Actions and
 * wait-for-visible timeouts are NOT scaled: readiness gates are about the game, not the
 * human's pacing.
 */
export function scaleTraceSettles<T extends { segments: { captures?: { settleMs?: number }[] }[] }>(
  trace: T,
  speed: number,
): T {
  if (speed <= 1) return trace;
  for (const segment of trace.segments) {
    for (const capture of segment.captures ?? []) {
      if (typeof capture.settleMs === "number") {
        capture.settleMs = Math.max(MIN_SCALED_SETTLE_MS, capture.settleMs / speed);
      }
    }
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
): Promise<{ speed: number; mismatchWith?: number }> {
  const baselineDir = path.join(paths.replayBaselines, id);
  const manifest = await loadTraceBaselineManifest(baselineDir);
  const stamped =
    manifest !== null && !isTraceBaselineManifestError(manifest) ? (manifest.replaySpeed ?? 1) : undefined;
  if (explicit !== undefined && stamped !== undefined && explicit !== stamped) {
    // An explicit pacing that contradicts the stamped baseline still RUNS (the replay is
    // how a report at the new pacing comes to exist, and refusing here would make
    // re-pacing impossible without hand-deleting the baseline), but the pixel gate for
    // this run is a harness fault, announced up front and again by applyVisualDiff.
    console.error(
      `[loombridge trace] pacing differs from the baseline (approved ${stamped}x, running ${explicit}x): ` +
        `the pixel gate is NOT graded this run; approve from this report to re-anchor at ${explicit}x.`,
    );
    return { speed: explicit, mismatchWith: stamped };
  }
  return { speed: explicit ?? stamped ?? 1 };
}

async function replayOneTrace(
  paths: ReplayLayout,
  id: string,
  opts: { tracePath?: string; html: boolean; projectPathCanonical?: string; speed?: number },
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
  if (speed > 1) {
    scaleTraceSettles(trace, speed);
    console.error(`[loombridge trace] replaying at ${speed}x pacing (recorded settles scaled, floor ${MIN_SCALED_SETTLE_MS}ms).`);
  }

  const captureDir = path.join(paths.replayReports, id, "actual");
  const artifact = await runLiveReplay(trace, {
    captureDir,
    projectPathCanonical: opts.projectPathCanonical,
  });
  // The pacing is part of the evidence: a baseline approved from this report inherits it,
  // and applyVisualDiff refuses a pacing mismatch instead of grading phase skew.
  artifact.replaySpeed = speed;
  // Visual regression: compare each capture to its approved baseline (if any).
  await applyVisualDiff(paths, id, artifact);

  const reportJson = path.join(paths.replayReports, `${id}.report.json`);
  await fs.writeFile(reportJson, `${JSON.stringify(artifact, null, 2)}\n`, "utf-8");
  const htmlPath = opts.html ? await writeHtmlReport(paths, id, artifact) : undefined;
  return { artifact, reportJson, htmlPath };
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

/** Promote the latest run's captures to the approved baseline for this trace. */
async function runApprove(args: TraceArgs): Promise<number> {
  const paths = layoutFor(args);
  const reportJson = path.join(paths.replayReports, `${args.id}.report.json`);
  const rel = path.relative(args.root, reportJson);

  let raw: string;
  try {
    raw = await fs.readFile(reportJson, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      console.error(`[loombridge trace] no report at ${rel} — run 'trace replay --id ${args.id}' first.`);
      return 1;
    }
    throw error;
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!isReplayRunArtifact(parsed)) {
    console.error(`[loombridge trace] ${rel} is not a valid replay report.`);
    return 1;
  }

  // An approval is a PROVENANCE record, not just a file copy: it has to say which
  // demonstration these frames belong to. Read the trace bytes first and refuse
  // (harness tier) if they are gone: a baseline that cannot name its trace is not
  // an anchor, and unified `verify` would have to treat it as unstamped anyway.
  const traceFile = path.join(paths.replayTraces, `${args.id}.trace.json`);
  let traceSha256: string;
  try {
    traceSha256 = sha256(await fs.readFile(traceFile));
  } catch (error) {
    console.error(
      `[loombridge trace] cannot approve "${args.id}": its trace is unreadable at ` +
        `${path.relative(args.root, traceFile)} (${message(error)}). An approved baseline must bind to the demonstration it froze.`,
    );
    return 2;
  }

  const baselineDir = path.join(paths.replayBaselines, args.id);

  // The approved TOLERANCE survives a re-freeze (A1). Approve replaces frames, and the
  // tolerance is a separate human decision about this trace's animation, so silently
  // resetting it to the default here would mean every re-approve quietly re-tightened a
  // gate the operator had consented to widen, and the next replay would fail with a
  // suggestion to widen it again. An UNREADABLE previous manifest carries nothing
  // forward and says so: a tolerance nobody can read is not a tolerance anybody approved.
  const previousLoaded = await loadTraceBaselineManifest(baselineDir);
  let previous: TraceBaselineManifest | null = null;
  if (isTraceBaselineManifestError(previousLoaded)) {
    console.error(
      `[loombridge trace] note: the existing ${TRACE_BASELINE_MANIFEST} is unreadable ` +
        `(${previousLoaded.error}); re-stamping from scratch at the default tolerance.`,
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
      `[loombridge trace] cannot approve "${args.id}": ${unreadable.length} capture(s) in the latest run ` +
        `could not be decoded (${unreadable.join(", ")}). A capture gap is a harness fault, never an anchor.`,
    );
    console.error(
      `[loombridge trace]   re-run \`loombridge trace replay --id ${args.id}\`; if the APPROVED BASELINE is the ` +
        `unreadable half (the replay output names which), remove ${path.relative(args.root, baselineDir)} and approve again.`,
    );
    return 2;
  }

  // MASKS ARE RE-VALIDATED AGAINST THE FRAMES THIS APPROVE IS FREEZING (Q1), BEFORE a
  // single byte is written. A re-freeze at a new resolution leaves every approved rect
  // pointing at pixels that are no longer where the human put them, and the two silent
  // options are both wrong: dropping the masks un-blinds a region an operator consented
  // to hide (the next replay fails, and the suggestion tells them to mask it again),
  // while keeping them re-interprets a human decision against a frame they never saw.
  // Refuse instead, and name the verb that owns the decision.
  const carried = carryForward(previous);
  if ((carried.maskRects?.length ?? 0) > 0) {
    const dims = await captureFrameDims(parsed, paths);
    if ("error" in dims) {
      console.error(
        `[loombridge trace] cannot approve "${args.id}" while masks are stamped: ${dims.error}. ` +
          `Clear them first (\`loombridge trace mask --id ${args.id} --clear\`) or fix the capture.`,
      );
      return 2;
    }
    const refusal = maskRefusal(carried.maskRects, dims.width, dims.height);
    if (refusal !== null) {
      console.error(
        `[loombridge trace] cannot approve "${args.id}": the ${carried.maskRects!.length} approved mask(s) no longer ` +
          `fit the frames being frozen (${dims.width}x${dims.height}): ${refusal}.`,
      );
      console.error(
        `[loombridge trace]   re-state them for the new frames with \`loombridge trace mask --id ${args.id} --set ...\`, ` +
          `or drop them with \`--clear\`. A re-freeze never reinterprets a mask a human approved.`,
      );
      return 2;
    }
    // The dims travel with the frames: the masks were just proven against THESE.
    carried.frameWidth = dims.width;
    carried.frameHeight = dims.height;
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
    traceId: args.id,
    traceSha256,
    approvedAt: new Date().toISOString(),
    sourceReportSha256: sha256(raw),
    pngs,
    // Q6: ONE helper names every preserved field, for all three writers.
    ...carried,
    ...nextApprovalLedger(previous),
  };
  // The pacing the promoted frames were captured at rides the REPORT into the anchor, so
  // approve re-derives it rather than carrying the old value: these frames really were
  // captured at this pacing, and inheriting the previous one would mislabel them and
  // break the "approve from this report to re-anchor at 1x" escape hatch.
  const promotedSpeed = (parsed as ReplayRunArtifact).replaySpeed ?? 1;
  if (promotedSpeed !== 1) manifest.replaySpeed = promotedSpeed;
  else delete manifest.replaySpeed;
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
    console.error(`[loombridge trace] ${manifestRel}: ${current.length} approved mask(s).`);
    for (const rect of current) {
      console.error(
        `[loombridge trace]   ${rect.captureId ?? "(every capture)"} ${formatRectGeometry(rect)} reason: ${rect.reason}`,
      );
    }
    console.error(
      `[loombridge trace] ${anchorTermsSentence(manifestAnchorTerms(loaded)) ?? NO_MASKS_DEFAULT_TERMS}.`,
    );
    if (loaded.maskedFractionHistory?.length) {
      console.error(
        `[loombridge trace] mask history: ${loaded.maskedFractionHistory.map((f) => `${driftPercentText(f)}%`).join(" → ")}.`,
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

  console.error(
    `[loombridge trace] stamped ${manifestRel}: ${current.length} → ${rects.length} mask(s), masked ` +
      `${driftPercentText(before)}% to ${driftPercentText(after)}% of the frame ` +
      `(approval #${stamped.approvalCount}, ${stamped.pngs.length} frame(s) untouched).`,
  );
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
 * per-trace JSON report, and the tier that replay earns. No HTML (the unified
 * report links the JSON), no argv, no `TraceArgs` (the verb's argv shape stays
 * private so the orchestrator cannot grow a second, drifting CLI).
 *
 * The unified flow always passes `strictVisual: true` (S1 amendment A5: pixel-drift
 * gating is the DEFAULT there: an approved pixel baseline that a human froze is an
 * anchor, so drifting from it is a result, not a warning). The `trace` verb's own
 * default is unchanged.
 */
export async function replayTraceForVerify(
  layout: ReplayLayout,
  id: string,
  opts: { strictVisual: boolean; projectPathCanonical?: string },
): Promise<{
  artifact: ReplayRunArtifact;
  reportJson: string;
  exitTier: number;
  /** A3: the drift facts, so the unified section reports numbers instead of a bare tier. */
  drift: DriftFacts;
  /**
   * Q3: the mask verdict for this run, derived once in `applyVisualDiff` and carried to
   * whichever door is printing. Absent when nothing drifted.
   */
  maskSuggestion?: MaskSuggestion;
}> {
  const { artifact, reportJson } = await replayOneTrace(layout, id, {
    html: false,
    projectPathCanonical: opts.projectPathCanonical,
  });
  return {
    artifact,
    reportJson,
    exitTier: replayExitCode(artifact, opts.strictVisual),
    drift: driftFacts(artifact),
    ...(artifact.maskSuggestion ? { maskSuggestion: artifact.maskSuggestion } : {}),
  };
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
  let baselineFault: string | null = null;
  if (integrity.unstamped) {
    // Legacy baseline (or none yet): default terms, no fault.
  } else if (!integrity.ok) {
    baselineFault = integrity.failures.join("; ");
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
        baselineFault = `masks are stamped but ${dims.error}`;
      } else if (dims.width !== frameWidth || dims.height !== frameHeight) {
        baselineFault =
          `the masks were approved against a ${frameWidth}x${frameHeight} frame but the approved frames are ` +
          `${dims.width}x${dims.height}; re-state them with \`loombridge trace mask --id ${id} --set ...\`, ` +
          `or drop them with \`--clear\``;
      }
    }
    // Pacing mismatch is a HARNESS refusal, not drift: frames captured at different
    // pacings sit at different animation phases, and grading them against each other
    // reads phase skew as drift (or hides real drift behind it).
    const stampedSpeed = integrity.manifest!.replaySpeed ?? 1;
    const runSpeed = artifact.replaySpeed ?? 1;
    if (stampedSpeed !== runSpeed) {
      baselineFault =
        `the baseline was approved at ${stampedSpeed}x pacing but this run replayed at ` +
        `${runSpeed}x; re-run at ${stampedSpeed}x, or approve from this run's report to re-anchor at ${runSpeed}x`;
    }
  }
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
  let anyCompared = false;
  const evidence: CaptureDriftEvidence[] = [];
  for (const segment of artifact.segments) {
    for (const capture of segment.captures) {
      if (!capture.artifact) continue;
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
        evidence.push({
          captureId: capture.id,
          drifted: diff.status === "drift",
          ...(diff.driftDiffSha !== undefined ? { driftDiffSha: diff.driftDiffSha } : {}),
          ...(diff.driftBounds !== undefined ? { driftBounds: diff.driftBounds } : {}),
          ...(diff.driftClusters !== undefined ? { driftClusters: diff.driftClusters } : {}),
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
  if (anyUnreadable || baselineFault !== null) artifact.visualHarnessFault = true;
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
    const suggestion = deriveMaskSuggestion(evidence, previousEvidence, dims.frameWidth, dims.frameHeight);
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

  const htmlPath = await writeHtmlReport(paths, args.id, artifact);
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

/** Load the capture PNGs and render the self-contained HTML next to the JSON. */
async function writeHtmlReport(
  paths: ReplayLayout,
  id: string,
  artifact: ReplayRunArtifact,
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
      ...(anchor?.frameWidth !== undefined ? { frameWidth: anchor.frameWidth } : {}),
      ...(anchor?.frameHeight !== undefined ? { frameHeight: anchor.frameHeight } : {}),
      anchorTerms: anchorTermsSentence(
        maskAnchorTerms(
          maskRects,
          anchor?.frameWidth ?? 0,
          anchor?.frameHeight ?? 0,
          artifact.toleranceUsed ?? DEFAULT_DRIFT_FRACTION,
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

function printSummary(
  root: string,
  id: string,
  artifact: ReplayRunArtifact,
  reportJson: string,
  htmlPath: string | undefined,
  strictVisual: boolean,
): void {
  const blocked = artifact.blockedReason ? ` (${artifact.blockedReason})` : "";
  console.error(`[loombridge trace] ${id}: ${artifact.status.toUpperCase()}${blocked}`);
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
    for (const line of driftSuggestionLines({ ...facts, traceId: id })) {
      console.error(`[loombridge trace] ${line}`);
    }
    // Masks for CONCENTRATED drift, tolerance for diffuse: both are printed when both
    // could help (P4), and the mask branch is the one that can refuse outright.
    if (artifact.maskSuggestion) {
      for (const line of maskSuggestionLines(artifact.maskSuggestion, id)) {
        console.error(`[loombridge trace] ${line}`);
      }
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
  let autoStateSignal = false;
  let driftTolerance: number | undefined;
  let maskSet: MaskRect[] | undefined;
  let maskClear = false;
  let maskList = false;
  let speed: number | undefined;

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
      autoStateSignal = true;
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

  // `replay-all` runs every trace, so it needs no --id; the others require one.
  if (sub !== "replay-all" && !id) {
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
  // `record` needs a scene to reset to and (v1) the --observe mode flag.
  if (sub === "record") {
    if (!observe) {
      console.error("[loombridge trace] record requires --observe (the only recording mode in v1).");
      return { help: true, usageError: true };
    }
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
    autoStateSignal,
    driftTolerance,
    maskSet,
    maskClear,
    maskList,
    speed,
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
      "  record      Record a human demonstration into a replayable trace: reset to",
      "              --scene, observe your clicks/drags until you press Enter (or",
      "              --duration <sec>), and write .loombridge/replays/traces/<id>.trace.json.",
      "  replay      Drive .loombridge/replays/traces/<id>.trace.json against the running",
      "              editor and write .loombridge/replays/reports/<id>.report.{json,html},",
      "              diffing each capture against its approved baseline. --speed <1..8>",
      "              replays faster than the demonstration (recorded settles divided,",
      "              floored at 250ms); the pacing is stamped into the report and, at",
      "              approve, into the baseline, and a replay at a pacing other than the",
      "              baseline's REFUSES the pixel comparison (phase skew is not drift).",
      "  replay-all  Replay EVERY trace under .loombridge/replays/traces/ and write a",
      "              roll-up .loombridge/replays/fleet.report.{json,html}. Exit by worst tier.",
      "  approve     Promote the latest run's captures to the approved baseline",
      "              (.loombridge/replays/baselines/<id>/). Never takes a tolerance, and",
      "              refuses a run with an unreadable capture (a capture gap is not an anchor).",
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
      "  --id <id>         Trace id (required except for replay-all).",
      "  --root <dir>      Project root containing .loombridge/ (default: cwd).",
      "  --trace <path>    Override the trace input path (replay only).",
      "  --flat            Lay replay artifacts directly under --root (traces/, reports/,",
      "                    baseline/) with no nested .loombridge/ — the mini-game workspace layout.",
      "  --no-html         Skip the HTML report.",
      "  --strict-visual   Make a visual drift from baseline a failure.",
      "  --speed <n>       replay only: pacing multiplier, 1 to 8 (default: the baseline's",
      "                    stamped pacing, else 1).",
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
      "  --observe         record: record by observing a human session (required).",
      "  --scene <path>    record: scene to reset to and record from (optional: when omitted,",
      "                    the recorder resolves the editor's CURRENT scene, refusing if unsaved).",
      "  --duration <sec>  record: auto-stop after N seconds instead of waiting for Enter.",
      "  --outcomes <file> record: JSON OutcomeSpec[] to pin as end-state assertions.",
      "  --state-signal <path>:<Component>:<property>",
      "                    record: gate each gesture on this game state field (e.g.",
      "                    /Canvas/GM:ChefGameManager:phase) so replay waits for the game",
      "                    to reach the consumable state, not just for the target to appear.",
      "  --auto-state-signal",
      "                    record: AUTO-DETECT each scene's state signal live and switch on",
      "                    scene-change (per-scene gates for a hub→game recording, no manual",
      "                    --state-signal). Takes precedence over --state-signal.",
      "  --title <text>    record: human-readable trace title.",
      "  --intent <text>   record: what the trace is meant to verify.",
      "",
      "Exit: 0 pass · 1 game defect: fail/error (or drift with --strict-visual)",
      "      2 harness fault: blocked (undrivable), an unreadable capture/baseline PNG,",
      "        a baseline manifest that cannot be trusted at grade time (including one",
      "        carrying an over-cap drift tolerance), an unreachable editor, or a usage",
      "        error. A harness fault is never reported as a game defect.",
      "      tolerance/mask: 0 stamped · 1 no approved baseline to stamp (approve frames",
      "        first) · 2 the baseline manifest exists but cannot be trusted, the approved",
      "        frames cannot be decoded, or the rects are refused (out of bounds, no reason,",
      `        or over the ${driftPercentText(MAX_MASKED_FRACTION)}% masked-area cap). A refused stamp writes nothing.`,
      "      A run that failed ONLY on pixel drift prints the observed max drift and the",
      "      exact `trace tolerance` command to consent to it. That suggestion never",
      "      appears for an unreadable capture: a harness fault is not drift.",
      "      The same run may also print a MASK suggestion, but only after TWO runs whose",
      "      drift bitmaps DIFFER in the same region (nondeterministic ambient animation).",
      "      An identical drift twice is a deterministic change and says so instead; a",
      "      diffuse drift says masks cannot cover it honestly. Nothing is ever applied.",
    ].join("\n"),
  );
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
