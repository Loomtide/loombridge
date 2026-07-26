/**
 * Auto-detect a mini-game's `stateSignal` during `scan` (phase-2 of the hands-off flow).
 *
 * A multi-screen/gesture game needs a declared `stateSignal` (a MonoBehaviour phase enum,
 * e.g. `ChefGameManager.phase`) so `trace record --observe --state-signal …` can phase-align
 * each gesture and capture can label each screen. In phase-1 the dev declared it by hand
 * (G1-lite threaded it into the printed record command; G6 surfaced the note). Phase-2 removes
 * even that: scan walks the scene for a likely state-manager component with a public enum field
 * and writes the `stateSignal` into the draft, so the bootstrap's printed record command carries
 * `--state-signal` with zero hand-editing.
 *
 * Discovery is ADVISORY and conservative: we only emit a signal when a component has an enum
 * field whose NAME looks like a game phase/state (so a stray `Image.type` enum is never picked).
 * When nothing confident is found we emit nothing and the G6 note still nudges a manual declaration.
 * The result never touches the verify verdict — it only shapes the draft + the printed guidance.
 */

import type { BridgeSend } from "../replay/unity-driver.js";
import type { BridgeResponse } from "../../shared/types.js";

/** The declared shape `minigame next` threads into `--state-signal <locator>:<component>:<property>`. */
export interface StateSignalCandidate {
  /** Bare hierarchy path (no scene prefix, no `:`) — the validator's locator rule. */
  locator: string;
  /** Component type name (e.g. `ChefGameManager`). */
  component: string;
  /** The enum field's serialized path (e.g. `phase`) — what the recorder/wait_for_condition reads. */
  property: string;
  /** The enum's symbolic values (informational; not written to the contract). */
  enumValues: string[];
  /** Heuristic confidence; higher wins. */
  score: number;
}

/**
 * Common Unity/UI/render component type names whose enum fields are never a game phase
 * (`Image.type`, `Canvas.renderMode`, …). Skipping them cuts `component.describe` round-trips
 * and avoids false positives. A custom MonoBehaviour state-manager is never in this set.
 * (The phase/state NAME filter below is the real correctness guard; this is the fast path.)
 */
const BUILTIN_COMPONENTS = new Set(
  [
    "Transform", "RectTransform", "Canvas", "CanvasRenderer", "CanvasScaler", "GraphicRaycaster",
    "Image", "RawImage", "Text", "TextMeshProUGUI", "TextMeshPro", "TMP_Text", "Button", "Toggle",
    "ToggleGroup", "Slider", "Scrollbar", "ScrollRect", "Dropdown", "TMP_Dropdown", "InputField",
    "TMP_InputField", "Mask", "RectMask2D", "Selectable", "LayoutElement", "HorizontalLayoutGroup",
    "VerticalLayoutGroup", "GridLayoutGroup", "ContentSizeFitter", "AspectRatioFitter", "Outline",
    "Shadow", "PositionAsUV1", "EventTrigger", "EventSystem", "StandaloneInputModule",
    "InputSystemUIInputModule", "BaseInputModule", "Camera", "AudioSource", "AudioListener",
    "Light", "SpriteRenderer", "MeshRenderer", "MeshFilter", "SkinnedMeshRenderer", "Animator",
    "Animation", "ParticleSystem", "ParticleSystemRenderer", "Rigidbody", "Rigidbody2D",
    "BoxCollider", "BoxCollider2D", "CircleCollider2D", "PolygonCollider2D", "CapsuleCollider2D",
    "SphereCollider", "CapsuleCollider", "MeshCollider", "CompositeCollider2D", "LineRenderer",
    "TrailRenderer", "SortingGroup", "Grid", "Tilemap", "TilemapRenderer", "PlayerInput",
  ].map((s) => s.toLowerCase()),
);

/** A property descriptor as `component.describe` returns it. */
interface DescribedProperty {
  serializedPath?: unknown;
  displayName?: unknown;
  type?: unknown;
  enumValues?: unknown;
  /**
   * Whether the backing member is a PUBLIC instance field (newer bridges only). The recorder reads
   * the signal via public reflection, so a `false` here means the field is `[SerializeField] private`
   * — visible to `describe` but unreadable at record time → we must reject it. `undefined` (older
   * bridge that doesn't report it) ⇒ accept, falling back to the underscore/identifier guards.
   */
  publicField?: unknown;
}

