/**
 * `loombridge verify --profile <id>` — the verify-first entry (S5b).
 *
 * Runs standalone on an EXISTING Unity 2D platformer: no prior `plan`/`build`, no
 * `ACCEPTANCE.json`, no `SLICES.json`. It selects a product-owned feel profile
 * (S5a), compares any provided measurements against the profile's bands, and emits
 * a developer-facing report — WITHOUT mutating the project.
 *
 * Non-mutation by construction: this path never reads/requires the acceptance
 * contract or slice plan, never writes STATE.md, and never calls the Unity bridge
 * (the deterministic CLI is engine-agnostic — live read-only inspection is the
 * agent's job, see Docs/Profiles/VerifyFirstEntry.md). It writes the machine JSON
 * report plus sibling HTML/MD human reports at the report path supplied by the CLI.
 * The public `loombridge verify --profile` command resolves that path under the external verification workspace
 * (`~/.loombridge/projects/<id>/feel/reports/feel-profile.json`) so a verify-first
 * run does not dirty the Unity project.
 *
 * Boundary with S5c: measurements are an OPTIONAL input here. The harness that
 * GENERATES them (driving an arbitrary controller, raw trajectory/provenance) is
 * S5c. Absent measurements are reported as "not measured" — never invented, and
 * the overall status is never green while a metric is unmeasured (S5 non-goal:
 * "do not hide unmeasured metrics behind a green summary").
 */

import fs from "node:fs/promises";
import path from "node:path";

import { detectEngine } from "../../../verification/plan.js";
import { nowIso } from "../../../../domain/state.js";
import {
  loadProfile,
  SHIPPED_PROFILE_IDS,
} from "./profiles.js";
import {
  KNOWN_PROFILE_METRICS,
  type PlatformerFeelProfile,
  type ProfileMetricTarget,
} from "./types.js";
import {
  loadMeasurements,
  type ProfileMeasurements,
} from "./measurements.js";
import type { FeelCaptureCoverageEntry } from "../../../feel/types.js";
import { formatCaptureCoverageLine } from "../../../feel/report.js";
import {
  evaluateMechanisms,
  type MechanismGateResult,
} from "./mechanisms.js";
import { envelopeFromProfile } from "./reachability-profile.js";
import {
  evaluateReachabilityEnvelope,
  type ReachabilityLayout,
  type FeelEnvelope,
} from "../../../verification/gates/reachability.js";
import type { GateCheck } from "../../../verification/gates/types.js";
import { bandWindow, withinBand, type FeelProvenance } from "../../../verification/gates/feel.js";
import { rederiveFromSources, type RederiveVerdict } from "../../../verification/gates/feel-rederive.js";
import { resolveBuildStamp, formatBuildStamp, type BuildStamp } from "../../../../shared/build-stamp.js";
import { stimulusDistrust } from "../../../verification/gates/feel-provenance.js";
import { renderFeelReportHtml, renderFeelReportMarkdown } from "./feel-report-render.js";
import { ICON, tildify } from "../../../../shared/cli-ui.js";

/** Per-metric outcome. `not_measured` is distinct from a graded pass/fail. */
export type ProfileMetricStatus = "pass" | "fail" | "not_measured";

/** Overall report status. `incomplete` = some metric unmeasured, none failing. */
export type ProfileReportStatus = "pass" | "fail" | "incomplete";

/**
 * How much to trust a metric's number — the report's "warn" axis. This NEVER
 * changes the pass/fail `status` (grading is band + §0 distrust only); it tells
 * the developer whether a value was behaviorally re-derived or merely asserted:
 *  - `verified`   — re-derived from the source's own raw trajectory samples (§0 pass).
 *  - `reported`   — a measured value with no re-derivable capture backing it (a
 *                   hand-typed/param-read number); graded against the band like any
 *                   other, but weaker than a `verified` value — surfaced (esp. on an
 *                   in-band pass) so a typed number can't masquerade as measured.
 *  - `rejected`   — §0 re-derivation refuted it (tampered/param-read); forces fail.
 *  - `unmeasured` — no value provided.
 */
export type MetricConfidence = "verified" | "reported" | "rejected" | "unmeasured";

export interface ProfileMetricResult {
  id: string;
  label: string;
  family: string;
  target: number;
  unit: string;
  bandLabel: string;
  measured: number | null;
  status: ProfileMetricStatus;
  confidence: MetricConfidence;
  detail: string;
  whyItMatters?: string;
  suggestion?: string;
}

export interface ProfileConfidenceSummary {
  verified: number;
  reported: number;
  rejected: number;
  unmeasured: number;
}

