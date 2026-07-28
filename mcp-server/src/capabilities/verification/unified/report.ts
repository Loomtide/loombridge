/**
 * The unified `verify` report: one document per run, one section per verification
 * asset, and ONE exit tier derived from them (RFC `Docs/Design/UnifiedVerify.md`, S1).
 *
 * This module owns the two decisions that must never be made ad hoc at a call site:
 * what tier a run exits with, and what word describes it. Both are pure and
 * exhaustively unit-tested, because "the run exited 0" is the single claim the whole
 * product rests on.
 *
 * The report is written ALONGSIDE the per-asset reports (build-verdict.json, the
 * replay report JSONs, the drift report), never instead of them: existing tooling
 * and `doneness` read those, and a roll-up that swallowed them would break the
 * binding they carry.
 */

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import type { DiscoveredAsset, DiscoveredAssetKind, NotRunClass } from "./discovery.js";

/** The unified report filename under `.loombridge/reports/`. ONE constant; see A8. */
export const UNIFIED_VERIFY_REPORT = "verify.json";

/**
 * The verify-owned screens report. The guided mini-game flow drives its own state
 * machine off the WORKSPACE report path, so the unified run writes somewhere else
 * entirely rather than advancing (or resetting) that flow behind the operator's back.
 */
export const UNIFIED_SCREENS_REPORT = "verify-screens.json";

/** Resolve the unified report path from a reports dir (the only spelling of the name). */
export function unifiedVerifyReportPath(reportsDir: string): string {
  return path.join(reportsDir, UNIFIED_VERIFY_REPORT);
}

/** Resolve the verify-owned screens report path (the only spelling of the name). */
export function unifiedScreensReportPath(reportsDir: string): string {
  return path.join(reportsDir, UNIFIED_SCREENS_REPORT);
}

/** One section per asset family. `flow` covers trace replay (actuation + pixels). */
export type UnifiedSectionName = "contract" | "flow" | "feel" | "screens";

/**
 * The run's overall word.
 *
 * - `pass`            everything discovered executed, and every execution passed.
 * - `partial`         everything that executed passed, but something discovered did
 *                     NOT execute. Honest about coverage instead of rounding up.
 * - `fail`            an executed check found a game defect.
 * - `harness-fault`   an executed check could not be trusted (capture gap, broken
 *                     asset). Never reported as a game defect.
 * - `nothing-checked` zero assets executed. Never exit 0.
 */
export type UnifiedVerifyStatus = "pass" | "partial" | "fail" | "harness-fault" | "nothing-checked";

/**
 * Why a discovered asset did not execute. This CLASS, not the prose reason, decides
 * whether the run may still exit 0.
 *
 * Discovery's own three classes (`non-anchor`, `draft`, `broken`) plus the one the
 * ORCHESTRATOR adds: `live-only-skipped`, the asset needs `--live` and the operator
 * did not pass it. That one alone is an explicit operator choice, so it alone may
 * still exit 0; every other class is an anchor the run could not measure.
 */
export type NotRunReason = NotRunClass | "live-only-skipped";

export interface UnifiedNotRun {
  kind: DiscoveredAssetKind;
  id: string;
  /** The human sentence from the discovery row. */
  reason: string;
  why: NotRunReason;
}

/**
 * One executed ASSET inside a section. A section can cover several assets (a project
 * with three approved traces has one `flow` section), and a roll-up that reported only
 * the worst of them would hide WHICH trace broke. The section keeps its single status
 * and tier; this array is the per-asset detail behind it.
 */
export interface UnifiedAssetOutcome {
  kind: DiscoveredAssetKind;
  id: string;
  /** The per-asset engine's own status word, verbatim. */
  status: string;
  exit: number;
  reportPath?: string;
  reportSha256?: string | null;
}

export interface UnifiedVerifySection {
  /** The per-asset engine's own status word, verbatim (never re-spelled here). */
  status: string;
  /** The tier this section earned: 0 pass, 1 game defect, 2 harness fault. */
  exit: number;
  /** The per-asset report this section produced, relative to the project root. */
  reportPath?: string;
  /**
   * A8 binding: sha256 of that per-asset report's bytes at write time. Without it the
   * roll-up merely NAMES a file; with it, the roll-up is bound to the exact bytes it
   * summarized, so a later hand-edit of the per-asset report is detectable.
   */
  reportSha256?: string | null;
  /** Every asset this section executed, when the section covers more than one. */
  assets?: UnifiedAssetOutcome[];
}

