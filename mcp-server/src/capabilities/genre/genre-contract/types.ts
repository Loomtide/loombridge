/**
 * Genre Contract — the plan-time artifact produced by the `genre-pack-authoring` elicitation
 * front-end. It is the 12-field, genre-agnostic build contract that turns a one-line game brief
 * into a fully-specified, measurable, vertical-first, closed-set-bound plan.
 *
 * This file is the FROZEN shared interface for the milestone. The validator, the skill, the A/B
 * rubric harness, and the genre-pack hint-cards all bind to the shapes here. Do not change a field
 * name or enum value without re-freezing across all four.
 *
 * Two-track discipline: the *shape* lives here; the *enforcement* (closed-set binding, refusal on
 * absent/aspirational claims) lives in `validator.ts`, mirroring `slices.ts` / genre-packs/platformer-2d.
 */

import type { EvidenceClassName } from "../../verification/gates/evidence-classes.js";

export const GENRE_CONTRACT_SCHEMA_VERSION = "0.1.0" as const;

/* ------------------------------------------------------------------ closed vocabularies */

/**
 * Genre class drives the validator's per-class completeness profile. Twitch genres must populate
 * feedback chains + measurable feel; systems genres may be mostly `judgment-only` and must instead
 * populate `humanOracleChecks`. Keyed by this CLOSED enum (three core-owned profiles), never per-pack.
 */
export const GENRE_CLASSES = ["twitch", "systems", "hybrid"] as const;
export type GenreClass = (typeof GENRE_CLASSES)[number];
export const GENRE_CLASS_SET: ReadonlySet<string> = new Set(GENRE_CLASSES);

/**
 * Per-target measurability tag — the honesty crux AND the substrate backlog.
 *
 * Validator binding rules (enforced in validator.ts):
 *  - `measurable-now`            → the target's metric MUST be in IMPLEMENTED_CALCULATOR_IDS
 *                                  (REDERIVABLE_METRIC_SET ∪ MEASURABLE_METRICS ∪ implemented sync
 *                                  metrics). NOT the banded vocabulary KNOWN_PROFILE_METRIC_IDS,
 *                                  which contains ids with no calculator (maxFallSpeed, hitStopMs, …).
 *  - `needs-new-calculator`      → a TS calculator does not exist yet; capture pattern transfers.
 *  - `needs-new-bridge-capability` → needs new C# bridge capability (e.g. vector/rotation sampling,
 *                                  aim/look injection), not just a TS calculator.
 *  - `judgment-only`             → no measurable proxy; requires a humanOracleChecks entry.
 *  - `engine-unsupported-today`  → outside Loombridge's substrate today (e.g. 3D / Fusion-replicated state).
 */
export const MEASURABILITY_TAGS = [
  "measurable-now",
  "needs-new-calculator",
  "needs-new-bridge-capability",
  "judgment-only",
  "engine-unsupported-today",
] as const;
export type MeasurabilityTag = (typeof MEASURABILITY_TAGS)[number];
export const MEASURABILITY_TAG_SET: ReadonlySet<string> = new Set(MEASURABILITY_TAGS);

/**
 * Provenance of a feel band. An `agent-guess` band on a coreVertical target is REFUSED unless paired
 * with an out-of-band operator sign-off (signoffArtifact + signoffSha256), not a self-authored flag.
 */
export const EVIDENCE_KINDS = ["reference-anchored", "pack-default", "agent-guess"] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];
export const EVIDENCE_KIND_SET: ReadonlySet<string> = new Set(EVIDENCE_KINDS);

/** Confidence ladder, mirroring the parent bootstrap plan's slice status terms. */
export const CONTRACT_CONFIDENCE = ["experimental", "candidate", "hardened"] as const;
export type ContractConfidence = (typeof CONTRACT_CONFIDENCE)[number];
export const CONTRACT_CONFIDENCE_SET: ReadonlySet<string> = new Set(CONTRACT_CONFIDENCE);

/** Which bucket a slice belongs to. Vertical-first: meta must not be smuggled into coreVertical. */
export const SLICE_BUCKETS = ["coreVertical", "deferredMeta"] as const;
export type SliceBucket = (typeof SLICE_BUCKETS)[number];

/* ------------------------------------------------------------------ out-of-band sign-off */

/**
 * Out-of-band operator sign-off, mirroring SliceProof.signoffArtifact/signoffSha256 in slices.ts.
 * Used to confirm an `agent-guess` band on a coreVertical target — NOT a self-authored inline boolean.
 * If present, both fields are required and validated (path safety + 64-hex sha256).
 */
