import {
  ASSET_SOURCE_TYPES,
  validateAssetManifest,
  type AssetManifest,
  type AssetSourceType,
} from "../../assets/asset-manifest.js";
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
  /**
   * TRUE when the input was the project's STAGED DECLARATION (`.loombridge/ASSET_MANIFEST.json`,
   * which `verify` copies into the inputs dir itself) rather than a CAPTURE of what the build
   * used (D2). Set by `run-gates.ts` from the shape of the bytes on disk, never by the document.
   * FAIL-CLOSED default `false`: an input that does not say otherwise is held to the manifest's
   * own denominator, one observation per declared asset.
   */
  stagedDocument?: boolean;
}

function manifestCandidate(input: unknown): unknown {
  if (input && typeof input === "object" && "manifest" in input) {
    return (input as { manifest?: unknown }).manifest;
  }
  return input;
}

/**
 * Is this input a CAPTURE of what the build used, or the project's staged DECLARATION? (D2)
 *
 * FAIL-CLOSED: absent means CAPTURE, so the observation obligation applies unless something
 * explicitly says the input was the staged document. The flag cannot be self-declared from
 * inside the file: `run-gates.ts` derives it from the SHAPE of the bytes it read (bare document
 * vs `{ manifest, observedAssets }` wrapper) and injects it at the wrapper level AFTER spreading
 * the input, exactly as `artDeferred` is derived from the on-disk contract rather than trusted
 * from the staged input. Reading the shape here instead is not available: run-gates normalises
 * the bare document INTO the wrapper before this gate sees it, so by this point both shapes look
 * identical, and keying off "does the `observedAssets` key exist" would be the skip-on-absent
 * anti-pattern one field over (delete the key, become a declaration, owe nothing).
 */
function isCaptureInput(input: unknown): boolean {
  return !(input && typeof input === "object" && (input as AssetSourceFidelityInput).stagedDocument === true);
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
  // THE DENOMINATOR FOR THE OBSERVATION WALK (D2). A CAPTURE owes one observation per declared
  // manifest asset; a BARE staged declaration owes none (see `isCaptureInput`). Without this,
  // D's fix converted "delete a field" into "delete a list entry", which is cheaper: the drift
  // row was unconditional on the observation EXISTING but still conditional on the observation
  // existing at all, so dropping the entry (or the whole array) took a failing gate back to
  // `pass` AND kept it in `gradedGates`.
  const isCapture = isCaptureInput(input);

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

    // The observation row, with the DENOMINATOR RULE on the "not observed" case (D2). A CAPTURE
    // that does not observe a declared asset is a shrunken denominator: the expected set is
    // recomputable as `manifest.assets`, by this same reader, so a smaller observed list is not a
    // smaller obligation. A BARE staged declaration observes nothing by construction and keeps
    // the old pass, which is the whole of the carve-out's own argument (the marker in
    // `run-gates.ts` is what keeps that copy out of `gradedGates`).
    const matched = !!observed && observed.source === asset.source && samePaths(expectedPaths, observed.paths);
    checks.push({
      id: `asset-source.observed.${asset.id}`,
      expected: `${asset.source} ${expectedPaths.join(",")}`,
      actual: describeObserved(observed),
      status: matched ? "pass" : !observed && !isCapture ? "pass" : "fail",
      detail: !observed
        ? isCapture
          ? `This capture observed no use of '${asset.id}', which the approved manifest declares. A capture that ` +
            "observed fewer assets than the manifest declares has a shrunken denominator, not a smaller " +
            "obligation: re-capture asset usage for every declared asset, or re-approve a manifest that no " +
            "longer declares this one."
          : `No observed asset-use capture for '${asset.id}'; manifest binding remains the source of truth.`
        : matched
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
      // REFUSE-NOT-SKIP on the bound field. This was the literal house anti-pattern:
      // `if (observed?.registryAssetId && manifest !== observed.registryAssetId)`, where a
      // FALSY `registryAssetId` skipped the binding entirely. Demonstrated on the real
      // `runGates` path with one registry-bound manifest and three observation records:
      //
      //   honest observation                  -> gate pass, no failures
      //   observed.registryAssetId = other id -> gate FAIL, asset-source.registry-drift.<id>
      //   the SAME record, field OMITTED      -> gate pass, no failures
      //
      // Omitting the field certified where declaring it refused, and nothing else covers it:
      // `asset-source.observed.<id>` compares only `source` and `paths`.
      //
      // The row is emitted whenever an observation EXISTS, pass or fail, so the comparison is
      // COUNTED rather than conditionally present (the PR #88 rule). It is NOT emitted when
      // there is no observation for this asset: `verify` stages the BARE
      // `.loombridge/ASSET_MANIFEST.json` into the inputs dir itself, that copy carries no
      // observations at all by construction, and failing it would manufacture a tier-1 game
      // defect out of a harness gap. That path is already handled honestly by the
      // staged-document marker, which keeps it out of `gradedGates`.
      if (observed) {
        const bound = asset.registrySelection?.registryAssetId;
        const matches = !!observed.registryAssetId && bound === observed.registryAssetId;
        checks.push({
          id: `asset-source.registry-drift.${asset.id}`,
          expected: bound ?? "(manifest missing)",
          actual: observed.registryAssetId ?? "(absent)",
          status: matches ? "pass" : "fail",
          detail: matches
            ? `Observed registry asset id matches the approved manifest binding.`
            : observed.registryAssetId
              ? `Observed registry asset id does not match the approved manifest binding.`
              : `Observed asset use for '${asset.id}' states no registryAssetId, so it cannot be bound to the approved registry selection. Refusing rather than skipping the comparison.`,
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
      // Same refuse-not-skip rule as the registry branch above, for the same reason.
      if (observed) {
        const bound = asset.generatedExport?.generatedSetId;
        const matches = !!observed.generatedSetId && bound === observed.generatedSetId;
        checks.push({
          id: `asset-source.generated-drift.${asset.id}`,
          expected: bound ?? "(manifest missing)",
          actual: observed.generatedSetId ?? "(absent)",
          status: matches ? "pass" : "fail",
          detail: matches
            ? `Observed generated set id matches the approved manifest binding.`
            : observed.generatedSetId
              ? `Observed generated set id does not match the approved manifest binding.`
              : `Observed asset use for '${asset.id}' states no generatedSetId, so it cannot be bound to the approved generated export. Refusing rather than skipping the comparison.`,
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

  // AND THE REVERSE WALK, which is what makes `manifest.assets` a DENOMINATOR rather than a
  // filter (D2). Walking only manifest -> observations meant an observation of something the
  // approved manifest never declared had nothing to disagree with: the capture could report using
  // an asset nobody approved and the gate would never look at it. Scoped to a CAPTURE for the same
  // reason the forward walk is: a bare declaration has no observations to walk.
  if (isCapture) {
    const declaredIds = new Set(manifest.assets.map((asset) => asset.id));
    for (const [id] of observedById) {
      if (declaredIds.has(id)) continue;
      checks.push({
        id: `asset-source.observed-undeclared.${id}`,
        expected: "an asset id the approved ASSET_MANIFEST.json declares",
        actual: id,
        status: "fail",
        detail:
          `This capture observed use of '${id}', which the approved manifest does not declare. An asset the ` +
          "build used and nobody approved is exactly what this gate exists to find: add it to the manifest and " +
          "re-approve, or stop using it.",
      });
    }
  }

  return makeGateReport(GATE_NAME, checks);
}
