/**
 * Tuning analysis report (dogfood backlog High #6; plan §9 "Tuning Needs Lever
 * Isolation"). Pure, deterministic aggregation over one or two validated telemetry
 * run-sets.
 *
 * HARD RULE (plan §8 "Bots Tune Balance, Humans Judge Fun"): this report states
 * NUMBERS and DELTAS only. It NEVER emits a fun/quality verdict — no "better", no
 * "worse", no "improved". The disclaimer sentence rides at the top of every report.
 * The rule is enforced STRUCTURALLY: every human-facing prose string the renderer (or
 * the lever-isolation builder) emits is a fixed template in `RENDER_TEMPLATES` with
 * `{placeholder}` interpolation for VALUES only, and a unit test scans those templates
 * for judgment words — data values can therefore never smuggle or trip the guard.
 *
 * DETERMINISM SCOPE: the report is byte-identical for identical input UNDER THE SAME
 * BUILD. `producedBy` embeds the producing build's version/commit (provenance, same as
 * every other loombridge report), so it varies across builds; `dataAsOf` is derived from
 * the input runs' `producedAt` (chronologically latest, compared by epoch), never
 * wall-clock. The determinism test asserts byte-identity on everything EXCLUDING the
 * `producedBy` line, matching this documented property exactly.
 *
 * When two sets are supplied it also surfaces a LEVER-ISOLATION warning: the caller
 * declares which single lever was changed, and if config for both sets is provided the
 * report FLAGS (does not block) any other config value that also moved — because a
 * before/after delta is only attributable to one lever when only that lever changed
 * (plan §9). Configs are compared by dotted LEAF path (nested objects walked
 * recursively, key-order independent), so `--lever physics.enemySpeed` works and a
 * reordered-but-equal config never raises a spurious warning.
 */

import { resolveBuildStamp, type BuildStamp } from "../build-stamp.js";
import type { TelemetrySchema } from "./schema.js";

/** The humans-judge-fun disclaimer that heads every report (plan §8). */
export const TUNING_REPORT_DISCLAIMER =
  "Bots and telemetry tune balance; humans judge fun. This report states numbers and deltas only — it makes no better/worse or fun/quality judgment.";

/**
 * Every human-facing prose string the report can emit, as fixed templates with
 * `{placeholder}` slots for interpolated VALUES. The no-fun-verdict rule is enforced
 * by a unit test over THESE strings (structural), plus a word-boundary scan of the
 * rendered output as belt. Add new report prose HERE, never inline in the renderer.
 * (`TUNING_REPORT_DISCLAIMER` is separate: it legitimately names the banned words to
 * declare that no such judgment is made.)
 */
