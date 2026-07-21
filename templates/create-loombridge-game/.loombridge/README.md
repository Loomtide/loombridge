# `.loombridge/` — Loombridge project state (skeleton)

This directory is the **single source of truth** for Loombridge's plan → build →
verify → doneness flow in this project: the acceptance contract, design target,
captures, reports, and replays all live here.

It is intentionally near-empty in the template. Populate it by running `plan`
from the project root:

```bash
loombridge plan        # scaffolds the contract + design target into this directory
```

After `plan`, expect files such as `contract.json`, `design-target.json`, and
`status.json` to appear here (exact set depends on the genre). Do **not** hand-edit
these — the CLI owns them, and the verification gates read them as ground truth.

Starting the build from inside this template means the build is **inside the flow
from line one** (finding RCL-O03) rather than reaching only for the raw MCP bridge.
