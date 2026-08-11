/**
 * `loombridge update`: update the CLI itself, then reconcile a project's Loombridge-owned
 * bridge with the bridge that ships with THIS CLI, then run `doctor`.
 *
 * TWO THINGS need updating, unlike a single-binary tool: the CLI, and the bridge package
 * inside each Unity project (a freshness gate already refuses when they disagree). The verb
 * serves both without a mode flag:
 *
 *   loombridge update              CLI first; then the bridge, if cwd is a Unity project
 *   loombridge update --project X  the same, targeting X
 *   loombridge update --check      report only; install nothing, write nothing
 *
 * ORDERING IS LOAD-BEARING. The bridge tarball is bundled INSIDE the CLI, so a self-update
 * replaces the bundle this process already resolved. Reconciling afterwards would deliver
 * the previous bridge and print success, which is the "stale bundle looks healthy" failure
 * the freshness gate below exists to close. So a self-update that actually ran ENDS the run
 * and asks for a re-run; only an already-current CLI proceeds to the bridge.
 *
 * On the default tarball route this is a hash-checked file swap: drop the newer
 * `.tgz`, bump the `file:` line, prune the old one, rewrite `LoombridgeInstall.json`
 * (all via the shared installer). Because the resolved copy lives read-only in
 * Unity's `Library/PackageCache`, there is nothing a developer could have edited,
 * so no `--force-bridge` dance — that flag matters only for the `--embedded`
 * fallback (a physical folder someone could have modified).
 *
 * Self-updating is offered only for the npm channel, which is one portable command.
 * A frozen runtime or a source checkout is detected and INSTRUCTED, never self-run:
 * `npm install -g` over a developer's checkout would replace their working tree with a
 * published build. See `cli-install-method.ts` for the channel table.
 *
 * Exit codes: 0 up-to-date/updated + healthy · 1 update or health problem ·
 * 2 usage/precondition (an explicit --project that is not a Unity project or has no bridge
 * installed, or a bundle that does not match this CLI's packaged sources and was therefore
 * refused). Bare `update` outside a Unity project is NOT an error: updating the CLI is a
 * complete, useful action on its own.
 */

import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";

import { loombridgePaths } from "../../domain/state.js";
import { packageRoot } from "../../shared/pkg-root.js";
import { resolveBuildStamp } from "../../shared/build-stamp.js";
import { installBridge } from "./install-bridge.js";
import { reconcileAgentSurfaceForUpdate } from "./install-agent.js";
import { run as doctorRun } from "./doctor.js";
import {
  type CliInstallInfo,
  classifyCliInstall,
  manualUpdateInstruction,
} from "./cli-install-method.js";
import {
  type LatestVersionLookup,
  executeSelfUpdate,
  isValidVersionSpec,
  npmRegistryLookup,
  planSelfUpdate,
} from "./cli-self-update.js";
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
  /** Empty when no project was given AND cwd is not a Unity project: a CLI-only run. */
  project: string;
  tarball?: string;
  forceBridge: boolean;
  allowStaleBridge: boolean;
  dryRun: boolean;
  checkOnly: boolean;
  skipSelf: boolean;
  version?: string;
}

type ParseHelp = { help: true; usageError?: boolean };

function usageError(message: string): ParseHelp {
  console.error(`[loombridge update] ${message}`);
  return { help: true, usageError: true };
}

/**
 * Read the value that follows a value-taking flag.
 *
 * Returns `null` when the flag is last, or when the next token is itself a flag. Without the
 * second check `--project --check` consumes `--check` as the project path: the operator gets a
 * wrong target AND silently loses the no-write flag, which is the quiet-wrong-target class the
 * refusal exists to close. `--version --check` was worse: it built and RAN
 * `npm install -g loombridge@--check`.
 */
function valueAfter(args: string[], index: number): string | null {
  const next = args[index + 1];
  if (next === undefined || next.startsWith("-")) return null;
  return next;
}

