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

import { LOOMBRIDGE_DIRNAME } from "../shared/loombridge-dirname.js";

/**
 * Re-exported so every existing importer keeps reading it from here. The literal itself
 * is spelled ONCE, in `shared/loombridge-dirname.ts`, because `bridge/` may not import
 * `domain/` and still needs it. See that module for why the split falls there.
 */
export { LOOMBRIDGE_DIRNAME };

/**
 * The `.loombridge/` subdirectory holding the stamped Unity test-results pair (the NUnit3
 * XML, its binding manifest, and the run log).
 *
 * It lives HERE, in domain, rather than in the capability that writes it, because the
 * layering is one-directional (`capabilities -> domain`): `LoombridgePaths` cannot import
 * `capabilities/tests/`, and a second spelling of the directory name in each layer is
 * exactly the "declared path nothing walks" failure this repo keeps paying for. The
 * capability imports this constant; the filenames under it stay with the capability that
 * owns their format.
 *
 * Unlike `reports/`, this slot is meant to be COMMITTED: the stamped pair is evidence a
 * reviewer can read without re-running a multi-minute editor.
 */
export const TEST_RESULTS_DIRNAME = "tests";

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

/**
 * THE TWO TIER ROOTS (ArtifactStorage S2).
 *
 * `anchors/` holds ground truth: what a human froze, and what a gate compares against.
 * `run/` holds everything re-derivable from an anchor plus a run. The split is
 * STRUCTURAL, not a list: `run/` carries its own `.gitignore`, so "if it is not under
 * `run/`, it is meant to be committed" is a rule a human can hold and a clone inherits.
 *
 * Named constants rather than inline strings because the migration
 * (`capabilities/migrate/migrate-layout.ts`) and the write-path guard both have to spell
 * the same two words, and a second spelling of a tier root is the "declared path nothing
 * walks" failure applied to the layout itself.
 */
export const ANCHORS_DIRNAME = "anchors";
export const RUN_DIRNAME = "run";

/**
 * `.loombridge/run/.gitignore`, and why it is TWO lines rather than one.
 *
 * A bare `*` matches `.gitignore` itself, so the marker is never committed, never reaches
 * a clone, and the structural guarantee silently does nothing: the directory is ignored
 * only on the machine that happened to run a Loombridge verb. `!.gitignore` re-includes
 * the marker so it travels with the repo and ignores `run/` from the moment a clone
 * exists. Verified by `__tests__/unit/repo/write-paths.test.ts` against real `git
 * check-ignore` behavior, not asserted from memory.
 */
export const RUN_GITIGNORE_BODY = "# Loombridge run tier: everything here is re-derivable.\n*\n!.gitignore\n";

