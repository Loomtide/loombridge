/**
 * The slice contract + decomposer core (plan §'The slice contract', §'Per-slice
 * proof model', §'Slice scoping vs --stage').
 *
 * A Loombridge project is built one polished slice at a time: `plan` emits an
 * ordered, dependency-aware DAG (`.loombridge/SLICES.json`) from a genre template,
 * each slice carries its skill + feel intent + acceptance gates, and `build`
 * mints a PER-SLICE proof block so prior approvals stay auditable.
 *
 * This module is deterministic and engine-agnostic — no agent, no Unity. The
 * pure functions (instantiate / nextUnblockedSlice / planDispatchMode /
 * rollupDone) have NO fs side effects; the fs helpers are kept separate.
 */

import fs from "node:fs/promises";
import path from "node:path";

import type { LoombridgePaths } from "./state.js";
import { isSafeCapturePath } from "./capture-paths.js";
import { SUPPORTED_GATE_IDS } from "../verification/run-gates.js";

export const SLICES_SCHEMA_VERSION = "1";

/** Per-slice lifecycle state (mirrors slices.schema.json). */
export type SliceState = "pending" | "built" | "verified" | "approved" | "stale";

/**
 * Per-slice proof block, minted by that slice's `build` (plan §'Per-slice proof
 * model'). All fields are optional until the slice is built; the block lives PER
 * SLICE inside the slice entry, never in a shared single slot.
 */
export interface SliceProof {
  /** Slice-scoped run id minted at build start (run-<sliceId>-<ts>-<rand>). */
  runId?: string;
  /** ISO timestamp when the slice build was minted. */
  startedAt?: string;
  /** Per-slice verdict path: .loombridge/reports/slices/<sliceId>.verdict.json. */
  verdictPath?: string;
  /** Paths under .loombridge/verify/<sliceId>/ that MUST exist to certify. */
  captureManifest?: string[];
  /** The .loombridge-fixtures/<sliceId>/ snapshot id; null until verified. */
  checkpointId?: string | null;
  /** Set at the human checkpoint; null until approved. */
  approvedAt?: string | null;
  /** Optional human/operator approval note recorded at the approval seam. */
  approvalNote?: string;
  /** Durable root-relative sign-off artifact copied under .loombridge/reports/slices/<id>/. */
  signoffArtifact?: string;
  /** sha256 of the durable sign-off artifact bytes. */
  signoffSha256?: string;
}

/**
 * The slice's acceptance — which gates `verify --slice` selects for it
 * (plan §'Slice scoping vs --stage'): data-driven gate selection, NOT the
 * hardcoded --stage phase enum.
 */
export interface SliceAcceptance {
  /** Gate ids this slice's verify must run/pass. */
  gates: string[];
  /** Optional per-slice criteria refinements. */
  criteria?: Record<string, unknown>;
}

/** One slice entry (mirrors slices.schema.json `slice`). */
export interface SliceEntry {
  id: string;
  title: string;
  /** Build order — `plan` walks the DAG to pick the next unblocked slice. */
  dependsOn: string[];
  /** Which skill pack/component builds this slice. */
  skill: string;
  /** Genre/animation/feel notes for this slice. */
  feelIntent: string;
  acceptance: SliceAcceptance;
  state: SliceState;
  /** Absent until the slice is built. */
  proof?: SliceProof;
}

/** The slice DAG written to `.loombridge/SLICES.json`. */
export interface SlicePlan {
  schemaVersion: typeof SLICES_SCHEMA_VERSION;
  genre: string;
  slices: SliceEntry[];
}

const SLICE_STATES = new Set<SliceState>(["pending", "built", "verified", "approved", "stale"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => isNonEmptyString(v));
}

// ── validation (mirrors validator.ts: throw on bad shape) ────────────────────

/**
 * Throwing validator for a slice plan. Mirrors `assertValidAcceptanceContract`:
 * collects every shape problem, then throws a single summarised error. On top of
 * shape it enforces the DAG invariants: unique ids, dependsOn references resolve,
 * and the graph is acyclic.
 */
