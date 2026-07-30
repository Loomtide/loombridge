/**
 * THE PLAYABILITY OBSERVER against a SCRIPTED BRIDGE, end to end (stage 3).
 *
 * The fake below is a small deterministic game plus a recorder: it answers
 * `observe.start` with the state at window open, `observe.status` with a win that
 * arrives after a few polls, and `observe.drain` with a per-frame recording of a
 * declared run. So the recipe drives a session whose truth is known, and the
 * assertions are recoveries: the `playability.json` it writes must carry the
 * headline that recording produces.
 *
 * The gate assertions then run over THE FILE THE RECIPE JUST WROTE, which is the
 * whole point of the pair: the producer and the gate share one derivation, so a
 * green here means the gate reproduces the producer's headline from the producer's
 * own buffers. Every negative control tampers with that same file.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  buffersFromDrain,
  locatorParam,
  runPlayabilitySession,
  type PlayabilitySend,
} from "../../../../capabilities/verification/capture-playability.js";
import {
  evaluatePlayability,
  type PlayabilityResults,
} from "../../../../capabilities/verification/gates/playability.js";
import type { AcceptanceContract } from "../../../../capabilities/verification/types.js";

// ── the contract under test ─────────────────────────────────────────────────

const CONTRACT = {
  game: "TestRunner",
  feel: {
    runSpeed: { target: 7 },
    jumpApex: { target: 2.2 },
    timeToApex: { target: 0.28 },
  },
  win: { rule: "all-fruit", endStateMode: "modal", restartAction: "R key" },
  harness: {
    playability: {
      playerLocator: "Level:/Player",
      stateLocator: "Level:/GameManager",
      stateComponent: "GameManager",
      fields: { win: "isWin", score: "score", lives: "lives" },
      winRule: "all-collectibles",
      collectibles: { namePattern: "Apple" },
      keys: { moveRight: "D", restart: "R" },
      driveTimeoutSeconds: 60,
    },
  },
};

const DT_MS = 1000 / 60;

interface RecordingOptions {
  samples?: number;
  winAt?: number;
  hop?: { at: number; dx: number };
  winAtOpen?: boolean;
}

/** The drain payload shape: parallel arrays, exactly what the bridge echoes. */
function scriptedRecording(options: RecordingOptions = {}): Record<string, unknown> {
  const count = options.samples ?? 120;
  const winAt = options.winAt ?? 100;
  const scoreAt = new Set([20, 40, 60]);
  const loseAt = new Set([30]);
  const tMs: number[] = [];
  const frame: number[] = [];
  const fixedTick: number[] = [];
  const x: number[] = [];
  const y: number[] = [];
  const z: number[] = [];
  const win: boolean[] = [];
  const score: number[] = [];
  const lives: number[] = [];
  let px = 0;
  let sc = 0;
  let lv = 3;
  let w = options.winAtOpen === true;
  for (let i = 0; i < count; i += 1) {
    if (i > 0) px += 0.1;
    if (options.hop && i === options.hop.at) px += options.hop.dx;
    if (scoreAt.has(i)) sc += 1;
    if (loseAt.has(i)) lv -= 1;
    if (i === winAt) w = true;
    tMs.push(Math.round(i * DT_MS * 1000) / 1000);
    frame.push(500 + i);
    fixedTick.push(i);
    x.push(Math.round(px * 1e6) / 1e6);
    y.push(1);
    z.push(0);
    win.push(w);
    score.push(sc);
    lives.push(lv);
  }
  return { tMs, frame, fixedTick, x, y, z, win, score, lives };
}

interface FakeOptions extends RecordingOptions {
  /** Polls before the win shows up in observe.status. */
  pollsBeforeWin?: number;
  alreadyRecording?: boolean;
  drainWasRecording?: boolean;
  /** Never report the win, so the drive times out. */
  neverWins?: boolean;
  /** The player keeps moving under held input behind the overlay. */
  leakyInputLock?: boolean;
  recorderDiesDuringDrive?: boolean;
}

interface Fake {
  send: PlayabilitySend;
  calls: string[];
  logs: string[];
  clock: () => number;
}

