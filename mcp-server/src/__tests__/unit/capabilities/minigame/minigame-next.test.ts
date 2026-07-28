/**
 * `minigame next` — the guided-flow resolver. The pipeline state machine is PURE
 * (`resolveNextStep`), so the whole "what do I run next" contract is unit-tested without
 * disk; one integration test exercises `inspectWorkspace` reading a real workspace.
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  formatNextStep,
  inspectWorkspace,
  nextStepLinesFor,
  resolveNextStep,
  type WorkspaceFacts,
} from "../../../../capabilities/minigame/minigame-next.js";

const base: WorkspaceFacts = {
  id: "g",
  scene: "Assets/Scenes/G.unity",
  workspace: "/ws",
  traceRecorded: false,
  capturesPresent: false,
  contractFinalized: false,
  verify: null,
  baselineApproved: false,
  backgroundRecommended: false,
};
const reached = { ...base, traceRecorded: true, capturesPresent: true, contractFinalized: true };

test("resolveNextStep: walks the pipeline record → capture → finalize → verify → baseline → done", () => {
  assert.equal(resolveNextStep(base).at, "record");
  assert.equal(resolveNextStep({ ...base, traceRecorded: true }).at, "capture");
  assert.equal(resolveNextStep({ ...base, traceRecorded: true, capturesPresent: true }).at, "finalize");
  assert.equal(resolveNextStep(reached).at, "verify");
  assert.equal(resolveNextStep({ ...reached, verify: { status: "READY", stale: false } }).at, "baseline");
  assert.equal(resolveNextStep({ ...reached, verify: { status: "READY", stale: false }, baselineApproved: true }).at, "done");
});

test("resolveNextStep: the DISPLAYED verify command stays clean (no --quiet-next — that's only on the wrapper-spawned argv)", () => {
  // The run/check wrapper appends --quiet-next when it SPAWNS verify (stepArgv), but the command a
  // dev sees and may run by hand must NOT carry it — otherwise their manual run loses the footer.
  const verify = resolveNextStep(reached);
  assert.equal(verify.at, "verify");
  assert.doesNotMatch(verify.command, /--quiet-next/);
});

test("resolveNextStep: a discovered background binding folds `--background auto` into finalize (one command)", () => {
  const atFinalize = { ...base, traceRecorded: true, capturesPresent: true };
  // Default (no background recommended): plain finalize, no flag.
  const plain = resolveNextStep(atFinalize);
  assert.equal(plain.at, "finalize");
  assert.doesNotMatch(plain.command, /--background/);
  assert.match(plain.summary, /fills in the real locators/);
  // Background discovered + not yet enabled: the SINGLE finalize command enables the gate too.
  const withBg = resolveNextStep({ ...atFinalize, backgroundRecommended: true });
  assert.equal(withBg.at, "finalize");
  assert.match(withBg.command, /--trace-root \/ws --background auto$/);
  assert.match(withBg.summary, /enables the discovered background coverage \+ seam gates/);
});

test("resolveNextStep: stale background candidates recapture instead of suggesting known-bad finalize", () => {
  const atFinalize = { ...base, traceRecorded: true, capturesPresent: true, backgroundCandidatesStale: true };
  const step = resolveNextStep(atFinalize);
  assert.equal(step.at, "capture");
  assert.match(step.summary, /Re-capture with the current bridge/);
  assert.match(step.command, /^loombridge minigame capture /);
  assert.doesNotMatch(step.command, /--background auto/);
});

test("resolveNextStep: NOT READY / CAN'T VERIFY → fix (re-capture), never silently 'done'", () => {
  assert.equal(resolveNextStep({ ...reached, verify: { status: "NOT READY", stale: false } }).at, "fix");
  assert.equal(resolveNextStep({ ...reached, verify: { status: "CAN'T VERIFY", stale: false } }).at, "fix");
});

test("resolveNextStep: a STALE verify (captures newer than the report) → re-verify", () => {
  assert.equal(resolveNextStep({ ...reached, verify: { status: "READY", stale: true } }).at, "verify");
});

test("resolveNextStep: each non-done step is a runnable command; done is empty", () => {
  const record = resolveNextStep(base);
  assert.match(record.command, /^loombridge trace record .*--root \/ws --auto-state-signal$/);
  assert.equal(resolveNextStep({ ...reached, verify: { status: "READY", stale: false }, baselineApproved: true }).command, "");
});

test("formatNextStep: '👉 Next — <summary>' then the command", () => {
  const lines = formatNextStep(resolveNextStep(base));
  assert.match(lines[0], /^👉 Next — /);
  assert.match(lines[1], /loombridge trace record/);
});

test("resolveNextStep (G1): a declared stateSignal is threaded into the record command; absent → auto-detect + a note", () => {
  // Absent: the record command falls back to live per-scene auto-detection (a hub-to-game
  // recording would otherwise carry no phase gates and capture races activation animations),
  // and the summary says the recorder will auto-detect while still nudging an explicit signal.
  const without = resolveNextStep(base);
  assert.equal(without.at, "record");
  assert.doesNotMatch(without.command, / --state-signal/);
  assert.match(without.command, / --auto-state-signal$/);
  assert.match(without.summary, /AUTO-DETECT/);
  assert.match(without.summary, /stateSignal/);
  assert.match(without.summary, /phase-align/);

  // Present (component set): `--state-signal <locator>:<component>:<property>`, NO auto flag.
  const withSig = resolveNextStep({
    ...base,
    stateSignal: { locator: "/Canvas/GameManager", component: "GameManager", property: "phase" },
  });
  assert.match(withSig.command, /--state-signal \/Canvas\/GameManager:GameManager:phase$/);
  assert.doesNotMatch(withSig.command, /--auto-state-signal/);
  assert.doesNotMatch(withSig.summary, /stateSignal/);

  // The short `a:b:c` shape used by the task spec.
  const abc = resolveNextStep({ ...base, stateSignal: { locator: "a", component: "b", property: "c" } });
  assert.match(abc.command, /--state-signal a:b:c$/);

  // Component absent → `path::property` (empty middle field), still a valid 3-part flag.
  const noComp = resolveNextStep({ ...base, stateSignal: { locator: "/Canvas/GM", property: "phase" } });
  assert.match(noComp.command, /--state-signal \/Canvas\/GM::phase$/);
});

test("nextStepLinesFor (G6): the shared footer used by check/scan matches `minigame next` — exact record command + stateSignal threaded; absent → the note", async () => {
  // With a declared stateSignal: a fresh draft (no trace) resolves to the record step with the flag.
  const withSig = await fs.mkdtemp(path.join(os.tmpdir(), "mg-footer-sig-"));
  try {
    await fs.writeFile(
      path.join(withSig, "g.minigame.json"),
      JSON.stringify({
        id: "g",
        scenes: ["Assets/Scenes/G.unity"],
        requiredInFrame: [{ id: "x", locator: "g:/Canvas/X", description: "TODO: x" }],
        stateSignal: { locator: "/Canvas/ChefGameManager", component: "ChefGameManager", property: "phase" },
      }),
    );
    const lines = await nextStepLinesFor(withSig);
    const joined = lines.join("\n");
    assert.match(joined, /^👉 Next — /m);
    assert.match(joined, /loombridge trace record --observe/);
    assert.match(joined, /--state-signal \/Canvas\/ChefGameManager:ChefGameManager:phase/);
  } finally {
    await fs.rm(withSig, { recursive: true, force: true });
  }

  // Without a stateSignal: the footer still gives the exact record command, plus the declare-one note.
  const noSig = await fs.mkdtemp(path.join(os.tmpdir(), "mg-footer-nosig-"));
  try {
    await fs.writeFile(
      path.join(noSig, "g.minigame.json"),
      JSON.stringify({
        id: "g",
        scenes: ["Assets/Scenes/G.unity"],
        requiredInFrame: [{ id: "x", locator: "g:/Canvas/X", description: "TODO: x" }],
      }),
    );
    const joined = (await nextStepLinesFor(noSig)).join("\n");
    assert.match(joined, /loombridge trace record --observe/);
    assert.doesNotMatch(joined, / --state-signal/);
    assert.match(joined, /--auto-state-signal/);
    assert.match(joined, /stateSignal/);
  } finally {
    await fs.rm(noSig, { recursive: true, force: true });
  }

  // An unreadable workspace yields no footer (best-effort: [] so the caller prints nothing).
  const empty = await fs.mkdtemp(path.join(os.tmpdir(), "mg-footer-empty-"));
  try {
    assert.deepEqual(await nextStepLinesFor(empty), []);
  } finally {
    await fs.rm(empty, { recursive: true, force: true });
  }
});

test("inspectWorkspace (G1): a valid contract stateSignal is read into the facts and threaded; a malformed one is ignored", async () => {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), "mg-next-sig-"));
  try {
    await fs.writeFile(
      path.join(ws, "g.minigame.json"),
      JSON.stringify({
        id: "g",
        scenes: ["Assets/Scenes/G.unity"],
        requiredInFrame: [{ id: "x", locator: "g:/Canvas/X", description: "TODO: x" }],
        stateSignal: { locator: "/Canvas/GameManager", component: "GameManager", property: "phase" },
      }),
    );
    const facts = await inspectWorkspace(ws);
    assert.ok(!("error" in facts), JSON.stringify(facts));
    assert.deepEqual((facts as WorkspaceFacts).stateSignal, {
      locator: "/Canvas/GameManager",
      component: "GameManager",
      property: "phase",
    });
    assert.match(resolveNextStep(facts as WorkspaceFacts).command, /--state-signal \/Canvas\/GameManager:GameManager:phase/);

    // A malformed signal (locator carries a `:`) is defensively ignored → undefined (validator owns the hard refusal).
    const bad = await fs.mkdtemp(path.join(os.tmpdir(), "mg-next-badsig-"));
    await fs.writeFile(
      path.join(bad, "g.minigame.json"),
      JSON.stringify({
        id: "g",
        scenes: ["Assets/Scenes/G.unity"],
        requiredInFrame: [{ id: "x", locator: "g:/Canvas/X", description: "TODO: x" }],
        stateSignal: { locator: "G:/Canvas/GM", property: "phase" },
      }),
    );
    const badFacts = await inspectWorkspace(bad);
    assert.ok(!("error" in badFacts));
    assert.equal((badFacts as WorkspaceFacts).stateSignal, undefined);
    await fs.rm(bad, { recursive: true, force: true });
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
});

test("inspectWorkspace: reads a real workspace and the resolver picks the right step", async () => {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), "mg-next-"));
  try {
    // A draft contract + a recorded trace + a capture present → next = finalize.
    await fs.writeFile(
      path.join(ws, "g.minigame.json"),
      JSON.stringify({ id: "g", scenes: ["Assets/Scenes/G.unity"], requiredInFrame: [{ id: "x", locator: "g:/Canvas/X", description: "TODO: x" }] }),
    );
    await fs.mkdir(path.join(ws, "traces"), { recursive: true });
    await fs.writeFile(path.join(ws, "traces", "g-happy-path.trace.json"), "{}");
    await fs.mkdir(path.join(ws, "captures"), { recursive: true });
    await fs.writeFile(path.join(ws, "captures", "active.ui-rects.json"), '{"objects":[]}');

    const facts = await inspectWorkspace(ws);
    assert.ok(!("error" in facts), JSON.stringify(facts));
    assert.equal((facts as WorkspaceFacts).id, "g");
    assert.equal((facts as WorkspaceFacts).traceRecorded, true);
    assert.equal((facts as WorkspaceFacts).capturesPresent, true);
    assert.equal((facts as WorkspaceFacts).contractFinalized, false, "placeholder /Canvas/ + TODO: → still a draft");
    assert.equal(resolveNextStep(facts as WorkspaceFacts).at, "finalize");

    // An empty dir (no contract) → a clear error, never a crash.
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), "mg-empty-"));
    assert.ok("error" in (await inspectWorkspace(empty)));
    await fs.rm(empty, { recursive: true, force: true });
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
});

test("inspectWorkspace (G3): captures detected from the first ACTIVE-kind state, not a hardcoded 'active' id", async () => {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), "mg-next-mix-"));
  try {
    // A multi-screen game whose first active state is `mix` (NOT `active`) — a scan draft.
    await fs.writeFile(
      path.join(ws, "kc.minigame.json"),
      JSON.stringify({
        id: "kc",
        scenes: ["Assets/Scenes/StarChef.unity"],
        requiredInFrame: [{ id: "i", locator: "/Canvas/MixPanel/I", description: "Discovered control." }],
        states: [
          { id: "mix", kind: "active", requiredInFrame: ["i"], description: "discovered MixPanel screen." },
          { id: "success_reward", kind: "success_reward", description: "discovered FinaleGroup screen." },
        ],
        interactionFlow: { happyPath: ["mix", "success_reward"] },
      }),
    );
    await fs.mkdir(path.join(ws, "traces"), { recursive: true });
    await fs.writeFile(path.join(ws, "traces", "kc-happy-path.trace.json"), "{}");
    await fs.mkdir(path.join(ws, "captures"), { recursive: true });
    // The capture wrote `mix.ui-rects.json` (its real state id) — NOT `active.ui-rects.json`.
    await fs.writeFile(path.join(ws, "captures", "mix.ui-rects.json"), '{"objects":[]}');

    const facts = await inspectWorkspace(ws);
    assert.ok(!("error" in facts), JSON.stringify(facts));
    // Pre-fix this was false (no active.ui-rects.json) → the run/check loop stalled on "capture".
    assert.equal((facts as WorkspaceFacts).capturesPresent, true, "captures detected from the `mix` state");
    // No TODO: descriptions ⇒ finalized ⇒ the resolver advances PAST capture (not stuck on it).
    assert.notEqual(resolveNextStep(facts as WorkspaceFacts).at, "capture");
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
});

test("inspectWorkspace: a scan-derived draft (DRAFT: descriptions, NO TODO:) still requires finalize", async () => {
  // The multi-scene regression: a fused contract is built entirely from per-scene SCAN parts, which
  // write `DRAFT:` (not `TODO:`) descriptions — and once the pass-through hub's placeholder reward is
  // pruned there may be NO `TODO:` anywhere. Keying `contractFinalized` on `TODO:` alone then misread
  // it as finalized and SKIPPED finalize, leaving namespaced object ids unreconciled to bare-id
  // captures → every gate false-failed. `DRAFT:` must be treated as a draft signal too.
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), "mg-next-draft-"));
  try {
    await fs.writeFile(
      path.join(ws, "ka.minigame.json"),
      JSON.stringify({
        id: "ka",
        scenes: ["Assets/Scenes/GameHub.unity", "Assets/Scenes/StarChef.unity"],
        requiredInFrame: [{ id: "star-chef__ingredientSugar", locator: "StarChef:/Canvas/MixPanel/Ingredient_sugar", description: "Discovered tappable control." }],
        states: [
          { id: "star-chef__mix", kind: "active", scene: "StarChef", requiredInFrame: ["star-chef__ingredientSugar"], description: "DRAFT: discovered MixPanel screen. Review/edit after recording a demonstration." },
        ],
        interactionFlow: { happyPath: ["star-chef__mix"] },
      }),
    );
    await fs.mkdir(path.join(ws, "traces"), { recursive: true });
    await fs.writeFile(path.join(ws, "traces", "ka-happy-path.trace.json"), "{}");
    await fs.mkdir(path.join(ws, "captures"), { recursive: true });
    await fs.writeFile(path.join(ws, "captures", "star-chef__mix.ui-rects.json"), '{"objects":[]}');

    const facts = await inspectWorkspace(ws);
    assert.ok(!("error" in facts), JSON.stringify(facts));
    assert.equal((facts as WorkspaceFacts).contractFinalized, false, "DRAFT: descriptions ⇒ not finalized");
    assert.equal(resolveNextStep(facts as WorkspaceFacts).at, "finalize", "must finalize before verify, not skip it");
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
});

test("inspectWorkspace: old background-candidates without render order are marked stale, not recommended", async () => {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), "mg-next-bg-old-"));
  try {
    await fs.writeFile(
      path.join(ws, "g.minigame.json"),
      JSON.stringify({ id: "g", scenes: ["Assets/Scenes/G.unity"], requiredInFrame: [{ id: "x", locator: "g:/Canvas/X", description: "TODO: x" }] }),
    );
    await fs.mkdir(path.join(ws, "traces"), { recursive: true });
    await fs.writeFile(path.join(ws, "traces", "g-happy-path.trace.json"), "{}");
    await fs.mkdir(path.join(ws, "captures"), { recursive: true });
    await fs.writeFile(path.join(ws, "captures", "active.ui-rects.json"), '{"objects":[]}');
    await fs.writeFile(
      path.join(ws, "captures", "background-candidates.json"),
      JSON.stringify({ recommended: [{ locator: "g:/Background/Sky", aabb: { min: { x: -1, y: -1 }, max: { x: 1, y: 1 } } }] }),
    );

    const facts = await inspectWorkspace(ws);
    assert.ok(!("error" in facts), JSON.stringify(facts));
    assert.equal((facts as WorkspaceFacts).backgroundRecommended, false);
    assert.equal((facts as WorkspaceFacts).backgroundCandidatesStale, true);
    const step = resolveNextStep(facts as WorkspaceFacts);
    assert.equal(step.at, "capture");
    assert.match(step.summary, /Re-capture with the current bridge/);
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
});

test("inspectWorkspace: a re-finalized contract (newer than the report) marks verify STALE → re-verify", async () => {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), "mg-stale-"));
  try {
    await fs.mkdir(path.join(ws, "traces"), { recursive: true });
    await fs.writeFile(path.join(ws, "traces", "g-happy-path.trace.json"), "{}");
    await fs.mkdir(path.join(ws, "captures"), { recursive: true });
    await fs.writeFile(path.join(ws, "captures", "active.ui-rects.json"), '{"objects":[]}');
    await fs.mkdir(path.join(ws, "reports"), { recursive: true });
    // A PASSING report written first…
    await fs.writeFile(path.join(ws, "reports", "minigame-verification.json"), '{"status":"pass"}');
    // …then the contract re-finalized AFTER it (e.g. a `finalize --safe-area-insets` pass).
    await new Promise((r) => setTimeout(r, 12));
    await fs.writeFile(
      path.join(ws, "g.minigame.json"),
      JSON.stringify({ id: "g", description: "Finalized …", scenes: ["Assets/Scenes/G.unity"], requiredInFrame: [{ id: "x", locator: "G:/Canvas/X", description: "Inferred x." }] }),
    );

    const facts = await inspectWorkspace(ws);
    assert.ok(!("error" in facts), JSON.stringify(facts));
    assert.deepEqual((facts as WorkspaceFacts).verify, { status: "READY", stale: true }, "contract newer than report ⇒ stale");
    // A stale pass must NOT advance to baseline — it must re-verify.
    assert.equal(resolveNextStep(facts as WorkspaceFacts).at, "verify");
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
});

test("inspectWorkspace: a CANVAS-ROOTED finalized contract reads as finalized (regression: /Canvas/ is a real Unity root, not a placeholder)", async () => {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), "mg-canvas-"));
  try {
    // Finalized contract whose REAL locators sit under a Canvas named "Canvas" (Unity's
    // default) — and NO `TODO:` anywhere (finalize strips them). This must read as finalized,
    // else `next` would loop on "finalize" forever for every Canvas-rooted uGUI game.
    await fs.writeFile(
      path.join(ws, "g.minigame.json"),
      JSON.stringify({
        id: "g",
        description: "Finalized 2D kids mini-game verification contract (locators inferred from captures).",
        scenes: ["Assets/Scenes/ShapeMatch.unity"],
        requiredInFrame: [{ id: "startButton", locator: "ShapeMatch:/Canvas/StartScreen/StartButton", description: "Inferred start control (/Canvas/StartScreen/StartButton)." }],
      }),
    );
    await fs.mkdir(path.join(ws, "traces"), { recursive: true });
    await fs.writeFile(path.join(ws, "traces", "g-happy-path.trace.json"), "{}");
    await fs.mkdir(path.join(ws, "captures"), { recursive: true });
    await fs.writeFile(path.join(ws, "captures", "active.ui-rects.json"), '{"objects":[]}');

    const facts = await inspectWorkspace(ws);
    assert.ok(!("error" in facts), JSON.stringify(facts));
    assert.equal((facts as WorkspaceFacts).contractFinalized, true, "/Canvas/ in real locators must NOT be read as a draft placeholder");
    assert.equal(resolveNextStep(facts as WorkspaceFacts).at, "verify", "finalized → advance to verify, not loop on finalize");
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
});
