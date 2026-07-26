import assert from "node:assert/strict";
import test from "node:test";

// We test the pure logic parts of UnityClient without needing a real WebSocket.
// The class is imported after it's created.

// --- Test helpers ---

/**
 * Computes expected backoff delay for a given attempt number.
 * Backoff: 500, 1000, 2000, 4000, 8000, 10000, 10000...
 */
function expectedBackoff(attempt: number): number {
  return Math.min(500 * Math.pow(2, attempt), 10000);
}

type HandshakeFixture = {
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
};

function handshakeFixture(port = 8200, overrides: Partial<HandshakeFixture> = {}): HandshakeFixture {
  return {
    engine: "unity",
    engineVersion: "6000.3.9f1",
    pluginVersion: "0.1.0",
    port,
    protocolVersion: 1,
    sessionId: "test-session",
    projectPath: "/Users/dev/GameA",
    projectPathCanonical: "/Users/dev/GameA",
    projectName: "GameA",
    processId: 12345,
    capabilities: {
      screenshotTargets: ["scene", "game"],
      supportedCategories: ["scene", "editor"],
      maxPayloadBytes: 5242880,
      supportsAnimatorSpec: true,
      supportsGlobalObjectId: true,
    },
    ...overrides,
  };
}

function discoveryFixture(overrides?: Partial<{
  sessionId: string;
  transportModeDefault: "auto" | "ipc" | "tcp";
  endpoints: Array<{
    transport: "ipc" | "tcp";
    kind: "unix_domain_socket" | "named_pipe" | "websocket";
    path?: string;
      host?: string;
      port?: number;
      supportsHandshake?: boolean;
      supportsPing?: boolean;
  }>;
}>) {
  const endpoints = (overrides?.endpoints ?? [
    {
      transport: "ipc",
      kind: "unix_domain_socket",
      path: "/tmp/loombridge/bridge-test.sock",
      supportsHandshake: true,
      supportsPing: true,
    },
    {
      transport: "tcp",
      kind: "websocket",
      host: "localhost",
      port: 8200,
      supportsHandshake: true,
      supportsPing: true,
    },
  ]).map((endpoint) => ({
    ...endpoint,
    supportsHandshake: endpoint.supportsHandshake ?? true,
    supportsPing: endpoint.supportsPing ?? true,
  }));

  return {
    schemaVersion: "1",
    sessionId: overrides?.sessionId ?? "discovery-session",
    publishedAtUnixMs: Date.now(),
    expiresAtUnixMs: Date.now() + 60_000,
    transportModeDefault: overrides?.transportModeDefault ?? "auto",
    endpoints,
  };
}

function createMockSocket() {
  const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  const onceHandlers = new Map<string, Array<(...args: unknown[]) => void>>();

  const addHandler = (
    bucket: Map<string, Array<(...args: unknown[]) => void>>,
    event: string,
    handler: (...args: unknown[]) => void,
  ) => {
    const existing = bucket.get(event) ?? [];
    existing.push(handler);
    bucket.set(event, existing);
  };

  const socket = {
    readyState: 1,
    on(event: string, handler: (...args: unknown[]) => void) {
      addHandler(handlers, event, handler);
      return socket;
    },
    once(event: string, handler: (...args: unknown[]) => void) {
      addHandler(onceHandlers, event, handler);
      return socket;
    },
    removeListener(event: string, handler: (...args: unknown[]) => void) {
      const removeFrom = (bucket: Map<string, Array<(...args: unknown[]) => void>>) => {
        const list = bucket.get(event);
        if (!list) return;
        bucket.set(event, list.filter((entry) => entry !== handler));
      };
      removeFrom(handlers);
      removeFrom(onceHandlers);
      return socket;
    },
    removeAllListeners() {
      handlers.clear();
      onceHandlers.clear();
      return socket;
    },
    terminate() {
      socket.readyState = 3;
    },
    ping() {
      // no-op in tests
    },
    send(_payload: string, cb?: (err?: Error) => void) {
      cb?.();
    },
    close(_code?: number, _reason?: string) {
      socket.readyState = 3;
      socket.emit("close", 1000, Buffer.from("closed"));
    },
    emit(event: string, ...args: unknown[]) {
      for (const handler of handlers.get(event) ?? []) {
        handler(...args);
      }
      const once = onceHandlers.get(event) ?? [];
      onceHandlers.delete(event);
      for (const handler of once) {
        handler(...args);
      }
    },
  };

  return socket;
}

// --- Tests for backoff calculation ---

test("backoff calculation: attempt 0 = 500ms", () => {
  assert.equal(expectedBackoff(0), 500);
});

test("backoff calculation: attempt 1 = 1000ms", () => {
  assert.equal(expectedBackoff(1), 1000);
});

test("backoff calculation: attempt 2 = 2000ms", () => {
  assert.equal(expectedBackoff(2), 2000);
});

test("backoff calculation: attempt 3 = 4000ms", () => {
  assert.equal(expectedBackoff(3), 4000);
});

test("backoff calculation: attempt 4 = 8000ms", () => {
  assert.equal(expectedBackoff(4), 8000);
});

