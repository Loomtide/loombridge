/**
 * SFX gate evaluators (sfx-presence / sfx-runtime / inputToSfxLatency / sfx-fatigue) on
 * synthetic captures (pass / fail / missing-capture-blocked), the no-immediate-repeat
 * detection math, and the opt-in run-gates wiring (a contract without the SFX section is
 * byte-for-byte unchanged).
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  evaluateSfxPresence as presence,
  evaluateSfxRuntime as runtime,
  evaluateInputToSfxLatency as latency,
  evaluateSfxFatigue as fatigue,
  findImmediateRepeats as repeats,
} from "../verification/gates/index.js";
import { validateCueMapSchema, type CueMapSchema } from "../loomtide/sfx/cue-map.js";
import { runGates, SFX_GATE_NAMES } from "../verification/run-gates.js";
import type { AcceptanceContract } from "../verification/types.js";
import type { GateReport } from "../verification/gates/types.js";

/** A small valid cue map: `fire` (required, frequent, no-repeat) + `loot` (required, occasional). */
function cueMap(): CueMapSchema {
  const raw = {
    schemaVersion: "1",
    id: "test.cue-map",
    cues: [
      {
        id: "fire",
        event: "weapon.fire",
        required: true,
        frequency: "frequent",
        priority: "gameplay",
        mixerBus: "SFX",
        layerRoles: ["transient", "body"],
        spatial: { mode: "2d" },
        variantPolicy: { count: 3, noImmediateRepeat: true },
      },
      {
        id: "loot",
        event: "loot.open",
        required: true,
        frequency: "occasional",
        priority: "gameplay",
        mixerBus: "SFX",
        layerRoles: ["reward"],
        spatial: { mode: "2d" },
      },
      {
        id: "ambience",
        event: "zone.enter",
        required: false,
        frequency: "loop",
        priority: "cosmetic",
        mixerBus: "Ambience",
        layerRoles: ["context"],
        spatial: { mode: "2d" },
      },
    ],
  };
  const r = validateCueMapSchema(raw);
  assert.ok(r.ok && r.schema, `fixture cue map must validate: ${JSON.stringify(r.refusals)}`);
  return r.schema!;
}

function verdict(report: GateReport): string {
  return report.verdict;
}

// ── sfx-presence ─────────────────────────────────────────────────────────────

test("sfx-presence PASSES when every required cue is bound", () => {
  const r = presence(
    {
      bindings: [
        { cueId: "fire", bound: true, clipPath: "Assets/Audio/fire.wav" },
        { cueId: "loot", bound: true, clipPath: "Assets/Audio/loot.wav" },
      ],
    },
    cueMap(),
  );
  assert.equal(verdict(r), "pass");
});

test("sfx-presence FAILS (refuses) when a required cue binding is ABSENT", () => {
  const r = presence({ bindings: [{ cueId: "fire", bound: true, clipPath: "a.wav" }] }, cueMap());
  assert.equal(verdict(r), "fail");
  const loot = r.checks.find((c) => c.id === "sfx-presence.loot");
  assert.equal(loot!.status, "fail");
  assert.match(loot!.detail, /no binding entry/);
});

test("sfx-presence FAILS when a required cue is bound=false / empty clip", () => {
  const r = presence(
    {
      bindings: [
        { cueId: "fire", bound: false, clipPath: null },
        { cueId: "loot", bound: true, clipPath: "" },
      ],
    },
    cueMap(),
  );
  assert.equal(verdict(r), "fail");
});

test("sfx-presence: a malformed capture (no bindings array) is a graceful FAIL, not a throw (D3)", () => {
  const noArray = presence({ bindings: "nope" } as never, cueMap());
  assert.equal(verdict(noArray), "fail");
  assert.match(noArray.checks[0].detail, /present but malformed/);
  const notObject = presence(42 as never, cueMap());
  assert.equal(verdict(notObject), "fail");
});

test("sfx-presence: a malformed binding ENTRY is its own FAIL check, others still grade (D3)", () => {
  const r = presence(
    {
      bindings: [
        null as never,
        { cueId: "fire", bound: true, clipPath: "a.wav" },
        { cueId: "loot", bound: true, clipPath: "b.wav" },
      ],
    },
    cueMap(),
  );
  assert.equal(verdict(r), "fail");
  assert.equal(r.checks.find((c) => c.id === "sfx-presence.binding.0")!.status, "fail");
  // the well-formed entries still graded
  assert.equal(r.checks.find((c) => c.id === "sfx-presence.fire")!.status, "pass");
  assert.equal(r.checks.find((c) => c.id === "sfx-presence.loot")!.status, "pass");
});

