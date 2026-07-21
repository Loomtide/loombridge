/**
 * `loombridge doneness` — the §3a supervisor freshness predicate.
 *
 * "Build ends in verify and cannot report success without a fresh green verdict"
 * written as command prose can be skipped by an agent that just claims done.
 * This module is the code rule: the CLI itself certifies — phase
 * `verified-green` alone is not enough; the verdict must demonstrably belong to
 * the *current build* (runId match + produced after the build started + every
 * required capture present). Any "done" claim path goes through this gate.
 *
 * The minting half of the contract (writing `currentBuild` to STATE) lives in
 * `build.ts` (M2); this module ships the substrate so the contract is in place
 * the moment a runId exists.
 */

import fs from "node:fs/promises";
import path from "node:path";

import {
  fileExists,
  loombridgePaths,
  readState,
  type LoombridgePaths,
  type LoombridgeState,
} from "./state.js";
import { designStatus } from "./design.js";
import { isSafeCapturePath, isWithin } from "./capture-paths.js";
import {
  getSliceVerifyDir,
  readSlicePlan,
  type SliceEntry,
  type SlicePlan,
} from "./slices.js";
import { readAssetManifest } from "./asset-manifest.js";
import { resolveAllSliceAssetBindings } from "./asset-bindings.js";
import { genreFidelityCriteria } from "./genre-registry.js";
import { inspectContractPresence, noContractRefusal } from "./contract-presence.js";
import { assertValidAcceptanceContract } from "../verification/validator.js";
import { SFX_GATE_NAMES } from "../verification/run-gates.js";
import {
  deriveEvidenceClassesFromUntrusted,
  EVIDENCE_CLASS_SET,
  type EvidenceClassName,
  type EvidenceClassStatus,
} from "../verification/gates/evidence-classes.js";

/** The frozen Design Target metadata `verify` embeds into the verdict (§3c). */
export interface VerdictDesignTarget {
  status?: string;
  /**
   * The 3D design-target split. `composition-reference` is a style/composition
   * guide approved only to unlock scene assembly — it can NEVER certify
   * doneness or satisfy final hero-shot fidelity. Absent ⇒ `rendered-unity-frame`
   * (final-by-default — a pre-split verdict carries no `kind`, and a flat 2D
   * mock IS the final hero shot). Only an EXPLICIT `composition-reference` is
   * refused, so existing 2D behaviour is unchanged.
   */
  kind?: string;
  /** sha256 of the hero-shot bytes recorded at approval (the freeze). */
  pngSha256?: string | null;
  frozenMatches?: boolean;
}

/** One advisory VLM review criterion as it appears in the verdict. */
export interface VerdictReviewCriterion {
  id: string;
  status?: string;
  reason?: string;
}

/**
 * The advisory Tier-2 review block `verify --vlm` merges into the verdict. The
 * fidelity predicate reads three things from it: which hero shot the review
 * compared against (`reference`), whether it was independent (`independence`),
 * and the per-criterion verdicts.
 */
export interface VerdictReviewFindings {
  /** P0.1 — what the reviewers actually compared the frames against. */
  reference?: { heroShotSha256?: string };
  /** P0.3 — independence attestation (the CLI can check it was declared, ≥2). */
  independence?: { independent?: boolean; reviewerCount?: number };
  frames?: Array<{ id: string; path: string; label?: string }>;
  criteria?: VerdictReviewCriterion[];
  summary?: string;
}

/** The shape `doneness` reads from `build-verdict.json`. */
export interface VerdictLike {
  status?: string;
  runId?: string | null;
  producedAt?: string;
  /** Frozen Design Target metadata (plan §3c); present on `loombridge verify` output. */
  designTarget?: VerdictDesignTarget;
  /** Advisory Tier-2 VLM review; present only when `verify --vlm` ran. */
  reviewFindings?: VerdictReviewFindings;
  /** Per-gate verdict statuses from build-verdict.json (BuildVerdict.gates). */
  gates?: Record<string, string | undefined>;
  /** Flat deterministic gate checks from build-verdict.json. */
  checks?: Array<{ id?: string; status?: string; detail?: string; actual?: string }>;
  /**
   * Evidence-class matrix (dogfood learnings §6 / High #7): each class's present/absent/
   * partial status. ALWAYS emitted by `loombridge verify`. When the on-disk contract
   * declares `verification.requiredEvidenceClasses`, doneness REFUSES unless every
   * required class here is `"present"` (an absent/partial/omitted class is a
   * refusal, never a skip) AND that `present` agrees with a RE-DERIVATION from
   * this verdict's own `gates`+`checks` (the block is never trusted in isolation —
   * a hand-edited block field cannot self-attest). Loosely typed (disk data).
   */
  evidenceClasses?: Record<string, { status?: string; source?: string } | undefined>;
  /**
   * The art posture the build CLAIMS (RCL-D01). NEVER trusted on its own — the
   * gray-box relaxation is decided from the on-disk acceptance contract. A
   * verdict that claims `art.mode:"deferred"` while the on-disk contract does
   * not declare it is REFUSED (no laundering — `artModeRefusals`).
   */
  art?: { mode?: string };
}

/**
 * The hero-shot fidelity criteria a design-targeted build must pass before
 * `doneness` certifies it (plan §P0.2). These are the structural checks RUN-1's
 * flat build failed-but-was-passed-anyway: the overall layout match plus the
 * background/level/element-placement structure that the deterministic gates
 * cannot see. This literal is the platformer-2d default; the genre-dispatched
 * criteria are resolved per-build via the genre registry (genreFidelityCriteria),
 * falling back to this default for an unregistered/"unknown" genre.
 */
export const HERO_SHOT_FIDELITY_CRITERIA = [
  "composition-match",
  "parallax-present",
  "platform-tiers",
  "element-placement-arc",
] as const;

/**
 * Resolve the hero-shot fidelity criteria for a build's genre, or a REFUSAL when the genre is not
 * registered. An unknown/unregistered genre is NEVER defaulted to the platformer criteria (the
 * "unknown genre is refused, not defaulted" invariant) — a stale or hand-edited `state.genre` must not
 * certify a design-targeted build against arbitrary criteria. The refusal only matters when there is an
 * approved Design Target (callers gate on that); otherwise hero-shot fidelity is N/A.
 */
export function fidelityCriteriaForGenre(
  genre: string,
): { criteria: readonly string[] } | { refusal: string } {
  const criteria = genreFidelityCriteria(genre);
  if (criteria) return { criteria };
  return {
    refusal: `genre "${genre}" is not a registered genre — cannot resolve hero-shot fidelity criteria; refusing (an unknown genre is never defaulted to platformer — plan §P0).`,
  };
}

/**
 * The hero-shot fidelity predicate (plan §P0.1/P0.2/P0.3/P0.5). For a build with
 * an APPROVED Design Target, `doneness` is not allowed to certify a build that
 * does not demonstrably match the frozen hero shot via an INDEPENDENT review.
 * Returns the (possibly empty) list of reasons it is NOT faithful.
 *
 * N/A (returns `[]`) when there is no approved Design Target — an ungrounded or
 * pre-design build has no hero shot to match (and is refused on other grounds).
 *
 * This is the moat: RUN-1 reached `doneness=0` on a flat-background / flat-level
 * build because the VLM was advisory, self-graded, judged contract attributes
 * (`references hero-shot.png:false`) and `composition-match` was a self-accepted
 * WARN. Each of those is a distinct refusal here. Pure + exhaustively testable.
 */
/**
 * The single refusal a `composition-reference` Design Target earns from every
 * doneness path (the 3D split, §3c). Shared so the verdict-driven check and the
 * disk-truth check emit the identical, actionable message.
 */
export const COMPOSITION_REFERENCE_REFUSAL =
  "design target is an APPROVED `composition-reference` (style/composition guide for scene assembly only) — it is NOT a frozen hero shot and can never certify doneness. Assemble the 3D scene, capture a real Unity frame, then `loombridge design set --image <frame> --kind rendered-unity-frame --approve` and re-run (the composition → assemble → capture → freeze → fidelity flow, plan §3c).";

/** The on-disk Design Target facts the disk-truth refusal reads (a subset of DesignStatusReport). */
export interface DiskDesignTargetFacts {
  status: string;
  kind: string;
  /** The frozen sha recorded at approval; null when missing. */
  pngSha256?: string | null;
  /** True when the current hero-shot bytes still match the frozen hash. */
  frozenMatches: boolean;
}