export interface OperatorSignoff {
  /** durable, root-relative artifact path (validated by the same safe-path rule as slice proofs). */
  signoffArtifact: string;
  /** sha256 hex digest of the artifact (^[a-f0-9]{64}$). */
  signoffSha256: string;
  /** optional human note on what was confirmed. */
  note?: string;
}

/* ------------------------------------------------------------------ Group A — Context (fields 0–4) */

/** Field 0 — Target & platform. Input scheme lives here (authoritative), not in field 2. */
export interface TargetPlatform {
  device: string; // e.g. "pc" | "mobile" | "console" — open string; genre-pack/profile may constrain.
  inputScheme: string; // e.g. "kb-mouse" | "touch" | "gamepad"
  aspect?: string; // e.g. "16:9"
  session?: string; // session shape, e.g. "short-arena" | "campaign"
}

/** Field 1 — Network model. Photon Fusion is the default netcode for any multiplayer. */
export interface NetworkModel {
  mode: "single-player" | "co-op" | "pvp";
  netcode?: string; // e.g. "photon-fusion"; required when mode != single-player
  authority?: string; // e.g. "shared" | "host" | "server"
  tick?: string; // e.g. "fixed"
  prediction?: string; // posture note, e.g. "client-prediction + rollback"
  /** Fusion can run single-player/host mode → MP-capable architecture, SP-playable vertical. */
  spPlayable?: boolean;
}

/** Field 2 — Core loop + perspective + genreClass (the class drives validator completeness). */
export interface CoreLoop {
  description: string; // moment-to-moment loop
  perspective?: string; // e.g. "tps" | "fps" | "top-down" | "side-scroll"
  subGenre?: string; // disambiguated sub-genre
  genreClass: GenreClass; // AUTHORITATIVE value the validator binds against (hint-card only seeds it).
}

/** Field 3 — Art / asset direction. */
export interface ArtDirection {
  style: string;
  palette?: string;
  assetRoles?: string[]; // role-set (e.g. weapon, projectile, enemy, arena), NOT just theme
  theme?: string;
  /**
   * Design-target hero-shot mock reference. Whether this is the frozen pngSha256 Design Target
   * artifact is genre-dependent; for genres without a registered fidelity-criteria slot it is advisory.
   */
  heroShotMock?: string;
}

/** Field 4 — Vertical-slice budget. Enforces vertical-first by content counts, not just bucket presence. */
export interface VerticalSliceBudget {
  /** Minimal content counts for the core vertical (e.g. { weapon: 1, enemy: 1, arena: 1 }). */
  coreVerticalContent: Record<string, number>;
  /** What is explicitly pushed to deferredMeta (roster, progression, economy, matchmaking, …). */
  deferred: string[];
}

/* ------------------------------------------------------------------ Group B — Craft (fields 5–8) */

/** Field 5 — Input → response → feedback chain for one core verb. */
export interface FeedbackChain {
  verb: string; // e.g. "fire", "ads", "move", "take-damage"
  input: string;
  response: string;
  feedback: string;
}

/** Field 6 — A named, runtime-tunable feel parameter (no magic constants in gameplay code). */
export interface Tunable {
  id: string; // e.g. "fireIntervalMs"
  description?: string;
  unit?: string; // SHOULD be in SUPPORTED_PROFILE_UNIT_SET when set
}

/** A provisional feel target band (range or qualitative). */
export interface FeelBand {
  /** numeric band when measurable; omit for qualitative. */
  min?: number;
  max?: number;
  unit?: string;
  /** qualitative band when no numeric target is meaningful yet. */
  qualitative?: string;
}

/** Field 7 — Measurability map entry. The honesty crux + the substrate backlog, one row per target. */
export interface MeasurabilityEntry {
  /** the feel target this row is about (often a tunable id or a metric id). */
  target: string;
  tag: MeasurabilityTag;
  /**
   * For `measurable-now`: the implemented calculator id this binds to (validator checks membership in
   * IMPLEMENTED_CALCULATOR_IDS). For `needs-new-calculator`/`needs-new-bridge-capability`: a short note
   * naming what must be built.
   */
  calculator?: string;
  /**
   * The aspirational TARGET band (recorded, never gates an experimental-green verdict). A measured value
   * MAY fall outside it — that is surfaced, not failed, for a measure-only metric. (Was simply "band".)
   */
  band?: FeelBand;
  /**
   * The ENFORCED gate band. When present (numeric min/max), a passing metric-evidence row for this target
   * MUST carry a derived value WITHIN it — an out-of-band value is refused, not surfaced. A row with only a
   * `band` (no `gateBand`) is measure-only: recorded, never gates green. This is the targetBand/gateBand
   * split — it forbids "banded + measure-only + counts as green", and is the band promotion will enforce.
   */
  gateBand?: FeelBand;
  /** provenance of the band; required when `band` is present. */
  evidenceKind?: EvidenceKind;
  /** out-of-band confirmation, required to accept an `agent-guess` band on a coreVertical target. */
  signoff?: OperatorSignoff;
  /**
   * Which bucket the owning target lives in. REQUIRED — the agent-guess refusal and the genre-class
   * completeness rules key off this, so it must never be inferred or absent.
   */
  bucket: SliceBucket;
}

