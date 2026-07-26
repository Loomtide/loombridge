/**
 * Design-doc hardening (RCL tranche-2) — advisory checks that turn the dogfood planning-review
 * learnings into machine-legible WARNS, never deterministic refusals.
 *
 * Motivating incidents (the internal Codex planning/tuning learnings ledger):
 *  §1 "Review The Design Doc Before Build" — adversarial review of the dogfood project's design doc BEFORE build
 *     caught expensive false starts: no acceptance protocol, a mobile target validated keyboard-only,
 *     sound treated as optional, unstated verification-evidence expectations.
 *  §2 "Product Thesis Prevents Feature Drift" — one thesis ("casual greed run, NOT mobile Tarkov")
 *     pre-empted drift into ammo/attachments/inventory grids/long raids.
 *  §5 "Scale Comes From Speed And Target Run" — a 40x40 arena at ~5 m/s collapsed a 90-150s run.
 *
 * TWO-TRACK DISCIPLINE. Everything here is JUDGMENT-ADJACENT and therefore ADVISORY: it emits
 * `{ code, message, path }` warnings the plan/adopt CLI prints, and NEVER changes an exit code or a
 * validation verdict. The refusal moat (`validateGenreContract`) is untouched — it refuses only a
 * PRESENT-but-malformed optional section; the mere ABSENCE of a thesis / scaleModel is a WARN here.
 *
 * Pure + side-effect-free: every function is a deterministic transform of its inputs, unit-testable
 * with hand-computed cases (the dogfood project's numbers are the calibration).
 */

import type { GenreContract, GenreContractIssue } from "./types.js";

/* ================================================================== scale sanity checker (§5) */

/**
 * The numeric inputs the scale checker needs. In a GenreContract these come from `scaleModel`; the
 * function itself is decoupled from the contract shape so it can be unit-tested directly and reused.
 */
export interface ScaleSanityInputs {
  /** Player traversal speed, metres/second (> 0). */
  playerSpeedMps: number;
  /** Intended run/session duration, seconds (> 0). */
  targetRunSeconds: number;
  /** Arena/level width, metres. Optional — needed for the crossing-ratio + camera-coverage checks. */
  arenaWidthM?: number;
  /**
   * Arena/level height/depth, metres. Optional — when present the crossing check runs on BOTH axes
   * (EITHER axis out of band is flagged, with the axis named). Absent on a rectangular-implied arena
   * → the check runs width-only and DISCLOSES that as a limit, never a silent skip.
   */
  arenaHeightM?: number;
  /** Camera world width shown on screen, metres. Optional — needed for the camera-coverage check. */
  cameraVisibleWidthM?: number;
  /** Expected time to the first loot pickup, seconds. Optional — needed for the first-loot checks. */
  firstLootSeconds?: number;
}

export interface ScaleSanityWarning {
  code: string;
  message: string;
}

export interface ScaleSanityResult {
  /** True when the inputs were sufficient to compute AND no warning fired. */
  ok: boolean;
  /** Derived quantities (only the ones the available inputs allowed computing). */
  computed: {
    timeToCrossWidthSec?: number;
    crossingsPerRun?: number;
    /** Height-axis crossing figures — computed only when arenaHeightM was supplied. */
    timeToCrossHeightSec?: number;
    crossingsPerRunHeight?: number;
    cameraCoverageFraction?: number;
  };
  warnings: ScaleSanityWarning[];
  /** Honest notes where a check could NOT run because an optional input was absent. */
  limits: string[];
}

/**
 * Plausible band for "how many times a player crosses the arena's width in one target run".
 *
 * CALIBRATION (dogfood collapse): 40 m arena / 5 m/s = 8 s to cross; a 90-150 s target run ⇒ 11.25 -
 * 18.75 crossings. That is far above the upper bound — the whole space is traversed a dozen-plus
 * times per run, so "far away" loot, route choice, and risk escalation cannot exist (exploration
 * collapses). Below the lower bound the arena is so large it is barely traversed once — a different
 * failure (dead space). The band is deliberately wide; it flags collapse, not fine tuning.
 */
