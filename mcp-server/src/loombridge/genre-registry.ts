/**
 * Genre pack registry — the typed indirection that lets the deterministic pipeline core resolve a
 * genre's bindings without hard-coding a single genre.
 *
 * Phase 1b of genre-pack decoupling. `plan` knew exactly one genre (platformer-2d) via hard-coded
 * dicts (`GENRE_TEMPLATES` / `SLICE_TEMPLATES`); this module is the single source of truth it now
 * resolves through. The registry grows one binding at a time as each genre-coupled site is re-pointed:
 * `doneness` hero-shot fidelity, the `plan` default genre, and the verify-first feel-profile entry now
 * resolve here (the verification-layer scenario packs + gate taxonomy follow in later steps).
 *
 * Resolution REFUSES an unknown genre (returns `null`; the caller exits 2 / throws) — never a silent
 * default to platformer. That hard-fail-on-unknown is a load-bearing safety property: a typo'd or
 * absent genre must not silently plan+verify the wrong genre green.
 *
 * NOTE (transitional): genre-owned material (slice DAG, verify-first feel machinery, shooter
 * acceptance) now lives under `loombridge/genre-packs/<genre>/`, and this registry binds to it there.
 * The registrations are still declared inline; the next step turns them into a declarative manifest
 * the registry discovers from disk, at which point the genre-neutral core carries no genre id at all.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

// Type-only: the registry (the genre-wiring SoT) may reference a pack entry's signature; these imports
// are erased at runtime and never pull pack/verification code into the core import graph.
import type { VerifyProfileArgs } from "./genre-packs/platformer-2d/verify-profile.js";
import type { AcceptanceContract } from "../verification/types.js";

// At runtime this file is dist/loombridge/genre-registry.js, so the package root is two up. Genre
// templates (.json) live under src/ — `tsc` does not copy .json into dist/, so they are read from src
// at runtime (the same convention plan.ts / the platformer pack use).
const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** A genre pack's deterministic bindings into the plan → verify → doneness pipeline. */
export interface GenrePackRegistration {
  id: string;
  /** Absolute path to the acceptance-contract template `plan` seeds the Design Target from. */
  acceptanceTemplatePath: string;
  /** Absolute path to the slice-DAG roadmap template `plan` instantiates once the target is approved. */
  sliceTemplatePath: string;
  /**
   * The hero-shot fidelity criteria the `doneness` gate enforces for an approved Design Target of this
   * genre. Frozen with the registration and NON-EMPTY — an empty set would make the structural fidelity
   * check vacuously pass (the RUN-1 flat-build self-pass the moat exists to stop).
   */
  fidelityCriteria: readonly string[];
  /**
   * The genre's verify-first (`loombridge verify --profile <id>`) feel-grading entry, lazily loaded.
   * OPTIONAL: only a genre that ships feel profiles declares it (today, just platformer-2d). The
   * loader is `import()`-deferred so the core `verify` orchestrator never statically imports a pack:
   * resolving the runner pulls pack code into the graph only when a `--profile` run actually needs it.
   */
  loadFeelProfileModule?: () => Promise<FeelProfileModule>;
  /**
   * The bundled verification-capture scenario pack this genre's build-mode verify runs when no
   * project-specific `--scenario` is supplied. OPTIONAL: a genre without one is simply never
   * auto-selected (the runner then requires an explicit `--scenario`). Declared here so
   * `capture-runner` (the verification-layer orchestrator) carries no genre id of its own.
   */
  scenarioPack?: ScenarioPackDescriptor;
}

/**
 * Describes a bundled verification-capture scenario pack. `capture-runner` owns resolving `fileName`
 * to an on-disk path under `verification/scenarios/`; the registry owns which genre claims which pack
 * and how it is matched against an acceptance contract.
 */
export interface ScenarioPackDescriptor {
  id: string;
  gameKind: string;
  fileName: string;
  /** True when this pack should grade the given acceptance contract (the auto-selection predicate). */
  matches: (acceptance: AcceptanceContract) => boolean;
}

/**
 * The contract `verify.ts` consumes for the verify-first (`--profile`) path, resolved through the
 * registry instead of a direct pack import. A genre that ships feel profiles binds all three: the
 * shipped ids it grades, the runner, and the "unknown profile" message (the pack owns its own voice).
 */
