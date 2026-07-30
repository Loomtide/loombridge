/**
 * `loombridge update` — reconcile a project's Loombridge-owned bridge with the bridge
 * that ships with THIS CLI, then run `doctor`.
 *
 * On the default tarball route this is a hash-checked file swap: drop the newer
 * `.tgz`, bump the `file:` line, prune the old one, rewrite `LoombridgeInstall.json`
 * (all via the shared installer). Because the resolved copy lives read-only in
 * Unity's `Library/PackageCache`, there is nothing a developer could have edited,
 * so no `--force-bridge` dance — that flag matters only for the `--embedded`
 * fallback (a physical folder someone could have modified).
 *
 * The CLI itself is NOT self-updated (self-running an install is brittle across
 * nvm/volta/asdf/corepack), so we detect-and-instruct: print the single
 * install-or-update command, which is the same one a developer used to install
 * and re-runs to update. See `printCliSelfUpdateHint` for why that command is
 * the release's `install.sh` and not a get.loomtide.ai one-liner.
 *
 * Exit codes: 0 up-to-date/updated + healthy · 1 update or health problem ·
 * 2 usage/precondition (bridge never installed here, or a bundle that does not match
 * this CLI's packaged sources and was therefore refused).
 */

import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";

import { installBridge } from "./install-bridge.js";
import { reconcileAgentSurfaceForUpdate } from "./install-agent.js";
import { run as doctorRun } from "./doctor.js";
import {
  ALLOW_STALE_FLAG,
  METADATA_RELPATH,
  PKG_ID,
  gateBridgeFreshness,
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
  allowStaleBridge: boolean;
  dryRun: boolean;
  channel?: string;
  version?: string;
}

type ParseHelp = { help: true; usageError?: boolean };

function parseArgs(args: string[]): UpdateArgs | ParseHelp {
  let project = "";
  let tarball: string | undefined;
  let forceBridge = false;
  let allowStaleBridge = false;
  let dryRun = false;
  let channel: string | undefined;
  let version: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--project" || arg === "-p") project = args[(i += 1)] ?? "";
    else if (arg === "--tarball") tarball = args[(i += 1)] ?? "";
    else if (arg === "--force-bridge") forceBridge = true;
    else if (arg === ALLOW_STALE_FLAG) allowStaleBridge = true;
    else if (arg === "--dry-run") dryRun = true;
    else if (arg === "--channel") channel = args[(i += 1)] ?? "";
    else if (arg === "--version") version = args[(i += 1)] ?? "";
    else if (arg === "--help" || arg === "-h") return { help: true };
    else {
      console.error(`[loombridge update] unknown argument "${arg}".`);
      return { help: true, usageError: true };
    }
  }
  if (!project) {
    console.error("[loombridge update] --project <unity-project-dir> is required.");
    return { help: true, usageError: true };
  }
  return { project: path.resolve(project), tarball, forceBridge, allowStaleBridge, dryRun, channel, version };
}

