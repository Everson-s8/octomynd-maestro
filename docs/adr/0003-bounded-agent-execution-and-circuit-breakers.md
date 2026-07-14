# ADR 0003: Bounded agent execution and circuit breakers

## Status

Accepted

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

Defaults are intentionally conservative: two-minute inactivity, six-minute provider phase, and a
thirty-minute active execution window. A persisted run waiting for provider availability receives a
new bounded window when resumed. Two equivalent failures or two completed writable phases without
worktree progress are enough to block for diagnosis.

## Consequences

- Known failure loops stop before another expensive provider cycle.
- Partial implementation remains available for inspection or controlled resume.
- Raw artifacts remain recoverable while duplicate handoffs no longer inflate later prompts.
- Dashboard and Telegram can explain why execution stopped from deterministic events.
- A genuine long-running phase must be split or explicitly configured rather than silently extending
  every provider timeout.
