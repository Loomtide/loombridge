import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { EditorRoutingError } from "../editor-registry.js";
import type { UnityEndpointDiscoveryRecord } from "../types.js";
import {
  buildUnityRoutingMetadata,
  createUnityClientForCli,
  resolveUnityProjectTarget,
  type ResolvedUnityClient,
  UNITY_PROJECT_ENV_VAR,
} from "../verification/unity-client-resolver.js";

function discoveryRecord(overrides: Partial<{
  sessionId: string;
  projectPathCanonical: string;
  projectName: string;
  processId: number;
}> = {}): UnityEndpointDiscoveryRecord {
  const projectPathCanonical = overrides.projectPathCanonical ?? "/Users/dev/GameA";
  return {
    schemaVersion: "1",
    sessionId: overrides.sessionId ?? "session-a",
    projectPath: projectPathCanonical,
    projectPathCanonical,
    projectName: overrides.projectName ?? path.basename(projectPathCanonical),
    processId: overrides.processId ?? 123,
    publishedAtUnixMs: 1000,
    expiresAtUnixMs: 10_000,
    transportModeDefault: "auto",
    endpoints: [
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

test("unity-client resolver: explicit project overrides env", () => {
  assert.equal(
    resolveUnityProjectTarget("GameA", { [UNITY_PROJECT_ENV_VAR]: "GameB" }),
    "GameA",
  );
});

test("unity-client resolver: env project is used when arg is omitted", () => {
  assert.equal(
    resolveUnityProjectTarget(undefined, { [UNITY_PROJECT_ENV_VAR]: "GameB" }),
    "GameB",
  );
});

test("unity-client resolver: CLI target selects a pinned project client", async () => {
  const resolved = createUnityClientForCli({
    project: "GameB",
    scanRecords: () => [
      discoveryRecord({ projectPathCanonical: "/Users/dev/GameA", projectName: "GameA" }),
      discoveryRecord({ projectPathCanonical: "/Users/dev/GameB", projectName: "GameB", sessionId: "session-b" }),
    ],
  });

  assert.equal(resolved.projectTarget, "GameB");
  assert.equal(resolved.route.projectPathCanonical, "/Users/dev/GameB");
  await resolved.disconnect();
});

function fakeResolved(handshake: unknown, recordSessionId: string): ResolvedUnityClient {
  const record = discoveryRecord({ sessionId: recordSessionId });
  return {
    client: { handshake } as ResolvedUnityClient["client"],
    route: {
      client: {} as ResolvedUnityClient["client"],
      projectPathCanonical: record.projectPathCanonical ?? null,
      record,
      reason: "single",
    },
    projectTarget: null,
    disconnect: async () => {},
  };
}

test("buildUnityRoutingMetadata: prefers the live handshake session over the discovery record", () => {
  // This is why metadata must be snapshotted BEFORE disconnect(): a live handshake
  // is authoritative; once disconnect() nulls it, only the (possibly stale) record remains.
  const meta = buildUnityRoutingMetadata(
    fakeResolved({ sessionId: "live-session", projectPathCanonical: "/Users/dev/GameA" }, "stale-discovery-session"),
  );
  assert.equal(meta.editorSessionId, "live-session");
});

test("buildUnityRoutingMetadata: falls back to the discovery record session when disconnected", () => {
  const meta = buildUnityRoutingMetadata(fakeResolved(null, "stale-discovery-session"));
  assert.equal(meta.editorSessionId, "stale-discovery-session");
});

test("unity-client resolver: multiple editors without target fail closed", () => {
  assert.throws(
    () => createUnityClientForCli({
      scanRecords: () => [
        discoveryRecord({ projectPathCanonical: "/Users/dev/GameA" }),
        discoveryRecord({ projectPathCanonical: "/Users/dev/GameB", sessionId: "session-b" }),
      ],
    }),
    (err: Error) => err instanceof EditorRoutingError
      && err.code === "EDITOR_AMBIGUOUS",
  );
});
