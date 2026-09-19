---
name: diagnose-goal-failure
description: Diagnose failed Goals from bounded evidence.
---

# Diagnose Goal Failure

## Introduction

> **Iron Law: NO RECOVERY ACTION WITHOUT A CLASSIFIED CAUSE AND EVIDENCE.**

Diagnose a Maestro Goal that failed, blocked, or stalled without changing its
workspace, retrying a provider, or mutating policy. The output is a bounded
classification, evidence list, reversible recovery, and recurrence-prevention
note. This Skill does not turn a provider narrative into a fact.
Do not edit files while diagnosing a Goal.

## When to Use

Use in `planning` or `testing` when a Goal needs an explanation or recovery
decision. Use it after a provider failure, validation failure, exhausted budget,
or resumable checkpoint. Do not use it to implement the fix or approve a PR.

## Prerequisites

Read the Goal record, phase status, compact handoff, provider outcome and
failure category, validation report, checkpoint, and bounded runtime artifacts.
Identify the Task, project, and exact phase before suggesting a retry. Do not
request secrets, local paths, or an unbounded raw log.

## How to Run

Run read-only in the prepared workspace. Build a cause matrix from artifacts,
then choose the smallest reversible action. If the evidence cannot distinguish
two causes, fail closed and name the missing artifact instead of guessing.

## Quick Reference

- Classify: environment, provider auth/quota, timeout, permission, validation,
  code defect, or orchestration.
- Preserve the semantic checkpoint: `done`, `decisions`, `testsRun`,
  `knownFailures`, and `remaining`.
- Distinguish the failed provider from the Task itself before retrying.
- A recovery must be resumable and must not erase the worktree.

## Procedure

1. Start with the terminal record and phase transition. Check whether the
   runner says `blocked`, `failed`, `cancelled`, or `completed`; do not infer
   from a title or an empty dashboard card.
2. Read the validation evidence as the authoritative local result. The
   validation runner deliberately compacts up to 400,000 characters into about
   2,400 relevant characters at `validation/runner.ts:401`, retaining lines
   containing the error. The received excerpt is already the diagnostic slice;
   asking for “the full log” does not restore discarded evidence.
3. Classify the first cause with a concrete signal:
   - environment: missing executable, incompatible Node/native module, missing
     directory, or reproducible local setup failure;
   - auth/quota: provider health or credentials explicitly say unavailable;
   - permission: a CLI reports denied/auto-denied, including exit 0 soft denial;
   - timeout: deadline or inactivity terminated the process;
   - validation/code: a deterministic check or reproducible behavior fails;
   - orchestration: wrong phase, stale lease, duplicate retry, or lost handoff.
4. Do not conflate a provider failure with a code failure. In
   `goals/runner.ts:992`, a failed provider is put in `excluded`, the registry
   can select an alternate, and the checkpoint is recovered so the alternate
   does not restart from zero. Recommend that path only when the evidence says
   the provider failed, not when the code itself failed validation.
5. Read the semantic checkpoint before proposing a resume. `done` and
   `decisions` are completed context; `testsRun` and `knownFailures` are
   evidence; `remaining` is the work still authorized. A retry that discards
   these fields risks repeating completed phases or hiding a known failure.
6. Check the F01 boundary: a required-test Goal whose last validation failed
   at exhausted budget is resumably `blocked`, never deliverable. A green
   historical check does not override a later edit or failed last validation.
7. Return one primary cause, supporting artifact references, confidence, the
   smallest reversible recovery, and what the evidence does not prove. If two
   causes remain plausible, say so and request the narrowest missing evidence.

## Pitfalls

### Red Flags — STOP

- The diagnosis quotes provider prose but no Goal, validation, or checkpoint
  artifact.
- A 2,400-character compacted excerpt is treated as incomplete just because it
  is shorter than the original output.
- The proposed retry starts from planning despite a semantic checkpoint with
  completed planning and implementation.
- A permission-denied adapter result is called a code defect because its exit
  code was zero.
- “No provider output” is treated as success or as proof of a code regression.
- The diagnosis asks the user to reveal a token, password, local worktree path,
  or full unredacted log.

The process is not satisfied by naming a category; the evidence must support
the category and the recovery must preserve the work already proved.

## Common Rationalizations

- **“The provider failed, so restart the Goal from planning.”** The runner's
  fallback and semantic checkpoint exist to resume from the last safe boundary.
  Exclude the failed provider and preserve completed decisions.
- **“The compact log is useless; ask for all 400,000 characters.”** The compact
  excerpt is the deliberate error-focused evidence. Ask for a specific missing
  artifact, not discarded noise.
- **“Exit 0 means the adapter completed.”** F04 explicitly treats soft
  permission denial as `blocked`; inspect stdout and stderr semantics.
- **“The environment is broken because the test is red.”** Separate setup
  signals from reproducible validation or code signals before choosing a
  recovery.
- **“The checkpoint says tests ran, so the current code is validated.”** The
  checkpoint records history; a later implementation edit can expire that
  validation under F01.

## Verification

Confirm every claim is supported by a bounded artifact and distinguish facts from hypotheses.
Confirm the primary classification, excluded-provider state,
and semantic checkpoint agree. Confirm the proposed recovery is reversible,
resumable, does not mutate code or policy, and fails closed when evidence is
insufficient.
