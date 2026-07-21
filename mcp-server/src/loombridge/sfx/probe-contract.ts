/**
 * SfxPlayer probe CONTRACT (SFX dogfood backlog High #6 "Production SfxPlayer
 * contract"; `Docs/Assets/GeneratedSfxWorkflow.md` "Verification").
 *
 * This is the DOCUMENTED probe-field contract the SFX runtime + latency gates read.
 * It is NOT the MonoBehaviour — the actual `SfxPlayer` C# component (pooled sources,
 * no-repeat variants, pitch/volume jitter, per-cue voice limits, priority, mixer-group
 * routing, 2D/3D mode, graceful no-op on missing optional clips) belongs to a SKILL /
 * asset pack authored later. What lives here is the SHAPE of the runtime snapshot the
 * bridge captures from that component via the existing `runtime.probe` / `get_snapshot`
 * path, plus a refuse-shaped validator so a stale / internally-inconsistent snapshot is
 * caught before any gate reads it (harness-fault ≠ game-defect — CLAUDE.md).
 *
 * ── C# component field expectations (for the future SfxPlayer MonoBehaviour) ──
 * The bridge `runtime.probe` reads public serialized fields / properties by name.
 * The SfxPlayer MUST expose, so this snapshot can be assembled:
 *   - `PlayCount`      (int)                — total cues played this session.
 *   - `PerCueCounts`   (per-cue int map)    — count keyed by cue id. The probe path
 *                                             flattens a dictionary/serialized pair
 *                                             list into `perCue` here.
 *   - `LastCueId`      (string)             — id of the most recent cue ("" when none).
 *   - `LastCueTimeMs`  (double/float, ms)   — engine time of the most recent cue.
 *   - `LastPayloadJson`(string, optional)   — JSON of the most recent event payload.
 * The template + wiring guidance is deferred to the SfxPlayer skill; this module only
 * defines the read contract so the deterministic gates can be built + tested now.
 *
 * Pure TS, engine-agnostic. Mirrors the telemetry validators' refuse-not-skip style.
 */

/** The runtime SFX snapshot captured from an `SfxPlayer` via `runtime.probe`. */
export interface SfxProbeSnapshot {
  /** Total cues played this session (== sum of `perCue` values). */
  playCount: number;
  /** Per-cue play counts keyed by cue id. */
  perCue: Record<string, number>;
  /** Id of the most recent cue; `null` when nothing has played. */
  lastCueId: string | null;
  /** Engine time (ms) of the most recent cue; `null` when nothing has played. */
  lastCueTimeMs: number | null;
  /** Optional most-recent event payload (for payload-mapping spot-checks). */
  lastPayload?: Record<string, unknown>;
}

export interface SfxProbeValidationResult {
  ok: boolean;
  refusals: string[];
  snapshot?: SfxProbeSnapshot;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isNonNegInt(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && Number.isInteger(v) && v >= 0;
}

/**
 * Validate a raw probe snapshot. Refuse-shaped: every internal-consistency problem is
 * a REFUSAL, never a silently-tolerated read — a stale or partial runtime capture must
 * not be treated as trustworthy evidence (CLAUDE.md harness-fault tier). Checks:
 *  - `playCount` is a non-negative integer.
 *  - `perCue` is a map of non-negative integer counts.
 *  - SUM(perCue) === playCount — a total that disagrees with the per-cue breakdown is
 *    an inconsistent/partial read (refused; you cannot tell which number is stale).
 *  - `lastCueId`/`lastCueTimeMs` agree with `playCount`: nothing played ⇒ both null;
 *    something played ⇒ a non-empty last cue id that appears in `perCue` with count>0,
 *    plus a finite non-negative last time. A snapshot claiming plays with no last cue
 *    (or a last cue absent from `perCue`) is inconsistent → refused.
 */
export function validateSfxProbeSnapshot(raw: unknown): SfxProbeValidationResult {
  const refusals: string[] = [];
  if (!isObject(raw)) {
    return { ok: false, refusals: ["probe: snapshot is not an object"] };
  }

  if (!isNonNegInt(raw.playCount)) {
    refusals.push("probe: `playCount` must be a non-negative integer");
  }

  const perCue: Record<string, number> = {};
  let perCueSum = 0;
  if (!isObject(raw.perCue)) {
    refusals.push("probe: `perCue` must be an object of cueId -> count");
  } else {
    for (const [cueId, count] of Object.entries(raw.perCue)) {
      if (!isNonNegInt(count)) {
        refusals.push(`probe: perCue[\`${cueId}\`] must be a non-negative integer`);
        continue;
      }
      perCue[cueId] = count;
      perCueSum += count;
    }
  }

  // Consistency: total must equal the per-cue breakdown (a mismatch = partial/stale read).
  if (isNonNegInt(raw.playCount) && Object.keys(perCue).length === Object.keys((raw.perCue as object) ?? {}).length) {
    if (raw.playCount !== perCueSum) {
      refusals.push(
        `probe: playCount ${raw.playCount} != sum(perCue) ${perCueSum} — the snapshot is internally inconsistent (partial/stale read; refusing)`,
      );
    }
  }

  const lastCueId = raw.lastCueId;
  const lastCueTimeMs = raw.lastCueTimeMs;
  const played = isNonNegInt(raw.playCount) && (raw.playCount as number) > 0;
  if (played) {
    if (typeof lastCueId !== "string" || lastCueId.length === 0) {
      refusals.push(
        "probe: playCount > 0 but `lastCueId` is absent/empty — a snapshot that recorded plays must name the last cue (refusing)",
      );
    } else if (!(lastCueId in perCue) || perCue[lastCueId] <= 0) {
      refusals.push(
        `probe: \`lastCueId\` \`${lastCueId}\` is not present in perCue with count>0 — inconsistent snapshot (refusing)`,
      );
    }
    if (typeof lastCueTimeMs !== "number" || !Number.isFinite(lastCueTimeMs) || lastCueTimeMs < 0) {
      refusals.push("probe: playCount > 0 but `lastCueTimeMs` is not a finite ms >= 0 (refusing)");
    }
  } else if (isNonNegInt(raw.playCount)) {
    // playCount === 0: last-cue fields must be null/absent (nothing has played).
    if (lastCueId !== null && lastCueId !== undefined && lastCueId !== "") {
      refusals.push("probe: playCount === 0 but `lastCueId` is set — inconsistent (refusing)");
    }
    if (lastCueTimeMs !== null && lastCueTimeMs !== undefined) {
      refusals.push("probe: playCount === 0 but `lastCueTimeMs` is set — inconsistent (refusing)");
    }
  }

  if (raw.lastPayload !== undefined && !isObject(raw.lastPayload)) {
    refusals.push("probe: `lastPayload` must be an object when present");
  }

  if (refusals.length > 0) {
    return { ok: false, refusals: [...refusals].sort() };
  }
  const snapshot: SfxProbeSnapshot = {
    playCount: raw.playCount as number,
    perCue,
    lastCueId: played ? (lastCueId as string) : null,
    lastCueTimeMs: played ? (lastCueTimeMs as number) : null,
    lastPayload: isObject(raw.lastPayload) ? (raw.lastPayload as Record<string, unknown>) : undefined,
  };
  return { ok: true, refusals: [], snapshot };
}
