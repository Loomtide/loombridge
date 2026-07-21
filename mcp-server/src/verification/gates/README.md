# Tier-1 Deterministic Gates (Phase C)

Pure, unit-testable gate evaluators for the Loomtide verification pipeline.
Each gate grades one captured op-output file against the acceptance contract
and reports pass/warn/fail; `run-gates.ts` aggregates every gate's report into
the final `build-verdict.json`.

Each evaluator is a **pure function** `(opOutput, acceptance) -> GateReport`. No
Unity/MCP/editor calls live here — that's Phase E/F. This layer just turns
captured op output + the acceptance contract into pass/warn/fail reports.

## Report shape

```ts
GateReport = {
  gate: string,
  checks: { id, expected, actual, status: "pass"|"warn"|"fail", detail }[],
  verdict: "pass"|"warn"|"fail",   // worst-of the checks
}
```

`aggregateVerdict(reports[])` → `build-verdict.json`:

```ts
BuildVerdict = {
  status: "pass"|"warn"|"fail",
  gates: { [gateName]: verdict },
  checks: [...all checks...],
  failures: [...status==="fail"...],
  warnings: [...status==="warn"...],
}
```

### How warn vs fail is decided

- **fail** — a hard contract violation: wrong font, wrong HUD color, a required
  HUD element / manifest element missing, a placeholder asset, a required object
  clipped/off-screen, level not completable, win fires by the wrong rule, a
  hazard that doesn't kill, a collectible that doesn't score, a measured feel
  metric out of band.
- **warn** — a soft / context-dependent signal that should be surfaced but must
  NOT break the build:
  - the **player anchor** off-target (static-vs-follow-camera reconcile — see
    `framing.playerAnchor.note`),
  - **manifest extras** when `extrasAreFailure` is false (the default),
  - a check that **could not be evaluated**: no acceptance target/palette role
    to compare against, or a metric/field the orchestration did not measure
    (`undefined` input).
- **pass** — within tolerance / present / observed-correct.

Aggregation: any gate `fail` ⇒ overall `fail`; else any `warn` ⇒ `warn`; else
`pass`. Tier-1 is the build gate (the VLM tier in §5 is advisory and separate).

## Orchestration recipe (Phase E/F)

Call the op with these args, then feed its output into the matching evaluator.

| Gate | Op call (Phase E/F) | Evaluator |
|---|---|---|
| **ui-conformance** | `ui.scan_text_components { locator: "/HUD" }` (Canvas/HUD root) | `evaluateUiConformance(scanResult, acceptance)` |
| **framing** | `scene.get_screen_rects { locators: ["/Player", "/Level/Flag", "/Level/Saw", ...] }` (player + the goal/hazards/collectibles you require in-frame) | `evaluateFraming(screenRects, acceptance)` |
| **manifest** | `scene.verify_manifest { manifest: acceptance.manifest }` (the op applies the `matching`/`caseSensitive`/`placeholderRule` rules and returns `{missing,placeholders,extras,all_ok}`) | `evaluateManifest(verifyResult, acceptance)` |
| **playability** | Drive the player: multi-driver/sequenced `runtime.probe` (run + jump/dash) along the path, then `runtime.assert_condition` / `runtime.wait_for_condition` on `GameManager.isWin` (false before goal-overlap, true after), `lives` (decrements on a hazard drive), `score` (increments on a collectible drive). Assemble the booleans + observed win rule into `PlayabilityResults`. | `evaluatePlayability(results, acceptance)` |
| **feel** | FeelHarness for `runSpeed`/`jumpApex`/`timeToApex`; `runtime.probe` recipes for `dashDistance` (`forceDash`, measure ΔX), `shortHopApex` (`forceJump`+`forceJumpCut`, peak Y), `coyoteTime`/`jumpBuffer` (timed probe phases). Assemble into `FeelMeasurements`. | `evaluateFeel(measurements, acceptance)` |

Then:

```ts
const verdict = aggregateVerdict([
  evaluateManifest(...),         // §10 run order: cheap → expensive, fail-fast
  evaluateUiConformance(...),
  evaluateFraming(...),
  evaluatePlayability(...),
  evaluateFeel(...),
]);
// write verdict -> build-verdict.json
```

### Input-shape notes for the live ops (Phase E/F gaps)

- `playability` defines its INPUT (`PlayabilityResults`) here; Phase F must
  produce it. `runtime.probe` is **single-driver** today (plan §3.3) — a
  sequenced/multi-driver probe or an in-process playability harness is required
  before "completable" is a hard gate. Until then, fields left `undefined`
  degrade to WARN rather than FAIL.
- `feel`'s `dashDistance`/`shortHopApex`/`coyoteTime`/`jumpBuffer` come from
  `runtime.probe` recipes, not the current FeelHarness (which only does
  apex/time-to-apex/run). Unmeasured metrics degrade to WARN.
- The component→HUD-role mapping in `ui-conformance` is by **name substring**
  (`ScoreLabel` → `score`). If a project names HUD text differently, either
  rename or extend the mapping.
- `framing` identifies the player by name (`player`/`ninja`/`frog`, or a
  `playerNameHint` option). Pass the goal/hazard locators you want clip-checked.
