import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import {
  childStepStdio,
  forwardCapturedOutput,
  stdoutIsStructuredChannel,
} from "../../../shared/child-stdio.js";

test("child-stdio: a test-runner child is detected as a structured channel", () => {
  assert.equal(stdoutIsStructuredChannel({ NODE_TEST_CONTEXT: "child-v8" }), true);
  assert.equal(stdoutIsStructuredChannel({}), false);
  assert.equal(stdoutIsStructuredChannel({ NODE_TEST_CONTEXT: "" }), false);
});

test("child-stdio: interactive runs keep inherit so long steps stream live", () => {
  assert.deepEqual(childStepStdio({}), { stdio: "inherit" });
});

test("child-stdio: under the test runner the child is piped, never handed fd 1", () => {
  const opts = childStepStdio({ NODE_TEST_CONTEXT: "child-v8" });
  assert.equal((opts as { stdio?: unknown }).stdio, undefined, "must not inherit");
  assert.equal((opts as { encoding?: string }).encoding, "utf8");
});

test("child-stdio: THIS process is a runner child, so the real call is piped", () => {
  // Self-check: these tests only mean something if the suite really does run in the
  // context the fix targets. If Node ever stops setting NODE_TEST_CONTEXT this fails
  // loudly rather than silently protecting nothing.
  assert.equal(stdoutIsStructuredChannel(), true);
  assert.equal((childStepStdio() as { stdio?: unknown }).stdio, undefined);
});

test("child-stdio: captured output is still forwarded, so nothing is swallowed", () => {
  const res = spawnSync(process.execPath, ["-e", "process.stdout.write('forwarded-marker')"], childStepStdio());
  assert.equal(res.stdout?.toString(), "forwarded-marker", "child output must be captured, not lost");

  const written: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  (process.stdout as unknown as { write: (c: string) => boolean }).write = (chunk: string) => {
    written.push(String(chunk));
    return true;
  };
  try {
    forwardCapturedOutput(res);
  } finally {
    (process.stdout as unknown as { write: typeof original }).write = original;
  }
  assert.ok(written.join("").includes("forwarded-marker"), "captured output must be re-emitted");
});

test("child-stdio: forwarding is a no-op interactively (inherit already wrote it)", () => {
  const written: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  (process.stdout as unknown as { write: (c: string) => boolean }).write = (chunk: string) => {
    written.push(String(chunk));
    return true;
  };
  try {
    forwardCapturedOutput({ stdout: "should-not-double-print" }, {});
  } finally {
    (process.stdout as unknown as { write: typeof original }).write = original;
  }
  assert.deepEqual(written, [], "inherit already emitted it; re-emitting would duplicate");
});
