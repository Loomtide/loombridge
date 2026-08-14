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
 * ───────────────────────── THE FOLLOW-UP, AND WHY IT IS HERE ─────────────────────────
 *
 * The first pass at the above also stamped the RECORD-TIME GAME VIEW SIZE onto the trace
 * (`ReplayTrace.viewport`) and compared it, before the drive, against the anchor's stamped
 * frame size. On a healthy consumer project that note fired on EVERY run:
 *
 *     this demonstration was recorded at 1280x720 but its approved frames are 1024x576.
 *     … set the Game view to 1024x576 first, or approve from this run's report to re-anchor
 *
 * NOTHING HAD BEEN RESIZED. THE TWO NUMBERS ARE NOT THE SAME MEASUREMENT. The recorder read
 * the Game view WINDOW (`ui.get_screen_rects` → `Handles.GetMainGameViewSize()`, 1280x720);
 * a capture is the game camera rendered into an offscreen RenderTexture at the screenshot
 * op's capture width and that window's ASPECT (`ScreenshotCapture.CaptureCameraToTexture`:
 * `width = maxWidth; height = round(width / aspect)`), so every frame in every run and every
 * baseline was 1024x576. The note compared a window against a render target, and the remedy
 * it printed would have had an operator "fix" a working configuration.
 *
 * THE STAMP, ITS PARSER BRANCH AND ITS ONE READER ARE ALL GONE. With the comparison removed
 * the field had no reader at all, which is this repo's most expensive recurring shape.
 *
 * NINE LITMUS-VERIFIED TESTS SHIPPED WITH THAT NOTE AND NONE OF THEM CAUGHT IT, for one
 * reason: EVERY FIXTURE USED THE SAME NUMBER FOR THE WINDOW SIZE AND THE FRAME SIZE. A
 * fixture that cannot tell the two apart cannot fail when the code confuses them. So the
 * fixtures below now hold them APART on purpose (`WINDOW_W`/`WINDOW_H` are never `W`/`H`),
 * and "the healthy differing-numbers case is silent" is a guard in its own right.
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
    // THE WINDOW, AND IT IS NEVER THE FRAME SIZE. This editor reports a Game view of
    // WINDOW_W x WINDOW_H while handing back frames of W x H, which is the shape of a real
    // project (window 1280x720, frames 1024x576: same aspect, different numbers). Every
    // fixture in the first pass of this file used ONE number for both, which is exactly why
    // nine LITMUS-verified tests all stayed green while the code compared them.
    "ui.get_screen_rects": () => ({
      data: { objects: [], viewport: { width: WINDOW_W, height: WINDOW_H, aspect: WINDOW_W / WINDOW_H } },
    }),
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

/**
 * A one-capture trace where the verb expects it.
 *
 * `recordedWindow` writes a `viewport` key onto the FILE, which is what a trace recorded
 * during the hour that field existed looks like on disk. Nothing reads it any more, and the
 * point of being able to write one is to prove that: a legacy key must not be refused, must
 * not resurrect a comparison, and must not reach any operator-facing sentence.
 */
