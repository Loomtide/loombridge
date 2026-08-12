/**
 * Feel snapshot manifest: the "lockfile for game feel".
 *
 * A snapshot freezes a game's MEASURED BEHAVIOR (kinematics from the running
 * game) after a human plays it and approves ("this feels right"). Afterwards
 * `verify --snapshot` grades kinematic DRIFT against the frozen values, the way
 * `trace` grades pixel drift. Freezing measured behavior rather than serialized
 * parameters is the point: a physics-material swap, timestep change, or collider
 * resize regresses the feel while touching no tuned field, and only a behavioral
 * baseline can catch it.
 *
 * Same approve-once / freeze / refuse-drift grammar as the Design Target
 * (`verification/design.ts`, sha256-pinned hero shot) and the mini-game baseline
 * (`minigame/minigame-baseline.ts`): approval state lives beside the artifacts it
 * freezes, integrity is sha256 recorded at freeze and recomputed at read, a
 * tampered or partial bundle is refused (never a silent pass), and only a clean
 * candidate may be frozen.
 *
 * Genre neutrality (genre-core LITMUS): metric ids are OPAQUE STRINGS, and the
 * per-metric `derivation` comes from the capture contract's recipe entries, never
 * from any pack vocabulary.
 */

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { deriveRepoIdentity, projectBindingPairError } from "../../shared/repo-identity.js";

import { rederiveFromSources } from "../verification/gates/feel-rederive.js";
import { stimulusDistrust } from "../verification/gates/feel-provenance.js";
import { parseMeasurements, type FeelMeasurementsFile } from "./measurements.js";
import type { FeelCaptureCoverageEntry } from "./types.js";

export const FEEL_SNAPSHOT_MANIFEST = "manifest.json";
export const SNAPSHOT_MEASUREMENTS_FILE = "measurements.json";
export const SNAPSHOT_CONTRACT_FILE = "capture-contract.json";

export interface FeelSnapshotMetricEntry {
  /** The frozen measured value. */
  value: number;
  /**
   * Derivation kind from the capture contract's recipe for this metric
   * (trajectory | phase-delta | bisection | sync | trace | reported | ...).
   * Genre-neutral; drives the default tolerance floor. Absent when the contract
   * carries no recipe for the metric.
   */
  derivation?: string;
  /**
   * §0 verdict at approve time: `verified` (re-derived from the capture's own
   * raw samples) or `reported` (no re-derivable backing). A `rejected` value
   * never freezes: approve refuses it.
   */
  confidence: "verified" | "reported";
}

export interface FeelSnapshotTolerancePolicy {
  /** Relative tolerance as a fraction of |baseline| (default 0.05). */
  defaultRelPct: number;
  /** Absolute floor per derivation kind, in the metric's native unit. */
  defaultAbsFloorByDerivation: Record<string, number>;
  /**
   * Frozen per-metric overrides (from `--tolerances` at approve). NEVER
   * overridable at verify time: a lockfile whose tolerance can be widened at
   * check time is not a lockfile; re-approval is the change path.
   */
  perMetric?: Record<string, { relPct?: number; abs?: number }>;
}

/**
 * Defaults are sized against known single-capture variance: sync metrics
 * quantize at the ~80ms capture cadence (floor 100ms), bisection metrics
 * (coyote/jump-buffer, in seconds) get one-fixed-tick-ish 0.02s, trajectory and
 * phase-delta kinematics get a small absolute floor with the 5% relative band
 * absorbing shortHop-style injection jitter.
 */
export const DEFAULT_SNAPSHOT_TOLERANCES: FeelSnapshotTolerancePolicy = {
  defaultRelPct: 0.05,
  defaultAbsFloorByDerivation: {
    trajectory: 0.05,
    "phase-delta": 0.05,
    bisection: 0.02,
    sync: 100,
    trace: 0.05,
    reported: 0,
  },
};

