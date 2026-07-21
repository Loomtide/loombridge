# Mini-Game Release Check in CI (for developers)

**Status:** S7c — partner-facing CI guide (2026-06-07)
**Companion to:** [`MiniGameVerifyQuickstart.md`](MiniGameVerifyQuickstart.md) (the four-verb flow).
**Example workflow:** [`examples/minigame-verify.github-actions.yml`](examples/minigame-verify.github-actions.yml).

This page is everything you need to run `loombridge verify --minigame` on a CI runner: how to install
`loombridge` without the agent surface, how to confirm which build you're running, the one CI command, how to
upload the report, and what the exit codes mean to a pipeline.

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
node "$PWD/dist/cli.js" --version
```

Wrap it in a shell alias / step so the rest of the pipeline can call `loombridge`:

```bash
echo "alias loombridge='node $PWD/dist/cli.js'"     # or add a wrapper to $PATH
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

## 3. Produce the capture pack

`verify --minigame` grades a **capture pack** — a folder with, per screen, `<screen>.png` +
`<screen>.ui-rects.json` + `<screen>.console.json`, plus a `flow.json` (see the Quickstart). Producing it
requires driving the game in the Unity editor through the Loombridge bridge: `loombridge minigame capture`
replays a recorded demonstration and snapshots each screen (and the `minigame check` / `minigame run` front
doors call it as part of the pipeline — see the Quickstart's [developer-owned `scan`/`sync`/`check`
flow](MiniGameVerifyQuickstart.md#start-here-derive--demonstrate--check-recommended)). That capture step
needs a Unity-equipped machine; on a headless CI runner you have two realistic options:

- **Recorded pack (simplest):** capture once locally (per the capture runbook), commit the pack to the repo,
  and have CI re-grade it against the contract on every change. Good for catching contract/threshold drift and
  for PR review of the report; it does **not** re-capture the live build.
- **Live capture on a Unity-equipped runner:** a self-hosted runner (or a `game-ci`-style job) with the editor
  + bridge produces the pack in a prior step, then CI grades it. This is the full release check.

The example workflow marks this step clearly so you can wire whichever fits.

## 4. The CI command

```bash
WORKSPACE="${LOOMBRIDGE_WORKSPACE:-$HOME/.loombridge/projects/$GAME_ID}"
REPORT_JSON="$WORKSPACE/reports/minigame-verification.json"

loombridge verify --minigame \
  --contract "$CONTRACT" \
  --captures "$CAPTURES" \
  --output "$REPORT_JSON" \
  --strict
```

- **`--strict`** is recommended in CI — it treats soft warnings as hard failures (all-green to ship).
- It is **read-only**; it never mutates your game. It writes three files next to the report path
  (normally `~/.loombridge/projects/<id>/reports/minigame-verification.{json,html,md}` via
  `--output`; omitted `--output` uses the legacy root-local report path).

## 5. Upload the report artifacts

Always upload (even on failure) so reviewers can open the report:

- **`minigame-verification.html`** — the one-screen human report (inline thumbnails; open in a browser).
- **`minigame-verification.md`** — the same summary as text (drop into a PR comment).
- **`minigame-verification.json`** — the full machine record (every check + exact numbers) for tooling/audit.

See the `actions/upload-artifact` step (with `if: always()`) in the example workflow.

## 6. Exit codes in CI language

`verify --minigame` returns one of three codes. **Any non-zero means "do not ship"** — but the *reason* and
the *owner* differ, so surface the distinction in the job summary rather than a generic "build failed":

| Exit | Banner | CI meaning | Who fixes it |
|---|---|---|---|
| **0** | `READY` | All tested screens passed. | — ship. |
| **1** | `NOT READY` | A **game/asset defect** (control off-screen / too small / clipped, flow didn't reach its reward) **or** a **baseline drift**. | The **game** team — fix it; or, if the visual change was intended, re-approve the baseline (`loombridge minigame baseline approve`). |
| **2** | `CAN'T VERIFY` | The build **wasn't honestly tested** — a screen wasn't captured, or a tap didn't fire. | The **test setup** — fix the capture/harness and re-run. **Do not touch game code on a `2`.** |

A `2` is never a game verdict: the report keeps capture/harness gaps in their own "couldn't be tested"
section, never under "must fix". Treat `1` and `2` as distinct pipeline outcomes (e.g. route a `2` to the QA
infra owner, a `1` to the game team).

Bash pattern (don't let `set -e` swallow the code):

```bash
set +e
loombridge verify --minigame --contract "$CONTRACT" --captures "$CAPTURES" --strict
CODE=$?
set -e
case "$CODE" in
  0) echo "READY — ship." ;;
  1) echo "NOT READY — fix the game (or re-approve the baseline if the change was intended)." ;;
  2) echo "CAN'T VERIFY — fix the capture/test setup, not the game." ;;
esac
exit "$CODE"
```

---

See the [example GitHub Actions workflow](examples/minigame-verify.github-actions.yml) for all of this wired
together: install + `--version` guard → capture (placeholder) → `verify --strict` → artifact upload → an
exit-code-aware job summary.
