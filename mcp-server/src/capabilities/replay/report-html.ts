/**
 * Replay Verification — static HTML report renderer (product surface).
 *
 * `renderReplayReportHtml(artifact, captures)` is a PURE function: given a replay
 * report and the capture images (already base64-encoded by the caller), it
 * returns a single self-contained HTML document (images inlined as data URIs, no
 * external assets). This is the "only UI the slice ships" — a local file, no
 * server. Kept pure (no fs, no Date) so it is fully unit-testable.
 */

import type { MaskRect } from "./visual-diff.js";
import type { ReplayRunArtifact } from "./types.js";

export interface CaptureImage {
  id: string;
  segment: string;
  /** Actual PNG bytes as base64 for a `data:` URI, or undefined when the file is missing. */
  base64?: string;
  /** Approved baseline PNG as base64, when one exists. */
  baselineBase64?: string;
  /**
   * Visual verdict vs the baseline (`unreadable` = a capture gap, not drift;
   * `not-compared` = the anchor was untrusted, so nothing graded this frame).
   *
   * ABSENT IS RENDERED, NOT SKIPPED. A capture with a frame and no verdict is a frame
   * nothing compared, and the page says exactly that: see {@link captureFigure}.
   */
  visualStatus?: "match" | "drift" | "no-baseline" | "unreadable" | "not-compared";
  /** Why the harness lost this capture, when it did (`CaptureResult.harnessFault`). */
  harnessFault?: string;
  /** Fraction of perceptually-differing pixels, in [0,1]. */
  diffFraction?: number;
  /**
   * The approved masks in force for THIS capture, drawn on both thumbnails. A blanked
   * region is invisible in a "match": the outline is what stops a reader concluding the
   * frames agree everywhere, when in fact part of the frame was never compared.
   */
  masks?: readonly MaskRect[];
  /** Fraction of this frame the masks blanked, in [0,1]. */
  maskedFraction?: number;
}

/** Report-wide facts the header needs, none of which live on the artifact. */
export interface ReportChrome {
  /** The frame size the mask rects are expressed in; without it nothing is drawn. */
  frameWidth?: number;
  frameHeight?: number;
  /** The ONE combined consent sentence for this anchor's terms, when there is one. */
  anchorTerms?: string | null;
  /**
   * sha256 of the EXACT `<id>.report.json` bytes this page was rendered from.
   *
   * The HTML is the artifact a human actually opens, and it sits on disk next to a JSON
   * verdict that a LATER run can rewrite. Two artifacts that can silently disagree is the
   * failure this stamp exists to end: with it, "is this page the run whose verdict I was
   * just shown?" is answerable by hashing the JSON beside it, instead of by trusting an
   * mtime. Absent only for a caller that has no bytes to bind to (nothing in-tree).
   */
  sourceReportSha256?: string;
}

/** The `<meta>` name the source-report binding is published under. */
export const SOURCE_REPORT_SHA_META = "loombridge-source-report-sha256";

/** A sha we are willing to put in an HTML attribute: 64 lowercase hex, nothing else. */
const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * Read back the source-report binding {@link renderReplayReportHtml} stamped.
 *
 * The reader half of the stamp, kept here beside the writer so the two cannot drift
 * apart. A caller holding the report JSON's bytes compares this against their sha256:
 * equal means the page and the verdict describe the same run, different (or absent)
 * means the page is stale and must not be read as this run's evidence.
 */
export function sourceReportSha256Of(html: string): string | undefined {
  const match = new RegExp(`<meta name="${SOURCE_REPORT_SHA_META}" content="([0-9a-f]{64})"`).exec(html);
  return match?.[1];
}

const STATUS_COLOR: Record<string, string> = {
  pass: "#1a7f37",
  fail: "#cf222e",
  blocked: "#9a6700",
};

const STATUS_CLASSES: ReadonlySet<string> = new Set([
  "pass",
  "fail",
  "blocked",
  "not_reached",
]);

/**
 * Map a status string to a FIXED css class. A report rendered by `trace report`
 * comes from an unvalidated on-disk JSON, so the status could be attacker-shaped;
 * emitting only whitelisted class names means no untrusted value ever reaches an
 * HTML attribute (the displayed text is still `esc()`'d separately).
 */