function printUsage(): void {
  console.log(
    [
      "Usage: loombridge update --project <unity-project-dir> [options]",
      "",
      "Reconcile the project's bridge with the bridge bundled in this CLI, then run",
      "doctor. Default (tarball) route is a hash-checked file swap.",
      "",
      "Options:",
      "  --project, -p <dir>   Target Unity project (required)",
      "  --force-bridge        Overwrite an --embedded copy even if it may be edited",
      `  ${ALLOW_STALE_FLAG}  Deliver a bundle that does not match this CLI's sources`,
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
 * Where releases (and therefore `install.sh`) are published. Mirrors the `LOOMBRIDGE_REPO` default
 * in `scripts/install.sh` and `scripts/loombridge-release.sh`; `release-asset-contract.test.ts`
 * keeps the three in agreement.
 */
const RELEASE_REPO = process.env.LOOMBRIDGE_REPO || "Loomtide/loombridge";

/**
 * Detect-and-instruct: never self-run an install (brittle across node version
 * managers). Print the install-or-update command — the same one used to install;
 * re-running it pulls the latest release. `--version` maps to the installer's
 * `LOOMBRIDGE_VERSION` pin; `--channel` is advisory only.
 *
 * IT MUST NOT ADVERTISE `get.loomtide.ai` BY DEFAULT. That endpoint does not serve Loombridge: it
 * currently returns the installer for a DIFFERENT product (`@loomtide/cli`), so the old default here
 * told every user running `loombridge update` to install something else entirely. Confirmed by
 * running it. `README.md` and `Docs/Install.md` already carried that warning; this code contradicted
 * them.
 *
 * The honest default is the channel that actually works today: `install.sh`, published as an asset
 * on each release. `LOOMBRIDGE_INSTALL_URL` stays as the override, so the one-liner returns as the
 * default the moment a Loombridge-specific endpoint is deployed, without another code change.
 */
function printCliSelfUpdateHint(_channel?: string, version?: string): void {
  const prefix = version ? `LOOMBRIDGE_VERSION=${version} ` : "";
  const url = process.env.LOOMBRIDGE_INSTALL_URL;
  if (url) {
    console.log(`  note: to update the CLI itself, run:  ${prefix}curl -fsSL ${url} | sh`);
  } else {
    console.log("  note: to update the CLI itself, download install.sh from the latest release and run it:");
    console.log(
      `        ${prefix}gh release download -R ${RELEASE_REPO} -p install.sh && sh install.sh`,
    );
  }
  console.log(`        (needs 'gh auth login' or LOOMBRIDGE_TOKEN)`);
}

export async function run(args: string[]): Promise<number> {
  const parsed = parseArgs(args);
  if ("help" in parsed) {
    printUsage();
    return parsed.usageError ? 2 : 0;
  }
  const { project } = parsed;

  if (!existsSync(project) || !looksLikeUnityProject(project)) {
    console.error(`[loombridge update] ${project} is not a Unity project.`);
    return 2;
  }

  const meta = readInstallMetadata(project);
  if (!meta) {
    console.error(
      `[loombridge update] no ${METADATA_RELPATH} — the bridge was never installed here.\n` +
        `    Run: loombridge install-bridge --project ${project}`,
    );
    return 2;
  }

  let tgz;
  try {
    tgz = resolveBundledTarball(parsed.tarball);
  } catch (error) {
    // A corrupt archive or an unreadable source tree makes the grade impossible. That is a
    // runtime failure, never a silent proceed: an ungraded bundle is exactly what this
    // guard exists to stop.
    console.error(`[loombridge update] could not read the bridge tarball: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  if (!tgz) {
    console.error("[loombridge update] no bundled bridge tarball found (run scripts/loombridge-pack-bridge.sh in dev).");
    return 1;
  }
  const bundledVersion = readTarballVersion(tgz.path);
  const bundledSha = sha256File(tgz.path);

  // THE FRESHNESS GATE, deliberately here: ABOVE reconcileAgentSurfaceForUpdate (which
  // writes files) and ABOVE the alreadyCurrent short-circuit. A project already holding
  // the stale bridge must hear "stale", never "already up to date". That message is what
  // made the original failure look healthy end to end.
  const gate = gateBridgeFreshness("update", tgz, parsed.allowStaleBridge);
  switch (gate.kind) {
    case "proceed":
      break;
    case "warn":
      console.warn(gate.message);
      break;
    case "refuse":
      console.error(gate.message);
      return 2;
    default: {
      const exhaustive: never = gate;
      throw new Error(`unhandled freshness gate outcome: ${JSON.stringify(exhaustive)}`);
    }
  }

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
      "[loombridge update] refusing to overwrite an --embedded bridge (it may contain local edits).\n" +
        `    Re-run with --force-bridge to overwrite, or migrate to the tarball route: ` +
        `loombridge install-bridge --project ${project}`,
    );
    return 1;
  }

  // Backup the install record before mutating (the plan's "backup before migrate").
  // The backup lives under .loombridge/backups/ — NOT next to the record in
  // ProjectSettings/, where a stray `.bak` shows up as an untracked file in every
  // consumer's `git status` after every update. `.loombridge/` run artifacts are the
  // one Loombridge surface consumers never commit.
  if (!parsed.dryRun) {
    const metaPath = path.join(project, METADATA_RELPATH);
    if (existsSync(metaPath)) {
      const backupDir = path.join(project, ".loombridge", "backups");
      mkdirSync(backupDir, { recursive: true });
      copyFileSync(metaPath, path.join(backupDir, "LoombridgeInstall.json.bak"));
      console.log(`  -> backed up ${METADATA_RELPATH} -> .loombridge/backups/LoombridgeInstall.json.bak`);
    }
    // Heal the legacy location: older CLIs dropped the .bak beside the record.
    const legacyBak = `${metaPath}.bak`;
    if (existsSync(legacyBak)) {
      rmSync(legacyBak);
      console.log(`  -> removed legacy ${METADATA_RELPATH}.bak (backups live in .loombridge/backups/ now)`);
    }
  }

  // Reuse the exact installer file operations (tarball swap / embedded refresh).
  // The tarball is handed on as an EXPLICIT path: update has already run the gate above,
  // and re-deriving the grade inside the installer would either duplicate the refusal or
  // (worse) reach a different verdict for the same bytes.
  const installCode = await installBridge({
    project,
    mode: isEmbedded ? "embedded" : "tarball",
    tarball: tgz.path,
    allowStaleBridge: parsed.allowStaleBridge,
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
