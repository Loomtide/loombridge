import assert from "node:assert/strict";
import test from "node:test";

import {
  feelBannerFor,
  renderFeelReportHtml,
  renderFeelReportMarkdown,
} from "../loombridge/genre-packs/platformer-2d/feel-report-render.js";
import type { ProfileVerifyReport } from "../loombridge/genre-packs/platformer-2d/verify-profile.js";

function baseReport(over: Partial<ProfileVerifyReport> = {}): ProfileVerifyReport {
  return {
    kind: "feel-profile",
    schemaVersion: "1",
    producedAt: "2026-06-20T00:00:00.000Z",
    producedBy: {
      tool: "loombridge",
      version: "0.1.0",
      commit: "abc123",
      builtAt: "2026-06-20T00:00:00.000Z",
      stampStatus: "stamped",
    },
    profile: {
      id: "precision",
      title: "Precision Platformer",
      summary: "Tight, low-latency, responsive control.",
      exemplars: ["Celeste", "Super Meat Boy"],
    },
    engine: { engine: "unity" },
    measurementsSource: {
      path: "/tmp/profile-measurements.json",
      provenance: {
        sources: [
          {
            source: "runtime.capture_input_motion",
            sampleCount: 42,
            captureFps: 120,
            measuredMetrics: ["jumpApex"],
            measuredAt: "2026-06-20T00:00:00.000Z",
          },
        ],
      },
    },
    captureCoverage: [
      { metric: "jumpApex", status: "measured", interactionId: "jump-key" },
      { metric: "shortHopApex", status: "attempted-blocked", interactionId: "short-hop", reason: "settle timeout" },
      { metric: "coyoteTime", status: "unsupported", reason: "semantic anchor missing" },
    ],
    metrics: [
      {
        id: "jumpApex",
        label: "Jump apex",
        family: "jump",
        target: 3,
        unit: "u",
        bandLabel: "+/-12%",
        measured: 2.1,
        status: "fail",
        confidence: "verified",
        detail: "Jump apex failed.",
        whyItMatters: "A low apex makes gaps unreachable.",
        suggestion: "Increase jumpSpeed or reduce gravityScale.",
      },
      {
        id: "timeToApex",
        label: "Time to apex",
        family: "jump",
        target: 310,
        unit: "ms",
        bandLabel: "+/-15%",
        measured: 315,
        status: "pass",
        confidence: "reported",
        detail: "Time to apex passed.",
      },
      {
        id: "shortHopApex",
        label: "Short-hop apex",
        family: "jump",
        target: 1.2,
        unit: "u",
        bandLabel: "+/-15%",
        measured: null,
        status: "not_measured",
        confidence: "unmeasured",
        detail: "Short-hop apex not measured.",
      },
    ],
    rederivation: [
      { metric: "jumpApex", reported: 2.1, rederived: 2.1, status: "pass", detail: "matched raw trajectory" },
    ],
    alsoMeasured: [
      {
        id: "inputLatency",
        label: "Input latency",
        family: "run",
        measured: 42,
        unit: "ms",
        confidence: "verified",
        whyItMatters: "Late response feels sluggish.",
      },
    ],
    mechanisms: {
      status: "refused",
      checks: [
        {
          id: "airDash",
          expectation: "requires",
          result: "unprobed",
          ok: false,
          detail: "airDash could not be probed from the captured trajectory",
        },
      ],
    },
    reachability: {
      status: "not_run",
      reason: "no level layout supplied",
      checks: [],
    },
    summary: { total: 3, pass: 1, fail: 1, notMeasured: 1 },
    confidence: { verified: 1, reported: 1, rejected: 0, unmeasured: 1 },
    status: "fail",
    headline: "1 of 3 Precision Platformer metric(s) failed.",
    nextAction: "Fix jumpApex, then re-measure.",
    ...over,
  };
}

