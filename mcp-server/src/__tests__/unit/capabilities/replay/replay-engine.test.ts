import assert from "node:assert/strict";
import test from "node:test";

import {
  parseTrace,
  replay,
  TraceParseError,
  type Action,
  type Anchor,
  type Assertion,
  type ReplayDriver,
  type ReplayTrace,
} from "../../../../capabilities/replay/index.js";

// ───────────────────────────── fixtures ─────────────────────────────

/** A valid 2-segment success trace with anchors, captures, and an assertion. */
function baseTrace(): ReplayTrace {
  return {
    schemaVersion: "0.1",
    id: "level-1-success",
    start: { scene: "Level1", reset: "scene-load" },
    input: { backend: "ui-events" },
    segments: [
      {
        id: "s1",
        actions: [{ do: "tap", locator: { path: "/Canvas/Start" } }],
        anchors: [
          { id: "a1", kind: "ui-visible", locator: { path: "/Canvas/Board" } },
        ],
        captures: [{ id: "c1", atAnchor: "a1" }],
      },
      {
        id: "s2",
        actions: [{ do: "tap", locator: { path: "/Canvas/Apple" } }],
        anchors: [
          {
            id: "a2",
            kind: "condition",
            locator: { path: "/GameManager" },
            component: "GameManager",
            property_path: "score",
            operator: "greater_than",
            expected: 0,
          },
        ],
        captures: [{ id: "c2" }],
      },
    ],
    assertions: [
      {
        id: "win",
        locator: { path: "/GameManager" },
        component: "GameManager",
        property_path: "isWin",
        operator: "equals",
        expected: true,
      },
    ],
    outcome: { expected: "success" },
  };
}

interface FakeOptions {
  capabilitySupported?: boolean;
  resetOk?: boolean;
  /** tap/wait locator.path or drag.from.path that should fail to dispatch. */
  failActionLocator?: string;
  /** anchor id that should never be reached. */
  missAnchorId?: string;
  /** assertion id that should evaluate false. */
  failAssertionId?: string;
  consoleErrors?: string[];
}

/** A programmable driver: succeeds at everything unless told otherwise. */
function fakeDriver(opts: FakeOptions = {}): ReplayDriver {
  const actionLocator = (a: Action): string =>
    a.do === "drag"
      ? a.from.path
      : a.do === "key-tap" || a.do === "key-hold" || a.do === "key-down" || a.do === "key-up"
        ? a.key
        : a.do === "wait"
          ? `wait-${a.durationMs}`
          : a.locator.path;
  return {
    async capabilityCheck(backend) {
      const supported = opts.capabilitySupported ?? backend === "ui-events";
      return supported
        ? { supported: true }
        : { supported: false, reason: "unsupported-input-backend" };
    },
    async reset() {
      return (opts.resetOk ?? true)
        ? { ok: true, tier: "scene-load" }
        : { ok: false, reason: "reset-unavailable" };
    },
    async dispatch(action: Action) {
      if (opts.failActionLocator === actionLocator(action)) {
        return { ok: false, detail: "element not found" };
      }
      return { ok: true };
    },
    async waitForAnchor(anchor: Anchor) {
      if (opts.missAnchorId === anchor.id) {
        return { reached: false, actual: "still hidden" };
      }
      return { reached: true };
    },
    async capture(id: string) {
      return { artifact: `.loombridge/replays/level-1-success/actual/${id}.png`, sha256: "deadbeef" };
    },
    async evaluateAssertion(assertion: Assertion) {
      if (opts.failAssertionId === assertion.id) {
        return { pass: false, actual: "false" };
      }
      return { pass: true, actual: "true" };
    },
    async readConsole() {
      const errors = opts.consoleErrors ?? [];
      return { errorCount: errors.length, errors };
    },
  };
}

// ───────────────────────────── engine ─────────────────────────────

