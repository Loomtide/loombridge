---
name: generated-3d-art-integration
description: Integrate AI-generated 3D art (image → image-to-3D → Unity) into an existing gameplay blockout through Loomtide, as a parallel art vertical that preserves tuning-scene invariants. Use when skinning a 3D game (top-down/mobile extraction shooter, arena, etc.) with generated environments, characters, weapons, decals, and baked FX.
---

Use this skill to dress a working 3D gameplay blockout with generated art WITHOUT turning art
integration into gameplay tuning. Art is a parallel vertical: fork the scene, apply art as prefab
variants / visual-only children / instance overrides, and prove the tuning scene's geometry and
serialized wiring survived every swap.

This skill is the actionable agent runbook. The deterministic boundary, provider-key safety,
provenance field list, cache key, and mobile defaults are canonical in
`Docs/Assets/GeneratedArtWorkflow.md` — read it once, follow it, do not restate it here. Loomtide never
deterministically approves art quality; taste, silhouette read, hero-shot fidelity, animation feel, and
weapon grip are HUMAN gates.

## Inputs (gather before Stage 0)

- Unity project + the canonical gameplay/tuning scene (the one carrying colliders, triggers, LOS
  blockers, spawn/extract volumes, tuning configs, serialized gameplay refs).
- Art scene, or explicit permission to fork one.
- Hero/style reference (the style contract) and a blockout truth sheet, or permission to generate it.
- Asset categories mapped to gameplay footprints + readability goals (role, tier, silhouette, scale
  cue, signal color).
- Provider availability: image generation, image-to-3D (Meshy-like), optional animation library. Keys
  live in env/secret file/keychain per `GeneratedArtWorkflow.md` — never in chat, commits, or reports.

## DO-NOT rules (High-Risk Failure Modes — each burned a real session)

- **Never generate a whole-map image as the build source.** Generate modular single-object assets and
  place them in Unity. A full-map render cannot be diffed against the blockout and cannot be reused.
- **Never trust Meshy-embedded GLB materials.** Build Unity URP materials from the loose PBR maps
  (base/normal/metallic-smoothness/emission). Provider importer defaults ship wrong scale, wrong
  smoothness, and non-URP shaders.
- **Never tile a Meshy UV-atlas texture as if it were a seamless tile.** UV-atlas maps are not periodic;
  tiling them produces visible seams. Author seamless tiles separately; use the atlas only on its mesh.
- **Never send a source image to paid 3D before QC.** One QC failure that reaches image-to-3D is spent
  credits on a dead asset. QC first (Stage 2 gate), spend second.
- **Never mutate the canonical tuning scene.** Fork it (Stage 0). If a change unavoidably touches shared
  tuning data (the dogfood camera-zoom fix altered `CameraFollowConfig`, which also drives the tuning
  scene), FLAG it in the commit message with the downstream retune risk.
- **Never run `unity_asset_replace_with_prefab` blind.** A destructive swap DESTROYS the replaced
  hierarchy and silently NULLs every external reference into it (including refs to a CHILD, e.g. the
  minimap-extract-point → beacon-child incident). Pre-flight, then remap (Stage 4).
- **Never fuse multiple objects in one image-to-3D submission.** One object per image; split sheets
  content-aware before submission — a fixed midline clipped both the joystick ring and thumb.
- **Never green animation from a static pose.** Headless/unfocused Unity advances physics but freezes
  Animator time; a single-pose snapshot proves nothing. Sample across a window (see Stage 6).
- **Never do unguarded module-level work in an art utility script.** An `import` of an extraction
  script silently re-ran the whole extraction and overwrote an already-fixed sprite. Guard every side
  effect behind `if __name__ == "__main__"` (or an explicit call).

## Ops that close the old manual-workaround gaps

These Wave-1/2 bridge ops replace the hand-editing loops the source dogfood session suffered through. Use them
by exact name; they land in the same release as this skill.

- Model importer / sub-assets: `unity_asset_list_sub_assets` (fileID/guid/type/name/duration/avatar —
  replaces grepping `m_Animation:` out of a temp prefab), `unity_asset_inspect_model_importer`,
  `unity_asset_configure_model_importer` (sets animationType/avatarSetup/importAnimation + `clip_overrides`
  for `loopTime`, replacing the cloned `.fbx.meta` trick; no domain reload, synchronous).
- Animator binding: `unity_animator_set_state_motion` and `unity_animator_apply_spec` motion selectors
  BIND `m_Motion`/speed (native `.anim` or `{asset_path, sub_asset}` FBX clip) and REFUSE unknown keys —
  no more silently-dropped fields, no more null-motion controllers.
- Reference integrity: `unity_scene_find_references_to` (pre-flight the destroy surface),
  `unity_scene_validate_references` (severed vs never-assigned nulls), and
  `unity_asset_replace_with_prefab` `remap_references:true` (re-point refs onto the new instance,
  surfacing unmapped ones).
- Scene lighting: `unity_scene_set_render_settings` / `unity_scene_get_render_settings` (ambient/fog/
  skybox/sun through the bridge, not YAML patching that clobbers unsaved scene state).
