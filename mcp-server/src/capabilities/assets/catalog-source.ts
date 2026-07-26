import fs from "node:fs/promises";
import path from "node:path";
import {
  catalogRecordToRegistryEntry,
  normalizeCatalogRecord,
  parseCatalogJsonl,
  validateCatalogRecord,
} from "./catalog.js";
import { fetchAuthOptionsForUrl, type FetchAuthOptions } from "./http-auth.js";
import { validatePublicCatalogRecord } from "./public-catalog-validation.js";
import { trustTierForEntry } from "./trust.js";
import type {
  AssetCatalogQueryOptions,
  AssetCatalogRecord,
  AssetRegistryEntry,
  AssetRegistryPack,
} from "./types.js";

/**
 * There is deliberately NO built-in default catalog URL. The historical default pointed at a
 * private GitHub mirror that 404s for anyone outside the Loombridge org, so a fresh install would
 * silently fail. Until a stable public catalog endpoint ships (see
 * `Docs/Assets/PublicCatalogQuickstart.md`), callers must set `LOOMBRIDGE_ASSET_CATALOG_URL`
 * (or pass an explicit `--catalog` / `--catalog-api` URL).
 */
export const ASSET_CATALOG_URL_ENV_VAR = "LOOMBRIDGE_ASSET_CATALOG_URL";

export interface CatalogSource {
  load(): Promise<AssetCatalogRecord[]>;
  query(options: AssetCatalogQueryOptions): Promise<AssetCatalogRecord[]>;
}

export interface CatalogFetchResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export type CatalogFetch = (url: string, init?: FetchAuthOptions) => Promise<CatalogFetchResponse>;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function includesText(record: AssetCatalogRecord, text: string | undefined): boolean {
  if (!text || text.trim().length === 0) {
    return true;
  }

  const needle = text.toLowerCase();
  const haystack = [
    record.id,
    record.genre,
    record.primitive,
    record.kind,
    record.category,
    record.source.title,
    record.source.author,
    record.provider.name,
    record.license.spdx,
    ...record.tags,
  ]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();

  return haystack.includes(needle);
}

function hasAllTags(record: AssetCatalogRecord, tags: string[] | undefined): boolean {
  if (!tags || tags.length === 0) {
    return true;
  }

  const recordTags = new Set(record.tags.map((tag) => tag.toLowerCase()));
  return tags.every((tag) => recordTags.has(tag.toLowerCase()));
}

function priorityOf(record: AssetCatalogRecord): number {
  return record.priority ?? 0;
}

function verifiedScore(record: AssetCatalogRecord): number {
  return record.review.status === "verified" ? 1 : 0;
}

function preferredLicenseScore(record: AssetCatalogRecord, preferredLicense: string | undefined): number {
  if (!preferredLicense) {
    return record.license.spdx === "CC0-1.0" ? 1 : 0;
  }
  return record.license.spdx === preferredLicense ? 1 : 0;
}

export function sortCatalogCandidates(
  a: AssetCatalogRecord,
  b: AssetCatalogRecord,
  preferredLicense?: string,
): number {
  const aVerified = verifiedScore(a);
  const bVerified = verifiedScore(b);
  if (aVerified !== bVerified) {
    return bVerified - aVerified;
  }

  const aLicense = preferredLicenseScore(a, preferredLicense);
  const bLicense = preferredLicenseScore(b, preferredLicense);
  if (aLicense !== bLicense) {
    return bLicense - aLicense;
  }

  if (priorityOf(a) !== priorityOf(b)) {
    return priorityOf(b) - priorityOf(a);
  }

  return a.id.localeCompare(b.id);
}

export function queryCatalogRecords(
  records: AssetCatalogRecord[],
  options: AssetCatalogQueryOptions,
): AssetCatalogRecord[] {
  const primitives = new Set([
    ...(options.primitives ?? []),
    ...(options.primitive ? [options.primitive] : []),
  ]);

  return records
    .filter((record) => !options.genre || record.genre === options.genre || record.genre === "game-asset")
    .filter((record) => primitives.size === 0 || primitives.has(record.primitive))
    .filter((record) => !options.kind || record.kind === options.kind)
    .filter((record) => hasAllTags(record, options.tags))
    .filter((record) => !options.license || record.license.spdx === options.license)
    .filter((record) => !options.provider || record.provider.name.toLowerCase() === options.provider.toLowerCase())
    .filter((record) => !options.verificationStatus || record.review.status === options.verificationStatus)
    .filter((record) => includesText(record, options.text))
    .sort((a, b) => sortCatalogCandidates(a, b, options.preferredLicense));
}

