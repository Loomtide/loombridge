#!/usr/bin/env node
/**
 * run-gates.ts — the Tier-1 gate-runner glue CLI (Phase D).
 *
 * Loads an `acceptance.json` contract + a directory of captured op-output JSON
 * files (the verifying agent saves each MCP op's output there during a run),
 * maps each known filename to its Phase-C evaluator, runs the evaluators, and
 * writes the aggregated `build-verdict.json`.
 *
 * Missing inputs degrade to a WARN gate (they do NOT crash the run) so a
 * partial capture still yields a useful verdict + a clear "not measured" list.
 *
 * The Tier-2 VLM review (§5) is ADVISORY: with `--vlm <findings.json>` its
 * review-findings are merged under a SEPARATE `reviewFindings` key — they are
 * NOT folded into the Tier-1 `status`.
 *
 * Usage:
 *   node dist/capabilities/verification/run-gates.js \
 *     --acceptance src/capabilities/verification/tiderunner.acceptance.json \
 *     --inputs ../demos/.artifacts/verify \
 *     --output ../demos/.artifacts/verify/build-verdict.json \
 *     [--vlm ../demos/.artifacts/verify/vlm-review.json]
 *
 * Mirrors the `scenario-cli.ts` CLI style (argv parse + run() returning an exit
 * code + a `--help` path + a main-module guard).
 *
 * See `gates/README.md` for the op→evaluator orchestration recipe (which
 * filename maps to which Phase-C evaluator).
 */

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, resolve } from "node:path";

import {
  aggregateVerdict,
  evaluateAssetSourceFidelity,
  evaluateConsoleClean,
  evaluateCoverage,
  evaluateFeel,
  evaluateFeelProvenance,
  evaluateFeelRederive,
  evaluateFrameIntegrity,
  evaluateFraming,
  evaluateManifest,
  evaluateParallaxMotion,
  evaluatePhysicsTimestep,
  evaluatePlacement,
  evaluatePlayability,
  evaluatePlatformTiles,
  evaluateTileRender,
  evaluatePropPurpose,
  evaluateReachability,
  evaluateRenderFrame,
  evaluateSfxPresence,
  evaluateSfxRuntime,
  evaluateInputToSfxLatency,
  evaluateSfxFatigue,
  evaluateUiConformance,
  evaluateVisualArtifacts,
  makeGateReport,
  type ConsoleLogsResult,
  type CoverageInput,
  type FeelMeasurements,
  type FrameIntegrityInput,
  type GateReport,
  type PlacementInput,
  type ParallaxMotionInput,
  type PlayabilityResults,
  type PlatformTilesInput,
  type TileRenderInput,
  type PropPurposeInput,
  type ReachabilityLayout,
  type RenderFrameInput,
  type ScanTextComponentsResult,
  type ScreenRectsResult,
  type VisualArtifactsInput,
  type VerifyManifestResult,
} from "./gates/index.js";
import type { BuildVerdict, CheckStatus, GateCheck } from "./gates/types.js";
import { assertValidAcceptanceContract } from "./validator.js";
import type { AcceptanceContract, SfxVerificationSection } from "./types.js";
import { validateCueMapSchema, type CueMapSchema } from "../sfx/cue-map.js";
import type {
  SfxAssetBindingCapture,
  SfxLatencyCapture,
  SfxSequenceCapture,
} from "../sfx/capture-shapes.js";

// ─────────────────────────────────────────────────────────────────────────────
// Contract sections (H1/L108: what a gate WALKS)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The CLOSED set of acceptance-contract sections a gate can walk.
 *
 * L108, the repo's own "declared path nothing walks" failure lifted to the contract
 * level: `manifest.elements` required a goal object and an `SfxPlayer`, `audio.cues`
 * required six clips, and the `manifest` gate was in NO slice's gate list, so the
 * project reached 9/9 approved with `manifest` reported `not_applicable` nine times.
 * Nothing validated that the union of the plan's gates covers the contract's own
 * required sections, because nothing had ever written down which sections each gate
 * covers. This vocabulary is that missing half.
 */
export const CONTRACT_SECTIONS = [
  "fonts",
  "palette",
  "hud",
  "framing",
  "physics",
  "feel",
  "juice",
  "audio",
  "manifest",
  "win",
  "props",
  "placement",
  "platformer",
  "reachability",
  "render",
] as const;

export type ContractSectionName = (typeof CONTRACT_SECTIONS)[number];

// ─────────────────────────────────────────────────────────────────────────────
// Input-file → evaluator map (the captured-op-output contract)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The gates, in the §10 fail-fast run order (cheap → expensive). Each entry maps
 * the captured op-output filename the agent saves to its Phase-C evaluator.
 * The `gate` name MUST match the evaluator's `GATE_NAME` so a degraded
 * (missing-input) gate reports under the same key as a real one.
 */
interface GateSpec {
  /** Gate name (matches the evaluator's GATE_NAME). */
  gate: string;
  /** Expected capture filename inside the `--inputs` directory. */
  file: string;
  /** Which MCP op produces it (for the degraded-warn message). */
  op: string;
  /**
   * H1/L108: which ACCEPTANCE CONTRACT SECTIONS this gate walks. Declared ON the
   * registry entry so a new gate cannot be added without answering the question, and
   * so the contract-coverage refusal reads the same table the runner dispatches from.
   * `[]` is a legitimate answer (the gate grades a capture's internal consistency and
   * binds no contract section), and it is an ANSWER, not an omission: the repo guard
   * `contract-coverage.test.ts` fails when any supported gate id is missing from the
   * declaration.
   */
  sections: readonly ContractSectionName[];
  /** Run the evaluator over the parsed op output. */
  run: (data: unknown, acceptance: AcceptanceContract) => GateReport;
}

