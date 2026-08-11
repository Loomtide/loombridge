/**
 * Verification-asset DISCOVERY for the unified `verify` front door (RFC
 * `Docs/Design/UnifiedVerify.md`, S1).
 *
 * A project accumulates verification ASSETS: a frozen, human-approved anchor plus
 * the recipe to re-measure the live game against it. This module answers, from disk
 * alone, "what can this project prove, and what approved it?". Nothing here runs a
 * gate, drives Unity, or writes to the project.
 *
 * Three rules make the answer trustworthy:
 *
 * 1. **The inventory is CLOSED.** `ASSET_KINDS` is the whole list. Adding a kind is
 *    an RFC-level change, never a quiet extra case in a switch, because a discovery
 *    that can grow silently is a plan an operator cannot audit.
 * 2. **An asset exists because an approve/init step WROTE it**, never because a
 *    heuristic sniffed for it. Every lookup below is a declared location.
 *    ONE CARVE-OUT (A5): the workspace ROUTING SCAN reads other workspaces' ownership
 *    stamps to answer "you are probably looking for `--id <other>`". It emits a plan
 *    NOTE and nothing else. It never produces a `DiscoveredAsset`, never adopts a
 *    workspace, and therefore can never contribute to (or subtract from) a verdict: a
 *    heuristic may point at an asset, but only an operator's explicit `--id` may grade
 *    one.
 * 3. **Absent provenance never skips into pass** (amendment A4). A recorded trace
 *    with no approved baseline, a baseline with no manifest, a workspace asset with
 *    no owning-project stamp: each is a `runnable: "no"` NON-ANCHOR row with a
 *    reason. It is never executed, so it can never contribute a pass, and because
 *    it is still a ROW, it is visible in the plan rather than quietly missing.
 *
 * A malformed asset never throws out of discovery: it becomes ONE `broken` row (the
 * harness tier) and the rest of the plan still resolves. A plan that aborts because
 * one file on disk is bad tells an operator nothing about the other three.
 */

import fs from "node:fs/promises";
import path from "node:path";

import {
  fileExists,
  loombridgePaths,
  readState,
  standardReplayLayout,
  type LoombridgePaths,
} from "../../../domain/state.js";
import {
  sanitizeWorkspaceId,
  projectWorkspace,
  workspacesRoot,
} from "../../../domain/workspace-paths.js";
import { discoverTraces } from "../../replay/trace.js";
import { TRACE_BASELINE_MANIFEST, verifyTraceBaseline } from "../../replay/trace-baseline-manifest.js";
import { DEFAULT_DRIFT_FRACTION, maskAnchorTerms } from "../../replay/visual-diff.js";
import { feelPaths } from "../../feel/feel-workspace.js";
import { FEEL_SNAPSHOT_MANIFEST, verifySnapshotIntegrity } from "../../feel/snapshot-manifest.js";
import { findContract } from "../../minigame/minigame-next.js";
import { isDraftContract } from "../../minigame/minigame-draft.js";
import { loadBaselineManifest, BASELINE_MANIFEST } from "../../minigame/minigame-baseline.js";
import { assertValidAcceptanceContract } from "../validator.js";
import { assertValidSlicePlan, type SlicePlan } from "../slices.js";
import { designStatus } from "../design.js";
import { projectDeclaresTests } from "../../tests/test-declaration.js";
import {
  TEST_RESULTS_FILE,
  testResultsManifestPath,
  testResultsPath,
  testRunLogPath,
  verifyTestResults,
} from "../../tests/test-results-manifest.js";
import { projectBindingMatches, type ProjectBinding } from "../../../shared/repo-identity.js";

/**
 * The CLOSED inventory (RFC "The model: verification assets"), and the ONE place a kind
 * is declared. Order is the plan's print order, cheapest and most universal first.
 *
 * - `contract`        the acceptance contract + design target (Tier-1 gate suite).
 * - `trace`           a recorded demonstration + its approved pixel baseline.
 * - `feel-snapshot`   frozen kinematics + the capture contract that measured them.
 * - `screen-contract` declared screens/objects/flow + the approved layout baseline.
 * - `test-results`    a stamped Unity EditMode test run (`loombridge tests run`), graded
 *                     offline from the stored bytes. APPENDED LAST (G14) so every existing
 *                     plan keeps its print order and only gains a row at the end.
 * - `slice-plan`      the approved slice roadmap (`SLICES.json`) and the per-slice
 *                     verdicts + evidence dirs it points at, rolled up OFFLINE (E5/L109).
 *                     APPENDED LAST for the same reason `test-results` was.
 *
 * EACH ENTRY CARRIES ITS OWN PROSE (`covers`, `nextAction`), because the ABSENCE report
 * (`absentAssetFamilies`) has to name every kind this project has no asset of, and a
 * second hand-maintained list of kinds somewhere in the reporting code is exactly the
 * drift this repo keeps paying for: the seventh kind gets added here, the reporting list
 * does not, and the gap it leaves is invisible precisely where the whole point was to make
 * gaps visible. Deriving both the closed inventory and its prose from ONE array means a
 * new kind cannot be silently omitted from either.
 */
export const ASSET_KIND_CATALOG = [
  {
    kind: "contract",
    covers: "the acceptance contract's Tier-1 gates over captured evidence in .loombridge/verify/",
    nextAction: "loombridge plan (scaffolds ACCEPTANCE.json)",
  },
  {
    kind: "trace",
    covers: "a recorded demonstration re-driven and compared pixel-for-pixel to its approved frames",
    nextAction: "loombridge trace record --id <name>, then `trace replay`, then `trace approve`",
  },
  {
    kind: "feel-snapshot",
    covers: "frozen kinematics (jump height, run speed, gravity) re-measured against the live game",
    nextAction: "loombridge feel snapshot capture, then `loombridge feel snapshot approve`",
  },
  {
    kind: "screen-contract",
    covers:
      "declared screens and their layout: safe area, tap-target size, required objects in frame, text clipping",
    nextAction: "loombridge minigame init --id <kebab>, then `capture`, then `minigame baseline approve`",
  },
  {
    kind: "test-results",
    covers: "a stamped Unity EditMode test run, graded offline from the stored results",
    nextAction: "loombridge tests run",
  },
  {
    kind: "slice-plan",
    covers: "the approved slice roadmap, rolled up from each slice's own verdict and evidence",
    nextAction: "loombridge plan --genre <pack> (a genre pack authors SLICES.json)",
  },
] as const;

