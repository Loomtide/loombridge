# Live Unity Projectile Speed Dogfood

This records the shooter measurement-loop follow-up after `projectileSpeed` became measurable through the
generic trajectory derivation path.

## Claim

- A projectile that can be bound as the measured trajectory subject can produce `projectileSpeed` from raw
  `runtime.capture_input_motion` samples.
- The calculator ignores the stationary pre-launch prefix and derives median moving interval speed.
- This does not close automatic runtime-spawned object discovery; it only proves a pre-bound projectile
  trajectory can derive speed.

## Run

- Unity project: `unity-projects/shooter-projectile-dogfood`
- Scene: `Assets/Scenes/ShooterProjectileDogfood.unity`
- Measured object: `/Projectile`
- Input phase: `Space` held for 500ms
- Capture FPS: 60
- Calculator result: `projectileSpeed = 17.9964u/s`

## Artifact

- `live-projectile-speed-capture-2026-06-25.json`
