/**
 * `loombridge genre <init>`: the authoring front door for the any-genre path.
 *
 * `plan --genre-contract` / `plan --brief` have always compiled an arbitrary genre into a working
 * ACCEPTANCE.json + SLICES.json. What was missing was a way to WRITE the contract without reading
 * `validator.ts` (GenreGenericity.md §2). `genre init` writes one that passes the real validator
 * unedited, so the first move on a genre with no pack is a command rather than a study session.
 *
 * WHERE IT WRITES, and why it matters: `.loombridge/genre-contract.json` by default, because
 * `resolveBriefBundle` already resolves that exact filename inside a `--brief` directory. So
 *
 *     loombridge genre init --genre <id> --class <class>
 *     loombridge plan --brief .loombridge
 *
 * composes with no path juggling. `--out` overrides it for an author who keeps briefs elsewhere.
 *
 * REFUSES TO OVERWRITE without `--force`, matching every other seeding verb here: a scaffold that
 * silently replaced a contract someone had spent an afternoon on would be a destructive default.
 */

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { CANONICAL_BRIEF_FILENAME } from "../../domain/brief-bundle.js";
import { LOOMBRIDGE_DIRNAME } from "../../domain/state.js";
import { GENRE_CLASSES } from "./genre-contract/types.js";
import {
  hintCardGenreIds,
  isScaffoldError,
  scaffoldGenreContract,
} from "./genre-contract/scaffold.js";

const TAG = "[loombridge genre]";

/**
 * The default output filename. Taken from the brief-bundle resolver's own priority list rather than
 * spelled again here, so the "init then --brief" composition cannot be broken by renaming one side.
 */
export const DEFAULT_CONTRACT_FILENAME = CANONICAL_BRIEF_FILENAME;

interface InitArgs {
  genreId: string;
  genreClass?: string;
  device?: string;
  inputScheme?: string;
  outPath?: string;
  root: string;
  force: boolean;
  includeFidelityCriteria: boolean;
}

type ParseHelp = { help: true; usageError?: boolean };

export async function run(argv: string[]): Promise<number> {
  const sub = argv[0];
  if (!sub || sub === "--help" || sub === "-h") {
    printUsage();
    return sub ? 0 : 2;
  }
  if (sub !== "init") {
    console.error(`${TAG} unknown subcommand "${sub}".`);
    printUsage();
    return 2;
  }

  const parsed = parseInitArgs(argv.slice(1));
  if ("help" in parsed) {
    printUsage();
    return parsed.usageError ? 2 : 0;
  }
  return runInit(parsed);
}

export async function runInit(args: InitArgs): Promise<number> {
  const result = scaffoldGenreContract({
    genreId: args.genreId,
    ...(args.genreClass !== undefined ? { genreClass: args.genreClass } : {}),
    ...(args.device !== undefined ? { device: args.device } : {}),
    ...(args.inputScheme !== undefined ? { inputScheme: args.inputScheme } : {}),
    includeFidelityCriteria: args.includeFidelityCriteria,
  });
  if (isScaffoldError(result)) {
    console.error(`${TAG} ${result.error}`);
    return 2;
  }

  const outPath = args.outPath ?? path.join(args.root, LOOMBRIDGE_DIRNAME, DEFAULT_CONTRACT_FILENAME);
  const exists = await pathExists(outPath);
  if (exists && !args.force) {
    console.error(
      `${TAG} ${outPath} already exists. Re-run with --force to replace it, or pass --out <path> to ` +
        "write elsewhere. A scaffold never overwrites an authored contract by default.",
    );
    return 2;
  }

  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, `${JSON.stringify(result.contract, null, 2)}\n`, "utf-8");

  console.log(`${TAG} wrote ${outPath}${exists ? " (replaced)" : ""}`);
  for (const note of result.notes) console.log(`${TAG} ${note}`);
  if (result.placeholders.length > 0) {
    console.log(
      `${TAG} ${result.placeholders.length} field(s) still say "REPLACE ME" and are yours to write: ` +
        `${result.placeholders.join(", ")}`,
    );
  }
  for (const warning of result.warnings) console.error(`${TAG} ${warning}`);
  console.log(
    `${TAG} next: edit the contract, then \`loombridge plan --brief ${path.dirname(outPath)}\` ` +
      "(or `--genre-contract <path>`). It plans and builds like any genre and verifies as " +
      "`partially-graded`, with its ungraded gaps enumerated on the verdict.",
  );
  return 0;
}

