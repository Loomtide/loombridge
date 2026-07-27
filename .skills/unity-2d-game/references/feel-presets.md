# Game-Feel Presets + Auto-Tune Loop (2D Platformer)

This is the curated-craft layer: adjectives → measurable feel targets → physics params, then a
**measure → compare → tune** loop that verifies the built game actually hits the target feel.

Use with `runtime.measure_motion` (the measurement op) and the standard build flow in
`build-checklist.md`.

> MVP scope: three controllable+measurable metrics — **jump apex height, time-to-apex, run speed**.
> `groundAccelMs` is deferred (the default PlayerController sets horizontal velocity instantly; honoring
> an accel ramp needs a script change — v2).

## 1. The feel identity — profiles, not loose adjectives

The single source of truth for a platformer feel is a **product-owned profile**
(`mcp-server/src/capabilities/genre/genre-packs/platformer-2d/profiles/*.profile.json`): a named set of measurable
target **bands** (the verify side) plus an optional `build` block holding only the starting params a
band can't analytically solve (the build side). The three shipped identities are `precision`,
`classic`, and `momentum`.

> Adjective note: `precise` ≈ the `precision` profile. The old `snappy` / `floaty` / `weighty`
> adjectives have **no profile counterpart and are retired from the build surface** — pick one of the
> three profiles, not a loose adjective. Don't hand-author starting numbers; resolve them from the
> profile (next section).

## 2. Profile → Physics Params (analytic solve)

Starting params come from `resolveStartingParams(profile)`
(`mcp-server/src/capabilities/genre/genre-packs/platformer-2d/solve-params.ts`) — the build-side counterpart to the
verify bands. It DERIVES everything solvable from the band targets and reads only the un-solvable
remainder (`jumpCutMultiplier`, `fixedTimestep`) from the profile's `build` block. For a 2D jump with
initial vertical velocity `v0` (jumpSpeed) and `gravityScale` `k`, with Unity 2D default gravity 9.81:

```
g_eff       = k * 9.81                       # effective gravity (m/s^2)
apexHeight  = v0^2 / (2 * g_eff)
timeToApex  = v0 / g_eff                      # seconds

# Solve for params from the profile's band targets:
v0           = 2 * jumpApex.target / (timeToApex.target/1000)
gravityScale = v0 / ((timeToApex.target/1000) * 9.81)
moveSpeed    = runSpeed.target                 # PlayerController: velocity.x = input * moveSpeed
# jumpCutMultiplier + fixedTimestep are read from build.stored / build (not solvable)
```

Resolved starting params for the shipped profiles (GENERATED from the profile JSONs by
`scripts/sync-loombridge-artifacts.mjs` — do not edit by hand; edit the profile and regenerate):

<!-- BEGIN GENERATED: starting-params (scripts/sync-loombridge-artifacts.mjs) -->
| Profile | jumpSpeed (v0) | gravityScale | moveSpeed | jumpCutMultiplier | fixedTimestep |
|---------|----------------|--------------|-----------|-------------------|---------------|
| `precision` | 21.43 | 7.80 | 9 | 0.08 | 0.0166667 |
| `classic` | 18.10 | 4.39 | 7 | 0.3 | 0.0166667 |
| `momentum` | 18.42 | 4.94 | 14 | — | 0.0166667 |
<!-- END GENERATED: starting-params -->

Apply via `unity_component_set_property` on the Player `Rigidbody2D` (`gravityScale`) and on the
`PlayerController` (`jumpSpeed`, `moveSpeed`; `jumpCutMultiplier` on early release where the profile
bands `shortHopApex`). Building from the resolved params means the first playtest already lands close;
the loop only corrects discretization residual.

## 3. Measurement Procedure — use the in-process FeelHarness

**Do NOT drive input + sampling over MCP frame-by-frame** — that is latency-bound and unreliable for
fast/precise gameplay (the agent's thinking time between calls + network round-trips desync from the
50–120Hz physics loop). Instead, measurement runs **in-process** via `FeelHarness.cs`
(`demos/unity-platformer/Assets/Scripts/FeelHarness.cs`), and the agent only configures it
and reads the result. This is how every serious game-engine MCP project does verification.

Why it's robust: the harness pins `Time.captureDeltaTime = Time.fixedDeltaTime` and
`Application.runInBackground = true`, so it measures deterministically on the physics timeline
**even while Unity is unfocused under MCP control**. It triggers the jump/run through the
controller's real path (`forceJump` / `forceHorizontal`), samples every `FixedUpdate`, and detects
apex by vertical-velocity zero-crossing.

