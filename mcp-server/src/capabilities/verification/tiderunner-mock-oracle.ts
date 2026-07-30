/**
 * Tiderunner mock-oracle parser.
 *
 * Parses the Tiderunner design mock HTML (`Level Hero Shot.html`) and the locked feel doc
 * (`trailer-demo-concept.md`) into the generic `AcceptanceContract` shape for the Tiderunner fixture.
 *
 * Node has no DOM, so this uses lightweight regex/string parsing over the mock's
 * very regular structure:
 *   - palette: the `:root { --name: #hex; }` CSS variables
 *   - fonts:   the Google Fonts stack + the HUD `font-family` declaration + annotation A
 *   - HUD / juice / camera: the `.note[data-leader="X"]` blocks (A–J) with `<b>` numerics
 *
 * Feel targets are NOT visually encoded in the mock; they come from the feel doc's
 * "Proven feel params" block (parsed here) — or may be hand-authored and merged.
 *
 * The output is intended to MATCH the hand-authored `tiderunner.acceptance.json`
 * for the fields the mock encodes; feel is filled from the doc.
 */

import type {
  AcceptanceContract,
  DashTrailSpec,
  FontsSection,
  FramingSection,
  HudElement,
  HudSection,
  JuiceSection,
  ManifestSection,
  PaletteEntry,
  PaletteSection,
  WinSection,
  FeelSection,
} from "./types.js";
import { ACCEPTANCE_SCHEMA_VERSION } from "./types.js";

// ---------------------------------------------------------------------------
// Small parse helpers
// ---------------------------------------------------------------------------

/** Strip HTML tags, collapse whitespace, decode the few entities the mock uses. */
function stripTags(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&ldquo;|&rdquo;/g, '"')
    .replace(/&nbsp;/g, " ")
    .replace(/&times;|×/g, "x")
    .replace(/&[a-z]+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** First numeric (int or float, allows leading sign) found in a string. */
function firstNumber(s: string): number | undefined {
  const m = s.match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : undefined;
}

/** All numerics in a string, in order. */
function allNumbers(s: string): number[] {
  const out: number[] = [];
  const re = /-?\d+(?:\.\d+)?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) out.push(Number(m[0]));
  return out;
}

// ---------------------------------------------------------------------------
// Mock HTML extraction
// ---------------------------------------------------------------------------

export interface MockNote {
  id: string;
  /** category class on the note: hud | juice | camera | para */
  category: string;
  /** the raw inner text of the `.body` element. */
  body: string;
  /** the `<b>` bolded fragments, in order. */
  bolds: string[];
}

/** Parse the `:root { ... }` CSS palette variables → { name → hex }. */
export function parsePaletteVars(html: string): Record<string, string> {
  const vars: Record<string, string> = {};
  const rootMatch = html.match(/:root\s*\{([\s\S]*?)\}/);
  if (!rootMatch) return vars;
  const re = /--([\w-]+)\s*:\s*(#[0-9a-fA-F]{3,8})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(rootMatch[1])) !== null) {
    vars[m[1]] = m[2].toLowerCase();
  }
  return vars;
}

