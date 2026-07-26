/**
 * S6d-1 — interaction-flow gate: harness-vs-game failure separation.
 *
 * Unit-tests `evaluateInteractionFlow` (the per-transition taxonomy) and the
 * extended `minigameReportStatus` (the exit-code keystone), with NO disk:
 *   - pass / game_fail / harness_fault / missing_evidence
 *   - anti-self-grade: the gate re-derives reachability from the capture, never from
 *     a harness-asserted field
 *   - the load-bearing keystones: a harness_fault (or captureAbsent) FORCES incomplete
 *     even when every per-state gate passes; a real fail still outranks a harness fault.
 *
 * The "missing whole capture = exit 2 not 1" and "object missing inside a valid
 * capture = exit 1" CLI proofs live in verify-minigame.test.ts (captureAbsent →
 * incomplete; the offscreen-negative fixture → required-in-frame fail).
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  evaluateInteractionFlow,
  loadFlowEvidence,
  FLOW_EVIDENCE_FILE,
  type FlowEvidence,
  type FlowOutcome,
  type FlowReport,
} from "../../../../capabilities/minigame/index.js";
import { minigameReportStatus } from "../../../../capabilities/minigame/verify-minigame.js";
import type { MinigameContract } from "../../../../capabilities/minigame/profiles/types.js";
import type { MinigameCaptureObject, MinigameCaptureState } from "../../../../capabilities/minigame/types.js";
import { makeGateReport, type CheckStatus, type GateReport } from "../../../../capabilities/verification/gates/types.js";

// ── builders ────────────────────────────────────────────────────────────────────

/** A flow contract: start → active → success_reward → home_back, one required object per state. */
function flowContract(overrides: Partial<MinigameContract> = {}): MinigameContract {
  return {
    schemaVersion: "1",
    id: "flow",
    type: "2d-kids-minigame",
    scenes: ["Assets/Scenes/F.unity"],
    ageBand: "3-5",
    visualProfile: "phone-landscape",
    requiredInFrame: [
      { id: "startButton", locator: "F:/HUD/StartButton" },
      { id: "answerButton0", locator: "F:/HUD/AnswerButton0" },
      { id: "replayButton", locator: "F:/HUD/ReplayButton" },
    ],
    states: [
      { id: "start", kind: "start", requiredInFrame: ["startButton"] },
      { id: "active", kind: "active", requiredInFrame: ["answerButton0"] },
      { id: "success_reward", kind: "success_reward", requiredInFrame: ["replayButton"] },
      { id: "home_back", kind: "home_back", requiredInFrame: ["startButton"] },
    ],
    uiSafeAreas: { maxOverflowFraction: 0 },
    tapTargets: { minSizeDp: 96 },
    interactionFlow: { happyPath: ["start", "active", "success_reward", "home_back"] },
    artifactThresholds: {},
    checks: { deterministic: ["interaction-flow"] },
    ...overrides,
  } as MinigameContract;
}

function capObj(id: string): MinigameCaptureObject {
  return {
    id,
    path: `/HUD/${id}`,
    role: "image",
    active: true,
    isVisible: true,
    visibilityReason: null,
    isFullyVisible: true,
    isPartiallyClipped: false,
    screenRect: { x: 0, y: 0, width: 100, height: 100 },
  } as MinigameCaptureObject;
}

function mkCap(state: string, visibleIds: string[]): MinigameCaptureState {
  return { state, viewport: { width: 1280, height: 720, aspect: 16 / 9 }, objects: visibleIds.map(capObj) };
}

/** The "honest happy path" capture set: each `to` shows its required object and has left its `from`. */
function goodCaptures(): Map<string, MinigameCaptureState | null> {
  return new Map<string, MinigameCaptureState | null>([
    ["start", mkCap("start", ["startButton"])],
    ["active", mkCap("active", ["answerButton0"])],
    ["success_reward", mkCap("success_reward", ["replayButton"])],
    ["home_back", mkCap("home_back", ["startButton"])],
  ]);
}