test("backoff calculation: attempt 5 = 10000ms (capped)", () => {
  assert.equal(expectedBackoff(5), 10000);
});

test("backoff calculation: attempt 6 = 10000ms (stays capped)", () => {
  assert.equal(expectedBackoff(6), 10000);
});

// --- Tests for port range ---

test("port range generation covers 8200-8210", () => {
  const ports: number[] = [];
  for (let p = 8200; p <= 8210; p++) {
    ports.push(p);
  }
  assert.equal(ports.length, 11);
  assert.equal(ports[0], 8200);
  assert.equal(ports[ports.length - 1], 8210);
});

// --- Import UnityClient for state machine tests ---

import {
  UnityClient,
  classifyConnectionError,
  formatConnectionDiagnostics,
  ipcWebSocketUrl,
  isRouteMismatchError,
} from "../bridge/unity-client.js";

// --- IPC transport URL ---

test("ipcWebSocketUrl: emits the ws+unix form ws accepts, keeping native separators", () => {
  // A Windows named pipe must keep its backslashes; POSIX-ifying it yields ENOENT.
  assert.equal(
    ipcWebSocketUrl("\\\\.\\pipe\\loombridge-bridge-abc"),
    "ws+unix:\\\\.\\pipe\\loombridge-bridge-abc:/",
  );
  assert.equal(ipcWebSocketUrl("/tmp/loombridge.sock"), "ws+unix:/tmp/loombridge.sock:/");
});

test("ipcWebSocketUrl: single colon separator, never the invalid ws+unix:// form", () => {
  const url = ipcWebSocketUrl("/tmp/loombridge.sock");
  assert.ok(!url.startsWith("ws+unix://"), "ws+unix:// is not a parseable URL");
  assert.ok(url.endsWith(":/"), "ws expects <path>:<httpPath>");
});

// --- AggregateError unwrapping (Node's dual-stack localhost connect failure) ---

test("classifyConnectionError: unwraps AggregateError instead of reporting UNKNOWN", () => {
  const sub = Object.assign(new Error("connect ECONNREFUSED ::1:80"), { code: "ECONNREFUSED" });
  const agg = new AggregateError([sub], ""); // Node leaves .message empty
  assert.equal(classifyConnectionError(agg), "ECONNREFUSED");
});

test("classifyConnectionError: falls back to .code when the message is empty", () => {
  const bare = Object.assign(new Error(""), { code: "ETIMEDOUT" });
  assert.equal(classifyConnectionError(bare), "TIMEOUT");
});

test("isRouteMismatchError: detects ROUTE_MISMATCH and ignores other errors", () => {
  assert.equal(isRouteMismatchError(new Error("ROUTE_MISMATCH: wrong project")), true);
  assert.equal(isRouteMismatchError(new Error("ECONNREFUSED 127.0.0.1:8200")), false);
  assert.equal(isRouteMismatchError("nope"), false);
});

test("UnityClient: pins to LOOMBRIDGE_TARGET_PROJECT_PATH when no explicit targetIdentity is given", () => {
  const prev = process.env.LOOMBRIDGE_TARGET_PROJECT_PATH;
  try {
    process.env.LOOMBRIDGE_TARGET_PROJECT_PATH = "/Users/dev/GameA/";
    // Trailing slash is normalized away by normalizeProjectPathCanonical.
    assert.equal(new UnityClient().pinnedProjectPathCanonical, "/Users/dev/GameA");
  } finally {
    if (prev === undefined) delete process.env.LOOMBRIDGE_TARGET_PROJECT_PATH;
    else process.env.LOOMBRIDGE_TARGET_PROJECT_PATH = prev;
  }
});

test("UnityClient: an explicit targetIdentity wins over the env pin", () => {
  const prev = process.env.LOOMBRIDGE_TARGET_PROJECT_PATH;
  try {
    process.env.LOOMBRIDGE_TARGET_PROJECT_PATH = "/Users/dev/GameA";
    const client = new UnityClient({ targetIdentity: { projectPathCanonical: "/Users/dev/GameB" } });
    assert.equal(client.pinnedProjectPathCanonical, "/Users/dev/GameB");
  } finally {
    if (prev === undefined) delete process.env.LOOMBRIDGE_TARGET_PROJECT_PATH;
    else process.env.LOOMBRIDGE_TARGET_PROJECT_PATH = prev;
  }
});

test("UnityClient: no env pin and no targetIdentity → unpinned (back-compat)", () => {
  const prev = process.env.LOOMBRIDGE_TARGET_PROJECT_PATH;
  try {
    delete process.env.LOOMBRIDGE_TARGET_PROJECT_PATH;
    assert.equal(new UnityClient().pinnedProjectPathCanonical, null);
  } finally {
    if (prev !== undefined) process.env.LOOMBRIDGE_TARGET_PROJECT_PATH = prev;
  }
});

