/**
 * `loombridge setup`: one command from a fresh Unity project to a wired one.
 *
 *   cd /path/to/UnityProject
 *   loombridge setup
 *
 * Onboarding had three pieces and shipped an installer for two of them
 * (Docs/Design/OneCommandSetup.md): the bridge had `install-bridge`, the optional slash
 * commands had `install-agent`, and the piece that actually connects the agent to Unity, the
 * MCP registration, had nothing at all. This verb is the front door over all of them.
 *
 * It COMPOSES the existing verbs; it reimplements none of them. Each still works alone and
 * stays documented, so `setup` cannot drift from what those verbs do:
 *
 *   1. Resolve the project      cwd by default, exactly as `update` defaults it.
 *   2. CLI currency             `update`'s own check, in REPORT-ONLY mode.
 *   3. Bridge                   `install-bridge`'s installer (freshness gate included).
 *   4. MCP                      `install-mcp`.
 *   5. Agent surface, LAST      `install-agent`, and only with consent (see below).
 *   6. `doctor`                 so the run ends on evidence rather than on a claim.
 *
 * WHY THE CURRENCY CHECK ONLY REPORTS. A self-update has to END the run: the bridge tarball
 * ships inside the CLI, so the newly installed binary must be the one that delivers it (see
 * update.ts's ordering note). Ending `setup` halfway through, on a first-time setup, is worse
 * than telling the operator to run `loombridge update`. So a stale CLI warns and the run
 * continues: the bridge about to be installed is the one this CLI shipped with, so the result
 * is internally consistent either way.
 *
 * WHY ONLY STEP 5 PROMPTS. The slash commands and skills are opinionated content committed
 * into someone else's repo, so they stay opt-in. Everything else, MCP included, is what makes
 * the tool work at all and is not what the confirmation is about. And the prompt can never
 * block: this CLI is driven by agents as often as by humans, so a missing answer resolves to
 * the documented default (skip), never to a write.
 *
 * Exit codes:
 *   0  the project is wired (bridge + MCP) and `doctor` is happy. An OPTIONAL step that was
 *      skipped (the agent surface, by flag, by a non-interactive run, or by a recorded
 *      "declined") does not change this: skipping is its documented default.
 *   1  a REQUIRED step failed: the bridge could not be reconciled, the agent surface install
 *      failed after being asked for, or `doctor` reported a problem.
 *   2  usage or precondition: bad arguments, cwd is not a Unity project, a refused stale
 *      bridge bundle, or a `.mcp.json` that could not be parsed or holds a foreign entry.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";

import { installBridge } from "./install-bridge.js";
import { agentSurfaceState, reconcileAgentSurfaceForUpdate, run as installAgentRun } from "./install-agent.js";
import { runInstallMcp } from "./install-mcp.js";
import { run as doctorRun } from "./doctor.js";
import { runCliSelfUpdatePhase } from "./update.js";
import { ALLOW_STALE_FLAG, METADATA_RELPATH, looksLikeUnityProject, readInstallMetadata } from "./bridge-install-common.js";

interface SetupArgs {
  project: string;
  /** Install the agent surface without asking. */
  yes: boolean;
  /** Skip the agent surface without asking. */
  noAgentSurface: boolean;
  allowStaleBridge: boolean;
}

type ParseHelp = { help: true; usageError?: boolean };

/**
 * Read the value that follows a value-taking flag, refusing a missing value AND a following
 * flag. Same discipline as `update`: without the second check `--project --yes` consumes
 * `--yes` as the project path, so the operator gets a wrong target and silently loses the
 * flag they typed. That is the quiet-wrong-target class.
 */
function valueAfter(args: string[], index: number): string | null {
  const next = args[index + 1];
  if (next === undefined || next.startsWith("-")) return null;
  return next;
}

export function parseArgs(args: string[], cwd: string = process.cwd()): SetupArgs | ParseHelp {
  let project = "";
  let projectFlagSeen = false;
  let yes = false;
  let noAgentSurface = false;
  let allowStaleBridge = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--project" || arg === "-p") {
      projectFlagSeen = true;
      project = valueAfter(args, i) ?? "";
      if (project.length > 0) i += 1;
    }
    else if (arg === "--yes" || arg === "-y") yes = true;
    else if (arg === "--no-agent-surface") noAgentSurface = true;
    else if (arg === ALLOW_STALE_FLAG) allowStaleBridge = true;
    else if (arg === "--help" || arg === "-h") return { help: true };
    else {
      console.error(`[loombridge setup] unknown argument "${arg}".`);
      return { help: true, usageError: true };
    }
  }

  // A value-less `--project` is a USAGE ERROR, never a silent fallback to cwd: the operator
  // named a target and would otherwise get a different one.
  if (projectFlagSeen && project.length === 0) {
    console.error("[loombridge setup] --project needs a directory.");
    return { help: true, usageError: true };
  }

  // Contradictory consent is a usage error rather than a precedence rule nobody remembers.
  if (yes && noAgentSurface) {
    console.error("[loombridge setup] --yes and --no-agent-surface contradict each other; pass one.");
    return { help: true, usageError: true };
  }

  if (!projectFlagSeen) project = cwd;
  return { project: path.resolve(project), yes, noAgentSurface, allowStaleBridge };
}

