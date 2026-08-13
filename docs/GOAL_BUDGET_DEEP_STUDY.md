# Goal Budget & Loop Control — Deep Study

**Status:** Draft — review before implementation
**Date:** 2026-08-13
**Author:** Octomynd Maestro team
**Scope:** How the orchestrator decides *when a goal is done* and *when to stop it* — the budget / loop-control machinery.

---

## 1. TL;DR (the problem in one paragraph)

The orchestrator terminates goals two ways: either a reviewer approves, or a **step budget is exhausted**. The budget is derived from a **heuristic text classifier** (`computeTaskDNAFromText`) that systematically **under-sizes real features**, and when a budget trips the goal becomes **`blocked` = terminal** with **no automatic retry**. Real data shows this is the single biggest killer: **18 of 19 blocked goals** died on `budget_exhausted` ("Goal reached its N-step budget"), several at only **7 steps** for genuinely medium/large work. The result is a system that routinely *kills healthy, progressing work* and then *demands a human to press retry* — the opposite of autonomous delivery.

---

## 2. What exists today (with code references)

### 2.1 The termination decision
- **Loop**: `src/goals/runner.ts:149` — `while (stepCount < run.maxSteps)`.
- **Global kill switch**: `runner.ts:1026` — `finishRun(..., "blocked", ..., "budget_exhausted")` when the loop exits without completing → `"Goal reached its ${maxSteps}-step budget."`
- **Phase kill switch**: `runner.ts:205` / circuit-breaker `observe()` (`src/goals/circuit-breaker.ts:110`) — `phase_budget_exhausted`.
- **Success signal**: `runner.ts:885` — `reviewDecision === "approved"` breaks the loop → deliver. OR `testsPassed` in the last phase (`runner.ts:913`). OR a `trivial` task with no file changes (`runner.ts:895`).

### 2.2 How `maxSteps` and phase budgets are decided
- `src/goals/coordinator.ts:62` — `computeTaskDNAFromText(task.text)` → `dnaMaxSteps = sum(phaseBudgets) + 5`.
- `src/goals/task-dna.ts:139` — `computeTaskDNAFromText` is a **word-count heuristic**:
  - `length < 100 && fix && !multiple` → trivial (**2 implement steps**)
  - `length > 400 || actionCount >= 5 || (feature && multiple && length > 250)` → large
  - `feature && !architecture && length < 300 && !multiple` → small (**3+2=5 steps**)
  - else default → medium (**2+5+3+4=14 steps**)
- Phase budgets are `per-phase` ceilings (`task-dna.ts:23-26, 75, 96, 112, 127`).

### 2.3 Why `blocked` is terminal (no auto-retry)
- `src/backlog/autopilot.ts:99` — autopilot only picks up tasks whose **goal status is `running` or `waiting_provider`**. A `blocked` goal is invisible to it.
- Auto-retry exists **only for `waiting_provider`** (`runner.ts:1195-1229` — `nextRetryAt`, `pauseRun`). There is **no auto-retry for `budget_exhausted`**.
- Manual retry exists: `coordinator.ts:123 retryRun` (`POST /api/tasks/:id/retry`), which does **not** raise `maxSteps` — retrying can immediately re-hit the same ceiling.

