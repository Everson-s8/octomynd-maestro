# Octomynd Maestro

Chat-first local orchestrator for Antigravity, Codex, Claude and GitHub workflows, com uma
central visual local para acompanhar projetos, fila, agentes e eventos.

O Maestro usa as autenticacoes dos CLIs Antigravity, Codex e Claude. Ele nao requer
`OPENAI_API_KEY` nem cria faturamento separado da OpenAI API.

This first version validates Telegram as the main control surface. It receives commands, creates local tasks, stores events in SQLite and keeps secrets out of Git.

Telegram belongs to the Maestro gateway, not to every managed project. Projects only need their own
Telegram integration when that is an explicit product requirement. When a goal opens a draft pull
request, the Maestro sends the restricted Telegram user a review notification with the public PR URL.

## Requirements

- Node.js 20.17.x for local development and CI. `.node-version`, `package.json`
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

## Plataforma visual

O dashboard usa dados reais do SQLite e permanece restrito ao computador local.

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
- API local: `http://127.0.0.1:4787`
- Build: `npm run build:ui`
- Typecheck: `npm run typecheck:ui`

Para executar o runtime completo no Windows com PID, logs e health check:

```powershell
.\scripts\maestro-runtime.ps1 start
.\scripts\maestro-runtime.ps1 status
.\scripts\maestro-runtime.ps1 restart
.\scripts\maestro-runtime.ps1 stop
```

O controlador considera o startup concluido somente quando
`http://127.0.0.1:4787/api/dashboard` responde. Logs e PID ficam sob
`.maestro/runtime/`, fora do Git. Manutencoes devem terminar com `status` verde;
parar o processo tambem interrompe Dashboard, Telegram e coordenadores.

A interface permite acompanhar estado do daemon, projetos, fila, agentes e eventos,
alem de criar tasks locais como `queued`, abrir detalhes e preparar uma worktree
isolada. Uma task preparada pode iniciar um goal autonomo com planejamento,
implementacao, testes e revisao. Antigravity, Codex e Claude sao roteados por capacidade; quando
todos ficam indisponiveis ou sem cota, o goal e persistido em `waiting_provider` e
retomado automaticamente sem perder os passos concluidos.
O `AgentRegistry` e a fonte unica para capacidade, carga, saude e cooldown dos
providers. O Dashboard e `/status` no Telegram exibem o mesmo estado operacional,
sem inferir autenticacao ou disponibilidade por regras visuais separadas.
O Antigravity usa a assinatura Google autenticada no CLI, sem API key no projeto. Por
padrao ele recebe planejamento, implementacao, testes, pesquisa e revisao de melhoria
antes dos providers com cota mais escassa. O Claude continua como primeira opcao de
Final Review independente. Work Graphs podem usar providers diferentes em nodes
independentes, mas nunca permitem dois writers concorrentes sobre a mesma Task.
Depois da revisao, o Maestro verifica segredos, cria commit, envia a branch e abre um
draft PR. Para uma Task avulsa, o merge continua sendo uma decisao humana. Em uma
Feature, os Work PRs permanecem Draft como evidencia e nunca sao mergeados
individualmente. O unico candidato a merge e o Feature PR consolidado: quando o
usuario o marca como Ready for review, o Maestro valida checks e mergeabilidade,
executa um Final Review read-only sobre o SHA exato e, se aprovado, faz o merge,
fecha os Work PRs e limpa branches integradas. Qualquer mudanca no SHA ou falha de
gate invalida a revisao e impede o merge.

## Work Graph multiagente

Tasks complexas podem ser representadas como um DAG governado de ate quatro Worker
Nodes. O Maestro continua como gerente: valida dependencias e budgets, permite no
maximo dois readers simultaneos e serializa um unico writer com escopo de escrita
declarado. Resultados grandes ficam em artefatos redigidos; os workers seguintes
recebem apenas referencias e resumos limitados.

O Dashboard mostra graph, nodes, tentativas, budgets e evidencias. No Telegram:

- `/graphs [@projeto]` lista Work Graphs e seus nodes;
- `/graph_cancel <id>` cancela graphs parados e preserva toda a auditoria;
- `/status` inclui Work Graphs ativos.

Cancelamento de um graph em execucao falha fechado ate que um coordenador residente
possa propagar `AbortSignal` ao provider. A classificacao de complexidade e o runtime
estao prontos, mas a ativacao automatica para toda Task permanece desligada nesta
primeira entrega para nao multiplicar tokens em demandas simples.

