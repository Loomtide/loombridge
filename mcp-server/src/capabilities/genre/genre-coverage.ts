/**
 * Genre COVERAGE — what `verify` is allowed to CLAIM about a build, as distinct from what the
 * pipeline is willing to ACCEPT.
 *
 * THE PROBLEM THIS SOLVES. The genre registry refuses an unknown genre so that an unregistered game
 * is never silently graded against platformer criteria. That reasoning is about SILENT DEFAULTING, but
 * it was implemented as REFUSING TO PROCEED, so a developer whose game has no registered pack could
 * not reach `plan` at all. Those are two different things. The closed set belongs on the CLAIM, not on
 * the front door (`Docs/Design/CommandSurfaceRedesign.md`, W1).
 *
 * THREE STATES, ALL EXPLICIT:
 *
 *   graded             a registered genre — feel oracle and fidelity criteria are wired. Full Tier-1
 *                      claim. Every genre registered today lands here, so shipped behavior is unchanged.
 *   partially-graded   no registration, but the project was planned from a promoted GENRE CONTRACT.
 *                      Genre-neutral gates still apply and still gate; the genre-specific oracle does
 *                      not exist, so the verdict passes WITH ITS GAPS ENUMERATED.
 *   ungraded           neither. There is no oracle AND no contract to enumerate gaps from, so there is
 *                      nothing honest to claim. Callers REFUSE.
 *
 * WHY `ungraded` REFUSES. The product decision (D1) was that an ungraded game may reach `doneness`
 * *provided* the gap list is mandatory and non-empty. With genre-contract promotion as the only entry
 * path for an unregistered genre, anything that reaches `plan` has either a registration or a
 * `GENRE_PROMOTION.json`, so `ungraded` is the residual state: a hand-edited `STATE.genre`, a deleted
 * promotion report, an adopted project. In every one of those there is no source to enumerate gaps
 * from, so D1's own precondition cannot be met and refusal is the only honest answer. If a free-form
 * entry path is ever added, THIS is the function that has to grow a fourth story, not the callers.
 *
 * TRUST MODEL — this is a moat surface, so read carefully:
 *  - The result is DERIVED from disk (the registry + `GENRE_PROMOTION.json`) at gate time. `verify`
 *    stamps it into the verdict for humans; `doneness` RE-DERIVES it and refuses on disagreement. A
 *    hand-written `genreCoverage: "graded"` in a verdict therefore certifies nothing. Same discipline
 *    as `designTarget.kind`, which is read from disk by the slice roll-up for the same reason.
 *  - The disk must not be allowed to disagree with itself. `STATE.genre` and the promotion report are
 *    two separate on-disk claims about what this project IS, and when they conflict the derivation
 *    REFUSES rather than preferring whichever grades higher. Without that rule the registry lookup
 *    short-circuits a mismatched report into a full `graded` pass — see step 0 below, which is a
 *    confirmed-and-fixed laundering route, not a hypothetical.
 *  - `gaps` is non-empty for every non-`graded` result BY CONSTRUCTION, not by validation: the entries
 *    below are computed from the absence of a registration, so there is no input a contract author can
 *    supply that yields "partially-graded with nothing missing". A gap list that could be emptied by
 *    authoring choice would be a suppression vector.
 *
 * PURE — no I/O. Callers read `STATE.genre` and `GENRE_PROMOTION.json` and pass them in, so this file
 * is exhaustively testable and carries no path knowledge.
 */

import { resolveGenrePack } from "./genre-registry.js";
import type { GenrePromotionReport } from "./genre-contract/promote.js";

/** What `verify` may claim about this build. See the file header for the semantics of each. */
export type GenreCoverage = "graded" | "partially-graded" | "ungraded";

/** Where a coverage decision came FROM — recorded so a verdict reader can audit the derivation. */
export type GenreCoverageSource = "registry" | "genre-contract" | "none";

export interface GenreCoverageResolution {
  coverage: GenreCoverage;
  /** The genre the coverage was resolved FOR (echoed so a stamped verdict binds to a genre id). */
  genre: string;
  source: GenreCoverageSource;
  /**
   * Everything the pipeline canNOT grade for this build, in the words a developer needs. NON-EMPTY
   * whenever `coverage !== "graded"`, and derived rather than authored — see the header's trust model.
   */
  gaps: string[];
}

export interface DeriveGenreCoverageInput {
  /** `STATE.genre` — the genre the project was planned as. */
  genre: string;
  /**
   * Parsed `.loombridge/GENRE_PROMOTION.json`, or `null` when absent/unreadable. A report whose
   * `sourceGenreId` does NOT match `genre` is a contradiction and refuses — it is never merely
   * ignored, because ignoring it is what let a mismatched genre fall through to the registry.
   */
  promotion: GenrePromotionReport | null;
}

/**
 * Resolve what may be claimed about a build. See the file header — this is the single place the three
 * states are decided, and the only place a fourth would be added.
 */
