import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { REPO_ROOT } from "../../_support/paths.js";
import { isMainModule } from "../../../shared/main-module.js";

/**
 * Guard: a declared bin must DO something when invoked by its bin name.
 *
 * WHY THIS EXISTS. `package-entrypoints.test.ts` checks that every `bin` target file exists. It
 * did, and six of eight declared commands were still silent no-ops, because npm installs a bin as
 * a SYMLINK named after the bin, and every entrypoint decided "am I the entrypoint?" with
 *
 *     process.argv[1]?.endsWith("capture-runner.js")
 *
 * Through the symlink, `argv[1]` is `/opt/homebrew/bin/loombridge-capture-runner`, which does not
 * end with `capture-runner.js`, so the main block never ran. Exit 0, no output, no work. Measured
 * on a real install:
 *
 *     loombridge                   6014 bytes   OK
 *     loombridge-run-gates            0 bytes   INERT
 *     loombridge-capture-runner       0 bytes   INERT
 *     loombridge-analyze-frames       0 bytes   INERT
 *
 * `loombridge-capture-runner` had been a declared bin the whole time and had never done anything
 * when run by name. This is the repo's "declared path nothing walks" shape one level deeper: the
 * path existed, the file existed, the suite was green, the command was dead.
 *
 * THE TEST HAS TO USE A SYMLINK. Invoking `node dist/x.js` passes even with the old broken guard,
 * because then `argv[1]` really does end with the filename. Only the symlink reproduces what a
 * user's PATH does.
 */

/** Bins whose entrypoint is a long-running server, so `--help` would block rather than return. */
const SERVER_BINS = new Set(["loombridge-mcp"]);

function declaredBins(): Record<string, string> {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, "mcp-server", "package.json"), "utf-8"),
  ) as { bin?: Record<string, string> };
  return pkg.bin ?? {};
}

/**
 * Run `<binName> --help` through a symlink named exactly like the installed bin, and report what
 * the user would see.
 */
function invokeThroughBinSymlink(binName: string, target: string): { status: number | null; bytes: number } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loombridge-bin-"));
  const link = path.join(dir, binName);
  fs.symlinkSync(path.join(REPO_ROOT, "mcp-server", target), link);
  try {
    const r = spawnSync(process.execPath, [link, "--help"], {
      encoding: "utf-8",
      timeout: 30_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: r.status, bytes: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim().length };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("every declared bin produces OUTPUT when invoked through its bin symlink", () => {
  const bins = Object.entries(declaredBins()).filter(([name]) => !SERVER_BINS.has(name));
  assert.ok(bins.length >= 5, `expected several bins to check, saw ${bins.length}`);

  const inert: string[] = [];
  for (const [name, target] of bins) {
    if (!fs.existsSync(path.join(REPO_ROOT, "mcp-server", target))) continue; // package-entrypoints owns that
    const { bytes } = invokeThroughBinSymlink(name, target);
    if (bytes === 0) inert.push(`${name} -> ${target}`);
  }

  assert.deepEqual(
    inert,
    [],
    "these commands exit silently and do nothing when run by their bin name, which is how a user " +
      "and an agent invoke them. The usual cause is a main-module check keyed on the FILENAME " +
      `instead of shared/main-module.ts:\n  ${inert.join("\n  ")}`,
  );
});

test("LITMUS: isMainModule is true through a symlink, and false for a non-entrypoint", () => {
  // The unit the guard above depends on. A filename-suffix check fails the first case, which is
  // exactly the defect.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loombridge-mainmod-"));
  const real = path.join(dir, "actual-name.mjs");
  fs.writeFileSync(
    real,
    'import { isMainModule } from "MODPATH";\nprocess.stdout.write(isMainModule(import.meta.url) ? "MAIN" : "NOT-MAIN");\n'
      .replace("MODPATH", path.join(REPO_ROOT, "mcp-server", "dist", "shared", "main-module.js")),
    "utf-8",
  );
  const link = path.join(dir, "totally-different-bin-name");
  fs.symlinkSync(real, link);

  try {
    const direct = spawnSync(process.execPath, [real], { encoding: "utf-8" });
    assert.equal(direct.stdout, "MAIN", "direct invocation must be MAIN");

    const viaLink = spawnSync(process.execPath, [link], { encoding: "utf-8" });
    assert.equal(
      viaLink.stdout,
      "MAIN",
      "through a symlink whose NAME differs from the file, it must still be MAIN: this is the case " +
        "the old endsWith() check got wrong and that made six bins inert",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ...and it must not claim to be main when it is merely imported.
  assert.equal(isMainModule("file:///definitely/not/the/entrypoint.js"), false);
});
