/**
 * `loombridge install-mcp`: register the Loombridge MCP server in a project's `.mcp.json`,
 * the project-scoped convention every MCP client reads from the repo root.
 *
 * This is the step that actually connects an agent to Unity, and until now nothing in
 * Loombridge wrote it: the README asked the developer to translate prose into their client's
 * config by hand (Docs/Design/OneCommandSetup.md, "the finding").
 *
 * The file belongs to the PROJECT, not to Loombridge, so every rule here is about touching
 * exactly one key and nothing else:
 *
 *   - MERGE, never clobber. Other servers and other top-level keys are preserved verbatim.
 *   - A `loombridge` entry Loombridge did not write is REFUSED, never overwritten. Ownership
 *     is proven by a sha in `ProjectSettings/LoombridgeInstall.json`, the same hand-edit-safe
 *     ledger discipline `install-agent` uses for its managed files.
 *   - Malformed JSON is a REFUSAL, not a reason to start fresh: rewriting a file we could not
 *     parse would discard configuration we never read.
 *   - Nothing is ever written outside the project root.
 *   - Idempotent: a second run over an entry we wrote changes no bytes and exits 0.
 *
 * The ledger hashes OUR ENTRY, not the whole file. Other tooling legitimately adds servers to
 * `.mcp.json`, so a whole-file hash would read every unrelated addition as a hand edit and
 * refuse from then on. A guard that fires on the honest case is a guard people delete.
 *
 * Exit codes: 0 registered / already registered · 1 filesystem/runtime failure ·
 * 2 usage/precondition (not a Unity project, unparseable config, or a foreign entry).
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import { resolveBuildStamp } from "../../shared/build-stamp.js";
import {
  BridgeInstallError as RuntimeFailure,
  type McpRegistrationRecord,
  looksLikeUnityProject,
  readInstallMetadata,
  writeInstallRecord,
} from "./bridge-install-common.js";

/** Usage/precondition failures exit 2; genuine runtime failures exit 1. */
class UsageError extends Error {}

/** The project-scoped MCP config every client reads from the repo root. POSIX-relative. */
export const MCP_CONFIG_RELPATH = ".mcp.json";

/** The one key inside `mcpServers` that Loombridge owns. Everything else is the project's. */
export const MCP_SERVER_KEY = "loombridge";

/**
 * The entry written for that key. `command: "loombridge"` + `args: ["mcp"]` is exactly what
 * the README tells a developer to type into their client, so the installer and the docs
 * cannot describe two different servers.
 */
export function desiredServerEntry(): Record<string, unknown> {
  return { command: "loombridge", args: ["mcp"] };
}

/**
 * Stable stringification: object keys sorted at every depth, arrays left in order. The sha
 * that proves ownership must not change because a client rewrote the same entry with its
 * keys in another order. That would read as a hand edit and refuse a run that should be a
 * no-op.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

function sha256Text(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

/** The ownership sha for a server entry: sha256 over its canonical JSON. */
export function entrySha(entry: unknown): string {
  return sha256Text(canonicalJson(entry));
}

/**
 * Resolve the config path INSIDE the project, refusing anything that escapes it.
 *
 * `MCP_CONFIG_RELPATH` is a constant today, so this cannot fire from the CLI; it is here
 * because "never write outside the project root" is an invariant of this verb rather than a
 * property of one string, and a future relpath (or an override) must not be able to quietly
 * break it. Exported so the refusal is testable with a path that does escape.
 */
export function resolveMcpConfigPath(project: string, relpath: string = MCP_CONFIG_RELPATH): string {
  const root = path.resolve(project);
  const target = path.resolve(root, relpath);
  const rel = path.relative(root, target);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new UsageError(`refusing to write outside the project root: ${target}`);
  }
  return target;
}

function assertUnityProject(project: string): void {
  if (!existsSync(project)) throw new UsageError(`--project directory does not exist: ${project}`);
  if (!statSync(project).isDirectory()) throw new UsageError(`--project is not a directory: ${project}`);
  if (!looksLikeUnityProject(project)) {
    throw new UsageError(
      `${project} does not look like a Unity project (no Assets/, ProjectSettings/ProjectVersion.txt, or Packages/manifest.json).`,
    );
  }
}

