# Onboarding Audit: Public Experience for Non-Technical Users

Status: audit only. No product code was changed as part of this task.

## Scope and method

This audit walks the onboarding path a non-technical user would follow today, end to
end, using only the current repository state (no assumptions about unreleased work):

1. Installing the app.
2. Connecting available AI providers (Codex, Claude).
3. Understanding provider health.
4. Creating the first project.
5. Running the first task.

Findings are based on `README.md`, `.env.example`, `scripts/maestro-runtime.ps1`,
`src/environment/doctor.ts`, `src/agents/registry.ts`, `src/agents/codex.ts`,
`src/agents/claude.ts`, `src/commands/application-commands.ts`, `src/telegram/bot.ts`,
`ui/src/App.tsx`, `ui/src/api.ts`, and `docs/MAESTRO_CONSTITUTION.md`.

## Executive summary

Maestro's automation core (routing, environment doctor, Work Graph, PR delivery,
audit trail) is mature and well governed. The public-facing *entry path*, however,
is built for a developer who already has Node.js, Git, GitHub CLI, and the Codex/
Claude CLIs installed and authenticated, and who is comfortable editing `.env.local`
and typing absolute Windows paths into a Telegram chat. For a non-technical user this
path has several hard stops and one materially misleading UI element. None of this
requires deep rework: the underlying data (real provider health, real environment
checks) already exists and mostly just needs to be surfaced and made actionable.

## Findings by stage

### 1. Installing the app

**Current state**: `README.md` requires manual `npm install`, copying
`.env.example` to `.env.local`, and filling in `TELEGRAM_BOT_TOKEN` by hand after
creating a bot via BotFather. Running the app requires PowerShell familiarity
(`scripts/maestro-runtime.ps1 start`) and there is no installer, setup wizard, or
guided first-run screen.

**Friction / risk**:
- No non-technical user will independently create a Telegram bot via BotFather,
  find their numeric user ID, and hand-edit an env file.
- `GitHub CLI` (`gh`) is a hard dependency for the entire PR delivery path
  (`src/features/assembly.ts:312`, `src/features/github.ts:182`,
  `src/goals/delivery.ts:124`, `src/reviews/github.ts:48`) but is **not listed** in
  the README "Requirements" section and is **not checked** by
  `EnvironmentDoctor` (`src/environment/doctor.ts`). A user can complete setup,
  create a project, run a task, and only discover the missing/unauthenticated `gh`
  CLI when delivery silently fails deep into a goal run.

**Affected modules**: `README.md`, `.env.example`, `scripts/maestro-runtime.ps1`,
`src/environment/doctor.ts`.

### 2. Connecting available AI providers

**Current state**: Codex and Claude are detected by checking for a globally
installed npm CLI binary path (`resolveCodexCliEntry` in `src/agents/codex.ts:376`,
`resolveClaudeCliCommand` in `src/agents/claude.ts:117`). Authentication
(`codex login` / `claude login`) happens entirely outside Maestro, in a terminal,
with no in-app prompt, deep link, or verification step.

**Friction / risk**:
- Presence of the binary is conflated with readiness. A provider whose CLI is
  installed but not logged in reports `state: "ready"` at health-check time
  (`codex.ts:67-76`, `claude.ts:115-122`); the `auth_required` classification only
  fires reactively, after a real execution attempt fails
  (`codex.ts:149-150`, and the equivalent Claude failure path).
- There is no UI affordance to install the CLIs or trigger login from the
  dashboard; the user must know the npm package names
  (`@openai/codex`, `@anthropic-ai/claude-code`) and CLI login commands from
  outside documentation.

**Affected modules**: `src/agents/codex.ts`, `src/agents/claude.ts`,
`src/agents/registry.ts`, `ui/src/App.tsx` (`AgentDock`).

### 3. Understanding provider health

