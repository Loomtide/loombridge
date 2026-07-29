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

/**
 * The SCOPED run's report (S2a/F1). A `--only` run NEVER writes `verify.json`.
 *
 * The failure this separates is quiet and total: `verify.json` is the document `doneness`
 * reads, and a scoped run answers a strictly narrower question than the one that file is
 * understood to answer. Letting `--only tests` overwrite the full run's roll-up would mean
 * a subset run silently replaces (and, when the subset is green, erases) the record of
 * every anchor the full run could not measure. Two files, two questions, and the full
 * report keeps meaning what it has always meant.
 *
 * `doneness` deliberately does NOT read this file: a scoped run is never a certificate,
 * and the belt-and-braces refusal in `unifiedVerifyRefusals` (a `verify.json` whose `only`
 * is a non-null array) covers the unreachable case where one lands there anyway.
 */
export const UNIFIED_SCOPED_REPORT = "verify-scoped.json";

/** Resolve the unified report path from a reports dir (the only spelling of the name). */
export function unifiedVerifyReportPath(reportsDir: string): string {
  return path.join(reportsDir, UNIFIED_VERIFY_REPORT);
}

/** Resolve the verify-owned screens report path (the only spelling of the name). */
export function unifiedScreensReportPath(reportsDir: string): string {
  return path.join(reportsDir, UNIFIED_SCREENS_REPORT);
}

/** Resolve the SCOPED (`--only`) report path (the only spelling of the name). */
export function unifiedScopedReportPath(reportsDir: string): string {
  return path.join(reportsDir, UNIFIED_SCOPED_REPORT);
}

/**
 * One section per asset family. `flow` covers trace replay (actuation + pixels); `tests`
 * grades a stamped Unity EditMode run offline.
 */
export type UnifiedSectionName = "contract" | "flow" | "feel" | "screens" | "tests";

/**
 * The CLOSED list of section names, in plan order. It is the `--only` vocabulary AND the
 * report's own section vocabulary, spelled once: a selector the report cannot express
 * would be a selector nothing could grade.
 */
export const UNIFIED_SECTION_NAMES = ["contract", "flow", "feel", "screens", "tests"] as const;

/**
 * Which SECTION an asset kind is graded by. Single source of truth, because `--only`
 * deselection and the section dispatch must agree: a mapping re-spelled at the call site
 * would let a selector name a section that the orchestrator then runs anyway (or worse,
 * deselect an asset the orchestrator still executes).
 */
export const SECTION_FOR_KIND: Readonly<Record<DiscoveredAssetKind, UnifiedSectionName>> = {
  contract: "contract",
  trace: "flow",
  "feel-snapshot": "feel",
  "screen-contract": "screens",
  "test-results": "tests",
};

/**
 * Parse a `--only` value into a selection, or into the refusal sentence that must be
 * printed instead (S2a). Pure, so the refusals are pinned without an argv round trip.
 *
 * Refuse-not-skip: an unknown name, an empty selection, and a selection made only of
 * separators are each a REFUSAL naming the valid names, never a silently widened run. A
 * selector that quietly fell back to "everything" would turn a CI job that believes it is
 * checking one section into a full run, and (worse in the other direction) a typo'd
 * selector into a run that grades nothing while reporting on its own terms.
 */
export function parseOnlySelection(
  raw: string,
): { ok: true; sections: UnifiedSectionName[] } | { ok: false; error: string } {
  const known = UNIFIED_SECTION_NAMES.join(", ");
  const requested = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (requested.length === 0) {
    return {
      ok: false,
      error: `--only needs at least one section name. Known: ${known}.`,
    };
  }
  const unknown = requested.filter((s) => !(UNIFIED_SECTION_NAMES as readonly string[]).includes(s));
  if (unknown.length > 0) {
    return {
      ok: false,
      error: `unknown --only section(s): ${unknown.join(", ")}. Known: ${known}.`,
    };
  }
  // De-duplicated, and re-ordered into plan order so `--only tests,contract` and
  // `--only contract,tests` produce the same recorded scoping.
  const selected = new Set(requested as UnifiedSectionName[]);
  return { ok: true, sections: UNIFIED_SECTION_NAMES.filter((s) => selected.has(s)) };
}

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
 * A HEALTHY discovered asset the operator scoped out with `--only` (S2a/F2).
 *
 * A SEPARATE type from {@link UnifiedNotRun}, on purpose. `notRun` rows carry a tier into
 * `resolveUnifiedOutcome`; deselected rows carry none, because the operator chose the
 * scope. Keeping them in one array with a "costs nothing" class would put a zero-tier
 * member one edit away from every unmeasured anchor, which is exactly the laundering path
 * F2 exists to close. Two types cannot be confused by a refactor.
 *
 * Only a row with `runnable !== "no"` can ever land here: broken, non-anchor and draft rows
 * stay in `notRun` whatever the selection says. Tampering is never scoped away.
 */
