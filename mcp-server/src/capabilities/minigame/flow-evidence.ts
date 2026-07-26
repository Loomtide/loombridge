/**
 * Interaction-flow evidence (S6d-1) — `<captures>/flow.json`.
 *
 * The per-state captures (`<state>.ui-rects.json`) are the BEFORE/AFTER state
 * snapshots; this file adds, per declared `happyPath` transition, the **actuation**
 * evidence — proof the input was honestly delivered. Records are written verbatim
 * from `unity_ui_dispatch_pointer`'s return (`actuated`/`handlerTarget` (locator)/
 * `raycastHit` (bool)/`handlersFired`), so the harness cannot fabricate a green: the flow gate
 * independently re-derives the outcome from the capture and treats partial/weak
 * evidence as a harness fault.
 *
 * Loading is refuse-on-absent: an absent/unparseable `flow.json` returns null,
 * which — when `interaction-flow` is enabled — makes every declared transition
 * `missing_evidence` (incomplete, never green, never a game defect).
 */

import fs from "node:fs/promises";
import path from "node:path";

/** One actuation record (a single dispatched input). For a multi-step transition, one per step. */
export interface FlowActuation {
  /** The bridge confirmed the input fired (`unity_ui_dispatch_pointer.actuated`). */
  actuated?: boolean;
  /**
   * The uGUI element whose handler accepted the event, as the bridge reports it —
   * a `Scene:/Path` locator OR a bare `/Path`. NOTE it is the object whose *handler*
   * fired, which for a click on a child (e.g. a Button's `Label`) is the PARENT
   * Button — i.e. legitimately an ANCESTOR of the declared leaf target. The flow
   * gate normalizes the locator and corroborates by ancestor/descendant path match.
   */
  handlerTarget?: string;
  /** Whether the screen-point raycast hit a UI graphic (bridge `raycastHit`, a boolean). */
  raycastHit?: boolean;
  /** The handler sequence that fired (e.g. `["pointerDown","pointerUp","pointerClick"]`). */
  handlersFired?: string[];
  /** For a `steps[]` entry: the element this step acted on (corroborated against handlerTarget/raycastHit). */
  target?: string;
  /**
   * The dispatch kind. `"tap"` (default when absent — back-compat with tap-only games) corroborates
   * the handler against `target` and needs a click signal. `"drag"` (StarChef-style gesture
   * transitions: stir / ingredient-to-zone / topping drops) fires `beginDrag/drag/endDrag` on the
   * dragged SOURCE, not a `pointerClick` on the drop target, so it corroborates against `source` and
   * accepts a drag signal instead.
   */
  kind?: "tap" | "drag";
  /** For a `"drag"` entry: the element the gesture began on (the dragged object) — what the bridge's handler fires on. */
  source?: string;
  /** Optional human label for a `steps[]` entry (e.g. the round number). */
  round?: number;
}

export interface FlowTrigger {
  /** Input mechanism. `ui-dispatch` = `unity_ui_dispatch_pointer` (the only kind this slice grades). */
  kind?: string;
  /** The declared element the transition acts on (the single-actuation target). */
  target?: string;
}

export interface FlowTransitionEvidence {
  from: string;
  to: string;
  trigger?: FlowTrigger;
  /** Single-click transitions: one actuation. */
  actuation?: FlowActuation;
  /** Multi-click transitions (e.g. answering N rounds): one actuation PER step — all must be honest. */
  steps?: FlowActuation[];
  /** Console snapshot during the transition — INFORMATIONAL only this slice (console-clean owns console health). */
  console?: { errorCount?: number };
}

export interface FlowEvidence {
  schemaVersion?: string;
  transitions: FlowTransitionEvidence[];
}

export const FLOW_EVIDENCE_FILE = "flow.json";

/**
 * Load `<captureDir>/flow.json`. Returns null when the file is absent or
 * unparseable (refuse-on-absent → the flow gate reports `missing_evidence`). A
 * present file with a non-array `transitions` degrades to an empty transition list
 * (every declared transition then reports `missing_evidence`), never a throw.
 */
export async function loadFlowEvidence(captureDir: string): Promise<FlowEvidence | null> {
  let parsed: Partial<FlowEvidence>;
  try {
    const raw = await fs.readFile(path.join(captureDir, FLOW_EVIDENCE_FILE), "utf-8");
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return {
    schemaVersion: typeof parsed.schemaVersion === "string" ? parsed.schemaVersion : undefined,
    transitions: Array.isArray(parsed.transitions) ? parsed.transitions : [],
  };
}
