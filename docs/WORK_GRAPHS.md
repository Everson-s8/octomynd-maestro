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
- handoffs and reports are sanitized, hashed and stored outside coordinator context;
- scope violations preserve changes for inspection and block the graph fail-closed.

## Lifecycle

```text
draft -> validated -> running -> completed
                         |  \
                         |   -> waiting_provider -> running
                         -> blocked
draft/validated/waiting_provider -> cancelled
```

Running cancellation is intentionally unavailable from Dashboard and Telegram until a resident
Work Graph coordinator can abort the active provider process. Reporting a graph as cancelled while
its process still runs would violate the execution contract.

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