/**
 * An INFORMATIONAL measured metric the SELECTED profile does NOT band (F5). It is
 * surfaced so a value the profile can't grade (e.g. `inputLatency` — a known metric
 * no shipped profile bands yet) is still VISIBLE in the report instead of silently
 * dropped. It is NEVER graded: it carries no pass/fail and CANNOT affect `status`,
 * `summary`, or the graded `metrics` list. Confidence still applies (a §0-rejected
 * unbanded value reads as `rejected`, so a tampered unbanded number can't pass for
 * a clean measurement — it just never gates).
 */
export interface ProfileUnbandedMetricResult {
  id: string;
  /** Human label (from KNOWN_PROFILE_METRICS, falling back to the id). */
  label: string;
  /** Family (from KNOWN_PROFILE_METRICS, falling back to "run"). */
  family: string;
  measured: number;
  /** Canonical unit (from KNOWN_PROFILE_METRICS), or "" for an unknown id. */
  unit: string;
  /** verified | reported | rejected — same trust axis as graded metrics (never gates). */
  confidence: Exclude<MetricConfidence, "unmeasured">;
  /** Vocabulary-level "why it matters" (spec.whyItMatters), when known. */
  whyItMatters?: string;
}

/**
 * F4 — feel ↔ level coupling. Reachability of the level under the PROFILE's swapped
 * envelope. Three outcomes:
 *  - `pass`    — a level layout was supplied and every collectible is reachable from
 *                the profile's envelope.
 *  - `fail`    — a level layout was supplied and ≥1 collectible is OUT of the swapped
 *                envelope (a real playability break). GATES the verdict (forces `fail`,
 *                like the F3 mechanisms gate) — a swap that strands a collectible can
 *                never certify "playable under this feel".
 *  - `not_run` — NO level layout was supplied. The seam strictness B relies on: this
 *                is stamped EXPLICITLY (never silently absent) so a leveled-game flow
 *                can refuse a profile-green that skipped reachability. A bare feel-check
 *                with no level is not itself failed by `not_run`.
 *
 * `envelope` records the solved reach radii so the swap is auditable (the whole F4
 * point is that a tighter-apex profile shrinks this envelope). Present on `pass`/`fail`
 * (a layout was checked against a derived envelope); absent on `not_run` (no layout,
 * no collectibles, or a missing solve band — nothing was solved against).
 */
export type ProfileReachabilityStatus = "pass" | "fail" | "not_run";

export interface ProfileReachabilityResult {
  status: ProfileReachabilityStatus;
  /** Why reachability was not run (set iff `status === "not_run"`). */
  reason?: string;
  /** The solved reach envelope from the profile's bands (when derivable). */
  envelope?: FeelEnvelope;
  /** Per-collectible checks (empty when `not_run`). */
  checks: GateCheck[];
}

export interface ProfileVerifyReport {
  kind: "feel-profile";
  schemaVersion: "1";
  producedAt: string;
  /** Which loombridge build graded this report (F5 #14: audit provenance). */
  producedBy: BuildStamp;
  profile: {
    id: string;
    title: string;
    summary: string;
    exemplars?: string[];
  };
  engine: { engine: string | null; reason?: string };
  measurementsSource: { path: string | null; provenance?: FeelProvenance };
  /**
   * Generic existing-game capture coverage. This is separate from the profile
   * verdict so harness/setup gaps never read as game bugs, but they stay visible.
   */
  captureCoverage: FeelCaptureCoverageEntry[];
  metrics: ProfileMetricResult[];
  /**
   * S5c §0: per-metric re-derivation verdicts for any measurement claiming
   * trajectory derivation. A `fail` here forces the corresponding metric to fail
   * (a tampered/param-read value can't earn a band pass). Empty for legacy
   * number-only measurements (graded exactly as before — no regression).
   */
  rederivation: RederiveVerdict[];
  /**
   * F5: INFORMATIONAL metrics measured this run that the selected profile does NOT
   * band (e.g. `inputLatency`). Reported so a measured-but-unbanded value stays
   * visible; never graded, never affects `status`/`summary`/`metrics`.
   */
  alsoMeasured: ProfileUnbandedMetricResult[];
  /**
   * F3 — the mechanism-presence gate. For each `requires`/`forbids` entry on the
   * profile's `mechanisms` block, a behavioral-signature check against the captured
   * evidence. UNLIKE `alsoMeasured` this DOES gate: a `fail` (a required mechanism
   * absent, or a forbidden one present) forces the overall `status` to `fail`; a
   * `refused` (a claimed mechanism with no usable evidence) can never be green
   * (downgrades a would-be `pass` to `incomplete`). `not_applicable` when the
   * profile makes no mechanism claim. The F1 hole (#166) is closed here.
   */
  mechanisms: MechanismGateResult;
  /**
   * F4 — feel ↔ level coupling. Reachability of the supplied level layout under THIS
   * profile's swapped envelope. ALWAYS present (never silently absent): `not_run` when
   * no layout was supplied (the strictness-B seam), `fail` when a collectible is out of
   * the swapped envelope (GATES the verdict, like `mechanisms`), else `pass`.
   */
  reachability: ProfileReachabilityResult;
  summary: { total: number; pass: number; fail: number; notMeasured: number };
  /** Trust roll-up across measured metrics — the report's "warn" axis (see MetricConfidence). */
  confidence: ProfileConfidenceSummary;
  status: ProfileReportStatus;
  /** One-line takeaway — the single most important thing to read first. */
  headline: string;
  nextAction: string;
}

