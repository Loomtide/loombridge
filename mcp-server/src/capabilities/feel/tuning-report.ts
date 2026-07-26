/**
 * `loombridge tuning-report` — the tuning analysis report verb (dogfood backlog High #6;
 * plan §9 "Tuning Needs Lever Isolation").
 *
 *   loombridge tuning-report --genre <id>|--schema <path> --runs <dir> [--out <p>] [--out-text <p>]
 *   loombridge tuning-report --genre <id>|--schema <path> --before <dir> --after <dir> \
 *       [--lever <name>] [--config-before <p> --config-after <p>] [--out <p>] [--out-text <p>]
 *
 * Reads one or two telemetry run-sets (summary JSON + event JSONL, validated against the
 * genre-pack schema), aggregates schema metrics (segmented by map/persona/route/outcome),
 * and — for two sets — emits a before/after delta table PLUS a lever-isolation warning.
 *
 * It states NUMBERS and DELTAS only; it never judges fun/quality (plan §8). Exit codes:
 *   0  report produced
 *   2  bad args / unreadable schema / unreadable run-set / no runs to aggregate
 * A lever-isolation warning does NOT change the exit code (it is advisory, plan §9).
 */

import fs from "node:fs/promises";
import path from "node:path";

import { telemetrySchemaPathForGenre, validateTelemetrySchema, type TelemetrySchema } from "../telemetry/schema.js";
import { loadRunSet } from "../telemetry/loader.js";
import { buildTuningReport, renderTuningReportText, stableStringify, type TelemetryRun } from "../telemetry/report.js";
import { personaContractPathForGenre, validatePersonaContract, type PersonaContract } from "../telemetry/personas.js";
import {
  buildPersonaCohortReport,
  buildPersonaCohortComparison,
  renderPersonaCohortReportText,
  renderPersonaCohortComparisonText,
  stablePersonaStringify,
} from "../telemetry/persona-report.js";

interface Args {
  genre?: string;
  schema?: string;
  runs?: string;
  before?: string;
  after?: string;
  lever?: string;
  configBefore?: string;
  configAfter?: string;
  out?: string;
  outText?: string;
  personas?: string;
  personasGenre?: string;
  personasOut?: string;
  personasOutText?: string;
  help?: boolean;
}

function parseArgs(argv: string[]): Args | { error: string } {
  const args: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[i + 1];
      if (v === undefined) throw new Error(`missing value for ${a}`);
      i += 1;
      return v;
    };
    try {
      switch (a) {
        case "--help": case "-h": args.help = true; break;
        case "--genre": args.genre = next(); break;
        case "--schema": args.schema = next(); break;
        case "--runs": args.runs = next(); break;
        case "--before": args.before = next(); break;
        case "--after": args.after = next(); break;
        case "--lever": args.lever = next(); break;
        case "--config-before": args.configBefore = next(); break;
        case "--config-after": args.configAfter = next(); break;
        case "--out": args.out = next(); break;
        case "--out-text": args.outText = next(); break;
        case "--personas": args.personas = next(); break;
        case "--personas-genre": args.personasGenre = next(); break;
        case "--personas-out": args.personasOut = next(); break;
        case "--personas-out-text": args.personasOutText = next(); break;
        default:
          return { error: `unknown argument \`${a}\`` };
      }
    } catch (e) {
      return { error: (e as Error).message };
    }
  }
  return args;
}

function usage(): string {
  return [
    "loombridge tuning-report — deterministic tuning analysis over telemetry run-sets",
    "",
    "  --genre <id>            resolve the pack telemetry schema (genre-packs/<id>/telemetry.json)",
    "  --schema <path>         OR an explicit telemetry.json schema path",
    "  --runs <dir>            single run-set to aggregate",
    "  --before <dir>          before run-set (with --after: emit a delta table)",
    "  --after <dir>           after run-set",
    "  --lever <name>          the single lever changed between before/after",
    "  --config-before <path>  flat key→value config JSON for the before set (lever isolation)",
    "  --config-after <path>   flat key→value config JSON for the after set",
    "  --out <path>            write the deterministic report JSON",
    "  --out-text <path>       write the human-readable markdown report",
    "  --personas <path>       ALSO emit a persona cohort report against this persona contract",
    "  --personas-genre <id>   OR resolve the pack persona contract (genre-packs/<id>/personas.json)",
    "  --personas-out <path>   write the deterministic persona cohort report JSON",
    "  --personas-out-text <p> write the human-readable persona cohort markdown",
    "",
    "States numbers and deltas only — humans judge fun (plan §8). The persona report grades",
    "each persona against its OWN declared envelope and flags drift/uncalibrated personas as",
    "caveats about the BOTS, never game-balance claims.",
  ].join("\n");
}