/** A plain JSON object (not an array, not null), the only shape we will merge into. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface InstallMcpArgs {
  project: string;
  dryRun: boolean;
}

/** What a run decided, so `setup` can report it without re-deriving anything. */
export type McpRegistrationOutcome = "written" | "updated" | "unchanged" | "already-correct-foreign";

export interface InstallMcpResult {
  code: number;
  outcome?: McpRegistrationOutcome;
}

/**
 * Register (or re-register) the server. Exported so `loombridge setup` composes this exact
 * path rather than special-casing MCP with a second, unguarded writer.
 */
export function installMcp(args: InstallMcpArgs): InstallMcpResult {
  const project = path.resolve(args.project);
  const configPath = resolveMcpConfigPath(project);
  const meta = readInstallMetadata(project);
  const desired = desiredServerEntry();
  const desiredSha = entrySha(desired);

  console.log(`==> Registering the Loombridge MCP server in ${path.join(project, MCP_CONFIG_RELPATH)}`);
  if (args.dryRun) console.log("    (--dry-run: no files will be written)");

  let config: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    const raw = readFileSync(configPath, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      // REFUSAL, not a fresh start. A file we could not parse still holds the project's
      // other servers; rewriting it would delete configuration we never read.
      throw new UsageError(
        `${MCP_CONFIG_RELPATH} is not valid JSON (${(error as Error).message}).\n` +
          `    Refusing to rewrite it: that would discard servers this CLI could not read.\n` +
          `    Fix the file (or move it aside) and re-run.`,
      );
    }
    if (!isPlainObject(parsed)) {
      throw new UsageError(
        `${MCP_CONFIG_RELPATH} is valid JSON but not an object, so there is nowhere to merge a server into.\n` +
          `    Refusing to replace it. Fix the file (or move it aside) and re-run.`,
      );
    }
    config = parsed;
  }

  const serversRaw = config.mcpServers;
  if (serversRaw !== undefined && !isPlainObject(serversRaw)) {
    throw new UsageError(
      `${MCP_CONFIG_RELPATH} has an "mcpServers" key that is not an object. Refusing to replace it.`,
    );
  }
  const servers: Record<string, unknown> = isPlainObject(serversRaw) ? serversRaw : {};

  const existing = servers[MCP_SERVER_KEY];
  let outcome: McpRegistrationOutcome;
  if (existing !== undefined) {
    const onDiskSha = entrySha(existing);
    const ledgerSha = meta?.mcpRegistration?.entrySha256;
    const ours = ledgerSha !== undefined && onDiskSha === ledgerSha;
    if (onDiskSha === desiredSha) {
      // Already exactly what we would write. No bytes change either way, so there is
      // nothing to refuse, and nothing to claim: an entry we did not write stays
      // unrecorded, so we never take ownership of a line a human typed.
      outcome = ours ? "unchanged" : "already-correct-foreign";
    } else if (!ours) {
      // The refusal that carries the whole verb: a `loombridge` entry whose bytes do not
      // match what this ledger says we wrote is the developer's, and theirs to keep.
      throw new UsageError(
        `${MCP_CONFIG_RELPATH} already has a "${MCP_SERVER_KEY}" server that Loombridge did not write.\n` +
          `    Refusing to overwrite it: that config is yours.\n` +
          `    on disk: ${canonicalJson(existing)}\n` +
          `    ours:    ${canonicalJson(desired)}\n` +
          `    Keep yours (nothing to do), or delete that entry and re-run to let Loombridge own it.`,
      );
    } else {
      outcome = "updated";
    }
  } else {
    outcome = "written";
  }

  if (outcome === "unchanged" || outcome === "already-correct-foreign") {
    console.log(
      outcome === "unchanged"
        ? `  -> already registered by Loombridge; nothing to change.`
        : `  -> already registered with exactly this config (not by Loombridge); left as is.`,
    );
    return { code: 0, outcome };
  }

  // MERGE: only `mcpServers.loombridge` is replaced. Every other top-level key and every
  // other server object is carried through untouched.
  const nextConfig: Record<string, unknown> = { ...config, mcpServers: { ...servers, [MCP_SERVER_KEY]: desired } };
  if (!args.dryRun) {
    try {
      mkdirSync(path.dirname(configPath), { recursive: true });
      writeFileSync(configPath, `${JSON.stringify(nextConfig, null, 2)}\n`);
    } catch (error) {
      throw new RuntimeFailure(`could not write ${MCP_CONFIG_RELPATH}: ${(error as Error).message}`);
    }
  }
  const otherServers = Object.keys(servers).filter((k) => k !== MCP_SERVER_KEY);
  console.log(`  -> ${MCP_CONFIG_RELPATH} (${outcome === "written" ? "added" : "updated"} "${MCP_SERVER_KEY}": loombridge mcp)`);
  if (otherServers.length > 0) {
    console.log(`     ${otherServers.length} other server(s) preserved: ${otherServers.join(", ")}`);
  }

  // Record WHAT WE WROTE so a later run can tell "we wrote this" from "a human wrote this".
  // Same committed record as the agent surface, so one file describes everything Loombridge
  // owns in this project.
  const record: McpRegistrationRecord = {
    state: "enabled",
    cliVersion: resolveBuildStamp().version,
    installedAt: new Date().toISOString(),
    path: MCP_CONFIG_RELPATH,
    serverKey: MCP_SERVER_KEY,
    entrySha256: desiredSha,
  };
  const patch = meta ? { mcpRegistration: record } : { schemaVersion: 1, mcpRegistration: record };
  writeInstallRecord(project, patch, args.dryRun);
  console.log("  -> ProjectSettings/LoombridgeInstall.json (mcpRegistration recorded)");
  return { code: 0, outcome };
}

