/**
 * `loombridge install-bridge` — install the Loombridge Unity bridge into a consumer
 * Unity project WITHOUT cloning the Loombridge repo.
 *
 * Default route: drop the versioned bridge `.tgz` bundled with THIS CLI into the project and add it as a
 * `file:` IMMUTABLE dependency in `Packages/manifest.json`:
 *
 *   "com.loomtide.loombridge": "file:tarballs/com.loomtide.loombridge-<ver>.tgz"
 *
 * Unity resolves that read-only into `Library/PackageCache`, which (a) means the
 * package's Tests/ self-exclude from the consumer compile (an immutable dependency
 * is not a Unity "testable", so `UNITY_INCLUDE_TESTS` stays undefined) and (b)
 * kills the "developer edited the embedded bridge" hazard. Proven live on Unity
 * 6000.3.9f1: a consumer with no com.unity.test-framework compiled clean.
 *
 * `--embedded` fallback: physically copy the bridge into
 * `Packages/com.loomtide.loombridge/`, EXCLUDING Tests/ (the legacy RUN-1 #62
 * shape), for air-gapped consumers who refuse a manifest dependency.
 *
 * Exit codes: 0 installed · 1 filesystem/runtime failure · 2 usage/validation.
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { REQUIRED_PROTOCOL_VERSION } from "../preflight/prerequisite-checks.js";
import { resolveBuildStamp } from "./build-stamp.js";
import {
  BridgeInstallError as RuntimeFailure,
  InstallMetadata,
  METADATA_RELPATH,
  PKG_ID,
  SUPERSEDED_PKG_IDS,
  looksLikeUnityProject,
  readTarballVersion,
  resolveBundledTarball as resolveBundledTarballShared,
  sha256File,
  writeInstallRecord,
} from "./bridge-install-common.js";
import { agentSurfaceState, printAgentSurfaceHintIfUnset } from "./install-agent.js";
import { extractTarball } from "./tarball.js";
import {
  ROUTING_DOC_RELPATH,
  ROUTING_DOC_VERSION,
  type RoutingDocRecord,
  parseRoutingDocVersion,
  renderRoutingDoc,
} from "./routing-doc.js";

// --- exit-code discipline: usage/validation = 2, runtime failure = 1 ---
class UsageError extends Error {}

/** install-bridge cannot proceed without a tarball, so treat "none found" as fatal. */
function resolveBundledTarball(override?: string): string {
  const tgz = resolveBundledTarballShared(override);
  if (!tgz) {
    throw new RuntimeFailure(
      "no bundled bridge tarball found. In the dev repo, run scripts/loombridge-pack-bridge.sh first.",
    );
  }
  return tgz;
}

export interface InstallArgs {
  project: string;
  mode: "tarball" | "embedded";
  tarball?: string; // explicit tarball path override
  dryRun: boolean;
}

type ParseHelp = { help: true; usageError?: boolean };

function parseArgs(args: string[]): InstallArgs | ParseHelp {
  let project = "";
  let mode: "tarball" | "embedded" = "tarball";
  let tarball: string | undefined;
  let dryRun = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--project" || arg === "-p") project = args[(i += 1)] ?? "";
    else if (arg === "--tarball") tarball = args[(i += 1)] ?? "";
    else if (arg === "--embedded") mode = "embedded";
    else if (arg === "--dry-run") dryRun = true;
    else if (arg === "--help" || arg === "-h") return { help: true };
    else {
      console.error(`[loombridge install-bridge] unknown argument "${arg}".`);
      return { help: true, usageError: true };
    }
  }
  if (!project) {
    console.error("[loombridge install-bridge] --project <unity-project-dir> is required.");
    return { help: true, usageError: true };
  }
  return { project: path.resolve(project), mode, tarball, dryRun };
}

