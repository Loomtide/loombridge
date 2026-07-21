/**
 * Telemetry run-set loader — reads a directory of runs (summary JSON + event JSONL),
 * parses + validates each against the schema, and splits them into accepted runs and
 * rejected runs (with refusals). Deterministic: accepted runs are sorted by run id.
 *
 * File-pairing convention (a run's two files share a STEM):
 *   <stem>.summary.json  +  <stem>.events.jsonl      (canonical)
 *   <stem>_summary.json  +  <stem>_events.jsonl      (also accepted — the dogfood project's `run_*` shape)
 *
 * A summary file with no matching events file (or vice-versa) is a rejected run, not a
 * silent drop — an incomplete run must never be averaged into a tuning aggregate.
 */

import fs from "node:fs/promises";
import path from "node:path";

import type { TelemetrySchema } from "./schema.js";
import { validateTelemetryRun } from "./validate.js";
import type { RejectedRun, TelemetryRun } from "./report.js";

export interface LoadedRunSet {
  runs: TelemetryRun[];
  rejected: RejectedRun[];
}

/** Strip a summary-file suffix to the shared stem, or null if not a summary file. */
function summaryStem(fileName: string): string | null {
  if (fileName.endsWith(".summary.json")) return fileName.slice(0, -".summary.json".length);
  if (fileName.endsWith("_summary.json")) return fileName.slice(0, -"_summary.json".length);
  return null;
}

/** The two candidate events filenames for a stem, canonical first. */
function eventsCandidates(stem: string): string[] {
  return [`${stem}.events.jsonl`, `${stem}_events.jsonl`];
}

/** Parse a JSONL string into an array of objects, or throw on the first bad line. */
function parseJsonl(text: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (e) {
      throw new Error(`events line ${i + 1}: invalid JSON (${(e as Error).message})`);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`events line ${i + 1}: not a JSON object`);
    }
    out.push(parsed as Record<string, unknown>);
  });
  return out;
}

/**
 * Load + validate every run in `dir` against `schema`. `setLabel` tags rejected runs.
 * Throws when the directory itself cannot be read, AND when two ACCEPTED runs declare
 * the same runId (D1): a duplicated run id means the set is corrupt — the same run
 * would be averaged twice into every aggregate — so the WHOLE set is refused with the
 * colliding id(s) named, never silently deduped (which duplicate is "the" run is not
 * ours to guess). Individually bad runs become rejected entries.
 */
export async function loadRunSet(
  dir: string,
  setLabel: string,
  schema: TelemetrySchema,
): Promise<LoadedRunSet> {
  const entries = await fs.readdir(dir);
  const stems = entries
    .map(summaryStem)
    .filter((s): s is string => s !== null)
    .sort();

  const runs: TelemetryRun[] = [];
  const rejected: RejectedRun[] = [];

  for (const stem of stems) {
    // Resolve the summary file's actual name (either suffix form).
    const summaryName = entries.find((f) => summaryStem(f) === stem)!;
    const eventsName = eventsCandidates(stem).find((c) => entries.includes(c)) ?? null;

    if (!eventsName) {
      rejected.push({ set: setLabel, runId: stem, refusals: [`no events file for summary \`${summaryName}\` (expected ${eventsCandidates(stem).join(" or ")})`] });
      continue;
    }

    let summary: unknown;
    try {
      summary = JSON.parse(await fs.readFile(path.join(dir, summaryName), "utf8"));
    } catch (e) {
      rejected.push({ set: setLabel, runId: stem, refusals: [`summary parse error: ${(e as Error).message}`] });
      continue;
    }

    let events: Array<Record<string, unknown>>;
    try {
      events = parseJsonl(await fs.readFile(path.join(dir, eventsName), "utf8"));
    } catch (e) {
      rejected.push({ set: setLabel, runId: stem, refusals: [(e as Error).message] });
      continue;
    }

    const result = validateTelemetryRun(summary, events, schema);
    const runId = deriveRunId(summary, schema, stem);
    if (!result.ok) {
      rejected.push({ set: setLabel, runId, refusals: result.refusals });
      continue;
    }
    runs.push({ runId, summary: summary as Record<string, unknown>, events });
  }

  // D1: duplicate run ids across the set → REFUSE the whole load. Two summaries
  // declaring the same runId would both average into every aggregate (silent
  // double-count); a duplicated id means the set is corrupt, so refuse loudly with
  // the colliding id(s) named rather than dedupe by any arbitrary rule.
  const idCounts = new Map<string, number>();
  for (const r of runs) idCounts.set(r.runId, (idCounts.get(r.runId) ?? 0) + 1);
  const duplicates = [...idCounts.entries()]
    .filter(([, c]) => c > 1)
    .map(([id]) => id)
    .sort();
  if (duplicates.length > 0) {
    throw new Error(
      `run-set ${dir}: duplicate runId(s) across the set: ${duplicates.map((d) => `\`${d}\``).join(", ")} — each run must be counted exactly once; a duplicated run id means the set is corrupt (refusing the whole set, not silently deduping)`,
    );
  }

  runs.sort((a, b) => (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0));
  return { runs, rejected };
}

/** Run id from the schema's events-file binding field, falling back to the file stem. */
function deriveRunId(summary: unknown, schema: TelemetrySchema, stem: string): string {
  const bindingField = schema.runSummary.fields.find((f) => f.binding === "events-file");
  if (bindingField && summary && typeof summary === "object") {
    const v = (summary as Record<string, unknown>)[bindingField.name];
    if (typeof v === "string" && v.length > 0) return v;
    if (typeof v === "number") return String(v);
  }
  return stem;
}
