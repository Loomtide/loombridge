/**
 * Unity editor resolution (plan T3), the TypeScript port of `scripts/unity/open-project.sh`.
 *
 * Every fact the resolver reads goes through `EditorLocatorSeams`, so these tests plant
 * fake Hub trees IN MEMORY and can exercise the Windows and Linux layouts from a macOS
 * developer machine. Nothing here touches a real Unity install, a real project, or
 * `~/.loombridge`, and no editor is ever spawned.
 *
 * The property under test is not "it finds Unity". It is that the PRECEDENCE holds
 * (--unity > UNITY_EDITOR > Hub), that the version match is EXACT, and that a miss is a
 * refusal naming the version and both escape hatches rather than a silent substitution: a
 * near-miss editor recompiles the project and can rewrite its version file, which is the
 * mutation the producer's guard exists to catch.
 */

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  defaultEditorLocatorSeams,
  hubSecondaryInstallConfigPath,
  isEditorLocatorError,
  normalizeUnityExecutable,
  projectVersionPath,
  readProjectEditorVersion,
  resolveUnityEditor,
  unityCandidatePaths,
  type EditorLocatorSeams,
} from "../../../../capabilities/tests/editor-locator.js";

const VERSION = "6000.3.20f1";

interface FakeWorld {
  platform: string;
  home: string;
  env?: NodeJS.ProcessEnv;
  /** Paths that exist and are executable files. */
  executables?: string[];
  /** Directories that exist. */
  directories?: string[];
  /** File contents by absolute path. */
  files?: Record<string, string>;
}

/** An in-memory filesystem + environment. No disk, no platform assumptions. */
function fakeSeams(world: FakeWorld): EditorLocatorSeams {
  const executables = new Set(world.executables ?? []);
  const directories = new Set(world.directories ?? []);
  const files = world.files ?? {};
  return defaultEditorLocatorSeams({
    env: world.env ?? {},
    platform: world.platform,
    homedir: () => world.home,
    isExecutable: (p) => executables.has(p),
    isDirectory: (p) => directories.has(p),
    readTextFile: (p) => files[p] ?? null,
    realpath: (p) => p,
  });
}

/* -------------------------------------------------------------------------- */
/* ProjectVersion.txt                                                         */
/* -------------------------------------------------------------------------- */

test("the project's editor version is the FIRST m_EditorVersion line, not the WithRevision one", () => {
  const root = "/projects/dev-project";
  const seams = fakeSeams({
    platform: "darwin",
    home: "/Users/dev",
    files: {
      [projectVersionPath(root)]: `m_EditorVersion: ${VERSION}\nm_EditorVersionWithRevision: ${VERSION} (0123456789ab)\n`,
    },
  });
  const version = readProjectEditorVersion(root, seams);
  assert.ok(!isEditorLocatorError(version));
  assert.equal(version.version, VERSION);
});

test("a directory with no ProjectVersion.txt is refused by name", () => {
  const seams = fakeSeams({ platform: "darwin", home: "/Users/dev" });
  const version = readProjectEditorVersion("/not/a/project", seams);
  assert.ok(isEditorLocatorError(version));
  assert.match(version.error, /not a Unity project/);
  assert.match(version.error, /ProjectVersion\.txt/);
});

test("a ProjectVersion.txt with no m_EditorVersion line is refused, not defaulted", () => {
  const root = "/projects/broken";
  const seams = fakeSeams({
    platform: "darwin",
    home: "/Users/dev",
    files: { [projectVersionPath(root)]: "m_EditorVersionWithRevision: 6000.3.20f1 (abc)\n" },
  });
  const version = readProjectEditorVersion(root, seams);
  assert.ok(isEditorLocatorError(version));
  assert.match(version.error, /could not read m_EditorVersion/);
});

/* -------------------------------------------------------------------------- */
/* Hub layouts per platform                                                   */
/* -------------------------------------------------------------------------- */

test("macOS: the Hub default root resolves through the .app bundle to the binary", () => {
  const binary = `/Applications/Unity/Hub/Editor/${VERSION}/Unity.app/Contents/MacOS/Unity`;
  const seams = fakeSeams({ platform: "darwin", home: "/Users/dev", executables: [binary] });
  const resolved = resolveUnityEditor({ version: VERSION }, seams);
  assert.ok(!isEditorLocatorError(resolved), JSON.stringify(resolved));
  assert.equal(resolved.path, binary);
  assert.equal(resolved.source, "hub");
});

