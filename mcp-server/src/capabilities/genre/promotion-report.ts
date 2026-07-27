/**
 * Reading the on-disk genre promotion report (`.loombridge/GENRE_PROMOTION.json`).
 *
 * Split from the pure `genre-coverage.ts` so the coverage decision itself stays I/O-free and
 * exhaustively testable: this file knows where the artifact lives, that one knows what it means.
 *
 * ABSENT IS A FACT, NOT AN ERROR. A project planned from a registered pack has no promotion report at
 * all, so a missing file returns `null` and the caller resolves coverage from the registry. What is
 * NOT tolerated is a present-but-unusable file: unparseable JSON, or JSON missing the two fields
 * coverage binds to. Those return `null` as well, which drops the project to `ungraded` and therefore
 * REFUSES — a corrupt report must not read as "no report", because "no report" is the state a
 * registered genre is in and would be a laundering route for a genre that has no registration.
 */

import fs from "node:fs/promises";

import type { LoombridgePaths } from "../../domain/state.js";
import type { GenrePromotionReport } from "./genre-contract/promote.js";

/**
 * Read + shape-check `.loombridge/GENRE_PROMOTION.json`, or `null` when it is absent, unreadable, or
 * does not carry the fields coverage derivation binds to.
 *
 * The shape check is deliberately minimal and REFUSE-SHAPED: `sourceGenreId` (a non-empty string) and
 * `measurability` + `explicitGaps` (the gap sources). Anything missing means the derivation would have
 * to invent a gap list, so the report is treated as unusable rather than partially trusted. This is
 * NOT full validation of the promotion report — it is the binding check for the fields read here.
 */
export async function readGenrePromotionReport(
  paths: LoombridgePaths,
): Promise<GenrePromotionReport | null> {
  let raw: string;
  try {
    raw = await fs.readFile(paths.genrePromotion, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const report = parsed as Partial<GenrePromotionReport>;
  if (typeof report.sourceGenreId !== "string" || report.sourceGenreId.trim().length === 0) return null;
  if (!Array.isArray(report.measurability)) return null;
  if (
    typeof report.explicitGaps !== "object" ||
    report.explicitGaps === null ||
    Array.isArray(report.explicitGaps)
  ) {
    return null;
  }

  return report as GenrePromotionReport;
}
