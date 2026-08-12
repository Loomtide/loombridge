/**
 * `loombridge plan` — establish/refresh the design target + contract in `.loombridge/`.
 *
 * Walking-skeleton scope (plan §8 M1): the DETERMINISTIC part of `plan` only —
 * scaffold `.loombridge/`, seed a validated `ACCEPTANCE.json` from the genre
 * template, derive `FEEL_SPEC.json`, and drop `GAME_SPEC.md` + `design/` stubs.
 *
 * The agent-judgment part — the Design Target Phase (plan §3c: generate/ingest an
 * annotated hero shot, human-approve, freeze) — is orchestrated by the command
 * layer (`commands/loombridge/plan.md`, `scripts/loombridge-plan`), NOT here. This
 * file just lays down the slots and refuses to silently clobber a contract.
 */

import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

import { assertValidAcceptanceContract } from "./validator.js";
import type { AcceptanceContract } from "./types.js";
import {
  ensureScaffold,
  fileExists,
  loombridgePaths,
  nowIso,
  readState,
  updateState,
  writeState,
  type LoombridgePaths,
  UNPLANNED_GENRE,
  type LoombridgeState,
} from "../../domain/state.js";
import { designStatus, exitCodeForDesignReadiness } from "./design.js";
import {
  ASSET_MANIFEST_MODES,
  createDraftAssetManifest,
  readAssetManifest,
  writeAssetManifest,
  type AssetManifest,
  type AssetManifestMode,
} from "../assets/asset-manifest.js";
import { isSliceDone } from "./doneness.js";
import {
  assertValidSlicePlan,
  awaitingApprovalSlices,
  getSliceSignoffPath,
  instantiateSlicePlan,
  nextUnblockedSlice,
  planDispatchMode,
  readSlicePlan,
  renderSliceSkill,
  sliceApprovalEvidence,
  writeSlicePlan,
  type SlicePlan,
} from "./slices.js";
import { readInstalledSkills } from "../setup/installed-skills.js";
import { computeStatusModel, renderPlanStatusEcho } from "./status-model.js";
import { defaultGenreId, knownGenreIds, resolveGenrePack } from "../genre/genre-registry.js";
import { promoteGenreContract, type GenrePromotionResult } from "../genre/genre-contract/promote.js";
import {
  genreContractPlaceholderPaths,
  placeholderPrefix,
} from "../genre/genre-contract/scaffold.js";
import { readGenrePromotionReport } from "../genre/promotion-report.js";
import { resolveBriefBundle } from "../../domain/brief-bundle.js";
// Never count `..` to find the package root (CLAUDE.md) — re-nesting this file would repoint it.
import { packageRoot } from "../../shared/pkg-root.js";
import { formatDesignHardeningAdvisory } from "../genre/genre-contract/design-hardening.js";
import type { GenreContract } from "../genre/genre-contract/types.js";

// Genre-specific paths (acceptance + slice templates) are resolved through the genre registry
// (`genre-registry.ts`) — the single source of truth that replaced the hard-coded per-genre dicts.

/**
 * Pure, synchronous engine auto-detection from the project root (deterministic
 * CLI track — see CLAUDE.md two-track discipline). Inspects well-known engine
 * markers; never prompts (asking-when-unclear is the agent layer's job, in
 * `commands/loombridge/plan.md`). Returns the detected engine, or `null` + a
 * human-readable reason the CLI turns into an exit-2 usage error.
 */
export type EngineDetection =
  | { engine: string }
  | { engine: null; reason: string };

export function detectEngine(root: string): EngineDetection {
  // Unity: ProjectSettings/ProjectVersion.txt is the canonical project marker.
  if (fsSync.existsSync(path.join(root, "ProjectSettings", "ProjectVersion.txt"))) {
    return { engine: "unity" };
  }
  // Godot: a project.godot manifest at the root.
  if (fsSync.existsSync(path.join(root, "project.godot"))) {
    return { engine: "godot" };
  }
  // Unreal: any *.uproject file at the root.
  try {
    if (fsSync.readdirSync(root).some((name) => name.endsWith(".uproject"))) {
      return { engine: "unreal" };
    }
  } catch {
    // root unreadable / missing → treated as "nothing detected" below.
  }
  return {
    engine: null,
    reason: `could not detect a game engine project at ${root} — run from a project root or pass --engine`,
  };
}

/**
 * The GENRE-NEUTRAL fallback pack (CommandSurfaceRedesign W1/D). An unregistered `--genre` seeds
 * from here instead of exiting 2, and verifies as `genreCoverage: "ungraded"` with its gaps listed.
 *
 * The underscore prefix keeps it OUT of `knownGenreIds()`, which matters in three places: it can
 * never be selected as a genre of its own, the registry template walk does not audit it as a real
 * pack, and the W2 skill-binding guard does not expect bindings it deliberately has none of.
 */
const GENERIC_PACK_DIR = path.join(
  packageRoot(import.meta.url),
  "src",
  "capabilities",
  "genre",
  "genre-packs",
  "_generic",
);

/** Read + validate a genre's slice-DAG roadmap template, falling back to the generic pack. */
async function loadSliceTemplate(genre: string): Promise<SlicePlan> {
  const pack = resolveGenrePack(genre);
  const templatePath = pack ? pack.sliceTemplatePath : path.join(GENERIC_PACK_DIR, "slices.json");
  const raw = await fs.readFile(templatePath, "utf-8");
  // The generic DAG declares the project's OWN genre string, not "generic" — the roadmap must bind
  // to the genre the project was planned as, or the slice roll-up's plan-vs-STATE agreement check
  // (added in W1) would refuse every free-form project.
  return assertValidSlicePlan({ ...JSON.parse(raw), genre });
}

/**
 * The genre a prior `STATE.md` supplies, or `undefined` when it supplies none.
 *
 * ONE definition, two readers: the re-plan preservation below and the refusal in `run` must agree
 * about whether STATE answers "what genre is this project?", or bare `plan` would refuse on a
 * project whose genre it was about to preserve anyway. `UNPLANNED_GENRE` is the sentinel a
 * `target set` before any `plan` leaves behind, and it means "no genre chosen yet".
 */
function genreFromState(prev: LoombridgeState | null): string | undefined {
  return prev?.genre && prev.genre !== UNPLANNED_GENRE ? prev.genre : undefined;
}

/** The `genre` FEEL_SPEC.json declares, or `undefined` when it is absent/unreadable. */
async function genreFromFeelSpec(paths: LoombridgePaths): Promise<string | undefined> {
  return declaredGenre(paths.feelSpec);
}

/**
 * The `genre` ACCEPTANCE.json declares, or `undefined` when it declares none.
 *
 * ACCEPTANCE.json is the artifact whose CONTENTS ARE THE GRADING, so it is the one that must be able
 * to state its own genre. Legacy/hand-authored contracts carry no `genre` and correctly answer
 * `undefined`: absent is no claim, never a default (see `AcceptanceContract.genre`).
 */
async function genreFromAcceptance(paths: LoombridgePaths): Promise<string | undefined> {
  return declaredGenre(paths.acceptance);
}

