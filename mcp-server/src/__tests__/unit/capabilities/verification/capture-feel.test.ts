/**
 * THE FEEL PRODUCER against a SCRIPTED BRIDGE (evidence arc E1, stage 2).
 *
 * The fake below is not a stub returning canned numbers: it is a small deterministic
 * platformer that interprets the phases the recipe actually sends, with a DECLARED
 * run speed, jump speed, coyote window and jump buffer. So the recipe drives a game
 * whose truth is known, and the assertions are recoveries: the `feel.json` it writes
 * must contain the game's declared values, derived through the same code path a live
 * run uses. Every wire interaction is mocked; no editor is involved.
 *
 * The fake also reproduces the two facts the convention is built from: sample `i`
 * shows the state after step `i-1`, and an injected key is consumed one step after
 * its phase begins: and the ledger-C1 contention: while the input reader is enabled,
 * a value written to the controller seam survives exactly one FixedUpdate.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  actualFixedTicksOfPhase,
  effectiveCaptureFps,
  evaluateSeamPersistence,
  positionFromSnapshot,
  runFeelSession,
  sweepTicksForTarget,
  type FeelSend,
} from "../../../../capabilities/verification/capture-feel.js";
import { SHORT_HOP_CANONICAL_TAP_TICKS } from "../../../../domain/feel-primitives.js";

// ── the scripted game ───────────────────────────────────────────────────────

const DT = 1 / 60;
const DECLARED = {
  runSpeed: 7,
  jumpSpeed: 12,
  gravity: -30,
  jumpCutMultiplier: 0.5,
  coyoteSeconds: 0.1,
  bufferSeconds: 0.1,
  dashSpeed: 18.75,
  dashSeconds: 0.15,
  spawnX: 0,
  ledgeX: 2,
  groundY: 0,
  lowerGroundY: -5,
};

interface Phase {
  keys?: string[];
  fixedTicks?: number;
  durationMs?: number;
  drivers?: { property_path: string; value: unknown }[];
  value?: unknown;
}

interface GameState {
  x: number;
  y: number;
  vy: number;
  grounded: boolean;
  ungroundStep: number | null;
  bufferedAtStep: number | null;
  dashTicksLeft: number;
}

function spawnState(): GameState {
  return {
    x: DECLARED.spawnX,
    y: DECLARED.groundY,
    vy: 0,
    grounded: true,
    ungroundStep: null,
    bufferedAtStep: null,
    dashTicksLeft: 0,
  };
}

/** The floor under the player: past the ledge there is a drop. */
function floorAt(x: number): number {
  return x > DECLARED.ledgeX ? DECLARED.lowerGroundY : DECLARED.groundY;
}

interface StepInput {
  moveX: number;
  jumpHeld: boolean;
  dashHeld: boolean;
}

/** One fixed step of the scripted controller. */
function stepGame(state: GameState, input: StepInput, step: number, prevJumpHeld: boolean): void {
  const pressedJump = input.jumpHeld && !prevJumpHeld;
  const releasedJump = !input.jumpHeld && prevJumpHeld;

  if (pressedJump) {
    const airborneTicks = state.ungroundStep === null ? Infinity : step - state.ungroundStep;
    if (state.grounded || airborneTicks <= DECLARED.coyoteSeconds / DT) {
      state.vy = DECLARED.jumpSpeed;
      state.grounded = false;
    } else {
      state.bufferedAtStep = step;
    }
  }
  if (releasedJump && state.vy > 0) state.vy *= DECLARED.jumpCutMultiplier;
  if (input.dashHeld && state.dashTicksLeft === 0) {
    state.dashTicksLeft = Math.round(DECLARED.dashSeconds / DT);
  }

  if (state.dashTicksLeft > 0) {
    state.x += DECLARED.dashSpeed * DT;
    state.dashTicksLeft -= 1;
  } else {
    state.x += input.moveX * DECLARED.runSpeed * DT;
  }
  if (state.grounded && state.x > DECLARED.ledgeX) {
    state.grounded = false;
    state.ungroundStep = step;
  }
  if (!state.grounded) {
    state.vy += DECLARED.gravity * DT;
    state.y += state.vy * DT;
    const floor = floorAt(state.x);
    if (state.y <= floor) {
      state.y = floor;
      state.vy = 0;
      state.grounded = true;
      state.ungroundStep = null;
      if (state.bufferedAtStep !== null && step - state.bufferedAtStep <= DECLARED.bufferSeconds / DT) {
        state.vy = DECLARED.jumpSpeed;
        state.grounded = false;
        state.y += state.vy * DT;
      }
      state.bufferedAtStep = null;
    }
  }
}