/**
 * The closed kind list, DERIVED from the catalog rather than spelled a second time. Every
 * existing consumer (the plan sort, the `--only` mapping, the tests that pin the append
 * order) keeps reading this name.
 */
export const ASSET_KINDS = ASSET_KIND_CATALOG.map((entry) => entry.kind);

export type DiscoveredAssetKind = (typeof ASSET_KINDS)[number];

/** One catalog entry, as the absence report reads it. */
export interface AssetKindEntry {
  readonly kind: DiscoveredAssetKind;
  readonly covers: string;
  readonly nextAction: string;
}

/**
 * A check family this project has NO asset of, so nothing in it ran (R-gap).
 *
 * INFORMATIONAL ONLY, and deliberately a separate type from {@link DiscoveredAsset} and
 * from `UnifiedNotRun`: those two carry tiers into the outcome rule, and an absent family
 * carries none. Nothing here may ever reach `resolveUnifiedOutcome`. The reason is the
 * moat rather than tidiness: naming a gap is not covering it, and a shape that could be
 * mistaken for a graded row is one refactor away from letting "we listed what we skipped"
 * read as "we checked it".
 */
export interface AbsentAssetFamily {
  kind: DiscoveredAssetKind;
  /** What a check of this family would have established. */
  covers: string;
  /** The command that creates one. */
  nextAction: string;
  /**
   * WHERE discovery looked, when that is not the project root. The workspace assets live
   * at `~/.loombridge/projects/<id>/`, and the id is derived from the project's FOLDER
   * NAME, so "there is no screen contract" and "there is no screen contract UNDER THE ID
   * THIS FOLDER NAME DERIVES" are different sentences. Naming the directory is what lets
   * a reader see which one they are being told (see the routing note below, which names
   * the other id when one exists).
   */
  searchedIn?: string;
}

/**
 * Every known check family this project has no asset of, in catalog order.
 *
 * The catalog is a PARAMETER with a production default so a test can hand in a
 * seventh kind and prove this function reports whatever the source of truth holds,
 * rather than a list copied into this file.
 */
export function absentAssetFamilies(
  assets: readonly { kind: DiscoveredAssetKind }[],
  opts: { workspace?: string } = {},
  catalog: readonly AssetKindEntry[] = ASSET_KIND_CATALOG,
): AbsentAssetFamily[] {
  const present = new Set(assets.map((a) => a.kind));
  const absent: AbsentAssetFamily[] = [];
  for (const entry of catalog) {
    if (present.has(entry.kind)) continue;
    absent.push({
      kind: entry.kind,
      covers: entry.covers,
      nextAction: entry.nextAction,
      ...(opts.workspace !== undefined && WORKSPACE_SCOPED_KINDS.has(entry.kind)
        ? { searchedIn: opts.workspace }
        : {}),
    });
  }
  return absent;
}

/**
 * The kinds that live OUTSIDE the project, in the workspace whose id is derived from the
 * folder name. Spelled here rather than as a catalog field because it is a fact about
 * where `discoverVerificationAssets` looks, and the two lookups below are its only
 * definition: `discoverFeelSnapshotAsset` and `discoverScreenContractAsset` are the only
 * two that take a `workspace` argument.
 *
 * EXPORTED so `__tests__/unit/repo/write-paths.test.ts` can assert the carve-out is closed
 * and shrinking: every kind in here is an anchor that lives outside the project and therefore
 * cannot be committed, which is the defect ArtifactStorage S2/S3 exists to close. S3 empties
 * this set; until then the guard pins its exact membership so a THIRD kind cannot join
 * quietly.
 */
export const WORKSPACE_SCOPED_KINDS: ReadonlySet<DiscoveredAssetKind> = new Set<DiscoveredAssetKind>([
  "feel-snapshot",
  "screen-contract",
]);

/**
 * How (and whether) an asset can be checked:
 * - `offline` gradeable from files already on disk (no editor);
 * - `live`    needs a running editor to re-measure (D2: opt-in via `--live`);
 * - `no`      NOT runnable, and never executed. Either broken, or a NON-ANCHOR
 *             (unapproved / unstamped), or a draft. A `no` row can never pass.
 */
export type AssetRunnable = "offline" | "live" | "no";

/**
 * WHY a discovered asset is not runnable, as a machine-readable class rather than
 * prose. The tiering rule reads THIS; if it re-parsed the human `reason` string,
 * rewording a sentence would silently change an exit code.
 *
 * - `non-anchor` unapproved or unstamped: there is no frozen thing to compare to.
 * - `draft`      a draft screen contract: the scaffold, not the game.
 * - `broken`     tampered, unreadable, or approved for another project.
 */
export type NotRunClass = "non-anchor" | "draft" | "broken";

/** Declared locations for one asset. Every kind fills the fields it has. */
export interface DiscoveredAssetPaths {
  /** The file or dir that DECLARES the asset (contract JSON, trace JSON, snapshot dir). */
  asset: string;
  /** Where the captured inputs the check reads live, when the check reads captures. */
  inputs?: string;
  /** The approved anchor compared against (baseline dir, frozen snapshot dir). */
  baseline?: string;
  /** Where this asset's own per-asset report is written. */
  report?: string;
}

