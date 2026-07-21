# Playability gate

Catches the level-not-completable / win-by-wrong-rule / hazard-doesn't-kill / collectible-doesn't-score class — including the "YOU WIN fired on the left, away from the flag" bug.

You assemble a `playability.json` of four observed facts by **driving the player and asserting on `GameManager`**, then `evaluatePlayability` checks them against `acceptance.win`.

```json
{
  "completable": true,
  "winRuleObserved": "all-fruit",   // or "reach-flag", etc. — see tie-break below
  "hazardKills": true,
  "collectibleIncrements": true,
  "completionMethod": "played",     // "played" | "teleported" — see Reachability below
  "postWinInputLocked": true,
  "postWinPlayerFrozen": true,
  "restartWorks": true
}
```

## Driving the player — `runtime.probe`, never real-time waits

The sim throttles/freezes when the editor is backgrounded, so wall-clock waits drift. Drive on the physics timeline with `unity_runtime_probe`; state persists between probe calls (the sim is frozen in the inter-call gap, so no drift). Two forms:

- **Single-driver:** one property over phases — `unity_runtime_probe { locator:"/Player", property_path:"forceDash", phases:[{value:1, durationMs:150},{value:0, durationMs:200}] }`.
- **Multi-driver (run + jump/dash simultaneously):** per-phase `drivers[]`, all set at the phase boundary —
  ```
  unity_runtime_probe {
    locator: "/Player",
    phases: [
      { durationMs: 800, drivers: [
          { locator:"/Player", property_path:"forceHorizontal", value:1 },
          { locator:"/Player", property_path:"forceJump",       value:1 } ] },
      { durationMs: 600, drivers: [
          { locator:"/Player", property_path:"forceHorizontal", value:1 },
          { locator:"/Player", property_path:"forceDash",       value:1 } ] }
    ]
  }
  ```
  Multi-driver is what makes real traversal (run + action) possible — required before "completable" is a hard gate. **It needs an MCP reconnect to advertise the `drivers[]` form.**
- **Stopgap:** persistent fields stay set across calls — `unity_component_set_property forceHorizontal=1`, then chain single-driver probes for `forceDash`/`forceJump`. Good for a straight slice, not precise multi-moment sequencing.

## Reachability (no teleporting)

**PROVE collectibles are reachable — do not teleport to them.** Teleporting the player onto a collectible (`unity_scene_set_transform`) only verifies pickup LOGIC (the trigger fires, score increments); it does NOT prove the player can actually GET there by jumping/dashing/bouncing. A clean-room build can pass "completable" by teleporting and still ship a collectible stranded above the jump arc. To prove completion, **drive the player with input / `unity_runtime_probe` (jump/dash drivers) along the route** — same multi-driver form as above — and let the player arrive under its own motion.

Record **`completionMethod`** in `playability.json`: `"played"` if you drove the player along the route, `"teleported"` if you set its transform. The gate **WARNS** when completion was teleported (reachability unproven) and **PASSES** when it was played. Always prefer `"played"`.

Capture a **`reachability.json`** for the deterministic reachability gate (the geometric jump/dash/trampoline envelope). Read each relevant object with `unity_scene_get_bounds` and assemble:

```json
{
  "player": { "startX": -7.0, "startY": -2.5 },
  "platforms":   [ { "name": "/Level/Ground", "topY": -2.5, "minX": -8.0, "maxX": 8.0 } ],
  "launchers":   [ { "name": "/Level/Trampoline", "x": 1.2, "topY": -1.8, "launchApex": 4.5 } ],
  "collectibles":[ { "name": "/Level/Fruit_0", "x": 3.4, "y": 1.2 } ]
}
```

- **player.startX / startY** — the player's spawn world position.
- **platforms[].topY** — the platform's walkable **top surface** Y (where the player stands), with its horizontal span `minX`..`maxX`.
- **launchers[].launchApex** — how high a trampoline throws the player (peak Y reached off the bounce); `x`/`topY` locate the launcher's surface.
- **collectibles[].x / y** — the collectible's **world center**.

The reachability gate geometrically checks each collectible sits within the jump/dash envelope from some platform or launcher; a missing `reachability.json` degrades it to **warn**.

