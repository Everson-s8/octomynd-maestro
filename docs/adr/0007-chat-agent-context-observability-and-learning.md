# Chat Agent Context, Observability and Learning

Status: accepted

## Context

The conversational agent must interpret a conversation before creating a Task. A final user
message such as “crie uma task” is a control instruction, not the Task objective. The agent also
needs to show what it is doing, survive provider failures without replaying side effects, and learn
useful user preferences without silently changing its own governance.

The first agent-loop implementation had four failure modes:

- malformed provider JSON could be displayed as a final answer;
- provider fallback could replay a completed governed action;
- activity was one mutable in-memory status per thread, so concurrent requests shared cancellation
  and a browser refresh lost the process history;
- context was bounded by a few recent messages and character slices, which could hide the original
  objective in a long conversation.

## Decision

The chat agent is split into four deep modules with small seams:

1. **Context compiler** — the transcript remains the source of truth. Each turn receives a bounded
   recent window plus a deterministic digest of substantive user and orchestrator turns, explicit
   decisions, constraints and open questions. Meta requests are never promoted to the objective.
2. **Agent loop** — provider turns are structured JSON. Invalid structured output consumes another
   bounded iteration for repair instead of becoming user-visible content. A tool result can mark a
   mutation as committed; once that happens, provider fallback is disabled for that turn.
3. **Activity ledger** — every request has its own request ID and controller. Progress events are
   persisted with redacted, bounded details and exposed separately from the current status. The UI
   can show a timeline without exposing command output or hidden reasoning.
4. **Learning pipeline** — learning is proposal-first. Explicit user memories may be saved through
   the existing guarded memory path. Repeated corrections and provider failures may later create a
   Skill-curator incident or proposal, but they must not directly edit active Skills or governance.

## Hermes-derived constraints

Hermes is a reference for lifecycle governance, not a reason to copy its runtime. Its background
review runs in a fork and keeps the live conversation/prompt cache isolated. Its curator distinguishes
agent-owned artifacts, preserves provenance, protects pinned or human-owned Skills, and archives
instead of deleting. Maestro follows the same contracts through its existing versioned Skill and
curator modules.

## Learning policy

- Store user preference, project decision and environment fact in separate typed records.
- Never infer a durable preference from one frustrated sentence without a repeat signal or explicit
  confirmation.
- Redact credentials, paths and secret-like text before persistence or model replay.
- Record the source conversation and evidence for every candidate proposal.
- Require read-before-write, independent evaluation and rollback for agent-owned Skill changes.
- Keep the live chat path fast: background curation may be deferred, bounded and cancellable; it
  must never block the user-facing response.

## Consequences

- The Dashboard can explain the latest process and recover its recent activity after refresh.
- A provider failure after a mutation becomes an explicit “do not replay” state instead of an
  invisible duplicate-task risk.
- Long conversations retain a compact objective trace without sending the entire transcript on
  every provider turn.
- Automatic learning remains safe and auditable, but it is intentionally slower than ordinary
  conversation and requires a separate curator worker/proposal UI.

## Rejected alternatives

### Let the model rewrite memory or Skills directly

Rejected because a conversational model cannot be the sole authority for durable policy. It would
mix user preference, project state and procedural rules and make rollback difficult.

### Persist hidden chain-of-thought

Rejected. The activity ledger stores bounded public progress, tool names, status and redacted detail,
not private reasoning. This is enough for operational trust and debugging.

### Replay the full transcript on every tool turn

Rejected because context growth and cost become nonlinear. The digest and bounded tool transcript
preserve the relevant state while keeping the provider interface predictable.
