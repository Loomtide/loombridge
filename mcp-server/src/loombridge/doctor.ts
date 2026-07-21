/**
 * `loombridge doctor` — health check for the local install + a project's bridge
 * wiring, with an actionable remediation on every failed row.
 *
 * Offline (always): CLI build stamp, Node version, the CLI-bundled bridge tarball.
 * With `--project`: the install metadata (`LoombridgeInstall.json`), the manifest
 * `file:` dependency, the dropped tarball's presence + sha integrity, drift of the
 * installed bridge vs the CLI-bundled bridge, and the expected protocol.
 * With `--live` (and `--project`): connects to the running Unity bridge and runs
 * the SAME protocol preflight (`evaluatePrerequisiteChecks`) the capture path uses.
 *
 * Exit codes: 0 healthy (no fail rows) · 1 problems found · 2 usage error.
 * `--ci` emits the report as JSON (same exit code) for pipelines.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { REQUIRED_PROTOCOL_VERSION } from "../preflight/prerequisite-checks.js";
import { resolveBuildStamp } from "./build-stamp.js";
import {
  InstallMetadata,
  METADATA_RELPATH,
  PKG_ID,
  looksLikeUnityProject,
  readInstallMetadata,
  readTarballVersion,
  resolveBundledTarball,
  sha256File,
} from "./bridge-install-common.js";
import { ROUTING_DOC_RELPATH, ROUTING_DOC_VERSION, parseRoutingDocVersion } from "./routing-doc.js";

type CheckStatus = "pass" | "warn" | "fail" | "info";

interface DoctorCheck {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  /** Exact command to fix a warn/fail row. */
  remediation?: string;
}

interface DoctorArgs {
  project?: string;
  live: boolean;
  ci: boolean;
}

type ParseHelp = { help: true; usageError?: boolean };

function parseArgs(args: string[]): DoctorArgs | ParseHelp {
  let project: string | undefined;
  let live = false;
  let ci = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--project" || arg === "-p") project = path.resolve(args[(i += 1)] ?? "");
    else if (arg === "--live") live = true;
    else if (arg === "--ci") ci = true;
    else if (arg === "--help" || arg === "-h") return { help: true };
    else {
      console.error(`[loombridge doctor] unknown argument "${arg}".`);
      return { help: true, usageError: true };
    }
  }
  return { project, live, ci };
}

// --- offline checks -------------------------------------------------------

function checkLocalInstall(checks: DoctorCheck[]): { bundledVersion?: string; bundledSha?: string } {
  const stamp = resolveBuildStamp();
  checks.push({
    id: "cli.version",
    label: "CLI build",
    status: "info",
    detail: `loombridge ${stamp.version} (${stamp.commit}, ${stamp.stampStatus})`,
  });

  const nodeMajor = Number(process.versions.node.split(".")[0]);
  checks.push({
    id: "node.version",
    label: "Node runtime",
    status: nodeMajor >= 18 ? "pass" : "warn",
    detail: `node ${process.versions.node}`,
    remediation: nodeMajor >= 18 ? undefined : "Install Node 18+ (Loombridge targets an active LTS).",
  });

  const tgz = safe(() => resolveBundledTarball());
  if (!tgz) {
    checks.push({
      id: "bridge.bundled",
      label: "Bundled bridge tarball",
      status: "fail",
      detail: "no bridge tarball ships with this CLI build",
      remediation: "In the dev repo, run scripts/loombridge-pack-bridge.sh (CI should bundle it into @loomtide/loombridge).",
    });
    return {};
  }
  const bundledVersion = safe(() => readTarballVersion(tgz)) ?? "unknown";
  const bundledSha = safe(() => sha256File(tgz));
  checks.push({
    id: "bridge.bundled",
    label: "Bundled bridge tarball",
    status: "pass",
    detail: `${PKG_ID}@${bundledVersion} (${path.basename(tgz)})`,
  });
  return { bundledVersion, bundledSha };
}