/** Parse all `.note[data-leader="X"]` annotation blocks A–J. */
export function parseNotes(html: string): MockNote[] {
  const notes: MockNote[] = [];
  // Each note: <div class="note <cat>" data-leader="X" ...> ... </div>
  // The notes are flat siblings (no nested .note), so match greedily up to the
  // next note/structural boundary by capturing class + id then the following
  // .body block which holds the spec.
  const noteRe =
    /<div class="note ([a-z]+)" data-leader="([A-J])"[^>]*>([\s\S]*?)(?=<div class="note |<!-- =|<\/div><!-- \/\.stage|<svg)/g;
  let m: RegExpExecArray | null;
  while ((m = noteRe.exec(html)) !== null) {
    const category = m[1];
    const id = m[2];
    const inner = m[3];
    const bodyMatch = inner.match(/<div class="body">([\s\S]*?)<\/div>/);
    const bodyHtml = bodyMatch ? bodyMatch[1] : inner;
    const bolds: string[] = [];
    const bRe = /<b>([\s\S]*?)<\/b>/g;
    let bm: RegExpExecArray | null;
    while ((bm = bRe.exec(bodyHtml)) !== null) {
      bolds.push(stripTags(bm[1]));
    }
    notes.push({ id, category, body: stripTags(bodyHtml), bolds });
  }
  return notes;
}

function noteById(notes: MockNote[], id: string): MockNote | undefined {
  return notes.find((n) => n.id === id);
}

/**
 * Resolve the HUD font from the `.hud { font-family: ... }` declaration.
 * The mock uses `font-family: 'Press Start 2P', monospace;`.
 */
export function parseHudFont(html: string): string | undefined {
  const hud = html.match(/\.hud\s*\{[\s\S]*?font-family:\s*([^;]+);/);
  if (!hud) return undefined;
  const first = hud[1].split(",")[0].trim().replace(/^['"]|['"]$/g, "");
  return first || undefined;
}

// ---------------------------------------------------------------------------
// Section builders (mock-derived)
// ---------------------------------------------------------------------------

function buildPalette(vars: Record<string, string>): PaletteSection {
  // Map the mock's semantic CSS vars to acceptance roles.
  const roleMap: Record<string, string[]> = {
    ink: ["background"],
    hud: ["hud-accent"],
    juice: ["juice", "hearts"],
    camera: ["camera-frame"],
    para: ["parallax"],
  };
  const entries: PaletteEntry[] = [];
  const names: Record<string, string> = {
    hud: "cyan",
    juice: "magenta",
    camera: "gold",
    para: "lavender",
    ink: "ink",
  };
  for (const [key, roles] of Object.entries(roleMap)) {
    const hex = vars[key];
    if (hex && /^#[0-9a-f]{6}$/.test(hex)) {
      entries.push({ hex, roles, name: names[key] });
    }
  }
  // The HUD score color (#ffd166 gold) is NOT a :root var — it is inlined in
  // `.hud .score .x { color: #ffd166; }`. Annotation A also calls it out. Add it.
  entries.push({ hex: "#ffd166", roles: ["score", "fruit-counter"], name: "gold" });
  // The timer renders white and is also not a :root var. The `timer` HUD element
  // maps to a `timer` colorRole, so the palette MUST carry that role or the color
  // check degrades to an un-checkable warn (Phase F reconcile #4). The build's
  // TimerLabel is pure #ffffff, so the role hex must match it.
  entries.push({ hex: "#ffffff", roles: ["timer"], name: "hud-white" });
  return { entries };
}

function buildFonts(hudFont: string | undefined): FontsSection {
  const family = hudFont ?? "Press Start 2P";
  return {
    global: { family: "Press Start 2P", note: "HUD font; pixel display face, monospace fallback." },
    byRole: {
      score: { family },
      lives: { family },
      timer: { family },
    },
  };
}

function buildHud(notes: MockNote[]): HudSection {
  const elements: HudElement[] = [];

  // A · Score (top-left, #ffd166, Press Start 2P, ×NN / total)
  const a = noteById(notes, "A");
  elements.push({
    id: "score",
    role: "Fruit counter",
    anchor: "top-left",
    insetPx: a ? firstNumber(a.bolds.find((b) => /px/.test(b)) ?? "24") ?? 24 : 24,
    colorRole: "score",
    font: "Press Start 2P",
    format: "×NN / total",
    required: true,
    note: a?.body,
  });

  // C · Timer (top-center, mm:ss:ff) — optional in story mode
  const c = noteById(notes, "C");
  elements.push({
    id: "timer",
    role: "Run timer",
    anchor: "top-center",
    colorRole: "timer",
    font: "Press Start 2P",
    format: "mm:ss:ff",
    required: false,
    note: c?.body,
  });

  // B · Lives (top-right, 3 hearts, magenta)
  const b = noteById(notes, "B");
  elements.push({
    id: "lives",
    role: "Heart row",
    anchor: "top-right",
    insetPx: b ? firstNumber(b.bolds.find((x) => /px/.test(x)) ?? "24") ?? 24 : 24,
    colorRole: "hearts",
    font: "Press Start 2P",
    format: "3 hearts (empty pip on loss)",
    required: true,
    note: b?.body,
  });

  return { elements };
}

function buildFraming(notes: MockNote[]): FramingSection {
  // I · Camera framing — "16 × 9 tiles", "256 × 144 native @ 5×", anchor 40% W.
  const i = noteById(notes, "I");
  let aspect = { w: 16, h: 9 };
  let nativeResolution = { w: 256, h: 144 };
  let pixelScale = 5;
  let anchorFraction = 0.4;

  if (i) {
    // Anchor: find the bold that contains a percent.
    const pctBold = i.bolds.find((bx) => /%/.test(bx));
    if (pctBold) {
      const pct = firstNumber(pctBold);
      if (pct !== undefined) anchorFraction = pct / 100;
    }
    // Native resolution: the bold like "256 x 144 native".
    const nativeBold = i.bolds.find((bx) => /native/i.test(bx));
    if (nativeBold) {
      const nums = allNumbers(nativeBold);
      if (nums.length >= 2) nativeResolution = { w: nums[0], h: nums[1] };
    }
    // Pixel scale: the bold that is a single number immediately followed by "x"
    // (e.g. "5x pixel scale") — distinct from the two-number "WxH" dimension bolds.
    // `allNumbers` of "256 x 144" yields 2 entries; the scale bold yields exactly 1.
    const scaleBold = i.bolds.find((bx) => allNumbers(bx).length === 1 && /^\s*\d+(?:\.\d+)?\s*x/i.test(bx));
    if (scaleBold) {
      const s = firstNumber(scaleBold);
      if (s !== undefined) pixelScale = s;
    }
    // Aspect: the bold like "16 x 9 tiles".
    const tilesBold = i.bolds.find((bx) => /tile/i.test(bx));
    if (tilesBold) {
      const nums = allNumbers(tilesBold);
      if (nums.length >= 2) aspect = { w: nums[0], h: nums[1] };
    }
  }

  return {
    aspect,
    nativeResolution,
    pixelScale,
    playerAnchor: {
      centerXFraction: anchorFraction,
      tolerance: 0.05,
      note:
        "Mock 'lead-the-look' implies a FOLLOWING camera; Tiderunner ships a static one-screen " +
        "camera, so a fixed 40% anchor may not literally apply. Phase-F design reconcile.",
    },
    verticalPan: false,
    note: i?.body,
  };
}

function buildDashTrail(notes: MockNote[]): DashTrailSpec | undefined {
  // D · Dash trail — "3 ghost copies", opacities "52 / 32 / 18 %", "10 px", "80 ms".
  const d = noteById(notes, "D");
  if (!d) return undefined;
  const ghostsBold = d.bolds.find((b) => /ghost/i.test(b));
  const ghosts = ghostsBold ? firstNumber(ghostsBold) ?? 3 : 3;
  const opBold = d.bolds.find((b) => /%/.test(b) && /\//.test(b));
  const opacities = opBold ? allNumbers(opBold) : [52, 32, 18];
  const spacingBold = d.bolds.find((b) => /px/.test(b));
  const spacingPx = spacingBold ? firstNumber(spacingBold) : 10;
  const holdBold = d.bolds.find((b) => /ms/.test(b));
  const holdMs = holdBold ? firstNumber(holdBold) : 80;
  return { ghosts, opacities, spacingPx, holdMs, tint: "cyan / screen blend", note: d.body };
}

function buildJuice(notes: MockNote[]): JuiceSection {
  const juice: JuiceSection = {};

  const dashTrail = buildDashTrail(notes);
  if (dashTrail) juice.dashTrail = dashTrail;

  // E · Landing dust — "4 dust particles", "±6 px", "240 ms".
  const e = noteById(notes, "E");
  if (e) {
    const particlesBold = e.bolds.find((b) => /particle/i.test(b));
    const spreadBold = e.bolds.find((b) => /px/.test(b));
    const fadeBold = e.bolds.find((b) => /ms/.test(b));
    juice.landingDust = {
      particles: particlesBold ? firstNumber(particlesBold) ?? 4 : 4,
      spreadXPx: spreadBold ? Math.abs(firstNumber(spreadBold) ?? 6) : 6,
      fadeMs: fadeBold ? firstNumber(fadeBold) ?? 240 : 240,
      note: e.body,
    };
  }

  // F · Fruit pop — "Collected.png 6-frame", scale "1.0 → 1.4 → 0", "6" sparkles, "coin_05.wav".
  const f = noteById(notes, "F");
  if (f) {
    const frameBold = f.bolds.find((b) => /frame/i.test(b));
    const scaleBold = f.bolds.find((b) => /→|->|to/.test(b) || allNumbers(b).length >= 3);
    const sparkBold =
      f.bolds.find((b) => /sparkle/i.test(b)) ??
      f.body.match(/sparkles?\s*\((\d+)\)/i)?.[0];
    const sfxBold = f.bolds.find((b) => /\.wav/i.test(b));
    const sparkleCount =
      f.body.match(/sparkles?\s*\((\d+)\)/i)?.[1] ??
      (typeof sparkBold === "string" ? firstNumber(sparkBold) : undefined);
    juice.fruitPop = {
      frames: frameBold ? firstNumber(frameBold) ?? 6 : 6,
      scaleKeyframes: scaleBold ? allNumbers(scaleBold) : [1.0, 1.4, 0],
      sparkles: sparkleCount !== undefined ? Number(sparkleCount) : 6,
      sfx: sfxBold ? sfxBold.trim() : "coin_05.wav",
      note: f.body,
    };
  }

  // G · Hit-stop — single bold "6 frames (100 ms)", + flash white 1 frame.
  const g = noteById(notes, "G");
  if (g) {
    const msBold = g.bolds.find((b) => /ms/.test(b));
    const frameBold = g.bolds.find((b) => /frame/i.test(b));
    // The ms value is the number immediately preceding "ms" (the bold packs both
    // "6 frames" and "(100 ms)"), so grab the number that precedes the ms token.
    const msMatch = msBold?.match(/(-?\d+(?:\.\d+)?)\s*ms/i);
    juice.hitStop = {
      ms: msMatch ? Number(msMatch[1]) : 100,
      frames: frameBold ? firstNumber(frameBold) ?? 6 : 6,
      playerFlashWhite: /flash(es)? white/i.test(g.body),
      note: g.body,
    };
  }

  // H · Screen shake — amplitude "4 px", "180 ms" decay, hit-only (NOT landing).
  const h = noteById(notes, "H");
  if (h) {
    const pxBold = h.bolds.find((b) => /px/.test(b));
    const msBold = h.bolds.find((b) => /ms/.test(b));
    const hitOnly = /hit only|NOT on landing|not on land/i.test(h.body);
    juice.screenShake = {
      amplitudePx: pxBold ? firstNumber(pxBold) ?? 4 : 4,
      decayMs: msBold ? firstNumber(msBold) ?? 180 : 180,
      trigger: hitOnly ? "hit-only" : "hit-and-land",
      note: h.body,
    };
  }

  // J · Parallax — "Sky × 0.3" → "Hills × 0.6" → "Foreground × 1.0".
  const j = noteById(notes, "J");
  if (j) {
    const layers = j.bolds
      .map((b) => {
        const factor = firstNumber(b);
        const name = b.replace(/[×x].*$/i, "").trim();
        if (factor === undefined || !name) return undefined;
        return { name, factor };
      })
      .filter((x): x is { name: string; factor: number } => x !== undefined);
    juice.parallax = {
      layers: layers.length > 0 ? layers : [
        { name: "Sky", factor: 0.3 },
        { name: "Hills", factor: 0.6 },
        { name: "Foreground", factor: 1.0 },
      ],
      note: j.body,
    };
  }

  return juice;
}

// ---------------------------------------------------------------------------
// Feel doc extraction (trailer-demo-concept.md)
// ---------------------------------------------------------------------------

/**
 * Parse the locked "Proven feel params" block from trailer-demo-concept.md.
 * Falls back to the locked literals if the doc text is unavailable.
 */
export function parseFeelFromDoc(markdown: string): FeelSection {
  const text = markdown.replace(/\s+/g, " ");

  const grab = (re: RegExp): number | undefined => {
    const m = text.match(re);
    return m ? Number(m[1]) : undefined;
  };

  const runSpeed = grab(/run\s+([\d.]+)\s*u\/s/i) ?? grab(/moveSpeed\s+([\d.]+)/i) ?? 7;
  const jumpApex = grab(/apex\s+\**([\d.]+)u/i) ?? 2.2;
  const timeToApex = grab(/@\s*\**([\d.]+)\s*ms/i) ?? 325;
  const shortHop = grab(/short hop\s+([\d.]+)u/i) ?? 1.41;
  const dashDist = grab(/\*\*([\d.]+)u\*\*\s*dash/i) ?? grab(/([\d.]+)u\s*dash/i) ?? 3.0;
  const dashTime = grab(/dashTime\s+([\d.]+)/i) ?? 0.15;
  const dashCooldown = grab(/dashCooldown\s+([\d.]+)/i) ?? 0.4;
  const coyote = grab(/coyote[^\d]*([\d.]+)\s*s/i) ?? 0.1;
  const buffer = grab(/buffer[^\d]*([\d.]+)\s*s/i) ?? grab(/jump-?buffer\s*\(([\d.]+)s\)/i) ?? 0.1;

  return {
    runSpeed: { target: runSpeed, unit: "u/s", band: { percent: 5 }, note: "moveSpeed 7" },
    jumpApex: { target: jumpApex, unit: "u", band: { percent: 5 }, note: "jumpSpeed 14.22 + gravityScale 4.402" },
    timeToApex: { target: timeToApex, unit: "ms", band: { percent: 10 } },
    shortHopApex: { target: shortHop, unit: "u", band: { percent: 10 }, note: "canonical 6-tick tap plateau" },
    dashDistance: { target: dashDist, unit: "u", band: { percent: 5 }, note: "dashSpeed 18.75 / dashTime 0.15" },
    dashTime: { target: dashTime, unit: "s", band: { percent: 10 } },
    dashCooldown: { target: dashCooldown, unit: "s", band: { percent: 10 }, note: "one dash per airtime" },
    coyoteTime: { target: coyote, unit: "s", band: { abs: 0.02 } },
    jumpBuffer: { target: buffer, unit: "s", band: { abs: 0.02 } },
  };
}

// ---------------------------------------------------------------------------
// Manifest + win (not visually encoded; derived from mock props + plan §3.3)
// ---------------------------------------------------------------------------

function buildManifest(): ManifestSection {
  // Derived from the mock's pixel-world props: player, terrain tiles, fruit,
  // saw + spikes hazards, the flag/checkpoint. Tiderunner fixture input contract (§3.1).
  return {
    matching: "regex",
    caseSensitive: false,
    extrasAreFailure: false,
    elements: [
      { nameRegex: "player|ninja|frog", type: "GameObject", primitive: "player", required: true },
      { nameRegex: "ground|tile|platform|terrain", type: "GameObject", primitive: "tile", minCount: 1, required: true },
      { nameRegex: "fruit|apple|cherr|strawberry|banana|kiwi", type: "GameObject", primitive: "collectible", minCount: 1, required: true },
      { nameRegex: "saw", type: "GameObject", primitive: "hazard", required: true },
      { nameRegex: "spike", type: "GameObject", primitive: "hazard", required: true },
      { nameRegex: "flag|checkpoint|goal", type: "GameObject", primitive: "goal", required: true },
      { nameRegex: "GameManager", type: "GameObject", required: true },
    ],
  };
}

function buildWin(): WinSection {
  return {
    rule: "reach-flag",
    buildRule: "all-fruit (GameManager.isWin flips on score >= totalCoins, or WinLevel())",
    note:
      "Mock goal is the flag, so the intended rule is reach-flag. The CURRENT build sets isWin on " +
      "all-fruit-collected (score >= totalCoins), which can win away from the flag — a mismatch to " +
      "reconcile in Phase F (conform build to reach-flag, or consciously adopt all-fruit).",
  };
}

// ---------------------------------------------------------------------------
// Top-level: parse mock + feel doc → AcceptanceContract
// ---------------------------------------------------------------------------

export interface ParseMockOptions {
  /** Game id for the produced contract. Defaults "tiderunner". */
  game?: string;
  /** Provenance paths recorded under `source`. */
  mockPath?: string;
  feelDocPath?: string;
}

/**
 * Parse the mock HTML (and optional feel-doc markdown) into an AcceptanceContract.
 * If `feelDocMarkdown` is omitted, the feel section uses the locked literals.
 */
export function parseMockToAcceptance(
  mockHtml: string,
  feelDocMarkdown?: string,
  options: ParseMockOptions = {},
): AcceptanceContract {
  const vars = parsePaletteVars(mockHtml);
  const notes = parseNotes(mockHtml);
  const hudFont = parseHudFont(mockHtml);

  return {
    schemaVersion: ACCEPTANCE_SCHEMA_VERSION,
    game: options.game ?? "tiderunner",
    source: {
      mock: options.mockPath,
      feelDoc: options.feelDocPath,
      note: "Visual/HUD/juice/camera parsed from the mock; feel from the feel doc.",
    },
    fonts: buildFonts(hudFont),
    palette: buildPalette(vars),
    hud: buildHud(notes),
    framing: buildFraming(notes),
    feel: parseFeelFromDoc(feelDocMarkdown ?? ""),
    juice: buildJuice(notes),
    manifest: buildManifest(),
    win: buildWin(),
  };
}
