import fs from "node:fs";
import path from "node:path";
import {
  UNITY_PROJECT_ENV_VAR,
  resolveUnityProjectTarget,
} from "./verification/unity-client-resolver.js";

/**
 * The MCP server's inferred startup binding to a Unity project.
 *
 * Both binding kinds are named by their *source* (env vs cwd) and BOTH fail closed:
 * if the bound target does not match a discovered editor the registry throws
 * `EDITOR_NOT_FOUND` — it must NEVER fall through to some other single editor.
 *
 * - `strict`  — an explicit `LOOMBRIDGE_UNITY_PROJECT` target. The explicit override for
 *   unusual layouts (e.g. when the cwd is not inside the Unity project).
 * - `cwd`     — the developer's intended project, inferred from the nearest Unity project
 *   root above the server's cwd. Launching the agent from inside a Unity project folder is
 *   exactly as intentional as setting the env var, so a cwd binding is fail-closed too: if
 *   its editor isn't discoverable the registry fails closed rather than touching another
 *   project.
 * - `none`    — no startup signal; behave exactly like the pre-binding server.
 */
export type McpStartupProjectBinding =
  | { kind: "strict"; target: string }
  | { kind: "cwd"; target: string }
  | { kind: "none" };

const UNITY_PROJECT_VERSION_MARKER = path.join("ProjectSettings", "ProjectVersion.txt");

/** Defensive cap so a pathological symlink/mount loop cannot spin forever. */
const MAX_UPWARD_WALK_DEPTH = 64;

/**
 * Walk upward from `startDir` looking for a Unity project root, identified by a
 * `ProjectSettings/ProjectVersion.txt` marker. Returns the project root directory, or
 * `null` if none is found before the filesystem root.
 *
 * Filesystem errors (EACCES, ENOENT, unreadable directories) are swallowed and treated
 * as "not a project root here" so a sandboxed/locked-down cwd never throws.
 */
export function findUnityProjectRoot(startDir: string): string | null {
  if (typeof startDir !== "string" || startDir.trim().length === 0) {
    return null;
  }

  let current = path.resolve(startDir);
  for (let depth = 0; depth < MAX_UPWARD_WALK_DEPTH; depth++) {
    if (hasUnityProjectMarker(current)) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      // Reached the filesystem root (dirname is idempotent there).
      return null;
    }
    current = parent;
  }
  return null;
}

function hasUnityProjectMarker(dir: string): boolean {
  try {
    return fs.statSync(path.join(dir, UNITY_PROJECT_VERSION_MARKER)).isFile();
  } catch {
    // EACCES / ENOENT / unreadable — treat as "no marker here" and keep walking.
    return false;
  }
}

/**
 * Resolve the MCP server's startup project binding from its environment and cwd.
 *
 * Precedence (mirrors the plan's Binding Precedence §3–§4):
 *   1. `LOOMBRIDGE_UNITY_PROJECT` (strict) — the explicit override; wins over cwd inference.
 *   2. nearest Unity project root above `cwd` (cwd) — the developer's intended project.
 *   3. otherwise `{ kind: "none" }`.
 *
 * Both `strict` and `cwd` bind fail-closed; see `McpStartupProjectBinding`.
 */
export function resolveMcpStartupProjectBinding(options: {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
} = {}): McpStartupProjectBinding {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();

  // §3 — an explicit env target binds strictly and wins over cwd. Reuse the shared
  // resolver so the env literal lives in exactly one place.
  const envTarget = resolveUnityProjectTarget(undefined, env);
  if (typeof env[UNITY_PROJECT_ENV_VAR] === "string" && envTarget) {
    return { kind: "strict", target: envTarget };
  }

  // §4 — the developer's intended project, inferred from the cwd's nearest Unity project
  // root. Fail-closed, like the env binding.
  const root = findUnityProjectRoot(cwd);
  if (root) {
    return { kind: "cwd", target: root };
  }

  return { kind: "none" };
}
