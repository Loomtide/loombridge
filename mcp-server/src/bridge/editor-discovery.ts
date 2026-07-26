import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type {
  UnityDiscoveryEndpoint,
  UnityEndpointDiscoveryRecord,
} from "../shared/types.js";

export const DISCOVERY_DIR_ENV_VAR = "LOOMBRIDGE_ENDPOINT_DISCOVERY_DIR";
export const DISCOVERY_FILE_ENV_VAR = "LOOMBRIDGE_ENDPOINT_DISCOVERY_FILE";
export const DISCOVERY_LATEST_FILE_NAME = "endpoint-discovery-latest.json";
/**
 * Process-wide project pin: when set, an otherwise-untargeted `UnityClient` routes ONLY to the editor
 * for this canonical project path (and refuses a wrong-project handshake via ROUTE_MISMATCH). Lets a
 * parent command (e.g. the scene-agnostic `minigame check`) resolve one editor once and force every
 * spawned CLI subprocess to the SAME editor, so record/scan can't diverge to different editors when
 * several are open. Unset ⇒ unchanged behaviour; an explicit `targetIdentity` still wins.
 */
export const TARGET_PROJECT_ENV_VAR = "LOOMBRIDGE_TARGET_PROJECT_PATH";

let cachedDarwinUserTempDirectory: string | null | undefined;

export function normalizeProjectPathCanonical(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim().replace(/[\\/]+$/, "");
  return trimmed.length > 0 ? trimmed : null;
}

export function projectPathCanonicalEquals(a: string, b: string): boolean {
  if (process.platform === "win32" || process.platform === "darwin") {
    return a.toLocaleLowerCase() === b.toLocaleLowerCase();
  }
  return a === b;
}

/**
 * Symlink-tolerant project-path equality. The fast path (`projectPathCanonicalEquals`)
 * does the case-folded string compare with no I/O; realpath resolution only runs when
 * that plain compare fails — i.e. rarely — so the common case stays allocation-light.
 * Used for cwd/env-derived target vs Unity-reported `projectPathCanonical`, which can
 * differ by a symlink (e.g. macOS `/tmp` → `/private/tmp`, or any symlinked project/home).
 * Non-existent / unreadable paths resolve to no match rather than throwing.
 */
export function projectPathsEquivalent(a: string, b: string): boolean {
  if (projectPathCanonicalEquals(a, b)) return true;            // fast path, no I/O
  try {
    return projectPathCanonicalEquals(fs.realpathSync(a), fs.realpathSync(b));
  } catch {
    return false;                                               // non-existent / unreadable → no match
  }
}

export function resolveDiscoveryDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const discoveryDir = env[DISCOVERY_DIR_ENV_VAR];
  return typeof discoveryDir === "string" && discoveryDir.trim().length > 0
    ? discoveryDir
    : path.join(resolveRuntimeTempDirectory(env), "loombridge", "unitybridge");
}

export function resolveDiscoveryLatestFilePath(env: NodeJS.ProcessEnv = process.env): string {
  const explicitFile = env[DISCOVERY_FILE_ENV_VAR];
  if (typeof explicitFile === "string" && explicitFile.trim().length > 0) {
    return explicitFile;
  }
  return path.join(resolveDiscoveryDirectory(env), DISCOVERY_LATEST_FILE_NAME);
}

