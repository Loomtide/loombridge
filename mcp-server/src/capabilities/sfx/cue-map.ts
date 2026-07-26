/**
 * Cue event-map schema — a GENRE-PACK-OWNED artifact (SFX dogfood backlog
 * High #5 "Cue event-map schema"; `Docs/Assets/GeneratedSfxWorkflow.md` "Cue Grammar").
 *
 * The dogfood SFX pass taught that SFX is a SEMANTIC SYSTEM, not a file drop: the
 * durable lesson is that the per-cue grammar (event binding, layer roles, frequency
 * class, variant policy, priority, mixer bus, spatial policy, required-vs-optional)
 * belongs to the genre pack, not to something an agent invents per run. This module
 * defines the schema TYPE and a self-validating parser (the "schema of schemas"); the
 * seed cue map lives on disk as a pack artifact (`genre-packs/<genre>/cue-map.json`),
 * exactly like `telemetry.json`.
 *
 * The schema is deterministic and engine-agnostic (pure TS, no bridge/C#). The SFX
 * verification gates (`sfx-presence`, `sfx-runtime`, `inputToSfxLatency`,
 * `sfx-fatigue`) read the parsed cue map to know WHICH cues are required, WHICH must
 * fire in a drive scenario, and WHICH declare a no-immediate-repeat variant policy.
 *
 * Mirrors `telemetry/schema.ts`: closed-enum fields, refuse-shaped validation (every
 * structural problem returned, deterministically sorted; `schema` only when `ok`), and
 * honesty-rule carriage. A malformed / hand-edited pack cue map can never silently
 * degrade the SFX gates into a no-op.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { packageRoot } from "../../shared/pkg-root.js";
import {
  telemetrySchemaPathForGenre,
  validateTelemetrySchema,
  type TelemetrySchema,
} from "../telemetry/schema.js";

/** How often a cue fires — drives whether a variant policy is REQUIRED (learning #2). */
export type CueFrequency = "rare" | "occasional" | "frequent" | "loop";

/** Playback importance under voice virtualization (Unity `AudioSource.priority`). */
export type CuePriority = "critical" | "gameplay" | "cosmetic";

/** Mixer bus the cue routes through (never straight to the listener). */
export type CueMixerBus = "SFX" | "UI" | "Voice" | "Ambience" | "Music" | "Cinematic";

/** Functional layer role (learning #3: layers are ROLES, not "make it bigger" stacks). */
export type CueLayerRole = "transient" | "body" | "sweetener" | "tail" | "reward" | "context";

/** Spatial blend mode — 2D/global confirms vs 3D/world foley vs a hybrid. */
export type CueSpatialMode = "2d" | "3d" | "hybrid";

/** Distance-attenuation class for a 3D/hybrid cue. Documentation + rig hint. */
export type CueRolloffClass = "none" | "linear" | "logarithmic" | "custom";

/** How an event payload field selects a variant/tier (learning #4: payloads matter). */
export type PayloadMappingKind = "tier" | "threshold" | "enum";

export const CUE_FREQUENCIES: ReadonlySet<string> = new Set<CueFrequency>([
  "rare",
  "occasional",
  "frequent",
  "loop",
]);
export const CUE_PRIORITIES: ReadonlySet<string> = new Set<CuePriority>([
  "critical",
  "gameplay",
  "cosmetic",
]);
export const CUE_MIXER_BUSES: ReadonlySet<string> = new Set<CueMixerBus>([
  "SFX",
  "UI",
  "Voice",
  "Ambience",
  "Music",
  "Cinematic",
]);
export const CUE_LAYER_ROLES: ReadonlySet<string> = new Set<CueLayerRole>([
  "transient",
  "body",
  "sweetener",
  "tail",
  "reward",
  "context",
]);
export const CUE_SPATIAL_MODES: ReadonlySet<string> = new Set<CueSpatialMode>([
  "2d",
  "3d",
  "hybrid",
]);
export const CUE_ROLLOFF_CLASSES: ReadonlySet<string> = new Set<CueRolloffClass>([
  "none",
  "linear",
  "logarithmic",
  "custom",
]);
export const PAYLOAD_MAPPING_KINDS: ReadonlySet<string> = new Set<PayloadMappingKind>([
  "tier",
  "threshold",
  "enum",
]);

