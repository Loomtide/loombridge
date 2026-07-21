import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** A peer loombridge MCP server process discovered on this machine. */
export interface SiblingServer {
  pid: number;
  ppid: number;
  /** ps `etime` (elapsed running time), e.g. "06:18:42" or "01-01:53:16". */
  etime: string;
}

/**
 * How confidently a ps line was identified as a loombridge MCP server:
 *  - "path": a path-qualified entrypoint (`.../mcp-server/dist/index.js`) — unambiguous.
 *  - "bare": `node dist/index.js` with no path — could be ANY node app, since ps does not
 *    report cwd. Must have its cwd verified (see partitionCandidates) before it is treated
 *    as a real loombridge server / recommended for `kill`.
 */
export type ServerMatch = "path" | "bare";

export interface SiblingCandidate extends SiblingServer {
  match: ServerMatch;
}

/** Confirmed servers are kill-safe; ambiguous ones (bare, cwd unverifiable) are not. */
export interface DoctorServers {
  confirmed: SiblingServer[];
  ambiguous: SiblingServer[];
}

/** pkill pattern offered as a convenience remedy (covers the path-qualified forms). */
const PKILL_PATTERN = "mcp-server/dist/index.js";

/**
 * Classify a ps command line as a loombridge MCP server launch, or null if it isn't one.
 * The entrypoint is `dist/index.js`, launched several ways whose command lines differ —
 * and crucially NOT all carry the `mcp-server/` prefix:
 *   - `node mcp-server/dist/index.js`                          (.mcp.json, cwd = repo root)
 *   - `/abs/node /abs/mcp-server/dist/index.js`                (.mcp.json, absolute)
 *   - `node dist/index.js`                                     (cwd = mcp-server; scripts/smoke)
 *   - `/abs/node ~/.loombridge/runtime/mcp-server/dist/index.js` (installed/frozen runtime)
 * A substring match on `mcp-server/dist/index.js` silently misses the bare cwd=mcp-server
 * form. But matching bare `dist/index.js` on argv alone OVER-matches: ps has no cwd, so an
 * unrelated node app launched as `node dist/index.js` looks identical. So path-qualified
 * forms are returned as "path" (trustworthy), and the bare form as "bare" (needs a cwd check
 * before we trust it or recommend killing it).
 */
export function classifyServerCommand(command: string): ServerMatch | null {
  const tokens = command.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  // argv[0] must be a node binary: `node`, `/abs/path/node`, `node22`, ...
  const exe = tokens[0]!.replace(/\\/g, "/");
  const exeBase = exe.slice(exe.lastIndexOf("/") + 1);
  if (!/^node(\d+(\.\d+)*)?$/.test(exeBase)) return null;

  let bare = false;
  for (const tok of tokens) {
    const t = tok.replace(/\\/g, "/");
    if (t === "mcp-server/dist/index.js" || t.endsWith("/mcp-server/dist/index.js")) {
      return "path"; // unambiguous — prefer it over any bare token on the same line
    }
    if (t === "dist/index.js") bare = true;
  }
  return bare ? "bare" : null;
}

/** True when a resolved process cwd is a mcp-server directory (repo or frozen runtime). */
export function isLoombridgeServerCwd(cwd: string): boolean {
  const c = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
  return c.endsWith("/mcp-server") || c === "mcp-server";
}

/**
 * Parse `ps -axo pid=,ppid=,etime=,command=` output into loombridge MCP server CANDIDATES
 * (excluding `selfPid`), each tagged with its match confidence. Pure so it can be
 * unit-tested without spawning `ps`. Lines that don't match the expected shape are skipped.
 */
export function parseSiblingServers(psStdout: string, selfPid: number): SiblingCandidate[] {
  const out: SiblingCandidate[] = [];
  for (const raw of psStdout.split("\n")) {
    const line = raw.trim();
    const m = line.match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
    if (!m) continue;
    const match = classifyServerCommand(m[4]!);
    if (!match) continue;
    const pid = Number(m[1]);
    const ppid = Number(m[2]);
    if (!Number.isFinite(pid) || pid === selfPid) continue;
    out.push({ pid, ppid, etime: m[3]!, match });
  }
  return out;
}

