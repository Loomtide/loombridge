/**
 * A RESIZED GAME VIEW IS A HARNESS FAULT, NOT A GAME DEFECT.
 *
 * THE OBSERVATION, on a live consumer project. The operator resized the Unity Game view
 * between `loombridge trace approve` and `loombridge trace replay`. Every capture came back
 * at the new size, `comparePerceptual` correctly refused to pixel-align two frames with no
 * common pixel space, and the run reported `diffFraction: 1`, `visualStatus: "drift"`, exit
 * 1: the GAME tier. The operator was told their game had changed completely. Nothing in the
 * output, the report, or the rendered page mentioned resolution.
 *
 * THREE THINGS WERE MISSING, each pinned below:
 *
 *  1. NOTHING RECORDED THE RESOLUTION. The trace had no viewport field at all (its keys
 *     were `schemaVersion, id, start, input, segments, outcome`) and the baseline manifest
 *     stamped `frameWidth`/`frameHeight` only when MASKS existed, which is backwards: masks
 *     NEED the dimensions to position rects, but every baseline HAS a resolution, and an
 *     anchor that cannot state its own size cannot tell an operator what to restore.
 *
 *  2. `dimensionsMatch` WAS COMPUTED AND NEVER READ. `comparePerceptual` has always
 *     returned it (`visual-diff.ts`), and on the replay door nothing consumed it: its only
 *     readers were the minigame path. So the one fact that separates "the game changed"
 *     from "the window changed" was thrown away one line after it was derived.
 *
 *  3. THE REMEDY DID NOT EXIST. With no size on disk anywhere, the only way forward from a
 *     red gate was to re-approve, which mints a new anchor from frames nothing compared.
 *     Restoring the window was not offered because no number said what to restore it to.
 *
 * THIS WAS NEVER A FALSE GREEN. The mismatch was always caught and always loud, and a
 * cross-resolution comparison can never be laundered into a pass. What shipped wrong was
 * the TIER and the message, which is its own kind of expensive: a correct verdict pointed
 * at the wrong suspect.
 *
 * THE FREE-ASPECT DECISION, which is the real design risk. A project on a free-aspect Game
 * view resizes constantly, so a rule that says "any difference is red" turns an honest
 * project permanently red, and a permanently red gate gets relaxed later. The tests below
 * pin BOTH halves of the answer: the mismatch REFUSES (harness, exit 2, never a pass, never
 * drift) because a comparison across resolutions is meaningless and there is no honest
 * verdict to give; and the way forward is RESTORE THE WINDOW to the size the anchor now
 * states, which costs nothing and keeps the anchor a human already consented to. Re-approve
 * remains available and is deliberately named second.
 *
 * LITMUS is recorded per test: the real code path was broken, the failure observed VERBATIM
 * from the runner, and the line restored. A guard whose failure nobody has seen is a guard
 * nobody has tested.
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import zlib from "node:zlib";

import { parseTrace } from "../../../../capabilities/replay/parse.js";
import { recordObservedTrace } from "../../../../capabilities/replay/observe-record-live.js";
import { run as runTrace } from "../../../../capabilities/replay/trace.js";
import { loadTraceBaselineManifest } from "../../../../capabilities/replay/trace-baseline-manifest.js";
import type { TraceBaselineManifest } from "../../../../capabilities/replay/trace-baseline-manifest.js";
import type { ReplayRunArtifact } from "../../../../capabilities/replay/types.js";
import { standardReplayLayout } from "../../../../domain/state.js";
import type { BridgeResponse } from "../../../../shared/types.js";
import type { BridgeSend } from "../../../../capabilities/replay/unity-driver.js";

// ───────────────────────────── fixtures ─────────────────────────────

/**
 * A valid non-interlaced 8-bit RGBA PNG of the requested size, filled with `r` in the red
 * channel. Sized on purpose: the whole subject of this file is two frames that do not agree
 * on their dimensions, so a fixed 1x1 helper could not express it.
 */
function png(width: number, height: number, r: number): Buffer {
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
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 4); // leading filter byte 0 (None)
    for (let x = 0; x < width; x += 1) {
      row[1 + x * 4] = r;
      row[1 + x * 4 + 3] = 255;
    }
    rows.push(row);
  }
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function crc32(buf: Buffer): number {
  let c: number;
  const table: number[] = [];
  for (let n = 0; n < 256; n += 1) {
    c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) | 0;
}

type Handler = (params: Record<string, unknown>) => { data?: unknown };

