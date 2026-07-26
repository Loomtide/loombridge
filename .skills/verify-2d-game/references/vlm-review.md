# Tier-2 VLM perceptual + design review

An **independent, adversarial ensemble** of multimodal reviewers (N >= 2, recommend 3 — each a fresh context with NO build knowledge) looks at the rendered key frames next to the design mock and scores the contract's perceptual rubric. It catches the layer Tier-1 can't judge — both **design fidelity** (composition, end-state styling, juice-cue presence, hazard/readability cues, collectible-path readability when applicable) and the **perceptual long tail**: the "looks wrong" issues a human spots instantly but the deterministic gates miss (purposeless prop clipping the player, a backdrop's exposed bottom crop, a runtime render line, blurry HUD, floating goal, a platform's visible start/end mid-frame). The ensemble exists because a single self-graded pass — the builder reviewing its own work — rubber-stamps: it judges intent, not what the frame shows. Independent + adversarial + unioned defeats that confirmation bias.

**Advisory for the Tier-1 verdict, REQUIRED for handover.** The findings are nondeterministic, so they are reported under the **separate** `reviewFindings` key of `build-verdict.json` and are **never folded into the Tier-1 `status`** (a hard pass/fail would flake the build). But the verify-2d-game **definition-of-done requires** the ensemble to run against PLAY-MODE frames (HUD visible) and **every union `fail` to be resolved (fix the build → re-verify) or explicitly justified in writing** before handover — see SKILL.md "Definition of done". Promote a criterion to a hard Tier-1 gate only once it can be reframed deterministically (e.g. "font matches the contract family" already lives in UI conformance; `upscaleRT==true` blurry-HUD now lives in the ui-conformance gate).

The output is a strict JSON rubric (schema: `mcp-server/src/capabilities/verification/vlm-review.schema.json`), saved as ONE consolidated review at the verify root (`.loombridge/verify/vlm-review.json`) that references every state's frames by their state-relative path, and merged by `loombridge verify --vlm` under the advisory `reviewFindings` key (see the flow in §"Merge ONE consolidated review" below).

**The hero-shot fidelity subset is NOT advisory — `loombridge doneness` enforces it (plan §P0).** For a build with an **approved Design Target**, `doneness` REFUSES to certify (exit 1) unless the verdict's `reviewFindings` proves the build matches the frozen hero shot via an INDEPENDENT review. Concretely, doneness requires:

