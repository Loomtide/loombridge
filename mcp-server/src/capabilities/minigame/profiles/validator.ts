/**
 * 2D Kids Mini-Game contract validator (S6a).
 *
 * Hand-written, mirroring `genre-packs/platformer-2d/validator.ts`: a non-throwing
 * `validateMinigameContract` returning `{ valid, issues[] }`, plus a throwing
 * `assertValidMinigameContract` for load-time use.
 *
 * The rules are the anti-false-green moat for the mini-game contract (CLAUDE.md
 * "Verification / supervisor invariants" — an absent binding is a REFUSAL):
 *
 *   UNSUPPORTED_TYPE        type != "2d-kids-minigame"                    (wrong contract kind)
 *   MISSING_SCENES          no scenes declared                           (nothing to open)
 *   INVALID_SCENE_PATH      a scene path outside Assets/**.unity          (garbage path)
 *   UNKNOWN_AGE_BAND        ageBand outside AGE_BANDS                     (unmeasurable ergonomics)
 *   UNKNOWN_VISUAL_PROFILE  visualProfile outside VISUAL_PROFILES         (no aspect to check)
 *   INVALID_DEVICE          a devices[] entry has a bad id/label/width/height    (unrenderable device)
 *   DUPLICATE_DEVICE_ID     two devices[] entries share an id            (ambiguous capture filename)
 *   MISSING_STATES          no states declared                           (nothing to capture)
 *   UNKNOWN_STATE_KIND      a state.kind outside STATE_KINDS              (invented state role)
 *   INVALID_STATE_ID        a state.id not a filename-safe slug / has '@' (corrupts <state>.png / <state>@<device>)
 *   DUPLICATE_STATE_ID      two states share an id                       (ambiguous reference)
 *   STATE_SCENE_NOT_DECLARED a state.scene not in scenes[]               (invalid scene ref)
 *   UNKNOWN_STATE_OBJECT    a state requiredInFrame id not declared       (dangling object ref)
 *   MISSING_REQUIRED_OBJECTS no requiredInFrame objects                  (verifies nothing visible)
 *   DUPLICATE_OBJECT_ID     two object refs share an id                  (ambiguous reference)
 *   INVALID_LOCATOR         an object locator that names no path          (can't point a check)
 *   CONTRADICTORY_OFFSCREEN an id is both requiredInFrame and allowedOffscreen
 *   INVALID_TAP_TARGET      tapTargets.minSizeDp not a positive number    (no usable floor)
 *   IMPOSSIBLE_TAP_TARGET   minSizeDp below the age-band ergonomic floor  (unreachable bar)
 *   INVALID_SAFE_AREA       safe-area fractions out of range              (nonsense tolerance)
 *   UNKNOWN_THRESHOLD       an artifactThresholds key outside the set     (typo widens a gate)
 *   INVALID_THRESHOLD       a threshold value outside [0,1]               (nonsense tolerance)
 *   NO_DETERMINISTIC_CHECKS checks.deterministic empty/absent             (decides nothing in CI)
 *   UNSUPPORTED_CHECK       a deterministic/advisory check name unknown   (silently disabled check)
 *   FLOW_UNKNOWN_STATE      interactionFlow references an undeclared state
 *   FLOW_NO_REWARD          the happy path never reaches a success_reward state
 *   UNKNOWN_MASK_OBJECT     a baseline.masks entry not a declared object id      (typo disables a mask)
 *   OBJECT_CHECK_NO_BINDINGS an object-scoped check is enabled but NO state binds a
 *                           per-state requiredInFrame object — the check would grade
 *                           nothing (only vacuous passes), a green that verified nothing
 *   FLOW_NO_TRANSITIONS     interaction-flow enabled but happyPath has <2 states (no transition)
 *   FLOW_INDISTINCT_TRANSITION  happyPath repeats an adjacent state (ungradeable self-transition)
 *   MISSING_BACKGROUND_BINDING  background geometry enabled but no backgroundLayers / backgroundCamera
 *                           (the geometry gates would decide nothing — refuse-on-absent)
 */

import {
  AGE_BANDS,
  ARTIFACT_THRESHOLD_KEY_SET,
  isObjectLocator,
  isScenePath,
  MINIGAME_ADVISORY_CHECK_SET,
  MINIGAME_CONTRACT_SCHEMA_VERSION,
  MINIGAME_CONTRACT_TYPE,
  MINIGAME_DETERMINISTIC_CHECK_SET,
  MINIGAME_ID_PATTERN,
  STATE_ID_PATTERN,
  STATE_KIND_SET,
  VISUAL_PROFILE_IDS,
  type MinigameContract,
  type MinigameValidationIssue,
  type MinigameValidationResult,
} from "./types.js";
import { sceneSlug } from "../minigame-scene-inference.js";

const REACHED_CONDITION_OPERATORS: ReadonlySet<string> = new Set([
  "equals",
  "not_equals",
  "greater_than",
  "less_than",
  "approx",
  "contains",
]);

