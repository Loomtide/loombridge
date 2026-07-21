# Contributing to Loombridge

Thanks for helping build Loombridge. This guide covers how to get set up, run the suite,
and land a change.

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

## Developer Certificate of Origin (DCO)

Loombridge uses the **Developer Certificate of Origin** — a lightweight sign-off, **not a
CLA**. You certify you wrote the change (or have the right to submit it under the project's
Apache-2.0 license) by adding a `Signed-off-by` line to every commit:

```bash
git commit -s -m "fix(bridge): ..."
```

`-s` appends `Signed-off-by: Your Name <your@email>` using your `git config user.name` /
`user.email`. The full DCO text is at <https://developercertificate.org>. Amend an existing
commit with `git commit --amend -s`; sign off a range with `git rebase --signoff <base>`.

## Getting set up

```bash
git clone https://github.com/Loomtide/loombridge.git
cd loombridge/mcp-server
npm ci
npm run build
```

To run **unreleased CLI changes** as `loombridge` on your PATH, link the dev bin (it
follows every `npm run build`):

```bash
cd mcp-server && npm link      # `loombridge --version` then shows your local commit (+dirty)
```

For the agent surface (slash commands + skills + auxiliary harness wrappers) and the full
new-machine flow, see [`Docs/Install.md`](Docs/Install.md). Note: the CLI on your PATH for
everyday use should still come from the release channel — `loombridge-install-locally.sh`
deliberately does **not** install a `loombridge` bin (it would shadow the released one).

## Running the suite

All commands run from `mcp-server/`:

```bash
npm run ci                    # typecheck + build + unit tests — the pre-commit bar
npm run typecheck             # tsc --noEmit
npm run test:unit             # unit tests only (fast)
npm run test:integration      # integration tests (spawns the server over stdio)
npm run test:all              # build + unit + integration
```

The **pre-commit bar is `npm run ci` green.** Add or update tests for any behavior change —
the deterministic gates and the doneness supervisor are the product, so a change there
without a test that would have caught the old behavior won't land.

Smoke tests against a real editor (optional, need Unity open with the bridge running):

```bash
npm run smoke:phase3:connected      # Unity open
npm run smoke:phase3:disconnected   # Unity closed (deterministic CONNECTION_ERROR)
```

A `blocked` smoke result (e.g. `EPERM_LOOPBACK`, `TIMEOUT_CONNECT`) is a deterministic
environment blocker preserved as evidence — not a product pass, and not a failure.

### EditMode (C#) tests

The Unity package tests live in `packages/com.loomtide.loombridge/Tests/` and run headless
from `unity-projects/loombridge-dev` via Unity batchmode. **They require a Unity install and
a valid Unity license**, so they don't run on a plain `npm` checkout. The same suite runs in
CI (`.github/workflows/unity-editmode.yml`); if your change touches C# in the bridge
package, describe how you exercised it (headless batchmode, or a live editor) in the PR.

## Pull requests

- **One focused change per PR.** Keep the diff reviewable.
- **Conventional commits.** Titles follow `type(scope): summary` — e.g.
  `feat(cli): ...`, `fix(bridge): ...`, `docs: ...`, `test: ...`, `refactor: ...`. This
  matches the existing history and drives release notes.
- **DCO sign-off on every commit** (see above). PRs with unsigned commits can't merge.
- **Green + documented.** `npm run ci` passing, tests added/updated, and any user-facing
  behavior reflected in the docs (`README.md`, `Docs/`, `mcp-server/TOOLS.md` regenerated
  via `npm run docs:tools` if you changed the op surface).
- Fill in the [pull request template](.github/pull_request_template.md) checklist.

## Adversarial review culture

Loombridge's value is that a "done" claim can't be self-graded — so we hold contributions to
the same bar. Reviews are **adversarial by design**: a reviewer's job is to find the way a
change could produce a false green, a bypassed gate, or a verdict that isn't actually bound
to the run it claims. Expect pointed questions about *where enforcement actually runs*
("defined but not wired" is a real finding), and about integrity bindings on any change near
the verification supervisor. This isn't personal — it's the same skepticism the product
applies to the games it verifies. Bring evidence (real output, a failing-then-passing test),
not assurances.

## Support matrix & non-goals

Supported: Unity `2022.3 LTS` (compatibility) → `6000.x LTS` (primary); Node `>= 18`;
macOS / Windows / Linux (IPC is Windows-only in practice — see the
[support matrix](README.md#support-matrix)).

Please don't open PRs for the declared **non-goals** — they're intentional, not gaps
(see [Roadmap & non-goals](README.md#roadmap--non-goals)):

- **No arbitrary code-execution op** — the typed op registry is a security boundary.
- **No telemetry** — no analytics or phone-home.
- **No cloud requirement** — the core runs fully local.

## Security

Do **not** open a public issue for a vulnerability — report it privately per
[`SECURITY.md`](SECURITY.md). The security posture is documented in
[`Docs/ThreatModel.md`](Docs/ThreatModel.md).
