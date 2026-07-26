import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  formatToolResult,
  formatErrorResult,
  formatConnectionErrorMessage,
  sanitizeErrorMessage,
  resolveOpTimeoutMs,
  stripRoutingParams,
  resolveSafeScreenshotOutputPath,
  writeScreenshotOutputPath,
  formatEditorRoutingError,
  settlePlayMode,
  buildPlaySettleFailureMessage,
  runReloadAwarePreflight,
  isReloadWindowCommand,
  isReloadSurvivableSendCommand,
  shouldRetryReloadDrop,
  buildPlaySettleCompileHint,
  buildWaitForCompileFailureHint,
  buildConsoleErrorHint,
  buildReloadReconnectHint,
  isDomainReloadTriggeringCommand,
} from "../surfaces/index.js";
import type { ContextualHint } from "../surfaces/index.js";
import type { BridgePreflightResult } from "../bridge/preflight/bridge-preflight.js";
import type { BridgeResponse } from "../shared/types.js";
import { EditorRegistry, EditorRoutingError } from "../bridge/editor-registry.js";
import { resolveMcpStartupProjectBinding } from "../bridge/startup-binding.js";
import { UnityConnectionError } from "../bridge/unity-client.js";
import { OpRegistry } from "../surfaces/op-registry.js";
import {
  buildEditorListPayload,
  EDITOR_LIST_TOOL,
  EDITOR_LIST_TOOL_NAME,
  EDITOR_USE_TOOL,
  EDITOR_USE_TOOL_NAME,
} from "../surfaces/editor-tools.js";
import type { UnityEndpointDiscoveryRecord } from "../shared/types.js";

// ─────────────────────────────────────────────
// Tests for response formatting helpers
// ─────────────────────────────────────────────

test("formatToolResult: screenshot with jpeg format returns image content with correct mimeType", () => {
  const result = formatToolResult(
    "editor.screenshot",
    {
      image_base64: "abc123",
      format: "jpeg",
      width: 800,
      height: 600,
    }
  );

  assert.equal(result.content.length, 1);
  const content = result.content[0]!;
  assert.equal(content.type, "image");
  assert.equal((content as { data: string }).data, "abc123");
  assert.equal((content as { mimeType: string }).mimeType, "image/jpeg");
});

test("formatToolResult: screenshot with png format returns image/png mimeType", () => {
  const result = formatToolResult(
    "editor.screenshot",
    {
      image_base64: "def456",
      format: "png",
      width: 1024,
      height: 768,
    }
  );

  const content = result.content[0]!;
  assert.equal(content.type, "image");
  assert.equal((content as { mimeType: string }).mimeType, "image/png");
});

test("formatToolResult: non-screenshot op returns text/json content", () => {
  const result = formatToolResult(
    "scene.create_object",
    { locator: { path: "/Cube" } }
  );

  assert.equal(result.content.length, 1);
  const content = result.content[0]!;
  assert.equal(content.type, "text");
  const parsed = JSON.parse((content as { text: string }).text);
  assert.deepEqual(parsed, { locator: { path: "/Cube" } });
});

test("formatToolResult: screenshot op without image_base64 returns text/json", () => {
  // Edge case: screenshot response might not have image_base64 (e.g. error state)
  const result = formatToolResult(
    "editor.screenshot",
    { error: "view not available" }
  );

  assert.equal(result.content.length, 1);
  assert.equal(result.content[0]!.type, "text");
});

test("writeScreenshotOutputPath: writes screenshot bytes and returns deterministic JSON metadata", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loombridge-screenshot-output-"));
  try {
    const bytes = Buffer.from("fake-png-data");
    const outputPath = path.join(tmpDir, "captures", "start.png");
    const metadata = await writeScreenshotOutputPath(
      {
        image_base64: bytes.toString("base64"),
        format: "png",
        width: 320,
        height: 180,
      },
      outputPath,
      tmpDir,
    );

    assert.deepEqual(fs.readFileSync(outputPath), bytes);
    assert.equal(metadata.path, outputPath);
    assert.equal(metadata.width, 320);
    assert.equal(metadata.height, 180);
    assert.equal(metadata.format, "png");
    assert.equal(metadata.sizeBytes, bytes.byteLength);
    assert.equal(metadata.sha256, crypto.createHash("sha256").update(bytes).digest("hex"));

    const result = formatToolResult("editor.screenshot", metadata);
    assert.equal(result.content.length, 1);
    assert.equal(result.content[0]!.type, "text");
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    assert.equal(parsed.path, outputPath);
    assert.equal(parsed.sizeBytes, bytes.byteLength);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("resolveSafeScreenshotOutputPath: allows relative artifact roots only", () => {
  const cwd = "/Users/example/project";

  assert.equal(
    resolveSafeScreenshotOutputPath("captures/start.png", cwd),
    path.join(cwd, "captures/start.png"),
  );
  assert.equal(
    resolveSafeScreenshotOutputPath(".loombridge/captures/start.png", cwd),
    path.join(cwd, ".loombridge/captures/start.png"),
  );
  assert.throws(
    () => resolveSafeScreenshotOutputPath("Assets/Scenes/Game.unity", cwd),
    /outputPath must stay under/,
  );
});

test("resolveSafeScreenshotOutputPath: refuses traversal outside allowed roots", () => {
  assert.throws(
    () => resolveSafeScreenshotOutputPath("../outside.png", "/Users/example/project/subdir"),
    /outputPath must stay under/,
  );
});

test("resolveSafeScreenshotOutputPath: refuses prefix traversal that escapes into the project root", () => {
  const cwd = "/Users/example/project";

  // The artifact-prefix check must not whitelist the whole cwd: a `..` after the
  // prefix would otherwise overwrite arbitrary files under the project root.
  assert.throws(
    () => resolveSafeScreenshotOutputPath(".loombridge/../mcp-server/src/index.ts", cwd),
    /outputPath must stay under/,
  );
  assert.throws(
    () => resolveSafeScreenshotOutputPath("captures/../package.json", cwd),
    /outputPath must stay under/,
  );
});

test("formatErrorResult: sets isError true and includes error message", () => {
  const result = formatErrorResult("Something went wrong");

  assert.equal(result.isError, true);
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0]!.type, "text");
  assert.equal((result.content[0] as { text: string }).text, "Something went wrong");
});

