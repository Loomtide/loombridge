/**
 * `loomtide update` — reconcile a project's Loomtide-owned bridge with the bridge
 * that ships with THIS CLI, then run `doctor`.
 *
 * On the default tarball route this is a hash-checked file swap: drop the newer
 * `.tgz`, bump the `file:` line, prune the old one, rewrite `LoomtideInstall.json`
 * (all via the shared installer). Because the resolved copy lives read-only in
 * Unity's `Library/PackageCache`, there is nothing a developer could have edited,
 * so no `--force-bridge` dance — that flag matters only for the `--embedded`
 * fallback (a physical folder someone could have modified).
 *
 * The CLI itself is NOT self-updated (self-running an install is brittle across
 * nvm/volta/asdf/corepack), so we detect-and-instruct: print the single
 * install-or-update command (`curl -fsSL https://get.loomtide.ai | sh`), which
 * is the same command a developer used to install and re-runs to update.
 *
 * Exit codes: 0 up-to-date/updated + healthy · 1 update or health problem ·
 * 2 usage/precondition (e.g. bridge was never installed).
 */

import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";

import { installBridge } from "./install-bridge.js";
import { reconcileAgentSurfaceForUpdate } from "./install-agent.js";
import { run as doctorRun } from "./doctor.js";
import {
  METADATA_RELPATH,
  PKG_ID,
  looksLikeUnityProject,
  readInstallMetadata,
  readTarballVersion,
  resolveBundledTarball,
  sha256File,
} from "./bridge-install-common.js";

interface UpdateArgs {
  project: string;
  tarball?: string;
  forceBridge: boolean;
  dryRun: boolean;
  channel?: string;
  version?: string;
}

type ParseHelp = { help: true; usageError?: boolean };

function parseArgs(args: string[]): UpdateArgs | ParseHelp {
  let project = "";
  let tarball: string | undefined;
  let forceBridge = false;
  let dryRun = false;
  let channel: string | undefined;
  let version: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--project" || arg === "-p") project = args[(i += 1)] ?? "";
    else if (arg === "--tarball") tarball = args[(i += 1)] ?? "";
    else if (arg === "--force-bridge") forceBridge = true;
    else if (arg === "--dry-run") dryRun = true;
    else if (arg === "--channel") channel = args[(i += 1)] ?? "";
    else if (arg === "--version") version = args[(i += 1)] ?? "";
    else if (arg === "--help" || arg === "-h") return { help: true };
    else {
      console.error(`[loomtide update] unknown argument "${arg}".`);
      return { help: true, usageError: true };
    }
  }
  if (!project) {
    console.error("[loomtide update] --project <unity-project-dir> is required.");
    return { help: true, usageError: true };
  }
  return { project: path.resolve(project), tarball, forceBridge, dryRun, channel, version };
}

function printUsage(): void {
  console.log(
    [
      "Usage: loomtide update --project <unity-project-dir> [options]",
      "",
      "Reconcile the project's bridge with the bridge bundled in this CLI, then run",
      "doctor. Default (tarball) route is a hash-checked file swap.",
      "",
      "Options:",
      "  --project, -p <dir>   Target Unity project (required)",
      "  --force-bridge        Overwrite an --embedded copy even if it may be edited",
      "  --tarball <path>      Update to this bridge .tgz instead of the CLI-bundled one",
      "  --dry-run             Print the plan without writing any files",
      "  --channel <name>      (advisory) shown in the CLI self-update instruction",
      "  --version <x.y.z>     (advisory) shown in the CLI self-update instruction",
      "  -h, --help            Show this help",
      "",
      "Exit codes: 0 up-to-date/updated + healthy · 1 problem · 2 usage/precondition.",
    ].join("\n"),
  );
}

/**
 * Detect-and-instruct: never self-run an install (brittle across node version
 * managers). Print the SINGLE install-or-update command — the same one used to
 * install; re-running it pulls the latest release. `--version` maps to the
 * installer's `LOOMTIDE_VERSION` pin; `--channel` is advisory only.
 */
function printCliSelfUpdateHint(_channel?: string, version?: string): void {
  const url = process.env.LOOMTIDE_INSTALL_URL || "https://get.loomtide.ai";
  const prefix = version ? `LOOMTIDE_VERSION=${version} ` : "";
  console.log(`  note: to update the CLI itself, run:  ${prefix}curl -fsSL ${url} | sh`);
  console.log(`        (same command you installed with; needs 'gh auth login' or LOOMTIDE_TOKEN)`);
}

