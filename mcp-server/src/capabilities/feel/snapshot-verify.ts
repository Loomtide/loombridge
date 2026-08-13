/**
 * `loombridge verify --snapshot` — the tuning-drift gate.
 *
 * Grades the game's CURRENT measured behavior against the approved feel
 * snapshot (`feel snapshot approve`). Three input modes:
 *  - default: live-capture using the snapshot's own FROZEN contract, so the
 *    contract binding is verified by construction;
 *  - `--capture-contract <p>`: live-capture with an explicit contract, hash-
 *    checked against the manifest (a mismatch REFUSES: apples to oranges);
 *  - `--measurements <p>`: offline grading of an existing measurements file;
 *    the binding cannot be proven and is stamped `unverified` (exit 1 under
 *    `--strict`), never silently.
 *
 * Exit contract (see `exitCodeForSnapshotDrift`): 0 clean, 1 drift or a
 * §0-rejected current value, 2 integrity/binding/capture-gap/harness.
 */

import fs from "node:fs/promises";
import path from "node:path";

import { nowIso } from "../../domain/state.js";
import { formatBuildStamp, resolveBuildStamp, type BuildStamp } from "../../shared/build-stamp.js";
import { ICON, tildify } from "../../shared/cli-ui.js";
import { feelPaths } from "./feel-workspace.js";
import { loadMeasurements, type FeelMeasurementsFile } from "./measurements.js";
import {
  SNAPSHOT_CONTRACT_FILE,
  FEEL_SNAPSHOT_MANIFEST,
  rederiveView,
  sha256,
  verifySnapshotIntegrity,
  widenedToleranceConsentLine,
  type FeelSnapshotManifest,
} from "./snapshot-manifest.js";
import {
  compareSnapshot,
  exitCodeForSnapshotDrift,
  type SnapshotCompareResult,
  type SnapshotContractBinding,
} from "./snapshot-compare.js";
import type { FeelCaptureLiveArgs } from "./live.js";

const TAG = "[loombridge verify]";

export interface SnapshotDriftReport {
  kind: "feel-snapshot-drift";
  schemaVersion: "1";
  producedAt: string;
  producedBy: BuildStamp;
  snapshot: {
    approvedAt: string;
    capturedAt: string;
    note?: string;
    manifestPath: string;
    /** sha256 of the manifest file bytes: the seam a future doneness binding consumes. */
    manifestSha256: string;
  };
  contractBinding: SnapshotContractBinding;
  integrity: { ok: boolean; failures: string[] };
  metrics: SnapshotCompareResult["metrics"];
  newMetrics: SnapshotCompareResult["newMetrics"];
  summary: SnapshotCompareResult["summary"];
  status: SnapshotCompareResult["status"];
  headline: string;
  nextAction: string;
}

export interface RunVerifySnapshotArgs {
  root: string;
  workspace: string;
  captureContractPath?: string;
  measurementsPath?: string;
  project?: string;
  sourceRoot?: string;
  strict: boolean;
  outputPath?: string;
  /** Test seam: injected bridge client factory for the live-capture path. */
  clientFactory?: FeelCaptureLiveArgs["clientFactory"];
}

function headlineFor(status: SnapshotCompareResult["status"], summary: SnapshotCompareResult["summary"], binding: SnapshotContractBinding, approvedAt: string): string {
  const bindingNote = binding === "unverified" ? " (contract binding unverified: offline measurements)" : "";
  if (status === "clean") {
    return `Feel matches the approved snapshot: ${summary.match}/${summary.total} metric(s) within tolerance${bindingNote}.`;
  }
  if (status === "drift") {
    const parts: string[] = [];
    if (summary.drift > 0) parts.push(`${summary.drift} drifted`);
    if (summary.rejected > 0) parts.push(`${summary.rejected} rejected by re-derivation`);
    return `Feel DRIFTED from the snapshot approved ${approvedAt}: ${parts.join(", ")} of ${summary.total}${bindingNote}.`;
  }
  return `Snapshot compare incomplete: ${summary.missing} baseline metric(s) unmeasured in the current capture (capture gap, not a pass)${bindingNote}.`;
}

function nextActionFor(report: Pick<SnapshotDriftReport, "status" | "metrics" | "snapshot" | "contractBinding">): string {
  if (report.status === "drift") {
    const drifted = report.metrics.filter((m) => m.status === "drift").map((m) => m.id);
    const rejected = report.metrics.filter((m) => m.status === "rejected").map((m) => m.id);
    const parts: string[] = [];
    if (drifted.length > 0) {
      parts.push(
        `${drifted.join(", ")} moved since ${report.snapshot.approvedAt}: if intentional, re-approve (\`loombridge feel snapshot capture\` then \`loombridge feel snapshot approve\`); else inspect physics/timestep/collider changes since then`,
      );
    }
    if (rejected.length > 0) {
      parts.push(`${rejected.join(", ")} failed re-derivation: re-capture honestly`);
    }
    return `${parts.join("; ")}.`;
  }
  if (report.status === "incomplete") {
    const missing = report.metrics.filter((m) => m.status === "missing").map((m) => m.id);
    return `Re-capture so ${missing.join(", ")} measure again (a gap is a harness/setup problem, never a pass).`;
  }
  if (report.contractBinding === "unverified") {
    return "Clean, but the contract binding is unverified: for a fully bound verdict re-run with live capture (drop --measurements): loombridge verify --snapshot";
  }
  return "Feel is locked. Nothing to change.";
}

