/**
 * `loombridge assets` — deterministic Asset Manifest approval helpers.
 *
 * This is the production-facing bridge from the draft manifest created by
 * `loombridge plan --asset-mode ...` to an approved, provenance-complete
 * `.loombridge/ASSET_MANIFEST.json`. It deliberately consumes explicit JSON
 * inputs rather than hand-editing the manifest.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  applyGeneratedAssetExportsToManifest,
  buildGeneratedAssetPlan,
  type GeneratedAssetAnnotation,
  type GeneratedAssetExportInput,
} from "./generated-assets.js";
import {
  applyRegistrySelectionsToManifest,
  buildAssetPickerSlotsFromRegistrySelectionPlan,
  buildRegistrySelectionPlan,
} from "./manifest-selection.js";
import {
  ApiCatalogSource,
  catalogRecordsToRegistryPack,
  type CatalogFetch,
  catalogUrlFromEnv,
  HttpCatalogSource,
  LocalCatalogSource,
} from "./catalog-source.js";
import { loadAssetProfile, loadRegistryPack } from "./registry.js";
import {
  assertValidAssetManifest,
  readAssetManifest,
  readPromotedAssetProfile,
  writeAssetManifest,
  type AssetManifest,
} from "./asset-manifest.js";
import { DEFAULT_ASSET_GENRE, contractAssetGenreProfile, knownAssetGenres, resolveAssetGenreProfile } from "./asset-genre-profile.js";
import { loombridgePaths } from "../../domain/state.js";

type AssetCommand = "roles" | "registry-plan" | "registry-apply" | "generated-plan" | "generated-apply" | "pack-ingest" | "cover-build" | "discover";

export interface RunAssetsOptions {
  catalogFetch?: CatalogFetch;
  /**
   * Injected R2 storage provider for `pack-ingest --apply` (tests pass a fake; default = R2 from
   * env). Typed opaquely here so this OPEN client entry has no compile-time dependency on the
   * PRIVATE authoring side; the authoring verbs narrow it to `AssetStorageProvider`
   * (src/asset-authoring/storage.ts).
   */
  storage?: unknown;
  /**
   * Environment consulted for the `LOOMBRIDGE_ASSET_CATALOG_URL` fallback. Injected by tests so a
   * developer machine that happens to export the variable cannot change what the suite measures;
   * production leaves it unset and `catalogUrlFromEnv` reads `process.env`.
   */
  env?: NodeJS.ProcessEnv;
}

export interface ParsedArgs {
  action?: AssetCommand;
  root: string;
  /** `assets roles --genre <id>`: which genre's role profile to print. */
  genre?: string;
  registryPath?: string;
  catalogPath?: string;
  catalogApiUrl?: string;
  profilePath?: string;
  selectionsPath?: string;
  fromSelectionPath?: string;
  annotationsPath?: string;
  exportsPath?: string;
  outputPath?: string;
  approvedAt?: string;
  preferredLicense?: string;
  generatedSetId?: string;
  producedFromHash?: string;
  strictRoles?: boolean;
  manifestPath?: string;
  publicBaseUrl?: string;
  reviewer?: string;
  reviewedAt?: string;
  apply?: boolean;
  sourceRoot?: string;
  progressPath?: string;
  thumbsDir?: string;
  outDir?: string;
  columns?: number;
  rows?: number;
  cell?: number;
  sampleSize?: number;
  candidatesPath?: string;
  packId?: string;
  allowAttribution?: boolean;
  help?: boolean;
}

interface WebAssetSelectionItem {
  registryId: string;
  role?: string;
  primitive?: string;
  kind?: string;
  title?: string;
}

interface WebPackSelectionItem {
  packId: string;
  name?: string;
  genre?: string;
  assetCount?: number;
  coverUrl?: string;
}

interface WebSelectionItems {
  assets: WebAssetSelectionItem[];
  packs: WebPackSelectionItem[];
}

const PACK_ID_PATTERN = /^[a-z0-9][a-z0-9.-]*$/;

/**
 * The authoring block is printed ONLY when the private asset-authoring seam is actually present
 * (see `resolveAssetsAuthoringCli`). In an open build the verbs always refuse, and naming a
 * private publish mechanic ("publishes bytes to R2") in help an OSS consumer reads is an
 * information leak in a smaller font. The SAME seam resolution decides what runs and what is
 * advertised, so the two can never disagree; `parseArgs` still accepts the verbs, so someone who
 * types one anyway gets the clear refusal rather than "unknown action".
 */
