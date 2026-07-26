/**
 * `loombridge design` — the deterministic half of the Design Target Phase (plan §3c).
 *
 * The Design Target is an *approved, frozen* annotated hero shot: the visual
 * contract `build` converges on and `verify`'s VLM review compares against. The
 * clean-room finding is blunt — without a visual target, polish is poor — so
 * `plan` is not complete until a target is approved (the readiness gate here).
 *
 * This module is deterministic and engine-agnostic: it ingests/freezes a hero
 * shot, records provenance, and reports readiness + frozen-integrity. The
 * judgment — *generating* the hero shot (provide / generate / reference-game) —
 * is the agent layer's job (`commands/loombridge/plan.md`), never the CLI's.
 */

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { packageRoot } from "../../shared/pkg-root.js";

import {
  loombridgePaths,
  nowIso,
  updateState,
  type DesignTargetStatus,
  type LoombridgePaths,
} from "../../domain/state.js";

// At runtime this file is dist/loombridge/design.js. The canonical (product-owned)
// schema for the artifacts this module writes lives next to the source under
// `src/domain/schemas/` — v0.6 explicitly settled the location decision: the
// product is the source of truth, projects are consumers. Exported so external
// tooling can resolve the schema path without grepping the package.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const DESIGN_TARGET_SCHEMA_PATH = path.join(
  packageRoot(import.meta.url),
  "src",
  "domain",
  "schemas",
  "design-target.schema.json",
);

/** Where the hero shot came from. */
export type DesignTargetMode = "provided" | "generated" | "reference-game";

/**
 * What KIND of artifact the Design Target image is (the 3D design-target split).
 *
 * - `rendered-unity-frame` — a real rendered frame of the assembled scene (a
 *   Unity capture for an engine build, or a final mock for a flat 2D game). It
 *   is the FROZEN hero shot: eligible for strict hero-shot fidelity + `doneness`.
 *   This is the DEFAULT so existing 2D/platformer targets stay "final" with no
 *   migration.
 * - `composition-reference` — a style/composition guide approved ONLY to unlock
 *   3D scene assembly. It is NOT a frozen hero shot and can NEVER certify
 *   `doneness` or satisfy final hero-shot fidelity. For a 3D vertical, a flat 2D
 *   mock cannot faithfully stand in for materials/proportions/lighting, so it
 *   guides composition while building; the real Unity capture is frozen later as
 *   a `rendered-unity-frame`.
 *
 * The 3D flow: (1) set/approve a `composition-reference`, (2) assemble the 3D
 * scene, (3) capture a real Unity frame, (4) `set --kind rendered-unity-frame
 * --approve` that frame, (5) only THEN does strict hero-shot fidelity run.
 */
export type DesignTargetKind = "composition-reference" | "rendered-unity-frame";

/**
 * The default kind for a Design Target. Final-by-default preserves existing
 * 2D/platformer behaviour: a target set without `--kind` (and any pre-split
 * `design-target.json` on disk, which has no `kind` field) is treated as a
 * frozen `rendered-unity-frame` and stays eligible for hero-shot fidelity.
 */
export const DEFAULT_DESIGN_TARGET_KIND: DesignTargetKind = "rendered-unity-frame";

/** Normalise a possibly-absent `kind` (pre-split files) to the default. */
export function resolveDesignTargetKind(
  kind: DesignTargetKind | string | null | undefined,
): DesignTargetKind {
  return kind === "composition-reference" ? "composition-reference" : DEFAULT_DESIGN_TARGET_KIND;
}

/** `.loombridge/design/design-target.json` — the frozen target's provenance. */
export interface DesignTargetMeta {
  schemaVersion: "1";
  status: DesignTargetStatus;
  mode: DesignTargetMode;
  /**
   * Artifact kind (the 3D design-target split). Absent on pre-split files ⇒
   * treated as `rendered-unity-frame` (the final-by-default rule).
   */
  kind?: DesignTargetKind;
  /** Set when mode === "reference-game". */
  referenceGame?: string | null;
  /** Hero-shot image filename, relative to `.loombridge/design/`. */
  heroShot: string;
  /** Optional editable source filename, relative to `.loombridge/design/`. */
  heroShotHtml?: string | null;
  /** sha256 of the hero-shot bytes at the last set/approve (the freeze). */
  pngSha256: string;
  note?: string | null;
  /** ISO timestamp of approval; null while draft. */
  approvedAt?: string | null;
  updatedAt: string;
}

