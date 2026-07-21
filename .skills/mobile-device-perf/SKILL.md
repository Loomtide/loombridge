---
name: mobile-device-perf
description: Profile and optimize an AI-built Unity mobile game toward a frame-time target on REAL devices — automated adb build→install→launch→logcat perf pipeline, device-tier matrix, p50/p95/p99 per workload, and one-lever-at-a-time A/B. Use when a Unity mobile game must hit a frame-rate target (e.g. 60 FPS on low-end Android) on real hardware and editor numbers are lying to you.
---

Use this skill to drive a Unity mobile game to a frame-time budget on **real devices**, not in the editor.
The discipline is **measure → rank → fix ONE lever → re-measure**, and the single load-bearing rule is:
**editor CPU/GPU numbers are not device evidence.** The source dogfood project (a top-down mobile
extraction-shooter gray-box; "the dogfood project" below) read CPU 1.1 ms / GPU 0.7 ms in the editor
while the iPhone stuttered — that lesson is already paid for (GRL-C10). Only a capture off a real device
counts.

> **This is a CANDIDATE skill — validated by ONE run** (the dogfood project's perf pass 1, 2026-07-05). The
> `[validated …]` rows below were executed once, on a single reference device; do NOT promote them to
> genre law until a second mobile-shipping run repeats them. Everything tagged `[method: plan-derived]`
> is audited-and-sound but NOT yet device-proven. Every concrete dogfood number is an ANECDOTE from
> one game on one phone — use the *shape* of the rule, re-derive the number per game/device.

## Loomtide surface routing (do the static pass FIRST)

1. **Run `loomtide mobile-audit` before touching anything.** Capture the working set with the MCP op
   `unity_editor_audit_mobile_assets` (walks the CURRENTLY-LOADED scenes: textures / audio / meshes by
   `triangle_load` = tris × instance_count, quality + URP render-pipeline settings), save the
   `payload_kind: mobile_asset_audit` response verbatim, feed it to `loomtide mobile-audit --input
   <audit.json>` for advisory findings. This ranks SUSPECTS (the 30.7k-tri wall instanced 57× surfaces at
   the top); it is stamped `hardware_unvalidated` **by design** — it never certifies frame rate. It tells
   you where to point the device capture, not whether the game is fast.
2. Perf-relevant bridge ops that exist at HEAD (verified in `mcp-server/TOOLS.md`): `unity_editor_get_state`
   (play_mode / compile / `error_count`), `unity_editor_console_logs` (severity-filtered EDITOR console —
   NOT device logcat), `unity_scene_snapshot_gameplay_geometry` / `unity_scene_compare_gameplay_geometry`
   (prove an optimization pass did not move gameplay geometry — zero-drift is the "visual-only" evidence).
   None of these measure DEVICE frame time; the device-truth channel lives outside the bridge (§ below).

## The device capture pipeline — VALIDATED (1 run, the dogfood project's perf pass 1)

The whole capture is **automated and scripted end to end** — no hand-timed screenshots:

- **Build → install → launch → logcat harvest.** A durable C# `[MenuItem]` build (driven via one
  `unity_editor_execute_menu_item` op + `.loomtide/editor-allowlist.json`) → `adb install` → `adb shell am
  start … --ez botmode true` (arms the scene's bot cohort at 1× time) → `[PERF]` lines filtered out of
  `adb logcat`. `[validated: GRL-C25/C28, 1 run]`
- **Structured perf lines in logcat are the device-truth channel.** The on-device overlay emits one
  `[PERF]` line per window (frame time, GPU ms, memory, GC heap, exceptions); harvest those from logcat —
  do NOT read the editor. `[validated: GRL-C25/C28, 1 run]`
- **Development Build is required for SetPass / Batches / Tris.** Outside a Development Build those counters
  read **0** — a false zero, not a fast frame. `[validated: GRL-C25/C28, 1 run]` (also GRL-C10)
- **Per-launch preset override for A/B.** Pass the preset as a launch intent extra (`--ei preset 0` for
  Low, `--ez botmode true` for bot mode) so each arm arms a KNOWN preset from the command line — never
  mutate settings between arms in the app. Confirm the arm actually engaged (log line + the expected fps
  cap). `[validated: GRL-C25/C28, 1 run]`
- **Settled-vs-mid-arc filing discipline.** Classify each capture window as **settled** (steady-state, DVFS
  and thermally settled) vs **mid-arc** (scene reload / spin-up / transient) and file them SEPARATELY —
  never average across the boundary. DVFS clock-parking inflates per-frame GPU ms in a transient or
  fps-capped window, so a mid-arc window is not comparable to a settled one. **File the numbers in the
  perf plan doc BEFORE and AFTER each lever** (a before/after table per device tier), so a lever's effect
  is attributable and durable. `[validated: GRL-C25/C28, 1 run]`

> Anecdote (dogfood pass 1, one phone): OnePlus 10R / Adreno 730 dev APK, bot-cohort workload,
> 26×10 s windows read a locked 60 (p50=p95=p99=16.7 ms) with GPU ~5.4 ms and ~525 MB, flat across 9
> scene reloads. These are single-device anecdotes, NOT a target — a Mali-G52 min-spec phone has ~5–8×
> less GPU throughput and will not hold 60 on the same settings.

## Method — plan-derived (audited, NOT yet device-proven beyond one reference tier)

Sourced from the audited dogfood-project performance plan; sound but proven on only the reference device so far.

- **Device-tier matrix, first.** Min-spec (must hold the target) / mainstream-low / reference. **Bucket by
  GPU class + RAM, not by model name** (Mali-G52 MC2 / Adreno 610-class = min-spec). Rank the tiers from the
  **Google Play Console → Reach and devices → Device catalog** export (market install base, since a
  pre-launch app has no audience yet). All min-spec claims are made on a physical min-spec device; the
  reference phone is for bring-up, rig, relative A/Bs, and pacing — **never for min-spec certification.**
  `[method: plan-derived]`
- **Report p50/p95/p99 frame time per workload per device — NEVER averages.** On a vsynced 60 Hz panel
  presented times quantize to 16.67 ms (the gate is tautological when passing); gate on the CPU-main and
  GPU sub-budget p95s + missed-vsync %, not presented frame time. `[method: plan-derived]`
- **The 3-workload capture protocol.** W1 idle (arena, no combat — floor cost) / W2 mid-combat (~10 enemies
  + projectiles + hit FX — typical) / W3 peak (max heat, extraction hold, bloom/emissive-heavy — worst
  case). Capture CPU main / render / GPU split + draw calls + overdraw + memory per workload per tier.
  `[method: plan-derived]`
- **One lever at a time.** One target metric, one dominant lever changed, re-run the SAME workload, keep or
  revert. Levers rank from the baseline (HDR/Bloom bandwidth, main-light shadow map/distance, MSAA,
  transparent overdraw, CPU sim tick rates, canvas rebuilds, frame pacing, shader warmup, ASTC/texture).
  `[method: plan-derived]`
- **Thermal soak.** A ≥30-minute soak must hold the sustained target (low-end phones throttle within
  minutes) — reserve GPU headroom for it; first-minute numbers lie. `[method: plan-derived]`
- **Frame pacing.** Verify Optimized Frame Pacing (Swappy) actually engages on-device; on a 90 Hz panel a
  clean 60-cap beats a drifting 45–55 band, which *feels* worse than a paced 30. `[method: plan-derived]`

## The reproducible workload is the bot cohort (cross-reference, do not duplicate)

The standard perf workload is a **fixed-seed persona-bot cohort run** (e.g. a Greedy cohort on Arena map 1
as the 60 s workload) — the SAME substrate the greed-loop tuner uses, so every tuning cohort doubles as a
perf regression run. The cohort machinery, persona contract, telemetry schema, and honesty rules live in
`.skills/graybox-greed-loop-tuning-pack/SKILL.md` and the `3d-topdown-arena` genre pack — do **not** restate
them here. A `perf_sample` telemetry event (frameTimeP95, gpuMs, memMB) sourced from `FrameTimingManager`
(release-safe; ProfilerRecorder render counters read 0 outside Development Builds) is a candidate schema
addition once it proves out on a second run.

## DO-NOT (evidence-backed)

- **Never claim a low-end / min-spec result without a min-spec device.** The dogfood project's Low-vs-Medium A/B
  was **inconclusive** because it ran on a never-GPU-bound high-end phone (Adreno 730): both arms read flat
  GPU ms, DVFS parked clocks low in both, so the preset delta sat below the device's resolution floor. Do
  NOT read "Low buys nothing" from a device that never saturates — the lever must be measured where the
  workload actually saturates the GPU. `[validated do-not: GRL-C24, 1 run]`
- **Never A/B without pinning the preset per launch.** Each arm arms a known preset from the launch command
  (`--ei preset …`), not by toggling settings in-app between arms — else you lose attribution and can't tell
  a lever's effect from DVFS noise. `[validated do-not: GRL-C25/C28, 1 run]`
- **Never read editor CPU/GPU numbers as device evidence.** The editor read CPU 1.1 ms / GPU 0.7 ms while
  the iPhone stuttered. Editor console_logs / get_state / profiler are for editor debugging; the device
  perf truth is the on-device `[PERF]` logcat channel only. `[validated do-not: GRL-C10, 1 run]`
- **Never trust SetPass/Batches/Tris off a non-Development Build** (they read a false 0).
- **Never average across the settled↔mid-arc window boundary**, and never file a lever's after-number
  without its before-number in the same table.
- **Never promote a dogfood-project number** (16.7 ms, ~5.4 ms GPU, 525 MB, `--ei preset 0`, tier device lists)
  as a genre/device constant — one game, one phone, one run.

## Boundaries

- Loomtide owns the **static** audit (`unity_editor_audit_mobile_assets` → `loomtide mobile-audit`, always
  `hardware_unvalidated`) and the geometry-drift proof that an optimization pass did not move gameplay. It
  does **not** own the device: the adb pipeline, logcat harvest, on-device overlay, Play Console export,
  profiler/GPU counters, and the physical min-spec device are all outside the bridge — this skill is the
  human/device-in-the-loop runbook that surrounds them.
- Use only generic `unity_*` / `loomtide` ops; do not add game-specific bridge operations.
- A `mobile-audit` finding, a passing editor capture, or a green reference-tier A/B is NEVER a min-spec
  pass — it stays `hardware_unvalidated` / inconclusive until a real min-spec device build proves frame
  rate, memory, and thermal soak. Theory-sound ≠ device-proven.
