/**
 * The hero-shot fidelity criterion ids the VLM-review shape validator accepts — the single source of
 * truth, extracted from `doneness.ts` so the two places that DECLARE criteria can validate against it
 * without importing the whole doneness orchestrator.
 *
 * WHY IT IS A CLOSED SET: `doneness` requires every declared fidelity criterion to appear in
 * `vlm-review.json` with a `pass`, and `validateVlmReviewFindingsShape` REJECTS any criterion id
 * outside this list. So a criterion declared anywhere but absent here makes that genre's doneness
 * UNREACHABLE-green — the build can never satisfy a criterion the review file may not even carry.
 *
 * Two sites declare criteria and BOTH must validate against this set:
 *  - `genre-registry.ts` pack registrations (`fidelityCriteria`), cross-checked by
 *    `genre-registry.test.ts`;
 *  - a genre contract's optional `fidelityCriteria` (the promoted, unregistered-genre path),
 *    cross-checked by `genre-contract/validator.ts` at authoring time AND re-checked by doneness at
 *    gate time — the contract file travels with the project, so authoring-time validation alone is
 *    not a trust boundary.
 *
 * Mirrors the `evidence-classes.ts` arrangement: a fixed enum shared by the declaring side and the
 * enforcing side rather than duplicated in each.
 */

/** Every criterion id `vlm-review.json` may carry (and therefore every id a genre may require). */
export const VLM_REVIEW_CRITERION_IDS = new Set([
  "composition-centering",
  "palette-adherence",
  "font-rendering",
  "juice-cue-presence",
  "end-state-styling",
  "hazard-readability",
  "collectible-path",
  "parallax",
  "hud-crispness",
  "props-grounded",
  "platform-edge-to-edge",
  "backdrop-seamless",
  "palette-match",
  "composition-match",
  "rendering-artifacts",
  "parallax-present",
  "platform-tiers",
  "element-placement-arc",
  // 2d-shooter hero-shot fidelity criteria (registered in genre-registry.ts). Must stay in sync with
  // every registered pack's fidelityCriteria — the cross-table test in genre-registry.test.ts enforces
  // that a pack can't declare a criterion the VLM-review shape validator would then reject (which would
  // make that genre's doneness unreachable-green).
  "arena-framing",
  "enemy-readability",
  "hud-placement",
]);

/**
 * Validate a DECLARED fidelity-criteria list (from a pack registration or a genre contract).
 *
 * REFUSE-NOT-SKIP: an absent or empty list is NOT silently accepted here — it returns an issue, so a
 * caller that treats "no criteria" as "no fidelity requirement" has to do so deliberately rather than
 * by falling through this function. An empty set would make the structural fidelity check pass
 * VACUOUSLY, which is the flat-build self-pass the moat exists to stop.
 *
 * Returns the (possibly empty) list of human-readable issues; empty means the declaration is usable.
 */
export function validateFidelityCriteria(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) {
    return [`${label} must be an array of hero-shot fidelity criterion ids`];
  }
  if (value.length === 0) {
    return [
      `${label} must not be empty — an empty criteria set would make the hero-shot fidelity check pass vacuously`,
    ];
  }
  const issues: string[] = [];
  value.forEach((id, i) => {
    if (typeof id !== "string" || !VLM_REVIEW_CRITERION_IDS.has(id)) {
      issues.push(
        `${label}[${i}] "${String(id)}" is not a gradable criterion id — doneness would be unreachable-green ` +
          `(one of: ${[...VLM_REVIEW_CRITERION_IDS].join(", ")})`,
      );
    }
  });
  return issues;
}
