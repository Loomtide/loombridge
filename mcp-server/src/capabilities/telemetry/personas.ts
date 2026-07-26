/**
 * Persona contract — a GENRE-PACK-OWNED artifact (plan §8 "Bots Tune Balance, Humans
 * Judge Fun"; dogfood backlog High #5). It declares the SCRIPTED heuristic bot personas
 * (Timid / Balanced / Greedy / Reckless) used as a deterministic balance + regression
 * proxy — NEVER a fun judge, NEVER learned AI.
 *
 * The durable dogfood rules this schema encodes:
 *  - Persona INTENT is defined BEFORE pass rates. A persona with no `intent` is REFUSED
 *    (you cannot measure a persona against a role it never stated). This is the whole
 *    reason the field is required-and-non-empty rather than optional prose.
 *  - Behavioral DIALS carry plausible-range bands (`min`..`max`) so a persona is a set of
 *    named, bounded knobs, not free text — a dial with `min > max` is refused.
 *  - The expected-outcome ENVELOPE is expressed as metric bands over the TELEMETRY
 *    schema's summary fields, referenced BY NAME, so the two schemas stay BOUND: an
 *    envelope field that is not a declared telemetry summary field is a REFUSAL (mirrors
 *    the telemetry validator's "an absent bound field is a refusal, not a skip" rule).
 *  - CALIBRATION is explicit: `calibrated: boolean` + a `calibrationEvidence` pointer. A
 *    persona that CLAIMS calibration (`calibrated: true`) with no evidence is REFUSED — a
 *    balance claim resting on an uncalibrated bot is exactly what the doc warns against
 *    ("calibrate personas before tuning the game around their failures").
 *
 * The bot RUNTIME is game-side C#; this module ships only the CONTRACT + its validator.
 * Pure TS, engine-agnostic, deterministic (sorted refusals).
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

import type { TelemetrySchema } from "./schema.js";
import { packageRoot } from "../../shared/pkg-root.js";

/** How an envelope band's observed value is derived from the telemetry runs. */
export type PersonaEnvelopeStat = "mean" | "rate";

/** A named behavioral knob with a plausible-range band. */
export interface PersonaDial {
  name: string;
  min: number;
  max: number;
  unit?: string;
  description?: string;
}

/**
 * One expected-outcome band, bound BY NAME to a telemetry summary field.
 *  - `stat: "mean"` — band over the MEAN of a numeric summary field (e.g. bankedValue).
 *  - `stat: "rate"` — band over the FRACTION of runs whose (segmentable) field equals
 *    `equals` (e.g. the extraction rate = rate over `outcome` == "extracted"). A rate
 *    band must lie within [0,1]; its denominator is the runs where the field is PRESENT.
 *
 * MISSING-DATA DESIGN (deliberate): a band MAY name an OPTIONAL telemetry field — the
 * validator does NOT require `required: true` on bound fields, because the persona
 * report ALWAYS carries + renders per-band `observedCount`/`missingCount`, so a shrunken
 * sample is surfaced at the point of grading rather than banned at the point of authoring
 * (e.g. `extractionCompleteMs` is honestly absent on runs that died).
 */
export interface PersonaEnvelopeBand {
  field: string;
  stat: PersonaEnvelopeStat;
  /** Required when `stat: "rate"`: the field VALUE whose fraction is banded. */
  equals?: string;
  min: number;
  max: number;
  unit?: string;
  description?: string;
}

/** One persona: intent (before pass rates), dials, expected-outcome envelope, calibration. */
export interface PersonaEntry {
  id: string;
  intent: string;
  dials: PersonaDial[];
  envelope: PersonaEnvelopeBand[];
  calibrated: boolean;
  /** Pointer to calibration evidence (report path / run-set id). Required when calibrated. */
  calibrationEvidence: string | null;
}

/** The genre-pack persona contract. */
export interface PersonaContract {
  schemaVersion: string;
  id: string;
  genre?: string;
  /**
   * REQUIRED: must equal the bound telemetry schema's `id`. The binding is EXPLICIT —
   * an id-less contract would silently bind to whatever schema the caller happened to
   * pass, which is exactly the drift this field exists to refuse.
   */
  telemetrySchemaId: string;
  /** The telemetry summary field carrying the persona id (must be segmentable). */
  personaField: string;
  /** What the game-side C# bot MUST emit — the implementation contract (documentation). */
  implementationContract?: string;
  note?: string;
  personas: PersonaEntry[];
}

