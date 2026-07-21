/**
 * Brief-bundle resolver (RCL-P03) — turn an existing design-doc bundle into the
 * structured brief the plan/adopt flow already understands.
 *
 * `loomtide plan` historically took its inputs ONLY from the interactive
 * interview (whose machine output is a GenreContract, fed via `--genre-contract`).
 * A build that already has a written spec — the dogfood project's, say, which enumerated every
 * dial + a rubric — had no front door. This resolver lets a caller point at a
 * design-doc bundle (a docs directory, or a brief file) and resolves it to the
 * SAME structured GenreContract JSON the interview emits, so the existing
 * promotion path produces an equivalent contract.
 *
 * Deterministic + side-effect-free: it only LOCATES the structured brief; the
 * caller validates + promotes it (so a malformed brief is refused by the existing
 * `--genre-contract` error path, never a partial fabricated contract). It does NOT
 * synthesize a contract from prose — the structured brief is the human-reviewable
 * artifact, exactly like the interview output.
 */

import fsSync from "node:fs";
import path from "node:path";

/** Where a bundle resolved its structured brief from. */
export interface BriefBundleResolution {
  /** Absolute path to the structured GenreContract JSON the bundle resolves to. */
  genreContractPath: string;
  /** A directly-passed file, or a brief discovered inside a directory bundle. */
  source: "file" | "directory";
  /** When resolved from a directory, the matched filename (for the echo). */
  matchedFile?: string;
}

/**
 * Convention names for the structured brief inside a docs directory, in priority
 * order. A bundle author drops the interview-equivalent GenreContract under one of
 * these names alongside the human design docs.
 */
export const BRIEF_FILE_PRIORITY = ["brief.json", "genre-contract.json", "GENRE_CONTRACT.json"] as const;

/**
 * Resolve a `--brief` / `--docs` path to the structured GenreContract JSON it
 * carries. Returns `{ error }` (never throws) when the bundle is missing,
 * unreadable, or carries no/ambiguous structured brief — the caller turns that
 * into an exit-2 usage error with nothing written.
 */
export function resolveBriefBundle(briefPath: string): BriefBundleResolution | { error: string } {
  let stat: fsSync.Stats;
  try {
    stat = fsSync.statSync(briefPath);
  } catch {
    return { error: `brief bundle not found: ${briefPath}` };
  }

  if (stat.isFile()) {
    if (!briefPath.endsWith(".json")) {
      return {
        error: `brief file must be a .json GenreContract (the interview-equivalent structured brief): ${briefPath}`,
      };
    }
    return { genreContractPath: path.resolve(briefPath), source: "file" };
  }

  if (stat.isDirectory()) {
    let entries: string[];
    try {
      entries = fsSync.readdirSync(briefPath);
    } catch {
      return { error: `brief bundle directory unreadable: ${briefPath}` };
    }
    for (const name of BRIEF_FILE_PRIORITY) {
      if (entries.includes(name)) {
        return { genreContractPath: path.resolve(briefPath, name), source: "directory", matchedFile: name };
      }
    }
    const contractFiles = entries.filter((e) => e.endsWith(".contract.json")).sort();
    if (contractFiles.length === 1) {
      return {
        genreContractPath: path.resolve(briefPath, contractFiles[0]!),
        source: "directory",
        matchedFile: contractFiles[0],
      };
    }
    if (contractFiles.length > 1) {
      return {
        error:
          `brief bundle ${briefPath} has multiple *.contract.json files (${contractFiles.join(", ")}); ` +
          "point --brief at the one structured brief file directly.",
      };
    }
    return {
      error:
        `no structured brief found in ${briefPath} — expected one of ${BRIEF_FILE_PRIORITY.join(", ")} ` +
        "or a single *.contract.json (a GenreContract authored from the design docs). " +
        "Author the brief with the genre-pack-authoring interview, then re-run.",
    };
  }

  return { error: `brief bundle is neither a file nor a directory: ${briefPath}` };
}
