/**
 * Scene inference + scene-namespaced ids (Phase 1, Slice 1a). Pure helpers, synthetic traces — the
 * verification-side foundation for the scene-agnostic flow. Asserts: distinct scenes in first-touch
 * order, single-scene back-compat (no evidence ⇒ empty + `hasEvidence:false`), transition points, and
 * that path-typed `start.scene` and name-typed `segment.scene` reconcile to one filename-safe slug.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  inferScenesFromTrace,
  sceneTransitionsFromTrace,
  sceneSlug,
  sceneNamespacedId,
  findSlugCollisions,
} from "../loombridge/minigame-scene-inference.js";
import { observedClicksToTrace } from "../loombridge/replay/observe.js";
import type { ObservedClick } from "../loombridge/replay/observe.js";
import type { ReplayTrace, Segment } from "../loombridge/replay/types.js";

/** A minimal trace shell; `segs` are partial Segments (only `scene` matters to these helpers). */
function trace(startScene: string, segs: Array<Partial<Segment>>): Pick<ReplayTrace, "segments" | "start"> {
  return {
    start: { scene: startScene, reset: "scene-load" },
    segments: segs.map((s, i) => ({ id: `step-${i + 1}`, actions: [], ...s }) as Segment),
  };
}

test("inferScenesFromTrace: distinct scenes in first-touch order (hub→game→back)", () => {
  const t = trace("Assets/Scenes/Home.unity", [
    { scene: "Home" },
    { scene: "Home" },
    { scene: "StarChef" },
    { scene: "StarChef" },
    { scene: "Home" }, // returns home — already seen, not re-appended
  ]);
  const r = inferScenesFromTrace(t);
  assert.deepEqual(r.sceneNames, ["Home", "StarChef"]);
  assert.equal(r.startScene, "Assets/Scenes/Home.unity");
  assert.equal(r.hasEvidence, true);
});

test("inferScenesFromTrace: no scene evidence ⇒ single-scene back-compat (empty names, hasEvidence false)", () => {
  const t = trace("Assets/Scenes/G.unity", [{}, {}, {}]); // no segment carries a scene
  const r = inferScenesFromTrace(t);
  assert.deepEqual(r.sceneNames, []);
  assert.equal(r.hasEvidence, false);
  assert.equal(r.startScene, "Assets/Scenes/G.unity");
});

test("inferScenesFromTrace: partial evidence — only evidenced segments count, blanks ignored", () => {
  const t = trace("Assets/Scenes/Home.unity", [
    { scene: "Home" },
    {}, // no evidence on this one — skipped, doesn't reset the run
    { scene: "StarChef" },
    { scene: "" }, // empty string is not evidence
  ]);
  const r = inferScenesFromTrace(t);
  assert.deepEqual(r.sceneNames, ["Home", "StarChef"]);
  assert.equal(r.hasEvidence, true);
});

test("inferScenesFromTrace: empty / missing segments ⇒ no evidence, no throw", () => {
  assert.deepEqual(inferScenesFromTrace({ start: { scene: "A.unity", reset: "scene-load" }, segments: [] }).sceneNames, []);
  assert.equal(
    inferScenesFromTrace({ start: { scene: "A.unity", reset: "scene-load" } } as Pick<ReplayTrace, "segments" | "start">).hasEvidence,
    false,
  );
});

test("sceneTransitionsFromTrace: a transition is logged only when the scene CHANGES", () => {
  const t = trace("Assets/Scenes/Home.unity", [
    { scene: "Home" }, // first evidenced segment ⇒ entering Home (transition @0)
    { scene: "Home" }, // same scene — not a transition
    { scene: "StarChef" }, // change @2
    { scene: "StarChef" },
    { scene: "Home" }, // change back @4
  ]);
  assert.deepEqual(sceneTransitionsFromTrace(t), [
    { atSegment: 0, scene: "Home" },
    { atSegment: 2, scene: "StarChef" },
    { atSegment: 4, scene: "Home" },
  ]);
});

test("sceneTransitionsFromTrace: blanks between same-scene segments don't fabricate a transition", () => {
  const t = trace("Assets/Scenes/Home.unity", [{ scene: "Home" }, {}, { scene: "Home" }]);
  assert.deepEqual(sceneTransitionsFromTrace(t), [{ atSegment: 0, scene: "Home" }]);
});

