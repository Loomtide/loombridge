import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { deflateSync } from "node:zlib";

import {
  applyVisualDiff,
  captureCoverageNotices,
  discoverReports,
  discoverTraces,
  mostRecentReportId,
  mostRecentTraceId,
  observeDropNotices,
  traceDemonstration,
  parseStateSignal,
  readEnter,
  replayExitCode,
  resolveAutoStateSignal,
  run,
  traceIdFromScenePath,
} from "../../../../capabilities/replay/trace.js";
import { loadTraceBaselineManifest } from "../../../../capabilities/replay/trace-baseline-manifest.js";
import { flatReplayLayout, standardReplayLayout } from "../../../../domain/state.js";
import type { ReplayLiveClient } from "../../../../capabilities/replay/run-live.js";
import type { ReplayRunArtifact } from "../../../../capabilities/replay/types.js";

test("parseStateSignal: <path>:<Component>:<property> → meta shape", () => {
  assert.deepEqual(parseStateSignal("/Canvas/GM:ChefGameManager:phase"), {
    locator: { path: "/Canvas/GM" },
    component: "ChefGameManager",
    property: "phase",
  });
});

test("parseStateSignal: a malformed value (no colons / too few parts / empty part) is rejected (null)", () => {
  for (const bad of ["phase", "/Canvas/GM:phase", ":ChefGameManager:phase", "/Canvas/GM::phase", "/Canvas/GM:Comp:phase:extra"]) {
    assert.equal(parseStateSignal(bad), null, `expected ${JSON.stringify(bad)} to be rejected`);
  }
});

// --- observe drop notices (the honest "we saw it, we did not record it" lines) ---------------

test("observeDropNotices: reports taps swallowed while the Game view was unfocused", () => {
  const lines = observeDropNotices({ droppedNoTarget: 0, droppedUnfocused: 2 });
  assert.equal(lines.length, 1);
  assert.equal(
    lines[0],
    "[loombridge trace] ignored 2 tap(s) while the Game view was unfocused (the game never received them).",
  );
});

test("observeDropNotices: an older bridge (no droppedUnfocused) prints only the inert-tap line", () => {
  // The field is absent from the observe_stop payload, so the CLI must not invent a
  // focus notice (and must not print "undefined"): the inert line is the only output.
  const lines = observeDropNotices({ droppedNoTarget: 3 });
  assert.deepEqual(lines, [
    "[loombridge trace] ignored 3 inert tap(s) (no interactive target — backdrop/empty space).",
  ]);
});

test("observeDropNotices: both counts print both lines; zero counts print nothing", () => {
  assert.equal(observeDropNotices({ droppedNoTarget: 1, droppedUnfocused: 1 }).length, 2);
  assert.deepEqual(observeDropNotices({ droppedNoTarget: 0, droppedUnfocused: 0 }), []);
  assert.deepEqual(observeDropNotices({ droppedNoTarget: 0 }), []);
});

test("observeDropNotices: dropped Cmd/Win key edges are REPORTED (a dropped human input is never silent)", () => {
  const lines = observeDropNotices({ droppedNoTarget: 0, droppedOsModifier: 5 });
  assert.deepEqual(lines, [
    "[loombridge trace] ignored 5 Cmd/Win key edge(s) — OS window-manager input (focusing the Game view), " +
      "not gameplay. Ctrl/Alt/Shift are always kept.",
  ]);
  // Zero, or absent (nothing was dropped), prints nothing.
  assert.deepEqual(observeDropNotices({ droppedNoTarget: 0, droppedOsModifier: 0 }), []);
  assert.deepEqual(observeDropNotices({ droppedNoTarget: 0 }), []);
});

test("trace record: a malformed --state-signal (no colons) is a usage error (exit 2)", async () => {
  assert.equal(
    await run(["record", "--observe", "--id", "x", "--scene", "S", "--state-signal", "phase"]),
    2,
  );
});

test("replay layouts: standard nests under .loombridge/replays/, flat sits directly under root", () => {
  const std = standardReplayLayout("/proj");
  assert.equal(std.replayTraces, path.join("/proj", ".loombridge", "replays", "traces"));
  assert.equal(std.replayReports, path.join("/proj", ".loombridge", "replays", "reports"));
  assert.equal(std.replayBaselines, path.join("/proj", ".loombridge", "replays", "baselines"));

  const flat = flatReplayLayout("/ws");
  assert.equal(flat.replays, "/ws");
  assert.equal(flat.replayTraces, path.join("/ws", "traces"));
  assert.equal(flat.replayReports, path.join("/ws", "reports")); // shared with the verify report
  assert.equal(flat.replayBaselines, path.join("/ws", "baseline"));
});

async function writeReport(
  root: string,
  id: string,
  captures: Array<{ id: string; artifact: string }>,
): Promise<void> {
  const reports = path.join(root, ".loombridge", "replays", "reports");
  await fs.mkdir(reports, { recursive: true });
  const artifact = {
    traceId: id,
    status: "pass",
    resetTier: "scene-load",
    segments: [{ id: "s", status: "pass", anchorsReached: [], captures }],
    assertions: [],
    console: { status: "pass", errorCount: 0, errors: [] },
    startedAt: "t",
    finishedAt: "t",
    durationMs: 1,
  };
  await fs.writeFile(path.join(reports, `${id}.report.json`), JSON.stringify(artifact));
}

/**
 * Plant the trace `approve` binds its baseline manifest to. An approval that cannot
 * name the demonstration it froze is refused (exit 2), so every approve fixture has
 * to carry one, the same thing a real run has after `trace record`.
 */
async function writeTrace(root: string, id: string): Promise<string> {
  const traces = path.join(root, ".loombridge", "replays", "traces");
  await fs.mkdir(traces, { recursive: true });
  const file = path.join(traces, `${id}.trace.json`);
  await fs.writeFile(
    file,
    JSON.stringify({
      schemaVersion: "0.1",
      id,
      start: { scene: "Assets/Scenes/Game.unity", reset: "scene-load" },
      input: { backend: "ui-events" },
      segments: [{ id: "s", actions: [] }],
      outcome: { expected: "success" },
    }),
  );
  return file;
}

// These cases never touch the Unity bridge: `--id` validation rejects before
// any `replay`, and the `report` subcommand only reads/writes local files.

test("trace: no args → usage error (exit 2)", async () => {
  assert.equal(await run([]), 2);
});

test("trace replay: a path-traversal --id is rejected before driving (exit 2)", async () => {
  assert.equal(await run(["replay", "--id", "../../etc/x"]), 2);
});

test("trace report: a path-traversal --id is rejected (exit 2)", async () => {
  assert.equal(await run(["report", "--id", "../../etc/x"]), 2);
});

test("trace replay: --id given a flag-like value is rejected (exit 2)", async () => {
  assert.equal(await run(["replay", "--id", "--root"]), 2);
});

