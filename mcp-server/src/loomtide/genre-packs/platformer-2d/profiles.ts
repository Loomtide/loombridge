/**
 * Shipped platformer profile loader (S5a).
 *
 * The three product-owned profiles (`precision` / `classic` / `momentum`) live as
 * JSON next to this module under `profiles/`. `tsc` does not copy `.json` into
 * `dist/`, so — like `plan.ts` does for the genre template — we resolve the source
 * tree at runtime via `import.meta.url` and read + validate the files there.
 *
 * Every load goes through `assertValidPlatformerProfile`, so a malformed shipped
 * profile throws at load time rather than reaching a verify run.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { assertValidPlatformerProfile } from "./validator.js";
import type { PlatformerFeelProfile } from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// __dirname is dist/loomtide/genre-packs/platformer-2d at runtime; the JSON lives in the
// source tree (not copied by tsc), so resolve to the package root and read src/.
const PKG_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const PROFILES_DIR = path.join(
  PKG_ROOT,
  "src",
  "loomtide",
  "genre-packs",
  "platformer-2d",
  "profiles",
);

/** The ids of the profiles this product ships, in display order. */
export const SHIPPED_PROFILE_IDS = ["precision", "classic", "momentum"] as const;

export type ShippedProfileId = (typeof SHIPPED_PROFILE_IDS)[number];

function profilePath(id: string): string {
  return path.join(PROFILES_DIR, `${id}.profile.json`);
}

/** Load and validate a single shipped profile by id. Throws if absent or invalid. */
export async function loadProfile(id: string): Promise<PlatformerFeelProfile> {
  let raw: string;
  try {
    raw = await fs.readFile(profilePath(id), "utf-8");
  } catch {
    throw new Error(
      `Unknown platformer profile '${id}'. Shipped profiles: ${SHIPPED_PROFILE_IDS.join(", ")}.`,
    );
  }
  const parsed: unknown = JSON.parse(raw);
  const profile = assertValidPlatformerProfile(parsed);
  if (profile.id !== id) {
    throw new Error(
      `Profile file ${id}.profile.json declares mismatched id '${profile.id}'.`,
    );
  }
  return profile;
}

/** Load and validate all shipped profiles, in display order. */
export async function loadAllProfiles(): Promise<PlatformerFeelProfile[]> {
  return Promise.all(SHIPPED_PROFILE_IDS.map((id) => loadProfile(id)));
}