test("UnityClient: abandons auto-reconnect after repeated ROUTE_MISMATCH (M1)", async () => {
  const client = new UnityClient({
    targetIdentity: { projectPathCanonical: "/Users/dev/GameA" },
  }) as unknown as {
    connect: () => Promise<unknown>;
    _getBackoffMs: (n: number) => number;
    _attemptReconnect: () => Promise<void>;
    _sawRouteMismatch: boolean;
    reconnectAbandoned: boolean;
  };

  let calls = 0;
  client._getBackoffMs = () => 0;
  client.connect = async () => {
    calls += 1;
    client._sawRouteMismatch = true;
    throw new Error("ROUTE_MISMATCH: connected editor projectPathCanonical=/Users/dev/GameB");
  };

  await client._attemptReconnect();

  assert.equal(client.reconnectAbandoned, true);
  assert.equal(calls, 5); // MAX_ROUTE_MISMATCH_RECONNECTS — bounded, not infinite
});

test("UnityClient: send() throws if not connected", async () => {
  const client = new UnityClient();
  await assert.rejects(
    () => client.send("scene.create_object", {}),
    (err: Error) => {
      assert.match(err.message, /not connected/i);
      return true;
    }
  );
});

test("UnityClient: send() waits for an in-flight reconnect before transmitting a not-yet-sent op", async () => {
  const client = new UnityClient();
  const internal = client as unknown as {
    _ws: unknown;
    _reconnecting: boolean;
    _handshakeComplete: boolean;
    _pendingOps: Map<string, unknown>;
    _rejectAllPending(reason: string): void;
  };

  // Simulate a play-mode domain reload: socket torn down, auto-reconnect in flight.
  internal._ws = null;
  internal._reconnecting = true;
  internal._handshakeComplete = false;

  // The reconnect settles shortly after send() starts waiting.
  setTimeout(() => {
    internal._ws = createMockSocket();
    internal._handshakeComplete = true;
    internal._reconnecting = false;
  }, 60);

  const p = client.send("scene.find_object", { locator: "x" }, 5000);

  // Once the op registers (i.e. it transmitted instead of throwing), clear it so the
  // pending promise/timer don't leak past the test.
  void (async () => {
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && internal._pendingOps.size === 0) {
      await new Promise((r) => setTimeout(r, 10));
    }
    internal._rejectAllPending("test cleanup");
  })();

  await assert.rejects(p, (err: Error) => {
    assert.doesNotMatch(err.message, /not connected/i, "should wait for the reconnect, not throw immediately");
    return true;
  });
  assert.equal(internal._pendingOps.size, 0);
});

test("UnityClient: send() rejects after a bounded wait if the reconnect never completes", async () => {
  const client = new UnityClient();
  const internal = client as unknown as {
    _ws: unknown;
    _reconnecting: boolean;
    _handshakeComplete: boolean;
  };
  internal._ws = null;
  internal._reconnecting = true; // in flight, but never settles
  internal._handshakeComplete = false;

  const start = Date.now();
  await assert.rejects(
    () => client.send("scene.find_object", {}, 400),
    (err: Error) => {
      assert.match(err.message, /not connected/i);
      return true;
    },
  );
  const elapsed = Date.now() - start;
  assert.ok(elapsed >= 300, `should wait ~the op timeout before giving up (waited ${elapsed}ms)`);
});

test("UnityClient: send() does not wait for reconnect once it is abandoned", async () => {
  const client = new UnityClient();
  const internal = client as unknown as {
    _ws: unknown;
    _reconnecting: boolean;
    _reconnectAbandoned: boolean;
    _handshakeComplete: boolean;
  };
  internal._ws = null;
  internal._reconnecting = true;
  internal._reconnectAbandoned = true; // gave up — don't block on it
  internal._handshakeComplete = false;

  const start = Date.now();
  await assert.rejects(
    () => client.send("scene.find_object", {}, 5000),
    (err: Error) => {
      assert.match(err.message, /not connected/i);
      return true;
    },
  );
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 200, `should throw immediately when abandoned (waited ${elapsed}ms)`);
});

test("UnityClient: send() does not transmit when the reconnect consumed the whole timeout budget", async () => {
  const client = new UnityClient();
  const internal = client as unknown as {
    _ws: unknown;
    _reconnecting: boolean;
    _handshakeComplete: boolean;
    _pendingOps: Map<string, unknown>;
  };
  internal._ws = null;
  internal._reconnecting = true;
  internal._handshakeComplete = false;

  const socket = createMockSocket();
  let sendCalled = false;
  socket.send = (_payload: string, cb?: (err?: Error) => void) => {
    sendCalled = true;
    cb?.();
  };

  // Reconnect completes, but only after the op's 200ms budget is already spent
  // (waitForReconnect polls at 250ms, so it reports connected just past the deadline).
  setTimeout(() => {
    internal._ws = socket;
    internal._handshakeComplete = true;
    internal._reconnecting = false;
  }, 180);

  await assert.rejects(
    () => client.send("scene.create_object", { name: "Boom" }, 200),
    (err: Error) => {
      // A mutating op must report timeout WITHOUT being transmitted — not "not connected".
      assert.match(err.message, /timeout/i);
      assert.doesNotMatch(err.message, /not connected/i);
      return true;
    },
  );
  assert.equal(sendCalled, false, "must not transmit a mutating op after the budget is exhausted");
  assert.equal(internal._pendingOps.size, 0, "no pending op should be registered");
});