## Assertions — `runtime.assert_condition` (reuse)

`unity_runtime_assert_condition` / `unity_runtime_wait_for_condition` read **instance fields on a locatable GameObject** (not statics). `GameManager.isWin`, `isGameOver`, `lives`, `score` are instance fields on `/GameManager` → directly assertable. Use the existing `isWin` — do not add a `won` field.

- **completable:** assert `/GameManager isWin == false` before the goal-overlap drive, drive to the goal, assert `isWin == true` after.
- **winRuleObserved:** determine *how* `isWin` fired. Drive to the flag WITHOUT collecting all fruit → if `isWin` is true, the rule is reach-flag-capable; collect all fruit away from the flag → if `isWin` flips, the rule is all-fruit. Record the rule that actually fired.
  - **Tie-break when multiple rules can fire.** A build may accept *several* win triggers (e.g. all-fruit AND reaching the flag both flip `isWin`). The gate compares ONE observed rule to `acceptance.win.rule`, so record the rule that **diverges from the contract** — that's the one that makes the gate flag a real mismatch. If every fireable rule matches the contract, record the contract rule (no divergence). Don't silently record the matching one and hide a divergent trigger.
- **hazardKills:** read `lives`, drive the player into a saw/spike, assert `lives` decremented.
- **collectibleIncrements:** read `score`, drive over a fruit, assert `score` incremented.
- **postWinInputLocked:** after the win/lose overlay appears, keep the sim in that state and drive normal
  gameplay input for ~0.5s via `unity_runtime_probe`. Assert input no longer changes gameplay state
  (player cannot run/jump/dash, no extra scoring, hazards do not continue killing behind the card).
- **postWinPlayerFrozen:** record player position/velocity at the first modal end-state frame, drive the
  same post-win input probe, then assert position delta is within a tiny epsilon and velocity is zero or
  ignored by the frozen state. This catches the "win popup appears but the game keeps running" bug.
- **restartWorks:** invoke the declared restart affordance (`acceptance.win.restartAction`, commonly `R`
  or a UI button) and assert the game returns to a playable state: `isWin == false`, player near spawn,
  score/timer/lives reset according to the contract.

## Modal end-state default

Most polished games treat win/lose as a modal state: gameplay stops behind the end-card and only
restart/continue/menu actions remain live. Loombridge therefore treats `acceptance.win.endStateMode` as
`"modal"` when omitted. If a game intentionally keeps simulation running during the result sequence,
declare:

```json
{
  "win": {
    "rule": "all-fruit",
    "endStateMode": "continuous",
    "note": "The endless-run celebration keeps scrolling for 2s before score summary."
  }
}
```

For modal games, use a `GameState` / `RunState` enum or equivalent boolean gate in input, hazards,
pickups, timers, and player motion. Prefer a logical freeze over blindly setting `Time.timeScale = 0`;
if you do set `timeScale`, make UI animations/restart use unscaled time.

## Checks (`evaluatePlayability`)

- `playability.completable` — false ⇒ **fail**; `undefined` ⇒ **warn**.
- `playability.completionMethod` — `"teleported"` ⇒ **warn** (reachability not proven; you faked completion); `"played"` ⇒ **pass**; `undefined` ⇒ **warn**.
- `playability.winRule` — `winRuleObserved` must equal `acceptance.win.rule` ⇒ **fail** on mismatch (this is where all-fruit-vs-reach-flag surfaces); `undefined` ⇒ **warn**.
- `playability.hazardKills` / `playability.collectibleIncrements` — false ⇒ **fail**; `undefined` ⇒ **warn**.
- `playability.postWinInputLocked` / `postWinPlayerFrozen` / `restartWorks` — checked when
  `acceptance.win.endStateMode` is omitted or `"modal"`; false ⇒ **fail**, `undefined` ⇒ **warn**.
  Skipped for `"continuous"`.

## Reconcile pattern

A divergence between the build and the contract is resolved by **conforming the build** OR
**consciously adopting the build's behavior and updating `acceptance.win.rule`** (documenting why in
`buildRule`/`note`). The contract is the source of truth — either choice is valid, but it must be a
recorded decision, not a silent drift.
