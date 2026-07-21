---
description: Report Loomtide slice progress, next step, and actionable warnings without mutating state
allowed-tools: Read, Glob, Grep, Bash(loomtide:*), Bash(node:*), Bash(cat:*)
---

# loomtide status

Report the current Loomtide project state without changing anything. Use this when the
developer asks "where are we?", "what should I run next?", or when an agent is about to
continue work after a restart.

## Process

1. Run the deterministic CLI from the project root:

   ```bash
   loomtide status
   ```

   For local dogfooding before install:

   ```bash
   node mcp-server/dist/cli.js status --root .
   ```

2. Report the CLI output directly. Do not replace it with a hand-authored status table.
   The default output is intentionally compact:

   - `Progress`.
   - `Waiting for approval` or `Current slice`.
   - `Next`.
   - `Warnings` only when something needs attention.

3. Treat `Next` as authoritative unless the user explicitly overrides it. `Next` must
   always be developer-facing and copyable/sayable:

   - `run /loomtide:plan` — scaffold/check design and roadmap.
   - `run /loomtide:build or say continue` — build the current pending/stale slice.
   - `<slice> needs capture/verify evidence; run /loomtide:build or say continue` —
     the agent flow owns deterministic capture/verify details.
   - `say "approve <slice>" or run /loomtide:plan to approve and advance` — a verified
     slice is waiting for human approval. Do not tell the developer to remember `--go`;
     after explicit approval, the agent runs the internal `loomtide plan --go` command.
   - `all slices are approved; ask the agent to certify done` — run the roll-up gate in
     the appropriate command flow.

4. Never mutate from this command. Do not run `plan --go`, `build`, `capture`, `verify`,
   or `doneness` as part of `/loomtide:status`. If the developer asks you to continue,
   then run the reported next command in the appropriate command flow.

5. If `Warnings` appears, surface them before any next-step recommendation. Proof warnings,
   stale slices, missing capture files, and run-binding mismatches are exactly what `status`
   exists to make visible.
