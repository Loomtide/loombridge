/**
 * Developer-facing human report renderer for `verify --profile`.
 *
 * Turns the machine `ProfileVerifyReport` into a self-contained HTML report plus
 * a Markdown twin. The JSON remains the audit record; this layer only makes the
 * already-derived verdict readable without changing status, confidence, or exit
 * semantics.
 */

import type {
  MetricConfidence,
  ProfileMetricResult,
  ProfileMetricStatus,
  ProfileReachabilityResult,
  ProfileReportStatus,
  ProfileVerifyReport,
} from "./verify-profile.js";
import type { FeelMeasurementSource } from "../../../verification/gates/feel.js";
import { formatCaptureCoverageLine } from "../../feel-capture/report.js";
import { formatBuildStamp } from "../../build-stamp.js";

export interface FeelReportBanner {
  status: ProfileReportStatus;
  label: string;
  tone: "pass" | "fail" | "incomplete";
  line: string;
}

export function feelBannerFor(status: ProfileReportStatus): FeelReportBanner {
  if (status === "pass") {
    return {
      status,
      label: "PASS",
      tone: "pass",
      line: "The measured feel matches this profile.",
    };
  }
  if (status === "fail") {
    return {
      status,
      label: "FAIL",
      tone: "fail",
      line: "One or more measured feel checks failed.",
    };
  }
  return {
    status,
    label: "INCOMPLETE",
    tone: "incomplete",
    line: "The profile was not fully measured or certified.",
  };
}

function esc(value: unknown): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function mdEsc(value: unknown): string {
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/`/g, "\\`")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\r?\n/g, " ");
}

function fmt(value: number): string {
  return String(Number(value.toFixed(3)));
}

function measuredText(metric: ProfileMetricResult): string {
  return metric.measured === null ? "not measured" : `${fmt(metric.measured)}${metric.unit}`;
}

const STATUS_LABEL: Record<ProfileMetricStatus, string> = {
  pass: "PASS",
  fail: "FAIL",
  not_measured: "NOT MEASURED",
};

const CONFIDENCE_LABEL: Record<MetricConfidence, string> = {
  verified: "verified",
  reported: "reported",
  rejected: "rejected",
  unmeasured: "unmeasured",
};

function statusClass(status: ProfileMetricStatus): string {
  if (status === "pass") return "ok";
  if (status === "fail") return "bad";
  return "muted";
}

function confidenceClass(confidence: MetricConfidence): string {
  if (confidence === "verified") return "ok";
  if (confidence === "rejected") return "bad";
  if (confidence === "reported") return "warn";
  return "muted";
}

function sourceLine(report: ProfileVerifyReport): string {
  const path = report.measurementsSource.path ?? "no measurements file";
  const sources = report.measurementsSource.provenance?.sources ?? [];
  if (sources.length === 0) return path;
  return `${path} (${sources.length} provenance source(s))`;
}

function provenanceSourceLine(source: FeelMeasurementSource): string {
  const status = (source as { status?: string }).status;
  const metrics = source.measuredMetrics?.length ? ` metrics=${source.measuredMetrics.join(",")}` : "";
  const samples = typeof source.sampleCount === "number" ? ` samples=${source.sampleCount}` : "";
  const fps = typeof source.captureFps === "number" ? ` fps=${fmt(source.captureFps)}` : "";
  const at = source.measuredAt ? ` at=${source.measuredAt}` : "";
  const state = status ? ` status=${status}` : "";
  return `${source.source ?? "unknown source"}${state}${metrics}${samples}${fps}${at}`.trim();
}

function renderMetricRows(report: ProfileVerifyReport): string {
  return report.metrics
    .map((m) => {
      const fix =
        m.status === "fail"
          ? `<div class="metric-note">${m.whyItMatters ? `<b>Why:</b> ${esc(m.whyItMatters)} ` : ""}${
              m.confidence === "rejected"
                ? "<b>Fix:</b> Re-capture honestly; the reported value did not match raw samples."
                : m.suggestion
                  ? `<b>Fix:</b> ${esc(m.suggestion)}`
                  : ""
            }</div>`
          : "";
      return `<tr>
        <td><b>${esc(m.label)}</b><span>${esc(m.id)}</span></td>
        <td>${esc(measuredText(m))}</td>
        <td>${esc(`${m.target}${m.unit}`)} <span>${esc(m.bandLabel)}</span></td>
        <td><span class="pill ${statusClass(m.status)}">${STATUS_LABEL[m.status]}</span></td>
        <td><span class="pill ${confidenceClass(m.confidence)}">${CONFIDENCE_LABEL[m.confidence]}</span></td>
      </tr>${fix ? `<tr><td colspan="5">${fix}</td></tr>` : ""}`;
    })
    .join("\n");
}

