/**
 * Persona contract validation (schema-of-schemas + cross-binding to the telemetry
 * schema), envelope evaluation math (hand-computed mean + rate), the persona-drift and
 * uncalibrated caveats, cross-persona spread-table determinism, the STRUCTURAL
 * no-fun-verdict guard over the render templates, and the shipped 3d-topdown-arena seed
 * (personas.json binds clean to telemetry.json).
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

import { validateTelemetrySchema, telemetrySchemaPathForGenre, type TelemetrySchema } from "../capabilities/telemetry/schema.js";
import { validatePersonaContract, personaContractPathForGenre, type PersonaContract } from "../capabilities/telemetry/personas.js";
import {
  buildPersonaCohortReport,
  buildPersonaCohortComparison,
  renderPersonaCohortReportText,
  renderPersonaCohortComparisonText,
  stablePersonaStringify,
  metricKeyFor,
  PERSONA_RENDER_TEMPLATES,
  PERSONA_REPORT_DISCLAIMER,
  type PersonaCohortReport,
} from "../capabilities/telemetry/persona-report.js";
import { LOW_SAMPLE_THRESHOLD, type TelemetryRun } from "../capabilities/telemetry/report.js";

const SCHEMA: TelemetrySchema = validateTelemetrySchema({
  schemaVersion: "1",
  id: "t.v1",
  genre: "test-genre",
  runSummary: {
    requiredFreshnessFields: ["runId", "producedAt"],
    fields: [
      { name: "runId", type: "string", required: true, binding: "events-file" },
      { name: "producedAt", type: "string", required: true, format: "iso-8601" },
      { name: "persona", type: "string", required: true, segmentable: true },
      { name: "outcome", type: "string", required: true, segmentable: true },
      { name: "bankedValue", type: "number", required: true, aggregate: "mean" },
      { name: "lostValue", type: "number", required: true, aggregate: "mean" },
    ],
  },
  eventStream: {
    timestampField: "t",
    events: [{ type: "loot_pickup", payload: [{ name: "t", type: "number", required: true }] }],
  },
}).schema!;

/** A minimal well-formed contract used as a base for refusal mutations. */
function baseContractRaw(): Record<string, unknown> {
  return {
    schemaVersion: "1",
    id: "t.personas.v1",
    genre: "test-genre",
    telemetrySchemaId: "t.v1",
    personaField: "persona",
    personas: [
      {
        id: "timid",
        intent: "Bank early and safely.",
        dials: [{ name: "lootGreedThreshold", min: 20, max: 120, unit: "pts" }],
        envelope: [
          { field: "outcome", stat: "rate", equals: "extracted", min: 0.8, max: 1.0 },
          { field: "bankedValue", stat: "mean", min: 0, max: 45 },
        ],
        calibrated: false,
        calibrationEvidence: null,
      },
    ],
  };
}

function run(runId: string, persona: string, outcome: string, banked: number, lost: number): TelemetryRun {
  return {
    runId,
    summary: { runId, producedAt: `2026-07-04T00:00:0${runId.slice(-1)}Z`, persona, outcome, bankedValue: banked, lostValue: lost },
    events: [],
  };
}

// ---------- schema refusals ----------

test("validatePersonaContract: accepts a well-formed contract bound to the telemetry schema", () => {
  const r = validatePersonaContract(baseContractRaw(), SCHEMA);
  assert.equal(r.ok, true, r.refusals.join("; "));
  assert.ok(r.contract);
  assert.equal(r.contract!.personas.length, 1);
});

test("refusal: an intent-less persona is refused (intent BEFORE pass rates)", () => {
  const raw = baseContractRaw();
  (raw.personas as Array<Record<string, unknown>>)[0].intent = "   ";
  const r = validatePersonaContract(raw, SCHEMA);
  assert.equal(r.ok, false);
  assert.ok(r.refusals.some((x) => /`intent` must be a non-empty string/.test(x)), r.refusals.join("; "));
});

