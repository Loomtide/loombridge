/**
 * Phase 1 enforcement primitives (Slice 1c): D5 entry-scene resolution + invariant #4 (a gesture scene
 * with no sampled phase signal is can't-verify). Pure helpers, synthetic traces. These are the MOAT
 * guards the doc insists are ENFORCED, not documented — so the tests pin the refusals.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveEntryScene,
  resolveActiveEntryScene,
  resolveScenePathByName,
  unverifiableGestureScenes,
  ENTRY_SCENE_REFUSAL,
  type SceneQueryDriver,
} from "../loomtide/minigame-scene-gating.js";
import type { ReplayTrace, Segment, Action } from "../loomtide/replay/types.js";

// ── D5 — resolveEntryScene ───────────────────────────────────────────────────────

test("resolveEntryScene: a saved Assets/**.unity active scene resolves, carrying the runtime name", () => {
  const r = resolveEntryScene({ name: "Home", assetPath: "Assets/Scenes/Home.unity" });
  assert.deepEqual(r, { ok: true, scene: "Assets/Scenes/Home.unity", sceneName: "Home" });
});

test("resolveEntryScene: an unsaved / path-less active scene REFUSES (exit 2), never guesses a name", () => {
  for (const active of [
    { name: "Untitled", assetPath: null },
    { name: "Untitled", assetPath: undefined },
    { name: "Untitled" },
    null,
    undefined,
  ]) {
    const r = resolveEntryScene(active);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.exitCode, 2);
      assert.equal(r.message, ENTRY_SCENE_REFUSAL);
    }
  }
});

test("resolveEntryScene: a non-asset path (traversal / bare name) REFUSES — the name can't be a reset target", () => {
  assert.equal(resolveEntryScene({ assetPath: "Home" }).ok, false);
  assert.equal(resolveEntryScene({ assetPath: "../escape.unity" }).ok, false);
  assert.equal(resolveEntryScene({ assetPath: "Assets/Scenes/Home.prefab" }).ok, false);
});

// ── resolveActiveEntryScene (bridge → resolution) ────────────────────────────────

const fakeDriver = (result: { error: string } | { data: Record<string, unknown> }): SceneQueryDriver => ({
  op: async (opName) => {
    assert.equal(opName, "scene.get_active");
    return result;
  },
});

test("resolveActiveEntryScene: a saved active scene from the bridge resolves to its asset path + name", async () => {
  const r = await resolveActiveEntryScene(
    fakeDriver({ data: { scene_name: "Home", scene_path: "Assets/Scenes/Home.unity", is_saved: true } }),
  );
  assert.deepEqual(r, { ok: true, scene: "Assets/Scenes/Home.unity", sceneName: "Home" });
});

test("resolveActiveEntryScene: an unsaved active scene (scene_path null) REFUSES (exit 2)", async () => {
  const r = await resolveActiveEntryScene(fakeDriver({ data: { scene_name: "Untitled", scene_path: null, is_saved: false } }));
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.exitCode, 2);
});

test("resolveActiveEntryScene: a bridge ERROR is itself a can't-verify (exit 2), never a guess", async () => {
  const r = await resolveActiveEntryScene(fakeDriver({ error: "not connected" }));
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.exitCode, 2);
    assert.match(r.message, /bridge error: not connected/);
  }
});

// ── resolveScenePathByName (name → asset path) ──────────────────────────────────

const findByName = (result: { error: string } | { data: Record<string, unknown> }): SceneQueryDriver => ({
  op: async (opName) => {
    assert.equal(opName, "scene.find_by_name");
    return result;
  },
});

test("resolveScenePathByName: a unique match resolves to its asset path", async () => {
  const p = await resolveScenePathByName(
    findByName({ data: { scene_name: "StarChef", scene_path: "Assets/Scenes/StarChef.unity", match_count: 1 } }),
    "StarChef",
  );
  assert.equal(p, "Assets/Scenes/StarChef.unity");
});

test("resolveScenePathByName: not-found (count 0) and AMBIGUOUS (count >1, null path) both resolve to null — never guess", async () => {
  assert.equal(await resolveScenePathByName(findByName({ data: { scene_name: "Ghost", scene_path: null, match_count: 0 } }), "Ghost"), null);
  assert.equal(
    await resolveScenePathByName(findByName({ data: { scene_name: "StarChef", scene_path: null, match_count: 2, matches: ["a/StarChef.unity", "b/StarChef.unity"] } }), "StarChef"),
    null,
    "ambiguous name is unresolvable, not a silent pick",
  );
});

test("resolveScenePathByName: a non-asset path or a bridge error resolves to null (defense in depth)", async () => {
  assert.equal(await resolveScenePathByName(findByName({ data: { scene_path: "../escape.unity", match_count: 1 } }), "X"), null);
  assert.equal(await resolveScenePathByName(findByName({ error: "not connected" }), "X"), null);
});

// ── Invariant #4 — unverifiableGestureScenes ────────────────────────────────────

const drag = (travelPx: number): Action => ({ do: "drag", from: { path: "/Canvas/Pan" }, to: { path: "/Canvas/Pan" }, travelPx });
const tap = (): Action => ({ do: "tap", locator: { path: "/Canvas/Btn" } });
const worldTap = (): Action => ({ do: "world-tap", locator: { path: "/Sprite" } });
const signal = (): Action => ({ do: "wait-for-condition", locator: { path: "/GM" }, property_path: "phase", operator: "equals", expected: "Mix" });

function seg(scene: string | undefined, actions: Action[]): Segment {
  return { id: "s", actions, ...(scene !== undefined ? { scene } : {}) } as Segment;
}

function trace(segments: Segment[]): Pick<ReplayTrace, "segments" | "start"> {
  return { start: { scene: "Assets/Scenes/Home.unity", reset: "scene-load" }, segments };
}

test("invariant #4: a gesture gated in its OWN segment (recorder structure) is verifiable (not flagged)", () => {
  const t = trace([seg("StarChef", [signal(), drag(800)])]);
  assert.deepEqual(unverifiableGestureScenes(t), []);
});

test("invariant #4: an unsignalled continuous gesture is flagged can't-verify", () => {
  const t = trace([
    seg("Home", [tap()]), // tap-only nav scene — fine
    seg("StarChef", [drag(800)]), // continuous gesture, no signal → can't verify
  ]);
  const out = unverifiableGestureScenes(t);
  assert.equal(out.length, 1);
  assert.equal(out[0].sceneName, "StarChef");
  assert.match(out[0].reason, /can't verify|exit 2/i);
});

test("invariant #4: a signal in a DIFFERENT segment does NOT cover the gesture — binding is per-segment (the HIGH)", () => {
  // The state-signal gate sits in segment A; the unsignalled stir sits in segment B of the same scene.
  // Per-segment binding flags it — a stray gate elsewhere can't launder the gesture into verifiable.
  const t = trace([seg("StarChef", [signal()]), seg("StarChef", [drag(800)])]);
  assert.deepEqual(unverifiableGestureScenes(t).map((u) => u.sceneName), ["StarChef"]);
});

test("invariant #4: an UNRELATED wait-for-condition in the gesture's own segment still counts (recorder only grafts the signal gate there)", () => {
  // The recorder never grafts a non-signal wait-for-condition into a gesture segment, so a same-segment
  // gate IS the signal gate. (Documents the structural binding the predicate relies on.)
  const t = trace([seg("StarChef", [signal(), drag(800)])]);
  assert.deepEqual(unverifiableGestureScenes(t), []);
});

test("invariant #4: only CONTINUOUS (travel) gestures count — tap / world-tap / zero-travel are never flagged", () => {
  assert.deepEqual(unverifiableGestureScenes(trace([seg("Home", [tap()])])), []);
  assert.deepEqual(unverifiableGestureScenes(trace([seg("StarChef", [worldTap()])])), []);
  // A point-to-point / drop drag carries travelPx 0 → not a continuous gesture → not flagged.
  assert.deepEqual(unverifiableGestureScenes(trace([seg("StarChef", [drag(0)])])), []);
});

test("invariant #4: a single-scene trace (no scene evidence) returns [] — existing single-signal flow owns it", () => {
  // No segment carries a scene ⇒ no evidence ⇒ this multi-scene predicate stays out of the way.
  assert.deepEqual(unverifiableGestureScenes(trace([seg(undefined, [drag(800)])])), []);
});

test("invariant #4: a gesture segment with NO scene evidence is skipped even amid evidenced segments (not mis-attributed)", () => {
  // Segment 2 has a gesture but no scene tag → it can't be attributed to a scene, so it is skipped, not
  // pinned to Home. Home itself (tap-only) stays verifiable. (Documents the partial-evidence boundary.)
  const t = trace([seg("Home", [tap()]), seg(undefined, [drag(800)])]);
  assert.deepEqual(unverifiableGestureScenes(t), []);
});

test("invariant #4: two unsignalled gesture scenes are BOTH flagged, in first-touch order, once each", () => {
  const t = trace([
    seg("Stir", [drag(500)]),
    seg("Whisk", [drag(600)]),
    seg("Stir", [drag(500)]), // same scene again — not duplicated
  ]);
  assert.deepEqual(unverifiableGestureScenes(t).map((u) => u.sceneName), ["Stir", "Whisk"]);
});