/** A scripted editor: play mode, a recorder, and the post-win probe captures. */
function fakeBridge(options: FakeOptions = {}): Fake {
  const calls: string[] = [];
  const logs: string[] = [];
  const recording = scriptedRecording(options);
  let polls = 0;
  let restartSession = false;
  let nowMs = 1_000_000;

  const send: PlayabilitySend = async (command, params = {}) => {
    calls.push(command);
    switch (command) {
      case "editor.play":
      case "editor.wait_for":
      case "editor.stop":
      case "input.begin_session":
      case "input.end_session":
        return {};
      case "editor.console_logs":
        return { logs: [{ type: "Log", message: "[Loombridge] hello" }] };
      case "observe.start": {
        if (options.alreadyRecording && !restartSession) {
          return { sessionId: "live-session", started: false, alreadyRecording: true, recording: true };
        }
        const isRestartProbe = restartSession;
        restartSession = true;
        return {
          sessionId: isRestartProbe ? "restart-session" : "play-session",
          editorSessionId: "editor-abc",
          started: true,
          alreadyRecording: false,
          recording: true,
          capacity: 36000,
          startedAtUtc: "2026-07-30T00:00:00.000Z",
          fixedTimestep: 0.0166667,
          spawn: { x: 0, y: 1, z: 0 },
          collectibleTotal: 3,
          collectibleInactive: 0,
          collectiblePaths: ["/Apples/Apple", "/Apples/Apple[1]", "/Apples/Apple[2]"],
          initial: {
            tMs: 0,
            frame: 500,
            x: 0,
            y: 1,
            win: isRestartProbe ? true : options.winAtOpen === true,
            score: isRestartProbe ? 3 : 0,
            lives: isRestartProbe ? 1 : 3,
          },
          unreadableFields: [],
        };
      }
      case "observe.status": {
        polls += 1;
        nowMs += 2000;
        if (options.recorderDiesDuringDrive && polls > 1) {
          return { recording: false, sessionId: "play-session", sampleCount: 40 };
        }
        const won = !options.neverWins && polls >= (options.pollsBeforeWin ?? 2);
        return {
          recording: true,
          sessionId: "play-session",
          sampleCount: 40 * polls,
          droppedSamples: 0,
          latest: { tMs: polls * 2000, frame: 500 + polls, x: polls, y: 1, win: won, score: 3, lives: 2 },
        };
      }
      case "observe.drain": {
        const isRestart = calls.filter((c) => c === "observe.drain").length > 1;
        if (isRestart) {
          return {
            sessionId: "restart-session",
            wasRecording: true,
            recording: false,
            sampleCount: 3,
            totalSampled: 3,
            droppedSamples: 0,
            capacity: 36000,
            elapsedMs: 33.3,
            effectiveSampleRateHz: 60,
            samples: {
              tMs: [0, 16.667, 33.333],
              frame: [900, 901, 902],
              fixedTick: [0, 1, 2],
              x: [0, 0, 0],
              y: [1, 1, 1],
              z: [0, 0, 0],
              win: [true, false, false],
              score: [3, 0, 0],
              lives: [1, 3, 3],
            },
          };
        }
        const tMs = recording.tMs as number[];
        return {
          sessionId: "play-session",
          editorSessionId: "editor-abc",
          wasRecording: options.drainWasRecording === false ? false : true,
          recording: false,
          sampleCount: tMs.length,
          totalSampled: tMs.length,
          droppedSamples: 0,
          capacity: 36000,
          elapsedMs: tMs[tMs.length - 1],
          effectiveSampleRateHz: 60,
          fixedTickCount: tMs.length,
          unreadableFields: [],
          samples: recording,
        };
      }
      case "runtime.capture_input_motion": {
        const phases = (params.phases ?? []) as { keys?: string[] }[];
        const held = phases.some((phase) => (phase.keys ?? []).includes("D"));
        const moving = held && options.leakyInputLock === true;
        const samples = Array.from({ length: 30 }, (_, i) => ({
          tMs: Math.round(i * DT_MS * 1000) / 1000,
          x: moving ? 11.9 + i * 0.1 : 11.9,
          y: 1,
        }));
        return { sampleCount: samples.length, durationMs: samples[samples.length - 1].tMs, phases: [], samples };
      }
      default:
        throw new Error(`unscripted op: ${command}`);
    }
  };

  return { send, calls, logs, clock: () => nowMs };
}

async function runSession(options: FakeOptions = {}, contract: unknown = CONTRACT) {
  const fake = fakeBridge(options);
  const output = await runPlayabilitySession({
    send: fake.send,
    contract,
    runId: "run-2026-07-30",
    editorSessionId: "editor-abc",
    now: () => "2026-07-30T00:00:00.000Z",
    clock: fake.clock,
    sleep: async () => {},
    log: (message) => fake.logs.push(message),
    pollIntervalMs: 1,
  });
  return { output, fake };
}

// ── the happy path ──────────────────────────────────────────────────────────