export interface PersonaContractParseResult {
  ok: boolean;
  refusals: string[];
  /**
   * ADVISORY warnings (never block `ok`). Today: an `intent` statement containing a
   * judgment word (better/worse/fun/…) — intent is contract-author prose rendered
   * VERBATIM by the persona report (the structural template scan cannot reach it), so
   * the validator nudges the author toward behavior-stating intents without blocking
   * data. Deterministically sorted.
   */
  warnings: string[];
  contract?: PersonaContract;
}

/**
 * Judgment words the persona report's no-fun-verdict guard bans from its TEMPLATES.
 * The validator scans contract-author `intent` prose against the same list — as a WARN,
 * not a refusal (data is the author's; the report renders it verbatim).
 */
export const PERSONA_JUDGMENT_WORDS =
  /\b(better|worse|improved|improvement|regressed|regression|good|bad|fun)\b/i;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * Validate a raw parsed object as a `PersonaContract`, BOUND to `telemetrySchema`.
 * Refuse-shaped: returns every structural + binding problem (deterministically sorted),
 * and `contract` only when `ok`.
 *
 * The cross-schema binding is deliberate: an envelope band names a telemetry summary
 * field, and an ABSENT / wrong-shaped bound field is a REFUSAL (never a skipped check) —
 * so a persona's expected-outcome envelope can never drift free of the telemetry schema
 * it is graded against.
 */
