# Platformer Feel Profiles

**Status:** S5a — Profile Contract (shipped 2026-06-02)
**Source of truth:** `mcp-server/src/capabilities/genre/genre-packs/platformer-2d/`
**Schema:** `mcp-server/src/domain/schemas/platformer-profile.schema.json`

A **profile** is a product-owned, named set of *measurable* 2D-platformer feel target
bands. It is the verify-first counterpart to a game's `AcceptanceContract.feel` section:
where a contract pins one game's exact feel, a profile says "for **this kind** of
platformer, a healthy metric sits in **this band**." `loombridge verify` selects a profile
and reports measured-vs-band per metric — no prior `plan` or `build` required.

## The anti-vibe rule

Every profile metric **must** define a tolerance band — never a bare exact target.
Feel is measured behaviorally and never lands on an exact value, so an exact target
would either always FAIL or be a prose vibe with no honest pass window. The validator
(`validator.ts`) **refuses** a band-less metric (`MISSING_BAND`), an empty `metrics`
map (`NO_METRICS`), a metric id outside the known vocabulary (`UNKNOWN_METRIC`), an
unsupported unit (`UNSUPPORTED_UNIT`), a supported-but-wrong unit for a metric
(`WRONG_UNIT`), and a malformed profile id (`INVALID_PROFILE_ID`). This mirrors the
§3a "an absent binding is a refusal, not a skipped check" discipline.

## The three profiles, in measurable terms

A band is `±percent` (`{ "percent": 15 }`) or `±absolute` (`{ "abs": 0.03 }`) around
the target. Units: `u` (world units), `u/s`, `u/s^2`, `s`, `ms`, `px`, `x` (multiplier).

### `precision` — tight action platformer (Celeste-like)

Low-latency, snappy, controlled. Short jump, fast rise, heavy fall, explicit forgiveness.

| Metric | Target | Band |
|---|---|---|
| runSpeed | 9 u/s | ±15% |
| runAcceleration | 90 u/s² | ±25% |
| runDeceleration | 120 u/s² | ±25% |
| jumpApex | 3 u | ±12% |
| timeToApex | 280 ms | ±60 ms |
| shortHopApex | 1.1 u | ±20% |
| fallGravityMultiplier | 1.6× | ±0.4 |
| coyoteTime | 0.1 s | ±0.03 s |
| jumpBuffer | 0.1 s | ±0.03 s |
| dashDistance | 4 u | ±15% |
| dashTime | 0.15 s | ±0.05 s |
| dashCooldown | 0.2 s | ±0.1 s |

### `classic` — readable, forgiving (Mario-like)

Taller, floatier jump with more hang time and broad landing readability. A slight slide
on release; the classic "floaty rise, fast fall" asymmetry.

| Metric | Target | Band |
|---|---|---|
| runSpeed | 7 u/s | ±20% |
| runAcceleration | 45 u/s² | ±30% |
| runDeceleration | 35 u/s² | ±30% |
| jumpApex | 3.8 u | ±15% |
| timeToApex | 420 ms | ±80 ms |
| shortHopApex | 1.4 u | ±25% |
| fallGravityMultiplier | 2× | ±0.5 |
| coyoteTime | 0.08 s | ±0.04 s |
| jumpBuffer | 0.12 s | ±0.05 s |

### `momentum` — speed-building (Sonic-like)

High top speed, gradual acceleration, long deceleration glide, high terminal velocity.
Momentum matters more than instant stop-start control.

| Metric | Target | Band |
|---|---|---|
| runSpeed | 14 u/s | ±20% |
| runAcceleration | 25 u/s² | ±30% |
| runDeceleration | 18 u/s² | ±35% |
| jumpApex | 3.5 u | ±18% |
| timeToApex | 380 ms | ±90 ms |
| maxFallSpeed | 24 u/s | ±20% |
| coyoteTime | 0.1 s | ±0.04 s |
| jumpBuffer | 0.1 s | ±0.05 s |

## Metric vocabulary

Profile metric ids are a closed set (`KNOWN_PROFILE_METRICS` in `types.ts`), each pinned
to one canonical unit: `runSpeed`, `runAcceleration`, `runDeceleration`, `jumpApex`,
`timeToApex`, `shortHopApex`, `fallGravityMultiplier`, `maxFallSpeed`, `dashDistance`,
`dashTime`, `dashCooldown`, `coyoteTime`, `jumpBuffer`, `cameraLookahead`,
`cameraSettleTime`, `hitStopMs`, `screenShakePx`, `knockbackImpulse`. A profile targets a
subset — unsupported families (e.g. dash for `classic`) are simply omitted, never faked.

## Notes

- These bands are **starting reference values**, validated by the schema and tests but not
  yet by external projects. The S5e design-partner protocol exists to tune them against
  real precision / classic / momentum games; band changes go through reviewed updates.
- A profile metric target reuses the verification `NumericTarget` shape, so the existing
  feel gate's `bandWindow` / `withinBand` (`gates/feel.ts`) consume a profile target
  unchanged — the comparison code is shared, not duplicated.
