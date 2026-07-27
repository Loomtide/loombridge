/**
 * `loombridge minigame run` — drive the WHOLE release-check pipeline with one command.
 *
 * Instead of running setup → record → capture → finalize → verify by hand, this loops the
 * SAME guided state machine `minigame next` uses (`inspectWorkspace` → `resolveNextStep`) and
 * EXECUTES each step instead of printing it, pausing only for the one inherently-interactive
 * step (record, where a human plays the game). It is correct-by-construction (no separate
 * "steps 1-5" list to drift) and fully RESUMABLE — a re-run re-inspects the workspace and
 * continues from wherever it stopped.
 *
 * It deliberately STOPS — never auto-advances past — two human gates:
 *   - NOT READY / CAN'T VERIFY  → fix the game (or the test setup), then re-run.
 *   - READY                      → approve the baseline yourself (blessing the reference
 *                                  screens for drift checks is a sign-off, not an auto-step).
 *
 * The orchestration core (`driveRun`) is dependency-injected (inspect / runStep / log), so the
 * progression, the stop gates, the error-stop, and the no-progress backstop are unit-testable
 * without disk or subprocesses. `runRun` wires the real IO (inspectWorkspace + a subprocess
 * per step, stdio inherited so each step looks exactly as if typed by hand).
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";

import {
  inspectWorkspace,
  resolveNextStep,
  type NextStepAt,
  type WorkspaceFacts,
} from "./minigame-next.js";
import { projectWorkspace as defaultWorkspace, normalizeWorkspaceId } from "../../domain/workspace-paths.js";
import { nextStepLines } from "../../shared/cli-ui.js";
import { isScenePath } from "./profiles/types.js";
import { childStepStdio, forwardCapturedOutput } from "../../shared/child-stdio.js";
import {
  resolveSetupConfig,
  scaffoldWorkspace,
  type Asker,
  type SetupFlags,
} from "./minigame-setup.js";

/** The steps `driveRun` EXECUTES (the stop states — fix / baseline / done — are never run). */
type ExecutableAt = Extract<NextStepAt, "record" | "capture" | "finalize" | "verify">;

/**
 * The CLI argv (verb tokens + ABSOLUTE-path flags) for an executable step — the executable
 * twin of `minigame next`'s display `commandsFor` (which uses `~`-shortened paths for reading).
 * Kept here because the executor spawns real argv; a unit test pins it against the resolver's
 * intent so the two never drift.
 */
export function stepArgv(at: ExecutableAt, f: WorkspaceFacts, opts: { recordScene?: string } = {}): string[] {
  const ws = f.workspace;
  const contract = path.join(ws, `${f.id}.minigame.json`);
  const captures = path.join(ws, "captures");
  const reports = path.join(ws, "reports", "minigame-verification.json");
  const traceId = `${f.id}-happy-path`;
  switch (at) {
    case "record": {
      // Thread the declared/auto-detected stateSignal so the chained record phase-aligns each gesture
      // (the same flag `minigame next` prints) — without it a multi-screen/gesture game records degraded.
      const stateSignal = f.stateSignal
        ? ["--state-signal", `${f.stateSignal.locator}:${f.stateSignal.component ?? ""}:${f.stateSignal.property}`]
        : [];
      // Record can RESET to a different scene than the scanned contract scene (a hub→game flow: scan the
      // game scene for the contract, but start the demonstration on the home/hub scene). The contract's
      // scene stays the game; only the record reset target changes.
      const recordScene = opts.recordScene ?? f.scene;
      return ["trace", "record", "--observe", "--flat", "--id", traceId, "--scene", recordScene, "--root", ws, ...stateSignal];
    }
    case "capture":
      return ["minigame", "capture", "--contract", contract, "--trace-root", ws, "--captures", captures];
    case "finalize":
      // Fold the discovered background binding in (the resolver only sets this flag when capture
      // recommended a full-frame layer set with render order) so the gate is enabled in one pass.
      return [
        "minigame", "finalize", "--contract", contract, "--captures", captures, "--trace-root", ws,
        ...(f.backgroundRecommended ? ["--background", "auto"] : []),
      ];
    case "verify":
      // `--quiet-next`: the wrapper owns the stop-gate footer (the `❌ Not ready …`/`✅ Ready …`
      // line driveRun prints after re-inspecting), so suppress verify's own resolved next step to
      // avoid printing it twice. (The user-facing `commandsFor.verify` stays clean — a dev who runs
      // the printed verify command manually still gets the footer.)
      return ["verify", "--minigame", "--contract", contract, "--captures", captures, "--output", reports, "--strict", "--quiet-next"];
  }
}

/** Injected IO so the orchestration loop is testable without disk or child processes. */
export interface RunDeps {
  /** Gather the workspace facts (the real impl is `inspectWorkspace`). */
  inspect: () => Promise<WorkspaceFacts | { error: string }>;
  /** Execute one step's CLI argv; resolves to its exit code. */
  runStep: (at: ExecutableAt, argv: string[]) => Promise<number>;
  /** Emit a progress/result line. */
  log: (line: string) => void;
}

