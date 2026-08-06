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
  GENRE_CONTRACT_SCHEMA_FILE,
  hintCardGenreIds,
  isScaffoldError,
  placeholderPrefix,
  scaffoldGenreContract,
} from "./genre-contract/scaffold.js";

const TAG = "[loombridge genre]";

/**
 * The marker string the scaffold leaves in every field a human still has to write, read from the
 * template rather than spelled here: `plan`'s refusal keys off the SAME value, so a template rename
 * must not be able to leave this prose pointing at a token nothing looks for any more.
 */
const PLACEHOLDER_LABEL = placeholderPrefix();

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
  const existing = await statKind(outPath);
  const exists = existing !== "absent";
  if (exists && !args.force) {
    console.error(
      `${TAG} ${outPath} already exists. Re-run with --force to replace it, or pass --out <path> to ` +
        "write elsewhere. A scaffold never overwrites an authored contract by default.",
    );
    return 2;
  }
  // `--force` means "replace the contract at this path", never "replace whatever is at this path".
  // Writing a file over a DIRECTORY is an EISDIR the CLI used to surface as an unhandled stack
  // trace, which reads as a crash rather than as the usage error it is.
  if (existing === "directory") {
    console.error(
      `${TAG} ${outPath} is a DIRECTORY, not a contract file: refusing to write over it (--force ` +
        `replaces a contract, not a directory). Pass --out <dir>/${DEFAULT_CONTRACT_FILENAME}, or ` +
        "point --out at a different path.",
    );
    return 2;
  }

  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, `${JSON.stringify(result.contract, null, 2)}\n`, "utf-8");

  console.log(`${TAG} wrote ${outPath}${exists ? " (replaced)" : ""}`);
  for (const note of result.notes) console.log(`${TAG} ${note}`);
  if (result.placeholders.length > 0) {
    console.log(
      `${TAG} ${result.placeholders.length} field(s) still say "${PLACEHOLDER_LABEL}" and are yours to ` +
        `write: ${result.placeholders.join(", ")}. \`loombridge plan\` REFUSES a contract that still ` +
        "carries any of them.",
    );
  }
  for (const warning of result.warnings) console.error(`${TAG} ${warning}`);
  // The close has to match the genre it just scaffolded. Promising `partially-graded` for an id that
  // resolves to a REGISTERED pack is the closing line contradicting the warning above it: coverage
  // comes from the registry, so the claim is `graded` against the PACK's oracle, not this contract's.
  console.log(
    result.registeredPack
      ? `${TAG} next: fill in every "${PLACEHOLDER_LABEL}" field (\`plan\` REFUSES a contract that still ` +
          `carries one), then \`loombridge plan --brief ${path.dirname(outPath)}\`. NOTE: because ` +
          `"${args.genreId}" is a registered pack, that plan verifies as \`graded\` against the PACK's ` +
          "feel and fidelity oracle: this file's own `fidelityCriteria` are not what it is graded on. " +
          "Rename `genreId` to an unregistered id to have this contract govern its own grading."
      : `${TAG} next: fill in every "${PLACEHOLDER_LABEL}" field (\`plan\` REFUSES a contract that still ` +
          `carries one), then \`loombridge plan --brief ${path.dirname(outPath)}\` ` +
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
      "Then: `loombridge plan --brief <dir>` (or `--genre-contract <file>`). `plan` REFUSES a",
      `contract that still carries a "${PLACEHOLDER_LABEL}" field, so fill them in first.`,
      "",
      // The npm package ships `dist` + `src` and NOT `Docs/`, so pointing a consumer at a
      // Docs/ path is a dangling reference on every machine that installed from npm. Point at the
      // schema that DOES ship (it is the field-by-field reference) and at the repo for the prose.
      "Reference: the JSON Schema shipped beside the code,",
      `  ${path.relative(process.cwd(), GENRE_CONTRACT_SCHEMA_FILE)}`,
      "Full authoring guide (repo only, not shipped in the npm package):",
      "  https://github.com/Loomtide/loombridge/blob/main/Docs/Profiles/GenreContractAuthoring.md",
    ].join("\n"),
  );
}

/** What is at `p` today: a regular file, a directory, or nothing. */
async function statKind(p: string): Promise<"file" | "directory" | "absent"> {
  try {
    return (await fs.stat(p)).isDirectory() ? "directory" : "file";
  } catch {
    return "absent";
  }
}
