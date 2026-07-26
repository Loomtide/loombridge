/**
 * `loombridge minigame check` — drift-aware single entry point.
 *
 * This composes the existing S8 pieces:
 *  - scan bootstraps a reviewed draft when no contract exists;
 *  - sync guards structural drift and stops for developer-confirmed migration;
 *  - run owns the capture/finalize/verify loop and all verdict/report semantics.
 */

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { ICON, unityConnectionHint } from "../../shared/cli-ui.js";
import { idFromScene, runScan } from "./minigame-scan.js";
import { defaultWorkspace, findContract, nextStepLinesFor } from "./minigame-next.js";
import { runRun } from "./minigame-run.js";
import {
  locatorPath,
  scanContractDiff,
  type ContractDiff,
} from "./minigame-sync.js";
import { assertValidMinigameContract } from "./profiles/validator.js";
import { isScenePath } from "./profiles/types.js";
import { normalizeWorkspaceId } from "../../domain/workspace-paths.js";
import { runSceneAgnosticCheckCli } from "./minigame-scene-entry.js";

export interface CheckDeps {
  hasContract: () => Promise<boolean>;
  runScanStep: () => Promise<number>;
  syncDiff: () => Promise<ContractDiff>;
  delegateToRun: () => Promise<number>;
  /** The resolved next-step footer lines for the workspace (exact record command + stateSignal note). */
  nextSteps: () => Promise<string[]>;
  /**
   * After a fresh scan bootstrap, continue STRAIGHT THROUGH into the run loop (record → capture →
   * finalize → verify) so the whole flow is ONE command. True only on an interactive terminal (the
   * record step pauses for you to play) and not `--bootstrap-only`. When false (non-TTY/CI, or
   * opt-out) the bootstrap stops after writing the draft and prints the next step, as before.
   */
  continueThroughRecord: boolean;
  log: (line: string) => void;
}

/**
 * Whether `check` should continue STRAIGHT THROUGH the interactive record into the run loop (the
 * one-command flow), vs stop after the draft. Only on a real terminal (the record step pauses for the
 * dev to play — a non-TTY can't, and `trace record` itself refuses non-TTY stdin) and unless the dev
 * asked to stop. Strict `=== true`: an undefined `isTTY` (piped/redirected) is NOT a terminal.
 */
export function continueThroughRecordFor(isTTY: boolean | undefined, bootstrapOnly: boolean): boolean {
  return isTTY === true && !bootstrapOnly;
}

/**
 * True when the workspace an id resolved ALREADY holds a contract for a DIFFERENT scene than the one
 * the dev asked about — so resuming it would verify/overwrite the wrong game. Compared by basename
 * (the practical identity). A fresh workspace (no existing scene) never conflicts.
 */
export function scenesConflict(wantScene: string, existingScene: string | undefined): boolean {
  if (!existingScene) return false;
  return path.basename(existingScene) !== path.basename(wantScene);
}

/** A BOUND object moved or vanished — structural drift that must stop for the dev. */
function breakingDrift(diff: ContractDiff): boolean {
  return diff.relocated.length > 0 || diff.removed.length > 0;
}

function driftReviewLines(diff: ContractDiff): string[] {
  const lines = ["The scene changed — review the structural contract migration before verifying:"];
  for (const relocated of diff.relocated) {
    lines.push(`  relocated: ${relocated.ref.id}: ${locatorPath(relocated.fromLocator)} -> ${locatorPath(relocated.toLocator)}`);
  }
  for (const ref of diff.removed) {
    lines.push(`  removed: ${ref.id}: ${locatorPath(ref.locator)}`);
  }
  lines.push("Review and apply with `loombridge minigame sync --scene ... --apply [--add] [--remove]`, then re-run `loombridge minigame check`.");
  return lines;
}

/** Dependency-injected orchestration core, unit-testable without Unity or subprocesses. */
export async function driveCheck(deps: CheckDeps): Promise<number> {
  if (!(await deps.hasContract())) {
    const scanCode = await deps.runScanStep();
    if (scanCode !== 0) return scanCode;
    // ONE-COMMAND flow (interactive): the scan already auto-detected the controls + stateSignal, so
    // continue straight through into record → capture → finalize → verify instead of stopping. The
    // record step pauses for you to play; the rest auto-continues to the verdict.
    if (deps.continueThroughRecord) {
      deps.log("Draft written from the scene scan — running the full flow (record → capture → verify) in one go…");
      return deps.delegateToRun();
    }
    // Non-interactive (or --bootstrap-only): stop after the draft. Route the "next" through the SAME
    // resolver `minigame next` uses so the dev gets the EXACT record command (with `--state-signal`
    // threaded) + the stateSignal note, then re-runs check.
    const nextLines = await deps.nextSteps();
    deps.log(
      [
        "Draft contract written from the scene scan — review/edit it, then:",
        ...nextLines,
        "After recording, re-run `loombridge minigame check`.",
      ].join("\n"),
    );
    return 0;
  }

  const diff = await deps.syncDiff();

  // A BOUND object moved or vanished is structural drift — stop for the dev FIRST (before any
  // "continuing" note). A same-leaf relocation is only a proposal, not a semantic proof, so check
  // never auto-applies it.
  if (breakingDrift(diff)) {
    deps.log(driftReviewLines(diff).join("\n"));
    return 0;
  }

  // No blocking drift — new scanned controls are INFORMATIONAL, not a stop: a contract may
  // legitimately bind a SUBSET of the scene's controls, so an unbound control is not drift.
  if (diff.added.length > 0) {
    deps.log(
      [
        `Found ${diff.added.length} new control(s) not bound by the contract (a contract may bind a subset):`,
        ...diff.added.map((a) => `  ${a.candidate.id}: ${locatorPath(a.candidate.locator)}`),
        "Run `loombridge minigame sync --scene ... --apply --add` to adopt them. Continuing the check.",
      ].join("\n"),
    );
  }

  return deps.delegateToRun();
}