export const RENDER_TEMPLATES = {
  title: "# Tuning Analysis Report",
  determinismNote:
    "Determinism: byte-identical for identical input under the same build (the `Produced by` line varies across builds).",
  schemaLine: "Schema: {id}",
  schemaGenreSuffix: " (genre {genre})",
  dataAsOfLine: "Data as of: {value}",
  producedByLine: "Produced by: loombridge {version} ({commit})",
  setHeader: "## {label} ({runs} run(s), {rejected} rejected)",
  caveatLine: "⚠ {caveat}",
  lowSampleCaveat:
    "LOW SAMPLE: means from {n} accepted run(s); treat as anecdote, not signal (tune against a fixed cohort of adequate size before reading these numbers).",
  rejectedMajorityCaveat:
    "REJECTED MAJORITY: {rejected} run(s) rejected vs {accepted} accepted — the accepted sample may not represent the cohort; inspect the rejected runs before reading these numbers.",
  segmentsHeader: "### Segments",
  segmentHeader: "#### {field} = {value} ({runs} run(s))",
  metricsTableHeader: "| metric | unit | mean | min | max | n | missing |",
  metricsTableRule: "| --- | --- | --- | --- | --- | --- | --- |",
  singleObservation: "{value} (single observation)",
  eventsLine: "Events: {counts}",
  eventsNone: "(none)",
  lootTiersLine: "Loot tiers: {counts}",
  comparisonHeader: "## Before → After (deltas)",
  deltaTableHeader: "| metric | unit | before mean | after mean | delta (after − before) |",
  deltaTableRule: "| --- | --- | --- | --- | --- |",
  segmentDeltaHeader: "### Segment {field} = {value}",
  segmentDeltaTableHeader: "| metric | unit | before mean | after mean | delta |",
  leverHeader: "## Lever Isolation",
  leverDeclaredLine: "Declared lever: `{lever}`",
  leverCheckedLine: "Checked: {value}",
  leverWarningLine: "⚠ {warning}",
  leverTableHeader: "| other changed lever | before | after |",
  leverTableRule: "| --- | --- | --- |",
  rejectedHeader: "## Rejected runs (excluded from aggregates)",
  rejectedLine: "- [{set}] {runId}: {refusals}",
  // Strings the lever-isolation builder embeds in the report JSON:
  leverWarnOthersChanged:
    "LEVER-ISOLATION WARNING: {count} config value(s) other than the declared lever `{lever}` changed between sets ({keys}); before/after deltas may not be attributable to `{lever}` alone.",
  leverNotFoundWarn:
    "declared lever `{lever}` was NOT FOUND in either config (top-level keys: {keys}) — check the lever name; deltas carry no lever-isolation guarantee.",
  leverSameNote:
    "the declared lever `{lever}` has the SAME value in both configs — it did not actually change.",
  leverCleanNote: "lever isolation clean: only the declared lever changed.",
  leverUncheckedNote:
    "lever isolation NOT checked — pass --config-before and --config-after (key→value JSON; nested objects are compared by dotted leaf path) to verify only the declared lever moved.",
  noLeverNote:
    "no --lever declared for a before/after comparison — deltas are reported without a lever-isolation guarantee (plan §9: change one dominant lever at a time).",
} as const;

