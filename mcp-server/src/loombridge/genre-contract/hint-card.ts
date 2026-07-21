/**
 * Genre-pack hint-card — the declarative SEED a genre pack hands the elicitation front-end.
 *
 * A hint-card is genre-specific KNOWLEDGE (sub-genre taxonomy, the canonical tunables for this
 * genre, default asset roles, default feel bands, exemplars) plus the `genreClass` seed default. The
 * elicitation engine reads it to pre-fill a `GenreContract` draft; absent a pack the spine + agent
 * knowledge still emit a contract (graceful degradation) — the generic core always works, a genre
 * pack is a knowledge upgrade on top of it, never a hard requirement.
 *
 * BINDING DISCIPLINE (the load-bearing invariant). A hint-card must never seed a value that the
 * contract validator (`validateGenreContract`) would later REJECT — otherwise the two drift and a
 * pack could quietly re-open a false-green. So this validator binds to the EXACT SAME closed sets as
 * the contract validator:
 *   - genreClass        → GENRE_CLASS_SET            (types.ts)
 *   - measurabilityTag  → MEASURABILITY_TAG_SET      (types.ts)
 *   - evidenceKind      → EVIDENCE_KIND_SET          (types.ts)
 *   - units             → SUPPORTED_PROFILE_UNIT_SET (genre-neutral feel-primitives.ts)
 *   - measurable-now    → IMPLEMENTED_CALCULATOR_IDS (validator.ts — the same set the contract binds)
 *
 * It is intentionally a hand-rolled, issue-collecting validator mirroring `validator.ts` /
 * `genre-packs/platformer-2d/validator.ts`: an absent bound field is a REFUSAL, never a silently-skipped
 * check.
 */

import { SUPPORTED_PROFILE_UNIT_SET } from "../feel-primitives.js";
import { IMPLEMENTED_CALCULATOR_IDS } from "./validator.js";
import {
  GENRE_CLASS_SET,
  MEASURABILITY_TAG_SET,
  EVIDENCE_KIND_SET,
  type GenreClass,
  type MeasurabilityTag,
  type EvidenceKind,
  type GenreContractIssue,
  type GenreContractValidationResult,
} from "./types.js";

const FORBIDDEN_CORE_HOOK_KINDS = new Set([
  "roster",
  "progression",
  "economy",
  "matchmaking",
  "shop",
  "unlocks",
  "campaign",
]);

/* ------------------------------------------------------------------ manifest + card shapes */

/**
 * `genre-packs/<id>/pack.json` — the pack manifest. `genreId`, `subGenres`, `genreClass` and the
 * registered `slots` are required; `requires` lists external dependencies (e.g. `photon-fusion`).
 */
export interface GenrePackManifest {
  /** stable genre id, e.g. "2d-shooter" — matches the contract's genreId. */
  genreId: string;
  /** sub-genre taxonomy this pack covers, e.g. ["top-down", "twin-stick", "side-scroll"]. */
  subGenres: string[];
  /** the genreClass this pack seeds (drives the contract validator's completeness profile). */
  genreClass: GenreClass;
  /** external deps the pack needs, e.g. ["photon-fusion"]. Optional. */
  requires?: string[];
  /** registered pack slots present in this pack, e.g. ["hint-card"]. */
  slots: string[];
}

/** A genre-canonical tunable the hint-card seeds into the contract's `tunables`. */
export interface HintCardTunable {
  id: string;
  /** SHOULD be in SUPPORTED_PROFILE_UNIT_SET when set; a non-supported unit is refused. */
  unit?: string;
  description?: string;
}

/** A numeric or qualitative default band, mirroring the contract's FeelBand. */
export interface HintCardBand {
  min?: number;
  max?: number;
  unit?: string;
  qualitative?: string;
}

/**
 * A default feel band the hint-card seeds for a target. Carries the honest measurabilityTag + the
 * provenance evidenceKind — the same two honesty fields the contract's measurabilityMap row carries.
 */
export interface HintCardDefaultBand {
  /** the feel target (usually a tunable id or a metric id), e.g. "inputToSfxLatency". */
  target: string;
  /** provisional band (numeric or qualitative). */
  band: HintCardBand;
  /** provenance of the band. Same closed set as the contract's EVIDENCE_KINDS. */
  evidenceKind: EvidenceKind;
  /** honest measurability of this target. Same closed set as the contract's MEASURABILITY_TAGS. */
  measurabilityTag: MeasurabilityTag;
  /**
   * For a `measurable-now` default: the implemented calculator id (must be in
   * IMPLEMENTED_CALCULATOR_IDS). For the needs-* tags: a short note naming what must be built.
   */
  calculator?: string;
}