test("trace replay-all: no traces is a friendly failure (exit 1), never touches the bridge", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "trace-fleet-"));
  try {
    assert.equal(await run(["replay-all", "--root", root]), 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("trace replay-all: --id is not required (no usage error)", async () => {
  // With no traces it returns 1 (business), NOT 2 (usage) — proving --id is optional here.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "trace-fleet-"));
  try {
    assert.notEqual(await run(["replay-all", "--root", root]), 2);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("trace replay-all: a bad trace does NOT abort the fleet — the roll-up is still written", async () => {
  // Both traces fail at parse (before any bridge call): malformed JSON and an
  // invalid-shape trace. The fleet must record both as errors, write the report,
  // and exit 1 — not abort on the first and discard the roll-up (review F1).
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "trace-fleet-"));
  try {
    const traces = path.join(root, ".loombridge", "replays", "traces");
    await fs.mkdir(traces, { recursive: true });
    await fs.writeFile(path.join(traces, "a.trace.json"), "this is not json{");
    await fs.writeFile(path.join(traces, "b.trace.json"), "{}"); // valid json, invalid trace

    assert.equal(await run(["replay-all", "--root", root]), 1);

    const fleetJson = path.join(root, ".loombridge", "replays", "fleet.report.json");
    const fleet = JSON.parse(await fs.readFile(fleetJson, "utf8"));
    assert.equal(fleet.status, "fail");
    assert.equal(fleet.counts.total, 2, "both traces are recorded, not dropped");
    assert.ok(fleet.traces.every((t: { error?: string }) => t.error), "each carries an error");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// `record` arg validation — these reject before any connect/bridge call.

test("trace record: a malformed --scene (non-asset path) → usage error (exit 2)", async () => {
  // `--scene` is now OPTIONAL (omitted ⇒ the recorder resolves the active scene), but a GIVEN value must
  // be a real Assets/**.unity path — a bare name / traversal is still a usage error before any connect.
  assert.equal(await run(["record", "--id", "x", "--observe", "--scene", "NotAScene"]), 2);
  assert.equal(await run(["record", "--id", "x", "--observe", "--scene", "../escape.unity"]), 2);
});

test("trace record: a path-traversal --id is rejected (exit 2)", async () => {
  assert.equal(await run(["record", "--id", "../../etc/x", "--scene", "Assets/S.unity", "--observe"]), 2);
});

test("trace record: a non-positive --duration is rejected (exit 2)", async () => {
  assert.equal(await run(["record", "--id", "x", "--scene", "Assets/S.unity", "--observe", "--duration", "0"]), 2);
  assert.equal(await run(["record", "--id", "x", "--scene", "Assets/S.unity", "--observe", "--duration", "nope"]), 2);
});

test("trace record: readEnter refuses a non-TTY stdin (would hang holding Play Mode)", async () => {
  // The test runner's stdin is not a TTY, so the interactive pause must refuse and
  // point at --duration rather than wait forever for an Enter that can't come.
  assert.equal(process.stdin.isTTY, undefined);
  await assert.rejects(() => readEnter("prompt"), /not a TTY.*--duration/s);
});

// ─────────────── `trace record` ergonomics: no required flags, derived id, auto signal ───────────────
//
// These drive the WHOLE verb (argv → runRecord → the real observeRecordLive/recordObservedTrace
// → the real id derivation and trace write) against a scripted bridge injected through the
// existing `clientFactory` door. No Unity editor is involved, and nothing here re-implements
// the behaviour it is checking: every assertion reads a file the production code wrote or a
// bridge param the production code sent.

interface RecordedCall {
  command: string;
  params: Record<string, unknown>;
}

/** The one gesture the observer "saw", so the transform has something real to build from. */
const ONE_CLICK = [{ tMs: 0, locator: { path: "/HUD/Start" }, button: 0, kind: "ui" }];

/**
 * A scripted bridge that answers a whole observe-recording: active-scene resolution, the
 * reset cycle (defaulted), observe_start/observe_stop, teardown. Returns the `clientFactory`
 * the trace verb already accepts, plus the call log.
 */
function recordBridge(
  over: Record<string, (params: Record<string, unknown>) => { data?: unknown; error?: string }> = {},
): { factory: () => ReplayLiveClient; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const handlers = {
    "scene.get_active": () => ({
      data: { scene_name: "KidsChef", scene_path: "Assets/Scenes/KidsChef.unity", is_saved: true },
    }),
    "input.observe_stop": () => ({ data: { clicks: ONE_CLICK, observed: true } }),
    ...over,
  } as Record<string, (params: Record<string, unknown>) => { data?: unknown; error?: string }>;
  const send = async (command: string, params: Record<string, unknown>) => {
    calls.push({ command, params });
    const result = (handlers[command] ?? (() => ({ data: {} })))(params);
    if (result.error !== undefined) {
      return {
        id: "t",
        timestamp: 0,
        status: "error" as const,
        data: null,
        error: { code: "X", message: result.error },
      };
    }
    return { id: "t", timestamp: 0, status: "success" as const, data: result.data ?? {} };
  };
  const factory = (): ReplayLiveClient => ({
    isConnected: true,
    waitForReconnect: async () => true,
    connect: async () => ({}),
    send,
    disconnect: async () => {},
  });
  return { factory, calls };
}

/** Run the verb with stderr captured (the derived-id notices are printed there). */
async function capturedRun(
  argv: string[],
  opts: Parameters<typeof run>[1],
): Promise<{ exit: number; err: string }> {
  const original = console.error;
  let err = "";
  console.error = (...parts: unknown[]) => {
    err += `${parts.map(String).join(" ")}\n`;
  };
  try {
    const exit = await run(argv, opts);
    return { exit, err };
  } finally {
    console.error = original;
  }
}

async function recordRoot(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "trace-record-"));
}

function tracesDir(root: string): string {
  return standardReplayLayout(root).replayTraces;
}

test("trace record: BARE `trace record` records; neither --observe nor --id is required", async () => {
  // LITMUS: restore the `if (!observe) { … return usageError }` refusal in parseArgs (or the
  // `sub !== "record"` exemption on the --id requirement) and this exits 2 with no trace on
  // disk. Verified by doing exactly that against this test: it failed on `exit 2`, then passed
  // once the refusals were removed again.
  const root = await recordRoot();
  try {
    const { factory } = recordBridge();
    const { exit, err } = await capturedRun(
      ["record", "--root", root, "--duration", "0.01"],
      { clientFactory: factory },
    );
    assert.equal(exit, 0, err);
    const written = JSON.parse(
      await fs.readFile(path.join(tracesDir(root), "kids-chef.trace.json"), "utf8"),
    ) as { id: string; start: { scene: string } };
    assert.equal(written.id, "kids-chef", "the id is derived from the RESOLVED scene");
    assert.equal(written.start.scene, "Assets/Scenes/KidsChef.unity");
    assert.match(err, /no --id given, recording as "kids-chef"/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("trace record: --observe is still accepted and changes nothing (byte-identical trace)", async () => {
  const bare = await recordRoot();
  const legacy = await recordRoot();
  try {
    const withoutFlag = await capturedRun(["record", "--root", bare, "--duration", "0.01"], {
      clientFactory: recordBridge().factory,
    });
    const withFlag = await capturedRun(
      ["record", "--observe", "--root", legacy, "--duration", "0.01"],
      { clientFactory: recordBridge().factory },
    );
    assert.equal(withoutFlag.exit, 0, withoutFlag.err);
    assert.equal(withFlag.exit, 0, withFlag.err);
    assert.equal(
      await fs.readFile(path.join(tracesDir(legacy), "kids-chef.trace.json"), "utf8"),
      await fs.readFile(path.join(tracesDir(bare), "kids-chef.trace.json"), "utf8"),
      "the legacy flag selects nothing, so it must produce the same trace",
    );
  } finally {
    await fs.rm(bare, { recursive: true, force: true });
    await fs.rm(legacy, { recursive: true, force: true });
  }
});

test("traceIdFromScenePath: basename without .unity, kebab-cased; unusable names refuse (null)", () => {
  // LITMUS: drop the refusal (`return id;`) and both this and the CLI-level refusal test below
  // fail: the derivation hands back an empty id and the recording would write ".trace.json".
  // Verified by doing exactly that.
  //
  // A SECOND LITMUS covers the CamelCase rule: delete either boundary replace and a row here
  // fails. Dropping `([a-z0-9])([A-Z])` gives "kidschef"; dropping `([A-Z]+)([A-Z][a-z])`
  // gives "hudtest". Verified by doing exactly that, one at a time.

  // A CamelCase hump is a word boundary: Unity scene names are conventionally PascalCase, and
  // this id becomes a filename, a baseline directory and a fleet row.
  assert.equal(traceIdFromScenePath("Assets/Scenes/KidsChef.unity"), "kids-chef");
  assert.equal(traceIdFromScenePath("Assets/Scenes/CountTheFruits.unity"), "count-the-fruits");
  assert.equal(traceIdFromScenePath("Assets/Scenes/Level2Boss.unity"), "level2-boss");
  // An acronym run stays one word until a real word starts (never h-u-d-test, never hudtest).
  assert.equal(traceIdFromScenePath("Assets/Scenes/HUDTest.unity"), "hud-test");
  assert.equal(traceIdFromScenePath("Assets/Scenes/TestHUD.unity"), "test-hud");
  assert.equal(traceIdFromScenePath("Assets/Scenes/MyHUD2Test.unity"), "my-hud2-test");
  // Stated separators still split, and an already-kebab name survives byte for byte (no
  // doubled hyphens, no leading/trailing hyphen).
  assert.equal(traceIdFromScenePath("Assets/Scenes/Count The Fruits.unity"), "count-the-fruits");
  assert.equal(traceIdFromScenePath("Assets/Scenes/Count_The_Fruits.unity"), "count-the-fruits");
  assert.equal(traceIdFromScenePath("Assets/Scenes/count-the-fruits.unity"), "count-the-fruits");
  assert.equal(traceIdFromScenePath("Assets/Scenes/Kids-Chef.unity"), "kids-chef");
  assert.equal(traceIdFromScenePath("Assets/Levels/Level 01.unity"), "level-01");
  // A digit run inside one word is NOT a boundary (only lower-or-digit → UPPER is).
  assert.equal(traceIdFromScenePath("Assets/Scenes/Scene01.unity"), "scene01");
  // Nothing usable survives ⇒ null, so the caller asks for an explicit --id rather than
  // inventing a generic name nobody chose.
  assert.equal(traceIdFromScenePath("Assets/Scenes/___.unity"), null);
  assert.equal(traceIdFromScenePath("Assets/Scenes/シーン.unity"), null);
});

test("trace record: a scene whose name yields no safe id REFUSES and names --id (no generic fallback)", async () => {
  const root = await recordRoot();
  try {
    const { factory } = recordBridge({
      "scene.get_active": () => ({
        data: { scene_name: "___", scene_path: "Assets/Scenes/___.unity", is_saved: true },
      }),
    });
    const { exit, err } = await capturedRun(["record", "--root", root, "--duration", "0.01"], {
      clientFactory: factory,
    });
    assert.notEqual(exit, 0);
    assert.match(err, /cannot derive a trace id.*Pass --id <name>/s);
    assert.deepEqual(
      await fs.readdir(tracesDir(root)).catch(() => []),
      [],
      "a refused derivation writes no trace at all",
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("trace record: a DERIVED id never overwrites; it lands at <id>-2 and the original is untouched", async () => {
  // LITMUS: delete the suffixing loop in `deriveRecordId` (return `base` straight) and this
  // fails on the byte comparison: the pre-existing trace comes back rewritten. Verified by
  // doing exactly that: the run overwrote kids-chef.trace.json and the assertion caught it.
  const root = await recordRoot();
  try {
    await fs.mkdir(tracesDir(root), { recursive: true });
    const original = path.join(tracesDir(root), "kids-chef.trace.json");
    const originalBytes = '{"this":"is someone else\'s recording"}\n';
    await fs.writeFile(original, originalBytes, "utf8");

    const { exit, err } = await capturedRun(["record", "--root", root, "--duration", "0.01"], {
      clientFactory: recordBridge().factory,
    });
    assert.equal(exit, 0, err);

    assert.equal(
      await fs.readFile(original, "utf8"),
      originalBytes,
      "the existing trace must be byte-identical afterwards",
    );
    const second = JSON.parse(
      await fs.readFile(path.join(tracesDir(root), "kids-chef-2.trace.json"), "utf8"),
    ) as { id: string };
    assert.equal(second.id, "kids-chef-2", "the trace's own id matches the file it landed in");
    assert.match(err, /recording as "kids-chef-2"/);
    assert.match(err, /re-record it with: --id kids-chef\b/, "it says how to re-record the original");

    // And a THIRD recording keeps counting rather than stopping at -2.
    const third = await capturedRun(["record", "--root", root, "--duration", "0.01"], {
      clientFactory: recordBridge().factory,
    });
    assert.equal(third.exit, 0, third.err);
    assert.ok(
      await fs.stat(path.join(tracesDir(root), "kids-chef-3.trace.json")).then(() => true),
      "the suffix keeps climbing",
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("trace record: an EXPLICIT --id still overwrites (unchanged) and is never suffixed", async () => {
  const root = await recordRoot();
  try {
    await fs.mkdir(tracesDir(root), { recursive: true });
    const target = path.join(tracesDir(root), "happy-path.trace.json");
    await fs.writeFile(target, '{"stale":true}\n', "utf8");

    const { exit, err } = await capturedRun(
      ["record", "--id", "happy-path", "--root", root, "--duration", "0.01"],
      { clientFactory: recordBridge().factory },
    );
    assert.equal(exit, 0, err);
    const written = JSON.parse(await fs.readFile(target, "utf8")) as { id: string };
    assert.equal(written.id, "happy-path", "the named trace was re-recorded in place");
    assert.deepEqual(
      (await fs.readdir(tracesDir(root))).sort(),
      ["happy-path.trace.json"],
      "an explicit id never grows a -2 sibling",
    );
    assert.doesNotMatch(err, /no --id given/, "the derivation path is inert when --id was typed");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// --- auto state-signal precedence (the pure table, then the same table through the CLI) ---

test("resolveAutoStateSignal: the four rows of the precedence table", () => {
  // LITMUS: make the default win over a declaration (`if (flag !== undefined) return flag;
  // return true;`) and row 2 fails. Verified by doing exactly that.
  assert.equal(resolveAutoStateSignal(undefined, false), true, "neither typed ⇒ ON (the new default)");
  assert.equal(resolveAutoStateSignal(undefined, true), false, "--state-signal alone ⇒ the declaration wins");
  assert.equal(resolveAutoStateSignal(true, true), true, "--auto-state-signal still beats --state-signal");
  assert.equal(resolveAutoStateSignal(true, false), true, "--auto-state-signal alone ⇒ ON");
  assert.equal(resolveAutoStateSignal(false, false), false, "--no-auto-state-signal ⇒ OFF");
  assert.equal(resolveAutoStateSignal(false, true), false, "--no-auto-state-signal ⇒ OFF even with a declaration");
});

/**
 * Drive a real recording and report what `input.observe_start` was actually asked for. This
 * is the wiring half of the table: the resolver above could be perfect and still not reach
 * the bridge.
 */
async function observeStartParams(extraArgs: string[]): Promise<Record<string, unknown>> {
  const root = await recordRoot();
  try {
    const { factory, calls } = recordBridge();
    const { exit, err } = await capturedRun(
      ["record", "--root", root, "--duration", "0.01", ...extraArgs],
      { clientFactory: factory },
    );
    assert.equal(exit, 0, err);
    const start = calls.find((c) => c.command === "input.observe_start");
    assert.ok(start, "the recording never started observing");
    return start.params;
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("trace record precedence (wired): nothing typed ⇒ auto-detection ON", async () => {
  const params = await observeStartParams([]);
  assert.equal(params.autoDetectStateSignal, true);
});

test("trace record precedence (wired): --state-signal alone ⇒ the declared signal wins, auto OFF", async () => {
  // LITMUS: default the flag to `true` instead of `!hasDeclaredStateSignal` and this fails:
  // the declared signal disappears from observe_start and autoDetectStateSignal shows up.
  const params = await observeStartParams(["--state-signal", "/Canvas/GM:ChefGameManager:phase"]);
  assert.equal("autoDetectStateSignal" in params, false, "a default must never beat a declaration");
  assert.deepEqual(params.stateSignal, {
    path: "/Canvas/GM",
    component: "ChefGameManager",
    property: "phase",
  });
});

test("trace record precedence (wired): --auto-state-signal wins even alongside --state-signal", async () => {
  const params = await observeStartParams([
    "--auto-state-signal",
    "--state-signal",
    "/Canvas/GM:ChefGameManager:phase",
  ]);
  assert.equal(params.autoDetectStateSignal, true, "the documented precedence is preserved");
  assert.equal("stateSignal" in params, false, "the two modes stay exclusive");
});

test("trace record precedence (wired): --no-auto-state-signal forces auto OFF", async () => {
  const bare = await observeStartParams(["--no-auto-state-signal"]);
  assert.deepEqual(bare, {}, "the explicit opt out leaves observe_start with no signal at all");

  const declared = await observeStartParams([
    "--no-auto-state-signal",
    "--state-signal",
    "/Canvas/GM:ChefGameManager:phase",
  ]);
  assert.equal("autoDetectStateSignal" in declared, false);
  assert.deepEqual(declared.stateSignal, {
    path: "/Canvas/GM",
    component: "ChefGameManager",
    property: "phase",
  });
});

// ─────────────── `trace replay` ergonomics: bare replay defaults to the most recent trace ───────────────
//
// These drive the WHOLE verb (argv → runReplay → the real id resolution → the real
// replayOneTrace → the real engine/driver) against a scripted bridge injected through the
// existing `clientFactory` door, so no Unity editor is ever reachable: `runLiveReplay` only
// constructs a discovering `UnityClient` when neither `client` nor `clientFactory` is given.
//
// The bridge REFUSES the reset's `scene.open_scene`, so the engine reports `blocked` before
// driving a single segment, and `replayOneTrace` still writes `<chosen-id>.report.json`. That
// file is the observable: it is written by production code and NAMED by the id the CLI chose,
// so nothing here re-implements the selection it is checking.

/** The scripted bridge above: everything default-answered except a refused scene open. */
function replayBridge(): ReturnType<typeof recordBridge> {
  return recordBridge({ "scene.open_scene": () => ({ error: "scripted: reset refused" }) });
}

function reportsDir(root: string): string {
  return standardReplayLayout(root).replayReports;
}

/** Write `<id>.trace.json` and stamp its mtime `minutesAgo` minutes into the past. */
async function writeTraceAged(root: string, id: string, minutesAgo: number): Promise<void> {
  const file = await writeTrace(root, id);
  const when = new Date(Date.now() - minutesAgo * 60_000);
  await fs.utimes(file, when, when);
}

test("trace replay: bare, with several traces on disk, replays the NEWEST by mtime", async () => {
  // LITMUS: flip the mtime comparison in `mostRecentIdByMtime` (the sort `mostRecentTraceId`
  // shares with the `approve` default) to `a.mtimeMs - b.mtimeMs` (the reversed sort) and
  // this fails, observed verbatim:
  //   AssertionError [ERR_ASSERTION]: The input did not match the regular expression
  //   /no --id given, replaying the most recent trace "newest"/. Input:
  //   '[loombridge trace] no --id given, replaying the most recent trace "oldest".\n' +
  //     '[loombridge trace] oldest: BLOCKED (reset-unavailable)\n' + …
  // Verified by doing exactly that, then restoring it and watching it pass.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "trace-recent-"));
  try {
    await writeTraceAged(root, "oldest", 30);
    await writeTraceAged(root, "newest", 1);
    await writeTraceAged(root, "middle", 10);

    const bridge = replayBridge();
    const { exit, err } = await capturedRun(["replay", "--root", root], {
      clientFactory: bridge.factory,
    });
    assert.match(err, /no --id given, replaying the most recent trace "newest"/);
    // The scripted reset refuses, so the run is BLOCKED: the harness tier (2), which is
    // exactly what a replay that never formed an opinion about the game must report.
    assert.equal(exit, 2, err);

    const report = JSON.parse(
      await fs.readFile(path.join(reportsDir(root), "newest.report.json"), "utf8"),
    ) as { traceId: string; status: string };
    assert.equal(report.traceId, "newest", "the report names the trace the CLI chose");
    assert.equal(report.status, "blocked");
    // The losers were never driven: no report exists under their names.
    await assert.rejects(fs.access(path.join(reportsDir(root), "oldest.report.json")));
    await assert.rejects(fs.access(path.join(reportsDir(root), "middle.report.json")));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("trace replay: IDENTICAL mtimes tie-break by name, the same way on every call", async () => {
  // A fresh `git clone` writes every trace in one burst, so equal mtimes are the normal
  // case. An arbitrary pick that varied between two runs of the same command would make
  // "replay, then read the report" unreproducible, so the tie-break is deterministic.
  //
  // LITMUS (two steps, because a stable sort hides a missing tie-break): drop the
  // `|| (a.id < b.id ? …)` clause from `mostRecentIdByMtime` (the sort `mostRecentTraceId`
  // shares with the `approve` default) AND reverse `discoverTraces`' ordering
  // (`.sort().reverse()`). This then fails, observed verbatim:
  //   AssertionError [ERR_ASSERTION]: tie-break winner on call 0
  //   'charlie' !== 'alpha'
  // Step two: restore the tie-break clause alone, LEAVING `discoverTraces` reversed, and
  // this passes again (only the unrelated `discoverTraces` ordering test still fails).
  // That second step is the real assertion: the winner must not depend on the discovery
  // order, so the tie-break has to be explicit rather than inherited from sort stability.
  // Verified by doing exactly that, then restoring both.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "trace-tie-"));
  try {
    const same = new Date(Date.now() - 5 * 60_000);
    for (const id of ["charlie", "alpha", "bravo"]) {
      await fs.utimes(await writeTrace(root, id), same, same);
    }
    const traces = standardReplayLayout(root).replayTraces;
    for (let call = 0; call < 5; call += 1) {
      assert.equal(await mostRecentTraceId(traces), "alpha", `tie-break winner on call ${call}`);
    }

    // …and the wired verb agrees with the function (no second, divergent selection path).
    const { err } = await capturedRun(["replay", "--root", root], {
      clientFactory: replayBridge().factory,
    });
    assert.match(err, /no --id given, replaying the most recent trace "alpha"/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("trace replay: bare with NO traces REFUSES (exit 2), names `trace record`, never touches the bridge", async () => {
  // LITMUS: delete the `if (recent === null) { … return null; }` refusal from
  // `resolveReplayTargetId` (`if (recent === null) return "";` instead) and this fails: the
  // empty id falls through to the loader, which opens a path nobody typed. Observed verbatim:
  //   AssertionError [ERR_ASSERTION]: missing traces dir: [loombridge trace] fatal: ENOENT:
  //   no such file or directory, open '/…/trace-none-g2TFyf/.loombridge/replays/traces/.trace.json'
  //   1 !== 2
  // Verified by doing exactly that, then restoring it and watching it pass.
  const missing = await fs.mkdtemp(path.join(os.tmpdir(), "trace-none-"));
  const empty = await fs.mkdtemp(path.join(os.tmpdir(), "trace-none-"));
  try {
    // (a) the traces directory does not exist at all, and (b) it exists and is empty:
    // both are "nothing to replay", and both must refuse identically.
    await fs.mkdir(standardReplayLayout(empty).replayTraces, { recursive: true });

    for (const [label, root] of [["missing traces dir", missing], ["empty traces dir", empty]] as const) {
      const bridge = replayBridge();
      const { exit, err } = await capturedRun(["replay", "--root", root], {
        clientFactory: bridge.factory,
      });
      assert.equal(exit, 2, `${label}: ${err}`);
      assert.match(err, /there is nothing to replay/, label);
      assert.match(err, /loombridge trace record/, `${label}: the refusal names the recording verb`);
      assert.deepEqual(bridge.calls, [], `${label}: refuses before any bridge call`);
    }
  } finally {
    await fs.rm(missing, { recursive: true, force: true });
    await fs.rm(empty, { recursive: true, force: true });
  }
});

test("trace replay --id: an explicit id is replayed as-is and the most-recent search never runs", async () => {
  // The whole default path must be INERT for existing callers, so the trace asked for here
  // is deliberately NOT the newest one on disk.
  //
  // LITMUS: drop the `if (args.id) return args.id;` short-circuit from
  // `resolveReplayTargetId` and this fails, observed verbatim:
  //   AssertionError [ERR_ASSERTION]: nothing was defaulted
  //   actual: '[loombridge trace] no --id given, replaying the most recent trace "newest".\n…'
  //   expected: /no --id given/  operator: 'doesNotMatch'
  // (the report also lands under "newest" rather than the "oldest" that was asked for).
  // Verified by doing exactly that, then restoring it and watching it pass.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "trace-explicit-"));
  try {
    await writeTraceAged(root, "oldest", 30);
    await writeTraceAged(root, "newest", 1);

    const { exit, err } = await capturedRun(["replay", "--id", "oldest", "--root", root], {
      clientFactory: replayBridge().factory,
    });
    assert.equal(exit, 2, err);
    assert.doesNotMatch(err, /no --id given/, "nothing was defaulted");
    const report = JSON.parse(
      await fs.readFile(path.join(reportsDir(root), "oldest.report.json"), "utf8"),
    ) as { traceId: string };
    assert.equal(report.traceId, "oldest");
    await assert.rejects(fs.access(path.join(reportsDir(root), "newest.report.json")));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("trace replay --trace: an explicit file wins over the most-recent search; the trace names its own report", async () => {
  // `--trace` names an exact file, which is a stronger statement than "the newest one", so
  // the search must not run. With no --id the trace's OWN id names the output, which is
  // what `--id <that id>` would have produced.
  //
  // LITMUS: delete the `if (args.tracePath !== undefined)` branch from
  // `resolveReplayTargetId` and this fails: the search runs, picks the newer in-directory
  // trace, and the report lands under the wrong name. Observed verbatim:
  //   AssertionError [ERR_ASSERTION]: The input did not match the regular expression
  //   /no --id given, replaying "external-trace" from/. Input:
  //   '[loombridge trace] no --id given, replaying the most recent trace "in-dir".\n' +
  //     '[loombridge trace] warning: trace id "external-trace" != "in-dir"; using "in-dir"
  //      for output paths.\n' + …
  // Verified by doing exactly that, then restoring it and watching it pass.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "trace-explicit-file-"));
  try {
    // A NEWER trace inside the traces directory: the one the search would have picked.
    await writeTraceAged(root, "in-dir", 0);
    // The explicitly named file lives outside the traces directory and is OLDER.
    const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), "trace-outside-"));
    const outside = await writeTrace(outsideRoot, "external-trace");

    const { exit, err } = await capturedRun(["replay", "--trace", outside, "--root", root], {
      clientFactory: replayBridge().factory,
    });
    try {
      assert.equal(exit, 2, err);
      assert.match(err, /no --id given, replaying "external-trace" from/);
      assert.doesNotMatch(err, /most recent/, "the search must not have run");
      const report = JSON.parse(
        await fs.readFile(path.join(reportsDir(root), "external-trace.report.json"), "utf8"),
      ) as { traceId: string };
      assert.equal(report.traceId, "external-trace");
      await assert.rejects(fs.access(path.join(reportsDir(root), "in-dir.report.json")));

      // …and `--trace` WITH `--id` is unchanged: the id still names the output paths and the
      // mismatch against the file's own id is still warned about, exactly as before.
      const explicit = await capturedRun(
        ["replay", "--trace", outside, "--id", "renamed", "--root", root],
        { clientFactory: replayBridge().factory },
      );
      assert.match(explicit.err, /trace id "external-trace" != "renamed"/);
      await fs.access(path.join(reportsDir(root), "renamed.report.json"));
    } finally {
      await fs.rm(outsideRoot, { recursive: true, force: true });
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ─────────────── `trace approve` ergonomics: bare approve freezes the most recent RUN ───────────────
//
// The sibling of the `trace replay` block above, with ONE deliberate difference: `approve`
// promotes the captures of a COMPLETED RUN, so it selects the most recent REPORT, never the
// most recent trace. These drive the whole verb (argv → runApprove → the real id resolution →
// the real promotion) and never touch the bridge at all: approve is a pure file operation.
//
// The observable is the BASELINE DIRECTORY production code wrote, named by the id the CLI
// chose, so nothing here re-implements the selection it is checking.

function baselinesDir(root: string): string {
  return standardReplayLayout(root).replayBaselines;
}

/**
 * Plant a COMPLETED RUN: `<id>.report.json` with `captures` promotable captures, the trace it
 * binds to, and the report's mtime stamped `minutesAgo` minutes into the past.
 */
async function writeRunAged(
  root: string,
  id: string,
  opts: { minutesAgo: number; captures?: number },
): Promise<void> {
  const actualDir = path.join(reportsDir(root), id, "actual");
  await fs.mkdir(actualDir, { recursive: true });
  const captures: Array<{ id: string; artifact: string }> = [];
  for (let i = 0; i < (opts.captures ?? 1); i += 1) {
    const artifact = path.join(actualDir, `cap${i}.png`);
    await fs.writeFile(artifact, Buffer.from(`png-${id}-${i}`));
    captures.push({ id: `cap${i}`, artifact });
  }
  await writeReport(root, id, captures);
  await writeTrace(root, id);
  const when = new Date(Date.now() - opts.minutesAgo * 60_000);
  await fs.utimes(path.join(reportsDir(root), `${id}.report.json`), when, when);
}

test("trace approve: bare, with several runs on disk, freezes the NEWEST report by mtime", async () => {
  // LITMUS: flip the mtime comparison in `mostRecentIdByMtime` to `a.mtimeMs - b.mtimeMs`
  // (the reversed sort) and this fails, observed verbatim:
  //   AssertionError [ERR_ASSERTION]: The input did not match the regular expression
  //   /no --id given, approving the most recent run "newest"/. Input:
  //   '[loombridge trace] no --id given, approving the most recent run "oldest".\n' +
  //     '[loombridge trace]   that run holds 1 capture(s), and approving freezes them as the
  //      approved baseline for "oldest".\n' + …
  // Verified by doing exactly that, then restoring it and watching it pass.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "approve-recent-"));
  try {
    await writeRunAged(root, "oldest", { minutesAgo: 30 });
    await writeRunAged(root, "newest", { minutesAgo: 1 });
    await writeRunAged(root, "middle", { minutesAgo: 10 });

    const { exit, err } = await capturedRun(["approve", "--root", root], {});
    assert.equal(exit, 0, err);
    assert.match(err, /no --id given, approving the most recent run "newest"/);

    // The baseline production code wrote is the observable: the loser runs were never frozen.
    assert.deepEqual(
      await fs.readFile(path.join(baselinesDir(root), "newest", "cap0.png")),
      Buffer.from("png-newest-0"),
    );
    await assert.rejects(fs.access(path.join(baselinesDir(root), "oldest")));
    await assert.rejects(fs.access(path.join(baselinesDir(root), "middle")));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("trace approve: the default selects the most recent REPORT, never the most recent TRACE", async () => {
  // THE TEST THAT PROVES THE TWO VERBS DELIBERATELY DIFFER. `approve` promotes the captures
  // of a run that HAPPENED, so a trace recorded after that run is not a candidate: it has no
  // report, nothing was ever replayed from it, and there is nothing to promote. Reusing
  // `replay`'s trace-based search would pick it and then fail with "no report at
  // reports/recorded-later.report.json" for an id nobody typed.
  //
  // LITMUS: swap the search in `resolveApproveTargetId` to the trace-based one
  // (`await mostRecentTraceId(paths.replayTraces)`) and this fails, observed verbatim:
  //   AssertionError [ERR_ASSERTION]: [loombridge trace] no --id given, approving the most
  //   recent run "recorded-later".
  //   [loombridge trace] no report at .loombridge/replays/reports/recorded-later.report.json
  //   — run 'trace replay --id recorded-later' first.
  //
  //   1 !== 0
  // Verified by doing exactly that, then restoring it and watching it pass.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "approve-vs-trace-"));
  try {
    // The run that should win: replayed a while ago, so its REPORT is the newest report…
    await writeRunAged(root, "replayed", { minutesAgo: 10 });
    // …while a trace recorded SINCE then is the newest TRACE on disk and has no report.
    const laterTrace = await writeTrace(root, "recorded-later");
    const now = new Date();
    await fs.utimes(laterTrace, now, now);
    // Belt and braces: the winner's own trace is older than the decoy's, so a trace-based
    // pick cannot land on "replayed" by accident.
    const older = new Date(Date.now() - 60 * 60_000);
    await fs.utimes(path.join(tracesDir(root), "replayed.trace.json"), older, older);

    const { exit, err } = await capturedRun(["approve", "--root", root], {});
    assert.equal(exit, 0, err);
    assert.match(err, /no --id given, approving the most recent run "replayed"/);
    await fs.access(path.join(baselinesDir(root), "replayed", "cap0.png"));
    await assert.rejects(
      fs.access(path.join(baselinesDir(root), "recorded-later")),
      "a trace that was never replayed must never be approved",
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("trace approve: IDENTICAL mtimes tie-break by name, the same way on every call", async () => {
  // Same correctness requirement as the replay default: a fresh clone or a copied workspace
  // writes every file in one burst, so equal mtimes are the normal case, and a winner that
  // varied between two runs of the same command would make an approval unreproducible.
  //
  // LITMUS (two steps, because a stable sort hides a missing tie-break): drop the
  // `|| (a.id < b.id ? …)` clause from `mostRecentIdByMtime` AND reverse `discoverReports`'
  // ordering (`.sort().reverse()`). This then fails, observed verbatim:
  //   AssertionError [ERR_ASSERTION]: tie-break winner on call 0
  //   'charlie' !== 'alpha'
  // Step two: restore the tie-break clause alone, LEAVING `discoverReports` reversed, and
  // this passes again. That second step is the real assertion: the winner must not depend on
  // the discovery order. Verified by doing exactly that, then restoring both.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "approve-tie-"));
  try {
    const same = new Date(Date.now() - 5 * 60_000);
    for (const id of ["charlie", "alpha", "bravo"]) {
      await writeRunAged(root, id, { minutesAgo: 5 });
      await fs.utimes(path.join(reportsDir(root), `${id}.report.json`), same, same);
    }
    for (let call = 0; call < 5; call += 1) {
      assert.equal(await mostRecentReportId(reportsDir(root)), "alpha", `tie-break winner on call ${call}`);
    }

    // …and the wired verb agrees with the function (no second, divergent selection path).
    const { err } = await capturedRun(["approve", "--root", root], {});
    assert.match(err, /no --id given, approving the most recent run "alpha"/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("trace approve: bare with NO reports REFUSES (exit 2), names `trace replay`, freezes nothing", async () => {
  // LITMUS: delete the `if (recent === null) { … return null; }` refusal from
  // `resolveApproveTargetId` (`if (recent === null) return "";` instead) and this fails: the
  // empty id falls through to the loader, which names a path nobody typed and exits in the
  // game-defect tier. Observed verbatim:
  //   AssertionError [ERR_ASSERTION]: missing reports dir: [loombridge trace] no report at
  //   .loombridge/replays/reports/.report.json — run 'trace replay --id ' first.
  //
  //   1 !== 2
  // Verified by doing exactly that, then restoring it and watching it pass.
  const missing = await fs.mkdtemp(path.join(os.tmpdir(), "approve-none-"));
  const empty = await fs.mkdtemp(path.join(os.tmpdir(), "approve-none-"));
  try {
    // (a) the reports directory does not exist at all, and (b) it exists and is empty:
    // both are "nothing to approve", and both must refuse identically.
    await fs.mkdir(reportsDir(empty), { recursive: true });
    // A recorded-but-never-replayed trace is still nothing to approve: it is the decoy the
    // trace-based search would have picked, and it must not rescue either case.
    await writeTrace(empty, "recorded-only");

    for (const [label, root] of [["missing reports dir", missing], ["empty reports dir", empty]] as const) {
      const { exit, err } = await capturedRun(["approve", "--root", root], {});
      assert.equal(exit, 2, `${label}: ${err}`);
      assert.match(err, /there is nothing to approve/, label);
      assert.match(err, /loombridge trace replay/, `${label}: the refusal names the replay verb`);
      await assert.rejects(fs.access(baselinesDir(root)), `${label}: nothing was frozen`);
    }
  } finally {
    await fs.rm(missing, { recursive: true, force: true });
    await fs.rm(empty, { recursive: true, force: true });
  }
});

test("trace approve --id: an explicit id is approved as-is and the most-recent search never runs", async () => {
  // The whole default path must be INERT for existing callers, so the run asked for here is
  // deliberately NOT the newest one on disk, and the consent line the default prints must
  // not appear either.
  //
  // LITMUS: drop the `if (args.id) return args.id;` short-circuit from
  // `resolveApproveTargetId` and this fails, observed verbatim:
  //   AssertionError [ERR_ASSERTION]: nothing was defaulted
  //   actual: '[loombridge trace] no --id given, approving the most recent run "newest".\n…'
  //   expected: /no --id given/  operator: 'doesNotMatch'
  // (the baseline also lands under "newest" rather than the "oldest" that was asked for).
  // Verified by doing exactly that, then restoring it and watching it pass.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "approve-explicit-"));
  try {
    await writeRunAged(root, "oldest", { minutesAgo: 30 });
    await writeRunAged(root, "newest", { minutesAgo: 1 });

    const { exit, err } = await capturedRun(["approve", "--id", "oldest", "--root", root], {});
    assert.equal(exit, 0, err);
    assert.doesNotMatch(err, /no --id given/, "nothing was defaulted");
    assert.doesNotMatch(err, /that run holds/, "the explicit path prints what it always did");
    await fs.access(path.join(baselinesDir(root), "oldest", "cap0.png"));
    await assert.rejects(fs.access(path.join(baselinesDir(root), "newest")));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("trace approve: the consent line states the REAL number of captures being frozen", async () => {
  // Naming the run is not enough at the consent moment for an anchor: "the most recent run"
  // reads the same whether it freezes one frame or forty, so the size is printed too. The
  // number is checked against the baselines production code actually wrote, so a hard-coded
  // or off-by-one count cannot pass.
  //
  // LITMUS: hard-code the count (`const promotable = 1;`) in `runApprove` and this fails,
  // observed verbatim:
  //   AssertionError [ERR_ASSERTION]: The input did not match the regular expression
  //   /that run holds 3 capture\(s\)/. Input: '[loombridge trace] no --id given, approving
  //   the most recent run "three-frames".\n' +
  //     '[loombridge trace]   that run holds 1 capture(s), and approving freezes them as the
  //      approved baseline for "three-frames".\n' + …
  // Verified by doing exactly that, then restoring it and watching it pass.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "approve-count-"));
  try {
    await writeRunAged(root, "three-frames", { minutesAgo: 1, captures: 3 });

    const { exit, err } = await capturedRun(["approve", "--root", root], {});
    assert.equal(exit, 0, err);
    assert.match(err, /that run holds 3 capture\(s\)/);
    // The stated number is the number that was frozen, not a number about something else.
    assert.deepEqual(
      (await fs.readdir(path.join(baselinesDir(root), "three-frames"))).filter((f) => f.endsWith(".png")).sort(),
      ["cap0.png", "cap1.png", "cap2.png"],
    );
    assert.match(err, /approved 3 baseline\(s\)/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("discoverReports: only *.report.json with safe ids, sorted; missing dir → []", async () => {
  // The suffix filter is what keeps the mini-game workspace's own `minigame-verification.json`
  // (this directory is shared in the flat layout) out of the approve candidate list.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "approve-disco-"));
  try {
    const dir = path.join(root, "reports");
    await fs.mkdir(dir, { recursive: true });
    for (const name of [
      "b.report.json",
      "a.report.json",
      "minigame-verification.json",
      "a.report.html",
      ".report.json",
      "..report.json",
    ]) {
      await fs.writeFile(path.join(dir, name), "{}");
    }
    assert.deepEqual(await discoverReports(dir), ["a", "b"]);
    assert.deepEqual(await discoverReports(path.join(root, "missing")), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("discoverTraces: only *.trace.json with safe ids, sorted; missing dir → []", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "trace-disco-"));
  try {
    const dir = path.join(root, "traces");
    await fs.mkdir(dir, { recursive: true });
    for (const name of ["b.trace.json", "a.trace.json", "notatrace.txt", ".trace.json", "..trace.json"]) {
      await fs.writeFile(path.join(dir, name), "{}");
    }
    assert.deepEqual(await discoverTraces(dir), ["a", "b"]);
    assert.deepEqual(await discoverTraces(path.join(root, "missing")), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("trace report: a missing report is a friendly failure (exit 1)", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "trace-report-"));
  try {
    assert.equal(await run(["report", "--id", "nope", "--root", root]), 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("trace report: invalid report JSON is a friendly failure (exit 1)", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "trace-report-"));
  try {
    const reports = path.join(root, ".loombridge", "replays", "reports");
    await fs.mkdir(reports, { recursive: true });
    await fs.writeFile(path.join(reports, "bad.report.json"), '{"not":"a report"}');
    assert.equal(await run(["report", "--id", "bad", "--root", root]), 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("trace approve: copies the run's captures to the baseline dir (exit 0)", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "trace-approve-"));
  try {
    const reports = path.join(root, ".loombridge", "replays", "reports");
    await fs.mkdir(path.join(reports, "demo", "actual"), { recursive: true });
    const actualPng = path.join(reports, "demo", "actual", "cap.png");
    await fs.writeFile(actualPng, Buffer.from("png-bytes"));
    const artifact = {
      traceId: "demo",
      status: "pass",
      resetTier: "scene-load",
      segments: [
        { id: "s", status: "pass", anchorsReached: [], captures: [{ id: "cap", artifact: actualPng }] },
      ],
      assertions: [],
      console: { status: "pass", errorCount: 0, errors: [] },
      startedAt: "t",
      finishedAt: "t",
      durationMs: 1,
    };
    await fs.writeFile(path.join(reports, "demo.report.json"), JSON.stringify(artifact));
    await writeTrace(root, "demo");

    assert.equal(await run(["approve", "--id", "demo", "--root", root]), 0);
    const baseline = path.join(root, ".loombridge", "replays", "baselines", "demo", "cap.png");
    assert.deepEqual(await fs.readFile(baseline), Buffer.from("png-bytes"));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("trace approve: a missing report is a friendly failure (exit 1)", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "trace-approve-"));
  try {
    assert.equal(await run(["approve", "--id", "nope", "--root", root]), 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("trace approve: an unsafe capture.id is skipped — no traversal write (exit 1)", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "trace-approve-"));
  try {
    const actual = path.join(root, ".loombridge", "replays", "reports", "demo", "actual", "cap.png");
    await fs.mkdir(path.dirname(actual), { recursive: true });
    await fs.writeFile(actual, Buffer.from("png-bytes"));
    await writeReport(root, "demo", [{ id: "../../EVIL", artifact: actual }]);
    await writeTrace(root, "demo");

    assert.equal(await run(["approve", "--id", "demo", "--root", root]), 1, "nothing approved");
    await assert.rejects(
      fs.access(path.join(root, ".loombridge", "replays", "EVIL.png")),
      "the traversal target must not be written",
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("trace approve: a capture.artifact outside .loombridge/replays is not copied (exit 1)", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "trace-approve-"));
  const secret = path.join(os.tmpdir(), `secret-${process.pid}-${Date.now()}.txt`);
  try {
    await fs.writeFile(secret, "SECRET");
    await writeReport(root, "demo", [{ id: "cap", artifact: secret }]);
    await writeTrace(root, "demo");

    assert.equal(await run(["approve", "--id", "demo", "--root", root]), 1, "nothing approved");
    await assert.rejects(
      fs.access(path.join(root, ".loombridge", "replays", "baselines", "demo", "cap.png")),
      "an out-of-tree source must not be copied into baselines",
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(secret, { force: true });
  }
});

test("replayExitCode: pass→0, drift→0 (warn) unless --strict-visual, fail→1", () => {
  assert.equal(replayExitCode({ status: "pass" }, false), 0);
  assert.equal(replayExitCode({ status: "pass", visualDrift: true }, false), 0);
  assert.equal(replayExitCode({ status: "pass", visualDrift: true }, true), 1);
  assert.equal(replayExitCode({ status: "fail" }, false), 1);
  assert.equal(replayExitCode({ status: "fail" }, true), 1);
});

test("replayExitCode: blocked is the HARNESS tier (2), never a game defect (1)", () => {
  // `blocked` means replay could not drive the trace at all (unsupported backend,
  // a reset it cannot perform). It never formed an opinion about the game, so
  // grading it 1 would report a missing capability as a regression.
  assert.equal(replayExitCode({ status: "blocked" }, false), 2);
  assert.equal(replayExitCode({ status: "blocked" }, true), 2);
});

test("replayExitCode: an unreadable capture/baseline is the harness tier (2), even with drift alongside", () => {
  assert.equal(replayExitCode({ status: "pass", visualHarnessFault: true }, false), 2);
  assert.equal(replayExitCode({ status: "pass", visualDrift: true, visualHarnessFault: true }, true), 2);
  // 2 dominates 1: once part of the run could not be trusted, the run is not a clean
  // game verdict in either direction.
  assert.equal(replayExitCode({ status: "fail", visualHarnessFault: true }, false), 2);
});

// ── visual diff tiering: drift is a game signal, an undecodable file is not ──

/** A minimal, real RGBA PNG so `readPng` decodes it (no image library needed). */
function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    crc ^= buf[i]!;
    for (let k = 0; k < 8; k += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const t = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function pngBuffer(width: number, height: number, rgb: [number, number, number]): Buffer {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc(height * (1 + width * 4));
  let o = 0;
  for (let y = 0; y < height; y += 1) {
    raw[o++] = 0;
    for (let x = 0; x < width; x += 1) {
      raw[o++] = rgb[0];
      raw[o++] = rgb[1];
      raw[o++] = rgb[2];
      raw[o++] = 255;
    }
  }
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/** A one-capture artifact pointing at `actualPng`, ready for `applyVisualDiff`. */
function artifactWithCapture(id: string, actualPng: string): ReplayRunArtifact {
  return {
    traceId: id,
    status: "pass",
    resetTier: "scene-load",
    segments: [{ id: "s", status: "pass", anchorsReached: [], captures: [{ id: "cap", artifact: actualPng }] }],
    assertions: [],
    console: { status: "pass", errorCount: 0, errors: [] },
    startedAt: "t",
    finishedAt: "t",
    durationMs: 1,
  };
}

/** Stage `<reports>/<id>/actual/cap.png` + `<baselines>/<id>/cap.png` and diff them. */
async function diffFixture(
  actual: Buffer,
  baseline: Buffer,
): Promise<{ artifact: ReplayRunArtifact; root: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "trace-vdiff-"));
  const layout = standardReplayLayout(root);
  const actualDir = path.join(layout.replayReports, "demo", "actual");
  await fs.mkdir(actualDir, { recursive: true });
  const actualPng = path.join(actualDir, "cap.png");
  await fs.writeFile(actualPng, actual);
  const baselineDir = path.join(layout.replayBaselines, "demo");
  await fs.mkdir(baselineDir, { recursive: true });
  await fs.writeFile(path.join(baselineDir, "cap.png"), baseline);

  const artifact = artifactWithCapture("demo", actualPng);
  await applyVisualDiff(layout, "demo", artifact);
  return { artifact, root };
}

test("applyVisualDiff: an UNREADABLE baseline is a capture gap (exit 2), never reported as drift", async () => {
  // The corrupt baseline is the whole point: a truncated/undecodable PNG says nothing
  // about the game, so calling it drift would report a harness fault as a regression.
  const { artifact, root } = await diffFixture(pngBuffer(4, 4, [255, 255, 255]), Buffer.from("not-a-png"));
  try {
    const capture = artifact.segments[0]!.captures[0]!;
    assert.equal(capture.visualStatus, "unreadable");
    assert.notEqual(capture.visualStatus, "drift", "an undecodable file must not be laundered into drift");
    assert.equal(artifact.visualDrift, undefined, "no drift is claimed");
    assert.equal(artifact.visualHarnessFault, true);
    assert.equal(replayExitCode(artifact, false), 2);
    assert.equal(replayExitCode(artifact, true), 2);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("applyVisualDiff: a REAL drift keeps its meaning: 0 by default, 1 under --strict-visual", async () => {
  const { artifact, root } = await diffFixture(pngBuffer(4, 4, [0, 0, 0]), pngBuffer(4, 4, [255, 255, 255]));
  try {
    assert.equal(artifact.segments[0]!.captures[0]!.visualStatus, "drift");
    assert.equal(artifact.visualDrift, true);
    assert.equal(artifact.visualHarnessFault, undefined, "real drift is a GAME signal, not a harness fault");
    assert.equal(replayExitCode(artifact, false), 0);
    assert.equal(replayExitCode(artifact, true), 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("applyVisualDiff: matching frames are a match, and no baseline is `no-baseline` (never a pass claim)", async () => {
  const same = pngBuffer(4, 4, [10, 20, 30]);
  const { artifact, root } = await diffFixture(same, same);
  try {
    assert.equal(artifact.segments[0]!.captures[0]!.visualStatus, "match");
    assert.equal(replayExitCode(artifact, true), 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }

  const bare = await fs.mkdtemp(path.join(os.tmpdir(), "trace-vdiff-"));
  try {
    const layout = standardReplayLayout(bare);
    const actualDir = path.join(layout.replayReports, "demo", "actual");
    await fs.mkdir(actualDir, { recursive: true });
    const actualPng = path.join(actualDir, "cap.png");
    await fs.writeFile(actualPng, same);
    const artifact2 = artifactWithCapture("demo", actualPng);
    await applyVisualDiff(layout, "demo", artifact2);
    assert.equal(artifact2.segments[0]!.captures[0]!.visualStatus, "no-baseline");
    assert.equal(artifact2.visualHarnessFault, undefined);
  } finally {
    await fs.rm(bare, { recursive: true, force: true });
  }
});

// ── approve stamps the baseline manifest ─────────────────────────────────────

test("trace approve: stamps baseline-manifest.json binding the trace, the source report, and every png", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "trace-approve-"));
  try {
    const layout = standardReplayLayout(root);
    const actualDir = path.join(layout.replayReports, "demo", "actual");
    await fs.mkdir(actualDir, { recursive: true });
    const actualPng = path.join(actualDir, "cap.png");
    await fs.writeFile(actualPng, Buffer.from("png-bytes"));
    await writeReport(root, "demo", [{ id: "cap", artifact: actualPng }]);
    await writeTrace(root, "demo");

    assert.equal(await run(["approve", "--id", "demo", "--root", root]), 0);

    const loaded = await loadTraceBaselineManifest(path.join(layout.replayBaselines, "demo"));
    assert.ok(loaded && !("error" in loaded), `expected a manifest, got ${JSON.stringify(loaded)}`);
    assert.equal(loaded.kind, "trace-baseline");
    assert.equal(loaded.traceId, "demo");
    assert.match(loaded.traceSha256, /^[0-9a-f]{64}$/);
    assert.match(loaded.sourceReportSha256, /^[0-9a-f]{64}$/);
    assert.ok(Date.parse(loaded.approvedAt) > 0, "approvedAt is an ISO timestamp");
    assert.deepEqual(
      loaded.pngs.map((p) => p.captureId),
      ["cap"],
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("trace approve: REFUSES (exit 2) when the trace it would bind to is gone", async () => {
  // An approval that cannot name the demonstration it froze is not an anchor.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "trace-approve-"));
  try {
    const layout = standardReplayLayout(root);
    const actualDir = path.join(layout.replayReports, "demo", "actual");
    await fs.mkdir(actualDir, { recursive: true });
    const actualPng = path.join(actualDir, "cap.png");
    await fs.writeFile(actualPng, Buffer.from("png-bytes"));
    await writeReport(root, "demo", [{ id: "cap", artifact: actualPng }]);

    assert.equal(await run(["approve", "--id", "demo", "--root", root]), 2);
    await assert.rejects(fs.access(path.join(layout.replayBaselines, "demo", "cap.png")));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("trace report --flat: reads/writes the FLAT workspace layout (no nested .loombridge/)", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "trace-flat-"));
  try {
    // Flat layout: reports live directly under <root>/reports, captures under
    // <root>/reports/<id>/actual — NOT <root>/.loombridge/replays/...
    const reports = path.join(root, "reports");
    await fs.mkdir(path.join(reports, "demo", "actual"), { recursive: true });
    const pngPath = path.join(reports, "demo", "actual", "cap.png");
    await fs.writeFile(pngPath, Buffer.from("png-bytes"));
    const artifact = {
      traceId: "demo",
      status: "pass",
      resetTier: "scene-load",
      segments: [
        { id: "s", status: "pass", anchorsReached: [], captures: [{ id: "cap", artifact: pngPath }] },
      ],
      assertions: [],
      console: { status: "pass", errorCount: 0, errors: [] },
      startedAt: "2026-06-06T10:00:00.000Z",
      finishedAt: "2026-06-06T10:00:01.000Z",
      durationMs: 1000,
    };
    await fs.writeFile(path.join(reports, "demo.report.json"), JSON.stringify(artifact));

    assert.equal(await run(["report", "--flat", "--id", "demo", "--root", root]), 0);
    // HTML written to the flat location, and the capture (under <root>/reports) inlined.
    const html = await fs.readFile(path.join(reports, "demo.report.html"), "utf8");
    assert.match(html, /data:image\/png;base64,/, "flat-layout capture is inlined");
    // The nested .loombridge/ layout must NOT be created under --flat.
    await assert.rejects(fs.access(path.join(root, ".loombridge")));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("trace report --flat: a report PNG OUTSIDE reports/ (but inside the workspace) is not inlined", async () => {
  // Confinement parity: under --flat, `replays` is the whole workspace, but the
  // copy/inline guard must still confine to the replay-artifact dirs (reports/,
  // baseline/). A hand-edited report.json pointing at another workspace file
  // (here raw/evil.png) must NOT be inlined into the HTML.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "trace-flat-confine-"));
  try {
    const reports = path.join(root, "reports");
    await fs.mkdir(reports, { recursive: true });
    const evil = path.join(root, "raw", "evil.png");
    await fs.mkdir(path.dirname(evil), { recursive: true });
    await fs.writeFile(evil, Buffer.from("not-a-replay-artifact"));
    const artifact = {
      traceId: "demo",
      status: "pass",
      resetTier: "scene-load",
      segments: [
        { id: "s", status: "pass", anchorsReached: [], captures: [{ id: "cap", artifact: evil }] },
      ],
      assertions: [],
      console: { status: "pass", errorCount: 0, errors: [] },
      startedAt: "2026-06-06T10:00:00.000Z",
      finishedAt: "2026-06-06T10:00:01.000Z",
      durationMs: 1000,
    };
    await fs.writeFile(path.join(reports, "demo.report.json"), JSON.stringify(artifact));

    assert.equal(await run(["report", "--flat", "--id", "demo", "--root", root]), 0);
    const html = await fs.readFile(path.join(reports, "demo.report.html"), "utf8");
    assert.doesNotMatch(html, /data:image\/png;base64,/, "out-of-artifact-dir PNG must not be inlined");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("trace report: renders self-contained HTML from a valid report (exit 0)", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "trace-report-"));
  try {
    const reports = path.join(root, ".loombridge", "replays", "reports");
    await fs.mkdir(path.join(reports, "demo", "actual"), { recursive: true });
    const pngPath = path.join(reports, "demo", "actual", "cap.png");
    await fs.writeFile(pngPath, Buffer.from("png-bytes"));
    const artifact = {
      traceId: "demo",
      status: "pass",
      resetTier: "scene-load",
      segments: [
        { id: "s", status: "pass", anchorsReached: [], captures: [{ id: "cap", artifact: pngPath }] },
      ],
      assertions: [],
      console: { status: "pass", errorCount: 0, errors: [] },
      startedAt: "2026-06-06T10:00:00.000Z",
      finishedAt: "2026-06-06T10:00:01.000Z",
      durationMs: 1000,
    };
    await fs.writeFile(path.join(reports, "demo.report.json"), JSON.stringify(artifact));

    assert.equal(await run(["report", "--id", "demo", "--root", root]), 0);
    const html = await fs.readFile(path.join(reports, "demo.report.html"), "utf8");
    assert.match(html, /^<!DOCTYPE html>/);
    assert.match(html, /data:image\/png;base64,/, "the capture is inlined");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ─────────────── capture coverage: the summary line, and the under-capture warning ───────────────
//
// The defect these cover, observed on a real 62-action consumer recording: six incidental key
// edges routed the whole session onto the merged keyboard timeline, which emits ONE segment
// with ONE trailing capture, and `trace record` reported "1 step(s)" because it counted
// SEGMENTS. The human lost 13 of 14 frames and nothing said so.

/** A scripted `input.observe_stop` payload: `n` pointer gestures plus `keys` key edges. */
function observedSession(n: number, keys: number): { data: unknown } {
  const clicks = Array.from({ length: n }, (_, i) => ({
    tMs: i * 1000,
    locator: { path: `/HUD/Button${i}` },
    button: 0,
    kind: "ui",
  }));
  const keyEdges = Array.from({ length: keys }, (_, i) => ({
    key: "D",
    edge: i % 2 === 0 ? "down" : "up",
    tMs: 500 + i * 100,
  }));
  return { data: { clicks, keyEdges, observed: true } };
}

test("trace record: the summary counts GESTURES and key edges, not segments", async () => {
  // LITMUS: replace the summary's `shape.gestures` with `trace.segments.length` (the old
  // count) and this fails on the match:
  //   AssertionError [ERR_ASSERTION]: The input did not match the regular expression
  //   /recorded "kids-chef": 3 gesture\(s\), 4 key edge\(s\)/. Input:
  //   '…recorded "kids-chef": 1 gesture(s), 4 key edge(s), 1 capture(s), 0 outcome(s) → …'
  // Restored, it passes. Driven through the REAL verb (argv → runRecord → the real transform).
  const root = await recordRoot();
  try {
    const { factory } = recordBridge({ "input.observe_stop": () => observedSession(3, 4) });
    const { exit, err } = await capturedRun(["record", "--root", root, "--duration", "0.01"], {
      clientFactory: factory,
    });
    assert.equal(exit, 0, err);
    assert.match(err, /recorded "kids-chef": 3 gesture\(s\), 4 key edge\(s\)/);
    assert.doesNotMatch(err, /step\(s\)/, "the segment-count phrasing is gone");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("trace record: a KEYBOARD recording captures every gesture, so the under-capture warning stays silent", async () => {
  // This is the end-to-end proof for BOTH halves: the merged keyboard timeline now takes one
  // frame per gesture plus the final one, and the warning that used to fire for it silences
  // itself because it is bound to the counts.
  //
  // LITMUS (piece 2): in `observedEdgesToTrace`, delete the `actions.push({ do: "capture", … })`
  // that follows each gesture — i.e. go back to the single trailing `final` capture. Observed:
  //   AssertionError [ERR_ASSERTION]: The input did not match the regular expression
  //   /recorded "kids-chef": 3 gesture\(s\), 4 key edge\(s\), 4 capture\(s\)/. Input:
  //   '…[loombridge trace] WARNING: 3 gesture(s) were demonstrated but this trace takes only
  //     1 capture(s) — 2 gesture(s) get no frame of their own.\n
  //     …[loombridge trace] recorded "kids-chef": 3 gesture(s), 4 key edge(s), 1 capture(s), …'
  // Restored, it passes. The same failure output is the wiring proof for piece 1's warning:
  // the notices really are printed by the verb, not just returned by a pure function.
  const root = await recordRoot();
  try {
    const { factory } = recordBridge({ "input.observe_stop": () => observedSession(3, 4) });
    const { exit, err } = await capturedRun(["record", "--root", root, "--duration", "0.01"], {
      clientFactory: factory,
    });
    assert.equal(exit, 0, err);
    assert.match(err, /recorded "kids-chef": 3 gesture\(s\), 4 key edge\(s\), 4 capture\(s\)/);
    assert.doesNotMatch(err, /WARNING/, "every gesture has a frame, so there is nothing to warn about");

    const written = JSON.parse(
      await fs.readFile(path.join(tracesDir(root), "kids-chef.trace.json"), "utf8"),
    ) as { segments: { id: string; actions: { do: string; id?: string }[]; captures: { id: string }[] }[] };
    assert.equal(written.segments.length, 1, "still ONE segment: held keys must not be split");
    assert.deepEqual(
      written.segments[0]!.actions.filter((a) => a.do === "capture").map((a) => a.id),
      ["step-1", "step-2", "step-3"],
      "one interleaved capture per gesture, ids stable and per-gesture",
    );
    assert.deepEqual(written.segments[0]!.captures.map((c) => c.id), ["final"], "the end state is still captured");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("trace record: a pointer-only recording captures every gesture, so NO warning is printed", async () => {
  const root = await recordRoot();
  try {
    const { factory } = recordBridge({ "input.observe_stop": () => observedSession(3, 0) });
    const { exit, err } = await capturedRun(["record", "--root", root, "--duration", "0.01"], {
      clientFactory: factory,
    });
    assert.equal(exit, 0, err);
    assert.match(err, /recorded "kids-chef": 3 gesture\(s\), 0 key edge\(s\), 3 capture\(s\)/);
    assert.doesNotMatch(err, /WARNING/, "captures == gestures, so there is nothing to warn about");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("captureCoverageNotices: bound to the COUNTS, not to which transform ran", () => {
  // The warning must silence itself when a transform starts capturing per gesture, and must
  // still fire for a keyboard-free path that under-captures for some other reason.
  assert.deepEqual(captureCoverageNotices({ gestures: 14, keyEdges: 0, captures: 14 }), []);
  assert.deepEqual(captureCoverageNotices({ gestures: 0, keyEdges: 40, captures: 1 }), []);
  const noKeys = captureCoverageNotices({ gestures: 14, keyEdges: 0, captures: 1 });
  assert.equal(noKeys.length, 2, "under-captured with no key edges still warns");
  assert.doesNotMatch(noKeys.join("\n"), /keyboard/, "…without blaming a keyboard that was not used");
  const withKeys = captureCoverageNotices({ gestures: 14, keyEdges: 6, captures: 1 });
  assert.equal(withKeys.length, 4, "key edges add the cause + the remedy");
  assert.match(withKeys.join("\n"), /6 recorded key edge\(s\)/);
});

test("traceDemonstration: counts gestures, key edges, and captures across every segment", () => {
  const shape = traceDemonstration({
    segments: [
      {
        actions: [
          { do: "wait-for-visible" },
          { do: "tap" },
          { do: "key-down" },
          { do: "wait" },
          { do: "key-up" },
          { do: "drag" },
          { do: "world-tap" },
        ],
        captures: [{ id: "final" }],
      },
      { actions: [{ do: "tap" }], captures: [{ id: "step-1" }] },
      { actions: [{ do: "wait" }] },
    ],
  });
  assert.deepEqual(shape, { gestures: 4, keyEdges: 2, captures: 2 });
});