test("refusal: an envelope field absent from the telemetry schema is refused (cross-binding)", () => {
  const raw = baseContractRaw();
  (raw.personas as Array<Record<string, unknown>>)[0].envelope = [
    { field: "ghostMetric", stat: "mean", min: 0, max: 1 },
  ];
  const r = validatePersonaContract(raw, SCHEMA);
  assert.equal(r.ok, false);
  assert.ok(r.refusals.some((x) => /`ghostMetric` is not a declared telemetry summary field/.test(x)), r.refusals.join("; "));
});

test("refusal: calibrated:true with no calibrationEvidence is refused (a claim needs evidence)", () => {
  const raw = baseContractRaw();
  const p = (raw.personas as Array<Record<string, unknown>>)[0];
  p.calibrated = true;
  p.calibrationEvidence = null;
  const r = validatePersonaContract(raw, SCHEMA);
  assert.equal(r.ok, false);
  assert.ok(r.refusals.some((x) => /`calibrated: true` requires a non-empty `calibrationEvidence`/.test(x)), r.refusals.join("; "));
});

test("refusal: a dial with min > max is refused", () => {
  const raw = baseContractRaw();
  (raw.personas as Array<Record<string, unknown>>)[0].dials = [{ name: "d", min: 10, max: 2 }];
  const r = validatePersonaContract(raw, SCHEMA);
  assert.equal(r.ok, false);
  assert.ok(r.refusals.some((x) => /dial `d` has min 10 > max 2/.test(x)), r.refusals.join("; "));
});

test("refusal: a rate band leaving [0,1] is refused", () => {
  const raw = baseContractRaw();
  (raw.personas as Array<Record<string, unknown>>)[0].envelope = [
    { field: "outcome", stat: "rate", equals: "extracted", min: 0.5, max: 1.4 },
  ];
  const r = validatePersonaContract(raw, SCHEMA);
  assert.equal(r.ok, false);
  assert.ok(r.refusals.some((x) => /is a rate but its band \[0.5, 1.4\] leaves \[0,1\]/.test(x)), r.refusals.join("; "));
});

test("refusal: stat 'mean' over a non-numeric telemetry field is refused", () => {
  const raw = baseContractRaw();
  (raw.personas as Array<Record<string, unknown>>)[0].envelope = [
    { field: "outcome", stat: "mean", min: 0, max: 1 },
  ];
  const r = validatePersonaContract(raw, SCHEMA);
  assert.equal(r.ok, false);
  assert.ok(r.refusals.some((x) => /uses stat "mean" but the telemetry field is `string`, not numeric/.test(x)), r.refusals.join("; "));
});

test("refusal: stat 'rate' over a non-segmentable telemetry field is refused", () => {
  const raw = baseContractRaw();
  (raw.personas as Array<Record<string, unknown>>)[0].envelope = [
    { field: "bankedValue", stat: "rate", equals: "x", min: 0, max: 1 },
  ];
  const r = validatePersonaContract(raw, SCHEMA);
  assert.equal(r.ok, false);
  assert.ok(r.refusals.some((x) => /uses stat "rate" but the telemetry field is not `segmentable`/.test(x)), r.refusals.join("; "));
});

test("refusal: personaField that is not segmentable in the telemetry schema is refused", () => {
  const raw = baseContractRaw();
  raw.personaField = "bankedValue"; // declared but not segmentable
  const r = validatePersonaContract(raw, SCHEMA);
  assert.equal(r.ok, false);
  assert.ok(r.refusals.some((x) => /`personaField` `bankedValue` is not `segmentable`/.test(x)), r.refusals.join("; "));
});

test("refusal: telemetrySchemaId mismatch is refused (keeps the two artifacts bound)", () => {
  const raw = baseContractRaw();
  raw.telemetrySchemaId = "some.other.v9";
  const r = validatePersonaContract(raw, SCHEMA);
  assert.equal(r.ok, false);
  assert.ok(r.refusals.some((x) => /≠ bound telemetry schema id `t.v1`/.test(x)), r.refusals.join("; "));
});

