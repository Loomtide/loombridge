/**
 * Scene inference + scene-namespaced ids for the multi-scene (scene-agnostic) mini-game flow.
 *
 * Phase 1 of the scene-agnostic milestone: a recorded playthrough crosses scenes (home → game), and
 * the persisted trace carries per-segment scene evidence (`Segment.scene`, set by the observer when
 * the bridge reports the active scene). These PURE helpers turn that evidence into the scene graph and
 * keep generated state/object ids collision-free across scenes (a `start` state in two scenes must not
 * share a workspace filename). Replay never reads any of this — it's verification-side only.
 *
 * No IO, no bridge — exhaustively unit-testable. The live wiring (the C# observer emitting the scene,
 * resolving a runtime name → an `Assets/**.unity` path, the per-scene scan loop) is a separate slice.
 */

import { normalizeWorkspaceId } from "./workspace-paths.js";
import type { ReplayTrace } from "./replay/types.js";

export interface InferredScenes {
  /**
   * Distinct runtime scene NAMES the demonstration visited, in first-touch order, from the per-segment
   * scene evidence. Empty when the trace carried no evidence (a single-scene game — use `startScene`).
   */
  sceneNames: string[];
  /** The reset/start scene (the trace's `start.scene` — an `Assets/**.unity` asset path). */
  startScene: string | undefined;
  /** True when at least one segment carried scene evidence (i.e. a multi-scene trace). */
  hasEvidence: boolean;
}

/**
 * Derive the scene graph from a recorded trace's per-segment scene evidence. Pure. Returns the distinct
 * scene names in the order they were first touched (so `[home, starChef]` for a hub→game playthrough),
 * plus the reset start scene.
 *
 * `hasEvidence: false` means ONLY "no segment carried a scene" — NOT "confirmed single-scene". A real
 * single-scene game and a multi-scene game whose recorder failed to emit scenes both land here. The
 * caller MUST NOT treat the no-evidence case as a confirmed single scene and PASS it: for a trace known
 * to have navigated (or any flow where scenes were expected), no evidence is a can't-verify (exit 2),
 * never a silent green. It is back-compatible only in the genuine single-scene case.
 */
export function inferScenesFromTrace(trace: Pick<ReplayTrace, "segments" | "start">): InferredScenes {
  const startScene = trace.start?.scene;
  const sceneNames: string[] = [];
  const seen = new Set<string>();
  let hasEvidence = false;
  for (const seg of trace.segments ?? []) {
    const scene = (seg as { scene?: unknown }).scene;
    if (typeof scene !== "string" || scene.length === 0) continue;
    hasEvidence = true;
    if (!seen.has(scene)) {
      seen.add(scene);
      sceneNames.push(scene);
    }
  }
  return { sceneNames, startScene, hasEvidence };
}

/** The 0-based segment indices where the active scene CHANGES (a scene transition / navigation point),
 *  from the per-segment evidence. The first evidenced segment is always a transition (entering the
 *  first evidenced scene). Empty when there's no evidence. */
export function sceneTransitionsFromTrace(trace: Pick<ReplayTrace, "segments">): { atSegment: number; scene: string }[] {
  const transitions: { atSegment: number; scene: string }[] = [];
  let current: string | undefined;
  (trace.segments ?? []).forEach((seg, i) => {
    const scene = (seg as { scene?: unknown }).scene;
    if (typeof scene !== "string" || scene.length === 0) return;
    if (scene !== current) {
      transitions.push({ atSegment: i, scene });
      current = scene;
    }
  });
  return transitions;
}

/**
 * A canonical, collision-free slug for a scene NAME or asset PATH — the lowercase-kebab basename, no
 * extension. `Assets/Scenes/StarChef.unity` and the runtime name `StarChef` both slug to `star-chef`,
 * so a path-typed `start.scene` and a name-typed `segment.scene` reconcile to one identity.
 */
export function sceneSlug(sceneNameOrPath: string): string {
  const trimmed = sceneNameOrPath.replace(/\/+$/, ""); // tolerate a trailing slash before basename-ing
  const base = trimmed.split("/").pop() || trimmed; // `||` not `??` — an empty basename is not usable
  const noExt = base.replace(/\.unity$/i, "");
  return normalizeWorkspaceId(noExt);
}

/**
 * Find scenes that collapse to the SAME slug — distinct scene identities that `sceneNamespacedId` would
 * silently merge into one capture/id namespace (e.g. `Levels/A/Home.unity` + `Levels/B/Home.unity`, or
 * `My Scene` + `MyScene`, or two underivable punctuation-only names that both fall back to the generic
 * slug). The per-scene consumer MUST call this and REFUSE (can't-verify, exit 2) on any collision rather
 * than namespace by a slug that two scenes share — otherwise scene B's screens grade against scene A's
 * frozen captures. Returns one entry per colliding slug, with the offending names; empty ⇒ safe to slug.
 */
export function findSlugCollisions(sceneNames: string[]): { slug: string; names: string[] }[] {
  const bySlug = new Map<string, string[]>();
  for (const name of sceneNames) {
    const slug = sceneSlug(name);
    const names = bySlug.get(slug) ?? [];
    if (!names.includes(name)) names.push(name);
    bySlug.set(slug, names);
  }
  return [...bySlug.entries()].filter(([, names]) => names.length > 1).map(([slug, names]) => ({ slug, names }));
}

/**
 * Scene-namespace a generated state/object id so two scenes' identically-named screens (a `start` in
 * `home` AND in the game) get distinct, filename-safe ids: `home__start`, `star-chef__active`. The
 * state still carries its `scene` field for human grouping.
 *
 * Given a `baseId` that is already STATE_ID-valid (`^[a-z0-9][a-z0-9_-]*$`) — which generated base ids
 * are — the result is also STATE_ID-valid (only the scene half is normalized here), so it is a legal
 * state id and a safe capture filename. PRECONDITION: the caller must have run `findSlugCollisions` over
 * the scene set and refused on any collision; two scenes that share a slug would mint colliding ids here.
 */
export function sceneNamespacedId(sceneNameOrPath: string, baseId: string): string {
  return `${sceneSlug(sceneNameOrPath)}__${baseId}`;
}
