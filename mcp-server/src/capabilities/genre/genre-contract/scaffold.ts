/**
 * Genre Contract scaffolder: the generator behind `loombridge genre init`.
 *
 * The `--genre-contract` / `--brief` path has always been able to plan an ARBITRARY genre; what it
 * lacked was a way in. Authoring a contract from scratch meant reading `validator.ts` to learn nine
 * rule families and seven closed sets, so the generic path wore the costume of a supported one
 * (GenreGenericity.md §2). This module closes that: it emits a contract that passes the REAL
 * `validateGenreContract` unedited, seeded from the genre's hint-card pack when one exists.
 *
 * THE BAR, and the reason `scaffoldGenreContract` validates its own output before returning: a
 * generator whose output the gate rejects is worse than no generator. A caller never writes an
 * invalid contract from here. The self-check turns a template regression into a loud refusal
 * instead of a file the author has to debug.
 *
 * GENRE-NEUTRAL BY CONSTRUCTION. Every seed lives in `init-templates.json` keyed by genreClass, and
 * per-genre knowledge is read from `genre-packs/<id>/hint-card.json` discovered on disk. No genre id
 * is written as a literal here, which is what `genre-core-litmus.test.ts` requires of anything under
 * `capabilities/`.
 *
 * PLACEHOLDERS ARE LOUD ON PURPOSE. The fields no generator can know (the core loop, the art
 * direction, each feedback chain) are seeded with a `REPLACE ME:` marker and reported back to the
 * caller, so the scaffold reads as a starting point rather than as a finished contract.
 */

import fsSync from "node:fs";
import path from "node:path";

import { packageRoot } from "../../../shared/pkg-root.js";
import { knownGenreIds, resolveGenrePack } from "../genre-registry.js";
import { IMPLEMENTED_CALCULATOR_IDS, validateGenreContract } from "./validator.js";
import { validateHintCard, type GenreHintCard } from "./hint-card.js";
import {
  GENRE_CLASSES,
  GENRE_CLASS_SET,
  GENRE_CONTRACT_SCHEMA_VERSION,
  type GenreClass,
  type GenreContract,
  type HumanOracleCheck,
  type MeasurabilityEntry,
  type RefusalCondition,
  type SliceDag,
  type Tunable,
} from "./types.js";

const PKG_ROOT = packageRoot(import.meta.url);

/**
 * Genre-contract material lives under `src/`, not `dist/`: `tsc` does not copy `.json`, so the
 * templates and the hint-card packs are read from source at runtime. Same convention as
 * `genre-registry.ts` and the platformer pack.
 */
const CONTRACT_ROOT = path.join(PKG_ROOT, "src", "capabilities", "genre", "genre-contract");
const TEMPLATES_PATH = path.join(CONTRACT_ROOT, "init-templates.json");
const HINT_CARD_PACK_ROOT = path.join(CONTRACT_ROOT, "genre-packs");
const HINT_CARD_FILE = "hint-card.json";

/** The published JSON Schema, for the pointer the scaffolder prints. */
export const GENRE_CONTRACT_SCHEMA_FILE = path.join(CONTRACT_ROOT, "genre-contract.schema.json");

/* ------------------------------------------------------------------ template shapes */

interface ClassTemplate {
  coreLoopSuffix: string;
  feedbackChains: Array<{ verb: string; input: string; response: string; feedback: string }>;
  judgmentOnly: Array<{ target: string; check: string }>;
  fidelityCriteria: string[];
}

interface SharedTemplate {
  targetPlatform: { device: string; inputScheme: string };
  verticalSliceBudget: { coreVerticalContent: Record<string, number>; deferred: string[] };
  measurabilityMap: Array<MeasurabilityEntry & { note?: string }>;
  tunables: Tunable[];
  sliceDag: SliceDag;
}

interface InitTemplates {
  placeholderPrefix: string;
  shared: SharedTemplate;
  classes: Record<string, ClassTemplate>;
}

let cachedTemplates: InitTemplates | null = null;

function loadTemplates(): InitTemplates {
  if (cachedTemplates) return cachedTemplates;
  cachedTemplates = JSON.parse(fsSync.readFileSync(TEMPLATES_PATH, "utf-8")) as InitTemplates;
  return cachedTemplates;
}

/** The marker every field a human still has to write is seeded with. */
export function placeholderPrefix(): string {
  return loadTemplates().placeholderPrefix;
}

