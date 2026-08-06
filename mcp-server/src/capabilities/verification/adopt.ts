/**
 * `loombridge adopt` — the build-then-verify on-ramp (RCL-P02).
 *
 * The verification core has no front door for a build that started RAW: a project
 * constructed outside the flow (the dogfood case — built straight through the
 * bridge, never `plan`ned) cannot retrofit an acceptance contract, so it can never
 * be verified. `adopt` is that retrofit: it ingests the signals an existing build
 * already carries — design docs and an existing scene/build — and EMITS a PROPOSED
 * acceptance contract for human review.
 *
 * HONESTY DISCIPLINE — `adopt` PROPOSES, it never VERIFIES. It is structurally
 * incapable of being a false-green vector:
 *   - it writes a contract clearly marked as a PROPOSAL (`source.note`) plus an
 *     `ADOPTION.json` report whose `status` is `proposed-unverified`,
 *   - it sets `phase: planned` and writes NO `currentBuild` and NO verdict, so a
 *     later `loombridge verify` / `loombridge doneness` still REFUSES (Epic-0 refuse
 *     semantics) until the project is properly planned, built, and verified,
 *   - it never mints a run, never approves a slice, never freezes a Design Target.
 *
 * Like `plan`, it only scaffolds slots for review — it just seeds them from
 * existing artifacts instead of an interview. The richer seed: if the design-doc
 * bundle carries the interview-equivalent structured brief (a GenreContract), it
 * is promoted (reusing the same path as `plan --brief`); otherwise the proposal
 * falls back to the genre's pack template.
 */

import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";

import { assertValidAcceptanceContract, validateAcceptanceContract } from "./validator.js";
import type { AcceptanceContract } from "./types.js";
import {
  ensureScaffold,
  fileExists,
  loombridgePaths,
  nowIso,
  writeState,
  type LoombridgeState,
} from "../../domain/state.js";
import { designStatus } from "./design.js";
import { detectEngine, renderGameSpec } from "./plan.js";
import { knownGenreIds, resolveGenrePack } from "../genre/genre-registry.js";
import { resolveBriefBundle } from "../../domain/brief-bundle.js";
import { promoteGenreContract } from "../genre/genre-contract/promote.js";
import { formatDesignHardeningAdvisory } from "../genre/genre-contract/design-hardening.js";
import type { GenreContract } from "../genre/genre-contract/types.js";

export const ADOPTION_REPORT_SCHEMA_VERSION = "0.1.0" as const;

/** A signal `adopt` ingested from the existing build. */
export interface AdoptSignal {
  kind: "design-docs" | "scene" | "structured-brief" | "engine";
  /** Root-relative (or absolute, for an out-of-tree input) path of the signal. */
  path?: string;
  present: boolean;
  /** Human detail (e.g. the doc filenames found, or the matched brief). */
  detail?: string;
}

/**
 * The proposal record `adopt` writes alongside the proposed contract. It exists to
 * make the proposed/unverified status MACHINE-checkable (and impossible to mistake
 * for a verdict): `status` is always `proposed-unverified` and `verified` is always
 * false.
 */
export interface AdoptionReport {
  schemaVersion: typeof ADOPTION_REPORT_SCHEMA_VERSION;
  /** Invariant: always `proposed-unverified`. `adopt` cannot emit anything else. */
  status: "proposed-unverified";
  /** Invariant: always false. A proposal is not a verification. */
  verified: false;
  generatedBy: "loombridge adopt";
  generatedAt: string;
  genre: string;
  engine: string;
  /** Where the proposed contract came from. */
  seededFrom: "structured-brief" | "genre-template";
  /** The signals ingested from the existing build. */
  signals: AdoptSignal[];
  /** Root-relative path of the proposed contract. */
  proposedAcceptance: string;
  disclaimer: string;
  nextSteps: string[];
}

export interface AdoptArgs {
  /** Project root (the dir that will contain `.loombridge/`). */
  root: string;
  genre: string;
  engine: string;
  /** Optional game name; overrides the folder-derived name. */
  name?: string;
  /** Optional design-doc bundle (a docs directory or a brief .json) to ingest. */
  docsPath?: string;
  /** Optional existing scene/build file to record as evidence of an existing build. */
  scenePath?: string;
  /** Overwrite an existing proposed contract instead of refusing. */
  force: boolean;
}