export interface UnifiedVerifyReport {
  kind: "unified-verify";
  schemaVersion: "1";
  producedAt: string;
  root: string;
  /**
   * A8 binding: the run this verdict certifies (`STATE.currentBuild.runId`), or null
   * when no build is in flight. The SAME rule `build-verdict.json` uses, so the two
   * can be checked against each other.
   */
  runId: string | null;
  /** Whether live-only assets were executed (`--live`). */
  live: boolean;
  /** Every discovered asset, printed BEFORE anything ran. */
  plan: DiscoveredAsset[];
  /** Discovered assets that did not execute, and why. Never folded into pass. */
  notRun: UnifiedNotRun[];
  sections: Partial<Record<UnifiedSectionName, UnifiedVerifySection>>;
  status: UnifiedVerifyStatus;
  exit: number;
  notes: string[];
}

/**
 * Worst tier across executed sections: any 2 beats any 1 beats 0.
 *
 * 2 dominating 1 is deliberate and is the harness-fault invariant in arithmetic form:
 * once any part of a run could not be trusted, the run as a whole cannot be reported
 * as a clean game verdict, in either direction.
 *
 * An EMPTY list is 0 here, and that is not the zero-executed answer: "nothing ran" is
 * `nothing-checked` (exit 2), decided by `resolveUnifiedOutcome`, because a
 * worst-of reducer over an empty set has no honest opinion to give.
 */
export function worstExitTier(codes: readonly number[]): number {
  let worst = 0;
  for (const code of codes) {
    if (code === 2) return 2;
    if (code > worst) worst = code;
  }
  return worst;
}

/** Map a not-run reason to the tier it contributes (A6). */
function notRunTier(why: NotRunReason): number {
  // A deliberate `--live` omission is the ONLY non-execution an operator chose; every
  // other one is an anchor the run could not measure, which is the harness tier.
  return why === "live-only-skipped" ? 0 : 2;
}

/**
 * The run's status word + exit tier.
 *
 * Truth table (executed = sections that actually ran):
 *
 *   executed empty                            -> nothing-checked, 2
 *   any executed tier 2                       -> harness-fault,   2
 *   any executed tier 1 (no 2)                -> fail,            max(1, notRun tiers)
 *   all executed 0, notRun empty              -> pass,            0
 *   all executed 0, notRun all live-only      -> partial,         0
 *   all executed 0, notRun has any other      -> partial,         2
 *
 * `partial` never rounds up to `pass`: the summary line names every unmeasured
 * anchor, and only the operator's own `--live` omission is allowed to keep the exit
 * at 0.
 */
export function resolveUnifiedOutcome(input: {
  executed: readonly { section: UnifiedSectionName; exit: number }[];
  notRun: readonly UnifiedNotRun[];
}): { status: UnifiedVerifyStatus; exit: number } {
  const notRunExit = worstExitTier(input.notRun.map((n) => notRunTier(n.why)));
  if (input.executed.length === 0) return { status: "nothing-checked", exit: 2 };

  const executedExit = worstExitTier(input.executed.map((e) => e.exit));
  const exit = worstExitTier([executedExit, notRunExit]);
  if (executedExit === 2) return { status: "harness-fault", exit };
  if (executedExit === 1) return { status: "fail", exit };
  if (input.notRun.length === 0) return { status: "pass", exit };
  return { status: "partial", exit };
}

/**
 * sha256 of a per-asset report's bytes, or null when it cannot be read. Null is the
 * honest answer for "no binding available"; it is never silently omitted, so a
 * section with `reportSha256: null` reads as unbound rather than unmentioned.
 */
export async function reportSha256(absPath: string | undefined): Promise<string | null> {
  if (!absPath) return null;
  try {
    return createHash("sha256").update(await fs.readFile(absPath)).digest("hex");
  } catch {
    return null;
  }
}

/** Serialize the report to `outputPath`, creating the reports dir. */
export async function writeUnifiedVerifyReport(
  outputPath: string,
  report: UnifiedVerifyReport,
): Promise<void> {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf-8");
}

/**
 * Turn a NOT-runnable discovery row into a `notRun` entry.
 *
 * The class is READ from the row (`notRunClass`), never re-derived from its prose:
 * a tiering rule that pattern-matched the human `reason` would change an exit code
 * the next time someone reworded a sentence. A row that somehow carries no class
 * falls back to `non-anchor`, the conservative choice (tier 2, never a pass).
 */
export function notRunFor(asset: DiscoveredAsset): UnifiedNotRun {
  return {
    kind: asset.kind,
    id: asset.id,
    reason: asset.reason ?? "not runnable",
    why: asset.notRunClass ?? "non-anchor",
  };
}