test("observer: the produced playability.json is derived from the recording, not declared", async () => {
  const { output, fake } = await runSession();
  const file = output.playability as Record<string, unknown>;

  assert.equal(file.completable, true);
  assert.equal(file.completionMethod, "played");
  assert.equal(file.winRuleObserved, "all-fruit");
  assert.equal(file.hazardKills, true);
  assert.equal(file.collectibleIncrements, true);
  assert.equal(file.postWinPlayerFrozen, true);
  assert.equal(file.postWinInputLocked, true);
  assert.equal(file.restartWorks, true);

  const provenance = file._provenance as Record<string, unknown>;
  assert.equal(provenance.writer, "loombridge-capture");
  assert.equal(provenance.recipe, "playability");
  assert.equal(provenance.runId, "run-2026-07-30");
  assert.equal(provenance.editorSessionId, "editor-abc");

  const observation = provenance.observation as Record<string, unknown>;
  const buffers = observation.buffers as Record<string, unknown[]>;
  assert.equal(buffers.tMs.length, 120, "every recorded frame is retained, nothing decimated");
  assert.equal((observation.open as Record<string, unknown>).collectibleTotal, 3);

  // The window is opened BEFORE the drive-now line and drained after: the ordering
  // is what makes the recording cover the play.
  const order = fake.calls.filter((c) => c.startsWith("observe.") || c === "editor.play");
  assert.deepEqual(order.slice(0, 3), ["editor.play", "observe.start", "observe.status"]);
  assert.ok(fake.calls.includes("observe.drain"));
});

test("observer: the DRIVE NOW line is one machine-readable line carrying the session", async () => {
  const { fake } = await runSession();
  const driveLine = fake.logs.find((line) => line.includes("DRIVE NOW"));
  assert.ok(driveLine, "the recipe must tell the agent when the window is open");
  const payload = JSON.parse(driveLine.slice(driveLine.indexOf("{")));
  assert.equal(payload.sessionId, "play-session");
  assert.equal(payload.editorSessionId, "editor-abc");
  assert.equal(payload.winField, "GameManager.isWin");
  assert.equal(payload.timeoutSeconds, 60);
  assert.match(payload.instruction, /do NOT teleport the player/);
});

test("observer: console.json comes from the SAME session as the recording (ledger L106)", async () => {
  const { output } = await runSession();
  const consoleProvenance = (output.console as Record<string, unknown>)._provenance as Record<string, unknown>;
  const playabilityProvenance = (output.playability as Record<string, unknown>)._provenance as Record<string, unknown>;
  assert.equal(consoleProvenance, playabilityProvenance, "one provenance object, one session");
  assert.equal(output.logCount, 1);
});

// ── the refusals ────────────────────────────────────────────────────────────

test("observer: a window whose win field is already true at open is REFUSED before any drive", async () => {
  await assert.rejects(
    () => runSession({ winAtOpen: true }),
    /ALREADY TRUE when the observation window opened/,
  );
});

test("observer: an already-live recorder is REFUSED (the opening state is unknown)", async () => {
  await assert.rejects(() => runSession({ alreadyRecording: true }), /a recording window was ALREADY open/);
});

test("observer: a drain that reports the recorder was not live is REFUSED", async () => {
  await assert.rejects(
    () => runSession({ drainWasRecording: false }),
    /not live at drain time/,
  );
});

test("observer: a recorder that dies mid-drive is REFUSED, never treated as a short window", async () => {
  await assert.rejects(
    () => runSession({ recorderDiesDuringDrive: true }),
    /stopped before a win was observed/,
  );
});

test("observer: no win inside the timeout REFUSES and writes nothing", async () => {
  await assert.rejects(() => runSession({ neverWins: true }), /no win was observed within 60s/);
});

test("observer: a contract with no harness.playability refuses with the JSON to add", async () => {
  await assert.rejects(
    () => runSession({}, { ...CONTRACT, harness: {} }),
    /the contract declares no `harness.playability`/,
  );
});

test("observer: a modal end state with no restart key refuses at seam resolution", async () => {
  const contract = {
    ...CONTRACT,
    harness: {
      playability: {
        ...CONTRACT.harness.playability,
        keys: { moveRight: "D" },
      },
    },
  };
  await assert.rejects(() => runSession({}, contract), /keys\.restart/);
});

test("observer: a contract with no feel target refuses (no kinematic bound to test motion against)", async () => {
  const contract = { ...CONTRACT, feel: {} };
  await assert.rejects(() => runSession({}, contract), /no usable `feel` target/);
});

test("observer: no editorSessionId means the evidence cannot be bound to a session", async () => {
  const fake = fakeBridge();
  await assert.rejects(
    () =>
      runPlayabilitySession({
        send: fake.send,
        contract: CONTRACT,
        runId: "run-1",
        clock: fake.clock,
        sleep: async () => {},
        pollIntervalMs: 1,
      }),
    /no editorSessionId/,
  );
});