export const MAX_PLAUSIBLE_CROSSINGS_PER_RUN = 8;
export const MIN_PLAUSIBLE_CROSSINGS_PER_RUN = 1.5;

/**
 * Compute scale sanity from speed + target run (+ optional arena / camera / first-loot). Pure: no
 * I/O, deterministic. Returns WARNINGS (advisory), never throws; degenerate/insufficient inputs
 * become `limits` notes, not crashes.
 */
export function checkScaleSanity(inputs: ScaleSanityInputs): ScaleSanityResult {
  const warnings: ScaleSanityWarning[] = [];
  const limits: string[] = [];
  const computed: ScaleSanityResult["computed"] = {};

  const speed = inputs.playerSpeedMps;
  const run = inputs.targetRunSeconds;
  const speedOk = Number.isFinite(speed) && speed > 0;
  const runOk = Number.isFinite(run) && run > 0;
  if (!speedOk || !runOk) {
    limits.push("scale check needs a positive playerSpeedMps and targetRunSeconds; skipped.");
    return { ok: false, computed, warnings, limits };
  }

  // ── arena-crossing ratio (per axis — EITHER axis out of band is flagged) ────
  const checkAxis = (dimM: number, axis: "width" | "height"): { timeToCrossSec: number; crossings: number } => {
    const timeToCrossSec = dimM / speed;
    const crossings = run / timeToCrossSec;
    if (crossings > MAX_PLAUSIBLE_CROSSINGS_PER_RUN) {
      warnings.push({
        code: "SCALE_ARENA_TOO_SMALL",
        message:
          `arena ${axis} ${round(dimM)}m at ${round(speed)} m/s is crossed in ${round(timeToCrossSec)}s — ` +
          `~${round(crossings)} full ${axis}-crossings in a ${round(run)}s run (plausible ≤ ${MAX_PLAUSIBLE_CROSSINGS_PER_RUN}). ` +
          `The space is traversed so many times per run that exploration / route-choice / risk-escalation collapse ` +
          `(the dogfood project's 40x40 @ 5 m/s vs a 90-150s run was exactly this failure). Scale from speed × target run, ` +
          `or split a shorter starter map from a longer route-test map.`,
      });
    } else if (crossings < MIN_PLAUSIBLE_CROSSINGS_PER_RUN) {
      warnings.push({
        code: "SCALE_ARENA_TOO_LARGE",
        message:
          `arena ${axis} ${round(dimM)}m at ${round(speed)} m/s takes ${round(timeToCrossSec)}s to cross — ` +
          `only ~${round(crossings)} ${axis}-crossings in a ${round(run)}s run (plausible ≥ ${MIN_PLAUSIBLE_CROSSINGS_PER_RUN}). ` +
          `The arena is barely traversed once per run: likely dead space with no reason to move.`,
      });
    }
    return { timeToCrossSec, crossings };
  };

  const width = inputs.arenaWidthM;
  const widthOk = Number.isFinite(width) && (width as number) > 0;
  const height = inputs.arenaHeightM;
  const heightOk = Number.isFinite(height) && (height as number) > 0;

  if (widthOk) {
    const w = checkAxis(width as number, "width");
    computed.timeToCrossWidthSec = w.timeToCrossSec;
    computed.crossingsPerRun = w.crossings;

    // ── camera coverage vs arena (width axis) ─────────────────────────────────
    const cam = inputs.cameraVisibleWidthM;
    if (Number.isFinite(cam) && (cam as number) > 0) {
      const cameraCoverageFraction = (cam as number) / (width as number);
      computed.cameraCoverageFraction = cameraCoverageFraction;
      if (cameraCoverageFraction >= 1) {
        warnings.push({
          code: "SCALE_CAMERA_SHOWS_WHOLE_ARENA",
          message:
            `camera shows ${round(cam as number)}m of a ${round(width as number)}m arena ` +
            `(${round(cameraCoverageFraction * 100)}% — the whole arena fits on one screen). ` +
            `A route-choice game needs a LOCAL-combat camera plus a full-arena minimap, not a camera that ` +
            `reveals everything at once (the dogfood project moved to a local camera + minimap for exactly this reason).`,
        });
      }
    } else {
      limits.push("camera-coverage check skipped — no cameraVisibleWidthM supplied.");
    }
  } else {
    limits.push("arena-crossing check skipped — no arenaWidthM supplied.");
  }

  if (heightOk) {
    const h = checkAxis(height as number, "height");
    computed.timeToCrossHeightSec = h.timeToCrossSec;
    computed.crossingsPerRunHeight = h.crossings;
  } else if (widthOk) {
    // Rectangular-implied arena with only one declared axis: disclose, don't silently narrow.
    limits.push("arenaHeightM not declared — the crossing check ran on the width axis only; the height axis was not checked.");
  }

  // ── first-loot timing ────────────────────────────────────────────────────────
  const firstLoot = inputs.firstLootSeconds;
  if (Number.isFinite(firstLoot) && (firstLoot as number) > 0) {
    if ((firstLoot as number) > run) {
      warnings.push({
        code: "SCALE_FIRST_LOOT_AFTER_RUN",
        message:
          `first loot expected at ${round(firstLoot as number)}s but the target run is only ${round(run)}s — ` +
          `the first reward lands after the run ends. First-pickup time must sit well inside the run.`,
      });
    } else if ((firstLoot as number) > run * 0.5) {
      warnings.push({
        code: "SCALE_FIRST_LOOT_LATE",
        message:
          `first loot expected at ${round(firstLoot as number)}s, past the midpoint of a ${round(run)}s run — ` +
          `the greed loop starts slowly; consider earlier first-pickup placement.`,
      });
    }
  } else if (firstLoot !== undefined) {
    limits.push("first-loot check skipped — firstLootSeconds was not a positive number.");
  }

  return { ok: warnings.length === 0, computed, warnings, limits };
}

