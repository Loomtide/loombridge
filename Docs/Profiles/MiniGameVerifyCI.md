# Mini-Game Release Check in CI (for developers)

**Status:** partner-facing CI guide (updated 2026-08-11)
**Companion to:** [`MiniGameVerifyQuickstart.md`](MiniGameVerifyQuickstart.md) (the four-verb flow).
**Example workflow:** [`examples/minigame-verify.github-actions.yml`](examples/minigame-verify.github-actions.yml).

This page is everything you need to run the Loombridge release check on a CI runner: how to install
`loombridge` without the agent surface, how to confirm which build you're running, the one CI command, how to
upload the report, and what the exit codes mean to a pipeline.

> **The check has to be anchored, or it is not a check.** `loombridge minigame finalize` derives a screen
> contract's real locators and states *from* a capture pack, so grading that contract against that pack is
> circular: both halves come from the same session, and nothing a human approved is in the loop. The frozen
> third thing is the **approved layout baseline** that `loombridge minigame baseline approve` writes. The
> unified `verify` door refuses to run the screens section without one, and refuses to exit `0` for a run in
> which nothing human-approved was compared.
>
> `loombridge verify --minigame --contract <c> --captures <p>` is a **deprecated alias** that does not enforce
> that rule: it compares against a baseline only if the contract happens to declare `baseline.ref`, and grades
> green with no anchor at all otherwise. **Do not use it in CI.** Earlier revisions of this page and of the
> example workflow did; that was the bug this revision fixes.

---

## 1. Install `loombridge` on a runner (no `~/.claude`)

The local install script (`scripts/loombridge-install-locally.sh`) sets up the *agent* surface — slash
commands and skills under `~/.claude`, a frozen runtime under `~/.loombridge`. **CI does not want any of that.**
Install just the CLI, two ways:

**A. Build from a pinned checkout (recommended for CI).** Reproducible and ref-pinned:

```bash
git clone https://github.com/Loomtide/loombridge loombridge
cd loombridge && git checkout <PINNED_SHA_OR_TAG>
cd mcp-server && npm ci && npm run build
# invoke directly — no global install, no ~/.claude:
node "$PWD/dist/surfaces/cli.js" --version
```

Wrap it in a shell alias / step so the rest of the pipeline can call `loombridge`:

```bash
echo "alias loombridge='node $PWD/dist/surfaces/cli.js'"     # or add a wrapper to $PATH
```

**B. Packaged CLI (`npm pack` → install the tarball).** A portable, self-contained artifact — hand a partner
the `.tgz`, no repo checkout needed on the target, still no `~/.claude`:

```bash
cd mcp-server && npm ci && npm pack          # -> loombridge-cli-<version>.tgz
                                             #    (prepack builds dist + packs the bundled bridge tarball)
npm i -g ./loombridge-cli-<version>.tgz        # installs the `loombridge` bin + pulls runtime deps
loombridge --version
```

(Or `npm link` from `mcp-server` on a dev box — same `loombridge` bin, no install.) The installed `loombridge`
runs the same code path as the packed tarball; `loombridge --version` confirms the build either way.

> **Node:** `>= 18`. The CLI itself (contract validation, gate engine, report rendering) is pure Node — it
> needs **no Unity** to *grade* a capture pack. Unity + the bridge are only needed to *produce* the capture
> pack (see §3).

## 2. Confirm the build — `loombridge --version` (stale-runtime guard)

```bash
$ loombridge --version
loombridge 0.1.0 (a1b2c3d, built 2026-06-07T16:01:17.458Z)
```

Print this in CI **before** verifying. It reports the **exact build** you're running — version + the git
commit and build time the binary was compiled from (`+dirty` if the tree had uncommitted changes; `(dev)` if
built without git). This is the guard against the most common footgun: a `loombridge` that execs a **frozen,
stale** runtime (a local global install does NOT update on `git pull` — only re-running the install/build
does). If `--version` doesn't match the commit you expect, your runner is stale — rebuild/reinstall.

## 3. The anchor bundle, and what a headless runner can prove

The screens section grades three things that live together in one **workspace** directory:

```
<workspace>/<id>.minigame.json     the screen contract
<workspace>/captures/              per screen: <screen>.png, <screen>.ui-rects.json,
                                   <screen>.console.json, plus flow.json
<workspace>/baseline/              the APPROVED layout baseline, including
                                   baseline-manifest.json
```