/**
 * Split candidates into confirmed (kill-safe) and ambiguous, verifying the cwd of every
 * "bare" candidate via the injected `resolveCwd` (injectable for testing):
 *   - "path" candidate                         → confirmed (entrypoint is unambiguous).
 *   - "bare" + cwd is a mcp-server dir          → confirmed.
 *   - "bare" + cwd resolves to something else   → dropped (it is not a loombridge server).
 *   - "bare" + cwd cannot be resolved           → ambiguous (reported, never kill-recommended).
 */
export async function partitionCandidates(
  candidates: SiblingCandidate[],
  resolveCwd: (pid: number) => Promise<string | null>,
): Promise<DoctorServers> {
  const confirmed: SiblingServer[] = [];
  const ambiguous: SiblingServer[] = [];
  for (const c of candidates) {
    const base: SiblingServer = { pid: c.pid, ppid: c.ppid, etime: c.etime };
    if (c.match === "path") {
      confirmed.push(base);
      continue;
    }
    const cwd = await resolveCwd(c.pid);
    if (cwd === null) ambiguous.push(base);
    else if (isLoombridgeServerCwd(cwd)) confirmed.push(base);
    // else: cwd verified, not a mcp-server dir → not ours, drop silently.
  }
  return { confirmed, ambiguous };
}

/** Best-effort resolution of a process's working directory (Linux /proc, then macOS lsof). */
async function resolveProcessCwd(pid: number): Promise<string | null> {
  try {
    const link = await fs.readlink(`/proc/${pid}/cwd`);
    if (link) return link;
  } catch {
    /* not Linux, or no permission — fall through to lsof */
  }
  try {
    const { stdout } = await execFileAsync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], {
      timeout: 2000,
    });
    for (const line of stdout.split("\n")) {
      if (line.startsWith("n")) return line.slice(1);
    }
  } catch {
    /* lsof unavailable or process gone */
  }
  return null;
}

/**
 * Best-effort enumeration of OTHER running loombridge MCP server processes on this machine,
 * split into confirmed (kill-safe) and ambiguous (bare form whose cwd could not be verified).
 * Returns empty lists on any failure (ps unavailable, timeout, parse error): diagnostics
 * must never block or crash server startup.
 */
export async function collectSiblingServers(selfPid: number): Promise<DoctorServers> {
  try {
    const { stdout } = await execFileAsync("ps", ["-axo", "pid=,ppid=,etime=,command="], {
      timeout: 3000,
      maxBuffer: 8 * 1024 * 1024,
    });
    return await partitionCandidates(parseSiblingServers(stdout, selfPid), resolveProcessCwd);
  } catch {
    return { confirmed: [], ambiguous: [] };
  }
}

export interface DoctorSnapshot {
  servers: DoctorServers;
  /** Display names (or paths) of currently discovered editors. */
  editorNames: string[];
  /** Startup binding description, e.g. "none", "cwd:/path", "strict:Name". */
  binding: string;
  /** Effective active route (project path/name) or null when unbound. */
  activeRoute: string | null;
  routeHealth?: RouteHealthSnapshot;
}

export interface RouteHealthSnapshot {
  unityProcess: "unknown" | "found" | "missing";
  endpointFile: "unknown" | "found" | "missing";
  websocket: "unknown" | "healthy" | "unreachable";
  bridgeHandshake: "unknown" | "healthy" | "failed";
  compileState: "unknown" | "clean" | "compiling" | "failed";
  mcpRoute: "unknown" | "registered" | "unregistered";
  latestCompileError?: string;
}

