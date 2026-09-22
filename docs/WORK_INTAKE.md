# Governed Work Intake

Work Intake selects the smallest safe execution shape before work begins. It
does not split work merely because several files may change.

## Decisions

- `direct_task`: one bounded objective that one agent can complete and validate
  without coordination, even when several files are involved.
- `feature_plan`: genuinely coordinated delivery with dependent work, parallel
  workstreams, multiple review gates, several acceptance units, or a very large
  estimated change surface.
- `needs_clarification`: missing or unusably vague objectives.

Explicit overrides are supported and recorded as evidence. The decision,
reason, confidence, policy version, coordination signals, and sanitized input
are persisted for auditability.

## Operational rule

Prefer a direct task. Promote work to a Feature Plan only when decomposition
reduces delivery risk more than it adds planning, handoff, integration, and
review overhead.

Feature Plans produce Draft Work PRs for their tasks and one consolidated
Feature PR for final review. Individual Work PRs are evidence and must not each
trigger an independent final review.

## Representative routing

| Request | Decision |
| --- | --- |
| Tiny fix, documentation update, or bounded audit | `direct_task` |
| One objective touching several related files | `direct_task` |
| Missing or meaningless objective | `needs_clarification` |
| Dependent or parallel workstreams | `feature_plan` |
| Multiple independent deliverables or review gates | `feature_plan` |

The regression suite in `test/work-intake.test.ts` protects these boundaries.

The dashboard composer accepts long-form objectives (up to 80,000 characters)
so a detailed user brief is not silently cut off at the input field. For local
autonomous execution, the user can explicitly approve command execution and
project-local install/change/removal inside the task's isolated worktree. That
approval is recorded against the Task; it is never translated into a global
provider permission change. Full Access chat task creation records the same
task-scoped approval. A retry of the same intake updates the existing task's
approval instead of creating a duplicate.