test("UnityClient: send() does not transmit if the budget elapses during synchronous request build", async () => {
  const client = new UnityClient();
  const internal = client as unknown as {
    _ws: unknown;
    _handshakeComplete: boolean;
    _pendingOps: Map<string, unknown>;
  };
  const socket = createMockSocket();
  let sendCalled = false;
  socket.send = (_payload: string, cb?: (err?: Error) => void) => {
    sendCalled = true;
    cb?.();
  };
  internal._ws = socket; // already connected + handshaken (no reconnect/handshake wait)
  internal._handshakeComplete = true;

  // Drive Date.now so the pre-send budget checks pass, but the clock jumps past the
  // deadline exactly when responseTimeoutMs is computed (the narrow build-window edge).
  const realNow = Date.now;
  const T = realNow();
  const seq = [T, T + 10, T + 10, T + 1001]; // deadline, check#1, check#2, responseTimeoutMs
  let i = 0;
  Date.now = () => (i < seq.length ? seq[i++] : T + 1001);
  try {
    await assert.rejects(
      () => client.send("scene.create_object", { name: "Boom" }, 1000),
      (err: Error) => {
        assert.match(err.message, /timeout/i);
        return true;
      },
    );
  } finally {
    Date.now = realNow;
  }
  assert.equal(sendCalled, false, "must not transmit once the budget elapsed during build");
  assert.equal(internal._pendingOps.size, 0, "no pending op should be registered");
});

test("UnityClient: disconnect rejects pending ops", async () => {
  const client = new UnityClient();

  // Access the internal pending ops map to simulate a pending op
  const pendingOps = (client as unknown as { _pendingOps: Map<string, { resolve: Function; reject: Function; startTime: number }> })._pendingOps;

  let rejectedError: Error | null = null;
  const promise = new Promise<void>((_resolve, reject) => {
    pendingOps.set("test-id-123", {
      resolve: _resolve,
      reject: (err: Error) => {
        rejectedError = err;
        reject(err);
      },
      startTime: Date.now(),
    });
  });

  // Call the internal reject method
  (client as unknown as { _rejectAllPending(reason: string): void })._rejectAllPending("test disconnect");

  await assert.rejects(() => promise, (err: Error) => {
    assert.match(err.message, /CONNECTION_LOST|test disconnect/i);
    return true;
  });

  assert.equal(pendingOps.size, 0);
});

test("UnityClient: request IDs are valid UUIDs", () => {
  // Test the UUID generation pattern used internally
  const id = crypto.randomUUID();
  // UUID v4 pattern: 8-4-4-4-12 hex chars
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  assert.match(id, uuidRegex);
});

test("UnityClient: getBackoffMs returns correct values", () => {
  const client = new UnityClient();
  const getBackoff = (client as unknown as { _getBackoffMs(attempt: number): number })._getBackoffMs.bind(client);

  assert.equal(getBackoff(0), 500);
  assert.equal(getBackoff(1), 1000);
  assert.equal(getBackoff(2), 2000);
  assert.equal(getBackoff(3), 4000);
  assert.equal(getBackoff(4), 8000);
  assert.equal(getBackoff(5), 10000);
  assert.equal(getBackoff(6), 10000);
  assert.equal(getBackoff(10), 10000);
});

test("UnityClient: getPortRange returns 8200-8210", () => {
  const client = new UnityClient();
  const getPortRange = (client as unknown as { _getPortRange(): number[] })._getPortRange.bind(client);

  const ports = getPortRange();
  assert.equal(ports.length, 11);
  assert.equal(ports[0], 8200);
  assert.equal(ports[10], 8210);
});

test("UnityClient: getPortRange puts cached port first", () => {
  const client = new UnityClient();
  // Set the cached active port
  (client as unknown as { _activePort: number | null })._activePort = 8205;
  const getPortRange = (client as unknown as { _getPortRange(): number[] })._getPortRange.bind(client);

  const ports = getPortRange();
  assert.equal(ports[0], 8205);
  // Should still contain all ports, with 8205 first
  assert.equal(ports.length, 11);
  // 8205 should only appear once
  assert.equal(ports.filter((p: number) => p === 8205).length, 1);
});

test("UnityClient: probe host order defaults with localhost first and loopback fallback", () => {
  const client = new UnityClient() as unknown as {
    _getProbeUrls: (port: number) => string[];
  };

  const urls = client._getProbeUrls(8200);
  assert.deepEqual(urls, [
    "ws://localhost:8200",
    "ws://127.0.0.1:8200",
    "ws://[::1]:8200",
  ]);
});

test("UnityClient: probe host order prioritizes previously successful host", () => {
  const client = new UnityClient() as unknown as {
    _preferredProbeHost: string | null;
    _getProbeUrls: (port: number) => string[];
  };
  client._preferredProbeHost = "127.0.0.1";

  const urls = client._getProbeUrls(8200);
  assert.deepEqual(urls, [
    "ws://127.0.0.1:8200",
    "ws://localhost:8200",
    "ws://[::1]:8200",
  ]);
});

