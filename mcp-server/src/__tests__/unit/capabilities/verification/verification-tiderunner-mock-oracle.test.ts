import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  parseFeelFromDoc,
  parseHudFont,
  parseMockToAcceptance,
  parseNotes,
  parsePaletteVars,
} from "../../../../capabilities/verification/tiderunner-mock-oracle.js";
import { validateAcceptanceContract } from "../../../../capabilities/verification/validator.js";
import type { AcceptanceContract } from "../../../../capabilities/verification/types.js";
import { REPO_ROOT } from "../../../_support/paths.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = REPO_ROOT;
const mockPath = path.join(
  repoRoot,
  "mcp-server/src/__tests__/fixtures/design-briefs/level-hero-shot.html",
);
// Relocated from .planning (internal) into the test-fixture tree for the OSS export.
const feelDocPath = path.join(repoRoot, "mcp-server/src/__tests__/fixtures/design-briefs/trailer-demo-concept.md");
const acceptancePath = path.join(
  repoRoot,
  "mcp-server/src/capabilities/verification/tiderunner.acceptance.json",
);

async function loadMock(): Promise<string> {
  return fs.readFile(mockPath, "utf-8");
}
async function loadFeelDoc(): Promise<string> {
  return fs.readFile(feelDocPath, "utf-8");
}
async function loadAcceptance(): Promise<AcceptanceContract> {
  return JSON.parse(await fs.readFile(acceptancePath, "utf-8")) as AcceptanceContract;
}

// ---------------------------------------------------------------------------
// Low-level parse primitives
// ---------------------------------------------------------------------------

test("tiderunner-mock-oracle: parses :root palette vars", async () => {
  const vars = parsePaletteVars(await loadMock());
  assert.equal(vars.ink, "#0d1015");
  assert.equal(vars.hud, "#4dd0e1");
  assert.equal(vars.juice, "#ff4d8d");
  assert.equal(vars.camera, "#ffc857");
  assert.equal(vars.para, "#b388ff");
});

test("tiderunner-mock-oracle: resolves HUD font to Press Start 2P", async () => {
  const font = parseHudFont(await loadMock());
  assert.equal(font, "Press Start 2P");
});

