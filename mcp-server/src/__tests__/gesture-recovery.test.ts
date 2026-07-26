/**
 * Closed-loop adaptive gesture replay — re-drive a continuous gesture (a stir/scrub) with escalating
 * travel when its phase gate fails, until the game's state signal advances or a budget is spent.
 * Pure orchestration over an injected driver, so the whole contract is unit-tested without Unity.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  dispatchConditionWithGestureRecovery,
  isContinuousGesture,
  preservesPendingGesture,
} from "../capabilities/replay/gesture-recovery.js";
import type { Action } from "../capabilities/replay/types.js";
import type { DispatchResult } from "../capabilities/replay/driver.js";

const GATE: Extract<Action, { do: "wait-for-condition" }> = {
  do: "wait-for-condition", locator: { path: "/Canvas/GM" }, component: "GM", property_path: "phase", operator: "equals", expected: "Cook",
};
const STIR: Action = { do: "drag", from: { path: "/Canvas/MixPanel/MixZone" }, to: { path: "/Canvas/MixPanel/MixZone" }, travelPx: 1000, travelRefHeight: 720 };
const TAP: Action = { do: "tap", locator: { path: "/Canvas/Button" } };

/** A fake driver that fails the gate until `passAfterRedrives` re-drives have happened, then passes.
 *  Records every dispatched action so a test can assert the re-drive escalation. */
function fakeDriver(passAfterRedrives: number) {
  const dispatched: Action[] = [];
  let redrives = 0;
  return {
    dispatched,
    driver: {
      async dispatch(action: Action): Promise<DispatchResult> {
        dispatched.push(action);
        if (action.do === "drag") { redrives += 1; return { ok: true }; }
        if (action.do === "wait-for-condition") {
          return redrives >= passAfterRedrives ? { ok: true } : { ok: false, detail: `phase=Stir (want Cook)` };
        }
        return { ok: true };
      },
    },
  };
}

test("isContinuousGesture: a travelPx drag yes; a tap or a travel-less drag no", () => {
  assert.equal(isContinuousGesture(STIR), true);
  assert.equal(isContinuousGesture(TAP), false);
  assert.equal(isContinuousGesture({ do: "drag", from: { path: "/a" }, to: { path: "/b" } }), false); // position drag, no travel
  assert.equal(isContinuousGesture(undefined), false);
});

test("preservesPendingGesture (adjacency): only the waits keep a gesture re-drivable; any discrete input clears it", () => {
  // All three waits sit between a gesture and the gate it advances → they preserve.
  assert.equal(preservesPendingGesture({ do: "wait-for-visible", locator: { path: "/x" } } as Action), true);
  assert.equal(preservesPendingGesture({ do: "wait", durationMs: 100 } as Action), true);
  assert.equal(preservesPendingGesture(GATE), true);
  // A discrete input between a gesture and a gate means THAT input advances the gate → clears (default-deny).
  assert.equal(preservesPendingGesture(TAP), false);
  assert.equal(preservesPendingGesture({ do: "key-tap", key: "Space" } as unknown as Action), false);
  assert.equal(preservesPendingGesture(STIR), false); // a gesture itself isn't a preserver (the caller arms on it)
  assert.equal(preservesPendingGesture({ do: "drag", from: { path: "/a" }, to: { path: "/b" } }), false); // position drag
});

test("a BLOCKED first gate (capability/harness fault) is NEVER recovered — returned as-is, no re-drive", async () => {
  const dispatched: Action[] = [];
  const driver = {
    async dispatch(action: Action): Promise<DispatchResult> {
      dispatched.push(action);
      if (action.do === "wait-for-condition") return { ok: false, blocked: true, detail: "capability missing" };
      return { ok: true };
    },
  };
  const res = await dispatchConditionWithGestureRecovery(driver, GATE, STIR);
  assert.equal(res.ok, false);
  assert.equal(res.blocked, true);
  assert.deepEqual(dispatched.map((a) => a.do), ["wait-for-condition"]); // a harness fault is not brute-forced
});