interface ParsedCheckArgs {
  /** Absent ⇒ the scene-agnostic record-first flow (resolves the active scene, infers + scans each). */
  scene?: string;
  id: string;
  bootstrapOnly: boolean;
  /** The raw `--id` when it was canonicalized (e.g. `StarChef`), so the caller can show a notice. */
  normalizedFrom?: string;
  /** Scene the record step RESETS to (hub→game): scan/contract use `--scene`, the demo starts here. */
  recordScene?: string;
}

export function parseArgs(argv: string[]): ParsedCheckArgs | { help: true } | { error: string } {
  let scene: string | undefined;
  let id: string | undefined;
  let bootstrapOnly = false;
  let recordScene: string | undefined;
  const take = (i: number, name: string): string | { error: string } => {
    const v = argv[i];
    if (v === undefined || v.startsWith("--")) return { error: `${name} requires a value` };
    return v;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return { help: true };
    if (arg === "--scene") {
      const v = take((i += 1), arg);
      if (typeof v !== "string") return v;
      scene = v;
    } else if (arg === "--id") {
      const v = take((i += 1), arg);
      if (typeof v !== "string") return v;
      id = v;
    } else if (arg === "--bootstrap-only") {
      bootstrapOnly = true;
    } else if (arg === "--record-scene") {
      const v = take((i += 1), arg);
      if (typeof v !== "string") return v;
      recordScene = v;
    } else {
      return { error: `unknown argument "${arg}"` };
    }
  }
  // SCENE-AGNOSTIC (no `--scene`): record-first. There's no scene to derive an id from, so `--id` is
  // required. The flow resolves the active scene, infers the scenes the playthrough visited, and scans
  // each — no `--scene`/`--record-scene` needed (a `--record-scene` without `--scene` is meaningless).
  if (!scene) {
    if (!id) return { error: "--scene <Assets/...unity> is required, OR pass --id <id> to record-first without a scene" };
    if (recordScene !== undefined) return { error: "--record-scene needs --scene (it's the hub→game reset for the scene-first flow)" };
    // --bootstrap-only writes the draft from a scene SCAN and stops before record — but the scene-agnostic
    // flow records FIRST (the scan needs the recorded scenes), so "stop before record" is meaningless here.
    if (bootstrapOnly) return { error: "--bootstrap-only isn't supported without --scene (the scene-agnostic flow records before it can scan)" };
    const resolvedId = normalizeWorkspaceId(id);
    return { id: resolvedId, bootstrapOnly: false, normalizedFrom: id !== resolvedId ? id : undefined };
  }
  if (!isScenePath(scene)) return { error: `--scene '${scene}' must be an Assets/**.unity path` };
  if (recordScene !== undefined && !isScenePath(recordScene)) {
    return { error: `--record-scene '${recordScene}' must be an Assets/**.unity path` };
  }
  // Accept any reasonable --id and canonicalize it (StarChef → star-chef) instead of rejecting — the
  // id is also a folder + filename, so it must be lowercase-kebab, but we do that FOR the dev (the same
  // normalization the scene-derived default uses) rather than make them retype it.
  const resolvedId = id !== undefined ? normalizeWorkspaceId(id) : idFromScene(scene);
  return { scene, id: resolvedId, bootstrapOnly, recordScene, normalizedFrom: id !== undefined && id !== resolvedId ? id : undefined };
}

