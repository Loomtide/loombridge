import assert from "node:assert/strict";
import test from "node:test";

import {
  extractClicks,
  observedClicksToTrace,
  observedEdgesToTrace,
  parseTrace,
  replay,
  type Action,
  type Anchor,
  type Assertion,
  type ObservedClick,
  type ReplayDriver,
} from "../capabilities/replay/index.js";
import { captureOutcomes, observeLive } from "../capabilities/replay/observe-live.js";
import type { BridgeResponse } from "../types.js";

const click = (path: string, tMs: number): ObservedClick => ({ tMs, locator: { path }, button: 0 });

/** An all-green driver — enough to prove an observed trace's actions are well-formed. */
function okDriver(): ReplayDriver {
  return {
    async capabilityCheck() {
      return { supported: true };
    },
    async reset() {
      return { ok: true, tier: "scene-load" };
    },
    async dispatch(_action: Action) {
      return { ok: true };
    },
    async waitForAnchor(_anchor: Anchor) {
      return { reached: true };
    },
    async capture(id: string) {
      return { artifact: `${id}.png`, sha256: "x" };
    },
    async evaluateAssertion(_assertion: Assertion) {
      return { pass: true, actual: "true" };
    },
    async readConsole() {
      return { errorCount: 0, errors: [] };
    },
  };
}

function fakeSend(data: unknown): BridgeResponse {
  return { id: "x", status: "success", data, timestamp: 0 } as BridgeResponse;
}

test("observedClicksToTrace: each click → its own step segment (wait-for-visible + tap + capture)", () => {
  const trace = observedClicksToTrace(
    [click("/HUD/StartScreen/StartButton", 120), click("/HUD/Answers/Option2", 1840)],
    { id: "ctf-observed", scene: "Assets/Scenes/CountTheFruits.unity" },
  );
  assert.deepEqual(trace.segments.map((s) => s.id), ["step-1", "step-2"]);
  assert.deepEqual(
    trace.segments[0].actions.map((a) => a.do),
    ["wait-for-visible", "tap"],
  );
  assert.equal(trace.segments[0].captures?.[0].id, "step-1");
  assert.equal(trace.segments[1].captures?.[0].id, "step-2");
});

test("observedClicksToTrace: grafts the observed gap as a capped per-step CAPTURE settle", () => {
  const trace = observedClicksToTrace(
    [click("/A", 0), click("/B", 1500), click("/C", 99999)], // gap 1500ms, then a huge pause
    { id: "x", scene: "S" },
  );
  const settleOf = (seg: number) => trace.segments[seg].captures?.[0].settleMs;
  assert.equal(settleOf(0), 1500, "settles for the dwell on this screen (gap to the next click)");
  assert.equal(settleOf(1), 3000, "a long gap is capped, not literal");
  assert.equal(settleOf(2), 3000, "the last step settles for the final screen (default)");
  // The gap is honored ONCE — as the post-tap settle, not also a pre-tap wait floor:
  const wait = trace.segments[0].actions[0];
  assert.equal(wait.do === "wait-for-visible" ? wait.minDelayMs : "n/a", undefined);
});

test("observedClicksToTrace: produces a trace its own parser accepts (green by construction)", () => {
  const trace = observedClicksToTrace([click("/A", 0)], { id: "x", scene: "S.unity", title: "T", intent: "I" });
  assert.doesNotThrow(() => parseTrace(trace));
  assert.equal(trace.start.reset, "scene-load");
  assert.equal(trace.input.backend, "ui-events");
  assert.equal(trace.title, "T");
  assert.equal(trace.intent, "I");
});

test("observedClicksToTrace: reduces a bridge locator to the stable path only", () => {
  // The live bridge returns instanceId as a NUMBER, a runtime globalObjectId, and
  // the runtime scene NAME — all of which bind the trace to one session / scene
  // name and (for instanceId) trip parseTrace. Only the path survives.
  const bridgeClick = {
    tMs: 10,
    locator: {
      path: "/HUD/StartScreen/StartButton/Label",
      scene: "CountTheFruits",
      instanceId: 12345,
      globalObjectId: "GlobalObjectId(...)",
    },
  } as unknown as ObservedClick;

  const trace = observedClicksToTrace([bridgeClick], { id: "x", scene: "S.unity" });
  const tap = trace.segments[0].actions.find((a) => a.do === "tap")!;
  const locator = "locator" in tap ? tap.locator : undefined;
  assert.deepEqual(locator, { path: "/HUD/StartScreen/StartButton/Label" });
  assert.doesNotThrow(() => parseTrace(trace), "no ephemeral field must reach the parser");
});

