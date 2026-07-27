# Agent instructions

The project instructions for **all** agents (Codex, Claude Code, and anything else) live in
[`CLAUDE.md`](CLAUDE.md). Read it before changing code. This file exists so agents that look for
`AGENTS.md` find the same single source of truth rather than a drifting copy.

Skills are canonical in [`.skills/`](.skills), symlinked from `.claude/skills/` and `.codex/skills/`
so both agents discover the same content.