- `reviewFindings.reference.heroShotSha256` **equals the verdict's `designTarget.pngSha256`** (the frozen hero-shot hash) — proof the reviewers judged the hero-shot **IMAGE**, not contract attributes. So you MUST pass `.loombridge/design/hero-shot.png` to the reviewers and record its sha256 here.
- `reviewFindings.independence.independent === true` and `reviewerCount >= 2` — a build-authored self-review cannot certify (this is RUN-1's failure mode).
- Every **Group C hero-shot fidelity criterion** (`composition-match`, `parallax-present`, `platform-tiers`, `element-placement-arc`) is **present and `pass`** — a missing one means it was never judged; a `warn`/`fail` is a divergence that cannot self-accept.

This is the moat: RUN-1 reached `doneness=0` on a flat-background / flat-level build because the VLM was advisory, self-graded, and judged contract attributes. Each of those is now a distinct refusal. Everything ELSE in the rubric stays advisory to Tier-1 as before.

## The rubric (contract-driven criteria)

Each criterion is scored `pass | warn | fail` with a one-line `reason` + the `evidenceFrame` it's based on. No free-form prose verdict. Two groups: **(A) design fidelity from the game's contract/mock** and **(B) generic perceptual long tail** (the catch-all). Emit one entry per id requested by the game contract. If the contract has not yet declared custom criteria, use the defaults below and mark non-applicable criteria as `warn` with a reason.

### Group A — design fidelity

| id | judges |
|---|---|
| `composition-centering` | player placement / lead-the-look / overall balance vs the mock |
| `palette-adherence` | colors read as the mock/contract palette |
| `font-rendering` | HUD text renders crisp in the intended pixel face (cross-check Tier-1 UI gate) |
| `juice-cue-presence` | contract-declared juice cues are visible at the right moment: afterimages, hit-stop, shake, impact particles, launch/contact dust, pickup pops, etc. |
| `end-state-styling` | the win/lose/end state is styled per the mock/contract, not default font/layout |
| `hazard-readability` | hazards or danger cues named by the contract read clearly as dangerous, not decorative |
| `collectible-path` | collectibles or route markers named by the contract sit on a readable, intentional path (not loose/scattered) |
| `parallax` | backdrop depth reads according to the contract's layer plan |

### Group B — perceptual long tail (compare the PLAY-MODE frame to the mock)

The catch-all for the issues a human spots instantly. Each is scored against the play-mode frame (HUD visible), referenced to the mock. **Resolve every `fail` or justify it in writing before handover.**

| id | what to look for | pass / warn / fail |
|---|---|---|
| `hud-crispness` | HUD glyphs + icons render crisp and legible — sharp pixel edges, no soft/fuzzy/anti-aliased smear, no double-image. The recurring tell of a `PixelPerfectCamera` with `upscaleRT==true` or a non-integer canvas scale. | **pass** glyph edges sharp, every label readable · **warn** slightly soft but legible · **fail** blurry/smeared/illegible HUD (fix: `upscaleRT:false`, integer scale — see framing-checks.md) |
| `props-grounded` | every actor + prop that should rest on a surface (player, flag/goal, fruit, boxes, saws, spikes, trampoline) sits ON its surface — visible base touches the surface top, not floating above a gap nor sunk into the ground. | **pass** all bases meet their surface · **warn** ≤1px hairline gap/overlap · **fail** any floating (gap under the base) or sunk (base below surface) prop — esp. the goal flag |
| `platform-edge-to-edge` | ground/boundary platforms run fully across the frame — no platform START or END (a tile cap / cut edge / corner) is visible inside the camera frame where the level should read as continuous. | **pass** ground spans edge-to-edge, ends sit off-frame · **warn** an intentional ledge end that reads as designed · **fail** a boundary platform's cut start/end shows mid-frame (the "level just stops" look) |
| `backdrop-seamless` | the parallax/backdrop fills the whole frame and is seamless — no exposed background band (camera color showing through), no visible tile seam or repeat join, after the backdrop has drifted. | **pass** backdrop full-frame + seamless · **warn** a faint seam only under scrutiny · **fail** an exposed bg band (sky/clear-color strip) or an obvious repeat seam |
| `palette-match` | the frame's dominant + key colors read as the mock/contract palette — sky, ground, player, HUD, accents all in-palette; no off-hue surprise. | **pass** colors read as the mock/contract palette · **warn** a minor shade drift · **fail** a key element renders the wrong hue vs the contract |
| `composition-match` | the overall layout matches the mock — player/HUD/goal positions, horizon line, prop density and placement read like the mock's composition (not just centered, but the whole frame). | **pass** layout matches the mock · **warn** minor placement drift · **fail** a structural mismatch (HUD on the wrong side, horizon off, goal mislocated) |
| `rendering-artifacts` | no obvious rendering defects — z-fighting/flicker, wrong sort order (player behind ground, HUD behind world), clipped/cut sprites at the frame edge that should be whole, hard seams between tiles. | **pass** clean render · **warn** a minor edge artifact · **fail** z-fighting, inverted sort order, a clipped key sprite, or a hard tile seam |

### Group C — hero-shot structural fidelity (judged against the frozen hero-shot IMAGE — ENFORCED by `doneness`)

These compare the play-mode frame to the **frozen `.loombridge/design/hero-shot.png`** structure, not to contract attributes. **Unlike Groups A/B, this subset is a hard gate:** for a design-targeted build, `loombridge doneness` refuses unless every Group-C criterion is **present and `pass`**. Score them honestly — a `warn`/`fail` here means "fix the build to match the hero shot," not "justify it away." These exist because RUN-1's flat-background, single-tier build diverged from a parallax-backed multi-tier hero shot and the advisory rubric let it through.

| id | what to look for | pass / warn / fail |
|---|---|---|
| `composition-match` | the overall layout matches the hero shot — player/HUD/goal positions, horizon, prop density and placement read like the hero shot's composition (the whole frame, not just centering). *(Also a Group-B id; the doneness gate reads this one.)* | **pass** layout matches the hero shot · **warn** placement drift · **fail** a structural mismatch (HUD wrong side, horizon off, goal mislocated, flat where the hero shot is staged) |
| `parallax-present` | the backdrop has the hero shot's depth/parallax structure — the layered hills/trees/sky the hero shot shows, NOT a flat two-tone fill. | **pass** parallax layers present as in the hero shot · **warn** present but thin/low-contrast · **fail** flat/solid background where the hero shot has parallax (the RUN-1 miss) |
| `platform-tiers` | the level has the hero shot's multi-tier platform structure (staged platforms / pits / the "Saw-Pit Hop"), NOT a single flat ground strip. | **pass** tiers match the hero shot's staging · **warn** fewer tiers but recognisably staged · **fail** a single flat ground strip where the hero shot is multi-tier (the RUN-1 miss) |
| `element-placement-arc` | collectibles/hazards/goal sit on the hero shot's intended traversal arc (on the jump/platform path), not lined up in a flat row on the ground. | **pass** elements on the hero shot's arc · **warn** roughly on-path · **fail** elements in a flat row vs the hero shot's arc (the RUN-1 miss) |

## Key-frame capture recipe — one frame per `capturePack` state (consolidated, plan §P1.3)

**Capture in PLAY mode with the HUD visible** — the perceptual checks (group B) need the live render, not the edit-mode scene view. The HUD only draws in play mode; an edit-mode frame would falsely fail `hud-crispness` and miss the in-play sort order / clipping.

**Capture EVERY `capturePack` state, not just spawn (plan §P0.4).** RUN-1 ran the VLM spawn-only (4 frames spawn; hazard/movement/win = 0), so the review saw 1 of 4 moments and the consolidated single-VLM pass was unused. The default is now: drive the player to each contract state, capture one game-view frame per state into that state's `frames/` dir, then run **ONE** ensemble over all of them (the flow below). For `platformer-2d` the states are spawn / hazard / movement / win:

1. **spawn** — at level start in play mode (no drive needed): `unity_editor_screenshot { view: "game" }` → `.loombridge/verify/spawn/frames/spawn.png`. The baseline for the group-B perceptual checks (HUD crisp, props grounded, platforms edge-to-edge, backdrop, palette, composition).
2. **hazard** — drive the player adjacent to a saw/spike mid-arc (`unity_runtime_probe`, physics-timeline — see `playability-checks.md`), screenshot → `.loombridge/verify/hazard/frames/hazard.png`. Exposes hazard readability + framing under motion.
3. **movement** — drive into the main feel cue (mid-dash or apex of a jump), screenshot mid-trajectory → `.loombridge/verify/movement/frames/movement.png`. Exposes transient juice timing and readability.
4. **win** — drive to the win (collect-all-fruit per `win.rule`, or reach the goal) so `GameManager.isWin` flips, screenshot → `.loombridge/verify/win/frames/win.png`. Exposes end-state styling (and the grounded goal flag).

A drifted-backdrop frame (after a ~5–6s soak — same as the coverage gate) helps judge `backdrop-seamless`; reuse the coverage soak if you have it, else add a `drift.png` under `spawn/frames/`.

> **The driving is game-specific** (where the saw/goal sit), so the bundled capture-runner scenario cannot fully automate hazard/movement/win (the P1.1 cross-workstream lesson). Capture spawn (+ jump) via the runner where it applies, and drive the game-specific states with `unity_runtime_probe`; either way the frames land in the per-state `frames/` dirs the consolidated review reads.

**Collecting the PNG (decode the inline base64 — deterministic, race-free).** `unity_editor_screenshot` **returns the PNG inline in its result as `image_base64`** (plus `width`/`height`/`format`). The TS server *also* writes a trace artifact asynchronously — but **do not depend on that file**. Instead, **read `image_base64` from THIS screenshot result and write the decoded bytes straight to the named frame file**. One call → one named frame, no glob, no `ls -t`, no trace-dir dependency, immune to the async-write race:

```bash
# RIGHT — decode the base64 THIS screenshot op returned, into the named frame:
mkdir -p <inputs-dir>/frames
# <B64> = the `image_base64` string from THIS unity_editor_screenshot result
printf '%s' "<B64>" | base64 -d > <inputs-dir>/frames/win.png

# WRONG — never glob the trace dir; it is racy AND cross-session-stale:
#   cp "$(ls -t <repo>/trace/artifacts/screenshot_*.png | head -1)" frames/win.png
# spawn/dash-mid/win all resolve to whatever PNG is newest at cp time — often a
# LEFTOVER frame from a prior session — so they come out byte-identical (frame-integrity FAIL).
```

This **reverses the earlier "don't decode the base64" guidance**: the "no base64 blobs" rule is about the trace *transport* (don't ship blobs through the trace), NOT about saving a named review frame. Decoding `image_base64` to `frames/<id>.png` IS the correct way to collect a review frame.

**If anything ever does read the trace artifact** (it shouldn't need to), it is at `./trace/artifacts/` **relative to where `claude` launched — the project dir (cwd), NEVER `<repo>/trace/artifacts`**. The repo-root path is the stale, cross-session trap: a shared dir holding leftover frames from other sessions, which is exactly how a clean-room run grabbed byte-identical "spawn/win/dash" frames.

Record each as a `frames[]` entry `{ id, path }` in the rubric JSON.

**⚠️ The stale-capture trap (a `frame-integrity` build failure).** Decoding `image_base64` per the recipe above kills the racy-glob source of duplicate frames. One source remains: **sim-throttle** — a *backgrounded* editor throttles rendering, so a play-mode screenshot can return a **stale framebuffer**, making distinct-state frames come out byte-identical and invalidating the review (you'd be scoring `end-state-styling`/`juice-cue-presence` against a frame that doesn't show the win/dash). Guard against it:
- **Capture each frame only after the state actually changed** — e.g. decode `win.png` only *after* asserting `GameManager.isWin == true` (via `unity_runtime_assert_condition`), not before.
- **Force a fresh render**: keep the Unity editor **foregrounded** during play-mode captures, and drive a short `unity_runtime_probe` / `editor_wait_for` tick between the state change and the screenshot so the framebuffer advances.
- **Verify distinctness before trusting them**: `md5 frames/spawn.png frames/dash-mid.png frames/win.png` — if any two distinct-state frames match, your capture is stale; re-capture.

The `run-gates` **`frame-integrity` gate enforces this deterministically**: it hashes every `frames[]` PNG and **FAILS the Tier-1 build** if two distinct frame ids are byte-identical. So a stale/duplicate capture can no longer slip through as a green — fix the capture, don't work around it.

## The flow — an INDEPENDENT, ADVERSARIAL ENSEMBLE (NOT the builder grading itself)

**Why this changed.** A lone self-graded review is confirmation bias: when the agent that *built* the game also reviews it, it judges "does this match what I intended?" and rubber-stamps — writing confident-but-false pass reasons (`backdrop-seamless: pass "no exposed band"`, `rendering-artifacts: pass "no clipping"`) while a box clips the player at spawn, a hills-backdrop bottom crop shows in the pit, and a render line streaks the frame. The fix: the reviewer is NOT the builder. Run **N ≥ 2 (recommend 3) INDEPENDENT review passes, each in a fresh context with NO build knowledge**, prompt them **adversarially**, and **union their flags**.

No external model or API is required — Claude is multimodal. But the reviewers must be *separate contexts*, not the builder's own continued reasoning.

1. **Capture ALL `capturePack` states' play-mode frames** (above), HUD visible — decode each `image_base64` into `.loombridge/verify/<state>/frames/<id>.png`. This is the consolidated multi-state capture (plan §P0.4/P1.3): one frame per state (spawn / hazard / movement / win), NOT spawn-only.
2. **Spawn N ≥ 2 (recommend 3) independent reviewers — each in a FRESH context with NO build knowledge.** The building agent spawns them via the Task/sub-agent tool (or a fresh session). Each reviewer receives ONLY:
   - the **frozen hero shot** — the actual image bytes of `.loombridge/design/hero-shot.png` (plus its HTML annotations: palette vars, font names, A–J layout notes, if present). This is the comparison target; the reviewer compares the frames to **this image**, not to a list of contract attributes.
   - **all the captured PLAY-MODE frames across every state** (`spawn/frames/spawn.png`, `hazard/frames/hazard.png`, `movement/frames/movement.png`, `win/frames/win.png`, optional `spawn/frames/drift.png`) — ONE consolidated review covers every moment, not one review per state.
   - the **rubric** (the fixed criteria incl. Group C + the adversarial prompt below).

   It must **NOT** see the build steps, the contract internals, or the builder's intent — that knowledge is exactly what causes rubber-stamping. The reviewer judges what the frame *shows* against the hero-shot image, with no idea what was *intended*.
3. **Prompt each reviewer ADVERSARIALLY** (not "does this match?") — assume the build is flawed and hunt the flaws. Use the prompt below. Each reviewer emits the fixed-criteria JSON conforming to `vlm-review.schema.json`, including the **Group C** structural-fidelity criteria.
4. **Union the flags across all N reviews into one `vlm-review.json`.** Merge so the **worst status per criterion survives** (`fail` > `warn` > `pass`) and **every distinct flagged observation is preserved** (concatenate the reviewers' `reason` lines for any criterion ≥ `warn`, citing the frame each cited). A criterion **passes ONLY if ALL reviewers passed it** — ANY reviewer scoring it `warn`/`fail` carries through. Then **stamp the provenance the doneness gate reads** (plan §P0.1/P0.3):
   - `reference: { heroShot: ".loombridge/design/hero-shot.png", heroShotSha256: "<sha256 of the hero-shot bytes the reviewers saw>" }` — compute it with `shasum -a 256 .loombridge/design/hero-shot.png`. It MUST equal the frozen `designTarget.pngSha256` or `doneness` refuses.
   - `independence: { independent: true, reviewerCount: <N> }` — N is the number of fresh-context reviewers you unioned (≥ 2). Do NOT set `independent: true` if you (the builder) graded it yourself — that defeats the gate and is dishonest.
   - Ensure all four Group-C criteria (`composition-match`, `parallax-present`, `platform-tiers`, `element-placement-arc`) are present. Validate the unioned JSON against `vlm-review.schema.json` before saving.
   - **Use the exact schema shape.** `criteria` is an **array**, not an object keyed by id; use `status`, not `verdict`; do not add custom fields such as `schemaVersion`, `kind`, `title`, `method`, `_provenance`, nested reviewer blocks, or `advisoryDivergences`. `loombridge doneness` validates this file before trusting it.

   Minimal valid shape:

   ```json
   {
     "reference": {
       "heroShot": ".loombridge/design/hero-shot.png",
       "heroShotSha256": "<frozen-hero-shot-sha256>"
     },
     "independence": { "independent": true, "reviewerCount": 2 },
     "frames": [
       { "id": "spawn", "path": "spawn/frames/spawn.png" },
       { "id": "hazard", "path": "hazard/frames/hazard.png" }
     ],
     "criteria": [
       {
         "id": "composition-match",
         "status": "pass",
         "reason": "Layout matches the frozen hero shot.",
         "evidenceFrame": "spawn"
       },
       {
         "id": "parallax-present",
         "status": "pass",
         "reason": "Layered background depth is visible.",
         "evidenceFrame": "spawn"
       },
       {
         "id": "platform-tiers",
         "status": "pass",
         "reason": "The level has staged tiers around the pit.",
         "evidenceFrame": "hazard"
       },
       {
         "id": "element-placement-arc",
         "status": "pass",
         "reason": "Collectibles follow the jump arc over the hazard.",
         "evidenceFrame": "hazard"
       }
     ],
     "summary": "Independent hero-shot fidelity review complete."
   }
   ```
5. **Merge ONE consolidated review with the canonical CLI** — `loombridge verify` (which writes a verdict with `runId` + `producedAt` so `loombridge doneness` can certify it). Save the single unioned `vlm-review.json` at the **verify ROOT** (`.loombridge/verify/vlm-review.json`), and reference each frame by its **state-relative path** (`spawn/frames/spawn.png`, `hazard/frames/hazard.png`, …). `run-gates` resolves the VLM file's `frames[]` paths relative to the VLM JSON's own directory — so a root-level review resolves frames across every state subdir, and `frame-integrity` hashes them all (catching a stale capture in ANY state, not just spawn):

   ```bash
   # ONE consolidated review at the verify root covers every capturePack state.
   # --inputs still points at the primary state (verify grades that state's
   # deterministic gates); --vlm is the consolidated multi-state review.
   node mcp-server/dist/surfaces/cli.js verify --root . \
     --inputs .loombridge/verify/spawn \
     --vlm .loombridge/verify/vlm-review.json \
     --strict
   ```

   The findings merge under `reviewFindings` (advisory to the Tier-1 `status` — but the hero-shot fidelity subset is enforced by `loombridge doneness`, see the top of this doc). `loombridge verify` logs `reviewFindings (ADVISORY): N criteria, X fail, Y warn`. Do NOT call `run-gates.js` directly — it bypasses the §3a supervisor mechanism (no `runId`/`producedAt` minted into the verdict, so `loombridge doneness` cannot certify the run).
6. **Resolve every union `fail`** before handover: fix the build, re-capture the affected frame, **re-run the ensemble**, re-union, re-run the gates — OR justify the `fail` in writing (a one-line rationale recorded next to the verdict, e.g. "rendering-artifacts fail = intentional CRT scanline overlay, matches mock"). This `fail`-resolution loop is part of the **definition of done** (SKILL.md), not optional.

### Adversarial reviewer prompt (fresh context, NO build knowledge)

> **You are a hostile QA reviewer. Assume this build is flawed and find the flaws.** You did NOT build this; you have no idea what was intended — judge ONLY what the frames *show*, compared to the hero-shot image. Inputs: (1) the **frozen hero-shot image** (`.loombridge/design/hero-shot.png`) + any annotations (palette vars, font names, A–J layout notes) — THIS image is the target the frames must match, (2) rendered PLAY-MODE key frames (spawn, dash-mid, win, drift — HUD visible), (3) the rubric below. Be specific and **cite the frame** for every observation.
>
> Hunt aggressively for:
> - **Structural divergence from the hero shot (judge against the IMAGE).** Does the background have the hero shot's parallax/depth layers, or is it a flat fill? Does the level have the hero shot's multi-tier platform staging, or one flat ground strip? Do collectibles/hazards/goal sit on the hero shot's traversal arc, or lined up in a flat row? These are the `parallax-present` / `platform-tiers` / `element-placement-arc` / `composition-match` criteria — and they are ENFORCED (a `warn`/`fail` blocks `doneness`), so score them strictly against what the hero-shot image shows.
> - **Purposeless / misplaced props.** For EVERY visible object, state its gameplay purpose (platform, hazard, collectible, goal, decor that matches the hero shot) — or flag it as **purposeless/misplaced**. Call out anything that **clips or overlaps the player**, especially at spawn (the recurring "box clipping the frog" miss). *(Deterministic sibling: the `prop-purpose` gate.)*
> - **Backdrop seams / crop edges / exposed bands.** List every backdrop seam, repeat join, or visible **crop edge** — any background layer whose **bottom crop edge is visible** is a fail; a BG must be **bottom-aligned to the viewport** so no bare strip (e.g. a hills backdrop whose bottom shows in the pit). *(Deterministic sibling: the `coverage` bottom-coverage check.)*
> - **Rendering artifacts.** Name every render line/streak, seam, z-fight/flicker, wrong sort order, or clipped sprite. *(Deterministic sibling: `console-clean` for runtime render errors.)*
> - **Composition deviations from the hero shot.** Name everything that looks off versus the hero shot — HUD on the wrong side, horizon off, goal mislocated, prop density/placement wrong, anything that breaks the hero shot's composition.
>
> Then emit ONE finding per criterion requested by the contract. If using the default rubric, score: `composition-centering`, `palette-adherence`, `font-rendering`, `juice-cue-presence`, `end-state-styling`, `hazard-readability`, `collectible-path`, `parallax`, `hud-crispness`, `props-grounded`, `platform-edge-to-edge`, `backdrop-seamless`, `palette-match`, `composition-match`, `rendering-artifacts`, and the Group-C fidelity criteria `parallax-present`, `platform-tiers`, `element-placement-arc`. Each finding: `status` (pass | warn | fail), a SINGLE-LINE `reason` citing the specific observation, and the `evidenceFrame` id. **Default to skepticism — only `pass` what you can affirmatively verify is clean.** Output ONLY JSON conforming to `vlm-review.schema.json`: `{ "reference": { ... }, "independence": { ... }, "frames": [{ "id": "...", "path": "..." }], "criteria": [{ "id": "...", "status": "pass|warn|fail", "reason": "...", "evidenceFrame": "..." }], "summary": "..." }`. No free-form verdict; no criteria object map; no custom fields.

These adversarial checks are the **catch-all for the variants the deterministic siblings miss** — `prop-purpose`, `coverage` bottom-coverage, and `console-clean` now gate the common cases deterministically; the independent ensemble is what survives the "looks wrong" long tail those geometry/log gates can't see. The `frame-integrity` gate (distinct-state frames must differ by hash) backstops the capture itself.

## Game-specific expected findings

Do not put expected findings for a specific game in this generic skill. Store those in the game's
brief, acceptance contract, or verification fixture. The generic rule is: VLM findings should
corroborate deterministic gates where possible, catch perceptual variants the geometry misses, and
require every `fail` to be resolved or justified before handover.

The same key frames feed a future golden-frame regression — a human approves once, later builds diff against the stored frames.
