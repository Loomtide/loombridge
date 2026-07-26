/**
 * Record-first per-scene scan loop (Phase 1 D2-A). IO-injected orchestration: scan each verifiable
 * scene, fuse into one contract, and surface unverifiable / path-unresolvable scenes as can't-verify
 * (never dropped, never green). Fakes for resolveScenePath / scanScene.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { driveSceneAgnosticScan, type SceneScanDeps } from "../../../../capabilities/minigame/minigame-scene-scan.js";
import type { SceneAgnosticPlan } from "../../../../capabilities/minigame/minigame-scene-plan.js";
import type { MinigameContract } from "../../../../capabilities/minigame/profiles/types.js";

/** A minimal per-scene contract a fake `scanScene` returns. */
function sceneContract(idHint: string): MinigameContract {
  return {
    schemaVersion: "1",
    id: idHint,
    type: "2d-kids-minigame",
    scenes: [`Assets/Scenes/${idHint}.unity`],
    ageBand: "5-7",
    visualProfile: "phone-portrait",
    states: [{ id: "start", kind: "start", requiredInFrame: ["btn"] }],
    requiredInFrame: [{ id: "btn", locator: `${idHint}:/Canvas/Btn` }],
    uiSafeAreas: { maxOverflowFraction: 0 },
    tapTargets: { minSizeDp: 44 },
    interactionFlow: { happyPath: ["start"] },
    artifactThresholds: {},
    checks: { deterministic: ["required-in-frame"] },
  };
}

const okPlan = (scenes: Array<{ sceneName: string; namespacePrefix: string; verifiable: boolean; reason?: string }>): Extract<SceneAgnosticPlan, { status: "ok" }> => ({
  status: "ok",
  startScene: "Assets/Scenes/Home.unity",
  scenes,
  unverifiable: scenes.filter((s) => !s.verifiable).map((s) => ({ sceneName: s.sceneName, reason: s.reason ?? "x" })),
});

function fakeDeps(over: Partial<SceneScanDeps> = {}): { deps: SceneScanDeps; scanned: string[] } {
  const scanned: string[] = [];
  const deps: SceneScanDeps = {
    resolveScenePath: async (name) => `Assets/Scenes/${name}.unity`,
    scanScene: async (path, name) => {
      scanned.push(name);
      return sceneContract(name);
    },
    log: () => {},
    ...over,
  };
  return { deps, scanned };
}

test("scan loop: scans each verifiable scene and fuses into one namespaced multi-scene contract", async () => {
  const { deps, scanned } = fakeDeps();
  const plan = okPlan([
    { sceneName: "Home", namespacePrefix: "home", verifiable: true },
    { sceneName: "StarChef", namespacePrefix: "star-chef", verifiable: true },
  ]);
  const res = await driveSceneAgnosticScan(plan, "game-hub", deps);
  assert.ok(res.ok);
  if (!res.ok) return;
  assert.deepEqual(scanned, ["Home", "StarChef"]);
  assert.equal(res.contract.id, "game-hub");
  assert.deepEqual(res.contract.states.map((s) => s.id), ["home__start", "star-chef__start"]);
  assert.deepEqual(res.contract.scenes, ["Assets/Scenes/Home.unity", "Assets/Scenes/StarChef.unity"]);
  assert.deepEqual(res.cantVerify, []);
});

test("scan loop: an unverifiable scene (invariant #4) is can't-verify — scanned scenes still fuse", async () => {
  const { deps, scanned } = fakeDeps();
  const plan = okPlan([
    { sceneName: "Home", namespacePrefix: "home", verifiable: true },
    { sceneName: "Stir", namespacePrefix: "stir", verifiable: false, reason: "no sampled phase signal" },
  ]);
  const res = await driveSceneAgnosticScan(plan, "g", deps);
  assert.ok(res.ok);
  if (!res.ok) return;
  assert.deepEqual(scanned, ["Home"], "the unverifiable scene is NOT scanned");
  assert.deepEqual(res.cantVerify.map((c) => c.sceneName), ["Stir"]);
  assert.match(res.cantVerify[0].reason, /phase signal/);
});

