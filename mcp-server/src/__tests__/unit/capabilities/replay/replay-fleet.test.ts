import assert from "node:assert/strict";
import test from "node:test";

import {
  renderFleetReportHtml,
  summarizeFleet,
  type FleetTraceResult,
} from "../../../../capabilities/replay/index.js";

function result(over: Partial<FleetTraceResult> = {}): FleetTraceResult {
  return { id: "x", status: "pass", visualDrift: false, durationMs: 10, report: "reports/x.report.html", ...over };
}

test("summarizeFleet: all pass → pass with correct counts", () => {
  const report = summarizeFleet([result({ id: "a" }), result({ id: "b" })], "t");
  assert.equal(report.status, "pass");
  assert.deepEqual(report.counts, { total: 2, pass: 2, fail: 0, blocked: 0, drift: 0 });
});

test("summarizeFleet: a fail dominates a blocked", () => {
  const report = summarizeFleet([result({ status: "fail" }), result({ status: "blocked" })], "t");
  assert.equal(report.status, "fail");
  assert.equal(report.counts.fail, 1);
  assert.equal(report.counts.blocked, 1);
});

test("summarizeFleet: blocked is the worst when there is no fail", () => {
  const report = summarizeFleet([result({ status: "pass" }), result({ status: "blocked" })], "t");
  assert.equal(report.status, "blocked");
});

test("summarizeFleet: drift is counted but does not change overall status", () => {
  const report = summarizeFleet([result({ visualDrift: true })], "t");
  assert.equal(report.status, "pass");
  assert.equal(report.counts.drift, 1);
});

test("renderFleetReportHtml: a row per trace, with status, link, divergence and drift", () => {
  const report = summarizeFleet(
    [
      result({ id: "good", status: "pass", report: "reports/good.report.html" }),
      result({
        id: "bad",
        status: "fail",
        firstDivergence: { kind: "action-failed", segment: "start" },
        report: "reports/bad.report.html",
      }),
      result({ id: "drifty", status: "pass", visualDrift: true, report: "reports/drifty.report.html" }),
    ],
    "2026-06-06T10:00:00Z",
  );
  const html = renderFleetReportHtml(report);
  assert.match(html, /^<!DOCTYPE html>/);
  assert.match(html, /FAIL<\/span>/); // worst-status badge
  assert.match(html, /href="reports\/good\.report\.html"/);
  assert.match(html, /action-failed/);
  assert.match(html, /vstatus-drift">drift/);
  assert.match(html, /3 traces · 2 pass · 1 fail/);
});

test("renderFleetReportHtml: escapes trace ids (no injection)", () => {
  const report = summarizeFleet([result({ id: '<img src=x onerror=alert(1)>', report: "r" })], "t");
  const html = renderFleetReportHtml(report);
  assert.doesNotMatch(html, /<img src=x onerror/);
  assert.match(html, /&lt;img/);
});

test("renderFleetReportHtml: escapes a malicious report path in the href (attribute context)", () => {
  const report = summarizeFleet([result({ id: "x", report: '" onload=alert(1) x="' })], "t");
  const html = renderFleetReportHtml(report);
  assert.doesNotMatch(html, /"\s*onload=alert/, "a real quote must not break out of href");
  // the path is not scheme-y, so it links, but quotes are escaped:
  assert.match(html, /&quot; onload=alert\(1\) x=&quot;/);
});

test("renderFleetReportHtml: a javascript: report is NOT turned into a link", () => {
  const report = summarizeFleet([result({ id: "x", report: "javascript:alert(1)" })], "t");
  const html = renderFleetReportHtml(report);
  assert.doesNotMatch(html, /href="javascript:/);
});

test("renderFleetReportHtml: a non-whitelisted status uses status-unknown, escaped text", () => {
  const report = summarizeFleet(
    [result({ status: 'pass"><script>alert(1)</script>' as unknown as FleetTraceResult["status"] })],
    "t",
  );
  const html = renderFleetReportHtml(report);
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /class="status-unknown"/);
});

test("renderFleetReportHtml: an errored trace shows the (escaped) error, preferred over divergence", () => {
  const report = summarizeFleet(
    [result({ id: "boom", status: "fail", error: "Invalid replay trace: <bad>", report: "" })],
    "t",
  );
  const html = renderFleetReportHtml(report);
  assert.match(html, /class="err">Invalid replay trace: &lt;bad&gt;/);
});

test("renderFleetReportHtml: an empty fleet renders without crashing", () => {
  const html = renderFleetReportHtml(summarizeFleet([], "t"));
  assert.match(html, /no traces/);
});

// BX2: THE COUNTS AGREE WITH THE TIER. A trace whose actuation passed while its captures could
// not be compared exits 2 and rolls up as `blocked`, but it used to be COUNTED as a pass, so a
// fleet printed "2/2 pass" one line above its own BLOCKED verdict and a non-zero exit. `blocked`
// is this vocabulary's "no verdict was produced", which is exactly what an uncomparable capture
// leaves behind.
test("summarizeFleet: a harness fault counts under BLOCKED, never under pass", () => {
  const report = summarizeFleet(
    [result({ id: "clean" }), result({ id: "uncomparable", status: "pass", visualHarnessFault: true })],
    "t",
  );
  assert.equal(report.status, "blocked");
  assert.deepEqual(
    report.counts,
    { total: 2, pass: 1, fail: 0, blocked: 1, drift: 0 },
    "the run with no comparable frame is not one of the passes",
  );
});

test("summarizeFleet: a FAILING trace that also faulted stays counted once, as a fail", () => {
  // fail > blocked in this vocabulary, and a trace must land in exactly one bucket or the
  // counts stop summing to `total`.
  const report = summarizeFleet([result({ status: "fail", visualHarnessFault: true })], "t");
  assert.equal(report.status, "fail");
  assert.deepEqual(report.counts, { total: 1, pass: 0, fail: 1, blocked: 0, drift: 0 });
});

test("summarizeFleet: the buckets always sum to total (no double-counted trace)", () => {
  const report = summarizeFleet(
    [
      result({ id: "a" }),
      result({ id: "b", status: "blocked" }),
      result({ id: "c", status: "fail" }),
      result({ id: "d", status: "pass", visualHarnessFault: true }),
      result({ id: "e", status: "blocked", visualHarnessFault: true }),
    ],
    "t",
  );
  const { total, pass, fail, blocked } = report.counts;
  assert.equal(pass + fail + blocked, total, JSON.stringify(report.counts));
  assert.deepEqual(report.counts, { total: 5, pass: 1, fail: 1, blocked: 3, drift: 0 });
});