test("tiderunner-mock-oracle: parses all 10 annotation notes A-J", async () => {
  const notes = parseNotes(await loadMock());
  const ids = notes.map((n) => n.id).sort();
  assert.deepEqual(ids, ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"]);
});

// ---------------------------------------------------------------------------
// Full contract assembly — key values per the deliverable spec
// ---------------------------------------------------------------------------

test("tiderunner-mock-oracle: produced contract validates against the schema", async () => {
  const contract = parseMockToAcceptance(await loadMock(), await loadFeelDoc(), {
    game: "tiderunner",
    mockPath,
    feelDocPath,
  });
  const result = validateAcceptanceContract(contract);
  assert.equal(result.valid, true, JSON.stringify(result.issues, null, 2));
});

test("tiderunner-mock-oracle: palette includes HUD score gold #ffd166", async () => {
  const contract = parseMockToAcceptance(await loadMock());
  const hexes = contract.palette.entries.map((e) => e.hex);
  assert.ok(hexes.includes("#ffd166"), `expected #ffd166 in ${hexes.join(",")}`);
  const score = contract.palette.entries.find((e) => e.roles.includes("score"));
  assert.equal(score?.hex, "#ffd166");
});

test("tiderunner-mock-oracle: fonts require Press Start 2P globally and for score", async () => {
  const contract = parseMockToAcceptance(await loadMock());
  assert.equal(contract.fonts.global?.family, "Press Start 2P");
  assert.equal(contract.fonts.byRole?.score?.family, "Press Start 2P");
});

test("tiderunner-mock-oracle: HUD elements anchored per the mock", async () => {
  const contract = parseMockToAcceptance(await loadMock());
  const byId = Object.fromEntries(contract.hud.elements.map((e) => [e.id, e]));
  assert.equal(byId.score.anchor, "top-left");
  assert.equal(byId.score.colorRole, "score");
  assert.equal(byId.lives.anchor, "top-right");
  assert.equal(byId.timer.anchor, "top-center");
  assert.equal(byId.timer.required, false);
});

test("tiderunner-mock-oracle: dash trail has 3 ghosts and opacities 52/32/18", async () => {
  const contract = parseMockToAcceptance(await loadMock());
  const dt = contract.juice.dashTrail;
  assert.equal(dt?.ghosts, 3);
  assert.deepEqual(dt?.opacities, [52, 32, 18]);
  assert.equal(dt?.spacingPx, 10);
  assert.equal(dt?.holdMs, 80);
});

test("tiderunner-mock-oracle: landing dust 4 particles, ±6px, 240ms", async () => {
  const contract = parseMockToAcceptance(await loadMock());
  const ld = contract.juice.landingDust;
  assert.equal(ld?.particles, 4);
  assert.equal(ld?.spreadXPx, 6);
  assert.equal(ld?.fadeMs, 240);
});

test("tiderunner-mock-oracle: fruit pop 6-frame, scale 1.0->1.4->0, 6 sparkles", async () => {
  const contract = parseMockToAcceptance(await loadMock());
  const fp = contract.juice.fruitPop;
  assert.equal(fp?.frames, 6);
  assert.deepEqual(fp?.scaleKeyframes, [1.0, 1.4, 0]);
  assert.equal(fp?.sparkles, 6);
  assert.equal(fp?.sfx, "coin_05.wav");
});

test("tiderunner-mock-oracle: hit-stop is 100ms / 6 frames with white flash", async () => {
  const contract = parseMockToAcceptance(await loadMock());
  const hs = contract.juice.hitStop;
  assert.equal(hs?.ms, 100);
  assert.equal(hs?.frames, 6);
  assert.equal(hs?.playerFlashWhite, true);
});

test("tiderunner-mock-oracle: screen shake 4px amplitude, hit-only trigger", async () => {
  const contract = parseMockToAcceptance(await loadMock());
  const ss = contract.juice.screenShake;
  assert.equal(ss?.amplitudePx, 4);
  assert.equal(ss?.decayMs, 180);
  assert.equal(ss?.trigger, "hit-only");
});

test("tiderunner-mock-oracle: parallax 3 layers Sky/Hills/Foreground at 0.3/0.6/1.0", async () => {
  const contract = parseMockToAcceptance(await loadMock());
  const layers = contract.juice.parallax?.layers ?? [];
  assert.equal(layers.length, 3);
  assert.deepEqual(
    layers.map((l) => [l.name, l.factor]),
    [
      ["Sky", 0.3],
      ["Hills", 0.6],
      ["Foreground", 1.0],
    ],
  );
});

test("tiderunner-mock-oracle: camera framing 16x9, native 256x144 @ 5x, anchor 40%", async () => {
  const contract = parseMockToAcceptance(await loadMock());
  const f = contract.framing;
  assert.deepEqual(f.aspect, { w: 16, h: 9 });
  assert.deepEqual(f.nativeResolution, { w: 256, h: 144 });
  assert.equal(f.pixelScale, 5);
  assert.equal(f.verticalPan, false);
  assert.equal(f.playerAnchor.centerXFraction, 0.4);
});

test("tiderunner-mock-oracle: feel parsed from the feel doc (apex 2.2u, dash 2.8125u, run 7)", async () => {
  const feel = parseFeelFromDoc(await loadFeelDoc());
  assert.equal(feel.runSpeed?.target, 7);
  assert.equal(feel.jumpApex?.target, 2.2);
  assert.equal(feel.timeToApex?.target, 325);
  assert.equal(feel.shortHopApex?.target, 1.41);
  // Phase F reconcile corrected the dash arithmetic slip: 18.75 × 0.15 = 2.8125u.
  assert.equal(feel.dashDistance?.target, 2.8125);
  assert.equal(feel.dashTime?.target, 0.15);
  assert.equal(feel.coyoteTime?.target, 0.1);
  assert.equal(feel.jumpBuffer?.target, 0.1);
});

test("tiderunner-mock-oracle: parser still reflects the mock's reach-flag goal (pre-reconcile spec)", async () => {
  // The parser encodes what the mock literally says (the flag is the goal). The
  // hand-authored contract has since been reconciled to all-fruit in Phase F;
  // the two intentionally diverge on win.rule (see the divergence test below).
  const contract = parseMockToAcceptance(await loadMock(), await loadFeelDoc());
  assert.equal(contract.win.rule, "reach-flag");
  assert.match(contract.win.buildRule ?? "", /all-fruit/i);
});

// ---------------------------------------------------------------------------
// Hand-authored Tiderunner instance: valid + covered by the parser
// ---------------------------------------------------------------------------

test("tiderunner.acceptance.json validates against the schema", async () => {
  const contract = await loadAcceptance();
  const result = validateAcceptanceContract(contract);
  assert.equal(result.valid, true, JSON.stringify(result.issues, null, 2));
});

test("tiderunner.acceptance.json declares the 6 SFX cues + an SfxPlayer", async () => {
  const contract = await loadAcceptance();
  assert.ok(contract.audio, "audio section should be present");
  assert.equal(contract.audio?.playerComponent, "SfxPlayer");
  const cueIds = (contract.audio?.cues ?? []).map((c) => c.id).sort();
  assert.deepEqual(cueIds, ["bounce", "collect", "dash", "hit", "jump", "win"]);
  for (const cue of contract.audio?.cues ?? []) {
    assert.ok(cue.clip.startsWith("Assets/Audio/"), `cue ${cue.id} clip should live under Assets/Audio/`);
  }
  // The SfxPlayer is verified by the existing manifest gate — assert the manifest
  // entry exists so manifest presence (not a bespoke audio gate) covers it.
  const hasSfxManifest = contract.manifest.elements.some(
    (e) => e.nameRegex === "SfxPlayer" || e.name === "SfxPlayer",
  );
  assert.ok(hasSfxManifest, "manifest should require an SfxPlayer GameObject");
});

test("validator accepts a valid audio section and rejects bad cues", () => {
  const base = {
    schemaVersion: "1",
    game: "x",
    fonts: { global: { family: "F" } },
    palette: { entries: [{ hex: "#ffd166", roles: ["score"] }] },
    hud: { elements: [{ id: "score", role: "r", anchor: "top-left" }] },
    framing: { aspect: { w: 16, h: 9 }, playerAnchor: { centerXFraction: 0.4, tolerance: 0.05 } },
    feel: {},
    juice: {},
    manifest: { matching: "exact", elements: [{ name: "P", type: "GameObject" }] },
    win: { rule: "reach-flag" },
  };
  // valid audio section
  assert.equal(
    validateAcceptanceContract({
      ...base,
      audio: { playerComponent: "SfxPlayer", cues: [{ id: "jump", clip: "Assets/Audio/jump.wav" }] },
    }).valid,
    true,
  );
  // duplicate cue id
  const dup = validateAcceptanceContract({
    ...base,
    audio: {
      cues: [
        { id: "jump", clip: "a.wav" },
        { id: "jump", clip: "b.wav" },
      ],
    },
  });
  assert.equal(dup.valid, false);
  assert.ok(dup.issues.some((i) => i.code === "DUPLICATE_AUDIO_ID"));
  // missing clip + empty cues
  assert.ok(
    validateAcceptanceContract({ ...base, audio: { cues: [{ id: "jump" }] } }).issues.some(
      (i) => i.path === "audio.cues[0].clip",
    ),
  );
  assert.ok(
    validateAcceptanceContract({ ...base, audio: { cues: [] } }).issues.some(
      (i) => i.path === "audio.cues",
    ),
  );
});

test("validator accepts generic gateTuning and rejects non-object gate rows", () => {
  const base = {
    schemaVersion: "1",
    game: "x",
    fonts: { global: { family: "F" } },
    palette: { entries: [{ hex: "#ffd166", roles: ["score"] }] },
    hud: { elements: [{ id: "score", role: "r", anchor: "top-left" }] },
    framing: { aspect: { w: 16, h: 9 }, playerAnchor: { centerXFraction: 0.4, tolerance: 0.05 } },
    feel: {},
    juice: {},
    manifest: { matching: "exact", elements: [{ name: "P", type: "GameObject" }] },
    win: { rule: "reach-flag" },
  };
  assert.equal(
    validateAcceptanceContract({
      ...base,
      gateTuning: { byGate: { "platform-tiles": { tileIntegerTolerance: 0.02 } } },
    }).valid,
    true,
  );
  const result = validateAcceptanceContract({
    ...base,
    gateTuning: { byGate: { "platform-tiles": 0.02 } },
  });
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((i) => i.path === "gateTuning.byGate.platform-tiles"));

  const unsafe = validateAcceptanceContract({
    ...base,
    gateTuning: {
      byGate: {
        "platform-tiles": { tileIntegerTolerance: -1 },
        "tile-render": { tileRenderEdgeCols: 1.5 },
      },
    },
  });
  assert.equal(unsafe.valid, false);
  assert.ok(unsafe.issues.some((i) => i.path === "gateTuning.byGate.platform-tiles.tileIntegerTolerance"));
  assert.ok(unsafe.issues.some((i) => i.path === "gateTuning.byGate.tile-render.tileRenderEdgeCols"));
});

