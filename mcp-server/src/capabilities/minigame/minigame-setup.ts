/**
 * `loombridge minigame setup` — guided first-time onboarding (a WRAPPER, not a new
 * engine).
 *
 * Power/CI users keep driving the proven low-level verbs directly:
 *
 *   loombridge minigame init
 *   loombridge trace record/replay
 *   loombridge verify --minigame
 *   loombridge minigame baseline approve|status
 *
 * `setup` is the friendly front door for someone running the mini-game release
 * check for the FIRST time: it gathers the handful of facts those verbs need
 * (game id, Unity project, scene, device shape), lays out a clean
 * external workspace, scaffolds a ready-to-use starter contract (reusing the SAME
 * `buildScaffoldContract` as `init`), and prints the exact next commands. It runs
 * no gates, changes no game, and does not touch the verifier engine.
 *
 * It is scriptable (all values can be passed as flags) AND interactive (missing
 * values are prompted ONLY when stdin is a TTY). In a non-TTY (CI) with required
 * values missing it refuses with exit 2 rather than hanging on a prompt.
 *
 * Exit codes:
 *   0  workspace + contract scaffolded
 *   2  usage / missing required value in a non-TTY / invalid flag value
 *   1  unexpected filesystem or runtime error
 */

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";

import { buildScaffoldContract } from "./minigame-scaffold.js";
import { ICON } from "../../shared/cli-ui.js";
import { formatNextStep, resolveNextStep } from "./minigame-next.js";
import { assertValidMinigameContract } from "./profiles/validator.js";
import {
  MINIGAME_ID_PATTERN,
  VISUAL_PROFILE_IDS,
  isScenePath,
} from "./profiles/types.js";
import {
  isInside,
  normalizeWorkspaceId,
  projectWorkspace,
  sanitizeWorkspaceId,
} from "../../domain/workspace-paths.js";

/** Raw flags parsed from `setup`'s argv (every value optional — resolution fills gaps). */
export interface SetupFlags {
  id?: string;
  project?: string;
  scene?: string;
  workspace?: string;
  visualProfile?: string;
  /** Tri-state: true/false set explicitly via flags; undefined ⇒ ask (TTY) or default false. */
  gatedOutcome?: boolean;
  force: boolean;
}

/** The fully-resolved configuration the scaffold + checklist are built from. */
export interface SetupConfig {
  id: string;
  project: string;
  scene: string;
  /** Absolute workspace dir. */
  workspace: string;
  visualProfile: string;
  /** The win/reward is gated by gameplay outcome a read-only replay can't drive. */
  gatedOutcome: boolean;
}

/**
 * The fixed set of subdirectories `setup` lays out under the workspace. Everything
 * for a mini-game lives FLAT under `~/.loombridge/projects/<id>/` — `traces/` holds the
 * recorded trace, `reports/` the verify + replay reports, `captures/` the capture pack,
 * `baseline/` the approved baselines. No nested `.loombridge/`, no separate replay root.
 */
export const WORKSPACE_SUBDIRS = [
  "traces",
  "captures",
  "reports",
  "baseline",
  "raw",
] as const;

/** A prompt function — injected so the interactive path is testable. Returns the raw line. */
export type Asker = (prompt: string) => Promise<string>;

/**
 * Lowercase-kebab a folder name into a candidate mini-game id, or undefined if it
 * can't. Aliases the shared resolver so the mini-game and feel flows derive ids
 * identically. Re-exported for existing callers/tests that import it from here.
 */
export const sanitizeToId = sanitizeWorkspaceId;

/**
 * The default workspace path for an id: `~/.loombridge/projects/<id>`. Deliberately
 * under the user's home, NOT cwd — running `setup` from inside the Unity project must
 * not drop generated artifacts into the game repo (the "keep the project clean" rule).
 */
export const defaultWorkspace = projectWorkspace;

export { isInside };