function printUsage(): void {
  console.log(
    [
      "Usage: loombridge setup [--project <unity-project-dir>] [options]",
      "",
      "Wire a Unity project end to end, in one command: the bridge, the MCP registration",
      "in .mcp.json, optionally the agent commands + skills, then doctor. With no",
      "--project the current directory is used, and must be a Unity project.",
      "",
      "It composes the individual verbs (install-bridge, install-mcp, install-agent,",
      "doctor), which all keep working on their own. Re-run it any time: it is idempotent.",
      "",
      "The CLI's own currency is REPORTED, never self-updated: installing a new CLI has to",
      "end the run (the bridge ships inside it), so `setup` tells you to run",
      "`loombridge update` instead of stopping halfway.",
      "",
      "The agent surface (slash commands + skills, committed into your repo) is the ONLY",
      "step that asks. Not a terminal and no flag: it is SKIPPED, and the command to add",
      "it later is printed. Nothing else prompts.",
      "",
      "Options:",
      "  --project, -p <dir>   Target Unity project (default: the current directory)",
      "  --yes, -y             Install the agent surface without asking",
      "  --no-agent-surface    Skip the agent surface without asking",
      `  ${ALLOW_STALE_FLAG}  Install a bridge bundle that does not match this CLI's sources`,
      "  -h, --help            Show this help",
      "",
      "Exit codes: 0 wired + healthy (a skipped OPTIONAL step is still 0) · 1 a required",
      "step failed · 2 usage/precondition.",
    ].join("\n"),
  );
}

/**
 * Test seam. Kept to what a unit test cannot control from outside: the working directory,
 * the phases that reach the network or need a packed bridge tarball, and the terminal.
 *
 * The defaults ARE the real verbs (asserted by the wiring test). The seam exists so the
 * argv-to-actuator path is covered, which is exactly where `update`'s `--dry-run` defect hid.
 */
export interface SetupRunDeps {
  cwd?: string;
  selfUpdatePhase?: typeof runCliSelfUpdatePhase;
  installBridgeFn?: typeof installBridge;
  installMcpFn?: typeof runInstallMcp;
  installAgentFn?: typeof installAgentRun;
  doctorFn?: typeof doctorRun;
  /** Whether stdin is a terminal. Defaults to the real `process.stdin.isTTY === true`. */
  isTTY?: boolean;
  /** Ask a question. Only ever called when `isTTY` is true. */
  ask?: (question: string) => Promise<string>;
}

export const _defaultDeps = {
  selfUpdatePhase: runCliSelfUpdatePhase,
  installBridgeFn: installBridge,
  installMcpFn: runInstallMcp,
  installAgentFn: installAgentRun,
  doctorFn: doctorRun,
};

