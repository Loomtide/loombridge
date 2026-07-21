import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  collapseReloadChurn,
  DISCOVERY_FILE_ENV_VAR,
  DISCOVERY_LATEST_FILE_NAME,
  loadPreferredEndpointDiscovery,
  projectPathsEquivalent,
  resolveDiscoveryDirectory,
  scanEndpointDiscoveryRecords,
  selectEndpointDiscoveryRecord,
} from "../editor-discovery.js";
import type { UnityEndpointDiscoveryRecord } from "../types.js";

function discoveryRecord(overrides: Partial<{
  sessionId: string;
  projectPathCanonical: string;
  projectPath: string;
  projectName: string;
  processId: number;
  publishedAtUnixMs: number;
  expiresAtUnixMs: number;
  port: number;
}> = {}): UnityEndpointDiscoveryRecord {
  const projectPathCanonical = overrides.projectPathCanonical ?? "/Users/dev/GameA";
  return {
    schemaVersion: "1",
    sessionId: overrides.sessionId ?? "session-a",
    projectPath: overrides.projectPath ?? projectPathCanonical,
    projectPathCanonical,
    projectName: overrides.projectName ?? path.basename(projectPathCanonical),
    processId: overrides.processId ?? 123,
    publishedAtUnixMs: overrides.publishedAtUnixMs ?? 1000,
    expiresAtUnixMs: overrides.expiresAtUnixMs ?? 10_000,
    transportModeDefault: "auto",
    endpoints: [
      {
        transport: "tcp",
        kind: "websocket",
        host: "localhost",
        port: overrides.port ?? 8200,
        supportsHandshake: true,
        supportsPing: true,
      },
    ],
  };
}

