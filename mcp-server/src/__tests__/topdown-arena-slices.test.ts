/**
 * The seed `3d-topdown-arena` slice grammar loads clean and holds its provenance
 * discipline. Mirrors `telemetry-schema.test.ts` (a pack artifact self-validates)
 * and `loombridge-slices.test.ts` (the shipped template is schema-valid). The pack
 * is a GATED CANDIDATE — it is deliberately NOT registered in `genre-registry`, so
 * this pack-level test is how its `slices.json` is consumed + guarded, the same way
 * `telemetry-schema.test.ts` guards its `telemetry.json`.
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { assertValidSlicePlan, SLICES_SCHEMA_VERSION } from "../capabilities/verification/slices.js";

const SLICES_PATH = path.join(
  process.cwd(),
  "src",
  "capabilities",
  "genre",
  "genre-packs",
  "3d-topdown-arena",
  "slices.json",
);

async function loadTopdownSlices(): Promise<unknown> {
  return JSON.parse(await fs.readFile(SLICES_PATH, "utf8"));
}

/** The closed verification taxonomy every slice must declare (see methodology-gaps.md). */
const VERIFICATION_VALUES = new Set(["gate", "calculator", "telemetry", "dual-validated", "gap"]);

test("3d-topdown-arena slices.json is a schema-valid slice plan", async () => {
  const raw = await loadTopdownSlices();
  // assertValidSlicePlan enforces the shape, DAG resolution, acyclicity, safe ids,
  // AND that every acceptance.gate is a real (supported) gate id.
  const plan = assertValidSlicePlan(raw);
  assert.equal(plan.schemaVersion, SLICES_SCHEMA_VERSION);
  assert.equal(plan.genre, "3d-topdown-arena");
  assert.ok(plan.slices.length >= 10, "the extraction loop decomposes into >= 10 slices");
});

test("3d-topdown-arena — every dep resolves and every slice carries console-clean", async () => {
  const plan = assertValidSlicePlan(await loadTopdownSlices());
  const ids = new Set(plan.slices.map((s) => s.id));
  for (const s of plan.slices) {
    for (const dep of s.dependsOn) assert.ok(ids.has(dep), `${s.id} -> unknown dep ${dep}`);
    assert.ok(s.acceptance.gates.includes("console-clean"), `${s.id} lacks console-clean gate`);
  }
});

test("3d-topdown-arena — EVERY slice declares a verification binding in the closed taxonomy", async () => {
  // The core provenance-discipline invariant: no slice is silently unverifiable.
  const plan = assertValidSlicePlan(await loadTopdownSlices());
  for (const s of plan.slices) {
    const criteria = s.acceptance.criteria as { verification?: unknown } | undefined;
    assert.ok(criteria, `${s.id} has no acceptance.criteria`);
    assert.ok(
      typeof criteria!.verification === "string" && VERIFICATION_VALUES.has(criteria!.verification),
      `${s.id} verification '${String(criteria?.verification)}' is not in the closed taxonomy`,
    );
    // A non-gap binding must name what verifies it; a gap is the ONLY binding allowed to omit verifiedBy.
    if (criteria!.verification !== "gap") {
      const verifiedBy = (criteria as { verifiedBy?: unknown }).verifiedBy;
      assert.ok(
        Array.isArray(verifiedBy) && verifiedBy.length > 0,
        `${s.id} (verification=${criteria!.verification}) must name verifiedBy evidence`,
      );
    }
  }
});

test("3d-topdown-arena — the extraction beats bind to the GROUND-TRUTHED telemetry event types", async () => {
  // loot-loop / extraction-hold / pressure-ramp must reference the REAL (T3-T) event names,
  // never the pre-real modeled names (loot_pickup / *_position_sample).
  const plan = assertValidSlicePlan(await loadTopdownSlices());
  const byId = new Map(plan.slices.map((s) => [s.id, s]));
  const evidenceText = (id: string): string => {
    const c = byId.get(id)!.acceptance.criteria as { verifiedBy?: string[] };
    return (c.verifiedBy ?? []).join(" \n ");
  };
  for (const id of ["loot-loop", "extraction-hold", "pressure-ramp"]) {
    assert.equal(
      (byId.get(id)!.acceptance.criteria as { verification: string }).verification,
      "telemetry",
      `${id} must be telemetry-bound`,
    );
  }
  assert.match(evidenceText("loot-loop"), /loot_start|loot_complete/);
  assert.match(evidenceText("extraction-hold"), /extract_hold_start|extract_complete/);
  assert.match(evidenceText("pressure-ramp"), /pressure_start/);
  // The stale pre-real modeled names must not appear anywhere in the extraction bindings.
  const allExtraction = ["loot-loop", "extraction-hold", "pressure-ramp"].map(evidenceText).join(" ");
  for (const gone of ["loot_pickup", "player_position_sample", "enemy_position_sample"]) {
    assert.ok(!allExtraction.includes(gone), `stale modeled telemetry name ${gone} leaked into a slice`);
  }
});