/** Field 8 — Reference anchor: real-data sources for setting bands instead of guessing. */
export interface ReferenceAnchor {
  clips?: string[]; // reference gameplay clip ids/paths
  exemplars?: string[]; // named exemplar games / sample projects (e.g. private shooter references, Fusion samples)
  /** 3D video→reference is research-tier; 3D bands fall back to exemplar/hand-set + judgment-only. */
  notes?: string;
}

/* ------------------------------------------------------------------ Group C — Build plan (fields 9–11) */

/**
 * A buildable slice in the DAG.
 *
 * Proof invariant (enforced by validator): a slice MUST declare at least one of `gates` or `gaps`
 * — BOTH are allowed (a slice can be partly proven by gates and partly an explicit gap). A slice
 * with neither is refused: every slice maps to a real proof and/or a named gap, never to nothing.
 */
export interface SliceNode {
  id: string;
  title: string;
  dependsOn: string[];
  /** confidence for THIS slice (experimental | candidate | hardened). REQUIRED. */
  confidence: ContractConfidence;
  /** gate ids in SUPPORTED_GATE_IDS that prove this slice. At least one of `gates`/`gaps` required. */
  gates?: string[];
  /** explicit gaps where no supported gate exists (kept out of `gates`, never silently satisfied). */
  gaps?: string[];
  /** optional content-kind tag, checked against the genre-class allowlist for the bucket. */
  kind?: string;
}

/** Field 9 — Slice DAG, split into the two vertical-first buckets. */
export interface SliceDag {
  coreVertical: SliceNode[];
  deferredMeta: SliceNode[];
}

/** Field 10 — A refusal / experimental condition: what is unverifiable and labeled honestly. */
export interface RefusalCondition {
  condition: string;
  reason: string;
}

/** Field 11 — A human-oracle check for a `judgment-only` target (load-bearing for systems genres). */
export interface HumanOracleCheck {
  check: string; // the question a human answers, e.g. "does aiming feel good?"
  appliesTo: string; // the target/aspect it judges
}

/* ------------------------------------------------------------------ optional — design-doc hardening */

/**
 * OPTIONAL anti-drift section (RCL §2 "Product Thesis Prevents Feature Drift").
 *
 * The single most useful dogfood guardrail was "this is a casual mobile greed run, NOT a mobile
 * Tarkov-like extraction sim" — one thesis that pre-empted drift into ammo/attachments/inventory
 * grids/long raids. Agents "improve" a prototype by adding familiar genre features, which for a
 * short-loop build makes it LESS playable. This section makes the guardrail machine-legible.
 *
 * BACKWARD-COMPAT CONTRACT: entirely OPTIONAL. A legacy contract that omits it validates unchanged
 * (byte-identical issues) — its absence is a WARN emitted by the plan/adopt advisory layer, never a
 * refusal. When PRESENT it is validated (non-empty statement + arrays of non-empty strings); a
 * present-but-malformed thesis IS refused.
 */
export interface ProductThesis {
  /** What this game IS, in one line (e.g. "a casual mobile greed run"). Non-empty. */
  statement: string;
  /** What this game is NOT — the anti-drift boundary (e.g. "mobile Tarkov extraction sim"). */
  notThisGame: string[];
  /** Features intentionally deferred until after v0 (e.g. "ammo", "attachments", "inventory grid"). */
  deferredFeatures: string[];
  /** Mechanics that would DAMAGE the target feel if added too early (e.g. "long raids", "reload friction"). */
  feelDamagingAdditions: string[];
}

/**
 * OPTIONAL scale model (RCL §5 "Scale Comes From Speed And Target Run") — the numeric inputs the
 * scale sanity checker (`design-hardening.ts`) consumes. the dogfood project's 40x40 arena at ~5 m/s collapsed
 * the intended 90-150s session (the player crossed the whole arena in ~8s, ~11-19 times per run), so
 * geometry must be tied to speed + target run, not chosen as "make the level bigger".
 *
 * BACKWARD-COMPAT CONTRACT: entirely OPTIONAL. Absent → the scale checker cannot run and the advisory
 * layer says so (honest limit), never a refusal. Present → validated (positive finite numbers); a
 * present-but-malformed scaleModel IS refused.
 */
