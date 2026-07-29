/**
 * Portable evidence binding: the repo-identity derivation and the manifest matching rule.
 *
 * The scenario the whole feature exists for: a dev stamps a test run on their machine,
 * COMMITS the trio, and CI (a different absolute path, the same repository) grades it.
 * The scenario it must never enable: a trio from a DIFFERENT repository grading here.
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

test("deriveRepoIdentity: origin URL + repo-relative project path, '.' at the toplevel", async () => {
  const repo = await tmpDir();
  try {
    await plantRepo(repo, "git@github.com:Loomtide/game.git");
    const atRoot = deriveRepoIdentity(repo);
    assert.deepEqual(atRoot, {
      repoIdentity: "git@github.com:Loomtide/game",
      projectPath: ".",
    });

    const nested = path.join(repo, "unity", "MyGame");
    await fs.mkdir(nested, { recursive: true });
    const inside = deriveRepoIdentity(nested);
    assert.deepEqual(inside, {
      repoIdentity: "git@github.com:Loomtide/game",
      projectPath: "unity/MyGame",
    });
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});

test("deriveRepoIdentity: no origin falls back to a STATED basename identity; no git yields null", async () => {
  const repo = await tmpDir();
  try {
    await plantRepo(repo);
    const derived = deriveRepoIdentity(repo);
    assert.equal(derived?.repoIdentity, `basename:${path.basename(repo)}`);

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

test("normalizeRepoUrl converges .git suffix spellings; readOriginUrl survives a missing config", async () => {
  assert.equal(normalizeRepoUrl("https://github.com/x/y.git"), "https://github.com/x/y");
  assert.equal(normalizeRepoUrl("https://github.com/x/y"), "https://github.com/x/y");
  const empty = await tmpDir();
  try {
    assert.equal(readOriginUrl(empty), null, "no .git at all reads as no origin, never a throw");
  } finally {
    await fs.rm(empty, { recursive: true, force: true });
  }
});

test("projectBindingMatches: SAME repo at a DIFFERENT checkout path matches; a DIFFERENT repo refuses", async () => {
  const devCheckout = await tmpDir();
  const ciCheckout = await tmpDir();
  const otherRepo = await tmpDir();
  try {
    await plantRepo(devCheckout, "https://github.com/Loomtide/game.git");
    await plantRepo(ciCheckout, "https://github.com/Loomtide/game"); // same repo, .git-less spelling
    await plantRepo(otherRepo, "https://github.com/Loomtide/other-game.git");

    // The manifest as the dev machine stamped it.
    const stamp = {
      projectRoot: devCheckout,
      ...deriveRepoIdentity(devCheckout)!,
    };

    assert.equal(projectBindingMatches(stamp, devCheckout), true, "absolute rule on the origin machine");
    assert.equal(
      projectBindingMatches(stamp, ciCheckout),
      true,
      "THE FEATURE: same repo, different absolute path (CI), matches portably",
    );
    assert.equal(
      projectBindingMatches(stamp, otherRepo),
      false,
      "a different repository can never claim the trio",
    );

    // Legacy manifest (no portable stamp): absolute path is the only rule.
    const legacy = { projectRoot: devCheckout };
    assert.equal(projectBindingMatches(legacy, devCheckout), true);
    assert.equal(projectBindingMatches(legacy, ciCheckout), false, "legacy stays machine-bound (re-stamp to port)");

    // Monorepo: same repo, different project position: refuses.
    const nestedStamp = {
      projectRoot: path.join(devCheckout, "games", "a"),
      repoIdentity: "https://github.com/Loomtide/game",
      projectPath: "games/a",
    };
    const otherPosition = path.join(ciCheckout, "games", "b");
    await fs.mkdir(otherPosition, { recursive: true });
    assert.equal(
      projectBindingMatches(nestedStamp, otherPosition),
      false,
      "two projects inside one repo stay distinct",
    );
  } finally {
    for (const d of [devCheckout, ciCheckout, otherRepo]) await fs.rm(d, { recursive: true, force: true });
  }
});