const HERO_PNG = "hero-shot.png";
const HERO_HTML = "hero-shot.html";
const META_FILE = "design-target.json";

export interface DesignPaths {
  heroPng: string;
  heroHtml: string;
  meta: string;
}

export function designPaths(paths: LoombridgePaths): DesignPaths {
  return {
    heroPng: path.join(paths.design, HERO_PNG),
    heroHtml: path.join(paths.design, HERO_HTML),
    meta: path.join(paths.design, META_FILE),
  };
}

/**
 * The Design Target readiness gate. Ready (0) iff the target is `approved` AND
 * its bytes still match the frozen hash. A tampered approved hero shot (status
 * still says approved but bytes differ from the freeze) is NOT ready — the
 * "frozen = golden" invariant must be enforced by the gate, not just reported.
 * Pure + exported so this is unit-tested without fixtures.
 */
export function exitCodeForDesignReadiness(
  report: { status: DesignTargetStatus; frozenMatches: boolean },
): number {
  return report.status === "approved" && report.frozenMatches ? 0 : 1;
}

async function sha256OrNull(absPath: string): Promise<string | null> {
  try {
    return createHash("sha256").update(await fs.readFile(absPath)).digest("hex");
  } catch {
    return null;
  }
}

async function readMeta(dp: DesignPaths): Promise<DesignTargetMeta | null> {
  try {
    return JSON.parse(await fs.readFile(dp.meta, "utf-8")) as DesignTargetMeta;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function writeMeta(dp: DesignPaths, meta: DesignTargetMeta): Promise<void> {
  await fs.mkdir(path.dirname(dp.meta), { recursive: true });
  await fs.writeFile(dp.meta, `${JSON.stringify(meta, null, 2)}\n`, "utf-8");
}

export interface DesignStatusReport {
  status: DesignTargetStatus;
  hasPng: boolean;
  hasHtml: boolean;
  mode?: DesignTargetMode;
  /**
   * Artifact kind (the 3D split). Always resolved to a concrete value — a
   * pre-split target with no `kind` on disk reads as `rendered-unity-frame`.
   */
  kind: DesignTargetKind;
  referenceGame?: string | null;
  approvedAt?: string | null;
  /** The hash recorded at the last set/approve (the freeze); null when missing. */
  pngSha256?: string | null;
  /** True when the current hero-shot bytes still match the frozen hash. */
  frozenMatches: boolean;
}

/** Inspect the Design Target on disk (no mutation). */
export async function designStatus(paths: LoombridgePaths): Promise<DesignStatusReport> {
  const dp = designPaths(paths);
  const meta = await readMeta(dp);
  const currentHash = await sha256OrNull(dp.heroPng);
  const hasPng = currentHash !== null;
  const hasHtml = await filePresent(dp.heroHtml);

  if (!meta) {
    return {
      status: "missing",
      hasPng,
      hasHtml,
      kind: DEFAULT_DESIGN_TARGET_KIND,
      pngSha256: null,
      frozenMatches: false,
    };
  }
  return {
    status: meta.status,
    hasPng,
    hasHtml,
    mode: meta.mode,
    kind: resolveDesignTargetKind(meta.kind),
    referenceGame: meta.referenceGame ?? null,
    approvedAt: meta.approvedAt ?? null,
    pngSha256: meta.pngSha256,
    // A frozen target is only honoured if the bytes still match the recorded hash.
    frozenMatches: hasPng && currentHash === meta.pngSha256,
  };
}

async function filePresent(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export interface SetDesignTargetArgs {
  root: string;
  /** Source image to freeze as the hero shot. */
  imagePath: string;
  /** Optional editable source (HTML) to keep alongside. */
  htmlPath?: string;
  mode: DesignTargetMode;
  /**
   * Artifact kind (the 3D split). Defaults to `rendered-unity-frame` (final).
   * Pass `composition-reference` to approve a style/composition guide that
   * unlocks scene assembly but can never certify final hero-shot fidelity.
   */
  kind?: DesignTargetKind;
  referenceGame?: string;
  note?: string;
  /** Approve immediately (otherwise the target is recorded as `draft`). */
  approve?: boolean;
}

/** Ingest + freeze a hero shot into `.loombridge/design/` and record provenance. */
export async function setDesignTarget(args: SetDesignTargetArgs): Promise<DesignTargetMeta> {
  if (args.mode === "reference-game" && !args.referenceGame) {
    throw new Error("--reference-game <name> is required when --mode reference-game.");
  }
  const paths = loombridgePaths(args.root);
  const dp = designPaths(paths);
  await fs.mkdir(paths.design, { recursive: true });

  await fs.copyFile(args.imagePath, dp.heroPng);
  if (args.htmlPath) await fs.copyFile(args.htmlPath, dp.heroHtml);

  const hash = await sha256OrNull(dp.heroPng);
  if (!hash) throw new Error(`Could not read the frozen hero shot at ${dp.heroPng}.`);

  const status: DesignTargetStatus = args.approve ? "approved" : "draft";
  const meta: DesignTargetMeta = {
    schemaVersion: "1",
    status,
    mode: args.mode,
    kind: resolveDesignTargetKind(args.kind),
    referenceGame: args.mode === "reference-game" ? args.referenceGame ?? null : null,
    heroShot: HERO_PNG,
    heroShotHtml: args.htmlPath ? HERO_HTML : null,
    pngSha256: hash,
    note: args.note ?? null,
    approvedAt: args.approve ? nowIso() : null,
    updatedAt: nowIso(),
  };
  await writeMeta(dp, meta);
  await updateState(paths, { designTarget: status });
  return meta;
}

/** Approve an already-ingested draft hero shot (re-freezing its current bytes). */
export async function approveDesignTarget(args: { root: string; note?: string }): Promise<DesignTargetMeta> {
  const paths = loombridgePaths(args.root);
  const dp = designPaths(paths);
  const meta = await readMeta(dp);
  if (!meta) {
    throw new Error("No design target to approve — run `loombridge design set --image <path>` first.");
  }
  const hash = await sha256OrNull(dp.heroPng);
  if (!hash) throw new Error(`Hero shot missing at ${dp.heroPng}; cannot approve.`);

  const approved: DesignTargetMeta = {
    ...meta,
    status: "approved",
    // Preserve the draft's kind; a pre-split draft (no `kind`) normalises to the
    // final-by-default `rendered-unity-frame`. Approving never silently promotes
    // a composition-reference to a frozen hero shot — that needs an explicit
    // `set --kind rendered-unity-frame` of the captured Unity frame.
    kind: resolveDesignTargetKind(meta.kind),
    pngSha256: hash, // re-freeze to the current bytes
    note: args.note ?? meta.note ?? null,
    approvedAt: nowIso(),
    updatedAt: nowIso(),
  };
  await writeMeta(dp, approved);
  await updateState(paths, { designTarget: "approved" });
  return approved;
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI (`loombridge design <status|set|approve>`) — a non-headline helper the plan
// flow calls; not part of the two-verb surface.
// ─────────────────────────────────────────────────────────────────────────────

function printUsage(): void {
  console.log(
    [
      "Usage: loombridge design <status|set|approve> [options]",
      "",
      "Manage the Design Target (annotated hero shot) in .loombridge/design/.",
      "",
      "  status   [--root <dir>] [--require-approved]",
      "  set      --image <path> [--html <path>] [--mode provided|generated|reference-game]",
      "           [--kind composition-reference|rendered-unity-frame]",
      "           [--reference-game <name>] [--note <text>] [--approve] [--root <dir>]",
      "  approve  [--note <text>] [--root <dir>]",
      "",
      "Kinds (the 3D design-target split):",
      "  rendered-unity-frame  (default) the FROZEN hero shot — a real rendered frame",
      "                        (Unity capture, or a final 2D mock). Eligible for strict",
      "                        hero-shot fidelity + `doneness`.",
      "  composition-reference a style/composition guide approved ONLY to unlock 3D scene",
      "                        assembly. NEVER certifies `doneness` / final fidelity.",
      "                        3D flow: approve a composition-reference → assemble the",
      "                        scene → capture a Unity frame → `set --kind",
      "                        rendered-unity-frame --approve` → only then run fidelity.",
    ].join("\n"),
  );
}

interface DesignFlags {
  root: string;
  imagePath?: string;
  htmlPath?: string;
  mode: DesignTargetMode;
  kind?: DesignTargetKind;
  referenceGame?: string;
  note?: string;
  approve: boolean;
  requireApproved: boolean;
}

const DESIGN_TARGET_KINDS: ReadonlySet<DesignTargetKind> = new Set([
  "composition-reference",
  "rendered-unity-frame",
]);

function parseFlags(args: string[]): DesignFlags {
  const f: DesignFlags = { root: process.cwd(), mode: "provided", approve: false, requireApproved: false };
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === "--root") f.root = path.resolve(args[(i += 1)] ?? f.root);
    else if (a === "--image") f.imagePath = path.resolve(args[(i += 1)] ?? "");
    else if (a === "--html") f.htmlPath = path.resolve(args[(i += 1)] ?? "");
    else if (a === "--mode") f.mode = (args[(i += 1)] as DesignTargetMode) ?? f.mode;
    else if (a === "--kind") {
      const value = args[(i += 1)] ?? "";
      if (!DESIGN_TARGET_KINDS.has(value as DesignTargetKind)) {
        throw new Error(`--kind must be composition-reference|rendered-unity-frame (got "${value}").`);
      }
      f.kind = value as DesignTargetKind;
    } else if (a === "--reference-game") f.referenceGame = args[(i += 1)] ?? undefined;
    else if (a === "--note") f.note = args[(i += 1)] ?? undefined;
    else if (a === "--approve") f.approve = true;
    else if (a === "--require-approved") f.requireApproved = true;
    else throw new Error(`unknown argument "${a}".`);
  }
  return f;
}

/** CLI entry: `loombridge design <action> [flags]`. */
export async function run(args: string[]): Promise<number> {
  const action = args[0];
  if (!action || action === "--help" || action === "-h") {
    printUsage();
    return 0;
  }
  let flags: DesignFlags;
  try {
    flags = parseFlags(args.slice(1));
  } catch (error) {
    console.error(`[loombridge design] ${error instanceof Error ? error.message : String(error)}`);
    printUsage();
    return 2;
  }

  try {
    switch (action) {
      case "status": {
        const report = await designStatus(loombridgePaths(flags.root));
        const frozen = report.status === "approved" && !report.frozenMatches ? " (CHANGED since approval — re-approve!)" : "";
        const compRefNote =
          report.status === "approved" && report.kind === "composition-reference"
            ? " (composition-reference: unlocks scene assembly only — capture a Unity frame + `set --kind rendered-unity-frame --approve` before doneness)"
            : "";
        console.error(
          `[loombridge design] status=${report.status}${frozen} kind=${report.kind} png=${report.hasPng} html=${report.hasHtml}` +
            `${report.mode ? ` mode=${report.mode}` : ""}${report.referenceGame ? ` ref=${report.referenceGame}` : ""}${compRefNote}`,
        );
        return flags.requireApproved ? exitCodeForDesignReadiness(report) : 0;
      }
      case "set": {
        if (!flags.imagePath) throw new Error("set requires --image <path>.");
        const meta = await setDesignTarget({
          root: flags.root,
          imagePath: flags.imagePath,
          htmlPath: flags.htmlPath,
          mode: flags.mode,
          kind: flags.kind,
          referenceGame: flags.referenceGame,
          note: flags.note,
          approve: flags.approve,
        });
        console.error(`[loombridge design] set hero shot (status=${meta.status}, kind=${meta.kind ?? DEFAULT_DESIGN_TARGET_KIND}, mode=${meta.mode}).`);
        return 0;
      }
      case "approve": {
        const meta = await approveDesignTarget({ root: flags.root, note: flags.note });
        console.error(`[loombridge design] approved (frozen sha256=${meta.pngSha256.slice(0, 12)}…).`);
        return 0;
      }
      default:
        console.error(`[loombridge design] unknown action "${action}".`);
        printUsage();
        return 2;
    }
  } catch (error) {
    console.error(`[loombridge design] ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
