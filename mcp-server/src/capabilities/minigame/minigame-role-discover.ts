/**
 * Mini-game role discovery (S8a).
 *
 * Advisory scan core for `loombridge minigame scan`: inspect a live scene's
 * full-screen UI rect dump and propose the real controls/text objects a developer
 * can adopt into a contract draft. This is deliberately suggest-only; it never
 * binds evidence to a verdict and never changes gate behavior.
 */

import type { BridgeResponse } from "../../types.js";
import type { BridgeSend } from "../replay/unity-driver.js";
import {
  AGE_BANDS,
  VISUAL_PROFILES,
  type MinigameContract,
  type MinigameState,
  type MinigameObjectRef,
} from "./profiles/types.js";
import { assertValidMinigameContract } from "./profiles/validator.js";
import { sceneSlug } from "./minigame-scene-inference.js";
import {
  actionLocatorPath,
  assignObjectIds,
  objectIdFromPath,
  type RawScreenObject,
  type RawScreenRects,
} from "./minigame-capture-plan.js";
import type { BackgroundCandidates } from "./types.js";
import type { Action, ReplayTrace } from "../replay/types.js";

/** Full-frame/backdrop convention shared with the safe-area sweep heuristics. */
export const SWEEP_BACKDROP_AREA = 0.85;

export interface RoleCandidate {
  id: string;
  locator: string;
  name: string;
  role: string;
}

export interface RoleCandidates {
  controls: RoleCandidate[];
  texts: RoleCandidate[];
  /**
   * Measured live GameView aspect (width / height) from the `ui.get_screen_rects`
   * viewport, when available. Advisory only — used to infer the draft's
   * `visualProfile`; absent/zero falls back to the default profile.
   */
  viewportAspect?: number;
}

/** The default draft visual profile when the live aspect is unknown/unusable. */
export const DEFAULT_VISUAL_PROFILE = "phone-portrait";

/**
 * Pick the visual profile id whose target aspect ratio is closest to a measured
 * live aspect (width / height). Refuse-to-guess: a missing/zero/NaN/negative
 * aspect returns the safe default profile rather than a fabricated guess.
 */
export function nearestVisualProfile(aspect: number): string {
  if (!Number.isFinite(aspect) || aspect <= 0) return DEFAULT_VISUAL_PROFILE;
  let best = DEFAULT_VISUAL_PROFILE;
  let bestDelta = Number.POSITIVE_INFINITY;
  for (const profile of Object.values(VISUAL_PROFILES)) {
    const delta = Math.abs(profile.aspectRatio - aspect);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = profile.id;
    }
  }
  return best;
}

export interface StateCluster {
  container: string;
  objectIds: string[];
  kind: "active" | "success_reward";
}

export interface DraftContractOptions {
  panelOrder?: string[];
  backgroundCandidates?: BackgroundCandidates;
  /** Visual profile id for the draft (one of VISUAL_PROFILES). Default "phone-portrait". */
  visualProfile?: string;
  /**
   * The recorded demonstration. When present, panels the human DEMONSTRABLY used
   * (their control locators are in the trace) but that the static scene scan could
   * not see — because they were INACTIVE at scene-load (e.g. StarChef's decorate
   * screen) — are added as DRAFT candidate states. Propose-only: derived states are
   * suggestions the dev confirms; they never touch the verify verdict.
   */
  trace?: ReplayTrace;
  /**
   * Auto-detected `stateSignal` (a phase/state enum on a manager component). When present it is
   * written onto the draft so a multi-screen/gesture game phase-aligns with zero hand-editing —
   * `minigame next`/`check` thread it into the printed `--state-signal` record flag. Advisory:
   * absent ⇒ no signal (the G6 note nudges a manual declaration). Never affects the verdict.
   */
  stateSignal?: { locator: string; component?: string; property: string };
}

function rawPath(raw: RawScreenObject): string {
  if (typeof raw.locator === "string") return raw.locator;
  if (raw.locator && typeof raw.locator.path === "string") return raw.locator.path;
  return raw.name ? `/${raw.name}` : "";
}