function renderDriftReport(report: SnapshotDriftReport): void {
  console.error(`${TAG} ${report.headline}`);
  console.error(`${TAG} produced by ${formatBuildStamp(report.producedBy)}`);
  if (!report.integrity.ok) {
    console.error(`${TAG} snapshot INTEGRITY FAILED:`);
    for (const f of report.integrity.failures) console.error(`  REFUSE ${f}`);
  }
  for (const m of report.metrics) {
    const glyph =
      m.status === "match" ? "OK  " : m.status === "drift" ? "DRIFT" : m.status === "rejected" ? "REJ " : "GAP ";
    const conf = m.confidence ? `  [${m.confidence === "verified" ? "verified" : "unverified"}]` : "";
    console.error(`  ${glyph} ${m.detail}${conf}`);
  }
  if (report.newMetrics.length > 0) {
    console.error(`${TAG} newly measured (not in the baseline; informational):`);
    for (const n of report.newMetrics) console.error(`       ${n.id} = ${n.value} [${n.confidence}]`);
  }
  const s = report.summary;
  console.error(
    `${TAG} status=${report.status} | ${s.match} match, ${s.drift} drift, ${s.rejected} rejected, ${s.missing} missing (of ${s.total}) | binding=${report.contractBinding}`,
  );
  console.error(`${TAG} next: ${report.nextAction}`);
}