/** Fill a `RENDER_TEMPLATES` string's `{placeholder}` slots. Unknown slots are left as-is. */
function tpl(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

/** One validated run: its id, parsed summary, and parsed event stream. */
export interface TelemetryRun {
  runId: string;
  summary: Record<string, unknown>;
  events: Array<Record<string, unknown>>;
}

/** A run rejected by validation (excluded from aggregates — never averaged in). */
export interface RejectedRun {
  set: string;
  runId: string;
  refusals: string[];
}

/** Aggregate stats for one numeric summary field over a set of runs. */
export interface FieldAggregate {
  field: string;
  unit: string | null;
  /** Runs that carried a numeric value for this field. */
  count: number;
  /** Runs (of the set) that OMITTED this field — reported, never silently dropped. */
  missing: number;
  mean: number | null;
  min: number | null;
  max: number | null;
  sum: number;
}

/** Aggregates within one value of one segmentable field (e.g. persona = "Greedy"). */
export interface SegmentAggregate {
  field: string;
  value: string;
  runCount: number;
  metrics: FieldAggregate[];
}

/** Count of one event type across a set. */
export interface EventTypeCount {
  type: string;
  count: number;
}

/** Count of loot pickups by tier (route/loot-tier stats, plan §7). */
export interface LootTierCount {
  tier: string;
  count: number;
}

/** All aggregates for one run-set. */
export interface SetAggregate {
  label: string;
  dir: string;
  runCount: number;
  rejectedRunCount: number;
  /**
   * Sample-size caveats (D3): present when acceptedRuns < LOW_SAMPLE_THRESHOLD or
   * rejected > accepted — a mean over a handful of runs reads authoritative but is an
   * anecdote. Rendered prominently at the top of the set section.
   */
  sampleCaveats: string[];
  metrics: FieldAggregate[];
  segments: SegmentAggregate[];
  events: EventTypeCount[];
  lootTiers: LootTierCount[];
}

/** A before→after delta for one metric (overall or within a segment). */
export interface MetricDelta {
  field: string;
  unit: string | null;
  beforeMean: number | null;
  afterMean: number | null;
  /** after − before, or null when either side is absent. */
  delta: number | null;
}

export interface SegmentDelta {
  field: string;
  value: string;
  metrics: MetricDelta[];
}

export interface Comparison {
  metrics: MetricDelta[];
  segments: SegmentDelta[];
}

/** The declared lever's fate between the two configs. */
export type DeclaredLeverState = "changed" | "same" | "not-found";

export interface LeverIsolation {
  declaredLever: string;
  /** True only when config for BOTH sets was supplied and comparable. */
  checked: boolean;
  /** Config values (dotted leaf paths) OTHER than the lever that moved. */
  otherChangedLevers: Array<{ key: string; before: unknown; after: unknown }>;
  /** changed / same / not-found — null when unchecked. */
  declaredLeverState: DeclaredLeverState | null;
  /** Back-compat boolean view of declaredLeverState (null when unchecked/not-found). */
  declaredLeverChanged: boolean | null;
  warning: string | null;
  note: string | null;
}

export interface TuningReport {
  schemaVersion: "1";
  kind: "tuning-report";
  disclaimer: string;
  producedBy: BuildStamp;
  /**
   * The chronologically latest run `producedAt` across all input runs (compared by
   * EPOCH via Date.parse — string-max mis-ranks mixed UTC-offset timestamps; the
   * ORIGINAL string of the winning run is kept, so a non-UTC offset round-trips
   * verbatim). Deterministic from input, never wall-clock. Null when no run carries a
   * parseable producedAt.
   */
  dataAsOf: string | null;
  schema: { id: string; genre: string | null };
  before: SetAggregate;
  after: SetAggregate | null;
  comparison: Comparison | null;
  leverIsolation: LeverIsolation | null;
  rejectedRuns: RejectedRun[];
}

const ROUND = 1000; // 3 decimal places
function round3(n: number): number {
  return Math.round(n * ROUND) / ROUND;
}

/** Sets smaller than this get the LOW SAMPLE caveat (D3). */
export const LOW_SAMPLE_THRESHOLD = 5;

/** Numeric summary fields the schema marks for aggregation, in schema order. */
function aggregateFields(schema: TelemetrySchema): Array<{ name: string; unit: string | null }> {
  return schema.runSummary.fields
    .filter((f) => f.aggregate === "mean")
    .map((f) => ({ name: f.name, unit: f.unit ?? null }));
}

function segmentableFieldNames(schema: TelemetrySchema): string[] {
  return schema.runSummary.fields.filter((f) => f.segmentable).map((f) => f.name);
}

function computeFieldAggregate(
  runs: TelemetryRun[],
  field: string,
  unit: string | null,
): FieldAggregate {
  const values: number[] = [];
  let missing = 0;
  for (const r of runs) {
    const v = r.summary[field];
    if (typeof v === "number" && Number.isFinite(v)) values.push(v);
    else missing += 1;
  }
  if (values.length === 0) {
    return { field, unit, count: 0, missing, mean: null, min: null, max: null, sum: 0 };
  }
  const sum = values.reduce((a, b) => a + b, 0);
  return {
    field,
    unit,
    count: values.length,
    missing,
    mean: round3(sum / values.length),
    min: round3(Math.min(...values)),
    max: round3(Math.max(...values)),
    sum: round3(sum),
  };
}

/** The D3 sample-size caveats for a set. Deterministic (template + counts). */
function computeSampleCaveats(runCount: number, rejectedCount: number): string[] {
  const caveats: string[] = [];
  if (runCount < LOW_SAMPLE_THRESHOLD) {
    caveats.push(tpl(RENDER_TEMPLATES.lowSampleCaveat, { n: runCount }));
  }
  if (rejectedCount > runCount) {
    caveats.push(
      tpl(RENDER_TEMPLATES.rejectedMajorityCaveat, { rejected: rejectedCount, accepted: runCount }),
    );
  }
  return caveats;
}

/** Aggregate one run-set. Runs are assumed already validated + sorted by runId. */
export function aggregateSet(
  label: string,
  dir: string,
  runs: TelemetryRun[],
  rejectedCount: number,
  schema: TelemetrySchema,
): SetAggregate {
  const aggFields = aggregateFields(schema);
  const metrics = aggFields.map((f) => computeFieldAggregate(runs, f.name, f.unit));

  // Segmentation: group by each segmentable field's stringified value.
  const segments: SegmentAggregate[] = [];
  for (const segField of segmentableFieldNames(schema)) {
    const groups = new Map<string, TelemetryRun[]>();
    for (const r of runs) {
      const raw = r.summary[segField];
      if (raw === undefined || raw === null) continue;
      const key = String(raw);
      const list = groups.get(key) ?? [];
      list.push(r);
      groups.set(key, list);
    }
    for (const value of [...groups.keys()].sort()) {
      const groupRuns = groups.get(value)!;
      segments.push({
        field: segField,
        value,
        runCount: groupRuns.length,
        metrics: aggFields.map((f) => computeFieldAggregate(groupRuns, f.name, f.unit)),
      });
    }
  }

  // Event-type counts across the set (deterministic: schema order).
  const declaredTypes = schema.eventStream.events.map((e) => e.type);
  const counts = new Map<string, number>(declaredTypes.map((t) => [t, 0]));
  const tierCounts = new Map<string, number>();
  for (const r of runs) {
    for (const ev of r.events) {
      const t = ev.type;
      if (typeof t === "string" && counts.has(t)) counts.set(t, counts.get(t)! + 1);
      // Loot-tier breakdown keys off `loot_complete` — the SECURED pickup (ground-truthed
      // real event name, T3-T; aligns with the `loot_reward` cue binding). `loot_start` is
      // deliberately NOT counted here: a started-then-cancelled hold also emits loot_start,
      // so counting both would double-count secured loot and inflate the tier distribution.
      if (t === "loot_complete") {
        const tier = ev.tier;
        if (tier !== undefined && tier !== null) {
          const key = String(tier);
          tierCounts.set(key, (tierCounts.get(key) ?? 0) + 1);
        }
      }
    }
  }
  const events: EventTypeCount[] = declaredTypes.map((t) => ({ type: t, count: counts.get(t) ?? 0 }));
  const lootTiers: LootTierCount[] = [...tierCounts.keys()]
    .sort()
    .map((tier) => ({ tier, count: tierCounts.get(tier)! }));

  return {
    label,
    dir,
    runCount: runs.length,
    rejectedRunCount: rejectedCount,
    sampleCaveats: computeSampleCaveats(runs.length, rejectedCount),
    metrics,
    segments,
    events,
    lootTiers,
  };
}

function metricDelta(field: string, unit: string | null, before: FieldAggregate | undefined, after: FieldAggregate | undefined): MetricDelta {
  const b = before?.mean ?? null;
  const a = after?.mean ?? null;
  const delta = b !== null && a !== null ? round3(a - b) : null;
  return { field, unit, beforeMean: b, afterMean: a, delta };
}

/** Build the before→after comparison (overall metrics + per-segment). */
export function buildComparison(before: SetAggregate, after: SetAggregate): Comparison {
  const beforeByField = new Map(before.metrics.map((m) => [m.field, m]));
  const afterByField = new Map(after.metrics.map((m) => [m.field, m]));
  const fields = before.metrics.map((m) => ({ field: m.field, unit: m.unit }));
  const metrics = fields.map((f) => metricDelta(f.field, f.unit, beforeByField.get(f.field), afterByField.get(f.field)));

  // Per-segment deltas: only segments present in BOTH sets (same field+value).
  const key = (s: SegmentAggregate) => `${s.field} ${s.value}`;
  const beforeSeg = new Map(before.segments.map((s) => [key(s), s]));
  const segments: SegmentDelta[] = [];
  for (const aSeg of after.segments) {
    const bSeg = beforeSeg.get(key(aSeg));
    if (!bSeg) continue;
    const bByField = new Map(bSeg.metrics.map((m) => [m.field, m]));
    const aByField = new Map(aSeg.metrics.map((m) => [m.field, m]));
    segments.push({
      field: aSeg.field,
      value: aSeg.value,
      metrics: fields.map((f) => metricDelta(f.field, f.unit, bByField.get(f.field), aByField.get(f.field))),
    });
  }
  segments.sort((x, y) => (x.field === y.field ? (x.value < y.value ? -1 : x.value > y.value ? 1 : 0) : x.field < y.field ? -1 : 1));
  return { metrics, segments };
}

/**
 * Structural deep-equal: recursive, object-key-order INDEPENDENT (D7 — a reordered
 * but value-identical config must never raise a spurious lever warning). Arrays are
 * ordered. NaN equals NaN (Object.is).
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  if (
    a !== null && b !== null &&
    typeof a === "object" && typeof b === "object" &&
    !Array.isArray(a) && !Array.isArray(b)
  ) {
    const ka = Object.keys(a as Record<string, unknown>).sort();
    const kb = Object.keys(b as Record<string, unknown>).sort();
    if (ka.length !== kb.length) return false;
    return ka.every(
      (k, i) => k === kb[i] && deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
    );
  }
  return false;
}

/**
 * Flatten a config object to dotted LEAF paths (`physics.enemySpeed` → value). Plain
 * objects are walked; arrays and primitives are leaves. Deterministic (sorted keys).
 */
function flattenConfig(obj: Record<string, unknown>, prefix = ""): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (const k of Object.keys(obj).sort()) {
    const p = prefix ? `${prefix}.${k}` : k;
    const v = obj[k];
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      for (const [nk, nv] of flattenConfig(v as Record<string, unknown>, p)) out.set(nk, nv);
    } else {
      out.set(p, v);
    }
  }
  return out;
}