test("formatErrorResult: includes error code when provided", () => {
  const result = formatErrorResult("Object not found", "NOT_FOUND");

  assert.equal(result.isError, true);
  const text = (result.content[0] as { text: string }).text;
  assert.match(text, /NOT_FOUND/);
  assert.match(text, /Object not found/);
});

test("sanitizeErrorMessage: strips stack lines and normalizes whitespace", () => {
  const input = new Error("connect ECONNREFUSED 127.0.0.1:8200\n    at Socket._onTimeout");
  const message = sanitizeErrorMessage(input);
  assert.equal(message, "connect ECONNREFUSED 127.0.0.1:8200");
});

test("formatConnectionErrorMessage: emits preflight diagnostics for UnityConnectionError", () => {
  const message = formatConnectionErrorMessage(
    new UnityConnectionError("connect failed", {
      transportMode: "auto",
      attemptedEndpoints: ["legacy_port_probe:8200", "legacy_port_probe:8201", "legacy_port_probe:8202"],
      failedEndpoints: [
        {
          transport: "tcp",
          kind: "legacy_port_probe",
          endpoint: "legacy_port_probe:8200",
          errorClass: "EPERM",
          message: "connect EPERM [::1]:8200",
        },
      ],
      selectedTransport: null,
      selectedEndpoint: null,
      attemptedPorts: [8200, 8201, 8202],
      failedPorts: [
        {
          port: 8200,
          hostAttempts: [
            { url: "ws://[::1]:8200", errorClass: "EPERM", message: "connect EPERM [::1]:8200" },
            { url: "ws://127.0.0.1:8200", errorClass: "ECONNREFUSED", message: "connect ECONNREFUSED" },
          ],
        },
      ],
      lastErrorClass: "EPERM",
      lastErrorMessage: "connect EPERM [::1]:8200",
    }),
  );

  assert.match(message, /preflight blocked/i);
  assert.match(message, /error class:\s*EPERM/i);
  assert.match(message, /attempted ports:\s*8200,\s*8201,\s*8202/i);
  assert.match(message, /host attempts:\s*ws:\/\/\[::1\]:8200 \(EPERM\)/i);
});

test("formatConnectionErrorMessage: falls back to first-line sanitize for generic errors", () => {
  const message = formatConnectionErrorMessage(
    new Error("connect ECONNREFUSED 127.0.0.1:8200\n    at Socket._onTimeout"),
  );
  assert.equal(message, "connect ECONNREFUSED 127.0.0.1:8200");
});

test("index routing surface: unity_input_key_tap is discoverable in OpRegistry", () => {
  const registry = new OpRegistry();
  const op = registry.getByToolName("unity_input_key_tap");
  assert.ok(op, "unity_input_key_tap should exist for index routing");
  assert.equal(op!.command, "input.key_tap");
});

test("index routing surface: editor list tool is registered as a Loombridge MCP tool", () => {
  assert.equal(EDITOR_LIST_TOOL.name, EDITOR_LIST_TOOL_NAME);
  assert.equal(EDITOR_LIST_TOOL_NAME, "loombridge_editor_list");
});

test("index routing surface: editor use tool is registered as a Loombridge MCP tool", () => {
  assert.equal(EDITOR_USE_TOOL.name, EDITOR_USE_TOOL_NAME);
  assert.equal(EDITOR_USE_TOOL_NAME, "loombridge_editor_use");
});

test("index routing surface: Unity tools advertise project routing parameter", () => {
  const tool = new OpRegistry().toMCPTools().find((candidate) => candidate.name === "unity_scene_create_object");
  assert.ok(tool);
  const props = (tool!.inputSchema as { properties: Record<string, unknown> }).properties;
  assert.ok(props.project);
});

test("stripRoutingParams removes server-only params before forwarding params to Unity", () => {
  const { unityParams, project, outputPath } = stripRoutingParams({
    project: "/Users/dev/GameA",
    outputPath: "captures/start.png",
    name: "Cube",
    position: { x: 1, y: 2, z: 3 },
  });

  assert.equal(project, "/Users/dev/GameA");
  assert.equal(outputPath, "captures/start.png");
  assert.deepEqual(unityParams, {
    name: "Cube",
    position: { x: 1, y: 2, z: 3 },
  });
});

test("formatEditorRoutingError: embeds the active editor in the peer payload (m3)", () => {
  const err = new EditorRoutingError(
    "EDITOR_AMBIGUOUS",
    "Multiple Unity editors are open.",
    [],
  );
  const message = formatEditorRoutingError(err, "/Users/dev/GameA");
  const json = JSON.parse(message.slice(message.indexOf("{")));
  assert.equal(json.activeProjectPathCanonical, "/Users/dev/GameA");
});

