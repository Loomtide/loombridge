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
- Live verification (`verify --live`, `trace replay`, `trace record`,
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
   project binding (the git repository identity plus the project's path inside it).
   Remote SPELLINGS of one repo converge (an ssh clone locally and the https checkout CI
   writes are the same identity), so the same repository checked out at any path on any
   machine grades the trio, while a trio from a different repository refuses. Honest
   scope, stated plainly: this is anti-accident provenance, not anti-forgery (the
   manifest is editable text, as the absolute path before it was); sibling clones of one
   TEMPLATE repository share the template's origin until `git remote set-url` runs; and
   a repo with no remote at all has no portable identity (evidence stays bound to the
   producing machine until a remote exists; the refusal names the re-stamp command).
3. CI checks out the repo and grades OFFLINE, with no Unity install at all:

   ```yaml
   - run: loombridge tests grade --results .loombridge/tests/test-results.xml
   ```

   The grade takes well under a second and applies the full tier mapping (real failures
   exit 1; compile errors, mutations, cancelled or hollow runs exit 2), refusing
   tampered, edited, or foreign evidence by its recorded bindings. A stamped, binding
   pair is quotable anywhere; `GITHUB_ACTIONS` additionally lets an UNSTAMPED
   runner-produced XML exit 0, as an env-claimed attestation the output labels as such.

The same pattern covers the acceptance-contract and design-target anchors (committed by
default). Trace pixel baselines are different: replay grading is LIVE by nature (it
re-drives the editor), so it always needs a licensed editor and never runs in a
license-less CI; the baselines under `.loombridge/run/replays/` are ignored by default and
committing them buys review visibility, not CI grading.

**The honest trade:** CI grades what was produced; it cannot re-produce. If code changes
land without a fresh local run, CI is grading yesterday's stamped results. That fact is
visible rather than hidden: the manifest's `finishedAt` is printed, and the full
`loombridge verify` door refuses results not scoped to the build in flight (`runId`);
`tests grade` itself does not read build STATE. Teams that need CI-executed runs move to
tier 3.

## Tier 3: CI that runs Unity itself (Personal works, with ceremony)

Per Unity's own licensing terms (verify against your edition and revenue tier), Personal
licenses are usable in CI for Personal-eligible teams, via the manual
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