const DISCLAIMER =
  "This acceptance contract is a PROPOSAL inferred from existing artifacts by `loombridge adopt`. " +
  "It is UNVERIFIED — a starting point for human review, not a verdict. `adopt` never produces a " +
  "green/approved state: there is no build run, no verdict, and `loombridge verify` / `loombridge doneness` " +
  "will REFUSE until the project is properly planned, built, and verified.";

function rel(root: string, p: string): string {
  return path.relative(root, p);
}

/**
 * Resolve the proposed contract from the available signals. If the design-doc
 * bundle carries the interview-equivalent structured brief, promote it (richer,
 * reflects the doc's authored dials); otherwise seed from the genre pack template.
 * Returns the contract + provenance, or an `{ error }` (never throws) for a
 * malformed brief — the caller turns that into an exit-2 with nothing written.
 */
function proposeContract(args: {
  root: string;
  genre: string;
  name?: string;
  docsPath?: string;
}):
  | { contract: AcceptanceContract; genre: string; seededFrom: AdoptionReport["seededFrom"]; briefDetail?: string; genreContract?: GenreContract }
  | { error: string } {
  const gameName = args.name ?? (path.basename(args.root) || undefined);

  // Try the structured brief first when a docs bundle is supplied. A docs path
  // that simply has no structured brief is NOT an error here (it is still a valid
  // signal source for the template seed); only a malformed/ambiguous brief is.
  if (args.docsPath) {
    const resolved = resolveBriefBundle(args.docsPath);
    if (!("error" in resolved)) {
      let raw: unknown;
      try {
        raw = JSON.parse(fsSync.readFileSync(resolved.genreContractPath, "utf-8"));
      } catch (error) {
        return { error: `structured brief is not valid JSON (${rel(args.root, resolved.genreContractPath)}): ${error instanceof Error ? error.message : String(error)}` };
      }
      let promoted;
      try {
        promoted = promoteGenreContract(raw);
      } catch (error) {
        return { error: `structured brief is not a valid GenreContract: ${error instanceof Error ? error.message : String(error)}` };
      }
      const contract: AcceptanceContract = {
        ...promoted.acceptance,
        ...(gameName ? { game: gameName } : {}),
        source: {
          ...(promoted.acceptance.source ?? {}),
          note: `PROPOSED by \`loombridge adopt\` from the design-doc bundle ${rel(args.root, args.docsPath)} — UNVERIFIED, needs human review.`,
        },
      };
      return {
        contract,
        genre: promoted.report.sourceGenreId,
        seededFrom: "structured-brief",
        briefDetail: resolved.matchedFile ?? path.basename(resolved.genreContractPath),
        genreContract: raw as GenreContract, // validated by promoteGenreContract above; used for the advisory
      };
    }
    // If the docs path explicitly POINTED at a brief file (not a directory) but it
    // could not be resolved, that is a malformed brief → refuse. A directory with
    // no brief falls through to the template seed below.
    if (fsSync.existsSync(args.docsPath) && fsSync.statSync(args.docsPath).isFile()) {
      return { error: resolved.error };
    }
  }

  const pack = resolveGenrePack(args.genre);
  if (!pack) {
    return { error: `unknown genre "${args.genre}". Known: ${knownGenreIds().join(", ")}` };
  }
  let template: AcceptanceContract;
  try {
    template = JSON.parse(fsSync.readFileSync(pack.acceptanceTemplatePath, "utf-8")) as AcceptanceContract;
  } catch (error) {
    return { error: `could not read the ${args.genre} acceptance template: ${error instanceof Error ? error.message : String(error)}` };
  }
  const contract: AcceptanceContract = {
    ...template,
    game: gameName ?? template.game,
    source: {
      ...(template.source ?? {}),
      note:
        `PROPOSED by \`loombridge adopt\` from the ${args.genre} pack template` +
        (args.docsPath ? ` (design-doc bundle ${rel(args.root, args.docsPath)} present but carried no structured brief)` : "") +
        " — UNVERIFIED, needs human review.",
    },
  };
  return { contract, genre: args.genre, seededFrom: "genre-template" };
}

