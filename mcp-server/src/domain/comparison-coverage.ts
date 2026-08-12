/**
 * COMPARISON COVERAGE: how many comparisons a gate was supposed to perform, how many it
 * actually performed, and the refusal that reads the difference.
 *
 * THE RULE. Every anchor on disk already declares its own denominator: an approved trace
 * baseline declares `manifest.pngs`, a screen contract declares `contract.states`, a feel
 * snapshot declares `manifest.metrics`, a slice verdict's evidence ledger declares
 * `sliceEvidenceFiles(acceptance.gates)`. A gate that reports only its per-item verdicts
 * is silent about the items it never reached, and "no verdict about item X" prints
 * identically to "no problem with item X". That silence is a false green, and it has
 * been observed on real runs: a replay page showed a green PASS badge over fifteen frames
 * nothing had compared.
 *
 * So every gate that grades against an anchor reports BOTH numbers, and this module owns
 * the one predicate that turns them into a verdict.
 *
 * FOUR PROPERTIES, each paid for by a real false green (see PRs #80 and #82, where this
 * shape was first proven for the replay pixel gate):
 *
 *  1. **The refusal reads the NUMBERS, never a boolean.** A gate that also sets a
 *     `harnessFault` flag sets it from the same statement that computes the counts, so in
 *     a report this tool wrote the two always agree. The numbers matter for a report it
 *     did NOT write: a hand-edited verdict that deletes the flag still has to carry a
 *     denominator it can meet. Deleting a flag must not be able to launder a shortfall.
 *  2. **An absent numerator reads as ZERO, never as "assume met".** A truncated or
 *     hand-edited report is exactly the document with a field missing, and treating the
 *     gap as satisfied would make deletion the cheapest way to pass.
 *  3. **An absent DENOMINATOR is a different statement from zero.** No `expected` means
 *     there was no approved set to fall short of (no baseline yet, a legacy unstamped
 *     anchor). That is honestly "unanchored", which the callers report as such; inventing
 *     `expected: 0` there would be inventing a promise nobody made. It is never a pass by
 *     itself: {@link anchoredByComparison} answers `false` for it.
 *  4. **The refusal names the shortfall PER ITEM.** "12 of 15" tells an operator a gate
 *     is broken; "12 of 15; start, mid, end were never graded" tells them what to fix.
 *
 * THE TIER IS ALWAYS 2 (harness), never 1 (game defect). A gate that could not run is not
 * evidence the game is broken, and reporting it as a game defect is the shape an agent
 * misreads as "the code regressed" when the truth is "nothing was measured".
 *
 * Vocabulary, not orchestration: no argv, no I/O, no capability imports. Every capability
 * gate (replay pixels, screen contract, feel snapshot, evidence ledger) reads THIS
 * predicate rather than re-deriving one, so they cannot come to different answers about
 * what "compared nothing" means.
 */

/** The harness tier. A gate that could not run is never a verdict about the game. */
export const COMPARISON_SHORTFALL_EXIT = 2;

/**
 * One gate's coverage of its anchor.
 *
 * Both counts are optional IN THE TYPE and refused AT THE GATE (property 2 above):
 * reports written before a gate learned to count still parse, and the predicate below
 * treats a missing `performed` as zero rather than as a satisfied promise.
 */
export interface ComparisonCoverage {
  /**
   * The ANCHOR'S OWN declared denominator: how many comparisons the human-approved
   * artefact says there are. Absent when there is no anchor to be measured against.
   */
  expected?: number;
  /** How many of them THIS run actually performed. Absent reads as zero. */
  performed?: number;
  /**
   * The items the run was supposed to compare and did not, by id. Optional because a
   * caller may only be able to count; when present it is what the refusal names.
   */
  ungraded?: readonly string[];
}

/** A shortfall, with everything a refusal sentence needs. */
export interface ComparisonShortfall {
  expected: number;
  performed: number;
  ungraded: readonly string[];
}

/**
 * The shortfall for one gate's coverage, or null when there is none.
 *
 * THE WHOLE OF THE "COMPARED NOTHING" GUARANTEE, and deliberately tiny: every caller's
 * refusal, exit tier and `anchored` derivation funnels through this one comparison of two
 * numbers, so there is exactly one place where the rule could be weakened and exactly one
 * place to look when auditing it.
 */
export function comparisonShortfall(
  coverage: ComparisonCoverage | null | undefined,
): ComparisonShortfall | null {
  if (!coverage) return null;
  const expected = coverage.expected;
  // No denominator: no approved set to fall short of. Never a shortfall, and never an
  // anchor either (see `anchoredByComparison`).
  if (typeof expected !== "number" || !Number.isFinite(expected) || expected <= 0) return null;
  const performed =
    typeof coverage.performed === "number" && Number.isFinite(coverage.performed)
      ? coverage.performed
      : 0;
  if (performed >= expected) return null;
  return { expected, performed, ungraded: coverage.ungraded ?? [] };
}

/**
 * Did this run compare something against a human-approved anchor, IN FULL?
 *
 * This is the `anchored` derivation the unified door's outcome rule (`resolveUnifiedOutcome`)
 * needs. That rule is sound as written; what used to be wrong were its INPUTS, which
 * derived `anchored` from discovery ("a runnable row existed") or from parsing ("the
 * manifest loaded") rather than from the run. Discovery's opinion is a plan, not evidence.
 *
 * A partial comparison is NOT anchored: a run that graded one of three approved frames
 * measured a third of what a human froze, and calling that "anchored" would let the
 * unified door exit 0 on it.
 */
export function anchoredByComparison(coverage: ComparisonCoverage | null | undefined): boolean {
  if (!coverage) return false;
  const expected = coverage.expected;
  if (typeof expected !== "number" || !Number.isFinite(expected) || expected <= 0) return false;
  return comparisonShortfall(coverage) === null;
}

/**
 * The refusal sentence for a shortfall, naming the ungraded items (property 4).
 *
 * `subject` is what the denominator counts ("approved frame", "declared state",
 * "baseline metric", "declared evidence file"), singularised: the caller knows its own
 * vocabulary and a generic "item" would make every gate's refusal read the same.
 */
export function comparisonShortfallSentence(args: {
  label: string;
  subject: string;
  shortfall: ComparisonShortfall;
}): string {
  const { expected, performed, ungraded } = args.shortfall;
  const named =
    ungraded.length > 0
      ? `: ${ungraded.join(", ")} ${ungraded.length === 1 ? "was" : "were"} never compared`
      : "";
  return (
    `${args.label}: the anchor declares ${expected} ${args.subject}(s) but this run compared ` +
    `${performed}${named} (harness tier ${COMPARISON_SHORTFALL_EXIT}: a gate that could not run is ` +
    "not evidence the game is broken)"
  );
}