export function parseEndpointDiscoveryRecord(
  raw: string,
  nowMs: number = Date.now(),
): UnityEndpointDiscoveryRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object") {
    return null;
  }

  const maybeRecord = parsed as Partial<UnityEndpointDiscoveryRecord> & { endpoints?: unknown[] };
  if (
    maybeRecord.schemaVersion !== "1"
    || typeof maybeRecord.sessionId !== "string"
    || maybeRecord.sessionId.trim().length === 0
    || typeof maybeRecord.expiresAtUnixMs !== "number"
    || !Array.isArray(maybeRecord.endpoints)
  ) {
    return null;
  }

  if (maybeRecord.expiresAtUnixMs <= nowMs) {
    return null;
  }

  const normalizedEndpoints: UnityDiscoveryEndpoint[] = [];
  for (const endpoint of maybeRecord.endpoints) {
    if (!endpoint || typeof endpoint !== "object") {
      continue;
    }

    const maybeEndpoint = endpoint as Partial<UnityDiscoveryEndpoint>;
    const transport = maybeEndpoint.transport;
    const kind = maybeEndpoint.kind;
    if (transport !== "ipc" && transport !== "tcp") {
      continue;
    }
    if (
      kind !== "unix_domain_socket"
      && kind !== "named_pipe"
      && kind !== "websocket"
    ) {
      continue;
    }

    const supportsHandshake = maybeEndpoint.supportsHandshake ?? true;
    const supportsPing = maybeEndpoint.supportsPing ?? true;
    if (!supportsHandshake) {
      continue;
    }

    if (transport === "ipc") {
      if (kind !== "unix_domain_socket" && kind !== "named_pipe") {
        continue;
      }
      if (typeof maybeEndpoint.path !== "string" || maybeEndpoint.path.trim().length === 0) {
        continue;
      }
      normalizedEndpoints.push({
        transport,
        kind,
        path: maybeEndpoint.path,
        supportsHandshake,
        supportsPing,
      });
      continue;
    }

    if (kind !== "websocket") {
      continue;
    }
    if (typeof maybeEndpoint.host !== "string" || maybeEndpoint.host.trim().length === 0) {
      continue;
    }
    if (
      typeof maybeEndpoint.port !== "number"
      || !Number.isInteger(maybeEndpoint.port)
      || maybeEndpoint.port < 1
      || maybeEndpoint.port > 65535
    ) {
      continue;
    }
    normalizedEndpoints.push({
      transport,
      kind,
      host: maybeEndpoint.host,
      port: maybeEndpoint.port,
      supportsHandshake,
      supportsPing,
    });
  }

  if (normalizedEndpoints.length === 0) {
    return null;
  }

  const transportModeDefault =
    maybeRecord.transportModeDefault === "ipc" || maybeRecord.transportModeDefault === "tcp"
      ? maybeRecord.transportModeDefault
      : "auto";

  return {
    schemaVersion: "1",
    sessionId: maybeRecord.sessionId,
    projectPath: typeof maybeRecord.projectPath === "string"
      ? maybeRecord.projectPath
      : undefined,
    projectPathCanonical: typeof maybeRecord.projectPathCanonical === "string"
      ? maybeRecord.projectPathCanonical
      : undefined,
    projectName: typeof maybeRecord.projectName === "string"
      ? maybeRecord.projectName
      : undefined,
    processId: typeof maybeRecord.processId === "number"
      ? maybeRecord.processId
      : undefined,
    publishedAtUnixMs: typeof maybeRecord.publishedAtUnixMs === "number"
      ? maybeRecord.publishedAtUnixMs
      : nowMs,
    expiresAtUnixMs: maybeRecord.expiresAtUnixMs,
    transportModeDefault,
    endpoints: normalizedEndpoints,
  };
}

export function loadEndpointDiscoveryFile(
  filePath: string,
  nowMs: number = Date.now(),
): UnityEndpointDiscoveryRecord | null {
  try {
    return parseEndpointDiscoveryRecord(fs.readFileSync(filePath, "utf8"), nowMs);
  } catch {
    return null;
  }
}

export function scanEndpointDiscoveryRecords(
  discoveryDir: string = resolveDiscoveryDirectory(),
  nowMs: number = Date.now(),
): UnityEndpointDiscoveryRecord[] {
  let names: string[];
  try {
    names = fs.readdirSync(discoveryDir);
  } catch {
    return [];
  }

  const records: UnityEndpointDiscoveryRecord[] = [];
  for (const name of names) {
    if (!/^endpoint-discovery-.+\.json$/.test(name) || name === DISCOVERY_LATEST_FILE_NAME) {
      continue;
    }
    const record = loadEndpointDiscoveryFile(path.join(discoveryDir, name), nowMs);
    if (record) {
      records.push(record);
    }
  }

  return records.sort(compareDiscoveryRecords);
}

export function collapseReloadChurn(
  records: UnityEndpointDiscoveryRecord[],
): UnityEndpointDiscoveryRecord[] {
  // Group every record by project, dropping any that cannot be routed (no canonical
  // path). Within a project, a distinct processId is a distinct live editor (kept,
  // newest-per-pid); records with NO processId carry no editor identity, so they must
  // NOT each count as a separate peer — otherwise a single editor's stale/identity-less
  // files (left behind across domain reloads until TTL) would trip false EDITOR_AMBIGUOUS.
  const byProject = new Map<string, UnityEndpointDiscoveryRecord[]>();
  for (const record of records) {
    const project = normalizeProjectPathCanonical(record.projectPathCanonical);
    if (!project) {
      continue;
    }
    const key = project.toLocaleLowerCase();
    const group = byProject.get(key);
    if (group) {
      group.push(record);
    } else {
      byProject.set(key, [record]);
    }
  }

  const collapsed: UnityEndpointDiscoveryRecord[] = [];
  for (const group of byProject.values()) {
    const withProcessId = group.filter((record) => typeof record.processId === "number");
    if (withProcessId.length > 0) {
      // One peer per distinct live process, newest record wins.
      const byProcess = new Map<number, UnityEndpointDiscoveryRecord>();
      for (const record of withProcessId) {
        const existing = byProcess.get(record.processId as number);
        if (!existing || compareNewestDiscoveryRecord(record, existing) < 0) {
          byProcess.set(record.processId as number, record);
        }
      }
      collapsed.push(...byProcess.values());
    } else {
      // No process identity for this project at all → collapse to a single newest peer.
      collapsed.push([...group].sort(compareNewestDiscoveryRecord)[0]!);
    }
  }

  return collapsed.sort(compareDiscoveryRecords);
}

