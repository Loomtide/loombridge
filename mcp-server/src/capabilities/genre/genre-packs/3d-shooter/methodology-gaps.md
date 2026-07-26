# `3d-shooter` methodology gaps

This file is the honest ledger for the **first** `3d-shooter` genre seed. It records exactly what
Loombridge can measure for a 3D shooter today versus what is deferred, so no row is ever silently
treated as green. It pairs with:

- `acceptance.json` / `slices.json` — the plan-time templates (`plan --genre 3d-shooter`).
- `mcp-server/src/capabilities/genre/genre-contract/genre-packs/3d-shooter/hint-card.json` — the elicitation
  seed whose `defaultBands` carry the `measurabilityTag` for each metric.
- `unity-dev-project/shooter-3d-combat-dogfood/` — the repo-owned 3D fixture that supplied the first
  live capture.
- `demos/evidence-bundles/3d-shooter-first-live-capture/` — raw + derived live capture evidence for the first
  3D shooter loop; `generate.mjs` rebuilds the derived artifact from the raw transcript through the
  production feel calculators.
- `demos/evidence-bundles/3d-projectile-speed-substrate/` — raw + derived live capture evidence for the first
  true-3D `projectileSpeed` (3D measurement substrate v1); `generate.mjs` rebuilds it from the raw
  `{x,y,z}` transcript through the production `deriveProjectileSpeed`.
- `demos/evidence-bundles/3d-aim-turn-rate-substrate/` — raw + derived live capture evidence for the first
  rotation metric `aimTurnRateDegPerSec` (3D measurement substrate v2); `generate.mjs` rebuilds it
  from the raw `{x,y,z,rx,ry,rz}` transcript through the production `deriveAimTurnRateDegPerSec`.
- `demos/evidence-bundles/3d-impact-feedback/` — raw + derived live capture evidence for the impact-feedback
  metrics `hitstopMs` and true-3D `screenShakeMag`; `generate.mjs` rebuilds both from the raw camera
  `{x,y,z}` + window-series transcript through the production `deriveHitstopMs` / `deriveScreenShakeMag`,
  asserting the Z-stripped projection refuses and both feedback edges are causally tied to the hit.
- `demos/evidence-bundles/3d-hitscan-weapon/` — raw + derived live capture evidence for `hitscanImpactLatencyMs`;
  `generate.mjs` rebuilds it from the raw fire/raycast-hit/damage edge series through the production
  `deriveHitscanImpactLatencyMs`, asserting the fire → raycast-hit → damage ordering (no false green).
- `demos/evidence-bundles/3d-ai-reaction/` — raw + derived live capture evidence for `enemyReactionLatencyMs`;
  `generate.mjs` rebuilds it from the raw perception/reaction edge series through the production
  `deriveEnemyReactionLatencyMs`, asserting the occluder blocked LOS at start and perception precedes
  reaction (a real line-of-sight edge, not a timer).
- `demos/evidence-bundles/3d-cover-proof/` — raw COVERED + EXPOSED capture pair for `coverBlocksDamage`;
  `generate.mjs` rebuilds it from both raw transcripts through the production `deriveCoverBlocksDamage`,
  asserting covered blocks LOS + every valid shot + all damage, exposed restores LOS + damage (a miss is
  not a cover block).
- `demos/evidence-bundles/3d-wave-objective/` — raw capture for `waveObjectiveComplete`; `generate.mjs` rebuilds it
  from the raw spawn/alive/kill/complete edge series through the production `deriveWaveObjectiveComplete`,
  asserting spawn N → kill all → ObjectiveComplete rises at/after kill-all (kill-gated, not a timer).
- `demos/evidence-bundles/3d-shooter-minimal-vertical/` — the FINAL productization roll-up (Phase 07): a fresh live
  core-loop capture re-derived through the production calculators, plus an `evidence-manifest.json` +
  `reports/3d-shooter-vertical-report.json` that compose all the proven capabilities (each citing its raw
  bundle) and list every remaining gap EXPLICITLY. `experimental-green`, a minimal vertical builder, NOT a
  production-ready 3D shooter pack.
- `demos/evidence-bundles/3d-shooter-3c-controller-camera/` — proof bundle for the Character/Controller/Camera slice:
  look input changes the player/camera yaw, movement is aim-relative, and shot direction follows aim forward.

## Productization status (Phases 01–08 complete)

The `3d-shooter` pack is a **minimal vertical builder** — a sequence of merged, raw-proven capabilities
composed into one honest vertical run (`demos/evidence-bundles/3d-shooter-minimal-vertical/`), NOT a production-ready
3D shooter. **Eleven measured capabilities** (core-loop fireIntervalMs/fireInputToSpawnLatency/ttkMs,
true-3D projectileSpeed, aimTurnRateDegPerSec, hitstopMs, true-3D screenShakeMag, hitscanImpactLatencyMs,
enemyReactionLatencyMs, coverBlocksDamage, waveObjectiveComplete), each backed by a live capture. The
Phase 08 3C slice adds controller/camera so the visible vertical is no longer a fixed-camera range
shooter, and its two checks (`lookInputToYawLatencyMs` and `shotAimAlignmentDeg`) are now PROMOTED to
measurable-now: `demos/evidence-bundles/3d-shooter-3c-controller-camera/captures/` carries the committed live
`runtime.capture_input_motion` artifacts (look sweep + aim-then-fire) whose generator re-derives both
through the production calculators (16.66 ms look latency; 0° shot/aim alignment at 86° yaw) — bringing
the count to **thirteen measured capabilities**. The gaps below remain explicit and never green.