test("UnityClient: discovery candidates in auto mode prioritize ipc endpoints before tcp", () => {
  const client = new UnityClient() as unknown as {
    _buildDiscoveryCandidates: (
      mode: "auto" | "ipc" | "tcp",
      discovery: ReturnType<typeof discoveryFixture>,
    ) => Array<{ transport: "ipc" | "tcp"; endpoint: string }>;
  };

  const discovery = discoveryFixture({
    endpoints: [
      {
        transport: "tcp",
        kind: "websocket",
        host: "localhost",
        port: 8200,
      },
      {
        transport: "ipc",
        kind: "unix_domain_socket",
        path: "/tmp/loombridge/bridge-priority.sock",
      },
    ],
  });

  const candidates = client._buildDiscoveryCandidates("auto", discovery);
  assert.equal(candidates[0]?.transport, "ipc");
  assert.equal(candidates[1]?.transport, "tcp");
});

test("UnityClient: ipc mode fails fast when endpoint discovery is unavailable", async () => {
  const client = new UnityClient() as unknown as {
    _resolveTransportMode: () => "ipc";
    _loadEndpointDiscovery: () => null;
    connect: () => Promise<unknown>;
  };

  client._resolveTransportMode = () => "ipc";
  client._loadEndpointDiscovery = () => null;

  await assert.rejects(
    () => client.connect(),
    (err: Error) => {
      assert.match(err.message, /ipc mode requires endpoint discovery/i);
      // A preflight refusal (nothing dialed) must classify as NO_ENDPOINT, not UNKNOWN.
      assert.match(err.message, /error class:\s*NO_ENDPOINT/i);
      return true;
    },
  );
});

test("UnityClient: ipc mode over a tcp-only discovery (macOS) refuses as NO_ENDPOINT", async () => {
  // macOS/Linux editors publish only a tcp endpoint (Mono lacks the unix-domain-socket
  // API), so forcing ipc mode finds no ipc candidate and must fail fast + legibly.
  const client = new UnityClient() as unknown as {
    _resolveTransportMode: () => "ipc";
    _loadEndpointDiscovery: () => ReturnType<typeof discoveryFixture>;
    connect: () => Promise<unknown>;
  };

  client._resolveTransportMode = () => "ipc";
  client._loadEndpointDiscovery = () => discoveryFixture({
    endpoints: [{ transport: "tcp", kind: "websocket", host: "localhost", port: 8200 }],
  });

  await assert.rejects(
    () => client.connect(),
    (err: Error) => {
      assert.match(err.message, /ipc mode requires discovery record with at least one ipc endpoint/i);
      assert.match(err.message, /error class:\s*NO_ENDPOINT/i);
      return true;
    },
  );
});

test("UnityClient: auto mode attempts discovery ipc endpoint before discovered tcp endpoint", async () => {
  const client = new UnityClient() as unknown as {
    _resolveTransportMode: () => "auto";
    _loadEndpointDiscovery: () => ReturnType<typeof discoveryFixture>;
    _connectToUrl: (url: string, label: string, socketPath?: string) => Promise<unknown>;
    _performHandshake: (ws: unknown) => Promise<unknown>;
    _startHeartbeat: () => void;
    _connectToPort: (port: number) => Promise<unknown>;
    connect: () => Promise<{ sessionId: string }>;
  };

  const attempts: string[] = [];
  client._resolveTransportMode = () => "auto";
  client._loadEndpointDiscovery = () => discoveryFixture({
    endpoints: [
      {
        transport: "ipc",
        kind: "unix_domain_socket",
        path: "/tmp/loombridge/bridge-discovery.sock",
      },
      {
        transport: "tcp",
        kind: "websocket",
        host: "localhost",
        port: 8200,
      },
    ],
  });
  client._connectToUrl = async (_url: string, label: string, _socketPath?: string) => {
    attempts.push(label);
    if (label.includes("unix_domain_socket")) {
      throw new Error("simulated ipc connect failure");
    }
    return createMockSocket();
  };
  client._performHandshake = async () => handshakeFixture();
  client._startHeartbeat = () => {};
  client._connectToPort = async () => {
    throw new Error("legacy probe should not run when discovered tcp endpoint succeeds");
  };

  const handshake = await client.connect();
  assert.equal(handshake.sessionId, "test-session");
  assert.equal(attempts.length >= 2, true, `expected at least 2 discovery attempts, got ${attempts.join(" | ")}`);
  assert.match(attempts[0] ?? "", /unix_domain_socket/i);
  assert.match(attempts[1] ?? "", /websocket/i);
});

test("UnityClient: handshake data is null before connect", () => {
  const client = new UnityClient();
  assert.equal(client.handshake, null);
});

test("UnityClient: isConnected is false before connect", () => {
  const client = new UnityClient();
  assert.equal(client.isConnected, false);
});

test("UnityClient: classifyConnectionError identifies common network classes", () => {
  assert.equal(classifyConnectionError(new Error("connect EPERM 127.0.0.1:8200")), "EPERM");
  assert.equal(classifyConnectionError(new Error("preflight blocked: EPERM_LOOPBACK")), "EPERM_LOOPBACK");
  assert.equal(classifyConnectionError(new Error("connect ECONNREFUSED 127.0.0.1:8200")), "ECONNREFUSED");
  assert.equal(classifyConnectionError(new Error("Connection timeout on port 8200")), "TIMEOUT");
});