- Animation honesty: `unity_runtime_sample_animator` (per-state `time_advancing`, `bones_moving`, and a
  `blocked_unfocused` / `blocked_culled` status instead of a laundered pass).
- Module/compile diagnostics: `unity_editor_get_project_diagnostics` (why a symbol/module looks missing
  while `error_count` stays 0 — the disabled ParticleSystem/ScreenCapture-module case).
- Visual-only proof: `unity_scene_snapshot_gameplay_geometry` / `unity_scene_compare_gameplay_geometry`
  (baseline before dressing, diff after — proves colliders/triggers/transforms/tuning refs are byte-
  identical so an art pass cannot silently move gameplay). These land in the same release; use them as
  the machine-checkable "visual-only" evidence every gate below asks for.

## Stages And Gates (0–7)

### Stage 0 — Safety setup

- Fork the art scene from the canonical tuning scene; preserve graybox colliders, triggers, LOS
  blockers, tuning configs, serialized gameplay refs.
- Baseline with `unity_scene_snapshot_gameplay_geometry` and record active-scene name.
- Preflight modules with `unity_editor_get_project_diagnostics` (ParticleSystem, ScreenCapture, glTFast,
  URP present; nothing you need is a `disabled_built_in_module`).
- **Gate:** art scene loads and compiles; tuning scene untouched; geometry snapshot saved.

### Stage 1 — Art contract

- Map each gameplay category to a visual treatment: `static-prop` / `flat-decal` / `baked-fx` /
  `animated-character` / `weapon`. Environment and character pipelines are DIFFERENT contracts
  (GLB+loose-maps vs FBX+ModelImporter) — decide per role now.
- Refresh the blockout truth sheet from LIVE scene/config facts (dimensions, counts, spawn/extract,
  roles, camera height/pitch/FOV, HUD, tier readability). The truth sheet is the layout contract; the
  hero shot is the style contract.
- **Human gate:** developer approves the spend list (which roles get paid 3D, at what count).

### Stage 2 — Source images

- Generate ONE-object images. Split any multi-object sheet content-aware before Stage 3.
- QC each image: silhouette read, palette, role-read, scale cue, single-object purity. Keep signal
  colors disciplined (threat vs loot/extract must not collide).
- **Human gate (image QC):** no failed source image proceeds to paid image-to-3D.

### Stage 3 — 3D import and review

- Submit only approved images (one object each). Reuse via the cache key in `GeneratedArtWorkflow.md`
  before re-spending credits.
- Download GLB/FBX + loose PBR maps under LFS. Build Unity materials from the loose maps — do NOT trust
  provider materials. Static props: GLB is usually fine for mesh scale. Animated characters: FBX +
  `unity_asset_configure_model_importer` (Meshy FBX defaults `avatarSetup:0`, so avatar/clip sub-assets
  are absent until configured).
- Stage every import in an `_AssetReview` lineup at gameplay scale, grouped by role/tier; capture a
  review screenshot.
- **Human gate (hero-read):** review screenshot, provenance (provider/model/job/source-hash/cost/
  balance/output-hash per `GeneratedArtWorkflow.md`), and hashes recorded before any real-scene dressing.

### Stage 4 — Scene dressing

- Place art under a dedicated visual parent (`unity_scene_set_parent`), preserving gameplay roots.
- Apply as prefab variants / instance overrides. For a destructive `unity_asset_replace_with_prefab`:
  pre-flight with `unity_scene_find_references_to` on the target hierarchy, pass `expected_scene_path`
  (guards the wrong active scene) and `remap_references:true`, then read `remapped[]`/`unmapped[]`.
  Resolve every `unmapped[]` by hand; a `dry_run:true` pass reports mappability against the prefab asset
  first.
- After the swap run `unity_scene_validate_references` (severed refs flag `missing:true`) and
  `unity_scene_compare_gameplay_geometry` against the Stage-0 baseline.
- **Gate:** compile clean, `error_count=0`, gameplay smoke passes, geometry compare shows zero drift,
  zero severed references. Guid-stable in-place fixes (re-crop/regenerate keeping the guid) self-update
  references with no rewiring — prefer them.

### Stage 5 — Ground, decals, baked FX, boundary

- Build a SEAMLESS local tile plus a level-scale macro overlay (verify PIL↔Unity V-axis when authoring
  overlays programmatically — they disagree). Add transparent decals, additive cards, amber pools,
  beacon beams, blob shadows as textures/quads on the baked-signal budget (`GeneratedArtWorkflow.md`
  Mobile Art Defaults: one directional light + emission/bloom, bake the rest).
- Boundary is a DESIGN pass before mesh work: it must read "the world continues, you cannot," read from
  the top-down camera, not occlude the south/front edge, stay signal-neutral, and vary (modular rhythm +
  breach/accent pieces). Test worst-case occlusion by walking the player flush against the boundary.
- Extraction/objective zones stack signals by distance (far beacon/beam → mid amber wash → near
  rotating ring + chevrons); validate the drawn ring size against the ACTUAL trigger radius.