// ─────────────────────────────────────────────
// Startup binding wiring (A3) — main() resolves the binding from env + cwd
// ─────────────────────────────────────────────

test("startup binding: strict env target is resolved as main() wires it", () => {
  const binding = resolveMcpStartupProjectBinding({
    env: { LOOMBRIDGE_UNITY_PROJECT: "/Users/dev/GameA" },
    cwd: "/tmp/not-a-unity-project",
  });
  assert.deepEqual(binding, { kind: "strict", target: "/Users/dev/GameA" });
});

test("startup binding: no env + non-Unity cwd yields kind none (inert in repo root)", () => {
  const binding = resolveMcpStartupProjectBinding({
    env: {},
    cwd: "/tmp/not-a-unity-project",
  });
  assert.deepEqual(binding, { kind: "none" });
});

test("editor_list wiring: payload carries the startupBinding and peeked active without committing the pin", () => {
  // Mirrors the EDITOR_LIST_TOOL_NAME handler: list records → describe display state →
  // build payload. A configured strict binding that resolves is shown as active for display
  // only; the committed pin stays null until the first real routed op.
  const fullRecord = (overrides: Partial<UnityEndpointDiscoveryRecord>): UnityEndpointDiscoveryRecord => ({
    schemaVersion: "1",
    sessionId: overrides.sessionId ?? "session-a",
    projectPath: overrides.projectPath ?? overrides.projectPathCanonical ?? "/Users/dev/GameA",
    projectPathCanonical: overrides.projectPathCanonical ?? "/Users/dev/GameA",
    projectName: overrides.projectName ?? "GameA",
    processId: overrides.processId ?? 1,
    publishedAtUnixMs: 1000,
    expiresAtUnixMs: 10_000,
    transportModeDefault: "auto",
    endpoints: [
      { transport: "tcp", kind: "websocket", host: "localhost", port: 8200, supportsHandshake: true, supportsPing: true },
    ],
  });

  const registry = new EditorRegistry({
    startupBinding: { kind: "strict", target: "/Users/dev/GameA" },
    scanRecords: () => [
      fullRecord({ projectPathCanonical: "/Users/dev/GameA", projectName: "GameA" }),
      fullRecord({ projectPathCanonical: "/Users/dev/GameB", projectName: "GameB", sessionId: "session-b", processId: 2 }),
    ],
  });

  const records = registry.listRecords();
  const display = registry.describeListDisplayState(records);
  const payload = buildEditorListPayload(
    records,
    display.effectiveActiveProjectPathCanonical,
    display.startupBinding,
  );

  assert.deepEqual(payload.startupBinding, {
    kind: "strict",
    target: "/Users/dev/GameA",
    resolved: true,
  });
  assert.equal(payload.activeProjectPathCanonical, "/Users/dev/GameA");
  assert.equal(payload.peers.find((p) => p.projectName === "GameA")!.active, true);
  // Listing did not commit the binding.
  assert.equal(registry.activeProjectPathCanonical, null);
});

// ─────────────────────────────────────────────
// Tests for resolveOpTimeoutMs (async-op wire timeout resolution)
// ─────────────────────────────────────────────

test("resolveOpTimeoutMs: caller timeoutMs overrides the op default (above and below)", () => {
  const op = { defaultTimeoutMs: 120000 };
  assert.equal(resolveOpTimeoutMs(op, { timeoutMs: 300000 }), 300000);
  assert.equal(resolveOpTimeoutMs(op, { timeoutMs: 5000 }), 5000);
});

test("resolveOpTimeoutMs: falls back to op default when timeoutMs is absent", () => {
  assert.equal(resolveOpTimeoutMs({ defaultTimeoutMs: 60000 }, {}), 60000);
});

test("resolveOpTimeoutMs: falls back to 10000 when neither is set", () => {
  assert.equal(resolveOpTimeoutMs({}, {}), 10000);
});

test("resolveOpTimeoutMs: ignores non-positive and non-finite requests", () => {
  const op = { defaultTimeoutMs: 120000 };
  assert.equal(resolveOpTimeoutMs(op, { timeoutMs: 0 }), 120000);
  assert.equal(resolveOpTimeoutMs(op, { timeoutMs: -5 }), 120000);
  assert.equal(resolveOpTimeoutMs(op, { timeoutMs: Number.NaN }), 120000);
  assert.equal(resolveOpTimeoutMs(op, { timeoutMs: Infinity }), 120000);
  assert.equal(resolveOpTimeoutMs(op, { timeoutMs: "200000" }), 120000);
});

test("resolveOpTimeoutMs: package.add exposes a timeoutMs the server now honors", () => {
  const op = new OpRegistry().getByToolName("unity_package_add");
  assert.ok(op);
  assert.equal(op!.isAsync, true);
  // Schema advertises the knob...
  const props = (op!.inputSchema as { properties: Record<string, unknown> }).properties;
  assert.ok(props.timeoutMs, "package.add should expose timeoutMs");
  // ...and the resolver actually applies it over the op default.
  assert.equal(resolveOpTimeoutMs(op!, { timeoutMs: 250000 }), 250000);
});