export interface LoombridgePaths {
  /** Project root — the directory that contains `.loombridge/`. */
  root: string;
  /** `.loombridge/` */
  dir: string;
  /**
   * `.loombridge/anchors/` — the COMMITTED ground-truth tier: recorded demonstrations,
   * approved pixel baselines, and the human sign-off artifacts a slice approval cites.
   */
  anchors: string;
  /**
   * `.loombridge/run/` — the IGNORED re-derivable tier. Carries its own `.gitignore`
   * ({@link RUN_GITIGNORE_BODY}) so the ignore rule travels to a clone.
   */
  run: string;
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
  /**
   * `.loombridge/ADOPTION.json` — the `loombridge adopt` proposal record (`status:
   * proposed-unverified`). A slot rather than a literal join onto `dir` at the writer, so the
   * write-path guard walks it like every other destination.
   */
  adoption: string;
  /** `.loombridge/design/` — the Design Target Phase artifacts (plan §3c). */
  design: string;
  /** `.loombridge/run/reports/` */
  reports: string;
  /**
   * `.loombridge/tests/`: the stamped Unity test-results slot (`loombridge tests run`
   * writes it; the unified `verify` door grades it OFFLINE). COMMITTED, unlike `reports/`.
   */
  tests: string;
  /**
   * `.loombridge/run/backups/` — where `loombridge update` copies the bridge install record
   * before mutating it, so a stray `.bak` never appears next to the record in
   * `ProjectSettings/` (and therefore in every consumer's `git status`).
   *
   * WRITE-ONLY today: nothing reads it back. It is a slot rather than a literal join at the
   * writer so the write-path guard walks it; a destination no guard walks is how a dead
   * `traces` slot survived here for as long as it did.
   */
  backups: string;
  /**
   * `.loombridge/run/replays/` — the replay RUN root: the fleet roll-up
   * (`fleet.report.{json,html}`) plus `reports/`.
   *
   * NO LONGER the confinement root for traces and baselines (ArtifactStorage S2): those
   * are anchors and moved to `anchors/traces/` + `anchors/baselines/`. The `flat`
   * workspace layout still puts all four under one directory, which is why
   * `isReplayArtifact` confines against `replayReports` + `replayBaselines` and never
   * against this field.
   */
  replays: string;
  /** `.loombridge/anchors/traces/` — recorded demonstrations (`<id>.trace.json`). ANCHOR. */
  replayTraces: string;
  /** `.loombridge/run/replays/reports/` — replay reports (`<id>.report.json`/`.html`) + per-id captures. */
  replayReports: string;
  /** `.loombridge/anchors/baselines/` — approved baseline PNGs per trace (`<id>/<captureId>.png`). ANCHOR. */
  replayBaselines: string;
  /**
   * `.loombridge/anchors/signoffs/` — the durable human sign-off artifacts
   * `plan --go --signoff` copies, and that `SLICES.json` cites as approval evidence.
   *
   * AN ANCHOR, NOT RUN OUTPUT (ArtifactStorage S2 M4). It used to live under
   * `reports/slices/<id>/`, which the S2 split would have put under `run/`: a
   * machine-local, `git clean -fdx`-deletable file that `SLICES.json` still names as the
   * reason a slice is `approved`. An approval whose evidence is regenerable is not an
   * approval, so this slot is committed like every other anchor.
   */
  signoffs: string;
  /**
   * `.loombridge/registry/` — imported asset packs (`<packId>.json`).
   *
   * DELIBERATELY NOT UNDER `run/` and DELIBERATELY NOT UNDER `anchors/`. These are
   * project INPUTS: re-deriving one may need a hosted catalog a clone or a CI runner
   * cannot reach, so ignoring them would break the clone-and-verify promise; but nobody
   * APPROVES a pack, so filing them beside the recorded demonstrations would put an
   * approval-shaped word on something no human ever froze. A committed, named top-level
   * directory is what both facts add up to. A slot rather than a `path.join(paths.dir,
   * "registry")` at the writer so the write-path guard walks it (W2) instead of W6
   * catching it by luck.
   */
  registry: string;
  /**
   * `.loombridge/run/captures/` — the ad-hoc screenshot destination the op registry
   * advertises. Regenerable by construction: it is whatever an agent pointed a screenshot at.
   */
  captures: string;
  /** `.loombridge/run/art/` — geometry/art snapshot JSON written by the art ops. */
  art: string;
  /**
   * `.loombridge/run/handoff/` — `scripts/prepare-project-assets.sh` writes its
   * asset-prepare report and the attribution markdown here. Both are re-derived by
   * re-running the script against the same profile + registry.
   */
  handoff: string;
  /**
   * `.loombridge/run/op-traces/` — the MCP server's own session trace JSONL + artifacts.
   *
   * A SEPARATE DIRECTORY FROM THE REPLAY ANCHORS ON PURPOSE (ArtifactStorage S2 M6). The
   * server constructs its recorder at STARTUP, outside every CLI verb, and appends on the
   * first op; no verb-level refusal can cover it. Sharing a directory with the recorded
   * demonstrations is what made an op trace and a human demonstration indistinguishable by
   * location.
   */
  opTraces: string;
  /**
   * `.loombridge/verify/` — captured op-output JSON the gates read.
   *
   * DOES NOT MOVE, for two independent reasons (ArtifactStorage S2). (a)
   * `packages/com.loomtide.loombridge/Editor/Handlers/CaptureHandler.cs` hard-codes
   * `Path.Combine(projectRoot, ".loombridge", "verify")` as its write allowlist and throws
   * `INVALID_PARAMS` outside it, so moving this is a cross-language migration needing a
   * bridge release AND a reinstall in every consumer project. (b) it is COMMITTED: the
   * shipped template does not ignore it, which is what lets a clone re-grade an approved
   * slice offline. Filing it under `run/` would structurally ignore it and break exactly
   * the promise this RFC exists to deliver.
   */
  verifyInputs: string;
  /** `.loombridge/run/reports/build-verdict.json` */
  verdict: string;
}

