/**
 * Partner-facing human report renderer for `verify --minigame` (S7b).
 *
 * Turns the machine `MinigameVerifyReport` into a one-screen, self-contained HTML
 * report (inline thumbnails, no server) + a plain-text Markdown twin for PR
 * comments. The full JSON stays the audit record; THESE are what a producer/QA
 * opens.
 *
 * The whole point of this module is LEGIBILITY WITHOUT BLURRING THE MOAT (S6d/S6e):
 *   - a capture/harness gap renders in its OWN "couldn't be tested — fix the test
 *     setup, not the game" section, NEVER under "must fix" (it is exit 2, not a game
 *     defect);
 *   - baseline drift renders in its OWN "looks different — re-approve if intended"
 *     section, NEVER as a bug;
 *   - everything speaks product language (the raw gate ids stay in the JSON).
 *
 * The HTML now DRAWS a safe-area failure: a finding that carries `annotation.rect`
 * gets an annotated screenshot (safe box + offending-element box + an overflow tag,
 * everything outside the safe box dimmed) plus a What/Where/Why/Fix card with
 * concrete-pixel guidance, all derived from LIVE captured geometry. Every other
 * finding keeps its plain humanized sentence (+ optional thumbnail).
 *
 * Pure (no disk/clock): the HTML renderer takes pre-read thumbnails as data URIs so
 * it stays unit-testable. `runVerifyMinigame` reads the PNGs and calls in.
 */

import type { GateCheckAnnotation, SeamAnnotation, SeamSegment } from "../verification/gates/types.js";
import { sceneSlug } from "./minigame-scene-inference.js";
import type {
  MinigameDeviceTag,
  MinigameFinding,
  MinigameReportStatus,
  MinigameVerifyReport,
} from "./verify-minigame.js";

/** The three partner-facing outcomes, with the banner copy each gets. */
export interface ReportBanner {
  status: MinigameReportStatus;
  /** Big label: READY / NOT READY / CAN'T VERIFY. */
  label: string;
  /** Status icon: ✅ / ❌ / 🟡. */
  icon: string;
  /** Stable tone token for CSS / styling. */
  tone: "ready" | "not-ready" | "cant-verify";
  /** A one-line plain-language summary line. */
  line: string;
}

export function bannerFor(status: MinigameReportStatus): ReportBanner {
  if (status === "pass") {
    return { status, label: "READY", icon: "✅", tone: "ready", line: "✅ Release check passed. Safe to ship." };
  }
  if (status === "fail") {
    return {
      status,
      label: "NOT READY",
      icon: "❌",
      tone: "not-ready",
      line: "❌ Not ready to ship. A real problem, or the look drifted from the approved version.",
    };
  }
  return {
    status,
    label: "CAN'T VERIFY",
    icon: "🟡",
    tone: "cant-verify",
    line: "🟡 Couldn't verify this build. The test setup didn't capture it honestly (not a game result).",
  };
}

/** A short, friendly verdict line for the banner H1 area (no em-dashes, no raw ids). */
export function verdictLine(report: MinigameVerifyReport): string {
  const n = report.cr.blockingFailures.length;
  if (report.status === "pass") {
    return '<span class="verdict">Ready to ship.</span> Every check that could run came back clean.';
  }
  if (report.status === "incomplete") {
    return '<span class="verdict">Couldn\'t verify this build.</span> The test setup didn\'t capture it honestly, so this is not a game result.';
  }
  const things = n === 1 ? "One thing needs" : `${n === 0 ? "A few things" : numberWord(n)} need${n === 1 ? "s" : ""}`;
  const rest = n > 0 ? "Everything else looks good." : "";
  return `<span class="verdict">Not ready to ship.</span> ${things} fixing before release. ${rest}`.trim();
}

/** Spell small counts as words for natural copy ("Two things need fixing"). */
function numberWord(n: number): string {
  const words = ["Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"];
  return words[n] ?? String(n);
}

/** Turn an object/state id into a readable phrase: `answerButton0` → `Answer button 0`. */
export function prettyId(id: string): string {
  const spaced = id
    .replace(/[-_]/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Za-z])([0-9])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();
  return spaced.length > 0 ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : id;
}

/** Quote a readable object/screen name for a sentence. */
function quoted(id: string): string {
  return `“${prettyId(id)}”`;
}

/** Frame/console gates grade the whole screen, not a per-object id. */
const FRAME_OR_CONSOLE_GATES: ReadonlySet<string> = new Set(["no-black-bars", "render-frame", "console-clean", "background-coverage", "background-seam"]);

/**
 * The readable subject of a per-state gate check (`required-in-frame.startButton`
 * → `Start Button`), or null for a frame/console-level check that has no per-object
 * subject. Lets non-render callers (e.g. the `nextAction` builder) speak in product
 * names instead of leaking raw `<gate>.<id>` strings.
 */
export function prettyCheckSubject(gate: string | undefined, checkId: string | undefined): string | null {
  if (!checkId) return null;
  if (gate && FRAME_OR_CONSOLE_GATES.has(gate)) return null;
  const prefix = gate ? `${gate}.` : "";
  const rest = prefix && checkId.startsWith(prefix) ? checkId.slice(prefix.length) : checkId;
  return rest.length > 0 ? prettyId(rest) : null;
}

/** Extract the object id a gate check points at (`required-in-frame.startButton` → `startButton`). */
function objectIdOf(finding: MinigameFinding): string | null {
  if (!finding.gate || !finding.id) return null;
  if (FRAME_OR_CONSOLE_GATES.has(finding.gate)) return null;
  const prefix = `${finding.gate}.`;
  const rest = finding.id.startsWith(prefix) ? finding.id.slice(prefix.length) : finding.id;
  return rest.length > 0 ? rest : null;
}

// ── safe-area-sweep background-container suggestion (Phase 2, advisory only) ─────
//
// When the sweep flags a wall of elements, the dev needs a starting point for what
// to declare in `contract.safeAreaBackground`. From the FLAGGED sweep paths we surface
// candidate CONTAINERS (a parent with ≥2 flagged children) and bracketed-index GLOBS
// (`/Canvas/Sparkle[0]`, `/Canvas/Sparkle[4]` → `/Canvas/Sparkle*`). This is ADVISORY:
// it never exempts anything and never changes the verdict — a cloud and a real score
// chip look identical, so the DEV picks the decorative ones. The candidates may include
// non-decoration containers (game tiles share a parent too); the copy makes that clear.

const SAFE_AREA_SWEEP_GATE = "safe-area-sweep";
/** Cap so a wall of findings can't spray a wall of suggestions. */
const MAX_BACKGROUND_CANDIDATES = 6;
/** The scene label a scene-less finding (a global flow/console defect) is grouped under (D6). The single
 *  source of truth so the section split and the per-scene declare panel scope agree exactly. */
const OTHER_SCENES_LABEL = "Other screens";

/** The object path a sweep finding points at (the gate sets `annotation.locator = o.path`). */
function sweepPath(finding: MinigameFinding): string | null {
  const locator = finding.annotation?.locator;
  return locator && locator.length > 0 ? locator : null;
}

/** Strip the last `/segment` to get a path's parent (`/Canvas/Background/Cloud3` → `/Canvas/Background`). */
function parentPath(path: string): string | null {
  const i = path.lastIndexOf("/");
  return i > 0 ? path.slice(0, i) : null;
}

/** Number of hierarchy segments below the root: `/Canvas` → 1, `/Canvas/Background` → 2. */
function pathDepth(path: string): number {
  return path.split("/").filter(Boolean).length;
}

/** True iff candidate `broad` (a plain path or a trailing-`*` glob) covers candidate `narrow`.
 *  Exported so the `declare-background` verb folds entries with the SAME segment-safe rule. */
export function covers(broad: string, narrow: string): boolean {
  const narrowBase = narrow.endsWith("*") ? narrow.slice(0, -1) : narrow;
  if (broad.endsWith("*")) {
    // SEGMENT-SAFE, matching the gate's `matchesBackground` glob: a `*` glob covers only its exact
    // prefix, a bracket-index sibling, or a sub-path — so `/Canvas/Star*` does NOT "cover" the
    // distinct candidate `/Canvas/StarScore` (which would wrongly drop it from the suggestion).
    const prefix = broad.slice(0, -1);
    return narrowBase === prefix || narrowBase.startsWith(`${prefix}[`) || narrowBase.startsWith(`${prefix}/`);
  }
  return narrowBase === broad || narrowBase.startsWith(`${broad}/`);
}

/**
 * Candidate `safeAreaBackground` entries derived from the FLAGGED safe-area-sweep paths.
 * Pure: paths in → candidate strings out.
 *
 *  - a PARENT with ≥2 flagged children → propose the parent container (`/Canvas/Background`);
 *  - flagged siblings matching a bracketed-index pattern `<prefix>[<n>]`, with ≥2 sharing the
 *    prefix → propose a trailing-`*` GLOB (`/Canvas/Sparkle*`) — these share NO real parent.
 *
 * Deduped, sorted by path, capped. CANNOT tell decoration from HUD by clustering alone (gameplay
 * controls share a parent too) — so `protectedPaths` (the bound required-control paths) are used
 * to DROP any candidate that would exempt a real control: a container that is an ancestor of (or
 * equals) a bound control is never proposed. The copy still tells the dev to pick decorative ones.
 */
export function backgroundContainerCandidates(
  flaggedPaths: readonly string[],
  protectedPaths: readonly string[] = [],
): string[] {
  const parentCounts = new Map<string, number>();
  const globPrefixCounts = new Map<string, number>();
  const bracketed = /^(.*)\[\d+\]$/;

  for (const path of flaggedPaths) {
    if (!path) continue;
    const m = bracketed.exec(path);
    if (m && m[1].length > 0) {
      // A bracketed-index sibling (`/Canvas/Sparkle[0]`) → count under its `<prefix>` (`/Canvas/Sparkle`).
      globPrefixCounts.set(m[1], (globPrefixCounts.get(m[1]) ?? 0) + 1);
      continue;
    }
    const parent = parentPath(path);
    if (parent) parentCounts.set(parent, (parentCounts.get(parent) ?? 0) + 1);
  }

  const candidates = new Set<string>();
  for (const [parent, n] of parentCounts) {
    if (n >= 2 && pathDepth(parent) >= 2) candidates.add(parent); // skip the bare canvas/scene root (too broad)
  }
  for (const [prefix, n] of globPrefixCounts) {
    if (n >= 2 && pathDepth(prefix) >= 2) candidates.add(`${prefix}*`);
  }
  // Never propose a container that would exempt a BOUND control (a gameplay/HUD container the
  // verifier knows is real) — `/Canvas/GameplayRoot` when AnswerButton is bound, etc.
  const safe = [...candidates].filter((c) => !protectedPaths.some((p) => covers(c, p)));
  // Drop a candidate already COVERED by a broader one (e.g. `/Canvas/Background/Balloon*` is
  // redundant under `/Canvas/Background`) so we propose the minimal, non-overlapping set.
  const minimal = safe.filter((c) => !safe.some((other) => other !== c && covers(other, c)));
  return minimal.sort().slice(0, MAX_BACKGROUND_CANDIDATES);
}

/** Candidate containers for a report's safe-area-sweep failures (empty when no sweep fails).
 *  Excludes any container that would exempt a real control — both bound required controls
 *  (`report.contract.requiredLocators`) and any flagged INTERACTIVE element (raycastTarget). */
export function backgroundCandidatesFor(report: MinigameVerifyReport): string[] {
  const sweepFailures = report.cr.blockingFailures.filter((f) => f.source === "gate" && f.gate === SAFE_AREA_SWEEP_GATE);
  const flagged = sweepFailures.map(sweepPath).filter((p): p is string => p !== null);
  if (flagged.length === 0) return [];
  // A flagged interactive element protects its container exactly like a bound control would: a
  // tappable control is never decoration, so never propose a container that would exempt it.
  const interactivePaths = sweepFailures
    .filter((f) => f.annotation?.interactive === true)
    .map(sweepPath)
    .filter((p): p is string => p !== null);
  const protectedPaths = [...(report.contract.requiredLocators ?? []), ...interactivePaths];
  return backgroundContainerCandidates(flagged, protectedPaths);
}

/**
 * Split blocking failures into the real HUD must-fix set vs the LIKELY-BACKGROUND set — the
 * safe-area-sweep findings whose element sits under a proposed background container (so they're
 * probably decoration to declare). A PRESENTATION split only: both remain exit-1 failures; this
 * just lets the report lead with "declare these as background" instead of burying real HUD issues.
 */
export function partitionBackgroundCandidates(
  blockingFailures: readonly MinigameFinding[],
  candidates: readonly string[],
): { mustFix: MinigameFinding[]; likelyBackground: MinigameFinding[] } {
  const underCandidate = (f: MinigameFinding): boolean => {
    if (f.source !== "gate" || f.gate !== SAFE_AREA_SWEEP_GATE) return false;
    // An interactive control is never "likely background" — keep it in must-fix even if it happens
    // to sit under a candidate container (belt: backgroundCandidatesFor already drops such containers).
    if (f.annotation?.interactive === true) return false;
    const path = sweepPath(f);
    return path !== null && candidates.some((c) => covers(c, path));
  };
  const mustFix: MinigameFinding[] = [];
  const likelyBackground: MinigameFinding[] = [];
  for (const f of blockingFailures) (underCandidate(f) ? likelyBackground : mustFix).push(f);
  return { mustFix, likelyBackground };
}

/** One container the dev can declare as background, with the flagged elements it covers — the unit
 *  the report's "Copy declare command" panel lists (container checkbox + per-element override). */
export interface BackgroundDeclareGroup {
  /** The candidate container glob/path written to `safeAreaBackground` when its box stays checked. */
  container: string;
  /** The likely-background elements this container covers (for the per-element override checkboxes). */
  elements: { locator: string; name: string }[];
  /**
   * True = a HIGH-CONFIDENCE clustered candidate (≥2 flagged siblings); pre-ticked in the panel and the
   * default copy-command. False = a LONE non-interactive swept element offered for per-item REVIEW — the
   * tool can't tell a single decorative image from a single real-but-undeclared control, so it is
   * default-UNticked and the dev opts it in. (Lone items stay in must-fix until declared — never silently
   * reclassified.)
   */
  confident: boolean;
}

