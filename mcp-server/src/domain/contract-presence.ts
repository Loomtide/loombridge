/**
 * Contract presence — the refuse-on-missing-contract substrate (the extraction-shooter dogfood
 * core-hardening Epic 0; findings RCL-P04 / RCL-P01).
 *
 * The threat model: a build hand-creates a `.loombridge/run/captures/` directory and
 * self-grades a "verification contract pass" with NO acceptance contract and NO
 * gate run. Captures are NOT a verification — nothing has been graded. The gate
 * verbs (`verify`/`doneness`) must REFUSE clearly when the contract is absent,
 * and `status` must report the unverified state honestly so captures can never be
 * mistaken for a pass.
 *
 * Pure + engine-agnostic — it belongs in the deterministic CLI (the equalizer),
 * exactly like the rest of the `.loombridge/` state contract. Mirrors the §3a
 * refuse-when-you-can't-check discipline: an absent contract is a refusal, never a
 * silent skip.
 */

import fs from "node:fs/promises";
import path from "node:path";

import { fileExists, type LoombridgePaths } from "./state.js";

/**
 * Capture directory paths, relative to `.loombridge/`, that a build may hand-create. The
 * gates read `.loombridge/verify/`; the extraction-shooter dogfood (RCL-P04) hand-created
 * `.loombridge/run/captures/`. Any one of them being non-empty with NO contract is the
 * false-green shape we surface.
 *
 * `run/captures` is where ArtifactStorage S2 moved the ad-hoc screenshot destination, and
 * it is the ONLY spelling scanned. The pre-S2 top-level `captures` was dropped with the
 * rest of the S2 migration machinery: no published version ever shipped that layout, so no
 * project can be in it (see `Docs/Design/ArtifactStorage.md`, "Why S2 shipped no migration").
 */
export const CAPTURE_DIR_NAMES = ["verify", "run/captures"] as const;

export interface ContractPresence {
  /** Whether `.loombridge/` exists at all. */
  loombridgeDirExists: boolean;
  /** Whether the acceptance contract (`.loombridge/ACCEPTANCE.json`) exists. */
  contractExists: boolean;
  /** Absolute path the contract is expected at. */
  contractPath: string;
  /** Capture dir names under `.loombridge/` that exist and hold at least one entry. */
  capturePresentDirs: string[];
  /** True when capture files are present but NO contract exists (the false-green shape). */
  capturesWithoutContract: boolean;
}

async function dirHasEntries(dir: string): Promise<boolean> {
  try {
    const entries = await fs.readdir(dir);
    return entries.length > 0;
  } catch {
    // ENOENT / not a directory → no captures here.
    return false;
  }
}

/** Inspect contract + capture presence under `.loombridge/`. No mutation. */
export async function inspectContractPresence(paths: LoombridgePaths): Promise<ContractPresence> {
  const [loombridgeDirExists, contractExists] = await Promise.all([
    fileExists(paths.dir),
    fileExists(paths.acceptance),
  ]);
  const capturePresentDirs: string[] = [];
  for (const name of CAPTURE_DIR_NAMES) {
    if (await dirHasEntries(path.join(paths.dir, name))) capturePresentDirs.push(name);
  }
  return {
    loombridgeDirExists,
    contractExists,
    contractPath: paths.acceptance,
    capturePresentDirs,
    capturesWithoutContract: !contractExists && capturePresentDirs.length > 0,
  };
}

/**
 * The canonical refusal message for a missing acceptance contract. Shared by
 * `verify`/`doneness` so the wording is identical and actionable. Names the
 * captures-are-not-a-verification trap explicitly when capture dirs are present.
 */
export function noContractRefusal(contractPath: string, capturePresentDirs: string[] = []): string {
  const captureNote =
    capturePresentDirs.length > 0
      ? ` A ${capturePresentDirs.map((d) => `\`.loombridge/${d}/\``).join(" / ")} directory is present, but it is NOT a verification — nothing has been graded.`
      : " A `.loombridge/run/captures/` directory is NOT a verification; nothing has been graded.";
  return `No acceptance contract found at ${contractPath} — run \`loombridge plan\` (or \`adopt\`) first.${captureNote}`;
}
