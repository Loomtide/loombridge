import { assertValidSlicePlan, SLICES_SCHEMA_VERSION, type SlicePlan } from "../../verification/slices.js";
import {
  ACCEPTANCE_SCHEMA_VERSION,
  type AcceptanceContract,
  type HudAnchor,
  type NumericTarget,
  type ToleranceBand,
} from "../../verification/types.js";
import { assertValidAcceptanceContract } from "../../verification/validator.js";
import { assertValidGenreContract } from "./validator.js";
import type { FeelBand, GenreContract, MeasurabilityEntry, SliceNode } from "./types.js";

export const GENRE_PROMOTION_REPORT_SCHEMA_VERSION = "0.1.0" as const;

export interface PromotedMeasurabilityRow {
  target: string;
  tag: MeasurabilityEntry["tag"];
  bucket: MeasurabilityEntry["bucket"];
  calculator?: string;
  targetBand?: FeelBand;
  gateBand?: FeelBand;
  evidenceKind?: MeasurabilityEntry["evidenceKind"];
}

export interface GenrePromotionReport {
  schemaVersion: typeof GENRE_PROMOTION_REPORT_SCHEMA_VERSION;
  sourceGenreId: string;
  /**
   * sha256 of the raw source-contract bytes this report was promoted from. Present whenever the
   * caller supplied it (`loombridge plan` always does); absent on a report written by an older
   * release.
   *
   * WHAT IT PROVES, EXACTLY: that this report came from a specific contract file, and WHICH bytes.
   * It does NOT prove the contract was any good — `validateGenreContract` owns that and runs before
   * promotion. It does not make the report unforgeable either: someone writing a report by hand can
   * also write a digest. It raises the cost of claiming a promotion that never happened, and it lets
   * a reviewer confirm the contract in the repo is the one that produced the plan on disk.
   */
  sourceContractSha256?: string;
  sourceConfidence: GenreContract["confidence"];
  generatedAcceptance: string;
  generatedSlices: string;
  promotedCoreSlices: string[];
  deferredSlices: string[];
  explicitGaps: Record<string, string[]>;
  measurability: PromotedMeasurabilityRow[];
  refusalConditions: GenreContract["refusalConditions"];
  humanOracleChecks: GenreContract["humanOracleChecks"];
  /**
   * The contract's declared hero-shot fidelity criteria, carried through VERBATIM so `doneness` can
   * resolve them for an unregistered genre from the on-disk `GENRE_PROMOTION.json` rather than from
   * the contract file (which need not travel with the project). Omitted when the contract declares
   * none — and an absent list is a REFUSAL at doneness for a design-targeted build, never a fallback
   * to another genre's criteria.
   */
  fidelityCriteria?: string[];
}

export interface GenrePromotionResult {
  acceptance: AcceptanceContract;
  slices: SlicePlan;
  report: GenrePromotionReport;
  /**
   * The values the promoter INVENTED because the GenreContract has no field for them, in prose the
   * CLI prints verbatim.
   *
   * A GenreContract declares a core loop, feel bands and a slice DAG; it says nothing about a win
   * rule, a font, a palette, or a native resolution. The promoter fills those from a pixel-art 2D
   * template, and `GAME_SPEC.md` then states them as fact ("Objective: all-enemies-defeated") with
   * nothing marking them as assumptions. Naming them once at promotion time is the difference
   * between a default and a silent decision. Not persisted on the report: this is a fact about THIS
   * promotion run, and a reader wants it while they still have the contract open.
   */
  defaults: string[];
}

export interface GenrePromotionOptions {
  /** Optional registered pack slice template; matching ids preserve pack-owned skill/gate guidance. */
  sliceTemplate?: SlicePlan;
  /**
   * sha256 of the RAW source-contract bytes, computed by the caller that read the file. Recorded on
   * the report so a promotion is pinned to the exact input it came from.
   *
   * Raw BYTES, never `JSON.stringify(contract)` — a re-serialization is canonicalization-dependent
   * (key order, spacing, unicode escaping), so it would drift between Node versions and between a
   * hand-formatted file and a generated one, and a digest that drifts proves nothing.
   */
  sourceContractSha256?: string;
}

const HUD_ANCHORS: HudAnchor[] = ["top-left", "top-center", "top-right", "bottom-left", "bottom-right"];
const KNOWN_FEEL_KEYS = new Set([
  "runSpeed",
  "jumpApex",
  "timeToApex",
  "shortHopApex",
  "dashDistance",
  "dashTime",
  "dashCooldown",
  "coyoteTime",
  "jumpBuffer",
]);

