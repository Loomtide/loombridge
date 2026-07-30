# TideRunner dogfood: product learnings

Source transcript: `/private/tmp/claude-501/-Users-avinash-Projects-AI-loombridge/b1457f72-3c28-433d-9ca8-66162d4a4087/tasks/ac83c964d739824e6.output`

---

## Interval 1: run 2026-07-30, processed to byte offset 856645 (JSONL lines 0 to 155)

Builder progress at this offset: slices `framing` and `ground-tiling` are green and approved
(2/9), `player-feel` has been minted by `loombridge build`
(runId `run-player-feel-2026-07-30T13-33-10-756Z-453c94fe`, captureManifest
`player-feel/feel.json` + `player-feel/console.json`) and the builder is reading the
`feel` / `feel-provenance` / `physics-timestep` gate sources. Scene is
`Assets/Scenes/Main.unity` with `/Main Camera` (ortho 4.5 at 8,4.5,-10 + PixelPerfectCamera
16 PPU / 256x144), `/Player` (SpriteRenderer, NinjaFrog Idle_0), and
`/Level/Terrain/{Ground,Platform_A,Platform_B}` each a BoxCollider2D parent with Tiled
SpriteRenderer rows. One agent-authored editor script exists:
`Assets/Editor/GroundTiling.cs` (409 lines).

### Flow friction

- **L1. `loombridge capture` does not produce every file `loombridge build` requires, and
  exits 0 anyway.** `build` minted ground-tiling with a 4-entry captureManifest
  (`placement.json`, `platform-tiles.json`, `tile-render.json`, `console.json`), but
  `capture --slice ground-tiling` writes only three of them: "invoked
  GroundTiling.WriteTileCaptures -> wrote [platform-tiles.json, tile-render.json] +
  console.json", `EXIT=0`. Nothing named the missing `placement.json`. The builder only
  found the gap by reading `capabilities/verification/run-gates.ts` in the repo and
  discovering `{ gate: "placement", file: "placement.json" }` with no producer
  (`domain/capture-recipes.ts` maps gates to only `framing | tiles | console`). The fix
  the CLI should have named: either a placement recipe, or a capture warning listing the
  manifest entries it did not write.
- **L2. `capture --help` advertises three recipes and silently has no row for the
  gates that need agent-assembled evidence.** The help lists framing, platform-tiles /
  tile-render, and console-clean. `placement`, `reachability`, `prop-purpose`,
  `playability`, `feel`, `coverage`, `parallax-motion`, `visual-artifacts`,
  `render-frame` all have evidence files in `run-gates.ts` and no recipe. An agent
  reading only the help concludes capture covers its slice.
- **L3. The framing verdict grades a strict subset of the framing contract, with no
  notice.** `.loombridge/ACCEPTANCE.json` framing declares `aspect 16:9`,
  `nativeResolution 256x144`, `pixelScale 5`, `backgroundColorHex "#2a1f4d"`,
  `origin "bottom-left"`, plus the pixelPerfect block. The graded checks in
  `framing.verdict.json` were exactly: `anchor.player`, `clip.Player`,
  `camera.projection`, `camera.position`, `camera.orthographicSize`,
  `camera.pixelPerfect.assetsPPU`, `camera.pixelPerfect.refResolution`,
  `camera.pixelPerfect.upscaleRT`, `camera.pixelPerfect.pixelSnapping`,
  `console-clean.infra`. The builder probed for this deliberately and printed
  `background check present: False`, `aspect check present: False`. A contract field that
  is declared and never graded is exactly the "declared path nothing walks" shape:
  someone could set the camera background to any color and the framing gate stays green.
- **L4. `.loombridge/STATE.md` does not track slice verdicts.** After two green,
  approved slices the embedded state is still
  `"phase":"built-unverified","lastVerdict":null`. Progress lives only in
  `SLICES.json`. The human-readable status file understates the run.
- **L5. The verdict JSON is ~90 percent `not_applicable` noise.** Every slice verdict
  enumerates all 19 gates with a `<gate>.slice` check whose detail is a paragraph about
  scope. For the framing slice that is 17 not-applicable stanzas around 10 real checks;
  the builder had to write a python one-liner filtering `status != 'not_applicable'`
  twice just to read its own result.
- **L6. `verify`'s exit code is hard to capture from a pipeline.** The builder wrote
  `loombridge verify ... | tail -40; echo "EXIT=${PIPESTATUS[0]}"` twice and got
  `EXIT=` (empty) both times. It was saved by `verify` printing `exit=0` inside its own
  success line, which is a good affordance worth keeping and extending to `capture`.

### Bridge and op gaps

- **L7. `component.set_property` on an enum wants Unity's display string, not the C#
  identifier.** `clearFlags: "SolidColor"` was refused with
  `INVALID_PARAMS: Unknown enum value: 'SolidColor'. Valid: [Skybox, Solid Color, Depth
  only, Don't Clear]`. The refusal named the fix (good), but the space-bearing display
  names are the opposite of every C# reference an agent has seen, so the first attempt
  will nearly always be wrong. Accepting the identifier form as an alias would remove one
  guaranteed round trip per game.
- **L8. The documented post-script-create chain can silently skip the authoritative
  compile result.** After `code.create_script` (which returned success,
  `{"path":...,"replaced":true}`), the reconnect attempt failed once with
  `CONNECTION_LOST: code=1006`, and the retried `editor.wait_for {compiling:false}`
  returned `{"waited_ms":95}` with no `compileResult`. Per the op's own doc, absent
  `compileResult` means "no compile happened in this window", not "compile succeeded":
  the compile finished during the 3s retry backoff. The builder fell back to
  `editor.get_state -> error_count: 0`, which is weaker evidence (it is a console-error
  count, not a compiler verdict). There is no "give me the last finished compile result"
  query, so the recommended pattern is racy by construction whenever a reconnect is
  needed, which is exactly the domain-reload case it exists for.
- **L9. `editor.screenshot` with `outputPath` still returns `image_base64`.** The builder
  passed `outputPath: "Logs/tiderunner/ground.png"` and got a large base64 payload back
  in the response (the doc says outputPath returns JSON with path/width/height/sha256).
  It then wrote a second script (`shot2.mjs`) that decodes `image_base64` to a local file
  purely so the `Read` tool could display it. Two scripts and a base64 blob through the
  log for one look at the game view.
- **L10. No op returns the camera's world frame rectangle.** To build `placement.json`
  the builder had to reconstruct `cameraFrame` by hand from
  `scene.get_screen_rects` -> `camera.orthographicSize` and `viewport.aspect`
  (`halfW = halfH * aspect`). Every placement / reachability / coverage capture needs the
  same rectangle; it should come from the bridge, not from agent arithmetic.
- **L11. Sprite import settings and slices were already correct, and checking them cost
  real effort anyway.** The builder read every `.png.meta` with a python regex to learn
  PPU, pivot, alignment and slice names (`Terrain.png` -> 9 named slices GrassTopMid,
  DirtMid, ...). There is no op that answers "what sprites does this sheet expose, at what
  PPU". `asset.list_sub_assets` exists in the catalog but the builder never found it via
  the TOOLS.md scan; the index is 1964 lines read by `sed`.

### MCP surface

- **L12. Driving ops through node scripts costs a file write per idea.** Nine scratch
  `.mjs` files by the second slice (`lib.mjs`, `state.mjs`, `f1.mjs`, `f2.mjs`, `g1.mjs`,
  `pushcs.mjs`, `shot.mjs`, `shot2.mjs`, `placement.mjs`). Every op failure means editing
  and re-running a whole script: the `SolidColor` refusal cost a `sed -i` plus a full
  re-run of scene creation, which re-ran `scene.new_scene` and destroyed and rebuilt the
  scene to retry one property.
- **L13. Tool discovery was `grep` and `sed` over a 1964-line TOOLS.md, and one read
  overflowed.** `sed -n '424,500p;542,660p;996,1152p' TOOLS.md` produced 32.6KB and was
  spilled to a persisted-output file, which the builder then had to `sed` again. With a
  real MCP surface the op list and schemas are already in context and this whole
  sub-phase disappears.
- **L14. Image results needed a manual round trip (see L9).** Under MCP the screenshot
  is an inline image result; here it is base64 in a log, a decode script, and a `Read`.

### Moat and gate integrity

- **L15. `placement.json` is agent-authored evidence that no gate distrusts.** No recipe
  writes it, so the builder assembled it in `placement.mjs` and stamped its own
  provenance block, honestly labelled
  `"writer": "agent-assembled (no loombridge capture recipe emits placement.json)"`.
  `verify --slice ground-tiling` passed `placement=pass` without checking that a
  `_provenance` exists, who wrote it, or whether the runId matches. A less scrupulous
  agent writes `grounds` and `groundedItems` by hand with the numbers it wants and gets
  the same green. This is the single largest integrity gap observed this interval: the
  moat rests on evidence the CLI produces, and this file is outside that boundary while
  still being a hard gate. Contrast with the tile captures, where the CLI stamps
  provenance and the bridge refuses an outDir outside `.loombridge/verify`.
- **L16. The tile-evidence PRODUCER is agent-written C# in the game project.**
  `capture.invoke_static` allowlists the NAME `GroundTiling.WriteTileCaptures` by
  default, and the builder wrote the 409-line `Assets/Editor/GroundTiling.cs` that
  implements it. The allowlist protects against invoking arbitrary code; it does not
  constrain what the allowlisted method reports. In this run the implementation was
  honest (it samples live `SpriteRenderer.sprite`, real `Collider2D.bounds`, and real
  per-column pixel luminance from the texture on disk), but a self-serving version that
  returns constants would pass every check in `platform-tiles` and `tile-render`
  identically. Reported honestly rather than as an accusation: worth deciding whether the
  bridge should ship the sampler rather than allowlist a project-authored name.
- **L17. The builder pre-computed the tile-render gate verdict in python before building
  anything.** It cropped `Terrain.png`, recomputed `edgeInteriorContrast`,
  `junctionContrast`, `interiorDelta` and the `x4` threshold exactly as
  `gates/tile-render.ts` does, and confirmed GrassTopMid / DirtMid / DirtMid2 would pass
  (`0.0188 / 0.0332 vs threshold 0.0603`). The predicted numbers then matched the real
  verdict to four decimals. This is legitimate design-time checking, and it is also proof
  that the seam gate is fully predictable from the source art: an agent can choose tiles
  that pass rather than tiles that look right. No dishonesty here, the whole build is a
  scene of real sprites, but the gate is selectable.
- **L18. `console-clean` grades only the capture window, not the slice's construction.**
  The tile capture sets `consoleCleared: true`, then invokes, so
  `ground-tiling/console.json` held 2 entries and passed with "2 log entries, none
  error/warning". Every error thrown during the dozens of construction ops before the
  capture is outside the graded window. The builder did check the console separately with
  `editor.console_logs {count:200}` (0 warn/err) out of its own diligence, not because a
  gate required it.
- **L19. No hand-edits of `.loombridge/` occurred, and no gate was retried until green.**
  Both slices passed on the first `verify`. The one "retry" was a failed op
  (`SolidColor`), not a failed gate.

### Wins