function act(target: string, opts: Record<string, unknown> = {}): Record<string, unknown> {
  // handlerTarget corroborates the declared target; raycastHit is a boolean (did the
  // ray hit a graphic), informational only.
  return { actuated: true, handlerTarget: target, raycastHit: true, handlersFired: ["pointerDown", "pointerUp", "pointerClick"], ...opts };
}

/** The honest 3-transition evidence (the middle one multi-step, ×5 rounds). */
function goodFlow(): FlowEvidence {
  const steps = Array.from({ length: 5 }, (_v, i) => ({ round: i + 1, target: "/HUD/AnswerButton0", ...act("/HUD/AnswerButton0") }));
  return {
    schemaVersion: "1",
    transitions: [
      { from: "start", to: "active", trigger: { kind: "ui-dispatch", target: "/HUD/StartButton" }, actuation: act("/HUD/StartButton") },
      { from: "active", to: "success_reward", trigger: { kind: "ui-dispatch", target: "/HUD/AnswerButton0" }, steps },
      { from: "success_reward", to: "home_back", trigger: { kind: "ui-dispatch", target: "/HUD/HomeButton" }, actuation: act("/HUD/HomeButton") },
    ],
  };
}

/** Deep-clone the flow so a test can mutate one transition without touching the others. */
function cloneFlow(): FlowEvidence {
  return JSON.parse(JSON.stringify(goodFlow())) as FlowEvidence;
}

function outcomeOf(transition: string, report: ReturnType<typeof evaluateInteractionFlow>): FlowOutcome {
  return report.transitions.find((t) => t.from + " → " + t.to === transition || t.transition === transition)!.status;
}

// ── PASS ──────────────────────────────────────────────────────────────────────

test("flow PASS: honest actuation + every target reached → outcome pass", () => {
  const r = evaluateInteractionFlow(flowContract(), goodFlow(), goodCaptures());
  assert.equal(r.outcome, "pass");
  assert.equal(r.transitions.length, 3);
  assert.ok(r.transitions.every((t) => t.status === "pass"));
});

// ── GAME_FAIL ────────────────────────────────────────────────────────────────

test("flow GAME_FAIL: honest actuation but the target state's required object is not visible", () => {
  const caps = goodCaptures();
  caps.set("success_reward", mkCap("success_reward", [])); // reward card not shown
  const r = evaluateInteractionFlow(flowContract(), goodFlow(), caps);
  assert.equal(r.outcome, "game_fail");
  const t = r.transitions.find((x) => x.to === "success_reward")!;
  assert.equal(t.status, "game_fail");
  assert.equal(t.expectedState, "success_reward");
  assert.match(t.detail, /replayButton/);
  assert.match(t.nextAction, /Game bug/i);
});

test("flow GAME_FAIL: reached target but never LEFT the source (soft-lock / overlay stuck)", () => {
  const caps = goodCaptures();
  // active capture still shows startButton AND answerButton0 → did not leave 'start'.
  caps.set("active", mkCap("active", ["answerButton0", "startButton"]));
  const r = evaluateInteractionFlow(flowContract(), goodFlow(), caps);
  const t = r.transitions.find((x) => x.transition === "start → active")!;
  assert.equal(t.status, "game_fail");
  assert.match(t.detail, /did not advance|still showing/i);
});

// ── HARNESS_FAULT (the crux: never a game defect, never a pass) ──────────────────

test("flow HARNESS_FAULT: actuated=false → harness fault, NOT game_fail/pass", () => {
  const flow = cloneFlow();
  flow.transitions[0].actuation!.actuated = false;
  const r = evaluateInteractionFlow(flowContract(), flow, goodCaptures());
  assert.equal(r.outcome, "harness_fault");
  const t = r.transitions[0];
  assert.equal(t.status, "harness_fault");
  assert.match(t.detail, /not honestly tested/i);
  assert.match(t.nextAction, /Do NOT treat as a game defect/i);
});