/**
 * Drive the workspace to a stop gate. PURE of IO (all via `deps`). Returns the process exit
 * code: 0 = reached READY (stop at baseline) or fully done; 1 = NOT READY / CAN'T VERIFY, a
 * step failed, or no progress; 2 = the workspace can't be read.
 */
export async function driveRun(deps: RunDeps, opts: { recordScene?: string } = {}): Promise<number> {
  let lastExecuted: ExecutableAt | "" = "";
  // Backstop: the pipeline is record→capture→finalize→verify→(fix|baseline|done), so it always
  // converges in a handful of steps. A high cap only catches a genuine logic loop.
  for (let guard = 0; guard < 16; guard += 1) {
    const facts = await deps.inspect();
    if ("error" in facts) {
      deps.log(`✗ ${facts.error}`);
      return 2;
    }
    const step = resolveNextStep(facts);

    if (step.at === "done") {
      deps.log(`✅ ${step.summary}`);
      return 0;
    }
    if (step.at === "baseline") {
      // READY — but blessing the reference screens is a human sign-off, so stop here. Same slim
      // `👉 Next — …` footer the standalone verify prints, so the format is identical either way.
      deps.log(`\n${nextStepLines(step.summary, step.command).join("\n")}`);
      return 0;
    }
    if (step.at === "fix") {
      // NOT READY / CAN'T VERIFY — the dev fixes the game (or test setup) and re-runs.
      deps.log(`\n${nextStepLines(step.summary, step.command).join("\n")}`);
      return 1;
    }

    // An executable step (record / capture / finalize / verify).
    if (step.at === lastExecuted) {
      deps.log(`✗ No progress after '${step.at}' — stopping (check the step's output above).`);
      return 1;
    }
    lastExecuted = step.at;
    deps.log(`\n▶ ${step.at} — ${step.summary}`);
    const code = await deps.runStep(step.at, stepArgv(step.at, facts, opts));
    // `verify --strict` exits 1 on NOT READY — that's a verdict, not an executor failure, so
    // re-inspect (the report drives the next step). Any OTHER step's non-zero exit is a real stop.
    if (code !== 0 && step.at !== "verify") {
      deps.log(`✗ '${step.at}' exited ${code} — stopping. Fix it, then re-run \`loombridge minigame run\`.`);
      return code;
    }
  }
  deps.log("✗ Too many steps — stopping (possible loop). Run `loombridge minigame next` to inspect.");
  return 1;
}

/** Re-exec THIS CLI (same node + entry) with the given argv, streaming to the terminal.
 *  Under `node --test` fd 1 is the runner's serialized channel, so we capture and re-emit
 *  rather than handing that fd to the child — see shared/child-stdio.ts. */
function spawnCli(argv: string[]): number {
  const entry = process.argv[1];
  const res = spawnSync(process.execPath, [entry, ...argv], childStepStdio());
  forwardCapturedOutput(res);
  if (res.error) {
    console.error(`[loombridge minigame] run: could not spawn step: ${res.error.message}`);
    return 1;
  }
  return res.status ?? 1;
}

interface ParsedRunArgs {
  id?: string;
  workspace?: string;
  // setup pass-throughs (used only when the workspace needs first-time setup)
  project?: string;
  scene?: string;
  visualProfile?: string;
  gatedOutcome?: boolean;
  noGatedOutcome?: boolean;
  force?: boolean;
  /** Scene the record step RESETS to (a hub→game flow): the contract stays the scanned `--scene`,
   *  but the demonstration starts here. Asset path; defaults to the contract scene. */
  recordScene?: string;
}

/** Map the run flags to setup's flag shape (so `run` reuses setup's resolver verbatim). */
function toSetupFlags(a: ParsedRunArgs): SetupFlags {
  return {
    id: a.id,
    project: a.project,
    scene: a.scene,
    workspace: a.workspace,
    visualProfile: a.visualProfile,
    // tri-state: --gated-outcome → true, --no-gated-outcome → false, neither → ask (TTY) / false.
    gatedOutcome: a.gatedOutcome === true ? true : a.noGatedOutcome === true ? false : undefined,
    force: a.force ?? false,
  };
}