- **L20. Provenance stamping on CLI-produced evidence is strong and visibly load-bearing.**
  `framing/screen-rects.json` carries `_provenance` with `writer`, `capturedAt`,
  `capturedInPlayMode: true`, `runId`, an `editorSessionId` + `processId` +
  `routeReason: "single"` routing block, and a per-field `sources[]` naming which op
  produced what and in which editor mode
  (`"captured": "edit-mode (authored orthographicSize + fieldOfView)"` versus
  `"captured": "play-mode"` for the screen rects). That is exactly the "a verdict is
  bound to the run it claims" property.
- **L21. `doctor --live` gave a complete, actionable green in one call.** CLI build stamp,
  node version, bundled tarball freshness against packaged sources, manifest dependency
  line, tarball sha, bridge-bytes match, protocol preflight, live handshake. The builder
  ran it once and never questioned the environment again.
- **L22. The op refusals that fired named their fix.** The enum refusal listed the valid
  values; `capture.invoke_static` refuses off-allowlist methods with the exact JSON key
  and file to add (`add "X" to staticMethods[] in .loombridge/editor-allowlist.json`) and
  refuses an outDir outside `.loombridge/verify`; `asset.assign_sprite`'s NOT_FOUND
  diagnoses sprite-mode / unsliced-sheet causes. None of these fired as a surprise
  because the docs pre-empted them, which is itself the point.
- **L23. `plan --go` -> `build` is frictionless and states the dependency it satisfied.**
  `Next unblocked: ground-tiling (needs framing OK)` then a minted runId and an explicit
  next instruction. The builder never had to ask what to do next.
- **L24. Every op failure auto-captured a screenshot artifact.** The `SolidColor` error
  response carried
  `artifacts: [{kind: "screenshot", sourcePath: "Logs/Loombridge/screenshots/error_..._component_set_property.jpg"}]`
  without being asked.

### Raw notable events

- **L25.** `EACCES` writing into the Unity project from the scratchpad through a
  `..`-chained relative path
  (`scratchpad/tiderunner/../../../../../../loomtide-runs/.../verify/ground-tiling`),
  which then succeeded with the same directory addressed absolutely. Harness sandbox
  quirk, but it is also the repo's own "never count `..` segments" rule biting an agent
  from the outside.
- **L26.** `.loombridge/verify/<slice>/asset-manifest.json` appears in both slice verify
  dirs and is a verbatim copy of `.loombridge/ASSET_MANIFEST.json`. Neither `build` nor
  `capture` announced writing it and it is not in either slice's captureManifest.
- **L27.** The builder launched an `Explore` subagent to map the framing gate and the
  capture recipe, then read all of the same source itself while waiting; the subagent
  result never arrived within this interval. Duplicated work, no product impact.
- **L28.** `editor.set_game_view_size {1280,720}` returned
  `previousWidth: 1280, previousHeight: 720`, that is, the view was already at the target,
  so the framing evidence's `viewport` (1280x720, aspect 1.7777) reflects whatever the
  human left the Game view at, not something the contract pinned. The framing gate does
  not grade aspect (L3), so nothing binds the captured viewport to the declared 16:9.
- **L29.** `code.create_script` returned a normal success response before the domain
  reload landed; the reload then killed the NEXT connection instead
  (`retry 0 ... CONNECTION_LOST: code=1006`). Matches the documented hazard, and the
  builder's own retry-with-backoff wrapper absorbed it in one attempt.

---

## Interval 2 (FINAL): mined 2026-07-30, byte range 856645 to 1227337 (JSONL lines 156 to 233)

Builder status: **finished-blocked**. Two slices green and approved (`framing`, `ground-tiling`),
`player-feel` built, measured, and honestly failing (`feel=fail feel-provenance=pass
physics-timestep=pass console-clean=pass`, exit 1, slice state left at `built`). The builder
stopped on a contract contradiction rather than tuning the controller to chase the band.

What this interval contains: a fixed-timestep fight, an authored `PlayerController` +
`PlayerInputReader`, two full live feel-measurement passes (unpinned then pinned at 120fps, 7
trials each), a hand-written `assemble.mjs` that produced `feel.json`, `capture` + `verify` on
`player-feel`, and the final report.

### Cross-check of the builder's own 9 findings against the transcript

1. **shortHopApex unsatisfiable under the 6-tick canonical tap: EVIDENCED.** Constants read live
   (`SHORT_HOP_CANONICAL_TAP_TICKS = 6`, `SHORT_HOP_TAP_TICK_TOLERANCE = 0`), verdict `FAIL
   feel.shortHopApex | 1.4133u | exp 0.72u (±10%)`, `jumpApex`/`timeToApex`/`runSpeed` all PASS in
   the same file. Two discrepancies worth recording: (a) there were **six** canonical trials, not
   three, 3 unpinned (all 1.41327322) and 3 pinned (1.4133, 1.4133, 1.5303); the report cites only
   the pinned set. (b) The quoted `Live diag on tiderunner: 2t->0 ... 6t->1.405` line is real
   (`domain/feel-primitives.ts:89`) but does not appear in any tool result in this interval; the
   builder's visible read window was lines 72 to 80. See L50 for the larger point: the repo has
   already fixed this value in one artifact and not in the two an author copies from.
2. **Framing fields declared and bound by zero checks: EVIDENCED and now verified at source.**
   `acceptance.schema.json` requires `framing.aspect` + `framing.playerAnchor`, and requires
   `worldPosition, orthographicSize, backgroundColorHex, pixelPerfect` under `framing.camera`.
   `gates/framing.ts` contains **zero** references to `backgroundColorHex` or `verticalPan`.
3. **`capture --slice` writing 3 of 4 manifest files and exiting 0: EVIDENCED** (interval 1, L1),
   and it recurred here on `player-feel` (L34).
4. **`feel.json` has no CLI producer: EVIDENCED.** `run-gates.ts` binds four gates to `feel.json`
   with `op: "FeelHarness + runtime.probe recipes (assembled)"`, and no recipe emits it. The
   sub-claim that `verify --profile` writes a nested `{metrics:{...}}` shape is **not evidenced in
   the transcript**: the builder never ran or read `--profile` in either interval. Repo inspection
   supports the direction (profile mode writes `<workspace>/feel/reports/feel-profile.{json,html,md}`
   and `<workspace>/feel/profile-measurements.json`, a different artifact family from a slice
   verify dir), but treat the exact shape claim as unverified.
5. **`runtime.probe` lacks the three fields its owning gate demands: EVIDENCED at source.** The
   probe response object built in `RuntimeHandler.cs` (~2770 to 2830) is
   `{phases[], sampleCount, totalDurationMs, samples?}`; a grep for the timestep field names
   returned only the `measure_motion` / `capture_input_motion` paths (`MotionMetrics.Compute`).
   `validMeasurementSource` requires `captureFps > 0`, `projectFixedTimestepBeforeMeasurement` and
   `measurementFixedTimestep`.
6. **fps-0 default corrupting numbers: EVIDENCED**, with a correction: the effective unpinned rate
   was ~11 to 12Hz, not ~10.5Hz (14 samples over a 1200ms run window; 17 over 1508ms). The
   deltas cited (run 5.60 vs 6.18, dash phase 0 vs 2.5) are exact.
7. **`editor.screenshot` ignoring `outputPath`: EVIDENCED** (interval 1, L9).
8. **Rigidbody2D velocity unsettable: PARTIALLY EVIDENCED.** The transcript shows only the
   `m_Velocity` refusal verbatim (`No property found matching 'm_Velocity' on Rigidbody2D`); the
   `m_LinearVelocity` attempt was wrapped in a `.catch()` so its error text was swallowed. That the
   fallback ran does prove `m_LinearVelocity` failed, but no one saw why.
9. **Positives: EVIDENCED**, and the refusal path is the strongest of them (L54).

### Flow friction

- **L30. Nothing in the product sets the project fixed timestep, and the obvious way is silently
  ineffective.** The `physics-timestep` gate demands 1/60. The builder hand-edited
  `ProjectSettings/TimeManager.asset` YAML (`m_Count: 2822399` to `2352000` over
  `m_Numerator: 141120000`), and the next play-mode measure still reported
  `projectFixedTimestepBeforeMeasurement: 0.02`: the running editor holds the value in memory and
  ignores (and can clobber) the on-disk edit. The fix that worked was authoring
  `Assets/Editor/PhysicsTimestepBootstrap.cs`, an `[InitializeOnLoad]` script that pins
  `Time.fixedDeltaTime`, pushing it, and waiting for the compile. Satisfying a first-class gate
  required writing C# into the game project.
- **L31. A gate-bound feel capture outruns the default tool timeout and is not resumable.**
  `feel2.mjs` (7 pinned trials at 120fps) was killed at 2 minutes with exit 143; `timeout` does not
  exist on macOS (`command not found`); the re-run needed an explicit 560s budget. There is no
  progress output and no per-trial persistence, so a killed run loses every trial.
- **L32. `loombridge status` does not report a failing gate.** After the fail verdict was written,
  status still said `player-feel needs capture/verify evidence; run /loombridge:build or say
  continue`. Evidence exists, a gate failed, and the summary line describes neither.
- **L33. `EXIT=` empty from `${PIPESTATUS[0]}` recurred** on the `player-feel` verify (L6 again),
  rescued again only because verify prints `exit=1` inside its own line.
- **L34. `capture --slice player-feel` wrote 1 of the 2 declared manifest entries and said nothing.**
  It announced `console.json (34 log(s): 32 startup + 2 steady)` and exited. The other entry,
  `feel.json`, is the entire verdict for that slice, and no recipe emits it. Same shape as L1, on
  the slice where the missing file is everything.
- **L35. The second background research agent also never delivered.** An `Explore` agent was
  launched with a six-part question (is there a shipped `FeelHarness`, is there any producer of
  `feel.json`, exact response shapes for six runtime ops, the canonical-tap recipe, the
  `feel-rederive` source, any reference `PlayerController`). It never returned before the run ended;
  the builder answered all six itself with `sed` over TOOLS.md and `grep` over
  `RuntimeHandler.cs`. Two of two research agents produced nothing usable (see L27).
- **L36. There is no reference `PlayerController`, so every consumer re-derives the contract.** The
  builder authored `PlayerController.cs` from scratch: the feel fields
  (`moveSpeed/jumpSpeed/gravityScale/jumpCutMultiplier/coyoteTime/jumpBuffer/dashSpeed/dashTime/
  dashCooldown`), an input seam (`moveX/jumpHeld/dashHeld`) so a measurement driver can own input
  without bypassing controller logic, a tick-quantized dash, an `OverlapBoxNonAlloc` ground probe,
  and the `#if UNITY_6000_0_OR_NEWER` `linearVelocity` versus `velocity` split. The
  `platformer-2d` pack bands these metrics and ships nothing that realizes them.

### Bridge and op gaps

- **L37. `component.set_property` cannot set `Rigidbody2D` velocity.** `m_LinearVelocity` failed and
  `m_Velocity` refused with `No property found matching 'm_Velocity' on Rigidbody2D`. A measurement
  harness therefore cannot zero the body between trials. The builder's workaround was
  `scene.set_transform` to a fixed spawn plus `editor.tick {frames: 30..40, captureFps: 60}` to
  settle.
- **L38. `runtime.probe` structurally cannot satisfy the gate that names it sole owner.** Its
  response carries no `captureFps`, no `projectFixedTimestepBeforeMeasurement`, no
  `measurementFixedTimestep`, while `validMeasurementSource` requires all three and
  `SOURCE_METRIC_OWNERSHIP` gives `runtime.probe` exclusive ownership of `coyoteTime` and
  `jumpBuffer` (plus `dashDistance`, `shortHopApex`). Those metrics are un-certifiable today by any
  honest route, which is exactly why this run left three of them at "(not measured)".