function parseFlags(rest: string[]): SetupFlags | { error: string } {
  const flags: SetupFlags = { force: false };
  const take = (i: number, name: string): string | { error: string } => {
    const v = rest[i];
    if (v === undefined || v.startsWith("--")) return { error: `${name} requires a value` };
    return v;
  };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    let v: string | { error: string };
    switch (arg) {
      case "--id":
        v = take((i += 1), arg);
        if (typeof v !== "string") return v;
        flags.id = normalizeWorkspaceId(v); // StarChef → star-chef, like every other workspace --id entry point
        break;
      case "--project":
        v = take((i += 1), arg);
        if (typeof v !== "string") return v;
        flags.project = v;
        break;
      case "--scene":
        v = take((i += 1), arg);
        if (typeof v !== "string") return v;
        flags.scene = v;
        break;
      case "--workspace":
        v = take((i += 1), arg);
        if (typeof v !== "string") return v;
        flags.workspace = v;
        break;
      case "--visual-profile":
        v = take((i += 1), arg);
        if (typeof v !== "string") return v;
        flags.visualProfile = v;
        break;
      case "--gated-outcome":
        flags.gatedOutcome = true;
        break;
      case "--no-gated-outcome":
        flags.gatedOutcome = false;
        break;
      case "--force":
      case "-f":
        flags.force = true;
        break;
      default:
        return { error: `unknown argument "${arg}"` };
    }
  }
  return flags;
}

/** Per-field resolution spec: how to validate it and (interactively) what to suggest. */
interface FieldSpec {
  /** The flag that supplies it non-interactively (used in the missing-value error). */
  flag: string;
  /** A prompt question (interactive only). */
  question: string;
  /** A default offered interactively — pressing Enter accepts it. */
  suggested?: string;
  /** Return an error string if invalid, else null. */
  validate: (value: string) => string | null;
}

const okIfNonEmpty = (value: string): string | null =>
  value.trim().length > 0 ? null : "must not be empty";

/**
 * Resolve all required fields from flags, prompting for any that are missing when
 * `interactive`. Returns a `SetupConfig` plus the resolved (absolute) workspace, or
 * a usage error (invalid flag value, or — in a non-TTY — a missing required value).
 */
export async function resolveSetupConfig(
  flags: SetupFlags,
  opts: { root: string; interactive: boolean; ask?: Asker },
): Promise<{ config: SetupConfig } | { usage: string }> {
  const { root, interactive } = opts;
  const ask = opts.ask;

  type PromptKey = "id" | "project" | "scene" | "visualProfile";
  const idSuggestion = sanitizeToId(path.basename(root));
  const specs: Record<PromptKey, FieldSpec> = {
    id: {
      flag: "--id",
      question: "Mini-game id (lowercase-kebab)",
      suggested: idSuggestion,
      validate: (v) =>
        MINIGAME_ID_PATTERN.test(v)
          ? null
          : "must be lowercase kebab-case (letters, digits, hyphens; start with a letter)",
    },
    project: {
      flag: "--project",
      question: "Unity project path",
      suggested: root,
      validate: okIfNonEmpty,
    },
    scene: {
      flag: "--scene",
      question: "Scene path (Assets/.../X.unity)",
      suggested: idSuggestion ? `Assets/Scenes/${idSuggestion}.unity` : undefined,
      validate: (v) =>
        isScenePath(v) ? null : "must be a Unity scene path under Assets/ ending in .unity",
    },
    visualProfile: {
      flag: "--visual-profile",
      question: `Visual profile (${[...VISUAL_PROFILE_IDS].join(" | ")})`,
      suggested: "phone-portrait",
      validate: (v) =>
        VISUAL_PROFILE_IDS.has(v) ? null : `must be one of: ${[...VISUAL_PROFILE_IDS].join(", ")}`,
    },
  };

  const provided: Record<PromptKey, string | undefined> = {
    id: flags.id,
    project: flags.project,
    scene: flags.scene,
    visualProfile: flags.visualProfile,
  };

  const resolved: Partial<Record<PromptKey, string>> = {};
  const missing: string[] = [];

  for (const key of Object.keys(specs) as PromptKey[]) {
    const spec = specs[key];
    const supplied = provided[key];
    if (supplied !== undefined) {
      const err = spec.validate(supplied);
      if (err) return { usage: `${spec.flag} ${err} (got "${supplied}")` };
      resolved[key] = supplied;
      continue;
    }
    if (interactive && ask) {
      const value = await promptField(ask, spec);
      if (value === null) return { usage: `${spec.flag} was not provided` };
      resolved[key] = value;
      continue;
    }
    missing.push(spec.flag);
  }

  if (missing.length > 0) {
    return {
      usage: `missing required value(s): ${missing.join(", ")} (stdin is not a TTY — pass them as flags)`,
    };
  }

  const workspace = flags.workspace
    ? path.resolve(root, flags.workspace)
    : defaultWorkspace(resolved.id!);

  // Refuse a workspace inside the Unity project — generated artifacts must never
  // pollute the game repo (covers both an explicit bad --workspace and any future
  // default that resolves into the project).
  const projectAbs = path.resolve(root, resolved.project!);
  if (isInside(workspace, projectAbs)) {
    return {
      usage:
        `workspace ${workspace} is inside the Unity project ${projectAbs} — ` +
        `pass --workspace <dir> outside it (the default is ${defaultWorkspace(resolved.id!)})`,
    };
  }

  // Outcome-gating: explicit flag wins; else ask (TTY) once; else default false. It's an
  // honest, human-declared claim ("the win is gated by gameplay outcome a replay can't
  // drive") — never inferred, so a deterministic game is never silently un-verified.
  let gatedOutcome = flags.gatedOutcome;
  if (gatedOutcome === undefined && interactive && ask) {
    gatedOutcome = await askYesNo(
      ask,
      "Is the win/reward gated by gameplay OUTCOME (correct answers / RNG / skill) an automated replay can't reproduce?",
      false,
    );
  }

  return {
    config: {
      id: resolved.id!,
      project: resolved.project!,
      scene: resolved.scene!,
      workspace,
      visualProfile: resolved.visualProfile!,
      gatedOutcome: gatedOutcome ?? false,
    },
  };
}

