/**
 * `loombridge minigame` — mini-game helper verb (S6e).
 *
 * Today this hosts the baseline-regression lifecycle, kept OFF the read-only
 * `verify` surface because `approve` MUTATES (it writes the approved baseline
 * bundle):
 *
 *   loombridge minigame baseline approve --contract <c> --captures <d> [--ref <dir>]
 *   loombridge minigame baseline status  --contract <c> [--ref <dir>]
 *
 * `approve` snapshots a PASS verification run's captures into an approved baseline
 * bundle at the contract's `baseline.ref` (or `--ref`). It REFUSES a non-pass run —
 * you must never freeze a broken reference — and it grades WITHOUT comparing to any
 * existing baseline (re-approving an intended change must not be blocked by the old
 * one). `status` is read-only: it prints the current baseline manifest summary.
 *
 * Mutation is confined to the baseline bundle dir (outside the game project); the
 * game is never touched, and the `.loombridge/` build tree is never scaffolded.
 */

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { assertValidMinigameContract } from "./profiles/validator.js";
import { type MinigameContract } from "./profiles/types.js";
import { normalizeWorkspaceId } from "../../domain/workspace-paths.js";
import { buildScaffoldContract } from "./minigame-scaffold.js";
import { runMinigameGates } from "./run-minigame-gates.js";
import { minigameReportStatus, summarize } from "./verify-minigame.js";
import {
  loadBaselineManifest,
  resolveBaselineRef,
  writeBaselineBundle,
} from "./minigame-baseline.js";
import { nowIso } from "../../domain/state.js";

interface BaselineArgs {
  root: string;
  contractPath: string;
  capturesDir?: string;
  ref?: string;
  at?: string;
}

interface InitArgs {
  id: string;
  output?: string;
  force: boolean;
}

type Parsed =
  | { kind: "approve"; args: BaselineArgs }
  | { kind: "status"; args: BaselineArgs }
  | { kind: "init"; args: InitArgs }
  | { kind: "help"; usageError?: boolean };

function parseInitArgs(rest: string[]): InitArgs | { error: string } {
  let id: string | undefined;
  let output: string | undefined;
  let force = false;
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === "--id") id = rest[(i += 1)] ?? "";
    else if (arg === "--output" || arg === "-o") output = path.resolve(rest[(i += 1)] ?? "");
    else if (arg === "--force" || arg === "-f") force = true;
    else return { error: `unknown argument "${arg}"` };
  }
  if (id === undefined || id.length === 0) return { error: "--id <id> is required" };
  return { id: normalizeWorkspaceId(id), output, force };
}

function parseBaselineArgs(rest: string[]): BaselineArgs | { error: string } {
  let root = process.cwd();
  let contractPath: string | undefined;
  let capturesDir: string | undefined;
  let ref: string | undefined;
  let at: string | undefined;
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === "--root") root = path.resolve(rest[(i += 1)] ?? root);
    else if (arg === "--contract") contractPath = path.resolve(rest[(i += 1)] ?? "");
    else if (arg === "--captures") capturesDir = path.resolve(rest[(i += 1)] ?? "");
    else if (arg === "--ref") ref = path.resolve(rest[(i += 1)] ?? "");
    else if (arg === "--at") at = rest[(i += 1)] ?? "";
    else return { error: `unknown argument "${arg}"` };
  }
  if (contractPath === undefined) return { error: "--contract <path> is required" };
  return { root, contractPath, capturesDir, ref, at };
}

function parse(argv: string[]): Parsed {
  // argv here is the post-`minigame` remainder, one of:
  //   [ "init", ...flags ]
  //   [ "baseline", "approve"|"status", ...flags ]
  const group = argv[0];
  if (!group || group === "--help" || group === "-h") return { kind: "help" };

  if (group === "init") {
    const parsed = parseInitArgs(argv.slice(1));
    if ("error" in parsed) {
      console.error(`[loombridge minigame] ${parsed.error}.`);
      return { kind: "help", usageError: true };
    }
    return { kind: "init", args: parsed };
  }

  if (group !== "baseline") return { kind: "help", usageError: true };
  const action = argv[1];
  if (action !== "approve" && action !== "status") return { kind: "help", usageError: true };
  const parsed = parseBaselineArgs(argv.slice(2));
  if ("error" in parsed) {
    console.error(`[loombridge minigame] ${parsed.error}.`);
    return { kind: "help", usageError: true };
  }
  return { kind: action, args: parsed };
}

