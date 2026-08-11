/**
 * Closed-loop adaptive gesture replay — re-drive a continuous gesture (a stir/scrub) with escalating
 * travel when the wait that follows it fails, until the game advances or a budget is spent.
 * Pure orchestration over an injected driver, so the whole contract is unit-tested without Unity.
 *
 * The last block drives the REAL `replay()` engine against a modelled game, because the bug this
 * covers was not in the recovery helper at all: it was that the engine only ever ROUTED the phase
 * gate through it, while the recorder emits `wait-for-visible` FIRST.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  dispatchWaitWithGestureRecovery,
  isContinuousGesture,
  isRecoverableWait,
  preservesPendingGesture,
} from "../../../../capabilities/replay/gesture-recovery.js";
import { replay } from "../../../../capabilities/replay/index.js";
import type { Action, Anchor, ReplayTrace } from "../../../../capabilities/replay/types.js";
import type { DispatchResult, ReplayDriver } from "../../../../capabilities/replay/driver.js";

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
  const res = await dispatchWaitWithGestureRecovery(driver, GATE, STIR);
  assert.equal(res.ok, false);
  assert.equal(res.blocked, true);
  assert.deepEqual(dispatched.map((a) => a.do), ["wait-for-condition"]); // a harness fault is not brute-forced
});

test("escalated travel is BOUNDED to maxTravelMultiple × recorded — never brute-forces past the cap", async () => {
  const f = fakeDriver(99); // never passes
  const travels: number[] = [];
  await dispatchWaitWithGestureRecovery(f.driver, GATE, STIR, {
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
  const res = await dispatchWaitWithGestureRecovery(f.driver, GATE, STIR);
  assert.equal(res.ok, true);
  assert.deepEqual(f.dispatched.map((a) => a.do), ["wait-for-condition"]); // no gesture re-drive
});

test("gate fails but there is NO continuous gesture to retry → returns the failure, no re-drive", async () => {
  const f = fakeDriver(99); // never passes
  const res = await dispatchWaitWithGestureRecovery(f.driver, GATE, TAP); // last gesture was a tap
  assert.equal(res.ok, false);
  assert.deepEqual(f.dispatched.map((a) => a.do), ["wait-for-condition"]); // tap is not re-drivable
});

test("gate fails then PASSES after re-driving the gesture → ok; travel ESCALATES each attempt", async () => {
  const f = fakeDriver(2); // passes once 2 re-drives have happened
  const travels: number[] = [];
  const res = await dispatchWaitWithGestureRecovery(f.driver, GATE, STIR, {
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
  const res = await dispatchWaitWithGestureRecovery(f.driver, GATE, STIR, { maxAttempts: 3 });
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
  await dispatchWaitWithGestureRecovery(driver, { ...GATE, timeoutMs: 8000 }, STIR, { maxAttempts: 2, recheckTimeoutMs: 1500 });
  // first dispatch keeps the gate's own timeout; the 2 re-checks use the short recheck timeout.
  assert.deepEqual(timeouts, [8000, 1500, 1500]);
});

// ───────────────── the visibility wait, driven through the REAL engine ─────────────────
//
// REPRODUCTION OF A LIVE FAILURE (StarChef cooking mini-game, human recording, 2026-08).
// At `--speed 1` the replay passed; at `--speed 4` it failed:
//
//   firstDivergence: step 27, action-failed
//     expected: wait-for-visible /Canvas/CookPanel/Ingredient_spray
//     actual:   inactive
//
// The recorded actions around it were: drag MixZone→MixZone (the stir, travelPx 3643) → capture
// step-7 → wait-for-visible Ingredient_spray → wait-for-condition phase == "Cooking". The stir
// under-delivered at 4x, so the game stayed in Mixing and the CookPanel never activated. Gesture
// recovery existed for precisely this, but the engine only routed `wait-for-condition` through it,
// and the recorder emits the VISIBILITY wait one action EARLIER — so the run died before the
// recovery-armed gate was ever reached.
//
// LITMUS (observed, not asserted). Revert the routing in `engine.ts` to the old
// `action.do === "wait-for-condition"` and re-run this file. It fails on the REAL engine path with
// the same divergence the live run reported:
//
//   ✖ REPRODUCTION: an under-reproduced stir recovers at the wait-for-visible and the run PASSES
//     AssertionError [ERR_ASSERTION]: expected a recovered pass, got
//     {"segment":"recorded","step":3,"kind":"action-failed",
//      "expected":"wait-for-visible /Canvas/CookPanel/Ingredient_spray","actual":"inactive"}
//     'fail' !== 'pass'
//   ✖ THE MOAT: a stir that genuinely cannot reach the target still FAILS, with bounded escalation
//     AssertionError [ERR_ASSERTION]: it did try to recover
//
//   ℹ pass 13 / ℹ fail 2
//
// The second failure is the moat's own litmus: with the fix reverted the run still fails (good), but
// it fails for the WRONG reason (recovery never armed), which is exactly what the assertion catches.

const RECORDED_TRAVEL = 3643;
const MIXZONE = "/Canvas/MixPanel/MixZone";
const SPRAY = "/Canvas/CookPanel/Ingredient_spray";

/**
 * A modelled stir game. A dispatched drag deposits `delivery × travelPx` into the game's travel
 * accumulator (a `delivery` below 1 is the under-reproduction that 4x replay causes), and the game
 * advances to Cooking — activating the CookPanel, so `Ingredient_spray` becomes visible — only once
 * the accumulator reaches `threshold`. Everything else on screen is always visible.
 */