/**
 * The live client the replay drives, returning WHATEVER `current()` says right now.
 *
 * The indirection is the fixture's whole job: a resize is modelled by approving one run and
 * then handing the NEXT replay a differently sized frame from the same editor, which is
 * exactly what dragging the Game view's edge does. The whole door is walked through this
 * seam (argv → manifest read → driver → report → page), so nothing here re-implements a
 * predicate the product owns.
 */
function scriptedClient(current: () => Buffer): () => {
  isConnected: boolean;
  waitForReconnect: () => Promise<boolean>;
  connect: () => Promise<unknown>;
  send: (command: string, params: Record<string, unknown>) => Promise<BridgeResponse>;
  disconnect: () => Promise<void>;
} {
  const handlers: Record<string, Handler> = {
    "editor.wait_for": () => ({ data: { waited_ms: 1 } }),
    "editor.play": () => ({ data: { play_mode: "playing" } }),
    "editor.console_logs": () => ({ data: { logs: [] } }),
    "editor.screenshot": () => ({ data: { image_base64: current().toString("base64"), format: "png" } }),
    "replay.settle_and_capture": () => ({
      data: {
        image_base64: current().toString("base64"),
        format: "png",
        framesElapsed: 15,
        settledMs: 250,
        realtimeDeadlineHit: false,
        fixedDeltaTime: 0.02,
      },
    }),
  };
  return () => ({
    isConnected: true,
    waitForReconnect: async () => true,
    connect: async () => ({}),
    send: async (command: string, params: Record<string, unknown>) => {
      const handler = handlers[command] ?? (() => ({ data: {} }));
      return {
        id: "t",
        timestamp: 0,
        status: "success",
        data: handler(params).data ?? {},
      } as unknown as BridgeResponse;
    },
    disconnect: async () => {},
  });
}

/** A one-capture trace where the verb expects it, optionally declaring a recorded size. */
async function writeTrace(root: string, viewport?: { width: number; height: number }): Promise<void> {
  const paths = standardReplayLayout(root);
  await fs.mkdir(paths.replayTraces, { recursive: true });
  await fs.writeFile(
    path.join(paths.replayTraces, "demo.trace.json"),
    JSON.stringify({
      schemaVersion: "0.1",
      id: "demo",
      start: { scene: "Assets/Scenes/Game.unity", reset: "scene-load" },
      input: { backend: "ui-events" },
      ...(viewport ? { viewport } : {}),
      segments: [{ id: "cap", actions: [], captures: [{ id: "cap", settleMs: 250 }] }],
      outcome: { expected: "success" },
    }),
  );
}

async function tmpRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "loombridge-capture-res-"));
}

/** Capture stderr for a block (the CLI prints its refusals there). */
async function captured<T>(fn: () => Promise<T>): Promise<{ value: T; out: string }> {
  const original = console.error;
  let out = "";
  console.error = (...args: unknown[]) => {
    out += `${args.map(String).join(" ")}\n`;
  };
  try {
    return { value: await fn(), out };
  } finally {
    console.error = original;
  }
}

async function readReport(root: string): Promise<ReplayRunArtifact> {
  const paths = standardReplayLayout(root);
  return JSON.parse(
    await fs.readFile(path.join(paths.replayReports, "demo.report.json"), "utf8"),
  ) as ReplayRunArtifact;
}

async function readManifest(root: string): Promise<TraceBaselineManifest> {
  const loaded = await loadTraceBaselineManifest(
    path.join(standardReplayLayout(root).replayBaselines, "demo"),
  );
  assert.ok(loaded !== null && !("error" in loaded), `manifest unreadable: ${JSON.stringify(loaded)}`);
  return loaded;
}

/** Rewrite the stamped manifest on disk, the way a hand edit or an older tool would leave it. */
async function editManifest(root: string, mutate: (m: Record<string, unknown>) => void): Promise<void> {
  const file = path.join(standardReplayLayout(root).replayBaselines, "demo", "baseline-manifest.json");
  const parsed = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
  mutate(parsed);
  await fs.writeFile(file, `${JSON.stringify(parsed, null, 2)}\n`);
}

const W = 40;
const H = 24;

// ───────── 1. the reproduction, through the whole door ─────────

