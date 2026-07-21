/**
 * Tier-1 verdict aggregator (§3.5).
 *
 * Rolls a set of per-gate `GateReport`s into the `build-verdict.json` shape:
 *   { status, gates:{gateName: verdict}, checks:[...all...], failures:[...], warnings:[...] }
 *
 * Verdict policy (Tier-1 is the build gate): any gate `fail` ⇒ overall `fail`;
 * else any gate `warn` ⇒ overall `warn`; else `pass`.
 */

import {
  worstStatus,
  type BuildVerdict,
  type GateCheck,
  type GateReport,
} from "./types.js";

export function aggregateVerdict(reports: GateReport[]): BuildVerdict {
  const gates: Record<string, GateReport["verdict"]> = {};
  const checks: GateCheck[] = [];

  for (const report of reports) {
    gates[report.gate] = report.verdict;
    for (const c of report.checks) checks.push(c);
  }

  const status = worstStatus(reports.map((r) => r.verdict));
  const failures = checks.filter((c) => c.status === "fail");
  const warnings = checks.filter((c) => c.status === "warn");

  return { status, gates, checks, failures, warnings };
}