Agent workflow (existing tools only — no special op):
1. **Edit mode:** `unity_scene_create_object` a `FeelHarness` GameObject, `unity_code_attach_script`
   the `FeelHarness` script. (autoRun=true by default; captureFps=60.)
2. Apply the solved physics params on the Player (`gravityScale` on Rigidbody2D; `jumpSpeed` /
   `moveSpeed` on PlayerController) via `unity_component_set_property`.
3. `unity_editor_play`; wait for play, then `unity_editor_wait_for { delayMs: ~4000 }` (the harness
   runs settle → jump → land → run, ~2s of game time).
4. `unity_component_get_properties { locator:{path:"/FeelHarness"}, type_name:"FeelHarness",
   include_paths:["feelStatus","resultApexHeight","resultTimeToApexMs","resultRunSpeed"] }`.
   Poll until `feelStatus == "done"`.
5. Read `resultApexHeight` (units), `resultTimeToApexMs`, `resultRunSpeed` (units/sec).
6. `unity_editor_stop`, compare to spec, tune, repeat.

Note: a small systematic discretization undershoot on apex height (~2–6%, larger at higher gravity)
is expected and is exactly what the tune loop corrects.

## 4. Tolerances (PASS bands)

| Metric (FeelHarness field) | PASS band |
|----------------------------|-----------|
| `resultApexHeight` | ±5% |
| `resultTimeToApexMs` | ±20 ms |
| `resultRunSpeed` | ±5% |

## 5. Auto-Tune Loop (agent-driven)

Loop, max 5 iterations. Each iteration: apply params (edit mode) → enter play → read FeelHarness
result → compare → if any metric out of band, correct params and repeat.

Correction policy (one-step, explainable):

```
# Apex height scales with v0^2:
jumpSpeed   *= sqrt(targetApex / measuredApex)

# Re-fix time-to-apex from the (new) jumpSpeed:
gravityScale = jumpSpeed / (targetTimeToApexSec * 9.81)

# Run speed is linear in moveSpeed:
moveSpeed   *= (targetRunSpeed / measuredRunSpeed)
```

Apply corrected params, re-measure. Stop when all metrics are within tolerance, or after 5
iterations (report the best attempt). Because the start point is analytically solved, convergence is
typically 1–3 iterations.

## 6. Feel Report (output artifact)

Emit after the loop ends — the proof artifact:

```
FEEL REPORT — "precision" profile  (converged in 1 iter)
metric           target     measured    band      result
jumpApexHeight   3.00 u     3.02 u      ±12%      PASS
timeToApexMs     280 ms     283 ms      ±60ms     PASS
runSpeed         9.00 u/s   8.71 u/s    ±15%      PASS
VERDICT: feel matched ✓     params: jumpSpeed=21.43 gravityScale=7.80 moveSpeed=9
```

Include the final tuned params and iteration count. The report is the reproducible evidence that the
built game matches the intended feel.

> The dated validation notes below predate the F2 feel identity and reference the retired
> `snappy`/`floaty`/`precise` adjectives; they are kept verbatim as the historical measurement record
> of those runs. New builds resolve params from a profile (§2), not these adjectives.

**Validated 2026-05-21** (measured in-process via FeelHarness, Unity unfocused under MCP control):
- `snappy` (jumpSpeed 17.7, gravityScale 6.24, moveSpeed 9): apex 2.41 / 283ms / 8.59 — 3/3 PASS (1 tune iter)
- `floaty` (jumpSpeed 12.31, gravityScale 2.41, moveSpeed 6): apex 3.12 / 517ms / 5.84 — 3/3 PASS (0 tune iters)
Two prompts → two measurably distinct, verified games.

**Re-validated 2026-05-22** on the merged asset-dressed scene + tight-precision follow camera
(`FreshPlatformerWithAssets`): `snappy` reproduced bit-identical (2.41 / 283ms / 8.59), confirming the
loop is unaffected by visuals/camera. New `precise` preset converged in 1 tune iter
(jumpSpeed 22.44, gravityScale 9.53, moveSpeed 11.63): apex 2.51 / 233ms / 11.01 — 3/3 PASS. The run
correction (11→11.63 moveSpeed for an 11.0 felt speed) shows the loop compensating for real ground
friction the analytic solve omits.
