/**
 * Tuning-report aggregation: hand-computed aggregate math, before/after deltas, the
 * lever-isolation states (clean / other-lever warning / not-found / dotted-nested /
 * key-order-independent), sample-size caveats (D3), epoch-based dataAsOf (D4),
 * deterministic output scoped to exclude the build-provenance line (D5), the
 * STRUCTURAL no-fun-verdict guard over the render templates (D8), and the loader
 * end-to-end (pairing, rejected runs excluded, duplicate-runId whole-set refusal D1).
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { validateTelemetrySchema, type TelemetrySchema } from "../../../../capabilities/telemetry/schema.js";
import {
  aggregateSet,
  buildTuningReport,
  buildLeverIsolation,
  deepEqual,
  stableStringify,
  renderTuningReportText,
  RENDER_TEMPLATES,
  TUNING_REPORT_DISCLAIMER,
  type TelemetryRun,
  type TuningReport,
} from "../../../../capabilities/telemetry/report.js";
import { loadRunSet } from "../../../../capabilities/telemetry/loader.js";

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
      { name: "bankedValue", type: "number", required: true, aggregate: "mean" },
      { name: "lostValue", type: "number", required: true, aggregate: "mean" },
    ],
  },
  eventStream: {
    timestampField: "t",
    events: [
      { type: "loot_complete", payload: [{ name: "t", type: "number", required: true }, { name: "tier", type: "string", required: true }] },
    ],
  },
}).schema!;

function run(runId: string, persona: string, banked: number, lost: number, tiers: string[]): TelemetryRun {
  return {
    runId,
    summary: { runId, producedAt: `2026-07-04T00:00:0${runId.slice(-1)}Z`, persona, bankedValue: banked, lostValue: lost },
    events: tiers.map((tier, i) => ({ type: "loot_complete", t: (i + 1) * 10, tier, runId })),
  };
}

const BEFORE = [run("run-1", "greedy", 100, 0, ["common", "rare"]), run("run-2", "timid", 50, 10, ["common"])];
const AFTER = [run("run-1", "greedy", 120, 0, ["rare"]), run("run-2", "timid", 60, 5, ["common"])];

test("aggregateSet: hand-computed mean/min/max/sum/count", () => {
  const agg = aggregateSet("before", "/x", BEFORE, 0, SCHEMA);
  const banked = agg.metrics.find((m) => m.field === "bankedValue")!;
  assert.deepEqual(
    { mean: banked.mean, min: banked.min, max: banked.max, sum: banked.sum, count: banked.count, missing: banked.missing },
    { mean: 75, min: 50, max: 100, sum: 150, count: 2, missing: 0 },
  );
  const lost = agg.metrics.find((m) => m.field === "lostValue")!;
  assert.equal(lost.mean, 5);
});

test("aggregateSet: segmentation by persona + event/loot-tier counts", () => {
  const agg = aggregateSet("before", "/x", BEFORE, 0, SCHEMA);
  const greedy = agg.segments.find((s) => s.field === "persona" && s.value === "greedy")!;
  assert.equal(greedy.metrics.find((m) => m.field === "bankedValue")!.mean, 100);
  const timid = agg.segments.find((s) => s.field === "persona" && s.value === "timid")!;
  assert.equal(timid.metrics.find((m) => m.field === "bankedValue")!.mean, 50);
  assert.equal(agg.events.find((e) => e.type === "loot_complete")!.count, 3);
  assert.deepEqual(agg.lootTiers, [{ tier: "common", count: 2 }, { tier: "rare", count: 1 }]);
});

test("aggregateSet: a missing metric value is COUNTED as missing, not dropped silently", () => {
  const partial: TelemetryRun[] = [
    run("run-1", "greedy", 100, 0, []),
    { runId: "run-2", summary: { runId: "run-2", producedAt: "2026-07-04T00:00:02Z", persona: "timid", lostValue: 3 }, events: [] },
  ];
  const agg = aggregateSet("before", "/x", partial, 0, SCHEMA);
  const banked = agg.metrics.find((m) => m.field === "bankedValue")!;
  assert.equal(banked.count, 1);
  assert.equal(banked.missing, 1);
  assert.equal(banked.mean, 100);
});

test("sample caveats (D3): a small set carries LOW SAMPLE in JSON and rendered text", () => {
  const agg = aggregateSet("before", "/x", BEFORE, 0, SCHEMA); // 2 runs < 5
  assert.equal(agg.sampleCaveats.length, 1);
  assert.match(agg.sampleCaveats[0]!, /LOW SAMPLE: means from 2 accepted run\(s\); treat as anecdote, not signal/);
  const report = buildTuningReport({ schema: SCHEMA, before: { label: "before", dir: "/x", runs: BEFORE, rejected: [] } });
  const text = renderTuningReportText(report);
  assert.match(text, /⚠ LOW SAMPLE: means from 2 accepted run\(s\)/);
});

test("sample caveats (D3): rejected > accepted adds the REJECTED MAJORITY caveat", () => {
  const rejected = Array.from({ length: 3 }, (_, i) => ({ set: "before", runId: `bad-${i}`, refusals: ["x"] }));
  const agg = aggregateSet("before", "/x", [run("run-1", "greedy", 100, 0, [])], rejected.length, SCHEMA);
  assert.ok(agg.sampleCaveats.some((c) => /REJECTED MAJORITY: 3 run\(s\) rejected vs 1 accepted/.test(c)), agg.sampleCaveats.join("; "));
});

test("sample caveats (D3): n=1 renders 'single observation' instead of mean/min/max statistics", () => {
  const report = buildTuningReport({
    schema: SCHEMA,
    before: { label: "before", dir: "/x", runs: [run("run-1", "greedy", 100, 0, [])], rejected: [] },
  });
  const text = renderTuningReportText(report);
  assert.match(text, /\| bankedValue \|\s+\| 100 \(single observation\) \| — \| — \| 1 \| 0 \|/);
});

test("sample caveats (D3): a 5-run set has NO low-sample caveat", () => {
  const runs = [1, 2, 3, 4, 5].map((i) => run(`run-${i}`, "greedy", i * 10, 0, []));
  const agg = aggregateSet("before", "/x", runs, 0, SCHEMA);
  assert.deepEqual(agg.sampleCaveats, []);
});

test("buildTuningReport: before/after deltas are correct (overall + per-segment)", () => {
  const report = buildTuningReport({
    schema: SCHEMA,
    before: { label: "before", dir: "/b", runs: BEFORE, rejected: [] },
    after: { label: "after", dir: "/a", runs: AFTER, rejected: [] },
    lever: "mapScale",
  });
  const banked = report.comparison!.metrics.find((m) => m.field === "bankedValue")!;
  assert.deepEqual({ before: banked.beforeMean, after: banked.afterMean, delta: banked.delta }, { before: 75, after: 90, delta: 15 });
  const lost = report.comparison!.metrics.find((m) => m.field === "lostValue")!;
  assert.deepEqual({ before: lost.beforeMean, after: lost.afterMean, delta: lost.delta }, { before: 5, after: 2.5, delta: -2.5 });
  const greedySeg = report.comparison!.segments.find((s) => s.value === "greedy")!;
  assert.equal(greedySeg.metrics.find((m) => m.field === "bankedValue")!.delta, 20);
});

test("dataAsOf: chronologically latest producedAt by EPOCH, original string kept (D4 — string-max mis-ranks offsets)", () => {
  // "2026-07-04T02:00:00+02:00" is epoch 00:00Z — EARLIER than "2026-07-04T01:00:00Z",
  // yet string-max would pick it (\"02:\" > \"01:\"). Epoch comparison must win.
  const runs: TelemetryRun[] = [
    { runId: "r1", summary: { runId: "r1", producedAt: "2026-07-04T02:00:00+02:00", persona: "greedy", bankedValue: 1, lostValue: 0 }, events: [] },
    { runId: "r2", summary: { runId: "r2", producedAt: "2026-07-04T01:00:00Z", persona: "timid", bankedValue: 2, lostValue: 0 }, events: [] },
  ];
  const report = buildTuningReport({ schema: SCHEMA, before: { label: "before", dir: "/x", runs, rejected: [] } });
  assert.equal(report.dataAsOf, "2026-07-04T01:00:00Z");
});

test("dataAsOf: the winning run's ORIGINAL string round-trips verbatim", () => {
  const runs: TelemetryRun[] = [
    { runId: "r1", summary: { runId: "r1", producedAt: "2026-07-04T05:30:00+05:30", persona: "greedy", bankedValue: 1, lostValue: 0 }, events: [] },
  ];
  const report = buildTuningReport({ schema: SCHEMA, before: { label: "before", dir: "/x", runs, rejected: [] } });
  assert.equal(report.dataAsOf, "2026-07-04T05:30:00+05:30");
});

/** Strip the build-provenance surface (D5): producedBy from JSON, its line from text. */
function jsonBody(report: TuningReport): string {
  const { producedBy, ...rest } = report;
  void producedBy;
  return stableStringify(rest);
}
function textBody(report: TuningReport): string {
  return renderTuningReportText(report)
    .split("\n")
    .filter((l) => !l.startsWith("Produced by:"))
    .join("\n");
}