test("scan loop: a scene whose path can't be resolved is can't-verify, never guessed", async () => {
  const { deps } = fakeDeps({ resolveScenePath: async (name) => (name === "Ghost" ? null : `Assets/Scenes/${name}.unity`) });
  const plan = okPlan([
    { sceneName: "Home", namespacePrefix: "home", verifiable: true },
    { sceneName: "Ghost", namespacePrefix: "ghost", verifiable: true },
  ]);
  const res = await driveSceneAgnosticScan(plan, "g", deps);
  assert.ok(res.ok);
  if (!res.ok) return;
  assert.deepEqual(res.cantVerify.map((c) => c.sceneName), ["Ghost"]);
  assert.match(res.cantVerify[0].reason, /saved Assets|can't resolve/i);
});

test("scan loop: NOTHING verifiable+resolvable ⇒ ok:false (can't verify this build), never an empty green", async () => {
  const { deps } = fakeDeps({ resolveScenePath: async () => null });
  const plan = okPlan([{ sceneName: "Home", namespacePrefix: "home", verifiable: true }]);
  const res = await driveSceneAgnosticScan(plan, "g", deps);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.match(res.error, /nothing to grade|can't verify/i);
  assert.deepEqual(res.cantVerify.map((c) => c.sceneName), ["Home"]);
});

test("scan loop: MIXED dispositions — ok + unverifiable + unresolvable in one plan, every scene accounted for", async () => {
  const { deps, scanned } = fakeDeps({
    resolveScenePath: async (name) => (name === "Ghost" ? null : `Assets/Scenes/${name}.unity`),
  });
  const plan = okPlan([
    { sceneName: "Home", namespacePrefix: "home", verifiable: true },
    { sceneName: "Stir", namespacePrefix: "stir", verifiable: false, reason: "no sampled phase signal" },
    { sceneName: "Ghost", namespacePrefix: "ghost", verifiable: true }, // resolves to null
    { sceneName: "StarChef", namespacePrefix: "star-chef", verifiable: true },
  ]);
  const res = await driveSceneAgnosticScan(plan, "g", deps);
  assert.ok(res.ok);
  if (!res.ok) return;
  // Only the two ok+resolvable scenes are scanned + fused…
  assert.deepEqual(scanned, ["Home", "StarChef"]);
  assert.deepEqual(res.contract.states.map((s) => s.id), ["home__start", "star-chef__start"]);
  // …and BOTH the unverifiable and the unresolvable scene land in can't-verify (none dropped).
  assert.deepEqual(res.cantVerify.map((c) => c.sceneName).sort(), ["Ghost", "Stir"]);
});

test("scan loop: a per-scene scan that THROWS (scene won't open) degrades to can't-verify, never crashes the run", async () => {
  const { deps } = fakeDeps({
    scanScene: async (path, name) => {
      if (name === "Broken") throw new Error("scene failed to open");
      return sceneContract(name);
    },
  });
  const plan = okPlan([
    { sceneName: "Home", namespacePrefix: "home", verifiable: true },
    { sceneName: "Broken", namespacePrefix: "broken", verifiable: true },
  ]);
  const res = await driveSceneAgnosticScan(plan, "g", deps); // must NOT reject
  assert.ok(res.ok);
  if (!res.ok) return;
  assert.deepEqual(res.cantVerify.map((c) => c.sceneName), ["Broken"]);
  assert.match(res.cantVerify[0].reason, /scan failed: scene failed to open/);
});

test("scan loop: a merge failure (e.g. a per-scene scan that disagrees on age band) is surfaced as ok:false, not a throw", async () => {
  const { deps } = fakeDeps({
    scanScene: async (path, name) => ({ ...sceneContract(name), ageBand: name === "StarChef" ? "8-10" : "5-7" }),
  });
  const plan = okPlan([
    { sceneName: "Home", namespacePrefix: "home", verifiable: true },
    { sceneName: "StarChef", namespacePrefix: "star-chef", verifiable: true },
  ]);
  const res = await driveSceneAgnosticScan(plan, "g", deps);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.match(res.error, /age band|cannot fuse/i);
});