test("escalated travel is BOUNDED to maxTravelMultiple × recorded — never brute-forces past the cap", async () => {
  const f = fakeDriver(99); // never passes
  const travels: number[] = [];
  await dispatchConditionWithGestureRecovery(f.driver, GATE, STIR, {
    maxAttempts: 10, travelEscalation: 1.5, maxTravelMultiple: 2.5,
    onRetry: (_a, t) => travels.push(t),
  });
  const cap = STIR.travelPx! * 2.5; // 2500
  assert.ok(travels.every((t) => t <= cap + 1e-6), `every escalated travel ≤ ${cap}: ${travels}`);
  assert.ok(Math.max(...travels) >= cap - 1e-6, "it does reach the cap before giving up");
  // It stops once the cap is hit (a further attempt would add no scrub) — far fewer than maxAttempts:10.
  const redrives = f.dispatched.filter((a) => a.do === "drag").length;
  assert.ok(redrives <= 3, `bounded re-drives, not 10: ${redrives}`);
});

test("gate passes on the first try → exactly one dispatch, no re-drive (strict superset of old behavior)", async () => {
  const f = fakeDriver(0); // passes immediately
  const res = await dispatchConditionWithGestureRecovery(f.driver, GATE, STIR);
  assert.equal(res.ok, true);
  assert.deepEqual(f.dispatched.map((a) => a.do), ["wait-for-condition"]); // no gesture re-drive
});

test("gate fails but there is NO continuous gesture to retry → returns the failure, no re-drive", async () => {
  const f = fakeDriver(99); // never passes
  const res = await dispatchConditionWithGestureRecovery(f.driver, GATE, TAP); // last gesture was a tap
  assert.equal(res.ok, false);
  assert.deepEqual(f.dispatched.map((a) => a.do), ["wait-for-condition"]); // tap is not re-drivable
});

test("gate fails then PASSES after re-driving the gesture → ok; travel ESCALATES each attempt", async () => {
  const f = fakeDriver(2); // passes once 2 re-drives have happened
  const travels: number[] = [];
  const res = await dispatchConditionWithGestureRecovery(f.driver, GATE, STIR, {
    onRetry: (_attempt, travelPx) => travels.push(travelPx),
  });
  assert.equal(res.ok, true);
  // first gate (fail) → redrive#1 + recheck (fail) → redrive#2 + recheck (pass)
  assert.deepEqual(f.dispatched.map((a) => a.do), ["wait-for-condition", "drag", "wait-for-condition", "drag", "wait-for-condition"]);
  // escalation: 1000*1.6=1600, *1.6=2560 — strictly increasing scrub.
  assert.equal(travels.length, 2);
  assert.ok(travels[1] > travels[0] && travels[0] > STIR.travelPx!);
  const redriveTravels = f.dispatched.filter((a) => a.do === "drag").map((a) => (a as { travelPx?: number }).travelPx);
  assert.deepEqual(redriveTravels, travels);
});

test("gate never passes within the budget → returns the LAST failure (honest, never a fabricated pass)", async () => {
  const f = fakeDriver(99); // never passes
  const res = await dispatchConditionWithGestureRecovery(f.driver, GATE, STIR, { maxAttempts: 3 });
  assert.equal(res.ok, false);
  // 1 initial gate + 3 (redrive + recheck) attempts = 1 + 3 gates + 3 drags.
  assert.equal(f.dispatched.filter((a) => a.do === "drag").length, 3);
  assert.equal(f.dispatched.filter((a) => a.do === "wait-for-condition").length, 4);
});

test("re-check uses the shorter recheck timeout (a stuck run doesn't wait the full gate timeout each attempt)", async () => {
  const timeouts: (number | undefined)[] = [];
  const driver = {
    async dispatch(action: Action): Promise<DispatchResult> {
      if (action.do === "wait-for-condition") { timeouts.push(action.timeoutMs); return { ok: false, detail: "stuck" }; }
      return { ok: true };
    },
  };
  await dispatchConditionWithGestureRecovery(driver, { ...GATE, timeoutMs: 8000 }, STIR, { maxAttempts: 2, recheckTimeoutMs: 1500 });
  // first dispatch keeps the gate's own timeout; the 2 re-checks use the short recheck timeout.
  assert.deepEqual(timeouts, [8000, 1500, 1500]);
});
