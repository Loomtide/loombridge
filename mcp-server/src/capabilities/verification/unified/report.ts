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

/**
 * The unified report filename under `.loombridge/reports/`. ONE constant; see A8.
 *
 * DOCUMENTED LIMITATION (L14). This file carries NO self-integrity stamp: nothing in
 * it proves it was written by the run it describes, and anyone who can edit the
 * project can write a green one by hand. That is why `doneness` consumes it as a
 * REFUSE-ONLY input: a non-zero `exit` ADDS a refusal reason, and a zero `exit` adds
 * nothing at all. A forged passing report therefore buys exactly one thing, the
 * absence of one extra refusal, while every existing doneness gate still applies. It
 * is never a source of green.
 */
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

/**
 * One section per asset family. `flow` covers trace replay (actuation + pixels); `tests`
 * grades a stamped Unity EditMode run offline.
 */
export type UnifiedSectionName = "contract" | "flow" | "feel" | "screens" | "tests";

/**
 * The run's overall word.
 *
 * - `pass`            everything discovered executed, every execution passed, AND every
 *                     executed section compared a frozen human-approved anchor (G1).
 * - `partial`         everything that executed passed, but something discovered did
 *                     NOT execute, or something that executed was measured against no
 *                     human approval. Honest about coverage instead of rounding up.
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
  /** Why this asset carries no report of its own (M5: "no report produced this run"). */
  note?: string;
}

export interface UnifiedVerifySection {
  /**
   * The per-asset engine's own status word, verbatim (never re-spelled here), with ONE
   * exception this module owns: `"refused"`, recorded when the engine exited at the
   * harness tier having graded nothing. The engine writes `warn` on that path (its
   * verdict file records every missing capture), and copying `warn` up here would put
   * the mildest word in the product on the run that measured nothing at all.
   */
  status: string;
  /** The tier this section earned: 0 pass, 1 game defect, 2 harness fault. */
  exit: number;
  /** The per-asset report this section produced, relative to the project root. */
  reportPath?: string;
  /**
   * A8 binding: sha256 of that per-asset report's bytes at write time. Without it the
   * roll-up merely NAMES a file; with it, the roll-up is bound to the exact bytes it
   * summarized, so a later hand-edit of the per-asset report is detectable.
   *
   * Both this and `reportPath` are stamped ONLY when THIS run actually (re)wrote the
   * file (M5): an engine that refused before writing would otherwise leave the previous
   * run's report standing, and the roll-up would present a stale sha as this run's
   * evidence. When nothing was written, both are omitted and `note` says so.
   */
  reportSha256?: string | null;
  /**
   * Why this section carries no report of its own, or any other one-line qualification
   * the summary must print alongside the status word.
   */
  note?: string;
  /**
   * M8: was a FROZEN, human-approved anchor actually compared in this section?
   *
   * A green section is not automatically an anchored one. The contract section grades
   * declared gates whether or not a design target was ever approved; the screens section
   * can grade declared screens while the layout baseline comparison did not happen. This
   * field is the machine-readable answer to "what did a human freeze, and was it used",
   * kept separate from `status` so neither can be inferred from the other.
   */
  anchored: boolean;
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
   *
   * DOCUMENTED LIMITATION (M7). This stamp is CONTEXTUAL, not an enforcement: it
   * records which build was in flight when the run happened, and nothing here refuses
   * a report whose runId has since gone stale. Freshness enforcement remains
   * `doneness`'s job (`verdict.runId === currentBuild.runId` plus the producedAt
   * ordering), and this field exists so the two documents can be cross-checked, not so
   * this one can self-certify.
   */
  runId: string | null;
  /** Whether live-only assets were executed (`--live`). */
  live: boolean;
  /** Every discovered asset, printed BEFORE anything ran. */
  plan: DiscoveredAsset[];
  /** Discovered assets that did not execute, and why. Never folded into pass. */
  notRun: UnifiedNotRun[];
  sections: Partial<Record<UnifiedSectionName, UnifiedVerifySection>>;
  /**
   * M8: which executed sections compared a frozen, human-approved anchor, and which
   * did not. A roll-up that reported only pass/fail would let "green" and "green
   * against nothing frozen" print identically.
   */
  anchoredSections: UnifiedSectionName[];
  unanchoredSections: UnifiedSectionName[];
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
 *   executed empty                                       -> nothing-checked, 2
 *   any executed tier 2                                  -> harness-fault,   2
 *   any executed tier 1 (no 2)                           -> fail,            1
 *   all 0, notRun empty, every section anchored          -> pass,            0
 *   all 0, notRun empty, any section UNANCHORED          -> partial,         0
 *   all 0, notRun all live-only                          -> partial,         0
 *   all 0, notRun has any other                          -> partial,         2
 *
 * G1: `pass` REQUIRES EVERY EXECUTED SECTION TO BE ANCHORED, and the rule is general
 * rather than a special case for one kind. A contract graded with no approved design
 * target, a stamped test run (which has no human-approve step at all, and never will),
 * a screens section whose baseline comparison did not happen: each is a real, green,
 * deterministic result measured against nothing a human ever froze, and the product's
 * whole claim is that a "done" verdict is anchored to a human approval. Printing the same
 * word for both readings is how "agents grade their own homework" comes back in through
 * the roll-up. The EXIT is unchanged (a green all-green run with no unmeasured anchor
 * still exits 0): this narrows what may be called a pass, it does not invent a failure.
 * `anchored` is REQUIRED on every entry rather than optional-with-a-default, so a caller
 * that forgets it fails to compile instead of silently claiming an anchor.
 *
 * A FOUND GAME DEFECT KEEPS EXIT 1, whatever else went unmeasured. The earlier cut
 * raised it to 2 whenever an anchor could not be measured, which quietly broke the
 * one promise the exit codes make: "2 is never a game verdict". A `fail` at exit 2
 * is a game verdict wearing the harness tier's clothes, and it is exactly the shape
 * an agent misreads as "the harness is flaky, re-run it". The unmeasured anchors do
 * not vanish: they are still every row of `notRun`, and the summary line names each
 * one, which is where coverage honesty belongs.
 *
 * `partial` never rounds up to `pass`: only the operator's own `--live` omission is
 * allowed to keep the exit at 0.
 */