async function loadContract(contractPath: string): Promise<MinigameContract> {
  const raw = await fs.readFile(contractPath, "utf-8");
  return assertValidMinigameContract(JSON.parse(raw));
}

/**
 * Approve: grade the captures with the deterministic + flow gates (NO baseline
 * compare), refuse unless PASS, then snapshot the pack into the bundle.
 */
async function runApprove(args: BaselineArgs): Promise<number> {
  if (args.capturesDir === undefined) {
    console.error("[loombridge minigame] baseline approve requires --captures <dir>.");
    return 2;
  }
  let contract: MinigameContract;
  try {
    contract = await loadContract(args.contractPath);
  } catch (error) {
    console.error(`[loombridge minigame] could not load contract ${args.contractPath}: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }

  const refDir = resolveBaselineRef(contract, args.root, args.ref);
  if (!refDir) {
    console.error("[loombridge minigame] no baseline target — set contract.baseline.ref or pass --ref <dir>.");
    return 2;
  }

  // Grade WITHOUT any baseline compare (we're establishing the baseline) — a stale
  // bundle at refDir must not block re-approving an intended change.
  const verdict = await runMinigameGates(contract, args.capturesDir);
  // Mirror the verify gate's incomplete-forcing signals EXACTLY — a baseline must only ever freeze a
  // run that `verify --minigame` would also call PASS. Dropping `sequentialStates`/`inputResponse` here
  // would let a can't-verify run (e.g. a state that collapses sequential sub-screens, whose required
  // objects were downgraded to not_applicable) be laundered into a green frozen baseline. (Moat.)
  const status = minigameReportStatus(verdict.states, {
    strict: true,
    captureAbsent: verdict.captureAbsent,
    flow: verdict.flow,
    sequentialStates: verdict.sequentialStates,
    inputResponse: verdict.inputResponse,
  });
  if (status !== "pass") {
    console.error(
      `[loombridge minigame] REFUSED to approve a non-pass run (status=${status}). ` +
        "Only a PASS verification may be frozen as a baseline — fix the failures/captures and re-run `loombridge verify --minigame` to green first.",
    );
    return 1;
  }

  const summary = summarize(verdict.states);
  try {
    const manifest = await writeBaselineBundle({
      contract,
      capturesDir: args.capturesDir,
      refDir,
      capturedAt: args.at ?? nowIso(),
      approvedSummary: { pass: summary.pass, warn: summary.warn, fail: summary.fail, notApplicable: summary.notApplicable },
      // Ownership stamp (A4): the PROJECT root this approval is for. `--root` (default
      // cwd) is the only project identity this verb is given: the contract, captures,
      // and ref all live in the external workspace, none of which names the game repo.
      projectRoot: path.resolve(args.root),
    });
    console.error(
      `[loombridge minigame] baseline APPROVED for '${contract.id}' → ${path.relative(args.root, refDir)} ` +
        `(${manifest.states.length} state(s), ${manifest.masks.length} mask(s), capturedAt ${manifest.capturedAt}).`,
    );
    console.error("[loombridge minigame] future `loombridge verify --minigame` runs now enforce this baseline (drift = baseline regression).");
    return 0;
  } catch (error) {
    console.error(`[loombridge minigame] failed to write baseline bundle: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

/** Status: print the current baseline manifest summary (read-only). */
async function runStatus(args: BaselineArgs): Promise<number> {
  let contract: MinigameContract;
  try {
    contract = await loadContract(args.contractPath);
  } catch (error) {
    console.error(`[loombridge minigame] could not load contract ${args.contractPath}: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  const refDir = resolveBaselineRef(contract, args.root, args.ref);
  if (!refDir) {
    console.error("[loombridge minigame] no baseline target — set contract.baseline.ref or pass --ref <dir>.");
    return 2;
  }
  const manifest = await loadBaselineManifest(refDir);
  if (!manifest) {
    console.error(`[loombridge minigame] no approved baseline at ${path.relative(args.root, refDir)} — run \`loombridge minigame baseline approve\`.`);
    return 0;
  }
  console.error(
    `[loombridge minigame] baseline for '${manifest.contractId}' @ ${path.relative(args.root, refDir)}`,
  );
  console.error(
    `  approved ${manifest.capturedAt} | ${manifest.states.length} state(s): ${manifest.states.map((s) => s.id).join(", ")}`,
  );
  console.error(`  masks: ${manifest.masks.length > 0 ? manifest.masks.join(", ") : "(none)"}`);
  if (manifest.contractId !== contract.id) {
    console.error(`  WARNING: baseline contractId '${manifest.contractId}' != current contract '${contract.id}'.`);
  }
  return 0;
}

/**
 * Init: scaffold a ready-to-edit mini-game contract for `--id`. The scaffold is
 * validated before it is emitted, so `init` can never produce an invalid contract.
 * With `--output` it writes a file (refusing to clobber an existing one unless
 * `--force`); without it, the contract goes to stdout so it can be piped.
 */
async function runInit(args: InitArgs): Promise<number> {
  const contract = buildScaffoldContract(args.id);
  // Belt-and-suspenders: a scaffold that doesn't validate is a bug here, not a user
  // error — fail loudly rather than hand a partner a broken starting point.
  assertValidMinigameContract(contract);
  const json = `${JSON.stringify(contract, null, 2)}\n`;

  if (!args.output) {
    process.stdout.write(json);
    console.error(
      `[loombridge minigame] scaffolded contract for '${args.id}' (stdout). ` +
        "Edit scenes / locators / states to match your game, then run `loombridge verify --minigame`.",
    );
    return 0;
  }

  try {
    await fs.access(args.output);
    if (!args.force) {
      console.error(
        `[loombridge minigame] ${path.relative(process.cwd(), args.output)} already exists — refusing to overwrite. ` +
          "Pass --force to replace it (this would discard your edits).",
      );
      return 1;
    }
  } catch {
    // Does not exist — fine, we'll create it.
  }

  try {
    await fs.mkdir(path.dirname(args.output), { recursive: true });
    await fs.writeFile(args.output, json, "utf-8");
  } catch (error) {
    console.error(`[loombridge minigame] failed to write ${args.output}: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  console.error(
    `[loombridge minigame] wrote a starter contract for '${args.id}' → ${path.relative(process.cwd(), args.output)}.`,
  );
  console.error(
    "[loombridge minigame] next: edit scenes / requiredInFrame locators / states to match your game, capture its screens, then `loombridge verify --minigame`.",
  );
  return 0;
}

function printUsage(): void {
  console.log(
    [
      "Usage: loombridge minigame <command> [options]",
      "",
      "Helpers for verifying a 2D kids mini-game release.",
      "",
      "  run       Drive the WHOLE flow with one command: setup (if needed) → record →",
      "            capture → finalize → verify. Resumable; pauses for the interactive record.",
      "  setup     Guided first-time setup: lay out a workspace, scaffold a contract,",
      "            and print the first command (a wrapper over the verbs below).",
      "  next      Print the SINGLE next command for where your workspace is in the flow.",
      "  init      Scaffold a ready-to-edit verification contract for a mini-game.",
      "  scan      Open a live scene, propose controls/text, and emit a DRAFT contract.",
      "  sync      Re-scan a live scene and propose structural contract migrations.",
      "  check     Drift-aware single entry point: scan/sync guard, then run.",
      "  capture   Drive the recorded happy-path trace through the bridge and write the",
      "            capture pack (<state>.png / .ui-rects.json / .console.json + flow.json).",
      "  finalize  Replace a placeholder contract's locators/states with REAL scene",
      "            objects inferred from the capture pack (no hand-editing JSON).",
      "  baseline  Manage the approved visual/layout baseline (approve | status).",
      "",
      "setup/capture/finalize options: run `loombridge minigame <cmd> --help` for their flags.",
      "scan/sync options: run `loombridge minigame <cmd> --help` for their flags.",
      "",
      "init options:",
      "  --id <kebab-id>    Mini-game id (lowercase kebab; required).",
      "  --output <path>    Write the contract here (default: stdout). Won't overwrite.",
      "  --force            Overwrite an existing --output file.",
      "",
      "baseline <approve|status> options:",
      "  approve   Freeze the current PASS captures as the approved baseline (MUTATES the",
      "            bundle dir). Refuses a non-pass run. Grades WITHOUT comparing to any",
      "            existing baseline, so re-approving an intended change is never blocked.",
      "  status    Print the current baseline manifest summary (read-only).",
      "  --contract <path>  Mini-game contract JSON (required).",
      "  --captures <dir>   Per-state capture pack (required for approve).",
      "  --ref <dir>        Baseline bundle dir (default: contract.baseline.ref).",
      "  --root <dir>       Project root (default: cwd).",
      "  --at <iso>         Override the recorded capturedAt timestamp (approve).",
      "",
      "Exit: init     → 0 written/printed, 1 exists-without-force/write error, 2 usage error.",
      "      approve  → 0 approved, 1 refused (non-pass)/write error, 2 usage/load error.",
      "      status   → 0 (prints summary or 'no baseline'), 2 usage/load error.",
    ].join("\n"),
  );
}

/** CLI entry: parse the post-`minigame` args and run. */
export async function run(argv: string[]): Promise<number> {
  // `setup` is the guided onboarding wrapper — it does its own arg parsing
  // (interactive prompts + flags), so route it before the flag-only parser.
  if (argv[0] === "setup") {
    const { runSetup } = await import("./minigame-setup.js");
    return runSetup(argv.slice(1));
  }
  // `finalize` rewrites a placeholder contract from real captures — its own parser.
  if (argv[0] === "finalize") {
    const { runFinalize } = await import("./minigame-finalize.js");
    return runFinalize(argv.slice(1));
  }
  // `capture` drives the recorded trace through the bridge to write the pack.
  if (argv[0] === "capture") {
    const { runCapture } = await import("./minigame-capture.js");
    return runCapture(argv.slice(1));
  }
  // `scan` proposes a draft contract from a live scene's visible UI roster.
  if (argv[0] === "scan") {
    const { runScan } = await import("./minigame-scan.js");
    return runScan(argv.slice(1));
  }
  // `sync` proposes structural migrations when contract locators drift from the scene.
  if (argv[0] === "sync") {
    const { runSync } = await import("./minigame-sync.js");
    return runSync(argv.slice(1));
  }
  // `check` bootstraps/sync-guards, then delegates to the existing run loop.
  if (argv[0] === "check") {
    const { runCheck } = await import("./minigame-check.js");
    return runCheck(argv.slice(1));
  }
  // `next` inspects the workspace and prints the single next command (the guided flow).
  if (argv[0] === "next") {
    const { runNext } = await import("./minigame-next.js");
    return runNext(argv.slice(1));
  }
  // `run` drives the whole pipeline (the guided flow, executed) with one command.
  if (argv[0] === "run") {
    const { runRun } = await import("./minigame-run.js");
    return runRun(argv.slice(1));
  }
  // `declare-background` writes the report's marked decoration into the contract (closes the loop).
  if (argv[0] === "declare-background") {
    const { runDeclareBackground } = await import("./minigame-declare-background.js");
    return runDeclareBackground(argv.slice(1));
  }
  const parsed = parse(argv);
  if (parsed.kind === "help") {
    printUsage();
    return parsed.usageError ? 2 : 0;
  }
  try {
    if (parsed.kind === "init") return await runInit(parsed.args);
    return parsed.kind === "approve" ? await runApprove(parsed.args) : await runStatus(parsed.args);
  } catch (error) {
    console.error(`[loombridge minigame] fatal: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
