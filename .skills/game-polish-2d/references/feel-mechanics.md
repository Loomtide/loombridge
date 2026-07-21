# Feel Mechanics

The locked S4 player-feel component is now:

- `references/player-controller.md` — standalone `PlatformerPlayerController`.
- `references/tuning-run-speed.md`
- `references/tuning-jump-apex.md`
- `references/tuning-dash-distance.md`

Use those references instead of copying the older demo `PlayerController`. The reusable controller has
no `GameManager`, pickup, enemy, or dust dependencies; gameplay integration happens through optional
events and companion slice scripts.

Verification lives in `verify-2d-game/references/feel-checks.md`: final `feel.json` must include
`provenance.sources[]`, and `loombridge verify --slice player-feel` must pass `feel`,
`feel-provenance`, `physics-timestep`, `playability`, `manifest`, and `console-clean`.
