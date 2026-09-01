# Agent Docs

This directory is the system of record for agent-facing repo guidance. Keep topic pages small, specific, and mechanically checkable where possible.

## Recommended Reading Order

1. `quickstart.md`
2. `architecture/overview.md`
3. the task-specific page for the area you are changing

## Directory Layout

- `architecture/`
  - system structure and major code ownership boundaries
  - [`workspace-server.md`](architecture/workspace-server.md) — protocol versioning, negotiation handshake, and behavior-change rules for the remote workspace daemon
  - [`acp-runtime.md`](architecture/acp-runtime.md) — ACP runtime, session manager, connection pool, cells, live models, and API contract ownership
- `workflows/`
  - task-oriented procedures like testing, worktrees, remote development, and Nx task orchestration
- `integrations/`
  - provider, MCP, and external service guidance
- `risky-areas/`
  - places where incorrect changes are expensive
- `conventions/`
  - coding contracts and repo rules
- `roadmaps/`
  - written technical strategies, sequenced implementation plans, and acceptance criteria
  - [`rig-resilience.md`](roadmaps/rig-resilience.md) — current plan for session resilience, recovery, filesystem safety, performance, and desktop completeness
  - [`agent-queryable-context.md`](roadmaps/agent-queryable-context.md) — Stage 1 design for
    explaining document passages from existing anchors, Tap provenance, and CLI retrieval
  - [`agent-queryable-context-verification.md`](roadmaps/agent-queryable-context-verification.md) —
    reproducible cross-repository verification record and remaining provider acceptance work

## Maintenance Rules

- Prefer one page per concrete topic.
- Avoid volatile counts unless you can verify them cheaply.
- Link to the source-of-truth file paths.
- Update the smallest relevant page instead of expanding `AGENTS.md`.
