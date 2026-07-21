/**
 * Experimental build follow-on proof validator.
 *
 * This is deliberately narrower than a production `loomtide build` mode. It validates a
 * reviewable evidence bundle for the generic genre bootstrap follow-on: one non-platformer
 * slice may be called `experimental-green` only when its plan-time Genre Contract is valid,
 * every runnable gate it claims is supported + passing, and every unsupported shooter-feel
 * claim remains an explicit methodology gap.
 */

import { SUPPORTED_GATE_IDS } from "../../verification/run-gates.js";
import { defaultGenreId } from "../genre-registry.js";
import { validateGenreContract } from "./validator.js";
import type { FeelBand, GenreContract, GenreContractIssue, SliceNode } from "./types.js";

/**
 * Options for proof validation. `readArtifact` resolves a metric-evidence row's relative artifact
 * path to the artifact JSON. It is the mechanism that makes a `status:pass` row VERIFIABLE: the proof
 * reads the cited artifact and confirms it structurally records the derived value (and, if the contract
 * declares a `gateBand`, that the value is within it). Self-reported `status` is never the sole basis for
 * a pass — a row whose artifact cannot be read/verified is refused, not skipped.
 */
export interface ExperimentalProofOptions {
  /** Resolve a safe relative artifact path to its parsed JSON (or null/throw if unreadable). */
  readArtifact?: (relativeArtifactPath: string) => unknown;
}

export const EXPERIMENTAL_BUILD_PROOF_SCHEMA_VERSION = "0.1.0" as const;

export type ExperimentalBuildStatus = "experimental-green" | "blocked" | "failed";
export type ExperimentalGateStatus = "pass" | "warn" | "fail";

export interface ExperimentalGateEvidence {
  gate: string;
  status: ExperimentalGateStatus;
  artifact: string;
  summary: string;
}

export interface ExperimentalMetricEvidence {
  metric: string;
  status: ExperimentalGateStatus;
  artifact: string;
  summary: string;
}

export interface ExperimentalMethodologyGap {
  id: string;
  linkedTargets?: string[];
  reason: string;
}

export interface ExperimentalBuildProof {
  schemaVersion: typeof EXPERIMENTAL_BUILD_PROOF_SCHEMA_VERSION;
  genreContract: GenreContract;
  slice: {
    id: string;
    title: string;
    confidence: "experimental";
    status: ExperimentalBuildStatus;
    productionReady: false;
    supportedGates: string[];
  };
  build: {
    runId: string;
    builtAt: string;
    implementationSummary: string;
  };
  capture: {
    capturedAt: string;
    gateEvidence: ExperimentalGateEvidence[];
    metricEvidence?: ExperimentalMetricEvidence[];
  };
  methodologyGaps: ExperimentalMethodologyGap[];
}

export interface ExperimentalBuildProofIssue {
  code: string;
  message: string;
  path: string;
}

export interface ExperimentalBuildProofValidationResult {
  valid: boolean;
  issues: ExperimentalBuildProofIssue[];
}

const SAFE_ARTIFACT_PATH_RE = /^[A-Za-z0-9._/@-]+$/;