test("validator rejects a contract missing required sections", () => {
  const result = validateAcceptanceContract({ schemaVersion: "1", game: "x" });
  assert.equal(result.valid, false);
  const paths = result.issues.map((i) => i.path);
  assert.ok(paths.includes("fonts"));
  assert.ok(paths.includes("palette.entries"));
  assert.ok(paths.includes("hud.elements"));
  assert.ok(paths.includes("framing"));
  assert.ok(paths.includes("win.rule"));
});

test("validator rejects a bad hex and an out-of-range anchor fraction", () => {
  const result = validateAcceptanceContract({
    schemaVersion: "1",
    game: "x",
    fonts: { global: { family: "F" } },
    palette: { entries: [{ hex: "ffd166", roles: ["score"] }] },
    hud: { elements: [{ id: "score", role: "r", anchor: "top-left" }] },
    framing: { aspect: { w: 16, h: 9 }, playerAnchor: { centerXFraction: 1.4, tolerance: 0.05 } },
    feel: {},
    juice: {},
    manifest: { matching: "exact", elements: [{ name: "P", type: "GameObject" }] },
    win: { rule: "reach-flag" },
  });
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((i) => i.code === "INVALID_HEX"));
  assert.ok(result.issues.some((i) => i.code === "INVALID_ANCHOR_FRACTION"));
});

