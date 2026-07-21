/**
 * Dependency-free reader for the gzipped tarballs `npm pack` produces.
 *
 * We do NOT shell out to `tar`. Inside Git Bash — the shell the installer mandates on
 * Windows — `tar` resolves to GNU tar, which treats the drive-letter colon in a native
 * path (`C:\Users\...`) as a remote `host:file` spec and tries to network-resolve a host
 * named `C`. bsdtar (System32) has no such behaviour, so the failure is invisible from
 * cmd.exe/PowerShell and only bites the documented install path.
 */

import { gunzipSync } from "node:zlib";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const BLOCK = 512;

export interface TarEntry {
  path: string;
  type: "file" | "directory" | "other";
  data: Buffer;
}

/** Parse a tar numeric field: octal by default, GNU base-256 when the high bit is set. */
function readNumeric(header: Buffer, offset: number, length: number): number {
  const field = header.subarray(offset, offset + length);
  if (field.length > 0 && (field[0] as number) & 0x80) {
    let value = 0;
    for (let i = 1; i < field.length; i += 1) value = value * 256 + (field[i] as number);
    return value;
  }
  const text = field.toString("ascii").replace(/\0.*$/, "").trim();
  if (text.length === 0) return 0;
  const parsed = Number.parseInt(text, 8);
  return Number.isFinite(parsed) ? parsed : 0;
}

function readString(header: Buffer, offset: number, length: number): string {
  return header.subarray(offset, offset + length).toString("utf8").replace(/\0.*$/, "");
}

/** Pull the `path=` override out of a PAX extended header's record stream. */
function paxPath(data: Buffer): string | null {
  let cursor = 0;
  const text = data.toString("utf8");
  while (cursor < text.length) {
    const space = text.indexOf(" ", cursor);
    if (space < 0) break;
    const length = Number.parseInt(text.slice(cursor, space), 10);
    if (!Number.isFinite(length) || length <= 0) break;
    const record = text.slice(space + 1, cursor + length).replace(/\n$/, "");
    const eq = record.indexOf("=");
    if (eq > 0 && record.slice(0, eq) === "path") return record.slice(eq + 1);
    cursor += length;
  }
  return null;
}

/** Read every entry out of a `.tgz`, resolving PAX / GNU long-name headers. */
export function readTarball(tgz: string): TarEntry[] {
  const buf = gunzipSync(readFileSync(tgz));
  const entries: TarEntry[] = [];

  // Set by a preceding 'x' (PAX) or 'L' (GNU long name) header; applies to the next entry.
  let pendingPath: string | null = null;
  let offset = 0;

  while (offset + BLOCK <= buf.length) {
    const header = buf.subarray(offset, offset + BLOCK);
    // Two consecutive zero blocks terminate the archive; one is enough to stop here.
    if (header.every((byte) => byte === 0)) break;

    const size = readNumeric(header, 124, 12);
    const typeflag = String.fromCharCode(header[156] as number);
    const dataStart = offset + BLOCK;
    const data = buf.subarray(dataStart, dataStart + size);
    offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;

    if (typeflag === "x" || typeflag === "X") {
      pendingPath = paxPath(data) ?? pendingPath;
      continue;
    }
    if (typeflag === "L") {
      pendingPath = data.toString("utf8").replace(/\0.*$/, "");
      continue;
    }
    // Global PAX headers ('g') carry no per-entry path; ignore them outright.
    if (typeflag === "g") continue;

    const prefix = readString(header, 345, 155);
    const name = readString(header, 0, 100);
    const entryPath = pendingPath ?? (prefix ? `${prefix}/${name}` : name);
    pendingPath = null;
    if (entryPath.length === 0) continue;

    const type = typeflag === "5" ? "directory" : typeflag === "0" || typeflag === "\0" ? "file" : "other";
    entries.push({ path: entryPath, type, data: Buffer.from(data) });
  }

  return entries;
}

/** Read a single file out of a `.tgz`, or null when it is absent. */
export function readTarballFile(tgz: string, entryPath: string): Buffer | null {
  const wanted = entryPath.replace(/\\/g, "/");
  for (const entry of readTarball(tgz)) {
    if (entry.type === "file" && entry.path.replace(/\\/g, "/") === wanted) return entry.data;
  }
  return null;
}

/** Extract a `.tgz` into `destDir`, mirroring `tar -xzf <tgz> -C <destDir>`. */
export function extractTarball(tgz: string, destDir: string): void {
  const root = path.resolve(destDir);
  mkdirSync(root, { recursive: true });

  for (const entry of readTarball(tgz)) {
    if (entry.type === "other") continue;

    // Refuse `../` and absolute members rather than writing outside the destination.
    const target = path.resolve(root, entry.path);
    if (target !== root && !target.startsWith(root + path.sep)) {
      throw new Error(`refusing to extract outside ${root}: ${entry.path}`);
    }

    if (entry.type === "directory") {
      mkdirSync(target, { recursive: true });
      continue;
    }
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, entry.data);
  }
}
