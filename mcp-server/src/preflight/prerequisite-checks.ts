import type { HandshakeResponse } from "../types.js";
import {
  classifyConnectionError,
  type ConnectionDiagnostics,
  type ConnectionErrorClass,
} from "../unity-client.js";

/**
 * The bridge protocol version this CLI/server build expects. Advertised by the
 * Unity bridge in `bridge.initialize` (`Handshake.cs#ProtocolVersion`) and gated
 * here at preflight. Exported so `loomtide install-bridge` can stamp the SAME
 * expectation into a project's `LoomtideInstall.json` — one source of truth, so
 * install metadata and the live preflight can never disagree.
 */
export const REQUIRED_PROTOCOL_VERSION = 1;
const MIN_SUPPORTED_PAYLOAD_BYTES = 1024;

const SCENARIO_PREFLIGHT_COMMAND_PREFIXES = ["runtime.", "input."];
const SCENARIO_PREFLIGHT_EXACT_COMMANDS = new Set([
  "editor.get_state",
  "editor.play",
  "editor.wait_for",
  "editor.screenshot",
]);

export interface PreflightBlocker {
  code: string;
  signature: string;
  message: string;
  remediation: string;
  details?: Record<string, unknown>;
}

export interface PreflightPrerequisiteCheck {
  id: string;
  passed: boolean;
  detail: string;
}

export interface PrerequisiteEvaluation {
  checks: PreflightPrerequisiteCheck[];
  blockers: PreflightBlocker[];
}

function toCategory(command: string): string {
  const [category = ""] = command.split(".", 1);
  return category.trim().toLowerCase();
}

function toUpperSignatureToken(value: string): string {
  return value
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    || "UNKNOWN";
}

export function shouldRunDeterministicPreflight(command: string): boolean {
  if (SCENARIO_PREFLIGHT_EXACT_COMMANDS.has(command)) {
    return true;
  }

  return SCENARIO_PREFLIGHT_COMMAND_PREFIXES.some((prefix) =>
    command.startsWith(prefix));
}

export function toConnectionBlockerSignature(errorClass: ConnectionErrorClass): string {
  switch (errorClass) {
    case "EPERM_LOOPBACK":
    case "EPERM":
      return "EPERM_LOOPBACK";
    case "ECONNREFUSED":
      return "ECONNREFUSED_NO_LISTENER";
    case "TIMEOUT":
      return "TIMEOUT_CONNECT";
    case "EHOSTUNREACH":
      return "EHOSTUNREACH_LOOPBACK";
    case "ENETUNREACH":
      return "ENETUNREACH_LOOPBACK";
    case "HANDSHAKE_ERROR":
      return "HANDSHAKE_FAILURE";
    case "EADDRNOTAVAIL":
      return "EADDRNOTAVAIL_LOOPBACK";
    default:
      return "CONNECTION_ERROR_GENERIC";
  }
}

function remediationForConnectionSignature(signature: string): string {
  switch (signature) {
    case "EPERM_LOOPBACK":
      return "Loopback socket access is blocked by host policy. Run on a host where localhost sockets are permitted.";
    case "ECONNREFUSED_NO_LISTENER":
      return "UnityBridge listener is unavailable. Open Unity project and confirm the bridge server is running.";
    case "TIMEOUT_CONNECT":
      return "Connection timed out. Verify firewall or VPN policy does not block local bridge traffic.";
    case "EHOSTUNREACH_LOOPBACK":
    case "ENETUNREACH_LOOPBACK":
    case "EADDRNOTAVAIL_LOOPBACK":
      return "Loopback networking is unavailable. Verify local host networking and Unity process locality.";
    case "HANDSHAKE_FAILURE":
      return "Handshake failed. Restart Unity and MCP server with compatible plugin/server versions.";
    default:
      return "Inspect preflight diagnostics and UnityBridge logs for connection details.";
  }
}

export function buildConnectionBlocker(
  diagnostics: ConnectionDiagnostics,
  message: string,
): PreflightBlocker {
  const signature = toConnectionBlockerSignature(diagnostics.lastErrorClass);
  return {
    code: "PREFLIGHT_CONNECTION_BLOCKED",
    signature,
    message: message.trim() || "Unity connection preflight failed.",
    remediation: remediationForConnectionSignature(signature),
    details: {
      transportMode: diagnostics.transportMode,
      selectedTransport: diagnostics.selectedTransport ?? "none",
      selectedEndpoint: diagnostics.selectedEndpoint ?? "none",
      attemptedEndpoints: diagnostics.attemptedEndpoints,
      attemptedPorts: diagnostics.attemptedPorts,
      errorClass: diagnostics.lastErrorClass,
      lastErrorMessage: diagnostics.lastErrorMessage,
    },
  };
}

export function buildGenericConnectionBlocker(error: unknown): PreflightBlocker {
  const message = error instanceof Error ? error.message : String(error);
  const errorClass = classifyConnectionError(error);
  const signature = toConnectionBlockerSignature(errorClass);
  return {
    code: "PREFLIGHT_CONNECTION_BLOCKED",
    signature,
    message,
    remediation: remediationForConnectionSignature(signature),
    details: {
      errorClass,
    },
  };
}

