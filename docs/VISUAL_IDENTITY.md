# Octomynd Maestro — identidade visual

## Direção: Neon Control Room

O Maestro não deve parecer um dashboard SaaS genérico. Ele é uma central local,
viva e auditável: um espaço em que pessoas coordenam agentes sem perder contexto
ou autoridade. A linguagem combina a energia experimental do Octomynd com a
clareza de uma ferramenta operacional.

## Manifesto

> Muitos agentes. Um só ritmo. O Maestro transforma mensagens em trabalho
> rastreável, deixa cada execução visível e mantém a decisão final com a pessoa.

## Fundamentos

- **Papel quente:** `#F6F0E7` reduz a frieza de ferramentas técnicas.
- **Preto profundo:** `#0C0B10` cria foco e diferencia a control room.
- **Rosa elétrico:** `#FF2FC8` é assinatura, energia e ação em movimento.
- **Cyan:** `#27E3FF` representa telemetria e comunicação.
- **Lima:** `#CAFF47` sinaliza sucesso, autorização e próxima ação.
- **Violeta:** `#7868FF` identifica revisão, Claude e estados intermediários.

## Tipografia

- Interface: Aptos / Segoe UI Variable, com contraste forte entre títulos e corpo.
- Dados e estados: Cascadia Code / Consolas.
- Títulos usam tracking negativo; metadados usam caixa alta e tracking positivo.

## Forma e espaço

- Raios entre 14 e 30 px, nunca pill em containers grandes.
- Hairlines de 1 px e sombras largas, suaves e raras.
- Escala de espaço baseada em 4 px; gaps operacionais preferem 8, 12, 16, 24 e 32.
- Cards de task são densos; hero e composer podem respirar mais.

## Movimento

- Feedback de interface: 160–220 ms.
- Entrada de painéis: 240–300 ms.
- Movimento ambiente só no mascote e órbitas, nunca em tabelas ou texto.
- `prefers-reduced-motion` desliga animações não essenciais.

## Arquitetura da informação

1. Estado do sistema e ação primária.
2. Missão atual e métricas de operação.
3. Fluxo de tasks.
4. Presença dos agentes.
5. Projetos locais.
6. Pulso de eventos e aprovações humanas.

## Regras de confiança

- O dashboard escuta apenas `127.0.0.1`.
- Nenhum token ou ID privado entra no payload visual.
- A UI cria tasks como `queued`; executar continua sendo uma ação explícita.
- Estados críticos dependem também de texto/ícone, nunca somente de cor.