test("refusal (D6): a MISSING telemetrySchemaId is refused — the binding must be explicit", () => {
  const raw = baseContractRaw();
  delete raw.telemetrySchemaId;
  const r = validatePersonaContract(raw, SCHEMA);
  assert.equal(r.ok, false);
  assert.ok(
    r.refusals.some((x) => /`telemetrySchemaId` must be a non-empty string — the contract must NAME the telemetry schema/.test(x)),
    r.refusals.join("; "),
  );
});

test("warn (D5): a judgment word inside an intent statement WARNS (advisory) without blocking", () => {
  const raw = baseContractRaw();
  (raw.personas as Array<Record<string, unknown>>)[0].intent = "Play a good safe run and bank early.";
  const r = validatePersonaContract(raw, SCHEMA);
  assert.equal(r.ok, true, r.refusals.join("; ")); // NOT a refusal — data is the author's
  assert.equal(r.warnings.length, 1);
  assert.ok(/`intent` contains a judgment word \(good\)/.test(r.warnings[0]!), r.warnings[0]);
  // A clean intent produces no warnings.
  const clean = validatePersonaContract(baseContractRaw(), SCHEMA);
  assert.deepEqual(clean.warnings, []);
});

test("refusal: a duplicate persona id is refused", () => {
  const raw = baseContractRaw();
  const one = (raw.personas as Array<Record<string, unknown>>)[0];
  raw.personas = [one, { ...one }];
  const r = validatePersonaContract(raw, SCHEMA);
  assert.equal(r.ok, false);
  assert.ok(r.refusals.some((x) => /persona id `timid` is declared more than once/.test(x)), r.refusals.join("; "));
});

test("refusal: an empty envelope is refused (an unbanded persona can't be checked for drift)", () => {
  const raw = baseContractRaw();
  (raw.personas as Array<Record<string, unknown>>)[0].envelope = [];
  const r = validatePersonaContract(raw, SCHEMA);
  assert.equal(r.ok, false);
  assert.ok(r.refusals.some((x) => /`envelope` must declare at least one/.test(x)), r.refusals.join("; "));
});

// ---------- envelope evaluation math (hand-computed) ----------

const GREEDY_CONTRACT: PersonaContract = validatePersonaContract(
  {
    schemaVersion: "1",
    id: "t.personas.v1",
    genre: "test-genre",
    telemetrySchemaId: "t.v1",
    personaField: "persona",
    personas: [
      {
        id: "greedy",
        intent: "Chase high-value loot.",
        dials: [{ name: "greed", min: 0, max: 1 }],
        envelope: [
          { field: "bankedValue", stat: "mean", min: 60, max: 150 },
          { field: "outcome", stat: "rate", equals: "extracted", min: 0.3, max: 0.7 },
          { field: "outcome", stat: "rate", equals: "died", min: 0.25, max: 0.6 },
        ],
        calibrated: true,
        calibrationEvidence: "reports/greedy-cohort.json",
      },
    ],
  },
  SCHEMA,
).contract!;

test("envelope math: mean(bankedValue) and rate(outcome=...) are hand-computed and in-band", () => {
  // banked 100 & 120 → mean 110; outcomes extracted+died → each rate 0.5.
  const runs = [run("g-1", "greedy", "extracted", 100, 0), run("g-2", "greedy", "died", 120, 50)];
  const report = buildPersonaCohortReport(GREEDY_CONTRACT, SCHEMA, runs);
  const greedy = report.personas.find((p) => p.personaId === "greedy")!;
  assert.equal(greedy.runCount, 2);
  const banked = greedy.bands.find((b) => b.metricKey === "mean(bankedValue)")!;
  assert.deepEqual({ observed: banked.observed, inBand: banked.inBand }, { observed: 110, inBand: true });
  const extractRate = greedy.bands.find((b) => b.metricKey === "rate(outcome=extracted)")!;
  assert.deepEqual({ observed: extractRate.observed, inBand: extractRate.inBand }, { observed: 0.5, inBand: true });
  const deathRate = greedy.bands.find((b) => b.metricKey === "rate(outcome=died)")!;
  assert.deepEqual({ observed: deathRate.observed, inBand: deathRate.inBand }, { observed: 0.5, inBand: true });
  assert.equal(greedy.drift, false);
});