function viewportArea(raw: RawScreenObject): number {
  const rect = raw.viewportRect;
  const width = rect && typeof rect.width === "number" && Number.isFinite(rect.width) ? rect.width : 0;
  const height = rect && typeof rect.height === "number" && Number.isFinite(rect.height) ? rect.height : 0;
  return Math.max(0, width) * Math.max(0, height);
}

function isContainer(raw: RawScreenObject): boolean {
  return raw.role === "container";
}

function candidateFrom(raw: RawScreenObject, id: string): RoleCandidate {
  const locator = rawPath(raw);
  return {
    id,
    locator,
    name: raw.name ?? locator.split("/").filter(Boolean).at(-1) ?? id,
    role: raw.role ?? "unknown",
  };
}

function hasNonEmptyText(raw: RawScreenObject): boolean {
  return typeof raw.text === "string" && raw.text.trim().length > 0;
}

function eligible(raw: RawScreenObject): boolean {
  if (raw.isVisible !== true) return false;
  if (isContainer(raw)) return false;
  if (viewportArea(raw) >= SWEEP_BACKDROP_AREA) return false;
  return rawPath(raw).length > 0;
}

/**
 * Pure classifier over a `ui.get_screen_rects` dump. Controls are visible
 * raycast-target non-containers; text candidates are visible non-container objects
 * with non-empty text. Large full-frame backdrops are excluded from both sets.
 */
export function classifyRoleCandidates(rects: RawScreenRects): RoleCandidates {
  const objects = rects.objects ?? [];
  const candidateObjects = objects.filter(eligible);
  const idMap = assignObjectIds(candidateObjects.map(rawPath));
  const idFor = (raw: RawScreenObject): string => idMap.get(rawPath(raw)) ?? objectIdFromPath(rawPath(raw));

  return {
    controls: candidateObjects
      .filter((raw) => raw.raycastTarget === true)
      .map((raw) => candidateFrom(raw, idFor(raw))),
    texts: candidateObjects
      .filter(hasNonEmptyText)
      .map((raw) => candidateFrom(raw, idFor(raw))),
  };
}

function dataOrNull(res: BridgeResponse): Record<string, unknown> | null {
  if (res.status === "error") return null;
  return (res.data ?? {}) as Record<string, unknown>;
}

/**
 * Online shell: ask the bridge for a full-scene UI rect dump and classify it.
 * Discovery is advisory and defensive; odd/missing scenes return empty sets.
 */
export async function discoverRoleCandidates(send: BridgeSend): Promise<RoleCandidates> {
  try {
    const data = dataOrNull(await send("ui.get_screen_rects", {}));
    if (!data) return { controls: [], texts: [] };
    const rects = data as RawScreenRects;
    const candidates = classifyRoleCandidates(rects);
    const aspect = rects.viewport?.aspect;
    if (typeof aspect === "number") candidates.viewportAspect = aspect;
    return candidates;
  } catch {
    return { controls: [], texts: [] };
  }
}

function locatorPath(locator: string): string {
  const colon = locator.indexOf(":");
  return colon >= 0 ? locator.slice(colon + 1) : locator;
}

function pathSegments(locator: string): string[] {
  return locatorPath(locator).split("/").filter(Boolean);
}

function panelFromLocator(locator: string): string | null {
  const segments = pathSegments(locator);
  return segments.length >= 3 ? segments[1] : null;
}

function isDepth2(locator: string): boolean {
  return pathSegments(locator).length === 2;
}

function uniq(values: Iterable<string>): string[] {
  return [...new Set(values)];
}

const DECORATIVE_PANEL_RE = /hint|fx|layer|overlay|drag/i;
const SUCCESS_RE = /playagain|play-again|replay|again|home ?pill|finish|well ?done|reward/i;
const INTERACTIVE_LOOKING_RE = /button|btn|tap|drag|drop|control|answer|choice|ingredient|target|zone|pill|play|done|finish|home|back|next|start|power/i;
const STATE_SUFFIX_RE = /(panel|screen|group|root|container)$/i;