/** One row of the plan. ONE shape for all four kinds, so the plan prints uniformly. */
export interface DiscoveredAsset {
  kind: DiscoveredAssetKind;
  id: string;
  runnable: AssetRunnable;
  /** Why it is not runnable, or a qualification on a runnable row. Always set when `runnable === "no"`. */
  reason?: string;
  /** The machine-readable class of that refusal. Set IFF `runnable === "no"`. */
  notRunClass?: NotRunClass;
  /** WHEN the human anchor was approved. Absent for an unstamped/legacy or unapproved asset. */
  approvedAt?: string;
  /** WHAT approved it (the note, the source report, the contract id): the other half of the anchor question. */
  approvedBy?: string;
  /** Present IFF the asset is broken (tampered, unreadable, wrong project). Tier 2. */
  broken?: string;
  /**
   * A3/R1: the human-approved pixel drift tolerance stamped on this asset's anchor, when
   * one was stamped. TYPED, not prose, because the plan line prints it and a reader (or a
   * test) must be able to ask "was this run graded loosely?" without parsing a sentence.
   * Absent means the default, which is the strictest value the field can carry.
   */
  driftTolerance?: number;
  /**
   * Q7: how many regions of the frame this anchor excludes from the pixel comparison,
   * and the largest fraction of any one frame they hide. TYPED for the same reason the
   * tolerance is: "was this run graded blind anywhere, and how much?" must be answerable
   * without parsing a sentence. Absent means no masks, which is the strictest value.
   */
  maskCount?: number;
  maskedFraction?: number;
  /** How many of those rects are scoped to ONE capture (so not every frame is hidden equally). */
  maskScopedCount?: number;
  paths: DiscoveredAssetPaths;
}

export interface DiscoveryResult {
  assets: DiscoveredAsset[];
  /**
   * Every known check family with ZERO assets here, so the plan can say what it could
   * not check and why. Informational: it never becomes a row, a section, or a tier.
   */
  absent: AbsentAssetFamily[];
  /** Plan-level notes that belong to no single asset (e.g. an underivable workspace). */
  notes: string[];
}

export interface DiscoveryOpts {
  root: string;
  /**
   * Override the derived workspace id. The workspace assets (feel snapshot, screen
   * contract) live OUTSIDE the project, at `~/.loombridge/projects/<id>/`, and the id
   * is derived from the project folder name (D8, matching every existing verb). When
   * the folder name cannot derive one, those two kinds are skipped VISIBLY via a note
   * rather than guessed at.
   */
  workspaceId?: string;
  /**
   * Explicit workspace DIRECTORY, the same override every workspace-aware verb takes
   * (`--workspace`). Wins over `workspaceId`, and is what makes discovery addressable
   * at all: without it the only reachable workspace is the one under the real `$HOME`.
   */
  workspace?: string;
  /**
   * The DECLARED workspaces root to scan for the routing note (A5). Injectable so the
   * scan and its tests share ONE root: a test that pointed at a fixture directory while
   * the shipped code read `$HOME` would be proving something about a code path nobody
   * runs. Defaults to `workspacesRoot()`.
   */
  workspacesRoot?: string;
}

/**
 * How many workspaces the routing scan will look at (A5). Bounded because this runs on
 * every unified `verify`, and an unbounded walk of a directory a user controls is a
 * plan that gets slower the longer someone uses the product. When the cap bites, the
 * note SAYS SO rather than presenting a truncated list as the whole answer.
 */
export const WORKSPACE_SCAN_CAP = 50;

/**
 * Gather every verification asset a project declares. Deterministic: every
 * enumeration is sorted, so two runs over the same disk produce the same plan in the
 * same order. Never throws.
 */
export async function discoverVerificationAssets(opts: DiscoveryOpts): Promise<DiscoveryResult> {
  const root = path.resolve(opts.root);
  const paths = loombridgePaths(root);
  const assets: DiscoveredAsset[] = [];
  const notes: string[] = [];

  // ONE ASSET, ONE GRADER (E5). A slice-planned project grades its acceptance contract
  // PER SLICE: each slice's verdict runs that slice's gates over that slice's evidence
  // dir, and the roll-up re-grades all of them. The flat `.loombridge/verify/` contract
  // row is the NON-SLICED flow's door, and emitting it here as well would do two wrong
  // things at once: grade the (empty) flat dir, refuse "nothing graded", and pin the run
  // at the harness tier no matter what the roll-up found; and let `runVerify` write
  // build-verdict.json + flip STATE for a project whose proof is per-slice. So when a
  // roadmap exists, the contract is represented by the slice-plan row, and the note says
  // so rather than leaving a reader to wonder where the contract went.
  const slicePlanAssets = await discoverSlicePlanAsset(root, paths);
  if (slicePlanAssets.length === 0) {
    assets.push(...(await discoverContractAsset(root, paths)));
  } else if (await fileExists(paths.acceptance)) {
    notes.push(
      "the acceptance contract is graded PER SLICE (each slice's own gates over its own evidence dir) and rolled up " +
        "by the `slices` section; the flat .loombridge/verify/ contract row is the non-sliced flow's door and is not run here.",
    );
  }
  assets.push(...(await discoverTraceAssets(root)));
  assets.push(...(await discoverTestResultsAsset(root, paths)));
  assets.push(...slicePlanAssets);

  const workspaceId = opts.workspaceId ?? sanitizeWorkspaceId(path.basename(root));
  const workspace = opts.workspace ?? (workspaceId ? projectWorkspace(workspaceId) : undefined);
  if (workspace === undefined) {
    notes.push(
      `workspace assets (feel snapshot, screen contract) not discoverable for '${path.basename(root)}': ` +
        "no workspace id can be derived from the folder name; pass --id <kebab> or --workspace <dir> to include them.",
    );
  } else {
    const workspaceAssets = [
      ...(await discoverFeelSnapshotAsset(root, workspace)),
      ...(await discoverScreenContractAsset(root, workspace)),
    ];
    assets.push(...workspaceAssets);
    // R2: the refuse-only UX gap. The workspace id is derived from a FOLDER NAME, so a
    // project whose workspace was created under a different id (a renamed folder, an
    // explicit `--id` used once and forgotten) discovers nothing here and the plan says
    // only that there is nothing to find. The scan below turns that silence into
    // ROUTING: some workspace on this machine stamps THIS project root, and here is the
    // id to pass. It runs only when the derived workspace produced no assets at all.
    if (workspaceAssets.length === 0) {
      notes.push(...(await workspaceRoutingNotes(root, workspace, opts.workspacesRoot)));
    }
  }

  assets.sort(
    (a, b) => ASSET_KINDS.indexOf(a.kind) - ASSET_KINDS.indexOf(b.kind) || a.id.localeCompare(b.id),
  );
  // THE ABSENCE REPORT, computed here rather than at the call site: this function is the
  // one thing that knows both what was found and WHERE it looked. A project with only a
  // trace used to say nothing at all about the five families it never checked, so a reader
  // could not tell "those passed" from "those do not exist here".
  return { assets, absent: absentAssetFamilies(assets, { workspace }), notes };
}