// ── helpers ─────────────────────────────────────────────────────────────────

test("locatorParam: a scene-qualified locator is split, so the bridge does not hunt for a root named 'Level:'", () => {
  assert.deepEqual(locatorParam("Level:/Player"), { scene: "Level", path: "/Player" });
  assert.deepEqual(locatorParam("/Player"), { path: "/Player" });
});

test("buffersFromDrain: an unreadable sample stays null instead of becoming 0/false", () => {
  const buffers = buffersFromDrain({
    samples: { tMs: [0, 16], frame: [1, 2], fixedTick: [0, 1], x: [0, 1], y: [1, 1], win: [false, null], score: [0, null], lives: [3, 3] },
  });
  assert.ok(buffers);
  assert.deepEqual(buffers.win, [false, null]);
  assert.deepEqual(buffers.score, [0, null]);
});

// ── the gate, over the file the recipe just wrote ───────────────────────────

async function producedFile(options: FakeOptions = {}): Promise<Record<string, unknown>> {
  const { output } = await runSession(options);
  // Round-trip through JSON: the gate reads a FILE, never the in-memory object.
  return JSON.parse(JSON.stringify(output.playability)) as Record<string, unknown>;
}

test("gate: the produced file PASSES, and every headline field was re-derived to get there", async () => {
  const file = await producedFile();
  const report = evaluatePlayability(file, CONTRACT as unknown as AcceptanceContract);
  assert.equal(report.verdict, "pass", JSON.stringify(report.checks.filter((c) => c.status !== "pass"), null, 2));
  const rederive = report.checks.find((check) => check.id === "playability.produced.rederive");
  assert.equal(rederive?.status, "pass");
  assert.match(rederive?.detail ?? "", /re-derived from the file's own 120-sample recording/);
  const continuity = report.checks.find((check) => check.id === "playability.produced.continuity");
  assert.equal(continuity?.status, "pass");
});

test("FLAGSHIP: the gate REFUSES a file claiming 'played' over a recording with a 3u hop", async () => {
  // The producer itself derives "assisted" from this window, so the tamper is the
  // realistic one: someone edits the headline afterwards.
  const honest = await producedFile({ hop: { at: 50, dx: 3 } });
  assert.equal(honest.completionMethod, "assisted", "the producer never wrote 'played' here");
  const honestReport = evaluatePlayability(honest, CONTRACT as unknown as AcceptanceContract);
  assert.equal(honestReport.verdict, "warn", "an assisted completion warns: the win fired, traversal was not shown");
  assert.equal(
    honestReport.checks.find((c) => c.id === "playability.produced.continuity")?.status,
    "warn",
    "the unexplained step is named on its own check and denies the pass",
  );
  assert.equal(
    honestReport.checks.find((c) => c.id === "playability.produced.rederive")?.status,
    "pass",
    "the honest file is not tampered: its headline is exactly what the recording yields",
  );

  const laundered = { ...honest, completionMethod: "played" } as PlayabilityResults;
  const report = evaluatePlayability(laundered, CONTRACT as unknown as AcceptanceContract);
  assert.equal(report.verdict, "fail");
  const rederive = report.checks.find((check) => check.id === "playability.produced.rederive");
  assert.equal(rederive?.status, "fail");
  assert.match(rederive?.detail ?? "", /completionMethod: file says "played", the recording yields "assisted"/);
});

test("FLAGSHIP: the gate catches a bumped headline field (the laundering detector)", async () => {
  const file = await producedFile();
  for (const [field, value] of [
    ["hazardKills", false],
    ["collectibleIncrements", false],
    ["postWinInputLocked", false],
    ["restartWorks", false],
    ["winRuleObserved", "reach-flag"],
  ] as const) {
    const tampered = { ...file, [field]: value };
    const report = evaluatePlayability(tampered, CONTRACT as unknown as AcceptanceContract);
    const rederive = report.checks.find((check) => check.id === "playability.produced.rederive");
    assert.equal(rederive?.status, "fail", `bumping ${field} must be refused`);
    assert.match(rederive?.detail ?? "", new RegExp(field));
  }
});

test("gate: a produced file with its buffers stripped is REFUSED (absent evidence, not a skip)", async () => {
  const file = await producedFile();
  const provenance = file._provenance as Record<string, unknown>;
  const observation = provenance.observation as Record<string, unknown>;
  delete observation.buffers;
  const report = evaluatePlayability(file, CONTRACT as unknown as AcceptanceContract);
  assert.equal(report.verdict, "fail");
  const check = report.checks.find((c) => c.id === "playability.produced.buffers");
  assert.equal(check?.status, "fail");
  assert.match(check?.detail ?? "", /The buffers ARE the evidence/);
});

test("gate: a produced file with no observation block at all is REFUSED", async () => {
  const file = await producedFile();
  delete (file._provenance as Record<string, unknown>).observation;
  const report = evaluatePlayability(file, CONTRACT as unknown as AcceptanceContract);
  assert.equal(report.verdict, "fail");
  assert.equal(report.checks.find((c) => c.id === "playability.produced.observation")?.status, "fail");
});

test("gate: a file carrying a WIDENED kinematic bound is refused and graded with the contract's bound", async () => {
  const file = await producedFile({ hop: { at: 50, dx: 3 } });
  const observation = (file._provenance as Record<string, unknown>).observation as Record<string, unknown>;
  const context = observation.context as Record<string, unknown>;
  // The tamper that would make the hop legal: a bound wide enough to swallow it.
  (context.bound as Record<string, unknown>).maxSpeedUPerSec = 100000;
  const relabelled = { ...file, completionMethod: "played" } as PlayabilityResults;
  const report = evaluatePlayability(relabelled, CONTRACT as unknown as AcceptanceContract);
  assert.equal(report.verdict, "fail");
  const boundCheck = report.checks.find((c) => c.id === "playability.produced.bound");
  assert.equal(boundCheck?.status, "fail");
  assert.match(boundCheck?.detail ?? "", /could launder an assisted completion into a played one/);
  assert.equal(
    report.checks.find((c) => c.id === "playability.produced.continuity")?.status,
    "warn",
    "the gate still grades with the contract's own bound, so the hop is still seen",
  );
  assert.equal(
    report.checks.find((c) => c.id === "playability.produced.rederive")?.status,
    "fail",
    "and the 'played' claim over that hop is still refused",
  );
});

test("gate: a contract with no harness.playability.winRule cannot re-check a produced file", async () => {
  const file = await producedFile();
  const contract = { ...CONTRACT, harness: {} };
  const report = evaluatePlayability(file, contract as unknown as AcceptanceContract);
  assert.equal(report.verdict, "fail");
  assert.match(
    report.checks.find((c) => c.id === "playability.produced.winRule")?.detail ?? "",
    /names the mechanical CHECK/,
  );
});

test("FLAGSHIP: an agent-assembled file is CAPPED AT WARN, never pass", () => {
  // The exact door-one shape: eight fields, every one a literal (ledger L97).
  const handTyped: PlayabilityResults = {
    completable: true,
    completionMethod: "played",
    winRuleObserved: "all-fruit",
    hazardKills: true,
    collectibleIncrements: true,
    postWinInputLocked: true,
    postWinPlayerFrozen: true,
    restartWorks: true,
  };
  const report = evaluatePlayability(handTyped, CONTRACT as unknown as AcceptanceContract);
  assert.equal(report.verdict, "warn");
  assert.equal(
    report.checks.filter((check) => check.status === "fail").length,
    0,
    "nothing FAILS: the cap is the whole finding",
  );
  const cap = report.checks.find((check) => check.id === "playability.evidenceOrigin");
  assert.equal(cap?.status, "warn");
  assert.match(cap?.detail ?? "", /CAPPED AT WARN/);
  assert.match(cap?.detail ?? "", /anti-teleport control/);
  // Positive control: the same headline WITH the producer's recording behind it
  // passes, so the cap is about the evidence origin and nothing else.
});

test("gate: a half-marked file (writer without the recipe) does not count as produced", () => {
  const halfMarked: PlayabilityResults = {
    completable: true,
    completionMethod: "played",
    _provenance: { writer: "loombridge-capture" },
  };
  const report = evaluatePlayability(halfMarked, CONTRACT as unknown as AcceptanceContract);
  assert.equal(report.verdict, "warn");
  assert.ok(report.checks.some((check) => check.id === "playability.evidenceOrigin"));
});

test("gate: a legacy self-declared 'teleported' still warns (unchanged behaviour for old files)", () => {
  const legacy: PlayabilityResults = {
    completable: true,
    completionMethod: "teleported",
    winRuleObserved: "all-fruit",
    hazardKills: true,
    collectibleIncrements: true,
    postWinInputLocked: true,
    postWinPlayerFrozen: true,
    restartWorks: true,
  };
  const report = evaluatePlayability(legacy, CONTRACT as unknown as AcceptanceContract);
  assert.equal(report.verdict, "warn");
  assert.match(
    report.checks.find((check) => check.id === "playability.completable")?.detail ?? "",
    /TELEPORTING/,
  );
});
