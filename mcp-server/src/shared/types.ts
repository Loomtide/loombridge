/**
 * Shared TypeScript interfaces for Loombridge MCP Server.
 * These types define the wire protocol and data structures used
 * for communication between the MCP server and the Unity plugin.
 */

// --- Entity Locators ---

export interface EntityLocator {
  scene: string;
  path: string;
  globalObjectId?: string;
  instanceId?: string;
}

// --- Wait / Sync ---

export interface WaitCondition {
  compiling?: boolean;
  updating?: boolean;
  playMode?: "playing" | "paused" | "stopped";
  frames?: number;
  delayMs?: number;
  timeoutMs?: number;
}

export interface WaitResult {
  waited_ms: number;
  compileResult?: {
    compileId: number;
    finishedAtMs: number;
    succeeded: boolean;
    errorCount: number;
    errors: Array<{
      file: string;
      line: number;
      column: number;
      message: string;
    }>;
  };
}

// --- Input Automation ---

export interface InputBackendCapability {
  name: string;
  available: boolean;
  requiresGameViewFocus: boolean;
}

export interface InputCapabilities {
  backend: {
    available: boolean;
    selected: string;
    fallbackOrder: string[];
    backends: InputBackendCapability[];
  };
  focus: {
    gameViewFocused: boolean;
    required: boolean;
  };
  requiresPlayMode: boolean;
  session: {
    required: boolean;
    active: boolean;
  };
  limitations: string[];
}

// --- Runtime Introspection / Assertions ---

export interface RuntimeSnapshot {
  locator: EntityLocator;
  name: string;
  scene: string;
  activeSelf: boolean;
  activeInHierarchy: boolean;
  tag: string;
  layer: number;
  transform: {
    position: { x: number; y: number; z: number };
    localPosition: { x: number; y: number; z: number };
    eulerAngles: { x: number; y: number; z: number };
    localScale: { x: number; y: number; z: number };
  };
  components: Array<{
    type_name: string;
    full_type_name?: string;
    properties: PropertyDescriptor[];
  }>;
}

export type RuntimeComparator =
  | "equals"
  | "not_equals"
  | "greater_than"
  | "less_than"
  | "approx"
  | "contains";

export interface RuntimeConditionResult {
  passed: boolean;
  operator: RuntimeComparator;
  component?: string;
  property_path: string;
  resolved_path: string;
  actual: unknown;
  expected: unknown;
  tolerance: number;
  waited_ms?: number;
}

// --- Scenario Orchestration ---

export interface ScenarioReport {
  status: "pass" | "fail" | "blocked";
  scenarioName: string;
  deterministic?: true;
  startedAtMs: number;
  finishedAtMs: number;
  durationMs: number;
  failedStepIndex?: number;
  failedStepId?: string;
  failedStepStatus?: "fail" | "blocked";
  diagnostics: {
    totalSteps: number;
    passedSteps: number;
    failedSteps: number;
    blockedSteps?: number;
  };
}

// --- Screenshots ---

export interface ScreenshotParams {
  view?: "scene" | "game";
  maxWidth?: number;
  format?: "jpeg" | "png";
  quality?: number;
}

export interface ScreenshotResult {
  image_base64: string;
  width: number;
  height: number;
  sizeBytes: number;
  format: "jpeg" | "png";
}

// --- Inspector / Properties ---

export interface PropertyDescriptor {
  displayName: string;
  serializedPath: string;
  type: string;
  currentValue: unknown;
  readOnly?: boolean;
  range?: { min: number; max: number };
  enumValues?: string[];
}

// --- Op Definitions ---

export interface OpDefinition {
  name: string;
  description: string;
  category: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  requiresEditMode?: boolean;
  requiresPlayMode?: boolean;
  modifiesScene?: boolean;
  undoable?: boolean;
  defaultTimeoutMs?: number;
}

// --- Wire Protocol ---

export interface BridgeRequest {
  id: string;
  command: string;
  params: Record<string, unknown>;
}

export interface BridgeResponse {
  id: string;
  status: "success" | "error";
  data: unknown;
  error?: { code: string; message: string };
  trace?: {
    consoleDelta: Array<{
      type: string;
      message: string;
      stackTrace?: string;
      timestamp?: number;
    }>;
    artifacts?: Array<{
      kind: "screenshot" | "file";
      sourcePath?: string;
      format?: "jpeg" | "png";
      width?: number;
      height?: number;
      sizeBytes?: number;
      description?: string;
    }>;
  };
  timestamp: number;
}

// --- Transport Discovery ---

export type UnityTransportMode = "auto" | "ipc" | "tcp";
export type UnityEndpointTransport = "ipc" | "tcp";
export type UnityEndpointKind = "unix_domain_socket" | "named_pipe" | "websocket";

export interface UnityDiscoveryEndpoint {
  transport: UnityEndpointTransport;
  kind: UnityEndpointKind;
  path?: string;
  host?: string;
  port?: number;
  supportsHandshake: boolean;
  supportsPing: boolean;
}

export interface UnityEndpointDiscoveryRecord {
  schemaVersion: "1";
  sessionId: string;
  projectPath?: string;
  projectPathCanonical?: string;
  projectName?: string;
  processId?: number;
  publishedAtUnixMs: number;
  expiresAtUnixMs: number;
  transportModeDefault: UnityTransportMode;
  endpoints: UnityDiscoveryEndpoint[];
}

// --- Handshake ---

export interface HandshakeResponse {
  engine: string;
  engineVersion: string;
  pluginVersion: string;
  port: number;
  protocolVersion: number;
  sessionId: string;
  projectPath?: string;
  projectPathCanonical?: string;
  projectName?: string;
  processId?: number;
  capabilities: {
    screenshotTargets: string[];
    supportedCategories: string[];
    maxPayloadBytes: number;
    supportsAnimatorSpec: boolean;
    supportsGlobalObjectId: boolean;
  };
}
