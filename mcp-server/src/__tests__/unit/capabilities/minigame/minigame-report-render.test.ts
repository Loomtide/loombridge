/**
 * S7b — partner-facing human report renderer (`minigame-report-render.ts`).
 *
 * The load-bearing guarantee under test: the renderer makes the report LEGIBLE
 * without blurring the S6d/S6e moats —
 *   - a capture/harness gap renders in its own "couldn't be tested — fix the test
 *     setup, not the game" section, NEVER under "must fix" (it is exit 2, not a defect);
 *   - baseline drift renders in its own "looks different — re-approve" section, NEVER
 *     as a bug, and never inside the must-fix block;
 *   - everything speaks product language (no raw gate ids in the human copy).
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  annotatedTitle,
  backgroundCandidatesFor,
  backgroundContainerCandidates,
  backgroundDeclareGroups,
  backgroundSuggestionText,
  bannerFor,
  fixCopy,
  groupFindingsByDevice,
  harnessFlowSentence,
  humanizeFinding,
  humanizeGrouped,
  overflowPx,
  partitionBackgroundCandidates,
  regionName,
  renderMinigameReportHtml,
  renderMinigameReportMarkdown,
  whereCopy,
} from "../../../../capabilities/minigame/minigame-report-render.js";
import {
  buildCrGroups,
  type MinigameDeviceTag,
  type MinigameFinding,
  type MinigameFlatCheck,
  type MinigameVerifyReport,
} from "../../../../capabilities/minigame/verify-minigame.js";
import { makeGateReport, type GateCheckAnnotation, type GateReport } from "../../../../capabilities/verification/gates/types.js";

/** A fully-formed report with sane defaults; override only what a case needs. */
function baseReport(over: Partial<MinigameVerifyReport>): MinigameVerifyReport {
  return {
    kind: "minigame-verification",
    schemaVersion: "1",
    producedAt: "2026-06-07T00:00:00Z",
    contract: {
      id: "demo-game",
      title: "Demo Game",
      type: "2d-kids-minigame",
      ageBand: "5-7",
      ageBandLabel: "Early elementary (5–7)",
      visualProfile: "phone-portrait",
      visualProfileLabel: "Phone portrait (9:16)",
      scenes: ["Assets/Scenes/Demo.unity"],
      requiredLocators: [],
    },
    capturesDir: "captures",
    status: "pass",
    states: {},
    gatesByState: {},
    summary: { statesTotal: 4, statesGraded: 4, checksTotal: 8, pass: 8, warn: 0, fail: 0, notApplicable: 0 },
    failures: [],
    notApplicable: [],
    captureAbsent: [],
    outcomeGated: [],
    cr: { blockingFailures: [], baselineRegressions: [], incompleteHarness: [], warnings: [], passedGates: {}, advisoryNotes: [], notAssertedOutcomeGated: [] },
    statePaths: {},
    deviceLabels: {},
    headline: "headline",
    nextAction: "next action",
    ...over,
  };
}

const gateFail = (state: string, gate: string, obj: string): MinigameFlatCheck => ({
  state,
  gate,
  id: `${gate}.${obj}`,
  expected: "visible",
  actual: "offScreen",
  detail: `${obj} not visible`,
});