function normalizeCatalogInput(raw: unknown): AssetCatalogRecord[] {
  if (Array.isArray(raw)) {
    return raw.map(normalizeCatalogRecord);
  }

  if (isObject(raw) && Array.isArray(raw.assets)) {
    return raw.assets.map((asset) => normalizeCatalogRecord(asset));
  }

  if (isObject(raw) && Array.isArray(raw.entries)) {
    const pack = raw as unknown as AssetRegistryPack;
    return pack.entries.map((entry) => normalizeCatalogRecord(entry));
  }

  if (isObject(raw)) {
    return [normalizeCatalogRecord(raw)];
  }

  throw new Error("Unsupported catalog payload.");
}

function validateLoadedRecords(records: AssetCatalogRecord[]): AssetCatalogRecord[] {
  const accepted: AssetCatalogRecord[] = [];
  const rejected = records.flatMap((record, index) => {
    const validation = validateCatalogRecord(record, `assets[${index}]`);
    if (validation.status === "accepted") {
      accepted.push(record);
      return [];
    }
    const unsupportedInventoryOnly = validation.issues.length > 0 && validation.issues.every((issue) =>
      issue.code === "INVALID_FILE" && /\.files\[\d+\]\.format$/.test(issue.path)
    );
    if (unsupportedInventoryOnly) {
      return [];
    }
    return validation.issues;
  });

  if (rejected.length > 0) {
    const first = rejected[0]!;
    throw new Error(`Invalid catalog record at ${first.path}: ${first.message}`);
  }

  return accepted;
}

export interface CatalogSourceOptions {
  /**
   * Opt-in PUBLIC-catalog policy gate. When true, after the normal load +
   * validateLoadedRecords, every record is run through validatePublicCatalogRecord and the
   * load THROWS (listing offending record ids + issue codes) if any record fails. When
   * false/absent the gate does NOT run — hosted (non-public) catalogs with
   * attribution/unverified records and mirror refs still load unchanged.
   */
  enforcePublicPolicy?: boolean;
}

/**
 * Enforce the public-catalog policy gate on loaded records (opt-in via enforcePublicPolicy).
 * Throws a single clear error listing every offending record id + its issue codes.
 */
function enforcePublicCatalogPolicy(records: AssetCatalogRecord[]): AssetCatalogRecord[] {
  const failures = records
    .map((record, index) => ({ record, index, result: validatePublicCatalogRecord(record, `assets[${index}]`) }))
    .filter((entry) => entry.result.status === "rejected");

  if (failures.length > 0) {
    const detail = failures
      .map(({ record, index, result }) => {
        const id = record.id ?? `assets[${index}]`;
        const codes = Array.from(new Set(result.issues.map((issue) => issue.code))).join(", ");
        return `${id} (${codes})`;
      })
      .join("; ");
    throw new Error(`Public catalog policy gate rejected ${failures.length} record(s): ${detail}`);
  }

  return records;
}

async function readCatalogFile(filePath: string): Promise<AssetCatalogRecord[]> {
  const raw = await fs.readFile(filePath, "utf-8");
  if (filePath.endsWith(".jsonl")) {
    return parseCatalogJsonl(raw);
  }
  return normalizeCatalogInput(JSON.parse(raw));
}

async function readLocalCatalog(pathOrDirectory: string): Promise<AssetCatalogRecord[]> {
  const stat = await fs.stat(pathOrDirectory);
  if (!stat.isDirectory()) {
    return readCatalogFile(pathOrDirectory);
  }

  const files = (await fs.readdir(pathOrDirectory))
    .filter((file) => file.endsWith(".json") || file.endsWith(".jsonl"))
    .sort();
  const records = await Promise.all(files.map((file) => readCatalogFile(path.join(pathOrDirectory, file))));
  return records.flat();
}

export class LocalCatalogSource implements CatalogSource {
  constructor(
    private readonly pathOrDirectory: string,
    private readonly options: CatalogSourceOptions = {},
  ) {}