## Status of this seed

**Seed / foundation, not a complete 3D-shooter builder.** The first live 3D capture has now been
taken in the repo-owned fixture for the three dimension-agnostic counter/edge metrics below. This
proves the core projectile-collision loop for `fireIntervalMs`, `fireInputToSpawnLatency`, and
`ttkMs`.

**3D measurement substrate v1 (added):** the bridge now samples a true `{x,y,z}` trajectory
(previously `z` was read but dropped at serialization) and `deriveProjectileSpeed` is
dimension-agnostic, so **`projectileSpeed` is now live-proven for true 3D** (a +Z shot, measurable
only because `z` is sampled).

**3D measurement substrate v2 (added):** the bridge now ALSO samples a true rotation trajectory —
every trajectory sample carries `rx`/`ry`/`rz` (world `transform.eulerAngles`, degrees) alongside
`{x,y,z}`. `deriveAimTurnRateDegPerSec` reads the yaw axis (`ry`) and reports the median moving
per-interval angular speed (wrap-aware), so **a constant yaw turn RATE is now live-proven for true
3D** (`119.976 deg/s` from a clean-room aim rig, measurable only because rotation is sampled). It
does **still NOT** prove recoil kick/recovery, ADS, AI, waves, or networking — those need additional
semantics (a recoil calculator, ADS state sampling) beyond the rotation sampler that now exists.

