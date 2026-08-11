# `.loombridge/` — Loombridge project state (skeleton)

This directory is the **single source of truth** for Loombridge's plan → build →
verify → doneness flow in this project: the acceptance contract, design target,
captures, reports, and replays all live here.

**One rule decides what a team commits.** Everything Loombridge re-derives from an
anchor plus a run lives under `run/`, which carries its own `.gitignore`. Everything
else here is meant to be committed:

```
.loombridge/
  ACCEPTANCE.json  FEEL_SPEC.json  GAME_SPEC.md  SLICES.json  STATE.md   COMMITTED
  design/     the approved hero shot (Design Target)                     COMMITTED
  anchors/    traces/     recorded human demonstrations                  COMMITTED
              baselines/  approved pixel baselines + manifest            COMMITTED
              signoffs/   the human sign-off artifacts SLICES.json cites COMMITTED
  tests/      stamped Unity results + binding manifest                   COMMITTED
  verify/     captured op output the Tier-1 gates read                   COMMITTED
  registry/   imported asset packs (project inputs)                      COMMITTED
  run/        reports/  replays/  captures/  art/  backups/  handoff/    IGNORED
              op-traces/
```

If it is not under `run/`, it is meant to be committed. An anchor whose evidence
never leaves one machine is not a gate.

It is intentionally near-empty in the template. Populate it by running `plan`
from the project root. `plan` REFUSES to guess the genre (a guessed genre seeds
that genre's whole contract and still claims `graded`), so name one:

```bash
loombridge plan --genre <id>   # scaffolds the contract + design target into this directory
```

`loombridge plan --help` lists the genres with a shipped pack. For a genre that
has none, write a contract first and plan from it: `genre init` writes it into
this directory, under the exact name `--brief` resolves:

```bash
loombridge genre init --genre <your-id> --class <twitch|systems|hybrid>
# fill in every "REPLACE ME:" field: `plan` refuses a contract that still has one
loombridge plan --brief .loombridge
```

A re-plan needs no flag: the genre already in `STATE.md` wins.

After `plan`, expect files such as `contract.json`, `design-target.json`, and
`status.json` to appear here (exact set depends on the genre). Do **not** hand-edit
these — the CLI owns them, and the verification gates read them as ground truth.

Starting the build from inside this template means the build is **inside the flow
from line one** (finding RCL-O03) rather than reaching only for the raw MCP bridge.