  async load(): Promise<AssetCatalogRecord[]> {
    const records = validateLoadedRecords(await readLocalCatalog(this.pathOrDirectory));
    return this.options.enforcePublicPolicy ? enforcePublicCatalogPolicy(records) : records;
  }

  async query(options: AssetCatalogQueryOptions): Promise<AssetCatalogRecord[]> {
    return queryCatalogRecords(await this.load(), options);
  }
}

async function fetchText(fetcher: CatalogFetch, url: string, token?: string): Promise<string> {
  const response = await fetcher(url, fetchAuthOptionsForUrl(url, token));
  if (!response.ok) {
    throw new Error(`Catalog fetch failed for ${url}: HTTP ${response.status}`);
  }
  return response.text();
}

async function fetchOptionalText(fetcher: CatalogFetch, url: string, token?: string): Promise<string | undefined> {
  const response = await fetcher(url, fetchAuthOptionsForUrl(url, token));
  if (response.status === 404) {
    return undefined;
  }
  if (!response.ok) {
    throw new Error(`Catalog fetch failed for ${url}: HTTP ${response.status}`);
  }
  return response.text();
}

function isCatalogFileUrl(url: string): boolean {
  const pathname = (() => {
    try {
      return new URL(url).pathname;
    } catch {
      return url;
    }
  })();
  return pathname.endsWith(".json") || pathname.endsWith(".jsonl");
}

function shardUrl(baseUrl: string, index: number, width: number): string {
  return `${baseUrl.replace(/\/+$/, "")}/part-${String(index).padStart(width, "0")}.jsonl`;
}

const SHARD_GAP_PROBE_WINDOW = 8;

async function fetchCatalogDirectoryPattern(
  fetcher: CatalogFetch,
  url: string,
  token: string | undefined,
  options: { startIndex: number; width: number },
): Promise<AssetCatalogRecord[]> {
  const records: AssetCatalogRecord[] = [];
  for (let offset = 0; offset <= 1000; offset += 1) {
    const partUrl = shardUrl(url, options.startIndex + offset, options.width);
    const raw = await fetchOptionalText(fetcher, partUrl, token);
    if (raw === undefined) {
      if (records.length > 0) {
        for (let probe = 1; probe <= SHARD_GAP_PROBE_WINDOW; probe += 1) {
          const nextPartUrl = shardUrl(url, options.startIndex + offset + probe, options.width);
          const nextRaw = await fetchOptionalText(fetcher, nextPartUrl, token);
          if (nextRaw !== undefined) {
            throw new Error(`Catalog shard sequence is non-contiguous: missing ${partUrl} but found ${nextPartUrl}.`);
          }
        }
      }
      break;
    }
    records.push(...parseCatalogJsonl(raw));
  }
  return records;
}

async function fetchCatalogDirectory(fetcher: CatalogFetch, url: string, token?: string): Promise<AssetCatalogRecord[]> {
  const zeroBasedRecords = await fetchCatalogDirectoryPattern(fetcher, url, token, { startIndex: 0, width: 5 });
  if (zeroBasedRecords.length > 0) {
    return zeroBasedRecords;
  }

  const oneBasedRecords = await fetchCatalogDirectoryPattern(fetcher, url, token, { startIndex: 1, width: 4 });
  if (oneBasedRecords.length > 0) {
    return oneBasedRecords;
  }

  throw new Error(`Catalog fetch failed for ${shardUrl(url, 0, 5)}: HTTP 404`);
}

export class HttpCatalogSource implements CatalogSource {
  constructor(
    private readonly url: string,
    private readonly fetcher: CatalogFetch = globalThis.fetch as unknown as CatalogFetch,
    private readonly authToken?: string,
    private readonly options: CatalogSourceOptions = {},
  ) {}

  async load(): Promise<AssetCatalogRecord[]> {
    const records = isCatalogFileUrl(this.url)
      ? await (async () => {
        const raw = await fetchText(this.fetcher, this.url, this.authToken);
        return this.url.endsWith(".jsonl")
          ? parseCatalogJsonl(raw)
          : normalizeCatalogInput(JSON.parse(raw));
      })()
      : await fetchCatalogDirectory(this.fetcher, this.url, this.authToken);
    const validated = validateLoadedRecords(records);
    return this.options.enforcePublicPolicy ? enforcePublicCatalogPolicy(validated) : validated;
  }