## Fila de revisao humana

Draft PRs entregues aparecem em **Aguardando revisao** com projeto, demanda, agentes,
resumo do review, arquivos relativos, testes e o resultado do secret guard. A pessoa
responsavel registra uma justificativa e escolhe:

- **Aprovar PR avulso para merge**: usa `gh pr ready`; nao executa merge.
- **Solicitar ajustes**: devolve o PR para draft e reabre o mesmo goal em implementacao,
  incluindo a justificativa no contexto do agente.
- **Rejeitar**: fecha o PR sem merge e encerra a task como rejeitada.

Todas as decisoes ficam no SQLite e geram eventos e notificacoes do Telegram. Segredos,
IDs privados e caminhos locais sao removidos do payload visual; justificativas contendo
segredo ou caminho privado sao bloqueadas antes de persistencia ou envio.

Esta fila de decisao manual e diferente do protocolo de Feature PR descrito acima.
Marcar somente o Feature PR consolidado como Ready for review autoriza o Final Review
e o merge automatico governado; Work PRs individuais devem permanecer Draft.

A direcao visual esta documentada em `docs/VISUAL_IDENTITY.md`.

## Aprendizado seguro

O painel inclui um laboratorio de propostas de melhoria inspirado no ciclo de
aprendizado do Hermes Agent. Cada candidata registra categoria, justificativa,
mudanca proposta, evidencias, risco e origem. O usuario pode aprovar ou rejeitar,
mas **aprovar nao aplica a mudanca automaticamente**: cria uma nova Task e um
Feature Plan, que passam pelo fluxo normal de worktree isolada, validacao, Work PR
Draft e Final Review somente no Feature PR consolidado.

Quando uma Feature termina, um outbox SQLite idempotente registra um pacote de
evidencias limitado, sanitizado e com proveniencia. Um reviewer em background usa
Codex ou Claude em modo estritamente read-only e no maximo duas tentativas. Um
evaluator deterministico rejeita evidencias inventadas, duplicatas, baixa confianca,
risco subestimado e qualquer tentativa de alterar Constituicao, segredos, aprovacoes,
auditoria, permissoes ou rollback. O reviewer nunca escreve skills, memoria ou codigo.

A governanca esta separada da persona:

- `docs/MAESTRO_CONSTITUTION.md`: principios protegidos que agentes nao podem editar;
- `docs/HERMES_APPLIED_STUDY.md`: conclusoes do estudo e elementos priorizados;
- uma futura `SOUL.md`: somente tom e personalidade, sem poder de alterar seguranca.

## Skills governadas

O runtime de Skills usa pacotes portaveis com `SKILL.md`, policy opcional em
`maestro.yaml` e casos deterministas em `evals/cases.yaml`. A descoberta carrega
somente metadados; instrucoes entram no prompt apenas depois da selecao e ficam
limitadas por budget. Cada Goal fixa o hash exato da versao usada, o motivo do
trigger e o modo de invocacao.

Ele permanece desligado por padrao. Para habilitar os tres Skills iniciais:

```text
MAESTRO_SKILLS_ENABLED=true
MAESTRO_SKILLS_PATH=skills
MAESTRO_SKILL_VERSIONS_PATH=.maestro/skill-versions
MAESTRO_SKILLS_PROJECT_KEY=maestro
```

- `diagnose-goal-failure`: pode ser selecionado implicitamente, mas e read-only,
  sem rede e sem escrita.
- `final-feature-review`: pode ser selecionado implicitamente somente na revisao,
  sem rede e sem escrita.
- `implement-task-safely`: exige selecao explicita e limita escrita ao workspace
  preparado.

No startup, apenas o allowlist de Skills do sistema pode passar automaticamente
por eval, aprovacao e ativacao. Pacotes adicionais ficam como `candidate`. Uma
versao falha fechada se os triggers, guardrails, sintaxe ou policy regredirem. O
Dashboard e a evidencia do Goal mostram versoes, resultados, duracao e tokens
estimados, mas nunca persistem ou exibem as instrucoes privadas do Skill.

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
rather than silently discarded. Configure it with
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

The Goal runtime applies the same validation policy before review. Passing checks
skip a separate LLM testing pass; failures are stored as sanitized artifacts and
summarized into a compact correction handoff.

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
- Tokens e IDs privados do Telegram nao entram no payload da interface.
