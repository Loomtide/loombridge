---
name: ui-polish-pack
description: Skin and polish uGUI/HUD for an AI-built game — generate UI sprites (magenta chroma-key), enforce 9-slice + state-matrix discipline, catch the uGUI/import gotchas, and verify UI in every game state. Use when a built game needs a presentable, honest HUD/menu skin (desktop or mobile).
---

Use this skill to turn a graybox HUD into a shippable, honest UI skin — buttons, bars, panels,
icons, minimap, settings — WITHOUT faking readability or letting AI tells slip through. UI skinning is
its own pipeline, separate from environment/character art (`generated-3d-art-integration`) and from SFX
(`sfx-integration-pack`).

The magenta chroma-key extraction recipe, one-element-per-image rule, review-every-state rule, the
runtime-driven-restyle rule, and the 9-slice clean-center rule are **canonical in
`Docs/Assets/GeneratedArtWorkflow.md` → "UI Skin Passes"** — read that once and follow it; this skill
adds only the delta (uGUI/import gotchas, the state matrix, safe-area, honest store shots, text-fit /
AI-tell copy review) plus the DO/DO-NOT framing. Loombridge never deterministically approves UI taste;
readability, layout beauty, and copy quality are HUMAN gates.

Provenance tags below: **VALIDATED** = seen across ≥2 sources (a ledger + a planning/workflow doc, a
recurring incident, or a deterministic uGUI fact). **CANDIDATE** = one run only — use, but do not
promote as a genre constant.

## Inputs (gather before Stage 0)

- The live scene + a **HUD truth sheet** built from the CURRENT build, never a stale concept mock —
  actual control inventory, positions, counters, bars, minimap, joystick, action buttons.
  `[VALIDATED: dogfood-ui #1 + codex-tuning #10]`
- Platform target (desktop / mobile-landscape / mobile-portrait / tablet) and its safe-area insets.
- The required **state list** (see Stage 2) and, for touch builds, tap-target + safe-area budgets.
- Provider access for generation (ImageGen). Keys live in env/secret file/keychain per
  `GeneratedArtWorkflow.md` — never in chat, commits, or reports.

## DO-NOT rules (each burned a real session)

- **Never luma/alpha-key a dark UI element.** Generate on pure magenta `#FF00FF`, ask for no
  shadow/glow bleed, chroma-key + despill offline. Dark useful pixels read as transparent against a
  light key. `[VALIDATED: dogfood-ui #3 + GeneratedArtWorkflow "UI Skin Passes" + GRL-C12 settings-restyle reuse]`
- **Never split a multi-element sheet at a fixed midline.** One element per image where possible; a
  hard 50% split clipped the joystick ring AND thumb, and a later unguarded utility re-import reverted
  the content-aware fix. Guard every extraction side effect behind `if __name__ == "__main__"`.
  `[VALIDATED: dogfood-ui #4 + GeneratedArtWorkflow]`
- **Never assign a `Type=Filled` Image with no sprite and expect it to fill.** A uGUI `Image` set to
  Filled but left spriteless silently ignores `fillAmount` — loot/extract/sprint bars "don't fill".
  Assign a real sprite (even a 16×16 white). `[VALIDATED: GRL-B31 + dogfood-ui #8 sprint-fill]`
- **Never fight a per-frame runtime writer at the child Image.** If a driver script rewrites
  `Image.color`/`fillAmount` every frame (e.g. a `SprintHud` writing `_readyColor`/`_sprintingColor`),
  restyle the driver's **serialized state fields**, not the child.
  `[VALIDATED: dogfood-ui #7 + codex-tuning #10 + GeneratedArtWorkflow]`
- **Never judge a new sprite over old tint.** Existing UI Images carry old flat `Image.color`; assigning
  new art without neutralizing tint double-tints it. Reset to white (or preserve tint intentionally) and
  capture before/after. `[VALIDATED: dogfood-ui #6]`
- **Never approve UI from one idle screenshot.** Review every state (Stage 2). A CRT result-overlay
  looked fine in play and read as a giant red slab in the death state. `[VALIDATED: dogfood-ui #11 + GeneratedArtWorkflow]`
- **Never ship a 9-slice bar with a noisy center.** Chroma residue in the stretchable center smears into
  a visible band as the bar drains. Repaint the center uniform; inset the fill inside the frame slot.
  `[VALIDATED: dogfood-ui #9 + GeneratedArtWorkflow]`
- **Never ship a filled/cooldown/charge overlay whose alpha shape differs from its base control.** A
  square fill over a rounded button reads square when full. Give the overlay the same rounded sprite/mask
  so it clips to the same shape in every state. `[VALIDATED: dogfood-ui #8]`
- **Never fake HUD state in a store/marketing screenshot.** A full health bar and a salvage count the
  player did not earn is a lie. Stage an honest-looking real gameplay frame — same staging, no tell.
  `[VALIDATED-principle: GRL-C07 — extends the core verification-honesty moat to marketing]`