interface FakeOptions {
  /** Leave the input reader ENABLED, so driven seam values are zeroed after a tick (C1). */
  readerStaysLive?: boolean;
  /** Refuse the get_snapshot read-back, as the live bridge does today (L117). */
  snapshotRefuses?: boolean;
  /** Drop `actualFixedTicks` from the echo (an off-canon tap the file must not launder). */
  tapTicksOverride?: number;
  /**
   * Stage 3: `runtime.probe` now echoes captureFps + both timestep fields
   * (ComputeProbeResult). Off by default so the OLD-bridge path stays covered.
   */
  probeEchoesProvenance?: boolean;
}

interface FakeBridge {
  send: FeelSend;
  calls: { command: string; params: Record<string, unknown> }[];
  readerEnabled: boolean[];
}

function fakeBridge(options: FakeOptions = {}): FakeBridge {
  const calls: { command: string; params: Record<string, unknown> }[] = [];
  const readerEnabled: boolean[] = [];
  let readerLive = true;
  let state = spawnState();

  const runKeyed = (phases: Phase[], captureFps: number): Record<string, unknown> => {
    // ONE TICK OF INJECTION LATENCY. A key whose phase begins at sample index j is
    // consumed by the controller at step j+1, not step j: the same live behaviour
    // the canonical short-hop constant is built around (a 2-3 tick tap never
    // registers at all). The fake reproduces it by running the whole capture off a
    // key sequence shifted one step, which is what makes the recipe's tick
    // convention testable end to end here.
    const stepKeys: string[][] = [];
    const phaseTicks: number[] = [];
    for (const phase of phases) {
      const ticks = phase.fixedTicks ?? Math.round(((phase.durationMs ?? 0) / 1000) * (1 / DT));
      phaseTicks.push(ticks);
      for (let i = 0; i < ticks; i += 1) stepKeys.push((phase.keys ?? []).map((k) => k.toLowerCase()));
    }

    const samples: { tMs: number; x: number; y: number }[] = [{ tMs: 0, x: state.x, y: state.y }];
    const phaseEcho: Record<string, unknown>[] = [];
    let step = 0;
    let prevJumpHeld = false;
    for (const [index, phase] of phases.entries()) {
      const ticks = phaseTicks[index];
      const startTick = step;
      const startX = state.x;
      const startY = state.y;
      let minY = state.y;
      let maxY = state.y;
      for (let i = 0; i < ticks; i += 1) {
        const keys = step === 0 ? [] : stepKeys[step - 1];
        const input: StepInput = {
          moveX: keys.includes("d") || keys.includes("rightarrow") ? 1 : 0,
          jumpHeld: keys.includes("space"),
          dashHeld: keys.includes("leftshift"),
        };
        stepGame(state, input, step, prevJumpHeld);
        prevJumpHeld = input.jumpHeld;
        step += 1;
        samples.push({ tMs: step * DT * 1000, x: state.x, y: state.y });
        minY = Math.min(minY, state.y);
        maxY = Math.max(maxY, state.y);
      }
      phaseEcho.push({
        index,
        keys: phase.keys ?? [],
        requestedDurationMs: ticks * DT * 1000,
        sampleCount: ticks,
        ...(phase.fixedTicks === undefined ? {} : { requestedFixedTicks: phase.fixedTicks }),
        fixedTickStart: startTick,
        fixedTickEnd: step,
        actualFixedTicks:
          options.tapTicksOverride !== undefined && index === 1 ? options.tapTicksOverride : step - startTick,
        startX,
        endX: state.x,
        deltaX: state.x - startX,
        startY,
        endY: state.y,
        deltaY: state.y - startY,
        minY,
        maxY,
      });
    }
    // The first sample is the pre-step state, so N steps yield N+1 samples; the
    // recipe's phase indexing sums the per-phase counts, matching the live echo.
    void captureFps;
    return {
      samples,
      phases: phaseEcho,
      sampleCount: samples.length,
      durationMs: step * DT * 1000,
      projectFixedTimestepBeforeMeasurement: DT,
      measurementFixedTimestep: DT,
      peakY: Math.max(...samples.map((s) => s.y)),
      deltaX: state.x - samples[0].x,
    };
  };

  const runProbe = (phases: Phase[]): Record<string, unknown> => {
    const samples: { tMs: number; x: number; y: number; phase: number }[] = [];
    const phaseEcho: Record<string, unknown>[] = [];
    let step = 0;
    let moveX = 0;
    let dashHeld = false;
    for (const [index, phase] of phases.entries()) {
      for (const driver of phase.drivers ?? []) {
        if (driver.property_path === "moveX") moveX = Number(driver.value) || 0;
        if (driver.property_path === "dashHeld") dashHeld = driver.value === true;
      }
      const ticks = Math.round(((phase.durationMs ?? 0) / 1000) * (1 / DT));
      let count = 0;
      for (let i = 0; i < ticks; i += 1) {
        // C1: a LIVE input reader rewrites the seam every Update, so a driven value
        // survives exactly one FixedUpdate and then reads zero.
        const effectiveMoveX = readerLive && i > 0 ? 0 : moveX;
        const effectiveDash = readerLive && i > 0 ? false : dashHeld;
        stepGame(state, { moveX: effectiveMoveX, jumpHeld: false, dashHeld: effectiveDash }, step, false);
        step += 1;
        count += 1;
        samples.push({ tMs: step * DT * 1000, x: state.x, y: state.y, phase: index });
      }
      phaseEcho.push({ index, sampleCount: count, requestedDurationMs: phase.durationMs });
      dashHeld = false;
    }
    // A PRE-STAGE-3 probe echoes NO captureFps and NEITHER timestep field: the live
    // gap (ledger L75) this fake reproduces on purpose. `probeEchoesProvenance`
    // switches it to the stage-3 bridge, whose ComputeProbeResult echoes all three.
    return {
      samples,
      phases: phaseEcho,
      sampleCount: samples.length,
      totalDurationMs: step * DT * 1000,
      ...(options.probeEchoesProvenance
        ? {
            captureFps: 60,
            projectFixedTimestepBeforeMeasurement: DT,
            measurementFixedTimestep: DT,
          }
        : {}),
    };
  };

  const send: FeelSend = async (command, params = {}) => {
    calls.push({ command, params });
    switch (command) {
      case "editor.play":
      case "editor.wait_for":
      case "editor.stop":
      case "input.begin_session":
      case "input.end_session":
        return {};
      case "editor.console_logs":
        return { logs: [{ type: "Log", message: "hello" }] };
      case "scene.set_transform": {
        const position = params.position as { x: number; y: number } | undefined;
        state = spawnState();
        if (position) {
          state.x = position.x;
          state.y = position.y;
        }
        return {};
      }
      case "runtime.get_snapshot":
        if (params.components !== undefined) {
          // The reader read-back: unreadable today (L117).
          if (options.snapshotRefuses !== false) throw new Error("m_Enabled is not exposed by get_snapshot");
          return { components: [{ type: "PlayerInputReader", properties: { enabled: !readerLive } }] };
        }
        return { transform: { position: { x: DECLARED.spawnX, y: DECLARED.groundY, z: 0 } } };
      case "component.set_property":
        if (params.property_path === "m_Enabled") {
          readerLive = params.value === true ? true : Boolean(options.readerStaysLive);
          readerEnabled.push(params.value === true);
        }
        return {};
      case "runtime.capture_input_motion":
        return runKeyed(params.phases as Phase[], Number(params.captureFps));
      case "runtime.probe":
        return runProbe(params.phases as Phase[]);
      default:
        throw new Error(`unscripted op: ${command}`);
    }
  };

  return { send, calls, readerEnabled };
}

