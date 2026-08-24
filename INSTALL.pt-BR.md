# Instalação do Maestro — Português (Brasil)

Este guia é o espelho em português do [`INSTALL.md`](INSTALL.md). O Maestro é local-first:
projetos, credenciais locais, SQLite, worktrees e logs ficam na máquina do usuário.

## Requisitos

- Node.js `>=22.12.0 <25`.
- Git disponível no `PATH`.
- Pelo menos um provider instalado e autenticado, ou uma API key configurada.

## Instalação a partir do código

```powershell
npm install
Copy-Item .env.example .env.local
npm run setup
npm run dev:platform
```

O dashboard fica em `http://127.0.0.1:4788` e a API em `http://127.0.0.1:4787`.

## Providers

O Maestro não instala nem autentica providers automaticamente. Instale e autentique cada CLI
seguindo a documentação oficial e depois abra **Providers > Refresh providers**. O login continua
na conta do usuário e nenhuma chave fica salva no Octomynd.

Você também pode conectar um endpoint compatível com OpenAI usando API key. A credencial é mantida
localmente e o provider só entra no roteamento depois que a conexão for validada.

## Desktop para Windows

```powershell
npm run release:win
```

O instalador é gerado em `release/`. A aplicação empacotada inclui o runtime do Maestro, mas Git e
os providers continuam sendo responsabilidade do usuário. Para distribuição pública, use os
artefatos publicados em GitHub Releases e confira o checksum SHA-256.

## Uso básico

1. Registre um projeto local ou do GitHub.
2. Conecte pelo menos um provider.
3. Crie uma task no dashboard ou pela CLI.
4. Prepare a worktree e inicie o goal.
5. Acompanhe logs, testes e revisão humana antes do merge.

O **Chat** é persistente e separado por projeto. Crie conversas com `+`, apague-as pela lixeira
e use **Maestro (geral)** para dúvidas sobre providers e configuração. Em **Settings > Language**,
escolha inglês ou português; inglês é o padrão.

## Diagnóstico

```powershell
npm run setup
npm test
```

Leia a documentação pública em [docs.octomynd.com](https://docs.octomynd.com/) para o onboarding
completo em inglês e português.
