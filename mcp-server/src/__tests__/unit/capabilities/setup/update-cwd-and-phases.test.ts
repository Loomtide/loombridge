/**
 * `loombridge update`'s argv defaulting and phase ordering.
 *
 * Two behaviours are load-bearing beyond ergonomics:
 *
 *  - **A value-less `--project` is a usage error, never a fallback to cwd.** The operator
 *    named a target; silently updating a DIFFERENT project is the quiet-wrong-target class.
 *  - **A self-update that ran ENDS the run.** The bridge tarball is bundled inside the CLI,
 *    so once the binary on disk is replaced, the bundle this process resolved is the old
 *    one. Continuing would deliver the previous bridge and print success, which is exactly
 *    the "stale bundle looks healthy" failure the freshness gate exists to close.
 */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, describe } from "node:test";

import { parseArgs, run, runCliSelfUpdatePhase } from "../../../../capabilities/setup/update.js";

const temps: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "lb-update-"));
  temps.push(dir);
  return dir;
}

/** A directory that `looksLikeUnityProject` accepts. */
function unityProjectDir(): string {
  const dir = tempDir();
  mkdirSync(path.join(dir, "ProjectSettings"), { recursive: true });
  writeFileSync(path.join(dir, "ProjectSettings", "ProjectVersion.txt"), "m_EditorVersion: 6000.0.0f1\n");
  mkdirSync(path.join(dir, "Assets"), { recursive: true });
  return dir;
}

after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

/** Silence console output for the duration of `fn` (sync or async). */
function quietly<T>(fn: () => T): T {
  const log = console.log;
  const warn = console.warn;
  const error = console.error;
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
  try {
    return fn();
  } finally {
    console.log = log;
    console.warn = warn;
    console.error = error;
  }
}

/**
 * The async form. `quietly` restores the console in a synchronous `finally`, which for an
 * async callee fires while the work is still running, so its output would escape.
 */
async function quietlyAsync<T>(fn: () => Promise<T>): Promise<T> {
  const log = console.log;
  const warn = console.warn;
  const error = console.error;
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
    console.warn = warn;
    console.error = error;
  }
}

describe("update argv: project defaulting", () => {
  test("cwd is used when it IS a Unity project", () => {
    const project = unityProjectDir();
    const parsed = parseArgs([], project);
    assert.ok(!("help" in parsed));
    assert.equal((parsed as { project: string }).project, path.resolve(project));
  });

  test("cwd outside a Unity project yields NO project, not an error", () => {
    const parsed = parseArgs([], tempDir());
    assert.ok(!("help" in parsed), "a CLI-only run is valid; it must not be a usage error");
    assert.equal((parsed as { project: string }).project, "", "no project means the CLI-only path");
  });

  test("an explicit --project overrides cwd", () => {
    const cwdProject = unityProjectDir();
    const explicit = unityProjectDir();
    const parsed = parseArgs(["--project", explicit], cwdProject);
    assert.equal((parsed as { project: string }).project, path.resolve(explicit));
  });

  test("REFUSAL: a value-less --project is a usage error, never a silent cwd fallback", () => {
    const project = unityProjectDir();
    const parsed = quietly(() => parseArgs(["--project"], project));
    assert.ok("help" in parsed, "the flag must not be accepted with no value");
    assert.equal((parsed as { usageError?: boolean }).usageError, true);
  });

  test("REFUSAL: --project must not SWALLOW the flag that follows it", () => {
    // `loombridge update --project --check` is a plausible typo. Consuming `--check` as the
    // project path gives the operator a wrong target AND silently drops the no-write flag,
    // so the run installs for real. Every value-taking flag gets the same treatment.
    const parsed = quietly(() => parseArgs(["--project", "--check"], unityProjectDir()));
    assert.ok("help" in parsed, "a flag may never be read as another flag's value");
    assert.equal((parsed as { usageError?: boolean }).usageError, true);
  });

  test("REFUSAL: --tarball and --version reject a following flag too", () => {
    // `--version --check` was the worst of these: the pin branch runs BEFORE any comparison,
    // so it built and executed `npm install -g loombridge@--check` on a run the operator
    // asked to be report-only.
    for (const flag of ["--tarball", "--version"]) {
      const parsed = quietly(() => parseArgs([flag, "--check"], tempDir()));
      assert.ok("help" in parsed, `${flag} must not swallow --check`);
      assert.equal((parsed as { usageError?: boolean }).usageError, true, `${flag} must be a usage error`);
    }
  });

  test("REFUSAL: a --version value that would split into extra install targets", () => {
    // The pin is interpolated into a command string that is later split on spaces, so an
    // unvalidated value with whitespace installs additional global packages.
    const parsed = quietly(() => parseArgs(["--version", "1.0.0 evil-pkg"], tempDir()));
    assert.ok("help" in parsed, "a pin with whitespace must be refused at the door");
    assert.equal((parsed as { usageError?: boolean }).usageError, true);
  });

  test("an explicit --project is NOT silently replaced by cwd when it is not a Unity project", () => {
    const notAProject = tempDir();
    const parsed = parseArgs(["--project", notAProject], unityProjectDir());
    // Parsing keeps it; `run` is what refuses. The point is that cwd never wins here.
    assert.equal((parsed as { project: string }).project, path.resolve(notAProject));
  });

  test("--check and --no-self-update parse as flags", () => {
    const parsed = parseArgs(["--check", "--no-self-update"], tempDir()) as {
      checkOnly: boolean;
      skipSelf: boolean;
    };
    assert.equal(parsed.checkOnly, true);
    assert.equal(parsed.skipSelf, true);
  });
});