// ── contract ─────────────────────────────────────────────────────────────────

/**
 * The acceptance contract. Offline by construction: the Tier-1 gates read captured
 * op output from `.loombridge/verify/`, never a live editor.
 *
 * A malformed `ACCEPTANCE.json` is a BROKEN row (tier 2), not a fatal: the contract
 * is one asset among four, and a project with a good trace baseline should still get
 * that trace checked (amendment A2). The inputs dir is NOT probed for emptiness:
 * "did anything grade?" is the ENGINE's question, answered from the assembled report
 * (`run-gates.ts` `gradedGates`), and duplicating it here as a directory test would
 * put a second, drifting answer in the plan.
 */
async function discoverContractAsset(root: string, paths: LoombridgePaths): Promise<DiscoveredAsset[]> {
  if (!(await fileExists(paths.acceptance))) return [];
  const base: DiscoveredAsset = {
    kind: "contract",
    id: "acceptance",
    runnable: "offline",
    paths: {
      asset: paths.acceptance,
      inputs: paths.verifyInputs,
      report: paths.verdict,
    },
  };

  let game: string | undefined;
  try {
    const contract = assertValidAcceptanceContract(JSON.parse(await fs.readFile(paths.acceptance, "utf-8")));
    game = contract.game;
  } catch (error) {
    return [
      {
        ...base,
        runnable: "no",
        reason: "the acceptance contract cannot be read",
        notRunClass: "broken",
        broken: `${path.relative(root, paths.acceptance)} is malformed: ${message(error)}`,
      },
    ];
  }
  base.id = game ?? "acceptance";

  // The design target is the contract asset's frozen half. Advisory for Tier-1 (it
  // never changes a gate verdict), but it IS the answer to "what approved this", so
  // the row records it and says so when the frozen bytes have moved since approval.
  const design = await designStatus(paths);
  if (design.status === "approved" && design.frozenMatches) {
    base.approvedAt = design.approvedAt ?? undefined;
    base.approvedBy = `design target (${design.kind})`;
  } else if (design.status === "approved") {
    base.reason = "design target CHANGED since approval; the hero-shot comparison is ungrounded (advisory)";
  } else {
    base.reason = "no approved design target; polish/VLM judgment is ungrounded (advisory)";
  }
  return [base];
}

// ── trace (demonstration + pixel baseline) ───────────────────────────────────

/**
 * Recorded demonstrations and their approved pixel baselines. LIVE-only: replay
 * drives the trace against a running editor.
 *
 * Provenance decides runnability, per A4:
 *  - no baseline dir at all      -> "recorded, not approved" (non-anchor).
 *  - PNGs but no manifest        -> "unstamped baseline" (non-anchor, legacy).
 *  - manifest present but the shas disagree with disk, or a PNG is undeclared
 *                                -> BROKEN (tier 2).
 *  - manifest verifies           -> runnable live, with approvedAt/approvedBy.
 */
async function discoverTraceAssets(root: string): Promise<DiscoveredAsset[]> {
  const layout = standardReplayLayout(root);
  const ids = await discoverTraces(layout.replayTraces);
  const rows: DiscoveredAsset[] = [];
  for (const id of ids) {
    const tracePath = path.join(layout.replayTraces, `${id}.trace.json`);
    const baselineDir = path.join(layout.replayBaselines, id);
    const row: DiscoveredAsset = {
      kind: "trace",
      id,
      runnable: "no",
      paths: {
        asset: tracePath,
        baseline: baselineDir,
        report: path.join(layout.replayReports, `${id}.report.json`),
      },
    };

    const integrity = await verifyTraceBaseline(baselineDir, { tracePath });
    if (integrity.unstamped) {
      const hasFrames = await dirHasPng(baselineDir);
      row.notRunClass = "non-anchor";
      row.reason = hasFrames
        ? `unstamped baseline (no ${TRACE_BASELINE_MANIFEST}): re-approve with \`loombridge trace approve --id ${id}\` to stamp what approved it`
        : `recorded, not approved: run \`loombridge trace replay --id ${id}\` then \`loombridge trace approve --id ${id}\``;
      rows.push(row);
      continue;
    }
    if (!integrity.ok) {
      row.notRunClass = "broken";
      row.reason = "the approved baseline cannot be trusted";
      row.broken = integrity.failures.join("; ");
      rows.push(row);
      continue;
    }
    row.runnable = "live";
    row.approvedAt = integrity.manifest!.approvedAt;
    // The approved tolerance travels into the PLAN, not just into the grader. A silent
    // tolerance is the failure mode this feature has to avoid: the plan line is where an
    // operator sees, before anything runs, that this anchor grades at 2% rather than 0.5%.
    // Absent field means the default, and the row stays silent about it.
    if (integrity.manifest!.driftTolerance !== undefined) {
      row.driftTolerance = integrity.manifest!.driftTolerance;
    }
    // Masks travel into the plan for the same reason, and more urgently: a tolerance
    // makes the whole frame slightly forgiving, while a mask makes part of it entirely
    // ungraded. Both numbers are re-derived from the manifest that just verified, never
    // from the row's own earlier opinion.
    const masks = integrity.manifest!.maskRects ?? [];
    if (masks.length > 0) {
      // Derived by the SAME helper the stamp verbs and the replay summary use, so the
      // plan cannot describe this anchor's terms in numbers the stamp never printed.
      const terms = maskAnchorTerms(
        masks,
        integrity.manifest!.frameWidth ?? 0,
        integrity.manifest!.frameHeight ?? 0,
        integrity.manifest!.driftTolerance ?? DEFAULT_DRIFT_FRACTION,
      );
      row.maskCount = terms.maskCount;
      row.maskedFraction = terms.maskedFraction;
      row.maskScopedCount = terms.scopedCount;
    }
    // RECORDED, not audited (L13). The frame shas above were re-derived from disk, so
    // the FRAMES are audited; the source report is a provenance note copied from the
    // manifest, and the report it names may not even exist any more. The wording says
    // which of the two this is, so the plan cannot be read as claiming more.
    row.approvedBy = `recorded from replay report ${integrity.manifest!.sourceReportSha256.slice(0, 12)}`;
    rows.push(row);
  }
  return rows;
}