/** Gather the ingestable signals (for the proposal report + the refuse-when-empty rule). */
function gatherSignals(args: AdoptArgs): AdoptSignal[] {
  const signals: AdoptSignal[] = [{ kind: "engine", present: true, detail: args.engine }];

  if (args.docsPath) {
    const exists = fsSync.existsSync(args.docsPath);
    let detail: string | undefined;
    if (exists && fsSync.statSync(args.docsPath).isDirectory()) {
      const files = fsSync.readdirSync(args.docsPath).filter((f) => /\.(md|txt|json|pdf)$/i.test(f)).sort();
      detail = files.length ? files.join(", ") : "(no readable design docs)";
    } else if (exists) {
      detail = path.basename(args.docsPath);
    }
    signals.push({ kind: "design-docs", path: args.docsPath, present: exists, detail });
  }

  if (args.scenePath) {
    signals.push({ kind: "scene", path: args.scenePath, present: fsSync.existsSync(args.scenePath) });
  }

  return signals;
}

/**
 * Run `adopt` programmatically. Returns a process exit code (0 proposal emitted,
 * 1 refused, 2 usage error). Exported for tests.
 */
export async function runAdopt(args: AdoptArgs): Promise<number> {
  const paths = loombridgePaths(args.root);

  // Refuse to silently clobber an existing contract (a human may have edited it,
  // or the project went through the real flow). --force is the explicit override.
  if (!args.force && (await fileExists(paths.acceptance))) {
    console.error(
      `[loombridge adopt] NOT ready — ${rel(args.root, paths.acceptance)} already exists. ` +
        "`adopt` proposes a contract for a project that started raw; re-run with --force to replace it.",
    );
    return 1;
  }

  // A docs path / scene path that was named but does not exist is a clear input
  // error — refuse with nothing written (no partial fabricated contract).
  for (const [flag, p] of [["--docs", args.docsPath], ["--scene", args.scenePath]] as const) {
    if (p && !fsSync.existsSync(p)) {
      console.error(`[loombridge adopt] ${flag} path not found: ${p}`);
      return 2;
    }
  }

  const proposal = proposeContract({ root: args.root, genre: args.genre, name: args.name, docsPath: args.docsPath });
  if ("error" in proposal) {
    console.error(`[loombridge adopt] ${proposal.error}`);
    return 2;
  }

  // The proposed contract MUST validate against the schema before anything is
  // written — a proposal that cannot be checked is worthless (and would mislead).
  const validation = validateAcceptanceContract(proposal.contract);
  if (!validation.valid) {
    console.error("[loombridge adopt] could not propose a valid contract from the available signals:");
    for (const issue of validation.issues) console.error(`  - ${issue.path}: ${issue.message}`);
    return 2;
  }
  assertValidAcceptanceContract(proposal.contract); // belt-and-suspenders before write

  const signals = gatherSignals(args);
  if (proposal.briefDetail) {
    signals.push({ kind: "structured-brief", path: args.docsPath, present: true, detail: proposal.briefDetail });
  }

  await ensureScaffold(paths);

  // 1. ACCEPTANCE.json — the PROPOSED contract (validated above).
  await fs.writeFile(paths.acceptance, `${JSON.stringify(proposal.contract, null, 2)}\n`, "utf-8");

  // 2. FEEL_SPEC.json — mirror of the contract's feel section (same as `plan`).
  const feel = (proposal.contract as unknown as { feel?: unknown }).feel ?? {};
  const feelSpec = {
    genre: proposal.genre,
    source: "derived from ACCEPTANCE.json `feel` by `loombridge adopt` (PROPOSAL — unverified)",
    metrics: feel,
  };
  await fs.writeFile(paths.feelSpec, `${JSON.stringify(feelSpec, null, 2)}\n`, "utf-8");

  // 3. GAME_SPEC.md — human-readable mirror (same renderer as `plan`).
  await fs.writeFile(
    paths.gameSpec,
    renderGameSpec(proposal.contract as unknown as Parameters<typeof renderGameSpec>[0], proposal.genre, args.engine),
    "utf-8",
  );

  // 4. ADOPTION.json — the machine-checkable proposal record (status, signals,
  //    disclaimer, next steps). This is what makes "proposed-not-verified" legible.
  const report: AdoptionReport = {
    schemaVersion: ADOPTION_REPORT_SCHEMA_VERSION,
    status: "proposed-unverified",
    verified: false,
    generatedBy: "loombridge adopt",
    generatedAt: nowIso(),
    genre: proposal.genre,
    engine: args.engine,
    seededFrom: proposal.seededFrom,
    signals,
    proposedAcceptance: rel(args.root, paths.acceptance),
    disclaimer: DISCLAIMER,
    nextSteps: [
      "Review and edit .loombridge/ACCEPTANCE.json — it is an inferred PROPOSAL, not ground truth.",
      "Establish + approve the Design Target (annotated hero shot) via `loombridge target set/approve`.",
      "Run `loombridge plan` to scaffold the slice roadmap from the reviewed contract.",
      "Build, then `loombridge verify`, then `loombridge doneness` — these still refuse until verified-green.",
    ],
  };
  const reportPath = path.join(paths.dir, "ADOPTION.json");
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf-8");

  // 5. STATE.md — `planned` ONLY. No currentBuild, no verdict: doneness/verify
  //    must still refuse. Preserve nothing from a prior verified run; a re-adopt
  //    is an explicit --force reset back to an unverified planned proposal.
  const design = await designStatus(paths);
  const state: LoombridgeState = {
    genre: proposal.genre,
    engine: args.engine,
    phase: "planned",
    designTarget: design.status,
    currentBuild: null,
    // Reset to UNVERIFIED (P2): a forced re-adopt must NOT carry a prior run's verdict. Doneness
    // already refuses on phase:planned + currentBuild:null, but a stale lastVerdict:"pass" surfacing
    // next to a fresh unverified proposal is a false signal on status surfaces. Preserve nothing.
    lastVerdict: null,
    updatedAt: nowIso(),
  };
  await writeState(paths, state);

  console.error(`[loombridge adopt] genre=${proposal.genre} engine=${args.engine} root=${args.root}`);
  console.error(
    `[loombridge adopt] proposed (UNVERIFIED) contract from ${proposal.seededFrom}: ` +
      `${rel(args.root, paths.acceptance)}, ${rel(args.root, paths.feelSpec)}, ${rel(args.root, paths.gameSpec)}, ${rel(args.root, reportPath)}`,
  );
  for (const s of signals) {
    console.error(`[loombridge adopt] signal ${s.kind}: ${s.present ? "present" : "MISSING"}${s.detail ? ` — ${s.detail}` : ""}`);
  }
  // Design-doc hardening (RCL tranche-2) — ADVISORY only. When the proposal was seeded from a
  // structured brief, surface the coverage checklist + anti-drift/scale WARNs the pre-build review
  // would have caught. Never changes the adopt exit code.
  if ("genreContract" in proposal && proposal.genreContract) {
    for (const line of formatDesignHardeningAdvisory(proposal.genreContract)) {
      console.error(`[loombridge adopt] ${line}`);
    }
  }
  console.error(`[loombridge adopt] ${DISCLAIMER}`);
  console.error("[loombridge adopt] next: review the proposal, then `loombridge target` → `loombridge plan` → build → verify → doneness.");
  return 0;
}

