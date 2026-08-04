/**
 * `loombridge update`'s CLI half: install-channel classification, version comparison, and
 * the self-update decision table.
 *
 * The failures these close, in order of how expensive they would be:
 *
 *  1. **"Already up to date" when nothing was compared.** An unreachable registry must
 *     report UNKNOWN, not current. This is the same false-green shape the verification
 *     gates refuse, at the install layer.
 *  2. **Offering to `npm install -g` over a developer's checkout.** `npm link` puts a
 *     symlink in the global node_modules, so an unresolved path classifies a source tree as
 *     a registry install, and self-updating would replace the working tree with a published
 *     build. The classifier resolves symlinks FIRST; the LITMUS below proves it.
 *  3. **Lexical version comparison.** "0.10.0" < "0.9.0" as strings, so a naive compare
 *     tells a user on 0.9.0 that they are ahead of 0.10.0 and they never update.
 */

import assert from "node:assert/strict";
import test, { describe } from "node:test";

import {
  type InstallMethodProbe,
  classifyCliInstall,
  manualUpdateInstruction,
  selfUpdateCommandFor,
} from "../../../../capabilities/setup/cli-install-method.js";
import {
  compareVersions,
  executeSelfUpdate,
  isValidVersionSpec,
  planSelfUpdate,
} from "../../../../capabilities/setup/cli-self-update.js";

/** A probe over an in-memory path set, so classification is tested without touching disk. */
function probeFor(opts: {
  home: string;
  links?: Record<string, string>;
  present?: string[];
}): InstallMethodProbe {
  return {
    exists: (p) => (opts.present ?? []).includes(p),
    realpath: (p) => opts.links?.[p] ?? p,
    homedir: () => opts.home,
  };
}

describe("compareVersions", () => {
  test("orders versions NUMERICALLY per component", () => {
    assert.equal(compareVersions("0.3.0", "0.2.0"), 1);
    assert.equal(compareVersions("0.2.0", "0.3.0"), -1);
    assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
    assert.equal(compareVersions("1.2.3", "1.2"), 1, "a missing component reads as 0");
  });

  test("LITMUS: 0.10.0 is NEWER than 0.9.0 (a string compare gets this backwards)", () => {
    assert.ok("0.10.0" < "0.9.0", "precondition: lexically, 0.10.0 sorts BEFORE 0.9.0");
    assert.equal(compareVersions("0.10.0", "0.9.0"), 1, "numerically 0.10.0 must be newer");
    assert.equal(compareVersions("0.9.0", "0.10.0"), -1);
  });

  test("a release outranks a prerelease of the same core", () => {
    assert.equal(compareVersions("1.0.0", "1.0.0-rc.1"), 1);
    assert.equal(compareVersions("1.0.0-rc.1", "1.0.0"), -1);
    assert.equal(compareVersions("1.0.0-rc.2", "1.0.0-rc.1"), 1);
  });

  test("an unparseable version returns null rather than guessing a direction", () => {
    assert.equal(compareVersions("unknown", "1.0.0"), null);
    assert.equal(compareVersions("1.0.0", ""), null);
  });

  test("build metadata is IGNORED for precedence, per semver", () => {
    // Without stripping `+...`, `0.3.0+ci.12` parses as core [0,3,0,12] and reports itself
    // as NEWER than the published 0.3.0, so that build would refuse to update forever.
    assert.equal(compareVersions("0.3.0+ci.12", "0.3.0"), 0);
    assert.equal(compareVersions("0.3.0+ci.12", "0.4.0"), -1);
  });
});

describe("isValidVersionSpec", () => {
  test("accepts real versions and rejects anything that would split a command", () => {
    for (const good of ["0.2.0", "v1.0.0", "1.0.0-rc.1", "1.0.0+build.5"]) {
      assert.equal(isValidVersionSpec(good), true, good);
    }
    // The pin is interpolated into a command string that is later split on spaces.
    for (const bad of ["1.0.0 evil-pkg", "--check", "", "1.0.0;rm -rf /", "$(whoami)"]) {
      assert.equal(isValidVersionSpec(bad), false, bad);
    }
  });
});