**3C controller/camera slice (added, then PROMOTED — PR #355):** the visible vertical now has a clean-room
third-person Character/Controller/Camera loop. Deterministic look input changes player/aim yaw and pitch, WASD
moves relative to the aim yaw, the camera follows from a third-person pose, and the weapon records a shot
direction derived from `AimForward`. `lookInputToYawLatencyMs` (look-input onset → first yaw response) and
`shotAimAlignmentDeg` (aim/camera forward vs shot direction angular error) are now MEASURABLE-NOW: committed
live captures under `demos/evidence-bundles/3d-shooter-3c-controller-camera/captures/` re-derive both through the
production `deriveLookInputToYawLatencyMs` / `deriveShotAimAlignmentDeg` calculators (16.66 ms look latency;
0° shot/aim alignment at 86° yaw), and the calculators refuse missing/out-of-window onset, rotation-stripped
samples, pre-armed yaw, or a malformed/zero shot or aim vector. This proves mechanics binding PLUS the two measured 3C
checks; subjective aiming feel, recoil, ADS, animation polish, and camera-composition quality remain gaps.

**3D impact feedback (added):** the two combat "juice" metrics now have raw 3D capture evidence. A
clean-room camera component opens a hit-stop WINDOW and a camera punch along **world +Z** on the
enemy's collision hit edge. `deriveHitstopMs` (a dimension-agnostic temporal window) measures the
first window; `deriveScreenShakeMag` — now dimension-agnostic (`hypot(dx,dy,dz)`) — measures the peak
camera displacement, with the entire signal living in Z (the X/Y projection refuses → Z is
load-bearing). Both edges are checked for causality against the hit edge (`isImmediateImpactFeedback`),
so pre-impact or delayed feedback cannot green. It does **still NOT** measure hit-stop / screen-shake
QUALITY, trauma curves, shake shape, recoil, hitscan, ADS, or any production camera-shake authoring.

## Measurable now (implemented calculators; dimension-agnostic)

| Metric | Calculator | Evidence path in the fixture |
|---|---|---|
| `fireIntervalMs` | `fireIntervalMs` | `Weapon.FireCount` rising-edge series. |
| `fireInputToSpawnLatency` | `fireInputToSpawnLatency` | fire-input onset → `Weapon.ProjectileSpawnCount` rising edge. |
| `ttkMs` | `ttkMs` | first `Enemy.HitCount` rising edge → `Enemy.IsDead` flip. |
| `projectileSpeed` (true 3D) | `projectileSpeed` (dimension-agnostic) | median moving per-interval Euclidean speed over the measurement projectile's `{x,y,z}` trajectory. |
| `aimTurnRateDegPerSec` (true 3D) | `aimTurnRateDegPerSec` (yaw axis = `ry`) | median moving per-interval angular speed (wrap-aware) over the aim rig's rotation (`{rx,ry,rz}`) trajectory. |
| `hitscanImpactLatencyMs` | `deriveHitscanImpactLatencyMs` | fire input onset → `RaycastHitCount` rising edge, gated by the fire → raycast-hit → damage ordering (instantaneous-raycast weapon). |
| `enemyReactionLatencyMs` | `deriveEnemyReactionLatencyMs` | perception edge (`TargetAcquiredCount`, a real line-of-sight Linecast) → first reaction edge (`StartedAimingCount`); refuses no-LOS / no-reaction / pre-armed. |
| `coverBlocksDamage` (boolean) | `deriveCoverBlocksDamage` | covered (LOS blocked + every valid shot blocked by the cover collider + no damage) vs exposed (LOS restored + damage) capture pair; refuses miss-as-block / damage-through-cover / false-cover. |
| `waveObjectiveComplete` (boolean) | `deriveWaveObjectiveComplete` | spawn N → kill all (`KillCount == SpawnCount`, `AliveCount` returns to 0) → `ObjectiveComplete` rises at/after kill-all; refuses under-spawn / under-kill / alive-remaining / completion-before-kill-all (timer). |
| `hitstopMs` (3D-fixture) | `deriveHitstopMs` (dimension-agnostic temporal window) | first rising→falling edge of the `IsHitStopped` window series, fired by a true 3D projectile collision. |
| `screenShakeMag` (true 3D) | `deriveScreenShakeMag` (dimension-agnostic) | peak Euclidean camera displacement `hypot(dx,dy,dz)` from rest after the hit; the punch lives in Z, so the X/Y projection refuses. |
| `holdChannelDurationMs` | `deriveHoldChannelDuration` (dimension-agnostic temporal window) | input-DOWN edge of `HoldInputHeld` → first `ChannelProgress` sample reaching the declared target, with a continuous-hold + monotonic-rise guard; refuses released-early / never-completes / non-causal / non-monotonic. |
| `holdInterruptOnDamage` (boolean) | `deriveHoldInterruptOnDamage` (dimension-agnostic) | progress-before vs progress-after the first `DamageTakenCount` edge while the channel is active; `interrupted` true iff progress reset after damage. Refuses no-damage / inactive-channel / degraded series. |
| `zoneObjectiveComplete` (sequence) | `deriveZoneObjectiveComplete` (dimension-agnostic) | enter-trigger (`InZone` rising edge) → dwell `ExtractProgress` reaches the declared target while `InZone` stays continuously true → `LootBanked` flips/increments AT/AFTER completion; refuses never-entered / left-zone-before-complete (interrupted extraction) / never-completed / never-banked / non-causal ordering. |
| `stashLossOnDeath` (boolean) | `deriveStashLossOnDeath` (dimension-agnostic) | contemporaneous `CarriedStash` AT the first `PlayerDead` edge vs the bounded post-death trough; `lostOnDeath` true iff the stash dropped to baseline (lose-everything). Refuses no-death / stash-at-baseline-at-death (no loot carried) / no-post-death-sample / degraded series. |
| `moveSpeed` (true 3D, planar) | `deriveMoveSpeed` (dimension-agnostic) | steady-state PLANAR (XZ ground-plane) move speed `hypot(Δx,Δz)/Δt` over the cruise plateau of the moving character's `{x,y,z}` trajectory; Y (up axis) excluded so a hop never inflates ground speed. Refuses idle / lone-snap / a z-stripped pure +Z run. |
| `accelTo90` (true 3D, planar) | `deriveAccelTo90` (dimension-agnostic) | time from movement start to first reaching 90% of steady planar move speed, over the same planar tick speeds; refuses no-ramp (instant snap / single partial-injection tick), never-reaches-90%, idle, or malformed trajectory. |
| `threatRampSlope` (slope + monotone) | `deriveThreatRampSlope` (dimension-agnostic) | spawn-edge series (counter increments / events): the inter-spawn intervals must STRICTLY shrink (rising rate) and the grace window must be respected; reports the least-squares slope of rate-vs-run-time + the intervals/rates evidence. Refuses flat / non-monotonic / grace-violated / <3 spawns / degraded. |
| `autoAimAcquisition` (correct boolean) | `deriveAutoAimAcquisition` (dimension-agnostic) | the alive candidates' {position, hp, alive[, threat]} at the fire instant + the locked id + a priority rule (nearest / lowest-hp / highest-threat): asserts the lock matches the rule's correct pick. A WRONG lock is an honest MEASURED MISS (`correct: false`), NOT a refusal; refuses no-candidates / no-alive / no-lock / unresolved-tie / degraded. |
| `sprintProfile` (multiplier + duration + cooldown) | `deriveSprintProfile` (dimension-agnostic) | planar-speed + sprint-input series: the sprint MULTIPLIER (peak boost / base moving speed), the boost DURATION (first boost-window span), and the COOLDOWN lockout (first boost end → second boost start), read from the speed boost windows + gated on a real sprint-input edge. Refuses no-sprint / no-base-speed / no-boost / no-second-boost / degraded. |

The first three calculators count edges/durations on sampled scalar fields, so they are unaffected by
2D vs 3D. `projectileSpeed` is now dimension-agnostic too: the bridge samples a true `{x,y,z}`
trajectory and the calculator uses the full Euclidean step (`hypot(Δx,Δy,Δz)`), so a +Z shot is
measured correctly. If a required field/trajectory is absent the calculator REFUSES — the row
becomes `not_measured` / `attempted-blocked`, never green.

HONESTY CAVEAT on the hold-channel pair (`holdChannelDurationMs` / `holdInterruptOnDamage`, the
extraction-shooter "hold-to-loot / hold-to-extract" mechanic, dogfood finding RCL-G01): the
calculators are IMPLEMENTED and covered by synthetic-trace unit tests
(`__tests__/3d-hold-channel-substrate.test.ts`), but unlike every other row in this table they are
NOT yet backed by a committed live capture (`demos/evidence-bundles/3d-hold-channel/*` does not exist) — a real
hold-to-extract capture needs a built extraction scene. They are honest measure-only proofs over the
documented `HoldInputHeld` / `ChannelProgress` / `DamageTakenCount` sampled fields; promote them to
live-proven once that capture is recorded, the same path the cover/wave substrates took.

HONESTY CAVEAT on the move-speed pair (`moveSpeed` / `accelTo90`, the 3D movement-feel metric, dogfood
finding RCL-G06): the calculators are IMPLEMENTED and covered by synthetic-trajectory unit tests
(`__tests__/3d-move-speed-substrate.test.ts`), but — exactly like the hold-channel pair — they are NOT
yet backed by a committed live capture (`demos/evidence-bundles/3d-move-speed/*` does not exist); a real top-down
locomotion capture needs a built move scene. They are unblocked by the Z-aware `measure_motion` fix
(RCL-T02): the bridge now samples a true `{x,y,z}` trajectory, so `deriveMoveSpeed` reads the PLANAR
(XZ) ground speed and a top-down character running FORWARD (+Z) measures correctly instead of the ~0 the
old horizontal-only `runSpeed` produced — and a z-stripped pure +Z run REFUSES rather than fabricating a
0 (z is load-bearing). They are honest measure-only proofs over the sampled trajectory; promote them to
live-proven once a real locomotion capture is recorded, the same path the cover/wave substrates took.

HONESTY CAVEAT on the extraction win/loss pair (`zoneObjectiveComplete` / `stashLossOnDeath`, the
extraction-shooter "reach-zone → dwell → bank" win path + "lose-everything-on-death" greed rule,
dogfood findings RCL-G02 + RCL-G07): the calculators are IMPLEMENTED and covered by synthetic-trace
unit tests (`__tests__/3d-extraction-objective-substrate.test.ts`), but — exactly like the
hold-channel and move-speed pairs — they are NOT yet backed by a committed live capture
(`demos/evidence-bundles/3d-extraction-objective/*` does not exist); a real reach-zone → dwell → bank (and a
death-wipe) capture needs a built extraction scene. They are the INVERSE of the wave/objective proof
(`waveObjectiveComplete` is spawn-N → kill-all → clear; extraction is enter-zone → dwell/hold → bank,
lose-on-death). They are honest measure-only proofs over the documented `InZone` / `ExtractProgress` /
`LootBanked` and `CarriedStash` / `PlayerDead` sampled fields: `deriveZoneObjectiveComplete` refuses an
interrupted/non-causal extraction (left the zone before the dwell finished, banked before dwelling,
never entered/completed/banked) and `deriveStashLossOnDeath` reads the CONTEMPORANEOUS stash at the
death edge (not a stale peak) in a bounded post-death window (a later re-loot after respawn is never
charged to the death), so a stale already-empty stash, a stash-at-baseline-at-death, or a stash that
SURVIVED the death (the BUG the rule forbids) is surfaced honestly — never a fabricated outcome.
Promote them to live-proven once a real extraction capture is recorded, the same path the cover/wave
substrates took.

HONESTY CAVEAT on the extraction-PRESSURE trio (`threatRampSlope` / `autoAimAcquisition` / `sprintProfile`,
the heat-ramp / auto-aim / sprint-traversal knobs that make a raid tense, dogfood findings
RCL-G03 + RCL-G04 + RCL-G05): the calculators are IMPLEMENTED and covered by synthetic-trace unit tests
(`__tests__/3d-extraction-pressure-substrate.test.ts`), but — exactly like the hold-channel, move-speed,
and extraction win/loss pairs — they are NOT yet backed by a committed live capture
(`demos/evidence-bundles/3d-extraction-pressure/*` does not exist); a real heat-ramp / auto-aim / sprint capture
needs a built extraction-pressure scene. They are honest measure-only proofs over the documented spawn,
candidate-set, and planar-speed + sprint-input signals: `deriveThreatRampSlope` refuses a flat /
non-monotonic / grace-violated / under-spawned / degraded ramp (a positive endpoint slope over a
non-monotonic middle cannot green); `deriveAutoAimAcquisition` surfaces a wrong lock as an honest
MEASURED MISS (`correct: false`, the targeting BUG the rule forbids) rather than a refusal, and refuses
only "could not decide" (no candidates / no living target / no lock / an unresolved tie / degraded);
`deriveSprintProfile` reads the multiplier/duration/cooldown from the speed BOOST WINDOWS (the physical
evidence) gated on a real sprint-input edge, and refuses no-sprint / no-base-speed / no-observed-boost /
no-second-boost (the cooldown lockout needs a second sprint to observe "available again") / degraded — so
a held sprint key with no speed change, or a fabricated cooldown off a single burst, can never green.
Promote them to live-proven once a real extraction-pressure capture is recorded, the same path the
cover/wave substrates took.

## 3C checks (PROMOTED — measurable-now, measure-only proof)

Both promoted with committed live evidence in `demos/evidence-bundles/3d-shooter-3c-controller-camera/captures/`
(`generate.mjs` re-derives through the production calculators).

| Metric | Status | Live evidence |
|---|---|---|
| `lookInputToYawLatencyMs` | measurable-now (`deriveLookInputToYawLatencyMs`) | `look-latency-raw-2026-06-26.json`: a settle→RightArrow sweep; first sampled /Player yaw (ry) response one frame after the recorded look-input onset → **16.66 ms** (band max 50). Refuses missing/out-of-window onset, rotation-stripped samples, pre-armed yaw, no response. |
| `shotAimAlignmentDeg` | measurable-now (`deriveShotAimAlignmentDeg`) | `shot-alignment-raw-2026-06-26.json`: after yawing the aim to ~86°, a Space fire records `LastShotDirection*`; at the FireCount edge it equals `AimForward*` → **0°** (band max 5). Refuses malformed/zero vectors. |

First live 3D proof:

- Raw transcript:
  `demos/evidence-bundles/3d-shooter-first-live-capture/shooter-3d-combat-loop-raw-2026-06-25.json`
- Derived summary:
  `demos/evidence-bundles/3d-shooter-first-live-capture/shooter-3d-combat-loop-derived-2026-06-25.json`
- Generator:
  `demos/evidence-bundles/3d-shooter-first-live-capture/generate.mjs`
- Capture op: `runtime.capture_input_motion`, `captureFps=60`, `sampleCount=111`,
  `durationMs=1833.33`, `editorStateAfterCapture.error_count=0`.
- Input phases: three short `Space` fire phases separated by empty cooldown windows.
- Observed edges: `FireCount`/`ProjectileSpawnCount` at `16.67`, `166.67`, `316.67`ms;
  `HitCount` at `633.33`, `783.33`, `933.33`ms; `IsDead`/`DeathCount` at `933.33`ms.
- Derived metrics: `fireIntervalMs=150`, `fireInputToSpawnLatency=16.67`, `ttkMs=300`.

First live true-3D `projectileSpeed` proof (3D measurement substrate v1):

- Raw transcript:
  `demos/evidence-bundles/3d-projectile-speed-substrate/shooter-3d-projectile-speed-raw-2026-06-25.json`
- Derived summary:
  `demos/evidence-bundles/3d-projectile-speed-substrate/shooter-3d-projectile-speed-derived-2026-06-25.json`
- Generator:
  `demos/evidence-bundles/3d-projectile-speed-substrate/generate.mjs`
- Capture op: `runtime.capture_input_motion`, `captureFps=60`, `sampleCount=119`,
  `durationMs=1966.67`, `editorStateAfterCapture.error_count=0`, measure `/MeasurementProjectile`.
- Trajectory: pure `+Z` — `x=0`, `y=1` constant; `z` rises `0.6 → 29.4` after launch (the entire
  speed lives in `z`).
- Derived metric: `projectileSpeed=17.9964 u/s` (configured `18`; the gap is `tMs` reported rounded
  to 2dp). Substrate proof: the same samples with `z` stripped collapse to a stationary `x/y` track
  and the 2D-only derivation REFUSES (`null`) — the value is recoverable only because `z` is sampled.

First live true-3D `aimTurnRateDegPerSec` proof (3D measurement substrate v2):

- Raw transcript:
  `demos/evidence-bundles/3d-aim-turn-rate-substrate/shooter-3d-aim-turn-rate-raw-2026-06-26.json`
- Derived summary:
  `demos/evidence-bundles/3d-aim-turn-rate-substrate/shooter-3d-aim-turn-rate-derived-2026-06-26.json`
- Generator:
  `demos/evidence-bundles/3d-aim-turn-rate-substrate/generate.mjs`
- Capture op: `runtime.capture_input_motion`, `captureFps=60`, `sampleCount=113`,
  `durationMs=1866.67`, `editorStateAfterCapture.error_count=0`, measure `/AimRig`.
- Trajectory: position fixed (`x=3`, `y=1`, `z=0`); yaw `ry` rises `0 → 150°` at a constant
  `~120°/s` after the `Q` trigger, then plateaus (`rx`/`rz` constant 0 — the entire signal lives in
  yaw).
- Derived metric: `aimTurnRateDegPerSec=119.976 deg/s` (configured `120`; the gap is `tMs` rounded to
  2dp plus the first/last partial moving intervals). Substrate proof: the same samples with the
  rotation fields stripped collapse to a stationary position-only track and the rotation derivation
  REFUSES (`null`) — the value is recoverable only because rotation is sampled.

First live 3D impact-feedback proof (`hitstopMs` + true-3D `screenShakeMag`):

- Raw transcript: `demos/evidence-bundles/3d-impact-feedback/3d-impact-feedback-raw-2026-06-26.json`
- Derived summaries: `demos/evidence-bundles/3d-impact-feedback/3d-hitstop-derived-2026-06-26.json`,
  `demos/evidence-bundles/3d-impact-feedback/3d-screen-shake-derived-2026-06-26.json`
- Generator: `demos/evidence-bundles/3d-impact-feedback/generate.mjs`
- Capture op: `runtime.capture_input_motion`, `captureFps=60`, `sampleCount=111`,
  `durationMs=1833.33`, `editorStateAfterCapture.error_count=0`, measure `/Main Camera`.
- Fixture: a clean-room `Shooter3DImpactFeedback` on the Main Camera opens a hit-stop window + a camera
  punch along WORLD +Z on the enemy's collision hit edge (a real `Shooter3DProjectile` collision; never
  input/timer). World `x`/`y` are constant — the whole shake lives in Z.
