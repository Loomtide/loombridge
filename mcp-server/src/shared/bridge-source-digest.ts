/**
 * The ONE implementation of the bridge source digest.
 *
 * `scripts/loombridge-pack-bridge.sh` shells to the built copy of this module
 * (`node dist/shared/bridge-source-digest.js <srcDir>` prints `v1:<hex>`) and embeds the
 * result inside the tarball it writes; the freshness check imports the same module and
 * recomputes it against the sources on disk. One implementation means the producer and
 * the consumer cannot drift: a second, bash-side reimplementation would have been a
 * silent-divergence surface exactly like the staleness class this whole guard closes.
 *
 * WHY A SOURCE DIGEST AND NOT THE TARBALL SHA: tar is not byte-deterministic across
 * platforms (BSD tar takes a different branch in the pack script, mtimes and ordering
 * differ), so hashing the .tgz can only answer "was this file altered", never "does this
 * bundle correspond to the sources this CLI ships". The existing `.tgz.sha256` sidecar
 * answers the first question and was therefore blind to a bundle that had outlived
 * dozens of commits.
 *
 * THE DIGEST: sha256 over a manifest of `<sha256 of file bytes>  <relative posix path>`
 * lines, sorted by path as raw bytes (the same ordering `LC_ALL=C sort` gives the pack
 * script's tar step). Paths participate, so a rename or an added/removed file changes the
 * digest even when the file bytes are unchanged.
 *
 * Layer note: this lives in `shared/` (leaf helpers, no domain vocabulary) rather than in
 * `scripts/`, because npm does not publish `scripts/` and the freshness check has to run
 * from an installed CLI.
 */

import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * The digest format marker. An UNKNOWN prefix is its own refusal state in the freshness
 * check: a digest this CLI cannot interpret must never be read as "stale" (which suggests
 * "re-pack") nor as "fresh". Bump this only when the manifest construction changes.
 */
export const BRIDGE_DIGEST_PREFIX = "v1:";

/**
 * The record embedded inside the packed tarball, at `package/<this name>`. A leading dot
 * keeps it out of Unity's asset pipeline (hidden files are not imported, so it needs no
 * `.meta` sibling).
 */
export const BRIDGE_DIGEST_ENTRY_NAME = ".loombridge-source-digest";

/**
 * Names pruned from the staged package tree by `scripts/loombridge-pack-bridge.sh` (its
 * `find ... -exec rm -rf` list), matched on the BASENAME at any depth exactly as `find
 * -name` does. The digest must apply the identical exclusions or every pack on a macOS
 * machine that had opened the folder in Finder would read back as stale.
 *
 * `BRIDGE_DIGEST_ENTRY_NAME` is excluded too: the digest can never cover itself, and a
 * copy accidentally left in a source tree must not be able to poison later digests.
 */
export const BRIDGE_DIGEST_EXCLUDED_NAMES: readonly string[] = [
  ".DS_Store",
  "Thumbs.db",
  ".git",
  ".gitkeep",
  BRIDGE_DIGEST_ENTRY_NAME,
];

const EXCLUDED = new Set(BRIDGE_DIGEST_EXCLUDED_NAMES);

/** Collect `<relative posix path>` for every regular file under `dir`, exclusions applied. */
function collectFiles(dir: string, prefix: string, out: string[]): void {
  // withFileTypes so a symlink is neither isFile() nor isDirectory(): symlinks are skipped
  // deliberately. `cp -R` in the pack script copies them as links, and their target bytes
  // are not part of this package tree, so hashing what they point at would make the digest
  // depend on state outside the tree.
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (EXCLUDED.has(entry.name)) continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) collectFiles(path.join(dir, entry.name), rel, out);
    else if (entry.isFile()) out.push(rel);
  }
}

/**
 * The digest of a UPM source package tree: `v1:<hex>`.
 *
 * Throws (ENOENT etc.) when `srcDir` cannot be walked. Callers that must not crash are
 * responsible for catching, and for reporting the failure as its own FAILED state rather
 * than skipping the check.
 */
export function computeBridgeSourceDigest(srcDir: string): string {
  const root = path.resolve(srcDir);
  const files: string[] = [];
  collectFiles(root, "", files);
  // Byte ordering, not locale ordering: `LC_ALL=C sort` is what the pack script uses, and
  // JS's default sort compares UTF-16 code units, which differs for astral-plane names.
  files.sort((a, b) => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8")));

  const manifest = createHash("sha256");
  for (const rel of files) {
    const fileSha = createHash("sha256").update(readFileSync(path.join(root, rel))).digest("hex");
    manifest.update(`${fileSha}  ${rel}\n`);
  }
  return `${BRIDGE_DIGEST_PREFIX}${manifest.digest("hex")}`;
}

/** Is this a digest string whose format this CLI understands? */
export function isKnownBridgeDigest(value: string): boolean {
  return value.startsWith(BRIDGE_DIGEST_PREFIX) && value.length > BRIDGE_DIGEST_PREFIX.length;
}

// --- CLI entry (the pack script's producer) --------------------------------
// `node dist/shared/bridge-source-digest.js <srcDir>` prints the digest on stdout.
// Declared in scripts/loombridge-pack-bridge.sh as DIGEST_BUILDER_REL and walked by
// package-entrypoints.test.ts, because a declared path nothing imports is invisible to a
// green suite (that is the failure class this repo pays for most often).
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const srcDir = process.argv[2];
  if (!srcDir) {
    console.error(`Usage: node ${path.basename(fileURLToPath(import.meta.url))} <source-package-dir>`);
    process.exit(2);
  }
  try {
    process.stdout.write(`${computeBridgeSourceDigest(srcDir)}\n`);
  } catch (error) {
    console.error(`bridge-source-digest: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