// ── test results (stamped Unity EditMode run) ────────────────────────────────

/**
 * The stamped Unity test run. OFFLINE by construction (T1): `loombridge tests run` is the
 * only thing that launches an editor, and this door grades the bytes it left behind. Bare
 * `verify` therefore never takes the license seat and never fights a domain reload.
 *
 * PERMANENTLY UNANCHORED (T5/R8). `approvedAt`/`approvedBy` are deliberately never set:
 * there is no human-approve step for a test suite, and inventing one would put an
 * approval-shaped word on something no human ever looked at. The row runs, and the section
 * it feeds reports `anchored: false` forever, which is exactly what G1 then costs the run's
 * status word. Binding does NOT substitute for approval, and it does not prove freshness
 * relative to source edits either; it proves the provenance of these bytes, and `runId`
 * scopes them to a build when one exists (G7).
 *
 * The five dispositions, in the order they are decided:
 *  - manifest + XML, verifying, `projectRoot` matching this root -> runnable OFFLINE;
 *  - a build IS in flight and the manifest is not scoped to it -> BROKEN (G7, tightened by
 *    FXC: an UNSCOPED manifest is refused too, see below);
 *  - XML with no manifest -> NON-ANCHOR (a hand-dropped file never grades, H1);
 *  - manifest with no XML, a sha mismatch, or a foreign `projectRoot` -> BROKEN (G9);
 *  - neither file, but the project DECLARES tests -> NON-ANCHOR (G6: deleting the
 *    evidence must not delete the row);
 *  - neither file and no declaration -> no row at all (tests are opt-in).
 */
async function discoverTestResultsAsset(root: string, paths: LoombridgePaths): Promise<DiscoveredAsset[]> {
  const dir = paths.tests;
  const row: DiscoveredAsset = {
    kind: "test-results",
    id: "editmode",
    runnable: "no",
    paths: {
      asset: testResultsPath(dir),
      inputs: testRunLogPath(dir),
      baseline: testResultsManifestPath(dir),
    },
  };

  // `root` is passed on purpose: it makes the `projectRoot` binding LIVE here, so a manifest
  // copied out of another checkout is refused rather than quietly vouching for this one.
  const integrity = await verifyTestResults(dir, { root });

  if (integrity.unstamped) {
    if (await fileExists(testResultsPath(dir))) {
      row.notRunClass = "non-anchor";
      row.reason =
        `unstamped results (${TEST_RESULTS_FILE} with no binding manifest): run \`loombridge tests run\` ` +
        "so the results are bound to the editor, root and command that produced them";
      return [row];
    }
    const declaration = await projectDeclaresTests(root);
    if (!declaration.declared) return [];
    row.notRunClass = "non-anchor";
    row.reason =
      `tests declared, no stamped results: run \`loombridge tests run\` (${declaration.how})`;
    return [row];
  }

  if (!integrity.ok) {
    row.notRunClass = "broken";
    row.reason = "the stamped test results cannot be trusted";
    row.broken = integrity.failures.join("; ");
    return [row];
  }

  // G7, TIGHTENED BY FXC: results minted under a different build, OR under no build at all,
  // are not evidence about the build in flight.
  //
  // The earlier rule fired only when BOTH ids were non-null and differed, which left the
  // cheapest evasion wide open: a manifest whose `runId` is simply `null` passed the check by
  // having nothing to compare, so "stamped before this build started" and "stamped for this
  // build" graded identically. That is the falsy-skip anti-pattern in CLAUDE.md wearing a
  // different hat, and the fix is the same shape: when there IS a build in flight, the
  // manifest must be scoped to THAT build, and an absent scope is a refusal rather than a
  // skipped comparison.
  //
  // The other direction stays permissive on purpose: with NO build in flight there is nothing
  // to scope against (a ratchet project that never runs `build` has no runId at all), so a
  // manifest with or without a runId is accepted and the section prints which it was.
  const manifest = integrity.manifest!;
  const currentRunId = (await readState(paths).catch(() => null))?.currentBuild?.runId ?? null;
  if (currentRunId !== null && manifest.runId !== currentRunId) {
    row.notRunClass = "broken";
    row.reason = "results are not scoped to the build in flight: re-run `loombridge tests run`";
    row.broken =
      `the stamped results carry runId ${manifest.runId ?? "none"}, but the build in flight is ${currentRunId}; ` +
      "re-run `loombridge tests run` against this build";
    return [row];
  }

  row.runnable = "offline";
  // NOT an approval, and never printed as one. This is the qualification the plan prints in
  // place of "approved <when> by <what>", so a reader cannot mistake a stamped suite for a
  // human-approved anchor.
  row.reason =
    `stamped ${manifest.finishedAt} by ${manifest.resolvedEditorPath} (bound to the run, never human-approved)`;
  return [row];
}

// ── slice plan (the approved roadmap + its per-slice verdicts) ───────────────