test("replay: happy path → pass with no divergence", async () => {
  const report = await replay(baseTrace(), fakeDriver());

  assert.equal(report.status, "pass");
  assert.equal(report.firstDivergence, undefined);
  assert.equal(report.resetTier, "scene-load");
  assert.deepEqual(report.segments.map((s) => s.status), ["pass", "pass"]);
  assert.deepEqual(report.segments[0].anchorsReached, ["a1"]);
  assert.deepEqual(report.segments[0].captures.map((c) => c.id), ["c1"]);
  assert.deepEqual(report.assertions, [{ id: "win", status: "pass" }]);
  assert.equal(report.console.status, "pass");
});

test("replay: missed anchor → fail with anchor-missed first divergence; later segment not_reached", async () => {
  const report = await replay(baseTrace(), fakeDriver({ missAnchorId: "a1" }));

  assert.equal(report.status, "fail");
  assert.equal(report.firstDivergence?.kind, "anchor-missed");
  assert.equal(report.firstDivergence?.segment, "s1");
  assert.equal(report.firstDivergence?.step, 0);
  assert.match(report.firstDivergence?.actual ?? "", /still hidden/);
  assert.deepEqual(report.segments.map((s) => s.status), ["fail", "not_reached"]);
  // The halting segment captured nothing; the assertion was never reached.
  assert.deepEqual(report.segments[0].captures, []);
  assert.deepEqual(report.assertions, [{ id: "win", status: "not_reached" }]);
});

test("replay: failed action → fail with action-failed first divergence", async () => {
  const report = await replay(
    baseTrace(),
    fakeDriver({ failActionLocator: "/Canvas/Apple" }),
  );

  assert.equal(report.status, "fail");
  assert.equal(report.firstDivergence?.kind, "action-failed");
  assert.equal(report.firstDivergence?.segment, "s2");
  assert.equal(report.firstDivergence?.step, 0);
  assert.match(report.firstDivergence?.expected ?? "", /tap \/Canvas\/Apple/);
  assert.deepEqual(report.segments.map((s) => s.status), ["pass", "fail"]);
});

test("replay: failed assertion → fail with assertion-failed first divergence", async () => {
  const report = await replay(baseTrace(), fakeDriver({ failAssertionId: "win" }));

  assert.equal(report.status, "fail");
  assert.equal(report.firstDivergence?.kind, "assertion-failed");
  assert.equal(report.firstDivergence?.segment, null);
  assert.deepEqual(report.segments.map((s) => s.status), ["pass", "pass"]);
  assert.deepEqual(report.assertions, [{ id: "win", status: "fail" }]);
});

test("replay: console error → fail with console-error divergence when nothing earlier", async () => {
  const report = await replay(
    baseTrace(),
    fakeDriver({ consoleErrors: ["NullReferenceException at Foo.Update"] }),
  );

  assert.equal(report.status, "fail");
  assert.equal(report.firstDivergence?.kind, "console-error");
  assert.equal(report.console.status, "fail");
  assert.equal(report.console.errorCount, 1);
});

test("replay: earlier divergence wins over a console error", async () => {
  const report = await replay(
    baseTrace(),
    fakeDriver({ missAnchorId: "a1", consoleErrors: ["boom"] }),
  );

  // The missed anchor is the first divergence, not the console error.
  assert.equal(report.firstDivergence?.kind, "anchor-missed");
  assert.equal(report.console.status, "fail");
});

test("replay: unsupported input backend → blocked, never run", async () => {
  const report = await replay(
    baseTrace(),
    fakeDriver({ capabilitySupported: false }),
  );

  assert.equal(report.status, "blocked");
  assert.equal(report.blockedReason, "unsupported-input-backend");
  assert.equal(report.resetTier, null);
  assert.equal(report.firstDivergence, undefined);
  assert.deepEqual(report.segments.map((s) => s.status), ["not_reached", "not_reached"]);
  assert.deepEqual(report.assertions, [{ id: "win", status: "not_reached" }]);
});

test("replay: reset unavailable → blocked", async () => {
  const report = await replay(baseTrace(), fakeDriver({ resetOk: false }));

  assert.equal(report.status, "blocked");
  assert.equal(report.blockedReason, "reset-unavailable");
  assert.equal(report.resetTier, null);
});

