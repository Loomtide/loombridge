import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { renderGameSpec, runPlan } from "../../../../capabilities/verification/plan.js";
import { fileExists, nextActionFor, readState, loombridgePaths, type LoombridgeState } from "../../../../domain/state.js";
import { setDesignTarget } from "../../../../capabilities/verification/design.js";
import { deriveGenreCoverage } from "../../../../capabilities/genre/genre-coverage.js";

async function tmpRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "loombridge-plan-"));
}

async function namedTmpRoot(name: string): Promise<string> {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "loombridge-plan-parent-"));
  const root = path.join(parent, name);
  await fs.mkdir(root);
  return root;
}

// ── renderGameSpec — auto-derive from the contract (#64, P2.3) ───────────────

test("renderGameSpec — derives pitch / mechanics / win / feel / HUD from the contract (no TODO stubs)", () => {
  const md = renderGameSpec(
    {
      game: "tiderunner",
      win: { rule: "all-fruit", note: "collect every fruit" },
      feel: { runSpeed: { target: 7, unit: "u/s" }, jumpApex: { target: 2.2, unit: "u" } },
      hud: { elements: [{ id: "score", role: "Fruit counter", anchor: "top-left" }] },
      manifest: { elements: [{ primitive: "player" }, { primitive: "collectible" }, { primitive: "hazard" }] },
      framing: { cameraMode: "static", aspect: { w: 16, h: 9 } },
      audio: { cues: [{ id: "jump" }, { id: "collect" }] },
    },
    "platformer-2d",
    "unity",
  );

  assert.match(md, /"tiderunner"/);
  assert.match(md, /Objective: \*\*all-fruit\*\*/);
  assert.match(md, /a player character/);
  assert.match(md, /collectibles/);
  assert.match(md, /## Feel targets/);
  assert.match(md, /runSpeed \| 7 u\/s/);
  assert.match(md, /## HUD/);
  assert.match(md, /`score`/);
  assert.match(md, /16:9, static camera/);
  assert.match(md, /jump, collect/);
  // The all-TODO stub is gone.
  assert.doesNotMatch(md, /_TODO_/);
});

test("renderGameSpec — degrades gracefully on a sparse contract", () => {
  const md = renderGameSpec({ game: "x" }, "topdown-action", "unity");
  assert.match(md, /A topdown-action game \("x"\)/);
  assert.match(md, /no win rule declared/);
  // No feel/HUD sections fabricated when absent.
  assert.doesNotMatch(md, /## Feel targets/);
});

// ── nextActionFor — STATE.md is actionable at every phase (#64, P2.3) ────────

function stateWith(patch: Partial<LoombridgeState>): LoombridgeState {
  return {
    genre: "platformer-2d",
    engine: "unity",
    phase: "planned",
    updatedAt: "2026-05-29T00:00:00.000Z",
    ...patch,
  };
}

test("nextActionFor — planned without an approved target points at the Design Target", () => {
  const action = nextActionFor(stateWith({ phase: "planned", designTarget: "missing" }));
  assert.match(action, /Design Target/);
  // The verb was renamed `design` -> `target` (CommandSurfaceRedesign §4); `design` remains a
  // deprecated alias, but the guidance we hand a developer must name the CANONICAL verb.
  assert.match(action, /loombridge target/);
});

test("nextActionFor — planned WITH approval points at build", () => {
  assert.match(nextActionFor(stateWith({ phase: "planned", designTarget: "approved" })), /loombridge build/);
});

test("nextActionFor — verified-green points at doneness + the hero-shot review", () => {
  const action = nextActionFor(stateWith({ phase: "verified-green", designTarget: "approved" }));
  assert.match(action, /loombridge doneness/);
  assert.match(action, /hero-shot/);
});

test("nextActionFor — failing/warn/built phases each have a concrete next step", () => {
  assert.match(nextActionFor(stateWith({ phase: "verified-failing" })), /latest verdict failures/);
  assert.match(nextActionFor(stateWith({ phase: "verified-warn" })), /--strict/);
  assert.match(nextActionFor(stateWith({ phase: "built-unverified" })), /capturePack/);
});

// ── integration: plan writes a derived GAME_SPEC + an actionable STATE.md ─────

test("runPlan — GAME_SPEC.md is contract-derived and STATE.md carries a Next action", async () => {
  const root = await tmpRoot();
  try {
    await runPlan({ root, genre: "platformer-2d", engine: "unity", force: false, allowMissingDesignTarget: true });
    const paths = loombridgePaths(root);
    const seededGameName = path.basename(root);

    const contract = JSON.parse(await fs.readFile(paths.acceptance, "utf-8"));
    assert.equal(contract.game, seededGameName);
    const gameSpec = await fs.readFile(paths.gameSpec, "utf-8");
    assert.doesNotMatch(gameSpec, /_TODO_/, "GAME_SPEC must be derived, not an all-TODO stub");
    assert.match(gameSpec, new RegExp(`\\("${seededGameName}"\\)`), "pitch uses the project folder name");
    assert.match(gameSpec, /Objective: \*\*all-fruit\*\*/, "derived from the seeded tiderunner contract");
    assert.match(gameSpec, /## Feel targets/);

    const stateMd = await fs.readFile(paths.state, "utf-8");
    assert.match(stateMd, /\*\*Next action:\*\*/, "STATE.md must carry an actionable Next action line");
    // planned + no approved design target → points at the Design Target.
    assert.match(stateMd, /Design Target/);

    // sanity: state round-trips.
    const state = await readState(paths);
    assert.equal(state?.phase, "planned");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("runPlan — `--genre 2d-shooter` plans a shooter through the same core (no platformer template)", async () => {
  const root = await tmpRoot();
  try {
    const code = await runPlan({ root, genre: "2d-shooter", engine: "unity", force: false, allowMissingDesignTarget: true });
    assert.equal(code, 0, "plan --genre 2d-shooter must succeed through the registry-driven core");
    const paths = loombridgePaths(root);

    // The seeded contract is the SHOOTER acceptance template, not the platformer one.
    const contract = JSON.parse(await fs.readFile(paths.acceptance, "utf-8"));
    assert.equal(contract.win.rule, "all-enemies-defeated");
    assert.ok(contract.feel.fireIntervalMs, "shooter feel metrics seeded");
    assert.equal(contract.platformer, undefined, "shooter contract carries no platformer section");

    // GAME_SPEC is derived (not a stub), and state records the shooter genre.
    const gameSpec = await fs.readFile(paths.gameSpec, "utf-8");
    assert.doesNotMatch(gameSpec, /_TODO_/);
    const state = await readState(paths);
    assert.equal(state?.genre, "2d-shooter");
    assert.equal(state?.phase, "planned");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("runPlan — `--genre 3d-shooter` plans the 3D-shooter seed through the same core (no platformer fallback)", async () => {
  const root = await tmpRoot();
  try {
    const code = await runPlan({ root, genre: "3d-shooter", engine: "unity", force: false, allowMissingDesignTarget: true });
    assert.equal(code, 0, "plan --genre 3d-shooter must succeed through the registry-driven core");
    const paths = loombridgePaths(root);

    // The seeded contract is the 3D-SHOOTER acceptance template, not the platformer one.
    const contract = JSON.parse(await fs.readFile(paths.acceptance, "utf-8"));
    assert.equal(contract.win.rule, "all-enemies-defeated");
    assert.ok(contract.feel.fireIntervalMs, "shooter feel metrics seeded");
    // Honest seed: 3D-specific feel that has no calculator is NOT seeded into the contract feel.
    assert.equal(contract.feel.projectileSpeed, undefined, "true-3D projectileSpeed is a gap, not seeded as feel");
    assert.equal(contract.platformer, undefined, "3D-shooter contract carries no platformer section");
    // 3D framing is a perspective rig, not a 2D pixel/orthographic frame.
    assert.equal(contract.framing.cameraMode, "third-person-follow");

    // GAME_SPEC is derived (not a stub), and state records the 3d-shooter genre.
    const gameSpec = await fs.readFile(paths.gameSpec, "utf-8");
    assert.doesNotMatch(gameSpec, /_TODO_/);
    const state = await readState(paths);
    assert.equal(state?.genre, "3d-shooter");
    assert.equal(state?.phase, "planned");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("runPlan — --genre-contract promotes acceptance, slices, and report", async () => {
  const root = await tmpRoot();
  try {
    const genreContractPath = path.join(
      process.cwd(),
      "src",
      "capabilities",
  "genre",
  "genre-contract",
      "examples",
      "2d-shooter.contract.json",
    );
    const code = await runPlan({
      root,
      genre: "ignored-when-contract-is-present",
      genreContractPath,
      engine: "unity",
      force: false,
      allowMissingDesignTarget: true,
    });
    assert.equal(code, 0);

    const paths = loombridgePaths(root);
    const acceptance = JSON.parse(await fs.readFile(paths.acceptance, "utf-8"));
    const slices = JSON.parse(await fs.readFile(paths.slices, "utf-8"));
    const report = JSON.parse(await fs.readFile(path.join(paths.dir, "GENRE_PROMOTION.json"), "utf-8"));

    assert.equal(acceptance.game, path.basename(root));
    assert.equal(acceptance.platformer, undefined);
    assert.equal(acceptance.feel.extra?.fireIntervalMs, undefined, "target bands stay report-only");
    assert.equal(slices.genre, "2d-shooter");
    const weaponSlice = slices.slices.find((slice: { id?: string }) => slice.id === "weapon");
    // The REGISTERED 2d-shooter pack template supplies the binding, and it names a skill consumers
    // actually receive. It used to name `shooter-weapon`, which ships nowhere; the repo guard
    // `slice-skill-bindings.test.ts` is what keeps it resolvable.
    assert.equal(weaponSlice?.skill, "unity-2d-game");
    assert.ok(weaponSlice?.acceptance.gates.includes("visual-artifacts"));
    assert.equal(report.sourceGenreId, "2d-shooter");
    assert.ok(report.measurability.some((row: { target?: string; targetBand?: { min?: number } }) => row.target === "fireIntervalMs" && row.targetBand?.min === 90));
    assert.deepEqual(report.deferredSlices, ["weapon-roster", "progression"]);

    const state = await readState(paths);
    assert.equal(state?.genre, "2d-shooter");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

/** The shipped 2d-shooter contract, re-pointed at an UNREGISTERED genre id. */
async function unregisteredContractAt(
  root: string,
  genreId: string,
  mutate?: (contract: Record<string, unknown>) => void,
): Promise<string> {
  const sourcePath = path.join(process.cwd(), "src", "capabilities", "genre", "genre-contract", "examples", "2d-shooter.contract.json");
  const source = JSON.parse(await fs.readFile(sourcePath, "utf-8"));
  source.genreId = genreId;
  mutate?.(source);
  const contractPath = path.join(root, `${genreId}.contract.json`);
  await fs.writeFile(contractPath, JSON.stringify(source), "utf-8");
  return contractPath;
}

test("runPlan — --genre-contract PLANS an unregistered genre (coverage, not refusal)", async () => {
  // W1 (CommandSurfaceRedesign): this used to exit 2. The registry lookup it tripped over was a pure
  // gatekeeper — on the promoted path the pack's acceptance template is never even read, because the
  // contract supplies acceptance AND slices. The closed set now governs what `verify` CLAIMS instead.
  const root = await tmpRoot();
  try {
    const contractPath = await unregisteredContractAt(root, "unregistered-shooter");
    const code = await runPlan({
      root,
      genre: "2d-shooter",
      genreContractPath: contractPath,
      engine: "unity",
      force: false,
      allowMissingDesignTarget: true,
    });
    assert.equal(code, 0, "an unregistered genre with a valid contract must plan, not refuse");

    const paths = loombridgePaths(root);
    // All three promoted artifacts exist and bind to the unregistered genre...
    const slices = JSON.parse(await fs.readFile(paths.slices, "utf-8"));
    const report = JSON.parse(await fs.readFile(paths.genrePromotion, "utf-8"));
    assert.equal(slices.genre, "unregistered-shooter");
    assert.equal(report.sourceGenreId, "unregistered-shooter");
    assert.ok(JSON.parse(await fs.readFile(paths.acceptance, "utf-8")).game);
    // ...and STATE records it, which is what `verify`/`doneness` resolve coverage from.
    assert.equal((await readState(paths))?.genre, "unregistered-shooter");

    // The claim is scoped: partially-graded, with a non-empty gap list.
    const coverage = deriveGenreCoverage({ genre: "unregistered-shooter", promotion: report });
    assert.equal(coverage.coverage, "partially-graded");
    assert.ok(coverage.gaps.length > 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("runPlan — a bare --genre naming an unregistered genre plans FREE-FORM from the generic template", async () => {
  // W2 asserted this exited 2, because the templated path had nothing to seed from. Shipping the
  // genre-neutral `_generic` pack removed that blocker, which is what finally makes `ungraded` a
  // state a real project can be in — and therefore what makes D1's "an ungraded game may reach
  // doneness" mean anything at all.
  const root = await tmpRoot();
  try {
    const code = await runPlan({
      root,
      genre: "unregistered-shooter",
      genreExplicit: true,
      engine: "unity",
      force: false,
      allowMissingDesignTarget: true,
    });
    assert.notEqual(code, 2, "an unregistered genre must no longer be refused at the door");

    const paths = loombridgePaths(root);
    assert.equal(await fileExists(paths.acceptance), true, "the generic contract must be seeded");
    // STATE records the DEVELOPER'S genre string, never "generic" — coverage binds to what they
    // said they are building, and `_generic` is a template, not an identity.
    assert.equal((await readState(paths))?.genre, "unregistered-shooter");

    // And the claim is the narrowest one: ungraded, with its limits enumerated.
    const coverage = deriveGenreCoverage({ genre: "unregistered-shooter", promotion: null });
    assert.equal(coverage.coverage, "ungraded");
    assert.ok(coverage.gaps.length > 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("runPlan — an unregistered genre carries its contract's fidelityCriteria into the promotion report", async () => {
  // The contract-side equivalent of a pack registration: this is what lets a promoted genre certify a
  // design-targeted build without borrowing another genre's criteria. It must survive promotion, since
  // doneness reads it from GENRE_PROMOTION.json, not from the contract file.
  const root = await tmpRoot();
  try {
    const contractPath = await unregisteredContractAt(root, "topdown-brawler", (c) => {
      c.fidelityCriteria = ["composition-match", "arena-framing"];
    });
    assert.equal(
      await runPlan({ root, genre: "2d-shooter", genreContractPath: contractPath, engine: "unity", force: false, allowMissingDesignTarget: true }),
      0,
    );
    const report = JSON.parse(await fs.readFile(loombridgePaths(root).genrePromotion, "utf-8"));
    assert.deepEqual(report.fidelityCriteria, ["composition-match", "arena-framing"]);
    // With criteria declared, the fidelity gap drops out of the coverage gap list...
    const coverage = deriveGenreCoverage({ genre: "topdown-brawler", promotion: report });
    assert.ok(!coverage.gaps.some((g) => /no hero-shot fidelity criteria/.test(g)));
    // ...but the feel-oracle gap is structural and survives, so the list is still non-empty.
    assert.ok(coverage.gaps.length > 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("runPlan — re-planning onto a registered genre CLEARS the stale promotion report", async () => {
  // Without this, the legitimate "I promoted a contract, now I want a shipped pack" switch leaves a
  // report describing artifacts that no longer exist, the disk contradicts itself, and the coverage
  // derivation refuses forever. The refusal is correct; stranding the developer on it is not.
  const root = await tmpRoot();
  try {
    const contractPath = await unregisteredContractAt(root, "puzzle-hypercasual");
    assert.equal(
      await runPlan({ root, genre: "2d-shooter", genreContractPath: contractPath, engine: "unity", force: false, allowMissingDesignTarget: true }),
      0,
    );
    const paths = loombridgePaths(root);
    assert.equal(await fileExists(paths.genrePromotion), true, "precondition: the promoted report exists");

    // Switch to a registered genre, re-seeding acceptance from its pack template.
    await runPlan({ root, genre: "platformer-2d", genreExplicit: true, engine: "unity", force: true, allowMissingDesignTarget: true });
    assert.equal(await fileExists(paths.genrePromotion), false, "the stale report must be removed, not left to contradict STATE");
    assert.equal((await readState(paths))?.genre, "platformer-2d");
    // And coverage resolves cleanly to the registered genre — no contradiction.
    assert.equal(deriveGenreCoverage({ genre: "platformer-2d", promotion: null }).coverage, "graded");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("runPlan — a contract declaring an UNGRADABLE fidelity criterion is refused at plan time", async () => {
  // Refuse at authoring rather than at doneness: a criterion outside VLM_REVIEW_CRITERION_IDS can
  // never appear in vlm-review.json, so accepting it would hand the developer a genre whose doneness
  // is unreachable-green and only tell them at the very end.
  const root = await tmpRoot();
  try {
    const contractPath = await unregisteredContractAt(root, "bad-criteria", (c) => {
      c.fidelityCriteria = ["looks-great-honestly"];
    });
    const code = await runPlan({ root, genre: "2d-shooter", genreContractPath: contractPath, engine: "unity", force: false, allowMissingDesignTarget: true });
    assert.equal(code, 2, "an ungradable declared criterion must refuse");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("runPlan — --genre-contract refuses to mix with existing artifacts without --force", async () => {
  const root = await tmpRoot();
  try {
    await runPlan({ root, genre: "platformer-2d", engine: "unity", force: false, allowMissingDesignTarget: true });
    const genreContractPath = path.join(process.cwd(), "src", "capabilities", "genre", "genre-contract", "examples", "2d-shooter.contract.json");
    const code = await runPlan({
      root,
      genre: "2d-shooter",
      genreContractPath,
      engine: "unity",
      force: false,
      allowMissingDesignTarget: true,
    });
    assert.equal(code, 2);
    const state = await readState(loombridgePaths(root));
    assert.equal(state?.genre, "platformer-2d");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("runPlan — an unregistered genre is never SILENTLY DEFAULTED to another genre's pack", async () => {
  // The original invariant, which survives the free-form entry unchanged: refusing at the door was
  // only ever a means to it. An unregistered genre must not inherit platformer (or any registered
  // genre's) contract — that is the false-green the registry refusal existed to prevent. It now
  // seeds the GENRE-NEUTRAL template instead, which asserts nothing about the game.
  const root = await tmpRoot();
  try {
    const code = await runPlan({ root, genre: "fps-3d-unregistered", engine: "unity", force: false, allowMissingDesignTarget: true });
    assert.notEqual(code, 2);

    const contract = JSON.parse(await fs.readFile(loombridgePaths(root).acceptance, "utf-8"));
    // Not the platformer default...
    assert.equal(contract.platformer, undefined, "must not inherit the platformer section");
    assert.equal(contract.win.rule, "declared-by-project", "the win rule is an explicit placeholder");
    // ...and not any registered genre's feel bands, which would be graded against a game that never
    // agreed to them.
    assert.deepEqual(contract.feel, { extra: {} }, "a free-form seed declares NO feel targets");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("runPlan — omitted --name seeds game from folder basename; explicit --name wins", async () => {
  const root = await namedTmpRoot("my-cool-game");
  try {
    await runPlan({ root, genre: "platformer-2d", engine: "unity", force: false, allowMissingDesignTarget: true });
    const paths = loombridgePaths(root);

    let contract = JSON.parse(await fs.readFile(paths.acceptance, "utf-8"));
    let gameSpec = await fs.readFile(paths.gameSpec, "utf-8");
    assert.equal(contract.game, "my-cool-game");
    assert.match(gameSpec, /"my-cool-game"/);

    await runPlan({
      root,
      genre: "platformer-2d",
      engine: "unity",
      name: "explicit-name",
      force: true,
      allowMissingDesignTarget: true,
    });
    contract = JSON.parse(await fs.readFile(paths.acceptance, "utf-8"));
    gameSpec = await fs.readFile(paths.gameSpec, "utf-8");
    assert.equal(contract.game, "explicit-name");
    assert.match(gameSpec, /"explicit-name"/);
  } finally {
    await fs.rm(path.dirname(root), { recursive: true, force: true });
  }
});

// ── genre preservation on re-plan (PR #349 finding 1) ────────────────────────

test("runPlan — a bare re-plan PRESERVES the promoted STATE.genre instead of resetting to the default", async () => {
  const root = await tmpRoot();
  try {
    const paths = loombridgePaths(root);

    // 1. First plan promotes to 3d-shooter (explicit --genre).
    assert.equal(
      await runPlan({ root, genre: "3d-shooter", genreExplicit: true, engine: "unity", force: false, allowMissingDesignTarget: true }),
      0,
    );
    assert.equal((await readState(paths))?.genre, "3d-shooter");

    // 2. A BARE re-plan (no --genre, no --genre-contract → parser default platformer-2d, genreExplicit false)
    //    must NOT silently flip the genre back to the registry default.
    assert.equal(
      await runPlan({ root, genre: "platformer-2d", genreExplicit: false, engine: "unity", force: false, allowMissingDesignTarget: true }),
      0,
    );
    assert.equal((await readState(paths))?.genre, "3d-shooter", "bare re-plan must preserve the promoted genre");

    // 3. An EXPLICIT --genre still overrides — users can deliberately switch genres.
    assert.equal(
      await runPlan({ root, genre: "2d-shooter", genreExplicit: true, engine: "unity", force: true, allowMissingDesignTarget: true }),
      0,
    );
    assert.equal((await readState(paths))?.genre, "2d-shooter", "explicit --genre overrides the preserved genre");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("REGRESSION: a FREE-FORM genre survives a bare re-plan (no silent downgrade to the default)", async () => {
  // Found by adversarial review of the free-form entry path, reproduced end-to-end before the fix.
  //
  // Genre preservation tested "is `prev.genre` REGISTERED?", which was equivalent to "was it really
  // planned?" only while every plannable genre was registered. Free-form broke that equivalence, and
  // a bare `loombridge plan` after `plan --genre my-weird-game` silently rewrote STATE.genre to
  // platformer-2d. Two things went wrong at once: the developer's project became a platformer, and
  // its coverage claim was UPGRADED from `ungraded` to `graded` — a full Tier-1 claim over a
  // genre-neutral contract that asserts nothing. That is the silent-default false green the registry
  // refusal existed to stop, re-entering through the new door.
  //
  // LITMUS: restore the `resolveGenrePack(prev.genre)` test and this fails with "platformer-2d".
  const root = await tmpRoot();
  try {
    const paths = loombridgePaths(root);
    await runPlan({ root, genre: "my-weird-game", genreExplicit: true, engine: "unity", force: false, allowMissingDesignTarget: true });
    assert.equal((await readState(paths))?.genre, "my-weird-game", "precondition: planned free-form");

    // A BARE re-plan — no --genre, so the parser hands in the registry default.
    await runPlan({ root, genre: "platformer-2d", genreExplicit: false, engine: "unity", force: false, allowMissingDesignTarget: true });
    assert.equal((await readState(paths))?.genre, "my-weird-game", "the free-form genre must survive");

    // And the claim must not have been upgraded behind the developer's back.
    assert.equal(deriveGenreCoverage({ genre: "my-weird-game", promotion: null }).coverage, "ungraded");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("runPlan — the `unknown` placeholder genre from `design set` is NOT preserved on a bare re-plan", async () => {
  const root = await tmpRoot();
  try {
    const paths = loombridgePaths(root);
    const img = path.join(root, "hero.png");
    await fs.writeFile(img, "hero", "utf-8");
    // `design set` BEFORE any `plan` bootstraps STATE with the placeholder genre "unknown".
    await setDesignTarget({ root, imagePath: img, mode: "generated", kind: "rendered-unity-frame", approve: true });
    assert.equal((await readState(paths))?.genre, "unknown", "precondition: design-set bootstraps the `unknown` placeholder genre");

    // A bare re-plan must resolve to the registry DEFAULT — the unregistered placeholder must NOT stick.
    // If the registered-genre guard were dropped, `resolveGenrePack("unknown")` is null → plan would exit 2
    // and STATE.genre would stay "unknown". (Exit may be 1 here — design is approved but no --asset-mode yet —
    // but STATE.genre is written before that gate, so the genre RESOLUTION is what we assert.)
    const code = await runPlan({ root, genre: "platformer-2d", genreExplicit: false, engine: "unity", force: false, allowMissingDesignTarget: true });
    assert.notEqual(code, 2, "placeholder `unknown` must not cause an unknown-genre exit 2");
    assert.equal((await readState(paths))?.genre, "platformer-2d", "`unknown` must NOT be preserved; the default genre wins");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
