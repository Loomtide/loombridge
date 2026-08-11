/**
 * `loombridge migrate-layout`: move an existing project onto the ArtifactStorage S2
 * layout (`Docs/Design/ArtifactStorage.md`).
 *
 * THIS VERB TOUCHES THE ONE ARTIFACT IN THE SYSTEM THAT CANNOT BE REGENERATED. A
 * recorded demonstration exists because a human sat down and played the game; the
 * approved pixel baselines exist because a human looked at frames and said yes. Every
 * rule below is written from that fact, and none of them is a preference:
 *
 * 1. NOTHING IS DELETED UNTIL THE DESTINATION BYTES VERIFY. Every move is copy →
 *    re-hash every file at the destination → release the source, in that order. There is
 *    no `fs.rename` anywhere in this file, which also makes a cross-device move
 *    (`EXDEV`, a project on an external volume) an ordinary case rather than a fallback
 *    path that only runs on someone else's machine.
 *
 * 2. THE DISK IS THE TRUTH, THE JOURNAL IS A HINT. Interrupt this verb between the
 *    destination-verify and the source-release and BOTH copies exist. A second run must
 *    not read the survivor as un-migrated work, and must not read it as done either: it
 *    re-verifies the destination and finishes the release. The journal records what
 *    happened for a human; every decision is re-derived from what is actually there.
 *
 * 3. A TRACE AND ITS BASELINES MOVE AS ONE UNIT. Half a pair is worse than neither:
 *    a migrated trace with a legacy baseline reads as "recorded, not approved", whose
 *    printed next action is to freeze a NEW baseline over the approved one.
 *
 * 4. THE LEGACY PATHS ARE LEFT OCCUPIED, NOT EMPTY. See `legacy-layout.ts` for the whole
 *    argument; in one line, an older CLI against an emptied project prints the on-ramp
 *    and asks the human to re-record the demonstration they still have.
 *
 * 5. THE ANCHORS ARE LEFT TRACKED. `git clean -fd` skips IGNORED files, so anchors under
 *    the old `.loombridge/replays/` were accidentally protected by the very ignore rule
 *    this RFC exists to remove. Moving them somewhere untracked and un-ignored removes
 *    that protection: measured on a template-derived project, `git clean -fd` deleted the
 *    migrated anchors with no git object behind them. So this verb refuses to run outside
 *    a git work tree unless the operator explicitly accepts that (`--no-git`), and it
 *    `git add`s the destination itself.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  LOOMBRIDGE_DIRNAME,
  ensureRunGitignore,
  loombridgePaths,
  readState,
  writeState,
  type LoombridgePaths,
} from "../../domain/state.js";
import { readSlicePlan, writeSlicePlan } from "../verification/slices.js";
import {
  MIGRATE_VERB,
  legacyPaths,
  isTombstoneFile,
  remapLegacyRelPath,
  scanLegacyLayout,
  tombstoneBaselineManifest,
  tombstoneTraceBody,
} from "./legacy-layout.js";
import { TRACE_BASELINE_MANIFEST } from "../replay/trace-baseline-manifest.js";

const execFileAsync = promisify(execFile);
const TAG = "[loombridge migrate-layout]";

/** How long a lock may sit before a later run may take it over. */
export const STALE_LOCK_MS = 15 * 60 * 1000;

// ── filesystem primitives (copy, verify, release) ────────────────────────────

async function sha256File(file: string): Promise<string> {
  return createHash("sha256").update(await fs.readFile(file)).digest("hex");
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Every FILE under `dir`, as `/`-separated paths relative to it. `[]` when absent. */
export async function listFiles(dir: string, base = dir): Promise<string[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(abs, base)));
    else out.push(path.relative(base, abs).split(path.sep).join("/"));
  }
  return out.sort();
}

/**
 * Copy a file or a whole tree. Overwrites, so a resumed run re-copies rather than
 * refusing; the verify step afterwards is what decides whether the bytes are right.
 */
async function copyPath(from: string, to: string): Promise<void> {
  const stat = await fs.stat(from);
  if (stat.isDirectory()) {
    await fs.mkdir(to, { recursive: true });
    await fs.cp(from, to, { recursive: true, force: true });
    return;
  }
  await fs.mkdir(path.dirname(to), { recursive: true });
  await fs.copyFile(from, to);
}

