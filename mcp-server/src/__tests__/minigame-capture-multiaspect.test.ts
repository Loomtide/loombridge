/**
 * Multi-aspect capture restructure (Phase 3): the device loop is the OUTERMOST level —
 * the trace is RE-DRIVEN once per device (size set BEFORE the drive while stopped, never
 * resized mid-play). These tests cover the pure-ish drive bookkeeping against a FAKE
 * driver (no live bridge): per-device vs base-only artifact decisions, flow/response
 * staying base-only, checkpoint indexing, and the run-wide id resolution feeding every
 * per-device dump. The live wiring (UnityClient, set_game_view_size ordering, restore) is
 * exercised by hand against a running editor.
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildScaffoldContract } from "../loomtide/minigame-scaffold.js";
import {
  driveDeviceOnce,
  indexCheckpoints,
  type CaptureDriver,
  type DriveAccumulators,
} from "../loomtide/minigame-capture.js";
import { planCaptureFromTrace } from "../loomtide/minigame-capture-plan.js";
import type { DeviceSpec, MinigameContract } from "../loomtide/minigame-profiles/types.js";
import type { Action, ReplayTrace } from "../loomtide/replay/types.js";

const tap = (p: string): Action => ({ do: "tap", locator: { path: p } });
const wait = (p: string): Action => ({ do: "wait-for-visible", locator: { path: p } });

function trace(actions: Action[]): ReplayTrace {
  return {
    schemaVersion: "0.1",
    id: "g-happy-path",
    start: { scene: "Assets/Scenes/G.unity", reset: "scene-load" },
    input: { backend: "ui-events" },
    segments: actions.map((a, i) => ({ id: `step-${i + 1}`, actions: [a] })),
    outcome: { expected: "success" },
  };
}

interface FakeState {
  resets: number;
  shots: string[];
  consoleReads: number;
  dumps: number;
  reachedChecks: number;
}

/** A fake driver that records its call counts and writes a real .png so base copyFile works. */
function fakeDriver(
  capturesDir: string,
  opts: { reached?: boolean; actual?: string } = {},
): { driver: CaptureDriver; state: FakeState } {
  const state: FakeState = { resets: 0, shots: [], consoleReads: 0, dumps: 0, reachedChecks: 0 };
  const driver: CaptureDriver = {
    async capabilityCheck() {
      return { supported: true };
    },
    async reset() {
      state.resets += 1;
      return { ok: true };
    },
    async dispatch(action: Action) {
      // A uGUI tap carries verbatim actuation evidence; everything else does not.
      if (action.do === "tap") {
        return { ok: true, raw: { actuated: true, handlerTarget: action.locator.path } };
      }
      return { ok: true };
    },
    async confirmReached() {
      state.reachedChecks += 1;
      return opts.reached === false
        ? { reached: false, actual: opts.actual }
        : { reached: true };
    },
    async capture(id: string) {
      state.shots.push(id);
      const artifact = path.join(capturesDir, `${id}.png`);
      await fs.mkdir(path.dirname(artifact), { recursive: true });
      await fs.writeFile(artifact, `png:${id}`);
      return { artifact };
    },
    async dumpScreenRects() {
      state.dumps += 1;
      // A single object so the run-wide id map + per-device rects have content.
      return {
        viewport: { width: 1, height: 1, aspect: 1 },
        objects: [{ locator: { path: "/HUD/Question" }, role: "text", active: true, isVisible: true }],
      };
    },
    async readConsole() {
      state.consoleReads += 1;
      return { errorCount: 0, errors: [] };
    },
  };
  return { driver, state };
}

function freshAcc(): DriveAccumulators {
  return { rawByState: new Map(), consoleByState: new Map(), captured: [], notReached: [], partial: [], transitions: [] };
}

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "lt-multiaspect-"));
}

const DEVICES: DeviceSpec[] = [
  { id: "base-9x16", label: "9:16", width: 720, height: 1280 },
  { id: "iphone-9x195", label: "iPhone", width: 1179, height: 2556 },
];