/**
 * A brief-defining mechanic that can look like meta/progression, but should remain minimally present
 * in the core vertical when the brief explicitly asks for it. The full system still belongs in
 * deferredMeta; this records the one representative core slice the authoring front-end should keep.
 */
export interface HintCardCoreHook {
  /** stable hook id, e.g. "minimal-upgrade-choice". */
  id: string;
  /** phrases/brief features that activate this hook. */
  triggerTerms: string[];
  /** non-meta content kind to declare in verticalSliceBudget.coreVerticalContent, e.g. "upgradeChoice". */
  coreContentKind: string;
  /** recommended coreVertical slice title for the minimal representative mechanic. */
  coreSliceTitle: string;
  /** what must remain deferred rather than smuggled into coreVertical. */
  deferredRemainder: string[];
}

/** The hint-card itself — the declarative slot data. */
export interface GenreHintCard {
  /** matches the manifest genreId. */
  genreId: string;
  /** the genreClass seed default (contract field 2 is authoritative; this only seeds it). */
  genreClass: GenreClass;
  /** sub-genre / perspective taxonomy, e.g. ["top-down", "twin-stick", "side-scroll"]. */
  subGenres: string[];
  /** perspective taxonomy, e.g. ["top-down", "side-scroll"]. */
  perspectives: string[];
  /** the canonical, runtime-tunable feel parameters for this genre. */
  canonicalTunables: HintCardTunable[];
  /** concrete core-vertical asset roles this genre normally needs to read correctly. */
  assetRoles?: string[];
  /** brief-defining meta-looking hooks that should get one minimal core representative slice. */
  coreHooks?: HintCardCoreHook[];
  /** default feel bands keyed by target, with honest measurability + provenance. */
  defaultBands: HintCardDefaultBand[];
  /** named exemplar games / reference projects. */
  exemplars: string[];
  /** free-form authoring notes. */
  notes?: string;
}

/* ------------------------------------------------------------------ small guards */

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function isString(v: unknown): v is string {
  return typeof v === "string";
}
function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}
function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

/* ------------------------------------------------------------------ validation */

/**
 * Validate a genre pack: a manifest plus the hint-card it carries. Both are optional inputs so this
 * can validate the manifest alone, the card alone, or a `{ manifest, hintCard }` pair. The shipped
 * pack passes BOTH a manifest and a card.
 */
export function validateHintCard(
  input: { manifest?: unknown; hintCard?: unknown } | unknown,
): GenreContractValidationResult {
  const issues: GenreContractIssue[] = [];
  const push = (code: string, message: string, path: string) => issues.push({ code, message, path });

  // Accept either a bare hint-card object, or a { manifest, hintCard } pair.
  let manifest: unknown;
  let hintCard: unknown;
  if (isRecord(input) && ("manifest" in input || "hintCard" in input)) {
    manifest = (input as Record<string, unknown>).manifest;
    hintCard = (input as Record<string, unknown>).hintCard;
  } else {
    hintCard = input;
  }

  if (manifest !== undefined) validateManifest(manifest, push);
  if (hintCard !== undefined) validateCard(hintCard, push);
  if (manifest === undefined && hintCard === undefined) {
    push("EMPTY_INPUT", "nothing to validate — provide a hint-card and/or a manifest", "");
  }

  return { valid: issues.length === 0, issues };
}

/** Manifest refusals: a missing required field is a refusal (genreId/subGenres/genreClass/slots). */
function validateManifest(
  manifest: unknown,
  push: (code: string, message: string, path: string) => void,
): void {
  if (!isRecord(manifest)) {
    push("MANIFEST_NOT_OBJECT", "manifest must be a JSON object", "manifest");
    return;
  }
  if (!isNonEmptyString(manifest.genreId)) {
    push("MANIFEST_GENRE_ID", "manifest.genreId is required (non-empty string)", "manifest.genreId");
  }
  if (!isStringArray(manifest.subGenres) || manifest.subGenres.length === 0) {
    push("MANIFEST_SUBGENRES", "manifest.subGenres is required (non-empty string[])", "manifest.subGenres");
  }
  if (!isString(manifest.genreClass) || !GENRE_CLASS_SET.has(manifest.genreClass)) {
    push("MANIFEST_GENRE_CLASS", "manifest.genreClass must be twitch | systems | hybrid", "manifest.genreClass");
  }
  if (!isStringArray(manifest.slots) || manifest.slots.length === 0) {
    push("MANIFEST_SLOTS", "manifest.slots is required (non-empty string[] of registered slots)", "manifest.slots");
  }
  if (manifest.requires !== undefined && !isStringArray(manifest.requires)) {
    push("MANIFEST_REQUIRES", "manifest.requires, when present, must be a string[]", "manifest.requires");
  }
}

