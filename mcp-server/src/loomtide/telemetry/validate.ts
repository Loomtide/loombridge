/**
 * `validateTelemetryRun` — the refuse-shaped gate over one telemetry run (a summary +
 * its event stream) against a genre-pack `TelemetrySchema`.
 *
 * The dogfood telemetry honesty bugs this exists to catch:
 *  - stale/fresh confusion       → FRESHNESS: a summary missing `producedAt` or its run
 *                                   id is REFUSED, never silently graded (mirrors the
 *                                   isFreshGreen producedAt discipline in CLAUDE.md);
 *                                   a `format: "iso-8601"` field that Date.parse cannot
 *                                   place in time is likewise refused.
 *  - cross-run event mix-up      → BINDING: when the schema declares a binding field,
 *                                   EVERY event must carry it AND match the summary —
 *                                   a missing binding field is a refusal, not a skip
 *                                   (else a stale events file renamed onto a fresh
 *                                   summary's stem pairs cleanly). RESIDUAL LIMIT
 *                                   (honest): events carry no independent producedAt;
 *                                   freshness rides the summary + this per-event
 *                                   binding, nothing more.
 *  - ad-hoc/unknown event kinds  → the event `type` must be in the schema's closed set.
 *  - wrong-typed / missing data  → summary + payload fields are type-checked; a missing
 *                                   REQUIRED field is refused.
 *  - out-of-order samples        → the event stream must be time-sorted: monotonic
 *                                   non-decreasing timestamps, either as one global
 *                                   stream (`monotonicity: "global"`) or within each
 *                                   entity lane (`"per-entity"`, keyed by the schema's
 *                                   `entityField` — the realistic shape when several
 *                                   emitters, e.g. multiple enemies, interleave).
 *
 * Every problem is a REFUSAL (never a skipped check); `ok` is true only when the run is
 * clean. Refusals are returned deterministically sorted so a report over them is stable.
 */

import type { TelemetryFieldType, TelemetrySchema } from "./schema.js";

export interface TelemetryValidationResult {
  ok: boolean;
  refusals: string[];
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** True when `value` conforms to the declared field type. */
function typeMatches(value: unknown, type: TelemetryFieldType): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "boolean":
      return typeof value === "boolean";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value);
  }
}

/**
 * Validate one run against the schema. `summary` is the parsed per-run summary object;
 * `events` is the parsed event stream (already JSON-parsed — a JSONL parse error is the
 * caller's refusal, distinct from a schema violation).
 */
