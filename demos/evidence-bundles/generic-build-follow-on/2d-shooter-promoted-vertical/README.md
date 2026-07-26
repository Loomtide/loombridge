# 2D Shooter Promoted Vertical Dogfood

Status: `experimental-green` proof bundle for the promoted `weapon` slice.

This bundle proves the next generic-genre step after GenreContract promotion: the committed
`mcp-server/src/capabilities/genre/genre-contract/examples/2d-shooter.contract.json` promotes into runtime Loombridge artifacts,
and the promoted weapon slice validates against artifact-backed gate and metric evidence.

## Artifacts

- `generate.mjs` — deterministic generator. Run after `cd mcp-server && npm run build`.
- `acceptance.json` — promoted `.loombridge/ACCEPTANCE.json` fixture.
- `slices.json` — promoted `.loombridge/SLICES.json` fixture.
- `promotion-report.json` — promotion report with explicit gaps.
- `2d-shooter-promoted-run.json` — experimental build proof bundle.
- `ttk-shooter-combat-loop-raw-2026-06-25.json` — **immutable raw capture transcript**: the verbatim
  `runtime.capture_input_motion` bridge interaction captured against the repo-owned `shooter-combat-dogfood`
  Unity fixture (host editor, exact request, verbatim response incl. real per-phase `fixedTick` provenance and all
  six sampled combat fields). The source of truth for the live shooter-combat-loop TTK evidence.
- `ttk-shooter-combat-loop-2026-06-25.json` — **canonical** live Unity `ttkMs` evidence (cited by the proof). It is
  ASSEMBLED from the raw transcript by `generate.mjs` (six series copied verbatim, value derived through
  `deriveTimeToKill`), and names its source via `rawCaptureSource`. `generate.mjs` cannot mint this from constants —
  delete or edit the raw transcript and assembly fails or changes.
- `ttk-live-capture-raw-2026-06-25.json` / `ttk-live-capture-2026-06-25.json` — the earlier **GameHub
  host-of-convenience** live capture (a real capture, but in a non-shooter host whose hits were injected fire-key
  edges, not projectile collisions). Now SUPERSEDED (`superseded: true`, `supersededBy` the shooter-combat-loop
  artifact) and no longer cited; retained so the provenance chain stays intact.
- `ttk-fixture-capture-2026-06-25.json` — SUPERSEDED fixture-backed `ttkMs` evidence, kept only as offline fallback
  (marked `superseded: true`, `supersededBy` the shooter-combat-loop artifact; the proof no longer cites it).
- `impact-feedback-raw-2026-06-25.json` — **immutable raw capture transcript** for the combat-feedback (hit-stop +
  screen-shake) dogfood: the verbatim `runtime.capture_input_motion` interaction against the same repo-owned
  `shooter-combat-dogfood` fixture, with the **Main Camera** as the measured subject and the combat fields sampled on
  `/CombatController`. Source of truth for both polish metrics.
- `hitstop-capture-2026-06-25.json` — **canonical** live Unity `hitstopMs` evidence (cited by the proof), ASSEMBLED
  from the impact raw transcript by `generate.mjs` (hit-stop series copied verbatim, value derived through
  `deriveHitstopMs`), naming its source via `rawCaptureSource`.
- `screen-shake-capture-2026-06-25.json` — **canonical** live Unity `screenShakeMag` evidence (cited by the proof),
  ASSEMBLED from the impact raw transcript (camera trajectory copied verbatim, value derived through
  `deriveScreenShakeMag`), naming its source via `rawCaptureSource`. Neither can be minted from constants — delete or
  edit the raw transcript and assembly fails or changes.

## Evidence

The promoted proof claims only the gates declared on the source contract's `weapon` slice:

- `manifest`
- `console-clean`

It deliberately does **not** claim `visual-artifacts` for the promoted slice, even though older hand-authored proof
material includes visual-artifact evidence, because the committed GenreContract fixture does not declare that gate on
`weapon`. Promotion cannot smuggle in an undeclared runnable gate.

Measured rows:

