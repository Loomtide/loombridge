# `3d-topdown-arena` methodology gaps

This file is the honest ledger for the **first** `3d-topdown-arena` (twin-stick) genre seed —
the FIRST contract for the empty 3D top-down / twin-stick quadrant (dogfood findings
RCL-F01/RCL-F02). It records exactly what Loomtide can measure for a top-down 3D arena today
versus what is deferred, so no row is ever silently treated as green. It pairs with:

- `acceptance.json` — the plan-time template (`plan --genre 3d-topdown-arena`). Its `framing`
  block declares a TOP-DOWN / high-angle rig (orthographic-or-high-angle projection, a 55–90°
  downward `pitchDownDeg` tilt range, "the play space reads top-down", and a `lookAhead` bias
  toward the aim/movement vector) — explicitly NOT the `3d-shooter` pack's over-shoulder
  third-person rig (`cameraMode: third-person-follow`, `projection: perspective`, FOV 60,
  "player near screen-center").
- `slices.json` — the extraction/greed-loop slice DAG (`plan` instantiates it once the Design
  Target is approved). Every slice carries a `acceptance.criteria.verification` binding so no slice
  is silently unverifiable (see "Slice grammar + verification bindings" below).

## Why this seed exists

The existing `3d-shooter` pack hard-codes an over-shoulder THIRD-PERSON perspective. A real
top-down extraction-shooter / twin-stick arena (the dogfood build is top-down landscape) is
framed from ABOVE looking DOWN, and its camera FEEL is a different dial: the camera DAMPS toward
the player and LEADS the aim/movement vector. The dogfood spec named that dial — "camera
half-life 0.10–0.18s, look-ahead 2–4m" — and **nothing in Loomtide could measure it**. This seed
adds the framing contract for the quadrant plus the calculator that measures the dial.

## Measurable now (implemented calculator; dimension-agnostic)

| Metric | Calculator | Evidence |
|---|---|---|
| `cameraFollowDamping` → `halfLifeMs` (catch-up half-life) + `lookAheadOffset` (steady lead toward the movement vector) | `deriveCameraFollowDamping` (`verification/feel-derive.ts`) | Paired player + camera `{x,y,z}` trajectory captured over the same window: the residual gap to the settled camera pose decays as `g0·exp(−t/τ)`, so a log-linear fit of the decay tail recovers the constant half-life (`τ·ln2`); the look-ahead is the mean signed projection of `(camera − player)` onto the net movement direction in the settled window. Dimension-agnostic (`hypot(Δx,Δy,Δz)`, missing z = 0), so a top-down overhead rig whose follow lives in the XZ plane measures correctly and a 2D capture is unchanged. |

`deriveCameraFollowDamping` is **honest-or-omit**: it REFUSES (never fabricates a damping value)
when either trajectory is malformed, the two captures are not time-aligned, the player never
moves (no follow stimulus), the camera never moves (a fixed/static rig — NOT a follow camera),
the player returns home with no net direction (no look-ahead axis), or the gap never decays
(the camera diverges / a degraded capture). An INSTANT-snap camera (zero damping — the residual
gap collapses within one frame, leaving no decay tail to fit) is NOT a refusal: it is the honest
measurement `halfLifeMs = 0`, with `evidence.instant = true`. So a static camera can never be
laundered into a fabricated half-life, and a rigid no-damping rig reports zero rather than a
made-up "tight" value.

## HONESTY CAVEAT — LIVE capture DEFERRED

`cameraFollowDamping` is **IMPLEMENTED** (`deriveCameraFollowDamping`) and covered by
synthetic-trace unit tests (`mcp-server/src/__tests__/3d-camera-follow-damping.test.ts`:
step-then-ease → exact 140 ms half-life; instant-snap → honest `0`; static-camera /
no-player-motion / no-net-direction / malformed → refusal; look-ahead toward the movement vector
measured; the `3d-topdown-arena` framing profile validates against the production
`validateAcceptanceContract` and declares top-down, not over-shoulder).