function section(title: string, body: string, id: string): string {
  return `<section id="${esc(id)}"><h2>${esc(title)}</h2>${body}</section>`;
}

function renderCoverage(report: ProfileVerifyReport): string {
  if (report.captureCoverage.length === 0) {
    return `<p class="muted-text">No capture coverage entries were attached to this report.</p>`;
  }
  return `<ul>${report.captureCoverage.map((entry) => `<li>${esc(formatCaptureCoverageLine(entry))}</li>`).join("")}</ul>`;
}

function renderRederivation(report: ProfileVerifyReport): string {
  const sources = report.measurementsSource.provenance?.sources ?? [];
  const provenance =
    sources.length > 0
      ? `<h3>Provenance sources</h3><ul>${sources.map((source) => `<li>${esc(provenanceSourceLine(source))}</li>`).join("")}</ul>`
      : "";
  if (report.rederivation.length === 0) {
    return `${provenance}<p class="muted-text">No trajectory-backed re-derivation checks were attached.</p>`;
  }
  return `${provenance}<h3>Re-derivation checks</h3><ul>${report.rederivation
    .map((v) => `<li><span class="pill ${v.status === "pass" ? "ok" : v.status === "fail" ? "bad" : "muted"}">${esc(v.status.toUpperCase())}</span> <b>${esc(v.metric)}</b>: ${esc(v.detail)}</li>`)
    .join("")}</ul>`;
}

function renderAlsoMeasured(report: ProfileVerifyReport): string {
  if (report.alsoMeasured.length === 0) {
    return `<p class="muted-text">No unbanded metrics were reported.</p>`;
  }
  return `<ul>${report.alsoMeasured
    .map((m) => `<li><b>${esc(m.label)}</b> (${esc(m.id)}): ${esc(`${fmt(m.measured)}${m.unit}`)} <span class="pill ${confidenceClass(m.confidence)}">${esc(m.confidence)}</span> <span class="muted-text">informational, not graded</span></li>`)
    .join("")}</ul>`;
}

function renderMechanisms(report: ProfileVerifyReport): string {
  if (report.mechanisms.status === "not_applicable") {
    return `<p class="muted-text">This profile does not claim required or forbidden mechanisms.</p>`;
  }
  if (report.mechanisms.checks.length === 0) {
    return `<p class="muted-text">Mechanism status: ${esc(report.mechanisms.status)}.</p>`;
  }
  return `<ul>${report.mechanisms.checks
    .map((check) => {
      const status = check.result === "unprobed" ? "REFUSED" : check.ok ? "PASS" : "FAIL";
      const cls = check.result === "unprobed" ? "warn" : check.ok ? "ok" : "bad";
      return `<li><span class="pill ${cls}">${status}</span> ${esc(check.detail)}</li>`;
    })
    .join("")}</ul>`;
}

function reachabilityTitle(reach: ProfileReachabilityResult): string {
  if (reach.status === "not_run") return "Reachability not run";
  if (reach.status === "pass") return "Reachability passed";
  return "Reachability failed";
}

function renderReachability(reach: ProfileReachabilityResult): string {
  if (reach.status === "not_run") {
    return `<p class="muted-text">${esc(reach.reason ?? "No level layout supplied.")}</p>`;
  }
  const env = reach.envelope
    ? `<p class="muted-text">Envelope: jump apex ${esc(reach.envelope.jumpApex)}u, vertical margin ${esc(reach.envelope.vMargin)}u, horizontal reach ${esc(fmt(reach.envelope.hReach))}u.</p>`
    : "";
  return `${env}<ul>${reach.checks
    .map((check) => `<li><span class="pill ${check.status === "fail" ? "bad" : check.status === "warn" ? "warn" : "ok"}">${esc(check.status.toUpperCase())}</span> ${esc(check.detail)}</li>`)
    .join("")}</ul>`;
}