test("sfx-presence: optional cue not bound is not_applicable; unknown binding is a warn", () => {
  const r = presence(
    {
      bindings: [
        { cueId: "fire", bound: true, clipPath: "a.wav" },
        { cueId: "loot", bound: true, clipPath: "b.wav" },
        { cueId: "mystery", bound: true, clipPath: "c.wav" },
      ],
    },
    cueMap(),
  );
  assert.equal(r.checks.find((c) => c.id === "sfx-presence.ambience")!.status, "not_applicable");
  assert.equal(r.checks.find((c) => c.id === "sfx-presence.extra.mystery")!.status, "warn");
  assert.equal(verdict(r), "warn"); // no fails; the drift warn dominates
});

// ── sfx-runtime ──────────────────────────────────────────────────────────────

test("sfx-runtime PASSES when every required non-exempt cue fired", () => {
  const r = runtime({ playCount: 5, perCue: { fire: 3, loot: 2 }, lastCueId: "loot", lastCueTimeMs: 10 }, cueMap());
  assert.equal(verdict(r), "pass");
});

test("sfx-runtime FAILS when a required cue did not fire (silence is not success)", () => {
  const r = runtime({ playCount: 3, perCue: { fire: 3 }, lastCueId: "fire", lastCueTimeMs: 10 }, cueMap());
  assert.equal(verdict(r), "fail");
  assert.equal(r.checks.find((c) => c.id === "sfx-runtime.loot")!.status, "fail");
});

test("sfx-runtime: a scenario-exempt required cue is not_applicable WITH a note (not silently skipped)", () => {
  const r = runtime({ playCount: 3, perCue: { fire: 3 }, lastCueId: "fire", lastCueTimeMs: 10 }, cueMap(), ["loot"]);
  const loot = r.checks.find((c) => c.id === "sfx-runtime.loot")!;
  assert.equal(loot.status, "not_applicable");
  assert.match(loot.detail, /scenario-exempt/);
  assert.equal(verdict(r), "pass");
});

test("sfx-runtime FAILS on an internally inconsistent (stale) snapshot", () => {
  const r = runtime({ playCount: 9, perCue: { fire: 3, loot: 2 }, lastCueId: "loot", lastCueTimeMs: 10 }, cueMap());
  assert.equal(verdict(r), "fail");
  assert.match(r.checks[0].detail, /inconsistent/);
});

test("sfx-runtime: an exemption naming an unknown cue is a drift warn", () => {
  const r = runtime(
    { playCount: 5, perCue: { fire: 3, loot: 2 }, lastCueId: "loot", lastCueTimeMs: 10 },
    cueMap(),
    ["nope"],
  );
  assert.ok(r.checks.some((c) => c.id === "sfx-runtime.exempt.nope" && c.status === "warn"));
});

// ── inputToSfxLatency ────────────────────────────────────────────────────────

const band = { target: 50, unit: "ms", band: { abs: 20 } }; // [30, 70]

/** ≥3 valid pairs (D4 minimum), all within band, median 50ms. */
const goodPairs = [
  { inputTimeMs: 100, cueTimeMs: 150 },
  { inputTimeMs: 200, cueTimeMs: 245 },
  { inputTimeMs: 300, cueTimeMs: 355 },
];

test("inputToSfxLatency PASSES within band (≥3 pairs)", () => {
  const r = latency({ cueId: "fire", pairs: goodPairs }, cueMap(), band);
  assert.equal(verdict(r), "pass");
});

test("inputToSfxLatency FAILS out of band", () => {
  const r = latency(
    {
      cueId: "fire",
      pairs: [
        { inputTimeMs: 0, cueTimeMs: 120 },
        { inputTimeMs: 200, cueTimeMs: 325 },
        { inputTimeMs: 400, cueTimeMs: 518 },
      ],
    },
    cueMap(),
    band,
  );
  assert.equal(verdict(r), "fail");
  assert.match(r.checks.find((c) => c.id === "inputToSfxLatency.value")!.detail, /OUT of band/);
});