// ── the contract ────────────────────────────────────────────────────────────

function contract(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: "1",
    game: "fake-platformer",
    physics: { fixedTimestep: DT },
    feel: {
      runSpeed: { target: DECLARED.runSpeed, unit: "u/s", band: { percent: 10 } },
      jumpApex: { target: 2.4, unit: "u", band: { percent: 10 } },
      coyoteTime: { target: DECLARED.coyoteSeconds, unit: "s", band: { abs: 0.02 } },
      jumpBuffer: { target: DECLARED.bufferSeconds, unit: "s", band: { abs: 0.02 } },
    },
    harness: {
      feelSeam: {
        playerLocator: "Level:/Player",
        controllerComponent: "PlayerController",
        inputReaderComponent: "PlayerInputReader",
        fields: { moveX: "moveX", jumpHeld: "jumpHeld", dashHeld: "dashHeld" },
        keys: { jump: "Space", moveRight: "D", jumpCut: "Space", dash: "LeftShift" },
      },
    },
    ...overrides,
  };
}

async function run(options: FakeOptions = {}, contractOverrides: Record<string, unknown> = {}) {
  const bridge = fakeBridge(options);
  const output = await runFeelSession({
    send: bridge.send,
    contract: contract(contractOverrides),
    runId: "run-1",
    editorSessionId: "session-abc",
    now: () => "2026-07-30T00:00:00.000Z",
  });
  return { bridge, output };
}