function measurementsWithCoverageRefusals(
  measurements: ProfileMeasurements,
  bandedMetricIds: ReadonlySet<string>,
): ProfileMeasurements {
  if (!measurements.captureCoverage || measurements.captureCoverage.length === 0) return measurements;
  const refused = new Set(
    measurements.captureCoverage
      .filter((entry) => bandedMetricIds.has(entry.metric) && entry.status !== "measured")
      .map((entry) => entry.metric),
  );
  if (refused.size === 0) return measurements;
  const metrics = { ...measurements.metrics };
  for (const metric of refused) delete metrics[metric];
  return { ...measurements, metrics };
}

/**
 * Compare measurements against a profile's bands. Pure + exported for tests.
 * Honest status rule: any `fail` → `fail`; else any `not_measured` → `incomplete`;
 * else `pass`. A profile metric is never silently skipped.
 *
 * `distrusted` (S5c §0) maps a metric id → reason for any measurement that FAILED
 * re-derivation (or claimed trajectory derivation without samples). A distrusted
 * metric can NEVER be a band `pass` — it is forced to `fail` with the reason, so a
 * tampered/param-read measurement cannot earn a green via the verify-first path.
 *
 * `verified` (S5d) is the set of metric ids whose value re-derived cleanly from
 * the source's own raw samples (§0 pass). It is presentation-only — it sets each
 * metric's `confidence` but never changes its pass/fail `status`.
 */
export function evaluateProfile(
  profile: PlatformerFeelProfile,
  measurements: ProfileMeasurements,
  distrusted: ReadonlyMap<string, string> = new Map(),
  verified: ReadonlySet<string> = new Set(),
): {
  metrics: ProfileMetricResult[];
  status: ProfileReportStatus;
  summary: ProfileVerifyReport["summary"];
  confidence: ProfileConfidenceSummary;
} {
  const metrics: ProfileMetricResult[] = [];

  // Refuse a metric-less profile by construction (CLAUDE.md: "an absent binding is
  // a refusal, not a silently-skipped check"). loadProfile's validator already
  // refuses NO_METRICS, but this guard makes the honest-status property hold for
  // any caller — without it, an empty `metrics` would compute fail=0/notMeasured=0
  // and report a green "pass" from nothing.
  if (Object.keys(profile.metrics).length === 0) {
    throw new Error(
      `evaluateProfile: profile '${profile.id}' defines no metrics — a valid profile must declare at least one measurable band.`,
    );
  }

  for (const [id, targetRaw] of Object.entries(profile.metrics)) {
    const target = targetRaw as ProfileMetricTarget;
    const spec = KNOWN_PROFILE_METRICS[id];
    const { label: bandLabel } = bandWindow(target);
    const measured = measurements.metrics[id];

    const base = {
      id,
      label: spec?.label ?? id,
      family: spec?.family ?? "run",
      target: target.target,
      unit: target.unit,
      bandLabel,
      whyItMatters: target.whyItMatters,
      suggestion: target.suggestion,
    };

    if (measured === undefined) {
      metrics.push({
        ...base,
        measured: null,
        status: "not_measured",
        confidence: "unmeasured",
        detail: `${base.label}: target ${target.target}${target.unit} (${bandLabel}) — not measured.`,
      });
      continue;
    }

    // §0 enforcement: a measurement that failed re-derivation is untrusted and
    // can never pass the band — it is reported as a fail regardless of value.
    const distrustReason = distrusted.get(id);
    if (distrustReason !== undefined) {
      metrics.push({
        ...base,
        measured,
        status: "fail",
        confidence: "rejected",
        detail: `${base.label}: measurement rejected — ${distrustReason}`,
      });
      continue;
    }

    const ok = withinBand(measured, target);
    // Confidence is independent of pass/fail: a value re-derived from its own raw
    // samples is `verified`; otherwise it was asserted without re-derivable
    // evidence (`reported`). This never changes `status` — only how it reads.
    const confidence: MetricConfidence = verified.has(id) ? "verified" : "reported";
    metrics.push({
      ...base,
      measured,
      status: ok ? "pass" : "fail",
      confidence,
      detail: `${base.label}: target ${target.target}${target.unit}, measured ${measured}${target.unit}, band ${bandLabel} -> ${ok ? "PASS" : "FAIL"}.`,
    });
  }

  const summary = {
    total: metrics.length,
    pass: metrics.filter((m) => m.status === "pass").length,
    fail: metrics.filter((m) => m.status === "fail").length,
    notMeasured: metrics.filter((m) => m.status === "not_measured").length,
  };
  const confidence: ProfileConfidenceSummary = {
    verified: metrics.filter((m) => m.confidence === "verified").length,
    reported: metrics.filter((m) => m.confidence === "reported").length,
    rejected: metrics.filter((m) => m.confidence === "rejected").length,
    unmeasured: metrics.filter((m) => m.confidence === "unmeasured").length,
  };
  const status: ProfileReportStatus =
    summary.fail > 0 ? "fail" : summary.notMeasured > 0 ? "incomplete" : "pass";

  return { metrics, status, summary, confidence };
}