export function statusClass(status: string): string {
  return STATUS_CLASSES.has(status) ? `status-${status}` : "status-unknown";
}

const VSTATUS_CLASSES: ReadonlySet<string> = new Set([
  "match",
  "drift",
  "no-baseline",
  "unreadable",
  "not-compared",
]);

/**
 * The badge this page leads with, and the sentence under it.
 *
 * BX2, AT THE SURFACE A HUMAN ACTUALLY OPENS. `artifact.status` answers one question ("did
 * the actuation diverge?") and it is honestly `pass` for a run whose frames nothing could
 * compare. That run exits 2. The console summary has stated the worst tier since the
 * aligned slice; this page did not, and the gap was a real false green on a consumer
 * project: a green PASS badge over fifteen frames the pixel gate had refused to grade,
 * with nothing on the page saying so. The verdict word and the exit code now agree, and
 * the actuation result is named INSIDE the harness-fault sentence rather than replaced by
 * it, so no fact is lost.
 *
 * Exported so a test can pin the mapping without parsing HTML.
 */
export function reportVerdict(
  artifact: Pick<
    ReplayRunArtifact,
    | "status"
    | "visualHarnessFault"
    | "visualHarnessFaultReason"
    | "comparisonsExpected"
    | "comparisonsPerformed"
  >,
): { badge: string; color: string; note?: string } {
  // The page reads the coverage numbers for itself rather than trusting the flag, exactly
  // as `replayExitCode` does: `trace report` renders from an on-disk JSON that a hand edit
  // can strip a boolean out of, and the badge must not be the one surface that believes it.
  const expected = artifact.comparisonsExpected;
  const short =
    typeof expected === "number" && expected > 0 && (artifact.comparisonsPerformed ?? 0) < expected;
  if (artifact.visualHarnessFault || short) {
    const why = artifact.visualHarnessFaultReason
      ? ` Reason: ${artifact.visualHarnessFaultReason}.`
      : " The reason was not recorded in this report; re-run to capture it.";
    // The coverage is quoted whenever the report carries it, because "0 of 15" and "14 of
    // 15" are different situations and the sentence must not flatten them.
    const coverage =
      typeof expected === "number"
        ? ` Pixel gate coverage: ${artifact.comparisonsPerformed ?? 0} of ${expected} approved frame(s) compared.`
        : "";
    return {
      badge: "HARNESS FAULT",
      // The `blocked` amber, because that is this vocabulary's "no verdict was produced",
      // which is exactly what an ungraded capture leaves behind (the fleet roll-up maps a
      // harness fault onto `blocked` for the same reason).
      color: STATUS_COLOR.blocked!,
      note:
        `Actuation ${artifact.status}, but this run holds NO opinion about the frames it did not ` +
        `compare against an approved baseline: never a pass, never drift.${why}${coverage}`,
    };
  }
  return { badge: artifact.status.toUpperCase(), color: STATUS_COLOR[artifact.status] ?? "#57606a" };
}

/** Whitelist the visual-status css class (same trust boundary as `statusClass`). */
function vstatusClass(visualStatus: string): string {
  return VSTATUS_CLASSES.has(visualStatus) ? `vstatus-${visualStatus}` : "vstatus-none";
}