function printUsage(authoringAvailable: boolean): void {
  const authoringVerbs = authoringAvailable ? "|pack-ingest|cover-build|discover" : "";
  const authoringBlock = authoringAvailable
    ? [
      "Pack ingest (add a new pack to the hosted registry):",
      "  pack-ingest     --manifest <path> [--public-base-url <url>] [--reviewer <name>] [--reviewed-at <iso>] [--output <path>]",
      "                  [--apply --source-root <dir> [--progress <path>]]   # --apply publishes bytes to R2 (default dry-run)",
      "  cover-build     --thumbs <dir> --out-dir <dir> [--columns N] [--rows N] [--cell N] [--sample-size N]   # compose preview.png (+ sample.png)",
      "  discover        --candidates <path> --pack-id <provider.genre.slug> [--out <path>] [--allow-attribution]   # agent candidates -> gated DRAFT manifest (CC0 gate hard)",
      "",
    ]
    : [];
  console.log(
    [
      `Usage: loombridge assets <registry-plan|registry-apply|generated-plan|generated-apply${authoringVerbs}> [options]`,
      "",
      "Discover:",
    "  roles           [--genre <id>] [--root <dir>]   which asset roles a genre requires, which are",
    "                  registry-sourced vs generated in hybrid mode, and the primitives each accepts.",
    "                  Defaults to the genre in this project's ASSET_MANIFEST.json.",
    "",
    "Registry:",
      "  registry-plan   (--registry <path> | --catalog <path-or-url> | --catalog-api <baseUrl>) --profile <path> [--output <path>] [--preferred-license <spdx>]",
      "  registry-apply  (--registry <path> | --catalog <path-or-url> | --catalog-api <baseUrl>) --profile <path> (--selections <json> | --from-selection <web-selection.json>) --approved-at <iso> [--preferred-license <spdx>] [--strict-roles]",
      "",
      "Generated:",
      "  generated-plan  --annotations <json> [--output <path>] [--generated-set-id <id>] [--produced-from-hash <sha256>]",
      "  generated-apply --annotations <json> --exports <json> --approved-at <iso> [--generated-set-id <id>] [--produced-from-hash <sha256>]",
      "",
      ...authoringBlock,
      "Common:",
      "  --root <dir>     Project root (default: cwd)",
      "",
      "Input shapes:",
      "  --selections accepts {\"asset_id\":\"registry.entry.id\"} or {\"selections\":{...}}.",
      "  --from-selection accepts asset-web selection.json v1/v2; asset items role-match first and primitive-fallback second. Pack items require --catalog-api and are imported to .loombridge/registry/<packId>.json.",
      "  --annotations accepts an annotation array or {\"annotations\":[...]}.",
      "  --exports accepts an export array or {\"exports\":[...]}.",
    ].join("\n"),
  );
}

function parseArgs(args: string[]): ParsedArgs {
  const first = args[0];
  if (!first || first === "--help" || first === "-h") return { root: process.cwd(), help: true };
  if (!["roles", "registry-plan", "registry-apply", "generated-plan", "generated-apply", "pack-ingest", "cover-build", "discover"].includes(first)) {
    console.error(`[loombridge assets] unknown action "${first}".`);
    return { root: process.cwd(), help: true };
  }
  let root = process.cwd();
  for (let i = 1; i < args.length; i += 1) {
    if (args[i] === "--root") root = path.resolve(args[(i += 1)] ?? root);
  }

  const parsed: ParsedArgs = { root, action: first as AssetCommand };
  for (let i = 1; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--root") i += 1;
    else if (arg === "--registry") parsed.registryPath = path.resolve(parsed.root, args[(i += 1)] ?? "");
    else if (arg === "--catalog") {
      const value = args[(i += 1)] ?? "";
      parsed.catalogPath = /^https?:\/\//.test(value) ? value : path.resolve(parsed.root, value);
    }
    else if (arg === "--catalog-api") parsed.catalogApiUrl = args[(i += 1)] ?? "";
    else if (arg === "--profile") parsed.profilePath = path.resolve(parsed.root, args[(i += 1)] ?? "");
    else if (arg === "--selections") parsed.selectionsPath = path.resolve(parsed.root, args[(i += 1)] ?? "");
    else if (arg === "--from-selection") parsed.fromSelectionPath = path.resolve(parsed.root, args[(i += 1)] ?? "");
    else if (arg === "--annotations") parsed.annotationsPath = path.resolve(parsed.root, args[(i += 1)] ?? "");
    else if (arg === "--exports") parsed.exportsPath = path.resolve(parsed.root, args[(i += 1)] ?? "");
    else if (arg === "--output") parsed.outputPath = path.resolve(parsed.root, args[(i += 1)] ?? "");
    else if (arg === "--approved-at") parsed.approvedAt = args[(i += 1)] ?? "";
    else if (arg === "--preferred-license") parsed.preferredLicense = args[(i += 1)] ?? "";
    else if (arg === "--generated-set-id") parsed.generatedSetId = args[(i += 1)] ?? "";
    else if (arg === "--produced-from-hash") parsed.producedFromHash = args[(i += 1)] ?? "";
    else if (arg === "--strict-roles") parsed.strictRoles = true;
    else if (arg === "--genre") parsed.genre = args[(i += 1)] ?? "";
    else if (arg === "--manifest") parsed.manifestPath = path.resolve(parsed.root, args[(i += 1)] ?? "");
    else if (arg === "--public-base-url") parsed.publicBaseUrl = args[(i += 1)] ?? "";
    else if (arg === "--reviewer") parsed.reviewer = args[(i += 1)] ?? "";
    else if (arg === "--reviewed-at") parsed.reviewedAt = args[(i += 1)] ?? "";
    else if (arg === "--apply") parsed.apply = true;
    else if (arg === "--source-root") parsed.sourceRoot = path.resolve(parsed.root, args[(i += 1)] ?? "");
    else if (arg === "--progress") parsed.progressPath = path.resolve(parsed.root, args[(i += 1)] ?? "");
    else if (arg === "--thumbs") parsed.thumbsDir = path.resolve(parsed.root, args[(i += 1)] ?? "");
    else if (arg === "--out-dir") parsed.outDir = path.resolve(parsed.root, args[(i += 1)] ?? "");
    else if (arg === "--columns") parsed.columns = Number.parseInt(args[(i += 1)] ?? "", 10);
    else if (arg === "--rows") parsed.rows = Number.parseInt(args[(i += 1)] ?? "", 10);
    else if (arg === "--cell") parsed.cell = Number.parseInt(args[(i += 1)] ?? "", 10);
    else if (arg === "--sample-size") parsed.sampleSize = Number.parseInt(args[(i += 1)] ?? "", 10);
    else if (arg === "--candidates") parsed.candidatesPath = path.resolve(parsed.root, args[(i += 1)] ?? "");
    else if (arg === "--pack-id") parsed.packId = args[(i += 1)] ?? "";
    else if (arg === "--out") parsed.outputPath = path.resolve(parsed.root, args[(i += 1)] ?? "");
    else if (arg === "--allow-attribution") parsed.allowAttribution = true;
    else if (arg === "--help" || arg === "-h") return { ...parsed, help: true };
    else {
      console.error(`[loombridge assets] unknown option "${arg}".`);
      return { ...parsed, help: true };
    }
  }
  return parsed;
}

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(filePath, "utf-8")) as unknown;
}