test("metricKeyFor: canonical mean(...) and rate(field=value) keys", () => {
  assert.equal(metricKeyFor({ field: "bankedValue", stat: "mean" }), "mean(bankedValue)");
  assert.equal(metricKeyFor({ field: "outcome", stat: "rate", equals: "died" }), "rate(outcome=died)");
});

test("metricKeyFor (D8): '='/'('/')' in field/equals are escaped so distinct specs never collide", () => {
  // Without escaping these two DIFFERENT specs would both render `rate(a=b=c)`.
  const k1 = metricKeyFor({ field: "a=b", stat: "rate", equals: "c" });
  const k2 = metricKeyFor({ field: "a", stat: "rate", equals: "b=c" });
  assert.notEqual(k1, k2);
  assert.equal(k1, "rate(a\\=b=c)");
  assert.equal(k2, "rate(a=b\\=c)");
  assert.equal(metricKeyFor({ field: "weird)field(", stat: "mean" }), "mean(weird\\)field\\()");
});

test("envelope math: a persona with NO runs reports observed null / inBand null (not a pass)", () => {
  const report = buildPersonaCohortReport(GREEDY_CONTRACT, SCHEMA, []);
  const greedy = report.personas.find((p) => p.personaId === "greedy")!;
  assert.equal(greedy.noRuns, true);
  assert.equal(greedy.drift, false);
  for (const b of greedy.bands) {
    assert.equal(b.observed, null);
    assert.equal(b.inBand, null);
  }
});

// ---------- sample accounting (D1 + D3) ----------

const CAL_LOW_N_CONTRACT: PersonaContract = validatePersonaContract(
  {
    schemaVersion: "1",
    id: "t.personas.v1",
    telemetrySchemaId: "t.v1",
    personaField: "persona",
    personas: [
      {
        id: "timid",
        intent: "Bank early and safely.",
        dials: [],
        envelope: [{ field: "bankedValue", stat: "mean", min: 0, max: 200 }],
        calibrated: true,
        calibrationEvidence: "reports/timid-calibration.json",
      },
    ],
  },
  SCHEMA,
).contract!;

test("low sample (D1): a CALIBRATED persona graded from 1 in-band run carries the low-sample caveat next to its verdict", () => {
  const report = buildPersonaCohortReport(CAL_LOW_N_CONTRACT, SCHEMA, [run("t-1", "timid", "extracted", 100, 0)]);
  const timid = report.personas.find((p) => p.personaId === "timid")!;
  // In-band, calibrated — and STILL an anecdote.
  assert.equal(timid.drift, false);
  assert.equal(timid.calibrated, true);
  assert.equal(timid.sampleCaveats.length, 1);
  assert.match(timid.sampleCaveats[0]!, /LOW SAMPLE: envelope graded from 1 run\(s\); treat as anecdote, not signal/);
  // Rendered NEXT TO the envelope verdict line, and n=1 renders "single observation".
  const text = renderPersonaCohortReportText(report);
  const lines = text.split("\n");
  const verdictIdx = lines.findIndex((l) => l === PERSONA_RENDER_TEMPLATES.inEnvelopeMarker);
  assert.ok(verdictIdx >= 0);
  assert.match(lines[verdictIdx + 1]!, /⚠ LOW SAMPLE: envelope graded from 1 run\(s\)/);
  assert.match(text, /\| mean\(bankedValue\) \| \[0, 200\] \| 100 \(single observation\) \| 1 \| 0 \| yes \|/);
});

