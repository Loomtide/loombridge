import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  findUnityProjectRoot,
  resolveMcpStartupProjectBinding,
} from "../bridge/startup-binding.js";

const ENV_VAR = "LOOMBRIDGE_UNITY_PROJECT";

/** Create a temp Unity project (with the ProjectVersion.txt marker) and return its root. */
function makeUnityProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "loombridge-unity-"));
  const projectSettings = path.join(root, "ProjectSettings");
  fs.mkdirSync(projectSettings, { recursive: true });
  fs.writeFileSync(
    path.join(projectSettings, "ProjectVersion.txt"),
    "m_EditorVersion: 6000.3.0f1\n",
  );
  // Common nested dir so cwd-inside-Assets tests have somewhere to start from.
  fs.mkdirSync(path.join(root, "Assets", "Scripts"), { recursive: true });
  return root;
}

/** Create a temp directory that is NOT a Unity project. */
function makeNonUnityDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "loombridge-plain-"));
}

test("findUnityProjectRoot: returns the project root when started at the root", () => {
  const root = makeUnityProject();
  assert.equal(findUnityProjectRoot(root), root);
});

test("findUnityProjectRoot: cwd inside Assets/ resolves to the project root", () => {
  const root = makeUnityProject();
  const inside = path.join(root, "Assets", "Scripts");
  assert.equal(findUnityProjectRoot(inside), root);
});

test("findUnityProjectRoot: non-Unity directory returns null", () => {
  const plain = makeNonUnityDir();
  assert.equal(findUnityProjectRoot(plain), null);
});

test("findUnityProjectRoot: walk stops cleanly at the filesystem root", () => {
  // Starting from the OS root must terminate (no infinite loop) and find nothing.
  assert.equal(findUnityProjectRoot(path.parse(process.cwd()).root), null);
});

test("findUnityProjectRoot: empty/invalid startDir returns null", () => {
  assert.equal(findUnityProjectRoot(""), null);
  assert.equal(findUnityProjectRoot("   "), null);
  // @ts-expect-error — exercising defensive non-string guard
  assert.equal(findUnityProjectRoot(undefined), null);
});

test("findUnityProjectRoot: unreadable/nonexistent path returns null without throwing", () => {
  const missing = path.join(makeNonUnityDir(), "does", "not", "exist");
  assert.equal(findUnityProjectRoot(missing), null);
});

test("resolveMcpStartupProjectBinding: env var wins over cwd", () => {
  const root = makeUnityProject();
  const inside = path.join(root, "Assets");
  const binding = resolveMcpStartupProjectBinding({
    env: { [ENV_VAR]: "/Users/dev/EnvProject" },
    cwd: inside,
  });
  assert.deepEqual(binding, { kind: "strict", target: "/Users/dev/EnvProject" });
});

test("resolveMcpStartupProjectBinding: env var is trimmed", () => {
  const binding = resolveMcpStartupProjectBinding({
    env: { [ENV_VAR]: "  /Users/dev/EnvProject  " },
    cwd: makeNonUnityDir(),
  });
  assert.deepEqual(binding, { kind: "strict", target: "/Users/dev/EnvProject" });
});

test("resolveMcpStartupProjectBinding: blank env var falls back to cwd inference", () => {
  const root = makeUnityProject();
  const binding = resolveMcpStartupProjectBinding({
    env: { [ENV_VAR]: "   " },
    cwd: path.join(root, "Assets"),
  });
  assert.deepEqual(binding, { kind: "cwd", target: root });
});

test("resolveMcpStartupProjectBinding: cwd inside a Unity project yields a fail-closed cwd binding", () => {
  const root = makeUnityProject();
  const binding = resolveMcpStartupProjectBinding({
    env: {},
    cwd: path.join(root, "Assets", "Scripts"),
  });
  assert.deepEqual(binding, { kind: "cwd", target: root });
});

test("resolveMcpStartupProjectBinding: non-Unity cwd without env returns none", () => {
  const binding = resolveMcpStartupProjectBinding({
    env: {},
    cwd: makeNonUnityDir(),
  });
  assert.deepEqual(binding, { kind: "none" });
});
