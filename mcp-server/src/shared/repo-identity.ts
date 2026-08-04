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
 * anti-forgery (the manifest is plain text; so was the absolute path). It is also WEAKER
 * anti-forgery than the absolute path it replaces: forging the old stamp meant guessing
 * the victim's checkout path, while the clone URL is a public fact. That is the price of
 * an anchor that can be committed at all, and it is stated rather than hidden.
 *
 * Two accidental collisions remain and are likewise stated: sibling clones of one
 * template repository share the template's origin until `git remote set-url` runs, and
 * any identity that is not a real `host/path` (the `basename:` fallback, a `../x.git`
 * relative remote, a config shorthand) would collide on a name, which is why the matcher
 * refuses to match on those at all.
 */

import fsSync from "node:fs";
import path from "node:path";

export interface RepoIdentity {
  /**
   * Canonicalized origin URL when the repo has one, else `basename:<toplevel basename>`.
   * The `basename:` form is PROVENANCE ONLY: two unrelated local repos trivially share
   * a directory name (and an empty `.git` marker suffices to derive one), so the
   * matcher never accepts a portable match on it. Nor does it accept an origin that is
   * not a real `host/path` (see `isPortableRepoIdentity`): only a routable identity
   * names one repository from two machines.
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
/** The port each transport implies, and therefore the only port that may be dropped. */
const DEFAULT_PORT_BY_SCHEME: Record<string, string> = {
  ssh: "22",
  "git+ssh": "22",
  git: "9418",
  http: "80",
  https: "443",
};

export function normalizeRepoUrl(url: string): string {
  let u = url.trim().replace(/^"(.*)"$/, "$1").trim();
  let scheme: string | undefined;
  // scp-style: user@host:path (no scheme, single colon not followed by //)
  const scp = u.match(/^(?:[^@/]+@)?([^:/]+):(?!\/\/)(.+)$/);
  if (scp) {
    u = `${scp[1]}/${scp[2]}`;
  } else {
    // scheme://[user@]host[:port]/path
    const schemed = u.match(/^([a-z+]+):\/\/(?:[^@/]+@)?([^/]+)(\/.*)?$/i);
    if (schemed) {
      scheme = schemed[1]!.toLowerCase();
      u = `${schemed[2]}${schemed[3] ?? ""}`;
    }
  }
  u = u.replace(/\/+$/, "").replace(/\.git$/, "");
  const slash = u.indexOf("/");
  if (slash > 0) {
    let host = u.slice(0, slash).toLowerCase();
    // A NON-DEFAULT port stays part of the identity. Dropping every port made
    // `ssh://git@git.internal:2222/team/app` and `:2223/team/app` one repository, and two
    // git services on one host at different ports is an ordinary self-hosted layout.
    // Dropping only the scheme's own default keeps the convergence this function exists
    // for: `ssh://git@host:22/p` and the scp-style `git@host:p` are one URL spelled twice.
    const defaultPort = scheme !== undefined ? DEFAULT_PORT_BY_SCHEME[scheme] : undefined;
    if (defaultPort !== undefined && host.endsWith(`:${defaultPort}`)) {
      host = host.slice(0, host.length - defaultPort.length - 1);
    }
    return `${host}${u.slice(slash)}`;
  }
  return u;
}

/**
 * Is a canonicalized identity a real `host/path` one, and therefore capable of naming the
 * SAME repository from two different machines?
 *
 * A remote does not have to be a URL. `git remote add origin ../template.git` and the
 * `insteadOf` shorthands (`gh:acme/x`) are both legal, and both canonicalize to a short
 * token that says nothing about which repository is meant: two unrelated projects each
 * cloned from a sibling `../template.git` derive the identical string and would match.
 * That is the same class of coincidence as the `basename:` fallback, so it gets the same
 * answer. The test is a POSITIVE one ("this really is a host and a path") rather than a
 * list of known-bad prefixes, because a prefix list only refuses the shapes someone
 * thought of.
 */
export function isPortableRepoIdentity(identity: string): boolean {
  if (identity.startsWith("basename:")) return false;
  const slash = identity.indexOf("/");
  if (slash <= 0 || slash === identity.length - 1) return false;
  const host = identity.slice(0, slash);
  // A dotted label (or a bracketed IPv6 literal), optionally with a port, is what
  // separates a routable host from `..`, `gh`, or a bare drive letter.
  return /^(?:[a-z0-9-]+(?:\.[a-z0-9-]+)+|\[[0-9a-f:]+\])(?::\d+)?$/i.test(host);
}

/**
 * Is a canonicalized identity a real `host/path` one, and therefore capable of naming the
 * SAME repository from two different machines?
 *
 * A remote does not have to be a URL. `git remote add origin ../template.git` and the
 * `insteadOf` shorthands (`gh:acme/x`) are both legal, and both canonicalize to a short
 * token that says nothing about which repository is meant: two unrelated projects each
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
  // ONE portability test, on the STAMPED side, and it covers both sides: the comparison
  // below is a strict string equality, so a match forces the derived identity to be the
  // SAME string and therefore the same verdict here. An earlier cut tested each side
  // separately, which made each of the two lines individually deletable with the suite
  // still green: two guards doing one job pin nothing.
  //
  // A non-host/path identity (the `basename:` fallback, a `../template.git` relative
  // remote, an `insteadOf` shorthand) is a coincidence two unrelated repos share, so an
  // equal pair of them is still a refusal. Provenance only.
  if (!isPortableRepoIdentity(binding.repoIdentity)) return false;
  const derived = deriveRepoIdentity(root);
  // No git working tree here means no portable identity to compare against, so the
  // portable arm cannot answer and refuses. Without this a stamped anchor would claim
  // every non-git root on the machine.
  if (derived === null) return false;
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
