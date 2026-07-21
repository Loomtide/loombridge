/**
 * .loomtide/ state contract — the product's grip on the codebase (plan §4).
 *
 * Every Loomtide command reads and writes this directory. `STATE.md` is the
 * human-readable state file; a machine-readable copy is embedded in an HTML
 * comment so it round-trips without a second file (and stays invisible in
 * rendered markdown).
 *
 * This module is deterministic and engine-agnostic — no agent, no Unity. It is
 * the kind of code that belongs in the CLI (plan §3d: the CLI is the equalizer).
 */

import fs from "node:fs/promises";
import path from "node:path";

export const LOOMTIDE_DIRNAME = ".loomtide";

/** Readiness of the Design Target (the annotated hero shot — plan §3c). */
export type DesignTargetStatus = "missing" | "draft" | "approved";

/** Lifecycle phase of a Loomtide project. */
export type LoomtidePhase =
  | "planned" // contract exists; nothing built/verified yet
  | "built-unverified" // a build ran but verify has not confirmed it
  | "verified-green" // last verify passed all gates
  | "verified-warn" // last verify had warnings, no hard failures
  | "verified-failing"; // last verify failed; build is NOT done

export interface LoomtideVerdictRef {
  status: string;
  /** ISO timestamp of the verify run. */
  at: string;
  /** Verdict path, relative to the project root. */
  verdictPath: string;
}

/**
 * The §3a supervisor mechanism's run-binding block. `loomtide build` mints this
 * at the start of a build; `verify` records the same `runId` in the verdict so
 * a "done" claim can be checked for *belonging to this build*, not a stale one.
 *
 * The actual minting lives in `build.ts` (M2). This module ships the type, the
 * state slot, and the freshness predicate so the contract is in place.
 */
export interface CurrentBuildRef {
  /** Unique id for this build run (timestamp + random suffix is fine). */
  runId: string;
  /** ISO timestamp when the build was minted. */
  startedAt: string;
  /**
   * Optional capture filenames (relative to `.loomtide/verify/`) that MUST be
   * present for `doneness` to certify. Derived from the genre's `capturePack`
   * in ACCEPTANCE at build start. Empty/undefined ⇒ no capture-completeness check.
   */
  captureManifest?: string[];
  /**
   * True when this run started under `--allow-ungrounded-prototype` (no
   * approved Design Target). Sticky for the run's lifetime — survives the
   * verify → done transition — and `doneness` refuses to certify it (plan §3c:
   * the escape "disqualifies the build from any 'done' claim"). Modelling this
   * as a flag on the run rather than a new phase keeps the lifecycle enum tight.
   */
  ungrounded?: boolean;
}

export interface LoomtideState {
  genre: string;
  engine: string;
  phase: LoomtidePhase;
  /** Readiness of the Design Target (plan §3c); absent ⇒ treated as missing. */
  designTarget?: DesignTargetStatus;
  /** Set by `build` (M2); read by `verify` + `doneness` for run-binding (§3a). */
  currentBuild?: CurrentBuildRef | null;
  lastVerdict?: LoomtideVerdictRef | null;
  /** ISO timestamp of the last state write. */
  updatedAt: string;
}

export interface LoomtidePaths {
  /** Project root — the directory that contains `.loomtide/`. */
  root: string;
  /** `.loomtide/` */
  dir: string;
  /** `.loomtide/STATE.md` */
  state: string;
  /** `.loomtide/GAME_SPEC.md` */
  gameSpec: string;
  /** `.loomtide/FEEL_SPEC.json` */
  feelSpec: string;
  /** `.loomtide/ACCEPTANCE.json` */
  acceptance: string;
  /** `.loomtide/SLICES.json` — the slice DAG (plan §'The slice contract'). */
  slices: string;
  /** `.loomtide/ASSET_MANIFEST.json` — approved visual asset source contract. */
  assetManifest: string;
  /** `.loomtide/design/` — the Design Target Phase artifacts (plan §3c). */
  design: string;
  /** `.loomtide/reports/` */
  reports: string;
  /** `.loomtide/traces/` */
  traces: string;
  /** `.loomtide/replays/` — Replay Verification root (traces + reports + captures). */
  replays: string;
  /** `.loomtide/replays/traces/` — replay trace JSONs (`<id>.trace.json`). */
  replayTraces: string;
  /** `.loomtide/replays/reports/` — replay reports (`<id>.report.json`/`.html`) + per-id captures. */
  replayReports: string;
  /** `.loomtide/replays/baselines/` — approved baseline PNGs per trace (`<id>/<captureId>.png`). */
  replayBaselines: string;
  /** `.loomtide/verify/` — captured op-output JSON the gates read. */
  verifyInputs: string;
  /** `.loomtide/reports/build-verdict.json` */
  verdict: string;
}

