# Octomynd Maestro

A local, chat-first orchestrator for Antigravity, Codex, Claude, and GitHub workflows, with a
local visual command center to track projects, backlog, agents, and events.

Maestro uses the authenticated CLIs of Antigravity, Codex, and Claude. It does not require
`OPENAI_API_KEY` and does not create a separate OpenAI API billing surface.

This first version validates Telegram as the main control surface. It receives commands, creates
local tasks, stores events in SQLite, and keeps secrets out of Git.

Telegram belongs to the Maestro gateway, not to every managed project. Projects only need their own
Telegram integration when that is an explicit product requirement. When a goal opens a draft pull
request, Maestro sends the restricted Telegram user a review notification with the public PR URL.

## Requirements

- Node.js 20.17.x for local development and CI. `.node-version`, `package.json`,
  and GitHub Actions share the same runtime contract.
- A Telegram bot token from BotFather.

## Setup

```powershell
npm install
Copy-Item .env.example .env.local
```

Fill `.env.local`:

```text
TELEGRAM_BOT_TOKEN=your-token
TELEGRAM_ALLOWED_USER_ID=optional-your-telegram-user-id
```

`TELEGRAM_ALLOWED_USER_ID` is optional, but recommended before leaving the bot running.

## Commands

```powershell
npm run smoke
npm run dev
npm run dev:platform
npm test
```

## Visual platform

The dashboard reads real data from SQLite and stays restricted to the local machine.

### Provider control plane

The `Providers` dashboard section is the operational interface for AI routing. It persists provider
mode (`enabled`, `paused`, or `disabled`), fallback permission, preferred provider by capability,
and optional strict provider requirements in SQLite. Changes apply to the next lease without a
runtime restart. The `Use only this provider` action pauses every other connected provider and
disables fallback for the selected one; it is intended for temporary quota conservation.

Routing remains fail-closed: a required, paused, unhealthy, or unavailable provider does not
silently fall through to another provider. With automatic fallback enabled, the configured order is
used before the built-in defaults.

```powershell
npm run dev:platform
```

- UI: `http://127.0.0.1:4788`
- Local API: `http://127.0.0.1:4787`
- Build: `npm run build:ui`
- Typecheck: `npm run typecheck:ui`

To run the full runtime on Windows with PID, logs, and health check:

```powershell
.\scripts\maestro-runtime.ps1 start
.\scripts\maestro-runtime.ps1 status
.\scripts\maestro-runtime.ps1 restart
.\scripts\maestro-runtime.ps1 stop
```

The controller only considers startup complete once
`http://127.0.0.1:4787/api/dashboard` responds. Logs and PID live under
`.maestro/runtime/`, outside Git. Maintenance should end with a green `status`;
stopping the process also stops the Dashboard, Telegram, and coordinators.

The interface lets you watch the daemon state, projects, backlog, agents, and events, as well as
create local tasks as `queued`, open details, and prepare an isolated worktree. A prepared task can
start an autonomous goal with planning, implementation, testing, and review. Antigravity, Codex, and
Claude are routed by capability; when all are unavailable or out of quota, the goal is persisted in
`waiting_provider` and resumed automatically without losing completed steps.

The `AgentRegistry` is the single source for provider capacity, load, health, and cooldown. The
Dashboard and the `/status` Telegram command show the same operational state, without inferring
authentication or availability through separate visual rules.

Antigravity uses the Google subscription authenticated in the CLI, with no API key in the project.
By default it receives planning, implementation, testing, research, and improvement review before
providers with scarcer quota. Claude remains the first choice for independent Final Review. Work
Graphs may use different providers on independent nodes, but never allow two concurrent writers on
the same Task.

After review, Maestro checks for secrets, creates a commit, pushes the branch, and opens a draft PR.
For a standalone Task, merge remains a human decision. In a Feature, Work PRs stay Draft as evidence
and are never merged individually. The only merge candidate is the consolidated Feature PR: when the
user marks it Ready for review, Maestro validates checks and mergeability, runs a read-only Final
Review on the exact SHA, and if approved merges it, closes the Work PRs, and cleans up integrated
branches. Any change to the SHA or a gate failure invalidates the review and prevents the merge.

## Multi-agent Work Graph

