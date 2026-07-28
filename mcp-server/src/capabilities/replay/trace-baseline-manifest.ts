/**
 * The trace baseline manifest: provenance for an approved pixel baseline.
 *
 * `trace approve` copies a run's captures into `<replayBaselines>/<id>/` and, from
 * this module, stamps a manifest beside them. Without it a baseline dir is a bag of
 * PNGs that answers neither of the two questions a verdict has to answer about its
 * anchor: WHEN was this approved, and FROM WHAT. Unified `verify` discovery reads
 * the manifest to classify the trace asset, and an unstamped (legacy) baseline is
 * NOT an anchor: it is a row that never executes and can never contribute a pass.
 *
 * Same approve-once / freeze / refuse-drift grammar as the feel snapshot
 * (`feel/snapshot-manifest.ts`) and the screen-contract baseline
 * (`minigame/minigame-baseline.ts`): the integrity shas are recorded at freeze and
 * RECOMPUTED at read, so nothing in the manifest is trusted on its own word.
 *
 * The bindings, and why each one is here:
 *  - `traceSha256`        the demonstration the baseline was approved for. Edit the
 *                         trace and the frames no longer belong to it.
 *  - `sourceReportSha256` the replay report the frames were promoted from.
 *  - `pngs[]`             per-capture sha, so a hand-swapped baseline frame is a
 *                         refusal rather than a silently re-anchored comparison.
 */

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * The manifest filename inside a trace baseline dir. The ONE constant the writer
 * (`trace approve`) and every reader resolve the name from. A declared path that
 * two modules spell independently is a path nothing walks (CLAUDE.md).
 */
export const TRACE_BASELINE_MANIFEST = "baseline-manifest.json";

/** One approved baseline frame and the bytes it was approved as. */
export interface TraceBaselinePng {
  captureId: string;
  sha256: string;
}

export interface TraceBaselineManifest {
  kind: "trace-baseline";
  schemaVersion: "1";
  /** The trace this baseline anchors. */
  traceId: string;
  /** sha256 of the `<id>.trace.json` bytes at approve time. */
  traceSha256: string;
  approvedAt: string;
  /** sha256 of the `<id>.report.json` bytes the frames were promoted from. */
  sourceReportSha256: string;
  pngs: TraceBaselinePng[];
}

/**
 * A manifest that exists but cannot be trusted. Returned (never thrown) so a
 * caller enumerating assets can mark ONE row broken and carry on: discovery must
 * not abort the whole plan because one asset on disk is malformed.
 */
export interface TraceBaselineManifestError {
  error: string;
}

export function isTraceBaselineManifestError(
  value: TraceBaselineManifest | TraceBaselineManifestError | null,
): value is TraceBaselineManifestError {
  return value !== null && "error" in value;
}

export function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The manifest path inside a baseline dir (writer and reader both call this). */
export function traceBaselineManifestPath(dir: string): string {
  return path.join(dir, TRACE_BASELINE_MANIFEST);
}

/** Write (or overwrite, since approve is idempotent) the manifest for a baseline dir. */
export async function writeTraceBaselineManifest(
  dir: string,
  manifest: TraceBaselineManifest,
): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(traceBaselineManifestPath(dir), `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
}

/**
 * Read + shape-check the manifest in `dir`.
 *
 * Three outcomes, deliberately distinct: `null` when there is no manifest at all
 * (a LEGACY baseline: unstamped, not broken), a typed error marker when one is
 * present but unreadable/malformed (BROKEN: an anchor that cannot be read is a
 * refusal, never a skip), and the manifest itself when it is well-shaped. Never
 * throws.
 */
export async function loadTraceBaselineManifest(
  dir: string,
): Promise<TraceBaselineManifest | TraceBaselineManifestError | null> {
  let raw: string;
  try {
    raw = await fs.readFile(traceBaselineManifestPath(dir), "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return { error: `unreadable ${TRACE_BASELINE_MANIFEST}: ${message(error)}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { error: `${TRACE_BASELINE_MANIFEST} is not valid JSON: ${message(error)}` };
  }
  if (!isRecord(parsed)) return { error: `${TRACE_BASELINE_MANIFEST} is not a JSON object` };
  if (parsed.kind !== "trace-baseline") {
    return { error: `${TRACE_BASELINE_MANIFEST} kind is '${String(parsed.kind)}', expected 'trace-baseline'` };
  }
  if (parsed.schemaVersion !== "1") {
    return { error: `${TRACE_BASELINE_MANIFEST} schemaVersion is '${String(parsed.schemaVersion)}', expected '1'` };
  }
  for (const field of ["traceId", "traceSha256", "approvedAt", "sourceReportSha256"] as const) {
    if (typeof parsed[field] !== "string" || (parsed[field] as string).length === 0) {
      return { error: `${TRACE_BASELINE_MANIFEST} is missing a usable '${field}'` };
    }
  }
  if (!Array.isArray(parsed.pngs)) return { error: `${TRACE_BASELINE_MANIFEST} 'pngs' is not an array` };
  const pngs: TraceBaselinePng[] = [];
  for (const entry of parsed.pngs) {
    if (!isRecord(entry) || typeof entry.captureId !== "string" || typeof entry.sha256 !== "string") {
      return { error: `${TRACE_BASELINE_MANIFEST} 'pngs' has an entry without { captureId, sha256 }` };
    }
    pngs.push({ captureId: entry.captureId, sha256: entry.sha256 });
  }
  return { ...(parsed as unknown as TraceBaselineManifest), pngs };
}