function sourceFor(output: { feel: Record<string, unknown> }, metric: string): Record<string, unknown> | undefined {
  const provenance = output.feel.provenance as { sources?: Record<string, unknown>[] };
  return (provenance.sources ?? []).find((s) => (s.measuredMetrics as string[] | undefined)?.includes(metric));
}

// ── recoveries ──────────────────────────────────────────────────────────────

test("the producer recovers the scripted game's declared run speed and jump height", async () => {
  const { output } = await run();
  assert.ok(Math.abs((output.feel.runSpeed as number) - DECLARED.runSpeed) < 0.2, `runSpeed ${output.feel.runSpeed}`);
  // Analytic apex for a 12 u/s launch under 30 u/s²: v²/2g = 2.4u.
  assert.ok(Math.abs((output.feel.jumpApex as number) - 2.4) < 0.15, `jumpApex ${output.feel.jumpApex}`);
  assert.ok((output.feel.timeToApex as number) > 0);
});

test("the producer recovers the scripted game's declared coyote window and jump buffer", async () => {
  const { output } = await run();
  assert.ok(
    Math.abs((output.feel.coyoteTime as number) - DECLARED.coyoteSeconds) <= DT,
    `coyoteTime ${output.feel.coyoteTime} vs declared ${DECLARED.coyoteSeconds}`,
  );
  assert.ok(
    Math.abs((output.feel.jumpBuffer as number) - DECLARED.bufferSeconds) <= DT,
    `jumpBuffer ${output.feel.jumpBuffer} vs declared ${DECLARED.bufferSeconds}`,
  );
});

test("a DIFFERENT declared coyote window produces a different measured value (the recipe measures, it does not echo the target)", async () => {
  const bridgeA = fakeBridge();
  const a = await runFeelSession({
    send: bridgeA.send,
    contract: contract(),
    runId: "r",
    editorSessionId: "s",
    now: () => "t",
  });
  // Same game, a contract whose TARGET is wrong by 50ms: the measurement must not move.
  const bridgeB = fakeBridge();
  const b = await runFeelSession({
    send: bridgeB.send,
    contract: contract({
      feel: {
        runSpeed: { target: DECLARED.runSpeed, unit: "u/s", band: { percent: 10 } },
        coyoteTime: { target: 0.05, unit: "s", band: { abs: 0.02 } },
      },
    }),
    runId: "r",
    editorSessionId: "s",
    now: () => "t",
  });
  assert.equal(a.feel.coyoteTime, b.feel.coyoteTime);
  assert.ok(Math.abs((a.feel.coyoteTime as number) - DECLARED.coyoteSeconds) <= DT);
});