/** The non-empty string `genre` a JSON artifact declares, or `undefined` (absent/unreadable/other). */
async function declaredGenre(file: string): Promise<string | undefined> {
  try {
    const doc = JSON.parse(await fs.readFile(file, "utf-8")) as { genre?: unknown };
    return typeof doc.genre === "string" && doc.genre.length > 0 ? doc.genre : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The genres this project ALREADY records, read from the artifacts a run KEEPS rather than re-seeds.
 *
 * Deliberately not "STATE.genre" alone. The failure being detected is exactly a STATE that no longer
 * agrees with the contract beside it, so the check has to read the contract from DISK; trusting
 * STATE would make an already-desynced project invisible to its own guard.
 *
 * Which artifacts count depends on what a no-`--force` run rewrites:
 *  - SLICES.json is NEVER rewritten without `--force` (it is written only in `mode === "design"`,
 *    which an existing roadmap suppresses), so its genre always counts.
 *  - ACCEPTANCE.json's OWN `genre` stamp counts whenever the file is on disk to be kept. This is the
 *    artifact whose contents ARE the grading, and it was the one the guard never read. With
 *    SLICES.json absent (the design phase, before any roadmap) and FEEL_SPEC.json + STATE.md deleted,
 *    `found` was `[]` and the guard could not fire at all: a platformer ACCEPTANCE.json
 *    (`win.rule: "all-fruit"`, no `verification` block) was stamped `graded` under a 3d-shooter
 *    STATE. Reading the contract itself is what makes the guard independent of the two files the
 *    desync destroys.
 *  - FEEL_SPEC.json is rewritten only when ACCEPTANCE.json is (re)seeded, so it counts only while
 *    an ACCEPTANCE.json is on disk to be kept. With none, everything is re-seeded and nothing is
 *    stale, which is why a first `plan` in a fresh project reaches no refusal at all.
 *  - STATE.md is the LAST resort, used only when no contract artifact declares a genre of its own
 *    (a project seeded before FEEL_SPEC.json carried one). It is the file the desync CORRUPTS, so
 *    letting it speak while the contract can speak for itself would let a rewritten STATE.md hide
 *    the change from its own guard, and it would break the repair path, where re-running at the
 *    genre the contract actually describes must be accepted and must rewrite STATE back.
 */
async function recordedContractGenres(
  paths: LoombridgePaths,
  prev: LoombridgeState | null,
  existingPlan: SlicePlan | null,
): Promise<string[]> {
  const found: string[] = [];
  if (existingPlan) found.push(existingPlan.genre);
  if (await fileExists(paths.acceptance)) {
    const acceptanceGenre = await genreFromAcceptance(paths);
    if (acceptanceGenre) found.push(acceptanceGenre);
    const feelGenre = await genreFromFeelSpec(paths);
    if (feelGenre) found.push(feelGenre);
    if (found.length === 0) {
      const stateGenre = genreFromState(prev);
      if (stateGenre) found.push(stateGenre);
    }
  }
  return [...new Set(found)];
}

/**
 * REFUSE to guess the genre. Returns the refusal message, or `null` when the genre IS stated.
 *
 * A guessed genre is the one route in the system to a wrong `graded` coverage claim: defaulting to
 * the registry default seeds THAT genre's contract (its win rule, its feel metrics, its gate-tuning
 * section) and, because the default resolves to a registered pack, the "unregistered genre" warning
 * never fires and coverage still stamps `graded`. Observed live: a project named for an extraction
 * shooter was seeded with a platformer contract, nine platformer feel metrics, and no
 * `verification.gates` block, so the platformer-shaped gates stayed applicable.
 *
 * `loombridge adopt` already refuses on the same reasoning ("default to the registry default is
 * WRONG (it would silently mis-genre the proposal), so require it"); this is the other front door.
 *
 * Three ways the genre IS stated, and each keeps working with no flag churn: `--genre`, a
 * contract/brief that carries its own genre id, and the genre a prior `plan` already recorded in
 * STATE (so re-planning an existing project never needs the flag).
 */
export function unstatedGenreRefusal(args: {
  /** True when `--genre` was passed on the command line. */
  genreExplicit: boolean;
  /** True when `--genre-contract` / `--brief` was passed (the contract declares the genre). */
  hasContractSource: boolean;
  /** The genre a prior `STATE.md` supplies, if any (see {@link genreFromState}). */
  stateGenre: string | undefined;
  /**
   * The registered genre ids. Injected so a test can exercise the single-registered-genre case
   * without unregistering a real pack (which would weaken every other genre guard in the suite).
   */
  known?: readonly string[];
}): string | null {
  const known = args.known ?? knownGenreIds();
  // Defaulting is only correct while there is exactly one thing to default TO. With a single
  // registered pack the default IS the answer, so back-compat holds and `DEFAULT_GENRE_ID` stays.
  if (known.length < 2) return null;
  if (args.genreExplicit || args.hasContractSource || args.stateGenre) return null;
  return (
    "[loombridge plan] --genre is required: " +
    `${known.length} genre packs are registered, and \`plan\` will not guess which one this project ` +
    "is. A guessed genre seeds that genre's whole contract and still claims `graded`, so the build " +
    "would be graded against gates it was never designed for. " +
    `Known: ${known.join(", ")}. ` +
    "Pass --genre <id> for a registered pack, or --genre-contract <path> / --brief <path> to plan a " +
    "genre that has no pack. To WRITE that contract, run " +
    "`loombridge genre init --genre <your-id> --class <twitch|systems|hybrid>`: it emits one that " +
    "passes the validator unedited, at the path `--brief .loombridge` resolves. (Naming the command " +
    'matters: "author a genre contract" on its own sends a reader off to study the validator.) ' +
    "(Re-planning an existing project needs no flag: the genre already in STATE.md wins.)"
  );
}

export interface PlanArgs {
  /** Project root (the dir that will contain `.loombridge/`). */
  root: string;
  genre: string;
  /**
   * Whether `--genre` was passed explicitly (vs defaulted). When false, a re-plan PRESERVES the
   * genre already in STATE instead of resetting it to the registry default — so a bare `loombridge
   * plan` after a `--genre-contract` promotion does not silently flip the genre back to platformer-2d.
   */
  genreExplicit?: boolean;
  engine: string;
  /** Optional game name; overrides the folder-derived game name. */
  name?: string;
  /** Optional GenreContract JSON to promote instead of seeding from a registered pack template. */
  genreContractPath?: string;
  /**
   * Optional design-doc bundle (RCL-P03): a docs directory or brief file carrying
   * the interview-equivalent structured GenreContract. Resolved to a
   * `genreContractPath` and promoted exactly like `--genre-contract`, so an
   * existing written spec is a first-class brief source — not only the interview.
   */
  briefPath?: string;
  /** Overwrite existing seeded files instead of leaving them untouched. */
  force: boolean;
  /**
   * Escape hatch (§3c): allow `plan` to complete without an approved + frozen
   * Design Target. Default false — the gate is ON by default so users (and the
   * `/loombridge:plan` slash command) do not have to remember a flag for the
   * common path; the *exception* is the explicit flag.
   */
  allowMissingDesignTarget?: boolean;
  /**
   * Confirm-before-mutate for human approval seams. Roadmap scaffold is
   * deterministic once the Design Target is approved, so bare `plan` creates it.
   * `--go` remains the explicit approval action for verified slices.
   */
  go?: boolean;
  /** Optional approval note recorded when `plan --go` approves verified slices. */
  note?: string;
  /** Optional operator sign-off image/frame copied into .loombridge/anchors/signoffs/<id>/. */
  signoffPath?: string;
  /** Record the developer's explicit asset-source strategy in ASSET_MANIFEST.json. */
  assetMode?: AssetManifestMode;
}

interface AssetManifestReadiness {
  status: "missing" | "draft" | "approved" | "invalid";
  approved: boolean;
  mode?: AssetManifestMode;
  manifest?: AssetManifest;
  reason?: string;
}

/** Loosely-typed view of the contract fields GAME_SPEC.md is derived from. */
interface ContractView {
  game?: string;
  win?: { rule?: string; note?: string };
  feel?: Record<string, { target?: number; unit?: string }>;
  hud?: { elements?: Array<{ id?: string; role?: string; anchor?: string }> };
  manifest?: { elements?: Array<{ primitive?: string; nameRegex?: string }> };
  framing?: { cameraMode?: string; aspect?: { w?: number; h?: number } };
  audio?: { cues?: Array<{ id?: string }> };
}

const PRIMITIVE_LABELS: Record<string, string> = {
  player: "a player character",
  tile: "terrain / platforms",
  collectible: "collectibles",
  hazard: "hazards",
  goal: "a level goal",
  launcher: "launchers (trampolines/springs)",
  audio: "audio cues",
};

/**
 * Auto-derive GAME_SPEC.md from the seeded ACCEPTANCE contract (#64) — a human-
 * readable mirror of the machine-checkable contract, NOT an all-`_TODO_` stub
 * that stays dead weight through the whole e2e flow. The agent may enrich it
 * during the Design Target Phase, but it is meaningful the moment `plan` runs.
 */
export function renderGameSpec(contract: ContractView, genre: string, engine: string): string {
  const game = contract.game ?? "(unnamed)";
  const winRule = contract.win?.rule;
  const aspect = contract.framing?.aspect;
  const cameraMode = contract.framing?.cameraMode;

  const primitives = [
    ...new Set((contract.manifest?.elements ?? []).map((e) => e.primitive).filter((p): p is string => !!p)),
  ];
  const mechanics = primitives.length
    ? primitives.map((p) => `- ${PRIMITIVE_LABELS[p] ?? p}`)
    : ["- _TODO — no primitives declared in the contract manifest._"];

  const feel = contract.feel ?? {};
  const feelRows = Object.entries(feel)
    .filter(([, v]) => v && typeof v === "object" && "target" in v)
    .map(([k, v]) => `| ${k} | ${v.target ?? "?"}${v.unit ? ` ${v.unit}` : ""} |`);

  const hud = (contract.hud?.elements ?? [])
    .map((e) => `- \`${e.id ?? "?"}\`${e.role ? ` — ${e.role}` : ""}${e.anchor ? ` (${e.anchor})` : ""}`);

  const cues = (contract.audio?.cues ?? []).map((c) => c.id).filter(Boolean);

  const lines: string[] = [
    "# Game Spec",
    "",
    "> Auto-derived from `ACCEPTANCE.json` by `loombridge plan` — a human-readable mirror of the",
    "> machine-checkable contract. Enrich it during the Design Target Phase; the contract stays",
    "> the source of truth for the gates.",
    "",
    "## One-line pitch",
    "",
    `A ${genre} game ("${game}") built with Loombridge on ${engine}` +
      (winRule ? `. Objective: **${winRule}**.` : "."),
    "",
    "## Core mechanics",
    "",
    ...mechanics,
    "",
    "## Win / lose condition",
    "",
    winRule
      ? `**Win:** ${winRule}.${contract.win?.note ? ` ${contract.win.note}` : ""}`
      : "_TODO — no win rule declared in the contract._",
  ];

  if (feelRows.length) {
    lines.push("", "## Feel targets", "", "| metric | target |", "|---|---|", ...feelRows);
  }
  if (hud.length) {
    lines.push("", "## HUD", "", ...hud);
  }
  if (aspect?.w && aspect?.h) {
    lines.push("", "## Framing", "", `- ${aspect.w}:${aspect.h}${cameraMode ? `, ${cameraMode} camera` : ""}`);
  }
  if (cues.length) {
    lines.push("", "## Audio cues", "", `- ${cues.join(", ")}`);
  }
  lines.push("");
  return lines.join("\n");
}

const DESIGN_README_STUB = `# Design Target (\`.loombridge/design/\`)

This folder holds the **Design Target** (plan §3c): the visual contract \`build\` is
measured against. Drop the **annotated hero shot** here:

- \`hero-shot.html\` — the annotated frame (built from the asset registry).
- \`hero-shot.png\` — the frozen screenshot the VLM review + humans compare against.

Until an approved hero shot exists, \`plan\` is not truly complete — without a visual
target the build's *polish* is poor. (The generation/approval flow is driven by the
command layer, not the deterministic CLI.)
`;

type WriteOutcome = "created" | "kept";

async function writeIfAbsent(
  filePath: string,
  content: string,
  force: boolean,
): Promise<WriteOutcome> {
  if (!force && (await fileExists(filePath))) return "kept";
  await fs.writeFile(filePath, content, "utf-8");
  return "created";
}

async function copySignoffArtifact(args: {
  root: string;
  sliceId: string;
  signoffPath: string;
}): Promise<{ artifact: string; sha256: string }> {
  let bytes: Buffer;
  try {
    bytes = await fs.readFile(args.signoffPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`--signoff file not found: ${args.signoffPath}`);
    }
    throw error;
  }
  const ext = /^[.][A-Za-z0-9]{1,12}$/.test(path.extname(args.signoffPath))
    ? path.extname(args.signoffPath)
    : ".bin";
  const dest = getSliceSignoffPath(loombridgePaths(args.root), args.sliceId, ext);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.writeFile(dest, bytes);
  const durableBytes = await fs.readFile(dest);
  return {
    artifact: path.relative(args.root, dest),
    sha256: createHash("sha256").update(durableBytes).digest("hex"),
  };
}

async function assetManifestReadiness(paths: LoombridgePaths): Promise<AssetManifestReadiness> {
  try {
    const manifest = await readAssetManifest(paths);
    if (!manifest) return { status: "missing", approved: false };
    return {
      status: manifest.status,
      approved: manifest.status === "approved",
      mode: manifest.mode,
      manifest,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: "invalid", approved: false, reason: message };
  }
}

function renderAssetModeHelp(): void {
  console.error("[loombridge plan] asset strategy required before slice planning:");
  console.error("[loombridge plan]   registry  — use an approved registry pack; slices use those recorded assets.");
  console.error("[loombridge plan]   generated — generate/export assets from the approved hero-shot annotations.");
  console.error("[loombridge plan]   hybrid    — use an approved registry base and generated/manual missing assets.");
}

async function recordAssetStrategyDraft(args: {
  paths: LoombridgePaths;
  mode: AssetManifestMode;
  force: boolean;
  designPngSha256: string;
  genre: string;
}): Promise<"created" | "kept"> {
  if (!args.force && (await fileExists(args.paths.assetManifest))) return "kept";
  const draft = createDraftAssetManifest({
    mode: args.mode,
    heroShot: {
      path: ".loombridge/design/hero-shot.png",
      sha256: args.designPngSha256,
    },
    // Draft for the plan's genre so a 3d-shooter plan drafts 3d-shooter roles, not
    // platformer defaults. An unregistered asset genre resolves to platformer.
    genre: args.genre,
  });
  await writeAssetManifest(args.paths, draft);
  return "created";
}

/**
 * Print the ADVISORY design-doc hardening report for an ingested GenreContract. Emits the coverage
 * checklist (present/partial/absent per item) followed by the aggregated WARNs (anti-drift + scale).
 * Everything here is `console.error` diagnostics — it never affects the plan exit code.
 */
function emitDesignHardeningAdvisory(contract: GenreContract): void {
  for (const line of formatDesignHardeningAdvisory(contract)) {
    console.error(`[loombridge plan] ${line}`);
  }
}

/**
 * Run `plan` programmatically. Returns a process exit code (0 ok, 2 usage error).
 * Exported for tests.
 */
export async function runPlan(args: PlanArgs): Promise<number> {
  const paths = loombridgePaths(args.root);
  const rel = (p: string) => path.relative(args.root, p);
  // Read prior state once, up front: a re-plan must PRESERVE the genre it already promoted to.
  const prev = await readState(paths);

  // RCL-P03: a `--brief` design-doc bundle resolves to the SAME structured
  // GenreContract the interview emits, then flows through the identical promotion
  // path below — so a written spec is just another way to supply the brief.
  let genreContractPath = args.genreContractPath;
  if (args.briefPath) {
    if (genreContractPath) {
      console.error("[loombridge plan] pass either --brief or --genre-contract, not both.");
      return 2;
    }
    const resolved = resolveBriefBundle(args.briefPath);
    if ("error" in resolved) {
      console.error(`[loombridge plan] invalid --brief: ${resolved.error}`);
      return 2;
    }
    genreContractPath = resolved.genreContractPath;
    console.error(
      `[loombridge plan] brief bundle → ${path.relative(args.root, genreContractPath)} ` +
        `(${resolved.source}${resolved.matchedFile ? `: ${resolved.matchedFile}` : ""}, promoted as a GenreContract)`,
    );
  }

  let genreContractInput: unknown | null = null;
  let genreContractSha256: string | undefined;
  let promoted: GenrePromotionResult | null = null;
  if (genreContractPath) {
    try {
      // Hash the RAW bytes, before parsing — a digest over a re-serialized object would depend on
      // key order and formatting, so it would drift and prove nothing about the file on disk.
      const rawContract = await fs.readFile(genreContractPath, "utf-8");
      genreContractSha256 = createHash("sha256").update(rawContract, "utf-8").digest("hex");
      genreContractInput = JSON.parse(rawContract);
      promoted = promoteGenreContract(genreContractInput);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[loombridge plan] invalid --genre-contract: ${message}`);
      return 2;
    }
    // REFUSE A CONTRACT THAT IS STILL A SCAFFOLD. `genre init` seeds the fields no generator can
    // know (the core loop, the art direction, each feedback chain) with its placeholder marker and
    // says so ONCE on stdout, and nothing ever looked again. `validateGenreContract` cannot catch
    // it either: a placeholder IS a non-empty string, so the contract is structurally valid and
    // `plan` produced a full roadmap, a GAME_SPEC.md stating the placeholder as the pitch, and a
    // `partially-graded` coverage stamp over fields nobody had written.
    //
    // Same convention as the mini-game pipeline's `isDraftContract` (`DRAFT:`/`TODO:` prefixes,
    // `capabilities/minigame/minigame-draft.ts`), not a second one: a prefix-anchored check over
    // the DESCRIPTIONS, and a draft is not runnable. Anchored at the start, so a real art-direction
    // phrase that merely mentions the words never trips it.
    //
    // Refuses BEFORE `ensureScaffold`: a refusal that has already written half a `.loombridge/` is
    // not a refusal.
    const placeholders = genreContractPlaceholderPaths(genreContractInput);
    if (placeholders.length > 0) {
      console.error(
        `[loombridge plan] NOT ready: ${path.relative(args.root, genreContractPath)} still carries ` +
          `${placeholders.length} unwritten "${placeholderPrefix()}" field(s): ${placeholders.join(", ")}.`,
      );
      console.error(
        "[loombridge plan] Each one is a decision `loombridge genre init` could not make for you, and " +
          "planning on top of them would mint a roadmap, a GAME_SPEC.md, and a coverage claim over " +
          "text nobody wrote. Fill them in and re-run.",
      );
      return 2;
    }
  }

  // Genre resolution precedence: an explicit --genre-contract (its sourceGenreId) wins; then an
  // explicit --genre; then the genre already recorded in STATE; then the registry default.
  //
  // PRESERVE ANY RECORDED GENRE EXCEPT THE PLACEHOLDER. This originally tested "is it REGISTERED?",
  // which was equivalent while every plannable genre was registered. The free-form entry path broke
  // that equivalence and the old test became a live bug: a bare `loombridge plan` after
  // `plan --genre my-weird-game` silently rewrote STATE.genre to platformer-2d, converting the
  // developer's project into a platformer AND upgrading its coverage claim from `ungraded` to
  // `graded` — a full Tier-1 claim over the genre-neutral contract it was actually planned from.
  // That is precisely the silent-default false-green the registry refusal existed to prevent,
  // re-entering through the new door.
  //
  // The only value that must NOT stick is `UNPLANNED_GENRE`, the sentinel a `target set` before any
  // `plan` leaves behind — that one means "no genre chosen yet", so the default correctly wins.
  const preservedGenre = !args.genreExplicit ? genreFromState(prev) : undefined;
  const genre = promoted?.report.sourceGenreId ?? preservedGenre ?? args.genre;
  const genrePack = resolveGenrePack(genre);

  // COVERAGE, NOT REFUSAL (CommandSurfaceRedesign W1 + D). The registry's closed set governs what
  // `verify` CLAIMS, never what `plan` ACCEPTS. There are three ways in, and no genre string is
  // turned away at the door any more:
  //
  //  - REGISTERED: the pack IS the plan — its acceptance + slice templates are seeded. `graded`.
  //  - PROMOTED (--genre-contract / --brief): the contract supplies acceptance AND slices, and the
  //    pack's `acceptanceTemplatePath` is never even read (`promoted?.acceptance` short-circuits it
  //    below). `partially-graded`, with real gaps from the contract's own promotion report.
  //  - FREE-FORM: any other `--genre` seeds the genre-neutral `_generic` pack. `ungraded`, with a
  //    boilerplate gap list, because there is no oracle of any kind for an unknown genre.
  //
  // The last one is what makes D1's "an ungraded game may reach doneness" reachable at all. Before
  // it, `ungraded` was a state nothing could actually be in: the front door refused first.
  //
  // The pack's slice template stays OPTIONAL on the promoted path: when it exists, matching slice
  // ids keep pack-owned skill/gate guidance; when the genre is unregistered there is none, and the
  // promoter already accepts `sliceTemplate: undefined`.
  // The promotion report ALREADY ON DISK. A project planned from a contract keeps one, and it is the
  // artifact `deriveGenreCoverage` reads at verify/doneness time, so any message here that describes
  // this project's coverage has to read it too, or the CLI narrates a state the gates do not agree
  // with. Read before `ensureScaffold` (it only reads) and reused by the refusal below.
  const priorPromotion = await readGenrePromotionReport(paths);
  const priorPromotionForGenre = priorPromotion?.sourceGenreId === genre ? priorPromotion : null;

  if (!genrePack && !promoted) {
    if (priorPromotionForGenre) {
      // THE SECOND BARE `plan` ON A CONTRACT PROJECT. The old text fired here and was wrong three
      // ways: it announced `ungraded` when `deriveGenreCoverage` reads GENRE_PROMOTION.json from
      // disk and returns `partially-graded`; it prescribed "author a genre contract", which is what
      // the developer had already done; and it claimed to be "seeding the GENERIC template" one line
      // before reporting the contract's ACCEPTANCE.json as `kept (unchanged)`.
      console.error(
        `[loombridge plan] genre "${genre}" has no registered pack, and this project was planned from ` +
          `a genre contract (${rel(paths.genrePromotion)}): nothing is re-seeded, and it verifies as ` +
          "`partially-graded` with the contract's own gaps enumerated on the verdict. To change the " +
          "contract, edit it and re-run `loombridge plan --brief <dir> --force` (or `--genre-contract <file> --force`).",
      );
    } else {
      const seeds = args.force || !(await fileExists(paths.acceptance));
      console.error(
        `[loombridge plan] genre "${genre}" has no registered pack: ${seeds ? "seeding" : "keeping"} ` +
          `the GENERIC template. Registered genres (${knownGenreIds().join(", ")}) plan as \`graded\`; ` +
          "this project will verify as `ungraded` (genre-neutral gates only, no feel or fidelity " +
          "oracle). For a stronger claim, author a genre contract with `loombridge genre init --genre " +
          `${genre} --class <twitch|systems|hybrid>` +
          "` and pass --genre-contract <file> (or --brief <dir>).",
      );
    }
  }
  if (genreContractInput) {
    promoted = promoteGenreContract(genreContractInput, {
      ...(genrePack ? { sliceTemplate: await loadSliceTemplate(genre) } : {}),
      ...(genreContractSha256 ? { sourceContractSha256: genreContractSha256 } : {}),
    });
  }

  await ensureScaffold(paths);
  // One spelling of the path, shared with the gate that reads it (`promotion-report.ts`). A second
  // inline `path.join(paths.dir, ...)` here would be a declared path nothing cross-checks: if either
  // drifted, `plan` would write a report the gate never finds and the project would silently drop to
  // `ungraded`.
  const promotionReportPath = paths.genrePromotion;
  if (promoted && !args.force) {
    const existing = [];
    if (await fileExists(paths.acceptance)) existing.push("ACCEPTANCE.json");
    if (await fileExists(paths.slices)) existing.push("SLICES.json");
    if (await fileExists(promotionReportPath)) existing.push("GENRE_PROMOTION.json");
    if (existing.length > 0) {
      console.error(
        `[loombridge plan] NOT ready — --genre-contract would mix promoted artifacts with existing ${existing.join(", ")}. Re-run with --force to replace them.`,
      );
      return 2;
    }
  }

  // ── --force ON A CONTRACT PROJECT, AT ITS OWN GENRE ────────────────────────────────────────────
  // `plan --genre <the contract's own genre> --force` is reachable by combining two lines the flip
  // refusal itself prints ("re-run with --force", "or with --genre <the genre on disk>"). It used to
  // print "removed stale GENRE_PROMOTION.json, and it described the PREVIOUS promoted genre, not X"
  // when `sourceGenreId` IS X, and say nothing about what it actually did: replace the promoted
  // ACCEPTANCE.json with a TEMPLATE, discard the contract's `fidelityCriteria` (after which
  // `doneness` refuses every design-targeted build), move coverage off the contract, and leave
  // SLICES.json still carrying the contract's slices. A half-destroyed project, described as a
  // cleanup.
  //
  // A re-promotion (`--brief` / `--genre-contract`) is the intended iteration loop and is unaffected
  //: this only fires when NO contract was supplied on this run.
  if (!promoted && priorPromotionForGenre && args.force) {
    console.error(
      `[loombridge plan] NOT ready: --force would re-seed ${rel(paths.acceptance)} for "${genre}" from ` +
        `the ${genrePack ? "registered pack" : "genre-neutral"} template, but this project was planned ` +
        `from a genre CONTRACT for that same genre (${rel(paths.genrePromotion)}). That discards the ` +
        "contract's acceptance and its `fidelityCriteria` (after which `loombridge doneness` REFUSES " +
        `every design-targeted build), stops coverage being derived from the contract, and leaves ` +
        `${rel(paths.slices)} still carrying the contract's slices.`,
    );
    console.error(
      "[loombridge plan] To re-promote an EDITED contract (the normal iteration loop): " +
        "`loombridge plan --brief <dir> --force` (or --genre-contract <file> --force). To deliberately " +
        `abandon the contract and seed the template instead: delete ${rel(paths.genrePromotion)} first.`,
    );
    return 2;
  }

  const created: string[] = [];
  const kept: string[] = [];

  // ── a GENRE CHANGE moves the WHOLE contract, or it does not happen at all ───────────────────────
  // One detection point and one policy for both halves of the same failure, so they cannot drift.
  //
  // WITHOUT `--force` nothing under `.loombridge/` is re-seeded, so a flip wrote the NEW genre into
  // STATE.md and left the OLD genre's ACCEPTANCE.json, FEEL_SPEC.json and SLICES.json exactly where
  // they were. Observed live: `plan --genre 3d-shooter` on a project planned as platformer-2d
  // printed no genre notice at all, kept `win.rule: "all-fruit"` in the contract, and recorded
  // `Genre: 3d-shooter` in STATE. Because the new genre resolves to a REGISTERED pack, coverage
  // still stamps `graded`: a second route to the wrong `graded` claim `unstatedGenreRefusal`
  // exists to close, this time with the project graded against another genre's gates.
  //
  // REFUSE it rather than apply it. Applying the flip silently would let one mistyped flag destroy
  // a contract and a roadmap the developer has been building against for hours, and `plan` is
  // re-run constantly with no flags at all. `--force` is already the "overwrite existing seeded
  // files" flag and already carries the approval-proof rule below, so the refusal points there
  // instead of inventing a second policy.
  //
  // WITH `--force` the contract IS re-seeded, but on the non-promoted path SLICES.json is written
  // only in `mode === "design"`, which an existing roadmap suppresses. That left a stale slice DAG
  // still DECLARING the old genre, surfacing much later as a `doneness` roll-up refusal about a
  // genre mismatch: a half-changed project that looks changed. Rewrite it, LOUDLY.
  //
  // Either way, a slice carrying human sign-off REFUSES: an approval is evidence, and a genre flip
  // must never become the cheap way to erase one. `loombridge reopen` is the sanctioned withdrawal.
  const existingPlan = await readSlicePlan(paths);
  const roadmapMoves = existingPlan !== null && existingPlan.genre !== genre;

  // ── THE APPROVAL-PROOF BAR APPLIES TO ANY ROADMAP REWRITE, NOT ONLY A GENRE CHANGE ────────────
  // This guard used to be computed only when `roadmapMoves` was true, while the PROMOTED path writes
  // SLICES.json UNCONDITIONALLY (see below). So re-promoting an edited contract under the SAME
  // genreId: the ordinary iteration loop for the any-genre path: erased human sign-off with no
  // refusal and no notice: a slice with `state: "approved"` plus a full proof block came back
  // `pending`. The rewrite is what the rule is about, so the rule binds to the rewrite.
  //
  // The two rewrite paths, and nothing else writes SLICES.json before `mode === "design"`:
  //   - promoted        `writeSlicePlan(paths, promoted.slices)` further down, every time;
  //   - roadmapMoves    the `--force` genre-flip rebuild from the pack template.
  const roadmapRewritten = existingPlan !== null && (promoted !== null || roadmapMoves);
  if (roadmapRewritten) {
    const signed = existingPlan.slices
      .map((slice) => ({ id: slice.id, evidence: sliceApprovalEvidence(slice) }))
      .filter((s) => s.evidence.length > 0);
    if (signed.length > 0) {
      const cause = roadmapMoves
        ? `changing the genre from "${existingPlan.genre}" to "${genre}"`
        : `re-promoting the "${genre}" genre contract`;
      console.error(
        `[loombridge plan] NOT ready: ${cause} rewrites ${rel(paths.slices)}, but ${signed.length} ` +
          "slice(s) carry an approval proof:",
      );
      for (const s of signed) console.error(`[loombridge plan]   ${s.id}: ${s.evidence.join(", ")}`);
      console.error(
        "[loombridge plan] An approved slice is human-signed evidence and is never discarded silently. " +
          "Withdraw each approval with `loombridge reopen <slice-id>` (it clears the artifacts, cascades " +
          "to dependents, and records the event), then re-run this command.",
      );
      return 2;
    }
  }

  const staleGenres = (await recordedContractGenres(paths, prev, existingPlan)).filter((g) => g !== genre);
  if (staleGenres.length > 0) {
    if (!args.force) {
      console.error(
        `[loombridge plan] NOT ready: this project is planned as "${staleGenres.join('", "')}" and this ` +
          `run resolves the genre to "${genre}". Without --force nothing is re-seeded, so STATE.md ` +
          `would claim "${genre}" while ${rel(paths.acceptance)}, ${rel(paths.feelSpec)} and ` +
          `${rel(paths.slices)} still describe the old genre. A registered genre still stamps ` +
          "coverage `graded`, so the build would be graded against gates it was never designed for.",
      );
      console.error(
        `[loombridge plan] Re-run with --force to re-seed the whole contract for "${genre}" (all build ` +
          "state on the old slices is discarded), or re-run at the genre the contract on disk already " +
          `declares to keep it: ${staleGenres.map((g) => `--genre "${g}"`).join(" / ")}.`,
      );
      return 2;
    }
    // The promoted path writes its own SLICES.json from the contract below, so rewriting from a pack
    // template here would be overwritten a moment later by a better answer.
    if (roadmapMoves && !promoted) {
      const rebuilt = instantiateSlicePlan(await loadSliceTemplate(genre));
      await writeSlicePlan(paths, rebuilt);
      console.error(
        `[loombridge plan] REWROTE ${rel(paths.slices)}: the roadmap declared genre ` +
          `"${existingPlan!.genre}" and --force re-seeds "${genre}". ${existingPlan!.slices.length} ` +
          `slice(s) replaced with ${rebuilt.slices.length} from the "${genre}" roadmap; all build ` +
          "state on the old slices is discarded.",
      );
    }
  }

  // 1. ACCEPTANCE.json — seed from the genre template (validated before write).
  //    Keep the contract object around so GAME_SPEC.md can be derived from it
  //    whether we just seeded it or it already existed.
  let acceptanceOutcome: WriteOutcome;
  let contract: AcceptanceContract;
  if (args.force || !(await fileExists(paths.acceptance))) {
    // Seed precedence: a promoted contract wins; then the registered pack's template; then the
    // genre-neutral `_generic` fallback for a free-form genre. The pack template is read ONLY on the
    // templated path — `promoted?.acceptance` short-circuits it entirely.
    const acceptanceTemplatePath = genrePack
      ? genrePack.acceptanceTemplatePath
      : path.join(GENERIC_PACK_DIR, "acceptance.json");
    const template =
      promoted?.acceptance ??
      (JSON.parse(await fs.readFile(acceptanceTemplatePath, "utf-8")) as AcceptanceContract);
    const seededGameName = args.name ?? (path.basename(args.root) || template.game);
    // STAMP THE GENRE INTO THE CONTRACT. The contract is the grading; it has to say which genre it
    // grades, or the flip guard has nothing to read once FEEL_SPEC.json and STATE.md are gone. See
    // `recordedContractGenres` and `AcceptanceContract.genre`.
    contract = { ...template, game: seededGameName, genre };
    assertValidAcceptanceContract(contract); // fail fast if our seed is invalid
    await fs.writeFile(paths.acceptance, `${JSON.stringify(contract, null, 2)}\n`, "utf-8");
    acceptanceOutcome = "created";

    // 2. FEEL_SPEC.json — derived from the contract's feel section.
    const feel = (contract as unknown as { feel?: unknown }).feel ?? {};
    const feelSpec = {
      genre,
      source: "derived from ACCEPTANCE.json `feel` by `loombridge plan`",
      metrics: feel,
    };
    await fs.writeFile(paths.feelSpec, `${JSON.stringify(feelSpec, null, 2)}\n`, "utf-8");
    if ((await fileExists(paths.feelSpec))) created.push(rel(paths.feelSpec));
  } else {
    contract = JSON.parse(await fs.readFile(paths.acceptance, "utf-8")) as AcceptanceContract;
    acceptanceOutcome = "kept";
  }
  (acceptanceOutcome === "created" ? created : kept).push(rel(paths.acceptance));

  if (promoted) {
    // NAME WHAT WAS INVENTED. A GenreContract has no field for a win rule, a font, a palette or a
    // native resolution, so the promoter fills all four from a pixel-art 2D template: and
    // GAME_SPEC.md then prints them as fact ("Objective: all-enemies-defeated") with nothing
    // marking them as assumptions. One line here is the difference between a default and a silent
    // decision. Only on the run that actually promoted; a re-plan re-reads the contract from disk.
    if (acceptanceOutcome === "created") {
      console.error(
        `[loombridge plan] promoted contract DEFAULTS (the GenreContract states none of these, and ` +
          `${rel(paths.gameSpec)} prints them as fact):`,
      );
      for (const line of promoted.defaults) console.error(`[loombridge plan]   ${line}`);
      console.error(
        `[loombridge plan]   Edit ${rel(paths.acceptance)} directly if any of them is wrong for this game.`,
      );
    }

    await writeSlicePlan(paths, promoted.slices);
    created.push(rel(paths.slices));

    await fs.writeFile(promotionReportPath, `${JSON.stringify(promoted.report, null, 2)}
`, "utf-8");
    created.push(rel(promotionReportPath));
  } else if (acceptanceOutcome === "created" && (await fileExists(promotionReportPath))) {
    // A project just RE-SEEDED from a pack template is no longer the promoted project the old report
    // describes: that report's acceptance and slices have been replaced. Leaving it would make the
    // disk contradict itself (STATE says this genre, the report says another), which the coverage
    // derivation refuses on. Clearing it is what keeps the legitimate "switch to a registered genre
    // with --force" path from landing on that refusal.
    await fs.rm(promotionReportPath);
    console.error(
      `[loombridge plan] removed stale ${rel(promotionReportPath)} — it described the previous promoted genre, not "${genre}".`,
    );
  }

  // 3. GAME_SPEC.md (auto-derived from the contract, #64) + design/README.md stub
  //    (never clobber without --force).
  for (const [p, content] of [
    [paths.gameSpec, renderGameSpec(contract as unknown as ContractView, genre, args.engine)] as const,
    [path.join(paths.design, "README.md"), DESIGN_README_STUB] as const,
  ]) {
    const outcome = await writeIfAbsent(p, content, args.force);
    (outcome === "created" ? created : kept).push(rel(p));
  }

  // 4. STATE.md — preserve phase/verdict on re-plan; only bootstrap when absent.
  //    Refresh the Design Target readiness from disk (§3c).
  const design = await designStatus(paths);
  let state: LoombridgeState = prev
    ? { ...prev, genre, engine: args.engine, designTarget: design.status, updatedAt: nowIso() }
    : {
        genre,
        engine: args.engine,
        phase: "planned",
        designTarget: design.status,
        lastVerdict: null,
        updatedAt: nowIso(),
      };
  await writeState(paths, state);

  console.error(`[loombridge plan] genre=${genre} engine=${args.engine} root=${args.root}`);
  if (created.length) console.error(`[loombridge plan] created: ${created.join(", ")}`);
  if (kept.length) console.error(`[loombridge plan] kept (unchanged): ${kept.join(", ")}`);

  // Design-doc hardening (RCL tranche-2) — ADVISORY only. When a GenreContract/brief was ingested,
  // print the design-doc coverage report + anti-drift/scale WARNs. These NEVER change the exit code;
  // they surface the checklist the dogfood pre-build review would have caught by hand.
  if (genreContractInput) {
    emitDesignHardeningAdvisory(genreContractInput as GenreContract);
  }

  // ── slice pipeline (S1b): state-driven dispatch over SLICES.json + design ────
  // Read the roadmap (null ⇒ no roadmap yet) and classify the dispatch mode via
  // the documented precedence in slices.ts — we do NOT reimplement it here.
  const gateOk = exitCodeForDesignReadiness(design) === 0;
  let plan = await readSlicePlan(paths);
  const mode = planDispatchMode({
    hasRoadmap: plan !== null,
    designApproved: gateOk,
    nextSlice: plan ? nextUnblockedSlice(plan) : null,
    awaitingApproval: plan ? awaitingApprovalSlices(plan).length > 0 : false,
  });

  // ALWAYS print the read-only status echo first — it subsumes the dropped
  // `status` verb. Running `plan` and answering No stays a free status check.
  renderPlanStatusEcho(await computeStatusModel({ paths, plan, state, design }));

  // Design Target Phase (§3c): plan is not complete without an approved hero shot.
  const stale = design.status === "approved" && !design.frozenMatches;
  console.error(`[loombridge plan] design target: ${design.status}${stale ? " (CHANGED since approval — re-approve)" : ""}`);

  let assetManifest = await assetManifestReadiness(paths);
  if (args.assetMode !== undefined) {
    if (!gateOk || !design.pngSha256) {
      console.error(
        "[loombridge plan] NOT ready — choose an asset strategy after the Design Target is approved + frozen. " +
          "Run `loombridge target set/approve`, then `loombridge plan --asset-mode <registry|generated|hybrid>`.",
      );
      return 1;
    }
    let outcome: "created" | "kept";
    try {
      outcome = await recordAssetStrategyDraft({
        paths,
        mode: args.assetMode,
        force: args.force,
        designPngSha256: design.pngSha256,
        genre,
      });
    } catch (error) {
      console.error(`[loombridge plan] NOT ready — ${error instanceof Error ? error.message : String(error)}`);
      return 2;
    }
    console.error(
      outcome === "created"
        ? `[loombridge plan] recorded asset strategy draft: ${args.assetMode} → ${rel(paths.assetManifest)}`
        : `[loombridge plan] kept existing asset manifest: ${rel(paths.assetManifest)} (use --force to replace the draft)`,
    );
    assetManifest = await assetManifestReadiness(paths);
  }

  const assetLabel = assetManifest.status === "missing"
    ? "missing"
    : assetManifest.mode
      ? `${assetManifest.status} (${assetManifest.mode})`
      : assetManifest.status;
  console.error(`[loombridge plan] asset manifest: ${assetLabel}`);
  if (assetManifest.status === "invalid" && assetManifest.reason) {
    console.error(`[loombridge plan] asset manifest validation failed: ${assetManifest.reason}`);
  }

  // ── mode: design ────────────────────────────────────────────────────────────
  // The outer design plan: establish/re-approve the Design Target, and — once it
  // is approved + frozen — scaffold the slice roadmap (the design→roadmap pivot).
  if (mode === "design") {
    // §3c default hard gate: `plan` is NOT complete without an approved + frozen
    // Design Target. The escape hatch is the explicit --allow-missing-design-target
    // flag, not the gate — so the common path (and the `/loombridge:plan` slash
    // command) needs no flag to "just work."
    if (!gateOk && !args.allowMissingDesignTarget) {
      const reason =
        design.status !== "approved"
          ? "no approved Design Target (annotated hero shot)"
          : "the approved Design Target has CHANGED since approval (frozen hash mismatch)";
      console.error(
        `[loombridge plan] NOT ready — ${reason}. ` +
          "Establish/re-approve via `loombridge target set/approve` (see commands/loombridge/plan.md §3c), then re-run. " +
          "(Use --allow-missing-design-target only for early scaffolding — `build` will still block.)",
      );
      return exitCodeForDesignReadiness(design);
    }
    if (!gateOk && args.allowMissingDesignTarget) {
      console.error(
        "[loombridge plan] WARNING: completing without an approved Design Target (--allow-missing-design-target). " +
          "Polish will be ungrounded; `build` will still block until the target is approved + frozen.",
      );
    }
    if (!gateOk) {
      console.error(
        "[loombridge plan] next: establish the Design Target (annotated hero shot) in .loombridge/design/ via `loombridge target`, then re-run `loombridge plan`.",
      );
      return 0;
    }

    if (!assetManifest.approved) {
      renderAssetModeHelp();
      if (assetManifest.status === "missing") {
        console.error(
          "[loombridge plan] NOT ready — no approved ASSET_MANIFEST.json. " +
            "Record the user's choice with `loombridge plan --asset-mode hybrid` (or registry/generated), " +
            "fill the required roles/assets, approve the manifest, then re-run.",
        );
      } else if (assetManifest.status === "draft") {
        console.error(
          `[loombridge plan] NOT ready — ASSET_MANIFEST.json is draft (${assetManifest.mode}). ` +
            "Fill required assets/slice bindings and set status approved before scaffolding slices.",
        );
      } else {
        console.error(
          "[loombridge plan] NOT ready — ASSET_MANIFEST.json is invalid. Fix validation errors before scaffolding slices.",
        );
      }
      return 1;
    }

    // Design approved + frozen, but no roadmap yet (mode === "design" with
    // hasRoadmap false): this is the design→roadmap transition. Scaffold the
    // deterministic slice DAG from the genre template. The human approval seam
    // has already happened at Design Target approval; do not require developers
    // to remember a second `--go` just to create SLICES.json.
    // A PROMOTED project's SLICES.json is written at promotion time from its contract, so reaching
    // here means that file was deleted. Falling back to the generic DAG would silently replace the
    // contract's real, gap-annotated slices with a four-slice scaffold — a downgrade wearing the
    // costume of a recovery. Refuse and point at the re-promotion instead.
    //
    // A FREE-FORM project (no promotion report) has no such contract to lose, so the generic DAG IS
    // its roadmap and scaffolding it here is correct.
    if (!genrePack && (await fileExists(paths.genrePromotion))) {
      console.error(
        `[loombridge plan] NOT ready — "${genre}" was planned from a genre contract and ` +
          `${rel(paths.slices)} is missing. Re-run with --genre-contract <file> --force to regenerate ` +
          "the roadmap from that contract; scaffolding the generic template here would silently drop " +
          "the contract's slices and its declared gaps.",
      );
      return 2;
    }
    const template = await loadSliceTemplate(genre);
    const instantiated = instantiateSlicePlan(template);
    await writeSlicePlan(paths, instantiated);
    plan = instantiated;
    console.error(
      `[loombridge plan] scaffolded roadmap: ${instantiated.slices.length} slices → ${rel(paths.slices)}`,
    );
    renderPlanStatusEcho(await computeStatusModel({ paths, plan, state, design }));
    const next = nextUnblockedSlice(plan);
    if (next) {
      console.error(
        `[loombridge plan] Plan next slice: ${next.id} — ${next.title}`,
      );
      console.error(`[loombridge plan]   skill: ${renderSliceSkill(next.skill, readInstalledSkills(args.root))}`);
      console.error(`[loombridge plan]   feel: ${next.feelIntent}`);
      console.error(`[loombridge plan]   gates: ${next.acceptance.gates.join(", ")}`);
      console.error(
        "[loombridge plan] next: review the slice above, then run `loombridge build` to build it.",
      );
    } else {
      console.error("[loombridge plan] next: all slices approved.");
    }
    return 0;
  }

  // ── mode: await-approval ────────────────────────────────────────────────────
  // A prior slice is built/verified but not yet approved — the human approval
  // seam is due before advancing.
  if (mode === "await-approval") {
    const awaiting = awaitingApprovalSlices(plan!);
    const names = awaiting.map((s) => s.id).join(", ");
    if (!args.go) {
      console.error(`[loombridge plan] Approving ${names} (verified ✓) and advancing — ok?`);
      console.error(
        "[loombridge plan] Approval is the plan↔build human seam. In an agent session, approve this prompt; the agent will run the internal approval action. No change made now.",
      );
      console.error(`[loombridge plan] Next: say "approve ${awaiting[0]?.id ?? names}" or run /loombridge:plan to approve and advance.`);
      return 0;
    }

    const approvedAt = nowIso();
    const approvals = new Map<string, { approvalNote?: string; signoffArtifact?: string; signoffSha256?: string }>();
    let refused = false;
    for (const slice of awaiting) {
      if (slice.state === "built") {
        refused = true;
        console.error(`[loombridge plan] ${slice.id}: NOT approved — verify it first (\`loombridge verify --slice ${slice.id}\`).`);
        continue;
      }
      if (!slice.proof?.checkpointId) {
        refused = true;
        console.error(`[loombridge plan] ${slice.id}: NOT approved — proof.checkpointId is missing; re-run \`loombridge verify --slice ${slice.id}\`.`);
        continue;
      }
      const done = await isSliceDone(slice, paths);
      if (!done.ok) {
        refused = true;
        console.error(`[loombridge plan] ${slice.id}: NOT approved — doneness refused:`);
        for (const reason of done.reasons) console.error(`  - ${reason}`);
        continue;
      }
      let signoff: { artifact: string; sha256: string } | undefined;
      if (args.signoffPath) {
        try {
          signoff = await copySignoffArtifact({ root: args.root, sliceId: slice.id, signoffPath: args.signoffPath });
        } catch (error) {
          refused = true;
          const message = error instanceof Error ? error.message : String(error);
          console.error(`[loombridge plan] ${slice.id}: NOT approved — ${message}`);
          continue;
        }
      }
      approvals.set(slice.id, {
        ...(args.note !== undefined ? { approvalNote: args.note } : {}),
        ...(signoff ? { signoffArtifact: signoff.artifact, signoffSha256: signoff.sha256 } : {}),
      });
    }

    if (approvals.size > 0) {
      const nextPlan: SlicePlan = {
        ...plan!,
        slices: plan!.slices.map((slice) =>
          approvals.has(slice.id)
            ? {
                ...slice,
                state: "approved" as const,
                proof: { ...slice.proof, approvedAt, ...approvals.get(slice.id) },
              }
            : slice,
        ),
      };
      await writeSlicePlan(paths, nextPlan);
      plan = nextPlan;
      console.error(`[loombridge plan] approved: ${[...approvals.keys()].join(", ")}`);
      const next = nextUnblockedSlice(plan);
      if (next) {
        renderPlanStatusEcho(await computeStatusModel({ paths, plan, state, design }));
        console.error(`[loombridge plan] next: ${next.id} — ${next.title}`);
        console.error("[loombridge plan] Next: run /loombridge:build or say continue.");
      } else {
        state = await updateState(paths, { currentBuild: null });
        renderPlanStatusEcho(await computeStatusModel({ paths, plan, state, design }));
        console.error(`[loombridge plan] next: all approved.`);
        console.error("[loombridge plan] Next: all slices are approved; ask the agent to certify done.");
      }
    }
    if (refused) return 1;
    return 0;
  }

  // ── mode: plan-slice ────────────────────────────────────────────────────────
  // Announce the next unblocked slice read-only; the dev reviews it, then runs
  // `loombridge build`. NO mutation in S1b — `--go` has no extra effect here yet.
  if (mode === "plan-slice") {
    if (!assetManifest.approved) {
      renderAssetModeHelp();
      console.error(
        "[loombridge plan] NOT ready — slice planning requires an approved ASSET_MANIFEST.json. " +
          "Slices must consume manifest-bound asset ids, not search the registry silently.",
      );
      return 1;
    }
    const next = nextUnblockedSlice(plan!)!;
    console.error(`[loombridge plan] Plan next slice: ${next.id} — ${next.title}`);
    console.error(`[loombridge plan]   skill: ${renderSliceSkill(next.skill, readInstalledSkills(args.root))}`);
    console.error(`[loombridge plan]   feel: ${next.feelIntent}`);
    console.error(`[loombridge plan]   gates: ${next.acceptance.gates.join(", ")}`);
    console.error(`[loombridge plan] next: review the slice above, then run \`loombridge build\` to build it.`);
    if (args.go) {
      console.error(
        "[loombridge plan] (--go has no effect on a slice plan yet — `plan` makes no slice mutation in S1b; " +
          "the state flip lands in S2.)",
      );
    }
    return 0;
  }

  // ── mode: all-approved ──────────────────────────────────────────────────────
  if (state.currentBuild) {
    state = await updateState(paths, { currentBuild: null });
  }
  console.error(
    `[loombridge plan] All ${plan!.slices.length} slices approved — this game's roadmap is complete.`,
  );
  console.error(
    "[loombridge plan] next: add a new slice to the roadmap (or a new genre pack) to extend the game. " +
      "Run `loombridge doneness` to certify the composed build.",
  );
  return 0;
}

