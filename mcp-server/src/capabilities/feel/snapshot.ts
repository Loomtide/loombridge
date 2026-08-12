/**
 * `loombridge feel snapshot <capture|approve|status>` — the tuning-snapshot
 * lifecycle (a lockfile for game feel).
 *
 * capture  drive the reviewed capture contract through live Unity and stage a
 *          CANDIDATE bundle (measurements + frozen contract copy + cleanliness
 *          report). Staging only; nothing is approved.
 * approve  the human gate ("this feels right"). Recomputes candidate
 *          cleanliness from the raw files (never trusts the staged report) and
 *          REFUSES to freeze a non-clean candidate; only then writes the frozen
 *          `snapshots/current/` bundle the drift gate compares against.
 * status   read-only: integrity + summary of the approved snapshot.
 *
 * The drift gate itself is `loombridge verify --snapshot` (read-only grading
 * lives on the verify surface; the mutating approve lives here, mirroring the
 * `minigame baseline approve` precedent).
 */

import fs from "node:fs/promises";
import path from "node:path";

import { nowIso } from "../../domain/state.js";
import {
  WORKSPACE_ID_PATTERN,
  isInside,
  projectWorkspace,
  sanitizeWorkspaceId,
} from "../../domain/workspace-paths.js";
import { detectEngine } from "../verification/plan.js";
import { feelPaths } from "./feel-workspace.js";
import { loadMeasurements } from "./measurements.js";
import {
  DEFAULT_SNAPSHOT_TOLERANCES,
  SNAPSHOT_CONTRACT_FILE,
  SNAPSHOT_MEASUREMENTS_FILE,
  derivationsFromContract,
  rederiveView,
  verifySnapshotIntegrity,
  writeSnapshotBundle,
  type FeelSnapshotManifest,
  type FeelSnapshotTolerancePolicy,
} from "./snapshot-manifest.js";
import type { FeelCaptureLiveArgs } from "./live.js";

const TAG = "[loombridge feel]";

interface SnapshotCliArgs {
  sub: "capture" | "approve" | "status";
  root: string;
  workspace: string;
  contractPath?: string;
  project?: string;
  sourceRoot?: string;
  note?: string;
  tolerancesPath?: string;
  allowPartial: boolean;
}

function usage(): void {
  console.log(
    [
      "Usage: loombridge feel snapshot <capture|approve|status> [options]",
      "",
      "The tuning snapshot: freeze how the game MEASURABLY plays once a human",
      "approves it, then catch kinematic drift with `loombridge verify --snapshot`",
      "(the way `trace` catches pixel drift). Not related to `tuning-report`",
      "(telemetry run-set analysis).",
      "",
      "Subcommands:",
      "  capture   Drive the reviewed capture contract through live Unity and stage",
      "            a candidate bundle. Requires the editor running with the bridge.",
      "  approve   Freeze the candidate as the current snapshot. REFUSES a non-clean",
      "            candidate (rederivation failure, empty metrics, coverage gaps",
      "            without --allow-partial).",
      "  status    Read-only integrity + summary of the approved snapshot.",
      "",
      "Options:",
      "  --root <dir>            Project root (default: cwd)",
      "  --id <kebab>            Workspace id (default: sanitized basename of --root)",
      "  --workspace <dir>       Feel workspace (default: ~/.loombridge/projects/<id>)",
      "  --capture-contract <p>  Capture contract (capture; default: <workspace>/feel/capture-contract.json)",
      "  --project <name>        Unity editor/project routing for live capture",
      "  --source-root <dir>     Source root forwarded to the capture runner",
      "  --note <text>           Approve: the human 'this feels right' note",
      "  --tolerances <path>     Approve: JSON tolerance overrides, frozen into the manifest",
      "  --allow-partial         Approve: freeze the measured subset, recording coverage gaps",
      "",
      "Exit: 0 ok; 1 approve refused a graded-but-unclean candidate; 2 usage,",
      "missing candidate, capture/harness fault, or a tampered snapshot.",
    ].join("\n"),
  );
}