export interface TraceBaselineIntegrityResult {
  ok: boolean;
  /** Named refusals; empty iff ok. */
  failures: string[];
  manifest?: TraceBaselineManifest;
  /** True when there is no manifest at all: LEGACY, not broken. */
  unstamped: boolean;
}

/**
 * Verify an approved trace baseline end to end, recomputing every sha from disk.
 * Modeled on `verifySnapshotIntegrity`: each check is a NAMED refusal so a caller
 * can print why, and nothing recorded in the manifest is taken on trust.
 *
 *  - every declared PNG exists and its bytes still hash to the recorded sha;
 *  - no baseline PNG in the dir is UNDECLARED (an out-of-band frame would
 *    otherwise become the comparison anchor for a capture id the manifest never
 *    approved);
 *  - with `tracePath`, the trace file still hashes to `traceSha256` (the baseline
 *    belongs to the demonstration it was approved for).
 *
 * An absent manifest is reported as `unstamped`, NOT as a failure: legacy baselines
 * predate the manifest and are handled by the caller as non-anchors (never executed,
 * never a pass), not as tampering.
 */
export async function verifyTraceBaseline(
  dir: string,
  opts: { tracePath?: string } = {},
): Promise<TraceBaselineIntegrityResult> {
  const loaded = await loadTraceBaselineManifest(dir);
  if (loaded === null) {
    return { ok: false, failures: [], unstamped: true };
  }
  if (isTraceBaselineManifestError(loaded)) {
    return { ok: false, failures: [loaded.error], unstamped: false };
  }

  const failures: string[] = [];
  const declared = new Set<string>();
  for (const png of loaded.pngs) {
    declared.add(`${png.captureId}.png`);
    let bytes: Buffer;
    try {
      bytes = await fs.readFile(path.join(dir, `${png.captureId}.png`));
    } catch {
      failures.push(`approved baseline '${png.captureId}.png' is missing from ${dir}`);
      continue;
    }
    if (sha256(bytes) !== png.sha256) {
      failures.push(`approved baseline '${png.captureId}.png' sha256 mismatch (edited after approve)`);
    }
  }

  let entries: string[] = [];
  try {
    entries = await fs.readdir(dir);
  } catch (error) {
    failures.push(`baseline dir ${dir} is unreadable: ${message(error)}`);
  }
  for (const entry of entries.filter((e) => e.endsWith(".png")).sort()) {
    if (!declared.has(entry)) {
      failures.push(`baseline PNG '${entry}' is not declared in ${TRACE_BASELINE_MANIFEST} (re-approve to stamp it)`);
    }
  }

  if (opts.tracePath !== undefined) {
    try {
      const traceBytes = await fs.readFile(opts.tracePath);
      if (sha256(traceBytes) !== loaded.traceSha256) {
        failures.push("trace file sha256 mismatch: the baseline was approved for a different demonstration");
      }
    } catch {
      failures.push(`trace file missing at ${opts.tracePath}; the baseline is not bound to a demonstration`);
    }
  }

  return { ok: failures.length === 0, failures, manifest: loaded, unstamped: false };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
