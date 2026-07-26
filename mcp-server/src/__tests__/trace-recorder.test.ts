import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { TraceRecorder, type TraceEntry } from "../bridge/trace-recorder.js";

/**
 * Creates a temp directory for test isolation.
 * Returns the path to the temp dir.
 */
function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "trace-test-"));
}

test("TraceRecorder: record writes JSONL line that can be parsed back", async () => {
  const tmpDir = makeTempDir();
  try {
    const recorder = new TraceRecorder(tmpDir);
    recorder.setSessionId("test-session-1");

    const entry: TraceEntry = {
      timestamp: Date.now(),
      sessionId: "test-session-1",
      type: "op",
      op: "scene.create_object",
      input: { name: "Cube" },
      output: { locator: { path: "/Cube" } },
      durationMs: 42,
    };

    await recorder.record(entry);

    const filePath = path.join(tmpDir, "trace-test-session-1.jsonl");
    assert.ok(fs.existsSync(filePath), "JSONL file should exist");

    const content = fs.readFileSync(filePath, "utf-8").trim();
    const parsed = JSON.parse(content);
    assert.equal(parsed.type, "op");
    assert.equal(parsed.op, "scene.create_object");
    assert.equal(parsed.durationMs, 42);
    assert.deepEqual(parsed.input, { name: "Cube" });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("TraceRecorder: multiple records produce multiple JSONL lines", async () => {
  const tmpDir = makeTempDir();
  try {
    const recorder = new TraceRecorder(tmpDir);
    recorder.setSessionId("multi-session");

    await recorder.record({
      timestamp: 1000,
      sessionId: "multi-session",
      type: "connect",
    });

    await recorder.record({
      timestamp: 2000,
      sessionId: "multi-session",
      type: "op",
      op: "editor.screenshot",
      durationMs: 100,
    });

    const filePath = path.join(tmpDir, "trace-multi-session.jsonl");
    const lines = fs.readFileSync(filePath, "utf-8").trim().split("\n");
    assert.equal(lines.length, 2);

    const line1 = JSON.parse(lines[0]!);
    assert.equal(line1.type, "connect");

    const line2 = JSON.parse(lines[1]!);
    assert.equal(line2.type, "op");
    assert.equal(line2.op, "editor.screenshot");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("TraceRecorder: base64 redaction replaces image_base64 with artifactRef", async () => {
  const tmpDir = makeTempDir();
  try {
    const recorder = new TraceRecorder(tmpDir);
    recorder.setSessionId("redact-session");

    // Create a small fake base64 image (just a few bytes)
    const fakeImageData = Buffer.from("fake-png-data").toString("base64");

    const entry: TraceEntry = {
      timestamp: 1234567890,
      sessionId: "redact-session",
      type: "op",
      op: "editor.screenshot",
      output: {
        image_base64: fakeImageData,
        format: "png",
        width: 100,
        height: 100,
      },
      durationMs: 50,
    };

    await recorder.record(entry);

    const filePath = path.join(tmpDir, "trace-redact-session.jsonl");
    const content = fs.readFileSync(filePath, "utf-8").trim();
    const parsed = JSON.parse(content);

    // image_base64 should be replaced with artifactRef
    assert.equal(parsed.output.image_base64, undefined);
    assert.ok(parsed.output.artifactRef, "Should have artifactRef");
    assert.match(parsed.output.artifactRef, /^artifacts\/screenshot_/);
    assert.match(parsed.output.artifactRef, /\.png$/);

    // The artifact file should exist
    const artifactPath = path.join(tmpDir, parsed.output.artifactRef);
    assert.ok(fs.existsSync(artifactPath), "Artifact file should exist");

    // Verify contents match
    const artifactData = fs.readFileSync(artifactPath);
    assert.deepEqual(artifactData, Buffer.from(fakeImageData, "base64"));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("TraceRecorder: base64 redaction uses .jpg for jpeg format", async () => {
  const tmpDir = makeTempDir();
  try {
    const recorder = new TraceRecorder(tmpDir);
    recorder.setSessionId("jpeg-session");

    const fakeImageData = Buffer.from("fake-jpeg-data").toString("base64");

    const entry: TraceEntry = {
      timestamp: 1234567890,
      sessionId: "jpeg-session",
      type: "op",
      op: "editor.screenshot",
      output: {
        image_base64: fakeImageData,
        format: "jpeg",
        width: 200,
        height: 150,
      },
      durationMs: 30,
    };

    await recorder.record(entry);

    const filePath = path.join(tmpDir, "trace-jpeg-session.jsonl");
    const content = fs.readFileSync(filePath, "utf-8").trim();
    const parsed = JSON.parse(content);

    assert.match(parsed.output.artifactRef, /\.jpg$/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("TraceRecorder: lazy directory creation", async () => {
  const tmpDir = makeTempDir();
  const traceDir = path.join(tmpDir, "nested", "trace");
  try {
    const recorder = new TraceRecorder(traceDir);
    recorder.setSessionId("lazy-session");

    // Directory should NOT exist yet
    assert.ok(!fs.existsSync(traceDir), "Trace dir should not exist before first record");

    await recorder.record({
      timestamp: Date.now(),
      sessionId: "lazy-session",
      type: "connect",
    });

    // Now directory should exist
    assert.ok(fs.existsSync(traceDir), "Trace dir should exist after first record");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("TraceRecorder: record without sessionId uses 'unknown'", async () => {
  const tmpDir = makeTempDir();
  try {
    const recorder = new TraceRecorder(tmpDir);
    // Do NOT call setSessionId

    await recorder.record({
      timestamp: Date.now(),
      sessionId: "unknown",
      type: "connect",
    });

    const filePath = path.join(tmpDir, "trace-unknown.jsonl");
    assert.ok(fs.existsSync(filePath), "Should write to trace-unknown.jsonl");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("TraceRecorder: artifact ingestion copies file and records relative path", async () => {
  const tmpDir = makeTempDir();
  try {
    // Create a source file to ingest
    const sourceFile = path.join(tmpDir, "source-screenshot.png");
    fs.writeFileSync(sourceFile, "fake-png-bytes");

    const recorder = new TraceRecorder(tmpDir);
    recorder.setSessionId("ingest-session");

    const entry: TraceEntry = {
      timestamp: Date.now(),
      sessionId: "ingest-session",
      type: "op",
      op: "editor.screenshot",
      durationMs: 50,
    };

    const artifacts = await recorder.ingestArtifacts([
      {
        kind: "screenshot" as const,
        sourcePath: sourceFile,
        format: "png",
      },
    ]);

    entry.artifacts = artifacts;
    await recorder.record(entry);

    // Check that artifact was copied
    assert.equal(artifacts.length, 1);
    assert.match(artifacts[0]!, /^artifacts\//);

    const copiedPath = path.join(tmpDir, artifacts[0]!);
    assert.ok(fs.existsSync(copiedPath), "Copied artifact should exist");

    const copiedContent = fs.readFileSync(copiedPath, "utf-8");
    assert.equal(copiedContent, "fake-png-bytes");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("TraceRecorder: artifact ingestion handles missing source gracefully", async () => {
  const tmpDir = makeTempDir();
  try {
    const recorder = new TraceRecorder(tmpDir);
    recorder.setSessionId("missing-session");

    const artifacts = await recorder.ingestArtifacts([
      {
        kind: "file" as const,
        sourcePath: "/nonexistent/path/file.txt",
      },
    ]);

    // Should return empty array — missing files are skipped
    assert.equal(artifacts.length, 0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("TraceRecorder: input traces include backend and session diagnostics", async () => {
  const tmpDir = makeTempDir();
  try {
    const recorder = new TraceRecorder(tmpDir);
    recorder.setSessionId("input-session");

    await recorder.record({
      timestamp: 1700000000000,
      sessionId: "input-session",
      type: "op",
      op: "input.key_tap",
      input: { key: "Space" },
      output: {
        backend: "InputSystem",
        sessionId: "input-session-id",
        key: "Space",
        tapped: true,
      },
      durationMs: 12,
    });

    const filePath = path.join(tmpDir, "trace-input-session.jsonl");
    const content = fs.readFileSync(filePath, "utf-8").trim();
    const parsed = JSON.parse(content);

    assert.equal(parsed.inputDiagnostics.action, "key_tap");
    assert.equal(parsed.inputDiagnostics.backend, "InputSystem");
    assert.equal(parsed.inputDiagnostics.sessionId, "input-session-id");
    assert.equal(parsed.inputDiagnostics.key, "Space");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("TraceRecorder: input error traces preserve structured protocol codes", async () => {
  const tmpDir = makeTempDir();
  try {
    const recorder = new TraceRecorder(tmpDir);
    recorder.setSessionId("input-error-session");

    await recorder.record({
      timestamp: 1700000000100,
      sessionId: "input-error-session",
      type: "op",
      op: "input.key_down",
      input: { key: "BadKey" },
      error: {
        code: "INVALID_KEY",
        message: "Invalid key 'BadKey'",
      },
      durationMs: 3,
    });

    const filePath = path.join(tmpDir, "trace-input-error-session.jsonl");
    const content = fs.readFileSync(filePath, "utf-8").trim();
    const parsed = JSON.parse(content);

    assert.equal(parsed.error.code, "INVALID_KEY");
    assert.equal(parsed.inputDiagnostics.errorCode, "INVALID_KEY");
    assert.equal(parsed.inputDiagnostics.action, "key_down");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