function renderDriftMarkdown(report: SnapshotDriftReport): string {
  const lines: string[] = [];
  lines.push(`# Feel snapshot drift: ${report.status.toUpperCase()}`);
  lines.push("");
  lines.push(report.headline);
  lines.push("");
  lines.push(`**Next:** ${report.nextAction}`);
  lines.push("");
  lines.push(`Snapshot approved ${report.snapshot.approvedAt}${report.snapshot.note ? ` ("${report.snapshot.note}")` : ""}; contract binding: ${report.contractBinding}.`);
  lines.push("");
  if (!report.integrity.ok) {
    lines.push("## Integrity failures");
    for (const f of report.integrity.failures) lines.push(`- ${f}`);
    lines.push("");
  }
  lines.push("| Metric | Baseline | Current | Delta | Tolerance | Status |");
  lines.push("| --- | ---: | ---: | ---: | ---: | --- |");
  for (const m of report.metrics) {
    lines.push(
      `| ${m.id} | ${m.baseline} | ${m.current ?? "(missing)"} | ${m.delta ?? ""} | ${m.tolerance.applied} | ${m.status.toUpperCase()} |`,
    );
  }
  if (report.newMetrics.length > 0) {
    lines.push("");
    lines.push("## Newly measured (informational)");
    for (const n of report.newMetrics) lines.push(`- ${n.id} = ${n.value} [${n.confidence}]`);
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

/** Strip current values whose coverage says they were not actually measured. */
function withCoverageRefusals(current: FeelMeasurementsFile, baselineIds: ReadonlySet<string>): FeelMeasurementsFile {
  if (!current.captureCoverage?.length) return current;
  const refused = new Set(
    current.captureCoverage.filter((c) => baselineIds.has(c.metric) && c.status !== "measured").map((c) => c.metric),
  );
  if (refused.size === 0) return current;
  const metrics = { ...current.metrics };
  for (const id of refused) delete metrics[id];
  return { ...current, metrics };
}

export async function runVerifySnapshot(args: RunVerifySnapshotArgs): Promise<number> {
  const paths = feelPaths(args.workspace);
  const currentDir = paths.snapshotCurrentDir;

  const integrity = await verifySnapshotIntegrity(currentDir);
  // A TAMPERED ANCHOR IS NOT AN ABSENT ONE, and the two need different words. Both exit 2, so no
  // gate moves here, but `loadSnapshotManifest` returns null for a manifest whose SHAPE is
  // refused (a `tolerancePolicy: []`, a half-stamped portable pair), and reporting that as "no
  // approved feel snapshot: nothing to grade" told an operator to create a snapshot that is
  // already on disk, and described a hand-edited anchor as an empty workspace. `snapshot status`
  // has drawn this distinction since `manifestRefused` existed; this surface had not.
  if (integrity.manifestRefused) {
    console.error(`${TAG} the approved feel snapshot at ${currentDir} is present but REFUSED:`);
    for (const f of integrity.failures) console.error(`${TAG}   - ${f}`);
    console.error(`${TAG} re-capture and re-approve to restore a trustworthy baseline: \`loombridge feel snapshot capture\`.`);
    return 2;
  }
  if (!integrity.manifest) {
    console.error(`${TAG} no approved feel snapshot at ${currentDir}: nothing to grade.`);
    console.error(`${TAG} create one: \`loombridge feel snapshot capture\` then \`loombridge feel snapshot approve\`.`);
    return 2;
  }
  const manifest: FeelSnapshotManifest = integrity.manifest;
  // THE CONSENT SENTENCE, at the surface that GRADES against the widened band (the trace
  // precedent: stated where it is chosen, and again everywhere it is used).
  const consentLine = widenedToleranceConsentLine(manifest.metrics, manifest.tolerancePolicy);
  if (consentLine) console.error(`${TAG} ${consentLine}`);
  const manifestPath = path.join(currentDir, FEEL_SNAPSHOT_MANIFEST);
  const manifestSha256 = sha256(await fs.readFile(manifestPath));

  // Resolve the contract binding + the current measurements.
  let contractBinding: SnapshotContractBinding;
  let current: FeelMeasurementsFile | null = null;
  let captureError: string | null = null;

  if (args.measurementsPath !== undefined) {
    contractBinding = "unverified";
    try {
      current = await loadMeasurements(args.measurementsPath);
    } catch (error) {
      console.error(`${TAG} unreadable --measurements: ${error instanceof Error ? error.message : String(error)}`);
      return 2;
    }
  } else {
    const contractPath = args.captureContractPath ?? path.join(currentDir, SNAPSHOT_CONTRACT_FILE);
    let contractBytes: Buffer;
    try {
      contractBytes = await fs.readFile(contractPath);
    } catch {
      console.error(`${TAG} no capture contract at ${contractPath}.`);
      return 2;
    }
    contractBinding = sha256(contractBytes) === manifest.captureContract.sha256 ? "verified" : "mismatch";
    if (contractBinding === "mismatch") {
      console.error(
        `${TAG} capture contract at ${contractPath} does not match the one the snapshot froze: ` +
          "the comparison would be apples to oranges. Re-approve the snapshot under the new contract.",
      );
      return 2;
    }
    if (integrity.ok) {
      const { runFeelCaptureLive } = await import("./live.js");
      const outputPath = paths.measurements;
      try {
        await runFeelCaptureLive({
          root: args.root,
          contractPath,
          outputPath,
          artifactsDir: paths.captureArtifacts,
          project: args.project,
          sourceRoot: args.sourceRoot,
          clientFactory: args.clientFactory,
        });
        current = await loadMeasurements(outputPath);
      } catch (error) {
        captureError = error instanceof Error ? error.message : String(error);
      }
    }
  }

  if (captureError !== null) {
    console.error(`${TAG} capture failed: ${captureError}`);
    return 2;
  }

  // With broken integrity there is nothing trustworthy to compare against:
  // still write a report artifact naming the refusals, then exit 2.
  const baselineIds = new Set(Object.keys(manifest.metrics));
  const effectiveCurrent = current ? withCoverageRefusals(current, baselineIds) : { metrics: {} };
  const view = rederiveView(effectiveCurrent);
  const compare = integrity.ok
    ? compareSnapshot(manifest, effectiveCurrent, view.distrusted, view.verified)
    : ({ metrics: [], newMetrics: [], summary: { total: 0, match: 0, drift: 0, rejected: 0, missing: 0 }, status: "incomplete" } satisfies SnapshotCompareResult);

  const headline = integrity.ok
    ? headlineFor(compare.status, compare.summary, contractBinding, manifest.approvedAt)
    : `Snapshot NOT trustworthy (${integrity.failures.length} integrity failure(s)): re-capture and re-approve.`;
  const report: SnapshotDriftReport = {
    kind: "feel-snapshot-drift",
    schemaVersion: "1",
    producedAt: nowIso(),
    producedBy: resolveBuildStamp(),
    snapshot: {
      approvedAt: manifest.approvedAt,
      capturedAt: manifest.capturedAt,
      ...(manifest.note !== undefined ? { note: manifest.note } : {}),
      manifestPath,
      manifestSha256,
    },
    contractBinding,
    integrity: { ok: integrity.ok, failures: integrity.failures },
    metrics: compare.metrics,
    newMetrics: compare.newMetrics,
    summary: compare.summary,
    status: compare.status,
    headline,
    nextAction: "",
  };
  report.nextAction = integrity.ok
    ? nextActionFor(report)
    : "Re-capture and re-approve the snapshot; a tampered or partial baseline can never grade drift.";

  const outputPath = args.outputPath ?? paths.driftReport;
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf-8");
  const ext = path.extname(outputPath);
  const mdPath = `${ext === ".json" ? outputPath.slice(0, -ext.length) : outputPath}.md`;
  await fs.writeFile(mdPath, renderDriftMarkdown(report), "utf-8");

  renderDriftReport(report);
  console.error(`${ICON.report} Report: ${tildify(mdPath)}; full detail in ${tildify(outputPath)}`);

  return exitCodeForSnapshotDrift(report, { strict: args.strict });
}
