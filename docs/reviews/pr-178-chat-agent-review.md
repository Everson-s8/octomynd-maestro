# PR #178 — Chat Agent Review

Status: reviewed against `origin/feat/chat-agent-loop` and hardened locally in
commit `06e852e`.

## Executive decision

The PR should not be merged unchanged. It introduced the right architectural
direction — a provider-driven agent loop with governed tools — but the first
version had failure modes at the boundaries between provider output, side
effects, context retention and UI observability.

The local hardening commit addresses the high-impact issues below. The remote
PR branch remains unchanged until the reviewed changes are intentionally
published.

## Findings and resolutions

| Severity | Area | Failure | Resolution |
| --- | --- | --- | --- |
| P1 | Structured output | Malformed or unknown JSON could be treated as a final user-facing answer, so the agent could stop without executing the requested work. | Invalid structured turns now consume a bounded repair iteration and remain internal. |
| P1 | Side effects and fallback | A provider could create a task or complete another governed mutation and fail before returning its final answer; fallback could then repeat the mutation. | Tool results carry `mutationCommitted`; provider fallback is disabled after a committed mutation and the user receives an explicit non-replay explanation. |
| P1 | Request isolation | Activity and cancellation were keyed only by thread, so overlapping requests could share a controller, progress state and cleanup. | Each request has its own request ID, controller, progress record and thread index. |
| P1 | Observability | The UI exposed only a mutable current status; refreshes erased the process history and users could not tell whether context compilation, a tool or the provider was active. | Progress events are persisted in an activity ledger and displayed as a bounded process timeline. |
| P2 | Long conversations | Character-based recent-history limits could hide the original objective behind follow-up questions and meta requests such as “create a task from this”. | The context compiler retains a bounded recent window plus a digest of substantive turns, objective, requirements, decisions, constraints and open questions. |
| P2 | Task construction | Copying the last user sentence produced a task title/body that described the chat command instead of the requested product change. | The agent prompt requires a standalone implementation brief with context, objective, scope, observable acceptance criteria, validation and constraints; `deriveTaskIntake` normalizes the result before persistence. |
| P2 | Provider failures | A provider error could collapse into a terse deterministic response without preserving what the agent had already learned. | Partial evidence and loop statistics remain available, and committed actions are explicitly reported rather than retried. |
| P2 | API robustness | An invalid activity-event limit could reach SQLite as `NaN`. | The dashboard route now clamps invalid limits to a safe default and bounds them to 1–500. |

## Verification

- `87` test files passed.
- `777` tests passed.
- Backend typecheck passed.
- UI typecheck passed.
- Backend production build passed.
- UI production build passed.
- `git diff --check` passed.

## Hermes study translated into Maestro contracts

Hermes is useful here for lifecycle boundaries rather than for copying its
runtime. The relevant contracts are:

1. Keep the live request isolated from background review and bounded in input.
2. Preserve provenance for generated or curated artifacts.
3. Read before writing and never let a conversational response directly rewrite
   governance.
4. Prefer recoverable archive/rollback to destructive replacement.

Maestro now applies those contracts through the context compiler, request-scoped
activity ledger and existing versioned Skill Curator. The UI shows public
progress, tool names and bounded redacted details; it does not persist hidden
chain-of-thought.

## Self-improvement decision

No new Skill is required for this tranche. The repository already has:

- typed project memories for explicit user preferences, decisions and constraints;
- improvement proposals with evidence, provenance and human decisions;
- versioned Skills with curator, evaluation and rollback paths.

The safe next step is a separate **Chat Learning Reviewer** that turns repeated
corrections and provider failures into proposals or explicit memory candidates.
It must be profile/project scoped, deduplicated, redacted, evidence-backed and
proposal-first. A single frustrated sentence must not become a durable user
preference, and the live chat response must not wait for curation.

## Remaining follow-up risks

- The task execution log page and the chat activity timeline are different
  observability surfaces. The new ledger fixes chat-process continuity; it does
  not invent task execution logs when a goal never started.
- The current command mutation guard is conservative: a successful command
  disables provider fallback even when the command may be read-only. A future
  command plan can expose an explicit `mutatesWorkspace` classification.
- The activity timeline is intentionally bounded. Full provider output belongs
  in redacted task/goal evidence, not in the chat transcript.