function candidateKey(candidate: RoleCandidate): string {
  return `${candidate.id} ${candidate.name} ${candidate.role}`.toLowerCase();
}

function isInteractiveLooking(candidate: RoleCandidate, controlIds: Set<string>): boolean {
  return controlIds.has(candidate.id) || INTERACTIVE_LOOKING_RE.test(candidateKey(candidate));
}

function isSuccessCandidate(candidate: RoleCandidate): boolean {
  return SUCCESS_RE.test(candidateKey(candidate));
}

function stateIdFromContainer(container: string): string {
  const stripped = container.replace(STATE_SUFFIX_RE, "") || container;
  const words = stripped
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return "active";
  const camel = words
    .map((word, i) => {
      const lower = word.toLowerCase();
      return i === 0 ? lower : lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join("");
  return camel === "decor" ? "decorate" : camel;
}

/**
 * Cluster discovered controls/text by their screen container. Depth-2 controls
 * under the root Canvas are persistent chrome and are merged into every screen
 * cluster. Decorative/hint-only panel clusters are dropped conservatively.
 */
export function segmentStates(candidates: RoleCandidates, opts: { order?: string[] } = {}): StateCluster[] {
  const all = [...candidates.controls, ...candidates.texts];
  const controlIds = new Set(candidates.controls.map((c) => c.id));
  const byId = new Map<string, RoleCandidate>();
  for (const c of all) if (!byId.has(c.id)) byId.set(c.id, c);

  const chromeIds = candidates.controls
    .filter((c) => isDepth2(c.locator))
    .map((c) => c.id);
  const panelOrder: string[] = [];
  const grouped = new Map<string, string[]>();
  for (const candidate of all) {
    const panel = panelFromLocator(candidate.locator);
    if (!panel) continue;
    if (!grouped.has(panel)) {
      grouped.set(panel, []);
      panelOrder.push(panel);
    }
    grouped.get(panel)!.push(candidate.id);
  }

  const kept = panelOrder
    .map((panel) => {
      const ids = uniq(grouped.get(panel) ?? []);
      const members = ids.map((id) => byId.get(id)).filter((c): c is RoleCandidate => c !== undefined);
      if (DECORATIVE_PANEL_RE.test(panel)) return null;
      if (members.length === 1 && !isInteractiveLooking(members[0], controlIds)) return null;
      return { panel, ids, members };
    })
    .filter((c): c is { panel: string; ids: string[]; members: RoleCandidate[] } => c !== null);

  let successPanel: string | undefined;
  for (const cluster of kept) {
    if (cluster.members.some(isSuccessCandidate)) {
      successPanel = cluster.panel;
      break;
    }
  }

  const orderIndex = new Map((opts.order ?? []).map((panel, i) => [panel, i]));
  const encounterIndex = new Map(panelOrder.map((panel, i) => [panel, i]));
  kept.sort((a, b) => {
    const aSuccess = a.panel === successPanel;
    const bSuccess = b.panel === successPanel;
    if (aSuccess !== bSuccess) return aSuccess ? 1 : -1;
    const ai = orderIndex.has(a.panel) ? orderIndex.get(a.panel)! : Number.POSITIVE_INFINITY;
    const bi = orderIndex.has(b.panel) ? orderIndex.get(b.panel)! : Number.POSITIVE_INFINITY;
    if (ai !== bi) return ai - bi;
    return (encounterIndex.get(a.panel) ?? 0) - (encounterIndex.get(b.panel) ?? 0);
  });

  return kept.map((cluster) => ({
    container: cluster.panel,
    objectIds: uniq([...cluster.ids, ...chromeIds]),
    kind: cluster.panel === successPanel ? "success_reward" : "active",
  }));
}

function isPanelAction(action: Action): boolean {
  return action.do === "tap" || action.do === "drag";
}

/**
 * Every hierarchy path a tap/drag action touches. A tap contributes its `locator`;
 * a drag contributes BOTH its `from` (the picked-up control) and `to` (the drop
 * target), since the human demonstrably interacted with each. Used both to order
 * panels (`panelVisitOrder`) and to derive a thin requiredInFrame roster for a
 * trace-only state (`tracePanels`).
 */
function actionTouchedPaths(action: Action): string[] {
  if (action.do === "tap") return action.locator?.path ? [action.locator.path] : [];
  if (action.do === "drag") {
    return [action.from?.path, action.to?.path].filter((p): p is string => typeof p === "string" && p.length > 0);
  }
  return [];
}

/** Derive first-touch panel order from a demonstration trace. */
export function panelVisitOrder(trace: ReplayTrace): string[] {
  const order: string[] = [];
  const seen = new Set<string>();
  for (const segment of trace.segments) {
    for (const action of segment.actions) {
      if (!isPanelAction(action)) continue;
      const path = actionLocatorPath(action);
      if (!path) continue;
      const panel = panelFromLocator(path);
      if (!panel || seen.has(panel)) continue;
      seen.add(panel);
      order.push(panel);
    }
  }
  return order;
}

/**
 * Reorder a contract's `states` (and `interactionFlow.happyPath`) to the order the human actually
 * PLAYED them, derived from the demonstration trace (G5). The bootstrap `scan` (no trace yet) orders
 * states by static scene-hierarchy encounter — which can be backwards (StarChef: decorate-first), so
 * the flow tier then grades phantom transitions (decorate→mix). Once a trace exists this re-derives
 * the true order from first-touch panel visits; the per-screen checks are order-independent, so this
 * only fixes the flow pairing. A pure permutation — never adds/drops a state. Returns the SAME object
 * (no change) when the trace yields no panel order or the order already matches.
 *
 * Ranking: by the panel's first-touch index in the trace; a `success_reward` state always LAST
 * (the reward screen is the terminal, even if its panel was touched mid-play); a state whose panel
 * never appears in the trace keeps its relative position after the known ones (stable).
 */
export function reorderStatesByTrace(contract: MinigameContract, trace: ReplayTrace): MinigameContract {
  const order = panelVisitOrder(trace);
  if (order.length === 0) return contract;
  // Only reorder a scan-fresh happyPath (one entry per state, in state order) — the bootstrap writes
  // exactly that. A hand-edited happyPath (a subset, or a legitimate repeat like menu→play→menu) is the
  // dev's intent; silently rebuilding it as the full single-occurrence list would add/drop graded
  // transitions. Leave it untouched rather than guess. (Never a moat issue — only avoids a surprise.)
  const scanFresh =
    contract.interactionFlow.happyPath.length === contract.states.length &&
    contract.interactionFlow.happyPath.every((id, i) => id === contract.states[i]?.id);
  if (!scanFresh) return contract;
  const locById = new Map(contract.requiredInFrame.map((r) => [r.id, r.locator]));
  const panelOf = (state: MinigameState): string | null => {
    const counts = new Map<string, number>();
    for (const id of state.requiredInFrame ?? []) {
      const panel = panelFromLocator(locById.get(id) ?? "");
      if (panel) counts.set(panel, (counts.get(panel) ?? 0) + 1);
    }
    let best: string | null = null;
    let bestN = 0;
    for (const [panel, n] of counts) if (n > bestN) { best = panel; bestN = n; }
    return best;
  };
  const UNKNOWN = order.length + 1;
  const rank = (state: MinigameState): number => {
    if (state.kind === "success_reward") return order.length + 2; // terminal, always last (within its scene)
    const panel = panelOf(state);
    const i = panel ? order.indexOf(panel) : -1;
    return i >= 0 ? i : UNKNOWN;
  };
  // Multi-scene (D3): group states by scene in first-touch order so a per-scene reorder never
  // INTERLEAVES scenes (a hub's reward must stay before the game's screens, not sink behind them via
  // the global success-last rule). Within a scene the panel-visit `rank` applies. Single-scene
  // (sceneOrder < 2) leaves the sort byte-identical to the pre-D3 behaviour.
  const sceneOrder: string[] = [];
  {
    const seen = new Set<string>();
    for (const seg of trace.segments) {
      const sc = (seg as { scene?: unknown }).scene;
      if (typeof sc !== "string" || sc.length === 0) continue;
      const sl = sceneSlug(sc);
      if (!seen.has(sl)) { seen.add(sl); sceneOrder.push(sl); }
    }
  }
  const stateSceneSlugs = new Set(contract.states.map((s) => (s.scene ? sceneSlug(s.scene) : "")).filter((x) => x.length > 0));
  const multiScene = sceneOrder.length >= 2 && stateSceneSlugs.size >= 2;
  const sceneRank = (state: MinigameState): number => {
    const sl = state.scene ? sceneSlug(state.scene) : undefined;
    const i = sl ? sceneOrder.indexOf(sl) : -1;
    return i >= 0 ? i : sceneOrder.length; // an unvisited/unset scene sorts after the known ones
  };
  const reordered = contract.states
    .map((state, idx) => ({ state, idx, rank: rank(state), scene: sceneRank(state) }))
    .sort((a, b) => {
      if (multiScene && a.scene !== b.scene) return a.scene - b.scene;
      return a.rank !== b.rank ? a.rank - b.rank : a.idx - b.idx; // stable within equal rank
    })
    .map((x) => x.state);
  const sameOrder = reordered.every((s, i) => s === contract.states[i]);
  if (sameOrder) return contract;
  return {
    ...contract,
    states: reordered,
    interactionFlow: { ...contract.interactionFlow, happyPath: reordered.map((s) => s.id) },
  };
}

/** A panel the human interacted with during the demonstration. */
interface TracePanel {
  /** The panel container name (path segment[1]), in first-touch order. */
  panel: string;
  /** Distinct hierarchy paths of the controls touched under this panel, in touch order. */
  paths: string[];
}

/**
 * Panels referenced by the trace's tap/drag action locators, in first-touch order,
 * each with the distinct control paths the human touched there. A drag contributes
 * both endpoints (`from`/`to`). This is what lets `scan` propose a state for a panel
 * that was INACTIVE at scene-load (invisible to the static scan) but demonstrably used.
 */
function tracePanels(trace: ReplayTrace): TracePanel[] {
  const byPanel = new Map<string, string[]>();
  const order: string[] = [];
  for (const segment of trace.segments) {
    for (const action of segment.actions) {
      if (!isPanelAction(action)) continue;
      for (const path of actionTouchedPaths(action)) {
        const panel = panelFromLocator(path);
        if (!panel) continue;
        let paths = byPanel.get(panel);
        if (!paths) {
          paths = [];
          byPanel.set(panel, paths);
          order.push(panel);
        }
        if (!paths.includes(path)) paths.push(path);
      }
    }
  }
  return order.map((panel) => ({ panel, paths: byPanel.get(panel) ?? [] }));
}

function titleFromId(id: string): string {
  return id
    .split("-")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function objectRefs(candidates: RoleCandidates): MinigameObjectRef[] {
  const refs = new Map<string, MinigameObjectRef>();
  const add = (candidate: RoleCandidate, description: string): void => {
    if (refs.has(candidate.id)) return;
    refs.set(candidate.id, {
      id: candidate.id,
      locator: candidate.locator,
      description,
    });
  };
  for (const c of candidates.controls) add(c, `Discovered tappable control (${c.name}).`);
  for (const t of candidates.texts) add(t, `Discovered text label (${t.name}).`);
  return [...refs.values()];
}

/**
 * Build a schema-valid draft contract from discovered candidates. The active state
 * binds the real discovered roster; `success_reward` is a placeholder state so the
 * existing flow validator's reward requirement stays intact until S8b derives the
 * real state model from a demonstration.
 */
export function draftContractFromCandidates(
  id: string,
  scene: string,
  candidates: RoleCandidates,
  opts: DraftContractOptions = {},
): MinigameContract {
  const requiredInFrame = objectRefs(candidates);
  const clusters = segmentStates(candidates, { order: opts.panelOrder });
  const hasReward = clusters.some((c) => c.kind === "success_reward");
  const useSegmentedStates = clusters.length >= 2 && hasReward;
  const activeRefs = requiredInFrame.map((r) => r.id);
  const bandFloor = AGE_BANDS["5-7"].minTapTargetDp;
  const usedStateIds = new Set<string>();
  const uniqueStateId = (base: string): string => {
    const cleaned = base || "active";
    let id = cleaned;
    let suffix = 2; // contiguous numbering: game, game-2, game-3 (uniqueness via usedStateIds)
    while (usedStateIds.has(id)) {
      id = `${cleaned}-${suffix}`;
      suffix += 1;
    }
    usedStateIds.add(id);
    return id;
  };
  type DraftState = {
    id: string;
    kind: "active" | "success_reward";
    scene: string;
    requiredInFrame?: string[];
    description: string;
  };
  // The base (static-scan) states, exactly as before. Trace-derived states (below)
  // ONLY append to this when a demonstration is supplied; with no trace the output is
  // byte-identical to the pre-S8b behavior (the regression guard the reviewer checks).
  const staticStates: DraftState[] = useSegmentedStates
    ? clusters.map((cluster) => {
        const baseId = cluster.kind === "success_reward" ? "success_reward" : stateIdFromContainer(cluster.container);
        return {
          id: uniqueStateId(baseId),
          kind: cluster.kind,
          scene,
          requiredInFrame: cluster.objectIds,
          description: `DRAFT: discovered ${cluster.container} screen. Review/edit after recording a demonstration.`,
        };
      })
    : [
        {
          id: uniqueStateId("active"),
          kind: "active" as const,
          scene,
          requiredInFrame: activeRefs,
          description: "DRAFT: live-scanned screen roster. Refine after recording a demonstration.",
        },
        {
          id: uniqueStateId("success_reward"),
          kind: "success_reward" as const,
          scene,
          description: "TODO: replace with the actual reward/success screen from the demonstration.",
        },
      ];

  // S8b: propose DRAFT states for panels the human DEMONSTRABLY used but the static
  // scene scan could not see — panels INACTIVE at scene-load (e.g. StarChef's decorate
  // screen). Propose-only: these are suggestions the dev confirms via finalize; they
  // NEVER feed the verify verdict. A trace-only panel becomes its OWN new state — it is
  // never silently merged into, or used to drop/replace, an existing static state.
  //
  // OUT OF SCOPE here (deliberately left for later, NOT built):
  //  - `reached` (a per-state phase signal): the observer records no phase/component
  //    signal today, so there's nothing to derive — derived states leave `reached` UNSET.
  //  - A full requiredInFrame roster from rects: we don't have a trace-only panel's rects
  //    offline. A thin roster from the trace's action locators IS this slice; `finalize`
  //    binds real locators from the capture pack later.
  const traceDerived: DraftState[] = [];
  const derivedRefs: MinigameObjectRef[] = [];
  if (opts.trace) {
    // The depth-2 persistent chrome the static states receive (so derived states match).
    const chromeIds = candidates.controls.filter((c) => isDepth2(c.locator)).map((c) => c.id);
    // Panel containers already represented by a static cluster — never re-add these.
    const staticPanels = new Set(clusters.map((c) => c.container));
    const declaredRefIds = new Set(requiredInFrame.map((r) => r.id));
    for (const tp of tracePanels(opts.trace)) {
      if (staticPanels.has(tp.panel)) continue; // own-state rule: don't duplicate a static panel
      const idsForPaths = assignObjectIds(tp.paths);
      const panelRefIds: string[] = [];
      for (const p of tp.paths) {
        const objId = idsForPaths.get(p) ?? objectIdFromPath(p);
        if (!declaredRefIds.has(objId)) {
          declaredRefIds.add(objId);
          derivedRefs.push({
            id: objId,
            locator: p,
            description: `DRAFT: control used during the demonstration on the '${tp.panel}' screen (thin roster — finalize binds the real locator from the capture pack).`,
          });
        }
        if (!panelRefIds.includes(objId)) panelRefIds.push(objId);
      }
      const isSuccess = SUCCESS_RE.test(tp.panel);
      const baseId = isSuccess ? "success_reward" : stateIdFromContainer(tp.panel);
      traceDerived.push({
        id: uniqueStateId(baseId),
        kind: isSuccess ? "success_reward" : "active",
        scene,
        requiredInFrame: uniq([...panelRefIds, ...chromeIds]),
        description:
          `DRAFT: '${tp.panel}' screen discovered from the demonstration (not visible at scene-load); review and confirm.`,
      });
    }
  }

  // Order ALL states (static + trace-derived) by the demonstration's panel-visit order,
  // with success_reward last. With no trace, `traceDerived` is empty and we keep the
  // static order verbatim (byte-identical), so the sort below only runs when a trace exists.
  let states: DraftState[] = staticStates;
  if (opts.trace) {
    const order = panelVisitOrder(opts.trace);
    // Map each state to its panel for visit-order lookup. Static segmented states carry
    // their container as the panel; the fallback active/reward pair has no panel (kept in
    // place at the front). Derived states map back to their source panel via the base id.
    const visitIndex = new Map(order.map((panel, i) => [panel, i]));
    const panelOfCluster = new Map(
      clusters.map((c) => [c.kind === "success_reward" ? "success_reward" : stateIdFromContainer(c.container), c.container] as const),
    );
    const merged = [...staticStates, ...traceDerived];
    const baseIdOf = (s: DraftState): string => s.id.replace(/-\d+$/, "");
    const rank = (s: DraftState): number => {
      const base = baseIdOf(s);
      const panel = panelOfCluster.get(base);
      if (panel && visitIndex.has(panel)) return visitIndex.get(panel)!;
      if (visitIndex.has(base)) return visitIndex.get(base)!; // derived state id == panel-derived id
      return Number.POSITIVE_INFINITY; // unmapped (fallback active/reward) sinks to the end, before success
    };
    states = merged
      .map((s, i) => ({ s, i }))
      .sort((a, b) => {
        const aSuccess = a.s.kind === "success_reward";
        const bSuccess = b.s.kind === "success_reward";
        if (aSuccess !== bSuccess) return aSuccess ? 1 : -1; // success_reward LAST
        const ra = rank(a.s);
        const rb = rank(b.s);
        if (ra !== rb) return ra - rb;
        return a.i - b.i; // stable: preserve original (static-before-derived) order on ties
      })
      .map(({ s }) => s);
  }

  // Trace-only objects join the top-level roster so each derived state's requiredInFrame
  // ids resolve (the validator refuses a state ref absent from the declared list).
  requiredInFrame.push(...derivedRefs);

  const draft: MinigameContract = {
    schemaVersion: "1",
    id,
    type: "2d-kids-minigame",
    title: titleFromId(id),
    description: "DRAFT: generated from a live scene scan. Review/edit before capture and verify.",
    scenes: [scene],
    ageBand: "5-7",
    visualProfile: opts.visualProfile ?? DEFAULT_VISUAL_PROFILE,
    requiredInFrame,
    states,
    uiSafeAreas: {
      maxOverflowFraction: 0,
      insets: { top: 0.05, bottom: 0.05, left: 0.04, right: 0.04 },
    },
    tapTargets: {
      minSizeDp: Math.max(96, bandFloor),
    },
    interactionFlow: {
      happyPath: states.map((state) => state.id),
    },
    artifactThresholds: {
      maxBorderFraction: 0.02,
      maxUniformBorderFraction: 0.02,
      minContentCoverage: 0.9,
    },
    checks: {
      deterministic: ["required-in-frame", "safe-area", "safe-area-sweep", "tap-target-size", "console-clean", "interaction-flow"],
    },
  };

  if (opts.backgroundCandidates?.camera && opts.backgroundCandidates.recommended.length > 0) {
    draft.backgroundCamera = opts.backgroundCandidates.camera.locator;
    draft.backgroundLayers = opts.backgroundCandidates.recommended.map((layer) => layer.locator);
  }

  if (opts.stateSignal) {
    draft.stateSignal = opts.stateSignal.component
      ? { locator: opts.stateSignal.locator, component: opts.stateSignal.component, property: opts.stateSignal.property }
      : { locator: opts.stateSignal.locator, property: opts.stateSignal.property };
  }

  return assertValidMinigameContract(draft);
}
