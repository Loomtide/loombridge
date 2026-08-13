/**
 * `loombridge build` — the M1 verb-entry that mints the §3a supervisor block.
 *
 * Deterministic only: gates preconditions (contract + approved + frozen Design
 * Target — default hard gate, `--allow-ungrounded-prototype` is the loud
 * escape), mints `currentBuild` (`runId` + `startedAt` + `captureManifest`
 * derived from `ACCEPTANCE.capturePack`), and transitions phase to
 * `built-unverified`. Intent routing — the M2 agent-prose layer — lives in
 * `commands/loombridge/build.md` (not yet shipped) and never in this file (plan
 * §3b: no judgment in the CLI).
 *
 * Without this command, the §3a supervisor substrate is inert: `loombridge
 * doneness` has nothing to gate against. With it, the full flow lights up:
 *   plan → build (mints) → agent constructs + captures → verify → doneness.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { designStatus, exitCodeForDesignReadiness } from "./design.js";
import {
  fileExists,
  loombridgePaths,
  nowIso,
  updateState,
  type CurrentBuildRef,
} from "../../domain/state.js";
import { isSafeCapturePath } from "../../domain/capture-paths.js";
import { readAssetManifest } from "../assets/asset-manifest.js";
import { resolveAllSliceAssetBindings } from "../assets/asset-bindings.js";
import { assertValidAcceptanceContract } from "./validator.js";
import { readDeclaredArtMode } from "./doneness.js";
import type { CapturePackSection } from "./types.js";
import { sliceCaptureManifestEntries } from "./run-gates.js";
import {
  getSliceVerdictPath,
  markDependentStale,
  nextUnblockedSlice,
  readSlicePlan,
  writeSlicePlan,
  assertSafeSliceId,
  type SliceEntry,
  type SlicePlan,
} from "./slices.js";

export interface BuildReadiness {
  ok: boolean;
  blockers: string[];
  warnings: string[];
}

/**
 * Pure precondition gate. A contract is always required; the Design Target is
 * a default hard gate, mirroring `plan`'s default-hard-gate semantics. The
 * `--allow-ungrounded-prototype` escape converts the design-target blocker
 * into a loud warning and marks the run `ungrounded` (sticky disqualification
 * enforced by `doneness`).
 */
export function evaluateBuildReadiness(opts: {
  hasContract: boolean;
  /** designStatus === "approved" AND frozenMatches === true. */
  designReady: boolean;
  /** For the diagnostic message: "approved" vs other status names. */
  designStatusName: string;
  /** Approved, valid, and source-bound Asset Manifest exists. */
  assetManifestReady: boolean;
  /** Diagnostic summary for why the manifest is not ready. */
  assetManifestReason?: string;
  allowUngroundedPrototype: boolean;
  /**
   * Gray-box / feel-only (RCL-D01) — the on-disk acceptance contract declares
   * `art.mode:"deferred"`. The Design Target + Asset Manifest gates are then
   * NOT-APPLICABLE (primitives + no hero shot ARE the intended deliverable), so
   * the build proceeds GROUNDED (done-eligible) without escaping any gate. This
   * is NOT `--allow-ungrounded-prototype`: it is an explicit, disk-truth posture.
   */
  artDeferred?: boolean;
}): BuildReadiness {
  const blockers: string[] = [];
  const warnings: string[] = [];

  if (!opts.hasContract) {
    blockers.push(
      "no .loombridge/ACCEPTANCE.json — run `loombridge plan` first (nothing to build toward).",
    );
  }

  // Gray-box / feel-only: art is intentionally deferred. The Design Target +
  // Asset Manifest gates are N/A (not blockers, NOT ungrounded). The contract is
  // the disk truth; doneness still refuses to certify unless the Tier-1 verdict
  // is fresh + green (feel bands + structural assertions) and every capture is
  // present, and it refuses outright if an approved Design Target exists
  // (art:deferred + real art intent is a contradiction).
  if (opts.artDeferred) {
    warnings.push(
      "art:deferred (gray-box / feel-only) — Design Target + Asset Manifest gates are N/A; the run stays GROUNDED and `loombridge doneness` certifies on feel bands + structural assertions alone (RCL-D01).",
    );
    return { ok: opts.hasContract, blockers, warnings };
  }

  if (!opts.designReady) {
    const cause =
      opts.designStatusName === "approved"
        ? "Design Target CHANGED since approval (frozen hash mismatch)"
        : "no approved Design Target (annotated hero shot)";
    if (opts.allowUngroundedPrototype) {
      warnings.push(
        `${cause}; --allow-ungrounded-prototype: the build run will be tagged \`ungrounded\` and \`loombridge doneness\` will refuse to certify it.`,
      );
    } else {
      blockers.push(
        `${cause}. Establish/re-approve via \`loombridge design\` (use --allow-ungrounded-prototype only for throwaway prototypes).`,
      );
    }
  }

  if (!opts.assetManifestReady) {
    const cause = opts.assetManifestReason ?? "no approved ASSET_MANIFEST.json";
    if (opts.allowUngroundedPrototype) {
      warnings.push(
        `${cause}; --allow-ungrounded-prototype: the build run will be tagged \`ungrounded\` and \`loombridge doneness\` will refuse to certify it.`,
      );
    } else {
      blockers.push(`${cause}. Run \`loombridge plan --asset-mode <registry|generated|hybrid>\`, approve assets via \`loombridge assets\`, then build.`);
    }
  }

  return { ok: blockers.length === 0, blockers, warnings };
}

