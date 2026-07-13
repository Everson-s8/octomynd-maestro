# Octomynd Maestro

Chat-first local orchestrator for Codex, Claude and GitHub workflows, com uma
central visual local para acompanhar projetos, fila, agentes e eventos.

O Maestro usa as autenticacoes dos CLIs Codex e Claude. Ele nao requer
`OPENAI_API_KEY` nem cria faturamento separado da OpenAI API.

This first version validates Telegram as the main control surface. It receives commands, creates local tasks, stores events in SQLite and keeps secrets out of Git.

Telegram belongs to the Maestro gateway, not to every managed project. Projects only need their own
Telegram integration when that is an explicit product requirement. When a goal opens a draft pull
request, the Maestro sends the restricted Telegram user a review notification with the public PR URL.

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
Depois da revisao, o Maestro verifica segredos, cria commit, envia a branch e abre um
draft PR. O merge continua sendo a decisao humana importante.

## Fila de revisao humana

Draft PRs entregues aparecem em **Aguardando revisao** com projeto, demanda, agentes,
resumo do review, arquivos relativos, testes e o resultado do secret guard. A pessoa
responsavel registra uma justificativa e escolhe:

- **Aprovar para merge**: usa `gh pr ready`; nunca executa merge.
- **Solicitar ajustes**: devolve o PR para draft e reabre o mesmo goal em implementacao,
  incluindo a justificativa no contexto do agente.
- **Rejeitar**: fecha o PR sem merge e encerra a task como rejeitada.

Todas as decisoes ficam no SQLite e geram eventos e notificacoes do Telegram. Segredos,
IDs privados e caminhos locais sao removidos do payload visual; justificativas contendo
segredo ou caminho privado sao bloqueadas antes de persistencia ou envio.

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
- `/status` shows daemon status, active goals and agents currently working.
- `/status @<key>` shows the active work for one project.
- `/projects` lists registered projects.
- `/project_add <key> <repo-path>` registers a local Git project.
- `/task @<key> <text>` creates a local task for a project.
- `/queue` lists recent tasks.
- `/queue @<key>` lists recent tasks for a project.
- `/cancel <id>` cancels an active, waiting, or queued task without deleting its history.

The governed backlog autopilot is enabled by default. It starts at most one running goal at a time,
keeps `waiting_provider` goals from consuming that global slot, and never starts a second task for a
project that already has a running or waiting goal. Exact duplicates of delivered/completed work are
marked `blocked` for human review rather than silently discarded. Configure it with
`MAESTRO_AUTOPILOT_ENABLED`, `MAESTRO_AUTOPILOT_POLL_MS`, and
`MAESTRO_AUTOPILOT_MAX_CONCURRENT`.
- Any plain text message is saved as feedback.

Final goal notifications are proactive: completed goals with a draft PR send a concise review request.
The notification excludes local worktree paths, credentials and private Telegram identifiers.
Phase updates are also sent when an agent starts planning, implementation, testing or review,
regardless of whether the task originated in Telegram, the dashboard or another local surface.

## Task lifecycle controls

The task detail panel supports two governed actions:

- **Cancel task** interrupts an active Codex or Claude subprocess and preserves execution history.
- **Delete task** is limited to tasks without a worktree or goal history.

Pull requests are reconciled with GitHub while the dashboard is active. A PR merged outside the
dashboard automatically marks its task as completed and leaves the human review queue.

Example:

```text
/project_add octomynd C:\Users\evers\OneDrive\Imagens\TCC\octomynd_publish
/task @octomynd melhorar resposta fora de contexto
/queue @octomynd
```

## Continuous Integration

`.github/workflows/ci.yml` runs on every pull request and on pushes to `main`. It is
fail-closed: any failing step blocks the workflow, and no step ignores errors or masks
a non-zero exit code. The workflow does not deploy and does not merge pull requests.

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

The workflow uses `permissions: contents: read` (no write access), a `concurrency`
group keyed on workflow and ref to cancel superseded runs, and `actions/setup-node`
with `cache: npm` keyed on `package-lock.json` for safe, deterministic caching.

## Local Data

The local SQLite database is stored at `.maestro/maestro.db` by default. The folder is ignored by Git.

## Safety Defaults

- No token or `.env.local` file is committed.
- The bot does not print the Telegram token.
- Local database and logs are ignored.
- If `TELEGRAM_ALLOWED_USER_ID` is set, other users are blocked.
- O dashboard valida o host e aceita apenas `127.0.0.1` ou `localhost`.
- Tokens e IDs privados do Telegram não entram no payload da interface.
