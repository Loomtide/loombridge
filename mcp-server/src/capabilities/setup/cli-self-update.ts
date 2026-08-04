/**
 * The CLI half of `loombridge update`: is a newer `loombridge` published, and can this
 * install be updated in place?
 *
 * Two refusal rules carry the weight here, both instances of the repo's refuse-on-absent
 * discipline applied to a version check:
 *
 *  1. **An unreachable registry is never "up to date".** A failed lookup resolves to
 *     `check-failed`, which says so out loud. Reporting "already current" when nothing was
 *     compared is exactly the shape of false green this repo exists to refuse, and it is the
 *     cheap version of the same mistake a verification gate would be making.
 *  2. **A self-update ENDS the run.** The bridge tarball that `update` delivers to a Unity
 *     project is bundled inside the CLI, so once the CLI on disk has been replaced, the
 *     bundle this process already resolved is the OLD one. Reconciling a project after
 *     self-updating would install the previous bridge and report success. The flow therefore
 *     stops and asks for a re-run, rather than quietly delivering a stale bridge.
 *
 * Version comparison is numeric per component, not lexical: `0.10.0` is NEWER than `0.9.0`,
 * and a string compare gets that backwards. That case has a LITMUS in the tests.
 */

import { spawnSync } from "node:child_process";

import { childStepStdio, forwardCapturedOutput } from "../../shared/child-stdio.js";
import { NPM_PACKAGE_NAME, type CliInstallMethod, selfUpdateCommandFor } from "./cli-install-method.js";

/**
 * A version string safe to interpolate into an install command. Rejects whitespace, which
 * would re-split into EXTRA install targets downstream (`executeSelfUpdate` splits on spaces),
 * and anything outside semver's character set.
 */
export function isValidVersionSpec(v: string): boolean {
  // Must START with a digit (after an optional `v`), so a stray flag like `--check` can never
  // be read as a version even if it reaches here past the argv-level guard.
  return /^v?[0-9][0-9A-Za-z.\-+]*$/.test(v);
}

/** Split a semver-ish string into numeric core parts plus an optional prerelease tail. */
function parseVersion(v: string): { core: number[]; prerelease: string[] } | null {
  // Build metadata is ignored for precedence per semver. Stripping it also stops `0.3.0+ci.12`
  // from parsing as core [0,3,0,12] and reporting itself as newer than the published 0.3.0,
  // which would leave that build permanently refusing to update.
  const trimmed = v.trim().replace(/^v/, "").split("+")[0] ?? "";
  if (trimmed.length === 0) return null;
  const [corePart, ...rest] = trimmed.split("-");
  const core = corePart.split(".").map((n) => Number.parseInt(n, 10));
  if (core.length === 0 || core.some((n) => !Number.isFinite(n))) return null;
  const prerelease = rest.length > 0 ? rest.join("-").split(".") : [];
  return { core, prerelease };
}

/**
 * Compare two versions: -1 if `a` is older, 0 if equal, 1 if `a` is newer.
 * Returns `null` when either side is unparseable, so the caller can refuse rather than
 * guess a direction.
 */
export function compareVersions(a: string, b: string): number | null {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return null;

  const width = Math.max(pa.core.length, pb.core.length);
  for (let i = 0; i < width; i += 1) {
    const na = pa.core[i] ?? 0;
    const nb = pb.core[i] ?? 0;
    if (na !== nb) return na > nb ? 1 : -1;
  }

  // A release outranks any prerelease of the same core (1.0.0 > 1.0.0-rc.1).
  if (pa.prerelease.length === 0 && pb.prerelease.length > 0) return 1;
  if (pa.prerelease.length > 0 && pb.prerelease.length === 0) return -1;

  const preWidth = Math.max(pa.prerelease.length, pb.prerelease.length);
  for (let i = 0; i < preWidth; i += 1) {
    const ia = pa.prerelease[i];
    const ib = pb.prerelease[i];
    if (ia === undefined) return -1;
    if (ib === undefined) return 1;
    const numA = Number.parseInt(ia, 10);
    const numB = Number.parseInt(ib, 10);
    const bothNumeric = Number.isFinite(numA) && Number.isFinite(numB) && `${numA}` === ia && `${numB}` === ib;
    if (bothNumeric) {
      if (numA !== numB) return numA > numB ? 1 : -1;
    } else if (ia !== ib) {
      return ia > ib ? 1 : -1;
    }
  }
  return 0;
}

/** Look up the latest published version. Returns `null` on ANY failure: offline, timeout, unpublished. */
export type LatestVersionLookup = () => string | null;

/**
 * On Windows the npm launcher is `npm.cmd`, which `spawnSync` cannot resolve without a shell:
 * it returns ENOENT with `status: null`. Every lookup would then report "could not reach the
 * npm registry" on a machine that is online with npm installed, and every install would report
 * a failure that never ran. The README promises Windows in any shell, so this is load-bearing.
 */
export const npmSpawnOptions = { shell: process.platform === "win32" } as const;

