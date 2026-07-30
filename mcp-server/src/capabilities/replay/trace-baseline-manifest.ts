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
 *  - `driftTolerance`     OPTIONAL. The pixel allowance a human consented to for this
 *                         trace (`loombridge trace tolerance`). It lives HERE, in the
 *                         human-approved anchor, and never in a runtime flag, so a
 *                         looser comparison is always something a person stamped.
 *  - `maskRects`          OPTIONAL. The frame regions a human excluded from the pixel
 *                         comparison (`loombridge trace mask`), each with the reason it
 *                         exists. Same rule as the tolerance and for the same reason: a
 *                         mask is blindness somebody consented to, so it lives in the
 *                         anchor with a name on it, never in a flag.
 */

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { readPng } from "../verification/analyze-frames.js";
import { alignedCaptureFpsRefusal } from "./aligned-capture.js";
import {
  DEFAULT_DRIFT_FRACTION,
  MAX_DRIFT_TOLERANCE,
  maskRefusal,
  type MaskRect,
} from "./visual-diff.js";

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
  /**
   * The human-approved pixel allowance for THIS trace, as a fraction in
   * [0, {@link MAX_DRIFT_TOLERANCE}]. ABSENT means the default (0.5%), which is why
   * `schemaVersion` stays "1": every manifest written before this field existed keeps
   * grading exactly as it did, and the omission FAILS SAFE (a reader that never heard
   * of the field grades strictly, never leniently).
   *
   * Exact 0 is a valid, meaningful value: it demands pixel exactness, which is
   * STRICTER than the default, so it is never conflated with "absent".
   */
  driftTolerance?: number;
  /**
   * The pacing the approved frames were captured at (1 = the demonstration's own
   * pacing; up to {@link MAX_REPLAY_SPEED}). ABSENT means 1, so every pre-field
   * manifest keeps meaning what it meant. A replay at any other pacing REFUSES the
   * pixel comparison (harness tier): the frames would be captured at different
   * animation phases, and phase skew is indistinguishable from drift in both
   * directions.
   */
  replaySpeed?: number;
  /**
   * The CLOCK DISCIPLINE the approved frames were captured under: the fps an aligned settle
   * pinned `Time.captureDeltaTime` to. ABSENT means the legacy wall-clock settle, so every
   * manifest written before this field existed keeps meaning what it meant.
   *
   * A replay under a different discipline (aligned vs wall-clock, or a different fps)
   * REFUSES the pixel comparison, exactly as a pacing mismatch does and for the same reason:
   * the frames sit at different animation phases, and phase skew is indistinguishable from
   * drift in both directions. Absence fails safe, because it can only mean the older, less
   * deterministic discipline: it never claims an alignment nobody performed.
   */
  alignedCaptureFps?: number;
  /**
   * F6 LEDGER. How many approval events this baseline has seen, and what the previous
   * one said. A tolerance that ratchets upward one re-stamp at a time is the quiet
   * failure mode of this whole feature; the ledger is what makes that visible on disk
   * instead of only in a shell history nobody keeps.
   */
  approvalCount?: number;
  previousApprovedAt?: string;
  /**
   * WRITE-ONLY TODAY, and recorded as such (MX13). `previousMaskRects` had the same
   * problem and now has a reader (`mask --list` prints it), because "what did this anchor
   * hide before the last stamp" is the question an auditor arrives with. The tolerance's
   * previous value is deliberately left as it is for now: `mask --list` is the masks'
   * surface, `tolerance` has no `--list`, and inventing one here would be scope this fix
   * pass did not judge. It is a known gap, not an oversight.
   */
  previousDriftTolerance?: number;
  /**
   * THE MASK IS PART OF THE ANCHOR (P1). Frame rects excluded from the pixel comparison,
   * each carrying the human reason it exists. ABSENT means no masks, so every manifest
   * written before this field existed keeps grading the whole frame: the omission fails
   * safe in the same direction `driftTolerance` does, which is why `schemaVersion` stays
   * "1".
   *
   * Stamped by `loombridge trace mask`, preserved by `approve` and `tolerance`, and
   * re-validated against the frozen frames every time any of the three writes.
   */
  maskRects?: MaskRect[];
  /**
   * The frame size the masks were measured against, decoded from the approved PNGs at
   * stamp time. REQUIRED whenever `maskRects` is non-empty (Q1): without it the read side
   * has no denominator for the cap, and a mask nobody can measure is a mask nobody
   * approved. Kept in the manifest rather than re-decoded per read so the cap is checked
   * against the dimensions a human consented to, not against whatever is on disk now.
   */
  frameWidth?: number;
  frameHeight?: number;
  /** F6 LEDGER, mask half: what the mask list said before this stamp. */
  previousMaskRects?: MaskRect[];
  /**
   * APPEND-ONLY history of the masked fraction after each mask stamp. The mask twin of
   * the tolerance ratchet: 2% then 4% then 8% is three reasonable-looking stamps and one
   * blinded gate, and this array is where that becomes visible on disk.
   */
  maskedFractionHistory?: number[];
}

