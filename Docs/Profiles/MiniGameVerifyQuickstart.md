# Mini-Game Release Check — Quickstart (for developers)

**Status:** S8 — developer-owned setup flow (2026-06-17)
**Audience:** a studio shipping 2D kids mini-games who wants an automated release check in CI.
**You do not need to know Loombridge internals to use this.** This page is the whole contract.

Loombridge gives you one command that looks at a mini-game build and answers a single question:

> **Is this screen-by-screen build safe to ship?** — are the controls on-screen, inside the safe area,
> big enough to tap, the flow reaching its reward — and does it still match the version you approved?

It is a **read-only check**. It never changes your game, scenes, assets, or project settings. The only
command that writes anything into *your* space is the explicit `baseline approve` step, and that writes a
reference snapshot into a folder you choose — never into your game.

---

## Start here: derive → demonstrate → check (recommended)

**If you're setting up your own Unity mini-game for the first time, use this path.** It lets Loombridge
*derive* the contract from your live scene instead of asking you to author it, establishes the flow from one
demonstration, and runs the whole release check from one command. The older step-by-step flow further down
(`setup → record → capture → finalize → verify`) still works and is good for inspecting each stage — but the
three verbs here (`scan`, `sync`, `check`) are the developer-owned front door.

Open your game in the Unity editor first, with the Loombridge bridge connected. Then:

```bash
# One drift-aware command. On the FIRST run (no contract yet) it scans the scene,
# writes a DRAFT contract, and stops so you can review it + record a demonstration.
loombridge minigame check --scene Assets/Scenes/MyGame.unity
```

What each verb does:

- **`minigame scan` — derive the contract from the live scene.** It opens the scene, looks at the *visible*
  UI (tappable controls via their raycast targets, text labels, backgrounds) and proposes a draft contract:
  candidate `requiredInFrame` objects, candidate states, and the per-screen bindings. It writes a draft (to
  `--output`, or stdout) — **a proposal you review and edit, never a silent binding.** It refuses to emit a
  draft that would verify *no* real objects. `check` runs this for you on the first run.

  ```bash
  loombridge minigame scan --scene Assets/Scenes/MyGame.unity --id my-game -o my-game.minigame.json
  # add --trace <demo-id> to order the proposed screens from a recorded demonstration
  ```

- **Demonstration — establish the flow / state ordering.** Play your happy path once and let the observer
  record it. The demonstration is what fixes the *order* of screens (and feeds capture + role binding later):

  ```bash
  loombridge trace record --observe --flat \
    --id my-game-happy-path \
    --scene Assets/Scenes/MyGame.unity \
    --root ~/.loombridge/projects/my-game \
    --auto-state-signal
  ```

  `--auto-state-signal` makes the observer detect each scene's state signal live and gate
  every recorded gesture on it, so capture later waits for the game to be CONSUMABLE, not
  merely for a target to be visible (a gesture racing an activation animation stalls the
  whole flow otherwise). The guided flows (`minigame run` / `check` / `next`) add this
  automatically whenever the contract declares no explicit `stateSignal`; a declared
  `stateSignal` takes precedence.

  Re-running `scan` with `--trace` (pointed at the workspace where you recorded) will order the proposed
  states from this demonstration:

  ```bash
  loombridge minigame scan --scene Assets/Scenes/MyGame.unity --id my-game \
    --trace my-game-happy-path --trace-root ~/.loombridge/projects/my-game \
    -o my-game.minigame.json
  ```

  `--trace-root` must point at the `--root` you recorded the demonstration into; without it `scan` looks for
  the trace under the current directory and fails if it isn't there.

- **`minigame check` — the one drift-aware command.** Re-run it once you have a draft + a demonstration. It
  guards structural drift first: it **stops** (exit 0, with guidance and no release report) when a *bound*
  object moved or vanished — it never auto-rewrites your contract to make a run go green. New, *unbound*
  controls it found are reported as informational and don't block (a contract may legitimately bind a subset
  of the scene). When there's no blocking drift it delegates to the full `capture → finalize → verify` loop
  (the same `minigame run` pipeline documented below) and emits the single release report with the usual
  `READY` / `NOT READY` / `CAN'T VERIFY` result and exit code.

  ```bash
  loombridge minigame check --scene Assets/Scenes/MyGame.unity --id my-game
  ```