/** A Unity project must exist and look like a project. */
function assertUnityProject(project: string): void {
  if (!existsSync(project)) throw new UsageError(`--project directory does not exist: ${project}`);
  if (!statSync(project).isDirectory()) throw new UsageError(`--project is not a directory: ${project}`);
  if (!looksLikeUnityProject(project)) {
    throw new UsageError(
      `${project} does not look like a Unity project (no Assets/, ProjectSettings/ProjectVersion.txt, or Packages/manifest.json).`,
    );
  }
}

interface ManifestEdit {
  before?: string;
  after: string;
  removedStaleFolderRef: boolean;
  /** Superseded bridge package ids cleared from the manifest (see SUPERSEDED_PKG_IDS). */
  removedSupersededIds: string[];
}

/** Add/replace the file: dependency for the bridge id; report a replaced stale ref. */
function upsertManifestDependency(project: string, fileRef: string, dryRun: boolean): ManifestEdit {
  const manifestPath = path.join(project, "Packages", "manifest.json");
  let manifest: { dependencies?: Record<string, string> } = {};
  if (existsSync(manifestPath)) {
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch (e) {
      throw new RuntimeFailure(`Packages/manifest.json is not valid JSON: ${(e as Error).message}`);
    }
  }
  manifest.dependencies ??= {};
  const before = manifest.dependencies[PKG_ID];
  const removedStaleFolderRef = typeof before === "string" && before.startsWith("file:") && !before.endsWith(".tgz");
  // Clear any predecessor bridge BEFORE adding ours: leaving both declared installs two
  // packages that each define namespace UnityBridge with an [InitializeOnLoad] bootstrap.
  const removedSupersededIds: string[] = [];
  for (const legacy of SUPERSEDED_PKG_IDS) {
    if (legacy in manifest.dependencies) {
      delete manifest.dependencies[legacy];
      removedSupersededIds.push(legacy);
    }
  }
  manifest.dependencies[PKG_ID] = fileRef;
  if (!dryRun) {
    mkdirSync(path.dirname(manifestPath), { recursive: true });
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  return { before, after: fileRef, removedStaleFolderRef, removedSupersededIds };
}

/**
 * Install / refresh the agent-routing front door (LOOMBRIDGE.md) at the project root.
 *
 * The #1 trust rule for writing into someone else's repo: NEVER clobber user content.
 * So the decision is driven entirely by our version marker:
 *   - absent file                              → write ours            (written)
 *   - present, OUR marker, older version       → update in place       (updated)
 *   - present, OUR marker, current/newer       → leave it (byte-safe)  (unchanged)
 *   - present, NO marker (user-authored)       → REFUSE + warn         (refused-user-authored)
 *   - any filesystem error (EROFS/EISDIR/…)    → warn + degrade        (write-failed)
 *
 * NEVER throws: the routing doc is an advisory nicety — a broken LOOMBRIDGE.md write must
 * not abort an install whose bridge wiring (tarball/manifest) already succeeded, so IO
 * failures degrade to a warning + a "write-failed" record and the install still exits 0.
 *
 * The returned record is an INFORMATIONAL audit trail only (what this run decided).
 * The file ON DISK is the source of truth: `doctor` deliberately re-derives routing
 * health by re-reading LOOMBRIDGE.md (the honest check, like the tarball sha) — a record
 * saying "written" proves nothing if the user has since deleted or replaced the file.
 */
function syncRoutingDoc(project: string, dryRun: boolean): RoutingDocRecord {
  const docPath = path.join(project, ROUTING_DOC_RELPATH);
  // The routing doc gains a line pointing at the installed commands/skills ONLY when the
  // optional agent surface is enabled (read from the committed record on disk).
  const agentSurfaceEnabled = agentSurfaceState(project) === "enabled";
  try {
    const canonical = renderRoutingDoc(ROUTING_DOC_VERSION, { agentSurfaceEnabled });

    if (!existsSync(docPath)) {
      if (!dryRun) writeFileSync(docPath, canonical);
      console.log(`  -> ${ROUTING_DOC_RELPATH} (agent routing front door, v${ROUTING_DOC_VERSION})`);
      console.log(`     add to your CLAUDE.md/AGENTS.md: "Read LOOMBRIDGE.md before Unity work — it routes game-build/verify/perf tasks to Loombridge tools."`);
      return { relpath: ROUTING_DOC_RELPATH, version: ROUTING_DOC_VERSION, action: "written" };
    }

    const existing = readFileSync(docPath, "utf8");
    const onDiskVersion = parseRoutingDocVersion(existing);

    if (onDiskVersion === null) {
      // User-authored (or a hand-crafted file that dropped our marker) — never overwrite.
      console.log(`  !! ${ROUTING_DOC_RELPATH} exists WITHOUT the Loombridge marker — leaving it untouched (not clobbering your file).`);
      console.log(`     If you want the generated routing doc, move it aside and re-run: loombridge install-bridge --project ${project}`);
      return { relpath: ROUTING_DOC_RELPATH, version: null, action: "refused-user-authored" };
    }

    // Refresh an OUR-marked file whenever what we'd write differs from what's on disk —
    // whether the version bumped OR the same version now renders differently (e.g. the
    // optional agent-surface line just turned on). Content comparison keeps a true
    // same-content re-run byte-identical (a no-op) while honoring "re-run to update".
    // A file NEWER than this CLI knows is left alone (never downgraded).
    if (onDiskVersion <= ROUTING_DOC_VERSION && existing !== canonical) {
      if (!dryRun) writeFileSync(docPath, canonical);
      const how = onDiskVersion < ROUTING_DOC_VERSION ? `updated v${onDiskVersion} -> v${ROUTING_DOC_VERSION}` : `refreshed (v${ROUTING_DOC_VERSION})`;
      console.log(`  -> ${ROUTING_DOC_RELPATH} ${how}`);
      return { relpath: ROUTING_DOC_RELPATH, version: ROUTING_DOC_VERSION, action: "updated" };
    }

    // Byte-identical to what we'd write (or newer than this CLI knows) — a true no-op.
    console.log(`  -> ${ROUTING_DOC_RELPATH} already current (v${onDiskVersion})`);
    return { relpath: ROUTING_DOC_RELPATH, version: onDiskVersion, action: "unchanged" };
  } catch (error) {
    // Graceful degrade (same contract as the user-authored refusal): the bridge wiring
    // already landed, so finish the install; doctor's re-derive will surface the gap.
    const message = error instanceof Error ? error.message : String(error);
    console.log(`  !! could not write ${ROUTING_DOC_RELPATH}: ${message}`);
    console.log(`     the bridge install continues; fix the path and re-run: loombridge install-bridge --project ${project}`);
    return { relpath: ROUTING_DOC_RELPATH, version: null, action: "write-failed", error: message };
  }
}

/**
 * Write the bridge fields through the SHARED record writer so an existing agentSurface
 * block (from `install-agent`) is preserved — bridge and surface never clobber each other.
 */
function writeMetadata(project: string, meta: InstallMetadata, dryRun: boolean): string {
  return writeInstallRecord(project, meta, dryRun);
}

async function installTarball(a: InstallArgs): Promise<number> {
  const tgz = resolveBundledTarball(a.tarball);
  const version = readTarballVersion(tgz);
  const sha = sha256File(tgz);
  const tarballName = `${PKG_ID}-${version}.tgz`;
  const fileRef = `file:tarballs/${tarballName}`;

  console.log(`==> Installing ${PKG_ID}@${version} (tarball dependency) into ${a.project}`);
  console.log(`    source tarball: ${tgz}`);
  console.log(`    sha256: ${sha}`);
  if (a.dryRun) console.log("    (--dry-run: no files will be written)");

  // 1. Remove a stale EMBEDDED copy of the same package id (it would double-declare
  //    against the file: dependency — Unity errors on a duplicate package id).
  const embeddedDir = path.join(a.project, "Packages", PKG_ID);
  if (existsSync(embeddedDir)) {
    console.log(`  !! removing stale embedded copy at Packages/${PKG_ID}/ (conflicts with the file: dependency)`);
    if (!a.dryRun) rmSync(embeddedDir, { recursive: true, force: true });
  }

  // 2. Drop the tarball into Packages/tarballs/, pruning older bridge tarballs.
  const tarballsDir = path.join(a.project, "Packages", "tarballs");
  if (!a.dryRun) mkdirSync(tarballsDir, { recursive: true });
  if (existsSync(tarballsDir)) {
    for (const f of readdirSync(tarballsDir)) {
      if (f.startsWith(`${PKG_ID}-`) && f.endsWith(".tgz") && f !== tarballName) {
        console.log(`  -> pruning older tarball ${f}`);
        if (!a.dryRun) rmSync(path.join(tarballsDir, f), { force: true });
      }
    }
  }
  const destTgz = path.join(tarballsDir, tarballName);
  console.log(`  -> Packages/tarballs/${tarballName}`);
  if (!a.dryRun) cpSync(tgz, destTgz);

  // 3. Write the manifest dependency.
  const edit = upsertManifestDependency(a.project, fileRef, a.dryRun);
  if (edit.before && edit.before !== edit.after) {
    console.log(`  -> manifest dependency: "${edit.before}" -> "${edit.after}"`);
    if (edit.removedStaleFolderRef) console.log(`     (replaced a stale file:-folder reference)`);
  } else {
    console.log(`  -> manifest dependency: "${PKG_ID}": "${fileRef}"`);
  }
  for (const legacy of edit.removedSupersededIds) {
    console.log(`  -> removed superseded bridge dependency: "${legacy}"`);
    console.log(`     (it declares the same UnityBridge types — keeping both starts two bridges)`);
  }

  // 4. The agent-routing front door (LOOMBRIDGE.md) — install the workflow, not just the wiring.
  const routingDoc = syncRoutingDoc(a.project, a.dryRun);

  // 5. Install metadata (installMode/version/protocol/sha) — the record doctor/update read.
  const metaPath = writeMetadata(
    a.project,
    {
      schemaVersion: 1,
      installedAt: new Date().toISOString(),
      cliVersion: resolveBuildStamp().version,
      bridgeVersion: version,
      bridgeProtocol: REQUIRED_PROTOCOL_VERSION,
      installMode: "tarball-dependency",
      packageId: PKG_ID,
      tarball: `tarballs/${tarballName}`,
      tarballSha256: sha,
      routingDoc,
    },
    a.dryRun,
  );
  console.log(`  -> ProjectSettings/${path.basename(metaPath)} (installMode: tarball-dependency, protocol ${REQUIRED_PROTOCOL_VERSION})`);

  console.log("");
  console.log("==> Done. Next: open the project in Unity, wait for the bridge to compile, then run:");
  console.log(`    loombridge doctor --project ${a.project}`);
  return 0;
}

async function installEmbedded(a: InstallArgs): Promise<number> {
  const tgz = resolveBundledTarball(a.tarball);
  const version = readTarballVersion(tgz);
  console.log(`==> Installing ${PKG_ID}@${version} (EMBEDDED fallback, Tests/ excluded) into ${a.project}`);
  if (a.dryRun) console.log("    (--dry-run: no files will be written)");

  // Extract the tarball to a temp dir; its `package/` holds the full source.
  const tmp = mkdtempSync(path.join(tmpdir(), "loombridge-bridge-"));
  try {
    extractTarball(tgz, tmp);
    const src = path.join(tmp, "package");
    if (!existsSync(src)) throw new RuntimeFailure("tarball did not contain a package/ root");

    // Remove any file: dependency for the id (embedded is auto-discovered).
    const manifestPath = path.join(a.project, "Packages", "manifest.json");
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (manifest.dependencies && PKG_ID in manifest.dependencies) {
        console.log(`  !! removing manifest dependency "${PKG_ID}" (embedded copy is auto-discovered)`);
        delete manifest.dependencies[PKG_ID];
        if (!a.dryRun) writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      }
    }

    const dest = path.join(a.project, "Packages", PKG_ID);
    console.log(`  -> Packages/${PKG_ID}/ (excluding Tests/)`);
    if (!a.dryRun) {
      rmSync(dest, { recursive: true, force: true });
      mkdirSync(dest, { recursive: true });
      for (const entry of readdirSync(src)) {
        if (entry === "Tests" || entry === "Tests.meta") continue;
        cpSync(path.join(src, entry), path.join(dest, entry), { recursive: true });
      }
      if (existsSync(path.join(dest, "Tests")) || existsSync(path.join(dest, "Tests.meta"))) {
        throw new RuntimeFailure("Tests/ leaked into the embedded package");
      }
    }

    // The agent-routing front door — install the workflow, not just the wiring.
    const routingDoc = syncRoutingDoc(a.project, a.dryRun);

    const metaPath = writeMetadata(
      a.project,
      {
        schemaVersion: 1,
        installedAt: new Date().toISOString(),
        cliVersion: resolveBuildStamp().version,
        bridgeVersion: version,
        bridgeProtocol: REQUIRED_PROTOCOL_VERSION,
        installMode: "embedded-package",
        packageId: PKG_ID,
        routingDoc,
      },
      a.dryRun,
    );
    console.log(`  -> ProjectSettings/${path.basename(metaPath)} (installMode: embedded-package)`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  console.log("");
  console.log("==> Done. Open the project in Unity to let the bridge compile.");
  return 0;
}

function printUsage(): void {
  console.log(
    [
      "Usage: loombridge install-bridge --project <unity-project-dir> [options]",
      "",
      "Install the Loombridge Unity bridge into a consumer project without cloning the",
      "Loombridge repo. Default: add the bundled bridge .tgz as a file: immutable",
      "dependency in Packages/manifest.json (Tests/ self-exclude; PackageCache is",
      "read-only). Writes ProjectSettings/LoombridgeInstall.json.",
      "",
      "Options:",
      "  --project, -p <dir>   Target Unity project (required)",
      "  --embedded            Fallback: physically copy the package (Tests/ stripped)",
      "  --tarball <path>      Use this bridge .tgz instead of the CLI-bundled one",
      "                        (also honors $LOOMBRIDGE_BRIDGE_TARBALL)",
      "  --dry-run             Print the plan without writing any files",
      "  -h, --help            Show this help",
      "",
      "Exit codes: 0 installed · 1 filesystem/runtime failure · 2 usage/validation.",
    ].join("\n"),
  );
}

/**
 * Perform an install for already-parsed args. Exported so `loombridge update` can
 * reuse the exact same file operations (tarball swap / embedded refresh) instead
 * of reimplementing them. Returns the process exit code (0/1/2).
 */
export async function installBridge(parsed: InstallArgs): Promise<number> {
  try {
    assertUnityProject(parsed.project);
    return parsed.mode === "embedded" ? await installEmbedded(parsed) : await installTarball(parsed);
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`[loombridge install-bridge] ${error.message}`);
      return 2;
    }
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[loombridge install-bridge] ${message}`);
    return 1;
  }
}

export async function run(args: string[]): Promise<number> {
  const parsed = parseArgs(args);
  if ("help" in parsed) {
    printUsage();
    return parsed.usageError ? 2 : 0;
  }
  const code = await installBridge(parsed);
  // Nudge the OPTIONAL agent surface exactly once — only when the choice is UNSET.
  // install-bridge never installs the surface itself; it only points at install-agent.
  // (Kept out of installBridge() so `update`, which reuses it, hints via its own path.)
  if (code === 0) printAgentSurfaceHintIfUnset(parsed.project);
  return code;
}
