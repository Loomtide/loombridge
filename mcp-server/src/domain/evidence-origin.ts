/**
 * EVIDENCE ORIGIN: who wrote an evidence file, re-derived from the file itself.
 *
 * A NEW AXIS, deliberately not the evidence CLASS axis (`gates/evidence-classes.ts`).
 * A class answers "was this signal gathered at all?"; an ORIGIN answers "did the CLI
 * produce this, did the CLI observe it while an agent drove, or did an agent hand it
 * to us?". Folding the second question into the first would put a provenance answer
 * behind a coverage word, and `requiredEvidenceClasses` would start meaning two things
 * at once. This module therefore names nothing `class`, and the roll-up never wires
 * origin into `requiredEvidenceClasses`.
 *
 * THE DISCIPLINE IS `deriveEvidenceClassesFromUntrusted`'s: RE-DERIVE FROM THE DATA,
 * never trust a typed block. There is no `origin` field an author can write; the
 * origin comes from the markers the writer left (`_provenance.writer`, and the
 * observer's own `_provenance.observation` recording). An ABSENT marker is
 * `agent-assembled`, STATED in the note rather than omitted, because "we could not
 * tell" and "an agent wrote it" have the same standing here: neither is CLI-produced.
 *
 * The writer string is a REPORT LABEL, never the control (H11). Nothing gates on it:
 * the gates' own derivability checks (feel-rederive, the playability observation
 * re-derivation) are what refuse a laundered headline. This axis exists so a reader
 * of a verdict can see, per file, what kind of thing they are reading.
 */

/**
 * - `produced`        a CLI capture recipe drove the ops and wrote the file.
 * - `observed`        the CLI watched (and recorded) while an agent drove, and derived
 *                     the file from its own recording (the playability observer).
 * - `agent-assembled` no CLI producer marker: an agent (or a human) wrote this file.
 */
export type EvidenceOrigin = "produced" | "observed" | "agent-assembled";

/** The ordered vocabulary, so a summary always prints the same three buckets. */
export const EVIDENCE_ORIGINS = ["produced", "observed", "agent-assembled"] as const;

/**
 * The writer labels the shipped CLI producers stamp. They are NOT one string: the feel
 * and playability producers write `loombridge-capture`, while the framing/console/tiles
 * producers write `loombridge capture (framing)` and friends. Matching the family with
 * one anchored pattern is what keeps this derivation from silently missing three of the
 * five producers the moment someone reads only `FEEL_PRODUCER`.
 */
export const PRODUCER_WRITER_PATTERN = /^loombridge[-\s]capture\b/i;

export interface EvidenceProvenanceFacts {
  origin: EvidenceOrigin;
  /** The writer label AS RECORDED, or null. A label, never the control. */
  writer: string | null;
  /** `_provenance.runId`, or null when the file carries none. */
  runId: string | null;
  /** `_provenance.editorSessionId`, else `_provenance.unityRouting.editorSessionId`, else null. */
  editorSessionId: string | null;
  /**
   * `_provenance.observation.recorderEditorSessionId`, or null.
   *
   * THE STRONG BINDER (E15). `editorSessionId` is a bridge SERVER-GENERATION id, minted
   * when the bridge server starts and re-minted by every domain reload (which entering
   * play mode causes), and read by each connection from its own handshake or its cached
   * discovery record. Two files from ONE editor sitting therefore legitimately carry two
   * ids. This field is different in kind: the recorder reports it from INSIDE the running
   * editor at the moment it opened the observation window, so two files that disagree on
   * it were recorded by two genuinely different bridge sittings.
   */
  recorderEditorSessionId: string | null;
  /** One sentence saying WHY this origin was derived. Always set (absent is stated). */
  note: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Derive one evidence file's origin from its OWN markers. Pure; never throws; never
 * reads a self-declared `origin`/`evidenceOrigin` field (there is none to read).
 */
export function deriveEvidenceOrigin(parsed: unknown): EvidenceProvenanceFacts {
  const absent = (note: string): EvidenceProvenanceFacts => ({
    origin: "agent-assembled",
    writer: null,
    runId: null,
    editorSessionId: null,
    recorderEditorSessionId: null,
    note,
  });

  const file = asRecord(parsed);
  if (!file) return absent("the file is not a JSON object, so it carries no producer marker");
  const provenance = asRecord(file._provenance);
  if (!provenance) return absent("no `_provenance` block: nothing records a CLI producer");

  const writer = asString(provenance.writer);
  const runId = asString(provenance.runId);
  const routing = asRecord(provenance.unityRouting);
  const editorSessionId =
    asString(provenance.editorSessionId) ?? (routing ? asString(routing.editorSessionId) : null);
  const observationBlock = asRecord(provenance.observation);
  const recorderEditorSessionId = observationBlock
    ? asString(observationBlock.recorderEditorSessionId)
    : null;

  if (!writer) {
    return {
      origin: "agent-assembled",
      writer: null,
      runId,
      editorSessionId,
      recorderEditorSessionId,
      note: "`_provenance` carries no `writer`, so no CLI producer claims this file",
    };
  }
  if (!PRODUCER_WRITER_PATTERN.test(writer)) {
    return {
      origin: "agent-assembled",
      writer,
      runId,
      editorSessionId,
      recorderEditorSessionId,
      note: `\`_provenance.writer\` is "${writer}", which is not a Loombridge capture producer`,
    };
  }
  // The observer's tell is its own RECORDING, not its name: `capture --slice` writes the
  // playability file from `_provenance.observation`, and the gate re-derives the headline
  // from exactly that block. Keying on the recording rather than on the recipe string means
  // a renamed recipe cannot quietly demote an observed file to a produced one.
  if (observationBlock) {
    return {
      origin: "observed",
      writer,
      runId,
      editorSessionId,
      recorderEditorSessionId,
      note: "written by the CLI observer from its own `_provenance.observation` recording",
    };
  }
  return {
    origin: "produced",
    writer,
    runId,
    editorSessionId,
    recorderEditorSessionId,
    note: `written by the CLI capture producer "${writer}"`,
  };
}

/** True for the two origins whose file the CLI itself wrote (produced OR observed). */
export function isCliWritten(origin: EvidenceOrigin): boolean {
  return origin === "produced" || origin === "observed";
}

/** `produced 2, observed 1, agent-assembled 3` — the one spelling of the summary. */
export function renderOriginCounts(origins: readonly EvidenceOrigin[]): string {
  return EVIDENCE_ORIGINS.map(
    (origin) => `${origin} ${origins.filter((o) => o === origin).length}`,
  ).join(", ");
}
