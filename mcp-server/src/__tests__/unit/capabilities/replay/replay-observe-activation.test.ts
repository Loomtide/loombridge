/**
 * The observe-start ACTIVATION GATE, client side.
 *
 * THE FAILURE THIS CLOSES (reproduced on a live consumer project): a human ran
 * `loombridge trace record` from a terminal, clicked the Unity Game view to bring Unity
 * forward, and tapped a hub tile. The trace recorded that tap TWICE with the same scene tag,
 * and replay died on step-2 with `Could not resolve locator` because step-1 had already
 * navigated out of the hub. The first tap was swallowed by the editor (the game never
 * processed it) but the observer recorded it anyway: Unity-internal Game-view focus is true
 * even while Unity sits behind the terminal.
 *
 * The bridge half of the fix waits for Unity to become the ACTIVE OS APPLICATION before it
 * begins recording. This file guards the three client-side halves that make that wait usable,
 * each of which is a "declared value nothing walks" risk:
 *   - the WIRE timeout must exceed the bridge's grace, or the client aborts the call while the
 *     bridge is still waiting for the human's click (the C# constant is read OFF DISK here, so
 *     the two languages cannot drift apart silently),
 *   - the human must be told to click Unity BEFORE the blocking send, and told what actually
 *     happened after it,
 *   - the "press Enter to stop" prompt must never be reached before recording has started.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  OBSERVE_ACTIVATION_GRACE_MS,
  OBSERVE_START_TIMEOUT_MS,
  observeLive,
  observeStartNotice,
} from "../../../../capabilities/replay/observe-live.js";
import { recordObservedTrace } from "../../../../capabilities/replay/observe-record-live.js";
import { OpRegistry } from "../../../../surfaces/op-registry.js";
import type { BridgeSend } from "../../../../capabilities/replay/index.js";
import type { BridgeResponse } from "../../../../shared/types.js";
import { REPO_ROOT } from "../../../_support/paths.js";

const INPUT_HANDLER_CS = path.join(
  REPO_ROOT,
  "packages",
  "com.loomtide.loombridge",
  "Editor",
  "Handlers",
  "InputHandler.cs",
);

/** The bridge's activation grace, read from the C# source that actually declares it. */
function bridgeActivationGraceMs(): number {
  const source = fs.readFileSync(INPUT_HANDLER_CS, "utf8");
  const match = /DefaultActivationTimeoutMs\s*=\s*(\d+)\s*;/.exec(source);
  assert.ok(
    match,
    `InputHandler.cs must declare DefaultActivationTimeoutMs (the bridge's activation grace) — ` +
      `if it was renamed, rename the mirror in observe-live.ts with it`,
  );
  return Number(match![1]);
}

function ok(data: unknown): BridgeResponse {
  return { id: "x", status: "success", data, timestamp: 0 } as BridgeResponse;
}

// LITMUS (executed): with the C# constant raised to 300000 (`DefaultActivationTimeoutMs = 300000`)
// this test failed on the REAL comparison, not a re-implemented one:
//   AssertionError [ERR_ASSERTION]: the TS mirror of the bridge activation grace is stale:
//   observe-live.ts says 60000ms, InputHandler.cs says 300000ms
//   ... expected: 300000, actual: 60000
// Restoring the constant to 60000 turned it green again.
test("observe activation: the TS mirror + wire timeout are bound to the C# grace the bridge actually uses", () => {
  const grace = bridgeActivationGraceMs();
  assert.equal(
    OBSERVE_ACTIVATION_GRACE_MS,
    grace,
    `the TS mirror of the bridge activation grace is stale: observe-live.ts says ` +
      `${OBSERVE_ACTIVATION_GRACE_MS}ms, InputHandler.cs says ${grace}ms`,
  );
  assert.ok(
    OBSERVE_START_TIMEOUT_MS > grace,
    `the observe_start wire timeout (${OBSERVE_START_TIMEOUT_MS}ms) must exceed the bridge's ` +
      `activation grace (${grace}ms), else the client gives up while the bridge is still waiting ` +
      `for the human to click the Unity window`,
  );

  // The MCP surface sends the same op through resolveOpTimeoutMs, so its declared default has to
  // clear the same bar (its own 10s fallback would abort the wait).
  const op = new OpRegistry().getByCommand("input.observe_start");
  assert.ok(op, "input.observe_start must be registered");
  assert.ok(
    (op!.defaultTimeoutMs ?? 10000) > grace,
    `input.observe_start defaultTimeoutMs (${op!.defaultTimeoutMs ?? 10000}ms) must exceed the ` +
      `bridge activation grace (${grace}ms)`,
  );
  const properties = (op!.inputSchema.properties ?? {}) as Record<string, unknown>;
  assert.ok(
    Object.prototype.hasOwnProperty.call(properties, "activationTimeoutMs"),
    "input.observe_start must advertise the activationTimeoutMs it actually reads",
  );

  // The op only gets its editor ticks (and so its wait) by being dispatched through the C#
  // ASYNC path. If IsAsync stopped answering true for it, the handler would be called on the
  // sync path, where `respond` fires after the executor has already answered.
  //
  // LITMUS (executed): with InputHandler.IsAsync reverted to `return false;` this failed:
  //   AssertionError [ERR_ASSERTION]: InputHandler.IsAsync must return true for "observe_start"
  //   (the activation wait spans editor ticks)
  //   ... operator: 'match'
  assert.match(
    fs.readFileSync(INPUT_HANDLER_CS, "utf8"),
    /IsAsync\([^)]*\)\s*\{[^}]*return\s+opName\s*==\s*"observe_start";/s,
    'InputHandler.IsAsync must return true for "observe_start" (the activation wait spans editor ticks)',
  );
  assert.equal(op!.isAsync, true, "the registry must advertise input.observe_start as async");
});

