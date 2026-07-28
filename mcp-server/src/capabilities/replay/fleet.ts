/**
 * Replay Verification — fleet roll-up (Fleet Verification).
 *
 * `summarizeFleet(results)` is a PURE aggregation of N per-trace replay outcomes
 * into one fleet verdict: counts (pass/fail/blocked/drift) and the worst status
 * across the catalog. This is the scale layer for a minigame catalog — run every
 * trace, get one report. The batch orchestration (discover + replay each) lives
 * in the verb; this stays pure and unit-testable.
 */

import type { BlockedReason, DivergenceKind, ReplayStatus } from "./types.js";

/** One trace's outcome within a fleet run. */
export interface FleetTraceResult {
  id: string;
  status: ReplayStatus;
  blockedReason?: BlockedReason;
  /** True if any capture drifted from its baseline (a warning, per the design). */
  visualDrift: boolean;
  /**
   * True if a capture's visual comparison could not be made (unreadable actual or
   * baseline PNG): a capture gap, NOT drift. Optional so an older roll-up parses.
   */
  visualHarnessFault?: boolean;
  /** A brief first-divergence summary for the index (full detail in the per-trace report). */
  firstDivergence?: { kind: DivergenceKind; segment: string | null };
  /** Present when the trace could not be replayed at all (bad JSON, bridge failure). */
  error?: string;
  durationMs: number;
  /** Path to this trace's report (relative to the fleet report), for linking. */
  report: string;
}

export interface FleetCounts {
  total: number;
  pass: number;
  fail: number;
  blocked: number;
  /** Number of passing/failing traces that ALSO drifted visually (a warning). */
  drift: number;
}

export interface FleetReport {
  generatedAt: string;
  /**
   * Worst status across the fleet: any fail → fail; else any blocked OR any
   * unreadable-capture harness fault → blocked; else pass. A harness fault rides
   * `blocked` because that is this vocabulary's "no verdict was produced" value:
   * a roll-up that read `pass` while the run exited 2 would be a false green on disk.
   */
  status: ReplayStatus;
  counts: FleetCounts;
  traces: FleetTraceResult[];
}

export function summarizeFleet(
  traces: FleetTraceResult[],
  generatedAt: string,
): FleetReport {
  const counts: FleetCounts = {
    total: traces.length,
    pass: traces.filter((t) => t.status === "pass").length,
    fail: traces.filter((t) => t.status === "fail").length,
    blocked: traces.filter((t) => t.status === "blocked").length,
    drift: traces.filter((t) => t.visualDrift).length,
  };
  const harnessFaults = traces.filter((t) => t.visualHarnessFault).length;
  const status: ReplayStatus =
    counts.fail > 0 ? "fail" : counts.blocked > 0 || harnessFaults > 0 ? "blocked" : "pass";
  return { generatedAt, status, counts, traces };
}