test("validator rejects unsafe capturePack paths (no `..`, no absolute, no escaping state names)", () => {
  const baseContract = {
    schemaVersion: "1",
    game: "x",
    fonts: { global: { family: "F" } },
    palette: { entries: [{ hex: "#ffd166", roles: ["score"] }] },
    hud: { elements: [{ id: "score", role: "r", anchor: "top-left" }] },
    framing: { aspect: { w: 16, h: 9 }, playerAnchor: { centerXFraction: 0.5, tolerance: 0.05 } },
    feel: {},
    juice: {},
    manifest: { matching: "exact", elements: [{ name: "P", type: "GameObject" }] },
    win: { rule: "reach-flag" },
  };

  // (1) Path traversal in a requiredCaptures entry.
  const traversal = validateAcceptanceContract({
    ...baseContract,
    capturePack: {
      states: [{ name: "spawn", requiredCaptures: ["../reports/build-verdict.json"] }],
    },
  });
  assert.equal(traversal.valid, false);
  assert.ok(
    traversal.issues.some((i) => i.code === "UNSAFE_CAPTURE_PATH"),
    "must reject `..` in capture paths",
  );

  // (2) Absolute path in a requiredCaptures entry.
  const absolutePath = validateAcceptanceContract({
    ...baseContract,
    capturePack: {
      states: [{ name: "spawn", requiredCaptures: ["/etc/passwd"] }],
    },
  });
  assert.equal(absolutePath.valid, false);
  assert.ok(absolutePath.issues.some((i) => i.code === "UNSAFE_CAPTURE_PATH"));

  // (3) Escaping state name (would project into "../foo/manifest.json" at mint).
  const badStateName = validateAcceptanceContract({
    ...baseContract,
    capturePack: { states: [{ name: "..", requiredCaptures: ["manifest.json"] }] },
  });
  assert.equal(badStateName.valid, false);
  assert.ok(badStateName.issues.some((i) => i.code === "UNSAFE_STATE_NAME"));

  // Sanity: a safe pack passes.
  const good = validateAcceptanceContract({
    ...baseContract,
    capturePack: {
      states: [{ name: "spawn", requiredCaptures: ["manifest.json", "spawn/screen-rects.json"] }],
    },
  });
  assert.equal(good.valid, true, `safe pack must validate, got: ${JSON.stringify(good.issues)}`);
});