/** Ask a yes/no question; empty input takes `dflt`. Re-asks on unrecognized input (capped). */
async function askYesNo(ask: Asker, question: string, dflt: boolean): Promise<boolean> {
  const hint = dflt ? "[Y/n]" : "[y/N]";
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const raw = (await ask(`${question} ${hint}: `)).trim().toLowerCase();
    if (raw === "") return dflt;
    if (raw === "y" || raw === "yes") return true;
    if (raw === "n" || raw === "no") return false;
    process.stderr.write("  (answer y or n)\n");
  }
  return dflt;
}

/** Prompt for one field, re-asking on invalid input (capped). Returns null if abandoned. */
async function promptField(ask: Asker, spec: FieldSpec): Promise<string | null> {
  const hint = spec.suggested ? ` [${spec.suggested}]` : "";
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const raw = (await ask(`${spec.question}${hint}: `)).trim();
    const value = raw.length === 0 && spec.suggested !== undefined ? spec.suggested : raw;
    if (value.length === 0) {
      process.stderr.write("  (a value is required)\n");
      continue;
    }
    const err = spec.validate(value);
    if (!err) return value;
    process.stderr.write(`  ${err}\n`);
  }
  return null;
}

/** Display a path relative to cwd when that's shorter/cleaner, else absolute. */
function display(root: string, target: string): string {
  const rel = path.relative(root, target);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : target;
}

/**
 * Build the guided first step (pure, so tests can assert it). Just the ONE next command —
 * the rest is resolved one step at a time by `loombridge minigame next`, so the guidance can
 * never go stale. Reuses the SAME resolver every step's footer uses.
 */
export function buildNextStepsChecklist(config: SetupConfig, _root: string): string[] {
  const step = resolveNextStep({
    id: config.id,
    scene: config.scene,
    workspace: config.workspace,
    traceRecorded: false,
    capturesPresent: false,
    contractFinalized: false,
    verify: null,
    baselineApproved: false,
    backgroundRecommended: false,
  });
  const gatedNote = config.gatedOutcome
    ? [`${ICON.gated} Outcome-gated: you only need to record up to the active play screen — reaching the win is optional.`, ""]
    : [];
  return [
    ...gatedNote,
    ...formatNextStep(step),
    "",
    `(Run \`loombridge minigame next --id ${config.id}\` anytime to see your next step.)`,
  ];
}

/**
 * Run `minigame setup`. `argv` is the post-`setup` remainder. `root` defaults to cwd
 * (overridable for tests). Returns the process exit code.
 */