**Current state**: Real, per-provider health is computed by `AgentRegistry.snapshot()`
(`src/agents/registry.ts:172-195`) and rendered honestly in the "Agentes conectados"
panel (`AgentDock`, `ui/src/App.tsx:773-806`), with states `ready` / `working` /
`attention` / `offline` and a short `detail` string.

**Friction / risk**:
- The `detail` strings ("Codex CLI nao encontrado", "Claude CLI nao encontrado")
  are short, in Portuguese only, and give no remediation step (what to install,
  which command to run, where to log in).
- Separately, the hero section (`HeroConsole`, `ui/src/App.tsx:289-296`) renders
  **hardcoded** status chips — `Codex<small>ready</small>` and
  `Claude<small>review</small>` — that are static markup, not bound to
  `data.agents`. This is the single most misleading element in the current UI: it
  always shows "ready" even when both providers are actually offline or
  unauthenticated, directly contradicting the accurate `AgentDock` panel a few
  sections below.

**Affected modules**: `ui/src/App.tsx` (`HeroConsole`, `AgentDock`),
`src/agents/registry.ts`, `src/agents/codex.ts`, `src/agents/claude.ts`.

### 4. Creating the first project

**Current state**: There is no dashboard UI to register a project. The only path
is the Telegram command `/project_add <key> <repo-path>`
(`src/telegram/bot.ts:122`, `src/commands/application-commands.ts:179-215`), which
requires the user to already have a local Git repository checked out and to type
its absolute path (e.g. `C:\Users\...\my-project`) into a chat message. If the
path lacks a `.git` folder, registration still succeeds with a warning that is
easy to miss in a chat transcript (`application-commands.ts:189-191`).

**Friction / risk**:
- A non-technical user is very unlikely to have a local Git clone, know an
  absolute filesystem path, or understand why one is required.
- The dashboard (`ProjectDeck`, `ui/src/App.tsx:808+`) can only *display* projects
  registered elsewhere; it has no "Add project" action, so the primary visual
  surface cannot complete this required first step.
- This is the hardest blocking point in the whole funnel: without a registered
  project, task creation in the dashboard (`createTask` in `ui/src/api.ts:417`)
  has nothing to target.

**Affected modules**: `src/telegram/bot.ts`, `src/commands/application-commands.ts`,
`ui/src/App.tsx` (`ProjectDeck`), `ui/src/api.ts`.

### 5. Running the first task

