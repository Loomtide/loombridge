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
  /**
   * THE GROUND FLAG, e.g. "grounded" (E6 session three). Optional, and the ONE
   * declaration that makes `coyoteTime` exact.
   *
   * The coyote sweep has to know the tick the controller ungrounded on. Without this
   * it can only read the first VISIBLE y-descent, and on a real rig those are not the
   * same tick: a ground probe smaller than the player's collider reads false while the
   * collider still rests on the ledge overhang, and the trajectory stays flat for as
   * long as the overhang lasts. On TideRunner that gap is two ticks and it moved the
   * measurement from 0.1000s to 0.0667s. The gap is a property of the RIG, so no fixed
   * correction is right for the next game.
   *
   * Declared, the sweep passes this field to `runtime.capture_input_motion` as a
   * `sampledFields` entry (that op samples it on the trajectory's own tick clock;
   * `runtime.probe` does not sample fields at all, ledger L71) and anchors on the last
   * still-true reading, which IS the ungrounding step. It must be a PUBLIC BOOL member
   * on `controllerComponent`, readable at run time.
   *
   * Absent, the sweep still measures: it anchors on the descent and the written
   * evidence says so, so a reader can tell an exact reading from a rig-dependent one.
   */
  grounded?: string;
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

/**
 * THE RUNWAY (E6 finding, TideRunner live run).
 *
 * The run leg holds the move key for a fixed number of physics ticks and the coyote
 * calibration walks the same way. Both were written with no notion of level geometry:
 * 90 ticks at 7 u/s is 10.5 units of travel, and on the first real level that had
 * hazards it drove the player into spikes three times, spent every heart, and the
 * game's own modal end state froze the rest of the session (the next run measured a
 * corpse: 218 samples at one point).
 *
 * So the RUNWAY is a fact about the level, and facts about the project's wiring live
 * here. Both fields are OPTIONAL and the defaults are exactly today's behaviour, so no
 * existing contract changes meaning:
 *
 *   - `ticks`     bounds the RUN LEG's hold, and only that. Travel is
 *                 `ticks × runSpeed × fixedTimestep`, so a level with 4 clear units
 *                 at 7 u/s wants ~34 ticks.
 *
 *                 IT DOES NOT BOUND THE COYOTE CALIBRATION WALK (E6 session three).
 *                 The two legs want opposite things on the same number: the run leg
 *                 must STAY on the ground for its whole hold, and the coyote walk must
 *                 LEAVE it. One bound cannot serve both on any real level, and while it
 *                 did, a runway short enough to keep the run leg safe refused the coyote
 *                 sweep outright ("no ledge within the walk window"). The coyote walk
 *                 now searches for the ledge under its own hard cap.
 *   - `direction` which way the safe runway lies. `-1` injects `keys.moveLeft` for
 *                 those legs and drives `fields.moveX` negative for the seam proof;
 *                 declaring it therefore REQUIRES `keys.moveLeft`.
 *
 * Neither field can change a MEASURED value: `runSpeed` is |Δx|/Δt and the sweep
 * derivations read |dx|, so a leftward runway measures the same number as a rightward
 * one. This is a safety bound on where the harness drives the player, not a knob on
 * what it reports.
 */
export interface FeelSeamRunLeg {
  /** Physics ticks of hold for the run leg and the coyote calibration walk. */
  ticks?: number;
  /** Which way the safe runway lies: `1` right (default), `-1` left. */
  direction?: 1 | -1;
}

/** Bounds on `runLeg.ticks`. Below 12 ticks the run window is shorter than the
 * settle prefix and an acceleration ramp IS the whole measurement; above 600 the leg
 * runs ten seconds and any level's runway has ended. Outside the range is a refusal,
 * never a clamp: a silently clamped value would measure something the contract did
 * not ask for. */