/** A symmetric [min,max] jitter range (semitone or ratio for pitch, dB/linear for volume). */
export interface CueJitterRange {
  min: number;
  max: number;
}

/**
 * Variant / anti-fatigue policy for a cue (learning #2 "frequent cues need variants
 * and non-repeat"). A `frequent` cue MUST declare one, with `count >= 2` and
 * `noImmediateRepeat: true` — the validator refuses a frequent cue without it.
 */
export interface CueVariantPolicy {
  /** Number of interchangeable clip variants. `noImmediateRepeat` needs `>= 2`. */
  count: number;
  /** The same variant must not play twice in a row for this cue (round-robin/shuffle). */
  noImmediateRepeat: boolean;
  /** Random pitch jitter range applied per play. */
  pitchJitter?: CueJitterRange;
  /** Random volume jitter range applied per play. */
  volumeJitter?: CueJitterRange;
  /** Minimum time between two plays of this cue (voice-spam guard), ms. */
  cooldownMs?: number;
  /** Max simultaneous voices for this cue before stealing (concurrency cap). */
  maxConcurrent?: number;
}

/** One variant/tier selection bucket driven by a payload field value. */
export interface PayloadBucket {
  /** The variant/tier tag this bucket selects (e.g. `loot_high`, `heavy`). */
  variantTag: string;
  /** For `kind:"threshold"` — this bucket applies when value < `upTo` (ascending buckets). */
  upTo?: number;
  /** For `kind:"tier"`/`"enum"` — this bucket applies when the field equals `value`. */
  value?: string;
}

/** Maps an event payload field to variant/tier selection (learning #4). */
export interface CuePayloadMapping {
  /** Event payload field driving selection (e.g. `lootValue`, `weaponType`). */
  sourceField: string;
  kind: PayloadMappingKind;
  /** The selection buckets (closed set; at least one). */
  buckets: PayloadBucket[];
}

/** Spatial policy — blend mode + (for 3D/hybrid) a rolloff class. */
export interface CueSpatialPolicy {
  mode: CueSpatialMode;
  rolloff?: CueRolloffClass;
}

/** One cue declaration — the per-cue grammar. */
export interface CueDecl {
  /** Stable cue id (e.g. `fire`, `hit`, `loot_high`). Unique within the map. */
  id: string;
  /**
   * Game event / event channel that fires the cue (the binding). INTENTIONALLY a free
   * string (review D5): the runtime binding is game-side (the game's own event
   * channels / SfxPlayer wiring), so there is no closed registry the schema could
   * enforce against without false refusals. When the SAME genre pack also ships a
   * telemetry schema, `cueEventTelemetryWarnings` cross-checks each cue event against
   * the telemetry event-type closed set and WARNS (advisory, never a refusal) on a
   * name that matches no telemetry event — a telemetry-backed event name enables
   * cross-verification between the cue map and the event stream.
   */
  event: string;
  /**
   * Whether the cue is REQUIRED (its clip must bind + it must be honored in
   * verification) or OPTIONAL. Absent defaults to `false` (optional). A `critical`
   * priority cue MUST be `required: true` (an optional critical cue is contradictory).
   */
  required?: boolean;
  frequency: CueFrequency;
  priority: CuePriority;
  mixerBus: CueMixerBus;
  /** Functional layer roles (non-empty, no duplicates; each from `CUE_LAYER_ROLES`). */
  layerRoles: CueLayerRole[];
  spatial: CueSpatialPolicy;
  /** Variant/anti-fatigue policy. REQUIRED when `frequency:"frequent"`. */
  variantPolicy?: CueVariantPolicy;
  /** Optional payload→variant/tier mapping. */
  payloadMapping?: CuePayloadMapping;
  /** Human intent / grammar note (physical action first — see the runbook). */
  meaning?: string;
  note?: string;
}

/** A named honesty rule carried with the cue map (parity with telemetry). */
export interface CueMapHonestyRule {
  id: string;
  rule: string;
}

/** The genre-pack cue event map. */
export interface CueMapSchema {
  schemaVersion: string;
  id: string;
  genre?: string;
  note?: string;
  honestyRules: CueMapHonestyRule[];
  cues: CueDecl[];
}