- **`minigame sync` — handle scene drift over time.** When your scene changes (objects renamed, moved, added,
  removed), `sync` re-scans and shows a structural diff against the saved contract: `present` / `relocated`
  (a unique same-name path moved — proposes the new locator) / `removed` / `added`. It is **dry-run by
  default** — it prints the proposal and changes nothing. Apply only what you confirm:

  ```bash
  loombridge minigame sync --scene Assets/Scenes/MyGame.unity --id my-game          # show the diff
  loombridge minigame sync --scene Assets/Scenes/MyGame.unity --id my-game --apply  # write safe relocations
  #   add --add to adopt new controls, --remove to drop missing refs (both opt-in)
  ```

  `sync` refuses a removal that would leave a state with no bound objects. It re-scans *structure*; visual
  drift (a screen that looks different) stays a separate tier handled by the approved **baseline** (below).

### What this flow guarantees (the trust model)

These hold for `scan` / `sync` / `check` exactly as they do for the lower-level flow:

- **Derived data feeds the contract, never the verdict.** Everything `scan`/`sync` propose is a draft you
  confirm. The deterministic `verify --minigame` gates, the exit codes, and the report are unchanged — the
  CLI owns the ship/no-ship call.
- **Structural drift stops the run; it is not auto-fixed.** A bound object that moved or disappeared halts
  `check` for your review. A same-name relocation is only a *proposal* (`sync --apply` writes it after you
  see it) — `check` never silently rebinds.
- **Missing capture/evidence is never green.** A screen that wasn't reached/captured reports as
  `CAN'T VERIFY` (exit 2) in its own "couldn't be tested — fix the test setup, not the game" section, never
  as a pass and never as a game bug.
- **Eyeball / VLM judgment is advisory only.** It is never part of the deterministic pass/fail.

> **Outcome-gated games** (the win is behind correct answers / RNG / skill a read-only replay can't drive —
> CountFruits, chef, …): `scan` and `check` do **not** accept a `--gated-outcome` flag. Declare it one of two
> ways: **(a)** in the scan draft, set `"outcomeGated": true` on the post-win states (`success_reward`,
> `home_back`) before you run `check`; or **(b)** author the contract through the lower-level
> `minigame setup --gated-outcome` (or `minigame run --gated-outcome`) path, which marks those states for you.
> Either way the gated screens report as *not asserted — outcome-gated* (never a failure) while the verifiable
> screens (start, active) are still graded fully. Some games also expose a per-state `reached` condition (e.g.
> a phase field) so capture waits for the right screen instead of duplicating a frame; an unreached state is
> then honestly `CAN'T VERIFY`.

---

## One command (the whole flow)

> `minigame check` (above) is the recommended front door when you start from your own scene — it adds the
> drift guard and contract derivation on top of `minigame run`. Use `minigame run` directly when you already
> have a confirmed contract and just want to drive the pipeline without the scan/sync guard.

If you'd rather not run the steps one at a time, `minigame run` drives the entire pipeline —
setup (if needed) → record → capture → finalize → verify — with a single command.

You don't need to know the flags. Run it bare and it **asks for each value, one at a time** (the
same prompts as `minigame setup` — game id, Unity project, scene, device shape, gated outcome):

```bash
loombridge minigame run
```

Or pass what you already know as flags (anything omitted is still prompted on the first run):

```bash
loombridge minigame run \
  --id my-game \
  --project /path/to/UnityProject \
  --scene Assets/Scenes/MyGame.unity \
  --visual-profile phone-landscape \
  --gated-outcome          # if the win/return is RNG- or skill-gated
```

It pauses for the one inherently-interactive step — **record**, where you play the happy path in
Unity and press Enter — then continues automatically. It is **resumable**: re-run the same command
(just `--id my-game` is enough once set up) and it picks up from wherever it stopped. It stops at a
verdict so you stay in control:

