/**
 * Evidence-class verification reporting (dogfood learnings §6 / backlog High #7).
 *
 * The incident: "all green" was too broad. A clean Unity console did NOT mean the
 * playtest harness succeeded — some traces timed out, some cover/touch claims had
 * only partial evidence, and the agent compressed everything into one success
 * claim (which later curdled into an RCL-P04-shaped false-green). The fix is to
 * SEPARATE the distinct evidence signals a Tier-1 verdict actually establishes,
 * so a report can never let "console clean" imply "playtest verified."
 *
 * This module is PURE (no I/O): it derives a fixed-enum `evidenceClasses` block
 * from an already-assembled Tier-1 verdict's gate statuses + checks. The block is
 * ALWAYS emitted — a class with no producing gate wired today is reported
 * `"absent"` with source `"no-producer"`, NEVER omitted (refuse-not-skip: an
 * absent signal must be VISIBLE, not missing). `loombridge doneness` can then refuse
 * a build whose contract declares `requiredEvidenceClasses` that are not all
 * `"present"` (see `doneness.ts`).
 *
 * TRUST BOUNDARY — what `present` means: "a non-degenerate capture was COLLECTED
 * and its gate EVALUATED it". It inherits the verifier's existing trust in
 * capture files — a hollow-but-parseable capture is the producing gate's own
 * evaluator's job to catch (that gate fails/warns the Tier-1 `status`), not the
 * evidence class's. The class answers "was this signal gathered at all?", never
 * "was the gathered signal good?".
 *
 * Because the stored block travels inside the verdict file, doneness must not
 * trust it in isolation: `deriveEvidenceClassesFromUntrusted` re-derives the
 * block from the SAME verdict's own `gates`+`checks` so a single hand-edited
 * `evidenceClasses` field cannot claim `present` for a signal the verdict's own
 * gate data does not show (see `evidenceClassRefusals` in `doneness.ts`).
 */

import type { CheckStatus, GateCheck } from "./types.js";

/**
 * The fixed set of evidence classes (dogfood learnings §6). Order is stable — the
 * emitted block iterates this list, so a class is never silently dropped.
 *
 * - `compile_import`   — the project compiled + imported clean.
 * - `console_clean`    — the Unity console had no errors/exceptions.
 * - `scene_validation` — required scene objects exist + validate.
 * - `frame_evidence`   — a screenshot / render frame was captured.
 * - `input_exercised`  — an input path was actually driven (input → motion).
 * - `play_trace`       — a play trace ran to a playable outcome.
 * - `telemetry`        — a telemetry file was produced AND parsed.
 * - `human_notes`      — human playtest notes were captured.
 */
export const EVIDENCE_CLASSES = [
  "compile_import",
  "console_clean",
  "scene_validation",
  "frame_evidence",
  "input_exercised",
  "play_trace",
  "telemetry",
  "human_notes",
] as const;

export type EvidenceClassName = (typeof EVIDENCE_CLASSES)[number];

/** Fast membership check for validators / disk-truth reads. */
export const EVIDENCE_CLASS_SET: ReadonlySet<string> = new Set(EVIDENCE_CLASSES);

/** Whether a signal is established, missing, or only partially gathered. */
export type EvidenceClassStatus = "present" | "absent" | "partial";

/** One class's outcome + a citation of the gate/signal that established it. */
export interface EvidenceClassEntry {
  status: EvidenceClassStatus;
  /**
   * Where the status came from: `"no-producer"` for an unwired class, otherwise a
   * `;`-joined list of the producing gate(s) with their state annotation, e.g.
   * `"gate:console-clean"` or `"gate:render-frame; gate:frame-integrity (not run)"`.
   */
  source: string;
}

/** The `evidenceClasses` block emitted into the verdict (one entry per class). */
export type EvidenceClassBlock = Record<EvidenceClassName, EvidenceClassEntry>;