/**
 * EVERY manifest key, and what each WRITER does with it. Enumerated, and enforced by a
 * test that reads the interface above out of this file's source (Q6): the failure this
 * prevents is a new field that one writer preserves and another silently drops, which
 * reads on disk as "the operator un-stamped it" and is invisible until an anchor loses
 * its terms.
 *
 *  - `rewritten`: every writer re-derives it from the run it is stamping.
 *  - `carried`:   {@link carryForward} preserves it verbatim for all three writers.
 *  - `carried-rederived-by-approve`: carried by `tolerance`/`mask`, but `approve` takes
 *    it from the report it is freezing (the frames really were captured at that pacing).
 *  - `ledger`:    {@link nextApprovalLedger} owns it.
 */
export const MANIFEST_KEY_DECISIONS = {
  kind: "rewritten",
  schemaVersion: "rewritten",
  traceId: "rewritten",
  traceSha256: "rewritten",
  approvedAt: "rewritten",
  sourceReportSha256: "rewritten",
  pngs: "rewritten",
  driftTolerance: "carried",
  replaySpeed: "carried-rederived-by-approve",
  alignedCaptureFps: "carried-rederived-by-approve",
  approvalCount: "ledger",
  previousApprovedAt: "ledger",
  previousDriftTolerance: "ledger",
  maskRects: "carried",
  frameWidth: "carried",
  frameHeight: "carried",
  previousMaskRects: "ledger",
  maskedFractionHistory: "ledger",
} as const satisfies Record<string, "rewritten" | "carried" | "carried-rederived-by-approve" | "ledger">;

/** The keys {@link carryForward} must return when the previous manifest carries them. */
export const CARRIED_MANIFEST_KEYS = Object.entries(MANIFEST_KEY_DECISIONS)
  .filter(([, decision]) => decision.startsWith("carried"))
  .map(([key]) => key)
  .sort();

/**
 * The fields a re-stamp PRESERVES from the previous manifest, named one by one (Q6).
 *
 * All three writers (`approve`, `tolerance`, `mask`) build their manifest through this,
 * so "what survives a re-stamp" is one decision in one place instead of three spread
 * spreads that drift apart. The danger it removes is specific and has already happened
 * once for the tolerance: a writer that rebuilds the manifest from the run it is stamping
 * silently drops a human decision, and the next replay fails with a suggestion to make
 * that same decision again.
 *
 * `approve` OVERRIDES `replaySpeed` afterwards, because the frames it is freezing were
 * captured at the report's pacing and carrying the old one forward would mislabel them.
 */
export function carryForward(
  previous: TraceBaselineManifest | null,
): Pick<
  TraceBaselineManifest,
  "driftTolerance" | "replaySpeed" | "alignedCaptureFps" | "maskRects" | "frameWidth" | "frameHeight"
> {
  if (previous === null) return {};
  return {
    ...(previous.driftTolerance !== undefined ? { driftTolerance: previous.driftTolerance } : {}),
    ...(previous.replaySpeed !== undefined ? { replaySpeed: previous.replaySpeed } : {}),
    ...(previous.alignedCaptureFps !== undefined
      ? { alignedCaptureFps: previous.alignedCaptureFps }
      : {}),
    ...(previous.maskRects !== undefined ? { maskRects: previous.maskRects } : {}),
    ...(previous.frameWidth !== undefined ? { frameWidth: previous.frameWidth } : {}),
    ...(previous.frameHeight !== undefined ? { frameHeight: previous.frameHeight } : {}),
  };
}

