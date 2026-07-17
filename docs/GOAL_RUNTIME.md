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

## Token-efficient handoff runtime

Goal handoffs between phases use a token-efficient runtime. Each completed step keeps the sanitized
provider output in SQLite, writes a sanitized raw output artifact under `.maestro/runs/`, and sends
only a compact structured handoff to the next worker. The compact handoff preserves concrete errors,
review decisions, changed-file evidence, search hits, Git evidence and test failures while omitting
bulk diff/log/test noise. Raw artifacts can be recovered on demand from the step artifact key.
Equivalent handoffs are deduplicated before the next provider call, keeping the newest evidence and
recording `goal.handoff_deduplicated` without deleting the original steps or artifacts.

The runtime records paired A/B telemetry for every step: the legacy 2,000-character slice as control
and the compact handoff as treatment. Telemetry includes estimated bytes and tokens by provider,
phase and detected command family (`git.diff`, `git.status`, `git.log`, `rg`, `test` or
`provider.output`), plus artifact keys. Metrics never include raw output text.

If a local `rtk` executable or npm-global RTK package is already present, the runtime records that
fact. It never installs, downloads or updates RTK. When RTK is absent, the internal compressor is used
transparently. The adapter can be disabled with `MAESTRO_TOKEN_RUNTIME_ENABLED=false`, without
changing delivery gates, review gates or final Feature PR completion rules.

## Deterministic validation

The testing phase first calls one deep Maestro module with an allowlisted command
catalog: `git diff --check`, changed-file secret scan, backend/UI typecheck, Vitest
and the UI build. Commands run without a shell and cannot be supplied by a model.
Raw sanitized output is retained as an artifact while only a compact actionable
failure is handed to a provider.

Diff and secret checks are cheap fail-closed gates. When either fails, expensive
typecheck, test and build commands do not run. A clean validation advances directly
to review without spending a testing-provider call. A failed validation permits one
testing provider to repair the worktree, then the deterministic checks run again.

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
`waiting_provider`, the goal persists its typed wait reason and `nextRetryAt`, and the same run is
resumed later.
Retryable provider failures are recorded as attempts but do not consume the goal's semantic step
budget. When a waiting run resumes, the last failed provider is temporarily excluded so an
available fallback is tried first. If no alternative exists, the original provider remains eligible
for a later retry.

The provider control plane computes the earliest recovery across every capable provider. A Claude
quota failure therefore cannot force a ten-minute wait when Codex's timeout cooldown ends in fifteen
seconds. Provider preflight failures create a durable waiting Goal; only deterministic environment
failures block before Goal creation.

The `AgentRegistry` is also the provider control plane. It owns concurrency leases and transient
cooldowns, and exposes one operational snapshot with `ready`, `working`, `quota`, `auth_required`,
`cooldown`, or `offline`. Dashboard and Telegram consume this same snapshot instead of inferring
provider state independently. A provider adapter must report an explicit `retryAfterMs` before a
retryable failure creates a cooldown; this preserves immediate fallback while preventing known
timeouts or quota failures from being selected repeatedly.

## Current providers

- **Codex**: real non-interactive CLI adapter for planning, coding, testing, review, and research.
  Coding/testing use `workspace-write`; planning/review use `read-only`. Output is constrained by a
  JSON schema and artifacts are stored under `.maestro/runs/`.
- **Claude**: real CLI adapter for planning, coding, testing, review, and research. Planning/review
  use `plan` with read-only tools. Coding uses `acceptEdits` without shell access. Testing adds only
  allowlisted test and read-only Git commands. Commit, push, destructive Git cleanup, network
  download tools, cloud CLIs, package publication, PR merge, and release commands are explicitly
  denied. Authentication, subscription quota, and timeout failures are classified as retryable.

Codex and Claude share the same process runtime for bounded output, stdin, timeout, cancellation,
and Windows-hidden subprocess execution. Provider adapters only define CLI arguments, phase policy,
prompting, and result classification. Credential-shaped environment variables are removed before
either worker process starts; subscription authentication continues through the installed CLIs.

## Resumable execution and circuit breakers

Provider execution uses progress-sensitive limits instead of a short wall-clock timeout:

- Codex stops after ten minutes without stdout/stderr activity by default;
- Claude `--print` stops after thirty minutes without activity by default because it can buffer
  useful work longer;
- provider total runtime and Goal total deadline are optional environment policies and are disabled
  by default;
- repeated identical output and excessive received output stop the process early;
- the same normalized provider failure stops after two occurrences;
- implementation or testing that completes twice without worktree progress blocks the goal.

All stops preserve the isolated worktree. The runner does not reset, clean, or discard partial work.
Every writable step stores a durable checkpoint with changed files, worktree fingerprint and artifact
references. Provider fallback receives that checkpoint. On Maestro restart, an orphaned running step
is closed as interrupted, the checkpoint is captured, and the same Goal is scheduled from its
persisted state. If the worktree is missing, recovery fails closed instead of rebuilding silently.
Every step also records bounded process output statistics and whether a worktree change was observed.
Fallbacks emit `goal.provider_fallback`; circuit breakers emit `goal.circuit_breaker` with the reason
and `worktreePreserved=true`. This makes quota, timeout, output flood, repeated failure, and no-progress
conditions distinguishable without another LLM call.