async function assetManifestReadiness(paths: ReturnType<typeof loombridgePaths>): Promise<{ ready: boolean; reason?: string }> {
  try {
    const manifest = await readAssetManifest(paths);
    if (!manifest) return { ready: false, reason: "no approved ASSET_MANIFEST.json" };
    if (manifest.status !== "approved") {
      return { ready: false, reason: `ASSET_MANIFEST.json is ${manifest.status}, not approved` };
    }
    resolveAllSliceAssetBindings(manifest);
    return { ready: true };
  } catch (error) {
    return {
      ready: false,
      reason: `ASSET_MANIFEST.json is not build-ready: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Project the per-genre `capturePack` (named states + requiredCaptures) into a
 * flat list of capture paths the current build must produce — what `doneness`
 * checks against. Bare filenames are prefixed with their state name; paths that
 * already include a `/` are preserved (so authors can be explicit).
 */
export function deriveCaptureManifest(pack: CapturePackSection | undefined): string[] {
  if (!pack) return [];
  const out: string[] = [];
  for (const stateEntry of pack.states) {
    for (const cap of stateEntry.requiredCaptures) {
      const projected = cap.includes("/") ? cap : `${stateEntry.name}/${cap}`;
      // Defense in depth — the validator already refuses unsafe contracts, but
      // refuse again here so a hand-constructed pack (bypassing the validator)
      // cannot mint a manifest entry that escapes `.loombridge/verify/`.
      if (!isSafeCapturePath(projected)) {
        throw new Error(
          `capturePack would mint an unsafe capture path: "${projected}" ` +
            `(state="${stateEntry.name}", entry="${cap}"). ` +
            "Capture entries must be normalized relative paths with no `..` segments.",
        );
      }
      out.push(projected);
    }
  }
  return out;
}

/** Mint a unique-enough runId: ISO timestamp + short random suffix. */
export function mintRunId(): string {
  // Colons and dots aren't ideal in filename-ish identifiers; replace them.
  const ts = nowIso().replace(/[:.]/g, "-");
  const rnd = randomUUID().slice(0, 8);
  return `run-${ts}-${rnd}`;
}

/** Mint a slice-scoped runId: run-<sliceId>-<timestamp>-<rand>. */
export function mintSliceRunId(sliceId: string): string {
  const safe = assertSafeSliceId(sliceId);
  const ts = nowIso().replace(/[:.]/g, "-");
  const rnd = randomUUID().slice(0, 8);
  return `run-${safe}-${ts}-${rnd}`;
}

/**
 * Derive capture manifest entries relative to `.loombridge/verify/` for a slice.
 *
 * The body lives in `run-gates.ts` beside `gateInputFiles` because `doneness` RE-DERIVES
 * the same set to check that a slice's minted proof still covers what its gates owe. Two
 * copies of this rule would be two answers to one question, and the doneness one is the
 * one an adversary edits SLICES.json to get around.
 */
export function deriveSliceCaptureManifest(slice: SliceEntry): string[] {
  return sliceCaptureManifestEntries(assertSafeSliceId(slice.id), slice.acceptance.gates);
}

export interface BuildArgs {
  root: string;
  /** Developer intent (echoed; the CLI does not interpret it — plan §3b). */
  intent?: string;
  /** Loud escape hatch — proceed without an approved Design Target. */
  allowUngroundedPrototype?: boolean;
}

/**
 * Run `build` programmatically. Returns the process exit code (0 minted, 1
 * blocked). Exported for tests + the supervisor-end-to-end integration.
 */
export async function runBuild(args: BuildArgs): Promise<number> {
  const paths = loombridgePaths(args.root);

  const hasContract = await fileExists(paths.acceptance);
  const design = await designStatus(paths);
  const designReady = exitCodeForDesignReadiness(design) === 0;
  const assetManifest = await assetManifestReadiness(paths);

  // Gray-box / feel-only posture (RCL-D01) — read from the on-disk contract
  // (disk truth, fail-closed to `final`). An approved Design Target on disk is a
  // CONTRADICTION with art:deferred (real art intent cannot skip the hero-shot
  // moat); refuse to mint a gray-box run in that case so `build` can't quietly
  // launder one. doneness independently refuses the same contradiction.
  const declaredArtMode = await readDeclaredArtMode(paths.acceptance);
  const artDeferred = declaredArtMode === "deferred" && design.status !== "approved";
  if (declaredArtMode === "deferred" && design.status === "approved") {
    console.error(
      "[loombridge build] BLOCKED: acceptance contract declares `art.mode:\"deferred\"` (gray-box) but an APPROVED Design Target exists on disk — mutually exclusive. Remove the Design Target to stay gray-box, or set `art.mode:\"final\"` and build against the frozen hero shot (RCL-D01).",
    );
    return 1;
  }

  const readiness = evaluateBuildReadiness({
    hasContract,
    designReady,
    designStatusName: design.status,
    assetManifestReady: assetManifest.ready,
    assetManifestReason: assetManifest.reason,
    allowUngroundedPrototype: args.allowUngroundedPrototype ?? false,
    artDeferred,
  });

  if (args.intent) console.error(`[loombridge build] intent: "${args.intent}"`);
  for (const w of readiness.warnings) console.error(`[loombridge build] WARNING: ${w}`);
  if (!readiness.ok) {
    for (const b of readiness.blockers) console.error(`[loombridge build] BLOCKED: ${b}`);
    return 1;
  }

  // Read capturePack from the contract → derive the manifest. The contract is
  // already validated at write time; re-validate here as a defensive double-check.
  const contract = assertValidAcceptanceContract(
    JSON.parse(await fs.readFile(paths.acceptance, "utf-8")),
  );

  // A run is `ungrounded` (sticky disqualification from done) whenever the build only proceeded by
  // ESCAPING a hard gate with --allow-ungrounded-prototype — that includes an unapproved Asset Manifest,
  // not just a missing/drifted Design Target. Both gates already print the "will be tagged `ungrounded`"
  // warning above; computing it from BOTH makes the run tag match that promise.
  // A gray-box / feel-only (art:deferred) run is GROUNDED by design — the Design
  // Target + Asset Manifest gates are N/A, not escaped — so it is NEVER tagged
  // ungrounded even if --allow-ungrounded-prototype was also passed.
  const ungrounded =
    !artDeferred &&
    (args.allowUngroundedPrototype ?? false) &&
    (!designReady || !assetManifest.ready);

  const slicePlan = await readSlicePlan(paths);
  if (slicePlan) {
    return runSliceBuild(args, slicePlan, ungrounded);
  }

  const captureManifest = deriveCaptureManifest(contract.capturePack);

  const currentBuild: CurrentBuildRef = {
    runId: mintRunId(),
    startedAt: nowIso(),
    captureManifest,
    ...(ungrounded ? { ungrounded: true } : {}),
  };
  await updateState(paths, { phase: "built-unverified", currentBuild });

  console.error(
    `[loombridge build] minted runId=${currentBuild.runId} startedAt=${currentBuild.startedAt}` +
      (ungrounded ? " (UNGROUNDED — disqualified from done)" : ""),
  );
  console.error(
    `[loombridge build] phase=built-unverified, captureManifest=${captureManifest.length} entries from capturePack` +
      (captureManifest.length === 0 ? " (none — contract has no capturePack)" : ""),
  );
  console.error(
    "[loombridge build] next: agent constructs via Loombridge MCP, saves captures to .loombridge/verify/<state>/,",
  );
  console.error(
    // The printed command names --inputs ON PURPOSE. `.loombridge/verify` is the engine's
    // own default inputs dir, so this is byte-identical to the pre-S1 bare form (including
    // the nothing-graded refusal) while keeping the supervised loop on the CONTRACT-mode
    // engine. A bare `verify --strict` now routes to the unified front door, which is a
    // different (and broader) question than the one this loop is asking.
    "[loombridge build]       then `loombridge verify --strict --inputs .loombridge/verify` and `loombridge doneness` to certify (§3a).",
  );
  return 0;
}

