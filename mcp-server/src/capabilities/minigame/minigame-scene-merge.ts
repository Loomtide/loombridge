/**
 * Multi-scene contract fusion (Phase 1 D2-A/D/E): namespace each per-scene scanned contract's generated
 * ids by its scene, then concatenate into ONE contract whose findings group per scene (D6).
 *
 * The danger this module guards against: a state/object id (`start`, `playButton`) can exist in two
 * scenes, so every id is scene-namespaced (`home__start`, `star-chef__playButton`) — and EVERY field
 * that REFERENCES an id must be rewritten in lockstep (interactionFlow state-ids, inputResponse/container
 * /mask object-ids, …). A missed reference field would be a silent mis-binding — the exact false-green the
 * MOAT exists to prevent. So `validateContractReferentialIntegrity` is run after the merge: any reference
 * that doesn't resolve to a declared id is a LOUD refusal, never a silent dangling pointer. Even if the
 * rename enumeration is incomplete, the validator catches it.
 *
 * Locators (`Scene:/Path`) are NOT namespaced — they are already scene-qualified, so concatenation keeps
 * each scene's locators correct. Only the abstract ids (and references to them) collide across scenes.
 */

import { sceneNamespacedId, sceneSlug } from "./minigame-scene-inference.js";
import type { MinigameContract, MinigameState, MinigameObjectRef } from "./profiles/types.js";

/** One scanned scene to fuse: its namespace prefix (a scene slug) + runtime scene name + the contract a
 *  per-scene `minigame scan` produced for it. */
export interface ScenePart {
  /** Scene slug used to namespace this scene's ids (`<prefix>__<id>`); from `planSceneAgnosticScan`. */
  prefix: string;
  /** Runtime scene name stamped onto each state for per-scene reporting (D6). */
  sceneName: string;
  contract: MinigameContract;
}

/** Apply a rename map to an id, leaving unknown ids untouched (so a non-id token in a mixed field —
 *  e.g. a scene PATH in `safeAreaExempt` — passes through unchanged). */
const renamed = (map: ReadonlyMap<string, string>, id: string): string => map.get(id) ?? id;

/**
 * Namespace every generated id in one scene's contract by `prefix`, rewriting the id AND every field that
 * references it, and stamp `scene` onto each state. Returns a new contract (input untouched). The two id
 * spaces are independent: STATE ids and OBJECT ids each get their own rename map.
 */
export function namespaceContract(part: ScenePart): MinigameContract {
  const c = part.contract;
  const ns = (id: string): string => sceneNamespacedId(part.prefix, id);

  // Build the rename maps from the DECLARATIONS (the id-owning lists), then apply everywhere.
  const stateRename = new Map<string, string>(c.states.map((s) => [s.id, ns(s.id)]));
  const objectRename = new Map<string, string>(
    [...c.requiredInFrame, ...(c.allowedOffscreen ?? [])].map((o) => [o.id, ns(o.id)]),
  );
  const obj = (id: string): string => renamed(objectRename, id);
  const st = (id: string): string => renamed(stateRename, id);

  const states: MinigameState[] = c.states.map((s) => ({
    ...s,
    id: st(s.id),
    scene: part.sceneName,
    ...(s.requiredInFrame ? { requiredInFrame: s.requiredInFrame.map(obj) } : {}),
    ...(s.inputResponse
      ? { inputResponse: { ...s.inputResponse, tap: obj(s.inputResponse.tap), observe: s.inputResponse.observe.map(obj) } }
      : {}),
  }));

  const objRefs = (list: MinigameObjectRef[]): MinigameObjectRef[] => list.map((o) => ({ ...o, id: obj(o.id) }));

  return {
    ...c,
    states,
    requiredInFrame: objRefs(c.requiredInFrame),
    ...(c.allowedOffscreen ? { allowedOffscreen: objRefs(c.allowedOffscreen) } : {}),
    interactionFlow: { ...c.interactionFlow, happyPath: c.interactionFlow.happyPath.map(st) },
    ...(c.containers
      ? { containers: c.containers.map((b) => ({ ...b, background: obj(b.background), ...(b.content ? { content: b.content.map(obj) } : {}) })) }
      : {}),
    ...(c.baseline?.masks ? { baseline: { ...c.baseline, masks: c.baseline.masks.map(obj) } } : {}),
    // safeAreaExempt holds object ids OR scene paths — rename only the ids (`renamed` leaves paths alone).
    ...(c.safeAreaExempt ? { safeAreaExempt: c.safeAreaExempt.map(obj) } : {}),
  };
}

/** A scaffold PLACEHOLDER outcome state: a `success_reward`/`home_back` with no bound objects (a pure
 *  TODO the scan emits as the fallback pair for a scene it couldn't segment). It has no real screen. */
const isPlaceholderOutcome = (s: MinigameState): boolean =>
  (s.kind === "success_reward" || s.kind === "home_back") && (s.requiredInFrame?.length ?? 0) === 0;