function parseSnapshotArgs(args: string[]): SnapshotCliArgs | { help: true; usageError?: boolean } {
  if (args[0] !== "snapshot") {
    if (args[0] === "--help" || args[0] === "-h" || args.length === 0) return { help: true };
    console.error(`${TAG} unknown subcommand "${args[0] ?? ""}". Known: snapshot.`);
    return { help: true, usageError: true };
  }
  const sub = args[1];
  if (sub !== "capture" && sub !== "approve" && sub !== "status") {
    if (sub === "--help" || sub === "-h" || sub === undefined) return { help: true };
    console.error(`${TAG} unknown snapshot subcommand "${sub}". Known: capture, approve, status.`);
    return { help: true, usageError: true };
  }

  let root = process.cwd();
  let id: string | undefined;
  let workspace: string | undefined;
  let contractPath: string | undefined;
  let project: string | undefined;
  let sourceRoot: string | undefined;
  let note: string | undefined;
  let tolerancesPath: string | undefined;
  let allowPartial = false;

  for (let i = 2; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--root") root = path.resolve(args[(i += 1)] ?? root);
    else if (arg === "--id") id = args[(i += 1)] ?? "";
    else if (arg === "--workspace") workspace = path.resolve(args[(i += 1)] ?? "");
    else if (arg === "--capture-contract") contractPath = path.resolve(args[(i += 1)] ?? "");
    else if (arg === "--project") project = args[(i += 1)] ?? "";
    else if (arg === "--source-root") sourceRoot = path.resolve(args[(i += 1)] ?? "");
    else if (arg === "--note") note = args[(i += 1)] ?? "";
    else if (arg === "--tolerances") tolerancesPath = path.resolve(args[(i += 1)] ?? "");
    else if (arg === "--allow-partial") allowPartial = true;
    else if (arg === "--help" || arg === "-h") return { help: true };
    else {
      console.error(`${TAG} unknown argument "${arg}".`);
      return { help: true, usageError: true };
    }
  }

  if (id !== undefined && !WORKSPACE_ID_PATTERN.test(id)) {
    console.error(`${TAG} --id must be lowercase kebab-case (letters, digits, hyphens; start with a letter).`);
    return { help: true, usageError: true };
  }
  let resolvedWorkspace: string;
  if (workspace !== undefined) {
    resolvedWorkspace = workspace;
  } else {
    const wsId = id ?? sanitizeWorkspaceId(path.basename(root));
    if (!wsId) {
      console.error(`${TAG} could not derive a workspace id from '${path.basename(root)}'; pass --id <kebab>.`);
      return { help: true, usageError: true };
    }
    resolvedWorkspace = projectWorkspace(wsId);
  }
  if (isInside(resolvedWorkspace, path.resolve(root))) {
    console.error(
      `${TAG} feel workspace ${resolvedWorkspace} is inside the project; pass --workspace <dir> outside it.`,
    );
    return { help: true, usageError: true };
  }

  return { sub, root, workspace: resolvedWorkspace, contractPath, project, sourceRoot, note, tolerancesPath, allowPartial };
}

/** Candidate cleanliness stamp written by capture. INFORMATIONAL: approve recomputes. */
interface CandidateReport {
  kind: "feel-snapshot-candidate";
  capturedAt: string;
  engine: { engine: string | null };
  rederivation: { pass: number; total: number };
  distrusted: Array<{ metric: string; reason: string }>;
  coverageGaps: Array<{ metric: string; status: string; reason?: string }>;
  warnings: string[];
}

export interface SnapshotCaptureOpts {
  /** Test seam: injected bridge client factory (mirrors runFeelCaptureLive's). */
  clientFactory?: FeelCaptureLiveArgs["clientFactory"];
}