export function renderReplayReportHtml(
  artifact: ReplayRunArtifact,
  captures: CaptureImage[],
  chrome: ReportChrome = {},
): string {
  const verdict = reportVerdict(artifact);
  const color = verdict.color;
  const blocked = artifact.blockedReason ? ` (${esc(artifact.blockedReason)})` : "";
  const harnessBanner = verdict.note ? `<div class="fault">${esc(verdict.note)}</div>` : "";

  const divergence = artifact.firstDivergence
    ? section(
        "First divergence",
        `<table class="kv">
          <tr><td>kind</td><td><code>${esc(artifact.firstDivergence.kind)}</code></td></tr>
          <tr><td>segment</td><td><code>${esc(String(artifact.firstDivergence.segment))}</code></td></tr>
          <tr><td>step</td><td><code>${esc(String(artifact.firstDivergence.step ?? "-"))}</code></td></tr>
          <tr><td>expected</td><td>${esc(artifact.firstDivergence.expected)}</td></tr>
          <tr><td>actual</td><td>${esc(artifact.firstDivergence.actual)}</td></tr>
        </table>`,
      )
    : "";

  const segmentsRows = artifact.segments
    .map(
      (s) => `<tr>
        <td><code>${esc(s.id)}</code></td>
        <td class="${statusClass(s.status)}">${esc(s.status)}</td>
        <td>${s.anchorsReached.map((a) => `<code>${esc(a)}</code>`).join(", ") || "—"}</td>
        <td>${s.captures.map((c) => esc(c.id)).join(", ") || "—"}</td>
      </tr>`,
    )
    .join("");

  const assertionsRows = artifact.assertions.length
    ? artifact.assertions
        .map(
          (a) =>
            `<tr><td><code>${esc(a.id)}</code></td><td class="${statusClass(a.status)}">${esc(a.status)}</td></tr>`,
        )
        .join("")
    : `<tr><td colspan="2">— none —</td></tr>`;

  const consoleBlock = section(
    "Console",
    `<p class="${statusClass(artifact.console.status)}">${esc(artifact.console.status)} · ${artifact.console.errorCount} error(s)</p>` +
      (artifact.console.errors.length
        ? `<ul>${artifact.console.errors.map((e) => `<li><code>${esc(e)}</code></li>`).join("")}</ul>`
        : ""),
  );

  const gallery = captures.length
    ? captures.map((c) => captureFigure(c, chrome)).join("")
    : `<p>— no captures —</p>`;

  // THE COMBINED CONSENT, IN THE HEADER (Q7). The gallery shows two frames side by side
  // and invites the eye to conclude they agree; the terms under which that conclusion was
  // reached belong above the pictures, not in a terminal the reader no longer has.
  const terms = chrome.anchorTerms
    ? `<div class="terms">anchor terms: ${esc(chrome.anchorTerms)}</div>`
    : "";

  // THE BINDING TO THE VERDICT THIS PAGE RENDERS (see `ReportChrome.sourceReportSha256`).
  // Machine-readable in the head and legible in the header, because both readers exist: a
  // guard hashing the JSON beside it, and a human who wants to know the page is not a
  // leftover. An unparseable value is dropped rather than escaped into the attribute:
  // `trace report` renders from an unvalidated on-disk JSON, so nothing shaped by that
  // file may reach an attribute (the same trust boundary `statusClass` draws).
  const sourceSha = chrome.sourceReportSha256 && SHA256_HEX.test(chrome.sourceReportSha256)
    ? chrome.sourceReportSha256
    : undefined;
  const shaMeta = sourceSha ? `\n<meta name="${SOURCE_REPORT_SHA_META}" content="${sourceSha}" />` : "";
  const shaLine = sourceSha
    ? `<div class="meta">rendered from <code>${esc(artifact.traceId)}.report.json</code> ` +
      `sha256 <code>${sourceSha}</code></div>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />${shaMeta}
<title>Replay report: ${esc(artifact.traceId)}</title>
<style>
  :root { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #1f2328; }
  body { margin: 0 auto; max-width: 980px; padding: 24px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .badge { display: inline-block; color: #fff; padding: 2px 10px; border-radius: 12px; font-weight: 600; font-size: 13px; background: ${color}; }
  .meta { color: #57606a; font-size: 13px; margin: 8px 0 20px; }
  section { border: 1px solid #d0d7de; border-radius: 8px; padding: 12px 16px; margin: 16px 0; }
  section h2 { font-size: 14px; text-transform: uppercase; letter-spacing: .04em; color: #57606a; margin: 0 0 8px; }
  table { border-collapse: collapse; width: 100%; font-size: 14px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #eaeef2; vertical-align: top; }
  table.kv td:first-child { color: #57606a; width: 110px; }
  code { background: #f6f8fa; padding: 1px 5px; border-radius: 4px; font-size: 12px; }
  .status-pass { color: #1a7f37; font-weight: 600; }
  .status-fail, .status-not_reached { color: #cf222e; font-weight: 600; }
  .status-blocked { color: #9a6700; font-weight: 600; }
  .status-unknown { color: #57606a; font-weight: 600; }
  .gallery { display: grid; grid-template-columns: 1fr; gap: 16px; }
  figure { margin: 0; border: 1px solid #d0d7de; border-radius: 8px; overflow: hidden; }
  .frames { display: flex; gap: 1px; background: #d0d7de; }
  .frame { flex: 1; position: relative; background: #fff; }
  .frame img { width: 100%; display: block; }
  .frame span { position: absolute; top: 4px; left: 4px; font-size: 11px; background: rgba(0,0,0,.6); color: #fff; padding: 1px 6px; border-radius: 4px; }
  figcaption { padding: 8px; font-size: 12px; color: #57606a; }
  .missing { padding: 40px; text-align: center; color: #cf222e; background: #fff5f5; }
  .vstatus { font-weight: 600; padding: 1px 6px; border-radius: 10px; font-size: 11px; }
  .vstatus-match { color: #1a7f37; background: #eaffea; }
  .vstatus-drift { color: #cf222e; background: #fff5f5; }
  .vstatus-none { color: #57606a; background: #f6f8fa; }
  .vstatus-unreadable { color: #9a6700; background: #fff8c5; }
  .vstatus-not-compared { color: #9a6700; background: #fff8c5; }
  .gate-full { color: #1a7f37; background: #eaffea; }
  .gate-short { color: #9a6700; background: #fff8c5; }
  .fault { font-size: 13px; color: #7d4e00; background: #fff8c5; border: 1px solid #d4a72c; border-radius: 6px; padding: 8px 10px; margin: 0 0 16px; }
  .terms { font-size: 13px; color: #9a6700; background: #fff8c5; border-radius: 6px; padding: 6px 10px; margin: 0 0 16px; }
  .mask { position: absolute; border: 2px dashed #bf3989; background: rgba(191,57,137,.12); box-sizing: border-box; pointer-events: none; }
  .mask b { position: absolute; bottom: 100%; left: 0; font-size: 10px; font-weight: 600; color: #fff; background: #bf3989; padding: 0 4px; border-radius: 3px 3px 0 0; white-space: nowrap; }
</style>
</head>
<body>
  <h1>${esc(artifact.traceId)} <span class="badge">${esc(verdict.badge)}${blocked}</span></h1>
  <div class="meta">
    reset: <code>${esc(String(artifact.resetTier ?? "none"))}</code> ·
    ${esc(artifact.startedAt)} → ${esc(artifact.finishedAt)} · ${artifact.durationMs} ms${
      artifact.visualDrift ? ` · <span class="vstatus vstatus-drift">visual drift</span>` : ""
    }${coverageLine(artifact)}
  </div>
  ${shaLine}
  ${harnessBanner}
  ${terms}
  ${divergence}
  ${section("Segments", `<table><thead><tr><th>segment</th><th>status</th><th>anchors reached</th><th>captures</th></tr></thead><tbody>${segmentsRows}</tbody></table>`)}
  ${section("Assertions", `<table><tbody>${assertionsRows}</tbody></table>`)}
  ${consoleBlock}
  ${section("Captures", `<div class="gallery">${gallery}</div>`)}
</body>
</html>
`;
}