test("sceneSlug: a runtime NAME and its asset PATH reconcile to the same slug", () => {
  assert.equal(sceneSlug("StarChef"), "star-chef");
  assert.equal(sceneSlug("Assets/Scenes/StarChef.unity"), "star-chef");
  assert.equal(sceneSlug("Assets/Levels/Sub/Home.unity"), "home");
  assert.equal(sceneSlug("Home"), "home");
});

test("sceneSlug: messy names normalize to a valid, filename-safe id segment", () => {
  assert.equal(sceneSlug("Level 1 (Final)"), "level-1-final");
  // Leading non-letter ⇒ normalizeWorkspaceId prefixes game- so the id stays a legal STATE_ID.
  // Pinned to the exact value so a regression in the digit-prefix behavior is caught, not just well-formedness.
  assert.equal(sceneSlug("123Scene"), "game-123-scene");
  assert.match(sceneSlug("123Scene"), /^[a-z0-9][a-z0-9_-]*$/);
});

test("sceneSlug: a trailing slash doesn't swallow the basename (regression: '' basename → generic slug)", () => {
  assert.equal(sceneSlug("Home/"), "home");
  assert.equal(sceneSlug("Assets/Scenes/StarChef.unity/"), "star-chef");
  // A path with NO basename (folder only) has nothing to slug → the generic fallback, NOT a crash.
  assert.match(sceneSlug("Assets/Scenes/"), /^[a-z0-9][a-z0-9_-]*$/);
});

test("findSlugCollisions: two distinct scenes that share a slug are reported (must be refused, not merged)", () => {
  // Same basename, different folder — a normal Unity layout — collides to `home`.
  const folders = findSlugCollisions(["Assets/Levels/A/Home.unity", "Assets/Levels/B/Home.unity"]);
  assert.equal(folders.length, 1);
  assert.equal(folders[0].slug, "home");
  assert.deepEqual(folders[0].names.sort(), ["Assets/Levels/A/Home.unity", "Assets/Levels/B/Home.unity"]);

  // Runtime names that normalize identically also collide.
  const names = findSlugCollisions(["My Scene", "MyScene", "my-scene"]);
  assert.equal(names.length, 1);
  assert.equal(names[0].slug, "my-scene");
  assert.equal(names[0].names.length, 3);
});

test("findSlugCollisions: genuinely-distinct scenes report NO collision; identical names aren't a collision", () => {
  assert.deepEqual(findSlugCollisions(["Home", "StarChef", "Settings"]), []);
  assert.deepEqual(findSlugCollisions([]), []);
  // The SAME scene listed twice is one identity, not a collision.
  assert.deepEqual(findSlugCollisions(["Home", "Home"]), []);
});

test("sceneNamespacedId: two messy scenes that survive collision-detection stay distinct ids", () => {
  // Pathological-but-distinct slugs must not collapse.
  const a = sceneNamespacedId("Level 1", "start");
  const b = sceneNamespacedId("Level 2", "start");
  assert.notEqual(a, b);
  assert.match(a, /^[a-z0-9][a-z0-9_-]*$/);
  assert.match(b, /^[a-z0-9][a-z0-9_-]*$/);
});

test("observedClicksToTrace: an empty-string locator scene is dropped (no `scene` key), matching the no-evidence contract", () => {
  const clicks: ObservedClick[] = [
    { tMs: 0, locator: { path: "Canvas/Start", scene: "" } },
    { tMs: 100, locator: { path: "Canvas/Play", scene: "StarChef" } },
  ];
  const t = observedClicksToTrace(clicks, { id: "g", scene: "Assets/Scenes/G.unity" });
  // Empty string ⇒ no key at all (not `scene: ""`), so inference sees it as no-evidence.
  assert.ok(!("scene" in t.segments[0]), "empty-string scene must not serialize a scene key");
  assert.equal((t.segments[1] as { scene?: string }).scene, "StarChef");
  // And inference agrees: only the real scene counts.
  assert.deepEqual(inferScenesFromTrace(t).sceneNames, ["StarChef"]);
});

test("sceneNamespacedId: identically-named screens in two scenes get distinct, pattern-valid ids", () => {
  const STATE_ID = /^[a-z0-9][a-z0-9_-]*$/;
  const homeStart = sceneNamespacedId("Home", "start");
  const chefStart = sceneNamespacedId("Assets/Scenes/StarChef.unity", "start");
  assert.equal(homeStart, "home__start");
  assert.equal(chefStart, "star-chef__start");
  assert.notEqual(homeStart, chefStart);
  assert.match(homeStart, STATE_ID);
  assert.match(chefStart, STATE_ID);
});
