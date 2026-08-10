import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { deflateSync } from "node:zlib";

import {
  applyVisualDiff,
  discoverTraces,
  observeDropNotices,
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
      await fs.readFile(path.join(tracesDir(root), "kidschef.trace.json"), "utf8"),
    ) as { id: string; start: { scene: string } };
    assert.equal(written.id, "kidschef", "the id is derived from the RESOLVED scene");
    assert.equal(written.start.scene, "Assets/Scenes/KidsChef.unity");
    assert.match(err, /no --id given, recording as "kidschef"/);
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
      await fs.readFile(path.join(tracesDir(legacy), "kidschef.trace.json"), "utf8"),
      await fs.readFile(path.join(tracesDir(bare), "kidschef.trace.json"), "utf8"),
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
  assert.equal(traceIdFromScenePath("Assets/Scenes/KidsChef.unity"), "kidschef");
  assert.equal(traceIdFromScenePath("Assets/Scenes/Count The Fruits.unity"), "count-the-fruits");
  assert.equal(traceIdFromScenePath("Assets/Scenes/Count_The_Fruits.unity"), "count-the-fruits");
  assert.equal(traceIdFromScenePath("Assets/Scenes/count-the-fruits.unity"), "count-the-fruits");
  assert.equal(traceIdFromScenePath("Assets/Levels/Level 01.unity"), "level-01");
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
  // doing exactly that: the run overwrote kidschef.trace.json and the assertion caught it.
  const root = await recordRoot();
  try {
    await fs.mkdir(tracesDir(root), { recursive: true });
    const original = path.join(tracesDir(root), "kidschef.trace.json");
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
      await fs.readFile(path.join(tracesDir(root), "kidschef-2.trace.json"), "utf8"),
    ) as { id: string };
    assert.equal(second.id, "kidschef-2", "the trace's own id matches the file it landed in");
    assert.match(err, /recording as "kidschef-2"/);
    assert.match(err, /re-record it with: --id kidschef\b/, "it says how to re-record the original");

    // And a THIRD recording keeps counting rather than stopping at -2.
    const third = await capturedRun(["record", "--root", root, "--duration", "0.01"], {
      clientFactory: recordBridge().factory,
    });
    assert.equal(third.exit, 0, third.err);
    assert.ok(
      await fs.stat(path.join(tracesDir(root), "kidschef-3.trace.json")).then(() => true),
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
