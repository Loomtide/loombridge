/**
 * `loombridge install-agent` — OPT IN to Loombridge's agent commands + skills, installed
 * INTO a consumer Unity project's repo (committed, so teammates get them via `git pull`).
 * Never touches ~/.claude or ~/.codex — that global surface is the dev-repo installer's
 * job (scripts/loombridge-install-locally.sh). Skipping is the DEFAULT (do nothing); opting
 * out is `--remove` and is REMEMBERED in the committed install record (no nagging).
 *
 * The preference is a tri-state `agentSurface` block in ProjectSettings/LoombridgeInstall.json
 * (the already-committed record — NOT a .loombridge/ file, which consumers gitignore):
 *   absent  = UNSET (default) — install/update print ONE hint, install nothing.
 *   enabled = surface installed; a per-file sha256 ledger drives hand-edit-safe refresh.
 *   declined = opted out; install/update go silent.
 *
 * Payload: the SCRUBBED consumer surface bundled with this CLI (mcp-server/agent-surface/,
 * built by scripts/build-agent-surface.mjs at prepack). Every installed .md carries a
 * managed-marker (like LOOMBRIDGE.md): editing a file — or deleting its marker — changes its
 * bytes so its sha256 no longer matches the ledger, and Loombridge then treats it as the
 * user's (skipped on refresh, left in place on --remove).
 *
 * Layout installed into the project:
 *   .claude/commands/loombridge/<name>.md         (Claude slash commands)
 *   .claude/skills/<name>/**                     (Claude skills)
 *   .codex/skills/<name>/**                      (Codex skills — real committed files)
 * Codex COMMAND wrappers are intentionally NOT emitted here (see the PR body): the
 * monorepo generator's wrappers assume the monorepo layout, so retargeting them to a
 * consumer needs real design and is a follow-up. Skills are self-contained prose, so the
 * canonical `.skills → .codex/skills` convention ports cleanly as real files.
 *
 * Exit codes: 0 done · 1 filesystem/runtime failure · 2 usage/validation.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { resolveBuildStamp } from "../../shared/build-stamp.js";
import { packageRoot } from "../../shared/pkg-root.js";
import {
  AgentSurfaceFile,
  BridgeInstallError as RuntimeFailure,
  InstallMetadata,
  looksLikeUnityProject,
  readInstallMetadata,
  sha256File,
  writeInstallRecord,
} from "./bridge-install-common.js";

// --- exit-code discipline: usage/validation = 2, runtime failure = 1 ---
class UsageError extends Error {}

/** Bump when the managed-marker body changes (parallels ROUTING_DOC_VERSION). */
export const AGENT_SURFACE_MARKER_VERSION = 1;

/** Detects OUR marker anywhere in a file (it sits just after any YAML frontmatter). */
const MARKER_RE = /<!--\s*loombridge:agent-surface\s+v(\d+)\b/;

/** The one-line nudge install-bridge / update print when the choice is UNSET. */
const HINT_PREFIX = "agent commands + skills available (optional)";

export interface InstallAgentArgs {
  project: string;
  remove: boolean;
  dryRun: boolean;
}

type ParseHelp = { help: true; usageError?: boolean };

function parseArgs(args: string[]): InstallAgentArgs | ParseHelp {
  let project = "";
  let remove = false;
  let dryRun = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--project" || arg === "-p") project = args[(i += 1)] ?? "";
    else if (arg === "--remove") remove = true;
    else if (arg === "--dry-run") dryRun = true;
    else if (arg === "--help" || arg === "-h") return { help: true };
    else {
      console.error(`[loombridge install-agent] unknown argument "${arg}".`);
      return { help: true, usageError: true };
    }
  }
  if (!project) {
    console.error("[loombridge install-agent] --project <unity-project-dir> is required.");
    return { help: true, usageError: true };
  }
  return { project: path.resolve(project), remove, dryRun };
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

// --- payload -------------------------------------------------------------

/**
 * Locate the scrubbed consumer payload bundled with this CLI. Resolution:
 *   1. $LOOMBRIDGE_AGENT_SURFACE_DIR override (tests / air-gapped)
 *   2. <mcp-server>/agent-surface  (npm-packaged + dev layout — built by build-agent-surface.mjs)
 */