/**
 * The slice roadmap. OFFLINE by construction (E5): every input is already on disk :
 * the per-slice verdicts, their evidence dirs, and the contract the gates re-run
 * against. Nothing here launches an editor.
 *
 * THE HUMAN ANCHOR IS THE APPROVAL. `proof.approvedAt` is set at the human checkpoint,
 * which makes an approved slice the one frozen thing this asset can be compared to.
 * That is why a plan with NO approved slice is a NON-ANCHOR row rather than a runnable
 * one: rolling up nine self-verified slices with no human sign-off anywhere would be
 * the self-graded green the door exists to refuse.
 *
 * Dispositions:
 *  - no SLICES.json                 -> no row (the whole-game flow has no roadmap);
 *  - malformed SLICES.json          -> BROKEN (tier 2);
 *  - no approved slice              -> NON-ANCHOR (nothing human-approved to roll up);
 *  - at least one approved slice    -> runnable OFFLINE, approved <when> by <how many>.
 */
async function discoverSlicePlanAsset(root: string, paths: LoombridgePaths): Promise<DiscoveredAsset[]> {
  if (!(await fileExists(paths.slices))) return [];
  const row: DiscoveredAsset = {
    kind: "slice-plan",
    id: "roadmap",
    runnable: "no",
    paths: {
      asset: paths.slices,
      inputs: paths.verifyInputs,
      report: path.join(paths.reports, "slices"),
    },
  };

  let plan: SlicePlan;
  try {
    plan = assertValidSlicePlan(JSON.parse(await fs.readFile(paths.slices, "utf-8")));
  } catch (error) {
    row.notRunClass = "broken";
    row.reason = "the slice roadmap cannot be read";
    row.broken = `${path.relative(root, paths.slices)} is malformed: ${message(error)}`;
    return [row];
  }

  row.id = plan.genre;
  const approved = plan.slices.filter((s) => s.state === "approved");
  if (approved.length === 0) {
    row.notRunClass = "non-anchor";
    row.reason =
      `${plan.slices.length} slice(s) planned, none approved: a roll-up needs at least one human-approved slice ` +
      "(build, verify, then approve it through `loombridge plan`)";
    return [row];
  }

  row.runnable = "offline";
  // The LATEST approval timestamp, so the plan line answers "when was this frozen"
  // with the most recent human decision rather than the oldest one.
  const stamps = approved
    .map((s) => s.proof?.approvedAt)
    .filter((s): s is string => typeof s === "string" && s.length > 0)
    .sort();
  if (stamps.length > 0) row.approvedAt = stamps[stamps.length - 1];
  row.approvedBy = `${approved.length}/${plan.slices.length} slice(s) approved at the human checkpoint`;
  if (stamps.length < approved.length) {
    // An approved slice with no `approvedAt` is a proof block that lost its stamp. The
    // roll-up's own `isSliceDone` delegation refuses it; the plan says so up front.
    row.reason = `${approved.length - stamps.length} approved slice(s) carry no \`proof.approvedAt\` stamp`;
  }
  return [row];
}

// ── ownership stamps ─────────────────────────────────────────────────────────

/**
 * Why a stamped anchor did not bind to this root, for the `broken` line. Message text
 * only: the DECISION is `projectBindingMatches` in `shared/repo-identity.ts`, shared with
 * the stamped test-results trio so one rule decides all three.
 *
 * The `basename:` case gets its own sentence because the generic one MISLEADS there. A
 * no-remote repo stamps `basename:<dir>`, so a second no-remote repo of the same name
 * reads back an identity string identical to the one it would derive itself, with no
 * stated reason for the refusal and a remedy (re-approve) that cannot work: the identity
 * would come out the same. `git remote add origin` is the fix, so the message says so.
 */
function bindingDetail(binding: ProjectBinding, restamp: string): string {
  if (binding.repoIdentity === undefined) {
    return ` (no portable stamp: approved before portable binding, or a non-git project; re-approve with \`${restamp}\` to re-stamp)`;
  }
  if (binding.repoIdentity.startsWith("basename:")) {
    return (
      ` (stamped repo ${binding.repoIdentity} at ${binding.projectPath}: a \`basename:\` identity is a DIRECTORY NAME, ` +
      "which two unrelated repos share, so it never binds across checkouts. Give the repo an origin " +
      `(\`git remote add origin <url>\`) and re-approve with \`${restamp}\`; re-approving alone re-derives the same name.)`
    );
  }
  return ` (stamped repo ${binding.repoIdentity} at ${binding.projectPath})`;
}

/**
 * How a matching binding matched, when the answer is not obvious from the row. Empty for
 * the ordinary case (the anchor was approved at exactly this path), and a PROVENANCE
 * sentence when it bound PORTABLY, naming the absolute path it was approved at.
 *
 * Silence here loses a signal that existed before portable binding: two checkouts of one
 * repo share a home workspace (its id is the folder BASENAME), and the second checkout
 * used to read `broken`, which told the operator the anchor was not theirs. It now grades
 * live, correctly, but an operator who did not expect a shared anchor deserves to see
 * that the thing grading them was frozen somewhere else.
 */
function portableProvenance(binding: ProjectBinding, root: string): string | undefined {
  if (path.resolve(root) === path.resolve(binding.projectRoot)) return undefined;
  return `bound PORTABLY: approved at ${binding.projectRoot}, graded here as the same repo (${binding.repoIdentity}) at ${binding.projectPath}`;
}

// ── feel snapshot ────────────────────────────────────────────────────────────

/**
 * The frozen feel snapshot (a lockfile for game feel). LIVE-only: grading it means
 * re-measuring the running game with the snapshot's own frozen capture contract.
 *
 * Integrity is recomputed from disk (`verifySnapshotIntegrity`) rather than read off
 * the manifest, because a doctored baseline fails its own re-derivation. The ownership
 * stamp is checked on top of that: a snapshot approved for a DIFFERENT project is
 * broken, because the workspace path is derived from the project's folder NAME and two
 * checkouts can collide on it. "Different project" is decided by the portable rule (same
 * repo, same position inside it), so a snapshot COMMITTED by one teammate still binds on
 * another's checkout at a different absolute path.
 */