/**
 * Group the report's likely-background findings under the candidate container that covers each — the
 * data behind the report's report-driven declaration panel. Every likely-background finding sits
 * under exactly one (minimal, non-overlapping) candidate by construction; a finding is assigned to
 * the first covering candidate. Pure. Empty when there's nothing to declare.
 *
 * `scene` (multi-scene reports) scopes the panel to ONE scene: candidates are still computed from the
 * GLOBAL flagged set (so the must-fix/likely-background partition is identical to the rest of the report),
 * but the groups/review items are built only from that scene's blocking failures. Omit `scene` ⇒ the
 * whole report (back-compat for single-scene + existing callers).
 */
export function backgroundDeclareGroups(report: MinigameVerifyReport, scene?: string): BackgroundDeclareGroup[] {
  const candidates = backgroundCandidatesFor(report);
  // Match the section scope EXACTLY as `pushSceneSections` labels it: a scene-less finding belongs to the
  // "Other screens" section (`scene ?? "Other screens"`), so scoping by the raw `f.scene` would leave that
  // section's declare panel empty. Mirror the same fallback so every section's panel covers its findings.
  const failures = scene === undefined
    ? report.cr.blockingFailures
    : report.cr.blockingFailures.filter((f) => (f.scene ?? OTHER_SCENES_LABEL) === scene);
  const { likelyBackground } = partitionBackgroundCandidates(failures, candidates);
  const groups = new Map<string, BackgroundDeclareGroup>(candidates.map((c) => [c, { container: c, elements: [], confident: true }]));
  for (const f of likelyBackground) {
    const loc = sweepPath(f);
    if (!loc) continue;
    const container = candidates.find((c) => covers(c, loc));
    if (!container) continue;
    const group = groups.get(container);
    if (group && !group.elements.some((e) => e.locator === loc)) {
      group.elements.push({ locator: loc, name: prettyId(loc.split("/").filter(Boolean).pop() ?? loc) });
    }
  }
  // Confident (clustered) groups — pre-ticked, in candidate order.
  const clusterGroups = candidates.map((c) => groups.get(c)!).filter((g) => g.elements.length > 0);

  // REVIEW groups: every LONE non-interactive swept element NOT already covered by a cluster candidate.
  // Each is its OWN single-element group (`confident:false`) so the panel can offer it default-unticked —
  // the dev declares the decorative ones and leaves any real control (which stays in must-fix). Interactive
  // elements are never offered (a control is never background). This is purely an extra DECLARE affordance:
  // it does NOT move anything out of must-fix and does NOT feed `--from-report` (grouped-only).
  const reviewGroups: BackgroundDeclareGroup[] = [];
  const offered = new Set<string>();
  for (const f of failures) {
    if (f.source !== "gate" || f.gate !== SAFE_AREA_SWEEP_GATE) continue;
    if (f.annotation?.interactive === true) continue; // never offer a control as declarable background
    const loc = sweepPath(f);
    if (!loc || offered.has(loc)) continue;
    if (candidates.some((c) => covers(c, loc))) continue; // already in a cluster group
    offered.add(loc);
    reviewGroups.push({ container: loc, elements: [{ locator: loc, name: prettyId(loc.split("/").filter(Boolean).pop() ?? loc) }], confident: false });
  }
  return [...clusterGroups, ...reviewGroups];
}

/** Render the candidate paths as a `safeAreaBackground: [...]` example literal. */
function candidateExampleLiteral(candidates: readonly string[]): string {
  return `safeAreaBackground: [${candidates.map((c) => `"${c}"`).join(", ")}]`;
}

/**
 * The advisory suggestion sentence shown beside the safe-area-sweep findings. Plain text
 * (no HTML tags) so both the Markdown twin and the terminal can reuse it; the HTML wrapper
 * escapes it. Returns "" when there are no candidates (so it's never shown spuriously).
 */
export function backgroundSuggestionText(candidates: readonly string[]): string {
  if (candidates.length === 0) return "";
  return (
    "Some of these may be background DECORATION (sky / clouds / sparkles). If so, declare their " +
    `container(s) in \`contract.safeAreaBackground\` so the sweep stops flagging them — e.g. ` +
    `${candidateExampleLiteral(candidates)}. (Only declare the decorative ones — the rule is ` +
    `'only backgrounds may bleed'.) Lone decorative pieces are listed individually in the report's ` +
    `declare panel for per-item review.`
  );
}

/** A plain-language sentence for one per-state gate failure. */
function gateSentence(finding: MinigameFinding): string {
  const objId = objectIdOf(finding);
  const obj = objId ? quoted(objId) : "A required object";
  switch (finding.gate) {
    case "required-in-frame":
      return `${obj} is off-screen or hidden.`;
    case "safe-area":
      return `${obj} sits outside the safe area (could be cut off by the device frame).`;
    case "safe-area-sweep":
      return `${obj} sits outside the safe area (could be cut off by the device frame). Only backgrounds should bleed to the edge.`;
    case "tap-target-size":
      return `${obj} is too small to tap comfortably for this age group.`;
    case "text-clipping":
      return `Text on ${obj} is clipped or cut off.`;
    case "control-overlap":
      return `${obj} overlaps another control.`;
    case "background-fit":
      return `The background behind ${obj} doesn't cover its content.`;
    case "background-coverage":
      return "The background doesn't cover the frame (a gap shows at the edges).";
    case "background-seam":
      return "A background layer's edge is visible inside the frame.";
    case "no-black-bars":
      return "The screen shows black bars or empty edges.";
    case "render-frame":
      return "The screen doesn't fill the frame correctly.";
    case "console-clean":
      return "The game logged runtime errors on this screen.";
    default:
      // Closed vocab means this is unreachable for a validated contract; fall back to
      // the engine's own detail rather than inventing copy.
      return finding.detail;
  }
}

/**
 * The plain-language sentence for ANY finding, dispatched by source. This is the
 * single mapping the doc (`MiniGameVerifyQuickstart.md` appendix) specifies, and
 * it is where the harness-vs-game wording is guaranteed: a `capture` source and a
 * flow `harness_fault` BOTH say "fix the test setup, not the game" and never the
 * word "bug"/"defect".
 */
/**
 * The DEVICE-FREE sentence for a finding (no "— on iPhone" clause). Split out so the same
 * sentence can carry either a single-device clause (`humanizeFinding`) or a grouped multi-device
 * clause (`humanizeGrouped`) — the per-device finding rows are otherwise byte-identical, and
 * listing them once-per-device buries the report (the 63-line wall this grouping collapses).
 */
function baseFindingSentence(finding: MinigameFinding): string {
  switch (finding.source) {
    case "gate":
      return gateSentence(finding);
    case "flow":
      if (finding.expectedState) {
        return `The game flow stalled${finding.transition ? ` at the ${prettyId(finding.transition)} step` : ""}. It never reached the ${quoted(finding.expectedState)} screen.`;
      }
      return finding.detail;
    case "capture":
      return `The ${finding.state ? `${quoted(finding.state)} screen` : "screen"} was never captured. Fix the test setup, not the game.`;
    case "baseline":
      return `The ${finding.state ? `${quoted(finding.state)} screen` : "screen"} looks different from the approved version. Not a bug; re-approve if intended.`;
    default:
      return finding.detail;
  }
}

/**
 * The plain-language sentence for ONE finding, dispatched by source — with the single-device
 * clause for a per-device gate finding ("… by the device frame — on iPhone (19.5:9)."). The
 * grouped report uses `humanizeGrouped` instead; this stays for single-finding/legacy callers.
 */
export function humanizeFinding(finding: MinigameFinding): string {
  const sentence = baseFindingSentence(finding);
  return finding.source === "gate" ? withDeviceClause(sentence, finding) : sentence;
}

/**
 * The sentence for a per-device GROUP: the device-free sentence with ONE clause listing every
 * affected device ("… — on 16:9, iPhone (19.5:9), Tall Android (20:9)."). This is what collapses
 * the per-device duplicate rows (the same overflow reported once per aspect) into a single line.
 */
export function humanizeGrouped(group: GroupedFinding): string {
  return withDeviceListClause(baseFindingSentence(group.finding), group.devices);
}

/**
 * A flow finding in the INCOMPLETE/harness bucket (harness_fault / missing_evidence)
 * must read as a test-setup gap, never a game result. `humanizeFinding` keys off
 * `source`/`expectedState`; for the harness bucket we phrase explicitly here so the
 * "not the game" guarantee holds regardless of the finding's fields.
 */
export function harnessFlowSentence(finding: MinigameFinding): string {
  if (finding.source === "capture") return humanizeFinding(finding);
  const where = finding.transition ? `The ${prettyId(finding.transition)} step` : "A step in the flow";
  // G8: a transition into a state that collapses sequential sub-screens can't be re-derived from a
  // single frame — it's a contract-granularity gap (split the state), NOT a dishonest tap. Surface
  // that specifically so the dev fixes the contract, not the harness. (Keyed off OUR own detail text.)
  if (/sequential sub-screens/i.test(finding.detail)) {
    const to = finding.expectedState ? `'${prettyId(finding.expectedState)}'` : "the target screen";
    return `${where} couldn't be tested: ${to} shows its controls across sequential sub-screens (the contract groups them into one state), so reaching it can't be confirmed in a single frame. Split it into one state per sub-screen — not a game bug.`;
  }
  return `${where} couldn't be tested. The tap didn't register honestly. Fix the test setup, not the game.`;
}

// ── annotated safe-area copy (pure helpers, unit-tested) ─────────────────────────

/** Round a fraction of the frame into whole pixels along the given axis. */
export function overflowPx(annotation: GateCheckAnnotation): number {
  if (!annotation.overflow || !annotation.viewport) return 0;
  const dim = annotation.overflow.edge === "left" || annotation.overflow.edge === "right"
    ? annotation.viewport.width
    : annotation.viewport.height;
  return Math.round(annotation.overflow.fraction * dim);
}

/** Name the region of the frame the captured rect sits in ("Bottom-left corner", …). */
export function regionName(rect: GateCheckAnnotation["rect"]): string {
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2; // bottom-left origin: y near 0 = bottom
  const vert = cy < 0.33 ? "Bottom" : cy > 0.66 ? "Top" : "Middle";
  const horiz = cx < 0.33 ? "left" : cx > 0.66 ? "right" : "center";
  if (vert === "Middle" && horiz === "center") return "Center of the screen";
  if (horiz === "center") return `${vert} of the screen`;
  if (vert === "Middle") return `${horiz.charAt(0).toUpperCase()}${horiz.slice(1)} side of the screen`;
  return `${vert}-${horiz} corner`;
}

/** The "Where" sentence: region + which edge crosses the safe margin, by how many px. */
export function whereCopy(annotation: GateCheckAnnotation): string {
  const region = regionName(annotation.rect);
  if (!annotation.overflow) {
    return `${region}. It sits inside the safe margin.`;
  }
  const px = overflowPx(annotation);
  const edge = annotation.overflow.edge;
  switch (edge) {
    case "left":
      return `${region}. Its left edge sits <b>${px}px inside the safe margin</b> on the side.`;
    case "right":
      return `${region}. Its right edge sits <b>${px}px inside the safe margin</b> on the side.`;
    case "bottom":
      return `${region}. Its bottom edge sits <b>${px}px below the safe margin</b>.`;
    case "top":
      return `${region}. Its top edge sits <b>${px}px above the safe margin</b>.`;
  }
}

/** The "Why" sentence: canned, per overflowing edge. */
export function whyCopy(edge: "left" | "right" | "top" | "bottom"): string {
  switch (edge) {
    case "bottom":
      return "The bottom strip is where the phone home and gesture bar live. Taps there can be swallowed by the OS.";
    case "top":
      return "The top strip is where the notch and status area live. A control this close can be clipped or hard to reach.";
    case "left":
    case "right":
      return "Real phones have rounded corners and a notch. A control this close to the side can get clipped, or be hard to tap.";
  }
}

/**
 * The "Fix" sentence: the target px the edge should reach (safe inset × frame
 * dimension), the px it sits at now, and the delta + direction. Concrete and
 * actionable, phrased like the mockup.
 */
export function fixCopy(annotation: GateCheckAnnotation): string {
  if (!annotation.overflow || !annotation.viewport || !annotation.safeInsets) {
    return "Move the control fully inside the dashed safe area.";
  }
  const { width: vw, height: vh } = annotation.viewport;
  const { left, right, top, bottom } = annotation.safeInsets;
  const r = annotation.rect;
  const edge = annotation.overflow.edge;
  const px = overflowPx(annotation);
  switch (edge) {
    case "left": {
      const targetPx = Math.round(left * vw);
      return `Move it so the left edge is at least <code>${targetPx}px</code> from the side. That is about <b>${px}px right</b>.`;
    }
    case "right": {
      const targetPx = Math.round(right * vw);
      return `Move it so the right edge stays at least <code>${targetPx}px</code> from the side. That is about <b>${px}px left</b>.`;
    }
    case "bottom": {
      const targetPx = Math.round(bottom * vh);
      return `Raise it so the bottom edge is at least <code>${targetPx}px</code> up from the bottom. That is about <b>${px}px up</b>.`;
    }
    case "top": {
      const targetPx = Math.round(top * vh);
      return `Lower it so the top edge stays at least <code>${targetPx}px</code> down from the top. That is about <b>${px}px down</b>.`;
    }
  }
}

/** A short title for the annotated card ("Home button is too close to the corner"). When the
 *  finding is grouped across devices, pass them so the title names ALL of them, not just the
 *  representative; omit `devices` (single-finding callers) to keep the lone-device clause. */
export function annotatedTitle(finding: MinigameFinding, _devices?: MinigameDeviceTag[]): string {
  const objId = objectIdOf(finding);
  const subject = objId ? prettyId(objId) : "A required control";
  const edge = finding.annotation?.overflow?.edge;
  // The title states only the symptom — the device list lives once in the screen pill below the
  // title (the redesign dropped the redundant "— on 16:9, iPhone…" tail that repeated that line).
  // A sweep finding is "this element bleeds past the safe area" — it may be a control to move OR
  // decoration to declare, so the title states the symptom, not "move it" (the fix copy forks).
  if (finding.gate === "safe-area-sweep") return `${subject} bleeds past the safe area`;
  if (edge === "bottom") return `${subject} runs off the bottom`;
  if (edge === "top") return `${subject} runs off the top`;
  return `${subject} is too close to the edge`;
}

// ── shared content model (so HTML + MD render the same thing) ──────────────────

interface ReportItem {
  finding: MinigameFinding;
  sentence: string;
  /** The LOGICAL state id (used for screen wording). */
  state?: string;
  /** The thumbnail / statePaths key: `<state>@<device>` for a per-device finding (Phase 4),
   * else the plain `<state>`. The renderer draws the PER-DEVICE screenshot from this. */
  thumbKey?: string;
  /** Every device this (grouped) finding fails on — the annotated card names them all. */
  devices?: MinigameDeviceTag[];
  /** Every screen this (grouped) finding spans — the screen label names them all (a persistent
   *  element clubbed across screens reads "On the Start and Active screens"). */
  states?: string[];
}

