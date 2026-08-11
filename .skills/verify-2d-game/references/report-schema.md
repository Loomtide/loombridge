# Report + contract shapes

## `build-verdict.json` (Tier-1 verdict — the proof artifact)

Produced by `run-gates.js` (aggregates the per-gate `GateReport`s). This is what you hand over.

```json
{
  "status": "pass | warn | fail",
  "gates": {
    "manifest": "pass | warn | fail",
    "ui-conformance": "pass | warn | fail",
    "framing": "pass | warn | fail",
    "placement": "pass | warn | fail",
    "playability": "pass | warn | fail",
    "reachability": "pass | warn | fail",
    "coverage": "pass | warn | fail",
    "feel": "pass | warn | fail"
  },
  "checks":   [ { "id": "...", "expected": "...", "actual": "...", "status": "...", "detail": "..." } ],
  "failures": [ /* every check with status === "fail" */ ],
  "warnings": [ /* every check with status === "warn" */ ],
  "reviewFindings": { /* OPTIONAL, advisory, only when --vlm passed (see below) */ }
}
```

- `status` is the **Tier-1 verdict only**: any gate `fail` => `fail`; else any `warn` => `warn`; else `pass`. The CLI exits 1 on `fail`, 0 on `pass`/`warn`.
- `checks` is the flat union of every gate's checks; `failures`/`warnings` are the filtered subsets — your fix-loop worklist.
- A gate with a **missing capture file** appears with a single `<gate>.input` WARN check (degraded, not crashed).
- If an asset-layer prepare report exists, `build-verdict.json` / `final-verdict.json` may also include
  `registryAssets` metadata. Treat that metadata as an audited handoff section: ids and Unity paths must
  match the prepare report exactly, and a separate `asset-handoff-consistency.json` should be produced by
  running the consistency checker with its required flags from the repo root:
  ```bash
  node mcp-server/dist/capabilities/assets/handoff-consistency.js \
    --prepare-report .loombridge/run/handoff/<genre>-asset-prepare-report.json \
    --verdict .loombridge/run/reports/build-verdict.json \
    --output .loombridge/run/handoff/asset-handoff-consistency.json
  ```
  (The bare `npm run asset:handoff:check` script omits `--prepare-report` and exits 1 — see the canonical
  command in SKILL.md §6 and `commands/loombridge/build.md` §7.)

### Captured inputs → gate map

Each gate maps to one capture file in the `--inputs` dir (full list + ops in SKILL.md §1 and `acceptance-gates.md`). Beyond the five original captures, gates were added to close the teleport-completion, drifting-backdrop, and visible-edge/floating-prop blind spots:

| Capture file | Gate | Source op | Reference |
|---|---|---|---|
| `reachability.json` | **reachability** | `unity_scene_get_bounds` per platform/launcher/collectible (geometric jump/dash/trampoline envelope) | `playability-checks.md` |
| `coverage.json` | **coverage** | play-mode "soak" then `unity_scene_get_bounds` per parallax layer + camera frame | `framing-checks.md` |
| `placement.json` | **placement** | `unity_scene_get_bounds` per ground (`minX`,`maxX`,`topY`) + grounded item (`visibleBottomY`, `surfaceTopY`) + overscan-aware `cameraFrame` | `framing-checks.md` |

The `ui-scan.json` capture also now carries a **`canvas`** block (`{renderMode, cameraName, cameraHasPixelPerfect, cameraUpscaleRT}`) that the `ui-conformance` gate reads for the blurry-HUD (`upscaleRT`) check — see `framing-checks.md`.

These added gates **degrade to WARN if their capture is missing** (same as the others) — a partial run still produces a useful verdict.

## `reviewFindings` (Tier-2 VLM — ADVISORY, separate from `status`)

Merged under this key only when `--vlm <findings.json>` is passed. Strict schema: `mcp-server/src/capabilities/verification/vlm-review.schema.json`. **Never folded into `status`** — informs, does not gate.

```json
{
  "frames": [ { "id": "win", "path": "frames/win.png" } ],
  "criteria": [
    { "id": "end-state-styling", "status": "fail", "reason": "YOU WIN uses default font", "evidenceFrame": "win" }
  ],
  "summary": "1 fail / 1 warn (advisory)"
}
```

Criteria ids come from the game contract's perceptual rubric, or from the default generic set:
`composition-centering`, `palette-adherence`, `font-rendering`, `juice-cue-presence`,
`end-state-styling`, `hazard-readability`, `collectible-path`, `parallax` (see `vlm-review.md`).

## Acceptance contract (`acceptance.json`) — the spec every gate checks against

Schema: `mcp-server/src/capabilities/verification/acceptance.schema.json`; reference instance pattern: `<game>.acceptance.json`; types: `mcp-server/src/capabilities/verification/types.ts`. Sections:

- `fonts` — `{ global:{family}, byRole:{<id>:{family}} }` -> UI gate font checks.
- `palette` — `{ entries:[{hex, roles[], name}] }` -> UI gate color checks (roles map to HUD `colorRole`s).
- `hud` — `{ elements:[{id, role, anchor, colorRole, font, required, format}] }` -> UI gate font/color/presence.
- `framing` — `{ aspect, nativeResolution, cameraMode?:"static"|"follow", playerAnchor:{centerXFraction, tolerance}, ... }` -> framing gate. `cameraMode:"static"` makes the player-anchor check informational (the 40% lead-the-look anchor only applies to a following camera).
- `feel` — per-metric `{ target, unit, band:{percent|abs} }` -> feel gate.
- `juice` — `{ dashTrail, landingDust, fruitPop, hitStop, screenShake, parallax }` -> informs the VLM rubric + game-specific mock oracle/contract tooling.
- `manifest` — `{ matching, caseSensitive, extrasAreFailure, elements:[{name|nameRegex, type, primitive, minCount, required}] }` -> fed into `unity_scene_verify_manifest`; the op returns `{missing, placeholders, extras, all_ok}` for the manifest gate.
- `win` — `{ rule, endStateMode?, restartAction?, buildRule?, note? }` -> playability gate's win-rule and
  end-state checks. `endStateMode` defaults to `"modal"`: gameplay input/player motion must freeze behind
  the win/lose overlay and restart must work. Use `"continuous"` only when the game intentionally keeps
  simulation running under the result sequence. `buildRule` documents a known divergence to reconcile.

When you author a contract for a new game, mirror this structure; validate it with `assertValidAcceptanceContract` (run-gates.js does this automatically before evaluating).

### Authoring rule: every `colorRole` needs a matching `palette` role

The UI color check resolves each HUD element's `colorRole` to a `palette.entries[]` whose `roles[]` contains that role. **If no palette entry carries the role, the color check silently degrades to an un-checkable `warn`** ("colorRole X has no palette entry") instead of a real pass/fail — so the element's color is effectively unverified. When you add a HUD element with a `colorRole`, add (or extend) the matching palette entry in the same pass.

> Example: if a `timer` HUD element renders near-white but has no `timer` palette role, `color.TimerLabel` is an un-checkable warn. Adding a palette entry such as `{ "hex": "#e8eaed", "roles": ["timer"], "name": "hud-white" }` makes it a real check. Pick the hex from the *actual* rendered color (near-white is often not pure `#ffffff`).