test("observedClicksToTrace: two clicks on the SAME locator are preserved as two steps", () => {
  const trace = observedClicksToTrace([click("/A", 0), click("/A", 200)], { id: "x", scene: "S" });
  assert.equal(trace.segments.length, 2);
  assert.deepEqual(
    trace.segments.flatMap((s) => s.actions.map((a) => ("locator" in a ? a.locator.path : a.do))),
    ["/A", "/A", "/A", "/A"],
  );
});

test("observedClicksToTrace: the produced trace replays to PASS through the engine", async () => {
  const trace = observedClicksToTrace([click("/Start", 0), click("/Answer", 900)], {
    id: "x",
    scene: "S.unity",
  });
  const report = await replay(trace, okDriver());
  assert.equal(report.status, "pass");
  assert.equal(report.segments[0].status, "pass");
});

test("replay: each capture's settleMs reaches the driver (screen settles before the shot)", async () => {
  const trace = observedClicksToTrace([click("/A", 0), click("/B", 600)], { id: "x", scene: "S" });
  const seen: Array<number | undefined> = [];
  const driver = okDriver();
  driver.capture = async (id: string, settleMs?: number) => {
    seen.push(settleMs);
    return { artifact: `${id}.png`, sha256: "x" };
  };
  await replay(trace, driver);
  assert.deepEqual(seen, [600, 3000], "step-1 settles for the 600ms gap; the last step uses the default");
});

test("observedClicksToTrace: a world-kind click becomes a world-tap step (no uGUI tap)", () => {
  const trace = observedClicksToTrace(
    [{ tMs: 0, locator: { path: "/Fruits/Apple" }, kind: "world" }],
    { id: "x", scene: "S" },
  );
  assert.deepEqual(trace.segments[0].actions.map((a) => a.do), ["world-tap"]);
  assert.equal(trace.segments[0].captures?.[0].id, "step-1");
});

test("observedClicksToTrace: a drag (click.to) becomes wait-for-visible(from) + drag(from→to)", () => {
  const trace = observedClicksToTrace(
    [{ tMs: 0, locator: { path: "/Canvas/Chip" }, kind: "ui", to: { path: "/Canvas/Zone" } }],
    { id: "x", scene: "S" },
  );
  const actions = trace.segments[0].actions;
  assert.deepEqual(actions.map((a) => a.do), ["wait-for-visible", "drag"]);
  const drag = actions[1];
  assert.equal(drag.do === "drag" ? drag.from.path : "", "/Canvas/Chip");
  assert.equal(drag.do === "drag" ? drag.to.path : "", "/Canvas/Zone");
  // The drop target is reduced to its stable path only (no ephemeral instanceId/scene).
  assert.deepEqual(drag.do === "drag" ? Object.keys(drag.to) : [], ["path"]);
  assert.equal(trace.segments[0].captures?.[0].id, "step-1");
});

test("observedClicksToTrace: a custom-drop drag (travelPx + release point) carries travelPx + releaseNorm", () => {
  const trace = observedClicksToTrace(
    [
      {
        tMs: 0,
        locator: { path: "/Canvas/Bowl" },
        kind: "ui",
        to: { path: "/Canvas/Bowl" },
        travelPx: 4800,
        releaseNx: 0.5,
        releaseNy: 0.25,
      } as ObservedClick,
    ],
    { id: "x", scene: "S" },
  );
  const drag = trace.segments[0].actions.find((a) => a.do === "drag")!;
  assert.equal(drag.do === "drag" ? drag.travelPx : undefined, 4800);
  assert.deepEqual(drag.do === "drag" ? drag.releaseNorm : undefined, { x: 0.5, y: 0.25 });
  assert.equal(drag.do === "drag" ? drag.from.path : "", "/Canvas/Bowl");
  assert.doesNotThrow(() => parseTrace(trace), "custom-drop fields survive the parser");
});

test("observedClicksToTrace: a normal distinct-drop drag (sentinel -1) emits NO travelPx/releaseNorm (regression)", () => {
  const trace = observedClicksToTrace(
    [
      {
        tMs: 0,
        locator: { path: "/Canvas/Chip" },
        kind: "ui",
        to: { path: "/Canvas/Zone" },
        travelPx: 0,
        releaseNx: -1,
        releaseNy: -1,
      } as ObservedClick,
    ],
    { id: "x", scene: "S" },
  );
  const drag = trace.segments[0].actions.find((a) => a.do === "drag")!;
  // Byte-identical to today's drag: only do/from/to keys, no travelPx, no releaseNorm.
  assert.deepEqual(drag, { do: "drag", from: { path: "/Canvas/Chip" }, to: { path: "/Canvas/Zone" } });
});