/**
 * Which Tier-1 gate(s) PRODUCE each evidence class. A class mapped to `[]` has NO
 * producer in the current pipeline — it is reported `absent` / `no-producer`
 * (honestly visible, never omitted), so a future producer only has to fill in
 * this table.
 *
 * Mapping rationale (kept deliberately non-conflating — each class cites the ONE
 * signal that honestly establishes it, so "console clean" can never stand in for
 * "playtest verified"):
 *  - `compile_import`   — NO producer: Tier-1 verify never independently checks
 *                         the editor's compile/import state (it is assumed because
 *                         ops ran). Distinct from `console_clean`.
 *  - `console_clean`    — the `console-clean` gate (console.json).
 *  - `scene_validation` — the `manifest` gate (unity_scene_verify_manifest).
 *  - `frame_evidence`   — the `render-frame` gate (a captured frame) and, when a
 *                         VLM ran, the derived `frame-integrity` gate.
 *  - `input_exercised`  — the `feel` gate (input injection → captured motion).
 *  - `play_trace`       — the `playability` gate (input drives a playable outcome).
 *  - `telemetry`        — NO producer: Tier-1 verify parses no telemetry file yet.
 *  - `human_notes`      — NO producer: human playtest notes are not captured yet.
 *
 * SFX GATES (SFX-dogfood backlog High #7) are DELIBERATELY NOT wired here. They were
 * evaluated against this table and no existing class maps CLEANLY without the exact
 * conflation this module exists to prevent: `sfx-runtime` ("a cue fired") is NOT
 * `play_trace` ("a play trace reached a playable outcome"), and `inputToSfxLatency`
 * ("an input produced an audible edge") is NOT `input_exercised` ("input → MOTION",
 * produced by `feel`) — folding audio evidence into either would let "a sound played"
 * stand in for "the game was played", the RCL-P04 false-green shape. The honest home
 * is a dedicated `sfx_runtime` evidence class; adding one is out of scope here ("do
 * NOT invent new classes"), so the SFX gates simply carry no evidence class today.
 * This keeps every existing verdict's block byte-identical (zero behavior change).
 */
export const EVIDENCE_CLASS_PRODUCERS: Record<EvidenceClassName, readonly string[]> = {
  compile_import: [],
  console_clean: ["console-clean"],
  scene_validation: ["manifest"],
  frame_evidence: ["render-frame", "frame-integrity"],
  input_exercised: ["feel"],
  play_trace: ["playability"],
  telemetry: [],
  human_notes: [],
};

/** The minimal verdict view `deriveEvidenceClasses` reads (gate statuses + checks). */
export interface EvidenceVerdictView {
  gates: Record<string, CheckStatus>;
  checks: GateCheck[];
}

/**
 * Per-producer evidence state:
 * - `gathered`   — the gate ran on real captured data (pass / warn / fail — the
 *                  SIGNAL was collected regardless of the verdict).
 * - `missing`    — the gate was in scope but its capture was ABSENT (the degraded
 *                  input marker: a `<gate>.input` check with actual `(missing)`).
 *                  This is the "trace timed out / capture never produced" case.
 * - `not_applicable` — the gate was deliberately marked not_applicable / out of
 *                  scope for this run (NOT counted against the class).
 * - `not_run`    — the gate is not present in this run's report at all (e.g.
 *                  `frame-integrity` without `--vlm`).
 */
type ProducerState = "gathered" | "missing" | "not_applicable" | "not_run";

function producerState(gate: string, view: EvidenceVerdictView): ProducerState {
  const status = view.gates[gate];
  if (status === undefined) return "not_run";
  if (status === "not_applicable") return "not_applicable";
  // A degraded gate reports its capture as missing via a `<gate>.input` check
  // whose actual is `(missing)` — that is an EXPECTED-but-absent signal, not real
  // evidence, even though the gate's own status is a WARN.
  const degraded = view.checks.some(
    (c) => c.id === `${gate}.input` && c.actual === "(missing)",
  );
  if (degraded) return "missing";
  return "gathered";
}

