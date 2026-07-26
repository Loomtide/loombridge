/**
 * Interaction-flow gate (S6d-1) — grades the declared `interactionFlow.happyPath`
 * per TRANSITION, separating a GAME failure from a HARNESS/capture failure.
 *
 * For each `from → to` step the gate needs two independent pieces of evidence:
 *   (A) ACTUATION — the input was honestly delivered (harness OK), and
 *   (B) OUTCOME   — the resulting capture RE-DERIVES to the expected target state
 *                   (game OK). The gate never trusts a harness-asserted "reached"
 *                   field; it recomputes reachability from the actual `to` capture.
 *
 * The failure class falls out of WHICH piece is missing/false:
 *   - `pass`             honest actuation + target reached (+ source left)
 *   - `game_fail`        honest actuation, but the target state was NOT reached
 *   - `harness_fault`    input didn't actuate / target mismatch / partial bridge
 *                        evidence — the game was NOT honestly tested
 *   - `missing_evidence` no flow.json entry, or a `from`/`to` capture is absent
 *
 * Crux rule (anti-misclassification): honest actuation is NECESSARY before the gate
 * may assign `pass` OR `game_fail`. Absent/weak actuation, or an absent capture, can
 * only ever be `harness_fault`/`missing_evidence` (incomplete) — never a game defect,
 * never a pass. Console health is NOT part of the flow outcome this slice
 * (the `console-clean` gate owns it); `evidence.console` is carried for context only.
 */

import type { MinigameContract } from "./profiles/types.js";
import type { MinigameCaptureObject, MinigameCaptureState } from "./types.js";
import type { FlowActuation, FlowEvidence, FlowTransitionEvidence } from "./flow-evidence.js";

/** The deterministic check name this gate implements. */
export const FLOW_CHECK = "interaction-flow";

export type FlowOutcome =
  | "pass"
  | "game_fail"
  | "harness_fault"
  | "missing_evidence"
  | "not_applicable"
  /**
   * The transition reaches an OUTCOME-GATED state (a win/reward the read-only verifier
   * can't drive on a non-deterministic game). Deliberately NOT asserted — neither a pass
   * nor a fail, and it never blocks the exit code. The verifiable transitions are graded
   * as usual; this one is reported honestly as "not asserted (outcome-gated)".
   */
  | "outcome_gated";

export interface FlowTransitionReport {
  /** Human label, e.g. "start → active". */
  transition: string;
  from: string;
  to: string;
  /** The state the transition is expected to reach (= `to`). */
  expectedState: string;
  status: FlowOutcome;
  /** What the evidence/capture actually showed (the re-derivable facts). */
  actualEvidence: string;
  detail: string;
  /** Class-specific remedy that never blames the wrong layer. */
  nextAction: string;
}

export interface FlowReport {
  outcome: FlowOutcome;
  transitions: FlowTransitionReport[];
}

/** uGUI handler signals that count as a real click for a `tap` `ui-dispatch`. */
const CLICK_SIGNALS: ReadonlySet<string> = new Set(["pointerClick", "click"]);

/**
 * uGUI handler signals that count as a real drag for a `drag` `ui-dispatch`. A drag fires the
 * `IDrag*`/`IDrop` chain on the dragged object (and possibly a drop target), NOT a `pointerClick` —
 * so a gesture-driven transition (StarChef: stir, ingredient-to-zone, topping drops) is corroborated
 * by these instead. Requiring at least one means a no-op drag (handlers never fired) is still refused.
 */
// `initializePotentialDrag` is deliberately EXCLUDED — it fires on pointer-down BEFORE any movement,
// so a mere press that never became a drag would otherwise satisfy the drag corroboration.
const DRAG_SIGNALS: ReadonlySet<string> = new Set(["beginDrag", "drag", "endDrag", "drop"]);

/** Bare hierarchy path from a value that may be a `Scene:/Path` locator or already a `/Path`. */
function toPath(s: string): string {
  const i = s.indexOf(":/");
  return i >= 0 ? s.slice(i + 1) : s;
}