async function discoverFeelSnapshotAsset(root: string, workspace: string): Promise<DiscoveredAsset[]> {
  const dir = feelPaths(workspace).snapshotCurrentDir;
  if (!(await dirExists(dir))) return [];
  const row: DiscoveredAsset = {
    kind: "feel-snapshot",
    id: "current",
    runnable: "no",
    paths: { asset: dir, baseline: dir, report: feelPaths(workspace).driftReport },
  };

  const integrity = await verifySnapshotIntegrity(dir);
  if (!integrity.ok) {
    row.notRunClass = "broken";
    row.reason = "the approved feel snapshot cannot be trusted";
    row.broken = integrity.failures.join("; ");
    return [row];
  }
  const manifest = integrity.manifest!;
  const projectRoot = manifest.projectRoot;
  // An ABSENT stamp is a refusal (non-anchor), never a default: an unbound snapshot
  // would grade whatever project it was found next to.
  if (projectRoot === undefined) {
    row.notRunClass = "non-anchor";
    row.reason =
      "unstamped snapshot (approved before ownership stamping): re-approve with " +
      "`loombridge feel snapshot approve` so the verdict is bound to this project";
    return [row];
  }
  const binding: ProjectBinding = {
    projectRoot,
    repoIdentity: manifest.repoIdentity,
    projectPath: manifest.projectPath,
  };
  if (!projectBindingMatches(binding, root)) {
    row.notRunClass = "broken";
    row.reason = "the approved feel snapshot belongs to another project";
    row.broken =
      `snapshot projectRoot is ${manifest.projectRoot}, verifying ${root}` +
      bindingDetail(binding, "loombridge feel snapshot approve");
    return [row];
  }
  row.runnable = "live";
  row.approvedAt = manifest.approvedAt;
  row.approvedBy = manifest.note ?? "human approval";
  // A portable match is never silent: the row names the path this anchor was frozen at.
  const provenance = portableProvenance(binding, root);
  if (provenance !== undefined) row.reason = provenance;
  return [row];
}

// ── screen contract ──────────────────────────────────────────────────────────

/**
 * The screen contract (the `minigame` verb family's asset; "screens" in unified
 * vocabulary). OFFLINE: it grades a declared contract against an already-captured
 * per-state pack.
 *
 * A DRAFT contract is not-runnable, never broken (A10): the placeholders are what
 * `finalize` is for, and grading them would measure the scaffold, not the game. An
 * APPROVED LAYOUT BASELINE IS REQUIRED for the row to run at all (H1, see below); one
 * with no ownership stamp is a non-anchor (A4), and one stamped for another project is
 * broken.
 */
async function discoverScreenContractAsset(root: string, workspace: string): Promise<DiscoveredAsset[]> {
  const contractPath = await findContract(workspace);
  if (!contractPath) return [];
  const capturesDir = path.join(workspace, "captures");
  const baselineDir = path.join(workspace, "baseline");
  const row: DiscoveredAsset = {
    kind: "screen-contract",
    id: path.basename(contractPath, ".minigame.json"),
    runnable: "no",
    paths: {
      asset: contractPath,
      inputs: capturesDir,
      baseline: baselineDir,
      report: path.join(workspace, "reports", "minigame-verification.json"),
    },
  };

  let contract: { id?: unknown; description?: unknown; states?: unknown };
  try {
    contract = JSON.parse(await fs.readFile(contractPath, "utf-8"));
  } catch (error) {
    row.notRunClass = "broken";
    row.reason = "the screen contract cannot be read";
    row.broken = `${contractPath} is unreadable: ${message(error)}`;
    return [row];
  }
  if (typeof contract !== "object" || contract === null) {
    row.notRunClass = "broken";
    row.reason = "the screen contract cannot be read";
    row.broken = `${contractPath} is not a JSON object`;
    return [row];
  }
  if (typeof contract.id === "string" && contract.id.length > 0) row.id = contract.id;

  if (isDraftContract(contract)) {
    row.notRunClass = "draft";
    row.reason = "contract draft: run `loombridge minigame finalize` to bind the real locators";
    return [row];
  }

  // THE APPROVED LAYOUT BASELINE IS REQUIRED, not optional (H1).
  //
  // An earlier cut treated its absence as a qualification on a runnable row: "declared
  // screens are graded, drift is not enforced". That was the one hole in the unified
  // door big enough to drive a manufactured pass through. A screen contract and its
  // capture pack are BOTH producible by the same agent in the same session, so with no
  // frozen third thing the section grades a document against captures of that document
  // and reports `pass`. Nothing a human ever approved is involved, yet the roll-up
  // reads `pass` and exit 0. The baseline manifest is the only artifact on this path a
  // human's `baseline approve` had to produce, and its `projectRoot` stamp is also what
  // binds the workspace (whose id is derived from a FOLDER NAME two checkouts can share)
  // to the root being verified. No stamped baseline, no execution.
  const manifestPresent = await fileExists(path.join(baselineDir, BASELINE_MANIFEST));
  if (!manifestPresent) {
    row.notRunClass = "non-anchor";
    row.reason =
      "declared screens without an approved layout baseline: run `loombridge minigame baseline approve` " +
      "(a contract graded against captures of itself is not a human anchor)";
    return [row];
  }
  const load = await loadBaselineManifest(baselineDir);
  if (load.status !== "ok") {
    row.notRunClass = "broken";
    row.reason = "the approved layout baseline cannot be read";
    row.broken =
      load.status === "refused"
        ? `${path.join(baselineDir, BASELINE_MANIFEST)} is unreadable or not a screen-contract baseline: ${load.reason}`
        : `${path.join(baselineDir, BASELINE_MANIFEST)} disappeared between the presence check and the read`;
    return [row];
  }
  const manifest = load.manifest;
  const projectRoot = manifest.projectRoot;
  // An ABSENT stamp is a refusal (non-anchor), never a default: an unbound baseline
  // would grade whatever project it was found next to.
  if (projectRoot === undefined) {
    row.notRunClass = "non-anchor";
    row.reason =
      "unstamped layout baseline (approved before ownership stamping): re-approve with " +
      "`loombridge minigame baseline approve` so the verdict is bound to this project";
    return [row];
  }
  const binding: ProjectBinding = {
    projectRoot,
    repoIdentity: manifest.repoIdentity,
    projectPath: manifest.projectPath,
  };
  if (!projectBindingMatches(binding, root)) {
    row.notRunClass = "broken";
    row.reason = "the approved layout baseline belongs to another project";
    row.broken =
      `baseline projectRoot is ${manifest.projectRoot}, verifying ${root}` +
      bindingDetail(binding, "loombridge minigame baseline approve");
    return [row];
  }
  row.approvedAt = manifest.capturedAt;
  row.approvedBy = `screen contract '${manifest.contractId}'`;
  row.runnable = "offline";
  // A portable match is never silent: the row names the path this anchor was frozen at.
  const provenance = portableProvenance(binding, root);
  if (provenance !== undefined) row.reason = provenance;
  return [row];
}