function resolvePayloadDir(): string {
  const override = process.env.LOOMBRIDGE_AGENT_SURFACE_DIR;
  if (override) {
    if (!existsSync(override)) throw new RuntimeFailure(`agent surface payload not found: ${override}`);
    return override;
  }
  // Depth-independent — see bridge-install-common.ts; the ".."-count broke on the reorg
  // and only the LOOMBRIDGE_AGENT_SURFACE_DIR override was covered by tests.
  const candidate = path.join(packageRoot(import.meta.url), "agent-surface");
  if (existsSync(candidate)) return candidate;
  throw new RuntimeFailure(
    "no agent-surface payload bundled with this CLI. In the dev repo, run scripts/build-agent-surface.mjs " +
      "(CI's prepack builds it into loombridge).",
  );
}

/** Every file under the payload dir, as POSIX-style rel paths (deterministic order). */
function payloadRelFiles(payloadDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else if (e.isFile()) out.push(path.relative(payloadDir, abs));
    }
  };
  walk(payloadDir);
  return out;
}

/**
 * Map a payload file to its project-relative install target(s), as POSIX ("/"-joined)
 * keys. Commands go to Claude; skills go to BOTH Claude and Codex as real committed files.
 *
 * The ledger stores these POSIX keys VERBATIM (never OS-native) — the record is COMMITTED
 * and shared across a team, so a Windows-authored ledger with backslash keys would miss on
 * a teammate's macOS/Linux and mis-flag every managed file as hand-edited. `toAbs` converts
 * to an OS path only at the filesystem boundary. `payloadRel` may arrive with either
 * separator (path.relative uses path.sep), so we normalize both.
 */
function installTargets(payloadRel: string): string[] {
  const parts = payloadRel.split(/[\\/]/);
  if (parts[0] === "commands") return [[".claude", ...parts].join("/")];
  if (parts[0] === "skills") return [[".claude", ...parts].join("/"), [".codex", ...parts].join("/")];
  return [];
}

/** Resolve a POSIX ledger key to an OS-native absolute path under the project. */
function toAbs(project: string, target: string): string {
  return path.join(project, ...target.split("/"));
}

/** The prior enabled ledger, hardened against a corrupt record (files absent/non-array). */
function enabledLedger(prior: InstallMetadata["agentSurface"]): AgentSurfaceFile[] {
  return prior?.state === "enabled" && Array.isArray(prior.files) ? prior.files : [];
}

function markerComment(): string {
  return (
    `<!-- loombridge:agent-surface v${AGENT_SURFACE_MARKER_VERSION} — GENERATED by \`loombridge install-agent\`. ` +
    "Do NOT hand-edit; re-run install-agent to refresh. Editing this file (or deleting this marker) makes " +
    "Loombridge treat it as yours: skipped on refresh, left in place on --remove. -->"
  );
}

/** Inject the managed-marker after any YAML frontmatter (else at the top). */
function withMarker(content: string): string {
  const fm = content.match(/^(---\r?\n[\s\S]*?\r?\n---\r?\n)/);
  const marker = markerComment();
  if (fm) {
    const head = fm[1];
    return `${head}${marker}\n${content.slice(head.length)}`;
  }
  return `${marker}\n\n${content}`;
}

