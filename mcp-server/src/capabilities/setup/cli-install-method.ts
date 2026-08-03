/**
 * How was the running `loombridge` CLI installed?
 *
 * `loombridge update` has to answer this before it can offer to update the CLI itself.
 * Only ONE of the install channels can be self-updated safely:
 *
 *  - `npm-package`    installed from the registry (`npm install -g loombridge`).
 *                     Self-updatable: one portable command, no assumptions about the
 *                     shell or the node version manager.
 *  - `frozen-runtime` delivered by `install.sh`, which copies a built `dist/` into
 *                     `~/.loombridge/runtime`. A `git pull` does NOT update it; re-running
 *                     the installer does. Instruct, never self-run.
 *  - `dev-clone`      running out of a source checkout (`npm link`, `npm run build`, tsx).
 *                     `npm install -g` here would REPLACE a developer's working tree with a
 *                     published build, which is destructive and never what they meant.
 *                     Instruct (`git pull && npm run build`).
 *  - `unknown`        anything else. Instruct with every option rather than guess: running
 *                     an install command against an unidentified layout is the one outcome
 *                     worse than printing a hint.
 *
 * The classification is a pure function of the RESOLVED package root plus a few filesystem
 * probes, so the whole table is unit-testable without installing anything. Symlinks are
 * resolved first on purpose: `npm link` puts a symlink inside the global `node_modules`, so
 * an unresolved path would classify a developer's checkout as a registry install and offer
 * to overwrite it.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** The published package name. Kept in one place so the update command cannot drift from it. */
export const NPM_PACKAGE_NAME = "loombridge";

export type CliInstallMethod = "npm-package" | "frozen-runtime" | "dev-clone" | "unknown";

export interface InstallMethodProbe {
  exists(p: string): boolean;
  /** Resolve symlinks. MUST fall back to the input path when the target is unreadable. */
  realpath(p: string): string;
  homedir(): string;
}

export const nodeProbe: InstallMethodProbe = {
  exists: (p) => fs.existsSync(p),
  realpath: (p) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return p;
    }
  },
  homedir: () => os.homedir(),
};

export interface CliInstallInfo {
  method: CliInstallMethod;
  /** The package root with symlinks resolved: what the classification actually judged. */
  resolvedRoot: string;
  /** Why this classification was reached, in one human-readable clause. */
  reason: string;
}

/** Does `p` contain `segment` as a whole path segment (never a substring of a longer name)? */
function hasPathSegment(p: string, segment: string): boolean {
  return p.split(path.sep).includes(segment);
}

/**
 * Classify how the CLI at `packageRootPath` was installed.
 *
 * Order matters, and each rule is checked BEFORE the more permissive one below it:
 *  1. the frozen runtime directory, which is also allowed to sit under a `node_modules`
 *     one day without becoming self-updatable;
 *  2. a real `node_modules` segment after symlink resolution: a registry install;
 *  3. source-tree markers (`src/` + `tsconfig.json`): a developer's checkout;
 *  4. unknown.
 */
export function classifyCliInstall(
  packageRootPath: string,
  probe: InstallMethodProbe = nodeProbe,
): CliInstallInfo {
  const resolvedRoot = probe.realpath(packageRootPath);

  const runtimeDir = path.join(probe.homedir(), ".loombridge", "runtime");
  if (resolvedRoot === runtimeDir || resolvedRoot.startsWith(runtimeDir + path.sep)) {
    return {
      method: "frozen-runtime",
      resolvedRoot,
      reason: `running from the frozen runtime at ${runtimeDir} (installed by install.sh)`,
    };
  }

  if (hasPathSegment(resolvedRoot, "node_modules")) {
    return {
      method: "npm-package",
      resolvedRoot,
      reason: "installed from the npm registry (the resolved package root sits under node_modules)",
    };
  }

  const looksLikeSource =
    probe.exists(path.join(resolvedRoot, "src")) && probe.exists(path.join(resolvedRoot, "tsconfig.json"));
  if (looksLikeSource) {
    return {
      method: "dev-clone",
      resolvedRoot,
      reason: "running from a source checkout (src/ and tsconfig.json are present next to the build)",
    };
  }

  return {
    method: "unknown",
    resolvedRoot,
    reason: "the install layout does not match any known channel",
  };
}

/**
 * The command that updates THIS install, or `null` when no command can be run safely on the
 * user's behalf. A `null` here is what turns the flow from "update it" into "tell them how".
 */
export function selfUpdateCommandFor(method: CliInstallMethod, version?: string): string | null {
  if (method !== "npm-package") return null;
  const spec = version && version.length > 0 ? version : "latest";
  return `npm install -g ${NPM_PACKAGE_NAME}@${spec}`;
}

/** The instruction printed when the channel cannot be self-updated. */
export function manualUpdateInstruction(method: CliInstallMethod, releaseRepo: string): string[] {
  switch (method) {
    case "frozen-runtime":
      return [
        "  This CLI came from install.sh (the frozen runtime), which a git pull does not update.",
        `  Re-run the installer to update it:`,
        `    gh release download -R ${releaseRepo} -p install.sh && sh install.sh`,
        `  Or switch to the npm channel:  npm install -g ${NPM_PACKAGE_NAME}`,
      ];
    case "dev-clone":
      return [
        "  This CLI is your source checkout, so it updates from git, never from the registry:",
        "    git pull && (cd mcp-server && npm ci && npm run build)",
        "  (npm link keeps the `loombridge` bin pointed at the rebuilt dist.)",
      ];
    case "npm-package":
      // Only reached when a command could not be built (no resolvable spec).
      return [`  Update with:  npm install -g ${NPM_PACKAGE_NAME}@latest`];
    case "unknown":
    default:
      return [
        "  Could not tell how this CLI was installed, so nothing was run automatically.",
        `  npm channel:      npm install -g ${NPM_PACKAGE_NAME}@latest`,
        `  installer channel: gh release download -R ${releaseRepo} -p install.sh && sh install.sh`,
      ];
  }
}