test("observedEdgesToTrace: a custom-drop drag in the timeline also carries travelPx + releaseNorm", () => {
  const trace = observedEdgesToTrace(
    [
      {
        tMs: 0,
        locator: { path: "/Canvas/Bowl" },
        kind: "ui",
        to: { path: "/Canvas/Bowl" },
        travelPx: 4800,
        releaseNx: 0.5,
        releaseNy: 0.25,
      } as ObservedClick,
    ],
    [],
    { id: "x", scene: "S" },
  );
  const drag = trace.segments[0].actions.find((a) => a.do === "drag")!;
  assert.equal(drag.do === "drag" ? drag.travelPx : undefined, 4800);
  assert.deepEqual(drag.do === "drag" ? drag.releaseNorm : undefined, { x: 0.5, y: 0.25 });
});

test("observedClicksToTrace: a world gesture with a stray `to` stays a world-tap (drags are uGUI-only)", () => {
  const trace = observedClicksToTrace(
    [{ tMs: 0, locator: { path: "/Sprite" }, kind: "world", to: { path: "/Zone" } }],
    { id: "x", scene: "S" },
  );
  assert.deepEqual(trace.segments[0].actions.map((a) => a.do), ["world-tap"]);
});

test("observedClicksToTrace: mixed taps and drags preserve order", () => {
  const trace = observedClicksToTrace(
    [
      click("/A", 0),
      { tMs: 100, locator: { path: "/Chip" }, kind: "ui", to: { path: "/Zone" } },
      click("/B", 200),
    ],
    { id: "x", scene: "S" },
  );
  assert.deepEqual(
    trace.segments.map((s) => s.actions.map((a) => a.do)),
    [["wait-for-visible", "tap"], ["wait-for-visible", "drag"], ["wait-for-visible", "tap"]],
  );
});

test("extractClicks: carries a drag's drop target through", () => {
  const clicks = extractClicks({
    clicks: [{ tMs: 5, locator: { path: "/Chip" }, kind: "ui", to: { path: "/Zone" } }],
  });
  assert.equal(clicks[0].to?.path, "/Zone");
});

test("extractClicks: rejects a drag whose drop target has no path (no silent degrade to a tap)", () => {
  assert.throws(
    () => extractClicks({ clicks: [{ tMs: 5, locator: { path: "/Chip" }, to: { scene: "S" } }] }),
    /drop target has no locator path/,
  );
});

test("replay: a blocked (world-tap) step is BLOCKED, the run continues, status is blocked", async () => {
  const trace = observedClicksToTrace(
    [{ tMs: 0, locator: { path: "/Fruit" }, kind: "world" }, click("/Start", 100)],
    { id: "x", scene: "S" },
  );
  const driver = okDriver();
  const pass = driver.dispatch;
  driver.dispatch = async (a) =>
    a.do === "world-tap" ? { ok: false, blocked: true, detail: "needs input traces" } : pass(a);

  const report = await replay(trace, driver);
  assert.equal(report.segments[0].status, "blocked");
  assert.equal(report.segments[1].status, "pass", "the run continued past the blocked step");
  assert.equal(report.status, "blocked");
  assert.equal(report.blockedReason, "world-input-unsupported");
  assert.equal(report.firstDivergence, undefined, "a block is not a divergence");
});

test("observedClicksToTrace: refuses an empty observation", () => {
  assert.throws(() => observedClicksToTrace([], { id: "x", scene: "S" }), /no clicks were recorded/);
});

test("observedClicksToTrace: an unsafe id is rejected (path-safety via parseTrace)", () => {
  assert.throws(
    () => observedClicksToTrace([click("/A", 0)], { id: "../evil", scene: "S" }),
    /id/,
  );
});

test("observedClicksToTrace: omits optional title/intent when absent", () => {
  const trace = observedClicksToTrace([click("/A", 0)], { id: "x", scene: "S" });
  assert.equal("title" in trace, false);
  assert.equal("intent" in trace, false);
});

test("extractClicks: pulls a valid clicks array out of the observe_stop payload", () => {
  const clicks = extractClicks({ clicks: [{ tMs: 5, locator: { path: "/A" }, button: 0 }] });
  assert.equal(clicks.length, 1);
  assert.equal(clicks[0].locator.path, "/A");
});

