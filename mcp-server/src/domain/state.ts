/**
 * .loombridge/ state contract — the product's grip on the codebase (plan §4).
 *
 * Every Loombridge command reads and writes this directory. `STATE.md` is the
 * human-readable state file; a machine-readable copy is embedded in an HTML
 * comment so it round-trips without a second file (and stays invisible in
 * rendered markdown).
 *
 * This module is deterministic and engine-agnostic — no agent, no Unity. It is
 * the kind of code that belongs in the CLI (plan §3d: the CLI is the equalizer).
 */

import fs from "node:fs/promises";
import path from "node:path";

export const LOOMBRIDGE_DIRNAME = ".loombridge";

/**
 * The PLACEHOLDER genre in a STATE bootstrapped before any `plan` ran — `loombridge target set`
 * can create STATE first, and at that point no genre has been chosen.
 *
 * It is a sentinel, not a genre, and `plan` must never preserve it across a bare re-plan. Named
 * rather than inlined because the distinction it draws is load-bearing: `plan` preserves ANY other
 * recorded genre, including a free-form one with no registered pack. Testing "is it registered?"
 * instead of "is it the placeholder?" silently converted free-form projects into platformers on a
 * bare re-plan — and upgraded their coverage claim from `ungraded` to `graded` on the way.
 */
export const UNPLANNED_GENRE = "unknown";

/** Readiness of the Design Target (the annotated hero shot — plan §3c). */
export type DesignTargetStatus = "missing" | "draft" | "approved";

/** Lifecycle phase of a Loombridge project. */
export type LoombridgePhase =
  | "planned" // contract exists; nothing built/verified yet
  | "built-unverified" // a build ran but verify has not confirmed it
  | "verified-green" // last verify passed all gates
  | "verified-warn" // last verify had warnings, no hard failures
  | "verified-failing"; // last verify failed; build is NOT done

export interface LoombridgeVerdictRef {
  status: string;
  /** ISO timestamp of the verify run. */
  at: string;
  /** Verdict path, relative to the project root. */
  verdictPath: string;
}

/**
 * The §3a supervisor mechanism's run-binding block. `loombridge build` mints this
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
   * Optional capture filenames (relative to `.loombridge/verify/`) that MUST be
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

export interface LoombridgeState {
  genre: string;
  engine: string;
  phase: LoombridgePhase;
  /** Readiness of the Design Target (plan §3c); absent ⇒ treated as missing. */
  designTarget?: DesignTargetStatus;
  /** Set by `build` (M2); read by `verify` + `doneness` for run-binding (§3a). */
  currentBuild?: CurrentBuildRef | null;
  lastVerdict?: LoombridgeVerdictRef | null;
  /** ISO timestamp of the last state write. */
  updatedAt: string;
}

export interface LoombridgePaths {
  /** Project root — the directory that contains `.loombridge/`. */
  root: string;
  /** `.loombridge/` */
  dir: string;
  /** `.loombridge/STATE.md` */
  state: string;
  /** `.loombridge/GAME_SPEC.md` */
  gameSpec: string;
  /** `.loombridge/FEEL_SPEC.json` */
  feelSpec: string;
  /** `.loombridge/ACCEPTANCE.json` */
  acceptance: string;
  /** `.loombridge/SLICES.json` — the slice DAG (plan §'The slice contract'). */
  slices: string;
  /** `.loombridge/ASSET_MANIFEST.json` — approved visual asset source contract. */
  assetManifest: string;
  /**
   * `.loombridge/GENRE_PROMOTION.json` — the promotion report `plan --genre-contract` writes. Present
   * only for a project planned from a genre contract, and the DISK TRUTH that decides genre coverage
   * for an unregistered genre (`capabilities/genre/genre-coverage.ts`).
   */
  genrePromotion: string;
  /** `.loombridge/design/` — the Design Target Phase artifacts (plan §3c). */
  design: string;
  /** `.loombridge/reports/` */
  reports: string;
  /** `.loombridge/traces/` */
  traces: string;
  /** `.loombridge/replays/` — Replay Verification root (traces + reports + captures). */
  replays: string;
  /** `.loombridge/replays/traces/` — replay trace JSONs (`<id>.trace.json`). */
  replayTraces: string;
  /** `.loombridge/replays/reports/` — replay reports (`<id>.report.json`/`.html`) + per-id captures. */
  replayReports: string;
  /** `.loombridge/replays/baselines/` — approved baseline PNGs per trace (`<id>/<captureId>.png`). */
  replayBaselines: string;
  /** `.loombridge/verify/` — captured op-output JSON the gates read. */
  verifyInputs: string;
  /** `.loombridge/reports/build-verdict.json` */
  verdict: string;
}