// ── S5/S1: what a blocked segment captures, and where a capture fault goes ──

// LITMUS. Break the gate back to `if (!segmentFailed)` and this test fails with c1 present:
// a segment whose tap never landed would still screenshot the half-driven screen and hand
// it to the pixel gate, where the missing state reads as drift. A blocked segment is a
// segment whose state was never reached, so it has nothing to capture.
test("replay: a BLOCKED segment emits ZERO captures (a half-driven screen is not evidence)", async () => {
  const driver = fakeDriver();
  const captured: string[] = [];
  driver.capture = async (id: string) => {
    captured.push(id);
    return { artifact: `${id}.png`, sha256: "d" };
  };
  // s2 is the discriminating segment: its capture `c2` has NO `atAnchor`, so nothing else
  // would stop it. (A test that blocked s1 would be VACUOUS: `c1` is anchored on `a1`, and an
  // anchored capture is already skipped when its anchor was never reached, and it passed with
  // the gate deliberately reverted.)
  driver.dispatch = async (action: Action) =>
    action.do === "tap" && action.locator.path === "/Canvas/Apple"
      ? { ok: false, blocked: true, detail: "no simulated pointer" }
      : { ok: true };

  const report = await replay(baseTrace(), driver);

  assert.equal(report.segments[1].status, "blocked");
  assert.deepEqual(report.segments[1].captures, [], "a blocked segment captures nothing");
  assert.equal(captured.includes("c2"), false, "…and the driver is never even asked for c2");
  // The run continues around it: the segment that DID drive still captures.
  assert.deepEqual(report.segments[0].captures.map((c) => c.id), ["c1"]);
  assert.equal(report.status, "blocked");
});

test("replay: the DRIVER's blocked reason wins over the engine's action-shaped guess", async () => {
  const driver = fakeDriver();
  driver.dispatch = async (action: Action) =>
    action.do === "tap" && action.locator.path === "/Canvas/Start"
      ? { ok: false, blocked: true, blockedReason: "focus-lost", detail: "needs Game-View focus" }
      : { ok: true };

  const report = await replay(baseTrace(), driver);
  assert.equal(report.status, "blocked");
  assert.equal(
    report.blockedReason,
    "focus-lost",
    "a focus loss is a harness condition; the action's shape must not relabel it",
  );
});

test("replay: a driver-reported capture HARNESS FAULT reaches the report (never swallowed)", async () => {
  const driver = fakeDriver();
  driver.capture = async (id: string) =>
    id === "c1" ? { harnessFault: "aligned settle failed: budget" } : { artifact: `${id}.png`, sha256: "d", framesElapsed: 15 };

  const report = await replay(baseTrace(), driver);
  const c1 = report.segments[0].captures[0];
  assert.equal(c1.id, "c1");
  assert.equal(c1.artifact, undefined, "no frame is claimed");
  assert.match(c1.harnessFault ?? "", /aligned settle failed/);
  assert.equal(report.segments[1].captures[0].framesElapsed, 15, "aligned evidence rides through too");
});

// ───────────────────────────── parser ─────────────────────────────

test("parseTrace: accepts a valid trace round-trip", () => {
  const parsed = parseTrace(baseTrace() as unknown);
  assert.equal(parsed.id, "level-1-success");
  assert.equal(parsed.segments.length, 2);
  assert.equal(parsed.input.backend, "ui-events");
});

test("parseTrace: accepts drag travelPx and carries it onto the parsed action", () => {
  const t = baseTrace();
  t.segments[0].actions = [
    { do: "drag", from: { path: "/Canvas/MixZone" }, to: { path: "/Canvas/MixZone" }, travelPx: 2600 },
  ];

  const action = parseTrace(t as unknown).segments[0].actions[0];
  assert.equal(action.do, "drag");
  assert.equal(action.do === "drag" ? action.travelPx : undefined, 2600);
});