- Observed edges: enemy `EnemyHitCount` first rises `0→1` at `633.33ms`; `IsHitStopped` opens at
  `633.33ms` (same frame as the hit) and closes at `750ms`; the camera first leaves rest at `633.33ms`.
- Derived metrics: `hitstopMs=116.67ms` (configured `0.12s`; the gap is `tMs` rounded to 2dp + frame
  quantization) and `screenShakeMag=0.2885u` (configured punch amplitude `0.35`; the discrete sampling
  of the decaying oscillation does not land on the peak). Both are CAUSAL (`isImmediateImpactFeedback`).
  Substrate proof: the same camera samples with `z` stripped (the X/Y projection of a Z-only punch)
  collapse to a stationary track and `deriveScreenShakeMag` REFUSES (`null`) — the magnitude is
  recoverable only because the bridge samples a true `{x,y,z}` trajectory.

First live 3D hitscan proof (`hitscanImpactLatencyMs`):

- Raw transcript: `demos/evidence-bundles/3d-hitscan-weapon/3d-hitscan-raw-2026-06-26.json`
- Derived summary: `demos/evidence-bundles/3d-hitscan-weapon/3d-hitscan-derived-2026-06-26.json`
- Generator: `demos/evidence-bundles/3d-hitscan-weapon/generate.mjs`
- Capture op: `runtime.capture_input_motion`, `captureFps=60`, `sampleCount=81`,
  `durationMs=1333.33`, `editorStateAfterCapture.error_count=0`, measure `/HitscanWeapon`.
