/**
 * THE LEGACY LAYOUT: where Loombridge wrote before ArtifactStorage S2, how a path from
 * back then maps forward, and how a MIGRATED project proves it was migrated.
 *
 * This module is the shared vocabulary between the migration verb and the doors that have
 * to notice a project which has not run it. It reads disk and it maps strings; it never
 * moves anything.
 *
 * ── WHY THE TOMBSTONE EXISTS, AND WHY IT IS NOT OPTIONAL ─────────────────────────────
 *
 * `verify`'s trace discovery calls `discoverTraces(<traces dir>)`, which returns `[]` for
 * a directory that is not there. So an OLDER CLI pointed at a MIGRATED project does not
 * report a broken anchor: it reports NO anchor. With no assets at all it prints the
 * on-ramp, whose first line is
 *
 *     "the cheapest universal anchor is a recorded demonstration, so ask your human to
 *      play the game once: 1. loombridge trace record --id <name>"
 *
 * and the recorded demonstration is the ONE artifact in the system that cannot be
 * regenerated without a human replaying the game. An old CLI is not hypothetical: a
 * pinned CI runner, a second machine, and the frozen `~/.loomtide/runtime` all keep
 * running whatever they were installed with. Telling that human to re-record is telling
 * them to destroy the anchor.
 *
 * So the migration leaves the legacy paths OCCUPIED rather than empty:
 *
 *   - a STUB trace at `replays/traces/<id>.trace.json`, so `discoverTraces` still returns
 *     the id and the row exists at all;
 *   - a PNG-LESS baseline manifest at `replays/baselines/<id>/baseline-manifest.json`
 *     carrying the REAL `traceSha256` of the migrated demonstration, so
 *     `verifyTraceBaseline` fails twice over (a declared frame that is not on disk, and a
 *     trace whose bytes do not hash to the recorded sha).
 *
 * On an old CLI that makes `integrity.unstamped` false and `integrity.ok` false, which is
 * `notRunClass: "broken"`, which is `notRunTier` 2. The run refuses, loudly, naming the
 * anchor, instead of quietly asking for a new recording. The first declared frame's
 * `captureId` is a SENTENCE rather than an id, because a manifest's failure text is the
 * one channel an old binary will print without knowing anything about this change.
 *
 * A NEW CLI reads the same files as the migration MARKER: `.loombridge/replays/` holding
 * only tombstones means "migrated", and that is what keeps the refusal below from turning
 * into a permanent exit-2 loop.
 */

import fs from "node:fs/promises";
import path from "node:path";

import { LOOMBRIDGE_DIRNAME } from "../../domain/state.js";
import { TRACE_BASELINE_MANIFEST } from "../replay/trace-baseline-manifest.js";

/** The verb that performs the move. Spelled once; every message below composes it. */
export const MIGRATE_VERB = "loombridge migrate-layout";

/**
 * The marker key both tombstone artifacts carry, and the ONLY thing that distinguishes a
 * migrated legacy path from an un-migrated one.
 *
 * A marker inside the FILE rather than the presence of the DIRECTORY, deliberately
 * (ArtifactStorage S2 M6). An MCP session re-creates `.loombridge/replays/traces/` simply
 * by connecting, so "the legacy directory exists" would turn a correct migration into a
 * permanent exit-2 loop the next time an agent attached. The refusal predicate below is
 * therefore "a `*.trace.json` or a stamped baseline manifest exists at a legacy path AND
 * is not a tombstone", never "the legacy directory exists".
 */
export const TOMBSTONE_MARKER = "loombridgeLayoutTombstone";

/** The marker's value: the migration this tombstone records. */
export const TOMBSTONE_MIGRATION_ID = "artifact-storage-s2";

/**
 * The `captureId` of the single frame a tombstone manifest DECLARES and never provides.
 *
 * It is a sentence, not an identifier, because `verifyTraceBaseline` renders it verbatim
 * into `approved baseline '<captureId>.png' is missing from <dir>`, and that string is
 * the only way this change can speak to a CLI built before it existed.
 */
export const TOMBSTONE_CAPTURE_ID =
  "THIS-PROJECT-WAS-MIGRATED-the-approved-baseline-moved-to-.loombridge-anchors-baselines-UPGRADE-YOUR-CLI";

/** Legacy paths, relative to `.loombridge/`. The migration's source side, spelled once. */
export const LEGACY_RELATIVE = {
  replays: "replays",
  replayTraces: path.join("replays", "traces"),
  replayBaselines: path.join("replays", "baselines"),
  replayReports: path.join("replays", "reports"),
  reports: "reports",
  backups: "backups",
  captures: "captures",
  art: "art",
  handoff: "handoff",
  sliceReports: path.join("reports", "slices"),
} as const;

