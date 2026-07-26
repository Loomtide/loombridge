/**
 * `build-stamp` — the single source of truth for "which build of loombridge is
 * running right now". F5 finding #14: a `verify --profile` report carried NO
 * record of which runtime/build graded it, so an independent audit could not
 * prove from artifacts alone that a "frozen gate" was the build that produced a
 * verdict (the F1 run was graded by a `+dirty` runtime; only a cross-build
 * re-run partially compensated).
 *
 * The build identity comes from two places, both frozen into the runtime at
 * install (`scripts/loombridge-install-locally.sh` copies `dist/` wholesale):
 *  - `version` — `mcp-server/package.json#version` (next to the compiled module).
 *  - `commit` + `builtAt` — `dist/build-info.json`, stamped by the build's
 *    `postbuild` step (`scripts/write-build-info.mjs`): `commit` is the short
 *    git SHA at build time with a `+dirty` suffix when the tree was modified
 *    (or `"unknown"` outside a git checkout, e.g. an npm-packed tarball), and
 *    `builtAt` is the ISO build timestamp.
 *
 * This is exactly the data `loombridge --version` prints (see `cli.ts#printVersion`).
 * It is extracted here so a report can STAMP the same identity it would print,
 * from one resolver — never two drifting copies.
 *
 * Refusal discipline (CLAUDE.md): absence must be impossible. When build-info is
 * unavailable at runtime the stamp does not omit the field — it records
 * `"unknown"` with an explicit `note` saying WHY (dev/hand-built dist, or a
 * git-less build), so a missing stamp can never be mistaken for a clean one.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * `stamped` — version + commit + builtAt all resolved from a real build.
 * `dev`     — no `build-info.json` at all (a hand-built `dist`, never installed
 *             via the build's postbuild step) → commit/builtAt unknown.
 * `unknown` — `build-info.json` present but `commit` is `"unknown"` (a git-less
 *             build, e.g. an npm-packed tarball).
 */
export type BuildStampStatus = "stamped" | "dev" | "unknown";

/**
 * The producing-runtime identity stamped into a report. Every field is always
 * present (absence is impossible): unresolved values are `"unknown"`/`null`
 * with a `note` explaining why, never omitted.
 */
export interface BuildStamp {
  /** Always `"loombridge"` — the tool that produced the artifact. */
  tool: "loombridge";
  /** `mcp-server/package.json#version`, or `"unknown"` if unreadable. */
  version: string;
  /** Short git SHA at build time, with `+dirty` if the tree was modified; `"unknown"` if not git-stamped. */
  commit: string;
  /** ISO build timestamp from the build, or `null` if not git-stamped. */
  builtAt: string | null;
  /** Whether the identity is fully stamped, a dev dist, or a git-less build. */
  stampStatus: BuildStampStatus;
  /** Present whenever `stampStatus !== "stamped"`: WHY the identity is incomplete. */
  note?: string;
}

/**
 * Resolve the running build's identity. `moduleUrl` defaults to this module's
 * own URL (so the resolver works regardless of caller); tests pass it explicitly
 * only to exercise paths.
 *
 * Resolution mirrors `cli.ts#printVersion`:
 *  - `version` ← `package.json#version` at the package root. The compiled module
 *    sits in `dist/capabilities/`, so the package root is two levels up:
 *    `../../package.json`.
 *  - `commit`/`builtAt` ← `dist/build-info.json`, one level up from the compiled
 *    module: `../build-info.json`.
 */
export function resolveBuildStamp(moduleUrl: string = import.meta.url): BuildStamp {
  let version = "unknown";
  try {
    const pkg = JSON.parse(
      readFileSync(fileURLToPath(new URL("../../package.json", moduleUrl)), "utf-8"),
    );
    if (typeof pkg.version === "string" && pkg.version.length > 0) version = pkg.version;
  } catch {
    /* package.json not resolvable — keep "unknown" */
  }

  let commit = "unknown";
  let builtAt: string | null = null;
  let stampStatus: BuildStampStatus = "dev";
  let note: string | undefined =
    "no build-info.json (a dev/hand-built dist not produced by the build's postbuild step) — commit and builtAt are unknown";

  try {
    const info = JSON.parse(
      readFileSync(fileURLToPath(new URL("../build-info.json", moduleUrl)), "utf-8"),
    );
    const infoCommit = typeof info.commit === "string" && info.commit.length > 0 ? info.commit : "unknown";
    const infoBuiltAt = typeof info.builtAt === "string" && info.builtAt.length > 0 ? info.builtAt : null;
    commit = infoCommit;
    builtAt = infoBuiltAt;
    if (infoCommit === "unknown") {
      stampStatus = "unknown";
      note = "build-info.json present but commit is 'unknown' (a git-less build, e.g. an npm-packed tarball)";
    } else {
      stampStatus = "stamped";
      note = undefined;
    }
  } catch {
    /* no build-info.json — keep the dev defaults set above */
  }

  const stamp: BuildStamp = {
    tool: "loombridge",
    version,
    commit,
    builtAt,
    stampStatus,
  };
  if (note !== undefined) stamp.note = note;
  return stamp;
}

/**
 * One-line human-readable form, matching `loombridge --version` style
 * (`loombridge 0.1.0 (86bb72b+dirty, built 2026-…)`). Used for the CLI report line
 * so the producing runtime reads the same everywhere.
 */
export function formatBuildStamp(stamp: BuildStamp): string {
  let inner: string;
  if (stamp.stampStatus === "dev") {
    inner = "dev";
  } else if (stamp.builtAt) {
    inner = `${stamp.commit}, built ${stamp.builtAt}`;
  } else {
    inner = stamp.commit;
  }
  return `${stamp.tool} ${stamp.version} (${inner})`;
}