// LITMUS (executed): reverting `observeLive` to `send("input.observe_start", startParams)` (no
// explicit timeout) failed here on the real call path:
//   AssertionError [ERR_ASSERTION]: observe_start must state its own wire timeout: the 10s
//   default aborts the call while the bridge waits for the human to click Unity
//   ... expected: 90000, actual: undefined
test("observeLive: states an explicit wire timeout on input.observe_start", async () => {
  let seenTimeout: number | undefined;
  const send: BridgeSend = async (command, _params, timeoutMs) => {
    if (command === "input.observe_start") seenTimeout = timeoutMs;
    return ok({ clicks: [], observed: true });
  };
  await observeLive(send);
  assert.equal(
    seenTimeout,
    OBSERVE_START_TIMEOUT_MS,
    "observe_start must state its own wire timeout: the 10s default aborts the call while the " +
      "bridge waits for the human to click Unity",
  );
});

// LITMUS (executed): moving the "click the Unity window" notify to AFTER the send failed here:
//   AssertionError [ERR_ASSERTION]: the human must be told to click Unity BEFORE the call that
//   blocks on their click ... expected 1 to be > 0  (notices.length was 0 at send time)
test("observeLive: tells the human to click Unity BEFORE the blocking send, and the outcome after", async () => {
  const notices: string[] = [];
  let noticesAtSend = -1;
  const send: BridgeSend = async (command) => {
    if (command === "input.observe_start") noticesAtSend = notices.length;
    return ok({ clicks: [], observed: true, applicationActive: true, activationTimedOut: false });
  };
  await observeLive(send, undefined, false, (m) => notices.push(m));

  assert.ok(
    noticesAtSend > 0,
    "the human must be told to click Unity BEFORE the call that blocks on their click",
  );
  assert.match(notices[0], /click the unity window/i);
  assert.match(notices[1], /recording/i);
});

test("observeStartNotice: an inactive/timed-out start is LOUD; a normal start is not; an old bridge is unchanged", () => {
  assert.match(observeStartNotice({ activationTimedOut: true, applicationActive: false }), /WARNING/);
  assert.match(observeStartNotice({ applicationActive: false }), /DROPPED/);
  assert.match(
    observeStartNotice({ applicationActive: true, activationTimedOut: false }),
    /^Recording\./,
  );
  // A bridge that predates the gate reports neither field: nothing to warn about, so it reads
  // exactly as a healthy start rather than crying wolf on every older editor.
  assert.match(observeStartNotice({}), /^Recording\./);
  assert.match(observeStartNotice(undefined), /^Recording\./);
});

// LITMUS (executed): with `await options.waitForStop()` moved ABOVE the `observeLive(...)` call in
// observe-record-live.ts this failed on the real orchestration:
//   AssertionError [ERR_ASSERTION]: the human must not be told to press Enter before being told
//   recording started ... expected 0 to be > 0
test("recordObservedTrace: recording is announced BEFORE the press-Enter prompt is reached", async () => {
  const notices: string[] = [];
  let noticesAtStop = -1;
  const send: BridgeSend = async (command) => {
    if (command === "input.observe_stop") {
      return ok({ clicks: [{ tMs: 0, locator: { path: "/HUD/Start" }, button: 0, kind: "ui" }], observed: true });
    }
    return ok({});
  };
  await recordObservedTrace(
    send,
    { id: "demo", scene: "Assets/Scenes/Game.unity" },
    {
      waitForStop: async () => {
        noticesAtStop = notices.length;
      },
      onNotice: (m) => notices.push(m),
    },
  );

  assert.ok(
    noticesAtStop > 0,
    "the human must not be told to press Enter before being told recording started",
  );
  assert.match(notices[noticesAtStop - 1], /recording/i);
});