/**
 * F4 — compute the reachability block for the profile-verify report. Pure + exported
 * for tests.
 *  - no layout            → `not_run` with the seam reason (never silently absent).
 *  - layout + bands ok    → run the gate; map its verdict: any `fail` check → `fail`
 *                           (gates the verdict upstream), else `pass`. (A bare WARN —
 *                           empty collectibles — maps to `pass`: the gate ran, nothing
 *                           is out of reach.)
 *  - layout but profile   → `not_run` with the missing-band reason (refuse-don't-skip:
 *    missing solve band     we cannot derive an honest envelope, so we do NOT invent
 *                           one and we do NOT pretend it passed).
 */
export function computeProfileReachability(
  profile: PlatformerFeelProfile,
  layout: ReachabilityLayout | undefined,
): ProfileReachabilityResult {
  if (!layout) {
    return {
      status: "not_run",
      reason:
        "no level layout supplied — reachability against this profile's envelope was not evaluated. Capture platforms/launchers/collectibles (scene.get_bounds) and pass --layout to re-validate the level under this feel.",
      checks: [],
    };
  }
  // A layout with no collectibles proves nothing — the gate would only WARN. Treat
  // it as not_run (it validated nothing), never a green that reads as "checked".
  if (!(layout.collectibles && layout.collectibles.length > 0)) {
    return {
      status: "not_run",
      reason:
        "layout has no collectibles — reachability validated nothing. Capture the collectible positions (scene.get_bounds) to re-validate the level under this feel.",
      checks: [],
    };
  }
  let envelope: FeelEnvelope;
  try {
    envelope = envelopeFromProfile(profile);
  } catch (err) {
    // Refuse-don't-skip: a profile missing a solve band cannot produce an honest
    // envelope. Stamp not_run with the reason rather than guessing or passing.
    return {
      status: "not_run",
      reason: err instanceof Error ? err.message : String(err),
      checks: [],
    };
  }
  const report = evaluateReachabilityEnvelope(layout, envelope);
  const anyFail = report.checks.some((c) => c.status === "fail");
  return {
    status: anyFail ? "fail" : "pass",
    envelope,
    checks: report.checks,
  };
}

/** Join a short list of ids for prose, capping the tail so the line stays readable. */
function listIds(ids: string[], cap = 3): string {
  if (ids.length <= cap) return ids.join(", ");
  return `${ids.slice(0, cap).join(", ")} +${ids.length - cap} more`;
}

/**
 * The developer-facing "what to do next" line. Specific where it can be: names
 * the failing metrics, the profile, and (on a pass) any in-band-but-unverified
 * metrics so a typed-number "pass" can never read as a measured one.
 */
function nextActionFor(
  report: Pick<ProfileVerifyReport, "status" | "metrics" | "confidence" | "profile">,
  engineOk: boolean,
  hasMeasurements: boolean,
  engineUnconfirmedButGraded: boolean,
): string {
  // Nothing was graded — point at the missing input (engine first, then measurements).
  if (!hasMeasurements) {
    if (!engineOk) {
      return "Run this from your Unity project root (the folder with Assets/ and ProjectSettings/) so Loombridge can detect the project.";
    }
    return `No measurements yet — have Loombridge measure your player (run/jump/coyote/buffer) and re-run to grade against the '${report.profile.id}' profile.`;
  }
  // A clean pass we can't certify because the engine isn't confirmed Unity — the
  // engine IS the next action here (the metrics already graded in-band).
  if (engineUnconfirmedButGraded) {
    return `Measured metrics are all in band for '${report.profile.id}', but the project isn't confirmed Unity — run from your Unity project root (the folder with Assets/ and ProjectSettings/) to confirm it and turn this into a verified pass.`;
  }
  // Metrics WERE graded → lead with the metric-driven action; the engine note (if
  // any) is appended context, never a replacement (band + §0 are engine-independent).
  const engineSuffix = engineOk
    ? ""
    : ` Also run from your Unity project root to confirm the project (the grading above is engine-independent).`;
  if (report.status === "fail") {
    const rejected = report.metrics.filter((m) => m.confidence === "rejected").map((m) => m.id);
    const outOfBand = report.metrics.filter((m) => m.status === "fail" && m.confidence !== "rejected").map((m) => m.id);
    const parts: string[] = [];
    if (outOfBand.length > 0) {
      parts.push(`${listIds(outOfBand)} fall outside the '${report.profile.id}' band — apply the fix shown for each, then re-measure and re-run`);
    }
    if (rejected.length > 0) {
      parts.push(`re-derivation rejected ${listIds(rejected)} (reported value ≠ raw samples) — re-capture honestly`);
    }
    return `${parts.join("; ")}.${engineSuffix}`;
  }
  if (report.status === "incomplete") {
    const unmeasured = report.metrics.filter((m) => m.status === "not_measured").map((m) => m.id);
    return `Measured metrics are in band; ${listIds(unmeasured)} still unmeasured — measure the rest for a complete '${report.profile.id}' report.${engineSuffix}`;
  }
  // pass
  if (report.confidence.reported > 0) {
    const unverified = report.metrics.filter((m) => m.confidence === "reported").map((m) => m.id);
    return `In band for '${report.profile.id}', but ${listIds(unverified)} are reported without a re-derivable capture — capture their trajectories so the pass is verified, not just asserted.`;
  }
  return `All measured metrics are verified in band for '${report.profile.id}'. Nothing to change for the metrics checked.`;
}