test("parseTrace: refuses malformed drag travelPx", () => {
  for (const travelPx of [-1, Number.POSITIVE_INFINITY, Number.NaN, "2600"]) {
    const t = baseTrace() as unknown as Record<string, unknown>;
    t.segments = [
      {
        id: "s1",
        actions: [
          { do: "drag", from: { path: "/Canvas/MixZone" }, to: { path: "/Canvas/MixZone" }, travelPx },
        ],
      },
    ];
    assert.throws(() => parseTrace(t), /travelPx must be a finite number >= 0/);
  }
});

test("parseTrace: refuses a missing required field instead of coercing", () => {
  const bad = baseTrace() as unknown as Record<string, unknown>;
  delete bad.id;
  assert.throws(() => parseTrace(bad), TraceParseError);
});

test("parseTrace: refuses a non-action-trace backend", () => {
  const bad = baseTrace() as unknown as Record<string, unknown>;
  bad.input = { backend: "unity-input-system" };
  assert.throws(() => parseTrace(bad), /input\.backend must be "ui-events"/);
});

test("parseTrace: refuses an unknown condition operator", () => {
  const bad = baseTrace();
  (bad.assertions as Assertion[])[0].operator = "between" as never;
  assert.throws(() => parseTrace(bad as unknown), /operator must be one of/);
});

test("parseTrace: refuses a path-traversal capture id (no writing outside captureDir)", () => {
  const bad = baseTrace();
  bad.segments[0].captures![0].id = "../../../../tmp/pwn";
  assert.throws(() => parseTrace(bad as unknown), /must not contain path separators/);
});

test("parseTrace: refuses a path-traversal trace id", () => {
  const bad = baseTrace() as unknown as Record<string, unknown>;
  bad.id = "../escape";
  assert.throws(() => parseTrace(bad), /must not contain path separators/);
});

test("parseTrace: refuses a capture atAnchor that matches no anchor in the segment", () => {
  const bad = baseTrace();
  bad.segments[0].captures![0].atAnchor = "no-such-anchor";
  assert.throws(() => parseTrace(bad as unknown), /does not match any anchor/);
});

test("parseTrace: an assertion's reachedWhenVisible must be a boolean", () => {
  const t = baseTrace();
  (t as { assertions?: unknown }).assertions = [
    { id: "a", locator: { path: "/X" }, property_path: "p", operator: "equals", expected: 1, reachedWhenVisible: "yes" },
  ];
  assert.throws(() => parseTrace(t as unknown), /reachedWhenVisible must be a boolean/);
});

test("parseTrace: accepts a world-tap action", () => {
  const t = baseTrace();
  t.segments[0].actions = [{ do: "world-tap", locator: { path: "/Fruits/Apple" } }];
  t.segments[0].anchors = [];
  t.segments[0].captures = [];
  const parsed = parseTrace(t as unknown);
  assert.equal(parsed.segments[0].actions[0].do, "world-tap");
});

test("parseTrace: accepts a wait-for-condition action and round-trips the condition", () => {
  const t = baseTrace();
  t.segments[0].actions = [
    {
      do: "wait-for-condition",
      locator: { path: "/Canvas/GM" },
      component: "ChefGameManager",
      property_path: "phase",
      operator: "equals",
      expected: "Pour",
      tolerance: 0.5,
      timeoutMs: 3000,
    },
    { do: "tap", locator: { path: "/Canvas/Start" } },
  ];
  const action = parseTrace(t as unknown).segments[0].actions[0];
  assert.equal(action.do, "wait-for-condition");
  if (action.do !== "wait-for-condition") throw new Error("unreachable");
  assert.equal(action.locator.path, "/Canvas/GM");
  assert.equal(action.component, "ChefGameManager");
  assert.equal(action.property_path, "phase");
  assert.equal(action.operator, "equals");
  assert.equal(action.expected, "Pour");
  assert.equal(action.tolerance, 0.5);
  assert.equal(action.timeoutMs, 3000);
});

test("parseTrace: a wait-for-condition missing property_path throws", () => {
  const t = baseTrace() as unknown as Record<string, unknown>;
  t.segments = [
    {
      id: "s1",
      actions: [
        { do: "wait-for-condition", locator: { path: "/Canvas/GM" }, operator: "equals", expected: "Pour" },
      ],
    },
  ];
  assert.throws(() => parseTrace(t), /property_path must be a non-empty string/);
});

