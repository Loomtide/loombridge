import type {
  AcceptanceContract,
  AcceptanceValidationIssue,
  AcceptanceValidationResult,
  NumericTarget,
} from "./types.js";
import { ACCEPTANCE_SCHEMA_VERSION, PROP_PURPOSE_ROLES } from "./types.js";
import { isSafeCapturePath } from "../../domain/capture-paths.js";
import { EVIDENCE_CLASS_SET, EVIDENCE_CLASSES } from "./gates/evidence-classes.js";

const HEX_PATTERN = /^#[0-9a-fA-F]{6}$/;
const HUD_ANCHORS = new Set([
  "top-left",
  "top-center",
  "top-right",
  "center",
  "bottom-left",
  "bottom-center",
  "bottom-right",
]);
const MANIFEST_MATCHING = new Set(["exact", "prefix", "regex"]);
const MANIFEST_TYPES = new Set(["GameObject", "Sprite", "Prefab"]);
const GATE_MODES = new Set(["required", "not_applicable"]);
const WIN_END_STATE_MODES = new Set(["modal", "continuous"]);

/** The closed prop-role set, shared with the `PropPurposeRole` union in types.ts. */
const PROP_PURPOSE_ROLE_SET: ReadonlySet<string> = new Set<string>(PROP_PURPOSE_ROLES);

const GATE_TUNING_NUMBER_FIELDS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["platform-tiles", new Set(["tileIntegerTolerance", "colliderSurfaceToleranceU"])],
  ["tile-render", new Set(["tileRenderSeamToleranceFactor"])],
  ["parallax-motion", new Set(["parallaxMotionAbsTolerance", "parallaxMotionRelTolerance", "parallaxMotionIdleTolerance"])],
]);
const GATE_TUNING_POSITIVE_INTEGER_FIELDS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["tile-render", new Set(["tileRenderEdgeCols", "tileRenderMaxRenderers"])],
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

function push(
  issues: AcceptanceValidationIssue[],
  code: string,
  message: string,
  path: string,
): void {
  issues.push({ code, message, path });
}

function validateNumericTarget(
  value: unknown,
  path: string,
  issues: AcceptanceValidationIssue[],
): void {
  if (!isRecord(value)) {
    push(issues, "INVALID_TARGET", `${path} must be an object.`, path);
    return;
  }
  if (!isNumber(value.target)) {
    push(issues, "MISSING_FIELD", `${path}.target must be a number.`, `${path}.target`);
  }
  if (!isString(value.unit)) {
    push(issues, "MISSING_FIELD", `${path}.unit must be a string.`, `${path}.unit`);
  }
  if (value.band !== undefined) {
    if (!isRecord(value.band)) {
      push(issues, "INVALID_BAND", `${path}.band must be an object.`, `${path}.band`);
    } else if (value.band.percent === undefined && value.band.abs === undefined) {
      push(
        issues,
        "INVALID_BAND",
        `${path}.band must define 'percent' or 'abs'.`,
        `${path}.band`,
      );
    }
  }
}