- **L39. `capture_input_motion`'s default `captureFps: 0` sampled at ~11Hz and changed the numbers.**
  Same recipes, unpinned versus pinned at 120: run `deltaX 5.60` versus `6.1833` (implying 6.22 u/s
  versus the true 7.0), dash phase 2 `deltaX 0` versus `2.5`, `sampleCount` 14 versus 145. The op
  doc explicitly warns off `fastForward` for gate-bound captures and blesses fps 0 as the default.
- **L40. At fps 0 the canonical stimulus itself was wrong and nothing downstream could see it.** The
  warmup capture requested `fixedTicks: 6` and the bridge reported `actualFixedTicks: 7`
  (`rft: 6, aft: 7`) with a 1-sample phase. Under 120fps pinning every short hop reported
  `aft: 6`. `SHORT_HOP_TAP_TICK_TOLERANCE` is 0, so the documented default can silently produce an
  off-canon tap, and the evidence format records the requested value, not the actual one (L46).
- **L41. Three identical canonical taps did not reproduce.** Pinned: 1.4133, 1.4133, 1.5303, a
  spread of 0.117u or 8.3 percent, against a ±10 percent band. Unpinned, the same three were
  bit-identical at 1.41327322. Pinning improved run and dash accuracy while making the short hop
  less repeatable. A metric whose canonical trials spread almost the whole band can be decided by
  which trial an assembler picks; the builder took the median and said so in a free-text note,
  but the format neither records that three trials existed nor requires N-trial agreement.
- **L42. The canonical `dashDistance` phase-delta recipe is off by one tick by construction.**
  Dash phase (`D + LeftShift`, 150ms, `aft: 9`) measured `deltaX 2.5`, exactly 8 dash ticks at
  0.3125u, because one of the 9 dash ticks lands in the following phase (which read 2.1 against a
  ~0.7-per-300ms walk baseline). A controller whose dash is arithmetically exact
  (`18.75 x 0.15 = 2.8125`) reads 2.5 against a 2.672 to 2.953 band. The obvious way to pass is to
  lengthen the dash to 10 ticks, that is, the recipe pressures the builder to corrupt the real
  value to satisfy the gate.

### MCP surface

- **L43. Every runtime interaction was a hand-written node script with its own transport
  resilience.** By the end there were 16 scratch `.mjs` files. A raw 1006 close killed `probe1.mjs`
  with an unhandled rejection and a Node stack trace, after which the builder added `retryUnity`
  (8 attempts, 2.5s backoff, regex-matching `CONNECTION_LOST|Failed to connect|Not connected|1006|
  closed`) to `lib.mjs` and wrapped every subsequent script in it. Reconnect policy is being
  reinvented per session in the consumer's scratch directory.
- **L44. Op discovery was `sed` over TOOLS.md again, and again overflowed.** The runtime section
  read spilled 40.8KB to a persisted-output file, which the builder then `sed`-ed twice more with
  regex ranges to isolate `capture_input_motion` and `probe`. The documentation is excellent, the
  access path is three tool calls and a spill file.

### Moat and gate integrity

- **L45. `feel.json` is 100 percent agent-authored, and every field the provenance gate reads is a
  literal the assembler typed.** `assemble.mjs` stamped, per source: `source:
  "runtime.capture_input_motion"`, `derivation: "trajectory"`, `captureFps: FPS` where `FPS` is a
  module-level constant `120` and **not** the value echoed by the op, `measuredAt: new Date()`,
  plus `sampleCount` and the two timestep numbers copied from the payload, plus `samples[]`. The
  builder was scrupulous: an honest `provenance.note` says "Assembled by the agent from raw
  `runtime.capture_input_motion` payloads (no loombridge capture recipe emits feel.json)", and the
  runId was read from `SLICES.json` `proof.runId`. `feel-provenance` then passed all five metric
  checks off those strings (`runtime.capture_input_motion:valid-owner`). The same file with
  fabricated `runSpeed`/`jumpApex`/`shortHopApex` and a plausible `samples` blob passes identically.
  This is the L15 `placement.json` gap again, on the artifact the moat exists for.
- **L46. The canonical-tap check is bound to a number the agent typed.** `checkShortHopStimulus`
  reads `stimulus.tapTicks` from the file and refuses anything other than 6.
  `assemble.mjs` wrote `tapTicks: 6` as a literal; the bridge's own confirmation
  (`requestedFixedTicks=6 and actualFixedTicks=6`) went only into a free-text `note` the gate never
  parses. The gate built specifically to stop tap-shopping (its own docstring records F1 shopping a
  70ms tap against a 35ms tap for the reading it wanted) accepts a self-declared 6 from a capture
  that may have run 7 ticks, which L40 shows really happens.
- **L47. `physics-timestep.captureFps` is warn-only and grades a self-declared number.** In
  `gates/physics-timestep.ts` a source with an absent or non-positive `captureFps` falls into
  `fpsMismatched`, and the check's status is `pass` or `warn`, never `fail`. Its `expected` label
  reads `1 / captureFps ~= measurementFixedTimestep` while it actually passed `fps=120` against
  `measurement=0.016667` through an undocumented-in-the-label finer-integer-multiple branch.
  Compounded with L45: had `assemble.mjs` read `raw-feel.json` (the fps-0, ~11Hz pass) instead of
  `raw-feel2.json` while keeping `const FPS = 120`, every timestep check would still have passed.
  The file carries `sampleCount` and `durationMs`, so the true sampling cadence is re-derivable and
  is not re-derived.
- **L48. The one gate that would bind the reported numbers to the raw samples was not run.**
  `run-gates.ts` registers `feel-rederive` against the same `feel.json`, but
  `capabilities/genre/genre-packs/platformer-2d/slices.json` lists `player-feel` gates as
  `feel, feel-provenance, physics-timestep, console-clean`. A 103KB evidence file full of real
  trajectory data was graded on its four headline numbers.
- **L49. "Not measured" is a WARN, not a refusal, which contradicts the repo's own invariant.**
  `gates/feel.ts` emits `status: warn`, `actual: "(not measured)"` for an accepted metric with no
  measurement. Three of seven in-scope metrics (`dashDistance`, `coyoteTime`, `jumpBuffer`) were
  unmeasured here, and the slice would have gone green had `shortHopApex` been in band. CLAUDE.md
  says a gate predicate must REFUSE when a bound field is absent. An agent that measures nothing
  it finds hard gets the same verdict as one that measures everything.
- **L50. The blocking contract defect is stale-copy drift, and the repo already fixed it in the one
  place nobody copies from.** `mcp-server/src/capabilities/verification/tiderunner.acceptance.json`
  carries `shortHopApex` target **1.41** with the note that the old 0.72u derived from
  `jumpCutMultiplier` alone, predates the tick canonicalization, and "is unreachable under the
  canonical tap for any controller that also satisfies jumpApex and timeToApex". The project's
  `.loombridge/ACCEPTANCE.json` carries **0.72** with the old note, and the design brief it was
  authored from,
  `mcp-server/src/__tests__/fixtures/design-briefs/trailer-demo-concept.md:57`, still states
  "short hop 0.72u". Nothing detects that a project contract is a stale derivative of a corrected
  source. Cost this run: a full build, two live measurement passes, and a hard stop.
- **L51. Trial resets are invisible to the evidence.** Every capture was preceded by
  `scene.set_transform` teleporting the player to (6.4, 2.0) plus 30 to 40 settle ticks, inside a
  single continuous play session that had already run earlier captures. `feel.json` records phases
  and timesteps but nothing about the reset procedure, the play-session identity, or trial
  ordering, so a reading taken after a state-corrupting prior trial is indistinguishable from a
  clean one.

### Wins

- **L52. Input System key injection worked with the Game view unfocused.**
  `input.get_capabilities` reported `gameViewFocused: false, required: false` and
  `gameplayKeyInjection.supported: true`, and every keyed phase registered. The historical
  focus tax did not recur.
- **L53. `editor.wait_for` in Play Mode returned `compileDeferred: true` with a paragraph
  explaining that Unity defers Play-Mode script edits and that this wait CANNOT confirm them.** The
  exact hazard of L8, now self-describing in the response.
- **L54. The failing slice was handled correctly end to end.** Verdict written, `exit=1`, and
  printed verbatim: `slice player-feel: verdict written, slice state NOT flipped (verdict.status is
  fail, not pass; verify exit is 1, not 0)`. `SLICES.json` stayed at `built`, status stayed
  `2/9 approved`. No silent partial approval, and the reason was stated rather than implied.
- **L55. The builder refused three tempting outs.** It did not tune `jumpSpeed` or
  `jumpCutMultiplier` to chase `shortHopApex` (which would have broken the passing `jumpApex`), it
  did not edit `ACCEPTANCE.json`, and it wrote "(not measured)" for the three metrics it could not
  measure rather than reading them off controller parameters. Honest-or-stop worked at the agent
  layer, which is the layer the moat is not supposed to have to trust.
- **L56. `console-clean` allowlisted the only warning present** (`[Loombridge] IPC transport
  unavailable in auto mode; fallback to tcp`) as known bridge infra and said so in the check detail.
- **L57. The per-metric verdict lines are exactly what an auditor wants when the evidence is real.**
  `feel-provenance.runSpeed | runtime.capture_input_motion:valid-owner`,
  `feel-provenance.shortHopApex.stimulus | 6 ticks (canonical)`, and a per-source
  `physics-timestep` line naming fps and timestep for each of the three sources.

### Raw notable events

- **L58.** Four round trips to change one project setting: YAML edit, play-mode measure still
  reporting 0.02, author + push `PhysicsTimestepBootstrap.cs`, stop and compile, measure again at
  0.016667.
