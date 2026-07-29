/**
 * Unity editor resolution for `loombridge tests run` (plan T3).
 *
 * A TypeScript port of `scripts/unity/open-project.sh`'s `find_unity`, so the CLI and the
 * developer script agree on WHICH editor a project belongs to. The rules, in order:
 *
 *  1. an explicit `--unity <path>` (the caller's override) wins;
 *  2. then `UNITY_EDITOR` from the environment;
 *  3. then the Unity Hub default install roots for this platform, plus the root the Hub
 *     records in `secondaryInstallPath.json` when the user moved it.
 *
 * The version is read from `ProjectSettings/ProjectVersion.txt` (first `m_EditorVersion`
 * line) and matched EXACTLY. No fuzzy matching: running `2022.3.10f1` sources through
 * `2022.3.62f1` recompiles the whole project and can rewrite the project's own version
 * file, which is exactly the mutation the producer's mutation guard exists to catch. A
 * miss is a refusal that names the version and the escape hatch, never a silent
 * substitution.
 *
 * Everything the resolver touches goes through `EditorLocatorSeams` so the unit tests can
 * plant fake Hub trees per platform without a Unity install and without ever spawning a
 * real editor.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** The filesystem and environment surface the resolver reads. Injected so tests can fake it. */
export interface EditorLocatorSeams {
  env: NodeJS.ProcessEnv;
  /** `process.platform` value: "darwin" | "win32" | anything else (treated as Linux). */
  platform: string;
  homedir(): string;
  /** True when `p` exists and can be executed (existence only on Windows). */
  isExecutable(p: string): boolean;
  isDirectory(p: string): boolean;
  /** File contents, or `null` when the file is absent or unreadable. */
  readTextFile(p: string): string | null;
  /** Canonicalized path; returns the input unchanged when it cannot be resolved. */
  realpath(p: string): string;
}

/** The real filesystem/environment seams, with per-field overrides for tests. */
export function defaultEditorLocatorSeams(overrides: Partial<EditorLocatorSeams> = {}): EditorLocatorSeams {
  const base: EditorLocatorSeams = {
    env: process.env,
    platform: process.platform,
    homedir: () => os.homedir(),
    isExecutable(p) {
      try {
        if (process.platform === "win32") return fs.statSync(p).isFile();
        fs.accessSync(p, fs.constants.X_OK);
        return fs.statSync(p).isFile();
      } catch {
        return false;
      }
    },
    isDirectory(p) {
      try {
        return fs.statSync(p).isDirectory();
      } catch {
        return false;
      }
    },
    readTextFile(p) {
      try {
        return fs.readFileSync(p, "utf-8");
      } catch {
        return null;
      }
    },
    realpath(p) {
      try {
        return fs.realpathSync(p);
      } catch {
        return p;
      }
    },
  };
  return { ...base, ...overrides };
}

/** A named refusal. Every resolver step returns one of these instead of throwing. */
export interface EditorLocatorError {
  error: string;
}

export function isEditorLocatorError<T extends object>(value: T | EditorLocatorError): value is EditorLocatorError {
  return "error" in value;
}

/** `<root>/ProjectSettings/ProjectVersion.txt`: the file that declares a project's editor. */
export function projectVersionPath(root: string): string {
  return path.join(root, "ProjectSettings", "ProjectVersion.txt");
}

/**
 * The editor version a Unity project declares.
 *
 * `ProjectVersion.txt` is a small YAML-ish file whose FIRST `m_EditorVersion` line is the
 * editor that owns the project (`m_EditorVersionWithRevision` follows it and carries a
 * revision hash the Hub paths do not use). Matching `m_EditorVersion:` with an anchored
 * pattern keeps the `WithRevision` line from winning by accident.
 */
export function readProjectEditorVersion(
  root: string,
  seams: EditorLocatorSeams = defaultEditorLocatorSeams(),
): { version: string } | EditorLocatorError {
  const file = projectVersionPath(root);
  const raw = seams.readTextFile(file);
  if (raw === null) {
    return { error: `not a Unity project (missing ${path.join("ProjectSettings", "ProjectVersion.txt")}): ${root}` };
  }
  for (const line of raw.split(/\r?\n/)) {
    const match = /^m_EditorVersion:[ \t]*(\S+)[ \t]*$/.exec(line);
    if (match) return { version: match[1] };
  }
  return { error: `could not read m_EditorVersion from ${file}` };
}

/**
 * Turn a user-supplied editor path into an executable.
 *
 * On macOS the Hub hands out `Unity.app`, a DIRECTORY; the binary lives at
 * `Contents/MacOS/Unity` inside it. Accepting the bundle and normalizing it is what makes
 * `--unity /Applications/Unity/Hub/Editor/6000.3.20f1/Unity.app` work the way a human
 * expects.
 */
export function normalizeUnityExecutable(
  value: string,
  seams: EditorLocatorSeams = defaultEditorLocatorSeams(),
): { path: string } | EditorLocatorError {
  let candidate = value;
  if (candidate.endsWith(".app") && seams.isDirectory(candidate)) {
    candidate = path.join(candidate, "Contents", "MacOS", "Unity");
  }
  if (!seams.isExecutable(candidate)) {
    return { error: `Unity executable is not executable: ${candidate}` };
  }
  return { path: seams.realpath(candidate) };
}