test("extractClicks: a missing / non-array clicks payload yields []", () => {
  assert.deepEqual(extractClicks(undefined), []);
  assert.deepEqual(extractClicks({}), []);
  assert.deepEqual(extractClicks({ clicks: "nope" }), []);
});

test("extractClicks: a present-but-malformed entry THROWS (no silent partial recording)", () => {
  assert.throws(
    () => extractClicks({ clicks: [{ tMs: 1, locator: { path: "/A" } }, { locator: {} }] }),
    /malformed click at index 1/,
  );
});

// ── outcome verification: the trustworthy-verdict layer ──

const scoreOutcome: Assertion = {
  id: "score",
  locator: { path: "/HUD" },
  component: "HudController",
  property_path: "score",
  operator: "equals",
  expected: 5,
};

test("observedClicksToTrace: emits captured outcomes as end-state assertions", () => {
  const trace = observedClicksToTrace([click("/Start", 0)], { id: "x", scene: "S" }, [scoreOutcome]);
  assert.deepEqual(trace.assertions, [scoreOutcome]);
});

test("observedClicksToTrace: no/empty outcomes ⇒ no assertions key", () => {
  assert.equal("assertions" in observedClicksToTrace([click("/A", 0)], { id: "x", scene: "S" }), false);
  assert.equal("assertions" in observedClicksToTrace([click("/A", 0)], { id: "x", scene: "S" }, []), false);
});

test("replay: a diverged outcome FAILS even when every tap actuated", async () => {
  const trace = observedClicksToTrace([click("/Start", 0), click("/Answer", 500)], { id: "x", scene: "S" }, [
    scoreOutcome,
  ]);
  // All taps actuate (okDriver), but the end-state assertion diverges → fail.
  const driver = okDriver();
  driver.evaluateAssertion = async () => ({ pass: false, actual: "0" });
  const report = await replay(trace, driver);
  assert.equal(report.status, "fail");
  assert.equal(report.firstDivergence?.kind, "assertion-failed");
  assert.ok(report.segments.every((s) => s.status === "pass"), "the UI flow itself passed");
});

test("replay: a matching outcome passes", async () => {
  const trace = observedClicksToTrace([click("/Start", 0)], { id: "x", scene: "S" }, [scoreOutcome]);
  const report = await replay(trace, okDriver());
  assert.equal(report.status, "pass");
  assert.equal(report.assertions[0].status, "pass");
});

test("replay: a GATED outcome whose screen is never reached FAILS (no false-pass on the default)", async () => {
  const gated = { ...scoreOutcome, reachedWhenVisible: true };
  const trace = observedClicksToTrace([click("/Start", 0)], { id: "x", scene: "S" }, [gated]);
  const driver = okDriver();
  // The asserted element never becomes visible (game didn't reach the screen)...
  driver.waitForAnchor = async () => ({ reached: false, actual: "not visible (inactive)" });
  // ...even though the value WOULD match (the scene default). Must still fail.
  driver.evaluateAssertion = async () => ({ pass: true, actual: "5 / 5" });
  const report = await replay(trace, driver);
  assert.equal(report.status, "fail");
  assert.equal(report.assertions[0].status, "fail");
  assert.match(report.firstDivergence?.actual ?? "", /not visible|not reached/);
});

test("replay: a GATED outcome whose screen IS reached evaluates by value", async () => {
  const gated = { ...scoreOutcome, reachedWhenVisible: true };
  const trace = observedClicksToTrace([click("/Start", 0)], { id: "x", scene: "S" }, [gated]);
  const report = await replay(trace, okDriver()); // waitForAnchor reached:true, assertion pass:true
  assert.equal(report.status, "pass");
  assert.equal(report.assertions[0].status, "pass");
});

test("captureOutcomes: gates a UI-Text outcome by default, leaves a non-UI one ungated, honors overrides", async () => {
  const send = async (): Promise<BridgeResponse> => fakeSend({ passed: true, actual: "5 / 5" });
  const [text] = await captureOutcomes(send, [
    { id: "s", locator: { path: "/HUD/Score" }, component: "Text", property_path: "m_Text" },
  ]);
  assert.equal(text.reachedWhenVisible, true, "a displayed UI-Text outcome is gated by default");
  const [field] = await captureOutcomes(send, [
    { id: "h", locator: { path: "/Player" }, component: "Health", property_path: "current" },
  ]);
  assert.equal(field.reachedWhenVisible, undefined, "a non-UI outcome is NOT gated (ui-visible would false-fail it)");
  const [forced] = await captureOutcomes(send, [
    { id: "h", locator: { path: "/Player" }, component: "Health", property_path: "current", reachedWhenVisible: true },
  ]);
  assert.equal(forced.reachedWhenVisible, true, "explicit opt-in honored");
});

