/**
 * `loombridge trace` — Replay Verification product surface.
 *
 *   loombridge trace replay --id <id> [--root <dir>] [--trace <path>] [--no-html]
 *   loombridge trace report --id <id> [--root <dir>]
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
  sub: "replay" | "report" | "approve" | "replay-all" | "record";
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
  // ── record --observe ──
  /** Scene to reset to + record from (record only; required). */
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
    if (parsed.sub === "record") return await runRecord(parsed);
    return await runReport(parsed);
  } catch (error) {
    const hint = unityConnectionHint(error);
    if (hint) {
      console.error(hint.join("\n"));
      return 1;
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
  });
  printSummary(args.root, args.id, artifact, reportJson, htmlPath);
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

  console.error(
    `[loombridge trace] recording "${args.id}" — resetting ${args.scene ?? "the current scene"} to a clean Play-Mode start…`,
  );
  const { trace, droppedNoTarget } = await observeRecordLive(meta, {
    waitForStop,
    outcomes,
    projectPathCanonical: resolveCliProjectPin({ root: args.root }),
  });

  await fs.mkdir(paths.replayTraces, { recursive: true });
  const traceFile = path.join(paths.replayTraces, `${args.id}.trace.json`);
  await fs.writeFile(traceFile, `${JSON.stringify(trace, null, 2)}\n`, "utf-8");

  const steps = trace.segments.length;
  const outcomeCount = trace.assertions?.length ?? 0;
  if (droppedNoTarget > 0) {
    // Honest, not silent: inert taps (transparent backdrop / decoration) did nothing
    // in the game, so they're not recorded — but say so, so the count isn't a mystery.
    console.error(
      `[loombridge trace] ignored ${droppedNoTarget} inert tap(s) (no interactive target — backdrop/empty space).`,
    );
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
async function replayOneTrace(
  paths: ReplayLayout,
  id: string,
  opts: { tracePath?: string; html: boolean; projectPathCanonical?: string },
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

  const captureDir = path.join(paths.replayReports, id, "actual");
  const artifact = await runLiveReplay(trace, {
    captureDir,
    projectPathCanonical: opts.projectPathCanonical,
  });
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
  for (const id of ids) {
    try {
      const { artifact, reportJson, htmlPath } = await replayOneTrace(paths, id, {
        html: args.html,
        projectPathCanonical: resolveCliProjectPin({ root: args.root }),
      });
      results.push({
        id,
        status: artifact.status,
        blockedReason: artifact.blockedReason,
        visualDrift: artifact.visualDrift ?? false,
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
  console.error(
    `[loombridge trace] fleet: ${fleet.status.toUpperCase()} — ${c.pass}/${c.total} pass, ${c.fail} fail, ${c.blocked} blocked, ${c.drift} drift`,
  );
  console.error(`[loombridge trace] fleet report → ${path.relative(args.root, fleetReport)}`);

  if (fleet.status !== "pass") return 1;
  if (c.drift > 0 && args.strictVisual) return 1;
  return 0;
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
 * Exit code for a replay run. A non-pass status fails (1). Visual drift is a
 * WARNING by default (GPU/AA noise shouldn't fail CI) — `--strict-visual`
 * promotes it to a failure. Pure + exported for unit tests.
 */
export function replayExitCode(
  artifact: Pick<ReplayRunArtifact, "status" | "visualDrift">,
  strictVisual: boolean,
): number {
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

  const baselineDir = path.join(paths.replayBaselines, args.id);
  await fs.mkdir(baselineDir, { recursive: true });
  let approved = 0;
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
        await fs.copyFile(capture.artifact, dest);
        approved += 1;
      } catch {
        console.error(`[loombridge trace] could not approve capture "${capture.id}" (missing actual).`);
      }
    }
  }
  console.error(
    `[loombridge trace] approved ${approved} baseline(s) → ${path.relative(args.root, baselineDir)}`,
  );
  return approved > 0 ? 0 : 1;
}

/** Annotate each capture with its perceptual diff vs the approved baseline. */
async function applyVisualDiff(
  paths: ReplayLayout,
  id: string,
  artifact: ReplayRunArtifact,
): Promise<void> {
  const baselineDir = path.join(paths.replayBaselines, id);
  let anyDrift = false;
  for (const segment of artifact.segments) {
    for (const capture of segment.captures) {
      if (!capture.artifact) continue;
      const baselinePath = path.join(baselineDir, `${capture.id}.png`);
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
        const diff = comparePerceptual(actual, baseline);
        capture.baseline = baselinePath;
        capture.diffFraction = diff.diffFraction;
        capture.visualStatus = diff.status;
        if (diff.status === "drift") anyDrift = true;
      } catch (error) {
        // Unreadable actual/baseline → treat as drift, never a silent match.
        capture.baseline = baselinePath;
        capture.visualStatus = "drift";
        anyDrift = true;
        console.error(`[loombridge trace] visual diff failed for "${capture.id}": ${message(error)}`);
      }
    }
  }
  if (anyDrift) artifact.visualDrift = true;
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
      });
    }
  }
  const htmlPath = path.join(paths.replayReports, `${id}.report.html`);
  await fs.writeFile(htmlPath, renderReplayReportHtml(artifact, captures), "utf-8");
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
    sub !== "record"
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
  };
}

function printUsage(): void {
  console.error(
    [
      "Usage: loombridge trace <record|replay|replay-all|approve|report> [--id <id>] [options]",
      "",
      "  record      Record a human demonstration into a replayable trace: reset to",
      "              --scene, observe your clicks/drags until you press Enter (or",
      "              --duration <sec>), and write .loombridge/replays/traces/<id>.trace.json.",
      "  replay      Drive .loombridge/replays/traces/<id>.trace.json against the running",
      "              editor and write .loombridge/replays/reports/<id>.report.{json,html},",
      "              diffing each capture against its approved baseline.",
      "  replay-all  Replay EVERY trace under .loombridge/replays/traces/ and write a",
      "              roll-up .loombridge/replays/fleet.report.{json,html}. Exit by worst status.",
      "  approve     Promote the latest run's captures to the approved baseline",
      "              (.loombridge/replays/baselines/<id>/).",
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
      "  --observe         record: record by observing a human session (required).",
      "  --scene <path>    record: scene to reset to and record from (required).",
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
      "Exit: 0 pass · 1 fail/blocked/error (or drift with --strict-visual) · 2 usage.",
    ].join("\n"),
  );
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