test("low sample (D1): the threshold is SHARED with Wave-A — a persona with LOW_SAMPLE_THRESHOLD runs has no caveat", () => {
  const runs = Array.from({ length: LOW_SAMPLE_THRESHOLD }, (_, i) => run(`t-${i}`, "timid", "extracted", 100, 0));
  const report = buildPersonaCohortReport(CAL_LOW_N_CONTRACT, SCHEMA, runs);
  assert.deepEqual(report.personas[0]!.sampleCaveats, []);
  // And n-1 runs still carries it (boundary).
  const under = buildPersonaCohortReport(CAL_LOW_N_CONTRACT, SCHEMA, runs.slice(0, LOW_SAMPLE_THRESHOLD - 1));
  assert.equal(under.personas[0]!.sampleCaveats.length, 1);
});

test("sample accounting (D3): mean surfaces observedCount/missingCount instead of silently shrinking", () => {
  // 3 timid runs; one omits bankedValue → mean over 2 values, missing=1, all visible.
  const runs: TelemetryRun[] = [
    run("t-1", "timid", "extracted", 100, 0),
    run("t-2", "timid", "extracted", 120, 0),
    { runId: "t-3", summary: { runId: "t-3", producedAt: "2026-07-04T00:00:03Z", persona: "timid", outcome: "extracted", lostValue: 0 }, events: [] },
  ];
  const report = buildPersonaCohortReport(CAL_LOW_N_CONTRACT, SCHEMA, runs);
  const band = report.personas[0]!.bands[0]!;
  assert.deepEqual(
    { observed: band.observed, observedCount: band.observedCount, missingCount: band.missingCount },
    { observed: 110, observedCount: 2, missingCount: 1 },
  );
  // Rendered: n and missing columns carry the accounting.
  assert.match(renderPersonaCohortReportText(report), /\| mean\(bankedValue\) \| \[0, 200\] \| 110 \| 2 \| 1 \| yes \|/);
});

test("sample accounting (D3): a rate's denominator is the PRESENT runs — a missing field is surfaced, never zero-counted", () => {
  // 3 greedy runs; one omits `outcome`. Zero-counting the missing run into the
  // denominator would report 2/3 ≈ 0.667; the honest rate is 2/2 = 1 with missing=1.
  const runs: TelemetryRun[] = [
    run("g-1", "greedy", "extracted", 100, 0),
    run("g-2", "greedy", "extracted", 120, 0),
    { runId: "g-3", summary: { runId: "g-3", producedAt: "2026-07-04T00:00:03Z", persona: "greedy", bankedValue: 50, lostValue: 0 }, events: [] },
  ];
  const report = buildPersonaCohortReport(GREEDY_CONTRACT, SCHEMA, runs);
  const band = report.personas[0]!.bands.find((b) => b.metricKey === "rate(outcome=extracted)")!;
  assert.deepEqual(
    { observed: band.observed, observedCount: band.observedCount, missingCount: band.missingCount },
    { observed: 1, observedCount: 2, missingCount: 1 },
  );
});

// ---------- drift + caveats ----------

const TIMID_CONTRACT: PersonaContract = validatePersonaContract(baseContractRaw(), SCHEMA).contract!;

test("drift caveat: a persona outside its OWN envelope is flagged as persona drift", () => {
  // Timid envelope wants extraction rate 0.8..1.0; give it 0.5 → out of band → drift.
  const runs = [run("t-1", "timid", "extracted", 10, 0), run("t-2", "timid", "died", 0, 5)];
  const report = buildPersonaCohortReport(TIMID_CONTRACT, SCHEMA, runs);
  const timid = report.personas.find((p) => p.personaId === "timid")!;
  assert.equal(timid.drift, true);
  assert.deepEqual(timid.driftFields, ["rate(outcome=extracted)"]);
  assert.deepEqual(report.driftPersonas, ["timid"]);
  assert.ok(report.caveats.some((c) => /PERSONA DRIFT: timid fell outside their OWN declared envelope/.test(c)), report.caveats.join(" | "));
  // The drift caveat is explicitly a report caveat about the BOT, not a game-balance claim.
  assert.ok(report.caveats.some((c) => /NOT a game-balance claim/.test(c)));
});

