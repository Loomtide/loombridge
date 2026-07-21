/**
 * UnityClient — WebSocket client that manages the connection to Unity's BridgeServer.
 *
 * Handles port discovery (8200-8210), handshake enforcement, auto-reconnect
 * with exponential backoff, heartbeat via WebSocket ping, and message routing
 * through a pending ops map.
 */

import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import type {
  BridgeRequest,
  BridgeResponse,
  HandshakeResponse,
  UnityEndpointDiscoveryRecord,
  UnityTransportMode,
  UnityDiscoveryEndpoint,
} from "./types.js";
import {
  isHandshakeResponseData,
  parseBridgeResponse,
} from "./bridge-protocol.js";
import {
  loadPreferredEndpointDiscovery,
  normalizeProjectPathCanonical,
  projectPathCanonicalEquals,
  TARGET_PROJECT_ENV_VAR,
} from "./editor-discovery.js";

// ─────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────

const BASE_PORT = 8200;
const MAX_PORT = 8210;
const CONNECT_TIMEOUT_MS = 5000;
const HEARTBEAT_INTERVAL_MS = 3000;
const HEARTBEAT_TIMEOUT_MS = 5000;
const MAX_BACKOFF_MS = 10000;
const BASE_BACKOFF_MS = 500;
/** Consecutive ROUTE_MISMATCH reconnect attempts before auto-reconnect is abandoned. */
const MAX_ROUTE_MISMATCH_RECONNECTS = 5;
const DEFAULT_OP_TIMEOUT_MS = 10000;
const LOOPBACK_PROBE_HOSTS = ["localhost", "127.0.0.1", "[::1]"] as const;
const TRANSPORT_MODE_ENV_VAR = "LOOMBRIDGE_UNITY_TRANSPORT_MODE";
type LoopbackProbeHost = (typeof LOOPBACK_PROBE_HOSTS)[number];

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

interface PendingOp {
  resolve: (response: BridgeResponse) => void;
  reject: (error: Error) => void;
  startTime: number;
  timer?: ReturnType<typeof setTimeout>;
}

export type ConnectionErrorClass =
  | "EPERM_LOOPBACK"
  | "EPERM"
  | "ECONNREFUSED"
  | "TIMEOUT"
  | "EHOSTUNREACH"
  | "ENETUNREACH"
  | "EADDRNOTAVAIL"
  | "HANDSHAKE_ERROR"
  | "NO_ENDPOINT"
  | "UNKNOWN";

export interface HostAttemptFailure {
  url: string;
  errorClass: ConnectionErrorClass;
  message: string;
}

export interface PortAttemptFailure {
  port: number;
  hostAttempts: HostAttemptFailure[];
}

export interface ConnectionDiagnostics {
  transportMode: UnityTransportMode;
  attemptedEndpoints: string[];
  failedEndpoints: EndpointAttemptFailure[];
  selectedTransport: "ipc" | "tcp" | null;
  selectedEndpoint: string | null;
  attemptedPorts: number[];
  failedPorts: PortAttemptFailure[];
  lastErrorClass: ConnectionErrorClass;
  lastErrorMessage: string;
}

export interface EndpointAttemptFailure {
  transport: "ipc" | "tcp";
  kind: UnityDiscoveryEndpoint["kind"] | "legacy_port_probe";
  endpoint: string;
  errorClass: ConnectionErrorClass;
  message: string;
}

interface DiscoveryCandidate {
  transport: "ipc" | "tcp";
  kind: UnityDiscoveryEndpoint["kind"];
  endpoint: string;
  url: string;
  port?: number;
  sessionId: string;
  projectPathCanonical?: string;
}

export interface UnityClientTargetIdentity {
  projectPathCanonical?: string;
}

export interface UnityClientOptions {
  targetIdentity?: UnityClientTargetIdentity;
  autoPinProject?: boolean;
}

class PortProbeError extends Error {
  readonly port: number;
  readonly hostAttempts: HostAttemptFailure[];

  constructor(port: number, hostAttempts: HostAttemptFailure[]) {
    super(
      `Unable to connect to port ${port}. host attempts: `
      + hostAttempts.map((attempt) =>
        `${attempt.url} (${attempt.errorClass}: ${attempt.message})`).join(", ")
    );
    this.name = "PortProbeError";
    this.port = port;
    this.hostAttempts = hostAttempts;
  }
}

export class UnityConnectionError extends Error {
  readonly diagnostics: ConnectionDiagnostics;

  constructor(message: string, diagnostics: ConnectionDiagnostics) {
    super(message);
    this.name = "UnityConnectionError";
    this.diagnostics = diagnostics;
  }
}