export function assertValidSlicePlan(input: unknown): SlicePlan {
  const issues: string[] = [];

  if (!isRecord(input)) {
    throw new Error("Slice plan validation failed: SLICES.json must be an object.");
  }

  if (input.schemaVersion !== SLICES_SCHEMA_VERSION) {
    issues.push(`schemaVersion: must be '${SLICES_SCHEMA_VERSION}'.`);
  }
  if (!isNonEmptyString(input.genre)) {
    issues.push("genre: is required.");
  }

  const ids = new Set<string>();
  if (!Array.isArray(input.slices)) {
    issues.push("slices: must be an array.");
  } else {
    input.slices.forEach((slice, i) => {
      const p = `slices[${i}]`;
      if (!isRecord(slice)) {
        issues.push(`${p}: must be an object.`);
        return;
      }
      if (!isNonEmptyString(slice.id)) {
        issues.push(`${p}.id: is required.`);
      } else if (!SAFE_SLICE_ID_RE.test(slice.id)) {
        // A slice id is a SINGLE `.loombridge/` path segment (it names the per-slice
        // verdict/verify/fixture dirs). Reject traversal/unsafe ids at rest so a
        // hand-edited SLICES.json can never steer a write outside `.loombridge/`
        // (the path builders also assert, but the contract must be valid at rest).
        issues.push(
          `${p}.id: '${slice.id}' is not a safe slice id (must match ${SAFE_SLICE_ID_RE} — a single .loombridge/ path segment, no traversal).`,
        );
      } else if (ids.has(slice.id)) {
        issues.push(`${p}.id: '${slice.id}' is duplicated.`);
      } else {
        ids.add(slice.id);
      }
      if (!isNonEmptyString(slice.title)) {
        issues.push(`${p}.title: is required.`);
      }
      if (!Array.isArray(slice.dependsOn) || !isStringArray(slice.dependsOn)) {
        issues.push(`${p}.dependsOn: must be an array of non-empty strings.`);
      } else {
        for (const dep of slice.dependsOn) {
          if (!SAFE_SLICE_ID_RE.test(dep)) {
            issues.push(`${p}.dependsOn: '${dep}' is not a safe slice id (${SAFE_SLICE_ID_RE}).`);
          }
        }
      }
      if (!isNonEmptyString(slice.skill)) {
        issues.push(`${p}.skill: is required.`);
      }
      if (!isNonEmptyString(slice.feelIntent)) {
        issues.push(`${p}.feelIntent: is required.`);
      }
      if (!isRecord(slice.acceptance) || !isStringArray(slice.acceptance.gates)) {
        issues.push(`${p}.acceptance.gates: must be a non-empty-string array.`);
      } else if (slice.acceptance.gates.length === 0) {
        issues.push(`${p}.acceptance.gates: must not be empty.`);
      } else {
        // Every requested gate MUST be a gate the verifier can actually grade.
        // An unknown id (a typo like 'ui-conformnace') would select no real gate
        // → every gate not_applicable → verify --slice exits 0 having graded
        // NOTHING (a false-green). Refuse at rest. (run-gates owns the set.)
        for (const g of slice.acceptance.gates) {
          if (!SUPPORTED_GATE_IDS.has(g)) {
            issues.push(
              `${p}.acceptance.gates: '${g}' is not a supported gate id (known: ${[...SUPPORTED_GATE_IDS].join(", ")}).`,
            );
          }
        }
      }
      if (typeof slice.state !== "string" || !SLICE_STATES.has(slice.state as SliceState)) {
        issues.push(`${p}.state: must be pending|built|verified|approved|stale.`);
      }
      // proof is optional (absent until built) but load-bearing once present — S2
      // doneness reads it, so validate shape + path safety now (S1a review MEDIUM).
      if (slice.proof !== undefined) {
        if (!isRecord(slice.proof)) {
          issues.push(`${p}.proof: must be an object.`);
        } else {
          const allowed = new Set(["runId", "startedAt", "verdictPath", "captureManifest", "checkpointId", "approvedAt", "approvalNote", "signoffArtifact", "signoffSha256"]);
          for (const key of Object.keys(slice.proof)) {
            if (!allowed.has(key)) issues.push(`${p}.proof: unknown field '${key}'.`);
          }
          for (const f of ["runId", "startedAt", "verdictPath"] as const) {
            if (slice.proof[f] !== undefined && typeof slice.proof[f] !== "string") {
              issues.push(`${p}.proof.${f}: must be a string.`);
            }
          }
          if (slice.proof.checkpointId !== undefined && slice.proof.checkpointId !== null && typeof slice.proof.checkpointId !== "string") {
            issues.push(`${p}.proof.checkpointId: must be a string or null.`);
          }
          if (slice.proof.approvedAt !== undefined && slice.proof.approvedAt !== null && typeof slice.proof.approvedAt !== "string") {
            issues.push(`${p}.proof.approvedAt: must be a string or null.`);
          }
          for (const f of ["approvalNote", "signoffSha256"] as const) {
            if (slice.proof[f] !== undefined && typeof slice.proof[f] !== "string") {
              issues.push(`${p}.proof.${f}: must be a string.`);
            }
          }
          if (typeof slice.proof.signoffSha256 === "string" && !/^[a-f0-9]{64}$/.test(slice.proof.signoffSha256)) {
            issues.push(`${p}.proof.signoffSha256: must be a lowercase sha256 hex digest.`);
          }
          if (slice.proof.signoffArtifact !== undefined) {
            if (typeof slice.proof.signoffArtifact !== "string") {
              issues.push(`${p}.proof.signoffArtifact: must be a string.`);
            } else if (!isSafeCapturePath(slice.proof.signoffArtifact)) {
              issues.push(`${p}.proof.signoffArtifact: '${slice.proof.signoffArtifact}' is not a safe relative path.`);
            }
          }
          if (slice.proof.captureManifest !== undefined) {
            if (!isStringArray(slice.proof.captureManifest)) {
              issues.push(`${p}.proof.captureManifest: must be a string[].`);
            } else {
              for (const cap of slice.proof.captureManifest) {
                if (!isSafeCapturePath(cap)) {
                  issues.push(`${p}.proof.captureManifest: '${cap}' is not a safe relative path.`);
                }
              }
            }
          }
        }
      }
    });
  }

  // DAG invariants — only meaningful once the per-slice shape is sound enough to
  // have ids + dependsOn arrays. Reference resolution + cycle detection run on
  // the well-formed subset so a shape error doesn't mask a graph error.
  if (Array.isArray(input.slices)) {
    const wellFormed = input.slices.filter(
      (s): s is { id: string; dependsOn: string[] } =>
        isRecord(s) && isNonEmptyString(s.id) && isStringArray(s.dependsOn),
    );
    for (const slice of wellFormed) {
      for (const dep of slice.dependsOn) {
        if (!ids.has(dep)) {
          issues.push(`slices[${slice.id}].dependsOn: unknown slice id '${dep}'.`);
        }
      }
    }
    const cycle = findCycle(wellFormed);
    if (cycle) {
      issues.push(`dependency cycle detected: ${cycle.join(" -> ")}.`);
    }
  }

  if (issues.length > 0) {
    throw new Error(`Slice plan validation failed: ${issues.join("; ")}`);
  }
  return input as unknown as SlicePlan;
}

