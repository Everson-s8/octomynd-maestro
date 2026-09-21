# Octomynd Maestro

<p align="center">
  <strong>Sistemas open-source para trabalho útil com IA, execução visível e controle local-first.</strong>
</p>

<p align="center">
  Octomynd é a marca. Maestro é o produto público atual: um orquestrador governado para agentes de
  programação, projetos, tasks e fluxos de entrega.
</p>

O Maestro é um orquestrador local, orientado a chat, para CLIs e APIs de agentes como Codex,
Claude, Gemini Antigravity e outros providers. Ele organiza projetos, tasks, worktrees isoladas,
logs, revisão humana e entrega em branches ou pull requests.

A direção da Octomynd é mais ampla do que um produto de data warehouse ou analytics. Estamos
construindo uma família de ferramentas open-source focadas, mantendo contexto, execução, credenciais
e falhas visíveis em vez de esconder decisões importantes atrás de uma caixa-preta. Projetos futuros
voltados a dados podem entrar no ecossistema depois; agora o foco público e de distribuição é o Maestro.

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
[`docs.octomynd.com/en/`](https://docs.octomynd.com/en/) em inglês e português.

No primeiro acesso, o dashboard abre uma configuração guiada que explica o produto, verifica
providers, oferece o cadastro de projeto ou um chat sem projeto e conduz até a primeira task.
Ela pode ser pulada e reaberta em **Configurações > Primeiro acesso**. O idioma da interface é
independente do idioma usado no Chat, nas tasks e nas respostas dos providers.

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