test("flow HARNESS_FAULT: actuated but handlerTarget is an unrelated element (acted on the wrong thing)", () => {
  const flow = cloneFlow();
  flow.transitions[0].actuation!.handlerTarget = "/HUD/SomethingElse";
  const r = evaluateInteractionFlow(flowContract(), flow, goodCaptures());
  assert.equal(outcomeOf("start → active", r), "harness_fault");
});

test("flow HARNESS_FAULT: handlerTarget absent — cannot corroborate the declared target (refuse-on-absent)", () => {
  // The live bug's honest floor: actuated:true + pointerClick fired, but no handlerTarget
  // to prove WHICH element handled it ⇒ harness_fault, never a silent pass.
  const flow = cloneFlow();
  delete flow.transitions[0].actuation!.handlerTarget;
  const r = evaluateInteractionFlow(flowContract(), flow, goodCaptures());
  const t = r.transitions.find((x) => x.transition === "start → active")!;
  assert.equal(t.status, "harness_fault");
  assert.match(t.actualEvidence, /handlerTarget=absent/);
});

test("flow PASS: handlerTarget is the parent Button (ancestor) of the tapped leaf Label — the live shape", () => {
  // Reproduces the real CountTheFruits capture: the trace tapped `…/StartButton/Label`
  // but uGUI fires the PARENT Button's click handler, and the bridge reports it as a
  // full `Scene:/Path` locator. Ancestor + locator-prefix must still corroborate.
  const flow = cloneFlow();
  flow.transitions[0].trigger!.target = "/HUD/StartButton/Label";
  flow.transitions[0].actuation = {
    actuated: true,
    handlerTarget: "DemoScene:/HUD/StartButton", // ancestor, locator-prefixed
    raycastHit: true,
    handlersFired: ["pointerDown", "pointerUp", "pointerClick"],
    target: "/HUD/StartButton/Label",
  };
  const r = evaluateInteractionFlow(flowContract(), flow, goodCaptures());
  assert.equal(outcomeOf("start → active", r), "pass");
});

test("flow PASS: handlerTarget is a DESCENDANT of the declared target (defensive direction)", () => {
  // The trace tapped the Button; the handler is reported on its child graphic. Tolerated.
  const flow = cloneFlow();
  flow.transitions[0].trigger!.target = "/HUD/StartButton";
  flow.transitions[0].actuation = {
    actuated: true,
    handlerTarget: "/HUD/StartButton/Icon",
    raycastHit: true,
    handlersFired: ["pointerClick"],
    target: "/HUD/StartButton",
  };
  assert.equal(outcomeOf("start → active", evaluateInteractionFlow(flowContract(), flow, goodCaptures())), "pass");
});

test("flow OUTCOME_GATED: a transition into a gated state is not asserted; the verifiable part still passes", () => {
  // success_reward + home_back are outcome-gated (a read-only verifier can't drive the win
  // on a re-randomizing game). start→active is verifiable and passes; the gated transitions
  // are 'outcome_gated' (neither pass nor fail), and the rollup is the gradeable result: pass.
  const contract = flowContract({
    states: [
      { id: "start", kind: "start", requiredInFrame: ["startButton"] },
      { id: "active", kind: "active", requiredInFrame: ["answerButton0"] },
      { id: "success_reward", kind: "success_reward", requiredInFrame: ["replayButton"], outcomeGated: true },
      { id: "home_back", kind: "home_back", requiredInFrame: ["startButton"], outcomeGated: true },
    ],
  } as Partial<MinigameContract>);
  const r = evaluateInteractionFlow(contract, cloneFlow(), goodCaptures());
  assert.equal(outcomeOf("start → active", r), "pass");
  assert.equal(outcomeOf("active → success_reward", r), "outcome_gated");
  assert.equal(outcomeOf("success_reward → home_back", r), "outcome_gated"); // can't leave a state you couldn't reach
  assert.equal(r.outcome, "pass", "rollup reflects the verifiable transitions");
});