/** Absolute legacy paths for a project root. */
export function legacyPaths(root: string): Record<keyof typeof LEGACY_RELATIVE, string> {
  const dir = path.join(root, LOOMBRIDGE_DIRNAME);
  return Object.fromEntries(
    Object.entries(LEGACY_RELATIVE).map(([key, rel]) => [key, path.join(dir, rel)]),
  ) as Record<keyof typeof LEGACY_RELATIVE, string>;
}

/**
 * THE PATH REMAP, and the reason it is one ordered table rather than a switch at each
 * caller (ArtifactStorage S2 M3).
 *
 * Four things on disk record a root-relative path INTO a directory this migration moves,
 * and none of them is sha-bound, so "no re-stamping needed" (true of the pixel baseline,
 * whose binding is a hash over bytes) is false of all four:
 *
 *   - `SliceProof.verdictPath`, which is PREFERRED over the derived path at three readers
 *     (`slice-rollup.ts`, `doneness.ts`, `status-model.ts`), so a stale one silently
 *     re-points the roll-up at a file that is no longer there;
 *   - `SliceProof.signoffArtifact` (+ `signoffSha256`, re-derived from the moved bytes);
 *   - the verdict evidence ledger's `inputsDir`;
 *   - `STATE.md`'s `lastVerdict.verdictPath`, which is committed and printed to humans.
 *
 * ORDER IS LOAD-BEARING: the sign-off entry has to win over the generic `reports/` entry,
 * because a sign-off is an ANCHOR and everything else under `reports/` is run output. The
 * first matching prefix wins, so the specific rules are listed first.
 *
 * A path this table does not recognise is returned UNCHANGED. That is deliberate: the
 * table's job is to move the paths this migration moves, and silently rewriting anything
 * else would be a second, unreviewed migration hiding inside this one.
 */
const REMAP_RULES: readonly { from: string; to: string; signoffOnly?: true }[] = [
  // The sign-off artifact: an anchor that used to live inside a reports directory.
  //
  // `signoffOnly` because this rule is about a FILE SHAPE, not a directory: the bare
  // `.loombridge/reports/slices` is the per-slice VERDICT directory (run output) and must
  // fall through to the generic `reports/` rule below. Without the flag, an `inputsDir` of
  // `.loombridge/reports/slices` would be re-stamped into `anchors/`, filing regenerable
  // output as ground truth.
  { from: `${LOOMBRIDGE_DIRNAME}/reports/slices/`, to: `${LOOMBRIDGE_DIRNAME}/anchors/signoffs/`, signoffOnly: true },
  { from: `${LOOMBRIDGE_DIRNAME}/replays/traces/`, to: `${LOOMBRIDGE_DIRNAME}/anchors/traces/` },
  { from: `${LOOMBRIDGE_DIRNAME}/replays/baselines/`, to: `${LOOMBRIDGE_DIRNAME}/anchors/baselines/` },
  { from: `${LOOMBRIDGE_DIRNAME}/replays/reports/`, to: `${LOOMBRIDGE_DIRNAME}/run/replays/reports/` },
  // The fleet roll-up sits directly under `replays/`, so this rule must come AFTER the
  // three more specific ones above it.
  { from: `${LOOMBRIDGE_DIRNAME}/replays/`, to: `${LOOMBRIDGE_DIRNAME}/run/replays/` },
  { from: `${LOOMBRIDGE_DIRNAME}/reports/`, to: `${LOOMBRIDGE_DIRNAME}/run/reports/` },
  { from: `${LOOMBRIDGE_DIRNAME}/backups/`, to: `${LOOMBRIDGE_DIRNAME}/run/backups/` },
  { from: `${LOOMBRIDGE_DIRNAME}/captures/`, to: `${LOOMBRIDGE_DIRNAME}/run/captures/` },
  { from: `${LOOMBRIDGE_DIRNAME}/art/`, to: `${LOOMBRIDGE_DIRNAME}/run/art/` },
  { from: `${LOOMBRIDGE_DIRNAME}/handoff/`, to: `${LOOMBRIDGE_DIRNAME}/run/handoff/` },
];

/**
 * A SPECIAL CASE the prefix table cannot express: the sign-off artifact loses a path
 * segment as well as gaining one.
 *
 * Old: `.loombridge/reports/slices/<sliceId>/signoff<ext>`
 * New: `.loombridge/anchors/signoffs/<sliceId>/signoff<ext>`
 *
 * The prefix rule above already produces exactly that, because both shapes are
 * `<prefix><sliceId>/signoff<ext>`. What it must NOT do is drag the per-slice VERDICT
 * (`.loombridge/reports/slices/<id>.verdict.json`, a FILE directly under `slices/`) into
 * `anchors/`. The guard is the shape: a sign-off is `<segment>/signoff<ext>` (two more
 * segments), a verdict is `<segment>.verdict.json` (one). Checked here rather than
 * assumed, because getting it wrong would file run output as ground truth.
 */