test("indexCheckpoints buckets the plan triggers by drive position", () => {
  const contract = buildScaffoldContract("g");
  const t = trace([
    wait("/HUD/StartScreen/StartButton"),
    tap("/HUD/StartScreen/StartButton"), // 1: first tap → active anchor
    tap("/HUD/AnswerButton0"), // 2
    tap("/HUD/HomeButton"), // 3: home tap
  ]);
  const plan = planCaptureFromTrace(contract, t);
  const idx = indexCheckpoints(plan);
  // start → initial; home_back → after the home tap (index 3); success_reward → before it.
  assert.equal(idx.initial.length, 1);
  assert.equal(idx.initial[0].stateId, "start");
  assert.equal(idx.after.get(1)?.[0].stateId, "active");
  assert.equal(idx.before.get(3)?.[0].stateId, "success_reward");
  assert.equal(idx.after.get(3)?.[0].stateId, "home_back");
});

test("BASE drive: writes legacy <state> artifacts + flow transitions + console + response", async () => {
  const dir = await tmpDir();
  const contract = buildScaffoldContract("g");
  const t = trace([
    wait("/HUD/StartScreen/StartButton"),
    tap("/HUD/StartScreen/StartButton"), // active anchor
    tap("/HUD/AnswerButton0"), // gameplay tap → input-response stimulus
    tap("/HUD/HomeButton"), // home tap
  ]);
  const plan = planCaptureFromTrace(contract, t);
  const idx = indexCheckpoints(plan);
  const { driver } = fakeDriver(dir);
  const acc = freshAcc();

  const out = await driveDeviceOnce(driver, contract, t, plan, idx, dir, 0, DEVICES[0], true, acc);
  assert.deepEqual(out, { ok: true });

  // Logical states captured in drive order (base populates `captured`).
  assert.deepEqual(acc.captured, ["start", "active", "success_reward", "home_back"]);
  // Console read once per LOGICAL state (device-invariant).
  assert.equal(acc.consoleByState.size, 4);
  // Transitions recorded between captured states (base only).
  assert.equal(acc.transitions.length, 3);
  assert.deepEqual(
    acc.transitions.map((tr) => `${tr.from}->${tr.to}`),
    ["start->active", "active->success_reward", "success_reward->home_back"],
  );
  // Base populates BOTH the per-device key AND the legacy `<state>` mirror.
  assert.ok(acc.rawByState.has("start"), "legacy <state> rects key present on base");
  assert.ok(acc.rawByState.has(`start@${DEVICES[0].id}`), "per-device key present");
  // The legacy `<state>.png` is copied from the base device's frame.
  await assert.doesNotReject(fs.access(path.join(dir, "start.png")));
  // input-response before/after dumps captured on base (a gameplay tap exists).
  assert.ok(acc.respBefore, "respBefore captured on base");
  assert.ok(acc.respAfter, "respAfter captured on base");

  await fs.rm(dir, { recursive: true, force: true });
});

test("NON-BASE drive: writes ONLY per-device rects — no legacy mirror, no flow/console/response", async () => {
  const dir = await tmpDir();
  const contract = buildScaffoldContract("g");
  const t = trace([
    wait("/HUD/StartScreen/StartButton"),
    tap("/HUD/StartScreen/StartButton"),
    tap("/HUD/AnswerButton0"),
    tap("/HUD/HomeButton"),
  ]);
  const plan = planCaptureFromTrace(contract, t);
  const idx = indexCheckpoints(plan);
  const { driver } = fakeDriver(dir);
  const acc = freshAcc();
  const device = DEVICES[1];

  const out = await driveDeviceOnce(driver, contract, t, plan, idx, dir, 0, device, false, acc);
  assert.deepEqual(out, { ok: true });

  // Non-base does NOT touch the device-invariant bookkeeping.
  assert.deepEqual(acc.captured, [], "captured stays empty (base owns it)");
  assert.equal(acc.transitions.length, 0, "no flow transitions on non-base");
  assert.equal(acc.consoleByState.size, 0, "no console reads on non-base");
  assert.equal(acc.respBefore, undefined, "no response on non-base");
  assert.equal(acc.respAfter, undefined, "no response on non-base");
  // It DOES write the per-device rects keys (one per captured state).
  assert.ok(acc.rawByState.has(`start@${device.id}`));
  assert.ok(acc.rawByState.has(`home_back@${device.id}`));
  // …and NEVER the legacy `<state>` mirror keys.
  assert.equal(acc.rawByState.has("start"), false, "non-base must not write the legacy mirror key");
  // No legacy `<state>.png` from a non-base drive.
  await assert.rejects(fs.access(path.join(dir, "start.png")));

  await fs.rm(dir, { recursive: true, force: true });
});