test("inputToSfxLatency is BLOCKED (warn) on empty pairs — never a pass", () => {
  const r = latency({ cueId: "fire", pairs: [] }, cueMap(), band);
  assert.equal(verdict(r), "warn");
  assert.match(r.checks[0].detail, /BLOCKED\/incomplete/);
});

test("inputToSfxLatency: fewer than 3 valid pairs = WARN insufficient (D4), never a graded pass", () => {
  const r = latency(
    { cueId: "fire", pairs: [{ inputTimeMs: 100, cueTimeMs: 150 }, { inputTimeMs: 200, cueTimeMs: 245 }] },
    cueMap(),
    band,
  );
  assert.equal(verdict(r), "warn");
  const check = r.checks.find((c) => c.id === "inputToSfxLatency.pairs")!;
  assert.match(check.detail, /insufficient pairs, latency unverified/);
  // and no graded value check was emitted
  assert.equal(r.checks.some((c) => c.id === "inputToSfxLatency.value"), false);
});

test("inputToSfxLatency is a warn (incomplete) when no band is declared", () => {
  const r = latency({ cueId: "fire", pairs: goodPairs }, cueMap());
  assert.equal(verdict(r), "warn");
  assert.match(r.checks.find((c) => c.id === "inputToSfxLatency.value")!.detail, /no band/);
});

test("inputToSfxLatency REFUSES an impossible pairing (cue before input)", () => {
  const r = latency({ cueId: "fire", pairs: [{ inputTimeMs: 100, cueTimeMs: 90 }] }, cueMap(), band);
  assert.equal(verdict(r), "fail");
  assert.match(r.checks[0].detail, /impossible pairing/);
});

test("inputToSfxLatency REFUSES a pair with a missing bound field", () => {
  const r = latency(
    { cueId: "fire", pairs: [{ inputTimeMs: 100, cueTimeMs: NaN as unknown as number }] },
    cueMap(),
    band,
  );
  assert.equal(verdict(r), "fail");
  assert.match(r.checks[0].detail, /missing a bound timestamp/);
});

test("inputToSfxLatency REFUSES an implausibly low pair (<8ms, incl. exactly 0 — D4 clock-pairing floor)", () => {
  const zero = latency({ cueId: "fire", pairs: [{ inputTimeMs: 100, cueTimeMs: 100 }] }, cueMap(), band);
  assert.equal(verdict(zero), "fail");
  assert.match(zero.checks[0].detail, /implausibly low — clock pairing suspect/);
  const subFrame = latency({ cueId: "fire", pairs: [{ inputTimeMs: 100, cueTimeMs: 105 }] }, cueMap(), band);
  assert.equal(verdict(subFrame), "fail");
  assert.match(subFrame.checks[0].detail, /implausibly low/);
  // 8ms exactly is at the floor and allowed through (graded, or warn on pair count)
  const atFloor = latency({ cueId: "fire", pairs: [{ inputTimeMs: 100, cueTimeMs: 108 }] }, cueMap(), band);
  assert.equal(atFloor.checks.some((c) => /implausibly low/.test(c.detail)), false);
});

test("inputToSfxLatency FAILS when pairs outnumber the probe's recorded fires (D4 anti-fabrication)", () => {
  const probe = { playCount: 2, perCue: { fire: 2 }, lastCueId: "fire", lastCueTimeMs: 10 };
  const r = latency({ cueId: "fire", pairs: goodPairs }, cueMap(), band, probe);
  assert.equal(verdict(r), "fail");
  assert.match(
    r.checks.find((c) => c.id === "inputToSfxLatency.fabrication")!.detail,
    /more pairings than fires is a fabricated capture/,
  );
});

test("inputToSfxLatency passes the probe cross-check when pairs ≤ fires", () => {
  const probe = { playCount: 3, perCue: { fire: 3 }, lastCueId: "fire", lastCueTimeMs: 10 };
  const r = latency({ cueId: "fire", pairs: goodPairs }, cueMap(), band, probe);
  assert.equal(verdict(r), "pass");
});

test("inputToSfxLatency: a malformed (non-object) capture is a graceful FAIL, not a throw (D3)", () => {
  const r = latency("garbage" as never, cueMap(), band);
  assert.equal(verdict(r), "fail");
  assert.match(r.checks[0].detail, /present but malformed/);
});