export function deriveGenreCoverage(input: DeriveGenreCoverageInput): GenreCoverageResolution {
  const { genre, promotion } = input;

  // 0. CONTRADICTION — a promotion report naming a DIFFERENT genre than the one being certified.
  //
  //    THIS CHECK MUST COME FIRST. An earlier cut ran the registry check first and treated a
  //    mismatched report as merely irrelevant, which was a confirmed laundering route: plan a
  //    puzzle game from a contract, hand-edit `STATE.genre` to "platformer-2d", and the registry
  //    short-circuit awarded a full `graded` pass — against platformer feel and fidelity criteria —
  //    while the report on disk still said `sourceGenreId: "puzzle-hypercasual"`. The contradicting
  //    evidence was sitting right there and was being discarded.
  //
  //    A project cannot be two genres. When the disk disagrees with itself there is no honest claim
  //    to make, so refuse and name both sides rather than picking the one that grades more
  //    favourably. (`plan` clears a stale report when it re-seeds a project onto a templated genre,
  //    so the legitimate genre switch does not land here.)
  if (promotion && promotion.sourceGenreId !== genre) {
    return {
      coverage: "ungraded",
      genre,
      source: "none",
      gaps: [
        `CONTRADICTION: this project is being certified as genre "${genre}", but ` +
          `.loombridge/GENRE_PROMOTION.json was promoted for "${promotion.sourceGenreId}". A project ` +
          `cannot be both, and the more favourable reading is never the one to take. Re-plan from the ` +
          `contract you mean to build (\`loombridge plan --genre-contract <file> --force\`), or delete ` +
          `the stale promotion report if this project really is "${genre}".`,
      ],
    };
  }

  // 1. Registered — the shipped path. Full claim, no gaps. Unchanged behavior for every genre that
  //    registers today, which is what makes this change additive rather than a migration.
  if (resolveGenrePack(genre)) {
    return { coverage: "graded", genre, source: "registry", gaps: [] };
  }

  // 2. Planned from a promoted genre contract for THIS genre.
  if (promotion) {
    return {
      coverage: "partially-graded",
      genre,
      source: "genre-contract",
      gaps: promotedGenreGaps(genre, promotion),
    };
  }

  // 3. Neither. Nothing to grade against and nothing to enumerate — refuse (header, "WHY `ungraded`
  //    REFUSES").
  return {
    coverage: "ungraded",
    genre,
    source: "none",
    gaps: [
      `genre "${genre}" is not registered and this project has no promoted genre contract ` +
        `(.loombridge/GENRE_PROMOTION.json) naming it — there is no oracle to grade against and no ` +
        `declared gap list to scope a claim to. Plan from a genre contract (\`loombridge plan ` +
        `--genre-contract <file>\`) or use a registered genre.`,
    ],
  };
}

/**
 * The gap list for a promoted genre. The first two entries are STRUCTURAL — they follow from the
 * absence of a registration and cannot be authored away — which is what makes the list non-empty for
 * every possible contract, including one whose slices declare no gaps and whose every measurability
 * row is `measurable-now`. The contract-sourced entries are added on top because they are the honest
 * detail a developer needs, not because the list depends on them.
 */
function promotedGenreGaps(genre: string, promotion: GenrePromotionReport): string[] {
  const gaps: string[] = [
    `no registered feel oracle for genre "${genre}" — genre-neutral gates (compile, playability, ` +
      `framing, UI conformance, safe-area, perf) apply and still gate, but there are no genre-specific ` +
      `feel calculators grading this build`,
  ];

  if (!promotion.fidelityCriteria || promotion.fidelityCriteria.length === 0) {
    gaps.push(
      `no hero-shot fidelity criteria declared for genre "${genre}" — a build with an APPROVED Design ` +
        `Target is refused at doneness (declare \`fidelityCriteria\` in the genre contract, or declare ` +
        `\`art: { "mode": "deferred" }\` in ACCEPTANCE.json for a gray-box build)`,
    );
  }

  // Every feel target the contract itself admits nothing can measure today. `measurable-now` rows bind
  // to an implemented calculator (the contract validator enforces that), so only the other tags are gaps.
  for (const row of promotion.measurability) {
    if (row.tag === "measurable-now") continue;
    const note = row.calculator ? `: ${row.calculator}` : "";
    gaps.push(`feel target "${row.target}" is ${row.tag}${note} — recorded, not graded`);
  }

  // Slice-level gaps the contract declared. Each slice must declare gates and/or gaps, so these are the
  // author's own statement of what a slice does not prove.
  for (const [sliceId, sliceGaps] of Object.entries(promotion.explicitGaps)) {
    for (const gap of sliceGaps) {
      gaps.push(`slice "${sliceId}": ${gap}`);
    }
  }

  return gaps;
}

/**
 * Resolve the hero-shot fidelity criteria a PROMOTED (unregistered) genre declared, or `null` when it
 * declared none.
 *
 * RE-VALIDATED against the criterion allow-list by the caller at gate time: `GENRE_PROMOTION.json`
 * lives in the project and is editable, so the fact that `plan` validated the source contract is not a
 * trust boundary. Empty coerces to `null` (never a vacuous pass), mirroring `genreFidelityCriteria`.
 */
export function promotedFidelityCriteria(
  genre: string,
  promotion: GenrePromotionReport | null,
): readonly string[] | null {
  if (!promotion || promotion.sourceGenreId !== genre) return null;
  const criteria = promotion.fidelityCriteria;
  return criteria && criteria.length > 0 ? criteria : null;
}