- `fireIntervalMs` — live Unity artifact from the existing fire dogfood.
- `projectileSpeed` — live Unity artifact from the projectile-speed dogfood.
- `fireInputToSpawnLatency` — live Unity artifact from the spawn-signal dogfood.
- `ttkMs` — **live Unity shooter-combat-loop** first projectile-collision-hit→death fieldTimeline, derived by
  `deriveTimeToKill` (`600.00ms`).
- `hitstopMs` — **live Unity** impact hit-stop window duration, derived by `deriveHitstopMs` (`116.66ms`).
- `screenShakeMag` — **live Unity** peak camera displacement on impact, derived by `deriveScreenShakeMag`
  (`0.3267u`).

### Live shooter-combat-loop `ttkMs` capture (what was proven)

`ttk-shooter-combat-loop-2026-06-25.json` is a real `runtime.capture_input_motion` Play-Mode capture (captureFps 60,
1800ms window, 109 samples) against the **repo-owned `shooter-combat-dogfood` fixture**
(`unity-dev-project/shooter-combat-dogfood`, scene `Assets/Scenes/ShooterCombatDogfood.unity`) — a real shooter build,
not a host-of-convenience. The capture measures `/CombatController` (`DogfoodCombatReset`) and samples all six combat
fields on the bridge tick clock. Three injected `Space` fires drive the full combat loop to enemy death:

- `combat-fire-count` (`FireCount`) and `combat-projectile-spawn-count` (`ProjectileSpawnCount`) rise together at
  **233.33 / 516.67 / 833.33ms** — each accepted fire spawns one `DogfoodProjectile` (18 u/s) from `FireSource` (x=0)
  toward the `Enemy` (x=6).
- `combat-projectile-hit-count` (`ProjectileHitCount`) and `combat-enemy-hit-count` (enemy `HitCount`) rise **together**
  at **533.33 / 816.67 / 1133.33ms** — each pair is a single `DogfoodProjectile.OnTriggerEnter2D` collision (~300ms of
  flight after each shot). Only a real projectile collision raises both counters, so this is collision evidence, not an
  injected-edge fake.
- `combat-enemy-health` (`Health`) falls `3 → 2 → 1 → 0` on those same hit ticks.
- `combat-enemy-is-dead` (`IsDead`) flips false→true at **1133.33ms**, the CAUSAL consequence of the third collision
  driving `Health` to 0 — never a timer.

`deriveTimeToKill` measures from the first enemy-hit edge to the death edge: `1133.33 − 533.33 = 600.00ms`. Both bound
signals (enemy `HitCount`, `IsDead`) are rising edges, so no falling-HP / threshold-cross primitive is involved.
Play Mode produced no console errors; nothing in the fixture project was saved.

**Provenance binding.** The verbatim bridge response is committed as `ttk-shooter-combat-loop-raw-2026-06-25.json` (a
raw capture transcript whose `host.projectName` is `shooter-combat-dogfood`). `generate.mjs` reads that transcript,
copies all six sampled series out of it, and derives the value through the real `deriveTimeToKill`; it does not
synthesize the series from constants. The canonical artifact records `rawCaptureSource`, and regression tests assert
the canonical `fieldTimeline` equals the raw transcript's response, that the transcript carries live per-phase
`fixedTick` provenance and the repo-owned host, that the projectile-hit edge coincides with the enemy-hit edge and
precedes death, and that a missing first-hit or death signal is refused (`attempted-blocked`, never green).

### Live combat-feedback `hitstopMs` + `screenShakeMag` capture (what was proven)

A second `runtime.capture_input_motion` Play-Mode capture (captureFps 60, 1800ms, 109 samples) against the same
repo-owned fixture measures the **Main Camera** transform and samples the combat fields on `/CombatController`. A new
`DogfoodImpactFeedback` component on the Main Camera watches the enemy's collision-driven `HitCount` rise and, on the
first hit (**516.67ms**), opens a hit-stop window and shakes the camera:

- `combat-hit-stop-active` (`IsHitStopped`) goes false→true at **516.67ms** and back to false at **633.33ms**, so
  `deriveHitstopMs` measures the first window as `633.33 − 516.67 = 116.66ms`.