export function resolveUnifiedOutcome(input: {
  executed: readonly { section: UnifiedSectionName; exit: number; anchored: boolean }[];
  notRun: readonly UnifiedNotRun[];
}): { status: UnifiedVerifyStatus; exit: number } {
  if (input.executed.length === 0) return { status: "nothing-checked", exit: 2 };

  const executedExit = worstExitTier(input.executed.map((e) => e.exit));
  if (executedExit === 2) return { status: "harness-fault", exit: 2 };
  if (executedExit === 1) return { status: "fail", exit: 1 };

  // G1. Read as a positive requirement, never as "skip the check when the field is absent":
  // the field is required by the type, and a `false` is what a section that compared nothing
  // frozen is obliged to report.
  const allAnchored = input.executed.every((e) => e.anchored);
  if (input.notRun.length === 0 && allAnchored) return { status: "pass", exit: 0 };
  const notRunExit = worstExitTier(input.notRun.map((n) => notRunTier(n.why)));
  return { status: "partial", exit: notRunExit };
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

/**
 * A per-asset report file as it stood at a point in time: the bytes' sha plus the
 * mtime. Both, because either alone can miss a rewrite (identical bytes rewritten,
 * or a filesystem with coarse mtime granularity).
 */
export interface ReportFingerprint {
  sha256: string | null;
  mtimeMs: number | null;
}

/** Fingerprint a per-asset report path. An absent or unreadable file is all-null. */
export async function fingerprintReport(absPath: string | undefined): Promise<ReportFingerprint> {
  if (!absPath) return { sha256: null, mtimeMs: null };
  try {
    const [bytes, stat] = await Promise.all([fs.readFile(absPath), fs.stat(absPath)]);
    return { sha256: createHash("sha256").update(bytes).digest("hex"), mtimeMs: stat.mtimeMs };
  } catch {
    return { sha256: null, mtimeMs: null };
  }
}

/**
 * Did THIS run (re)write the report? (M5)
 *
 * The attack this closes is cheap and quiet: run `verify` once so a good per-asset
 * report lands on disk, then break the asset so the engine refuses BEFORE writing
 * anything. The section would still find the old file, hash it, and stamp the
 * previous run's sha as this run's evidence, so the roll-up would name a report that
 * says nothing about the run it is attached to. A file that is absent both before and
 * after is likewise "not produced", never a silent pass.
 */
export function reportWasWritten(before: ReportFingerprint, after: ReportFingerprint): boolean {
  if (after.sha256 === null) return false;
  if (before.sha256 === null) return true;
  return before.sha256 !== after.sha256 || before.mtimeMs !== after.mtimeMs;
}

/**
 * A per-asset report path as recorded ON the report: relative to the project root when
 * it lives inside it, absolute when it does not.
 *
 * The workspace assets (feel, screens) live OUTSIDE the project by design, so a blind
 * `path.relative` produces a `../../..` string that means nothing without knowing the
 * cwd it will be resolved against. An escaping relative path is a path nothing can
 * walk, so it is stored absolute instead.
 */
export function reportPathFor(root: string, absPath: string | undefined): string | undefined {
  if (!absPath) return undefined;
  const rel = path.relative(root, absPath);
  return rel === "" || rel.startsWith("..") || path.isAbsolute(rel) ? absPath : rel;
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