/**
 * The actuation acted on the declared target when their hierarchy paths are equal, or
 * one is the other's ancestor at a segment boundary. A uGUI click on a child (the
 * `Label`/`Icon` the ray hit) fires the PARENT's (the Button's) handler, so the bridge's
 * `handlerTarget` is legitimately an ancestor — or, when the trace tapped the Button and
 * the handler is on a child, a descendant — of the declared target. Locator prefixes
 * (`Scene:/…`) are normalized away first so the compare is path-vs-path.
 */
function targetsRelated(actedOn: string, declared: string): boolean {
  const a = toPath(actedOn);
  const d = toPath(declared);
  if (a === d) return true;
  const [shorter, longer] = a.length <= d.length ? [a, d] : [d, a];
  return longer.startsWith(`${shorter}/`);
}

/** The `required-in-frame` per-object predicate: present, active, visible, fully in frame. */
function objectSatisfies(capture: MinigameCaptureState, id: string): boolean {
  const obj: MinigameCaptureObject | undefined = capture.objects.find((o) => o.id === id);
  return !!obj && obj.active === true && obj.isVisible === true && obj.isFullyVisible === true;
}

function stateRequired(contract: MinigameContract, stateId: string): string[] {
  return contract.states.find((s) => s.id === stateId)?.requiredInFrame ?? [];
}

type HonestyResult =
  | { ok: true; evidence: string }
  | { ok: false; reason: string; evidence: string };

/**
 * Accept actuation as honest ONLY when the bridge evidence proves the declared
 * target was acted on: `actuated === true`, the declared target is path-related
 * (equal/ancestor/descendant) to `handlerTarget`, and (for `ui-dispatch`)
 * `handlersFired` carries a click signal. (`raycastHit` is a boolean — did a ray hit
 * a graphic — so it can't corroborate WHICH element and is not used here.)
 * For a multi-step transition EVERY step must pass. Weak/partial → harness_fault.
 */
