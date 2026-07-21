// Stamp the current build into mcp-server/dist/build-info.json so `loombridge --version`
// reports WHICH build is running — the signal that catches a stale frozen runtime
// (the `loombridge` bin execs ~/.loombridge/runtime, frozen at install time; a repo
// rebuild does not update it). Run as the `postbuild` step (cwd = mcp-server).
//
// `commit` = git HEAD at build time (short sha, "+dirty" if the tree is modified),
// or "unknown" outside a git checkout (e.g. an npm-packed tarball). `builtAt` = ISO
// build time. Best-effort: a failure here must never fail the build.

import { execSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

function sh(cmd) {
  try {
    return execSync(cmd, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return "";
  }
}

const commit = sh("git rev-parse --short HEAD") || "unknown";
const dirty = commit !== "unknown" && sh("git status --porcelain") !== "" ? "+dirty" : "";
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
