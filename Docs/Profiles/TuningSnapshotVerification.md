# Tuning Snapshot Verification (a lockfile for game feel)

**CLI:** `loombridge feel snapshot <capture|approve|status>` + `loombridge verify --snapshot`
**Artifacts:** `~/.loombridge/projects/<id>/feel/snapshots/{candidate,current}/`, report at
`.../feel/reports/feel-snapshot-drift.{json,md}`

Archetype profiles (`verify --profile`) grade a game against a named opinion. The tuning
snapshot makes verification generic: measure the running game's ACTUAL behavior, let a
human approve it once ("this feels right"), freeze that measured state, and afterwards
verify DRIFT against the frozen snapshot instead of against anyone's opinion. `trace`
catches pixel drift; the snapshot catches kinematic drift.

The subjective judgment happens exactly once, at approve. After that, verification is
objective: numbers against a frozen anchor. This is the third instance of the repo's
approve-once / freeze / refuse-drift grammar (Design Target: composition; trace baselines:
pixels; snapshot: kinematics).

## Why measured behavior, not serialized parameters

Git already diffs tuned fields for free. The snapshot freezes what the game measurably
DOES (jump apex, run speed, time to apex, latencies), so it catches regressions that touch
no tuned field at all: a PhysicsMaterial2D swap, a Fixed Timestep change, a collider
resize, a new script stealing a FixedUpdate. Your jump apex dropped 0.4u and no parameter
changed; only a behavioral baseline sees it.

## Lifecycle

```bash
# 0. One-time: author the capture contract (existing machinery)
loombridge verify --profile classic --setup-capture --player "/Player" --jump-key space --apply --id my-game

# 1. Stage a candidate (live Unity capture; profile-less)
loombridge feel snapshot capture --id my-game

# 2. Play the game. When it feels right, freeze it
loombridge feel snapshot approve --id my-game --note "post 1.2 tuning, feels right"

# 3. From then on (CI, after any change): the drift gate
loombridge verify --snapshot --id my-game
```

- `capture` stages `snapshots/candidate/` (measurements + a frozen copy of the contract +
  a cleanliness report). Staging only; nothing is approved. A bridge/harness fault exits 2.
- `approve` recomputes candidate cleanliness from the raw files (a hand-edited staged
  report cannot launder an approve) and REFUSES a non-clean candidate: any §0
  re-derivation failure, zero metrics, or coverage gaps without `--allow-partial`
  (which freezes the measured subset and records the gaps on the manifest, never
  silently). Only then does it write `snapshots/current/`.
- `status` is read-only: integrity + summary. A tampered bundle prints NOT READY, exit 2.

## What the manifest freezes

`snapshots/current/manifest.json` (`kind: "feel-snapshot"`):

- per-metric `{ value, derivation, confidence }`; a §0-`rejected` value never freezes;
- sha256 of the frozen measurements AND of the capture contract. The snapshot is bound to
  HOW it was measured: comparing a keyboard-captured baseline under a different stimulus
  contract is apples to oranges, so a contract mismatch at verify time refuses (exit 2,
  "re-approve under the new contract");
- the frozen tolerance policy (below), the human `note`, `approvedAt`/`capturedAt`, and
  `captureRuns` (the seam for N-run averaging later).

Integrity is recomputed at every read, never trusted from the manifest: shas, strict
value equality between manifest and frozen measurements, and §0 re-derivation re-run over
the FROZEN samples, so a doctored baseline fails its own evidence.

## Tolerances

Per metric: `applied = max(absFloor(derivation), relPct * |baseline|)`, drift iff
`|current - baseline| > applied`. Defaults (sized against known single-capture variance):

| Derivation | Absolute floor | Why |
|---|---|---|
| trajectory / phase-delta / trace | 0.05 (native unit) | small kinematic jitter |
| bisection | 0.02 s | roughly one fixed tick (coyote/jump-buffer probes) |
| sync | 100 ms | capture cadence (~80 ms) quantizes sync latencies |
| reported | 0 | a typed number has no jitter excuse |

plus `defaultRelPct: 0.05`. Overrides (`feel snapshot approve --tolerances <json>`) are
validated against the candidate's metric ids and FROZEN into the manifest. There is
deliberately no verify-time loosening flag: a lockfile whose tolerance widens at check
time is not a lockfile. Re-approval is the change path.

## The drift gate (`verify --snapshot`)

Input modes:

- default: live-capture using the snapshot's own frozen contract (binding `verified` by
  construction);
- `--capture-contract <p>`: live-capture with an explicit contract, hash-checked
  (mismatch refuses, exit 2);
- `--measurements <p>`: offline grading; the binding cannot be proven and is stamped
  `unverified` on the report (exit 1 under `--strict`), never silently.

§0 re-derivation and stimulus distrust run on the CURRENT capture too: a current value
whose own samples refute it is `rejected` and drives the drift verdict; it never compares
as clean, even when numerically identical to the baseline.

Exit contract (0 clean, 1 drift, 2 harness/integrity):

| Case | Exit |
|---|---|
| every baseline metric measured, within tolerance, §0 clean both sides | 0 |
| any metric beyond tolerance, or a current value rejected by §0 | 1 |
| clean but binding `unverified`, under `--strict` | 1 |
| no approved snapshot / tampered bundle / contract mismatch / live capture fault | 2 |
| a baseline metric unmeasured now (absent, or coverage says not measured) | 2 (capture gap, never a pass, never a regression) |
| a current metric absent from the baseline | informational only (`newMetrics`) |

The report (`feel-snapshot-drift.json` + `.md`) carries per-metric
baseline/current/delta/tolerance/status, the binding, integrity failures, and
`snapshot.manifestSha256`: the named seam for a future `doneness` binding.

## Relation to profiles

Profiles remain the build-time spec ("build a precision platformer") and the diagnostic
wedge for a game with no baseline yet. Once a human approves how the game actually
plays, the game's own snapshot becomes the truth and drift, not archetype distance, is
the verdict. See [PlatformerFeelProfiles.md](PlatformerFeelProfiles.md) for the
grammar/taste split on the profile side.
