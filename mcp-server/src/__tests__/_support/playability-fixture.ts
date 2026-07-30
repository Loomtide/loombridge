/**
 * A PRODUCED `playability.json`, for tests that need the observer's evidence shape
 * without a scripted bridge (evidence arc stage 3).
 *
 * Stage 3 caps agent-assembled playability evidence at WARN, so every suite that
 * wants a green playability gate now needs a file with a real recording behind it.
 * This mints the smallest honest one: a short per-frame window in which the player
 * runs, collects, takes a hit, and wins, plus the three post-win probe traces. It
 * is deliberately built the way the producer builds it (the headline is whatever
 * `derivePlayability` derives from these buffers) so a fixture can never drift into
 * asserting a headline the derivation would refuse.
 */

import {
  derivePlayability,
  deriveKinematicBound,
  type ObservationBuffers,
} from "../../domain/playability-observation.js";

const DT_MS = 1000 / 60;

export interface PlayabilityFixtureOptions {
  /** The acceptance contract the evidence is graded against (supplies the bound). */
  contract: unknown;
  /** The contract's own `win.rule` string, echoed when the rule check passes. */
  contractWinRule?: string;
  /** Samples in the recorded window. */
  samples?: number;
  /** Sample index where the win field flips. */
  winAt?: number;
  /** Collectibles the bridge counted in the scene at open. */
  collectibleTotal?: number;
  /** A single-frame position jump, to build an ASSISTED fixture. */
  hop?: { at: number; dx: number };
  runId?: string;
  editorSessionId?: string;
}

function buildBuffers(options: PlayabilityFixtureOptions): ObservationBuffers {
  const count = options.samples ?? 60;
  const winAt = options.winAt ?? 50;
  const total = options.collectibleTotal ?? 3;
  const scoreAt = new Set(Array.from({ length: total }, (_, i) => 10 + i * 8));
  const buffers: ObservationBuffers = {
    tMs: [],
    frame: [],
    fixedTick: [],
    x: [],
    y: [],
    win: [],
    score: [],
    lives: [],
  };
  let x = 0;
  let score = 0;
  let lives = 3;
  let win = false;
  for (let i = 0; i < count; i += 1) {
    if (i > 0) x += 0.08;
    if (options.hop && i === options.hop.at) x += options.hop.dx;
    if (scoreAt.has(i)) score += 1;
    if (i === 35) lives -= 1;
    if (i === winAt) win = true;
    buffers.tMs.push(Math.round(i * DT_MS * 1000) / 1000);
    buffers.frame.push(100 + i);
    buffers.fixedTick.push(i);
    buffers.x.push(Math.round(x * 1e6) / 1e6);
    buffers.y.push(1);
    buffers.win.push(win);
    (buffers.score as number[]).push(score);
    (buffers.lives as number[]).push(lives);
  }
  return buffers;
}

function frozenProbe(x: number): { tMs: number; x: number; y: number }[] {
  return Array.from({ length: 20 }, (_, i) => ({ tMs: Math.round(i * DT_MS * 1000) / 1000, x, y: 1 }));
}

function restartWindow(): ObservationBuffers {
  return {
    tMs: [0, 16.667, 33.333],
    frame: [900, 901, 902],
    fixedTick: [0, 1, 2],
    x: [0, 0, 0],
    y: [1, 1, 1],
    win: [true, false, false],
    score: [3, 0, 0],
    lives: [1, 3, 3],
  };
}

/**
 * The produced evidence file: headline + `_provenance` with the recording the gate
 * re-derives from. Throws if the fixture's own window would be refused, so a broken
 * fixture fails loudly here instead of quietly at the gate.
 */
export function producedPlayabilityEvidence(
  options: PlayabilityFixtureOptions,
): Record<string, unknown> {
  const boundResolution = deriveKinematicBound(options.contract);
  if (!boundResolution.ok) throw new Error(`playability fixture: ${boundResolution.refusal}`);
  const bound = boundResolution.bound;
  const buffers = buildBuffers(options);
  const collectibleTotal = options.collectibleTotal ?? 3;
  const finalX = buffers.x[buffers.x.length - 1];
  const probes = {
    freezeSamples: frozenProbe(finalX),
    inputLockSamples: frozenProbe(finalX),
    restartBuffers: restartWindow(),
  };
  const context = {
    winRule: "all-collectibles" as const,
    contractWinRule: options.contractWinRule ?? "all-fruit",
    collectibleTotal,
    spawn: { x: 0, y: 1 },
    droppedSamples: 0,
    bound,
  };
  const derivation = derivePlayability(buffers, context, probes);
  if (derivation.refusals.length > 0) {
    throw new Error(`playability fixture: the synthetic window would be refused: ${derivation.refusals.join("; ")}`);
  }

  return {
    ...derivation.headline,
    _provenance: {
      writer: "loombridge-capture",
      recipe: "playability",
      capturedAt: "2026-07-30T00:00:00.000Z",
      capturedInPlayMode: true,
      runId: options.runId ?? "run-fixture",
      editorSessionId: options.editorSessionId ?? "editor-fixture",
      observation: {
        sessionId: "fixture-session",
        open: {
          capacity: 36000,
          fixedTimestep: 0.0166667,
          spawn: { x: 0, y: 1, z: 0 },
          collectibleTotal,
          initial: { tMs: 0, frame: 100, x: 0, y: 1, win: false, score: 0, lives: 3 },
        },
        accounting: {
          wasRecording: true,
          sampleCount: buffers.tMs.length,
          totalSampled: buffers.tMs.length,
          droppedSamples: 0,
          capacity: 36000,
          elapsedMs: buffers.tMs[buffers.tMs.length - 1],
          effectiveSampleRateHz: 60,
          unreadableFields: [],
        },
        context: { winRule: context.winRule, contractWinRule: context.contractWinRule, bound },
        buffers,
        probes,
        derived: derivation.observation,
      },
    },
  };
}