// ── sfx-fatigue + no-immediate-repeat math ──────────────────────────────────

test("findImmediateRepeats detects consecutive same variants per cue", () => {
  assert.deepEqual(repeats([{ cueId: "fire", variant: 0 }, { cueId: "fire", variant: 0 }]).repeats.length, 1);
  assert.deepEqual(repeats([{ cueId: "fire", variant: 0 }, { cueId: "fire", variant: 1 }]).repeats.length, 0);
  // interleaving another cue does NOT reset the per-cue chain (0 then 0 for fire = repeat)
  const mixed = repeats([{ cueId: "fire", variant: 0 }, { cueId: "fire", variant: 0 }]);
  assert.equal(mixed.repeats[0].occurrenceIndex, 1);
});

test("findImmediateRepeats flags a missing variant tag", () => {
  const out = repeats([{ cueId: "fire", variant: 0 }, { cueId: "fire" }]);
  assert.equal(out.missingVariant, true);
});

test("sfx-fatigue PASSES when no-repeat cues never immediately repeat", () => {
  const r = fatigue(
    { events: [{ cueId: "fire", variant: 0 }, { cueId: "loot" }, { cueId: "fire", variant: 1 }, { cueId: "fire", variant: 0 }] },
    cueMap(),
  );
  assert.equal(verdict(r), "pass");
});

test("sfx-fatigue FAILS on an immediate repeat", () => {
  const r = fatigue({ events: [{ cueId: "fire", variant: 2 }, { cueId: "fire", variant: 2 }] }, cueMap());
  assert.equal(verdict(r), "fail");
  assert.match(r.checks[0].detail, /same variant twice in a row/);
});

test("sfx-fatigue FAILS when a no-repeat cue fires without a variant tag (unverifiable)", () => {
  const r = fatigue({ events: [{ cueId: "fire" }, { cueId: "fire" }] }, cueMap());
  assert.equal(verdict(r), "fail");
  assert.match(r.checks[0].detail, /cannot verify no-immediate-repeat/);
});

// D2 hollow ≥ missing: unexercised / empty captures can never silently skip.

test("sfx-fatigue: an unexercised no-repeat cue WITHOUT probe corroboration is a WARN (not a silent skip)", () => {
  const r = fatigue({ events: [{ cueId: "loot" }] }, cueMap());
  const fire = r.checks.find((c) => c.id === "sfx-fatigue.fire")!;
  assert.equal(fire.status, "warn");
  assert.match(fire.detail, /no probe snapshot corroborates/);
});

test("sfx-fatigue: an unexercised no-repeat cue WITH the probe corroborating 0 fires is not_applicable", () => {
  const probe = { playCount: 1, perCue: { loot: 1 }, lastCueId: "loot", lastCueTimeMs: 5 };
  const r = fatigue({ events: [{ cueId: "loot" }] }, cueMap(), probe);
  const fire = r.checks.find((c) => c.id === "sfx-fatigue.fire")!;
  assert.equal(fire.status, "not_applicable");
  assert.match(fire.detail, /probe snapshot counted 0 fires/);
});

test("sfx-fatigue FAILS a hollow sequence: cue absent from sequence but the probe shows it FIRED (D2)", () => {
  const probe = { playCount: 3, perCue: { fire: 3 }, lastCueId: "fire", lastCueTimeMs: 5 };
  const r = fatigue({ events: [{ cueId: "loot" }] }, cueMap(), probe);
  const fire = r.checks.find((c) => c.id === "sfx-fatigue.fire")!;
  assert.equal(fire.status, "fail");
  assert.match(fire.detail, /hollow\/stale sequence capture/);
});

test("sfx-fatigue: an EMPTY events array on a present capture is a WARN, never not_applicable (D2)", () => {
  const r = fatigue({ events: [] }, cueMap());
  assert.equal(verdict(r), "warn");
  const seq = r.checks.find((c) => c.id === "sfx-fatigue.sequence")!;
  assert.match(seq.detail, /present but empty — fatigue unverified/);
});

test("sfx-fatigue: an EMPTY events array + probe showing fires = FAIL (hollow capture beats missing)", () => {
  const probe = { playCount: 2, perCue: { fire: 2 }, lastCueId: "fire", lastCueTimeMs: 5 };
  const r = fatigue({ events: [] }, cueMap(), probe);
  assert.equal(verdict(r), "fail");
  assert.match(r.checks.find((c) => c.id === "sfx-fatigue.fire")!.detail, /hollow\/stale/);
});

