import {
  REQUIRED_ASSET_ROLES,
  assertValidAssetManifest,
  type AssetManifest,
  type HeroRegion,
  type ManifestGeneratedExport,
  type RequiredAssetRole,
} from "../loombridge/asset-manifest.js";
import { createHash } from "node:crypto";

export interface GeneratedAssetAnnotation {
  annotationId: string;
  role: RequiredAssetRole;
  heroRegion?: HeroRegion;
  requiredOutputs?: string[];
  prompt?: string;
  styleLock?: string;
}

export interface GeneratedAssetSlot {
  assetId: string;
  role: RequiredAssetRole;
  annotationId: string;
  requiredOutputs: string[];
  heroRegion?: HeroRegion;
  prompt?: string;
  styleLock: string;
}

export interface GeneratedAssetIssue {
  code: "NO_GENERATED_SOURCE" | "MISSING_ANNOTATION" | "DUPLICATE_ANNOTATION" | "UNKNOWN_ROLE";
  role?: string;
  assetId?: string;
  message: string;
}

export interface GeneratedAssetPlan {
  producedFromHash: string;
  generatedSetId: string;
  slots: GeneratedAssetSlot[];
  issues: GeneratedAssetIssue[];
}

export interface GeneratedAssetExportInput {
  assetId: string;
  paths: string[];
  generator: string;
  producedAt: string;
  license: string;
  provenance: ManifestGeneratedExport["provenance"];
}

export interface GeneratedAssetProviderCacheInput {
  provider: string;
  model?: string;
  sourceImageSha256: string;
  promptSha256?: string;
  parameters?: Record<string, string | number | boolean | null | undefined>;
}

export interface ApplyGeneratedAssetExportsArgs {
  manifest: AssetManifest;
  annotations: GeneratedAssetAnnotation[];
  exports: GeneratedAssetExportInput[];
  producedFromHash: string;
  generatedSetId?: string;
  approvedAt: string;
}

export interface SliceGeneratedAssetBinding {
  sliceId: string;
  assets: Array<{
    assetId: string;
    role: string;
    paths: string[];
    generatedSetId: string;
    provenance: ManifestGeneratedExport["provenance"];
  }>;
}

const SAFE_PATH_RE = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\\)(?!.*(?:^|\/)\.(?:\/|$))(?!.*\/\/).+$/;
const SECRET_KEY_RE = /(?:api[_-]?key|token|secret|authorization|bearer|password|credential)/i;
const SECRET_VALUE_RE = /\b(?:sk-[A-Za-z0-9_-]{16,}|[A-Za-z0-9_-]{32,}\.[A-Za-z0-9_-]{16,}|(?=[A-Za-z0-9_-]*[a-z])(?=[A-Za-z0-9_-]*[A-Z])(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{48,})\b/;
const REDACT_SECRET_VALUE_RE = new RegExp(SECRET_VALUE_RE.source, "g");

export function redactGeneratedAssetSecrets<T>(value: T): T {
  return redactValue(value) as T;
}

function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = SECRET_KEY_RE.test(key) ? "[REDACTED]" : redactValue(entry);
    }
    return out;
  }
  if (typeof value === "string") return value.replace(REDACT_SECRET_VALUE_RE, "[REDACTED]");
  return value;
}