test("device-loop shape: base + non-base together yield per-device keys for EVERY device + the base mirror", async () => {
  const dir = await tmpDir();
  const contract = buildScaffoldContract("g");
  const t = trace([
    wait("/HUD/StartScreen/StartButton"),
    tap("/HUD/StartScreen/StartButton"),
    tap("/HUD/AnswerButton0"),
  ]);
  const plan = planCaptureFromTrace(contract, t);
  const idx = indexCheckpoints(plan);
  const { driver, state } = fakeDriver(dir);
  const acc = freshAcc();

  // Simulate the outer device loop: base first, then each non-base, sharing the accumulators.
  for (const [di, device] of DEVICES.entries()) {
    const out = await driveDeviceOnce(driver, contract, t, plan, idx, dir, 0, device, di === 0, acc);
    assert.deepEqual(out, { ok: true });
  }

  // Re-driving per device means one play-mode entry (reset) per device.
  assert.equal(state.resets, DEVICES.length, "the trace is re-driven once per device");

  // Every captured state has a per-device dump for EVERY device.
  for (const stateId of acc.captured) {
    for (const device of DEVICES) {
      assert.ok(acc.rawByState.has(`${stateId}@${device.id}`), `${stateId}@${device.id} present`);
    }
    // …plus the single legacy mirror (base only).
    assert.ok(acc.rawByState.has(stateId), `${stateId} legacy mirror present`);
  }
  // Flow/console captured ONCE despite N drives (base only).
  assert.equal(acc.transitions.length, acc.captured.length - 1);
  assert.equal(acc.consoleByState.size, acc.captured.length);

  await fs.rm(dir, { recursive: true, force: true });
});

test("a blocked reset returns { blocked } without mutating the accumulators", async () => {
  const dir = await tmpDir();
  const contract = buildScaffoldContract("g");
  const t = trace([wait("/HUD/StartScreen/StartButton"), tap("/HUD/StartScreen/StartButton")]);
  const plan = planCaptureFromTrace(contract, t);
  const idx = indexCheckpoints(plan);
  const acc = freshAcc();
  const driver: CaptureDriver = {
    async capabilityCheck() { return { supported: true }; },
    async reset() { return { ok: false, reason: "reset-unavailable" }; },
    async dispatch() { return { ok: true }; },
    async confirmReached() { return { reached: true }; },
    async capture() { return {}; },
    async dumpScreenRects() { return {}; },
    async readConsole() { return { errorCount: 0, errors: [] }; },
  };

  const out = await driveDeviceOnce(driver, contract, t, plan, idx, dir, 0, DEVICES[0], true, acc);
  assert.deepEqual(out, { blocked: "reset-unavailable" });
  assert.deepEqual(acc.captured, []);
  assert.equal(acc.rawByState.size, 0);

  await fs.rm(dir, { recursive: true, force: true });
});

test("a missing screenshot is refused loudly (no silent rects-only pack)", async () => {
  const dir = await tmpDir();
  const contract = buildScaffoldContract("g");
  const t = trace([wait("/HUD/StartScreen/StartButton"), tap("/HUD/StartScreen/StartButton")]);
  const plan = planCaptureFromTrace(contract, t);
  const idx = indexCheckpoints(plan);
  const acc = freshAcc();
  const driver: CaptureDriver = {
    async capabilityCheck() { return { supported: true }; },
    async reset() { return { ok: true }; },
    async dispatch() { return { ok: true }; },
    async confirmReached() { return { reached: true }; },
    async capture() { return {}; }, // no artifact → must throw
    async dumpScreenRects() { return { objects: [] }; },
    async readConsole() { return { errorCount: 0, errors: [] }; },
  };

  await assert.rejects(
    () => driveDeviceOnce(driver, contract, t, plan, idx, dir, 0, DEVICES[0], true, acc),
    /screenshot was not written/,
  );

  await fs.rm(dir, { recursive: true, force: true });
});