/**
 * Parse result before engine RESOLUTION. `engine` is left `undefined` when
 * `--engine` is omitted so `run` can auto-detect (the deterministic CLI track).
 * `runPlan` always receives a fully-resolved `engine` — the resolution happens
 * at this CLI layer, keeping `runPlan` + its tests unchanged.
 */
type ParsedArgs = Omit<PlanArgs, "engine"> & { engine?: string };

/**
 * A `--help`/parse outcome. `usageError` exits 2; a bare `help` exits 0.
 *
 * Same discriminator `update`/`verify`/`status` already carry, for the same reason: a malformed
 * invocation that reports SUCCESS is a refusal that does not look like one, and a CI step or an
 * agent branching on `$?` reads it as a pass.
 */
type ParseHelp = { help: true; usageError?: boolean };

function parseArgs(args: string[]): ParsedArgs | ParseHelp {
  // The registry default is the SEED value only. The genre literal lives in the registry (the one
  // genre-wiring point), not here, so this core stays genre-neutral. With more than one pack
  // registered this value is never reached: `run` refuses first (see `unstatedGenreRefusal`), and
  // `runPlan` prefers a promoted contract's genre and then the genre already in STATE. It remains
  // the correct answer in exactly the case it was written for: a single registered pack.
  let genre = defaultGenreId();
  let genreExplicit = false;
  let engine: string | undefined;
  let name: string | undefined;
  let root = process.cwd();
  let force = false;
  let allowMissingDesignTarget = false;
  let go = false;
  let note: string | undefined;
  let signoffPath: string | undefined;
  let assetMode: AssetManifestMode | undefined;
  let genreContractPath: string | undefined;
  let briefPath: string | undefined;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--genre") { genre = args[(i += 1)] ?? genre; genreExplicit = true; }
    else if (arg === "--engine") engine = args[(i += 1)] ?? engine;
    else if (arg === "--name") name = args[(i += 1)] ?? name;
    else if (arg === "--genre-contract") genreContractPath = path.resolve(args[(i += 1)] ?? "");
    else if (arg === "--brief") briefPath = path.resolve(args[(i += 1)] ?? "");
    else if (arg === "--root") root = path.resolve(args[(i += 1)] ?? root);
    else if (arg === "--force") force = true;
    else if (arg === "--allow-missing-design-target") allowMissingDesignTarget = true;
    else if (arg === "--go") go = true;
    else if (arg === "--note") note = args[(i += 1)] ?? "";
    else if (arg === "--signoff") signoffPath = path.resolve(args[(i += 1)] ?? "");
    else if (arg === "--asset-mode") {
      const value = args[(i += 1)];
      if (!value || !ASSET_MANIFEST_MODES.has(value as AssetManifestMode)) {
        console.error("[loombridge plan] --asset-mode must be registry, generated, or hybrid.");
        return { help: true, usageError: true };
      }
      assetMode = value as AssetManifestMode;
    }
    else if (arg === "--help" || arg === "-h") return { help: true };
    else {
      console.error(`[loombridge plan] unknown argument "${arg}".`);
      return { help: true, usageError: true };
    }
  }
  return { root, genre, genreExplicit, engine, name, genreContractPath, briefPath, force, allowMissingDesignTarget, go, note, signoffPath, assetMode };
}

