---
name: implement-task-safely
description: Implement approved Tasks with bounded evidence.
---

# Implement Task Safely

## Introduction

> **Iron Law: NO DELIVERY WITHOUT FRESH VALIDATION EVIDENCE.**

Implement one approved Maestro Task in its prepared workspace. This Skill
changes how completion is judged; it does not replace `AGENTS.md`, the
deterministic validation runner, provider policy, or human review. It does not
commit, push, merge, deploy, or change credentials.
Fail closed when the workspace or requirement is ambiguous.

The important distinction is between changing files and proving that the
change is deliverable. A provider outcome of `completed` is not proof that the
workspace is valid, and a test result from before the last implementation step
does not cover code changed afterward.

## When to Use

Use during the `implementing` phase for an approved Task whose workspace and
scope were prepared by Maestro. Do not use this Skill to turn a vague request
into a plan, to diagnose a failed Goal, or to approve a consolidated Feature
PR.

## Prerequisites

- Read the Task objective, specification, Feature contract if present, and
  repository instructions.
- Know which worktree and mutation scope belong to the Task; preserve any
  existing user changes in that workspace.
- Know whether the next validation must satisfy `requireTests`.
- Treat the checkpoint and previous-step handoff as evidence, not as an order
  to repeat work whose assumptions are stale.

## How to Run

This Skill requires explicit selection before writing in a prepared Task
workspace. Keep
the change bounded to the Task contract. Let Maestro's local validation runner
produce the authoritative deterministic evidence before claiming delivery.

## Quick Reference

1. Establish the smallest root-cause change.
2. Preserve the Task worktree and its scope.
3. Remember that implementation invalidates prior validation evidence.
4. Never deliver after an exhausted validation budget with a failed last test.
5. Report what was proved, what was not, and why.

## Procedure

1. Translate the acceptance criteria into observable behavior and identify the
   smallest coherent edit. Do not absorb unrelated cleanup into this Task.
2. Inspect the existing seam before writing. If the request conflicts with a
   Feature worker contract or a protected scope, stop with concrete evidence.
3. Implement the root cause. A provider's explanation, a prior checkpoint, or
   a green test from an earlier step is not permission to skip inspection.
4. Treat a later implementation step as invalidating the previous validation
   state. `lastValidationPassed` must describe the latest code, not the latest
   successful historical run.
5. Understand the F01 terminal rule: if `requireTests` is true, the last
   validation did not pass, and the final validation budget is exhausted, the
   Goal becomes `blocked` and resumable. It must never be delivered as if it
   were validated. A blocked result is a recovery state, not a failure to hide.
6. Do not spend provider tokens reproducing the seven local checks already
   owned by `validation/runner.ts`: `diff_check`, `secret_scan`,
   `typecheck_backend`, `typecheck_ui`, `tests_focused`, `tests_full`, and
   `build_ui`. Read their evidence and spend judgment on behavior, scope,
   integration, and gaps that those checks cannot prove.
7. If a check fails, fix only a failure caused by this Task, then validate the
   changed code again. Never relabel a red check as unrelated merely because
   the provider output is otherwise plausible.
8. Before handoff, state changed files, validation evidence, remaining gaps,
   and whether delivery is allowed. “Provider completed” is insufficient when
   the local contract says `blocked`, `failed`, or `changes_requested`.

Never commit, push, merge, deploy or change secrets from this Skill.

## Pitfalls

### Red Flags — STOP

- The last test failed but a test from an earlier step passed.
- The validation budget is exhausted while `lastValidationPassed` is false.
- Code was edited after the evidence being cited.
- The provider asks to skip `tests_full`, secret scanning, or the UI build
  because the output “looks right”.
- A fix expands the mutation scope, changes credentials, or touches a second
  Task without a dependency in the Feature contract.
- A successful provider exit is being used to override a deterministic
  `blocked` or `failed` result.

Violating the letter of the validation contract violates its purpose: the
checkpoint must make a later retry safer, not make an unvalidated delivery
look complete.

## Common Rationalizations

- **“The test failed, but the code is correct, so deliver it.”** F01 exists
  precisely to reject this judgment when tests are required and the budget is
  gone. Preserve the checkpoint and report `blocked`.
- **“Tests passed before my last edit.”** That evidence expired when the
  implementation step changed the workspace. Validate the current tree.
- **“The provider said completed, so the runner will accept it.”** Adapters
  can return `completed` without a verified change; deterministic evidence and
  the Task contract outrank the label.
- **“I will rerun every check inside the provider to be safe.”** The seven
  checks are already local and token-free. Reproducing them spends context
  while leaving the behavioral judgment under-specified.
- **“This unrelated failure is harmless.”** Classify it with the validation
  evidence. If it prevents a required gate from passing, do not silently
  deliver; if it is truly pre-existing, record the evidence and the boundary.

## Verification

Confirm that the current workspace, not a historical step, satisfies the Task
contract. Confirm the seven deterministic checks and their fresh timestamps or
step evidence. Confirm that a required test failure at exhausted budget yields
`blocked` and a resumable checkpoint. Confirm no provider claim, secret,
unreviewed scope expansion, or stale validation result was treated as proof.
