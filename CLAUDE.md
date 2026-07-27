# Loombridge

A **"Playwright for Unity"**: agents see, control, and verify Unity projects through MCP, and a
deterministic CLI owns the state and the verification contracts. The value is that a "done" claim
cannot be self-graded.

Read [`ARCHITECTURE.md`](ARCHITECTURE.md) for system design and
[`CONTRIBUTING.md`](CONTRIBUTING.md) for setup, the test commands, and PR rules. This file covers
the invariants an agent has to know before changing code.

## Layout

```
packages/com.loomtide.loombridge/  C# Unity bridge package (UPM layout)
mcp-server/src/                    TypeScript MCP server + `loombridge` CLI
commands/loombridge/               agent-facing slash-command prose (Codex shim is generated)
.skills/                           canonical skills, symlinked from .claude/skills + .codex/skills
demos/                             consumer demo projects
unity-dev-project/                 EditMode/CI project. NOT a demo: it declares the package testable
Docs/                              user docs; Docs/Design/ holds RFCs
```

## Source layers (`mcp-server/src/`)

One direction only, enforced by `__tests__/unit/repo/layering.test.ts`:

```
surfaces -> capabilities -> {bridge, domain} -> shared
```

- `surfaces/` argv and MCP entrypoints. `capabilities/` one directory per area, including that
  area's CLI verb. `domain/` vocabulary shared across capabilities (no argv, no orchestration).
  `bridge/` Unity transport. `shared/` leaf helpers with no domain knowledge.
- Place new code by what it **does** (capability) rather than what it **names** (domain). Genre
  packs are capabilities.
- Run the layering test before proposing any structural change. It carries a LITMUS self-test, so
  do not "simplify" the assembled specifier string in it: a bulk import-rewriter once rewrote that
  string as if it were real code and silently defused the check.

## The recurring blind spot: declared paths nothing walks

This repo's most expensive failures have all been the same shape. **A path declared in JSON, a
shell script, or a workflow file that no test imports is invisible to a green suite.** A full pass
of 3000+ tests has shipped broken `bin` targets, a doc generator writing to the wrong directory,
and an unresolvable Unity `file:` dependency.

Guards exist and must stay non-vacuous: `package-entrypoints.test.ts` (bin targets, npm-script
paths, Node-portability) and `unity-project-refs.test.ts` (Unity `file:` deps). When you add a
declared path, add the guard with it, and give the guard a LITMUS proving it fails on the broken
input.

Related: **never count `..` segments to find a root.** Use `shared/pkg-root.ts` (`packageRoot()`),
or `__tests__/_support/paths.ts` in tests. A `..` count silently encodes how deep a file sits, and
re-nesting one directory points it at `dist/`.

## Unity / C# gotchas

- **Unity `6000.5` made the InstanceID APIs obsolete-as-ERROR** (CS0619, not `#pragma`
  suppressible), replaced by EntityId APIs that do not exist before `6000.5`. All object-identity
  lookups go through `Editor/Core/EntityIdCompat.cs`. **Never call the raw InstanceID or EntityId
  APIs directly**, or one of the two supported editors stops compiling. Support runs `2022.3`
  (compatibility) to `6000.x`.
- Op handlers run on the **main thread**. Live harnesses use `UnityClient`, not a raw `ws`.
- Unity diagnostics keep the `[Loombridge]` log prefix.

## Op development gotchas

- A per-call `timeoutMs` arg overrides `op.defaultTimeoutMs` via `resolveOpTimeoutMs`. Never
  advertise a tunable `timeoutMs` on an async op without confirming the server reads it, and keep
  `defaultTimeoutMs` realistic regardless.
- **Ops that trigger a domain reload** (`package.add`/`remove`, any recompile) can lose their
  response: the reload wipes `WaitEngine` state and may sever the socket before the reply is sent.
  Respond before the reload completes and have the agent chain `editor.wait_for { compiling: false }`.
  Beware the server's `CONNECTION_LOST` auto-retry re-sending a **non-idempotent** op; prefer
  idempotent semantics.
- **A post-reload router stall has three stacked causes**, diagnose in this order: a heavy
  first-time import blocking the main thread; an unfocused editor not ticking the main thread; a
  latent compile error in **any** assembly (including test asmdefs) blocking assembly load, where
  the bridge listens on its port but never re-registers while `get_state` reports `error_count: 0`
  because no new compile ran. Recovery may still need a human to refocus Unity.

## Verification invariants (the moat)

- **A gate predicate must REFUSE when a bound field is absent, never skip the check.** The threat
  model is a hand-crafted or self-graded verdict. Anti-pattern: `else if (x.field && ref !== x.field)`,
  where a falsy `field` skips the binding. Use `if (!x.field) refuse(); else if (ref !== x.field) refuse();`.
- **"verified-green" is not "done" for a design-targeted build.** Tier-1 `verify` stays
  deterministic. Hero-shot fidelity is enforced in `loombridge doneness`. Never fold model-judgment
  (VLM) criteria into the deterministic Tier-1 status.
- **Only a frozen `rendered-unity-frame` can certify doneness; a `composition-reference` never
  can.** A flat 2D mock cannot represent materials, proportions, lighting, or silhouettes, so
  freezing it would certify against an idealized fiction. Backward compat is final-by-default: an
  absent `kind` resolves to `rendered-unity-frame`, so only an explicit `composition-reference` is
  refused. The slice roll-up reads `kind` from disk so it cannot be laundered by omitting it from a
  hand-edited verdict.
- **Harness fault is not a game defect.** Capture and harness gaps exit `2` in their own report
  tier: never a pass, never a game bug.
- Deterministic CLI versus agent judgment: gates, exits, and state live in the CLI. VLM review is
  advisory and never part of a deterministic verdict.
- Locators, not instance IDs (`SceneName:/Path/To/Object[index]`). Deterministic waits via
  `wait_for()`, never sleeps. Every tool routes through the op registry.

## Tests

From `mcp-server/`: `npm run ci` is the pre-commit bar (typecheck, build, unit).

- **`test:unit` runs with `--test-concurrency=1` on purpose.** Under parallel execution Node's
  runner intermittently fails to deserialize its V8 result stream, which surfaces as a whole file
  failing with no assertion and silently undercounts tests. Do not "optimise" it away.
  `CONTRIBUTING.md` carries the measurements.
- **CI pins Node 20; local may be newer.** Node 20 treats a positional to `node --test` as a
  directory, Node 22+ treats it as a glob. The scripts let the **shell** expand the file list so
  both work. A guard rejects glob metacharacters in the test scripts. Green locally is not green:
  check the CI run.
- Do not hand fd 1 to a grandchild under the test runner. Use `shared/child-stdio.ts`.
- EditMode C# tests need a Unity install and license; they run in CI via
  `.github/workflows/unity-editmode.yml`.

## Working agreements

- **Branch before committing. Never commit or push directly to `main`.**
- Conventional commit titles (`type(scope): summary`) and **DCO sign-off on every commit**
  (`git commit -s`). Unsigned commits cannot merge.
- Reviews are adversarial by design: the reviewer's job is to find the path to a false green, a
  bypassed gate, or a verdict not actually bound to the run it claims. "Defined but not wired" is a
  real finding. Bring evidence (real output, a failing-then-passing test), not assurances.
- Reproduce or observe a bug before fixing it. Build the verification tooling before fixing blind.
- Regenerate `mcp-server/TOOLS.md` via `npm run docs:tools` when the op surface changes.
- Never `git add -A` inside a worktree; use explicit paths.