- **L59.** The `warmup` capture was a deliberate throwaway ("the repo documents a cold-start tick
  penalty on the first injected stimulus"). It was also the only capture to report `aft: 7` at
  fps 0, and at 120fps it read 1.5303 versus the 1.4133 of the next two hops. The warmup convention
  is folklore carried in the agent's prompt: nothing enforces it and nothing records that it
  happened.
- **L60.** The jump capture's phase records read `deltaY: -0.00001` and `deltaY: 4.77e-7` with
  `maxY: 3.7389`: phase-level `deltaY` is start-to-end, so an arc that lands reads ~0. An assembler
  that reached for phase `deltaY` instead of `maxY` would report a zero-height jump. This builder
  used `maxY` and derived from `samples[]`.
- **L61.** `runSpeed` derived from the pinned trajectory came out to exactly 7.0000 u/s, matching
  `moveSpeed 7` to four decimals, while the fps-0 capture's own `avgRunSpeed` convenience field
  reported 4.307 for the same recipe. The op's summary metric was 38 percent low while the raw
  trajectory it returned alongside was exact.
- **L62.** `editor.tick {frames, captureFps}` worked as a Play-Mode settle primitive and was the
  only available workaround for L37.
- **L63.** The final Player carries no serialized ground reference: grounding is a live
  `Physics2D.OverlapBoxNonAlloc` query in the controller, so the measured feel numbers are bound to
  a real collider test rather than to a flag someone could set. Final hierarchy: `Main Camera`,
  `Player [SpriteRenderer, Rigidbody2D, BoxCollider2D, PlayerController, PlayerInputReader]`,
  `Level/Terrain/{Ground, Platform_A, Platform_B}`, `error_count: 0`, play mode stopped, scene
  saved.

---

## Interval 3: mined 2026-07-30, byte range 0 to 1840174 (JSONL lines 0 to 340)

**Source transcript for this interval is a NEW file** (the builder was resumed as a fresh agent):
`/Users/avinash/.claude/projects/-Users-avinash-Projects-AI-loombridge/b1457f72-3c28-433d-9ca8-66162d4a4087/subagents/agent-a2ddc366844afab06.jsonl`
(symlinked as `tasks/a2ddc366844afab06.output`). Offsets below are into that file, not the
interval 1/2 transcript.

Builder status: **running**. Slices approved 5/9: `framing`, `ground-tiling`, `player-feel`,
`parallax`, `collectibles`. Current slice `hazards` (built, runId
`run-hazards-2026-07-30T14-42-44-429Z-fc96e338`, 3 captureManifest entries), spikes and saw placed,
mid-way through flipping the trap textures readable so `scene.get_bounds` can report visible bounds.

What this interval contains: the corrected-band re-measurement of `shortHopApex`, first live
measurement of `dashDistance` / `coyoteTime` / `jumpBuffer`, a 7-metric `feel.json`, the whole
`parallax` slice (build plus 4 hand-assembled evidence files plus the first real non-console
producer this run), the whole `collectibles` slice, and the start of `hazards`. Four `verify`
runs, all green on the first attempt once evidence was complete.

### Answers to the five questions this interval was mined for

1. **shortHopApex re-measurement: in band, gate green, slice advanced.** `feel2.mjs` was re-run
   live (warm-up first, then 3 canonical taps at 120fps pinning). Hops: `1.4132732`, `1.4132732`,
   `1.5303186`; median `1.4133` reported. First `verify --slice player-feel` after the assembler
   ran read `feel=warn` (see L64); after the three missing metrics were measured it read
   `feel=pass feel-provenance=pass physics-timestep=pass console-clean=pass`, `exit=0`,
   `checkpoint=.loombridge-fixtures/player-feel/`. `plan --go` then printed `approved: player-feel`,
   `Roadmap: 3/9`.
2. **dashDistance / coyoteTime / jumpBuffer: all three measured through `runtime.probe` driving the
   controller's input seam.** `runtime.probe`'s missing provenance fields bit again exactly as
   predicted: the builder typed `captureFps: 60` and both timestep numbers as literals into the
   three probe sources and disclosed it in a `seams[]` block (L75). Three genuinely new workaround
   shapes appeared: whole-trajectory delta instead of phase delta for the dash (L91), disabling the
   ground `BoxCollider2D` at a known phase boundary as a deterministic "ledge departure" for coyote
   time, and tick-resolution threshold bisection with the bracket stated in the note.
3. **New slices.** `parallax` (gates coverage, parallax-motion, render-frame, visual-artifacts,
   console-clean) and `collectibles` (reachability, placement, console-clean) both passed on the
   first verify. `capture` produced 1 of 5 and 1 of 3 manifest entries respectively (L65). New gate
   holes found: L78 (dead layer certifies as responsive under a small stimulus), L79, L80, L81.
4. **Moat integrity.** Six hand-assembled evidence files this interval (`feel.json`,
   `parallax-motion.json`, `coverage.json`, `render-frame.json`, `reachability.json`,
   `placement.json`), every one carrying an explicit `_provenance.writer` with a `seams[]` list
   naming which fields the bridge did not supply. Provenance honesty was exemplary. What would let
   fabricated numbers pass is unchanged and now broader: L75, L76, L77, L79, L81.
5. **Injected resume guidance.** Warm-up-first: followed, and it did not do what it was supposed to
   (L90). Explicit `captureFps`: followed for every probe and capture. Expect `CONNECTION_LOST`:
   **wrong for this interval**, zero transport failures occurred (L89); every failure was an
   op-level `INVALID_PARAMS` / `NOT_FOUND`.

### Corrections to earlier findings

- **L49-correction (material).** Interval 2 claimed "an agent that measures nothing it finds hard
  gets the same verdict as one that measures everything" and that `player-feel` "would have gone
  green had shortHopApex been in band". **Both are wrong.** With `shortHopApex` in band and the
  three metrics still unmeasured, `verify` produced verdict status `warn`, printed
  `slice player-feel: warn`, and explicitly refused to advance:
  `slice state NOT flipped (verdict.status is warn, not pass)`. A WARN is not a refusal, but it
  does block slice approval. The remaining defect is narrower than filed: the exit code is still
  `0` (L64), and the gate reports `pass` on the `feel` gate line only after all in-scope metrics
  are measured.
- **L42-update.** The one-tick phase-boundary leak is not specific to `capture_input_motion`: the
  same leak reproduced under `runtime.probe`. See L91.
- **L59-update.** The warm-up convention was followed and moved the outlier rather than removing
  it. See L90.

### Flow friction

- **L64. `verify` exits 0 on a `warn` verdict that does not advance the slice.** The line reads
  `[loombridge verify] slice player-feel: warn → ...verdict.json exit=0` followed by
  `slice state NOT flipped`. Exit 0 is the same code a passing slice returns, so the one signal a
  pipeline can read most reliably cannot distinguish "approved" from "blocked". Compounds L6/L33,
  where `${PIPESTATUS[0]}` came back empty twice and the run was saved only by the printed
  `exit=N`. A third code, or a non-zero exit for warn, would close this.
- **L65. The capture-manifest shortfall is now measured across five slices and is getting worse as
  the slices get richer.** `player-feel` 1 of 2, `parallax` **1 of 5**, `collectibles` 1 of 3, all
  exiting 0 with a single line about `console.json` and no mention of the four (or two) files it
  did not write. `domain/capture-recipes.ts` still maps only `framing | tiles | console`, so every
  gate outside that set is an agent-assembled file by construction. Escalation of L1/L2/L34.
- **L66. The one real non-console evidence producer in the repo is not reachable from the CLI.**
  `analyze-frames` writes `visual-artifacts.json` from real PNG pixels and is exactly the pattern
  the other gates need, but `loombridge analyze-frames --help` answers
  `unknown command "analyze-frames"`. It ships as a separate bin (`loombridge-analyze-frames` in
  `package.json`) and the builder ended up invoking it by absolute path into
  `mcp-server/dist/capabilities/verification/analyze-frames.js`. It is absent from `--help`'s verb
  list, so an agent that had not grepped the repo would never find it and would hand-assemble
  `visual-artifacts.json` too.
- **L67. The `parallax-2d` skill's REQUIRED texture step has no op behind it.** The skill says
  "wrapMode = Repeat REQUIRED" and "filterMode = Point", and
  `asset.set_texture_import_settings` exposes only `texture_type`, `sprite_mode`, `sRGB`,
  `mipmaps`, `readable`, `alpha_source`. The builder set `texture_type: "Default"` and then
  verified the wrap mode by grepping `wrapU:` out of the `.png.meta` on disk. The load-bearing
  setting of the whole technique is unsettable and unverifiable through the bridge.
- **L68. No op touches a Material's tiling or offset, so the skill's own component had to be
  edited.** There is no way to set `mainTextureScale` or read `mainTextureOffset` over the bridge.
  The builder added a `textureScale` field to the skill's shipped `ParallaxLayer.cs` (applied to
  the instance material in `Awake`) purely to have a settable seam, and later added
  `CurrentOffsetX` / `CurrentOffsetY` getters purely so `sampledFields` (scalars only) could read
  the offset the gate grades. Both edits were annotated in the source with the reason. A skill that
  ships a component the platform cannot drive or observe pushes every consumer to fork it.

### Bridge and op gaps

- **L69. TOOLS.md documents an op the installed bridge does not implement, and `doctor --live` was
  green.** `ops.describe` / `unity_ops_describe` is documented at TOOLS.md:1900 with a full schema,
  including the "a typo self-corrects" suggestions feature. The live call returned
  `NOT_FOUND: Unknown ops op: 'describe'`. The project runs
  `com.loomtide.loombridge-0.1.0.tgz` (`Library/PackageCache/com.loomtide.loombridge@701412ef9981`).
  `editor.get_game_view_size` answered `Unknown editor op` as well. This is the repo's own
  "declared path nothing walks" shape between the generated doc and the shipped C# handler set:
  `npm run docs:tools` generates from the TypeScript op registry, and nothing checks that the
  registry's ops exist on the bridge the consumer actually has installed.
- **L70. Two ops address the same field by two different names.** `runtime.probe` drivers resolve
  a **public** member (`NOT_FOUND: No writable public property/field 'm_Enabled' on component
  'BoxCollider2D'`, fixed by passing `enabled`), while `component.set_property` on the same
  component wants the **serialized** name `m_Enabled`. The builder's coyote script ends up using
  both spellings for the same field, one in the driver list and one in the restore helper. The
  refusal named the fix, but the asymmetry is a permanent tax.
- **L71. `runtime.probe` silently ignores `sampledFields`.** The builder passed a valid
  `sampledFields` entry and got `fieldTimeline: null` back on all three trials, with no
  `unresolved` reason, no warning, and no refusal. `capture_input_motion` honors the same parameter
  and returned four full timelines. An unknown parameter dropped in silence is the worst case for a
  measurement harness: the builder only noticed because it printed the field explicitly, and the
  fallback cost it the tick-exact `grounded` signal that coyote/buffer really wanted (both metrics
  are instead derived from the position trajectory with a hand-chosen index offset, which is L76).
- **L72. `asset.list_sub_assets` returns an empty list for sliced sheets that do have sprites.**
  `{ asset_path: "Assets/Art/PixelAdventure/Fruits/Apple.png" }` returned `[]` and
  `Saw_On.png` returned `[]`, yet `asset.assign_sprite` then succeeded with `Apple_0` and, when
  given a wrong name, refused with
  `Sprite 'Saw_On_0' not found ... available sprites: [Saw_0, Saw_1, ... Saw_7]`. The discovery op
  is dead and the refusal path is the only working enumerator. This is the op interval 1 (L11)
  flagged as undiscoverable; it turns out to also be non-functional.
- **L73. `scene.get_bounds` cannot report `visibleBounds` for a non-readable texture, which is the
  exact field the placement gate needs.** Every collectible and hazard came back with
  `visibleBoundsUnavailable: "texture not CPU-readable (enable Read/Write)"`. The omission is
  honest (no fabricated 0), but `placement.groundedItems[].visibleBottomY` is the whole point of
  that gate, so producing placement evidence requires first flipping an importer flag on every
  art asset the level uses. Nothing in the gate, the skill, or `capture` says so.
- **L74. Two parameter-name misses in one slice, both caught by good refusals.**
  `asset.set_renderer_materials` wants `materials`, not `material_paths`
  (`INVALID_PARAMS: Missing required parameter: 'materials'`); `asset.list_sub_assets` wants
  `asset_path`, not `path`. Each cost a full script re-run. The `locator`/`path`/`asset_path`
  naming is inconsistent across the asset family.

### Moat and gate integrity

