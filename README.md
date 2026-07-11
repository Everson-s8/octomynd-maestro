# Octomynd Maestro

Chat-first local orchestrator for Codex, Claude and GitHub workflows.

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
npm test
```

## Telegram Commands

- `/start` shows the bot introduction.
- `/status` shows daemon status and recent activity.
- `/task <text>` creates a local task.
- `/queue` lists recent tasks.
- Any plain text message is saved as feedback.

## Local Data

The local SQLite database is stored at `.maestro/maestro.db` by default. The folder is ignored by Git.

## Safety Defaults

- No token or `.env.local` file is committed.
- The bot does not print the Telegram token.
- Local database and logs are ignored.
- If `TELEGRAM_ALLOWED_USER_ID` is set, other users are blocked.