function checkProjectWiring(
  project: string,
  bundled: { bundledVersion?: string; bundledSha?: string },
  checks: DoctorCheck[],
): void {
  const installCmd = `loombridge install-bridge --project ${project}`;

  if (!looksLikeUnityProject(project)) {
    checks.push({
      id: "project.valid",
      label: "Unity project",
      status: "fail",
      detail: `${project} is not a Unity project`,
      remediation: "Point --project at a directory with Assets/ or ProjectSettings/ProjectVersion.txt.",
    });
    return;
  }
  checks.push({ id: "project.valid", label: "Unity project", status: "pass", detail: project });

  const meta = readInstallMetadata(project);
  // `install-agent` (run before `install-bridge`) writes a record with ONLY the agentSurface
  // block — so a bare `!meta` guard would be bypassed and print a green "Bridge install:
  // undefined" row. Treat "record present but no bridge fields" the same as no install.
  if (!meta || !meta.installMode || !meta.bridgeVersion) {
    checks.push({
      id: "install.metadata",
      label: "Bridge install",
      status: "fail",
      detail: `no bridge in ${METADATA_RELPATH} — bridge not installed by Loombridge`,
      remediation: installCmd,
    });
    // Still surface the OPTIONAL agent-surface state if a record exists (install-agent may
    // have run first) — but never as a green bridge row.
    if (meta) checkAgentSurface(project, meta, checks);
    return;
  }
  checks.push({
    id: "install.metadata",
    label: "Bridge install",
    status: "pass",
    detail: `${meta.installMode} · bridge ${meta.bridgeVersion} · protocol ${meta.bridgeProtocol}`,
  });

  // Protocol expectation (offline): the metadata records what protocol this bridge
  // speaks; compare to the CLI's REQUIRED_PROTOCOL_VERSION (single source of truth).
  checks.push({
    id: "install.protocol",
    label: "Protocol compatibility",
    status: meta.bridgeProtocol === REQUIRED_PROTOCOL_VERSION ? "pass" : "fail",
    detail: `installed=${meta.bridgeProtocol}; CLI expects=${REQUIRED_PROTOCOL_VERSION}`,
    remediation:
      meta.bridgeProtocol === REQUIRED_PROTOCOL_VERSION
        ? undefined
        : `Protocol mismatch — reinstall the matching bridge: ${installCmd}`,
  });

  if (meta.installMode === "tarball-dependency") {
    checkTarballWiring(project, meta, bundled, checks, installCmd);
  } else {
    // Embedded fallback: verify the physical package is present + Tests-free.
    const dest = path.join(project, "Packages", PKG_ID);
    const editorOk = existsSync(path.join(dest, "Editor"));
    const testsLeaked = existsSync(path.join(dest, "Tests"));
    checks.push({
      id: "bridge.embedded",
      label: "Embedded bridge",
      status: editorOk && !testsLeaked ? "pass" : "fail",
      detail: `${dest}${testsLeaked ? " (Tests/ leaked — will break the consumer compile)" : ""}`,
      remediation: editorOk && !testsLeaked ? undefined : `${installCmd} --embedded`,
    });
  }

  // The agent-routing front door (LOOMBRIDGE.md) — present + our marker + current = healthy.
  checkRoutingDoc(project, checks, installCmd);

  // The OPTIONAL agent surface (commands + skills). Absence/decline is NEVER a failure.
  checkAgentSurface(project, meta, checks);

  // Drift: is a newer bridge bundled with this CLI than what the project has?
  if (bundled.bundledVersion && bundled.bundledVersion !== meta.bridgeVersion) {
    checks.push({
      id: "bridge.drift",
      label: "Bridge up to date",
      status: "warn",
      detail: `project has ${meta.bridgeVersion}; CLI bundles ${bundled.bundledVersion}`,
      remediation: `Update available — run: loombridge update --project ${project}  (until update lands: ${installCmd})`,
    });
  }
}