test("phase-gated capture: reached=true captures the state and writes artifacts", async () => {
  const dir = await tmpDir();
  const contract = buildScaffoldContract("g");
  const start = contract.states.find((s) => s.id === "start")!;
  contract.states = [start];
  contract.interactionFlow = { happyPath: ["start"] };
  start.reached = {
    locator: "G:/Canvas/GameManager",
    component: "GameManager",
    property_path: "phase",
    operator: "equals",
    expected: "Start",
  };
  const t = trace([tap("/HUD/StartScreen/StartButton")]);
  const plan = planCaptureFromTrace(contract, t);
  const idx = indexCheckpoints(plan);
  const { driver, state } = fakeDriver(dir, { reached: true });
  const acc = freshAcc();

  const out = await driveDeviceOnce(driver, contract, t, plan, idx, dir, 0, DEVICES[0], true, acc);
  assert.deepEqual(out, { ok: true });
  assert.equal(state.reachedChecks, 1);
  assert.ok(state.shots.includes(`start@${DEVICES[0].id}`));
  assert.ok(acc.captured.includes("start"));
  assert.deepEqual(acc.notReached, []);
  await assert.doesNotReject(fs.access(path.join(dir, "start.png")));

  await fs.rm(dir, { recursive: true, force: true });
});

test("phase-gated capture: reached=false produces no artifacts and records notReached", async () => {
  const dir = await tmpDir();
  const contract = buildScaffoldContract("g");
  const start = contract.states.find((s) => s.id === "start")!;
  contract.states = [start];
  contract.interactionFlow = { happyPath: ["start"] };
  start.reached = {
    locator: "G:/Canvas/GameManager",
    component: "GameManager",
    property_path: "phase",
    operator: "equals",
    expected: "Start",
    timeoutMs: 10,
  };
  const t = trace([tap("/HUD/StartScreen/StartButton")]);
  const plan = planCaptureFromTrace(contract, t);
  const idx = indexCheckpoints(plan);
  const { driver, state } = fakeDriver(dir, { reached: false, actual: "Stir" });
  const acc = freshAcc();

  const out = await driveDeviceOnce(driver, contract, t, plan, idx, dir, 0, DEVICES[0], true, acc);
  assert.deepEqual(out, { ok: true });
  assert.equal(state.reachedChecks, 1);
  assert.equal(state.shots.includes(`start@${DEVICES[0].id}`), false, "capture() must not be called for the not-reached state");
  assert.equal(state.dumps, 0, "no rect dump for a not-reached state");
  assert.deepEqual(acc.captured, []);
  assert.equal(acc.notReached.length, 1);
  assert.equal(acc.notReached[0].stateId, "start");
  assert.match(acc.notReached[0].reason, /never reached this screen/);
  await assert.rejects(fs.access(path.join(dir, "start.png")));
  await assert.rejects(fs.access(path.join(dir, `start@${DEVICES[0].id}.png`)));

  await fs.rm(dir, { recursive: true, force: true });
});

// ── visibility-windowed capture (slice 2): pick the MOMENT by requiredInFrame visibility ─────

const drag = (from: string, to: string): Action => ({ do: "drag", from: { path: from }, to: { path: to } });
const wcond = (expected: string): Action => ({
  do: "wait-for-condition",
  locator: { path: "/Canvas/GM" },
  component: "GM",
  property_path: "phase",
  operator: "equals",
  expected,
});

/** A single-active-screen contract whose `decorate` window spans two gated gestures, and whose
 *  `doneButton` only appears after the FIRST topping (mid-window). */
function decorateContract(): MinigameContract {
  const base = buildScaffoldContract("g");
  return {
    ...base,
    requiredInFrame: [
      { id: "topping", locator: "/Canvas/DecorPanel/Topping", description: "" },
      { id: "doneButton", locator: "/Canvas/DecorPanel/DoneButton", description: "" },
    ],
    states: [
      { id: "decorate", kind: "active", scene: base.scenes[0], requiredInFrame: ["topping", "doneButton"], description: "" },
      { id: "success_reward", kind: "success_reward", scene: base.scenes[0], requiredInFrame: ["topping"], description: "" },
    ],
    interactionFlow: { happyPath: ["decorate", "success_reward"] },
  } as MinigameContract;
}

