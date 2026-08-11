import os from "node:os";
import path from "node:path";
import { LOOMBRIDGE_DIRNAME } from "../shared/loombridge-dirname.js";
import type { McpStartupProjectBinding } from "./startup-binding.js";

/** Explicit override, for harnesses and for users who want traces somewhere specific. */
export const TRACE_DIR_ENV_VAR = "LOOMBRIDGE_TRACE_DIR";

/**
 * Where the MCP server writes op traces and their artifacts.
 *
 * The recorder used to default to `"./trace"` — relative to whatever directory the MCP
 * client launched the server from, which is normally the user's project root. That put
 * unbounded trace JSONL and screenshot artifacts outside the documented `.loombridge/`
 * state directory, in a location every consumer had to discover and .gitignore by hand,
 * and (in this repo) it dirtied the working tree so release artifacts stamped `+dirty`.
 *
 * Resolution, in order:
 *  1. `LOOMBRIDGE_TRACE_DIR` — explicit override, used verbatim.
 *  2. A bound Unity project → `<project>/.loombridge/replays/traces`, matching the
 *     contract that `.loombridge/` is the single source of truth per project.
 *  3. No bound project → a temp directory. Deliberately NOT cwd-relative: with no project
 *     to own the traces, writing into the caller's directory is what caused the problem.
 *
 * The directory is created lazily by the recorder, so an idle server writes nothing.
 */
export function resolveTraceDirectory(
  binding: McpStartupProjectBinding,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override = env[TRACE_DIR_ENV_VAR];
  if (typeof override === "string" && override.trim().length > 0) {
    return override.trim();
  }
  if (binding.kind === "strict" || binding.kind === "cwd") {
    // The dirname comes from the ONE constant. The `replays/traces` tail is spelled here
    // rather than taken from `loombridgePaths().replayTraces` because `bridge/` may not
    // import `domain/` (layering.test.ts). `__tests__/unit/repo/write-paths.test.ts` calls
    // THIS function and classifies what it returns, so the tail cannot drift unwatched.
    return path.join(binding.target, LOOMBRIDGE_DIRNAME, "replays", "traces");
  }
  return path.join(os.tmpdir(), "loombridge", "traces");
}