export function loomtidePaths(root: string): LoomtidePaths {
  const dir = path.join(root, LOOMTIDE_DIRNAME);
  return {
    root,
    dir,
    state: path.join(dir, "STATE.md"),
    gameSpec: path.join(dir, "GAME_SPEC.md"),
    feelSpec: path.join(dir, "FEEL_SPEC.json"),
    acceptance: path.join(dir, "ACCEPTANCE.json"),
    slices: path.join(dir, "SLICES.json"),
    assetManifest: path.join(dir, "ASSET_MANIFEST.json"),
    design: path.join(dir, "design"),
    reports: path.join(dir, "reports"),
    traces: path.join(dir, "traces"),
    replays: path.join(dir, "replays"),
    replayTraces: path.join(dir, "replays", "traces"),
    replayReports: path.join(dir, "replays", "reports"),
    replayBaselines: path.join(dir, "replays", "baselines"),
    verifyInputs: path.join(dir, "verify"),
    verdict: path.join(dir, "reports", "build-verdict.json"),
  };
}

/**
 * The subset of paths the Replay Verification verbs need: traces, reports,
 * baselines, and the `replays` dir that confines them (read-PNG safety + the
 * fleet roll-up). Decoupled from the full `LoomtidePaths` so a caller can choose
 * WHERE replay artifacts live without inheriting the whole `.loomtide/` tree.
 */
export interface ReplayLayout {
  /** The directory every replay artifact lives under (confinement root). */
  replays: string;
  /** Replay trace JSONs (`<id>.trace.json`). */
  replayTraces: string;
  /** Replay reports (`<id>.report.{json,html}`) + per-id captures. */
  replayReports: string;
  /** Approved baseline PNGs per trace (`<id>/<captureId>.png`). */
  replayBaselines: string;
}

/**
 * Standard layout — replay artifacts under `<root>/.loomtide/replays/`. This is the
 * default for the generic `trace` verb run against a project root that owns a
 * `.loomtide/` state dir.
 */
export function standardReplayLayout(root: string): ReplayLayout {
  const p = loomtidePaths(root);
  return {
    replays: p.replays,
    replayTraces: p.replayTraces,
    replayReports: p.replayReports,
    replayBaselines: p.replayBaselines,
  };
}

/**
 * Flat workspace layout — replay artifacts live DIRECTLY under the workspace, with
 * no nested `.loomtide/`, sharing the workspace's own dirs: `traces/`, `reports/`
 * (alongside the verify report), `baseline/`. Used by the mini-game external
 * workspace (`~/.loomtide/projects/<id>/`) so a single project folder holds
 * everything in one obvious, standard place.
 */
export function flatReplayLayout(workspace: string): ReplayLayout {
  return {
    replays: workspace,
    replayTraces: path.join(workspace, "traces"),
    replayReports: path.join(workspace, "reports"),
    replayBaselines: path.join(workspace, "baseline"),
  };
}