function actuationHonest(evidence: FlowTransitionEvidence): HonestyResult {
  const kind = evidence.trigger?.kind ?? "ui-dispatch";
  // This slice only grades `ui-dispatch` input. A non-ui-dispatch kind (or a typo) must
  // NOT silently waive the click-signal corroboration below — `trigger.kind` is
  // attacker/harness-controlled evidence, never validated, so refuse it as a harness
  // fault rather than grade it with a weaker check. (Plan §1.2: ui-dispatch is the only
  // kind this slice grades.)
  if (kind !== "ui-dispatch") {
    return { ok: false, reason: `unsupported trigger.kind '${kind}' — this slice only grades 'ui-dispatch' input, so the actuation cannot be corroborated`, evidence: `kind=${kind}` };
  }
  const records: FlowActuation[] =
    Array.isArray(evidence.steps) && evidence.steps.length > 0
      ? evidence.steps
      : evidence.actuation
        ? [evidence.actuation]
        : [];
  if (records.length === 0) {
    return { ok: false, reason: "no actuation evidence (neither steps[] nor actuation present)", evidence: "actuation=absent" };
  }
  for (let i = 0; i < records.length; i += 1) {
    const r = records[i];
    const label = records.length > 1 ? `step ${r.round ?? i + 1}` : "actuation";
    if (r.actuated !== true) {
      return { ok: false, reason: `${label} actuated=${String(r.actuated)} (the bridge did not confirm the input fired)`, evidence: `actuated=${String(r.actuated)}` };
    }
    // A drag corroborates against its SOURCE (the dragged object the handler fires on) and accepts a
    // drag signal; a tap corroborates against its target and needs a click signal. `kind` defaults to
    // "tap" when absent (back-compat with tap-only flow.json).
    const isDrag = r.kind === "drag";
    const target = isDrag ? r.source ?? r.target ?? evidence.trigger?.target : r.target ?? evidence.trigger?.target;
    if (!target) {
      return { ok: false, reason: `${label} declares no ${isDrag ? "source" : "target"} to corroborate the actuation against`, evidence: "target=absent" };
    }
    // Corroborate the DECLARED target against the bridge's `handlerTarget` (the object
    // whose handler fired). `raycastHit` is a BOOLEAN (did the ray hit a graphic), not a
    // target — it can't corroborate WHICH element, so it's not used here. The match is by
    // hierarchy PATH (handlerTarget may be a `Scene:/Path` locator) and tolerates an
    // ancestor/descendant relationship: a click on a child (the `Label` the ray hit)
    // fires the PARENT Button's handler, so handlerTarget is legitimately an ancestor of
    // the declared leaf. Refuse-on-absent stands: no handlerTarget ⇒ cannot corroborate.
    if (typeof r.handlerTarget !== "string" || r.handlerTarget.length === 0) {
      return {
        ok: false,
        reason: `${label} has no handlerTarget locator to corroborate the declared target ${target} — the bridge did not report which element handled the input`,
        evidence: "handlerTarget=absent",
      };
    }
    if (!targetsRelated(r.handlerTarget, target)) {
      return {
        ok: false,
        reason: `${label} acted on ${r.handlerTarget}, not the declared ${isDrag ? "source" : "target"} ${target} (nor its ancestor/descendant)`,
        evidence: `acted-on=${r.handlerTarget}≠${target}`,
      };
    }
    // ui-dispatch: a real input must show the matching handler signal — REQUIRED (never waived).
    // tap → a click signal (pointerClick); drag → a drag signal (beginDrag/drag/endDrag/drop).
    const signals = isDrag ? DRAG_SIGNALS : CLICK_SIGNALS;
    if (!(Array.isArray(r.handlersFired) && r.handlersFired.some((h) => signals.has(h)))) {
      return {
        ok: false,
        reason: `${label} handlersFired=${JSON.stringify(r.handlersFired ?? [])} lacks a ${isDrag ? "drag signal (beginDrag/drag/endDrag)" : "click signal (pointerClick)"} — partial bridge evidence`,
        evidence: `handlers=${JSON.stringify(r.handlersFired ?? [])}`,
      };
    }
  }
  const first = records[0];
  const summary =
    records.length > 1
      ? `${records.length} honest actuation(s)`
      : `actuated=true target=${first.target ?? evidence.trigger?.target} handlers=${JSON.stringify(first.handlersFired ?? [])}`;
  return { ok: true, evidence: summary };
}

type ReachResult =
  | { kind: "reached"; evidence: string }
  | { kind: "game_fail"; reason: string; evidence: string }
  | { kind: "indeterminate"; reason: string; evidence: string };

/**
 * Re-derive whether the transition reached `to` from the ACTUAL `to` capture —
 * never from a harness-asserted field. Reached = `to`'s requiredInFrame all
 * satisfied AND the source `from` was left (its required no longer all satisfied).
 * A `to` state with no requiredInFrame is indeterminate (cannot re-derive →
 * incomplete, never a vacuous pass).
 */
function reachCheck(
  contract: MinigameContract,
  toCapture: MinigameCaptureState,
  to: string,
  from: string,
): ReachResult {
  const toRequired = stateRequired(contract, to);
  const fromRequired = stateRequired(contract, from);
  if (toRequired.length === 0) {
    return { kind: "indeterminate", reason: `target state '${to}' declares no requiredInFrame objects to re-derive reachability against`, evidence: "to.required=none" };
  }
  const missing = toRequired.filter((id) => !objectSatisfies(toCapture, id));
  if (missing.length > 0) {
    // G8: the capture marks objects that appeared DURING this state's window but never in the
    // representative frame — i.e. the contract collapsed sequential sub-screens (cook: spray→pour→
    // power) into one state. When every missing required object is such a sequential one, the game
    // DID reach the screen (it showed each in turn); we just can't confirm it as a single frame. That
    // is a contract-granularity gap → INDETERMINATE (can't verify, split the state), never a game fail.
    const sequential = new Set(toCapture.sequential?.missing ?? []);
    if (sequential.size > 0 && missing.every((id) => sequential.has(id))) {
      return {
        kind: "indeterminate",
        reason: `target '${to}' shows its required object(s) [${missing.join(", ")}] sequentially (never in one frame) — '${to}' collapses sequential sub-screens; split it into one state per sub-screen`,
        evidence: `to.sequential=[${missing.join(", ")}]`,
      };
    }
    return { kind: "game_fail", reason: `target '${to}' required object(s) [${missing.join(", ")}] not visible in the post-transition capture`, evidence: `to.required missing=[${missing.join(", ")}]` };
  }
  if (fromRequired.length > 0 && fromRequired.every((id) => objectSatisfies(toCapture, id))) {
    return {
      kind: "game_fail",
      reason: `still showing source '${from}' (its required object(s) [${fromRequired.join(", ")}] are all still visible) — did not advance`,
      evidence: "from.required still satisfied",
    };
  }
  return { kind: "reached", evidence: `to='${to}'.required satisfied${fromRequired.length > 0 ? `, from='${from}'.required no longer satisfied` : ""}` };
}