const GATE_SPECS: GateSpec[] = [
  {
    gate: "manifest",
    file: "verify-manifest.json",
    op: "unity_scene_verify_manifest",
    sections: ["manifest"],
    run: (data, acceptance) =>
      evaluateManifest(data as VerifyManifestResult, acceptance),
  },
  {
    gate: "ui-conformance",
    file: "ui-scan.json",
    op: "unity_ui_scan_text_components",
    sections: ["hud", "fonts", "palette"],
    run: (data, acceptance) =>
      evaluateUiConformance(data as ScanTextComponentsResult, acceptance),
  },
  {
    gate: "framing",
    file: "screen-rects.json",
    op: "unity_scene_get_screen_rects",
    sections: ["framing"],
    run: (data, acceptance) =>
      evaluateFraming(data as ScreenRectsResult, acceptance),
  },
  {
    gate: "render-frame",
    file: "render-frame.json",
    op: "unity_editor_screenshot + screenshot pixel analysis",
    sections: ["render"],
    run: (data, acceptance) =>
      evaluateRenderFrame(data as RenderFrameInput, acceptance),
  },
  {
    gate: "coverage",
    file: "coverage.json",
    op: "scene.get_bounds of parallax layers at play soak",
    sections: ["juice"],
    run: (data, acceptance) =>
      evaluateCoverage(data as CoverageInput, acceptance),
  },
  {
    gate: "parallax-motion",
    file: "parallax-motion.json",
    op: "ParallaxLayer offset capture",
    sections: ["platformer"],
    run: (data, acceptance) =>
      evaluateParallaxMotion(data as ParallaxMotionInput, acceptance),
  },
  {
    gate: "visual-artifacts",
    file: "visual-artifacts.json",
    op: "stateful screenshot artifact analysis",
    sections: ["render"],
    run: (data, acceptance) =>
      evaluateVisualArtifacts(data as VisualArtifactsInput, acceptance),
  },
  {
    gate: "reachability",
    file: "reachability.json",
    op: "scene.get_bounds layout capture",
    sections: ["feel", "reachability"],
    run: (data, acceptance) =>
      evaluateReachability(data as ReachabilityLayout, acceptance),
  },
  {
    gate: "placement",
    file: "placement.json",
    op: "scene.get_bounds (grounds + grounded items) + camera frame",
    sections: ["placement"],
    run: (data, acceptance) =>
      evaluatePlacement(data as PlacementInput, acceptance),
  },
  {
    gate: "platform-tiles",
    file: "platform-tiles.json",
    op: "platform/tile construction capture",
    sections: ["platformer", "placement"],
    run: (data, acceptance) =>
      evaluatePlatformTiles(data as PlatformTilesInput, acceptance),
  },
  {
    gate: "tile-render",
    file: "tile-render.json",
    op: "platform/tile render capture (GroundTiling.WriteTileCaptures)",
    sections: ["platformer"],
    run: (data, acceptance) =>
      evaluateTileRender(data as TileRenderInput, acceptance),
  },
  {
    gate: "prop-purpose",
    file: "objects.json",
    op: "scene.get_bounds (player + props) + component listing (hasCollider, scripts)",
    sections: ["props", "placement"],
    run: (data, acceptance) =>
      evaluatePropPurpose(data as PropPurposeInput, acceptance),
  },
  {
    gate: "playability",
    file: "playability.json",
    op: "runtime.probe + runtime.assert_condition (assembled)",
    sections: ["win"],
    run: (data, acceptance) =>
      evaluatePlayability(data as PlayabilityResults, acceptance),
  },
  {
    gate: "feel",
    file: "feel.json",
    op: "FeelHarness + runtime.probe recipes (assembled)",
    sections: ["feel"],
    run: (data, acceptance) => evaluateFeel(data as FeelMeasurements, acceptance),
  },
  {
    gate: "feel-provenance",
    file: "feel.json",
    op: "FeelHarness + runtime.probe measurement provenance",
    sections: ["feel"],
    run: (data, acceptance) => evaluateFeelProvenance(data as FeelMeasurements, acceptance),
  },
  {
    gate: "physics-timestep",
    file: "feel.json",
    op: "FeelHarness + runtime.probe timestep provenance",
    sections: ["physics"],
    run: (data, acceptance) => evaluatePhysicsTimestep(data as FeelMeasurements, acceptance),
  },
  {
    gate: "feel-rederive",
    file: "feel.json",
    op: "raw trajectory re-derivation (S5c)",
    // Grades the feel capture's own internal consistency (headline vs raw trajectory),
    // so it binds NO contract section: it can never stand in for the `feel` gate's
    // coverage of the declared bands.
    sections: [],
    run: (data, acceptance) => evaluateFeelRederive(data as FeelMeasurements, acceptance),
  },
  {
    gate: "console-clean",
    file: "console.json",
    op: "unity_editor_console_logs",
    // The console is graded against an allowlist the gate owns, not against a contract
    // section: a clean console covers nothing the contract declares.
    sections: [],
    run: (data, acceptance) =>
      evaluateConsoleClean(data as ConsoleLogsResult, acceptance),
  },
];

/**
 * The authoritative set of gate ids this verifier can actually grade — every
 * `GATE_SPECS` gate PLUS `frame-integrity` (VLM-derived, evaluated in the VLM
 * branch of `runGates`, not in `GATE_SPECS`). The single source of truth: a
 * slice's `acceptance.gates` must be a subset of this, else `verify --slice`
 * would silently grade NOTHING (an unknown id selects no real gate → every gate
 * `not_applicable` → `worstStatus` is `not_applicable` → exit 0). Validated at
 * rest in `assertValidSlicePlan` and refused at the grading seam in
 * `runVerifySlice` so a typo can never produce a false-green per-slice verdict.
 */
/**
 * Opt-in SFX gate ids (SFX-dogfood backlog High #7). NOT in `GATE_SPECS` — they run
 * only through `runSfxGates` when the contract sets `verification.sfx.enabled: true`
 * (no bridge capture-producer exists yet). Included in `SUPPORTED_GATE_IDS` so a
 * slice/contract may address them without tripping the unknown-gate false-green guard.
 */
export const SFX_GATE_NAMES = [
  "sfx-presence",
  "sfx-runtime",
  "inputToSfxLatency",
  "sfx-fatigue",
] as const;

export const SUPPORTED_GATE_IDS: ReadonlySet<string> = new Set<string>([
  ...GATE_SPECS.map((s) => s.gate),
  "asset-source-fidelity",
  "frame-integrity",
  ...SFX_GATE_NAMES,
]);

