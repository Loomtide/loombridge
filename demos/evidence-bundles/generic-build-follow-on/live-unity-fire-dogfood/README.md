# Live Unity Fire-Cadence Dogfood

This records the narrow slice after `fireIntervalMs` became measurable through the generic
TypeScript runner path. It replaces the fixture-backed runner evidence with a real Unity capture from a
throwaway shooter fixture.

## Proven Claim

- A Unity project exposes a monotonic shot counter (`DogfoodWeapon.FireCount`).
- `runtime.capture_input_motion` drives the fire key in-loop with an InputSystem `Space` phase.
- `sampledFields` records the shot counter into `fieldTimeline`.
- The generic feel-capture assembler derives `fireIntervalMs = 133.3325ms` from that raw fieldTimeline.

## Not Claimed

- Projectile speed, explicit input-to-spawn latency, and TTK are separate metrics with separate evidence.
- A visual/production shooter build is not required for this slice.
- A fixture-backed JSON sample is not enough; the accepted artifact must come from a Unity editor run.

## Fixture

The disposable project has been scaffolded locally at:

```text
unity-dev-project/shooter-fire-dogfood
```

It is intentionally not committed. The successful run used Unity `6000.3.9f1`; the tracked artifact is
`live-fire-capture-2026-06-25.json`.

## Capture Shape

The live evidence includes:

- `capture-contract.json` with a keyboard interaction similar to:

```json
{
  "id": "hold-fire",
  "kind": "keyboard",
  "measure": { "path": "/Player" },
  "phases": [{ "keys": ["Mouse0"], "durationMs": 420 }],
  "sampledFields": [
    {
      "id": "weapon-fire-count",
      "locator": { "path": "/Player/Weapon" },
      "type_name": "Weapon",
      "property_path": "FireCount"
    }
  ]
}
```

- raw bridge output from `runtime.capture_input_motion`, including:
  - `phases[0].keys` containing `Mouse0`
  - `fieldTimeline[]` containing `weapon-fire-count`
  - at least two observed counter edges
- assembled `profile-measurements.json` showing `fireIntervalMs` measured.

## Acceptance

`demos/evidence-bundles/generic-build-follow-on/2d-shooter-experimental-run.json` now points at the live artifact,
and the `live-unity-fire-event-capture` methodology gap is removed. All remaining shooter-feel gaps stay
explicit.

Missing input session, missing active-phase key evidence, unresolved sampled fields, or fewer than two shot
edges must remain `attempted-blocked` / `not-measured`, never green.