/**
 * Resolve the engine at the CLI layer (deterministic track): an explicit
 * `--engine` wins over detection, but it is still validated against supported
 * engines. Detection either resolves to Unity, or produces a usage error
 * (exit 2) — the CLI NEVER prompts (asking is the agent layer's job). Returns
 * the resolved engine, or a numeric exit code on error.
 */
function resolveEngine(parsed: ParsedArgs): { engine: string } | { exitCode: number } {
  if (parsed.engine !== undefined) {
    if (parsed.engine !== "unity") {
      console.error(
        `[loombridge plan] --engine ${parsed.engine} is not supported; Loombridge currently supports Unity only`,
      );
      return { exitCode: 2 };
    }
    return { engine: parsed.engine };
  }

  const detected = detectEngine(parsed.root);
  if (detected.engine === null) {
    console.error(`[loombridge plan] ${detected.reason}`);
    return { exitCode: 2 };
  }
  if (detected.engine !== "unity") {
    console.error(
      `[loombridge plan] detected ${detected.engine}, but Loombridge currently supports Unity only`,
    );
    return { exitCode: 2 };
  }
  console.error(`[loombridge plan] detected engine: ${detected.engine}`);
  return { engine: detected.engine };
}

function printUsage(): void {
  console.log(
    [
      "Usage: loombridge plan [options]",
      "",
      "State-driven: dispatches by `.loombridge/` state — establish the Design",
      "Target, scaffold the slice roadmap, announce the next slice, or approve",
      "a verified slice with `--go`.",
      "",
      "Options:",
      `  --genre <id>    Genre pack: one of ${knownGenreIds().join(", ")}. REQUIRED on a first`,
      "                  `plan` while more than one pack is registered; `plan` refuses",
      "                  rather than guess. A re-plan needs no flag (the genre in",
      "                  STATE.md wins), and --genre-contract / --brief supply it too.",
      "                  These are the genres with a shipped pack template; a build",
      "                  planned from one verifies as `graded`. For any OTHER genre, run",
      "                  `loombridge genre init --genre <your-id> --class <twitch|systems",
      "                  |hybrid>` to write a contract, then --brief / --genre-contract:",
      "                  it plans and builds, and verifies as `partially-graded` with",
      "                  its ungraded gaps enumerated on the verdict.",
      "  --engine <id>   Target engine. Auto-detected from --root when omitted",
      "                  (Unity via ProjectSettings/ProjectVersion.txt); a non-Unity",
      "                  project or none detected is an error (run from a project root).",
      "  --name <name>   Game name (default: project folder name)",
      "  --genre-contract <path>",
      "                  Promote a validated GenreContract JSON into",
      "                  .loombridge/ACCEPTANCE.json, SLICES.json, and",
      "                  GENRE_PROMOTION.json instead of seeding a pack template.",
      "                  Works for an UNREGISTERED genre: the contract supplies both",
      "                  acceptance and slices, so no pack is needed.",
      "  --brief <path>  Use an existing design-doc bundle (a docs directory or a",
      "                  brief .json) as the brief source instead of the interview.",
      "                  Resolves to the interview-equivalent GenreContract and",
      "                  promotes it exactly like --genre-contract.",
      "  --root <dir>    Project root (default: cwd)",
      "  --force         Overwrite existing seeded files. REQUIRED to change the genre of an",
      "                  already-planned project: without it a --genre that disagrees with the",
      "                  contract on disk refuses, rather than record the new genre in STATE.md",
      "                  beside the old genre's contract.",
      "  --asset-mode <registry|generated|hybrid>",
      "                  Record the developer-approved asset strategy as a draft",
      "                  .loombridge/ASSET_MANIFEST.json. Roadmap scaffolding still",
      "                  requires that manifest to be filled and approved.",
      "  --go            Approve a verified+done slice and advance. Roadmap scaffold",
      "                  happens automatically once the Design Target is approved.",
      "  --note <text>   Optional operator note recorded when `--go` approves a slice",
      "  --signoff <path>",
      "                  Optional operator sign-off frame copied into",
      "                  .loombridge/anchors/signoffs/<id>/ and hashed at approval",
      "  --allow-missing-design-target",
      "                  Escape hatch: complete plan without an approved Design Target.",
      "                  (Default: gate is ON — plan exits non-zero until a hero shot is",
      "                  approved + frozen. The slash command relies on the default.)",
      "  -h, --help      Show this help",
    ].join("\n"),
  );
}

