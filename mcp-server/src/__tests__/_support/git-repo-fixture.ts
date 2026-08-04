/**
 * The git-checkout PLANTER for portable-binding tests.
 *
 * `deriveRepoIdentity` reads the filesystem (a `.git` marker plus the config's origin
 * url) and never spawns git, so a fixture only has to plant those two files. That is
 * also the point: the tests exercise the production derivation, not a stubbed one.
 *
 * Omitting `origin` plants the no-remote repo, whose identity is the `basename:` marker
 * that must NEVER match portably. Every LITMUS for the directory-name coincidence is
 * built from that shape.
 */

import fs from "node:fs/promises";
import path from "node:path";

export async function plantGitRepo(root: string, origin?: string): Promise<string> {
  await fs.mkdir(path.join(root, ".git"), { recursive: true });
  const config = origin
    ? `[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = ${origin}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`
    : `[core]\n\trepositoryformatversion = 0\n`;
  await fs.writeFile(path.join(root, ".git", "config"), config);
  return root;
}