function printUsage(): void {
  console.log(
    [
      "Usage: loombridge minigame check (--scene <Assets/...unity> | --id <id>) [--id <id>] [--record-scene <s>] [--bootstrap-only]",
      "",
      "ONE-COMMAND release check. From scratch on an interactive terminal it runs the WHOLE",
      "flow — scan (auto-detect controls + stateSignal) → record (you play, then press Enter)",
      "→ capture → finalize → verify — and stops at the verdict. Drift-aware + resumable: re-run",
      "to continue from wherever it stopped.",
      "",
      "SCENE-AGNOSTIC (no --scene, just --id): records FIRST from the editor's current scene,",
      "infers the scenes your playthrough visited (e.g. home → game), scans + grades each, and",
      "groups the verdict per scene. Any scene it can't grade is reported can't-verify (never a",
      "silent pass). Requires an interactive editor session.",
      "",
      "Options:",
      "  --scene <path>     Unity scene path under Assets/ ending in .unity (required) — scanned for the contract.",
      "  --id <kebab-id>    Workspace id (default: derived from scene filename).",
      "  --record-scene <p> Scene the demonstration STARTS on (a hub→game flow: --scene is the game, this is",
      "                     the home/hub). The record step resets here; the contract stays the scanned scene.",
      "  --bootstrap-only   Just write the draft from the scan and stop (don't run record/verify).",
      "",
      "Exit: guided stops return 0; the delegated run preserves READY/NOT-READY/CAN'T-VERIFY semantics.",
    ].join("\n"),
  );
}

export async function runCheck(argv: string[], root: string = process.cwd()): Promise<number> {
  const parsed = parseArgs(argv);
  if ("help" in parsed) {
    printUsage();
    return 0;
  }
  if ("error" in parsed) {
    console.error(`[loombridge minigame] check: ${parsed.error}.`);
    printUsage();
    return 2;
  }
  if (parsed.normalizedFrom) {
    console.error(`[loombridge minigame] check: using id '${parsed.id}' (normalized from '${parsed.normalizedFrom}' — ids are lowercase-kebab folders).`);
  }

  // SCENE-AGNOSTIC branch: no `--scene` ⇒ the record-first flow (resolve active scene → infer → scan
  // each → fuse → grade). Branches BEFORE the scene-dependent scan/sync/run path, which is untouched.
  if (!parsed.scene) {
    try {
      return await runSceneAgnosticCheckCli(parsed.id, root);
    } catch (error) {
      const hint = unityConnectionHint(error);
      console.error(hint ? hint.join("\n") : `${ICON.fail} check failed: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
  }
  const scene = parsed.scene; // narrowed: the scene-first flow below uses a guaranteed scene path.

  const workspace = defaultWorkspace(parsed.id);
  const contractPath = path.join(workspace, `${parsed.id}.minigame.json`);
  let cachedContractPath: string | null | undefined;
  const resolveContract = async (): Promise<string | null> => {
    cachedContractPath ??= await findContract(workspace);
    return cachedContractPath;
  };
  const readContract = async () => {
    const p = await resolveContract();
    if (!p) throw new Error(`no contract found in ${workspace}`);
    return assertValidMinigameContract(JSON.parse(await fs.readFile(p, "utf-8")));
  };

  // Scene-binding guard: a workspace id resolves a FOLDER. If that folder already holds a contract for
  // a DIFFERENT scene — e.g. two games whose names normalize to the same id, or a junk id that collapses
  // to the same canonical bucket — refuse rather than silently resume/overwrite the other game's
  // workspace and verify the WRONG contract. A same-scene resume (the normal case) passes through.
  const existing = await resolveContract();
  if (existing) {
    try {
      const existingScene = (await readContract()).scenes?.[0];
      if (scenesConflict(scene, existingScene)) {
        console.error(
          `[loombridge minigame] check: workspace id '${parsed.id}' already exists for scene '${path.basename(existingScene!)}', ` +
            `but --scene is '${path.basename(scene)}'. Two games can't share a workspace — pass a different --id for this one.`,
        );
        return 2;
      }
    } catch {
      // An unreadable existing contract isn't this guard's concern — driveCheck/verify surface it.
    }
  }

  try {
    return await driveCheck({
      hasContract: async () => (await resolveContract()) !== null,
      // `--quiet-next`: check owns the bootstrap "next" footer (it adds the re-run-check loop), so
      // suppress scan's own footer to avoid printing the record step twice.
      runScanStep: () => runScan(["--scene", scene, "--id", parsed.id, "--output", contractPath, "--quiet-next"], root),
      syncDiff: async () => scanContractDiff(scene, await readContract()),
      delegateToRun: () => runRun(["--id", parsed.id, "--scene", scene, ...(parsed.recordScene ? ["--record-scene", parsed.recordScene] : [])], root),
      nextSteps: () => nextStepLinesFor(workspace),
      // One-command flow: continue through the interactive record only on a real terminal (it pauses
      // for you to play) and unless the dev asked to stop after the draft.
      continueThroughRecord: continueThroughRecordFor(process.stdin.isTTY, parsed.bootstrapOnly),
      log: (line) => console.log(line),
    });
  } catch (error) {
    const hint = unityConnectionHint(error);
    console.error(hint ? hint.join("\n") : `${ICON.fail} check failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