/**
 * Disk-truth Design-Target refusals for the whole-game doneness path (§3c).
 *
 * INDEPENDENT of the verdict's self-reported `designTarget`, so a hand-edited
 * fresh/pass verdict that OMITS or MIS-BINDS that block cannot skip the
 * design-target moat. This COMPLEMENTS (never replaces) the verdict-driven
 * `checkHeroShotFidelity`:
 *  - an approved `composition-reference` on disk → always refuse (it is never a
 *    frozen hero shot);
 *  - an approved `rendered-unity-frame` on disk → the verdict MUST carry an
 *    approved `designTarget` bound to the SAME frozen sha (otherwise the
 *    hero-shot fidelity review was silently skipped — the P1 laundering hole),
 *    and the frozen bytes must still match (no post-approval tampering).
 *
 * Returns `[]` when there is NO approved Design Target on disk — a target
 * DELETED after verify is deliberately left to the verdict-driven path ONLY when
 * the run-bound verdict still carries the approved block, so fidelity still runs
 * and the deletion cannot escape. If STATE still says a Design Target was
 * approved but the disk target and verdict binding are both absent, refuse.
 * Pure + exhaustively testable.
 */
export function diskTruthDesignTargetRefusals(
  design: DiskDesignTargetFacts,
  verdict: VerdictLike | null,
  stateDesignTarget?: string | null,
): string[] {
  if (design.status !== "approved") {
    if (stateDesignTarget === "approved" && verdict?.designTarget?.status !== "approved") {
      return [
        "STATE says Design Target is `approved` but the on-disk design target is missing/unapproved and the verdict carries no approved `designTarget` binding — cannot prove hero-shot fidelity was evaluated; restore the target or re-run `loombridge verify` against the approved target (plan §3c/§P0.1)",
      ];
    }
    return [];
  }
  if (design.kind === "composition-reference") return [COMPOSITION_REFERENCE_REFUSAL];

  const reasons: string[] = [];
  const vdt = verdict?.designTarget;
  const bound =
    vdt?.status === "approved" &&
    typeof vdt.pngSha256 === "string" &&
    !!design.pngSha256 &&
    vdt.pngSha256 === design.pngSha256;
  if (!bound) {
    const sha = design.pngSha256 ? ` (sha \`${design.pngSha256.slice(0, 12)}…\`)` : "";
    reasons.push(
      `an approved Design Target (\`rendered-unity-frame\`) is on disk but the verdict carries no matching approved \`designTarget\` bound to the frozen hero shot${sha} — hero-shot fidelity was not evaluated; run \`loombridge verify\` against the approved target so the verdict binds it (plan §3c/§P0.1)`,
    );
  }
  if (!design.frozenMatches) {
    reasons.push(
      "approved Design Target changed since approval (frozen hash mismatch) — re-approve before certifying done",
    );
  }
  return reasons;
}

export function checkHeroShotFidelity(
  verdict: VerdictLike | null,
  criteria: readonly string[] = HERO_SHOT_FIDELITY_CRITERIA,
): string[] {
  // Absence of a verdict is reported by isFreshGreen; nothing to add here.
  if (!verdict) return [];
  const design = verdict.designTarget;
  // Only design-targeted builds are held to hero-shot fidelity.
  if (design?.status !== "approved") return [];

  // The 3D design-target split (§3c). An approved `composition-reference` is a
  // style/composition guide that only unlocks scene assembly — it is NOT a
  // frozen hero shot and can never satisfy final fidelity, no matter how good
  // the review looks. Refuse outright and point at the next step. Only an
  // EXPLICIT `composition-reference` is refused — an absent `kind` (pre-split
  // verdict, or a flat 2D mock that IS the final hero shot) is treated as a
  // frozen `rendered-unity-frame`, so existing 2D/platformer doneness is
  // unchanged.
  if (design.kind === "composition-reference") {
    return [COMPOSITION_REFERENCE_REFUSAL];
  }

  const reasons: string[] = [];
  const review = verdict.reviewFindings;
  if (!review || !Array.isArray(review.criteria)) {
    reasons.push(
      "design target is `approved` but the verdict carries no independent hero-shot review — run the VLM ensemble and `verify --vlm` (plan §P0.1/P0.5)",
    );
    return reasons; // nothing else to check without findings
  }

  // P0.1 — the review must have compared against the FROZEN hero shot, not contract
  // attributes (`references hero-shot.png:false` was the RUN-1 tell).
  const ref = review.reference?.heroShotSha256;
  if (!ref) {
    reasons.push(
      "VLM review has no `reference.heroShotSha256` — it did not record comparing against the hero-shot IMAGE (plan §P0.1)",
    );
  } else if (!design.pngSha256) {
    // The moat must not depend on a co-operating `verify` step. If the verdict
    // claims an approved Design Target but carries no frozen hash, the review
    // cannot be bound to it — refuse rather than accept an unbindable reference.
    // (A hand-crafted verdict is exactly the threat the supervisor defends.)
    reasons.push(
      "verdict `designTarget.pngSha256` is absent — cannot bind the review to a frozen hero shot; refusing (plan §P0.1)",
    );
  } else if (ref !== design.pngSha256) {
    reasons.push(
      `VLM review compared against sha256 \`${ref.slice(0, 12)}…\`, not the FROZEN hero shot \`${design.pngSha256.slice(0, 12)}…\` (stale/wrong reference — plan §P0.1)`,
    );
  }

  // P0.3 — independent, ≥2 fresh-context reviewers. A build-authored self-review
  // rubber-stamps its own divergence (the RUN-1 failure mode).
  const independence = review.independence;
  if (!independence?.independent) {
    reasons.push(
      "VLM review is not marked `independence.independent: true` — a build-authored self-review cannot certify (plan §P0.3)",
    );
  }
  if (!independence?.reviewerCount || independence.reviewerCount < 2) {
    reasons.push(
      `VLM review reviewerCount is \`${independence?.reviewerCount ?? "(absent)"}\`; need ≥2 independent reviewers (plan §P0.3)`,
    );
  }

  // P0.2 — every fidelity criterion must be PRESENT and `pass`. A missing
  // criterion means the review never judged that structure (spawn-only / didn't
  // look at parallax); a WARN/fail is a divergence that cannot self-accept.
  const byId = new Map(review.criteria.map((c) => [c.id, c] as const));
  for (const id of criteria) {
    const criterion = byId.get(id);
    if (!criterion) {
      reasons.push(
        `hero-shot fidelity criterion \`${id}\` is missing from the review (it was never judged against the hero shot — plan §P0.2)`,
      );
    } else if (criterion.status !== "pass") {
      const why = criterion.reason ? `: ${criterion.reason}` : "";
      reasons.push(
        `hero-shot fidelity criterion \`${id}\` is \`${criterion.status ?? "(absent)"}\`, must be \`pass\` (plan §P0.2)${why}`,
      );
    }
  }

  return reasons;
}

export function checkAssetSourceFidelity(verdict: VerdictLike | null): string[] {
  if (!verdict) return [];
  if (verdict.designTarget?.status !== "approved") return [];

  const checks = verdict.checks ?? [];
  const assetChecks = checks.filter((check) => typeof check.id === "string" && check.id.startsWith("asset-source."));
  if (assetChecks.length === 0) {
    return [
      "design target is `approved` but the verdict carries no asset-source fidelity checks — include `asset-manifest.json` in verification inputs so asset drift is judged separately from layout/composition drift",
    ];
  }

  return assetChecks
    .filter((check) => check.status === "fail")
    .map((check) => {
      const detail = check.detail ? `: ${check.detail}` : "";
      return `asset-source fidelity check \`${check.id ?? "(unknown)"}\` failed${detail}`;
    });
}

/**
 * The gray-box / feel-only resolution (RCL-D01). Decides — from DISK truth — whether
 * the doneness visual-fidelity gates are NOT-APPLICABLE, and collects the refusals
 * that keep the relaxation from being abused. PURE + exhaustively testable.
 *
 * Inputs are all from disk (the on-disk acceptance contract's `art.mode`, the on-disk
 * Design Target status) EXCEPT `verdictArtMode`, which is the value the build-verdict
 * CLAIMS — and is NEVER trusted to enable the relaxation. Two refusals guard it:
 *
 *  - LAUNDERING: a verdict that claims `art.mode:"deferred"` while the on-disk contract
 *    does NOT declare it is refused (mirrors `diskTruthDesignTargetRefusals`' STATE-vs-
 *    verdict mismatch rule — the contract is the disk truth, the verdict cannot forge it).
 *  - CONTRADICTION: a contract that declares `art:deferred` while an approved Design
 *    Target exists — whether ON DISK or asserted by the run-bound VERDICT/STATE — is
 *    refused. An approved hero shot means the build HAS real art intent, so it must NOT
 *    be allowed to skip the hero-shot moat. In that case `deferred` resolves to FALSE
 *    (the full fidelity gate still runs) AND the contradiction is reported, so the
 *    relaxation can never disable an existing moat. Considering the verdict/STATE claim
 *    — not just disk — closes the TOCTOU "disk-absent + verdict-approved" quadrant: an
 *    attacker cannot delete the on-disk target meta to fake `designApprovedOnDisk=false`
 *    on a verdict that itself carries an approved Design Target + a real review.
 *
 * `deferred` is true ONLY when the contract declares it AND NO approved Design Target
 * is asserted by disk OR the run-bound verdict/STATE.
 */
