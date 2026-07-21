import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import os from "node:os";
import { fileURLToPath } from "node:url";
import test from "node:test";

// dist/__tests__/integration/lifecycle.test.js -> dist/index.js
const SERVER_ENTRY = fileURLToPath(new URL("../../index.js", import.meta.url));

function waitForStderr(child: ChildProcessWithoutNullStreams, marker: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => {
      child.stderr.off("data", onData);
      reject(new Error(`timed out waiting for "${marker}" in stderr; saw:\n${buf}`));
    }, timeoutMs);
    const onData = (chunk: Buffer) => {
      buf += chunk.toString();
      if (buf.includes(marker)) {
        clearTimeout(timer);
        child.stderr.off("data", onData);
        resolve();
      }
    };
    child.stderr.on("data", onData);
  });
}

function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("server did not exit after stdin closed (orphan risk)"));
    }, timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

test("server exits when its controlling client closes stdin (EOF) — no orphan", async () => {
  const env = { ...process.env };
  // Keep startup deterministic: don't let an inherited binding change routing logs.
  delete env.LOOMTIDE_UNITY_PROJECT;

  const child = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: os.tmpdir(),
    env,
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;

  try {
    // No Unity needed — connections are lazy, so the server boots standalone.
    await waitForStderr(child, "MCP server started", 15_000);

    // The common, signal-less death of an MCP client: it closes our stdin.
    child.stdin.end();

    const code = await waitForExit(child, 8_000);
    assert.equal(code, 0, "clean exit(0) on stdin EOF");
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }
});

test("server exits on SIGTERM", async () => {
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: os.tmpdir(),
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;

  try {
    await waitForStderr(child, "MCP server started", 15_000);
    child.kill("SIGTERM");
    const code = await waitForExit(child, 8_000);
    assert.equal(code, 0, "clean exit(0) on SIGTERM");
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }
});
