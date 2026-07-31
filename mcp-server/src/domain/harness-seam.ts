/**
 * The HARNESS block: what a measurement recipe needs to drive this game.
 *
 * WHY IT IS ITS OWN TOP-LEVEL SECTION (review M14). `acceptance.feel` states what
 * the game must FEEL LIKE: targets and bands a gate grades. The seam below states
 * how a harness REACHES this game's controller: a component name, a field name, a
 * locator. Those are facts about the project's wiring, not claims about the game,
 * and folding them into `feel` would make the graded contract and the test rig one
 * object. `harness` is optional in the schema (no existing contract breaks) and the
 * feel recipe REFUSES at run time when it is absent, naming the exact JSON to add.
 *
 * WHY THE RECIPE CANNOT GUESS. Measuring an existing controller is black box: there
 * is no discovery that reliably tells a harness which field is "horizontal input"
 * or which component reads the keyboard. Guessing wrong is worse than refusing: the
 * door-one run spent a whole slice on a misdiagnosed bridge defect (ledger C1) that
 * was really a live input reader zeroing a driven field every `Update`. Refuse,
 * never guess.
 *
 * The two faces of the seam, and why both are declared here:
 *   - `keys`   the keyboard bindings the KEYED captures inject
 *              (`runtime.capture_input_motion` drives real keys through the real
 *              input path, so the reader must be LIVE for those legs);
 *   - `fields` the public drive fields on the controller, plus the input-reader
 *              component to disable, for the SEAM-DRIVEN legs (`runtime.probe`),
 *              where a live reader would overwrite the driven value every frame.
 */

/** Public drive fields on the controller component (the seam a probe writes). */
export interface FeelSeamFields {
  /** Horizontal drive field, e.g. "moveX". Required: every seam-driven leg pins it. */
  moveX: string;
  /** Jump-held field, e.g. "jumpHeld". */
  jumpHeld?: string;
  /** Dash-held field, e.g. "dashHeld". */
  dashHeld?: string;
}

/** Keyboard bindings the keyed captures inject (InputSystem Key names). */
export interface FeelSeamKeys {
  /** Key that triggers a jump, e.g. "Space". */
  jump: string;
  /** Key that moves right, e.g. "D" / "RightArrow". */
  moveRight: string;
  /** Key that moves left. Optional: no measured metric requires it today. */
  moveLeft?: string;
  /** Key whose release cuts the jump short; often the same as `jump`. */
  jumpCut?: string;
  /** Key that triggers a dash. */
  dash?: string;
}

export interface FeelSeam {
  /** Locator of the player object the captures measure, e.g. "Level:/Player". */
  playerLocator: string;
  /** Component carrying the public drive `fields`, e.g. "PlayerController". */
  controllerComponent: string;
  /**
   * Component that reads real input and writes the drive fields, e.g.
   * "PlayerInputReader". The seam-driven legs DISABLE it and re-enable it after
   * (ledger C1: a live reader rewrites the seam every `Update`, so a driven value
   * survives exactly one `FixedUpdate` and the measurement reads one tick of
   * motion). Required: without it a seam-driven measurement is silently corrupt.
   */
  inputReaderComponent: string;
  fields: FeelSeamFields;
  keys: FeelSeamKeys;
}

/**
 * THE WIN BINDING (stage 3; review H7 + M14, ledger L97/L98).
 *
 * The playability observer records the game's own win/score/lives state from
 * inside the game loop and DERIVES the verdict from what it recorded. To do that
 * it has to know which component carries those fields and what the win rule means
 * mechanically. Every one of those is a fact about the project's wiring, so it
 * lives here beside the feel seam, never inside `acceptance.win` (which states the
 * rule the game is GRADED against).
 *
 * Nothing in this block is a verdict. Declaring `winRule: "all-collectibles"`
 * does not assert that the game works that way: it names the CHECK the observer
 * runs against the recorded buffer (were there as many score increments before the
 * win as there are collectible objects in the scene?), and a game that wins some
 * other way fails that check.
 */
export interface PlayabilitySeamFields {
  /** Public bool field that flips when the level is won, e.g. "isWin". */
  win: string;
  /** Public numeric score field, e.g. "score". */
  score: string;
  /** Public numeric lives field, e.g. "lives". */
  lives: string;
}