/** The thumbnail / statePaths key for a finding — per-device when it carries a device tag. */
function thumbKeyFor(finding: MinigameFinding): string | undefined {
  if (!finding.state) return undefined;
  return finding.device ? `${finding.state}@${finding.device.id}` : finding.state;
}

/** A trailing " — on iPhone (19.5:9)" clause for a per-device finding (Phase 4), else "". */
function deviceClause(finding: MinigameFinding): string {
  return finding.device ? ` — on ${finding.device.label}` : "";
}

/**
 * Append the device clause INSIDE the sentence's terminal period so a per-device gate
 * finding reads "… by the device frame — on iPhone (19.5:9)." A finding with no device
 * (old single-aspect pack / device-invariant gate) is returned unchanged.
 */
function withDeviceClause(sentence: string, finding: MinigameFinding): string {
  if (!finding.device) return sentence;
  const clause = deviceClause(finding);
  return sentence.endsWith(".") ? `${sentence.slice(0, -1)}${clause}.` : `${sentence}${clause}`;
}

/**
 * Like `withDeviceClause`, but lists EVERY affected device ("— on 16:9, iPhone (19.5:9), Tall
 * Android (20:9)") inside the terminal period. Empty list → unchanged (a device-invariant finding).
 */
function withDeviceListClause(sentence: string, devices: MinigameDeviceTag[]): string {
  if (devices.length === 0) return sentence;
  const clause = ` — on ${devices.map((d) => d.label).join(", ")}`;
  return sentence.endsWith(".") ? `${sentence.slice(0, -1)}${clause}.` : `${sentence}${clause}`;
}

/** A logical finding plus every device it fails on — the unit the human report lists once. */
export interface GroupedFinding {
  /** The representative finding (first failing device) — its geometry/thumbnail drive the card. */
  finding: MinigameFinding;
  /** Every device this logical finding fails on, in first-appearance order. `[]` = device-invariant. */
  devices: MinigameDeviceTag[];
  /** Every SCREEN this logical finding was flagged on, in first-appearance order. A persistent
   *  element (chrome / background) flagged identically on several screens is clubbed into one group
   *  spanning them all; `[]` = no screen (device-invariant flow/console). */
  states: string[];
}

/**
 * Collapse per-device duplicates: findings sharing a logical identity (source + state + gate +
 * object id + transition) differ only by the device they were graded at, so list them ONCE with
 * the devices named. A device-invariant finding (no `device` — flow / capture / console) is never
 * merged (each keeps its own group). First-appearance order is preserved. Pure.
 */
/**
 * A stable signature of a finding's QUALITATIVE defect — which edge it bleeds past, or that it is
 * too small to tap — so the SAME element flagged the SAME WAY on several screens clubs into one row.
 * A persistent home button or a background layer is one issue, not one-per-screen. Deliberately NOT
 * keyed on the magnitude (overflow fraction / exact dp) or the rect position: those vary by a few px
 * between screens (a cloud drifts along the top edge; a button is laid out a hair smaller on one
 * screen), but "bleeds past the top" / "too small to tap" is the same thing to fix — and the grouped
 * row already shows only the representative device's px anyway (per-device grouping, #177). A
 * genuinely different defect (a DIFFERENT overflowing edge) yields a different key and stays its own
 * row. Empty when the finding has no such geometry, in which case it is NEVER clubbed across screens
 * (we can't prove two screens' geometry-less findings are the same defect — e.g. console errors).
 */
function findingGeometryKey(finding: MinigameFinding): string {
  const a = finding.annotation;
  if (!a) return "";
  const parts: string[] = [];
  if (a.overflow) parts.push(`o:${a.overflow.edge}`);
  if (a.tapTarget) parts.push("t:small");
  return parts.join("|");
}

/** Internal grouping accumulator: a GroupedFinding plus the per-device geometry seen so far (used to
 *  keep a genuinely different per-screen position as its own row, never silently clubbed). */
interface MutableGroup extends GroupedFinding {
  geomByDevice: Map<string, string>;
}

/**
 * Collapse duplicate rows on two axes:
 *  - per-DEVICE: findings sharing (source + gate + object id + transition) that differ only by the
 *    device they were graded at are listed ONCE with the devices named (the wall this began as was
 *    mostly the same overflow reported once per aspect);
 *  - per-SCREEN: a finding with identical DRAWN geometry (same `findingGeometryKey` for a given
 *    device) flagged on several screens is the SAME physical element — a persistent home button /
 *    background layer — so it is clubbed into one row spanning those screens. A finding with NO
 *    geometry stays per-screen (can't prove same defect); a same-element finding whose geometry
 *    DIFFERS on another screen stays its own row (it moved).
 * A device-invariant finding (no `device` — flow / capture / console) is never merged. Pure.
 */
export function groupFindingsByDevice(findings: readonly MinigameFinding[]): GroupedFinding[] {
  const order: MutableGroup[] = [];
  const byKey = new Map<string, MutableGroup>();
  let invariantSeq = 0;
  const create = (key: string, f: MinigameFinding, geom: string): void => {
    const group: MutableGroup = {
      finding: f,
      devices: f.device ? [f.device] : [],
      states: f.state ? [f.state] : [],
      geomByDevice: new Map(f.device ? [[f.device.id, geom]] : []),
    };
    byKey.set(key, group);
    order.push(group);
  };
  for (const f of findings) {
    if (!f.device) {
      // Device-invariant (flow / capture / console): never merged — each keeps its own group.
      create(`\x00invariant\x00${invariantSeq++}`, f, "");
      continue;
    }
    const geom = findingGeometryKey(f);
    // With geometry, drop the screen from the key so the same element clubs across screens; without
    // it, keep the screen (we can't prove two screens' geometry-less findings are the same defect).
    let key = geom
      ? `${f.source}|${f.gate ?? ""}|${f.id ?? ""}|${f.transition ?? ""}`
      : `${f.source}|${f.state ?? ""}|${f.gate ?? ""}|${f.id ?? ""}|${f.transition ?? ""}`;
    let group = byKey.get(key);
    // Same element + same device but a DIFFERENT geometry on another screen => a distinct defect (it
    // moved): qualify the key by screen so clubbing never hides a real per-screen difference.
    if (group && geom) {
      const prior = group.geomByDevice.get(f.device.id);
      if (prior !== undefined && prior !== geom) {
        key = `${key}|@${f.state ?? ""}`;
        group = byKey.get(key);
      }
    }
    if (group) {
      if (!group.devices.some((d) => d.id === f.device!.id)) group.devices.push(f.device);
      if (f.state && !group.states.includes(f.state)) group.states.push(f.state);
      if (!group.geomByDevice.has(f.device.id)) group.geomByDevice.set(f.device.id, geom);
    } else {
      create(key, f, geom);
    }
  }
  return order.map(({ finding, devices, states }) => ({ finding, devices, states }));
}

/** "the Start screen" / "the Start and Active screens" — names every screen a clubbed finding spans. */
function screensPhrase(states: readonly string[]): string {
  const names = states.map(prettyId);
  if (names.length === 0) return "the screen";
  if (names.length === 1) return `the ${names[0]} screen`;
  if (names.length === 2) return `the ${names[0]} and ${names[1]} screens`;
  return `the ${names.slice(0, -1).join(", ")} and ${names[names.length - 1]} screens`;
}

interface ReportSection {
  heading: string;
  /** The scene this section's findings belong to (multi-scene contracts only, D6). Rendered as a label
   *  AFTER the heading's trailing count so the count-badge parsing stays intact, and used to keep the
   *  HTML anchor id unique across a bucket that splits into one section per scene. Absent ⇒ single-scene. */
  scene?: string;
  /** Whether this is the dedicated outcome-gated "not asserted" block (collapsed copy). */
  outcomeGated?: boolean;
  /** A prominent "declare these as background" call-to-action shown at the TOP of this section
   * (the likely-background bucket) — so the dev's first move is to declare, not fix 49 things. */
  declareCTA?: string;
  /** Fold the findings behind a `<details>` in HTML (count + CTA stay visible). Set on the
   *  likely-background bucket: those are auto-detected candidates, not user-declared, so they
   *  shouldn't dominate the page — the dev expands them only to confirm what to declare. */
  collapsed?: boolean;
  /** Each item carries the whole finding so the HTML can draw an annotation when present. */
  items: ReportItem[];
}

/** A short "what passed" summary line from the CR passed-gates + flow. */
function passedSummary(report: MinigameVerifyReport): string {
  const labels: Record<string, string> = {
    "required-in-frame": "required objects visible",
    "safe-area": "safe area",
    "safe-area-sweep": "all HUD inside the safe area",
    "tap-target-size": "tap-target size",
    "text-clipping": "no clipped text",
    "control-overlap": "no overlapping controls",
    "background-fit": "backgrounds fit",
    "background-coverage": "background covers the frame",
    "background-seam": "background edges are hidden",
    "no-black-bars": "no black bars",
    "render-frame": "frame fills the screen",
    "console-clean": "no runtime errors",
  };
  const seen = new Set<string>();
  for (const gates of Object.values(report.cr.passedGates)) {
    for (const g of gates) if (labels[g]) seen.add(labels[g]);
  }
  const parts = [...seen];
  if (report.flow?.outcome === "pass") {
    parts.push(`game flow (${report.flow.transitions.length}/${report.flow.transitions.length})`);
  }
  return parts.length > 0 ? parts.join(", ") : "nothing yet";
}

/** A grouped ReportItem: one row per logical finding, with the per-device duplicates collapsed. */
function groupedItems(
  findings: MinigameFinding[],
  sentenceFor: (g: GroupedFinding) => string,
): ReportItem[] {
  return groupFindingsByDevice(findings).map((g) => ({
    finding: g.finding,
    sentence: sentenceFor(g),
    state: g.finding.state,
    thumbKey: thumbKeyFor(g.finding),
    devices: g.devices,
    states: g.states,
  }));
}

/** True when any finding carries a scene — i.e. a multi-scene contract whose report groups under each
 *  scene. A single-scene contract has no scene on any finding ⇒ false ⇒ the report renders flat. */
function isMultiScene(cr: MinigameVerifyReport["cr"]): boolean {
  return [
    cr.blockingFailures, cr.baselineRegressions, cr.incompleteHarness,
    cr.warnings, cr.advisoryNotes, cr.notAssertedOutcomeGated,
  ].some((arr) => arr.some((f) => f.scene !== undefined));
}

/** The scenes present in `findings`, in first-appearance order; scene-less findings (a global flow /
 *  console finding) sort LAST under an explicit `undefined` bucket so nothing is dropped. */
function scenesInOrder(findings: readonly MinigameFinding[]): (string | undefined)[] {
  const order: string[] = [];
  const seen = new Set<string>();
  let hasUndef = false;
  for (const f of findings) {
    if (f.scene === undefined) { hasUndef = true; continue; }
    if (!seen.has(f.scene)) { seen.add(f.scene); order.push(f.scene); }
  }
  return hasUndef ? [...order, undefined] : order;
}

/**
 * Emit a report bucket as ONE section (single-scene) or, when the report spans scenes, one section per
 * scene (ordered by first appearance) tagged with `section.scene` — so the report reads grouped under
 * Home / StarChef (D6). The verdict stays global; this only splits the display. `build` receives a
 * same-scene subset + the scene (undefined for single-scene or the scene-less "Other screens" bucket)
 * and returns the section. Single-scene reports call `build(all, undefined)` once ⇒ byte-identical.
 */
function pushSceneSections(
  sections: ReportSection[],
  findings: MinigameFinding[],
  multiScene: boolean,
  build: (subset: MinigameFinding[], scene: string | undefined) => ReportSection,
): void {
  if (!multiScene) {
    sections.push(build(findings, undefined));
    return;
  }
  for (const scene of scenesInOrder(findings)) {
    const subset = findings.filter((f) => f.scene === scene);
    if (subset.length === 0) continue;
    sections.push(build(subset, scene ?? OTHER_SCENES_LABEL));
  }
}

/** Build the ordered, non-empty sections the report shows. Per-device findings are GROUPED so the
 *  same overflow reported across N device aspects shows as one row (count = distinct issues). For a
 *  multi-scene contract, each bucket is further split into one section per scene (D6). */
function buildSections(report: MinigameVerifyReport): ReportSection[] {
  const cr = report.cr;
  const sections: ReportSection[] = [];
  const multiScene = isMultiScene(cr);

  if (cr.blockingFailures.length > 0) {
    // De-noise the dominant content: split the real HUD issues from the likely-background sweep
    // findings (decoration the sweep flags until declared). Both stay exit-1 failures; the
    // background bucket just leads with the declare call-to-action instead of burying the rest.
    const candidates = backgroundCandidatesFor(report);
    const { mustFix, likelyBackground } = partitionBackgroundCandidates(cr.blockingFailures, candidates);
    if (mustFix.length > 0) {
      pushSceneSections(sections, mustFix, multiScene, (subset, scene) => {
        const items = groupedItems(subset, humanizeGrouped);
        return { heading: `Must fix before release (${items.length})`, scene, items };
      });
    }
    if (likelyBackground.length > 0) {
      pushSceneSections(sections, likelyBackground, multiScene, (subset, scene) => {
        const items = groupedItems(subset, humanizeGrouped);
        return {
          heading: `Likely background decoration — declare to dismiss (${items.length})`,
          scene,
          declareCTA: backgroundSuggestionText(candidates),
          collapsed: true,
          items,
        };
      });
    }
  }
  if (cr.baselineRegressions.length > 0) {
    pushSceneSections(sections, cr.baselineRegressions, multiScene, (subset, scene) => {
      const items = groupedItems(subset, humanizeGrouped);
      return { heading: `Looks different from the approved version (${items.length})`, scene, items };
    });
  }
  if (cr.incompleteHarness.length > 0) {
    pushSceneSections(sections, cr.incompleteHarness, multiScene, (subset, scene) => {
      const items = groupedItems(subset, (g) => harnessFlowSentence(g.finding));
      return { heading: `Couldn't be tested (${items.length})`, scene, items };
    });
  }
  if (cr.warnings.length > 0) {
    pushSceneSections(sections, cr.warnings, multiScene, (subset, scene) => {
      const items = groupedItems(subset, humanizeGrouped);
      return { heading: `Warnings (${items.length})`, scene, items };
    });
  }
  if (cr.notAssertedOutcomeGated.length > 0) {
    pushSceneSections(sections, cr.notAssertedOutcomeGated, multiScene, (subset, scene) => ({
      heading: `Not asserted (outcome-gated) (${subset.length})`,
      scene,
      outcomeGated: true,
      // The finding's OWN detail carries the outcome-gated wording — never the harness phrasing.
      items: subset.map((f) => ({ finding: f, sentence: f.detail ?? "not asserted (outcome-gated)", state: f.state })),
    }));
  }
  return sections;
}