test("feelBannerFor maps profile statuses to stable human labels", () => {
  assert.deepEqual({ label: feelBannerFor("pass").label, tone: feelBannerFor("pass").tone }, { label: "PASS", tone: "pass" });
  assert.deepEqual({ label: feelBannerFor("fail").label, tone: feelBannerFor("fail").tone }, { label: "FAIL", tone: "fail" });
  assert.deepEqual({ label: feelBannerFor("incomplete").label, tone: feelBannerFor("incomplete").tone }, { label: "INCOMPLETE", tone: "incomplete" });
});

test("HTML report renders verdict, metric fixes, coverage, trust, mechanisms, reachability, and unbanded metrics", () => {
  const html = renderFeelReportHtml(baseReport());

  assert.match(html, /^<!doctype html>/);
  assert.match(html, /Loombridge Feel Verification/);
  assert.match(html, /Precision Platformer/);
  assert.match(html, /Fix jumpApex, then re-measure/);
  assert.match(html, /Jump apex/);
  assert.match(html, /Increase jumpSpeed or reduce gravityScale/);
  assert.match(html, /shortHopApex: attempted-blocked via short-hop/);
  assert.match(html, /runtime\.capture_input_motion metrics=jumpApex samples=42 fps=120/);
  assert.match(html, /jumpApex<\/b>: matched raw trajectory/);
  assert.match(html, /airDash could not be probed/);
  assert.match(html, /Reachability not run/);
  assert.match(html, /Input latency/);
  assert.match(html, /informational, not graded/);
});

test("Markdown report is PR-friendly and keeps capture gaps separate from metric failures", () => {
  const md = renderFeelReportMarkdown(baseReport());

  assert.match(md, /^# Precision Platformer - Feel report: FAIL/);
  assert.match(md, /\| Jump apex \(jumpApex\) \| 2.1u \| 3u \+\/-12% \| FAIL \| verified \|/);
  assert.match(md, /Fix: Increase jumpSpeed or reduce gravityScale/);
  assert.match(md, /shortHopApex: attempted-blocked via short-hop/);
  assert.match(md, /coyoteTime: unsupported/);
  assert.match(md, /runtime\.capture_input_motion metrics=jumpApex samples=42 fps=120/);
  assert.match(md, /PASS jumpApex: matched raw trajectory/);
  assert.match(md, /REFUSED: airDash could not be probed/);
  assert.match(md, /Reachability not run/);
  assert.match(md, /Input latency \(inputLatency\): 42ms \[verified\] - informational, not graded/);
});

test("Markdown report escapes external text from measurements and coverage", () => {
  const report = baseReport({
    headline: "bad <script>alert(1)</script>",
    nextAction: "run `rm -rf` | no",
    profile: {
      id: "precision",
      title: "Precision <Profile>",
      summary: "summary with <b>html</b> | table",
      exemplars: ["Game <One>"],
    },
    captureCoverage: [
      {
        metric: "jump|Apex",
        status: "attempted-blocked",
        interactionId: "jump`key`",
        reason: "bad <img src=x> | reason\nsecond line",
      },
    ],
    rederivation: [
      { metric: "jump<Apex>", reported: 2, rederived: null, status: "fail", detail: "raw <svg> mismatch | detail" },
    ],
    mechanisms: {
      status: "refused",
      checks: [
        {
          id: "airDash",
          expectation: "requires",
          result: "unprobed",
          ok: false,
          detail: "mechanism <script> | detail",
        },
      ],
    },
    reachability: { status: "not_run", reason: "layout <missing> | nope", checks: [] },
  });

  const md = renderFeelReportMarkdown(report);
  assert.doesNotMatch(md, /<script>/);
  assert.doesNotMatch(md, /<img/);
  assert.doesNotMatch(md, /<svg>/);
  assert.match(md, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(md, /run \\`rm -rf\\` \\| no/);
  assert.match(md, /jump\\|Apex: attempted-blocked via jump\\`key\\`/);
  assert.match(md, /bad &lt;img src=x&gt; \\| reason second line/);
  assert.match(md, /mechanism &lt;script&gt; \\| detail/);
  assert.match(md, /layout &lt;missing&gt; \\| nope/);
});
