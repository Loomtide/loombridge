/**
 * THE HTML PAGE BESIDE A REPLAY REPORT ALWAYS DESCRIBES THE RUN THAT WROTE THE JSON.
 *
 * Observed on a live consumer project. `loombridge verify --live` re-drove a trace, graded
 * 14 captures, found 2 over tolerance, exited 1, and wrote that failing verdict to
 * `.loombridge/replays/reports/kids-adventure.report.json` (13:42). It rendered no HTML, so
 * `kids-adventure.report.html` was still the page a standalone `trace replay` had rendered
 * from a PASSING run four minutes earlier (13:38), with nothing on it saying so.
 *
 * The HTML is the artifact a human actually opens. A missing one is a dead end; a stale one
 * is a wrong answer: a reader who opened that page after the failing verify would have seen
 * green frames and concluded the failure was spurious. The human here got the lucky outcome
 * and simply reported "I don't see the HTML report".
 *
 * The properties pinned below, in the order they matter:
 *
 *  1. after any command that writes `<id>.report.json`, the `<id>.report.html` beside it
 *     corresponds to that same run, or does not exist;
 *  2. the page NAMES the verdict it was rendered from (sha256 of the JSON's exact bytes),
 *     so staleness is detectable by any later reader instead of inferred from mtimes;
 *  3. `--no-html` still renders nothing, and removes the previous page rather than leaving
 *     it beside a fresher JSON.
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import zlib from "node:zlib";

import { replayTraceForVerify, run as runTrace } from "../../../../capabilities/replay/trace.js";
import { sourceReportSha256Of } from "../../../../capabilities/replay/report-html.js";
import {
  sha256,
  writeTraceBaselineManifest,
} from "../../../../capabilities/replay/trace-baseline-manifest.js";
import { standardReplayLayout } from "../../../../domain/state.js";
import type { BridgeResponse } from "../../../../shared/types.js";
import type { ReplayRunArtifact } from "../../../../capabilities/replay/types.js";

// ───────────────────────────── fixtures ─────────────────────────────

type Handler = (params: Record<string, unknown>) => { data?: unknown; error?: string };

/** A `UnityClient`-shaped fake: the same technique `replay-aligned-capture.test.ts` uses. */
function scriptedClient(png: Buffer): () => {
  isConnected: boolean;
  waitForReconnect(timeoutMs?: number): Promise<boolean>;
  connect(): Promise<unknown>;
  send(command: string, params: Record<string, unknown>, timeoutMs?: number): Promise<BridgeResponse>;
  disconnect(): Promise<void>;
} {
  const handlers: Record<string, Handler> = {
    "editor.wait_for": () => ({ data: { waited_ms: 1 } }),
    "editor.play": () => ({ data: { play_mode: "playing" } }),
    "editor.console_logs": () => ({ data: { logs: [] } }),
    "editor.screenshot": () => ({ data: { image_base64: png.toString("base64"), format: "png" } }),
  };
  return () => ({
    isConnected: true,
    waitForReconnect: async () => true,
    connect: async () => ({}),
    send: async (command, params) => {
      const result = (handlers[command] ?? (() => ({ data: {} })))(params);
      return { id: "t", timestamp: 0, status: "success", data: result.data ?? {} } as unknown as BridgeResponse;
    },
    disconnect: async () => {},
  });
}

/** A 1x1 PNG whose single pixel carries `r`: two different `r` values decode as full drift. */
function tinyPng(r: number): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.from([0, r, 0, 0, 255]);
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

function crc32(buf: Buffer): number {
  const table: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) | 0;
}

/** A project with one replayable trace and an APPROVED baseline frozen from `baseline`. */
async function projectWithApprovedTrace(baseline: Buffer): Promise<{
  root: string;
  paths: ReturnType<typeof standardReplayLayout>;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "loombridge-html-fresh-"));
  const paths = standardReplayLayout(root);
  await fs.mkdir(paths.replayTraces, { recursive: true });
  const traceBody = JSON.stringify({
    schemaVersion: "0.1",
    id: "demo",
    start: { scene: "Assets/Scenes/Game.unity", reset: "scene-load" },
    input: { backend: "ui-events" },
    segments: [{ id: "s1", actions: [], captures: [{ id: "cap", settleMs: 1 }] }],
    outcome: { expected: "success" },
  });
  await fs.writeFile(path.join(paths.replayTraces, "demo.trace.json"), traceBody);

  const baselineDir = path.join(paths.replayBaselines, "demo");
  await fs.mkdir(baselineDir, { recursive: true });
  await fs.writeFile(path.join(baselineDir, "cap.png"), baseline);
  await writeTraceBaselineManifest(baselineDir, {
    kind: "trace-baseline",
    schemaVersion: "1",
    traceId: "demo",
    traceSha256: sha256(Buffer.from(traceBody)),
    approvedAt: "2026-08-11T00:00:00.000Z",
    sourceReportSha256: "0".repeat(64),
    pngs: [{ captureId: "cap", sha256: sha256(baseline) }],
  });
  return { root, paths };
}