describe("classifyCliInstall", () => {
  const home = "/home/dev";

  test("a resolved node_modules path is the npm channel", () => {
    const root = "/usr/local/lib/node_modules/loombridge";
    const info = classifyCliInstall(root, probeFor({ home }));
    assert.equal(info.method, "npm-package");
    assert.equal(selfUpdateCommandFor(info.method), "npm install -g loombridge@latest");
  });

  test("the frozen runtime is detected BEFORE any other rule", () => {
    const root = `${home}/.loombridge/runtime`;
    const info = classifyCliInstall(root, probeFor({ home }));
    assert.equal(info.method, "frozen-runtime");
    assert.equal(selfUpdateCommandFor(info.method), null, "a frozen runtime is never self-updated");
  });

  test("LITMUS: an npm-linked checkout resolves to its source tree, NOT the npm channel", () => {
    // What `npm link` really looks like: a symlink in the global node_modules whose target is
    // the developer's clone. Judging the UNRESOLVED path would classify this as npm-package
    // and offer to overwrite the clone with a published build.
    const linkPath = "/usr/local/lib/node_modules/loombridge";
    const clone = "/home/dev/Projects/loombridge/mcp-server";
    const probe = probeFor({
      home,
      links: { [linkPath]: clone },
      present: [`${clone}/src`, `${clone}/tsconfig.json`],
    });

    const info = classifyCliInstall(linkPath, probe);
    assert.equal(info.method, "dev-clone", "a linked clone must classify as a source checkout");
    assert.equal(info.resolvedRoot, clone);
    assert.equal(selfUpdateCommandFor(info.method), null, "a checkout is never self-updated");

    // The proof that the symlink resolution is what did it: without the link, the same path
    // classifies as the npm channel.
    const unlinked = classifyCliInstall(linkPath, probeFor({ home }));
    assert.equal(unlinked.method, "npm-package");
  });

  test("an unrecognized layout is unknown, and instructs with every channel", () => {
    const info = classifyCliInstall("/opt/weird/loombridge", probeFor({ home }));
    assert.equal(info.method, "unknown");
    const lines = manualUpdateInstruction(info.method, "Loomtide/loombridge").join("\n");
    assert.match(lines, /npm install -g loombridge@latest/);
    assert.match(lines, /install\.sh/);
  });

  test("`node_modules` must be a whole path segment, never a substring", () => {
    const info = classifyCliInstall("/home/dev/my_node_modules_backup/loombridge", probeFor({ home }));
    assert.notEqual(info.method, "npm-package");
  });

  test("REGRESSION: a project-local install is npm-local, NOT globally self-updatable", () => {
    // A team adds loombridge as a devDependency and runs `npx loombridge update`. Classifying
    // this as a global install makes the CLI run `npm install -g`, which writes a DIFFERENT
    // copy, prints "CLI updated", and stops the run. The local copy never changes, so the
    // next run repeats it forever while reporting success every time.
    const projectRoot = "/home/dev/work/MyGame";
    const info = classifyCliInstall(`${projectRoot}/node_modules/loombridge`, probeFor({
      home,
      present: [`${projectRoot}/package.json`],
    }));
    assert.equal(info.method, "npm-local");
    assert.equal(selfUpdateCommandFor(info.method), null, "a local copy is never globally updated");

    // LITMUS: the SAME path with no owning package.json is a global install, so the rule is
    // the package.json probe and not something incidental about the path shape.
    const global = classifyCliInstall(`${projectRoot}/node_modules/loombridge`, probeFor({ home }));
    assert.equal(global.method, "npm-package");
  });

  test("REGRESSION: an npx cache entry is npm-local", () => {
    const info = classifyCliInstall(`${home}/.npm/_npx/8fa1b/node_modules/loombridge`, probeFor({ home }));
    assert.equal(info.method, "npm-local", "an ephemeral npx entry is not updated in place");
    assert.equal(selfUpdateCommandFor(info.method), null);
  });

  test("a real global prefix stays self-updatable (nvm, homebrew, /usr/local)", () => {
    for (const root of [
      "/usr/local/lib/node_modules/loombridge",
      `${home}/.nvm/versions/node/v20.11.0/lib/node_modules/loombridge`,
      "/opt/homebrew/lib/node_modules/loombridge",
    ]) {
      assert.equal(classifyCliInstall(root, probeFor({ home })).method, "npm-package", root);
    }
  });
});