/**
 * "pixel gate: 15 of 15 approved frame(s) compared", in the header meta, on EVERY anchored
 * run including a green one.
 *
 * A green page is exactly where this number does the work: it is what turns "PASS" from an
 * assertion into a measured claim, and its absence is what let a page that compared none
 * of its fifteen approved frames look identical to one that compared all of them. Absent
 * only when there is no stamped anchor, where there is no denominator to state.
 */
function coverageLine(
  artifact: Pick<ReplayRunArtifact, "comparisonsExpected" | "comparisonsPerformed">,
): string {
  if (typeof artifact.comparisonsExpected !== "number") return "";
  const performed = artifact.comparisonsPerformed ?? 0;
  // ITS OWN CLASS NAMES, not the per-capture `vstatus-match` / `vstatus-not-compared`.
  // These are a RUN-level count, and reusing a capture verdict's class would make "the page
  // contains a matched capture" and "the page states full coverage" indistinguishable to
  // any reader keyed on the class, tests included.
  const klass = performed < artifact.comparisonsExpected ? "gate-short" : "gate-full";
  return (
    ` · <span class="vstatus ${klass}">pixel gate: ${performed} of ${artifact.comparisonsExpected}` +
    ` approved frame(s) compared</span>`
  );
}

function captureFigure(c: CaptureImage, chrome: ReportChrome): string {
  const overlay = maskOverlay(c, chrome);
  const frame = (b64: string | undefined, label: string): string =>
    b64
      ? `<div class="frame"><img alt="${esc(c.id)} ${label}" src="data:image/png;base64,${b64}" /><span>${label}</span>${overlay}</div>`
      : `<div class="frame missing">${label} missing</div>`;

  const hasBaseline = c.visualStatus === "match" || c.visualStatus === "drift";
  const frames = hasBaseline
    ? `${frame(c.baselineBase64, "baseline")}${frame(c.base64, "actual")}`
    : frame(c.base64, "actual");

  // EVERY FIGURE CARRIES A VERDICT, INCLUDING "nobody graded this one".
  //
  // The bound field is `visualStatus`, and the old shape (`else if (c.visualStatus)`) is
  // the anti-pattern this repo refuses by name: a falsy value SKIPPED the label, so the
  // frame rendered under a green page with no chip at all and read as unremarkable. The
  // absence is precisely the interesting case, because it is what a refused pixel gate
  // leaves behind, so it is now the loudest one. `harnessFault` names the cause when the
  // capture step itself is what failed.
  let visual: string;
  if (c.visualStatus === "no-baseline") {
    visual = `<span class="vstatus vstatus-none">no baseline</span>`;
  } else if (c.visualStatus === undefined) {
    const why = c.harnessFault ? `: ${c.harnessFault}` : "";
    visual = `<span class="vstatus vstatus-not-compared">not compared${esc(why)}</span>`;
  } else {
    const pct = c.diffFraction !== undefined ? ` · ${(c.diffFraction * 100).toFixed(2)}%` : "";
    visual = `<span class="vstatus ${vstatusClass(c.visualStatus)}">${esc(c.visualStatus)}${pct}</span>`;
  }
  const masked =
    c.maskedFraction !== undefined && c.maskedFraction > 0
      ? ` · <span class="vstatus vstatus-none">${(c.maskedFraction * 100).toFixed(2)}% masked</span>`
      : "";

  return `<figure>
    <div class="frames">${frames}</div>
    <figcaption><code>${esc(c.id)}</code> · segment <code>${esc(c.segment)}</code> ${visual}${masked}</figcaption>
  </figure>`;
}

