# Governed Skills and Multi-Agent Work Graph

Status: accepted

## Context

The Maestro can route durable Goal phases to Codex or Claude and can generate governed improvement
candidates. It does not yet have a reusable procedural Skill runtime or an observable decomposition
model for specialist workers inside a Goal.

Directly enabling autonomous Skill writes or unrestricted Provider-native subagents would weaken the
existing guarantees around provenance, review, budgets, worktree isolation and final Feature review.
Multi-agent systems also add substantial token and coordination costs when work is not genuinely
parallel.

## Decision

Introduce two independent deep modules:

1. A **Governed Skill Runtime** that uses the portable Agent Skills directory structure, adds optional
   Maestro policy metadata, loads content progressively, pins immutable versions per Goal and records
   trigger and outcome telemetry.
2. A **Multi-Agent Work Graph** controlled by the Maestro. It models bounded Worker Nodes with explicit
   dependencies, artifacts, output contracts, budgets and mutation scopes.

The Maestro uses a manager pattern and retains authority over the Goal. Providers are adapters used to
execute Worker Nodes; they do not own the workflow. Provider-native subagents may be added later as
adapters behind the same Worker Node contract.

Initial parallelism is limited to independent read-only nodes. The first implementation permits one
writer node per Goal and rejects overlapping mutation scopes. Large worker outputs are persisted as
artifacts and only bounded summaries and references return to the coordinator context.

Skill self-improvement remains proposal-first. Skill versions are immutable and move through a
candidate, evaluated, approved, active, deprecated and archived lifecycle. User-owned and system-owned
Skills are protected from autonomous curation. Agent-owned Skills require evidence, independent
evaluation, reviewed implementation, activation telemetry and rollback.

## Consequences

- Simple Tasks retain the current single-agent path and avoid extra token cost.
- Complex, read-heavy work can gain parallel speed and independent context windows.
- Skill behavior is reproducible because a Goal records the exact version used.
- A shared Skill format can be used by Codex and Claude while Maestro-specific policy remains local.
- The database and Dashboard will need new Skill, version, evaluation, Work Graph and Worker Node
  records.
- Graph validation, artifact handoffs and writer leases add implementation complexity before native
  subagent delegation is enabled.
- Some Provider-native capabilities will initially remain unused because observability and safety take
  priority over maximum fan-out.

## Rejected alternatives

### Let each Provider manage its own hidden subagents

Rejected as the primary architecture because the Maestro would lose uniform budgets, cancellation,
node state, artifact lineage and write-scope enforcement.

### Use one mutable `SOUL.md` as the learning surface

Rejected because persona, governance and procedural learning have different authority and risk. The
Constitution remains protected, persona remains presentation, and Skills remain versioned procedures.

### Copy Hermes or migrate the runtime to Python

Rejected. The useful ideas are provenance, curation and rollback contracts, not the implementation
language. Rewriting the established TypeScript runtime would add risk without improving the domain
model.

### Allow parallel writers immediately

Rejected until read-only worker graphs, artifacts, cancellation and telemetry are proven. Multiple
writers create merge conflicts and ambiguous ownership that outweigh early speed gains.

### Load every Skill into every prompt

Rejected because it increases context cost and makes selection less reliable. Progressive disclosure
is required.

## Validation

The architecture is accepted only after Feature A demonstrates, on realistic Maestro fixtures, that
selected Skills improve or preserve completion quality while reporting token, duration and Provider
attempt deltas. Multi-agent execution remains disabled by default until Feature B proves bounded
parallel speedup without write conflicts or review degradation.
