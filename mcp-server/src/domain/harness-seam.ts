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

export interface HarnessSection {
  feelSeam?: FeelSeam;
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

export type FeelSeamResolution =
  | { ok: true; seam: FeelSeam }
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