test("uncalibrated caveat: an uncalibrated persona is prominently flagged", () => {
  const runs = [run("t-1", "timid", "extracted", 10, 0)];
  const report = buildPersonaCohortReport(TIMID_CONTRACT, SCHEMA, runs);
  assert.deepEqual(report.uncalibratedPersonas, ["timid"]);
  assert.ok(report.caveats.some((c) => /UNCALIBRATED PERSONA\(S\): timid/.test(c)), report.caveats.join(" | "));
});

test("no-runs + undeclared caveats fire independently", () => {
  // Contract declares only "timid"; the runs are all "reckless" → timid has no runs AND
  // reckless is undeclared.
  const runs = [run("r-1", "reckless", "died", 0, 90)];
  const report = buildPersonaCohortReport(TIMID_CONTRACT, SCHEMA, runs);
  assert.deepEqual(report.noRunPersonas, ["timid"]);
  // D7: undeclared personas surface their run counts, in the JSON and in the caveat.
  assert.deepEqual(report.undeclaredCohortPersonas, [{ id: "reckless", runCount: 1 }]);
  assert.ok(report.caveats.some((c) => /NO RUNS: persona\(s\) timid/.test(c)));
  assert.ok(report.caveats.some((c) => /UNDECLARED PERSONA\(S\) IN COHORT: reckless \(1 run\(s\)\)/.test(c)));
});

test("unattributed runs (D7): a missing/empty persona value is bucketed + caveated, never silently dropped", () => {
  const emptyPersona = run("e-1", "", "extracted", 10, 0); // present-but-empty-string persona
  const missingPersona: TelemetryRun = {
    runId: "e-2",
    summary: { runId: "e-2", producedAt: "2026-07-04T00:00:02Z", outcome: "died", bankedValue: 0, lostValue: 5 },
    events: [],
  };
  const report = buildPersonaCohortReport(TIMID_CONTRACT, SCHEMA, [emptyPersona, missingPersona, run("t-1", "timid", "extracted", 10, 0)]);
  assert.equal(report.unattributedRunCount, 2);
  assert.ok(report.caveats.some((c) => /UNATTRIBUTED RUNS: 2 run\(s\) carry a missing or empty `persona` value/.test(c)), report.caveats.join(" | "));
  // The unattributed runs never leak into a declared persona's grading.
  assert.equal(report.personas.find((p) => p.personaId === "timid")!.runCount, 1);
  // Nor into the undeclared list (they carry no persona id to declare).
  assert.deepEqual(report.undeclaredCohortPersonas, []);
});

// ---------- spread table + determinism ----------

const SPREAD_CONTRACT: PersonaContract = validatePersonaContract(
  {
    schemaVersion: "1",
    id: "t.personas.v1",
    telemetrySchemaId: "t.v1",
    personaField: "persona",
    personas: [
      { id: "timid", intent: "Safe.", dials: [], envelope: [{ field: "bankedValue", stat: "mean", min: 0, max: 45 }], calibrated: false, calibrationEvidence: null },
      { id: "greedy", intent: "Greedy.", dials: [], envelope: [{ field: "outcome", stat: "rate", equals: "died", min: 0.25, max: 0.6 }], calibrated: false, calibrationEvidence: null },
    ],
  },
  SCHEMA,
).contract!;

test("spread table: metric-key union is sorted and every persona is evaluated over every column", () => {
  const runs = [
    run("t-1", "timid", "extracted", 10, 0),
    run("g-1", "greedy", "died", 100, 50),
    run("g-2", "greedy", "extracted", 120, 0),
  ];
  const report = buildPersonaCohortReport(SPREAD_CONTRACT, SCHEMA, runs);
  // Union of both personas' bands, sorted.
  assert.deepEqual(report.spread.metricKeys, ["mean(bankedValue)", "rate(outcome=died)"]);
  const timidRow = report.spread.rows.find((r) => r.personaId === "timid")!;
  // timid: mean bankedValue = 10; death rate = 0/1 = 0.
  assert.deepEqual(timidRow.observed, [10, 0]);
  const greedyRow = report.spread.rows.find((r) => r.personaId === "greedy")!;
  // greedy: mean bankedValue = 110; death rate = 1/2 = 0.5.
  assert.deepEqual(greedyRow.observed, [110, 0.5]);
});