test("determinism (D5): byte-identical for identical input EXCLUDING the producedBy provenance", () => {
  const mk = () =>
    buildTuningReport({
      schema: SCHEMA,
      before: { label: "before", dir: "/b", runs: BEFORE, rejected: [] },
      after: { label: "after", dir: "/a", runs: AFTER, rejected: [] },
      lever: "mapScale",
    });
  assert.equal(jsonBody(mk()), jsonBody(mk()));
  assert.equal(textBody(mk()), textBody(mk()));
});

test("determinism scope is stated in the report header (D5)", () => {
  const report = buildTuningReport({ schema: SCHEMA, before: { label: "before", dir: "/b", runs: BEFORE, rejected: [] } });
  const text = renderTuningReportText(report);
  assert.ok(text.includes(RENDER_TEMPLATES.determinismNote));
  assert.match(RENDER_TEMPLATES.determinismNote, /under the same build/);
});

test("lever isolation: clean when only the declared lever changed", () => {
  const li = buildLeverIsolation("mapScale", { enemySpeed: 5, mapScale: 40 }, { enemySpeed: 5, mapScale: 48 });
  assert.equal(li.checked, true);
  assert.equal(li.otherChangedLevers.length, 0);
  assert.equal(li.declaredLeverState, "changed");
  assert.equal(li.declaredLeverChanged, true);
  assert.equal(li.warning, null);
});

