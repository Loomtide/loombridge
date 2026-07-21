# Framing / composition gate

Catches the clipped-player / off-center-anchor class (the frog hugging the left edge), plus HUD labels clipped at the viewport edge and a parallax backdrop that drifts open a seam.

## Op

```
unity_scene_get_screen_rects { locators: ["/Player", "/Level/Flag", "/Level/Saw", "/Level/Spike", "/Canvas/ScoreLabel", "/Canvas/TimerLabel"] }
```

Pass the player + every object you require in-frame (goal, hazards, key collectibles) **and the HUD labels**. Returns `{ objects: [{ name, screenRect{x,y,w,h}, centerXFraction, centerYFraction, isFullyVisible, isPartiallyClipped, isOffScreen, clipSide, rendererRect, colliderRect }] }`.

**Run screen-rects in PLAY mode.** The clipping check only catches a clipped HUD label if the canvas is laid out as it is in play. The earlier run captured **edit-mode only** and missed a score label clipped at the viewport edge (the HUD's runtime layout / `Canvas` scaling differs from edit mode). Enter play, let the HUD populate, then capture — include the HUD labels in `locators` so `clip.<label>` fires on a clipped element.

**Which bounds:** defaults to **opaque/visible-pixel** bounds (the "is the visible character clipped" question), with `rendererRect`/`colliderRect` as debug fields. A `boundsMode` param can switch the primary if needed. It reuses the `Camera.WorldToScreenPoint` projection from screenshot capture.

Save the returned object verbatim to `screen-rects.json`.

**Write it with the raw capture writer, not by hand — `loomtide capture`.** A hand-authored `screen-rects.json` can claim any camera (so the camera check below grades fiction), and a hand-curated `console.json` can hide errors. Use:

```
loomtide capture --slice <id> --root . [--locators /Player,/Level/Flag,...]
```

It reads the **authored** Camera `orthographicSize` in **EDIT mode** first (`camera.authoredOrthographicSize` — before PixelPerfect's runtime overscan), then enters Play Mode, runs `unity_scene_get_screen_rects`, reads the live `PixelPerfectCamera` via `unity_component_get_properties` and **merges its settings into the returned `camera` block** (`camera.pixelPerfect = { assetsPPU, refResolutionX, refResolutionY, upscaleRT, pixelSnapping }`), pulls `unity_editor_console_logs`, restores Edit Mode, and stamps a `_provenance` block into both `screen-rects.json` and `console.json` under `.loomtide/verify/<id>/`. The window-dependent **runtime** `orthographicSize`/`viewport.aspect` are recorded but **not** hard-checked (a non-16:9 Game view overscans when `cropFrame` is off — e.g. authored 4.5 reads ~5.85 at runtime); the gate enforces the **authored** value instead.

## Render-frame capture (actual Game-view fill)

For the **`render-frame`** gate, analyze the live **Game-view PNG** after `unity_editor_screenshot`
and save `render-frame.json`:

```json
{
  "frames": [
    {
      "id": "spawn",
      "width": 1920,
      "height": 1080,
      "edgeBlackFraction": { "top": 0, "right": 0, "bottom": 0, "left": 0 },
      "uniformBorderFraction": { "top": 0, "right": 0, "bottom": 0, "left": 0 },
      "contentRect": { "x": 0, "y": 0, "width": 1920, "height": 1080 }
    }
  ]
}
```

This is screenshot-level, not world-space. It catches black bars / boxed viewport / accidental camera
rects that `coverage.json` cannot see. Default contract policy is `acceptance.render.viewportMode:
"full"` with `maxBorderFraction: 0.02`. If bars are a deliberate aesthetic, set
`viewportMode:"letterbox"` in the contract; do not let a demo ship boxed by accident.

## Stateful visual-artifacts capture

For the **`visual-artifacts`** gate, capture named states (`spawn`, jump/apex or primary action,
dash/stress, win/end-state) and analyze for **classified** straight seams/bands:

Default capture + analyzer:

1. Enter Play Mode once.
2. Run `unity_runtime_capture_sequence` with a baseline and a short stress burst, e.g.
   `spawn` at `trigger:"start"`, `jump-rise`/`jump-fall` at `trigger:"atMs"`, and `jump-apex`
   at `trigger:"apexY"`. The op drives the jump phases, samples motion, and captures screenshots
   inside the same pinned runtime loop, so no separate screenshot call can miss an airborne state.
   Do not rely on apex alone: some seams only appear while the camera is moving.
3. Decode the returned `frames[].image_base64` values into `.loomtide/verify/<state>/frames/<id>.png` (per-state — matches where the speed runner writes that state's frames, and where `loomtide verify --inputs .loomtide/verify/<state>` reads from).
4. Run the analyzer from the repo root (writes the per-state `visual-artifacts.json` the gate consumes):

```bash
node mcp-server/dist/verification/analyze-frames.js \
  --baseline-id spawn \
  --baseline .loomtide/verify/<state>/frames/spawn.png \
  --stress-id jump-rise \
  --stress .loomtide/verify/<state>/frames/jump-rise.png \
  --stress-id jump-apex \
  --stress .loomtide/verify/<state>/frames/jump-apex.png \
  --output .loomtide/verify/<state>/visual-artifacts.json
```

The analyzer compares the baseline against action/stress frames and scans only the stable background
region by default (top HUD excluded, lower platform/gameplay band excluded). That makes jump-only
parallax seams fail as `background_seam` without treating platform tops or HUD bars as artifacts. Tune
`--stable-top-fraction`, `--stable-bottom-fraction`, and `--min-line-fraction` only when a game's
camera/composition requires a different stable region.

```json
{
  "frames": [
    {
      "id": "jump",
      "longLines": [
        {
          "orientation": "horizontal",
          "lengthFraction": 0.96,
          "y": 440,
          "classification": "background_seam"
        }
      ]
    }
  ],
  "comparisons": [
    { "from": "spawn", "to": "jump", "movedLine": true, "stableRegionChangeFraction": 0.02 }
  ]
}
```

This capture is **not a raw edge dump**. Mask or classify expected gameplay geometry first:

- `platform_edge`, `hud_edge`, `end_card_edge`, `expected_geometry` -> informational pass.
- `background_seam`, `camera_edge`, `render_band` -> artifact finding; obvious long spans fail.
- `unknown` or omitted classification on a long line -> warn, not fail; refine the analyzer/mask.

Scan stable background regions whenever possible, excluding platforms, HUD, end cards, sprites, and
intentional tile boundaries. For platformers, always include a jump/apex frame because vertical
parallax/pixel snapping artifacts often appear only while airborne.

## Backdrop coverage "soak" capture

For the coverage gate (catches the parallax sky that DRIFTS open a gap exposing the camera background — invisible to a t=0 capture). The seam only appears after the parallax layers have drifted, so capture **after a soak**, not on frame 0:

1. **Enter play** (`unity_editor_play`).
2. **Let the scene run ~5–6s** so the parallax layers DRIFT (advance game-time via `unity_runtime_probe` if the editor may background — wall-clock waits drift; the sim freezes when backgrounded).
3. `unity_scene_get_bounds` on **each parallax layer** and the **camera frame**.
4. Save **`coverage.json`**:

```json
{
  "cameraFrame": { "minX": -8.9, "maxX": 8.9, "minY": -5.0, "maxY": 5.0 },
  "layers": [
    { "name": "/Backdrop/Sky", "minX": -12.0, "maxX": 12.0, "minY": -6.0, "maxY": 6.0 }
  ],
  "atSeconds": 6
}
```

The coverage gate asserts the **full-screen layer (Sky)** still fully covers the camera frame AFTER drift — i.e. no exposed camera background / no seam at `atSeconds`. A missing `coverage.json` degrades it to **warn**.

## Placement capture (boundary-ground ends + grounded-prop float)

For the **`placement`** gate (catches boundary ground platforms whose ends show mid-screen, and a flag/
prop floating above the surface). Capture **`placement.json`**:

1. `unity_scene_get_bounds` on each **ground** platform → `minX`, `maxX`, `topY`.
2. `unity_scene_get_bounds` on each **grounded item** (flag/goal, props) → its `visibleBottomY`
   (from `visibleBounds`) plus the `surfaceTopY` of the ground it rests on. **`visibleBottomY` needs
   the sprite texture imported Read/Write-enabled** (else get_bounds reports *"texture not CPU-readable"*
   — see `unity-2d-game/references/default-values.md` §7).
3. `cameraFrame` from the camera — **mind overscan**: the real visible frame can be wider than
   `orthoSize × 2 × aspect` (a non-16:9 Game view overscans), so read the camera's actual frame via
   `unity_scene_get_bounds`, not the nominal width.

```json
{
  "cameraFrame": { "minX": -1.1, "maxX": 17.1, "minY": -3.0, "maxY": 5.0 },
  "grounds": [
    { "name": "/Level/GroundLeft",  "minX": -2.0, "maxX": 5.0,  "topY": 0.0 },
    { "name": "/Level/GroundRight", "minX": 8.5,  "maxX": 18.0, "topY": 0.0 }
  ],
  "groundedItems": [
    { "name": "/Level/Flag", "visibleBottomY": 0.0, "surfaceTopY": 0.0 }
  ]
}
```

The `placement` gate asserts the **leftmost ground's `minX` ≤ `cameraFrame.minX`** and the **rightmost
ground's `maxX` ≥ `cameraFrame.maxX`** (boundary ends run off-screen; interior gaps are ignored), and
each grounded item's **`visibleBottomY` ≈ `surfaceTopY`** (no float). A missing `placement.json`
degrades it to **warn**.

## Canvas block for the HUD-crispness check (`ui-scan.json`)

The **`ui-conformance`** gate now also reads a **`canvas`** block from `ui-scan.json` to catch a blurry
HUD rendered through a pixel-perfect camera with `upscaleRT=true` (see
`game-polish-2d/references/hud-kit.md`). After `unity_ui_scan_text_components`, add a `canvas` block via
`unity_component_get_properties` on the HUD `Canvas` (render mode + camera) and on the camera's
`PixelPerfectCamera`:

```json
{
  "...": "existing text-component scan fields",
  "canvas": {
    "renderMode": "ScreenSpaceCamera",
    "cameraName": "Main Camera",
    "cameraHasPixelPerfect": true,
    "cameraUpscaleRT": false
  }
}
```

- `renderMode` / `cameraName` — `unity_component_get_properties` on the HUD `Canvas` (`m_RenderMode`,
  `m_Camera`).
- `cameraHasPixelPerfect` — whether the referenced camera has a `PixelPerfectCamera` component.
- `cameraUpscaleRT` — `unity_component_get_properties` on that `PixelPerfectCamera` (`m_UpscaleRT`).

The gate **fails** when `cameraHasPixelPerfect == true` AND `cameraUpscaleRT == true` AND the HUD renders
through that camera (`renderMode == "ScreenSpaceCamera"` referencing it) — the blurry-HUD condition.

## Checks (`evaluateFraming`)

- **anchor.player** — the player's `centerXFraction` vs `framing.playerAnchor.centerXFraction ± tolerance`. Behavior depends on `framing.cameraMode`:
  - **`cameraMode: "static"`** ⇒ the per-frame lead-the-look anchor does **not** apply (it presumes a *following* camera), so the check is **informational**: status **pass** with a note, regardless of where the player sits. Never a warn.
  - **`cameraMode: "follow"` or absent** ⇒ off-target is a **warn** (never a hard fail): surface the deviation; reconcile in the fix loop (conform the camera, or update the spec note). On-target ⇒ **pass**.
  - The no-player / no-`centerXFraction` cases stay a **warn** in both modes (can't measure).
- **clip.<name>** — for every projected object, `isPartiallyClipped` or `isOffScreen` ⇒ **fail** (an important object must not be clipped). Fully in frame ⇒ **pass**.
- **camera.*** (only when the contract pins a concrete `framing.camera` block) — validates the captured `camera` block so a wrong camera can't pass framing just because the player rect happens to be in frame:
  - **camera.projection** — `camera.orthographic === true` ⇒ pass; perspective ⇒ **fail** (distorts a 2D frame).
  - **camera.position** — `camera.position` within ±0.05 world units of `framing.camera.worldPosition` ⇒ pass; off ⇒ **fail** (a static camera transform is deterministic).
  - **camera.orthographicSize** — the AUTHORED half-height (`camera.authoredOrthographicSize`, captured in edit mode) within ±0.01 of `framing.camera.orthographicSize` ⇒ pass; off ⇒ **fail**. The **runtime** `camera.orthographicSize` is recorded but NOT enforced (PixelPerfect overscans it off-16:9).
  - **camera.pixelPerfect.assetsPPU / .refResolution / .upscaleRT** — must equal `framing.camera.pixelPerfect`; mismatch ⇒ **fail**. `upscaleRT` is the blurry-HUD pin (usually `false`). **camera.pixelPerfect.pixelSnapping** mismatch ⇒ **warn**.
  - **Degraded captures** — a `screen-rects.json` with no `camera` block (`camera.capture`), no `authoredOrthographicSize` (`camera.orthographicSize`), or no `pixelPerfect` block (`camera.pixelPerfect`) ⇒ **warn** ("re-capture with `loomtide capture`"), not a false green.

Player matched by name containing `player`/`ninja`/`frog`, or a `playerNameHint` option.

## Reconcile pattern

If a following-camera contract declares a player anchor and the frame is off-target, either tune the
camera or update the contract to a static/room camera. If the player or another required object is
actually clipped, that remains a hard **fail** regardless of camera mode.