// ── provenance mechanics ────────────────────────────────────────────────────

test("every source carries the producer marker, a derivation, and echo-sourced timestep fields", async () => {
  const { output } = await run();
  const sources = (output.feel.provenance as { sources: Record<string, unknown>[] }).sources;
  assert.ok(sources.length >= 5);
  for (const source of sources) {
    assert.equal(source.producedBy, "loombridge-capture");
    assert.ok(typeof source.derivation === "string", "a produced source with no derivation is refused by feel-rederive");
  }
  const runSource = sourceFor(output, "runSpeed")!;
  assert.equal(runSource.measurementFixedTimestep, DT);
  assert.equal(runSource.projectFixedTimestepBeforeMeasurement, DT);
  assert.equal(runSource.requestedCaptureFps, 120);
  assert.ok(typeof runSource.effectiveCaptureFps === "number");
});

test("the short-hop stimulus binds tapTicks to the ECHOED actualFixedTicks, never a literal (L46)", async () => {
  const { output } = await run();
  const stimulus = sourceFor(output, "shortHopApex")!.stimulus as Record<string, unknown>;
  assert.equal(stimulus.metric, "shortHopApex");
  assert.equal(stimulus.tapTicks, SHORT_HOP_CANONICAL_TAP_TICKS);

  // LITMUS: the bridge reports a SEVEN-tick tap for the same 6-tick request (the
  // exact L40 case). The file must carry the 7 the bridge reported: which the
  // canonical-tap check then refuses: not the 6 that was asked for.
  const off = await run({ tapTicksOverride: 7 });
  const offStimulus = sourceFor(off.output, "shortHopApex")!.stimulus as Record<string, unknown>;
  assert.equal(offStimulus.tapTicks, 7);
});

test("the sweeps retain every trial's raw echo, and the headline re-derives from them (L77)", async () => {
  const { output } = await run();
  for (const metric of ["coyoteTime", "jumpBuffer"]) {
    const source = sourceFor(output, metric)!;
    assert.equal(source.derivation, "input-bisection");
    const trials = source.trials as { phases: unknown[]; samples: unknown[] }[];
    assert.ok(trials.length >= 8, `${metric} retained ${trials.length} trials`);
    for (const trial of trials) {
      assert.ok(Array.isArray(trial.phases) && trial.phases.length > 0, "a trial with no phase echo is a retyped table");
      assert.ok(Array.isArray(trial.samples) && trial.samples.length > 0, "a trial with no samples cannot be re-derived");
    }
    assert.equal(source.tickOffset, 2);
  }
});

test("the run binding is stamped unconditionally, and an absent editor session refuses (H11/L106)", async () => {
  const { output } = await run();
  const provenance = output.feel._provenance as Record<string, unknown>;
  assert.equal(provenance.writer, "loombridge-capture");
  assert.equal(provenance.runId, "run-1");
  assert.equal(provenance.editorSessionId, "session-abc");

  const bridge = fakeBridge();
  await assert.rejects(
    runFeelSession({ send: bridge.send, contract: contract(), runId: "run-1" }),
    /editorSessionId/,
  );
});

// ── the harness refusal (S2a / M14) ─────────────────────────────────────────

test("a contract with no harness block REFUSES and names the JSON to add", async () => {
  const bridge = fakeBridge();
  await assert.rejects(
    runFeelSession({
      send: bridge.send,
      contract: { schemaVersion: "1", game: "x", feel: {} },
      runId: "r",
      editorSessionId: "s",
    }),
    (error: Error) => {
      assert.match(error.message, /no `harness` section/);
      assert.match(error.message, /"feelSeam"/);
      assert.match(error.message, /inputReaderComponent/);
      return true;
    },
  );
  // …and nothing was driven: the refusal lands before play mode is entered.
  assert.deepEqual(bridge.calls.map((c) => c.command), []);
});