/** How the observer counts the scene's collectibles at window open. */
export interface PlayabilityCollectibleQuery {
  /** Case-insensitive substring of the GameObject name, e.g. "Apple". */
  namePattern?: string;
  /** Unity tag, e.g. "Collectible". */
  tag?: string;
}

/** Keys the observer injects for its own post-win probes. */
export interface PlayabilitySeamKeys {
  /** Movement key the post-win INPUT-LOCK probe holds, e.g. "D". */
  moveRight: string;
  /** Restart key the restart probe taps, e.g. "R". Required for a modal end state. */
  restart?: string;
}

export interface PlayabilitySeam {
  /** Locator of the player whose position the recorder samples every Update. */
  playerLocator: string;
  /** Locator of the object carrying the win/score/lives component, e.g. "Level:/GameManager". */
  stateLocator: string;
  /** Component type name carrying the fields, e.g. "GameManager". */
  stateComponent: string;
  fields: PlayabilitySeamFields;
  /** Closed-set win rule: names the mechanical check, never the verdict. */
  winRule: "all-collectibles" | "reach-goal";
  /** Scene query the bridge runs at open to count collectibles (all-collectibles rule). */
  collectibles?: PlayabilityCollectibleQuery;
  /** Object whose position is the goal (reach-goal rule), read from the scene at open. */
  goalLocator?: string;
  /** Radius that counts as reaching the goal, world units. */
  goalRadiusU?: number;
  /**
   * Object whose position is the game's own respawn point (ledger L125: a hazard
   * teleport to a hardcoded point that is NOT the spawn). Read from the scene at
   * open; a super-kinematic step landing there is classified as a respawn instead
   * of forcing completionMethod "assisted".
   */
  respawnLocator?: string;
  keys: PlayabilitySeamKeys;
  /** How long the observer waits for the win before giving up, seconds. */
  driveTimeoutSeconds?: number;
}

export interface HarnessSection {
  feelSeam?: FeelSeam;
  playability?: PlayabilitySeam;
}

/** The contract shape this module reads (a structural subset of AcceptanceContract). */
export interface HarnessCarrier {
  harness?: HarnessSection;
}

/**
 * The exact JSON an operator has to add. Emitted verbatim inside the refusal so the
 * fix is a copy/paste, not a documentation hunt.
 */
export const FEEL_SEAM_TEMPLATE = `  "harness": {
    "feelSeam": {
      "playerLocator": "<Scene>:/Player",
      "controllerComponent": "PlayerController",
      "inputReaderComponent": "PlayerInputReader",
      "fields": { "moveX": "moveX", "jumpHeld": "jumpHeld", "dashHeld": "dashHeld" },
      "keys": { "jump": "Space", "moveRight": "D", "jumpCut": "Space", "dash": "LeftShift" }
    }
  }`;

/**
 * The exact JSON the playability observer needs. Emitted verbatim inside its
 * refusal, same reason as the feel template: the fix is a copy/paste.
 */
export const PLAYABILITY_SEAM_TEMPLATE = `  "harness": {
    "playability": {
      "playerLocator": "<Scene>:/Player",
      "stateLocator": "<Scene>:/GameManager",
      "stateComponent": "GameManager",
      "fields": { "win": "isWin", "score": "score", "lives": "lives" },
      "winRule": "all-collectibles",
      "collectibles": { "namePattern": "Apple" },
      "respawnLocator": "<Scene>:/RespawnPoint",
      "keys": { "moveRight": "D", "restart": "R" },
      "driveTimeoutSeconds": 600
    }
  }`;

export type FeelSeamResolution =
  | { ok: true; seam: FeelSeam }
  | { ok: false; refusal: string };