test("resolveOpTimeoutMs: editor.execute_menu_item honors a raised timeoutMs for long PLAYER BUILDS (GRL-C26)", () => {
  const op = new OpRegistry().getByToolName("unity_editor_execute_menu_item");
  assert.ok(op);
  // The op has no defaultTimeoutMs, so a build would otherwise be capped at the 10s wire fallback...
  assert.equal(resolveOpTimeoutMs(op!, {}), 10000);
  // ...but a per-call timeoutMs (e.g. a 10-minute iOS build) is honored end-to-end by the server.
  assert.equal(resolveOpTimeoutMs(op!, { timeoutMs: 600000 }), 600000);
});

// ─────────────────────────────────────────────
// settlePlayMode: editor.play waits out the play-mode domain reload
// ─────────────────────────────────────────────

function okResponse(): BridgeResponse {
  return { id: "x", status: "success", data: {}, timestamp: 0 };
}

function errorResponse(message: string): BridgeResponse {
  return { id: "x", status: "error", data: null, error: { code: "ERR", message }, timestamp: 0 };
}

test("settlePlayMode: waits for the reconnect, then confirms Play Mode (happy path)", async () => {
  const calls: string[] = [];
  const result = await settlePlayMode(
    {
      waitForReconnect: async () => {
        calls.push("reconnect");
        return true;
      },
      waitForPlaying: async () => {
        calls.push("playing");
        return okResponse();
      },
    },
    60000,
  );
  assert.deepEqual(result, { settled: true });
  // Reconnect is awaited before the (idempotent) Play Mode confirmation is issued.
  assert.deepEqual(calls, ["reconnect", "playing"]);
});

test("settlePlayMode: recovers from a CONNECTION_LOST mid-wait (reload firing) by reconnecting and re-issuing the idempotent wait", async () => {
  const calls: string[] = [];
  let attempt = 0;
  const result = await settlePlayMode(
    {
      waitForReconnect: async () => {
        calls.push("reconnect");
        return true;
      },
      waitForPlaying: async () => {
        calls.push("playing");
        attempt += 1;
        if (attempt === 1) throw new Error("CONNECTION_LOST: socket closed");
        return okResponse();
      },
    },
    60000,
  );
  assert.deepEqual(result, { settled: true });
  assert.deepEqual(calls, ["reconnect", "playing", "reconnect", "playing"]);
});

test("settlePlayMode: first reconnect lands on the stale pre-reload bridge; settles only after it drops and a fresh one comes up", async () => {
  // Model two bridge generations: the stale one (still up when settle begins) drops
  // with CONNECTION_LOST as the domain reload tears it down; the fresh one (post-reload)
  // answers the idempotent wait_for. This is the exact stale-bridge timing edge —
  // distinct from a clean mid-wait loss against an already-fresh bridge.
  let bridgeGeneration = 0;
  const reconnectGenerations: number[] = [];
  const playingGenerations: number[] = [];
  const result = await settlePlayMode(
    {
      waitForReconnect: async () => {
        // 1st call: already "connected" to the stale bridge (gen 0).
        // 2nd call: the reload finished — connect to the fresh bridge (gen 1).
        if (bridgeGeneration === 0 && reconnectGenerations.length > 0) {
          bridgeGeneration = 1;
        }
        reconnectGenerations.push(bridgeGeneration);
        return true;
      },
      waitForPlaying: async () => {
        playingGenerations.push(bridgeGeneration);
        if (bridgeGeneration === 0) {
          throw new Error("CONNECTION_LOST: bridge stopped for domain reload");
        }
        return okResponse();
      },
    },
    60000,
  );
  assert.deepEqual(result, { settled: true });
  // wait_for was tried against the stale bridge (gen 0), lost it, then re-reconnected
  // and succeeded against the fresh bridge (gen 1).
  assert.deepEqual(playingGenerations, [0, 1]);
  assert.deepEqual(reconnectGenerations, [0, 1]);
});

test("settlePlayMode: surfaces a wait_for timeout (error status) instead of resending play", async () => {
  const result = await settlePlayMode(
    {
      waitForReconnect: async () => true,
      waitForPlaying: async () => errorResponse("Timeout waiting for playMode=playing"),
    },
    60000,
  );
  assert.equal(result.settled, false);
  assert.match(result.error ?? "", /playMode=playing/);
});

test("settlePlayMode: a non-CONNECTION_LOST error is terminal (no retry)", async () => {
  let attempts = 0;
  const result = await settlePlayMode(
    {
      waitForReconnect: async () => true,
      waitForPlaying: async () => {
        attempts += 1;
        throw new Error("ROUTE_MISMATCH: different project");
      },
    },
    60000,
  );
  assert.equal(result.settled, false);
  assert.match(result.error ?? "", /ROUTE_MISMATCH/);
  assert.equal(attempts, 1, "must not retry a non-CONNECTION_LOST failure");
});

test("settlePlayMode: gives up after the settle deadline (reload never finishes)", async () => {
  let clock = 1000;
  const result = await settlePlayMode(
    {
      now: () => clock,
      waitForReconnect: async () => {
        clock += 5000; // consume time; never reconnects
        return false;
      },
      waitForPlaying: async () => {
        throw new Error("CONNECTION_LOST: still reloading");
      },
    },
    3000,
  );
  assert.equal(result.settled, false);
  assert.match(result.error ?? "", /CONNECTION_LOST|did not settle/);
});