/** A plain C# identifier — a top-level field the recorder can reflect by name (no `.`/`[]` nesting). */
const PLAIN_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** One object + one of its component type names — the unit a `component.describe` probe runs on. */
export interface ProbeTarget {
  locator: string;
  component: string;
}

/** Normalize a property name for matching: lower-cased, non-alphanumerics stripped (`Game Phase` → `gamephase`). */
function normalizeName(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Score an enum property as a game phase/state signal, or `null` if it doesn't look like one.
 * PURE — the heart of the heuristic, exhaustively unit-tested.
 *
 * - The PROPERTY name is the load-bearing signal: it must read as a phase/state (so a stray
 *   `Image.type`/`renderMode` enum scores `null`). `step`/`stage`/`screen`/`mode`/`status` only
 *   qualify when the COMPONENT also looks like a manager (avoids picking, say, a `mode` toggle).
 * - The COMPONENT name (manager/controller/director/game) is a confidence bonus, not a gate —
 *   a game may name its state-machine `Flow` or `Director`.
 * - A real state machine has ≥2 enum values; an underscore-prefixed serialized field (`_phase`)
 *   is rejected because the recorder reads the signal by PUBLIC reflection name, not the
 *   serialized path, so `_phase` would sample nothing.
 */
export function scoreStateSignalProperty(
  componentName: string,
  serializedPath: string,
  displayName: string,
  enumValues: string[],
): number | null {
  if (!Array.isArray(enumValues) || enumValues.length < 2) return null;
  // The recorder reflects the property by its PUBLIC member name, so it must be a plain top-level
  // identifier and not an underscore-prefixed private convention (`_phase`/`m_Phase`).
  if (serializedPath.startsWith("_")) return null;
  if (!PLAIN_IDENTIFIER.test(serializedPath)) return null; // nested/array path → unreadable by name

  const prop = normalizeName(serializedPath || displayName);
  const propAlt = normalizeName(displayName);
  const matches = (needle: string) => prop.includes(needle) || propAlt.includes(needle);

  let propScore: number;
  let weakFamily = false;
  if (prop === "phase" || prop === "gamephase" || propAlt === "phase") propScore = 6;
  else if (prop === "state" || prop === "gamestate" || propAlt === "state") propScore = 5;
  else if (matches("phase")) propScore = 5;
  else if (matches("state")) propScore = 4;
  else if (matches("step") || matches("stage") || matches("screen") || matches("mode") || matches("status") || matches("round")) {
    propScore = 2;
    weakFamily = true;
  } else return null;

  // The weak family (mode/step/stage/…) is easily a binary toggle (RGB/HSV, On/Off) rather than a
  // game phase — require ≥3 values so a real multi-screen state machine, not a 2-way switch, qualifies.
  if (weakFamily && enumValues.length < 3) return null;

  const comp = componentName.toLowerCase();
  let componentBonus = 0;
  if (comp.includes("manager")) componentBonus = 3;
  else if (comp.includes("controller")) componentBonus = 2;
  else if (comp.includes("director") || comp.includes("sequencer") || comp.includes("flow")) componentBonus = 2;
  else if (comp.includes("game")) componentBonus = 2;

  // Viability gate: a clear phase/state name stands alone; the weaker family (step/stage/mode/…)
  // only counts on a manager-ish component. Anything else is too weak to risk a false signal.
  const viable = propScore >= 4 || (propScore >= 2 && componentBonus >= 2);
  if (!viable) return null;

  return propScore + componentBonus;
}

/**
 * Pick the single best candidate, or undefined. PURE. Deterministic tie-break so the same scene
 * always yields the same signal: higher score → more enum values → shorter locator → lexicographic.
 */
export function pickStateSignal(candidates: StateSignalCandidate[]): StateSignalCandidate | undefined {
  if (candidates.length === 0) return undefined;
  return [...candidates].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.enumValues.length !== a.enumValues.length) return b.enumValues.length - a.enumValues.length;
    if (a.locator.length !== b.locator.length) return a.locator.length - b.locator.length;
    return a.locator < b.locator ? -1 : a.locator > b.locator ? 1 : 0;
  })[0];
}