Complex tasks can be represented as a governed DAG of up to four Worker Nodes. Maestro remains the
manager: it validates dependencies and budgets, allows at most two simultaneous readers, and
serializes a single writer with a declared write scope. Large results live in redacted artifacts;
downstream workers receive only references and bounded summaries.

The Dashboard shows graphs, nodes, attempts, budgets, and evidence. On Telegram:

- `/graphs [@project]` lists Work Graphs and their nodes;
- `/graph_cancel <id>` cancels stuck graphs and preserves all audit;
- `/status` includes active Work Graphs.

Canceling a running graph fails closed until a resident coordinator can propagate `AbortSignal` to
the provider. The complexity classification and runtime are ready, but automatic activation for
every Task remains off in this first release to avoid multiplying tokens on simple requests.

## Human review queue

Delivered draft PRs appear under **Awaiting review** with project, request, agents, review summary,
relative files, tests, and the secret-guard result. The responsible person records a justification
and chooses:

- **Approve standalone PR for merge**: runs `gh pr ready`; does not merge.
- **Request changes**: returns the PR to draft and reopens the same goal into implementation,
  including the justification in the agent context.
- **Reject**: closes the PR without merging and ends the task as rejected.

All decisions live in SQLite and generate events and Telegram notifications. Secrets, private IDs,
and local paths are removed from the visual payload; justifications containing a secret or private
path are blocked before persistence or delivery.

This manual decision queue differs from the Feature PR protocol described above. Marking only the
consolidated Feature PR as Ready for review authorizes Final Review and the governed automatic merge;
individual Work PRs must stay Draft.

The visual direction is documented in `docs/VISUAL_IDENTITY.md`.

## Safe learning

The panel includes a proposal lab inspired by the Hermes Agent learning loop. Each candidate records
category, rationale, proposed change, evidence, risk, and origin. The user can approve or reject,
but **approving does not apply the change automatically**: it creates a new Task and a Feature Plan,
which then go through the normal flow of isolated worktree, validation, Draft Work PR, and Final
Review only on the consolidated Feature PR.

When a Feature finishes, an idempotent SQLite outbox records a limited, sanitized evidence package
with provenance. A background reviewer uses Codex or Claude in strictly read-only mode with at most
two attempts. A deterministic evaluator rejects invented, duplicate, low-confidence, or understated
evidence, and any attempt to alter the Constitution, secrets, approvals, audit, permissions, or
rollback. The reviewer never writes skills, memory, or code.

Governance is separated from persona:

- `docs/MAESTRO_CONSTITUTION.md`: protected principles agents cannot edit;
- `docs/HERMES_APPLIED_STUDY.md`: conclusions of the study and prioritized elements;
- a future `SOUL.md`: tone and personality only, with no power to change security.

## Governed Skills

The Skills runtime uses portable packages with a `SKILL.md`, optional policy in `maestro.yaml`, and
deterministic cases in `evals/cases.yaml`. Discovery loads only metadata; instructions enter the
prompt only after selection and are bounded by budget. Each Goal pins the exact hash of the version
used, the trigger reason, and the invocation mode.

It is off by default. To enable the three initial Skills:

```text
MAESTRO_SKILLS_ENABLED=true
MAESTRO_SKILLS_PATH=skills
MAESTRO_SKILL_VERSIONS_PATH=.maestro/skill-versions
MAESTRO_SKILLS_PROJECT_KEY=maestro
```

- `diagnose-goal-failure`: can be selected implicitly, but is read-only, off-network, and
  write-free.
- `final-feature-review`: can be selected implicitly only during review, off-network and write-free.
- `implement-task-safely`: requires explicit selection and limits writes to the prepared workspace.

On startup, only the system Skills allowlist can pass eval, approval, and activation automatically.
Additional packages stay as `candidate`. A version fails closed if triggers, guardrails, syntax, or
policy regress. The Dashboard and Goal evidence show versions, results, duration, and estimated
tokens, but never persist or expose the Skill's private instructions.

## Autonomous goal

A prepared task can start a persistent execution from the panel. Maestro advances alone through
planning, implementation, testing, and review. When the review requests changes, the flow returns to
implementation without requiring the user to update the task. The state and every step live in
SQLite.

