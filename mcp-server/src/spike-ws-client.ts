/**
 * Phase 0 spike: WebSocket test client for Unity bridge.
 * Tests handshake, ping, handshake enforcement, and domain reload reconnection.
 *
 * Usage: npx tsx src/spike-ws-client.ts
 */

import WebSocket from "ws";
import type { BridgeRequest, BridgeResponse } from "./types.js";
import {
  isHandshakeResponseData,
  parseBridgeResponse,
} from "./bridge-protocol.js";

// ─────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────

const BASE_PORT = 8200;
const MAX_PORT = 8210;
const CONNECT_TIMEOUT_MS = 5000;
const RESPONSE_TIMEOUT_MS = 10000;
const RECONNECT_DELAYS_MS = [500, 1000, 2000, 4000];

// ─────────────────────────────────────────────
// Test infrastructure
// ─────────────────────────────────────────────

let testsPassed = 0;
let testsFailed = 0;

function pass(name: string, detail?: string): void {
  testsPassed++;
  const suffix = detail ? ` — ${detail}` : "";
  console.log(`  \u2705 PASS: ${name}${suffix}`);
}

function fail(name: string, reason: string): void {
  testsFailed++;
  console.log(`  \u274c FAIL: ${name} — ${reason}`);
}

function assert(
  condition: boolean,
  name: string,
  detail?: string,
  failReason?: string
): void {
  if (condition) {
    pass(name, detail);
  } else {
    fail(name, failReason ?? "Assertion failed");
  }
}

// ─────────────────────────────────────────────
// WebSocket helpers
// ─────────────────────────────────────────────

function generateId(): string {
  return crypto.randomUUID();
}

async function findPort(): Promise<number> {
  for (let port = BASE_PORT; port <= MAX_PORT; port++) {
    try {
      const ws = new WebSocket(`ws://localhost:${port}`);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          ws.close();
          reject(new Error("timeout"));
        }, 1000);
        ws.on("open", () => {
          clearTimeout(timer);
          ws.close();
          resolve();
        });
        ws.on("error", () => {
          clearTimeout(timer);
          reject(new Error("connection refused"));
        });
      });
      return port;
    } catch {
      // Try next port
    }
  }
  throw new Error(
    `No Unity WebSocket server found on ports ${BASE_PORT}-${MAX_PORT}`
  );
}

