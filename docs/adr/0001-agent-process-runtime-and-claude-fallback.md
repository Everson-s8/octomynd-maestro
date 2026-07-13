# ADR 0001: Shared agent process runtime and guarded Claude fallback

## Status

Accepted

## Context

Codex and Claude had separate subprocess implementations. They disagreed on timeout, cancellation,
buffering, capabilities, and failure classification. Claude was restricted to review even though the
routing table already listed it as the fallback for coding and testing. A Codex quota failure could
therefore leave a valid goal waiting while an authenticated Claude subscription was available.

## Decision

Use one deep `AgentProcessRuntime` module for subprocess lifecycle. Provider adapters retain only
their command construction, permission policy, prompts, health, and result classification.

Claude advertises planning, coding, testing, reviewing, and research:

- planning/reviewing run in `plan` mode with read-only tools;
- coding/testing run in `acceptEdits` mode inside the prepared task worktree;
- bypass permissions are never enabled;
- commit, push, destructive Git cleanup, PR merge, and release commands are denied;
- delivery remains a deterministic Maestro responsibility after testing and review;
- authentication, quota, and timeout failures are retryable and route to another provider.

When a persisted goal resumes from `waiting_provider`, the most recently failed provider for the
current phase is temporarily excluded. If no other provider is ready, it becomes eligible again so a
single-provider installation does not deadlock.

## Consequences

- Claude can continue overnight work when Codex quota is exhausted.
- Cancellation, timeout, and output limits behave consistently across providers.
- Provider permissions remain explicit and phase-specific.
- The Maestro still cannot merge or deploy automatically.
- Claude CLI permission semantics are now part of the adapter contract and require regression tests
  when the installed CLI is upgraded.