describe("update argv reaches the actuator (the wiring, not just the parse)", () => {
  /** Record what the CLI phase was asked to do, and never actually install. */
  function spyPhase() {
    const calls: Array<{ checkOnly: boolean; pinnedVersion?: string | undefined }> = [];
    const phase = (params: { checkOnly: boolean; pinnedVersion?: string | undefined }) => {
      calls.push({ checkOnly: params.checkOnly, pinnedVersion: params.pinnedVersion });
      return { kind: "continue" as const };
    };
    return { calls, phase };
  }

  test("REGRESSION: --dry-run reaches the installer as a no-write run", async () => {
    // The defect this closes: `run` forwarded only `--check`, so `--dry-run`, documented as
    // "print the plan without writing any files", performed a real global `npm install -g`.
    // Every unit test passed because they all called the phase directly, never through argv.
    const { calls, phase } = spyPhase();
    await quietlyAsync(() => run(["--dry-run"], { cwd: tempDir(), selfUpdatePhase: phase }));
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.checkOnly, true, "--dry-run must never actuate an install");
  });

  test("--check reaches the installer as a no-write run", async () => {
    const { calls, phase } = spyPhase();
    await quietlyAsync(() => run(["--check"], { cwd: tempDir(), selfUpdatePhase: phase }));
    assert.equal(calls[0]!.checkOnly, true);
  });

  test("a bare run is a WRITE run (the flags above are what make it write-free)", async () => {
    // Without this, the two assertions above would pass on a phase hard-coded to no-write.
    const { calls, phase } = spyPhase();
    await quietlyAsync(() => run([], { cwd: tempDir(), selfUpdatePhase: phase }));
    assert.equal(calls[0]!.checkOnly, false);
  });

  test("--no-self-update never reaches the CLI phase at all", async () => {
    const { calls, phase } = spyPhase();
    await quietlyAsync(() => run(["--no-self-update"], { cwd: tempDir(), selfUpdatePhase: phase }));
    assert.equal(calls.length, 0);
  });

  test("--version forwards the pin", async () => {
    const { calls, phase } = spyPhase();
    await quietlyAsync(() => run(["--version", "0.1.5"], { cwd: tempDir(), selfUpdatePhase: phase }));
    assert.equal(calls[0]!.pinnedVersion, "0.1.5");
  });

  test("REGRESSION: an invalid --project exits 2 BEFORE anything is actuated", async () => {
    // Phase 1 can end the run by self-updating and returning 0, so validating the project
    // afterwards let `update --project /typo` exit 0 while never touching the named project.
    const { calls, phase } = spyPhase();
    const code = await quietly(() =>
      run(["--project", path.join(tempDir(), "nope")], { cwd: tempDir(), selfUpdatePhase: phase }),
    );
    assert.equal(code, 2, "a bad project is a precondition failure");
    assert.equal(calls.length, 0, "nothing may be actuated before the arguments are known good");
  });

  test("a CLI-only run in a non-Unity directory exits 0", async () => {
    const { phase } = spyPhase();
    const code = await quietlyAsync(() => run([], { cwd: tempDir(), selfUpdatePhase: phase }));
    assert.equal(code, 0, "updating the CLI is a complete action, not a usage error");
  });
});

