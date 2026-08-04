/**
 * Portable evidence binding: the repo-identity derivation and the ONE matching rule every
 * stamped artifact gates on (test results, the frozen feel snapshot, the approved screen
 * layout baseline).
 *
 * The scenario the whole feature exists for: a human stamps evidence on their machine,
 * COMMITS it, and a teammate or CI (a different absolute path, a DIFFERENT REMOTE
 * SPELLING, the same repository) grades it. The scenarios it must never enable: evidence
 * from a different repository grading here, and a directory-name coincidence counting as
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
  isPortableRepoIdentity,
  normalizeRepoUrl,
  projectBindingMatches,
  projectBindingPairError,
  readOriginUrl,
} from "../../../shared/repo-identity.js";
import { plantGitRepo } from "../../_support/git-repo-fixture.js";

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "loombridge-repoid-"));
}

async function plantRepo(root: string, origin?: string): Promise<void> {
  await plantGitRepo(root, origin);
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

test("normalizeRepoUrl keeps a NON-DEFAULT port, and only a non-default one", async () => {
  // Two git services on one host at different ports is an ordinary self-hosted layout.
  // Stripping every port made them the same repository.
  assert.equal(normalizeRepoUrl("ssh://git@git.internal:2222/team/app.git"), "git.internal:2222/team/app");
  assert.notEqual(
    normalizeRepoUrl("ssh://git@git.internal:2222/team/app.git"),
    normalizeRepoUrl("ssh://git@git.internal:2223/team/app.git"),
    "different ports on one host are different services, therefore different repositories",
  );
  // …while the scheme's OWN default is not part of the identity, which is what keeps the
  // ssh-vs-https convergence (the whole point of canonicalization) intact.
  assert.equal(normalizeRepoUrl("ssh://git@github.com:22/Loomtide/game.git"), "github.com/Loomtide/game");
  assert.equal(normalizeRepoUrl("https://github.com:443/Loomtide/game"), "github.com/Loomtide/game");
});

test("A PORT COLLISION is a real refusal: two hosts differing only in port never bind to each other", async () => {
  const a = await tmpDir();
  const b = await tmpDir();
  try {
    await plantRepo(a, "ssh://git@git.internal:2222/team/app.git");
    await plantRepo(b, "ssh://git@git.internal:2223/team/app.git");
    const stamp = { projectRoot: a, ...deriveRepoIdentity(a)! };
    assert.equal(stamp.repoIdentity, "git.internal:2222/team/app");
    assert.equal(
      projectBindingMatches(stamp, b),
      false,
      "port 2222 and port 2223 are two services; an anchor from one must not grade the other",
    );
  } finally {
    for (const d of [a, b]) await fs.rm(d, { recursive: true, force: true });
  }
});

test("isPortableRepoIdentity: only a real host/path identity may bind across machines", () => {
  for (const good of ["github.com/Loomtide/game", "git.internal:2222/team/app", "192.168.1.5/team/app"]) {
    assert.equal(isPortableRepoIdentity(good), true, good);
  }
  for (const bad of [
    "basename:game", // the no-remote fallback
    "../template", // `git remote add origin ../template.git`
    "gh/acme/x", // an `insteadOf` shorthand, canonicalized
    "template", // no path at all
    "localhost/team/app", // a single-label host names a DIFFERENT machine on each machine
    "github.com/", // a host with an empty path
  ]) {
    assert.equal(isPortableRepoIdentity(bad), false, bad);
  }
});

test("A RELATIVE-PATH origin is a coincidence, not an identity: two `../template.git` repos never bind", async () => {
  // `git remote add origin ../template.git` is legal and common for a local template, and
  // it canonicalizes to a token that says nothing about WHICH template. Two unrelated
  // projects derive the identical string, so the predicate must refuse it the same way it
  // refuses `basename:` rather than keying on that one literal prefix.
  const a = await tmpDir();
  const b = await tmpDir();
  try {
    await plantRepo(a, "../template.git");
    await plantRepo(b, "../template.git");
    const stamp = { projectRoot: a, ...deriveRepoIdentity(a)! };
    assert.equal(stamp.repoIdentity, "../template", "the fixture really does produce the colliding token");
    assert.equal(
      projectBindingMatches(stamp, b),
      false,
      "a relative-path origin is a directory-name coincidence with extra steps",
    );
    assert.equal(projectBindingMatches(stamp, a), true, "control: the approving checkout still matches absolutely");

    // The same hole through a config shorthand (`url.<base>.insteadOf`, e.g. `gh:acme/x`).
    const c = await tmpDir();
    const d = await tmpDir();
    try {
      await plantRepo(c, "gh:acme/x");
      await plantRepo(d, "gh:acme/x");
      const shorthand = { projectRoot: c, ...deriveRepoIdentity(c)! };
      assert.equal(
        projectBindingMatches(shorthand, d),
        false,
        "an insteadOf shorthand resolves per-machine; it cannot name one repository across two",
      );
    } finally {
      for (const x of [c, d]) await fs.rm(x, { recursive: true, force: true });
    }
  } finally {
    for (const x of [a, b]) await fs.rm(x, { recursive: true, force: true });
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

test("MIXED sides: a real-origin stamp and a `basename:` root refuse each other, in both directions", async () => {
  // The only pre-existing fixture made BOTH sides `basename:`, so a reader could not tell
  // which side the refusal came from. These two run one real origin against one fallback.
  const withOrigin = await tmpDir();
  const noOrigin = await tmpDir();
  try {
    await plantRepo(withOrigin, "git@github.com:Loomtide/game.git");
    await plantRepo(noOrigin); // no remote: the identity falls back to the directory name
    const realStamp = { projectRoot: withOrigin, ...deriveRepoIdentity(withOrigin)! };
    const fallbackStamp = { projectRoot: noOrigin, ...deriveRepoIdentity(noOrigin)! };
    assert.ok(fallbackStamp.repoIdentity.startsWith("basename:"), "the fixture really is mixed");

    assert.equal(projectBindingMatches(realStamp, noOrigin), false, "a real origin never binds to a no-remote repo");
    assert.equal(projectBindingMatches(fallbackStamp, withOrigin), false, "…and the fallback never binds outward");
  } finally {
    for (const d of [withOrigin, noOrigin]) await fs.rm(d, { recursive: true, force: true });
  }
});

test("a portably-stamped anchor refuses a root that is in NO git tree (there is nothing to derive)", async () => {
  // Without this refusal the portable arm would compare against an underivable pair and
  // a stamped anchor would claim every non-git directory on the machine. The mutation
  // that motivated the test (`derived === null` returning true) survived 4049 tests.
  const repo = await tmpDir();
  const bare = await tmpDir(); // deliberately NOT a git working tree
  try {
    await plantRepo(repo, "git@github.com:Loomtide/game.git");
    const stamp = { projectRoot: repo, ...deriveRepoIdentity(repo)! };
    assert.equal(deriveRepoIdentity(bare), null, "the fixture really is outside any git tree");
    assert.equal(
      projectBindingMatches(stamp, bare),
      false,
      "no git tree, no portable identity: the portable arm cannot answer, so it refuses",
    );
  } finally {
    for (const d of [repo, bare]) await fs.rm(d, { recursive: true, force: true });
  }
});

test("HALF a pair refuses in BOTH directions, including projectPath-without-repoIdentity", () => {
  // The pre-existing case (repoIdentity, no projectPath) is also caught by the final
  // equality, so it passes with or without the guard. The guard's ONLY unique job is this
  // direction, where the identity check would otherwise be handed `undefined`.
  const stamp = { projectRoot: "/nowhere/alice", projectPath: "." };
  assert.equal(
    projectBindingMatches(stamp, "/nowhere/bob"),
    false,
    "a projectPath with no repoIdentity names a position in NO repository: refused, never thrown at",
  );
});

test("projectBindingPairError: absent is fine, HALF is refused, empty strings are refused", () => {
  assert.equal(projectBindingPairError({}), null, "no portable stamp at all: legacy and non-git, allowed");
  assert.equal(
    projectBindingPairError({ repoIdentity: "github.com/Loomtide/game", projectPath: "." }),
    null,
    "the complete pair is the point of the feature",
  );
  assert.match(
    String(projectBindingPairError({ repoIdentity: "github.com/Loomtide/game" })),
    /stamped together/,
    "a repoIdentity with no projectPath claims any position in the repo: refused, never defaulted",
  );
  assert.match(String(projectBindingPairError({ projectPath: "games/a" })), /stamped together/);
  assert.match(String(projectBindingPairError({ repoIdentity: "", projectPath: "." })), /repoIdentity/);
  assert.match(String(projectBindingPairError({ repoIdentity: "x", projectPath: 7 })), /projectPath/);
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