function parseAspect(aspect: string | undefined): { w: number; h: number } {
  const match = aspect?.match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/);
  if (!match) return { w: 16, h: 9 };
  const w = Number(match[1]);
  const h = Number(match[2]);
  return Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0 ? { w, h } : { w: 16, h: 9 };
}

function sanitizeId(value: string): string {
  const id = value.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return id || "item";
}

function regexForRole(role: string): string {
  return sanitizeId(role).split("-").filter(Boolean).join(".*") || "item";
}

function targetFromBand(row: MeasurabilityEntry, tunableUnits: ReadonlyMap<string, string>): NumericTarget | null {
  const band = row.gateBand;
  if (!band) return null;
  const min = typeof band.min === "number" && Number.isFinite(band.min) ? band.min : undefined;
  const max = typeof band.max === "number" && Number.isFinite(band.max) ? band.max : undefined;
  if (min === undefined && max === undefined) return null;

  let target: number;
  let tolerance: ToleranceBand | undefined;
  if (min !== undefined && max !== undefined) {
    target = (min + max) / 2;
    tolerance = { abs: (max - min) / 2 };
  } else if (max !== undefined) {
    target = max;
  } else {
    target = min!;
  }

  return {
    target,
    unit: band.unit ?? tunableUnits.get(row.target) ?? "unitless",
    ...(tolerance ? { band: tolerance } : {}),
    note: `${row.tag}; ${row.evidenceKind ?? "no-band-evidence"}; ${row.bucket}`,
  };
}

function buildFeel(contract: GenreContract): AcceptanceContract["feel"] {
  const tunableUnits = new Map(contract.tunables.flatMap((t) => t.unit ? [[t.id, t.unit] as const] : []));
  const feel: AcceptanceContract["feel"] = {};
  const extra: Record<string, NumericTarget> = {};
  for (const row of contract.measurabilityMap) {
    const target = targetFromBand(row, tunableUnits);
    if (!target) continue;
    if (KNOWN_FEEL_KEYS.has(row.target)) {
      (feel as Record<string, NumericTarget>)[row.target] = target;
    } else {
      extra[row.target] = target;
    }
  }
  if (Object.keys(extra).length > 0) feel.extra = extra;
  return feel;
}

function buildHud(contract: GenreContract): AcceptanceContract["hud"] {
  const hudRoles = (contract.artDirection.assetRoles ?? [])
    .filter((role) => /hud|score|ammo|health|lives|timer/i.test(role))
    .map((role) => sanitizeId(role.replace(/-?hud$/i, "")))
    .filter(Boolean);
  const unique = [...new Set(hudRoles.length > 0 ? hudRoles : ["status"] )];
  return {
    elements: unique.map((id, index) => ({
      id,
      role: id.replace(/-/g, " "),
      anchor: HUD_ANCHORS[index % HUD_ANCHORS.length]!,
      colorRole: id,
      font: "Press Start 2P",
      required: true,
    })),
  };
}

function buildManifest(contract: GenreContract): AcceptanceContract["manifest"] {
  const roles = (contract.artDirection.assetRoles ?? [])
    .filter((role) => !/hud|sfx|vfx|palette|theme/i.test(role))
    .map((role) => sanitizeId(role));
  const budgetRoles = Object.keys(contract.verticalSliceBudget.coreVerticalContent).map((role) => sanitizeId(role));
  const unique = [...new Set([...roles, ...budgetRoles])];
  const required = unique.length > 0 ? unique : ["player", "game-manager"];
  return {
    matching: "regex",
    caseSensitive: false,
    extrasAreFailure: false,
    elements: required.map((role) => ({
      nameRegex: regexForRole(role),
      type: "GameObject",
      primitive: role,
      required: true,
    })),
  };
}

// `genreId` was only ever read to mint the synthetic skill name removed below; nothing else in a
// promoted slice is genre-derived, so the parameter went with it.
function buildSlice(node: SliceNode, template?: SlicePlan["slices"][number]) {
  if (!node.gates || node.gates.length === 0) return null;
  const gaps = node.gaps?.length ? ` Explicit gaps: ${node.gaps.join(", ")}.` : "";
  const gates = [...new Set([...(node.gates ?? []), ...(template?.acceptance.gates ?? [])])];
  return {
    id: node.id,
    title: node.title,
    dependsOn: node.dependsOn,
    // Only a registered pack template can supply a skill binding. GenreContract's `SliceNode` has no
    // `skill` field at all, so the previous `genre-<genreId>-<sliceId>` fallback could only ever name
    // something that does not exist — EVERY promoted contract emitted bindings that were dangling by
    // construction, and `plan` printed them to the agent as the skill to build with. Omit instead:
    // "no skill pack covers this" is a true statement, and an invented name is not.
    ...(template?.skill ? { skill: template.skill } : {}),
    feelIntent: `${template?.feelIntent ?? node.title}.${gaps}`.trim(),
    acceptance: { gates },
    state: "pending" as const,
  };
}