- **Never ship generated UI copy without a text-fit + AI-tell pass.** Text overflowed the restyled popup
  boundary; em-dashes in generated copy are an AI tell the user flags. Check overflow at the target
  resolution and lint the copy. `[VALIDATED: GRL-C13 — em-dash L7807 + overflow L9818, recurred]`

## uGUI / import gotchas (deterministic facts, not taste)

- **Sprite import defaults cause false "Sprite not found".** Valid PNGs failed because Unity imported
  them as Multiple sprite mode with zero slices. Force **Single** sprite mode (unless you supply slices)
  and refresh; diagnose "Multiple mode / zero sub-sprites" rather than a generic not-found.
  `[VALIDATED: dogfood-ui #5, observed repeatedly]`
- **Some uGUI/TMP properties are not bridge-addressable.** Nested `Text.fontData.fontSize` (and similar
  nested style) may not round-trip through the property setter — you may have to save, edit scene YAML,
  reload. Prefer any `ui.*` style op if present; treat YAML surgery as the fallback, then reload.
  `[VALIDATED: dogfood-ui #12]`
- **HUD semantic references break during art replacement.** A minimap's serialized extract-point ref was
  severed when the beacon prefab was replaced. A visible marker is not enough — verify it still points at
  the correct gameplay object after any prefab swap (cross-ref `generated-3d-art-integration` Stage 4
  `validate_references`/`remap_references`). `[VALIDATED: dogfood-ui #13 + GRL-A04]`

## Stages and gates

### Stage 0 — HUD truth sheet
- Inspect the LIVE scene + scripts; enumerate every visible control, counter, bar, marker, overlay, and
  its owning driver script. The truth sheet — not a concept mock — is the layout contract.
- **Gate:** live inventory matches the UI plan, or every delta is explicit.

### Stage 1 — Asset generation / extraction
- Generate one element per image on magenta; record crop bounds + extraction method; keep signal colors
  disciplined (threat vs loot/extract must not collide). Panel plates, 2-state button plates
  (idle/press), and icon sheets are the reusable UI-element families.
  `[CANDIDATE for the exact palette/CRT look: GRL-C12 — do not promote the source dogfood project's aesthetics as canonical]`
- **Gate:** no clipped element at content bounds, clean alpha, Single sprite mode, borders set for
  9-slice pieces.

### Stage 2 — State matrix (the core proof)
- Define and capture EVERY state that changes UI visuals or semantics: idle, active gameplay,
  low-health/damaged, interaction/hold (looting/extracting), win/extract, fail/death, pause/menu, and —
  for touch controls — the charge/cooldown/disabled states. Also capture bar value states: full / mid /
  low / empty / charging / ready. `[VALIDATED: dogfood-ui #10/#11 + GeneratedArtWorkflow]`
- **Gate:** each required state has a capture (or an explicit unsupported reason). No single idle
  screenshot certifies UI polish.

### Stage 3 — Mobile / safe-area (touch builds)
- Every visible HUD element must sit inside the device safe area; only backgrounds may bleed. Audit
  control insets against the notch inset at the target device resolution, and check tap-target sizes.
  The safe-area-sweep gate LOGIC exists (`mcp-server/src/verification/mobile-touch-gates.ts`) but today
  is reachable only through the 2D minigame verify pipeline — for a 3D/mobile build apply the same
  discipline by hand until a 3D/mobile front door exists.
  `[VALIDATED-concept: GRL-C08 + dogfood-ui #11; the specific joystick-notch numbers are CANDIDATE — do not promote]`
- **Gate:** no visible element clipped by the notch/safe area; tap targets meet the min size.

### Stage 4 — Text-fit + AI-tell copy review
- At the target resolution, confirm no string overflows its container across states. Lint generated copy
  for AI tells (em-dashes, boilerplate phrasing) and overlong labels. `[VALIDATED: GRL-C13]`
- **Gate:** no overflow at target resolution; copy passes the tell lint.

### Stage 5 — Human / advisory review
- Ask targeted questions: does the health state read under combat? does the minimap convey strategy, not
  just orientation? do touch controls feel tappable? does the fail/win overlay sit cleanly above damage
  flashes? Record corrections with provenance before promoting any into a gate.

## Boundaries
- Use generic `unity_*` / `ui_*` ops and hand-edit + reload only where a nested-style op is missing —
  never add game-specific bridge ops.
- Missing state capture, unresolved severed HUD reference, spriteless Filled image, or overflowing copy
  ⇒ `blocked`/`incomplete`, never green.
- Do NOT promote the source dogfood project's exact UI aesthetics (CRT panel, gunmetal palette, exact health-color
  thresholds, the floating-joystick rect) as canonical — single-session anecdotes, gate on a second run.