// ── workspace routing note (R2) ──────────────────────────────────────────────

/**
 * "Some OTHER workspace stamps this project root", as a NOTE and never as an asset (A5).
 *
 * The gap this closes is pure UX, and it was observed live: the workspace id is derived
 * from the project's folder name, so a project verified after a rename (or one whose
 * workspace was created once under an explicit `--id`) finds nothing, and the plan can
 * only say that nothing was found. The operator is left guessing an id.
 *
 * What it must NOT do is adopt the match. Two checkouts can share a folder name, an
 * ownership stamp is a claim made by the workspace about the project rather than the
 * other way round, and silently grading assets the operator did not ask for would make
 * the verdict depend on whatever else is on the machine. So this returns routing text:
 * every match, sorted, with the explicit statement that the CHOICE of id changes the
 * verdict, and an honest word when the scan cap cut the answer short.
 *
 * Cost is bounded on both axes: at most {@link WORKSPACE_SCAN_CAP} workspaces, at most
 * two manifest reads each.
 */
async function workspaceRoutingNotes(
  root: string,
  usedWorkspace: string,
  scanRootOverride: string | undefined,
): Promise<string[]> {
  const scanRoot = scanRootOverride ?? workspacesRoot();
  let entries: string[];
  try {
    entries = (await fs.readdir(scanRoot, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
  const truncated = entries.length > WORKSPACE_SCAN_CAP;
  const notes: string[] = [];
  const matches: string[] = [];
  for (const id of entries.slice(0, WORKSPACE_SCAN_CAP)) {
    const dir = path.join(scanRoot, id);
    // The workspace this run already looked in is not a routing answer: it produced no
    // assets, which is why we are here.
    if (path.resolve(dir) === path.resolve(usedWorkspace)) continue;
    const stamps = await stampedProjectRoots(dir);
    // The SAME rule the anchors themselves bind by. Comparing raw absolute paths made the
    // note blind exactly where portable binding now helps: a teammate whose anchor DOES
    // bind portably got "no assets found" and no hint about which `--id` to pass, while
    // the author of the anchor got the hint.
    if (stamps.some((stamp) => projectBindingMatches(stamp, root))) matches.push(id);
  }
  if (matches.length > 0) {
    notes.push(
      `${matches.map((id) => `workspace '${id}'`).join(", ")} ` +
        `${matches.length === 1 ? "stamps" : "stamp"} this project root but ` +
        `${matches.length === 1 ? "was" : "were"} not used: pass --id <id> (or --workspace <dir>) to include ` +
        "its assets. Nothing is adopted automatically, and WHICH id you pass changes what is measured and " +
        "therefore the verdict.",
    );
  }
  if (truncated) {
    notes.push(
      `the workspace scan stopped at the first ${WORKSPACE_SCAN_CAP} of ${entries.length} directories under ` +
        `${scanRoot}, so this routing list may be incomplete.`,
    );
  }
  return notes;
}

/**
 * The owning-project BINDINGS a workspace declares, from AT MOST two declared files: the
 * frozen feel snapshot's manifest and the screen-contract layout baseline's manifest.
 * Read as raw JSON on purpose (never integrity-verified): this is routing, and a
 * workspace whose assets are broken is exactly the one an operator most needs pointing
 * at. Anything unreadable simply contributes no stamp.
 *
 * The whole binding travels, not just `projectRoot`, so the caller can ask the SAME
 * question the anchors ask rather than a weaker absolute-path one.
 */
async function stampedProjectRoots(workspace: string): Promise<ProjectBinding[]> {
  const files = [
    path.join(feelPaths(workspace).snapshotCurrentDir, FEEL_SNAPSHOT_MANIFEST),
    path.join(workspace, "baseline", BASELINE_MANIFEST),
  ];
  const stamps: ProjectBinding[] = [];
  for (const file of files) {
    try {
      const parsed = JSON.parse(await fs.readFile(file, "utf-8")) as {
        projectRoot?: unknown;
        repoIdentity?: unknown;
        projectPath?: unknown;
      } | null;
      const stamp = parsed?.projectRoot;
      if (typeof stamp !== "string" || stamp.length === 0) continue;
      stamps.push({
        projectRoot: stamp,
        ...(typeof parsed?.repoIdentity === "string" ? { repoIdentity: parsed.repoIdentity } : {}),
        ...(typeof parsed?.projectPath === "string" ? { projectPath: parsed.projectPath } : {}),
      });
    } catch {
      /* unreadable or absent: no stamp, never a throw out of discovery */
    }
  }
  return stamps;
}

// ── helpers ──────────────────────────────────────────────────────────────────

async function dirExists(dir: string): Promise<boolean> {
  try {
    return (await fs.stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

async function dirHasPng(dir: string): Promise<boolean> {
  try {
    return (await fs.readdir(dir)).some((e) => e.endsWith(".png"));
  } catch {
    return false;
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