export function npmRegistryLookup(timeoutMs = 8000): LatestVersionLookup {
  return () => {
    try {
      const result = spawnSync("npm", ["view", NPM_PACKAGE_NAME, "version"], {
        encoding: "utf8",
        timeout: timeoutMs,
        ...npmSpawnOptions,
        // Never inherit: this runs inside a CLI whose stdout may be a structured channel,
        // and the value is parsed, not displayed.
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (result.status !== 0) return null;
      const out = (result.stdout ?? "").trim();
      return out.length > 0 ? out : null;
    } catch {
      return null;
    }
  };
}

export type SelfUpdateAction =
  /** The registry could not be reached or the answer was unusable. NOT a pass. */
  | "check-failed"
  /** Running the newest published version. */
  | "already-current"
  /** Running something newer than the registry (a dev build or an unreleased tag). */
  | "ahead-of-registry"
  /** A newer version exists and this channel can install it. */
  | "self-update"
  /** A newer version exists but this channel must be updated by hand. */
  | "instruct";

export interface SelfUpdatePlan {
  action: SelfUpdateAction;
  method: CliInstallMethod;
  current: string;
  /** `null` whenever the lookup failed: the plan never invents a version it did not read. */
  latest: string | null;
  /** The command to run, present only for `self-update`. */
  command: string | null;
  /** One-line explanation, always present. */
  message: string;
}

/**
 * Decide what to do about the CLI itself. PURE: the registry answer and the install method
 * are both inputs, so every branch of this table is testable without a network or an install.
 *
 * `pinnedVersion` (from `--version`) targets an exact release instead of `latest`; it forces
 * the self-update branch even when the pin is older, because pinning downward is a deliberate
 * operator action (a rollback), not a drift.
 */
export function planSelfUpdate(params: {
  method: CliInstallMethod;
  current: string;
  latest: string | null;
  pinnedVersion?: string | undefined;
}): SelfUpdatePlan {
  const { method, current, latest, pinnedVersion } = params;

  if (pinnedVersion && pinnedVersion.length > 0) {
    // A pin that ALREADY matches the running version must not actuate. Reinstalling would
    // print "CLI updated", and because a self-update always ends the run, the bridge phase
    // would never execute. A CI job that pins for reproducibility (`update --version 0.2.0`
    // while on 0.2.0) would then be unable to reconcile a bridge on any run, forever, while
    // every run reported success. Nothing changed, so this is `already-current`.
    if (compareVersions(current, pinnedVersion) === 0) {
      return {
        action: "already-current",
        method,
        current,
        latest,
        command: null,
        message: `already on the pinned version (${current})`,
      };
    }
    const command = selfUpdateCommandFor(method, pinnedVersion);
    if (command) {
      return {
        action: "self-update",
        method,
        current,
        latest,
        command,
        message: `pinned to ${pinnedVersion} (currently ${current})`,
      };
    }
    return {
      action: "instruct",
      method,
      current,
      latest,
      command: null,
      message: `pinned to ${pinnedVersion}, but this install channel cannot be updated automatically`,
    };
  }

  if (latest === null) {
    return {
      action: "check-failed",
      method,
      current,
      latest: null,
      command: null,
      message: `could not reach the npm registry, so "up to date" is UNKNOWN (running ${current})`,
    };
  }

  const cmp = compareVersions(current, latest);
  if (cmp === null) {
    return {
      action: "check-failed",
      method,
      current,
      latest,
      command: null,
      message: `could not compare the running version (${current}) with the published one (${latest})`,
    };
  }
  if (cmp === 0) {
    return {
      action: "already-current",
      method,
      current,
      latest,
      command: null,
      message: `already on the latest published version (${current})`,
    };
  }
  if (cmp > 0) {
    return {
      action: "ahead-of-registry",
      method,
      current,
      latest,
      command: null,
      message: `running ${current}, newer than the latest published version (${latest})`,
    };
  }

  const command = selfUpdateCommandFor(method);
  if (command) {
    return {
      action: "self-update",
      method,
      current,
      latest,
      command,
      message: `a newer loombridge is published: ${current} -> ${latest}`,
    };
  }
  return {
    action: "instruct",
    method,
    current,
    latest,
    command: null,
    message: `a newer loombridge is published: ${current} -> ${latest}, but this channel updates by hand`,
  };
}

/**
 * Run a planned self-update. Returns true only when the install command exited 0.
 *
 * `npm install -g` is slow enough that its output is worth streaming, so this uses the
 * shared child-stdio helper rather than `inherit`: under the test runner fd 1 is a
 * V8-serialized result channel, and handing it to a grandchild corrupts the stream.
 */
export function executeSelfUpdate(
  command: string,
  exec: (cmd: string, args: string[]) => { status: number | null; stdout?: string | Buffer | null; stderr?: string | Buffer | null } = (
    cmd,
    args,
  ) => spawnSync(cmd, args, { ...childStepStdio(), ...npmSpawnOptions }),
): boolean {
  const parts = command.split(" ").filter((p) => p.length > 0);
  const [cmd, ...args] = parts;
  if (!cmd) return false;
  const result = exec(cmd, args);
  forwardCapturedOutput(result);
  return result.status === 0;
}
