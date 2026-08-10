/**
 * `loombridge minigame next` — the guided flow.
 *
 * Instead of a static "do steps 1–5" list (which goes stale the moment reality differs
 * — a NOT-READY verify, a missing capture), this inspects the workspace and prints the
 * SINGLE next command for exactly where you are. `setup`, `capture`, and `finalize` print
 * this resolved next step in their footer; the trace verbs point back here; so you can
 * drive the whole pipeline one command at a time. (`verify` keeps its own findings-specific
 * next-step guidance.)
 *
 * The resolver (`resolveNextStep`) is PURE — it takes plain facts about the workspace and
 * returns the one next step. The IO (`inspectWorkspace`) gathers those facts. Keeping them
 * apart makes the step logic exhaustively unit-testable without disk.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { nextStepLines } from "../../shared/cli-ui.js";
import { isDraftContract } from "./minigame-draft.js";
import { normalizeWorkspaceId, projectWorkspace } from "../../domain/workspace-paths.js";

/** The default workspace for an id: `~/.loombridge/projects/<id>` (matches `minigame setup`).
 *  Re-exported so `declare-background`/`sync`/`check` resolve the workspace from `--id`
 *  the same way (the shared resolver lives in `workspace-paths.ts`). */
export const defaultWorkspace = projectWorkspace;

/** Plain facts about a mini-game workspace — everything `resolveNextStep` needs. */
export interface WorkspaceFacts {
  id: string;
  scene: string;
  /** Absolute workspace dir. */
  workspace: string;
  /** A human-recorded happy-path trace exists. */
  traceRecorded: boolean;
  /** The capture pack exists (the `active` screen at least). */
  capturesPresent: boolean;
  /** The contract has real locators (finalize has run) — not the placeholder draft. */
  contractFinalized: boolean;
  /** The last verify result, or null if verify hasn't run. `stale` = captures newer than it. */
  verify: { status: "READY" | "NOT READY" | "CAN'T VERIFY"; stale: boolean } | null;
  /** An approved baseline exists. */
  baselineApproved: boolean;
  /**
   * Capture discovered a background binding (a recommended layer set in
   * `background-candidates.json`) that the contract hasn't enabled yet — so the finalize step
   * folds in `--background auto`, enabling the gate in ONE command instead of a separate run.
   */
  backgroundRecommended: boolean;
  /**
   * A pre-seam `background-candidates.json` exists, but its recommended layers have no render
   * order. Re-capture first; otherwise `finalize --background auto` is known to refuse.
   */
  backgroundCandidatesStale?: boolean;
  /**
   * The contract's declared `stateSignal` (a multi-screen/gesture game's phase field) — threaded
   * into the printed `record` command as `--state-signal <locator>:<component>:<property>` so the
   * recorder can phase-align each gesture. Absent ⇒ the record command omits the flag and the
   * step adds a note that a multi-screen/gesture game should declare one.
   */
  stateSignal?: { locator: string; component?: string; property: string };
}

export type NextStepAt = "record" | "capture" | "finalize" | "verify" | "fix" | "baseline" | "done";

export interface NextStep {
  /** Where you are in the flow. */
  at: NextStepAt;
  /** One plain sentence: what to do next. */
  summary: string;
  /** The exact command to run (empty when done). */
  command: string;
}

/** Shorten an absolute path under $HOME to `~/…` for readable commands. */
function tilde(p: string): string {
  const home = os.homedir();
  return p === home || p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p;
}

/** The exact command for each step, built from the workspace facts. */
function commandsFor(f: WorkspaceFacts): Record<Exclude<NextStepAt, "done">, string> {
  const ws = tilde(f.workspace);
  const contract = `${ws}/${f.id}.minigame.json`;
  const captures = `${ws}/captures`;
  const reports = `${ws}/reports/minigame-verification.json`;
  const baseline = `${ws}/baseline`;
  const traceId = `${f.id}-happy-path`;
  // Fold the discovered background binding into finalize so the gates are enabled in ONE
  // command — otherwise the dev runs a plain finalize and the 🎨 suggestion is silently dropped.
  const backgroundFlag = f.backgroundRecommended ? " --background auto" : "";
  // A declared stateSignal phase-aligns each recorded gesture (required for multi-screen/gesture
  // games). The CLI's --state-signal parses `<path>:<Component>:<property>` on `:`, so the locator
  // is bare (no scene prefix / no `:`, enforced by the validator); an absent component → `path::property`.
  // With NO declared signal, fall back to live per-scene auto-detection: the scan only sees the
  // scanned scene, so a hub-to-game recording would otherwise carry no phase gates and capture
  // races activation animations ("visible" is not "consumable"). The flag now RESTATES the
  // CLI default rather than switching anything on, and is kept so the printed command still
  // says out loud which gating the workspace expects.
  const stateSignalFlag = f.stateSignal
    ? ` --state-signal ${f.stateSignal.locator}:${f.stateSignal.component ?? ""}:${f.stateSignal.property}`
    : " --auto-state-signal";
  return {
    record: `loombridge trace record --flat --id ${traceId} --scene ${f.scene} --root ${ws}${stateSignalFlag}`,
    capture: `loombridge minigame capture --contract ${contract} --trace-root ${ws} --captures ${captures}`,
    finalize: `loombridge minigame finalize --contract ${contract} --captures ${captures} --trace-root ${ws}${backgroundFlag}`,
    fix: `loombridge minigame capture --contract ${contract} --trace-root ${ws} --captures ${captures}`,
    verify: `loombridge verify --minigame --contract ${contract} --captures ${captures} --output ${reports} --strict`,
    baseline: `loombridge minigame baseline approve --contract ${contract} --captures ${captures} --ref ${baseline}`,
  };
}