/** The one-line takeaway — read this first. */
export function headlineFor(
  report: Pick<ProfileVerifyReport, "status" | "summary" | "confidence" | "profile">,
  engineOk: boolean,
  hasMeasurements: boolean,
  engineUnconfirmedButGraded: boolean,
  reachabilityNotRun: boolean,
): string {
  // A green feel verdict must NOT hide that the level was never re-validated under
  // this feel's envelope — otherwise a leveled-game swap reads as a clean pass just
  // by omitting --layout (F4 strictness B; the doneness refusal is the seam's other
  // half). Surfaced on every otherwise-passing headline.
  const reachNote = reachabilityNotRun
    ? " — reachability NOT run (no level layout); pass --layout to validate the level under this feel"
    : "";
  const title = report.profile.title;
  // Nothing was graded — the gate (no engine / no measurements) IS the headline.
  if (!hasMeasurements) {
    if (!engineOk) return "Can't confirm a Unity project here — nothing graded.";
    return `No measurements provided — nothing graded against ${title}.`;
  }
  const s = report.summary;
  const c = report.confidence;
  // A clean pass we can't certify because the engine isn't confirmed Unity. Say
  // so explicitly — the metrics DID grade in-band; this is not "nothing graded".
  if (engineUnconfirmedButGraded) {
    return `All ${s.pass} measured metric(s) in band for ${title}, but the project isn't confirmed Unity — can't certify a pass yet.`;
  }
  // Metrics WERE graded → lead with the feel verdict; the engine note is a caveat.
  const caveat = engineOk
    ? ""
    : ` — project not confirmed as Unity (band grading + re-derivation are engine-independent)`;
  if (report.status === "fail") {
    // A rejected metric may be perfectly in-band and fail ONLY because §0
    // re-derivation refuted it — never lump it under "outside the band".
    const outOfBand = s.fail - c.rejected;
    const parts: string[] = [];
    if (outOfBand > 0) parts.push(`${outOfBand} outside band`);
    if (c.rejected > 0) parts.push(`${c.rejected} rejected by re-derivation`);
    return `${s.fail} of ${s.total} ${title} metric(s) failed: ${parts.join(", ")}.${caveat}`;
  }
  if (report.status === "incomplete") {
    return `${s.pass} measured metric(s) in band for ${title}; ${s.notMeasured} still unmeasured.${caveat}`;
  }
  // pass
  const verifiedNote =
    c.reported > 0
      ? ` (${c.verified} verified, ${c.reported} reported without re-derivable capture)`
      : " — all verified from raw samples";
  return `All ${s.pass} measured metric(s) in band for ${title}${verifiedNote}.${reachNote}`;
}

export interface VerifyProfileArgs {
  /** Project root (the dir that contains the Unity project / `.loombridge/`). */
  root: string;
  /** Shipped profile id (`precision`/`classic`/`momentum`). */
  profile: string;
  /** Optional measurements file path. */
  measurementsPath?: string;
  /** Report output path. Required by `runVerifyProfile`; ignored by pure report builders. */
  outputPath?: string;
  /** Treat an `incomplete` (unmeasured) report as a non-zero exit too. */
  strict: boolean;
  /**
   * F4 — optional level layout (platforms/launchers/collectibles, the SAME shape the
   * build-mode reachability gate consumes via `scene.get_bounds`). When supplied,
   * reachability runs against THIS profile's envelope and an unreachable collectible
   * GATES the verdict. When omitted, reachability is stamped `not_run` (the seam).
   */
  layout?: ReachabilityLayout;
}