export async function run(args: string[]): Promise<number> {
  const parsed = parseArgs(args);
  if ("help" in parsed) {
    printUsage();
    return parsed.usageError ? 2 : 0;
  }
  const { project } = parsed;

  if (!existsSync(project) || !looksLikeUnityProject(project)) {
    console.error(`[loomtide update] ${project} is not a Unity project.`);
    return 2;
  }

  const meta = readInstallMetadata(project);
  if (!meta) {
    console.error(
      `[loomtide update] no ${METADATA_RELPATH} — the bridge was never installed here.\n` +
        `    Run: loomtide install-bridge --project ${project}`,
    );
    return 2;
  }

  const tgz = resolveBundledTarball(parsed.tarball);
  if (!tgz) {
    console.error("[loomtide update] no bundled bridge tarball found (run scripts/loomtide-pack-bridge.sh in dev).");
    return 1;
  }
  const bundledVersion = readTarballVersion(tgz);
  const bundledSha = sha256File(tgz);

  console.log(`==> Updating ${PKG_ID} in ${project}`);
  console.log(`    installed: ${meta.bridgeVersion} (${meta.installMode})`);
  console.log(`    bundled:   ${bundledVersion}`);
  printCliSelfUpdateHint(parsed.channel, parsed.version);

  // Optional agent surface: UNSET → ONE hint, "declined" → silent, "enabled" → REFRESH to
  // this CLI's payload (same hash discipline as install-agent). Runs on every update path.
  const surfaceCode = reconcileAgentSurfaceForUpdate(project, parsed.dryRun);
  if (surfaceCode !== 0) return surfaceCode;

  const isEmbedded = meta.installMode === "embedded-package";
  const alreadyCurrent =
    !isEmbedded && meta.bridgeVersion === bundledVersion && meta.tarballSha256 === bundledSha;

  if (alreadyCurrent) {
    console.log("  -> already up to date; running doctor.");
    return doctorRun(["--project", project]);
  }

  // Embedded copies can be hand-edited and we can't tell — refuse to clobber
  // without an explicit --force-bridge (the plan's safety rule).
  if (isEmbedded && !parsed.forceBridge) {
    console.error(
      "[loomtide update] refusing to overwrite an --embedded bridge (it may contain local edits).\n" +
        `    Re-run with --force-bridge to overwrite, or migrate to the tarball route: ` +
        `loomtide install-bridge --project ${project}`,
    );
    return 1;
  }

  // Backup the install record before mutating (the plan's "backup before migrate").
  // The backup lives under .loomtide/backups/ — NOT next to the record in
  // ProjectSettings/, where a stray `.bak` shows up as an untracked file in every
  // consumer's `git status` after every update. `.loomtide/` run artifacts are the
  // one Loomtide surface consumers never commit.
  if (!parsed.dryRun) {
    const metaPath = path.join(project, METADATA_RELPATH);
    if (existsSync(metaPath)) {
      const backupDir = path.join(project, ".loomtide", "backups");
      mkdirSync(backupDir, { recursive: true });
      copyFileSync(metaPath, path.join(backupDir, "LoomtideInstall.json.bak"));
      console.log(`  -> backed up ${METADATA_RELPATH} -> .loomtide/backups/LoomtideInstall.json.bak`);
    }
    // Heal the legacy location: older CLIs dropped the .bak beside the record.
    const legacyBak = `${metaPath}.bak`;
    if (existsSync(legacyBak)) {
      rmSync(legacyBak);
      console.log(`  -> removed legacy ${METADATA_RELPATH}.bak (backups live in .loomtide/backups/ now)`);
    }
  }

  // Reuse the exact installer file operations (tarball swap / embedded refresh).
  const installCode = await installBridge({
    project,
    mode: isEmbedded ? "embedded" : "tarball",
    tarball: tgz,
    dryRun: parsed.dryRun,
  });
  if (installCode !== 0) return installCode;

  if (parsed.dryRun) {
    console.log("  (--dry-run: skipped doctor)");
    return 0;
  }

  console.log("");
  console.log("==> Verifying with doctor:");
  return doctorRun(["--project", project]);
}