test("UnityClient: formatConnectionDiagnostics returns preflight summary fields", () => {
  const text = formatConnectionDiagnostics({
    transportMode: "auto",
    attemptedEndpoints: ["legacy_port_probe:8200", "legacy_port_probe:8201"],
    failedEndpoints: [
      {
        transport: "tcp",
        kind: "legacy_port_probe",
        endpoint: "legacy_port_probe:8200",
        errorClass: "ECONNREFUSED",
        message: "connect ECONNREFUSED",
      },
    ],
    selectedTransport: null,
    selectedEndpoint: null,
    attemptedPorts: [8200, 8201],
    failedPorts: [
      {
        port: 8200,
        hostAttempts: [
          { url: "ws://127.0.0.1:8200", errorClass: "ECONNREFUSED", message: "connect ECONNREFUSED" },
        ],
      },
    ],
    lastErrorClass: "ECONNREFUSED",
    lastErrorMessage: "connect ECONNREFUSED 127.0.0.1:8200",
  });

  assert.match(text, /preflight blocked/i);
  assert.match(text, /error class:\s*ECONNREFUSED/i);
  assert.match(text, /attempted ports:\s*8200,\s*8201/i);
  assert.match(text, /host attempts:\s*ws:\/\/127\.0\.0\.1:8200 \(ECONNREFUSED\)/i);
});

test("UnityClient: connect failure includes attempted ports and per-port diagnostics", async () => {
  const client = new UnityClient() as unknown as {
    _activePort: number | null;
    _resolveTransportMode: () => "tcp";
    _loadEndpointDiscovery: () => null;
    _connectToPort: (port: number) => Promise<never>;
    connect: () => Promise<unknown>;
  };
  client._activePort = 8205;
  client._resolveTransportMode = () => "tcp";
  client._loadEndpointDiscovery = () => null;
  client._connectToPort = async (port: number) => {
    throw new Error(`simulated connect failure for ${port}`);
  };

  await assert.rejects(
    () => client.connect(),
    (err: Error) => {
      assert.match(err.message, /attempted order: 8205, 8200, 8201/i);
      assert.match(err.message, /preflight blocked/i);
      assert.match(err.message, /error class:\s*UNKNOWN/i);
      assert.match(err.message, /port 8205: UNKNOWN: simulated connect failure for 8205/i);
      assert.match(err.message, /port 8210: UNKNOWN: simulated connect failure for 8210/i);
      return true;
    }
  );
});

test("UnityClient: connectToPort failure reports loopback host attempts", async () => {
  const client = new UnityClient() as unknown as {
    _connectToUrl: (url: string, port: number) => Promise<never>;
    _connectToPort: (port: number) => Promise<unknown>;
  };

  client._connectToUrl = async (url: string) => {
    throw new Error(`socket refused for ${url}`);
  };

  await assert.rejects(
    () => client._connectToPort(8200),
    (err: Error) => {
      assert.match(err.message, /ws:\/\/\[::1\]:8200/i);
      assert.match(err.message, /ws:\/\/127\.0\.0\.1:8200/i);
      assert.match(err.message, /ws:\/\/localhost:8200/i);
      return true;
    }
  );
});

test("UnityClient: connect failure reports EPERM_LOOPBACK for deterministic loopback blocks", async () => {
  const client = new UnityClient() as unknown as {
    _connectToUrl: (url: string, port: number) => Promise<never>;
    connect: () => Promise<unknown>;
  };
  client._connectToUrl = async (url: string) => {
    if (url.includes("localhost")) {
      throw new Error("unknown error");
    }
    throw new Error(`connect EPERM blocked by local policy ${url}`);
  };

  await assert.rejects(
    () => client.connect(),
    (err: Error) => {
      assert.match(err.message, /error class:\s*EPERM_LOOPBACK/i);
      return true;
    },
  );
});

test("UnityClient: connectToPort promotes successful fallback host for future probes", async () => {
  const client = new UnityClient() as unknown as {
    _preferredProbeHost: string | null;
    _connectToUrl: (url: string, port: number) => Promise<unknown>;
    _connectToPort: (port: number) => Promise<unknown>;
  };

  client._preferredProbeHost = null;
  client._connectToUrl = async (url: string) => {
    if (url.includes("localhost")) {
      throw new Error(`EPERM at ${url}`);
    }
    return createMockSocket();
  };

  await client._connectToPort(8200);
  assert.equal(client._preferredProbeHost, "127.0.0.1");
});