export async function writeJsonOrStdout(outputPath: string | undefined, value: unknown): Promise<void> {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  if (!outputPath) {
    process.stdout.write(serialized);
    return;
  }
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, serialized, "utf-8");
}

/**
 * `loombridge assets roles`: which roles a genre requires, and how each is sourced.
 *
 * SNP-P02: a real 3d-shooter plan run spent 32 of 78 shell calls reading Loombridge's own
 * `src/`/`dist/` from inside the consumer project, and `asset-genre-profile.ts` was one of the
 * files it opened, purely to learn which roles the genre needs and which are generated in hybrid
 * mode. That is a discoverability failure, not curiosity: the information is deterministic, cheap,
 * and was reachable only by reading the tool's source. This prints it.
 *
 * Genre resolution: `--genre` wins; otherwise the project's ASSET_MANIFEST.json; otherwise the
 * known genres are listed and it REFUSES rather than silently defaulting to platformer, because
 * defaulting is exactly what made `reticle` look unknown (SNP-T01).
 */
async function runRoles(parsed: ParsedArgs): Promise<number> {
  let genre = parsed.genre?.trim();
  let source = "--genre";
  let manifest: AssetManifest | null = null;
  if (!genre) {
    manifest = await readAssetManifest(loombridgePaths(parsed.root));
    if (manifest) {
      // An ABSENT genre on a real manifest is not missing information: it IS the platformer
      // default, which is how every other consumer reads it (`resolveAssetGenreProfile(undefined)`).
      // Refusing here would break the single most common project, since a platformer draft omits
      // the key entirely. Refuse only when there is no manifest AND no flag.
      genre = manifest.genre?.trim() || DEFAULT_ASSET_GENRE;
      source = manifest.genre?.trim() ? "ASSET_MANIFEST.json" : "ASSET_MANIFEST.json (genre absent: the default)";
    }
  }
  if (!genre) {
    console.error(
      `[loombridge assets] no genre: pass --genre <id>, or run this from a project that has ` +
        `.loombridge/ASSET_MANIFEST.json. Known genres: ${knownAssetGenres().join(", ")}.`,
    );
    return 2;
  }
  // A CONTRACT genre resolves through the manifest's own contractRoles (or, before a
  // manifest exists, the promoted assetProfile on GENRE_PROMOTION.json).
  let contractProfile: ReturnType<typeof contractAssetGenreProfile> | null = null;
  if (!knownAssetGenres().includes(genre)) {
    if (manifest && manifest.genre === genre && manifest.contractRoles) {
      contractProfile = contractAssetGenreProfile(genre, manifest.contractRoles);
    } else {
      const promoted = await readPromotedAssetProfile(loombridgePaths(parsed.root));
      if (promoted && promoted.id === genre) {
        contractProfile = contractAssetGenreProfile(promoted.id, promoted.requiredRoles, promoted.sliceBindings);
        source = `${source} + GENRE_PROMOTION.json assetProfile`;
      }
    }
  }
  if (!knownAssetGenres().includes(genre) && !contractProfile) {
    console.error(
      `[loombridge assets] unknown genre "${genre}" (from ${source}). ` +
        `Known genres: ${knownAssetGenres().join(", ")}. A contract genre needs a promoted ` +
        `assetProfile: declare artDirection.assetRoles and re-run \`loombridge plan --brief/--genre-contract\`.`,
    );
    return 2;
  }

  const profile = contractProfile ?? resolveAssetGenreProfile(genre);
  const lines: string[] = [
    `genre: ${profile.id}   (from ${source})`,
    `required roles: ${profile.requiredRoles.length}`,
    "",
    "  ROLE                  HYBRID SOURCE   ACCEPTED REGISTRY PRIMITIVES",
  ];
  for (const role of profile.requiredRoles) {
    const generated = profile.hybridGeneratedRoles.has(role);
    const rule = profile.roleSelectionRules[role];
    const primitives = rule?.primitives?.length ? rule.primitives.join(", ") : "(none: generated only)";
    const tags = rule?.requiredTags?.length ? `  [tags: ${rule.requiredTags.join(", ")}]` : "";
    lines.push(`  ${role.padEnd(21)} ${(generated ? "generated" : "registry").padEnd(15)} ${primitives}${tags}`);
  }
  lines.push(
    "",
    "In hybrid mode the `generated` roles are authored from the approved hero shot",
    "(`loombridge assets generated-plan`); the rest are selected from a registry or catalog",
    "(`loombridge assets registry-plan`).",
  );
  console.log(lines.join("\n"));
  return 0;
}