/** Cap for the top-level-keys hint in the lever-not-found warning (bounded output). */
const NOT_FOUND_KEY_HINT_CAP = 15;

/**
 * Lever-isolation check (plan §9). `lever` is the single lever the caller says they
 * changed — a dotted path reaches nested config (`physics.enemySpeed`); naming a
 * subtree owns every leaf under it. When config for both sets is provided, FLAG every
 * OTHER leaf whose value moved — the before/after delta is only cleanly attributable
 * when nothing else moved. Three declared-lever states are distinguished (D6):
 * `changed`, `same` (present but identical), and `not-found` (absent from BOTH
 * configs — warned with a bounded top-level-key hint, since a typo'd lever must not
 * read as "verified isolated"). Advisory only; never blocks.
 */
export function buildLeverIsolation(
  lever: string,
  configBefore: Record<string, unknown> | null,
  configAfter: Record<string, unknown> | null,
): LeverIsolation {
  if (!configBefore || !configAfter) {
    return {
      declaredLever: lever,
      checked: false,
      otherChangedLevers: [],
      declaredLeverState: null,
      declaredLeverChanged: null,
      warning: null,
      note: RENDER_TEMPLATES.leverUncheckedNote,
    };
  }

  const flatBefore = flattenConfig(configBefore);
  const flatAfter = flattenConfig(configAfter);
  const allPaths = [...new Set([...flatBefore.keys(), ...flatAfter.keys()])].sort();
  const leverOwns = (p: string) => p === lever || p.startsWith(`${lever}.`);

  const otherChangedLevers: Array<{ key: string; before: unknown; after: unknown }> = [];
  let leverChanged = false;
  for (const p of allPaths) {
    const inBefore = flatBefore.has(p);
    const inAfter = flatAfter.has(p);
    const b = inBefore ? flatBefore.get(p) : undefined;
    const a = inAfter ? flatAfter.get(p) : undefined;
    // A path present on only one side counts as changed.
    const changed = !(inBefore && inAfter && deepEqual(b, a));
    if (!changed) continue;
    if (leverOwns(p)) leverChanged = true;
    else otherChangedLevers.push({ key: p, before: inBefore ? b ?? null : null, after: inAfter ? a ?? null : null });
  }

  const leverFound = allPaths.some(leverOwns);
  const declaredLeverState: DeclaredLeverState = !leverFound ? "not-found" : leverChanged ? "changed" : "same";

  const warningParts: string[] = [];
  if (declaredLeverState === "not-found") {
    const topKeys = [...new Set([...Object.keys(configBefore), ...Object.keys(configAfter)])].sort();
    const shown = topKeys.slice(0, NOT_FOUND_KEY_HINT_CAP);
    const keyHint = shown.join(", ") + (topKeys.length > shown.length ? `, … (+${topKeys.length - shown.length} more)` : "");
    warningParts.push(tpl(RENDER_TEMPLATES.leverNotFoundWarn, { lever, keys: keyHint }));
  }
  if (otherChangedLevers.length > 0) {
    warningParts.push(
      tpl(RENDER_TEMPLATES.leverWarnOthersChanged, {
        count: otherChangedLevers.length,
        lever,
        keys: otherChangedLevers.map((c) => c.key).join(", "),
      }),
    );
  }

  const noteParts: string[] = [];
  if (declaredLeverState === "same") noteParts.push(tpl(RENDER_TEMPLATES.leverSameNote, { lever }));
  if (declaredLeverState === "changed" && otherChangedLevers.length === 0) {
    noteParts.push(RENDER_TEMPLATES.leverCleanNote);
  }

  return {
    declaredLever: lever,
    checked: true,
    otherChangedLevers,
    declaredLeverState,
    declaredLeverChanged: declaredLeverState === "not-found" ? null : declaredLeverState === "changed",
    warning: warningParts.length > 0 ? warningParts.join(" ") : null,
    note: noteParts.length > 0 ? noteParts.join(" ") : null,
  };
}

