/**
 * Repository identity for PORTABLE evidence binding.
 *
 * The stamped test-results manifest binds the project it was produced for. An absolute
 * path is the strongest anti-accident binding on ONE machine, and worthless across two:
 * the whole point of committing stamped evidence is that CI (a different machine, a
 * different checkout path) can grade it. What identifies "the same project" across
 * machines is the REPOSITORY plus the project's position inside it:
 *
 *  - `repoIdentity`: the canonicalized git origin URL when one exists, else a
 *    `basename:` marker that is provenance only and NEVER matches portably.
 *  - `projectPath`: the project root relative to the git toplevel ("." for a repo-root
 *    project), which keeps two Unity projects in one monorepo distinct.
 *
 * Everything here is read from the filesystem (.git directory or worktree file, git
 * config), never by spawning git: the CLI must answer the same way on a machine without
 * git installed, and a child process is not worth two file reads.
 *
 * HONEST SCOPE: like every stamp in this repo, this is anti-accident provenance, not
 * anti-forgery (the manifest is plain text; so was the absolute path). Two accidental
 * collisions remain and are stated rather than hidden: sibling clones of one template
 * repository share the template's origin until `git remote set-url` runs, and the
 * `basename:` fallback would collide on a directory name, which is why the matcher
 * refuses to match on it at all.
 */

import fsSync from "node:fs";
import path from "node:path";

export interface RepoIdentity {
  /**
   * Canonicalized origin URL when the repo has one, else `basename:<toplevel basename>`.
   * The `basename:` form is PROVENANCE ONLY: two unrelated local repos trivially share
   * a directory name (and an empty `.git` marker suffices to derive one), so the
   * matcher never accepts a portable match on it. Only a real origin identity matches.
   *
   * HONEST LIMIT even for real origins: clones of one template repository share the
   * template's origin (and its history) until `git remote set-url` runs, and no git
   * metadata distinguishes "another checkout of my repo" from "a sibling clone of the
   * same template". The binding is anti-accident provenance; the docs say so.
   */
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
    // Minimal ini walk. Section headers may be INDENTED (git allows it), so the
    // terminator anchors on any line whose first non-blank char is `[`, and git's own
    // precedence is last-value-wins, so the LAST url across all origin sections is
    // taken (the adversarial review defeated the first cut with an indented following
    // section that leaked the upstream url into origin).
    const sections = [...config.matchAll(/^[ \t]*\[remote "origin"\][ \t]*$([\s\S]*?)(?=^[ \t]*\[|(?![\s\S]))/gm)];
    let url: string | undefined;
    for (const section of sections) {
      const urls = [...(section[1] ?? "").matchAll(/^\s*url\s*=\s*(.+?)\s*$/gm)];
      const last = urls[urls.length - 1]?.[1];
      if (last !== undefined) url = last;
    }
    return url ? normalizeRepoUrl(url) : null;
  } catch {
    return null;
  }
}

/**
 * Canonicalize a remote URL so the SPELLINGS of one repository converge: scp-style ssh
 * (`git@host:path`), `ssh://`, `https://`, `git://`, quoted config values, trailing
 * slashes and the `.git` suffix all reduce to `host/path` with a lowercased host. The
 * single most common real split is an ssh clone on the dev machine and the https
 * checkout actions/checkout writes in CI: those MUST converge or the doc's flagship
 * tier-2 flow refuses on every runner (found by adversarial review before it shipped).
 */
export function normalizeRepoUrl(url: string): string {
  let u = url.trim().replace(/^"(.*)"$/, "$1").trim();
  // scp-style: user@host:path (no scheme, single colon not followed by //)
  const scp = u.match(/^(?:[^@/]+@)?([^:/]+):(?!\/\/)(.+)$/);
  if (scp) {
    u = `${scp[1]}/${scp[2]}`;
  } else {
    // scheme://[user@]host[:port]/path
    const schemed = u.match(/^[a-z+]+:\/\/(?:[^@/]+@)?([^/]+)(\/.*)?$/i);
    if (schemed) u = `${schemed[1]}${schemed[2] ?? ""}`;
  }
  u = u.replace(/\/+$/, "").replace(/\.git$/, "");
  const slash = u.indexOf("/");
  if (slash > 0) {
    const host = u.slice(0, slash).toLowerCase().replace(/:\d+$/, "");
    return `${host}${u.slice(slash)}`;
  }
  return u;
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