test("an outcome-gated state renders in its OWN 'not asserted' section with the gated wording, not the harness sentence", () => {
  const flow = {
    outcome: "pass" as const,
    transitions: [
      { transition: "active → success_reward", from: "active", to: "success_reward", expectedState: "success_reward",
        status: "outcome_gated" as const, actualEvidence: "'success_reward' is outcome-gated",
        detail: "'active → success_reward' reaches an outcome-gated state — read-only can't drive the win.", nextAction: "leave outcomeGated set" },
    ],
  };
  const cr = buildCrGroups({}, [], [], [], flow, undefined, ["success_reward"]);
  const report = baseReport({ status: "pass", outcomeGated: ["success_reward"], cr, flow });

  const html = renderMinigameReportHtml(report);
  const md = renderMinigameReportMarkdown(report);

  for (const out of [html, md]) {
    assert.match(out, /Not asserted \(outcome-gated\)/i, "the dedicated section heading");
    assert.match(out, /outcome-gated/i, "the gated finding's own detail");
    // It must NEVER borrow the harness-fault wording — that would wrongly imply a test-setup bug.
    assert.doesNotMatch(out, /didn't register honestly/i);
    assert.doesNotMatch(out, /fix the test setup, not the game/i);
  }
  // It's not a blocker and not a capture gap — the banner is READY.
  assert.doesNotMatch(html, /Must fix before release/);
  assert.match(html, /hero ready/);
  assert.match(html, /Ready to ship/); // hero verdict carries the green status
});

test("a capture/harness gap renders as 'couldn't be tested — not the game', never under 'must fix'", () => {
  const cr = buildCrGroups({}, [], [], ["home_back"], undefined);
  const report = baseReport({
    status: "incomplete",
    captureAbsent: ["home_back"],
    cr,
    statePaths: { home_back: { uiRects: "captures/home_back.ui-rects.json", console: "captures/home_back.console.json", png: "captures/home_back.png" } },
  });

  const html = renderMinigameReportHtml(report);
  const md = renderMinigameReportMarkdown(report);

  // It is in the "couldn't be tested" section…
  assert.match(html, /Couldn't be tested/);
  // The harness guarantee now lives in the per-item body sentence (capital "Fix…"), not the heading.
  assert.match(html, /Fix the test setup, not the game/);
  assert.match(html, /Home back/); // the screen, in product language
  assert.match(md, /Couldn't be tested/);
  assert.match(md, /not the game/);

  // …and it is NOT a game defect: there is no "must fix" block at all here.
  assert.doesNotMatch(html, /Must fix before release/);
  assert.doesNotMatch(md, /Must fix before release/);

  // The banner is CAN'T VERIFY (not READY, not NOT READY): tone class + verdict line carry it now.
  assert.match(html, /hero cant-verify/);
  assert.match(html, /Couldn't verify this build/);
  assert.doesNotMatch(html, /hero ready/);
  assert.doesNotMatch(html, /hero not-ready/);

  // The humanized harness sentence never calls it a bug/defect, and reads naturally
  // ("<X> screen was never captured", not "<X> was never captured").
  const harnessFinding = cr.incompleteHarness[0];
  const sentence = humanizeFinding(harnessFinding);
  assert.match(sentence, /screen was never captured/);
  assert.match(sentence, /not the game/);
  assert.doesNotMatch(sentence, /\b(bug|defect)\b/i);
});

test("a flow harness_fault renders as a test-setup gap, not a game defect", () => {
  const flow = {
    outcome: "harness_fault",
    transitions: [
      { transition: "start → active", from: "start", to: "active", expectedState: "active", status: "harness_fault", actualEvidence: "e", detail: "actuated=false", nextAction: "re-capture" },
    ],
  } as unknown as Parameters<typeof buildCrGroups>[4];
  const cr = buildCrGroups({}, [], [], [], flow);
  const report = baseReport({ status: "incomplete", cr, flow: flow as MinigameVerifyReport["flow"] });

  const html = renderMinigameReportHtml(report);
  assert.match(html, /Couldn't be tested/);
  assert.match(html, /Start → active step couldn't be tested/i);
  assert.match(html, /Fix the test setup, not the game/);
  assert.doesNotMatch(html, /Must fix before release/);
});

test("a blocking gate fail renders under 'must fix'; a baseline drift in its OWN section, never blocking", () => {
  const failures = [gateFail("start", "required-in-frame", "startButton")];
  const regressions: MinigameFinding[] = [
    { source: "baseline", state: "success_reward", detail: "drifted 5%", nextAction: "re-approve" },
  ];
  const cr = buildCrGroups({}, failures, [], [], undefined, { regressions, incomplete: [] });
  const report = baseReport({ status: "fail", failures, cr });

  const html = renderMinigameReportHtml(report);

  const iMustFix = html.indexOf("Must fix before release");
  const iLooksDifferent = html.indexOf("Looks different from the approved version");
  const iOffScreen = html.indexOf("off-screen");
  const iDrift = html.indexOf("looks different from the approved version");

  assert.ok(iMustFix >= 0, "has a must-fix section");
  assert.ok(iLooksDifferent >= 0, "has a baseline-drift section");
  // The off-screen game defect sits in the must-fix block (before the drift section).
  assert.ok(iOffScreen > iMustFix && iOffScreen < iLooksDifferent, "game defect is under must-fix, not under drift");
  // The drift sentence sits in (and after) the drift section — never in must-fix.
  assert.ok(iDrift > iLooksDifferent, "drift sentence is in the drift section");
  // Product language: the gate id is humanized, not leaked.
  assert.match(html, /"?Start Button"?[\s\S]*off-screen/i);
  assert.doesNotMatch(html, /required-in-frame\.startButton/);
  assert.match(html, /Not a bug; re-approve if intended/); // drift framing (now in the per-item body sentence)
});

test("a passing report → READY banner, self-contained HTML with an inline thumbnail", () => {
  const states: Record<string, GateReport[]> = {
    start: [makeGateReport("required-in-frame", [{ id: "required-in-frame.startButton", expected: "visible", actual: "visible", status: "pass", detail: "ok" }])],
  };
  const cr = buildCrGroups(states, [], [], [], undefined);
  const report = baseReport({
    status: "pass",
    states,
    cr,
    statePaths: { start: { uiRects: "captures/start.ui-rects.json", console: "captures/start.console.json", png: "captures/start.png" } },
  });
  const thumbs = { start: "data:image/png;base64,AAAABBBB" };

  const html = renderMinigameReportHtml(report, thumbs);
  assert.match(html, /<!doctype html>/);
  assert.match(html, /hero ready/); // green tone class carries the verdict
  assert.match(html, /Ready to ship/); // friendly hero verdict
  assert.match(html, /Required objects visible/); // passed summary in product language (sentence-cased)
  // Self-contained: the thumbnail is inlined, no external image refs.
  assert.match(html, /data:image\/png;base64,AAAABBBB/);
  assert.doesNotMatch(html, /src="https?:/);
});

test("bannerFor maps each status to a stable label + tone", () => {
  assert.deepEqual({ label: bannerFor("pass").label, tone: bannerFor("pass").tone }, { label: "READY", tone: "ready" });
  assert.deepEqual({ label: bannerFor("fail").label, tone: bannerFor("fail").tone }, { label: "NOT READY", tone: "not-ready" });
  assert.deepEqual({ label: bannerFor("incomplete").label, tone: bannerFor("incomplete").tone }, { label: "CAN'T VERIFY", tone: "cant-verify" });
});

test("humanizeFinding maps each per-state gate to product language (no raw ids)", () => {
  const g = (gate: string, obj: string): MinigameFinding => ({ source: "gate", state: "active", gate, id: `${gate}.${obj}`, detail: "raw" });
  assert.match(humanizeFinding(g("required-in-frame", "startButton")), /off-screen or hidden/);
  assert.match(humanizeFinding(g("tap-target-size", "answerButton0")), /too small to tap/);
  assert.match(humanizeFinding(g("safe-area", "scoreChip")), /outside the safe area/);
  // The sweep names the element + reminds that only backgrounds may bleed.
  const sweep = humanizeFinding(g("safe-area-sweep", "countChip"));
  assert.match(sweep, /outside the safe area/);
  assert.match(sweep, /[Oo]nly backgrounds should bleed/);
  assert.doesNotMatch(sweep, /safe-area-sweep/);
  // A frame-level gate has no per-object subject.
  const frame: MinigameFinding = { source: "gate", state: "start", gate: "console-clean", id: "console-clean.start", detail: "raw" };
  assert.match(humanizeFinding(frame), /runtime errors/);
  assert.doesNotMatch(humanizeFinding(frame), /console-clean/);
});

// ── annotated safe-area card (the redesign centerpiece) ──────────────────────────

/** The real CountTheFruits homeButton safe-area failure (left edge), bottom-origin rect. */
const homeButtonAnnotation: GateCheckAnnotation = {
  rect: { x: 0.0218750238, y: 0.03888887, width: 0.1109375, height: 0.15 },
  safeInsets: { top: 0.05, bottom: 0.05, left: 0.04, right: 0.04 },
  overflow: { edge: "left", fraction: 0.018 },
  viewport: { width: 1280, height: 720 },
  locator: "/HUD/HomeButton",
};

/** An answer-button bottom-edge failure (bottom-origin rect near y≈0). */
const answerButtonAnnotation: GateCheckAnnotation = {
  rect: { x: 0.289843738, y: 0.0352220535, width: 0.1234375, height: 0.194444448 },
  safeInsets: { top: 0.05, bottom: 0.05, left: 0.04, right: 0.04 },
  overflow: { edge: "bottom", fraction: 0.015 },
  viewport: { width: 1280, height: 720 },
  locator: "/HUD/AnswerButton0",
};

function safeAreaFinding(annotation: GateCheckAnnotation, obj: string): MinigameFinding {
  return { source: "gate", state: "active", gate: "safe-area", id: `safe-area.${obj}`, detail: "raw", annotation };
}

test("a safe-area finding WITH an annotation draws the safe box + element box (flipped-y top%) and shows the px overflow", () => {
  const failures: MinigameFinding[] = [
    safeAreaFinding(homeButtonAnnotation, "homeButton"),
    safeAreaFinding(answerButtonAnnotation, "answerButton0"),
  ];
  const cr = buildCrGroups({}, [], [], [], undefined);
  cr.blockingFailures = failures;
  const report = baseReport({ status: "fail", cr });
  const thumbs = { active: "data:image/png;base64,AAAA" };

  const html = renderMinigameReportHtml(report, thumbs);

  // The annotated card is rendered (safe + element overlay boxes).
  assert.match(html, /class="safe"/);
  assert.match(html, /class="elem"/);
  // Safe box = the contract insets.
  assert.match(html, /left:4\.00%;right:4\.00%;top:5\.00%;bottom:5\.00%;/);
  // Element box: bottom-origin rect flipped to CSS top. top = 1-(0.0389+0.15) ≈ 0.8111.
  assert.match(html, /top:81\.11%/);
  assert.match(html, /left:2\.19%/);
  // The px overflow appears in both the tag and the copy (left edge: round(0.018*1280)=23px).
  assert.match(html, /23px past the safe edge/);
  assert.match(html, /23px inside the safe margin/);
  // The two safe-area findings CLUSTER under one "Safe area (2)" header: the first is the full card
  // above, the second is folded behind "Show 1 more" — but is the SAME full annotated card (thumbnail +
  // highlight), just collapsed.
  assert.match(html, /cluster-t">Safe area<\/span><span class="cluster-n">2</);
  assert.match(html, /<details class="morefold"><summary>Show 1 more safe area issue</);
  // The folded finding still draws its own annotated card: the bottom-edge tag (round(0.015*720)=11px)
  // and its own locator both appear.
  assert.match(html, /11px below the safe edge/);
  assert.match(html, /\/HUD\/AnswerButton0/);
  // Both findings are full `.finding` cards (rep + folded), each with its element box — none collapsed to text.
  assert.equal(html.match(/class="finding"/g)?.length, 2, "two full finding cards (rep + folded)");
  assert.equal((html.match(/class="elem"/g) ?? []).length, 2, "each card draws its element box");
  // The rep card's locator is shown too.
  assert.match(html, /\/HUD\/HomeButton/);
  // It's a blocking finding → still under must-fix.
  assert.match(html, /Must fix before release/);
});

test("the HTML is light-only (design) and carries the lightbox element + script", () => {
  const report = baseReport({ status: "pass" });
  const html = renderMinigameReportHtml(report);
  assert.match(html, /color-scheme: light/);
  assert.match(html, /class="lightbox"/);
  assert.match(html, /function zoom\(src\)/);
  // Enlarging an annotated shot clones its overlay + detail into a two-pane lightbox, with a
  // toggle to hide/show the annotation.
  assert.match(html, /function zoomShot\(el\)/);
  assert.match(html, /function toggleAnn\(cb\)/);
  assert.match(html, /id="lbbox"/);
  // Esc closes the lightbox.
  assert.match(html, /e\.key === 'Escape'/);
});

test("a finding WITHOUT an annotation renders the SAME two-pane card (screenshot left, detail right) — no overlay", () => {
  const failures = [gateFail("active", "required-in-frame", "homeButton")];
  const cr = buildCrGroups({}, failures, [], [], undefined);
  const report = baseReport({ status: "fail", failures, cr });
  const thumbs = { active: "data:image/png;base64,AAAA" };

  const html = renderMinigameReportHtml(report, thumbs);
  assert.match(html, /off-screen or hidden/);
  // Issue 2: a thumbnailed plain finding (e.g. a missing element) renders the SAME `.finding` two-pane
  // card as the annotated ones — screenshot on the left, detail on the right — not a full-width image.
  assert.match(html, /class="finding"/);
  assert.match(html, /class="shot"/);
  assert.match(html, /class="detail"/);
  assert.doesNotMatch(html, /class="finding noshot"/, "with a thumbnail it's the two-pane card, not single-column");
  // The subject titles the card (required-in-frame → the object name).
  assert.match(html, /Home Button/);
  // No annotated overlay for a non-rect finding (nothing to highlight).
  assert.doesNotMatch(html, /class="safe"/);
  assert.doesNotMatch(html, /class="elem"/);
});

test("a thumbnail-less plain finding falls back to a single-column card (.finding.noshot), still consistent shell", () => {
  const failures = [gateFail("active", "required-in-frame", "homeButton")];
  const cr = buildCrGroups({}, failures, [], [], undefined);
  const report = baseReport({ status: "fail", failures, cr });

  const html = renderMinigameReportHtml(report, {}); // no thumbs
  assert.match(html, /class="finding noshot"/);
  assert.match(html, /off-screen or hidden/);
});

test("the Where/Fix copy helpers are derived from the annotation (pure)", () => {
  // regionName: homeButton centre is bottom-left.
  assert.equal(regionName(homeButtonAnnotation.rect), "Bottom-left corner");
  // overflowPx uses the right axis per edge.
  assert.equal(overflowPx(homeButtonAnnotation), 23); // left → width axis
  assert.equal(overflowPx(answerButtonAnnotation), 11); // bottom → height axis
  // whereCopy names the region + edge + px.
  assert.match(whereCopy(homeButtonAnnotation), /Bottom-left corner/);
  assert.match(whereCopy(homeButtonAnnotation), /23px inside the safe margin/);
  assert.match(whereCopy(answerButtonAnnotation), /11px below the safe margin/);
  // fixCopy gives a concrete target px (left inset 0.04*1280=51px) and a direction.
  assert.match(fixCopy(homeButtonAnnotation), /51px/);
  assert.match(fixCopy(homeButtonAnnotation), /23px right/);
  // bottom fix: target px = 0.05*720=36px, raise it up.
  assert.match(fixCopy(answerButtonAnnotation), /36px/);
  assert.match(fixCopy(answerButtonAnnotation), /11px up/);
  // No em-dashes in the derived copy.
  assert.doesNotMatch(whereCopy(homeButtonAnnotation), /—/);
  assert.doesNotMatch(fixCopy(homeButtonAnnotation), /—/);
});

// ── per-device finding GROUPING (collapse the same issue across aspects) ────────────

const devTag = (id: string, label: string): MinigameDeviceTag => ({ id, label });
const devSafeArea = (state: string, d: MinigameDeviceTag): MinigameFinding => ({
  source: "gate", state, gate: "safe-area", id: "safe-area.homeButton", detail: "homeButton overflows", device: d,
});

test("groupFindingsByDevice: the same (state,gate,id) across N device aspects collapses to ONE group naming all devices in order", () => {
  const findings = [
    devSafeArea("active", devTag("landscape-16x9", "16:9")),
    devSafeArea("active", devTag("landscape-iphone", "iPhone (19.5:9)")),
    devSafeArea("active", devTag("landscape-android-tall", "Tall Android (20:9)")),
  ];
  const groups = groupFindingsByDevice(findings);
  assert.equal(groups.length, 1, "three device variants → one group");
  assert.deepEqual(groups[0].devices.map((d) => d.label), ["16:9", "iPhone (19.5:9)", "Tall Android (20:9)"]);
  // The grouped sentence lists every device once, before the terminal period.
  assert.match(humanizeGrouped(groups[0]), /safe area.*— on 16:9, iPhone \(19\.5:9\), Tall Android \(20:9\)\.$/);
});

test("groupFindingsByDevice: different states stay separate; a device-invariant finding is never merged", () => {
  const findings: MinigameFinding[] = [
    devSafeArea("start", devTag("d1", "16:9")),
    devSafeArea("start", devTag("d2", "iPhone")),
    devSafeArea("active", devTag("d1", "16:9")),
    { source: "flow", transition: "start-active", expectedState: "active", detail: "stalled" }, // no device
  ];
  const groups = groupFindingsByDevice(findings);
  // These findings carry NO geometry (annotation), so the same element on two screens can't be
  // proven the same defect → it stays per-screen. (Geometry-backed clubbing is the next tests.)
  assert.equal(groups.length, 3, "geometry-less: start(2 devices)→1, active(1)→1, flow→1");
  assert.deepEqual(groups[0].devices.map((d) => d.label), ["16:9", "iPhone"]);
  assert.deepEqual(groups[1].devices.map((d) => d.label), ["16:9"]);
  assert.deepEqual(groups[2].devices, [], "device-invariant finding carries no device list");
});

// ── cross-SCREEN clubbing: a persistent element flagged identically on several screens is ONE issue.
const annoHome = (over?: Partial<GateCheckAnnotation>): GateCheckAnnotation => ({
  rect: { x: 0.02, y: 0.84, width: 0.07, height: 0.12 },
  safeInsets: { top: 0.05, bottom: 0.05, left: 0.04, right: 0.04 },
  viewport: { width: 1280, height: 720 },
  overflow: { edge: "left", fraction: 0.021 },
  locator: "/Canvas/HomeButton",
  ...over,
});
const devSafeAreaGeo = (state: string, d: MinigameDeviceTag, anno: GateCheckAnnotation = annoHome()): MinigameFinding => ({
  source: "gate", state, gate: "safe-area", id: "safe-area.homeButton", detail: "homeButton overflows", device: d, annotation: anno,
});

test("groupFindingsByDevice: a persistent element with identical geometry on several screens clubs into ONE group spanning them", () => {
  const d1 = devTag("landscape-16x9", "16:9");
  const d2 = devTag("landscape-iphone", "iPhone (19.5:9)");
  const d3 = devTag("landscape-android-tall", "Tall Android (20:9)");
  const findings = [
    devSafeAreaGeo("start", d1), devSafeAreaGeo("start", d2), devSafeAreaGeo("start", d3),
    devSafeAreaGeo("active", d1), devSafeAreaGeo("active", d2), devSafeAreaGeo("active", d3),
  ];
  const groups = groupFindingsByDevice(findings);
  assert.equal(groups.length, 1, "same element + same geometry across two screens → one clubbed group");
  assert.deepEqual(groups[0].devices.map((x) => x.label), ["16:9", "iPhone (19.5:9)", "Tall Android (20:9)"], "devices deduped across screens");
  assert.deepEqual(groups[0].states, ["start", "active"], "the clubbed group spans both screens");
});

test("groupFindingsByDevice: the SAME element with DIFFERENT geometry on another screen stays its OWN row (it moved — never silently clubbed)", () => {
  const d1 = devTag("landscape-16x9", "16:9");
  const groups = groupFindingsByDevice([
    devSafeAreaGeo("start", d1),
    devSafeAreaGeo("active", d1, annoHome({ rect: { x: 0.5, y: 0.84, width: 0.07, height: 0.12 }, overflow: { edge: "right", fraction: 0.03 } })),
  ]);
  assert.equal(groups.length, 2, "a real per-screen position difference is two rows, not a silent merge");
});

test("a clubbed element names ALL its screens in the card label (On the Start and Active screens)", () => {
  const d1 = devTag("landscape-16x9", "16:9");
  const d2 = devTag("landscape-iphone", "iPhone (19.5:9)");
  const blocking = [devSafeAreaGeo("start", d1), devSafeAreaGeo("start", d2), devSafeAreaGeo("active", d1), devSafeAreaGeo("active", d2)];
  const cr = buildCrGroups({}, [], [], [], undefined);
  cr.blockingFailures = blocking;
  const report = baseReport({ status: "fail", cr });
  // The representative finding is the first (start, landscape-16x9); its annotated card draws on that thumb.
  const html = renderMinigameReportHtml(report, { "start@landscape-16x9": "data:image/png;base64,AAAA" });
  assert.match(html, /sec-t">Must fix before release<\/span><span class="rule"><\/span><span class="count[^"]*">1<\/span>/, "the home button clubs to ONE must-fix row, not one-per-screen");
  assert.match(html, /On the Start and Active screens/, "the card names both screens it spans");
});

test("backgroundDeclareGroups: groups likely-background findings under their candidate container with element names", () => {
  const blocking = [
    sweepFinding("/Canvas/Background/Cloud1"),
    sweepFinding("/Canvas/Background/Cloud2"),
    { source: "gate", state: "active", gate: "safe-area", id: "safe-area.homeButton", detail: "home overflow",
      annotation: { rect: { x: 0, y: 0, width: 0.1, height: 0.1 }, viewport: { width: 1280, height: 720 }, overflow: { edge: "bottom", fraction: 0.02 } } } as MinigameFinding,
  ];
  const cr = buildCrGroups({}, [], [], [], undefined);
  cr.blockingFailures = blocking;
  const report = baseReport({ status: "fail", cr });
  const groups = backgroundDeclareGroups(report);
  assert.equal(groups.length, 1, "one candidate container");
  assert.equal(groups[0].container, "/Canvas/Background");
  assert.deepEqual(groups[0].elements.map((e) => e.locator).sort(), ["/Canvas/Background/Cloud1", "/Canvas/Background/Cloud2"]);
  assert.deepEqual(groups[0].elements.map((e) => e.name).sort(), ["Cloud 1", "Cloud 2"], "element names are humanized");
});

test("the report DECLARE panel emits a copyable declare-background command (container glob default, per-element data-loc override)", () => {
  const blocking = [sweepFinding("/Canvas/Background/Cloud1"), sweepFinding("/Canvas/Background/Cloud2")];
  const cr = buildCrGroups({}, [], [], [], undefined);
  cr.blockingFailures = blocking;
  const report = baseReport({ status: "fail", cr }); // contract.id = "demo-game"
  const html = renderMinigameReportHtml(report, { active: "data:image/png;base64,AAAA" });
  assert.match(html, /class="declpanel" data-id="demo-game"/, "the panel carries the contract id");
  assert.match(html, /class="bgcont" data-glob="\/Canvas\/Background" checked/, "a pre-ticked container checkbox emitting the glob");
  assert.match(html, /class="bgel" data-loc="\/Canvas\/Background\/Cloud1" checked/, "a per-element override checkbox carries the exact locator");
  // The command lives in a textarea, so its quotes are HTML-escaped (&quot;) — the browser shows real quotes.
  assert.match(html, /loombridge minigame declare-background --id demo-game &quot;\/Canvas\/Background&quot;/, "the default command uses the container glob");
  assert.match(html, /Copy declare command/, "the copy button");
});

test("backgroundDeclareGroups: lone non-interactive elements become confident:false review groups; clusters stay confident; an interactive lone element is never offered", () => {
  const interactiveSweep = (p: string): MinigameFinding => {
    const f = sweepFinding(p);
    return { ...f, annotation: { ...f.annotation!, interactive: true } };
  };
  const blocking: MinigameFinding[] = [
    sweepFinding("/Canvas/Background/Cloud1"),
    sweepFinding("/Canvas/Background/Cloud2"), // ≥2 siblings → confident cluster
    sweepFinding("/Canvas/Logo"), // lone, non-interactive → review
    sweepFinding("/Canvas/Hud/Tray"), // lone, non-interactive → review
    interactiveSweep("/Canvas/MusicButton"), // lone, INTERACTIVE → never offered as background
  ];
  const cr = buildCrGroups({}, [], [], [], undefined);
  cr.blockingFailures = blocking;
  const report = baseReport({ status: "fail", cr });
  const groups = backgroundDeclareGroups(report);
  assert.deepEqual(groups.filter((g) => g.confident).map((g) => g.container), ["/Canvas/Background"]);
  assert.deepEqual(groups.filter((g) => !g.confident).map((g) => g.container).sort(), ["/Canvas/Hud/Tray", "/Canvas/Logo"]);
  assert.ok(groups.filter((g) => !g.confident).every((g) => g.elements.length === 1), "each review group is a single lone element");
  assert.ok(!groups.some((g) => g.container.includes("MusicButton")), "an interactive lone element is never offered as declarable background");
});

test("the report DECLARE panel lists lone elements as default-UNticked review items; the default command pre-fills clusters only", () => {
  const blocking: MinigameFinding[] = [
    sweepFinding("/Canvas/Background/Cloud1"),
    sweepFinding("/Canvas/Background/Cloud2"),
    sweepFinding("/Canvas/Logo"), // lone → review, default unticked
  ];
  const cr = buildCrGroups({}, [], [], [], undefined);
  cr.blockingFailures = blocking;
  const report = baseReport({ status: "fail", cr });
  const html = renderMinigameReportHtml(report, { active: "data:image/png;base64,AAAA" });
  assert.match(html, /Review individually/, "the review subsection is rendered");
  assert.match(html, /class="bgel" data-loc="\/Canvas\/Logo" onchange/, "the lone item is present and NOT pre-checked");
  assert.match(html, /class="bgel" data-loc="\/Canvas\/Background\/Cloud1" checked/, "cluster elements stay pre-checked");
  // The default command pre-fills ONLY the cluster glob (mirrors --from-report) — the singleton is not appended.
  assert.match(html, /declare-background --id demo-game &quot;\/Canvas\/Background&quot;<\/textarea>/, "default command = cluster glob only, no singleton");
});

test("the DECLARE panel wires container↔child checkbox sync (no stale container-checked-but-child-unticked state)", () => {
  // The bug this guards: without sync, ticking the container but unticking a child still declared the
  // whole glob (child unticks ignored), and an unticked container with all children ticked spammed every
  // child path instead of the glob. The embedded JS now syncs both directions.
  const blocking: MinigameFinding[] = [sweepFinding("/Canvas/Background/Cloud1"), sweepFinding("/Canvas/Background/Cloud2")];
  const cr = buildCrGroups({}, [], [], [], undefined);
  cr.blockingFailures = blocking;
  const report = baseReport({ status: "fail", cr });
  const html = renderMinigameReportHtml(report, { active: "data:image/png;base64,AAAA" });
  assert.match(html, /els\.forEach\(function\(c\)\{ c\.checked = cont\.checked; \}\)/, "ticking the container syncs its children");
  assert.match(html, /cont\.checked = els\.length > 0 && Array\.prototype\.every\.call\(els/, "the container mirrors all-children-ticked (so all-ticked collapses to the glob)");
});

test("the auto-detected likely-background section is FOLDED behind a <details> in HTML (count + CTA stay visible), flat in Markdown", () => {
  const blocking = [sweepFinding("/Canvas/Background/Cloud1"), sweepFinding("/Canvas/Background/Cloud2")];
  const cr = buildCrGroups({}, [], [], [], undefined);
  cr.blockingFailures = blocking;
  const report = baseReport({ status: "fail", cr });
  const html = renderMinigameReportHtml(report, { active: "data:image/png;base64,AAAA" });
  assert.match(html, /sec-t">Likely background decoration<\/span><span class="rule"><\/span><span class="count[^"]*">2<\/span>/, "the section heading + count stay visible");
  assert.match(html, /background DECORATION/i, "the declare CTA stays visible above the fold");
  assert.match(html, /<details class="bgfold"><summary>Show the 2 flagged background elements<\/summary>/, "the findings are folded behind a details");
  // Markdown stays a flat list (GitHub PR comments) — no fold, the items listed under the heading.
  const md = renderMinigameReportMarkdown(report);
  assert.doesNotMatch(md, /<details/, "markdown twin stays flat");
});

test("grouping end-to-end: 3 per-device duplicates render as ONE must-fix row, count (1), naming all aspects", () => {
  const findings = [
    devSafeArea("active", devTag("landscape-16x9", "16:9")),
    devSafeArea("active", devTag("landscape-iphone", "iPhone (19.5:9)")),
    devSafeArea("active", devTag("landscape-android-tall", "Tall Android (20:9)")),
  ];
  const cr = buildCrGroups({}, findings as unknown as MinigameFlatCheck[], [], [], undefined);
  const report = baseReport({ status: "fail", cr });

  const md = renderMinigameReportMarkdown(report);
  assert.match(md, /## Must fix before release \(1\)/, "grouped count is 1, not 3");
  const safeRows = md.split("\n").filter((l) => /safe area/.test(l));
  assert.equal(safeRows.length, 1, "one row, not one-per-device");
  assert.match(safeRows[0], /16:9, iPhone \(19\.5:9\), Tall Android \(20:9\)/, "the single row names all three aspects");

  const html = renderMinigameReportHtml(report);
  assert.match(html, /sec-t">Must fix before release<\/span><span class="rule"><\/span><span class="count[^"]*">1<\/span>/, "HTML heading shows the grouped count");
  assert.match(html, /class="stat red" href="#must-fix"><div class="n"><span class="dot"><\/span>1<\/div><div class="l">Must fix<\/div>/, "the scorecard stat uses the grouped count too");
  assert.match(html, /16:9, iPhone \(19\.5:9\), Tall Android \(20:9\)/, "the card names all three aspects");
});

// ── issue-typed annotations: the card points at THE issue, not always the safe area ──

test("tap-target card: points at the SIZE issue (control box + needed-size guide + dp badge), never a safe-area box", () => {
  const annotation: GateCheckAnnotation = {
    rect: { x: 0.1, y: 0.82, width: 0.06, height: 0.06 },
    viewport: { width: 1280, height: 720 },
    locator: "G:/Canvas/HomeButton",
    tapTarget: { actualDp: 54, minDp: 96 },
  };
  const finding: MinigameFinding = {
    source: "gate", state: "active", gate: "tap-target-size", id: "tap-target-size.homeButton",
    detail: "homeButton is 54dp", annotation, device: { id: "d", label: "16:9" },
  };
  const cr = buildCrGroups({}, [finding as unknown as MinigameFlatCheck], [], [], undefined);
  const report = baseReport({ status: "fail", cr });
  const html = renderMinigameReportHtml(report, { "active@d": "data:image/png;base64,TT" });
  assert.match(html, /class="target"/, "draws the needed-size guide");
  assert.match(html, /54dp · needs ≥96dp/, "shows the measured-vs-floor badge");
  assert.match(html, /is too small to tap/, "size-specific title");
  assert.doesNotMatch(html, /class="safe"/, "a tap-target finding NEVER renders the safe-area box");
  assert.doesNotMatch(html, /rounded corners/, "not the safe-area why copy");
});

test("safe-area-sweep card: states the bleed symptom + the declare-or-move fix, NOT the safe-area 'move it Npx' copy", () => {
  const annotation: GateCheckAnnotation = {
    rect: { x: 0.0, y: 0.95, width: 0.2, height: 0.1 },
    safeInsets: { top: 0.05, bottom: 0.05, left: 0.04, right: 0.04 },
    viewport: { width: 1280, height: 720 },
    overflow: { edge: "top", fraction: 0.03 },
    locator: "G:/Canvas/Background/Cloud3",
  };
  const finding: MinigameFinding = {
    source: "gate", state: "active", gate: "safe-area-sweep", id: "safe-area-sweep.cloud3",
    detail: "cloud3 bleeds past the safe area", annotation, device: { id: "d", label: "16:9" },
  };
  const cr = buildCrGroups({}, [finding as unknown as MinigameFlatCheck], [], [], undefined);
  const report = baseReport({ status: "fail", cr });
  const html = renderMinigameReportHtml(report, { "active@d": "data:image/png;base64,SW" });
  assert.match(html, /bleeds past the safe area/, "the title states the symptom, not 'move it'");
  assert.match(html, /safeAreaBackground/, "the fix offers the declare-as-background path");
  assert.doesNotMatch(html, /Move it so the/, "not the safe-area control fix copy");
});

// ── Phase 4: per-device findings carry their device, the renderer shows it ──────────

test("Phase 4: a per-device gate finding carries its device label and the renderer names the device", () => {
  const finding: MinigameFinding = {
    source: "gate",
    state: "active",
    gate: "safe-area",
    id: "safe-area.homeButton",
    detail: "homeButton overflows on the bottom edge in active",
    device: { id: "landscape-iphone", label: "iPhone (19.5:9)" },
  };
  // humanizeFinding names the device inside the sentence's terminal period.
  const sentence = humanizeFinding(finding);
  assert.match(sentence, /iPhone \(19\.5:9\)/, "the device label is in the human sentence");
  assert.match(sentence, /safe area.*— on iPhone \(19\.5:9\)\.$/, "the device clause sits before the period");

  const cr = buildCrGroups({}, [finding as unknown as MinigameFlatCheck], [], [], undefined);
  const report = baseReport({ status: "fail", cr });
  const html = renderMinigameReportHtml(report);
  const md = renderMinigameReportMarkdown(report);
  assert.match(html, /iPhone \(19\.5:9\)/, "the HTML names the device");
  assert.match(md, /iPhone \(19\.5:9\)/, "the Markdown names the device");

  // A finding WITHOUT a device renders exactly once, with no device clause.
  const noDevice: MinigameFinding = { ...finding, device: undefined };
  assert.doesNotMatch(humanizeFinding(noDevice), /— on /, "no device clause for a device-less finding");
});

test("Phase 4: the annotated card uses the PER-DEVICE thumbnail and titles the device", () => {
  const annotation: GateCheckAnnotation = {
    rect: { x: 0.02, y: 0.02, width: 0.2, height: 0.12 },
    safeInsets: { top: 0.05, bottom: 0.05, left: 0.04, right: 0.04 },
    viewport: { width: 1280, height: 720 },
    overflow: { edge: "bottom", fraction: 0.02 },
    locator: "G:/HUD/homeButton",
  };
  const finding: MinigameFinding = {
    source: "gate",
    state: "active",
    gate: "safe-area",
    id: "safe-area.homeButton",
    detail: "overflow",
    annotation,
    device: { id: "landscape-iphone", label: "iPhone (19.5:9)" },
  };
  // The card title states only the symptom; the device lives in the screen pill below it (redesign
  // dropped the redundant "— on iPhone…" title tail).
  assert.match(annotatedTitle(finding), /runs off the bottom/);
  assert.doesNotMatch(annotatedTitle(finding), /iPhone/);

  const cr = buildCrGroups({}, [finding as unknown as MinigameFlatCheck], [], [], undefined);
  const report = baseReport({
    status: "fail",
    cr,
    statePaths: {
      "active@landscape-iphone": { uiRects: "captures/active@landscape-iphone.ui-rects.json", console: "captures/active.console.json", png: "captures/active@landscape-iphone.png" },
    },
    deviceLabels: { "landscape-iphone": "iPhone (19.5:9)" },
  });
  // The per-device thumbnail key is `<state>@<device>` — the card must draw THAT screenshot.
  const thumbs = { "active@landscape-iphone": "data:image/png;base64,PERDEVICE" };
  const html = renderMinigameReportHtml(report, thumbs);
  assert.match(html, /data:image\/png;base64,PERDEVICE/, "draws the per-device screenshot");
  assert.match(html, /iPhone \(19\.5:9\)/, "names the device in the card");
});

test("Phase 4: the gallery lists per-device screens, each captioned with its device", () => {
  const states: Record<string, GateReport[]> = {
    "start@landscape-16x9": [makeGateReport("required-in-frame", [{ id: "required-in-frame.x", expected: "visible", actual: "visible", status: "pass", detail: "ok" }])],
    "start@landscape-iphone": [makeGateReport("required-in-frame", [{ id: "required-in-frame.x", expected: "visible", actual: "visible", status: "pass", detail: "ok" }])],
  };
  const report = baseReport({
    status: "pass",
    states,
    cr: buildCrGroups(states, [], [], [], undefined),
    statePaths: {
      "start@landscape-16x9": { uiRects: "a", console: "c", png: "captures/start@landscape-16x9.png" },
      "start@landscape-iphone": { uiRects: "a", console: "c", png: "captures/start@landscape-iphone.png" },
    },
    deviceLabels: { "landscape-16x9": "16:9", "landscape-iphone": "iPhone (19.5:9)" },
  });
  const thumbs = {
    "start@landscape-16x9": "data:image/png;base64,AAA",
    "start@landscape-iphone": "data:image/png;base64,BBB",
  };
  const html = renderMinigameReportHtml(report, thumbs);
  assert.match(html, /Screens captured/);
  assert.match(html, /Start · 16:9/, "the base-device screen is captioned with its device");
  assert.match(html, /Start · iPhone \(19\.5:9\)/, "the iphone screen is captioned with its device");
});

// ── background-seam card ─────────────────────────────────────────────────────────

/** A background-seam blocking finding with a resolved screenshotKey + two cut-edge segments. */
function seamFinding(screenshotKey: string | undefined): MinigameFinding {
  return {
    source: "gate",
    state: "active",
    gate: "background-seam",
    id: "background-seam",
    detail: "A background layer's cut edge is visible inside the frame.",
    device: { id: "wide-20x9", label: "Tall Android (20:9)" },
    seamAnnotation: {
      viewport: { width: 2400, height: 1080 },
      ...(screenshotKey ? { screenshotKey } : {}),
      segments: [
        { edge: "bottom", layerLocator: "Scene:/Background/Ground", line: { x0: 0, y0: 0.78, x1: 1, y1: 0.78 }, strip: { x: 0, y: 0.78, width: 1, height: 0.22 }, exposedFraction: 0.22 },
        { edge: "right", layerLocator: "Scene:/Background/HillNear", line: { x0: 0.9, y0: 0.2, x1: 0.9, y1: 0.8 }, strip: { x: 0.9, y: 0.2, width: 0.1, height: 0.6 }, exposedFraction: 0.1 },
      ],
    },
  };
}

test("renderSeamCard: draws the screenshot, a seamline + seamstrip per segment, and the layer labels", () => {
  const cr = buildCrGroups({}, [], [], [], undefined);
  cr.blockingFailures = [seamFinding("active@wide-20x9")];
  const report = baseReport({ status: "fail", cr });
  const thumbs = { "active@wide-20x9": "data:image/png;base64,SEAM" };

  const html = renderMinigameReportHtml(report, thumbs);

  // The gameplay screenshot is drawn.
  assert.match(html, /src="data:image\/png;base64,SEAM"/);
  // One seamline + one seamstrip per segment (two segments).
  assert.equal((html.match(/class="seamline"/g) ?? []).length, 2);
  assert.equal((html.match(/class="seamstrip"/g) ?? []).length, 2);
  // Per-layer labels with the px depth (round(0.22*1080)=238, round(0.1*2400)=240).
  assert.match(html, /Ground bottom — 238px/);
  assert.match(html, /Hill Near right — 240px/);
  // The seam legend + the must-fix placement.
  assert.match(html, /exposed background edge/);
  assert.match(html, /Must fix before release/);
});

test("renderSeamCard: a seam finding with no resolvable screenshot falls back to the plain card (no crash)", () => {
  const cr = buildCrGroups({}, [], [], [], undefined);
  cr.blockingFailures = [seamFinding(undefined)];
  const report = baseReport({ status: "fail", cr });

  const html = renderMinigameReportHtml(report, {}); // no thumbs at all
  // No seam overlay drawn…
  assert.doesNotMatch(html, /class="seamline"/);
  assert.doesNotMatch(html, /class="seamstrip"/);
  // …but the plain humanized sentence is still present (the background-seam product copy).
  assert.match(html, /A background layer's edge is visible inside the frame/);
});

test("renderSeamCard: a non-seam finding is unaffected (renders as before)", () => {
  const failures = [gateFail("active", "required-in-frame", "homeButton")];
  const cr = buildCrGroups({}, failures, [], [], undefined);
  const report = baseReport({ status: "fail", failures, cr });

  const html = renderMinigameReportHtml(report, { active: "data:image/png;base64,AAAA" });
  assert.doesNotMatch(html, /class="seamline"/);
  assert.match(html, /off-screen or hidden/);
});

// ── Phase 2: safe-area-sweep suggests candidate background containers (advisory) ──────

/** A sweep failure carrying the flagged object's path via `annotation.locator` (as the gate sets). */
function sweepFinding(path: string): MinigameFinding {
  return {
    source: "gate",
    state: "active",
    gate: "safe-area-sweep",
    id: `safe-area-sweep.${path}`,
    detail: "raw",
    annotation: {
      rect: { x: 0, y: 0, width: 0.1, height: 0.1 },
      safeInsets: { top: 0.05, bottom: 0.05, left: 0.04, right: 0.04 },
      viewport: { width: 1280, height: 720 },
      overflow: { edge: "bottom", fraction: 0.02 },
      locator: path,
    },
  };
}

test("backgroundContainerCandidates: a parent with ≥2 flagged children + a bracketed-index glob are proposed; a lone child is not", () => {
  const flagged = [
    "/Canvas/Background/Cloud3",
    "/Canvas/Background/HillFar",
    "/Canvas/Sparkle[0]",
    "/Canvas/Sparkle[4]",
    "/Canvas/Tiles/Tile_A/Label",
    "/Canvas/Tiles/Tile_B/Label",
  ];
  const candidates = backgroundContainerCandidates(flagged);

  // /Canvas/Background has ≥2 flagged children → its container is proposed.
  assert.ok(candidates.includes("/Canvas/Background"), "parent with ≥2 children");
  // /Canvas/Sparkle[0] + /Canvas/Sparkle[4] share a bracketed prefix → a trailing-* glob.
  assert.ok(candidates.includes("/Canvas/Sparkle*"), "bracketed-index glob");
  // The two Tile labels live under different parents (Tile_A vs Tile_B), so neither parent has
  // ≥2 flagged children → no Tile container is proposed.
  assert.ok(!candidates.some((c) => c.includes("Tile")), "no single-child parent proposed");
  // Deterministic (sorted) order.
  assert.deepEqual(candidates, [...candidates].sort());
});

test("backgroundContainerCandidates: a single flagged element under a parent does NOT propose that parent", () => {
  assert.deepEqual(backgroundContainerCandidates(["/Canvas/Background/OnlyCloud"]), []);
  // A single bracketed sibling is also not enough for a glob.
  assert.deepEqual(backgroundContainerCandidates(["/Canvas/Sparkle[0]"]), []);
});

test("backgroundContainerCandidates: never proposes the bare canvas root, and drops candidates covered by a broader one", () => {
  // logo + musicButton share parent /Canvas → would propose the ROOT (a footgun: exempts everything). Excluded.
  // Balloon* lives under /Canvas/Background → redundant with /Canvas/Background. Dropped.
  const flagged = [
    "/Canvas/Logo",
    "/Canvas/MusicButton",
    "/Canvas/Background/Cloud",
    "/Canvas/Background/Hill",
    "/Canvas/Background/Balloon[0]",
    "/Canvas/Background/Balloon[1]",
  ];
  const candidates = backgroundContainerCandidates(flagged);
  assert.ok(!candidates.includes("/Canvas"), "never propose the bare root");
  assert.ok(!candidates.includes("/Canvas/Background/Balloon*"), "Balloon* is covered by /Canvas/Background");
  assert.ok(candidates.includes("/Canvas/Background"), "the specific decoration container is proposed");
});

test("backgroundContainerCandidates: a glob does NOT cover a distinct same-prefix sibling container (segment-safe dedup)", () => {
  // Star[0]/Star[1] → /Canvas/Star* ; StarScore/{A,B} → /Canvas/StarScore (a separate HUD container).
  // A raw-prefix `covers` would wrongly drop /Canvas/StarScore as "covered by /Canvas/Star*".
  const flagged = [
    "/Canvas/Star[0]",
    "/Canvas/Star[1]",
    "/Canvas/StarScore/A",
    "/Canvas/StarScore/B",
  ];
  const candidates = backgroundContainerCandidates(flagged);
  assert.ok(candidates.includes("/Canvas/Star*"), "the bracketed-sibling glob is proposed");
  assert.ok(candidates.includes("/Canvas/StarScore"), "the distinct same-prefix container is NOT swallowed by the glob");
});

test("backgroundContainerCandidates: dedups and caps at 6", () => {
  // 8 distinct parents each with 2 children → capped to 6, sorted.
  const flagged: string[] = [];
  for (let i = 0; i < 8; i++) flagged.push(`/Canvas/G${i}/a`, `/Canvas/G${i}/b`);
  const candidates = backgroundContainerCandidates(flagged);
  assert.equal(candidates.length, 6);
  assert.deepEqual(candidates, [...candidates].sort());
});

test("backgroundSuggestionText: empty for no candidates; uses the actual candidates in the example", () => {
  assert.equal(backgroundSuggestionText([]), "");
  const text = backgroundSuggestionText(["/Canvas/Background", "/Canvas/Sparkle*"]);
  assert.match(text, /background DECORATION/);
  assert.match(text, /contract\.safeAreaBackground/);
  assert.match(text, /safeAreaBackground: \["\/Canvas\/Background", "\/Canvas\/Sparkle\*"\]/);
  assert.match(text, /Only declare the decorative ones/);
});

test("the report SHOWS the background suggestion (with example values) when there are sweep failures + candidates", () => {
  const failures: MinigameFinding[] = [
    sweepFinding("/Canvas/Background/Cloud3"),
    sweepFinding("/Canvas/Background/HillFar"),
    sweepFinding("/Canvas/Sparkle[0]"),
    sweepFinding("/Canvas/Sparkle[4]"),
  ];
  const cr = buildCrGroups({}, [], [], [], undefined);
  cr.blockingFailures = failures;
  const report = baseReport({ status: "fail", cr });

  const html = renderMinigameReportHtml(report, { active: "data:image/png;base64,AAAA" });
  const md = renderMinigameReportMarkdown(report);

  for (const out of [html, md]) {
    assert.match(out, /background DECORATION/i, "the advisory preamble");
    assert.match(out, /contract\.safeAreaBackground/, "names the contract field");
    // The actual computed candidates appear in the example literal.
    assert.match(out, /\/Canvas\/Background/, "the parent-container candidate");
    assert.match(out, /\/Canvas\/Sparkle\*/, "the bracketed-index glob candidate");
    // The sweep findings move into a "declare to dismiss" section (still failures, never silenced),
    // led by the CTA — not a flat must-fix wall. All four here are decoration → no must-fix section.
    assert.match(out, /Likely background decoration/);
  }
  assert.doesNotMatch(html, /Must fix before release/, "all-decoration sweep → no separate must-fix wall");
});

test("backgroundContainerCandidates: a container that would exempt a BOUND control is never proposed (MED-1)", () => {
  // AnswerButton0/1/2 cluster under /Canvas/GameplayRoot/Answers → it would be proposed, BUT
  // AnswerButton2 is a bound control, so the gameplay container must be excluded from the suggestion.
  const flagged = [
    "/Canvas/GameplayRoot/Answers/AnswerButton0",
    "/Canvas/GameplayRoot/Answers/AnswerButton1",
    "/Canvas/GameplayRoot/Answers/AnswerButton2",
    "/Canvas/Background/Cloud1",
    "/Canvas/Background/Cloud2",
  ];
  const withoutProtection = backgroundContainerCandidates(flagged);
  assert.ok(withoutProtection.includes("/Canvas/GameplayRoot/Answers"), "without protection it WOULD propose the gameplay container");
  const candidates = backgroundContainerCandidates(flagged, ["/Canvas/GameplayRoot/Answers/AnswerButton2"]);
  assert.ok(!candidates.includes("/Canvas/GameplayRoot/Answers"), "a bound control's container is excluded");
  assert.ok(candidates.includes("/Canvas/Background"), "the genuine decoration container is still proposed");
});

test("partitionBackgroundCandidates: sweep findings under a candidate are likely-background; bound-control children + non-sweep stay must-fix", () => {
  const candidates = ["/Canvas/Background", "/Canvas/Sparkle*"];
  const blocking: MinigameFinding[] = [
    sweepFinding("/Canvas/Background/Cloud3"),        // under a candidate → background
    sweepFinding("/Canvas/Sparkle[0]"),               // glob candidate → background
    sweepFinding("/Canvas/GameplayRoot/Answers/AnswerButton0"), // NOT under any candidate → must-fix
    { source: "gate", state: "active", gate: "safe-area", id: "safe-area.homeButton", detail: "home overflow",
      annotation: { rect: { x: 0, y: 0, width: 0.1, height: 0.1 }, viewport: { width: 1280, height: 720 }, overflow: { edge: "bottom", fraction: 0.02 } } },
  ];
  const { mustFix, likelyBackground } = partitionBackgroundCandidates(blocking, candidates);
  assert.deepEqual(likelyBackground.map((f) => f.id), ["safe-area-sweep./Canvas/Background/Cloud3", "safe-area-sweep./Canvas/Sparkle[0]"]);
  assert.deepEqual(mustFix.map((f) => f.id), ["safe-area-sweep./Canvas/GameplayRoot/Answers/AnswerButton0", "safe-area.homeButton"]);
});

test("interactivity protection: an UNBOUND interactive control stays must-fix and its container is NEVER proposed (so it can't be declared-away)", () => {
  // Two unbound tappable controls (raycastTarget → interactive) clustered in /Canvas/Toolbar, plus a
  // decoration cluster. Without protection the toolbar would be proposed + bucketed background.
  const interactiveSweep = (path: string): MinigameFinding => {
    const f = sweepFinding(path);
    return { ...f, annotation: { ...f.annotation!, interactive: true } };
  };
  const blocking: MinigameFinding[] = [
    interactiveSweep("/Canvas/Toolbar/PauseButton"),
    interactiveSweep("/Canvas/Toolbar/SettingsButton"),
    sweepFinding("/Canvas/Background/Cloud1"),
    sweepFinding("/Canvas/Background/Cloud2"),
  ];
  const cr = buildCrGroups({}, [], [], [], undefined);
  cr.blockingFailures = blocking;
  const report = baseReport({ status: "fail", cr }); // requiredLocators: [] — nothing bound
  const candidates = backgroundCandidatesFor(report);
  assert.ok(!candidates.some((c) => c.includes("Toolbar")), "the interactive controls' container is NOT proposed");
  assert.ok(candidates.includes("/Canvas/Background"), "the genuine decoration container IS proposed");
  const { mustFix, likelyBackground } = partitionBackgroundCandidates(blocking, candidates);
  assert.deepEqual(mustFix.map((f) => f.id).sort(), ["safe-area-sweep./Canvas/Toolbar/PauseButton", "safe-area-sweep./Canvas/Toolbar/SettingsButton"].sort());
  assert.deepEqual(likelyBackground.map((f) => f.id).sort(), ["safe-area-sweep./Canvas/Background/Cloud1", "safe-area-sweep./Canvas/Background/Cloud2"].sort());
});

test("partitionBackgroundCandidates: conservation — every finding lands in exactly one bucket (nothing silenced)", () => {
  const blocking: MinigameFinding[] = [
    sweepFinding("/Canvas/Background/Cloud1"),
    sweepFinding("/Canvas/Background/Cloud2"),
    { source: "gate", state: "active", gate: "safe-area", id: "safe-area.homeButton", detail: "x" },
    { source: "flow", transition: "start-active", expectedState: "active", detail: "stalled" }, // non-gate, no .gate
    { source: "gate", state: "active", gate: "safe-area-sweep", id: "safe-area-sweep.noLoc", detail: "no annotation" }, // no locator
  ];
  const { mustFix, likelyBackground } = partitionBackgroundCandidates(blocking, ["/Canvas/Background"]);
  assert.equal(mustFix.length + likelyBackground.length, blocking.length, "nothing dropped");
  const ids = [...mustFix, ...likelyBackground].map((f) => f.id ?? f.transition);
  assert.equal(new Set(ids).size, ids.length, "buckets are disjoint");
  assert.deepEqual(likelyBackground.map((f) => f.id), ["safe-area-sweep./Canvas/Background/Cloud1", "safe-area-sweep./Canvas/Background/Cloud2"]);
});

test("render: when must-fix AND likely-background coexist, BOTH headings show and the CTA leads the background section", () => {
  const blocking: MinigameFinding[] = [
    { source: "gate", state: "active", gate: "safe-area", id: "safe-area.homeButton", detail: "home overflow",
      annotation: { rect: { x: 0, y: 0, width: 0.1, height: 0.1 }, viewport: { width: 1280, height: 720 }, overflow: { edge: "bottom", fraction: 0.02 } } },
    sweepFinding("/Canvas/Background/Cloud1"),
    sweepFinding("/Canvas/Background/Cloud2"),
  ];
  const cr = buildCrGroups({}, [], [], [], undefined);
  cr.blockingFailures = blocking;
  const report = baseReport({ status: "fail", cr });
  const html = renderMinigameReportHtml(report, { active: "data:image/png;base64,AAAA" });
  const mustIdx = html.indexOf("Must fix before release");
  const bgIdx = html.indexOf("Likely background decoration");
  assert.ok(mustIdx >= 0 && bgIdx >= 0, "both sections render");
  assert.ok(mustIdx < bgIdx, "must-fix comes before likely-background");
  // The CTA leads its section: the short "background art" explainer appears BEFORE the first cloud
  // finding below it (the folded details).
  const ctaIdx = html.indexOf("background art", bgIdx);
  const firstBgItem = html.indexOf("Cloud", bgIdx);
  assert.ok(ctaIdx >= 0 && ctaIdx < firstBgItem, "the declare CTA leads the background section, not trailing");
});

test("the likely-background CTA + declare panel use short, plain-English copy (no jargon)", () => {
  const blocking = [sweepFinding("/Canvas/Background/Cloud1"), sweepFinding("/Canvas/Background/Cloud2")];
  const cr = buildCrGroups({}, [], [], [], undefined);
  cr.blockingFailures = blocking;
  const report = baseReport({ status: "fail", cr });
  const html = renderMinigameReportHtml(report, { active: "data:image/png;base64,AAAA" });
  assert.match(html, /Some of these are background art, not problems/, "the CTA box explains the concept in plain English");
  assert.match(html, /Only buttons and text need to stay inside the safe area/, "the rule is stated simply");
  assert.match(html, /<b>Tick the real background<\/b>/, "the panel instruction is short and direct");
  assert.doesNotMatch(html, /no hand-editing the contract/, "the old verbose declhead copy is gone");
});

test("the HTML next-step renders scannable bullets, code-formats commands, and drops the background clause (the panel covers it)", () => {
  const report = baseReport({
    status: "fail",
    nextAction:
      "fix Home Button, Progress (see the report for the exact screen + check), then re-capture and re-run `loombridge verify --minigame`; Some of these may be background DECORATION (sky / clouds). If so, declare their container(s).",
  });
  const html = renderMinigameReportHtml(report, {});
  assert.match(html, /<ul class="nextlist">/, "the next steps render as a bullet list");
  assert.match(html, /<li>Fix Home Button, Progress[^<]*<\/li>/, "the fix is its own bullet, capitalized");
  assert.match(html, /<li>Re-capture and re-run <code>loombridge verify --minigame<\/code><\/li>/, "the re-run is its own bullet; the command is <code>");
  assert.doesNotMatch(html, /background DECORATION/i, "the background clause is dropped from the next steps");
});

test("the HTML next-step stays an inline sentence when there is only one step", () => {
  const report = baseReport({ status: "pass", nextAction: "Re-run after any UI change." });
  const html = renderMinigameReportHtml(report, {});
  assert.match(html, /<p class="next-h">Next step<\/p><p>Re-run after any UI change\.<\/p>/, "a single step stays an inline line");
  assert.doesNotMatch(html, /<ul class="nextlist">/, "no bullet list for one step");
});

test("render: with NO candidates (lone sweep elements), everything stays must-fix and NO likely-background section appears", () => {
  // One child per parent → no parent has ≥2 flagged children → no candidates.
  const blocking = [sweepFinding("/Canvas/Background/Cloud1"), sweepFinding("/Canvas/Foreground/Star1")];
  const cr = buildCrGroups({}, [], [], [], undefined);
  cr.blockingFailures = blocking;
  const report = baseReport({ status: "fail", cr });
  const html = renderMinigameReportHtml(report, { active: "data:image/png;base64,AAAA" });
  assert.match(html, /sec-t">Must fix before release<\/span><span class="rule"><\/span><span class="count[^"]*">2<\/span>/, "lone sweep findings stay must-fix");
  assert.doesNotMatch(html, /Likely background decoration/, "no spurious likely-background section");
});

test("the report does NOT show the background suggestion when there are no sweep failures", () => {
  // A required-in-frame failure (no sweep) → no suggestion.
  const failures = [gateFail("active", "required-in-frame", "homeButton")];
  const cr = buildCrGroups({}, failures, [], [], undefined);
  const report = baseReport({ status: "fail", failures, cr });

  const html = renderMinigameReportHtml(report, { active: "data:image/png;base64,AAAA" });
  const md = renderMinigameReportMarkdown(report);
  for (const out of [html, md]) {
    assert.doesNotMatch(out, /background DECORATION/i);
    assert.doesNotMatch(out, /contract\.safeAreaBackground/);
  }
});

test("a clean pass report shows no background suggestion", () => {
  const report = baseReport({ status: "pass" });
  const html = renderMinigameReportHtml(report);
  const md = renderMinigameReportMarkdown(report);
  for (const out of [html, md]) {
    assert.doesNotMatch(out, /background DECORATION/i);
  }
});

test("harnessFlowSentence (G8): a sequential sub-screen transition reads as 'split the state', not 'tap didn't register'", () => {
  // The G8 indeterminate detail (from gradeTransition) carries 'sequential sub-screens' — the human
  // sentence must surface the contract-granularity fix, not the generic dishonest-tap harness wording.
  const seq: MinigameFinding = {
    source: "flow",
    transition: "mix → cook",
    expectedState: "cook",
    detail: "Cannot re-derive reachability for 'mix → cook': target 'cook' shows its required object(s) [ingredientSpray, ingredientPour] sequentially (never in one frame) — 'cook' collapses sequential sub-screens; split it into one state per sub-screen.",
  };
  const s = harnessFlowSentence(seq);
  assert.match(s, /sequential sub-screens/i);
  assert.match(s, /split it into one state per sub-screen|Split it/i);
  assert.doesNotMatch(s, /tap didn't register/i);

  // A genuine harness fault (dishonest actuation) still reads as the tap-didn't-register gap.
  const harness: MinigameFinding = {
    source: "flow",
    transition: "start → active",
    detail: "Harness fault on 'start → active': actuation acted on /X, not the declared target /Y.",
  };
  assert.match(harnessFlowSentence(harness), /tap didn't register/i);
});
