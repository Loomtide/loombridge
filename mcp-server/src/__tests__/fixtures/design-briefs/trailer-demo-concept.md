# Trailer Demo: "Tiderunner" — a pixel precision dash-platformer

Working title: **Tiderunner** (ties to the Loomtide brand). A short, hand-crafted vertical slice whose
job is to make a **45-second trailer** that shows Loomtide building a *high-quality platformer with
feel* — end to end, with the things no other AI-game tool shows.

## Why this game (trailer logic)
The trailer's hero is Loomtide's differentiators, not "an AI made a game":
1. **Feel, measured** — the FeelHarness tunes jump/dash to numeric targets *on screen* ("apex 2.2u,
   time-to-apex 330ms ✓"). Unique.
2. **The verify loop** — the green/yellow collider-vs-feet overlays + the symmetric-camera probe: "the
   AI checks its own work."
3. **The Asset Browser** — browsing + picking real CC0 art on camera sells the pipeline.
4. **End-to-end** — empty scene → polished, juicy, playable.

## Core mechanics (feel-forward)
- Run, **variable-height jump**, **coyote time** (~0.1s), **jump buffer** (~0.1s), **air dash**
  (horizontal, ~0.15s, with a brief cooldown). One-way (jump-through) platforms.
- Hazard (saw/spikes) → snappy respawn at the last checkpoint/spawn.
- Collectibles (fruit). Goal: reach the flag.

## Feel targets (FeelHarness / runtime.probe — tune & verify on camera)
- Run speed ≈ **7 u/s**; jump apex ≈ **2.2 u**; time-to-apex ≈ **330 ms**.
- Coyote ≈ 0.1s; jump buffer ≈ 0.1s; dash distance ≈ **2.81 u** (18.75×0.15) over ≈ 0.15s.

## Juice (the polish montage)
Landing dust, dash afterimage/trail, fruit-collect pop + sfx, hit-stop on dash/land, light screen
shake on land/death, the (now symmetric) camera look-ahead, respawn snap.

## Level (single short slice, ~20–30s to clear)
Spawn → run + coyote/buffered jumps across one-way platforms → a **dash gap** (too wide to jump) →
collect 3–5 fruit → past a **saw/spikes** hazard → **flag**. Readable in one screen-scroll.

## Art direction — high-quality CC0 (pixel)
Cohesive, professional pixel art (a clear jump from the seed stubs):
- **Hero set: Pixel Frog "Pixel Adventure 1 (& 2)"** (itch.io, **CC0**) — animated characters
  (idle/run/jump/fall/double-jump/hit), terrain tileset, traps (saw, spikes, fire), items (fruit,
  boxes, checkpoint), backgrounds. Pro-grade and free.
- Alternates already in registry: **Kenney "Pixel Platformer"** (CC0) tiles/characters.
- **Audio:** CC0 SFX (jump, dash, collect, land, death) + a CC0 chiptune loop (OpenGameArt / Kenney).

## Trailer beat sheet (~45s)
1. **0–8s** Asset Browser: filter to the Pixel Adventure set, pick character + tiles + fruit + traps →
   inventory fills → Confirm.
2. **8–20s** Scene builds: tiles lay in, character drops + animates, camera frames it.
3. **20–32s** Feel tuning: FeelHarness numbers tick to target ("✓ snappy"); verify overlays flash
   (collider hugs feet; camera symmetric).
4. **32–45s** Clean playthrough: coyote jump → dash the gap → fruit pops → dodge the saw → flag. Juice
   throughout.

## LOCKED (post-build, 2026-05-23)
- **Mechanics: focused dash-only air mobility** — run + variable-height jump + coyote (0.1s) +
  jump-buffer (0.1s) + air dash. **No double-jump, no wall-jump** (keep the trailer's air move singular
  and readable). Built + tuned in `d241e32` (branch `feature/PolishedPlatformer`).
- **Proven feel params** (independently re-measured via runtime.probe / measure_motion):
  `moveSpeed 7` → run 7.0 u/s; `jumpSpeed 14.22` + `gravityScale 4.402` → apex **2.20u** @ **325ms**;
  `jumpCutMultiplier 0.5` → short hop 0.72u; `dashSpeed 18.75`/`dashTime 0.15` → **2.8125u** dash (≈2.81u; the earlier 3.0u was an arithmetic slip — 18.75×0.15=2.8125);
  `dashCooldown 0.4`, one dash per airtime.
- **Look:** being mocked by the user in **Claude Design** (level slice + visual direction); implemented
  1:1 in Unity from the registered Pixel Adventure CC0 art.

## Build status / dependencies
- Existing & reused: feet-fit collider, symmetric camera, per-key jump, pixel-perfect, HUD,
  `runtime.probe`/FeelHarness, the Asset Browser + picker handshake.
- **New for this demo:** coyote time + jump buffer + variable jump + **dash** (extend PlayerController —
  the deferred "Celeste-style" feel work), the one-way-platform level (see `/platformer-level-design`),
  the juice layer (particles/hit-stop/shake), and **registering the high-quality CC0 art**.