/**
 * One refusal sentence per file whose destination bytes are not the source bytes.
 *
 * SHA, NOT SIZE, NOT COUNT. The whole point of the copy-verify-release order is that the
 * thing being deleted has already been proved present somewhere else; a comparison that
 * could pass on a truncated copy would make the order decorative.
 */
export async function verifyCopy(from: string, to: string): Promise<string[]> {
  const failures: string[] = [];
  const stat = await fs.stat(from);
  if (!stat.isDirectory()) {
    if (!(await exists(to))) return [`${to} is missing after the copy`];
    if ((await sha256File(from)) !== (await sha256File(to))) {
      failures.push(`${to} does not match ${from} (sha256 mismatch after the copy)`);
    }
    return failures;
  }
  for (const rel of await listFiles(from)) {
    const src = path.join(from, ...rel.split("/"));
    const dst = path.join(to, ...rel.split("/"));
    if (!(await exists(dst))) {
      failures.push(`${rel} is missing from ${to} after the copy`);
      continue;
    }
    if ((await sha256File(src)) !== (await sha256File(dst))) {
      failures.push(`${rel} in ${to} does not match ${from} (sha256 mismatch after the copy)`);
    }
  }
  return failures;
}

// ── the move plan ────────────────────────────────────────────────────────────

/** One (source, destination) pair inside a unit. */
interface Move {
  from: string;
  to: string;
}

/**
 * The atom of the migration: a set of paths that move together, and the tombstones left
 * behind once they have. `id` is the journal key AND the resume key, so renaming one
 * makes a half-finished migration re-verify rather than silently skip.
 */
interface MoveUnit {
  id: string;
  tier: "anchor" | "run";
  label: string;
  moves: Move[];
  /** Written after the sources are released. Anchor units only. */
  tombstones: { file: string; body: () => Promise<string> }[];
}

/** Trace ids from `<dir>/<id>.trace.json`, tombstones excluded. */
async function legacyTraceIds(dir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const ids: string[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".trace.json")) continue;
    if (await isTombstoneFile(path.join(dir, entry))) continue;
    ids.push(entry.slice(0, -".trace.json".length));
  }
  return ids.sort();
}

/** Baseline ids: every SUBDIRECTORY of the legacy baselines dir, tombstones excluded. */
async function legacyBaselineIds(dir: string): Promise<string[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const ids: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (await isTombstoneFile(path.join(dir, entry.name, TRACE_BASELINE_MANIFEST))) continue;
    ids.push(entry.name);
  }
  return ids.sort();
}

/**
 * Build the ordered unit list.
 *
 * ORDER MATTERS IN ONE PLACE AND IT IS CALLED OUT HERE: the sign-off artifacts are
 * extracted from `reports/slices/<id>/` BEFORE `reports/` moves wholesale, because they
 * are anchors living inside a run-tier directory and the bulk move would otherwise file a
 * human's approval evidence under `run/`.
 */
