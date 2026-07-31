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
  DEGENERATE_LEG_REASON,
  actualFixedTicksOfPhase,
  controllerReportsEnabled,
  diagnoseFrozenPlayer,
  effectiveCaptureFps,
  evaluateSeamPersistence,
  positionFromSnapshot,
  runFeelSession,
  sweepTicksForTarget,
  type FeelSend,
} from "../../../../capabilities/verification/capture-feel.js";
import { deriveTimeToApex } from "../../../../capabilities/verification/feel-derive.js";
import { evaluatePhysicsTimestep } from "../../../../capabilities/verification/gates/physics-timestep.js";
import type { AcceptanceContract } from "../../../../capabilities/verification/types.js";
import type { FeelMeasurements, FeelTrajectorySample } from "../../../../capabilities/verification/gates/feel.js";
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
  /**
   * E6: the game is FROZEN: every step is a no-op, so every capture comes back as a
   * flat trajectory at one point. This is the live run-2 shape (a modal end state that
   * stopped the whole simulation) and it is what turned into `jumpApex: 0`.
   */
  frozen?: boolean;
  /** Freeze the SEAM probe only, so the keyed legs still run and the seam proof reads no motion. */
  seamProofDead?: boolean;
  /** The controller-facing get_snapshot answers `enabled: true` (an affirmative sign of life). */
  controllerReportsEnabled?: boolean;
  /** The controller-facing get_snapshot answers `enabled: false` (the end-state signature). */
  controllerDisabled?: boolean;
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

    // THE SAMPLER SAMPLES AT captureFps (E6). The fake used to emit ONE sample per
    // physics step whatever cadence was requested, so a 120fps trajectory leg came
    // back with half the samples a real 120fps capture returns, and every scripted
    // source therefore carried a cadence its own `captureFps` did not explain. That
    // is precisely what physics-timestep exists to catch, and the fake's cleanliness
    // hid the fencepost bug the live run then failed on. A finer cadence is an
    // integer multiple of the physics rate: sample k reports the state after step
    // floor(k / perStep), which reproduces the live pairing (two identical readings
    // per step at 120fps of a 60Hz sim).
    const perStep = Math.max(1, Math.round((captureFps || 1 / DT) * DT));
    const sampleMs = 1000 / (captureFps || 1 / DT);
    const samples: { tMs: number; x: number; y: number }[] = [{ tMs: 0, x: state.x, y: state.y }];
    const emitFor = (stepIndex: number): void => {
      for (let k = 0; k < perStep; k += 1) {
        const sampleIndex = stepIndex * perStep + k + 1;
        samples.push({ tMs: Math.round(sampleIndex * sampleMs * 100) / 100, x: state.x, y: state.y });
      }
    };
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
          moveX: keys.includes("d") || keys.includes("rightarrow") ? 1 : keys.includes("a") || keys.includes("leftarrow") ? -1 : 0,
          jumpHeld: keys.includes("space"),
          dashHeld: keys.includes("leftshift"),
        };
        if (!options.frozen) stepGame(state, input, step, prevJumpHeld);
        prevJumpHeld = input.jumpHeld;
        emitFor(step);
        step += 1;
        minY = Math.min(minY, state.y);
        maxY = Math.max(maxY, state.y);
      }
      phaseEcho.push({
        index,
        keys: phase.keys ?? [],
        requestedDurationMs: ticks * DT * 1000,
        sampleCount: ticks * perStep,
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
    // The first sample is the pre-step state, so N steps at `perStep` samples each
    // yield N*perStep+1 samples; the recipe's phase indexing sums the per-phase
    // counts, matching the live echo. `durationMs` is the SPAN of the samples, which
    // is what the live op echoes.
    return {
      samples,
      phases: phaseEcho,
      sampleCount: samples.length,
      durationMs: samples[samples.length - 1].tMs,
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
        if (!options.frozen && !options.seamProofDead) {
          stepGame(state, { moveX: effectiveMoveX, jumpHeld: false, dashHeld: effectiveDash }, step, false);
        }
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
      case "runtime.get_snapshot": {
        const components = params.components as string[] | undefined;
        if (components === undefined) {
          return { transform: { position: { x: DECLARED.spawnX, y: DECLARED.groundY, z: 0 } } };
        }
        if (components.includes("PlayerInputReader")) {
          // The reader read-back: unreadable today (L117).
          if (options.snapshotRefuses !== false) throw new Error("m_Enabled is not exposed by get_snapshot");
          return { components: [{ type: "PlayerInputReader", properties: { enabled: !readerLive } }] };
        }
        // E6: the CONTROLLER-facing snapshots: the between-legs liveness reading and
        // the no-motion diagnosis. Unanswerable by default, which is the live default
        // and the reason "we could not tell" must never count as a sign of life.
        if (options.controllerReportsEnabled || options.controllerDisabled) {
          return {
            activeInHierarchy: true,
            components: [
              {
                type_name: "PlayerController",
                properties: [],
                runtimeProperties: [
                  {
                    name: "enabled",
                    type: "Boolean",
                    value: Boolean(options.controllerReportsEnabled),
                    declaringType: "Behaviour",
                  },
                ],
              },
            ],
          };
        }
        throw new Error("component enabled state is not exposed by get_snapshot (L117)");
      }
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

test("E6 F1: a scene-qualified playerLocator reaches the WIRE as {scene, path}, never a bare path", async () => {
  // The live bridge refuses {"path":"Main:/Player"} outright; the fixtures always used
  // a qualified locator but nothing asserted the params actually handed to send(), so a
  // green suite shipped a producer that could not run against its own template's
  // format. This walks the wire params for every op that names the player.
  const bridge = fakeBridge();
  await runFeelSession({
    send: bridge.send,
    contract: contract(),
    runId: "run-e6-f1",
    editorSessionId: "session-e6",
  }).catch(() => {
    // Measurement outcomes are other tests' business; the wire shape is this one's.
  });
  const playerOps = bridge.calls.filter((c) => {
    const locator = (c.params.locator ?? c.params.measure) as Record<string, unknown> | undefined;
    if (locator === undefined) return false;
    return String(locator.path ?? "").includes("Player") || String(locator.scene ?? "").length > 0;
  });
  assert.ok(playerOps.length > 0, "the session must have sent at least one player-locator op");
  for (const call of playerOps) {
    const locator = (call.params.locator ?? call.params.measure) as { scene?: string; path?: string };
    assert.equal(locator.scene, "Level", `${call.command}: the scene qualifier must ride separately`);
    assert.equal(locator.path, "/Player", `${call.command}: the path must be bare`);
  }
});

// ── E6: the produced sources, graded by the gate they have to feed ──────────

test("E6: the produced sources PASS physics-timestep, the guard the scripted suite never had", () => {
  // Nothing graded the producer's own output through the cadence gate, so the two
  // shipped in one commit with incompatible arithmetic and the first live run failed
  // every source. This is that missing edge, and it is why the fake now samples at
  // the cadence it was asked for rather than once per physics step.
  return run().then(({ output }) => {
    const report = evaluatePhysicsTimestep(
      output.feel as unknown as FeelMeasurements,
      contract() as unknown as AcceptanceContract,
    );
    const cadence = report.checks.find((c) => c.id === "physics-timestep.effectiveCadence")!;
    assert.equal(cadence.status, "pass", cadence.actual);
    const pair = report.checks.find((c) => c.id === "physics-timestep.recordedCadencePair")!;
    assert.equal(pair.status, "pass", pair.detail);

    // LITMUS: bump ONE source's sampleCount by a single sample and the gate refuses.
    const sources = (output.feel.provenance as { sources: Record<string, unknown>[] }).sources;
    sources[0]!.sampleCount = (sources[0]!.sampleCount as number) + 1;
    assert.equal(
      evaluatePhysicsTimestep(output.feel as unknown as FeelMeasurements, contract() as unknown as AcceptanceContract)
        .checks.find((c) => c.id === "physics-timestep.effectiveCadence")!.status,
      "fail",
    );
  });
});

test("E6: the SWEEP source records windowCount, and it is the number of trials it retained", async () => {
  const { output } = await run();
  for (const metric of ["coyoteTime", "jumpBuffer"]) {
    const source = sourceFor(output, metric)!;
    const trials = source.trials as unknown[];
    assert.equal(source.windowCount, trials.length, `${metric} windowCount`);
    // The recorded cadence is the per-window rate, not the sum-over-one-fencepost
    // number the shipped producer wrote (60.6708 for a 60fps sweep).
    const sampleCount = source.sampleCount as number;
    const durationMs = source.durationMs as number;
    const expected = effectiveCaptureFps(sampleCount, durationMs, trials.length)!;
    assert.ok(Math.abs((source.effectiveCaptureFps as number) - expected) < 1e-3);
  }
});

// ── E6: timeToApex from launch ──────────────────────────────────────────────

test("E6: timeToApex is measured from LAUNCH, so the 12-tick settle prefix is not in the number", async () => {
  const { output } = await run();
  // The scripted controller launches at 12 u/s under 30 u/s²: v0/g = 400ms exactly.
  // The jump leg prepends 12 settle ticks (200ms) plus a tick of injection latency,
  // all of which the old first-sample anchor charged to the rise.
  const measured = output.feel.timeToApex as number;
  assert.ok(Math.abs(measured - 400) <= 2 * (DT * 1000), `timeToApex ${measured} (analytic 400ms)`);
  assert.ok(measured < 500, "the settle prefix must not be inside the reading");

  // …and it re-derives from the source's own samples, which is what the gate checks.
  const source = sourceFor(output, "timeToApex")!;
  assert.equal(deriveTimeToApex(source.samples as FeelTrajectorySample[]), measured);
});

// ── E6: the runway ──────────────────────────────────────────────────────────

test("E6: runLeg.ticks bounds BOTH the run leg and the coyote calibration walk", async () => {
  const short = await run({}, {
    harness: {
      feelSeam: {
        playerLocator: "Level:/Player",
        controllerComponent: "PlayerController",
        inputReaderComponent: "PlayerInputReader",
        fields: { moveX: "moveX", jumpHeld: "jumpHeld", dashHeld: "dashHeld" },
        keys: { jump: "Space", moveRight: "D", jumpCut: "Space", dash: "LeftShift" },
        runLeg: { ticks: 20 },
      },
    },
  });
  const holds = short.bridge.calls
    .filter((c) => c.command === "runtime.capture_input_motion")
    .flatMap((c) => (c.params.phases as { keys?: string[]; fixedTicks?: number }[]) ?? [])
    .filter((p) => (p.keys ?? []).includes("D") && !(p.keys ?? []).includes("Space"));
  assert.ok(holds.length >= 2, "the run leg and the calibration walk both hold the move key");
  for (const phase of holds) {
    assert.ok((phase.fixedTicks ?? 0) <= 20, `a horizontal hold ran ${phase.fixedTicks} ticks past the declared runway`);
  }

  // POSITIVE CONTROL: the DEFAULT is unchanged, so no existing contract moves.
  const { bridge } = await run();
  const defaultHold = (bridge.calls
    .filter((c) => c.command === "runtime.capture_input_motion")
    .flatMap((c) => (c.params.phases as { keys?: string[]; fixedTicks?: number }[]) ?? [])
    .find((p) => (p.keys ?? []).includes("D") && !(p.keys ?? []).includes("Space")))!;
  assert.equal(defaultHold.fixedTicks, 90);
});

test("E6: runLeg.direction -1 injects moveLeft and drives moveX negative, and measures the same speed", async () => {
  const left = await run({}, {
    harness: {
      feelSeam: {
        playerLocator: "Level:/Player",
        controllerComponent: "PlayerController",
        inputReaderComponent: "PlayerInputReader",
        fields: { moveX: "moveX", jumpHeld: "jumpHeld", dashHeld: "dashHeld" },
        keys: { jump: "Space", moveRight: "D", moveLeft: "A", jumpCut: "Space", dash: "LeftShift" },
        runLeg: { ticks: 90, direction: -1 },
      },
    },
  });
  const keyed = left.bridge.calls
    .filter((c) => c.command === "runtime.capture_input_motion")
    .flatMap((c) => (c.params.phases as { keys?: string[] }[]) ?? []);
  assert.ok(keyed.some((p) => (p.keys ?? []).includes("A")), "the leftward runway must inject moveLeft");
  assert.equal(keyed.some((p) => (p.keys ?? []).includes("D")), false, "and never the rightward key");

  // The SEAM-driven proof drives the field negative, not just the keyed legs.
  const proof = left.bridge.calls.find((c) => c.command === "runtime.probe")!;
  const drives = ((proof.params.phases as { drivers?: { property_path: string; value: unknown }[] }[]) ?? [])
    .flatMap((p) => p.drivers ?? [])
    .filter((d) => d.property_path === "moveX")
    .map((d) => d.value);
  assert.ok(drives.includes(-1), `moveX drives were ${JSON.stringify(drives)}`);

  // AND the derivations are direction-blind: |dx| either way, so the runway bound
  // cannot move a measured value.
  const { output: right } = await run();
  assert.ok(
    Math.abs((left.output.feel.runSpeed as number) - (right.feel.runSpeed as number)) < 1e-6,
    `left ${left.output.feel.runSpeed} vs right ${right.feel.runSpeed}`,
  );
});

// ── E6: the frozen corpse ───────────────────────────────────────────────────

test("E6: a leg that never moves the player OMITS its metrics and ABORTS the session, never derives 0", async () => {
  const { output } = await run({ frozen: true });
  // The zeroes that shipped are gone.
  assert.equal(output.feel.jumpApex, undefined);
  assert.equal(output.feel.timeToApex, undefined);
  assert.equal(output.feel.runSpeed, undefined);
  assert.ok(output.omitted.some((o) => o.metric === "runSpeed" && o.reason === DEGENERATE_LEG_REASON));

  // …and the session gave up after the FIRST corpse rather than measuring five more.
  assert.ok(output.aborted, "a dead player must end the session");
  assert.equal(output.aborted!.leg, "run");
  assert.match(output.aborted!.reason, /moved the player not at all/);
  const legs = (output.feel._provenance as { ops: { leg?: string }[] }).ops
    .map((op) => op.leg)
    .filter((leg): leg is string => typeof leg === "string");
  assert.equal(legs.some((leg) => leg.startsWith("shortHop")), false, "no leg after the abort may run");
  assert.equal(legs.some((leg) => leg.includes("coyote")), false);

  // POSITIVE CONTROL: the same code path on the LIVE game measures normally.
  const { output: alive } = await run();
  assert.equal(alive.aborted, undefined);
  assert.ok((alive.feel.runSpeed as number) > 0);
});

test("E6: a controller that reports itself ENABLED keeps the session alive even after a still leg", async () => {
  // Liveness is `the leg moved it OR the controller says it is enabled`. A game that
  // simply does not respond to one stimulus is not a corpse, and must not abort.
  const { output } = await run({ frozen: true, controllerReportsEnabled: true });
  assert.equal(output.aborted, undefined);
  assert.ok(output.omitted.some((o) => o.reason === DEGENERATE_LEG_REASON), "the metric is still omitted, not zeroed");
  assert.equal(output.feel.jumpApex, undefined);
});

// ── E6: honest blame for a no-motion seam proof ────────────────────────────

test("E6: diagnoseFrozenPlayer blames the END STATE when the snapshot says so, and the seam otherwise", () => {
  const seam = {
    playerLocator: "Main:/Player",
    controllerComponent: "PlayerController",
    inputReaderComponent: "PlayerInputReader",
    fields: { moveX: "moveX" },
    keys: { jump: "Space", moveRight: "D" },
  };
  // The shape the LIVE bridge returns (E6 run 1's readerDisable.snapshotReadBack):
  // components[].runtimeProperties[] = {name, type, value, declaringType}.
  const disabled = {
    activeInHierarchy: true,
    components: [
      {
        type_name: "PlayerController",
        properties: [],
        runtimeProperties: [{ name: "enabled", type: "Boolean", value: false, declaringType: "Behaviour" }],
      },
    ],
  };
  assert.match(diagnoseFrozenPlayer(disabled, seam)!, /controller component "PlayerController" reports enabled=false/);
  assert.match(diagnoseFrozenPlayer(disabled, seam)!, /restart play mode/);

  const notSimulated = {
    activeInHierarchy: true,
    components: [{ type_name: "Rigidbody2D", runtimeProperties: [{ name: "simulated", value: false }] }],
  };
  assert.match(diagnoseFrozenPlayer(notSimulated, seam)!, /Rigidbody2D reports simulated=false/);

  assert.match(diagnoseFrozenPlayer({ activeInHierarchy: false }, seam)!, /INACTIVE in the hierarchy/);

  // …and when NOTHING in the snapshot accuses anything, it says nothing: the seam
  // sentence stands. Silence is not a clean bill of health, it is no evidence.
  const healthy = {
    activeInHierarchy: true,
    components: [{ type_name: "PlayerController", runtimeProperties: [{ name: "enabled", value: true }] }],
  };
  assert.equal(diagnoseFrozenPlayer(healthy, seam), null);
  assert.equal(diagnoseFrozenPlayer(undefined, seam), null);

  // controllerReportsEnabled is the affirmative half, and an unanswerable snapshot
  // is NOT a yes.
  assert.equal(controllerReportsEnabled(healthy, seam), true);
  assert.equal(controllerReportsEnabled(disabled, seam), false);
  assert.equal(controllerReportsEnabled({ available: false }, seam), false);
});

test("E6: a no-motion seam proof says END STATE when the scene says so, not 'wrong component/field name'", async () => {
  const { output } = await run({ readerStaysLive: true, seamProofDead: true, controllerDisabled: true });
  const disable = (output.feel._provenance as Record<string, unknown>).readerDisable as Record<string, unknown>;
  assert.equal(disable.ok, false);
  assert.match(String(disable.reason), /reports enabled=false/);
  assert.equal(/wrong component\/field name/.test(String(disable.reason)), false, "the seam must not be blamed");

  // POSITIVE CONTROL: the SAME dead drive with a snapshot that accuses nothing keeps
  // the seam sentence, because then the seam really is the best available guess.
  const { output: noEvidence } = await run({ readerStaysLive: true, seamProofDead: true });
  const bare = (noEvidence.feel._provenance as Record<string, unknown>).readerDisable as Record<string, unknown>;
  assert.match(String(bare.reason), /wrong component\/field name/);
});

// ── E6: capture exit honesty ────────────────────────────────────────────────

test("E6: a capture that leaves a BANDED metric unmeasured reports it, so the CLI can refuse to exit 0", async () => {
  const { output } = await run({ frozen: true });
  // Run 2's shape: the contract bands metrics the session could not measure.
  assert.deepEqual(
    [...output.unmeasuredAcceptedTargets].sort(),
    ["coyoteTime", "jumpApex", "jumpBuffer", "runSpeed"],
  );
  // Every one of them carries a stated reason: no banded metric is silently absent.
  for (const metric of output.unmeasuredAcceptedTargets) {
    assert.ok(output.omitted.some((o) => o.metric === metric), `${metric} has no stated reason`);
  }

  // POSITIVE CONTROL: a fully-measured session owes nothing, which is the exit-0 path.
  const { output: full } = await run();
  assert.deepEqual(full.unmeasuredAcceptedTargets, []);
});