/**
 * The mask rects, drawn over BOTH thumbnails as percentage-positioned outlines.
 *
 * Percentages rather than pixels because the thumbnails are `width: 100%` of a
 * responsive column, so a pixel offset would be wrong at every size but one. Nothing is
 * drawn without the frame dimensions: a rect positioned against an unknown frame would
 * be an outline pointing at the wrong pixels, which is worse than no outline at all.
 */
function maskOverlay(c: CaptureImage, chrome: ReportChrome): string {
  const W = chrome.frameWidth ?? 0;
  const H = chrome.frameHeight ?? 0;
  if (!c.masks?.length || !(W > 0) || !(H > 0)) return "";
  return c.masks
    .map((m) => {
      const style =
        `left:${pct(m.x / W)};top:${pct(m.y / H)};width:${pct(m.w / W)};height:${pct(m.h / H)}`;
      return `<div class="mask" style="${esc(style)}"><b>masked: ${esc(m.reason)}</b></div>`;
    })
    .join("");
}

/** A clamped percentage with two decimals: never emits an attacker-shaped style value. */
function pct(fraction: number): string {
  const safe = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0;
  return `${(safe * 100).toFixed(2)}%`;
}

function section(title: string, body: string): string {
  return `<section><h2>${esc(title)}</h2>${body}</section>`;
}

export function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