export async function planUnits(paths: LoombridgePaths, migratedAt: string): Promise<MoveUnit[]> {
  const legacy = legacyPaths(paths.root);
  const units: MoveUnit[] = [];

  // 1. The human sign-off artifacts, out of `reports/slices/` and into `anchors/`.
  let sliceDirs: import("node:fs").Dirent[] = [];
  try {
    sliceDirs = await fs.readdir(legacy.sliceReports, { withFileTypes: true });
  } catch {
    sliceDirs = [];
  }
  for (const entry of sliceDirs.filter((e) => e.isDirectory())) {
    const from = path.join(legacy.sliceReports, entry.name);
    const files = (await listFiles(from)).filter((f) => f.startsWith("signoff"));
    if (files.length === 0) continue;
    units.push({
      id: `signoff:${entry.name}`,
      tier: "anchor",
      label: `sign-off artifact for slice ${entry.name}`,
      moves: files.map((f) => ({
        from: path.join(from, ...f.split("/")),
        to: path.join(paths.signoffs, entry.name, ...f.split("/")),
      })),
      tombstones: [],
    });
  }

  // 2. Each demonstration WITH its approved frames: one unit, never two.
  const traceIds = await legacyTraceIds(legacy.replayTraces);
  const baselineIds = await legacyBaselineIds(legacy.replayBaselines);
  for (const id of traceIds) {
    const traceFrom = path.join(legacy.replayTraces, `${id}.trace.json`);
    const traceTo = path.join(paths.replayTraces, `${id}.trace.json`);
    const moves: Move[] = [{ from: traceFrom, to: traceTo }];
    const hasBaseline = baselineIds.includes(id);
    if (hasBaseline) {
      moves.push({
        from: path.join(legacy.replayBaselines, id),
        to: path.join(paths.replayBaselines, id),
      });
    }
    units.push({
      id: `trace:${id}`,
      tier: "anchor",
      label: hasBaseline
        ? `demonstration '${id}' + its approved baseline (one unit)`
        : `demonstration '${id}' (no approved baseline)`,
      moves,
      tombstones: [
        { file: traceFrom, body: async () => tombstoneTraceBody(id, migratedAt) },
        {
          file: path.join(legacy.replayBaselines, id, TRACE_BASELINE_MANIFEST),
          // The REAL sha of the migrated demonstration, read from the destination after
          // the move: a tombstone bound to a sentinel would refuse for a reason nobody
          // could check.
          body: async () =>
            tombstoneBaselineManifest({ id, traceSha256: await sha256File(traceTo), migratedAt }),
        },
      ],
    });
  }

  // 3. Approved frames whose demonstration is already gone. Still an anchor, still
  //    tombstoned: without a stub trace at the legacy path an older CLI's
  //    `discoverTraces` returns nothing for this id and the on-ramp fires anyway.
  for (const id of baselineIds.filter((b) => !traceIds.includes(b))) {
    const from = path.join(legacy.replayBaselines, id);
    units.push({
      id: `baseline:${id}`,
      tier: "anchor",
      label: `approved baseline '${id}' (no recorded demonstration at the legacy path)`,
      moves: [{ from, to: path.join(paths.replayBaselines, id) }],
      tombstones: [
        {
          file: path.join(legacy.replayTraces, `${id}.trace.json`),
          body: async () => tombstoneTraceBody(id, migratedAt),
        },
        {
          file: path.join(from, TRACE_BASELINE_MANIFEST),
          body: async () =>
            tombstoneBaselineManifest({
              id,
              // No demonstration to hash. A sha over a marker still refuses, because the
              // stub trace's own bytes will never equal it, and the declared-but-absent
              // frame refuses independently of this field.
              traceSha256: createHash("sha256").update(`${MIGRATE_VERB}:no-trace:${id}`).digest("hex"),
              migratedAt,
            }),
        },
      ],
    });
  }

  // 4. THE MCP SERVER'S OWN OP TRACES, which shared `replays/traces/` with the human
  //    demonstrations until S2. Everything in there that is NOT a `<id>.trace.json` is
  //    machine-generated session output and belongs in the run tier.
  let traceDirEntries: import("node:fs").Dirent[] = [];
  try {
    traceDirEntries = await fs.readdir(legacy.replayTraces, { withFileTypes: true });
  } catch {
    traceDirEntries = [];
  }
  const opTraceMoves = traceDirEntries
    .filter((e) => !e.name.endsWith(".trace.json"))
    .map((e) => ({
      from: path.join(legacy.replayTraces, e.name),
      to: path.join(paths.opTraces, e.name),
    }));
  if (opTraceMoves.length > 0) {
    units.push({
      id: "op-traces",
      tier: "run",
      label: "MCP session op traces (they shared the demonstrations' directory)",
      moves: opTraceMoves,
      tombstones: [],
    });
  }

  // 5. The run tier: everything re-derivable from an anchor plus a run.
  const runMoves: { id: string; label: string; moves: Move[] }[] = [
    {
      id: "replay-reports",
      label: "replay run reports",
      moves: [{ from: legacy.replayReports, to: paths.replayReports }],
    },
    { id: "reports", label: "verification reports", moves: [{ from: legacy.reports, to: paths.reports }] },
    { id: "backups", label: "bridge install backups", moves: [{ from: legacy.backups, to: paths.backups }] },
    { id: "captures", label: "ad-hoc screenshots", moves: [{ from: legacy.captures, to: paths.captures }] },
    { id: "art", label: "art/geometry snapshots", moves: [{ from: legacy.art, to: paths.art }] },
    { id: "handoff", label: "asset-prepare handoff", moves: [{ from: legacy.handoff, to: paths.handoff }] },
  ];
  // The fleet roll-up sits DIRECTLY under `replays/`, beside `reports/`, so it is named
  // file by file rather than swept: moving the whole `replays/` directory would drag the
  // anchors this migration just carefully separated back into the run tier.
  const fleetMoves: Move[] = [];
  for (const name of ["fleet.report.json", "fleet.report.html"]) {
    const from = path.join(legacy.replays, name);
    if (await exists(from)) fleetMoves.push({ from, to: path.join(paths.replays, name) });
  }
  if (fleetMoves.length > 0) {
    runMoves.push({ id: "fleet-report", label: "fleet roll-up report", moves: fleetMoves });
  }

  for (const entry of runMoves) {
    const present: Move[] = [];
    for (const move of entry.moves) if (await exists(move.from)) present.push(move);
    if (present.length === 0) continue;
    units.push({ id: entry.id, tier: "run", label: entry.label, moves: present, tombstones: [] });
  }

  return units;
}

