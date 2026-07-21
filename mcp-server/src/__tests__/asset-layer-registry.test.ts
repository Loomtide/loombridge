import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../../..");

function readJson<T>(relativePath: string): T {
  const absolutePath = path.join(repoRoot, relativePath);
  return JSON.parse(fs.readFileSync(absolutePath, "utf-8")) as T;
}

interface JsonSchemaObject {
  required?: string[];
  properties?: Record<string, unknown>;
  items?: JsonSchemaObject;
}

interface AssetProfile {
  id: string;
  genre: string;
  primitives: Record<string, { unityFolder: string }>;
  validation: {
    allowedFormats: string[];
    maxDimensions: { width: number; height: number };
    expectedPixelsPerUnit: number;
    requiredProvenanceFields: string[];
    allowedLicenses: string[];
    allowedKinds?: string[];
    licensePolicy?: { allowedSpdx: string[]; deniedSpdx?: string[] };
    sourcePolicy?: { requireVerified?: boolean; minimumProvenanceFields?: string[] };
  };
}

interface AssetRegistry {
  schemaVersion: string;
  packId: string;
  entries: Array<{
    id?: string;
    genre?: string;
    primitive?: string;
    kind?: string;
    placeholder?: boolean;
    source?: {
      title?: string;
      url?: string;
      author?: string;
      verified?: boolean;
      provenance?: Record<string, unknown>;
    };
    license?: { name?: string; spdx?: string; url?: string };
    provider?: { name?: string; url?: string; type?: string };
    files?: Array<{ localPath?: string; url?: string; format?: string; checksum?: { algorithm?: string; value?: string } }>;
    technical?: { width?: number; height?: number; pixelsPerUnit?: number };
    tags?: string[];
    unity?: { path?: string; pixelsPerUnit?: number };
  }>;
}

const requiredEntryFields = [
  "id",
  "genre",
  "primitive",
  "source",
  "license",
  "provider",
  "files",
  "technical",
  "tags",
  "unity",
];

test("asset registry schema declares the MVP entry contract", () => {
  const schema = readJson<JsonSchemaObject>("asset-layer/schemas/asset-registry.schema.json");
  const entrySchema = schema.properties?.entries as JsonSchemaObject | undefined;
  const itemSchema = entrySchema?.items;

  assert.equal((schema.properties as Record<string, unknown> | undefined)?.entries !== undefined, true);
  assert.deepEqual(itemSchema?.required, requiredEntryFields);
});

test("platformer registry entries are unique, licensed, sourced, and profile-compatible", () => {
  const registry = readJson<AssetRegistry>("asset-layer/registry/platformer-2d.json");
  const profile = readJson<AssetProfile>("asset-layer/profiles/2d-platformer.json");
  const knownPrimitives = new Set(Object.keys(profile.primitives));
  const seenIds = new Set<string>();

  assert.equal(registry.schemaVersion, "1");
  assert.equal(registry.packId, "platformer-2d");
  assert.ok(registry.entries.length >= 4, "seed registry should cover player, tile, collectible, and background/decor");

  for (const entry of registry.entries) {
    assert.ok(entry.id, "entry id is required");
    assert.equal(seenIds.has(entry.id), false, `duplicate asset id: ${entry.id}`);
    seenIds.add(entry.id);

    assert.equal(entry.genre, profile.genre, `${entry.id} genre must match profile`);
    assert.ok(entry.primitive && knownPrimitives.has(entry.primitive), `${entry.id} uses unknown primitive`);
    assert.ok(entry.kind, `${entry.id} kind must be explicit`);
    assert.ok(profile.validation.allowedKinds?.includes(entry.kind), `${entry.id} kind is not allowed`);

    assert.ok(entry.source?.title, `${entry.id} missing source title`);
    assert.ok(entry.source?.url?.startsWith("https://"), `${entry.id} missing source url`);
    assert.ok(entry.source?.author, `${entry.id} missing source author`);
    assert.equal(entry.source?.verified, true, `${entry.id} source must be verified`);
    for (const field of profile.validation.requiredProvenanceFields) {
      assert.ok(entry.source?.provenance?.[field], `${entry.id} missing provenance.${field}`);
    }

    assert.ok(entry.license?.name, `${entry.id} missing license name`);
    assert.ok(entry.license?.spdx, `${entry.id} missing license SPDX`);
    assert.ok(profile.validation.allowedLicenses.includes(entry.license.spdx), `${entry.id} license is not allowed`);
    assert.ok(entry.license?.url?.startsWith("https://"), `${entry.id} missing license url`);

    assert.ok(entry.provider?.name, `${entry.id} missing provider name`);
    assert.ok(entry.provider?.url?.startsWith("https://"), `${entry.id} missing provider url`);

    assert.ok(Array.isArray(entry.files) && entry.files.length > 0, `${entry.id} must declare files`);
    for (const file of entry.files) {
      assert.ok(file.localPath ?? file.url, `${entry.id} file must include localPath or url`);
      assert.ok(file.format && profile.validation.allowedFormats.includes(file.format), `${entry.id} unsupported format`);
    }

    if (entry.kind === "sprite") {
      assert.equal(entry.technical?.pixelsPerUnit, profile.validation.expectedPixelsPerUnit);
      assert.ok((entry.technical?.width ?? 0) <= profile.validation.maxDimensions.width, `${entry.id} width too large`);
      assert.ok((entry.technical?.height ?? 0) <= profile.validation.maxDimensions.height, `${entry.id} height too large`);
    }
    assert.ok(Array.isArray(entry.tags) && entry.tags.length > 0, `${entry.id} missing tags`);

    assert.ok(entry.unity?.path?.startsWith("Assets/"), `${entry.id} unity path must stay under Assets/`);
    assert.equal(entry.unity?.pixelsPerUnit, profile.validation.expectedPixelsPerUnit);
  }
});