describe("update phase ordering: a self-update ends the run", () => {
  const npmInstall = {
    installMethod: {
      method: "npm-package" as const,
      resolvedRoot: "/usr/local/lib/node_modules/loombridge",
      reason: "test",
    },
    currentVersion: "0.2.0",
  };

  test("a successful self-update STOPS, so the stale bundled bridge is never delivered", () => {
    let ran = "";
    const outcome = quietly(() =>
      runCliSelfUpdatePhase({
        ...npmInstall,
        checkOnly: false,
        lookup: () => "0.3.0",
        runInstall: (command) => {
          ran = command;
          return true;
        },
      }),
    );
    assert.equal(ran, "npm install -g loombridge@latest");
    assert.deepEqual(outcome, { kind: "stop-updated", exitCode: 0 });
  });

  test("a FAILED self-update stops at exit 1, never falling through to the bridge", () => {
    const outcome = quietly(() =>
      runCliSelfUpdatePhase({
        ...npmInstall,
        checkOnly: false,
        lookup: () => "0.3.0",
        runInstall: () => false,
      }),
    );
    assert.deepEqual(outcome, { kind: "stop-updated", exitCode: 1 });
  });

  test("--check plans the install but runs nothing, and continues to the bridge phase", () => {
    let called = false;
    const outcome = quietly(() =>
      runCliSelfUpdatePhase({
        ...npmInstall,
        checkOnly: true,
        lookup: () => "0.3.0",
        runInstall: () => {
          called = true;
          return true;
        },
      }),
    );
    assert.equal(called, false, "--check must not install anything");
    assert.deepEqual(outcome, { kind: "continue" });
  });

  test("an up-to-date CLI continues to the bridge phase", () => {
    const outcome = quietly(() =>
      runCliSelfUpdatePhase({ ...npmInstall, checkOnly: false, lookup: () => "0.2.0" }),
    );
    assert.deepEqual(outcome, { kind: "continue" });
  });

  test("an unreachable registry continues but never installs", () => {
    let called = false;
    const outcome = quietly(() =>
      runCliSelfUpdatePhase({
        ...npmInstall,
        checkOnly: false,
        lookup: () => null,
        runInstall: () => {
          called = true;
          return true;
        },
      }),
    );
    assert.equal(called, false, "nothing may be installed on the strength of a failed lookup");
    assert.deepEqual(outcome, { kind: "continue" });
  });

  test("a dev clone with a newer release available instructs and installs NOTHING", () => {
    let called = false;
    const outcome = quietly(() =>
      runCliSelfUpdatePhase({
        installMethod: {
          method: "dev-clone",
          resolvedRoot: "/home/dev/loombridge/mcp-server",
          reason: "test",
        },
        currentVersion: "0.2.0",
        checkOnly: false,
        lookup: () => "0.3.0",
        runInstall: () => {
          called = true;
          return true;
        },
      }),
    );
    assert.equal(called, false, "a developer's checkout is never overwritten by an install");
    assert.deepEqual(outcome, { kind: "continue" });
  });
});