/**
 * A fake driver whose object visibility depends on how many gestures have been dispatched
 * (`visibleFromStep`): an object becomes visible once `dispatched >= its from-step`. This models
 * decorate's doneButton appearing only after the first topping is placed. The window scan probes
 * BEFORE each dispatch, so at the start of iteration `i` `dispatched === i`.
 */
function steppedDriver(
  capturesDir: string,
  objects: Array<{ path: string; visibleFromStep: number }>,
): { driver: CaptureDriver; state: { dispatched: number; shots: string[] } } {
  const st = { dispatched: 0, shots: [] as string[] };
  const driver: CaptureDriver = {
    async capabilityCheck() { return { supported: true }; },
    async reset() { st.dispatched = 0; return { ok: true }; },
    async dispatch() { st.dispatched += 1; return { ok: true }; },
    async confirmReached() { return { reached: true }; },
    async capture(id: string) {
      st.shots.push(id);
      const artifact = path.join(capturesDir, `${id}.png`);
      await fs.mkdir(path.dirname(artifact), { recursive: true });
      await fs.writeFile(artifact, `png:${id}`);
      return { artifact };
    },
    async dumpScreenRects() {
      return {
        viewport: { width: 1, height: 1, aspect: 1 },
        objects: objects.map((o) => ({
          locator: { path: o.path },
          role: "container",
          active: true,
          isVisible: st.dispatched >= o.visibleFromStep,
        })),
      };
    },
    async readConsole() { return { errorCount: 0, errors: [] }; },
  };
  return { driver, state: st };
}

test("window state is captured at the FIRST step where all requiredInFrame objects are co-visible", async () => {
  const dir = await tmpDir();
  const contract = decorateContract();
  // gate, topping-drag (step→1), gate, done-drag (step→2): window = [1, 3].
  const t = trace([
    wcond("Decor"),                                        // 0
    drag("/Canvas/DecorPanel/Topping", "/Canvas/DecorPanel/Plate"), // 1
    wcond("Decor"),                                        // 2
    drag("/Canvas/DecorPanel/Topping", "/Canvas/DecorPanel/Plate"), // 3
  ]);
  const plan = planCaptureFromTrace(contract, t);
  const decorate = plan.states.find((s) => s.stateId === "decorate")!;
  assert.deepEqual(decorate.trigger, { kind: "window", start: 1, end: 3 });
  const idx = indexCheckpoints(plan);
  // topping is visible from the start; doneButton only appears after the first topping (step 1) is
  // placed — i.e. dispatched >= 1, which holds at the start of iteration i=1 onward... wait: the
  // scan at i=1 runs BEFORE that dispatch, so dispatched===1 already (gate dispatched at i=0).
  // Model doneButton appearing only after the topping drag at i=1 → visibleFromStep 2.
  const { driver, state } = steppedDriver(dir, [
    { path: "/Canvas/DecorPanel/Topping", visibleFromStep: 0 },
    { path: "/Canvas/DecorPanel/DoneButton", visibleFromStep: 2 },
  ]);
  const acc = freshAcc();

  const out = await driveDeviceOnce(driver, contract, t, plan, idx, dir, 0, DEVICES[0], true, acc);
  assert.deepEqual(out, { ok: true });
  // Captured exactly once, at i=2 (the first window step where dispatched>=2 → doneButton visible).
  assert.ok(acc.captured.includes("decorate"));
  assert.equal(state.shots.filter((s) => s.startsWith("decorate@")).length, 1, "captured once");
  assert.deepEqual(acc.partial, [], "all required co-visible → not partial");

  await fs.rm(dir, { recursive: true, force: true });
});