/** Result of validating a raw object AS a cue map (the schema of schemas). */
export interface CueMapParseResult {
  ok: boolean;
  refusals: string[];
  schema?: CueMapSchema;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** Validate a jitter range in the context of a cue; pushes refusals, returns parsed or undefined. */
function parseJitter(
  raw: unknown,
  cueId: string,
  field: string,
  refusals: string[],
): CueJitterRange | undefined {
  if (raw === undefined) return undefined;
  if (!isObject(raw) || !isFiniteNumber(raw.min) || !isFiniteNumber(raw.max)) {
    refusals.push(`cue \`${cueId}\`: variantPolicy.${field} must be { min:number, max:number }`);
    return undefined;
  }
  if (raw.min > raw.max) {
    refusals.push(`cue \`${cueId}\`: variantPolicy.${field}.min (${raw.min}) > max (${raw.max})`);
    return undefined;
  }
  return { min: raw.min, max: raw.max };
}

function parseVariantPolicy(
  raw: unknown,
  cue: CueDecl,
  refusals: string[],
): CueVariantPolicy | undefined {
  if (raw === undefined) return undefined;
  if (!isObject(raw)) {
    refusals.push(`cue \`${cue.id}\`: variantPolicy must be an object`);
    return undefined;
  }
  let ok = true;
  if (!isFiniteNumber(raw.count) || !Number.isInteger(raw.count) || raw.count < 1) {
    refusals.push(`cue \`${cue.id}\`: variantPolicy.count must be an integer >= 1`);
    ok = false;
  }
  if (typeof raw.noImmediateRepeat !== "boolean") {
    refusals.push(`cue \`${cue.id}\`: variantPolicy.noImmediateRepeat must be a boolean`);
    ok = false;
  }
  // no-immediate-repeat needs at least two variants to alternate between — a count:1
  // no-repeat policy can never be satisfied (only one clip to choose), so refuse it.
  if (raw.noImmediateRepeat === true && isFiniteNumber(raw.count) && raw.count < 2) {
    refusals.push(
      `cue \`${cue.id}\`: variantPolicy.noImmediateRepeat requires count >= 2 (a single variant can never avoid an immediate repeat)`,
    );
    ok = false;
  }
  const pitchJitter = parseJitter(raw.pitchJitter, cue.id, "pitchJitter", refusals);
  const volumeJitter = parseJitter(raw.volumeJitter, cue.id, "volumeJitter", refusals);
  if (raw.cooldownMs !== undefined && (!isFiniteNumber(raw.cooldownMs) || raw.cooldownMs < 0)) {
    refusals.push(`cue \`${cue.id}\`: variantPolicy.cooldownMs must be a number >= 0`);
    ok = false;
  }
  if (
    raw.maxConcurrent !== undefined &&
    (!isFiniteNumber(raw.maxConcurrent) || !Number.isInteger(raw.maxConcurrent) || raw.maxConcurrent < 1)
  ) {
    refusals.push(`cue \`${cue.id}\`: variantPolicy.maxConcurrent must be an integer >= 1`);
    ok = false;
  }
  if (!ok) return undefined;
  return {
    count: raw.count as number,
    noImmediateRepeat: raw.noImmediateRepeat as boolean,
    pitchJitter,
    volumeJitter,
    cooldownMs: isFiniteNumber(raw.cooldownMs) ? raw.cooldownMs : undefined,
    maxConcurrent: isFiniteNumber(raw.maxConcurrent) ? raw.maxConcurrent : undefined,
  };
}

function parsePayloadMapping(
  raw: unknown,
  cueId: string,
  refusals: string[],
): CuePayloadMapping | undefined {
  if (raw === undefined) return undefined;
  if (!isObject(raw)) {
    refusals.push(`cue \`${cueId}\`: payloadMapping must be an object`);
    return undefined;
  }
  let ok = true;
  if (typeof raw.sourceField !== "string" || raw.sourceField.length === 0) {
    refusals.push(`cue \`${cueId}\`: payloadMapping.sourceField must be a non-empty string`);
    ok = false;
  }
  const kind = raw.kind;
  if (typeof kind !== "string" || !PAYLOAD_MAPPING_KINDS.has(kind)) {
    refusals.push(
      `cue \`${cueId}\`: payloadMapping.kind must be one of ${[...PAYLOAD_MAPPING_KINDS].join("/")}`,
    );
    ok = false;
  }
  const buckets: PayloadBucket[] = [];
  if (!Array.isArray(raw.buckets) || raw.buckets.length === 0) {
    refusals.push(`cue \`${cueId}\`: payloadMapping.buckets must be a non-empty array`);
    ok = false;
  } else {
    raw.buckets.forEach((b, i) => {
      if (!isObject(b) || typeof b.variantTag !== "string" || b.variantTag.length === 0) {
        refusals.push(`cue \`${cueId}\`: payloadMapping.buckets[${i}].variantTag must be a non-empty string`);
        return;
      }
      if (kind === "threshold") {
        if (!isFiniteNumber(b.upTo)) {
          refusals.push(`cue \`${cueId}\`: payloadMapping.buckets[${i}] (threshold) requires numeric \`upTo\``);
          return;
        }
      } else if (typeof b.value !== "string" || b.value.length === 0) {
        refusals.push(`cue \`${cueId}\`: payloadMapping.buckets[${i}] (${String(kind)}) requires a non-empty string \`value\``);
        return;
      }
      buckets.push({
        variantTag: b.variantTag,
        upTo: isFiniteNumber(b.upTo) ? b.upTo : undefined,
        value: typeof b.value === "string" ? b.value : undefined,
      });
    });
  }
  if (!ok || buckets.length === 0) return undefined;
  return { sourceField: raw.sourceField as string, kind: kind as PayloadMappingKind, buckets };
}

/**
 * Validate a raw parsed object as a `CueMapSchema`. Refuse-shaped: returns every
 * structural problem (deterministically sorted), and `schema` only when `ok`.
 *
 * This guards the cue-map artifact itself so a malformed/hand-edited pack cue map can
 * never silently degrade the SFX gates (a cue map that doesn't parse means the gates
 * cannot know which cues are required → the SFX gates refuse, never pass).
 */
export function validateCueMapSchema(raw: unknown): CueMapParseResult {
  const refusals: string[] = [];
  if (!isObject(raw)) {
    return { ok: false, refusals: ["cue-map: root is not an object"] };
  }
  if (typeof raw.schemaVersion !== "string" || raw.schemaVersion.length === 0) {
    refusals.push("cue-map: `schemaVersion` must be a non-empty string");
  }
  if (typeof raw.id !== "string" || raw.id.length === 0) {
    refusals.push("cue-map: `id` must be a non-empty string");
  }

  const honestyRules: CueMapHonestyRule[] = [];
  if (raw.honestyRules !== undefined) {
    if (!Array.isArray(raw.honestyRules)) {
      refusals.push("cue-map: `honestyRules` must be an array");
    } else {
      raw.honestyRules.forEach((r, i) => {
        if (!isObject(r) || typeof r.id !== "string" || typeof r.rule !== "string") {
          refusals.push(`cue-map: honestyRules[${i}] must have string \`id\` and \`rule\``);
        } else {
          honestyRules.push({ id: r.id, rule: r.rule });
        }
      });
    }
  }

  const cues: CueDecl[] = [];
  if (!Array.isArray(raw.cues) || raw.cues.length === 0) {
    refusals.push("cue-map: `cues` must be a non-empty array");
  } else {
    const seen = new Set<string>();
    raw.cues.forEach((c, i) => {
      if (!isObject(c) || typeof c.id !== "string" || c.id.length === 0) {
        refusals.push(`cue-map: cues[${i}] must have a non-empty string \`id\``);
        return;
      }
      const id = c.id;
      if (seen.has(id)) {
        refusals.push(`cue-map: cue \`${id}\` is declared more than once`);
        return;
      }
      seen.add(id);

      let ok = true;
      if (typeof c.event !== "string" || c.event.length === 0) {
        refusals.push(`cue \`${id}\`: \`event\` must be a non-empty string (the game-event binding)`);
        ok = false;
      }
      if (c.required !== undefined && typeof c.required !== "boolean") {
        refusals.push(`cue \`${id}\`: \`required\` must be a boolean when present`);
        ok = false;
      }
      if (typeof c.frequency !== "string" || !CUE_FREQUENCIES.has(c.frequency)) {
        refusals.push(`cue \`${id}\`: \`frequency\` must be one of ${[...CUE_FREQUENCIES].join("/")}`);
        ok = false;
      }
      if (typeof c.priority !== "string" || !CUE_PRIORITIES.has(c.priority)) {
        refusals.push(`cue \`${id}\`: \`priority\` must be one of ${[...CUE_PRIORITIES].join("/")}`);
        ok = false;
      }
      if (typeof c.mixerBus !== "string" || !CUE_MIXER_BUSES.has(c.mixerBus)) {
        refusals.push(`cue \`${id}\`: \`mixerBus\` must be one of ${[...CUE_MIXER_BUSES].join("/")}`);
        ok = false;
      }
      const layerRoles: CueLayerRole[] = [];
      if (!Array.isArray(c.layerRoles) || c.layerRoles.length === 0) {
        refusals.push(`cue \`${id}\`: \`layerRoles\` must be a non-empty array`);
        ok = false;
      } else {
        const seenRoles = new Set<string>();
        c.layerRoles.forEach((r, j) => {
          if (typeof r !== "string" || !CUE_LAYER_ROLES.has(r)) {
            refusals.push(`cue \`${id}\`: layerRoles[${j}] \`${String(r)}\` is not one of ${[...CUE_LAYER_ROLES].join("/")}`);
          } else if (seenRoles.has(r)) {
            refusals.push(`cue \`${id}\`: layerRoles[${j}] \`${r}\` is duplicated`);
          } else {
            seenRoles.add(r);
            layerRoles.push(r as CueLayerRole);
          }
        });
      }
      let spatial: CueSpatialPolicy | undefined;
      if (!isObject(c.spatial) || typeof c.spatial.mode !== "string" || !CUE_SPATIAL_MODES.has(c.spatial.mode)) {
        refusals.push(`cue \`${id}\`: \`spatial.mode\` must be one of ${[...CUE_SPATIAL_MODES].join("/")}`);
        ok = false;
      } else {
        const rollRaw = c.spatial.rolloff;
        if (rollRaw !== undefined && (typeof rollRaw !== "string" || !CUE_ROLLOFF_CLASSES.has(rollRaw))) {
          refusals.push(`cue \`${id}\`: \`spatial.rolloff\` must be one of ${[...CUE_ROLLOFF_CLASSES].join("/")}`);
          ok = false;
        } else {
          spatial = {
            mode: c.spatial.mode as CueSpatialMode,
            rolloff: typeof rollRaw === "string" ? (rollRaw as CueRolloffClass) : undefined,
          };
        }
      }

      const partial: CueDecl = {
        id,
        event: typeof c.event === "string" ? c.event : "",
        required: c.required === true,
        frequency: c.frequency as CueFrequency,
        priority: c.priority as CuePriority,
        mixerBus: c.mixerBus as CueMixerBus,
        layerRoles,
        spatial: spatial ?? { mode: "2d" },
        meaning: typeof c.meaning === "string" ? c.meaning : undefined,
        note: typeof c.note === "string" ? c.note : undefined,
      };
      const variantPolicy = parseVariantPolicy(c.variantPolicy, partial, refusals);
      const payloadMapping = parsePayloadMapping(c.payloadMapping, id, refusals);
      partial.variantPolicy = variantPolicy;
      partial.payloadMapping = payloadMapping;

      // Learning #2 encoded as a schema invariant: a FREQUENT cue must declare a
      // variant policy (count >= 2, no-immediate-repeat) — frequent single-clip cues
      // are the fatigue bug the dogfood pass fixed.
      if (partial.frequency === "frequent") {
        if (!variantPolicy) {
          refusals.push(
            `cue \`${id}\`: frequency \`frequent\` requires a variantPolicy (frequent cues fatigue without variants — learning #2)`,
          );
        } else if (!variantPolicy.noImmediateRepeat || variantPolicy.count < 2) {
          refusals.push(
            `cue \`${id}\`: a frequent cue's variantPolicy must have count >= 2 and noImmediateRepeat:true (anti-fatigue)`,
          );
        }
      }
      // A critical cue that is optional is contradictory — a critical cue is by
      // definition one whose absence is a defect.
      if (partial.priority === "critical" && partial.required !== true) {
        refusals.push(`cue \`${id}\`: priority \`critical\` requires \`required: true\` (an optional critical cue is contradictory)`);
      }

      if (ok) cues.push(partial);
    });
  }

  if (refusals.length > 0) {
    return { ok: false, refusals: [...refusals].sort() };
  }
  const schema: CueMapSchema = {
    schemaVersion: raw.schemaVersion as string,
    id: raw.id as string,
    genre: typeof raw.genre === "string" ? raw.genre : undefined,
    note: typeof raw.note === "string" ? raw.note : undefined,
    honestyRules,
    cues,
  };
  return { ok: true, refusals: [], schema };
}

/** Required cue ids, in declared order. */
export function requiredCueIds(schema: CueMapSchema): string[] {
  return schema.cues.filter((c) => c.required === true).map((c) => c.id);
}

/** Cues that declare an enforceable no-immediate-repeat policy (count >= 2). */
export function noRepeatCues(schema: CueMapSchema): CueDecl[] {
  return schema.cues.filter((c) => c.variantPolicy?.noImmediateRepeat === true && c.variantPolicy.count >= 2);
}

// At runtime this compiles to dist/capabilities/sfx/cue-map.js, so the package root is
// three levels up. Pack artifacts (.json) are read from src/ (tsc does not copy .json
// into dist), the same convention telemetry/schema.ts + genre-registry.ts use.
const PKG_ROOT = packageRoot(import.meta.url);

/**
 * Resolve the on-disk path to a genre pack's cue-map artifact
 * (`src/capabilities/genre/genre-packs/<genre>/cue-map.json`). Pure path construction — does
 * NOT check existence (the caller reads + validates, refusing on a missing file). The
 * genre id is constrained to a single path segment so it cannot escape the packs dir.
 */
export function cueMapPathForGenre(genreId: string): string | null {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(genreId)) return null;
  return path.join(PKG_ROOT, "src", "capabilities", "genre", "genre-packs", genreId, "cue-map.json");
}

