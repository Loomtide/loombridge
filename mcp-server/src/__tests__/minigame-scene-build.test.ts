/**
 * Record-first contract assembly (Phase 1 capstone). Ties plan + scan-loop into one contract, resolving
 * the three plan branches: single-scene fallback, collision refusal, multi-scene fuse. Synthetic traces
 * + fake scan IO.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { buildContractFromTrace, type BuildContractDeps } from "../loomtide/minigame-scene-build.js";
import type { ReplayTrace, Segment, Action } from "../loomtide/replay/types.js";
import type { MinigameContract } from "../loomtide/minigame-profiles/types.js";

const drag = (travelPx: number): Action => ({ do: "drag", from: { path: "/P" }, to: { path: "/P" }, travelPx });
const tap = (): Action => ({ do: "tap", locator: { path: "/B" } });
const signal = (): Action => ({ do: "wait-for-condition", locator: { path: "/GM" }, property_path: "phase", operator: "equals", expected: "Mix" });
const seg = (scene: string | undefined, actions: Action[]): Segment => ({ id: "s", actions, ...(scene !== undefined ? { scene } : {}) }) as Segment;
const trace = (segments: Segment[], startScene = "Assets/Scenes/Home.unity"): Pick<ReplayTrace, "segments" | "start"> => ({
  start: { scene: startScene, reset: "scene-load" },
  segments,
});

function sceneContract(idHint: string): MinigameContract {
  return {
    schemaVersion: "1", id: idHint, type: "2d-kids-minigame",
    scenes: [`Assets/Scenes/${idHint}.unity`], ageBand: "5-7", visualProfile: "phone-portrait",
    states: [{ id: "start", kind: "start", requiredInFrame: ["btn"] }],
    requiredInFrame: [{ id: "btn", locator: `${idHint}:/Canvas/Btn` }],
    uiSafeAreas: { maxOverflowFraction: 0 }, tapTargets: { minSizeDp: 44 },
    interactionFlow: { happyPath: ["start"] }, artifactThresholds: {}, checks: { deterministic: ["required-in-frame"] },
  };
}

function fakeDeps(over: Partial<BuildContractDeps> = {}): BuildContractDeps {
  return {
    scan: {
      resolveScenePath: async (name) => `Assets/Scenes/${name}.unity`,
      scanScene: async (path, name) => sceneContract(name),
      log: () => {},
    },
    singleSceneScan: async (path) => sceneContract("single"),
    log: () => {},
    ...over,
  };
}

test("build (no evidence): falls back to a single-scene scan of the start scene", async () => {
  let scanned: string | undefined;
  const res = await buildContractFromTrace(trace([seg(undefined, [tap()])]), "g", fakeDeps({
    singleSceneScan: async (path) => { scanned = path; return sceneContract("single"); },
  }));
  assert.ok(res.ok);
  if (!res.ok) return;
  assert.equal(res.multiScene, false);
  assert.equal(scanned, "Assets/Scenes/Home.unity");
  assert.deepEqual(res.cantVerify, []);
});

test("build (no evidence): a single-scene scan failure is a can't-verify, not a throw", async () => {
  const res = await buildContractFromTrace(trace([seg(undefined, [tap()])]), "g", fakeDeps({
    singleSceneScan: async () => { throw new Error("scene won't open"); },
  }));
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.match(res.error, /scan of .* failed|scene won't open/i);
});

test("build (no evidence): a recording with no resolvable start scene refuses (can't verify)", async () => {
  const noStart = { start: { scene: "", reset: "scene-load" as const }, segments: [seg(undefined, [tap()])] };
  const res = await buildContractFromTrace(noStart, "g", fakeDeps());
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.match(res.error, /no resolvable start scene/i);
});

test("build (multi-scene): scans each scene and fuses into a namespaced multi-scene contract", async () => {
  const res = await buildContractFromTrace(
    trace([seg("Home", [tap()]), seg("StarChef", [signal(), drag(800)])]),
    "game-hub",
    fakeDeps(),
  );
  assert.ok(res.ok);
  if (!res.ok) return;
  assert.equal(res.multiScene, true);
  assert.deepEqual(res.contract.states.map((s) => s.id), ["home__start", "star-chef__start"]);
  assert.deepEqual(res.cantVerify, []);
});

test("build (multi-scene): an unverifiable gesture scene is carried as can't-verify; the rest fuse", async () => {
  const res = await buildContractFromTrace(
    trace([seg("Home", [tap()]), seg("Stir", [drag(800)])]), // Stir: unsignalled gesture
    "g",
    fakeDeps(),
  );
  assert.ok(res.ok);
  if (!res.ok) return;
  assert.deepEqual(res.cantVerify.map((c) => c.sceneName), ["Stir"]);
  assert.deepEqual(res.contract.states.map((s) => s.id), ["home__start"]);
});

test("build (collision): two scenes that share a slug REFUSE (exit 2), naming the colliding scenes", async () => {
  const res = await buildContractFromTrace(
    trace([seg("My Scene", [tap()]), seg("MyScene", [tap()])]),
    "g",
    fakeDeps(),
  );
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.match(res.error, /share a capture namespace|can't verify/i);
  assert.deepEqual(res.cantVerify.map((c) => c.sceneName).sort(), ["My Scene", "MyScene"]);
});

test("build (multi-scene): nothing verifiable+resolvable ⇒ can't verify this build (ok:false)", async () => {
  const res = await buildContractFromTrace(
    trace([seg("Home", [tap()])]),
    "g",
    fakeDeps({ scan: { resolveScenePath: async () => null, scanScene: async (p, n) => sceneContract(n), log: () => {} } }),
  );
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.match(res.error, /nothing to grade|can't verify/i);
  assert.deepEqual(res.cantVerify.map((c) => c.sceneName), ["Home"]);
});