export function renderFeelReportMarkdown(report: ProfileVerifyReport): string {
  const banner = feelBannerFor(report.status);
  const lines: string[] = [];
  lines.push(`# ${mdEsc(report.profile.title)} - Feel report: ${banner.label}`);
  lines.push("");
  lines.push(banner.line);
  lines.push("");
  lines.push(`**Headline:** ${mdEsc(report.headline)}`);
  lines.push("");
  lines.push(`**Next:** ${mdEsc(report.nextAction)}`);
  lines.push("");
  lines.push(`**Profile:** ${mdEsc(report.profile.id)} - ${mdEsc(report.profile.summary)}`);
  if (report.profile.exemplars?.length) lines.push(`**Feels like:** ${mdEsc(report.profile.exemplars.join(", "))}`);
  lines.push(`**Measurements:** ${mdEsc(sourceLine(report))}`);
  lines.push(`**Produced by:** ${mdEsc(formatBuildStamp(report.producedBy))}`);
  lines.push("");
  lines.push("## Metrics");
  lines.push("");
  lines.push("| Metric | Measured | Target | Status | Confidence |");
  lines.push("| --- | ---: | ---: | --- | --- |");
  for (const m of report.metrics) {
    lines.push(`| ${mdEsc(`${m.label} (${m.id})`)} | ${mdEsc(measuredText(m))} | ${mdEsc(`${m.target}${m.unit} ${m.bandLabel}`)} | ${STATUS_LABEL[m.status]} | ${CONFIDENCE_LABEL[m.confidence]} |`);
    if (m.status === "fail") {
      if (m.whyItMatters) lines.push(`| ${mdEsc(`Why: ${m.whyItMatters}`)} |  |  |  |  |`);
      if (m.confidence === "rejected") lines.push("| Fix: re-capture honestly; the reported value did not match raw samples. |  |  |  |  |");
      else if (m.suggestion) lines.push(`| ${mdEsc(`Fix: ${m.suggestion}`)} |  |  |  |  |`);
    }
  }
  lines.push("");
  lines.push("## Capture Coverage");
  if (report.captureCoverage.length === 0) lines.push("- No capture coverage entries were attached.");
  else for (const entry of report.captureCoverage) lines.push(`- ${mdEsc(formatCaptureCoverageLine(entry))}`);
  lines.push("");
  lines.push("## Evidence Trust");
  const sources = report.measurementsSource.provenance?.sources ?? [];
  if (sources.length > 0) {
    lines.push("### Provenance Sources");
    for (const source of sources) lines.push(`- ${mdEsc(provenanceSourceLine(source))}`);
    lines.push("");
  }
  if (report.rederivation.length === 0) lines.push("- No trajectory-backed re-derivation checks were attached.");
  else {
    lines.push("### Re-derivation Checks");
    for (const v of report.rederivation) lines.push(`- ${v.status.toUpperCase()} ${mdEsc(v.metric)}: ${mdEsc(v.detail)}`);
  }
  lines.push("");
  lines.push("## Mechanisms");
  if (report.mechanisms.status === "not_applicable") lines.push("- This profile does not claim required or forbidden mechanisms.");
  else if (report.mechanisms.checks.length === 0) lines.push(`- Mechanism status: ${mdEsc(report.mechanisms.status)}.`);
  else {
    for (const check of report.mechanisms.checks) {
      const status = check.result === "unprobed" ? "REFUSED" : check.ok ? "PASS" : "FAIL";
      lines.push(`- ${status}: ${mdEsc(check.detail)}`);
    }
  }
  lines.push("");
  lines.push(`## ${mdEsc(reachabilityTitle(report.reachability))}`);
  if (report.reachability.status === "not_run") lines.push(`- ${mdEsc(report.reachability.reason ?? "No level layout supplied.")}`);
  else for (const check of report.reachability.checks) lines.push(`- ${check.status.toUpperCase()}: ${mdEsc(check.detail)}`);
  lines.push("");
  lines.push("## Also Measured");
  if (report.alsoMeasured.length === 0) lines.push("- No unbanded metrics were reported.");
  else for (const m of report.alsoMeasured) lines.push(`- ${mdEsc(m.label)} (${mdEsc(m.id)}): ${mdEsc(`${fmt(m.measured)}${m.unit}`)} [${m.confidence}] - informational, not graded.`);
  lines.push("");
  return `${lines.join("\n")}\n`;
}