The contract, routing, and limits are documented in `docs/GOAL_RUNTIME.md`.

## Telegram Commands

- `/start` shows the bot introduction.
- `/help` shows available commands.
- `/status` shows daemon status, active goals, and agents currently working.
- `/status @<key>` shows the active work for one project.
- `/projects` lists registered projects.
- `/project_add <key> <repo-path>` registers a local Git project.
- `/task @<key> <text>` creates a local task for a project.
- `/queue` lists recent tasks.
- `/queue @<key>` lists recent tasks for a project.
- `/graphs [@<key>]` lists governed Work Graphs and node budgets.
- `/graph_cancel <id>` cancels an idle Work Graph while preserving evidence.
- `/cancel <id>` cancels an active, waiting, or queued task without deleting its history.
- `/doctor [@<key>]` verifies deterministic execution and provider readiness.
- `/improvements` lists governed improvement candidates.
- `/improve_approve <id>` approves a candidate as a new Task + Feature Plan.
- `/improve_reject <id>` rejects a candidate while preserving its audit history.

The governed backlog autopilot is enabled by default. It starts at most one running goal at a time,
keeps `waiting_provider` goals from consuming that global slot, and evaluates Feature Task
dependencies before preparing a worktree. Same-project parallelism requires explicit disjoint
mutation scopes; dependent Tasks inherit exact validated ancestor commits through a deterministic
baseline branch. Exact duplicates of delivered/completed work are marked `blocked` for human review
rather than silently discarded. Configure it with `MAESTRO_AUTOPILOT_ENABLED`,
`MAESTRO_AUTOPILOT_POLL_MS`, and `MAESTRO_AUTOPILOT_MAX_CONCURRENT`.

- Any plain text message is saved as feedback.

Final goal notifications are proactive: completed goals with a draft PR send a concise review
request. The notification excludes local worktree paths, credentials, and private Telegram
identifiers. Phase updates are also sent when an agent starts planning, implementation, testing, or
review, regardless of whether the task originated in Telegram, the dashboard, or another local
surface.

## Task lifecycle controls

The task detail panel supports two governed actions:

- **Cancel task** interrupts an active Codex or Claude subprocess and preserves execution history.
- **Delete task** is limited to tasks without a worktree or goal history.

Pull requests are reconciled with GitHub while the dashboard is active. A PR merged outside the
dashboard automatically marks its task as completed and leaves the human review queue.

Example:

```text
/project_add octomynd C:\Users\evers\OneDrive\Imagens\TCC\octomynd_publish
/task @octomynd improve out-of-context response
/queue @octomynd
```

## Continuous Integration

`.github/workflows/ci.yml` runs on every pull request and on pushes to `main`. It is
fail-closed: any failing step blocks the workflow, and no step ignores errors or masks a non-zero
exit code. The workflow does not deploy and does not merge pull requests.

Required checks (all must pass):

1. `npm ci` — clean, reproducible dependency install.
2. `npm run typecheck` — backend TypeScript typecheck.
3. `npm run typecheck:ui` — UI TypeScript typecheck.
4. `npm test` — full Vitest suite.
5. `npm run build:ui` — production UI build.
6. Secret scan — greps tracked files for the secret patterns used by
   `src/security/redaction.ts` (API keys, bot tokens, private key headers) and fails the
   run if any match. Only filenames are reported; matched secret values are never
   printed to logs.

The Goal runtime applies the same validation policy before review. Passing checks skip a separate
LLM testing pass; failures are stored as sanitized artifacts and summarized into a compact
correction handoff.

The workflow uses `permissions: contents: read` (no write access), a `concurrency` group keyed on
workflow and ref to cancel superseded runs, and `actions/setup-node` with `cache: npm` keyed on
`package-lock.json` for safe, deterministic caching.

## Local Data

The local SQLite database is stored at `.maestro/maestro.db` by default. The folder is ignored by Git.

## Safety Defaults

- No token or `.env.local` file is committed.
- The bot does not print the Telegram token.
- Local database and logs are ignored.
- If `TELEGRAM_ALLOWED_USER_ID` is set, other users are blocked.
- The dashboard validates the host and only accepts `127.0.0.1` or `localhost`.
- Tokens and private Telegram IDs never enter the interface payload.