/**
 * The agent-routing front door. DELIBERATELY re-derived from the file ON DISK — never
 * from the install record's informational `routingDoc` field — because disk is the honest
 * check (like the tarball sha): metadata saying "written" proves nothing if the user has
 * since deleted or replaced the file. Graded against the CLI's current ROUTING_DOC_VERSION:
 *   - present, our marker, current/newer → pass
 *   - present, our marker, older         → warn (stale) + install-bridge remediation
 *   - present, NO marker (user-authored) → info (we deliberately don't manage it)
 *   - absent                             → warn (missing) + install-bridge remediation
 *   - unreadable (e.g. it's a directory) → warn, never a doctor crash
 */
function checkRoutingDoc(project: string, checks: DoctorCheck[], installCmd: string): void {
  const docPath = path.join(project, ROUTING_DOC_RELPATH);
  if (!existsSync(docPath)) {
    checks.push({
      id: "routing.doc",
      label: "Agent routing (LOOMBRIDGE.md)",
      status: "warn",
      detail: `missing ${ROUTING_DOC_RELPATH} — the agent front door is not installed`,
      remediation: installCmd,
    });
    return;
  }
  const content = safe(() => readFileSync(docPath, "utf8"));
  if (content === undefined) {
    checks.push({
      id: "routing.doc",
      label: "Agent routing (LOOMBRIDGE.md)",
      status: "warn",
      detail: `${ROUTING_DOC_RELPATH} exists but cannot be read as a file`,
      remediation: `Remove/fix the path, then re-run: ${installCmd}`,
    });
    return;
  }
  const onDisk = parseRoutingDocVersion(content);
  if (onDisk === null) {
    checks.push({
      id: "routing.doc",
      label: "Agent routing (LOOMBRIDGE.md)",
      status: "info",
      detail: `present without the Loombridge marker — left as-authored (Loombridge won't manage it)`,
    });
    return;
  }
  if (onDisk < ROUTING_DOC_VERSION) {
    checks.push({
      id: "routing.doc",
      label: "Agent routing (LOOMBRIDGE.md)",
      status: "warn",
      detail: `stale (v${onDisk}; CLI ships v${ROUTING_DOC_VERSION})`,
      remediation: installCmd,
    });
    return;
  }
  checks.push({
    id: "routing.doc",
    label: "Agent routing (LOOMBRIDGE.md)",
    status: "pass",
    detail: `v${onDisk}`,
  });
}

/**
 * The OPTIONAL project-scoped agent surface. Absence and decline are BOTH fine — this row
 * never FAILS and never THROWS (an optional surface must never be able to crash or fail
 * doctor, and checkProjectWiring is not safe()-wrapped). A malformed record is a WARN, not
 * an uncaught TypeError.
 *   unset                    → info  "(optional) agent surface not installed"
 *   enabled, current         → pass
 *   enabled, stale           → warn + refresh command
 *   declined                 → info  "agent surface declined (by choice)"
 *   malformed / unknown state→ warn  "re-run install-agent"
 */
function checkAgentSurface(project: string, meta: InstallMetadata, checks: DoctorCheck[]): void {
  const push = (status: CheckStatus, detail: string, remediation?: string) =>
    checks.push({ id: "agent.surface", label: "Agent surface (optional)", status, detail, remediation });

  const surface = meta.agentSurface as InstallMetadata["agentSurface"] | undefined;
  if (!surface || typeof surface !== "object") {
    push("info", `(optional) agent surface not installed — loombridge install-agent --project ${project}`);
    return;
  }
  if (surface.state === "declined") {
    push("info", "agent surface declined (by choice)");
    return;
  }
  // Any other shape must be defensive: an enabled block whose `files` is absent/null/not an
  // array is a CORRUPT record — warn (with the self-heal command), never dereference `.length`.
  if (surface.state !== "enabled" || !Array.isArray(surface.files)) {
    push(
      "warn",
      "agentSurface record malformed — re-run install-agent",
      `loombridge install-agent --project ${project}`,
    );
    return;
  }
  const cliVersion = resolveBuildStamp().version;
  const current = surface.cliVersion === cliVersion;
  push(
    current ? "pass" : "warn",
    current
      ? `enabled — ${surface.files.length} managed file(s), cli ${surface.cliVersion}`
      : `enabled but stale (installed with cli ${surface.cliVersion}; this CLI is ${cliVersion})`,
    current ? undefined : `loombridge install-agent --project ${project}`,
  );
}