export function validatePersonaContract(
  raw: unknown,
  telemetrySchema: TelemetrySchema,
): PersonaContractParseResult {
  const refusals: string[] = [];
  const warnings: string[] = [];
  if (!isObject(raw)) {
    return { ok: false, refusals: ["personas: root is not an object"], warnings: [] };
  }

  if (typeof raw.schemaVersion !== "string" || raw.schemaVersion.length === 0) {
    refusals.push("personas: `schemaVersion` must be a non-empty string");
  }
  if (typeof raw.id !== "string" || raw.id.length === 0) {
    refusals.push("personas: `id` must be a non-empty string");
  }

  // telemetrySchemaId is REQUIRED and must match the bound schema: an id-less contract
  // would bind silently to whatever schema the caller passed — make the binding explicit.
  if (typeof raw.telemetrySchemaId !== "string" || raw.telemetrySchemaId.length === 0) {
    refusals.push(
      "personas: `telemetrySchemaId` must be a non-empty string — the contract must NAME the telemetry schema it binds to (an id-less contract would silently bind to whatever schema is passed)",
    );
  } else if (raw.telemetrySchemaId !== telemetrySchema.id) {
    refusals.push(
      `personas: \`telemetrySchemaId\` \`${raw.telemetrySchemaId}\` ≠ bound telemetry schema id \`${telemetrySchema.id}\` (the persona contract is bound to the wrong telemetry schema)`,
    );
  }

  // Build the telemetry summary field index once (name -> field), for binding checks.
  const summaryByName = new Map(telemetrySchema.runSummary.fields.map((f) => [f.name, f]));

  // personaField: a declared, SEGMENTABLE summary field carrying the persona id.
  if (typeof raw.personaField !== "string" || raw.personaField.length === 0) {
    refusals.push("personas: `personaField` must be a non-empty string");
  } else {
    const pf = summaryByName.get(raw.personaField);
    if (!pf) {
      refusals.push(
        `personas: \`personaField\` \`${raw.personaField}\` is not a declared telemetry summary field (add it to the telemetry schema, then bind it here)`,
      );
    } else if (!pf.segmentable) {
      refusals.push(
        `personas: \`personaField\` \`${raw.personaField}\` is not \`segmentable\` in the telemetry schema — a persona segmentation field must be segmentable`,
      );
    }
  }

  // personas array
  const personas: PersonaEntry[] = [];
  if (!Array.isArray(raw.personas)) {
    refusals.push("personas: `personas` must be an array");
  } else if (raw.personas.length === 0) {
    refusals.push("personas: `personas` must declare at least one persona");
  } else {
    const seenIds = new Set<string>();
    raw.personas.forEach((p, i) => {
      if (!isObject(p)) {
        refusals.push(`personas[${i}]: must be an object`);
        return;
      }
      const label = typeof p.id === "string" && p.id.length > 0 ? p.id : `[${i}]`;
      if (typeof p.id !== "string" || p.id.length === 0) {
        refusals.push(`personas[${i}]: \`id\` must be a non-empty string`);
      } else if (seenIds.has(p.id)) {
        refusals.push(`personas: persona id \`${p.id}\` is declared more than once`);
      } else {
        seenIds.add(p.id);
      }

      // INTENT before pass rates: a persona with no intent cannot be measured.
      if (typeof p.intent !== "string" || p.intent.trim().length === 0) {
        refusals.push(
          `personas \`${label}\`: \`intent\` must be a non-empty string — persona intent is defined BEFORE pass rates (refusing an intent-less persona)`,
        );
      } else if (PERSONA_JUDGMENT_WORDS.test(p.intent)) {
        // ADVISORY (never blocks): intent is author prose the report renders verbatim —
        // the structural template scan cannot reach it, so nudge here.
        warnings.push(
          `personas \`${label}\`: \`intent\` contains a judgment word (${p.intent.match(PERSONA_JUDGMENT_WORDS)![0]}) — intent should state BEHAVIOR, not quality; the persona report renders this prose verbatim and its no-judgment guard only covers its own templates`,
        );
      }

      // calibration: explicit boolean; a calibration CLAIM needs evidence.
      let calibrated = false;
      if (typeof p.calibrated !== "boolean") {
        refusals.push(`personas \`${label}\`: \`calibrated\` must be a boolean`);
      } else {
        calibrated = p.calibrated;
      }
      let calibrationEvidence: string | null = null;
      const hasEvidence = typeof p.calibrationEvidence === "string" && p.calibrationEvidence.trim().length > 0;
      if (hasEvidence) calibrationEvidence = p.calibrationEvidence as string;
      if (calibrated && !hasEvidence) {
        refusals.push(
          `personas \`${label}\`: \`calibrated: true\` requires a non-empty \`calibrationEvidence\` pointer — a balance claim resting on an uncalibrated bot is refused (calibrate before trusting the persona)`,
        );
      }

      // dials: named, bounded knobs.
      const dials: PersonaDial[] = [];
      if (!Array.isArray(p.dials)) {
        refusals.push(`personas \`${label}\`: \`dials\` must be an array`);
      } else {
        const seenDials = new Set<string>();
        p.dials.forEach((d, j) => {
          if (!isObject(d) || typeof d.name !== "string" || d.name.length === 0) {
            refusals.push(`personas \`${label}\`: dials[${j}] must have a non-empty string \`name\``);
            return;
          }
          if (seenDials.has(d.name)) {
            refusals.push(`personas \`${label}\`: dial \`${d.name}\` is declared more than once`);
            return;
          }
          seenDials.add(d.name);
          if (!isFiniteNumber(d.min) || !isFiniteNumber(d.max)) {
            refusals.push(`personas \`${label}\`: dial \`${d.name}\` must have finite numeric \`min\` and \`max\``);
            return;
          }
          if (d.min > d.max) {
            refusals.push(`personas \`${label}\`: dial \`${d.name}\` has min ${d.min} > max ${d.max}`);
            return;
          }
          dials.push({
            name: d.name,
            min: d.min,
            max: d.max,
            unit: typeof d.unit === "string" ? d.unit : undefined,
            description: typeof d.description === "string" ? d.description : undefined,
          });
        });
      }

      // envelope: expected-outcome bands, BOUND by name to telemetry summary fields.
      const envelope: PersonaEnvelopeBand[] = [];
      if (!Array.isArray(p.envelope)) {
        refusals.push(`personas \`${label}\`: \`envelope\` must be an array`);
      } else if (p.envelope.length === 0) {
        refusals.push(
          `personas \`${label}\`: \`envelope\` must declare at least one expected-outcome band (an unbanded persona cannot be checked for drift)`,
        );
      } else {
        p.envelope.forEach((b, j) => {
          if (!isObject(b) || typeof b.field !== "string" || b.field.length === 0) {
            refusals.push(`personas \`${label}\`: envelope[${j}] must have a non-empty string \`field\``);
            return;
          }
          const stat = b.stat;
          if (stat !== "mean" && stat !== "rate") {
            refusals.push(`personas \`${label}\`: envelope field \`${b.field}\` has invalid \`stat\` \`${String(stat)}\` (want "mean" or "rate")`);
            return;
          }
          // BINDING: the field must be a declared telemetry summary field.
          const decl = summaryByName.get(b.field);
          if (!decl) {
            refusals.push(
              `personas \`${label}\`: envelope field \`${b.field}\` is not a declared telemetry summary field (bind envelopes to the telemetry schema BY NAME)`,
            );
            return;
          }
          if (!isFiniteNumber(b.min) || !isFiniteNumber(b.max)) {
            refusals.push(`personas \`${label}\`: envelope band \`${b.field}\` must have finite numeric \`min\` and \`max\``);
            return;
          }
          if (b.min > b.max) {
            refusals.push(`personas \`${label}\`: envelope band \`${b.field}\` has min ${b.min} > max ${b.max}`);
            return;
          }
          if (stat === "mean") {
            if (decl.type !== "number" && decl.type !== "integer") {
              refusals.push(
                `personas \`${label}\`: envelope band \`${b.field}\` uses stat "mean" but the telemetry field is \`${decl.type}\`, not numeric`,
              );
              return;
            }
          } else {
            // rate: the field must be categorical (segmentable), `equals` required, band in [0,1].
            if (!decl.segmentable) {
              refusals.push(
                `personas \`${label}\`: envelope band \`${b.field}\` uses stat "rate" but the telemetry field is not \`segmentable\` (a rate is a fraction over a categorical field's value)`,
              );
              return;
            }
            if (typeof b.equals !== "string" || b.equals.length === 0) {
              refusals.push(
                `personas \`${label}\`: envelope band \`${b.field}\` uses stat "rate" and requires a non-empty \`equals\` (the field value whose fraction is banded)`,
              );
              return;
            }
            if (b.min < 0 || b.max > 1) {
              refusals.push(
                `personas \`${label}\`: envelope band \`${b.field}\` is a rate but its band [${b.min}, ${b.max}] leaves [0,1]`,
              );
              return;
            }
          }
          envelope.push({
            field: b.field,
            stat,
            equals: stat === "rate" ? (b.equals as string) : undefined,
            min: b.min,
            max: b.max,
            unit: typeof b.unit === "string" ? b.unit : undefined,
            description: typeof b.description === "string" ? b.description : undefined,
          });
        });
      }

      if (typeof p.id === "string" && p.id.length > 0) {
        personas.push({
          id: p.id,
          intent: typeof p.intent === "string" ? p.intent : "",
          dials,
          envelope,
          calibrated,
          calibrationEvidence,
        });
      }
    });
  }

  if (refusals.length > 0) {
    return { ok: false, refusals: [...refusals].sort(), warnings: [...warnings].sort() };
  }

  const contract: PersonaContract = {
    schemaVersion: raw.schemaVersion as string,
    id: raw.id as string,
    genre: typeof raw.genre === "string" ? raw.genre : undefined,
    telemetrySchemaId: raw.telemetrySchemaId as string,
    personaField: raw.personaField as string,
    implementationContract: typeof raw.implementationContract === "string" ? raw.implementationContract : undefined,
    note: typeof raw.note === "string" ? raw.note : undefined,
    personas,
  };
  return { ok: true, refusals: [], warnings: [...warnings].sort(), contract };
}

// Mirrors telemetrySchemaPathForGenre: pack artifacts live under src/ (tsc does not copy
// .json into dist). PKG_ROOT is three levels up from dist/capabilities/telemetry/personas.js.
const PKG_ROOT = packageRoot(import.meta.url);

/**
 * Resolve the on-disk path to a genre pack's persona contract artifact
 * (`src/capabilities/genre/genre-packs/<genre>/personas.json`). Pure path construction — does NOT
 * check existence. The genre id is constrained to a single path segment so it cannot
 * escape the packs dir.
 */
export function personaContractPathForGenre(genreId: string): string | null {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(genreId)) return null;
  return path.join(PKG_ROOT, "src", "capabilities", "genre", "genre-packs", genreId, "personas.json");
}
