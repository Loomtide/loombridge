/**
 * `loombridge minigame sync` — structural contract drift proposal.
 *
 * Re-scan a live scene, diff the saved contract's object locators against the
 * current hierarchy, and propose safe migrations. Dry-run by default; writes only
 * with --apply. This is structural drift only (locators / objects), not visual
 * baseline drift.
 */

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { UnityClient } from "../../bridge/unity-client.js";
import { ICON, tildify, unityConnectionHint } from "../../shared/cli-ui.js";
import { classifyRoleCandidates, type RoleCandidate, type RoleCandidates } from "./minigame-role-discover.js";
import { defaultWorkspace, findContract } from "./minigame-next.js";
import { assertValidMinigameContract } from "./profiles/validator.js";
import { isScenePath, type MinigameContract, type MinigameObjectRef } from "./profiles/types.js";
import { normalizeWorkspaceId } from "../../domain/workspace-paths.js";
import { objectIdFromPath, rawObjectPaths, type RawScreenRects } from "./minigame-capture-plan.js";
import { resilientSend } from "../replay/resilient-send.js";
import type { BridgeSend } from "../replay/unity-driver.js";

export interface RelocatedRef {
  ref: MinigameObjectRef;
  fromLocator: string;
  toLocator: string;
}

export interface AddedCandidate {
  candidate: RoleCandidate;
}

export interface ContractDiff {
  present: MinigameObjectRef[];
  relocated: RelocatedRef[];
  removed: MinigameObjectRef[];
  added: AddedCandidate[];
}

interface SyncArgs {
  scene: string;
  id?: string;
  contract?: string;
  apply: boolean;
  add: boolean;
  remove: boolean;
}

export function locatorPath(locator: string): string {
  const colon = locator.indexOf(":");
  return colon >= 0 ? locator.slice(colon + 1) : locator;
}

function leaf(pathLike: string): string {
  return locatorPath(pathLike).split("/").filter(Boolean).at(-1) ?? "";
}

function uniqueId(base: string, used: Set<string>): string {
  if (!used.has(base)) return base;
  for (let i = 2; ; i += 1) {
    const candidate = `${base}${i}`;
    if (!used.has(candidate)) return candidate;
  }
}

function cloneContract(contract: MinigameContract): MinigameContract {
  return JSON.parse(JSON.stringify(contract)) as MinigameContract;
}

/**
 * Pure structural diff: required contract refs are present, relocated, or removed;
 * scanned new controls absent from the contract become added proposals.
 */
export function diffContractVsScene(
  contract: MinigameContract,
  allScenePaths: string[],
  candidates: RoleCandidates,
): ContractDiff {
  const scenePathSet = new Set(allScenePaths.map(locatorPath));
  const pathsByLeaf = new Map<string, string[]>();
  for (const p of scenePathSet) {
    const l = leaf(p);
    const group = pathsByLeaf.get(l) ?? [];
    group.push(p);
    pathsByLeaf.set(l, group);
  }

  const present: MinigameObjectRef[] = [];
  const relocated: RelocatedRef[] = [];
  const removed: MinigameObjectRef[] = [];
  const referencedPaths = new Set<string>();

  for (const ref of contract.requiredInFrame) {
    const fromPath = locatorPath(ref.locator);
    if (scenePathSet.has(fromPath)) {
      present.push(ref);
      referencedPaths.add(fromPath);
      continue;
    }
    const matches = pathsByLeaf.get(leaf(fromPath)) ?? [];
    if (matches.length === 1) {
      relocated.push({ ref, fromLocator: ref.locator, toLocator: matches[0] });
      referencedPaths.add(matches[0]);
    } else {
      removed.push(ref);
    }
  }

  const added = candidates.controls
    .filter((candidate) => !referencedPaths.has(locatorPath(candidate.locator)))
    .map((candidate) => ({ candidate }));

  return { present, relocated, removed, added };
}

function canRemoveRef(contract: MinigameContract, idsToRemove: Set<string>, ref: MinigameObjectRef): boolean {
  const remainingTopLevel = contract.requiredInFrame.filter((r) => r.id !== ref.id && !idsToRemove.has(r.id));
  if (remainingTopLevel.length === 0) return false;
  for (const state of contract.states) {
    const refs = state.requiredInFrame ?? [];
    if (!refs.includes(ref.id)) continue;
    const remaining = refs.filter((id) => id !== ref.id && !idsToRemove.has(id));
    if (remaining.length === 0) return false;
  }
  return true;
}

/**
 * Pure apply step. Relocations are always applied. Adds/removes are opt-in, and
 * removals that would empty a state's bindings are refused by keeping the ref.
 */