function checkTarballWiring(
  project: string,
  meta: InstallMetadata,
  bundled: { bundledSha?: string },
  checks: DoctorCheck[],
  installCmd: string,
): void {
  // Manifest file: dependency present and pointing at the recorded tarball.
  const manifestPath = path.join(project, "Packages", "manifest.json");
  let dep: string | undefined;
  if (existsSync(manifestPath)) {
    try {
      dep = JSON.parse(readFileSync(manifestPath, "utf8"))?.dependencies?.[PKG_ID];
    } catch {
      /* reported below as a missing dep */
    }
  }
  const expectedRef = meta.tarball ? `file:${meta.tarball}` : undefined;
  checks.push({
    id: "manifest.dependency",
    label: "manifest.json dependency",
    status: dep && dep === expectedRef ? "pass" : "fail",
    detail: dep ? `"${PKG_ID}": "${dep}"` : `no "${PKG_ID}" dependency in manifest.json`,
    remediation: dep && dep === expectedRef ? undefined : installCmd,
  });

  // The dropped tarball must exist and match the recorded sha (integrity).
  if (!meta.tarball) {
    checks.push({
      id: "tarball.present",
      label: "Bridge tarball file",
      status: "fail",
      detail: "metadata has no tarball path",
      remediation: installCmd,
    });
    return;
  }
  const tarballPath = path.join(project, "Packages", meta.tarball);
  if (!existsSync(tarballPath)) {
    checks.push({
      id: "tarball.present",
      label: "Bridge tarball file",
      status: "fail",
      detail: `missing ${meta.tarball}`,
      remediation: installCmd,
    });
    return;
  }
  const actualSha = safe(() => sha256File(tarballPath));
  checks.push({
    id: "tarball.integrity",
    label: "Bridge tarball integrity",
    status: actualSha === meta.tarballSha256 ? "pass" : "fail",
    detail:
      actualSha === meta.tarballSha256
        ? `sha256 matches metadata`
        : `sha256 mismatch (file=${actualSha?.slice(0, 12)}…, metadata=${meta.tarballSha256?.slice(0, 12)}…)`,
    remediation: actualSha === meta.tarballSha256 ? undefined : `Tarball altered — reinstall: ${installCmd}`,
  });
}

// --- live check -----------------------------------------------------------

async function checkLiveBridge(checks: DoctorCheck[], project?: string): Promise<void> {
  let client:
    | {
        connect: () => Promise<unknown>;
        disconnect: () => Promise<void>;
        handshake: unknown;
        activeTransport: "ipc" | "tcp" | null;
        activeEndpoint: string | null;
      }
    | undefined;
  try {
    const { UnityClient, isRouteMismatchError } = await import("../unity-client.js");
    const { evaluatePrerequisiteChecks } = await import("../preflight/prerequisite-checks.js");
    // Pin to --project so we validate the INTENDED editor, not whatever bridge is
    // reachable on the ports (a different project could be open).
    client = new UnityClient(
      project ? { targetIdentity: { projectPathCanonical: project } } : {},
    ) as unknown as typeof client;
    let handshake: { pluginVersion?: string; protocolVersion?: number };
    try {
      handshake = (await client!.connect()) as { pluginVersion?: string; protocolVersion?: number };
    } catch (connectErr) {
      if (project && isRouteMismatchError(connectErr)) {
        checks.push({
          id: "live.reachable",
          label: "Unity bridge (live)",
          status: "fail",
          detail: "a bridge is running, but it is a DIFFERENT project than --project",
          remediation: `Open ${project} in Unity (close the other editor or point --project at the open one).`,
        });
        return;
      }
      throw connectErr;
    }
    checks.push({
      id: "live.reachable",
      label: "Unity bridge (live)",
      status: "pass",
      detail: `handshake ok — plugin ${handshake.pluginVersion ?? "?"}, protocol ${handshake.protocolVersion ?? "?"}`,
    });
    // Name the transport that actually won. Without this an IPC→TCP fallback is invisible
    // in both the console and the --ci JSON, so a broken IPC path can pass unnoticed.
    const activeTransport = client!.activeTransport;
    if (activeTransport) {
      checks.push({
        id: "live.transport",
        label: "Live transport",
        status: "info",
        detail: `${activeTransport}${client!.activeEndpoint ? ` — ${client!.activeEndpoint}` : ""}`,
      });
    }
    const evaln = evaluatePrerequisiteChecks("editor.get_state", handshake as never);
    const protoBlocked = evaln.blockers.some((b) => b.signature === "PROTOCOL_VERSION_MISMATCH");
    checks.push({
      id: "live.protocol",
      label: "Live protocol preflight",
      status: protoBlocked ? "fail" : "pass",
      detail: protoBlocked
        ? `bridge protocol ${handshake.protocolVersion} ≠ expected ${REQUIRED_PROTOCOL_VERSION}`
        : `protocol ${handshake.protocolVersion} accepted`,
      remediation: protoBlocked ? "Update the bridge and CLI to matching protocol versions." : undefined,
    });
  } catch (error) {
    checks.push({
      id: "live.reachable",
      label: "Unity bridge (live)",
      status: "warn",
      detail: `not reachable (${error instanceof Error ? error.message.split("\n")[0] : String(error)})`,
      remediation: "Open the project in Unity and wait for the bridge to compile, then re-run with --live.",
    });
  } finally {
    try {
      await client?.disconnect();
    } catch {
      /* best-effort */
    }
  }
}