export function loombridgePaths(root: string): LoombridgePaths {
  const dir = path.join(root, LOOMBRIDGE_DIRNAME);
  const anchors = path.join(dir, ANCHORS_DIRNAME);
  const run = path.join(dir, RUN_DIRNAME);
  // TWO TREES ARE NAMED `reports` (ArtifactStorage S2 M7), and folding them into one
  // would be a MERGE no rename can undo. `run/reports/` is the verification tier's
  // (the build verdict, the unified report, `slices/`); `run/replays/reports/` is the
  // replay tier's (`<id>.report.json`). They stay nested and distinct.
  const replays = path.join(run, "replays");
  return {
    root,
    dir,
    anchors,
    run,
    state: path.join(dir, "STATE.md"),
    gameSpec: path.join(dir, "GAME_SPEC.md"),
    feelSpec: path.join(dir, "FEEL_SPEC.json"),
    acceptance: path.join(dir, "ACCEPTANCE.json"),
    slices: path.join(dir, "SLICES.json"),
    assetManifest: path.join(dir, "ASSET_MANIFEST.json"),
    genrePromotion: path.join(dir, "GENRE_PROMOTION.json"),
    adoption: path.join(dir, "ADOPTION.json"),
    design: path.join(dir, "design"),
    registry: path.join(dir, "registry"),
    reports: path.join(run, "reports"),
    tests: path.join(dir, TEST_RESULTS_DIRNAME),
    backups: path.join(run, "backups"),
    replays,
    replayTraces: path.join(anchors, "traces"),
    replayReports: path.join(replays, "reports"),
    replayBaselines: path.join(anchors, "baselines"),
    signoffs: path.join(anchors, "signoffs"),
    captures: path.join(run, "captures"),
    art: path.join(run, "art"),
    handoff: path.join(run, "handoff"),
    opTraces: path.join(run, "op-traces"),
    verifyInputs: path.join(dir, "verify"),
    verdict: path.join(run, "reports", "build-verdict.json"),
  };
}

/**
 * The subset of paths the Replay Verification verbs need: traces, reports,
 * baselines, and the `replays` dir that confines them (read-PNG safety + the
 * fleet roll-up). Decoupled from the full `LoombridgePaths` so a caller can choose
 * WHERE replay artifacts live without inheriting the whole `.loombridge/` tree.
 */
export interface ReplayLayout {
  /**
   * The replay RUN root: the fleet roll-up lives here, and per-run report paths are
   * printed relative to it.
   *
   * NOT a confinement root. In the standard layout the traces and baselines are anchors
   * and sit elsewhere entirely; in the flat workspace layout this IS the workspace, which
   * is why `isReplayArtifact` confines against `replayReports` + `replayBaselines`
   * instead. Reading this field as "everything replay writes lives under here" was true
   * before ArtifactStorage S2 and is not true now.
   */
  replays: string;
  /** Replay trace JSONs (`<id>.trace.json`). */
  replayTraces: string;
  /** Replay reports (`<id>.report.{json,html}`) + per-id captures. */
  replayReports: string;
  /** Approved baseline PNGs per trace (`<id>/<captureId>.png`). */
  replayBaselines: string;
}

/**
 * Standard layout — SPLIT ACROSS THE TWO TIERS (ArtifactStorage S2). The recorded
 * demonstration and its approved frames are anchors (`.loombridge/anchors/{traces,
 * baselines}/`); the run output is not (`.loombridge/run/replays/`). This is the default
 * for the generic `trace` verb run against a project root that owns a `.loombridge/`
 * state dir.
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

/**
 * Create the `.loombridge/` directory tree. Idempotent.
 *
 * A `paths.traces` slot (a top-level `traces` directory) used to be scaffolded here, and
 * the path is deliberately no longer spelled: after ArtifactStorage S2 the demonstrations
 * live at `paths.replayTraces`, and naming a second top-level slot in this paragraph would
 * read as a live one. It was DEAD: this line
 * was its only reference in non-test source, nothing ever wrote a file into it, and every
 * replay trace goes to `paths.replayTraces`. A directory declared in the layout and created
 * on every `plan`, that no writer and no reader walks, is this repo's signature failure
 * shape sitting inside the layout itself. Both the slot and this entry are gone;
 * `__tests__/unit/repo/write-paths.test.ts` is what stops the next one.
 */
export async function ensureScaffold(paths: LoombridgePaths): Promise<void> {
  for (const d of [paths.dir, paths.design, paths.reports, paths.verifyInputs]) {
    await fs.mkdir(d, { recursive: true });
  }
  await ensureRunGitignore(paths);
}

/**
 * Write `.loombridge/run/.gitignore` if it is not already there.
 *
 * Called from EVERY entry point that creates the run tier, not only from `plan`: the
 * whole structural guarantee is that a directory holding regenerable output cannot exist
 * without the marker that ignores it. An existing file is left alone (a team may have
 * added rules of their own under it), which is also what makes this safe to call on every
 * scaffold.
 */
export async function ensureRunGitignore(paths: LoombridgePaths): Promise<void> {
  await fs.mkdir(paths.run, { recursive: true });
  const marker = path.join(paths.run, ".gitignore");
  if (await fileExists(marker)) return;
  await fs.writeFile(marker, RUN_GITIGNORE_BODY, "utf-8");
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
      // `--inputs` is named on purpose, for the same reason `build` prints it: a BARE
      // `verify --strict` is now the unified front door (a broader question), while this
      // loop is resuming the contract-mode run that produced the warns. `.loombridge/verify`
      // is that engine's own default dir, so the behavior is unchanged.
      return "Resolve the warnings (or accept them), re-run `loombridge verify --strict --inputs .loombridge/verify`, then `loombridge doneness`.";
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