// ── scene-first regrouping + issue-type clustering (presentation only) ───────────
//
// D6 gave us per-scene SECTIONS; this puts the SCENE at the top level so a scene owns ALL its buckets
// (must-fix, likely-background, …) + its own declare panel, and within a bucket the same-TYPE findings
// CLUSTER (one representative card + the rest folded) so a wall of near-identical safe-area cards
// collapses to one line. Pure presentation — counts, the must-fix/likely-background partition, and the
// verdict are all untouched; every finding stays visible (a card or a folded row).

/** A scene and the report sections (buckets) that belong to it, in bucket-priority order. `scene`
 *  undefined ⇒ single-scene (no scene header; the flat pre-D6 layout). */
interface ReportSceneGroup {
  scene?: string;
  sections: ReportSection[];
}

/**
 * Regroup the flat bucket×scene sections from `buildSections` so the SCENE is the top level: each group
 * holds one scene's buckets in priority order. A single-scene report (no finding carries a scene) returns
 * ONE group with `scene: undefined` ⇒ the renderers emit the flat layout unchanged. Scenes appear in
 * first-appearance order; scene-less "Other screens" sections form their own trailing group. Pure.
 */
function groupSectionsByScene(report: MinigameVerifyReport): ReportSceneGroup[] {
  const sections = buildSections(report);
  if (!isMultiScene(report.cr)) return [{ scene: undefined, sections }];
  const order: string[] = [];
  const seen = new Set<string>();
  for (const s of sections) {
    const key = s.scene ?? "";
    if (!seen.has(key)) { seen.add(key); order.push(key); }
  }
  return order.map((scene) => ({
    scene: scene || undefined,
    sections: sections.filter((s) => (s.scene ?? "") === scene),
  }));
}

/** The human cluster label for a finding's issue TYPE — related gates merge (safe-area + sweep →
 *  "Safe area"; background-* → "Background") so the report shows one cluster per KIND of problem. */
function issueTypeLabel(finding: MinigameFinding): string {
  if (finding.source === "gate") {
    switch (finding.gate) {
      case "required-in-frame": return "Missing element";
      case "safe-area":
      case "safe-area-sweep": return "Safe area";
      case "tap-target-size": return "Tap target";
      case "text-clipping": return "Clipped text";
      case "control-overlap": return "Overlapping controls";
      case "background-fit":
      case "background-coverage":
      case "background-seam": return "Background";
      case "no-black-bars":
      case "render-frame": return "Frame";
      case "console-clean": return "Runtime errors";
      default: return "Other";
    }
  }
  switch (finding.source) {
    case "flow": return "Game flow";
    case "capture": return "Not captured";
    case "baseline": return "Looks different";
    default: return "Other";
  }
}

/** One issue-type cluster within a bucket: a label + the (already device/screen-grouped) items of that type. */
interface IssueCluster {
  label: string;
  items: ReportItem[];
}

/** Group a section's items by issue-type label, first-appearance order preserved. Pure. */
function clusterItems(items: readonly ReportItem[]): IssueCluster[] {
  const order: IssueCluster[] = [];
  const byLabel = new Map<string, IssueCluster>();
  for (const item of items) {
    const label = issueTypeLabel(item.finding);
    let cluster = byLabel.get(label);
    if (!cluster) {
      cluster = { label, items: [] };
      byLabel.set(label, cluster);
      order.push(cluster);
    }
    cluster.items.push(item);
  }
  return order;
}

/** The subtitle stats line shown under the title. */
function statsLine(report: MinigameVerifyReport): string {
  const s = report.summary;
  const flow = report.flow ? ` · flow ${report.flow.transitions.filter((t) => t.status === "pass").length}/${report.flow.transitions.length}` : "";
  let baseline = "";
  if (report.baseline) {
    baseline = report.baseline.present
      ? ` · baseline: approved ${report.baseline.capturedAt ?? "?"}`
      : " · baseline: not approved yet";
  }
  return `Tested ${s.statesGraded}/${s.statesTotal} screens · ${s.checksTotal} checks${flow}${baseline}`;
}

function title(report: MinigameVerifyReport): string {
  return report.contract.title ?? report.contract.id;
}

// ── Markdown ───────────────────────────────────────────────────────────────────

/** A one-line, plain-text safe-area fix note (px overflow + direction) for the MD twin. */
function safeAreaMarkdownNote(annotation: GateCheckAnnotation): string {
  const px = overflowPx(annotation);
  const edge = annotation.overflow?.edge;
  if (!edge) return "";
  const where =
    edge === "bottom" ? `${px}px below the safe margin` :
    edge === "top" ? `${px}px above the safe margin` :
    `${px}px inside the safe margin`;
  const fix = stripTags(fixCopy(annotation));
  return ` (${where}. ${fix})`;
}

/** Drop the inline `<b>`/`<code>` tags so a derived HTML sentence reads plainly in Markdown. */
function stripTags(html: string): string {
  return html.replace(/<\/?(?:b|code)>/g, "");
}

/** Render the report as plain Markdown (PR-comment friendly). Pure. */
export function renderMinigameReportMarkdown(report: MinigameVerifyReport): string {
  const banner = bannerFor(report.status);
  const lines: string[] = [];
  lines.push(`# ${title(report)} · Release check: ${banner.label}`);
  lines.push("");
  lines.push(banner.line);
  lines.push("");
  lines.push(`_${statsLine(report)}_`);
  lines.push("");
  // The report reads SCENE-first: a multi-scene group leads with `## Scene` and nests its buckets at
  // `### bucket`; a single-scene group has no scene heading and keeps its buckets at `## bucket`
  // (byte-compatible with the pre-scene-grouping layout). The declare CTA is rendered PER SCENE.
  for (const group of groupSectionsByScene(report)) {
    const multi = group.scene !== undefined;
    if (multi) {
      lines.push(`## ${group.scene}`);
      lines.push("");
    }
    const bucketHeading = multi ? "###" : "##";
    for (const section of group.sections) {
      lines.push(`${bucketHeading} ${section.heading}`);
      if (section.outcomeGated) {
        lines.push(
          `${section.items.length} screen(s) and step(s) could not be auto-tested, and that is expected, not a failure. The verifier looks at the game, it does not play it. These only show after the game's own answer, which it shuffles each round, so a look-only check cannot reliably reach them.`,
        );
        for (const item of section.items) {
          const label = item.finding.transition ? `the ${prettyId(item.finding.transition)} step` : `the ${prettyId(item.finding.state ?? "screen")} screen`;
          lines.push(`- ${label}`);
        }
      } else {
        // The declare call-to-action leads the (scene-scoped) likely-background section, never silences
        // anything — the findings stay failures until declared.
        if (section.declareCTA) {
          lines.push(`🎨 ${section.declareCTA}`, "");
        }
        // Cluster the findings by issue type; emit a bold per-type sub-label only when the bucket spans
        // more than one type (a single-type bucket's heading count already conveys it).
        const clusters = clusterItems(section.items);
        const labelClusters = clusters.length > 1;
        for (const cluster of clusters) {
          if (labelClusters) lines.push(`**${cluster.label} (${cluster.items.length})**`);
          for (const item of cluster.items) {
            const note = item.finding.annotation?.rect ? safeAreaMarkdownNote(item.finding.annotation) : "";
            lines.push(`- ${item.sentence}${note}`);
          }
        }
      }
      lines.push("");
    }
  }
  lines.push(`**Passed:** ${passedSummary(report)}`);
  lines.push("");
  lines.push(`**Next:** ${report.nextAction}`);
  lines.push("");
  return lines.join("\n");
}

// ── HTML ─────────────────────────────────────────────────────────────────────

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Escape a plain string, then turn its backtick spans into <code> (so `loomtide verify` reads as code). */
function escapeWithCode(text: string): string {
  return escapeHtml(text).replace(/`([^`]+)`/g, (_m, code) => `<code>${code}</code>`);
}

/**
 * Split the machine `nextAction` into scannable bullets for the HTML report. Clauses are `; `-joined,
 * and a "fix X, then re-capture and re-run" clause splits again on ", then" so each action is its own
 * bullet. The background-suggestion clause is dropped here — the declare panel above already covers it.
 * One clause → one bullet. First letter capitalized.
 */
function nextStepBullets(report: MinigameVerifyReport): string[] {
  return report.nextAction
    .replace(/\.\s*$/, "")
    .split("; ")
    .filter((s) => !/^\s*Some of these may be background DECORATION/i.test(s))
    .flatMap((s) => s.split(/,\s+then\s+/i))
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1));
}

const STYLE = `
:root{
  color-scheme: light;
  --bg:#f4f5f7; --card:#ffffff; --card-2:#fbfbfc;
  --ink:#14171c; --ink-2:#3a4049; --muted:#6e747f; --faint:#9aa0ac;
  --line:#e7e9ee; --hair:#eef0f3;
  --brand:#5457d6; --brand-2:#4843cc;
  --red:#d4343a; --red-ink:#b42318; --red-bg:#fef3f2; --red-line:#f7cdc9;
  --amber:#b66a06; --amber-ink:#92520a; --amber-bg:#fdf6ec; --amber-line:#f4e0bb;
  --green:#1f9254; --green-ink:#157347; --green-bg:#eefaf1; --green-line:#bfe8cd;
  --slate:#5b6270; --slate-bg:#f1f3f6; --slate-line:#e2e6ec;
  --sh-xs:0 1px 2px rgba(20,23,28,.05);
  --sh-sm:0 1px 2px rgba(20,23,28,.04), 0 2px 6px rgba(20,23,28,.05);
  --sh-md:0 2px 4px rgba(20,23,28,.04), 0 10px 28px rgba(20,23,28,.08);
  --sans:"Hanken Grotesk", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --mono:"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{font-family:var(--sans); font-size:15px; line-height:1.6; color:var(--ink);
  background:var(--bg); margin:0; padding:0;
  -webkit-font-smoothing:antialiased; text-rendering:optimizeLegibility;}
.wrap{max-width:940px; margin:0 auto; padding:0 24px 84px;}
a{color:var(--brand); text-decoration:none}
code{font-family:var(--mono); font-size:.86em}
::selection{background:rgba(84,87,214,.16)}

