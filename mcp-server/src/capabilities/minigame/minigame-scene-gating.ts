/**
 * Phase 1 enforcement primitives for the scene-agnostic flow — the parts the doc insists are ENFORCED,
 * not just documented. Pure + exhaustively unit-testable; the live runner wires them in.
 *
 *  - `resolveEntryScene` (D5): when `check`/`run` is invoked WITHOUT `--scene`, resolve the editor's
 *    active scene to a resettable `Assets/**.unity` asset path, or REFUSE (exit 2) — never guess.
 *  - `unverifiableGestureScenes` (invariant #4): a touched scene that demonstrates a continuous gesture
 *    but carries no sampled phase signal cannot be graded honestly → emit it as can't-verify (exit 2),
 *    so a best-effort replay can never read it green.
 */

import { isScenePath } from "./profiles/types.js";
import { isContinuousGesture } from "../replay/gesture-recovery.js";
import { inferScenesFromTrace } from "./minigame-scene-inference.js";
import type { ReplayTrace, Segment } from "../replay/types.js";

// ── D5 — entry-scene resolution without `--scene` ────────────────────────────────

/** What the bridge reports about the editor's active scene: a runtime NAME and the saved asset PATH
 *  (absent/null when the scene is unsaved or has no on-disk asset). */
export interface ActiveSceneInfo {
  name?: string;
  /** The `Assets/**.unity` asset path, or null/undefined when the active scene isn't saved to disk. */
  assetPath?: string | null;
}

export type EntrySceneResolution =
  | { ok: true; scene: string; sceneName?: string }
  | { ok: false; exitCode: 2; message: string };

/** The single refusal message for an unresolvable entry scene — quoted so callers stay consistent. */
export const ENTRY_SCENE_REFUSAL =
  "can't verify current scene; save/open the intended entry scene or pass --scene";

/**
 * Resolve the entry scene for a no-`--scene` invocation (D5). Replay resets via `scene.open_scene`,
 * which needs a real `Assets/**.unity` path, so an unsaved / path-less active scene is a REFUSAL
 * (exit 2) — never a bare runtime name stored as `trace.start.scene`. The runtime name is returned
 * separately as evidence for inference/reporting. Pure: the caller supplies what the bridge reported.
 */
export function resolveEntryScene(active: ActiveSceneInfo | null | undefined): EntrySceneResolution {
  const path = active?.assetPath;
  if (!isScenePath(path)) {
    return { ok: false, exitCode: 2, message: ENTRY_SCENE_REFUSAL };
  }
  return { ok: true, scene: path, sceneName: active?.name };
}

/** The minimal bridge surface the active-scene query needs — the live `UnityDriver.op` satisfies it, and
 *  a fake satisfies it in tests (so the no-`--scene` resolution is unit-testable without an editor). */
export interface SceneQueryDriver {
  op(
    opName: string,
    params: Record<string, unknown>,
  ): Promise<{ error: string } | { data: Record<string, unknown> }>;
}

/**
 * Query the editor's ACTIVE scene over the bridge (`scene.get_active`) and resolve it to an entry scene
 * for the no-`--scene` flow, or a refusal (exit 2). A bridge error is itself a can't-verify — we can't
 * read the current scene, so we never guess. The C# op returns `scene_path: null` for an unsaved scene,
 * which `resolveEntryScene` turns into the standard refusal.
 */
export async function resolveActiveEntryScene(driver: SceneQueryDriver): Promise<EntrySceneResolution> {
  const res = await driver.op("scene.get_active", {});
  if ("error" in res) {
    return { ok: false, exitCode: 2, message: `${ENTRY_SCENE_REFUSAL} (bridge error: ${res.error})` };
  }
  const d = res.data;
  return resolveEntryScene({
    name: typeof d.scene_name === "string" ? d.scene_name : undefined,
    assetPath: typeof d.scene_path === "string" ? d.scene_path : null,
  });
}