/**
 * Capture input files required by a set of deterministic gate ids. This is the
 * verifier-owned gate→file map exported for slice-build proof minting; callers
 * must not duplicate GATE_SPECS. VLM-derived gates such as `frame-integrity` do
 * not have captured-op JSON files in GATE_SPECS, so they contribute no file.
 */
export function gateInputFiles(gateIds: Iterable<string>): string[] {
  const requested = new Set(gateIds);
  const out: string[] = [];
  for (const spec of GATE_SPECS) {
    if (requested.has(spec.gate) && !out.includes(spec.file)) out.push(spec.file);
  }
  return out;
}

/**
 * The staged project document `verify` copies into the inputs dir for the
 * asset-source gate. Not a GATE_SPECS file (it is not an op capture), so
 * `gateInputFiles` cannot know about it, but it IS read at grade time and therefore
 * belongs in the evidence ledger when that gate is selected.
 */
export const ASSET_MANIFEST_INPUT_FILE = "asset-manifest.json";

/**
 * Every file a gate set READS from the inputs dir: the op captures plus the staged
 * asset manifest when the asset-source gate is selected. This is the set
 * `verify --slice` mints evidence shas over (H3), so "graded input file" has ONE
 * definition rather than one per caller.
 */
export function sliceEvidenceFiles(gateIds: Iterable<string>): string[] {
  const requested = new Set(gateIds);
  const files = gateInputFiles(requested);
  if (requested.has("asset-source-fidelity")) files.push(ASSET_MANIFEST_INPUT_FILE);
  return files;
}

/**
 * Which contract sections each SUPPORTED gate walks (H1). GATE_SPECS declare their own
 * on the registry entry; the gates that live outside GATE_SPECS are declared here, in
 * the same module, so the answer is never spread across the codebase.
 *
 * `asset-source-fidelity` and `frame-integrity` walk NO contract section: the first
 * grades `ASSET_MANIFEST.json` (a separate document), the second hashes VLM frames.
 * The SFX gates walk `audio`: they are the only gates that do, which is exactly why
 * an `audio.cues` block with the SFX gates disabled is an uncovered section.
 */
const NON_SPEC_GATE_SECTIONS: Readonly<Record<string, readonly ContractSectionName[]>> = {
  "asset-source-fidelity": [],
  "frame-integrity": [],
  "sfx-presence": ["audio"],
  "sfx-runtime": ["audio"],
  inputToSfxLatency: ["audio"],
  "sfx-fatigue": ["audio"],
};

/**
 * The declared section list for one gate id, or `undefined` when the id is not a
 * supported gate. Exported so the repo guard can walk `SUPPORTED_GATE_IDS` and fail on
 * any gate that declares nothing (LITMUS: unregister one and the guard reds).
 */
export function contractSectionsForGate(gate: string): readonly ContractSectionName[] | undefined {
  const spec = GATE_SPECS.find((s) => s.gate === gate);
  if (spec) return spec.sections;
  return NON_SPEC_GATE_SECTIONS[gate];
}