But — exactly like the hold-channel, move-speed, extraction win/loss, and extraction-pressure
pairs in the `3d-shooter` ledger — it is **NOT yet backed by a committed live capture**
(`demo-bundles/3d-topdown-camera/*` does not exist). A real twin-stick follow capture (a player
that strafes/dashes while the camera damps toward it and leads the aim vector) needs a built
top-down scene with a paired player + camera trajectory capture. It is an honest measure-only
proof over the documented paired `{x,y,z}` player/camera trajectory; **promote it to live-proven
once a real top-down follow capture is recorded**, the same path the cover/wave substrates took.

## No-false-green invariants carried here

- A static camera (`camera-static`) or a player that never moves (`no-player-motion`) is a
  REFUSAL, never a fabricated half-life — the gate row stays `not_measured`.
- An instant-snap (zero-damping) camera reports `halfLifeMs = 0` honestly — it is a real
  measurement of "no damping", not a refusal and not a fabricated tight value.
- The framing contract NAMES a top-down / high-angle rig and validates against the SAME
  `validateAcceptanceContract` as every other pack, so the empty quadrant is filled WITHOUT a
  schema fork and without claiming the over-shoulder rig is top-down.

## Slice grammar + verification bindings (`slices.json`)

The `slices.json` DAG decomposes the extraction/greed loop into polished slices. Every slice
declares a `acceptance.criteria.verification` binding — one of a small closed taxonomy — so a slice
is **never** silently unverifiable. The binding lives in `acceptance.criteria` (which the slice
schema leaves open, `additionalProperties: true`, and which `instantiateSlicePlan` deep-copies into
the instantiated `.loomtide/SLICES.json`), so it survives instantiation and stays schema-valid.

| `verification` | Meaning | Slices |
|---|---|---|
| `gate` | Verified by a deterministic Tier-1 gate only (structural); no feel calculator / telemetry claimed | `arena` (framing gate), `hud` (ui-conformance) |
| `calculator` | Bound to proven `verification/feel-derive.ts` calculator(s) | `controller`, `weapon`, `enemy-pressure`, `impact-feedback`, `end-state` |
| `telemetry` | Bound to the ground-truthed telemetry event/summary schema (`telemetry.json`, T3-T) | `loot-loop`, `extraction-hold`, `pressure-ramp` |
| `dual-validated` | A qualitative design contract taught independently in TWO extraction-shooter runs | `minimap` (informs-not-reveals) |
| `gap` | An honest gap — the slice's intended feel has NO measurement path yet | *(none in this seed; documented so a future gap is marked, never omitted)* |

**`liveProof` sub-field — do not launder implemented-but-not-live-captured as live-proven.** Each
calculator/telemetry slice carries a `liveProof` note. In this SEED, **no calculator is backed by a
committed live top-down capture** (`demo-bundles/3d-topdown-*` does not exist) — consistent with the
HONESTY CAVEAT above. `deriveCoverBlocksDamage` / `deriveEnemyReactionLatencyMs` / `deriveHitstopMs`
/ `deriveScreenShakeMag` / `deriveWaveObjectiveComplete` are live-proven in the **3d-shooter**
substrate ledger (over-shoulder rig), but their **top-down** capture is deferred.
`deriveHoldChannelDuration` / `deriveHoldInterruptOnDamage` / `deriveZoneObjectiveComplete` /
`deriveStashLossOnDeath` / `deriveThreatRampSlope` / `deriveMoveSpeed` / `deriveCameraFollowDamping`
/ `deriveWallSlideTangentRatio` are IMPLEMENTED + synthetic-trace unit-tested but **live-deferred**.
Promote a slice to live-proven only when a real top-down capture is committed, the same path the
cover/wave substrates took.

### The minimap contract (dual-validated, first-class)

The `minimap` slice encodes the **informs-without-revealing** contract as first-class contract
material (`acceptance.criteria.minimapContract`) because it is one of only **two** dual-validated
extraction-shooter learnings (taught independently in the codex-tuning `019f0dfa` session AND the
Claude `3de0bf92` session):