/** Capture stderr for a block (every one of these verbs reports there). */
async function captured<T>(fn: () => Promise<T>): Promise<{ value: T; out: string }> {
  const lines: string[] = [];
  const origError = console.error;
  const origLog = console.log;
  const sink = (...a: unknown[]): void => void lines.push(a.map(String).join(" "));
  console.error = sink;
  console.log = sink;
  try {
    return { value: await fn(), out: lines.join("\n") };
  } finally {
    console.error = origError;
    console.log = origLog;
  }
}

const htmlFile = (paths: ReturnType<typeof standardReplayLayout>): string =>
  path.join(paths.replayReports, "demo.report.html");
const jsonFile = (paths: ReturnType<typeof standardReplayLayout>): string =>
  path.join(paths.replayReports, "demo.report.json");

// ───────────────────────── the reproduction ─────────────────────────

/*
 * LITMUS, run 2026-08-11 against the real `replayTraceForVerify` -> `replayOneTrace` ->
 * `writeHtmlReport` path. Nothing in this file re-implements the rule it checks; every
 * assertion reads bytes those functions actually put on disk.
 *
 * The fix has TWO independent arms, and the litmus had to establish that, because each one
 * alone already closes the observed hole. Restoring only `html: false` on the verify seam
 * failed here, but on the OTHER arm (the page was deleted rather than left stale):
 *
 *   ✖ THE REPRODUCTION: a failing verify REPLACES the page a passing `trace replay` left
 *     Error: ENOENT: no such file or directory, open
 *     '/var/folders/.../loombridge-html-fresh-IG70HE/.loombridge/replays/reports/demo.report.html'
 *
 * So the pre-fix code was reconstructed in full: `html: false` on the verify seam AND
 * `removeStaleHtmlReport` neutered to `return undefined`, which is exactly what shipped.
 * That reproduces the defect the human hit:
 *
 *   ✖ THE REPRODUCTION: a failing verify REPLACES the page a passing `trace replay` left
 *     AssertionError [ERR_ASSERTION]: the page beside a rewritten verdict is STILL the
 *     earlier passing run: this is the observed defect
 *
 *     false !== true
 *
 * Both arms restored, it passes.
 */