export function classifyRouteHealth(health: RouteHealthSnapshot): "healthy" | "recoverable" | "blocked" | "unknown" {
  if (
    health.unityProcess === "found" &&
    health.endpointFile === "found" &&
    health.websocket === "healthy" &&
    health.bridgeHandshake === "healthy" &&
    health.compileState === "clean" &&
    health.mcpRoute === "registered"
  ) {
    return "healthy";
  }
  if (
    health.websocket === "healthy" &&
    health.bridgeHandshake === "healthy" &&
    health.compileState !== "failed" &&
    health.mcpRoute === "unregistered"
  ) {
    return "recoverable";
  }
  if (
    health.unityProcess === "missing" ||
    health.endpointFile === "missing" ||
    health.websocket === "unreachable" ||
    health.bridgeHandshake === "failed" ||
    health.compileState === "failed"
  ) {
    return "blocked";
  }
  return "unknown";
}

export function formatRouteHealthLine(health: RouteHealthSnapshot): string {
  const status = classifyRouteHealth(health);
  const parts = [
    `unity=${health.unityProcess}`,
    `endpoint=${health.endpointFile}`,
    `websocket=${health.websocket}`,
    `handshake=${health.bridgeHandshake}`,
    `compile=${health.compileState}`,
    `mcpRoute=${health.mcpRoute}`,
  ];
  let line = `[loombridge] doctor: route health ${status}; ${parts.join("; ")}`;
  if (status === "recoverable") {
    line += "; bridge is healthy but MCP route is unregistered - reconnect/rebind the loombridge MCP server for this editor";
  }
  if (health.latestCompileError) {
    line += `; latest compile error: ${health.latestCompileError}`;
  }
  return line;
}

/**
 * One-line (plus an optional NOTE) health snapshot for stderr. Surfaces a dirty
 * environment — orphaned sibling servers, multiple editors, unexpected binding —
 * immediately, instead of needing `lsof`/`ps` spelunking after the fact. A `kill` remedy
 * is offered ONLY for confirmed servers; ambiguous (unverifiable-cwd) ones are counted but
 * never recommended for killing, since they might be unrelated node apps.
 */
export function formatDoctorLines(snap: DoctorSnapshot): string[] {
  const { servers, editorNames, binding, activeRoute } = snap;
  const { confirmed, ambiguous } = servers;

  let siblingDesc =
    confirmed.length === 0
      ? "0 other loombridge MCP servers"
      : `${confirmed.length} other loombridge MCP server${confirmed.length === 1 ? "" : "s"} `
        + `(pids: ${confirmed.map((s) => s.pid).join(", ")})`;
  if (ambiguous.length > 0) {
    siblingDesc += ` + ${ambiguous.length} possible (bare node dist/index.js, cwd unverified: `
      + `pids ${ambiguous.map((s) => s.pid).join(", ")})`;
  }

  const editors = editorNames.length ? editorNames.join(", ") : "none";
  const lines = [
    `[loombridge] doctor: ${siblingDesc} running; editors discovered: ${editors}; `
      + `startup binding: ${binding}; active route: ${activeRoute ?? "unbound"}`,
  ];
  if (snap.routeHealth) {
    lines.push(formatRouteHealthLine(snap.routeHealth));
  }
  if (confirmed.length > 0) {
    lines.push(
      `[loombridge] doctor: NOTE other loombridge MCP servers are running against this machine. `
        + `Stale servers from prior agent sessions can churn the Unity bridge; if unexpected, `
        + `stop them by PID (kill ${confirmed.map((s) => s.pid).join(" ")}) `
        + `or: pkill -f ${PKILL_PATTERN}`,
    );
  }
  if (ambiguous.length > 0) {
    lines.push(
      `[loombridge] doctor: NOTE ${ambiguous.length} bare \`node dist/index.js\` process(es) `
        + `(pids ${ambiguous.map((s) => s.pid).join(", ")}) could not have their cwd verified; `
        + `they MAY be loombridge servers or unrelated node apps — verify before killing.`,
    );
  }
  return lines;
}
