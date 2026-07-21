import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { isSafeCapturePath, isWithin } from "../loomtide/capture-paths.js";

// ── isSafeCapturePath ────────────────────────────────────────────────────────

test("isSafeCapturePath accepts normalized relative paths", () => {
  assert.equal(isSafeCapturePath("spawn/verify-manifest.json"), true);
  assert.equal(isSafeCapturePath("a/b/c.json"), true);
  assert.equal(isSafeCapturePath("file.json"), true);
});

test("isSafeCapturePath rejects absolute paths (POSIX + Windows shapes)", () => {
  assert.equal(isSafeCapturePath("/etc/passwd"), false);
  assert.equal(isSafeCapturePath("/abs/path.json"), false);
  // Windows-style: path.isAbsolute treats "C:\\..." as absolute on Windows
  // builds; on POSIX it's a weird filename. We don't rely on the platform —
  // the canonical-form check below rejects backslashes via normalization.
});

test("isSafeCapturePath rejects `..` segments (start, middle, alone)", () => {
  assert.equal(isSafeCapturePath(".."), false);
  assert.equal(isSafeCapturePath("../foo"), false);
  assert.equal(isSafeCapturePath("../reports/build-verdict.json"), false);
  // These normalize to escape — also rejected.
  assert.equal(isSafeCapturePath("a/../b"), false);
  assert.equal(isSafeCapturePath("foo/.."), false);
});

test("isSafeCapturePath rejects empty segments, trailing slashes, and `.` segments", () => {
  assert.equal(isSafeCapturePath("./foo"), false);
  assert.equal(isSafeCapturePath("a//b"), false);
  assert.equal(isSafeCapturePath("a/"), false);
  assert.equal(isSafeCapturePath("a/./b"), false);
});

test("isSafeCapturePath rejects backslashes (forces forward-slash forms cross-platform)", () => {
  assert.equal(isSafeCapturePath("spawn\\manifest.json"), false);
});

test("isSafeCapturePath rejects empty / wrong-type inputs defensively", () => {
  assert.equal(isSafeCapturePath(""), false);
  // @ts-expect-error — invalid type at runtime should not throw.
  assert.equal(isSafeCapturePath(null), false);
  // @ts-expect-error — invalid type at runtime should not throw.
  assert.equal(isSafeCapturePath(undefined), false);
});

// ── isWithin ─────────────────────────────────────────────────────────────────

test("isWithin returns true for equal paths and strict descendants", () => {
  const base = "/a/b/c";
  assert.equal(isWithin(base, "/a/b/c"), true, "equal paths are within (== boundary)");
  assert.equal(isWithin(base, "/a/b/c/d/e.json"), true);
});

test("isWithin returns false for siblings, parents, and prefix collisions", () => {
  const base = "/a/b/c";
  assert.equal(isWithin(base, "/a/b/cd"), false, "/a/b/cd looks like /a/b/c by string prefix only");
  assert.equal(isWithin(base, "/a/b"), false, "parent is not within child");
  assert.equal(isWithin(base, "/x/y/z"), false);
});

test("isWithin normalizes both sides (handles `..` in caller-supplied paths)", () => {
  const base = "/a/b";
  assert.equal(isWithin(base, "/a/b/c/../d.json"), true, "stays inside after normalize");
  assert.equal(isWithin(base, "/a/b/../c.json"), false, "escapes after normalize");
});

test("isWithin uses the platform separator so it works under either runtime", () => {
  // Resolve both, so on POSIX the assertion holds and on Windows it would too.
  const baseAbs = path.resolve("/tmp/loomtide-x/.loomtide/verify");
  const candidate = path.resolve(baseAbs, "spawn/manifest.json");
  assert.equal(isWithin(baseAbs, candidate), true);
});
