/**
 * Replay Verification — public surface of the deterministic replay core.
 *
 * Slice A1/A2: trace types, the parser, the driver seam, and the pure engine.
 * The live `UnityDriver` (A3) and the `loomtide trace replay` CLI (A4) build on
 * top of these exports.
 */

export * from "./types.js";
export * from "./driver.js";
export { parseTrace, TraceParseError, isSafePathSegment } from "./parse.js";
export { replay } from "./engine.js";
export { UnityDriver } from "./unity-driver.js";
export type { BridgeSend, UnityDriverOptions } from "./unity-driver.js";
export {
  resilientSend,
  ensureConnected,
  isConnectionLoss,
  NON_IDEMPOTENT_OPS,
} from "./resilient-send.js";
export type { ReconnectableClient } from "./resilient-send.js";
export { renderReplayReportHtml } from "./report-html.js";
export type { CaptureImage } from "./report-html.js";
export { summarizeFleet } from "./fleet.js";
export type { FleetReport, FleetTraceResult, FleetCounts } from "./fleet.js";
export { renderFleetReportHtml } from "./fleet-html.js";
export { comparePerceptual } from "./visual-diff.js";
export type { RgbaLike, VisualDiff, VisualDiffOptions, VisualStatus } from "./visual-diff.js";
export { RecordingSession } from "./record.js";
export type { RecordingMeta } from "./record.js";
export { observedClicksToTrace, observedEdgesToTrace, extractClicks, extractKeyEdges } from "./observe.js";
export type { ObservedClick, ObservedKeyEdge, ObserveTraceMeta, OutcomeSpec, StateSignalSpec } from "./observe.js";
