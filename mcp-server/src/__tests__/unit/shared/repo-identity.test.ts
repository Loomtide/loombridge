/**
 * Portable evidence binding: the repo-identity derivation and the manifest matching rule.
 *
 * The scenario the whole feature exists for: a dev stamps a test run on their machine,
 * COMMITS the trio, and CI (a different absolute path, a DIFFERENT REMOTE SPELLING, the
 * same repository) grades it. The scenarios it must never enable: a trio from a
 * different repository grading here, and a directory-name coincidence counting as
 * identity (the adversarial review demonstrated both against the first cut).
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  deriveRepoIdentity,
  findGitToplevel,
  normalizeRepoUrl,
  readOriginUrl,
} from "../../../shared/repo-identity.js";
import { projectBindingMatches } from "../../../capabilities/tests/test-results-manifest.js";

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "loombridge-repoid-"));
}

async function plantRepo(root: string, origin?: string): Promise<void> {
  await fs.mkdir(path.join(root, ".git"), { recursive: true });
  const config = origin
    ? `[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = ${origin}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`
    : `[core]\n\trepositoryformatversion = 0\n`;
  await fs.writeFile(path.join(root, ".git", "config"), config);
}

test("normalizeRepoUrl canonicalizes the SPELLING FAMILY of one repo to host/path", () => {
  const canonical = "github.com/Loomtide/game";
  for (const spelling of [
    "git@github.com:Loomtide/game.git", // scp-style ssh (the dev machine)
    "https://github.com/Loomtide/game", // what actions/checkout writes (CI)
    "https://github.com/Loomtide/game.git/",
    "ssh://git@GitHub.com:22/Loomtide/game.git",
    '"https://github.com/Loomtide/game.git"', // quoted config value
  ]) {
    assert.equal(normalizeRepoUrl(spelling), canonical, spelling);
  }
});

test("deriveRepoIdentity: canonical origin + repo-relative project path, '.' at the toplevel", async () => {
  const repo = await tmpDir();
  try {
    await plantRepo(repo, "git@github.com:Loomtide/game.git");
    assert.deepEqual(deriveRepoIdentity(repo), {
      repoIdentity: "github.com/Loomtide/game",
      projectPath: ".",
    });

    const nested = path.join(repo, "unity", "MyGame");
    await fs.mkdir(nested, { recursive: true });
    assert.deepEqual(deriveRepoIdentity(nested), {
      repoIdentity: "github.com/Loomtide/game",
      projectPath: "unity/MyGame",
    });
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});

test("deriveRepoIdentity: no origin yields the basename PROVENANCE marker; no git yields null", async () => {
  const repo = await tmpDir();
  try {
    await plantRepo(repo);
    assert.equal(deriveRepoIdentity(repo)?.repoIdentity, `basename:${path.basename(repo)}`);

    const bare = await tmpDir();
    try {
      assert.equal(deriveRepoIdentity(bare), null, "outside any git tree there is no portable identity");
      assert.equal(findGitToplevel(bare), null);
    } finally {
      await fs.rm(bare, { recursive: true, force: true });
    }
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});

test("readOriginUrl: an INDENTED following section cannot leak its url into origin, and last-url wins", async () => {
  const repo = await tmpDir();
  try {
    // The adversarial shape: origin section empty, upstream section indented so a naive
    // column-0 terminator swallows it into origin.
    await fs.mkdir(path.join(repo, ".git"), { recursive: true });
    await fs.writeFile(
      path.join(repo, ".git", "config"),
      `[remote "origin"]\n  [remote "upstream"]\n\turl = https://github.com/UPSTREAM/repo.git\n`,
    );
    assert.equal(readOriginUrl(repo), null, "upstream's url must never become origin's");

    // git precedence: last value wins.
    await fs.writeFile(
      path.join(repo, ".git", "config"),
      `[remote "origin"]\n\turl = https://github.com/OLD/repo.git\n\turl = https://github.com/NEW/repo.git\n`,
    );
    assert.equal(readOriginUrl(repo), "github.com/NEW/repo");

    const missing = await tmpDir();
    try {
      assert.equal(readOriginUrl(missing), null, "no .git reads as no origin, never a throw");
    } finally {
      await fs.rm(missing, { recursive: true, force: true });
    }
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});

test("projectBindingMatches: ssh dev + https CI of the SAME repo matches; different repo refuses", async () => {
  const devCheckout = await tmpDir();
  const ciCheckout = await tmpDir();
  const otherRepo = await tmpDir();
  try {
    await plantRepo(devCheckout, "git@github.com:Loomtide/game.git"); // ssh clone (dev)
    await plantRepo(ciCheckout, "https://github.com/Loomtide/game"); // https checkout (CI)
    await plantRepo(otherRepo, "https://github.com/Loomtide/other-game.git");

    const stamp = { projectRoot: devCheckout, ...deriveRepoIdentity(devCheckout)! };

    assert.equal(projectBindingMatches(stamp, devCheckout), true, "absolute rule on the origin machine");
    assert.equal(
      projectBindingMatches(stamp, ciCheckout),
      true,
      "THE FEATURE: ssh spelling at dev, https at CI, same repo: matches portably",
    );
    assert.equal(projectBindingMatches(stamp, otherRepo), false, "a different repository never claims the trio");

    // Legacy manifest (no portable stamp): absolute path is the only rule.
    const legacy = { projectRoot: devCheckout };
    assert.equal(projectBindingMatches(legacy, devCheckout), true);
    assert.equal(projectBindingMatches(legacy, ciCheckout), false, "legacy stays machine-bound (re-stamp to port)");
  } finally {
    for (const d of [devCheckout, ciCheckout, otherRepo]) await fs.rm(d, { recursive: true, force: true });
  }
});

test("the basename fallback NEVER matches portably (two unrelated repos share a name), and projectPath is required", async () => {
  const alice = await tmpDir();
  const bobParent = await tmpDir();
  try {
    // Two genuinely different no-origin repos with the SAME directory name.
    const name = "demo-platformer";
    const aliceRepo = path.join(alice, name);
    const bobRepo = path.join(bobParent, name);
    await fs.mkdir(aliceRepo, { recursive: true });
    await fs.mkdir(bobRepo, { recursive: true });
    await plantRepo(aliceRepo);
    await plantRepo(bobRepo);

    const stamp = { projectRoot: aliceRepo, ...deriveRepoIdentity(aliceRepo)! };
    assert.ok(stamp.repoIdentity.startsWith("basename:"), "the fixture really is the fallback case");
    assert.equal(
      projectBindingMatches(stamp, bobRepo),
      false,
      "a directory-name coincidence is not an identity: basename never matches portably",
    );
    assert.equal(projectBindingMatches(stamp, aliceRepo), true, "the origin machine still matches, by the absolute rule");

    // F9: an absent projectPath is a refusal in the PREDICATE itself, never a default,
    // even though the on-disk validator also enforces the pairing. The check must run
    // through the PORTABLE arm, so the roots differ (same-root would legitimately match
    // by the absolute rule before the portable fields are ever consulted).
    await plantRepo(aliceRepo, "https://github.com/Loomtide/game.git");
    await plantRepo(bobRepo, "https://github.com/Loomtide/game.git");
    const missingPath = { projectRoot: aliceRepo, repoIdentity: "github.com/Loomtide/game" };
    assert.equal(
      projectBindingMatches(missingPath, bobRepo),
      false,
      "repoIdentity without projectPath refuses (the falsy-field anti-pattern, closed at the predicate)",
    );
    assert.equal(
      projectBindingMatches({ ...missingPath, projectPath: "." }, bobRepo),
      true,
      "control: with the pair complete, the same-origin checkout matches portably",
    );

    // Monorepo separation: same repo, different position, refuses.
    const nestedStamp = {
      projectRoot: path.join(aliceRepo, "games", "a"),
      repoIdentity: "github.com/Loomtide/game",
      projectPath: "games/a",
    };
    const otherPosition = path.join(aliceRepo, "games", "b");
    await fs.mkdir(otherPosition, { recursive: true });
    assert.equal(projectBindingMatches(nestedStamp, otherPosition), false, "monorepo siblings stay distinct");
  } finally {
    for (const d of [alice, bobParent]) await fs.rm(d, { recursive: true, force: true });
  }
});