// ── the journal + the lock ───────────────────────────────────────────────────

interface Journal {
  schemaVersion: "1";
  startedAt: string;
  /** Unit id -> the last thing that finished for it. */
  units: Record<string, "copied" | "released">;
}

function journalPath(paths: LoombridgePaths): string {
  return path.join(paths.run, "migrate-layout.journal.json");
}

function lockPath(paths: LoombridgePaths): string {
  return path.join(paths.run, "migrate-layout.lock");
}

async function readJournal(paths: LoombridgePaths): Promise<Journal | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(journalPath(paths), "utf-8")) as Journal;
    return parsed.schemaVersion === "1" && typeof parsed.units === "object" ? parsed : null;
  } catch {
    return null;
  }
}

async function writeJournal(paths: LoombridgePaths, journal: Journal): Promise<void> {
  await fs.mkdir(paths.run, { recursive: true });
  await fs.writeFile(journalPath(paths), `${JSON.stringify(journal, null, 2)}\n`, "utf-8");
}

/** True when a process id is alive on this machine (and therefore its lock is not stale). */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Take the migration lock, or refuse.
 *
 * A lock file with a STALE RULE is the minimum here, not a nicety: two concurrent runs
 * would race copy-verify-release against each other over the same trees, and the loser
 * could release a source the winner had not finished copying. Staleness is decided by BOTH
 * age and liveness, because a killed process leaves a lock that is neither old nor held,
 * and an age-only rule makes an operator wait fifteen minutes to recover from a Ctrl-C.
 */