export function validateAcceptanceContract(input: unknown): AcceptanceValidationResult {
  const issues: AcceptanceValidationIssue[] = [];

  if (!isRecord(input)) {
    push(issues, "INVALID_DOCUMENT", "Acceptance contract must be an object.", "acceptance");
    return { valid: false, issues };
  }

  if (input.schemaVersion !== ACCEPTANCE_SCHEMA_VERSION) {
    push(
      issues,
      "INVALID_SCHEMA_VERSION",
      `schemaVersion must be '${ACCEPTANCE_SCHEMA_VERSION}'.`,
      "schemaVersion",
    );
  }

  if (!isString(input.game)) {
    push(issues, "MISSING_FIELD", "game is required.", "game");
  }

  // ---- fonts ----
  if (!isRecord(input.fonts)) {
    push(issues, "MISSING_FIELD", "fonts section is required.", "fonts");
  } else {
    if (input.fonts.global !== undefined && !isRecord(input.fonts.global)) {
      push(issues, "INVALID_FONT", "fonts.global must be an object.", "fonts.global");
    } else if (isRecord(input.fonts.global) && !isString(input.fonts.global.family)) {
      push(issues, "MISSING_FIELD", "fonts.global.family is required.", "fonts.global.family");
    }
    if (input.fonts.byRole !== undefined) {
      if (!isRecord(input.fonts.byRole)) {
        push(issues, "INVALID_FONT", "fonts.byRole must be an object.", "fonts.byRole");
      } else {
        for (const [role, req] of Object.entries(input.fonts.byRole)) {
          if (!isRecord(req) || !isString(req.family)) {
            push(
              issues,
              "MISSING_FIELD",
              `fonts.byRole.${role}.family is required.`,
              `fonts.byRole.${role}.family`,
            );
          }
        }
      }
    }
  }

  // ---- palette ----
  if (!isRecord(input.palette) || !Array.isArray(input.palette.entries)) {
    push(issues, "MISSING_FIELD", "palette.entries array is required.", "palette.entries");
  } else {
    input.palette.entries.forEach((entry, i) => {
      const p = `palette.entries[${i}]`;
      if (!isRecord(entry)) {
        push(issues, "INVALID_PALETTE", `${p} must be an object.`, p);
        return;
      }
      if (!isString(entry.hex) || !HEX_PATTERN.test(entry.hex)) {
        push(issues, "INVALID_HEX", `${p}.hex must be a 6-digit hex like '#ffd166'.`, `${p}.hex`);
      }
      if (!Array.isArray(entry.roles) || entry.roles.length === 0) {
        push(issues, "MISSING_FIELD", `${p}.roles must be a non-empty array.`, `${p}.roles`);
      }
    });
  }

  // ---- hud ----
  if (!isRecord(input.hud) || !Array.isArray(input.hud.elements)) {
    push(issues, "MISSING_FIELD", "hud.elements array is required.", "hud.elements");
  } else {
    const seen = new Set<string>();
    input.hud.elements.forEach((el, i) => {
      const p = `hud.elements[${i}]`;
      if (!isRecord(el)) {
        push(issues, "INVALID_HUD", `${p} must be an object.`, p);
        return;
      }
      if (!isString(el.id)) {
        push(issues, "MISSING_FIELD", `${p}.id is required.`, `${p}.id`);
      } else if (seen.has(el.id)) {
        push(issues, "DUPLICATE_HUD_ID", `${p}.id '${el.id}' is duplicated.`, `${p}.id`);
      } else {
        seen.add(el.id);
      }
      if (!isString(el.role)) {
        push(issues, "MISSING_FIELD", `${p}.role is required.`, `${p}.role`);
      }
      if (typeof el.anchor !== "string" || !HUD_ANCHORS.has(el.anchor)) {
        push(issues, "INVALID_ANCHOR", `${p}.anchor must be a valid HUD anchor.`, `${p}.anchor`);
      }
    });
  }

  // ---- framing ----
  if (!isRecord(input.framing)) {
    push(issues, "MISSING_FIELD", "framing section is required.", "framing");
  } else {
    const f = input.framing;
    if (!isRecord(f.aspect) || !isNumber(f.aspect.w) || !isNumber(f.aspect.h)) {
      push(issues, "MISSING_FIELD", "framing.aspect must define numeric w and h.", "framing.aspect");
    }
    if (!isRecord(f.playerAnchor)) {
      push(issues, "MISSING_FIELD", "framing.playerAnchor is required.", "framing.playerAnchor");
    } else {
      const a = f.playerAnchor;
      if (!isNumber(a.centerXFraction) || a.centerXFraction < 0 || a.centerXFraction > 1) {
        push(
          issues,
          "INVALID_ANCHOR_FRACTION",
          "framing.playerAnchor.centerXFraction must be in [0,1].",
          "framing.playerAnchor.centerXFraction",
        );
      }
      if (!isNumber(a.tolerance) || a.tolerance < 0 || a.tolerance > 1) {
        push(
          issues,
          "INVALID_TOLERANCE",
          "framing.playerAnchor.tolerance must be in [0,1].",
          "framing.playerAnchor.tolerance",
        );
      }
    }
    // ---- framing.camera perspective/high-angle band (3d-topdown-arena) ----
    // Only the NEW perspective fields are validated here; the 2D pixel-perfect
    // camera block stays authored-from-demo (unvalidated, as before).
    if (isRecord(f.camera)) {
      const cam = f.camera;
      const validateRangeBand = (band: unknown, path: string): void => {
        if (band === undefined) return;
        if (!isRecord(band) || !isNumber(band.min) || !isNumber(band.max)) {
          push(issues, "INVALID_FRAMING_CAMERA", `${path} must define numeric min and max.`, path);
        } else if (band.min > band.max) {
          push(issues, "INVALID_FRAMING_CAMERA", `${path}.min must be ≤ ${path}.max.`, path);
        } else if (band.min < 0 || band.max <= 0) {
          push(
            issues,
            "INVALID_FRAMING_CAMERA",
            `${path} must be non-negative (min ≥ 0, max > 0) — a negative width/angle band is meaningless.`,
            path,
          );
        }
      };
      validateRangeBand(cam.visibleGroundWidthM, "framing.camera.visibleGroundWidthM");
      validateRangeBand(cam.pitchDownDeg, "framing.camera.pitchDownDeg");
      // A perspective-shaped camera block (pitch band / perspective fallback
      // declared) REQUIRES the visibleGroundWidthM band: arming the ground-extent
      // gate is opt-out-with-noise, never disarmable by omission (the gate
      // additionally WARNs at grade time for pre-rule contracts).
      const perspectiveShaped = cam.pitchDownDeg !== undefined || cam.perspectiveFallback !== undefined;
      if (perspectiveShaped && cam.visibleGroundWidthM === undefined) {
        push(
          issues,
          "INVALID_FRAMING_CAMERA",
          "framing.camera declares perspective framing (pitchDownDeg / perspectiveFallback) without a visibleGroundWidthM {min,max} band — the visible ground extent would be unenforced. Declare the band (world metres).",
          "framing.camera.visibleGroundWidthM",
        );
      }
      // isNumber already requires Number.isFinite, so NaN/±Infinity refuse here.
      if (cam.groundPlaneY !== undefined && !isNumber(cam.groundPlaneY)) {
        push(
          issues,
          "INVALID_FRAMING_CAMERA",
          "framing.camera.groundPlaneY must be a finite number.",
          "framing.camera.groundPlaneY",
        );
      }
      if (cam.perspectiveFallback !== undefined) {
        if (!isRecord(cam.perspectiveFallback) || !isNumber(cam.perspectiveFallback.fieldOfViewDeg)) {
          push(
            issues,
            "INVALID_FRAMING_CAMERA",
            "framing.camera.perspectiveFallback.fieldOfViewDeg must be a number.",
            "framing.camera.perspectiveFallback.fieldOfViewDeg",
          );
        } else if (
          cam.perspectiveFallback.fieldOfViewDeg <= 0 ||
          cam.perspectiveFallback.fieldOfViewDeg >= 180
        ) {
          push(
            issues,
            "INVALID_FRAMING_CAMERA",
            "framing.camera.perspectiveFallback.fieldOfViewDeg must be in (0,180).",
            "framing.camera.perspectiveFallback.fieldOfViewDeg",
          );
        }
      }
    }
  }

  // ---- feel ----
  if (!isRecord(input.feel)) {
    push(issues, "MISSING_FIELD", "feel section is required.", "feel");
  } else {
    const namedKeys: Array<keyof typeof input.feel> = [
      "runSpeed",
      "jumpApex",
      "timeToApex",
      "shortHopApex",
      "dashDistance",
      "dashTime",
      "dashCooldown",
      "coyoteTime",
      "jumpBuffer",
    ];
    for (const key of namedKeys) {
      const v = (input.feel as Record<string, unknown>)[key as string];
      if (v !== undefined) {
        validateNumericTarget(v, `feel.${String(key)}`, issues);
      }
    }
    if (input.feel.extra !== undefined) {
      if (!isRecord(input.feel.extra)) {
        push(issues, "INVALID_FEEL", "feel.extra must be an object.", "feel.extra");
      } else {
        for (const [k, v] of Object.entries(input.feel.extra)) {
          validateNumericTarget(v as NumericTarget, `feel.extra.${k}`, issues);
        }
      }
    }
  }

  // ---- juice ----
  if (!isRecord(input.juice)) {
    push(issues, "MISSING_FIELD", "juice section is required.", "juice");
  } else {
    const j = input.juice;
    if (j.dashTrail !== undefined) {
      const dt = j.dashTrail;
      if (!isRecord(dt) || !isNumber(dt.ghosts) || !Array.isArray(dt.opacities)) {
        push(
          issues,
          "INVALID_JUICE",
          "juice.dashTrail requires numeric ghosts and opacities array.",
          "juice.dashTrail",
        );
      }
    }
    if (j.landingDust !== undefined) {
      if (!isRecord(j.landingDust) || !isNumber(j.landingDust.particles)) {
        push(issues, "INVALID_JUICE", "juice.landingDust requires numeric particles.", "juice.landingDust");
      }
    }
    if (j.hitStop !== undefined) {
      if (!isRecord(j.hitStop) || !isNumber(j.hitStop.ms)) {
        push(issues, "INVALID_JUICE", "juice.hitStop requires numeric ms.", "juice.hitStop");
      }
    }
    if (j.screenShake !== undefined) {
      const ss = j.screenShake;
      if (!isRecord(ss) || !isNumber(ss.amplitudePx) || !isString(ss.trigger)) {
        push(
          issues,
          "INVALID_JUICE",
          "juice.screenShake requires numeric amplitudePx and a trigger string.",
          "juice.screenShake",
        );
      }
    }
    if (j.parallax !== undefined) {
      if (!isRecord(j.parallax) || !Array.isArray(j.parallax.layers)) {
        push(issues, "INVALID_JUICE", "juice.parallax requires a layers array.", "juice.parallax");
      }
    }
  }

  // ---- audio (optional) ----
  if (input.audio !== undefined) {
    if (!isRecord(input.audio)) {
      push(issues, "INVALID_AUDIO", "audio must be an object.", "audio");
    } else if (!Array.isArray(input.audio.cues) || input.audio.cues.length === 0) {
      push(issues, "MISSING_FIELD", "audio.cues must be a non-empty array.", "audio.cues");
    } else {
      const seenCues = new Set<string>();
      input.audio.cues.forEach((cue, i) => {
        const p = `audio.cues[${i}]`;
        if (!isRecord(cue)) {
          push(issues, "INVALID_AUDIO", `${p} must be an object.`, p);
          return;
        }
        if (!isString(cue.id)) {
          push(issues, "MISSING_FIELD", `${p}.id is required.`, `${p}.id`);
        } else if (seenCues.has(cue.id)) {
          push(issues, "DUPLICATE_AUDIO_ID", `${p}.id '${cue.id}' is duplicated.`, `${p}.id`);
        } else {
          seenCues.add(cue.id);
        }
        if (!isString(cue.clip)) {
          push(issues, "MISSING_FIELD", `${p}.clip is required.`, `${p}.clip`);
        }
      });
    }
  }

  // ---- manifest ----
  if (!isRecord(input.manifest)) {
    push(issues, "MISSING_FIELD", "manifest section is required.", "manifest");
  } else {
    const m = input.manifest;
    if (typeof m.matching !== "string" || !MANIFEST_MATCHING.has(m.matching)) {
      push(issues, "INVALID_MATCHING", "manifest.matching must be exact|prefix|regex.", "manifest.matching");
    }
    if (!Array.isArray(m.elements) || m.elements.length === 0) {
      push(issues, "MISSING_FIELD", "manifest.elements must be a non-empty array.", "manifest.elements");
    } else {
      m.elements.forEach((el, i) => {
        const p = `manifest.elements[${i}]`;
        if (!isRecord(el)) {
          push(issues, "INVALID_MANIFEST", `${p} must be an object.`, p);
          return;
        }
        if (!isString(el.name) && !isString(el.nameRegex)) {
          push(issues, "MISSING_FIELD", `${p} requires name or nameRegex.`, p);
        }
        if (typeof el.type !== "string" || !MANIFEST_TYPES.has(el.type)) {
          push(issues, "INVALID_TYPE", `${p}.type must be GameObject|Sprite|Prefab.`, `${p}.type`);
        }
      });
    }
  }

  // ---- win ----
  if (!isRecord(input.win) || !isString(input.win.rule)) {
    push(issues, "MISSING_FIELD", "win.rule is required.", "win.rule");
  } else if (
    input.win.endStateMode !== undefined
    && (typeof input.win.endStateMode !== "string" || !WIN_END_STATE_MODES.has(input.win.endStateMode))
  ) {
    push(
      issues,
      "INVALID_WIN_END_STATE",
      "win.endStateMode must be modal|continuous.",
      "win.endStateMode",
    );
  }

  // ---- verification applicability (optional) ----
  if (input.verification !== undefined) {
    if (!isRecord(input.verification)) {
      push(issues, "INVALID_VERIFICATION", "verification must be an object.", "verification");
    } else {
      if (input.verification.gates !== undefined) {
        if (!isRecord(input.verification.gates)) {
          push(issues, "INVALID_VERIFICATION", "verification.gates must be an object.", "verification.gates");
        } else {
          for (const [gate, mode] of Object.entries(input.verification.gates)) {
            if (typeof mode !== "string" || !GATE_MODES.has(mode)) {
              push(
                issues,
                "INVALID_VERIFICATION",
                `verification.gates.${gate} must be required|not_applicable.`,
                `verification.gates.${gate}`,
              );
            }
          }
        }
      }
      // Anti-compression evidence gate (dogfood learnings §6 / High #7): every requested
      // class must be a known member of the fixed enum — an unknown class name is
      // a validation refusal, never silently accepted (it could never be satisfied
      // by the verdict's evidenceClasses block, so doneness would refuse forever).
      if (input.verification.requiredEvidenceClasses !== undefined) {
        if (!Array.isArray(input.verification.requiredEvidenceClasses)) {
          push(
            issues,
            "INVALID_VERIFICATION",
            "verification.requiredEvidenceClasses must be an array of evidence-class names.",
            "verification.requiredEvidenceClasses",
          );
        } else {
          input.verification.requiredEvidenceClasses.forEach((cls, i) => {
            if (typeof cls !== "string" || !EVIDENCE_CLASS_SET.has(cls)) {
              push(
                issues,
                "INVALID_VERIFICATION",
                `verification.requiredEvidenceClasses[${i}] "${String(cls)}" is not a known evidence class (one of: ${EVIDENCE_CLASSES.join(", ")}).`,
                `verification.requiredEvidenceClasses[${i}]`,
              );
            }
          });
        }
      }
      // Opt-in SFX verification (SFX-dogfood backlog High #7). Absent ⇒ no SFX gates.
      if (input.verification.sfx !== undefined) {
        const sfx = input.verification.sfx;
        if (!isRecord(sfx)) {
          push(issues, "INVALID_VERIFICATION", "verification.sfx must be an object.", "verification.sfx");
        } else {
          if (typeof sfx.enabled !== "boolean") {
            push(issues, "INVALID_VERIFICATION", "verification.sfx.enabled must be a boolean.", "verification.sfx.enabled");
          }
          if (sfx.scenarioExemptCues !== undefined) {
            if (!Array.isArray(sfx.scenarioExemptCues) || sfx.scenarioExemptCues.some((c) => typeof c !== "string")) {
              push(
                issues,
                "INVALID_VERIFICATION",
                "verification.sfx.scenarioExemptCues must be an array of cue-id strings.",
                "verification.sfx.scenarioExemptCues",
              );
            }
          }
          if (sfx.inputToSfxLatencyMs !== undefined) {
            validateNumericTarget(sfx.inputToSfxLatencyMs, "verification.sfx.inputToSfxLatencyMs", issues);
          }
        }
      }
    }
  }

  // ---- art posture (optional, gray-box / feel-only — RCL-D01) ----
  if (input.art !== undefined) {
    if (!isRecord(input.art)) {
      push(issues, "INVALID_ART", "art must be an object.", "art");
    } else {
      if (input.art.mode !== "deferred" && input.art.mode !== "final") {
        push(issues, "INVALID_ART", "art.mode must be 'deferred' or 'final'.", "art.mode");
      }
      if (input.art.note !== undefined && !isString(input.art.note)) {
        push(issues, "INVALID_ART", "art.note must be a non-empty string when present.", "art.note");
      }
      for (const key of Object.keys(input.art)) {
        if (key !== "mode" && key !== "note") {
          push(issues, "INVALID_ART", `art has unsupported field '${key}'.`, `art.${key}`);
        }
      }
    }
  }

  // ---- gate tuning (optional) ----
  if (input.gateTuning !== undefined) {
    if (!isRecord(input.gateTuning)) {
      push(issues, "INVALID_GATE_TUNING", "gateTuning must be an object.", "gateTuning");
    } else if (input.gateTuning.byGate !== undefined) {
      if (!isRecord(input.gateTuning.byGate)) {
        push(issues, "INVALID_GATE_TUNING", "gateTuning.byGate must be an object.", "gateTuning.byGate");
      } else {
        for (const [gate, tuning] of Object.entries(input.gateTuning.byGate)) {
          if (!isString(gate)) {
            push(issues, "INVALID_GATE_TUNING", "gateTuning.byGate keys must be non-empty gate ids.", "gateTuning.byGate");
          }
          if (!isRecord(tuning)) {
            push(
              issues,
              "INVALID_GATE_TUNING",
              `gateTuning.byGate.${gate} must be an object.`,
              `gateTuning.byGate.${gate}`,
            );
            continue;
          }
          const numberFields = GATE_TUNING_NUMBER_FIELDS.get(gate) ?? new Set<string>();
          for (const field of numberFields) {
            if (tuning[field] !== undefined && (!isNumber(tuning[field]) || (tuning[field] as number) < 0)) {
              push(
                issues,
                "INVALID_GATE_TUNING",
                `gateTuning.byGate.${gate}.${field} must be a finite number >= 0.`,
                `gateTuning.byGate.${gate}.${field}`,
              );
            }
          }
          const integerFields = GATE_TUNING_POSITIVE_INTEGER_FIELDS.get(gate) ?? new Set<string>();
          for (const field of integerFields) {
            if (tuning[field] !== undefined && (!isNumber(tuning[field]) || !Number.isInteger(tuning[field]) || (tuning[field] as number) < 1)) {
              push(
                issues,
                "INVALID_GATE_TUNING",
                `gateTuning.byGate.${gate}.${field} must be an integer >= 1.`,
                `gateTuning.byGate.${gate}.${field}`,
              );
            }
          }
        }
      }
    }
  }

  // ---- props (optional section, but MIGRATION-CLOSED: ledger L101) ----
  // `prop-purpose`'s semantic tier used to be opt-in through a falsy skip in the
  // gate (`if (purposeSpecs.length > 0 || prop.purpose)`): a contract that
  // declared a `props` section but no `props.purposes` silently disabled the
  // whole tier. The gate rule is now unconditional, so the migration edge (a
  // contract written before `purposes` existed) is answered HERE, at rest, by
  // NAMING the missing section rather than by letting the gate grade nothing.
  // A contract with no `props` section at all is untouched: it declares no prop
  // context, so there is nothing to migrate.
  if (input.props !== undefined) {
    if (!isRecord(input.props)) {
      push(issues, "INVALID_PROPS", "props must be an object.", "props");
    } else if (input.props.purposes === undefined) {
      push(
        issues,
        "MISSING_FIELD",
        "props.purposes is required once the contract declares a props section: the prop-purpose gate's semantic tier " +
          "grades every non-ground prop against a declared role, and an absent purposes list would leave it ungraded " +
          "(refused, not skipped). Declare the roles (route_platform/blocker/hazard/launcher/collectible/" +
          "collectible_support/goal/cover/enemy/decor/pickup), or remove the props section entirely.",
        "props.purposes",
      );
    } else if (!Array.isArray(input.props.purposes) || input.props.purposes.length === 0) {
      push(
        issues,
        "MISSING_FIELD",
        "props.purposes must be a non-empty array of { name | nameRegex, purpose } specs.",
        "props.purposes",
      );
    } else {
      input.props.purposes.forEach((spec, i) => {
        const p = `props.purposes[${i}]`;
        if (!isRecord(spec)) {
          push(issues, "INVALID_PROP_PURPOSE", `${p} must be an object.`, p);
          return;
        }
        if (!isString(spec.name) && !isString(spec.nameRegex)) {
          push(issues, "MISSING_FIELD", `${p} must declare 'name' or 'nameRegex'.`, `${p}.name`);
        }
        if (!isString(spec.purpose) || !PROP_PURPOSE_ROLE_SET.has(spec.purpose)) {
          push(
            issues,
            "INVALID_PROP_PURPOSE",
            `${p}.purpose must be one of: ${PROP_PURPOSE_ROLES.join(", ")}.`,
            `${p}.purpose`,
          );
        }
      });
    }
  }

  // ---- capturePack (optional, plan §3c) ----
  if (input.capturePack !== undefined) {
    if (!isRecord(input.capturePack)) {
      push(issues, "INVALID_CAPTURE_PACK", "capturePack must be an object.", "capturePack");
    } else if (!Array.isArray(input.capturePack.states) || input.capturePack.states.length === 0) {
      push(
        issues,
        "MISSING_FIELD",
        "capturePack.states must be a non-empty array.",
        "capturePack.states",
      );
    } else {
      const seen = new Set<string>();
      input.capturePack.states.forEach((stateEntry, i) => {
        const p = `capturePack.states[${i}]`;
        if (!isRecord(stateEntry)) {
          push(issues, "INVALID_CAPTURE_STATE", `${p} must be an object.`, p);
          return;
        }
        if (!isString(stateEntry.name)) {
          push(issues, "MISSING_FIELD", `${p}.name must be a non-empty string.`, `${p}.name`);
        } else if (
          stateEntry.name.includes("/") ||
          stateEntry.name.includes("\\") ||
          stateEntry.name === "." ||
          stateEntry.name === ".."
        ) {
          // The state name is concatenated into capture paths under
          // `.loombridge/verify/<name>/`; a `/`, `\`, `.`, or `..` here would
          // let the contract escape that directory at mint time.
          push(
            issues,
            "UNSAFE_STATE_NAME",
            `${p}.name "${stateEntry.name}" must not contain "/" or "\\", and must not be "." or "..".`,
            `${p}.name`,
          );
        } else if (seen.has(stateEntry.name)) {
          push(
            issues,
            "DUPLICATE_STATE",
            `${p}.name "${stateEntry.name}" is duplicated in capturePack.`,
            `${p}.name`,
          );
        } else {
          seen.add(stateEntry.name);
        }
        if (
          !Array.isArray(stateEntry.requiredCaptures) ||
          stateEntry.requiredCaptures.length === 0
        ) {
          push(
            issues,
            "MISSING_FIELD",
            `${p}.requiredCaptures must be a non-empty array of filenames.`,
            `${p}.requiredCaptures`,
          );
        } else {
          stateEntry.requiredCaptures.forEach((cap, ci) => {
            if (!isString(cap)) {
              push(
                issues,
                "INVALID_CAPTURE_NAME",
                `${p}.requiredCaptures[${ci}] must be a non-empty string.`,
                `${p}.requiredCaptures[${ci}]`,
              );
            } else if (!isSafeCapturePath(cap)) {
              // Reject path traversal: capture entries must be normalised
              // relative paths (no leading "/", no ".." segments, canonical
              // form). Otherwise a contract could declare e.g.
              // "../reports/build-verdict.json" and doneness would count an
              // external file as required evidence (§3a).
              push(
                issues,
                "UNSAFE_CAPTURE_PATH",
                `${p}.requiredCaptures[${ci}] "${cap}" must be a normalized RELATIVE path with no ".." segments (canonical form).`,
                `${p}.requiredCaptures[${ci}]`,
              );
            }
          });
        }
      });
    }
  }

  return { valid: issues.length === 0, issues };
}

export function assertValidAcceptanceContract(input: unknown): AcceptanceContract {
  const result = validateAcceptanceContract(input);
  if (!result.valid) {
    const summary = result.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ");
    throw new Error(`Acceptance contract validation failed: ${summary}`);
  }
  return input as AcceptanceContract;
}