test("sfx-fatigue REFUSES a non-monotonic tMs sequence (D6 order integrity)", () => {
  const r = fatigue(
    { events: [{ cueId: "fire", variant: 0, tMs: 100 }, { cueId: "fire", variant: 1, tMs: 50 }] },
    cueMap(),
  );
  assert.equal(verdict(r), "fail");
  assert.match(r.checks.find((c) => c.id === "sfx-fatigue.order")!.detail, /not time-sorted/);
});

test("sfx-fatigue: a malformed (no events array) capture is a graceful FAIL, not a throw (D3)", () => {
  const r = fatigue({} as never, cueMap());
  assert.equal(verdict(r), "fail");
  assert.match(r.checks[0].detail, /present but malformed/);
});

test("sfx-fatigue is not_applicable when the cue map declares no no-repeat cues", () => {
  const raw = validateCueMapSchema({
    schemaVersion: "1",
    id: "x",
    cues: [{ id: "win", event: "e", required: true, frequency: "rare", priority: "gameplay", mixerBus: "SFX", layerRoles: ["reward"], spatial: { mode: "2d" } }],
  });
  const r = fatigue({ events: [] }, raw.schema!);
  assert.equal(verdict(r), "not_applicable");
});

// ── opt-in run-gates wiring ─────────────────────────────────────────────────

function baseAcceptance(sfx?: unknown): AcceptanceContract {
  return {
    schemaVersion: "1",
    game: "sfx-fixture",
    fonts: {},
    palette: { entries: [] },
    hud: { elements: [] },
    framing: { aspect: { w: 16, h: 9 }, playerAnchor: { centerXFraction: 0.5, tolerance: 0.1 } },
    feel: {},
    juice: {},
    manifest: { matching: "exact", elements: [] },
    win: { rule: "reach-flag" },
    ...(sfx ? { verification: { sfx } } : {}),
  } as unknown as AcceptanceContract;
}

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "sfx-gates-"));
}

