import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { resolveBuildStamp, formatBuildStamp } from "../loomtide/build-stamp.js";

// F5 finding #14: the producing-runtime identity must be STAMPABLE into a report,
// with absence impossible — when build info is unavailable the stamp says so
// explicitly ("unknown"/null + a note), never an omitted field.
//
// The resolver reads two files RELATIVE to a module URL:
//   <moduleUrl>/../../package.json   (package root #version)
//   <moduleUrl>/../build-info.json   (commit + builtAt)
// so each scenario is exercised by pointing `moduleUrl` at a temp layout that
// mimics `dist/loomtide/<module>.js`.

/** Build a temp `<dir>/dist/loomtide/build-stamp.js` and return its file URL. */
async function fakeModule(opts: {
  version?: string | null;
  buildInfo?: unknown;
}): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "loomtide-stamp-"));
  const distDir = path.join(dir, "dist");
  const modDir = path.join(distDir, "loomtide");
  await fs.mkdir(modDir, { recursive: true });
  // package.json lives at the package root (two levels up from the module).
  if (opts.version !== null) {
    await fs.writeFile(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "@loomtide/cli", version: opts.version ?? "0.1.0" }),
      "utf-8",
    );
  }
  // build-info.json lives in dist/ (one level up from the module).
  if (opts.buildInfo !== undefined) {
    await fs.writeFile(
      path.join(distDir, "build-info.json"),
      JSON.stringify(opts.buildInfo),
      "utf-8",
    );
  }
  const modPath = path.join(modDir, "build-stamp.js");
  await fs.writeFile(modPath, "// placeholder\n", "utf-8");
  return pathToFileURL(modPath).href;
}

// ── the real running build (default moduleUrl) ───────────────────────────────

test("resolveBuildStamp (running build): every field present and non-empty, never omitted", () => {
  const stamp = resolveBuildStamp();
  assert.equal(stamp.tool, "loomtide");
  // version comes from the package.json next to the compiled module.
  assert.equal(typeof stamp.version, "string");
  assert.ok(stamp.version.length > 0, "version is non-empty");
  // commit is always present (a real sha, "+dirty", or "unknown") — never undefined.
  assert.equal(typeof stamp.commit, "string");
  assert.ok(stamp.commit.length > 0, "commit is non-empty");
  // builtAt is string|null, never undefined.
  assert.ok(stamp.builtAt === null || typeof stamp.builtAt === "string");
  assert.ok(["stamped", "dev", "unknown"].includes(stamp.stampStatus));
  // When NOT fully stamped, the note must explain why (absence-with-reason).
  if (stamp.stampStatus !== "stamped") {
    assert.ok(stamp.note && stamp.note.length > 0, "non-stamped build carries a reason note");
  }
});

test("npm test runs from a freshly-built dist, so the running build is fully stamped", () => {
  // `npm test` = `npm run build && test:unit`; build's postbuild writes
  // dist/build-info.json, so a clean run resolves a real commit + builtAt.
  const stamp = resolveBuildStamp();
  assert.equal(stamp.stampStatus, "stamped");
  assert.notEqual(stamp.commit, "unknown");
  assert.equal(typeof stamp.builtAt, "string");
  assert.equal(stamp.note, undefined, "a fully stamped build carries no caveat note");
});

// ── stamped build (version + git sha + builtAt) ──────────────────────────────

test("a clean stamped build resolves version, commit (+dirty marker) and builtAt", async () => {
  const url = await fakeModule({
    version: "0.1.0",
    buildInfo: { commit: "86bb72b+dirty", builtAt: "2026-06-12T11:46:20.722Z" },
  });
  const stamp = resolveBuildStamp(url);
  assert.equal(stamp.tool, "loomtide");
  assert.equal(stamp.version, "0.1.0");
  assert.equal(stamp.commit, "86bb72b+dirty"); // the +dirty marker is preserved
  assert.equal(stamp.builtAt, "2026-06-12T11:46:20.722Z");
  assert.equal(stamp.stampStatus, "stamped");
  assert.equal(stamp.note, undefined);
  // The one-line form matches `loomtide --version`.
  assert.equal(
    formatBuildStamp(stamp),
    "loomtide 0.1.0 (86bb72b+dirty, built 2026-06-12T11:46:20.722Z)",
  );
});

// ── absence is impossible: dev dist (no build-info.json) ─────────────────────

test("no build-info.json -> 'dev' stampStatus with a reason note, fields never omitted", async () => {
  const url = await fakeModule({ version: "0.1.0", buildInfo: undefined });
  const stamp = resolveBuildStamp(url);
  assert.equal(stamp.version, "0.1.0");
  assert.equal(stamp.commit, "unknown"); // present, explicitly unknown — NOT omitted
  assert.equal(stamp.builtAt, null);
  assert.equal(stamp.stampStatus, "dev");
  assert.ok(stamp.note && /build-info\.json/.test(stamp.note), "note explains the missing stamp");
  assert.equal(formatBuildStamp(stamp), "loomtide 0.1.0 (dev)");
});

// ── git-less build (build-info present, commit "unknown") ────────────────────

test("build-info commit='unknown' (git-less build) -> 'unknown' stampStatus + reason", async () => {
  const url = await fakeModule({
    version: "0.1.0",
    buildInfo: { commit: "unknown", builtAt: "2026-06-12T11:46:20.722Z" },
  });
  const stamp = resolveBuildStamp(url);
  assert.equal(stamp.commit, "unknown");
  assert.equal(stamp.builtAt, "2026-06-12T11:46:20.722Z");
  assert.equal(stamp.stampStatus, "unknown");
  assert.ok(stamp.note && /git-less|tarball/.test(stamp.note), "note explains the git-less build");
});

// ── version unreadable: still 'unknown', never crashes or omits ──────────────

test("unreadable package.json -> version 'unknown', other fields still resolved", async () => {
  const url = await fakeModule({
    version: null, // no package.json written
    buildInfo: { commit: "abc1234", builtAt: "2026-06-12T11:46:20.722Z" },
  });
  const stamp = resolveBuildStamp(url);
  assert.equal(stamp.version, "unknown");
  assert.equal(stamp.commit, "abc1234");
  assert.equal(stamp.stampStatus, "stamped");
});
