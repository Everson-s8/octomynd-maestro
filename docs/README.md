# Maestro documentation

Start with the root [README](../README.md) (install, surfaces, CLI parity) and
[CONTEXT.md](../CONTEXT.md) (canonical vocabulary: Task, Goal, Feature, Work PR,
Feature PR, Provider, Skill, Work Graph).

## Canonical docs by topic

| Topic | Document |
|---|---|
| Principles and governance | [MAESTRO_CONSTITUTION](MAESTRO_CONSTITUTION.md) |
| Goal lifecycle, phases, retries, `waiting_provider` vs `blocked`, handoff | [GOAL_RUNTIME](GOAL_RUNTIME.md) |
| Choosing a direct task or a Feature Plan | [WORK_INTAKE](WORK_INTAKE.md) |
| Providers: catalog, connection, routing, Codex flags | [PROVIDERS](PROVIDERS.md) |
| Deterministic validation and dependency repair | [VALIDATION](VALIDATION.md) |
| Multi-worker execution (explicit adoption) | [WORK_GRAPHS](WORK_GRAPHS.md) |
| Skills and multi-agent architecture | [SKILLS_AND_MULTI_AGENT_ARCHITECTURE](SKILLS_AND_MULTI_AGENT_ARCHITECTURE.md) |
| Backlog autopilot | [BACKLOG_AUTOPILOT](BACKLOG_AUTOPILOT.md) |
| Feature queue roadmap | [FEATURE_QUEUE_ROADMAP](FEATURE_QUEUE_ROADMAP.md) |
| Onboarding and i18n | [I18N_ONBOARDING](I18N_ONBOARDING.md) |
| Visual identity | [VISUAL_IDENTITY](VISUAL_IDENTITY.md) |
| Desktop build, updater and release checklist | [desktop-release](desktop-release.md) |
| Release notes | [releases/](releases/) |
| WhatsApp gateway (plan, not implemented) | [WHATSAPP_GATEWAY_PLAN](WHATSAPP_GATEWAY_PLAN.md) |

## Architecture decisions

| ADR | Decision |
|---|---|
| [0001](adr/0001-agent-process-runtime-and-claude-fallback.md) | Agent process runtime and provider fallback |
| [0002](adr/0002-feature-pr-completion-protocol.md) | Feature PR completion protocol |
| [0003](adr/0003-bounded-agent-execution-and-circuit-breakers.md) | Bounded execution and circuit breakers |
| [0004](adr/0004-governed-skills-and-multi-agent-work-graph.md) | Governed skills and the Work Graph |
| [0005](adr/0005-resumable-feature-task-execution.md) | Resumable feature/task execution |
| [0006](adr/0006-antigravity-provider-and-cost-aware-routing.md) | Antigravity provider and cost-aware routing |
| [0007](adr/0007-chat-agent-context-observability-and-learning.md) | Chat agent context, observability and learning |
| [0008](adr/0008-product-design-skill-layer.md) | Product-design skill layer (was a second "0005") |

New ADRs take the next free number.

## Archive

[archive/](archive/) holds point-in-time reviews, audits and studies:
- the PR #132 and #178 reviews;
- the runtime recovery study;
- the onboarding audit;
- the design QA notes.

They explain past decisions but are not current behaviour. When they
disagree with a canonical doc or the code, the canonical doc wins.