/**
 * Returns a cycle as an ordered id list (the repeated id closes the loop), or
 * null when the graph is acyclic. Standard DFS three-colour walk.
 */
function findCycle(slices: Array<{ id: string; dependsOn: string[] }>): string[] | null {
  const byId = new Map(slices.map((s) => [s.id, s]));
  const visiting = new Set<string>();
  const done = new Set<string>();
  const stack: string[] = [];

  function dfs(id: string): string[] | null {
    visiting.add(id);
    stack.push(id);
    const node = byId.get(id);
    for (const dep of node?.dependsOn ?? []) {
      if (!byId.has(dep)) continue; // unresolved dep is reported separately
      if (visiting.has(dep)) {
        return [...stack.slice(stack.indexOf(dep)), dep];
      }
      if (!done.has(dep)) {
        const found = dfs(dep);
        if (found) return found;
      }
    }
    visiting.delete(id);
    stack.pop();
    done.add(id);
    return null;
  }

  for (const slice of slices) {
    if (!done.has(slice.id)) {
      const found = dfs(slice.id);
      if (found) return found;
    }
  }
  return null;
}

// ── pure functions (NO fs side effects) ──────────────────────────────────────

/**
 * Produce a fresh SlicePlan from a genre template: a deep copy with every slice
 * reset to `state: "pending"` and no proof. The template itself is never mutated.
 */
export function instantiateSlicePlan(template: SlicePlan): SlicePlan {
  return {
    schemaVersion: SLICES_SCHEMA_VERSION,
    genre: template.genre,
    slices: template.slices.map((slice) => ({
      id: slice.id,
      title: slice.title,
      dependsOn: [...slice.dependsOn],
      skill: slice.skill,
      feelIntent: slice.feelIntent,
      acceptance: {
        gates: [...slice.acceptance.gates],
        ...(slice.acceptance.criteria
          ? { criteria: structuredClone(slice.acceptance.criteria) }
          : {}),
      },
      state: "pending" as const,
    })),
  };
}

