/**
 * `sfx-presence` gate (SFX dogfood backlog High #7 "Presence").
 *
 * Every REQUIRED cue in the cue map must have a clip asset actually bound on the
 * SfxPlayer. Consumes the build stage's asset-binding capture (`sfx-bindings.json`,
 * `SfxAssetBindingCapture`).
 *
 * Refuse-on-missing (CLAUDE.md gate invariants): a required cue whose binding is ABSENT
 * from the capture is a FAILURE, never a silently-skipped check — the same discipline
 * as a missing bound field elsewhere. A required cue that is present but not bound (or
 * bound to an empty clip path) also fails. Optional cues are informational. A binding
 * for a cue that is not in the cue map is a WARN (drift, not a hard fail).
 *
 * Shape guard (review D3): a present-but-MALFORMED capture (no `bindings` array, or a
 * malformed binding entry) is a graceful FAIL naming the malformation — never a thrown
 * exception that aborts the whole verify run with no verdict.
 *
 * Pure function — unit-testable from a synthetic capture + cue map, no live editor.
 */

import { makeGateReport, type GateCheck, type GateReport } from "./types.js";
import type { CueMapSchema } from "../../loomtide/sfx/cue-map.js";
import type { SfxAssetBindingCapture, SfxCueBinding } from "../../loomtide/sfx/capture-shapes.js";

export const GATE_NAME = "sfx-presence";

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function bindingFor(bindings: readonly SfxCueBinding[], cueId: string): SfxCueBinding | undefined {
  return bindings.find((b) => b.cueId === cueId);
}

function hasClip(b: SfxCueBinding): boolean {
  return b.bound === true && typeof b.clipPath === "string" && b.clipPath.trim().length > 0;
}

export function evaluateSfxPresence(
  capture: SfxAssetBindingCapture,
  cueMap: CueMapSchema,
): GateReport {
  // D3 shape guard: wrong-shape capture = graceful FAIL, never a thrown abort.
  if (!isObject(capture) || !Array.isArray(capture.bindings)) {
    return makeGateReport(GATE_NAME, [
      {
        id: "sfx-presence.capture",
        expected: "sfx-bindings.json with a `bindings` array",
        actual: "(malformed)",
        status: "fail",
        detail:
          "sfx-bindings.json is present but malformed (no `bindings` array) — a present-but-unreadable capture is a defect, refused (never weaker than a missing one).",
      },
    ]);
  }
  const checks: GateCheck[] = [];
  const bindings: SfxCueBinding[] = [];
  (capture.bindings as unknown[]).forEach((b, i) => {
    if (isObject(b) && typeof b.cueId === "string" && b.cueId.length > 0) {
      bindings.push(b as unknown as SfxCueBinding);
    } else {
      checks.push({
        id: `sfx-presence.binding.${i}`,
        expected: "binding entry is an object with a non-empty string `cueId`",
        actual: "(malformed entry)",
        status: "fail",
        detail: `bindings[${i}] is malformed (not an object with a non-empty string \`cueId\`) — refused, not skipped.`,
      });
    }
  });
  const cueIds = new Set(cueMap.cues.map((c) => c.id));

  for (const cue of cueMap.cues) {
    const binding = bindingFor(bindings, cue.id);
    if (cue.required === true) {
      if (!binding) {
        checks.push({
          id: `sfx-presence.${cue.id}`,
          expected: "bound clip asset for required cue",
          actual: "(absent from bindings)",
          status: "fail",
          detail: `Required cue \`${cue.id}\` (event \`${cue.event}\`) has no binding entry — refusing (an absent required binding is a defect, not a skip).`,
        });
      } else if (!hasClip(binding)) {
        checks.push({
          id: `sfx-presence.${cue.id}`,
          expected: "bound clip asset for required cue",
          actual: binding.bound ? `bound but clipPath="${String(binding.clipPath ?? "")}"` : "bound=false",
          status: "fail",
          detail: `Required cue \`${cue.id}\` is not bound to a clip asset.`,
        });
      } else {
        checks.push({
          id: `sfx-presence.${cue.id}`,
          expected: "bound clip asset for required cue",
          actual: binding.clipPath as string,
          status: "pass",
          detail: `Required cue \`${cue.id}\` is bound to ${binding.clipPath}.`,
        });
      }
    } else {
      // Optional cue: informational — bound is nice, absent is fine.
      const bound = binding ? hasClip(binding) : false;
      checks.push({
        id: `sfx-presence.${cue.id}`,
        expected: "optional cue: bound if present",
        actual: bound ? (binding!.clipPath as string) : "(optional, not bound)",
        status: bound ? "pass" : "not_applicable",
        detail: bound
          ? `Optional cue \`${cue.id}\` is bound to ${binding!.clipPath}.`
          : `Optional cue \`${cue.id}\` is not bound (allowed).`,
      });
    }
  }

  // Drift: a binding for a cue the map does not declare.
  for (const b of bindings) {
    if (!cueIds.has(b.cueId)) {
      checks.push({
        id: `sfx-presence.extra.${b.cueId}`,
        expected: "binding references a declared cue",
        actual: `unknown cue \`${b.cueId}\``,
        status: "warn",
        detail: `Binding references cue \`${b.cueId}\` which is not in the cue map (drift).`,
      });
    }
  }

  if (checks.length === 0) {
    checks.push({
      id: "sfx-presence.data",
      expected: "cue map with cues",
      actual: "(no cues)",
      status: "warn",
      detail: "Cue map declares no cues; presence was not evaluated.",
    });
  }
  return makeGateReport(GATE_NAME, checks);
}