test("a contract WITHOUT the sfx section runs ZERO sfx gates (zero behavior change)", async () => {
  const dir = await tmpDir();
  try {
    const report = await runGates({ acceptance: baseAcceptance(), inputsDir: dir });
    for (const g of SFX_GATE_NAMES) {
      assert.equal(report.gates[g], undefined, `sfx gate ${g} must be absent`);
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("sfx enabled but NO cue map staged ⇒ every sfx gate is BLOCKED (warn), never passed", async () => {
  const dir = await tmpDir();
  try {
    const report = await runGates({ acceptance: baseAcceptance({ enabled: true }), inputsDir: dir });
    for (const g of SFX_GATE_NAMES) {
      assert.equal(report.gates[g], "warn", `sfx gate ${g} blocked as warn`);
      assert.ok(report.checks.some((c) => c.id === `${g}.cue-map` && /BLOCKED/.test(c.detail)));
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("sfx enabled with an INVALID cue map ⇒ sfx gates FAIL (malformed pack artifact)", async () => {
  const dir = await tmpDir();
  try {
    await fs.writeFile(path.join(dir, "sfx-cue-map.json"), JSON.stringify({ schemaVersion: "1" }), "utf8");
    const report = await runGates({ acceptance: baseAcceptance({ enabled: true }), inputsDir: dir });
    for (const g of SFX_GATE_NAMES) assert.equal(report.gates[g], "fail");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("sfx enabled with a valid cue map + captures ⇒ gates GRADE the captures", async () => {
  const dir = await tmpDir();
  try {
    const cm = {
      schemaVersion: "1",
      id: "x",
      cues: [
        { id: "fire", event: "weapon.fire", required: true, frequency: "frequent", priority: "gameplay", mixerBus: "SFX", layerRoles: ["transient", "body"], spatial: { mode: "2d" }, variantPolicy: { count: 3, noImmediateRepeat: true } },
        { id: "loot", event: "loot.open", required: true, frequency: "occasional", priority: "gameplay", mixerBus: "SFX", layerRoles: ["reward"], spatial: { mode: "2d" } },
      ],
    };
    await fs.writeFile(path.join(dir, "sfx-cue-map.json"), JSON.stringify(cm), "utf8");
    await fs.writeFile(
      path.join(dir, "sfx-bindings.json"),
      JSON.stringify({ bindings: [{ cueId: "fire", bound: true, clipPath: "a.wav" }, { cueId: "loot", bound: true, clipPath: "b.wav" }] }),
      "utf8",
    );
    await fs.writeFile(
      path.join(dir, "sfx-probe.json"),
      JSON.stringify({ playCount: 4, perCue: { fire: 3, loot: 1 }, lastCueId: "loot", lastCueTimeMs: 12 }),
      "utf8",
    );
    await fs.writeFile(
      path.join(dir, "sfx-latency.json"),
      JSON.stringify({
        cueId: "fire",
        pairs: [
          { inputTimeMs: 0, cueTimeMs: 45 },
          { inputTimeMs: 100, cueTimeMs: 150 },
          { inputTimeMs: 200, cueTimeMs: 255 },
        ],
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(dir, "sfx-sequence.json"),
      JSON.stringify({ events: [{ cueId: "fire", variant: 0 }, { cueId: "fire", variant: 1 }] }),
      "utf8",
    );

    const acc = baseAcceptance({ enabled: true, inputToSfxLatencyMs: { target: 50, unit: "ms", band: { abs: 20 } } });
    const report = await runGates({ acceptance: acc, inputsDir: dir });
    assert.equal(report.gates["sfx-presence"], "pass");
    assert.equal(report.gates["sfx-runtime"], "pass");
    assert.equal(report.gates["inputToSfxLatency"], "pass");
    assert.equal(report.gates["sfx-fatigue"], "pass");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("sfx enabled, cue map staged, but a capture MISSING ⇒ that gate is BLOCKED (warn), never a pass", async () => {
  const dir = await tmpDir();
  try {
    const cm = {
      schemaVersion: "1",
      id: "x",
      cues: [{ id: "loot", event: "loot.open", required: true, frequency: "occasional", priority: "gameplay", mixerBus: "SFX", layerRoles: ["reward"], spatial: { mode: "2d" } }],
    };
    await fs.writeFile(path.join(dir, "sfx-cue-map.json"), JSON.stringify(cm), "utf8");
    // stage NO capture files
    const report = await runGates({ acceptance: baseAcceptance({ enabled: true }), inputsDir: dir });
    assert.equal(report.gates["sfx-presence"], "warn");
    assert.ok(report.checks.some((c) => c.id === "sfx-presence.input" && /BLOCKED\/incomplete/.test(c.detail)));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("D3 isolation: a malformed capture never aborts the run — that gate FAILS, the others still grade", async () => {
  const dir = await tmpDir();
  try {
    const cm = {
      schemaVersion: "1",
      id: "x",
      cues: [{ id: "loot", event: "loot.open", required: true, frequency: "occasional", priority: "gameplay", mixerBus: "SFX", layerRoles: ["reward"], spatial: { mode: "2d" } }],
    };
    await fs.writeFile(path.join(dir, "sfx-cue-map.json"), JSON.stringify(cm), "utf8");
    // MALFORMED bindings (wrong shape), UNPARSEABLE probe, valid sequence.
    await fs.writeFile(path.join(dir, "sfx-bindings.json"), JSON.stringify({ bindings: "nope" }), "utf8");
    await fs.writeFile(path.join(dir, "sfx-probe.json"), "{ not json", "utf8");
    await fs.writeFile(path.join(dir, "sfx-sequence.json"), JSON.stringify({ events: [{ cueId: "loot" }] }), "utf8");

    // Must complete WITHOUT throwing (the old behavior aborted the whole verify run).
    const report = await runGates({ acceptance: baseAcceptance({ enabled: true }), inputsDir: dir });
    assert.equal(report.gates["sfx-presence"], "fail"); // malformed shape = graceful FAIL
    assert.equal(report.gates["sfx-runtime"], "fail"); // unparseable capture = FAIL, not a crash
    assert.ok(
      report.checks.some((c) => c.id === "sfx-runtime.input" && /could not be parsed/.test(c.detail)),
    );
    // latency still graded (missing capture → blocked warn), fatigue still graded.
    assert.equal(report.gates["inputToSfxLatency"], "warn");
    assert.equal(typeof report.gates["sfx-fatigue"], "string");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
