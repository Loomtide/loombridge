/**
 * THE manifest-completeness predicate.
 *
 * "Is every entry of a minted `captureManifest` a safe path that actually exists
 * on disk?" was implemented three times independently: in `status-model.ts`
 * (private), and twice inside `doneness.ts` (whole-game and per-slice). Three
 * copies of a refusal predicate is three chances for one of them to drift into a
 * skip, and `capture` (the verb that WRITES those files) asked the question
 * nowhere at all, which is ledger L1/L34/L65: `capture --slice parallax` wrote 1
 * of 5 declared entries and exited 0 without naming the other four.
 *
 * One exported predicate, four callers (capture, status, doneness x2).
 *
 * Two containment rules, both enforced here (never one without the other):
 *  1. the raw entry must be a safe relative capture path (`isSafeCapturePath`);
 *  2. the RESOLVED path must live inside `.loombridge/verify/`, and, for a
 *     slice-scoped manifest, inside that slice's own verify dir.
 * An entry failing either is `unsafe`, reported as its own class, never
 * collapsed into "missing", so a hand-edited STATE.md cannot smuggle a traversal
 * entry past a caller that only looks at `missing`.
 */

import path from "node:path";

import { isSafeCapturePath, isWithin } from "./capture-paths.js";
import { fileExists } from "./state.js";

/**
 * The machine-readable record `loombridge capture` writes beside the evidence it
 * produced: what each manifest entry's producer was, what landed, and what the
 * agent still has to assemble. Declared ONCE here; every writer and reader
 * resolves it from this constant (`unified-verify-declared-paths.test.ts`).
 */
export const CAPTURE_REPORT_FILE = "capture-report.json";

/** Absolute path of the capture report inside a slice's verify dir. */
export function captureReportPath(outDir: string): string {
  return path.join(outDir, CAPTURE_REPORT_FILE);
}

/** One manifest entry, resolved. */
export interface ManifestEntryStatus {
  /** The entry exactly as the manifest declares it. */
  entry: string;
  /** Absolute path it resolved to (still reported for an unsafe entry, for the message). */
  absolutePath: string;
  /** True when the entry fails a containment rule; `exists` is then always false. */
  unsafe: boolean;
  /** True when the entry is safe AND the file is on disk. */
  exists: boolean;
}

/** The completeness verdict for a whole manifest. */
export interface ManifestCompleteness {
  entries: ManifestEntryStatus[];
  /** Entries that failed a containment rule. */
  unsafe: string[];
  /** Safe entries with no file on disk. */
  missing: string[];
  /** Safe entries that exist. */
  present: string[];
  /** True only when nothing is unsafe and nothing is missing. */
  complete: boolean;
}

export interface CheckCaptureManifestArgs {
  /** The minted manifest entries (relative to `verifyRoot`). */
  manifest: readonly string[];
  /** Absolute `.loombridge/verify/` dir every entry must resolve inside. */
  verifyRoot: string;
  /**
   * Absolute sub-directory a SLICE-scoped manifest must additionally resolve
   * inside (`.loombridge/verify/<slice>/`). Omit for the whole-game manifest,
   * whose entries are only bounded by `verifyRoot`.
   */
  scopeRoot?: string;
  /** Injectable existence probe (tests); defaults to the real filesystem. */
  exists?: (absolutePath: string) => Promise<boolean>;
}

/**
 * Resolve a manifest against the disk. PURE of console output and of policy: the
 * caller decides what an incomplete manifest MEANS (capture: which entries had a
 * producer; doneness: refuse to certify; status: a warning line).
 */
export async function checkCaptureManifest(args: CheckCaptureManifestArgs): Promise<ManifestCompleteness> {
  const verifyRootAbs = path.resolve(args.verifyRoot);
  const scopeRootAbs = args.scopeRoot === undefined ? null : path.resolve(args.scopeRoot);
  const probe = args.exists ?? fileExists;

  const entries: ManifestEntryStatus[] = [];
  for (const entry of args.manifest) {
    const absolutePath = path.resolve(verifyRootAbs, entry);
    if (!isSafeCapturePath(entry)) {
      entries.push({ entry, absolutePath, unsafe: true, exists: false });
      continue;
    }
    if (!isWithin(verifyRootAbs, absolutePath) || (scopeRootAbs !== null && !isWithin(scopeRootAbs, absolutePath))) {
      entries.push({ entry, absolutePath, unsafe: true, exists: false });
      continue;
    }
    entries.push({ entry, absolutePath, unsafe: false, exists: await probe(absolutePath) });
  }

  const unsafe = entries.filter((e) => e.unsafe).map((e) => e.entry);
  const missing = entries.filter((e) => !e.unsafe && !e.exists).map((e) => e.entry);
  const present = entries.filter((e) => !e.unsafe && e.exists).map((e) => e.entry);
  return { entries, unsafe, missing, present, complete: unsafe.length === 0 && missing.length === 0 };
}
