# Tier-1 acceptance gates — orchestration recipe

The deterministic gates (`mcp-server/src/capabilities/verification/gates/`). Each evaluator is a **pure function** `(opOutput, acceptance) -> GateReport`. You drive the MCP op, save its output, and `run-gates.js` feeds it to the matching evaluator. You never re-implement the gate math.

## Report shape

```ts
GateReport = {
  gate: string,
  checks: { id, expected, actual, status: "pass"|"warn"|"fail", detail }[],
  verdict: "pass"|"warn"|"fail",   // worst-of the checks
}
```

`run-gates.js` aggregates all gate reports into `build-verdict.json` (shape in `report-schema.md`).

## Op → capture file → evaluator

Call the op with these args; save its JSON output to the capture file in the `--inputs` dir.

| Gate | Capture file | Op call | Evaluator |
|---|---|---|---|
| **manifest** | `verify-manifest.json` | `unity_scene_verify_manifest { manifest: acceptance.manifest }` — the op applies the `matching`/`caseSensitive`/`placeholderRule` rules and returns `{missing,placeholders,extras,all_ok}` | `evaluateManifest` |
| **ui-conformance** | `ui-scan.json` | `unity_ui_scan_text_components { locator: "/Canvas" }` (Canvas/HUD root), **plus a `canvas` block** (`{renderMode, cameraName, cameraHasPixelPerfect, cameraUpscaleRT}` via `unity_component_get_properties` on the HUD Canvas + the camera's `PixelPerfectCamera`) so the blurry-HUD check can read it — see `framing-checks.md` | `evaluateUiConformance` |
| **framing** | `screen-rects.json` | `unity_scene_get_screen_rects { locators: [...] }` (player + goal/hazards/collectibles + **HUD labels**, captured in **PLAY mode** so a clipped HUD element is caught — see `framing-checks.md`) | `evaluateFraming` |
| **render-frame** | `render-frame.json` | Analyze live Game-view screenshots into `{frames:[{id,width,height,edgeBlackFraction,uniformBorderFraction,contentRect}]}`. Fails unintended black bars / boxed camera output unless `acceptance.render.viewportMode:"letterbox"` or `"any"` declares otherwise | `evaluateRenderFrame` |
| **placement** | `placement.json` | `unity_scene_get_bounds` per ground (`minX`,`maxX`,`topY`) + grounded item (`visibleBottomY` — Read/Write textures — and its `surfaceTopY`); `cameraFrame` from the camera (overscan-aware). Catches boundary-ground ends showing mid-screen and a floating flag/prop — see `framing-checks.md` | `evaluatePlacement` |
| **visual-artifacts** | `visual-artifacts.json` | Default: capture `spawn` + a short motion burst with `unity_runtime_capture_sequence` (`jump-rise`, `jump-apex`, `jump-fall`, or the genre equivalent), decode `frames[].image_base64` to PNGs under `.loombridge/verify/<state>/frames/`, then run `node mcp-server/dist/capabilities/verification/analyze-frames.js --baseline-id spawn --baseline .loombridge/verify/<state>/frames/spawn.png --stress-id jump-rise --stress .loombridge/verify/<state>/frames/jump-rise.png --stress-id jump-apex --stress .loombridge/verify/<state>/frames/jump-apex.png --output .loombridge/verify/<state>/visual-artifacts.json` from the repo root. Produces `{frames:[{id,longLines,bands}], comparisons:[{from,to,movedLine,stableRegionChangeFraction}]}`. `longLines`/`bands` must be **classified findings**, not raw geometry: mask or classify platform edges, HUD bars, end-card borders, and other expected geometry. Fails obvious classified `background_seam` / `camera_edge` / `render_band`; warns on unclassified long lines and subtle stable-region changes | `evaluateVisualArtifacts` |
| **prop-purpose** | `objects.json` | `unity_scene_get_bounds` the player + each non-ground prop, plus `hasCollider`, attached `scripts`, optional `purpose`, optional `routeEvidence`, **and the same `grounds:[{name,minX,maxX,topY}]` spans the placement gate captures** → `{player:{name,bounds}, props:[{name,bounds,hasCollider,scripts,bottomY?,purpose?,routeEvidence?}], grounds?:[...]}`. Catches a purposeless prop, player-spawn overlap, floating props, and — when `acceptance.props.purposes[]` or captured `purpose` is present — collider-only props with no semantic route/combat/goal evidence. Decor with a collider fails unless intentional | `evaluatePropPurpose` |
| **coverage** | `coverage.json` | Enter play, let the parallax **drift ~5–6s**, then `unity_scene_get_bounds` each parallax layer + the camera frame → `{cameraFrame, layers:[{name,minX,maxX,minY,maxY}], atSeconds}`. Catches a backdrop seam/gap that only appears after drift; a `coversBottom` layer's `minY` must also reach the viewport floor (catches a cropped bottom edge showing in the pit) | `evaluateCoverage` |
| **reachability** | `reachability.json` | `unity_scene_get_bounds` the platforms (walkable `topY`,`minX`,`maxX`), launchers (trampoline `x`,`topY`,`launchApex`) and collectibles (`x`,`y`) → geometric jump/dash/trampoline envelope per collectible. **Do not teleport to prove this** | `evaluateReachability` |
| **platform-tiles** | `platform-tiles.json` | Platformer terrain construction: `{platforms:[{name,widthTiles,heightTiles,rows:[{index,role}],colliderTopY,visibleTopY}]}`. Fails capped/top rows repeated below row 0, non-integer tile spans, and collider top misalignment. Mark `verification.gates.platform-tiles:"not_applicable"` for non-platformer contracts | `evaluatePlatformTiles` |
| **playability** | `playability.json` | Drive the player via multi-driver `unity_runtime_probe`, assert `GameManager.isWin`/`lives`/`score` with `unity_runtime_assert_condition`; assemble into `{completable, winRuleObserved, hazardKills, collectibleIncrements, completionMethod}`. Set `completionMethod:"played"` only if you reached the win by **movement** (teleporting ⇒ WARN) | `evaluatePlayability` |
| **feel** | `feel.json` | FeelHarness for `runSpeed`/`jumpApex`/`timeToApex`; `unity_runtime_probe` recipes for `dashDistance`/`shortHopApex`/`coyoteTime`/`jumpBuffer`; assemble into one object | `evaluateFeel` |
| **console-clean** | `console.json` | After the play soak, `unity_editor_console_logs` → `{logs:[{type,message}]}` (a bare array is tolerated). Catches runtime Error/Exception entries and a PixelPerfect/odd-numbered-resolution rendering warning a green build ignored | `evaluateConsoleClean` |

Run order (cheap → expensive, fail-fast): manifest → ui-conformance → framing → render-frame → coverage → visual-artifacts → reachability → placement → platform-tiles → prop-purpose → playability → feel → console-clean → **frame-integrity** (only when `--vlm` is passed) → advisory VLM. `run-gates.js` already iterates the gates in this order. Missing capture files degrade to WARN unless the contract marks the gate `not_applicable`.

**`frame-integrity`** is a deterministic hard gate derived from the VLM review's `frames[]`: `run-gates.js` hashes each captured PNG and **FAILS** if two distinct frame ids (e.g. `spawn`/`win`/`dash-mid`) are byte-identical — a stale/duplicate capture that would let the perceptual review score states the frame doesn't actually show. It only runs when `--vlm` is supplied (the frames live in the review). See `vlm-review.md` "stale-capture trap".

## warn vs fail policy

- **fail** — a hard contract violation: wrong font, wrong HUD color, a required HUD/manifest element missing, a placeholder asset, a required object clipped/off-screen, unintended black bars/boxed Game view, a state-specific long seam/band **classified as a render artifact**, a boundary ground whose end shows inside the camera frame, a grounded prop/flag floating above its surface, a blurry HUD (HUD rendered through a `PixelPerfectCamera` with `upscaleRT==true`), **a `coversBottom` backdrop whose bottom edge (`minY`) sits above the viewport floor (its cropped bottom shows a band of camera background in the pit)**, a capped tile row repeated vertically in platformer terrain, **a purposeless prop or a collider-only prop with no declared semantic route/combat/goal purpose**, level not completable, win fires by the wrong rule, a hazard that doesn't kill, a collectible that doesn't score, a measured feel metric out of band, **a runtime Error/Exception in the console**, **a PixelPerfect/odd-numbered-resolution rendering warning (a real visual artifact)**, **two distinct-state key frames byte-identical (a stale/duplicate perceptual capture)**.
- **warn** — a soft / context-dependent signal surfaced but NOT build-breaking:
  - the **player anchor** off-target (static-vs-follow-camera reconcile — see `framing-checks.md`),
  - **manifest extras** when `extrasAreFailure` is false (the default),
  - a **benign (non-rendering) console warning**,
  - a check that **could not be evaluated**: no acceptance target/palette role to compare against, or a metric/field the run did not measure (`undefined` input),
  - a **missing capture file** — the whole gate degrades to a single `<gate>.input` WARN check rather than crashing the run.
- **pass** — within tolerance / present / observed-correct.

Aggregation: any gate `fail` ⇒ overall `fail`; else any `warn` ⇒ `warn`; else `pass`. Tier-1 is the build gate; the VLM tier (`vlm-review.md`) is advisory and reported separately.

## Capture-file gotchas

- Save the op's **raw JSON payload** (the `content[].text` parsed object), not the MCP envelope. A present-but-malformed file is a hard error; an absent file degrades to WARN.
- The component→HUD-role mapping in `ui-conformance` is by **name substring** (`ScoreLabel` → `score`). If a project names HUD text differently, rename or extend `acceptance.hud.elements[].id`.
- `framing` identifies the player by name (`player`/`ninja`/`frog`, or a `playerNameHint`). Pass the goal/hazard locators you want clip-checked.
- `playability` fields left `undefined` degrade to WARN ("not observed"), so a partial traversal still reports.
  For modal games (the default), include `postWinInputLocked`, `postWinPlayerFrozen`, and `restartWorks`
  so the gate proves the win/lose overlay actually stops gameplay behind it.
