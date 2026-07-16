# Governed backlog autopilot

The backlog autopilot converts a user-created `queued` task into a prepared, persistent goal when
runtime capacity is available. It automates task pickup, not approval or delivery authority.

## Rules

- Start at most `MAESTRO_AUTOPILOT_MAX_CONCURRENT` running goals. The default is one, which also
  limits provider concurrency conservatively.
- A `waiting_provider` goal does not consume the global running slot, so an independent project can
  continue while another provider waits for quota or authentication.
- A project with unrelated running or waiting work remains occupied. Tasks in the same Feature may
  share capacity only when both contracts explicitly allow parallel execution and mutation scopes
  are disjoint.
- `queued` and `waiting_dependency` tasks are candidates for dependency evaluation.
- A dependent Task starts only after every ancestor is delivered and validated. A failed, rejected,
  blocked or cancelled ancestor blocks the descendant instead of letting it run against stale code.
- A dependent worktree starts from a deterministic baseline containing the exact delivered commits
  of its transitive dependencies.
- A task without a project is marked `blocked` for human review.
- An exact normalized duplicate of `awaiting_human`, `ready_to_merge`, or `done` work in the same
  project is marked `blocked`; it is never silently deleted.
- Preparation failures become `blocked` with a sanitized audit event.
- Every automatic start or block emits an event.
- Merge, deploy, learning activation, and human review gates are unchanged.

## Visibility and control

- Dashboard snapshots expose enabled state, capacity, running/waiting counts, queue size, last action,
  and last tick time.
- Telegram `/status` shows the autopilot state and capacity.
- Telegram `/cancel <id>` and the Dashboard task controls cancel active or waiting work while keeping
  execution history.
- Set `MAESTRO_AUTOPILOT_ENABLED=false` to disable automatic pickup.