function stirGame(opts: { delivery: number; threshold: number }) {
  let delivered = 0;
  const dispatched: Action[] = [];
  const cooking = (): boolean => delivered >= opts.threshold;
  const driver: ReplayDriver = {
    async capabilityCheck() {
      return { supported: true };
    },
    async reset() {
      return { ok: true, tier: "scene-load" };
    },
    async dispatch(action: Action): Promise<DispatchResult> {
      dispatched.push(action);
      if (action.do === "drag") {
        if (typeof action.travelPx === "number") delivered += action.travelPx * opts.delivery;
        return { ok: true };
      }
      if (action.do === "wait-for-visible") {
        // Only the CookPanel's child is gated on the game having advanced.
        if (action.locator.path === SPRAY) return cooking() ? { ok: true } : { ok: false, detail: "inactive" };
        return { ok: true };
      }
      if (action.do === "wait-for-condition") {
        return cooking() ? { ok: true } : { ok: false, detail: 'phase="Mixing"' };
      }
      return { ok: true };
    },
    async waitForAnchor(_anchor: Anchor) {
      return { reached: true };
    },
    async capture(id: string) {
      return { artifact: `${id}.png` };
    },
    async evaluateAssertion() {
      return { pass: true };
    },
    async readConsole() {
      return { errorCount: 0, errors: [] };
    },
  };
  return { driver, dispatched };
}

/** The recorded shape: stir → capture → wait-for-visible (the killer) → phase gate → tap. */
function stirTrace(stir: Action): ReplayTrace {
  return {
    schemaVersion: "0.1",
    id: "chef-stir",
    start: { scene: "Assets/Scenes/StarChef.unity", reset: "scene-load" },
    input: { backend: "ui-events" },
    segments: [
      {
        id: "recorded",
        actions: [
          { do: "wait-for-visible", locator: { path: MIXZONE }, timeoutMs: 4000 },
          stir,
          { do: "capture", id: "step-7", settleMs: 2549 },
          { do: "wait-for-visible", locator: { path: SPRAY }, timeoutMs: 4000 },
          {
            do: "wait-for-condition",
            locator: { path: "/Canvas/ChefGameManager" },
            component: "ChefGameManager",
            property_path: "phase",
            operator: "equals",
            expected: "Cooking",
          },
          { do: "tap", locator: { path: SPRAY } },
        ],
        captures: [{ id: "final", settleMs: 400 }],
      },
    ],
    outcome: { expected: "success" },
  };
}

const RECORDED_STIR: Action = {
  do: "drag",
  from: { path: MIXZONE },
  to: { path: MIXZONE },
  travelPx: RECORDED_TRAVEL,
  travelRefHeight: 1080,
};

/** Every travel a RE-DRIVE dispatched, in order (the trace's own stir is dropped). */
const redriveTravels = (dispatched: Action[]): number[] =>
  dispatched
    .filter((a) => a.do === "drag")
    .map((a) => (a as { travelPx?: number }).travelPx ?? 0)
    .slice(1);

test("isRecoverableWait: both waits the recorder emits around a gesture; nothing else", () => {
  assert.equal(isRecoverableWait(GATE), true);
  assert.equal(isRecoverableWait({ do: "wait-for-visible", locator: { path: SPRAY } }), true);
  assert.equal(isRecoverableWait({ do: "wait", durationMs: 100 }), false);
  assert.equal(isRecoverableWait(TAP), false);
  assert.equal(isRecoverableWait(STIR), false);
});

