/**
 * Tier-1 deterministic gate evaluators + aggregator (Phase C).
 *
 * Each evaluator is a PURE function `(opOutput, acceptance) -> GateReport`,
 * fully unit-testable from captured op-output fixtures with no live editor.
 * Live orchestration (which op to call → which evaluator) is documented in
 * `README.md` and wired in Phase E/F.
 */

export * from "./types.js";
export * from "./color.js";

export {
  evaluateUiConformance,
  normalizeFontName,
  normalizeRenderMode,
  fontMatches,
  GATE_NAME as UI_CONFORMANCE_GATE,
  type ScannedTextComponent,
  type ScanTextComponentsResult,
} from "./ui-conformance.js";

export {
  evaluateFraming,
  GATE_NAME as FRAMING_GATE,
  type ScreenRectObject,
  type ScreenRectsResult,
} from "./framing.js";

export {
  evaluateManifest,
  GATE_NAME as MANIFEST_GATE,
  type ManifestEntry,
  type VerifyManifestResult,
} from "./manifest.js";

export {
  evaluateAssetSourceFidelity,
  GATE_NAME as ASSET_SOURCE_FIDELITY_GATE,
  type AssetSourceFidelityInput,
  type ObservedAssetUse,
} from "./asset-source-fidelity.js";

export {
  evaluatePlayability,
  GATE_NAME as PLAYABILITY_GATE,
  type PlayabilityResults,
} from "./playability.js";

export {
  evaluateReachability,
  evaluateReachabilityEnvelope,
  feelEnvelope,
  GATE_NAME as REACHABILITY_GATE,
  type ReachabilityLayout,
  type ReachabilityPlatform,
  type ReachabilityLauncher,
  type ReachabilityCollectible,
  type FeelEnvelope,
  type FeelEnvelopeBudget,
} from "./reachability.js";

export {
  evaluateCoverage,
  GATE_NAME as COVERAGE_GATE,
  type CoverageInput,
  type CoverageRect,
  type CoverageLayer,
  type CoverageSample,
} from "./coverage.js";

export {
  evaluatePlacement,
  GATE_NAME as PLACEMENT_GATE,
  type PlacementInput,
  type PlacementCameraFrame,
  type PlacementGround,
  type PlacementGroundedItem,
} from "./placement.js";

export {
  evaluateFeel,
  bandWindow,
  withinBand,
  GATE_NAME as FEEL_GATE,
  type FeelMeasurements,
  type FeelMeasurementSource,
  type FeelMeasurementSourceKind,
  type FeelProvenance,
} from "./feel.js";

export {
  evaluateFeelProvenance,
  measuredAcceptedMetrics,
  validMeasurementSource,
  GATE_NAME as FEEL_PROVENANCE_GATE,
} from "./feel-provenance.js";

export {
  evaluateFeelRederive,
  rederiveFromSources,
  GATE_NAME as FEEL_REDERIVE_GATE,
  type RederiveVerdict,
} from "./feel-rederive.js";

export {
  evaluatePhysicsTimestep,
  GATE_NAME as PHYSICS_TIMESTEP_GATE,
} from "./physics-timestep.js";

export {
  evaluateFrameIntegrity,
  GATE_NAME as FRAME_INTEGRITY_GATE,
  type FrameIntegrityInput,
  type FrameIntegrityFrame,
} from "./frame-integrity.js";

export {
  evaluateConsoleClean,
  GATE_NAME as CONSOLE_CLEAN_GATE,
  type ConsoleLogsResult,
  type ConsoleLogEntry,
} from "./console-clean.js";

export {
  evaluatePropPurpose,
  GATE_NAME as PROP_PURPOSE_GATE,
  type PropPurposeInput,
  type PropPlayer,
  type PropObject,
  type PropBounds,
} from "./prop-purpose.js";

export {
  evaluateRenderFrame,
  GATE_NAME as RENDER_FRAME_GATE,
  type RenderFrameInput,
  type RenderFrameSample,
} from "./render-frame.js";

export {
  evaluateVisualArtifacts,
  GATE_NAME as VISUAL_ARTIFACTS_GATE,
  type VisualArtifactsInput,
  type VisualArtifactFrame,
  type VisualArtifactComparison,
} from "./visual-artifacts.js";

export {
  evaluatePlatformTiles,
  GATE_NAME as PLATFORM_TILES_GATE,
  type PlatformTilesInput,
  type PlatformTileCapture,
  type PlatformTileRole,
} from "./platform-tiles.js";

export {
  evaluateTileRender,
  GATE_NAME as TILE_RENDER_GATE,
  type TileRenderInput,
  type TileRenderPlatform,
  type TileSpriteCapture,
} from "./tile-render.js";

export {
  evaluateParallaxMotion,
  GATE_NAME as PARALLAX_MOTION_GATE,
  type ParallaxMotionInput,
  type ParallaxMotionLayer,
  type ParallaxMotionSample,
} from "./parallax-motion.js";

export {
  evaluateSfxPresence,
  GATE_NAME as SFX_PRESENCE_GATE,
} from "./sfx-presence.js";

export {
  evaluateSfxRuntime,
  GATE_NAME as SFX_RUNTIME_GATE,
} from "./sfx-runtime.js";

export {
  evaluateInputToSfxLatency,
  median as sfxLatencyMedian,
  GATE_NAME as INPUT_TO_SFX_LATENCY_GATE,
} from "./sfx-latency.js";

export {
  evaluateSfxFatigue,
  findImmediateRepeats,
  GATE_NAME as SFX_FATIGUE_GATE,
  type ImmediateRepeat,
} from "./sfx-fatigue.js";

export { aggregateVerdict } from "./aggregate.js";
