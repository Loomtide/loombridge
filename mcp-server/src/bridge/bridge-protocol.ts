import type { BridgeResponse, HandshakeResponse } from "../shared/types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/**
 * Parses and validates the minimum shape of a bridge response payload.
 * Throws with a descriptive error if the payload is malformed.
 */
export function parseBridgeResponse(raw: string): BridgeResponse {
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Bridge response is not valid JSON");
  }

  if (!isRecord(parsed)) {
    throw new Error("Bridge response must be a JSON object");
  }

  if (typeof parsed.id !== "string" || parsed.id.length === 0) {
    throw new Error("Bridge response missing a valid string id");
  }

  if (parsed.status !== "success" && parsed.status !== "error") {
    throw new Error("Bridge response status must be 'success' or 'error'");
  }

  if (typeof parsed.timestamp !== "number") {
    throw new Error("Bridge response missing numeric timestamp");
  }

  if ("error" in parsed && parsed.error != null) {
    if (!isRecord(parsed.error)) {
      throw new Error("Bridge response error field must be an object");
    }
    if (
      typeof parsed.error.code !== "string" ||
      typeof parsed.error.message !== "string"
    ) {
      throw new Error("Bridge response error object is malformed");
    }
  }

  const response: BridgeResponse = {
    id: parsed.id,
    status: parsed.status,
    data: "data" in parsed ? parsed.data : null,
    timestamp: parsed.timestamp,
  };

  if ("error" in parsed && parsed.error != null && isRecord(parsed.error)) {
    response.error = {
      code: parsed.error.code as string,
      message: parsed.error.message as string,
    };
  }

  // Preserve trace data (consoleDelta, artifacts) for TraceRecorder
  if ("trace" in parsed && isRecord(parsed.trace)) {
    response.trace = parsed.trace as BridgeResponse["trace"];
  }

  return response;
}

/**
 * Runtime validator for handshake payloads returned by bridge.initialize.
 */
export function isHandshakeResponseData(
  data: unknown
): data is HandshakeResponse {
  if (!isRecord(data)) return false;
  if (typeof data.engine !== "string") return false;
  if (typeof data.engineVersion !== "string") return false;
  if (typeof data.pluginVersion !== "string") return false;
  if (typeof data.port !== "number") return false;
  if (typeof data.protocolVersion !== "number") return false;
  if (typeof data.sessionId !== "string") return false;
  if ("projectPath" in data && typeof data.projectPath !== "string") return false;
  if ("projectPathCanonical" in data && typeof data.projectPathCanonical !== "string") return false;
  if ("projectName" in data && typeof data.projectName !== "string") return false;
  if ("processId" in data && typeof data.processId !== "number") return false;
  if (!isRecord(data.capabilities)) return false;

  const caps = data.capabilities;
  if (!isStringArray(caps.screenshotTargets)) return false;
  if (!isStringArray(caps.supportedCategories)) return false;
  if (typeof caps.maxPayloadBytes !== "number") return false;
  if (typeof caps.supportsAnimatorSpec !== "boolean") return false;
  if (typeof caps.supportsGlobalObjectId !== "boolean") return false;

  return true;
}