/**
 * Deterministic checks that grade objects taken from each state's per-state
 * `requiredInFrame`. If one of these is enabled but no state binds any object,
 * the check has nothing to grade (only vacuous passes) → `OBJECT_CHECK_NO_BINDINGS`.
 * (Frame-level checks — `no-black-bars`/`render-frame` — and `console-clean` grade
 * the frame/console, not per-state objects, so they are NOT in this set;
 * `background-fit` binds via `containers`; `interaction-flow` is deferred.)
 */
const OBJECT_SCOPED_CHECKS: ReadonlySet<string> = new Set([
  "required-in-frame",
  "safe-area",
  "tap-target-size",
  "text-clipping",
  "control-overlap",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function inUnitRange(value: unknown, { exclusiveMax = false } = {}): value is number {
  return isNumber(value) && value >= 0 && (exclusiveMax ? value < 1 : value <= 1);
}

function push(
  issues: MinigameValidationIssue[],
  code: string,
  message: string,
  path: string,
): void {
  issues.push({ code, message, path });
}

/** Filename-safe device id (used later as `<state>@<id>.png`). */
const DEVICE_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
/** Matches the bridge's Game-View size clamp. */
const DEVICE_DIM_MIN = 16;
const DEVICE_DIM_MAX = 8192;

function isPositiveIntInRange(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= DEVICE_DIM_MIN &&
    value <= DEVICE_DIM_MAX
  );
}

/**
 * Validate an OPTIONAL contract `devices` override (Phase 2). Absent = use the
 * profile default, so nothing to check. When present it must be a non-empty
 * array of well-formed devices with unique, filename-safe ids.
 */
function validateDevices(input: Record<string, unknown>, issues: MinigameValidationIssue[]): void {
  if (input.devices === undefined) return;

  if (!Array.isArray(input.devices) || input.devices.length === 0) {
    push(
      issues,
      "INVALID_DEVICE",
      "devices, when present, must be a non-empty array of device specs.",
      "devices",
    );
    return;
  }

  const seenIds = new Set<string>();
  input.devices.forEach((device, i) => {
    const at = `devices[${i}]`;
    if (!isRecord(device)) {
      push(issues, "INVALID_DEVICE", `${at} must be an object.`, at);
      return;
    }

    if (typeof device.id !== "string" || !DEVICE_ID_PATTERN.test(device.id)) {
      push(
        issues,
        "INVALID_DEVICE",
        `${at}.id '${String(device.id)}' must be a filename-safe slug (${DEVICE_ID_PATTERN}).`,
        `${at}.id`,
      );
    } else if (seenIds.has(device.id)) {
      push(
        issues,
        "DUPLICATE_DEVICE_ID",
        `${at}.id '${device.id}' is declared more than once; device ids must be unique.`,
        `${at}.id`,
      );
    } else {
      seenIds.add(device.id);
    }

    if (!isString(device.label)) {
      push(issues, "INVALID_DEVICE", `${at}.label must be a non-empty string.`, `${at}.label`);
    }

    if (!isPositiveIntInRange(device.width)) {
      push(
        issues,
        "INVALID_DEVICE",
        `${at}.width must be a positive integer in [${DEVICE_DIM_MIN}, ${DEVICE_DIM_MAX}].`,
        `${at}.width`,
      );
    }
    if (!isPositiveIntInRange(device.height)) {
      push(
        issues,
        "INVALID_DEVICE",
        `${at}.height must be a positive integer in [${DEVICE_DIM_MIN}, ${DEVICE_DIM_MAX}].`,
        `${at}.height`,
      );
    }
  });
}

function validateScenes(input: Record<string, unknown>, issues: MinigameValidationIssue[]): Set<string> {
  const scenes = new Set<string>();
  if (!Array.isArray(input.scenes) || input.scenes.length === 0) {
    push(issues, "MISSING_SCENES", "scenes must list at least one Unity scene.", "scenes");
    return scenes;
  }
  input.scenes.forEach((scene, i) => {
    if (!isScenePath(scene)) {
      push(
        issues,
        "INVALID_SCENE_PATH",
        `scenes[${i}] '${String(scene)}' must be an Assets/**.unity path (no '..'/'.' segments, no backslashes).`,
        `scenes[${i}]`,
      );
    } else {
      scenes.add(scene);
    }
  });
  return scenes;
}

/** Validate requiredInFrame + allowedOffscreen; returns the set of declared object ids. */
function validateObjects(
  input: Record<string, unknown>,
  issues: MinigameValidationIssue[],
): Set<string> {
  const ids = new Set<string>();

  const validateRefList = (list: unknown, field: string, requireNonEmpty: boolean): void => {
    if (list === undefined && !requireNonEmpty) return;
    if (!Array.isArray(list) || (requireNonEmpty && list.length === 0)) {
      if (requireNonEmpty) {
        push(
          issues,
          "MISSING_REQUIRED_OBJECTS",
          `${field} must declare at least one object that the verifier can check.`,
          field,
        );
      } else {
        push(issues, "INVALID_FIELD", `${field} must be an array of object refs.`, field);
      }
      return;
    }
    list.forEach((ref, i) => {
      const p = `${field}[${i}]`;
      if (!isRecord(ref)) {
        push(issues, "INVALID_FIELD", `${p} must be an object ref { id, locator }.`, p);
        return;
      }
      if (!isString(ref.id)) {
        push(issues, "MISSING_FIELD", `${p}.id is required.`, `${p}.id`);
      } else if (ids.has(ref.id)) {
        push(issues, "DUPLICATE_OBJECT_ID", `${p}.id '${ref.id}' is declared more than once.`, `${p}.id`);
      } else {
        ids.add(ref.id);
      }
      if (!isObjectLocator(ref.locator)) {
        push(
          issues,
          "INVALID_LOCATOR",
          `${p}.locator must be a scene-object path (e.g. "Scene:/Canvas/Tile"); got '${String(ref.locator)}'.`,
          `${p}.locator`,
        );
      }
    });
  };

  // requiredInFrame is REQUIRED and non-empty — a contract that requires nothing
  // visible verifies nothing.
  validateRefList(input.requiredInFrame, "requiredInFrame", true);
  validateRefList(input.allowedOffscreen, "allowedOffscreen", false);

  // An object cannot be both required-in-frame AND explicitly allowed offscreen.
  if (Array.isArray(input.requiredInFrame) && Array.isArray(input.allowedOffscreen)) {
    const required = new Set(
      input.requiredInFrame.filter(isRecord).map((r) => r.id).filter(isString),
    );
    input.allowedOffscreen.filter(isRecord).forEach((r, i) => {
      if (isString(r.id) && required.has(r.id)) {
        push(
          issues,
          "CONTRADICTORY_OFFSCREEN",
          `allowedOffscreen[${i}].id '${r.id}' is also requiredInFrame — pick one.`,
          `allowedOffscreen[${i}].id`,
        );
      }
    });
  }

  return ids;
}

function validateStates(
  input: Record<string, unknown>,
  scenes: Set<string>,
  objectIds: Set<string>,
  issues: MinigameValidationIssue[],
): Set<string> {
  const stateIds = new Set<string>();
  // A state's `scene` is the runtime NAME (e.g. `GameHub`) while `scenes` holds asset PATHS
  // (`Assets/Scenes/GameHub.unity`) — the documented multi-scene convention. Reconcile the two by
  // slug so a name matches its path, exactly as the contract-fusion referential-integrity net does.
  // `findSlugCollisions` already refuses two DISTINCT scenes sharing a slug before fusion, so this can't
  // mis-bind a state to the wrong scene.
  const sceneSlugs = new Set<string>([...scenes].map(sceneSlug));
  if (!Array.isArray(input.states) || input.states.length === 0) {
    push(issues, "MISSING_STATES", "states must declare at least one named capture state.", "states");
    return stateIds;
  }
  input.states.forEach((state, i) => {
    const p = `states[${i}]`;
    if (!isRecord(state)) {
      push(issues, "INVALID_FIELD", `${p} must be an object.`, p);
      return;
    }
    if (!isString(state.id)) {
      push(issues, "MISSING_FIELD", `${p}.id is required.`, `${p}.id`);
    } else if (!STATE_ID_PATTERN.test(state.id)) {
      // A state id becomes a `<state>.png` filename and the LOGICAL half of a
      // `<state>@<device>` key; an `@` (or other non-slug char) would corrupt the
      // capture filenames and `splitStateDevice`. Refuse it. (Low-1 fix.)
      push(
        issues,
        "INVALID_STATE_ID",
        `${p}.id '${state.id}' must be a filename-safe slug (${STATE_ID_PATTERN}) with no '@' (the device delimiter).`,
        `${p}.id`,
      );
    } else if (stateIds.has(state.id)) {
      push(issues, "DUPLICATE_STATE_ID", `${p}.id '${state.id}' is declared more than once.`, `${p}.id`);
    } else {
      stateIds.add(state.id);
    }
    if (!isString(state.kind) || !STATE_KIND_SET.has(state.kind)) {
      push(
        issues,
        "UNKNOWN_STATE_KIND",
        `${p}.kind '${String(state.kind)}' is not a known state kind (${[...STATE_KIND_SET].join(", ")}).`,
        `${p}.kind`,
      );
    }
    if (
      state.scene !== undefined
      && !scenes.has(state.scene as string)
      && !sceneSlugs.has(sceneSlug(state.scene as string))
    ) {
      push(
        issues,
        "STATE_SCENE_NOT_DECLARED",
        `${p}.scene '${String(state.scene)}' is not one of the declared scenes.`,
        `${p}.scene`,
      );
    }
    if (state.requiredInFrame !== undefined) {
      if (!Array.isArray(state.requiredInFrame)) {
        push(issues, "INVALID_FIELD", `${p}.requiredInFrame must be an array of object ids.`, `${p}.requiredInFrame`);
      } else {
        state.requiredInFrame.forEach((ref, j) => {
          if (!isString(ref) || !objectIds.has(ref)) {
            push(
              issues,
              "UNKNOWN_STATE_OBJECT",
              `${p}.requiredInFrame[${j}] '${String(ref)}' is not a declared requiredInFrame object id.`,
              `${p}.requiredInFrame[${j}]`,
            );
          }
        });
      }
    }
    if (state.outcomeGated !== undefined && typeof state.outcomeGated !== "boolean") {
      push(issues, "INVALID_FIELD", `${p}.outcomeGated must be a boolean.`, `${p}.outcomeGated`);
    }
    validateInputResponse(state.inputResponse, `${p}.inputResponse`, objectIds, issues);
    validateReachedCondition(state.reached, `${p}.reached`, issues);
  });
  return stateIds;
}

/** Validate an optional `state.inputResponse`: tap + observe must be declared object ids. */
function validateInputResponse(
  ir: unknown,
  p: string,
  objectIds: Set<string>,
  issues: MinigameValidationIssue[],
): void {
  if (ir === undefined) return;
  if (!isRecord(ir)) {
    push(issues, "INVALID_FIELD", `${p} must be an object.`, p);
    return;
  }
  if (!isString(ir.tap) || !objectIds.has(ir.tap)) {
    push(issues, "UNKNOWN_STATE_OBJECT", `${p}.tap '${String(ir.tap)}' is not a declared requiredInFrame object id.`, `${p}.tap`);
  }
  if (!Array.isArray(ir.observe) || ir.observe.length === 0) {
    push(issues, "INVALID_FIELD", `${p}.observe must be a non-empty array of object ids that must change.`, `${p}.observe`);
  } else {
    ir.observe.forEach((ref, j) => {
      if (!isString(ref) || !objectIds.has(ref)) {
        push(issues, "UNKNOWN_STATE_OBJECT", `${p}.observe[${j}] '${String(ref)}' is not a declared requiredInFrame object id.`, `${p}.observe[${j}]`);
      }
    });
  }
  if (ir.expect !== undefined && ir.expect !== "changed") {
    push(issues, "INVALID_FIELD", `${p}.expect must be "changed" (the only supported relation).`, `${p}.expect`);
  }
}

function validateReachedCondition(
  reached: unknown,
  p: string,
  issues: MinigameValidationIssue[],
): void {
  if (reached === undefined) return;
  if (!isRecord(reached)) {
    push(issues, "INVALID_REACHED_CONDITION", `${p} must be an object.`, p);
    return;
  }
  if (!isObjectLocator(reached.locator)) {
    push(
      issues,
      "INVALID_REACHED_CONDITION",
      `${p}.locator must be a non-empty contract locator string (e.g. "Scene:/Canvas/GameManager").`,
      `${p}.locator`,
    );
  }
  if (!isString(reached.property_path)) {
    push(
      issues,
      "INVALID_REACHED_CONDITION",
      `${p}.property_path is required and must be a non-empty string.`,
      `${p}.property_path`,
    );
  }
  if (!isString(reached.operator) || !REACHED_CONDITION_OPERATORS.has(reached.operator)) {
    push(
      issues,
      "INVALID_REACHED_CONDITION",
      `${p}.operator must be one of ${[...REACHED_CONDITION_OPERATORS].join(", ")}.`,
      `${p}.operator`,
    );
  }
  if (!Object.prototype.hasOwnProperty.call(reached, "expected")) {
    push(
      issues,
      "INVALID_REACHED_CONDITION",
      `${p}.expected is required.`,
      `${p}.expected`,
    );
  }
  if (reached.component !== undefined && !isString(reached.component)) {
    push(issues, "INVALID_REACHED_CONDITION", `${p}.component must be a non-empty string when present.`, `${p}.component`);
  }
  if (reached.tolerance !== undefined && !isNumber(reached.tolerance)) {
    push(issues, "INVALID_REACHED_CONDITION", `${p}.tolerance must be a finite number when present.`, `${p}.tolerance`);
  }
  if (reached.timeoutMs !== undefined && (!isNumber(reached.timeoutMs) || reached.timeoutMs < 0)) {
    push(issues, "INVALID_REACHED_CONDITION", `${p}.timeoutMs must be a non-negative number when present.`, `${p}.timeoutMs`);
  }
}

function validateAgeAndTapTargets(input: Record<string, unknown>, issues: MinigameValidationIssue[]): void {
  const bandSpec = isString(input.ageBand) ? AGE_BANDS[input.ageBand] : undefined;
  if (!isString(input.ageBand)) {
    push(issues, "MISSING_FIELD", "ageBand is required.", "ageBand");
  } else if (!bandSpec) {
    push(
      issues,
      "UNKNOWN_AGE_BAND",
      `ageBand '${input.ageBand}' is not a known age band (${Object.keys(AGE_BANDS).join(", ")}).`,
      "ageBand",
    );
  }

  if (!isRecord(input.tapTargets)) {
    push(issues, "MISSING_FIELD", "tapTargets is required.", "tapTargets");
    return;
  }
  const minSize = input.tapTargets.minSizeDp;
  if (!isNumber(minSize) || minSize <= 0) {
    push(issues, "INVALID_TAP_TARGET", "tapTargets.minSizeDp must be a positive number (dp).", "tapTargets.minSizeDp");
    return;
  }
  // Impossible setting: a declared minimum below the ergonomic floor for the age
  // the game claims to serve could never satisfy the band — refuse it up front.
  if (bandSpec && minSize < bandSpec.minTapTargetDp) {
    push(
      issues,
      "IMPOSSIBLE_TAP_TARGET",
      `tapTargets.minSizeDp ${minSize}dp is below the ${bandSpec.minTapTargetDp}dp floor for age band '${bandSpec.id}'.`,
      "tapTargets.minSizeDp",
    );
  }
}

function validateSafeAreas(input: Record<string, unknown>, issues: MinigameValidationIssue[]): void {
  if (!isRecord(input.uiSafeAreas)) {
    push(issues, "MISSING_FIELD", "uiSafeAreas is required.", "uiSafeAreas");
    return;
  }
  if (!inUnitRange(input.uiSafeAreas.maxOverflowFraction)) {
    push(
      issues,
      "INVALID_SAFE_AREA",
      "uiSafeAreas.maxOverflowFraction must be a fraction in [0,1].",
      "uiSafeAreas.maxOverflowFraction",
    );
  }
  const insets = input.uiSafeAreas.insets;
  if (insets !== undefined) {
    if (!isRecord(insets)) {
      push(issues, "INVALID_SAFE_AREA", "uiSafeAreas.insets must be an object.", "uiSafeAreas.insets");
    } else {
      for (const edge of ["top", "bottom", "left", "right"] as const) {
        if (insets[edge] !== undefined && !inUnitRange(insets[edge], { exclusiveMax: true })) {
          push(
            issues,
            "INVALID_SAFE_AREA",
            `uiSafeAreas.insets.${edge} must be a fraction in [0,1).`,
            `uiSafeAreas.insets.${edge}`,
          );
        }
      }
    }
  }
}

function validateThresholds(input: Record<string, unknown>, issues: MinigameValidationIssue[]): void {
  if (!isRecord(input.artifactThresholds)) {
    push(issues, "MISSING_FIELD", "artifactThresholds is required (may be an empty object).", "artifactThresholds");
    return;
  }
  for (const [key, value] of Object.entries(input.artifactThresholds)) {
    const p = `artifactThresholds.${key}`;
    if (!ARTIFACT_THRESHOLD_KEY_SET.has(key)) {
      push(
        issues,
        "UNKNOWN_THRESHOLD",
        `${p} is not a known artifact threshold (${[...ARTIFACT_THRESHOLD_KEY_SET].join(", ")}).`,
        p,
      );
    } else if (!inUnitRange(value)) {
      push(issues, "INVALID_THRESHOLD", `${p} must be a fraction in [0,1].`, p);
    }
  }
}

function validateChecks(input: Record<string, unknown>, issues: MinigameValidationIssue[]): void {
  if (!isRecord(input.checks)) {
    push(issues, "NO_DETERMINISTIC_CHECKS", "checks is required and must enable ≥1 deterministic check.", "checks");
    return;
  }
  const det = input.checks.deterministic;
  if (!Array.isArray(det) || det.length === 0) {
    push(
      issues,
      "NO_DETERMINISTIC_CHECKS",
      "checks.deterministic must enable at least one CI-deciding check — a contract that decides nothing is refused.",
      "checks.deterministic",
    );
  } else {
    det.forEach((name, i) => {
      if (!isString(name) || !MINIGAME_DETERMINISTIC_CHECK_SET.has(name)) {
        push(
          issues,
          "UNSUPPORTED_CHECK",
          `checks.deterministic[${i}] '${String(name)}' is not a supported deterministic check.`,
          `checks.deterministic[${i}]`,
        );
      }
    });
  }
  if (input.checks.advisory !== undefined) {
    if (!Array.isArray(input.checks.advisory)) {
      push(issues, "INVALID_FIELD", "checks.advisory must be an array.", "checks.advisory");
    } else {
      input.checks.advisory.forEach((name, i) => {
        if (!isString(name) || !MINIGAME_ADVISORY_CHECK_SET.has(name)) {
          push(
            issues,
            "UNSUPPORTED_CHECK",
            `checks.advisory[${i}] '${String(name)}' is not a supported advisory check.`,
            `checks.advisory[${i}]`,
          );
        }
      });
    }
  }
}

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/**
 * Validate `containers` (the background-fit bindings). Each `background`/`content`
 * must reference a declared object id, colours must be `#RRGGBB`, and a fill
 * fraction must be in [0,1]. A binding whose background is also in its own content
 * is contradictory. `background-fit`-enabled-without-containers is enforced by the
 * caller (a check that decides nothing is refused — the anti-false-green stance).
 */
function validateContainers(
  input: Record<string, unknown>,
  objectIds: Set<string>,
  issues: MinigameValidationIssue[],
): void {
  if (input.containers === undefined) return;
  if (!Array.isArray(input.containers)) {
    push(issues, "INVALID_FIELD", "containers must be an array of background→content bindings.", "containers");
    return;
  }
  input.containers.forEach((binding, i) => {
    const p = `containers[${i}]`;
    if (!isRecord(binding)) {
      push(issues, "INVALID_FIELD", `${p} must be an object { background, ... }.`, p);
      return;
    }
    if (!isString(binding.background)) {
      push(issues, "MISSING_FIELD", `${p}.background is required.`, `${p}.background`);
    } else if (!objectIds.has(binding.background)) {
      push(issues, "UNKNOWN_CONTAINER_BACKGROUND", `${p}.background '${binding.background}' is not a declared object id.`, `${p}.background`);
    }
    if (binding.content !== undefined) {
      if (!Array.isArray(binding.content)) {
        push(issues, "INVALID_FIELD", `${p}.content must be an array of object ids.`, `${p}.content`);
      } else {
        binding.content.forEach((id, j) => {
          if (!isString(id) || !objectIds.has(id)) {
            push(issues, "UNKNOWN_CONTAINER_CONTENT", `${p}.content[${j}] '${String(id)}' is not a declared object id.`, `${p}.content[${j}]`);
          } else if (id === binding.background) {
            push(issues, "CONTAINER_SELF_CONTENT", `${p}.content[${j}] '${id}' is also the background — pick one.`, `${p}.content[${j}]`);
          }
        });
      }
    }
    if (binding.bgColor !== undefined && (typeof binding.bgColor !== "string" || !HEX_COLOR.test(binding.bgColor))) {
      push(issues, "INVALID_CONTAINER_COLOR", `${p}.bgColor must be a #RRGGBB hex colour.`, `${p}.bgColor`);
    }
    if (
      binding.minBgFillFraction !== undefined &&
      !(typeof binding.minBgFillFraction === "number" && binding.minBgFillFraction > 0 && binding.minBgFillFraction <= 1)
    ) {
      push(
        issues,
        "INVALID_CONTAINER_FILL",
        `${p}.minBgFillFraction must be a fraction in (0,1] — 0 would make background-fit an always-pass gate.`,
        `${p}.minBgFillFraction`,
      );
    }
  });
}

/**
 * Validate the background geometry bindings (Phase 5). When either background geometry check
 * (`background-coverage` or `background-seam`) is enabled the
 * contract MUST declare a non-empty `backgroundLayers` (each a non-empty scene locator)
 * AND a non-empty `backgroundCamera` locator — mirroring how `background-fit` requires
 * `containers`. A declared-but-unbound check decides nothing → `MISSING_BACKGROUND_BINDING`
 * (refuse-on-absent). When the check is OFF the fields are optional and ignored.
 */
function validateBackgroundGeometry(
  input: Record<string, unknown>,
  det: unknown[],
  issues: MinigameValidationIssue[],
): void {
  const enabled = det.filter((c) => c === "background-coverage" || c === "background-seam") as string[];
  if (enabled.length === 0) return;
  const checks = enabled.join(", ");

  if (!Array.isArray(input.backgroundLayers) || input.backgroundLayers.length === 0) {
    push(
      issues,
      "MISSING_BACKGROUND_BINDING",
      `checks.deterministic enables [${checks}] but no backgroundLayers are declared — the gate would decide nothing (it needs the world-space background sprites to test coverage/seams).`,
      "backgroundLayers",
    );
  } else {
    input.backgroundLayers.forEach((layer, i) => {
      if (!isObjectLocator(layer)) {
        push(
          issues,
          "INVALID_LOCATOR",
          `backgroundLayers[${i}] must be a scene-object path (e.g. "Scene:/Background/Sky"); got '${String(layer)}'.`,
          `backgroundLayers[${i}]`,
        );
      }
    });
  }

  if (!isObjectLocator(input.backgroundCamera)) {
    push(
      issues,
      "MISSING_BACKGROUND_BINDING",
      `checks.deterministic enables [${checks}] but backgroundCamera is not a usable scene locator (got '${String(input.backgroundCamera)}') — the gate needs the rendering camera to build its per-aspect view rect.`,
      "backgroundCamera",
    );
  }
}

/**
 * Validate the OPTIONAL `stateSignal` — the declared game-phase field `minigame next`
 * threads into the printed `--state-signal <path>:<Component>:<property>` command. Absent ⇒
 * valid. When present: `locator` is a non-empty bare hierarchy path with NO `:` (the CLI
 * splits the flag on `:`, so a `:` in the path would corrupt the parse), `property` is a
 * non-empty string, and `component` (optional) is a non-empty string when present.
 */
function validateStateSignal(input: Record<string, unknown>, issues: MinigameValidationIssue[]): void {
  if (input.stateSignal === undefined) return;
  const ss = input.stateSignal;
  if (!isRecord(ss)) {
    push(issues, "INVALID_STATE_SIGNAL", "stateSignal, when present, must be an object { locator, property, component? }.", "stateSignal");
    return;
  }
  if (!isString(ss.locator)) {
    push(issues, "INVALID_STATE_SIGNAL", "stateSignal.locator must be a non-empty bare hierarchy path.", "stateSignal.locator");
  } else if (ss.locator.includes(":")) {
    push(
      issues,
      "INVALID_STATE_SIGNAL",
      `stateSignal.locator '${ss.locator}' must not contain ':' — it is a BARE hierarchy path (the --state-signal flag is parsed as <path>:<Component>:<property> on ':').`,
      "stateSignal.locator",
    );
  }
  if (!isString(ss.property)) {
    push(issues, "INVALID_STATE_SIGNAL", "stateSignal.property must be a non-empty string (the phase property name).", "stateSignal.property");
  }
  if (ss.component !== undefined && !isString(ss.component)) {
    push(issues, "INVALID_STATE_SIGNAL", "stateSignal.component must be a non-empty string when present.", "stateSignal.component");
  }
}

function validateInteractionFlow(
  input: Record<string, unknown>,
  stateIds: Set<string>,
  issues: MinigameValidationIssue[],
): void {
  if (!isRecord(input.interactionFlow) || !Array.isArray(input.interactionFlow.happyPath)) {
    push(issues, "MISSING_FIELD", "interactionFlow.happyPath must be an array of state ids.", "interactionFlow.happyPath");
    return;
  }
  const path = input.interactionFlow.happyPath;
  if (path.length === 0) {
    push(issues, "INVALID_FIELD", "interactionFlow.happyPath must not be empty.", "interactionFlow.happyPath");
    return;
  }
  path.forEach((id, i) => {
    if (!isString(id) || !stateIds.has(id)) {
      push(
        issues,
        "FLOW_UNKNOWN_STATE",
        `interactionFlow.happyPath[${i}] '${String(id)}' is not a declared state id.`,
        `interactionFlow.happyPath[${i}]`,
      );
    }
  });

  // The happy path must actually reach a reward (S6: "core flow reaches
  // success/reward"). A flow that never wins can't prove the loop closes.
  const states = Array.isArray(input.states) ? input.states.filter(isRecord) : [];
  const kindById = new Map(states.map((s) => [s.id as string, s.kind as string]));
  const reachesReward = path.some((id) => kindById.get(id as string) === "success_reward");
  if (!reachesReward) {
    push(
      issues,
      "FLOW_NO_REWARD",
      "interactionFlow.happyPath must include a 'success_reward' state — the flow must reach a reward.",
      "interactionFlow.happyPath",
    );
  }
}

export function validateMinigameContract(input: unknown): MinigameValidationResult {
  const issues: MinigameValidationIssue[] = [];

  if (!isRecord(input)) {
    push(issues, "INVALID_DOCUMENT", "Contract must be an object.", "contract");
    return { valid: false, issues };
  }

  if (input.schemaVersion !== MINIGAME_CONTRACT_SCHEMA_VERSION) {
    push(issues, "INVALID_SCHEMA_VERSION", `schemaVersion must be '${MINIGAME_CONTRACT_SCHEMA_VERSION}'.`, "schemaVersion");
  }

  if (!isString(input.id)) {
    push(issues, "MISSING_FIELD", "id is required.", "id");
  } else if (!MINIGAME_ID_PATTERN.test(input.id)) {
    push(issues, "INVALID_ID", `id '${input.id}' must match ${MINIGAME_ID_PATTERN} (lowercase kebab).`, "id");
  }

  if (input.type !== MINIGAME_CONTRACT_TYPE) {
    push(issues, "UNSUPPORTED_TYPE", `type must be '${MINIGAME_CONTRACT_TYPE}'.`, "type");
  }

  if (!isString(input.visualProfile)) {
    push(issues, "MISSING_FIELD", "visualProfile is required.", "visualProfile");
  } else if (!VISUAL_PROFILE_IDS.has(input.visualProfile)) {
    push(
      issues,
      "UNKNOWN_VISUAL_PROFILE",
      `visualProfile '${input.visualProfile}' is not a known visual profile (${[...VISUAL_PROFILE_IDS].join(", ")}).`,
      "visualProfile",
    );
  }

  validateDevices(input, issues);

  const scenes = validateScenes(input, issues);
  const objectIds = validateObjects(input, issues);
  const stateIds = validateStates(input, scenes, objectIds, issues);
  validateAgeAndTapTargets(input, issues);
  validateSafeAreas(input, issues);
  validateThresholds(input, issues);
  validateChecks(input, issues);
  validateContainers(input, objectIds, issues);
  validateInteractionFlow(input, stateIds, issues);
  validateStateSignal(input, issues);

  // `background-fit` decides nothing without container bindings — refuse it (the
  // closed-vocab/anti-false-green stance: a defined-but-unwired check is a refusal).
  const det = isRecord(input.checks) && Array.isArray(input.checks.deterministic)
    ? input.checks.deterministic
    : [];
  if (det.includes("background-fit")) {
    const hasContainers = Array.isArray(input.containers) && input.containers.length > 0;
    if (!hasContainers) {
      push(
        issues,
        "BACKGROUND_FIT_NO_CONTAINERS",
        "checks.deterministic enables 'background-fit' but no containers are declared — the gate would decide nothing.",
        "containers",
      );
    }
  }

  // Background geometry gates grade world-space geometry: the declared background
  // layer sprites must cover the declared camera's view rect and hide interior cut
  // edges at every device aspect. They decide nothing without those bindings — refuse
  // it (the same anti-false-green stance as BACKGROUND_FIT_NO_CONTAINERS).
  validateBackgroundGeometry(input, det, issues);

  // The object-scoped gates grade objects drawn from each state's per-state
  // `requiredInFrame`. If one is enabled but NO state declares any per-state
  // requiredInFrame object, the gate binds nothing in any state and would emit
  // only vacuous "nothing to check here" passes — an authoritative green that
  // verified nothing (the cardinal anti-false-green sin). Refuse it, same stance
  // as BACKGROUND_FIT_NO_CONTAINERS / NO_DETERMINISTIC_CHECKS. (A contract may
  // still have SOME object-less states — a loading/transition state — as long as
  // at least one state binds an object for the enabled checks to grade.)
  const enabledObjectChecks = det.filter((c) => OBJECT_SCOPED_CHECKS.has(c as string));
  if (enabledObjectChecks.length > 0) {
    const states = Array.isArray(input.states) ? input.states.filter(isRecord) : [];
    const anyStateBindsObject = states.some(
      (s) => Array.isArray(s.requiredInFrame) && s.requiredInFrame.some((id) => isString(id)),
    );
    if (!anyStateBindsObject) {
      push(
        issues,
        "OBJECT_CHECK_NO_BINDINGS",
        `checks.deterministic enables object-scoped check(s) [${enabledObjectChecks.join(", ")}] but no state declares a per-state requiredInFrame object — the check(s) would grade nothing (only vacuous passes). Bind required objects to the states they must appear in.`,
        "states",
      );
    }
  }

  // `interaction-flow` (S6d) grades TRANSITIONS — consecutive `happyPath` pairs. If
  // it is enabled but the happy path has fewer than 2 states there is no transition
  // to grade (decides nothing → refuse, same anti-"decides nothing" stance). An
  // adjacent-duplicate state would make a transition's "left the source" re-derivation
  // vacuous, so those are refused too.
  if (det.includes("interaction-flow")) {
    const happy =
      isRecord(input.interactionFlow) && Array.isArray(input.interactionFlow.happyPath)
        ? input.interactionFlow.happyPath
        : [];
    if (happy.length < 2) {
      push(
        issues,
        "FLOW_NO_TRANSITIONS",
        "checks.deterministic enables 'interaction-flow' but interactionFlow.happyPath has fewer than 2 states — there is no transition to grade.",
        "interactionFlow.happyPath",
      );
    }
    for (let i = 0; i + 1 < happy.length; i += 1) {
      if (isString(happy[i]) && happy[i] === happy[i + 1]) {
        push(
          issues,
          "FLOW_INDISTINCT_TRANSITION",
          `interactionFlow.happyPath[${i}]→[${i + 1}] repeats state '${String(happy[i])}' — a transition to the same state cannot be graded.`,
          `interactionFlow.happyPath[${i + 1}]`,
        );
      }
    }
  }

  // `input-response` grades a DECLARED liveness (`state.inputResponse`). The check and the
  // declaration must BOTH be present — otherwise the liveness is silently never graded
  // (the "defined-but-not-wired = silent skip" footgun). Refuse BOTH directions:
  //   - enabled but nothing declares it → grades nothing (vacuous) → INPUT_RESPONSE_NO_BINDINGS
  //   - declared but the check is off  → never graded (silent skip) → INPUT_RESPONSE_DECLARED_NOT_ENABLED
  {
    const states = Array.isArray(input.states) ? input.states : [];
    const anyDeclared = states.some((s) => isRecord(s) && s.inputResponse !== undefined);
    const enabled = det.includes("input-response");
    if (enabled && !anyDeclared) {
      push(
        issues,
        "INPUT_RESPONSE_NO_BINDINGS",
        "checks.deterministic enables 'input-response' but no state declares an `inputResponse` (tap + observe) — the check would grade nothing. Declare it on the gameplay state (typically `active`).",
        "states",
      );
    } else if (!enabled && anyDeclared) {
      push(
        issues,
        "INPUT_RESPONSE_DECLARED_NOT_ENABLED",
        "a state declares `inputResponse` but checks.deterministic does not enable 'input-response' — the liveness would be silently never checked. Enable the check, or remove the declaration.",
        "checks.deterministic",
      );
    }
  }

  // baseline is optional (regression is a later slice) — validate its shape AND
  // that every mask references a DECLARED object id. A mask is a closed reference,
  // not free text: a typo'd mask would silently disable a baseline-diff exclusion
  // later (the same anti-false-green concern the closed check vocab guards).
  if (input.baseline !== undefined) {
    if (!isRecord(input.baseline) || !isString(input.baseline.ref)) {
      push(issues, "INVALID_FIELD", "baseline, when present, must be an object with a 'ref' string.", "baseline");
    } else if (input.baseline.masks !== undefined) {
      if (!Array.isArray(input.baseline.masks)) {
        push(issues, "INVALID_FIELD", "baseline.masks must be an array of object ids.", "baseline.masks");
      } else {
        input.baseline.masks.forEach((mask, i) => {
          if (!isString(mask) || !objectIds.has(mask)) {
            push(
              issues,
              "UNKNOWN_MASK_OBJECT",
              `baseline.masks[${i}] '${String(mask)}' is not a declared requiredInFrame/allowedOffscreen object id.`,
              `baseline.masks[${i}]`,
            );
          }
        });
      }
    }
  }

  return { valid: issues.length === 0, issues };
}

/** Throwing variant for load-time use — summarises every issue. */
export function assertValidMinigameContract(input: unknown): MinigameContract {
  const result = validateMinigameContract(input);
  if (!result.valid) {
    const summary = result.issues.map((i) => `  - [${i.code}] ${i.path}: ${i.message}`).join("\n");
    throw new Error(`Mini-game contract validation failed:\n${summary}`);
  }
  return input as MinigameContract;
}