test("parseTrace: a wait-for-condition missing operator throws", () => {
  const t = baseTrace() as unknown as Record<string, unknown>;
  t.segments = [
    {
      id: "s1",
      actions: [
        { do: "wait-for-condition", locator: { path: "/Canvas/GM" }, property_path: "phase", expected: "Pour" },
      ],
    },
  ];
  assert.throws(() => parseTrace(t), /operator must be a non-empty string|operator must be one of/);
});

test('parseTrace: accepts reset "relaunch" (tier-3)', () => {
  const t = baseTrace();
  t.start.reset = "relaunch" as never;
  assert.equal(parseTrace(t as unknown).start.reset, "relaunch");
});

test("parseTrace: accepts a tap reset hook (tier-2)", () => {
  const t = baseTrace();
  t.start.reset = { hook: { do: "tap", locator: { path: "/HUD/EndSummary/Card/ReplayButton" } } } as never;
  const reset = parseTrace(t as unknown).start.reset as { hook: { do: string; locator: { path: string } } };
  assert.equal(reset.hook.do, "tap");
  assert.equal(reset.hook.locator.path, "/HUD/EndSummary/Card/ReplayButton");
});

test("parseTrace: accepts a set reset hook (tier-2)", () => {
  const t = baseTrace();
  t.start.reset = {
    hook: { do: "set", locator: { path: "/GameManager" }, component: "GameManager", property: "resetNow" },
  } as never;
  const reset = parseTrace(t as unknown).start.reset as { hook: { do: string; component: string } };
  assert.equal(reset.hook.do, "set");
  assert.equal(reset.hook.component, "GameManager");
});

test("parseTrace: refuses a reset object without a hook, and an unknown hook.do", () => {
  const noHook = baseTrace();
  noHook.start.reset = { notAHook: 1 } as never;
  assert.throws(() => parseTrace(noHook as unknown), /must declare a "hook"/);

  const badDo = baseTrace();
  badDo.start.reset = { hook: { do: "explode" } } as never;
  assert.throws(() => parseTrace(badDo as unknown), /hook.do must be/);
});

test("parseTrace: the old string-hook form is rejected with a migration hint", () => {
  const t = baseTrace();
  t.start.reset = { hook: "NewGame" } as never;
  assert.throws(() => parseTrace(t as unknown), /is now \{ do: "tap"\|"set", \.\.\. \}, not a string/);
});

test("parseTrace: accepts a tap hook with a verify post-condition", () => {
  const t = baseTrace();
  t.start.reset = {
    hook: { do: "tap", locator: { path: "/Replay" }, verify: { locator: { path: "/HUD/StartScreen" } } },
  } as never;
  const reset = parseTrace(t as unknown).start.reset as { hook: { verify: { locator: { path: string } } } };
  assert.equal(reset.hook.verify.locator.path, "/HUD/StartScreen");
});

test("parseTrace: refuses duplicate segment ids", () => {
  const bad = baseTrace();
  bad.segments[1].id = bad.segments[0].id;
  assert.throws(() => parseTrace(bad as unknown), /duplicate segment id/);
});

test('parseTrace: refuses an expected:"failure" trace with no anchor or assertion to observe it', () => {
  const bad = baseTrace();
  bad.outcome.expected = "failure";
  bad.assertions = undefined;
  for (const segment of bad.segments) {
    segment.anchors = undefined;
    segment.captures = undefined; // captures' atAnchor would otherwise fail first
  }
  assert.throws(() => parseTrace(bad as unknown), /must declare at least one anchor or assertion/);
});

test('parseTrace: accepts an expected:"failure" trace that declares an anchor', () => {
  const ok = baseTrace();
  ok.outcome.expected = "failure";
  ok.assertions = undefined;
  // segment 0 keeps its ui-visible anchor → the failure is observable.
  const parsed = parseTrace(ok as unknown);
  assert.equal(parsed.outcome.expected, "failure");
});