async function writeTrace(root: string, recordedWindow?: { width: number; height: number }): Promise<void> {
  const paths = standardReplayLayout(root);
  await fs.mkdir(paths.replayTraces, { recursive: true });
  await fs.writeFile(
    path.join(paths.replayTraces, "demo.trace.json"),
    JSON.stringify({
      schemaVersion: "0.1",
      id: "demo",
      start: { scene: "Assets/Scenes/Game.unity", reset: "scene-load" },
      input: { backend: "ui-events" },
      ...(recordedWindow ? { viewport: recordedWindow } : {}),
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

/**
 * THE FRAME SIZE: what the capture path renders and what both sides of the pixel gate
 * decode. This is the only resolution the gate is about.
 */
const W = 40;
const H = 24;

/**
 * THE WINDOW SIZE: what `ui.get_screen_rects` reports and what the recorder briefly stamped
 * onto traces. DELIBERATELY DIFFERENT NUMBERS FROM `W`/`H`, and deliberately the same
 * ASPECT, because that is the healthy real-world configuration the deleted note called a
 * mismatch. Any code that reaches for this as a stand-in for the frame size is wrong, and
 * with these constants apart it is wrong LOUDLY instead of silently.
 */
const WINDOW_W = W * 2;
const WINDOW_H = H * 2;

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

    // (e) THE OPERATOR IS TOLD WHAT TO DO, with the number they need. Restoring the view
    // leads; re-approving is named second on purpose (it mints an anchor from frames
    // nothing compared).
    assert.match(out, new RegExp(`taken at ${W * 2}x${H}`));
    assert.match(out, new RegExp(`approved baseline is ${W}x${H}`));
    assert.match(out, new RegExp(`restore the Game view's ASPECT to the approved frames' \\(${W}x${H}\\)`));
    assert.match(out, /harness fault, not (a game defect|drift)/);
    // …and the remedy still leads with restoring rather than with re-approving, because an
    // operator staring at a red gate reaches for the command that makes it green.
    assert.ok(
      out.indexOf("restore the Game view's ASPECT") < out.indexOf("trace approve --id demo"),
      "restoring is named before re-anchoring",
    );

    // (f) AND THE APPROVED NUMBER IS NAMED AS A FRAME SIZE, NEVER AS A WINDOW SIZE TO TYPE
    // IN. This is the half of the fix the deleted pre-drive note got backwards: a capture is
    // the camera rendered at a fixed capture width and the Game view's ASPECT, so the
    // approved size is a render-target size that any Game view of that shape reproduces.
    // Telling an operator to set their Game view to it reads as precise and teaches exactly
    // the confusion that produced the false warning.
    assert.doesNotMatch(out, /set the (Unity )?Game view (back )?to \d+x\d+/, "the frame size is not a window size");
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
 *
 * LITMUS for (f), the frame-size-is-not-a-window-size half. BREAK, restore PR #94's remedy
 * prose (`git checkout c373d08 -- src/capabilities/replay/`), which told the operator to
 * type the FRAME size into the Game view. OBSERVED, verbatim:
 *
 *     ✖ THE REPRODUCTION: a resized Game view is a HARNESS FAULT that names both resolutions, never drift
 *       AssertionError [ERR_ASSERTION]: The input did not match the regular expression
 *       /restore the Game view's ASPECT to the approved frames' \(40x24\)/. Input:
 *
 *       "…[loombridge trace] the Game view is not the size this anchor was approved at (harness fault,
 *         not a game defect): 1 capture(s) were taken at 80x24, the approved frames are 40x24. …\n
 *         [loombridge trace]   set the Unity Game view back to 40x24 and re-run `loombridge trace
 *         replay --id demo`. …"
 *
 *         expected: /restore the Game view's ASPECT to the approved frames' \(40x24\)/,
 *         operator: 'match'
 *
 *   Both halves of the run still name both resolutions there, which is why (f) is a separate
 *   assertion: the numbers were right and the SENTENCE taught the confusion that produced
 *   the false pre-drive warning. "Set the Game view to 40x24" happens to work (a capture is
 *   `maxWidth` wide, so a window at the frame size has the frame's aspect), and that is
 *   exactly what makes it dangerous prose: it reads as an identity rather than a
 *   coincidence.
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
 *   re-derives the size, never inherits it": undefined !== 48) and the differing-numbers
 *   guard in §6, whose fixture asserts the anchor is stamped at the FRAME size before it
 *   can say anything about the window size being held apart from it.
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

// ───────── 5. a trace records NO resolution, and the recorder does not ask for one ─────────

test("the recorder RECORDS NO RESOLUTION: no Game view read, no field on the trace", async () => {
  // This editor WOULD answer with a Game view size. The guard is that nobody asks it.
  const calls: string[] = [];
  const send: BridgeSend = async (command, params) => {
    calls.push(command);
    const data: Record<string, Record<string, unknown>> = {
      "ui.get_screen_rects": { viewport: { width: WINDOW_W, height: WINDOW_H, aspect: WINDOW_W / WINDOW_H } },
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

  // (a) THE ROUND TRIP IS GONE FROM THE RECORDING SPINE. It used to land between the reset
  // and the observation purely to stamp a number nothing could honestly use, and it spent
  // that trip on the main thread in the moment before a human starts performing.
  assert.ok(
    !calls.includes("ui.get_screen_rects"),
    "a recording does not read the Game view size: the window is not the frame size",
  );

  // (b) AND NOTHING LANDS ON THE TRACE. Asserted on the KEYS rather than on the value, so
  // an explicit `viewport: undefined` (which serialises away and reads as absent) cannot
  // pass this: the field is gone, not blanked.
  assert.ok(
    !Object.keys(trace).includes("viewport"),
    "the trace states no resolution at all",
  );
  assert.doesNotMatch(JSON.stringify(trace), /viewport/, "…and none reaches the file either");
});

/*
 * LITMUS. BREAK, `observe-record-live.ts`, put the record-time read and the stamp back,
 * which is the code that shipped in PR #94:
 *     +  const viewport = await driver.recordedViewport();
 *     +  if (viewport !== null) meta = { ...meta, viewport };
 *   (with `recordedViewport()` restored on `UnityDriver`, `ObserveTraceMeta.viewport`
 *   restored, and `observedClicksToTrace` spreading it onto the trace again).
 *   OBSERVED (node --test, against `git checkout c373d08 -- src/capabilities/replay/`, i.e.
 *   PR #94's code verbatim), verbatim:
 *
 *     ✖ the recorder RECORDS NO RESOLUTION: no Game view read, no field on the trace
 *       AssertionError [ERR_ASSERTION]: a recording does not read the Game view size: the window is not the frame size
 *
 *         actual: false,
 *         expected: true,
 *         operator: '=='
 */

test("a LEGACY trace carrying a `viewport` key still parses, and the key is DROPPED rather than honoured", () => {
  // Traces recorded during the hour `viewport` existed carry the record-time WINDOW size.
  // They are on disk on real projects, so parsing them must not refuse…
  const legacy = parseTrace({
    schemaVersion: "0.1",
    id: "demo",
    start: { scene: "Assets/Scenes/Game.unity", reset: "scene-load" },
    input: { backend: "ui-events" },
    viewport: { width: WINDOW_W, height: WINDOW_H },
    segments: [{ id: "s", actions: [] }],
    outcome: { expected: "success" },
  });
  // …and must not carry the number forward, because `parseTrace` REBUILDS the trace field
  // by field and anything it hands on is something a later reader may reach for. A window
  // size sitting next to frame sizes is how the false warning happened in the first place.
  assert.ok(!Object.keys(legacy).includes("viewport"), "the legacy key is dropped, not carried");

  // AND A MALFORMED ONE IS NOT A REFUSAL EITHER. The parser used to validate this field
  // (two positive integers) and throw otherwise. A parse-time refusal bound to a field
  // NOTHING CONSUMES is a gate with no subject: it can only ever brick a trace over a value
  // that changes no verdict. Refusals belong on fields that grade something.
  for (const bad of [{ width: WINDOW_W }, { width: "1280", height: 720 }, { width: 0, height: 720 }, "1280x720"]) {
    assert.doesNotThrow(
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
      `a legacy viewport ${JSON.stringify(bad)} must not brick a trace over a field nothing reads`,
    );
  }
});

/*
 * LITMUS. BREAK, `parse.ts`, restore the validating branch PR #94 shipped:
 *     +  const viewport = parseViewport(root.viewport);
 *     +  ...(viewport !== undefined ? { viewport } : {}),
 *   (with `parseViewport` restored.) OBSERVED, verbatim:
 *
 *     ✖ a LEGACY trace carrying a `viewport` key still parses, and the key is DROPPED rather than honoured
 *       AssertionError [ERR_ASSERTION]: the legacy key is dropped, not carried
 *
 *         actual: false,
 *         expected: true,
 *         operator: '=='
 *
 *   The malformed-viewport half fails on the same restored code from the other direction:
 *   `parseViewport` throws `viewport.height must be a positive integer` for `{ width: 80 }`,
 *   i.e. a refusal bound to a field nothing consumes.
 */

// ───────── 6. THE FALSE POSITIVE: the window size is not the frame size ─────────

/*
 * THE GUARD THAT WOULD HAVE CAUGHT PR #94, and the reason it did not exist: every fixture
 * in that PR used ONE number for the Game view WINDOW and for the rendered FRAME, so a
 * comparison between the two was green by construction. This one holds them apart.
 */
test("A RECORD-TIME WINDOW SIZE THAT DIFFERS FROM THE FRAME SIZE IS HEALTHY: no warning, no fault, exit 0", async () => {
  // THE FIXTURE'S OWN ASSUMPTION, ASSERTED. If a later edit collapses these onto one
  // number, this test stops being able to fail for the reason it exists and says so here
  // rather than by silently passing.
  assert.notEqual(`${WINDOW_W}x${WINDOW_H}`, `${W}x${H}`, "the window and the frame must be different numbers");

  const root = await tmpRoot();
  try {
    // The live consumer shape, exactly: the editor reports a Game view of WINDOW_W x
    // WINDOW_H (`scriptedClient`'s `ui.get_screen_rects`), the trace on disk states that
    // same window size the way a trace recorded during PR #94's hour does, and every frame
    // the capture path returns is W x H, because a capture is rendered at the screenshot
    // op's capture width and the view's ASPECT. 1280x720 window, 1024x576 frames.
    const factory = scriptedClient(() => png(W, H, 10));
    await writeTrace(root, { width: WINDOW_W, height: WINDOW_H });
    await captured(() => runTrace(["replay", "--id", "demo", "--root", root], { clientFactory: factory }));
    assert.equal((await captured(() => runTrace(["approve", "--id", "demo", "--root", root]))).value, 0);

    // THE FIXTURE IS NON-VACUOUS: the anchor really is stamped at the FRAME size while the
    // trace really does state the WINDOW size, so the two quantities are both present and
    // are different. A comparison between them has something to be wrong about.
    const manifest = await readManifest(root);
    assert.equal(manifest.frameWidth, W, "the anchor is stamped at the frame size");
    assert.equal(manifest.frameHeight, H);
    const onDisk = await fs.readFile(
      path.join(standardReplayLayout(root).replayTraces, "demo.trace.json"),
      "utf8",
    );
    assert.match(onDisk, new RegExp(`"viewport":\\{"width":${WINDOW_W},"height":${WINDOW_H}\\}`));

    // NOTHING WAS RESIZED, so the run is an ordinary green run.
    const { value: exit, out } = await captured(() =>
      runTrace(["replay", "--id", "demo", "--root", root], { clientFactory: factory }),
    );
    assert.equal(exit, 0, out);

    const report = await readReport(root);
    assert.equal(report.segments[0]!.captures[0]!.visualStatus, "match", "the frames match, because they do");
    assert.equal(report.comparisonsPerformed, 1, "the run really graded, rather than being waved through");
    assert.notEqual(report.visualHarnessFault, true, "a healthy setup is not a harness fault");
    assert.equal(report.visualHarnessFaultReason, undefined);

    // AND THE OPERATOR IS NOT WARNED ABOUT A RESIZE THAT DID NOT HAPPEN. The window's
    // numbers must not appear anywhere in the run's output: the only place they could come
    // from is code treating them as a frame size.
    assert.doesNotMatch(out, new RegExp(`${WINDOW_W}x${WINDOW_H}`), "the window size is never quoted as a resolution");
    assert.doesNotMatch(out, /recorded at/, "no pre-drive resolution note fires on a healthy project");
    assert.doesNotMatch(out, /harness fault/i);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

/*
 * LITMUS, BY REINTRODUCING THE COMPARISON PR #94 SHIPPED. `trace.ts`, restore
 * `announceViewportMismatch` and call it from `replayOneTrace` with the trace's recorded
 * window size (`parse.ts` carrying `viewport` forward again, per BREAK 5 above):
 *
 *     +async function announceViewportMismatch(paths, id, recorded) {
 *     +  if (recorded === undefined) return;
 *     +  const manifest = await loadTraceBaselineManifest(path.join(paths.replayBaselines, id));
 *     +  if (manifest === null || isTraceBaselineManifestError(manifest)) return;
 *     +  const { frameWidth, frameHeight } = manifest;
 *     +  if (frameWidth === undefined || frameHeight === undefined) return;
 *     +  if (frameWidth === recorded.width && frameHeight === recorded.height) return;
 *     +  console.error(
 *     +    `[loombridge trace] this demonstration was recorded at ${recorded.width}x${recorded.height} but its ` +
 *     +      `approved frames are ${frameWidth}x${frameHeight}. …`,
 *     +  );
 *     +}
 *     +  await announceViewportMismatch(paths, id, trace.viewport);
 *
 *   In practice the whole of PR #94's replay source restores it in one step:
 *   `git checkout c373d08 -- src/capabilities/replay/`.
 *
 *   OBSERVED (node --test, over the real CLI door), verbatim:
 *
 *     ✖ A RECORD-TIME WINDOW SIZE THAT DIFFERS FROM THE FRAME SIZE IS HEALTHY: no warning, no fault, exit 0
 *       AssertionError [ERR_ASSERTION]: the window size is never quoted as a resolution
 *
 *         actual: "[loombridge trace] capture-aligned replay at 60 fps: each settle runs inside the
 *           bridge's pinned tick loop and the frame is taken on the frame the settle completes.\n
 *           [loombridge trace] this demonstration was recorded at 80x48 but its approved frames are
 *           40x24. If the Game view is still at the recorded size, the pixel gate will refuse this run
 *           as a harness fault (frames of different sizes share no pixels); set the Game view to 40x24
 *           first, or approve from this run's report to re-anchor at the new size.\n
 *           [loombridge trace] physics steps 5 times every 6 frame(s) at 60 fps (fixedDeltaTime 0.02);
 *           feel-sensitive traces may differ from the recording\n
 *           [loombridge trace] demo: PASS\n
 *           [loombridge trace]   pixel gate: 1 of 1 approved frame(s) compared.\n…",
 *         expected: /80x48/,
 *         operator: 'doesNotMatch'
 *
 *   THAT IS THE SHIPPED DEFECT, REPRODUCED, and read the two lines together: `demo: PASS`,
 *   `1 of 1 approved frame(s) compared`, and above them an instruction to go resize a Game
 *   view that was never wrong. The real gate stayed correctly silent (the frames match,
 *   because they do); only the note fired. On PR #94's own fixtures that same code was
 *   silent, because there `recorded.width` and `frameWidth` were the same number by
 *   construction, which is the whole reason nine LITMUS-verified tests missed it.
 */
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