test("UnityClient: emits deterministic probe logs for rejected and selected hosts", async () => {
  const client = new UnityClient() as unknown as {
    events: { onProbe?: (message: string) => void };
    _connectToUrl: (url: string, port: number) => Promise<unknown>;
    _connectToPort: (port: number) => Promise<unknown>;
  };
  const probeLogs: string[] = [];
  client.events.onProbe = (message) => {
    probeLogs.push(message);
  };
  client._connectToUrl = async (url: string) => {
    if (url.includes("localhost")) {
      throw new Error(`EPERM at ${url}`);
    }
    return createMockSocket();
  };

  await client._connectToPort(8200);

  assert.ok(
    probeLogs.some((line) => /probe port 8200: host order/i.test(line)),
    `expected host order probe log, got: ${probeLogs.join(" | ")}`,
  );
  assert.ok(
    probeLogs.some((line) => /probe rejected ws:\/\/localhost:8200/i.test(line)),
    `expected rejected-host probe log, got: ${probeLogs.join(" | ")}`,
  );
  assert.ok(
    probeLogs.some((line) => /probe selected ws:\/\/127\.0\.0\.1:8200/i.test(line)),
    `expected selected-host probe log, got: ${probeLogs.join(" | ")}`,
  );
});

test("UnityClient: connect dedupes concurrent calls to one in-flight attempt", async () => {
  const client = new UnityClient() as unknown as {
    _resolveTransportMode: () => "tcp";
    _loadEndpointDiscovery: () => null;
    _connectToPort: (port: number) => Promise<unknown>;
    _performHandshake: (ws: unknown) => Promise<unknown>;
    _startHeartbeat: () => void;
    connect: () => Promise<{ sessionId: string }>;
  };

  let connectCalls = 0;
  let handshakeCalls = 0;
  const socket = createMockSocket();

  client._resolveTransportMode = () => "tcp";
  client._loadEndpointDiscovery = () => null;
  client._connectToPort = async (_port: number) => {
    connectCalls += 1;
    return socket;
  };
  client._performHandshake = async () => {
    handshakeCalls += 1;
    return handshakeFixture();
  };
  client._startHeartbeat = () => {};

  const [a, b] = await Promise.all([client.connect(), client.connect()]);

  assert.equal(connectCalls, 1);
  assert.equal(handshakeCalls, 1);
  assert.equal(a.sessionId, "test-session");
  assert.equal(b.sessionId, "test-session");
});

test("UnityClient: auto-pins to first handshaken project identity", async () => {
  const client = new UnityClient() as unknown as {
    _resolveTransportMode: () => "tcp";
    _loadEndpointDiscovery: () => null;
    _connectToPort: (port: number) => Promise<unknown>;
    _performHandshake: (ws: unknown) => Promise<unknown>;
    _startHeartbeat: () => void;
    pinnedProjectPathCanonical: string | null;
    connect: () => Promise<{ projectPathCanonical?: string }>;
  };

  client._resolveTransportMode = () => "tcp";
  client._loadEndpointDiscovery = () => null;
  client._connectToPort = async () => createMockSocket();
  client._performHandshake = async () => handshakeFixture(8200, {
    sessionId: "session-a",
    projectPathCanonical: "/Users/dev/GameA",
  });
  client._startHeartbeat = () => {};

  await client.connect();

  assert.equal(client.pinnedProjectPathCanonical, "/Users/dev/GameA");
});

test("UnityClient: pinned client accepts same project with new sessionId", async () => {
  const client = new UnityClient({
    targetIdentity: { projectPathCanonical: "/Users/dev/GameA" },
  }) as unknown as {
    _validateAndPinHandshake: (handshake: ReturnType<typeof handshakeFixture>) => ReturnType<typeof handshakeFixture>;
    pinnedProjectPathCanonical: string | null;
  };

  const handshake = client._validateAndPinHandshake(handshakeFixture(8201, {
    sessionId: "session-after-domain-reload",
    projectPathCanonical: "/Users/dev/GameA",
  }));

  assert.equal(handshake.sessionId, "session-after-domain-reload");
  assert.equal(client.pinnedProjectPathCanonical, "/Users/dev/GameA");
});

test("UnityClient: pinned client rejects wrong project identity", () => {
  const client = new UnityClient({
    targetIdentity: { projectPathCanonical: "/Users/dev/GameA" },
  }) as unknown as {
    _validateAndPinHandshake: (handshake: ReturnType<typeof handshakeFixture>) => ReturnType<typeof handshakeFixture>;
  };

  assert.throws(
    () => client._validateAndPinHandshake(handshakeFixture(8202, {
      sessionId: "session-b",
      projectPathCanonical: "/Users/dev/GameB",
      projectName: "GameB",
    })),
    /ROUTE_MISMATCH.*GameB.*GameA/i,
  );
});