/**
 * The single next step for a workspace. PURE — exhaustively unit-tested. Order mirrors the
 * pipeline: record → capture → finalize → verify → (fix | baseline) → done.
 */
export function resolveNextStep(f: WorkspaceFacts): NextStep {
  const cmd = commandsFor(f);
  if (!f.traceRecorded) {
    // When the contract declares no stateSignal, the printed record command auto-detects one
    // per scene at record time (--auto-state-signal). Still nudge the dev: an explicit declared
    // signal beats the heuristic when the game has one worth naming.
    const summary = f.stateSignal
      ? "Record your happy path: play it in Unity (up to the active screen), then press Enter."
      : 'Record your happy path: play it in Unity (up to the active screen), then press Enter. ' +
        "The recorder will AUTO-DETECT each scene's state signal to phase-align gestures; a game " +
        'with a known phase field can declare it explicitly instead, e.g. "stateSignal": ' +
        '{ "locator": "/Canvas/GameManager", "component": "GameManager", "property": "phase" }.';
    return { at: "record", summary, command: cmd.record };
  }
  if (!f.capturesPresent) {
    return { at: "capture", summary: "Capture the screens by driving your recorded trace through the bridge.", command: cmd.capture };
  }
  if (!f.contractFinalized && f.backgroundCandidatesStale) {
    return { at: "capture", summary: "Re-capture with the current bridge so the background seam check has render-order evidence.", command: cmd.capture };
  }
  if (!f.contractFinalized) {
    const summary = f.backgroundRecommended
      ? "Finalize the contract — binds the real locators from your captures and enables the discovered background coverage + seam gates."
      : "Finalize the contract — fills in the real locators from your captures.";
    return { at: "finalize", summary, command: cmd.finalize };
  }
  if (!f.verify || f.verify.stale) {
    return { at: "verify", summary: "Run the release check.", command: cmd.verify };
  }
  if (f.verify.status === "NOT READY") {
    return { at: "fix", summary: "Not ready: fix the findings in the report, then re-capture and re-verify.", command: cmd.fix };
  }
  if (f.verify.status === "CAN'T VERIFY") {
    return { at: "fix", summary: "Can't verify: a capture/test-setup gap. Re-record or re-capture, then re-verify.", command: cmd.capture };
  }
  if (!f.baselineApproved) {
    return { at: "baseline", summary: "Ready to ship. Approve the baseline so later runs catch any drift.", command: cmd.baseline };
  }
  return { at: "done", summary: "All done — ready to ship. Re-run verify after any change.", command: "" };
}

/** Render the next step as the shared `👉 Next — …` footer every command uses. */
export function formatNextStep(step: NextStep): string[] {
  return nextStepLines(step.summary, step.command || undefined);
}

/**
 * Inspect a workspace and print the single next step — the shared footer for `capture` /
 * `finalize` so the flow chains one command at a time. Best-effort: a workspace it can't
 * read prints nothing (the command's own output already stands on its own).
 */
export async function printNextStep(workspace: string): Promise<void> {
  const facts = await inspectWorkspace(workspace);
  if (!("error" in facts)) console.log(`\n${formatNextStep(resolveNextStep(facts)).join("\n")}`);
}

/**
 * The resolved next-step footer LINES for a workspace, or `[]` when it can't be inspected.
 * Lets the `check` bootstrap and the standalone `scan` footer print the SAME guidance the
 * `minigame next` resolver gives (the exact record command + the `--state-signal` note),
 * instead of their own drift-prone prose — so "just follow the printed steps" holds whichever
 * verb the dev entered through.
 */
