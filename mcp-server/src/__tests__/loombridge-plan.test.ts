import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { renderGameSpec, runPlan } from "../capabilities/verification/plan.js";
import { nextActionFor, readState, loombridgePaths, type LoombridgeState } from "../domain/state.js";
import { setDesignTarget } from "../capabilities/verification/design.js";

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
  assert.match(action, /loombridge design/);
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
    assert.equal(weaponSlice?.skill, "shooter-weapon");
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

test("runPlan — --genre-contract refuses unregistered promoted genres", async () => {
  const root = await tmpRoot();
  try {
    const sourcePath = path.join(process.cwd(), "src", "capabilities", "genre", "genre-contract", "examples", "2d-shooter.contract.json");
    const source = JSON.parse(await fs.readFile(sourcePath, "utf-8"));
    source.genreId = "unregistered-shooter";
    const contractPath = path.join(root, "unregistered.contract.json");
    await fs.writeFile(contractPath, JSON.stringify(source), "utf-8");
    const code = await runPlan({
      root,
      genre: "2d-shooter",
      genreContractPath: contractPath,
      engine: "unity",
      force: false,
      allowMissingDesignTarget: true,
    });
    assert.equal(code, 2);
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

test("runPlan — an unregistered genre is REFUSED (exit 2), never defaulted", async () => {
  const root = await tmpRoot();
  try {
    const code = await runPlan({ root, genre: "fps-3d-unregistered", engine: "unity", force: false, allowMissingDesignTarget: true });
    assert.equal(code, 2, "unknown genre must exit 2, not silently plan a default genre");
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

test("runPlan — the `unknown` placeholder genre from `design set` is NOT preserved on a bare re-plan", async () => {
  const root = await tmpRoot();
  try {
    const paths = loombridgePaths(root);
    const img = path.join(root, "hero.png");
    await fs.writeFile(img, "hero", "utf-8");
    // `design set` BEFORE any `plan` bootstraps STATE with the placeholder genre "unknown".
    await setDesignTarget({ root, imagePath: img, mode: "generated", approve: true });
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