async function runSliceBuild(args: BuildArgs, plan: SlicePlan, ungrounded: boolean): Promise<number> {
  const paths = loombridgePaths(args.root);
  const slice = nextUnblockedSlice(plan);
  if (!slice) {
    console.error(
      "[loombridge build] no slice to build — a prior slice may be awaiting approval; " +
        "run `loombridge plan` to enter the approval flow, or all slices are approved.",
    );
    return 1;
  }

  const captureManifest = deriveSliceCaptureManifest(slice);
  const startedAt = nowIso();
  const runId = mintSliceRunId(slice.id);
  const verdictPath = path.relative(args.root, getSliceVerdictPath(paths, slice.id));

  const withInvalidatedDependents = hasApprovedDependent(plan, slice.id)
    ? markDependentStale(plan, slice.id)
    : plan;
  const nextPlan: SlicePlan = {
    ...withInvalidatedDependents,
    slices: withInvalidatedDependents.slices.map((entry) =>
      entry.id === slice.id
        ? {
            ...entry,
            state: "built" as const,
            proof: {
              runId,
              startedAt,
              verdictPath,
              captureManifest,
              checkpointId: null,
              approvedAt: null,
            },
          }
        : entry,
    ),
  };
  await writeSlicePlan(paths, nextPlan);

  const currentBuild: CurrentBuildRef = {
    runId,
    startedAt,
    captureManifest,
    ...(ungrounded ? { ungrounded: true } : {}),
  };
  await updateState(paths, { phase: "built-unverified", currentBuild });

  console.error(
    `[loombridge build] slice ${slice.id} built (proof minted) runId=${runId} startedAt=${startedAt}` +
      (ungrounded ? " (UNGROUNDED — disqualified from done)" : ""),
  );
  console.error(
    `[loombridge build] captureManifest=${captureManifest.length} entries under .loombridge/verify/${slice.id}/` +
      (captureManifest.length === 0 ? " (none — slice gates have no captured-op file)" : ""),
  );
  console.error(
    `[loombridge build] next: construct slice ${slice.id}, save captures, then \`loombridge verify --slice ${slice.id}\`.`,
  );
  return 0;
}

