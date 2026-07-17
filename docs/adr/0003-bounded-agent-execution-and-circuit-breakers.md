# ADR 0003: Bounded agent execution and circuit breakers

## Status

Superseded by ADR 0005

## Context

A single long provider timeout allowed silent processes, repeated output, repeated failures, and
successful-looking phases without repository progress to consume time and subscription quota. A
fallback could repeat the same failure because the Goal Runner had no cross-step stop condition.
Large provider output was retained and handed forward even when it contained duplicate evidence.

## Decision

Keep the provider process runtime and Goal Runner as separate deep modules with explicit boundaries:

- the process runtime owns inactivity, phase timeout, absolute deadline, output volume, duplicate
  output, process-tree termination, and bounded evidence;
- the Goal Runner owns repeated normalized failures, repeated no-progress writable phases, handoff
  deduplication, fallback telemetry, and durable blocked state;
- provider adapters pass the goal deadline into the shared process runtime and expose process
  breaker telemetry without implementing their own retry loops;
- worktree progress is a content fingerprint of tracked changes and untracked files;
- a circuit breaker preserves the worktree and records a durable reason. It never resets or cleans.

The original fixed six-minute provider phase and thirty-minute Goal window were superseded after
production evidence showed that a healthy Codex process could keep producing output and changing the
worktree until the wall-clock timeout discarded its final response. ADR 0005 retains bounded output,
inactivity and no-progress breakers while making total runtime limits explicit opt-in policy.

## Consequences

- Known failure loops stop before another expensive provider cycle.
- Partial implementation remains available for inspection or controlled resume.
- Raw artifacts remain recoverable while duplicate handoffs no longer inflate later prompts.
- Dashboard and Telegram can explain why execution stopped from deterministic events.
- A genuine long-running phase must be split or explicitly configured rather than silently extending
  every provider timeout.