test("a half-declared seam refuses too (a missing reader component is not a default)", async () => {
  const bridge = fakeBridge();
  await assert.rejects(
    runFeelSession({
      send: bridge.send,
      contract: contract({
        harness: {
          feelSeam: {
            playerLocator: "Level:/Player",
            controllerComponent: "PlayerController",
            fields: { moveX: "moveX" },
            keys: { jump: "Space", moveRight: "D" },
          },
        },
      }),
      runId: "r",
      editorSessionId: "s",
    }),
    /missing required field\(s\): inputReaderComponent/,
  );
});

// ── the reader disable, proven behaviorally (S2b / M15) ─────────────────────

test("the input reader is disabled AFTER the keyed legs and re-enabled in the finally", async () => {
  const { bridge } = await run();
  const commands = bridge.calls.map((c) => c.command);
  const firstDisable = bridge.calls.findIndex((c) => c.command === "component.set_property" && c.params.value === false);
  const lastKeyed = commands.lastIndexOf("runtime.capture_input_motion");
  assert.ok(firstDisable > lastKeyed, "the reader must stay LIVE while keys are being injected");
  assert.deepEqual(bridge.readerEnabled, [false, true], "the reader is disabled once and restored once");
  assert.ok(commands.indexOf("editor.stop") > commands.lastIndexOf("component.set_property"));
});

test("M15: when the reader is NOT really disabled, the seam leg refuses and dashDistance is omitted", async () => {
  const { output } = await run({ readerStaysLive: true });
  const disable = (output.feel._provenance as Record<string, unknown>).readerDisable as Record<string, unknown>;
  assert.equal(disable.ok, false);
  assert.match(String(disable.reason), /did NOT survive the window|ledger-C1/);
  assert.equal(output.feel.dashDistance, undefined, "no seam measurement may be taken through an unproven disable");
  assert.ok(output.omitted.some((o) => o.metric === "dashDistance"));
});

test("M15: the get_snapshot read-back is attempted and its unavailability is recorded, not hidden (L117)", async () => {
  const { output } = await run();
  const disable = (output.feel._provenance as Record<string, unknown>).readerDisable as Record<string, unknown>;
  assert.equal(disable.ok, true);
  assert.equal(disable.decidedBy, "behavioral (driven-value persistence)");
  assert.equal((disable.snapshotReadBack as Record<string, unknown>).available, false);
});

test("the dash is measured whole-window and its provenance gap is NAMED, not typed away (L75)", async () => {
  const { output } = await run();
  // 9 dash ticks at 18.75 u/s: 0.15s × 18.75 = 2.8125u, the exact value the
  // phase-delta recipe could not reach (ledger L42/L91).
  assert.ok(Math.abs((output.feel.dashDistance as number) - 2.8125) < 0.05, `dashDistance ${output.feel.dashDistance}`);
  const source = sourceFor(output, "dashDistance")!;
  assert.equal(source.derivation, "window-delta");
  assert.equal(source.captureFps, undefined, "runtime.probe does not echo captureFps, so the producer must not invent one");
  assert.equal(source.measurementFixedTimestep, undefined);
  assert.deepEqual(source.notEchoedByOp, [
    "captureFps",
    "projectFixedTimestepBeforeMeasurement",
    "measurementFixedTimestep",
  ]);
  assert.ok(output.gaps.some((g) => /runtime\.probe echoed no captureFps/.test(g)));
  assert.ok(output.gaps.some((g) => /predates the stage-3 ComputeProbeResult echo/.test(g)));
});

