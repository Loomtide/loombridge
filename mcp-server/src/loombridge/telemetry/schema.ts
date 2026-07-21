/**
 * Telemetry schema — a GENRE-PACK-OWNED artifact (plan §7 "Telemetry Is The Tuning
 * Substrate"; dogfood backlog High #4).
 *
 * the dogfood project's telemetry was ad-hoc debug output with honesty bugs: a `seen` field that
 * was really proximity, ambiguous lost-vs-banked values, unescaped event JSON, and
 * stale-vs-fresh summary confusion. The durable lesson is that a telemetry schema is
 * part of the genre pack, not something an agent invents per run. This module defines
 * the schema TYPE and a self-validating loader; the seed schema lives on disk as a
 * pack artifact (`genre-packs/<genre>/telemetry.json`).
 *
 * The schema declares two surfaces:
 *  - `runSummary`  — the typed per-run summary fields (name/type/unit + honesty
 *                    guidance in `description`), plus the FRESHNESS fields that bind a
 *                    summary to its event stream (mirrors the isFreshGreen producedAt
 *                    discipline in CLAUDE.md).
 *  - `eventStream` — the closed set of event types and their typed payloads.
 *
 * This file is deterministic and engine-agnostic (pure TS, no bridge/C#).
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

/** The primitive types a telemetry field may declare. `integer` is a whole `number`. */
export type TelemetryFieldType = "string" | "number" | "integer" | "boolean";

/** How a numeric summary field is rolled up by the tuning report. Only `mean` today. */
export type TelemetryAggregate = "mean";

/** A typed per-run summary field. */
export interface TelemetrySummaryField {
  name: string;
  type: TelemetryFieldType;
  /** Physical unit (e.g. `ms`, `m`, `pts`). Documentation only. */
  unit?: string;
  /** When true, a run summary that omits this field is REFUSED by the validator. */
  required?: boolean;
  /** When true, the tuning report may segment aggregates by this field's value. */
  segmentable?: boolean;
  /** When set, a numeric field the tuning report rolls up (mean/min/max/sum/count). */
  aggregate?: TelemetryAggregate;
  /**
   * `events-file` marks the field (the run id) that binds a summary to its event
   * stream: every event MUST carry the same-named property AND it must match the
   * summary's value, or the run is refused (the stale/cross-run mix-up the dogfood project hit).
   * An event that OMITS the binding field is a refusal, not a skip — otherwise a
   * stale events file renamed to a fresh summary's stem would pair cleanly.
   * RESIDUAL LIMIT (honest): events carry no independent `producedAt`; freshness
   * rides the summary's `producedAt` plus this required per-event binding, nothing
   * more.
   */
  binding?: "events-file";
  /**
   * Declared value format. `iso-8601` values are validated with `Date.parse` — an
   * unparseable value is a REFUSAL (a `producedAt` that cannot be placed in time
   * cannot establish freshness).
   */
  format?: "iso-8601";
  /** Honesty guidance — WHAT this field actually measures (the anti-`seen` rule). */
  description?: string;
}

/** A typed field inside an event payload. */
export interface TelemetryPayloadField {
  name: string;
  type: TelemetryFieldType;
  unit?: string;
  required?: boolean;
  description?: string;
}

/** A declared event type and its typed payload (the closed set the validator enforces). */
export interface TelemetryEventType {
  type: string;
  description?: string;
  payload: TelemetryPayloadField[];
}

/** A named naming-honesty rule lifted from the learnings doc, carried with the schema. */
export interface TelemetryHonestyRule {
  id: string;
  rule: string;
}

/** The genre-pack telemetry schema. */
export interface TelemetrySchema {
  schemaVersion: string;
  id: string;
  genre?: string;
  note?: string;
  honestyRules: TelemetryHonestyRule[];
  runSummary: {
    /**
     * Fields a fresh, non-stale summary MUST carry (the run id + `producedAt`). A
     * missing freshness field is a REFUSAL, never a skipped check — mirrors
     * `isFreshGreen`'s "refuse a missing producedAt" discipline (CLAUDE.md).
     */
    requiredFreshnessFields: string[];
    fields: TelemetrySummaryField[];
  };
  eventStream: {
    /** The event property carrying the event timestamp (checked monotonic). */
    timestampField: string;
    timestampUnit?: string;
    /**
     * Timestamp-ordering contract. `global` (the default): the stream is ONE
     * globally time-sorted sequence — every event's timestamp is >= the previous
     * event's, regardless of type. `per-entity`: timestamps are monotonic within
     * each entity lane, keyed by `entityField` (events that don't carry the field
     * share one common lane) — the realistic emitter shape when several entities
     * (e.g. multiple enemies) interleave samples.
     */
    monotonicity: "global" | "per-entity";
    /** The event property keying per-entity lanes. Required when `per-entity`. */
    entityField?: string;
    events: TelemetryEventType[];
  };
}

