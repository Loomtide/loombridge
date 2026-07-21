/**
 * `sfx-fatigue` gate (SFX dogfood backlog High #7 "Fatigue").
 *
 * Detects a no-immediate-repeat VIOLATION: the same variant played twice in a row for a
 * cue whose cue-map `variantPolicy` declares `noImmediateRepeat: true` (learning #2 —
 * frequent cues fatigue without round-robin/shuffle variants). Consumes the ordered
 * cue-fire sequence capture (`sfx-sequence.json`, `SfxSequenceCapture`), plus an
 * OPTIONAL cross-read of the sfx-runtime probe snapshot for hollow-capture detection.
 *
 * HOLLOW ≥ MISSING (review D2): a PRESENT-but-hollow capture must be AT LEAST as
 * strict as a missing one (a missing file is a blocked WARN upstream) — otherwise
 * writing `{"events":[]}` would be a cheaper laundering path than not capturing at all.
 * Concretely:
 *  - empty `events` on a present capture → WARN ("present but empty — fatigue
 *    unverified"), NEVER not_applicable;
 *  - zero fires for a declared no-repeat cue while the probe snapshot shows the cue
 *    FIRED → FAIL (the sequence capture is hollow/stale relative to the same run's
 *    own counters);
 *  - zero fires with NO probe corroboration → WARN (unverified, not silently skipped);
 *  - zero fires with the probe corroborating zero → not_applicable (genuinely not
 *    exercised, and the run's own counters agree).
 *
 * ORDER INTEGRITY (review D6): when events carry `tMs`, the sequence must be
 * time-sorted (monotonic non-decreasing) — a non-monotonic sequence is REFUSED, since
 * "immediate repeat" is only meaningful over the true play order.
 *
 * VARIANT-TAG TRUST BOUNDARY (review D6): the `variant` tag is PRODUCER-REPORTED (the
 * SfxPlayer's own selection). This gate detects policy violations in what the player
 * REPORTED playing; a player that misreports its variants is out of this gate's scope —
 * that is the C# component's provenance to establish (the probe cross-read corroborates
 * at the COUNT level only, not per-variant).
 *
 * Refuse-not-skip (CLAUDE.md): a no-repeat cue whose fires carry NO `variant` tag cannot
 * be verified — that is a FAILURE, not a silent skip (you cannot see a repeat you cannot
 * observe). When the cue map declares no no-repeat cues at all, the gate is
 * `not_applicable` (there is nothing to fatigue-check).
 *
 * "Immediate repeat" is PER CUE: it walks each cue's own ordered fire subsequence (fires
 * of other cues in between do not reset it), because round-robin/shuffle selection is
 * per cue — the same clip should not be re-selected on that cue's next play.
 *
 * Pure function — unit-testable from a synthetic sequence + cue map, no live editor.
 */

import { makeGateReport, type GateCheck, type GateReport } from "./types.js";
import { noRepeatCues, type CueMapSchema } from "../../loomtide/sfx/cue-map.js";
import type { SfxSequenceCapture, SfxSequenceEvent } from "../../loomtide/sfx/capture-shapes.js";
import { validateSfxProbeSnapshot, type SfxProbeSnapshot } from "../../loomtide/sfx/probe-contract.js";

export const GATE_NAME = "sfx-fatigue";

/** A detected immediate-repeat violation within one cue's fire subsequence. */
export interface ImmediateRepeat {
  /** The repeated variant tag. */
  variant: number | string;
  /** Index in the cue's OWN subsequence where the repeat occurred (the 2nd of the pair). */
  occurrenceIndex: number;
}

/**
 * No-immediate-repeat detection math over one cue's ordered fires.
 *
 * Returns `{ missingVariant: true }` when ANY fire of the cue lacks a `variant` tag
 * (unverifiable — the caller refuses). Otherwise returns the list of immediate repeats
 * (consecutive equal variants). An empty list means the cue never immediately repeated.
 */