function isSignoffRelPath(rel: string): boolean {
  const tail = rel.slice(`${LOOMBRIDGE_DIRNAME}/reports/slices/`.length).split("/");
  return tail.length === 2 && tail[1]!.startsWith("signoff");
}

/**
 * Map ONE root-relative path from the legacy layout to the current one. Idempotent: a
 * path already in the new layout matches no rule and is returned unchanged, so re-running
 * the migration cannot double-rewrite a stamp.
 *
 * Accepts (and returns) POSIX-separated root-relative paths, which is the form every
 * stamped field on disk uses.
 */
export function remapLegacyRelPath(rel: string): string {
  const normalized = rel.split(path.sep).join("/").replace(/^\.\//, "");
  for (const rule of REMAP_RULES) {
    // THE BARE DIRECTORY FORM IS A REAL INPUT, and missing it was a real bug: the evidence
    // ledger records `inputsDir` as `.loombridge/captures`, with no trailing slash and no
    // child, so a prefix test alone left every ledgered evidence dir pointing at a
    // directory the migration had just emptied. `rule.from` keeps its trailing slash (it is
    // what makes `replays/reports/` win over `replays/`), and the exact-directory case is
    // handled beside it rather than by loosening the prefix.
    if (!rule.signoffOnly && normalized === rule.from.slice(0, -1)) return rule.to.slice(0, -1);
    if (!normalized.startsWith(rule.from)) continue;
    if (rule.signoffOnly && !isSignoffRelPath(normalized)) continue;
    return rule.to + normalized.slice(rule.from.length);
  }
  return normalized;
}

// ── the tombstone: writing it, and recognising it ────────────────────────────

/** The stub trace left at a legacy trace path. Exported so the migration and its tests agree. */
export function tombstoneTraceBody(id: string, migratedAt: string): string {
  return `${JSON.stringify(
    {
      [TOMBSTONE_MARKER]: TOMBSTONE_MIGRATION_ID,
      migratedAt,
      readThis:
        "THIS IS NOT A RECORDED DEMONSTRATION. It is a tombstone left by " +
        `${MIGRATE_VERB} so an older Loombridge CLI reports a BROKEN anchor here ` +
        "instead of reporting NO anchor and telling you to record a new one.",
      theRealTraceIsAt: `${LOOMBRIDGE_DIRNAME}/anchors/traces/${id}.trace.json`,
      whatToDo:
        "Upgrade the CLI on this machine. Do NOT run `loombridge trace record` for this " +
        "id: a recorded demonstration cannot be regenerated without a human replaying " +
        "the game, and the real one is at the path above.",
      doNotDelete:
        "Deleting this file makes an older CLI print the on-ramp again, which asks a " +
        "human to re-record the demonstration you still have.",
    },
    null,
    2,
  )}\n`;
}

/**
 * The PNG-less baseline manifest left at a legacy baseline path.
 *
 * Every field is shaped so `loadTraceBaselineManifest` ACCEPTS it (an unreadable manifest
 * would be `broken` too, but for the wrong reason, and a reader would blame corruption
 * rather than a move) and `verifyTraceBaseline` then REFUSES it. `traceSha256` is the
 * real sha of the migrated demonstration, so the refusal is bound to the artifact it is
 * protecting rather than to a sentinel nobody can check.
 */
export function tombstoneBaselineManifest(args: {
  id: string;
  traceSha256: string;
  migratedAt: string;
}): string {
  return `${JSON.stringify(
    {
      kind: "trace-baseline",
      schemaVersion: "1",
      traceId: args.id,
      traceSha256: args.traceSha256,
      approvedAt: args.migratedAt,
      sourceReportSha256: TOMBSTONE_MIGRATION_ID,
      pngs: [{ captureId: TOMBSTONE_CAPTURE_ID, sha256: "0".repeat(64) }],
      [TOMBSTONE_MARKER]: TOMBSTONE_MIGRATION_ID,
      readThis:
        "THIS IS NOT AN APPROVED BASELINE. It is a tombstone left by " +
        `${MIGRATE_VERB}; the approved frames are at ` +
        `${LOOMBRIDGE_DIRNAME}/anchors/baselines/${args.id}/. Upgrade the CLI on this machine.`,
    },
    null,
    2,
  )}\n`;
}

/** True when a parsed JSON object carries the tombstone marker. */
export function isTombstoneObject(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<string, unknown>)[TOMBSTONE_MARKER] === TOMBSTONE_MIGRATION_ID
  );
}

