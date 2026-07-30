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
import {
  BRIDGE_DIGEST_ENTRY_NAME,
  computeBridgeSourceDigest,
  isKnownBridgeDigest,
} from "../../shared/bridge-source-digest.js";
import { packageRoot } from "../../shared/pkg-root.js";

export const PKG_ID = "com.loomtide.loombridge";

/**
 * Package ids this bridge REPLACES. A project that still declares one of these alongside
 * PKG_ID loads two bridges: both define `namespace UnityBridge` with an
 * `[InitializeOnLoad] UnityBridgeBootstrap`, so Unity starts two bridge servers racing for
 * the same port and the duplicated types raise CS0433. Installing must clear them, and
 * doctor must fail on them — a project in that state cannot compile, and reporting it
 * "healthy" is worse than not checking at all.
 */
export const SUPERSEDED_PKG_IDS = ["com.loomtide.unitybridge"] as const;

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
 * How the tarball we are about to deliver was chosen. This decides how loud a stale
 * bundle is allowed to be: an `--tarball` argument is a deliberate, per-invocation user
 * choice (warn and proceed), while `$LOOMBRIDGE_BRIDGE_TARBALL` is AMBIENT (it can be
 * exported in a shell profile and forgotten) and the auto-resolved bundle is not a choice
 * at all. Both of those refuse.
 */
export type BridgeTarballOrigin = "explicit" | "env" | "bundled";

/** A bridge tarball on disk, before any freshness work is done. */
export interface LocatedBridgeTarball {
  path: string;
  origin: BridgeTarballOrigin;
}

/**
 * Locate the bridge tarball that ships with this CLI build. Resolution order:
 *   1. explicit override (`--tarball` / `$LOOMBRIDGE_BRIDGE_TARBALL`)
 *   2. `<mcp-server>/bridge/`  (npm-packaged layout — tarball bundled here)
 *   3. `<repo>/dist/bridge/`   (dev layout — `scripts/loombridge-pack-bridge.sh` output)
 * Within a directory, the newest `com.loomtide.loombridge-*.tgz` wins. Returns
 * null when none is found (callers decide whether that is fatal).
 *
 * Locating is deliberately separate from grading (`bundledBridgeFreshness`): the grade can
 * throw on a corrupt archive or an unreadable source tree, and doctor has to be able to
 * say "the tarball is HERE and its freshness could not be evaluated" rather than
 * collapsing both failures into "no tarball ships with this CLI".
 */