test("lever isolation: WARNS (does not block) when another lever also moved", () => {
  const li = buildLeverIsolation("mapScale", { enemySpeed: 5, mapScale: 40 }, { enemySpeed: 6, mapScale: 48 });
  assert.equal(li.checked, true);
  assert.deepEqual(li.otherChangedLevers.map((c) => c.key), ["enemySpeed"]);
  assert.ok(li.warning && /LEVER-ISOLATION WARNING/.test(li.warning));
});

test("lever isolation: notes it is UNCHECKED when no config supplied", () => {
  const li = buildLeverIsolation("mapScale", null, null);
  assert.equal(li.checked, false);
  assert.equal(li.declaredLeverState, null);
  assert.match(li.note!, /NOT checked/);
});

test("lever isolation (D6): a lever absent from BOTH configs is NOT FOUND (warned with bounded key hint), not 'did not change'", () => {
  const li = buildLeverIsolation("mapScaleTypo", { enemySpeed: 5, mapScale: 40 }, { enemySpeed: 5, mapScale: 40 });
  assert.equal(li.declaredLeverState, "not-found");
  assert.equal(li.declaredLeverChanged, null);
  assert.ok(li.warning && /NOT FOUND in either config/.test(li.warning), String(li.warning));
  assert.ok(/top-level keys: enemySpeed, mapScale/.test(li.warning!));
});

