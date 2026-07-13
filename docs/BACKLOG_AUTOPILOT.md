# Governed backlog autopilot

The backlog autopilot converts a user-created `queued` task into a prepared, persistent goal when
runtime capacity is available. It automates task pickup, not approval or delivery authority.

## Rules

- Start at most `MAESTRO_AUTOPILOT_MAX_CONCURRENT` running goals. The default is one, which also
  limits provider concurrency conservatively.
- A `waiting_provider` goal does not consume the global running slot, so an independent project can
  continue while another provider waits for quota or authentication.
- A project with a running or waiting goal remains occupied; the autopilot does not create competing
  worktrees for the same project.
- Only tasks still in `queued` are candidates.
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