export function parseArgs(args: string[], cwd: string = process.cwd()): UpdateArgs | ParseHelp {
  let project = "";
  let projectFlagSeen = false;
  let tarball: string | undefined;
  let forceBridge = false;
  let allowStaleBridge = false;
  let dryRun = false;
  let checkOnly = false;
  let skipSelf = false;
  let version: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--project" || arg === "-p") {
      projectFlagSeen = true;
      project = valueAfter(args, i) ?? "";
      if (project.length > 0) i += 1;
    }
    else if (arg === "--tarball") {
      tarball = valueAfter(args, i) ?? "";
      if (tarball.length === 0) return usageError(`${arg} needs a path.`);
      i += 1;
    }
    else if (arg === "--force-bridge") forceBridge = true;
    else if (arg === ALLOW_STALE_FLAG) allowStaleBridge = true;
    else if (arg === "--dry-run") dryRun = true;
    else if (arg === "--check") checkOnly = true;
    else if (arg === "--no-self-update") skipSelf = true;
    else if (arg === "--version") {
      version = valueAfter(args, i) ?? "";
      if (version.length === 0) return usageError(`${arg} needs a version.`);
      // The pin is interpolated into an install command, so it is validated at the door.
      // A value containing whitespace would re-split downstream into EXTRA install targets.
      if (!isValidVersionSpec(version)) {
        return usageError(`--version "${version}" is not a valid version.`);
      }
      i += 1;
    }
    else if (arg === "--help" || arg === "-h") return { help: true };
    else {
      console.error(`[loombridge update] unknown argument "${arg}".`);
      return { help: true, usageError: true };
    }
  }

  // A value-less `--project` is a USAGE ERROR, never a silent fallback to cwd: the operator
  // named a target and got a different one, which is the quiet-wrong-target class.
  if (projectFlagSeen && project.length === 0) {
    console.error("[loombridge update] --project needs a directory.");
    return { help: true, usageError: true };
  }

  // Default the project to cwd, but ONLY when cwd really is a Unity project. Resolving it
  // to a non-project cwd would turn every `loombridge update` run in a random directory into
  // a "not a Unity project" error, which is precisely the friction this defaulting removes.
  if (!projectFlagSeen && looksLikeUnityProject(cwd)) project = cwd;

  return {
    project: project.length > 0 ? path.resolve(project) : "",
    tarball,
    forceBridge,
    allowStaleBridge,
    dryRun,
    checkOnly,
    skipSelf,
    version,
  };
}