The default workspace is `~/.loombridge/projects/<id>/`. Producing the captures means driving the game in the
Unity editor through the Loombridge bridge (`loombridge minigame capture`, or the `minigame check` / `minigame
run` front doors; see the Quickstart's [developer-owned `scan`/`sync`/`check`
flow](MiniGameVerifyQuickstart.md#start-here-derive--demonstrate--check-recommended)). Once that run is a
PASS, `loombridge minigame baseline approve` freezes it as the approved baseline. **That approval is the
anchor**; everything after it is deterministic re-grading.

Grading needs no Unity. So a headless runner can do a real, anchored check, but only of the evidence you give
it:

- **Anchored re-check (headless, every PR).** Commit the whole bundle to the repo, restore it on the runner,
  and run `verify`. This catches a contract edit, a threshold edit, a deleted or foreign anchor, and anchor
  rot, and it **refuses** (exit `2`) when no human-approved anchor is present. It does **not** re-capture the
  build in the PR, so its green says nothing about how the current code renders.
- **Live release check (Unity-equipped runner).** A self-hosted runner (or a `game-ci`-style job) with the
  editor + bridge re-captures **this** build into the workspace, then grades those fresh captures against the
  same approved anchors. This is the only job whose green is a statement about the code in the PR.

The example workflow ships both, with the second gated on a runner label you supply, so its absence is visible
in the checks list rather than silently implied by the first.

**Committing the bundle is portable.** `baseline approve` stamps the manifest with the project's git origin
and its path inside the repo, so a committed bundle grades correctly on any checkout at any absolute path. A
bundle stamped for a different repository is refused, not silently accepted.

## 4. The CI command

`verify` refuses a `--workspace` inside the project (a workspace there would write verification artifacts into
the game repo), so CI restores the committed bundle to a directory outside the checkout:

```bash
ANCHORS=verification/screens                       # wherever you committed the bundle
cp -R "$ANCHORS" "$RUNNER_TEMP/loombridge-workspace"

loombridge verify --strict \
  --root "$GITHUB_WORKSPACE" \
  --workspace "$RUNNER_TEMP/loombridge-workspace"
```

- Bare `verify` is the **front door**: it discovers every verification asset the project has, prints the plan,
  runs the offline ones, and writes one roll-up. Add `--only screens` to narrow it. A scoped run is reported
  as `partial` and is never a certificate, which is the honest label for a subset.
- **`--strict`** is recommended in CI: it treats soft warnings as hard failures (all-green to ship).
- It is **read-only** with respect to your game. It writes only under `.loombridge/reports/`.
- When project-local anchors land ([`Docs/Design/ArtifactStorage.md`](../Design/ArtifactStorage.md), stage S2)
  the `cp -R` and the `--workspace` flag are the single edit: delete both.

> **There is no `LOOMBRIDGE_WORKSPACE` environment variable.** An earlier revision of this page showed one.
> No source file has ever read it, so setting it did nothing. `--workspace <dir>` is the real knob, and it is
> the same flag every workspace-aware verb takes.

## 5. Upload the report artifacts

Always upload (even on failure) so reviewers can open the report. The unified door writes into
`.loombridge/reports/` under the project root:

- **`verify.json`**: the run roll-up, every section, its status, and whether it was anchored.
- **`verify-screens.json`** / **`.html`** / **`.md`**: the screens section in full, every check with exact
  numbers, the one-screen human report with inline thumbnails, and the same summary as text for a PR comment.
- **`verify-scoped.json`**: written instead of `verify.json` when you pass `--only`.

Uploading the whole `.loombridge/reports/` directory (with `if: always()`) is simplest; see the
`actions/upload-artifact` step in the example workflow.

## 6. Exit codes in CI language

`verify` returns one of three codes. **Any non-zero means "do not ship"**, but the *reason* and the *owner*
differ, so surface the distinction in the job summary rather than a generic "build failed":

| Exit | Banner | CI meaning | Who fixes it |
|---|---|---|---|
| **0** | `READY` | Every executed section passed, and at least one compared something a human approved. | Ship. |
| **1** | `NOT READY` | A **game/asset defect** (control off-screen / too small / clipped, flow didn't reach its reward) **or** a **baseline drift**. | The **game** team — fix it; or, if the visual change was intended, re-approve the baseline (`loombridge minigame baseline approve`). |
| **2** | `CAN'T VERIFY` | The build **wasn't honestly tested**: a screen wasn't captured, a tap didn't fire, an asset is broken, **or nothing human-approved was compared**. | The **test setup / the anchors**: fix the evidence and re-run. **Do not touch game code on a `2`.** |

A `2` is never a game verdict: the report keeps capture/harness gaps in their own "couldn't be tested"
section, never under "must fix". Treat `1` and `2` as distinct pipeline outcomes (e.g. route a `2` to the QA
infra owner, a `1` to the game team).

The zero-anchored case is worth calling out on its own: a run whose sections all passed but where **none** of
them compared a frozen human approval exits `2`, not `0`, and prints *"nothing human-approved was compared; a
self-produced green cannot exit 0"*. That is the rule the deprecated `--minigame` alias does not have.

Bash pattern (don't let `set -e` swallow the code):

```bash
set +e
loombridge verify --strict --root "$GITHUB_WORKSPACE" --workspace "$RUNNER_TEMP/loombridge-workspace"
CODE=$?
set -e
case "$CODE" in
  0) echo "READY — ship." ;;
  1) echo "NOT READY — fix the game (or re-approve the baseline if the change was intended)." ;;
  2) echo "CAN'T VERIFY: fix the evidence/anchors, not the game." ;;
esac
exit "$CODE"
```

---

See the [example GitHub Actions workflow](examples/minigame-verify.github-actions.yml) for all of this wired
together: install + `--version` guard → restore the approved anchors → `verify --strict` → artifact upload →
an exit-code-aware job summary, plus the Unity-runner job the headless one cannot replace.