export interface FeelSnapshotManifest {
  schemaVersion: "1";
  kind: "feel-snapshot";
  /** From the capture contract's `game`, when present. */
  game?: string;
  /**
   * OWNERSHIP STAMP: the absolute PROJECT root this snapshot was approved for.
   *
   * The snapshot lives in an external workspace (`~/.loombridge/projects/<id>/`),
   * derived from the project's basename, so two different checkouts that sanitize
   * to the same id resolve to the SAME workspace, and a verify run in project B
   * would silently grade against project A's frozen feel. Discovery refuses a stamp
   * that names a different root.
   *
   * OPTIONAL by design (schema-tolerant): manifests approved before this field
   * existed carry no stamp and must still load and verify. An unstamped snapshot is
   * not tampering; it is a non-anchor ("re-approve to stamp") for the caller.
   */
  projectRoot?: string;
  /**
   * PORTABLE binding (optional; stamped at approve time when the project sits in a git
   * working tree): the repository identity (origin URL, else a stated basename fallback
   * that never matches portably) plus the project's path relative to the git toplevel.
   * This is what lets a COMMITTED snapshot grade on a teammate's checkout at a different
   * absolute path, while a snapshot from a DIFFERENT repository still reads broken.
   * Absent on snapshots approved before portable binding and on non-git projects: those
   * bind by absolute path only, and re-approving re-stamps them portably.
   */
  repoIdentity?: string;
  projectPath?: string;
  engine: { engine: string | null };
  capturedAt: string;
  approvedAt: string;
  /** The human "this feels right" statement. */
  note?: string;
  /** Seam for N-run averaging; v1 always 1. */
  captureRuns: 1;
  /**
   * The snapshot is bound to HOW it was measured: the frozen contract's sha256.
   * Comparing a baseline against a different stimulus contract is apples to
   * oranges; a mismatch at verify time refuses (re-approve under the new one).
   */
  captureContract: { sha256: string; file: typeof SNAPSHOT_CONTRACT_FILE; interactions: number; metrics: number };
  measurements: { sha256: string; file: typeof SNAPSHOT_MEASUREMENTS_FILE };
  /** Frozen measured behavior per (opaque) metric id. */
  metrics: Record<string, FeelSnapshotMetricEntry>;
  /** Present only when approved with --allow-partial: gaps recorded, never silent. */
  coverageGaps?: FeelCaptureCoverageEntry[];
  /** Baseline §0 summary at approve time (recomputed, never trusted, at read). */
  rederivation: { pass: number; total: number };
  tolerancePolicy: FeelSnapshotTolerancePolicy;
}

export function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Shape-check + load a manifest from a snapshot dir. Returns null for an absent
 * OR malformed manifest (the caller reports which via fs.access if it needs to
 * distinguish); integrity beyond shape lives in `verifySnapshotIntegrity`.
 */
export async function loadSnapshotManifest(dir: string): Promise<FeelSnapshotManifest | null> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(dir, FEEL_SNAPSHOT_MANIFEST), "utf-8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  if (parsed.kind !== "feel-snapshot" || parsed.schemaVersion !== "1") return null;
  if (!isRecord(parsed.metrics) || Object.keys(parsed.metrics).length === 0) return null;
  if (!isRecord(parsed.measurements) || typeof parsed.measurements.sha256 !== "string") return null;
  if (!isRecord(parsed.captureContract) || typeof parsed.captureContract.sha256 !== "string") return null;
  if (typeof parsed.approvedAt !== "string" || typeof parsed.capturedAt !== "string") return null;
  if (!isRecord(parsed.tolerancePolicy)) return null;
  // The portable binding pair is optional, but a HALF pair is refused rather than
  // ignored: a repoIdentity with no projectPath would claim any position inside the
  // repo, and dropping the odd field is exactly the "absent means skip the check" shape
  // the ownership stamp exists to prevent. A refused manifest reads as unreadable here,
  // which discovery reports as broken (tier 2), never as a silent pass.
  if (projectBindingPairError(parsed) !== null) return null;
  return parsed as unknown as FeelSnapshotManifest;
}

/** Map metric id to the contract recipe's derivation, leniently parsed. */
export function derivationsFromContract(contractJson: unknown): Map<string, string> {
  const out = new Map<string, string>();
  if (!isRecord(contractJson) || !Array.isArray(contractJson.metrics)) return out;
  for (const entry of contractJson.metrics) {
    if (!isRecord(entry)) continue;
    if (typeof entry.metric === "string" && typeof entry.derivation === "string") {
      out.set(entry.metric, entry.derivation);
    }
  }
  return out;
}

/**
 * Compute the §0 view of a measurements file: which metric ids re-derived
 * cleanly (`verified`), which are refused (`distrusted`, with reasons), and the
 * raw pass/total counts. Shared by approve (freezing) and integrity (re-check).
 */
export function rederiveView(measurements: FeelMeasurementsFile): {
  verified: Set<string>;
  distrusted: Map<string, string>;
  pass: number;
  total: number;
} {
  const verdicts = rederiveFromSources(measurements.provenance?.sources ?? [], measurements.metrics);
  const distrusted = new Map<string, string>(
    verdicts.filter((v) => v.status === "fail").map((v) => [v.metric, v.detail]),
  );
  for (const [metric, reason] of stimulusDistrust(
    Object.keys(measurements.metrics),
    measurements.provenance?.sources ?? [],
  )) {
    if (!distrusted.has(metric)) distrusted.set(metric, reason);
  }
  const verified = new Set<string>(
    verdicts.filter((v) => v.status === "pass" && !distrusted.has(v.metric)).map((v) => v.metric),
  );
  return { verified, distrusted, pass: verified.size, total: verdicts.length };
}