/** The union of contract sections a set of gate ids walks. Unknown ids contribute nothing. */
export function contractSectionsForGates(gateIds: Iterable<string>): ContractSectionName[] {
  const covered = new Set<ContractSectionName>();
  for (const gate of gateIds) {
    for (const section of contractSectionsForGate(gate) ?? []) covered.add(section);
  }
  return CONTRACT_SECTIONS.filter((s) => covered.has(s));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyArray(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

function nonEmptyRecord(value: unknown): boolean {
  return isRecord(value) && Object.keys(value).length > 0;
}

/** One contract section that declares content a gate is supposed to walk. */
export interface RequiredContentSection {
  section: ContractSectionName;
  /** What the contract declares there, in the words the refusal prints. */
  declares: string;
}

/**
 * Which contract sections DECLARE REQUIRED CONTENT for this contract.
 *
 * "Required content" is content a gate could walk: a non-empty element/cue/entry list,
 * or a declared block. An ABSENT or EMPTY section declares nothing, so it is not in the
 * answer: the refusal must fire on a contract that asks for something and never gets it
 * checked, not on every optional block a genre does not use.
 *
 * The predicate reads the contract as loose JSON on purpose. It runs against documents
 * on disk, and a section validation missed is not a reason to skip the coverage
 * question.
 */
export function requiredContentSections(acceptance: unknown): RequiredContentSection[] {
  const c = isRecord(acceptance) ? acceptance : {};
  const out: RequiredContentSection[] = [];
  const add = (section: ContractSectionName, when: boolean, declares: string): void => {
    if (when) out.push({ section, declares });
  };

  const fonts = isRecord(c.fonts) ? c.fonts : {};
  add(
    "fonts",
    isRecord(fonts.global) || nonEmptyRecord(fonts.byRole) || nonEmptyArray(fonts.forbidden),
    "required font families",
  );
  add("palette", nonEmptyArray((isRecord(c.palette) ? c.palette : {}).entries), "palette entries");
  const hudElements = (isRecord(c.hud) ? c.hud : {}).elements;
  add("hud", nonEmptyArray(hudElements), `${Array.isArray(hudElements) ? hudElements.length : 0} HUD element(s)`);
  add("framing", nonEmptyRecord(c.framing), "camera framing");
  add("physics", nonEmptyRecord(c.physics), "project physics settings");
  add("feel", nonEmptyRecord(c.feel), "feel targets");
  add("juice", nonEmptyRecord(c.juice), "juice/parallax layers");
  const cues = (isRecord(c.audio) ? c.audio : {}).cues;
  add("audio", nonEmptyArray(cues), `${Array.isArray(cues) ? cues.length : 0} audio cue(s)`);
  const elements = (isRecord(c.manifest) ? c.manifest : {}).elements;
  add(
    "manifest",
    nonEmptyArray(elements),
    `${Array.isArray(elements) ? elements.length : 0} required scene element(s)`,
  );
  add("win", nonEmptyRecord(c.win), "the win rule");
  add("props", nonEmptyRecord((isRecord(c.props) ? c.props : {}).purposes), "prop purposes");
  add("placement", nonEmptyRecord(c.placement), "placement tolerances");
  add("platformer", nonEmptyRecord(c.platformer), "platformer/tile policy");
  add("reachability", nonEmptyRecord(c.reachability), "reachability envelope");
  add("render", nonEmptyRecord(c.render), "render-frame policy");
  return out;
}

/**
 * H1/L108: every contract section that declares required content must be walked by at
 * least ONE gate in the union of the plan's gate lists.
 *
 * Returns one refusal per uncovered section, naming the section, what it declares, and
 * every gate that WOULD cover it, so the fix ("add `manifest` to a slice's
 * acceptance.gates, or empty the section with human consent") is in the message rather
 * than in someone's head.
 */
export function contractCoverageRefusals(args: {
  acceptance: unknown;
  gates: Iterable<string>;
}): string[] {
  const covered = new Set(contractSectionsForGates(args.gates));
  const refusals: string[] = [];
  for (const required of requiredContentSections(args.acceptance)) {
    if (covered.has(required.section)) continue;
    const candidates = [...SUPPORTED_GATE_IDS].filter((gate) =>
      (contractSectionsForGate(gate) ?? []).includes(required.section),
    );
    refusals.push(
      `contract section \`${required.section}\` declares ${required.declares} and NO gate in the plan walks it ` +
        `(gates that would: ${candidates.length > 0 ? candidates.join(", ") : "none exist"}). ` +
        "A contract requirement nothing grades is a declared path nothing walks: add a covering gate to a " +
        "slice's acceptance.gates, or amend the contract with explicit human consent.",
    );
  }
  return refusals;
}

// ─────────────────────────────────────────────────────────────────────────────
// VLM advisory review (separate from the Tier-1 verdict)
// ─────────────────────────────────────────────────────────────────────────────

/** One advisory review criterion (see `vlm-review.schema.json`). */
export interface ReviewCriterion {
  id: string;
  status: "pass" | "warn" | "fail";
  reason: string;
  evidenceFrame?: string;
}

/** The advisory review-findings block, merged under `reviewFindings`. */
export interface ReviewFindings {
  /**
   * What the review compared against (plan §P0.1). `loombridge doneness` requires
   * `reference.heroShotSha256` to equal the verdict's `designTarget.pngSha256`
   * before it certifies a design-targeted build — proof the review judged the
   * hero-shot IMAGE, not contract attributes.
   */
  reference?: { heroShot?: string; heroShotSha256?: string };
  /**
   * Independence attestation (plan §P0.3): `doneness` refuses a design-targeted
   * build unless `independent` is true and `reviewerCount` >= 2.
   */
  independence?: { independent?: boolean; reviewerCount?: number };
  frames?: Array<{ id: string; path: string }>;
  criteria: ReviewCriterion[];
  summary?: string;
}

/** The CLI output: the Tier-1 verdict + (optionally) the advisory review block. */
export interface VerifyReport extends BuildVerdict {
  /** ADVISORY Tier-2 VLM review, reported SEPARATELY from the Tier-1 `status`. */
  reviewFindings?: ReviewFindings;
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────

interface CliArgs {
  acceptancePath: string;
  inputsDir: string;
  outputPath: string;
  vlmPath?: string;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function printUsage(): void {
  console.log(
    [
      "Usage: node dist/capabilities/verification/run-gates.js \\",
      "  --acceptance <acceptance.json> \\",
      "  --inputs <dir of captured op-output JSON> \\",
      "  [--output <build-verdict.json>] \\",
      "  [--vlm <vlm-review.json>]",
      "",
      "Expected capture filenames in --inputs (missing -> WARN, not crash):",
      ...GATE_SPECS.map((g) => `  ${g.file.padEnd(20)} -> ${g.gate}`),
    ].join("\n"),
  );
}

function parseArgs(argv: string[]): CliArgs {
  let acceptancePath = "";
  let inputsDir = "";
  let outputPath = "";
  let vlmPath: string | undefined;

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--acceptance") {
      acceptancePath = argv[i + 1] ?? "";
      i += 1;
    } else if (arg === "--inputs") {
      inputsDir = argv[i + 1] ?? "";
      i += 1;
    } else if (arg === "--output") {
      outputPath = argv[i + 1] ?? "";
      i += 1;
    } else if (arg === "--vlm") {
      vlmPath = argv[i + 1] ?? "";
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }
  }

  if (!acceptancePath) throw new Error("Missing required --acceptance <path>.");
  if (!inputsDir) throw new Error("Missing required --inputs <dir>.");

  // Default the verdict next to the inputs.
  const resolvedInputs = resolve(process.cwd(), inputsDir);
  return {
    acceptancePath: resolve(process.cwd(), acceptancePath),
    inputsDir: resolvedInputs,
    outputPath: outputPath
      ? resolve(process.cwd(), outputPath)
      : resolve(resolvedInputs, "build-verdict.json"),
    vlmPath: vlmPath ? resolve(process.cwd(), vlmPath) : undefined,
  };
}

async function readJson(filePath: string): Promise<unknown> {
  const raw = await fs.readFile(filePath, "utf-8");
  return JSON.parse(raw) as unknown;
}

/** Try to read+parse a capture file; null if it does not exist. */
async function tryReadJson(filePath: string): Promise<unknown | null> {
  try {
    return await readJson(filePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    throw error; // a present-but-malformed capture is a real error.
  }
}

/**
 * sha256 hex of a file's bytes; null on ANY error (ENOENT, EISDIR, perms, …).
 * A null hash drives the frame-integrity gate to a per-frame WARN, never a crash.
 */
async function hashFile(absPath: string): Promise<string | null> {
  try {
    const bytes = await fs.readFile(absPath);
    return createHash("sha256").update(bytes).digest("hex");
  } catch {
    return null;
  }
}

/** A degraded gate report when its capture file is absent — WARN, never crash. */
function degradedGateReport(spec: GateSpec): GateReport {
  return makeGateReport(spec.gate, [
    {
      id: `${spec.gate}.input`,
      expected: `captured op output at "${spec.file}"`,
      actual: "(missing)",
      status: "warn",
      detail: `No "${spec.file}" in --inputs; run ${spec.op} and save its output there. Gate not evaluated.`,
    },
  ]);
}

function isGateApplicable(acceptance: AcceptanceContract, gate: string): boolean {
  return acceptance.verification?.gates?.[gate] !== "not_applicable";
}

/**
 * Phase-scoped verification (the stage-fixture harness). A staged build is not
 * finished, so the full gate set would wrongly red a mid-build checkpoint (e.g.
 * no playable win after only `construct`). `--stage` restricts the gates to those
 * a stage can satisfy; out-of-stage gates report `not_applicable` so the verdict
 * reflects ONLY the in-stage gates (worstStatus ignores not_applicable). `verify`
 * (or no stage) is the full run that the §3a supervisor certifies.
 */
export const VERIFY_STAGES = ["construct", "level", "polish", "verify"] as const;
export type VerifyStage = (typeof VERIFY_STAGES)[number];

const STAGE_GATES: Record<Exclude<VerifyStage, "verify">, ReadonlySet<string>> = {
  // Scene objects exist (player/tiles/fruit/hazards/goal/managers + HUD), clean console.
  construct: new Set(["manifest", "ui-conformance", "console-clean"]),
  // Layout is reachable + framed; objects sit on surfaces.
  level: new Set(["manifest", "placement", "platform-tiles", "tile-render", "reachability", "framing", "console-clean"]),
  // Visual presentation: full-frame coverage, purposeful props, no render artifacts.
  polish: new Set(["coverage", "parallax-motion", "prop-purpose", "render-frame", "visual-artifacts", "framing", "console-clean"]),
};

/** A gate runs in a stage when no stage is set, the stage is the full `verify`, or it is in the stage's set. */
export function isGateInStage(stage: VerifyStage | undefined, gate: string): boolean {
  if (!stage || stage === "verify") return true;
  return STAGE_GATES[stage].has(gate);
}

/**
 * Slice-scoped gate selection (S2a, plan §'Slice scoping vs --stage'): an
 * EXPLICIT set of gate ids drawn from the slice's `acceptance.gates`. When no
 * set is supplied every gate is selected (the legacy whole-game run); when a set
 * is supplied a gate NOT in it is excluded (reported `not_applicable`, like an
 * out-of-stage gate). `--slice` and `--stage` are mutually exclusive at the CLI,
 * so `selectGates` and `stage` never both restrict the same run.
 */
export function isGateSelected(selectGates: ReadonlySet<string> | undefined, gate: string): boolean {
  return selectGates === undefined || selectGates.has(gate);
}

function unselectedGateReport(gate: string): GateReport {
  return makeGateReport(gate, [
    {
      id: `${gate}.slice`,
      expected: "gate is in the slice's acceptance.gates",
      actual: "out_of_scope",
      status: "not_applicable",
      detail: `Gate "${gate}" is not in this slice's acceptance.gates; it is only graded by a slice that requests it (or the full \`verify\`).`,
    },
  ]);
}

function outOfStageReport(gate: string, stage: VerifyStage): GateReport {
  return makeGateReport(gate, [
    {
      id: `${gate}.stage`,
      expected: `gate runs in stage "${stage}"`,
      actual: "out_of_scope",
      status: "not_applicable",
      detail: `Gate "${gate}" is out of scope for stage "${stage}"; run the full \`verify\` (no --stage) to include it.`,
    },
  ]);
}

function notApplicableGateReport(spec: Pick<GateSpec, "gate">, acceptance: AcceptanceContract): GateReport {
  return makeGateReport(spec.gate, [
    {
      id: `${spec.gate}.applicability`,
      expected: "gate applies to this game's acceptance contract",
      actual: "not_applicable",
      status: "not_applicable",
      detail: `Gate "${spec.gate}" is marked not_applicable for ${acceptance.game}; it was deliberately skipped.`,
    },
  ]);
}

function degradedAssetSourceFidelityReport(): GateReport {
  return makeGateReport("asset-source-fidelity", [
    {
      // `<gate>.input` (NOT the evaluator's own `asset-source.*` id namespace) so this
      // degraded report carries the same capture-absent marker every other one does:
      // `gradedGates` below recovers per-gate graded-ness from the flat check list and
      // must not have to special-case one gate's spelling.
      id: "asset-source-fidelity.input",
      expected: `${ASSET_MANIFEST_INPUT_FILE} staged in verification inputs`,
      actual: "(missing)",
      status: "warn",
      detail: `No ${ASSET_MANIFEST_INPUT_FILE} in --inputs; asset-source fidelity was requested but could not be evaluated.`,
    },
  ]);
}

/**
 * The `actual` a report writes when the input a gate needed was ABSENT. Every
 * "this gate did not grade" report in this module writes it: `degradedGateReport`,
 * `degradedAssetSourceFidelityReport`, the SFX missing-capture report, and the SFX
 * blocked-cue-map report.
 */
const CAPTURE_ABSENT_ACTUAL = "(missing)";

/** The exact check ids those reports use, per gate (`<gate>.input`, `<gate>.cue-map`). */
function captureAbsentCheckIds(gate: string): string[] {
  return [`${gate}.input`, `${gate}.cue-map`];
}

/**
 * The marker a gate carries when its input was a STAGED PROJECT DOCUMENT rather than a
 * capture of what the build actually did (H2).
 *
 * `asset-manifest.json` is the only input `verify` puts in the inputs dir itself, by
 * copying `.loombridge/ASSET_MANIFEST.json` there. That copy is the BARE manifest: a
 * declaration of what the project intends, with no `observedAssets` and therefore no
 * observation of the game at all. A capture run instead writes the WRAPPED shape
 * (`{ manifest, observedAssets }`), which is the form that says what was really used.
 *
 * Without this distinction the bare copy could carry a whole run: hand-write a bare
 * `asset-manifest.json` into an otherwise EMPTY inputs dir under an `art: deferred`
 * contract, and the gate passes on the document alone, so `gradedGates` is non-empty,
 * the nothing-graded refusal never fires, and STATE flips to a quotable `verified-*`
 * with zero captures on disk. The gate still RUNS and its verdict still counts toward
 * Tier-1 status (a declaration that contradicts itself is still a defect); what it must
 * not do is stand in as the evidence that this run measured the game.
 */
const STAGED_DOCUMENT_ACTUAL = "(staged project document, not a capture)";

/** The check id that marker uses, per gate. */
function stagedDocumentCheckIds(gate: string): string[] {
  return [`${gate}.staged-document`];
}

/** The marker check appended to a gate graded from a staged project document. */
function stagedDocumentCheck(gate: string): GateCheck {
  return {
    id: `${gate}.staged-document`,
    expected: "captured evidence of what the build used (observedAssets)",
    actual: STAGED_DOCUMENT_ACTUAL,
    // `not_applicable` so the marker cannot move the gate's own verdict: it records
    // WHAT the gate read, it does not grade it.
    status: "not_applicable",
    detail:
      "This gate read the staged .loombridge/ASSET_MANIFEST.json (the project's declaration), not a " +
      "captured observation of the build. The verdict stands, but this gate is NOT evidence that this " +
      "run measured the game; capture asset usage into --inputs to make it count.",
  };
}

/** Append the staged-document marker to a gate report without changing its verdict. */
function withStagedDocumentMarker(report: GateReport): GateReport {
  return makeGateReport(report.gate, [...report.checks, stagedDocumentCheck(report.gate)]);
}

/**
 * Which gates in an ASSEMBLED verdict actually GRADED: an evaluator consumed a
 * real captured input and said something about the game.
 *
 * Derived from the verdict's OWN gates + checks, which is the only truth that
 * cannot disagree with the verdict itself. Directory listings are NOT usable as a
 * proxy: a gate can be `not_applicable` by contract while its file exists, several
 * gates share one file (`feel.json` feeds four), and `asset-manifest.json` is
 * staged into the inputs dir by `verify` itself, so "the inputs dir has files" and
 * "a gate graded" are different questions.
 *
 * A gate did NOT grade when it is `not_applicable` (out of stage, unselected by a
 * slice, or declared N/A by the contract), when it carries the capture-absent
 * marker, or when it carries the STAGED-DOCUMENT marker (its input was a project
 * document `verify` staged itself, never an observation of the build). Everything
 * else ran a real evaluator over real captured evidence, whatever its verdict.
 *
 * `runVerify` refuses a run where this comes back empty: a verdict that graded
 * nothing is not a pass (RFC UnifiedVerify: "a verify that checked nothing must
 * never exit 0"). Pure + exported so that rule is unit-tested without fixtures: it
 * reads the assembled report and nothing else, so it cannot disagree with the
 * verdict it is judging.
 */
export function gradedGates(verdict: Pick<BuildVerdict, "gates" | "checks">): string[] {
  const graded: string[] = [];
  for (const [gate, status] of Object.entries(verdict.gates)) {
    if (status === "not_applicable") continue;
    const absentIds = captureAbsentCheckIds(gate);
    const captureAbsent = verdict.checks.some(
      (c) => absentIds.includes(c.id) && c.actual === CAPTURE_ABSENT_ACTUAL,
    );
    if (captureAbsent) continue;
    const stagedIds = stagedDocumentCheckIds(gate);
    const stagedDocument = verdict.checks.some(
      (c) => stagedIds.includes(c.id) && c.actual === STAGED_DOCUMENT_ACTUAL,
    );
    if (!stagedDocument) graded.push(gate);
  }
  return graded;
}

/** Capture filename each SFX gate consumes (the bridge-side spec; see capture-shapes.ts). */
const SFX_GATE_FILES: Record<(typeof SFX_GATE_NAMES)[number], string> = {
  "sfx-presence": "sfx-bindings.json",
  "sfx-runtime": "sfx-probe.json",
  inputToSfxLatency: "sfx-latency.json",
  "sfx-fatigue": "sfx-sequence.json",
};

/**
 * Run one SFX gate against its capture; a MISSING capture is a degraded WARN (blocked),
 * never a pass. `probeRaw` is the once-read `sfx-probe.json` (or null when absent):
 * `inputToSfxLatency` and `sfx-fatigue` cross-read it for fabrication / hollow-capture
 * detection (review D2/D4) — a missing probe never blocks them, it just removes the
 * corroboration.
 *
 * EXCEPTION ISOLATION (review D3): the evaluator body is wrapped so no single gate
 * exception can abort the whole verify run with no verdict — an unexpected throw
 * becomes that gate's own FAIL report and the other gates still grade.
 */
async function runOneSfxGate(
  gate: (typeof SFX_GATE_NAMES)[number],
  cueMap: CueMapSchema,
  sfx: SfxVerificationSection,
  inputsDir: string,
  probeRaw: unknown | null,
): Promise<GateReport> {
  const file = SFX_GATE_FILES[gate];
  let data: unknown;
  try {
    data = await tryReadJson(resolve(inputsDir, file));
  } catch (error) {
    // Present but unreadable/unparseable: that is THIS gate's FAIL (hollow ≥ missing),
    // never an exception that aborts the whole run (D3).
    return makeGateReport(gate, [
      {
        id: `${gate}.input`,
        expected: `parseable JSON capture at "${file}"`,
        actual: "(unparseable)",
        status: "fail",
        detail: `"${file}" exists but could not be parsed (${(error as Error).message}) — a present-but-unreadable capture is a defect, refused (never weaker than a missing one).`,
      },
    ]);
  }
  if (data === null) {
    return makeGateReport(gate, [
      {
        id: `${gate}.input`,
        expected: `captured SFX output at "${file}"`,
        actual: "(missing)",
        status: "warn",
        detail: `No "${file}" in --inputs; the SFX capture was not produced. Gate BLOCKED/incomplete, not passed.`,
      },
    ]);
  }
  try {
    switch (gate) {
      case "sfx-presence":
        return evaluateSfxPresence(data as SfxAssetBindingCapture, cueMap);
      case "sfx-runtime":
        return evaluateSfxRuntime(data, cueMap, sfx.scenarioExemptCues ?? []);
      case "inputToSfxLatency":
        return evaluateInputToSfxLatency(
          data as SfxLatencyCapture,
          cueMap,
          sfx.inputToSfxLatencyMs,
          probeRaw ?? undefined,
        );
      case "sfx-fatigue":
        return evaluateSfxFatigue(data as SfxSequenceCapture, cueMap, probeRaw ?? undefined);
    }
  } catch (error) {
    return makeGateReport(gate, [
      {
        id: `${gate}.error`,
        expected: "gate evaluates its capture without throwing",
        actual: "(exception)",
        status: "fail",
        detail: `Gate \`${gate}\` threw while evaluating "${file}": ${(error as Error).message} — reported as this gate's own FAIL so the other gates still grade (never aborts the run).`,
      },
    ]);
  }
}

/**
 * Opt-in SFX gate orchestration (SFX-dogfood backlog High #7). Returns [] unless the
 * contract sets `verification.sfx.enabled: true` — so a contract WITHOUT the SFX
 * section is byte-for-byte unchanged (zero behavior change). When enabled, the resolved
 * genre-pack cue map must be staged as `sfx-cue-map.json`; a missing cue map BLOCKS the
 * SFX gates (WARN — the gates cannot know which cues are required), and an INVALID cue
 * map FAILS them (a malformed pack artifact is a defect, never silently ignored). Each
 * gate then grades its own capture (missing capture → degraded WARN, per `runOneSfxGate`).
 * Stage/slice scoping is honored exactly like the deterministic gates.
 */
async function runSfxGates(args: {
  acceptance: AcceptanceContract;
  inputsDir: string;
  stage?: VerifyStage;
  selectGates?: ReadonlySet<string>;
}): Promise<GateReport[]> {
  const sfx = args.acceptance.verification?.sfx;
  if (!sfx?.enabled) return [];

  const cueMapRaw = await tryReadJson(resolve(args.inputsDir, "sfx-cue-map.json"));
  let cueMap: CueMapSchema | null = null;
  let cueMapIssue: { status: CheckStatus; actual: string; detail: string } | null = null;
  if (cueMapRaw === null) {
    cueMapIssue = {
      status: "warn",
      actual: "(missing)",
      detail:
        "No sfx-cue-map.json in --inputs; SFX gates are BLOCKED (they cannot know which cues are required). Stage the resolved genre-pack cue map.",
    };
  } else {
    const parsed = validateCueMapSchema(cueMapRaw);
    if (!parsed.ok || !parsed.schema) {
      cueMapIssue = {
        status: "fail",
        actual: "(invalid)",
        detail: `sfx-cue-map.json failed schema validation (refusing): ${parsed.refusals.join("; ")}`,
      };
    } else {
      cueMap = parsed.schema;
    }
  }

  // Read the probe capture ONCE for the cross-reads (D2 hollow-sequence / D4
  // fabrication). A missing OR unparseable probe just removes the corroboration —
  // it never blocks the latency/fatigue gates and never aborts the run.
  let probeRaw: unknown | null = null;
  try {
    probeRaw = await tryReadJson(resolve(args.inputsDir, SFX_GATE_FILES["sfx-runtime"]));
  } catch {
    probeRaw = null;
  }

  const reports: GateReport[] = [];
  for (const gate of SFX_GATE_NAMES) {
    if (!isGateInStage(args.stage, gate)) {
      reports.push(outOfStageReport(gate, args.stage!));
      continue;
    }
    if (!isGateSelected(args.selectGates, gate)) {
      reports.push(unselectedGateReport(gate));
      continue;
    }
    if (!isGateApplicable(args.acceptance, gate)) {
      reports.push(notApplicableGateReport({ gate }, args.acceptance));
      continue;
    }
    if (!cueMap) {
      reports.push(
        makeGateReport(gate, [
          {
            id: `${gate}.cue-map`,
            expected: "valid sfx-cue-map.json staged in --inputs",
            actual: cueMapIssue!.actual,
            status: cueMapIssue!.status,
            detail: cueMapIssue!.detail,
          },
        ]),
      );
      continue;
    }
    reports.push(await runOneSfxGate(gate, cueMap, sfx, args.inputsDir, probeRaw));
  }
  return reports;
}

/**
 * Build the full verify report from an acceptance contract + a directory of
 * captured op outputs (+ an optional advisory VLM findings file).
 *
 * Exported so unit tests can exercise the assembly path directly from fixtures.
 */
export async function runGates(args: {
  acceptance: AcceptanceContract;
  inputsDir: string;
  vlmPath?: string;
  /** Phase-scoped verification (default: full run, certifiable). */
  stage?: VerifyStage;
  /**
   * Slice-scoped verification (S2a): an explicit set of gate ids from the
   * slice's `acceptance.gates`. A gate NOT in the set is excluded
   * (`not_applicable`). Mutually exclusive with `stage` at the CLI.
   */
  selectGates?: ReadonlySet<string>;
}): Promise<VerifyReport> {
  const reports: GateReport[] = [];

  for (const spec of GATE_SPECS) {
    if (!isGateInStage(args.stage, spec.gate)) {
      reports.push(outOfStageReport(spec.gate, args.stage!));
      continue;
    }
    if (!isGateSelected(args.selectGates, spec.gate)) {
      reports.push(unselectedGateReport(spec.gate));
      continue;
    }
    if (!isGateApplicable(args.acceptance, spec.gate)) {
      reports.push(notApplicableGateReport(spec, args.acceptance));
      continue;
    }
    const filePath = resolve(args.inputsDir, spec.file);
    const data = await tryReadJson(filePath);
    if (data === null) {
      reports.push(degradedGateReport(spec));
      continue;
    }
    reports.push(spec.run(data, args.acceptance));
  }

  const assetSourceGate = "asset-source-fidelity";
  const assetSourceInScope = isGateInStage(args.stage, assetSourceGate) && isGateSelected(args.selectGates, assetSourceGate);
  const assetSourceExplicitlySelected = args.selectGates?.has(assetSourceGate) === true;
  const assetManifestInput = await tryReadJson(resolve(args.inputsDir, ASSET_MANIFEST_INPUT_FILE));
  // RCL-D02 review: artDeferred MUST come from the DISK-TRUTH acceptance contract, never from the
  // agent-staged asset-manifest.json input — otherwise an art:final build forges artDeferred:true in
  // the staged input to skip asset-source fidelity on unprovenanced primitiveFinal roles. Override any
  // input-supplied flag with the contract's declared art mode (the same disk-truth doneness reads).
  const assetArtDeferred = args.acceptance.art?.mode === "deferred";
  // WRAPPED (`{ manifest, observedAssets }`) is a capture of what the build used; BARE
  // (the manifest document itself) is the staged project declaration. Same discriminator
  // the gate's own `manifestCandidate` uses, so the two can never disagree about which
  // shape they are looking at.
  const assetSourceIsCapture =
    assetManifestInput !== null
    && typeof assetManifestInput === "object"
    && !Array.isArray(assetManifestInput)
    && "manifest" in (assetManifestInput as Record<string, unknown>);
  // Inject `artDeferred` at the WRAPPER level, never into the manifest document itself.
  // A bare staged document must first be normalized to the wrapped shape: spreading the
  // flag straight onto the bare document plants an unknown field INSIDE the manifest, and
  // schema validation then fails a perfectly valid manifest. That failure is a harness
  // artifact reported as a tier-1 game defect (exit 1, STATE verified-failing), observed
  // live during the S1 final test on a clean project. Harness fault is never a game defect.
  const assetSourceInput =
    assetManifestInput !== null && typeof assetManifestInput === "object" && !Array.isArray(assetManifestInput)
      ? {
          ...(assetSourceIsCapture
            ? (assetManifestInput as Record<string, unknown>)
            : { manifest: assetManifestInput }),
          artDeferred: assetArtDeferred,
        }
      : assetManifestInput;
  if (assetManifestInput !== null && assetSourceInScope) {
    const assetSourceReport = evaluateAssetSourceFidelity(assetSourceInput);
    reports.push(assetSourceIsCapture ? assetSourceReport : withStagedDocumentMarker(assetSourceReport));
  } else if (assetManifestInput !== null && !isGateInStage(args.stage, assetSourceGate)) {
    reports.push(outOfStageReport(assetSourceGate, args.stage!));
  } else if (assetManifestInput !== null && !isGateSelected(args.selectGates, assetSourceGate)) {
    reports.push(unselectedGateReport(assetSourceGate));
  } else if (assetManifestInput === null && assetSourceExplicitlySelected) {
    reports.push(degradedAssetSourceFidelityReport());
  }

  // Opt-in SFX gates (SFX-dogfood backlog High #7). Empty unless the contract sets
  // verification.sfx.enabled — a contract without the SFX section is unchanged.
  reports.push(
    ...(await runSfxGates({
      acceptance: args.acceptance,
      inputsDir: args.inputsDir,
      stage: args.stage,
      selectGates: args.selectGates,
    })),
  );

  // Read the VLM file ONCE: it feeds both the deterministic frame-integrity gate
  // (which CAN fail the Tier-1 verdict) and the advisory reviewFindings merge
  // (which never does). Only present when --vlm was supplied.
  let vlm: ReviewFindings | undefined;
  if (args.vlmPath) {
    vlm = (await readJson(args.vlmPath)) as ReviewFindings;

    // Frame-integrity is derived from the VLM frames (not GATE_SPECS), so it is
    // pushed into `reports` BEFORE aggregation: a byte-identical capture must be
    // able to drive the Tier-1 `status` to fail. Frame paths in the VLM file are
    // resolved relative to the VLM file's own directory.
    const vlmDir = dirname(args.vlmPath);
    const declared = vlm.frames ?? [];
    const frames = await Promise.all(
      declared.map(async (f) => {
        const absPath = isAbsolute(f.path) ? f.path : resolve(vlmDir, f.path);
        return { id: f.id, path: f.path, hash: await hashFile(absPath) };
      }),
    );
    if (!isGateInStage(args.stage, "frame-integrity")) {
      reports.push(outOfStageReport("frame-integrity", args.stage!));
    } else if (!isGateSelected(args.selectGates, "frame-integrity")) {
      reports.push(unselectedGateReport("frame-integrity"));
    } else if (isGateApplicable(args.acceptance, "frame-integrity")) {
      const frameIntegrityInput: FrameIntegrityInput = { frames };
      reports.push(evaluateFrameIntegrity(frameIntegrityInput, args.acceptance));
    } else {
      reports.push(notApplicableGateReport({ gate: "frame-integrity" }, args.acceptance));
    }
  }

  const verdict = aggregateVerdict(reports);
  const report: VerifyReport = { ...verdict };

  if (vlm) {
    // Advisory only — merged under a SEPARATE key, never folded into `status`.
    report.reviewFindings = vlm;
  }

  return report;
}

async function run(): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[run-gates] ${message}`);
    printUsage();
    return 2;
  }

  try {
    const acceptance = assertValidAcceptanceContract(await readJson(args.acceptancePath));
    const report = await runGates({
      acceptance,
      inputsDir: args.inputsDir,
      vlmPath: args.vlmPath,
    });

    await fs.mkdir(dirname(args.outputPath), { recursive: true });
    await fs.writeFile(args.outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf-8");

    const gateLine = Object.entries(report.gates)
      .map(([g, v]) => `${g}=${v}`)
      .join(" ");
    console.error(
      `[run-gates] status=${report.status} | ${gateLine} | output=${args.outputPath}`,
    );
    if (report.reviewFindings) {
      const adv = report.reviewFindings.criteria ?? [];
      const advFail = adv.filter((c) => c.status === "fail").length;
      const advWarn = adv.filter((c) => c.status === "warn").length;
      console.error(
        `[run-gates] reviewFindings (ADVISORY): ${adv.length} criteria, ${advFail} fail, ${advWarn} warn`,
      );
    }

    // Tier-1 `fail` ⇒ nonzero exit (the build gate). `warn` is not a hard fail.
    return report.status === "fail" ? 1 : 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[run-gates] fatal: ${message}`);
    return 1;
  }
}

const isMainModule =
  process.argv[1]?.endsWith("run-gates.js") || process.argv[1]?.endsWith("run-gates.ts");
if (isMainModule) {
  run().then((code) => {
    process.exitCode = code;
  });
}

export { run as runGatesCli, GATE_SPECS };