function normalizeErrorMessage(error: unknown): string {
  // Node returns an AggregateError (with an EMPTY .message) for any dual-stack localhost
  // connect failure, so the real ECONNREFUSED/ETIMEDOUT lives in .errors[]. Without this,
  // every such failure classifies as UNKNOWN and prints "unknown error".
  if (error instanceof AggregateError && error.errors.length > 0) {
    const parts = error.errors.map((sub) => normalizeErrorMessage(sub)).filter((p) => p !== "unknown error");
    if (parts.length > 0) return [...new Set(parts)].join("; ");
  }
  const raw = error instanceof Error ? error.message : String(error);
  const firstLine = raw.split(/\r?\n/, 1)[0] ?? "";
  const normalized = firstLine.replace(/\s+/g, " ").trim();
  const code = (error as { code?: unknown } | null)?.code;
  if (!normalized && typeof code === "string" && code.length > 0) return code;
  return normalized || "unknown error";
}

/**
 * Build the WebSocket URL for an IPC endpoint (unix domain socket or Windows named pipe).
 *
 * `ws` does NOT honour a caller-supplied `socketPath` option: `initAsClient` spreads the
 * caller's options and then hard-overrides `socketPath: undefined`, so the only supported
 * route is a `ws+unix:` URL. Passing `{ socketPath }` instead makes ws dial the literal
 * URL — and `ws://localhost` with no port means TCP port 80, which is why IPC never
 * connected and `auto` silently fell through to TCP.
 *
 * The separator is a single colon and the path must keep its native separators: a Windows
 * pipe (`\\.\pipe\name`) breaks if the backslashes are POSIX-ified, and the `ws+unix://`
 * double-slash form is not a valid URL.
 */
export function ipcWebSocketUrl(socketPath: string): string {
  return `ws+unix:${socketPath}:/`;
}

export function isRouteMismatchError(error: unknown): boolean {
  return /\bROUTE_MISMATCH\b/i.test(normalizeErrorMessage(error));
}

export function classifyConnectionError(error: unknown): ConnectionErrorClass {
  const message = normalizeErrorMessage(error);
  if (/EPERM_LOOPBACK/i.test(message)) return "EPERM_LOOPBACK";
  if (/EPERM/i.test(message)) return "EPERM";
  if (/ECONNREFUSED/i.test(message)) return "ECONNREFUSED";
  if (/ETIMEDOUT|timeout/i.test(message)) return "TIMEOUT";
  if (/EHOSTUNREACH/i.test(message)) return "EHOSTUNREACH";
  if (/ENETUNREACH/i.test(message)) return "ENETUNREACH";
  if (/EADDRNOTAVAIL/i.test(message)) return "EADDRNOTAVAIL";
  if (/handshake/i.test(message)) return "HANDSHAKE_ERROR";
  return "UNKNOWN";
}

export function formatConnectionDiagnostics(diagnostics: ConnectionDiagnostics): string {
  const attemptedEndpoints = diagnostics.attemptedEndpoints.join(", ");
  const endpointFailures = diagnostics.failedEndpoints
    .map((attempt) => `${attempt.endpoint} (${attempt.errorClass})`)
    .slice(0, 4)
    .join(", ");
  const attemptedPorts = diagnostics.attemptedPorts.join(", ");
  const representativeHostAttempts = diagnostics.failedPorts
    .flatMap((portFailure) => portFailure.hostAttempts.map((attempt) =>
      `${attempt.url} (${attempt.errorClass})`))
    .slice(0, LOOPBACK_PROBE_HOSTS.length)
    .join(", ");
  return `preflight blocked; transport mode: ${diagnostics.transportMode}; selected transport: `
    + `${diagnostics.selectedTransport ?? "none"}; selected endpoint: ${diagnostics.selectedEndpoint ?? "none"}; `
    + `attempted endpoints: ${attemptedEndpoints || "none"}; endpoint attempts: ${endpointFailures || "none"}; `
    + `error class: ${diagnostics.lastErrorClass}; attempted ports: ${attemptedPorts || "none"}; `
    + `host attempts: ${representativeHostAttempts || "none"}; `
    + `last error: ${diagnostics.lastErrorMessage}`;
}

function isLoopbackEpermBlock(hostAttempts: HostAttemptFailure[]): boolean {
  return hostAttempts.some((attempt) => attempt.errorClass === "EPERM")
    && hostAttempts.every((attempt) =>
      attempt.errorClass === "EPERM" || attempt.errorClass === "UNKNOWN");
}

export interface UnityClientEvents {
  onConnected?: (handshake: HandshakeResponse) => void;
  onDisconnected?: (reason: string) => void;
  onReconnecting?: (attempt: number) => void;
  onProbe?: (message: string) => void;
}

// ─────────────────────────────────────────────
// UnityClient
// ─────────────────────────────────────────────