test("switchyard registry covers non-platformer proof roles with real candidates and fallback placeholders", () => {
  const registry = readJson<AssetRegistry>("asset-layer/registry/switchyard-2d.json");
  const profile = readJson<AssetProfile>("asset-layer/profiles/2d-topdown-arena.json");
  const knownPrimitives = new Set(Object.keys(profile.primitives));
  const seenIds = new Set<string>();

  assert.equal(registry.schemaVersion, "1");
  assert.equal(registry.packId, "switchyard-2d");
  assert.ok(
    registry.entries.some((entry) => entry.placeholder === false),
    "switchyard registry should include at least one real curated candidate above placeholders",
  );
  assert.ok(
    registry.entries.some((entry) => entry.placeholder === true),
    "switchyard registry should keep explicit fallback placeholders",
  );

  const primitives = new Set(registry.entries.map((entry) => entry.primitive));
  const requiredPrimitives = [
    "player",
    "battery",
    "terminal",
    "arena",
    "hazard",
    "vfx",
    "sfx_pickup",
    "sfx_deposit",
    "sfx_dodge",
    "sfx_hit",
    "sfx_win",
    "sfx_lose",
  ];
  for (const required of requiredPrimitives) {
    assert.ok(primitives.has(required), `switchyard registry should cover ${required}`);
    assert.ok(
      registry.entries.some((entry) => entry.primitive === required && entry.placeholder === false),
      `switchyard registry should include a real curated candidate for ${required}`,
    );
  }

  for (const entry of registry.entries) {
    assert.ok(entry.id, "entry id is required");
    assert.equal(seenIds.has(entry.id), false, `duplicate asset id: ${entry.id}`);
    seenIds.add(entry.id);
    assert.equal(entry.genre, profile.genre, `${entry.id} genre must match profile`);
    assert.ok(entry.primitive && knownPrimitives.has(entry.primitive), `${entry.id} uses unknown primitive`);
    assert.equal(entry.source?.verified, true, `${entry.id} source must be verified`);
    assert.equal(entry.license?.spdx, "CC0-1.0", `${entry.id} must be CC0 for clean-room fallback use`);
    if (entry.placeholder === true) {
      assert.ok(entry.tags?.includes("placeholder"), `${entry.id} should be visibly marked as a placeholder seed`);
    } else {
      assert.equal(entry.tags?.includes("placeholder"), false, `${entry.id} real candidates must not be tagged placeholder`);
    }
    assert.ok(entry.files?.length, `${entry.id} must declare files`);
    for (const file of entry.files ?? []) {
      if (file.localPath) {
        assert.ok(fs.existsSync(path.join(repoRoot, file.localPath)), `${entry.id} local fixture missing: ${file.localPath}`);
      }
    }
  }
});