export interface WriteSnapshotBundleArgs {
  /** Dir holding the candidate `measurements.json` + `capture-contract.json`. */
  candidateDir: string;
  /** Destination dir for the frozen bundle (replaced atomically enough for v1). */
  currentDir: string;
  engine: { engine: string | null };
  capturedAt: string;
  approvedAt: string;
  note?: string;
  tolerancePolicy: FeelSnapshotTolerancePolicy;
  /** Metric entries the caller vetted (approve refuses rejected/unclean first). */
  metrics: Record<string, FeelSnapshotMetricEntry>;
  coverageGaps?: FeelCaptureCoverageEntry[];
  rederivation: { pass: number; total: number };
  game?: string;
  /**
   * Absolute PROJECT root this approval is for (the ownership stamp). The portable
   * pair is DERIVED from it here rather than passed in, so a caller cannot stamp half
   * of it, and so every approve path is portable without having to remember to be.
   */
  projectRoot?: string;
  contractStats: { interactions: number; metrics: number };
}

/** Copy the candidate files into `currentDir`, hash them, write the manifest. */
export async function writeSnapshotBundle(args: WriteSnapshotBundleArgs): Promise<FeelSnapshotManifest> {
  const measurementsBytes = await fs.readFile(path.join(args.candidateDir, SNAPSHOT_MEASUREMENTS_FILE));
  const contractBytes = await fs.readFile(path.join(args.candidateDir, SNAPSHOT_CONTRACT_FILE));
  await fs.mkdir(args.currentDir, { recursive: true });
  await fs.writeFile(path.join(args.currentDir, SNAPSHOT_MEASUREMENTS_FILE), measurementsBytes);
  await fs.writeFile(path.join(args.currentDir, SNAPSHOT_CONTRACT_FILE), contractBytes);
  const manifest: FeelSnapshotManifest = {
    schemaVersion: "1",
    kind: "feel-snapshot",
    ...(args.game !== undefined ? { game: args.game } : {}),
    ...(args.projectRoot !== undefined ? { projectRoot: args.projectRoot } : {}),
    // The portable pair travels with the absolute stamp and only with it: without a
    // projectRoot there is nothing for it to make portable. A non-git project derives
    // null and stays absolute-path-bound, which is the pre-portable behavior.
    ...(args.projectRoot !== undefined ? (deriveRepoIdentity(args.projectRoot) ?? {}) : {}),
    engine: args.engine,
    capturedAt: args.capturedAt,
    approvedAt: args.approvedAt,
    ...(args.note !== undefined ? { note: args.note } : {}),
    captureRuns: 1,
    captureContract: {
      sha256: sha256(contractBytes),
      file: SNAPSHOT_CONTRACT_FILE,
      interactions: args.contractStats.interactions,
      metrics: args.contractStats.metrics,
    },
    measurements: { sha256: sha256(measurementsBytes), file: SNAPSHOT_MEASUREMENTS_FILE },
    metrics: args.metrics,
    ...(args.coverageGaps && args.coverageGaps.length > 0 ? { coverageGaps: args.coverageGaps } : {}),
    rederivation: args.rederivation,
    tolerancePolicy: args.tolerancePolicy,
  };
  await fs.writeFile(
    path.join(args.currentDir, FEEL_SNAPSHOT_MANIFEST),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf-8",
  );
  return manifest;
}

export interface SnapshotIntegrityResult {
  ok: boolean;
  /** Named refusals; empty iff ok. */
  failures: string[];
  manifest?: FeelSnapshotManifest;
  /** The frozen measurements, parsed (present when readable). */
  measurements?: FeelMeasurementsFile;
  /**
   * True when a manifest FILE exists at `dir` but was refused (bad shape, a half-stamped
   * portable pair). Distinct from "no snapshot approved yet", which is the same file being
   * absent: a caller that collapses the two tells an operator to approve a snapshot that
   * already exists, and reports an ungradeable anchor as an empty workspace.
   */
  manifestRefused?: boolean;
}

/**
 * Verify a frozen bundle end to end. Every check is a named refusal:
 *  - manifest present and well-shaped;
 *  - frozen measurements/contract bytes match their recorded sha256;
 *  - every manifest metric value STRICTLY equals the frozen measurements value
 *    (a hand-edited manifest cannot drift from its own evidence);
 *  - §0 re-derivation over the FROZEN samples has zero fails, and every entry
 *    the manifest calls `verified` actually re-derives (a doctored baseline
 *    fails its own re-derivation).
 * Verdicts are recomputed at read; nothing is trusted from the manifest.
 */