function sha256Bytes(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

interface DesiredFile {
  target: string; // project-relative
  bytes: string;
}

/**
 * A scoped `.gitattributes` pinning the managed files to LF. Windows Git's default
 * `core.autocrlf=true` would otherwise flip LF→CRLF on checkout, changing the bytes out
 * from under the sha ledger so every managed file reads as "hand-edited" on a teammate's
 * clone (refresh/remove then silently no-op). A `.gitattributes` INSIDE `.claude/`/`.codex/`
 * applies only to files under it, so it never touches the consumer's own root config.
 */
const GITATTRIBUTES_BYTES =
  "# Loombridge-managed — keep LF so the install ledger's sha matches on every OS (Windows core.autocrlf included).\n" +
  "* text eol=lf\n";

/** The full desired on-disk set for the current payload (marker injected into .md). */
function desiredFiles(payloadDir: string): DesiredFile[] {
  const out: DesiredFile[] = [];
  for (const rel of payloadRelFiles(payloadDir)) {
    const raw = readFileSync(path.join(payloadDir, rel), "utf8");
    const bytes = rel.endsWith(".md") ? withMarker(raw) : raw;
    for (const target of installTargets(rel)) out.push({ target, bytes });
  }
  // Pin each root that actually received files to LF (managed like everything else, so it
  // refreshes / removes / prunes through the same hash discipline). POSIX keys, verbatim.
  for (const root of [".claude", ".codex"]) {
    if (out.some((f) => f.target.startsWith(`${root}/`))) {
      out.push({ target: `${root}/.gitattributes`, bytes: GITATTRIBUTES_BYTES });
    }
  }
  return out;
}

// --- install / refresh ---------------------------------------------------

/**
 * Install (from UNSET/declined) or REFRESH (from enabled) the surface, with per-file hash
 * discipline: a target that is absent is written fresh; a target whose on-disk sha matches
 * the LEDGER is Loombridge-managed and gets rewritten to the current payload; a target that
 * exists but does NOT match the ledger (hand-edited, marker removed, or a pre-existing user
 * file) is SKIPPED and left untouched, with a warning naming it. Returns exit 0/1.
 */
function installSurface(project: string, dryRun: boolean): number {
  const payloadDir = resolvePayloadDir();
  const meta = readInstallMetadata(project);
  const prior = meta?.agentSurface;
  const priorLedger = new Map<string, string>(enabledLedger(prior).map((f) => [f.path, f.sha256]));

  const desired = desiredFiles(payloadDir);
  const ledger: AgentSurfaceFile[] = [];
  const written: string[] = [];
  const skipped: string[] = [];

  console.log(`==> ${prior?.state === "enabled" ? "Refreshing" : "Installing"} the Loombridge agent surface in ${project}`);
  if (dryRun) console.log("    (--dry-run: no files will be written)");

  // Persist whatever we managed to write before a failure propagates, so a mid-loop IO
  // error can't strand files with no ledger (--remove could then never clean them). The
  // record is written with the PARTIAL ledger, then the error re-throws for exit-1.
  const persistLedger = (state: "enabled") => {
    const record = { state, cliVersion: resolveBuildStamp().version, installedAt: new Date().toISOString(), files: ledger };
    const patch = meta ? { agentSurface: record } : { schemaVersion: 1, agentSurface: record };
    writeInstallRecord(project, patch, dryRun);
  };

  const orphansRemoved: string[] = [];
  const orphansKept: string[] = [];
  try {
    for (const { target, bytes } of desired) {
      const abs = toAbs(project, target);
      const sha = sha256Bytes(bytes);
      if (existsSync(abs)) {
        const onDisk = sha256File(abs);
        const ledgerSha = priorLedger.get(target);
        const managed = ledgerSha !== undefined && onDisk === ledgerSha;
        if (!managed) {
          skipped.push(target); // hand-edited / user's own file — never clobber
          continue;
        }
        if (onDisk !== sha && !dryRun) writeFileSync(abs, bytes);
        if (onDisk !== sha) written.push(target);
        ledger.push({ path: target, sha256: sha });
      } else {
        if (!dryRun) {
          mkdirSync(path.dirname(abs), { recursive: true });
          writeFileSync(abs, bytes);
        }
        written.push(target);
        ledger.push({ path: target, sha256: sha });
      }
    }

    // ORPHAN PRUNE: a path in the PRIOR ledger that this payload no longer ships (a dropped
    // or renamed command/skill) must not strand. Where it is still Loombridge-managed on disk
    // (sha matches the prior ledger) delete it and prune newly-empty dirs; where the user
    // hand-edited it, leave it (it's theirs now) — either way it drops out of the ledger, so
    // the surface can genuinely shrink and a later re-add starts clean instead of frozen.
    const desiredTargets = new Set(desired.map((d) => d.target));
    for (const [priorPath, priorSha] of priorLedger) {
      if (desiredTargets.has(priorPath)) continue; // still shipped — handled above
      const abs = toAbs(project, priorPath);
      if (!existsSync(abs)) continue; // already gone
      if (sha256File(abs) === priorSha) {
        if (!dryRun) rmSync(abs, { force: true });
        orphansRemoved.push(priorPath);
      } else {
        orphansKept.push(priorPath); // hand-edited orphan — leave it, drop from ledger
      }
    }
    if (!dryRun && orphansRemoved.length) pruneEmptyDirs(project, orphansRemoved);
  } catch (err) {
    persistLedger("enabled"); // best-effort recovery record for the partial install
    throw err;
  }

  console.log(`  -> ${written.length} file(s) written/updated across .claude/ + .codex/`);
  if (orphansRemoved.length) {
    console.log(`  -> ${orphansRemoved.length} file(s) no longer shipped removed (surface shrank)`);
  }
  if (skipped.length) {
    console.log(`  !! ${skipped.length} hand-edited file(s) left untouched (yours now — refresh skips them):`);
    for (const s of skipped) console.log(`       - ${s}`);
  }
  if (orphansKept.length) {
    console.log(`  !! ${orphansKept.length} hand-edited, no-longer-shipped file(s) LEFT in place (yours now):`);
    for (const k of orphansKept) console.log(`       - ${k}`);
  }

  persistLedger("enabled");
  console.log(`  -> ProjectSettings/LoombridgeInstall.json (agentSurface: enabled, ${ledger.length} managed file(s))`);
  console.log("");
  console.log("==> Done. Commit .claude/ (+ .codex/) + ProjectSettings/LoombridgeInstall.json so teammates get it via git pull.");
  return 0;
}

// --- remove --------------------------------------------------------------

/** Prune now-empty ancestor dirs of removed files, up to (not including) the project root. */
function pruneEmptyDirs(project: string, removed: string[]): void {
  const dirs = new Set<string>();
  for (const rel of removed) dirs.add(path.dirname(toAbs(project, rel)));
  // Deepest-first so children are pruned before parents.
  for (const start of [...dirs].sort((a, b) => b.length - a.length)) {
    let dir = start;
    while (dir.startsWith(project) && dir !== project) {
      try {
        if (readdirSync(dir).length > 0) break;
        // rmdirSync, NOT rmSync: `rmSync(dir, { recursive: false })` throws EISDIR on a
        // directory (force only suppresses ENOENT), so the catch below used to swallow it
        // and nothing was ever pruned. rmdirSync also refuses a non-empty dir on its own.
        rmdirSync(dir);
      } catch {
        break;
      }
      dir = path.dirname(dir);
    }
  }
}

/**
 * Opt out: delete Loombridge-managed files (ONLY where on-disk sha256 matches the ledger),
 * leave hand-edited ones with a warning, then remember the choice as state:"declined".
 */
function removeSurface(project: string, dryRun: boolean): number {
  const meta = readInstallMetadata(project);
  const prior = meta?.agentSurface;
  // Corrupt-ledger safe: a malformed enabled block (files absent/non-array) degrades to an
  // empty ledger so --remove still flips the state to "declined" and lets the user self-heal.
  const ledger = enabledLedger(prior);

  console.log(`==> Removing the Loombridge agent surface from ${project}`);
  if (dryRun) console.log("    (--dry-run: no files will be deleted)");

  const removed: string[] = [];
  const kept: string[] = [];
  for (const f of ledger) {
    const abs = toAbs(project, f.path);
    if (!existsSync(abs)) continue; // already gone
    if (sha256File(abs) === f.sha256) {
      if (!dryRun) rmSync(abs, { force: true });
      removed.push(f.path);
    } else {
      kept.push(f.path); // hand-edited — leave it (it's the user's now)
    }
  }
  if (!dryRun) pruneEmptyDirs(project, removed);

  console.log(`  -> ${removed.length} managed file(s) removed`);
  if (kept.length) {
    console.log(`  !! ${kept.length} hand-edited file(s) LEFT in place (yours — not Loombridge's to remove):`);
    for (const k of kept) console.log(`       - ${k}`);
  }

  const record = {
    state: "declined" as const,
    cliVersion: resolveBuildStamp().version,
    installedAt: new Date().toISOString(),
    files: [],
  };
  const patch = meta ? { agentSurface: record } : { schemaVersion: 1, agentSurface: record };
  writeInstallRecord(project, patch, dryRun);
  console.log("  -> ProjectSettings/LoombridgeInstall.json (agentSurface: declined) — install/update stay silent now");
  console.log("");
  console.log("==> Done. Re-enable any time: loombridge install-agent --project " + project);
  return 0;
}

// --- shared surface preference API (install-bridge / update / doctor) -----

export type AgentSurfaceState = "unset" | "enabled" | "declined";

/** The tri-state preference from the committed record (absent block = UNSET). */
export function agentSurfaceState(project: string): AgentSurfaceState {
  const s = readInstallMetadata(project)?.agentSurface;
  return s ? s.state : "unset";
}

/**
 * install-bridge + update: print EXACTLY ONE hint line when the choice is UNSET; stay
 * silent once the user has enabled or declined (no nagging). Returns whether it hinted.
 */
export function printAgentSurfaceHintIfUnset(project: string): boolean {
  if (agentSurfaceState(project) !== "unset") return false;
  console.log(`  -> ${HINT_PREFIX} — loombridge install-agent --project ${project}`);
  return true;
}

/**
 * `loombridge update`: UNSET → hint; "declined" → silent; "enabled" → REFRESH the surface to
 * this CLI's payload with the same hash discipline (skip+warn hand-edited, rewrite the
 * rest, update the ledger + cliVersion). Returns exit 0/1.
 */
export function reconcileAgentSurfaceForUpdate(project: string, dryRun: boolean): number {
  const state = agentSurfaceState(project);
  if (state === "unset") {
    printAgentSurfaceHintIfUnset(project);
    return 0;
  }
  if (state === "declined") return 0; // silent by choice
  console.log("");
  return installSurface(project, dryRun);
}

// --- CLI -----------------------------------------------------------------

function printUsage(): void {
  console.log(
    [
      "Usage: loombridge install-agent --project <unity-project-dir> [options]",
      "",
      "OPT IN to Loombridge's agent commands + skills, installed INTO your Unity project's",
      "repo (committed, so teammates get them via git pull). Skipping is the DEFAULT — do",
      "nothing. The choice is remembered in ProjectSettings/LoombridgeInstall.json, so one",
      "dev decides and everyone's `loombridge update` behaves identically after a pull.",
      "",
      "Installs (real committed files, never ~/.claude or ~/.codex):",
      "  .claude/commands/loombridge/*.md   Claude slash commands",
      "  .claude/skills/<name>/**         Claude skills",
      "  .codex/skills/<name>/**          Codex skills",
      "",
      "Options:",
      "  --project, -p <dir>   Target Unity project (required)",
      "  --remove              Delete the managed surface (hand-edited files are LEFT) and",
      "                        remember the opt-out (state:declined; update goes silent).",
      "                        Re-running install-agent later re-enables it.",
      "  --dry-run             Print the plan without writing/deleting any files",
      "  -h, --help            Show this help",
      "",
      "Exit codes: 0 done · 1 filesystem/runtime failure · 2 usage/validation.",
    ].join("\n"),
  );
}

export async function run(args: string[]): Promise<number> {
  const parsed = parseArgs(args);
  if ("help" in parsed) {
    printUsage();
    return parsed.usageError ? 2 : 0;
  }
  try {
    assertUnityProject(parsed.project);
    return parsed.remove ? removeSurface(parsed.project, parsed.dryRun) : installSurface(parsed.project, parsed.dryRun);
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`[loombridge install-agent] ${error.message}`);
      return 2;
    }
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[loombridge install-agent] ${message}`);
    return 1;
  }
}

/** Exported for the anti-drift / marker tests. */
export const _internals = { MARKER_RE, withMarker, installTargets };
