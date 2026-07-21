# DESIGN BRIEF - "Switchyard Courier" (2D top-down delivery/dodge slice)

**You are the game developer.** A studio has handed you this design brief: build a short, polished
top-down Unity 2D vertical slice with tight movement feel, clear hazard readability, satisfying delivery
feedback, and enough handoff evidence for an external reviewer to evaluate the build. The point of this
brief is to build a different kind of 2D game from a fresh, empty project.

Switchyard Courier is a one-room industrial delivery game. The player pilots a small maintenance cart
through a switchyard, collects charged batteries, and delivers them to matching terminals while avoiding
sweeping security cones and timed electric floor arcs. It should take about **20-30 seconds** to clear
when played well.

## Engine / project

Unity **6000.3 LTS** (2D, Input System, built-in render pipeline). The project starts empty. Build the
scripts, scene, HUD, visual feedback, audio hooks, and verification artifacts yourself.

Do not build a platformer. This game has **no gravity, no jump, no one-way platforms, no trampoline, no
flag goal, no fruit arc, and no platform reachability route**.

## 1. Visual target

One-screen top-down industrial yard, readable at a glance:

- **Arena:** rectangular switchyard floor with clear boundary rails or hazard-striped edges.
- **Player:** compact maintenance cart / courier bot, readable at small size, centered enough to see
  incoming hazards.
- **Pickups:** charged batteries, visually distinct from terminals and hazards.
- **Terminals:** 3 delivery pads or sockets, each readable as an objective target.
- **Hazards:** sweeping security cones and timed electric floor arcs. Hazards must telegraph before
  damaging the player.
- **HUD:** calm workbench-style UI showing batteries delivered, lives, carried state, and game state.

Use a distinct palette from bright side-view platformer demos. Suggested direction: dark graphite floor, teal/green objective
glow, amber hazard warnings, red damage, off-white HUD text. Record the main color roles you chose.

## 2. Mechanics

- **Movement:** 8-way top-down movement with acceleration/deceleration, no gravity.
- **Dodge burst:** short dash/burst in the current movement direction. It should feel quick and
  deliberate, not like a platformer air dash.
- **Pickup:** drive over a battery to carry it. The carried state must be visible.
- **Delivery:** touch a terminal while carrying a battery to deposit it. Deposits increment delivered
  count and clear carried state.
- **Win:** deliver **3 batteries**.
- **Damage:** hazards remove 1 life. The player starts with **3 lives**. At 0 lives, lose.
- **Hazard telegraph:** hazards show a warning before becoming damaging.

No jumping, no collectible arc, no end flag, no score fruit counter.

## 3. Feel direction

Choose and tune sensible top-down delivery/dodge feel values. The brief intentionally does not give
exact tuning numbers: use your own game-design judgment and any relevant support available in your
environment.

- **Movement:** responsive 8-way movement with enough acceleration/deceleration to feel physical, but
  not so much drift that precise delivery and hazard dodging feel slippery.
- **Dodge burst:** a short, deliberate burst that helps cross danger zones or recover from bad
  positioning. It should read as a top-down maintenance-cart dodge, not a side-view air dash.
- **Cooldown:** frequent enough to feel expressive, constrained enough that hazards still matter.
- **Damage response:** hit-stop, damage flash, and invulnerability should make the hit clear without
  making the player feel locked out for too long.

Record the values you chose and why. Movement must be measured by driving the player through runtime
probes or an equivalent deterministic harness. Do not rely only on eyeballing.

## 4. Camera / framing

Static orthographic camera showing the full arena. The player and all active hazards must remain in
frame. The camera should not scroll or follow unless the implementation deliberately expands the arena
and documents that choice in the handoff notes.

Choose a one-room framing that makes the whole play space readable without making the player tiny. The
camera should present the arena as a compact top-down room: objectives, batteries, and active hazards
should be visible at a glance, and the HUD must not crowd gameplay.

## 5. Art / assets

Use CC0, public-domain, self-authored, generated, or otherwise clearly licensed assets. If your
environment provides curated asset sources or libraries, use them before drawing procedural placeholders.
Procedural placeholders are acceptable only for early development; the final proof should not present
placeholder art as polished. Record where important assets came from and which required roles, if any,
fell back to procedural art.

Required asset roles:

- player/cart or courier bot
- battery pickup
- terminal/delivery pad
- security cone / warning sweep
- electric floor arc
- arena floor/boundary
- pickup, delivery, dodge, hit, win, and lose SFX

Keep provenance metadata for imported assets.

## 6. Polish / juice

Polish should support readability and feel:

- pickup pop / glow when a battery is collected
- delivery pulse on a terminal when a battery is deposited
- dodge streak or short afterimage tuned for this game's top-down burst
- hit-stop and a brief damage flash on hazard contact
- small screen shake only on damage or terminal power-up, not constant movement
- warning-to-danger transition for security cones/electric arcs
- win/lose overlay that appears above all world sprites

Do not copy side-view platformer dash trails, arcade HUD fonts, fruit language, or win copy unless this
brief explicitly asks for it. It does not.

## 7. Verification expectations

The build should produce evidence for:

- manifest: player, batteries, terminals, hazard emitters, damaging hazard zones, HUD, GameManager,
  SfxPlayer
- UI: delivered count, lives, carried state, and win/lose state use clear chosen font/color roles
- playability: driving can collect batteries, deposit them, take damage, lose at 0 lives, and win only
  after 3 deliveries
- feel: top speed, acceleration, deceleration, dodge distance/time/cooldown, hit-stop, invulnerability
- framing: player, hazards, batteries, terminals, and HUD are not clipped
- frame integrity: spawn, pickup, delivery, damage/dodge, and win frames are distinct captures
- perceptual review: hazard readability, telegraph clarity, objective readability, hit feedback,
  arena-boundary clarity, and HUD legibility

The handoff must include concrete evidence, not only a prose summary:

- a playable Unity scene
- notes or data showing the chosen movement/camera values and why they were chosen
- screenshots or captured frames for spawn, pickup, delivery, damage/dodge, and win
- any automated verification artifact available in your environment
- known remaining issues, if any, with specific justification

## 8. Done

A playable, polished one-room top-down delivery game that reads clearly and feels responsive:

- all 3 batteries can be delivered through real movement, not teleporting
- hazards visibly warn before damage
- damage and delivery feedback are obvious
- HUD is legible and not default-looking
- win and lose states work
- handoff evidence exists and is part of the final answer
- no side-view platformer-specific taste leaks into the scene, UI, scripts, or review criteria
