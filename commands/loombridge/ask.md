---
description: Explain the current Loombridge project state without mutating anything
allowed-tools: Read, Bash(loombridge:*), Bash(node:*)
---

# loombridge ask

Answer a developer's local Loombridge workflow question from deterministic `.loombridge/`
state. This is **not AI chat** and not a workflow command: it is a read-only explainer
over `loombridge status`.

## Process

1. Run the CLI from the project root, forwarding the user's question exactly:

   ```bash
   loombridge ask "$ARGUMENTS"
   ```

   For local dogfooding before install:

   ```bash
   node mcp-server/dist/surfaces/cli.js ask --root . "$ARGUMENTS"
   ```

2. Report the CLI output directly. Do not replace it with a custom table or a broader plan.

3. Never mutate state from this command. Do not run `plan --go`, `build`, `capture`,
   `verify`, or `doneness` as part of `/loombridge:ask`.

4. If the CLI says approval is waiting, ask the developer for approval or direct them to
   `/loombridge:plan`. After explicit approval, the plan command flow owns the internal
   approval action.

5. Every answer should preserve the CLI's `Next:` line. It is intentionally phrased as a
   developer-facing action such as `say "approve collectibles"` or `run /loombridge:build`,
   not an internal flag sequence.