export function selectEndpointDiscoveryRecord(
  records: UnityEndpointDiscoveryRecord[],
  targetProjectPathCanonical?: string | null,
): UnityEndpointDiscoveryRecord | null {
  const target = normalizeProjectPathCanonical(targetProjectPathCanonical);
  const collapsed = collapseReloadChurn(records);
  const candidates = target
    ? collapsed.filter((record) => {
      const project = normalizeProjectPathCanonical(record.projectPathCanonical);
      return project ? projectPathCanonicalEquals(project, target) : false;
    })
    : collapsed;

  if (candidates.length === 0) {
    return null;
  }
  return [...candidates].sort(compareNewestDiscoveryRecord)[0] ?? null;
}

export function loadPreferredEndpointDiscovery(
  targetProjectPathCanonical?: string | null,
  env: NodeJS.ProcessEnv = process.env,
  nowMs: number = Date.now(),
): UnityEndpointDiscoveryRecord | null {
  const explicitFile = env[DISCOVERY_FILE_ENV_VAR];
  if (typeof explicitFile === "string" && explicitFile.trim().length > 0) {
    return loadEndpointDiscoveryFile(explicitFile, nowMs);
  }

  const scanned = scanEndpointDiscoveryRecords(resolveDiscoveryDirectory(env), nowMs);
  const selected = selectEndpointDiscoveryRecord(scanned, targetProjectPathCanonical);
  if (selected) {
    return selected;
  }

  return loadEndpointDiscoveryFile(resolveDiscoveryLatestFilePath(env), nowMs);
}

function resolveRuntimeTempDirectory(env: NodeJS.ProcessEnv): string {
  // On macOS the MCP server and the Editor can carry different $TMPDIR values (e.g. a
  // coding agent sets a custom TMPDIR while a GUI-launched Editor uses launchd's per-user
  // dir). Preferring the stable, env-independent DARWIN_USER_TEMP_DIR keeps both processes
  // pointed at the same discovery directory — which is exactly where Path.GetTempPath()
  // resolves for a GUI Editor. The Unity bridge (BridgeServer.ResolveDiscoveryTempBase)
  // resolves the same value; the two MUST stay in sync or multi-editor discovery breaks.
  if (process.platform === "darwin") {
    const darwinUserTempDirectory = resolveDarwinUserTempDirectory();
    if (darwinUserTempDirectory) {
      return darwinUserTempDirectory;
    }
  }

  const envTempDirectory = env.TMPDIR ?? env.TMP ?? env.TEMP;
  if (typeof envTempDirectory === "string" && envTempDirectory.trim().length > 0) {
    return envTempDirectory;
  }

  return os.tmpdir();
}

function resolveDarwinUserTempDirectory(): string | null {
  if (cachedDarwinUserTempDirectory !== undefined) {
    return cachedDarwinUserTempDirectory;
  }

  try {
    const output = execFileSync("/usr/bin/getconf", ["DARWIN_USER_TEMP_DIR"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    cachedDarwinUserTempDirectory = output.length > 0 ? output : null;
  } catch {
    cachedDarwinUserTempDirectory = null;
  }

  return cachedDarwinUserTempDirectory;
}

function compareDiscoveryRecords(
  a: UnityEndpointDiscoveryRecord,
  b: UnityEndpointDiscoveryRecord,
): number {
  const project = (a.projectPathCanonical ?? "").localeCompare(b.projectPathCanonical ?? "");
  if (project !== 0) return project;
  if (a.publishedAtUnixMs !== b.publishedAtUnixMs) {
    return a.publishedAtUnixMs - b.publishedAtUnixMs;
  }
  return a.sessionId.localeCompare(b.sessionId);
}

function compareNewestDiscoveryRecord(
  a: UnityEndpointDiscoveryRecord,
  b: UnityEndpointDiscoveryRecord,
): number {
  if (a.publishedAtUnixMs !== b.publishedAtUnixMs) {
    return b.publishedAtUnixMs - a.publishedAtUnixMs;
  }
  return b.sessionId.localeCompare(a.sessionId);
}