- **L75. The three metrics `runtime.probe` exclusively owns were certified on provenance fields the
  agent typed.** `assemble2.mjs` defines
  `probeBase = (n) => ({ source: "runtime.probe", sampleCount: n, captureFps: 60,
  measuredAt: now, projectFixedTimestepBeforeMeasurement: DT, measurementFixedTimestep: DT })`
  where `DT = 0.016667` is a module constant. `feel-provenance` passed all seven metric checks off
  those strings. The builder disclosed it precisely, in the file, in a `seams[]` entry stating that
  those three fields "are therefore agent-sourced, not echoed by the probe op". This is L38 landing
  exactly as predicted: `SOURCE_METRIC_OWNERSHIP` names `runtime.probe` sole owner of
  `dashDistance`/`coyoteTime`/`jumpBuffer`, and `validMeasurementSource` demands three fields the
  op does not emit, so the only route to a green is for the agent to supply them.
- **L76. `coyoteTime`'s reported value is a function of an agent-chosen tick-indexing convention
  whose swing is larger than the tolerance band.** The assembler computes
  `elapsedTicks = t.J - t.Tg + 2` with a comment explaining that sample `i` reports the position
  after physics step `i-1` and that a driver set at a phase's first sample index takes effect in
  that same tick. That `+2` yields `coyFire = 6` ticks and `coyoteTime = 0.1000`, dead on the
  target. **With `+0` the same raw trials yield 4 ticks and 0.0667, which fails the `±0.02s` band;
  with `+1`, 0.0833, which barely passes.** One physics tick is 0.0167s against a total band width
  of 0.04s, so the indexing convention alone can move the answer across the pass boundary. No gate
  can audit that convention: the raw trials are in the evidence file, the derivation is prose in a
  `stimulus.method` string, and nothing re-derives the number from the trials. This is the
  strongest single argument this run has produced for the CLI owning the measurement rather than
  the gate grading a scalar.
- **L77. The `jumpBuffer` trial table in `feel.json` is hand-retyped, and half of its trials have no
  raw file on disk.** `assemble2.mjs` contains a literal six-row array
  (`{ W: 200, pressTick: 26, jumped: false }, ...`) transcribed from console output rather than
  read from `raw-buffer2.json`, and the sweep that produced W=250/317 was overwritten by the
  W=200/217/233 re-run, so three of the six trials exist only as retyped numbers. `LAND_TICK = 34`
  is likewise a literal derived from an earlier calibration run. The numbers are real, and the
  provenance note is honest about the method, but the evidence file is one careless copy away from
  being wrong with no way to detect it.
- **L78. `parallax-motion` certifies a completely dead layer as responsive whenever the driven
  displacement is small.** The tolerance is
  `max(absTolerance 0.015, |expected| * relTolerance 0.15)`, and `expected = playerΔ * factor /
  tileWorldSize`. For Sky that is `0.075` per world unit of player motion, so any capture whose
  driven displacement is under **0.2u** produces an expected response smaller than the floor
  tolerance: a layer whose offset never changes at all measures 0 against expected < 0.015 and
  passes. For Hills X (`0.6/16 = 0.0375` per unit) the threshold is **0.4u**. The gate has no
  minimum-stimulus requirement, and the agent chooses the phase durations. This nearly happened by
  accident: the builder's first capture ran the player rightward under `Platform_A`, whose underside
  capped the jump at `0.225u`, and the vertical response check would have passed on that degenerate
  arc (expected 0.0169 versus tolerance 0.015, a 13 percent margin).
- **L79. `parallax-motion` grades measured offsets against agent-declared layer parameters.**
  `factorX`, `factorY`, `tileWorldWidth`, `tileWorldHeight` all come from the evidence file, where
  the assembler wrote them as literals; no check reads the live `ParallaxLayer` component, the
  material, or the texture dimensions. The gate therefore proves internal consistency between two
  agent-supplied quantities, not that the scene realizes the contract's `juice.parallax` factors.
  The contract's `Sky 0.3 / Hills 0.6` are never compared to anything in the scene.
- **L80. The `coverage` gate's continuity check is structurally vacuous for the technique the skill
  mandates.** It exists to catch the `BackdropDrift` world-space teleport (its own doc comment says
  so), but `parallax-2d` replaced that with a static frame-covering quad whose transform never
  moves. Result: `coverage.Sky | 5 samples covered, max excursion 0.00u`. Under the recommended
  component the bounds are constant by construction, so both the exposure check and the continuity
  check are decided at build time and can never fail at capture time. The failure mode the gate was
  written for is now unreachable, and the failure mode the new technique has (a wrong
  `mainTextureScale` producing a stretched or double-sampled tile) is unchecked.
- **L81. `render-frame.json` is agent-measured from images the evidence does not identify.** The
  builder implemented a PNG decoder in `pxassemble.mjs` and computed real
  `edgeBlackFraction` / `contentRect` from real pixels (a border row is one whose every pixel is
  within tolerance 12 of black or of the contract's `#2a1f4d`). Honest work. But the frames live in
  the scratch dir (`frames/spawn.png`, `run.png`, `apex.png`), outside `.loombridge/`, and the
  provenance block records `frameFiles: [{ id, tMs, sha256: null }]`. Nothing binds the three
  numbers to those three images, and the images are not part of the run's evidence. A hand-typed
  `edgeBlackFraction: {top:0,...}` with `contentRect` equal to the full frame passes the gate
  identically and requires no images at all.
- **L82. `reachability` grades against the contract's feel TARGETS, not the measured `feel.json`.**
  The envelope uses `feel.jumpApex?.target ?? 2.2`, `feel.dashDistance?.target ?? 0`,
  `feel.runSpeed?.target ?? 0`, `2 * feel.timeToApex?.target`. A level is therefore certified
  reachable by the numbers the contract wishes for, not the numbers the game was measured to
  produce. Here they agree (the `feel` gate passed), so the coupling is currently harmless, but the
  two artifacts are one slice apart and nothing links them: a later controller change that drifts
  `jumpApex` down would not re-open `collectibles`.
- **L83. Six of the nine evidence files this interval were agent-assembled.** `feel.json`,
  `parallax-motion.json`, `coverage.json`, `render-frame.json`, `reachability.json` and
  `placement.json` all carry `_provenance.writer` naming the agent, the reason
  ("loombridge capture has no recipe for this file"), and a `seams[]` list. Only `console.json`
  (three times) and `visual-artifacts.json` came from a real producer. The moat currently rests on
  the agent choosing to be honest in six of eight cases per slice.

### Wins

- **L84. The builder rejected its own degenerate stimulus without being asked.** After the first
  parallax capture it inspected the trajectory, noticed `peakY 1.7400` and `deltaY 0.225` (the
  player was under `Platform_A`), and re-ran the whole capture leftward to get a real `3.7389`
  apex. The gate would have passed the degenerate capture (L78). This is the honest-or-stop
  disposition again doing work the gate does not require.
- **L85. The assembler asserts the two evidence streams share a tick clock.** `pxassemble.mjs`
  throws `tick clock mismatch on ${id} at ${i}` if any picked `fieldTimeline` sample's `tMs`
  differs from its position sample's `tMs`. That is precisely the binding a gate should be doing,
  written voluntarily by the agent, which is both a good sign and an argument for moving it into
  `feel-rederive` / a real recipe.
- **L86. Every hand-assembled file names its own seams.** `seams[]` entries this interval include
  the missing probe provenance fields, `runtime.probe`'s dropped `sampledFields`, the derived
  (not captured) `cameraFrame`, the missing material-offset op, the leftward-run rationale, and
  "no loombridge capture recipe or op emits render-frame.json". An auditor reading only the
  evidence files learns the entire gap list.
- **L87. Four verifies, four first-try greens, no retry-until-green, no `.loombridge/` hand-edit.**
  `player-feel` (after the band fix and the three added metrics), `parallax` (5 gates),
  `collectibles` (3 gates). The one non-green (`warn`) was answered by measuring the missing
  metrics, not by weakening anything.
- **L88. `plan --go` refused to approve on `warn` and flipped only on `pass`.** The state machine
  behaved correctly at every boundary this interval: 2/9 to 3/9 to 4/9 to 5/9, each preceded by a
  `pass` verdict, each printing the dependency it satisfied
  (`Next unblocked: collectibles (needs ground-tiling ✓, player-feel ✓)`).
- **L89. Zero transport failures.** No `CONNECTION_LOST`, no 1006, across two script-triggered
  domain reloads (`ParallaxLayer.cs` created twice with `if_exists: "replace"`), roughly 40 script
  runs and several play-mode entries. `retryUnity` absorbed nothing because nothing needed
  absorbing. The interval-2 reconnect hardening looks like it either fixed the problem or the
  problem is load-dependent.

### Raw notable events

- **L90.** The warm-up convention was followed and did not do its job. The throwaway warm-up hop
  read the modal `1.41327` with `aft: 6`, and `shortHop1`, the first **graded** trial, was the
  `1.5303` outlier. Warming up moved the outlier into the measured set rather than out of it. Also
  `shortHop3` reported `rft: 6, aft: 7`, an off-canon tap inside the graded set, which
  `SHORT_HOP_TAP_TICK_TOLERANCE = 0` would refuse if the evidence recorded actual ticks (L46).
- **L91.** The phase-boundary tick leak reproduced under `runtime.probe`: the dash phase reported
  `deltaX 1.875` (6 ticks) and the following phase `0.625` (2 ticks), while the whole trajectory
  summed to exactly `2.8125` over 9 consecutive ticks of a constant `0.3125u`. Taking the
  whole-window delta with `moveX` pinned to 0 is the workaround that got the exact value, and the
  builder wrote the reason into the evidence note. L42's "the recipe pressures the builder to
  corrupt the real value" is now closed by technique rather than by a fix.
- **L92.** Two auto-captured error screenshots came back `1024x22` (a 22-pixel-tall image), on
  `asset.set_renderer_materials` and `asset.assign_sprite`. The artifact is being captured from
  something other than the game view for those failures.
- **L93.** Sprite slice names are not filename-derived: `Saw_On.png` exposes `Saw_0` through
  `Saw_7`, and the builder's filename-based guess `Saw_On_0` was refused. `Apple.png` (544x32 at
  PPU 32) exposes `Apple_0`. With L72 (`list_sub_assets` returning `[]`) the only way to learn a
  sheet's slice names is to guess wrong and read the refusal.
- **L94.** A passing `verify --slice` now also prints `checkpoint=.loombridge-fixtures/<slice>/`, a
  directory neither `build` nor `capture` announced and which does not appear in any
  `captureManifest`. Same shape as L26 (`asset-manifest.json`).
- **L95.** `bg-hills.png` is 256x48 with a fully transparent top row and a maximum alpha of 140:
  the builder measured the wrap seam (`col0 vs col255` mean channel delta `2.21` against a typical
  adjacent-column delta of `3.22`) and concluded the art tiles cleanly before building anything.
  Same design-time predictability as L17, now applied to a backdrop.
- **L96.** `component.get_properties` on the Camera in play mode exposes `orthographic size` as a
  display-named property (`"serializedPath": "orthographic size"`, with a space) and returns
  `runtimeProperties: null`. The builder had to regex the properties array to find it, then still
  derived `cameraFrame` by hand (L10 unresolved).

---

## Interval 4 (FINAL): mined 2026-07-30. Two sources.

1. **Builder tail**, `tasks/a2ddc366844afab06.output` byte range **1840174 to 2523994** (JSONL lines
   341 to 478): the `hazards`, `hud` and `juice` slices, and the handoff at 8/9.
2. **Closer**, `tasks/a80e781748ea32828.output` byte range **0 to 1513869** (JSONL lines 0 to 223):
   the `end-state` slice, a played completion, `plan --go` to 9/9, and the full-project
   `loombridge verify` refusal.