- **requires:** broad *authored* danger zones are present on the minimap ("this area is getting
  dangerous").
- **forbids:** per-crate loot markers; exact-position enemy radar / precise enemy dots.
- The `~22-26%` arena-coverage figure is retained ONLY as an annotated single-game **anecdote**
  (`coverageAnecdote`), never a band and never machine-enforced.

Tier-1 `ui-conformance` verifies the widget is present and safe-area-legal; the informs-not-reveals
property itself is a **qualitative human/design checklist**, deliberately not a deterministic gate.

## Gated candidates — DO NOT promote to first-class contract material (2nd-run gate)

The learnings below are **single-source** (taught in exactly one extraction-shooter run — the Claude
`3de0bf92` session — with the parallel codex-tuning session parking the same *class*, not the same
*rules*) OR are single-session mobile-quadrant anecdotes. Per the provenance ruling they may appear
here as gated candidates ONLY; they are **NOT** bound anywhere in `slices.json` or `acceptance.json`
as design bands or rules. **Promotion gate: a SECOND independent extraction-shooter (or mobile)
run** that teaches the same rule — at which point they become dual-validated and may be promoted.

**Extraction-shooter greed-loop tuning grammar** (single-source; `3de0bf92`):

- `pressure-tied-to-greed-not-clock` — first enemy spawns *after first loot*, not on a wall-clock
  timer (with a grace fallback + a high-rush trigger). The `pressure-ramp` slice checks only that the
  heat/proximity signal is emitted and rises — never *why*.
- `first/second/third-crate progression` — one free "understanding" crate, then pressure begins, so
  the third crate is the real greed decision.
- `high-loot-behind-route-cost` — the highest-value loot must sit off the extract path and not be
  reachable in the opener, so "high" isn't the default diagonal-home route.
- `geographic-danger-over-global-buffs` — express danger through authored sightlines / danger
  pockets, not global stat buffs.
- `opener-only-nearest-spawn` — bias spawning toward the player only for the opener / early pressure,
  else the map loses spatial strategy.
- `avoid-bespoke-single-scenario-systems` — build pressure from existing systems, not one-off
  scenario scripts (a generalizable design-review principle).

**Mobile-quadrant candidates** (single-session; the `52d42a44` tail of the internal dogfood findings ledger):

- **GRL-C09** — mobile-touch feel (rigid vs floating joystick) is driven by a real-device feedback
  loop Loomtide has no in-editor proxy for; device-in-the-loop is entirely the human. Candidate for a
  `3d-topdown-mobile` pack + product-seam (document the human device loop).
- **GRL-C10** — editor perf ≠ device perf, with no Loomtide device-perf capture; ship a PerfHud
  recipe + Development-Build note. Candidate.
- **GRL-C11** — mobile settings-panel genre knowledge (preset row; render-scale relabeled as
  resolution 720p/1080p; ProMotion-gated 120fps; audio effects applied on popup close). Candidate.

## Gaps closed / narrowed by this seed

- **CLOSED — "no slice grammar for the 3D top-down extraction/greed loop."** `slices.json` now
  decomposes the loop (arena → controller → weapon → enemy-pressure → impact-feedback → loot-loop →
  extraction-hold → pressure-ramp → minimap → hud → end-state) with a per-slice verification binding.
- **CLOSED — "the extraction loot/hold/pressure beats had no measurement surface named in the pack."**
  The `loot-loop` / `extraction-hold` / `pressure-ramp` slices bind to the **ground-truthed** (T3-T)
  telemetry events + summary fields (`loot_*`, `extract_hold_*`, `pressure_start`, `bankedValue`,
  `lostValue`, etc.), so the greed loop is telemetry-measurable, not hand-graded.
- **NARROWED — the minimap "informs-not-reveals" learning** moved from an unstructured note to a
  first-class, dual-validated slice contract.
- **STILL OPEN (live-deferred):** every calculator binding in this seed still lacks a committed live
  top-down capture — see the `liveProof` discipline above. This is the same deferral as
  `cameraFollowDamping` in the HONESTY CAVEAT; it is honestly `not_measured`-until-captured, never a
  silent green.