/* ================================================================== design-doc coverage (§1) */

export type CoverageStatus = "present" | "partial" | "absent";

export interface CoverageItem {
  /** stable id. */
  id: "product-thesis" | "input-contract" | "feedback-sound" | "acceptance-protocol" | "verification-evidence";
  label: string;
  status: CoverageStatus;
  /** which contract field(s) the signal was read from (or an honest detectability limit). */
  where: string;
  /** incident-grounded rationale — why this item matters, esp. when absent/partial. */
  rationale: string;
}

export interface DesignDocCoverageReport {
  items: CoverageItem[];
  /** absent/partial items surfaced as advisory warnings (code/message/path). */
  warnings: GenreContractIssue[];
}

const MOBILE_DEVICE_RE = /mobile|phone|touch|handheld|ios|android|tablet/i;
/** keyboard/mouse/gamepad/arrow/d-pad/stylus tokens — a non-touch input scheme. */
const NON_TOUCH_INPUT_RE = /\b(kb|keyboard|wasd|arrows?|arrow-?keys|d-?pad|dpad|stylus|mouse|gamepad|controller)\b/i;
const TOUCH_INPUT_RE = /touch|tap|swipe|drag|virtual-?(stick|pad)|on-?screen/i;
const SOUND_RE = /\b(sfx|sound|audio|foley|sting|music|voice|vo)\b/i;

/** Disclosed on the input-contract item: the platform/input consistency check is a token match, not NLU. */
const INPUT_HEURISTIC_NOTE =
  " (Token-list heuristic: device/input strings are matched against known keyboard/mouse/gamepad/arrow/d-pad/stylus vs touch tokens; unrecognized wording may not be classified.)";

/**
 * Build the design-doc hardening coverage report for a (validated) GenreContract. Each checklist item
 * from RCL §1 is scored present/partial/absent from the STRUCTURED contract only — the prose design
 * docs in a bundle are NOT machine-parsed (brief-bundle resolves only the structured GenreContract, it
 * never synthesizes from prose), so items with no first-class contract field (acceptance protocol,
 * verification-evidence classes) are scored from PROXIES and say so in `where`. Honest detectability
 * over fabricated checks.
 */