export interface FeelProfileModule {
  /** Profile ids this genre grades (e.g. precision/classic/momentum). */
  SHIPPED_PROFILE_IDS: readonly string[];
  /** Run the verify-first profile flow; returns the process exit code. */
  runVerifyProfile: (args: VerifyProfileArgs & { outputPath: string }) => Promise<number>;
  /** The pack-voiced guidance shown when `--profile <id>` names an id this genre does not grade. */
  unknownProfileMessage: (id: string) => string;
}

/**
 * The genre `plan` assumes when `--genre` is omitted (back-compat: the platformer happy path). Declared
 * here — the one genre-wiring point — so the genre-neutral core (`plan.ts`) carries no genre literal.
 * MUST name a registered genre; asserted at module load below.
 */
export const DEFAULT_GENRE_ID = "platformer-2d";

const REGISTRY: Record<string, GenrePackRegistration> = {
  "platformer-2d": {
    id: "platformer-2d",
    // The acceptance template (tiderunner) stays under src/verification/ — it doubles as a shared
    // mock-oracle test fixture referenced by name across the suite; only the genre-owned slice DAG +
    // verify-first machinery relocate into the pack.
    acceptanceTemplatePath: path.join(PKG_ROOT, "src", "verification", "tiderunner.acceptance.json"),
    sliceTemplatePath: path.join(PKG_ROOT, "src", "loombridge", "genre-packs", "platformer-2d", "slices.json"),
    fidelityCriteria: ["composition-match", "parallax-present", "platform-tiers", "element-placement-arc"],
    // verify-first feel grading lives in the platformer pack (the shipped profile ids + the runner).
    // Loaded via `import()` so `verify.ts` never statically depends on the pack — see the file header.
    loadFeelProfileModule: async () => {
      const [{ SHIPPED_PROFILE_IDS }, { runVerifyProfile, unknownProfileMessage }] = await Promise.all([
        import("./genre-packs/platformer-2d/profiles.js"),
        import("./genre-packs/platformer-2d/verify-profile.js"),
      ]);
      return { SHIPPED_PROFILE_IDS, runVerifyProfile, unknownProfileMessage };
    },
    // Auto-selected for any acceptance contract carrying a `platformer` gate-tuning section. The
    // scenario JSON itself stays under verification/scenarios/ (capture-runner resolves the path).
    scenarioPack: {
      id: "platformer-2d-basic",
      gameKind: "platformer-2d",
      fileName: "platformer-2d-basic.json",
      matches: (acceptance) => Boolean((acceptance as AcceptanceContract & { platformer?: unknown }).platformer),
    },
  },
  "2d-shooter": {
    id: "2d-shooter",
    acceptanceTemplatePath: path.join(PKG_ROOT, "src", "loombridge", "genre-packs", "2d-shooter", "acceptance.json"),
    sliceTemplatePath: path.join(PKG_ROOT, "src", "loombridge", "genre-packs", "2d-shooter", "slices.json"),
    // Shooter hero-shot fidelity is judged on arena/enemy/HUD structure — NOT the platformer
    // parallax/platform-tier criteria. Non-empty (no vacuous pass) AND every id must be in
    // doneness' VLM_REVIEW_CRITERION_IDS allow-list, else the genre's doneness is unreachable-green;
    // a cross-table test in genre-registry.test.ts enforces both invariants.
    fidelityCriteria: ["composition-match", "arena-framing", "enemy-readability", "hud-placement"],
  },
  "3d-shooter": {
    id: "3d-shooter",
    acceptanceTemplatePath: path.join(PKG_ROOT, "src", "loombridge", "genre-packs", "3d-shooter", "acceptance.json"),
    sliceTemplatePath: path.join(PKG_ROOT, "src", "loombridge", "genre-packs", "3d-shooter", "slices.json"),
    // First 3D-shooter SEED. Hero-shot fidelity is judged on the same genre-neutral arena/enemy/HUD
    // structure as 2d-shooter (all four ids are in doneness' VLM_REVIEW_CRITERION_IDS allow-list — the
    // genre-registry.test.ts cross-table test enforces it). 3D-specific fidelity (look/recoil/ADS,
    // 3D-camera shake) is deliberately NOT registered yet: it has no calculator/criterion, so claiming
    // it would make this genre's doneness unreachable-green. No verify-first feel profile and no bundled
    // scenario pack yet — both await the first live 3D capture proof.
    fidelityCriteria: ["composition-match", "arena-framing", "enemy-readability", "hud-placement"],
  },
};