test("settlePlayMode: reports a timeout message when the budget is exhausted before any confirmation", async () => {
  const result = await settlePlayMode(
    {
      waitForReconnect: async () => true,
      waitForPlaying: async () => okResponse(),
    },
    0,
  );
  assert.equal(result.settled, false);
  assert.match(result.error ?? "", /did not settle within 0ms/);
});

// ─────────────────────────────────────────────
// buildPlaySettleFailureMessage: GRL-B01 compile-error attribution on editor.play settle failure
// ─────────────────────────────────────────────

test("buildPlaySettleFailureMessage: no compile error → keeps the generic settle message (never guesses)", () => {
  const msg = buildPlaySettleFailureMessage("wait_for timed out");
  assert.match(msg, /entered Play Mode but the bridge did not settle/);
  assert.match(msg, /wait_for timed out/);
  assert.ok(!msg.includes("compile"), "must not attribute a compile error that was not detected");
});

test("buildPlaySettleFailureMessage: undefined/empty compile error is not treated as a compile error", () => {
  assert.match(buildPlaySettleFailureMessage("x", undefined), /did not settle/);
  assert.match(buildPlaySettleFailureMessage("x", null), /did not settle/);
  // A non-object (e.g. a stray string) is not a structured block → stays generic.
  assert.match(buildPlaySettleFailureMessage("x", "nope"), /did not settle/);
});

test("buildPlaySettleFailureMessage: a compile_error block is attributed with its structured payload", () => {
  const compileError = {
    scriptCompilationFailed: true,
    errorCount: 1,
    errors: [{ file: "Assets/BotBrainTests.cs", line: 42, message: "CS7036: no arg for param" }],
    firstFile: "Assets/BotBrainTests.cs",
  };
  const msg = buildPlaySettleFailureMessage("wait_for timed out", compileError);
  assert.match(msg, /compile error is blocking script compilation/);
  assert.ok(!msg.includes("did not settle"), "compile attribution replaces the misleading settle message");
  // The structured block is embedded verbatim so the agent can read the offending assembly.
  const parsed = JSON.parse(msg.slice(msg.indexOf("{")));
  assert.deepEqual(parsed.compile_error, compileError);
});

// ─────────────────────────────────────────────
// runReloadAwarePreflight: editor.wait_for must survive the reload it waits through (RCL-T03)
// ─────────────────────────────────────────────

function passResult(command: string): BridgePreflightResult {
  return {
    status: "pass",
    command,
    checkedAtUnixMs: 0,
    deterministic: true,
    sessionReady: true,
    handshakeReady: true,
    sessionId: "s",
    blockerSignature: "NONE",
    blockers: [],
    prerequisites: [],
  };
}

function connBlockedResult(command: string, signature: string): BridgePreflightResult {
  return {
    status: "blocked",
    command,
    checkedAtUnixMs: 0,
    deterministic: true,
    sessionReady: false,
    handshakeReady: false,
    sessionId: null,
    blockerSignature: signature,
    blockers: [
      {
        code: "PREFLIGHT_CONNECTION_BLOCKED",
        signature,
        message: `connection blocked: ${signature}`,
        remediation: "open Unity",
      },
    ],
    prerequisites: [],
  };
}

function noListenerBlockedResult(command: string): BridgePreflightResult {
  return connBlockedResult(command, "ECONNREFUSED_NO_LISTENER");
}

function otherBlockedResult(command: string): BridgePreflightResult {
  return {
    status: "blocked",
    command,
    checkedAtUnixMs: 0,
    deterministic: true,
    sessionReady: true,
    handshakeReady: true,
    sessionId: "s",
    blockerSignature: "PROTOCOL_VERSION_MISMATCH",
    blockers: [
      {
        code: "PREFLIGHT_PREREQUISITE_PROTOCOL_MISMATCH",
        signature: "PROTOCOL_VERSION_MISMATCH",
        message: "protocol mismatch",
        remediation: "upgrade",
      },
    ],
    prerequisites: [],
  };
}

test("isReloadWindowCommand: only the preflight-gated reload-window ops are listed (editor.stop excluded — not preflight-gated)", () => {
  assert.equal(isReloadWindowCommand("editor.wait_for"), true);
  assert.equal(isReloadWindowCommand("editor.play"), true);
  // editor.stop is NOT in the deterministic-preflight trigger set, so listing it would be dead
  // config that claims coverage the pipeline never delivers. Surviving a reload around stop is
  // deferred (see RELOAD_WINDOW_COMMANDS comment).
  assert.equal(isReloadWindowCommand("editor.stop"), false);
  assert.equal(isReloadWindowCommand("editor.screenshot"), false);
  assert.equal(isReloadWindowCommand("runtime.get_snapshot"), false);
});

test("runReloadAwarePreflight: reload-window op polls through a transient no-listener window, then passes", async () => {
  let clock = 1000;
  let attempt = 0;
  const result = await runReloadAwarePreflight("editor.wait_for", 30000, {
    runPreflight: async () => {
      attempt += 1;
      // First two passes hit the bouncing listener; third sees the bridge back up.
      return attempt < 3 ? noListenerBlockedResult("editor.wait_for") : passResult("editor.wait_for");
    },
    hasEverConnected: () => true,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    pollIntervalMs: 250,
  });
  assert.equal(result.status, "pass");
  assert.equal(attempt, 3);
});

