import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
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

/**
 * NO EXCLUSIONS. The first cut carried `SERVER_BINS = ["loombridge-mcp"]` on the premise that a
 * stdio server would block on `--help`. It does not, with THIS harness: stdin is `ignore`, so the
 * server sees EOF and shuts down (measured: 174 ms, exit 0, 187 bytes).
 *
 * The exclusion was not merely unnecessary, it hid the most valuable bin. Reverting
 * `surfaces/index.js` to the old suffix check leaves `loombridge-mcp` completely inert with the
 * WHOLE suite green, and that is the bin `install-mcp.ts` writes into every consumer `.mcp.json`
 * (`command: "loombridge-mcp"`). So the real count was seven of nine dead, not six of eight.
 *
 * A name-based exclusion list is the wrong shape here: it is exactly how a broken bin hides. If a
 * bin ever genuinely cannot answer `--help`, give it a per-bin invocation recipe below rather than
 * removing it from the walk.
 */

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
  const bins = Object.entries(declaredBins());
  assert.ok(bins.length >= 5, `expected several bins to check, saw ${bins.length}`);

  const broken: string[] = [];
  let walked = 0;
  for (const [name, target] of bins) {
    if (!fs.existsSync(path.join(REPO_ROOT, "mcp-server", target))) continue; // package-entrypoints owns that
    walked += 1;
    const { status, bytes } = invokeThroughBinSymlink(name, target);
    // BOTH conditions. The first cut checked only `bytes`, which proves a bin SPEAKS, not that it
    // WORKS: a command that crashes loudly on every invocation passed, and `analyze-frames` was
    // already exiting 1 on `--help` while counted healthy.
    if (bytes === 0) broken.push(`${name} -> ${target} (silent: 0 bytes)`);
    else if (status !== 0) broken.push(`${name} -> ${target} (exit ${status} on --help)`);
  }
  // Count what was WALKED, not what was declared: an unbuilt dist would otherwise pass vacuously.
  assert.ok(walked >= 5, `expected to walk several built bins, walked ${walked}`);

  assert.deepEqual(
    broken,
    [],
    "run by their bin name, which is how a user and an agent invoke them, these commands either " +
      "say nothing or fail. Silence is usually a main-module check keyed on the FILENAME instead " +
      `of shared/main-module.ts; a non-zero exit means --help is unsupported:\n  ${broken.join("\n  ")}`,
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
  //
  // The path must EXIST. The first cut used a made-up path, so `realpathSync` threw and the
  // assertion passed from the CATCH rather than from path inequality: gutting the comparison to
  // `return true` left both tests in this file green.
  const realButNotEntrypoint = path.join(REPO_ROOT, "mcp-server", "dist", "shared", "main-module.js");
  assert.equal(fs.existsSync(realButNotEntrypoint), true, "the fixture path must exist to exercise the comparison");
  assert.equal(isMainModule(pathToFileURL(realButNotEntrypoint).href), false);
});

test("every declared bin target carries a shebang, so PATH execution works", () => {
  // The test above spawns `node <link>`, which is how NODE invokes a bin, not how a SHELL does.
  // A target without `#!/usr/bin/env node` passes that test and dies on PATH with a shell syntax
  // error, because the shell executes the symlink directly. Demonstrated: a shebang-less script
  // returns 22 bytes through `node <link>` and "syntax error near unexpected token" through PATH.
  //
  // Every current target does carry one, and nothing asserted it. Same "declared path nothing
  // walks" shape, one level below the previous one.
  const missing: string[] = [];
  for (const [name, target] of Object.entries(declaredBins())) {
    const abs = path.join(REPO_ROOT, "mcp-server", target);
    if (!fs.existsSync(abs)) continue;
    const firstLine = fs.readFileSync(abs, "utf-8").split("\n", 1)[0] ?? "";
    if (!firstLine.startsWith("#!")) missing.push(`${name} -> ${target} (first line: ${JSON.stringify(firstLine.slice(0, 40))})`);
  }
  assert.deepEqual(
    missing,
    [],
    "a bin target without a shebang is executable by `node <path>` but NOT by a shell on PATH, " +
      `which is how a user and an agent run it:\n  ${missing.join("\n  ")}`,
  );
});
