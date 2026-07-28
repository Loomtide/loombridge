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
import { sanitizeWorkspaceId, projectWorkspace } from "../../../domain/workspace-paths.js";
import { discoverTraces } from "../../replay/trace.js";
import { TRACE_BASELINE_MANIFEST, verifyTraceBaseline } from "../../replay/trace-baseline-manifest.js";
import { feelPaths } from "../../feel/feel-workspace.js";
import { verifySnapshotIntegrity } from "../../feel/snapshot-manifest.js";
import { findContract } from "../../minigame/minigame-next.js";
import { isDraftContract } from "../../minigame/minigame-draft.js";
import { loadBaselineManifest, BASELINE_MANIFEST } from "../../minigame/minigame-baseline.js";
import { assertValidAcceptanceContract } from "../validator.js";
import { designStatus } from "../design.js";
import { projectDeclaresTests } from "../../tests/test-declaration.js";
import {
  TEST_RESULTS_FILE,
  testResultsManifestPath,
  testResultsPath,
  testRunLogPath,
  verifyTestResults,
} from "../../tests/test-results-manifest.js";

/**
 * The CLOSED inventory (RFC "The model: verification assets"). Order is the plan's
 * print order, cheapest and most universal first.
 *
 * - `contract`        the acceptance contract + design target (Tier-1 gate suite).
 * - `trace`           a recorded demonstration + its approved pixel baseline.
 * - `feel-snapshot`   frozen kinematics + the capture contract that measured them.
 * - `screen-contract` declared screens/objects/flow + the approved layout baseline.
 * - `test-results`    a stamped Unity EditMode test run (`loombridge tests run`), graded
 *                     offline from the stored bytes. APPENDED LAST (G14) so every existing
 *                     plan keeps its print order and only gains a row at the end.
 */
export const ASSET_KINDS = ["contract", "trace", "feel-snapshot", "screen-contract", "test-results"] as const;

export type DiscoveredAssetKind = (typeof ASSET_KINDS)[number];

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
  paths: DiscoveredAssetPaths;
}

export interface DiscoveryResult {
  assets: DiscoveredAsset[];
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
}

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

  assets.push(...(await discoverContractAsset(root, paths)));
  assets.push(...(await discoverTraceAssets(root)));
  assets.push(...(await discoverTestResultsAsset(root, paths)));

  const workspaceId = opts.workspaceId ?? sanitizeWorkspaceId(path.basename(root));
  const workspace = opts.workspace ?? (workspaceId ? projectWorkspace(workspaceId) : undefined);
  if (workspace === undefined) {
    notes.push(
      `workspace assets (feel snapshot, screen contract) not discoverable for '${path.basename(root)}': ` +
        "no workspace id can be derived from the folder name; pass --id <kebab> or --workspace <dir> to include them.",
    );
  } else {
    assets.push(...(await discoverFeelSnapshotAsset(root, workspace)));
    assets.push(...(await discoverScreenContractAsset(root, workspace)));
  }

  assets.sort(
    (a, b) => ASSET_KINDS.indexOf(a.kind) - ASSET_KINDS.indexOf(b.kind) || a.id.localeCompare(b.id),
  );
  return { assets, notes };
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
 *  - manifest `runId` and the CURRENT STATE `runId` both set and different -> BROKEN (G7);
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

  // G7: results minted under a DIFFERENT build than the one in flight are evidence about
  // some other build. Both ids must be non-null for this to fire; a run with no build in
  // flight, or results stamped before run-binding existed, is scoped by nothing and says so
  // rather than being refused for a comparison that cannot be made.
  const manifest = integrity.manifest!;
  const currentRunId = (await readState(paths).catch(() => null))?.currentBuild?.runId ?? null;
  if (manifest.runId !== null && currentRunId !== null && manifest.runId !== currentRunId) {
    row.notRunClass = "broken";
    row.reason = "results from a different build run";
    row.broken =
      `the stamped results carry runId ${manifest.runId}, but the build in flight is ${currentRunId}; ` +
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

// ── feel snapshot ────────────────────────────────────────────────────────────

/**
 * The frozen feel snapshot (a lockfile for game feel). LIVE-only: grading it means
 * re-measuring the running game with the snapshot's own frozen capture contract.
 *
 * Integrity is recomputed from disk (`verifySnapshotIntegrity`) rather than read off
 * the manifest, because a doctored baseline fails its own re-derivation. The ownership
 * stamp is checked on top of that: a snapshot approved for a DIFFERENT project root
 * is broken, because the workspace path is derived from the project's folder NAME
 * and two checkouts can collide on it.
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
  if (manifest.projectRoot === undefined) {
    row.notRunClass = "non-anchor";
    row.reason =
      "unstamped snapshot (approved before ownership stamping): re-approve with " +
      "`loombridge feel snapshot approve` so the verdict is bound to this project";
    return [row];
  }
  if (path.resolve(manifest.projectRoot) !== root) {
    row.notRunClass = "broken";
    row.reason = "the approved feel snapshot belongs to another project";
    row.broken = `snapshot projectRoot is ${manifest.projectRoot}, verifying ${root}`;
    return [row];
  }
  row.runnable = "live";
  row.approvedAt = manifest.approvedAt;
  row.approvedBy = manifest.note ?? "human approval";
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
  const manifest = await loadBaselineManifest(baselineDir);
  if (!manifest) {
    row.notRunClass = "broken";
    row.reason = "the approved layout baseline cannot be read";
    row.broken = `${path.join(baselineDir, BASELINE_MANIFEST)} is unreadable or not a screen-contract baseline`;
    return [row];
  }
  if (manifest.projectRoot === undefined) {
    row.notRunClass = "non-anchor";
    row.reason =
      "unstamped layout baseline (approved before ownership stamping): re-approve with " +
      "`loombridge minigame baseline approve` so the verdict is bound to this project";
    return [row];
  }
  if (path.resolve(manifest.projectRoot) !== root) {
    row.notRunClass = "broken";
    row.reason = "the approved layout baseline belongs to another project";
    row.broken = `baseline projectRoot is ${manifest.projectRoot}, verifying ${root}`;
    return [row];
  }
  row.approvedAt = manifest.capturedAt;
  row.approvedBy = `screen contract '${manifest.contractId}'`;
  row.runnable = "offline";
  return [row];
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