test("lever isolation (D6): the not-found key hint is bounded", () => {
  const big: Record<string, unknown> = {};
  for (let i = 0; i < 30; i++) big[`k${String(i).padStart(2, "0")}`] = i;
  const li = buildLeverIsolation("ghost", big, big);
  assert.equal(li.declaredLeverState, "not-found");
  assert.ok(/\(\+15 more\)/.test(li.warning!), String(li.warning));
});

test("lever isolation (D6): present-but-identical lever is state 'same'", () => {
  const li = buildLeverIsolation("mapScale", { mapScale: 40 }, { mapScale: 40 });
  assert.equal(li.declaredLeverState, "same");
  assert.equal(li.declaredLeverChanged, false);
  assert.match(li.note!, /SAME value in both configs/);
});

test("lever isolation (D6): dotted nested lever path works, and naming a subtree owns its leaves", () => {
  const before = { physics: { enemySpeed: 5, gravity: -9.8 }, mapScale: 40 };
  const after = { physics: { enemySpeed: 6, gravity: -9.8 }, mapScale: 40 };
  const leaf = buildLeverIsolation("physics.enemySpeed", before, after);
  assert.equal(leaf.declaredLeverState, "changed");
  assert.equal(leaf.otherChangedLevers.length, 0);
  assert.equal(leaf.warning, null);
  // Naming the subtree also owns the changed leaf under it.
  const subtree = buildLeverIsolation("physics", before, after);
  assert.equal(subtree.declaredLeverState, "changed");
  assert.equal(subtree.otherChangedLevers.length, 0);
  // A nested change under a DIFFERENT declared lever is flagged by its dotted path.
  const other = buildLeverIsolation("mapScale", before, after);
  assert.equal(other.declaredLeverState, "same");
  assert.deepEqual(other.otherChangedLevers.map((c) => c.key), ["physics.enemySpeed"]);
});

test("lever isolation (D7): reordered-but-equal nested config raises NO spurious warning (key-order independent)", () => {
  const before = { a: { x: 1, y: [1, 2, { z: 3 }] }, mapScale: 40 };
  const after = { mapScale: 48, a: { y: [1, 2, { z: 3 }], x: 1 } }; // same values, different key order
  const li = buildLeverIsolation("mapScale", before, after);
  assert.equal(li.declaredLeverState, "changed");
  assert.equal(li.otherChangedLevers.length, 0);
  assert.equal(li.warning, null);
});

test("deepEqual: recursive, key-order independent, arrays ordered", () => {
  assert.equal(deepEqual({ a: 1, b: { c: 2 } }, { b: { c: 2 }, a: 1 }), true);
  assert.equal(deepEqual([1, 2], [2, 1]), false);
  assert.equal(deepEqual({ a: 1 }, { a: 1, b: 2 }), false);
  assert.equal(deepEqual(NaN, NaN), true);
});

test("no-fun-verdict guard (D8): the render TEMPLATES carry no judgment words (structural)", () => {
  const banned = /\b(better|worse|improved|improvement|regressed|regression|good|bad|fun)\b/i;
  for (const [key, value] of Object.entries(RENDER_TEMPLATES)) {
    assert.ok(!banned.test(value), `RENDER_TEMPLATES.${key} contains a judgment word: "${value}"`);
  }
});

test("no-fun-verdict guard (D8): rendered output body is judgment-free (word-boundary belt) even with judgment-shaped data values", () => {
  // A persona value containing "worse" as a SUBSTRING must not trip the guard, and the
  // report itself must not add judgment words around it.
  const trickyRuns = [
    { runId: "run-1", summary: { runId: "run-1", producedAt: "2026-07-04T00:00:01Z", persona: "reckless-worst-case", bankedValue: 1, lostValue: 0 }, events: [] },
  ];
  const report = buildTuningReport({
    schema: SCHEMA,
    before: { label: "before", dir: "/b", runs: trickyRuns, rejected: [] },
    after: { label: "after", dir: "/a", runs: AFTER, rejected: [] },
    lever: "mapScale",
  });
  assert.equal(report.disclaimer, TUNING_REPORT_DISCLAIMER);
  const full = renderTuningReportText(report);
  assert.ok(full.includes("numbers and deltas only"));
  // Scan the BODY (everything except the disclaimer line, which legitimately names the
  // banned words to declare it makes no such judgment).
  const body = full
    .split("\n")
    .filter((l) => !l.includes(TUNING_REPORT_DISCLAIMER))
    .join("\n");
  const banned = /\b(better|worse|improved|regressed)\b/i;
  assert.ok(!banned.test(body), "report body must not judge");
});