test("flow OUTCOME_GATED: a wholly-gated flow rolls up to outcome_gated (never laundered to pass)", () => {
  const contract = flowContract({
    states: [
      { id: "start", kind: "start", requiredInFrame: ["startButton"], outcomeGated: true },
      { id: "active", kind: "active", requiredInFrame: ["answerButton0"], outcomeGated: true },
      { id: "success_reward", kind: "success_reward", requiredInFrame: ["replayButton"], outcomeGated: true },
      { id: "home_back", kind: "home_back", requiredInFrame: ["startButton"], outcomeGated: true },
    ],
  } as Partial<MinigameContract>);
  const r = evaluateInteractionFlow(contract, cloneFlow(), goodCaptures());
  assert.equal(r.outcome, "outcome_gated");
  assert.ok(r.transitions.every((t) => t.status === "outcome_gated"));
});

test("minigameReportStatus: an outcome_gated flow + a passing per-state gate = PASS (not incomplete, not fail)", () => {
  const states: Record<string, GateReport[]> = {
    active: [makeGateReport("required-in-frame", [{ id: "required-in-frame.answerButton0", expected: "visible", actual: "visible", status: "pass", detail: "ok" }])],
  };
  const flow: FlowReport = { outcome: "outcome_gated", transitions: [] };
  assert.equal(minigameReportStatus(states, { strict: false, flow }), "pass");
  // ...and outcome_gated must never be a fail or force incomplete on its own.
  assert.notEqual(minigameReportStatus({}, { strict: false, flow }), "fail");
});

test("flow HARNESS_FAULT: a SIBLING-PREFIX handlerTarget is NOT an ancestor (the '/' boundary holds)", () => {
  // `/HUD/StartButton` must NOT corroborate `/HUD/StartButtonX` (prefix, but not a path
  // segment ancestor) — guards the `+ "/"` boundary against a string-prefix false match.
  const flow = cloneFlow();
  flow.transitions[0].trigger!.target = "/HUD/StartButtonX";
  flow.transitions[0].actuation = {
    actuated: true,
    handlerTarget: "/HUD/StartButton",
    raycastHit: true,
    handlersFired: ["pointerClick"],
    target: "/HUD/StartButtonX",
  };
  assert.equal(outcomeOf("start → active", evaluateInteractionFlow(flowContract(), flow, goodCaptures())), "harness_fault");
});

test("flow HARNESS_FAULT: ui-dispatch handlersFired lacks a click signal (partial bridge evidence)", () => {
  const flow = cloneFlow();
  flow.transitions[0].actuation!.handlersFired = ["pointerDown", "pointerUp"]; // no pointerClick
  const r = evaluateInteractionFlow(flowContract(), flow, goodCaptures());
  assert.equal(outcomeOf("start → active", r), "harness_fault");
});

test("flow HARNESS_FAULT: one of the multi-step round actuations did not fire", () => {
  const flow = cloneFlow();
  flow.transitions[1].steps![2].actuated = false; // round 3 click missed
  const r = evaluateInteractionFlow(flowContract(), flow, goodCaptures());
  assert.equal(outcomeOf("active → success_reward", r), "harness_fault");
});

// ── DRAG actuations (G4: gesture-driven transitions) ──────────────────────────

/** A drag actuation: fires the drag chain on the SOURCE (the dragged object), not a pointerClick. */
function dragAct(source: string, target: string, opts: Record<string, unknown> = {}): Record<string, unknown> {
  return { actuated: true, kind: "drag", source, target, handlerTarget: source, raycastHit: true, handlersFired: ["beginDrag", "drag", "endDrag"], ...opts };
}

