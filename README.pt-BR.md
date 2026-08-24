# Octomynd Maestro

O Maestro é um orquestrador local, orientado a chat, para CLIs e APIs de agentes como Codex,
Claude, Gemini Antigravity e outros providers. Ele organiza projetos, tasks, worktrees isoladas,
logs, revisão humana e entrega em branches ou pull requests.

O Maestro usa as CLIs autenticadas ou credenciais de API escolhidas por você. Ele não exige
`OPENAI_API_KEY` nem cria uma cobrança separada da OpenAI. O dashboard e a CLI local são as
interfaces principais; Telegram é opcional.

## Requisitos

- Node.js `>=22.12.0 <25` para executar o runtime e gerar o desktop para Windows.
- Git para registrar projetos e executar tasks em worktrees.
- Pelo menos um provider CLI ou uma credencial de API.

## Começo rápido

```powershell
npm install
Copy-Item .env.example .env.local
npm run dev:platform
```

Abra o dashboard em `http://127.0.0.1:4788`. Registre um projeto, conecte um provider em
**Providers** e crie uma task. A linguagem do dashboard pode ser escolhida em **Settings >
Language**; o padrão é inglês e Português (Brasil) está disponível.

Para a instalação completa, providers, desktop e diagnóstico, consulte o
[`INSTALL.pt-BR.md`](INSTALL.pt-BR.md). A documentação pública mantida está em
[`docs.octomynd.com`](https://docs.octomynd.com/) em inglês e português.

## CLI

```powershell
maestro.cmd project list
maestro.cmd task create <project-key> "descreva a tarefa"
maestro.cmd task prepare <task-id>
maestro.cmd task start <task-id>
maestro.cmd task logs <task-id> --follow
maestro.cmd providers status
```

Veja também a versão canônica em inglês: [`README.md`](README.md).