test("window state with a NEVER-co-visible required object lands in notReached, NOT captured (no zero-required mislabel)", async () => {
  const dir = await tmpDir();
  const contract = decorateContract();
  const t = trace([
    wcond("Decor"),                                        // 0
    drag("/Canvas/DecorPanel/Topping", "/Canvas/DecorPanel/Plate"), // 1
    wcond("Decor"),                                        // 2
    drag("/Canvas/DecorPanel/Topping", "/Canvas/DecorPanel/Plate"), // 3
  ]);
  const plan = planCaptureFromTrace(contract, t);
  const idx = indexCheckpoints(plan);
  // NEITHER required object is ever visible during the window → zero-required at the last step.
  const { driver, state } = steppedDriver(dir, [
    { path: "/Canvas/DecorPanel/Topping", visibleFromStep: 999 },
    { path: "/Canvas/DecorPanel/DoneButton", visibleFromStep: 999 },
  ]);
  const acc = freshAcc();

  const out = await driveDeviceOnce(driver, contract, t, plan, idx, dir, 0, DEVICES[0], true, acc);
  assert.deepEqual(out, { ok: true });
  // Never captured (never screenshot a zero-required frame), surfaced honestly in notReached.
  assert.equal(state.shots.filter((s) => s.startsWith("decorate@")).length, 0, "never captured");
  assert.ok(!acc.captured.includes("decorate"));
  const nr = acc.notReached.find((n) => n.stateId === "decorate");
  assert.ok(nr, "decorate surfaced in notReached");
  assert.match(nr!.reason, /never showed this screen/);
  assert.deepEqual(acc.partial, []);

  await fs.rm(dir, { recursive: true, force: true });
});

test("window state with only SOME required ever co-visible → best-effort capture + a partial note", async () => {
  const dir = await tmpDir();
  const contract = decorateContract();
  const t = trace([
    wcond("Decor"),                                        // 0
    drag("/Canvas/DecorPanel/Topping", "/Canvas/DecorPanel/Plate"), // 1
    wcond("Decor"),                                        // 2
    drag("/Canvas/DecorPanel/Topping", "/Canvas/DecorPanel/Plate"), // 3
  ]);
  const plan = planCaptureFromTrace(contract, t);
  const idx = indexCheckpoints(plan);
  // topping visible throughout; doneButton NEVER visible → at the last step visible===1 (>=1).
  const { driver, state } = steppedDriver(dir, [
    { path: "/Canvas/DecorPanel/Topping", visibleFromStep: 0 },
    { path: "/Canvas/DecorPanel/DoneButton", visibleFromStep: 999 },
  ]);
  const acc = freshAcc();

  const out = await driveDeviceOnce(driver, contract, t, plan, idx, dir, 0, DEVICES[0], true, acc);
  assert.deepEqual(out, { ok: true });
  // Best-effort: captured (some required visible), with the missing id surfaced via partial.
  assert.ok(acc.captured.includes("decorate"));
  assert.equal(state.shots.filter((s) => s.startsWith("decorate@")).length, 1);
  // doneButton was never visible at ANY window frame here → genuinely missing, not sequential (sequential=[]).
  assert.deepEqual(acc.partial, [{ stateId: "decorate", missing: ["doneButton"], sequential: [] }]);
  // It is NOT mislabeled as notReached (the screen WAS shown).
  assert.equal(acc.notReached.find((n) => n.stateId === "decorate"), undefined);

  await fs.rm(dir, { recursive: true, force: true });
});