test("flow PASS (G4): a DRAG transition is honest when the drag chain fires on the dragged source", () => {
  // StarChef-style: the transition is a drag from an ingredient to a mix zone — beginDrag/drag/endDrag
  // fire on the SOURCE, never a pointerClick on the drop target. Must grade as honest, then pass on reach.
  const flow = cloneFlow();
  flow.transitions[0] = {
    from: "start", to: "active",
    trigger: { kind: "ui-dispatch", target: "/HUD/MixZone" },
    actuation: dragAct("/HUD/StartButton", "/HUD/MixZone"),
  };
  const r = evaluateInteractionFlow(flowContract(), flow, goodCaptures());
  assert.equal(outcomeOf("start → active", r), "pass");
});

test("flow (G8): a sequential sub-screen `to` state → indeterminate (missing_evidence), NOT a false game_fail", () => {
  // active's required object is shown sequentially (the capture marks it), so it's missing from the
  // single representative frame. The game DID advance (honest drag); we just can't confirm reach as one
  // frame → can't-verify (split the state), never "game didn't advance".
  const flow = cloneFlow();
  flow.transitions[0].actuation = dragAct("/HUD/StartButton", "/HUD/MixZone");
  const caps = goodCaptures();
  const activeSeq = mkCap("active", []); // answerButton0 NOT in the captured frame
  activeSeq.sequential = { missing: ["answerButton0"] }; // …but seen elsewhere in the window
  caps.set("active", activeSeq);
  const r = evaluateInteractionFlow(flowContract(), flow, caps);
  assert.equal(outcomeOf("start → active", r), "missing_evidence");
  assert.match(r.transitions[0].detail, /sequential sub-screens|split/i);
});

test("flow HARNESS_FAULT (G4): a drag with no drag signal (only pointerDown/Up) is refused", () => {
  const flow = cloneFlow();
  flow.transitions[0].actuation = dragAct("/HUD/StartButton", "/HUD/MixZone", { handlersFired: ["pointerDown", "pointerUp"] });
  assert.equal(outcomeOf("start → active", evaluateInteractionFlow(flowContract(), flow, goodCaptures())), "harness_fault");
});

test("flow HARNESS_FAULT (G4): a drag whose handler fired on an UNRELATED element (not the dragged source) is refused", () => {
  const flow = cloneFlow();
  flow.transitions[0].actuation = dragAct("/HUD/StartButton", "/HUD/MixZone", { handlerTarget: "/HUD/SomethingElse" });
  assert.equal(outcomeOf("start → active", evaluateInteractionFlow(flowContract(), flow, goodCaptures())), "harness_fault");
});

test("flow back-compat: a tap actuation (kind absent) STILL requires a click signal — a drag signal alone is not enough", () => {
  const flow = cloneFlow();
  // No kind → treated as a tap; beginDrag/drag are not click signals → refused (drag relaxation must not leak to taps).
  flow.transitions[0].actuation!.handlersFired = ["beginDrag", "drag", "endDrag"];
  assert.equal(outcomeOf("start → active", evaluateInteractionFlow(flowContract(), flow, goodCaptures())), "harness_fault");
});

test("flow HARNESS_FAULT: a non-ui-dispatch trigger.kind is refused, NOT graded with a weaker check (Critical regression)", () => {
  // trigger.kind is attacker/harness-controlled evidence (never validated). A non-ui-dispatch
  // kind must NOT waive the click-signal corroboration — even with otherwise-honest evidence
  // (actuated + target match) and a reached capture, it is a harness fault, never a pass.
  const flow = cloneFlow();
  flow.transitions[0].trigger!.kind = "keyboard";
  delete flow.transitions[0].actuation!.handlersFired; // input fire never proven
  const r = evaluateInteractionFlow(flowContract(), flow, goodCaptures());
  assert.equal(outcomeOf("start → active", r), "harness_fault");
  assert.match(r.transitions[0].detail, /ui-dispatch/);
  // Even a fully-honest-looking record under a non-ui-dispatch kind is refused.
  const flow2 = cloneFlow();
  flow2.transitions[0].trigger!.kind = "tap";
  assert.equal(outcomeOf("start → active", evaluateInteractionFlow(flowContract(), flow2, goodCaptures())), "harness_fault");
});