- Spawn points are designed, not hidden by default: telegraph with floor hatch/grate markers, red
  threat-aligned glow, rise-from-below, dust puff, positional audio.
- **Gate:** no obvious tile repetition, no grey-alpha plates, mobile light budget respected, boundary
  occludes nothing at the front edge, drawn affordances match trigger radii. Use
  `unity_scene_set_render_settings` for ambient/fog, not YAML edits.

### Stage 6 — Characters, weapons, animation

- Route animated characters through `unity_asset_configure_model_importer` (animationType, avatarSetup,
  importAnimation, `clip_overrides` for `loopTime`). Discover clips with `unity_asset_list_sub_assets`
  (imported clip fileIDs are name-hash-based, not `7400000`; takes arrive with doubled prefixes like
  `Armature|Armature|...`).
- Bind clips with `unity_animator_set_state_motion` / `unity_animator_apply_spec` motion selectors; then
  confirm no state has a null `m_Motion`.
- Match locomotion clips to move speed by MEASURING foot-slide: derive the clip's natural locomotion
  speed from foot curves and compare to move speed. A large mismatch (e.g. 0.3 vs 4.9 m/s → 15× playback)
  means SWAP the clip, do not multiply playback speed — reusing a sprint clip at 0.65× made walk→sprint
  read as one accelerating run.
- Create a calibrated weapon socket on a rig bone and parent the weapon at LOCAL identity — do not tune
  placement per pose. Put aim-yaw correction in `LateUpdate` about true world-up on the live bone, not as
  baked clip yaw. Firing-pose grammar: standing/walking fire pose (never the sprint pose), sprint drops
  the fire pose quickly, short firing latch after a shot. Muzzle spawns projectiles from the animated
  muzzle transform with small clearance. Ship a scene-scoped, default-off serialized debug toggle (the
  `_fireWithoutTarget` pattern) so the developer can tune spawn feel in any locomotion state.
- Death/hit FX must match material semantics: metal robots want sparks/smoke/ember/char, not a red puff.
  If gameplay destroys the object immediately, cache the renderer BEFORE death and spawn a temporary
  wreck; clean it up on a lifetime.
- **Verify animation with `unity_runtime_sample_animator`, never a static pose.** Require `status:"ok"`
  with `time_advancing:true` and `bones_moving:true`; treat `blocked_unfocused` / `blocked_culled` /
  `insufficient_samples` as NOT verified. Paused-scene pose reads and muzzle/grip vector samples in the
  live scene beat offline quaternion math.
- **Human gate (animation feel + weapon grip):** subjective animation quality and weapon grip need
  focused human approval OR explicit animation-time evidence. Do not commit animation feel changes until
  the developer approves — headless can compile and still be visually wrong.

### Stage 7 — Optimization pass (audit first)

- Audit BEFORE changing anything: texture dimensions×role, audio file sizes + import load type, mesh
  triangles × instance frequency, URP shadow settings, build-scene config. The worst dogfood offender was
  a 30.7k-tri T-wall instanced 57× — regenerating that one segment at ~6k tris removed the cost while
  preserving layout/read. Optimize high-frequency instanced meshes before isolated props.
- Cap textures by what the gameplay camera resolves (not source prestige); keep 2048 only for
  fullscreen/ground-scale surfaces. Compress long loops in memory (no raw-PCM music/ambience at load).
  Add Static flags / one-material-per-prop; do NOT add static-batching flags without evidence when the
  SRP Batcher may already cover the cost. Update assets in place when bounds match so layout/refs survive.
- For a marketing hero capture, use the REAL render path (a capture script rendering the post-processed
  frame) — the screenshot tool bypasses bloom/vignette/ACES/split-toning. Label capture provenance
  (scene-view vs game-view vs swap-chain, post-FX included/excluded).
- **Gate:** gameplay-read unchanged at the target camera (`unity_scene_compare_gameplay_geometry` still
  zero-drift). Mark the pass `hardware_unvalidated` until a real device build proves frame rate, memory,
  and post-processing cost — theory-sound ≠ device-proven.

## Provenance and correction capture

User visual corrections are first-class pipeline evidence — wrong ground texture, non-looping walk, null
idle clip, drifting weapon, camera-zoom scale, movement-facing rule, sprint-vs-fire pose. Record each as
a candidate learning tagged `observed-this-session` / `inherited-handover` / `user-taught` before
promoting into canonical docs, skills, or gates. Do not bury corrections in chat memory.

## Boundaries

- Keep Loomtide core generic: use `unity_*` / `runtime_*` ops and the CLI verbs. Do not add
  game-specific bridge operations.
- Missing source hash, provider job id, output hash, import diagnostics, or review capture ⇒ `blocked` /
  `incomplete`, never green (`GeneratedArtWorkflow.md` Failure Semantics).
- A dirty or unexpected active scene during mutation ⇒ refuse until saved/switched or an explicit guarded
  override is passed.
- Do not promote the source dogfood project's exact art choices, Meshy job/clip names, one-off UI aesthetics, or game-specific
  tuning values as canonical until a second run validates them.
