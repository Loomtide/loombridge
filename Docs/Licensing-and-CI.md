# Unity licensing and CI

Loombridge is built around a fact of life for small teams: **the Unity license lives on
the developer's machine, and CI usually has none.** The verification architecture treats
that as a design constraint, not a limitation to apologize for. There are three tiers,
and most teams only ever need the first two.

## Tier 1: local development (Unity Personal, nothing to configure)

Everything Loombridge does locally runs under the license your open editor already uses:

- `loombridge tests run` (headless batchmode) and your open editor share one activation
  on one machine. Unity permits this; the only contention is per-project, and the CLI
  refuses to spawn against a project whose editor is already open
  (`Temp/UnityLockfile`).
- Live verification (`verify --live`, `trace replay`, `trace record --observe`,
  `feel snapshot capture`) attaches to your already-running, already-licensed editor
  over the local bridge. No second seat, no extra activation.

If you are a solo developer or a small team on Unity Personal, there is no licensing
problem anywhere in the local loop.

## Tier 2: CI with ZERO Unity licenses (the recommended default)

The producer/consumer split exists for this tier: **evidence is produced where the
license lives, and graded where it does not.**

1. A developer runs `loombridge tests run` locally. The stamped trio
   (`test-results.xml`, `test-results-manifest.json`, `test-run.log`) lands in
   `.loombridge/tests/`, which is a COMMITTED directory by design.
2. The trio is bound: sha256 of the results and log, the assembly list, the editor that
   ran, the command line, the build `runId` when one was in flight, and a PORTABLE
   project binding (the git repository identity plus the project's path inside it), so
   the same repository checked out at any path on any machine can grade it, while a trio
   copied from a different repository refuses.
3. CI checks out the repo and grades OFFLINE, with no Unity install at all:

   ```yaml
   - run: loombridge tests grade --results .loombridge/tests/test-results.xml
   ```

   The grade takes well under a second, applies the full tier mapping (real failures
   exit 1; compile errors, mutations, cancelled or hollow runs exit 2), and refuses
   tampered, edited, or foreign evidence. Under `GITHUB_ACTIONS` the stamped-pair green
   is quotable.

The same pattern covers the acceptance-contract and design-target anchors (committed by
default) and, for teams willing to pay the repository size, trace pixel baselines (under
`.loombridge/replays/`, ignored by default; opt in via git LFS if you want them graded
in CI).

**The honest trade:** CI grades what was produced; it cannot re-produce. If code changes
land without a fresh local run, CI is grading yesterday's stamped results. That fact is
visible rather than hidden: the manifest's `finishedAt` is printed, and when a build is
in flight the `runId` scoping refuses results stamped under a different build. Teams that
need CI-executed runs move to tier 3.

## Tier 3: CI that runs Unity itself (Personal works, with ceremony)

Unity Personal licenses are usable in CI for Personal-eligible teams, via the manual
activation flow the GameCI project documents: generate an activation request on the
runner, activate it at Unity's license portal, and store the resulting `.ulf` as the
`UNITY_LICENSE` repository secret. Loombridge's EditMode workflow is gated on that
secret: with it absent, the Unity jobs SKIP loudly (they never fake a green); with it
present, the workflow runs the suite and grades the artifacts with the same
`tests grade` mapping CI uses in tier 2.

Known friction, stated plainly: the activation file occasionally needs regenerating, and
Unity's licensing service has transient failures (a `Licensing ... 505` that self-heals
was observed live during Loombridge's own validation). The workflow's skip-not-fail
posture exists so that flakiness never converts into a false red or a silent green.

## Which tier should you use?

| Situation | Tier |
|---|---|
| Solo dev or small team, Unity Personal | 1 + 2 |
| Team wants every PR to re-run the suite in CI | 3 (plus 2 as the fallback) |
| No git remote, no CI | 1 only; everything still works locally |

The rule of thumb: start at tier 2. It costs nothing, needs no secrets, and the binding
manifests are what make locally-produced evidence trustworthy elsewhere; move to tier 3
only when stale-evidence risk actually bites.