/**
 * The gates that walk a contract SECTION a non-platformer contract does not declare, one gate per
 * omitted section: `platform-tiles` + `tile-render` + `parallax-motion` walk `platformer`,
 * `reachability` walks `reachability`, `placement` walks `placement`, and `prop-purpose` walks
 * `props` + `placement`.
 *
 * THE ONE LIST, exported so the three shipped non-platformer pack templates and `_generic` cannot
 * drift from it (`pack-gate-applicability.test.ts` binds all five to this constant, with a LITMUS).
 * Those packs' notes assert "the same set promote.ts applies", and until `prop-purpose` was added
 * here that sentence was simply false: `prop-purpose` is pure 2D geometry with no `props` section
 * defaults, so a contract-planned 3D game was graded on props it never declared.
 *
 * NOT a blanket off-switch: a contract whose slice DAG explicitly REQUESTS one of these keeps it
 * applicable (the `gated` filter below), so a genre that really does own platform tiles still gets
 * graded on them.
 */
export const CONTRACT_OMITTED_SECTION_GATES = [
  "platform-tiles",
  "tile-render",
  "parallax-motion",
  "reachability",
  "placement",
  "prop-purpose",
] as const;

function verificationOverrides(contract: GenreContract): AcceptanceContract["verification"] {
  const gated = new Set(contract.sliceDag.coreVertical.flatMap((slice) => slice.gates ?? []));
  const gates = Object.fromEntries(
    CONTRACT_OMITTED_SECTION_GATES
      .filter((gate) => !gated.has(gate))
      .map((gate) => [gate, "not_applicable" as const]),
  );
  const hasGates = Object.keys(gates).length > 0;
  // RCL §6: propagate a plan-time evidence-class expectation VERBATIM into the generated acceptance
  // contract's `verification.requiredEvidenceClasses`, where `loombridge doneness` enforces it. Absent ⇒
  // the section is emitted exactly as before (byte-identical), so legacy contracts are untouched.
  const evidence = contract.requiredEvidenceClasses;
  const hasEvidence = evidence !== undefined;
  if (!hasGates && !hasEvidence) return undefined;
  return {
    ...(hasGates
      ? {
          gates,
          note: "Promoted generic contract: one gate per contract section this contract omits (platformer / reachability / placement / props) is not applicable unless the slice DAG explicitly requests it.",
        }
      : {}),
    ...(hasEvidence ? { requiredEvidenceClasses: [...evidence] } : {}),
  };
}