test("replay: a gated outcome that IS visible still FAILS on a wrong value (gate doesn't mask divergence)", async () => {
  const gated = { ...scoreOutcome, reachedWhenVisible: true };
  const trace = observedClicksToTrace([click("/Start", 0)], { id: "x", scene: "S" }, [gated]);
  const driver = okDriver(); // waitForAnchor reached:true (screen reached)
  driver.evaluateAssertion = async () => ({ pass: false, actual: "2 / 5" });
  const report = await replay(trace, driver);
  assert.equal(report.status, "fail");
  assert.equal(report.firstDivergence?.kind, "assertion-failed");
  assert.match(report.firstDivergence?.actual ?? "", /2 \/ 5/, "the value divergence, not the gate, is reported");
});

test("captureOutcomes: reads the live value into an equals-assertion", async () => {
  const send = async (command: string, params: Record<string, unknown>): Promise<BridgeResponse> => {
    assert.equal(command, "runtime.assert_condition");
    assert.equal(params.property_path, "score");
    return fakeSend({ passed: true, actual: 5 });
  };
  const [a] = await captureOutcomes(send, [
    { id: "score", locator: { path: "/HUD" }, component: "HudController", property_path: "score" },
  ]);
  assert.equal(a.expected, 5, "the live value becomes the expected");
  assert.equal(a.operator, "equals", "default operator");
  assert.equal(a.id, "score");
});

test("captureOutcomes: refuses a property that read no value (no silent absent outcome)", async () => {
  const send = async (): Promise<BridgeResponse> => fakeSend({ passed: false });
  await assert.rejects(
    () => captureOutcomes(send, [{ id: "x", locator: { path: "/A" }, property_path: "p" }]),
    /read no value/,
  );
});

test("captureOutcomes: surfaces the bridge error message (not a misleading 'read no value')", async () => {
  const send = async (): Promise<BridgeResponse> =>
    ({
      id: "x",
      status: "error",
      data: null,
      error: { code: "NOT_FOUND", message: "No property found matching 'Stars'." },
      timestamp: 0,
    }) as unknown as BridgeResponse;
  await assert.rejects(
    () => captureOutcomes(send, [{ id: "stars", locator: { path: "/HUD" }, component: "GameManager", property_path: "Stars" }]),
    /No property found matching 'Stars'/,
  );
});

test("captureOutcomes: reads `actual` via not_equals+sentinel even when the compare 'fails'; null round-trips", async () => {
  const params: Array<Record<string, unknown>> = [];
  const send = async (_command: string, p: Record<string, unknown>): Promise<BridgeResponse> => {
    params.push(p);
    return fakeSend({ passed: false, actual: null }); // sentinel "matched" → passed false, value is null
  };
  const [a] = await captureOutcomes(send, [{ id: "x", locator: { path: "/A" }, property_path: "p" }]);
  assert.equal(params[0].operator, "not_equals", "reads via the type-safe not_equals + sentinel");
  assert.equal(a.expected, null, "a legitimately-null value round-trips, regardless of `passed`");
});

test("observeLive: stop() refuses when the recorder was not live (observed:false)", async () => {
  const session = await observeLive(async () => fakeSend({ clicks: [], observed: false }));
  await assert.rejects(() => session.stop(), /recorder was not live/);
});

// ───────────────────── state-signal gate ─────────────────────

const STATE_META = {
  id: "chef",
  scene: "Assets/Scenes/Chef.unity",
  stateSignal: { locator: { path: "/Canvas/GM" }, component: "ChefGameManager", property: "phase" },
};

test("observedClicksToTrace: declared signal + sampled value → wait-for-condition gate before the tap", () => {
  const clicks: ObservedClick[] = [
    { tMs: 100, locator: { path: "/Canvas/PourButton" }, button: 0, stateSignal: "Pour" },
  ];
  const trace = observedClicksToTrace(clicks, STATE_META);
  const actions = trace.segments[0].actions;
  assert.deepEqual(actions.map((a) => a.do), ["wait-for-visible", "wait-for-condition", "tap"]);
  // The gate sits immediately before the gesture, with the correct condition.
  assert.deepEqual(actions[1], {
    do: "wait-for-condition",
    locator: { path: "/Canvas/GM" },
    component: "ChefGameManager",
    property_path: "phase",
    operator: "equals",
    expected: "Pour",
  });
  // The whole trace still validates (green by construction).
  assert.equal(parseTrace(trace).segments[0].actions[1].do, "wait-for-condition");
});

