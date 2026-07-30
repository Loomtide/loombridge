/**
 * `cli-ui` — the shared icon vocabulary + helpers. Focus: `unityConnectionHint` turns the
 * bridge's wall-of-ECONNREFUSED failure into ONE clear, actionable line (Unity isn't open),
 * and leaves every OTHER error to the caller's normal handling.
 */

import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ICON,
  nextStepLines,
  tildify,
  unityConnectionHint,
  unityConnectionLostHint,
} from "../../../shared/cli-ui.js";

test("tildify: shortens a $HOME path to ~/…, leaves others untouched", () => {
  assert.equal(tildify(path.join(os.homedir(), ".loombridge", "x", "y.png")), "~/.loombridge/x/y.png");
  assert.equal(tildify(os.homedir()), "~");
  assert.equal(tildify("/var/tmp/z"), "/var/tmp/z");
  assert.equal(tildify("relative/path"), "relative/path");
});

/** A stand-in for the bridge's UnityConnectionError (duck-typed by name + diagnostics). */
function fakeConnError(message: string, attemptedPorts: number[]): Error {
  const e = new Error(message);
  e.name = "UnityConnectionError";
  (e as unknown as { diagnostics: unknown }).diagnostics = { attemptedPorts };
  return e;
}

test("unityConnectionHint: a UnityConnectionError → one clear actionable message, not the raw dump", () => {
  const raw = "Failed to connect to Unity on ports 8200-8210 (attempted order: …) ECONNREFUSED ECONNREFUSED …";
  const lines = unityConnectionHint(fakeConnError(raw, [8200, 8201, 8210]));
  assert.ok(lines, "should recognize the connection error");
  const out = lines!.join("\n");
  assert.match(out, /^❌ Can't reach Unity/);
  assert.match(out, /Open your project in Unity/);
  assert.match(out, /tried ports 8200–8210/);
  // The wall of ECONNREFUSED is NOT shown by default.
  assert.doesNotMatch(out, /ECONNREFUSED/);
});

test("unityConnectionHint: LOOMBRIDGE_DEBUG=1 appends the full diagnostics", () => {
  const prev = process.env.LOOMBRIDGE_DEBUG;
  process.env.LOOMBRIDGE_DEBUG = "1";
  try {
    const out = unityConnectionHint(fakeConnError("…ECONNREFUSED wall…", [8200, 8210]))!.join("\n");
    assert.match(out, /ECONNREFUSED wall/, "debug appends the raw message");
  } finally {
    if (prev === undefined) delete process.env.LOOMBRIDGE_DEBUG;
    else process.env.LOOMBRIDGE_DEBUG = prev;
  }
});

test("unityConnectionHint: any OTHER error → null (caller keeps its normal handling)", () => {
  assert.equal(unityConnectionHint(new Error("disk full")), null);
  assert.equal(unityConnectionHint("a string"), null);
  assert.equal(unityConnectionHint(null), null);
  assert.equal(unityConnectionHint({ name: "SomethingElse" }), null);
});

test("nextStepLines: '👉 Next — <summary>' + the indented command", () => {
  const lines = nextStepLines("Do the thing.", "loombridge do-thing");
  assert.equal(lines[0], `${ICON.next} Next — Do the thing.`);
  assert.equal(lines[1], "   loombridge do-thing");
  // No command → just the summary line.
  assert.equal(nextStepLines("Done.").length, 1);
});

// BX3: the OTHER half of the same condition. `unity-client` rejects in-flight ops with a plain
// `Error("CONNECTION_LOST: …")` that carries no `UnityConnectionError` name, so a socket that
// dropped MID-RUN did not match `unityConnectionHint` and every caller keyed on it fell through
// to its generic failure path: a harness fault reported as a game defect.
test("unityConnectionLostHint: the CONNECTION_LOST message shape is recognised", () => {
  for (const message of [
    "CONNECTION_LOST: code=1006 reason=",
    "editor.screenshot failed: CONNECTION_LOST: socket closed",
    "Not connected to Unity",
    "WebSocket is not open",
  ]) {
    const lines = unityConnectionLostHint(new Error(message));
    assert.ok(lines, `must recognise: ${message}`);
    assert.match(lines!.join("\n"), /Lost the connection to Unity mid-run/);
    assert.match(lines!.join("\n"), /no verdict about the game/);
  }
});

test("unityConnectionLostHint: any OTHER error → null, and it never claims the port-scan hint", () => {
  assert.equal(unityConnectionLostHint(new Error("NOT_FOUND: locator")), null);
  assert.equal(unityConnectionLostHint(new Error("disk full")), null);
  assert.equal(unityConnectionLostHint(null), null);
  // The two hints stay distinct: a mid-run drop has no attempted-port diagnostics to quote,
  // which is exactly why the client's throw is NOT renamed to UnityConnectionError.
  assert.equal(unityConnectionHint(new Error("CONNECTION_LOST: code=1006")), null);
  assert.doesNotMatch(
    unityConnectionLostHint(new Error("CONNECTION_LOST: code=1006"))!.join("\n"),
    /tried ports/,
  );
});
