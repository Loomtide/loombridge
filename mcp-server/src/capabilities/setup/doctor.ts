/**
 * `loombridge doctor` — health check for the local install + a project's bridge
 * wiring, with an actionable remediation on every failed row.
 *
 * Offline (always): CLI build stamp, Node version, the CLI-bundled bridge tarball.
 * With `--project`: the install metadata (`LoombridgeInstall.json`), the manifest
 * `file:` dependency, the dropped tarball's presence + sha integrity, drift of the
 * installed bridge vs the CLI-bundled bridge, the expected protocol, and the MCP
 * registration in `.mcp.json`.
 * With `--live` (and `--project`): connects to the running Unity bridge and runs
 * the SAME protocol preflight (`evaluatePrerequisiteChecks`) the capture path uses.
 *
 * Exit codes: 0 healthy (no fail rows) · 1 problems found · 2 usage error.
 * `--ci` emits the report as JSON (same exit code) for pipelines.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { REQUIRED_PROTOCOL_VERSION } from "../../bridge/preflight/prerequisite-checks.js";
import { resolveBuildStamp } from "../../shared/build-stamp.js";
import {
  InstallMetadata,
  METADATA_RELPATH,
  PKG_ID,
  SUPERSEDED_PKG_IDS,
  bundledBridgeFreshness,
  judgeBridgeFreshness,
  locateBridgeTarball,
  looksLikeUnityProject,
  readInstallMetadata,
  readTarballVersion,
  sha256File,
} from "./bridge-install-common.js";
import {
  MCP_CONFIG_RELPATH,
  MCP_SERVER_KEY,
  canonicalJson,
  desiredServerEntry,
  entrySha,
  isLoombridgeAuthoredEntry,
} from "./install-mcp.js";
import { ROUTING_DOC_RELPATH, ROUTING_DOC_VERSION, parseRoutingDocVersion } from "./routing-doc.js";
import { detectGenerationBackends, generationBackendsDoctorDetail } from "./generation-backends.js";

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

  // Which hero-shot generation backends this machine can OFFER. INFO on purpose: an optional
  // accelerator being absent is a supported configuration, not a missing dependency, and
  // `claude` is always available so the count is never zero. See generation-backends.ts.
  const backends = safe(() => detectGenerationBackends()) ?? [];
  if (backends.length > 0) {
    checks.push({
      id: "generation.backends",
      label: "Hero-shot backends",
      status: "info",
      detail: generationBackendsDoctorDetail(backends),
    });
  }

  const located = safe(() => locateBridgeTarball());
  if (!located) {
    checks.push({
      id: "bridge.bundled",
      label: "Bundled bridge tarball",
      status: "fail",
      detail: "no bridge tarball ships with this CLI build",
      remediation: "In the dev repo, run scripts/loombridge-pack-bridge.sh (CI should bundle it into loombridge).",
    });
    // The freshness row is pushed even here: a check that vanishes when its input is
    // missing reads, in the JSON report and to the eye, exactly like a check that passed.
    checks.push({
      id: "bridge.freshness",
      label: "Bundled bridge freshness",
      status: "fail",
      detail: "no tarball to grade",
    });
    return {};
  }
  const tgz = located.path;
  const bundledVersion = safe(() => readTarballVersion(tgz));
  const bundledSha = safe(() => sha256File(tgz));
  checks.push({
    id: "bridge.bundled",
    label: "Bundled bridge tarball",
    status: "pass",
    detail: `${PKG_ID}@${bundledVersion ?? "unknown"} (${path.basename(tgz)})`,
  });

  // Is that tarball actually built from the sources this CLI ships? The `.tgz.sha256`
  // sidecar cannot answer this (it hashes the tarball itself), which is how a symlinked
  // global install kept delivering a bridge packed months earlier while every row here
  // stayed green.
  let freshness;
  try {
    freshness = bundledBridgeFreshness(tgz);
  } catch (error) {
    // An unreadable archive or source tree is its OWN failed row. Never a skipped one:
    // the whole point of this guard is that a check which cannot run must be loud.
    checks.push({
      id: "bridge.freshness",
      label: "Bundled bridge freshness",
      status: "fail",
      detail: `could not be evaluated (${error instanceof Error ? error.message.split("\n")[0] : String(error)})`,
      remediation: "Re-pack or reinstall the bridge bundle, then re-run doctor.",
    });
    return { bundledVersion, bundledSha };
  }
  const judged = judgeBridgeFreshness(freshness, tgz);
  switch (judged.disposition) {
    case "ok":
      checks.push({ id: "bridge.freshness", label: "Bundled bridge freshness", status: "pass", detail: judged.detail });
      break;
    case "info":
      checks.push({ id: "bridge.freshness", label: "Bundled bridge freshness", status: "info", detail: judged.detail });
      break;
    case "reject":
      checks.push({
        id: "bridge.freshness",
        label: "Bundled bridge freshness",
        status: "fail",
        detail: judged.consequence ? `${judged.detail}; ${judged.consequence}` : judged.detail,
        remediation: judged.remediation,
      });
      break;
    default: {
      const exhaustive: never = judged.disposition;
      throw new Error(`unhandled freshness disposition: ${String(exhaustive)}`);
    }
  }
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
    // The MCP registration does not depend on the bridge install, and a row that vanishes
    // when a NEIGHBOURING check fails reads exactly like a row that passed.
    checkMcpRegistration(project, meta, checks);
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

  // The MCP registration (.mcp.json): the step that connects an agent to Unity at all.
  checkMcpRegistration(project, meta, checks);

  // The OPTIONAL agent surface (commands + skills). Absence/decline is NEVER a failure.
  checkAgentSurface(project, meta, checks);

  // Drift: is a newer bridge bundled with this CLI than what the project has?
  //
  // Pushed UNCONDITIONALLY. The previous `if (bundled.bundledVersion && ...)` shape meant
  // an UNREADABLE bundled version silently removed the row, so a report with nothing to
  // compare against was indistinguishable from a report that compared and agreed. Absence
  // of a bound field is a refusal here, not a skip.
  if (!bundled.bundledVersion) {
    checks.push({
      id: "bridge.drift",
      label: "Bridge up to date",
      status: "fail",
      detail: `cannot compare: the CLI-bundled bridge version could not be read (project has ${meta.bridgeVersion})`,
      remediation: "Re-pack or reinstall the bridge bundle, then re-run doctor.",
    });
  } else if (bundled.bundledVersion !== meta.bridgeVersion) {
    checks.push({
      id: "bridge.drift",
      label: "Bridge up to date",
      status: "warn",
      detail: `project has ${meta.bridgeVersion}; CLI bundles ${bundled.bundledVersion}`,
      remediation: `Update available, run: loombridge update --project ${project}  (until update lands: ${installCmd})`,
    });
  } else {
    checks.push({
      id: "bridge.drift",
      label: "Bridge up to date",
      status: "pass",
      detail: `project and CLI both at ${meta.bridgeVersion}`,
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

/** A plain JSON object (not an array, not null): the only shape `.mcp.json` may take. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The MCP registration in `.mcp.json`, the step that actually connects an agent to Unity,
 * and the one thing `setup` performs that nothing here used to grade.
 *
 * DELIBERATELY re-derived from the file ON DISK, then compared to the ledger, never reported
 * FROM the ledger. `mcpRegistration: { state: "enabled" }` proves nothing once the developer
 * has deleted `.mcp.json` or rewritten the entry, the same reason the tarball sha and the
 * routing doc are recomputed at read.
 *
 * WHY A MISSING REGISTRATION IS A WARN, not a fail and not an info. An agent cannot drive
 * Unity without it, so it is not as optional as the slash commands (info, never a nag). But a
 * developer who only ever runs the deterministic CLI never needs it, and doctor's exit code
 * is the verdict on whether the install is BROKEN. Missing therefore grades exactly like a
 * missing routing doc: loud, remediated, and not a failed install.
 *
 *   absent file / no `loombridge` key       → warn  + install-mcp
 *   unreadable, malformed, or not a config  → fail  (a check that cannot run must be loud)
 *   entry == what this CLI would write      → pass
 *   ours (ledger or a shape we shipped)     → warn  + install-mcp will upgrade it in place
 *   anything else                           → info  left as authored; the entry is theirs
 *
 * Ownership is decided by install-mcp's OWN predicate, never by a second copy of the rule
 * here: doctor must not advise `install-mcp` on an entry install-mcp would refuse, nor call
 * an entry the developer's that install-mcp is about to rewrite.
 */
