import type { SpawnSyncOptions } from "node:child_process";

/**
 * Whether this process's stdout is a structured channel rather than a terminal.
 *
 * `node --test` runs each test file in a child whose **fd 1 is a V8-serialized result
 * channel** (`NODE_TEST_CONTEXT=child-v8`). Console output from the test itself is safe —
 * Node wraps it — but `stdio: "inherit"` hands that same fd to a grandchild, whose raw
 * bytes go into the channel unwrapped. When they land mid-message the runner dies with
 * `Unable to deserialize cloned data due to invalid or unsupported version`, which the
 * reporter surfaces as a whole FILE failing with no assertion and a few tests missing from
 * the count. That is an intermittent, load-dependent red with no useful diagnostic.
 */
export function stdoutIsStructuredChannel(env: NodeJS.ProcessEnv = process.env): boolean {
  return typeof env.NODE_TEST_CONTEXT === "string" && env.NODE_TEST_CONTEXT.length > 0;
}

/**
 * `spawnSync` stdio options for running a child CLI step.
 *
 * Interactive runs keep `"inherit"` so a long step streams live — that is the whole point
 * of the CLI. Under the test runner we capture instead and the caller re-emits through the
 * parent's own (wrapped) streams, so the output still appears without ever touching fd 1
 * directly.
 */
export function childStepStdio(env: NodeJS.ProcessEnv = process.env): SpawnSyncOptions {
  return stdoutIsStructuredChannel(env)
    ? { encoding: "utf8" } // default stdio is "pipe"
    : { stdio: "inherit" };
}

/** Re-emit captured child output through this process's wrapped streams. */
export function forwardCapturedOutput(
  result: { stdout?: string | Buffer | null; stderr?: string | Buffer | null },
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!stdoutIsStructuredChannel(env)) return; // inherit already wrote it
  if (result.stdout) process.stdout.write(result.stdout.toString());
  if (result.stderr) process.stderr.write(result.stderr.toString());
}