const FIELD_TYPES: ReadonlySet<string> = new Set<TelemetryFieldType>([
  "string",
  "number",
  "integer",
  "boolean",
]);

/** Result of validating a raw object AS a telemetry schema (the schema of schemas). */
export interface TelemetrySchemaParseResult {
  ok: boolean;
  refusals: string[];
  schema?: TelemetrySchema;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Validate a raw parsed object as a `TelemetrySchema`. Refuse-shaped: returns every
 * structural problem (deterministically sorted), and `schema` only when `ok`.
 *
 * This guards the schema artifact itself so a malformed/hand-edited pack schema can
 * never silently degrade run validation into a no-op.
 */
export function validateTelemetrySchema(raw: unknown): TelemetrySchemaParseResult {
  const refusals: string[] = [];
  if (!isObject(raw)) {
    return { ok: false, refusals: ["schema: root is not an object"] };
  }

  if (typeof raw.schemaVersion !== "string" || raw.schemaVersion.length === 0) {
    refusals.push("schema: `schemaVersion` must be a non-empty string");
  }
  if (typeof raw.id !== "string" || raw.id.length === 0) {
    refusals.push("schema: `id` must be a non-empty string");
  }

  // honestyRules
  const honestyRules: TelemetryHonestyRule[] = [];
  if (raw.honestyRules !== undefined) {
    if (!Array.isArray(raw.honestyRules)) {
      refusals.push("schema: `honestyRules` must be an array");
    } else {
      raw.honestyRules.forEach((r, i) => {
        if (!isObject(r) || typeof r.id !== "string" || typeof r.rule !== "string") {
          refusals.push(`schema: honestyRules[${i}] must have string \`id\` and \`rule\``);
        } else {
          honestyRules.push({ id: r.id, rule: r.rule });
        }
      });
    }
  }

  // runSummary
  const summaryFields: TelemetrySummaryField[] = [];
  let requiredFreshnessFields: string[] = [];
  if (!isObject(raw.runSummary)) {
    refusals.push("schema: `runSummary` must be an object");
  } else {
    const rs = raw.runSummary;
    if (!Array.isArray(rs.requiredFreshnessFields) || rs.requiredFreshnessFields.some((f) => typeof f !== "string")) {
      refusals.push("schema: `runSummary.requiredFreshnessFields` must be a string[]");
    } else {
      requiredFreshnessFields = rs.requiredFreshnessFields as string[];
    }
    if (!Array.isArray(rs.fields)) {
      refusals.push("schema: `runSummary.fields` must be an array");
    } else {
      const seen = new Set<string>();
      rs.fields.forEach((f, i) => {
        if (!isObject(f) || typeof f.name !== "string" || f.name.length === 0) {
          refusals.push(`schema: runSummary.fields[${i}] must have a non-empty string \`name\``);
          return;
        }
        if (typeof f.type !== "string" || !FIELD_TYPES.has(f.type)) {
          refusals.push(`schema: runSummary field \`${f.name}\` has invalid type \`${String(f.type)}\``);
          return;
        }
        if (seen.has(f.name)) {
          refusals.push(`schema: runSummary field \`${f.name}\` is declared more than once`);
          return;
        }
        if (f.format !== undefined && f.format !== "iso-8601") {
          refusals.push(
            `schema: runSummary field \`${f.name}\` has invalid format \`${String(f.format)}\` (only "iso-8601" is supported)`,
          );
          return;
        }
        seen.add(f.name);
        summaryFields.push({
          name: f.name,
          type: f.type as TelemetryFieldType,
          unit: typeof f.unit === "string" ? f.unit : undefined,
          required: f.required === true,
          segmentable: f.segmentable === true,
          aggregate: f.aggregate === "mean" ? "mean" : undefined,
          binding: f.binding === "events-file" ? "events-file" : undefined,
          format: f.format === "iso-8601" ? "iso-8601" : undefined,
          description: typeof f.description === "string" ? f.description : undefined,
        });
      });
      // Every declared freshness field must be a declared summary field.
      for (const ff of requiredFreshnessFields) {
        if (!seen.has(ff)) {
          refusals.push(`schema: freshness field \`${ff}\` is not a declared runSummary field`);
        }
      }
    }
  }

  // eventStream
  let timestampField = "";
  let timestampUnit: string | undefined;
  let monotonicity: "global" | "per-entity" = "global";
  let entityField: string | undefined;
  const events: TelemetryEventType[] = [];
  if (!isObject(raw.eventStream)) {
    refusals.push("schema: `eventStream` must be an object");
  } else {
    const es = raw.eventStream;
    if (typeof es.timestampField !== "string" || es.timestampField.length === 0) {
      refusals.push("schema: `eventStream.timestampField` must be a non-empty string");
    } else {
      timestampField = es.timestampField;
    }
    if (typeof es.timestampUnit === "string") timestampUnit = es.timestampUnit;
    if (es.monotonicity !== undefined && es.monotonicity !== "global" && es.monotonicity !== "per-entity") {
      refusals.push(
        `schema: \`eventStream.monotonicity\` must be "global" or "per-entity", got \`${String(es.monotonicity)}\``,
      );
    } else if (es.monotonicity === "per-entity") {
      monotonicity = "per-entity";
      if (typeof es.entityField !== "string" || es.entityField.length === 0) {
        refusals.push('schema: per-entity monotonicity requires a non-empty `eventStream.entityField`');
      } else {
        entityField = es.entityField;
      }
    }
    if (!Array.isArray(es.events)) {
      refusals.push("schema: `eventStream.events` must be an array");
    } else {
      const seenTypes = new Set<string>();
      es.events.forEach((e, i) => {
        if (!isObject(e) || typeof e.type !== "string" || e.type.length === 0) {
          refusals.push(`schema: eventStream.events[${i}] must have a non-empty string \`type\``);
          return;
        }
        if (seenTypes.has(e.type)) {
          refusals.push(`schema: event type \`${e.type}\` is declared more than once`);
          return;
        }
        seenTypes.add(e.type);
        const payload: TelemetryPayloadField[] = [];
        if (!Array.isArray(e.payload)) {
          refusals.push(`schema: event \`${e.type}\` \`payload\` must be an array`);
        } else {
          e.payload.forEach((p, j) => {
            if (!isObject(p) || typeof p.name !== "string" || p.name.length === 0) {
              refusals.push(`schema: event \`${e.type}\` payload[${j}] must have a non-empty string \`name\``);
              return;
            }
            if (typeof p.type !== "string" || !FIELD_TYPES.has(p.type)) {
              refusals.push(`schema: event \`${e.type}\` payload field \`${p.name}\` has invalid type \`${String(p.type)}\``);
              return;
            }
            payload.push({
              name: p.name,
              type: p.type as TelemetryFieldType,
              unit: typeof p.unit === "string" ? p.unit : undefined,
              required: p.required === true,
              description: typeof p.description === "string" ? p.description : undefined,
            });
          });
        }
        events.push({
          type: e.type,
          description: typeof e.description === "string" ? e.description : undefined,
          payload,
        });
      });
    }
  }

  if (refusals.length > 0) {
    return { ok: false, refusals: [...refusals].sort() };
  }

  const schema: TelemetrySchema = {
    schemaVersion: raw.schemaVersion as string,
    id: raw.id as string,
    genre: typeof raw.genre === "string" ? raw.genre : undefined,
    note: typeof raw.note === "string" ? raw.note : undefined,
    honestyRules,
    runSummary: { requiredFreshnessFields, fields: summaryFields },
    eventStream: { timestampField, timestampUnit, monotonicity, entityField, events },
  };
  return { ok: true, refusals: [], schema };
}

// At runtime this compiles to dist/loombridge/telemetry/schema.js, so the package root
// is three levels up. Pack artifacts (.json) are read from src/ (tsc does not copy
// .json into dist), the same convention genre-registry.ts uses.
const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/**
 * Resolve the on-disk path to a genre pack's telemetry schema artifact
 * (`src/loombridge/genre-packs/<genre>/telemetry.json`). Pure path construction — does
 * NOT check existence (the caller reads + validates, refusing on a missing file). The
 * genre id is constrained to a single path segment so it cannot escape the packs dir.
 */
export function telemetrySchemaPathForGenre(genreId: string): string | null {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(genreId)) return null;
  return path.join(PKG_ROOT, "src", "loombridge", "genre-packs", genreId, "telemetry.json");
}