test("THE REPRODUCTION: a failing verify REPLACES the page a passing `trace replay` left", async () => {
  const baseline = tinyPng(10);
  const { root, paths } = await projectWithApprovedTrace(baseline);
  try {
    // 13:38, the standalone door replays the trace and it MATCHES the frozen baseline.
    const first = await captured(() =>
      runTrace(["replay", "--id", "demo", "--root", root], { clientFactory: scriptedClient(baseline) }),
    );
    assert.equal(first.value, 0, first.out);
    const passingHtml = await fs.readFile(htmlFile(paths), "utf8");
    const passingJson = JSON.parse(await fs.readFile(jsonFile(paths), "utf8")) as ReplayRunArtifact;
    assert.equal(passingJson.segments[0]!.captures[0]!.visualStatus, "match");
    // The BADGE on the capture figure, not the bare class name: `vstatus-match` also
    // appears in the stylesheet of every page, drift or not, so matching it alone would
    // make both of these assertions true forever.
    assert.match(passingHtml, /vstatus vstatus-match/, "the page a human would open shows the green run");

    // 13:42, `verify --live` re-drives the SAME trace against a game that now renders a
    // different frame. This is the exact seam the unified door uses (`runFlowTrace`).
    const drifted = tinyPng(250);
    const second = await captured(() =>
      replayTraceForVerify(paths, "demo", { strictVisual: true, clientFactory: scriptedClient(drifted) }),
    );
    assert.equal(second.value.exitTier, 1, `the re-drive must grade as drift:\n${second.out}`);

    const rewrittenJsonBytes = await fs.readFile(jsonFile(paths), "utf8");
    const rewrittenJson = JSON.parse(rewrittenJsonBytes) as ReplayRunArtifact;
    assert.equal(
      rewrittenJson.segments[0]!.captures[0]!.visualStatus,
      "drift",
      "precondition: the verdict on disk is the FAILING run",
    );

    // PROPERTY 1. The page beside that verdict is this run's, not the earlier passing one.
    const afterHtml = await fs.readFile(htmlFile(paths), "utf8");
    assert.equal(
      afterHtml !== passingHtml,
      true,
      "the page beside a rewritten verdict is STILL the earlier passing run: this is the observed defect",
    );
    assert.match(afterHtml, /vstatus vstatus-drift/, "the page shows the drift the verdict reports");
    assert.doesNotMatch(afterHtml, /vstatus vstatus-match/, "…and no trace of the run it replaced");

    // PROPERTY 2. It says so in a way a later reader can CHECK, rather than by mtime.
    assert.equal(
      sourceReportSha256Of(afterHtml),
      sha256(rewrittenJsonBytes),
      "the page must name the exact verdict bytes it was rendered from",
    );
    assert.equal(second.value.htmlPath, htmlFile(paths), "…and the seam hands that page to its caller");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

/*
 * LITMUS, run 2026-08-11. The `sourceReportSha256` line deleted from the chrome object
 * `writeHtmlReport` hands `renderReplayReportHtml` (i.e. the page renders, but declines to
 * name the verdict it came from):
 *
 *   ✖ `trace report` re-renders the page bound to the bytes it READ, hand-edits included
 *     AssertionError [ERR_ASSERTION]: the page names the bytes it rendered, so a later
 *     reader can catch the pair drifting apart
 *     + actual - expected
 *
 *     + undefined
 *     - 'b70a01552a926917a4d1e22d94bce63c2975c18e2fea50acd2c0a84837a6d1e8'
 *
 * Restored, it passes.
 */
test("`trace report` re-renders the page bound to the bytes it READ, hand-edits included", async () => {
  const baseline = tinyPng(10);
  const { root, paths } = await projectWithApprovedTrace(baseline);
  try {
    const first = await captured(() =>
      runTrace(["replay", "--id", "demo", "--root", root, "--no-html"], {
        clientFactory: scriptedClient(baseline),
      }),
    );
    assert.equal(first.value, 0, first.out);

    // A HAND-EDITED verdict is the case that matters: `trace report` renders whatever is on
    // disk, so the stamp has to name those bytes, not a re-serialization of the parse.
    const edited = await fs.readFile(jsonFile(paths), "utf8");
    const tampered = edited.replace(`"status": "pass"`, `"status": "fail"`);
    assert.notEqual(tampered, edited, "precondition: the fixture verdict really was rewritten");
    await fs.writeFile(jsonFile(paths), tampered, "utf-8");

    const rendered = await captured(() => runTrace(["report", "--id", "demo", "--root", root]));
    assert.equal(rendered.value, 0, rendered.out);
    assert.equal(
      sourceReportSha256Of(await fs.readFile(htmlFile(paths), "utf8")),
      sha256(tampered),
      "the page names the bytes it rendered, so a later reader can catch the pair drifting apart",
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

/*
 * LITMUS, run 2026-08-11. `removeStaleHtmlReport` short-circuited to `return undefined`,
 * which is the pre-fix behaviour exactly: `--no-html` skipped rendering and left whatever
 * page happened to be there:
 *
 *   ✖ `--no-html` renders nothing AND deletes the previous run's page, rather than leaving
 *     it beside a fresher verdict
 *     AssertionError [ERR_ASSERTION]: the page from the PREVIOUS run is still on disk
 *     beside a verdict it does not describe
 *
 *     true !== false
 *
 * Restored, it passes.
 */
test("`--no-html` renders nothing AND deletes the previous run's page, rather than leaving it beside a fresher verdict", async () => {
  const baseline = tinyPng(10);
  const { root, paths } = await projectWithApprovedTrace(baseline);
  try {
    // A page exists from an earlier run that DID render one.
    const first = await captured(() =>
      runTrace(["replay", "--id", "demo", "--root", root], { clientFactory: scriptedClient(baseline) }),
    );
    assert.equal(first.value, 0, first.out);
    assert.equal(await exists(htmlFile(paths)), true, "precondition: an earlier run left a page");

    // The human explicitly opts out of rendering for the NEXT run, which drifts.
    const second = await captured(() =>
      runTrace(["replay", "--id", "demo", "--root", root, "--no-html"], {
        clientFactory: scriptedClient(tinyPng(250)),
      }),
    );
    // Exit 0: the STANDALONE door is permissive about pixel drift by default (only the
    // unified door gates it), which is untouched here. What matters is that this run
    // really did produce a different verdict from the one the page on disk describes.
    assert.equal(second.value, 0, second.out);
    assert.match(second.out, /visual drift: cap/, "precondition: the re-drive graded differently");

    // The opt-out is HONOURED: nothing was rendered. And property 1 still holds, by the
    // other arm: rather than leave a page describing a run that is no longer the verdict on
    // disk, the stale one is removed, and the removal is announced with the way back.
    assert.equal(
      await exists(htmlFile(paths)),
      false,
      "the page from the PREVIOUS run is still on disk beside a verdict it does not describe",
    );
    assert.match(second.out, /removed the stale demo\.report\.html/);
    assert.match(second.out, /loombridge trace report --id demo/, "the human is told how to get a page back");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("`--no-html` on a project that never rendered a page says nothing (no phantom removal)", async () => {
  const baseline = tinyPng(10);
  const { root, paths } = await projectWithApprovedTrace(baseline);
  try {
    const only = await captured(() =>
      runTrace(["replay", "--id", "demo", "--root", root, "--no-html"], {
        clientFactory: scriptedClient(baseline),
      }),
    );
    assert.equal(only.value, 0, only.out);
    assert.equal(await exists(htmlFile(paths)), false);
    assert.doesNotMatch(only.out, /removed the stale/, "nothing was there, so nothing is announced");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function exists(file: string): Promise<boolean> {
  try {
    await fs.stat(file);
    return true;
  } catch {
    return false;
  }
}
