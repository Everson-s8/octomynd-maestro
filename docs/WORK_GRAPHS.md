# Work Graph Runtime

The Work Graph is the Maestro-owned multi-agent execution primitive. Providers execute bounded
Worker Nodes; they do not own the workflow or communicate independently with the user.

## Invariants

- one Work Graph per Goal run;
- at most four nodes and two concurrent read-only nodes;
- at most one writer, always serialized;
- only an `implementer` may be a writer; every other role is read-only in this release;
- read-only mode is enforced by provider adapters: Codex uses a read-only sandbox and Claude uses plan mode without edit/write tools, including tester nodes;
- the runner fingerprints dirty repository paths before and after every Worker, blocking any mutation by a read-only Worker as a fail-closed fallback;
- every node declares role, capability, dependencies, output contract and budgets;
- a writer declares repository-relative write scopes;
- provider absence moves the graph to `waiting_provider` without spending an attempt;
- provider waits emit typed, redacted evidence while the resident coordinator owns their retry timer;
- handoffs and reports are sanitized, hashed and stored outside coordinator context;
- the resident `WorkGraphCoordinator` owns one `AbortController` per active graph and deduplicates
  active execution by both Work Graph id and Goal run id;
- scope violations preserve changes for inspection and block the graph fail-closed.

## Lifecycle

```text
draft -> validated -> running -> completed
                         |  \
                         |   -> waiting_provider -> running
                         -> blocked
draft/validated/running/waiting_provider -> cancelled
```

Dashboard and Telegram cancel through the shared application command. If the graph is active, the
resident coordinator aborts the provider with the graph `AbortSignal`, waits for the execution to
settle, marks the graph and unfinished nodes as cancelled, and leaves Goal lifecycle, worktree changes
and artifacts intact for the owning workflow.

On Maestro restart, the coordinator recovers `draft`, `validated`, `running` and `waiting_provider`
graphs from the existing `src/work-graphs` persistence. An interrupted running Worker attempt is
finalized as cancelled evidence; if budget remains, recovery creates one new attempt with correct
provider lineage. Completed nodes and artifact keys are never duplicated.

Work Graph completion is not Goal completion. The runner only owns Work Graph and Worker state;
validation, review, delivery and terminal Goal/Task transitions remain in the Goal lifecycle.

## Scheduling

The scheduler selects dependency-ready nodes. Independent readers may run in one parallel batch up
to `maxParallelReaders`. A writer runs only when no other node is active and all dependencies have
completed. Failed nodes may retry only within their attempt budget.

## Evidence

Each attempt writes two bounded artifacts below the configured artifact root:

```text
goal-{run}/work-graph-{graph}/node-{key}/attempt-{n}/handoff.md
goal-{run}/work-graph-{graph}/node-{key}/attempt-{n}/result.json
```

The database records relative keys, kind, byte count and SHA-256 content hash. Downstream workers
receive only artifact keys and sanitized summaries, not the full output of every prior worker.

## Current activation policy

The deterministic complexity classifier and runtime are available, but automatic activation is off
in the first release. Simple Tasks continue through the existing single-agent Goal path. A later
feature may enable automatic selection after before/after telemetry demonstrates quality or latency
benefit without uncontrolled token multiplication.

## Goal lifecycle integration

A Work Graph only executes when `MAESTRO_WORK_GRAPH_MODE=explicit` **and** the Task's persisted
`FeatureTaskContract.workGraphRequest` declares one. `off` and `shadow` never create or run a Work
Graph, even when a request is persisted; the heuristic classifier only ever produces telemetry. See
[Explicit Work Graph execution inside the Goal lifecycle](GOAL_RUNTIME.md#explicit-work-graph-execution-inside-the-goal-lifecycle)
for how the `implementing` phase creates, validates, runs and hands off the graph without repeating
implementation or bypassing validation, review or delivery.