test("loader: pairs summary+events, validates, and EXCLUDES rejected runs from aggregates", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "telemetry-runs-"));
  // A valid run.
  await fs.writeFile(path.join(dir, "run-1.summary.json"), JSON.stringify({ runId: "run-1", producedAt: "2026-07-04T00:00:01Z", persona: "greedy", bankedValue: 100, lostValue: 0 }));
  await fs.writeFile(path.join(dir, "run-1.events.jsonl"), [JSON.stringify({ type: "loot_complete", t: 10, tier: "rare", runId: "run-1" })].join("\n"));
  // An INVALID run (stale: missing producedAt) — must be rejected, not averaged.
  await fs.writeFile(path.join(dir, "run-2.summary.json"), JSON.stringify({ runId: "run-2", persona: "timid", bankedValue: 999, lostValue: 0 }));
  await fs.writeFile(path.join(dir, "run-2.events.jsonl"), "");
  // A summary with NO events file — rejected.
  await fs.writeFile(path.join(dir, "run-3.summary.json"), JSON.stringify({ runId: "run-3", producedAt: "2026-07-04T00:00:03Z", persona: "timid", bankedValue: 1, lostValue: 0 }));

  const set = await loadRunSet(dir, "before", SCHEMA);
  assert.equal(set.runs.length, 1);
  assert.equal(set.runs[0]!.runId, "run-1");
  assert.equal(set.rejected.length, 2);
  const rejectedIds = set.rejected.map((r) => r.runId).sort();
  assert.deepEqual(rejectedIds, ["run-2", "run-3"]);
  // The stale run 999 never reaches the aggregate.
  const agg = aggregateSet("before", dir, set.runs, set.rejected.length, SCHEMA);
  assert.equal(agg.metrics.find((m) => m.field === "bankedValue")!.mean, 100);
  await fs.rm(dir, { recursive: true, force: true });
});

test("loader (D1): duplicate runIds across a set REFUSE the whole load (never silently double-counted)", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "telemetry-dup-"));
  // Two different file stems, BOTH declaring runId "run-1" — both individually valid.
  for (const stem of ["run-a", "run-b"]) {
    await fs.writeFile(path.join(dir, `${stem}.summary.json`), JSON.stringify({ runId: "run-1", producedAt: "2026-07-04T00:00:01Z", persona: "greedy", bankedValue: 100, lostValue: 0 }));
    await fs.writeFile(path.join(dir, `${stem}.events.jsonl`), JSON.stringify({ type: "loot_complete", t: 10, tier: "rare", runId: "run-1" }));
  }
  await assert.rejects(
    () => loadRunSet(dir, "before", SCHEMA),
    (e: Error) => /duplicate runId\(s\) across the set: `run-1`/.test(e.message) && /refusing the whole set/.test(e.message),
  );
  await fs.rm(dir, { recursive: true, force: true });
});

test("loader: also accepts the run_*_events.jsonl (underscore) pairing", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "telemetry-runs-us-"));
  await fs.writeFile(path.join(dir, "run_7_summary.json"), JSON.stringify({ runId: "run-7", producedAt: "2026-07-04T00:00:07Z", persona: "reckless", bankedValue: 0, lostValue: 80 }));
  await fs.writeFile(path.join(dir, "run_7_events.jsonl"), JSON.stringify({ type: "loot_complete", t: 1, tier: "common", runId: "run-7" }));
  const set = await loadRunSet(dir, "before", SCHEMA);
  assert.equal(set.runs.length, 1);
  assert.equal(set.runs[0]!.runId, "run-7");
  await fs.rm(dir, { recursive: true, force: true });
});