test("flow: an ABSENT trigger.kind defaults to ui-dispatch (honest evidence still passes)", () => {
  const flow = cloneFlow();
  delete flow.transitions[0].trigger!.kind; // omitted → defaults to ui-dispatch
  assert.equal(outcomeOf("start → active", evaluateInteractionFlow(flowContract(), flow, goodCaptures())), "pass");
});

test("flow: steps[] takes precedence over a sibling actuation (a bad step wins)", () => {
  const flow = cloneFlow();
  // Give the multi-step transition a (good) single actuation too — steps[] must still govern.
  flow.transitions[1].actuation = act("/HUD/AnswerButton0") as never;
  flow.transitions[1].steps![0].actuated = false;
  assert.equal(outcomeOf("active → success_reward", evaluateInteractionFlow(flowContract(), flow, goodCaptures())), "harness_fault");
});

test("flow HARNESS_FAULT: a single actuation with no target to corroborate against", () => {
  const flow = cloneFlow();
  delete flow.transitions[0].trigger!.target;
  delete flow.transitions[0].actuation!.target;
  assert.equal(outcomeOf("start → active", evaluateInteractionFlow(flowContract(), flow, goodCaptures())), "harness_fault");
});

// ── MISSING_EVIDENCE ─────────────────────────────────────────────────────────

test("flow MISSING_EVIDENCE: no flow.json at all → every transition missing", () => {
  const r = evaluateInteractionFlow(flowContract(), null, goodCaptures());
  assert.equal(r.outcome, "missing_evidence");
  assert.ok(r.transitions.every((t) => t.status === "missing_evidence"));
});

test("flow MISSING_EVIDENCE: a declared transition has no entry", () => {
  const flow = cloneFlow();
  flow.transitions = flow.transitions.filter((t) => !(t.from === "success_reward")); // drop the last
  const r = evaluateInteractionFlow(flowContract(), flow, goodCaptures());
  assert.equal(r.outcome, "missing_evidence");
  assert.equal(outcomeOf("success_reward → home_back", r), "missing_evidence");
});

test("flow MISSING_EVIDENCE: a wholly-absent capture for a flow state (never game_fail)", () => {
  const caps = goodCaptures();
  caps.set("active", null); // capture/harness gap
  const r = evaluateInteractionFlow(flowContract(), goodFlow(), caps);
  // start→active (to absent) and active→success_reward (from absent) are missing, not game_fail.
  assert.equal(outcomeOf("start → active", r), "missing_evidence");
  assert.equal(outcomeOf("active → success_reward", r), "missing_evidence");
  assert.equal(r.outcome, "missing_evidence");
});

test("flow MISSING_EVIDENCE: a 'to' state with no requiredInFrame is indeterminate, never a vacuous pass", () => {
  const contract = flowContract();
  contract.states.find((s) => s.id === "active")!.requiredInFrame = [];
  const r = evaluateInteractionFlow(contract, goodFlow(), goodCaptures());
  const t = r.transitions.find((x) => x.transition === "start → active")!;
  assert.equal(t.status, "missing_evidence");
  // The next action points at the CONTRACT gap (a present-and-correct capture), not "capture it".
  assert.match(t.nextAction, /Add a requiredInFrame object/i);
  assert.doesNotMatch(t.nextAction, /flow\.json entry and\/or a capture is absent/i);
});

// ── loadFlowEvidence robustness ─────────────────────────────────────────────────