export function applyContractDiff(
  contract: MinigameContract,
  diff: ContractDiff,
  opts: { add?: boolean; remove?: boolean },
): MinigameContract {
  const next = cloneContract(contract);
  const relocatedById = new Map(diff.relocated.map((r) => [r.ref.id, r.toLocator]));
  next.requiredInFrame = next.requiredInFrame.map((ref) => {
    const to = relocatedById.get(ref.id);
    return to ? { ...ref, locator: to } : ref;
  });

  const removable = new Set<string>();
  if (opts.remove) {
    for (const ref of diff.removed) {
      if (canRemoveRef(next, removable, ref)) removable.add(ref.id);
    }
  }
  if (removable.size > 0) {
    next.requiredInFrame = next.requiredInFrame.filter((ref) => !removable.has(ref.id));
    next.states = next.states.map((state) => ({
      ...state,
      requiredInFrame: state.requiredInFrame?.filter((id) => !removable.has(id)),
    }));
  }

  if (opts.add) {
    const used = new Set(next.requiredInFrame.map((ref) => ref.id));
    const firstActive = next.states.find((state) => state.kind === "active");
    for (const { candidate } of diff.added) {
      const base = objectIdFromPath(locatorPath(candidate.locator));
      const id = uniqueId(base, used);
      used.add(id);
      next.requiredInFrame.push({
        id,
        locator: locatorPath(candidate.locator),
        description: `Discovered new control (${candidate.name}); sync bound it to the first active state. Review per-screen placement.`,
      });
      if (firstActive) {
        const refs = firstActive.requiredInFrame ?? [];
        firstActive.requiredInFrame = [...refs, id];
      }
    }
  }

  return assertValidMinigameContract(next);
}

function parseArgs(argv: string[]): SyncArgs | { help: true } | { error: string } {
  let scene: string | undefined;
  let id: string | undefined;
  let contract: string | undefined;
  let apply = false;
  let add = false;
  let remove = false;
  const take = (i: number, name: string): string | { error: string } => {
    const v = argv[i];
    if (v === undefined || v.startsWith("--")) return { error: `${name} requires a value` };
    return v;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return { help: true };
    if (arg === "--apply") apply = true;
    else if (arg === "--add") add = true;
    else if (arg === "--remove") remove = true;
    else if (arg === "--scene") {
      const v = take((i += 1), arg);
      if (typeof v !== "string") return v;
      scene = v;
    } else if (arg === "--id") {
      const v = take((i += 1), arg);
      if (typeof v !== "string") return v;
      id = v;
    } else if (arg === "--contract") {
      const v = take((i += 1), arg);
      if (typeof v !== "string") return v;
      contract = path.resolve(v);
    } else {
      return { error: `unknown argument "${arg}"` };
    }
  }
  if (!scene) return { error: "--scene <Assets/...unity> is required" };
  if (!isScenePath(scene)) return { error: `--scene '${scene}' must be an Assets/**.unity path` };
  if (id !== undefined && contract !== undefined) return { error: "pass either --id or --contract, not both" };
  // Canonicalize an explicit --id (StarChef → star-chef) so sync resolves the SAME workspace `check` created.
  return { scene, id: id !== undefined ? normalizeWorkspaceId(id) : undefined, contract, apply, add, remove };
}

function printUsage(): void {
  console.log(
    [
      "Usage: loombridge minigame sync --scene <Assets/...unity> [--id <id> | --contract <path>] [--apply] [--add] [--remove]",
      "",
      "Re-scan a live scene and propose structural contract drift migrations.",
      "",
      "Options:",
      "  --scene <path>     Unity scene path under Assets/ ending in .unity (required).",
      "  --id <kebab-id>    Resolve ~/.loombridge/projects/<id>/<id>.minigame.json.",
      "  --contract <path>  Explicit contract path.",
      "  --apply            Write safe relocations to the contract. Without it, dry-run only.",
      "  --add              With --apply, append newly scanned controls and bind to first active state.",
      "  --remove           With --apply, remove missing refs when doing so keeps the contract valid.",
      "",
      "Exit: 0 diff printed/written, 1 scan/write failed, 2 usage/load error.",
    ].join("\n"),
  );
}

async function openSceneForSync(send: BridgeSend, scene: string): Promise<void> {
  await send("editor.stop", {});
  await send("editor.wait_for", { playMode: "stopped", compiling: false, updating: false, timeoutMs: 15000 }, 20000);
  const opened = await send("scene.open_scene", { path: scene, mode: "Single" }, 30000);
  if (opened.status === "error") throw new Error(opened.error?.message ?? `scene.open_scene failed for ${scene}`);
  await send("editor.wait_for", { playMode: "stopped", compiling: false, updating: false, timeoutMs: 15000 }, 20000);
}