export function locateBridgeTarball(override?: string): LocatedBridgeTarball | null {
  const explicit = override || process.env.LOOMBRIDGE_BRIDGE_TARBALL;
  if (explicit) {
    const p = path.resolve(explicit);
    if (!existsSync(p)) throw new BridgeInstallError(`bridge tarball not found: ${p}`);
    return { path: p, origin: override ? "explicit" : "env" };
  }
  // Depth-independent: counting ".." encoded how deep this module sat, so the source
  // reorganisation silently pointed both candidates one level too shallow and every
  // consumer install lost its bundled bridge while the test suite stayed green.
  const mcpServerRoot = packageRoot(import.meta.url); // <mcp-server>
  const repoRoot = path.resolve(mcpServerRoot, ".."); // <repo>
  const candidateDirs = [path.join(mcpServerRoot, "bridge"), path.join(repoRoot, "dist", "bridge")];
  for (const dir of candidateDirs) {
    if (!existsSync(dir)) continue;
    const tgzs = readdirSync(dir)
      .filter((f) => f.startsWith(`${PKG_ID}-`) && f.endsWith(".tgz"))
      .map((f) => ({ f, mtime: statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    if (tgzs.length > 0) return { path: path.join(dir, tgzs[0].f), origin: "bundled" };
  }
  return null;
}

// --- bundled-bridge freshness ---------------------------------------------

/**
 * Is the bundled tarball actually built from the sources this CLI ships?
 *
 *   fresh                 embedded digest == digest recomputed from the local sources
 *   stale                 both exist and DIFFER: the delivery bug this guard closes
 *   undigested            no embedded record: not produced by the current pipeline, so
 *                         nothing binds it to any source tree. Fails in EVERY layout.
 *   unknown-digest-version  a record this CLI cannot interpret. Never silently read as
 *                         stale (which would advise "re-pack") nor as fresh.
 *   unverifiable          a valid digest, but no source tree next to this install to
 *                         recompute against (the npm-packaged layout, where `prepack`
 *                         regenerated the tarball at pack time by construction).
 */
export type BridgeFreshnessState = "fresh" | "stale" | "undigested" | "unknown-digest-version" | "unverifiable";

export interface BridgeFreshness {
  state: BridgeFreshnessState;
  /** The digest embedded in the tarball, when it carries a readable one. */
  embedded?: string;
  /** The digest recomputed from the local source package, when one exists. */
  local?: string;
  /** The source package directory the local digest came from (or would have). */
  sourceDir?: string;
  /** Provenance carried by the embedded record: which CLI build packed it, from what commit. */
  producedBy?: { cliVersion?: string; commit?: string };
  /** Why an unknown/unreadable record could not be interpreted. */
  note?: string;
}

/**
 * The bridge SOURCE package next to this CLI install, or null when there is none.
 *
 * Two layouts resolve here and BOTH are deliberately verifiable:
 *   - the dev repo:        <repo>/packages/com.loomtide.loombridge, mcp-server/ alongside
 *   - the frozen runtime:  ~/.loomtide/runtime/packages/com.loomtide.loombridge, vendored
 *     next to mcp-server/ by scripts/loombridge-install-locally.sh
 * The frozen runtime packs its bundled tarball from that vendored copy, so a mismatch
 * there is a real defect (a re-vendored source with a stale tarball), not a false alarm.
 *
 * An npm-installed CLI (`node_modules/@loomtide/loombridge/`) has no sibling `packages/`,
 * which is what makes it `unverifiable` rather than stale.
 *
 * packageRoot(), never `..` counting: a `..` count encodes how deep this module sits, and
 * re-nesting one directory would silently point this at the wrong tree.
 */
export function resolveBridgeSourcePackageDir(): string | null {
  const mcpServerRoot = packageRoot(import.meta.url);
  const candidate = path.join(path.resolve(mcpServerRoot, ".."), "packages", PKG_ID);
  return existsSync(path.join(candidate, "package.json")) ? candidate : null;
}

/**
 * Grade a bridge tarball against the sources this CLI ships.
 *
 * The digest is evaluated BEFORE the layout branch on purpose: "no embedded digest" is a
 * failure in every layout, because once the pack script embeds one, its absence means the
 * tarball did not come from this pipeline at all. Deciding the layout first would have let
 * an undigested tarball pass as "unverifiable" wherever sources happen to be missing,
 * which is precisely the shape of the bug being closed.
 *
 * THROWS on a corrupt archive or an unreadable source tree. That is deliberate: a check
 * that cannot run must become its own failure at the caller, never a skipped row.
 *
 * @param sourcePackageDir test-only override. Production callers pass nothing so that the
 *        answer always derives from the CLI's own resolved layout.
 */
export function bundledBridgeFreshness(
  tgz: string,
  sourcePackageDir: string | null = resolveBridgeSourcePackageDir(),
): BridgeFreshness {
  const raw = readTarballFile(tgz, `package/${BRIDGE_DIGEST_ENTRY_NAME}`);
  if (raw === null) return { state: "undigested" };

  let record: { digest?: unknown; cliVersion?: unknown; commit?: unknown };
  try {
    record = JSON.parse(raw.toString("utf8")) as typeof record;
  } catch {
    return { state: "unknown-digest-version", note: `package/${BRIDGE_DIGEST_ENTRY_NAME} is not valid JSON` };
  }
  const embedded = record.digest;
  if (typeof embedded !== "string" || !isKnownBridgeDigest(embedded)) {
    return {
      state: "unknown-digest-version",
      note:
        typeof embedded === "string"
          ? `digest "${embedded.slice(0, 24)}" uses a format this CLI does not know`
          : `package/${BRIDGE_DIGEST_ENTRY_NAME} carries no digest field`,
    };
  }
  const producedBy = {
    cliVersion: typeof record.cliVersion === "string" ? record.cliVersion : undefined,
    commit: typeof record.commit === "string" ? record.commit : undefined,
  };

  if (!sourcePackageDir) return { state: "unverifiable", embedded, producedBy };

  const local = computeBridgeSourceDigest(sourcePackageDir);
  return {
    state: local === embedded ? "fresh" : "stale",
    embedded,
    local,
    sourceDir: sourcePackageDir,
    producedBy,
  };
}

/** A located tarball plus its grade. */
export interface ResolvedBridgeTarball extends LocatedBridgeTarball {
  freshness: BridgeFreshness;
}

/**
 * Locate AND grade in one call. Returning the grade beside the path is what makes "every
 * delivery door consumes the freshness" a compiler-enforced property rather than a prose
 * list: no caller can obtain a path without also being handed the grade.
 */
export function resolveBundledTarball(override?: string): ResolvedBridgeTarball | null {
  const located = locateBridgeTarball(override);
  if (!located) return null;
  return { ...located, freshness: bundledBridgeFreshness(located.path) };
}

/** What a door should DO about a grade. */
export type FreshnessDisposition = "ok" | "info" | "reject";

export interface BridgeFreshnessJudgement {
  disposition: FreshnessDisposition;
  /** One line naming the state (for a doctor row or a refusal header). */
  detail: string;
  /** What happens if this bundle is delivered anyway. Rejections only. */
  consequence?: string;
  /** The exact command that fixes it, absolute, or undefined when no file-level fix applies. */
  remediation?: string;
}

/**
 * Re-pack command for a stale bundle, built ABSOLUTE from the resolved roots and only when
 * the script is actually there: a remediation naming a file that does not exist is worse
 * than no remediation, because it sends the reader looking for a path this CLI invented.
 * `--out-dir` targets the directory the stale tarball came from, so the fix lands where
 * the resolver will look next time.
 */
function repackCommand(tgz: string): string | undefined {
  const repoRoot = path.resolve(packageRoot(import.meta.url), "..");
  const script = path.join(repoRoot, "scripts", "loombridge-pack-bridge.sh");
  if (!existsSync(script)) return undefined;
  return `bash ${script} --out-dir ${path.dirname(path.resolve(tgz))}`;
}

const REINSTALL_HINT =
  "Reinstall the CLI from a release (its prepack regenerates the bundled bridge), or re-pack it in a dev checkout.";

/**
 * The ONE classifier every door shares. The `never` default means a new freshness state
 * cannot be added without this switch failing to compile, and the three-valued
 * disposition means a door that switches on it cannot silently ignore a new outcome.
 */
export function judgeBridgeFreshness(f: BridgeFreshness, tgz: string): BridgeFreshnessJudgement {
  switch (f.state) {
    case "fresh":
      return { disposition: "ok", detail: `matches the packaged sources (${shortDigest(f.embedded)})` };
    case "stale":
      return {
        disposition: "reject",
        detail: `bundle ${shortDigest(f.embedded)} does not match the sources at ${f.sourceDir} (${shortDigest(f.local)})`,
        consequence:
          "the bridge this would install does not match the CLI's own packaged sources; the editor would run code this CLI no longer has",
        remediation: repackCommand(tgz) ?? REINSTALL_HINT,
      };
    case "undigested":
      return {
        disposition: "reject",
        detail: "carries no source digest: it was not produced by the current pack pipeline",
        consequence:
          "nothing binds this tarball to any source tree, so there is no way to tell what the editor would run",
        remediation: repackCommand(tgz) ?? REINSTALL_HINT,
      };
    case "unknown-digest-version":
      return {
        disposition: "reject",
        detail: `source digest is unreadable to this CLI${f.note ? ` (${f.note})` : ""}`,
        consequence:
          "a digest this CLI cannot interpret proves nothing; treating it as fresh would be a guess dressed as a check",
        remediation: repackCommand(tgz) ?? REINSTALL_HINT,
      };
    case "unverifiable":
      return {
        disposition: "info",
        detail:
          `digest ${shortDigest(f.embedded)} present; no bridge sources next to this CLI to recompute against` +
          (f.producedBy?.cliVersion ? ` (packed by cli ${f.producedBy.cliVersion}` : "") +
          (f.producedBy?.commit ? ` @ ${f.producedBy.commit.slice(0, 7)})` : f.producedBy?.cliVersion ? ")" : ""),
      };
    default: {
      const exhaustive: never = f.state;
      throw new BridgeInstallError(`unhandled bridge freshness state: ${String(exhaustive)}`);
    }
  }
}

function shortDigest(d?: string): string {
  return d ? `${d.slice(0, 15)}…` : "unknown";
}

/**
 * The override every delivery door honours. Named `--allow-stale-bridge` rather than
 * `--force-stale-bridge` so it cannot be misread as a variant of the existing
 * `--force-bridge` (which is about clobbering a hand-edited EMBEDDED copy, an unrelated
 * hazard). Nothing is recorded in the install metadata when it is used: every later
 * verdict re-derives from DISK, so a forced install shows up as a failed doctor row
 * whether or not a record admits to it.
 */
export const ALLOW_STALE_FLAG = "--allow-stale-bridge";

/** What a delivery door must do about the bundle it just resolved. */
export type FreshnessGateOutcome =
  | { kind: "proceed" }
  | { kind: "warn"; message: string }
  | { kind: "refuse"; message: string };

/**
 * The gate every delivery door runs. Scope, deliberately narrow and pinned by tests:
 *
 *   --tarball <path>              WARN and proceed. Naming a tarball is a per-invocation,
 *                                 deliberate choice; refusing it would make the escape
 *                                 hatch for "install this exact build" unusable.
 *   $LOOMBRIDGE_BRIDGE_TARBALL    REFUSE. Ambient: exported once in a shell profile and
 *                                 then invisible at the call site.
 *   auto-resolved bundle          REFUSE. Not a choice at all, and the failing case.
 *
 * `--allow-stale-bridge` turns any refusal into a loud warning.
 */
export function gateBridgeFreshness(
  verb: string,
  resolved: ResolvedBridgeTarball,
  allowStale: boolean,
): FreshnessGateOutcome {
  const judged = judgeBridgeFreshness(resolved.freshness, resolved.path);
  switch (judged.disposition) {
    case "ok":
      return { kind: "proceed" };
    case "info":
      // `unverifiable`: a valid digest with no local sources to check it against. There is
      // nothing to refuse on, and refusing would break every npm-installed CLI.
      return { kind: "proceed" };
    case "reject":
      if (allowStale) return { kind: "warn", message: freshnessWarningMessage(verb, resolved, judged, "override") };
      if (resolved.origin === "explicit") {
        return { kind: "warn", message: freshnessWarningMessage(verb, resolved, judged, "explicit-tarball") };
      }
      return { kind: "refuse", message: freshnessRefusalMessage(verb, resolved, judged) };
    default: {
      const exhaustive: never = judged.disposition;
      throw new BridgeInstallError(`unhandled freshness disposition: ${String(exhaustive)}`);
    }
  }
}

/** The refusal a door prints when it will not deliver a bundle. Names the consequence, not just the state. */
export function freshnessRefusalMessage(
  verb: string,
  resolved: ResolvedBridgeTarball,
  judged: BridgeFreshnessJudgement,
): string {
  const lines = [
    `[loombridge ${verb}] REFUSING to deliver this bridge tarball: ${judged.detail}`,
    `    ${judged.consequence ?? "this bundle cannot be shown to match the CLI's packaged sources"}`,
    `    tarball: ${resolved.path}`,
  ];
  if (judged.remediation) lines.push(`    fix: ${judged.remediation}`);
  lines.push(`    (${ALLOW_STALE_FLAG} proceeds anyway; doctor will keep reporting the mismatch.)`);
  return lines.join("\n");
}

/** The warning a door prints when it proceeds regardless (explicit --tarball, or the override). */
export function freshnessWarningMessage(
  verb: string,
  resolved: ResolvedBridgeTarball,
  judged: BridgeFreshnessJudgement,
  why: "explicit-tarball" | "override",
): string {
  const reason =
    why === "explicit-tarball"
      ? "proceeding because you named this tarball explicitly with --tarball"
      : `proceeding because ${ALLOW_STALE_FLAG} was passed`;
  const lines = [
    `[loombridge ${verb}] !! STALE BRIDGE: ${judged.detail}`,
    `    ${judged.consequence ?? "this bundle cannot be shown to match the CLI's packaged sources"}`,
    `    tarball: ${resolved.path}`,
    `    ${reason}.`,
  ];
  if (judged.remediation) lines.push(`    fix it later with: ${judged.remediation}`);
  return lines.join("\n");
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