export class UnityClient {
  private _ws: WebSocket | null = null;
  private _activePort: number | null = null;
  private _activeSocketGeneration = 0;
  private _handshake: HandshakeResponse | null = null;
  private _pendingOps: Map<string, PendingOp> = new Map();
  private _handshakeComplete = false;
  private _handshakeQueue: Array<{ resolve: () => void; reject: (err: Error) => void }> = [];
  private _heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private _pongTimer: ReturnType<typeof setTimeout> | null = null;
  private _reconnecting = false;
  private _intentionalDisconnect = false;
  private _autoReconnect = true;
  private _connectPromise: Promise<HandshakeResponse> | null = null;
  private _preferredProbeHost: LoopbackProbeHost | null = null;
  private _activeTransport: "ipc" | "tcp" | null = null;
  private _activeEndpoint: string | null = null;
  private _pinnedProjectPathCanonical: string | null = null;
  private readonly _autoPinProject: boolean;
  /** Set during a connect attempt when the handshake fails the project pin (ROUTE_MISMATCH). */
  private _sawRouteMismatch = false;
  /** Consecutive reconnect attempts that hit ROUTE_MISMATCH; bounds the retry loop. */
  private _routeMismatchStreak = 0;
  /** True once auto-reconnect gives up because the pinned editor keeps mismatching. */
  private _reconnectAbandoned = false;
  /**
   * Latched true after the FIRST successful handshake and never reset. Distinguishes a bridge
   * that is bouncing through a known domain reload (a transient ECONNREFUSED_NO_LISTENER — the
   * editor process is alive, the listener will return) from one that never had a listener at all
   * (a genuinely-dead bridge). The reload-aware preflight retry keys off this so it never polls
   * forever against a bridge that was never up.
   */
  private _hasEverConnected = false;

  /** Event callbacks */
  public events: UnityClientEvents = {};

  constructor(options: UnityClientOptions = {}) {
    this._autoPinProject = options.autoPinProject ?? true;
    // An explicit targetIdentity wins; otherwise honour a process-wide pin from the environment so
    // a parent command can constrain every spawned CLI subprocess to one editor (see TARGET_PROJECT_ENV_VAR).
    this._pinnedProjectPathCanonical =
      normalizeProjectPathCanonical(options.targetIdentity?.projectPathCanonical)
      ?? normalizeProjectPathCanonical(process.env[TARGET_PROJECT_ENV_VAR]);
  }

  // ─────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────

  /** Returns the cached handshake data, or null if not connected. */
  get handshake(): HandshakeResponse | null {
    return this._handshake;
  }

  /**
   * The transport the live connection actually settled on. `auto` mode prefers IPC and
   * falls back to TCP, so surfacing this is what keeps a silent downgrade visible.
   */
  get activeTransport(): "ipc" | "tcp" | null {
    return this._activeTransport;
  }

  /** The endpoint the live connection settled on, e.g. `tcp:websocket:localhost:8200`. */
  get activeEndpoint(): string | null {
    return this._activeEndpoint;
  }

  /** Returns true if the WebSocket is open and handshake is complete. */
  get isConnected(): boolean {
    return this._ws !== null
      && this._ws.readyState === WebSocket.OPEN
      && this._handshakeComplete;
  }

  /**
   * True once this client has completed at least one handshake (latched, never reset).
   * A subsequent ECONNREFUSED_NO_LISTENER then means the listener is bouncing through a
   * reload rather than that the bridge was never up.
   */
  get hasEverConnected(): boolean {
    return this._hasEverConnected;
  }

  /** Durable project identity this client is pinned to, if known. */
  get pinnedProjectPathCanonical(): string | null {
    return this._pinnedProjectPathCanonical;
  }

  /**
   * True when auto-reconnect has given up because the pinned editor repeatedly
   * handshakes as a different project. The registry uses this to evict and recreate
   * the client instead of letting it spin forever against the wrong editor.
   */
  get reconnectAbandoned(): boolean {
    return this._reconnectAbandoned;
  }

  /**
   * Connect to Unity's BridgeServer.
   * Scans ports 8200-8210 (cached port first), opens WebSocket,
   * performs handshake, and starts heartbeat.
   */
  async connect(): Promise<HandshakeResponse> {
    if (this.isConnected && this._handshake) {
      return this._handshake;
    }

    if (this._connectPromise) {
      return this._connectPromise;
    }

    this._intentionalDisconnect = false;
    const connectPromise = this._connectInternal();
    this._connectPromise = connectPromise;

    try {
      return await connectPromise;
    } finally {
      if (this._connectPromise === connectPromise) {
        this._connectPromise = null;
      }
    }
  }