export function buildDesignDocCoverageReport(contract: GenreContract): DesignDocCoverageReport {
  const items: CoverageItem[] = [];

  // (a) product thesis — fully detectable (first-class optional field).
  {
    const t = contract.productThesis;
    const present = !!t && typeof t.statement === "string" && t.statement.trim().length > 0;
    items.push({
      id: "product-thesis",
      label: "Product thesis / anti-drift boundary",
      status: present ? "present" : "absent",
      where: "genreContract.productThesis",
      rationale: present
        ? "an explicit 'this is / is-not' thesis is declared."
        : "no product thesis — agents drift toward familiar genre features, which makes a short-loop prototype LESS playable (the dogfood project's 'casual greed run, NOT mobile Tarkov' thesis pre-empted ammo/attachments/inventory-grid/long-raid drift).",
    });
  }

  // (b) input contract consistent with target platform — detectable; flags the exact dogfood class.
  {
    const tp = contract.targetPlatform;
    const device = typeof tp?.device === "string" ? tp.device : "";
    const input = typeof tp?.inputScheme === "string" ? tp.inputScheme : "";
    const hasBoth = device.trim().length > 0 && input.trim().length > 0;
    const mobile = MOBILE_DEVICE_RE.test(device) || MOBILE_DEVICE_RE.test(tp?.session ?? "");
    const nonTouch = NON_TOUCH_INPUT_RE.test(input);
    const touch = TOUCH_INPUT_RE.test(input);
    const contradiction = hasBoth && mobile && nonTouch && !touch;
    items.push({
      id: "input-contract",
      label: "Input contract consistent with target platform",
      status: !hasBoth ? "absent" : contradiction ? "partial" : "present",
      where: "genreContract.targetPlatform.{device,inputScheme,session}",
      rationale:
        (!hasBoth
          ? "device and/or inputScheme are missing — the build has no authoritative input posture."
          : contradiction
            ? `CONTRADICTION: a mobile/touch target ("${device}") declares a keyboard/mouse-style input scheme ("${input}") with no touch scheme. This is the exact dogfood false-start: a mobile game validated keyboard-only. Declare the touch/virtual-stick input the platform actually uses.`
            : `device "${device}" and input "${input}" are consistent.`) + INPUT_HEURISTIC_NOTE,
    });
  }

  // (c) feedback / sound treatment — detectable; sound must not be optional.
  {
    const chains = Array.isArray(contract.feedbackChains) ? contract.feedbackChains : [];
    const nonEmpty = chains.length > 0;
    const soundMentioned = chains.some((c) => typeof c?.feedback === "string" && SOUND_RE.test(c.feedback));
    items.push({
      id: "feedback-sound",
      label: "Feedback contract incl. sound treatment",
      status: !nonEmpty ? "absent" : soundMentioned ? "present" : "partial",
      where: "genreContract.feedbackChains[].feedback",
      rationale: !nonEmpty
        ? "no feedback chains — the input→response→feedback contract for the core verbs is unstated."
        : soundMentioned
          ? "feedback chains are declared and at least one names an audio/SFX cue."
          : "feedback chains are declared but NONE name sound/SFX — the dogfood project treated sound as optional even though shooting, damage, loot, and extraction depend on readable AUDIO feedback. Make sound a first-class feedback cue, not a deferred nicety.",
    });
  }

  // (d) playtest acceptance protocol — HONEST LIMIT: no dedicated field; proxied.
  {
    const map = Array.isArray(contract.measurabilityMap) ? contract.measurabilityMap : [];
    const hasGateBands = map.some(
      (m) => m?.gateBand && (typeof m.gateBand.min === "number" || typeof m.gateBand.max === "number"),
    );
    const hasOracle = Array.isArray(contract.humanOracleChecks) && contract.humanOracleChecks.length > 0;
    const proxies = (hasGateBands ? 1 : 0) + (hasOracle ? 1 : 0);
    items.push({
      id: "acceptance-protocol",
      label: "Playtest acceptance protocol (proxied)",
      status: proxies === 0 ? "absent" : proxies === 1 ? "partial" : "present",
      where:
        "PROXY (no dedicated acceptance-protocol field in GenreContract): measurabilityMap[].gateBand (enforced thresholds) + humanOracleChecks (human playtest judgment)",
      rationale:
        proxies === 2
          ? "enforced gate thresholds AND human-oracle checks are both declared — a reasonable acceptance-protocol proxy. (Loombridge has no first-class acceptance-protocol section; graded from proxies.)"
          : proxies === 1
            ? "only one acceptance proxy is present (either enforced gate thresholds OR human-oracle checks, not both). the dogfood project's review found NO concrete playtest acceptance protocol — declare both an enforced-metric gate and a human-judgment check."
            : "no acceptance-protocol signal: neither enforced gate bands nor human-oracle checks. An agent cannot tell when the build is done. (Detectability limit: GenreContract has no dedicated acceptance-protocol field.)",
    });
  }

  // (e) verification evidence expectations — now FIRST-CLASS when `requiredEvidenceClasses` is declared
  // (RCL §6); otherwise falls back to the per-slice gates/gaps PROXY (unchanged partial/absent semantics).
  {
    const declared = Array.isArray(contract.requiredEvidenceClasses) ? contract.requiredEvidenceClasses : [];
    if (declared.length > 0) {
      // First-class: the §6 evidence-class taxonomy is stated directly and (via plan) propagated into the
      // generated acceptance contract, where `loombridge doneness` enforces each class is `present`.
      items.push({
        id: "verification-evidence",
        label: "Verification evidence expectations (first-class)",
        status: "present",
        where: "requiredEvidenceClasses (first-class)",
        rationale:
          `verification.requiredEvidenceClasses declares ${declared.length} required evidence class(es) ` +
          `(${declared.join(", ")}) — a first-class §6 evidence-class taxonomy that plan propagates into the ` +
          `generated acceptance contract and doneness enforces, so "all green" (e.g. a clean console) can never ` +
          `stand in for a specific gathered signal.`,
      });
    } else {
      // FALLBACK proxy: no evidence classes declared → score from whether slices bind verification gates.
      const core = Array.isArray(contract.sliceDag?.coreVertical) ? contract.sliceDag.coreVertical : [];
      const withGates = core.filter((s) => Array.isArray(s?.gates) && s.gates.length > 0);
      items.push({
        id: "verification-evidence",
        label: "Verification evidence expectations (proxied)",
        status: core.length === 0 ? "absent" : withGates.length > 0 ? "present" : "partial",
        where: "PROXY (no requiredEvidenceClasses declared): sliceDag.coreVertical[].gates / gaps",
        rationale:
          core.length === 0
            ? "no core-vertical slices — nothing declares what evidence proves the build. Declare verification.requiredEvidenceClasses (the §6 evidence-class taxonomy) to make evidence expectations first-class."
            : withGates.length > 0
              ? `${withGates.length}/${core.length} core slices bind at least one verification gate. (Detectability limit: the §6 evidence CLASSES — screenshot/trace/telemetry/human-notes — are only PROXIED by gate/gap ids here; declare verification.requiredEvidenceClasses to state them first-class and have doneness enforce them.)`
              : "core slices exist but NONE bind a verification gate (all gaps-only). 'All green' cannot mean 'verified' when no slice declares positive evidence. Attach gates, not just named gaps — or declare verification.requiredEvidenceClasses to state the required evidence classes first-class.",
      });
    }
  }

  const warnings: GenreContractIssue[] = items
    .filter((it) => it.status !== "present")
    .map((it) => ({
      code: `COVERAGE_${it.id.replace(/-/g, "_").toUpperCase()}_${it.status === "absent" ? "ABSENT" : "PARTIAL"}`,
      message: `${it.label}: ${it.status.toUpperCase()} — ${it.rationale}`,
      path: it.where,
    }));

  return { items, warnings };
}