/**
 * Drop a non-terminal scene's PLACEHOLDER outcome states (see `isPlaceholderOutcome`) from both
 * `states` and `interactionFlow.happyPath`. A reward/return WITH bound objects (a real scanned screen)
 * is kept, and the terminal scene is never passed here — so this removes only the meaningless hub/
 * pass-through reward, never a real or recording-missed one. Returns a new contract (input untouched).
 */
function pruneNonTerminalPlaceholderOutcomes(c: MinigameContract): MinigameContract {
  const drop = new Set(c.states.filter(isPlaceholderOutcome).map((s) => s.id));
  if (drop.size === 0) return c;
  return {
    ...c,
    states: c.states.filter((s) => !drop.has(s.id)),
    interactionFlow: { ...c.interactionFlow, happyPath: c.interactionFlow.happyPath.filter((id) => !drop.has(id)) },
  };
}

const uniq = <T>(xs: readonly T[]): T[] => [...new Set(xs)];

/**
 * Fuse the per-scene parts (in scene order) into one multi-scene contract. The first part provides the
 * contract-level config (id, age band, visual profile, tap targets, safe areas, thresholds); the
 * id/object/flow lists are the namespaced concatenation; `scenes` and `checks` are unioned so a check any
 * scene needs runs for all. `id` is overridden to the workspace id. Throws if a referential-integrity
 * problem survives (a dangling reference ⇒ a missed rename ⇒ refuse, never ship a mis-bound contract).
 */
export function mergeSceneContracts(parts: ScenePart[], workspaceId: string): MinigameContract {
  if (parts.length === 0) throw new Error("mergeSceneContracts: no scenes to merge");
  // A non-terminal scene (a hub/pass-through the player only navigates THROUGH) has no reward/return
  // screen — but a per-scene scan that couldn't segment still emits the scaffold `active`+
  // `success_reward` fallback pair. That placeholder outcome (empty `requiredInFrame`, no real screen)
  // has no captureable frame, so capture honestly leaves it unreached and `finalize` would then refuse
  // on the "missing" screen. Drop such placeholders from every scene EXCEPT the terminal one — the
  // terminal scene's reward stays declared and enforced, so a recording that genuinely misses a real
  // reward still refuses (the MOAT holds; only the scaffold artifact is removed).
  const lastIdx = parts.length - 1;
  const namespaced = parts
    .map(namespaceContract)
    .map((c, i) => (i === lastIdx ? c : pruneNonTerminalPlaceholderOutcomes(c)));
  const base = namespaced[0];

  // CONTRACT-LEVEL SINGLETONS the fused contract can hold only ONE of. Silently keeping scene 0's would
  // drop scenes 2..N's value — a mis-binding the referential-integrity net can't catch (it isn't a
  // dangling reference). So REFUSE when the scenes disagree, rather than ship a stale singleton. A
  // game-wide value (one ageBand/visualProfile) and Phase 1's single state-signal (per-scene signals are
  // D1/Phase 2) make a conflict a genuine "can't fuse these scenes yet", not a silent green.
  const onlyOne = <T>(values: (T | undefined)[], key: (v: T) => string, label: string): T | undefined => {
    const distinct = new Map<string, T>();
    for (const v of values) if (v !== undefined) distinct.set(key(v), v);
    if (distinct.size > 1) {
      throw new Error(`mergeSceneContracts: scenes declare ${distinct.size} different ${label} — cannot fuse into one contract (Phase 1 supports a single ${label} across scenes).`);
    }
    return [...distinct.values()][0];
  };
  const ageBand = onlyOne(namespaced.map((c) => c.ageBand), (v) => v, "age band")!;
  const visualProfile = onlyOne(namespaced.map((c) => c.visualProfile), (v) => v, "visual profile")!;
  const stateSignal = onlyOne(namespaced.map((c) => c.stateSignal), (s) => `${s.locator}:${s.component ?? ""}:${s.property}`, "state signal");
  const backgroundCamera = onlyOne(namespaced.map((c) => c.backgroundCamera), (v) => v, "background camera");
  const baselineRef = onlyOne(namespaced.map((c) => c.baseline?.ref), (v) => v, "baseline ref");
  // baseline.masks COMPOSE across scenes — union the (already-namespaced) masks rather than drop them.
  const baseWithBaseline = namespaced.find((c) => c.baseline);
  const baselineMasks = uniq(namespaced.flatMap((c) => c.baseline?.masks ?? []));

  const merged: MinigameContract = {
    ...base,
    id: workspaceId,
    ageBand,
    visualProfile,
    scenes: uniq(namespaced.flatMap((c) => c.scenes)),
    states: namespaced.flatMap((c) => c.states),
    requiredInFrame: namespaced.flatMap((c) => c.requiredInFrame),
    allowedOffscreen: uniq(namespaced.flatMap((c) => c.allowedOffscreen ?? [])),
    interactionFlow: { happyPath: namespaced.flatMap((c) => c.interactionFlow.happyPath) },
    containers: namespaced.flatMap((c) => c.containers ?? []),
    backgroundLayers: uniq(namespaced.flatMap((c) => c.backgroundLayers ?? [])),
    safeAreaBackground: uniq(namespaced.flatMap((c) => c.safeAreaBackground ?? [])),
    safeAreaExempt: uniq(namespaced.flatMap((c) => c.safeAreaExempt ?? [])),
    checks: {
      deterministic: uniq(namespaced.flatMap((c) => c.checks.deterministic)),
      advisory: uniq(namespaced.flatMap((c) => c.checks.advisory ?? [])),
    },
    // Explicitly fuse the singletons (don't inherit scene 0's blindly from `...base`).
    ...(stateSignal ? { stateSignal } : { stateSignal: undefined }),
    ...(backgroundCamera ? { backgroundCamera } : { backgroundCamera: undefined }),
    ...(baselineRef
      ? { baseline: { ...baseWithBaseline!.baseline!, ref: baselineRef, masks: baselineMasks } }
      : { baseline: undefined }),
  };
  if (merged.stateSignal === undefined) delete merged.stateSignal;
  if (merged.backgroundCamera === undefined) delete merged.backgroundCamera;
  if (merged.baseline === undefined) delete merged.baseline;
  else if (merged.baseline.masks?.length === 0) delete merged.baseline.masks;
  // Drop empty optional arrays so the merged contract stays minimal / matches a single-scene shape.
  if (merged.allowedOffscreen?.length === 0) delete merged.allowedOffscreen;
  if (merged.containers?.length === 0) delete merged.containers;
  if (merged.backgroundLayers?.length === 0) delete merged.backgroundLayers;
  if (merged.safeAreaBackground?.length === 0) delete merged.safeAreaBackground;
  if (merged.safeAreaExempt?.length === 0) delete merged.safeAreaExempt;
  if (merged.checks.advisory?.length === 0) delete merged.checks.advisory;

  const problems = validateContractReferentialIntegrity(merged);
  if (problems.length > 0) {
    throw new Error(`mergeSceneContracts: referential integrity failed — ${problems.join("; ")}`);
  }
  return merged;
}

