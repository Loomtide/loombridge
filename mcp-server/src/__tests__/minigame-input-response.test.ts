/**
 * input-response gate (slice 3) — read-only liveness taxonomy.
 *
 * Unit-tests `evaluateInputResponse` (pass / game_fail / missing_evidence / not_applicable)
 * + the extended `minigameReportStatus` exit-code keystone, with NO disk. The metamorphic
 * signal: tapping the declared control must observably CHANGE a declared `observe` object —
 * true for any RNG outcome — else the game didn't respond (a real, RNG-invariant defect).
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateInputResponse,
  type InputResponseEvidence,
} from "../capabilities/minigame/input-response.js";
import { minigameReportStatus } from "../capabilities/minigame/verify-minigame.js";
import type { MinigameContract } from "../capabilities/minigame/profiles/types.js";
import type { MinigameCaptureObject } from "../capabilities/minigame/types.js";

/** A contract whose `active` state declares an input-response (tap answer0 → feedback changes). */
function contract(overrides: Partial<MinigameContract> = {}): MinigameContract {
  return {
    schemaVersion: "1",
    id: "g",
    type: "2d-kids-minigame",
    scenes: ["Assets/Scenes/G.unity"],
    ageBand: "3-5",
    visualProfile: "phone-landscape",
    requiredInFrame: [
      { id: "answer0", locator: "G:/HUD/Answer0" },
      { id: "feedback", locator: "G:/HUD/Feedback" },
      { id: "question", locator: "G:/HUD/Question" },
    ],
    states: [
      { id: "active", kind: "active", requiredInFrame: ["answer0"], inputResponse: { tap: "answer0", observe: ["feedback", "question"] } },
    ],
    uiSafeAreas: { maxOverflowFraction: 0 },
    tapTargets: { minSizeDp: 96 },
    interactionFlow: { happyPath: ["active"] },
    artifactThresholds: {},
    checks: { deterministic: ["input-response"] },
    ...overrides,
  } as MinigameContract;
}

function o(id: string, fields: Partial<MinigameCaptureObject> = {}): MinigameCaptureObject {
  return { id, path: `/HUD/${id}`, role: "image", active: true, isVisible: true, isFullyVisible: true, screenRect: { x: 0, y: 0, width: 50, height: 50 }, ...fields } as MinigameCaptureObject;
}

function ev(before: MinigameCaptureObject[], after: MinigameCaptureObject[]): InputResponseEvidence {
  return { tap: "answer0", before: { objects: before }, after: { objects: after } };
}

const map = (e: InputResponseEvidence | null): Map<string, InputResponseEvidence | null> => new Map([["active", e]]);

test("input-response PASS: an observed object's text changed → the game responded", () => {
  const r = evaluateInputResponse(
    contract(),
    map(ev([o("question", { text: "How many apples?" })], [o("question", { text: "How many pears?" })])),
  );
  assert.equal(r.outcome, "pass");
  assert.equal(r.states[0].status, "pass");
  assert.deepEqual(r.states[0].changed, ["question"]);
});

test("input-response PASS: a feedback element APPEARED (absent before, present after)", () => {
  const r = evaluateInputResponse(
    contract(),
    map(ev([o("question", { text: "Q" })], [o("question", { text: "Q" }), o("feedback")])),
  );
  assert.equal(r.outcome, "pass");
  assert.deepEqual(r.states[0].changed, ["feedback"]);
});

test("input-response GAME_FAIL: nothing observed changed → the control is inert (a real defect)", () => {
  const r = evaluateInputResponse(
    contract(),
    map(ev([o("question", { text: "Q" }), o("feedback")], [o("question", { text: "Q" }), o("feedback")])),
  );
  assert.equal(r.outcome, "game_fail");
  assert.equal(r.states[0].status, "game_fail");
  assert.match(r.states[0].detail, /did NOT respond/i);
});

test("input-response MISSING_EVIDENCE: no before/after evidence (capture gap, not a game fail)", () => {
  const r = evaluateInputResponse(contract(), map(null));
  assert.equal(r.outcome, "missing_evidence");
  assert.equal(r.states[0].status, "missing_evidence");
  assert.match(r.states[0].nextAction, /capture/i);
});

test("input-response MISSING_EVIDENCE: observed objects absent in BOTH snapshots (can't tell)", () => {
  const r = evaluateInputResponse(contract(), map(ev([o("answer0")], [o("answer0")])));
  assert.equal(r.outcome, "missing_evidence");
});

test("input-response NOT_APPLICABLE: no state declares inputResponse", () => {
  const c = contract({ states: [{ id: "active", kind: "active", requiredInFrame: ["answer0"] }] } as Partial<MinigameContract>);
  const r = evaluateInputResponse(c, new Map());
  assert.equal(r.outcome, "not_applicable");
  assert.equal(r.states.length, 0);
});

test("minigameReportStatus: input-response game_fail → fail; missing → incomplete; pass → substantive", () => {
  const gameFail = { outcome: "game_fail" as const, states: [] };
  const missing = { outcome: "missing_evidence" as const, states: [] };
  const pass = { outcome: "pass" as const, states: [] };
  assert.equal(minigameReportStatus({}, { strict: false, inputResponse: gameFail }), "fail");
  assert.equal(minigameReportStatus({}, { strict: false, inputResponse: missing }), "incomplete");
  assert.equal(minigameReportStatus({}, { strict: false, inputResponse: pass }), "pass"); // substantive
});