async function writeJson(filePath: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(data)}\n`, "utf8");
}

test("editor discovery: scan excludes latest and ignores corrupt files", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "loomtide-discovery-test-"));
  await writeJson(path.join(dir, "endpoint-discovery-a.json"), discoveryRecord({ sessionId: "a" }));
  await writeJson(path.join(dir, DISCOVERY_LATEST_FILE_NAME), discoveryRecord({ sessionId: "latest" }));
  await fs.writeFile(path.join(dir, "endpoint-discovery-corrupt.json"), "{not json", "utf8");

  const records = scanEndpointDiscoveryRecords(dir, 5000);

  assert.deepEqual(records.map((record) => record.sessionId), ["a"]);
});

test("editor discovery: scan honors directory env override through preferred loader", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "loomtide-discovery-env-"));
  await writeJson(path.join(dir, "endpoint-discovery-b.json"), discoveryRecord({
    sessionId: "b",
    projectPathCanonical: "/Users/dev/GameB",
    publishedAtUnixMs: 2000,
  }));

  const record = loadPreferredEndpointDiscovery(null, {
    LOOMTIDE_ENDPOINT_DISCOVERY_DIR: dir,
  }, 5000);

  assert.equal(resolveDiscoveryDirectory({ LOOMTIDE_ENDPOINT_DISCOVERY_DIR: dir }), dir);
  assert.equal(record?.sessionId, "b");
});

test("editor discovery: sanitized env still resolves the platform temp directory", () => {
  const resolved = resolveDiscoveryDirectory({});

  assert.equal(path.basename(resolved), "unitybridge");
  assert.equal(path.basename(path.dirname(resolved)), "loomtide");
  if (process.platform === "darwin") {
    assert.notEqual(resolved, path.join("/tmp", "loomtide", "unitybridge"));
  }
});

test("editor discovery: macOS ignores a custom $TMPDIR and uses DARWIN_USER_TEMP_DIR (C1)", { skip: process.platform !== "darwin" }, () => {
  // The MCP server may carry a custom TMPDIR (e.g. a coding agent's /tmp/claude-NNN)
  // while a GUI Editor writes under launchd's per-user dir. The reader must NOT follow
  // its own TMPDIR; it must resolve the env-independent DARWIN_USER_TEMP_DIR that the
  // Unity bridge (BridgeServer.ResolveDiscoveryTempBase) also resolves — otherwise the
  // two processes never share a directory and multi-editor discovery breaks.
  const darwinUserTemp = execFileSync("/usr/bin/getconf", ["DARWIN_USER_TEMP_DIR"], {
    encoding: "utf8",
  }).trim();
  const resolved = resolveDiscoveryDirectory({ TMPDIR: "/tmp/some-custom-agent-tmp" });

  assert.ok(
    resolved.startsWith(darwinUserTemp),
    `expected ${resolved} to be under ${darwinUserTemp}, not the custom $TMPDIR`,
  );
  assert.ok(!resolved.startsWith("/tmp/some-custom-agent-tmp"));
});

test("editor discovery: reload churn drops records without a canonical project (M3)", () => {
  const withProject = discoveryRecord({ projectPathCanonical: "/Users/dev/GameA" });
  const withoutProject = { ...discoveryRecord({ sessionId: "no-id" }), projectPathCanonical: undefined };

  const collapsed = collapseReloadChurn([withProject, withoutProject]);

  assert.deepEqual(collapsed.map((r) => r.sessionId), ["session-a"]);
});

test("editor discovery: reload churn collapses identity-less (no processId) files to one peer (M3)", () => {
  // One editor that left several stale per-session files lacking processId must present
  // as a SINGLE peer, not several — otherwise routing sees false EDITOR_AMBIGUOUS.
  const mk = (sessionId: string, publishedAtUnixMs: number) => ({
    ...discoveryRecord({ sessionId, projectPathCanonical: "/Users/dev/GameA", publishedAtUnixMs }),
    processId: undefined,
  });

  const collapsed = collapseReloadChurn([mk("old", 1000), mk("new", 2000), mk("mid", 1500)]);

  assert.equal(collapsed.length, 1);
  assert.equal(collapsed[0]!.sessionId, "new");
});

test("editor discovery: explicit single-file override remains compatible", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "loomtide-discovery-file-"));
  const file = path.join(dir, "custom-discovery.json");
  await writeJson(file, discoveryRecord({ sessionId: "explicit", projectPathCanonical: "/Users/dev/Explicit" }));

  const record = loadPreferredEndpointDiscovery("/Users/dev/Other", {
    [DISCOVERY_FILE_ENV_VAR]: file,
  }, 5000);

  assert.equal(record?.sessionId, "explicit");
  assert.equal(record?.projectPathCanonical, "/Users/dev/Explicit");
});

test("editor discovery: pinned selection prefers matching project over newer latest-like peer", () => {
  const selected = selectEndpointDiscoveryRecord([
    discoveryRecord({
      sessionId: "game-a",
      projectPathCanonical: "/Users/dev/GameA",
      publishedAtUnixMs: 1000,
    }),
    discoveryRecord({
      sessionId: "game-b-newer",
      projectPathCanonical: "/Users/dev/GameB",
      publishedAtUnixMs: 2000,
    }),
  ], "/Users/dev/GameA");

  assert.equal(selected?.sessionId, "game-a");
});

test("editor discovery: reload churn collapses same project/process to newest record", () => {
  const collapsed = collapseReloadChurn([
    discoveryRecord({
      sessionId: "old-session",
      projectPathCanonical: "/Users/dev/GameA",
      processId: 123,
      publishedAtUnixMs: 1000,
    }),
    discoveryRecord({
      sessionId: "new-session",
      projectPathCanonical: "/Users/dev/GameA",
      processId: 123,
      publishedAtUnixMs: 2000,
    }),
    discoveryRecord({
      sessionId: "other-process",
      projectPathCanonical: "/Users/dev/GameA",
      processId: 456,
      publishedAtUnixMs: 1500,
    }),
  ]);

  assert.deepEqual(
    collapsed.map((record) => record.sessionId).sort(),
    ["new-session", "other-process"],
  );
});

test("editor discovery: projectPathsEquivalent treats a symlink and its target as equal", () => {
  const root = fsSync.mkdtempSync(path.join(os.tmpdir(), "loomtide-symlink-eq-"));
  try {
    const realDir = path.join(root, "real-project");
    const linkDir = path.join(root, "linked-project");
    fsSync.mkdirSync(realDir);
    fsSync.symlinkSync(realDir, linkDir);

    // Equal in both orderings (symlink resolves to the real dir).
    assert.equal(projectPathsEquivalent(realDir, linkDir), true);
    assert.equal(projectPathsEquivalent(linkDir, realDir), true);

    // Identical spellings short-circuit via the fast path.
    assert.equal(projectPathsEquivalent(realDir, realDir), true);
  } finally {
    fsSync.rmSync(root, { recursive: true, force: true });
  }
});

test("editor discovery: projectPathsEquivalent rejects unrelated dirs and non-existent paths", () => {
  const root = fsSync.mkdtempSync(path.join(os.tmpdir(), "loomtide-symlink-neq-"));
  try {
    const a = path.join(root, "alpha");
    const b = path.join(root, "beta");
    fsSync.mkdirSync(a);
    fsSync.mkdirSync(b);

    // Two unrelated real dirs are unequal.
    assert.equal(projectPathsEquivalent(a, b), false);

    // Non-existent paths return false (no throw).
    assert.equal(
      projectPathsEquivalent(path.join(root, "missing-x"), path.join(root, "missing-y")),
      false,
    );
    assert.equal(projectPathsEquivalent(a, path.join(root, "missing")), false);
  } finally {
    fsSync.rmSync(root, { recursive: true, force: true });
  }
});
