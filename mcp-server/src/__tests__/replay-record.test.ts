import assert from "node:assert/strict";
import test from "node:test";

import { parseTrace, type Action, type Anchor, type ReplayDriver } from "../capabilities/replay/index.js";
import { RecordingSession } from "../capabilities/replay/record.js";

function fakeDriver(
  opts: { failTap?: string; missAnchor?: string; captureNoImage?: boolean } = {},
): ReplayDriver {
  return {
    capabilityCheck: async () => ({ supported: true }),
    reset: async () => ({ ok: true, tier: "scene-load" }),
    dispatch: async (a: Action) => {
      const path =
        a.do === "drag"
          ? a.from.path
          : a.do === "key-tap" || a.do === "key-hold" || a.do === "key-down" || a.do === "key-up"
            ? a.key
            : a.do === "wait"
              ? `wait-${a.durationMs}`
              : a.locator.path;
      return opts.failTap === path ? { ok: false, detail: "not found" } : { ok: true };
    },
    waitForAnchor: async (anchor: Anchor) => {
      const path = anchor.kind === "ui-visible" ? anchor.locator.path : "";
      return opts.missAnchor === path ? { reached: false, actual: "hidden" } : { reached: true };
    },
    capture: async (id: string) =>
      opts.captureNoImage ? {} : { artifact: `/tmp/${id}.png`, sha256: "x" },
    evaluateAssertion: async () => ({ pass: true }),
    readConsole: async () => ({ errorCount: 0, errors: [] }),
  };
}

test("RecordingSession: a demonstrated flow becomes a valid trace", async () => {
  const session = new RecordingSession(fakeDriver(), {
    id: "demo",
    scene: "Assets/Scenes/Game.unity",
    intent: "start → question",
  });
  session.segment("start-to-question");
  await session.tap({ path: "/HUD/StartScreen/StartButton" });
  const anchorId = await session.waitVisible({ path: "/HUD/Banner/QuestionText" });
  await session.capture("question");

  const trace = session.build();
  assert.equal(trace.id, "demo");
  assert.equal(trace.input.backend, "ui-events");
  assert.equal(trace.start.scene, "Assets/Scenes/Game.unity");
  assert.deepEqual(trace.segments[0].actions, [
    { do: "tap", locator: { path: "/HUD/StartScreen/StartButton" } },
  ]);
  assert.equal(trace.segments[0].anchors![0].id, anchorId);
  assert.equal(trace.segments[0].captures![0].atAnchor, anchorId);
  // the recorded trace round-trips through the parser unchanged.
  assert.doesNotThrow(() => parseTrace(trace as unknown));
});

test("RecordingSession: a tap that does not actuate throws and is not recorded", async () => {
  const session = new RecordingSession(fakeDriver({ failTap: "/Gone" }), { id: "d", scene: "S" });
  await assert.rejects(() => session.tap({ path: "/Gone" }), /tap \/Gone failed/);
  assert.equal(session.build().segments[0].actions.length, 0);
});

test("RecordingSession: a never-visible anchor throws (a recording is green by construction)", async () => {
  const session = new RecordingSession(fakeDriver({ missAnchor: "/Modal" }), { id: "d", scene: "S" });
  await assert.rejects(() => session.waitVisible({ path: "/Modal" }, 0), /never became visible/);
});

test("RecordingSession: drag records a drag action", async () => {
  const session = new RecordingSession(fakeDriver(), { id: "d", scene: "S" });
  await session.drag({ path: "/A" }, { path: "/B" });
  assert.deepEqual(session.build().segments[0].actions, [
    { do: "drag", from: { path: "/A" }, to: { path: "/B" } },
  ]);
});

test("RecordingSession: multiple segments are preserved in order", async () => {
  const session = new RecordingSession(fakeDriver(), { id: "d", scene: "S" });
  session.segment("one");
  await session.tap({ path: "/A" });
  session.segment("two");
  await session.tap({ path: "/B" });
  const trace = session.build();
  assert.deepEqual(trace.segments.map((s) => s.id), ["one", "two"]);
});

// ── the recorder must never emit a trace its own parser would reject ──

test("RecordingSession: rejects an unsafe trace id at construction", () => {
  assert.throws(() => new RecordingSession(fakeDriver(), { id: "../evil", scene: "S" }), /trace id/);
});

test("RecordingSession: rejects an unsafe or duplicate segment id", () => {
  const session = new RecordingSession(fakeDriver(), { id: "d", scene: "S" });
  assert.throws(() => session.segment("../x"), /segment id/);
  session.segment("one");
  assert.throws(() => session.segment("one"), /duplicate segment id/);
});

test("RecordingSession: rejects an unsafe capture id before driving (no traversal write)", async () => {
  const session = new RecordingSession(fakeDriver(), { id: "d", scene: "S" });
  await assert.rejects(() => session.capture("../../escape"), /capture id/);
});

test("RecordingSession: a capture that produced no image throws", async () => {
  const session = new RecordingSession(fakeDriver({ captureNoImage: true }), { id: "d", scene: "S" });
  await assert.rejects(() => session.capture("shot"), /produced no image/);
});

test("RecordingSession: build() round-trips a multi-segment / capture-without-anchor trace", async () => {
  const session = new RecordingSession(fakeDriver(), { id: "d", scene: "S" });
  session.segment("one");
  await session.tap({ path: "/A" });
  await session.capture("cap-a"); // no anchor in this segment → atAnchor omitted
  session.segment("two");
  const anchorId = await session.waitVisible({ path: "/B" });
  await session.capture("cap-b"); // tied to the anchor in segment two

  const trace = session.build(); // throws if parseTrace would reject
  assert.equal(trace.segments[0].captures![0].atAnchor, undefined);
  assert.equal(trace.segments[1].captures![0].atAnchor, anchorId);
});

test("RecordingSession: build() refuses an outcome:failure recording with nothing to observe it", async () => {
  const session = new RecordingSession(fakeDriver(), { id: "d", scene: "S", outcome: "failure" });
  session.segment("seg");
  await session.tap({ path: "/A" });
  assert.throws(() => session.build(), /must declare at least one anchor or assertion/);
});
