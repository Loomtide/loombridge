<!--
Title should follow conventional commits, e.g. `fix(bridge): ...`, `feat(cli): ...`, `docs: ...`.
-->

## What & why

<!-- What does this change and what problem does it solve? Link any related issue (Fixes #NN). -->

## How it was verified

<!-- Real evidence: commands run + output, a failing-then-passing test, live-editor exercise for C#. -->

## Checklist

- [ ] Tests added/updated and `npm run ci` is green (from `mcp-server/`)
- [ ] Docs updated (`README.md` / `Docs/` / `mcp-server/TOOLS.md` regenerated via `npm run docs:tools` if the op surface changed)
- [ ] EditMode tests noted if C# in the bridge package changed (headless batchmode or live editor)
- [ ] Every commit is DCO signed off (`git commit -s` — see [CONTRIBUTING.md](../blob/main/CONTRIBUTING.md#developer-certificate-of-origin-dco))
- [ ] Change respects the declared [non-goals](../blob/main/README.md#roadmap--non-goals) (no arbitrary code-exec op, no telemetry, no cloud requirement)