**Current state**: Once a project exists, task creation, worktree preparation, and
starting a goal are reasonably well supported from the dashboard ("Nova task"
button, task detail panel, `Prepare worktree`, `Start goal`, phase-by-phase status
per `README.md`'s "Goal autonoma" section). `EnvironmentDoctor` gives a real,
per-project readiness report before execution starts.

**Friction / risk**:
- This stage is comparatively strong, but its quality is undermined by the
  stages before it: a user who can't get past provider connection or project
  creation never reaches this comparatively good experience.
- `EnvironmentDoctor` checks `git`, `node`, `npm`, `typescript`, `vitest`, and
  provider readiness, but not `gh` (see Finding 1), so a first task can complete
  planning/implementing/testing/review and only fail at PR delivery.

**Affected modules**: `src/environment/doctor.ts`, `ui/src/App.tsx` (task panel),
`ui/src/api.ts`.

## Prioritized improvements

Priorities: **P0** blocks a non-technical user from completing onboarding at all;
**P1** actively misleads or causes confusing failures; **P2** reduces friction but
has a workaround today.

| # | Priority | Improvement | Affected modules | Acceptance criteria |
|---|----------|-------------|-------------------|----------------------|
| 1 | P0 | Add a dashboard "Add project" flow (folder picker or path input with live validation) so project registration no longer requires Telegram or manual path typing. | `ui/src/App.tsx`, `ui/src/api.ts`, new dashboard API route, `src/commands/application-commands.ts` | User can register a project entirely from the dashboard; invalid/non-Git paths are rejected inline with an actionable message before submission; Telegram `/project_add` continues to work unchanged. |
| 2 | P0 | Bind the hero section's Codex/Claude status chips to real `data.agents` state instead of hardcoded markup. | `ui/src/App.tsx` (`HeroConsole`) | Hero chips reflect the same `ready`/`working`/`attention`/`offline` state as `AgentDock` for the same refresh cycle; no static "ready" text remains in `HeroConsole`. |
| 3 | P0 | Add actionable remediation text (and, where feasible, a copyable command or deep link) to provider `offline`/`auth_required` health details for Codex and Claude. | `src/agents/codex.ts`, `src/agents/claude.ts`, `src/agents/types.ts`, `ui/src/App.tsx` (`AgentDock`) | An offline/unauthenticated provider's `detail` names the exact install or login command the user must run; UI renders it without truncation. |
| 4 | P1 | Add a `gh` CLI presence + auth check to `EnvironmentDoctor`, and document `gh` as a hard requirement in `README.md`. | `src/environment/doctor.ts`, `README.md` | A project/task with `gh` missing or unauthenticated is reported `environment_blocked` before planning starts, with a remediation summary; README "Requirements" lists GitHub CLI. |
| 5 | P1 | Make provider health checks distinguish "CLI present" from "CLI authenticated" proactively (not only after a failed execution). | `src/agents/codex.ts`, `src/agents/claude.ts` | Health check performs a lightweight auth probe (e.g. cached non-mutating CLI call) and can report `auth_required` before any task execution is attempted. |
| 6 | P2 | Add a guided first-run setup screen or checklist (Telegram bot token, provider CLIs, first project) reachable from the dashboard when no projects exist. | `ui/src/App.tsx`, dashboard API | Dashboard with zero registered projects shows a checklist instead of an empty state; each item links to the relevant action or doc section. |
| 7 | P2 | Translate/duplicate key health and doctor messages in English (or make language configurable) for a non-Portuguese-speaking public beta audience. | `src/agents/codex.ts`, `src/agents/claude.ts`, `src/environment/doctor.ts` | User-facing health/doctor strings are available in English for the public beta locale. |

## Security constraints for any follow-up implementation

Any implementation task addressing the above must preserve the invariants in
`docs/MAESTRO_CONSTITUTION.md` and existing security posture, in particular:

- **Secret safety**: no provider token, Telegram bot token, or credential may be
  displayed, logged, or persisted as part of a new "add project" UI, setup
  wizard, or health remediation message. Reuse `src/security/redaction.ts` /
  `src/security/secrets.ts` for any new user-facing text that could echo
  environment or path data.
- **Least privilege / no new automation surface**: a dashboard "add project" flow
  must call the existing `ApplicationCommands.registerProject` validation path
  (`src/commands/application-commands.ts`) rather than bypassing it; it must not
  grant the browser-facing API broader filesystem access than the existing local
  dashboard already has (still bound to `127.0.0.1`/`localhost`, per
  `README.md`'s "Safety Defaults").
- **No fabricated readiness**: fixing the hero status chips (#2) must not be
  "solved" by defaulting to an optimistic state when data is unavailable; absence
  of data should render as `offline`/unknown, never as `ready`.
- **Human authority preserved**: none of these changes should alter merge,
  approval, or Final Review gates; onboarding improvements are additive UI/DX
  only.

## Recommended minimum public beta scope

To let a non-technical user complete install → connect providers → understand
health → create a project → run a first task without touching Telegram or a
terminal beyond initial setup, the minimum scope is:

1. Item 1 (dashboard "Add project").
2. Item 2 (accurate hero status).
3. Item 3 (actionable provider remediation text).
4. Item 4 (document + check `gh` as a hard requirement).

Items 5–7 improve trust and polish but are not blocking for a first public beta;
they should be scheduled as fast follow-ups once the above land and are validated
with real non-technical testers.