/**
 * Resolve a runtime scene NAME to its saved `Assets/**.unity` asset path via the bridge
 * (`scene.find_by_name`), for the per-scene scan loop. Returns null when the name can't be safely
 * resolved — NOT found (match_count 0), AMBIGUOUS (>1 same-named scene asset, so the bridge returns a
 * null path), an unsafe path, or a bridge error. A null is a can't-verify for that scene (the caller
 * never guesses which scene to open). This is the `SceneScanDeps.resolveScenePath` impl.
 */
export async function resolveScenePathByName(driver: SceneQueryDriver, sceneName: string): Promise<string | null> {
  const res = await driver.op("scene.find_by_name", { name: sceneName });
  if ("error" in res) return null;
  const path = res.data.scene_path;
  return typeof path === "string" && isScenePath(path) ? path : null;
}

// ── Invariant #4 — a gesture scene with no sampled signal is can't-verify ─────────

/** The recorder's sampled state-signal gate kind. `observe.ts` grafts this gate into the SAME segment as
 *  the gesture it gates (precondition: wait for the phase to reach the consumable value before actuating),
 *  so a gesture is "covered" by a signal only when its OWN segment carries the gate — never merely by a
 *  gate elsewhere in the scene. Binding per-segment (not per-scene) is what keeps an unrelated wait from
 *  laundering an ungradeable gesture into "verifiable" (the absent-binding-bypass anti-pattern). */
const STATE_SIGNAL_GATE = "wait-for-condition";

export interface UnverifiableScene {
  /** The runtime scene NAME (e.g. `StarChef`), as carried on the trace — NOT an asset path. */
  sceneName: string;
  reason: string;
}

const segmentHasContinuousGesture = (seg: Segment): boolean => seg.actions.some((a) => isContinuousGesture(a));

/** A continuous gesture is signal-covered only by a state-signal gate in its OWN segment (per the
 *  recorder's gate+gesture-in-one-segment structure). */
const segmentHasSignalGate = (seg: Segment): boolean => seg.actions.some((a) => a.do === STATE_SIGNAL_GATE);

/**
 * Invariant #4 (Phase 1): a touched scene that demonstrates a CONTINUOUS gesture (a stir/scrub whose
 * effect is travel-accumulation — `travelPx > 0`) where that gesture's segment carries NO sampled
 * state-signal gate cannot be verified honestly. Replay would re-drive the gesture blind with no phase
 * signal to close the loop, so a best-effort run could read green when the game actually stalled. Phase 1
 * supports a single signalled gesture scene; every OTHER gesture scene whose gesture is unsignalled is
 * returned here for the runner to emit as can't-verify (exit 2) before any best-effort replay.
 *
 * The signal binding is PER-SEGMENT, not per-scene: the gate must sit in the gesture's own segment (the
 * structure `observe.ts` produces), so a stray `wait-for-condition` elsewhere in the scene — or in another
 * segment advancing a different phase — can never launder the gesture into "verifiable" (the HIGH from
 * review). A scene is unverifiable if ANY of its continuous-gesture segments lacks its own signal gate.
 *
 * Pure + evidence-driven: a scene only counts when the trace carries per-segment scene evidence (1a). A
 * single-scene trace (no evidence) is governed by the existing single-signal flow and returns `[]` — this
 * predicate never changes single-scene behavior. Scenes are returned in first-touch order, once each.
 */
export function unverifiableGestureScenes(trace: Pick<ReplayTrace, "segments" | "start">): UnverifiableScene[] {
  if (!inferScenesFromTrace(trace).hasEvidence) return [];

  const order: string[] = [];
  const unverifiable = new Set<string>();
  for (const seg of trace.segments ?? []) {
    const scene = (seg as { scene?: unknown }).scene;
    if (typeof scene !== "string" || scene.length === 0) continue;
    if (!order.includes(scene)) order.push(scene);
    // An unsignalled continuous-gesture segment makes its scene unverifiable (its own segment must gate it).
    if (segmentHasContinuousGesture(seg) && !segmentHasSignalGate(seg)) unverifiable.add(scene);
  }

  return order
    .filter((scene) => unverifiable.has(scene))
    .map((sceneName) => ({
      sceneName,
      reason:
        "demonstrates a continuous gesture whose segment carries no sampled phase signal — replay can't close the loop on this scene (can't verify; exit 2). Declare a state signal for this scene or verify it separately.",
    }));
}
