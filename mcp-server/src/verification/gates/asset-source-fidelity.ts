import {
  ASSET_SOURCE_TYPES,
  validateAssetManifest,
  type AssetManifest,
  type AssetSourceType,
} from "../../loombridge/asset-manifest.js";
import { makeGateReport, type GateCheck, type GateReport } from "./types.js";

export const GATE_NAME = "asset-source-fidelity";

export interface ObservedAssetUse {
  assetId: string;
  source?: AssetSourceType;
  paths?: string[];
  registryAssetId?: string;
  generatedSetId?: string;
}

export interface AssetSourceFidelityInput {
  manifest?: AssetManifest;
  observedAssets?: ObservedAssetUse[];
  /**
   * Gray-box / feel-only posture (RCL-D02). FAIL-CLOSED default `false`: a
   * `primitiveFinal` role only passes the gate by design (and only validates as
   * an unprovenanced approved asset) when the on-disk acceptance contract
   * declares `art.mode:"deferred"`. Under art:final, `primitiveFinal` is inert —
   * the role is held to the SAME real-asset checks as any other, so a normal
   * build cannot self-declare it to skip asset-source fidelity.
   */
  artDeferred?: boolean;
}

function manifestCandidate(input: unknown): unknown {
  if (input && typeof input === "object" && "manifest" in input) {
    return (input as { manifest?: unknown }).manifest;
  }
  return input;
}

function asManifest(input: unknown, artDeferred: boolean): AssetManifest | null {
  const candidate = manifestCandidate(input);
  const result = validateAssetManifest(candidate, { artDeferred });
  return result.valid ? candidate as AssetManifest : null;
}

function manifestIssues(input: unknown, artDeferred: boolean): string[] {
  const candidate = manifestCandidate(input);
  return validateAssetManifest(candidate, { artDeferred }).issues.map((issue) => `[${issue.code}] ${issue.path}: ${issue.message}`);
}

function samePaths(expected: string[], actual: string[] | undefined): boolean {
  if (!actual) return false;
  if (expected.length !== actual.length) return false;
  const left = [...expected].sort((a, b) => a.localeCompare(b));
  const right = [...actual].sort((a, b) => a.localeCompare(b));
  return left.every((value, i) => value === right[i]);
}

function describeObserved(observed: ObservedAssetUse | undefined): string {
  if (!observed) return "(not observed)";
  return [
    observed.source ? `source=${observed.source}` : "source=(absent)",
    observed.paths?.length ? `paths=${observed.paths.join(",")}` : "paths=(absent)",
    observed.registryAssetId ? `registryAssetId=${observed.registryAssetId}` : "",
    observed.generatedSetId ? `generatedSetId=${observed.generatedSetId}` : "",
  ].filter(Boolean).join(" ");
}

