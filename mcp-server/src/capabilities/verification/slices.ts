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

import type { LoombridgePaths } from "../../domain/state.js";
import { isSafeCapturePath } from "../../domain/capture-paths.js";
import { SUPPORTED_GATE_IDS } from "./run-gates.js";

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

/**
 * How a slice's skill binding is RENDERED to an agent. Shared by every surface that shows it
 * (`plan`'s next-slice block, `ask`'s slice details) so an unbound slice can never reach an agent as
 * the literal string "undefined" on one surface while reading correctly on another.
 *
 * The binding is optional by design: for most genres no shipped skill pack covers a given slice, and
 * naming one that does not exist is worse than naming none, because the agent goes looking for it.
 */
export function renderSliceSkill(skill: string | undefined, installed: readonly string[] = []): string {
  if (skill) return skill;
  // NEVER assert absence while the project holds skills. The old text said
  // "(none ships for this slice ...)" unconditionally, and with 13 skills installed that was
  // simply false: an agent told nothing exists does not go looking, which is how a delivered
  // skill stayed invisible through a whole 3D build. See Docs/Design/SkillRouting.md.
  //
  // DELIBERATELY NOT A LIST. Only `installed.length` is read, never the names, because routing is
  // ALREADY automatic: Claude and Codex both surface the skills in `.claude/skills/` /
  // `.codex/skills/` with their descriptions, and those descriptions are written as trigger
  // conditions precisely so the agent matches without being handed a menu. Printing the inventory
  // here would be redundant with what the agent already has, and it would reframe an automatic
  // match as a choice somebody has to make. The only thing this line has to do is stop suppressing
  // the matching that would otherwise happen. Do not "improve" this by enumerating them.
  if (installed.length > 0) return "none pinned for this slice";
  // A project without `install-agent` genuinely has none, so the original wording is TRUE here.
  return "(none ships for this slice — build with the generic `unity_*` MCP ops)";
}

/**
 * The closed set of `action` values a history entry may carry. A closed set is the
 * point: an audit trail whose verbs are free text cannot be read by anything but a
 * human, and a typo'd action would silently become a new category of event.
 */
export const SLICE_HISTORY_ACTIONS = ["reopen"] as const;
export type SliceHistoryAction = (typeof SLICE_HISTORY_ACTIONS)[number];

/**
 * One lifecycle event recorded on a slice (mirrors slices.schema.json
 * `sliceHistoryEntry`). Written by `loombridge reopen`, which is the ONLY sanctioned
 * way to send a settled slice back to `stale`: before this verb the transition was a
 * hand edit to SLICES.json, which left no record that it had ever happened.
 */
export interface SliceHistoryEntry {
  /** ISO timestamp of the event. */
  at: string;
  /** What happened. Closed set (see {@link SLICE_HISTORY_ACTIONS}). */
  action: SliceHistoryAction;
  /**
   * The OTHER slices this event marked stale (the transitive dependents). The target
   * slice itself is never listed; `[]` means the reopen touched nothing downstream.
   */
  cascade: string[];
}

/** One slice entry (mirrors slices.schema.json `slice`). */
export interface SliceEntry {
  id: string;
  title: string;
  /** Build order — `plan` walks the DAG to pick the next unblocked slice. */
  dependsOn: string[];
  /**
   * OPTIONAL. Which skill pack builds this slice. ABSENT is the honest answer when no shipped skill
   * covers it: `plan` then tells the agent to use the generic ops rather than naming a skill that
   * does not exist. Present ⇒ non-empty (see the validator).
   */
  skill?: string;
  /** Genre/animation/feel notes for this slice. */
  feelIntent: string;
  acceptance: SliceAcceptance;
  state: SliceState;
  /** Absent until the slice is built. */
  proof?: SliceProof;
  /**
   * Append-only lifecycle log. Absent until something happens that a later reader
   * would otherwise have no way to reconstruct (today: `loombridge reopen`).
   */
  history?: SliceHistoryEntry[];
}

/**
 * The property sets the hand-rolled validator below enforces, named once so the
 * repo guard can compare them against `slices.schema.json` IN BOTH DIRECTIONS.
 *
 * Nothing loads the schema at runtime, so a field added to one side and not the other
 * is invisible: the schema (which declares `additionalProperties: false`) would refuse
 * a document the validator accepts, or the validator would refuse one the schema
 * blesses. `loombridge-slices.test.ts` walks these three constants against the schema's
 * own `properties` keys, so adding a field to either home alone fails the suite.
 */