export async function nextStepLinesFor(workspace: string): Promise<string[]> {
  const facts = await inspectWorkspace(workspace);
  return "error" in facts ? [] : formatNextStep(resolveNextStep(facts));
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function mtimeMs(p: string): Promise<number | null> {
  try {
    return (await fs.stat(p)).mtimeMs;
  } catch {
    return null;
  }
}

/** Find the single `*.minigame.json` contract in a workspace (the one `setup` scaffolds).
 *  Exported so `declare-background` resolves the contract the same way `next` does. */
export async function findContract(workspace: string): Promise<string | null> {
  try {
    // Sorted so a workspace with >1 contract resolves deterministically (not readdir order).
    const c = (await fs.readdir(workspace)).filter((e) => e.endsWith(".minigame.json")).sort()[0];
    return c ? path.join(workspace, c) : null;
  } catch {
    return null;
  }
}

/** Gather the workspace facts from disk (the IO half; the resolver stays pure). */
export async function inspectWorkspace(workspace: string): Promise<WorkspaceFacts | { error: string }> {
  const contractPath = await findContract(workspace);
  if (!contractPath) return { error: `no <id>.minigame.json found in ${tilde(workspace)} — run \`loombridge minigame setup\` first.` };

  let contractRaw: string;
  let contract: { id?: unknown; scenes?: unknown; states?: unknown; stateSignal?: unknown };
  try {
    contractRaw = await fs.readFile(contractPath, "utf-8");
    contract = JSON.parse(contractRaw);
  } catch (error) {
    return { error: `could not read ${tilde(contractPath)}: ${error instanceof Error ? error.message : String(error)}` };
  }
  const id = typeof contract.id === "string" ? contract.id : path.basename(contractPath, ".minigame.json");
  const scene = Array.isArray(contract.scenes) && typeof contract.scenes[0] === "string" ? contract.scenes[0] : "Assets/Scenes/Game.unity";

  const traceRecorded = await exists(path.join(workspace, "traces", `${id}-happy-path.trace.json`));
  // Detect captures by the contract's FIRST `active`-kind state's ui-rects, not a hardcoded
  // "active" id — a multi-screen game names its gameplay states (mix/cook/decorate), so it
  // never writes `active.ui-rects.json` and `capturesPresent` would be false forever (the
  // run/check loop then loops on "capture" → "no progress" stall). Falls back to "active" for
  // a contract with no active state (backward-compatible: a single-active game still resolves
  // its gameplay state's id, e.g. literally "active").
  const states = Array.isArray(contract.states) ? (contract.states as { id?: unknown; kind?: unknown }[]) : [];
  const firstActive = states.find((s) => s?.kind === "active" && typeof s.id === "string")?.id;
  const captureProbeState = typeof firstActive === "string" ? firstActive : "active";
  const capturesPresent = await exists(path.join(workspace, "captures", `${captureProbeState}.ui-rects.json`));
  // A draft (finalize hasn't run) still carries placeholder descriptions; finalize rewrites EVERY one
  // (each state → "<kind> screen.", requiredInFrame rebuilt from captures, top → "Finalized …"). The
  // shared `isDraftContract` inspects those DESCRIPTIONS structurally — anchored at their start, across
  // the top-level / states / declared objects — so it catches a fused multi-scene contract whose
  // top-level reads finalized while its per-scene SCAN states are still `DRAFT:` (the case that skipped
  // finalize → namespaced ids never reconciled to bare-id captures → every gate false-failed), without
  // the old raw-JSON substring's fragility (a locator/name merely containing the token).
  const contractFinalized = capturesPresent && !isDraftContract(contract);

  const reportPath = path.join(workspace, "reports", "minigame-verification.json");
  let verify: WorkspaceFacts["verify"] = null;
  const reportMtime = await mtimeMs(reportPath);
  if (reportMtime !== null) {
    let status: "READY" | "NOT READY" | "CAN'T VERIFY" = "CAN'T VERIFY";
    try {
      const s = (JSON.parse(await fs.readFile(reportPath, "utf-8")) as { status?: string }).status;
      status = s === "pass" ? "READY" : s === "fail" ? "NOT READY" : "CAN'T VERIFY";
    } catch {
      /* unreadable → treat as CAN'T VERIFY */
    }
    // Stale if the captures OR the contract were re-written after the report — the result no
    // longer reflects the inputs. The contract clause matters because re-finalize passes
    // (`--safe-area-insets` / `--input-response` / `--outcome-gated`) change the contract
    // without touching captures; without it `next` would advance to "baseline" on a stale verify.
    const newestCapture = await newestMtimeIn(path.join(workspace, "captures"));
    const contractMtime = await mtimeMs(contractPath);
    const stale =
      (newestCapture !== null && newestCapture > reportMtime) ||
      (contractMtime !== null && contractMtime > reportMtime);
    verify = { status, stale };
  }

  const baselineApproved = await dirHasFiles(path.join(workspace, "baseline"));

  // Capture writes `background-candidates.json`; if it recommends a background layer set and the
  // contract hasn't enabled the gate yet, fold `--background auto` into the finalize step. The
  // `background-coverage` string is the reliable already-enabled signal (it lives in checks +
  // the bindings), so an already-bound contract won't re-suggest it.
  let backgroundRecommended = false;
  let backgroundCandidatesStale = false;
  if (!contractRaw.includes("background-coverage")) {
    try {
      const cand = JSON.parse(
        await fs.readFile(path.join(workspace, "captures", "background-candidates.json"), "utf-8"),
      ) as { recommended?: unknown };
      const recommended = Array.isArray(cand.recommended) ? cand.recommended : [];
      const hasRecommendation = recommended.length > 0;
      const allHaveOrder = recommended.every((r) => typeof r === "object" && r !== null && Boolean((r as { order?: unknown }).order));
      backgroundRecommended = hasRecommendation && allHaveOrder;
      backgroundCandidatesStale = hasRecommendation && !allHaveOrder;
    } catch {
      /* no candidates / unreadable → no background suggestion (the gate stays opt-in) */
    }
  }

  // The declared stateSignal (optional) — threaded into the record command. Parsed defensively:
  // only a well-formed `{ locator, property }` (+ optional `component`), with a bare locator (no
  // `:`), is honoured; anything malformed is ignored (the resolver then nudges the dev as if absent,
  // and the validator is the authoritative gate on a malformed declaration).
  const stateSignal = parseStateSignal(contract.stateSignal);

  return { id, scene, workspace, traceRecorded, capturesPresent, contractFinalized, verify, baselineApproved, backgroundRecommended, backgroundCandidatesStale, stateSignal };
}

/** Defensively read `contract.stateSignal` into the threaded shape, or undefined when malformed/absent. */
function parseStateSignal(raw: unknown): WorkspaceFacts["stateSignal"] {
  if (typeof raw !== "object" || raw === null) return undefined;
  const ss = raw as { locator?: unknown; component?: unknown; property?: unknown };
  if (typeof ss.locator !== "string" || ss.locator.length === 0 || ss.locator.includes(":")) return undefined;
  if (typeof ss.property !== "string" || ss.property.length === 0) return undefined;
  const component = typeof ss.component === "string" && ss.component.length > 0 ? ss.component : undefined;
  return { locator: ss.locator, component, property: ss.property };
}

/** The newest mtime among a directory's files (recursively, one level), or null if empty/absent. */
async function newestMtimeIn(dir: string): Promise<number | null> {
  let newest: number | null = null;
  try {
    for (const entry of await fs.readdir(dir)) {
      const m = await mtimeMs(path.join(dir, entry));
      if (m !== null && (newest === null || m > newest)) newest = m;
    }
  } catch {
    return null;
  }
  return newest;
}

async function dirHasFiles(dir: string): Promise<boolean> {
  try {
    return (await fs.readdir(dir)).length > 0;
  } catch {
    return false;
  }
}

/** Run `loombridge minigame next`. Resolves the workspace from `--id` or `--workspace`. */
export async function runNext(argv: string[], root: string = process.cwd()): Promise<number> {
  let id: string | undefined;
  let workspace: string | undefined;
  /** Read a required value, rejecting a missing or flag-like one (so `--id --workspace` errors clearly). */
  const value = (i: number, flag: string): string | null => {
    const v = argv[i];
    if (v === undefined || v.startsWith("--")) {
      console.error(`[loombridge minigame] next: ${flag} requires a value.`);
      return null;
    }
    return v;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      console.error("Usage: loombridge minigame next [--id <id> | --workspace <dir>]\n\nPrints the single next command for where your workspace is in the flow.");
      return 0;
    }
    if (arg === "--id") {
      const v = value((i += 1), "--id");
      if (v === null) return 2;
      id = normalizeWorkspaceId(v); // accept StarChef → star-chef, resolving the same workspace as `check`
      if (id !== v) console.error(`[loombridge minigame] next: using id '${id}' (normalized from '${v}').`);
    } else if (arg === "--workspace") {
      const v = value((i += 1), "--workspace");
      if (v === null) return 2;
      workspace = path.resolve(root, v);
    } else {
      console.error(`[loombridge minigame] next: unknown argument "${arg}".`);
      return 2;
    }
  }
  const ws = workspace ?? (id ? defaultWorkspace(id) : undefined);
  if (!ws) {
    console.error("[loombridge minigame] next: pass --id <id> or --workspace <dir>.");
    return 2;
  }
  const facts = await inspectWorkspace(ws);
  if ("error" in facts) {
    console.error(`[loombridge minigame] next: ${facts.error}`);
    return 2;
  }
  console.log(formatNextStep(resolveNextStep(facts)).join("\n"));
  return 0;
}
