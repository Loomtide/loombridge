#!/usr/bin/env node

/**
 * Mirror-free public-seed byte source.
 *
 * Regenerates the byte-derived metadata (sha256 checksum, sizeBytes,
 * technical.width/height) of every record in a public catalog shard by reading
 * the BUNDLED asset files committed in-repo — it never reaches for the private
 * non-public asset mirror.
 *
 * An external maintainer can drop fresh CC0 bytes (e.g. re-downloaded from
 * kenney.nl) into `--assets-dir` and re-run this to refresh the shard. The byte
 * location of each record is resolved from its own `files[0].localPath` (which
 * already points under the bundled assets tree), so no private path or network
 * access is required.
 *
 * The transform is deterministic: same bytes in, same shard out (stable key
 * ordering, no wall-clock / random values), so CI can prove idempotency by
 * diffing a regenerated shard against the committed one.
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { readImageMetadata } from "./image-metadata.js";
import { isMainModule as isMainModuleUrl } from "../../shared/main-module.js";

export interface RegeneratedFileMetadata {
  sizeBytes: number;
  width: number;
  height: number;
  checksum: { algorithm: "sha256"; value: string };
}

export interface RegeneratePublicSeedOptions {
  /** Absolute path to the JSONL shard whose records will be refreshed. */
  shardPath: string;
  /**
   * Repo-relative root the records' `localPath` resolves against. Defaults to
   * the repo root inferred from the shard path
   * (`asset-layer/catalog-public/<profile>/part-*.jsonl` → repo root).
   */
  repoRoot?: string;
  /**
   * Bundled assets directory. Records resolve their bytes via
   * `files[0].localPath` under `repoRoot`; when a record's `localPath` is
   * absent this is used as the lookup base. Default:
   * `<repoRoot>/asset-layer/catalog-public/assets`.
   */
  assetsDir?: string;
}

export interface RegeneratePublicSeedResult {
  /** The regenerated shard text (newline-terminated JSONL). */
  text: string;
  /** Per-record id → derived metadata, in shard order. */
  records: { id: string; file: RegeneratedFileMetadata }[];
}

type UnknownRecord = Record<string, unknown>;

function repoRootFromShard(shardPath: string): string {
  // <repoRoot>/asset-layer/catalog-public/<profile>/part-00000.jsonl
  return path.resolve(path.dirname(shardPath), "../../..");
}

async function deriveFileMetadata(filePath: string): Promise<RegeneratedFileMetadata> {
  const bytes = await fs.readFile(filePath);
  const metadata = await readImageMetadata(filePath);
  return {
    sizeBytes: bytes.byteLength,
    width: metadata.width,
    height: metadata.height,
    checksum: {
      algorithm: "sha256",
      value: crypto.createHash("sha256").update(bytes).digest("hex"),
    },
  };
}

function resolveLocalBytePath(
  record: UnknownRecord,
  repoRoot: string,
  assetsDir: string,
): string {
  const files = Array.isArray(record.files) ? (record.files as UnknownRecord[]) : [];
  const file = files[0];
  const localPath = file && typeof file.localPath === "string" ? file.localPath : undefined;
  if (localPath) {
    return path.resolve(repoRoot, localPath);
  }
  // Fall back to deriving the bundled byte from the public url tail under assetsDir.
  const url = file && typeof file.url === "string" ? file.url : undefined;
  if (url) {
    const tail = url.replace(/^https?:\/\/[^/]+\//, "");
    return path.resolve(assetsDir, tail);
  }
  throw new Error(`Record ${String(record.id)} has no localPath or url to resolve bundled bytes.`);
}

/**
 * Rewrite a single record's byte-derived fields in place against fresh bytes,
 * preserving every other field and the existing key order.
 */
function applyMetadata(record: UnknownRecord, meta: RegeneratedFileMetadata): void {
  const files = Array.isArray(record.files) ? (record.files as UnknownRecord[]) : [];
  const file = files[0];
  if (file) {
    file.sizeBytes = meta.sizeBytes;
    file.checksum = meta.checksum;
    if (typeof file.sha256 === "string") {
      file.sha256 = meta.checksum.value;
    }
  }
  const technical = (record.technical && typeof record.technical === "object")
    ? (record.technical as UnknownRecord)
    : (record.technical = {} as UnknownRecord);
  technical.width = meta.width;
  technical.height = meta.height;
}

export async function regeneratePublicSeed(
  options: RegeneratePublicSeedOptions,
): Promise<RegeneratePublicSeedResult> {
  const shardPath = path.resolve(options.shardPath);
  const repoRoot = path.resolve(options.repoRoot ?? repoRootFromShard(shardPath));
  const assetsDir = path.resolve(
    options.assetsDir ?? path.join(repoRoot, "asset-layer/catalog-public/assets"),
  );

  const raw = await fs.readFile(shardPath, "utf-8");
  const lines = raw.split("\n").filter((line) => line.trim().length > 0);

  const outLines: string[] = [];
  const records: RegeneratePublicSeedResult["records"] = [];

  for (const line of lines) {
    const record = JSON.parse(line) as UnknownRecord;
    const bytePath = resolveLocalBytePath(record, repoRoot, assetsDir);
    const meta = await deriveFileMetadata(bytePath);
    applyMetadata(record, meta);
    outLines.push(JSON.stringify(record));
    records.push({ id: String(record.id), file: meta });
  }

  return { text: `${outLines.join("\n")}\n`, records };
}

function parseArgs(argv: string[]): { shardPath?: string; assetsDir?: string; write: boolean; help: boolean } {
  const out: { shardPath?: string; assetsDir?: string; write: boolean; help: boolean } = { write: false, help: false };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "-h":
      case "--help":
        out.help = true;
        break;
      case "--shard":
        out.shardPath = path.resolve(process.cwd(), argv[++i] ?? "");
        break;
      case "--assets-dir":
        out.assetsDir = path.resolve(process.cwd(), argv[++i] ?? "");
        break;
      case "--write":
        out.write = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return out;
}

async function run(): Promise<number> {
  const args = parseArgs(process.argv);
  if (args.help || !args.shardPath) {
    console.log(
      "Usage: node dist/capabilities/assets/public-seed-source.js --shard <jsonl> [--assets-dir <dir>] [--write]\n" +
        "  Regenerates byte-derived metadata (sha256, sizeBytes, technical.width/height)\n" +
        "  for each record from the BUNDLED assets — no private mirror, no network.\n" +
        "  Without --write it prints the regenerated shard to stdout (diff against the committed file).",
    );
    return args.help || !args.shardPath ? 0 : 1;
  }

  const result = await regeneratePublicSeed({ shardPath: args.shardPath, assetsDir: args.assetsDir });
  if (args.write) {
    await fs.writeFile(args.shardPath, result.text, "utf-8");
    console.error(`[public-seed-source] wrote ${result.records.length} record(s) to ${args.shardPath}`);
  } else {
    process.stdout.write(result.text);
  }
  return 0;
}

const isMainModule = isMainModuleUrl(import.meta.url);
if (isMainModule) {
  run().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    console.error(`[public-seed-source] fatal: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