function printUsage(): void {
  console.log(
    [
      "Usage: loombridge update [--project <unity-project-dir>] [options]",
      "",
      "Update Loombridge: the CLI itself first, then the bridge inside a Unity project,",
      "then run doctor. With no --project, the current directory is used when it is a",
      "Unity project; otherwise only the CLI is updated.",
      "",
      "The CLI is self-updated only for a GLOBAL npm install (one portable command). A",
      "local/npx copy, a frozen runtime, or a source checkout is detected and the exact",
      "command is printed instead, never run for you.",
      "",
      "Options:",
      "  --project, -p <dir>   Target Unity project (default: cwd when it is one)",
      "  --check               Report what would happen; install nothing, write nothing",
      "  --no-self-update      Skip the CLI check entirely; only touch the project bridge",
      "  --force-bridge        Overwrite an --embedded copy even if it may be edited",
      `  ${ALLOW_STALE_FLAG}  Deliver a bundle that does not match this CLI's sources`,
      "  --tarball <path>      Update to this bridge .tgz instead of the CLI-bundled one",
      "  --dry-run             Print the plan without writing any files",
      "  --version <x.y.z>     Pin the CLI update to an exact published version",
      "  -h, --help            Show this help",
      "",
      "A self-update ENDS the run: the bridge tarball ships inside the CLI, so the bridge",
      "must be reconciled by the NEW binary. Re-run `loombridge update` afterwards.",
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

/** What the CLI phase decided, and whether the bridge phase may still run in THIS process. */
type SelfUpdateOutcome =
  /** Nothing was installed; the bridge phase may proceed with this CLI's bundled tarball. */
  | { kind: "continue" }
  /** The CLI on disk was replaced. The bundle this process holds is now the OLD one. */
  | { kind: "stop-updated"; exitCode: number };

/**
 * The CLI half of `update`: check the registry, then either install (npm channel) or print
 * the exact command for this channel.
 *
 * `lookup` is injected so the whole table is testable without a network.
 */
export function runCliSelfUpdatePhase(params: {
  checkOnly: boolean;
  pinnedVersion?: string | undefined;
  lookup?: LatestVersionLookup;
  installMethod?: CliInstallInfo;
  currentVersion?: string;
  runInstall?: (command: string) => boolean;
}): SelfUpdateOutcome {
  const info = params.installMethod ?? classifyCliInstall(packageRoot(import.meta.url));
  const current = params.currentVersion ?? resolveBuildStamp().version;
  const lookup = params.lookup ?? npmRegistryLookup();

  console.log("==> Loombridge CLI");
  console.log(`    running:  ${current}  (${info.reason})`);

  const plan = planSelfUpdate({
    method: info.method,
    current,
    latest: lookup(),
    pinnedVersion: params.pinnedVersion,
  });

  switch (plan.action) {
    case "already-current":
      console.log(`  -> ${plan.message}`);
      return { kind: "continue" };

    case "ahead-of-registry":
      console.log(`  -> ${plan.message}`);
      return { kind: "continue" };

    case "check-failed":
      // NEVER "up to date": nothing was compared. Same refusal shape the gates use.
      console.warn(`  !! ${plan.message}`);
      return { kind: "continue" };

    case "instruct":
      console.log(`  -> ${plan.message}`);
      for (const line of manualUpdateInstruction(info.method, RELEASE_REPO)) console.log(line);
      return { kind: "continue" };

    case "self-update": {
      console.log(`  -> ${plan.message}`);
      if (!plan.command) {
        for (const line of manualUpdateInstruction(info.method, RELEASE_REPO)) console.log(line);
        return { kind: "continue" };
      }
      if (params.checkOnly) {
        console.log(`     would run:  ${plan.command}`);
        console.log("     (--check: nothing was installed)");
        return { kind: "continue" };
      }
      console.log(`     running:  ${plan.command}`);
      const ok = (params.runInstall ?? ((c: string) => executeSelfUpdate(c)))(plan.command);
      if (!ok) {
        console.error("[loombridge update] the CLI update command failed.");
        for (const line of manualUpdateInstruction(info.method, RELEASE_REPO)) console.error(line);
        return { kind: "stop-updated", exitCode: 1 };
      }
      // Report the spec that was actually INSTALLED, never the registry's `latest`. With
      // `--version 0.1.5` pinned, `latest` is a different version entirely, and printing it
      // would be a verdict unbound to the run that produced it: the exact failure this repo's
      // gates exist to refuse, in the install path.
      console.log(`  -> CLI updated to ${params.pinnedVersion || plan.latest || "the latest published version"}.`);
      console.log("");
      console.log("     The bridge ships inside the CLI, so the newly installed binary must be the");
      console.log("     one that delivers it. Re-run to reconcile a project's bridge:");
      console.log("       loombridge update");
      return { kind: "stop-updated", exitCode: 0 };
    }

    default: {
      const exhaustive: never = plan.action;
      throw new Error(`unhandled self-update action: ${String(exhaustive)}`);
    }
  }
}

/**
 * Test seam for `run`. Kept deliberately small: only the two things a unit test cannot control
 * from outside (the working directory, and the phase that reaches the network and installs).
 *
 * It exists because the argv-to-actuator WIRING had no coverage, and that is exactly where a
 * real defect hid: `--dry-run` was parsed correctly and then never forwarded, so a flag
 * documented as write-free ran a global install. Every unit test passed, because they all
 * called the phase directly with hand-supplied parameters and never walked argv into it.
 */
export interface UpdateRunDeps {
  cwd?: string;
  selfUpdatePhase?: typeof runCliSelfUpdatePhase;
}

export async function run(args: string[], deps: UpdateRunDeps = {}): Promise<number> {
  const parsed = parseArgs(args, deps.cwd);
  if ("help" in parsed) {
    printUsage();
    return parsed.usageError ? 2 : 0;
  }
  const { project } = parsed;

  // Validate an explicitly named project BEFORE phase 1. Phase 1 can end the run by
  // self-updating and returning 0, so a typo'd `--project /typo/path` would exit 0 having
  // never noticed the path is wrong, and the operator would believe that project was handled.
  // Argument validity is a precondition, so it is checked before anything is actuated.
  if (project.length > 0 && (!existsSync(project) || !looksLikeUnityProject(project))) {
    console.error(`[loombridge update] ${project} is not a Unity project.`);
    return 2;
  }

  // Phase 1: the CLI itself. A successful self-update ends the run (see the header note on
  // ordering): the replaced binary owns the bridge tarball the next phase would deliver.
  if (!parsed.skipSelf) {
    const outcome = (deps.selfUpdatePhase ?? runCliSelfUpdatePhase)({
      // BOTH no-write flags gate the install. `--dry-run` is documented as "print the plan
      // without writing any files"; forwarding only `--check` here meant `--dry-run` ran a
      // real global `npm install -g`, and `--dry-run --version <x>` silently DOWNGRADED the
      // CLI. A flag that promises to write nothing must reach every actuator, not just the
      // one it was written alongside.
      checkOnly: parsed.checkOnly || parsed.dryRun,
      pinnedVersion: parsed.version,
    });
    if (outcome.kind === "stop-updated") return outcome.exitCode;
    console.log("");
  }

  // Phase 2: the project bridge. No project in play is a COMPLETE run, not a usage error:
  // updating the CLI is useful on its own, and demanding --project here is the friction this
  // verb exists to remove.
  if (project.length === 0) {
    console.log("==> Unity project bridge");
    console.log("  -> no Unity project here, so nothing else to update.");
    console.log("     To update a project's bridge, run this from the project directory, or:");
    console.log("       loombridge update --project /path/to/UnityProject");
    return 0;
  }

  // (Project validity was already checked above, before anything could be actuated.)
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

  console.log(`==> Unity project bridge: ${PKG_ID} in ${project}`);
  console.log(`    installed: ${meta.bridgeVersion} (${meta.installMode})`);
  console.log(`    bundled:   ${bundledVersion}`);

  // `--check` reports without writing. It reuses the dry-run path rather than adding a second
  // no-write mode: one code path that never mutates is one path to keep honest.
  const dryRun = parsed.dryRun || parsed.checkOnly;

  // Optional agent surface: UNSET → ONE hint, "declined" → silent, "enabled" → REFRESH to
  // this CLI's payload (same hash discipline as install-agent). Runs on every update path.
  const surfaceCode = reconcileAgentSurfaceForUpdate(project, dryRun);
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
  // The backup lives under .loombridge/run/backups/ — NOT next to the record in
  // ProjectSettings/, where a stray `.bak` shows up as an untracked file in every
  // consumer's `git status` after every update. `.loombridge/` run artifacts are the
  // one Loombridge surface consumers never commit.
  if (!dryRun) {
    const metaPath = path.join(project, METADATA_RELPATH);
    if (existsSync(metaPath)) {
      const backupDir = loombridgePaths(project).backups;
      mkdirSync(backupDir, { recursive: true });
      copyFileSync(metaPath, path.join(backupDir, "LoombridgeInstall.json.bak"));
      console.log(`  -> backed up ${METADATA_RELPATH} -> .loombridge/run/backups/LoombridgeInstall.json.bak`);
    }
    // Heal the legacy location: older CLIs dropped the .bak beside the record.
    const legacyBak = `${metaPath}.bak`;
    if (existsSync(legacyBak)) {
      rmSync(legacyBak);
      console.log(`  -> removed legacy ${METADATA_RELPATH}.bak (backups live in .loombridge/run/backups/ now)`);
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
    dryRun,
  });
  if (installCode !== 0) return installCode;

  if (dryRun) {
    console.log(parsed.checkOnly ? "  (--check: nothing was written; skipped doctor)" : "  (--dry-run: skipped doctor)");
    return 0;
  }

  console.log("");
  console.log("==> Verifying with doctor:");
  return doctorRun(["--project", project]);
}
