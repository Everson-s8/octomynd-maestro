# Octomynd Maestro

Chat-first local orchestrator for Codex, Claude and GitHub workflows, com uma
central visual local para acompanhar projetos, fila, agentes e eventos.

O Maestro usa as autenticacoes dos CLIs Codex e Claude. Ele nao requer
`OPENAI_API_KEY` nem cria faturamento separado da OpenAI API.

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
isolada. Uma task preparada pode iniciar um goal autonomo com planejamento,
implementacao, testes e revisao. Codex e Claude sao roteados por capacidade; quando
ambos ficam indisponiveis ou sem cota, o goal e persistido em `waiting_provider` e
retomado automaticamente sem perder os passos concluidos.

A direção visual está documentada em `docs/VISUAL_IDENTITY.md`.

## Aprendizado seguro

O painel inclui um laboratorio de propostas de melhoria inspirado no ciclo de
aprendizado do Hermes Agent. Cada candidata registra categoria, justificativa,
mudanca proposta, evidencias, risco e origem. O usuario pode aprovar ou rejeitar,
mas **aprovar nao aplica a mudanca automaticamente**: apenas autoriza uma futura
task isolada com testes e revisao.

A governanca esta separada da persona:

- `docs/MAESTRO_CONSTITUTION.md`: principios protegidos que agentes nao podem editar;
- `docs/HERMES_APPLIED_STUDY.md`: conclusoes do estudo e elementos priorizados;
- uma futura `SOUL.md`: somente tom e personalidade, sem poder de alterar seguranca.

## Goal autonoma

Uma task preparada pode iniciar uma execucao persistente pelo painel. O Maestro avanca sozinho por
planejamento, implementacao, testes e revisao. Quando a revisao pede ajustes, o fluxo retorna para
implementacao sem exigir que o usuario atualize a task. O estado e cada etapa ficam no SQLite.

O contrato, roteamento e limites estao em `docs/GOAL_RUNTIME.md`.

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