test("observedEdgesToTrace: declared signal + sampled value → wait-for-condition gate before the tap", () => {
  const clicks: ObservedClick[] = [
    { tMs: 100, locator: { path: "/Canvas/PourButton" }, button: 0, stateSignal: "Pour" },
  ];
  const trace = observedEdgesToTrace(clicks, [], STATE_META);
  const actions = trace.segments[0].actions;
  assert.deepEqual(actions.map((a) => a.do), ["wait-for-visible", "wait-for-condition", "tap"]);
  assert.deepEqual(actions[1], {
    do: "wait-for-condition",
    locator: { path: "/Canvas/GM" },
    component: "ChefGameManager",
    property_path: "phase",
    operator: "equals",
    expected: "Pour",
  });
});

test("observedClicksToTrace: NO declared signal → byte-identical to today (regression)", () => {
  const withSignal: ObservedClick[] = [
    { tMs: 100, locator: { path: "/A" }, button: 0, stateSignal: "Pour" },
    { tMs: 900, locator: { path: "/B" }, button: 0, stateSignal: "Stir" },
  ];
  // Strip the per-click stateSignal so the no-signal observation is identical.
  const plain: ObservedClick[] = withSignal.map((c) => ({ tMs: c.tMs, locator: c.locator, button: c.button }));
  const baseline = observedClicksToTrace(plain, { id: "chef", scene: "S" });
  // Meta WITHOUT a stateSignal, even though clicks carry a sampled value → no gate.
  const withClickSignalButNoMeta = observedClicksToTrace(withSignal, { id: "chef", scene: "S" });
  assert.deepEqual(withClickSignalButNoMeta, baseline);
});

// The baseline meta is STATE_META with the signal stripped — so the ONLY variable
// under test is whether the gate is grafted (same id/scene, no scene drift).
const META_NO_SIGNAL = { id: STATE_META.id, scene: STATE_META.scene };

test("observedClicksToTrace: declared signal but null/absent click value → byte-identical (regression)", () => {
  const clicks: ObservedClick[] = [
    { tMs: 100, locator: { path: "/A" }, button: 0, stateSignal: null },
    { tMs: 900, locator: { path: "/B" }, button: 0 }, // absent
  ];
  const plain: ObservedClick[] = clicks.map((c) => ({ tMs: c.tMs, locator: c.locator, button: c.button }));
  const baseline = observedClicksToTrace(plain, META_NO_SIGNAL);
  const gated = observedClicksToTrace(clicks, STATE_META);
  assert.deepEqual(gated, baseline);
});

test("observedEdgesToTrace: declared signal but null/absent click value → byte-identical (regression)", () => {
  const clicks: ObservedClick[] = [
    { tMs: 100, locator: { path: "/A" }, button: 0, stateSignal: null },
    { tMs: 900, locator: { path: "/B" }, button: 0 },
  ];
  const plain: ObservedClick[] = clicks.map((c) => ({ tMs: c.tMs, locator: c.locator, button: c.button }));
  const baseline = observedEdgesToTrace(plain, [], META_NO_SIGNAL);
  const gated = observedEdgesToTrace(clicks, [], STATE_META);
  assert.deepEqual(gated, baseline);
});

test("observeLive: passes the declared stateSignal to observe_start; omits it when absent", async () => {
  const seen: Array<Record<string, unknown>> = [];
  const send = async (command: string, params: Record<string, unknown>): Promise<BridgeResponse> => {
    if (command === "input.observe_start") seen.push(params);
    return fakeSend({ clicks: [], observed: true });
  };
  await observeLive(send, { path: "/Canvas/GM", component: "ChefGameManager", property: "phase" });
  await observeLive(send);
  assert.deepEqual(seen[0], { stateSignal: { path: "/Canvas/GM", component: "ChefGameManager", property: "phase" } });
  assert.deepEqual(seen[1], {});
});

test("observeLive: stop() returns the clicks when observed", async () => {
  let stopped = false;
  const send = async (command: string): Promise<BridgeResponse> => {
    if (command === "input.observe_stop") stopped = true;
    return fakeSend({ clicks: [{ tMs: 3, locator: { path: "/A" }, button: 0 }], observed: true });
  };
  const session = await observeLive(send);
  const { clicks, droppedNoTarget } = await session.stop();
  assert.equal(stopped, true);
  assert.deepEqual(clicks.map((c) => c.locator.path), ["/A"]);
  assert.equal(droppedNoTarget, 0, "absent droppedNoTarget defaults to 0");
});