/** Build the report object. Pure aside from engine/profile/measurement loading. */
export async function buildProfileReport(
  args: VerifyProfileArgs,
): Promise<ProfileVerifyReport> {
  const engine = detectEngine(args.root);
  const profile = await loadProfile(args.profile); // throws on unknown id

  let measurements: ProfileMeasurements = { metrics: {} };
  if (args.measurementsPath) {
    measurements = await loadMeasurements(args.measurementsPath);
  }
  const bandedMetricIds = new Set(Object.keys(profile.metrics));
  measurements = measurementsWithCoverageRefusals(measurements, bandedMetricIds);
  const hasMeasurements = Object.keys(measurements.metrics).length > 0;

  // §0 enforcement: re-derive every trajectory-claimed metric from its own raw
  // samples; a metric whose reported value doesn't match (or that claims
  // trajectory derivation without samples) is distrusted and forced to fail in
  // evaluateProfile. Legacy number-only measurements carry no trajectory sources,
  // so this is empty and grading is unchanged.
  const rederivation = rederiveFromSources(
    measurements.provenance?.sources ?? [],
    measurements.metrics,
  );
  const distrusted = new Map<string, string>(
    rederivation.filter((v) => v.status === "fail").map((v) => [v.metric, v.detail]),
  );
  // F5: a stimulus-sensitive metric (shortHopApex) that this profile bands and the
  // run measured must carry a CANONICAL stimulus on its source. An absent / off-canon
  // tap is a refusal (same refuse-don't-skip discipline as re-derivation) — the
  // metric is forced to fail so an operator can't pick the tap that passes. Scoped
  // to stimulus-sensitive metrics only, so runSpeed/jumpApex/etc. are unaffected.
  // All banded+measured metrics; stimulusDistrust filters to the stimulus-sensitive
  // subset (isStimulusRequired) internally, so non-shortHop metrics are unaffected.
  const bandedMeasuredMetrics = Object.keys(measurements.metrics).filter((id) => bandedMetricIds.has(id));
  for (const [metric, reason] of stimulusDistrust(
    bandedMeasuredMetrics,
    measurements.provenance?.sources ?? [],
  )) {
    if (!distrusted.has(metric)) distrusted.set(metric, reason);
  }
  // Metrics that re-derived cleanly from their own samples earn `verified`
  // confidence (presentation only — never changes pass/fail).
  const verified = new Set<string>(
    rederivation.filter((v) => v.status === "pass").map((v) => v.metric),
  );

  const { metrics, status: metricStatus, summary, confidence } = evaluateProfile(
    profile,
    measurements,
    distrusted,
    verified,
  );

  // F5: measured metrics this profile does NOT band — surfaced informationally so a
  // value the profile can't grade (e.g. inputLatency) is visible, never graded.
  // Confidence reuses the SAME §0 axis (verified/reported/rejected) so a tampered
  // unbanded number reads honestly — but it never enters summary/status.
  const alsoMeasured: ProfileUnbandedMetricResult[] = Object.entries(measurements.metrics)
    .filter(([id, v]) => !bandedMetricIds.has(id) && typeof v === "number" && Number.isFinite(v))
    .map(([id, v]) => {
      const spec = KNOWN_PROFILE_METRICS[id];
      const conf: Exclude<MetricConfidence, "unmeasured"> = distrusted.has(id)
        ? "rejected"
        : verified.has(id)
          ? "verified"
          : "reported";
      return {
        id,
        label: spec?.label ?? id,
        family: spec?.family ?? "run",
        measured: v as number,
        unit: spec?.unit ?? "",
        confidence: conf,
        whyItMatters: spec?.whyItMatters,
      };
    });

  // F3 — the mechanism-presence gate (the F1 hole). Evidence is OPTIONAL (mirrors
  // `measurements`): absent → any CLAIMED mechanism refuses (never skipped). The gate
  // result is its own report block AND folds into the overall status below.
  const mechanisms = evaluateMechanisms(profile, measurements.mechanismEvidence ?? {});

  // F4 — feel ↔ level coupling. If a level layout was supplied, re-check it against
  // THIS profile's swapped envelope (the SAME geometry build mode runs, fed by the
  // profile's bands). An unreachable collectible GATES the verdict (forced `fail`
  // below) — a swap that strands a collectible can't certify "playable under this
  // feel". If NO layout was supplied, stamp `not_run` EXPLICITLY (never silently
  // absent): the seam strictness B relies on, so a leveled-game flow can refuse a
  // green that skipped reachability. A bare feel-check is not itself failed by it.
  const reachability = computeProfileReachability(profile, args.layout);

  // verify-first is a Unity 2D-platformer wedge. A clean "pass" on a project we
  // can't confirm is Unity — undetected (null) OR a different engine (godot/unreal)
  // — is incoherent: we have no evidence the measurements describe a real Unity
  // platformer here. Never report green unless the engine is Unity; downgrade to
  // "incomplete" so the verdict matches the "run from your Unity project root"
  // next action. A genuine out-of-band `fail` stays a fail regardless.
  const isUnity = engine.engine === "unity";
  let status: ProfileReportStatus =
    !isUnity && metricStatus === "pass" ? "incomplete" : metricStatus;
  // F3 status fold (refuse-don't-skip): a mechanism MISMATCH is a definitional
  // identity violation and gates the verdict → force `fail` (outranks everything).
  // A mechanism REFUSED (claimed but unprobed) can never read green → downgrade a
  // would-be pass to `incomplete` (the claim is unverified, like an unmeasured band).
  if (mechanisms.status === "fail") {
    status = "fail";
  } else if (mechanisms.status === "refused" && status === "pass") {
    status = "incomplete";
  }
  // F4 status fold (mirrors the F3 mechanisms fold): an unreachable collectible under
  // the swapped envelope is a real playability break → force `fail` (outranks
  // everything, like a mechanism mismatch). `not_run` does NOT gate here — it is the
  // honest "no level supplied" stamp; the leveled-game refusal lives in a future
  // swap-doneness flow (see the F4 plan §Strictness, Layer 2).
  if (reachability.status === "fail") {
    status = "fail";
  }
  // A graded, all-in-band run on a project we can't confirm is Unity: the metrics
  // DID grade (this is not "nothing graded") but we won't certify a pass. The
  // headline/nextAction lead with the feel verdict + this caveat (F3 fix).
  const engineUnconfirmedButGraded = !isUnity && metricStatus === "pass";

  const profileSummary = {
    id: profile.id,
    title: profile.title,
    summary: profile.summary,
    exemplars: profile.exemplars,
  };
  const headlineCtx = { status, summary, confidence, profile: profileSummary };
  const nextActionCtx = { status, metrics, confidence, profile: profileSummary };

  return {
    kind: "feel-profile",
    schemaVersion: "1",
    producedAt: nowIso(),
    producedBy: resolveBuildStamp(),
    profile: profileSummary,
    engine: "reason" in engine ? { engine: engine.engine, reason: engine.reason } : { engine: engine.engine },
    measurementsSource: {
      path: args.measurementsPath ?? null,
      provenance: measurements.provenance,
    },
    captureCoverage: measurements.captureCoverage ?? [],
    metrics,
    rederivation,
    alsoMeasured,
    mechanisms,
    reachability,
    summary,
    confidence,
    status,
    headline: headlineFor(headlineCtx, isUnity, hasMeasurements, engineUnconfirmedButGraded, reachability.status === "not_run"),
    nextAction: nextActionFor(nextActionCtx, isUnity, hasMeasurements, engineUnconfirmedButGraded),
  };
}