export interface BuildTuningReportInput {
  schema: TelemetrySchema;
  before: { label: string; dir: string; runs: TelemetryRun[]; rejected: RejectedRun[] };
  after?: { label: string; dir: string; runs: TelemetryRun[]; rejected: RejectedRun[] };
  lever?: string;
  configBefore?: Record<string, unknown> | null;
  configAfter?: Record<string, unknown> | null;
}

/**
 * The chronologically latest `producedAt` across the runs, compared by EPOCH (D4 —
 * string-max mis-ranks mixed UTC-offset timestamps). Returns the winning run's
 * ORIGINAL string. Unparseable values are skipped here (they are refused upstream by
 * the validator when the schema declares `format: "iso-8601"`).
 */
function latestProducedAt(runs: TelemetryRun[]): string | null {
  let latestEpoch = Number.NEGATIVE_INFINITY;
  let latestString: string | null = null;
  for (const r of runs) {
    const p = r.summary.producedAt;
    if (typeof p !== "string" || p.length === 0) continue;
    const epoch = Date.parse(p);
    if (Number.isNaN(epoch)) continue;
    if (epoch > latestEpoch) {
      latestEpoch = epoch;
      latestString = p;
    }
  }
  return latestString;
}

/** Assemble the full deterministic report object. */
export function buildTuningReport(input: BuildTuningReportInput): TuningReport {
  const { schema } = input;
  const beforeAgg = aggregateSet(input.before.label, input.before.dir, input.before.runs, input.before.rejected.length, schema);
  const afterAgg = input.after
    ? aggregateSet(input.after.label, input.after.dir, input.after.runs, input.after.rejected.length, schema)
    : null;

  const allRuns = [...input.before.runs, ...(input.after?.runs ?? [])];
  const dataAsOf = latestProducedAt(allRuns);

  const comparison = afterAgg ? buildComparison(beforeAgg, afterAgg) : null;

  let leverIsolation: LeverIsolation | null = null;
  if (input.after) {
    if (input.lever) {
      leverIsolation = buildLeverIsolation(input.lever, input.configBefore ?? null, input.configAfter ?? null);
    } else {
      leverIsolation = {
        declaredLever: "",
        checked: false,
        otherChangedLevers: [],
        declaredLeverState: null,
        declaredLeverChanged: null,
        warning: null,
        note: RENDER_TEMPLATES.noLeverNote,
      };
    }
  }

  const rejectedRuns = [...input.before.rejected, ...(input.after?.rejected ?? [])].sort((a, b) =>
    a.set === b.set ? (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0) : a.set < b.set ? -1 : 1,
  );

  return {
    schemaVersion: "1",
    kind: "tuning-report",
    disclaimer: TUNING_REPORT_DISCLAIMER,
    producedBy: resolveBuildStamp(),
    dataAsOf,
    schema: { id: schema.id, genre: schema.genre ?? null },
    before: beforeAgg,
    after: afterAgg,
    comparison,
    leverIsolation,
    rejectedRuns,
  };
}

