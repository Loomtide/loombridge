/**
 * Replay Verification — fleet roll-up HTML renderer.
 *
 * `renderFleetReportHtml(report)` is a PURE function producing a self-contained
 * HTML index over a fleet run: a counts header + one row per trace (status,
 * visual drift, first divergence, duration) linking to that trace's own report.
 * Escaping and the status-class whitelist are reused from `report-html` so the
 * same XSS trust boundary holds (a fleet report is assembled from per-trace
 * data that may be hand-edited on disk).
 */

import type { FleetReport } from "./fleet.js";
import { esc, statusClass } from "./report-html.js";

/** A link target is safe only if it is a non-empty relative path with no URL scheme. */
function isSafeRelativeLink(target: string): boolean {
  return target.length > 0 && !/^[a-z][a-z0-9+.-]*:/i.test(target) && !target.startsWith("//");
}

export function renderFleetReportHtml(report: FleetReport): string {
  const c = report.counts;
  const rows = report.traces
    .map((t) => {
      const blocked = t.blockedReason ? ` (${esc(t.blockedReason)})` : "";
      const drift = t.visualDrift
        ? `<span class="vstatus vstatus-drift">drift</span>`
        : "—";
      // Prefer the error (the trace never ran) over a divergence summary.
      const detail = t.error
        ? `<span class="err">${esc(t.error)}</span>`
        : t.firstDivergence
          ? `<code>${esc(t.firstDivergence.kind)}</code> @ <code>${esc(String(t.firstDivergence.segment))}</code>`
          : "—";
      const id = `<code>${esc(t.id)}</code>`;
      // Only link when `report` is a safe relative path — never an absolute/scheme
      // URL (a hand-edited fleet.report.json must not yield a `javascript:` link).
      const linked = isSafeRelativeLink(t.report) ? `<a href="${esc(t.report)}">${id}</a>` : id;
      return `<tr>
        <td>${linked}</td>
        <td class="${statusClass(t.status)}">${esc(t.status)}${blocked}</td>
        <td>${drift}</td>
        <td>${detail}</td>
        <td>${t.durationMs} ms</td>
      </tr>`;
    })
    .join("");

  const color = report.status === "fail" ? "#cf222e" : report.status === "blocked" ? "#9a6700" : "#1a7f37";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Replay fleet report</title>
<style>
  :root { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #1f2328; }
  body { margin: 0 auto; max-width: 980px; padding: 24px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .badge { display: inline-block; color: #fff; padding: 2px 10px; border-radius: 12px; font-weight: 600; font-size: 13px; background: ${color}; }
  .meta { color: #57606a; font-size: 13px; margin: 8px 0 20px; }
  table { border-collapse: collapse; width: 100%; font-size: 14px; }
  th, td { text-align: left; padding: 8px; border-bottom: 1px solid #eaeef2; }
  th { color: #57606a; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
  code { background: #f6f8fa; padding: 1px 5px; border-radius: 4px; font-size: 12px; }
  a { color: #0969da; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .status-pass { color: #1a7f37; font-weight: 600; }
  .status-fail, .status-not_reached { color: #cf222e; font-weight: 600; }
  .status-blocked { color: #9a6700; font-weight: 600; }
  .status-unknown { color: #57606a; font-weight: 600; }
  .vstatus { font-weight: 600; padding: 1px 6px; border-radius: 10px; font-size: 11px; }
  .vstatus-drift { color: #cf222e; background: #fff5f5; }
  .err { color: #cf222e; font-size: 12px; }
</style>
</head>
<body>
  <h1>Replay fleet <span class="badge">${esc(report.status.toUpperCase())}</span></h1>
  <div class="meta">
    ${c.total} traces · ${c.pass} pass · ${c.fail} fail · ${c.blocked} blocked · ${c.drift} drift ·
    ${esc(report.generatedAt)}
  </div>
  <table>
    <thead><tr><th>trace</th><th>status</th><th>visual</th><th>first divergence</th><th>duration</th></tr></thead>
    <tbody>${rows || `<tr><td colspan="5">— no traces —</td></tr>`}</tbody>
  </table>
</body>
</html>
`;
}