test("asset registry schema admits model/glb parity (kind + file role/format enums)", () => {
  const schema = readJson<Record<string, unknown>>("asset-layer/schemas/asset-registry.schema.json");
  const itemSchema = (((schema.properties as Record<string, JsonSchemaObject>).entries).items) as JsonSchemaObject;
  const props = itemSchema.properties as Record<string, { enum?: string[] }>;
  assert.ok(props.kind?.enum?.includes("model"), "kind enum should admit model");

  const fileItem = (props.files as unknown as JsonSchemaObject).items?.properties as Record<string, { enum?: string[] }>;
  assert.ok(fileItem.role?.enum?.includes("model"), "file role enum should admit model");
  assert.ok(fileItem.format?.enum?.includes("glb"), "file format enum should admit glb");
});

test("3d-shooter registry seed declares source-bound models, glb files, and honest placeholders", () => {
  const registry = readJson<AssetRegistry>("asset-layer/registry/3d-shooter.json");
  const profile = readJson<AssetProfile>("asset-layer/profiles/3d-shooter.json");
  const knownPrimitives = new Set(Object.keys(profile.primitives));
  const seenIds = new Set<string>();

  assert.equal(registry.schemaVersion, "1");
  assert.equal(registry.packId, "3d-shooter");
  assert.equal(profile.genre, "3d-shooter");

  // Every required vertical primitive has at least one REAL (non-placeholder) curated candidate.
  const requiredPrimitives = ["player_model", "enemy_model", "arena", "cover_prop", "weapon_model", "projectile", "reticle", "vfx"];
  for (const primitive of requiredPrimitives) {
    assert.ok(
      registry.entries.some((entry) => entry.primitive === primitive && entry.placeholder === false),
      `3d-shooter registry should include a real candidate for ${primitive}`,
    );
  }
  // Honest primitive fallbacks are kept, explicitly placeholder + tagged.
  assert.ok(registry.entries.some((entry) => entry.placeholder === true), "should keep explicit fallback placeholders");

  for (const entry of registry.entries) {
    assert.ok(entry.id, "entry id is required");
    assert.equal(seenIds.has(entry.id!), false, `duplicate asset id: ${entry.id}`);
    seenIds.add(entry.id!);
    assert.equal(entry.genre, profile.genre, `${entry.id} genre must match profile`);
    assert.ok(entry.primitive && knownPrimitives.has(entry.primitive), `${entry.id} uses unknown primitive`);
    assert.ok(entry.kind, `${entry.id} kind must be explicit`);
    assert.ok(profile.validation.allowedKinds?.includes(entry.kind!), `${entry.id} kind is not allowed`);
    assert.equal(entry.source?.verified, true, `${entry.id} source must be verified`);
    assert.equal(entry.license?.spdx, "CC0-1.0", `${entry.id} must be CC0`);
    assert.ok(profile.validation.allowedLicenses.includes(entry.license!.spdx!), `${entry.id} license not allowed`);
    assert.ok(entry.files?.length, `${entry.id} must declare files`);
    for (const file of entry.files ?? []) {
      assert.ok(file.format && profile.validation.allowedFormats.includes(file.format), `${entry.id} unsupported file format`);
    }
    if (entry.kind === "model") {
      assert.ok(entry.files?.every((file) => file.format === "glb"), `${entry.id} model files must be glb`);
      assert.ok(entry.unity?.path?.startsWith("Assets/Models/"), `${entry.id} model path must be under Assets/Models/`);
    }
    if (entry.placeholder === true) {
      assert.ok(entry.tags?.includes("placeholder"), `${entry.id} should be visibly tagged placeholder`);
    }
    assert.ok(entry.unity?.path?.startsWith("Assets/"), `${entry.id} unity path must stay under Assets/`);
  }
});

test("asset-layer skill guidance documents primitive placement and provenance", () => {
  const skill = fs.readFileSync(path.join(repoRoot, ".skills/asset-layer/SKILL.md"), "utf-8");
  const platformer = fs.readFileSync(path.join(repoRoot, ".skills/asset-layer/references/2d-platformer.md"), "utf-8");
  const topdown = fs.readFileSync(path.join(repoRoot, ".skills/asset-layer/references/2d-topdown-arena.md"), "utf-8");

  assert.match(skill, /asset layer/i);
  assert.match(skill, /registry/i);
  assert.match(skill, /validation/i);
  assert.match(skill, /prepare-project-assets\.sh/i);
  assert.match(platformer, /Assets\/Art/i);
  assert.match(platformer, /license/i);
  assert.match(platformer, /provenance/i);
  assert.match(topdown, /2d-topdown-arena/i);
  assert.match(topdown, /switchyard-2d\.json/i);
  assert.match(topdown, /placeholder:false/i);
});
