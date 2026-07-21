/**
 * Shared helpers for the bridge install/health surface (`install-bridge`,
 * `doctor`, and later `update`). Keeping tarball resolution, version/sha
 * derivation, and the install-metadata shape in ONE place means the record
 * `install-bridge` writes and the record `doctor` reads can never drift.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import type { RoutingDocRecord } from "./routing-doc.js";
import { readTarballFile } from "./tarball.js";

export const PKG_ID = "com.loomtide.loombridge";

/** Raised for a genuine runtime/filesystem failure (exit 1), vs a usage error (exit 2). */
export class BridgeInstallError extends Error {}

/**
 * One managed file in an optional-surface ledger: its project-relative path and the
 * sha256 of the exact bytes Loombridge wrote. Hand-edit detection is per-file: a mismatch
 * on disk means the user has made the file theirs, so it is never clobbered or removed.
 */
export interface AgentSurfaceFile {
  path: string;
  sha256: string;
}

/**
 * The optional project-scoped agent surface (commands + skills), stored in the SAME
 * committed install record so the decision is team-wide + versioned (one dev decides,
 * everyone's `loombridge update` behaves identically after `git pull`).
 *
 *   absent block  = UNSET  (default) — nothing installed; install/update print ONE hint.
 *   state:enabled = installed; the ledger drives refresh + hand-edit-safe removal.
 *   state:declined = opted out; install/update go silent (no nagging).
 *
 * This is deliberately ONE named key so future optional surfaces can slot in beside it
 * (a sibling key) without a schema break.
 */
export interface AgentSurfaceRecord {
  state: "enabled" | "declined";
  cliVersion: string;
  installedAt: string;
  files: AgentSurfaceFile[];
}

/** The record written to `<project>/ProjectSettings/LoombridgeInstall.json`. */
export interface InstallMetadata {
  schemaVersion: number;
  installedAt: string;
  cliVersion: string;
  bridgeVersion: string;
  bridgeProtocol: number;
  installMode: "tarball-dependency" | "embedded-package";
  packageId: string;
  tarball?: string;
  tarballSha256?: string;
  /**
   * INFORMATIONAL-ONLY audit trail of what the last install did to the agent-routing
   * front door (LOOMBRIDGE.md). Consumed by nothing — `doctor` deliberately re-derives
   * routing health from the file on disk (like the tarball sha check), because a record
   * saying "written" proves nothing once the user deletes or replaces the file. Absent
   * on pre-routing install records.
   */
  routingDoc?: RoutingDocRecord;
  /** Optional agent surface preference + ledger (see AgentSurfaceRecord). */
  agentSurface?: AgentSurfaceRecord;
}

export const METADATA_RELPATH = path.join("ProjectSettings", "LoombridgeInstall.json");

/**
 * Locate the bridge tarball that ships with this CLI build. Resolution order:
 *   1. explicit override (`--tarball` / `$LOOMBRIDGE_BRIDGE_TARBALL`)
 *   2. `<mcp-server>/bridge/`  (npm-packaged layout — tarball bundled here)
 *   3. `<repo>/dist/bridge/`   (dev layout — `scripts/loombridge-pack-bridge.sh` output)
 * Within a directory, the newest `com.loomtide.loombridge-*.tgz` wins. Returns
 * null when none is found (callers decide whether that is fatal).
 */
export function resolveBundledTarball(override?: string): string | null {
  const explicit = override || process.env.LOOMBRIDGE_BRIDGE_TARBALL;
  if (explicit) {
    const p = path.resolve(explicit);
    if (!existsSync(p)) throw new BridgeInstallError(`bridge tarball not found: ${p}`);
    return p;
  }
  const here = path.dirname(fileURLToPath(import.meta.url)); // <mcp-server>/dist/loombridge
  const mcpServerRoot = path.resolve(here, "..", ".."); // <mcp-server>
  const repoRoot = path.resolve(mcpServerRoot, ".."); // <repo>
  const candidateDirs = [path.join(mcpServerRoot, "bridge"), path.join(repoRoot, "dist", "bridge")];
  for (const dir of candidateDirs) {
    if (!existsSync(dir)) continue;
    const tgzs = readdirSync(dir)
      .filter((f) => f.startsWith(`${PKG_ID}-`) && f.endsWith(".tgz"))
      .map((f) => ({ f, mtime: statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    if (tgzs.length > 0) return path.join(dir, tgzs[0].f);
  }
  return null;
}

/** Read the authoritative package version from inside the tarball's package.json. */
export function readTarballVersion(tgz: string): string {
  try {
    const json = readTarballFile(tgz, "package/package.json");
    if (json) {
      const v = JSON.parse(json.toString("utf8")).version;
      if (typeof v === "string" && v.length > 0) return v;
    }
  } catch {
    /* unreadable or malformed tarball — fall through to the filename parse below */
  }
  // The tarball is malformed or is missing package.json — the filename is all we have left,
  // so say so rather than silently passing a guess off as the authoritative version.
  const m = path.basename(tgz).match(new RegExp(`^${PKG_ID}-(.+)\\.tgz$`));
  if (m) {
    console.warn(`  !! could not read package.json from ${path.basename(tgz)}; using the filename version`);
    return m[1];
  }
  throw new BridgeInstallError(`could not determine bridge version from ${tgz}`);
}

export function sha256File(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/** Read a project's install metadata, or null if absent/unparseable. */
export function readInstallMetadata(project: string): InstallMetadata | null {
  const p = path.join(project, METADATA_RELPATH);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as InstallMetadata;
  } catch {
    return null;
  }
}

/**
 * The SINGLE writer for the install record — both `install-bridge` (bridge fields) and
 * `install-agent` (the agentSurface block) go through this so the two concerns never
 * clobber each other. The `patch` is MERGED over the existing on-disk record, so writing
 * the bridge fields preserves an existing agentSurface block, and vice versa. Sibling
 * keys of a future optional surface would survive the same way. Returns the record path.
 */
export function writeInstallRecord(project: string, patch: Partial<InstallMetadata>, dryRun: boolean): string {
  const p = path.join(project, METADATA_RELPATH);
  const existing = readInstallMetadata(project) ?? {};
  const merged = { ...existing, ...patch };
  if (!dryRun) {
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, `${JSON.stringify(merged, null, 2)}\n`);
  }
  return p;
}

/** Does the directory look like a Unity project? */
export function looksLikeUnityProject(project: string): boolean {
  return (
    existsSync(path.join(project, "Assets")) ||
    existsSync(path.join(project, "ProjectSettings", "ProjectVersion.txt")) ||
    existsSync(path.join(project, "Packages", "manifest.json"))
  );
}