function hasApprovedDependent(plan: SlicePlan, sliceId: string): boolean {
  const byId = new Map(plan.slices.map((s) => [s.id, s]));

  function dependsTransitively(id: string): boolean {
    const slice = byId.get(id);
    if (!slice) return false;
    return slice.dependsOn.includes(sliceId) || slice.dependsOn.some(dependsTransitively);
  }

  return plan.slices.some((entry) => entry.state === "approved" && entry.id !== sliceId && dependsTransitively(entry.id));
}

/** A `--help`/parse outcome. `usageError` exits 2; a bare `help` exits 0. See `update`/`verify`. */
type ParseHelp = { help: true; usageError?: boolean };

function parseArgs(args: string[]): BuildArgs | ParseHelp {
  let root = process.cwd();
  let allowUngroundedPrototype = false;
  const intentParts: string[] = [];

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--root") root = path.resolve(args[(i += 1)] ?? root);
    else if (arg === "--allow-ungrounded-prototype") allowUngroundedPrototype = true;
    else if (arg === "--help" || arg === "-h") return { help: true };
    else if (arg.startsWith("--")) {
      console.error(`[loombridge build] unknown option "${arg}".`);
      return { help: true, usageError: true };
    } else {
      intentParts.push(arg);
    }
  }
  return {
    root,
    allowUngroundedPrototype,
    intent: intentParts.join(" ") || undefined,
  };
}

function printUsage(): void {
  console.log(
    [
      'Usage: loombridge build ["<intent>"] [options]',
      "",
      "Mint a §3a build run + gate preconditions. The agent then constructs through",
      "the Loombridge MCP, saves captures to .loombridge/verify/<state>/, runs",
      "`loombridge verify --strict --inputs .loombridge/verify` and `loombridge doneness`",
      "to certify (--inputs keeps the supervised loop on the contract-mode engine; it is",
      "the engine's own default dir, so behavior is unchanged).",
      "",
      "Intent routing is the M2 agent-prose layer (commands/loombridge/build.md);",
      "this CLI does not interpret natural language (plan §3b).",
      "",
      "Options:",
      "  --root <dir>                   Project root (default: cwd)",
      "  --allow-ungrounded-prototype   Loud escape: build without an approved Design",
      "                                 Target. The run is tagged `ungrounded` and",
      "                                 `doneness` will refuse to certify it.",
      "  -h, --help                     Show this help",
    ].join("\n"),
  );
}

/** CLI entry: parse the post-subcommand args and run. */
export async function run(args: string[]): Promise<number> {
  const parsed = parseArgs(args);
  if ("help" in parsed) {
    printUsage();
    return parsed.usageError ? 2 : 0;
  }
  try {
    return await runBuild(parsed);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[loombridge build] fatal: ${message}`);
    return 1;
  }
}