async function readProjectManifest(root: string): Promise<AssetManifest> {
  const paths = loombridgePaths(root);
  const manifest = await readAssetManifest(paths);
  if (!manifest) {
    throw new Error("No .loombridge/ASSET_MANIFEST.json — run `loombridge plan --asset-mode <mode>` first.");
  }
  return manifest;
}

export function requireOption(value: string | undefined, flag: string): string {
  if (!value) throw new Error(`Missing required ${flag}.`);
  return value;
}

function sourceLabel(value: string): string {
  if (/^https?:\/\//.test(value)) {
    return value.replace(/^https?:\/\//, "").replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase();
  }
  return path.basename(value, path.extname(value)) || "asset-catalog";
}

/**
 * Resolve the registry/catalog a verb reads from. Exported so the boundary guard can bind its
 * behavioural assertion to the REAL resolver: the previous guard tested `catalogUrlFromEnv` in
 * isolation, which had no production callers, so it could not have caught a live fallback added
 * right here (and did not).
 */
export async function loadRegistryOrCatalog(
  parsed: ParsedArgs,
  genre: string,
  options: RunAssetsOptions = {},
  exactRegistryIds?: string[],
) {
  const sources = [parsed.registryPath, parsed.catalogPath, parsed.catalogApiUrl].filter(Boolean);
  if (sources.length > 1) {
    throw new Error("Use only one of --registry, --catalog, or --catalog-api.");
  }
  if (parsed.registryPath) {
    return loadRegistryPack(parsed.registryPath);
  }

  if (parsed.catalogApiUrl) {
    const source = new ApiCatalogSource(parsed.catalogApiUrl, options.catalogFetch);
    const records = exactRegistryIds
      ? (await Promise.all([...new Set(exactRegistryIds)].sort().map(async (id) => {
        const record = await source.getById(id);
        if (!record) {
          throw new Error(`Unknown registryId '${id}' in --from-selection; it is absent from the loaded registry/catalog.`);
        }
        return record;
      })))
      : await source.query({
        genre,
        preferredLicense: parsed.preferredLicense,
      });
    return catalogRecordsToRegistryPack(records, {
      packId: sourceLabel(parsed.catalogApiUrl),
      name: `Asset Catalog: ${sourceLabel(parsed.catalogApiUrl)}`,
      description: `Adapted from hosted asset catalog search API ${parsed.catalogApiUrl}.`,
    });
  }

  // No source flag: fall back to the ONE documented environment variable. `catalogUrlFromEnv`
  // throws a message naming `LOOMBRIDGE_ASSET_CATALOG_URL` when it is unset, so with nothing
  // configured the verb still refuses by name rather than reaching for a built-in host. This is
  // the production caller that makes the env var (and every doc that advertises it) true.
  const configured = parsed.catalogPath ?? catalogUrlFromEnv(options.env);
  const catalogPath = /^https?:\/\//.test(configured) ? configured : path.resolve(parsed.root, configured);
  const source = /^https?:\/\//.test(catalogPath)
    ? new HttpCatalogSource(catalogPath, options.catalogFetch)
    : new LocalCatalogSource(catalogPath);
  const records = await source.query({
    genre,
    preferredLicense: parsed.preferredLicense,
  });
  return catalogRecordsToRegistryPack(records, {
    packId: sourceLabel(catalogPath),
    name: `Asset Catalog: ${sourceLabel(catalogPath)}`,
    description: `Adapted from hosted asset catalog source ${catalogPath}.`,
  });
}

function selectionsFromJson(value: unknown): Record<string, string> {
  const candidate = (value && typeof value === "object" && "selections" in value)
    ? (value as { selections?: unknown }).selections
    : value;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new Error("--selections must be a JSON object.");
  }
  const out: Record<string, string> = {};
  for (const [key, selected] of Object.entries(candidate)) {
    if (typeof selected !== "string" || selected.length === 0) {
      throw new Error(`--selections entry '${key}' must be a non-empty string.`);
    }
    out[key] = selected;
  }
  return out;
}

