import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { PKG_ROOT, REPO_ROOT } from "../../_support/paths.js";

/**
 * The release ASSET NAME is a three-way contract, and nothing walked it.
 *
 * `scripts/loombridge-release.sh` uploads a tarball; `scripts/install.sh` fetches it back by
 * `ASSET_GLOB`; and `npm pack` decides what the file is actually called. Those three drifted apart
 * at the 2026-07-21 mechanical product rename: it rewrote a hard-coded `loomtide-cli-$ver.tgz` to
 * `loombridge-cli-$ver.tgz` while the package name became `@loomtide/loombridge`, which packs to
 * `loomtide-loombridge-<ver>.tgz`. From then on the release script looked for a file npm never
 * produced and exited 1.
 *
 * It went unnoticed for four days and across a shipped release because releases are rare and v0.3.2's
 * asset was evidently produced by hand. A path declared in a shell script that no test walks is
 * invisible to a green suite, which is this repo's most expensive recurring failure shape.
 *
 * These assertions are about the two ENDS of the contract agreeing. The rename step in the middle is
 * exercised for real by `scripts/loombridge-release.sh --dry-run`.
 */

const RELEASE_SH = path.join(REPO_ROOT, "scripts", "loombridge-release.sh");
const INSTALL_SH = path.join(REPO_ROOT, "scripts", "install.sh");

function read(file: string): string {
  return readFileSync(file, "utf-8");
}

/** npm's own tarball naming: strip the leading `@`, flatten the scope separator to `-`. */
function npmPackFilename(name: string, version: string): string {
  return `${name.replace(/^@/, "").replace(/\//, "-")}-${version}.tgz`;
}

test("the release asset name the publisher writes is the one the installer fetches", () => {
  const releaseSh = read(RELEASE_SH);
  const installSh = read(INSTALL_SH);

  // What install.sh looks for, e.g. ASSET_GLOB='loombridge-cli-*.tgz'
  const globMatch = installSh.match(/ASSET_GLOB=(['"])(.+?)\1/);
  assert.ok(globMatch, "install.sh must declare an ASSET_GLOB");
  const glob = globMatch![2]!;
  const prefix = glob.replace(/\*.*$/, "");
  assert.ok(prefix.length > 0, `ASSET_GLOB ${glob} must have a literal prefix to match on`);

  // What the release script names the asset it uploads.
  assert.ok(
    releaseSh.includes(`${prefix}$ver.tgz`),
    `loombridge-release.sh must name the uploaded asset "${prefix}<version>.tgz" to match install.sh's ASSET_GLOB (${glob})`,
  );
});

test("the release script does NOT assume npm packs to the asset name", () => {
  // The actual defect: `npm pack` names the file from the PACKAGE NAME, which for a scoped package
  // never matches the asset name. A release script that treats them as the same file cannot run.
  const pkg = JSON.parse(read(path.join(PKG_ROOT, "package.json"))) as { name: string; version: string };
  const packed = npmPackFilename(pkg.name, pkg.version);
  const installSh = read(INSTALL_SH);
  const glob = installSh.match(/ASSET_GLOB=(['"])(.+?)\1/)![2]!;
  const prefix = glob.replace(/\*.*$/, "");

  // LITMUS for this whole file: if the package were ever renamed such that npm's output happened to
  // match the asset prefix, the bug class would be impossible and this test would be vacuous. Assert
  // they genuinely differ, so the rename step below is load-bearing rather than decorative.
  assert.ok(
    !packed.startsWith(prefix),
    `npm packs to "${packed}" and the asset prefix is "${prefix}" — these differing is what makes the ` +
      "rename step necessary; if they ever match, simplify the release script instead of keeping a no-op",
  );

  // So the script must derive the packed name rather than hard-coding it, and rename.
  const releaseSh = read(RELEASE_SH);
  assert.match(
    releaseSh,
    /require\(.*package\.json.*\)/,
    "loombridge-release.sh must DERIVE npm's packed filename from package.json, not hard-code it",
  );
  assert.match(releaseSh, /\bmv\b[^\n]*"\$tgz"/, "loombridge-release.sh must rename the packed tarball to the asset name");
});

test("nothing advertises get.loomtide.ai as the Loombridge installer", async () => {
  // That endpoint serves a DIFFERENT product's installer (@loomtide/cli). Running it installs
  // `loomtide`, not `loombridge` — confirmed empirically. `README.md` and `Docs/Install.md` have
  // always said so, but two code paths contradicted them: `loombridge update` printed it as THE
  // self-update command, and the release script baked it into its default notes, so every release
  // page repeated it.
  //
  // This asserts the CODE agrees with the docs. It deliberately allows prose that MENTIONS the
  // endpoint (the docs must be able to warn about it, and the code must be able to explain the
  // override); what it forbids is presenting it as a runnable install command.
  const offenders: string[] = [];
  const files = [
    path.join(PKG_ROOT, "src", "capabilities", "setup", "update.ts"),
    path.join(REPO_ROOT, "scripts", "loombridge-release.sh"),
    path.join(REPO_ROOT, "scripts", "install.sh"),
  ];
  // A runnable one-liner: a curl/irm of the endpoint piped into a shell.
  const runnable = /(curl|irm|wget)[^\n]*get\.loomtide\.ai[^\n]*(\|\s*(sh|bash|iex)|\bsh\b)/i;
  for (const file of files) {
    for (const [i, line] of read(file).split("\n").entries()) {
      // Skip the override branch: naming the env var that RESTORES the one-liner is not advertising it.
      if (/LOOMBRIDGE_INSTALL_URL/.test(line)) continue;
      if (runnable.test(line)) offenders.push(`${path.relative(REPO_ROOT, file)}:${i + 1}: ${line.trim()}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "these present get.loomtide.ai as a runnable Loombridge install command, but it installs a different product:\n  " +
      offenders.join("\n  "),
  );
});

test("both shipped package.json versions move together", () => {
  // The CLI package and the Unity UPM package are released as one unit: the release uploads the CLI
  // tarball AND the bridge tarball, and `install-bridge` wires `com.loomtide.loombridge-<ver>.tgz`
  // into a consumer project by that exact version. A half-bump ships a CLI that installs a bridge
  // version it was never tested against.
  const cli = JSON.parse(read(path.join(PKG_ROOT, "package.json"))) as { version: string };
  const unity = JSON.parse(
    read(path.join(REPO_ROOT, "packages", "com.loomtide.loombridge", "package.json")),
  ) as { version: string };
  assert.equal(
    unity.version,
    cli.version,
    "mcp-server/package.json and packages/com.loomtide.loombridge/package.json must carry the same version",
  );
});