export function loombridgePaths(root: string): LoombridgePaths {
  const dir = path.join(root, LOOMBRIDGE_DIRNAME);
  return {
    root,
    dir,
    state: path.join(dir, "STATE.md"),
    gameSpec: path.join(dir, "GAME_SPEC.md"),
    feelSpec: path.join(dir, "FEEL_SPEC.json"),
    acceptance: path.join(dir, "ACCEPTANCE.json"),
    slices: path.join(dir, "SLICES.json"),
    assetManifest: path.join(dir, "ASSET_MANIFEST.json"),
    genrePromotion: path.join(dir, "GENRE_PROMOTION.json"),
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
 * fleet roll-up). Decoupled from the full `LoombridgePaths` so a caller can choose
 * WHERE replay artifacts live without inheriting the whole `.loombridge/` tree.
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
 * Standard layout — replay artifacts under `<root>/.loombridge/replays/`. This is the
 * default for the generic `trace` verb run against a project root that owns a
 * `.loombridge/` state dir.
 */
export function standardReplayLayout(root: string): ReplayLayout {
  const p = loombridgePaths(root);
  return {
    replays: p.replays,
    replayTraces: p.replayTraces,
    replayReports: p.replayReports,
    replayBaselines: p.replayBaselines,
  };
}

/**
 * Flat workspace layout — replay artifacts live DIRECTLY under the workspace, with
 * no nested `.loombridge/`, sharing the workspace's own dirs: `traces/`, `reports/`
 * (alongside the verify report), `baseline/`. Used by the mini-game external
 * workspace (`~/.loombridge/projects/<id>/`) so a single project folder holds
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

/** Create the `.loombridge/` directory tree. Idempotent. */
export async function ensureScaffold(paths: LoombridgePaths): Promise<void> {
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
const STATE_MARKER_RE = /<!--\s*loombridge-state:\s*([\s\S]*?)-->/;

/**
 * The single most useful line for a human (or a reviewer) opening STATE.md: what
 * to do next, given the phase + Design Target readiness. Post-plan state used to
 * read as "empty" (no build, no verdict) and confused review during RUN-1 (#64);
 * a concrete next-action makes every phase self-explanatory.
 */
export function nextActionFor(state: LoombridgeState): string {
  const designReady = state.designTarget === "approved";
  switch (state.phase) {
    case "planned":
      return designReady
        ? "Design Target approved — run `loombridge build` to build the next planned slice."
        : "Establish + approve the Design Target (annotated hero shot) in `.loombridge/design/` via `loombridge target set/approve`, then `loombridge build`.";
    case "built-unverified":
      return "Drive every `capturePack` state into `.loombridge/verify/<state>/`, run the independent hero-shot review, then `loombridge verify --vlm … --strict` and `loombridge doneness`.";
    case "verified-failing":
      return "Read the latest verdict failures, fix each, then `loombridge build` → verify → doneness.";
    case "verified-warn":
      return "Resolve the warnings (or accept them), re-run `loombridge verify --strict`, then `loombridge doneness`.";
    case "verified-green":
      return "Run `loombridge doneness` to certify — for a design-targeted build it requires a passing independent hero-shot review (plan §P0).";
    default:
      return "Run `loombridge plan` to scaffold the contract.";
  }
}

export function renderStateMd(state: LoombridgeState): string {
  const verdict = state.lastVerdict
    ? `\`${state.lastVerdict.status}\` (${state.lastVerdict.at}) — \`${state.lastVerdict.verdictPath}\``
    : "_(none yet — run `loombridge verify`)_";
  return `${[
    "# Loombridge State",
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
    "- `planned` — `.loombridge/` contract exists; nothing built/verified yet.",
    "- `built-unverified` — a build ran but `verify` has not confirmed it.",
    "- `verified-green` — last `verify` passed all gates.",
    "- `verified-warn` — last `verify` had warnings, no hard failures.",
    "- `verified-failing` — last `verify` failed; the build is NOT done.",
    "",
    `<!-- loombridge-state: ${JSON.stringify(state)} -->`,
  ].join("\n")}\n`;
}

export async function writeState(paths: LoombridgePaths, state: LoombridgeState): Promise<void> {
  await fs.mkdir(paths.dir, { recursive: true });
  await fs.writeFile(paths.state, renderStateMd(state), "utf-8");
}

/** Read the embedded machine state from STATE.md; null if absent/unparseable. */
export async function readState(paths: LoombridgePaths): Promise<LoombridgeState | null> {
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
    return JSON.parse(match[1].trim()) as LoombridgeState;
  } catch {
    return null;
  }
}

/**
 * Read → merge a partial → write STATE.md, refreshing `updatedAt`. When no state
 * exists yet, starts from a minimal default. Returns the written state.
 */
export async function updateState(
  paths: LoombridgePaths,
  patch: Partial<LoombridgeState>,
): Promise<LoombridgeState> {
  const prev = await readState(paths);
  const base: LoombridgeState =
    prev ?? { genre: UNPLANNED_GENRE, engine: "unity", phase: "planned", lastVerdict: null, updatedAt: nowIso() };
  const next: LoombridgeState = { ...base, ...patch, updatedAt: nowIso() };
  await writeState(paths, next);
  return next;
}