test("runReloadAwarePreflight: a non-ECONNREFUSED survivable class (TIMEOUT_CONNECT) also polls through, then passes", async () => {
  // A reload can present as a connect timeout / handshake stall while the main thread is frozen,
  // not only as 'no listener'. Those are still reload-survivable while hasEverConnected.
  let clock = 1000;
  let attempt = 0;
  const result = await runReloadAwarePreflight("editor.wait_for", 30000, {
    runPreflight: async () => {
      attempt += 1;
      return attempt < 3
        ? connBlockedResult("editor.wait_for", "TIMEOUT_CONNECT")
        : passResult("editor.wait_for");
    },
    hasEverConnected: () => true,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    pollIntervalMs: 250,
  });
  assert.equal(result.status, "pass");
  assert.equal(attempt, 3);
});

test("runReloadAwarePreflight: dead-bridge polling is capped by the SHORT reload budget, not the full op timeout", async () => {
  // The op timeout is large (30s) but a genuinely-dead bridge (never recovers) must fail in
  // ~RELOAD_POLL_BUDGET_MS (~4s), not stall for the full 30s. Use an explicit small budget so the
  // assertion is exact and independent of the production constant.
  let clock = 1000;
  let attempt = 0;
  const result = await runReloadAwarePreflight("editor.wait_for", 30000, {
    runPreflight: async () => {
      attempt += 1;
      return noListenerBlockedResult("editor.wait_for"); // never recovers
    },
    hasEverConnected: () => true,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    pollIntervalMs: 250,
    pollBudgetMs: 4000,
  });
  assert.equal(result.status, "blocked");
  const elapsed = clock - 1000;
  // Bounded by the 4000ms budget (NOT the 30000ms op timeout): ~16 polls of 250ms.
  assert.ok(elapsed <= 4000, `polling must stop within the 4000ms budget, stopped at ${elapsed}ms`);
  assert.ok(elapsed >= 3750, `must actually use the budget before giving up, stopped at ${elapsed}ms`);
  assert.ok(attempt <= 18, `attempts must be bounded by the budget, got ${attempt}`);
});

test("runReloadAwarePreflight: the budget never exceeds the op timeout (short timeout wins over the budget)", async () => {
  // When the op timeout is SHORTER than the reload budget, the timeout bounds polling.
  let clock = 0;
  let attempt = 0;
  await runReloadAwarePreflight("editor.wait_for", 1000, {
    runPreflight: async () => {
      attempt += 1;
      return noListenerBlockedResult("editor.wait_for");
    },
    hasEverConnected: () => true,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    pollIntervalMs: 250,
    pollBudgetMs: 4000,
  });
  // min(1000, 4000) = 1000ms / 250 = ~4 polls.
  assert.ok(clock <= 1000, `short op timeout must cap polling at 1000ms, stopped at ${clock}ms`);
});

test("runReloadAwarePreflight: never-connected bridge is NOT polled (genuinely-dead, blocks on first pass)", async () => {
  let attempt = 0;
  const result = await runReloadAwarePreflight("editor.wait_for", 30000, {
    runPreflight: async () => {
      attempt += 1;
      return noListenerBlockedResult("editor.wait_for");
    },
    hasEverConnected: () => false, // never had a listener
    now: () => 0,
    sleep: async () => { throw new Error("must not sleep on a never-connected bridge"); },
  });
  assert.equal(result.status, "blocked");
  assert.equal(attempt, 1, "a never-up bridge must block immediately, not poll");
});

test("runReloadAwarePreflight: a non-connection blocker (protocol mismatch) is terminal, not polled", async () => {
  let attempt = 0;
  const result = await runReloadAwarePreflight("editor.wait_for", 30000, {
    runPreflight: async () => {
      attempt += 1;
      return otherBlockedResult("editor.wait_for");
    },
    hasEverConnected: () => true,
    now: () => 0,
    sleep: async () => { throw new Error("must not poll through a real prerequisite block"); },
  });
  assert.equal(result.status, "blocked");
  assert.equal(attempt, 1);
});

test("runReloadAwarePreflight: a non-reload-window op returns the first result unchanged (no polling)", async () => {
  let attempt = 0;
  const result = await runReloadAwarePreflight("editor.screenshot", 30000, {
    runPreflight: async () => {
      attempt += 1;
      return noListenerBlockedResult("editor.screenshot");
    },
    hasEverConnected: () => true,
    now: () => 0,
    sleep: async () => { throw new Error("must not poll a non-reload-window op"); },
  });
  assert.equal(result.status, "blocked");
  assert.equal(attempt, 1);
});

// shouldRetryReloadDrop / isReloadSurvivableSendCommand: async measure/capture ops survive an
// in-flight reload drop on the SEND path (RCL-T03 async follow-up)
test("isReloadSurvivableSendCommand: only async measurement/capture ops are reload-survivable on send", () => {
  assert.equal(isReloadSurvivableSendCommand("runtime.measure_motion"), true);
  assert.equal(isReloadSurvivableSendCommand("runtime.capture_sequence"), true);
  assert.equal(isReloadSurvivableSendCommand("runtime.capture_input_motion"), true);
  assert.equal(isReloadSurvivableSendCommand("runtime.capture_pointer_motion"), true);
  // Not survivable: a non-idempotent or non-measurement op must not silently re-run on a bare timeout
  assert.equal(isReloadSurvivableSendCommand("runtime.get_snapshot"), false);
  assert.equal(isReloadSurvivableSendCommand("scene.create_object"), false);
  assert.equal(isReloadSurvivableSendCommand("package.add"), false);
  assert.equal(isReloadSurvivableSendCommand("editor.play"), false);
});

