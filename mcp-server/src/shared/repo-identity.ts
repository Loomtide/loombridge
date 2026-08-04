/**
 * Repository identity for PORTABLE evidence binding.
 *
 * Every stamped artifact in this repo (test results, the frozen feel snapshot, the
 * approved screen layout baseline) binds the project it was produced for. An absolute
 * path is the strongest anti-accident binding on ONE machine, and worthless across two:
 * the whole point of committing stamped evidence is that a teammate or CI (a different
 * machine, a different checkout path) can grade it. What identifies "the same project"
 * across machines is the REPOSITORY plus the project's position inside it:
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

/**
 * The ownership stamp an artifact carries: the absolute project root it was produced or
 * approved for, plus the OPTIONAL portable pair.
 *
 * ONE shape, and below it ONE predicate, for every stamped artifact. Three hand-rolled
 * copies of a rule that decides whether foreign evidence may grade this project is three
 * chances for one of them to drift into a weaker rule that nothing notices.
 */
export interface ProjectBinding {
  projectRoot: string;
  repoIdentity?: string;
  projectPath?: string;
}

/**
 * Does the stamped binding say this artifact belongs to `root`?
 *
 * Two ways to match, either sufficient:
 *  1. ABSOLUTE: same resolved path (the pre-portable rule; always true on the machine
 *     that produced the stamp).
 *  2. PORTABLE: the artifact carries repoIdentity + projectPath, and the current root
 *     derives the same pair (same repository, same position inside it), whatever the
 *     absolute checkout path is. A different repository cannot share an origin URL, and
 *     a second project inside the same monorepo differs in projectPath.
 *
 * This converts "the same absolute path" into "the same repo at the same relative
 * position" and NOTHING wider. An artifact with no portable stamp read from a different
 * absolute path still refuses; the caller's message names the re-stamp path.
 */
export function projectBindingMatches(binding: ProjectBinding, root: string): boolean {
  if (path.resolve(root) === path.resolve(binding.projectRoot)) return true;
  // BOTH portable fields must be present: an absent projectPath is a refusal, never a
  // default (the falsy-field anti-pattern; every on-disk validator enforces the pairing
  // too, but this predicate is what gates, so the refusal lives here as well).
  if (binding.repoIdentity === undefined || binding.projectPath === undefined) return false;
  // A `basename:` identity is a directory-name guess: two unrelated local repos (or two
  // directories with an empty `.git` marker) trivially share one, so it never matches
  // portably. Provenance only.
  if (binding.repoIdentity.startsWith("basename:")) return false;
  const derived = deriveRepoIdentity(root);
  if (derived === null) return false;
  if (derived.repoIdentity.startsWith("basename:")) return false;
  return derived.repoIdentity === binding.repoIdentity && derived.projectPath === binding.projectPath;
}

/**
 * Shape-check the portable pair on a parsed manifest: `null` when it is acceptable, else
 * the reason it is refused (the caller prefixes its own filename).
 *
 * The pair is OPTIONAL (legacy stamps and non-git projects carry neither), but a HALF
 * pair is a refusal rather than a field to ignore: a repoIdentity with no projectPath
 * would claim any position inside the repo, which is wider than the stamp ever asserted,
 * and silently dropping the odd field is the "absent means skip the check" shape this
 * repo bans.
 */
export function projectBindingPairError(value: {
  repoIdentity?: unknown;
  projectPath?: unknown;
}): string | null {
  for (const field of ["repoIdentity", "projectPath"] as const) {
    const entry = value[field];
    if (entry !== undefined && (typeof entry !== "string" || entry.length === 0)) {
      return `'${field}' must be a non-empty string when present`;
    }
  }
  if ((value.repoIdentity === undefined) !== (value.projectPath === undefined)) {
    return "'repoIdentity' and 'projectPath' must be stamped together";
  }
  return null;
}