describe("planSelfUpdate", () => {
  const npm = { method: "npm-package" as const, current: "0.2.0" };

  test("a newer published version on the npm channel plans an install", () => {
    const plan = planSelfUpdate({ ...npm, latest: "0.3.0" });
    assert.equal(plan.action, "self-update");
    assert.equal(plan.command, "npm install -g loombridge@latest");
  });

  test("a newer published version on a manual channel INSTRUCTS instead", () => {
    const plan = planSelfUpdate({ method: "dev-clone", current: "0.2.0", latest: "0.3.0" });
    assert.equal(plan.action, "instruct");
    assert.equal(plan.command, null, "nothing may be run on a developer's checkout");
  });

  test("matching versions are already-current", () => {
    assert.equal(planSelfUpdate({ ...npm, latest: "0.2.0" }).action, "already-current");
  });

  test("a local build ahead of the registry is reported, never downgraded", () => {
    const plan = planSelfUpdate({ ...npm, latest: "0.1.0" });
    assert.equal(plan.action, "ahead-of-registry");
    assert.equal(plan.command, null);
  });

  test("REFUSAL: an unreachable registry is check-failed, NEVER already-current", () => {
    const plan = planSelfUpdate({ ...npm, latest: null });
    assert.equal(plan.action, "check-failed", "a lookup that answered nothing cannot report current");
    assert.equal(plan.latest, null, "the plan must not invent a version it did not read");
    assert.match(plan.message, /UNKNOWN/);
  });

  test("REFUSAL: an uncomparable version pair is check-failed, not a silent pass", () => {
    const plan = planSelfUpdate({ method: "npm-package", current: "unknown", latest: "0.3.0" });
    assert.equal(plan.action, "check-failed");
  });

  test("an explicit --version pin installs that version, including a downgrade", () => {
    const plan = planSelfUpdate({ ...npm, latest: "0.3.0", pinnedVersion: "0.1.5" });
    assert.equal(plan.action, "self-update");
    assert.equal(plan.command, "npm install -g loombridge@0.1.5");
  });

  test("REGRESSION: a pin equal to the running version does NOT reinstall", () => {
    // The pin branch used to run before any comparison, so `update --version 0.2.0` while on
    // 0.2.0 reinstalled, printed "CLI updated", and (because a self-update always ends the
    // run) left the bridge phase permanently unreachable. A CI job pinning for reproducibility
    // could therefore never reconcile a bridge, on any run, while every run reported success.
    const plan = planSelfUpdate({ ...npm, latest: "0.3.0", pinnedVersion: "0.2.0" });
    assert.equal(plan.action, "already-current", "nothing changed, so nothing may be actuated");
    assert.equal(plan.command, null);
  });

  test("a pin equal to the running version matches on VALUE, not string identity", () => {
    // `v0.2.0` and `0.2.0` are the same version; reinstalling on a formatting difference would
    // reintroduce the stranded-bridge loop above.
    assert.equal(planSelfUpdate({ ...npm, latest: "0.3.0", pinnedVersion: "v0.2.0" }).action, "already-current");
  });

  test("a pin on a manual channel still refuses to run anything", () => {
    const plan = planSelfUpdate({
      method: "frozen-runtime",
      current: "0.2.0",
      latest: "0.3.0",
      pinnedVersion: "0.1.5",
    });
    assert.equal(plan.action, "instruct");
    assert.equal(plan.command, null);
  });
});

describe("executeSelfUpdate", () => {
  test("splits the command and reports success only on exit 0", () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const ok = executeSelfUpdate("npm install -g loombridge@latest", (cmd, args) => {
      calls.push({ cmd, args });
      return { status: 0 };
    });
    assert.equal(ok, true);
    assert.deepEqual(calls, [
      { cmd: "npm", args: ["install", "-g", "loombridge@latest"] },
    ]);
  });

  test("a non-zero exit is a FAILURE, so the caller never claims the CLI was updated", () => {
    assert.equal(
      executeSelfUpdate("npm install -g loombridge@latest", () => ({ status: 1 })),
      false,
    );
  });
});
