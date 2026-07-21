/**
 * Input-response gate (S6 slice 3) — read-only LIVENESS for a non-deterministic game.
 *
 * Proves the gameplay RESPONDS to input WITHOUT needing to win: when you tap the declared
 * `state.inputResponse.tap` control, at least one `observe` object must observably CHANGE
 * (its text differs, or its visibility/active flips, or it appears/disappears). The change
 * is the metamorphic, RNG-invariant signal — true for a right OR wrong answer (a feedback
 * indicator shows, the question changes) — so the check holds on a re-randomizing game.
 *
 * The before→after evidence (`<state>.response.json`) is produced by `minigame capture`
 * (it drives the one declared tap and snapshots around it). This module is PURE: a loader
 * for the evidence + an evaluator that grades it. Like the interaction-flow gate it
 * separates game-vs-harness:
 *   - `pass`             evidence present; ≥1 observed object changed (the game responded)
 *   - `game_fail`        evidence present; NO observed object changed (a dead/inert control)
 *   - `missing_evidence` declared but `<state>.response.json` is absent/unobservable (capture
 *                        gap → incomplete, never a game defect)
 *   - `not_applicable`   no state declares `inputResponse`
 *
 * Refuse-on-absent (CLAUDE.md verification invariants): a declared liveness with no evidence
 * is INCOMPLETE, never a silent pass.
 */

import fs from "node:fs/promises";
import path from "node:path";

import type { MinigameContract } from "../minigame-profiles/types.js";
import type { MinigameCaptureObject } from "./types.js";

/** The deterministic check name this gate implements. */
export const INPUT_RESPONSE_CHECK = "input-response";

export type InputResponseOutcome = "pass" | "game_fail" | "missing_evidence" | "not_applicable";

export interface InputResponseStateReport {
  state: string;
  status: InputResponseOutcome;
  /** The tapped control + observed ids, for the report. */
  tap: string;
  observe: string[];
  /** Object ids that observably changed (the evidence behind a pass). */
  changed: string[];
  detail: string;
  /** Class-specific remedy that never blames the wrong layer. */
  nextAction: string;
}

export interface InputResponseReport {
  outcome: InputResponseOutcome;
  states: InputResponseStateReport[];
}

/** Before/after snapshots captured around the declared response tap. */
export interface InputResponseEvidence {
  /** The control actually tapped (echoed from the contract; informational). */
  tap?: string;
  before: { objects: MinigameCaptureObject[] };
  after: { objects: MinigameCaptureObject[] };
}

/** `<state>.response.json` — written by `minigame capture` when the state declares inputResponse. */
export const responseEvidenceFile = (stateId: string): string => `${stateId}.response.json`;

/**
 * Load `<captureDir>/<state>.response.json`. Returns null when absent/unparseable or when it
 * lacks the `before`/`after` object arrays (refuse-on-absent → missing_evidence). Never throws.
 */
export async function loadInputResponseEvidence(
  captureDir: string,
  stateId: string,
): Promise<InputResponseEvidence | null> {
  let parsed: { tap?: unknown; before?: { objects?: unknown }; after?: { objects?: unknown } };
  try {
    parsed = JSON.parse(await fs.readFile(path.join(captureDir, responseEvidenceFile(stateId)), "utf-8"));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed.before?.objects) || !Array.isArray(parsed.after?.objects)) return null;
  return {
    tap: typeof parsed.tap === "string" ? parsed.tap : undefined,
    before: { objects: parsed.before!.objects as MinigameCaptureObject[] },
    after: { objects: parsed.after!.objects as MinigameCaptureObject[] },
  };
}

type Observation =
  | { kind: "changed" }
  | { kind: "unchanged" }
  | { kind: "unobservable" };

/**
 * Did `id` observably change between before and after? Appearing or disappearing counts
 * (a feedback element shows / hides); when present in both, a difference in text, `active`,
 * `isVisible`, or `isFullyVisible` counts. Absent in BOTH ⇒ unobservable (no signal).
 */