const STATUS_GLYPH: Record<ProfileMetricStatus, string> = {
  pass: "PASS",
  fail: "FAIL",
  not_measured: "—",
};

/** Short trust tag shown after each measured metric (the "warn" axis). */
const CONFIDENCE_TAG: Record<MetricConfidence, string> = {
  verified: "verified",
  reported: "unverified",
  rejected: "rejected",
  unmeasured: "",
};

/** Round a measured value for the TERMINAL only — the JSON keeps full precision. */
function fmtMeasured(value: number): string {
  return String(Number(value.toFixed(3)));
}

/** Render the report to stderr in the loombridge developer voice. */
function renderReport(report: ProfileVerifyReport): void {
  const p = report.profile;
  console.error(`[loombridge verify] profile=${p.id} (${p.title}) — ${p.summary}`);
  if (p.exemplars && p.exemplars.length > 0) {
    console.error(`[loombridge verify] feels like: ${p.exemplars.join(", ")}`);
  }
  if (report.engine.engine !== "unity") {
    const detected = report.engine.engine === null ? "not detected" : `detected ${report.engine.engine}, not Unity`;
    console.error(
      `[loombridge verify] engine: ${detected} — ${report.engine.reason ?? "verify-first targets Unity 2D platformers"}`,
    );
  }
  // Headline first — the single most important line.
  console.error(`[loombridge verify] ${report.headline}`);
  console.error(`[loombridge verify] produced by ${formatBuildStamp(report.producedBy)}`);
  for (const m of report.metrics) {
    const measured = m.measured === null ? "(not measured)" : `${fmtMeasured(m.measured)}${m.unit}`;
    const tag = CONFIDENCE_TAG[m.confidence];
    const tagStr = tag ? `  [${tag}]` : "";
    console.error(
      `  ${STATUS_GLYPH[m.status].padEnd(4)} ${m.id} — ${measured} → ${m.target}${m.unit} ${m.bandLabel}${tagStr}`,
    );
    // On a failure, explain the stakes (why) before the remedy (fix) so the
    // developer can decide whether the metric matters for their game.
    if (m.status === "fail") {
      if (m.whyItMatters) console.error(`       why: ${m.whyItMatters}`);
      if (m.confidence === "rejected") {
        console.error(`       note: rejected by re-derivation — the reported number must come from real samples.`);
      } else if (m.suggestion) {
        console.error(`       fix: ${m.suggestion}`);
      }
    }
  }
  // F5: informational "also measured" — metrics this profile doesn't band. Clearly
  // separated from the graded list above and explicitly labelled UNBANDED so it can
  // never read as a graded pass/fail (it has no PASS/FAIL glyph and never gates).
  if (report.alsoMeasured.length > 0) {
    console.error(`[loombridge verify] also measured (unbanded — informational, not graded):`);
    for (const m of report.alsoMeasured) {
      const tag = CONFIDENCE_TAG[m.confidence];
      const tagStr = tag ? `  [${tag}]` : "";
      console.error(`       ${m.id} — ${fmtMeasured(m.measured)}${m.unit} (no band in this profile)${tagStr}`);
    }
  }
  if (report.captureCoverage.length > 0) {
    console.error(`[loombridge verify] capture coverage:`);
    for (const entry of report.captureCoverage) {
      console.error(`       ${formatCaptureCoverageLine(entry)}`);
    }
  }
  // F3: the mechanism-presence gate — printed only when the profile makes a claim.
  if (report.mechanisms.status !== "not_applicable") {
    console.error(
      `[loombridge verify] mechanisms (${report.mechanisms.status}) — required present / forbidden absent, verified behaviorally:`,
    );
    if (report.mechanisms.checks.length === 0) {
      console.error(`       (this profile claims no mechanisms)`);
    }
    for (const mc of report.mechanisms.checks) {
      const glyph = mc.result === "unprobed" ? "REFUSE" : mc.ok ? "PASS" : "FAIL";
      console.error(`  ${glyph.padEnd(6)} ${mc.detail}`);
    }
  }
  // F4: feel ↔ level coupling — printed always (the not_run stamp must be visible).
  const reach = report.reachability;
  if (reach.status === "not_run") {
    console.error(
      `[loombridge verify] reachability (not_run) — ${reach.reason ?? "no level layout supplied"}`,
    );
  } else {
    const env = reach.envelope;
    const envStr = env
      ? ` (envelope: apex ${env.jumpApex}+vMargin ${env.vMargin}u, hReach ${env.hReach.toFixed(2)}u)`
      : "";
    console.error(
      `[loombridge verify] reachability (${reach.status})${envStr} — every collectible within the profile's swapped envelope:`,
    );
    for (const rc of reach.checks) {
      const glyph = rc.status === "fail" ? "FAIL" : rc.status === "warn" ? "WARN" : "PASS";
      console.error(`  ${glyph.padEnd(4)} ${rc.detail}`);
    }
  }
  const s = report.summary;
  const c = report.confidence;
  console.error(
    `[loombridge verify] status=${report.status} | ${s.pass} pass, ${s.fail} fail, ${s.notMeasured} not measured (of ${s.total})`,
  );
  console.error(
    `[loombridge verify] confidence | ${c.verified} verified, ${c.reported} reported, ${c.rejected} rejected, ${c.unmeasured} unmeasured`,
  );
  console.error(`[loombridge verify] next: ${report.nextAction}`);
}