export interface UnifiedDeselected {
  kind: DiscoveredAssetKind;
  id: string;
  /** The section this asset would have been graded by, i.e. the name that would select it. */
  section: UnifiedSectionName;
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
  /**
   * FXC: the BUILD SCOPE of the evidence this section graded, when the evidence carries one.
   *
   * `string` when the graded artifact was stamped with a `STATE.currentBuild.runId`, `null`
   * when it was stamped outside any build, and ABSENT for sections whose evidence has no such
   * stamp at all. The three states are distinct on purpose: a reader of `verify.json` can
   * tell a build-scoped section from an unscoped one without parsing stderr, and `null` is
   * printed rather than omitted so "unscoped" cannot be mistaken for "not applicable".
   */
  runId?: string | null;
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
  /**
   * S2a/F12: the `--only` scoping of THIS run, or `null` for a full run. REQUIRED rather
   * than optional-when-absent, so a reader (and `doneness`) never has to treat a missing
   * field as "probably a full run": the two states are always both written down.
   */
  only: UnifiedSectionName[] | null;
  /** Healthy assets the scoping excluded. Empty on a full run. Never part of the calculus. */
  deselected: UnifiedDeselected[];
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
 *   all 0, ZERO executed sections anchored               -> partial,         2
 *   all 0, >= 1 anchored, notRun empty, some UNANCHORED  -> partial,         0
 *   all 0, >= 1 anchored, notRun all live-only           -> partial,         0
 *   all 0, >= 1 anchored, notRun has any other           -> partial,         2
 *
 * FXH, THE ZERO-ANCHORED EXIT RULE. Exit 0 additionally requires AT LEAST ONE anchored
 * executed section. G1 already refused to CALL such a run a pass, but the exit stayed 0, and
 * the exit is the only part of this an agent reads: a project with a single self-produced
 * asset (a stamped test run, a contract with no approved design target) could still exit 0
 * having compared nothing any human ever froze, which is precisely the self-graded green the
 * product exists to refuse. So a run in which NOTHING anchored was compared exits 2, the
 * harness tier, because "there was nothing here that could certify anything" is a statement
 * about the evidence, not a defect in the game. A MIXED run is unaffected: one anchored green
 * section still exits 0 with the unanchored extras named, because the run really did measure
 * something a human approved.
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
 *
 * SCOPED RUNS CANNOT SAY `pass` (F2). When `scoped` is true the ceiling is `partial`, whatever
 * the selected sections did: the word `pass` on this document means "everything this project
 * can prove was proved", and a subset run has not asked that question. The EXIT is untouched
 * (a scoped run of anchored green sections still exits 0, so `--only` stays usable in CI);
 * what a scoped run may never do is produce the word an agent quotes as a full green.
 */
export function resolveUnifiedOutcome(input: {
  executed: readonly { section: UnifiedSectionName; exit: number; anchored: boolean }[];
  notRun: readonly UnifiedNotRun[];
  /** `--only` was in force. Never inferred from an empty selection: the caller states it. */
  scoped?: boolean;
}): { status: UnifiedVerifyStatus; exit: number } {
  if (input.executed.length === 0) return { status: "nothing-checked", exit: 2 };

  const executedExit = worstExitTier(input.executed.map((e) => e.exit));
  if (executedExit === 2) return { status: "harness-fault", exit: 2 };
  if (executedExit === 1) return { status: "fail", exit: 1 };

  // G1. Read as a positive requirement, never as "skip the check when the field is absent":
  // the field is required by the type, and a `false` is what a section that compared nothing
  // frozen is obliged to report.
  const anchoredCount = input.executed.filter((e) => e.anchored).length;
  const allAnchored = anchoredCount === input.executed.length;
  if (input.notRun.length === 0 && allAnchored) {
    return input.scoped ? { status: "partial", exit: 0 } : { status: "pass", exit: 0 };
  }
  // FXH: counted, not merely "all or not all". Zero anchored executed sections means this run
  // compared nothing human-approved, and a self-produced green cannot exit 0.
  if (anchoredCount === 0) return { status: "partial", exit: 2 };
  const notRunExit = worstExitTier(input.notRun.map((n) => notRunTier(n.why)));
  return { status: "partial", exit: notRunExit };
}

/**
 * The one-line reason a zero-anchored run cannot exit 0 (FXH).
 *
 * Exported so the summary line and the tests that pin it read the same string, rather than a
 * sentence in the orchestrator and a regex in a test that drift apart.
 */
export const ZERO_ANCHORED_SUMMARY =
  "nothing human-approved was compared; a self-produced green cannot exit 0";

/**
 * The one-line reason a scoped run is never a full pass (S2a/F2), shared by the summary
 * line and the tests that pin it for the same reason as {@link ZERO_ANCHORED_SUMMARY}.
 */
export const SCOPED_SUMMARY =
  "SCOPED RUN (--only): a subset was measured, so this is never a full pass and never a certificate";

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