test("3d-topdown-arena — the minimap slice encodes the dual-validated informs-not-reveals contract", async () => {
  const plan = assertValidSlicePlan(await loadTopdownSlices());
  const minimap = plan.slices.find((s) => s.id === "minimap");
  assert.ok(minimap, "minimap slice exists");
  const c = minimap!.acceptance.criteria as {
    verification?: string;
    minimapContract?: { informsNotReveals?: boolean; requires?: string[]; forbids?: string[]; coverageAnecdote?: string };
  };
  assert.equal(c.verification, "dual-validated", "minimap is the dual-validated contract");
  const mc = c.minimapContract;
  assert.ok(mc, "minimapContract present");
  assert.equal(mc!.informsNotReveals, true);
  // The contract FORBIDS loot markers + exact enemy radar (the reveal), REQUIRES authored danger zones.
  const forbids = (mc!.forbids ?? []).join(" ").toLowerCase();
  assert.match(forbids, /loot marker/);
  assert.match(forbids, /radar|precise enemy|exact-position/);
  assert.match((mc!.requires ?? []).join(" ").toLowerCase(), /danger zone/);
  // The coverage % stays an ANECDOTE, explicitly not a band.
  assert.match(String(mc!.coverageAnecdote ?? ""), /anecdote/i);
});

test("3d-topdown-arena — gated single-source grammar rules are NOT bound as slice contract material", async () => {
  // ALL SIX single-source rules (pressure-tied-to-greed-not-clock, first/second/third-crate
  // progression, high-loot-behind-route-cost, geographic-danger-over-global-buffs,
  // opener-only-nearest-spawn, avoid-bespoke-single-scenario-systems) live ONLY in
  // methodology-gaps.md as gated candidates. They must never be smuggled into slices.json as
  // BINDING material, so this walks the FULL criteria tree of every slice: every key at every
  // depth AND every string value — including verifiedBy arrays and nested objects like
  // minimapContract (e.g. a smuggled `minimapContract.routeCostBand` key fails here).
  // The ONLY exemption is `note` VALUES: the honest prose deliberately names the gated
  // candidates in order to say they are NOT bound (note KEYS are still pattern-checked).
  const GATED_RULE_RE =
    /greed|first-?crate|second-?not-?free|third-?crate|high-?loot|route-?cost|geographic|sightline|danger[- ]?pocket|global[- ]?buff|opener-?only|nearest-?spawn|bespoke|single-?scenario/i;
  const rawText = await fs.readFile(SLICES_PATH, "utf8");
  const parsed = JSON.parse(rawText) as {
    slices: Array<{ id: string; acceptance: { criteria?: Record<string, unknown> } }>;
  };

  function walk(node: unknown, sliceId: string, where: string): void {
    if (typeof node === "string") {
      assert.ok(
        !GATED_RULE_RE.test(node),
        `gated single-source rule leaked into binding material at ${sliceId}:${where} — "${node}"`,
      );
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((v, i) => walk(v, sliceId, `${where}[${i}]`));
      return;
    }
    if (node && typeof node === "object") {
      for (const [key, value] of Object.entries(node)) {
        assert.ok(
          !GATED_RULE_RE.test(key),
          `gated single-source rule leaked as a criteria key '${key}' at ${sliceId}:${where}`,
        );
        if (key === "note") continue; // exempt honest prose VALUES only
        walk(value, sliceId, `${where}.${key}`);
      }
    }
  }

  for (const s of parsed.slices) {
    walk(s.acceptance.criteria ?? {}, s.id, "criteria");
  }
});

// ── binding reality: every named calculator + telemetry name must actually exist ─

/** Every verifiedBy string across all slices, tagged with its slice id. */
async function allVerifiedBy(): Promise<Array<{ sliceId: string; text: string }>> {
  const plan = assertValidSlicePlan(await loadTopdownSlices());
  const out: Array<{ sliceId: string; text: string }> = [];
  for (const s of plan.slices) {
    const c = s.acceptance.criteria as { verifiedBy?: unknown } | undefined;
    const vb = c?.verifiedBy;
    if (Array.isArray(vb)) {
      for (const v of vb) if (typeof v === "string") out.push({ sliceId: s.id, text: v });
    }
  }
  return out;
}