/** Hint-card refusals: bound to the SAME closed sets as the contract validator (see module note). */
function validateCard(
  card: unknown,
  push: (code: string, message: string, path: string) => void,
): void {
  if (!isRecord(card)) {
    push("CARD_NOT_OBJECT", "hint-card must be a JSON object", "hintCard");
    return;
  }

  if (!isNonEmptyString(card.genreId)) {
    push("CARD_GENRE_ID", "hintCard.genreId is required (non-empty string)", "hintCard.genreId");
  }
  // genreClass — same closed set the contract binds against.
  if (!isString(card.genreClass) || !GENRE_CLASS_SET.has(card.genreClass)) {
    push("CARD_GENRE_CLASS", "hintCard.genreClass must be twitch | systems | hybrid", "hintCard.genreClass");
  }
  if (!isStringArray(card.subGenres) || card.subGenres.length === 0) {
    push("CARD_SUBGENRES", "hintCard.subGenres is required (non-empty string[])", "hintCard.subGenres");
  }
  if (!isStringArray(card.perspectives) || card.perspectives.length === 0) {
    push("CARD_PERSPECTIVES", "hintCard.perspectives is required (non-empty string[])", "hintCard.perspectives");
  }
  if (!Array.isArray(card.exemplars)) {
    push("CARD_EXEMPLARS", "hintCard.exemplars must be a string[]", "hintCard.exemplars");
  } else if (!isStringArray(card.exemplars)) {
    push("CARD_EXEMPLARS", "hintCard.exemplars entries must be strings", "hintCard.exemplars");
  }

  // canonicalTunables — units, when present, must be a supported profile unit (R7 of the contract).
  if (!Array.isArray(card.canonicalTunables) || card.canonicalTunables.length === 0) {
    push("CARD_TUNABLES", "hintCard.canonicalTunables must be a non-empty array", "hintCard.canonicalTunables");
  } else {
    card.canonicalTunables.forEach((t, i) => {
      const p = `hintCard.canonicalTunables[${i}]`;
      if (!isRecord(t) || !isNonEmptyString(t.id)) {
        push("CARD_TUNABLE", "each canonical tunable needs an id", p);
      } else if (t.unit !== undefined && (!isString(t.unit) || !SUPPORTED_PROFILE_UNIT_SET.has(t.unit))) {
        push("CARD_TUNABLE_UNIT", `tunable unit "${String(t.unit)}" is not a supported unit`, `${p}.unit`);
      }
    });
  }

  if (card.assetRoles !== undefined) {
    if (!Array.isArray(card.assetRoles) || card.assetRoles.length === 0) {
      push("CARD_ASSET_ROLES", "hintCard.assetRoles, when present, must be a non-empty string[]", "hintCard.assetRoles");
    } else if (!isStringArray(card.assetRoles) || !card.assetRoles.every((r) => r.trim().length > 0)) {
      push("CARD_ASSET_ROLES", "hintCard.assetRoles entries must be non-empty strings", "hintCard.assetRoles");
    }
  }

  if (card.coreHooks !== undefined) {
    if (!Array.isArray(card.coreHooks)) {
      push("CARD_CORE_HOOKS", "hintCard.coreHooks, when present, must be an array", "hintCard.coreHooks");
    } else {
      card.coreHooks.forEach((hook, i) => {
        const p = `hintCard.coreHooks[${i}]`;
        if (!isRecord(hook)) {
          push("CARD_CORE_HOOK", "each core hook must be an object", p);
          return;
        }
        if (!isNonEmptyString(hook.id)) {
          push("CARD_CORE_HOOK_ID", "core hook id is required", `${p}.id`);
        }
        if (!isStringArray(hook.triggerTerms) || hook.triggerTerms.length === 0 || !hook.triggerTerms.every((t) => t.trim().length > 0)) {
          push("CARD_CORE_HOOK_TERMS", "core hook triggerTerms must be non-empty strings", `${p}.triggerTerms`);
        }
        if (!isNonEmptyString(hook.coreContentKind)) {
          push("CARD_CORE_HOOK_KIND", "core hook coreContentKind is required", `${p}.coreContentKind`);
        } else if (FORBIDDEN_CORE_HOOK_KINDS.has(hook.coreContentKind)) {
          push("CARD_CORE_HOOK_META_KIND", `core hook coreContentKind "${hook.coreContentKind}" is a forbidden meta kind`, `${p}.coreContentKind`);
        }
        if (!isNonEmptyString(hook.coreSliceTitle)) {
          push("CARD_CORE_HOOK_TITLE", "core hook coreSliceTitle is required", `${p}.coreSliceTitle`);
        }
        if (!isStringArray(hook.deferredRemainder) || hook.deferredRemainder.length === 0 || !hook.deferredRemainder.every((r) => r.trim().length > 0)) {
          push("CARD_CORE_HOOK_DEFERRED", "core hook deferredRemainder must be non-empty strings", `${p}.deferredRemainder`);
        }
      });
    }
  }

  // defaultBands — the honesty crux. Bound to the SAME closed sets as the contract's measurabilityMap.
  if (!Array.isArray(card.defaultBands) || card.defaultBands.length === 0) {
    push("CARD_DEFAULT_BANDS", "hintCard.defaultBands must be a non-empty array", "hintCard.defaultBands");
  } else {
    card.defaultBands.forEach((b, i) => {
      const p = `hintCard.defaultBands[${i}]`;
      if (!isRecord(b)) {
        push("CARD_BAND_ROW", "each defaultBand must be an object", p);
        return;
      }
      if (!isNonEmptyString(b.target)) {
        push("CARD_BAND_TARGET", "defaultBand.target must be a non-empty string", `${p}.target`);
      }

      // measurabilityTag — closed set.
      const tag = b.measurabilityTag;
      if (!isString(tag) || !MEASURABILITY_TAG_SET.has(tag)) {
        push("CARD_BAND_TAG", "defaultBand.measurabilityTag must be a known measurability tag", `${p}.measurabilityTag`);
      }
      // evidenceKind — closed set (a band always carries provenance).
      if (!isString(b.evidenceKind) || !EVIDENCE_KIND_SET.has(b.evidenceKind)) {
        push("CARD_BAND_EVIDENCE", "defaultBand.evidenceKind must be a known evidence kind", `${p}.evidenceKind`);
      }

      // measurable-now → calculator must be implemented (the same gate the contract enforces).
      if (tag === "measurable-now") {
        if (!isNonEmptyString(b.calculator)) {
          push("CARD_MEASURABLE_NOW_NO_CALC", "a measurable-now default requires a calculator id", `${p}.calculator`);
        } else if (!IMPLEMENTED_CALCULATOR_IDS.has(b.calculator)) {
          push(
            "CARD_MEASURABLE_NOW_UNIMPLEMENTED",
            `calculator "${b.calculator}" is not an implemented calculator — use needs-new-calculator`,
            `${p}.calculator`,
          );
        }
      }

      // band shape + unit (R7 — same supported unit set as the contract).
      if (!isRecord(b.band)) {
        push("CARD_BAND_SHAPE", "defaultBand.band must be an object", `${p}.band`);
      } else {
        const hasMin = b.band.min !== undefined;
        const hasMax = b.band.max !== undefined;
        const hasQualitative = isNonEmptyString(b.band.qualitative);
        if (hasMin && (typeof b.band.min !== "number" || !Number.isFinite(b.band.min))) {
          push("CARD_BAND_MIN", "band.min must be a finite number", `${p}.band.min`);
        }
        if (hasMax && (typeof b.band.max !== "number" || !Number.isFinite(b.band.max))) {
          push("CARD_BAND_MAX", "band.max must be a finite number", `${p}.band.max`);
        }
        if (typeof b.band.min === "number" && typeof b.band.max === "number" && b.band.min > b.band.max) {
          push("CARD_BAND_RANGE", "band.min must be <= band.max", `${p}.band`);
        }
        if (!hasMin && !hasMax && !hasQualitative) {
          push("CARD_BAND_EMPTY", "band must include min, max, or qualitative", `${p}.band`);
        }
        if (b.band.unit !== undefined && (!isString(b.band.unit) || !SUPPORTED_PROFILE_UNIT_SET.has(b.band.unit))) {
          push("CARD_BAND_UNIT", `band unit "${String(b.band.unit)}" is not a supported unit`, `${p}.band.unit`);
        }
      }
    });
  }
}

/** Throwing wrapper — mirrors assertValidGenreContract. */
export function assertValidHintCard(
  input: { manifest?: unknown; hintCard?: unknown } | unknown,
): void {
  const { valid, issues } = validateHintCard(input);
  if (!valid) {
    const summary = issues.map((i) => `${i.path || "<root>"}: ${i.message} [${i.code}]`).join("; ");
    throw new Error(`invalid genre hint-card: ${summary}`);
  }
}