/**
 * Deterministic JSON serialization: object keys emitted in sorted order at every level
 * so the same input yields byte-identical output UNDER THE SAME BUILD (`producedBy` is
 * build provenance and varies across builds — see the module header). Arrays keep
 * their (already deterministic) order.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value), null, 2) + "\n";
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = sortKeys((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

function fmt(n: number | null): string {
  return n === null ? "—" : String(n);
}

function renderMetricsTable(metrics: FieldAggregate[]): string[] {
  const lines: string[] = [];
  lines.push(RENDER_TEMPLATES.metricsTableHeader);
  lines.push(RENDER_TEMPLATES.metricsTableRule);
  for (const m of metrics) {
    // n=1: a mean/min/max over one run is ONE observation — say so instead of wearing
    // statistics labels (D3).
    const meanCell =
      m.count === 1 ? tpl(RENDER_TEMPLATES.singleObservation, { value: fmt(m.mean) }) : fmt(m.mean);
    const minCell = m.count === 1 ? "—" : fmt(m.min);
    const maxCell = m.count === 1 ? "—" : fmt(m.max);
    lines.push(`| ${m.field} | ${m.unit ?? ""} | ${meanCell} | ${minCell} | ${maxCell} | ${m.count} | ${m.missing} |`);
  }
  return lines;
}

function renderSet(agg: SetAggregate): string[] {
  const lines: string[] = [];
  lines.push(tpl(RENDER_TEMPLATES.setHeader, { label: agg.label, runs: agg.runCount, rejected: agg.rejectedRunCount }));
  lines.push("");
  for (const caveat of agg.sampleCaveats) {
    lines.push(tpl(RENDER_TEMPLATES.caveatLine, { caveat }));
  }
  if (agg.sampleCaveats.length > 0) lines.push("");
  lines.push(...renderMetricsTable(agg.metrics));
  lines.push("");
  if (agg.segments.length > 0) {
    lines.push(RENDER_TEMPLATES.segmentsHeader);
    lines.push("");
    for (const seg of agg.segments) {
      lines.push(tpl(RENDER_TEMPLATES.segmentHeader, { field: seg.field, value: seg.value, runs: seg.runCount }));
      lines.push("");
      lines.push(...renderMetricsTable(seg.metrics));
      lines.push("");
    }
  }
  const eventCounts = agg.events.map((e) => `${e.type}=${e.count}`).join(", ");
  lines.push(tpl(RENDER_TEMPLATES.eventsLine, { counts: eventCounts || RENDER_TEMPLATES.eventsNone }));
  if (agg.lootTiers.length > 0) {
    lines.push(tpl(RENDER_TEMPLATES.lootTiersLine, { counts: agg.lootTiers.map((t) => `${t.tier}=${t.count}`).join(", ") }));
  }
  lines.push("");
  return lines;
}

/**
 * Render the human-readable (markdown) report. Deterministic; byte-identical under the
 * same build for identical input (the `Produced by` line carries build provenance).
 * All prose comes from `RENDER_TEMPLATES` — see the module header.
 */
