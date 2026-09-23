# Runtime Recovery and Lifecycle Reconciliation Study

## Incident summary

Goal #40 reached its configured 12-step budget while Task #41 still had preserved
changes. The terminal state was reported as an unknown Claude provider failure even
though the provider had produced a useful final review. At the same time, the
self-update helper could terminate itself while stopping the Windows runtime,
leaving the update record in `in_progress` without restarting Maestro.

Completed Feature Plans also remained visible as planned because the persisted
plan status only represented authoring state. Completion lived in the linked
Feature and integration records, but the Dashboard did not project that lifecycle.

## Failure chain

1. The Goal consumed its final allowed step.
2. The runner reused the last provider error instead of emitting a budget terminal
   reason.
3. Observability attributed the failure to Claude and offered no next provider.
4. Preserved work remained recoverable, but the operator received a definitive
   interruption message.
5. The detached update script stopped the runtime process tree, including itself.
6. Restart reconciliation did not classify the interrupted update on startup.

## Why existing validation missed it

- Process execution was mocked, so Windows descendant-process behavior was absent.
- Goal tests covered provider failures but not exhaustion after useful preserved work.
- Runtime update tests asserted command creation, not restart completion after a
  real process boundary.
- Feature Plan state was read directly instead of projected from Feature and
  integration lifecycle records.

## Proposed follow-up feature

**Feature: Runtime Recovery and Lifecycle Reconciliation Hardening**

### Work block 1 — Windows process lifecycle harness

- Start a disposable Maestro runtime as a real child process.
- Launch the updater outside the runtime process tree.
- Verify stop, fast-forward update, restart and PID replacement.
- Inject restart failure and verify rollback to the previous known-good commit.

### Work block 2 — Crash-point reconciliation matrix

- Exercise crashes before fetch, after fetch, after merge and before restart.
- Reconcile every `in_progress` update deterministically on startup.
- Guarantee idempotent Telegram and Dashboard notifications.
- Prove repeated GitHub events cannot duplicate updates or reviews.

### Work block 3 — Terminal reason taxonomy

- Separate provider, quota, authentication, timeout, budget and policy outcomes.
- Never attribute scheduler or Goal-budget exhaustion to the last provider.
- Preserve checkpoint, changed files and the exact resumable action.
- Allow bounded continuation from a checkpoint after scope review.

### Work block 4 — Lifecycle projection and repair

- Treat linked completed Features as completed Feature Plans in all read models.
- Hide historical plans from the active queue by default.
- Add a repair command for stale projections without deleting audit history.
- Verify Dashboard, Telegram and scheduler use the same lifecycle projection.

### Work block 5 — Reliability canary

- Run a small synthetic Feature through plan, task, review, merge and restart.
- Record time, provider transitions, retries and terminal reason.
- Fail closed when runtime health or reconciliation is incomplete.
- Publish a short operator report with the next safe action.

## Acceptance criteria

- A real Windows integration test proves the updater cannot terminate itself.
- Interrupted updates converge to `completed`, `rolled_back` or `failed`; none stay
  indefinitely `in_progress`.
- Goal-budget exhaustion is never shown as a provider failure.
- Preserved work can be continued from its checkpoint without redoing completed work.
- Completed Feature Plans are absent from the active queue and remain available in
  history.
- Duplicate GitHub events produce exactly one final review and one update attempt.
- Dashboard and Telegram expose the same reason, source, checkpoint and next action.

## Operating guidance until the follow-up ships

- Keep self-update supervised and bounded.
- Review preserved work before increasing a Goal step budget.
- Use the Feature Plan history view for completed and cancelled plans.
- Treat `budget_exhausted` as a planning signal, not a provider outage.