function isSafeArtifactPath(value: unknown): value is string {
  if (!isNonEmptyString(value) || !SAFE_ARTIFACT_PATH_RE.test(value)) return false;
  if (value.startsWith("/") || value.includes("://")) return false;
  return !value.split("/").some((segment) => segment === "..");
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function pushGenreIssues(
  issues: ExperimentalBuildProofIssue[],
  contractIssues: GenreContractIssue[],
): void {
  for (const issue of contractIssues) {
    issues.push({
      code: `GENRE_CONTRACT_${issue.code}`,
      message: issue.message,
      path: `genreContract${issue.path ? `.${issue.path}` : ""}`,
    });
  }
}

function findCoreSlice(contract: GenreContract, sliceId: string): SliceNode | undefined {
  return contract.sliceDag.coreVertical.find((slice) => slice.id === sliceId);
}

function collectRequiredGapIds(contract: GenreContract, slice: SliceNode): Set<string> {
  const required = new Set<string>(slice.gaps ?? []);
  for (const row of contract.measurabilityMap) {
    if (row.bucket !== "coreVertical") continue;
    if (row.tag === "needs-new-calculator" || row.tag === "needs-new-bridge-capability" || row.tag === "engine-unsupported-today") {
      required.add(row.target);
    }
  }
  for (const condition of contract.refusalConditions) {
    required.add(condition.condition);
  }
  return required;
}

function measurableNowTargets(contract: GenreContract): Set<string> {
  return new Set(
    contract.measurabilityMap
      .filter((row) => row.tag === "measurable-now")
      .map((row) => row.target),
  );
}

function measurableNowCoreTargets(contract: GenreContract): Set<string> {
  return new Set(
    contract.measurabilityMap
      .filter((row) => row.bucket === "coreVertical" && row.tag === "measurable-now")
      .map((row) => row.target),
  );
}

function gapCovers(required: string, gap: ExperimentalMethodologyGap): boolean {
  return gap.id === required || (gap.linkedTargets ?? []).includes(required);
}

/** The enforced gate band for `metric`, if the contract declares one. (measurabilityMap targets are unique.) */
function gateBandForMetric(contract: GenreContract | null, metric: string): FeelBand | undefined {
  return contract?.measurabilityMap.find((row) => row.target === metric)?.gateBand;
}

/** A numeric [min,max] window for a gateBand, or null when the band is qualitative / unbounded both ways. */
function numericGateWindow(band: FeelBand | undefined): { min: number; max: number } | null {
  if (!band) return null;
  const min = typeof band.min === "number" ? band.min : -Infinity;
  const max = typeof band.max === "number" ? band.max : Infinity;
  if (min === -Infinity && max === Infinity) return null;
  return { min, max };
}

/**
 * The canonical derived value for `metric` recorded in a read artifact: `derived: { metric, value }`.
 * Returns null when the artifact does not structurally record a finite value for this exact metric —
 * which closes the fabricated-artifact hole (a path that does not record the claimed value cannot pass).
 */
function artifactDerivedValue(artifact: unknown, metric: string): number | null {
  if (!isRecord(artifact)) return null;
  const derived = artifact.derived;
  if (!isRecord(derived) || derived.metric !== metric) return null;
  const value = derived.value;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function validateExperimentalBuildProof(
  input: unknown,
  opts: ExperimentalProofOptions = {},
): ExperimentalBuildProofValidationResult {
  const issues: ExperimentalBuildProofIssue[] = [];
  const push = (code: string, message: string, path: string) => issues.push({ code, message, path });
  const readArtifact = opts.readArtifact;
  /** Metrics whose status:pass row was VERIFIED against its artifact (and gateBand, if any). */
  const verifiedPassingTargets = new Set<string>();

  if (!isRecord(input)) {
    return { valid: false, issues: [{ code: "NOT_OBJECT", message: "proof must be a JSON object", path: "" }] };
  }

  if (input.schemaVersion !== EXPERIMENTAL_BUILD_PROOF_SCHEMA_VERSION) {
    push("SCHEMA_VERSION", `schemaVersion must be "${EXPERIMENTAL_BUILD_PROOF_SCHEMA_VERSION}"`, "schemaVersion");
  }

  const contractResult = validateGenreContract(input.genreContract);
  if (!contractResult.valid) {
    pushGenreIssues(issues, contractResult.issues);
  }
  const contract = contractResult.valid ? (input.genreContract as GenreContract) : null;
  // The generic-build follow-on proof exists to show the pipeline works for a NEW genre — never the
  // baseline default genre (which already has the full pipeline). Sourced from the registry so this
  // carries no genre literal of its own.
  if (contract?.genreId === defaultGenreId()) {
    push(
      "NOT_GENERIC_FOLLOW_ON",
      `generic build follow-on must prove a genre other than the baseline default (${defaultGenreId()})`,
      "genreContract.genreId",
    );
  }

  const slice = input.slice;
  let coreSlice: SliceNode | undefined;
  if (!isRecord(slice)) {
    push("SLICE", "slice must be an object", "slice");
  } else {
    if (!isNonEmptyString(slice.id)) {
      push("SLICE_ID", "slice.id is required", "slice.id");
    } else if (contract) {
      coreSlice = findCoreSlice(contract, slice.id);
      if (!coreSlice) {
        push("SLICE_NOT_CORE_VERTICAL", "slice.id must reference a coreVertical slice in the contract", "slice.id");
      }
    }
    if (slice.confidence !== "experimental") {
      push("SLICE_CONFIDENCE", "follow-on proof can only certify experimental slices", "slice.confidence");
    }
    if (slice.status !== "experimental-green") {
      push("SLICE_STATUS", "slice.status must be experimental-green for this proof", "slice.status");
    }
    if (slice.productionReady !== false) {
      push("PRODUCTION_CLAIM", "experimental follow-on proof must not claim productionReady", "slice.productionReady");
    }
    if (!isStringArray(slice.supportedGates) || slice.supportedGates.length === 0) {
      push("SUPPORTED_GATES", "slice.supportedGates must be a non-empty string array", "slice.supportedGates");
    } else {
      const contractGates = new Set(coreSlice?.gates ?? []);
      slice.supportedGates.forEach((gate, i) => {
        if (!SUPPORTED_GATE_IDS.has(gate)) {
          push("UNSUPPORTED_GATE", `gate "${gate}" is not supported by the verifier`, `slice.supportedGates[${i}]`);
        }
        if (coreSlice && !contractGates.has(gate)) {
          push("GATE_NOT_IN_CONTRACT_SLICE", `gate "${gate}" is not declared on the contract slice`, `slice.supportedGates[${i}]`);
        }
      });
    }
  }

  const build = input.build;
  if (!isRecord(build) || !isNonEmptyString(build.runId) || !isNonEmptyString(build.builtAt) || !isNonEmptyString(build.implementationSummary)) {
    push("BUILD", "build requires runId, builtAt, and implementationSummary", "build");
  }

  const gateEvidence = isRecord(input.capture) ? input.capture.gateEvidence : undefined;
  if (!isRecord(input.capture) || !isNonEmptyString(input.capture.capturedAt) || !Array.isArray(gateEvidence)) {
    push("CAPTURE", "capture requires capturedAt and gateEvidence[]", "capture");
  } else if (isRecord(slice) && isStringArray(slice.supportedGates)) {
    const evidenceByGate = new Map<string, ExperimentalGateEvidence>();
    gateEvidence.forEach((e, i) => {
      const p = `capture.gateEvidence[${i}]`;
      if (!isRecord(e)) {
        push("GATE_EVIDENCE", "gate evidence row must be an object", p);
        return;
      }
      if (!isNonEmptyString(e.gate)) {
        push("GATE_EVIDENCE_GATE", "gate evidence requires gate", `${p}.gate`);
        return;
      }
      if (e.status !== "pass" && e.status !== "warn" && e.status !== "fail") {
        push("GATE_EVIDENCE_STATUS", "gate evidence status must be pass | warn | fail", `${p}.status`);
      }
      if (!isSafeArtifactPath(e.artifact)) {
        push("GATE_EVIDENCE_ARTIFACT", "gate evidence artifact must be a safe relative path", `${p}.artifact`);
      }
      if (!isNonEmptyString(e.summary)) {
        push("GATE_EVIDENCE_SUMMARY", "gate evidence requires summary", `${p}.summary`);
      }
      evidenceByGate.set(e.gate, e as unknown as ExperimentalGateEvidence);
    });

    slice.supportedGates.forEach((gate, i) => {
      const evidence = evidenceByGate.get(gate);
      if (!evidence) {
        push("MISSING_GATE_EVIDENCE", `missing evidence for supported gate "${gate}"`, `slice.supportedGates[${i}]`);
      } else if (evidence.status !== "pass") {
        push("NON_PASSING_GATE", `supported gate "${gate}" must pass for experimental-green`, `capture.gateEvidence.${gate}.status`);
      }
    });

    const metricEvidence = input.capture.metricEvidence;
    if (metricEvidence !== undefined) {
      if (!Array.isArray(metricEvidence)) {
        push("METRIC_EVIDENCE", "metricEvidence must be an array when present", "capture.metricEvidence");
      } else {
        const measurableTargets = contract ? measurableNowTargets(contract) : new Set<string>();
        metricEvidence.forEach((e, i) => {
          const p = `capture.metricEvidence[${i}]`;
          if (!isRecord(e)) {
            push("METRIC_EVIDENCE", "metric evidence row must be an object", p);
            return;
          }
          if (!isNonEmptyString(e.metric)) {
            push("METRIC_EVIDENCE_METRIC", "metric evidence requires metric", `${p}.metric`);
          } else if (contract && !measurableTargets.has(e.metric)) {
            push("METRIC_EVIDENCE_UNKNOWN_METRIC", "metric evidence metric must match a measurable-now target in the Genre Contract", `${p}.metric`);
          }
          if (e.status !== "pass") {
            push("METRIC_EVIDENCE_STATUS", "metric evidence status must be pass", `${p}.status`);
          }
          const safeArtifact = isSafeArtifactPath(e.artifact);
          if (!safeArtifact) {
            push("METRIC_EVIDENCE_ARTIFACT", "metric evidence artifact must be a safe relative path", `${p}.artifact`);
          }
          if (!isNonEmptyString(e.summary)) {
            push("METRIC_EVIDENCE_SUMMARY", "metric evidence requires summary", `${p}.summary`);
          }

          // Band-enforcement (refuse-don't-skip): a status:pass row is a VERIFIED pass only when its
          // artifact structurally records the derived value AND (if the contract declares a gateBand)
          // the value is within it. Self-reported status alone is never sufficient.
          if (e.status === "pass" && isNonEmptyString(e.metric) && safeArtifact) {
            if (!readArtifact) {
              push("METRIC_EVIDENCE_UNVERIFIED", "metric evidence status:pass requires artifact verification, but no artifact reader was supplied", `${p}.artifact`);
            } else {
              let artifact: unknown;
              try {
                artifact = readArtifact(e.artifact as string);
              } catch {
                artifact = undefined;
              }
              const value = artifactDerivedValue(artifact, e.metric);
              if (value === null) {
                push("METRIC_EVIDENCE_ARTIFACT_VALUE", `metric evidence artifact must record a finite derived value for "${e.metric}" at derived.{metric,value}`, `${p}.artifact`);
              } else {
                const window = numericGateWindow(gateBandForMetric(contract, e.metric));
                if (window && (value < window.min || value > window.max)) {
                  push("METRIC_EVIDENCE_OUT_OF_GATE_BAND", `metric "${e.metric}" derived value ${value} is outside its enforced gateBand [${window.min}, ${window.max}]`, `${p}.artifact`);
                } else {
                  verifiedPassingTargets.add(e.metric);
                }
              }
            }
          }
        });
      }
    }
  }

  if (!Array.isArray(input.methodologyGaps)) {
    push("METHODOLOGY_GAPS", "methodologyGaps must be an array", "methodologyGaps");
  } else {
    const gaps = input.methodologyGaps as ExperimentalMethodologyGap[];
    gaps.forEach((gap, i) => {
      const p = `methodologyGaps[${i}]`;
      if (!isRecord(gap) || !isNonEmptyString(gap.id) || !isNonEmptyString(gap.reason)) {
        push("METHODOLOGY_GAP", "each methodology gap requires id and reason", p);
      }
      if (isRecord(gap) && gap.linkedTargets !== undefined && !isStringArray(gap.linkedTargets)) {
        push("METHODOLOGY_GAP_TARGETS", "linkedTargets must be a string array when present", `${p}.linkedTargets`);
      }
    });

    if (contract && coreSlice) {
      for (const required of collectRequiredGapIds(contract, coreSlice)) {
        if (!gaps.some((gap) => gapCovers(required, gap))) {
          push("UNCOVERED_METHODOLOGY_GAP", `required gap "${required}" is not covered by methodologyGaps`, "methodologyGaps");
        }
      }
      for (const target of measurableNowCoreTargets(contract)) {
        if (!verifiedPassingTargets.has(target) && !gaps.some((gap) => gapCovers(target, gap))) {
          push(
            "MISSING_METRIC_EVIDENCE",
            `measurable-now core target "${target}" requires VERIFIED passing metric evidence (artifact-backed) or an explicit methodology gap`,
            "capture.metricEvidence",
          );
        }
      }
    }
  }

  return { valid: issues.length === 0, issues };
}

export function assertValidExperimentalBuildProof(
  input: unknown,
  opts: ExperimentalProofOptions = {},
): ExperimentalBuildProof {
  const result = validateExperimentalBuildProof(input, opts);
  if (!result.valid) {
    throw new Error(result.issues.map((i) => `${i.code} at ${i.path}: ${i.message}`).join("\n"));
  }
  return input as ExperimentalBuildProof;
}