/**
 * Advisory cross-check (review D5): cue `event` names vs a telemetry schema's closed
 * event-type set. Returns one WARNING string per cue whose event matches no telemetry
 * event type. ADVISORY only, never a refusal — cue events are intentionally free
 * strings (the runtime binding is game-side); a telemetry-backed name simply enables
 * cross-verification between the cue map and the run's event stream. Pure.
 */
export function cueEventTelemetryWarnings(
  cueMap: CueMapSchema,
  telemetry: TelemetrySchema,
): string[] {
  const types = new Set(telemetry.eventStream.events.map((e) => e.type));
  return cueMap.cues
    .filter((c) => !types.has(c.event))
    .map(
      (c) =>
        `cue \`${c.id}\`: event \`${c.event}\` matches no telemetry event type in \`${telemetry.id}\` (advisory — cue events are free strings bound game-side; a telemetry-backed name enables cross-verification)`,
    );
}

/**
 * Genre-level convenience for the D5 cross-check: when a genre pack ships BOTH a
 * cue map AND a telemetry schema (each present AND valid), return the advisory
 * warnings; otherwise `[]` — the cross-check applies only when both artifacts are
 * resolvable (a missing/invalid artifact is the artifact's own loader/validator's
 * refusal, not this check's).
 */
export async function crossCheckGenreCueEvents(genreId: string): Promise<string[]> {
  const cuePath = cueMapPathForGenre(genreId);
  const telemetryPath = telemetrySchemaPathForGenre(genreId);
  if (!cuePath || !telemetryPath) return [];
  let cueRaw: unknown;
  let telemetryRaw: unknown;
  try {
    cueRaw = JSON.parse(await fs.readFile(cuePath, "utf8"));
    telemetryRaw = JSON.parse(await fs.readFile(telemetryPath, "utf8"));
  } catch {
    return [];
  }
  const cueParsed = validateCueMapSchema(cueRaw);
  const telemetryParsed = validateTelemetrySchema(telemetryRaw);
  if (!cueParsed.ok || !cueParsed.schema || !telemetryParsed.ok || !telemetryParsed.schema) {
    return [];
  }
  return cueEventTelemetryWarnings(cueParsed.schema, telemetryParsed.schema);
}