  async query(options: AssetCatalogQueryOptions): Promise<AssetCatalogRecord[]> {
    return queryCatalogRecords(await this.load(), options);
  }
}

/**
 * Source-agnostic client for a read-only DB-backed search API (Phase B). It calls the
 * `/v1/assets/search` endpoint and maps the JSON response into the SAME `AssetCatalogRecord[]`
 * shape the shard path produces, so downstream code does not care whether records came from a
 * static JSONL shard directory or from Postgres-backed search.
 *
 * SECURITY: the client RE-VALIDATES every record the API returns through the exact same
 * `normalizeCatalogRecord` + `validateLoadedRecords` path used for shards. It never trusts the
 * API's asserted `trustTier` / `review` — trust is always re-derived locally (see
 * `trustTierForEntry` in select/prepare).
 */
export class ApiCatalogSource implements CatalogSource {
  constructor(
    private readonly baseUrl: string,
    private readonly fetcher: CatalogFetch = globalThis.fetch as unknown as CatalogFetch,
    private readonly authToken?: string,
  ) {}

  private searchUrl(options: AssetCatalogQueryOptions): string {
    const base = `${this.baseUrl.replace(/\/+$/, "")}/v1/assets/search`;
    const params = new URLSearchParams();
    const primitive = options.primitive
      ?? (options.primitives && options.primitives.length > 0 ? options.primitives[0] : undefined);
    if (options.genre) {
      params.set("profile", options.genre);
    }
    if (primitive) {
      params.set("primitive", primitive);
    }
    if (options.kind) {
      params.set("kind", options.kind);
    }
    if (options.tags && options.tags.length > 0) {
      params.set("tags", options.tags.join(","));
    }
    if (options.text && options.text.trim().length > 0) {
      params.set("text", options.text);
    }
    const queryString = params.toString();
    return queryString.length > 0 ? `${base}?${queryString}` : base;
  }

  private parseSearchResponse(raw: string): AssetCatalogRecord[] {
    const parsed: unknown = JSON.parse(raw);
    const list = isObject(parsed) && Array.isArray(parsed.records)
      ? parsed.records
      : isObject(parsed) && Array.isArray(parsed.assets)
        ? parsed.assets
        : undefined;
    if (!list) {
      throw new Error("Unsupported search response: expected { records: [...] } or { assets: [...] }.");
    }
    // RE-VALIDATE what the API returns — never trust the API's records blindly. Each record is
    // normalized and run through the same validation gate as a shard-loaded record.
    return validateLoadedRecords(list.map((record) => normalizeCatalogRecord(record)));
  }

  private parseAssetResponse(raw: string): AssetCatalogRecord {
    const parsed: unknown = JSON.parse(raw);
    const record = isObject(parsed) && isObject(parsed.record)
      ? parsed.record
      : isObject(parsed) && isObject(parsed.asset)
        ? parsed.asset
        : parsed;
    return validateLoadedRecords([normalizeCatalogRecord(record)])[0]!;
  }

  private packAssetsUrl(packId: string, limit: number, offset: number): string {
    const base = `${this.baseUrl.replace(/\/+$/, "")}/v1/packs/${encodeURIComponent(packId)}/assets`;
    const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
    return `${base}?${params.toString()}`;
  }

  private parsePackAssetsResponse(raw: string): { records: AssetCatalogRecord[]; total?: number } {
    const parsed: unknown = JSON.parse(raw);
    const list = isObject(parsed) && Array.isArray(parsed.records)
      ? parsed.records
      : isObject(parsed) && Array.isArray(parsed.assets)
        ? parsed.assets
        : undefined;
    if (!list) {
      throw new Error("Unsupported pack assets response: expected { records: [...] } or { assets: [...] }.");
    }
    const total = isObject(parsed) && typeof parsed.total === "number" && Number.isFinite(parsed.total)
      ? parsed.total
      : undefined;
    return {
      records: validateLoadedRecords(list.map((record) => normalizeCatalogRecord(record))),
      ...(total !== undefined ? { total } : {}),
    };
  }