async function readPersonaContract(
  args: Args,
  schema: TelemetrySchema,
): Promise<{ contract: PersonaContract } | { error: string } | null> {
  let contractPath: string | null = null;
  if (args.personas) {
    contractPath = path.resolve(args.personas);
  } else if (args.personasGenre) {
    contractPath = personaContractPathForGenre(args.personasGenre);
    if (!contractPath) return { error: `invalid --personas-genre \`${args.personasGenre}\`` };
  } else {
    return null; // persona mode not requested
  }

  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readFile(contractPath, "utf8"));
  } catch (e) {
    return { error: `cannot read persona contract at ${contractPath}: ${(e as Error).message}` };
  }
  const parsed = validatePersonaContract(raw, schema);
  if (!parsed.ok || !parsed.contract) {
    return { error: `persona contract is malformed:\n  - ${parsed.refusals.join("\n  - ")}` };
  }
  // Advisory validator warnings (e.g. a judgment word inside an intent statement) —
  // surfaced, never blocking.
  for (const w of parsed.warnings) {
    console.warn(`[loombridge tuning-report] persona contract warning: ${w}`);
  }
  return { contract: parsed.contract };
}

/**
 * Emit the persona cohort report(s). ONE labeled set per report — for a before/after
 * comparison each set is graded as its OWN cohort (never merged: grading a persona's
 * envelope over a mix of two game versions would conflate bot-drift with game-change)
 * plus a per-persona envelope-verdict comparison.
 */
async function emitPersonaReport(
  contract: PersonaContract,
  schema: TelemetrySchema,
  sets: Array<{ label: string; runs: TelemetryRun[] }>,
  args: Args,
): Promise<void> {
  const reports = sets.map((s) => buildPersonaCohortReport(contract, schema, s.runs, s.label));
  const texts = reports.map((r) => renderPersonaCohortReportText(r));

  let comparisonText: string | null = null;
  let jsonPayload: unknown;
  if (reports.length === 2) {
    const deltas = buildPersonaCohortComparison(reports[0], reports[1]);
    comparisonText = renderPersonaCohortComparisonText(reports[0], reports[1], deltas);
    jsonPayload = {
      schemaVersion: "1",
      kind: "persona-cohort-comparison",
      disclaimer: reports[0].disclaimer,
      before: reports[0],
      after: reports[1],
      comparison: deltas,
    };
  } else {
    jsonPayload = reports[0];
  }
  const fullText = texts.join("\n") + (comparisonText ? "\n" + comparisonText : "");

  if (args.personasOut) {
    const p = path.resolve(args.personasOut);
    await warnOnClobber(p);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, stablePersonaStringify(jsonPayload), "utf8");
  }
  if (args.personasOutText) {
    const p = path.resolve(args.personasOutText);
    await warnOnClobber(p);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, fullText + "\n", "utf8");
  }
  console.log("\n" + fullText);
  for (const report of reports) {
    for (const caveat of report.caveats) {
      console.warn(`[loombridge tuning-report] persona caveat [${report.cohortLabel}]: ${caveat}`);
    }
  }
}

async function readSchema(args: Args): Promise<{ schema: TelemetrySchema } | { error: string }> {
  let schemaPath: string | null = null;
  if (args.schema) {
    schemaPath = path.resolve(args.schema);
  } else if (args.genre) {
    schemaPath = telemetrySchemaPathForGenre(args.genre);
    if (!schemaPath) return { error: `invalid --genre \`${args.genre}\`` };
  } else {
    return { error: "one of --genre or --schema is required" };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readFile(schemaPath, "utf8"));
  } catch (e) {
    return { error: `cannot read telemetry schema at ${schemaPath}: ${(e as Error).message}` };
  }
  const parsed = validateTelemetrySchema(raw);
  if (!parsed.ok || !parsed.schema) {
    return { error: `telemetry schema is malformed:\n  - ${parsed.refusals.join("\n  - ")}` };
  }
  return { schema: parsed.schema };
}

async function readConfig(p: string | undefined): Promise<Record<string, unknown> | null> {
  if (!p) return null;
  const raw = JSON.parse(await fs.readFile(path.resolve(p), "utf8"));
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`config ${p} must be a flat JSON object`);
  }
  return raw as Record<string, unknown>;
}