test("shouldRetryReloadDrop: ANY op retries on CONNECTION_LOST (socket dropped — existing behavior)", () => {
  assert.equal(shouldRetryReloadDrop("scene.create_object", "[CONNECTION_LOST] socket closed"), true);
  assert.equal(shouldRetryReloadDrop("runtime.measure_motion", "[CONNECTION_LOST] socket closed"), true);
  assert.equal(shouldRetryReloadDrop("editor.play", "CONNECTION_LOST"), true);
});

test("shouldRetryReloadDrop: a survivable op ALSO retries on a reload-shaped bare timeout / refused", () => {
  // The exact dogfood signature: measure_motion died on a 30s timeout catching a reload window
  assert.equal(
    shouldRetryReloadDrop("runtime.measure_motion", "[CONNECTION_ERROR] Timeout (30000ms)"),
    true
  );
  assert.equal(shouldRetryReloadDrop("runtime.capture_sequence", "Not connected to Unity"), true);
  assert.equal(
    shouldRetryReloadDrop("runtime.capture_input_motion", "connect ECONNREFUSED 127.0.0.1:9999"),
    true
  );
  assert.equal(
    shouldRetryReloadDrop("runtime.measure_motion", "ECONNREFUSED_NO_LISTENER"),
    true
  );
});

test("shouldRetryReloadDrop: a NON-survivable op never retries on a bare timeout (no double-execute)", () => {
  // A non-idempotent op timing out must NOT be re-sent — re-running it could double its side effect
  assert.equal(shouldRetryReloadDrop("scene.create_object", "[CONNECTION_ERROR] Timeout (30000ms)"), false);
  assert.equal(shouldRetryReloadDrop("package.add", "Not connected to Unity"), false);
  assert.equal(shouldRetryReloadDrop("editor.play", "Timeout (30000ms)"), false);
});

test("shouldRetryReloadDrop: a survivable op does NOT retry on an unrelated (non-reload) error", () => {
  // A genuine validation/logic error is terminal even for a survivable op — only reload-shaped fails retry
  assert.equal(shouldRetryReloadDrop("runtime.measure_motion", "INVALID_PARAMS: locator required"), false);
  assert.equal(shouldRetryReloadDrop("runtime.capture_sequence", "NOT_FOUND: object missing"), false);
});

// ─────────────────────────────────────────────
// Contextual failure hints (Tranche 4a / GRL-C22)
// ─────────────────────────────────────────────

/** Pull the parsed { hint } from the last content entry, or undefined if none. */
function extractHint(result: { content: Array<{ type: string; text?: string }> }): ContextualHint | undefined {
  const last = result.content[result.content.length - 1];
  if (!last || last.type !== "text" || typeof last.text !== "string") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(last.text);
  } catch {
    return undefined;
  }
  return (parsed as { hint?: ContextualHint } | null)?.hint;
}

// ── withHint additive-safety: no hint ⇒ byte-identical to before ──

test("formatToolResult: without a hint the payload is unchanged (single content entry)", () => {
  const result = formatToolResult("editor.get_state", { ok: true });
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0]!.type, "text");
  assert.equal((result.content[0] as { text: string }).text, JSON.stringify({ ok: true }));
});

test("formatErrorResult: without a hint the payload is unchanged (single content entry)", () => {
  const result = formatErrorResult("boom", "CONNECTION_ERROR");
  assert.equal(result.isError, true);
  assert.equal(result.content.length, 1);
  assert.equal((result.content[0] as { text: string }).text, "[CONNECTION_ERROR] boom");
});

test("formatToolResult: a hint is appended as a SEPARATE trailing entry, content[0] byte-identical", () => {
  const hint: ContextualHint = { tool: "unity_editor_get_project_diagnostics", when: "w", why: "y" };
  const withoutHint = formatToolResult("editor.get_state", { ok: true });
  const withHintResult = formatToolResult("editor.get_state", { ok: true }, hint);
  // Primary payload is preserved exactly — additive only.
  assert.deepEqual(withHintResult.content[0], withoutHint.content[0]);
  assert.equal(withHintResult.content.length, 2);
  assert.deepEqual(extractHint(withHintResult), hint);
});

test("formatErrorResult: a hint never alters the error code / isError / message text", () => {
  const hint: ContextualHint = { tool: "unity_editor_wait_for", when: "w", why: "y" };
  const withHintResult = formatErrorResult("boom", "CONNECTION_ERROR", hint);
  assert.equal(withHintResult.isError, true);
  assert.equal((withHintResult.content[0] as { text: string }).text, "[CONNECTION_ERROR] boom");
  assert.equal(withHintResult.content.length, 2);
  assert.deepEqual(extractHint(withHintResult), hint);
});

// ── Site a: editor.play settle-failure compile-error hint ──

test("buildPlaySettleCompileHint: FIRES when a compile_error block is present", () => {
  const hint = buildPlaySettleCompileHint({ file: "A.cs", line: 3, message: "CS0103" });
  assert.ok(hint);
  assert.equal(hint!.tool, "unity_editor_get_project_diagnostics");
});

test("buildPlaySettleCompileHint: ABSENT when no compile error was detected (undefined / null / non-object)", () => {
  assert.equal(buildPlaySettleCompileHint(undefined), undefined);
  assert.equal(buildPlaySettleCompileHint(null), undefined);
  assert.equal(buildPlaySettleCompileHint("some string"), undefined);
});

