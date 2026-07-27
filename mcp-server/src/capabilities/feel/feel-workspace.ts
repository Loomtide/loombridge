/**
 * Feel workspace layout: the single place the per-project feel artifacts under
 * `<workspace>/feel/` are named (workspace = `~/.loombridge/projects/<id>`,
 * resolved by the caller via `domain/workspace-paths.ts`).
 *
 * Extracted from `verification/verify.ts` so the feel-snapshot flow shares the
 * exact same paths as `verify --profile` (a snapshot capture refreshes the same
 * `profile-measurements.json` the profile grader reads).
 *
 * Snapshot layout (v1: a single current snapshot per workspace; the extra
 * directory level is the seam for named snapshots later):
 *
 *   feel/snapshots/candidate/   staged by `feel snapshot capture`, replaced per capture
 *   feel/snapshots/current/     frozen ONLY by `feel snapshot approve`
 *   feel/reports/feel-snapshot-drift.json   written by `verify --snapshot`
 */

import path from "node:path";

export interface FeelWorkspacePaths {
  /** The reviewed existing-game capture contract. */
  captureContract: string;
  /** Measurements the capture runner writes and the graders read. */
  measurements: string;
  /** Raw capture artifact bundles. */
  captureArtifacts: string;
  /** The `verify --profile` report (JSON; siblings .html/.md derive from it). */
  report: string;
  /** Staged snapshot candidate bundle (pre-approval). */
  snapshotCandidateDir: string;
  /** The approved, frozen snapshot bundle (the lockfile). */
  snapshotCurrentDir: string;
  /** The `verify --snapshot` drift report (JSON; sibling .md derives from it). */
  driftReport: string;
}

export function feelPaths(workspace: string): FeelWorkspacePaths {
  const feelRoot = path.join(workspace, "feel");
  return {
    captureContract: path.join(feelRoot, "capture-contract.json"),
    measurements: path.join(feelRoot, "profile-measurements.json"),
    captureArtifacts: path.join(feelRoot, "capture-artifacts"),
    report: path.join(feelRoot, "reports", "feel-profile.json"),
    snapshotCandidateDir: path.join(feelRoot, "snapshots", "candidate"),
    snapshotCurrentDir: path.join(feelRoot, "snapshots", "current"),
    driftReport: path.join(feelRoot, "reports", "feel-snapshot-drift.json"),
  };
}
