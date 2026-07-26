import assert from "node:assert/strict";
import test from "node:test";
import {
  isHandshakeResponseData,
  parseBridgeResponse,
} from "../bridge/bridge-protocol.js";

test("parseBridgeResponse parses a valid success payload", () => {
  const json = JSON.stringify({
    id: "abc-123",
    status: "success",
    data: { pong: true },
    timestamp: Date.now(),
  });

  const response = parseBridgeResponse(json);

  assert.equal(response.id, "abc-123");
  assert.equal(response.status, "success");
});

test("parseBridgeResponse rejects invalid JSON", () => {
  assert.throws(
    () => parseBridgeResponse("{invalid"),
    /not valid JSON/i
  );
});

test("parseBridgeResponse rejects payload with missing id", () => {
  const json = JSON.stringify({
    status: "success",
    timestamp: Date.now(),
  });

  assert.throws(
    () => parseBridgeResponse(json),
    /valid string id/i
  );
});

test("isHandshakeResponseData returns true for valid payload", () => {
  const payload = {
    engine: "unity",
    engineVersion: "2022.3.0f1",
    pluginVersion: "0.1.0",
    port: 8200,
    protocolVersion: 1,
    sessionId: "session-1",
    capabilities: {
      screenshotTargets: ["scene", "game"],
      supportedCategories: ["scene", "editor"],
      maxPayloadBytes: 1024,
      supportsAnimatorSpec: true,
      supportsGlobalObjectId: true,
    },
  };

  assert.equal(isHandshakeResponseData(payload), true);
});

test("isHandshakeResponseData accepts optional project identity fields", () => {
  const payload = {
    engine: "unity",
    engineVersion: "6000.3.9f1",
    pluginVersion: "0.1.0",
    port: 8200,
    protocolVersion: 1,
    sessionId: "session-1",
    projectPath: "/Users/dev/Game",
    projectPathCanonical: "/Users/dev/Game",
    projectName: "Game",
    processId: 12345,
    capabilities: {
      screenshotTargets: ["scene", "game"],
      supportedCategories: ["scene", "editor"],
      maxPayloadBytes: 1024,
      supportsAnimatorSpec: true,
      supportsGlobalObjectId: true,
    },
  };

  assert.equal(isHandshakeResponseData(payload), true);
});

test("isHandshakeResponseData rejects malformed optional project identity fields", () => {
  const payload = {
    engine: "unity",
    engineVersion: "6000.3.9f1",
    pluginVersion: "0.1.0",
    port: 8200,
    protocolVersion: 1,
    sessionId: "session-1",
    projectPathCanonical: 12345,
    capabilities: {
      screenshotTargets: ["scene", "game"],
      supportedCategories: ["scene", "editor"],
      maxPayloadBytes: 1024,
      supportsAnimatorSpec: true,
      supportsGlobalObjectId: true,
    },
  };

  assert.equal(isHandshakeResponseData(payload), false);
});

test("parseBridgeResponse preserves trace data", () => {
  const json = JSON.stringify({
    id: "trace-test",
    status: "success",
    data: { name: "Player" },
    trace: {
      consoleDelta: [{ type: "Log", message: "Created object" }],
      artifacts: [{ kind: "screenshot", sourcePath: "/tmp/shot.jpg" }],
    },
    timestamp: Date.now(),
  });

  const response = parseBridgeResponse(json);

  assert.ok(response.trace, "trace should be preserved");
  assert.equal(response.trace!.consoleDelta.length, 1);
  assert.equal(response.trace!.consoleDelta[0].message, "Created object");
  assert.equal(response.trace!.artifacts!.length, 1);
  assert.equal(response.trace!.artifacts![0].kind, "screenshot");
});

test("parseBridgeResponse omits trace when not present", () => {
  const json = JSON.stringify({
    id: "no-trace",
    status: "success",
    data: null,
    timestamp: Date.now(),
  });

  const response = parseBridgeResponse(json);
  assert.equal(response.trace, undefined);
});

test("isHandshakeResponseData returns false for malformed payload", () => {
  const payload = {
    engine: "unity",
    engineVersion: "2022.3.0f1",
    pluginVersion: "0.1.0",
    port: 8200,
    protocolVersion: 1,
    sessionId: "session-1",
    capabilities: {
      screenshotTargets: ["scene", "game"],
      supportedCategories: ["scene", "editor"],
      maxPayloadBytes: "1024",
      supportsAnimatorSpec: true,
      supportsGlobalObjectId: true,
    },
  };

  assert.equal(isHandshakeResponseData(payload), false);
});