function printUsage(): void {
  console.error(
    [
      "Usage: loombridge minigame run [--id <id>] [setup flags]",
      "",
      "Drive the whole release check end to end: setup (if needed) → record → capture →",
      "finalize → verify. Run it with NO flags and it asks for each value it needs, one at a",
      "time (same prompts as `minigame setup`). Resumable — re-run to continue from where it",
      "stopped. Pauses for the interactive record step (you play the game), then auto-continues.",
      "Stops at the verdict: NOT READY (fix + re-run) or READY (approve the baseline to finish).",
      "",
      "Options (any missing value is PROMPTED for the first run, when stdin is a TTY):",
      "  --id <kebab-id>          Mini-game id (resolves the workspace; prompted if omitted).",
      "  --workspace <dir>        Workspace dir (default: ~/.loombridge/projects/<id>).",
      "  --project <path>         Unity project path.",
      "  --scene <Assets/..unity> Scene the game lives in.",
      "  --visual-profile <p>     phone-portrait | phone-landscape | tablet-portrait | tablet-landscape.",
      "  --gated-outcome / --no-gated-outcome   Win/return is RNG/skill-gated (not asserted).",
      "  --force                  Re-run setup even if the workspace already has a contract.",
      "",
      "Exit: 0 reached READY (approve baseline to finish) / done · 1 NOT READY or a step failed · 2 usage / non-TTY missing value.",
    ].join("\n"),
  );
}

/** Run `loombridge minigame run`. */
export async function runRun(argv: string[], root: string = process.cwd()): Promise<number> {
  const a: ParsedRunArgs = {};
  const need = (i: number, flag: string): string | null => {
    const v = argv[i];
    if (v === undefined || v.startsWith("--")) {
      console.error(`[loombridge minigame] run: ${flag} requires a value.`);
      return null;
    }
    return v;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      printUsage();
      return 0;
    } else if (arg === "--id") {
      const v = need((i += 1), "--id"); if (v === null) return 2; a.id = normalizeWorkspaceId(v);
      if (a.id !== v) console.error(`[loombridge minigame] run: using id '${a.id}' (normalized from '${v}').`);
    } else if (arg === "--workspace") {
      const v = need((i += 1), "--workspace"); if (v === null) return 2; a.workspace = path.resolve(root, v);
    } else if (arg === "--project") {
      const v = need((i += 1), "--project"); if (v === null) return 2; a.project = v;
    } else if (arg === "--scene") {
      const v = need((i += 1), "--scene"); if (v === null) return 2; a.scene = v;
    } else if (arg === "--record-scene") {
      const v = need((i += 1), "--record-scene"); if (v === null) return 2;
      if (!isScenePath(v)) { console.error(`[loombridge minigame] run: --record-scene '${v}' must be an Assets/**.unity path.`); return 2; }
      a.recordScene = v;
    } else if (arg === "--visual-profile") {
      const v = need((i += 1), "--visual-profile"); if (v === null) return 2; a.visualProfile = v;
    } else if (arg === "--gated-outcome") {
      a.gatedOutcome = true;
    } else if (arg === "--no-gated-outcome") {
      a.noGatedOutcome = true;
    } else if (arg === "--force") {
      a.force = true;
    } else {
      console.error(`[loombridge minigame] run: unknown argument "${arg}".`);
      return 2;
    }
  }

  // RESUME: when a workspace is already addressable (--id / --workspace) and has a contract,
  // pick up the flow without re-prompting or re-scaffolding. `--force` opts back into setup.
  const candidate = a.workspace ?? (a.id ? defaultWorkspace(a.id) : undefined);
  if (candidate && !a.force && !("error" in (await inspectWorkspace(candidate)))) {
    return drive(candidate, a.recordScene);
  }

  // FIRST-TIME SETUP: resolve the config the SAME way `minigame setup` does — every missing
  // value is PROMPTED one at a time when stdin is a TTY (so a dev needn't know the flags), or
  // reported as a usage error when non-interactive. Then scaffold via the shared helper.
  const interactive = process.stdin.isTTY === true;
  let rl: readline.Interface | undefined;
  const ask: Asker | undefined = interactive
    ? (prompt) => {
        rl ??= readline.createInterface({ input: process.stdin, output: process.stderr });
        return rl.question(prompt);
      }
    : undefined;
  let resolution: Awaited<ReturnType<typeof resolveSetupConfig>>;
  try {
    resolution = await resolveSetupConfig(toSetupFlags(a), { root, interactive, ask });
  } finally {
    rl?.close();
  }
  if ("usage" in resolution) {
    console.error(
      `[loombridge minigame] run: ${resolution.usage}.\n` +
        "Run it in an interactive terminal to be prompted, or pass --id/--project/--scene/--visual-profile.",
    );
    return 2;
  }
  const config = resolution.config;
  const setupCode = await scaffoldWorkspace(config, root, a.force ?? false, { checklist: false });
  if (setupCode !== 0) return setupCode;

  return drive(config.workspace, a.recordScene);
}

/** Wire the real IO (inspect + subprocess per step) and drive the workspace to a stop gate. */
function drive(workspace: string, recordScene?: string): Promise<number> {
  return driveRun(
    {
      inspect: () => inspectWorkspace(workspace),
      runStep: async (_at, stepArgvList) => spawnCli(stepArgvList),
      log: (line) => console.log(line),
    },
    { recordScene },
  );
}