export function evaluateAssetSourceFidelity(input: AssetSourceFidelityInput | unknown): GateReport {
  const artDeferred = !!(input && typeof input === "object" && (input as AssetSourceFidelityInput).artDeferred === true);
  const manifest = asManifest(input, artDeferred);
  if (!manifest) {
    return makeGateReport(GATE_NAME, [{
      id: "asset-source.manifest-valid",
      expected: "valid approved ASSET_MANIFEST.json snapshot",
      actual: "invalid or missing",
      status: "fail",
      detail: `Asset manifest snapshot is invalid: ${manifestIssues(input, artDeferred).join("; ")}`,
    }]);
  }

  const checks: GateCheck[] = [];
  checks.push({
    id: "asset-source.manifest-approved",
    expected: "ASSET_MANIFEST.json status approved",
    actual: manifest.status,
    status: manifest.status === "approved" ? "pass" : "fail",
    detail: manifest.status === "approved"
      ? "Asset manifest is approved."
      : "Asset manifest is not approved; source fidelity cannot be certified.",
  });

  const approvedSources = new Set(manifest.assetSources.filter((source) => source.approved).map((source) => source.id));
  const observedById = new Map(
    ((input as AssetSourceFidelityInput).observedAssets ?? []).map((asset) => [asset.assetId, asset]),
  );

  for (const source of manifest.assetSources) {
    checks.push({
      id: `asset-source.source-approved.${source.id}`,
      expected: "asset source approved",
      actual: source.approved ? "approved" : "unapproved",
      status: source.approved ? "pass" : "fail",
      detail: source.approved
        ? `Asset source '${source.id}' is approved.`
        : `Asset source '${source.id}' is unapproved and cannot be consumed by slices.`,
    });
  }

  for (const asset of manifest.assets) {
    const observed = observedById.get(asset.id);

    // Gray-box / feel-only (RCL-D02): the engine primitive IS the intended final
    // deliverable for this role. It passes the binding gate by design — no
    // resolved file paths or registry/generated provenance are expected — and the
    // provenance/observed sub-checks below are N/A. This waiver applies ONLY when
    // the on-disk contract declares `art.mode:"deferred"` (`artDeferred`):
    // fail-closed under art:final, where `primitiveFinal` is inert and the role
    // falls through to the unchanged real-asset checks (so a normal build cannot
    // self-declare primitive-final to skip asset-source fidelity). A role NOT
    // marked `primitiveFinal` also falls through.
    if (asset.primitiveFinal === true && artDeferred) {
      checks.push({
        id: `asset-source.binding.${asset.id}`,
        expected: "primitive is the intended final deliverable (primitive-final)",
        actual: `primitiveFinal status=${asset.status}`,
        status: "pass",
        detail: `Manifest asset '${asset.id}' is declared primitive-final (gray-box): the engine primitive is the intended deliverable, not a registry-missing gap.`,
      });
      continue;
    }

    const expectedPaths = asset.resolvedPaths ?? [];
    const sourceIdApproved = !asset.sourceId || approvedSources.has(asset.sourceId);
    checks.push({
      id: `asset-source.binding.${asset.id}`,
      expected: `${asset.source} asset with approved source and resolved paths`,
      actual: `${asset.status}${asset.sourceId ? ` sourceId=${asset.sourceId}` : ""}`,
      status: asset.status === "approved" && expectedPaths.length > 0 && sourceIdApproved ? "pass" : "fail",
      detail: asset.status === "approved" && expectedPaths.length > 0 && sourceIdApproved
        ? `Manifest asset '${asset.id}' is approved and path-bound.`
        : `Manifest asset '${asset.id}' is not an approved path-bound asset.`,
    });

    checks.push({
      id: `asset-source.observed.${asset.id}`,
      expected: `${asset.source} ${expectedPaths.join(",")}`,
      actual: describeObserved(observed),
      status: !observed || (
        observed.source === asset.source &&
        samePaths(expectedPaths, observed.paths)
      ) ? "pass" : "fail",
      detail: !observed
        ? `No observed asset-use capture for '${asset.id}'; manifest binding remains the source of truth.`
        : observed.source === asset.source && samePaths(expectedPaths, observed.paths)
          ? `Observed use of '${asset.id}' matches the manifest source and paths.`
          : `Observed use of '${asset.id}' differs from the manifest source or paths.`,
    });

    if (asset.source === "registry") {
      checks.push({
        id: `asset-source.registry-provenance.${asset.id}`,
        expected: "registrySelection with source/license/provenance",
        actual: asset.registrySelection?.registryAssetId ?? "(missing)",
        status: asset.registrySelection ? "pass" : "fail",
        detail: asset.registrySelection
          ? `Registry asset '${asset.id}' is bound to '${asset.registrySelection.registryAssetId}'.`
          : `Registry asset '${asset.id}' is missing registrySelection provenance.`,
      });
      if (observed?.registryAssetId && asset.registrySelection?.registryAssetId !== observed.registryAssetId) {
        checks.push({
          id: `asset-source.registry-drift.${asset.id}`,
          expected: asset.registrySelection?.registryAssetId ?? "(manifest missing)",
          actual: observed.registryAssetId,
          status: "fail",
          detail: `Observed registry asset id does not match the approved manifest binding.`,
        });
      }
    } else if (asset.source === "generated") {
      checks.push({
        id: `asset-source.generated-provenance.${asset.id}`,
        expected: "generatedExport with generator/source hash/provenance",
        actual: asset.generatedExport?.generatedSetId ?? "(missing)",
        status: asset.generatedExport ? "pass" : "fail",
        detail: asset.generatedExport
          ? `Generated asset '${asset.id}' is bound to generated set '${asset.generatedExport.generatedSetId}'.`
          : `Generated asset '${asset.id}' is missing generatedExport provenance.`,
      });
      if (observed?.generatedSetId && asset.generatedExport?.generatedSetId !== observed.generatedSetId) {
        checks.push({
          id: `asset-source.generated-drift.${asset.id}`,
          expected: asset.generatedExport?.generatedSetId ?? "(manifest missing)",
          actual: observed.generatedSetId,
          status: "fail",
          detail: `Observed generated set id does not match the approved manifest binding.`,
        });
      }
    } else if (!ASSET_SOURCE_TYPES.has(asset.source)) {
      checks.push({
        id: `asset-source.unknown-source.${asset.id}`,
        expected: "generated|registry|manual",
        actual: asset.source,
        status: "fail",
        detail: `Asset '${asset.id}' uses an unknown source mode.`,
      });
    }
  }

  return makeGateReport(GATE_NAME, checks);
}
