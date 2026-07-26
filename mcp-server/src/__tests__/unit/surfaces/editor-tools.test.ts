import assert from "node:assert/strict";
import test from "node:test";
import {
  buildEditorListPayload,
  EDITOR_LIST_TOOL,
  EDITOR_LIST_TOOL_NAME,
  EDITOR_USE_TOOL,
  EDITOR_USE_TOOL_NAME,
} from "../../../surfaces/editor-tools.js";
import type { UnityEndpointDiscoveryRecord } from "../../../shared/types.js";

function record(overrides: Partial<UnityEndpointDiscoveryRecord> = {}): UnityEndpointDiscoveryRecord {
  return {
    schemaVersion: "1",
    sessionId: overrides.sessionId ?? "session-a",
    projectPath: overrides.projectPath ?? "/Users/dev/GameA",
    projectPathCanonical: overrides.projectPathCanonical ?? "/Users/dev/GameA",
    projectName: overrides.projectName ?? "GameA",
    processId: overrides.processId ?? 123,
    publishedAtUnixMs: overrides.publishedAtUnixMs ?? 1000,
    expiresAtUnixMs: overrides.expiresAtUnixMs ?? 10_000,
    transportModeDefault: overrides.transportModeDefault ?? "auto",
    endpoints: overrides.endpoints ?? [
      {
        transport: "tcp",
        kind: "websocket",
        host: "localhost",
        port: 8200,
        supportsHandshake: true,
        supportsPing: true,
      },
    ],
  };
}

test("editor list tool has stable MCP shape", () => {
  assert.equal(EDITOR_LIST_TOOL.name, EDITOR_LIST_TOOL_NAME);
  assert.equal(EDITOR_LIST_TOOL.inputSchema.type, "object");
});

test("editor use tool has stable MCP shape", () => {
  assert.equal(EDITOR_USE_TOOL.name, EDITOR_USE_TOOL_NAME);
  assert.equal(EDITOR_USE_TOOL_NAME, "loombridge_editor_use");
  assert.equal(EDITOR_USE_TOOL.inputSchema.type, "object");
  assert.deepEqual(EDITOR_USE_TOOL.inputSchema.required, ["project"]);
});

test("buildEditorListPayload marks the active project and collapses reload churn", () => {
  const payload = buildEditorListPayload([
    record({
      sessionId: "old",
      projectPathCanonical: "/Users/dev/GameA",
      processId: 123,
      publishedAtUnixMs: 1000,
    }),
    record({
      sessionId: "new",
      projectPathCanonical: "/Users/dev/GameA",
      processId: 123,
      publishedAtUnixMs: 2000,
    }),
    record({
      sessionId: "other",
      projectPath: "/Users/dev/GameB",
      projectPathCanonical: "/Users/dev/GameB",
      projectName: "GameB",
      processId: 456,
      publishedAtUnixMs: 1500,
    }),
  ], "/Users/dev/GameA");

  assert.equal(payload.count, 2);
  assert.equal(payload.activeProjectPathCanonical, "/Users/dev/GameA");
  assert.deepEqual(
    payload.peers.map((peer) => [peer.sessionId, peer.active]),
    [["new", true], ["other", false]],
  );
  // No startupBinding argument → null in the payload.
  assert.equal(payload.startupBinding, null);
});

test("buildEditorListPayload surfaces the startup binding descriptor and marks the peeked active peer", () => {
  const payload = buildEditorListPayload(
    [
      record({ sessionId: "a", projectPathCanonical: "/Users/dev/GameA", projectName: "GameA" }),
      record({ sessionId: "b", projectPath: "/Users/dev/GameB", projectPathCanonical: "/Users/dev/GameB", projectName: "GameB", processId: 456 }),
    ],
    // Peeked effective-active path (not a committed pin) drives the active flag.
    "/Users/dev/GameB",
    { kind: "strict", target: "/Users/dev/GameB", resolved: true },
  );

  assert.equal(payload.activeProjectPathCanonical, "/Users/dev/GameB");
  assert.deepEqual(payload.startupBinding, {
    kind: "strict",
    target: "/Users/dev/GameB",
    resolved: true,
  });
  assert.deepEqual(
    payload.peers.map((peer) => [peer.sessionId, peer.active]),
    [["a", false], ["b", true]],
  );
});

test("buildEditorListPayload carries an unresolved startup binding even when no peer is active", () => {
  const payload = buildEditorListPayload(
    [record({ sessionId: "a", projectPathCanonical: "/Users/dev/GameA", projectName: "GameA" })],
    null,
    { kind: "strict", target: "/Users/dev/Missing", resolved: false },
  );

  assert.equal(payload.activeProjectPathCanonical, null);
  assert.deepEqual(payload.startupBinding, {
    kind: "strict",
    target: "/Users/dev/Missing",
    resolved: false,
  });
  assert.equal(payload.peers.every((peer) => peer.active === false), true);
});
