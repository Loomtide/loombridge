/**
 * Frame-integrity gate.
 *
 * WHY: a clean-room run PASSED its ADVISORY Tier-2 VLM perceptual review against
 * THREE "different" key frames (`spawn`, `win`, `dash-mid`) that were
 * byte-identical — the SAME image captured three times (a stale/duplicate
 * capture). The review then rubber-stamped `end-state-styling` (the win banner)
 * and `juice-cue-presence` (the dash trail) against frames that never showed
 * those states, and nothing caught it: the deterministic gates never looked at
 * the frames, and the perceptual review trusted the file names.
 *
 * This gate is the deterministic guard: it FAILS the build when distinct-state
 * key frames are byte-identical, so a perceptual review of those frames can
 * never silently rubber-stamp a state the frame does not show.
 *
 * INPUT (derived by `run-gates` from the VLM review's `frames[]`):
 *
 *   {
 *     frames: [{ id, path, hash }],   // hash = precomputed content hash
 *                                     // (sha256 hex), or null if unreadable.
 *   }
 *
 * ACCEPTANCE: unused — frame distinctness is a property of the capture itself,
 * not the design contract.
 *
 * CHECKS:
 *  - No frames declared -> a single WARN (`frame-integrity.frames`): nothing to
 *    verify; don't crash.
 *  - Each frame with `hash === null` -> a WARN (`frame-integrity.<id>.readable`):
 *    that frame could not be read/hashed, so its integrity is unverified. Other
 *    frames are still evaluated.
 *  - Among frames WITH a hash, group ids by hash. Any hash shared by ≥2 DISTINCT
 *    ids -> a FAIL (`frame-integrity.distinct`, one per colliding group): those
 *    frames are byte-identical, so the perceptual review of them is invalid.
 *  - ≥2 hashed frames with NO collision -> a PASS (`frame-integrity.distinct`):
 *    the key frames are pairwise distinct.
 *
 * Mirrors the doc-comment + GateCheck style of `placement.ts`.
 */

import type { AcceptanceContract } from "../types.js";
import {
  makeGateReport,
  type GateCheck,
  type GateReport,
} from "./types.js";

/** A captured key frame + its precomputed content hash (null = unreadable). */
export interface FrameIntegrityFrame {
  /** Stable frame id, e.g. "spawn", "dash-mid", "win". */
  id: string;
  /** Artifact path to the captured PNG. */
  path: string;
  /** sha256 hex of the file bytes, or null when the file is missing/unreadable. */
  hash: string | null;
}

/** The key frames whose distinctness this gate verifies. */
export interface FrameIntegrityInput {
  frames: Array<FrameIntegrityFrame>;
}

export const GATE_NAME = "frame-integrity";

/** Short, human-readable hash prefix for the report. */
function hashPrefix(hash: string): string {
  return hash.slice(0, 12);
}

export function evaluateFrameIntegrity(
  input: FrameIntegrityInput,
  _acceptance: AcceptanceContract,
): GateReport {
  const checks: GateCheck[] = [];

  const frames = input.frames ?? [];

  if (frames.length === 0) {
    return makeGateReport(GATE_NAME, [
      {
        id: "frame-integrity.frames",
        expected: "≥1 key frame declared in the VLM review",
        actual: "(none)",
        status: "warn",
        detail:
          "No key frames declared in the VLM review to verify; frame integrity not checked.",
      },
    ]);
  }

  // ---- UNREADABLE FRAMES warn (others are still evaluated) ----
  for (const frame of frames) {
    if (frame.hash === null) {
      checks.push({
        id: `frame-integrity.${frame.id}.readable`,
        expected: "frame file readable + hashable",
        actual: "(unreadable)",
        status: "warn",
        detail: `Could not read/hash ${frame.path} — frame integrity not verified for '${frame.id}'.`,
      });
    }
  }

  // ---- DISTINCTNESS: group ids by content hash; collisions are FAILs ----
  const hashed = frames.filter(
    (f): f is FrameIntegrityFrame & { hash: string } => f.hash !== null,
  );

  const byHash = new Map<string, string[]>();
  for (const frame of hashed) {
    const ids = byHash.get(frame.hash) ?? [];
    ids.push(frame.id);
    byHash.set(frame.hash, ids);
  }

  const collisions = [...byHash.entries()].filter(([, ids]) => ids.length >= 2);

  if (collisions.length > 0) {
    for (const [hash, ids] of collisions) {
      checks.push({
        id: "frame-integrity.distinct",
        expected: "distinct key frames differ",
        actual: `frames [${ids.join(", ")}] are byte-identical (sha256 ${hashPrefix(hash)})`,
        status: "fail",
        detail: `Frames [${ids.join(", ")}] are byte-identical (sha256 ${hashPrefix(hash)}) — a stale/duplicate capture (sim-throttle returned the same framebuffer, or a racy \`ls -t | cp\` grabbed one file), so the perceptual review of these frames is invalid. Re-capture each as a distinct state.`,
      });
    }
    return makeGateReport(GATE_NAME, checks);
  }

  // ---- No collisions: pass when ≥2 frames are pairwise distinct ----
  if (hashed.length >= 2) {
    checks.push({
      id: "frame-integrity.distinct",
      expected: "distinct key frames differ",
      actual: `${hashed.length} hashed key frames are pairwise distinct`,
      status: "pass",
      detail: `${hashed.length} key frames are pairwise distinct (no two share a content hash).`,
    });
  }

  return makeGateReport(GATE_NAME, checks);
}
