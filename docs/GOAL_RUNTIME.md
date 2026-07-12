# Maestro Goal Runtime

The goal runtime turns a prepared task into a persistent multi-step execution that does not require
the user to update task status manually.

## State machine

```text
planning
  -> implementing
  -> testing
  -> reviewing
       -> delivery -> completed + awaiting_human
       -> changes_requested -> implementing
```

Any phase can enter `waiting_provider` when both local providers are unavailable, unauthenticated,
or out of quota. The coordinator persists the run and retries it automatically without creating a
new goal or losing the completed steps.

Every transition is stored in SQLite. A run has a step budget, and every step records provider,
phase, outcome, summary, output, error, duration, and timestamps.

## Routing

Providers advertise capabilities. The registry selects a ready provider using this preference order:

| Capability | Preferred order |
| --- | --- |
| planning | Claude, Codex |
| coding | Codex, Claude |
| testing | Codex, Claude |
| reviewing | Claude, Codex |
| research | Claude, Codex |
| conversation | Claude, Codex |

If a provider fails, the runner excludes it for that phase and tries the next ready provider. A
review that returns `changes_requested` sends the goal back to implementation automatically. If
the available providers report a retryable quota or authentication condition, the task becomes
`waiting_quota`, the goal becomes `waiting_provider`, and the same run is resumed later.
Retryable provider failures are recorded as attempts but do not consume the goal's semantic step
budget.

## Current providers

- **Codex**: real non-interactive CLI adapter for planning, coding, testing, review, and research.
  Coding/testing use `workspace-write`; planning/review use `read-only`. Output is constrained by a
  JSON schema and artifacts are stored under `.maestro/runs/`.
- **Claude**: real read-only review adapter. Authentication failure is classified as retryable so
  routing can fall back.

The Maestro does not use the OpenAI API and does not require `OPENAI_API_KEY`. Codex uses the user's
existing Codex/ChatGPT authentication, while Claude uses its own installed CLI authentication. Each
service can still enforce the limits of the user's plan.

## Safety boundaries

- A task must have a prepared isolated worktree.
- Workers are instructed not to commit, push, merge, deploy, modify credentials, or leave the worktree.
- Every goal has a maximum step budget.
- Missing providers, blockers, failures, and budget exhaustion become explicit durable states.
- Goal artifacts, database, logs, environment files, and credentials remain ignored by Git.
- Completion means all phases succeeded; a planning or implementation response alone cannot finish a goal.
- Workers never publish directly. After review succeeds, the deterministic delivery layer scans for
  secrets, creates a commit, pushes the isolated task branch, and opens a draft pull request.
- Merge is never automatic. A delivered task remains `awaiting_human` with the draft PR URL.
- The Maestro Telegram gateway proactively notifies the restricted user when the draft PR is ready.
  Managed projects do not need to implement Telegram unless their own product explicitly requires it.

## Governed delivery

Delivery is intentionally outside the LLM worker. It is deterministic and idempotent: a retry can
continue from an existing task commit if push or PR creation failed. The secret guard blocks env
files, credential filenames, private keys, and common provider token formats before staging.
GitHub publication requires an authenticated `gh` CLI. The pull request is always created as draft.

## Dashboard API

```text
POST /api/tasks/:taskId/goal
GET  /api/goals/:runId
```

The task detail panel starts a goal once. The coordinator continues it in the background and the
dashboard refresh shows phase, step count, provider wait, completion, blocker, or failure. Waiting
runs are recovered after a Maestro restart and scheduled for retry. Delivered goals expose their
commit SHA and draft pull request URL.