The Maestro does not use the OpenAI API and does not require `OPENAI_API_KEY`. Codex uses the user's
existing Codex/ChatGPT authentication, while Claude uses its own installed CLI authentication. Each
service can still enforce the limits of the user's plan.

## Safety boundaries

- A task must have a prepared isolated worktree.
- New Windows worktrees default to
  `C:\MaestroRuntime\<project>\worktrees`, outside the user profile and
  cloud-synced folders. Existing Tasks keep their persisted worktree path;
  Maestro never moves an active worktree implicitly.
- `.maestro-execution.json` records the versioned execution contract without
  storing private host paths. Startup emits a sanitized environment fingerprint
  containing only versions, availability flags and path hashes.
- Node `20.17.x` is the pinned runtime line for local execution and CI. A
  divergent major/minor blocks startup before a long Goal can begin.
- `EnvironmentDoctor` is the single readiness seam used by Goal preflight,
  Dashboard and Telegram. It verifies execution/worktree writes, Git, Node,
  npm, dependency preparation, native runtime bindings, TypeScript, Vitest and
  provider readiness. Deterministic `npm ci` keeps lifecycle scripts from the
  trusted lockfile enabled because native modules such as `better-sqlite3`
  otherwise install without a usable binding.
- Goal preflight runs before `goal_runs` is created. Unsafe legacy worktrees,
  missing toolchains or dependency failures become `environment_blocked`
  evidence instead of consuming provider time.
- `/doctor [@project]` reports `ready`, `environment_blocked`,
  `auth_required`, `quota` or `offline` with a short recommended action. The
  Dashboard shows the latest persisted report by project.
- Workers are instructed not to commit, push, merge, deploy, modify credentials, or leave the worktree.
- Every goal has a maximum step budget.
- Every provider has an inactivity limit and output budget; total runtime limits are optional.
- Repeated failures and repeated no-progress phases stop before another provider cycle is spent.
- Missing providers, blockers, failures, and budget exhaustion become explicit durable states.
- Goal artifacts, database, logs, environment files, and credentials remain ignored by Git.
- Completion means all phases succeeded; a planning or implementation response alone cannot finish a goal.
- Workers never publish directly. After review succeeds, the deterministic delivery layer scans for
  secrets, creates a commit, pushes the isolated task branch, and opens a draft pull request.
- Merge is never automatic. A delivered task remains `awaiting_human` with the draft PR URL.
- The Maestro Telegram gateway proactively notifies the restricted user when the draft PR is ready.
  Managed projects do not need to implement Telegram unless their own product explicitly requires it.
- The dashboard review queue exposes only sanitized evidence: relative changed files, providers,
  test-step summaries, security alerts, commit and public GitHub URLs.
- Internal worker handoffs are structured and terse; security decisions, final review, merge
  decisions and important user-facing messages remain explicit and are not compressed into terse
  shorthand.
- Human review decisions require a justification and are stored in `human_reviews`.
- `approved` marks the GitHub PR ready and moves the task to `ready_to_merge`; merge remains manual.
- `changes_requested` returns the PR to draft and reopens the same goal at `implementing`, with the
  sanitized human justification added to the worker context.
- `rejected` closes the PR without merging and moves the task to `rejected`.

## Governed delivery

Delivery is intentionally outside the LLM worker. It is deterministic and idempotent: a retry can
continue from an existing task commit if push or PR creation failed. The secret guard blocks env
files, credential filenames, private keys, and common provider token formats before staging.
GitHub publication requires an authenticated `gh` CLI. The pull request is always created as draft.

Feature Plans can persist GitHub issue links for both the consolidated Feature and its Tasks. The
Draft Feature PR includes closing references, and post-merge cleanup closes Work PRs, branches and
linked issues idempotently. If any cleanup operation fails, the Feature remains in `merging` and is
retried; completion and Telegram notification happen only after the full lifecycle succeeds.

## Dashboard API

```text
POST /api/tasks/:taskId/goal
GET  /api/goals/:runId
```

The task detail panel starts a goal once. The coordinator continues it in the background and the
dashboard refresh shows phase, step count, provider wait, completion, blocker, or failure. Waiting
runs and stale running steps are recovered after a Maestro restart and scheduled for retry from the
latest checkpoint. Delivered goals expose their commit SHA and draft pull request URL.

## Feature Task contracts and dependency execution

Feature Tasks persist an explicit execution contract: objective, acceptance criteria, excluded scope,
mutation scope, dependency IDs and serial/parallel policy. A plan without explicit contracts is
normalized to a fail-closed serial chain for backward compatibility.

Dependencies must point backward inside the same Feature Plan and the graph must be acyclic. A Task
starts only after every dependency is delivered and validated. Failure, cancellation or rejection of
an ancestor blocks its descendants. Independent Tasks may run in parallel in the same project only
when both contracts opt into parallel execution and their mutation scopes are disjoint.

Dependent Tasks receive a deterministic Git baseline assembled from the exact delivered commits of
all transitive ancestors. Their Work PR targets that synthetic baseline. Final Feature assembly still
uses the exact Task delivery commits, preventing accidental inclusion of unrelated branch state.
Review evidence and secret scanning compare the Task against its recorded baseline, so ancestor
changes are not duplicated into the dependent Task's diff or reviewer context.