export type PlayabilitySeamResolution =
  | { ok: true; seam: PlayabilitySeam }
  | { ok: false; refusal: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isName(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function refuse(what: string): FeelSeamResolution {
  return {
    ok: false,
    refusal:
      `REFUSED: ${what}. The feel recipe drives this game's controller and cannot guess the seam ` +
      "(which component reads input, which fields it writes, which keys drive it). Add it to " +
      ".loombridge/ACCEPTANCE.json:\n" +
      FEEL_SEAM_TEMPLATE,
  };
}

/**
 * Resolve the feel seam, or refuse with the JSON to add. The refusal text is the
 * product here: an operator who runs `capture` on a slice with no seam must be able
 * to fix it from the message alone.
 */
export function resolveFeelSeam(contract: unknown): FeelSeamResolution {
  if (!isRecord(contract)) return refuse("the acceptance contract could not be read");
  const harness = (contract as HarnessCarrier).harness;
  if (harness === undefined) return refuse("the contract declares no `harness` section");
  if (!isRecord(harness)) return refuse("`harness` is not an object");
  const seam = harness.feelSeam;
  if (seam === undefined) return refuse("the contract declares no `harness.feelSeam`");
  if (!isRecord(seam)) return refuse("`harness.feelSeam` is not an object");

  const missing: string[] = [];
  if (!isName(seam.playerLocator)) missing.push("playerLocator");
  if (!isName(seam.controllerComponent)) missing.push("controllerComponent");
  if (!isName(seam.inputReaderComponent)) missing.push("inputReaderComponent");
  const fields = seam.fields;
  if (!isRecord(fields) || !isName(fields.moveX)) missing.push("fields.moveX");
  const keys = seam.keys;
  if (!isRecord(keys) || !isName(keys.jump)) missing.push("keys.jump");
  if (!isRecord(keys) || !isName(keys.moveRight)) missing.push("keys.moveRight");
  if (missing.length > 0) {
    return refuse(`\`harness.feelSeam\` is missing required field(s): ${missing.join(", ")}`);
  }

  const f = fields as Record<string, unknown>;
  const k = keys as Record<string, unknown>;
  return {
    ok: true,
    seam: {
      playerLocator: (seam.playerLocator as string).trim(),
      controllerComponent: (seam.controllerComponent as string).trim(),
      inputReaderComponent: (seam.inputReaderComponent as string).trim(),
      fields: {
        moveX: (f.moveX as string).trim(),
        ...(isName(f.jumpHeld) ? { jumpHeld: f.jumpHeld.trim() } : {}),
        ...(isName(f.dashHeld) ? { dashHeld: f.dashHeld.trim() } : {}),
      },
      keys: {
        jump: (k.jump as string).trim(),
        moveRight: (k.moveRight as string).trim(),
        ...(isName(k.moveLeft) ? { moveLeft: k.moveLeft.trim() } : {}),
        ...(isName(k.jumpCut) ? { jumpCut: k.jumpCut.trim() } : {}),
        ...(isName(k.dash) ? { dash: k.dash.trim() } : {}),
      },
    },
  };
}

function refusePlayability(what: string): PlayabilitySeamResolution {
  return {
    ok: false,
    refusal:
      `REFUSED: ${what}. The playability observer records the game's own win/score/lives state from inside the game ` +
      "loop and derives the verdict from what it recorded, so it cannot guess which component carries those fields, " +
      "which objects are the collectibles, or which key restarts the game. Add it to .loombridge/ACCEPTANCE.json:\n" +
      PLAYABILITY_SEAM_TEMPLATE,
  };
}

/** `acceptance.win.endStateMode`, defaulted the same way the playability gate defaults it. */
function endStateModeOf(contract: unknown): string {
  if (!isRecord(contract)) return "modal";
  const win = contract.win;
  if (!isRecord(win)) return "modal";
  return typeof win.endStateMode === "string" ? win.endStateMode : "modal";
}

/**
 * Resolve the playability seam, or refuse with the JSON to add.
 *
 * The contract is read for TWO things: the seam itself, and `win.endStateMode`,
 * because a modal end state means the gate grades `restartWorks`, which means the
 * observer must be able to tap a restart key. Refusing here, before play mode is
 * entered, beats discovering it after a five-minute drive.
 */
export function resolvePlayabilitySeam(contract: unknown): PlayabilitySeamResolution {
  if (!isRecord(contract)) return refusePlayability("the acceptance contract could not be read");
  const harness = (contract as HarnessCarrier).harness;
  if (harness === undefined) return refusePlayability("the contract declares no `harness` section");
  if (!isRecord(harness)) return refusePlayability("`harness` is not an object");
  const seam = harness.playability;
  if (seam === undefined) return refusePlayability("the contract declares no `harness.playability`");
  if (!isRecord(seam)) return refusePlayability("`harness.playability` is not an object");

  const missing: string[] = [];
  if (!isName(seam.playerLocator)) missing.push("playerLocator");
  if (!isName(seam.stateLocator)) missing.push("stateLocator");
  if (!isName(seam.stateComponent)) missing.push("stateComponent");
  const fields = seam.fields;
  if (!isRecord(fields) || !isName(fields.win)) missing.push("fields.win");
  if (!isRecord(fields) || !isName(fields.score)) missing.push("fields.score");
  if (!isRecord(fields) || !isName(fields.lives)) missing.push("fields.lives");
  const keys = seam.keys;
  if (!isRecord(keys) || !isName(keys.moveRight)) missing.push("keys.moveRight");
  if (missing.length > 0) {
    return refusePlayability(`\`harness.playability\` is missing required field(s): ${missing.join(", ")}`);
  }

  const winRule = seam.winRule;
  if (winRule !== "all-collectibles" && winRule !== "reach-goal") {
    return refusePlayability(
      "`harness.playability.winRule` must be one of the closed set the observer knows how to CHECK: " +
        '"all-collectibles" (as many score increments before the win as there are collectible objects in the scene) or ' +
        '"reach-goal" (the player was inside the goal radius on the sample the win fired)',
    );
  }

  const collectibles = isRecord(seam.collectibles) ? seam.collectibles : undefined;
  const hasQuery = collectibles !== undefined && (isName(collectibles.namePattern) || isName(collectibles.tag));
  if (winRule === "all-collectibles" && !hasQuery) {
    return refusePlayability(
      'the `all-collectibles` rule needs `harness.playability.collectibles` with a `namePattern` and/or `tag`, so the BRIDGE can count the ' +
        "collectible objects in the scene at window open (the score increments are cross-checked against that count, review H7)",
    );
  }
  if (winRule === "reach-goal" && !isName(seam.goalLocator)) {
    return refusePlayability(
      "the `reach-goal` rule needs `harness.playability.goalLocator`, so the bridge can read the goal's position at window open and " +
        "check the player was actually at it when the win fired",
    );
  }

  const endStateMode = endStateModeOf(contract);
  const keysRecord = keys as Record<string, unknown>;
  if (endStateMode === "modal" && !isName(keysRecord.restart)) {
    return refusePlayability(
      `the contract's end state is "${endStateMode}", so the playability gate grades \`restartWorks\`, and the observer proves it by TAPPING the restart key ` +
        "and recording a second window. Declare `harness.playability.keys.restart` (the key the game's own restart affordance listens for)",
    );
  }

  const fieldsRecord = fields as Record<string, unknown>;
  const radius = seam.goalRadiusU;
  const timeout = seam.driveTimeoutSeconds;
  return {
    ok: true,
    seam: {
      playerLocator: (seam.playerLocator as string).trim(),
      stateLocator: (seam.stateLocator as string).trim(),
      stateComponent: (seam.stateComponent as string).trim(),
      fields: {
        win: (fieldsRecord.win as string).trim(),
        score: (fieldsRecord.score as string).trim(),
        lives: (fieldsRecord.lives as string).trim(),
      },
      winRule,
      ...(collectibles
        ? {
            collectibles: {
              ...(isName(collectibles.namePattern) ? { namePattern: collectibles.namePattern.trim() } : {}),
              ...(isName(collectibles.tag) ? { tag: collectibles.tag.trim() } : {}),
            },
          }
        : {}),
      ...(isName(seam.goalLocator) ? { goalLocator: seam.goalLocator.trim() } : {}),
      ...(typeof radius === "number" && Number.isFinite(radius) && radius > 0 ? { goalRadiusU: radius } : {}),
      ...(isName(seam.respawnLocator) ? { respawnLocator: seam.respawnLocator.trim() } : {}),
      keys: {
        moveRight: (keysRecord.moveRight as string).trim(),
        ...(isName(keysRecord.restart) ? { restart: keysRecord.restart.trim() } : {}),
      },
      ...(typeof timeout === "number" && Number.isFinite(timeout) && timeout > 0
        ? { driveTimeoutSeconds: timeout }
        : {}),
    },
  };
}

/**
 * Split a scene-qualified locator ("Main:/Player") into the {scene, path} shape the
 * bridge ops take. A bare "/Player" passes through with no scene. E6 finding F1: the
 * feel producer handed the QUALIFIED string as a bare path at seven sites and the
 * bridge refused every one; the split lives here, next to the templates that teach
 * the qualified form, so a producer cannot prescribe a format it does not parse.
 */
export function locatorParam(locator: string): { path: string; scene?: string } {
  const marker = locator.indexOf(":/");
  if (marker <= 0) return { path: locator };
  return { scene: locator.slice(0, marker), path: locator.slice(marker + 1) };
}