export function promoteGenreContract(input: unknown, options: GenrePromotionOptions = {}): GenrePromotionResult {
  const contract = assertValidGenreContract(input);
  const aspect = parseAspect(contract.targetPlatform.aspect);
  const hud = buildHud(contract);
  const acceptance: AcceptanceContract = {
    schemaVersion: ACCEPTANCE_SCHEMA_VERSION,
    game: contract.genreId,
    // The promoted contract states its own genre, so the artifact that IS the grading is bound to a
    // genre wherever it is written, including `adopt`'s proposal, which never goes through `plan`.
    genre: contract.genreId,
    source: {
      note: `Promoted from GenreContract ${contract.genreId}; genreClass=${contract.coreLoop.genreClass}; confidence=${contract.confidence}.`,
    },
    fonts: {
      global: { family: "Press Start 2P" },
      byRole: Object.fromEntries(hud.elements.map((el) => [el.id, { family: "Press Start 2P" }])),
    },
    palette: {
      entries: [
        { hex: "#0d1015", roles: ["background"], name: "ink" },
        { hex: "#4dd0e1", roles: ["hud-accent", "ammo"], name: "cyan" },
        { hex: "#ff4d8d", roles: ["juice", "health"], name: "magenta" },
        { hex: "#ffd166", roles: ["score", "weapon"], name: "gold" },
        { hex: "#ffffff", roles: ["reticle", "status"], name: "white" },
      ],
    },
    hud,
    framing: {
      aspect,
      nativeResolution: { w: aspect.w * 16, h: aspect.h * 16 },
      cameraMode: contract.coreLoop.perspective?.includes("top-down") ? "static" : "follow",
      playerAnchor: { centerXFraction: 0.5, tolerance: 0.1 },
      verticalPan: false,
    },
    feel: buildFeel(contract),
    juice: {},
    manifest: buildManifest(contract),
    win: {
      rule: contract.coreLoop.subGenre?.includes("shooter") || contract.genreId.includes("shooter")
        ? "all-enemies-defeated"
        : "complete-core-loop",
      endStateMode: "modal",
      restartAction: "R",
    },
    ...(verificationOverrides(contract) ? { verification: verificationOverrides(contract) } : {}),
  };
  const validAcceptance = assertValidAcceptanceContract(acceptance);

  const droppedCoreSliceIds = new Set(
    contract.sliceDag.coreVertical
      .filter((node) => !node.gates || node.gates.length === 0)
      .map((node) => node.id),
  );
  for (const node of contract.sliceDag.coreVertical) {
    const droppedDeps = node.dependsOn.filter((dep) => droppedCoreSliceIds.has(dep));
    if (node.gates?.length && droppedDeps.length > 0) {
      throw new Error(
        `cannot promote gated slice "${node.id}" because it depends on gap-only slice(s): ${droppedDeps.join(", ")}`,
      );
    }
  }
  const templateById = new Map((options.sliceTemplate?.slices ?? []).map((slice) => [slice.id, slice]));
  const promotedCoreSlices = contract.sliceDag.coreVertical
    .map((node) => buildSlice(node, templateById.get(node.id)))
    .filter((slice): slice is NonNullable<ReturnType<typeof buildSlice>> => slice !== null);
  const slices = assertValidSlicePlan({
    schemaVersion: SLICES_SCHEMA_VERSION,
    genre: contract.genreId,
    slices: promotedCoreSlices,
  });

  const report: GenrePromotionReport = {
    schemaVersion: GENRE_PROMOTION_REPORT_SCHEMA_VERSION,
    sourceGenreId: contract.genreId,
    ...(options.sourceContractSha256 ? { sourceContractSha256: options.sourceContractSha256 } : {}),
    sourceConfidence: contract.confidence,
    generatedAcceptance: ".loombridge/ACCEPTANCE.json",
    generatedSlices: ".loombridge/SLICES.json",
    promotedCoreSlices: promotedCoreSlices.map((slice) => slice.id),
    deferredSlices: contract.sliceDag.deferredMeta.map((slice) => slice.id),
    explicitGaps: Object.fromEntries(
      [...contract.sliceDag.coreVertical, ...contract.sliceDag.deferredMeta]
        .filter((slice) => slice.gaps && slice.gaps.length > 0)
        .map((slice) => [slice.id, slice.gaps ?? []]),
    ),
    measurability: contract.measurabilityMap.map((row) => ({
      target: row.target,
      tag: row.tag,
      bucket: row.bucket,
      ...(row.calculator ? { calculator: row.calculator } : {}),
      ...(row.band ? { targetBand: row.band } : {}),
      ...(row.gateBand ? { gateBand: row.gateBand } : {}),
      ...(row.evidenceKind ? { evidenceKind: row.evidenceKind } : {}),
    })),
    refusalConditions: contract.refusalConditions,
    humanOracleChecks: contract.humanOracleChecks,
    // Verbatim, and only when declared — the absent case must stay absent so doneness refuses rather
    // than reading an empty list as "no fidelity requirement".
    ...(contract.fidelityCriteria && contract.fidelityCriteria.length > 0
      ? { fidelityCriteria: [...contract.fidelityCriteria] }
      : {}),
  };

  return { acceptance: validAcceptance, slices, report, defaults: promotionDefaults(validAcceptance) };
}

/**
 * The pixel-art-2D assumptions the promoter had to make, read back off the contract it just built so
 * the prose cannot drift from the values. See {@link GenrePromotionResult.defaults}.
 */
function promotionDefaults(acceptance: AcceptanceContract): string[] {
  const res = acceptance.framing.nativeResolution;
  return [
    `win.rule = "${acceptance.win.rule}" (a GenreContract declares no win condition; derived from the genre id / subGenre)`,
    `fonts = "${acceptance.fonts.global?.family ?? "?"}" globally and per HUD role (a pixel-art 2D default)`,
    `palette = the ${acceptance.palette.entries.length}-entry generic pixel-art palette (no artDirection.palette is read)`,
    `framing.nativeResolution = ${res?.w ?? "?"}x${res?.h ?? "?"} (aspect x16: a pixel-art tile assumption)`,
  ];
}
