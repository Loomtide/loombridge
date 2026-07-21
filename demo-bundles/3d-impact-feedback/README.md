# 3D impact feedback — live `hitstopMs` + true-3D `screenShakeMag`

First live **impact-feedback** capture, taken in the repo-owned
`unity-projects/shooter-3d-combat-dogfood` fixture. This takes the two combat "juice" metrics
`hitstopMs` and `screenShakeMag` out of the `3d-shooter` `needs-new-calculator` gap ledger, each backed
by raw Unity samples from a real projectile-collision hit.

## What this proves

A clean-room `Shooter3DImpactFeedback` component on the Main Camera watches the reference enemy's
collision-driven `HitCount` and, on its **rising edge** (a real `Shooter3DProjectile` trigger-collision —
never input, never a timer), opens a deterministic hit-stop window AND a decaying camera punch along
**world +Z** (the camera looks down +Z toward the enemy, so this is an impact kick along the view/depth
axis). Both advance on `Time.deltaTime` (the fixture never alters `Time.timeScale`), so a pinned capture
gives deterministic, capture-clock-aligned values.

- **`hitstopMs = 116.67 ms`** — the first hit-stop WINDOW duration (first rising → first falling edge of
  the sampled `IsHitStopped` signal), via the production `deriveHitstopMs`. Configured `0.12 s`; the gap
  is `tMs` reported rounded to 2 decimals plus frame quantization (the window spans exactly 7 capture
  frames at 60fps). `hitstopMs` is **dimension-agnostic** (a hit-stop window is temporal — it has no
  spatial axis); the 3D evidence is that the window is fired causally by a true 3D projectile collision.
- **`screenShakeMag = 0.2885 u`** — the peak camera displacement from rest after impact, via the
  production `deriveScreenShakeMag`, now **dimension-agnostic** (`hypot(dx,dy,dz)`, a missing z reads as 0
  so 2D results are byte-identical). The camera punch lives **entirely in world Z** (`x=0`, `y=2` constant
  for the whole capture), so:
  - **Z is load-bearing:** project the sampled trajectory onto X/Y (drop z) and the SAME production
    derivation **refuses** (`null`) — the magnitude is recoverable *only* because the bridge samples a
    true `{x,y,z}` trajectory. This is the camera analog of the pure-`+Z` measurement projectile used for
    true-3D `projectileSpeed`.

## Causality (not pre-impact, not delayed)

Both feedback edges are checked against the enemy's collision hit edge with the production
`isImmediateImpactFeedback` (an edge is immediate iff it fires on the same captured frame as the hit, or
within one sample interval after it):

- The enemy's first `EnemyHitCount` rising edge is at **`633.33 ms`**.
- `IsHitStopped` opens at **`633.33 ms`** (same frame) → closes at `750 ms`.
- The camera first leaves rest at **`633.33 ms`** (same frame); `deriveScreenShakeMag` is anchored to the
  hit onset, so it **refuses if the camera moved before the onset** (pre-impact motion is ambiguous) and
  measures the peak only at/after it.

A feedback edge that preceded the hit (pre-impact animation) or arrived more than one frame late
(delayed/independent motion) is reported non-causal and the artifact is NOT minted.

**Honest scope of the causality check here:** in this clean-room fixture the feedback and the sampled
hit edge are both driven from the same `Update` reading the enemy's collision counter, so they land on
the same captured frame by construction — the check confirms the calculator *runs and the relationship
holds*, and the underlying `EnemyHitCount` is genuinely collision-driven (only a projectile
`OnTriggerEnter` raises it, never a timer). The `isImmediateImpactFeedback` calculator's reject paths
(pre-impact / delayed) are exercised directly by the regression test, not by this fixture.

## Files

| File | Role |
|---|---|
| `3d-impact-feedback-raw-2026-06-26.json` | IMMUTABLE raw `runtime.capture_input_motion` transcript (op, host, request, verbatim `{x,y,z}` camera response + `fieldTimeline` series). Do not hand-edit. |
| `generate.mjs` | Assembles BOTH derived artifacts FROM the raw transcript: copies samples/series verbatim, runs the production `deriveHitstopMs` / `deriveScreenShakeMag`, asserts the Z-stripped projection refuses, and checks causality. Run: `node demo-bundles/3d-impact-feedback/generate.mjs`. |
| `3d-hitstop-derived-2026-06-26.json` | Canonical `hitstopMs` artifact (generated; reproducible from the raw transcript). |
| `3d-screen-shake-derived-2026-06-26.json` | Canonical `screenShakeMag` artifact (generated; reproducible from the raw transcript). |

Regression test: `mcp-server/src/__tests__/3d-impact-feedback-substrate.test.ts` (re-derives both metrics
from raw, proves Z is load-bearing for `screenShakeMag`, checks causality, deep-equals both generator
outputs, and proves degraded/static/pre-impact/delayed/never-closing inputs refuse — never green).

## Capture

- Op `runtime.capture_input_motion`, `captureFps=60`, `includeSamples=true`, measure `/Main Camera`,
  `sampleCount=111`, `durationMs=1833.33`, post-capture `error_count=0`.
- Phases: three short `Space` fire phases (proven shooter-combat loop) separated by cooldown windows.
  Each projectile flies ~300ms and collides with the enemy; the FIRST collision (`EnemyHitCount` 0→1 at
  `633.33ms`) opens the hit-stop window + camera punch.
- Sampled fields (on the camera component): `IsHitStopped`, `HitStopElapsedMs`, `ShakeMagnitude`
  (self-reported amplitude — an independent cross-check), and `EnemyHitCount` (the hit edge, so a
  camera-only capture carries both the cause and the effect).

## Honest gaps (still NOT measured)

This bundle proves the impact hit-stop WINDOW duration and the impact camera-DISPLACEMENT magnitude. It
does **not** measure hit-stop / screen-shake QUALITY, freeze or trauma curves, shake shape (perlin), or
any production camera-shake / time-dilation authoring. Muzzle flash, hit markers, crosshair bloom,
vignette, dust, recoil, ADS, hitscan impact latency, AI/cover/waves, and Fusion/multiplayer all remain
explicit gaps. See `mcp-server/src/loombridge/genre-packs/3d-shooter/methodology-gaps.md`.