/**
 * The tolerance a verified manifest grades at: the approved one, or the default when
 * the field is absent. THE ONE READER (A4): the value never gets re-derived at a call
 * site, so there is exactly one place a cap or a default could be forgotten.
 *
 * Absent resolves to the DEFAULT rather than refusing, and that is not the
 * falsy-skip anti-pattern: the default is STRICTER than anything the field could
 * legally carry, so an absent field can only make the comparison harder to pass. The
 * refusals live on the values that would LOOSEN it (over-cap, negative, non-numeric),
 * and they are enforced at read time in `loadTraceBaselineManifest`.
 */
export function resolveDriftTolerance(manifest: TraceBaselineManifest): number {
  return manifest.driftTolerance ?? DEFAULT_DRIFT_FRACTION;
}

/**
 * The next F6 ledger entry for an approval event (a `trace approve` re-freeze or a
 * `trace tolerance` re-stamp). One helper, so both verbs record history the same way.
 */
export function nextApprovalLedger(
  previous: TraceBaselineManifest | null,
  opts: {
    /**
     * The masked fraction this approval event is establishing, appended to
     * `maskedFractionHistory`.
     *
     * Present for a `trace mask` stamp (the only event that CHANGES the list) and for a
     * MASK-BEARING `approve` (MX2), which re-affirms the same rects against newly frozen
     * frames and is therefore an approval of that blindness too. `tolerance` and an
     * unmasked `approve` pass nothing and carry the history forward untouched.
     *
     * WHY approve appends an UNCHANGED number rather than staying silent: the history is
     * read as "the record of how blind this anchor has been made, one entry per event". If
     * only mask stamps wrote to it, six re-freezes between two stamps would be invisible,
     * and 4% -> 4% would read as one decision instead of the seven it took.
     */
    maskedFraction?: number;
  } = {},
): Pick<
  TraceBaselineManifest,
  | "approvalCount"
  | "previousApprovedAt"
  | "previousDriftTolerance"
  | "previousMaskRects"
  | "maskedFractionHistory"
> {
  const history = previous?.maskedFractionHistory ?? [];
  const nextHistory =
    opts.maskedFraction !== undefined ? [...history, opts.maskedFraction] : history;
  const historyField = nextHistory.length > 0 ? { maskedFractionHistory: nextHistory } : {};
  if (previous === null) return { approvalCount: 1, ...historyField };
  return {
    approvalCount: (previous.approvalCount ?? 1) + 1,
    previousApprovedAt: previous.approvedAt,
    ...(previous.driftTolerance !== undefined
      ? { previousDriftTolerance: previous.driftTolerance }
      : {}),
    ...(previous.maskRects !== undefined ? { previousMaskRects: previous.maskRects } : {}),
    ...historyField,
  };
}

/**
 * The mask rects a verified manifest grades with. THE ONE READER, for the same reason
 * `resolveDriftTolerance` is: absent resolves to "no masks", which is the strictest
 * possible value (the whole frame is graded), so an absent field can only ever make the
 * comparison harder to pass. Every refusal lives on the values that would LOOSEN it and
 * is enforced in `loadTraceBaselineManifest` through the one predicate.
 */
