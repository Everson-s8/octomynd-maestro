# ADR 0006: Antigravity provider and cost-aware routing

## Status

Accepted.

## Context

The Maestro already routes durable Goal phases through subscription-backed Codex and
Claude CLIs. Codex quota is also needed for interactive engineering work, while the
Google AI Pro subscription exposes Antigravity as an official headless CLI with its
own quota. Duplicating the same mutable Task across providers would increase cost and
create conflicting patches.

## Decision

Antigravity is a first-class `AgentProvider` using the official `agy` CLI and its
system-keyring authentication. No Google credential or browser cookie is stored in
the repository.

General planning, coding, testing, research and restricted improvement review prefer
Antigravity. Final Review keeps Claude first, followed by Antigravity and Codex. A
provider failure releases its lease, records cooldown telemetry and resumes through
the next compatible provider without discarding the Task worktree.

Parallel execution remains controlled by the Work Graph. Independent read-only nodes
may run on different providers at the same time. Dependency edges and the single
writer rule prevent concurrent mutation of the same Task.

## Consequences

- Codex quota is preserved for work where its quality is most valuable.
- Google subscription quota becomes observable in Dashboard and Telegram.
- Antigravity model and effort can be configured without hard-coding model names.
- Authentication health is probed through `agy models`, not inferred from binary
  presence alone.
- Provider fan-out does not mean speculative duplicate implementations.