type ParsedAdoptArgs = Omit<AdoptArgs, "engine"> & { engine?: string };

/**
 * A `--help`/parse outcome. `usageError` exits 2; a bare `help` exits 0.
 *
 * Both outcomes print the usage text, which is exactly why they must be told apart at the exit
 * code: every REFUSAL here (a missing `--genre`, an unknown flag) used to return 0 alongside the
 * genuine `--help`, so `adopt`'s "I will not guess the genre" refusal reported SUCCESS and a CI
 * step or an agent branching on `$?` read it as a pass. Same discriminator `update` already carries.
 */
type ParseHelp = { help: true; usageError?: boolean };

function parseArgs(args: string[]): ParsedAdoptArgs | ParseHelp {
  let genre = "";
  let genreExplicit = false;
  let engine: string | undefined;
  let name: string | undefined;
  let root = process.cwd();
  let docsPath: string | undefined;
  let scenePath: string | undefined;
  let force = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--genre") { genre = args[(i += 1)] ?? genre; genreExplicit = true; }
    else if (arg === "--engine") engine = args[(i += 1)] ?? engine;
    else if (arg === "--name") name = args[(i += 1)] ?? name;
    else if (arg === "--root") root = path.resolve(args[(i += 1)] ?? root);
    else if (arg === "--docs") docsPath = path.resolve(args[(i += 1)] ?? "");
    else if (arg === "--scene") scenePath = path.resolve(args[(i += 1)] ?? "");
    else if (arg === "--force") force = true;
    else if (arg === "--help" || arg === "-h") return { help: true };
    else {
      console.error(`[loombridge adopt] unknown argument "${arg}".`);
      return { help: true, usageError: true };
    }
  }

  // Genre is required: `adopt` cannot guess the genre of an existing build. The
  // exception is a structured brief in the docs bundle, which carries its own
  // genreId — so an omitted --genre is allowed ONLY when --docs is supplied (the
  // brief resolution then drives the genre). Otherwise default to the registry
  // default is WRONG (it would silently mis-genre the proposal), so require it.
  if (!genreExplicit) {
    if (!docsPath) {
      console.error(
        "[loombridge adopt] --genre is required (or pass --docs with a structured brief that declares its genre). " +
          `Known: ${knownGenreIds().join(", ")}.`,
      );
      return { help: true, usageError: true };
    }
    genre = ""; // resolved from the brief inside the docs bundle
  }

  return { root, genre, engine, name, docsPath, scenePath, force };
}