test("a failed wait-for-visible re-checks on the SHORT timeout and sheds the human's pacing floor", async () => {
  const seen: { timeoutMs?: number; minDelayMs?: number }[] = [];
  const driver = {
    async dispatch(action: Action): Promise<DispatchResult> {
      if (action.do === "wait-for-visible") {
        seen.push({ timeoutMs: action.timeoutMs, minDelayMs: action.minDelayMs });
        return { ok: false, detail: "inactive" };
      }
      return { ok: true };
    },
  };
  await dispatchWaitWithGestureRecovery(
    driver,
    { do: "wait-for-visible", locator: { path: SPRAY }, timeoutMs: 4000, minDelayMs: 900 },
    STIR,
    { maxAttempts: 2, recheckTimeoutMs: 1500 },
  );
  assert.deepEqual(seen, [
    { timeoutMs: 4000, minDelayMs: 900 }, // the first dispatch is the recorded wait, verbatim
    { timeoutMs: 1500, minDelayMs: undefined },
    { timeoutMs: 1500, minDelayMs: undefined },
  ]);
});

test("REPRODUCTION: an under-reproduced stir recovers at the wait-for-visible and the run PASSES", async () => {
  // 40% of the recorded travel lands (the 4x-speed under-delivery); the game needs ~99% of it.
  const game = stirGame({ delivery: 0.4, threshold: RECORDED_TRAVEL * 0.99 });
  const report = await replay(stirTrace(RECORDED_STIR), game.driver);

  assert.equal(report.status, "pass", `expected a recovered pass, got ${JSON.stringify(report.firstDivergence)}`);
  assert.equal(report.firstDivergence, undefined);
  // It really did recover AT the visibility wait: the wait was re-checked after a re-drive.
  const waits = game.dispatched.filter((a) => a.do === "wait-for-visible" && a.locator.path === SPRAY);
  assert.ok(waits.length >= 2, `the visibility wait was re-checked: ${waits.length} dispatch(es)`);
  assert.ok(redriveTravels(game.dispatched).length >= 1, "the stir was re-driven");
});

test("THE MOAT: a stir that genuinely cannot reach the target still FAILS, with bounded escalation", async () => {
  // The game needs 100× the recorded travel: no faithful re-drive can ever get there, so the run
  // must fail honestly rather than be brute-forced green.
  const game = stirGame({ delivery: 0.4, threshold: RECORDED_TRAVEL * 100 });
  const report = await replay(stirTrace(RECORDED_STIR), game.driver);

  assert.equal(report.status, "fail");
  assert.deepEqual(report.firstDivergence, {
    segment: "recorded",
    step: 3,
    kind: "action-failed",
    expected: `wait-for-visible ${SPRAY}`,
    actual: "inactive",
  });
  // Bounded: every escalated travel is inside the 2.5× cap on the RECORDED travel, and the number of
  // re-drives is small. This cap is what stops recovery laundering a real regression into a pass.
  const travels = redriveTravels(game.dispatched);
  const cap = RECORDED_TRAVEL * 2.5;
  assert.ok(travels.length > 0, "it did try to recover");
  assert.ok(travels.every((t) => t <= cap + 1e-6), `every escalated travel ≤ ${cap}: ${travels}`);
  assert.ok(travels.length <= 4, `bounded re-drives: ${travels.length}`);
  // The tap after the wait never ran — the run halted at the divergence.
  assert.equal(game.dispatched.filter((a) => a.do === "tap").length, 0);
  assert.equal(report.segments[0].status, "fail");
});

test("THE MOAT: a wait-for-visible after a TRAVEL-LESS drag is dispatched exactly once (no re-drive)", async () => {
  // A plain A→B drag has no travel to escalate, so there is nothing to recover — the failure is the
  // game's, and it is reported as-is. This is the strict-superset guarantee for existing traces.
  const positionDrag: Action = { do: "drag", from: { path: MIXZONE }, to: { path: MIXZONE } };
  const game = stirGame({ delivery: 0.4, threshold: 1 });
  const report = await replay(stirTrace(positionDrag), game.driver);

  assert.equal(report.status, "fail");
  assert.equal(report.firstDivergence?.expected, `wait-for-visible ${SPRAY}`);
  assert.equal(
    game.dispatched.filter((a) => a.do === "wait-for-visible" && a.locator.path === SPRAY).length,
    1,
  );
  assert.equal(redriveTravels(game.dispatched).length, 0);
});

test("THE MOAT: a TAP between the stir and the wait clears the gesture — a broken tap can't be laundered", async () => {
  const game = stirGame({ delivery: 0.4, threshold: RECORDED_TRAVEL * 0.99 });
  const trace = stirTrace(RECORDED_STIR);
  // The human tapped a button between the stir and the wait ⇒ THAT tap is what should have advanced
  // the game. Re-driving the stale stir would mask a broken tap transition, so recovery must not arm.
  trace.segments[0].actions.splice(3, 0, { do: "tap", locator: { path: "/Canvas/DoneButton" } });
  const report = await replay(trace, game.driver);

  assert.equal(report.status, "fail");
  assert.equal(report.firstDivergence?.expected, `wait-for-visible ${SPRAY}`);
  assert.equal(redriveTravels(game.dispatched).length, 0, "no re-drive of the stale stir");
});