/* ================================================================== aggregate advisory (wiring) */

/** Everything the plan/adopt advisory layer needs, computed ONCE: coverage + warnings + honest limits. */
export interface DesignHardeningAdvisory {
  coverage: DesignDocCoverageReport;
  /** All advisory warnings (coverage absents/partials + scale warnings + SCALE_MODEL_ABSENT). */
  warnings: GenreContractIssue[];
  /**
   * Checks that could NOT run because an input was absent (from `checkScaleSanity.limits`). These are
   * "unverified", not "clean" — the renderer must NEVER print an all-clear while limits are non-empty.
   */
  limits: string[];
}

/**
 * Aggregate ALL design-doc hardening advisories for a contract — the single entry point the plan/adopt
 * layer consumes. Combines the coverage report (which already includes the product-thesis absence
 * nudge) with the scale sanity check, PROPAGATING the scale checker's honest `limits` (a partial
 * scaleModel skips sub-checks — that must surface as "unverified", never as an implicit all-clear).
 * Everything returned is advisory — the caller prints it and NEVER changes an exit code. Absence of
 * `scaleModel` is itself surfaced as a warning, not a silent skip.
 */
export function aggregateDesignHardening(contract: GenreContract): DesignHardeningAdvisory {
  const coverage = buildDesignDocCoverageReport(contract);
  const warnings: GenreContractIssue[] = [...coverage.warnings];
  const limits: string[] = [];

  const sm = contract.scaleModel;
  if (sm && typeof sm.playerSpeedMps === "number" && typeof sm.targetRunSeconds === "number") {
    const result = checkScaleSanity({
      playerSpeedMps: sm.playerSpeedMps,
      targetRunSeconds: sm.targetRunSeconds,
      arenaWidthM: sm.arenaWidthM,
      arenaHeightM: sm.arenaHeightM,
      cameraVisibleWidthM: sm.cameraVisibleWidthM,
      firstLootSeconds: sm.firstLootSeconds,
    });
    for (const w of result.warnings) {
      warnings.push({ code: w.code, message: w.message, path: "genreContract.scaleModel" });
    }
    limits.push(...result.limits.map((l) => `scale: ${l}`));
  } else {
    warnings.push({
      code: "SCALE_MODEL_ABSENT",
      message:
        "no scaleModel — cannot sanity-check arena scale against player speed + target run. the dogfood project's 40x40 @ 5 m/s vs a 90-150s intended run collapsed the session; declare scaleModel { playerSpeedMps, targetRunSeconds, arenaWidthM } to enable the check.",
      path: "genreContract.scaleModel",
    });
  }

  return { coverage, warnings, limits };
}