test("spread trust markers (D4): a drifted persona's spread row is marked INLINE; a run-less row says (no runs)", () => {
  // timid banked mean 100 > its 0..45 band → drift; greedy has no runs.
  const runs = [run("t-1", "timid", "extracted", 100, 0)];
  const report = buildPersonaCohortReport(SPREAD_CONTRACT, SCHEMA, runs);
  const timidRow = report.spread.rows.find((r) => r.personaId === "timid")!;
  assert.equal(timidRow.drift, true);
  const greedyRow = report.spread.rows.find((r) => r.personaId === "greedy")!;
  assert.equal(greedyRow.noRuns, true);
  const text = renderPersonaCohortReportText(report);
  assert.match(text, /\| timid ⚠drift \| 100 \| 0 \|/);
  assert.match(text, /\| greedy \(no runs\) \| — \| — \|/);
});

/** Strip the build-provenance surface: producedBy from JSON, its line from text. */
function jsonBody(report: PersonaCohortReport): string {
  const { producedBy, ...rest } = report;
  void producedBy;
  return stablePersonaStringify(rest);
}
function textBody(report: PersonaCohortReport): string {
  return renderPersonaCohortReportText(report)
    .split("\n")
    .filter((l) => !l.startsWith("Produced by:"))
    .join("\n");
}

test("determinism: byte-identical for identical input EXCLUDING the producedBy provenance", () => {
  const runs = [run("t-1", "timid", "extracted", 10, 0), run("g-1", "greedy", "died", 100, 50)];
  const mk = () => buildPersonaCohortReport(SPREAD_CONTRACT, SCHEMA, runs);
  assert.equal(jsonBody(mk()), jsonBody(mk()));
  assert.equal(textBody(mk()), textBody(mk()));
});

// ---------- before/after: per-set cohorts, never merged (D2) ----------

