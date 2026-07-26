/**
 * D6 — per-scene report grouping (Phase 1). A multi-scene contract's findings render GROUPED under each
 * scene (Home / StarChef) while the verdict stays global; a single-scene contract renders exactly as
 * before (R4: byte-identical). Tests `stampFindingScenes` (the pure scene-stamp) and the rendered
 * markdown grouping. Inert for today's single-scene contracts — no state declares a `scene`.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { backgroundDeclareGroups, renderMinigameReportHtml, renderMinigameReportMarkdown } from "../../../../capabilities/minigame/minigame-report-render.js";
import {
  stampFindingScenes,
  type MinigameCrReport,
  type MinigameFinding,
  type MinigameVerifyReport,
} from "../../../../capabilities/minigame/verify-minigame.js";

const EMPTY_CR: MinigameCrReport = {
  blockingFailures: [], baselineRegressions: [], incompleteHarness: [],
  warnings: [], passedGates: {}, advisoryNotes: [], notAssertedOutcomeGated: [],
};

function baseReport(over: Partial<MinigameVerifyReport>): MinigameVerifyReport {
  return {
    kind: "minigame-verification",
    schemaVersion: "1",
    producedAt: "2026-06-07T00:00:00Z",
    contract: {
      id: "game-hub", title: "Game Hub", type: "2d-kids-minigame",
      ageBand: "5-7", ageBandLabel: "Early elementary (5–7)",
      visualProfile: "phone-portrait", visualProfileLabel: "Phone portrait (9:16)",
      scenes: ["Assets/Scenes/Home.unity", "Assets/Scenes/StarChef.unity"], requiredLocators: [],
    },
    capturesDir: "captures",
    status: "fail",
    states: {},
    gatesByState: {},
    summary: { statesTotal: 4, statesGraded: 4, checksTotal: 8, pass: 6, warn: 0, fail: 2, notApplicable: 0 },
    failures: [], notApplicable: [], captureAbsent: [], outcomeGated: [],
    cr: EMPTY_CR,
    statePaths: {}, deviceLabels: {}, headline: "h", nextAction: "n",
    ...over,
  };
}

const fail = (state: string, obj: string, scene?: string): MinigameFinding => ({
  source: "gate", state, scene, gate: "tap-target-size", id: `tap-target-size.${obj}`,
  detail: `${obj} is too small to tap`,
});

test("stampFindingScenes: empty map is a no-op and returns the SAME reference (single-scene back-compat)", () => {
  const cr: MinigameCrReport = { ...EMPTY_CR, blockingFailures: [fail("start", "btn")] };
  assert.equal(stampFindingScenes(cr, new Map()), cr, "single-scene: identical object, no copy");
});

test("stampFindingScenes: stamps a finding's scene from its state, and a flow finding's from expectedState", () => {
  const cr: MinigameCrReport = {
    ...EMPTY_CR,
    blockingFailures: [fail("home__start", "play")],
    incompleteHarness: [{ source: "flow", transition: "home__start → star-chef__active", expectedState: "star-chef__active", detail: "couldn't drive" }],
  };
  const stateScene = new Map([["home__start", "Home"], ["star-chef__active", "StarChef"]]);
  const out = stampFindingScenes(cr, stateScene);
  assert.equal(out.blockingFailures[0].scene, "Home");
  assert.equal(out.incompleteHarness[0].scene, "StarChef", "flow finding scene comes from expectedState");
  // Original is untouched (pure).
  assert.equal(cr.blockingFailures[0].scene, undefined);
});

test("stampFindingScenes: a state absent from the map keeps no scene (not invented)", () => {
  const cr: MinigameCrReport = { ...EMPTY_CR, blockingFailures: [fail("mystery_state", "btn")] };
  const out = stampFindingScenes(cr, new Map([["home__start", "Home"]]));
  assert.equal(out.blockingFailures[0].scene, undefined);
});

test("render (single-scene): headings have NO scene suffix — byte-identical to pre-D6 (R4)", () => {
  const cr: MinigameCrReport = { ...EMPTY_CR, blockingFailures: [fail("start", "play"), fail("active", "home")] };
  const md = renderMinigameReportMarkdown(baseReport({ cr }));
  assert.match(md, /## Must fix before release \(2\)\n/, "one flat must-fix section, no ' · scene' suffix");
  // No section HEADING carries a scene suffix (the title line legitimately uses ' · ', so scope to `## `).
  const headings = md.split("\n").filter((l) => l.startsWith("## "));
  assert.ok(headings.every((h) => !h.includes(" · ")), `headings must be scene-suffix-free: ${headings.join(" | ")}`);
});

test("render (multi-scene): the report reads SCENE-first — a `## Scene` heading, then the scene's `### bucket`, ordered by first appearance", () => {
  const cr: MinigameCrReport = {
    ...EMPTY_CR,
    blockingFailures: [
      fail("home__start", "play", "Home"),
      fail("star-chef__active", "mix", "StarChef"),
      fail("home__start", "settings", "Home"),
    ],
  };
  const md = renderMinigameReportMarkdown(baseReport({ cr }));
  const home = md.indexOf("## Home");
  const chef = md.indexOf("## StarChef");
  assert.ok(home >= 0, "Home scene heading");
  assert.ok(chef >= 0, "StarChef scene heading");
  assert.ok(home < chef, "Home appears before StarChef (first-appearance order)");
  // The bucket nests under the scene at `### bucket (count)`, with NO scene suffix (the scene is the parent).
  assert.match(md, /### Must fix before release \(2\)\n/, "Home's 2 must-fix findings");
  assert.match(md, /### Must fix before release \(1\)\n/, "StarChef's 1 must-fix finding");
});

test("render (multi-scene): a scene-less finding falls into an explicit 'Other screens' scene, never dropped", () => {
  const cr: MinigameCrReport = {
    ...EMPTY_CR,
    blockingFailures: [fail("home__start", "play", "Home"), { source: "gate", detail: "a global defect", gate: "console-clean", id: "console-clean.x" }],
  };
  const md = renderMinigameReportMarkdown(baseReport({ cr }));
  assert.match(md, /## Home\n/);
  assert.match(md, /## Other screens\n/);
  // Both scenes carry their own must-fix bucket.
  assert.equal(md.match(/### Must fix before release \(1\)/g)?.length, 2, "one must-fix bucket per scene");
});

test("render (multi-scene): the verdict stays GLOBAL — one NOT READY banner across scenes", () => {
  const cr: MinigameCrReport = {
    ...EMPTY_CR,
    blockingFailures: [fail("home__start", "play", "Home"), fail("star-chef__active", "mix", "StarChef")],
  };
  const md = renderMinigameReportMarkdown(baseReport({ status: "fail", cr }));
  assert.match(md, /NOT READY/);
  assert.equal(md.match(/Release check:/g)?.length, 1, "exactly one banner, not one per scene");
});

// ── HTML renderer (the per-scene split must not break anchors / counts) ──────────

/** Every `id="..."` attribute in the HTML, to assert anchor uniqueness. */
function htmlIds(html: string): string[] {
  return [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
}

test("HTML (single-scene): a bucket keeps its bare anchor id and the count badge isn't doubled (R4)", () => {
  const cr: MinigameCrReport = { ...EMPTY_CR, blockingFailures: [fail("start", "play"), fail("active", "home")] };
  const html = renderMinigameReportHtml(baseReport({ cr }), {});
  const ids = htmlIds(html);
  assert.equal(ids.filter((x) => x === "must-fix").length, 1, "exactly one #must-fix anchor");
  // The title text strips the trailing count (it lives in the badge) — so "(2)" must NOT appear in the <h2> title span.
  assert.doesNotMatch(html, /sec-t">[^<]*\(2\)/);
});

test("HTML (multi-scene): a scene banner per scene, UNIQUE anchor ids, and the first bucket keeps the bare anchor", () => {
  const cr: MinigameCrReport = {
    ...EMPTY_CR,
    blockingFailures: [fail("home__start", "play", "Home"), fail("star-chef__active", "mix", "StarChef")],
  };
  const html = renderMinigameReportHtml(baseReport({ status: "fail", cr }), {});
  const ids = htmlIds(html);
  assert.equal(new Set(ids).size, ids.length, `no duplicate ids: ${ids.join(",")}`);
  assert.ok(ids.includes("must-fix"), "first split section keeps the bare #must-fix anchor (scorecard tile resolves)");
  // Each scene leads with its own banner (scene name lives there now, not in the bucket title).
  assert.match(html, /class="scene" id="scene-home">Home</);
  assert.match(html, /class="scene" id="scene-star-chef">StarChef</);
  // The bucket title is scene-free (the scene is the parent banner); the second scene's bucket is suffixed.
  assert.match(html, /sec-t">Must fix before release</);
  assert.ok(ids.includes("must-fix-star-chef"), "the second scene's must-fix gets a scene-suffixed anchor");
});

// ── issue-type clustering (one rep card + "Show N more", counts stay honest) ──────

/** A safe-area finding with overflow geometry (so it draws a card / carries a terse note). */
const sa = (state: string, obj: string, edge: "top" | "bottom", scene?: string): MinigameFinding => ({
  source: "gate", state, scene, gate: "safe-area", id: `safe-area.${obj}`, detail: `${obj} bleeds`,
  annotation: { rect: { x: 0.1, y: 0.1, width: 0.1, height: 0.1 }, safeInsets: { top: 0.05, bottom: 0.05, left: 0.04, right: 0.04 }, overflow: { edge, fraction: 0.02 }, viewport: { width: 1000, height: 1000 }, locator: `/Canvas/${obj}` },
});
/** A non-interactive safe-area-sweep finding (declarable background) at the given locator. */
const sweep = (state: string, locator: string, scene?: string): MinigameFinding => ({
  source: "gate", state, scene, gate: "safe-area-sweep", id: `safe-area-sweep.${locator}`, detail: "bleeds",
  annotation: { locator, interactive: false, rect: { x: 0.1, y: 0.9, width: 0.05, height: 0.05 }, safeInsets: { top: 0.05, bottom: 0.05, left: 0.04, right: 0.04 }, viewport: { width: 1000, height: 1000 } },
});

test("clustering: a bucket's same-type findings collapse to ONE rep card + a 'Show N more' fold; the count badge stays the TOTAL", () => {
  const cr: MinigameCrReport = {
    ...EMPTY_CR,
    blockingFailures: [
      sa("active", "TitleBar", "top"),
      sa("active", "ScoreChip", "bottom"),
      sa("active", "MenuButton", "bottom"),
      fail("active", "tinyButton"), // a different type (tap-target) → its own cluster
    ],
  };
  const html = renderMinigameReportHtml(baseReport({ status: "fail", cr }), { active: "data:image/png;base64,AAAA" });
  // One must-fix section, badge = 4 (every finding counted — nothing dropped by clustering).
  assert.match(html, /sec-t">Must fix before release<\/span><span class="rule"><\/span><span class="count ">4</);
  // The 3 safe-area findings form one "Safe area (3)" cluster: one card + a fold for the other 2.
  assert.match(html, /cluster-t">Safe area<\/span><span class="cluster-n">3</);
  assert.match(html, /<summary>Show 2 more safe area issues<\/summary>/);
  // The folded findings are FULL cards (thumbnail + highlight), just collapsed — each draws its own
  // annotated title, not a text row.
  assert.match(html, /Score Chip runs off the bottom/);
  assert.match(html, /Menu Button runs off the bottom/);
  // Honest: every finding is a full `.finding` card (3 safe-area + 1 tap-target), nothing collapsed to text.
  assert.equal(html.match(/class="finding"/g)?.length, 4, "four full finding cards (rep + folded + tap)");
  // The tap-target is its OWN cluster (one card), not folded under safe-area.
  assert.match(html, /cluster-t">Tap target<\/span><span class="cluster-n">1</);
});

test("clustering: safe-area + safe-area-sweep MERGE into one 'Safe area' cluster (related gates, one kind of problem)", () => {
  // A bare sweep with no clustered container stays in must-fix (lone) — alongside a bound safe-area finding.
  const cr: MinigameCrReport = {
    ...EMPTY_CR,
    blockingFailures: [sa("active", "HomeButton", "bottom"), sweep("active", "/Canvas/LoneDecor")],
  };
  const html = renderMinigameReportHtml(baseReport({ status: "fail", cr }), { active: "data:image/png;base64,AAAA" });
  assert.match(html, /cluster-t">Safe area<\/span><span class="cluster-n">2</, "both gates share the Safe area cluster");
});

// ── per-scene declare panel (scene-scoped candidates) ────────────────────────────

test("declare panel: backgroundDeclareGroups(report, scene) scopes candidates to that scene; global lists both", () => {
  const cr: MinigameCrReport = {
    ...EMPTY_CR,
    blockingFailures: [
      sweep("home__start", "/Canvas/Background/Cloud1", "Home"),
      sweep("home__start", "/Canvas/Background/Cloud2", "Home"),
      sweep("star-chef__active", "/Canvas/Sky/Star1", "StarChef"),
      sweep("star-chef__active", "/Canvas/Sky/Star2", "StarChef"),
    ],
  };
  const report = baseReport({ status: "fail", cr });
  const home = backgroundDeclareGroups(report, "Home").map((g) => g.container);
  const chef = backgroundDeclareGroups(report, "StarChef").map((g) => g.container);
  const all = backgroundDeclareGroups(report).map((g) => g.container);
  assert.deepEqual(home, ["/Canvas/Background"], "Home's panel offers only Home's candidate");
  assert.deepEqual(chef, ["/Canvas/Sky"], "StarChef's panel offers only StarChef's candidate");
  assert.deepEqual(all.sort(), ["/Canvas/Background", "/Canvas/Sky"], "the global panel still lists both");
  // The rendered HTML carries BOTH per-scene declare panels (one declare command each).
  const html = renderMinigameReportHtml(report, {});
  assert.match(html, /data-glob="\/Canvas\/Background"/);
  assert.match(html, /data-glob="\/Canvas\/Sky"/);
});

test("declare panel: a SCENE-LESS likely-background finding is scoped under the 'Other screens' section (panel not empty)", () => {
  // Two scene-less sweeps under one container become a likely-background cluster; in a multi-scene report
  // (a Home finding makes it multi-scene) they land in the "Other screens" section, whose declare panel
  // must still offer the container (the bug: filtering by raw f.scene===undefined missed the label).
  const cr: MinigameCrReport = {
    ...EMPTY_CR,
    blockingFailures: [
      fail("home__start", "play", "Home"),
      sweep("global", "/Canvas/Globe/Deco1"),
      sweep("global", "/Canvas/Globe/Deco2"),
    ],
  };
  const report = baseReport({ status: "fail", cr });
  assert.deepEqual(
    backgroundDeclareGroups(report, "Other screens").map((g) => g.container),
    ["/Canvas/Globe"],
    "the scene-less container is offered under 'Other screens', not dropped",
  );
  const html = renderMinigameReportHtml(report, {});
  assert.match(html, /class="scene" id="scene-other-screens">Other screens</);
  assert.match(html, /data-glob="\/Canvas\/Globe"/);
});
