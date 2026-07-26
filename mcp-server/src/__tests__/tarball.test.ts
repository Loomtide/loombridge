import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { gzipSync } from "node:zlib";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { readTarball, readTarballFile, extractTarball } from "../capabilities/setup/tarball.js";

/**
 * Fixtures are produced by the SYSTEM tar, not by a writer of our own, so the reader is
 * checked against an independent implementation. Everything runs with `cwd` set to the
 * temp dir and relative member paths — an absolute Win32 path would trip GNU tar's
 * `host:file` parsing, which is the very bug this module exists to avoid.
 */
function buildFixture(format: "gnu" | "pax"): { tgz: string; dir: string } | null {
  const dir = mkdtempSync(path.join(tmpdir(), "loombridge-tarball-test-"));
  mkdirSync(path.join(dir, "package", "Runtime"), { recursive: true });
  writeFileSync(path.join(dir, "package", "package.json"), JSON.stringify({ name: "pkg", version: "1.2.3" }));
  writeFileSync(path.join(dir, "package", "Runtime", "Nested.cs"), "// nested\n");

  const tgz = path.join(dir, "fixture.tgz");
  try {
    execFileSync("tar", ["--format", format, "-czf", "fixture.tgz", "package"], { cwd: dir, stdio: "pipe" });
  } catch {
    rmSync(dir, { recursive: true, force: true });
    return null; // system tar missing or refuses this format — nothing to assert against
  }
  return { tgz, dir };
}

for (const format of ["gnu", "pax"] as const) {
  test(`readTarballFile reads package.json from a ${format}-format tarball`, () => {
    const fixture = buildFixture(format);
    if (!fixture) return; // no usable system tar
    try {
      const raw = readTarballFile(fixture.tgz, "package/package.json");
      assert.ok(raw, "expected package/package.json to be found");
      assert.equal(JSON.parse(raw.toString("utf8")).version, "1.2.3");
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test(`extractTarball round-trips a ${format}-format tarball`, () => {
    const fixture = buildFixture(format);
    if (!fixture) return;
    const dest = mkdtempSync(path.join(tmpdir(), "loombridge-tarball-out-"));
    try {
      extractTarball(fixture.tgz, dest);
      assert.ok(existsSync(path.join(dest, "package", "package.json")));
      assert.equal(readFileSync(path.join(dest, "package", "Runtime", "Nested.cs"), "utf8"), "// nested\n");
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
      rmSync(dest, { recursive: true, force: true });
    }
  });
}

test("readTarballFile returns null for an absent entry", () => {
  const fixture = buildFixture("gnu");
  if (!fixture) return;
  try {
    assert.equal(readTarballFile(fixture.tgz, "package/nope.json"), null);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

// --- hand-built archives, for cases the system tar will not produce on demand ---

/** Emit one 512-byte ustar header with a valid checksum. */
function ustarHeader(name: string, size: number, typeflag: string): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write("0000644\0", 100, 8, "ascii");
  header.write("0000000\0", 108, 8, "ascii");
  header.write("0000000\0", 116, 8, "ascii");
  header.write(`${size.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
  header.write("00000000000\0", 136, 12, "ascii");
  header.write("        ", 148, 8, "ascii"); // checksum placeholder: spaces
  header.write(typeflag, 156, 1, "ascii");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");

  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return header;
}

function tarball(entries: Array<{ name: string; body: string; typeflag?: string }>): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const body = Buffer.from(entry.body, "utf8");
    blocks.push(ustarHeader(entry.name, body.length, entry.typeflag ?? "0"));
    const padded = Buffer.alloc(Math.ceil(body.length / 512) * 512);
    body.copy(padded);
    if (body.length > 0) blocks.push(padded);
  }
  blocks.push(Buffer.alloc(1024)); // two zero blocks terminate the archive
  return gzipSync(Buffer.concat(blocks));
}

function writeTgz(buf: Buffer): { tgz: string; dir: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "loombridge-tarball-hand-"));
  const tgz = path.join(dir, "hand.tgz");
  writeFileSync(tgz, buf);
  return { tgz, dir };
}

test("extractTarball refuses a member that escapes the destination", () => {
  const { tgz, dir } = writeTgz(tarball([{ name: "../escaped.txt", body: "pwned" }]));
  const dest = mkdtempSync(path.join(tmpdir(), "loombridge-tarball-guard-"));
  try {
    assert.throws(() => extractTarball(tgz, dest), /refusing to extract outside/);
    assert.equal(existsSync(path.join(path.dirname(dest), "escaped.txt")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(dest, { recursive: true, force: true });
  }
});

test("readTarball applies a PAX path override to the following entry", () => {
  // libarchive (which npm/macOS use) emits 'x' headers; the long path lives there, not in `name`.
  // "%d %s=%s\n", where %d counts its own digits — solve for the fixpoint.
  const paxRecord = (key: string, value: string): string => {
    const rest = ` ${key}=${value}\n`;
    let len = rest.length + 1;
    while (String(len).length + rest.length !== len) len = String(len).length + rest.length;
    return `${len}${rest}`;
  };
  const record = paxRecord("path", "package/DeepName.cs");
  const { tgz, dir } = writeTgz(
    tarball([
      { name: "PaxHeader/bogus", body: record, typeflag: "x" },
      { name: "short-name", body: "// deep\n" },
    ]),
  );
  try {
    const entries = readTarball(tgz).filter((e) => e.type === "file");
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.path, "package/DeepName.cs");
    assert.equal(entries[0]?.data.toString("utf8"), "// deep\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readTarball applies a GNU long-name header to the following entry", () => {
  const longName = `package/${"a".repeat(120)}.cs`;
  const { tgz, dir } = writeTgz(
    tarball([
      { name: "././@LongLink", body: longName, typeflag: "L" },
      { name: "truncated", body: "// long\n" },
    ]),
  );
  try {
    const entries = readTarball(tgz).filter((e) => e.type === "file");
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.path, longName);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
