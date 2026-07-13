# Domain Docs

The Maestro is a single-context repository.

## Before Exploring

- Read `CONTEXT.md` at the repository root when it exists.
- Read ADRs under `docs/adr/` that affect the area being changed.
- If these files do not exist, proceed silently.

`CONTEXT.md` is a domain glossary, not a specification or implementation log.
Use its canonical terms in code, tests, issues, and architecture proposals.

Create domain documentation lazily:

- Add a glossary entry only when a domain term is resolved.
- Add an ADR only for a consequential, surprising, hard-to-reverse trade-off.
- Explicitly flag proposals that contradict an existing ADR.