/** CLI entry: parse the post-subcommand args and run. */
export async function run(args: string[]): Promise<number> {
  const parsed = parseArgs(args);
  if ("help" in parsed) {
    printUsage();
    return parsed.usageError ? 2 : 0;
  }
  // Resolve the engine (explicit override, else auto-detect) BEFORE building the
  // PlanArgs `runPlan` consumes — keeping `runPlan` engine-resolved + unchanged.
  const resolved = resolveEngine(parsed);
  if ("exitCode" in resolved) return resolved.exitCode;
  // Refuse an UNSTATED genre before anything is scaffolded or written: a refusal that has already
  // left a half-scaffolded `.loombridge/` behind is not a refusal. Exit 2, because a missing
  // required argument is a usage/precondition error, not a failed check.
  //
  // AFTER engine resolution on purpose. Both are exit-2 preconditions, but "you are not in a game
  // project" is the more actionable answer when both are true: asking someone to name the genre of
  // a directory that is not a project sends them to fix the wrong thing.
  const refusal = unstatedGenreRefusal({
    genreExplicit: parsed.genreExplicit === true,
    hasContractSource: Boolean(parsed.genreContractPath ?? parsed.briefPath),
    stateGenre: genreFromState(await readState(loombridgePaths(parsed.root))),
  });
  if (refusal) {
    console.error(refusal);
    return 2;
  }
  return runPlan({ ...parsed, engine: resolved.engine });
}
