import assert from "node:assert/strict";
import test from "node:test";
import {
  BridgePreflight,
  formatPreflightBlockedMessage,
} from "../../../bridge/preflight/bridge-preflight.js";
import type { HandshakeResponse } from "../../../shared/types.js";
import { UnityConnectionError, type ConnectionDiagnostics } from "../../../bridge/unity-client.js";

interface StubClientState {
  isConnected: boolean;
  handshake: HandshakeResponse | null;
  connectCalls: number;
}

class StubPreflightClient {
  private readonly _connectImpl: () => Promise<HandshakeResponse>;
  private readonly _state: StubClientState;

  constructor(
    connectImpl: () => Promise<HandshakeResponse>,
    initial: Partial<StubClientState> = {},
  ) {
    this._connectImpl = connectImpl;
    this._state = {
      isConnected: initial.isConnected ?? false,
      handshake: initial.handshake ?? null,
      connectCalls: 0,
    };
  }

  get isConnected(): boolean {
    return this._state.isConnected;
  }

  get handshake(): HandshakeResponse | null {
    return this._state.handshake;
  }

  get connectCalls(): number {
    return this._state.connectCalls;
  }

  async connect(): Promise<HandshakeResponse> {
    this._state.connectCalls += 1;
    const handshake = await this._connectImpl();
    this._state.isConnected = true;
    this._state.handshake = handshake;
    return handshake;
  }
}

function createHandshake(
  capabilityOverrides: Partial<HandshakeResponse["capabilities"]> = {},
  handshakeOverrides: Partial<HandshakeResponse> = {},
): HandshakeResponse {
  return {
    engine: "unity",
    engineVersion: "6000.3.0f1",
    pluginVersion: "0.1.0",
    port: 8200,
    protocolVersion: 1,
    sessionId: "session-preflight",
    capabilities: {
      screenshotTargets: ["scene", "game"],
      supportedCategories: ["scene", "editor", "component", "input", "runtime"],
      maxPayloadBytes: 5_242_880,
      supportsAnimatorSpec: true,
      supportsGlobalObjectId: true,
      ...capabilityOverrides,
    },
    ...handshakeOverrides,
  };
}

test("BridgePreflight: deterministic pass path validates handshake + prerequisites", async () => {
  const handshake = createHandshake();
  const client = new StubPreflightClient(async () => handshake);
  const preflight = new BridgePreflight(client);

  const result = await preflight.run("runtime.assert_condition");
  assert.equal(result.status, "pass");
  assert.equal(result.blockerSignature, "NONE");
  assert.equal(result.sessionReady, true);
  assert.equal(result.handshakeReady, true);
  assert.equal(client.connectCalls, 1);
  assert.ok(result.prerequisites.length >= 3, "expected prerequisite checks");
});

test("BridgePreflight: missing prerequisite emits deterministic blocked signature", async () => {
  const handshake = createHandshake({
    supportedCategories: ["scene", "editor", "component", "runtime"],
  });
  const client = new StubPreflightClient(
    async () => handshake,
    {
      isConnected: true,
      handshake,
    },
  );
  const preflight = new BridgePreflight(client);

  const result = await preflight.run("input.key_tap");
  assert.equal(result.status, "blocked");
  assert.equal(result.blockerSignature, "MISSING_CATEGORY_INPUT");
  assert.equal(result.blockers[0]?.code, "PREFLIGHT_PREREQUISITE_MISSING_CATEGORY");

  const message = formatPreflightBlockedMessage(result);
  assert.match(message, /deterministic scenario preflight blocked/i);
  const payloadText = message.replace(/^deterministic scenario preflight blocked:\s*/i, "");
  const payload = JSON.parse(payloadText) as {
    blockerSignature: string;
    status: string;
  };
  assert.equal(payload.status, "blocked");
  assert.equal(payload.blockerSignature, "MISSING_CATEGORY_INPUT");
});

test("BridgePreflight: disconnected host produces blocked connection signature", async () => {
  const diagnostics: ConnectionDiagnostics = {
    transportMode: "auto",
    attemptedEndpoints: ["legacy_port_probe:8200"],
    failedEndpoints: [],
    selectedTransport: null,
    selectedEndpoint: null,
    attemptedPorts: [8200],
    failedPorts: [],
    lastErrorClass: "EPERM_LOOPBACK",
    lastErrorMessage: "connect EPERM [::1]:8200",
  };

  const client = new StubPreflightClient(async () => {
    throw new UnityConnectionError("connect failed", diagnostics);
  });
  const preflight = new BridgePreflight(client);

  const result = await preflight.run("runtime.wait_for_condition");
  assert.equal(result.status, "blocked");
  assert.equal(result.sessionReady, false);
  assert.equal(result.handshakeReady, false);
  assert.equal(result.blockerSignature, "EPERM_LOOPBACK");
  assert.equal(result.blockers[0]?.code, "PREFLIGHT_CONNECTION_BLOCKED");
});