// --- CLI -----------------------------------------------------------------

type ParseHelp = { help: true; usageError?: boolean };

function parseArgs(args: string[]): InstallMcpArgs | ParseHelp {
  let project = "";
  let dryRun = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--project" || arg === "-p") project = args[(i += 1)] ?? "";
    else if (arg === "--dry-run") dryRun = true;
    else if (arg === "--help" || arg === "-h") return { help: true };
    else {
      console.error(`[loombridge install-mcp] unknown argument "${arg}".`);
      return { help: true, usageError: true };
    }
  }
  if (!project) {
    console.error("[loombridge install-mcp] --project <unity-project-dir> is required.");
    return { help: true, usageError: true };
  }
  return { project: path.resolve(project), dryRun };
}

function printUsage(): void {
  console.log(
    [
      "Usage: loombridge install-mcp --project <unity-project-dir> [options]",
      "",
      "Register the Loombridge MCP server in the project's .mcp.json, the project-scoped",
      "config every MCP client reads from the repo root. This is the step that connects",
      "your agent to Unity.",
      "",
      "Writes exactly one key:",
      '  { "mcpServers": { "loombridge": { "command": "loombridge", "args": ["mcp"] } } }',
      "",
      "An existing file is MERGED into: other servers and other keys are preserved. An",
      '"loombridge" entry Loombridge did not write is REFUSED, never overwritten, and a',
      "file that does not parse is refused rather than replaced.",
      "",
      "Options:",
      "  --project, -p <dir>   Target Unity project (required)",
      "  --dry-run             Print the plan without writing any files",
      "  -h, --help            Show this help",
      "",
      "Exit codes: 0 registered/already registered · 1 filesystem/runtime failure ·",
      "2 usage/precondition (not a Unity project, unparseable config, or a foreign entry).",
    ].join("\n"),
  );
}

export async function run(args: string[]): Promise<number> {
  const parsed = parseArgs(args);
  if ("help" in parsed) {
    printUsage();
    return parsed.usageError ? 2 : 0;
  }
  return runInstallMcp(parsed);
}

/**
 * The install with its error-to-exit-code mapping, shared by the verb and by `setup`.
 * Keeping it here means both surfaces turn a refusal into the SAME exit code; a second
 * mapping in `setup` would be a second contract to keep honest.
 */
export function runInstallMcp(parsed: InstallMcpArgs): number {
  try {
    assertUnityProject(parsed.project);
    return installMcp(parsed).code;
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`[loombridge install-mcp] ${error.message}`);
      return 2;
    }
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[loombridge install-mcp] ${message}`);
    return 1;
  }
}

/** Exported for the guard tests (the path refusal has no argv route by design). */
export const _internals = { UsageError, isPlainObject };