async function scanScene(scene: string): Promise<{ allScenePaths: string[]; candidates: RoleCandidates }> {
  const client = new UnityClient();
  await client.connect();
  const send = resilientSend(client);
  try {
    await openSceneForSync(send, scene);
    const res = await send("ui.get_screen_rects", {});
    if (res.status === "error") throw new Error(res.error?.message ?? "ui.get_screen_rects failed");
    const raw = (res.data ?? {}) as RawScreenRects;
    return { allScenePaths: rawObjectPaths(raw).map(locatorPath), candidates: classifyRoleCandidates(raw) };
  } finally {
    try {
      await client.disconnect();
    } catch {
      /* best-effort */
    }
  }
}

/** Online helper for callers that need the structural diff but own the write policy. */
export async function scanContractDiff(scene: string, contract: MinigameContract): Promise<ContractDiff> {
  const scanned = await scanScene(scene);
  return diffContractVsScene(contract, scanned.allScenePaths, scanned.candidates);
}

async function resolveContractPath(args: SyncArgs, root: string): Promise<string | null> {
  if (args.contract) return args.contract;
  const workspace = args.id ? defaultWorkspace(args.id) : root;
  return findContract(workspace);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function loadContract(contractPath: string): Promise<MinigameContract> {
  return assertValidMinigameContract(JSON.parse(await fs.readFile(contractPath, "utf-8")));
}

async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
  await fs.rename(tmp, file);
}

function diffLines(diff: ContractDiff): string[] {
  const lines = [
    `${ICON.info} Structural diff: ${diff.present.length} present · ${diff.relocated.length} relocated · ${diff.removed.length} removed · ${diff.added.length} added`,
  ];
  if (diff.relocated.length > 0) {
    lines.push("Relocated:");
    for (const r of diff.relocated) lines.push(`  ${r.ref.id}: ${locatorPath(r.fromLocator)} -> ${r.toLocator}`);
  }
  if (diff.removed.length > 0) {
    lines.push("Removed:");
    for (const r of diff.removed) lines.push(`  ${r.id}: ${locatorPath(r.locator)}`);
  }
  if (diff.added.length > 0) {
    lines.push("Added controls:");
    for (const a of diff.added) lines.push(`  ${a.candidate.id}: ${locatorPath(a.candidate.locator)}`);
  }
  return lines;
}

export async function runSync(argv: string[], root: string = process.cwd()): Promise<number> {
  const parsed = parseArgs(argv);
  if ("help" in parsed) {
    printUsage();
    return 0;
  }
  if ("error" in parsed) {
    console.error(`[loombridge minigame] sync: ${parsed.error}.`);
    printUsage();
    return 2;
  }

  const contractPath = await resolveContractPath(parsed, root);
  if (!contractPath) {
    console.error(`${ICON.fail} no <id>.minigame.json found — pass --contract or --id.`);
    return 2;
  }

  let contract: MinigameContract;
  try {
    contract = await loadContract(contractPath);
  } catch (error) {
    console.error(`${ICON.fail} could not load contract ${tildify(contractPath)}: ${message(error)}`);
    return 2;
  }

  let scanned: { allScenePaths: string[]; candidates: RoleCandidates };
  try {
    scanned = await scanScene(parsed.scene);
  } catch (error) {
    const hint = unityConnectionHint(error);
    console.error(hint ? hint.join("\n") : `[loombridge minigame] sync: scan failed: ${message(error)}`);
    return 1;
  }

  const diff = diffContractVsScene(contract, scanned.allScenePaths, scanned.candidates);
  console.log(diffLines(diff).join("\n"));

  if (!parsed.apply) {
    const cmd = [
      "loombridge minigame sync",
      "--scene", parsed.scene,
      parsed.contract ? "--contract" : parsed.id ? "--id" : "",
      parsed.contract ?? parsed.id ?? "",
      "--apply",
    ].filter(Boolean).join(" ");
    console.log(`${ICON.next} Dry run only. To apply safe relocations, run: ${cmd}`);
    console.log(`${ICON.info} Add --add to adopt new controls; add --remove to drop missing refs.`);
    return 0;
  }

  let next: MinigameContract;
  try {
    next = applyContractDiff(contract, diff, { add: parsed.add, remove: parsed.remove });
  } catch (error) {
    console.error(`${ICON.fail} sync would make the contract invalid — not written: ${message(error)}`);
    return 1;
  }
  await writeJsonAtomic(contractPath, next);
  console.log(`${ICON.pass} wrote structural updates to ${tildify(contractPath)}.`);
  console.log(`${ICON.next} Re-capture affected screens, then run \`loombridge verify --minigame\`.`);
  return 0;
}