export async function run(args: string[], deps: SetupRunDeps = {}): Promise<number> {
  const parsed = parseArgs(args, deps.cwd);
  if ("help" in parsed) {
    printUsage();
    return parsed.usageError ? 2 : 0;
  }
  const { project } = parsed;

  // --- 1. Resolve the project. A refusal, never a guess at a nearby directory, and BEFORE
  // anything is actuated so a wrong target cannot be half-wired.
  if (!existsSync(project) || !looksLikeUnityProject(project)) {
    console.error(
      `[loombridge setup] ${project} is not a Unity project (no Assets/, ProjectSettings/ProjectVersion.txt, or Packages/manifest.json).\n` +
        "    Run this from inside the project, or name it: loombridge setup --project <dir>",
    );
    return 2;
  }

  console.log(`==> Setting up Loombridge in ${project}`);
  console.log("");

  // --- 2. CLI currency: REPORT ONLY. `checkOnly` is what makes that true, and it is passed
  // unconditionally: `setup` has no flag that could turn it off.
  const outcome = (deps.selfUpdatePhase ?? _defaultDeps.selfUpdatePhase)({ checkOnly: true });
  if (outcome.kind === "stop-updated") {
    // Unreachable while `checkOnly` holds (the phase installs nothing), and handled anyway:
    // if a CLI were ever replaced mid-run, continuing would deliver the bundle THIS process
    // already resolved, which is the stale-bridge-looks-healthy failure.
    console.error("[loombridge setup] the CLI changed underneath this run; re-run `loombridge setup`.");
    return outcome.exitCode === 0 ? 1 : outcome.exitCode;
  }
  console.log("     (setup only REPORTS the CLI version; `loombridge update` is what installs a newer one.)");
  console.log("");

  // --- 3. Bridge: install when absent, reconcile when present. Both go through
  // install-bridge's installer, so the freshness gate and its refusals come along.
  const meta = readInstallMetadata(project);
  if (meta?.installMode === "embedded-package") {
    // An --embedded copy is a physical folder someone could have edited, and we cannot tell.
    // `update --force-bridge` is the deliberate override; `setup` never carries it, because
    // "one command for a new project" must not be the thing that clobbers local edits.
    console.error(
      `[loombridge setup] this project has an --embedded bridge, which may contain local edits.\n` +
        `    setup will not overwrite it. Reconcile it deliberately:\n` +
        `      loombridge update --project ${project} --force-bridge`,
    );
    return 1;
  }
  console.log(`==> Unity bridge (${meta ? `reconciling ${meta.bridgeVersion}` : "installing"})`);
  const bridgeCode = await (deps.installBridgeFn ?? _defaultDeps.installBridgeFn)({
    project,
    mode: "tarball",
    allowStaleBridge: parsed.allowStaleBridge,
    dryRun: false,
  });
  if (bridgeCode !== 0) return bridgeCode;
  console.log("");

  // --- 4. MCP. Default ON: this is the step that makes an agent able to touch Unity at all,
  // and it is NOT what the confirmation below is about.
  const mcpCode = (deps.installMcpFn ?? _defaultDeps.installMcpFn)({ project, dryRun: false });
  if (mcpCode !== 0) return mcpCode;
  console.log("");

  // --- 5. Agent surface, last and confirmed.
  const surfaceCode = await runAgentSurfaceStep(project, parsed, deps);
  if (surfaceCode !== 0) return surfaceCode;
  console.log("");

  // --- 6. Close on evidence.
  console.log("==> Verifying with doctor:");
  const doctorCode = await (deps.doctorFn ?? _defaultDeps.doctorFn)(["--project", project]);
  if (doctorCode === 0) {
    console.log("");
    console.log("==> Setup complete. Open the project in Unity and let the bridge compile, then start your agent.");
  }
  return doctorCode;
}

/**
 * The one confirmed step. Returns an exit code: 0 for installed AND for every flavour of
 * skipped, because skipping is this surface's documented default rather than a failure.
 */
async function runAgentSurfaceStep(project: string, parsed: SetupArgs, deps: SetupRunDeps): Promise<number> {
  // A recorded choice wins with no prompt: "enabled" refreshes to this CLI's payload,
  // "declined" stays silent. Exactly what `update` already does after a `git pull`, so a
  // teammate's decision is not re-litigated on every machine.
  if (agentSurfaceState(project) !== "unset") {
    return reconcileAgentSurfaceForUpdate(project, false);
  }

  const skip = (why: string): number => {
    console.log(`==> Agent commands + skills (optional): SKIPPED (${why})`);
    console.log(`     Add them any time:  loombridge install-agent --project ${project}`);
    console.log(`     The choice is recorded in ${METADATA_RELPATH}, so it is team-wide.`);
    return 0;
  };

  if (parsed.noAgentSurface) return skip("--no-agent-surface");

  const isTTY = deps.isTTY ?? process.stdin.isTTY === true;
  if (!parsed.yes) {
    // NOT A TERMINAL: skip, say so, and keep going. A prompt that cannot be answered must
    // never block a run: the CLI is driven by agents as often as by humans.
    if (!isTTY) return skip("not an interactive terminal");

    console.log("==> Agent commands + skills (optional)");
    console.log("     Loombridge can install its /loombridge:* slash commands and skills INTO this repo");
    console.log("     (.claude/ + .codex/, committed so teammates get them via git pull).");
    const ask = deps.ask ?? defaultAsk;
    const answer = (await ask("     Install them now? [y/N] ")).trim().toLowerCase();
    if (answer !== "y" && answer !== "yes") return skip("declined at the prompt");
  }

  return (deps.installAgentFn ?? _defaultDeps.installAgentFn)(["--project", project]);
}

/** The real prompt. Output goes to stderr so stdout stays parseable, as elsewhere in the CLI. */
async function defaultAsk(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}