test("before/after (D2): each set is graded as its OWN cohort and the verdict transition is stated", () => {
  // Before: timid banked mean 100 → outside its 0..45 band → drift.
  // After:  timid banked mean 20 → in-band. Greedy has runs only after.
  const beforeRuns = [run("t-1", "timid", "extracted", 100, 0)];
  // Greedy after: one died + one extracted → rate(outcome=died) = 0.5 ∈ [0.25, 0.6].
  const afterRuns = [run("t-2", "timid", "extracted", 20, 0), run("g-1", "greedy", "died", 100, 50), run("g-2", "greedy", "extracted", 80, 0)];
  const before = buildPersonaCohortReport(SPREAD_CONTRACT, SCHEMA, beforeRuns, "before");
  const after = buildPersonaCohortReport(SPREAD_CONTRACT, SCHEMA, afterRuns, "after");
  assert.equal(before.cohortLabel, "before");
  assert.equal(after.cohortLabel, "after");
  // Each cohort's grading is over ITS OWN runs only — no merged mix.
  assert.equal(before.personas.find((p) => p.personaId === "timid")!.runCount, 1);
  assert.equal(after.personas.find((p) => p.personaId === "timid")!.runCount, 1);
  assert.equal(after.personas.find((p) => p.personaId === "greedy")!.runCount, 2);

  const deltas = buildPersonaCohortComparison(before, after);
  assert.deepEqual(deltas, [
    {
      personaId: "timid",
      before: { state: "drift", driftFields: ["mean(bankedValue)"] },
      after: { state: "in-envelope" },
    },
    {
      personaId: "greedy",
      before: { state: "no-runs" },
      after: { state: "in-envelope" },
    },
  ]);

  const text = renderPersonaCohortComparisonText(before, after, deltas);
  assert.match(text, /## Persona envelope verdicts: before → after/);
  assert.match(text, /- timid: drift\(mean\(bankedValue\)\) → in-envelope/);
  assert.match(text, /- greedy: no-runs → in-envelope/);
  // The never-merged rule is stated in the rendered comparison itself.
  assert.match(text, /never evaluated over a merged mix of two game versions/);
});

test("before/after (D2): a merged-cohort grading would have hidden the drift the split surfaces", () => {
  // Merged, timid's banked mean would be (100+20)/2 = 60 — still out of band here, but
  // the point is sharper on the rate: merged timid extraction data would also blend two
  // game versions. Assert the split's BEFORE drift survives (the merged mean 60 differs
  // from both per-set means, proving the merge changes the graded number).
  const beforeRuns = [run("t-1", "timid", "extracted", 100, 0)];
  const afterRuns = [run("t-2", "timid", "extracted", 20, 0)];
  const before = buildPersonaCohortReport(SPREAD_CONTRACT, SCHEMA, beforeRuns, "before");
  const after = buildPersonaCohortReport(SPREAD_CONTRACT, SCHEMA, afterRuns, "after");
  const merged = buildPersonaCohortReport(SPREAD_CONTRACT, SCHEMA, [...beforeRuns, ...afterRuns], "merged");
  const bandOf = (r: PersonaCohortReport) => r.personas[0]!.bands[0]!.observed;
  assert.equal(bandOf(before), 100);
  assert.equal(bandOf(after), 20);
  assert.equal(bandOf(merged), 60); // neither cohort's truth — why the CLI never grades merged
});

// ---------- no-fun-verdict guard ----------

test("no-fun-verdict guard: the persona render TEMPLATES carry no judgment words (structural)", () => {
  const banned = /\b(better|worse|improved|improvement|regressed|regression|good|bad|fun)\b/i;
  for (const [key, value] of Object.entries(PERSONA_RENDER_TEMPLATES)) {
    assert.ok(!banned.test(value), `PERSONA_RENDER_TEMPLATES.${key} contains a judgment word: "${value}"`);
  }
});

test("no-fun-verdict guard: rendered body is judgment-free even with judgment-shaped persona ids", () => {
  const tricky = validatePersonaContract(
    {
      schemaVersion: "1",
      id: "t.personas.v1",
      telemetrySchemaId: "t.v1",
      personaField: "persona",
      personas: [
        { id: "reckless-worst-case", intent: "Probe.", dials: [], envelope: [{ field: "bankedValue", stat: "mean", min: 0, max: 45 }], calibrated: false, calibrationEvidence: null },
      ],
    },
    SCHEMA,
  ).contract!;
  const report = buildPersonaCohortReport(tricky, SCHEMA, [run("x-1", "reckless-worst-case", "extracted", 10, 0)]);
  assert.equal(report.disclaimer, PERSONA_REPORT_DISCLAIMER);
  const body = renderPersonaCohortReportText(report)
    .split("\n")
    .filter((l) => !l.includes(PERSONA_REPORT_DISCLAIMER))
    .join("\n");
  const banned = /\b(better|worse|improved|regressed)\b/i;
  assert.ok(!banned.test(body), "persona report body must not judge");
});

// ---------- shipped seed ----------

test("seed: 3d-topdown-arena personas.json validates + binds clean against the pack telemetry.json", async () => {
  const telemetryPath = telemetrySchemaPathForGenre("3d-topdown-arena")!;
  const telemetrySchema = validateTelemetrySchema(JSON.parse(await fs.readFile(telemetryPath, "utf8"))).schema!;
  const personaPath = personaContractPathForGenre("3d-topdown-arena")!;
  const raw = JSON.parse(await fs.readFile(personaPath, "utf8"));
  const r = validatePersonaContract(raw, telemetrySchema);
  assert.equal(r.ok, true, r.refusals.join("; "));
  // The seed's intent statements are behavior-stating — no advisory judgment-word warns.
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(r.contract!.personas.map((p) => p.id), ["timid", "balanced", "greedy", "reckless"]);
  // Honest posture: the seed ships every persona uncalibrated (design-doc-derived placeholders).
  assert.ok(r.contract!.personas.every((p) => p.calibrated === false));
  assert.ok(r.contract!.implementationContract && /persona/i.test(r.contract!.implementationContract));
});
