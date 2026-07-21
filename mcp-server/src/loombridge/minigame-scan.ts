/**
 * `loombridge minigame scan` — open a live Unity scene, propose role candidates,
 * and emit a schema-valid draft contract for the developer to review/edit.
 *
 * Advisory + read-only on the game: this scans UI rects/background candidates and
 * writes only the requested draft JSON (or stdout). It does not capture, finalize,
 * approve, or bind anything to a verdict.
 */

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { UnityClient } from "../unity-client.js";
import {
  isScenePath,
  VISUAL_PROFILES,
  type MinigameContract,
} from "./minigame-profiles/types.js";
import { normalizeWorkspaceId } from "./workspace-paths.js";
import { assertValidMinigameContract } from "./minigame-profiles/validator.js";
import { unityConnectionHint } from "./cli-ui.js";
import { nextStepLinesFor } from "./minigame-next.js";
import { discoverBackgroundCandidates } from "./minigame-background-discover.js";
import { discoverStateSignalCandidate, type StateSignalCandidate } from "./minigame-statesignal-discover.js";
import {
  discoverRoleCandidates,
  draftContractFromCandidates,
  nearestVisualProfile,
  panelVisitOrder,
  type RoleCandidates,
} from "./minigame-role-discover.js";
import { flatReplayLayout } from "./state.js";
import { parseTrace } from "./replay/index.js";
import { resilientSend } from "./replay/resilient-send.js";
import type { BridgeSend } from "./replay/unity-driver.js";
import type { ReplayTrace } from "./replay/types.js";

interface ScanArgs {
  scene: string;
  id: string;
  output?: string;
  traceId?: string;
  traceRoot?: string;
  /** Suppress the resolved "next" footer (set when `check` drives scan — it prints its own). */
  quietNext?: boolean;
}

/** The id auto-derived from a scene filename — `Assets/Scenes/StarChef.unity` → `star-chef`. */
export function idFromScene(scene: string): string {
  return normalizeWorkspaceId(path.basename(scene, ".unity"));
}