function assertNoGeneratedAssetSecrets(value: unknown, path = "generatedExport"): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoGeneratedAssetSecrets(entry, `${path}[${index}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      if (SECRET_KEY_RE.test(key)) {
        throw new Error(`Generated asset provenance must not include secret field '${path}.${key}'. Use an environment variable or ignored local secret file.`);
      }
      assertNoGeneratedAssetSecrets(entry, `${path}.${key}`);
    }
    return;
  }
  if (typeof value === "string" && SECRET_VALUE_RE.test(value)) {
    throw new Error(`Generated asset provenance appears to contain a secret at '${path}'. Redact credentials before applying exports.`);
  }
}

export function generatedAssetCacheKey(input: GeneratedAssetProviderCacheInput): string {
  const normalized = {
    provider: input.provider,
    model: input.model ?? "",
    sourceImageSha256: input.sourceImageSha256,
    promptSha256: input.promptSha256 ?? "",
    parameters: Object.fromEntries(
      Object.entries(input.parameters ?? {})
        .filter(([, value]) => value !== undefined)
        .sort(([a], [b]) => a.localeCompare(b)),
    ),
  };
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

function annotationByRole(annotations: GeneratedAssetAnnotation[]): {
  byRole: Map<RequiredAssetRole, GeneratedAssetAnnotation>;
  issues: GeneratedAssetIssue[];
} {
  const byRole = new Map<RequiredAssetRole, GeneratedAssetAnnotation>();
  const issues: GeneratedAssetIssue[] = [];
  for (const annotation of annotations) {
    if (!REQUIRED_ASSET_ROLES.includes(annotation.role)) {
      issues.push({
        code: "UNKNOWN_ROLE",
        role: annotation.role,
        message: `Unknown generated asset annotation role '${annotation.role}'.`,
      });
      continue;
    }
    if (byRole.has(annotation.role)) {
      issues.push({
        code: "DUPLICATE_ANNOTATION",
        role: annotation.role,
        message: `Generated asset role '${annotation.role}' has more than one annotation.`,
      });
      continue;
    }
    byRole.set(annotation.role, annotation);
  }
  return { byRole, issues };
}

function sourceIdForGenerated(manifest: AssetManifest, generatedSetId?: string): string | null {
  return generatedSetId ?? manifest.assetSources.find((source) => source.kind === "generated-set")?.id ?? null;
}

function defaultRequiredOutputs(role: RequiredAssetRole): string[] {
  if (role === "platform-tiles" || role === "one-way-platform") return ["tileset"];
  if (role === "parallax-background") return ["back", "middle", "front"];
  return ["main"];
}

function safePaths(paths: string[]): boolean {
  return paths.length > 0 && paths.every((p) => typeof p === "string" && SAFE_PATH_RE.test(p));
}

export function buildGeneratedAssetPlan(
  manifest: AssetManifest,
  annotations: GeneratedAssetAnnotation[],
  options: { producedFromHash?: string; generatedSetId?: string } = {},
): GeneratedAssetPlan {
  const generatedSetId = sourceIdForGenerated(manifest, options.generatedSetId);
  const { byRole, issues } = annotationByRole(annotations);
  if (!generatedSetId) {
    for (const asset of manifest.assets.filter((candidate) => candidate.source === "generated")) {
      issues.push({
        code: "NO_GENERATED_SOURCE",
        role: asset.role,
        assetId: asset.id,
        message: `Asset '${asset.id}' requests generated source but manifest has no generated-set assetSource.`,
      });
    }
  }

  const slots: GeneratedAssetSlot[] = [];
  for (const asset of manifest.assets.filter((candidate) => candidate.source === "generated")) {
    const role = asset.role as RequiredAssetRole;
    const annotation = byRole.get(role);
    if (!annotation) {
      issues.push({
        code: "MISSING_ANNOTATION",
        role,
        assetId: asset.id,
        message: `Generated asset role '${role}' must be backed by a hero-shot annotation.`,
      });
      continue;
    }
    const requiredOutputs = annotation.requiredOutputs?.length ? annotation.requiredOutputs : asset.requiredOutputs.length ? asset.requiredOutputs : defaultRequiredOutputs(role);
    slots.push({
      assetId: asset.id,
      role,
      annotationId: annotation.annotationId,
      requiredOutputs,
      ...(annotation.heroRegion ? { heroRegion: annotation.heroRegion } : {}),
      ...(annotation.prompt ? { prompt: annotation.prompt } : {}),
      styleLock: annotation.styleLock ?? asset.styleLock ?? `must match approved hero shot role '${role}'`,
    });
  }

  return {
    producedFromHash: options.producedFromHash ?? manifest.heroShot.sha256,
    generatedSetId: generatedSetId ?? "generated_set_needed",
    slots,
    issues,
  };
}

export function applyGeneratedAssetExportsToManifest(args: ApplyGeneratedAssetExportsArgs): AssetManifest {
  if (!args.approvedAt) {
    throw new Error("approvedAt is required when approving generated asset exports.");
  }
  const generatedSetId = sourceIdForGenerated(args.manifest, args.generatedSetId);
  if (!generatedSetId) {
    throw new Error("Cannot apply generated exports: manifest has no generated-set assetSource.");
  }

  const plan = buildGeneratedAssetPlan(args.manifest, args.annotations, {
    producedFromHash: args.producedFromHash,
    generatedSetId,
  });
  if (plan.issues.length > 0) {
    throw new Error(`Cannot apply generated exports: ${plan.issues.map((issue) => issue.message).join("; ")}`);
  }

  const exportsByAsset = new Map(args.exports.map((entry) => [entry.assetId, entry]));
  for (const slot of plan.slots) {
    const exported = exportsByAsset.get(slot.assetId);
    if (!exported) {
      throw new Error(`Missing generated export for asset '${slot.assetId}'.`);
    }
    if (!safePaths(exported.paths)) {
      throw new Error(`Generated export for asset '${slot.assetId}' must use safe relative paths.`);
    }
    if (!exported.provenance?.origin) {
      throw new Error(`Generated export for asset '${slot.assetId}' must include provenance.origin.`);
    }
    assertNoGeneratedAssetSecrets(exported.provenance, `exports.${slot.assetId}.provenance`);
  }

  const assets = args.manifest.assets.map((asset) => {
    const slot = plan.slots.find((candidate) => candidate.assetId === asset.id);
    if (!slot) return asset;
    const exported = exportsByAsset.get(asset.id)!;
    return {
      ...asset,
      source: "generated" as const,
      sourceId: generatedSetId,
      status: "approved" as const,
      heroRegion: slot.heroRegion ?? asset.heroRegion,
      requiredOutputs: slot.requiredOutputs,
      resolvedPaths: exported.paths,
      styleLock: slot.styleLock,
      generatedExport: {
        generatedSetId,
        generator: exported.generator,
        sourceImageSha256: args.producedFromHash,
        producedAt: exported.producedAt,
        license: exported.license,
        provenance: {
          annotationId: slot.annotationId,
          prompt: slot.prompt,
          ...redactGeneratedAssetSecrets(exported.provenance),
        },
      },
    };
  });

  const assetSources = args.manifest.assetSources
    .filter((source) => source.id !== generatedSetId)
    .concat({
      id: generatedSetId,
      kind: "generated-set" as const,
      license: args.exports[0]?.license ?? "project-generated",
      approved: true,
    })
    .sort((a, b) => a.id.localeCompare(b.id));
  const readyForApproval = assets.every((asset) => asset.status !== "needed");

  return assertValidAssetManifest({
    ...args.manifest,
    status: readyForApproval ? "approved" : "draft",
    approvedAt: readyForApproval ? args.approvedAt : args.manifest.approvedAt ?? null,
    assetSources,
    assets,
  });
}

export function resolveGeneratedAssetsForSlices(manifest: AssetManifest): SliceGeneratedAssetBinding[] {
  assertValidAssetManifest(manifest);
  return manifest.sliceBindings.map((binding) => ({
    sliceId: binding.sliceId,
    assets: binding.assetIds.flatMap((assetId) => {
      const asset = manifest.assets.find((candidate) => candidate.id === assetId);
      if (!asset || asset.source !== "generated") return [];
      if (!asset.generatedExport || !asset.resolvedPaths?.length) {
        throw new Error(`Slice '${binding.sliceId}' references generated asset '${assetId}' without approved generated export paths.`);
      }
      return [{
        assetId,
        role: asset.role,
        paths: asset.resolvedPaths,
        generatedSetId: asset.generatedExport.generatedSetId,
        provenance: { ...asset.generatedExport.provenance },
      }];
    }),
  }));
}