/**
 * Collect ALL design-doc hardening WARNINGS for a contract. Thin view over
 * `aggregateDesignHardening` — callers that also need the coverage report or the honest `limits`
 * (the advisory renderer does) must use the aggregate to avoid dropping the limits.
 */
export function collectDesignHardeningWarnings(contract: GenreContract): GenreContractIssue[] {
  return aggregateDesignHardening(contract).warnings;
}

/**
 * Format the advisory design-doc hardening report as human-readable lines (NO CLI prefix — the caller
 * prepends its own, e.g. "[loombridge plan]  "). Pure: deterministic transform, no I/O. Lines are the
 * coverage checklist, the UNVERIFIED (missing-inputs) limits, then the non-blocking warnings. The
 * all-clear line prints ONLY when there are no warnings AND no limits — a check that could not run is
 * unverified, not clean.
 */
export function formatDesignHardeningAdvisory(contract: GenreContract): string[] {
  const lines: string[] = [];
  const { coverage, warnings, limits } = aggregateDesignHardening(contract);
  const glyph: Record<CoverageStatus, string> = { present: "OK  ", partial: "WARN", absent: "MISS" };
  lines.push("design-doc hardening — coverage (RCL §1, advisory):");
  for (const it of coverage.items) {
    lines.push(`  [${glyph[it.status]}] ${it.label} — ${it.where}`);
  }
  if (limits.length > 0) {
    lines.push(`design-doc hardening: ${limits.length} check(s) unverified (missing inputs — not clean, not failed):`);
    for (const l of limits) {
      lines.push(`  LIMIT ${l}`);
    }
  }
  if (warnings.length === 0 && limits.length === 0) {
    lines.push("design-doc hardening: no advisories — thesis, input, feedback, acceptance, evidence + scale all present.");
    return lines;
  }
  if (warnings.length === 0) {
    lines.push("design-doc hardening: no advisory warnings, but the unverified check(s) above could not run.");
    return lines;
  }
  lines.push(`design-doc hardening: ${warnings.length} advisory warning(s) (non-blocking):`);
  for (const w of warnings) {
    lines.push(`  WARN ${w.code}: ${w.message}`);
  }
  return lines;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
