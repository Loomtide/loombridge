# Feel instrument, E6 live run: the artifacts the repair is pinned to

The first time the feel producer (`capture-feel.ts`) and the physics-timestep gate met a REAL editor
they could not pass together. Both shipped in one commit and both had only ever been exercised
against a scripted bridge whose echoes are not rounded and whose game has no hazards. These are the
files that run produced, kept verbatim so the fixes are pinned to reality rather than to a fake.

Project: TideRunner, a 2D platformer with spikes at `x >= 9.03` and a player spawn at `x = 6.4`.
Unity 6000.x, 60Hz fixed timestep.

## The files

| file | what it is |
| --- | --- |
| `tiderunner-feel-run1-2026-07-31.json` | run 1's `feel.json`: 4 real measurement sources, 2 of 7 banded metrics missing |
| `tiderunner-verdict-run1-2026-07-31.json` | the verdict run 1 got |
| `tiderunner-feel-run2-2026-07-31.json` | run 2's `feel.json`: the frozen-corpse run, `jumpApex: 0`, `timeToApex: 0` |
| `tiderunner-verdict-run2-2026-07-31.json` | the verdict run 2 got |
| `tiderunner-raw-run-leg-duplicate-2026-07-31.json` | a raw `runtime.capture_input_motion` echo carrying ONE duplicate-timestamp frame |

Verbatim except for ONE mechanical redaction: the capturing machine's absolute project path is
replaced with `<redacted-project-root>/TideRunner` wherever it appears. Nothing else was touched, no
number was recomputed, and the sample arrays are the bridge's own.

## What each one proves

**Cadence arithmetic (the blocker).** Run 1's four sources are, in order,
`218 samples / 1808.33ms / 120fps`, `182 / 1508.33 / 120`, `815 / 13416.67 / 60` aggregating TEN
trial windows, and `58 / 950 / 60`. Every one is an honest capture and every one failed the gate,
because the gate compared `sampleCount` against `captureFps * window` with a one-sample tolerance:
the fencepost (N samples span N-1 intervals) ate the whole tolerance on a single-window source, and a
ten-window sweep was ten fenceposts over budget. With the fencepost counted per window the four
sources land 4e-4, 4e-4, 2e-4 and 0 samples from their structural counts, against a rounding slack of
1.8e-3, 1.8e-3, 6.3e-3 and 9e-4. The sweep source also shows the producer's own arithmetic was wrong
in the same way: it recorded `effectiveCaptureFps: 60.6708` for a capture whose per-window rate is
exactly 60.000 on all ten trials.

**timeToApex.** The jump source's arc rises 0.225u on its launch tick, decaying 0.012u per tick, so
`v0 = 13.5 u/s`, `g = 43.2 u/s^2` and the analytic `v0/g` is 312.5ms. The capture prepends a 12-tick
settle phase, so measuring from the first sample reported **533.33ms** against a `325ms +/-10%`
target, a FAIL manufactured by the capture's own shape. From the launch anchor the same samples read
308.33ms.

**The runway.** `_provenance.ops` shows the run leg, the coyote calibration walk and their trial
walks all driving `D` from `x = 6.4` toward spikes that start at `x = 9.03`. Run 1 spent every heart;
run 2 measured what was left.

**The frozen corpse.** Run 2's single source is 218 samples all at `(6.4, 1.51499975)` and the
derivations turned that into `jumpApex: 0` and `timeToApex: 0`, both certified by a structurally
valid source. Five of seven banded metrics were unmeasured, and the capture still exited 0.

**The duplicate frame.** `tiderunner-raw-run-leg-duplicate-2026-07-31.json` carries 183 samples of
which index 133 repeats index 132 exactly (`{tMs: 1100, x: 6.4, y: 1.5}` twice). Under a strictly
increasing validator that one pair discarded the whole trajectory and `runSpeed` was omitted as "no
usable trajectory".
