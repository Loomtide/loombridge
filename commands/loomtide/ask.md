---
description: Explain the current Loomtide project state without mutating anything
allowed-tools: Read, Bash(loomtide:*), Bash(node:*)
---

# loomtide ask

Answer a developer's local Loomtide workflow question from deterministic `.loomtide/`
state. This is **not AI chat** and not a workflow command: it is a read-only explainer
over `loomtide status`.

## Process

1. Run the CLI from the project root, forwarding the user's question exactly:

   ```bash
   loomtide ask "$ARGUMENTS"
   ```

   For local dogfooding before install:

   ```bash
   node mcp-server/dist/cli.js ask --root . "$ARGUMENTS"
   ```

2. Report the CLI output directly. Do not replace it with a custom table or a broader plan.

3. Never mutate state from this command. Do not run `plan --go`, `build`, `capture`,
   `verify`, or `doneness` as part of `/loomtide:ask`.

4. If the CLI says approval is waiting, ask the developer for approval or direct them to
   `/loomtide:plan`. After explicit approval, the plan command flow owns the internal
   approval action.

5. Every answer should preserve the CLI's `Next:` line. It is intentionally phrased as a
   developer-facing action such as `say "approve collectibles"` or `run /loomtide:build`,
   not an internal flag sequence.