- Fixture: a clean-room `Shooter3DHitscanWeapon` (`/HitscanWeapon` at `(0,1,-4)`) fires one
  `Physics.Raycast` along `+Z` on the injected `F` key; the ray strikes the enemy at `15.5u` and applies
  one damage IN THE SAME FRAME. Damage is the SOLE consequence of a raycast hit (a miss raises neither
  `RaycastHitCount` nor damage).
- Observed edges (shot 1): `FireCount`/`RaycastHitCount`/`DamageTakenCount`/enemy `HitCount` all rise
  `0→1` together at `16.67ms`; `IsDead` flips at `316.67ms` after the 3rd shot kills the 3-HP enemy.
- Derived metric: `hitscanImpactLatencyMs=16.67ms` (fire onset `0` → raycast-hit edge `16.67`) — one
  capture frame, the instantaneous-hitscan signature (vs the projectile loop's flight-time `ttkMs`). The
  calculator enforces `fire ≤ raycast-hit ≤ damage` and REFUSES a miss / hit-without-damage /
  damage-without-hit / non-causal ordering — never a false green.

First live 3D AI perception/reaction proof (`enemyReactionLatencyMs`):

- Raw transcript: `demos/evidence-bundles/3d-ai-reaction/3d-ai-reaction-raw-2026-06-26.json`
- Derived summary: `demos/evidence-bundles/3d-ai-reaction/3d-ai-reaction-derived-2026-06-26.json`
- Generator: `demos/evidence-bundles/3d-ai-reaction/generate.mjs`
- Capture op: `runtime.capture_input_motion`, `captureFps=60`, `sampleCount=63`,
  `durationMs=1033.33`, `editorStateAfterCapture.error_count=0`, measure `/Enemy`.
- Fixture: a clean-room `Shooter3DEnemyReaction` on the enemy casts a `Physics.Linecast` toward the
  player each frame; an `Occluder` blocks that line until the injected `T` removes it. Perception is a
  real LOS edge, NOT a timer.
- Observed edges: `OccluderActive` true→false at `216.67ms` (the stimulus); `CanSeePlayer` /
  `TargetAcquiredCount` rise the SAME frame (`216.67ms`, perception); `StartedAimingCount` rises at
  `416.67ms` (reaction).
- Derived metric: `enemyReactionLatencyMs=200.00ms` (perception → reaction; configured reaction delay
  `0.2s`). The calculator REFUSES no-LOS (no perception edge), no-reaction, and a pre-armed reaction
  (reaction before perception) — never a false green.

First live 3D cover proof (`coverBlocksDamage`):

- Raw transcripts: `demos/evidence-bundles/3d-cover-proof/3d-cover-covered-raw-2026-06-26.json` (covered) +
  `demos/evidence-bundles/3d-cover-proof/3d-cover-exposed-raw-2026-06-26.json` (exposed)
- Derived summary: `demos/evidence-bundles/3d-cover-proof/3d-cover-derived-2026-06-26.json`
- Generator: `demos/evidence-bundles/3d-cover-proof/generate.mjs`
- Capture op: `runtime.capture_input_motion`, `captureFps=60`, `editorStateAfterCapture.error_count=0`
  on both, measure `/CoverProbe`.
- Fixture: a clean-room `Shooter3DCoverProbe` on an isolated lane (x=-4, clear of the main lane + the AI
  occluder) fires straight raycasts at a `CoverEnemy`; a `CoverProp` collider sits between them. A shot's
  ray either hits the cover (`BlockedShotCount` rises — a real block, not a miss) or the target (damage).
- Observed: COVERED — 3 shots fired, all 3 blocked, LOS false throughout, 0 damage. EXPOSED (`V` removes
  the cover at `116.67ms`) — LOS restored, 3 shots, 0 blocked, 3 damage.
- Derived proof: `coverBlocksDamage=true`. The calculator REFUSES a miss counted as a block
  (`BlockedShotCount != IncomingShotCount`), damage through cover, false cover (exposed dealt no damage),
  no shot, or no LOS probe — never a false green.

First live 3D wave/objective proof (`waveObjectiveComplete`):

- Raw transcript: `demos/evidence-bundles/3d-wave-objective/3d-wave-objective-raw-2026-06-26.json`
- Derived summary: `demos/evidence-bundles/3d-wave-objective/3d-wave-objective-derived-2026-06-26.json`
- Generator: `demos/evidence-bundles/3d-wave-objective/generate.mjs`
- Capture op: `runtime.capture_input_motion`, `captureFps=60`, `editorStateAfterCapture.error_count=0`,
  measure `/WaveManager`.
- Fixture: a clean-room `Shooter3DWaveObjective` spawns N real target GameObjects on `G` (tracked in a
  live list, so `AliveCount` is the actual live-object count), each `K` destroys one (`KillCount` rises),
  and `ObjectiveComplete` flips true ONLY when the live list reaches 0 after a wave spawned (kill-gated).
- Observed: `SpawnCount` 0→3 at `116.67ms`; `KillCount` 0→1→2→3 at `266.67/416.67/566.67ms`; `AliveCount`
  3→0 (reaches 0 at `566.67ms`); `ObjectiveComplete` false→true at `566.67ms` (the SAME frame as kill-all).
- Derived proof: `waveObjectiveComplete=true`. The calculator REFUSES under-spawn, under-kill
  (`KillCount != SpawnCount`), enemies-remaining (`AliveCount != 0`), no completion, and a completion
  BEFORE kill-all (a timer-driven complete) — never a false green.

## Explicit gaps (NOT green, NOT measurable-now)

| Target | Tag | Why it is not measurable today |
|---|---|---|
| `recoilKickDeg`, `recoilRecoveryMs` | `needs-new-calculator` | The rotation sampler now exists (substrate v2), but recoil is a kick-then-recover pulse with NO recoil calculator yet, and degrees have no supported profile unit (seeded unitless). Not ported blind. |
| `adsTransitionMs`, aim spread | `needs-new-bridge-capability` | No ADS state/FOV/reticle transition sampling. |
| hit-stop / screen-shake QUALITY | `judgment-only` | `hitstopMs` (window duration) and `screenShakeMag` (camera displacement) are measured, but their FEEL — freeze/trauma curves, shake shape (perlin), kickback readability — is not deterministic; pairs with a human/VLM oracle, never a Tier-1 verdict. |
| hitscan penetration / spread / recoil / ADS / tracer | `needs-new-calculator` + bridge | `hitscanImpactLatencyMs` (fire→raycast-hit→damage) is measured; broader hitscan weapon features — penetration, spread, recoil, reload, ADS, tracer/decal, body-part multipliers, lag compensation — are not. |
| enemy AI behavior (beyond reaction) | `needs-new-calculator` + bridge | `enemyReactionLatencyMs` (LOS perception → reaction) is measured; behavior trees, tactical movement, squads, target prioritization, and pathfinding quality are not. |
| wave pacing / mission design (beyond one wave) | `needs-new-calculator` + bridge | `waveObjectiveComplete` (one spawn N → kill-all → complete edge) is measured; multi-wave pacing, difficulty curves, spawn directors, arenas, boss waves, loot rewards, and mission design are not. |
| advanced cover (beyond LOS/damage) | `needs-new-calculator` + bridge | `coverBlocksDamage` (LOS + damage prevention) is measured; tactical planning, cover-point generation, navmesh safe areas, peeking, suppression, flanking, AI cover selection, and cover-map quality are not. |
| `aiming-feel` | `judgment-only` | Look latency and shot/aim alignment are now promoted (measurable-now), but aim fairness/readability, target acquisition comfort, controller curves, dead zones, and camera-composition quality are not deterministic; pairs with a human/VLM oracle, never a Tier-1 verdict. |
| Fusion / multiplayer / netcode | engine-unsupported-today | No `OnInput` injection, network-tick sampling, or interpolation-aware motion sampler. Single-player/local only. |

## No-false-green invariants carried here

- A metric tagged `measurable-now` MUST bind to an implemented calculator id
  (`IMPLEMENTED_CALCULATOR_IDS`); the hint-card validator refuses otherwise.
- A missing sampled field makes a metric `not_measured` / `attempted-blocked`, never green.
- The `3d-shooter` genre registers the same genre-neutral hero-shot fidelity criteria as `2d-shooter`
  (all in `VLM_REVIEW_CRITERION_IDS`); no 3D-specific fidelity criterion is registered until it has a
  gradable definition, so `doneness` cannot become unreachable-green or default to 2D criteria.
- No broad "3D shooter supported" claim is made from this seed. The committed live captures prove
  only the named core-loop counter/edge metrics, true-3D `projectileSpeed`, true-3D
  `aimTurnRateDegPerSec`, the impact `hitstopMs` window, true-3D `screenShakeMag`, the hitscan
  `hitscanImpactLatencyMs` edge chain, the `enemyReactionLatencyMs` perception→reaction edge, the
  `coverBlocksDamage` LOS/damage-prevention proof, and the `waveObjectiveComplete` spawn→kill-all→complete
  sequence above.
- `waveObjectiveComplete` is KILL-GATED: `deriveWaveObjectiveComplete` refuses unless every spawned enemy
  was killed (`KillCount == SpawnCount`, `AliveCount` returns to 0) AND `ObjectiveComplete` rose AT/AFTER
  kill-all — so an objective that completes on a timer (before `AliveCount` returns to 0), an under-killed
  wave, or alive enemies remaining can never green.
- `enemyReactionLatencyMs` is PERCEPTION-gated: `deriveEnemyReactionLatencyMs` refuses unless a real
  perception edge exists AND precedes the reaction, so a scripted reaction with NO line-of-sight
  perception edge can never green (a timer-only "reaction" is refused). The perception edge itself is a
  genuine LOS `Physics.Linecast` in the fixture, not a timer.
- `coverBlocksDamage` is MISS-vs-BLOCK gated: `deriveCoverBlocksDamage` refuses unless the covered case
  blocked EVERY valid shot at the cover collider (`BlockedShotCount == IncomingShotCount`) with zero
  damage AND the exposed case (same shots, cover removed) dealt damage — so a missed shot counted as a
  block, damage through cover, or false cover (exposure dealt no damage) can never green.
- `hitscanImpactLatencyMs` is ORDERING-gated: `deriveHitscanImpactLatencyMs` refuses unless
  `fire onset ≤ raycast-hit edge ≤ damage edge`, so a miss (no raycast hit), a hit-without-damage, or
  damage-without-a-hit (an injected/independent damage the raycast did not cause) can never green.
- `screenShakeMag` stays dimension-agnostic: the calculator uses `hypot(dx,dy,dz)` but a missing `z`
  (legacy 2D capture) is treated as 0, so 2D results are unchanged; a Z-only camera punch with `z`
  dropped collapses to its X/Y projection and REFUSES (`null`) rather than reporting a fabricated ~0.
- Impact feedback (`hitstopMs`/`screenShakeMag`) is CAUSALITY-gated: a feedback edge that preceded the
  hit edge, or arrived more than one capture frame late, is refused (`isImmediateImpactFeedback`), so
  pre-impact animation or a delayed/independent effect can never be certified as impact feedback.
- `projectileSpeed` stays dimension-agnostic: the calculator adds the `z` term but a missing `z`
  (legacy 2D capture) is treated as 0, so 2D results are unchanged; a pure +Z shot with `z` dropped
  refuses rather than reporting a fabricated ~0.
- `aimTurnRateDegPerSec` REQUIRES rotation evidence: the calculator refuses (`null`) when any sample
  lacks the chosen axis (a position-only capture), so a missing rotation field is `not_measured`,
  never a fabricated 0. Rotation fields are additive in the bridge (a position-only consumer ignores
  `rx`/`ry`/`rz`), so existing 2D/position captures are unchanged.

## Next follow-up

Keep widening only where raw evidence exists. **Done:** true `{x,y,z}` trajectory capture/derivation
(`projectileSpeed` live-proven for 3D, substrate v1), true rotation (`{rx,ry,rz}`) capture/derivation
(`aimTurnRateDegPerSec` live-proven for 3D, substrate v2), impact feedback (`hitstopMs` +
true-3D `screenShakeMag` live-proven, causality-gated), hitscan (`hitscanImpactLatencyMs`
live-proven, fire→raycast-hit→damage ordering-gated), enemy AI reaction (`enemyReactionLatencyMs`
live-proven, LOS-perception→reaction gated), cover (`coverBlocksDamage` live-proven, covered-blocks /
exposed-damages with a miss-vs-block guard), waves/objectives (`waveObjectiveComplete` live-proven,
spawn→kill-all→complete, kill-gated), the Phase 07 minimal-vertical roll-up
(`demos/evidence-bundles/3d-shooter-minimal-vertical/`, composition + honest-gap ledger, no new metric), and the
3C controller/camera pair — `lookInputToYawLatencyMs` (look-input onset → first sampled /Player yaw) +
`shotAimAlignmentDeg` (aim forward vs fired shot direction) — live-proven and promoted in PR #355. The
next useful cuts are:

- **Recoil:** add a recoil calculator (kick-then-recover pulse over the rotation trajectory) before
  claiming `recoilKickDeg`/`recoilRecoveryMs`; the rotation evidence exists, the calculator does not.
- Add a reusable verifier/bundle shape for 3D shooter capture evidence instead of keeping these as
  one-off proof bundles.
