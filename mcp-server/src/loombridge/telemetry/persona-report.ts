/**
 * Persona cohort report (plan §8 "Bots Tune Balance, Humans Judge Fun"; dogfood backlog
 * High #5). Pure, deterministic analysis of a validated telemetry run-set against a
 * genre-pack `PersonaContract`. Builds ON the Wave-A telemetry substrate: it consumes the
 * same `TelemetryRun[]` the tuning report aggregates, so a single cohort run-set feeds
 * BOTH reports.
 *
 * What it reports:
 *  - per-persona PASS vs its OWN declared envelope (each band's observed value, its
 *    sample size — `observedCount`/`missingCount`, a missing value is SURFACED, never
 *    silently shrunk out of the denominator — and in-band?);
 *  - per-persona SAMPLE caveats inheriting Wave-A's discipline (`LOW_SAMPLE_THRESHOLD`
 *    is IMPORTED from the tuning report, not duplicated): personas are segments, so n is
 *    always ≤ the set total — the anecdote trap is MORE likely here, and a persona graded
 *    from n<5 runs says so next to its envelope verdict (n=1 renders "single observation");
 *  - a persona whose observed value leaves its OWN envelope = PERSONA DRIFT — a REPORT
 *    CAVEAT about the BOT ("calibrate before trusting the cohort numbers"), NEVER a
 *    game-balance claim (do not nerf the game because a broken bot over-commits);
 *  - a cross-persona SPREAD table — the doc's point that the spread across Timid /
 *    Balanced / Greedy / Reckless is the balance signal — with drifted personas marked
 *    INLINE in their row so the numbers carry their trust state where they are read;
 *  - a prominent UNCALIBRATED caveat mirroring the Wave-A sample caveats: a persona used
 *    for a balance claim without calibration evidence is flagged, not silently trusted;
 *  - COHORT HYGIENE caveats: declared personas with no runs, UNDECLARED persona values in
 *    the runs (with their run counts), and UNATTRIBUTED runs (missing/empty persona
 *    value) — bucketed and caveated, never silently dropped.
 *
 * For a before/after lever comparison, `buildPersonaCohortComparison` pairs TWO reports
 * (one per set — a persona's envelope is NEVER graded over a merged mix of two game
 * versions, which would conflate bot-drift with game-change) and states each persona's
 * envelope verdict transition.
 *
 * NO-JUDGMENT RULE (same discipline as the tuning report), honest scope: this report
 * states NUMBERS and envelope PASS/DRIFT only and NEVER emits a fun/quality verdict —
 * enforced structurally over ITS OWN PROSE: every renderer-owned string is a fixed
 * template in `PERSONA_RENDER_TEMPLATES` with `{placeholder}` interpolation for VALUES
 * only, and a unit test scans those templates for judgment words. INTERPOLATED DATA
 * (persona ids, intent statements, calibration-evidence pointers) is contract-author
 * prose rendered VERBATIM and is NOT scanned here — the persona-contract validator
 * separately WARNS (advisory) when an intent statement contains a judgment word. Human
 * playtest stays the authority for fun.
 *
 * DETERMINISM: byte-identical for identical input UNDER THE SAME BUILD (`producedBy`
 * embeds build provenance and varies across builds; `dataAsOf` derives from the input
 * runs' `producedAt`, never wall-clock).
 */

import { resolveBuildStamp, type BuildStamp } from "../build-stamp.js";
import type { TelemetrySchema } from "./schema.js";
import type { PersonaContract, PersonaEntry, PersonaEnvelopeBand } from "./personas.js";
import { LOW_SAMPLE_THRESHOLD, type TelemetryRun } from "./report.js";

/** The humans-judge-fun disclaimer that heads every persona report (plan §8). */
export const PERSONA_REPORT_DISCLAIMER =
  "Bots and personas tune balance; humans judge fun. This report states persona pass rates against DECLARED envelopes and a cross-persona spread — it makes no better/worse or fun/quality judgment. Persona drift and uncalibrated personas are caveats about the BOTS, never game-balance claims.";

