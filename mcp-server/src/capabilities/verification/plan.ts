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
  instantiateSlicePlan,
  nextUnblockedSlice,
  planDispatchMode,
  readSlicePlan,
  writeSlicePlan,
  type SlicePlan,
} from "./slices.js";
import { computeStatusModel, renderPlanStatusEcho } from "./status-model.js";
import { defaultGenreId, knownGenreIds, resolveGenrePack } from "../genre/genre-registry.js";
import { promoteGenreContract, type GenrePromotionResult } from "../genre/genre-contract/promote.js";
import { resolveBriefBundle } from "../../domain/brief-bundle.js";
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

/** Read + validate a genre's slice-DAG roadmap template from the src tree. */
async function loadSliceTemplate(genre: string): Promise<SlicePlan> {
  const pack = resolveGenrePack(genre);
  if (!pack) {
    throw new Error(
      `no slice roadmap template for genre "${genre}". Known: ${knownGenreIds().join(", ")}`,
    );
  }
  const raw = await fs.readFile(pack.sliceTemplatePath, "utf-8");
  return assertValidSlicePlan(JSON.parse(raw));
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
  /** Optional operator sign-off image/frame copied into .loombridge/reports/slices/<id>/. */
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
  const dest = path.join(args.root, ".loombridge", "reports", "slices", args.sliceId, `signoff${ext}`);
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
  let promoted: GenrePromotionResult | null = null;
  if (genreContractPath) {
    try {
      genreContractInput = JSON.parse(await fs.readFile(genreContractPath, "utf-8"));
      promoted = promoteGenreContract(genreContractInput);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[loombridge plan] invalid --genre-contract: ${message}`);
      return 2;
    }
  }

  // Genre resolution precedence: an explicit --genre-contract (its sourceGenreId) wins; then an explicit
  // --genre; then the genre already recorded in STATE *if it is a registered genre* — so a bare re-plan does
  // NOT silently reset a promoted 3d-shooter back to the registry default, BUT the placeholder genre that
  // `design set` bootstraps into STATE before any genre is chosen (e.g. "unknown") never sticks; then the
  // registry default carried in args.genre.
  const preservedGenre =
    !args.genreExplicit && prev?.genre && resolveGenrePack(prev.genre) ? prev.genre : undefined;
  const genre = promoted?.report.sourceGenreId ?? preservedGenre ?? args.genre;
  const genrePack = resolveGenrePack(genre);
  if (!genrePack) {
    console.error(
      `[loombridge plan] unknown genre "${genre}". Known: ${knownGenreIds().join(", ")}`,
    );
    return 2;
  }
  const templatePath = genrePack.acceptanceTemplatePath;
  if (genreContractInput) {
    promoted = promoteGenreContract(genreContractInput, { sliceTemplate: await loadSliceTemplate(genre) });
  }

  await ensureScaffold(paths);
  const promotionReportPath = path.join(paths.dir, "GENRE_PROMOTION.json");
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

  const created: string[] = [];
  const kept: string[] = [];
  const rel = (p: string) => path.relative(args.root, p);

  // 1. ACCEPTANCE.json — seed from the genre template (validated before write).
  //    Keep the contract object around so GAME_SPEC.md can be derived from it
  //    whether we just seeded it or it already existed.
  let acceptanceOutcome: WriteOutcome;
  let contract: AcceptanceContract;
  if (args.force || !(await fileExists(paths.acceptance))) {
    const template = promoted?.acceptance ?? JSON.parse(await fs.readFile(templatePath, "utf-8")) as AcceptanceContract;
    const seededGameName = args.name ?? (path.basename(args.root) || template.game);
    contract = { ...template, game: seededGameName };
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
    await writeSlicePlan(paths, promoted.slices);
    created.push(rel(paths.slices));

    await fs.writeFile(promotionReportPath, `${JSON.stringify(promoted.report, null, 2)}
`, "utf-8");
    created.push(rel(promotionReportPath));
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
          "Run `loombridge design set/approve`, then `loombridge plan --asset-mode <registry|generated|hybrid>`.",
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
          "Establish/re-approve via `loombridge design set/approve` (see commands/loombridge/plan.md §3c), then re-run. " +
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
        "[loombridge plan] next: establish the Design Target (annotated hero shot) in .loombridge/design/ via `loombridge design`, then re-run `loombridge plan`.",
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
      console.error(`[loombridge plan]   skill: ${next.skill}`);
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
    console.error(`[loombridge plan]   skill: ${next.skill}`);
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

function parseArgs(args: string[]): ParsedArgs | { help: true } {
  // Back-compat default: an omitted --genre plans the registry's default genre. The genre literal
  // lives in the registry (the one genre-wiring point), not here — this core stays genre-neutral.
  // Now that a second genre is registered, omitting --genre silently picks the default; callers
  // building another genre must pass --genre explicitly. (Requiring an explicit genre when >1 is
  // registered is a deliberate future behavior change, not made here to keep the happy path unchanged.)
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
        return { help: true };
      }
      assetMode = value as AssetManifestMode;
    }
    else if (arg === "--help" || arg === "-h") return { help: true };
    else {
      console.error(`[loombridge plan] unknown argument "${arg}".`);
      return { help: true };
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
      `  --genre <id>    Genre pack — one of: ${knownGenreIds().join(", ")}. Defaults to ${defaultGenreId()} when omitted.`,
      "  --engine <id>   Target engine. Auto-detected from --root when omitted",
      "                  (Unity via ProjectSettings/ProjectVersion.txt); a non-Unity",
      "                  project or none detected is an error (run from a project root).",
      "  --name <name>   Game name (default: project folder name)",
      "  --genre-contract <path>",
      "                  Promote a validated GenreContract JSON into",
      "                  .loombridge/ACCEPTANCE.json, SLICES.json, and",
      "                  GENRE_PROMOTION.json instead of seeding a pack template.",
      "  --brief <path>  Use an existing design-doc bundle (a docs directory or a",
      "                  brief .json) as the brief source instead of the interview.",
      "                  Resolves to the interview-equivalent GenreContract and",
      "                  promotes it exactly like --genre-contract.",
      "  --root <dir>    Project root (default: cwd)",
      "  --force         Overwrite existing seeded files",
      "  --asset-mode <registry|generated|hybrid>",
      "                  Record the developer-approved asset strategy as a draft",
      "                  .loombridge/ASSET_MANIFEST.json. Roadmap scaffolding still",
      "                  requires that manifest to be filled and approved.",
      "  --go            Approve a verified+done slice and advance. Roadmap scaffold",
      "                  happens automatically once the Design Target is approved.",
      "  --note <text>   Optional operator note recorded when `--go` approves a slice",
      "  --signoff <path>",
      "                  Optional operator sign-off frame copied into",
      "                  .loombridge/reports/slices/<id>/ and hashed at approval",
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
    return 0;
  }
  // Resolve the engine (explicit override, else auto-detect) BEFORE building the
  // PlanArgs `runPlan` consumes — keeping `runPlan` engine-resolved + unchanged.
  const resolved = resolveEngine(parsed);
  if ("exitCode" in resolved) return resolved.exitCode;
  return runPlan({ ...parsed, engine: resolved.engine });
}