test("observeLive: stop() surfaces the dropped-inert-tap count from the bridge", async () => {
  const send = async (): Promise<BridgeResponse> =>
    fakeSend({ clicks: [{ tMs: 1, locator: { path: "/A" }, button: 0 }], observed: true, droppedNoTarget: 3 });
  const { clicks, droppedNoTarget } = await (await observeLive(send)).stop();
  assert.equal(clicks.length, 1);
  assert.equal(droppedNoTarget, 3);
});

// --- Scene-evidence round-trip (regression for the parse-drop + edge-path findings) -----------------

/** A click stamped with the runtime scene the bridge reported it in. */
const sceneClick = (path: string, tMs: number, scene: string): ObservedClick => ({
  tMs,
  locator: { path, scene },
  button: 0,
} as ObservedClick);

test("parseTrace: a segment's scene evidence ROUND-TRIPS (regression — parse must not drop segment.scene)", () => {
  // The no-`--scene` front door records a trace, writes it, then reads it back via parseTrace before
  // inferring scenes. If parse drops segment.scene, every multi-scene trace silently collapses to a
  // single-scene fallback — the exact bug that would defeat the live home→StarChef acceptance run.
  const trace = observedClicksToTrace(
    [sceneClick("/Home/Play", 0, "Home"), sceneClick("/Chef/Serve", 500, "StarChef")],
    { id: "x", scene: "Assets/Scenes/Home.unity" },
  );
  // The transform must stamp each segment with its scene (precondition for the round-trip to matter).
  assert.deepEqual(trace.segments.map((s) => s.scene), ["Home", "StarChef"]);

  // The load-bearing assertion: parsing a serialized copy preserves every segment.scene.
  const reparsed = parseTrace(JSON.parse(JSON.stringify(trace)));
  assert.deepEqual(reparsed.segments.map((s) => s.scene), ["Home", "StarChef"]);
});

test("parseTrace: a segment WITHOUT scene round-trips as absent (back-compat, no injected field)", () => {
  const trace = observedClicksToTrace([click("/A", 0)], { id: "x", scene: "S.unity" });
  const reparsed = parseTrace(JSON.parse(JSON.stringify(trace)));
  assert.equal("scene" in reparsed.segments[0], false, "absent scene stays absent — never materialized");
});

test("observedEdgesToTrace: a single-scene keyboard timeline STAMPS the segment scene (round-trips)", () => {
  const trace = observedEdgesToTrace(
    [sceneClick("/A", 0, "StarChef")],
    [{ tMs: 100, key: "space", edge: "down" }, { tMs: 300, key: "space", edge: "up" }],
    { id: "x", scene: "Assets/Scenes/StarChef.unity" },
  );
  assert.equal(trace.segments[0].scene, "StarChef");
  assert.equal(parseTrace(JSON.parse(JSON.stringify(trace))).segments[0].scene, "StarChef");
});

test("observedEdgesToTrace: a timeline spanning MULTIPLE click-scenes leaves scene ABSENT (no false single-scene claim)", () => {
  // One merged segment can't represent two scenes; rather than silently pick one, leave it absent so
  // inference falls back to single-scene — never a fabricated multi-scene claim. Phase 2 splits these.
  const trace = observedEdgesToTrace(
    [sceneClick("/A", 0, "Home"), sceneClick("/B", 400, "StarChef")],
    [],
    { id: "x", scene: "Assets/Scenes/Home.unity" },
  );
  assert.equal("scene" in trace.segments[0], false);
});

test("observedEdgesToTrace: a pure-keyboard timeline (no scene-bearing clicks) leaves scene absent", () => {
  const trace = observedEdgesToTrace(
    [],
    [{ tMs: 0, key: "left", edge: "down" }, { tMs: 200, key: "left", edge: "up" }],
    { id: "x", scene: "S" },
  );
  assert.equal("scene" in trace.segments[0], false);
});

// --- Phase 2 / D1-B: PER-GESTURE state-signal spec (per-scene auto-detect) ---------------------------