test("3d-topdown-arena — every derive* calculator named in a binding is a real feel-derive export", async () => {
  // Binding-reality guard: a typo'd deriveNonexistentThing in slices.json must fail CI.
  // Scan the WHOLE slices.json (bindings AND notes — a note claiming a calculator that does
  // not exist is also a false claim) and check membership against the imported module.
  const feelDerive = (await import("../capabilities/verification/feel-derive.js")) as Record<string, unknown>;
  const rawText = await fs.readFile(SLICES_PATH, "utf8");
  const tokens = new Set(rawText.match(/\bderive[A-Z]\w*/g) ?? []);
  assert.ok(tokens.size >= 15, `expected the pack to name many calculators, found ${tokens.size}`);
  for (const token of tokens) {
    assert.equal(
      typeof feelDerive[token],
      "function",
      `slices.json names '${token}' but feel-derive.ts exports no such function`,
    );
  }
});

test("3d-topdown-arena — every telemetry name in a binding exists in the shipped telemetry.json seed", async () => {
  const { telemetrySchemaPathForGenre } = await import("../capabilities/telemetry/schema.js");
  const telemetryPath = telemetrySchemaPathForGenre("3d-topdown-arena");
  assert.ok(telemetryPath, "telemetry.json resolves for the pack");
  const telemetry = JSON.parse(await fs.readFile(telemetryPath!, "utf8")) as {
    runSummary: { fields: Array<{ name: string }> };
    eventStream: { events: Array<{ type: string; payload: Array<{ name: string }> }> };
  };
  const eventTypes = new Set(telemetry.eventStream.events.map((e) => e.type));
  const summaryFields = new Set(telemetry.runSummary.fields.map((f) => f.name));
  const payloadByEvent = new Map(
    telemetry.eventStream.events.map((e) => [e.type, new Set(e.payload.map((p) => p.name))]),
  );
  const allPayloadFields = new Set(
    telemetry.eventStream.events.flatMap((e) => e.payload.map((p) => p.name)),
  );

  const bindings = await allVerifiedBy();

  for (const { sliceId, text } of bindings) {
    // (a) every snake_case token is a REAL event type (loot_start, extract_hold_*, player_pos, …).
    for (const m of text.match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g) ?? []) {
      assert.ok(eventTypes.has(m), `${sliceId}: '${m}' is not an event type in telemetry.json`);
    }
    // (b) every dotted event.field/field ref names real payload fields
    //     (player_pos.stash, player_pos.holdKind/holdProgress, damage.duringHold, …).
    //     Field-validate whenever the LEFT side is a known event type; a snake_case left
    //     side is already forced to be a real event by check (a), and a plain-word left
    //     side (acceptance.json, hud.elements) is prose, not a telemetry ref.
    for (const m of text.matchAll(/\b([a-z][a-z0-9_]*)\.([A-Za-z]\w*(?:\/[A-Za-z]\w*)*)/g)) {
      const [, ev, fieldsPart] = m;
      if (!eventTypes.has(ev!)) continue;
      for (const field of fieldsPart!.split("/")) {
        assert.ok(
          payloadByEvent.get(ev!)!.has(field),
          `${sliceId}: event '${ev}' has no payload field '${field}'`,
        );
      }
    }
    // (c) every event{field} ref (e.g. death{lost}) names a real event + payload field.
    for (const m of text.matchAll(/\b([a-z][a-z0-9_]*)\{(\w+)\}/g)) {
      const [, ev, field] = m;
      assert.ok(eventTypes.has(ev!), `${sliceId}: '${ev}' (in '${m[0]}') is not an event type`);
      assert.ok(
        payloadByEvent.get(ev!)!.has(field!),
        `${sliceId}: event '${ev}' has no payload field '${field}'`,
      );
    }
    // (d) every identifier on a runSummary:/telemetry: line (parentheticals + {field} refs
    //     stripped) must exist SOMEWHERE in the seed: a summary field, an event type, or a
    //     payload field (with a tiny stop-word list for connective prose).
    const STOP_WORDS = new Set(["runSummary", "telemetry", "event", "events"]);
    if (/^\s*(?:runSummary|telemetry):/.test(text)) {
      const stripped = text.replace(/\([^)]*\)/g, "").replace(/\{\w+\}/g, "");
      for (const token of stripped.match(/[A-Za-z]\w*/g) ?? []) {
        if (STOP_WORDS.has(token)) continue;
        assert.ok(
          summaryFields.has(token) || eventTypes.has(token) || allPayloadFields.has(token),
          `${sliceId}: '${token}' is not a summary field, event type, or payload field in telemetry.json`,
        );
      }
    }
  }
});