### 2.4 The "no measurable progress" detector (bug that kept recurring)
- `circuit-breaker.ts:172-186` — `no_progress` compares `workspaceBefore === workspaceAfter` **only for `implementing`/`testing`**.
- The `reviewing` phase never writes the worktree, so `worktreeChanged` is false there (fixed in `54`/PR#114, but the deeper issue is the detector conflates "stable worktree" with "stuck").

---

## 3. Real data (measured)

Dashboard snapshot of all goals (19 blocked):

| Cause | Count | Examples |
|---|---|---|
| `budget_exhausted` (global step cap) | 18 | tasks #83-94, #97, #92, #91, #90, #88, #87, #86, #84, #101… |
| `phase_budget_exhausted` (reviewing) | 1 | task #96 |

Key observations:
- **6 of those died at a `7-step` budget** — i.e. the text classifier said "small" (5 steps + 2) for work that was clearly more.
- Several features that the classifier sorted as small/medium reached `24-27 steps` (real work) yet were still killed on the cap instead of being delivered.
- The **completion rate is poor**: 5 completed vs 19 blocked vs 1 failed.

---

## 4. Architectural flaws

1. **Fragile "done" oracle.** Completion is gated on `reviewDecision === "approved"` and a step budget. There is a persisted `acceptanceCriteria` (intake) but it is **not deterministically verified** against the produced worktree. The system cannot say *"criteria met → done"*; it can only say *"the reviewer said ok"* or *"we spent enough steps"*.
2. **Heuristic sizing is a blunt instrument.** Word-count rules mislabel real features, producing ceilings too small (7 steps) that kill legitimate medium/large work.
3. **Budget as a hard terminal kill vs. a real loop guard.** The budget is meant to stop infinite loops, but it is implemented as a **terminal state** (`blocked`) that neither auto-retries nor re-raises — so a single under-estimate is fatal. Loop-safety and *budget exhaustion* are conflated.
4. **No auto-recovery path.** `blocked` goals (the dominant outcome) require a human operator to call `/retry`. An autonomous orchestrator must self-recover from a benign budget trip.
5. **Progress detection is phase-narrow.** `no_progress` only guards `implementing`/`testing`, and conflates "stable worktree" with "stuck" (reviewing reads, doesn't write). Real stall must be measured by *evidence produced*, not file-hash deltas alone.

---

## 5. Reference comparison

| Concern | Maestro (today) | Hermes | LangGraph / production agent tools |
|---|---|---|---|
| "When is a task done?" | Reviewer approval OR test-pass | (user-in-the-loop) | Node terminates when a `conditional_edge` predicate matches **ground truth**, not step count. |
| Stop a loop | Step budget → terminal `blocked` | configurable    | **Max iterations** is a *safety harness*, not the completion signal. The graph reaches an explicit terminal node. |
| Recover from budget trip | Manual `/retry` | —              | State checkpoint + resume with **relaxed/higher** budget and prior artifacts. |
| Size the task | Word-count heuristic | —              | Decompose into sub-graphs; each sub-goal has its own bounded scope. |

Key lesson: **a budget should bound a loop as a safety ceiling — it should never be the normal way a task ends.** Completion must be *evidence of correctness* (criteria met / review approved), and a budget trip should trigger **resume-with-adjusted-capacity**, not a dead end.

---

## 6. Proposed redesign (prioritized)

### P0 — Budget trip becomes retryable, not terminal  *(kills the #1 dead-end)*
- On `budget_exhausted` / `phase_budget_exhausted`, **do not** force status `blocked`. Instead transition to `waiting_provider`-like retry with:
  - preserved worktree + checkpoint (already exists),
  - an **elevated ceiling** (e.g. `maxSteps *= 1.5`, or re-derive PhaseDNA from the *observed* file count, not the text heuristic),
  - a retry count with a hard safety cap (e.g. 2 automatic re-raises) to still prevent true runaway.
- Autopilot counts these as recoverable, en route. Human `/retry` stays as a manual override.

### P1 — Determine "done" by verified criteria, not step budget
- Introduce a **verification step** that checks the yielded artifacts against `acceptanceCriteria` (existence of changed files, test/typecheck green, PR diff non-empty). If criteria are deterministically satisfied → `completed`.
- Reviewer approval remains the *human-quality* gate; verification becomes the *objective* gate. Both can be required, but neither should depend on step count.

> **Design note (from product discussion):** `planning` is **kept as a lightweight anchor**, not eliminated. A short upfront plan is cheap and gives the agent a script so it does not drift in "free mode" (no hard step ceiling). It must not, however, be a step-consuming phase that can kill the goal. `testing` (deterministic validation) is the valuable objective gate and stays; `review` is a single final gate that loops back to coding on problems. The loop becomes: *plan (anchor) → code → test (objective) → review (final) → fix → deliver*.

### P2 — Replace the text heuristic with observed sizing
- Derive the PhaseDNA from **measured signals** gathered during the run (files touched so far, LLM output size, `git diff` stat) rather than word-count at intake. Budgets become *adaptive ceilings* mid-run, not frozen predictions.
- Keep the heuristic only as an initial guess; recompute after N steps against reality.

### P3 — Real loop detection
- Extend `no_progress` to the `reviewing` phase using **evidence produced** (new review decisions, artifacts, messages), not worktree hashes.
- Track: repeated identical decision, zero decisions, same error fingerprint, no file delta — as **distinct** signals, each with its own threshold.
- A loop is *confirmed* when evidence is absent; a flat code path is not itself a loop.

### P4 — Long-term: explicit completion contract per US
- Persist a `Definition of Done` per task (from intake: criteria + required tests + PR). The runner exits `completed` when DoD is met; every other exit (deadline/budget/loop) is a *recoverable* interruption with a clear resume path. Autonomy = DoD-driven, not step-driven.

---

## 7. Hard decisions (need sign-off)

1. **Is auto-retry-with-raised-budget acceptable?** It trades "may burn more compute" for "stops killing healthy work". Need a max-retries cap so a genuinely looping task still stops (recommend cap=2 auto re-raises, then require human).
2. **Is deterministic verification of acceptance criteria trustworthy enough to mark `completed`?** Or should human/LLM review remain the *only* approval? (Recommend: verification approves resolution, reviewer approves quality — both required, neither step-counted.)
3. **Should the text-classifier sizing be kept at all**, or fully replaced by observed sizing on first contact? (Recommend: keep as seed, override from observation.)
4. **Scope of this change** — do it in one PR (P0-P3 together, since they interlock) or staged (P0 alone first, because it alone removes the #1 dead-end)?

---

## 8. Suggested follow-up

- Prototype P0 as a spike first (small, verifiable): change `finishRun` on budget to schedule a resume with elevated ceiling; validate on a replay of the 18 blocked goals to confirm they now complete.
- Instrument telemetry: count `completed` vs `blocked` vs `recovered` to confirm the fix moves the completion rate.
