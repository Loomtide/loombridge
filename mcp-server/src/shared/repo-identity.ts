/**
 * Repository identity for PORTABLE evidence binding.
 *
 * The stamped test-results manifest binds the project it was produced for. An absolute
 * path is the strongest anti-accident binding on ONE machine, and worthless across two:
 * the whole point of committing stamped evidence is that CI (a different machine, a
 * different checkout path) can grade it. What identifies "the same project" across
 * machines is the REPOSITORY plus the project's position inside it:
 *
 *  - `repoIdentity`: the git origin URL when one exists (a clone of a different project
 *    cannot share it), else the toplevel directory's basename (weaker, stated as such).
 *  - `projectPath`: the project root relative to the git toplevel ("." for a repo-root
 *    project), which keeps two Unity projects in one monorepo distinct.
 *
 * Everything here is read from the filesystem (.git directory or worktree file, git
 * config), never by spawning git: the CLI must answer the same way on a machine without
 * git installed, and a child process is not worth two file reads.
 *
 * HONEST SCOPE: like every stamp in this repo, this is anti-accident provenance, not
 * anti-forgery (the manifest is plain text; so was the absolute path). What it must
 * never do is MATCH two genuinely different projects by accident: an origin URL cannot
 * collide across different repositories, and the basename fallback is only consulted
 * when neither side has an origin.
 */

import fsSync from "node:fs";
import path from "node:path";

export interface RepoIdentity {
  /** Origin URL (normalized) when the repo has one, else `basename:<toplevel basename>`. */
  repoIdentity: string;
  /** Project root relative to the git toplevel, POSIX separators, "." for the toplevel itself. */
  projectPath: string;
}

/**
 * Walk up from `dir` to the nearest ancestor containing `.git` (a directory in a normal
 * clone, a FILE in a worktree or submodule: both mark the working-tree toplevel).
 * Returns null when no ancestor is a git working tree. The walk is by marker, never by
 * counting `..` segments (CLAUDE.md).
 */
export function findGitToplevel(dir: string): string | null {
  let current = path.resolve(dir);
  for (;;) {
    if (fsSync.existsSync(path.join(current, ".git"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * The origin URL from the repo's git config, or null. Handles the worktree/submodule
 * `.git` FILE (a `gitdir: <path>` pointer, followed once, plus the `commondir` hop where
 * present) on a best-effort basis: an unreadable config yields null, never a throw.
 */
export function readOriginUrl(toplevel: string): string | null {
  try {
    let gitDir = path.join(toplevel, ".git");
    const stat = fsSync.statSync(gitDir);
    if (stat.isFile()) {
      const pointer = fsSync.readFileSync(gitDir, "utf-8").match(/^gitdir:\s*(.+)\s*$/m);
      if (!pointer) return null;
      gitDir = path.resolve(toplevel, pointer[1]!.trim());
      const commonPath = path.join(gitDir, "commondir");
      if (fsSync.existsSync(commonPath)) {
        gitDir = path.resolve(gitDir, fsSync.readFileSync(commonPath, "utf-8").trim());
      }
    }
    const config = fsSync.readFileSync(path.join(gitDir, "config"), "utf-8");
    // Minimal ini walk: the url line inside the [remote "origin"] section.
    const section = config.match(/\[remote "origin"\]([\s\S]*?)(?=\n\[|$)/);
    const url = section?.[1]?.match(/^\s*url\s*=\s*(.+)\s*$/m)?.[1];
    return url ? normalizeRepoUrl(url) : null;
  } catch {
    return null;
  }
}

/** Trailing `.git` and whitespace stripped so ssh/https spellings of one repo converge more often. */
export function normalizeRepoUrl(url: string): string {
  return url.trim().replace(/\.git$/, "");
}

/**
 * Derive the portable identity for a project root, or null when the root is not inside
 * a git working tree (a non-git project has no portable identity; the absolute-path
 * binding remains the only one available and the caller says so).
 */
export function deriveRepoIdentity(projectRoot: string): RepoIdentity | null {
  const resolved = path.resolve(projectRoot);
  const toplevel = findGitToplevel(resolved);
  if (toplevel === null) return null;
  const origin = readOriginUrl(toplevel);
  const repoIdentity = origin ?? `basename:${path.basename(toplevel)}`;
  const rel = path.relative(toplevel, resolved);
  const projectPath = rel === "" ? "." : rel.split(path.sep).join("/");
  return { repoIdentity, projectPath };
}