export function validateTelemetryRun(
  summary: unknown,
  events: unknown,
  schema: TelemetrySchema,
): TelemetryValidationResult {
  const refusals: string[] = [];

  if (!isObject(summary)) {
    return { ok: false, refusals: ["summary: is not an object"] };
  }
  if (!Array.isArray(events)) {
    return { ok: false, refusals: ["events: is not an array"] };
  }

  // 1. Freshness — a missing freshness field cannot establish that the run is fresh
  //    (not stale). Refuse; do NOT quietly skip. Mirrors isFreshGreen.
  for (const ff of schema.runSummary.requiredFreshnessFields) {
    const v = summary[ff];
    if (v === undefined || v === null || (typeof v === "string" && v.length === 0)) {
      refusals.push(
        `freshness: summary field \`${ff}\` is absent/empty — cannot establish the run is fresh (refusing)`,
      );
    }
  }

  // 2. Required summary fields present + 3. type/format checks on present fields.
  for (const field of schema.runSummary.fields) {
    const present = Object.prototype.hasOwnProperty.call(summary, field.name);
    const v = present ? summary[field.name] : undefined;
    if (field.required && (v === undefined || v === null)) {
      refusals.push(`summary: required field \`${field.name}\` is absent`);
      continue;
    }
    if (v !== undefined && v !== null && !typeMatches(v, field.type)) {
      refusals.push(
        `summary: field \`${field.name}\` expected ${field.type}, got ${describe(v)}`,
      );
      continue;
    }
    // Format check: an unparseable ISO-8601 timestamp is refused — a value that
    // cannot be placed in time cannot establish freshness or order (D4).
    if (
      field.format === "iso-8601" &&
      typeof v === "string" &&
      v.length > 0 &&
      Number.isNaN(Date.parse(v))
    ) {
      refusals.push(
        `summary: field \`${field.name}\` is not parseable ISO-8601 (${describe(v)}) — cannot be placed in time (refusing)`,
      );
    }
  }

  // Run-id binding target: the events-file binding field's value on the summary.
  const bindingField = schema.runSummary.fields.find((f) => f.binding === "events-file");
  const bindingName = bindingField?.name;
  const bindingValue = bindingName ? summary[bindingName] : undefined;

  const eventTypes = new Map(schema.eventStream.events.map((e) => [e.type, e]));
  const tsField = schema.eventStream.timestampField;
  const { monotonicity, entityField } = schema.eventStream;

  // 4. Event stream: closed-set types, payload typing, binding, monotonic timestamps.
  // Timestamps are checked per LANE: one global lane, or per-entity lanes keyed by
  // `entityField` (events without the field share the "" lane) — see the module header.
  const lastTsByLane = new Map<string, number>();
  // Binding-missing events are collapsed into ONE refusal naming the first offending
  // line, so a wholesale-stale events file yields a readable refusal, not thousands.
  let bindingMissingCount = 0;
  let bindingMissingFirst = -1;
  events.forEach((raw, i) => {
    if (!isObject(raw)) {
      refusals.push(`events[${i}]: is not an object`);
      return;
    }
    const type = raw.type;
    if (typeof type !== "string" || type.length === 0) {
      refusals.push(`events[${i}]: missing string \`type\``);
      return;
    }
    const decl = eventTypes.get(type);
    if (!decl) {
      refusals.push(`events[${i}]: unknown event type \`${type}\` (not in schema closed set)`);
      return;
    }

    // Run-id binding: when the schema declares a binding field, EVERY event must carry
    // it and match the summary. A missing binding field is a refusal, not a skip —
    // otherwise a stale events file renamed onto a fresh summary's stem pairs cleanly.
    if (bindingName) {
      if (!Object.prototype.hasOwnProperty.call(raw, bindingName)) {
        bindingMissingCount += 1;
        if (bindingMissingFirst === -1) bindingMissingFirst = i;
      } else if (raw[bindingName] !== bindingValue) {
        refusals.push(
          `events[${i}] (${type}): \`${bindingName}\` ${describe(raw[bindingName])} ≠ summary ${describe(bindingValue)} (cross-run/stale binding)`,
        );
      }
    }

    // Payload typing + required presence.
    for (const p of decl.payload) {
      const has = Object.prototype.hasOwnProperty.call(raw, p.name);
      const pv = has ? raw[p.name] : undefined;
      if (p.required && (pv === undefined || pv === null)) {
        refusals.push(`events[${i}] (${type}): required payload field \`${p.name}\` is absent`);
        continue;
      }
      if (pv !== undefined && pv !== null && !typeMatches(pv, p.type)) {
        refusals.push(
          `events[${i}] (${type}): payload \`${p.name}\` expected ${p.type}, got ${describe(pv)}`,
        );
      }
    }

    // Monotonic timestamps — only meaningful when the event carries a numeric ts.
    const ts = raw[tsField];
    if (typeof ts === "number" && Number.isFinite(ts)) {
      let lane = "";
      if (monotonicity === "per-entity" && entityField) {
        const ev = raw[entityField];
        lane = typeof ev === "string" || typeof ev === "number" ? String(ev) : "";
      }
      const last = lastTsByLane.get(lane);
      if (last !== undefined && ts < last) {
        const laneNote = monotonicity === "per-entity" ? ` in lane \`${lane || "(no entity)"}\`` : "";
        refusals.push(
          `events[${i}] (${type}): timestamp ${ts} < previous ${last}${laneNote} (non-monotonic \`${tsField}\` — the event stream must be time-sorted, monotonicity: ${monotonicity})`,
        );
      }
      lastTsByLane.set(lane, ts);
    }
  });

  if (bindingMissingCount > 0) {
    refusals.push(
      `events: binding field \`${bindingName}\` is MISSING on ${bindingMissingCount} event(s) (first at events[${bindingMissingFirst}]) — every event must carry the run binding; an unbound events file cannot be tied to this summary (refusing)`,
    );
  }

  return { ok: refusals.length === 0, refusals: [...refusals].sort() };
}

/** A short, stable description of a value for a refusal message. */
function describe(v: unknown): string {
  if (v === null) return "null";
  if (v === undefined) return "undefined";
  if (typeof v === "string") return `"${v}"`;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return "array";
  return "object";
}