function renderProducer(gate: string, state: ProducerState): string {
  switch (state) {
    case "gathered":
      return `gate:${gate}`;
    case "missing":
      return `gate:${gate} (capture missing)`;
    case "not_applicable":
      return `gate:${gate} (not_applicable)`;
    case "not_run":
      return `gate:${gate} (not run)`;
  }
}

/**
 * Derive the `evidenceClasses` block from an assembled Tier-1 verdict.
 *
 * Status rules per class (over its PRODUCER gates):
 *  - no producers wired            → `absent`, source `no-producer`.
 *  - producers all not_applicable/
 *    not_run (none in scope)       → `absent` (nothing was expected to gather).
 *  - every in-scope producer
 *    gathered real evidence        → `present`.
 *  - every in-scope producer was
 *    capture-missing               → `absent`.
 *  - a MIX (some gathered, some
 *    capture-missing)              → `partial`.
 *
 * A `not_applicable` producer is EXCLUDED from the calculation (a game that
 * deliberately marks a gate N/A must not read `partial`); only a capture-`missing`
 * producer counts as expected-but-absent.
 */
export function deriveEvidenceClasses(view: EvidenceVerdictView): EvidenceClassBlock {
  const block = {} as EvidenceClassBlock;
  for (const cls of EVIDENCE_CLASSES) {
    const producers = EVIDENCE_CLASS_PRODUCERS[cls];
    if (producers.length === 0) {
      block[cls] = { status: "absent", source: "no-producer" };
      continue;
    }
    const states = producers.map((gate) => ({ gate, state: producerState(gate, view) }));
    const source = states.map((s) => renderProducer(s.gate, s.state)).join("; ");
    const inScope = states.filter(
      (s) => s.state === "gathered" || s.state === "missing",
    );
    if (inScope.length === 0) {
      block[cls] = { status: "absent", source };
      continue;
    }
    const gathered = inScope.filter((s) => s.state === "gathered").length;
    let status: EvidenceClassStatus;
    if (gathered === inScope.length) status = "present";
    else if (gathered === 0) status = "absent";
    else status = "partial";
    block[cls] = { status, source };
  }
  return block;
}

/**
 * Re-derive the evidence-class block from an UNTRUSTED (disk-read) verdict's own
 * `gates` + `checks` fields — the anti-self-attestation check for doneness: a
 * stored `evidenceClasses` entry must AGREE with what re-derivation over the same
 * verdict's gate data yields, so one hand-edited block field cannot claim
 * `present` for a signal the verdict's own gates never gathered.
 *
 * Returns `null` when the verdict carries no usable `gates` object — the caller
 * treats that as "cannot re-derive", which is a REFUSAL for a required class, not
 * a skip. Loose-shape tolerant: non-string gate statuses are dropped (an
 * undefined gate reads `not run`), and only each check's `id` + `actual` are read
 * (the degraded `<gate>.input` / `(missing)` marker) — the same fields
 * `deriveEvidenceClasses` uses on the trusted path.
 */
export function deriveEvidenceClassesFromUntrusted(
  gates: unknown,
  checks: unknown,
): EvidenceClassBlock | null {
  if (typeof gates !== "object" || gates === null || Array.isArray(gates)) return null;
  const gateMap: Record<string, CheckStatus> = {};
  for (const [gate, status] of Object.entries(gates as Record<string, unknown>)) {
    if (typeof status === "string") gateMap[gate] = status as CheckStatus;
  }
  const checkList: GateCheck[] = Array.isArray(checks)
    ? checks
        .filter((c): c is Record<string, unknown> => typeof c === "object" && c !== null)
        .map((c) => ({
          id: typeof c.id === "string" ? c.id : "",
          expected: "",
          actual: typeof c.actual === "string" ? c.actual : "",
          status: (typeof c.status === "string" ? c.status : "warn") as CheckStatus,
          detail: "",
        }))
    : [];
  return deriveEvidenceClasses({ gates: gateMap, checks: checkList });
}