/**
 * Referential-integrity check for a (merged) contract: every id reference must resolve to a declared id,
 * and ids must be unique. Returns a list of problems (empty ⇒ sound). This is the MOAT net: a dangling
 * reference means a rewrite was missed, so the merge REFUSES rather than ship a silently mis-bound
 * contract. Reusable on any contract, not just merged ones.
 */
export function validateContractReferentialIntegrity(c: MinigameContract): string[] {
  const problems: string[] = [];
  const stateIds = c.states.map((s) => s.id);
  const objectIds = [...c.requiredInFrame, ...(c.allowedOffscreen ?? [])].map((o) => o.id);
  const stateSet = new Set(stateIds);
  const objectSet = new Set(objectIds);

  const dupes = (ids: string[]): string[] => {
    const seen = new Set<string>();
    const dup = new Set<string>();
    for (const id of ids) (seen.has(id) ? dup : seen).add(id);
    return [...dup];
  };
  for (const d of dupes(stateIds)) problems.push(`duplicate state id '${d}'`);
  for (const d of dupes(objectIds)) problems.push(`duplicate object id '${d}'`);

  const needState = (id: string, where: string): void => {
    if (!stateSet.has(id)) problems.push(`${where} references unknown state '${id}'`);
  };
  const needObject = (id: string, where: string): void => {
    if (!objectSet.has(id)) problems.push(`${where} references unknown object '${id}'`);
  };

  c.interactionFlow.happyPath.forEach((id, i) => needState(id, `interactionFlow.happyPath[${i}]`));
  for (const s of c.states) {
    const sceneName = s.scene;
    if (sceneName) {
      // A state's `scene` is the runtime NAME (`Home`) while `scenes` holds asset PATHS
      // (`Assets/Scenes/Home.unity`); reconcile via slug (the established name↔path bridge).
      const ok = c.scenes.some((sc) => sc === sceneName || sceneSlug(sc) === sceneSlug(sceneName));
      if (!ok) problems.push(`state '${s.id}' has scene '${sceneName}' not in contract scenes`);
    }
    for (const id of s.requiredInFrame ?? []) needObject(id, `state '${s.id}'.requiredInFrame`);
    if (s.inputResponse) {
      needObject(s.inputResponse.tap, `state '${s.id}'.inputResponse.tap`);
      for (const id of s.inputResponse.observe) needObject(id, `state '${s.id}'.inputResponse.observe`);
    }
  }
  for (const b of c.containers ?? []) {
    needObject(b.background, "containers.background");
    for (const id of b.content ?? []) needObject(id, "containers.content");
  }
  for (const id of c.baseline?.masks ?? []) needObject(id, "baseline.masks");
  return problems;
}
