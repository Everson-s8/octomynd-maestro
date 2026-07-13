# Plano futuro: gateway WhatsApp

O Telegram continua sendo o canal principal do Maestro. A expansao para WhatsApp fica registrada
como milestone futuro e nao deve duplicar logica de tarefas dentro de cada projeto gerenciado.

## Arquitetura proposta

1. Extrair um contrato comum de gateway para Telegram, WhatsApp e canais futuros.
2. Executar um sidecar Node.js local usando Baileys, inspirado no bridge MIT do Hermes Agent.
3. Comecar exclusivamente em `self-chat`: somente mensagens enviadas pelo usuario para si mesmo.
4. Vincular a conta por QR Code no dashboard e armazenar a sessao fora do Git.
5. Usar HTTP em `127.0.0.1` com segredo aleatorio obrigatorio entre bridge e Maestro.
6. Manter grupos, contatos externos e midia desativados na primeira versao.
7. Aplicar debounce de mensagens e reutilizar os mesmos comandos, notificacoes e politicas do Telegram.

## Regras de seguranca

- Nunca versionar credenciais da sessao do WhatsApp.
- Preferir uma conta secundaria no piloto por causa do risco da integracao nao oficial.
- Manter Telegram como fallback operacional.
- Oferecer logout, revogacao e limpeza explicita da sessao.
- A alternativa oficial e a Meta Cloud API, que exige conta Business e webhook publico.

## Criterio para iniciar

Implementar somente depois que o contrato de gateway, notificacoes de progresso e lifecycle de tasks
estiverem estaveis no Telegram.