export interface ScaleModel {
  /** Player traversal speed, metres per second. Must be > 0. */
  playerSpeedMps: number;
  /** Intended run/session duration, seconds (the dogfood project's target was 90-150s). Must be > 0. */
  targetRunSeconds: number;
  /** Arena/level width, metres (dogfood Map1 ≈ 40). Optional but needed for the crossing-ratio check. */
  arenaWidthM?: number;
  /** Arena/level height/depth, metres. Optional. */
  arenaHeightM?: number;
  /** Camera world width shown on screen, metres (dogfood local-combat camera ≈ 24-32). Optional. */
  cameraVisibleWidthM?: number;
  /** Expected time to the first loot pickup, seconds. Optional. */
  firstLootSeconds?: number;
}

/* ------------------------------------------------------------------ the contract */

export interface GenreContract {
  schemaVersion: typeof GENRE_CONTRACT_SCHEMA_VERSION;
  genreId: string; // e.g. "2d-shooter", "3d-fusion-shooter"
  subGenres?: string[];
  confidence: ContractConfidence;

  // Group A — Context
  targetPlatform: TargetPlatform; // 0
  networkModel: NetworkModel; // 1
  coreLoop: CoreLoop; // 2
  artDirection: ArtDirection; // 3
  verticalSliceBudget: VerticalSliceBudget; // 4

  // Group B — Craft
  feedbackChains: FeedbackChain[]; // 5
  tunables: Tunable[]; // 6
  measurabilityMap: MeasurabilityEntry[]; // 7
  referenceAnchor: ReferenceAnchor; // 8

  // Group C — Build plan
  sliceDag: SliceDag; // 9
  refusalConditions: RefusalCondition[]; // 10
  humanOracleChecks: HumanOracleCheck[]; // 11

  // Optional — design-doc hardening (RCL tranche-2). Absent on every legacy contract; validated only
  // when present. The plan/adopt advisory layer WARNs on absence, never refuses (see design-hardening.ts).
  productThesis?: ProductThesis; // anti-drift (§2)
  scaleModel?: ScaleModel; // scale sanity inputs (§5)

  /**
   * OPTIONAL anti-compression evidence expectation (RCL §6 / High #7). Each named class comes from the
   * fixed `EVIDENCE_CLASSES` enum shared with the acceptance side (single source of truth in
   * `verification/gates/evidence-classes.ts`) — a plan-time declaration of which distinct evidence
   * signals the build must gather, so "console clean" can never stand in for "playtest verified."
   *
   * BACKWARD-COMPAT CONTRACT: entirely OPTIONAL. A legacy contract that omits it validates unchanged
   * (byte-identical issues) and promotes to a byte-identical acceptance contract. When declared,
   * `loombridge plan` propagates it VERBATIM into the generated acceptance contract's
   * `verification.requiredEvidenceClasses` (where `loombridge doneness` enforces it). Present ⇒ validated
   * (an array of known evidence-class names); a present-but-malformed value IS refused.
   */
  requiredEvidenceClasses?: EvidenceClassName[];

  /**
   * OPTIONAL hero-shot fidelity criteria for an UNREGISTERED genre — the contract-side equivalent of a
   * registered pack's `fidelityCriteria` in `genre-registry.ts`. This is what lets a promoted genre
   * reach `doneness` with an APPROVED Design Target without ever borrowing another genre's criteria.
   *
   * Every id MUST be in `VLM_REVIEW_CRITERION_IDS` (`verification/gates/vlm-criteria.ts`) and the list
   * MUST be non-empty when present: an id outside that set can never appear in `vlm-review.json`, and
   * an empty set would make the structural fidelity check pass VACUOUSLY. Both are refused here AND
   * re-checked by doneness at gate time — the contract travels with the project, so authoring-time
   * validation is not a trust boundary.
   *
   * BACKWARD-COMPAT CONTRACT: entirely OPTIONAL. Absent ⇒ a legacy contract validates and promotes
   * byte-identically, and a build of that genre with an approved Design Target is REFUSED at doneness
   * (declare criteria here, or declare `art: { "mode": "deferred" }` in ACCEPTANCE.json) — never
   * silently graded against some other genre's criteria.
   */
  fidelityCriteria?: string[];
}

/* ------------------------------------------------------------------ validation result types */

export interface GenreContractIssue {
  code: string;
  message: string;
  path: string;
}

export interface GenreContractValidationResult {
  valid: boolean;
  issues: GenreContractIssue[];
}