test("stateSignalGate: a PER-GESTURE stateSignalSpec builds the gate even with NO global meta.stateSignal", () => {
  // Auto-detect (D1-B) reports the scene's signal spec on the click itself; no global signal is declared.
  const clicks: ObservedClick[] = [
    {
      tMs: 100,
      locator: { path: "/Canvas/PourButton", scene: "StarChef" },
      button: 0,
      stateSignal: "Pour",
      stateSignalSpec: { locator: { path: "/Canvas/GM" }, component: "ChefGameManager", property: "phase" },
    },
  ];
  const trace = observedClicksToTrace(clicks, { id: "chef", scene: "Assets/Scenes/StarChef.unity" });
  const actions = trace.segments[0].actions;
  assert.deepEqual(actions.map((a) => a.do), ["wait-for-visible", "wait-for-condition", "tap"]);
  assert.deepEqual(actions[1], {
    do: "wait-for-condition",
    locator: { path: "/Canvas/GM" },
    component: "ChefGameManager",
    property_path: "phase",
    operator: "equals",
    expected: "Pour",
  });
  assert.doesNotThrow(() => parseTrace(trace));
});

test("stateSignalGate: per-gesture specs DIFFER across scenes → each gesture gets its own scene's gate", () => {
  const clicks: ObservedClick[] = [
    {
      tMs: 100, locator: { path: "/Home/Play", scene: "Home" }, button: 0,
      stateSignal: "Ready",
      stateSignalSpec: { locator: { path: "/Home/Mgr" }, component: "HomeManager", property: "screen" },
    },
    {
      tMs: 900, locator: { path: "/Chef/Bowl", scene: "StarChef" }, button: 0,
      stateSignal: "Mix",
      stateSignalSpec: { locator: { path: "/Chef/GM" }, component: "ChefGameManager", property: "phase" },
    },
  ];
  const trace = observedClicksToTrace(clicks, { id: "kids", scene: "Assets/Scenes/Home.unity" });
  const gate0 = trace.segments[0].actions.find((a) => a.do === "wait-for-condition")!;
  const gate1 = trace.segments[1].actions.find((a) => a.do === "wait-for-condition")!;
  assert.equal(gate0.do === "wait-for-condition" && gate0.component, "HomeManager");
  assert.equal(gate0.do === "wait-for-condition" && gate0.expected, "Ready");
  assert.equal(gate1.do === "wait-for-condition" && gate1.component, "ChefGameManager");
  assert.equal(gate1.do === "wait-for-condition" && gate1.expected, "Mix");
});

test("stateSignalGate: a per-gesture spec OVERRIDES the global meta.stateSignal", () => {
  const clicks: ObservedClick[] = [
    {
      tMs: 100, locator: { path: "/A" }, button: 0, stateSignal: "Pour",
      stateSignalSpec: { locator: { path: "/Override/GM" }, component: "OtherMgr", property: "state" },
    },
  ];
  const trace = observedClicksToTrace(clicks, STATE_META); // global signal present, but spec wins
  const gate = trace.segments[0].actions.find((a) => a.do === "wait-for-condition")!;
  assert.equal(gate.do === "wait-for-condition" && gate.component, "OtherMgr");
  assert.equal(gate.do === "wait-for-condition" && gate.property_path, "state");
});

test("stateSignalGate: a per-gesture spec with NO sampled value → no gate (value gates emission)", () => {
  const clicks: ObservedClick[] = [
    {
      tMs: 100, locator: { path: "/A" }, button: 0, stateSignal: null,
      stateSignalSpec: { locator: { path: "/GM" }, component: "Mgr", property: "phase" },
    },
  ];
  const baseline = observedClicksToTrace([{ tMs: 100, locator: { path: "/A" }, button: 0 }], { id: "x", scene: "S" });
  const withSpecNoValue = observedClicksToTrace(clicks, { id: "x", scene: "S" });
  assert.deepEqual(withSpecNoValue, baseline);
});

test("stateSignalGate: the per-gesture spec path also works in observedEdgesToTrace", () => {
  const clicks: ObservedClick[] = [
    {
      tMs: 100, locator: { path: "/Canvas/Bowl", scene: "StarChef" }, button: 0, stateSignal: "Mix",
      stateSignalSpec: { locator: { path: "/Canvas/GM" }, component: "ChefGameManager", property: "phase" },
    },
  ];
  const trace = observedEdgesToTrace(clicks, [], { id: "chef", scene: "Assets/Scenes/StarChef.unity" });
  const gate = trace.segments[0].actions.find((a) => a.do === "wait-for-condition")!;
  assert.equal(gate.do === "wait-for-condition" && gate.expected, "Mix");
  assert.equal(gate.do === "wait-for-condition" && gate.component, "ChefGameManager");
});