- the Main Camera transform displaces from its rest position (peak **0.3267u** at 516.67ms) and decays cleanly to 0;
  `deriveScreenShakeMag` returns that peak displacement. The sampled `combat-shake-magnitude` (`ShakeMagnitude`) field
  is carried as an independent cross-check and agrees with the transform peak.

Both signals open on the **same captured frame as the first projectile-collision hit** (the projectile-hit edge
coincides with the enemy-hit edge), so the feedback is the causal consequence of a real collision — never input,
never a timer. The windows advance on `Time.deltaTime` (the fixture never alters `Time.timeScale`), so the pinned
capture gives them deterministic durations.

**Causality moat (hardened).** Two guards stop a future trace from certifying unrelated motion as impact feedback:
(1) `generate.mjs` requires both the hit-stop window AND the camera-shake onset to fire **within one capture sample
interval** of the first hit (`isImmediateImpactFeedback`) — a delayed or independently-triggered effect is refused,
not just "at or after" the hit; and (2) `deriveScreenShakeMag` is given the impact onset, so it **refuses if the
camera displaced before the hit** and measures the peak only at/after it — unrelated pre-impact camera motion (e.g. a
follow-cam pan) can never be misattributed as shake.

**Provenance binding.** The verbatim bridge response is committed as `impact-feedback-raw-2026-06-25.json`.
`generate.mjs` copies the camera trajectory and the sampled series out of it and derives the values through the real
`deriveHitstopMs` / `deriveScreenShakeMag`; it does not synthesize from constants. Each canonical artifact records
`rawCaptureSource`, and regression tests assert the canonical samples equal the raw transcript's, the repo-owned host,
the within-one-frame causal ordering (a delayed-feedback trace is refused), that injected pre-impact camera motion is
refused, and that a missing hit-stop window or a static camera is refused (never a fabricated `0`).

### What remains unproven (honest residual)

The earlier `ttk-live-shooter-combat-loop` gap — a live first-hit→death TTK driven by real projectile-collision damage
in an actual shooter build — is **closed**, and `hitstopMs` / `screenShakeMag` are now **measured live** (no longer
`needs-new-calculator`). The remaining, unrelated limitations are preserved as explicit methodology gaps:

- `spawn-aware-capture`: the explicit spawn-signal metric is measured, but automatic discovery of arbitrary
  runtime-spawned projectile objects remains out of scope.
- `inputToSfxLatency` has no live fire-SFX edge capture in this promoted proof.
- `remaining shooter feel beyond current calculators`: secondary feedback (crosshair bloom, screen-edge vignette,
  directional dust) still has no calculator.
- `aiming-feel` remains judgment-only.

This is an `experimental-green` proof, not a production-ready claim: the fixture is a minimal, deterministic combat
loop (fixed cadence, one-shot kill at `maxHealth 3`, fixed hit-stop/shake amplitudes), not a shipped, balanced game.
`hitstopMs` measures the deterministic hit-stop **window signal** (the impact-freeze interval a renderer would
consume), not a rendered editor-timeline freeze; `screenShakeMag` is world-unit camera displacement, not a px figure
(a px conversion would depend on the camera's orthographic size and screen resolution).

## Reproduce

```bash
cd mcp-server
npm run build
cd ..
node demos/evidence-bundles/generic-build-follow-on/2d-shooter-promoted-vertical/generate.mjs
cd mcp-server
node --test dist/__tests__/genre-contract-promotion.test.js dist/__tests__/generic-build-follow-on.test.js
```

The live shooter-combat-loop capture itself is re-runnable from `unity-dev-project/shooter-combat-dogfood`: open the
project, open `Assets/Scenes/ShooterCombatDogfood.unity`, enter Play Mode, and drive three `Space` fire phases through
`runtime.capture_input_motion` measuring `/CombatController` (`FireCount`, `ProjectileSpawnCount`, `ProjectileHitCount`,
`HitCount`, `Health`, `IsDead`).