test("G9: a later screen STUCK behind an earlier one (only prior-shared chrome visible) → notReached, NOT a mislabeled partial", async () => {
  // Two active screens sharing a persistent `homeBtn`. The replay stalls on screen one (screen two's
  // gesture never reproduces), so at screen two's window only `homeBtn` (shared with the prior screen)
  // is visible. "≥1 required visible" would screenshot the stuck screen-one frame and mislabel it as
  // screen two → false "twoThing off-screen" GAME fails. Distinctive-by-prior-order must mark it notReached.
  const base = buildScaffoldContract("g");
  const contract = {
    ...base,
    requiredInFrame: [
      { id: "homeBtn", locator: "/Canvas/HomeBtn", description: "" },        // persistent chrome (depth-2)
      { id: "oneThing", locator: "/Canvas/OnePanel/Thing", description: "" },
      { id: "twoThing", locator: "/Canvas/TwoPanel/Thing", description: "" },
    ],
    states: [
      { id: "one", kind: "active", scene: base.scenes[0], requiredInFrame: ["oneThing", "homeBtn"], description: "" },
      { id: "two", kind: "active", scene: base.scenes[0], requiredInFrame: ["twoThing", "homeBtn"], description: "" },
      { id: "reward", kind: "success_reward", scene: base.scenes[0], requiredInFrame: ["homeBtn"], description: "" },
    ],
    interactionFlow: { happyPath: ["one", "two", "reward"] },
  } as MinigameContract;
  const dir = await tmpDir();
  const t = trace([
    wcond("One"), drag("/Canvas/OnePanel/Thing", "/Canvas/OnePanel/Zone"), // screen one
    wcond("Two"), drag("/Canvas/TwoPanel/Thing", "/Canvas/TwoPanel/Zone"), // screen two (stalls)
  ]);
  const plan = planCaptureFromTrace(contract, t);
  const idx = indexCheckpoints(plan);
  // Stuck on screen one: homeBtn + oneThing visible throughout; twoThing NEVER appears.
  const { driver } = steppedDriver(dir, [
    { path: "/Canvas/HomeBtn", visibleFromStep: 0 },
    { path: "/Canvas/OnePanel/Thing", visibleFromStep: 0 },
    { path: "/Canvas/TwoPanel/Thing", visibleFromStep: 999 },
  ]);
  const acc = freshAcc();

  const out = await driveDeviceOnce(driver, contract, t, plan, idx, dir, 0, DEVICES[0], true, acc);
  assert.deepEqual(out, { ok: true });
  // 'two' is NOT captured + NOT a partial — only the prior screen's chrome was visible → notReached.
  assert.equal(acc.captured.includes("two"), false);
  assert.equal(acc.partial.find((p) => p.stateId === "two"), undefined);
  const nr = acc.notReached.find((n) => n.stateId === "two");
  assert.ok(nr, "screen two must be notReached, not a mislabeled capture");
  assert.match(nr!.reason, /chrome shared with other screens|never showed/i);

  await fs.rm(dir, { recursive: true, force: true });
});

test("G9: a FINAL (terminal) screen the stalled drive never reached → notReached, not the stuck end-frame mislabeled", async () => {
  // success_reward has no gated gesture → a `final` trigger that screenshots wherever the drive ended.
  // If the replay stalls on an earlier screen, that end frame is NOT the reward screen — capturing it
  // would mislabel it + emit false "rewardThing off-screen". Its distinctive object never appearing
  // must make it notReached, not a captured frame.
  const base = buildScaffoldContract("g");
  const contract = {
    ...base,
    requiredInFrame: [
      { id: "homeBtn", locator: "/Canvas/HomeBtn", description: "" },
      { id: "playThing", locator: "/Canvas/PlayPanel/Thing", description: "" },
      { id: "rewardThing", locator: "/Canvas/RewardGroup/Thing", description: "" }, // reward-only (distinctive)
    ],
    states: [
      { id: "play", kind: "active", scene: base.scenes[0], requiredInFrame: ["playThing", "homeBtn"], description: "" },
      { id: "reward", kind: "success_reward", scene: base.scenes[0], requiredInFrame: ["rewardThing", "homeBtn"], description: "" },
    ],
    interactionFlow: { happyPath: ["play", "reward"] },
  } as MinigameContract;
  const dir = await tmpDir();
  const t = trace([wcond("Play"), drag("/Canvas/PlayPanel/Thing", "/Canvas/PlayPanel/Zone")]); // only screen play; reward = final
  const plan = planCaptureFromTrace(contract, t);
  assert.equal(plan.states.find((s) => s.stateId === "reward")?.trigger.kind, "final", "reward must be a final trigger for this test");
  const idx = indexCheckpoints(plan);
  // Stalled on play: homeBtn + playThing visible; rewardThing (reward's distinctive) NEVER appears.
  const { driver, state } = steppedDriver(dir, [
    { path: "/Canvas/HomeBtn", visibleFromStep: 0 },
    { path: "/Canvas/PlayPanel/Thing", visibleFromStep: 0 },
    { path: "/Canvas/RewardGroup/Thing", visibleFromStep: 999 },
  ]);
  const acc = freshAcc();

  await driveDeviceOnce(driver, contract, t, plan, idx, dir, 0, DEVICES[0], true, acc);
  assert.equal(acc.captured.includes("reward"), false, "the final reward screen was never reached → not captured");
  assert.equal(state.shots.filter((s) => s.startsWith("reward@")).length, 0, "no reward screenshot of a stuck frame");
  assert.ok(acc.notReached.find((n) => n.stateId === "reward"), "reward must be notReached");

  await fs.rm(dir, { recursive: true, force: true });
});