export const SLICE_FIELDS = [
  "id",
  "title",
  "dependsOn",
  "skill",
  "feelIntent",
  "acceptance",
  "state",
  "proof",
  "history",
] as const;

export const SLICE_PROOF_FIELDS = [
  "runId",
  "startedAt",
  "verdictPath",
  "captureManifest",
  "checkpointId",
  "approvedAt",
  "approvalNote",
  "signoffArtifact",
  "signoffSha256",
] as const;

export const SLICE_HISTORY_FIELDS = ["at", "action", "cascade"] as const;

/**
 * The proof fields that record an APPROVAL. Cleared whenever a slice is sent back to
 * `stale` by `loombridge reopen`: a stale slice that still carries `approvedAt` +
 * `checkpointId` is a re-approval shortcut, because those are exactly the fields the
 * approval seam and `isSliceDone` read to decide the slice has already been signed off.
 */
export const SLICE_APPROVAL_FIELDS = [
  "checkpointId",
  "approvedAt",
  "approvalNote",
  "signoffArtifact",
  "signoffSha256",
] as const;

/**
 * The subset of {@link SLICE_APPROVAL_FIELDS} that proves a HUMAN signed the slice off, i.e. the
 * fields only the `plan --go` approval seam ever writes.
 *
 * `checkpointId` is deliberately excluded: a merely VERIFIED slice already carries one, so counting
 * it as sign-off would treat "someone ran verify" as "someone approved this". Derived from
 * `SLICE_APPROVAL_FIELDS` rather than re-listed, so a new approval artifact cannot be added to one
 * list and forgotten in the other.
 */
export const SLICE_SIGNOFF_FIELDS: readonly Exclude<
  (typeof SLICE_APPROVAL_FIELDS)[number],
  "checkpointId"