const missingNext = (t: string): string =>
  `No flow evidence for '${t}' (a flow.json entry and/or a capture is absent). Capture it and re-run — this is NOT a game result.`;
const harnessNext = (t: string): string =>
  `Harness fault on '${t}' — the input driver did not honestly actuate the declared target. The game was NOT tested here; re-capture. Do NOT treat as a game defect.`;
const gameNext = (t: string, from: string, to: string, reason: string): string =>
  `Game bug on '${t}': the declared input on '${from}' did not advance to '${to}' (${reason}). Fix the game, re-capture, re-run.`;
const indeterminateNext = (to: string): string =>
  `Cannot re-derive reachability — target state '${to}' declares no requiredInFrame object. Add a requiredInFrame object to '${to}' in the contract so the gate can confirm the state was reached. (Not a game result.)`;

function gradeTransition(
  contract: MinigameContract,
  flowEvidence: FlowEvidence | null,
  capturesByState: ReadonlyMap<string, MinigameCaptureState | null>,
  from: string,
  to: string,
): FlowTransitionReport {
  const transition = `${from} → ${to}`;
  const base = { transition, from, to, expectedState: to };

  // 0. Outcome-gated? A transition into (or out of) an outcome-gated state depends on a
  // game OUTCOME a read-only verifier can't drive (e.g. winning a re-randomizing round).
  // We deliberately DON'T assert it — never a pass, never a fail. Reported honestly so a
  // reviewer sees "not asserted (outcome-gated)", not a misattributed game/harness fault.
  if (isOutcomeGated(contract, to) || isOutcomeGated(contract, from)) {
    const which = isOutcomeGated(contract, to) ? to : from;
    return {
      ...base,
      status: "outcome_gated",
      actualEvidence: `'${which}' is outcome-gated`,
      detail: `'${transition}' reaches an outcome-gated state ('${which}') — its outcome depends on game logic a READ-ONLY verifier can't drive (e.g. answering correctly on a game that re-randomizes each round). Not asserted by design.`,
      nextAction: outcomeGatedNext(transition, which),
    };
  }

  // 1. Evidence present? (refuse-on-absent → missing_evidence, never a game result)
  if (!flowEvidence) {
    return { ...base, status: "missing_evidence", actualEvidence: "no flow.json in the capture dir", detail: `No flow.json — cannot grade '${transition}'.`, nextAction: missingNext(transition) };
  }
  const evidence = flowEvidence.transitions.find((tr) => tr.from === from && tr.to === to);
  if (!evidence) {
    return { ...base, status: "missing_evidence", actualEvidence: "no transition entry in flow.json", detail: `flow.json has no entry for '${transition}'.`, nextAction: missingNext(transition) };
  }
  const toCapture = capturesByState.get(to) ?? null;
  const fromCapture = capturesByState.get(from) ?? null;
  if (!toCapture) {
    return { ...base, status: "missing_evidence", actualEvidence: `'${to}' capture absent/unreadable`, detail: `The '${to}' capture is absent/unreadable — cannot confirm the transition reached it (capture/harness gap, not a game defect).`, nextAction: missingNext(transition) };
  }
  if (!fromCapture) {
    return { ...base, status: "missing_evidence", actualEvidence: `'${from}' capture absent/unreadable`, detail: `The '${from}' capture is absent/unreadable — cannot anchor the transition.`, nextAction: missingNext(transition) };
  }

  // 2. Harness honest? (actuated + target corroboration + click signal)
  const honest = actuationHonest(evidence);
  if (!honest.ok) {
    return { ...base, status: "harness_fault", actualEvidence: honest.evidence, detail: `Harness fault on '${transition}': ${honest.reason}. The game was NOT honestly tested here.`, nextAction: harnessNext(transition) };
  }

  // 3. Outcome re-derived from the actual capture (never the harness's claim).
  const reach = reachCheck(contract, toCapture, to, from);
  const evidenceStr = `${honest.evidence}; ${reach.evidence}`;
  if (reach.kind === "reached") {
    return { ...base, status: "pass", actualEvidence: evidenceStr, detail: `Honest input advanced '${from}' → '${to}'.`, nextAction: "" };
  }
  if (reach.kind === "indeterminate") {
    return { ...base, status: "missing_evidence", actualEvidence: evidenceStr, detail: `Cannot re-derive reachability for '${transition}': ${reach.reason}.`, nextAction: indeterminateNext(to) };
  }
  return { ...base, status: "game_fail", actualEvidence: evidenceStr, detail: `Game did not advance on '${transition}': ${reach.reason}.`, nextAction: gameNext(transition, from, to, reach.reason) };
}