test("parser output covers the hand-authored Tiderunner instance on key fields", async () => {
  const hand = await loadAcceptance();
  const parsed = parseMockToAcceptance(await loadMock(), await loadFeelDoc(), {
    game: "tiderunner",
  });

  // Fonts
  assert.equal(parsed.fonts.global?.family, hand.fonts.global?.family);

  // Palette: every hand-authored hex must appear in the parsed palette.
  const parsedHexes = new Set(parsed.palette.entries.map((e) => e.hex));
  for (const e of hand.palette.entries) {
    assert.ok(parsedHexes.has(e.hex), `parser missing palette hex ${e.hex}`);
  }

  // HUD anchors per id.
  const handHud = Object.fromEntries(hand.hud.elements.map((e) => [e.id, e]));
  const parsedHud = Object.fromEntries(parsed.hud.elements.map((e) => [e.id, e]));
  for (const id of Object.keys(handHud)) {
    assert.equal(parsedHud[id]?.anchor, handHud[id].anchor, `HUD ${id} anchor mismatch`);
    assert.equal(parsedHud[id]?.colorRole, handHud[id].colorRole, `HUD ${id} colorRole mismatch`);
  }

  // Juice numerics.
  assert.equal(parsed.juice.dashTrail?.ghosts, hand.juice.dashTrail?.ghosts);
  assert.deepEqual(parsed.juice.dashTrail?.opacities, hand.juice.dashTrail?.opacities);
  assert.equal(parsed.juice.landingDust?.particles, hand.juice.landingDust?.particles);
  assert.equal(parsed.juice.hitStop?.ms, hand.juice.hitStop?.ms);
  assert.equal(parsed.juice.screenShake?.amplitudePx, hand.juice.screenShake?.amplitudePx);
  assert.equal(parsed.juice.screenShake?.trigger, hand.juice.screenShake?.trigger);

  // Framing.
  assert.deepEqual(parsed.framing.aspect, hand.framing.aspect);
  assert.equal(
    parsed.framing.playerAnchor.centerXFraction,
    hand.framing.playerAnchor.centerXFraction,
  );

  // Feel targets. After the Phase F arithmetic-slip fix both the doc-driven
  // parser and the hand-authored contract agree on the corrected 2.8125u dash.
  assert.equal(parsed.feel.jumpApex?.target, hand.feel.jumpApex?.target);
  assert.equal(parsed.feel.dashDistance?.target, hand.feel.dashDistance?.target);
  assert.equal(parsed.feel.dashDistance?.target, 2.8125);
  assert.equal(parsed.feel.runSpeed?.target, hand.feel.runSpeed?.target);

  // Win rule INTENTIONALLY diverges after the Phase F reconcile: the mock-derived
  // parser keeps the mock's reach-flag goal, but the accepted contract adopts the
  // build's all-fruit rule. The mismatch is recorded, not silently equated.
  assert.equal(parsed.win.rule, "reach-flag");
  assert.equal(hand.win.rule, "all-fruit");
  assert.notEqual(parsed.win.rule, hand.win.rule);
});