export function artModeRefusals(opts: {
  /** `art.mode` read from the on-disk acceptance contract (disk truth). */
  contractArtMode: string | undefined;
  /** `art.mode` the build-verdict claims (never trusted to ENABLE the relaxation). */
  verdictArtMode: string | undefined;
  /** True when an approved Design Target exists on disk. */
  designApprovedOnDisk: boolean;
  /**
   * True when the RUN-BOUND verdict (or the sticky STATE record) ITSELF asserts an
   * approved Design Target — a hero-shot-verified build. Feeding this in (not just
   * the on-disk status) closes the disk-absent + verdict-approved TOCTOU quadrant.
   */
  runtimeClaimsApprovedDesignTarget: boolean;
}): { deferred: boolean; refusals: string[] } {
  const contractDeferred = opts.contractArtMode === "deferred";
  const hasApprovedTarget = opts.designApprovedOnDisk || opts.runtimeClaimsApprovedDesignTarget;
  const refusals: string[] = [];

  if (opts.verdictArtMode === "deferred" && !contractDeferred) {
    refusals.push(
      "build-verdict claims `art.mode:\"deferred\"` but the on-disk acceptance contract does NOT declare it — refusing (the gray-box / feel-only relaxation is read from the contract on disk, never from the verdict; declare `art: { \"mode\": \"deferred\" }` in ACCEPTANCE.json — RCL-D01)",
    );
  }
  if (contractDeferred && hasApprovedTarget) {
    const where = [
      opts.designApprovedOnDisk ? "on disk" : null,
      opts.runtimeClaimsApprovedDesignTarget ? "in the run-bound verdict/STATE" : null,
    ].filter(Boolean).join(" and ");
    refusals.push(
      `acceptance contract declares \`art.mode:"deferred"\` (gray-box / feel-only) but an APPROVED Design Target exists (${where}) — these are mutually exclusive: a hero-shot-verified build has real art intent and CANNOT skip hero-shot fidelity. Remove the Design Target to stay gray-box, or set \`art.mode:"final"\` and certify against the frozen hero shot (RCL-D01). [closes the disk-absent + verdict-approved TOCTOU quadrant]`,
    );
  }

  return { deferred: contractDeferred && !hasApprovedTarget, refusals };
}

/**
 * Read `art.mode` from the on-disk acceptance contract (RCL-D01). Tolerant +
 * FAIL-CLOSED: any read/parse error, or an absent/non-string `art.mode`, returns
 * `undefined` — which the caller treats as `final` (full fidelity enforcement),
 * the stricter default. So a malformed contract can never silently enable the
 * gray-box relaxation.
 */
export async function readDeclaredArtMode(acceptancePath: string): Promise<string | undefined> {
  try {
    const parsed = JSON.parse(await fs.readFile(acceptancePath, "utf-8")) as unknown;
    if (parsed && typeof parsed === "object") {
      const art = (parsed as { art?: unknown }).art;
      if (art && typeof art === "object") {
        const mode = (art as { mode?: unknown }).mode;
        if (typeof mode === "string") return mode;
      }
    }
  } catch {
    // fall through → undefined (final)
  }
  return undefined;
}

/**
 * The result of reading `verification.requiredEvidenceClasses` from disk: either
 * the declared list (possibly empty — no gate), or a FAIL-CLOSED sentinel when
 * the contract FILE EXISTS but cannot be read/parsed, or the field is present but
 * malformed. The sentinel forces an explicit refusal downstream — a truncated /
 * hand-corrupted ACCEPTANCE.json must never silently DISARM a previously-declared
 * evidence gate (the polarity mirror of `readDeclaredArtMode`'s "malformed can
 * never ENABLE the relaxation").
 */
export type RequiredEvidenceClassesRead = string[] | { unreadable: string };

/**
 * Read `verification.requiredEvidenceClasses` from the on-disk acceptance
 * contract (dogfood learnings §6 / High #7). DISK-TRUTH, mirroring `readDeclaredArtMode`:
 * the gate is declared by the contract on disk, NEVER by the run-bound verdict, so
 * a hand-edited verdict cannot launder past it. FAIL-CLOSED on a PRESENT-but-bad
 * contract: a file that exists but does not parse, or a `requiredEvidenceClasses`
 * field that is not an array of strings, returns the `{ unreadable }` sentinel
 * (→ explicit refusal), because a malformed file could be hiding a declared gate.
 * By-design opt-outs stay opt-outs: an ABSENT contract file (ENOENT — other
 * doneness layers own that refusal) or a VALID contract without the field returns
 * `[]` (no new gate — backward compat). An unknown class NAME that survives to
 * here (a hand-edited contract that skipped validation) is REFUSED by
 * `evidenceClassRefusals`, not dropped.
 */