export async function runSetup(argv: string[], root: string = process.cwd()): Promise<number> {
  if (argv[0] === "--help" || argv[0] === "-h") {
    printUsage();
    return 0;
  }

  const flags = parseFlags(argv);
  if ("error" in flags) {
    console.error(`[loombridge minigame] setup: ${flags.error}.`);
    printUsage();
    return 2;
  }

  const interactive = process.stdin.isTTY === true;
  let rl: readline.Interface | undefined;
  const ask: Asker | undefined = interactive
    ? (prompt) => {
        rl ??= readline.createInterface({ input: process.stdin, output: process.stderr });
        return rl.question(prompt);
      }
    : undefined;

  let resolution: { config: SetupConfig } | { usage: string };
  try {
    resolution = await resolveSetupConfig(flags, { root, interactive, ask });
  } finally {
    rl?.close();
  }

  if ("usage" in resolution) {
    console.error(`[loombridge minigame] setup: ${resolution.usage}.`);
    if (!interactive) printUsage();
    return 2;
  }
  const config = resolution.config;
  return scaffoldWorkspace(config, root, flags.force, { checklist: true });
}

/**
 * Lay out the workspace + scaffold the contract for a resolved config. Extracted from `runSetup`
 * so `minigame run` reuses the SAME scaffolding (and the same "already exists" guard) after
 * resolving the config interactively — one source of truth. `checklist` prints the guided next
 * steps (setup wants them; `run` drives the steps itself so it skips them). Returns the exit code.
 */
export async function scaffoldWorkspace(
  config: SetupConfig,
  root: string,
  force: boolean,
  opts: { checklist: boolean } = { checklist: true },
): Promise<number> {
  // 1. Lay out the external workspace.
  try {
    for (const sub of WORKSPACE_SUBDIRS) {
      await fs.mkdir(path.join(config.workspace, sub), { recursive: true });
    }
  } catch (error) {
    console.error(`[loombridge minigame] setup: could not create workspace ${config.workspace}: ${message(error)}`);
    return 1;
  }

  // 2. Scaffold the contract (same builder as `minigame init`), validated before emit.
  const contractPath = path.join(config.workspace, `${config.id}.minigame.json`);
  let exists = false;
  try {
    await fs.access(contractPath);
    exists = true;
  } catch {
    // does not exist — fine
  }
  if (exists && !force) {
    console.error(
      `[loombridge minigame] setup: ${display(root, contractPath)} already exists — refusing to overwrite. ` +
        "Pass --force to replace it (this discards your edits).",
    );
    return 2;
  }

  try {
    const contract = buildScaffoldContract(config.id, {
      scene: config.scene,
      visualProfile: config.visualProfile,
      gatedOutcome: config.gatedOutcome,
    });
    // A scaffold that doesn't validate is a bug here, not a user error — fail loudly.
    assertValidMinigameContract(contract);
    await fs.writeFile(contractPath, `${JSON.stringify(contract, null, 2)}\n`, "utf-8");
  } catch (error) {
    console.error(`[loombridge minigame] setup: could not write contract ${contractPath}: ${message(error)}`);
    return 1;
  }

  console.error(
    `${ICON.workspace} Workspace ready at ${display(root, config.workspace)} ` +
      `(${WORKSPACE_SUBDIRS.join("/ ")}/) — contract scaffolded for '${config.id}'.`,
  );
  if (opts.checklist) console.log(buildNextStepsChecklist(config, root).join("\n"));
  return 0;
}

function printUsage(): void {
  console.error(
    [
      "Usage: loombridge minigame setup [options]",
      "",
      "Guided first-time setup for the mini-game release check: lays out an external",
      "workspace, scaffolds a contract, and prints the next commands. A wrapper over the",
      "proven verbs (init / trace / verify --minigame / baseline) — it changes no game and",
      "runs no gates.",
      "",
      "Options (any missing required value is prompted when stdin is a TTY):",
      "  --id <kebab-id>          Mini-game id (default: from the current folder name).",
      "  --project <path>         Unity project path.",
      "  --scene <Assets/..unity> Scene the game lives in.",
      "  --workspace <dir>        Workspace dir (default: ~/.loombridge/projects/<id>; must be",
      "                           OUTSIDE the Unity project).",
      "  --visual-profile <phone-portrait|...>  Device shape.",
      "  --gated-outcome          The win/reward is gated by gameplay outcome (correct answers /",
      "                           RNG / skill) a read-only replay can't reproduce — marks the",
      "                           win + return states NOT-ASSERTED (verify never fails on them).",
      "  --no-gated-outcome       Force off (skip the question). Default: ask when interactive, else off.",
      "  --force                  Overwrite an existing contract in the workspace.",
      "",
      "Exit: 0 scaffolded · 2 usage / missing required value in a non-TTY · 1 fs/runtime error.",
    ].join("\n"),
  );
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