export function renderTuningReportText(report: TuningReport): string {
  const lines: string[] = [];
  lines.push(RENDER_TEMPLATES.title);
  lines.push("");
  lines.push(`> ${report.disclaimer}`);
  lines.push("");
  lines.push(
    tpl(RENDER_TEMPLATES.schemaLine, { id: report.schema.id }) +
      (report.schema.genre ? tpl(RENDER_TEMPLATES.schemaGenreSuffix, { genre: report.schema.genre }) : ""),
  );
  lines.push(tpl(RENDER_TEMPLATES.dataAsOfLine, { value: report.dataAsOf ?? "unknown" }));
  lines.push(tpl(RENDER_TEMPLATES.producedByLine, { version: report.producedBy.version, commit: report.producedBy.commit }));
  lines.push(RENDER_TEMPLATES.determinismNote);
  lines.push("");

  lines.push(...renderSet(report.before));
  if (report.after) lines.push(...renderSet(report.after));

  if (report.comparison) {
    lines.push(RENDER_TEMPLATES.comparisonHeader);
    lines.push("");
    lines.push(RENDER_TEMPLATES.deltaTableHeader);
    lines.push(RENDER_TEMPLATES.deltaTableRule);
    for (const d of report.comparison.metrics) {
      lines.push(`| ${d.field} | ${d.unit ?? ""} | ${fmt(d.beforeMean)} | ${fmt(d.afterMean)} | ${fmt(d.delta)} |`);
    }
    lines.push("");
    for (const seg of report.comparison.segments) {
      lines.push(tpl(RENDER_TEMPLATES.segmentDeltaHeader, { field: seg.field, value: seg.value }));
      lines.push("");
      lines.push(RENDER_TEMPLATES.segmentDeltaTableHeader);
      lines.push(RENDER_TEMPLATES.deltaTableRule);
      for (const d of seg.metrics) {
        lines.push(`| ${d.field} | ${d.unit ?? ""} | ${fmt(d.beforeMean)} | ${fmt(d.afterMean)} | ${fmt(d.delta)} |`);
      }
      lines.push("");
    }
  }

  if (report.leverIsolation) {
    lines.push(RENDER_TEMPLATES.leverHeader);
    lines.push("");
    const li = report.leverIsolation;
    if (li.declaredLever) lines.push(tpl(RENDER_TEMPLATES.leverDeclaredLine, { lever: li.declaredLever }));
    lines.push(tpl(RENDER_TEMPLATES.leverCheckedLine, { value: li.checked ? "yes" : "no" }));
    if (li.warning) lines.push(tpl(RENDER_TEMPLATES.leverWarningLine, { warning: li.warning }));
    if (li.note) lines.push(li.note);
    if (li.otherChangedLevers.length > 0) {
      lines.push("");
      lines.push(RENDER_TEMPLATES.leverTableHeader);
      lines.push(RENDER_TEMPLATES.leverTableRule);
      for (const c of li.otherChangedLevers) {
        lines.push(`| ${c.key} | ${JSON.stringify(c.before)} | ${JSON.stringify(c.after)} |`);
      }
    }
    lines.push("");
  }

  if (report.rejectedRuns.length > 0) {
    lines.push(RENDER_TEMPLATES.rejectedHeader);
    lines.push("");
    for (const r of report.rejectedRuns) {
      lines.push(tpl(RENDER_TEMPLATES.rejectedLine, { set: r.set, runId: r.runId, refusals: r.refusals.join("; ") }));
    }
    lines.push("");
  }

  return lines.join("\n");
}