/** Create the `.loomtide/` directory tree. Idempotent. */
export async function ensureScaffold(paths: LoomtidePaths): Promise<void> {
  for (const d of [paths.dir, paths.design, paths.reports, paths.traces, paths.verifyInputs]) {
    await fs.mkdir(d, { recursive: true });
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}

export async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

// The machine-state marker. JSON cannot contain "-->", so a non-greedy capture
// up to the first "-->" is unambiguous even with nested objects (lastVerdict).
const STATE_MARKER_RE = /<!--\s*loomtide-state:\s*([\s\S]*?)-->/;

/**
 * The single most useful line for a human (or a reviewer) opening STATE.md: what
 * to do next, given the phase + Design Target readiness. Post-plan state used to
 * read as "empty" (no build, no verdict) and confused review during RUN-1 (#64);
 * a concrete next-action makes every phase self-explanatory.
 */
export function nextActionFor(state: LoomtideState): string {
  const designReady = state.designTarget === "approved";
  switch (state.phase) {
    case "planned":
      return designReady
        ? "Design Target approved — run `loomtide build` to build the next planned slice."
        : "Establish + approve the Design Target (annotated hero shot) in `.loomtide/design/` via `loomtide design set/approve`, then `loomtide build`.";
    case "built-unverified":
      return "Drive every `capturePack` state into `.loomtide/verify/<state>/`, run the independent hero-shot review, then `loomtide verify --vlm … --strict` and `loomtide doneness`.";
    case "verified-failing":
      return "Read the latest verdict failures, fix each, then `loomtide build` → verify → doneness.";
    case "verified-warn":
      return "Resolve the warnings (or accept them), re-run `loomtide verify --strict`, then `loomtide doneness`.";
    case "verified-green":
      return "Run `loomtide doneness` to certify — for a design-targeted build it requires a passing independent hero-shot review (plan §P0).";
    default:
      return "Run `loomtide plan` to scaffold the contract.";
  }
}

export function renderStateMd(state: LoomtideState): string {
  const verdict = state.lastVerdict
    ? `\`${state.lastVerdict.status}\` (${state.lastVerdict.at}) — \`${state.lastVerdict.verdictPath}\``
    : "_(none yet — run `loomtide verify`)_";
  return `${[
    "# Loomtide State",
    "",
    "> The machine-readable copy lives in the HTML comment at the bottom; the prose mirrors it.",
    "",
    `- **Genre:** ${state.genre}`,
    `- **Engine:** ${state.engine}`,
    `- **Phase:** \`${state.phase}\``,
    `- **Design target:** \`${state.designTarget ?? "missing"}\``,
    `- **Current build:** ${
      state.currentBuild
        ? `runId \`${state.currentBuild.runId}\` started ${state.currentBuild.startedAt}` +
          (state.currentBuild.captureManifest?.length
            ? ` (${state.currentBuild.captureManifest.length} required capture(s))`
            : "") +
          (state.currentBuild.ungrounded ? " — **UNGROUNDED**, cannot certify" : "")
        : "_(none — no build in flight)_"
    }`,
    `- **Last verdict:** ${verdict}`,
    `- **Updated:** ${state.updatedAt}`,
    "",
    `**Next action:** ${nextActionFor(state)}`,
    "",
    "## Phases",
    "",
    "- `planned` — `.loomtide/` contract exists; nothing built/verified yet.",
    "- `built-unverified` — a build ran but `verify` has not confirmed it.",
    "- `verified-green` — last `verify` passed all gates.",
    "- `verified-warn` — last `verify` had warnings, no hard failures.",
    "- `verified-failing` — last `verify` failed; the build is NOT done.",
    "",
    `<!-- loomtide-state: ${JSON.stringify(state)} -->`,
  ].join("\n")}\n`;
}

export async function writeState(paths: LoomtidePaths, state: LoomtideState): Promise<void> {
  await fs.mkdir(paths.dir, { recursive: true });
  await fs.writeFile(paths.state, renderStateMd(state), "utf-8");
}

/** Read the embedded machine state from STATE.md; null if absent/unparseable. */
export async function readState(paths: LoomtidePaths): Promise<LoomtideState | null> {
  let raw: string;
  try {
    raw = await fs.readFile(paths.state, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const match = raw.match(STATE_MARKER_RE);
  if (!match) return null;
  try {
    return JSON.parse(match[1].trim()) as LoomtideState;
  } catch {
    return null;
  }
}

/**
 * Read → merge a partial → write STATE.md, refreshing `updatedAt`. When no state
 * exists yet, starts from a minimal default. Returns the written state.
 */
export async function updateState(
  paths: LoomtidePaths,
  patch: Partial<LoomtideState>,
): Promise<LoomtideState> {
  const prev = await readState(paths);
  const base: LoomtideState =
    prev ?? { genre: "unknown", engine: "unity", phase: "planned", lastVerdict: null, updatedAt: nowIso() };
  const next: LoomtideState = { ...base, ...patch, updatedAt: nowIso() };
  await writeState(paths, next);
  return next;
}
