/**
 * Persistent, developer-authored verification-config OVERRIDES for a mini-game workspace.
 *
 * The scene-agnostic (`check --id`, no `--scene`) flow is RECORD-FIRST: it regenerates the contract from
 * a fresh recording every run (record → scan → merge → write). So any config a developer adds AFTER seeing
 * a verdict — most importantly `safeAreaBackground` (declaring decoration so the safe-area sweep stops
 * flagging it) — is wiped on the next `check`. This module keeps that config in a per-workspace sidecar
 * (`overrides.json`) and re-applies it onto every freshly-built contract, so the developer declares ONCE.
 *
 * MOAT-aligned: this only carries config the developer EXPLICITLY declared (e.g. via
 * `minigame declare-background`, which refuses to exempt a real control). It never guesses. Scope is
 * CONTRACT-LEVEL fields only (no per-state `outcomeGated`/`inputResponse`, whose keys are scene-namespaced
 * state ids that can shift across regenerations — a separate follow-up).
 *
 * Split pure/IO so the merge (`applyContractOverrides`) is unit-tested without disk.
 */

import fs from "node:fs/promises";
import path from "node:path";

import { covers } from "./minigame-report-render.js";
import { validateMinigameContract } from "./profiles/validator.js";
import type { MinigameContract } from "./profiles/types.js";

/** The developer-authored, contract-LEVEL config the sidecar persists (all optional). */
export interface ContractOverrides {
  safeAreaBackground?: string[];
  safeAreaExempt?: string[];
  uiSafeAreas?: { insets?: { top?: number; bottom?: number; left?: number; right?: number } };
  backgroundCamera?: string;
  backgroundLayers?: string[];
  baseline?: { ref: string; capturedAt?: string; masks?: string[] };
}

/** The sidecar file, alongside the contract in the workspace. */
export function overridesPath(workspaceDir: string): string {
  return path.join(workspaceDir, "overrides.json");
}

/** Read the overrides sidecar; null when absent / unreadable / not an object (a missing sidecar is the
 *  normal single-scene case — never an error). */
export async function loadOverrides(workspaceDir: string): Promise<ContractOverrides | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(overridesPath(workspaceDir), "utf-8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as ContractOverrides) : null;
  } catch {
    return null;
  }
}

/** Union two path/glob/id lists (trim, dedupe, sort). When `fold`, also drop an entry already covered by
 *  another (segment-safe `covers`) — the minimal `safeAreaBackground` form `computeDeclaration` produces. */
function unionList(current: readonly string[] | undefined, add: readonly string[] | undefined, fold: boolean): string[] {
  const set = [...new Set([...(current ?? []), ...(add ?? [])].map((s) => s.trim()).filter((s) => s.length > 0))];
  const minimal = fold ? set.filter((c) => !set.some((other) => other !== c && covers(other, c))) : set;
  return minimal.sort();
}

/** One independently-revertible override application onto a contract. */
interface FieldSetter {
  field: keyof ContractOverrides;
  apply: (c: MinigameContract) => MinigameContract;
}

/** The setters an `overrides` object contributes (only for the fields it actually supplies). */
function settersFor(overrides: ContractOverrides): FieldSetter[] {
  const setters: FieldSetter[] = [];
  if (overrides.safeAreaBackground?.length) {
    setters.push({ field: "safeAreaBackground", apply: (c) => ({ ...c, safeAreaBackground: unionList(c.safeAreaBackground, overrides.safeAreaBackground, true) }) });
  }
  if (overrides.safeAreaExempt?.length) {
    setters.push({ field: "safeAreaExempt", apply: (c) => ({ ...c, safeAreaExempt: unionList(c.safeAreaExempt, overrides.safeAreaExempt, false) }) });
  }
  if (overrides.backgroundCamera) {
    setters.push({ field: "backgroundCamera", apply: (c) => ({ ...c, backgroundCamera: overrides.backgroundCamera }) });
  }
  if (overrides.backgroundLayers?.length) {
    setters.push({ field: "backgroundLayers", apply: (c) => ({ ...c, backgroundLayers: unionList(c.backgroundLayers, overrides.backgroundLayers, false) }) });
  }
  if (overrides.uiSafeAreas?.insets) {
    setters.push({ field: "uiSafeAreas", apply: (c) => ({ ...c, uiSafeAreas: { ...c.uiSafeAreas, insets: { ...c.uiSafeAreas?.insets, ...overrides.uiSafeAreas!.insets } } }) });
  }
  if (overrides.baseline) {
    setters.push({ field: "baseline", apply: (c) => ({ ...c, baseline: { ...c.baseline, ...overrides.baseline! } }) });
  }
  return setters;
}

/**
 * Apply developer overrides onto a freshly-built contract. PURE. Each override field is validated in
 * ISOLATION against the base contract first: a field that would make the contract invalid is DROPPED
 * (named in `dropped`) and the rest still applied — a stale/bad sidecar must never brick `check`, only
 * surface loudly. If the base contract is already invalid (a separate bug surfaced elsewhere), the
 * overrides are skipped untouched.
 */
export function applyContractOverrides(
  contract: MinigameContract,
  overrides: ContractOverrides | null,
): { contract: MinigameContract; applied: string[]; dropped: string[] } {
  if (!overrides) return { contract, applied: [], dropped: [] };
  if (!validateMinigameContract(contract).valid) return { contract, applied: [], dropped: [] };

  const setters = settersFor(overrides);
  const good: FieldSetter[] = [];
  const dropped: string[] = [];
  for (const s of setters) {
    if (validateMinigameContract(s.apply(contract)).valid) good.push(s);
    else dropped.push(String(s.field));
  }
  let result = contract;
  for (const s of good) result = s.apply(result);
  // A field combination that's individually-valid but jointly-invalid is unexpected; fall back safely.
  if (!validateMinigameContract(result).valid) {
    return { contract, applied: [], dropped: [...dropped, ...good.map((s) => String(s.field))] };
  }
  return { contract: result, applied: good.map((s) => String(s.field)), dropped };
}

/** Read-merge-write the sidecar: accumulate a patch (union the list fields, set the scalar/object ones)
 *  so repeated declarations build up rather than overwrite. */
export async function mergeIntoOverrides(workspaceDir: string, patch: ContractOverrides): Promise<void> {
  const current = (await loadOverrides(workspaceDir)) ?? {};
  const next: ContractOverrides = { ...current };
  if (patch.safeAreaBackground) next.safeAreaBackground = unionList(current.safeAreaBackground, patch.safeAreaBackground, true);
  if (patch.safeAreaExempt) next.safeAreaExempt = unionList(current.safeAreaExempt, patch.safeAreaExempt, false);
  if (patch.backgroundLayers) next.backgroundLayers = unionList(current.backgroundLayers, patch.backgroundLayers, false);
  if (patch.backgroundCamera) next.backgroundCamera = patch.backgroundCamera;
  if (patch.uiSafeAreas?.insets) next.uiSafeAreas = { insets: { ...current.uiSafeAreas?.insets, ...patch.uiSafeAreas.insets } };
  if (patch.baseline) next.baseline = { ...current.baseline, ...patch.baseline };
  await fs.writeFile(overridesPath(workspaceDir), `${JSON.stringify(next, null, 2)}\n`, "utf-8");
}