  private async _connectInternal(): Promise<HandshakeResponse> {
    this._sawRouteMismatch = false;
    const transportMode = this._resolveTransportMode();
    const discovery = this._loadEndpointDiscovery();
    const discoveryCandidates = discovery
      ? this._buildDiscoveryCandidates(transportMode, discovery)
      : [];
    const ports = this._getPortRange();

    this._emitProbe(
      `probe strategy: transport mode ${transportMode}; discovery ${discovery ? "present" : "missing"}; `
      + `discovery candidates ${discoveryCandidates.length}; legacy ports ${ports.join(", ")}; `
      + `fallback hosts ${LOOPBACK_PROBE_HOSTS.join(", ")}; preferred host ${this._preferredProbeHost ?? "none"}`
    );

    const attemptedEndpoints: string[] = [];
    const failedEndpoints: EndpointAttemptFailure[] = [];
    const portFailures: string[] = [];
    const failedPorts: PortAttemptFailure[] = [];
    let lastError: Error | null = null;
    let lastErrorClass: ConnectionErrorClass = "UNKNOWN";
    let lastErrorMessage = "unknown error";
    let selectedTransport: "ipc" | "tcp" | null = null;
    let selectedEndpoint: string | null = null;

    for (const candidate of discoveryCandidates) {
      let attemptedSocket: WebSocket | null = null;
      attemptedEndpoints.push(candidate.endpoint);
      this._emitProbe(`probe candidate ${candidate.endpoint}`);

      try {
        const ws = await this._connectToUrl(candidate.url, candidate.endpoint);
        attemptedSocket = ws;
        selectedTransport = candidate.transport;
        selectedEndpoint = candidate.endpoint;
        this._emitProbe(`probe selected ${candidate.endpoint}`);
        return await this._activateConnectedSocket(
          ws,
          candidate.port ?? null,
          candidate.transport,
          candidate.endpoint,
        );
      } catch (err) {
        const message = this._toErrorMessage(err);
        const errorClass = classifyConnectionError(err);
        lastError = new Error(message);
        lastErrorClass = errorClass;
        lastErrorMessage = message;
        failedEndpoints.push({
          transport: candidate.transport,
          kind: candidate.kind,
          endpoint: candidate.endpoint,
          errorClass,
          message,
        });
        this._emitProbe(
          `probe rejected ${candidate.endpoint} (error class: ${errorClass}, message: ${message})`,
        );
        this._cleanupFailedSocket(attemptedSocket);
        if (isRouteMismatchError(err)) {
          throw err;
        }
      }
    }

    if (transportMode === "ipc") {
      if (discoveryCandidates.length === 0) {
        // Nothing was ever dialed — this is a config/preflight refusal, not a
        // failed connection. Classify it as NO_ENDPOINT so diagnostics don't
        // read a misleading "error class: UNKNOWN" (e.g. forcing ipc mode on a
        // macOS/Linux editor, whose Mono runtime never publishes an ipc endpoint).
        lastErrorClass = "NO_ENDPOINT";
        lastErrorMessage = discovery
          ? "ipc mode requires discovery record with at least one ipc endpoint"
          : "ipc mode requires endpoint discovery";
      }
      const diagnostics: ConnectionDiagnostics = {
        transportMode,
        attemptedEndpoints,
        failedEndpoints,
        selectedTransport,
        selectedEndpoint,
        attemptedPorts: [],
        failedPorts,
        lastErrorClass,
        lastErrorMessage,
      };
      throw new UnityConnectionError(
        `Failed to connect to Unity in ipc mode. ${formatConnectionDiagnostics(diagnostics)}. `
        + `Last error: ${lastError?.message ?? lastErrorMessage}.`,
        diagnostics,
      );
    }

    if (discoveryCandidates.length > 0) {
      this._emitProbe("discovery candidates exhausted; falling back to legacy tcp port probe");
    }

    for (const port of ports) {
      let attemptedSocket: WebSocket | null = null;
      const probeEndpoint = `legacy_port_probe:${port}`;
      attemptedEndpoints.push(probeEndpoint);

      try {
        const ws = await this._connectToPort(port);
        attemptedSocket = ws;
        selectedTransport = "tcp";
        selectedEndpoint = probeEndpoint;
        return await this._activateConnectedSocket(ws, port, "tcp", probeEndpoint);
      } catch (err) {
        const message = this._toErrorMessage(err);
        lastError = new Error(message);
        lastErrorMessage = message;

        if (err instanceof PortProbeError) {
          const portErrorClass = isLoopbackEpermBlock(err.hostAttempts)
            ? "EPERM_LOOPBACK"
            : err.hostAttempts[err.hostAttempts.length - 1]?.errorClass ?? classifyConnectionError(err);
          failedPorts.push({
            port: err.port,
            hostAttempts: [...err.hostAttempts],
          });
          failedEndpoints.push({
            transport: "tcp",
            kind: "legacy_port_probe",
            endpoint: probeEndpoint,
            errorClass: portErrorClass,
            message,
          });
          const attemptDetails = err.hostAttempts
            .map((attempt) => `${attempt.url} (${attempt.errorClass}: ${attempt.message})`)
            .join(", ");
          portFailures.push(`port ${port}: ${portErrorClass}: host attempts: ${attemptDetails}`);
          lastErrorClass = portErrorClass;
        } else {
          const errorClass = classifyConnectionError(err);
          failedEndpoints.push({
            transport: "tcp",
            kind: "legacy_port_probe",
            endpoint: probeEndpoint,
            errorClass,
            message,
          });
          lastErrorClass = errorClass;
          portFailures.push(`port ${port}: ${lastErrorClass}: ${message}`);
        }

        this._cleanupFailedSocket(attemptedSocket);
      }
    }

    const attemptedOrder = ports.join(", ");
    const attempts =
      portFailures.length > 0
        ? `attempt details: ${portFailures.join(" | ")}`
        : "attempt details: unavailable";
    if (
      failedPorts.length > 0
      && failedPorts.every((portFailure) => isLoopbackEpermBlock(portFailure.hostAttempts))
    ) {
      lastErrorClass = "EPERM_LOOPBACK";
    }
    const diagnostics: ConnectionDiagnostics = {
      transportMode,
      attemptedEndpoints,
      failedEndpoints,
      selectedTransport,
      selectedEndpoint,
      attemptedPorts: [...ports],
      failedPorts,
      lastErrorClass,
      lastErrorMessage,
    };
    throw new UnityConnectionError(
      `Failed to connect to Unity on ports ${BASE_PORT}-${MAX_PORT} (attempted order: ${attemptedOrder}). `
      + `${formatConnectionDiagnostics(diagnostics)}. Last error: ${lastError?.message ?? "unknown error"}. `
      + `${attempts}`,
      diagnostics,
    );
  }