export function parseScanArgs(argv: string[]): ScanArgs | { error: string } {
  let scene: string | undefined;
  let id: string | undefined;
  let output: string | undefined;
  let traceId: string | undefined;
  let traceRoot: string | undefined;
  let quietNext = false;
  const take = (i: number, name: string): string | { error: string } => {
    const v = argv[i];
    if (v === undefined || v.startsWith("--")) return { error: `${name} requires a value` };
    return v;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    let v: string | { error: string };
    switch (arg) {
      case "--scene":
        v = take((i += 1), arg);
        if (typeof v !== "string") return v;
        scene = v;
        break;
      case "--id":
        v = take((i += 1), arg);
        if (typeof v !== "string") return v;
        id = v;
        break;
      case "--output":
      case "-o":
        v = take((i += 1), arg);
        if (typeof v !== "string") return v;
        output = path.resolve(v);
        break;
      case "--trace":
        v = take((i += 1), arg);
        if (typeof v !== "string") return v;
        traceId = v;
        break;
      case "--trace-root":
        v = take((i += 1), arg);
        if (typeof v !== "string") return v;
        traceRoot = path.resolve(v);
        break;
      case "--quiet-next":
        quietNext = true;
        break;
      default:
        return { error: `unknown argument "${arg}"` };
    }
  }
  if (!scene) return { error: "--scene <Assets/...unity> is required" };
  if (!isScenePath(scene)) return { error: `--scene '${scene}' must be an Assets/**.unity path` };
  // Accept any reasonable --id and canonicalize it (StarChef → star-chef) instead of rejecting — same
  // normalization the scene-derived default uses, so an explicit id never adds friction.
  const resolvedId = id !== undefined ? normalizeWorkspaceId(id) : idFromScene(scene);
  return { scene, id: resolvedId, output, traceId, traceRoot, quietNext };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function openSceneForScan(send: BridgeSend, scene: string): Promise<void> {
  await send("editor.stop", {});
  await send("editor.wait_for", { playMode: "stopped", compiling: false, updating: false, timeoutMs: 15000 }, 20000);
  const opened = await send("scene.open_scene", { path: scene, mode: "Single" }, 30000);
  if (opened.status === "error") {
    throw new Error(opened.error?.message ?? `scene.open_scene failed for ${scene}`);
  }
  await send("editor.wait_for", { playMode: "stopped", compiling: false, updating: false, timeoutMs: 15000 }, 20000);
}

/**
 * Load the recorded demonstration, if one is available. The trace orders screen
 * clusters AND (S8b) lets the draft propose states for panels the human used that the
 * static scan couldn't see. Returns undefined when no trace was supplied/found (and the
 * lookup wasn't explicit), so the no-trace draft stays byte-identical.
 */
async function loadTrace(args: ScanArgs, root: string): Promise<ReplayTrace | undefined> {
  const traceRoot = args.traceRoot ?? root;
  const traceId = args.traceId ?? `${args.id}-happy-path`;
  const file = path.join(flatReplayLayout(traceRoot).replayTraces, `${traceId}.trace.json`);
  const explicit = args.traceRoot !== undefined || args.traceId !== undefined;
  try {
    return parseTrace(JSON.parse(await fs.readFile(file, "utf-8")));
  } catch (error) {
    if (!explicit) return undefined;
    throw new Error(`could not load trace '${traceId}' under ${path.relative(root, traceRoot)}: ${message(error)}`);
  }
}

async function scanLive(
  args: ScanArgs,
  root: string,
): Promise<{ contract: MinigameContract; candidates: RoleCandidates; visualProfile: string; viewportAspect?: number; stateSignal?: StateSignalCandidate }> {
  const trace = await loadTrace(args, root);
  const panelOrder = trace ? panelVisitOrder(trace) : undefined;
  const client = new UnityClient();
  await client.connect();
  const send = resilientSend(client);
  try {
    await openSceneForScan(send, args.scene);
    const candidates = await discoverRoleCandidates(send);
    const discoveredCount = candidates.controls.length + candidates.texts.length;
    if (discoveredCount === 0) {
      throw new Error("no visible tappable controls or text labels were discovered; refusing to emit a draft that verifies no real objects");
    }

    const viewportAspect = candidates.viewportAspect;
    const visualProfile = nearestVisualProfile(viewportAspect ?? 0);
    // Auto-detect the phase/state enum signal so a multi-screen/gesture game phase-aligns with zero
    // hand-editing (phase-2). Advisory + defensive — a failure leaves it undetected (the G6 note nudges).
    let stateSignal: StateSignalCandidate | undefined;
    try {
      stateSignal = await discoverStateSignalCandidate(send);
    } catch {
      // Discovery is advisory; never block the draft on it.
    }
    const draftOpts = { panelOrder, trace, visualProfile, stateSignal };
    let contract = draftContractFromCandidates(args.id, args.scene, candidates, draftOpts);
    try {
      const backgroundCandidates = await discoverBackgroundCandidates(send, contract);
      contract = draftContractFromCandidates(args.id, args.scene, candidates, { ...draftOpts, backgroundCandidates });
    } catch {
      // Background discovery is advisory; role discovery is the S8a deliverable.
    }
    return { contract, candidates, visualProfile, viewportAspect, stateSignal };
  } finally {
    try {
      await client.disconnect();
    } catch {
      // Best-effort; the scan result is already determined.
    }
  }
}

async function writeDraft(contract: MinigameContract, output?: string): Promise<void> {
  assertValidMinigameContract(contract);
  const json = `${JSON.stringify(contract, null, 2)}\n`;
  if (!output) {
    process.stdout.write(json);
    return;
  }
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, json, "utf-8");
}