function webSelectionItemsFromJson(value: unknown): WebSelectionItems {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("--from-selection must be a JSON object.");
  }
  const input = value as { schemaVersion?: unknown; kind?: unknown; items?: unknown };
  if (input.kind !== "loombridge-asset-selection") {
    throw new Error("--from-selection kind must be 'loombridge-asset-selection'.");
  }
  if (input.schemaVersion !== "1" && input.schemaVersion !== "2") {
    throw new Error("--from-selection schemaVersion must be '1' or '2'.");
  }
  if (!Array.isArray(input.items) || input.items.length === 0) {
    throw new Error("--from-selection items must be a non-empty array.");
  }

  const assets: WebAssetSelectionItem[] = [];
  const packs: WebPackSelectionItem[] = [];
  for (const [index, item] of input.items.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`--from-selection items[${index}] must be an object.`);
    }
    const candidate = item as Record<string, unknown>;
    const type = candidate.type ?? "asset";
    if (type !== "asset" && type !== "pack") {
      throw new Error(`--from-selection items[${index}].type must be 'asset' or 'pack'.`);
    }
    if (type === "pack") {
      if (input.schemaVersion !== "2") {
        throw new Error("--from-selection type:'pack' items require schemaVersion '2'.");
      }
      if (typeof candidate.packId !== "string" || !PACK_ID_PATTERN.test(candidate.packId)) {
        throw new Error(`--from-selection items[${index}].packId must match ${PACK_ID_PATTERN}.`);
      }
      packs.push({
        packId: candidate.packId,
        ...(typeof candidate.name === "string" && candidate.name.length > 0 ? { name: candidate.name } : {}),
        ...(typeof candidate.genre === "string" && candidate.genre.length > 0 ? { genre: candidate.genre } : {}),
        ...(typeof candidate.assetCount === "number" && Number.isFinite(candidate.assetCount) ? { assetCount: candidate.assetCount } : {}),
        ...(typeof candidate.coverUrl === "string" && candidate.coverUrl.length > 0 ? { coverUrl: candidate.coverUrl } : {}),
      });
      continue;
    }
    if (typeof candidate.registryId !== "string" || candidate.registryId.length === 0) {
      throw new Error(`--from-selection items[${index}].registryId must be a non-empty string.`);
    }
    assets.push({
      registryId: candidate.registryId,
      ...(typeof candidate.role === "string" && candidate.role.length > 0 ? { role: candidate.role } : {}),
      ...(typeof candidate.primitive === "string" && candidate.primitive.length > 0 ? { primitive: candidate.primitive } : {}),
      ...(typeof candidate.kind === "string" && candidate.kind.length > 0 ? { kind: candidate.kind } : {}),
      ...(typeof candidate.title === "string" && candidate.title.length > 0 ? { title: candidate.title } : {}),
    });
  }
  return { assets, packs };
}

function itemLabel(item: WebAssetSelectionItem, index: number): string {
  const title = item.title ? ` (${item.title})` : "";
  const role = item.role ? ` role=${item.role}` : "";
  const primitive = item.primitive ? ` primitive=${item.primitive}` : "";
  return `items[${index}] ${item.registryId}${title}${role}${primitive}`;
}

function buildSelectionsFromWebSelection(args: {
  manifest: AssetManifest;
  registry: Awaited<ReturnType<typeof loadRegistryOrCatalog>>;
  profile: Awaited<ReturnType<typeof loadAssetProfile>>;
  items: WebAssetSelectionItem[];
  preferredLicense?: string;
  strictRoles?: boolean;
}): Record<string, string> {
  const plan = buildRegistrySelectionPlan(args.manifest, args.registry, args.profile, {
    preferredLicense: args.preferredLicense,
  });
  if (plan.issues.length > 0) {
    throw new Error(`Cannot map web selection: ${plan.issues.map((issue) => issue.message).join("; ")}`);
  }

  const errors: string[] = [];
  const registryIds = new Set(args.registry.entries.map((entry) => entry.id));
  const matches = new Map<number, typeof plan.slots[number]>();
  const slotToItems = new Map<string, number[]>();
  const attributionRequired: string[] = [];

  for (const [index, item] of args.items.entries()) {
    if (!registryIds.has(item.registryId)) {
      errors.push(`Unknown registryId '${item.registryId}' in ${itemLabel(item, index)}; it is absent from the loaded registry/catalog.`);
      continue;
    }

    const roleMatches = item.role ? plan.slots.filter((slot) => slot.role === item.role) : [];
    const primitiveTokens = new Set([item.primitive, item.kind, item.role].filter((value): value is string => Boolean(value)));
    const primitiveMatches = roleMatches.length > 0 || args.strictRoles
      ? []
      : plan.slots.filter((slot) => slot.primitivePreferences.some((primitive) => primitiveTokens.has(primitive)));
    const candidateSlots = roleMatches.length > 0 ? roleMatches : primitiveMatches;

    if (candidateSlots.length === 0) {
      const mode = args.strictRoles ? "role" : "role or primitive";
      errors.push(`No manifest slot matches ${itemLabel(item, index)} by ${mode}.`);
      continue;
    }
    if (candidateSlots.length > 1) {
      errors.push(
        `Ambiguous web selection ${itemLabel(item, index)} matches multiple manifest slots: ` +
          candidateSlots.map((slot) => `${slot.assetId} (${slot.role})`).join(", ") + ".",
      );
      continue;
    }

    const slot = candidateSlots[0]!;
    const candidate = slot.candidates.find((entry) => entry.id === item.registryId);
    if (!candidate) {
      errors.push(`registryId '${item.registryId}' is not a valid candidate for manifest slot '${slot.assetId}' (${slot.role}).`);
      continue;
    }
    if (candidate.license.requiresAttribution || candidate.policyStatus === "attribution-required") {
      attributionRequired.push(`${slot.assetId}:${candidate.id}`);
    }
    matches.set(index, slot);
    const existing = slotToItems.get(slot.assetId) ?? [];
    existing.push(index);
    slotToItems.set(slot.assetId, existing);
  }

  for (const [slotId, itemIndexes] of slotToItems.entries()) {
    if (itemIndexes.length > 1) {
      errors.push(
        `Ambiguous web selection: multiple items map to manifest slot '${slotId}': ` +
          itemIndexes.map((index) => itemLabel(args.items[index]!, index)).join("; ") + ".",
      );
    }
  }

  const filledSlotIds = new Set([...matches.values()].map((slot) => slot.assetId));
  const unfilledSlots = plan.slots.filter((slot) => !filledSlotIds.has(slot.assetId));
  if (unfilledSlots.length > 0) {
    errors.push(
      `Unfilled manifest slot(s): ${unfilledSlots.map((slot) => `${slot.assetId} (${slot.role})`).join(", ")}.`,
    );
  }

  if (errors.length > 0) {
    throw new Error(`Cannot map web selection to manifest slots:\n- ${errors.join("\n- ")}`);
  }

  const selections = Object.fromEntries(
    [...matches.entries()]
      .sort((a, b) => a[1].assetId.localeCompare(b[1].assetId))
      .map(([index, slot]) => [slot.assetId, args.items[index]!.registryId]),
  );
  console.error(
    `[loombridge assets] from-selection matched=${Object.keys(selections).length}; ` +
      `attribution-required=${attributionRequired.length}` +
      (attributionRequired.length > 0 ? ` (${attributionRequired.sort().join(", ")})` : ""),
  );
  return selections;
}