  /**
   * Disconnect from Unity. Cancels heartbeat, rejects pending ops, closes WebSocket.
   */
  async disconnect(): Promise<void> {
    this._intentionalDisconnect = true;
    this._stopHeartbeat();
    this._rejectAllPending("Intentional disconnect");
    this._handshakeComplete = false;
    this._handshake = null;
    this._activeTransport = null;
    this._activeEndpoint = null;

    this._rejectHandshakeWaiters("Disconnected during handshake");

    if (this._ws) {
      const ws = this._ws;

      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        return new Promise<void>((resolve) => {
          ws.once("close", () => resolve());
          ws.close(1000, "Client disconnect");
          // Safety timeout in case close event doesn't fire
          setTimeout(() => {
            ws.terminate();
            resolve();
          }, 2000);
        });
      }

      this._ws = null;
      this._activeSocketGeneration = 0;
      this._activePort = null;
    }
  }

  /**
   * Wait for an in-progress auto-reconnect to complete.
   * Polls `isConnected` at 250ms intervals up to `timeoutMs`.
   * Resolves `true` if reconnected, `false` if timed out.
   */
  async waitForReconnect(timeoutMs: number = 5000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.isConnected) return true;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return this.isConnected;
  }

  /**
   * Send a command to Unity and wait for the response.
   * Blocks if handshake is not yet complete.
   */
  async send(
    command: string,
    params: Record<string, unknown>,
    timeoutMs: number = DEFAULT_OP_TIMEOUT_MS,
  ): Promise<BridgeResponse> {
    // Bound the whole call (reconnect wait + handshake wait + response) by timeoutMs.
    const deadline = Date.now() + timeoutMs;
    const remaining = () => deadline - Date.now();
    const timeoutError = () =>
      new Error(`Timeout waiting for response to ${command} (${timeoutMs}ms)`);

    if (this._connectPromise) {
      await this._connectPromise;
    }

    // The socket may be down because a play-mode entry or recompile triggered a
    // domain reload that tore the bridge down, and an auto-reconnect is in flight.
    // This op has NOT been transmitted yet, so waiting for the reconnect to settle
    // is safe — unlike resending an op that may already have reached Unity. Bound
    // the wait by the op's remaining timeout budget.
    if (
      (!this._ws || this._ws.readyState !== WebSocket.OPEN)
      && this._reconnecting
      && !this._reconnectAbandoned
      && !this._intentionalDisconnect
    ) {
      if (remaining() > 0) {
        await this.waitForReconnect(remaining());
      }
    }

    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) {
      throw new Error("Not connected — call connect() first");
    }

    // The reconnect wait may have consumed the whole budget. Never transmit an op
    // we can no longer wait for: a mutating command would execute in Unity while
    // the MCP side immediately reports timeout. Throw before sending instead.
    if (remaining() <= 0) {
      throw timeoutError();
    }

    // Wait for handshake if needed, bounded by the remaining budget.
    if (!this._handshakeComplete) {
      await this._waitForHandshake(remaining());
    }

    // Handshake wait may also have exhausted the budget — re-check immediately
    // before sending (no awaits between here and _ws.send()).
    if (remaining() <= 0) {
      throw timeoutError();
    }

    const id = randomUUID();
    const request: BridgeRequest = { id, command, params };

    // Use the remaining budget so the total call never exceeds timeoutMs. The clock
    // can tick past the deadline during the synchronous id/request build above, so
    // re-check here: never transmit with a non-positive budget (the request would
    // reach Unity before the 0ms timeout callback fires).
    const responseTimeoutMs = remaining();
    if (responseTimeoutMs <= 0) {
      throw timeoutError();
    }

    return new Promise<BridgeResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pendingOps.delete(id);
        reject(timeoutError());
      }, responseTimeoutMs);

      this._pendingOps.set(id, {
        resolve: (response: BridgeResponse) => {
          clearTimeout(timer);
          resolve(response);
        },
        reject: (err: Error) => {
          clearTimeout(timer);
          reject(err);
        },
        startTime: Date.now(),
        timer,
      });

      this._ws!.send(JSON.stringify(request), (err) => {
        if (err) {
          clearTimeout(timer);
          this._pendingOps.delete(id);
          reject(new Error(`Failed to send ${command}: ${err.message}`));
        }
      });
    });
  }

  // ─────────────────────────────────────────────
  // Internal: Connection
  // ─────────────────────────────────────────────

  /** Returns the port scan order — cached port first, then the full range. */
  _getPortRange(): number[] {
    const ports: number[] = [];
    if (this._activePort !== null) {
      ports.push(this._activePort);
    }
    for (let p = BASE_PORT; p <= MAX_PORT; p++) {
      if (p !== this._activePort) {
        ports.push(p);
      }
    }
    return ports;
  }

  private _resolveTransportMode(): UnityTransportMode {
    const rawMode = (process.env[TRANSPORT_MODE_ENV_VAR] ?? "").trim().toLowerCase();
    if (rawMode === "auto" || rawMode === "ipc" || rawMode === "tcp") {
      return rawMode;
    }
    return "auto";
  }

  private _loadEndpointDiscovery(): UnityEndpointDiscoveryRecord | null {
    return loadPreferredEndpointDiscovery(this._pinnedProjectPathCanonical);
  }

  _buildDiscoveryCandidates(
    mode: UnityTransportMode,
    discovery: UnityEndpointDiscoveryRecord,
  ): DiscoveryCandidate[] {
    const ipcCandidates: DiscoveryCandidate[] = [];
    const tcpCandidates: DiscoveryCandidate[] = [];

    for (const endpoint of discovery.endpoints) {
      if (!endpoint.supportsHandshake) {
        continue;
      }

      if (endpoint.transport === "ipc" && endpoint.path) {
        ipcCandidates.push({
          transport: "ipc",
          kind: endpoint.kind,
          endpoint: `ipc:${endpoint.kind}:${endpoint.path}`,
          url: ipcWebSocketUrl(endpoint.path),
          sessionId: discovery.sessionId,
          projectPathCanonical: discovery.projectPathCanonical,
        });
        continue;
      }

      if (endpoint.transport === "tcp" && endpoint.host && endpoint.port) {
        tcpCandidates.push({
          transport: "tcp",
          kind: "websocket",
          endpoint: `tcp:websocket:${endpoint.host}:${endpoint.port}`,
          url: `ws://${endpoint.host}:${endpoint.port}`,
          port: endpoint.port,
          sessionId: discovery.sessionId,
          projectPathCanonical: discovery.projectPathCanonical,
        });
      }
    }

    if (mode === "ipc") {
      return ipcCandidates;
    }
    if (mode === "tcp") {
      return tcpCandidates;
    }
    return [...ipcCandidates, ...tcpCandidates];
  }

  private async _activateConnectedSocket(
    ws: WebSocket,
    port: number | null,
    transport: "ipc" | "tcp",
    endpoint: string,
  ): Promise<HandshakeResponse> {
    const socketGeneration = this._activeSocketGeneration + 1;
    this._ws = ws;
    this._activePort = port;
    this._activeTransport = transport;
    this._activeEndpoint = endpoint;
    this._activeSocketGeneration = socketGeneration;
    this._handshake = null;
    this._handshakeComplete = false;

    ws.on("message", (data: WebSocket.RawData) => {
      this._onMessage(socketGeneration, data.toString());
    });

    ws.on("close", (code: number, reason: Buffer) => {
      this._onClose(socketGeneration, reason.toString() || `code=${code}`);
    });

    ws.on("error", (_err: Error) => {
      // Error is followed by close; cleanup occurs in close handler.
    });

    ws.on("pong", () => {
      this._onPong(socketGeneration);
    });

    const handshake = this._validateAndPinHandshake(await this._performHandshake(ws));
    this._handshake = handshake;
    this._handshakeComplete = true;
    this._hasEverConnected = true;
    this._routeMismatchStreak = 0;
    this._reconnectAbandoned = false;
    this._resolveHandshakeWaiters();
    this._startHeartbeat();
    this.events.onConnected?.(handshake);
    return handshake;
  }

  private _validateAndPinHandshake(handshake: HandshakeResponse): HandshakeResponse {
    const handshakeProject = normalizeProjectPathCanonical(handshake.projectPathCanonical);
    if (this._pinnedProjectPathCanonical) {
      if (!handshakeProject) {
        this._sawRouteMismatch = true;
        throw new Error(
          `ROUTE_MISMATCH: connected editor did not report projectPathCanonical; `
          + `expected ${this._pinnedProjectPathCanonical}`,
        );
      }
      if (!projectPathCanonicalEquals(handshakeProject, this._pinnedProjectPathCanonical)) {
        this._sawRouteMismatch = true;
        throw new Error(
          `ROUTE_MISMATCH: connected editor projectPathCanonical=${handshakeProject} `
          + `does not match pinned projectPathCanonical=${this._pinnedProjectPathCanonical}`,
        );
      }
      return handshake;
    }

    if (this._autoPinProject && handshakeProject) {
      this._pinnedProjectPathCanonical = handshakeProject;
    }
    return handshake;
  }

  private _cleanupFailedSocket(socket: WebSocket | null): void {
    if (!socket) {
      return;
    }
    socket.removeAllListeners();
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.terminate();
    }
    if (this._ws === socket) {
      this._ws = null;
      this._activeSocketGeneration = 0;
      this._handshake = null;
      this._handshakeComplete = false;
      this._activeTransport = null;
      this._activeEndpoint = null;
      this._activePort = null;
    }
  }

  /** Attempt to open a WebSocket to a specific port across loopback host variants. */
  private async _connectToPort(port: number): Promise<WebSocket> {
    // Unity transport behavior can differ between loopback variants per platform/version.
    const urls = this._getProbeUrls(port);
    this._emitProbe(`probe port ${port}: host order ${urls.join(", ")}`);

    const hostFailures: HostAttemptFailure[] = [];
    for (const url of urls) {
      try {
        const ws = await this._connectToUrl(url, `legacy_port_probe:${url}`);
        const resolvedHost = this._extractProbeHost(url);
        if (resolvedHost) {
          this._preferredProbeHost = resolvedHost;
        }
        this._emitProbe(`probe selected ${url} for port ${port}`);
        return ws;
      } catch (err) {
        const message = this._toErrorMessage(err);
        const errorClass = classifyConnectionError(err);
        hostFailures.push({
          url,
          errorClass,
          message,
        });
        this._emitProbe(`probe rejected ${url} (error class: ${errorClass}, message: ${message})`);
      }
    }

    throw new PortProbeError(port, hostFailures);
  }

  private _getProbeUrls(port: number): string[] {
    const hostOrder: LoopbackProbeHost[] = [];
    if (this._preferredProbeHost !== null) {
      hostOrder.push(this._preferredProbeHost);
    }
    for (const host of LOOPBACK_PROBE_HOSTS) {
      if (host !== this._preferredProbeHost) {
        hostOrder.push(host);
      }
    }
    return hostOrder.map((host) => `ws://${host}:${port}`);
  }

  private _extractProbeHost(url: string): LoopbackProbeHost | null {
    try {
      const parsed = new URL(url);
      if (parsed.hostname === "::1") {
        return "[::1]";
      }
      if (LOOPBACK_PROBE_HOSTS.includes(parsed.hostname as LoopbackProbeHost)) {
        return parsed.hostname as LoopbackProbeHost;
      }
      return null;
    } catch {
      return null;
    }
  }

  private _emitProbe(message: string): void {
    this.events.onProbe?.(message);
  }

  private _connectToUrl(url: string, label: string): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      // `url` already encodes the transport: `ws+unix:<path>:/` for IPC, `ws://host:port`
      // for TCP. Never pass `{ socketPath }` — ws discards it (see ipcWebSocketUrl).
      const ws = new WebSocket(url);
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error(`Connection timeout (${label})`));
      }, CONNECT_TIMEOUT_MS);

      ws.once("open", () => {
        clearTimeout(timer);
        resolve(ws);
      });

      ws.once("error", (err: Error) => {
        clearTimeout(timer);
        reject(new Error(this._toErrorMessage(err)));
      });
    });
  }

  private _toErrorMessage(err: unknown): string {
    return normalizeErrorMessage(err);
  }

  /**
   * Wait for the handshake to complete, bounded by `timeoutMs`. On timeout the
   * waiter removes itself from the queue and resolves — the caller re-checks its
   * remaining budget and throws a timeout before sending, so no op is transmitted.
   */
  private _waitForHandshake(timeoutMs: number): Promise<void> {
    if (this._handshakeComplete) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const waiter = {
        resolve: () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve();
        },
        reject: (err: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(err);
        },
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this._handshakeQueue = this._handshakeQueue.filter((w) => w !== waiter);
        resolve();
      }, Math.max(0, timeoutMs));
      this._handshakeQueue.push(waiter);
    });
  }

  private _resolveHandshakeWaiters(): void {
    for (const waiter of this._handshakeQueue) {
      waiter.resolve();
    }
    this._handshakeQueue = [];
  }

  private _rejectHandshakeWaiters(reason: string): void {
    for (const waiter of this._handshakeQueue) {
      waiter.reject(new Error(reason));
    }
    this._handshakeQueue = [];
  }

  // ─────────────────────────────────────────────
  // Internal: Handshake
  // ─────────────────────────────────────────────

  /** Send bridge.initialize and validate the response. */
  private _performHandshake(ws: WebSocket): Promise<HandshakeResponse> {
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const request: BridgeRequest = {
        id,
        command: "bridge.initialize",
        params: {},
      };

      const timer = setTimeout(() => {
        ws.removeListener("message", handler);
        reject(new Error("Handshake timeout"));
      }, CONNECT_TIMEOUT_MS);

      // Temporarily listen for the handshake response
      const handler = (data: WebSocket.RawData) => {
        try {
          const response = parseBridgeResponse(data.toString());
          if (response.id === id) {
            clearTimeout(timer);
            ws.removeListener("message", handler);

            if (response.status !== "success") {
              reject(new Error(
                `Handshake failed: ${response.error?.message ?? "unknown error"}`
              ));
              return;
            }

            if (!isHandshakeResponseData(response.data)) {
              reject(new Error("Handshake response payload is malformed"));
              return;
            }

            resolve(response.data);
          }
        } catch {
          // Ignore parse errors for non-matching messages
        }
      };

      ws.on("message", handler);
      ws.send(JSON.stringify(request), (err) => {
        if (err) {
          clearTimeout(timer);
          ws.removeListener("message", handler);
          reject(new Error(`Failed to send handshake: ${err.message}`));
        }
      });
    });
  }

  // ─────────────────────────────────────────────
  // Internal: Message Routing
  // ─────────────────────────────────────────────

  /** Handle incoming WebSocket message. Routes to pending op by id. */
  private _onMessage(socketGeneration: number, raw: string): void {
    if (socketGeneration !== this._activeSocketGeneration) {
      return;
    }

    let response: BridgeResponse;
    try {
      response = parseBridgeResponse(raw);
    } catch {
      // Ignore unparseable messages
      return;
    }

    const pending = this._pendingOps.get(response.id);
    if (pending) {
      this._pendingOps.delete(response.id);
      pending.resolve(response);
    }
  }

  // ─────────────────────────────────────────────
  // Internal: Connection Loss
  // ─────────────────────────────────────────────

  /** Handle WebSocket close. */
  private _onClose(socketGeneration: number, reason: string): void {
    if (socketGeneration !== this._activeSocketGeneration) {
      return;
    }

    this._stopHeartbeat();
    this._handshakeComplete = false;
    this._handshake = null;
    this._ws = null;
    this._activeSocketGeneration = 0;
    this._activePort = null;
    this._activeTransport = null;
    this._activeEndpoint = null;

    this._rejectAllPending(reason);

    this._rejectHandshakeWaiters(`Connection lost: ${reason}`);

    this.events.onDisconnected?.(reason);

    if (!this._intentionalDisconnect && this._autoReconnect) {
      this._attemptReconnect();
    }
  }

  /** Reject all pending operations with a CONNECTION_LOST error. */
  _rejectAllPending(reason: string): void {
    for (const [id, pending] of this._pendingOps) {
      if (pending.timer) {
        clearTimeout(pending.timer);
      }
      pending.reject(new Error(`CONNECTION_LOST: ${reason}`));
    }
    this._pendingOps.clear();
  }

  // ─────────────────────────────────────────────
  // Internal: Reconnect
  // ─────────────────────────────────────────────

  /** Auto-reconnect with exponential backoff. */
  private async _attemptReconnect(): Promise<void> {
    if (this._reconnecting || this._intentionalDisconnect || this._reconnectAbandoned) return;
    this._reconnecting = true;

    try {
      let attempt = 0;
      while (!this._intentionalDisconnect) {
        const delayMs = this._getBackoffMs(attempt);
        this.events.onReconnecting?.(attempt);

        await new Promise((resolve) => setTimeout(resolve, delayMs));

        if (this._intentionalDisconnect) break;

        try {
          await this.connect();
          return;
        } catch {
          attempt++;
          // A pinned client whose endpoint now answers as a DIFFERENT project will
          // ROUTE_MISMATCH on every attempt. Don't spin forever: after a few strikes,
          // abandon auto-reconnect and let the registry evict + recreate this client
          // once discovery shows the real editor again.
          if (this._sawRouteMismatch) {
            this._routeMismatchStreak++;
            if (this._routeMismatchStreak >= MAX_ROUTE_MISMATCH_RECONNECTS) {
              this._reconnectAbandoned = true;
              this.events.onDisconnected?.(
                `reconnect abandoned after ${this._routeMismatchStreak} ROUTE_MISMATCH attempts`,
              );
              break;
            }
          } else {
            this._routeMismatchStreak = 0;
          }
        }
      }
    } finally {
      this._reconnecting = false;
    }
  }

  /** Compute backoff delay: 500 * 2^attempt, capped at 10s. */
  _getBackoffMs(attempt: number): number {
    return Math.min(BASE_BACKOFF_MS * Math.pow(2, attempt), MAX_BACKOFF_MS);
  }

  // ─────────────────────────────────────────────
  // Internal: Heartbeat
  // ─────────────────────────────────────────────

  /** Start sending WebSocket ping frames every 3s. */
  private _startHeartbeat(): void {
    this._stopHeartbeat();

    this._heartbeatTimer = setInterval(() => {
      if (this._ws && this._ws.readyState === WebSocket.OPEN) {
        this._ws.ping();

        // Clear any previous pong timer to prevent race conditions
        if (this._pongTimer) {
          clearTimeout(this._pongTimer);
        }

        // Start pong timeout
        this._pongTimer = setTimeout(() => {
          this._pongTimer = null;
          // No pong received — treat as disconnected
          if (this._ws) {
            this._ws.terminate();
          }
        }, HEARTBEAT_TIMEOUT_MS);
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  /** Handle pong frame. */
  private _onPong(socketGeneration: number): void {
    if (socketGeneration !== this._activeSocketGeneration) {
      return;
    }
    if (this._pongTimer) {
      clearTimeout(this._pongTimer);
      this._pongTimer = null;
    }
  }

  /** Stop heartbeat timers. */
  private _stopHeartbeat(): void {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
    if (this._pongTimer) {
      clearTimeout(this._pongTimer);
      this._pongTimer = null;
    }
  }
}