export function buildMissingHandshakeBlocker(command: string): PreflightBlocker {
  return {
    code: "PREFLIGHT_HANDSHAKE_REQUIRED",
    signature: "HANDSHAKE_REQUIRED",
    message: `No bridge handshake is available for command '${command}'.`,
    remediation: "Re-establish UnityBridge connection and retry after handshake completes.",
  };
}

export function deterministicBlockerSignature(blockers: PreflightBlocker[]): string {
  const signatures = Array.from(
    new Set(
      blockers
        .map((blocker) => blocker.signature)
        .filter((signature) => typeof signature === "string" && signature.length > 0),
    ),
  );
  signatures.sort();
  return signatures.length > 0 ? signatures.join("+") : "NONE";
}

export function evaluatePrerequisiteChecks(
  command: string,
  handshake: HandshakeResponse,
): PrerequisiteEvaluation {
  const checks: PreflightPrerequisiteCheck[] = [];
  const blockers: PreflightBlocker[] = [];
  const category = toCategory(command);

  const protocolVersionPassed = handshake.protocolVersion === REQUIRED_PROTOCOL_VERSION;
  checks.push({
    id: "prerequisite.protocol_version",
    passed: protocolVersionPassed,
    detail: `expected=${REQUIRED_PROTOCOL_VERSION}; actual=${handshake.protocolVersion}`,
  });
  if (!protocolVersionPassed) {
    blockers.push({
      code: "PREFLIGHT_PREREQUISITE_PROTOCOL_MISMATCH",
      signature: "PROTOCOL_VERSION_MISMATCH",
      message: `Protocol mismatch: expected ${REQUIRED_PROTOCOL_VERSION}, got ${handshake.protocolVersion}.`,
      remediation: "Upgrade UnityBridge package or MCP server to matching protocol versions.",
      details: {
        expected: REQUIRED_PROTOCOL_VERSION,
        actual: handshake.protocolVersion,
      },
    });
  }

  const maxPayloadPassed = handshake.capabilities.maxPayloadBytes >= MIN_SUPPORTED_PAYLOAD_BYTES;
  checks.push({
    id: "prerequisite.max_payload_bytes",
    passed: maxPayloadPassed,
    detail: `minimum=${MIN_SUPPORTED_PAYLOAD_BYTES}; actual=${handshake.capabilities.maxPayloadBytes}`,
  });
  if (!maxPayloadPassed) {
    blockers.push({
      code: "PREFLIGHT_PREREQUISITE_PAYLOAD_CAPACITY",
      signature: "PAYLOAD_CAPACITY_TOO_LOW",
      message: `Handshake maxPayloadBytes=${handshake.capabilities.maxPayloadBytes} is below required minimum ${MIN_SUPPORTED_PAYLOAD_BYTES}.`,
      remediation: "Upgrade UnityBridge package to a build with required payload capacity.",
      details: {
        minimum: MIN_SUPPORTED_PAYLOAD_BYTES,
        actual: handshake.capabilities.maxPayloadBytes,
      },
    });
  }

  const supportsCategory = handshake.capabilities.supportedCategories.includes(category);
  const runtimeCompatibilityFallback = category === "runtime" && !supportsCategory;
  const categoryPassed = supportsCategory || runtimeCompatibilityFallback;
  checks.push({
    id: "prerequisite.supported_category",
    passed: categoryPassed,
    detail: runtimeCompatibilityFallback
      ? `category='${category}' accepted via compatibility fallback for legacy handshake payloads`
      : `category='${category}' supported=${supportsCategory}`,
  });
  if (!categoryPassed) {
    const categoryToken = toUpperSignatureToken(category);
    blockers.push({
      code: "PREFLIGHT_PREREQUISITE_MISSING_CATEGORY",
      signature: `MISSING_CATEGORY_${categoryToken}`,
      message: `Handshake capability 'supportedCategories' does not include '${category}'.`,
      remediation: "Install/upgrade UnityBridge package so required command categories are advertised.",
      details: {
        command,
        category,
        supportedCategories: handshake.capabilities.supportedCategories,
      },
    });
  }

  const requiresGlobalObjectId = category === "runtime" || category === "component" || category === "scene";
  const globalObjectIdPassed = !requiresGlobalObjectId || handshake.capabilities.supportsGlobalObjectId === true;
  checks.push({
    id: "prerequisite.supports_global_object_id",
    passed: globalObjectIdPassed,
    detail: `required=${requiresGlobalObjectId}; supported=${handshake.capabilities.supportsGlobalObjectId}`,
  });
  if (!globalObjectIdPassed) {
    blockers.push({
      code: "PREFLIGHT_PREREQUISITE_GLOBAL_OBJECT_ID",
      signature: "GLOBAL_OBJECT_ID_UNSUPPORTED",
      message: "Handshake capability 'supportsGlobalObjectId' is false for a command that requires stable locators.",
      remediation: "Upgrade UnityBridge package to enable supportsGlobalObjectId.",
      details: {
        command,
        category,
      },
    });
  }

  return { checks, blockers };
}
