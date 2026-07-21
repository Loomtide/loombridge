import assert from "node:assert/strict";
import test from "node:test";

import {
  renderReplayReportHtml,
  type CaptureImage,
  type ReplayRunArtifact,
} from "../loombridge/replay/index.js";

function artifact(overrides: Partial<ReplayRunArtifact> = {}): ReplayRunArtifact {
  return {
    traceId: "count-the-fruits-start",
    status: "pass",
    resetTier: "scene-load",
    segments: [
      {
        id: "start-to-question",
        status: "pass",
        anchorsReached: ["question-shown"],
        captures: [{ id: "question", artifact: "/abs/question.png", sha256: "abc" }],
      },
    ],
    assertions: [],
    console: { status: "pass", errorCount: 0, errors: [] },
    startedAt: "2026-06-06T10:00:00.000Z",
    finishedAt: "2026-06-06T10:00:02.500Z",
    durationMs: 2500,
    ...overrides,
  };
}

test("renderReplayReportHtml: self-contained pass report inlines the capture", () => {
  const captures: CaptureImage[] = [
    { id: "question", segment: "start-to-question", base64: "aGVsbG8=" },
  ];
  const html = renderReplayReportHtml(artifact(), captures);

  assert.match(html, /^<!DOCTYPE html>/);
  assert.match(html, /count-the-fruits-start/);
  assert.match(html, /PASS<\/span>/);
  assert.match(html, /data:image\/png;base64,aGVsbG8=/);
  assert.match(html, /question-shown/);
});

test("renderReplayReportHtml: fail report shows the first divergence", () => {
  const html = renderReplayReportHtml(
    artifact({
      status: "fail",
      firstDivergence: {
        segment: "start-to-question",
        step: 0,
        kind: "action-failed",
        expected: "tap /HUD/StartScreen/StartButton",
        actual: "Could not resolve locator",
      },
    }),
    [],
  );
  assert.match(html, /FAIL<\/span>/);
  assert.match(html, /First divergence/);
  assert.match(html, /action-failed/);
  assert.match(html, /Could not resolve locator/);
});

test("renderReplayReportHtml: escapes HTML in dynamic fields (no injection)", () => {
  const html = renderReplayReportHtml(
    artifact({
      status: "fail",
      console: { status: "fail", errorCount: 1, errors: ["<script>alert(1)</script>"] },
    }),
    [],
  );
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test("renderReplayReportHtml: a missing capture renders as 'capture missing', not a broken img", () => {
  const html = renderReplayReportHtml(artifact(), [
    { id: "question", segment: "start-to-question", base64: undefined },
  ]);
  assert.match(html, /actual missing/);
  assert.doesNotMatch(html, /data:image\/png/);
});

test("renderReplayReportHtml: escapes dynamic fields beyond console (id, divergence, anchors)", () => {
  const html = renderReplayReportHtml(
    artifact({
      traceId: "<x>",
      status: "fail",
      firstDivergence: {
        segment: "<seg>",
        step: 0,
        kind: "action-failed",
        expected: "<exp>",
        actual: "<act>",
      },
      segments: [
        { id: "<sid>", status: "fail", anchorsReached: ["<anc>"], captures: [] },
      ],
      assertions: [{ id: "<aid>", status: "fail" }],
    }),
    [],
  );
  for (const raw of ["<x>", "<seg>", "<exp>", "<act>", "<sid>", "<anc>", "<aid>"]) {
    assert.doesNotMatch(html, new RegExp(raw), `${raw} must be escaped, not raw`);
  }
  assert.match(html, /&lt;sid&gt;/);
});

test("renderReplayReportHtml: a malicious status cannot inject via the class attribute", () => {
  const html = renderReplayReportHtml(
    artifact({
      segments: [
        {
          id: "s",
          status: 'pass"><script>alert(1)</script>',
          anchorsReached: [],
          captures: [],
        },
      ] as unknown as ReplayRunArtifact["segments"],
    }),
    [],
  );
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /class="status-unknown"/);
});

test("renderReplayReportHtml: a drifted capture shows baseline + actual + the drift badge", () => {
  const html = renderReplayReportHtml(artifact({ visualDrift: true }), [
    {
      id: "question",
      segment: "start-to-question",
      base64: "YWN0dWFs",
      baselineBase64: "YmFzZWxpbmU=",
      visualStatus: "drift",
      diffFraction: 0.1234,
    },
  ]);
  assert.match(html, /visual drift/); // header badge
  assert.match(html, /YmFzZWxpbmU=/); // baseline image inlined
  assert.match(html, /YWN0dWFs/); // actual image inlined
  assert.match(html, /vstatus-drift">drift · 12\.34%/);
});

test("renderReplayReportHtml: a malicious visualStatus cannot inject via the class attribute", () => {
  const html = renderReplayReportHtml(artifact(), [
    {
      id: "q",
      segment: "s",
      base64: "YWN0dWFs",
      visualStatus: '"><img src=x onerror=alert(1)>' as unknown as CaptureImage["visualStatus"],
      diffFraction: 0.5,
    },
  ]);
  assert.doesNotMatch(html, /<img src=x onerror/);
  assert.match(html, /class="vstatus vstatus-none"/);
});

test("renderReplayReportHtml: a no-baseline capture is labeled, not silently matched", () => {
  const html = renderReplayReportHtml(artifact(), [
    { id: "question", segment: "start-to-question", base64: "YWN0dWFs", visualStatus: "no-baseline" },
  ]);
  assert.match(html, /no baseline/);
});

test("renderReplayReportHtml: blocked report names the reason", () => {
  const html = renderReplayReportHtml(
    artifact({ status: "blocked", resetTier: null, blockedReason: "unsupported-input-backend" }),
    [],
  );
  assert.match(html, /BLOCKED \(unsupported-input-backend\)/);
});
