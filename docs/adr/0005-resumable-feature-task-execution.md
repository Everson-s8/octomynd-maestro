# ADR 0005: Resumable Feature Task execution

## Status

Accepted

## Context

Fixed wall-clock provider deadlines terminated healthy Codex work after six minutes even while the
process produced output and changed its isolated worktree. A provider switch or Maestro restart kept
the files but lost the semantic handoff. Feature Tasks also started from independent copies of the
default branch, so dependent Tasks could run out of order or without validated ancestor work.

## Decision

Treat durable progress, not elapsed wall-clock time, as the primary execution signal:

- Codex and Claude have provider-specific inactivity limits. A total provider runtime and a total
  Goal deadline are optional operator policies, disabled by default.
- Output flood, duplicate output, repeated equivalent failure, step budget and repeated no-progress
  remain deterministic circuit breakers.
- Every writable provider step persists a checkpoint containing phase, provider, bounded summary,
  worktree fingerprint, changed files and artifact references.
- A retry, provider fallback or runtime restart resumes the same Goal from the existing worktree and
  latest checkpoint. Recovery never resets, cleans or deletes the worktree.
- Provider waits persist a typed reason and an absolute `nextRetryAt`; restart recovery restores the
  timer instead of applying a new generic delay.
- Every Feature Task has an objective, acceptance criteria, excluded scope, mutation scope,
  dependencies and serial/parallel policy. Legacy plans are normalized to a safe serial chain.
- The scheduler starts a Task only after all dependencies are delivered and validated. Failed
  dependencies block descendants. Same-project parallelism is allowed only for explicit disjoint
  mutation scopes.
- A dependent Task starts from a synthetic, deterministic Git baseline built by cherry-picking the
  exact delivered commits of its transitive dependencies. The Work PR targets that baseline; the
  final Feature assembly still integrates exact Task delivery commits once.

## Consequences

- Long but active provider work is not killed solely because it exceeded six minutes.
- Silent or looping providers still stop without consuming unbounded quota.
- Provider switches and runtime restarts preserve both files and semantic context.
- Dependent Tasks inherit validated ancestor output and cannot start after an upstream failure.
- Parallelism is conservative and auditable rather than inferred from Task text.
- Feature Plan creation requires better Task contracts; old plans remain safe but serial.
- Synthetic baseline branches add Git lifecycle work and are deleted only after successful Feature
  completion.