test("UnityClient: pinned connect rejects project B discovery and cleans up socket", async () => {
  const socket = createMockSocket();
  const client = new UnityClient({
    targetIdentity: { projectPathCanonical: "/Users/dev/GameA" },
  }) as unknown as {
    _resolveTransportMode: () => "auto";
    _loadEndpointDiscovery: () => ReturnType<typeof discoveryFixture>;
    _connectToUrl: (url: string, label: string, socketPath?: string) => Promise<ReturnType<typeof createMockSocket>>;
    _connectToPort: (port: number) => Promise<never>;
    _performHandshake: (ws: unknown) => Promise<HandshakeFixture>;
    _startHeartbeat: () => void;
    _ws: unknown;
    _activeSocketGeneration: number;
    _handshake: HandshakeFixture | null;
    _handshakeComplete: boolean;
    _activeTransport: string | null;
    _activeEndpoint: string | null;
    _activePort: number | null;
    connect: () => Promise<HandshakeFixture>;
  };

  client._resolveTransportMode = () => "auto";
  client._loadEndpointDiscovery = () => discoveryFixture({
    sessionId: "discovery-b",
    endpoints: [
      {
        transport: "tcp",
        kind: "websocket",
        host: "localhost",
        port: 8206,
      },
    ],
  });
  client._connectToUrl = async () => socket;
  client._connectToPort = async () => {
    throw new Error("legacy fallback should not recover a wrong-project discovery");
  };
  client._performHandshake = async () => handshakeFixture(8206, {
    sessionId: "session-b",
    projectPath: "/Users/dev/GameB",
    projectPathCanonical: "/Users/dev/GameB",
    projectName: "GameB",
  });
  client._startHeartbeat = () => {};

  await assert.rejects(
    () => client.connect(),
    (err: Error) => {
      assert.match(err.message, /ROUTE_MISMATCH.*GameB.*GameA/i);
      return true;
    },
  );

  assert.equal(socket.readyState, 3);
  assert.equal(client._ws, null);
  assert.equal(client._activeSocketGeneration, 0);
  assert.equal(client._handshake, null);
  assert.equal(client._handshakeComplete, false);
  assert.equal(client._activeTransport, null);
  assert.equal(client._activeEndpoint, null);
  assert.equal(client._activePort, null);
});

test("UnityClient: pinned client rejects missing project identity", () => {
  const client = new UnityClient({
    targetIdentity: { projectPathCanonical: "/Users/dev/GameA" },
  }) as unknown as {
    _validateAndPinHandshake: (handshake: ReturnType<typeof handshakeFixture>) => ReturnType<typeof handshakeFixture>;
  };
  const handshake = handshakeFixture(8203, { projectPathCanonical: undefined });

  assert.throws(
    () => client._validateAndPinHandshake(handshake),
    /ROUTE_MISMATCH.*did not report projectPathCanonical/i,
  );
});

test("UnityClient: stale socket close is ignored during reconnect windows", () => {
  const client = new UnityClient() as unknown as {
    _ws: unknown;
    _activeSocketGeneration: number;
    _pendingOps: Map<string, { resolve: () => void; reject: (err: Error) => void; startTime: number }>;
    _onClose: (socketGeneration: number, reason: string) => void;
  };

  const currentSocket = createMockSocket();
  client._ws = currentSocket;
  client._activeSocketGeneration = 2;

  let rejected = false;
  client._pendingOps.set("req-1", {
    resolve: () => {},
    reject: () => {
      rejected = true;
    },
    startTime: Date.now(),
  });

  client._onClose(1, "stale-close");

  assert.equal(client._ws, currentSocket);
  assert.equal(client._pendingOps.size, 1);
  assert.equal(rejected, false);
});

test("UnityClient: active socket close rejects pending ops and handshake waiters deterministically", async () => {
  const client = new UnityClient() as unknown as {
    _ws: unknown;
    _activeSocketGeneration: number;
    _autoReconnect: boolean;
    _pendingOps: Map<string, { resolve: () => void; reject: (err: Error) => void; startTime: number }>;
    _handshakeQueue: Array<{ resolve: () => void; reject: (err: Error) => void }>;
    _onClose: (socketGeneration: number, reason: string) => void;
  };

  client._ws = createMockSocket();
  client._activeSocketGeneration = 3;
  client._autoReconnect = false;

  let pendingRejected = "";
  client._pendingOps.set("req-2", {
    resolve: () => {},
    reject: (err: Error) => {
      pendingRejected = err.message;
    },
    startTime: Date.now(),
  });

  let waiterRejected = "";
  const waiterPromise = new Promise<void>((_resolve, reject) => {
    client._handshakeQueue.push({
      resolve: () => {},
      reject: (err: Error) => {
        waiterRejected = err.message;
        reject(err);
      },
    });
  });

  client._onClose(3, "network-drop");

  await assert.rejects(() => waiterPromise);
  assert.match(pendingRejected, /CONNECTION_LOST: network-drop/i);
  assert.match(waiterRejected, /Connection lost: network-drop/i);
  assert.equal(client._pendingOps.size, 0);
});

test("UnityClient: send waits for in-flight connect promise before evaluating connection state", async () => {
  const client = new UnityClient() as unknown as {
    _connectPromise: Promise<unknown> | null;
    _ws: unknown;
    _handshakeComplete: boolean;
    _activeSocketGeneration: number;
    _pendingOps: Map<string, unknown>;
    send: (command: string, params: Record<string, unknown>, timeoutMs: number) => Promise<unknown>;
  };

  const socket = createMockSocket();
  client._connectPromise = (async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    client._ws = socket;
    client._handshakeComplete = true;
    client._activeSocketGeneration = 4;
    return handshakeFixture();
  })();

  const sendPromise = client.send("scene.create_object", {}, 25);

  await assert.rejects(
    () => sendPromise,
    (err: Error) => {
      assert.match(err.message, /timeout waiting for response/i);
      return true;
    }
  );
  assert.equal(client._pendingOps.size, 0);
});