/** The registered genre ids, in registration order. */
export function knownGenreIds(): string[] {
  return Object.keys(REGISTRY);
}

// Fail loud at module load if the declared default is not a registered genre — a typo here would
// otherwise surface as a confusing "unknown genre" only when `plan` runs without `--genre`.
if (!Object.prototype.hasOwnProperty.call(REGISTRY, DEFAULT_GENRE_ID)) {
  throw new Error(`genre-registry: DEFAULT_GENRE_ID "${DEFAULT_GENRE_ID}" is not a registered genre`);
}

/** The genre `plan` uses when `--genre` is omitted. Always a registered id (asserted at load). */
export function defaultGenreId(): string {
  return DEFAULT_GENRE_ID;
}

/**
 * The bundled scenario-pack descriptors across all genres that declare one, in registration order.
 * `capture-runner` selects from this list (by each pack's `matches` predicate) instead of hard-coding
 * a platformer pack — so the verification-layer orchestrator stays genre-neutral.
 */
export function scenarioPacks(): ScenarioPackDescriptor[] {
  return Object.values(REGISTRY).flatMap((registration) =>
    registration.scenarioPack ? [registration.scenarioPack] : [],
  );
}

/**
 * Resolve the verify-first feel-profile module that grades `profileId`, routed through the registry so
 * the core `verify` orchestrator never imports a genre pack directly. Returns the owning genre's
 * `{ module }` on a match, else `{ unknownMessage }` (the owning pack's own guidance — with a single
 * feel-profile genre today this is byte-identical to the prior direct `unknownProfileMessage` call).
 *
 * Lazy: each candidate binding is `import()`-loaded only as the search reaches it, and the search
 * stops at the first owner — so resolving a profile loads at most the feel-profile genres declared
 * before its owner (today there is exactly one, so a valid profile loads only the platformer pack).
 */
export async function resolveFeelProfileModule(
  profileId: string,
): Promise<{ module: FeelProfileModule } | { unknownMessage: string }> {
  let fallbackMessage: string | null = null;
  for (const registration of Object.values(REGISTRY)) {
    if (!registration.loadFeelProfileModule) continue;
    const module = await registration.loadFeelProfileModule();
    if (module.SHIPPED_PROFILE_IDS.includes(profileId)) return { module };
    // Remember the first feel-profile genre's "unknown" message so a no-match still refuses with
    // pack-voiced guidance rather than a generic string.
    if (fallbackMessage === null) fallbackMessage = module.unknownProfileMessage(profileId);
  }
  return {
    unknownMessage:
      fallbackMessage ??
      `[loombridge verify] unknown --profile "${profileId}". No registered genre ships feel profiles.`,
  };
}

/**
 * Resolve a genre id to its registration, or `null` when the id is not registered. REFUSE on unknown:
 * the caller turns a null into an exit-2 / thrown error — never a default-to-platformer fallback.
 */
export function resolveGenrePack(id: string): GenrePackRegistration | null {
  return Object.prototype.hasOwnProperty.call(REGISTRY, id) ? REGISTRY[id]! : null;
}

/**
 * The hero-shot fidelity criteria for a genre, or `null` when the genre is not registered OR carries an
 * empty set (so the caller falls back to a non-empty default / refuses rather than silently certifying).
 * NEVER returns an empty list — an empty criteria set would make the structural fidelity check pass
 * vacuously (the RUN-1 flat-build self-pass the moat exists to stop), so it is treated as "no criteria"
 * and forces the fallback, not a free pass.
 */
export function genreFidelityCriteria(id: string): readonly string[] | null {
  const criteria = resolveGenrePack(id)?.fidelityCriteria;
  return criteria && criteria.length > 0 ? criteria : null;
}