- **NOT READY** → it prints the report + the next command; fix the findings, then re-run.
- **READY** → it stops at "approve the baseline to finish" (blessing the reference screens is your
  sign-off, not an auto-step — run `minigame baseline approve` when you're happy with them).

`minigame run` is just the guided `minigame next` state machine, executed. The step-by-step path
below is the same flow run one command at a time — use it when you want to inspect each stage.

## Step-by-step local run

This is the lower-level flow that `minigame check` and `minigame run` drive for you. Use it when you want to
inspect or run each stage yourself, or to understand what the one-command path does. It keeps the Unity
project clean by putting all generated Loombridge files under `~/.loombridge/projects/<game-id>`.

> Authoring the contract by hand with `minigame setup` / `minigame init` still works, but for a new game the
> recommended start is `minigame scan` (derive a draft from the scene) — see
> [Start here](#start-here-derive--demonstrate--check-recommended) above.

### 0. Confirm the CLI

```bash
loombridge --version
```

If this says `unknown command "--version"` or shows an old commit, rebuild/reinstall the CLI before continuing
(see [MiniGameVerifyCI.md](MiniGameVerifyCI.md) for packaging details):

```bash
cd /path/to/Loombridge/mcp-server
npm ci
npm run build
alias loombridge="node /path/to/Loombridge/mcp-server/dist/surfaces/cli.js"
hash -r
loombridge --version
```

### 1. Run guided setup

Interactive:

```bash
loombridge minigame setup
```

Scriptable:

```bash
loombridge minigame setup \
  --id count-the-fruits \
  --project /path/to/UnityProject \
  --scene Assets/Scenes/CountTheFruits.unity \
  --visual-profile phone-portrait \
  --workspace ~/.loombridge/projects/count-the-fruits \
  --gated-outcome   # the win is behind correct answers / RNG a replay can't drive
```

`setup` asks for the game id, Unity project, scene, and device shape — and, interactively,
**whether the win/reward is gated by gameplay outcome** (correct answers, RNG, skill) that an
automated read-only replay can't reproduce. Answer yes (or pass `--gated-outcome`) and the
win + return screens are marked **outcome-gated**: a read-only verifier won't assert them
(capture skips them, finalize doesn't need their roles, and verify reports them as
*not asserted — outcome-gated*, never a failure). The verifiable screens (start, active) are
still graded fully. CountTheFruits re-randomizes the answer each round, so it's gated.

It creates:

```text
~/.loombridge/projects/<game-id>/
  <game-id>.minigame.json
  traces/      the recorded happy-path trace
  captures/    the capture pack (per-screen PNG + ui-rects + console)
  reports/     verify + replay reports
  baseline/    approved baselines
  raw/
```

Everything for a game lives **flat under one project folder** — no nested `.loombridge/`, no separate replay
root. The trace verbs use `--flat --root <workspace>` so their artifacts land in `traces/` and `reports/`
alongside the rest.

### Shared verification workspace

`~/.loombridge/projects/<game-id>/` is the standard external workspace for generated Loombridge verification
artifacts. Mini-game visual/release verification uses the flat files above; existing-game feel verification
uses a `feel/` subtree in the same workspace:

```text
~/.loombridge/projects/<game-id>/
  <game-id>.minigame.json
  traces/
  captures/
  reports/
  baseline/
  raw/
  feel/
    capture-contract.json
    profile-measurements.json
    capture-artifacts/
    reports/
      feel-profile.json
```

Keep generated verification artifacts outside the Unity repository by default. The only files that should
land under `Docs/Profiles/artifacts/` are explicit, user-chosen archives or anonymized proof bundles.

Then it prints the next commands with your chosen paths.

### 2. Record and replay the happy path

Run the two commands printed by setup. They will look like:

```bash
loombridge trace record \
  --observe --flat \
  --id count-the-fruits-happy-path \
  --scene Assets/Scenes/CountTheFruits.unity \
  --root ~/.loombridge/projects/count-the-fruits

loombridge trace replay \
  --flat \
  --id count-the-fruits-happy-path \
  --root ~/.loombridge/projects/count-the-fruits
```

The `--flat` flag writes the trace to `…/count-the-fruits/traces/` and the replay report to
`…/count-the-fruits/reports/` — directly under the project folder.

During `trace record`, play the flow normally in Unity, then press Enter in the terminal. `trace replay`
confirms Loombridge can drive the recorded flow again. This is a sanity check before capture; it does not
replace the capture pack.

### 3. Capture the screens

Drive your recorded happy-path trace through the live bridge and let Loombridge write the capture pack for you
(the Unity editor must be open on the game, with the bridge connected):

```bash
loombridge minigame capture \
  --contract ~/.loombridge/projects/count-the-fruits/count-the-fruits.minigame.json \
  --trace-root ~/.loombridge/projects/count-the-fruits \
  --captures ~/.loombridge/projects/count-the-fruits/captures
```

It replays the trace (reset → taps/drags/world-taps → waits) and, at trace-anchored checkpoints, snapshots
each named screen's triple plus the flow evidence, into `~/.loombridge/projects/<game-id>/captures/`:

```text
start.png   start.ui-rects.json   start.console.json
active.png  active.ui-rects.json  active.console.json
success_reward.* …    home_back.* …    flow.json
```

**How states are detected (auto from the trace):** `start` = before the first tap; `active` = after it;
`success_reward` = just before the Home/Back tap (or at the end if there isn't one); `home_back` = after the
Home/Back tap. It is **read-only on the game** (only screenshots/introspects; never mutates the project) and
writes only into `--captures`.

**Honest about gaps:** a screen your recording never reaches is reported as *not captured* (e.g. `home_back`
if your trace never taps Home) — never faked. Record a flow that reaches it, or drop that state from the
contract. A screen that isn't captured shows up as `CAN'T VERIFY` in step 5, never a pass.

> `--id` defaults to `<game-id>-happy-path` (the trace setup told you to record). Pass `--id` to capture a
> different trace, and `--settle <ms>` to wait longer for animations before each screenshot (default 500).

### 4. Finalize the contract from the real captures

The contract `setup` generated is a **draft** with placeholder locators. Don't hand-edit it — run `finalize`
to replace the placeholders with the **real** scene objects observed in the capture pack:

```bash
loombridge minigame finalize \
  --contract ~/.loombridge/projects/count-the-fruits/count-the-fruits.minigame.json \
  --captures ~/.loombridge/projects/count-the-fruits/captures \
  --trace-root ~/.loombridge/projects/count-the-fruits
```

`finalize` reads each screen's `ui-rects.json` (real object paths / roles / text / visibility) — and, when
`--trace-root` is given, the first observed replay click — and infers which real object plays each role: the
start control, the home/back control, the active play area, and the reward object. It rewrites
`requiredInFrame` and each state's bindings to those real objects (binding an object only on screens where it
is actually visible), then writes the finalized contract back **in place** (or to `--output <path>`).

It is **honest-or-refuse**: it never emits a placeholder or invented locator. It **refuses with exit 2** (and
names what's missing) when the capture pack is missing, a declared screen wasn't captured, or a role can't be
inferred with confidence — fix the capture (or add a clearly-named control), then re-run. It also refuses if
the draft carries advanced contract fields it doesn't infer (`allowedOffscreen`, `containers`,
`baseline.masks`): remove them, or finalize that contract by hand. No VLM; deterministic heuristics only.

> `finalize` writes only the contract in your workspace. It never touches the Unity project and adds no gates
> — `verify` (next) still makes the actual ship/no-ship call.

### 5. Run release verification

Run the verify command printed by setup. It will look like:

```bash
loombridge verify --minigame \
  --contract ~/.loombridge/projects/count-the-fruits/count-the-fruits.minigame.json \
  --captures ~/.loombridge/projects/count-the-fruits/captures \
  --output ~/.loombridge/projects/count-the-fruits/reports/minigame-verification.json \
  --strict
```

Open the generated report:

```text
~/.loombridge/projects/<game-id>/reports/minigame-verification.html
```

### 6. Approve the baseline once green

Only approve after verify exits `0` / `READY`:

```bash
loombridge minigame baseline approve \
  --contract ~/.loombridge/projects/count-the-fruits/count-the-fruits.minigame.json \
  --captures ~/.loombridge/projects/count-the-fruits/captures \
  --ref ~/.loombridge/projects/count-the-fruits/baseline
```

Then re-run `verify --minigame` once. Future runs will report visual/layout drift separately from game bugs.

### Setup behavior worth knowing

- **Workspace default** is `~/.loombridge/projects/<id>` — under your home, **never inside the Unity
  project**, so running `setup` from the project folder can't drop artifacts into the game repo.
  Override with `--workspace`; a `--workspace` that points *inside* the Unity project is refused.
- **Interactive only on a TTY.** In CI / non-interactive shells, any missing required value
  (`--id`, `--project`, `--scene`, `--visual-profile`) is a clean **exit 2** with
  usage — it never hangs waiting for a prompt. So **CI uses the low-level commands below**, not
  `setup`.
- **Exit codes:** `0` scaffolded · `2` usage / missing required value in a non-TTY / contract
  already exists without `--force` / workspace inside the project · `1` filesystem/runtime error.

`setup` is a **guided wrapper, not a different verifier.** It only gathers inputs, creates the workspace, and
writes the contract using the same scaffold as `minigame init`. It runs no gates, changes no game, and does
not touch the verifier engine.

---

## Low-level command reference

```bash
# 1. Advanced/manual path — scaffold a contract file directly.
loombridge minigame init --id count-the-fruits --output count-the-fruits.minigame.json

# 2. Capture the game's screens (start / active / reward / home) into a folder.
#    `loombridge minigame capture` drives the running game once (replaying your demonstration)
#    and saves a screenshot + layout for each screen. See step 3 of the guided flow above.

# 3. Run the release check. Read-only. Writes a report you can open.
loombridge verify --minigame --contract count-the-fruits.minigame.json --captures ./captures/count-the-fruits

# 4. The FIRST time it's green — freeze this as the approved look, so future runs catch drift.
loombridge minigame baseline approve --contract count-the-fruits.minigame.json --captures ./captures/count-the-fruits
```

Power users and CI can run the underlying commands directly. They are the same commands that `setup` prints.
After baseline approval, every later `verify` run also tells you if the look **drifted** from what you
approved — kept separate from real bugs, so an intended redesign is never reported as a defect.

---

## Advanced Step 1 — describe your game (`minigame init`)

```bash
loombridge minigame init --id <kebab-case-id> --output <path>.minigame.json
```

This is the low-level path behind `minigame setup`. Most first-time users should run `setup` and follow the
printed commands instead. Use `init` directly when you already know you want to hand-author or script the
contract fields:

- **`scenes`** — the Unity scene(s) the game lives in.
- **`ageBand`** — `2-4`, `3-5`, `5-7`, or `8-12`. This sets how big tap targets must be.
- **`visualProfile`** — the screen shape: `phone-portrait`, `phone-landscape`, `tablet-portrait`,
  `tablet-landscape`.
- **`requiredInFrame`** — the named objects that must be visible (each with a `locator` path into your scene).
- **`states`** — the screens to check (`start`, `active`, `success_reward`, `home_back`) and which required
  objects must be visible on each.
- **`interactionFlow.happyPath`** — the order a player moves through those screens.

The starter is already valid, but its locators are placeholders. Rather than hand-editing them, capture the
screens and run **`loombridge minigame finalize`** (see the guided flow above) to fill in real locators from the
observed scene. If you do edit by hand and get a field wrong, `verify` tells you exactly which field and why —
it never guesses.

> The `--id` must be lowercase-kebab (letters, digits, hyphens; starts with a letter). Without `--output`
> the contract prints to stdout so you can pipe it. `init` will not overwrite an existing file unless you
> pass `--force`.

## Step 2 — capture the screens

The check grades a **capture pack**: a folder with, for each screen, a screenshot and a layout snapshot:

```
captures/count-the-fruits/
  start.png   start.ui-rects.json   start.console.json
  active.png  active.ui-rects.json  active.console.json
  success_reward.png  …
  home_back.png       …
  flow.json            # records that each screen was reached by a real tap (for the flow check)
```

**`loombridge minigame capture` produces this pack for you** (see [step 3](#3-capture-the-screens) of the
guided flow): with the Unity editor open on your game and the bridge connected, it replays your recorded
demonstration and snapshots each named screen (screenshot + UI layout + console + `flow.json`). The
`minigame check` / `minigame run` front doors call it as part of the pipeline. (You can still build a pack
by hand in an agent session through the editor bridge if you need to — the gate engine only consumes the
folder.)

What matters for the check: **a screen that isn't captured is reported as "couldn't test" — never as a passing
or a failing game.** A missing screenshot never silently becomes a green.

## Step 3 — run the check (`verify --minigame`)

```bash
loombridge verify --minigame --contract <contract>.minigame.json --captures <captures-dir> [--strict]
```

It writes, next to the report, three files:

- **`minigame-verification.html`** — a one-screen human report you can open in a browser (see below).
- **`minigame-verification.md`** — the same summary as plain text, handy for a PR comment.
- **`minigame-verification.json`** — the full machine record (every check, exact numbers) for audit/tooling.

`--strict` treats soft warnings as hard failures (recommended in CI). It is **read-only** — it never touches
your game.

## Step 4 — approve the baseline (once green)

```bash
loombridge minigame baseline approve --contract <contract>.minigame.json --captures <captures-dir> [--ref <dir>]
```

This freezes the current (passing) capture pack as the approved reference. It **refuses to approve a run that
isn't green** — you can't bless a broken build. From then on, `verify` also flags any **visual drift** from
this reference. When you *intend* a redesign, just run `baseline approve` again to re-bless it.

`loombridge minigame baseline status --contract <c>` prints what's currently approved (read-only).

---

## What the report says (exit codes)

The check ends in one of three results. **In CI, treat any non-zero as "do not ship"** — but the *reason*
differs, and so does what you do about it:

| Result | Exit | Meaning | What to do |
|---|---|---|---|
| **READY** | `0` | Every screen that was tested passed. | Ship. |
| **NOT READY** | `1` | A real problem: a control off-screen / too small / clipped, the flow not reaching its reward, **or** the look drifted from the approved baseline. | Fix the game/art — **or**, if the visual change was intended, re-approve the baseline. |
| **CAN'T VERIFY** | `2` | The build wasn't honestly tested: a screen wasn't captured, or the tap that should move between screens didn't actually fire. | Fix the **capture / test setup**, then re-run. **Don't change game code on a `2`** — nothing said the game is wrong. |

Three principles this guarantees, and that the report never blurs:

1. **A test-setup gap is never reported as a game bug.** A missing capture or a tap that didn't fire is
   `CAN'T VERIFY` (exit 2) — it lives in its own "couldn't be tested" section, never under "must fix."
2. **A look-changed is never reported as a bug.** Drift from the approved baseline is its own result with its
   own fix ("review, re-approve if intended"), separate from real defects.
3. **A missing input is never a silent pass.** No captures, no screens, or nothing to grade ⇒ `CAN'T
   VERIFY`, never `READY`.

### The human report (`.html` / `.md`)

```
Count the Fruits — RELEASE CHECK: ❌ NOT READY
Tested 4 screens · 12 checks · flow 3/3 · baseline: approved 2026-06-07

⛔ Must fix before release (1)
   • The "Start" button is off-screen on the START screen.            [start screen thumbnail]

🔁 Looks different from the approved version (1) — not a bug; re-approve if intended
   • The REWARD screen changed 5% from the approved look.

⚠️ Couldn't be tested (1) — fix the test setup, not the game
   • The HOME screen was never captured.

✅ Passed: required objects visible · safe area · tap-target size · game flow (3/3)

Next: move the "Start" button back on-screen, then re-run.
```

---

## CI usage

One job, exit-code driven:

```bash
loombridge verify --minigame \
  --contract "$CONTRACT" \
  --captures "$CAPTURES" \
  --strict
# 0 → ship · 1 → fix the game (or re-approve a baseline) · 2 → fix the capture/test setup
```

Upload `minigame-verification.html` + `minigame-verification.json` as build artifacts so reviewers can open
the report. Surface the 1-vs-2 distinction in the job summary so a "couldn't test" never reads as a game bug.

**Full CI guide + a copy-paste GitHub Actions workflow:** [`MiniGameVerifyCI.md`](MiniGameVerifyCI.md) — how
to install `loombridge` on a runner (no `~/.claude`), `loombridge --version` to catch a stale runtime, artifact
upload, and the exit-code handling.

---

## Appendix — plain-language mapping (what the report calls things)

The report speaks in product terms, not check ids. This is the mapping it uses (the raw check id stays in the
JSON for tooling):

| Check (internal) | What the report says when it fails |
|---|---|
| `required-in-frame` | The **&lt;object&gt;** is off-screen or hidden. |
| `safe-area` | The **&lt;object&gt;** sits outside the safe area (could be cut off by the device frame). |
| `tap-target-size` | The **&lt;object&gt;** is too small to tap comfortably for this age group. |
| `text-clipping` | Text on the **&lt;object&gt;** is clipped / cut off. |
| `control-overlap` | The **&lt;object&gt;** overlaps another control. |
| `background-fit` | The background behind the **&lt;object&gt;** doesn't cover its content. |
| `no-black-bars` | The screen shows black bars / empty edges. |
| `render-frame` | The screen doesn't fill the frame correctly. |
| `console-clean` | The game logged runtime errors on this screen. |
| `interaction-flow` (`game_fail`) | The game flow stalled — it never reached the **&lt;screen&gt;** screen. |
| `interaction-flow` (`harness_fault` / capture absent) | This screen **couldn't be tested** — fix the test setup, **not** the game. |
| baseline drift | The **&lt;screen&gt;** screen **looks different** from the approved version — not a bug; re-approve if intended. |

The split that matters: the first nine + `game_fail` and **baseline drift** are about the *game*; the
`harness_fault` / capture-absent row is about the *test setup*. The report keeps those in separate sections,
and the exit code keeps them apart (`1` vs `2`) — by design.