// ── Site b: editor.wait_for failed compileResult hint ──

test("buildWaitForCompileFailureHint: FIRES on a FAILED compileResult (succeeded:false)", () => {
  const hint = buildWaitForCompileFailureHint("editor.wait_for", {
    waited_ms: 120,
    compileResult: { compileId: 1, succeeded: false, errorCount: 2, errors: [{ file: "A.cs" }] },
  });
  assert.ok(hint);
  assert.equal(hint!.tool, "unity_editor_get_project_diagnostics");
});

test("buildWaitForCompileFailureHint: FIRES when errorCount>0 even if succeeded flag is missing", () => {
  const hint = buildWaitForCompileFailureHint("editor.wait_for", {
    compileResult: { errorCount: 1 },
  });
  assert.ok(hint);
});

test("buildWaitForCompileFailureHint: ABSENT on a SUCCEEDED compileResult (negative path)", () => {
  const hint = buildWaitForCompileFailureHint("editor.wait_for", {
    compileResult: { compileId: 1, succeeded: true, errorCount: 0, errors: [] },
  });
  assert.equal(hint, undefined);
});

test("buildWaitForCompileFailureHint: ABSENT when NO compileResult (absence is not failure)", () => {
  assert.equal(buildWaitForCompileFailureHint("editor.wait_for", { waited_ms: 40 }), undefined);
  assert.equal(buildWaitForCompileFailureHint("editor.wait_for", {}), undefined);
  assert.equal(buildWaitForCompileFailureHint("editor.wait_for", null), undefined);
});

test("buildWaitForCompileFailureHint: ABSENT for a different command even with a failed compileResult", () => {
  const hint = buildWaitForCompileFailureHint("editor.get_state", {
    compileResult: { succeeded: false, errorCount: 3 },
  });
  assert.equal(hint, undefined);
});

// ── Site c: editor.console_logs error-severity hint ──

test("buildConsoleErrorHint: FIRES when logs include an error-severity entry (type=Error)", () => {
  const hint = buildConsoleErrorHint("editor.console_logs", {
    logs: [{ type: "Log", message: "hi" }, { type: "Error", message: "NRE" }],
  });
  assert.ok(hint);
  assert.equal(hint!.tool, "unity_editor_get_project_diagnostics");
});

test("buildConsoleErrorHint: FIRES on Exception and Assert severities (case-insensitive, level field)", () => {
  assert.ok(buildConsoleErrorHint("editor.console_logs", { logs: [{ level: "exception" }] }));
  assert.ok(buildConsoleErrorHint("editor.console_logs", { logs: [{ type: "Assert" }] }));
});

test("buildConsoleErrorHint: ABSENT when logs are warnings/logs only (negative path)", () => {
  const hint = buildConsoleErrorHint("editor.console_logs", {
    logs: [{ type: "Warning", message: "w" }, { type: "Log", message: "l" }],
  });
  assert.equal(hint, undefined);
});

test("buildConsoleErrorHint: ABSENT on an empty log set and when logs is missing", () => {
  assert.equal(buildConsoleErrorHint("editor.console_logs", { logs: [] }), undefined);
  assert.equal(buildConsoleErrorHint("editor.console_logs", {}), undefined);
  assert.equal(buildConsoleErrorHint("editor.console_logs", null), undefined);
});

test("buildConsoleErrorHint: ABSENT for a different command even with error logs", () => {
  const hint = buildConsoleErrorHint("editor.get_state", { logs: [{ type: "Error" }] });
  assert.equal(hint, undefined);
});

// ── Site d: CONNECTION_LOST after a reload-triggering op hint ──

test("isDomainReloadTriggeringCommand: the documented reload-triggering set, and nothing else", () => {
  for (const cmd of [
    "package.add",
    "package.remove",
    "code.create_script",
    "code.modify_script",
    "code.attach_script",
    "editor.refresh_assets",
  ]) {
    assert.equal(isDomainReloadTriggeringCommand(cmd), true, cmd);
  }
  assert.equal(isDomainReloadTriggeringCommand("editor.play"), false);
  assert.equal(isDomainReloadTriggeringCommand("runtime.measure_motion"), false);
  assert.equal(isDomainReloadTriggeringCommand("scene.set_transform"), false);
});

test("buildReloadReconnectHint: FIRES on CONNECTION_LOST after a reload-triggering op", () => {
  const hint = buildReloadReconnectHint("package.add", "[CONNECTION_ERROR] CONNECTION_LOST: socket closed");
  assert.ok(hint);
  assert.equal(hint!.tool, "unity_editor_wait_for");
});

test("buildReloadReconnectHint: ABSENT when the op does NOT trigger a reload (negative path)", () => {
  assert.equal(buildReloadReconnectHint("editor.play", "CONNECTION_LOST"), undefined);
  assert.equal(buildReloadReconnectHint("runtime.measure_motion", "CONNECTION_LOST"), undefined);
});

test("buildReloadReconnectHint: ABSENT when the error is NOT CONNECTION_LOST (a plain timeout on a reload op)", () => {
  assert.equal(buildReloadReconnectHint("package.add", "Timeout waiting for response (120000ms)"), undefined);
  assert.equal(buildReloadReconnectHint("package.remove", "INVALID_PARAMS: bad id"), undefined);
});