export const RUN_LEG_MIN_TICKS = 12;
export const RUN_LEG_MAX_TICKS = 600;

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
  /** Optional runway bound for the horizontal legs. Absent keeps today's defaults. */
  runLeg?: FeelSeamRunLeg;
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
      "fields": { "moveX": "moveX", "jumpHeld": "jumpHeld", "dashHeld": "dashHeld", "grounded": "grounded" },
      "keys": { "jump": "Space", "moveRight": "D", "moveLeft": "A", "jumpCut": "Space", "dash": "LeftShift" },
      "runLeg": { "ticks": 90, "direction": 1 }
    }
  }`;

/**
 * The note printed under the template. `runLeg` is optional and its defaults are
 * today's behaviour, so the template shows it but the refusal has to say it is not
 * required: otherwise an operator adds a bound they have not measured.
 */
export const FEEL_SEAM_RUNLEG_NOTE =
  `"runLeg" is OPTIONAL (defaults: ticks 90, direction 1). It bounds how far the RUN LEG drives the player, ` +
  `in physics ticks (travel = ticks x runSpeed x fixedTimestep), and which way it drives. Set it when the level ` +
  `has a hazard inside the default 90-tick runway; direction -1 also requires keys.moveLeft. It does NOT bound ` +
  `the coyote calibration walk (which must LEAVE the ground and so searches for the ledge on its own), and it ` +
  `cannot change a measured value.`;

/**
 * The note for `fields.grounded`. Its own sentence because it is the one optional
 * declaration that changes a MEASURED value's accuracy rather than the harness's
 * safety, and an operator who skips it gets a rig-dependent coyote reading.
 */
export const FEEL_SEAM_GROUNDED_NOTE =
  `"fields.grounded" is OPTIONAL: declare it when the controller exposes its ground probe (a public bool such ` +
  `as "grounded"). It makes the coyote anchor exact. Without it the sweep anchors on the first visible descent, ` +
  `which on a rig whose ground probe is smaller than the collider fires ticks after the controller ungrounded ` +
  `(TideRunner: two ticks, 0.0667s measured against a real 0.1000s). The evidence records which anchor was used.`;

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
      FEEL_SEAM_TEMPLATE +
      `\n\n${FEEL_SEAM_RUNLEG_NOTE}\n\n${FEEL_SEAM_GROUNDED_NOTE}`,
  };
}

/**
 * Resolve the optional runway bound, or refuse. Refuse-don't-clamp: an out-of-range
 * `ticks` means the operator meant something the harness will not do, and silently
 * substituting 90 would drive the player down a runway they said was not there.
 */
function resolveRunLeg(
  seam: Record<string, unknown>,
  keys: Record<string, unknown>,
): { ok: true; runLeg?: FeelSeamRunLeg } | { ok: false; what: string } {
  const raw = seam.runLeg;
  if (raw === undefined) return { ok: true };
  if (!isRecord(raw)) return { ok: false, what: "`harness.feelSeam.runLeg` is not an object" };

  const out: FeelSeamRunLeg = {};
  const ticks = raw.ticks;
  if (ticks !== undefined) {
    if (typeof ticks !== "number" || !Number.isInteger(ticks)) {
      return { ok: false, what: "`harness.feelSeam.runLeg.ticks` must be a whole number of physics ticks" };
    }
    if (ticks < RUN_LEG_MIN_TICKS || ticks > RUN_LEG_MAX_TICKS) {
      return {
        ok: false,
        what:
          `\`harness.feelSeam.runLeg.ticks\` is ${ticks}, outside [${RUN_LEG_MIN_TICKS}, ${RUN_LEG_MAX_TICKS}]. ` +
          "Below the floor the hold is shorter than the settle prefix and an acceleration ramp IS the whole " +
          "measurement; above the ceiling the leg drives for ten seconds and no level's runway is that long",
      };
    }
    out.ticks = ticks;
  }

  const direction = raw.direction;
  if (direction !== undefined) {
    if (direction !== 1 && direction !== -1) {
      return { ok: false, what: "`harness.feelSeam.runLeg.direction` must be 1 (right) or -1 (left)" };
    }
    if (direction === -1 && !isName(keys.moveLeft)) {
      return {
        ok: false,
        what:
          "`harness.feelSeam.runLeg.direction` is -1, so the keyed legs inject `keys.moveLeft`, and the seam " +
          "declares none. Add `keys.moveLeft` (the key that moves the player left)",
      };
    }
    out.direction = direction;
  }

  return { ok: true, ...(Object.keys(out).length > 0 ? { runLeg: out } : {}) };
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
  const runLeg = resolveRunLeg(seam, k);
  if (!runLeg.ok) return refuse(runLeg.what);
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
        ...(isName(f.grounded) ? { grounded: f.grounded.trim() } : {}),
      },
      keys: {
        jump: (k.jump as string).trim(),
        moveRight: (k.moveRight as string).trim(),
        ...(isName(k.moveLeft) ? { moveLeft: k.moveLeft.trim() } : {}),
        ...(isName(k.jumpCut) ? { jumpCut: k.jumpCut.trim() } : {}),
        ...(isName(k.dash) ? { dash: k.dash.trim() } : {}),
      },
      ...(runLeg.runLeg ? { runLeg: runLeg.runLeg } : {}),
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