export function resolveMaskRects(manifest: TraceBaselineManifest): MaskRect[] {
  return manifest.maskRects ?? [];
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
  // THE CAP LIVES ON THE READ SIDE TOO (A4). `trace tolerance` refuses an out-of-range
  // value at stamp time, but the stamp is a JSON file an operator can edit, so a
  // hand-written `"driftTolerance": 0.9` would otherwise be a self-service exemption from
  // the pixel gate. Same constant, same refusal, at the only place every grader reads
  // through. A malformed value is a typed ERROR (the whole manifest is untrusted), never
  // a fall back to the default: falling back would grade the run against an anchor whose
  // stated terms nobody could read.
  for (const field of ["driftTolerance", "previousDriftTolerance"] as const) {
    const bad = toleranceRefusal(parsed[field], field);
    if (bad !== null) return { error: `${TRACE_BASELINE_MANIFEST} ${bad}` };
  }
  // Same read-side discipline for the replay speed: the baseline's captures were taken at
  // a specific pacing, and comparing them against a replay paced differently reads
  // animation phase skew as pixel drift (or hides real drift behind it). A hand-edited or
  // out-of-range speed is a typed ERROR, never a silent fall back to 1x.
  {
    const bad = replaySpeedRefusal(parsed.replaySpeed);
    if (bad !== null) return { error: `${TRACE_BASELINE_MANIFEST} ${bad}` };
  }
  // Same read-side discipline for the CLOCK the frames were captured under: a hand-edited or
  // out-of-range aligned fps is a typed ERROR, never a silent fall back to "wall-clock". The
  // stamp is a JSON file an operator can edit, and a manifest that claims an alignment nobody
  // can read is a manifest whose comparison terms nobody can read.
  {
    const bad = alignedCaptureFpsRefusal(parsed.alignedCaptureFps);
    if (bad !== null) return { error: `${TRACE_BASELINE_MANIFEST} ${bad}` };
  }
  if (parsed.approvalCount !== undefined) {
    const count = parsed.approvalCount;
    if (typeof count !== "number" || !Number.isInteger(count) || count < 1) {
      return { error: `${TRACE_BASELINE_MANIFEST} 'approvalCount' must be a positive integer` };
    }
  }
  if (parsed.previousApprovedAt !== undefined && typeof parsed.previousApprovedAt !== "string") {
    return { error: `${TRACE_BASELINE_MANIFEST} 'previousApprovedAt' must be a string` };
  }
  // THE MASK CAP LIVES ON THE READ SIDE TOO (Q1), through the SAME predicate the stamp
  // verb calls. `trace mask` refuses an over-cap or out-of-bounds rect set, but the stamp
  // is a JSON file an operator can edit, and a hand-written full-frame mask would
  // otherwise be a permanently green pixel gate that still prints "approved". Same
  // constant, same sentence, at the only place every grader reads through. Note the
  // ORDER: the frame dims are validated first, because they are the denominator the cap
  // is computed against, and a bad denominator must never be the thing that lets a mask
  // set through.
  {
    const bad = frameDimsRefusal(parsed.frameWidth, parsed.frameHeight);
    if (bad !== null) return { error: `${TRACE_BASELINE_MANIFEST} ${bad}` };
  }
  {
    const bad = maskRefusal(
      parsed.maskRects,
      parsed.frameWidth as number | undefined,
      parsed.frameHeight as number | undefined,
    );
    if (bad !== null) return { error: `${TRACE_BASELINE_MANIFEST} ${bad}` };
  }
  // The ledger halves are HISTORY, never enforcement: `previousMaskRects` records what
  // was masked before and is never read back into a comparison, so it is shape-checked
  // and not re-capped (the dims it was measured against may be long gone). The history
  // IS range-checked, because a hand-written 0.9 in it would be a fake consent record.
  if (parsed.previousMaskRects !== undefined && !Array.isArray(parsed.previousMaskRects)) {
    return { error: `${TRACE_BASELINE_MANIFEST} 'previousMaskRects' must be an array` };
  }
  // THE HISTORY IS RANGE-CHECKED AGAINST [0, 1], NOT AGAINST THE LIVE CAP (MX14). A
  // hand-written 1.5 in it would be a fake consent record, so the shape is checked; but the
  // history is HISTORY and never enforcement (nothing reads it back into a comparison), and
  // binding it to `MAX_MASKED_FRACTION` would mean that LOWERING the cap later retroactively
  // bricked every anchor whose past stamps were legal when they were made. A cap change must
  // refuse the next stamp, never un-read the record of the previous ones.
  if (parsed.maskedFractionHistory !== undefined) {
    const history = parsed.maskedFractionHistory;
    if (!Array.isArray(history)) {
      return { error: `${TRACE_BASELINE_MANIFEST} 'maskedFractionHistory' must be an array` };
    }
    for (const entry of history) {
      if (typeof entry !== "number" || !Number.isFinite(entry) || entry < 0 || entry > 1) {
        return {
          error:
            `${TRACE_BASELINE_MANIFEST} 'maskedFractionHistory' has an entry outside ` +
            `[0, 1] (${JSON.stringify(entry)})`,
        };
      }
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

/**
 * The refusal sentence for a stamped tolerance value, or null when it is acceptable.
 *
 * NON-COERCING (F9). `"0.9"`, `true` and `null` are refused as WRONG TYPES rather than
 * quietly run through `Number()`: a string that happens to parse is still a manifest
 * nobody validated, and the coercion is exactly how an out-of-range value would slip
 * past a `typeof` check somebody later "simplified". `undefined` is the only absence.
 */
/**
 * Replay pacing cap. `--speed` divides the recorded human inter-action gaps, so the
 * replay runs faster than the demonstration; 8x of a sub-second settle already lands at
 * the {@link MIN_SCALED_SETTLE_MS} floor, and anything beyond it only starves the game of
 * frames between actions. The speed is part of the ANCHOR: baselines record the pacing
 * their frames were captured at, and a replay at any other pacing refuses rather than
 * comparing phase-skewed frames.
 */
export const MAX_REPLAY_SPEED = 8;

/** The floor a scaled capture settle never goes under; the game still needs to render. */
export const MIN_SCALED_SETTLE_MS = 250;

/** Range/type refusal for a replay speed, shared by the flag parser and the manifest reader. */
export function replaySpeedRefusal(value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return `'replaySpeed' must be a finite number (got ${JSON.stringify(value) ?? typeof value})`;
  }
  if (value < 1) return `'replaySpeed' must be at least 1 (got ${value}); a replay never runs slower than the demonstration`;
  if (value > MAX_REPLAY_SPEED) {
    return `'replaySpeed' is ${value}, above the ${MAX_REPLAY_SPEED}x cap: beyond it the scaled settles all sit at the floor and the game starves for frames`;
  }
  return null;
}

/**
 * Range/type refusal for the stamped frame dimensions. They must arrive TOGETHER: one
 * without the other is half a denominator, and a mask measured against half a
 * denominator is not measured at all.
 */
export function frameDimsRefusal(width: unknown, height: unknown): string | null {
  if (width === undefined && height === undefined) return null;
  for (const [name, value] of [["frameWidth", width], ["frameHeight", height]] as const) {
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
      return `'${name}' must be a positive integer when stamped (got ${JSON.stringify(value) ?? typeof value})`;
    }
  }
  return null;
}

export function toleranceRefusal(value: unknown, field: string): string | null {
  if (value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return `'${field}' must be a finite number (got ${JSON.stringify(value) ?? typeof value})`;
  }
  if (value < 0) return `'${field}' must not be negative (got ${value})`;
  if (value > MAX_DRIFT_TOLERANCE) {
    return (
      `'${field}' is ${value}, above the ${MAX_DRIFT_TOLERANCE} cap: a tolerance above ` +
      `${MAX_DRIFT_TOLERANCE * 100}% makes the pixel comparison vacuous; use masks (\`trace mask\`) ` +
      "or investigate the drift"
    );
  }
  return null;
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
 *  - when `maskRects` are stamped, ONE declared PNG is DECODED and its real size is
 *    cross-checked against the stamped `frameWidth`/`frameHeight` (MX3). Without this the
 *    dimensions were self-asserted right up until grade time, so every PRE-RUN surface
 *    (the plan's `anchor terms:` line, `mask --list`, discovery's typed `maskedFraction`)
 *    could quote a masked fraction computed against a denominator nothing had checked:
 *    inflate the stamped dims and a 40% mask reads as 4%. It is one decode, not one per
 *    frame, because the sha check above already proves the other frames are the approved
 *    bytes and `trace mask` refuses a mixed-size baseline;
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

  // THE STAMPED DENOMINATOR IS CHECKED AGAINST A REAL FRAME (MX3). Everything downstream
  // divides by these two numbers, and until here they were the manifest's own word.
  if ((loaded.maskRects?.length ?? 0) > 0) {
    const first = loaded.pngs[0];
    if (first === undefined) {
      failures.push("masks are stamped but the manifest declares no frame to measure them against");
    } else {
      try {
        const image = await readPng(path.join(dir, `${first.captureId}.png`));
        if (image.width !== loaded.frameWidth || image.height !== loaded.frameHeight) {
          failures.push(
            `the stamped frame size ${loaded.frameWidth}x${loaded.frameHeight} is not the size of the approved ` +
              `frames (${first.captureId}.png is ${image.width}x${image.height}): every masked fraction on ` +
              "every surface was computed against a denominator that does not exist. Re-stamp with " +
              "`loombridge trace mask --set` against the real frames, or `--clear`",
          );
        }
      } catch (error) {
        failures.push(
          `masks are stamped but the approved frame '${first.captureId}.png' could not be decoded ` +
            `(${message(error)}), so the masked fraction cannot be measured`,
        );
      }
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
