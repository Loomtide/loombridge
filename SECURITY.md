# Security Policy

## Supported Versions

Loombridge (the `com.loomtide.loombridge` Unity package and the `loombridge` MCP
server/CLI) is pre-1.0. Only the **latest minor release** receives security fixes; older
minors are not patched — upgrade to the newest release to stay supported.

| Version | Supported |
|---------|-----------|
| Latest minor (currently 0.3.x) | Yes |
| Any earlier minor | No |

## Reporting a Vulnerability

Please report vulnerabilities privately — do **not** open a public GitHub issue for a
security problem.

- **Primary channel:** GitHub private vulnerability reporting — "Report a
  vulnerability" under this repository's **Security** tab. This channel becomes
  available when the repository goes public, and enabling it is a launch gate for the
  open-source release.
- **Secondary channel:** email **security@loomtide.ai**
  > **PLACEHOLDER — this mailbox is pending setup.** Until it is live, use the GitHub
  > channel above.

What to include: an affected version, a reproduction (or proof-of-concept), and your
assessment of impact. Please give us a reasonable disclosure window before publishing.

### Response expectations

- **Acknowledgement:** within 5 business days.
- **Initial assessment (accepted / declined / need more info):** within 14 days.
- **Fix or mitigation for accepted reports:** targeted for the next release; critical
  issues are prioritized out-of-band.

These are good-faith targets from a small team, not an SLA.

## Scope

Loombridge is a **local editor tool**: an MCP server and CLI on your machine talking to
a bridge plugin inside your own Unity Editor over loopback (localhost WebSocket; on
Windows, optionally a local named pipe). The threat model is documented in
[Docs/ThreatModel.md](Docs/ThreatModel.md).

In scope:

- Vulnerabilities exploitable in the supported local, single-developer configuration —
  e.g. the bridge accepting connections from non-loopback interfaces, op-handler bugs
  that escape the typed op surface, path traversal in artifact/trace/capture writing,
  or bypasses of the verification supervisor's integrity bindings.

Out of scope:

- **Remote exposure.** Deliberately exposing the bridge port or discovery files to a
  network (port-forwarding, tunnels, containers with published ports, multi-user
  hosts) is an unsupported configuration, not a vulnerability — the bridge is
  loopback-only by design and has no authentication for hostile-local-network use.
- Attacks requiring an already-compromised local machine or local same-user malware.
- Vulnerabilities in Unity itself, in Node.js, or in third-party dependencies
  (report those upstream; do tell us if Loombridge's usage makes one exploitable).
- Social-engineering the AI agent driving the tool.