export async function runSnapshotCapture(
  cli: Pick<SnapshotCliArgs, "root" | "workspace" | "contractPath" | "project" | "sourceRoot">,
  opts: SnapshotCaptureOpts = {},
): Promise<number> {
  const paths = feelPaths(cli.workspace);
  const contractPath = cli.contractPath ?? paths.captureContract;
  try {
    await fs.access(contractPath);
  } catch {
    console.error(
      `${TAG} no capture contract at ${contractPath}. Author one with ` +
        "`loombridge verify --profile <id> --setup-capture --player <path> ... --apply`, then re-run.",
    );
    return 2;
  }

  const candidateDir = paths.snapshotCandidateDir;
  await fs.rm(candidateDir, { recursive: true, force: true });
  await fs.mkdir(candidateDir, { recursive: true });
  const measurementsPath = path.join(candidateDir, SNAPSHOT_MEASUREMENTS_FILE);

  const { runFeelCaptureLive } = await import("./live.js");
  let warnings: string[] = [];
  try {
    const result = await runFeelCaptureLive({
      root: cli.root,
      contractPath,
      outputPath: measurementsPath,
      artifactsDir: paths.captureArtifacts,
      project: cli.project,
      sourceRoot: cli.sourceRoot,
      clientFactory: opts.clientFactory,
    });
    warnings = result.warnings;
  } catch (error) {
    console.error(`${TAG} capture failed: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }

  // Freeze a copy of the contract beside the measurements (the snapshot is bound
  // to HOW it was measured) and mirror measurements for `verify --profile` interop.
  await fs.copyFile(contractPath, path.join(candidateDir, SNAPSHOT_CONTRACT_FILE));
  await fs.mkdir(path.dirname(paths.measurements), { recursive: true });
  await fs.copyFile(measurementsPath, paths.measurements);

  const measurements = await loadMeasurements(measurementsPath);
  const view = rederiveView(measurements);
  const coverageGaps = (measurements.captureCoverage ?? []).filter((c) => c.status !== "measured");
  const report: CandidateReport = {
    kind: "feel-snapshot-candidate",
    capturedAt: nowIso(),
    engine: { engine: detectEngine(cli.root).engine },
    rederivation: { pass: view.pass, total: view.total },
    distrusted: [...view.distrusted].map(([metric, reason]) => ({ metric, reason })),
    coverageGaps: coverageGaps.map((c) => ({ metric: c.metric, status: c.status, reason: c.reason })),
    warnings,
  };
  await fs.writeFile(path.join(candidateDir, "candidate-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf-8");

  const metricCount = Object.keys(measurements.metrics).length;
  console.error(`${TAG} candidate staged: ${metricCount} metric(s), §0 ${view.pass}/${view.total} re-derived.`);
  for (const d of report.distrusted) console.error(`${TAG}   distrusted: ${d.metric}: ${d.reason}`);
  for (const g of report.coverageGaps) console.error(`${TAG}   coverage gap: ${g.metric} (${g.status})`);
  console.error(
    `${TAG} next: play the game; when it feels right, freeze with \`loombridge feel snapshot approve\`` +
      (report.distrusted.length > 0 ? " (approve will REFUSE until the distrusted metrics re-capture cleanly)" : ""),
  );
  return 0;
}

async function readTolerances(
  tolerancesPath: string,
  knownMetricIds: ReadonlySet<string>,
): Promise<FeelSnapshotTolerancePolicy | { error: string }> {
  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readFile(tolerancesPath, "utf-8"));
  } catch (error) {
    return { error: `unreadable --tolerances file: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { error: "--tolerances must be a JSON object" };
  }
  // Refuse-on-unknown, not silently-default: a fat-fingered schema (the live case: a flat
  // metric map without the "perMetric" wrapper) would otherwise parse to zero recognized
  // keys and FREEZE a lockfile with pure-default tolerances while the operator believes
  // their overrides are in force. Wrong tolerances in a frozen manifest are a wrong gate.
  const KNOWN_TOLERANCE_KEYS = new Set(["defaultRelPct", "defaultAbsFloorByDerivation", "perMetric"]);
  const unknownKeys = Object.keys(raw).filter((k) => !KNOWN_TOLERANCE_KEYS.has(k));
  if (unknownKeys.length > 0) {
    return {
      error:
        `--tolerances has unrecognized top-level key(s): ${unknownKeys.join(", ")}. ` +
        'Expected { defaultRelPct?, defaultAbsFloorByDerivation?, perMetric? }; per-metric ' +
        'overrides go under "perMetric", e.g. {"perMetric":{"jumpApex":{"abs":0.1}}}.',
    };
  }
  const doc = raw as {
    defaultRelPct?: unknown;
    defaultAbsFloorByDerivation?: unknown;
    perMetric?: Record<string, { relPct?: number; abs?: number }>;
  };
  const policy: FeelSnapshotTolerancePolicy = {
    defaultRelPct:
      typeof doc.defaultRelPct === "number" && doc.defaultRelPct > 0
        ? doc.defaultRelPct
        : DEFAULT_SNAPSHOT_TOLERANCES.defaultRelPct,
    defaultAbsFloorByDerivation: {
      ...DEFAULT_SNAPSHOT_TOLERANCES.defaultAbsFloorByDerivation,
      ...(typeof doc.defaultAbsFloorByDerivation === "object" && doc.defaultAbsFloorByDerivation !== null
        ? (doc.defaultAbsFloorByDerivation as Record<string, number>)
        : {}),
    },
  };
  if (doc.perMetric !== undefined) {
    if (typeof doc.perMetric !== "object" || doc.perMetric === null) {
      return { error: "--tolerances perMetric must be an object" };
    }
    for (const id of Object.keys(doc.perMetric)) {
      if (!knownMetricIds.has(id)) {
        return { error: `--tolerances overrides unknown metric '${id}' (not in the candidate measurements)` };
      }
    }
    policy.perMetric = doc.perMetric;
  }
  return policy;
}

async function runSnapshotApprove(cli: SnapshotCliArgs): Promise<number> {
  const paths = feelPaths(cli.workspace);
  const candidateDir = paths.snapshotCandidateDir;
  const measurementsPath = path.join(candidateDir, SNAPSHOT_MEASUREMENTS_FILE);
  const contractPath = path.join(candidateDir, SNAPSHOT_CONTRACT_FILE);

  let measurements;
  try {
    measurements = await loadMeasurements(measurementsPath);
  } catch {
    console.error(`${TAG} no snapshot candidate at ${candidateDir}. Run \`loombridge feel snapshot capture\` first.`);
    return 2;
  }
  let contractJson: unknown;
  try {
    contractJson = JSON.parse(await fs.readFile(contractPath, "utf-8"));
  } catch {
    console.error(`${TAG} candidate is missing its frozen capture contract; re-run \`loombridge feel snapshot capture\`.`);
    return 2;
  }

  // Recompute cleanliness from the raw files: the staged candidate-report is
  // informational and a hand-edited one must not be able to launder an approve.
  const view = rederiveView(measurements);
  const metricIds = Object.keys(measurements.metrics);
  const refusals: string[] = [];
  if (metricIds.length === 0) refusals.push("candidate has zero measured metrics; nothing to freeze");
  for (const [metric, reason] of view.distrusted) {
    refusals.push(`'${metric}' failed §0 re-derivation: ${reason}`);
  }
  const coverageGaps = (measurements.captureCoverage ?? []).filter((c) => c.status !== "measured");
  if (coverageGaps.length > 0 && !cli.allowPartial) {
    refusals.push(
      `coverage gaps on ${coverageGaps.map((c) => c.metric).join(", ")}; re-capture or pass --allow-partial to freeze the measured subset with the gaps recorded`,
    );
  }
  if (refusals.length > 0) {
    console.error(`${TAG} REFUSED to approve a non-clean candidate:`);
    for (const r of refusals) console.error(`${TAG}   - ${r}`);
    return 1;
  }

  let tolerancePolicy: FeelSnapshotTolerancePolicy = DEFAULT_SNAPSHOT_TOLERANCES;
  if (cli.tolerancesPath !== undefined) {
    const parsed = await readTolerances(cli.tolerancesPath, new Set(metricIds));
    if ("error" in parsed) {
      console.error(`${TAG} ${parsed.error}`);
      return 2;
    }
    tolerancePolicy = parsed;
  }

  const derivations = derivationsFromContract(contractJson);
  const metrics: FeelSnapshotManifest["metrics"] = {};
  for (const [id, value] of Object.entries(measurements.metrics)) {
    metrics[id] = {
      value,
      derivation: derivations.get(id),
      confidence: view.verified.has(id) ? "verified" : "reported",
    };
  }

  let capturedAt = nowIso();
  try {
    const staged = JSON.parse(await fs.readFile(path.join(candidateDir, "candidate-report.json"), "utf-8"));
    if (typeof staged?.capturedAt === "string") capturedAt = staged.capturedAt;
  } catch {
    // capturedAt falls back to approve time; the manifest stays honest either way.
  }

  const contract = contractJson as { game?: unknown; interactions?: unknown[]; metrics?: unknown[] };
  const manifest = await writeSnapshotBundle({
    candidateDir,
    currentDir: paths.snapshotCurrentDir,
    engine: { engine: detectEngine(cli.root).engine },
    capturedAt,
    approvedAt: nowIso(),
    note: cli.note,
    tolerancePolicy,
    metrics,
    coverageGaps: cli.allowPartial && coverageGaps.length > 0 ? coverageGaps : undefined,
    rederivation: { pass: view.pass, total: view.total },
    game: typeof contract.game === "string" ? contract.game : undefined,
    // Ownership stamp (A4): the PROJECT root this "feels right" was said about, NOT
    // the workspace, which is derived from the project basename and therefore shared
    // by any checkout with the same folder name.
    projectRoot: path.resolve(cli.root),
    contractStats: {
      interactions: Array.isArray(contract.interactions) ? contract.interactions.length : 0,
      metrics: Array.isArray(contract.metrics) ? contract.metrics.length : 0,
    },
  });

  const verifiedCount = Object.values(manifest.metrics).filter((m) => m.confidence === "verified").length;
  console.error(
    `${TAG} snapshot APPROVED: ${Object.keys(manifest.metrics).length} metric(s) frozen (${verifiedCount} verified)` +
      (cli.note ? ` with note "${cli.note}"` : ""),
  );
  console.error(`${TAG} drift gate: \`loombridge verify --snapshot --workspace ${cli.workspace}\``);
  return 0;
}

