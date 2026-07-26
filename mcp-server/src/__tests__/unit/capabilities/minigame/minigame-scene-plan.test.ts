/**
 * Record-first scene-agnostic scan PLAN (Phase 1 D2-A/D/E). Pure composition of the merged primitives
 * into one combined decision: scene order + namespace prefixes, a slug-collision REFUSAL, single-scene
 * fallback, and per-scene can't-verify (invariant #4). Synthetic traces; the MOAT precedence is pinned.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { planSceneAgnosticScan } from "../../../../capabilities/minigame/minigame-scene-plan.js";
import type { ReplayTrace, Segment, Action } from "../../../../capabilities/replay/types.js";

const drag = (travelPx: number): Action => ({ do: "drag", from: { path: "/Canvas/Pan" }, to: { path: "/Canvas/Pan" }, travelPx });
const tap = (): Action => ({ do: "tap", locator: { path: "/Canvas/Btn" } });
const signal = (): Action => ({ do: "wait-for-condition", locator: { path: "/GM" }, property_path: "phase", operator: "equals", expected: "Mix" });

const seg = (scene: string | undefined, actions: Action[]): Segment =>
  ({ id: "s", actions, ...(scene !== undefined ? { scene } : {}) }) as Segment;

const trace = (segments: Segment[], startScene = "Assets/Scenes/Home.unity"): Pick<ReplayTrace, "segments" | "start"> => ({
  start: { scene: startScene, reset: "scene-load" },
  segments,
});

test("plan: no scene evidence ⇒ single-scene fallback (the existing scan-first flow owns it)", () => {
  const p = planSceneAgnosticScan(trace([seg(undefined, [tap()])]));
  assert.equal(p.status, "no-evidence");
  if (p.status === "no-evidence") assert.equal(p.startScene, "Assets/Scenes/Home.unity");
});

test("plan (ok): multi-scene hub→game — scenes in first-touch order, each with its namespace prefix", () => {
  const p = planSceneAgnosticScan(
    trace([seg("Home", [tap()]), seg("StarChef", [signal(), drag(800)])]),
  );
  assert.equal(p.status, "ok");
  if (p.status !== "ok") return;
  assert.deepEqual(p.scenes.map((s) => s.sceneName), ["Home", "StarChef"]);
  assert.deepEqual(p.scenes.map((s) => s.namespacePrefix), ["home", "star-chef"]);
  assert.ok(p.scenes.every((s) => s.verifiable), "both scenes verifiable (gesture is signalled)");
  assert.equal(p.startScene, "Assets/Scenes/Home.unity");
});

test("plan (ok): a gesture scene with no sampled signal is marked can't-verify (invariant #4), not dropped", () => {
  const p = planSceneAgnosticScan(
    trace([seg("Home", [tap()]), seg("StarChef", [drag(800)])]), // unsignalled stir
  );
  assert.equal(p.status, "ok");
  if (p.status !== "ok") return;
  const chef = p.scenes.find((s) => s.sceneName === "StarChef")!;
  assert.equal(chef.verifiable, false);
  assert.match(chef.reason!, /can't verify|phase signal/i);
  // It's still in the plan (the runner emits exit 2 for it) AND in the unverifiable list.
  assert.deepEqual(p.unverifiable.map((u) => u.sceneName), ["StarChef"]);
  // Home (tap-only) stays verifiable.
  assert.equal(p.scenes.find((s) => s.sceneName === "Home")!.verifiable, true);
});

test("plan (collision): two distinct scenes that share a slug REFUSE up front — never a per-scene plan", () => {
  // Distinct runtime names that normalize to the same slug would merge captures → hard refusal.
  const p = planSceneAgnosticScan(trace([seg("My Scene", [tap()]), seg("MyScene", [tap()])]));
  assert.equal(p.status, "collision");
  if (p.status !== "collision") return;
  assert.equal(p.collisions.length, 1);
  assert.equal(p.collisions[0].slug, "my-scene");
});

test("plan: collision precedence — a slug collision refuses even when a scene is also can't-verify", () => {
  // MOAT order: the collision is detected BEFORE per-scene verifiability, so the verdict is the refusal.
  const p = planSceneAgnosticScan(trace([seg("My Scene", [drag(800)]), seg("MyScene", [drag(800)])]));
  assert.equal(p.status, "collision");
});

test("plan (ok): a revisited scene appears ONCE, in first-touch order, across 3 scenes", () => {
  const p = planSceneAgnosticScan(
    trace([seg("Home", [tap()]), seg("StarChef", [signal(), drag(800)]), seg("Scores", [tap()]), seg("Home", [tap()])]),
  );
  assert.equal(p.status, "ok");
  if (p.status !== "ok") return;
  assert.deepEqual(p.scenes.map((s) => s.sceneName), ["Home", "StarChef", "Scores"], "first-touch order, no revisit dup");
});

test("plan (ok): COMPLETENESS — every unverifiable scene appears in `scenes` as verifiable:false", () => {
  // Two unsignalled gesture scenes + one tap scene: the can't-verify set and the plan must agree exactly.
  const p = planSceneAgnosticScan(
    trace([seg("Stir", [drag(500)]), seg("Home", [tap()]), seg("Whisk", [drag(600)])]),
  );
  assert.equal(p.status, "ok");
  if (p.status !== "ok") return;
  const unverifiableNames = new Set(p.unverifiable.map((u) => u.sceneName));
  for (const s of p.scenes) {
    assert.equal(s.verifiable, !unverifiableNames.has(s.sceneName), `${s.sceneName} verifiable flag must match the unverifiable set`);
  }
  // And nothing in `unverifiable` is missing from `scenes` (no dropped can't-verify).
  for (const u of p.unverifiable) {
    assert.ok(p.scenes.some((s) => s.sceneName === u.sceneName && !s.verifiable), `${u.sceneName} must be in scenes as can't-verify`);
  }
});