test("Windows: PROGRAMFILES and the C:\\Program Files fallback are both searched", () => {
  const binary = path.join("C:\\Program Files", "Unity", "Hub", "Editor", VERSION, "Editor", "Unity.exe");
  const seams = fakeSeams({ platform: "win32", home: "C:\\Users\\dev", executables: [binary] });
  const resolved = resolveUnityEditor({ version: VERSION }, seams);
  assert.ok(!isEditorLocatorError(resolved), JSON.stringify(resolved));
  assert.equal(resolved.path, binary);

  const fromProgramFiles = path.join("D:\\Apps", "Unity", "Hub", "Editor", VERSION, "Editor", "Unity.exe");
  const withEnv = fakeSeams({
    platform: "win32",
    home: "C:\\Users\\dev",
    env: { PROGRAMFILES: "D:\\Apps" },
    executables: [fromProgramFiles],
  });
  const viaEnv = resolveUnityEditor({ version: VERSION }, withEnv);
  assert.ok(!isEditorLocatorError(viaEnv));
  assert.equal(viaEnv.path, fromProgramFiles);
});

test("Linux: the Hub installs under ~/Unity/Hub/Editor/<version>/Editor/Unity", () => {
  const home = "/home/dev";
  const binary = path.join(home, "Unity", "Hub", "Editor", VERSION, "Editor", "Unity");
  const seams = fakeSeams({ platform: "linux", home, executables: [binary] });
  const resolved = resolveUnityEditor({ version: VERSION }, seams);
  assert.ok(!isEditorLocatorError(resolved), JSON.stringify(resolved));
  assert.equal(resolved.path, binary);
});

test("the Hub's secondaryInstallPath.json is honoured, per platform config location", () => {
  // Windows: %APPDATA%\UnityHub\secondaryInstallPath.json, the case the shell original covered.
  const secondary = "D:\\UnityEditors";
  const binary = path.join(secondary, VERSION, "Editor", "Unity.exe");
  const winSeams = fakeSeams({
    platform: "win32",
    home: "C:\\Users\\dev",
    env: { APPDATA: "C:\\Users\\dev\\AppData\\Roaming" },
    executables: [binary],
    files: {
      // The Hub writes a JSON string, so a Windows path arrives with escaped separators.
      [path.join("C:\\Users\\dev\\AppData\\Roaming", "UnityHub", "secondaryInstallPath.json")]:
        JSON.stringify(secondary),
    },
  });
  const winResolved = resolveUnityEditor({ version: VERSION }, winSeams);
  assert.ok(!isEditorLocatorError(winResolved), JSON.stringify(winResolved));
  assert.equal(winResolved.path, binary);

  // macOS: the Hub writes the same file under Application Support. A user who moved their
  // editors off the boot volume used to get "not found" with an install sitting right there.
  const home = "/Users/dev";
  const macSecondary = "/Volumes/Work/UnityEditors";
  const macBinary = path.join(macSecondary, VERSION, "Unity.app", "Contents", "MacOS", "Unity");
  const macSeams = fakeSeams({
    platform: "darwin",
    home,
    executables: [macBinary],
    files: {
      [path.join(home, "Library", "Application Support", "UnityHub", "secondaryInstallPath.json")]:
        JSON.stringify(macSecondary),
    },
  });
  const macResolved = resolveUnityEditor({ version: VERSION }, macSeams);
  assert.ok(!isEditorLocatorError(macResolved), JSON.stringify(macResolved));
  assert.equal(macResolved.path, macBinary);

  assert.equal(hubSecondaryInstallConfigPath(fakeSeams({ platform: "win32", home: "C:\\x" })), null);
});

test("a malformed secondaryInstallPath.json is ignored, not fatal", () => {
  const binary = `/Applications/Unity/Hub/Editor/${VERSION}/Unity.app/Contents/MacOS/Unity`;
  const home = "/Users/dev";
  const seams = fakeSeams({
    platform: "darwin",
    home,
    executables: [binary],
    files: {
      [path.join(home, "Library", "Application Support", "UnityHub", "secondaryInstallPath.json")]: "{not json",
    },
  });
  const resolved = resolveUnityEditor({ version: VERSION }, seams);
  assert.ok(!isEditorLocatorError(resolved));
  assert.equal(resolved.path, binary);
});

/* -------------------------------------------------------------------------- */
/* Precedence and refusal                                                     */
/* -------------------------------------------------------------------------- */