/**
 * First slice in DAG order whose `state` is `pending` or `stale` AND all of its
 * `dependsOn` are `approved`; null when none is unblocked (all approved, or the
 * frontier is blocked on unfinished upstream slices).
 */
export function nextUnblockedSlice(plan: SlicePlan): SliceEntry | null {
  const byId = new Map(plan.slices.map((s) => [s.id, s]));
  for (const slice of plan.slices) {
    if (slice.state !== "pending" && slice.state !== "stale") continue;
    const ready = slice.dependsOn.every((dep) => byId.get(dep)?.state === "approved");
    if (ready) return slice;
  }
  return null;
}

/**
 * Slices that are `built`/`verified` but not yet `approved` — i.e. they have
 * passed build/verify and are waiting on the human approval seam before `plan`
 * will advance. Distinct from `nextUnblockedSlice` (which only sees
 * `pending`/`stale`). `plan` uses this to avoid mistaking "awaiting approval"
 * for "all done".
 */
export function awaitingApprovalSlices(plan: SlicePlan): SliceEntry[] {
  return plan.slices.filter((s) => s.state === "built" || s.state === "verified");
}

/**
 * Deterministic dispatch precedence for `loombridge plan` (plan §'Settled command
 * model'). Documented precedence — same state always yields the same mode:
 *   1. no roadmap (`hasRoadmap` false) → "design" (run the outer design plan)
 *   2. roadmap + design NOT approved → "design" (re-establish/re-approve the target)
 *   3. a slice is built/verified but not approved → "await-approval"
 *      (the human "approve previous slice, then advance" seam — must NOT be
 *      skipped by classifying it as done)
 *   4. roadmap + a next unblocked slice → "plan-slice" (plan the next slice)
 *   5. roadmap + nothing pending AND nothing awaiting approval → "all-approved"
 *
 * Slices are verified AGAINST the design target, so an unapproved/tampered target
 * (the A10 frozen-hash-mismatch case) routes back to "design" rather than building
 * against nothing — mirrors the build.ts design gate.
 *
 * `awaitingApproval` is passed explicitly so the function stays pure: without it,
 * a verified-but-unapproved slice blocks the frontier (nextSlice=null) and would
 * be misread as "all-approved", silently skipping the approval seam (S1a review HIGH).
 */
export function planDispatchMode(args: {
  hasRoadmap: boolean;
  designApproved: boolean;
  nextSlice: SliceEntry | null;
  awaitingApproval: boolean;
}): "design" | "await-approval" | "plan-slice" | "all-approved" {
  if (!args.hasRoadmap) return "design";
  if (!args.designApproved) return "design";
  // A built/verified-but-unapproved slice means the human approval seam is due.
  // Resolve it BEFORE planning the next slice or declaring done.
  if (args.awaitingApproval) return "await-approval";
  if (args.nextSlice) return "plan-slice";
  return "all-approved";
}

/**
 * Whether EVERY slice is in the `approved` state. NOTE: this is the cheap
 * structural check only — it does NOT verify each slice's per-slice proof / fresh
 * verdict still holds. Roll-up *doneness* (proof-aware) is enforced by `doneness`
 * in S2; do not treat this predicate alone as "the game is done" (a hand-edited
 * SLICES.json with all states forced to `approved` and no proof would pass here).
 */
export function allSlicesApproved(plan: SlicePlan): boolean {
  return plan.slices.length > 0 && plan.slices.every((s) => s.state === "approved");
}

/**
 * Return a copy of the plan with every transitive dependent of `sliceId` marked
 * stale. Rebuilding an upstream slice invalidates downstream approvals/proofs;
 * unrelated slices and upstream dependencies are left untouched.
 */
export function markDependentStale(plan: SlicePlan, sliceId: string): SlicePlan {
  assertSafeSliceId(sliceId);
  const byId = new Map(plan.slices.map((s) => [s.id, s]));
  const memo = new Map<string, boolean>();

  function dependsTransitively(id: string): boolean {
    const cached = memo.get(id);
    if (cached !== undefined) return cached;
    const slice = byId.get(id);
    if (!slice) {
      memo.set(id, false);
      return false;
    }
    const depends = slice.dependsOn.includes(sliceId) || slice.dependsOn.some(dependsTransitively);
    memo.set(id, depends);
    return depends;
  }

  return {
    ...plan,
    slices: plan.slices.map((slice) => {
      const copy = cloneSliceEntry(slice);
      return copy.id !== sliceId && dependsTransitively(copy.id)
        ? { ...copy, state: "stale" as const }
        : copy;
    }),
  };
}

