/**
 * `cli-ui` — the shared icon vocabulary + helpers. Focus: `unityConnectionHint` turns the
 * bridge's wall-of-ECONNREFUSED failure into ONE clear, actionable line (Unity isn't open),
 * and leaves every OTHER error to the caller's normal handling.
 */

import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ICON, nextStepLines, tildify, unityConnectionHint } from "../loombridge/cli-ui.js";

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