  async getById(id: string): Promise<AssetCatalogRecord | null> {
    const url = `${this.baseUrl.replace(/\/+$/, "")}/v1/assets/${encodeURIComponent(id)}`;
    const response = await this.fetcher(url, fetchAuthOptionsForUrl(url, this.authToken));
    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      throw new Error(`Catalog fetch failed for ${url}: HTTP ${response.status}`);
    }
    return this.parseAssetResponse(await response.text());
  }

  async getPackAssets(packId: string, pageSize = 500): Promise<AssetCatalogRecord[]> {
    const records: AssetCatalogRecord[] = [];
    let total: number | undefined;
    for (let offset = 0; ; offset += pageSize) {
      const url = this.packAssetsUrl(packId, pageSize, offset);
      const response = await this.fetcher(url, fetchAuthOptionsForUrl(url, this.authToken));
      if (response.status === 404) {
        throw new Error(`Catalog pack '${packId}' not found at ${url}.`);
      }
      if (!response.ok) {
        throw new Error(`Catalog fetch failed for ${url}: HTTP ${response.status}`);
      }
      const page = this.parsePackAssetsResponse(await response.text());
      records.push(...page.records);
      total = page.total ?? total;
      if (total !== undefined) {
        if (records.length >= total) {
          break;
        }
        if (page.records.length < pageSize) {
          throw new Error(`Catalog pack '${packId}' returned only ${records.length}/${total} records.`);
        }
        continue;
      }
      if (page.records.length < pageSize) break;
    }
    return records.slice(0, total ?? records.length);
  }

  async query(options: AssetCatalogQueryOptions): Promise<AssetCatalogRecord[]> {
    const raw = await fetchText(this.fetcher, this.searchUrl(options), this.authToken);
    return this.parseSearchResponse(raw);
  }

  async load(): Promise<AssetCatalogRecord[]> {
    return this.query({});
  }
}

/**
 * Resolve the catalog URL from the environment. REFUSES (throws) when
 * `LOOMBRIDGE_ASSET_CATALOG_URL` is unset instead of falling back to a private mirror —
 * a clear error beats a default that 404s for every external developer.
 */
export function catalogUrlFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const url = env[ASSET_CATALOG_URL_ENV_VAR];
  if (!url) {
    throw new Error(
      `No asset catalog URL configured: set ${ASSET_CATALOG_URL_ENV_VAR} (or pass an explicit --catalog / --catalog-api URL). ` +
        "See Docs/Assets/PublicCatalogQuickstart.md for public catalog options.",
    );
  }
  return url;
}

export async function selectAssetsFromCatalog(
  source: CatalogSource,
  options: Required<Pick<AssetCatalogQueryOptions, "genre">> & AssetCatalogQueryOptions,
): Promise<AssetRegistryEntry[]> {
  const records = await source.query({
    ...options,
    verificationStatus: options.verificationStatus ?? "verified",
  });
  const requestedPrimitives = options.primitives && options.primitives.length > 0
    ? options.primitives
    : Array.from(new Set(records.map((record) => record.primitive)));

  return requestedPrimitives.flatMap((primitive) => {
    // Trust-boundary gate: only auto-select a record whose LOCALLY-DERIVED trust tier is
    // trusted-default. The catalog's asserted trustTier is re-derived (and may only be made
    // more restrictive) by trustTierForEntry — never trust the catalog's asserted tier. We do
    // NOT fall back to lower tiers (attribution-required / unverified-discovery require explicit
    // approval, not auto-selection).
    const candidate = records.find((record) => {
      if (record.primitive !== primitive) {
        return false;
      }
      return trustTierForEntry(catalogRecordToRegistryEntry(record)) === "trusted-default";
    });
    return candidate ? [catalogRecordToRegistryEntry(candidate)] : [];
  });
}

export function catalogRecordsToRegistryPack(
  records: AssetCatalogRecord[],
  fallback: { packId: string; name: string; description?: string },
): AssetRegistryPack {
  const firstPack = records.find((record) => record.pack)?.pack;
  return {
    schemaVersion: "1",
    packId: firstPack?.packId ?? fallback.packId,
    name: firstPack?.name ?? fallback.name,
    ...(fallback.description ? { description: fallback.description } : {}),
    entries: records.map(catalogRecordToRegistryEntry),
  };
}
