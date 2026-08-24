# Octomynd Maestro — Plug-and-Play Installation Guide

Octomynd Maestro is designed for plug-and-play onboarding. You can run it with one available provider
(Codex, Claude, or Gemini Antigravity); you do not need to install every provider.

For the packaged Windows desktop flow, see [`docs/desktop-release.md`](docs/desktop-release.md).
The maintained product documentation is available at
[`docs.octomynd.com/maestro`](https://docs.octomynd.com/maestro).

---

## 1. Prerequisites

- **Node.js**: `v20.17.x` (or `>=20.17.0 <21`)
- **Git**: Installed and available in your PATH

---

## 2. Provider Setup & Authentication (Choose ANY ONE)

You do **not** need all AI providers installed. Maestro automatically detects available providers and routes all capabilities to whatever provider is active on your machine.

### Option A: OpenAI Codex
- **CLI Installation**: `npm install -g @openai/codex`
- **CLI Authentication**: `codex login`
- **ENV API Key Override**: Set `CODEX_API_KEY` (or `OPENAI_API_KEY`) in `.env`

### Option B: Anthropic Claude Code
- **CLI Installation**: `npm install -g @anthropic-ai/claude-code`
- **CLI Authentication**: `claude login`
- **ENV API Key Override**: Set `CLAUDE_API_KEY` (or `ANTHROPIC_API_KEY`) in `.env`

### Option C: Gemini Antigravity
- **CLI Installation (Windows PowerShell)**: `irm https://antigravity.google/cli/install.ps1 | iex`
- **CLI Authentication**: `agy login`
- **ENV API Key Override**: Set `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) in `.env`

---

## 3. GitHub CLI Integration (Optional)

- **Installation**: [cli.github.com](https://cli.github.com/)
- **Authentication**: `gh auth login`
- **Note**: GitHub CLI (`gh`) is **optional**. If `gh` is not installed or not authenticated, Maestro automatically operates in local git delivery mode for pull requests and branch creation without failing setup or goals.

---

## 4. Quick Start Setup

Maestro ships with a global-style CLI (`maestro`) so onboarding feels identical to other local tools: one binary, a few subcommands. Every `maestro` subcommand below also has an `npm run` equivalent.

### Step 1: Clone Repository & Install Dependencies

```bash
git clone https://github.com/Everson-s8/octomynd-maestro.git
cd octomynd-maestro
npm install
```

### Step 2: (Optional) Link the global `maestro` CLI

Installing the CLI globally lets you run `maestro setup`, `maestro start`, etc. from any directory:

```bash
npm link
```

`npm link` is optional and only affects the local developer checkout. If you prefer not to link,
substitute `npx tsx src/cli/index.ts <command>` or the `npm run cli:*` scripts below.

### Step 3: Run Configuration Wizard

Run the automated configuration wizard to detect available providers and create your `.env` configuration file:

```bash
maestro setup
# or: npm run setup  /  npm run cli:setup
```

The wizard will:
- Auto-detect installed provider CLIs and environment API keys.
- Check runtime dependencies.
- Generate `.env` with optimal defaults based on detected tools.

### Step 4: Connect Telegram Bot (No Manual .env Editing)

Connect your Telegram bot using the interactive CLI wizard or directly through the Maestro Dashboard UI without manually editing `.env`.

**Via CLI Wizard:**
```bash
maestro telegram connect
# or: npm run telegram:connect  /  npm run cli:telegram
```

The wizard will:
1. Prompt for your Telegram Bot HTTP API Token from `@BotFather`.
2. Prompt for your optional numeric Telegram User ID (obtained by messaging `@userinfobot`) to restrict access to authorized users.
3. Validate credentials with the Telegram API and automatically write them to `.env`.
4. Hot-restart the Telegram bot subsystem without restarting the entire Maestro process.

**Via Dashboard UI:**
1. Launch Maestro platform with `maestro start`.
2. Open `http://127.0.0.1:4788` and navigate to **Settings**.
3. Fill in the **Conexão do Telegram Bot** section with your Bot Token and Telegram User ID, then click **Conectar Bot Telegram**.

### Step 5: Register a project (local path or GitHub URL)

Attach a repository so Maestro can run goals against it. You can point to a local folder or paste a GitHub URL (Maestro clones it for you):

```bash
maestro project add <key> <path-or-github-url>
# examples:
#   maestro project add myapp ./my-app
#   maestro project add myapp https://github.com/owner/my-app
```

### Step 6: Run Smoke Verification

Verify that your single-provider (or multi-provider) machine is fully operational:

```bash
maestro status
# or: npm run smoke
```

`maestro status` prints a one-shot readiness report: runtime, detected provider CLIs, Telegram config, and database path.

### Step 7: Launch Maestro

Start the Maestro orchestrator and local web platform:

```bash
maestro start
# or: npm run dev:platform
```

- **Dashboard UI**: `http://127.0.0.1:4788`
- **Dashboard API**: `http://127.0.0.1:4787`

---

## 5. Features & Single-Provider Routing

- **Plug-and-Play Capability Routing**: When only one provider exists on your machine, Maestro routes 100% of capabilities (planning, coding, testing, reviewing, improvement reviewing, research, conversation) using that provider.
- **Environment API Keys**: You can supply provider API keys (`CODEX_API_KEY`, `CLAUDE_API_KEY`, `GEMINI_API_KEY`) via `.env` or standard shell variables without needing global CLI binaries.
- **Graceful GitHub Fallback**: Setup and goal execution do **NOT** fail if the GitHub CLI (`gh`) is missing or unauthenticated. Maestro falls back to local branch delivery mode seamlessly.

### Conversa e permissões

No Dashboard, abra **Chat** para conversar com o Maestro sobre um projeto específico ou escolha
**Maestro (geral)** para dúvidas de providers, configuração e runtime. Use `+` para criar uma
conversa isolada e a lixeira para removê-la. O seletor **Acesso** controla as ações disponíveis:

- **Somente leitura** responde e consulta evidências, sem alterar estado.
- **Standard** permite operações governadas após confirmação explícita.
- **Full Access** permite todas as operações governadas do Maestro, incluindo cancelamento; não
  libera um shell irrestrito nem expõe credenciais.

O chat continua disponível mesmo quando nenhum projeto foi cadastrado. Para criar uma task nesse
contexto, cadastre pelo menos um projeto; o Maestro usará o projeto padrão cadastrado e mostrará
essa associação antes da execução.

---

## 6. Troubleshooting & Diagnostics

Run the Environment Doctor check anytime to inspect system readiness:

```bash
npm run setup
```

For full test suite execution:

```bash
npm test
```
