// Stamp the current build into mcp-server/dist/build-info.json so `loombridge --version`
// reports WHICH build is running — the signal that catches a stale frozen runtime
// (the `loombridge` bin execs ~/.loombridge/runtime, frozen at install time; a repo
// rebuild does not update it). Run as the `postbuild` step (cwd = mcp-server).
//
// `commit` = git HEAD at build time (short sha, "+dirty" if the tree is modified),
// or "unknown" outside a git checkout (e.g. an npm-packed tarball). `builtAt` = ISO
// build time. Best-effort: a failure here must never fail the build.

import { execSync } from "node:child_process";
import { chmodSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

function sh(cmd) {
  try {
    return execSync(cmd, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return "";
  }
}

const commit = sh("git rev-parse --short HEAD") || "unknown";

// Only TRACKED modifications make a build "dirty". Untracked files are build output and
// scratch — they say nothing about whether the source differs from the commit, and letting
// them count made the stamp meaningless: a release build stamped "+dirty" purely because
// the packaging steps had produced their own artifacts, so a genuinely modified tree was
// indistinguishable from a clean release. Print WHAT is dirty, so a surprising stamp in a
// CI log explains itself instead of needing to be reverse-engineered.
const modified = commit !== "unknown" ? sh("git status --porcelain --untracked-files=no") : "";
const dirty = modified !== "" ? "+dirty" : "";
if (dirty) {
  const paths = modified.split("\n").slice(0, 10).join("\n  ");
  console.error(`[write-build-info] tree has uncommitted TRACKED changes:\n  ${paths}`);
}
const info = {
  commit: `${commit}${dirty}`,
  builtAt: new Date().toISOString(),
};

const distDir = path.resolve(process.cwd(), "dist");
try {
  mkdirSync(distDir, { recursive: true });
  writeFileSync(path.join(distDir, "build-info.json"), JSON.stringify(info, null, 2) + "\n");
  console.error(`[write-build-info] dist/build-info.json -> ${info.commit}, built ${info.builtAt}`);
} catch (e) {
  console.error(`[write-build-info] skipped (${e instanceof Error ? e.message : String(e)})`);
}

// npm sets the executable bit on bin targets at LINK/INSTALL time only; `rm -rf dist && tsc`
// recreates the files without it, so an `npm link`ed `loombridge` dies with "permission
// denied" after every rebuild. Restore the bit on every declared bin target each build.
// Best-effort like the stamp: a chmod failure must never fail the build.
try {
  const pkg = JSON.parse(readFileSync(path.resolve(process.cwd(), "package.json"), "utf-8"));
  for (const rel of Object.values(pkg.bin ?? {})) {
    try {
      chmodSync(path.resolve(process.cwd(), rel), 0o755);
    } catch {
      // target may not exist in a partial build; the entrypoint guard owns that failure mode
    }
  }
} catch (e) {
  console.error(`[write-build-info] bin chmod skipped (${e instanceof Error ? e.message : String(e)})`);
}
