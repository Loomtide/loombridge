import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { discoverTraces, parseStateSignal, readEnter, replayExitCode, run } from "../capabilities/replay/trace.js";
import { flatReplayLayout, standardReplayLayout } from "../domain/state.js";

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

test("trace record: without --observe → usage error (exit 2)", async () => {
  assert.equal(await run(["record", "--id", "x", "--scene", "Assets/S.unity"]), 2);
});

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

test("replayExitCode: pass→0, pass+drift→0 (warn) unless --strict-visual, non-pass→1", () => {
  assert.equal(replayExitCode({ status: "pass" }, false), 0);
  assert.equal(replayExitCode({ status: "pass", visualDrift: true }, false), 0);
  assert.equal(replayExitCode({ status: "pass", visualDrift: true }, true), 1);
  assert.equal(replayExitCode({ status: "fail" }, false), 1);
  assert.equal(replayExitCode({ status: "blocked" }, true), 1);
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