/**
 * Every renderer-owned prose string, as fixed templates with `{placeholder}` slots for
 * VALUES only. The no-fun-verdict rule is enforced by a unit test over THESE strings.
 * Add new report prose HERE, never inline in the renderer. Honest scope: interpolated
 * DATA (ids/intent/evidence) is author prose rendered verbatim — see the module header.
 * (`PERSONA_REPORT_DISCLAIMER` is separate: it legitimately names the banned words to
 * declare that no such judgment is made.)
 */
export const PERSONA_RENDER_TEMPLATES = {
  title: "# Persona Cohort Report",
  determinismNote:
    "Determinism: byte-identical for identical input under the same build (the `Produced by` line varies across builds).",
  contractLine: "Persona contract: {id}",
  contractGenreSuffix: " (genre {genre})",
  personaFieldLine: "Persona field: {field} (telemetry schema {schema})",
  cohortLine: "Cohort: {label} ({runs} run(s))",
  dataAsOfLine: "Data as of: {value}",
  producedByLine: "Produced by: loombridge {version} ({commit})",
  caveatLine: "⚠ {caveat}",
  uncalibratedCaveat:
    "UNCALIBRATED PERSONA(S): {ids} — a persona used for a balance claim without calibration evidence is not trustworthy (calibrate the persona against a fixed cohort BEFORE reading its cohort numbers as balance signal). Caveat about the BOT, not the game.",
  driftCaveat:
    "PERSONA DRIFT: {ids} fell outside their OWN declared envelope — this is a REPORT CAVEAT about the bot (calibrate the persona before trusting these cohort numbers), NOT a game-balance claim; do not tune the game around a persona that missed its own intent.",
  noRunsCaveat:
    "NO RUNS: persona(s) {ids} are declared but have no runs in this cohort — their envelope could not be evaluated.",
  undeclaredCaveat:
    "UNDECLARED PERSONA(S) IN COHORT: {ids} appear in the runs but are not in the persona contract — declare + calibrate them, or exclude their runs, before reading the cohort.",
  unattributedCaveat:
    "UNATTRIBUTED RUNS: {count} run(s) carry a missing or empty `{field}` value — excluded from every persona's grading and from the spread, never silently dropped; a run that names no persona cannot back any persona's numbers (fix the emitter).",
  personaLowSampleCaveat:
    "LOW SAMPLE: envelope graded from {n} run(s); treat as anecdote, not signal (a persona is a segment — grade it against a fixed cohort of adequate size before reading its envelope verdict).",
  spreadNote:
    "The spread across personas is the balance signal (safe extraction, moderate greed, over-greed outcomes). Interpret it against the declared envelopes — that interpretation is a human judgment.",
  personaHeader: "## Persona: {id} ({runs} run(s)) [calibrated: {calibrated}]",
  intentLine: "Intent: {intent}",
  driftMarker: "Envelope: DRIFT ({fields} outside band)",
  inEnvelopeMarker: "Envelope: all bands in range",
  noRunsMarker: "Envelope: not evaluated (no runs)",
  calibrationEvidenceLine: "Calibration evidence: {value}",
  envelopeTableHeader: "| metric | band | observed | n | missing | in band? |",
  envelopeTableRule: "| --- | --- | --- | --- | --- | --- |",
  singleObservation: "{value} (single observation)",
  spreadHeader: "## Cross-persona spread",
  spreadDriftSuffix: " ⚠drift",
  spreadNoRunsSuffix: " (no runs)",
  comparisonHeader: "## Persona envelope verdicts: {before} → {after}",
  comparisonNote:
    "Each set is graded as its OWN cohort — a persona's envelope is never evaluated over a merged mix of two game versions (that would conflate bot-drift with game-change). The verdict transition states envelope facts only.",
  comparisonLine: "- {id}: {before} → {after}",
  verdictInEnvelope: "in-envelope",
  verdictDrift: "drift({fields})",
  verdictNoRuns: "no-runs",
} as const;