test("loadFlowEvidence: absent file → null; unparseable → null; non-array transitions → []", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-evidence-"));
  try {
    assert.equal(await loadFlowEvidence(dir), null, "absent flow.json → null");

    await fs.writeFile(path.join(dir, FLOW_EVIDENCE_FILE), "{ not valid json", "utf-8");
    assert.equal(await loadFlowEvidence(dir), null, "unparseable flow.json → null (never throws)");

    await fs.writeFile(path.join(dir, FLOW_EVIDENCE_FILE), JSON.stringify({ transitions: "oops" }), "utf-8");
    const degraded = await loadFlowEvidence(dir);
    assert.ok(degraded && Array.isArray(degraded.transitions) && degraded.transitions.length === 0, "non-array transitions degrade to []");

    await fs.writeFile(path.join(dir, FLOW_EVIDENCE_FILE), JSON.stringify({ schemaVersion: "1", transitions: [{ from: "a", to: "b" }] }), "utf-8");
    const ok = await loadFlowEvidence(dir);
    assert.equal(ok?.transitions.length, 1);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ── ANTI-SELF-GRADE ────────────────────────────────────────────────────────────

test("flow ANTI-SELF-GRADE: honest actuation + a harness-asserted 'reached' field, but the capture contradicts it → game_fail, never pass", () => {
  const flow = cloneFlow();
  // The harness lies that it reached success_reward (an unknown field the gate must ignore)…
  (flow.transitions[1] as unknown as Record<string, unknown>).matchedState = "success_reward";
  const caps = goodCaptures();
  caps.set("success_reward", mkCap("success_reward", [])); // …but the capture shows no reward card.
  const r = evaluateInteractionFlow(flowContract(), flow, caps);
  // The gate re-derives from the capture and ignores the asserted field → game_fail.
  assert.equal(outcomeOf("active → success_reward", r), "game_fail");
});

// ── minigameReportStatus: the exit-code keystones ───────────────────────────────

function states(...specs: Array<[string, CheckStatus]>): Record<string, GateReport[]> {
  const out: Record<string, GateReport[]> = {};
  specs.forEach(([id, status], i) => {
    out[id] = [makeGateReport("g", [{ id: `g.${id}.${i}`, expected: "e", actual: "a", status, detail: "d" }])];
  });
  return out;
}
const flowWith = (outcome: FlowOutcome): FlowReport => ({ outcome, transitions: [] });

test("status KEYSTONE: harness_fault + EVERY per-state gate passes → incomplete (never laundered into a green)", () => {
  const st = states(["a", "pass"], ["b", "pass"]);
  assert.equal(minigameReportStatus(st, { strict: false, captureAbsent: [], flow: flowWith("harness_fault") }), "incomplete");
});

test("status KEYSTONE: a real deterministic fail OUTRANKS a harness fault → fail (the defect still surfaces)", () => {
  const st = states(["a", "fail"], ["b", "pass"]);
  assert.equal(minigameReportStatus(st, { strict: false, captureAbsent: [], flow: flowWith("harness_fault") }), "fail");
});

test("status: flow game_fail (with all per-state passing) → fail", () => {
  const st = states(["a", "pass"]);
  assert.equal(minigameReportStatus(st, { strict: false, flow: flowWith("game_fail") }), "fail");
});

test("status: captureAbsent forces incomplete even with all per-state gates passing", () => {
  const st = states(["a", "pass"]);
  assert.equal(minigameReportStatus(st, { strict: false, captureAbsent: ["start"] }), "incomplete");
});

test("status: flow missing_evidence + per-state pass → incomplete", () => {
  const st = states(["a", "pass"]);
  assert.equal(minigameReportStatus(st, { strict: false, flow: flowWith("missing_evidence") }), "incomplete");
});

test("status: flow pass makes a flow-only contract (no per-state checks) a real pass, not incomplete", () => {
  assert.equal(minigameReportStatus({ active: [], success_reward: [] }, { strict: false, flow: flowWith("pass") }), "pass");
});

test("status: flow pass + all per-state pass → pass", () => {
  const st = states(["a", "pass"], ["b", "pass"]);
  assert.equal(minigameReportStatus(st, { strict: false, flow: flowWith("pass") }), "pass");
});