/** True when the JSON file at `file` is a tombstone. Unreadable/absent is NOT a tombstone. */
export async function isTombstoneFile(file: string): Promise<boolean> {
  try {
    return isTombstoneObject(JSON.parse(await fs.readFile(file, "utf-8")));
  } catch {
    return false;
  }
}

// ── the refusal predicate ────────────────────────────────────────────────────

/**
 * What the legacy paths of `root` currently hold.
 *
 *  - `none`         nothing anchor-shaped is there. Includes the case that matters most:
 *                   an EMPTY `replays/traces/` an MCP session re-created by connecting.
 *  - `tombstoned`   only tombstones. The migration ran; this is the marker, not work.
 *  - `unmigrated`   at least one real demonstration or stamped baseline is still there.
 */
export type LegacyLayoutState = "none" | "tombstoned" | "unmigrated";

export interface LegacyLayoutScan {
  state: LegacyLayoutState;
  /** Trace ids whose `<id>.trace.json` is still a real demonstration. */
  unmigratedTraceIds: string[];
  /** Baseline ids whose manifest is still a real stamp. */
  unmigratedBaselineIds: string[];
  /** Ids whose legacy path holds a tombstone. */
  tombstonedIds: string[];
}

async function readdirSafe(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch {
    return [];
  }
}

/**
 * Scan the legacy anchor paths. FILE CONTENT decides, never directory existence: see
 * {@link TOMBSTONE_MARKER} for why that distinction is the difference between a migration
 * marker and a permanent refusal loop.
 */
export async function scanLegacyLayout(root: string): Promise<LegacyLayoutScan> {
  const legacy = legacyPaths(root);
  const unmigratedTraceIds: string[] = [];
  const unmigratedBaselineIds: string[] = [];
  const tombstoned = new Set<string>();

  for (const entry of await readdirSafe(legacy.replayTraces)) {
    if (!entry.endsWith(".trace.json")) continue;
    const id = entry.slice(0, -".trace.json".length);
    if (await isTombstoneFile(path.join(legacy.replayTraces, entry))) tombstoned.add(id);
    else unmigratedTraceIds.push(id);
  }

  for (const entry of await readdirSafe(legacy.replayBaselines)) {
    const manifest = path.join(legacy.replayBaselines, entry, TRACE_BASELINE_MANIFEST);
    let raw: string;
    try {
      raw = await fs.readFile(manifest, "utf-8");
    } catch {
      // No manifest at all is a LEGACY (unstamped) baseline, which was never an anchor
      // and can never contribute a pass. It is not evidence of an un-migrated project.
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // A manifest that is present but unreadable is a BROKEN anchor either way, so it
      // is not a migration signal. It stays exactly as broken as it was.
      continue;
    }
    if (isTombstoneObject(parsed)) tombstoned.add(entry);
    else unmigratedBaselineIds.push(entry);
  }

  const state: LegacyLayoutState =
    unmigratedTraceIds.length > 0 || unmigratedBaselineIds.length > 0
      ? "unmigrated"
      : tombstoned.size > 0
        ? "tombstoned"
        : "none";

  return {
    state,
    unmigratedTraceIds: unmigratedTraceIds.sort(),
    unmigratedBaselineIds: unmigratedBaselineIds.sort(),
    tombstonedIds: [...tombstoned].sort(),
  };
}

/**
 * The refusal a door prints when it finds un-migrated anchors. Returns `[]` when there is
 * nothing to refuse, so a caller can write `if (lines.length) { print; return 2; }`.
 *
 * It REFUSES rather than silently reading the legacy path, for the reason the whole
 * verification model turns on: a run that graded half of an anchor set, or that graded a
 * demonstration whose approved frames it could not see, is a verdict nobody can audit.
 */
export function legacyLayoutRefusal(scan: LegacyLayoutScan, tag: string): string[] {
  if (scan.state !== "unmigrated") return [];
  const named = [
    ...scan.unmigratedTraceIds.map((id) => `${LOOMBRIDGE_DIRNAME}/replays/traces/${id}.trace.json`),
    ...scan.unmigratedBaselineIds.map((id) => `${LOOMBRIDGE_DIRNAME}/replays/baselines/${id}/`),
  ];
  return [
    `${tag} REFUSED: this project's anchors are still at the pre-S2 paths, so this run would ` +
      "grade against an anchor set it can only half see.",
    ...named.map((p) => `${tag}   ${p}`),
    `${tag} run: ${MIGRATE_VERB}`,
    `${tag} it moves the recorded demonstrations and approved baselines to ` +
      `${LOOMBRIDGE_DIRNAME}/anchors/, leaves a tombstone at each old path so an OLDER CLI ` +
      "reports a broken anchor instead of asking a human to re-record, and re-stamps every " +
      "recorded path. Nothing is deleted until the destination bytes verify.",
  ];
}