export function renderFeelReportHtml(report: ProfileVerifyReport): string {
  const banner = feelBannerFor(report.status);
  const exemplars = report.profile.exemplars?.length
    ? `<p class="muted-text">Feels like: ${esc(report.profile.exemplars.join(", "))}</p>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(report.profile.title)} - Feel report</title>
  <style>
    :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #17202a; background: #f7f8fb; }
    body { margin: 0; }
    main { max-width: 1120px; margin: 0 auto; padding: 28px 20px 48px; }
    .topbar { display: flex; justify-content: space-between; align-items: center; gap: 16px; margin-bottom: 18px; color: #5d6878; font-size: 13px; }
    .hero { border: 1px solid #dde3ea; border-radius: 8px; background: #fff; padding: 24px; box-shadow: 0 1px 2px rgba(16, 24, 40, 0.05); }
    .hero.pass { border-top: 5px solid #198754; }
    .hero.fail { border-top: 5px solid #c93535; }
    .hero.incomplete { border-top: 5px solid #b7791f; }
    h1 { margin: 0 0 8px; font-size: 30px; line-height: 1.15; letter-spacing: 0; }
    h2 { margin: 0 0 14px; font-size: 18px; letter-spacing: 0; }
    section { margin-top: 18px; border: 1px solid #dde3ea; border-radius: 8px; background: #fff; padding: 18px; }
    table { width: 100%; border-collapse: collapse; font-size: 14px; }
    th { text-align: left; color: #5d6878; font-weight: 600; border-bottom: 1px solid #e7ecf2; padding: 10px 8px; }
    td { border-bottom: 1px solid #eef2f6; padding: 11px 8px; vertical-align: top; }
    td span { display: block; color: #697586; font-size: 12px; margin-top: 2px; }
    ul { margin: 0; padding-left: 20px; }
    li { margin: 8px 0; }
    .grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-top: 18px; }
    .stat { border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px; background: #fbfcfe; }
    .stat b { display: block; font-size: 22px; }
    .pill { display: inline-flex; align-items: center; border-radius: 999px; padding: 3px 8px; font-size: 12px; font-weight: 700; letter-spacing: 0; }
    .pill.ok { color: #11633d; background: #dff6ea; }
    .pill.bad { color: #8f1f1f; background: #fde2e2; }
    .pill.warn { color: #80520f; background: #fff1cc; }
    .pill.muted { color: #526070; background: #edf1f5; }
    .metric-note { color: #344054; background: #fbfcfe; border-left: 3px solid #c93535; padding: 10px 12px; }
    .muted-text { color: #667085; }
    .summary { display: grid; grid-template-columns: 1fr; gap: 8px; color: #344054; }
    @media (max-width: 760px) { main { padding: 18px 12px 36px; } .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } table { font-size: 13px; } th:nth-child(3), td:nth-child(3) { display: none; } }
  </style>
</head>
<body>
  <main>
    <div class="topbar"><strong>Loombridge Feel Verification</strong><span>${esc(report.producedAt)}</span></div>
    <div class="hero ${banner.tone}">
      <span class="pill ${banner.tone === "pass" ? "ok" : banner.tone === "fail" ? "bad" : "warn"}">${esc(banner.label)}</span>
      <h1>${esc(report.profile.title)}</h1>
      <div class="summary">
        <p><b>${esc(banner.line)}</b></p>
        <p>${esc(report.headline)}</p>
        <p><b>Next:</b> ${esc(report.nextAction)}</p>
      </div>
      <div class="grid">
        <div class="stat"><b>${esc(report.summary.pass)}</b><span>passed</span></div>
        <div class="stat"><b>${esc(report.summary.fail)}</b><span>failed</span></div>
        <div class="stat"><b>${esc(report.summary.notMeasured)}</b><span>not measured</span></div>
        <div class="stat"><b>${esc(report.confidence.verified)}</b><span>verified</span></div>
      </div>
    </div>

    ${section("Profile", `<p>${esc(report.profile.id)} - ${esc(report.profile.summary)}</p>${exemplars}<p class="muted-text">Measurements: ${esc(sourceLine(report))}</p><p class="muted-text">Produced by ${esc(formatBuildStamp(report.producedBy))}</p>`, "profile")}
    ${section("Metrics", `<table><thead><tr><th>Metric</th><th>Measured</th><th>Target</th><th>Status</th><th>Confidence</th></tr></thead><tbody>${renderMetricRows(report)}</tbody></table>`, "metrics")}
    ${section("Capture Coverage", renderCoverage(report), "capture-coverage")}
    ${section("Evidence Trust", renderRederivation(report), "evidence-trust")}
    ${section("Mechanisms", renderMechanisms(report), "mechanisms")}
    ${section(reachabilityTitle(report.reachability), renderReachability(report.reachability), "reachability")}
    ${section("Also Measured", renderAlsoMeasured(report), "also-measured")}
  </main>
</body>
</html>`;
}