function cloneSliceEntry(slice: SliceEntry): SliceEntry {
  return {
    ...slice,
    dependsOn: [...slice.dependsOn],
    acceptance: {
      gates: [...slice.acceptance.gates],
      ...(slice.acceptance.criteria ? { criteria: structuredClone(slice.acceptance.criteria) } : {}),
    },
    ...(slice.proof
      ? {
          proof: {
            ...slice.proof,
            ...(slice.proof.captureManifest ? { captureManifest: [...slice.proof.captureManifest] } : {}),
          },
        }
      : {}),
  };
}

// ── per-slice paths (S2a) ────────────────────────────────────────────────────

/**
 * A slice id is a single path segment under `.loombridge/` — it MUST NOT escape
 * (no `..`, no `/`, no absolute path). A hand-edited SLICES.json must not be able
 * to steer the per-slice verdict/verify dir outside `.loombridge/`. Mirrors the
 * `capturePack` safe-path discipline (`isSafeCapturePath`); a slice id is even
 * tighter — a SINGLE segment of `[a-z0-9][a-z0-9-]*` (case-insensitive).
 */
const SAFE_SLICE_ID_RE = /^[a-z0-9][a-z0-9-]*$/i;

export function assertSafeSliceId(sliceId: string): string {
  if (typeof sliceId !== "string" || !SAFE_SLICE_ID_RE.test(sliceId)) {
    throw new Error(
      `unsafe slice id "${sliceId}" — must match ${SAFE_SLICE_ID_RE} (a single .loombridge/ path segment; no traversal).`,
    );
  }
  return sliceId;
}

/** `.loombridge/reports/slices/<sliceId>.verdict.json` — the per-slice verdict path (S2a). */
export function getSliceVerdictPath(paths: LoombridgePaths, sliceId: string): string {
  return path.join(paths.reports, "slices", `${assertSafeSliceId(sliceId)}.verdict.json`);
}

/** `.loombridge/reports/slices/<sliceId>.diagnostic.json` — non-binding re-verify output. */
export function getSliceDiagnosticPath(paths: LoombridgePaths, sliceId: string): string {
  return path.join(paths.reports, "slices", `${assertSafeSliceId(sliceId)}.diagnostic.json`);
}

/** `.loombridge/verify/<sliceId>/` — the per-slice captured-op-output dir (S2a). */
export function getSliceVerifyDir(paths: LoombridgePaths, sliceId: string): string {
  return path.join(paths.verifyInputs, assertSafeSliceId(sliceId));
}

/** `.loombridge-fixtures/<sliceId>/` — the per-slice resumable checkpoint dir. */
export function getSliceFixtureDir(paths: LoombridgePaths, sliceId: string): string {
  return path.join(paths.root, ".loombridge-fixtures", assertSafeSliceId(sliceId));
}

// ── fs helpers (separate from the pure fns) ──────────────────────────────────

/**
 * Read + validate `.loombridge/SLICES.json`; null when absent (the legacy
 * whole-game model). Mirrors the JSON read idiom in state.ts/doneness.ts.
 */
export async function readSlicePlan(paths: LoombridgePaths): Promise<SlicePlan | null> {
  let raw: string;
  try {
    raw = await fs.readFile(paths.slices, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  return assertValidSlicePlan(JSON.parse(raw));
}

/** Validate then write `.loombridge/SLICES.json` (pretty-printed, trailing newline). */
export async function writeSlicePlan(paths: LoombridgePaths, plan: SlicePlan): Promise<void> {
  assertValidSlicePlan(plan);
  await fs.mkdir(paths.dir, { recursive: true });
  await fs.writeFile(paths.slices, `${JSON.stringify(plan, null, 2)}\n`, "utf-8");
}

/**
 * Snapshot `.loombridge/` into `.loombridge-fixtures/<sliceId>/loombridge/`.
 * This is the slice-keyed filesystem substrate S2b needs; stage-scene restore
 * remains owned by the existing shell harness.
 */
export async function snapshotSliceFixture(paths: LoombridgePaths, sliceId: string): Promise<string> {
  const safe = assertSafeSliceId(sliceId);
  const fixture = getSliceFixtureDir(paths, safe);
  const loom = path.join(fixture, "loombridge");
  await fs.rm(fixture, { recursive: true, force: true });
  await fs.mkdir(loom, { recursive: true });
  await fs.cp(paths.dir, loom, { recursive: true });
  return safe;
}