function checkMcpRegistration(project: string, meta: InstallMetadata | null, checks: DoctorCheck[]): void {
  const push = (status: CheckStatus, detail: string, remediation?: string) =>
    checks.push({ id: "mcp.registration", label: `MCP registration (${MCP_CONFIG_RELPATH})`, status, detail, remediation });
  const installCmd = `loombridge install-mcp --project ${project}`;

  const configPath = path.join(project, MCP_CONFIG_RELPATH);
  if (!existsSync(configPath)) {
    push("warn", `no ${MCP_CONFIG_RELPATH}: no MCP client can reach Unity through this project`, installCmd);
    return;
  }
  const raw = safe(() => readFileSync(configPath, "utf8"));
  if (raw === undefined) {
    push("fail", `${MCP_CONFIG_RELPATH} exists but cannot be read as a file`, `Remove/fix the path, then: ${installCmd}`);
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    // NEVER a silent pass. A file no client can parse is a file no client is reading, and
    // install-mcp refuses to rewrite it (that would discard servers it never read), so the
    // developer has to fix it by hand, which they will only do if doctor says so.
    push(
      "fail",
      `${MCP_CONFIG_RELPATH} is not valid JSON (${(error as Error).message.split("\n")[0]}): no MCP client can read it`,
      `Fix the file by hand (install-mcp refuses to rewrite it), then: ${installCmd}`,
    );
    return;
  }
  if (!isPlainObject(parsed)) {
    push("fail", `${MCP_CONFIG_RELPATH} is valid JSON but not an object, so it holds no servers`, `Fix the file by hand, then: ${installCmd}`);
    return;
  }
  const servers = parsed.mcpServers;
  if (servers !== undefined && !isPlainObject(servers)) {
    push("fail", `${MCP_CONFIG_RELPATH} has an "mcpServers" key that is not an object`, `Fix the file by hand, then: ${installCmd}`);
    return;
  }
  const entry = isPlainObject(servers) ? servers[MCP_SERVER_KEY] : undefined;
  if (entry === undefined) {
    push("warn", `no "${MCP_SERVER_KEY}" server in ${MCP_CONFIG_RELPATH}: an agent has no route to Unity`, installCmd);
    return;
  }

  const ledgerSha = meta?.mcpRegistration?.entrySha256;
  if (entrySha(entry) === entrySha(desiredServerEntry())) {
    // Correct wiring is correct wiring whether or not the ledger claims it: an entry a human
    // typed that happens to be exactly ours is adopted by nobody and works for everybody.
    push("pass", `"${MCP_SERVER_KEY}": ${canonicalJson(entry)}${ledgerSha === undefined ? " (not recorded as ours)" : ""}`);
    return;
  }
  if (isLoombridgeAuthoredEntry(entry, ledgerSha)) {
    push(
      "warn",
      `registered as ${canonicalJson(entry)}; this CLI writes ${canonicalJson(desiredServerEntry())}`,
      installCmd,
    );
    return;
  }
  // Hand-edited or hand-authored: honestly the developer's, exactly the stance install-agent
  // takes toward a managed file whose bytes have changed. Not broken, not nagged at.
  push(
    "info",
    `registered as ${canonicalJson(entry)}, left as authored (Loombridge does not manage an entry it did not write)`,
  );
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

/**
 * Grade the PROJECT's tarball against the CLI's bundle, byte for byte.
 *
 * `bundledSha` was accepted by this function and never read: doctor compared versions and
 * stopped there, so "same version, different bytes" (a project holding a tarball packed
 * from different sources than the CLI now bundles) was invisible. That state is ALWAYS a
 * mistake, because the version string is the only thing a re-pack does not change.
 * Pushed unconditionally, including from the early-exit paths, so an absent input is a
 * failed comparison rather than a missing row.
 */
function pushContentDrift(
  project: string,
  meta: InstallMetadata,
  bundled: { bundledVersion?: string; bundledSha?: string },
  actualSha: string | undefined,
  checks: DoctorCheck[],
): void {
  const push = (status: CheckStatus, detail: string, remediation?: string) =>
    checks.push({ id: "bridge.content-drift", label: "Bridge bytes match the CLI bundle", status, detail, remediation });

  if (!bundled.bundledSha || !bundled.bundledVersion) {
    push("fail", "cannot compare: the CLI-bundled tarball could not be hashed or versioned");
    return;
  }
  if (actualSha === undefined) {
    push("fail", "cannot compare: the project's tarball could not be hashed", `loombridge update --project ${project}`);
    return;
  }
  if (bundled.bundledVersion !== meta.bridgeVersion) {
    // Different versions are the "Bridge up to date" row's business; comparing bytes
    // across versions would just restate it.
    push("info", `different versions (project ${meta.bridgeVersion}, CLI ${bundled.bundledVersion}), see Bridge up to date`);
    return;
  }
  const same = actualSha === bundled.bundledSha;
  push(
    same ? "pass" : "fail",
    same
      ? `same version and same bytes (${bundled.bundledVersion})`
      : `SAME version ${meta.bridgeVersion} but DIFFERENT bytes (project=${actualSha.slice(0, 12)}…, CLI bundle=${bundled.bundledSha.slice(0, 12)}…); the editor is running a different bridge than this CLI ships`,
    same ? undefined : `loombridge update --project ${project}`,
  );
}

function checkTarballWiring(
  project: string,
  meta: InstallMetadata,
  bundled: { bundledVersion?: string; bundledSha?: string },
  checks: DoctorCheck[],
  installCmd: string,
): void {
  // Manifest file: dependency present and pointing at the recorded tarball.
  const manifestPath = path.join(project, "Packages", "manifest.json");
  let dep: string | undefined;
  let declaredSuperseded: string[] = [];
  if (existsSync(manifestPath)) {
    try {
      const deps = JSON.parse(readFileSync(manifestPath, "utf8"))?.dependencies ?? {};
      dep = deps[PKG_ID];
      declaredSuperseded = SUPERSEDED_PKG_IDS.filter((id) => id in deps);
    } catch {
      /* reported below as a missing dep */
    }
  }

  // A predecessor bridge declared alongside ours is not a warning: both packages define
  // namespace UnityBridge with an [InitializeOnLoad] bootstrap, so Unity starts two bridge
  // servers on the same port and CS0433s on the duplicated types. Such a project cannot
  // compile, and doctor previously called it "healthy (0 warnings)".
  if (declaredSuperseded.length > 0) {
    checks.push({
      id: "manifest.superseded-bridge",
      label: "Conflicting bridge package",
      status: "fail",
      detail:
        `manifest.json also declares ${declaredSuperseded.map((id) => `"${id}"`).join(", ")} — ` +
        `two bridges define the same UnityBridge types and both auto-start`,
      remediation: `remove the ${declaredSuperseded.join(", ")} dependency from Packages/manifest.json, or re-run: ${installCmd}`,
    });
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
    pushContentDrift(project, meta, bundled, undefined, checks);
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
    pushContentDrift(project, meta, bundled, undefined, checks);
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

  // The project is graded against the CLI's bundle, not just against its own metadata:
  // a record can agree with the file beside it and both can be months behind the bundle.
  pushContentDrift(project, meta, bundled, actualSha, checks);
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
    const { UnityClient, isRouteMismatchError } = await import("../../bridge/unity-client.js");
    const { evaluatePrerequisiteChecks } = await import("../../bridge/preflight/prerequisite-checks.js");
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
