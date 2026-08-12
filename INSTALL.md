# Octomynd Maestro - Plug-and-Play Installation Guide

Octomynd Maestro is designed for plug-and-play onboarding. You can run Maestro on any machine with **JUST ONE** provider (only Codex, only Claude, or only Gemini).

---

## 1. Prerequisites

- **Node.js**: `v20.17.x` (or `>=20.17.0 <21`)
- **Git**: Installed and available in your PATH

---

## 2. Provider Options (Choose ANY ONE)

You do **not** need all AI providers installed. Maestro automatically detects available providers and routes all capabilities to whatever provider is available on your machine.

| Provider | CLI Option | ENV Override Option |
| :--- | :--- | :--- |
| **Codex** | `@openai/codex` CLI | `CODEX_API_KEY` or `OPENAI_API_KEY` |
| **Claude** | `@anthropic-ai/claude-code` CLI | `CLAUDE_API_KEY` or `ANTHROPIC_API_KEY` |
| **Gemini Antigravity** | `agy` CLI | `GEMINI_API_KEY` or `GOOGLE_API_KEY` |

---

## 3. Quick Start Setup

### Step 1: Clone Repository & Install Dependencies

```bash
git clone https://github.com/Everson-s8/octomynd-maestro.git
cd octomynd-maestro
npm install
```

### Step 2: Run Configuration Wizard

Run the automated configuration wizard to detect available providers and create your `.env` configuration file:

```bash
npm run setup
```

The wizard will:
- Auto-detect installed provider CLIs and environment API keys.
- Check runtime dependencies.
- Generate `.env` with optimal defaults based on detected tools.

### Step 3: Run Smoke Verification

Verify that your single-provider (or multi-provider) machine is fully operational:

```bash
npm run smoke
```

### Step 4: Launch Maestro

Start the Maestro orchestrator and local web platform:

```bash
npm run dev:platform
```

- **Dashboard UI**: `http://127.0.0.1:4788`
- **Dashboard API**: `http://127.0.0.1:4787`

---

## 4. Features & Single-Provider Routing

- **Plug-and-Play Capability Routing**: When only one provider exists on your machine, Maestro routes 100% of capabilities (planning, coding, testing, reviewing, improvement reviewing, research, conversation) using that provider.
- **Environment API Keys**: You can supply provider API keys (`CODEX_API_KEY`, `CLAUDE_API_KEY`, `GEMINI_API_KEY`) via `.env` or standard shell variables without needing global CLI binaries.
- **Graceful GitHub Fallback**: Setup and goal execution do **NOT** fail if the GitHub CLI (`gh`) is missing. Maestro falls back to local branch delivery mode seamlessly.

---

## 5. Troubleshooting & Diagnostics

Run the Environment Doctor check anytime to inspect system readiness:

```bash
npx tsx src/wizard.ts
```

For full test suite execution:

```bash
npm test
```