async function buildImportedRegistryPacks(args: {
  packs: WebPackSelectionItem[];
  catalogApiUrl: string | undefined;
  catalogFetch?: CatalogFetch;
}): Promise<Array<{ packId: string; registryPack: ReturnType<typeof catalogRecordsToRegistryPack> }>> {
  if (args.packs.length === 0) return [];
  const catalogApiUrl = requireOption(args.catalogApiUrl, "--catalog-api");
  const source = new ApiCatalogSource(catalogApiUrl, args.catalogFetch);
  const imported: Array<{ packId: string; registryPack: ReturnType<typeof catalogRecordsToRegistryPack> }> = [];
  const seen = new Set<string>();
  for (const pack of args.packs) {
    if (seen.has(pack.packId)) {
      throw new Error(`Duplicate packId '${pack.packId}' in --from-selection.`);
    }
    seen.add(pack.packId);
    const records = await source.getPackAssets(pack.packId);
    const sorted = [...records].sort((a, b) => a.id.localeCompare(b.id));
    imported.push({
      packId: pack.packId,
      registryPack: catalogRecordsToRegistryPack(sorted, {
        packId: pack.packId,
        name: pack.name ?? pack.packId,
        description: `Imported pack ${pack.packId} from ${catalogApiUrl}.`,
      }),
    });
  }
  return imported.sort((a, b) => a.packId.localeCompare(b.packId));
}

async function writeImportedRegistryPacks(root: string, packs: Array<{ packId: string; registryPack: ReturnType<typeof catalogRecordsToRegistryPack> }>): Promise<void> {
  if (packs.length === 0) return;
  // Through the `registry` SLOT, not a `path.join(paths.dir, "registry")` composed here.
  // The write-path guard walks `LoombridgePaths` fields (W2); a destination composed off
  // `.dir` was only ever caught by W6, and before W6 existed it was caught by luck (a
  // nearby `console.error` happened to spell the path).
  const registryDir = loombridgePaths(root).registry;
  await fs.mkdir(registryDir, { recursive: true });
  for (const pack of packs) {
    const outputPath = path.join(registryDir, `${pack.packId}.json`);
    await fs.writeFile(outputPath, `${JSON.stringify(pack.registryPack, null, 2)}\n`, "utf-8");
    console.error(`[loombridge assets] imported pack ${pack.packId} -> .loombridge/registry/${pack.packId}.json (${pack.registryPack.entries.length} assets)`);
  }
}

function annotationsFromJson(value: unknown): GeneratedAssetAnnotation[] {
  const candidate = (value && typeof value === "object" && "annotations" in value)
    ? (value as { annotations?: unknown }).annotations
    : value;
  if (!Array.isArray(candidate)) throw new Error("--annotations must be a JSON array.");
  return candidate as GeneratedAssetAnnotation[];
}

function exportsFromJson(value: unknown): GeneratedAssetExportInput[] {
  const candidate = (value && typeof value === "object" && "exports" in value)
    ? (value as { exports?: unknown }).exports
    : value;
  if (!Array.isArray(candidate)) throw new Error("--exports must be a JSON array.");
  return candidate as GeneratedAssetExportInput[];
}