/* topbar */
.topbar{display:flex; align-items:center; justify-content:space-between; gap:16px; padding:22px 0 0; margin-bottom:30px;}
.brand{display:flex; align-items:center; gap:11px; font-weight:700; letter-spacing:-.01em; color:var(--ink); font-size:15px}
.brand .mark{width:28px;height:28px;border-radius:8px;display:grid;place-items:center;
  background:linear-gradient(150deg,#5e60e0,#8482f2); box-shadow:0 2px 6px rgba(84,87,214,.35)}
.brand .mark svg{width:17px;height:17px}
.brand .sub{color:var(--faint); font-weight:500}
.topbar .cmd{font-family:var(--mono); font-size:12px; color:var(--muted);
  background:var(--card); border:1px solid var(--line); border-radius:8px; padding:6px 11px; box-shadow:var(--sh-xs)}

/* hero */
.hero{position:relative; background:var(--card); border:1px solid var(--line); border-radius:18px;
  padding:30px 32px; box-shadow:var(--sh-md); overflow:hidden;}
.hero::before{content:""; position:absolute; left:0; right:0; top:0; height:130px; pointer-events:none;
  background:linear-gradient(180deg, rgba(212,52,58,.05), rgba(212,52,58,0));}
.hero.ready::before{background:linear-gradient(180deg, rgba(31,146,84,.06), transparent);}
.eyebrow{display:inline-flex; align-items:center; gap:8px; font-size:11.5px; font-weight:700;
  letter-spacing:.13em; text-transform:uppercase; color:var(--faint); margin:0 0 14px}
.eyebrow .tick{width:6px;height:6px;border-radius:50%;background:var(--red)}
.hero h1{margin:0; font-size:30px; line-height:1.12; font-weight:800; letter-spacing:-.025em; color:var(--ink)}
.verdict-row{display:flex; align-items:center; gap:13px; margin:20px 0 0}
.vicon{flex:0 0 auto; width:40px;height:40px}
.verdict{font-size:20px; font-weight:800; letter-spacing:-.015em; color:var(--red-ink)}
.hero.ready .verdict{color:var(--green-ink)}
.hero.cant-verify::before{background:linear-gradient(180deg, rgba(182,106,6,.06), transparent)}
.hero.cant-verify .verdict{color:var(--amber-ink)}
.hero.ready .eyebrow .tick{background:var(--green)}
.hero.cant-verify .eyebrow .tick{background:var(--amber)}
.vsub{margin:12px 0 0; color:var(--ink-2); font-size:15px; line-height:1.55}
.vsub b{color:var(--red-ink); font-weight:700}
.hero-meta{display:flex; flex-wrap:wrap; gap:8px; margin-top:24px; padding-top:22px; border-top:1px solid var(--hair)}
.tag-pill{display:inline-flex; align-items:center; gap:7px; font-size:12.5px; font-weight:550;
  color:var(--slate); background:var(--slate-bg); border:1px solid var(--slate-line); border-radius:8px; padding:5px 11px}
.tag-pill svg{width:14px;height:14px;opacity:.75}

/* scorecard */
.scorecard{margin-top:16px; background:var(--card); border:1px solid var(--line); border-radius:18px; box-shadow:var(--sh-sm); overflow:hidden}
.ratiobar{display:flex; height:6px; width:100%}
.ratiobar i{display:block; height:100%}
.ratiobar i.green{background:#34c277} .ratiobar i.red{background:#e5565b}
.ratiobar i.amber{background:#e0a03a} .ratiobar i.slate{background:#c6ccd6}
.score-grid{display:grid; grid-template-columns:repeat(4,1fr)}
.stat{display:block; padding:18px 20px; border-right:1px solid var(--hair); text-decoration:none; color:inherit; position:relative; transition:background .15s}
.stat:last-child{border-right:0}
a.stat:hover{background:var(--card-2)}
.stat .n{display:flex; align-items:center; gap:8px; font-size:27px; font-weight:800; letter-spacing:-.025em; color:var(--ink); line-height:1}
.stat .dot{width:8px;height:8px;border-radius:50%; flex:0 0 auto}
.stat.green .dot{background:var(--green)} .stat.green .n{color:var(--green-ink)}
.stat.red .dot{background:var(--red)} .stat.red .n{color:var(--red-ink)}
.stat.amber .dot{background:var(--amber)} .stat.slate .dot{background:var(--slate)}
.stat .l{margin-top:6px; font-size:13px; color:var(--muted); font-weight:550}
.stat .arrow{position:absolute; top:19px; right:16px; opacity:0; color:var(--faint); transition:opacity .15s, transform .15s}
.stat .arrow svg{width:14px;height:14px;display:block}
a.stat:hover .arrow{opacity:1; transform:translateX(2px)}

/* section header */
.sec{display:flex; align-items:center; gap:13px; margin:48px 0 18px; scroll-margin-top:18px}
.sec .sec-num{font-family:var(--mono); font-size:12px; font-weight:600; color:var(--faint)}
.sec .sec-t{font-size:18px; font-weight:700; letter-spacing:-.02em; color:var(--ink)}
.sec .rule{flex:1; height:1px; background:var(--hair)}
.sec .count{font-size:12px; font-weight:700; color:#fff; background:var(--red); border-radius:999px; padding:2px 9px; min-width:23px; text-align:center}
.sec .count.amber{background:var(--amber)} .sec .count.slate{background:var(--slate)} .sec .count.green{background:var(--green)}

/* finding */
.finding{background:var(--card); border:1px solid var(--line); border-radius:16px; box-shadow:var(--sh-sm);
  margin-bottom:16px; overflow:hidden; display:grid; grid-template-columns:420px 1fr; transition:box-shadow .18s, border-color .18s}
.finding:hover{box-shadow:var(--sh-md); border-color:#dfe2e8}
.finding.noshot{grid-template-columns:1fr}
@media(max-width:780px){.finding{grid-template-columns:1fr}}
.shot{position:relative; align-self:start; background:#0b0d10; border-right:1px solid var(--line); cursor:zoom-in; overflow:hidden}
@media(max-width:780px){.shot{border-right:0; border-bottom:1px solid var(--line)}}
.shot img{display:block; width:100%; height:auto}
.ovl{position:absolute; inset:0}
.safe{position:absolute; border:1.5px dashed rgba(255,255,255,.92); border-radius:5px; box-shadow:0 0 0 9999px rgba(11,13,16,.34)}
.elem{position:absolute; border:2px solid var(--red); border-radius:6px; background:rgba(229,86,91,.22); box-shadow:0 0 0 2px rgba(255,255,255,.55)}
.target{position:absolute; border:2px dashed #46d488; border-radius:8px; box-shadow:0 0 0 9999px rgba(11,13,16,.2)}
.tag{position:absolute; display:inline-flex; align-items:center; gap:5px; background:var(--red); color:#fff;
  font-family:var(--sans); font-size:11px; font-weight:600; line-height:1.4; padding:3px 8px; border-radius:7px; white-space:nowrap; box-shadow:0 2px 8px rgba(0,0,0,.32)}
.seamstrip{position:absolute;background:rgba(229,86,91,.28);box-shadow:0 0 0 1px rgba(229,86,91,.4) inset}
.seamline{position:absolute;border:0 solid var(--red);box-shadow:0 0 0 1px rgba(255,255,255,.45)}
.legend{position:absolute; left:10px; bottom:10px; display:flex; gap:12px; font-size:10.5px; color:#fff;
  background:rgba(11,13,16,.6); padding:5px 9px; border-radius:8px}
.legend i{font-style:normal; display:inline-flex; align-items:center; gap:5px}
.legend .sw-safe{width:14px;border-top:2px dashed #fff;display:inline-block}
.legend .sw-elem{width:11px;height:11px;border:2px solid var(--red);background:rgba(229,86,91,.3);border-radius:3px;display:inline-block}
.legend .sw-target{width:12px;height:12px;border:2px dashed #46d488;border-radius:3px;display:inline-block}
.legend .sw-seam{width:14px;border-top:2px solid var(--red);display:inline-block}
.zoomhint{position:absolute; top:9px; right:9px; font-size:10px; font-weight:550; color:#fff;
  background:rgba(11,13,16,.5); padding:3px 8px; border-radius:7px; opacity:.92; display:inline-flex; align-items:center; gap:4px}

/* detail */
.detail{padding:20px 22px; display:flex; flex-direction:column}
.detail .ttl{font-weight:700; font-size:15.5px; line-height:1.35; letter-spacing:-.01em; margin:0 0 9px; color:var(--ink)}
.detail .screen{display:inline-flex; align-self:flex-start; align-items:center; gap:6px; font-size:11.5px; color:var(--muted);
  font-weight:550; background:var(--slate-bg); border:1px solid var(--slate-line); border-radius:7px; padding:3px 9px; margin:0 0 14px}
.row{display:grid; grid-template-columns:52px 1fr; gap:12px; padding:10px 0; border-top:1px solid var(--hair)}
.row .k{font-size:10.5px; color:var(--faint); font-weight:700; text-transform:uppercase; letter-spacing:.06em; padding-top:2px}
.row .v{margin:0; color:var(--ink-2); font-size:14px; line-height:1.55}
.row .v b{color:var(--red-ink); font-weight:700}
.fix{margin-top:14px; background:var(--green-bg); border:1px solid var(--green-line); border-radius:11px; padding:11px 14px}
.fix .row{border:0; padding:0}
.fix .k{color:var(--green-ink)}
.fix .v b{color:var(--green-ink)}
.fix code{background:#fff; border:1px solid var(--green-line); border-radius:6px; padding:1px 6px; color:var(--green-ink)}
.path{margin:14px 0 0; font-size:11.5px; color:var(--faint); display:flex; align-items:center; gap:7px}
.path::before{content:"PATH"; font-family:var(--mono); font-size:9px; font-weight:600; letter-spacing:.08em; color:var(--faint); background:var(--slate-bg); border:1px solid var(--hair); padding:2px 5px; border-radius:4px}
.path code{background:var(--slate-bg); border:1px solid var(--hair); border-radius:6px; padding:2px 7px; color:var(--slate)}

/* info card */
.info{background:var(--card); border:1px solid var(--line); border-radius:14px; padding:18px 20px; box-shadow:var(--sh-sm)}
.info .head{margin:0 0 8px; font-weight:650; font-size:15px; color:var(--ink); display:flex; align-items:center; gap:9px}
.info .head .hicon{width:9px;height:9px;border-radius:3px;flex:0 0 auto}
.hicon.amber{background:var(--amber)} .hicon.slate{background:var(--slate)}
.info .why{color:var(--muted); margin:0; font-size:14px; line-height:1.6}
.info ul{margin:13px 0 0; padding-left:0; list-style:none; display:grid; gap:8px}
.info li{margin:0; color:var(--ink-2); font-size:14px; padding-left:22px; position:relative}
.info li::before{content:""; position:absolute; left:5px; top:8px; width:5px;height:5px; border-radius:50%; background:var(--slate)}
.info li b{color:var(--ink); font-weight:650}

/* declaration panel */
.declpanel{background:var(--card); border:1px solid var(--line); border-radius:14px; padding:18px 20px; margin-bottom:16px; box-shadow:var(--sh-sm)}
.declhead{margin:0 0 16px; color:var(--muted); font-size:13.5px; line-height:1.55}
.declhead b{color:var(--ink); font-weight:650}
.bggroup{margin:0 0 10px; padding:11px 13px; border:1px solid var(--hair); border-radius:11px; background:var(--card-2)}
.bgcontrow{display:flex; align-items:center; gap:9px; font-weight:600; font-size:14px; cursor:pointer; color:var(--ink)}
.bgcontrow code{background:var(--slate-bg); border:1px solid var(--hair); border-radius:6px; padding:2px 7px; color:var(--ink-2)}
.bgn{color:var(--faint); font-size:12px; font-weight:500; margin-left:auto}
.bgels{margin:11px 0 0 29px; display:flex; flex-wrap:wrap; gap:7px 18px}
.bgelrow{display:inline-flex; align-items:center; gap:7px; color:var(--ink-2); font-size:13px; cursor:pointer}
.bggroup.conton .bgels{opacity:.45}
input[type=checkbox]{accent-color:var(--brand); width:15px;height:15px; cursor:pointer}
.declcmdrow{display:flex; gap:10px; align-items:stretch; margin-top:14px}
.declbtn{flex:0 0 auto; border:1px solid var(--brand); background:var(--brand); color:#fff; border-radius:9px; padding:0 16px;
  font-family:var(--sans); font-size:13px; font-weight:600; cursor:pointer; transition:background .15s; box-shadow:var(--sh-xs)}
.declbtn:hover{background:var(--brand-2)}
.declcmd{flex:1 1 auto; font-family:var(--mono); font-size:12.5px; line-height:1.5; border:1px solid #1c2026; border-radius:9px;
  padding:11px 13px; background:#0e1014; color:#e7eaf0; resize:vertical; min-height:48px}

/* foldout */
details.bgfold{margin:6px 0 8px}
details.bgfold>summary{cursor:pointer; color:var(--muted); font-size:13.5px; font-weight:600; padding:11px 16px; border:1px solid var(--line);
  border-radius:11px; background:var(--card); box-shadow:var(--sh-xs); user-select:none; list-style:none; display:flex; align-items:center; gap:10px; transition:background .15s}
details.bgfold>summary:hover{background:var(--card-2)}
details.bgfold>summary::-webkit-details-marker{display:none}
details.bgfold>summary::before{content:""; width:7px;height:7px; border-right:2px solid var(--faint); border-bottom:2px solid var(--faint); transform:rotate(-45deg); transition:transform .2s}
details.bgfold[open]>summary::before{transform:rotate(45deg)}
details.bgfold[open]>summary{margin-bottom:14px}

/* scene banner (multi-scene reports) */
.scene{display:flex; align-items:center; gap:12px; margin:54px 0 4px; font-size:22px; font-weight:800; letter-spacing:-.02em; color:var(--ink); scroll-margin-top:18px}
.scene::before{content:""; width:10px;height:10px;border-radius:3px; background:var(--brand); flex:0 0 auto}
.scene::after{content:""; flex:1; height:1px; background:var(--line)}

/* issue-type cluster (one rep card + "show N more") */
.cluster{margin:0}
.cluster-h{display:flex; align-items:center; gap:9px; margin:18px 0 11px}
.cluster-h .cluster-t{font-size:13.5px; font-weight:700; color:var(--ink-2); letter-spacing:-.01em}
.cluster-h .cluster-n{font-size:11px; font-weight:700; color:var(--slate); background:var(--slate-bg); border:1px solid var(--slate-line); border-radius:999px; padding:1px 8px; min-width:20px; text-align:center}
details.morefold{margin:2px 0 14px}
details.morefold>summary{cursor:pointer; color:var(--muted); font-size:13px; font-weight:600; padding:9px 14px; border:1px solid var(--line);
  border-radius:10px; background:var(--card); box-shadow:var(--sh-xs); user-select:none; list-style:none; display:flex; align-items:center; gap:9px; transition:background .15s}
details.morefold>summary:hover{background:var(--card-2)}
details.morefold>summary::-webkit-details-marker{display:none}
details.morefold>summary::before{content:""; width:6px;height:6px; border-right:2px solid var(--faint); border-bottom:2px solid var(--faint); transform:rotate(-45deg); transition:transform .2s}
details.morefold[open]>summary::before{transform:rotate(45deg)}
details.morefold[open]>summary{margin-bottom:14px}

/* passed + next */
.passed{margin-top:30px; background:var(--green-bg); border:1px solid var(--green-line); border-radius:14px; padding:16px 20px; display:flex; gap:13px; align-items:flex-start}
.passed .pi{width:24px;height:24px;flex:0 0 auto;margin-top:1px}
.passed b{color:var(--green-ink); font-weight:700; font-size:15px}
.passed .items{color:var(--ink-2); font-size:14px; margin-top:4px}
.next{margin-top:14px; background:var(--card); border:1px solid var(--line); border-radius:14px; padding:18px 20px; box-shadow:var(--sh-sm)}
.next-h{margin:0 0 4px; font-weight:700; font-size:15px; color:var(--ink)}
.next code{background:var(--slate-bg); border:1px solid var(--hair); border-radius:6px; padding:2px 7px}
.nextlist{margin:12px 0 0; padding-left:0; list-style:none; counter-reset:step; display:grid; gap:11px}
.nextlist li{margin:0; color:var(--ink-2); font-size:14px; line-height:1.5; padding-left:34px; position:relative; counter-increment:step}
.nextlist li::before{content:counter(step); position:absolute; left:0; top:-1px; width:23px;height:23px; border-radius:7px; background:var(--slate-bg);
  border:1px solid var(--slate-line); color:var(--slate); font-size:12px; font-weight:700; display:grid; place-items:center}

/* gallery */
.gallery{display:grid; grid-template-columns:repeat(3,1fr); gap:14px; margin-top:6px}
@media(max-width:680px){.gallery{grid-template-columns:repeat(2,1fr)}}
.gallery figure{margin:0; font-size:12px; color:var(--muted)}
.gallery img{width:100%; border-radius:11px; border:1px solid var(--line); display:block; box-shadow:var(--sh-sm); cursor:zoom-in; background:#0b0d10; transition:transform .18s, box-shadow .18s}
.gallery img:hover{transform:translateY(-2px); box-shadow:var(--sh-md)}
.gallery figcaption{margin-top:9px; font-weight:600; color:var(--ink-2)}

footer{color:var(--faint); font-size:12.5px; margin-top:44px; padding-top:26px; border-top:1px solid var(--hair); text-align:center}
footer code{background:var(--slate-bg); border:1px solid var(--hair); border-radius:6px; padding:2px 7px; color:var(--muted)}

/* lightbox */
.lightbox{position:fixed; inset:0; background:rgba(15,18,23,.72); -webkit-backdrop-filter:blur(6px); backdrop-filter:blur(6px);
  display:none; align-items:center; justify-content:center; z-index:99; cursor:zoom-out; padding:28px}
.lightbox.show{display:flex}
.lbbox{display:flex; align-items:center; justify-content:center; max-width:96vw; max-height:92vh}
.lbplain{display:block; max-width:95vw; max-height:90vh; border-radius:12px; box-shadow:0 22px 70px rgba(0,0,0,.5)}
.lbwrap{position:relative; display:flex; align-items:stretch; background:var(--card); border-radius:16px; overflow:hidden;
  max-width:96vw; max-height:92vh; cursor:default; box-shadow:0 24px 80px rgba(0,0,0,.5)}
.lbshot{position:relative; flex:0 0 auto; align-self:stretch; display:flex; align-items:center; justify-content:center; background:#0b0d10}
.lbframe{position:relative; flex:0 0 auto; font-size:0; line-height:0}
.lbshot img{display:block; max-width:62vw; max-height:92vh; width:auto; height:auto}
.lbshot.annoff .ovl{display:none}
.lbside{flex:1 1 320px; min-width:280px; max-width:380px; overflow:auto; border-left:1px solid var(--line)}
.lbside .detail{height:100%}
.lbclose{position:absolute; top:10px; right:10px; z-index:3; width:30px;height:30px; padding:0; border:1px solid var(--line); border-radius:50%;
  background:rgba(255,255,255,.94); color:var(--ink); font-size:17px; line-height:1; text-align:center; cursor:pointer; box-shadow:var(--sh-sm)}
.lbclose:hover{background:#fff}
.anntoggle{position:absolute; top:10px; left:10px; z-index:2; display:inline-flex; align-items:center; gap:6px; font-size:11px; color:#fff;
  background:rgba(11,13,16,.62); padding:5px 9px; border-radius:8px; cursor:pointer}
.anntoggle input{margin:0; cursor:pointer; width:13px;height:13px}
@media(max-width:680px){.lbwrap{flex-direction:column; overflow:auto}.lbshot img{max-width:92vw}.lbside{max-width:none; border-left:0; border-top:1px solid var(--line)}}

@media(max-width:680px){
  .wrap{padding:0 16px 60px}
  .hero{padding:24px 22px} .hero h1{font-size:25px}
  .score-grid{grid-template-columns:repeat(2,1fr)}
  .stat:nth-child(2){border-right:0}
  .stat:nth-child(1),.stat:nth-child(2){border-bottom:1px solid var(--hair)}
}
@media print{
  body{background:#fff}
  .finding,.hero,.scorecard,.info,.declpanel,.next,.passed{break-inside:avoid; box-shadow:none}
  .zoomhint{display:none}
}
`;

/** A `data:` URI is safe to inline; reject anything else so a path never reaches the lightbox. */
function dataUriOrEmpty(src: string | undefined): string | null {
  return src && src.startsWith("data:") ? src : null;
}

/** Percentages for the CSS overlay boxes, derived from the captured (bottom-origin) rect. */
function overlayBoxes(annotation: GateCheckAnnotation): { safe: string; elem: string; tag: string } {
  const insets = annotation.safeInsets ?? { top: 0, bottom: 0, left: 0, right: 0 };
  const r = annotation.rect;
  const pct = (n: number): string => `${(n * 100).toFixed(2)}%`;
  // The image fills the frame; safe box is the inset rectangle.
  const safe = `left:${pct(insets.left)};right:${pct(insets.right)};top:${pct(insets.top)};bottom:${pct(insets.bottom)};`;
  // The captured rect is BOTTOM-origin; CSS top-origin → flip y.
  const top = 1 - (r.y + r.height);
  const elem = `left:${pct(r.x)};top:${pct(top)};width:${pct(r.width)};height:${pct(r.height)};`;
  // Tag sits just outside the offending edge, anchored to the element box.
  let tagPos: string;
  switch (annotation.overflow?.edge) {
    case "bottom":
      tagPos = `left:${pct(r.x)};top:${pct(Math.min(0.965, top + r.height + 0.01))};`;
      break;
    case "top":
      tagPos = `left:${pct(r.x)};top:${pct(Math.max(0.005, top - 0.05))};`;
      break;
    default:
      tagPos = `left:${pct(r.x)};top:${pct(Math.max(0.005, top - 0.06))};`;
  }
  return { safe, elem, tag: tagPos };
}

/** The short overflow tag text drawn on the screenshot ("8px past the safe edge"). */
function overflowTagText(annotation: GateCheckAnnotation): string {
  const px = overflowPx(annotation);
  const edge = annotation.overflow?.edge;
  if (edge === "bottom") return `${px}px below the safe edge`;
  if (edge === "top") return `${px}px above the safe edge`;
  return `${px}px past the safe edge`;
}

/**
 * The annotated safe-area card: a screenshot with safe/element overlay boxes + an
 * overflow tag, beside a What/Where/Why/Fix detail panel — all from live geometry.
 */
function renderAnnotatedCard(item: ReportItem, index: number, thumbs: Record<string, string>): string {
  const finding = item.finding;
  const annotation = finding.annotation as GateCheckAnnotation;
  // Phase 4: draw the PER-DEVICE screenshot (`<state>@<device>`) when the finding is
  // device-tagged, so the overlay geometry matches the device it was graded at.
  const thumbKey = item.thumbKey ?? item.state;
  const src = dataUriOrEmpty(thumbKey ? thumbs[thumbKey] : undefined);
  if (!src) return renderPlainItem(item, index, thumbs); // no image → fall back to the plain item
  const { safe, elem, tag } = overlayBoxes(annotation);
  // List every affected device (grouped); the screenshot itself is the representative device's.
  const devLabel =
    item.devices && item.devices.length > 0
      ? item.devices.map((d) => d.label).join(", ")
      : finding.device?.label;
  const screenLabel = item.state
    ? `On ${screensPhrase(item.states ?? [item.state])}${devLabel ? ` · ${devLabel}` : ""}`
    : "";
  const where = whereCopy(annotation);
  // safe-area-sweep is the "only backgrounds may bleed" gate — a flagged element is EITHER
  // decoration to declare OR a control to move, so its Why/Fix state that fork (not "move it",
  // which is wrong for a cloud). safe-area (a bound required control) keeps the move-it copy.
  const isSweep = finding.gate === "safe-area-sweep";
  const why = isSweep
    ? "Only true backgrounds may bleed to the edge. If this is decoration, declare it as background; if it's a control, the notch or rounded corners can clip it."
    : annotation.overflow ? whyCopy(annotation.overflow.edge) : "It sits inside the safe margin.";
  const fix = isSweep
    ? "If it's background art, add it to <code>contract.safeAreaBackground</code>. If it's a control, move it inside the dashed safe area."
    : fixCopy(annotation);
  const tagText = annotation.overflow ? `<div class="tag" style="${tag}">${escapeHtml(overflowTagText(annotation))}</div>` : "";
  const locator = annotation.locator
    ? `<p class="path"><code>${escapeHtml(annotation.locator)}</code></p>`
    : "";
  return `<div class="finding">
  <div class="shot" onclick="zoomShot(this)">
    <img src="${src}" alt="${escapeHtml(item.state ? `${prettyId(item.state)} screen` : "screen")}">
    <div class="ovl">
      <div class="safe" style="${safe}"></div>
      <div class="elem" style="${elem}"></div>
      ${tagText}
      <div class="legend"><i><span class="sw-safe"></span>safe area</i><i><span class="sw-elem"></span>out of bounds</i></div>
      <div class="zoomhint">click to enlarge</div>
    </div>
  </div>
  <div class="detail">
    <p class="ttl">${index}. ${escapeHtml(annotatedTitle(finding, item.devices))}</p>
    ${screenLabel ? `<p class="screen">${escapeHtml(screenLabel)}</p>` : ""}
    <div class="row"><span class="k">Where</span><p class="v">${where}</p></div>
    <div class="row"><span class="k">Why</span><p class="v">${escapeHtml(why)}</p></div>
    <div class="fix"><div class="row" style="border:0;padding:0"><span class="k">Fix</span><p class="v">${fix}</p></div></div>
    ${locator}
  </div>
</div>`;
}

/** The pretty layer name from a seam segment's locator ("Scene:/Background/Ground" → "Ground"). */
export function seamLayerName(locator: string): string {
  const tail = locator.split("/").filter(Boolean).pop() ?? locator;
  // Drop a leading "Scene:" if the locator had no path (defensive).
  const name = tail.includes(":") ? tail.slice(tail.lastIndexOf(":") + 1) : tail;
  return prettyId(name || locator);
}

/** The "Ground bottom — 84px" label for one seam segment. */
export function seamSegmentLabel(seg: SeamSegment, viewport?: { width: number; height: number }): string {
  const dim = seg.edge === "bottom" ? viewport?.height ?? 0 : viewport?.width ?? 0;
  const px = Math.round(seg.exposedFraction * dim);
  return `${seamLayerName(seg.layerLocator)} ${seg.edge} — ${px}px`;
}

/** CSS `left/top/width/height` percentages for the exposed strip (normalized top-origin). */
function seamStripStyle(strip: SeamSegment["strip"]): string {
  const pct = (n: number): string => `${(n * 100).toFixed(2)}%`;
  return `left:${pct(strip.x)};top:${pct(strip.y)};width:${pct(strip.width)};height:${pct(strip.height)};`;
}

/** CSS for the cut-edge LINE — a thin absolutely-positioned div spanning the segment. */
function seamLineStyle(line: SeamSegment["line"]): string {
  const pct = (n: number): string => `${(n * 100).toFixed(2)}%`;
  const left = Math.min(line.x0, line.x1);
  const top = Math.min(line.y0, line.y1);
  const width = Math.abs(line.x1 - line.x0);
  const height = Math.abs(line.y1 - line.y0);
  // A horizontal edge has ~0 height, a vertical edge ~0 width — give the thin axis a
  // visible 2px stroke (drawn by border-width in CSS), so the line is always at least 2px.
  const horizontal = width >= height;
  return horizontal
    ? `left:${pct(left)};top:${pct(top)};width:${pct(width)};height:0;border-top-width:2px;`
    : `left:${pct(left)};top:${pct(top)};width:0;height:${pct(height)};border-left-width:2px;`;
}

/** A label position anchored near the start of the segment's cut-edge line. */
function seamTagStyle(line: SeamSegment["line"]): string {
  const pct = (n: number): string => `${(n * 100).toFixed(2)}%`;
  const left = Math.min(line.x0, line.x1);
  const top = Math.min(line.y0, line.y1);
  return `left:${pct(Math.min(0.9, left))};top:${pct(Math.min(0.94, Math.max(0.005, top)))};`;
}

/**
 * The seam card: a gameplay screenshot with each flagged layer's cut-edge LINE + shaded
 * exposed STRIP drawn over it (one segment per layer) and a per-layer label, beside a
 * What/Where/Fix detail panel. Falls back to the plain item if the screenshot is missing.
 */
function renderSeamCard(item: ReportItem, seam: SeamAnnotation, index: number, thumbs: Record<string, string>): string {
  const finding = item.finding;
  const src = seam.screenshotKey ? dataUriOrEmpty(thumbs[seam.screenshotKey]) : null;
  if (!src) return renderPlainItem(item, index, thumbs); // no usable screenshot → plain item (no crash)

  const overlays = seam.segments
    .map((seg) => {
      const strip = `<div class="seamstrip" style="${seamStripStyle(seg.strip)}"></div>`;
      const lineDiv = `<div class="seamline" style="${seamLineStyle(seg.line)}"></div>`;
      const tag = `<div class="tag" style="${seamTagStyle(seg.line)}">${escapeHtml(seamSegmentLabel(seg, seam.viewport))}</div>`;
      return `${strip}${lineDiv}${tag}`;
    })
    .join("");

  const dev = finding.device ? ` — on ${finding.device.label}` : "";
  const title = `A background layer's edge shows inside the frame${dev}`;
  const where = `${seam.segments.length} layer edge${seam.segments.length === 1 ? "" : "s"} cut inside the frame (red lines), exposing the strip past them (shaded).`;
  const fix = "Extend the layer past the frame edge, or cover it with a closer background layer, so the cut edge sits outside the view.";

  return `<div class="finding">
  <div class="shot" onclick="zoomShot(this)">
    <img src="${src}" alt="${escapeHtml(item.state ? `${prettyId(item.state)} screen` : "screen")}">
    <div class="ovl">
      ${overlays}
      <div class="legend"><i><span class="sw-seam"></span>exposed background edge</i></div>
      <div class="zoomhint">click to enlarge</div>
    </div>
  </div>
  <div class="detail">
    <p class="ttl">${index}. ${escapeHtml(title)}</p>
    ${item.state ? `<p class="screen">${escapeHtml(`On the ${prettyId(item.state)} screen${finding.device ? ` · ${finding.device.label}` : ""}`)}</p>` : ""}
    <div class="row"><span class="k">What</span><p class="v">${escapeHtml(finding.detail)}</p></div>
    <div class="row"><span class="k">Where</span><p class="v">${escapeHtml(where)}</p></div>
    <div class="fix"><div class="row" style="border:0;padding:0"><span class="k">Fix</span><p class="v">${escapeHtml(fix)}</p></div></div>
  </div>
</div>`;
}

/**
 * The tap-target card: the control highlighted with a green "needed size" guide + a
 * "Ndp · needs ≥Mdp" badge, beside a What/Where/Why/Fix panel — points at the SIZE issue, not a
 * safe-area box. Falls back to the plain item when the screenshot or the tap-target data is absent.
 */
function renderTapTargetCard(item: ReportItem, index: number, thumbs: Record<string, string>): string {
  const finding = item.finding;
  const annotation = finding.annotation as GateCheckAnnotation;
  const tt = annotation.tapTarget;
  const thumbKey = item.thumbKey ?? item.state;
  const src = dataUriOrEmpty(thumbKey ? thumbs[thumbKey] : undefined);
  if (!src || !tt) return renderPlainItem(item, index, thumbs);
  const pct = (n: number): string => `${(n * 100).toFixed(2)}%`;
  const r = annotation.rect;
  const top = 1 - (r.y + r.height); // captured rect is bottom-origin; CSS is top-origin
  const elem = `left:${pct(r.x)};top:${pct(top)};width:${pct(r.width)};height:${pct(r.height)};`;
  // The "needed size" guide: scale the control up so its short edge reaches the dp floor, centered
  // on it, clamped to the frame — a green dashed box showing how big the tap area should be.
  const scale = tt.minDp / Math.max(tt.actualDp, 0.01);
  const tw = Math.min(1, r.width * scale);
  const th = Math.min(1, r.height * scale);
  const gx = Math.max(0, Math.min(1 - tw, r.x + r.width / 2 - tw / 2));
  const gy = Math.max(0, Math.min(1 - th, top + r.height / 2 - th / 2));
  const guide = `left:${pct(gx)};top:${pct(gy)};width:${pct(tw)};height:${pct(th)};`;
  const objId = objectIdOf(finding);
  const subject = objId ? prettyId(objId) : "A required control";
  const devLabel = item.devices && item.devices.length > 0 ? item.devices.map((d) => d.label).join(", ") : finding.device?.label;
  const screenLabel = item.state ? `On ${screensPhrase(item.states ?? [item.state])}${devLabel ? ` · ${devLabel}` : ""}` : "";
  const actual = tt.actualDp.toFixed(0);
  const factor = (tt.minDp / Math.max(tt.actualDp, 0.01)).toFixed(1);
  const badge = `${actual}dp · needs ≥${tt.minDp}dp`;
  const where = `The control is about <b>${actual}dp</b> on its short edge.`;
  const why = `Little fingers miss small targets, so this age band needs at least ${tt.minDp}dp.`;
  const fix = `Make it at least <code>${tt.minDp}dp</code>. It's <b>${actual}dp</b> now, so about <b>${factor}× bigger</b>.`;
  const locator = annotation.locator ? `<p class="path"><code>${escapeHtml(annotation.locator)}</code></p>` : "";
  return `<div class="finding">
  <div class="shot" onclick="zoomShot(this)">
    <img src="${src}" alt="${escapeHtml(item.state ? `${prettyId(item.state)} screen` : "screen")}">
    <div class="ovl">
      <div class="target" style="${guide}"></div>
      <div class="elem" style="${elem}"></div>
      <div class="tag" style="left:${pct(r.x)};top:${pct(Math.max(0.005, top - 0.06))};">${escapeHtml(badge)}</div>
      <div class="legend"><i><span class="sw-elem"></span>tap area</i><i><span class="sw-target"></span>needed size</i></div>
      <div class="zoomhint">click to enlarge</div>
    </div>
  </div>
  <div class="detail">
    <p class="ttl">${index}. ${escapeHtml(`${subject} is too small to tap`)}</p>
    ${screenLabel ? `<p class="screen">${escapeHtml(screenLabel)}</p>` : ""}
    <div class="row"><span class="k">Where</span><p class="v">${where}</p></div>
    <div class="row"><span class="k">Why</span><p class="v">${escapeHtml(why)}</p></div>
    <div class="fix"><div class="row" style="border:0;padding:0"><span class="k">Fix</span><p class="v">${fix}</p></div></div>
    ${locator}
  </div>
</div>`;
}

/**
 * The plain card for a finding with NO drawable annotation (a required object that's off-screen, a flow
 * stall, a capture gap…). Same two-pane `.finding` shell as the annotated cards — screenshot on the left
 * (no overlay boxes, nothing to highlight), What/where detail on the right — so every card reads alike.
 * With no screenshot it collapses to a single-column detail card (`.finding.noshot`).
 */
function renderPlainItem(item: ReportItem, index: number, thumbs: Record<string, string>): string {
  const finding = item.finding;
  const thumbKey = item.thumbKey ?? item.state;
  const src = dataUriOrEmpty(thumbKey ? thumbs[thumbKey] : undefined);
  const objId = objectIdOf(finding);
  // Subject when the gate points at an object (required-in-frame → "Play Button"); else the issue-type
  // label (flow / capture / console have no per-object subject).
  const titleText = objId ? prettyId(objId) : issueTypeLabel(finding);
  const devLabel = item.devices && item.devices.length > 0 ? item.devices.map((d) => d.label).join(", ") : finding.device?.label;
  const screenLabel = item.state ? `On ${screensPhrase(item.states ?? [item.state])}${devLabel ? ` · ${devLabel}` : ""}` : "";
  const locator = finding.annotation?.locator ? `<p class="path"><code>${escapeHtml(finding.annotation.locator)}</code></p>` : "";
  const detail = `<div class="detail">
    <p class="ttl">${index}. ${escapeHtml(titleText)}</p>
    ${screenLabel ? `<p class="screen">${escapeHtml(screenLabel)}</p>` : ""}
    <div class="row"><span class="k">What</span><p class="v">${escapeHtml(item.sentence)}</p></div>
    ${locator}
  </div>`;
  if (!src) return `<div class="finding noshot">${detail}</div>`;
  return `<div class="finding">
  <div class="shot" onclick="zoomShot(this)">
    <img alt="${escapeHtml(item.state ? `${prettyId(item.state)} screen` : "screen")}" src="${src}">
    <div class="ovl"><div class="zoomhint">click to enlarge</div></div>
  </div>
  ${detail}
</div>`;
}

/**
 * Render one finding. The annotated card is drawn ONLY for a finding that carries
 * rect geometry AND has a usable state thumbnail (safe-area today); every other
 * finding keeps the plain humanized item.
 */
function renderItemHtml(item: ReportItem, index: number, thumbs: Record<string, string>): string {
  // Seam card FIRST: a background-seam finding draws its cut edges over a gameplay
  // screenshot when one was resolved AND is on disk; otherwise it falls through to the
  // plain humanized item (no crash). Safe-area's rect path + the plain path are unchanged.
  const seam = item.finding.seamAnnotation;
  if (seam && seam.screenshotKey && dataUriOrEmpty(thumbs[seam.screenshotKey])) {
    return renderSeamCard(item, seam, index, thumbs);
  }
  // Tap-target findings carry a `tapTarget` annotation → draw the size card (control + needed-size
  // guide), NEVER the safe-area box. Safe-area / safe-area-sweep keep the safe-area annotated card.
  if (item.finding.gate === "tap-target-size" && item.finding.annotation?.tapTarget) {
    return renderTapTargetCard(item, index, thumbs);
  }
  if (item.finding.annotation?.rect) return renderAnnotatedCard(item, index, thumbs);
  return renderPlainItem(item, index, thumbs);
}

/**
 * Render a (non-collapsed, non-outcome-gated) bucket body as issue-type clusters: each cluster shows its
 * FIRST finding as the full card and folds the rest behind a "Show N more" `<details>` — the folded
 * findings are the SAME full cards (screenshot + highlight + detail), just collapsed so the bucket
 * doesn't dominate. Every finding is numbered 1..N across the bucket; a 1-item cluster renders just its
 * card. Honest: the cluster header carries the full count and nothing is dropped.
 */
function renderClusteredBody(items: ReportItem[], thumbs: Record<string, string>): string {
  let index = 0;
  return clusterItems(items)
    .map((cluster) => {
      const [rep, ...rest] = cluster.items;
      index += 1;
      const head = `<div class="cluster-h"><span class="cluster-t">${escapeHtml(cluster.label)}</span><span class="cluster-n">${cluster.items.length}</span></div>`;
      const card = renderItemHtml(rep, index, thumbs);
      const restCards = rest.map((item) => { index += 1; return renderItemHtml(item, index, thumbs); }).join("");
      const more = rest.length
        ? `<details class="morefold"><summary>Show ${rest.length} more ${escapeHtml(cluster.label.toLowerCase())} ${rest.length === 1 ? "issue" : "issues"}</summary>${restCards}</details>`
        : "";
      return `<div class="cluster">${head}${card}${more}</div>`;
    })
    .join("");
}

/** The collapsed outcome-gated block: one plain explanation + a short bullet list. */
function renderOutcomeGatedBlock(section: ReportSection): string {
  const n = section.items.length;
  const bullets = section.items
    .map((item) => {
      const f = item.finding;
      const label = f.transition
        ? `The <b>${escapeHtml(prettyId(f.transition))}</b> step`
        : `The <b>${escapeHtml(prettyId(f.state ?? "screen"))}</b> screen`;
      return `<li>${label}</li>`;
    })
    .join("");
  return `<div class="info">
  <p class="head"><span class="hicon slate"></span>${n} screen(s) and step(s) could not be auto-tested. That is expected, not a failure.</p>
  <p class="why">The verifier looks at the game, it does not play it. These only show up after the game's own answer, and the game shuffles the answer every round, so a look-only check cannot reliably reach them. The screens it could reach were all graded normally.</p>
  <ul>${bullets}</ul>
</div>`;
}

/**
 * The report-driven declaration panel: a checkbox per candidate container (pre-ticked) with the
 * elements it covers nested under it, plus a "Copy declare command" button + a readonly box holding
 * `loomtide minigame declare-background --id <id> <paths…>`. Default = container globs; unchecking a
 * container reveals per-element selection (the override). The HTML report can't write the contract
 * (static file), so this EMITS the command the dev runs once — closing the loop without hand-editing.
 * Empty when there's nothing to declare.
 */
function renderDeclarePanel(report: MinigameVerifyReport, scene?: string): string {
  const groups = backgroundDeclareGroups(report, scene);
  if (groups.length === 0) return "";
  const id = report.contract.id;
  const confident = groups.filter((g) => g.confident);
  const review = groups.filter((g) => !g.confident);
  // The default command pre-fills only the HIGH-CONFIDENCE clusters (it mirrors `--from-report`); lone
  // REVIEW items join only once the dev ticks them. When there are no clusters, show the same empty
  // placeholder the client `buildDeclCmd` emits, so the box never reads as a runnable no-op command.
  const defaultCmd = confident.length
    ? `loomtide minigame declare-background --id ${id} ${confident.map((g) => `"${g.container}"`).join(" ")}`
    : "# tick at least one item above to declare it as background";
  const clusterHtml = confident
    .map((g) => {
      const els = g.elements
        .map(
          (e) =>
            `<label class="bgelrow"><input type="checkbox" class="bgel" data-loc="${escapeHtml(e.locator)}" checked onchange="updateDeclCmd(this)"> ${escapeHtml(e.name)}</label>`,
        )
        .join("");
      return `<div class="bggroup conton">
      <label class="bgcontrow"><input type="checkbox" class="bgcont" data-glob="${escapeHtml(g.container)}" checked onchange="updateDeclCmd(this)"> <code>${escapeHtml(g.container)}</code> <span class="bgn">declare all ${g.elements.length}</span></label>
      <div class="bgels">${els}</div>
    </div>`;
    })
    .join("");
  // REVIEW: one box of lone elements, each default-UNticked — the tool can't tell a single decorative
  // image from a single real control, so the dev opts each in (a real control stays in must-fix).
  const reviewEls = review
    .map(
      (g) =>
        `<label class="bgelrow"><input type="checkbox" class="bgel" data-loc="${escapeHtml(g.container)}" onchange="updateDeclCmd(this)"> ${escapeHtml(g.elements[0]?.name ?? g.container)} <code>${escapeHtml(g.container)}</code></label>`,
    )
    .join("");
  const reviewHtml = review.length
    ? `<div class="bggroup">
      <div class="bgcontrow">Review individually <span class="bgn">decoration? tick it · a real control? leave it (fix the layout)</span></div>
      <div class="bgels">${reviewEls}</div>
    </div>`
    : "";
  return `<div class="declpanel" data-id="${escapeHtml(id)}">
    <p class="declhead"><b>Tick the real background</b> below: the art that's meant to reach the screen edge. Then copy the command and run it once. (Tick a whole group, or untick any piece that isn't background — the command updates as you go.)</p>
    ${clusterHtml}${reviewHtml}
    <div class="declcmdrow">
      <button type="button" class="declbtn" onclick="copyDeclareCmd(this)">Copy declare command</button>
      <textarea class="declcmd" readonly rows="2" onclick="this.select()">${escapeHtml(defaultCmd)}</textarea>
    </div>
  </div>`;
}

/**
 * Render the full self-contained HTML report. `thumbs` maps a state id to an inline
 * `data:image/png;base64,...` URI (omit a state to skip its thumbnail). Pure.
 */
export function renderMinigameReportHtml(
  report: MinigameVerifyReport,
  thumbs: Record<string, string> = {},
): string {
  const banner = bannerFor(report.status);
  const c = report.contract;
  const sceneGroups = groupSectionsByScene(report);

  const pad = (n: number): string => String(n).padStart(2, "0");
  // Map a section heading to its anchor id + count-badge tone (so the scorecard tiles can jump to it
  // and the badge colour matches the verdict tone). Headings carry a trailing " (N)" the design moves
  // into a separate badge, so the title text strips it.
  const sectionMeta = (heading: string): { id: string; tone: string } => {
    if (heading.startsWith("Must fix")) return { id: "must-fix", tone: "" };
    if (heading.startsWith("Likely background")) return { id: "declare", tone: "amber" };
    if (heading.startsWith("Not asserted")) return { id: "not-asserted", tone: "slate" };
    if (heading.startsWith("Looks different")) return { id: "looks-different", tone: "amber" };
    if (heading.startsWith("Couldn't be tested")) return { id: "couldnt-be-tested", tone: "amber" };
    if (heading.startsWith("Warnings")) return { id: "warnings", tone: "amber" };
    return { id: "section", tone: "slate" };
  };

  // The report reads SCENE-first: a scene banner, then that scene's buckets. A bucket appears once per
  // scene, so the FIRST occurrence of each bucket keeps the bare anchor id (so the scorecard
  // `#must-fix`/`#declare` tiles still resolve) and later same-bucket sections are suffixed with the
  // scene slug. The declare panel is rendered PER SCENE (scene-scoped candidates); single-scene reports
  // pass `scene: undefined` so it stays the report-global panel exactly as before.
  const seenSectionIds = new Set<string>();
  let secNum = 0;
  const renderSection = (s: ReportSection): string => {
    const meta = sectionMeta(s.heading);
    const id = !seenSectionIds.has(meta.id) ? meta.id : `${meta.id}-${s.scene ? sceneSlug(s.scene) : secNum}`;
    seenSectionIds.add(meta.id);
    secNum += 1;
    // Strip the trailing " (N)" (the count moves to a badge) and the "— declare to dismiss" suffix
    // (the CTA below says the rest). The scene now lives in the banner above, so the bucket title is
    // scene-free in multi-scene too.
    const title = s.heading.replace(/ \(\d+\)$/, "").replace(/ [—–-] declare to dismiss$/, "");
    const count = s.items.length;
    const header = `<h2 class="sec" id="${id}"><span class="sec-num">${pad(secNum)}</span><span class="sec-t">${escapeHtml(title)}</span><span class="rule"></span><span class="count ${meta.tone}">${count}</span></h2>`;
    if (s.outcomeGated) return `${header}${renderOutcomeGatedBlock(s)}`;
    if (s.collapsed) {
      // The likely-background bucket: its scene-scoped declare CTA + panel (checkboxes → a copyable
      // `declare-background` command), then the flagged findings folded behind a <details> so they don't
      // dominate. Presentation only; the findings stay exit-1 fails until the dev declares them.
      const ctaHtml = s.declareCTA
        ? `<div class="info" style="margin-bottom:14px"><p class="head"><span class="hicon amber"></span>Some of these are background art, not problems.</p><p class="why">Background art like sky, clouds and hills is allowed to reach the screen edge. Only buttons and text need to stay inside the safe area. Mark the real background below and it stops getting flagged.</p></div>`
        : "";
      const declareHtml = renderDeclarePanel(report, s.scene);
      const body = s.items.map((item, j) => renderItemHtml(item, j + 1, thumbs)).join("");
      const bodyHtml = `<details class="bgfold"><summary>Show the ${count} flagged background element${count === 1 ? "" : "s"}</summary>${body}</details>`;
      return `${header}${ctaHtml}${declareHtml}${bodyHtml}`;
    }
    // A normal bucket: cluster the findings by issue type (one rep card + "Show N more" per type).
    return `${header}${renderClusteredBody(s.items, thumbs)}`;
  };
  const sectionHtml = sceneGroups
    .map((g) => {
      // The scene banner heads each scene group (multi-scene only). Single-scene groups have no scene ⇒
      // no banner, byte-compatible with the flat pre-scene-grouping layout.
      const sceneBanner = g.scene ? `<h2 class="scene" id="scene-${sceneSlug(g.scene)}">${escapeHtml(g.scene)}</h2>` : "";
      return `${sceneBanner}${g.sections.map(renderSection).join("")}`;
    })
    .join("");

  // Screens gallery (Phase 4): list what was GRADED (the `states` map keys) and has a usable thumbnail
  // — `<state>@<device>` for a per-device pack (each labelled with its device), or the legacy `<state>`
  // for an old single-aspect pack. Keying off `states` (not all of `statePaths`) means a contract-
  // derived per-device path that isn't on disk never shows.
  const galleryStates = Object.keys(report.states).filter((st) => dataUriOrEmpty(thumbs[st]));
  const galleryCaption = (key: string): string => {
    const at = key.lastIndexOf("@");
    if (at < 0) return prettyId(key);
    const device = report.deviceLabels?.[key.slice(at + 1)] ?? key.slice(at + 1);
    return `${prettyId(key.slice(0, at))} · ${device}`;
  };
  const galleryHtml =
    galleryStates.length > 0
      ? `<h2 class="sec" id="screens"><span class="sec-num">${pad(secNum + 1)}</span><span class="sec-t">Screens captured</span><span class="rule"></span><span class="count slate">${galleryStates.length}</span></h2><div class="gallery">${galleryStates
          .map((st) => {
            const src = thumbs[st];
            const caption = galleryCaption(st);
            return `<figure><img alt="${escapeHtml(caption)} screen" src="${src}" onclick="zoom('${src}')"><figcaption>${escapeHtml(caption)}</figcaption></figure>`;
          })
          .join("")}</div>`
      : "";

  // Next step: render the clauses as scannable, numbered steps (a single clause stays an inline line).
  const nextBullets = nextStepBullets(report);
  const nextHtml =
    nextBullets.length >= 2
      ? `<div class="next" id="next-steps"><p class="next-h">Next steps</p><ul class="nextlist">${nextBullets.map((b) => `<li>${escapeWithCode(b)}</li>`).join("")}</ul></div>`
      : `<div class="next" id="next-steps"><p class="next-h">Next step</p><p>${escapeWithCode(report.nextAction)}</p></div>`;

  // The at-a-glance score: pass count + the GROUPED must-fix / likely-background counts (the same split
  // the sections show, so the scorecard never disagrees with a heading) + not-applicable.
  const passCount = report.summary.pass;
  const { mustFix: chipMustFix, likelyBackground: chipBackground } = partitionBackgroundCandidates(
    report.cr.blockingFailures,
    backgroundCandidatesFor(report),
  );
  const failCount = groupFindingsByDevice(chipMustFix).length;
  const declareCount = groupFindingsByDevice(chipBackground).length;
  const naCount = report.summary.notApplicable;
  const ratioTotal = Math.max(1, passCount + failCount + declareCount + naCount);
  const w = (n: number): string => `${((n / ratioTotal) * 100).toFixed(1)}%`;
  const arrow = `<span class="arrow"><svg viewBox="0 0 16 16" fill="none"><path d="M4 8h8M8.5 4.5L12 8l-3.5 3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></span>`;
  const stat = (tone: string, n: number, label: string, href: string): string =>
    `<a class="stat ${tone}" href="${href}"><div class="n"><span class="dot"></span>${n}</div><div class="l">${label}</div>${arrow}</a>`;
  const scorecard = `<div class="scorecard">
  <div class="ratiobar"><i class="green" style="width:${w(passCount)}"></i><i class="red" style="width:${w(failCount)}"></i><i class="amber" style="width:${w(declareCount)}"></i><i class="slate" style="width:${w(naCount)}"></i></div>
  <div class="score-grid">${stat("green", passCount, "Checks passed", "#what-passed")}${stat("red", failCount, "Must fix", "#must-fix")}${stat("amber", declareCount, "To declare", "#declare")}${stat("slate", naCount, "Not testable", "#not-asserted")}</div>
</div>`;

  // Hero: tone class + verdict icon + a plain-language verdict line, leading the report.
  const heroTone = banner.tone; // "ready" | "not-ready" | "cant-verify"
  const verdictText =
    report.status === "pass" ? "Ready to ship" : report.status === "incomplete" ? "Couldn't verify this build" : "Not ready to ship";
  const heroIcon =
    report.status === "pass"
      ? `<svg class="vicon" viewBox="0 0 40 40" fill="none" aria-hidden="true"><circle cx="20" cy="20" r="18.5" fill="#eefaf1" stroke="#bfe8cd" stroke-width="1.5"/><path d="M13 20.5l5 5 9-11" stroke="#1f9254" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`
      : report.status === "incomplete"
        ? `<svg class="vicon" viewBox="0 0 40 40" fill="none" aria-hidden="true"><circle cx="20" cy="20" r="18.5" fill="#fdf6ec" stroke="#f4e0bb" stroke-width="1.5"/><path d="M20 11.5v11.5M20 27.4v.2" stroke="#b66a06" stroke-width="2.6" stroke-linecap="round"/></svg>`
        : `<svg class="vicon" viewBox="0 0 40 40" fill="none" aria-hidden="true"><circle cx="20" cy="20" r="18.5" fill="#fef3f2" stroke="#f3c2bd" stroke-width="1.5"/><path d="M14 14l12 12M26 14L14 26" stroke="#d4343a" stroke-width="2.6" stroke-linecap="round"/></svg>`;
  let vsub: string;
  if (report.status === "pass") {
    vsub = "Every check that could run came back clean.";
  } else if (report.status === "incomplete") {
    vsub = "The test setup didn't capture it honestly, so this is not a game result.";
  } else if (failCount > 0) {
    vsub = `<b>${failCount} issue${failCount === 1 ? "" : "s"}</b> need${failCount === 1 ? "s" : ""} fixing before release. Everything else looks good.`;
  } else if (declareCount > 0) {
    vsub = `<b>${declareCount} background element${declareCount === 1 ? "" : "s"}</b> to declare. Everything else looks good.`;
  } else {
    vsub = "Some checks did not pass.";
  }
  const personSvg = `<svg viewBox="0 0 16 16" fill="none"><circle cx="8" cy="5.4" r="2.7" stroke="currentColor" stroke-width="1.4"/><path d="M3.4 13c0-2.3 2-3.7 4.6-3.7s4.6 1.4 4.6 3.7" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`;
  const phoneSvg = `<svg viewBox="0 0 16 16" fill="none"><rect x="1.5" y="4" width="13" height="8" rx="1.7" stroke="currentColor" stroke-width="1.4"/><circle cx="12.3" cy="8" r=".75" fill="currentColor"/></svg>`;
  const screensSvg = `<svg viewBox="0 0 16 16" fill="none"><rect x="2" y="2.5" width="7" height="7" rx="1.4" stroke="currentColor" stroke-width="1.4"/><rect x="7" y="6.5" width="7" height="7" rx="1.4" stroke="currentColor" stroke-width="1.4" fill="#fff"/></svg>`;
  const heroMeta = `<div class="hero-meta">
    <span class="tag-pill">${personSvg}${escapeHtml(c.ageBandLabel ?? c.ageBand)}</span>
    <span class="tag-pill">${phoneSvg}${escapeHtml(c.visualProfileLabel ?? c.visualProfile)}</span>
    <span class="tag-pill">${screensSvg}${report.summary.statesGraded} of ${report.summary.statesTotal} screens graded</span>
  </div>`;

  // "What passed" items: humanize passedSummary into the design's dot-separated, sentence-cased line.
  const passedItems = (() => {
    const s = passedSummary(report);
    const dotted = s.replace(/, /g, " · ");
    return dotted.charAt(0).toUpperCase() + dotted.slice(1);
  })();

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Release check: ${escapeHtml(title(report))}</title>
<style>${STYLE}</style>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Hanken+Grotesk:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
</head>
<body>
<div class="wrap">
<div class="topbar">
  <div class="brand">
    <span class="mark"><svg viewBox="0 0 24 24" fill="none"><path d="M3 8c3 0 3 3 6 3s3-3 6-3 3 3 6 3" stroke="#fff" stroke-width="2" stroke-linecap="round"/><path d="M3 14c3 0 3 3 6 3s3-3 6-3 3 3 6 3" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-opacity=".62"/></svg></span>
    <span>Loomtide <span class="sub">Release Check</span></span>
  </div>
  <span class="cmd">loomtide verify --minigame</span>
</div>
<div class="hero ${heroTone}">
  <p class="eyebrow"><span class="tick"></span> Minigame Release Check</p>
  <h1>${escapeHtml(title(report))}</h1>
  <div class="verdict-row">${heroIcon}<span class="verdict">${verdictText}</span></div>
  <p class="vsub">${vsub}</p>
  ${heroMeta}
</div>
${scorecard}
${sectionHtml}
<div class="passed" id="what-passed">
  <svg class="pi" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="11" fill="#eefaf1" stroke="#bfe8cd" stroke-width="1.3"/><path d="M7 12.3l3.2 3.2L17 8.5" stroke="#1f9254" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
  <div><b>What passed</b><div class="items">${escapeHtml(passedItems)}</div></div>
</div>
${nextHtml}
${galleryHtml}
<footer>Generated by <code>loomtide verify --minigame</code>. Full detail in the accompanying <code>.json</code> report.</footer>
</div>
<div class="lightbox" id="lb" onclick="this.classList.remove('show')"><div class="lbbox" id="lbbox"></div></div>
<script>
  function closeLb(){ document.getElementById('lb').classList.remove('show'); }
  function zoom(src){
    document.getElementById('lbbox').innerHTML = '<img class="lbplain" alt="Full screen" src="' + src + '">';
    document.getElementById('lb').classList.add('show');
  }
  // Enlarge an annotated shot as a two-pane card: the image + its overlay wrapped in a TIGHT frame
  // (.lbframe) so the %-positioned safe/element/seam boxes track the image exactly even when the side
  // detail panel is taller (the .lbshot letterboxes the extra space). A small toggle hides/shows the
  // annotation. Clicks inside the card don't close (only the backdrop / Esc).
  function zoomShot(el){
    var img = el.querySelector('img');
    var ovl = el.querySelector('.ovl');
    var detail = el.parentElement ? el.parentElement.querySelector('.detail') : null;
    var ovlHtml = '';
    if(ovl){
      var clone = ovl.cloneNode(true);
      var hint = clone.querySelector('.zoomhint');
      if(hint) hint.remove();
      ovlHtml = clone.outerHTML;
    }
    var toggle = ovl ? '<label class="anntoggle"><input type="checkbox" checked onchange="toggleAnn(this)"> annotation</label>' : '';
    var side = detail ? '<div class="lbside">' + detail.outerHTML + '</div>' : '';
    document.getElementById('lbbox').innerHTML =
      '<div class="lbwrap" onclick="event.stopPropagation()">' +
        '<button class="lbclose" title="Close" onclick="closeLb()">×</button>' +
        '<div class="lbshot"><div class="lbframe"><img alt="Full screen" src="' + img.getAttribute('src') + '">' + ovlHtml + '</div>' + toggle + '</div>' +
        side +
      '</div>';
    document.getElementById('lb').classList.add('show');
  }
  // Hide/show the annotation overlay in the enlarged view.
  function toggleAnn(cb){
    var shot = cb.closest('.lbshot');
    if(shot) shot.classList.toggle('annoff', !cb.checked);
  }
  // Report-driven background declaration: assemble the declare-background command from the ticked
  // containers/elements. A checked container emits its glob; an unchecked one emits its checked
  // children's exact locators (the per-element override). The HTML cannot write the contract, so the
  // dev copies this and runs it once.
  function buildDeclCmd(panel){
    var id = panel.getAttribute('data-id');
    var paths = [];
    panel.querySelectorAll('.bggroup').forEach(function(g){
      var cont = g.querySelector('.bgcont');
      if(cont && cont.checked){ paths.push(cont.getAttribute('data-glob')); }
      else { g.querySelectorAll('.bgel:checked').forEach(function(el){ paths.push(el.getAttribute('data-loc')); }); }
    });
    if(paths.length === 0) return '# tick at least one item above to declare it as background';
    return 'loomtide minigame declare-background --id ' + id + ' ' + paths.map(function(p){ return '"' + p + '"'; }).join(' ');
  }
  function updateDeclCmd(el){
    var panel = el.closest('.declpanel'); if(!panel) return;
    var g = el.closest('.bggroup');
    if(g){
      var cont = g.querySelector('.bgcont');
      var els = g.querySelectorAll('.bgel');
      // Keep the container box and its children in sync so the command always matches what's ticked:
      // ticking the container ticks every child (declare the whole glob); the container then mirrors
      // "all children ticked", so unticking ONE child drops just that piece (the container unticks and
      // the command lists the remaining children) while re-ticking them all collapses back to the glob.
      if(cont){
        if(el === cont){ els.forEach(function(c){ c.checked = cont.checked; }); }
        else { cont.checked = els.length > 0 && Array.prototype.every.call(els, function(c){ return c.checked; }); }
        g.classList.toggle('conton', !!cont.checked);
      }
    }
    var box = panel.querySelector('.declcmd'); if(box) box.value = buildDeclCmd(panel);
  }
  function copyDeclareCmd(btn){
    var panel = btn.closest('.declpanel'); if(!panel) return;
    var box = panel.querySelector('.declcmd');
    box.value = buildDeclCmd(panel);
    box.select();
    try { navigator.clipboard.writeText(box.value).then(function(){}, function(){}); } catch(e) { /* file:// blocks clipboard, text is selected for manual copy */ }
    var label = btn.textContent; btn.textContent = 'Copied ✓';
    setTimeout(function(){ btn.textContent = label; }, 1500);
  }
  document.addEventListener('keydown', function(e){
    if(e.key === 'Escape') document.getElementById('lb').classList.remove('show');
  });
</script>
</body>
</html>
`;
}