function printUsage(): void {
  console.log(
    [
      "Usage: loombridge adopt [options]",
      "",
      "Build-then-verify on-ramp (RCL-P02): ingest an EXISTING built project +",
      "design docs and PROPOSE an acceptance contract, so verification can be",
      "retrofitted onto a build that did not start in the flow.",
      "",
      "`adopt` PROPOSES, it never VERIFIES: it writes a contract clearly marked as",
      "a proposal (+ ADOPTION.json) and sets phase `planned` with NO build run and",
      "NO verdict — `loombridge verify` / `loombridge doneness` still refuse until the",
      "project is properly planned, built, and verified.",
      "",
      "Options:",
      `  --genre <id>    Genre pack — one of: ${knownGenreIds().join(", ")}. Required`,
      "                  unless --docs carries a structured brief that declares its genre.",
      "  --engine <id>   Target engine. Auto-detected from --root when omitted.",
      "  --name <name>   Game name (default: project folder name).",
      "  --docs <path>   Design-doc bundle (a docs directory or a brief .json). When it",
      "                  carries the interview-equivalent GenreContract, the proposal is",
      "                  promoted from it; otherwise it seeds from the genre pack template.",
      "  --scene <path>  Existing scene/build file, recorded as evidence of an existing build.",
      "  --root <dir>    Project root (default: cwd).",
      "  --force         Replace an existing .loombridge/ACCEPTANCE.json.",
      "  -h, --help      Show this help.",
      "",
      "Exit: 0 proposal emitted; 1 refused (e.g. existing contract); 2 usage error.",
    ].join("\n"),
  );
}

/**
 * Resolve the engine at the CLI layer (mirrors `plan`): explicit `--engine` wins
 * (validated), else auto-detect; never prompts. Returns the engine or an exit code.
 */
function resolveEngine(parsed: ParsedAdoptArgs): { engine: string } | { exitCode: number } {
  if (parsed.engine !== undefined) {
    if (parsed.engine !== "unity") {
      console.error(`[loombridge adopt] --engine ${parsed.engine} is not supported; Loombridge currently supports Unity only`);
      return { exitCode: 2 };
    }
    return { engine: parsed.engine };
  }
  const detected = detectEngine(parsed.root);
  if (detected.engine === null) {
    console.error(`[loombridge adopt] ${detected.reason}`);
    return { exitCode: 2 };
  }
  if (detected.engine !== "unity") {
    console.error(`[loombridge adopt] detected ${detected.engine}, but Loombridge currently supports Unity only`);
    return { exitCode: 2 };
  }
  console.error(`[loombridge adopt] detected engine: ${detected.engine}`);
  return { engine: detected.engine };
}

/** CLI entry: parse the post-subcommand args and run. */
export async function run(args: string[]): Promise<number> {
  const parsed = parseArgs(args);
  if ("help" in parsed) {
    printUsage();
    return parsed.usageError ? 2 : 0;
  }
  const resolved = resolveEngine(parsed);
  if ("exitCode" in resolved) return resolved.exitCode;
  return runAdopt({ ...parsed, engine: resolved.engine });
}
