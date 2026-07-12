# Octomynd Maestro

Chat-first local orchestrator for Codex, Claude and GitHub workflows, com uma
central visual local para acompanhar projetos, fila, agentes e eventos.

This first version validates Telegram as the main control surface. It receives commands, creates local tasks, stores events in SQLite and keeps secrets out of Git.

## Requirements

- Node.js 20.17+ for local development. Node 24 is the target for future CI.
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

## Plataforma visual

O dashboard usa dados reais do SQLite e permanece restrito ao computador local.

```powershell
npm run dev:platform
```

- UI: `http://127.0.0.1:4788`
- API local: `http://127.0.0.1:4787`
- Build: `npm run build:ui`
- Typecheck: `npm run typecheck:ui`

A interface permite acompanhar estado do daemon, projetos, fila, agentes e eventos,
além de criar tasks locais como `queued`, abrir detalhes e preparar uma worktree
isolada. Uma task preparada pode solicitar uma revisão read-only ao Claude; o
resultado ou erro de autenticação fica persistido no SQLite e visível na telemetria.
Ela não executa uma task automaticamente: o gate humano continua explícito.

A direção visual está documentada em `docs/VISUAL_IDENTITY.md`.

## Telegram Commands

- `/start` shows the bot introduction.
- `/help` shows available commands.
- `/status` shows daemon status and recent activity.
- `/projects` lists registered projects.
- `/project_add <key> <repo-path>` registers a local Git project.
- `/task @<key> <text>` creates a local task for a project.
- `/queue` lists recent tasks.
- `/queue @<key>` lists recent tasks for a project.
- Any plain text message is saved as feedback.

Example:

```text
/project_add octomynd C:\Users\evers\OneDrive\Imagens\TCC\octomynd_publish
/task @octomynd melhorar resposta fora de contexto
/queue @octomynd
```

## Local Data

The local SQLite database is stored at `.maestro/maestro.db` by default. The folder is ignored by Git.

## Safety Defaults

- No token or `.env.local` file is committed.
- The bot does not print the Telegram token.
- Local database and logs are ignored.
- If `TELEGRAM_ALLOWED_USER_ID` is set, other users are blocked.
- O dashboard valida o host e aceita apenas `127.0.0.1` ou `localhost`.
- Tokens e IDs privados do Telegram não entram no payload da interface.