/* ------------------------------------------------------------------ hint-card packs */

/**
 * The genre ids that ship a hint-card pack, discovered from disk rather than listed here, because a list in
 * TypeScript would both drift from the packs and put genre ids in the pipeline core.
 */
export function hintCardGenreIds(): string[] {
  let entries: fsSync.Dirent[];
  try {
    entries = fsSync.readdirSync(HINT_CARD_PACK_ROOT, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && fsSync.existsSync(path.join(HINT_CARD_PACK_ROOT, e.name, HINT_CARD_FILE)))
    .map((e) => e.name)
    .sort();
}

/**
 * Load a genre's hint card. Returns `null` when the genre ships no pack (the normal case for a new
 * genre, and NOT an error), and `{ error }` when a pack exists but does not validate. A broken card
 * must refuse rather than silently degrade to the class skeleton, or the scaffold would quietly stop
 * carrying the pack knowledge the author asked for.
 */
export function loadHintCard(genreId: string): GenreHintCard | null | { error: string } {
  const file = path.join(HINT_CARD_PACK_ROOT, genreId, HINT_CARD_FILE);
  if (!fsSync.existsSync(file)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fsSync.readFileSync(file, "utf-8"));
  } catch (err) {
    return { error: `hint card ${file} is not readable JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  const { valid, issues } = validateHintCard(parsed);
  if (!valid) {
    return { error: `hint card ${file} is invalid: ${issues.map((i) => `${i.path}: ${i.message}`).join("; ")}` };
  }
  return parsed as GenreHintCard;
}

/* ------------------------------------------------------------------ scaffolding */

export interface ScaffoldOptions {
  /** The genre id the contract is for. Open by design: an unregistered id is the whole point. */
  genreId: string;
  /** Required when the genre ships no hint card: the class cannot be guessed from an id. */
  genreClass?: string;
  /** Device + input scheme overrides; defaults come from the shared template. */
  device?: string;
  inputScheme?: string;
  /**
   * Emit `fidelityCriteria`. Default TRUE and it should stay that way: absent, `doneness` REFUSES
   * any design-targeted build of this genre, so it is the single field that buys back hero-shot
   * certification without a registered pack.
   */
  includeFidelityCriteria?: boolean;
}

export interface ScaffoldSuccess {
  contract: GenreContract;
  /** What the scaffold decided, in the order it decided it. Printed by the CLI. */
  notes: string[];
  /** Things the author must act on. Printed by the CLI, and never silent. */
  warnings: string[];
  /** Dotted paths whose value still carries the placeholder marker. */
  placeholders: string[];
  /**
   * True when this genre id ALSO names a registered pack. The scaffold still succeeds (an author may
   * legitimately want a pack genre's contract as a starting point), but the downstream claim is not
   * the one the any-genre path advertises, so the caller must say so rather than print the generic
   * "verifies as partially-graded" close. See the warning built in `registeredPackWarning`.
   */
  registeredPack: boolean;
}

export type ScaffoldResult = ScaffoldSuccess | { error: string };

export function isScaffoldError(r: ScaffoldResult): r is { error: string } {
  return "error" in r;
}

export function scaffoldGenreContract(opts: ScaffoldOptions): ScaffoldResult {
  const templates = loadTemplates();
  const notes: string[] = [];
  const warnings: string[] = [];

  const genreId = opts.genreId.trim();
  if (!genreId) return { error: "a genre id is required" };

  const card = loadHintCard(genreId);
  if (card !== null && "error" in card) return { error: card.error };

  // A genre id can be BOTH a hint-card pack and a REGISTERED pack (the shooters are), which makes
  // `genre init --genre <shooter>` the most natural "customise the shooter" invocation and the one
  // that silently does not do what it says. Warn rather than refuse: scaffolding a registered
  // genre's contract is a legitimate starting point (rename the id, keep the seeds), and refusing
  // would take away the only ergonomic route to one.
  const registeredPack = resolveGenrePack(genreId) !== null;
  if (registeredPack) warnings.push(registeredPackWarning(genreId));

  // The class is AUTHORITATIVE (it selects the validator's completeness profile), so it is never
  // guessed: a genre with no pack must state it, and a genre with a pack may not contradict it.
  let genreClass: GenreClass;
  if (opts.genreClass !== undefined) {
    if (!GENRE_CLASS_SET.has(opts.genreClass)) {
      return { error: `unknown genre class "${opts.genreClass}" (one of: ${GENRE_CLASSES.join(", ")})` };
    }
    if (card && card.genreClass !== opts.genreClass) {
      return {
        error:
          `genre class "${opts.genreClass}" contradicts the "${genreId}" hint-card pack, which declares ` +
          `"${card.genreClass}". Drop the flag to use the pack's class, or scaffold under a different genre id.`,
      };
    }
    genreClass = opts.genreClass as GenreClass;
  } else if (card) {
    genreClass = card.genreClass;
    notes.push(`genre class "${genreClass}" seeded from the ${genreId} hint-card pack`);
  } else {
    return {
      error:
        `"${genreId}" ships no hint-card pack, so the genre class cannot be seeded. ` +
        `Pass --class <${GENRE_CLASSES.join("|")}>: twitch and hybrid must commit to a measurable feel ` +
        "target and at least one feedback chain, systems carries its weight in human-oracle checks. " +
        (hintCardGenreIds().length > 0 ? `Packs available: ${hintCardGenreIds().join(", ")}.` : ""),
    };
  }

  const classTemplate = templates.classes[genreClass];
  if (!classTemplate) return { error: `init-templates.json has no seed block for genre class "${genreClass}"` };
  const shared = templates.shared;
  const marker = templates.placeholderPrefix;

  if (card) {
    notes.push(`seeded tunables, bands, asset roles, and exemplars from the ${genreId} hint-card pack`);
  } else {
    notes.push(`no hint-card pack for "${genreId}", seeded the ${genreClass} skeleton`);
  }

  /* --- field 7: the measurability map, and the oracle checks it implies ------------------- */

  const measurabilityMap: MeasurabilityEntry[] = [];
  const humanOracleChecks: HumanOracleCheck[] = [];
  const seenTargets = new Set<string>();

  const addRow = (row: MeasurabilityEntry, oracleCheck?: string): void => {
    if (seenTargets.has(row.target)) return;
    seenTargets.add(row.target);
    measurabilityMap.push(row);
    if (row.tag === "judgment-only") {
      humanOracleChecks.push({ check: oracleCheck ?? oracleQuestionFor(row), appliesTo: row.target });
    }
  };

  if (card) {
    for (const band of card.defaultBands) {
      addRow({
        target: band.target,
        tag: band.measurabilityTag,
        ...(band.calculator ? { calculator: band.calculator } : {}),
        ...(band.band ? { band: band.band } : {}),
        evidenceKind: band.evidenceKind,
        bucket: "coreVertical",
      });
    }
  }
  // The shared rows come last so a pack's own row for the same target always wins.
  for (const row of shared.measurabilityMap) {
    addRow(stripTemplateNote(row));
  }
  for (const judgment of classTemplate.judgmentOnly) {
    addRow({ target: judgment.target, tag: "judgment-only", bucket: "coreVertical" }, judgment.check);
  }

  // A pack card can go stale in the safe direction: a target it tagged `needs-new-calculator` may
  // have acquired one since. Under-claiming is not a false green, but it silently costs the author
  // a graded metric, so the scaffold says so instead of baking the stale tag in unremarked.
  for (const row of measurabilityMap) {
    if (row.tag === "measurable-now" || row.tag === "judgment-only") continue;
    if (IMPLEMENTED_CALCULATOR_IDS.has(row.target)) {
      warnings.push(
        `"${row.target}" is tagged ${row.tag} but a calculator for it EXISTS today. Retag it ` +
          `measurable-now with calculator: "${row.target}" to have it measured rather than deferred.`,
      );
    }
  }

  /* --- field 10: refusal conditions, DERIVED from the map rather than invented ------------ */

  const refusalConditions: RefusalCondition[] = [];
  const byTag = (tag: MeasurabilityEntry["tag"]): string[] =>
    measurabilityMap.filter((r) => r.tag === tag).map((r) => r.target);
  const unbuilt = [...byTag("needs-new-calculator"), ...byTag("needs-new-bridge-capability")];
  if (unbuilt.length > 0) {
    refusalConditions.push({
      condition: `feel targets with no calculator today: ${unbuilt.join(", ")}`,
      reason:
        "no implemented calculator measures these yet, so they are carried as named gaps on their slices " +
        "and never counted as proven",
    });
  }
  const judgmentTargets = byTag("judgment-only");
  if (judgmentTargets.length > 0) {
    refusalConditions.push({
      condition: `judgment-only targets: ${judgmentTargets.join(", ")}`,
      reason: "no measurable proxy exists; each is bound to a humanOracleCheck and answered by a human",
    });
  }
  const unsupported = byTag("engine-unsupported-today");
  if (unsupported.length > 0) {
    refusalConditions.push({
      condition: `outside the substrate today: ${unsupported.join(", ")}`,
      reason: "Loombridge cannot observe these at all yet; they are declared rather than claimed",
    });
  }

  /* --- assembly --------------------------------------------------------------------------- */

  const tunables: Tunable[] = card
    ? dedupeById([...card.canonicalTunables, ...shared.tunables])
    : [...shared.tunables];
  const perspective = card?.perspectives[0];
  const subGenre = card?.subGenres[0];

  const contract: GenreContract = {
    schemaVersion: GENRE_CONTRACT_SCHEMA_VERSION,
    genreId,
    ...(card && card.subGenres.length > 0 ? { subGenres: [...card.subGenres] } : {}),
    confidence: "experimental",

    targetPlatform: {
      device: opts.device?.trim() || shared.targetPlatform.device,
      inputScheme: opts.inputScheme?.trim() || shared.targetPlatform.inputScheme,
    },
    networkModel: { mode: "single-player", spPlayable: true },
    coreLoop: {
      description: `${marker}: ${classTemplate.coreLoopSuffix}, in one line`,
      ...(perspective ? { perspective } : {}),
      // Only when it says something the perspective did not: several cards taxonomise both axes
      // with the same terms, and echoing one into the other reads as a decision nobody made.
      ...(subGenre && subGenre !== perspective ? { subGenre } : {}),
      genreClass,
    },
    artDirection: {
      style: `${marker}: the art direction in a phrase (e.g. "stylized neon arcade")`,
      ...(card?.assetRoles && card.assetRoles.length > 0 ? { assetRoles: [...card.assetRoles] } : {}),
    },
    verticalSliceBudget: {
      coreVerticalContent: { ...shared.verticalSliceBudget.coreVerticalContent },
      deferred: [...shared.verticalSliceBudget.deferred],
    },

    feedbackChains: classTemplate.feedbackChains.map((c) => ({ ...c })),
    tunables,
    measurabilityMap,
    referenceAnchor: {
      ...(card && card.exemplars.length > 0 ? { exemplars: [...card.exemplars] } : {}),
      notes: card?.notes ?? `${marker}: the clips, exemplar games, or measurements the bands come from`,
    },

    sliceDag: cloneSliceDag(shared.sliceDag),
    refusalConditions,
    humanOracleChecks,
  };

  /* --- fidelityCriteria: present by default, and never silently absent -------------------- */

  if (opts.includeFidelityCriteria === false) {
    warnings.push(
      "fidelityCriteria OMITTED. `loombridge doneness` REFUSES any build of this genre that has an " +
        "approved Design Target until the contract declares them (or ACCEPTANCE.json declares " +
        'art: { "mode": "deferred" }). Re-run without --no-fidelity-criteria to get a starting set.',
    );
  } else {
    contract.fidelityCriteria = [...classTemplate.fidelityCriteria];
    notes.push(`fidelityCriteria seeded for the ${genreClass} class: ${contract.fidelityCriteria.join(", ")}`);
    warnings.push(
      "REVIEW fidelityCriteria before building: a criterion this game's hero shot cannot satisfy makes " +
        "doneness unreachable-green. Drop what does not apply, and add what does.",
    );
  }

  // Self-check. The generator's whole promise is that its output passes the gate unedited, so a
  // template regression refuses here instead of writing a contract the author has to debug.
  const { valid, issues } = validateGenreContract(contract);
  if (!valid) {
    return {
      error:
        "the scaffolded contract does not pass validateGenreContract (this is a Loombridge bug, not " +
        `your input): ${issues.map((i) => `${i.path || "<root>"}: ${i.message} [${i.code}]`).join("; ")}`,
    };
  }

  if (card?.coreHooks && card.coreHooks.length > 0) {
    warnings.push(
      `the ${genreId} pack declares core hooks (${card.coreHooks.map((h) => h.id).join(", ")}): if your brief ` +
        "asks for one, add its minimal core slice plus a coreVerticalContent count rather than deferring it whole.",
    );
  }

  return { contract, notes, warnings, placeholders: collectPlaceholderPaths(contract, marker), registeredPack };
}