function connectWs(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}`);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`Connection timeout after ${CONNECT_TIMEOUT_MS}ms`));
    }, CONNECT_TIMEOUT_MS);

    ws.on("open", () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function sendCommand(
  ws: WebSocket,
  command: string,
  params: Record<string, unknown> = {}
): Promise<BridgeResponse> {
  return new Promise((resolve, reject) => {
    const id = generateId();
    const request: BridgeRequest = { id, command, params };

    const timer = setTimeout(() => {
      reject(
        new Error(`Response timeout for ${command} after ${RESPONSE_TIMEOUT_MS}ms`)
      );
    }, RESPONSE_TIMEOUT_MS);

    const handler = (data: WebSocket.RawData) => {
      try {
        const response = parseBridgeResponse(data.toString());
        if (response.id === id) {
          clearTimeout(timer);
          ws.removeListener("message", handler);
          resolve(response);
        }
      } catch {
        // Ignore parse errors for non-matching messages
      }
    };

    ws.on("message", handler);
    ws.send(JSON.stringify(request));
  });
}

// ─────────────────────────────────────────────
// Test sequence
// ─────────────────────────────────────────────

async function runTests(): Promise<void> {
  console.log("\n=== Loombridge WebSocket Spike Test ===\n");

  // Step 1: Find the server port
  console.log("Scanning for Unity WebSocket server...");
  let port: number;
  try {
    port = await findPort();
    pass("Port scan", `Found server on port ${port}`);
  } catch (err) {
    fail("Port scan", (err as Error).message);
    console.log(
      "\nMake sure Unity is open with the Loombridge UnityBridge plugin loaded.\n"
    );
    return;
  }

  // Step 2: Connect and perform handshake
  console.log("\n--- Test: Handshake + Ping ---");
  let ws1: WebSocket;
  let originalSessionId: string;

  try {
    ws1 = await connectWs(port);
    pass("Connect", `Connected to ws://localhost:${port}`);
  } catch (err) {
    fail("Connect", (err as Error).message);
    return;
  }

  try {
    const initResponse = await sendCommand(ws1, "bridge.initialize");
    assert(
      initResponse.status === "success",
      "Initialize status",
      `status=${initResponse.status}`
    );

    assert(
      isHandshakeResponseData(initResponse.data),
      "Initialize payload shape",
      undefined,
      "Initialize payload missing required handshake fields"
    );

    if (!isHandshakeResponseData(initResponse.data)) {
      fail("Initialize payload shape", "Handshake payload was malformed");
      ws1.close();
      return;
    }

    const data = initResponse.data;
    originalSessionId = data.sessionId;
    assert(
      typeof originalSessionId === "string" && originalSessionId.length > 0,
      "SessionId present",
      `sessionId=${originalSessionId}`
    );
    assert(
      data.protocolVersion === 1,
      "Protocol version",
      `protocolVersion=${data.protocolVersion}`
    );
    assert(
      data.engine === "unity",
      "Engine field",
      `engine=${data.engine}`
    );
    assert(
      typeof data.pluginVersion === "string",
      "Plugin version",
      `pluginVersion=${data.pluginVersion}`
    );
  } catch (err) {
    fail("Initialize", (err as Error).message);
    ws1.close();
    return;
  }

  // Step 3: Ping
  try {
    const pingResponse = await sendCommand(ws1, "bridge.ping");
    assert(
      pingResponse.status === "success",
      "Ping status",
      `status=${pingResponse.status}`
    );

    const pingData = pingResponse.data as Record<string, unknown>;
    assert(pingData.pong === true, "Pong value", `pong=${pingData.pong}`);
    assert(
      pingData.sessionId === originalSessionId,
      "Ping sessionId matches",
      `sessionId=${pingData.sessionId}`
    );
  } catch (err) {
    fail("Ping", (err as Error).message);
  }

  ws1.close();

  // Step 4: Test handshake enforcement (new connection, send command before initialize)
  console.log("\n--- Test: Handshake Enforcement ---");
  let ws2: WebSocket;

  try {
    ws2 = await connectWs(port);
    pass("Connect (fresh)", "Connected for handshake enforcement test");
  } catch (err) {
    fail("Connect (fresh)", (err as Error).message);
    return;
  }

  try {
    const noHandshakeResponse = await sendCommand(ws2, "scene.create_object", {
      name: "TestObject",
    });
    assert(
      noHandshakeResponse.status === "error",
      "Pre-handshake rejected",
      `status=${noHandshakeResponse.status}`
    );

    const errorData = noHandshakeResponse.error;
    assert(
      errorData?.code === "HANDSHAKE_REQUIRED",
      "Error code is HANDSHAKE_REQUIRED",
      `code=${errorData?.code}`
    );
  } catch (err) {
    fail("Handshake enforcement", (err as Error).message);
  }

  ws2.close();

  // Step 5: Domain reload test (manual)
  console.log("\n--- Test: Domain Reload ---");
  console.log(
    "  Trigger a domain reload in Unity now (enter Play Mode or create a script)..."
  );
  console.log("  Waiting for disconnect...\n");

  let ws3: WebSocket;
  try {
    ws3 = await connectWs(port);
    // Complete handshake first
    await sendCommand(ws3, "bridge.initialize");
  } catch (err) {
    fail("Connect for reload test", (err as Error).message);
    return;
  }

  // Wait for disconnect
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new Error(
            "Timeout waiting for disconnect (120s). Trigger a domain reload in Unity."
          )
        );
      }, 120_000);

      ws3.on("close", () => {
        clearTimeout(timer);
        resolve();
      });
      ws3.on("error", () => {
        clearTimeout(timer);
        resolve();
      });
    });

    pass(
      "Disconnect detected",
      `Lost session ${originalSessionId}`
    );
  } catch (err) {
    fail("Disconnect detection", (err as Error).message);
    ws3.close();
    printSummary();
    return;
  }

  // Step 6: Auto-reconnect with backoff
  console.log("\n  Attempting auto-reconnect with backoff...");

  let reconnectedWs: WebSocket | null = null;
  for (let i = 0; i < RECONNECT_DELAYS_MS.length; i++) {
    const delay = RECONNECT_DELAYS_MS[i]!;
    console.log(`    Waiting ${delay}ms before attempt ${i + 1}...`);
    await sleep(delay);

    try {
      // Re-scan for port in case it changed
      const newPort = await findPort();
      reconnectedWs = await connectWs(newPort);
      port = newPort;
      pass(
        "Reconnect",
        `Connected on attempt ${i + 1} to port ${newPort}`
      );
      break;
    } catch {
      console.log(`    Attempt ${i + 1} failed, retrying...`);
    }
  }

  if (!reconnectedWs) {
    fail("Reconnect", "All reconnect attempts failed");
    printSummary();
    return;
  }

  // Step 7: Re-handshake, verify new sessionId
  try {
    const reinitResponse = await sendCommand(
      reconnectedWs,
      "bridge.initialize"
    );
    assert(
      reinitResponse.status === "success",
      "Re-initialize status",
      `status=${reinitResponse.status}`
    );

    const reinitData = reinitResponse.data as Record<string, unknown>;
    const newSessionId = reinitData.sessionId as string;
    assert(
      typeof newSessionId === "string" && newSessionId.length > 0,
      "New sessionId present",
      `sessionId=${newSessionId}`
    );
    assert(
      newSessionId !== originalSessionId,
      "SessionId changed after reload",
      `old=${originalSessionId}, new=${newSessionId}`
    );
  } catch (err) {
    fail("Re-initialize", (err as Error).message);
  }

  // Step 8: Ping after reconnect
  try {
    const pingResponse = await sendCommand(reconnectedWs, "bridge.ping");
    assert(
      pingResponse.status === "success",
      "Ping after reconnect",
      `status=${pingResponse.status}`
    );

    const pingData = pingResponse.data as Record<string, unknown>;
    assert(
      pingData.pong === true,
      "Pong after reconnect",
      `pong=${pingData.pong}`
    );
    assert(
      pingData.sessionId !== originalSessionId,
      "Ping uses new sessionId",
      `sessionId=${pingData.sessionId}`
    );
  } catch (err) {
    fail("Ping after reconnect", (err as Error).message);
  }

  reconnectedWs.close();

  printSummary();
}

// ─────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function printSummary(): void {
  const total = testsPassed + testsFailed;
  console.log(`\n=== Results: ${testsPassed}/${total} passed ===`);
  if (testsFailed > 0) {
    console.log(`${testsFailed} test(s) FAILED`);
    process.exit(1);
  } else {
    console.log("All tests passed!");
    process.exit(0);
  }
}

// ─────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────

runTests().catch((err) => {
  console.error("Unhandled error:", err);
  process.exit(1);
});
