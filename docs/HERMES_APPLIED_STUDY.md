# Hermes Agent: applied study for Octomynd Maestro

## Source reviewed

- Hermes Agent source snapshot supplied by the user (`hermes-agent-main.zip`).
- Reverse-engineering report supplied by the user.
- Source version is MIT licensed; this implementation reuses architectural principles rather than
  copying a large subsystem verbatim.

The source code was treated as authoritative. Claims from the referenced conversation were checked
against the implementation.

## What Hermes actually does

Hermes does not retrain model weights. Its self-improvement loop is persistent program and context
mutation:

```text
conversation
  -> restricted background reviewer
  -> memory or skill write
  -> provenance and optional approval staging
  -> later retrieval
  -> curator lifecycle and rollback
```

Important implementation points:

- `agent/background_review.py` forks an `AIAgent` after the foreground response.
- The review fork is restricted to memory/skill tools and persistence is isolated from the live chat.
- `tools/skill_provenance.py` distinguishes background-created skills from user-directed skills.
- `tools/skill_manager_tool.py` enforces read-before-write for autonomous review and protects origins.
- `tools/write_approval.py` can stage memory/skill writes under a pending directory.
- `agent/curator.py` manages active/stale/archived lifecycle and optional LLM consolidation.
- `agent/curator_backup.py` snapshots the skill tree and supports rollback.
- `gateway/platforms/` keeps channel adapters at the edge of the system.

## Is the SOUL warning valid?

Yes.

Hermes loads `SOUL.md` as the first stable identity block of the system prompt. When present, it
replaces the fallback identity. The background reviewer normally inherits the parent's cached system
prompt, so a bad SOUL can bias both normal execution and the process that decides what to remember or
turn into a skill.

Hermes reduces the blast radius with tool whitelists, protected skill origins, approval staging,
pinning, snapshots, and rollback. Those controls limit what the reviewer can mutate, but they do not
make a poorly specified identity harmless.

There are also two settings that deserve caution when adapting the design:

- write approval is optional rather than an unavoidable invariant;
- some guards for agent-created skills are configurable rather than always on.

For Maestro, governance must not depend on persona quality alone.

## Architecture adopted by Maestro

Maestro separates three layers:

1. **Constitution**: immutable to agents; security, truthfulness, approval, provenance, rollback.
2. **Persona/SOUL**: future user-owned tone and interaction preferences; cannot grant authority.
3. **Learning artifacts**: memories, skills, routing and integration proposals with lifecycle controls.

The first implemented vertical slice is an improvement proposal ledger:

- category: skill, memory, routing, policy, or integration;
- rationale and concrete proposed change;
- one or more evidence records;
- risk classification;
- source and timestamps;
- candidate, approved, or rejected state;
- audit event for proposal and decision.

An approved proposal is not activated automatically. It creates a normal isolated Task and Feature
Plan, so implementation, tests, Work PR evidence and consolidated Final Review remain mandatory.

## What should be reused next

### High priority

1. Restricted background reviewer that can only create improvement candidates.
2. Provenance on every candidate and future skill mutation.
3. Read-before-write and diff-before-approval.
4. Snapshot/rollback before activation.
5. Agent-owned versus user-owned artifact classification.
6. Gateway adapter interface shared by Telegram, WhatsApp, and future channels.

The deferred WhatsApp implementation plan is recorded in `docs/WHATSAPP_GATEWAY_PLAN.md`.

### Medium priority

1. Skill usage telemetry and stale lifecycle.
2. Context progressive disclosure instead of loading every skill every turn.
3. Session search and evidence links.
4. Curator dry-run reports.

### Do not copy directly

1. Direct autonomous skill writes when approval is disabled.
2. A SOUL file that can replace governance instructions.
3. LLM consolidation without mandatory evals and rollback proof.
4. Large gateway runtime before a stable platform adapter contract exists.
5. Autonomous mutation based on one frustrating or anomalous session alone.

## Implemented milestone: governed self-improvement loop

Completed Features now enter a durable SQLite review outbox keyed by reviewed head SHA. A restricted
read-only reviewer can produce bounded candidate drafts through Codex or Claude, and a deterministic
evaluator checks evidence references, confidence/risk floors, duplicate fingerprints and protected
surfaces. Accepted drafts appear in the Learning Lab and Telegram. Human approval creates a new Task
and Feature Plan; it never mutates code, prompts, memory, skills, routing or policy directly.

The next safe milestone is curator lifecycle and rollback for agent-owned artifacts, after enough
candidate/activation telemetry exists to evaluate false positives and proposal quality.
