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

import { parseArgs, runCliSelfUpdatePhase } from "../../../../capabilities/setup/update.js";

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

/** Silence the phase's console output for the duration of `fn`. */
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