test("stage 3: when the probe ECHOES its provenance, the dash source carries it and the gap is gone", async () => {
  // The other half of the stage-3 echo fix: ComputeProbeResult now reports
  // captureFps + both timestep fields, so the producer no longer has to leave the
  // dash source uncertifiable. The values are COPIED from the response: the fake
  // echoes captureFps 60, and a producer that typed its own requested pin instead
  // would show that here.
  const { output } = await run({ probeEchoesProvenance: true });
  const source = sourceFor(output, "dashDistance")!;
  assert.equal(source.captureFps, 60);
  assert.equal(source.projectFixedTimestepBeforeMeasurement, DT);
  assert.equal(source.measurementFixedTimestep, DT);
  assert.equal(source.notEchoedByOp, undefined, "nothing is missing, so nothing is listed as missing");
  assert.equal(
    output.gaps.some((g) => /runtime\.probe echoed no/.test(g)),
    false,
    "the provenance gap closes when the bridge closes it",
  );
});

test("the seam leg is skipped honestly when the contract declares no dash field", async () => {
  const { output } = await run(
    {},
    {
      harness: {
        feelSeam: {
          playerLocator: "Level:/Player",
          controllerComponent: "PlayerController",
          inputReaderComponent: "PlayerInputReader",
          fields: { moveX: "moveX" },
          keys: { jump: "Space", moveRight: "D" },
        },
      },
    },
  );
  assert.equal(output.feel.dashDistance, undefined);
  assert.ok(output.omitted.some((o) => o.metric === "dashDistance" && /dashHeld is not declared/.test(o.reason)));
});

// ── pure helpers ────────────────────────────────────────────────────────────

test("evaluateSeamPersistence: a sustained ramp passes, a one-tick-then-flat trace refuses (C1 signature)", () => {
  const sustained = Array.from({ length: 18 }, (_, i) => ({ tMs: i * 16.7, x: i * 0.116, y: 0 }));
  assert.equal(evaluateSeamPersistence(sustained).ok, true);

  const oneTick = Array.from({ length: 18 }, (_, i) => ({ tMs: i * 16.7, x: i === 0 ? 0 : 0.116, y: 0 }));
  const verdict = evaluateSeamPersistence(oneTick);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason ?? "", /did NOT survive the window/);

  const still = Array.from({ length: 18 }, (_, i) => ({ tMs: i * 16.7, x: 0, y: 0 }));
  assert.match(evaluateSeamPersistence(still).reason ?? "", /does not move this player/);
});

test("effectiveCaptureFps re-derives the cadence a capture ACHIEVED (H8)", () => {
  assert.equal(effectiveCaptureFps(121, 1000), 120);
  assert.equal(effectiveCaptureFps(undefined, 1000), undefined);
  assert.equal(effectiveCaptureFps(1, 1000), undefined);
});

test("actualFixedTicksOfPhase reads the phase the recipe names, not the first one it finds", () => {
  const phases = [
    { index: 0, actualFixedTicks: 12 },
    { index: 1, actualFixedTicks: 7 },
  ];
  assert.equal(actualFixedTicksOfPhase(phases, 1), 7);
  assert.equal(actualFixedTicksOfPhase(phases, 5), undefined);
});

test("sweepTicksForTarget binds the sweep RANGE to the contract target, clamped", () => {
  assert.equal(sweepTicksForTarget(0.1, DT), 10);
  assert.equal(sweepTicksForTarget(0.15, DT), 13);
  assert.equal(sweepTicksForTarget(undefined, DT), 12);
  assert.equal(sweepTicksForTarget(0.001, DT), 8);
  assert.equal(sweepTicksForTarget(5, DT), 20);
});

test("positionFromSnapshot reads the shapes the snapshot op may return, and refuses the rest", () => {
  assert.deepEqual(positionFromSnapshot({ transform: { position: { x: 1, y: 2, z: 3 } } }), { x: 1, y: 2, z: 3 });
  assert.deepEqual(positionFromSnapshot({ position: { x: 1, y: 2 } }), { x: 1, y: 2, z: 0 });
  assert.equal(positionFromSnapshot({ transform: {} }), null);
  assert.equal(positionFromSnapshot(null), null);
});