export async function run(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    console.error(`[loombridge tuning-report] ${parsed.error}`);
    console.error(usage());
    return 2;
  }
  if (parsed.help) {
    console.log(usage());
    return 0;
  }

  // Input-set shape: exactly one of { --runs } or { --before + --after }.
  const single = Boolean(parsed.runs);
  const pair = Boolean(parsed.before) || Boolean(parsed.after);
  if (single && pair) {
    console.error("[loombridge tuning-report] use --runs (single set) OR --before/--after (comparison), not both");
    return 2;
  }
  if (!single && !pair) {
    console.error("[loombridge tuning-report] provide --runs <dir>, or --before <dir> --after <dir>");
    console.error(usage());
    return 2;
  }
  if (pair && !(parsed.before && parsed.after)) {
    console.error("[loombridge tuning-report] a comparison needs BOTH --before <dir> and --after <dir>");
    return 2;
  }

  const schemaResult = await readSchema(parsed);
  if ("error" in schemaResult) {
    console.error(`[loombridge tuning-report] ${schemaResult.error}`);
    return 2;
  }
  const { schema } = schemaResult;

  // Persona mode (optional, additive): resolve + validate the persona contract up front so
  // a malformed contract fails before any run-set work.
  const personaResult = await readPersonaContract(parsed, schema);
  if (personaResult && "error" in personaResult) {
    console.error(`[loombridge tuning-report] ${personaResult.error}`);
    return 2;
  }
  const personaContract = personaResult?.contract ?? null;

  let configBefore: Record<string, unknown> | null = null;
  let configAfter: Record<string, unknown> | null = null;
  try {
    configBefore = await readConfig(parsed.configBefore);
    configAfter = await readConfig(parsed.configAfter);
  } catch (e) {
    console.error(`[loombridge tuning-report] ${(e as Error).message}`);
    return 2;
  }

  try {
    if (single) {
      const set = await loadRunSet(parsed.runs!, "runs", schema);
      if (set.runs.length === 0) {
        console.error(`[loombridge tuning-report] no valid runs in ${parsed.runs} (${set.rejected.length} rejected)`);
        for (const r of set.rejected) console.error(`  - ${r.runId}: ${r.refusals.join("; ")}`);
        return 2;
      }
      const report = buildTuningReport({ schema, before: { label: "runs", dir: parsed.runs!, ...set } });
      await emit(report, parsed);
      if (personaContract) {
        await emitPersonaReport(personaContract, schema, [{ label: "runs", runs: set.runs }], parsed);
      }
      return 0;
    }

    const before = await loadRunSet(parsed.before!, "before", schema);
    const after = await loadRunSet(parsed.after!, "after", schema);
    if (before.runs.length === 0 || after.runs.length === 0) {
      console.error(`[loombridge tuning-report] both sets need at least one valid run (before=${before.runs.length}, after=${after.runs.length})`);
      for (const r of [...before.rejected, ...after.rejected]) console.error(`  - [${r.set}] ${r.runId}: ${r.refusals.join("; ")}`);
      return 2;
    }
    const report = buildTuningReport({
      schema,
      before: { label: "before", dir: parsed.before!, ...before },
      after: { label: "after", dir: parsed.after!, ...after },
      lever: parsed.lever,
      configBefore,
      configAfter,
    });
    await emit(report, parsed);
    if (personaContract) {
      // D2: each set is its OWN persona cohort — never grade a merged mix of two game
      // versions (that conflates bot-drift with game-change).
      await emitPersonaReport(
        personaContract,
        schema,
        [
          { label: "before", runs: before.runs },
          { label: "after", runs: after.runs },
        ],
        parsed,
      );
    }
    return 0;
  } catch (e) {
    console.error(`[loombridge tuning-report] ${(e as Error).message}`);
    return 2;
  }
}

/** Warn (never block) before overwriting an existing report file (D9). */
async function warnOnClobber(p: string): Promise<void> {
  try {
    await fs.access(p);
    console.warn(`[loombridge tuning-report] overwriting existing ${p}`);
  } catch {
    // Does not exist — nothing to warn about.
  }
}

async function emit(report: ReturnType<typeof buildTuningReport>, args: Args): Promise<void> {
  const text = renderTuningReportText(report);
  if (args.out) {
    const outPath = path.resolve(args.out);
    await warnOnClobber(outPath);
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, stableStringify(report), "utf8");
  }
  if (args.outText) {
    const outTextPath = path.resolve(args.outText);
    await warnOnClobber(outTextPath);
    await fs.mkdir(path.dirname(outTextPath), { recursive: true });
    await fs.writeFile(outTextPath, text + "\n", "utf8");
  }
  // Always print the human-readable report to stdout so the verb is useful without files.
  console.log(text);
  if (report.leverIsolation?.warning) {
    console.warn(`\n[loombridge tuning-report] ${report.leverIsolation.warning}`);
  }
}