/**
 * Where the Hub records a moved install root.
 *
 * The shell original only looked at `%APPDATA%` (Windows). The Hub writes the same file
 * on every platform, so each platform's config location is checked here: a macOS user who
 * moved their editors off the boot volume used to get "Unity not found" with an install
 * sitting right there.
 */
export function hubSecondaryInstallConfigPath(seams: EditorLocatorSeams): string | null {
  if (seams.platform === "win32") {
    const appData = seams.env.APPDATA;
    return appData ? path.join(appData, "UnityHub", "secondaryInstallPath.json") : null;
  }
  if (seams.platform === "darwin") {
    return path.join(seams.homedir(), "Library", "Application Support", "UnityHub", "secondaryInstallPath.json");
  }
  return path.join(seams.homedir(), ".config", "UnityHub", "secondaryInstallPath.json");
}

/** The moved install root the Hub recorded, or `null` when there is none. Never throws. */
export function hubSecondaryInstallRoot(seams: EditorLocatorSeams): string | null {
  const configPath = hubSecondaryInstallConfigPath(seams);
  if (configPath === null) return null;
  const raw = seams.readTextFile(configPath);
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "string" && parsed.length > 0 ? parsed : null;
  } catch {
    return null;
  }
}

/** The editor binary inside a Hub install root, for this platform's layout. */
function editorBinaryUnder(installRoot: string, version: string, platform: string): string {
  if (platform === "darwin") return path.join(installRoot, version, "Unity.app", "Contents", "MacOS", "Unity");
  if (platform === "win32") return path.join(installRoot, version, "Editor", "Unity.exe");
  return path.join(installRoot, version, "Editor", "Unity");
}

/**
 * Every path an exact-version install could live at, in search order. Exported so the
 * refusal message can list what was searched and so a test can assert the layout per
 * platform without planting a whole tree.
 */
export function unityCandidatePaths(version: string, seams: EditorLocatorSeams): string[] {
  const candidates: string[] = [];
  const secondary = hubSecondaryInstallRoot(seams);

  if (seams.platform === "darwin") {
    candidates.push(editorBinaryUnder(path.join("/Applications", "Unity", "Hub", "Editor"), version, "darwin"));
    candidates.push(
      editorBinaryUnder(path.join(seams.homedir(), "Applications", "Unity", "Hub", "Editor"), version, "darwin"),
    );
  } else if (seams.platform === "win32") {
    const programFiles = seams.env.PROGRAMFILES;
    if (programFiles) {
      candidates.push(editorBinaryUnder(path.join(programFiles, "Unity", "Hub", "Editor"), version, "win32"));
    }
    candidates.push(editorBinaryUnder(path.join("C:\\Program Files", "Unity", "Hub", "Editor"), version, "win32"));
  } else {
    candidates.push(editorBinaryUnder(path.join(seams.homedir(), "Unity", "Hub", "Editor"), version, seams.platform));
  }

  if (secondary !== null) {
    candidates.push(editorBinaryUnder(secondary, version, seams.platform));
  }
  return candidates;
}

export interface ResolveEditorRequest {
  /** The exact editor version the project declares. */
  version: string;
  /** `--unity <path>`: the caller's explicit choice, which outranks everything. */
  override?: string;
}

/**
 * Resolve the editor for `version`, or refuse by name.
 *
 * The refusal deliberately names the version, every path searched, and BOTH escape
 * hatches. "Unity not found" with no version in it has cost real debugging time: the
 * usual cause is a project pinned one patch release away from what is installed, and the
 * message has to make that obvious without the reader opening ProjectVersion.txt.
 */
export function resolveUnityEditor(
  request: ResolveEditorRequest,
  seams: EditorLocatorSeams = defaultEditorLocatorSeams(),
): { path: string; source: "override" | "env" | "hub" } | EditorLocatorError {
  if (request.override !== undefined && request.override.length > 0) {
    const normalized = normalizeUnityExecutable(request.override, seams);
    if (isEditorLocatorError(normalized)) return { error: `--unity ${request.override}: ${normalized.error}` };
    return { path: normalized.path, source: "override" };
  }

  const fromEnv = seams.env.UNITY_EDITOR;
  if (fromEnv !== undefined && fromEnv.length > 0) {
    const normalized = normalizeUnityExecutable(fromEnv, seams);
    if (isEditorLocatorError(normalized)) return { error: `UNITY_EDITOR=${fromEnv}: ${normalized.error}` };
    return { path: normalized.path, source: "env" };
  }

  const candidates = unityCandidatePaths(request.version, seams);
  for (const candidate of candidates) {
    if (seams.isExecutable(candidate)) return { path: seams.realpath(candidate), source: "hub" };
  }

  return {
    error:
      `Unity ${request.version} not found. Install ${request.version} in Unity Hub, ` +
      `set UNITY_EDITOR=/path/to/Unity, or pass --unity <path>. ` +
      `Searched: ${candidates.join(", ") || "(no candidate roots for this platform)"}`,
  };
}