/**
 * Run the verify-first profile flow. Returns the exit code.
 * Exit: `fail` → 1; `incomplete` → 1 only under `--strict`; else 0.
 */
export async function runVerifyProfile(args: VerifyProfileArgs & { outputPath: string }): Promise<number> {
  const outputPath = args.outputPath;

  const report = await buildProfileReport(args);

  // Create ONLY the reports dir — verify-first must not scaffold the full
  // build-mode tree (design/traces/verify) in a read-only diagnose run.
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf-8");
  const ext = path.extname(outputPath);
  const base = ext === ".json" ? outputPath.slice(0, -ext.length) : outputPath;
  const htmlPath = `${base}.html`;
  const mdPath = `${base}.md`;
  await fs.writeFile(htmlPath, renderFeelReportHtml(report), "utf-8");
  await fs.writeFile(mdPath, renderFeelReportMarkdown(report), "utf-8");

  renderReport(report);
  console.error(
    `${ICON.report} Report: open ${tildify(htmlPath)} in a browser (or ${tildify(mdPath)}); full detail in ${tildify(outputPath)}`,
  );

  if (report.status === "fail") return 1;
  if (report.status === "incomplete" && args.strict) return 1;
  return 0;
}

/** Format the "unknown profile" guidance shared by the CLI. */
export function unknownProfileMessage(id: string): string {
  return `[loombridge verify] unknown --profile "${id}". Shipped profiles: ${SHIPPED_PROFILE_IDS.join(", ")}.`;
}
