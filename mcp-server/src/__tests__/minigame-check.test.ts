/**
 * S8e — `loombridge minigame check` orchestration core.
 *
 * Tests the injected decision loop only. The real command composes scan/sync/run;
 * those pieces are tested separately and are deliberately not reimplemented here.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { continueThroughRecordFor, driveCheck, parseArgs, scenesConflict, type CheckDeps } from "../loombridge/minigame-check.js";
import type { ContractDiff } from "../loombridge/minigame-sync.js";

test("parseArgs (Phase 0): --record-scene is parsed + validated as an asset path; --id normalizes; --scene stays the contract scene", () => {
  const ok = parseArgs(["--scene", "Assets/Scenes/StarChef.unity", "--id", "StarChef", "--record-scene", "Assets/Scenes/Home.unity"]);
  assert.ok(!("error" in ok) && !("help" in ok));
  assert.equal((ok as { scene: string }).scene, "Assets/Scenes/StarChef.unity"); // contract scene unchanged
  assert.equal((ok as { recordScene?: string }).recordScene, "Assets/Scenes/Home.unity");
  assert.equal((ok as { id: string }).id, "star-chef"); // --id still normalizes
  // A non-asset-path --record-scene is rejected (not silently accepted).
  assert.ok("error" in parseArgs(["--scene", "Assets/Scenes/StarChef.unity", "--record-scene", "NotAScene"]));
  // Absent → undefined (default: record resets to the contract scene).
  const none = parseArgs(["--scene", "Assets/Scenes/StarChef.unity"]);
  assert.equal((none as { recordScene?: string }).recordScene, undefined);
});

test("parseArgs (scene-agnostic): no --scene is valid with --id (record-first); requires --id; rejects --record-scene", () => {
  // No --scene + --id ⇒ the scene-agnostic record-first flow (scene resolved at record time).
  const ok = parseArgs(["--id", "GameHub"]);
  assert.ok(!("error" in ok) && !("help" in ok));
  assert.equal((ok as { scene?: string }).scene, undefined, "no scene bound — resolved at record time");
  assert.equal((ok as { id: string }).id, "game-hub", "--id still normalizes");
  // No --scene AND no --id ⇒ there's nothing to derive an id from ⇒ error.
  assert.ok("error" in parseArgs([]));
  // --record-scene without --scene is meaningless (it's the scene-first hub→game reset) ⇒ error.
  assert.ok("error" in parseArgs(["--id", "g", "--record-scene", "Assets/Scenes/Home.unity"]));
  // --bootstrap-only is meaningless without --scene (record-first can't "stop before record") ⇒ error.
  assert.ok("error" in parseArgs(["--id", "g", "--bootstrap-only"]));
});

test("scenesConflict (collision guard): a workspace already bound to a DIFFERENT scene conflicts; same scene / fresh does not", () => {
  // The danger: two games whose ids normalize to the same workspace, or a junk-id collision bucket.
  assert.equal(scenesConflict("Assets/Scenes/B.unity", "Assets/Scenes/A.unity"), true);   // different game → refuse
  assert.equal(scenesConflict("Assets/Scenes/StarChef.unity", "Assets/Other/StarChef.unity"), false); // same basename → same game, resume
  assert.equal(scenesConflict("Assets/Scenes/A.unity", undefined), false);                // fresh workspace → no conflict
});

test("continueThroughRecordFor: flow through ONLY on a real TTY and not --bootstrap-only", () => {
  assert.equal(continueThroughRecordFor(true, false), true);     // interactive → one-command flow
  assert.equal(continueThroughRecordFor(true, true), false);     // --bootstrap-only opts out even on a TTY
  assert.equal(continueThroughRecordFor(false, false), false);   // non-TTY → stop after the draft
  assert.equal(continueThroughRecordFor(undefined, false), false); // piped/redirected (undefined) is NOT a terminal
});

function emptyDiff(): ContractDiff {
  return { present: [], relocated: [], removed: [], added: [] };
}

function deps(overrides: Partial<CheckDeps> = {}) {
  const calls: string[] = [];
  const logs: string[] = [];
  const d: CheckDeps = {
    hasContract: async () => true,
    runScanStep: async () => { calls.push("scan"); return 0; },
    syncDiff: async () => { calls.push("sync"); return emptyDiff(); },
    delegateToRun: async () => { calls.push("run"); return 0; },
    nextSteps: async () => { calls.push("nextSteps"); return ["👉 Next — Record your happy path…", "   loombridge trace record --observe …"]; },
    continueThroughRecord: false, // default to the non-TTY/stop behavior; the flow-through test opts in
    log: (line) => logs.push(line),
    ...overrides,
  };
  return { d, calls, logs };
}

test("driveCheck: no contract runs scan, stops, and does not delegate to run", async () => {
  const h = deps({ hasContract: async () => false });

  assert.equal(await driveCheck(h.d), 0);
  assert.deepEqual(h.calls, ["scan", "nextSteps"]);
  assert.match(h.logs.join("\n"), /Draft contract written from the scene scan/);
});

test("driveCheck: bootstrap footer routes through the resolver (exact record command) + keeps the re-run-check loop", async () => {
  // G6: the bootstrap "next" must surface the SAME resolved record step `minigame next` gives
  // (with --state-signal threaded), not generic prose — AND keep the front-door re-run-check loop.
  const resolved = ["👉 Next — Record your happy path…", "   loombridge trace record --observe … --state-signal /Canvas/GM:GM:phase"];
  const h = deps({ hasContract: async () => false, nextSteps: async () => { h.calls.push("nextSteps"); return resolved; } });

  assert.equal(await driveCheck(h.d), 0);
  const log = h.logs.join("\n");
  assert.match(log, /loombridge trace record --observe … --state-signal \/Canvas\/GM:GM:phase/);
  assert.match(log, /After recording, re-run `loombridge minigame check`\./);
});

test("driveCheck (one-command): with continueThroughRecord, bootstrap flows STRAIGHT INTO run (no stop, no re-run-check prompt)", async () => {
  const h = deps({ hasContract: async () => false, continueThroughRecord: true });

  assert.equal(await driveCheck(h.d), 0);
  // scan, then delegate to run (record → capture → verify) — NOT the bootstrap-stop nextSteps path.
  assert.deepEqual(h.calls, ["scan", "run"]);
  const log = h.logs.join("\n");
  assert.match(log, /running the full flow .*one go/i);
  assert.doesNotMatch(log, /re-run `loombridge minigame check`/);
});

test("driveCheck: relocation drift stops for review and does not delegate", async () => {
  let syncCalled = false;
  const diff: ContractDiff = {
    ...emptyDiff(),
    relocated: [{ ref: { id: "homeButton", locator: "g:/Old/HomeButton" }, fromLocator: "g:/Old/HomeButton", toLocator: "/Canvas/HomeButton" }],
  };
  const h = deps({
    syncDiff: async () => { syncCalled = true; return diff; },
    delegateToRun: async () => { h.calls.push("run"); return 2; },
  });

  assert.equal(await driveCheck(h.d), 0);
  assert.equal(syncCalled, true);
  assert.deepEqual(h.calls, []);
  const log = h.logs.join("\n");
  assert.match(log, /relocated: homeButton/);
  assert.match(log, /\/Old\/HomeButton -> \/Canvas\/HomeButton/);
  assert.match(log, /loombridge minigame sync --scene/);
});

test("driveCheck: removed drift (a bound object vanished) stops without delegating", async () => {
  let syncCalled = false;
  const diff: ContractDiff = {
    ...emptyDiff(),
    removed: [{ id: "oldButton", locator: "g:/Canvas/OldButton" }],
  };
  const h = deps({ syncDiff: async () => { syncCalled = true; return diff; } });

  assert.equal(await driveCheck(h.d), 0);
  assert.equal(syncCalled, true);
  assert.deepEqual(h.calls, []); // never delegated to run
  const log = h.logs.join("\n");
  assert.match(log, /scene changed/);
  assert.match(log, /oldButton/);
  assert.match(log, /loombridge minigame sync --scene/);
});

test("driveCheck: added-only (new unbound controls) is informational and STILL delegates", async () => {
  const diff: ContractDiff = {
    ...emptyDiff(),
    added: [{ candidate: { id: "newButton", locator: "/Canvas/NewButton", name: "NewButton", role: "button" } }],
  };
  const h = deps({ syncDiff: async () => diff });

  assert.equal(await driveCheck(h.d), 0);
  assert.deepEqual(h.calls, ["run"]); // unbound controls do NOT block the check
  const log = h.logs.join("\n");
  assert.match(log, /new control\(s\) not bound/);
  assert.match(log, /newButton/);
});

test("driveCheck: no drift delegates directly and returns run code", async () => {
  const h = deps({ delegateToRun: async () => { h.calls.push("run"); return 0; } });

  assert.equal(await driveCheck(h.d), 0);
  assert.deepEqual(h.calls, ["sync", "run"]);
});

test("driveCheck: delegated NOT READY exit propagates as check exit 1", async () => {
  const h = deps({ delegateToRun: async () => { h.calls.push("run"); return 1; } });

  assert.equal(await driveCheck(h.d), 1);
  assert.deepEqual(h.calls, ["sync", "run"]);
});