function observe(before: MinigameCaptureObject[], after: MinigameCaptureObject[], id: string): Observation {
  const b = before.find((o) => o.id === id);
  const a = after.find((o) => o.id === id);
  if (!b && !a) return { kind: "unobservable" };
  if (!b || !a) return { kind: "changed" }; // appeared or disappeared
  const same =
    (b.text ?? null) === (a.text ?? null) &&
    b.active === a.active &&
    b.isVisible === a.isVisible &&
    b.isFullyVisible === a.isFullyVisible;
  return same ? { kind: "unchanged" } : { kind: "changed" };
}

/**
 * The single source of truth for "did this object observably change" — used by the gate
 * AND by `minigame capture`'s honest suggestion (so the suggestion only ever proposes
 * observing objects the GATE would agree changed). Returns the changed object ids.
 */
export function changedObjectIds(before: MinigameCaptureObject[], after: MinigameCaptureObject[]): string[] {
  const ids = [...new Set([...before.map((o) => o.id), ...after.map((o) => o.id)])];
  return ids.filter((id) => observe(before, after, id).kind === "changed");
}

function gradeState(
  stateId: string,
  ir: { tap: string; observe: string[] },
  evidence: InputResponseEvidence | null,
): InputResponseStateReport {
  const base = { state: stateId, tap: ir.tap, observe: ir.observe, changed: [] as string[] };
  if (!evidence) {
    return {
      ...base,
      status: "missing_evidence",
      detail: `No before/after evidence for '${stateId}' (${responseEvidenceFile(stateId)} absent or malformed) — cannot grade input-response.`,
      nextAction: `Run \`loombridge minigame capture\` (it drives the declared '${ir.tap}' tap and snapshots around it), then re-run. This is a capture gap, NOT a game result.`,
    };
  }
  const observations = ir.observe.map((id) => ({ id, obs: observe(evidence.before.objects, evidence.after.objects, id) }));
  const changed = observations.filter((o) => o.obs.kind === "changed").map((o) => o.id);
  if (changed.length > 0) {
    return { ...base, changed, status: "pass", detail: `Tapping '${ir.tap}' changed [${changed.join(", ")}] — the game responded.`, nextAction: "" };
  }
  // Nothing changed. If at least one observed object WAS observable (present), this is a real
  // liveness failure (the game ignored the input). If NONE were observable, it's a capture gap.
  const anyObservable = observations.some((o) => o.obs.kind !== "unobservable");
  if (!anyObservable) {
    return {
      ...base,
      status: "missing_evidence",
      detail: `None of [${ir.observe.join(", ")}] was present in the '${stateId}' before/after capture — cannot tell whether the game responded.`,
      nextAction: `Capture the response with a correct \`inputResponse\` (the observed objects must be visible around the '${ir.tap}' tap). Capture gap, not a game result.`,
    };
  }
  return {
    ...base,
    status: "game_fail",
    detail: `Tapping '${ir.tap}' changed none of [${ir.observe.join(", ")}] — the game did NOT respond to the gameplay input (an inert/dead control).`,
    nextAction: `Game bug: tapping '${ir.tap}' produced no observable response. Fix the game, re-capture, re-run.`,
  };
}

/** Worst-of rollup: game_fail > missing_evidence > pass; none declared → not_applicable. */
function rollup(states: InputResponseStateReport[]): InputResponseOutcome {
  if (states.length === 0) return "not_applicable";
  if (states.some((s) => s.status === "game_fail")) return "game_fail";
  if (states.some((s) => s.status === "missing_evidence")) return "missing_evidence";
  return "pass";
}

/**
 * Grade every state that declares `inputResponse` against its loaded before/after evidence.
 * PURE — exported so the taxonomy is unit-tested without disk. `evidenceByState` maps a
 * declaring state id to its loaded evidence (null = absent/unobservable → missing_evidence).
 */
export function evaluateInputResponse(
  contract: MinigameContract,
  evidenceByState: ReadonlyMap<string, InputResponseEvidence | null>,
): InputResponseReport {
  const states = contract.states
    .filter((s) => s.inputResponse)
    .map((s) => gradeState(s.id, s.inputResponse!, evidenceByState.get(s.id) ?? null));
  return { outcome: rollup(states), states };
}
