# Maestro Feature Queue Roadmap

## Operating rule

The Feature Plan is the unit of delivery. Tasks are bounded implementation units inside a Feature, and Goals are execution attempts for those Tasks.

```text
Feature Plan
  -> ordered or parallel Tasks
  -> one Work PR per Task
  -> one consolidated Feature PR
  -> final review
  -> merge
  -> local main update and runtime restart
  -> next Feature admission
```

Only one mutating Feature may be active per project by default. A Feature waiting for final review or merge keeps the project's writer lease. The scheduler may continue:

- Features from other projects;
- read-only research, audit, and evaluation work;
- independent Tasks inside the same active Feature when their write scopes do not overlap.

The next mutating Feature for the same project starts only after the previous Feature is merged, local `main` is updated, and its scope and dependencies are revalidated. This prevents a queued Feature from branching from stale code.

Stacked Features are an explicit advanced mode, not the default. They require a declared dependency on the predecessor Feature and must branch from its Feature branch. If the predecessor changes, the successor is revalidated before execution.

## Queue states

```text
draft -> queued -> admitted -> active -> waiting_review -> waiting_merge
      -> completed
      -> blocked -> queued (after recovery)
      -> cancelled
```

Completed and cancelled Feature Plans remain as audit history but do not appear in the active queue by default.

## Prioritized Features

### F1. Feature Queue Scheduler and Mainline Admission Gate

Goal: make Feature Plans the first-class scheduling unit and guarantee conflict-safe sequential delivery per project.

Tasks:

1. Add explicit persisted Feature lifecycle states and dependency edges.
2. Add a per-project writer lease and mainline freshness check.
3. Revalidate queued Features after predecessor merge or cancellation.
4. Add queue reorder, pause, resume, cancel, and retry controls to Dashboard and Telegram.
5. Add deterministic tests for restart recovery, duplicate events, stale branches, and cross-project concurrency.

Acceptance: two Features for one project cannot mutate concurrently; Features for different projects can run concurrently; the successor always starts from the latest validated `main`.

### F2. Runtime Recovery and Lifecycle Reconciliation Hardening

Depends on: F1.

Goal: recover deterministically from provider crashes, process restarts, quota exhaustion, and interrupted GitHub transitions.

Tasks:

1. Complete provider failure taxonomy and resumability decisions.
2. Reconcile Task, Goal, Feature, PR, checkpoint, and worktree state after restart.
3. Add bounded retry policies without total-runtime cancellation of productive agents.
4. Add recovery canaries and operator diagnostics.

### F3. Provider Capacity and Model Routing

Depends on: F1.

Goal: route work by capability, role, availability, quota, cost, and user preference while preserving handoff context.

Tasks:

1. Persist model-level capabilities and live capacity signals.
2. Add role-specific routing policies for planning, implementation, testing, and final review.
3. Explain every provider switch in Dashboard and Telegram.
4. Add local and free-tier provider admission with safety and quality gates.
5. Preserve checkpoints and artifacts across provider handoffs.

### F4. Native Multi-Agent Delegation and Skill Execution

Depends on: F2 and F3.

Goal: let providers delegate bounded work to specialist workers using governed skills and artifact contracts.

Tasks:

1. Add provider-native delegation adapters where supported.
2. Standardize worker handoff, result, evidence, and review artifacts.
3. Route skills by task class and pin approved versions.
4. Evaluate worker output before it can mutate a Feature branch.

### F5. Remote Operations and Travel Mode

Depends on: F1, F2, and F3.

Goal: operate the Maestro safely for long unattended periods through Telegram and the Dashboard.

Tasks:

1. Add complete Feature queue visibility and controls remotely.
2. Add governed autonomy profiles, including an explicit high-autonomy mode.
3. Add night-shift scheduling, health summaries, and escalation policies.
4. Guarantee notifications for provider switches, blocks, reviews, merges, updates, and rollbacks.

### F6. Public Onboarding and Distribution

Depends on: F1 through F3.

Goal: make installation, provider connection, project registration, and first successful Feature understandable to non-technical users.

Tasks:

1. Create a guided setup and environment doctor.
2. Add provider connection and permission explanations.
3. Add a sample project and first-Feature walkthrough.
4. Publish versioned documentation and release artifacts.

## Direct Task policy

Direct Tasks are allowed only for small fixes, audits, documentation, or emergency recovery that do not justify a Feature. Product behavior, schema changes, multi-file architecture, and user-facing capabilities must use a Feature Plan and consolidated Feature PR.