export function findImmediateRepeats(
  fires: readonly SfxSequenceEvent[],
): { missingVariant: boolean; repeats: ImmediateRepeat[] } {
  const repeats: ImmediateRepeat[] = [];
  let prev: number | string | undefined;
  let missingVariant = false;
  fires.forEach((f, i) => {
    if (f.variant === undefined || f.variant === null) {
      missingVariant = true;
      prev = undefined; // an unknown variant breaks the comparison chain.
      return;
    }
    if (prev !== undefined && f.variant === prev) {
      repeats.push({ variant: f.variant, occurrenceIndex: i });
    }
    prev = f.variant;
  });
  return { missingVariant, repeats };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function evaluateSfxFatigue(
  capture: SfxSequenceCapture,
  cueMap: CueMapSchema,
  /**
   * Optional cross-read of the same run's probe snapshot (`sfx-probe.json`). Used ONLY
   * for hollow-capture detection (D2): a no-repeat cue absent from the sequence while
   * the probe counted fires for it is a FAIL. An invalid probe is ignored here (its
   * own validation failures are `sfx-runtime`'s verdict, not this gate's).
   */
  probeRaw?: unknown,
): GateReport {
  const cues = noRepeatCues(cueMap);
  if (cues.length === 0) {
    return makeGateReport(GATE_NAME, [
      {
        id: "sfx-fatigue.applicability",
        expected: "≥1 cue with variantPolicy.noImmediateRepeat",
        actual: "(none)",
        status: "not_applicable",
        detail: "No cue declares a no-immediate-repeat variant policy; nothing to fatigue-check.",
      },
    ]);
  }

  // D3 discipline: a malformed capture is a graceful FAIL, never a thrown abort.
  if (!isObject(capture) || !Array.isArray(capture.events)) {
    return makeGateReport(GATE_NAME, [
      {
        id: "sfx-fatigue.capture",
        expected: "sfx-sequence.json with an `events` array",
        actual: "(malformed)",
        status: "fail",
        detail:
          "sfx-sequence.json is present but malformed (no `events` array) — a present-but-unreadable capture is a defect, refused (never weaker than a missing one).",
      },
    ]);
  }

  // Optional probe cross-read (D2). Invalid/absent probe ⇒ no corroboration.
  let probe: SfxProbeSnapshot | undefined;
  if (probeRaw !== undefined) {
    const parsed = validateSfxProbeSnapshot(probeRaw);
    if (parsed.ok) probe = parsed.snapshot;
  }

  const events = capture.events;
  const checks: GateCheck[] = [];

  // D6 order integrity: when tMs is present it must be monotonic non-decreasing across
  // the sequence — "immediate repeat" is only meaningful over the true play order.
  let lastT: number | undefined;
  for (let i = 0; i < events.length; i += 1) {
    const t = events[i]?.tMs;
    if (typeof t === "number" && Number.isFinite(t)) {
      if (lastT !== undefined && t < lastT) {
        checks.push({
          id: "sfx-fatigue.order",
          expected: "monotonic non-decreasing tMs across the sequence",
          actual: `events[${i}].tMs ${t} < previous ${lastT}`,
          status: "fail",
          detail:
            "Sequence capture is not time-sorted — order integrity is broken, so no-immediate-repeat cannot be judged over this capture (refusing).",
        });
        return makeGateReport(GATE_NAME, checks);
      }
      lastT = t;
    }
  }

  // D2 hollow-capture rule: a present-but-EMPTY sequence is a WARN (unverified),
  // never not_applicable — plus a per-cue FAIL when the probe shows a no-repeat cue
  // actually fired (the sequence capture is hollow/stale vs the run's own counters).
  if (events.length === 0) {
    checks.push({
      id: "sfx-fatigue.sequence",
      expected: "≥1 cue fire in the sequence capture",
      actual: "(empty)",
      status: "warn",
      detail:
        "sfx-sequence.json is present but empty — fatigue unverified (a hollow capture is never weaker than a missing one).",
    });
    for (const cue of cues) {
      const probeCount = probe?.perCue[cue.id] ?? 0;
      if (probe && probeCount > 0) {
        checks.push({
          id: `sfx-fatigue.${cue.id}`,
          expected: "sequence records the fires the probe counted",
          actual: `probe perCue=${probeCount}, sequence fires=0`,
          status: "fail",
          detail: `No-repeat cue \`${cue.id}\` fired ${probeCount}× per the probe snapshot but the sequence capture recorded NO fires — a hollow/stale sequence capture (refusing).`,
        });
      }
    }
    return makeGateReport(GATE_NAME, checks);
  }

  for (const cue of cues) {
    const fires = events.filter((e) => isObject(e) && e.cueId === cue.id);
    if (fires.length === 0) {
      const probeCount = probe?.perCue[cue.id] ?? 0;
      if (probe && probeCount > 0) {
        checks.push({
          id: `sfx-fatigue.${cue.id}`,
          expected: "sequence records the fires the probe counted",
          actual: `probe perCue=${probeCount}, sequence fires=0`,
          status: "fail",
          detail: `No-repeat cue \`${cue.id}\` fired ${probeCount}× per the probe snapshot but the sequence capture recorded NO fires — a hollow/stale sequence capture (refusing).`,
        });
      } else if (probe) {
        checks.push({
          id: `sfx-fatigue.${cue.id}`,
          expected: "no consecutive same-variant plays",
          actual: "(cue not exercised — probe corroborates 0 fires)",
          status: "not_applicable",
          detail: `No-repeat cue \`${cue.id}\` did not fire in the sequence AND the probe snapshot counted 0 fires — genuinely not exercised.`,
        });
      } else {
        checks.push({
          id: `sfx-fatigue.${cue.id}`,
          expected: "no consecutive same-variant plays",
          actual: "(cue absent from sequence; no probe corroboration)",
          status: "warn",
          detail: `No-repeat cue \`${cue.id}\` has no fires in the sequence and no probe snapshot corroborates that it was truly unexercised — fatigue unverified for this cue (warn, not a silent skip).`,
        });
      }
      continue;
    }
    const { missingVariant, repeats } = findImmediateRepeats(fires);
    if (missingVariant) {
      checks.push({
        id: `sfx-fatigue.${cue.id}`,
        expected: "every fire of a no-repeat cue carries a variant tag",
        actual: "(a fire has no variant)",
        status: "fail",
        detail: `No-repeat cue \`${cue.id}\` has fires with no \`variant\` tag — cannot verify no-immediate-repeat (refusing; an unobservable repeat is not a pass).`,
      });
      continue;
    }
    if (repeats.length > 0) {
      const first = repeats[0];
      checks.push({
        id: `sfx-fatigue.${cue.id}`,
        expected: "no consecutive same-variant plays",
        actual: `${repeats.length} immediate repeat(s), e.g. variant \`${String(first.variant)}\` at play #${first.occurrenceIndex + 1}`,
        status: "fail",
        detail: `No-repeat cue \`${cue.id}\` played the same variant twice in a row (${repeats.length} violation(s)) — the no-immediate-repeat policy was not honored.`,
      });
      continue;
    }
    checks.push({
      id: `sfx-fatigue.${cue.id}`,
      expected: "no consecutive same-variant plays",
      actual: `${fires.length} plays, no immediate repeat`,
      status: "pass",
      detail: `No-repeat cue \`${cue.id}\` never played the same variant twice in a row across ${fires.length} plays.`,
    });
  }

  return makeGateReport(GATE_NAME, checks);
}