Final state: **9/9 approved**, every slice verdict `pass` with exit 0, zero hand-edits of
`.loombridge/`, zero retry-until-green. Bare `loombridge verify` refuses with
`status=harness-fault exit=2` and `loombridge doneness` was never run.

### Cross-check of the builder's 11 tail findings

Already filed, re-evidenced here, no new number: #1 (probe public names vs serialized names) = L70;
#3 (`sampledFields` ignored) = L71; #4 (no material tiling op) = L68; #5 (no `wrapMode`/`filterMode`)
= L67; #9 (installed bridge behind TOOLS.md) = L69; #11 (`assign_sprite` names the valid sprites) =
L93/L22.

New and filed below: #6 (`coverage` grades only declared layers, and the declared `Hills` layer sits
occluded behind the terrain) folds into **L102/L103**'s family and is filed as part of **L108**'s
contract-scope problem; #7 (`manifest` requires a `saw` the hero shot does not contain) = **L108**;
#8 (`props.intentionalFloating` has no entry, so airborne collectibles cannot be listed) = **L100**;
#10 (`ui.get_screen_rects` empty) = **C4**.

**#2 is materially WRONG as stated. See C1.**

### Cross-check of the closer's 8 findings

1. **Unified vs per-slice input dirs: EVIDENCED verbatim, twice** (offsets 371134 and 1245040),
   including the unpiped `EXIT=2`. Filed as L109.
2. **No `ui-conformance` / `playability` capture recipe: EVIDENCED at source.**
   `domain/capture-recipes.ts` still returns only `framing | tiles | console`. Escalation of
   L1/L34/L65; the count is now seven slices, five of which got only `console.json`.
3. **`ui.get_screen_rects` `[]` in play mode: EVIDENCED** at the win state with an active
   Screen-Space-Camera canvas and ten authored uGUI elements on screen. Filed as C4.
4. **Component enable is write-only: EVIDENCED** three ways
   (`component.get_properties` on `PlayerInputReader` returned exactly
   `[["m_Script","PlayerInputReader"]]`; `runtime.get_snapshot` returned `undefined`;
   `component.set_property` on the same field succeeds). Filed as L117, and it is the root cause of
   C1.
5. **`scene.find_object` success-with-`found:false`: EVIDENCED verbatim.** Filed as L119.
6. **`scene.get_transform` missing: EVIDENCED verbatim** (`NOT_FOUND: Unknown scene op:
   'get_transform'`, with an auto-captured error screenshot). Filed as L118.
7. **Contract requires a goal + `SfxPlayer` + six audio cues no slice walks: EVIDENCED at source.**
   Verified directly against the project's `ACCEPTANCE.json`. Filed as L108, and it is the single
   most consequential finding of this interval.
8. **Probe drivers persist across phases and calls: EVIDENCED by consequence.** Filed as L120.

### Corrections to earlier findings