test("PRECEDENCE: --unity beats UNITY_EDITOR beats the Hub", () => {
  const hub = `/Applications/Unity/Hub/Editor/${VERSION}/Unity.app/Contents/MacOS/Unity`;
  const fromEnv = "/opt/unity-env/Unity";
  const fromFlag = "/opt/unity-flag/Unity";
  const seams = fakeSeams({
    platform: "darwin",
    home: "/Users/dev",
    env: { UNITY_EDITOR: fromEnv },
    executables: [hub, fromEnv, fromFlag],
  });

  const withFlag = resolveUnityEditor({ version: VERSION, override: fromFlag }, seams);
  assert.ok(!isEditorLocatorError(withFlag));
  assert.equal(withFlag.path, fromFlag);
  assert.equal(withFlag.source, "override");

  const withEnv = resolveUnityEditor({ version: VERSION }, seams);
  assert.ok(!isEditorLocatorError(withEnv));
  assert.equal(withEnv.path, fromEnv);
  assert.equal(withEnv.source, "env");
});

test("an override pointing at a Unity.app BUNDLE is normalized to the binary inside it", () => {
  const bundle = "/opt/editors/Unity.app";
  const binary = path.join(bundle, "Contents", "MacOS", "Unity");
  const seams = fakeSeams({
    platform: "darwin",
    home: "/Users/dev",
    directories: [bundle],
    executables: [binary],
  });
  const normalized = normalizeUnityExecutable(bundle, seams);
  assert.ok(!isEditorLocatorError(normalized));
  assert.equal(normalized.path, binary);

  const resolved = resolveUnityEditor({ version: VERSION, override: bundle }, seams);
  assert.ok(!isEditorLocatorError(resolved));
  assert.equal(resolved.path, binary);
});

test("an override that is not executable is refused, naming which override it was", () => {
  const seams = fakeSeams({ platform: "darwin", home: "/Users/dev", env: { UNITY_EDITOR: "/nope/Unity" } });

  const fromEnv = resolveUnityEditor({ version: VERSION }, seams);
  assert.ok(isEditorLocatorError(fromEnv));
  assert.match(fromEnv.error, /UNITY_EDITOR=\/nope\/Unity/);
  assert.match(fromEnv.error, /not executable/);

  const fromFlag = resolveUnityEditor({ version: VERSION, override: "/also/nope" }, seams);
  assert.ok(isEditorLocatorError(fromFlag));
  assert.match(fromFlag.error, /--unity \/also\/nope/);
});

test("EXACT match only: a near-miss install does not satisfy the declared version", () => {
  // 6000.3.19f1 installed, 6000.3.20f1 declared. Substituting it would recompile the whole
  // project and can rewrite ProjectVersion.txt, so the resolver refuses instead.
  const installed = "/Applications/Unity/Hub/Editor/6000.3.19f1/Unity.app/Contents/MacOS/Unity";
  const seams = fakeSeams({ platform: "darwin", home: "/Users/dev", executables: [installed] });
  const resolved = resolveUnityEditor({ version: VERSION }, seams);
  assert.ok(isEditorLocatorError(resolved), "a different patch release must not be substituted");

  // The message has to make the near-miss obvious without the reader opening a file.
  assert.match(resolved.error, new RegExp(`Unity ${VERSION.replace(/\./g, "\\.")} not found`));
  assert.match(resolved.error, /Install .* in Unity Hub/);
  assert.match(resolved.error, /UNITY_EDITOR=/);
  assert.match(resolved.error, /--unity <path>/);
  assert.match(resolved.error, /Searched: /);
  for (const candidate of unityCandidatePaths(VERSION, seams)) {
    assert.ok(resolved.error.includes(candidate), `the refusal must list ${candidate}`);
  }
});

test("the candidate list is platform-shaped, so a Windows layout is never searched on macOS", () => {
  const mac = unityCandidatePaths(VERSION, fakeSeams({ platform: "darwin", home: "/Users/dev" }));
  const win = unityCandidatePaths(VERSION, fakeSeams({ platform: "win32", home: "C:\\Users\\dev" }));
  const linux = unityCandidatePaths(VERSION, fakeSeams({ platform: "linux", home: "/home/dev" }));

  assert.ok(mac.every((p) => p.endsWith("Unity.app/Contents/MacOS/Unity")), mac.join(", "));
  assert.ok(win.every((p) => p.endsWith("Unity.exe")), win.join(", "));
  assert.ok(linux.every((p) => p.endsWith(path.join("Editor", "Unity"))), linux.join(", "));
  for (const list of [mac, win, linux]) {
    assert.ok(list.every((p) => p.includes(VERSION)), "every candidate is version-pinned");
  }
});