export function printScanUsage(): void {
  console.log(
    [
      "Usage: loombridge minigame scan --scene <Assets/...unity> [--id <id>] [--output <path>]",
      "",
      "Open a Unity scene, scan visible UI controls/text, and emit a DRAFT contract.",
      "",
      "Options:",
      "  --scene <path>     Unity scene path under Assets/ ending in .unity (required).",
      "  --id <kebab-id>    Contract id (default: derived from scene filename).",
      "  --output, -o       Write draft JSON here (default: stdout).",
      "  --trace <id>       Order screen clusters from this recorded demonstration.",
      "  --trace-root <dir> Workspace/trace root (default: cwd; trace id defaults to <id>-happy-path).",
      "  --quiet-next       Suppress the resolved 'next' footer (used when `check` drives scan).",
      "",
      "Exit: 0 draft emitted, 1 live scan/write failed, 2 usage error.",
    ].join("\n"),
  );
}

export async function runScan(argv: string[], root: string = process.cwd()): Promise<number> {
  if (argv[0] === "--help" || argv[0] === "-h") {
    printScanUsage();
    return 0;
  }
  const parsed = parseScanArgs(argv);
  if ("error" in parsed) {
    console.error(`[loombridge minigame] scan: ${parsed.error}.`);
    printScanUsage();
    return 2;
  }

  let result: { contract: MinigameContract; candidates: RoleCandidates; visualProfile: string; viewportAspect?: number; stateSignal?: StateSignalCandidate };
  try {
    result = await scanLive(parsed, root);
    await writeDraft(result.contract, parsed.output);
  } catch (error) {
    const hint = unityConnectionHint(error);
    console.error(hint ? hint.join("\n") : `[loombridge minigame] scan: ${message(error)}`);
    return 1;
  }

  const target = parsed.output ? path.relative(root, parsed.output) : "stdout";
  console.error(
    `[loombridge minigame] scan: found ${result.candidates.controls.length} control(s), ` +
      `${result.candidates.texts.length} text label(s), ${result.contract.states.length} draft state(s); ` +
      `wrote DRAFT contract → ${target}.`,
  );
  const aspectNote =
    typeof result.viewportAspect === "number" && Number.isFinite(result.viewportAspect) && result.viewportAspect > 0
      ? `inferred from aspect ${result.viewportAspect.toFixed(2)}`
      : "default — no live aspect measured";
  const validProfiles = Object.keys(VISUAL_PROFILES).join(" | ");
  console.error(
    `[loombridge minigame] visualProfile: ${result.visualProfile} (${aspectNote}); ` +
      `valid: ${validProfiles} — edit if wrong.`,
  );
  if (result.stateSignal) {
    const s = result.stateSignal;
    console.error(
      `[loombridge minigame] stateSignal: auto-detected ${s.locator}:${s.component}:${s.property} ` +
        `(${s.enumValues.length} phases) — record will phase-align automatically. Clear/edit it in the draft if wrong.`,
    );
  } else {
    console.error(
      "[loombridge minigame] stateSignal: none auto-detected. A multi-screen/gesture game should declare one " +
        "in the draft so capture can phase-align (see the record step's note).",
    );
  }
  // `check` drives scan and prints its own footer — stay silent so the record step isn't printed twice.
  if (parsed.quietNext) return 0;
  // Route the "next" footer through the SAME resolver `minigame next` uses, so a standalone scan
  // gives the EXACT record command (with `--state-signal` threaded when declared) + the note nudging
  // a multi-screen/gesture game to declare a stateSignal — not generic prose that drops the flag.
  // Needs a real workspace dir to inspect (the draft on disk); a stdout scan has none → fall back to
  // a generic hint so we never leave the dev with no "next". On stderr to keep stdout clean.
  const nextLines = parsed.output ? await nextStepLinesFor(path.dirname(parsed.output)) : [];
  if (nextLines.length > 0) {
    console.error(`[loombridge minigame] next: review/edit the draft, then:`);
    for (const line of nextLines) console.error(line);
  } else {
    console.error(
      "[loombridge minigame] next: review/edit the draft, then run `loombridge minigame next` for the exact next command " +
        "(record a demonstration, capture, finalize, verify).",
    );
  }
  return 0;
}