/* ------------------------------------------------------------------ helpers */

/**
 * The warning a scaffold under an ALREADY-REGISTERED genre id earns.
 *
 * Three things stop being true the moment the id is registered, and all three are silent:
 *  - coverage resolves from the REGISTRY, not the promotion report, so the build stamps `graded`
 *    rather than the `partially-graded` this path advertises (`genre-coverage.ts` step 1);
 *  - `fidelityCriteriaForGenre` returns the PACK's criteria and never consults the contract's, so
 *    the hero shot is graded on criteria this contract did not write (see the comment there: the
 *    registry wins ON PURPOSE, because `GENRE_PROMOTION.json` is project-editable and the registry
 *    is not, so preferring the report would let a project weaken a shipped genre's criteria);
 *  - the pack's own ACCEPTANCE template is what `plan --genre <id>` seeds, so the two doors into
 *    the same id produce different contracts.
 *
 * Built from `knownGenreIds()` rather than any literal: the genre-core litmus forbids registered
 * genre ids as string literals under `capabilities/`.
 */
function registeredPackWarning(genreId: string): string {
  return (
    `"${genreId}" is ALREADY a REGISTERED genre pack (${knownGenreIds().join(", ")}), so this contract ` +
    "will NOT be graded the way an unregistered genre is. Planning from it still resolves coverage " +
    "from the REGISTRY: the build stamps `graded` (not `partially-graded`), and `loombridge doneness` " +
    "grades the hero shot against the PACK's fidelityCriteria, silently discarding the ones below. " +
    `To get a contract that actually governs its own grading, scaffold under a NEW id (e.g. ` +
    `--genre ${genreId}-<your-variant>). To build the shipped ${genreId}, skip this file and run ` +
    `\`loombridge plan --genre ${genreId}\`.`
  );
}

