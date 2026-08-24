# Contributing to Octomynd Maestro

Thank you for helping improve Maestro. The project is an opinionated local orchestrator: changes
should preserve observable execution, human review gates, isolated worktrees, and secret safety.

## Before you start

- Read [`CONTEXT.md`](CONTEXT.md) for the project vocabulary.
- Read the relevant ADRs under [`docs/adr`](docs/adr) before changing orchestration, provider,
  review, or work-graph behaviour.
- For product usage and onboarding, use the maintained documentation at
  [docs.octomynd.com/en](https://docs.octomynd.com/en/).
- For a substantial change, open an issue first so the design and scope are visible.

## Local development

Use Node.js `>=22.12.0 <25` and Git. The repository's development version is
`22.12.x` because the dependency and Electron packaging toolchain require Node 22.12 or newer:

```powershell
npm ci
npm run typecheck
npm run typecheck:ui
npm test
npm run build:ui
```

Run the local platform with:

```powershell
npm run dev:platform
```

Provider CLIs and Telegram are optional for unit tests. Never use real credentials in tests. Use
fake values and temporary directories, and do not commit `.env.local`, databases, runtime logs,
provider caches, OAuth files, or generated build metadata.

## Change guidelines

- Keep dashboard, CLI, Telegram, and application-command behaviour aligned.
- Prefer a small, deep module interface over duplicating orchestration logic across surfaces.
- Preserve fail-closed behaviour for provider routing, permissions, secret scans, and human gates.
- Add or update deterministic tests for every behaviour change.
- Add an ADR only for a consequential or difficult-to-reverse architectural decision.
- Keep user-facing text clear about whether data is real, estimated, unavailable, or pending.
- Do not add provider-specific credentials, machine paths, or private documentation to the source.

## Pull requests

Use a focused branch and explain the user-visible problem, the chosen design, and the validation
performed. A good pull request includes:

- a concise title and scope;
- tests for the changed behaviour;
- documentation updates when commands, configuration, or user-visible behaviour changes;
- confirmation that no secrets, local databases, generated artifacts, or private paths are staged;
- screenshots or a short recording for meaningful UI changes.

The CI workflow is fail-closed. Every required check must pass before merge, but a green CI run
does not replace human review of provider permissions, desktop packaging, or release credentials.

## Commit messages

Use an imperative, scoped subject when practical, for example:

```text
fix(providers): keep health state stable between polls
feat(cli): add a project status command
docs(release): explain the Windows update path
```

## Code of conduct

Participation is governed by [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md). Security issues must be
reported privately as described in [`SECURITY.md`](SECURITY.md).