>[] = SLICE_APPROVAL_FIELDS.filter(
  (f): f is Exclude<(typeof SLICE_APPROVAL_FIELDS)[number], "checkpointId"> => f !== "checkpointId",
);

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
      // Closed-key strictness, mirroring `proof` below and the schema's own
      // `additionalProperties: false`. Without it a hand-edited SLICES.json can carry
      // an invented field (a mistyped `histroy`, a fabricated `approved: true`) that
      // every reader ignores while the author believes it is load-bearing.
      for (const key of Object.keys(slice)) {
        if (!(SLICE_FIELDS as readonly string[]).includes(key)) {
          issues.push(`${p}: unknown field '${key}'.`);
        }
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
      // OPTIONAL, present-only. Absent means "no shipped skill pack covers this slice", which is a
      // real and honest answer — 18 slices across the 3D packs are in exactly that position, and
      // naming a fiction there is what this became. But present-but-empty is still REFUSED: `""`
      // reads as a binding while naming nothing, which is the same failure wearing a different hat.
      //
      // Membership in the shipped skill set is deliberately NOT checked here. A consumer's SLICES.json
      // may name a skill they wrote themselves; the closed-set claim is about OUR templates, and it
      // lives in `__tests__/unit/repo/slice-skill-bindings.test.ts`.
      if (slice.skill !== undefined && !isNonEmptyString(slice.skill)) {
        issues.push(`${p}.skill: when present, must be a non-empty string (omit it if no skill pack applies).`);
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
          const allowed = new Set<string>(SLICE_PROOF_FIELDS);
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
      // history is optional (absent until a lifecycle event is recorded) and, like
      // proof, load-bearing once present: it is the ONLY record that a settled slice
      // was sent back to `stale` and why. Validate shape + the closed action set, so
      // a hand-written entry cannot invent an event class nothing renders.
      if (slice.history !== undefined) {
        if (!Array.isArray(slice.history)) {
          issues.push(`${p}.history: must be an array.`);
        } else {
          slice.history.forEach((entry, h) => {
            const hp = `${p}.history[${h}]`;
            if (!isRecord(entry)) {
              issues.push(`${hp}: must be an object.`);
              return;
            }
            const allowedHistory = new Set<string>(SLICE_HISTORY_FIELDS);
            for (const key of Object.keys(entry)) {
              if (!allowedHistory.has(key)) issues.push(`${hp}: unknown field '${key}'.`);
            }
            if (!isNonEmptyString(entry.at)) {
              issues.push(`${hp}.at: is required (ISO timestamp).`);
            }
            if (!(SLICE_HISTORY_ACTIONS as readonly unknown[]).includes(entry.action)) {
              issues.push(
                `${hp}.action: must be one of ${SLICE_HISTORY_ACTIONS.join("|")} (got ${JSON.stringify(entry.action)}).`,
              );
            }
            if (!Array.isArray(entry.cascade) || !entry.cascade.every((v) => isNonEmptyString(v))) {
              issues.push(`${hp}.cascade: must be an array of slice ids ([] when nothing cascaded).`);
            } else {
              for (const id of entry.cascade as string[]) {
                if (!SAFE_SLICE_ID_RE.test(id)) {
                  issues.push(`${hp}.cascade: '${id}' is not a safe slice id (${SAFE_SLICE_ID_RE}).`);
                }
              }
            }
          });
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
      // Conditional: a plain `skill: slice.skill` would write `"skill": undefined`, which
      // `JSON.stringify` drops from the file but which every in-memory reader still sees as a
      // present key. Omit it properly so absent means absent on both sides.
      ...(slice.skill ? { skill: slice.skill } : {}),
      feelIntent: slice.feelIntent,
      acceptance: {
        gates: [...slice.acceptance.gates],
        ...(slice.acceptance.criteria
          ? { criteria: structuredClone(slice.acceptance.criteria) }
          : {}),
      },
      state: "pending" as const,
      // Carried, not dropped. This function rebuilds every entry FIELD BY FIELD, so a
      // field it does not name is silently lost: and `history` is an audit trail, which
      // is the one kind of data a silent drop is least visible on. (`proof` is dropped on
      // purpose: a fresh instantiation has not been built.)
      ...(slice.history ? { history: structuredClone(slice.history) } : {}),
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

/** One slice a reopen changed, with the state it held before the change. */
export interface ReopenTouchedSlice {
  id: string;
  /** The state this slice held BEFORE the reopen. */
  priorState: SliceState;
  /** True for the reopen target; false for a slice the cascade invalidated. */
  target: boolean;
  /** Approval/proof artifacts that were PRESENT and have been cleared (may be empty). */
  clearedApproval: string[];
}

export type ReopenResult =
  | { ok: false; reason: "unknown-slice"; knownIds: string[] }
  | { ok: false; reason: "nothing-to-reopen"; state: SliceState }
  | {
      ok: true;
      plan: SlicePlan;
      /** Target first, then every cascaded slice in DAG order. */
      touched: ReopenTouchedSlice[];
      /** The slices to re-verify, dependencies before dependents. */
      reverifyChain: string[];
    };

/**
 * THE re-open transition (ledger backlog 3): send a settled slice back to `stale`
 * through the state machine instead of hand-editing SLICES.json.
 *
 * Three things happen together, and all three are load-bearing:
 *  1. the TARGET slice goes `stale`;
 *  2. its APPROVAL ARTIFACTS are cleared (`checkpointId`, `approvedAt`, `approvalNote`,
 *     `signoffArtifact`, `signoffSha256`): a stale slice that still carries them is a
 *     re-approval shortcut, since those fields are exactly what the approval seam and
 *     `isSliceDone` read to conclude the slice was already signed off;
 *  3. every transitive dependent is invalidated through the SAME `markDependentStale`
 *     the rebuild path uses, so re-open and rebuild can never disagree about what a
 *     slice's staleness reaches.
 *
 * The cascaded slices are cleared too. The argument for (2) does not weaken one hop
 * downstream: an approved dependent whose upstream evidence was just invalidated is
 * exactly as un-signed-off as the target.
 *
 * Pure: no fs, no clock. `at` is passed in so the caller owns the timestamp.
 */
export function reopenSlicePlan(plan: SlicePlan, sliceId: string, at: string): ReopenResult {
  assertSafeSliceId(sliceId);
  const target = plan.slices.find((s) => s.id === sliceId);
  if (!target) {
    return { ok: false, reason: "unknown-slice", knownIds: plan.slices.map((s) => s.id) };
  }
  // "Nothing to do" is STATED, never silently succeeded (and never silently rewritten):
  // a slice that is already stale or still pending has no approval to withdraw and no
  // downstream approval to invalidate that its own build did not already invalidate.
  if (target.state === "stale" || target.state === "pending") {
    return { ok: false, reason: "nothing-to-reopen", state: target.state };
  }

  const priorState = new Map(plan.slices.map((s) => [s.id, s.state]));
  const cascaded = markDependentStale(plan, sliceId);
  const changedIds = cascaded.slices
    .filter((s) => s.state !== priorState.get(s.id))
    .map((s) => s.id);

  const touched: ReopenTouchedSlice[] = [];
  const slices = cascaded.slices.map((entry) => {
    const isTarget = entry.id === sliceId;
    if (!isTarget && !changedIds.includes(entry.id)) return entry;
    const cleared = clearedApprovalFields(entry);
    touched.push({
      id: entry.id,
      priorState: priorState.get(entry.id)!,
      target: isTarget,
      clearedApproval: cleared,
    });
    const next: SliceEntry = {
      ...entry,
      state: "stale" as const,
      ...(entry.proof ? { proof: withApprovalCleared(entry.proof) } : {}),
    };
    if (!isTarget) return next;
    return {
      ...next,
      history: [...(entry.history ?? []), { at, action: "reopen" as const, cascade: [...changedIds] }],
    };
  });

  const chain = topoOrderIds(plan, [sliceId, ...changedIds]);
  return {
    ok: true,
    plan: { ...cascaded, slices },
    // Target first so the operator reads "what I asked for" before "what it cost".
    touched: [...touched].sort((a, b) => Number(b.target) - Number(a.target)),
    reverifyChain: chain,
  };
}

/**
 * The given ids in DAG order: a dependency always precedes its dependents. Derived from
 * `dependsOn`, NOT from the array order: the array happens to be authored in build order
 * today, and a re-verify chain printed in the wrong order tells an operator to re-verify a
 * slice before the evidence it rests on exists. Cycles are refused at rest by the
 * validator; the `seen` guard keeps this terminating regardless.
 */
function topoOrderIds(plan: SlicePlan, ids: string[]): string[] {
  const wanted = new Set(ids);
  const byId = new Map(plan.slices.map((s) => [s.id, s]));
  const seen = new Set<string>();
  const out: string[] = [];

  function visit(id: string): void {
    if (seen.has(id) || !wanted.has(id)) return;
    seen.add(id);
    for (const dep of byId.get(id)?.dependsOn ?? []) visit(dep);
    out.push(id);
  }

  for (const slice of plan.slices) visit(slice.id);
  return out;
}

/**
 * The HUMAN sign-off a slice carries today, named field by field; `[]` when it carries none.
 *
 * Used by any caller about to DISCARD a slice (today: `plan --force` across a genre change). An
 * approved slice is human-signed evidence, so replacing it silently would let a rewrite launder away
 * a sign-off; the sanctioned way to withdraw one is `loombridge reopen`, which records the event.
 *
 * `state: "approved"` counts on its own: a hand-edited SLICES.json can claim the state without the
 * proof block, and a rewrite must not be the cheap way to erase that claim rather than confront it.
 */
export function sliceApprovalEvidence(slice: SliceEntry): string[] {
  const out: string[] = [];
  if (slice.state === "approved") out.push('state: "approved"');
  const proof = slice.proof;
  if (proof) {
    for (const field of SLICE_SIGNOFF_FIELDS) {
      if (proof[field] !== undefined && proof[field] !== null) out.push(`proof.${field}`);
    }
  }
  return out;
}

/** Which approval artifacts a slice actually carries today (so the report can name them). */
function clearedApprovalFields(slice: SliceEntry): string[] {
  const proof = slice.proof;
  if (!proof) return [];
  return SLICE_APPROVAL_FIELDS.filter((f) => proof[f] !== undefined && proof[f] !== null);
}

/** A copy of the proof with every approval artifact removed (never set to a falsy stand-in). */
function withApprovalCleared(proof: SliceProof): SliceProof {
  const next: SliceProof = { ...proof };
  for (const field of SLICE_APPROVAL_FIELDS) delete next[field];
  return next;
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

/**
 * `.loombridge/reports/slices/<sliceId>/signoff<ext>` — the human sign-off artifact
 * `plan --signoff` durably copies next to the slice's verdict.
 *
 * A slot rather than a literal join at the writer (`plan.ts` used to spell the whole
 * `.loombridge/reports/slices/…` path itself), so the destination is derived from
 * `paths.reports` and walked by `__tests__/unit/repo/write-paths.test.ts` like every other
 * per-slice path here. `ext` is validated by the caller and passed through verbatim; the
 * slice id goes through the same single-segment guard as the verdict path.
 */
export function getSliceSignoffPath(paths: LoombridgePaths, sliceId: string, ext: string): string {
  return path.join(paths.reports, "slices", assertSafeSliceId(sliceId), `signoff${ext}`);
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