/**
 * Every dotted path in an ARBITRARY (possibly hand-edited, possibly `JSON.parse`d) genre contract
 * whose string value still carries the scaffold's placeholder marker.
 *
 * ONE rule, two readers: `genre init` reporting what it left for the author, and `plan` REFUSING to
 * plan on top of it: exactly the shape `minigame-draft.ts` uses for `DRAFT:`/`TODO:`. Anchored at
 * the START of the value for the same reason: a real art-direction phrase that merely mentions the
 * words must not trip it.
 *
 * Accepts `unknown` so it is safe over a parsed file before any validation has run.
 */
export function genreContractPlaceholderPaths(contract: unknown): string[] {
  return collectPlaceholderPaths(contract, placeholderPrefix());
}

/**
 * The question a human answers for a judgment-only target. A hint card's qualitative band already
 * says what "good" means, so it becomes the question; otherwise the target name has to carry it.
 */
function oracleQuestionFor(row: MeasurabilityEntry): string {
  const qualitative = row.band?.qualitative;
  return qualitative ? `does the build hold up on: ${qualitative}?` : `does "${row.target}" hold up in play?`;
}

/** `init-templates.json` rows carry an authoring `note` that is template prose, not contract data. */
function stripTemplateNote(row: MeasurabilityEntry & { note?: string }): MeasurabilityEntry {
  const copy: MeasurabilityEntry & { note?: string } = { ...row };
  delete copy.note;
  return copy;
}

function dedupeById(tunables: Tunable[]): Tunable[] {
  const seen = new Set<string>();
  const out: Tunable[] = [];
  for (const t of tunables) {
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    out.push({ ...t });
  }
  return out;
}

function cloneSliceDag(dag: SliceDag): SliceDag {
  return {
    coreVertical: dag.coreVertical.map((n) => ({ ...n, dependsOn: [...n.dependsOn] })),
    deferredMeta: dag.deferredMeta.map((n) => ({ ...n, dependsOn: [...n.dependsOn] })),
  };
}

/** Every dotted path whose string value still carries the placeholder marker. */
function collectPlaceholderPaths(value: unknown, marker: string, at = ""): string[] {
  if (typeof value === "string") return value.startsWith(marker) ? [at] : [];
  if (Array.isArray(value)) return value.flatMap((v, i) => collectPlaceholderPaths(v, marker, `${at}[${i}]`));
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([k, v]) =>
      collectPlaceholderPaths(v, marker, at ? `${at}.${k}` : k),
    );
  }
  return [];
}
