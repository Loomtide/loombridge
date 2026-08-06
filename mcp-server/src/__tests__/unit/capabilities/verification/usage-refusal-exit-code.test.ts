/**
 * A REFUSAL must not report success.
 *
 * Every verb here prints its usage text for two very different outcomes: an operator asking for
 * `--help` (success, exit 0) and a malformed or incomplete invocation the verb REFUSES to run
 * (exit 2). They were funnelled through one `{ help: true }` return, so the refusal exited 0.
 *
 * `adopt` is the sharp case the RFC cites as the correct precedent for refusing to guess a genre:
 * the refusal itself is right ("--genre is required"), but reporting it as SUCCESS means an agent
 * or a CI step branching on `$?` reads "I would not do this" as "I did it". That is the same
 * defect class as a silent genre default: a refusal that does not look like one.
 *
 * The discriminator (`{ help: true; usageError?: boolean }` → `parsed.usageError ? 2 : 0`) is the
 * shape `update`, `verify`, `status`, `capture` and friends already carry; these verbs join it.
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { run as runAdoptCli } from "../../../../capabilities/verification/adopt.js";
import { run as runBuildCli } from "../../../../capabilities/verification/build.js";
import { run as runPlanCli } from "../../../../capabilities/verification/plan.js";
import { run as runVerifyCli } from "../../../../capabilities/verification/verify.js";

/**
 * Run a verb's CLI entry point with the usage text swallowed (it goes to stdout and would otherwise
 * bury the test output), returning the exit code and whatever it wrote to stderr.
 */
async function quiet(fn: () => Promise<number>): Promise<{ code: number; err: string }> {
  const lines: string[] = [];
  const origErr = console.error;
  const origLog = console.log;
  console.error = (...parts: unknown[]) => void lines.push(parts.map(String).join(" "));
  console.log = () => {};
  try {
    return { code: await fn(), err: lines.join("\n") };
  } finally {
    console.error = origErr;
    console.log = origLog;
  }
}

/** A directory that is NOT a Unity project, so nothing here can accidentally do real work. */
async function tmpRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "loombridge-usage-exit-"));
}

// ── adopt: the refusal the RFC cites ─────────────────────────────────────────────────────────────

test("adopt: no --genre and no --docs is a REFUSAL, exit 2", async () => {
  const root = await tmpRoot();
  try {
    const { code, err } = await quiet(() => runAdoptCli(["--root", root]));
    assert.equal(code, 2, "`adopt` refusing to guess the genre must not report success");
    assert.match(err, /--genre is required/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("adopt: --help is a real help request, exit 0", async () => {
  // The other side of the discriminator. Turning every usage print into an error would break the
  // one caller that legitimately asked for it.
  const { code } = await quiet(() => runAdoptCli(["--help"]));
  assert.equal(code, 0);
  const short = await quiet(() => runAdoptCli(["-h"]));
  assert.equal(short.code, 0);
});

test("adopt: an unknown argument is a REFUSAL, exit 2", async () => {
  const { code, err } = await quiet(() => runAdoptCli(["--not-a-flag"]));
  assert.equal(code, 2);
  assert.match(err, /unknown argument/);
});

// ── the same shape in the neighbouring verbs ─────────────────────────────────────────────────────

test("plan: an unknown argument and a bad --asset-mode are REFUSALS, exit 2; --help exits 0", async () => {
  const unknown = await quiet(() => runPlanCli(["--not-a-flag"]));
  assert.equal(unknown.code, 2);
  assert.match(unknown.err, /unknown argument/);

  const badMode = await quiet(() => runPlanCli(["--asset-mode", "nope"]));
  assert.equal(badMode.code, 2);
  assert.match(badMode.err, /--asset-mode must be/);

  assert.equal((await quiet(() => runPlanCli(["--help"]))).code, 0);
});

test("build: an unknown option is a REFUSAL, exit 2; --help exits 0", async () => {
  const unknown = await quiet(() => runBuildCli(["--not-a-flag"]));
  assert.equal(unknown.code, 2);
  assert.match(unknown.err, /unknown option/);

  assert.equal((await quiet(() => runBuildCli(["--help"]))).code, 0);
});

test("verify: an invalid --stage is a REFUSAL, exit 2; --help exits 0", async () => {
  const badStage = await quiet(() => runVerifyCli(["--stage", "nope"]));
  assert.equal(badStage.code, 2);
  assert.match(badStage.err, /invalid --stage/);

  assert.equal((await quiet(() => runVerifyCli(["--help"]))).code, 0);
});
