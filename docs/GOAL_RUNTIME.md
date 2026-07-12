# Maestro Goal Runtime

The goal runtime turns a prepared task into a persistent multi-step execution that does not require
the user to update task status manually.

## State machine

```text
planning
  -> implementing
  -> testing
  -> reviewing
       -> completed
       -> changes_requested -> implementing
```

Every transition is stored in SQLite. A run has a step budget, and every step records provider,
phase, outcome, summary, output, error, duration, and timestamps.

## Routing

Providers advertise capabilities. The registry selects a ready provider using this preference order:

| Capability | Preferred order |
| --- | --- |
| planning | OpenAI, Claude, Codex |
| coding | Codex, OpenAI, Claude |
| testing | Codex, OpenAI, Claude |
| reviewing | Claude, OpenAI, Codex |
| research | OpenAI, Claude, Codex |
| conversation | OpenAI, Claude, Codex |

If a provider fails, the runner excludes it for that phase and tries the next ready provider. A
review that returns `changes_requested` sends the goal back to implementation automatically.

## Current providers

- **Codex**: real non-interactive CLI adapter for planning, coding, testing, review, and research.
  Coding/testing use `workspace-write`; planning/review use `read-only`. Output is constrained by a
  JSON schema and artifacts are stored under `.maestro/runs/`.
- **Claude**: real read-only review adapter. Authentication failure is classified as retryable so
  routing can fall back.
- **OpenAI API**: provider contract and routing slot are ready; API execution is the next connection.

## Safety boundaries

- A task must have a prepared isolated worktree.
- Workers are instructed not to commit, push, merge, deploy, modify credentials, or leave the worktree.
- Every goal has a maximum step budget.
- Missing providers, blockers, failures, and budget exhaustion become explicit durable states.
- Goal artifacts, database, logs, environment files, and credentials remain ignored by Git.
- Completion means all phases succeeded; a planning or implementation response alone cannot finish a goal.

## Dashboard API

```text
POST /api/tasks/:taskId/goal
GET  /api/goals/:runId
```

The task detail panel starts a goal once. The coordinator continues it in the background and the
dashboard refresh shows phase, step count, completion, blocker, or failure.