/** True when a declared state is outcome-gated (unassertable read-only by design). */
function isOutcomeGated(contract: MinigameContract, stateId: string): boolean {
  return contract.states.find((s) => s.id === stateId)?.outcomeGated === true;
}

const outcomeGatedNext = (t: string, state: string): string =>
  `'${t}' is outcome-gated on '${state}' — a read-only verifier can't drive the outcome (no RNG seed / no game change). NOT a defect and NOT a capture gap; the verifiable transitions are graded normally. Remove the state's \`outcomeGated\` flag only if the outcome becomes deterministically reachable.`;

/**
 * Worst-of rollup: game_fail > harness_fault > missing_evidence > pass > outcome_gated.
 * `outcome_gated` is the LOWEST priority: a flow with some verifiable transitions that
 * pass and some that are outcome-gated rolls up to `pass` (the gradeable part passed);
 * a wholly outcome-gated flow rolls up to `outcome_gated` (nothing was asserted, by
 * design — never laundered into a pass, never a fail).
 */
function rollupOutcome(transitions: FlowTransitionReport[]): FlowOutcome {
  if (transitions.length === 0) return "missing_evidence";
  if (transitions.some((t) => t.status === "game_fail")) return "game_fail";
  if (transitions.some((t) => t.status === "harness_fault")) return "harness_fault";
  if (transitions.some((t) => t.status === "missing_evidence")) return "missing_evidence";
  if (transitions.some((t) => t.status === "pass")) return "pass";
  return "outcome_gated";
}

/**
 * Grade the declared `interactionFlow.happyPath` over the per-transition evidence
 * and the per-state captures. PURE — exported so the taxonomy is exhaustively
 * unit-tested without disk. `capturesByState` maps each declared state id to its
 * loaded capture (null = absent/unreadable, → missing_evidence for any transition
 * that touches it).
 */
export function evaluateInteractionFlow(
  contract: MinigameContract,
  flowEvidence: FlowEvidence | null,
  capturesByState: ReadonlyMap<string, MinigameCaptureState | null>,
): FlowReport {
  const happy = contract.interactionFlow?.happyPath ?? [];
  const transitions: FlowTransitionReport[] = [];
  for (let i = 0; i + 1 < happy.length; i += 1) {
    transitions.push(gradeTransition(contract, flowEvidence, capturesByState, happy[i], happy[i + 1]));
  }
  return { outcome: rollupOutcome(transitions), transitions };
}