async function runSnapshotStatus(cli: SnapshotCliArgs): Promise<number> {
  const paths = feelPaths(cli.workspace);
  const currentDir = paths.snapshotCurrentDir;
  const integrity = await verifySnapshotIntegrity(currentDir);
  // A manifest that EXISTS and cannot be read is not "none approved": saying so would tell
  // an operator to approve a snapshot that is already there and already ungradeable.
  if (integrity.manifestRefused) {
    console.error(`${TAG} snapshot NOT READY (the manifest is present but REFUSED):`);
    for (const f of integrity.failures) console.error(`${TAG}   - ${f}`);
    console.error(`${TAG} re-capture and re-approve to restore a trustworthy baseline.`);
    return 2;
  }
  if (!integrity.manifest) {
    console.error(`${TAG} no approved snapshot at ${currentDir}.`);
    console.error(`${TAG} create one: \`loombridge feel snapshot capture\` then \`loombridge feel snapshot approve\`.`);
    return 0;
  }
  if (!integrity.ok) {
    console.error(`${TAG} snapshot NOT READY (tampered or partial):`);
    for (const f of integrity.failures) console.error(`${TAG}   - ${f}`);
    console.error(`${TAG} re-capture and re-approve to restore a trustworthy baseline.`);
    return 2;
  }
  const m = integrity.manifest;
  const verifiedCount = Object.values(m.metrics).filter((e) => e.confidence === "verified").length;
  console.error(`${TAG} snapshot ok: ${Object.keys(m.metrics).length} metric(s), ${verifiedCount} verified.`);
  console.error(`${TAG}   approved ${m.approvedAt}${m.note ? ` with note "${m.note}"` : ""}`);
  if (m.coverageGaps?.length) {
    console.error(`${TAG}   partial: gaps recorded on ${m.coverageGaps.map((c) => c.metric).join(", ")}`);
  }
  return 0;
}

export async function run(args: string[], opts: SnapshotCaptureOpts = {}): Promise<number> {
  const parsed = parseSnapshotArgs(args);
  if ("help" in parsed) {
    usage();
    return parsed.usageError ? 2 : 0;
  }
  if (parsed.sub === "capture") return runSnapshotCapture(parsed, opts);
  if (parsed.sub === "approve") return runSnapshotApprove(parsed);
  return runSnapshotStatus(parsed);
}