export async function readRequiredEvidenceClasses(
  acceptancePath: string,
): Promise<RequiredEvidenceClassesRead> {
  let raw: string;
  try {
    raw = await fs.readFile(acceptancePath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    return { unreadable: `contract could not be read (${(error as Error).message})` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return { unreadable: "contract exists but does not parse as JSON" };
  }
  if (!parsed || typeof parsed !== "object") {
    return { unreadable: "contract exists but is not a JSON object" };
  }
  const verification = (parsed as { verification?: unknown }).verification;
  if (!verification || typeof verification !== "object") return [];
  const required = (verification as { requiredEvidenceClasses?: unknown }).requiredEvidenceClasses;
  if (required === undefined) return [];
  if (!Array.isArray(required) || required.some((c) => typeof c !== "string")) {
    return {
      unreadable:
        "verification.requiredEvidenceClasses is declared but malformed (must be an array of evidence-class names)",
    };
  }
  return required as string[];
}

/**
 * The result of reading `verification.sfx` from disk: the declared enablement, or a
 * FAIL-CLOSED sentinel when the contract file exists but cannot be read/parsed, or the
 * `sfx` section is present but malformed (same polarity as
 * `readRequiredEvidenceClasses`: a corrupt contract must never silently DISARM a
 * previously-declared SFX verification gate).
 */
export type SfxDeclarationRead = { enabled: boolean } | { unreadable: string };

/**
 * Read `verification.sfx` from the ON-DISK acceptance contract (SFX dogfood #7 / review
 * D1). DISK-TRUTH, mirroring `readDeclaredArtMode` / `readRequiredEvidenceClasses`: the
 * SFX verification gate is declared by the contract on disk, never by the run-bound
 * verdict, so the bypass "enable sfx → never produce captures → flip enabled:false →
 * re-verify → green" is closed at doneness: when disk says `enabled:true`, the bound
 * verdict must have GRADED the SFX gates (see `sfxGateRefusals`).
 *
 * RESIDUAL BY-DESIGN OPT-OUT (honest): DISABLING `verification.sfx` in the disk
 * contract itself is spec-editing — like deleting `requiredEvidenceClasses` — and is
 * not laundering; this gate closes the verdict-vs-disk divergence, not spec changes.
 *
 * FAIL-CLOSED on a PRESENT-but-bad contract: unparseable file, non-object root, or an
 * `sfx` section that is present but malformed (non-object, or `enabled` not a boolean)
 * returns the `{ unreadable }` sentinel → an explicit refusal downstream. By-design
 * opt-outs stay opt-outs: ENOENT (other doneness layers own the missing-contract
 * refusal), an absent `verification`/`sfx` section, or `enabled:false` all read
 * `{ enabled: false }` (no new gate — backward compat).
 */
export async function readDeclaredSfxVerification(
  acceptancePath: string,
): Promise<SfxDeclarationRead> {
  let raw: string;
  try {
    raw = await fs.readFile(acceptancePath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { enabled: false };
    return { unreadable: `contract could not be read (${(error as Error).message})` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return { unreadable: "contract exists but does not parse as JSON" };
  }
  if (!parsed || typeof parsed !== "object") {
    return { unreadable: "contract exists but is not a JSON object" };
  }
  const verification = (parsed as { verification?: unknown }).verification;
  if (!verification || typeof verification !== "object") return { enabled: false };
  const sfx = (verification as { sfx?: unknown }).sfx;
  if (sfx === undefined) return { enabled: false };
  if (!sfx || typeof sfx !== "object" || Array.isArray(sfx)) {
    return { unreadable: "verification.sfx is declared but malformed (must be an object)" };
  }
  const enabled = (sfx as { enabled?: unknown }).enabled;
  if (typeof enabled !== "boolean") {
    return {
      unreadable: "verification.sfx is declared but malformed (`enabled` must be a boolean)",
    };
  }
  return { enabled };
}

/**
 * Disk-truth SFX enforcement at doneness (SFX dogfood #7 / review D1): when the
 * ON-DISK contract declares `verification.sfx.enabled: true`, the run-bound verdict
 * must carry gate reports for ALL FOUR SFX gates (`sfx-presence` / `sfx-runtime` /
 * `inputToSfxLatency` / `sfx-fatigue`) — proof `loombridge verify` actually GRADED the
 * declared SFX surface. A verdict with no `gates` block, or one missing any SFX gate,
 * earns a union refusal ("re-verify"), never a skip. This is deliberately a
 * GRADED-not-GREEN check: a blocked/warn/fail SFX gate still counts as graded here —
 * its verdict already feeds the Tier-1 status; what this closes is the divergence
 * where the verdict predates (or laundered away) the SFX declaration entirely.
 * An `{ unreadable }` contract read is an explicit refusal (fail-closed).
 * Pure; refusals ADD (union). Returns `[]` when disk declares no SFX verification.
 */
export function sfxGateRefusals(
  declared: SfxDeclarationRead,
  verdict: VerdictLike | null,
): string[] {
  if ("unreadable" in declared) {
    return [
      `contract unreadable — cannot determine whether SFX verification is declared (${declared.unreadable}); a malformed contract must not disarm a declared SFX gate; refusing (fix .loombridge/ACCEPTANCE.json — SFX-dogfood #7/D1)`,
    ];
  }
  if (!declared.enabled) return [];
  const gates = verdict?.gates;
  if (!gates || typeof gates !== "object" || Array.isArray(gates)) {
    return [
      "contract declares SFX verification (verification.sfx.enabled) but the verdict graded no SFX gates (no usable `gates` block) — re-run `loombridge verify` so the SFX gates are graded (SFX-dogfood #7/D1)",
    ];
  }
  const reasons: string[] = [];
  for (const gate of SFX_GATE_NAMES) {
    if (typeof gates[gate] !== "string") {
      reasons.push(
        `contract declares SFX verification (verification.sfx.enabled) but the verdict carries no \`${gate}\` gate report — the SFX surface was not graded by this verify run; re-run \`loombridge verify\` (SFX-dogfood #7/D1)`,
      );
    }
  }
  return reasons;
}

/**
 * The anti-compression refusals (dogfood learnings §6 / High #7): for each contract-declared
 * required evidence class, the run-bound verdict's `evidenceClasses` block MUST
 * report that class as `"present"` — AND that `present` must AGREE with a
 * re-derivation from the verdict's OWN `gates`+`checks` — or doneness REFUSES.
 *
 * Refuse-not-skip discipline (mirrors `diskTruthDesignTargetRefusals`): an
 * OMITTED block, an OMITTED class, an `absent`/`partial` status, or an
 * unrecognised status are each a distinct refusal — never a silent skip. An
 * unknown required class name (survived from a hand-edited contract) is also
 * refused (it can never be satisfied). An `{ unreadable }` contract read is an
 * explicit refusal (fail-closed — a corrupt contract cannot disarm the gate).
 *
 * ANTI-SELF-ATTESTATION (the stored block is data inside the same file it
 * certifies): a stored `present` is only trusted when re-deriving the class from
 * the verdict's own gate statuses + checks ALSO yields `present` — the stricter
 * of (stored, re-derived) wins, so one hand-edited `evidenceClasses` field cannot
 * claim a signal the verdict's own gate data never gathered. A verdict carrying
 * no usable `gates` object cannot be re-derived → refusal, not a skip. (Forging
 * the gates map itself is out of this check's scope — that is the run-binding /
 * freshness / Tier-1-status moat's territory.)
 *
 * NOTE on `present` semantics: "the capture was collected and its gate evaluated
 * it" — it inherits the verifier's existing trust in capture files; a
 * hollow-but-parseable capture is caught by the producing gate's own evaluator
 * (failing/warning the Tier-1 status), not by the evidence class.
 *
 * Pure + exhaustively testable; refusals ADD (union), they never override.
 * Returns `[]` when the contract declares no required classes (backward compat).
 */
export function evidenceClassRefusals(
  requiredEvidenceClasses: RequiredEvidenceClassesRead,
  verdict: VerdictLike | null,
): string[] {
  if (!Array.isArray(requiredEvidenceClasses)) {
    return [
      `contract unreadable — cannot determine required evidence classes (${requiredEvidenceClasses.unreadable}); a malformed contract must not disarm a declared evidence gate; refusing (fix .loombridge/ACCEPTANCE.json — dogfood §6/#7)`,
    ];
  }
  if (requiredEvidenceClasses.length === 0) return [];
  const reasons: string[] = [];
  const block = verdict?.evidenceClasses;
  // Re-derive ONCE from the verdict's own gates+checks (null ⇒ cannot re-derive).
  const rederived = verdict
    ? deriveEvidenceClassesFromUntrusted(verdict.gates, verdict.checks)
    : null;
  // De-dup while preserving declaration order.
  const seen = new Set<string>();
  for (const cls of requiredEvidenceClasses) {
    if (seen.has(cls)) continue;
    seen.add(cls);
    if (!EVIDENCE_CLASS_SET.has(cls)) {
      reasons.push(
        `contract requires unknown evidence class \`${cls}\` — not a member of the fixed evidence-class enum; refusing (fix the contract's verification.requiredEvidenceClasses — dogfood §6/#7)`,
      );
      continue;
    }
    if (!block) {
      reasons.push(
        `contract requires evidence class \`${cls}\` to be \`present\` but the verdict has NO \`evidenceClasses\` block — cannot prove the signal was gathered; refusing (re-run \`loombridge verify\` — dogfood §6/#7)`,
      );
      continue;
    }
    const entry = block[cls];
    if (!entry || typeof entry.status !== "string") {
      reasons.push(
        `contract requires evidence class \`${cls}\` to be \`present\` but the verdict's evidenceClasses omits it (or gives no status) — an absent binding is a refusal, not a skip (dogfood learnings §6/#7)`,
      );
      continue;
    }
    if (entry.status !== "present") {
      const status = entry.status as EvidenceClassStatus | string;
      const src = entry.source ? ` (source: ${entry.source})` : "";
      reasons.push(
        `contract requires evidence class \`${cls}\` to be \`present\` but the verdict reports it \`${status}\`${src} — "console clean" must not imply "playtest verified"; refusing (dogfood learnings §6/#7)`,
      );
      continue;
    }
    // Stored `present` — verify it against the re-derivation (stricter wins).
    if (!rederived) {
      reasons.push(
        `contract requires evidence class \`${cls}\` and the verdict's evidenceClasses claims \`present\`, but the verdict carries no usable \`gates\` block to re-derive it from — a stored block cannot self-attest; refusing (re-run \`loombridge verify\` — dogfood §6/#7)`,
      );
      continue;
    }
    const truth = rederived[cls as EvidenceClassName];
    if (truth.status !== "present") {
      reasons.push(
        `evidenceClasses.${cls} claims \`present\` but re-derivation from this verdict's own gates yields \`${truth.status}\` (${truth.source}) — the block does not match its own evidence; refusing (dogfood learnings §6/#7)`,
      );
    }
  }
  return reasons;
}

export interface CaptureCheck {
  /** Path relative to `.loombridge/verify/` (the captureManifest entry). */
  path: string;
  exists: boolean;
  /**
   * True when this entry failed the safe-path check (absolute / `..` /
   * non-canonical) OR when its resolved absolute path escaped
   * `.loombridge/verify/`. Surfaced as a distinct hard failure — counting it
   * silently as "missing" would hide path-traversal contracts.
   */
  unsafe?: boolean;
}

export interface FreshGreenInput {
  state: LoombridgeState | null;
  verdict: VerdictLike | null;
  captures: CaptureCheck[];
  /**
   * Gray-box / feel-only mode (RCL-D01). When true (resolved by the caller from
   * the on-disk acceptance contract — NOT from the verdict), the hero-shot
   * fidelity + asset-source fidelity checks are NOT-APPLICABLE: doneness is
   * satisfied by the fresh+green Tier-1 verdict (feel bands + structural
   * assertions) + captures alone. Every other freshness/run-binding check is
   * unchanged, so a stale/forged/non-passing verdict still fails.
   */
  artDeferred?: boolean;
}

export interface FreshGreenResult {
  ok: boolean;
  /** Empty when ok; otherwise human-readable failure reasons (all of them). */
  reasons: string[];
}

export interface SliceDoneResult {
  ok: boolean;
  reasons: string[];
}

const VLM_REVIEW_TOP_KEYS = new Set(["reference", "independence", "frames", "criteria", "summary"]);
const VLM_REVIEW_REFERENCE_KEYS = new Set(["heroShot", "heroShotSha256"]);
const VLM_REVIEW_INDEPENDENCE_KEYS = new Set(["independent", "reviewerCount"]);
const VLM_REVIEW_FRAME_KEYS = new Set(["id", "path", "label"]);
const VLM_REVIEW_CRITERION_KEYS = new Set(["id", "status", "reason", "evidenceFrame"]);
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
const VLM_REVIEW_STATUSES = new Set(["pass", "warn", "fail"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateNoExtraKeys(value: Record<string, unknown>, allowed: Set<string>, pathLabel: string, issues: string[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) issues.push(`${pathLabel} has unsupported field \`${key}\``);
  }
}

function validateStringField(value: Record<string, unknown>, key: string, pathLabel: string, issues: string[], required = false): void {
  const field = value[key];
  if (field === undefined) {
    if (required) issues.push(`${pathLabel}.${key} is required`);
    return;
  }
  if (typeof field !== "string" || field.trim().length === 0) {
    issues.push(`${pathLabel}.${key} must be a non-empty string`);
  }
}

/**
 * Strict shape check for `.loombridge/verify/vlm-review.json`.
 *
 * The schema is product-owned, but the file is agent-authored. Validate the
 * contract before reading it as evidence so a plausible custom object cannot
 * collapse into the vague "no independent review" refusal.
 */
export function validateVlmReviewFindingsShape(input: unknown): string[] {
  const issues: string[] = [];
  if (!isRecord(input)) return ["vlm-review.json must be an object"];

  validateNoExtraKeys(input, VLM_REVIEW_TOP_KEYS, "vlm-review.json", issues);

  if (input.reference !== undefined) {
    if (!isRecord(input.reference)) {
      issues.push("vlm-review.json.reference must be an object");
    } else {
      validateNoExtraKeys(input.reference, VLM_REVIEW_REFERENCE_KEYS, "vlm-review.json.reference", issues);
      validateStringField(input.reference, "heroShot", "vlm-review.json.reference", issues);
      validateStringField(input.reference, "heroShotSha256", "vlm-review.json.reference", issues);
    }
  }

  if (input.independence !== undefined) {
    if (!isRecord(input.independence)) {
      issues.push("vlm-review.json.independence must be an object");
    } else {
      validateNoExtraKeys(input.independence, VLM_REVIEW_INDEPENDENCE_KEYS, "vlm-review.json.independence", issues);
      if (input.independence.independent !== undefined && typeof input.independence.independent !== "boolean") {
        issues.push("vlm-review.json.independence.independent must be a boolean");
      }
      const count = input.independence.reviewerCount;
      if (count !== undefined && (!Number.isInteger(count) || (count as number) < 1)) {
        issues.push("vlm-review.json.independence.reviewerCount must be an integer >= 1");
      }
    }
  }

  if (!Array.isArray(input.frames)) {
    issues.push("vlm-review.json.frames must be an array of { id, path }");
  } else {
    input.frames.forEach((frame, index) => {
      const p = `vlm-review.json.frames[${index}]`;
      if (!isRecord(frame)) {
        issues.push(`${p} must be an object`);
        return;
      }
      validateNoExtraKeys(frame, VLM_REVIEW_FRAME_KEYS, p, issues);
      validateStringField(frame, "id", p, issues, true);
      validateStringField(frame, "path", p, issues, true);
      validateStringField(frame, "label", p, issues);
    });
  }

  if (!Array.isArray(input.criteria)) {
    const actual = isRecord(input.criteria) ? "an object map" : `\`${input.criteria === undefined ? "absent" : typeof input.criteria}\``;
    issues.push(`vlm-review.json.criteria must be an array of { id, status, reason, evidenceFrame? }, not ${actual}`);
  } else {
    input.criteria.forEach((criterion, index) => {
      const p = `vlm-review.json.criteria[${index}]`;
      if (!isRecord(criterion)) {
        issues.push(`${p} must be an object`);
        return;
      }
      validateNoExtraKeys(criterion, VLM_REVIEW_CRITERION_KEYS, p, issues);
      validateStringField(criterion, "id", p, issues, true);
      validateStringField(criterion, "status", p, issues, true);
      validateStringField(criterion, "reason", p, issues, true);
      validateStringField(criterion, "evidenceFrame", p, issues);
      if (typeof criterion.id === "string" && !VLM_REVIEW_CRITERION_IDS.has(criterion.id)) {
        issues.push(`${p}.id \`${criterion.id}\` is not a known VLM review criterion`);
      }
      if (typeof criterion.status === "string" && !VLM_REVIEW_STATUSES.has(criterion.status)) {
        issues.push(`${p}.status must be pass|warn|fail`);
      }
    });
  }

  validateStringField(input, "summary", "vlm-review.json", issues, true);
  return issues;
}

async function checkSliceRollupHeroShotFidelity(paths: LoombridgePaths): Promise<string[]> {
  const design = await designStatus(paths);
  if (design.status !== "approved") return [];
  if (!design.frozenMatches) {
    return ["approved Design Target changed since approval (frozen hash mismatch) — re-approve before certifying done"];
  }

  const reviewPath = path.join(paths.verifyInputs, "vlm-review.json");
  let review: VerdictReviewFindings | null = null;
  try {
    const parsed = JSON.parse(await fs.readFile(reviewPath, "utf-8")) as unknown;
    const shapeIssues = validateVlmReviewFindingsShape(parsed);
    if (shapeIssues.length) {
      return [
        `vlm-review.json exists but does not match the product-owned schema (${path.relative(paths.root, reviewPath)})`,
        ...shapeIssues,
      ];
    }
    review = parsed as VerdictReviewFindings;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  // Design Target is approved here (gated above), so an unregistered genre is a hard refusal — the
  // criteria must come from the build's registered genre, never the platformer default.
  const state = await readState(paths);
  const fidelity = fidelityCriteriaForGenre(state?.genre ?? "unknown");
  if (!("criteria" in fidelity)) return [fidelity.refusal];

  return checkHeroShotFidelity(
    {
      status: "pass",
      designTarget: {
        status: design.status,
        // Read from disk (designStatus), so a composition-reference cannot be
        // laundered into "final" by omitting `kind` from a hand-edited verdict.
        kind: design.kind,
        pngSha256: design.pngSha256 ?? null,
        frozenMatches: design.frozenMatches,
      },
      ...(review ? { reviewFindings: review } : {}),
    },
    fidelity.criteria,
  );
}

async function checkSliceRollupAssetSourceFidelity(paths: LoombridgePaths): Promise<string[]> {
  const design = await designStatus(paths);
  if (design.status !== "approved") return [];

  try {
    const manifest = await readAssetManifest(paths);
    if (!manifest) {
      return ["approved Design Target requires `.loombridge/ASSET_MANIFEST.json`; source fidelity cannot be certified without manifest bindings"];
    }
    resolveAllSliceAssetBindings(manifest);
    return [];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return [`asset manifest source bindings are not certifiable: ${message}`];
  }
}

/**
 * The freshness predicate. Pure + exhaustively unit-testable: returns ok only
 * when phase === verified-green AND verdict.runId === currentBuild.runId AND
 * verdict.producedAt >= currentBuild.startedAt AND every captureManifest entry
 * is present. ALL failure reasons are collected (not short-circuited) so a
 * single run reports everything wrong with a "done" claim.
 */
export function isFreshGreen(input: FreshGreenInput): FreshGreenResult {
  const reasons: string[] = [];
  const { state, verdict, captures } = input;

  if (!state) {
    return { ok: false, reasons: ["no .loombridge/STATE.md (run `loombridge plan` first)"] };
  }

  if (state.phase !== "verified-green") {
    reasons.push(`phase is \`${state.phase}\`, not \`verified-green\``);
  }
  if (!state.currentBuild) {
    reasons.push("no `currentBuild` in STATE — no build is in flight (run `loombridge build` first)");
  } else if (state.currentBuild.ungrounded) {
    reasons.push(
      "currentBuild is `ungrounded` — started with --allow-ungrounded-prototype (no approved Design Target); disqualified from any `done` claim (plan §3c)",
    );
  }
  if (!verdict) {
    reasons.push("no verdict at .loombridge/reports/build-verdict.json");
  } else if (verdict.status !== "pass") {
    reasons.push(`verdict.status is \`${verdict.status ?? "(absent)"}\`, not \`pass\``);
  }

  // Run-binding — the verdict must belong to *this* build.
  if (state.currentBuild && verdict) {
    if (!verdict.runId) {
      reasons.push(
        "verdict has no `runId` — likely produced before `loombridge build` minted `currentBuild` (stale)",
      );
    } else if (verdict.runId !== state.currentBuild.runId) {
      reasons.push(
        `verdict.runId \`${verdict.runId}\` ≠ currentBuild.runId \`${state.currentBuild.runId}\` (stale)`,
      );
    }
    // Freshness — a missing producedAt cannot be on/after startedAt; refuse,
    // don't quietly skip. (Same defensive failure for a corrupt currentBuild
    // missing startedAt.)
    if (!verdict.producedAt) {
      reasons.push(
        "verdict has no `producedAt` — cannot establish freshness against currentBuild.startedAt (refusing)",
      );
    } else if (!state.currentBuild.startedAt) {
      reasons.push(
        "currentBuild has no `startedAt` — cannot establish freshness (corrupt state)",
      );
    } else if (verdict.producedAt < state.currentBuild.startedAt) {
      reasons.push(
        `verdict.producedAt \`${verdict.producedAt}\` is BEFORE currentBuild.startedAt \`${state.currentBuild.startedAt}\``,
      );
    }
  }

  // Capture safety + completeness — every entry must be safe AND must exist.
  // Unsafe entries are reported as a distinct hard failure (NOT silently
  // collapsed into "missing") so a hand-edited STATE.md cannot smuggle a path-
  // traversal manifest past the gate.
  const unsafe = captures.filter((c) => c.unsafe).map((c) => c.path);
  if (unsafe.length) {
    reasons.push(
      `captureManifest has UNSAFE entries (path traversal refused — §3a): ${unsafe.join(", ")}`,
    );
  }
  const missing = captures.filter((c) => !c.unsafe && !c.exists).map((c) => c.path);
  if (missing.length) {
    reasons.push(`missing captureManifest entries: ${missing.join(", ")}`);
  }

  // Hero-shot + asset-source fidelity — for a design-targeted build, "done" means
  // "matches the frozen hero shot" via an independent review, not merely "green +
  // fresh" (plan §P0). N/A (no reasons) when there is no approved Design Target.
  // The criteria are resolved per-genre via the registry; an UNREGISTERED genre
  // is a REFUSAL for a design-targeted build, never a silent fallback to
  // platformer.
  //
  // GRAY-BOX (RCL-D01): when the on-disk acceptance contract declares
  // `art.mode:"deferred"` (resolved into `artDeferred` by the caller), BOTH
  // visual-fidelity gates are NOT-APPLICABLE. The feel bands + structural
  // assertions are still enforced through `verdict.status === "pass"` above, so
  // this never blanket-passes.
  //
  // DEFENSE-IN-DEPTH against the TOCTOU bypass: art:deferred is INCOHERENT with a
  // run-bound verdict that itself claims an approved Design Target (a
  // hero-shot-verified build). Even if a caller passes `artDeferred:true` here,
  // REFUSE to skip fidelity in that case and report the contradiction — the
  // relaxation must never disable an existing hero-shot moat. (The primary guard
  // is `artModeRefusals`, which already resolves `deferred=false` here; this is a
  // second, self-contained layer so `isFreshGreen` cannot be tricked in isolation.)
  const verdictClaimsApprovedTarget = verdict?.designTarget?.status === "approved";
  if (input.artDeferred && verdictClaimsApprovedTarget) {
    reasons.push(
      "art:deferred relaxation REFUSED — the run-bound verdict itself claims an approved Design Target; a hero-shot-verified build cannot skip fidelity via art:deferred (RCL-D01)",
    );
  }
  const artDeferred = !!input.artDeferred && !verdictClaimsApprovedTarget;
  if (!artDeferred) {
    const fidelity = fidelityCriteriaForGenre(state.genre);
    if ("criteria" in fidelity) {
      reasons.push(...checkHeroShotFidelity(verdict, fidelity.criteria));
    } else if (verdict?.designTarget?.status === "approved") {
      reasons.push(fidelity.refusal);
    }
    reasons.push(...checkAssetSourceFidelity(verdict));
  }

  return { ok: reasons.length === 0, reasons };
}

/**
 * Per-slice deterministic doneness. This intentionally does NOT call
 * checkHeroShotFidelity: the whole-scene fidelity moat is enforced once, at the
 * slice roll-up, while per-slice S2c certifies fresh+green+captures+run binding.
 */
export async function isSliceDone(slice: SliceEntry, paths: LoombridgePaths): Promise<SliceDoneResult> {
  const reasons: string[] = [];
  const proof = slice.proof;
  let verdict: VerdictLike | null = null;

  if (!proof) {
    reasons.push("not built (slice.proof is absent)");
  } else {
    if (!proof.runId) reasons.push("slice.proof.runId is missing");
    if (!proof.startedAt) reasons.push("slice.proof.startedAt is missing");
    if (!proof.verdictPath) {
      reasons.push("slice.proof.verdictPath is missing");
    } else {
      const verdictPath = path.isAbsolute(proof.verdictPath)
        ? proof.verdictPath
        : path.resolve(paths.root, proof.verdictPath);
      try {
        verdict = JSON.parse(await fs.readFile(verdictPath, "utf-8")) as VerdictLike;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          reasons.push(`no verdict at ${proof.verdictPath}`);
        } else {
          throw error;
        }
      }
    }

    if (verdict) {
      if (!verdict.runId) {
        reasons.push("verdict.runId is missing");
      } else if (proof.runId && verdict.runId !== proof.runId) {
        reasons.push(`verdict.runId \`${verdict.runId}\` != slice.proof.runId \`${proof.runId}\``);
      }
      if (!verdict.producedAt) {
        reasons.push("verdict.producedAt is missing");
      } else if (proof.startedAt && verdict.producedAt < proof.startedAt) {
        reasons.push(`verdict.producedAt \`${verdict.producedAt}\` is BEFORE slice.proof.startedAt \`${proof.startedAt}\``);
      }
      if (verdict.status !== "pass") {
        reasons.push(`verdict.status is \`${verdict.status ?? "(absent)"}\`, not \`pass\``);
      }
    }

    const manifest = proof.captureManifest ?? [];
    const sliceVerifyDirAbs = path.resolve(getSliceVerifyDir(paths, slice.id));
    const verifyDirAbs = path.resolve(paths.verifyInputs);
    const unsafe: string[] = [];
    const missing: string[] = [];
    for (const entry of manifest) {
      if (!isSafeCapturePath(entry)) {
        unsafe.push(entry);
        continue;
      }
      const candidate = path.resolve(paths.verifyInputs, entry);
      if (!isWithin(verifyDirAbs, candidate) || !isWithin(sliceVerifyDirAbs, candidate)) {
        unsafe.push(entry);
        continue;
      }
      if (!(await fileExists(candidate))) missing.push(entry);
    }
    if (unsafe.length) {
      reasons.push(`slice.proof.captureManifest has UNSAFE entries: ${unsafe.join(", ")}`);
    }
    if (missing.length) {
      reasons.push(`missing slice captureManifest entries: ${missing.join(", ")}`);
    }
  }

  if (slice.state !== "verified" && slice.state !== "approved") {
    reasons.push(`slice.state is \`${slice.state}\`, not \`verified\` or \`approved\``);
  }

  return { ok: reasons.length === 0, reasons };
}

export interface DonenessArgs {
  root: string;
  /** Override the verdict path (default: `.loombridge/reports/build-verdict.json`). */
  verdictPath?: string;
}

/**
 * The whole-game (non-slice) doneness reasons — the §3a freshness gate. Reads
 * STATE + the build verdict, runs `isFreshGreen` (runId-bound, fresh, captures
 * present) and the disk-truth Design-Target refusals. PURE of console output, so
 * BOTH `runDoneness` (CLI print + exit) and `isProjectDone` (boolean for the
 * bridge `loombridge_status`) consume the exact same predicate — `verifiedGreen`
 * can never drift from what `doneness` certifies. Exported for tests.
 */
export async function wholeGameDonenessReasons(
  paths: LoombridgePaths,
  verdictPathOverride?: string,
): Promise<{ reasons: string[]; state: LoombridgeState | null; verdict: VerdictLike | null; manifestCount: number; artDeferred: boolean }> {
  const state = await readState(paths);
  const verdictPath = verdictPathOverride ?? paths.verdict;

  let verdict: VerdictLike | null = null;
  try {
    verdict = JSON.parse(await fs.readFile(verdictPath, "utf-8")) as VerdictLike;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const manifest = state?.currentBuild?.captureManifest ?? [];
  const verifyDirAbs = path.resolve(paths.verifyInputs);
  const captures: CaptureCheck[] = await Promise.all(
    manifest.map(async (entry) => {
      // First gate: the raw entry must be a normalized, relative, non-`..` path.
      if (!isSafeCapturePath(entry)) {
        return { path: entry, exists: false, unsafe: true };
      }
      // Second gate: even after `path.resolve`, the result MUST live inside
      // `.loombridge/verify/`. This catches edge cases (symlinks, future ifs).
      const candidate = path.resolve(paths.verifyInputs, entry);
      if (!isWithin(verifyDirAbs, candidate)) {
        return { path: entry, exists: false, unsafe: true };
      }
      return { path: entry, exists: await fileExists(candidate) };
    }),
  );

  // Gray-box / feel-only resolution (RCL-D01) — read from DISK truth (the on-disk
  // acceptance contract's `art.mode` + the on-disk Design Target), never from the
  // verdict. `artModeRefusals` also emits the anti-laundering + contradiction
  // refusals; `deferred` is true ONLY when the contract declares it AND no
  // approved Design Target exists.
  const design = await designStatus(paths);
  const contractArtMode = await readDeclaredArtMode(paths.acceptance);
  const art = artModeRefusals({
    contractArtMode,
    verdictArtMode: verdict?.art?.mode,
    designApprovedOnDisk: design.status === "approved",
    // Close the disk-absent + verdict-approved TOCTOU quadrant: an approved
    // Design Target asserted by the run-bound verdict OR the sticky STATE record
    // (deleting the on-disk meta does NOT erase either) is a contradiction with
    // art:deferred.
    runtimeClaimsApprovedDesignTarget:
      verdict?.designTarget?.status === "approved" || state?.designTarget === "approved",
  });

  const result = isFreshGreen({ state, verdict, captures, artDeferred: art.deferred });
  const reasons = [...result.reasons];

  // Disk-truth Design-Target refusals (§3c) — INDEPENDENT of the verdict, so a
  // forged or absent `verdict.designTarget` cannot skip the design-target moat.
  // The on-disk `design-target.json` is authoritative for whether a target is an
  // approved composition-reference (never certifiable) OR an approved
  // rendered-unity-frame the verdict must bind to the frozen sha (else fidelity
  // was silently skipped — the P1 omitted-`designTarget` laundering hole). This
  // ADDS refusals; it never overrides the verdict's run-bound block, so a target
  // deleted after verify is still caught by the verdict-driven fidelity check.
  // Mirrors the slice roll-up, which reads the target from disk. Always run: when
  // `art.deferred` is true there is no approved Design Target (the contradiction
  // is refused above), so this is a no-op except for the STATE-mismatch safety
  // refusal — which still applies.
  for (const r of diskTruthDesignTargetRefusals(design, verdict, state?.designTarget)) {
    if (!reasons.some((existing) => existing === r)) reasons.push(r);
  }
  for (const r of art.refusals) {
    if (!reasons.some((existing) => existing === r)) reasons.push(r);
  }

  // Anti-compression evidence gate (dogfood learnings §6 / High #7) — read the REQUIRED
  // classes from the on-disk contract (disk-truth, like art.mode), then refuse
  // unless the run-bound verdict reports every one as `present`. ADDS refusals
  // (union); an absent block/class/status is a refusal, never a skip. Absent
  // requiredEvidenceClasses ⇒ no new gate (backward compat).
  const requiredEvidenceClasses = await readRequiredEvidenceClasses(paths.acceptance);
  for (const r of evidenceClassRefusals(requiredEvidenceClasses, verdict)) {
    if (!reasons.some((existing) => existing === r)) reasons.push(r);
  }

  // Disk-truth SFX gate (SFX dogfood #7 / review D1) — when the on-disk contract
  // declares verification.sfx.enabled, the run-bound verdict must have GRADED all
  // four SFX gates (blocked/warn counts as graded — its status already feeds Tier-1).
  // Closes the "enable sfx → never capture → flip enabled:false → re-verify" bypass:
  // ADDS refusals (union); a malformed sfx section is an explicit fail-closed refusal.
  const sfxDeclared = await readDeclaredSfxVerification(paths.acceptance);
  for (const r of sfxGateRefusals(sfxDeclared, verdict)) {
    if (!reasons.some((existing) => existing === r)) reasons.push(r);
  }

  return { reasons, state, verdict, manifestCount: manifest.length, artDeferred: art.deferred };
}

/** A single slice's roll-up line (computed once, printed by `runSliceDoneness`). */
interface SliceRollupLine {
  id: string;
  state: string;
  approved: boolean;
  passed: boolean;
  reasons: string[];
}

/** The slice roll-up evaluation, PURE of console output. Exported for tests. */
export interface SliceRollupEvaluation {
  emptyRoadmap: boolean;
  slices: SliceRollupLine[];
  depRefusals: Array<{ id: string; dep: string }>;
  fidelityReasons: string[];
  assetFidelityReasons: string[];
  /** Gray-box / feel-only refusals (laundering / contradiction — RCL-D01). */
  artRefusals: string[];
  /** True when the hero-shot + asset-source fidelity rollups are N/A (gray-box). */
  artDeferred: boolean;
  ok: boolean;
}

/**
 * Evaluate the slice doneness roll-up without printing. The accumulation order
 * matches the prior inline implementation exactly, so `runSliceDoneness` renders
 * byte-identical CLI output while `isProjectDone` reuses `.ok`.
 */
export async function evaluateSliceDoneness(
  plan: SlicePlan,
  paths: LoombridgePaths,
): Promise<SliceRollupEvaluation> {
  // An empty roadmap is NOT "done" — refuse rather than report 0/0 as green
  // (mirrors `allSlicesApproved`'s length>0 guard; a degenerate SLICES.json must
  // never false-green the roll-up).
  if (plan.slices.length === 0) {
    return { emptyRoadmap: true, slices: [], depRefusals: [], fidelityReasons: [], assetFidelityReasons: [], artRefusals: [], artDeferred: false, ok: false };
  }

  let ok = true;
  const slices: SliceRollupLine[] = [];
  for (const slice of plan.slices) {
    const result = await isSliceDone(slice, paths);
    const approved = slice.state === "approved";
    const passed = approved && result.ok;
    if (!approved || !result.ok) ok = false;
    slices.push({ id: slice.id, state: slice.state, approved, passed, reasons: result.reasons });
  }

  const byId = new Map(plan.slices.map((s) => [s.id, s]));
  const depRefusals: Array<{ id: string; dep: string }> = [];
  for (const slice of plan.slices) {
    if (slice.state !== "approved") continue;
    for (const dep of slice.dependsOn) {
      if (byId.get(dep)?.state !== "approved") {
        ok = false;
        depRefusals.push({ id: slice.id, dep });
      }
    }
  }

  // Gray-box / feel-only (RCL-D01) — read from DISK truth. When the on-disk
  // acceptance contract declares `art.mode:"deferred"` (and no approved Design
  // Target exists), the hero-shot + asset-source fidelity rollups are
  // NOT-APPLICABLE; per-slice fresh+green proofs (feel bands + structural
  // assertions) still gate `ok` above. There is no whole-game verdict in the
  // slice path, so only the contradiction refusal (deferred + approved target on
  // disk) applies.
  const design = await designStatus(paths);
  const rollupState = await readState(paths);
  const art = artModeRefusals({
    contractArtMode: await readDeclaredArtMode(paths.acceptance),
    verdictArtMode: undefined,
    designApprovedOnDisk: design.status === "approved",
    // No single whole-game verdict in the slice path; the sticky STATE record is
    // the run-bound claim (deleting the on-disk meta leaves STATE stale at
    // "approved"), so it closes the same TOCTOU quadrant for the slice rollup.
    runtimeClaimsApprovedDesignTarget: rollupState?.designTarget === "approved",
  });

  const fidelityReasons = art.deferred ? [] : await checkSliceRollupHeroShotFidelity(paths);
  if (fidelityReasons.length) ok = false;
  const assetFidelityReasons = art.deferred ? [] : await checkSliceRollupAssetSourceFidelity(paths);
  if (assetFidelityReasons.length) ok = false;
  if (art.refusals.length) ok = false;

  return { emptyRoadmap: false, slices, depRefusals, fidelityReasons, assetFidelityReasons, artRefusals: art.refusals, artDeferred: art.deferred, ok };
}

/** True only when the acceptance contract PARSES as a valid contract (bare `{}` is rejected). */
async function acceptanceContractValid(acceptancePath: string): Promise<boolean> {
  try {
    assertValidAcceptanceContract(JSON.parse(await fs.readFile(acceptancePath, "utf-8")));
    return true;
  } catch {
    return false;
  }
}

/**
 * Read-only boolean: would `loombridge doneness` certify this project right now?
 * The SAME gate, reused — NOT a re-implementation — so the bridge `loombridge_status`
 * `verifiedGreen` flag can never be forged from a hand-edited STATE.phase or a
 * bare/empty ACCEPTANCE.json. Returns false for the never-planned (captures-only)
 * shape; for the whole-game path it additionally requires the contract to parse
 * valid and STATE's last verdict to be a `pass`.
 */
export async function isProjectDone(paths: LoombridgePaths): Promise<boolean> {
  const slicePlan = await readSlicePlan(paths);

  // Never-planned (captures-only) → not done.
  if (!(await fileExists(paths.acceptance)) && !slicePlan) {
    const state = await readState(paths);
    if (!state) return false;
  }

  if (slicePlan) {
    const ev = await evaluateSliceDoneness(slicePlan, paths);
    return ev.ok;
  }

  // Whole-game: a bare/empty contract or a `pass`-less STATE can never certify.
  if (!(await acceptanceContractValid(paths.acceptance))) return false;
  const { reasons, state } = await wholeGameDonenessReasons(paths);
  if (state?.lastVerdict?.status !== "pass") return false;
  return reasons.length === 0;
}

/** Run the doneness check programmatically. Exported for tests. */
export async function runDoneness(args: DonenessArgs): Promise<number> {
  const paths = loombridgePaths(args.root);
  const slicePlan = await readSlicePlan(paths);

  // Refuse-on-missing-contract (RCL-P04). "Done" is meaningless for a project
  // that never planned: no acceptance contract, no roadmap, and no state — only
  // hand-created captures, which are NOT a verification. Refuse explicitly and
  // point at `loombridge plan`. (A project WITH a roadmap or state went through the
  // flow; its own freshness/slice-rollup checks below own the verdict.)
  if (!(await fileExists(paths.acceptance)) && !slicePlan) {
    const state = await readState(paths);
    if (!state) {
      const presence = await inspectContractPresence(paths);
      console.error(
        `[loombridge doneness] NOT done — ${noContractRefusal(paths.acceptance, presence.capturePresentDirs)}`,
      );
      return 1;
    }
  }

  if (slicePlan) {
    return runSliceDoneness(slicePlan, paths);
  }

  const { reasons, state, verdict, manifestCount, artDeferred } = await wholeGameDonenessReasons(paths, args.verdictPath);

  // The SAME contract-validity gate `isProjectDone` applies (a bare/empty/
  // malformed ACCEPTANCE.json can never certify) — surfaced here too so the
  // human-facing CLI and the bridge `verifiedGreen` flag cannot disagree: a
  // truncated contract must refuse on BOTH surfaces, not silently disarm the
  // contract-declared gates (art.mode, requiredEvidenceClasses) on one of them.
  if (!(await acceptanceContractValid(paths.acceptance))) {
    const r =
      "ACCEPTANCE.json is missing or does not parse as a valid acceptance contract — doneness cannot certify against an unvalidatable contract (fix .loombridge/ACCEPTANCE.json or re-run `loombridge plan`; the same check gates `loombridge_status.verifiedGreen`)";
    if (!reasons.some((existing) => existing === r)) reasons.push(r);
  }

  if (reasons.length === 0) {
    const runId = state?.currentBuild?.runId ?? "(missing)";
    const fidelity = artDeferred
      ? ", art:deferred (gray-box / feel-only — hero-shot fidelity N/A)"
      : verdict?.designTarget?.status === "approved" ? ", hero-shot faithful" : "";
    console.error(
      `[loombridge doneness] OK — fresh + green (runId=${runId}, ${manifestCount} captures verified${fidelity}).`,
    );
    return 0;
  }
  console.error("[loombridge doneness] NOT done:");
  for (const r of reasons) console.error(`  - ${r}`);
  return 1;
}

async function runSliceDoneness(plan: SlicePlan, paths: LoombridgePaths): Promise<number> {
  const ev = await evaluateSliceDoneness(plan, paths);
  if (ev.emptyRoadmap) {
    console.error("[loombridge doneness] NOT done — SLICES.json has no slices (empty roadmap).");
    return 1;
  }

  console.error("[loombridge doneness] Slice roll-up:");
  for (const slice of ev.slices) {
    if (!slice.approved) {
      console.error(`  - ${slice.id}: REFUSE — state is \`${slice.state}\`, not \`approved\``);
      for (const reason of slice.reasons) console.error(`      - ${reason}`);
    } else if (slice.passed) {
      console.error(`  - ${slice.id}: PASS`);
    } else {
      console.error(`  - ${slice.id}: REFUSE`);
      for (const reason of slice.reasons) console.error(`      - ${reason}`);
    }
  }

  for (const { id, dep } of ev.depRefusals) {
    console.error(`  - ${id}: REFUSE — dependency \`${dep}\` is not approved`);
  }

  if (ev.fidelityReasons.length) {
    console.error("  - hero-shot-fidelity: REFUSE");
    for (const reason of ev.fidelityReasons) console.error(`      - ${reason}`);
  } else {
    console.error(`  - hero-shot-fidelity: ${ev.artDeferred ? "N/A (art:deferred — gray-box / feel-only)" : "PASS"}`);
  }

  if (ev.assetFidelityReasons.length) {
    console.error("  - asset-source-fidelity: REFUSE");
    for (const reason of ev.assetFidelityReasons) console.error(`      - ${reason}`);
  } else {
    console.error(`  - asset-source-fidelity: ${ev.artDeferred ? "N/A (art:deferred — gray-box / feel-only)" : "PASS"}`);
  }

  if (ev.artRefusals.length) {
    console.error("  - art-mode: REFUSE");
    for (const reason of ev.artRefusals) console.error(`      - ${reason}`);
  }

  if (ev.ok) {
    console.error(`[loombridge doneness] OK — ${plan.slices.length}/${plan.slices.length} slices approved + deterministic proofs fresh + hero-shot faithful + asset-source faithful.`);
    return 0;
  }
  console.error("[loombridge doneness] NOT done — slice roll-up refused.");
  return 1;
}

function printUsage(): void {
  console.log(
    [
      "Usage: loombridge doneness [options]",
      "",
      "The §3a supervisor freshness gate. Exits 0 only when STATE.phase ===",
      "verified-green AND verdict.runId === currentBuild.runId AND verdict.producedAt",
      "is on/after currentBuild.startedAt AND every captureManifest entry exists.",
      "",
      "Options:",
      "  --root <dir>        Project root (default: cwd)",
      "  --verdict <path>    Override verdict path",
      "                      (default: .loombridge/reports/build-verdict.json)",
      "  -h, --help          Show this help",
      "",
      "Exit: 0 fresh + green; 1 otherwise (with all reasons listed).",
    ].join("\n"),
  );
}

/** CLI entry: parse the post-subcommand args and run. */
export async function run(args: string[]): Promise<number> {
  let root = process.cwd();
  let verdictPath: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--root") root = path.resolve(args[(i += 1)] ?? root);
    else if (arg === "--verdict") verdictPath = path.resolve(args[(i += 1)] ?? "");
    else if (arg === "--help" || arg === "-h") {
      printUsage();
      return 0;
    } else {
      console.error(`[loombridge doneness] unknown argument "${arg}".`);
      printUsage();
      return 2;
    }
  }
  try {
    return await runDoneness({ root, verdictPath });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[loombridge doneness] fatal: ${message}`);
    return 1;
  }
}