async function runRegistryPlan(parsed: ParsedArgs, options: RunAssetsOptions = {}): Promise<number> {
  const manifest = await readProjectManifest(parsed.root);
  const profile = await loadAssetProfile(requireOption(parsed.profilePath, "--profile"));
  const registry = await loadRegistryOrCatalog(parsed, profile.genre, options);
  const plan = buildRegistrySelectionPlan(manifest, registry, profile, {
    preferredLicense: parsed.preferredLicense,
  });
  await writeJsonOrStdout(parsed.outputPath, {
    plan,
    pickerSlots: buildAssetPickerSlotsFromRegistrySelectionPlan(plan),
  });
  console.error(`[loombridge assets] registry-plan slots=${plan.slots.length} issues=${plan.issues.length}`);
  return plan.issues.length === 0 ? 0 : 1;
}

async function runRegistryApply(parsed: ParsedArgs, options: RunAssetsOptions = {}): Promise<number> {
  const paths = loombridgePaths(parsed.root);
  const manifest = await readProjectManifest(parsed.root);
  const profile = await loadAssetProfile(requireOption(parsed.profilePath, "--profile"));
  if (parsed.selectionsPath && parsed.fromSelectionPath) {
    throw new Error("Use either --selections or --from-selection, not both.");
  }
  const webSelectionItems = parsed.fromSelectionPath
    ? webSelectionItemsFromJson(await readJson(parsed.fromSelectionPath))
    : undefined;

  const assetItems = webSelectionItems?.assets;
  const packItems = webSelectionItems?.packs ?? [];
  const shouldApplyAssetSelections = !parsed.fromSelectionPath || (assetItems !== undefined && assetItems.length > 0);
  const registry = shouldApplyAssetSelections
    ? await loadRegistryOrCatalog(
      parsed,
      profile.genre,
      options,
      parsed.catalogApiUrl && assetItems ? assetItems.map((item) => item.registryId) : undefined,
    )
    : undefined;
  const approved = shouldApplyAssetSelections
    ? applyRegistrySelectionsToManifest({
      manifest,
      registry: registry!,
      profile,
      selections: parsed.fromSelectionPath
        ? buildSelectionsFromWebSelection({
          manifest,
          registry: registry!,
          profile,
          items: assetItems!,
          preferredLicense: parsed.preferredLicense,
          strictRoles: parsed.strictRoles,
        })
        : selectionsFromJson(await readJson(requireOption(parsed.selectionsPath, "--selections or --from-selection"))),
      approvedAt: requireOption(parsed.approvedAt, "--approved-at"),
      preferredLicense: parsed.preferredLicense,
    })
    : undefined;
  const importedPacks = await buildImportedRegistryPacks({
    packs: packItems,
    catalogApiUrl: parsed.catalogApiUrl,
    catalogFetch: options.catalogFetch,
  });
  if (approved) {
    await writeAssetManifest(paths, approved);
  }
  await writeImportedRegistryPacks(parsed.root, importedPacks);
  const matched = approved
    ? approved.assets.filter((asset) => asset.source === "registry" && asset.status !== "needed").length
    : 0;
  console.error(
    `[loombridge assets] registry-apply status=${approved?.status ?? manifest.status}; ` +
      `matched=${matched} packs-imported=${importedPacks.length}`,
  );
  return 0;
}

async function runGeneratedPlan(parsed: ParsedArgs): Promise<number> {
  const manifest = await readProjectManifest(parsed.root);
  const annotations = annotationsFromJson(await readJson(requireOption(parsed.annotationsPath, "--annotations")));
  const plan = buildGeneratedAssetPlan(manifest, annotations, {
    producedFromHash: parsed.producedFromHash,
    generatedSetId: parsed.generatedSetId,
  });
  await writeJsonOrStdout(parsed.outputPath, plan);
  console.error(`[loombridge assets] generated-plan slots=${plan.slots.length} issues=${plan.issues.length}`);
  return plan.issues.length === 0 ? 0 : 1;
}

async function runGeneratedApply(parsed: ParsedArgs): Promise<number> {
  const paths = loombridgePaths(parsed.root);
  const manifest = await readProjectManifest(parsed.root);
  const annotations = annotationsFromJson(await readJson(requireOption(parsed.annotationsPath, "--annotations")));
  const exports = exportsFromJson(await readJson(requireOption(parsed.exportsPath, "--exports")));
  const approved = applyGeneratedAssetExportsToManifest({
    manifest,
    annotations,
    exports,
    producedFromHash: parsed.producedFromHash ?? manifest.heroShot.sha256,
    generatedSetId: parsed.generatedSetId,
    approvedAt: requireOption(parsed.approvedAt, "--approved-at"),
  });
  assertValidAssetManifest(approved);
  await writeAssetManifest(paths, approved);
  console.error(
    `[loombridge assets] generated-apply status=${approved.status}; ` +
      `${approved.assets.filter((asset) => asset.source === "generated" && asset.status !== "needed").length} generated assets resolved.`,
  );
  return 0;
}