function dataOf(res: BridgeResponse): Record<string, unknown> | null {
  if (res.status === "error") return null;
  return (res.data ?? {}) as Record<string, unknown>;
}

/** Walk the `scene.get_hierarchy` tree into (locator, component) probe targets, skipping built-ins. */
export function flattenProbeTargets(hierarchy: unknown): ProbeTarget[] {
  const targets: ProbeTarget[] = [];
  const seen = new Set<string>();
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const n = node as { locator?: { path?: unknown }; components?: unknown; children?: unknown };
    const pathRaw = n.locator?.path;
    const path = typeof pathRaw === "string" ? pathRaw : "";
    if (path && !path.includes(":") && Array.isArray(n.components)) {
      for (const c of n.components) {
        if (typeof c !== "string") continue;
        if (BUILTIN_COMPONENTS.has(c.toLowerCase())) continue;
        const key = `${path}::${c}`;
        if (seen.has(key)) continue;
        seen.add(key);
        targets.push({ locator: path, component: c });
      }
    }
    if (Array.isArray(n.children)) for (const child of n.children) visit(child);
  };
  const root = hierarchy as { scenes?: unknown };
  const scenes = Array.isArray(root?.scenes) ? root.scenes : [];
  for (const scene of scenes) {
    const roots = (scene as { rootObjects?: unknown })?.rootObjects;
    if (Array.isArray(roots)) for (const r of roots) visit(r);
  }
  return targets;
}

/** Extract every viable enum-phase candidate from a `component.describe` property list. */
export function candidatesFromProperties(target: ProbeTarget, properties: unknown): StateSignalCandidate[] {
  if (!Array.isArray(properties)) return [];
  const out: StateSignalCandidate[] = [];
  for (const raw of properties) {
    const p = raw as DescribedProperty;
    if (p?.type !== "enum") continue;
    // A newer bridge reports `publicField`; an explicit `false` means a [SerializeField] private enum
    // the recorder can't read by public reflection — reject. `undefined` (older bridge) falls through
    // to the underscore/identifier guards in the scorer.
    if (p.publicField === false) continue;
    const serializedPath = typeof p.serializedPath === "string" ? p.serializedPath : "";
    const displayName = typeof p.displayName === "string" ? p.displayName : "";
    const enumValues = Array.isArray(p.enumValues) ? p.enumValues.filter((v): v is string => typeof v === "string") : [];
    const property = serializedPath || displayName;
    if (!property) continue;
    const score = scoreStateSignalProperty(target.component, serializedPath, displayName, enumValues);
    if (score === null) continue;
    out.push({ locator: target.locator, component: target.component, property, enumValues, score });
  }
  return out;
}

/**
 * Online shell: ask the bridge for the scene hierarchy, probe each non-built-in component for a
 * phase/state enum, and return the single best `stateSignal` (or undefined). Advisory + defensive:
 * any bridge hiccup yields undefined so scan still emits its draft (the G6 note then nudges).
 *
 * `maxProbes` caps `component.describe` round-trips for a huge scene (the manager is found early
 * in practice; this is a safety valve). If it ever truncates we log it, so a missed signal in a
 * very large scene reads as "we stopped looking", not a false "none exists".
 */
export async function discoverStateSignalCandidate(
  send: BridgeSend,
  maxProbes = 200,
): Promise<StateSignalCandidate | undefined> {
  try {
    const data = dataOf(await send("scene.get_hierarchy", { depth: -1 }, 15000));
    if (!data) return undefined;
    const allTargets = flattenProbeTargets(data);
    if (allTargets.length > maxProbes) {
      console.error(
        `[loombridge minigame] stateSignal: scanned the first ${maxProbes} of ${allTargets.length} custom components ` +
          "for a phase enum; if none was detected, declare the stateSignal in the draft by hand.",
      );
    }
    const targets = allTargets.slice(0, maxProbes);
    const found: StateSignalCandidate[] = [];
    for (const target of targets) {
      let described: Record<string, unknown> | null;
      try {
        described = dataOf(await send("component.describe", { locator: { path: target.locator }, type_name: target.component }, 8000));
      } catch {
        continue; // one component's describe failing never aborts discovery
      }
      if (!described) continue;
      found.push(...candidatesFromProperties(target, described.properties));
    }
    return pickStateSignal(found);
  } catch {
    return undefined;
  }
}