async function acquireLock(paths: LoombridgePaths, now: number): Promise<{ ok: true } | { ok: false; why: string }> {
  await fs.mkdir(paths.run, { recursive: true });
  const file = lockPath(paths);
  const body = `${JSON.stringify({ pid: process.pid, host: os.hostname(), startedAt: new Date(now).toISOString() }, null, 2)}\n`;
  try {
    // `wx` is the whole mutual exclusion: an atomic create-or-fail, not a
    // read-then-write that two processes can both win.
    await fs.writeFile(file, body, { encoding: "utf-8", flag: "wx" });
    return { ok: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  let held: { pid?: number; startedAt?: string; host?: string } = {};
  try {
    held = JSON.parse(await fs.readFile(file, "utf-8")) as typeof held;
  } catch {
    held = {};
  }
  const age = held.startedAt ? now - Date.parse(held.startedAt) : Number.POSITIVE_INFINITY;
  const sameHost = held.host === os.hostname();
  const alive = sameHost && typeof held.pid === "number" && pidAlive(held.pid);
  if (alive && age < STALE_LOCK_MS) {
    return {
      ok: false,
      why:
        `another ${MIGRATE_VERB} is running (pid ${held.pid}, started ${held.startedAt}). ` +
        `Wait for it, or remove ${file} if you are certain it is dead.`,
    };
  }
  await fs.writeFile(file, body, "utf-8");
  console.error(
    `${TAG} took over a stale lock (pid ${held.pid ?? "?"}, started ${held.startedAt ?? "?"}); ` +
      "the previous run did not finish. Every unit is re-verified from disk before anything is released.",
  );
  return { ok: true };
}

// ── re-stamping the recorded paths ───────────────────────────────────────────

/**
 * Rewrite every recorded root-relative path that points into a directory this migration
 * moved, and re-derive the sign-off sha from the RELOCATED bytes.
 *
 * Returns one line per change, so the operator sees exactly which stamps moved rather
 * than being told that some did.
 */
export async function restampRecordedPaths(paths: LoombridgePaths): Promise<string[]> {
  const changes: string[] = [];

  // SLICES.json: `proof.verdictPath` (PREFERRED over the derived path by three separate
  // readers) and `proof.signoffArtifact` + `proof.signoffSha256`.
  const plan = await readSlicePlan(paths).catch(() => null);
  if (plan) {
    let touched = false;
    for (const slice of plan.slices) {
      const proof = slice.proof;
      if (!proof) continue;
      if (proof.verdictPath) {
        const next = remapLegacyRelPath(proof.verdictPath);
        if (next !== proof.verdictPath) {
          changes.push(`SLICES.json ${slice.id}.proof.verdictPath: ${proof.verdictPath} -> ${next}`);
          proof.verdictPath = next;
          touched = true;
        }
      }
      if (proof.signoffArtifact) {
        const next = remapLegacyRelPath(proof.signoffArtifact);
        if (next !== proof.signoffArtifact) {
          changes.push(`SLICES.json ${slice.id}.proof.signoffArtifact: ${proof.signoffArtifact} -> ${next}`);
          proof.signoffArtifact = next;
          touched = true;
        }
        // RE-DERIVED FROM THE MOVED BYTES, never carried forward. A sha copied across a
        // move asserts something nobody re-checked; a sha recomputed at the destination
        // is the only kind that means anything after a copy.
        const abs = path.resolve(paths.root, ...next.split("/"));
        try {
          const sha = await sha256File(abs);
          if (sha !== proof.signoffSha256) {
            changes.push(`SLICES.json ${slice.id}.proof.signoffSha256: re-derived from ${next}`);
            proof.signoffSha256 = sha;
            touched = true;
          }
        } catch {
          changes.push(
            `SLICES.json ${slice.id}.proof.signoffArtifact points at ${next}, which is not on disk: ` +
              "signoffSha256 left as it was (this slice's approval evidence is missing, not moved)",
          );
        }
      }
    }
    if (touched) await writeSlicePlan(paths, plan);
  }

  // STATE.md: `lastVerdict.verdictPath` is committed AND printed to humans.
  const state = await readState(paths);
  if (state?.lastVerdict?.verdictPath) {
    const next = remapLegacyRelPath(state.lastVerdict.verdictPath);
    if (next !== state.lastVerdict.verdictPath) {
      changes.push(`STATE.md lastVerdict.verdictPath: ${state.lastVerdict.verdictPath} -> ${next}`);
      state.lastVerdict = { ...state.lastVerdict, verdictPath: next };
      await writeState(paths, state);
    }
  }

  // Every verdict's evidence ledger records `inputsDir` root-relative. `.loombridge/verify/`
  // does NOT move, so most of these are no-ops; the rewrite runs anyway because a verdict
  // graded with an explicit `--inputs` under `reports/` or `captures/` is legal and is
  // exactly the kind of path a migration silently strands.
  for (const dir of [paths.reports, path.join(paths.reports, "slices")]) {
    for (const rel of await listFiles(dir)) {
      if (!rel.endsWith(".json") || rel.includes("/")) continue;
      const file = path.join(dir, rel);
      let parsed: Record<string, unknown>;
      let raw: string;
      try {
        raw = await fs.readFile(file, "utf-8");
        parsed = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        continue;
      }
      const evidence = parsed.evidence as { inputsDir?: unknown } | undefined;
      if (!evidence || typeof evidence.inputsDir !== "string") continue;
      const next = remapLegacyRelPath(evidence.inputsDir);
      if (next === evidence.inputsDir) continue;
      changes.push(`${path.relative(paths.root, file)} evidence.inputsDir: ${evidence.inputsDir} -> ${next}`);
      evidence.inputsDir = next;
      await fs.writeFile(file, `${JSON.stringify(parsed, null, 2)}\n`, "utf-8");
    }
  }

  return changes;
}

// ── the project's own .gitignore ─────────────────────────────────────────────

/**
 * Rewrite the PROJECT's `.gitignore`: drop the rule that hides the anchors, add the rule
 * that hides the run tier. Pure, so its behavior is testable without a filesystem.
 *
 * `.loombridge/run/*` AND NOT `.loombridge/run/`, and the star is load-bearing. Git
 * cannot re-include anything inside an excluded DIRECTORY, so the directory form also
 * hides `.loombridge/run/.gitignore` itself: the marker never gets committed, never
 * reaches a clone, and the structural guarantee silently does nothing on any machine that
 * has not run a Loombridge verb. Measured with `git check-ignore` on a real repo, both
 * forms, before choosing.
 */
export function rewriteProjectGitignore(body: string): { body: string; changes: string[] } {
  const changes: string[] = [];
  const eol = body.includes("\r\n") ? "\r\n" : "\n";
  const lines = body.split(/\r?\n/);
  const dropped = [`${LOOMBRIDGE_DIRNAME}/replays/`, `${LOOMBRIDGE_DIRNAME}/replays`];
  const kept = lines.filter((line) => {
    if (!dropped.includes(line.trim())) return true;
    changes.push(`removed '${line.trim()}' (it hid the recorded demonstrations and approved baselines)`);
    return false;
  });
  const runRule = `${LOOMBRIDGE_DIRNAME}/run/*`;
  const hasRunRule = kept.some((line) => line.trim() === runRule);
  if (!hasRunRule) {
    changes.push(`added '${runRule}' (the run tier; the trailing * keeps run/.gitignore committable)`);
    while (kept.length > 0 && kept[kept.length - 1]!.trim() === "") kept.pop();
    kept.push("", "# Loombridge: the re-derivable tier. Everything else under .loombridge/ is committed.", runRule, "");
  }
  return { body: kept.join(eol), changes };
}

// ── the verb ─────────────────────────────────────────────────────────────────

export interface MigrateLayoutArgs {
  root: string;
  dryRun: boolean;
  /** Proceed outside a git work tree, accepting that the anchors land untracked. */
  noGit: boolean;
  now?: () => Date;
}

async function isGitWorkTree(root: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", root, "rev-parse", "--is-inside-work-tree"]);
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}

export async function runMigrateLayout(args: MigrateLayoutArgs): Promise<number> {
  const paths = loombridgePaths(args.root);
  const now = args.now?.() ?? new Date();
  const migratedAt = now.toISOString();

  const scan = await scanLegacyLayout(args.root);
  const units = await planUnits(paths, migratedAt);

  if (units.length === 0) {
    if (scan.state === "tombstoned") {
      console.error(`${TAG} already migrated (${scan.tombstonedIds.length} tombstone(s) at the legacy paths).`);
    } else {
      console.error(`${TAG} nothing to migrate: no pre-S2 directories under ${LOOMBRIDGE_DIRNAME}/.`);
    }
    // The tier marker and the project ignore rule are established EVERY run, not only
    // when there is something to move: a project that never had a legacy directory still
    // needs the structural guarantee.
    await ensureRunGitignore(paths);
    if (!args.dryRun) await applyGitignore(paths);
    return 0;
  }

  console.error(`${TAG} plan (${units.length} unit(s)):`);
  for (const unit of units) {
    console.error(`${TAG}   [${unit.tier}] ${unit.id}: ${unit.label}`);
    for (const move of unit.moves) {
      console.error(
        `${TAG}       ${path.relative(args.root, move.from)} -> ${path.relative(args.root, move.to)}`,
      );
    }
  }

  if (args.dryRun) {
    console.error(`${TAG} --dry-run: nothing was copied, released, or re-stamped.`);
    return 0;
  }

  // THE GIT PREFLIGHT RUNS BEFORE ANY SOURCE IS RELEASED, which is the whole point of it
  // being a preflight: `git clean -fd` skips ignored files, so anchors under the old
  // (ignored) `replays/` were accidentally protected. Landing them somewhere untracked
  // and un-ignored removes that protection, and finding out afterwards is finding out
  // too late.
  const inGit = await isGitWorkTree(args.root);
  if (!inGit && !args.noGit) {
    console.error(
      `${TAG} REFUSED, and nothing was moved: ${args.root} is not inside a git work tree, so the ` +
        "migrated anchors would land untracked AND un-ignored.",
    );
    console.error(
      `${TAG} that is strictly less protection than they have now: \`git clean -fd\` SKIPS ignored ` +
        `files, so ${LOOMBRIDGE_DIRNAME}/replays/ was accidentally shielded by the very ignore rule ` +
        "this migration removes. Measured on a template-derived project: the migrated anchors were " +
        "deleted with no git object behind them.",
    );
    console.error(`${TAG} either \`git init\` here first, or re-run with --no-git to accept that.`);
    return 2;
  }

  const lock = await acquireLock(paths, now.getTime());
  if (!lock.ok) {
    console.error(`${TAG} REFUSED: ${lock.why}`);
    return 2;
  }

  try {
    const journal: Journal = (await readJournal(paths)) ?? {
      schemaVersion: "1",
      startedAt: migratedAt,
      units: {},
    };

    for (const unit of units) {
      // DISK FIRST. A unit whose sources are all gone and whose destinations are all
      // there is finished, whatever the journal says, and a unit the journal calls
      // finished is re-verified anyway. The journal is an audit record, not an authority:
      // it is written after each step, so it is always at least one step behind reality.
      const outstanding: Move[] = [];
      for (const move of unit.moves) if (await exists(move.from)) outstanding.push(move);
      if (outstanding.length === 0) {
        journal.units[unit.id] = "released";
        await writeJournal(paths, journal);
        console.error(`${TAG} ${unit.id}: already released (sources gone, destinations in place).`);
        continue;
      }

      for (const move of outstanding) {
        await copyPath(move.from, move.to);
        const failures = await verifyCopy(move.from, move.to);
        if (failures.length > 0) {
          console.error(`${TAG} REFUSED: the copy of ${unit.id} did not verify, so NOTHING was released.`);
          for (const failure of failures) console.error(`${TAG}   ${failure}`);
          console.error(`${TAG} both copies are still on disk. Fix the cause and re-run; this is resumable.`);
          return 2;
        }
      }
      journal.units[unit.id] = "copied";
      await writeJournal(paths, journal);

      // Only now, with every byte proved present at the destination, does the source go.
      for (const move of outstanding) await fs.rm(move.from, { recursive: true, force: true });
      for (const tombstone of unit.tombstones) {
        await fs.mkdir(path.dirname(tombstone.file), { recursive: true });
        await fs.writeFile(tombstone.file, await tombstone.body(), "utf-8");
      }
      journal.units[unit.id] = "released";
      await writeJournal(paths, journal);
      console.error(
        `${TAG} ${unit.id}: moved ${outstanding.length} path(s)` +
          (unit.tombstones.length > 0 ? `, tombstoned ${unit.tombstones.length} legacy path(s)` : ""),
      );
    }

    await ensureRunGitignore(paths);

    const restamped = await restampRecordedPaths(paths);
    if (restamped.length > 0) {
      console.error(`${TAG} re-stamped ${restamped.length} recorded path(s):`);
      for (const line of restamped) console.error(`${TAG}   ${line}`);
    } else {
      console.error(`${TAG} no recorded paths needed re-stamping.`);
    }

    const gitignoreChanges = await applyGitignore(paths);
    for (const change of gitignoreChanges) console.error(`${TAG} .gitignore: ${change}`);

    if (inGit) {
      const tracked = await trackAnchors(paths);
      if (tracked !== null) {
        console.error(
          `${TAG} BLOCKING: the anchors were moved but could NOT be staged (${tracked}).`,
        );
        console.error(
          `${TAG} run this yourself before anything runs \`git clean\`, or the migrated anchors have ` +
            "no git object behind them:",
        );
        console.error(`${TAG}   git -C ${args.root} add ${LOOMBRIDGE_DIRNAME}/anchors .gitignore`);
        return 2;
      }
      console.error(`${TAG} staged ${LOOMBRIDGE_DIRNAME}/anchors/ so the moved anchors are tracked. Commit them.`);
    } else {
      console.error(
        `${TAG} --no-git: the anchors are UNTRACKED and no longer ignored, so \`git clean -fd\` ` +
          "would delete them. Put this project under version control.",
      );
    }

    await fs.rm(journalPath(paths), { force: true });
    console.error(`${TAG} done. Legacy paths now hold tombstones so an OLDER CLI refuses loudly (exit 2)`);
    console.error(`${TAG} instead of asking a human to re-record a demonstration that still exists.`);
    return 0;
  } finally {
    await fs.rm(lockPath(paths), { force: true });
  }
}

/** Rewrite the project `.gitignore` in place. Returns the change lines. */
async function applyGitignore(paths: LoombridgePaths): Promise<string[]> {
  const file = path.join(paths.root, ".gitignore");
  let body = "";
  try {
    body = await fs.readFile(file, "utf-8");
  } catch {
    body = "";
  }
  const { body: next, changes } = rewriteProjectGitignore(body);
  if (changes.length > 0) await fs.writeFile(file, next.endsWith("\n") ? next : `${next}\n`, "utf-8");
  return changes;
}

/** `git add` the anchors + the ignore rules. Returns null on success, else the reason. */
async function trackAnchors(paths: LoombridgePaths): Promise<string | null> {
  const targets = [
    `${LOOMBRIDGE_DIRNAME}/anchors`,
    `${LOOMBRIDGE_DIRNAME}/run/.gitignore`,
    // THE TOMBSTONES ARE STAGED TOO, and that is not tidiness. Their whole job is to make
    // an OLD CLI refuse instead of asking for a re-record, and "an old CLI" most often
    // means a CLONE: a pinned CI runner, a teammate's machine, a second checkout. A
    // tombstone that only exists on the machine that ran the migration protects only the
    // one machine that was never at risk. The legacy paths were tracked before the move
    // (that is what the old ignore rule made possible), so this also stages the deletions
    // of everything that moved out of them.
    `${LOOMBRIDGE_DIRNAME}/replays`,
    ".gitignore",
  ];
  // Filtered by existence: `git add` fails the whole invocation on a pathspec that matches
  // nothing, and a project with no anchors at all would otherwise take the BLOCKING branch
  // for a reason that is not a problem.
  const present: string[] = [];
  for (const target of targets) {
    if (await exists(path.join(paths.root, ...target.split("/")))) present.push(target);
  }
  if (present.length === 0) return null;
  try {
    await execFileAsync("git", ["-C", paths.root, "add", "--", ...present]);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message.split("\n")[0]! : String(error);
  }
}

function printHelp(): void {
  console.log(
    [
      "loombridge migrate-layout: move this project onto the anchors/ + run/ storage layout.",
      "",
      "Usage: loombridge migrate-layout [--root <dir>] [--dry-run] [--no-git]",
      "",
      "  --root <dir>   project root (default: cwd)",
      "  --dry-run      print the plan and exit; nothing is copied, released, or re-stamped",
      "  --no-git       proceed outside a git work tree, accepting UNTRACKED anchors",
      "",
      "What it does, in order:",
      "  1. copies each legacy path to its new home and re-hashes EVERY file at the",
      "     destination before releasing the source (never a rename, so a cross-device",
      "     project is an ordinary case);",
      "  2. moves each recorded demonstration together with its approved baseline, as one",
      "     unit, because half a pair reads as 'recorded, not approved' and its printed",
      "     next action is to freeze a NEW baseline over the approved one;",
      "  3. leaves a TOMBSTONE at each legacy anchor path so an OLDER CLI reports a broken",
      "     anchor (exit 2) instead of reporting none and telling a human to re-record;",
      "  4. re-stamps every recorded path that pointed into a moved directory, and",
      "     re-derives the sign-off sha from the relocated bytes;",
      "  5. rewrites this project's .gitignore and stages the moved anchors.",
      "",
      "Resumable and idempotent: interrupt it and re-run. Every unit is re-verified from",
      "disk, so a survivor of a half-finished run is neither re-migrated nor mistaken for",
      "work that is already done.",
    ].join("\n"),
  );
}

export async function run(argv: string[]): Promise<number> {
  let root = process.cwd();
  let dryRun = false;
  let noGit = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      printHelp();
      return 0;
    } else if (arg === "--root") root = path.resolve(argv[(i += 1)] ?? "");
    else if (arg === "--dry-run") dryRun = true;
    else if (arg === "--no-git") noGit = true;
    else {
      console.error(`${TAG} unknown argument "${arg}".`);
      printHelp();
      return 2;
    }
  }
  return await runMigrateLayout({ root, dryRun, noGit });
}
