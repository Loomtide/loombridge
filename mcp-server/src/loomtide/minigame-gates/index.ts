/**
 * Mini-game UI gates (S6c-1) — public surface.
 *
 * Standalone deterministic UI/visual gates for a `MinigameContract`, graded over
 * per-state `unity_ui_get_screen_rects` captures. See `run-minigame-gates.ts`.
 */

export type {
  MinigameRect,
  MinigameCaptureObject,
  MinigameViewport,
  MinigameConsole,
  MinigameCaptureState,
  WorldPoint,
  WorldAabb,
  BackgroundLayer,
  BackgroundLayerOrder,
  BackgroundCamera,
  BackgroundData,
  DiscoveredCamera,
  DiscoveredLayer,
  BackgroundCoverageByDevice,
  BackgroundCandidates,
} from "./types.js";

export {
  COVERAGE_GRID,
  COVERAGE_EPSILON,
  pointInAabb,
  viewRect,
  coverageStats,
  type CoverageCamera,
  type ViewRect,
  type CoverageStats,
} from "./coverage-geometry.js";

export {
  isInFrontOf,
  renderOrderUnsupportedReason,
  seamFindings,
  seamSegment,
  type SeamEdge,
  type SeamFinding,
} from "./seam-geometry.js";

export {
  evaluateRequiredInFrame,
  evaluateSafeArea,
  evaluateSafeAreaSweep,
  safeAreaOverflow,
  evaluateControlOverlap,
  evaluateTextClipping,
  evaluateConsoleClean,
  evaluateTapTargetSize,
  evaluateNoBlackBars,
  evaluateRenderFrame,
  evaluateBackgroundFit,
  evaluateBackgroundCoverage,
  evaluateBackgroundSeam,
  BACKGROUND_COVERAGE_GATE,
  BACKGROUND_SEAM_GATE,
  normalizedRect,
  MINIGAME_GATE_EVALUATORS,
  MINIGAME_FRAME_EVALUATORS,
  MINIGAME_IMAGE_EVALUATORS,
  DEFERRED_MINIGAME_CHECKS,
} from "./evaluators.js";

export {
  computeFrameFacts,
  loadFrameFacts,
  readFrameImage,
  backgroundFillFraction,
  parseHexColor,
  type DecodedImage,
  type MinigameFrameFacts,
} from "./frame-facts.js";

export {
  runMinigameGates,
  runStateGates,
  CAPTURE_GATE,
  type MinigameVerdict,
} from "./run-minigame-gates.js";

export {
  loadFlowEvidence,
  FLOW_EVIDENCE_FILE,
  type FlowEvidence,
  type FlowTransitionEvidence,
  type FlowActuation,
  type FlowTrigger,
} from "./flow-evidence.js";

export {
  evaluateInteractionFlow,
  FLOW_CHECK,
  type FlowOutcome,
  type FlowReport,
  type FlowTransitionReport,
} from "./interaction-flow.js";

export {
  evaluateInputResponse,
  loadInputResponseEvidence,
  responseEvidenceFile,
  INPUT_RESPONSE_CHECK,
  type InputResponseEvidence,
  type InputResponseOutcome,
  type InputResponseReport,
  type InputResponseStateReport,
} from "./input-response.js";