/** Fill a `{placeholder}` template. Unknown slots are left as-is. */
function tpl(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

/**
 * Escape a metric-key component so a `field`/`equals` containing `=`, `(`, `)` or `\`
 * cannot collide with the key syntax (`rate(a=b)` vs a field literally named `a=b`).
 * Backslash-escaping is injective, so distinct band specs always yield distinct keys.
 */
function escKeyPart(s: string): string {
  return s.replace(/[\\()=]/g, (c) => `\\${c}`);
}

/** Canonical metric key for a band — `mean(field)` or `rate(field=value)`. Deterministic. */
export function metricKeyFor(band: Pick<PersonaEnvelopeBand, "field" | "stat" | "equals">): string {
  return band.stat === "rate"
    ? `rate(${escKeyPart(band.field)}=${escKeyPart(band.equals ?? "")})`
    : `mean(${escKeyPart(band.field)})`;
}

const ROUND = 1000; // 3 dp
function round3(n: number): number {
  return Math.round(n * ROUND) / ROUND;
}

/** One evaluated envelope band for a persona. */
export interface PersonaBandObservation {
  metricKey: string;
  field: string;
  stat: "mean" | "rate";
  equals: string | null;
  min: number;
  max: number;
  unit: string | null;
  /** The observed value over the persona's runs, or null when it cannot be computed. */
  observed: number | null;
  /**
   * Runs that CONTRIBUTED to `observed`: numeric values for `mean`, present field values
   * for `rate` (the rate denominator). Surfaced so a shrunken sample is visible where the
   * verdict is read.
   */
  observedCount: number;
  /** Runs of the persona that were MISSING the field — reported, never silently dropped. */
  missingCount: number;
  /** In-band? null when `observed` is null (no runs / no usable values). */
  inBand: boolean | null;
}

/** One persona's cohort row: its runs, evaluated envelope, drift state, sample caveats. */
export interface PersonaCohortRow {
  personaId: string;
  intent: string;
  calibrated: boolean;
  calibrationEvidence: string | null;
  runCount: number;
  noRuns: boolean;
  /**
   * Wave-A sample discipline, inherited PER PERSONA (a persona is a segment — its n is
   * always ≤ the set total, so the anecdote trap is more likely here than in the overall
   * tuning aggregate): 0 < n < LOW_SAMPLE_THRESHOLD carries the low-sample caveat,
   * rendered next to the envelope verdict.
   */
  sampleCaveats: string[];
  bands: PersonaBandObservation[];
  /** True when ANY evaluated band is out of range. */
  drift: boolean;
  /** The metric keys that drifted (out of band), sorted. */
  driftFields: string[];
}

/** The cross-persona spread grid: metric-key columns × persona rows. */
export interface PersonaSpreadTable {
  metricKeys: string[];
  rows: Array<{
    personaId: string;
    /** Trust markers carried INLINE with the numbers: a drifted / run-less row says so. */
    drift: boolean;
    noRuns: boolean;
    observed: Array<number | null>;
  }>;
}

export interface PersonaCohortReport {
  schemaVersion: "1";
  kind: "persona-cohort-report";
  disclaimer: string;
  producedBy: BuildStamp;
  dataAsOf: string | null;
  /** Which run-set this report grades (e.g. "runs", "before", "after"). ONE set per report. */
  cohortLabel: string;
  cohortRunCount: number;
  contract: { id: string; genre: string | null; personaField: string };
  schema: { id: string; genre: string | null };
  personas: PersonaCohortRow[];
  spread: PersonaSpreadTable;
  /** Top-level caveats, fixed order: uncalibrated, drift, no-runs, undeclared, unattributed. */
  caveats: string[];
  uncalibratedPersonas: string[];
  driftPersonas: string[];
  noRunPersonas: string[];
  /** Persona values present in the runs but not declared in the contract, with run counts. */
  undeclaredCohortPersonas: Array<{ id: string; runCount: number }>;
  /** Runs whose persona field is missing or the empty string — bucketed, never dropped silently. */
  unattributedRunCount: number;
}

/**
 * Group runs by the persona-field value. Missing/null AND present-but-empty-string values
 * are bucketed under "" (unattributed) — surfaced by a caveat, never silently dropped.
 * (The Wave-A run validator treats an empty string as "present" for a required non-
 * freshness field, so an empty persona value CAN reach this report — it is flagged here.)
 */
function groupByPersona(runs: TelemetryRun[], personaField: string): Map<string, TelemetryRun[]> {
  const groups = new Map<string, TelemetryRun[]>();
  for (const r of runs) {
    const raw = r.summary[personaField];
    const key = raw === undefined || raw === null ? "" : String(raw);
    const list = groups.get(key) ?? [];
    list.push(r);
    groups.set(key, list);
  }
  return groups;
}

/** A band's observed value + EXPLICIT sample accounting over a set of runs. */
function observeBand(
  band: Pick<PersonaEnvelopeBand, "field" | "stat" | "equals">,
  runs: TelemetryRun[],
): { observed: number | null; observedCount: number; missingCount: number } {
  if (band.stat === "mean") {
    const values: number[] = [];
    let missing = 0;
    for (const r of runs) {
      const v = r.summary[band.field];
      if (typeof v === "number" && Number.isFinite(v)) values.push(v);
      else missing += 1;
    }
    if (values.length === 0) return { observed: null, observedCount: 0, missingCount: missing };
    return {
      observed: round3(values.reduce((a, b) => a + b, 0) / values.length),
      observedCount: values.length,
      missingCount: missing,
    };
  }
  // rate: the denominator is the runs where the field is PRESENT — a missing field is
  // surfaced in missingCount, never zero-counted into the denominator (zero-counting
  // would bias the rate downward exactly when the data is least trustworthy).
  let present = 0;
  let missing = 0;
  let hits = 0;
  for (const r of runs) {
    const v = r.summary[band.field];
    if (v === undefined || v === null) {
      missing += 1;
      continue;
    }
    present += 1;
    if (String(v) === band.equals) hits += 1;
  }
  if (present === 0) return { observed: null, observedCount: 0, missingCount: missing };
  return { observed: round3(hits / present), observedCount: present, missingCount: missing };
}

/** The chronologically latest `producedAt` across runs, compared by EPOCH (see report.ts D4). */
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

function evaluatePersona(persona: PersonaEntry, runs: TelemetryRun[]): PersonaCohortRow {
  const bands: PersonaBandObservation[] = persona.envelope.map((b) => {
    const { observed, observedCount, missingCount } = observeBand(b, runs);
    const inBand = observed === null ? null : observed >= b.min - 1e-9 && observed <= b.max + 1e-9;
    return {
      metricKey: metricKeyFor(b),
      field: b.field,
      stat: b.stat,
      equals: b.equals ?? null,
      min: b.min,
      max: b.max,
      unit: b.unit ?? null,
      observed,
      observedCount,
      missingCount,
      inBand,
    };
  });
  const driftFields = bands.filter((b) => b.inBand === false).map((b) => b.metricKey).sort();
  // Per-persona sample caveat (Wave-A discipline, SHARED threshold — imported, not
  // duplicated). n=0 is covered by the distinct no-runs marker; 0 < n < threshold is an
  // anecdote wearing a verdict, so it says so.
  const sampleCaveats: string[] = [];
  if (runs.length > 0 && runs.length < LOW_SAMPLE_THRESHOLD) {
    sampleCaveats.push(tpl(PERSONA_RENDER_TEMPLATES.personaLowSampleCaveat, { n: runs.length }));
  }
  return {
    personaId: persona.id,
    intent: persona.intent,
    calibrated: persona.calibrated,
    calibrationEvidence: persona.calibrationEvidence,
    runCount: runs.length,
    noRuns: runs.length === 0,
    sampleCaveats,
    bands,
    drift: driftFields.length > 0,
    driftFields,
  };
}

/**
 * Build the deterministic persona cohort report over ONE run-set. `runs` are
 * already-validated telemetry runs (the SAME set the tuning report aggregates).
 * Personas are evaluated in contract declaration order. `cohortLabel` names the set
 * (e.g. "runs", "before", "after") — a report NEVER grades a merged mix of sets (that
 * would conflate bot-drift with game-change; use `buildPersonaCohortComparison`).
 */
export function buildPersonaCohortReport(
  contract: PersonaContract,
  schema: TelemetrySchema,
  runs: TelemetryRun[],
  cohortLabel = "runs",
): PersonaCohortReport {
  const groups = groupByPersona(runs, contract.personaField);

  const personas = contract.personas.map((p) => evaluatePersona(p, groups.get(p.id) ?? []));
  const rowById = new Map(personas.map((p) => [p.personaId, p]));

  // Cross-persona spread: the UNION of every persona's band metric keys (with a shared
  // spec), evaluated for EVERY declared persona over its own runs — a full comparison grid.
  const specByKey = new Map<string, Pick<PersonaEnvelopeBand, "field" | "stat" | "equals">>();
  for (const p of contract.personas) {
    for (const b of p.envelope) specByKey.set(metricKeyFor(b), { field: b.field, stat: b.stat, equals: b.equals });
  }
  const metricKeys = [...specByKey.keys()].sort();
  const spread: PersonaSpreadTable = {
    metricKeys,
    rows: contract.personas.map((p) => {
      const pr = groups.get(p.id) ?? [];
      const row = rowById.get(p.id)!;
      return {
        personaId: p.id,
        drift: row.drift,
        noRuns: row.noRuns,
        observed: metricKeys.map((k) => observeBand(specByKey.get(k)!, pr).observed),
      };
    }),
  };

  // Undeclared personas (with run counts) + unattributed runs (missing/empty persona value).
  const declared = new Set(contract.personas.map((p) => p.id));
  const undeclaredCohortPersonas = [...groups.keys()]
    .filter((k) => k.length > 0 && !declared.has(k))
    .sort()
    .map((id) => ({ id, runCount: groups.get(id)!.length }));
  const unattributedRunCount = groups.get("")?.length ?? 0;

  const uncalibratedPersonas = personas.filter((p) => !p.calibrated).map((p) => p.personaId).sort();
  const driftPersonas = personas.filter((p) => p.drift).map((p) => p.personaId).sort();
  const noRunPersonas = personas.filter((p) => p.noRuns).map((p) => p.personaId).sort();

  // Fixed caveat order: uncalibrated, drift, no-runs, undeclared, unattributed.
  const caveats: string[] = [];
  if (uncalibratedPersonas.length > 0) {
    caveats.push(tpl(PERSONA_RENDER_TEMPLATES.uncalibratedCaveat, { ids: uncalibratedPersonas.join(", ") }));
  }
  if (driftPersonas.length > 0) {
    caveats.push(tpl(PERSONA_RENDER_TEMPLATES.driftCaveat, { ids: driftPersonas.join(", ") }));
  }
  if (noRunPersonas.length > 0) {
    caveats.push(tpl(PERSONA_RENDER_TEMPLATES.noRunsCaveat, { ids: noRunPersonas.join(", ") }));
  }
  if (undeclaredCohortPersonas.length > 0) {
    caveats.push(
      tpl(PERSONA_RENDER_TEMPLATES.undeclaredCaveat, {
        ids: undeclaredCohortPersonas.map((u) => `${u.id} (${u.runCount} run(s))`).join(", "),
      }),
    );
  }
  if (unattributedRunCount > 0) {
    caveats.push(
      tpl(PERSONA_RENDER_TEMPLATES.unattributedCaveat, {
        count: unattributedRunCount,
        field: contract.personaField,
      }),
    );
  }

  return {
    schemaVersion: "1",
    kind: "persona-cohort-report",
    disclaimer: PERSONA_REPORT_DISCLAIMER,
    producedBy: resolveBuildStamp(),
    dataAsOf: latestProducedAt(runs),
    cohortLabel,
    cohortRunCount: runs.length,
    contract: { id: contract.id, genre: contract.genre ?? null, personaField: contract.personaField },
    schema: { id: schema.id, genre: schema.genre ?? null },
    personas,
    spread,
    caveats,
    uncalibratedPersonas,
    driftPersonas,
    noRunPersonas,
    undeclaredCohortPersonas,
    unattributedRunCount,
  };
}

/** A persona's envelope verdict inside one cohort — envelope facts only, no judgment. */
export type PersonaEnvelopeVerdict =
  | { state: "in-envelope" }
  | { state: "drift"; driftFields: string[] }
  | { state: "no-runs" };

/** One persona's verdict transition across a before/after pair of cohort reports. */
export interface PersonaVerdictDelta {
  personaId: string;
  before: PersonaEnvelopeVerdict;
  after: PersonaEnvelopeVerdict;
}

function verdictOf(row: PersonaCohortRow): PersonaEnvelopeVerdict {
  if (row.noRuns) return { state: "no-runs" };
  if (row.drift) return { state: "drift", driftFields: row.driftFields };
  return { state: "in-envelope" };
}

/**
 * Pair two persona cohort reports (each graded over its OWN set — never a merged cohort)
 * and state each persona's envelope verdict transition. Both reports must come from the
 * same contract; personas are matched by id in `before` declaration order.
 */
export function buildPersonaCohortComparison(
  before: PersonaCohortReport,
  after: PersonaCohortReport,
): PersonaVerdictDelta[] {
  const afterById = new Map(after.personas.map((p) => [p.personaId, p]));
  const deltas: PersonaVerdictDelta[] = [];
  for (const b of before.personas) {
    const a = afterById.get(b.personaId);
    if (!a) continue; // same contract → same persona list; defensive only
    deltas.push({ personaId: b.personaId, before: verdictOf(b), after: verdictOf(a) });
  }
  return deltas;
}

function fmt(n: number | null): string {
  return n === null ? "—" : String(n);
}

function bandLabel(b: PersonaBandObservation): string {
  return `[${b.min}, ${b.max}]${b.unit ? ` ${b.unit}` : ""}`;
}

function renderVerdict(v: PersonaEnvelopeVerdict): string {
  const T = PERSONA_RENDER_TEMPLATES;
  switch (v.state) {
    case "in-envelope":
      return T.verdictInEnvelope;
    case "drift":
      return tpl(T.verdictDrift, { fields: v.driftFields.join(", ") });
    case "no-runs":
      return T.verdictNoRuns;
  }
}

/**
 * Render the human-readable (markdown) persona cohort report. Deterministic;
 * byte-identical under the same build for identical input. All renderer-owned prose
 * comes from `PERSONA_RENDER_TEMPLATES` — see the module header for the guard's scope.
 */
export function renderPersonaCohortReportText(report: PersonaCohortReport): string {
  const T = PERSONA_RENDER_TEMPLATES;
  const lines: string[] = [];
  lines.push(T.title);
  lines.push("");
  lines.push(`> ${report.disclaimer}`);
  lines.push("");
  lines.push(
    tpl(T.contractLine, { id: report.contract.id }) +
      (report.contract.genre ? tpl(T.contractGenreSuffix, { genre: report.contract.genre }) : ""),
  );
  lines.push(tpl(T.personaFieldLine, { field: report.contract.personaField, schema: report.schema.id }));
  lines.push(tpl(T.cohortLine, { label: report.cohortLabel, runs: report.cohortRunCount }));
  lines.push(tpl(T.dataAsOfLine, { value: report.dataAsOf ?? "unknown" }));
  lines.push(tpl(T.producedByLine, { version: report.producedBy.version, commit: report.producedBy.commit }));
  lines.push(T.determinismNote);
  lines.push("");

  for (const caveat of report.caveats) lines.push(tpl(T.caveatLine, { caveat }));
  if (report.caveats.length > 0) lines.push("");

  for (const p of report.personas) {
    lines.push(tpl(T.personaHeader, { id: p.personaId, runs: p.runCount, calibrated: p.calibrated ? "yes" : "no" }));
    lines.push("");
    lines.push(tpl(T.intentLine, { intent: p.intent }));
    lines.push(
      tpl(T.calibrationEvidenceLine, { value: p.calibrationEvidence ?? "(none)" }),
    );
    lines.push(
      p.noRuns
        ? T.noRunsMarker
        : p.drift
          ? tpl(T.driftMarker, { fields: p.driftFields.join(", ") })
          : T.inEnvelopeMarker,
    );
    // Per-persona sample caveats render NEXT TO the envelope verdict — the verdict and
    // its sample size must be read together (D1).
    for (const caveat of p.sampleCaveats) {
      lines.push(tpl(T.caveatLine, { caveat }));
    }
    lines.push("");
    lines.push(T.envelopeTableHeader);
    lines.push(T.envelopeTableRule);
    for (const b of p.bands) {
      const inBand = b.inBand === null ? "—" : b.inBand ? "yes" : "no";
      // n=1: one run's value is ONE observation — say so instead of wearing a statistic
      // label (mirrors Wave-A's single-observation rendering).
      const observedCell =
        b.observedCount === 1
          ? tpl(T.singleObservation, { value: fmt(b.observed) })
          : fmt(b.observed);
      lines.push(
        `| ${b.metricKey} | ${bandLabel(b)} | ${observedCell} | ${b.observedCount} | ${b.missingCount} | ${inBand} |`,
      );
    }
    lines.push("");
  }

  lines.push(T.spreadHeader);
  lines.push("");
  lines.push(T.spreadNote);
  lines.push("");
  lines.push(`| persona | ${report.spread.metricKeys.join(" | ")} |`);
  lines.push(`| --- | ${report.spread.metricKeys.map(() => "---").join(" | ")} |`);
  for (const row of report.spread.rows) {
    // Trust state travels WITH the numbers (D4): a drifted persona's row says so inline.
    const label =
      row.personaId +
      (row.drift ? T.spreadDriftSuffix : "") +
      (row.noRuns ? T.spreadNoRunsSuffix : "");
    lines.push(`| ${label} | ${row.observed.map(fmt).join(" | ")} |`);
  }
  lines.push("");

  return lines.join("\n");
}

/**
 * Render the before→after persona verdict comparison. Pure template interpolation over
 * `buildPersonaCohortComparison` output; states envelope facts only.
 */
export function renderPersonaCohortComparisonText(
  before: PersonaCohortReport,
  after: PersonaCohortReport,
  deltas: PersonaVerdictDelta[],
): string {
  const T = PERSONA_RENDER_TEMPLATES;
  const lines: string[] = [];
  lines.push(tpl(T.comparisonHeader, { before: before.cohortLabel, after: after.cohortLabel }));
  lines.push("");
  lines.push(T.comparisonNote);
  lines.push("");
  for (const d of deltas) {
    lines.push(
      tpl(T.comparisonLine, {
        id: d.personaId,
        before: renderVerdict(d.before),
        after: renderVerdict(d.after),
      }),
    );
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * Deterministic JSON serialization (sorted keys at every level), mirroring the tuning
 * report so the same input yields byte-identical output UNDER THE SAME BUILD.
 */
export function stablePersonaStringify(value: unknown): string {
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