export async function verifySnapshotIntegrity(dir: string): Promise<SnapshotIntegrityResult> {
  const failures: string[] = [];
  const manifest = await loadSnapshotManifest(dir);
  if (!manifest) {
    const file = path.join(dir, FEEL_SNAPSHOT_MANIFEST);
    // PRESENT-but-refused is not ABSENT. Both are `ok: false`, so no gate changes here,
    // but the two need different words: one says "approve a snapshot", the other says
    // "the snapshot you approved cannot be read", and only the second is a refusal.
    const present = await fs
      .access(file)
      .then(() => true)
      .catch(() => false);
    return present
      ? {
          ok: false,
          manifestRefused: true,
          failures: [
            `feel-snapshot manifest at ${file} is present but REFUSED (bad shape, or a half-stamped repoIdentity/projectPath pair)`,
          ],
        }
      : { ok: false, failures: [`no readable feel-snapshot manifest at ${file}`] };
  }

  let measurementsBytes: Buffer | null = null;
  try {
    measurementsBytes = await fs.readFile(path.join(dir, manifest.measurements.file));
  } catch {
    failures.push(`frozen measurements missing (${manifest.measurements.file})`);
  }
  if (measurementsBytes && sha256(measurementsBytes) !== manifest.measurements.sha256) {
    failures.push("frozen measurements sha256 mismatch (edited after approve)");
  }

  let contractBytes: Buffer | null = null;
  try {
    contractBytes = await fs.readFile(path.join(dir, manifest.captureContract.file));
  } catch {
    failures.push(`frozen capture contract missing (${manifest.captureContract.file})`);
  }
  if (contractBytes && sha256(contractBytes) !== manifest.captureContract.sha256) {
    failures.push("frozen capture contract sha256 mismatch (edited after approve)");
  }

  let measurements: FeelMeasurementsFile | undefined;
  if (measurementsBytes) {
    try {
      measurements = parseMeasurements(JSON.parse(measurementsBytes.toString("utf-8")));
    } catch (error) {
      failures.push(`frozen measurements unparseable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (measurements) {
    for (const [id, entry] of Object.entries(manifest.metrics)) {
      const frozen = measurements.metrics[id];
      if (frozen === undefined) {
        failures.push(`manifest metric '${id}' has no value in the frozen measurements`);
      } else if (frozen !== entry.value) {
        failures.push(`manifest metric '${id}' (${entry.value}) != frozen measurements (${frozen})`);
      }
    }
    // AND THE REVERSE WALK, which is what makes `manifest.metrics` a DENOMINATOR rather
    // than a claim. Everything downstream counts it: `compareSnapshot` emits one row per
    // manifest metric, `summary.total` is that row count, and the unified door reads that
    // number as both `expected` and `performed`. Walking only manifest -> measurements
    // meant a metric DELETED from `manifest.metrics` had nothing left to disagree with, so
    // the shrunken number became the evidence for `anchored: true`.
    //
    // Demonstrated end to end (real approve, real `verify --snapshot`): a runSpeed drift of
    // +1.0 against a 0.14 tolerance exits 1 with `total: 3`; delete `runSpeed` from
    // `manifest.metrics` and the SAME drifted capture exits 0, `status: "clean"`,
    // `total: 2`, `anchored: true`.
    //
    // EXACT, not heuristic: `snapshot approve` freezes every measured metric, so the two
    // sets are equal at approve time by construction, and the measurements file's own
    // sha256 is checked above. A metric that was never measured (a coverage gap) is in
    // NEITHER set, so an honest partial snapshot is untouched by this.
    for (const id of Object.keys(measurements.metrics)) {
      if (!(id in manifest.metrics)) {
        failures.push(
          `frozen measurements carry '${id}' but the manifest does not declare it: the approved anchor was ` +
            "shrunk after approve, and a smaller denominator is not a smaller obligation " +
            "(re-capture and re-approve to change what is frozen)",
        );
      }
    }
    const view = rederiveView(measurements);
    for (const [metric, reason] of view.distrusted) {
      if (metric in manifest.metrics) {
        failures.push(`frozen baseline fails its own re-derivation for '${metric}': ${reason}`);
      }
    }
    for (const [id, entry] of Object.entries(manifest.metrics)) {
      if (entry.confidence === "verified" && !view.verified.has(id)) {
        failures.push(`manifest claims '${id}' is verified but the frozen samples do not re-derive it`);
      }
    }
  }

  return failures.length === 0
    ? { ok: true, failures, manifest, measurements }
    : { ok: false, failures, manifest, measurements };
}