/**
 * OSS seam: the pack-authoring verbs (`pack-ingest` / `cover-build` / `discover`) are implemented on
 * the PRIVATE side of the asset-layer split (the specifier below resolves, relative to this file,
 * to `src/capabilities/asset-authoring/assets-authoring-cli.ts`) because they drive hosted-registry
 * authoring (R2 publish plans, draft pack manifests, pack covers). The module specifier is
 * deliberately a `string`-typed constant, NOT a string-literal import, so this OPEN client entry
 * compiles with no reference to the private sources, and no bundler, `tsc`, or dependency walker
 * can follow an edge into them. In a build that omits the private directory, invoking one of these
 * verbs fails at runtime with a clear error; the consumer verbs (registry-plan/apply,
 * generated-plan/apply) are unaffected.
 *
 * The `: string` annotation is load-bearing, not decoration: without it TypeScript infers the
 * LITERAL type, and a literal-typed constant is exactly the shape a bundler or dependency walker
 * constant-folds back into a static edge into the private tree. Measured, so nobody has to guess:
 * removing the annotation does NOT fail `tsc --noEmit` today, which is precisely why it needs a
 * guard rather than a convention. `asset-registry-boundary.test.ts` walks both properties.
 */
const ASSET_AUTHORING_CLI_MODULE: string = "../asset-authoring/assets-authoring-cli.js";

interface AssetsAuthoringCliModule {
  runPackIngest(parsed: ParsedArgs, options?: RunAssetsOptions): Promise<number>;
  runDiscover(parsed: ParsedArgs): Promise<number>;
  runCoverBuild(parsed: ParsedArgs): Promise<number>;
}

/** Present: the private side is installed. Absent: an open build, with the reason to report. */
type AssetsAuthoringSeam =
  | { present: true; module: AssetsAuthoringCliModule }
  | { present: false; reason: string };

/**
 * The ONE mechanism that decides both what runs and what `--help` advertises. It reports absence
 * rather than throwing so the help path can ask the same question the dispatch path asks, instead
 * of a second hardcoded build flag that could drift out of agreement with reality.
 */
async function resolveAssetsAuthoringCli(): Promise<AssetsAuthoringSeam> {
  try {
    return { present: true, module: (await import(ASSET_AUTHORING_CLI_MODULE)) as AssetsAuthoringCliModule };
  } catch (error) {
    // Only the SEAM module itself being absent means "open build without the private side".
    // Anything else — a syntax error in it, or a missing TRANSITIVE module (e.g. a deleted
    // cover-build.js) — is a real defect and must surface undisguised.
    const code = (error as { code?: unknown } | null)?.code;
    const message = error instanceof Error ? error.message : String(error);
    // Node's message quotes the MISSING module ("Cannot find module '<path>' imported from ...");
    // a missing transitive dep quotes THAT dep and only names this module as the importer, so the
    // seam name must appear inside the quoted missing-module path itself.
    const seamModuleAbsent =
      code === "ERR_MODULE_NOT_FOUND" && /Cannot find module '[^']*assets-authoring-cli\.js'/.test(message);
    if (!seamModuleAbsent) throw error;
    return { present: false, reason: message };
  }
}

/**
 * Presence WITHOUT executing anything. `--help` is a pure, must-never-fail path: importing the
 * seam there ran PRIVATE top-level code on it, and `resolveAssetsAuthoringCli` deliberately
 * rethrows anything that is not the seam module itself being absent, so a private module with a
 * broken transitive import turned `assets --help` into a raw ERR_MODULE_NOT_FOUND stack and exit
 * 1. A file-existence check on the resolved specifier answers the only question help has to ask.
 */
export async function assetsAuthoringCliPresent(): Promise<boolean> {
  try {
    await fs.access(fileURLToPath(new URL(ASSET_AUTHORING_CLI_MODULE, import.meta.url)));
    return true;
  } catch {
    return false;
  }
}

async function loadAssetsAuthoringCli(): Promise<AssetsAuthoringCliModule> {
  const seam = await resolveAssetsAuthoringCli();
  if (seam.present) return seam.module;
  // Deliberately terse. The refusal used to print the resolver's own message, which quoted the
  // absolute path of the private module: more detail than the help text this branch removes.
  throw new Error(
    "The pack-authoring verbs require the private asset-authoring tooling, which is not present " +
      "in this build.",
  );
}

export async function run(args: string[], options: RunAssetsOptions = {}): Promise<number> {
  const parsed = parseArgs(args);
  if (parsed.help || !parsed.action) {
    printUsage(await assetsAuthoringCliPresent());
    return 0;
  }

  try {
    switch (parsed.action) {
      case "roles":
        return await runRoles(parsed);
      case "registry-plan":
        return await runRegistryPlan(parsed, options);
      case "registry-apply":
        return await runRegistryApply(parsed, options);
      case "generated-plan":
        return await runGeneratedPlan(parsed);
      case "generated-apply":
        return await runGeneratedApply(parsed);
      case "pack-ingest":
        return await (await loadAssetsAuthoringCli()).runPackIngest(parsed, options);
      case "cover-build":
        return await (await loadAssetsAuthoringCli()).runCoverBuild(parsed);
      case "discover":
        return await (await loadAssetsAuthoringCli()).runDiscover(parsed);
    }
  } catch (error) {
    console.error(`[loombridge assets] fatal: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