function parseInitArgs(args: string[]): InitArgs | ParseHelp {
  let genreId: string | undefined;
  let genreClass: string | undefined;
  let device: string | undefined;
  let inputScheme: string | undefined;
  let outPath: string | undefined;
  let root = process.cwd();
  let force = false;
  let includeFidelityCriteria = true;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--genre") genreId = args[(i += 1)];
    else if (arg === "--class") genreClass = args[(i += 1)];
    else if (arg === "--device") device = args[(i += 1)];
    else if (arg === "--input-scheme") inputScheme = args[(i += 1)];
    else if (arg === "--out") outPath = path.resolve(args[(i += 1)] ?? "");
    else if (arg === "--root") root = path.resolve(args[(i += 1)] ?? root);
    else if (arg === "--force") force = true;
    else if (arg === "--no-fidelity-criteria") includeFidelityCriteria = false;
    else if (arg === "--help" || arg === "-h") return { help: true };
    else {
      console.error(`${TAG} unknown argument "${arg}".`);
      return { help: true, usageError: true };
    }
  }

  if (!genreId) {
    console.error(`${TAG} --genre <id> is required: the contract is written FOR a genre, and it is never guessed.`);
    return { help: true, usageError: true };
  }
  return {
    genreId,
    ...(genreClass !== undefined ? { genreClass } : {}),
    ...(device !== undefined ? { device } : {}),
    ...(inputScheme !== undefined ? { inputScheme } : {}),
    ...(outPath !== undefined ? { outPath } : {}),
    root,
    force,
    includeFidelityCriteria,
  };
}

function printUsage(): void {
  const packs = hintCardGenreIds();
  console.log(
    [
      "Usage: loombridge genre init --genre <id> [options]",
      "",
      "Scaffold a Genre Contract: the plan-time build contract that lets `plan` handle a",
      "genre with no shipped pack. The output passes `validateGenreContract` unedited, so",
      "it is a starting point you refine rather than a draft you debug.",
      "",
      "Options:",
      "  --genre <id>    The genre this contract is for. Any id: an UNREGISTERED genre is",
      "                  the point of this path. Ids with a hint-card pack seed their",
      `                  tunables, bands, asset roles, and exemplars: ${packs.join(", ") || "(none installed)"}.`,
      `  --class <c>     Genre class: ${GENRE_CLASSES.join(" | ")}. REQUIRED when the genre has no`,
      "                  hint-card pack, because the class picks the completeness rules the",
      "                  validator applies and it is never guessed from an id. With a pack it",
      "                  is seeded, and a --class that contradicts the pack refuses.",
      "  --device <s>    Target device (default: pc).",
      "  --input-scheme <s>",
      "                  Input scheme (default: kb-mouse).",
      `  --out <path>    Where to write (default: <root>/${LOOMBRIDGE_DIRNAME}/${DEFAULT_CONTRACT_FILENAME},`,
      "                  the name `plan --brief <dir>` resolves).",
      "  --root <dir>    Project root for the default output path (default: cwd).",
      "  --force         Replace an existing file. Without it an existing contract is never",
      "                  overwritten.",
      "  --no-fidelity-criteria",
      "                  Omit `fidelityCriteria`. NOT recommended: without it `loombridge",
      "                  doneness` refuses any build of this genre that has an approved Design",
      "                  Target, which is the hero-shot half of the verification moat.",
      "",
      "Then: `loombridge plan --brief <dir>` (or `--genre-contract <file>`).",
      "See Docs/Profiles/GenreContractAuthoring.md for the decisions the contract asks you to make.",
    ].join("\n"),
  );
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}