// --- rendering ------------------------------------------------------------

const GLYPH: Record<CheckStatus, string> = { pass: "✓", warn: "⚠", fail: "✗", info: "•" };

function render(checks: DoctorCheck[]): void {
  console.log("loombridge doctor");
  console.log("");
  for (const c of checks) {
    console.log(`  ${GLYPH[c.status]} ${c.label}: ${c.detail}`);
    if (c.remediation && (c.status === "fail" || c.status === "warn")) {
      console.log(`      → ${c.remediation}`);
    }
  }
  const fails = checks.filter((c) => c.status === "fail").length;
  const warns = checks.filter((c) => c.status === "warn").length;
  console.log("");
  console.log(fails === 0 ? `healthy (${warns} warning${warns === 1 ? "" : "s"})` : `${fails} problem${fails === 1 ? "" : "s"} found, ${warns} warning${warns === 1 ? "" : "s"}`);
}

function printUsage(): void {
  console.log(
    [
      "Usage: loombridge doctor [--project <unity-project-dir>] [--live] [--ci]",
      "",
      "Health check for the local Loombridge install and a project's bridge wiring.",
      "Every failed row prints the exact command to fix it.",
      "",
      "Options:",
      "  --project, -p <dir>   Also check this Unity project's bridge install",
      "  --live                Also connect to the running Unity bridge and check protocol",
      "  --ci                  Emit the report as JSON (same exit code)",
      "  -h, --help            Show this help",
      "",
      "Exit codes: 0 healthy · 1 problems found · 2 usage error.",
    ].join("\n"),
  );
}

function safe<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

export async function run(args: string[]): Promise<number> {
  const parsed = parseArgs(args);
  if ("help" in parsed) {
    printUsage();
    return parsed.usageError ? 2 : 0;
  }
  const checks: DoctorCheck[] = [];
  const bundled = checkLocalInstall(checks);
  if (parsed.project) checkProjectWiring(parsed.project, bundled, checks);
  if (parsed.live) {
    if (!parsed.project) {
      checks.push({
        id: "live.reachable",
        label: "Unity bridge (live)",
        status: "info",
        detail: "--live attempts a bridge connection regardless of --project",
      });
    }
    await checkLiveBridge(checks, parsed.project);
  }

  if (parsed.ci) {
    const fails = checks.filter((c) => c.status === "fail").length;
    console.log(JSON.stringify({ healthy: fails === 0, checks }, null, 2));
  } else {
    render(checks);
  }
  return checks.some((c) => c.status === "fail") ? 1 : 0;
}
