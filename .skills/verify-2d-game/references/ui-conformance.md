# UI conformance gate

Catches the wrong-font / wrong-color / missing-HUD-element class of misses. Static — no play mode needed.

## Op

```
unity_ui_scan_text_components { locator: "/Canvas" }   // the Canvas/HUD root
```

Returns `{ components: [{ name, type, fontAssetPath, fontName, color{r,g,b,a}, fontSize, alignment, anchor, text }] }`. It scans both `UnityEngine.UI.Text` directly and TMP components **via reflection** (no hard TextMeshPro dependency), resolving the font's asset path via `AssetDatabase.GetAssetPath`. Colors are 0–1 RGBA.

Then add a **`canvas`** block to the saved file (the crispness check reads `scan.canvas`):

```json
"canvas": { "renderMode": "ScreenSpaceCamera", "cameraName": "Main Camera", "cameraHasPixelPerfect": true, "cameraUpscaleRT": false }
```

`renderMode`/`cameraName` from `unity_component_get_properties` on the HUD `Canvas` (`m_RenderMode`, `m_Camera`); `cameraHasPixelPerfect` = whether that camera has a `PixelPerfectCamera`; `cameraUpscaleRT` from that component's `m_UpscaleRT`. Full recipe in `framing-checks.md`.

Save the returned object (plus the `canvas` block) verbatim to `ui-scan.json`.

## Checks (`evaluateUiConformance`)

- **font** — every scanned component's `fontName` must match the required family. Resolution order per component: per-element `hud.<id>.font` > `fonts.byRole.<id>` > `fonts.global.family`. A TMP `" SDF"` suffix is tolerated (`<Family> SDF` equals `<Family>`). Mismatch ⇒ **fail**.
- **color** — each component mapped to a HUD element with a `colorRole` must match that role's palette hex within ±2/255 per channel. Mismatch ⇒ **fail**; no palette entry for the role ⇒ **warn**; no scanned color ⇒ **fail**.
- **presence** — every `required` HUD element id must appear (by name substring) in the scan. Missing ⇒ **fail**.
- **crispness** — reads `scan.canvas`. A Screen Space - Camera HUD rendered through a camera whose `PixelPerfectCamera` has `upscaleRT == true` ships **blurry** (the whole frame, HUD included, is rasterized into a low-res RT then upscaled — crisp in edit mode, soft in play). `cameraHasPixelPerfect == true` AND `cameraUpscaleRT == true` AND the HUD renders through that camera ⇒ **fail**. Fix: set `upscaleRT = false` (keep `pixelSnapping = true`) — see `game-polish-2d/references/hud-kit.md`. Missing `scan.canvas` ⇒ **warn** (un-checkable).

Components map to HUD elements by **id substring on the component name** (case-insensitive), so `ScoreLabel` → the `score` element. If your HUD uses different names, rename the objects or adjust `acceptance.hud.elements[].id`.

## Reconcile pattern

If the scan reports a different font or color than the contract, either fix the HUD to match the
contract or consciously update the contract. The generic gate does not own font families or palette
hexes; it only enforces the contract's declared roles.