- **C1 (MATERIAL, to the builder's tail finding #2: "a driven property survives exactly ONE physics
  tick per phase boundary").** Wrong as a bridge defect. In the closer's runs a single 600 ms
  `moveX=1` phase produced a continuous 42-sample ramp from x 4.0 to 8.2 at exactly 7.0 u/s, and a
  480 ms jump phase produced a full arc (`phaseMaxY 1.51, 3.74, 3.51`). Every one-tick reading comes
  from `drvtest.mjs`, which never disabled `PlayerInputReader`: the reader writes `moveX` from the
  keyboard every `Update`, so a driver value set once at a phase boundary survives exactly one
  `FixedUpdate` before being zeroed. Every closer script that worked opens with
  `component.set_property PlayerInputReader m_Enabled false`. Residual doubt: `juice2.mjs` did insert
  that disable and still read one tick per phase, and because `m_Enabled` is unreadable (L117)
  nobody could confirm the write landed; `juice3`/`juice4` reverted to repeated 50 ms phases rather
  than retest. **Net: this is not probe tick accounting, it is unobservable contention between a
  driver and a live input component.** The fix direction moves off `RuntimeHandler` phase accounting
  and onto (a) making component enabled state readable, (b) having `runtime.probe` report when a
  driven field's value changed between the driver write and the phase end.
- **C2 (MATERIAL, to L72 "`asset.list_sub_assets` returns an empty list ... the discovery op is
  dead").** Too strong. Here `{ asset_path: ".../Fruits/Collected.png" }` returned `count: 7` with
  `Collected_0..5` plus the Texture2D, and `button-green.png` returned `count: 1`. The op works. The
  `[]` on `Apple.png` and `Saw_On.png` is unexplained and was the case that mattered, so the finding
  survives as **inconsistent / silently empty for some sheets**, not dead.
- **C3 (to L42/L91, the phase-boundary tick leak).** The leak finding stands on the interval-3
  evidence. Do NOT cite the closer's `dx 1.05 over 500 ms` calibration for it: that reading was a
  `Hazard` respawn folded into `deltaX` (L125), which the closer diagnosed and corrected.
- **C4 (to the builder's tail finding #10).** `ui.get_screen_rects` returns `[]` in **play mode**
  too, not only edit mode, with the win modal on screen. Not edit-mode-specific.
- **C5 (to L26/L94).** `.loombridge-fixtures/<slice>/` checkpoints and the per-slice
  `asset-manifest.json` copies now exist for all nine slices, still undeclared in any
  `captureManifest` and still unannounced by `build` or `capture`.
- **C6 (to L6/L33).** Recurred once more: `loombridge verify | tail -60; echo EXIT=$?` printed
  `EXIT=0` for a run that really exited 2. The unpiped re-run gave `EXIT=2`. Three occurrences now.

### Moat and gate integrity

- **L97. The `playability` gate certifies the game is a game on eight fields, seven of which are
  literals the assembler typed.** `es-assemble.mjs` writes
  `completable: true, completionMethod: "played", hazardKills: true, collectibleIncrements: true,
  postWinInputLocked: true, postWinPlayerFrozen: true, restartWorks: true` as hard-coded constants;
  only `winRuleObserved` is read from a real `GameManager` read (`played.final.winRuleObserved`).
  The 14 KB `_provenance.evidence` block (per-leg drives, trajectory samples, GameManager snapshots
  after every leg, the 56-tick post-win lock proof, the lose demo) is **never parsed by any gate**.
  An eight-line hand-typed `playability.json` produces the identical `playability=pass`. This is the
  L15/L45 shape on the gate that answers "is this actually a playable game", which is the whole
  product claim.
- **L98. `completionMethod` is the gate's own anti-teleport control and it is self-declared.**
  `playability.ts` downgrades `completable` to WARN when `completionMethod === "teleported"`, with a
  doc comment explaining that a teleport proves the win logic but not traversal. The value comes out
  of the evidence file. A run that teleports the player onto all three apples and writes `"played"`
  gets a full pass. The one honesty control on the gate runs on the honor system.
- **L99. `prop-semantic` binds a SCRIPT NAME inside an agent-authored file.** The `hazards` slice
  failed `prop-semantic.Spike_1..Saw_1 | scripts=(none)`; the fix was to author `Hazard.cs` and
  attach it, after which the agent's `objects.json` reported `scripts: ["Hazard"]` and the gate
  passed. The gate never touches the scene: an empty `MonoBehaviour` named `Hazard`, or the string
  typed into `objects.json` with no component attached at all, passes identically. The builder's
  `Hazard.cs` is real (trigger, event, respawn) by choice, not by enforcement.
- **L100. The `prop-purpose` population is chosen by the agent.** `objects.json` listed only the four
  hazard props. The three apples were never graded even though `props.purposes` declares a
  `apple|fruit|coin|collectible -> collectible` spec that matches them, and `collectibles`' gate list
  (`reachability, placement, console-clean`) does not include `prop-purpose`. Nothing compares the
  evidence file's object list against the scene, so a prop omitted from the file is a prop that does
  not exist as far as the verdict is concerned. The builder disclosed the scoping decision in
  `_provenance`; no gate required it to.
- **L101. `prop-semantic` is opt-in via a falsy-skip.** `prop-purpose.ts:254` reads
  `if (purposeSpecs.length > 0 || prop.purpose)`. A contract with no `props.purposes` plus a capture
  that omits `purpose` disables the entire semantic tier silently. That is the exact
  `else if (x.field && ...)` anti-pattern CLAUDE.md forbids, sitting at a gate's own opt-in seam.
- **L102. The `juice` slice's contract is 100 percent ungraded.** Its gates are `visual-artifacts`
  and `console-clean`. `ACCEPTANCE.juice` specifies dashTrail (3 ghosts, 52/32/18 percent, 10 px,
  80 ms hold), landingDust (4 particles, ±6 px, 240 ms), fruitPop (6 frames, scale 1.0/1.4/0, 6
  sparkles), hitStop (100 ms, white player flash) and screenShake (4 px, 180 ms, hit-only). Not one
  number is graded. `analyze-frames` returned `0 visual findings`, which is an **absence** check: an
  empty `Juice.cs` producing no ghosts, no dust and no shake yields the same zero findings and the
  same green. The builder implemented every number and verified it by reading screenshots itself.
- **L103. `ui-conformance` grades font, color and presence, and nothing else the HUD contract
  declares.** `hud.elements[]` carries `anchor`, `insetPx: 24`, `format` and `role` per element. The
  score label sits at `anchoredPosition x: 56` and the icon at `x: 20`, neither is the declared 24,
  and nothing checks it. `lives` declares `format: "3 hearts (empty pip on loss)"` with
  `colorRole: hearts`; the build shipped a TMP label reading `LIFE x3` in the correct magenta.
  `presence.lives = present` and `color.LivesLabel = #ff4d8d` both pass and **the heart row does not
  exist**. L3's framing finding, repeated in the HUD contract, on the slice whose entire purpose is
  the HUD.
- **L104. `ui-conformance` cannot distinguish an on-screen element from a disabled one.**
  `ui.scan_text_components` enumerates inactive subtrees, so the `end-state` verdict emitted ten font
  checks including all four `LosePanel` texts while the lose modal was inactive, and the panels were
  re-saved inactive at the end. The op that would establish visibility, `ui.get_screen_rects`,
  returns `[]` (C4). No check binds a "present" HUD element to being rendered.
- **L105. `ui.hudCrispness` grades an agent-typed canvas block.** `ui.scan_text_components` does not
  report the render path, so the `canvas{}` object in `ui-scan.json` is assembled by the agent from
  `component.get_properties`, with `cameraHasPixelPerfect: true` written as a bare assertion. The
  check that exists to catch a HUD blurred through a pixel-perfect upscale RT reads
  `cameraUpscaleRT` out of a file the agent wrote. Done honestly here, and disclosed in `seams[]`.
- **L106. One slice's three evidence files came from three different play sessions, all stamped with
  the same runId, and nothing detects it.** `loombridge capture --slice end-state` wrote
  `console.json` from its own play-enter soak (34 logs) BEFORE the played run; `ui-scan.json` and
  `playability.json` come from the later played run, whose own console had 66 logs and lives only
  inside `playability`'s provenance. `console-clean` therefore certifies a session in which the game
  was never played. `runId` is minted by `build` and is not a play-session identity, so runId
  agreement proves nothing about co-temporality. The CLI's own provenance already carries
  `editorSessionId` + `processId`; nothing cross-checks them across a slice's files. Generalises
  L51.
- **L107. A later slice invalidated an approved earlier slice's evidence and the CLI never reopened
  it.** The `juice` slice widened `/Backdrop/{Sky,Hills}` from 16.4x9.4 to 17.4x10.4 and rewrote both
  `ParallaxLayer.textureScale` values, which are exactly the quantities `parallax-motion` and
  `coverage` grade. `parallax` stayed `approved`. The builder re-captured and re-verified out of
  diligence and got
  `slice parallax: diagnostic (not bound to slice proof) ... slice state NOT flipped`, which is the
  right refusal to re-bind. But nothing says "an approved slice's inputs changed, re-open it":
  `markDependentStale` in `build.ts` only follows declared `dependsOn` edges, and `juice` does not
  declare `parallax`.
- **L108. The contract declares required elements that no slice's gates ever walk, and the project
  reached 9/9 without them.** `manifest.elements` requires a `flag|checkpoint|goal` GameObject and an
  `SfxPlayer` GameObject, both `required: true`; `audio.cues` requires six clips under
  `Assets/Audio/`. `Assets/Audio` does not exist, no goal object exists in the scene, and `manifest`
  is in **no** slice's gate list, so `verify --slice` reported it `not_applicable` nine times out of
  nine. `props.purposes` even carries a `flag|checkpoint|goal -> goal` spec for the object that was
  never built. This is the repo's own "declared path nothing walks" failure lifted to the contract
  level: **nothing validates that the union of the slice plan's gates covers the contract's own
  required sections.** The builder's tail finding #7 (the `saw` the hero shot does not contain) and
  #6 (a declared `Hills` parallax layer that sits occluded behind the terrain) are the same defect
  from the other direction: contract and design target diverge and no gate arbitrates.
- **L109. The full-project door is the only thing that would have caught L108, and it cannot run.**
  Bare `loombridge verify` reads the flat `.loombridge/verify/` while all nine slices' evidence sits
  in `.loombridge/verify/<slice>/`, and refuses:
  `REFUSED: nothing was graded ... status=harness-fault exit=2`. There is no roll-up path and no
  top-level capture recipe. A 9/9 project therefore has a permanently red front door with no legal
  route to green. The closer explicitly refused to copy slice evidence up to make it green, on the
  grounds that it would mix capture vintages and fail `manifest` anyway.
- **L110. `GAME_SPEC.md` is a stale mirror of the contract inside the same project and nothing
  detects it.** `plan` prints `kept (unchanged): .loombridge/ACCEPTANCE.json, .loombridge/GAME_SPEC.md`,
  and the spec still lists `shortHopApex | 0.72 u` while `ACCEPTANCE.json` was corrected to 1.41
  mid-run. L50 is now a two-level problem: fixture-to-project drift AND contract-to-mirror drift
  within one project.

### Flow friction

- **L111. The gate-to-evidence-filename mapping is discoverable only by reading repo source.**
  `prop-purpose`'s input file is `objects.json`. The builder wrote `prop-purpose.json` and got
  `warn | prop-purpose.input | (missing) | No "objects.json" in --inputs; run scene.get_bounds ... Gate not evaluated.`
  The refusal names the file and the ops (excellent), but only after a full capture-and-verify round
  trip, and `capture --help` lists no such row.
- **L112. `loombridge status` ALREADY diffs the capture manifest; `capture` does not.** Status
  printed
  `Warnings: - end-state: missing capture file(s): end-state/ui-scan.json, end-state/playability.json, end-state/console.json`.
  That is precisely the diff L1/L34/L65 asked `capture` to emit. The logic exists in the status
  model and `capture` simply does not call it. This turns R2's largest UX item from a design job
  into a wiring job.
- **L113. A gate whose input file is missing is a WARN, and the run still exits 0.** `hazards` with
  no `objects.json` produced `verdict warn ... exit=0` plus `slice state NOT flipped`. The warn means
  "this gate was never evaluated at all", which is the strongest case yet for the third exit code
  L64 asked for: exit 0 currently covers approved, blocked-on-warn, and never-evaluated.
- **L114. `ui.add_image` silently ignored an undocumented `sprite` parameter and returned success.**
  The builder passed `{ sprite, sprite_name }`; TOOLS.md documents `sprite_path` and no
  `sprite_name`. The op returned `status: "success"` with a locator and rendered a white box. Fixed
  with a follow-up `asset.assign_sprite`. Accepting-and-dropping unknown parameters on a success
  response is the same failure class as L71.
- **L115. `ui.create_canvas { render_mode: "camera" }` leaves `m_Camera` null and plane distance
  100.** The HUD rendered behind the z=10 backdrop and was invisible in the first screenshot. Two
  extra `component.set_property` calls fixed it (`m_Camera` accepts a locator object, plane distance
  1). A canvas op offering a camera render mode should take the camera.
- **L116. A 100 ms gameplay burst is shorter than an MCP round trip, and the only way to see it was
  to slow the game down.** To confirm the `fruitPop` burst existed the closer set
  `FruitPop.secondsPerFrame` from 1/60 to 0.2 (12x) in play mode and screenshotted mid-flight.
  `runtime.capture_sequence`'s `atMs` triggers can land inside a burst, but there is no "capture N
  consecutive frames at the physics rate around event X" primitive, so verifying short-lived juice
  requires mutating the thing being verified.

### Bridge and op gaps

- **L117. Component enabled state is write-only over the bridge.**
  `component.set_property {property_path: "m_Enabled", value: false}` succeeds, but
  `component.get_properties` on `PlayerInputReader` returns exactly `[["m_Script","PlayerInputReader"]]`
  and `runtime.get_snapshot` returns `undefined` for the same field; `SpriteRenderer` omits it too.
  An agent that disables a component to own an input seam cannot read back whether it worked. This
  is the defect that made C1's misdiagnosis possible and cost the juice slice a whole workaround
  architecture.
- **L118. `scene.get_transform` does not exist while `scene.set_transform` does.**
  `NOT_FOUND: Unknown scene op: 'get_transform'`, with an auto-captured error screenshot. Reading a
  position requires `scene.get_bounds` or `runtime.get_snapshot`. Asymmetric verb pair; both
  builders hit it.
- **L119. `scene.find_object` returns `status: "success"` with `data: { found: false, locator: null }`.**
  The obvious idempotency guard (`if (r.status !== "success" || !r.data) create()`) skips creation
  because `data` is truthy. Cost one build round trip: `es-build1.mjs` logged "apple ready" three
  times while the hierarchy had zero `Pop` objects. The shape is honest; the ergonomics invite the
  bug.
- **L120. `runtime.probe` drivers persist across phases AND across MCP calls under
  `resetDriversOnEnd: false`.** A left-over `moveX = 1` kept the player running through the ~200 ms
  inter-call gap, walked it off Platform_A's right edge onto `Spike_3`, and folded a hazard respawn
  into the next phase's `deltaX`. The working pattern is an explicit zeroing STOP phase terminating
  every probe. Recording the mitigation as well as the defect.

### Wins

- **L121. The unified door refused correctly at the very end of a 9/9 run and said exactly why.**
  `REFUSED: nothing was graded. No gate consumed a captured input ... a verdict that measured nothing
  is NOT a pass; STATE was left untouched`, then `status=harness-fault exit=2`. Harness fault in its
  own exit tier, never a pass and never a game bug, is the CLAUDE.md invariant holding under maximum
  incentive to fudge, and the closer refused to hand-populate the flat directory to satisfy it.
- **L122. The played completion is the strongest evidence this run produced and no gate reads a byte
  of it.** Every leg drove `PlayerController.moveX`/`jumpHeld` through the same seam
  `PlayerInputReader` writes, with the reader disabled so the controller's `FixedUpdate`, ground
  probe, coyote/buffer logic and collisions ran unmodified. No `scene.set_transform` during the
  completion (the only teleport is the game's own hazard respawn). The restart used the real R key
  through `input.begin_session` + `input.key_tap` (`tapped: true`, restartCount 1 to 2, all three
  `Collectible.collected` back to false). The post-win lock was proven by 56 sampled ticks of driven
  input producing bit-identical x and y (13.0016737 / 5.514982). The level was completed twice by
  the same route. The jump geometry was solved from measured collider AABBs rather than guessed.
  Every bit of it lives in `_provenance.evidence`, which is exactly where a re-derivation gate should
  be reading from.
- **L123. The state machine held to the end.** `hazards` went warn (missing input) to fail
  (prop-semantic) to pass, and only the pass flipped it; `plan --go` printed
  `approved: end-state` then `Roadmap: 9/9 approved` then `all slices are approved; ask the agent to
  certify done`. Nine slices, zero `.loombridge/` hand-edits, zero retry-until-green, one honest
  `finished-blocked` handoff in between.

### Raw notable events

- **L124.** Duplicate check ids in a verdict: `end-state`'s `ui-conformance` emitted `font.Text`
  twice, because both button labels are named `Text`. Any consumer keying checks by id collides.
- **L125.** `Hazard.cs` teleports the player to a hardcoded `respawnPoint = (6.4, 1.5)` on contact.
  During calibration this folded a 2.6 u game-authored teleport into a probe's `deltaX` and produced
  a 1.05 u reading for a 500 ms run phase, which looked exactly like a bridge defect until the
  closer traced it. A game's own teleports are indistinguishable from harness teleports in
  trajectory evidence.
- **L126.** The two `generated` UI assets (`button-green.png`, `button-blue.png`, PIL-produced,
  `status: approved` in `ASSET_MANIFEST.json` with full provenance) shipped as
  `texture_type: Default` with zero Sprite sub-assets and had to be reimported as `Sprite/single`
  before `ui.add_image` could use them. An asset approved in the manifest for a role is not
  necessarily importable as the type that role implies.

---

## Consolidated route map (FINAL, all findings L1 to L126)

Five work items. Every finding L1 through L126 is assigned to exactly one.

**Re-balance decision.** R2 and R3 both grow, as expected, and one more change was warranted:
**R4 is no longer "UX friction only".** It now carries two items that can produce a wrong or
uncertifiable verdict, L107 (an approved slice whose evidence a later slice invalidated, with no
re-open path) and L109 (the project-level door that cannot be satisfied at 9/9), so its severity is
raised to "UX friction plus a certification-path gap". R1 loses one sub-item to correction C1: the
`runtime.probe` phase-accounting fix is retired and replaced by a readable-enabled-state fix in R5.
R2 is now the largest item and the highest-severity one, because `playability.json` is the same
agent-authored shape as `feel.json` on the gate that decides whether the artifact is a game at all.

### R1. Feel evidence has no producer and no binding: the CLI must measure it, and the gates must re-derive it

**Problem.** The most self-grading-prone measurement artifact, `feel.json`, is written by the agent,
and every field its three gates read is a literal the agent typed, including the canonical-tap tick
count the tap-shopping gate exists to pin, and the derivation conventions whose swing exceeds the
tolerance bands.

**Covers (26):** L30, L36, L38, L39, L40, L41, L42, L45, L46, L47, L48, L49, L51, L55, L58, L59,
L60, L61, L63, L71, L75, L76, L77, L85, L90, L91.

**Affected source.**
- `mcp-server/src/capabilities/verification/capture.ts` + `capture-runner.ts` +
  `domain/capture-recipes.ts`: a `feel` recipe that drives the runtime ops and writes `feel.json`
  itself, stamping `captureFps`, `sampleCount`, `actualFixedTicks` and both timestep fields **from
  the op response**, never from a caller constant.
- `mcp-server/src/domain/feel-primitives.ts`: `validMeasurementSource` and `checkShortHopStimulus`
  must bind to bridge-reported values (`stimulus.actualFixedTicks`), and `SOURCE_METRIC_OWNERSHIP`
  must not name an op that cannot emit the required provenance.
- `capabilities/verification/gates/physics-timestep.ts`: re-derive the real cadence from
  `sampleCount / durationMs` and fail on mismatch; fix the misleading `expected` label.
- `capabilities/verification/gates/feel.ts`: "(not measured)" must refuse, not warn.
- `capabilities/genre/genre-packs/platformer-2d/slices.json`: add `feel-rederive` to `player-feel`
  (already registered in `run-gates.ts` against the same file).
- `packages/com.loomtide.loombridge/Editor/Handlers/RuntimeHandler.cs`: emit `captureFps` and both
  timestep fields from `runtime.probe`; honor `sampledFields` on `probe` or refuse it; expose a
  settable runtime velocity; exact phase-boundary tick accounting.
- Ship a reference `PlayerController` with the pack.

**Severity: MOAT HOLE.** L45 + L46 + L48 means a fabricated `feel.json` passes every gate the slice
runs. L76 shows a single agent-chosen indexing convention moving a metric across the pass boundary.

### R2. Hard gates fed by agent-authored evidence, and capture manifests no recipe writes

**Problem.** `build` mints a `captureManifest`, `capture` writes a subset and exits 0 without naming
the difference, and the unwritten files are hard-gate evidence the agent then hand-assembles. Across
nine slices, five got only `console.json` from the CLI. The gates then read scalars, booleans and
name strings out of those files without re-deriving anything from the scene.

**Covers (29):** L1, L2, L10, L15, L16, L20, L26, L34, L65, L66, L73, L78, L79, L80, L81, L83, L84,
L86, L94, L97, L98, L99, L100, L101, L104, L105, L106, L111, L122.

**Affected source.**
- `capabilities/verification/capture.ts` + `domain/capture-recipes.ts`: `captureKindForSlice` still
  returns only `framing | tiles | console`. Add recipes for `ui-scan` (mechanical: one op verbatim
  plus two `component.get_properties` reads), `placement`/`objects`, `playability`, `parallax-motion`,
  `coverage`, `render-frame`. Diff the manifest against what was written and say so (the diff
  already exists in the status model, see R4/L112).
- `capabilities/verification/run-gates.ts`: the `{gate, file, op}` table is the authority. Every
  entry whose `op` reads "(assembled)" is a declared path nothing walks. Also expose the
  gate-to-filename mapping in `capture --help` (L111).
- `capabilities/verification/gates/playability.ts`: `completable`, `hazardKills`,
  `collectibleIncrements`, `postWinInputLocked`, `postWinPlayerFrozen`, `restartWorks` must be
  re-derived from a recorded drive log (positions, GameManager field reads, op names) rather than
  read as booleans; `completionMethod` must be inferred from whether the log contains a
  `scene.set_transform`, not self-declared.
- `capabilities/verification/gates/prop-purpose.ts`: bind `scripts[]` to a live `component.list`
  rather than a string in the file; compare the file's prop list against the scene so an omitted
  prop is a refusal; remove the `purposeSpecs.length > 0 || prop.purpose` falsy-skip (L101).
- `capabilities/verification/gates/ui-conformance.ts`: `canvas{}` must come from a producer, not the
  agent (L105); bind presence to on-screen visibility once `ui.get_screen_rects` works (L104).
- `capabilities/verification/gates/{parallax-motion,coverage,render-frame,placement}.ts`: require a
  minimum stimulus (L78), read layer factors from the live component (L79), bind frames by sha256 to
  files inside `.loombridge/` (L81).
- Provenance: cross-check `editorSessionId`/`processId` across a slice's evidence files so three
  different play sessions cannot share one runId (L106).
- `analyze-frames` must be reachable from the CLI verb list (L66); it is the one real non-console
  producer and the pattern the others need.
- Bridge: an op returning the camera world-frame rectangle (L10); `visibleBounds` without requiring
  a CPU-readable texture, or a capture-time refusal that says so (L73).

**Severity: MOAT HOLE, now the largest.** L97 + L98 mean an eight-line hand-typed file certifies the
game as completable and played. L99 + L100 mean a prop's gameplay role is a name string in a list the
agent chooses. L20, L84, L86 and L122 show the correct pattern already exists and that the agent did
the honest work voluntarily, which makes this a completion job, not a design question.

### R3. Declared-but-ungraded contract content, and contracts that drift from their own derivatives

**Problem.** The schema forces authors to declare fields and required elements that no check binds,
whole contract sections have no gate at all, and corrected values do not propagate to the artifacts
authors actually read.

**Covers (13):** L3, L17, L18, L28, L50, L56, L57, L82, L95, L102, L103, L108, L110.

**Affected source.**
- `capabilities/verification/gates/framing.ts`: no reference to `backgroundColorHex` or
  `verticalPan`; `aspect`, `nativeResolution` and `pixelScale` are ungraded (L3, L28).
- `capabilities/verification/gates/ui-conformance.ts`: `hud.elements[].anchor`, `insetPx`, `format`
  and `role` are ungraded, so a text label satisfies a declared heart row (L103).
- **No gate reads `ACCEPTANCE.juice` at all** (L102). Either grade the juice numbers (ghost count,
  dust particles, hit-stop duration, shake amplitude are all observable through
  `runtime.capture_sequence` + `sampledFields`) or stop declaring them as contract.
- `capabilities/verification/acceptance.schema.json` + `slices.ts`: **validate that the union of the
  slice plan's gates covers the contract's required sections.** `manifest.elements` demanded a goal
  GameObject and an `SfxPlayer`, `audio.cues` demanded six clips under a directory that does not
  exist, and a 9/9 approval was reachable without any of them (L108). This is the single highest-
  leverage new guard in the file.
- `plan`'s `GAME_SPEC.md` writer: regenerate or refuse when the mirror diverges from the contract
  (L110); and `__tests__/fixtures/design-briefs/trailer-demo-concept.md` versus
  `capabilities/verification/tiderunner.acceptance.json` for the 0.72-versus-1.41 divergence (L50).
- `gates/reachability.ts`: grades against the contract's feel TARGETS, not the measured `feel.json`
  (L82).
- `gates/console-clean.ts`: grades the capture window, not the construction that preceded it (L18).

**Severity: MOAT HOLE.** The repo's own "declared path nothing walks" failure mode, located inside
the verification layer and now demonstrated at three levels: field (L3, L103), section (L102), and
contract-versus-plan (L108). L17 and L95 (gates fully predictable from source art) belong to the same
"what does the gate actually bind" review at lower severity.

### R4. CLI state, verdict shape, exit reporting, and the project-level door

**Problem.** The human-readable state file understates the run, the verdict JSON is mostly
not-applicable noise, `status` does not name a failing gate, exit 0 covers three different outcomes,
an approved slice is never re-opened when a later slice invalidates its evidence, and the unified
front door cannot be satisfied by a fully approved project.

**Covers (20):** L4, L5, L6, L19, L21, L23, L32, L33, L52, L53, L54, L64, L87, L88, L107, L109,
L112, L113, L121, L123.

**Affected source.**
- `capabilities/verification/verify.ts`: a **roll-up path from `.loombridge/verify/<slice>/` into the
  project door**, or an explicit doneness route that consumes the nine slice verdicts. Today the
  refusal is correct and there is no legal way to answer it (L109). Also the not-applicable stanza
  per unrelated gate (L5) and the `exit=N` affordance that repeatedly saved the run (L6, L33, C6),
  which should extend to `capture`.
- Exit codes: a distinct code for `warn` and for `gate-not-evaluated`, so exit 0 stops meaning
  approved, blocked, and never-measured at once (L64, L113).
- `capabilities/verification/status.ts` + `status-model.ts`: it already diffs the capture manifest
  (L112) and should lend that to `capture`; it should also name a failing gate (L32).
- `capabilities/verification/build.ts` (`markDependentStale`) + `slices.ts`: re-open an approved
  slice whose evidence inputs changed, not just its declared `dependsOn` descendants (L107).
- `slices.ts` + the `STATE.md` writer: `phase: built-unverified, lastVerdict: null` after nine
  approved slices (L4).

**Severity: UX friction PLUS a certification-path gap** (raised from "UX friction only"). L107 lets
an approved verdict describe a scene that no longer exists; L109 leaves a finished project with no
route to a green front door. Everything else here costs reading time. L19, L21, L23, L52, L53, L54,
L87, L88, L121, L123 are the wins to preserve while changing the surrounding output.

### R5. The agent-facing surface: MCP-first driving, transport resilience, and bridge defects

**Problem.** With the MCP server unavailable the whole run went through ~40 hand-written node scripts
that reinvented reconnect policy, discovery was `sed` over a 1964-line doc, and a dozen small op
defects each cost a workaround, one of which cost a wrong root-cause diagnosis.

**Covers (38):** L7, L8, L9, L11, L12, L13, L14, L22, L24, L25, L27, L29, L31, L35, L37, L43, L44,
L62, L67, L68, L69, L70, L72, L74, L89, L92, L93, L96, L114, L115, L116, L117, L118, L119, L120,
L124, L125, L126.

**Affected source.**
- `surfaces/mcp`: the op list and schemas belong in context; screenshots belong inline as image
  results (L9, L13, L14, L44).
- `bridge/unity-client.ts`: reconnect and backoff are the client's job, not `lib.mjs`'s; add a "last
  finished compile result" query for the post-reload race (L8, L43).
- `packages/com.loomtide.loombridge/Editor/Handlers/*`:
  - **make component enabled state readable** (L117), the single highest-value bridge fix here
    because C1 shows an unreadable `m_Enabled` produced a wrong published root cause;
  - `scene.get_transform` (L118); `scene.find_object` `found:false` ergonomics (L119);
  - refuse unknown parameters instead of dropping them silently (`ui.add_image` L114, and L71's
    `sampledFields` on `probe`);
  - `ui.get_screen_rects` returning `[]` in both editor modes (C4);
  - `ui.create_canvas` should take the render camera (L115);
  - material `mainTextureScale`/`Offset` and texture `wrapMode`/`filterMode` ops (L67, L68);
  - one spelling per property across `component.set_property` and probe drivers (L70);
  - `asset.list_sub_assets` inconsistency (L72, C2) and the `locator`/`path`/`asset_path` naming
    drift (L74);
  - `Rigidbody2D` velocity settable (L37); enum display-name aliases (L7); a project-settings op so
    L30 stops requiring an authored editor script; error-screenshot source for UI-op failures (L92).
- `runtime.probe`/`capture_sequence`: document and ideally warn on cross-call driver persistence
  (L120); a "capture N consecutive frames at the physics rate around event X" primitive for
  sub-round-trip juice (L116); duplicate check ids from same-named UI children (L124).
- `mcp-server/TOOLS.md` + `npm run docs:tools`: the content is good, the access path is not, and it
  documents ops the shipped bridge lacks (L69).
- Agent-runtime plumbing for long captures (L31) and background research agents (L27, L35: two of
  two never delivered).

**Severity: UX friction, with a set of real bridge defects inside it.** None can produce a false
green on its own. L117 is the exception worth prioritising: it did not fake a verdict, it faked a
diagnosis.