test("THE REPRODUCTION: a resized Game view is a HARNESS FAULT that names both resolutions, never drift", async () => {
  const root = await tmpRoot();
  try {
    // One editor, one trace. The frame size changes between the two replays, which is what
    // dragging the Game view's edge does to every capture that follows.
    let frame = png(W, H, 10);
    const factory = scriptedClient(() => frame);
    await writeTrace(root);

    assert.equal(
      (await captured(() => runTrace(["replay", "--id", "demo", "--root", root], { clientFactory: factory }))).value,
      0,
    );
    assert.equal((await captured(() => runTrace(["approve", "--id", "demo", "--root", root]))).value, 0);

    // …the operator resizes the window, and re-runs.
    //
    // `--strict-visual` BECAUSE THAT IS THE DOOR THE OPERATOR WAS ON. The unified
    // `loombridge verify` flow hard-codes `strictVisual: true` (orchestrator.ts), so drift
    // there is exit 1, the GAME tier: the reported observation exactly. The bare
    // `trace replay` door treats drift as a warning and exited 0, which is the same defect
    // wearing the pass tier instead; it is pinned by its own test below so neither door can
    // regress alone.
    frame = png(W * 2, H, 10);
    const { value: exit, out } = await captured(() =>
      runTrace(["replay", "--id", "demo", "--root", root, "--strict-visual"], { clientFactory: factory }),
    );

    // (a) THE TIER. This is the assertion that fails on the shipped code, where the run
    // exited 1 on `diffFraction: 1`.
    assert.equal(exit, 2, "a resize is a harness fault, never a game defect");

    const report = await readReport(root);
    const capture = report.segments[0]!.captures[0]!;

    // (b) IT IS NOT DRIFT, AND IT CARRIES NO DRIFT NUMBER. `diffFraction: 1` next to
    // `status: "drift"` is precisely the sentence that told the operator their game had
    // changed completely, so its ABSENCE is part of the fix, not an incidental detail.
    assert.equal(capture.visualStatus, "not-compared", "nothing was compared, so nothing drifted");
    assert.equal(capture.diffFraction, undefined, "a frame nothing compared has no diff fraction");
    assert.notEqual(report.visualDrift, true, "the run claims no drift it did not measure");
    assert.equal(report.visualHarnessFault, true);

    // (c) BOTH RESOLUTIONS ARE NAMED, on the REPORT and not only on the stderr of the
    // process that wrote it: the rendered page and any later reader have only the JSON.
    const reason = report.visualHarnessFaultReason ?? "";
    assert.match(reason, new RegExp(`${W * 2}x${H}`), "the reason names the size the run captured at");
    assert.match(reason, new RegExp(`\\b${W}x${H}\\b`), "…and the size the anchor was approved at");
    assert.match(reason, /resolution/i);

    // (d) THE COMPARISON DID NOT HAPPEN, and the coverage says so against the anchor's own
    // denominator, so the exit code has a second, independent reason to refuse a pass.
    assert.equal(report.comparisonsExpected, 1);
    assert.equal(report.comparisonsPerformed, 0);

    // (e) THE OPERATOR IS TOLD WHAT TO DO, with the number they need. Restoring the window
    // leads; re-approving is named second on purpose (it mints an anchor from frames
    // nothing compared).
    assert.match(out, new RegExp(`taken at ${W * 2}x${H}`));
    assert.match(out, new RegExp(`approved baseline is ${W}x${H}`));
    assert.match(out, new RegExp(`set the Unity Game view back to ${W}x${H}`));
    assert.match(out, /harness fault, not (a game defect|drift)/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

/*
 * LITMUS. BREAK, `trace.ts` `applyVisualDiff`, restore the unread flag so the diff's own
 * `drift`/`1` verdict is stamped exactly as it was before this change:
 *     -        if (!diff.dimensionsMatch) {
 *     +        if (false && !diff.dimensionsMatch) {
 *   OBSERVED (node --test, over the real CLI door), verbatim:
 *
 *     test at dist/__tests__/unit/capabilities/replay/replay-capture-resolution.test.js:200:1
 *     ✖ THE REPRODUCTION: a resized Game view is a HARNESS FAULT that names both resolutions, never drift
 *       AssertionError [ERR_ASSERTION]: a resize is a harness fault, never a game defect
 *
 *       1 !== 2
 *
 *         actual: 1,
 *         expected: 2,
 *         operator: 'strictEqual'
 *
 *   That `1` IS the shipped defect: the game-defect tier for a window that was dragged. The
 *   same break also drops three other tests in this file (the non-strict door at 0, the
 *   unstamped anchor at 0, the free-aspect refusal at 0), each recorded below.
 */

test("…and on the NON-strict door, where the same resize used to sit at the PASS tier", async () => {
  const root = await tmpRoot();
  try {
    let frame = png(W, H, 10);
    const factory = scriptedClient(() => frame);
    await writeTrace(root);
    await captured(() => runTrace(["replay", "--id", "demo", "--root", root], { clientFactory: factory }));
    assert.equal((await captured(() => runTrace(["approve", "--id", "demo", "--root", root]))).value, 0);

    // WITHOUT `--strict-visual`, DRIFT IS A WARNING (GPU/AA noise must not fail CI), so the
    // pre-fix path exited 0 here: a run whose captures shared no pixels with their anchor,
    // graded, called drift, and waved through at the pass tier. Both doors are pinned
    // because the two tiers are different bugs and a partial fix could leave either.
    frame = png(W * 2, H, 10);
    const { value: exit } = await captured(() =>
      runTrace(["replay", "--id", "demo", "--root", root], { clientFactory: factory }),
    );
    assert.equal(exit, 2, "a run that compared nothing is never a pass, strict or not");
    assert.notEqual((await readReport(root)).visualDrift, true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

/*
 * LITMUS. BREAK, `trace.ts` `applyVisualDiff`, disable the dimensions branch:
 *     -        if (!diff.dimensionsMatch) {
 *     +        if (false && !diff.dimensionsMatch) {
 *   OBSERVED, verbatim:
 *     ✖ …and on the NON-strict door, where the same resize used to sit at the PASS tier
 *       AssertionError [ERR_ASSERTION]: a run that compared nothing is never a pass, strict or not
 *
 *       0 !== 2
 *
 *         actual: 0,
 *         expected: 2,
 *         operator: 'strictEqual'
 */

// ───────── 2. approve stamps the resolution, with no masks anywhere ─────────

test("approve STAMPS the capture resolution on an unmasked anchor, and announces it", async () => {
  const root = await tmpRoot();
  try {
    const factory = scriptedClient(() => png(W, H, 10));
    await writeTrace(root);
    await captured(() => runTrace(["replay", "--id", "demo", "--root", root], { clientFactory: factory }));
    const { value: exit, out } = await captured(() => runTrace(["approve", "--id", "demo", "--root", root]));
    assert.equal(exit, 0, out);

    // THE STAMP. Before this change these were `undefined` on every anchor that carried no
    // masks, i.e. on essentially every anchor.
    const manifest = await readManifest(root);
    assert.equal(manifest.maskRects, undefined, "the guard is about the UNMASKED path");
    assert.equal(manifest.frameWidth, W, "an unmasked anchor records the size it was approved at");
    assert.equal(manifest.frameHeight, H);

    // …and the operator is told the number, because it is the one they will need later.
    assert.match(out, new RegExp(`capture resolution ${W}x${H}`));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

/*
 * LITMUS. BREAK, `trace.ts` `runApprove`, delete the unmasked stamp so the size is once
 * again recorded only when masks exist:
 *     -  } else {
 *     -    // The unmasked stamp. …
 *     -    carried.frameWidth = dims.width;
 *     -    carried.frameHeight = dims.height;
 *     -  }
 *     +  }
 *   OBSERVED, verbatim:
 *     ✖ approve STAMPS the capture resolution on an unmasked anchor, and announces it
 *       AssertionError [ERR_ASSERTION]: an unmasked anchor records the size it was approved at
 *
 *       undefined !== 40
 *
 *         actual: undefined,
 *         expected: 40,
 *         operator: 'strictEqual'
 *
 *   The same break also drops the free-aspect test's re-anchor assertion ("approve
 *   re-derives the size, never inherits it": undefined !== 48) and the pre-drive note test,
 *   which has no anchor size left to compare the trace's against.
 */

// ───────── 3. an anchor approved BEFORE the stamp existed still works ─────────

test("A PRE-EXISTING ANCHOR WITH NO STAMPED SIZE still replays, still grades, and still catches a resize", async () => {
  const root = await tmpRoot();
  try {
    let frame = png(W, H, 10);
    const factory = scriptedClient(() => frame);
    await writeTrace(root);
    await captured(() => runTrace(["replay", "--id", "demo", "--root", root], { clientFactory: factory }));
    assert.equal((await captured(() => runTrace(["approve", "--id", "demo", "--root", root]))).value, 0);

    // THE LIVE CONSUMER SHAPE, constructed rather than borrowed: an approved anchor whose
    // manifest carries no `frameWidth`/`frameHeight` at all, beside a trace with no
    // `viewport`. This is the state every anchor on disk is in today, including the one on
    // the real project this defect was found on.
    await editManifest(root, (m) => {
      delete m.frameWidth;
      delete m.frameHeight;
    });
    const stripped = await readManifest(root);
    assert.equal(stripped.frameWidth, undefined, "the fixture really is unstamped");

    // (a) IT STILL GRADES. An absent size is "nobody wrote it down", not a mismatch, so it
    // must not make the anchor permanently red for a field that grades nothing on its own.
    const green = await captured(() =>
      runTrace(["replay", "--id", "demo", "--root", root], { clientFactory: factory }),
    );
    assert.equal(green.value, 0, green.out);
    const ok = await readReport(root);
    assert.equal(ok.segments[0]!.captures[0]!.visualStatus, "match");
    assert.equal(ok.comparisonsPerformed, 1, "the unstamped anchor was really compared, not skipped");
    assert.notEqual(ok.visualHarnessFault, true);

    // (b) AND IT STILL CATCHES A REAL RESIZE. This is what makes the absence safe rather
    // than a hole: the check reads the DECODED frames, so there is no field to omit and the
    // unstamped anchor is protected exactly as a stamped one is.
    frame = png(W, H * 2, 10);
    const red = await captured(() =>
      runTrace(["replay", "--id", "demo", "--root", root], { clientFactory: factory }),
    );
    assert.equal(red.value, 2, "an unstamped anchor still refuses a cross-resolution comparison");
    const report = await readReport(root);
    assert.equal(report.segments[0]!.captures[0]!.visualStatus, "not-compared");
    assert.match(report.visualHarnessFaultReason ?? "", new RegExp(`${W}x${H * 2}`));
    assert.match(report.visualHarnessFaultReason ?? "", new RegExp(`\\b${W}x${H}\\b`));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

/*
 * LITMUS, two directions, because this test's job is to catch a fix that bought strictness
 * with compatibility, and one that bought compatibility with the check.
 *
 * BREAK 3a (compatibility lost), `trace-baseline-manifest.ts` `verifyTraceBaseline`, make
 * the stamped-size check fire on an ABSENT stamp too, i.e. drop the presence test:
 *     -  if (loaded.frameWidth !== undefined && loaded.frameHeight !== undefined) {
 *     +  if (true) {
 *   OBSERVED, verbatim:
 *     ✖ A PRE-EXISTING ANCHOR WITH NO STAMPED SIZE still replays, still grades, and still catches a resize
 *       AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
 *
 *       2 !== 0
 *
 *         actual: 2,
 *         expected: 0,
 *         operator: 'strictEqual'
 *   That is the KidsAdventure anchor going permanently red for a field that was absent when
 *   it was approved, which is the compatibility failure this test exists to catch.
 *
 * BREAK 3b (the check lost), `trace.ts` `applyVisualDiff`, disable the dimensions branch:
 *     -        if (!diff.dimensionsMatch) {
 *     +        if (false && !diff.dimensionsMatch) {
 *   OBSERVED, verbatim:
 *     ✖ A PRE-EXISTING ANCHOR WITH NO STAMPED SIZE still replays, still grades, and still catches a resize
 *       AssertionError [ERR_ASSERTION]: an unstamped anchor still refuses a cross-resolution comparison
 *
 *       0 !== 2
 *
 *         actual: 0,
 *         expected: 2,
 *         operator: 'strictEqual'
 */

// ───────── 4. the free-aspect way forward, which is the real design risk ─────────

test("THE FREE-ASPECT WAY FORWARD: restoring the window re-greens the SAME anchor; re-approving is the second door", async () => {
  const root = await tmpRoot();
  try {
    let frame = png(W, H, 10);
    const factory = scriptedClient(() => frame);
    await writeTrace(root);
    await captured(() => runTrace(["replay", "--id", "demo", "--root", root], { clientFactory: factory }));
    assert.equal((await captured(() => runTrace(["approve", "--id", "demo", "--root", root]))).value, 0);
    const approvedAt = (await readManifest(root)).approvedAt;

    // The free-aspect project resizes. The gate refuses, at the harness tier.
    frame = png(W + 8, H, 10);
    assert.equal(
      (await captured(() => runTrace(["replay", "--id", "demo", "--root", root], { clientFactory: factory }))).value,
      2,
    );

    // (a) THE CAPTURE-LEVEL FAULT IS DELIBERATELY NOT SET. This single field is what decides
    // whether the operator is locked out: `approve` refuses any run carrying `harnessFault`
    // (BX1), and this repo has twice shipped a refusal that vetoed the very escape hatch it
    // pointed at. A resize must stay approvable.
    assert.equal(
      (await readReport(root)).segments[0]!.captures[0]!.harnessFault,
      undefined,
      "a resized capture is not a capture the harness lost; approve must remain available",
    );

    // (b) DOOR ONE, AND THE ONE THE OUTPUT LEADS WITH: put the window back. The anchor is
    // untouched, no new consent is minted, and the very next run is green. This is the
    // answer to "an operator on free-aspect cannot re-approve every time".
    frame = png(W, H, 10);
    const restored = await captured(() =>
      runTrace(["replay", "--id", "demo", "--root", root], { clientFactory: factory }),
    );
    assert.equal(restored.value, 0, restored.out);
    assert.equal((await readReport(root)).comparisonsPerformed, 1);
    assert.equal(
      (await readManifest(root)).approvedAt,
      approvedAt,
      "restoring the window re-uses the anchor a human already approved; it does not re-mint one",
    );

    // (c) DOOR TWO: the new size really is the one they want. `approve` re-anchors at it,
    // and the manifest now states the NEW size rather than inheriting the old one.
    frame = png(W + 8, H, 10);
    await captured(() => runTrace(["replay", "--id", "demo", "--root", root], { clientFactory: factory }));
    const reapprove = await captured(() => runTrace(["approve", "--id", "demo", "--root", root]));
    assert.equal(reapprove.value, 0, reapprove.out);
    assert.equal((await readManifest(root)).frameWidth, W + 8, "approve re-derives the size, never inherits it");

    const after = await captured(() =>
      runTrace(["replay", "--id", "demo", "--root", root], { clientFactory: factory }),
    );
    assert.equal(after.value, 0, after.out);
    assert.equal((await readReport(root)).comparisonsPerformed, 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

/*
 * LITMUS. BREAK, `trace.ts` `applyVisualDiff`, tier the resize as a CAPTURE fault, which is
 * the shape that reads as the stricter and more obvious fix:
 *     +          capture.harnessFault = `captured at ${actual.width}x${actual.height}`;
 *   OBSERVED, verbatim:
 *     ✖ THE FREE-ASPECT WAY FORWARD: restoring the window re-greens the SAME anchor; re-approving is the second door
 *       AssertionError [ERR_ASSERTION]: a resized capture is not a capture the harness lost; approve must remain available
 *       + actual - expected
 *
 *       + 'captured at 48x24'
 *       - undefined
 *
 *         actual: 'captured at 48x24',
 *         expected: undefined,
 *         operator: 'strictEqual'
 *
 *   That one field is the lock-out: `approve` refuses any run carrying a capture-level
 *   `harnessFault` (BX1), so the "re-anchor at the new size" door named in the refusal's own
 *   remedy would be closed by the refusal.
 *
 * THE OTHER DIRECTION, for the "just tolerate a resize" design the free-aspect worry pushes
 * toward. BREAK, disable the dimensions branch so the resize grades:
 *     -        if (!diff.dimensionsMatch) {
 *     +        if (false && !diff.dimensionsMatch) {
 *   OBSERVED: this test falls at the refusal itself,
 *       AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
 *
 *       0 !== 2
 *
 *         actual: 0,
 *         expected: 2,
 *         operator: 'strictEqual'
 *   which is the point: between refusing and lying there is no third state, because two
 *   frames of different sizes share no pixels to have an opinion about.
 */

// ───────── 5. the trace records the size, and the field is not decorative ─────────

test("the recorder STAMPS the Game view size on the trace, and the parser preserves it", async () => {
  // The recorder reads the live viewport after the reset and writes it onto the trace.
  const calls: string[] = [];
  const send: BridgeSend = async (command, params) => {
    calls.push(command);
    const data: Record<string, Record<string, unknown>> = {
      "ui.get_screen_rects": { viewport: { width: 1920, height: 1080, aspect: 1.777 } },
      "input.observe_stop": {
        clicks: [{ tMs: 0, locator: { path: "/HUD/Start" }, button: 0, kind: "ui" }],
        observed: true,
      },
    };
    void params;
    return { id: "t", timestamp: 0, status: "success", data: data[command] ?? {} } as unknown as BridgeResponse;
  };
  const { trace } = await recordObservedTrace(
    send,
    { id: "demo", scene: "Assets/Scenes/Game.unity" },
    { waitForStop: async () => {} },
  );
  assert.deepEqual(trace.viewport, { width: 1920, height: 1080 });
  assert.ok(calls.includes("ui.get_screen_rects"), "the size is read from the editor, never guessed");

  // AND IT SURVIVES THE PARSER. `parseTrace` REBUILDS the trace field by field, so a field
  // it does not name exists on disk and vanishes the moment replay reads the file: a
  // recorder writing a viewport nothing could read back would be a wired-looking field that
  // is not wired, which is this repo's most expensive recurring shape.
  const roundTripped = parseTrace(JSON.parse(JSON.stringify(trace)));
  assert.deepEqual(roundTripped.viewport, { width: 1920, height: 1080 });

  // An absent viewport stays absent (every trace recorded before this field existed).
  const legacy = parseTrace({
    schemaVersion: "0.1",
    id: "demo",
    start: { scene: "Assets/Scenes/Game.unity", reset: "scene-load" },
    input: { backend: "ui-events" },
    segments: [{ id: "s", actions: [] }],
    outcome: { expected: "success" },
  });
  assert.equal(legacy.viewport, undefined, "a legacy trace parses unchanged");

  // A PRESENT-BUT-MALFORMED viewport REFUSES rather than being coerced or dropped: a
  // half-written value would otherwise go on to name resolutions in operator-facing prose.
  for (const bad of [{ width: 1920 }, { width: "1920", height: 1080 }, { width: 0, height: 1080 }]) {
    assert.throws(
      () =>
        parseTrace({
          schemaVersion: "0.1",
          id: "demo",
          start: { scene: "Assets/Scenes/Game.unity", reset: "scene-load" },
          input: { backend: "ui-events" },
          viewport: bad,
          segments: [{ id: "s", actions: [] }],
          outcome: { expected: "success" },
        }),
      /viewport\.(width|height) must be a positive integer/,
      `viewport ${JSON.stringify(bad)} must be refused, not coerced`,
    );
  }
});

/*
 * LITMUS. BREAK 5a, `parse.ts`, drop the field from the rebuilt trace, which is the exact
 * shape of this repo's recurring defect (a writer writes it, the reader silently discards
 * it, and the field reads as wired):
 *     -    ...(viewport !== undefined ? { viewport } : {}),
 *     +    ...(false && viewport !== undefined ? { viewport } : {}),
 *   OBSERVED, verbatim:
 *     ✖ the recorder STAMPS the Game view size on the trace, and the parser preserves it
 *       AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
 *       + actual - expected
 *
 *       + undefined
 *       - {
 *       -   height: 1080,
 *       -   width: 1920
 *       - }
 *
 *         actual: undefined,
 *         expected: { width: 1920, height: 1080 },
 *         operator: 'deepStrictEqual'
 *   …and the pre-drive note test falls with it, because the replay reads the trace through
 *   this parser and so the recorded size never reaches the comparison.
 *
 * BREAK 5b, `observe-record-live.ts`, stop reading the live viewport:
 *     -  const viewport = await driver.recordedViewport();
 *     +  const viewport = null as { width: number; height: number } | null;
 *   OBSERVED, verbatim (the same deep-equal failure, one layer earlier):
 *     ✖ the recorder STAMPS the Game view size on the trace, and the parser preserves it
 *       AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
 *         actual: undefined,
 *         expected: { width: 1920, height: 1080 },
 *         operator: 'deepStrictEqual'
 */

// ───────── 6. the mismatch is NAMED BEFORE the editor is driven ─────────

test("a trace recorded at one size against an anchor approved at another says so BEFORE it drives", async () => {
  const root = await tmpRoot();
  try {
    const factory = scriptedClient(() => png(W, H, 10));
    // Recorded at the anchor's size first, so the anchor gets stamped at WxH…
    await writeTrace(root, { width: W, height: H });
    await captured(() => runTrace(["replay", "--id", "demo", "--root", root], { clientFactory: factory }));
    assert.equal((await captured(() => runTrace(["approve", "--id", "demo", "--root", root]))).value, 0);

    // …then the demonstration is re-recorded at a new window size. The pixel gate cannot
    // learn this until it decodes a frame, which is a capture per gesture away.
    await writeTrace(root, { width: W * 3, height: H });
    const { out } = await captured(() =>
      runTrace(["replay", "--id", "demo", "--root", root], { clientFactory: factory }),
    );

    assert.match(out, new RegExp(`recorded at ${W * 3}x${H} but its approved frames are ${W}x${H}`));
    // BEFORE THE DRIVE, not after: the note has to precede the first capture or it saves
    // nobody the thirteen frames it exists to save. The replay's own reset is the first
    // thing the driver does, and the summary is the last thing printed.
    assert.ok(
      out.indexOf("recorded at") < out.indexOf("report →"),
      "the note lands before the run's own output, not in the post-mortem",
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

/*
 * LITMUS. BREAK, `trace.ts` `replayOneTrace`, unwire the pre-drive call from the trace:
 *     -  await announceViewportMismatch(paths, id, trace.viewport);
 *     +  await announceViewportMismatch(paths, id, undefined);
 *   OBSERVED, verbatim (trimmed to the assertion; the full input is the run's own output):
 *     ✖ a trace recorded at one size against an anchor approved at another says so BEFORE it drives
 *       AssertionError [ERR_ASSERTION]: The input did not match the regular expression
 *       /recorded at 120x24 but its approved frames are 40x24/. Input:
 *
 *       "[loombridge trace] capture-aligned replay at 60 fps: …\n" +
 *         '[loombridge trace] the approved baseline for "demo" cannot be trusted at grade time
 *          (harness fault, not a game defect): trace file sha256 mismatch: the baseline was
 *          approved for a different demonstration\n' +
 *         …
 *
 *         expected: /recorded at 120x24 but its approved frames are 40x24/,
 *         operator: 'match'
 *
 *   Note what that captured output also shows, and why the note earns its place: a
 *   re-recorded trace ALSO breaks its anchor's `traceSha256` binding, so the run is refused
 *   anyway. The note is what turns "the baseline was approved for a different
 *   demonstration" into "…and here is the size that changed", before thirteen captures.
 *
 * The vacuity direction is covered by the test below rather than by a comment: a note
 * printed on every run is a note nobody reads.
 */

test("a matching recorded size is SILENT: the pre-drive note is not printed on every run", async () => {
  const root = await tmpRoot();
  try {
    const factory = scriptedClient(() => png(W, H, 10));
    await writeTrace(root, { width: W, height: H });
    await captured(() => runTrace(["replay", "--id", "demo", "--root", root], { clientFactory: factory }));
    assert.equal((await captured(() => runTrace(["approve", "--id", "demo", "--root", root]))).value, 0);
    const { value: exit, out } = await captured(() =>
      runTrace(["replay", "--id", "demo", "--root", root], { clientFactory: factory }),
    );
    assert.equal(exit, 0, out);
    assert.doesNotMatch(out, /recorded at/, "a note printed on every run is a note nobody reads");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ───────── 7. the stamped size is bound to the frames it claims to describe ─────────

test("a stamped resolution that is NOT the size of the approved frames is a harness fault, not a denominator", async () => {
  const root = await tmpRoot();
  try {
    const factory = scriptedClient(() => png(W, H, 10));
    await writeTrace(root);
    await captured(() => runTrace(["replay", "--id", "demo", "--root", root], { clientFactory: factory }));
    assert.equal((await captured(() => runTrace(["approve", "--id", "demo", "--root", root]))).value, 0);

    // A hand-edited (or older-tool) manifest asserting a size its own frames do not have.
    // The number is quoted back to operators as "restore the Game view to this", so an
    // unchecked one is a fiction in the one sentence meant to tell them what to do.
    await editManifest(root, (m) => {
      m.frameWidth = W * 4;
      m.frameHeight = H;
    });

    const { value: exit, out } = await captured(() =>
      runTrace(["replay", "--id", "demo", "--root", root], { clientFactory: factory }),
    );
    assert.equal(exit, 2, "an anchor whose stated size is not its frames' size cannot be trusted at grade time");
    assert.match(out, new RegExp(`stamped frame size ${W * 4}x${H} is not the size of the approved frames`));
    assert.equal((await readReport(root)).segments[0]!.captures[0]!.visualStatus, "not-compared");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

/*
 * LITMUS. BREAK, `trace-baseline-manifest.ts` `verifyTraceBaseline`, put the size check back
 * behind the mask branch, where it lived when only masked anchors stamped a size:
 *     -  if (loaded.frameWidth !== undefined && loaded.frameHeight !== undefined) {
 *     +  if ((loaded.maskRects?.length ?? 0) > 0) {
 *   OBSERVED, verbatim:
 *     ✖ a stamped resolution that is NOT the size of the approved frames is a harness fault, not a denominator
 *       AssertionError [ERR_ASSERTION]: an anchor whose stated size is not its frames' size cannot be trusted at grade time
 *
 *       0 !== 2
 *
 *         actual: 0,
 *         expected: 2,
 *         operator: 'strictEqual'
 */
