# ADR 0008: Product-design Skill Layer

## Status

Accepted.

## Context

Maestro's existing Skills are selected mainly by execution capability and
phase. That is enough for bounded coding and review procedures, but it lets a
UI task reach the same implementation path as backend work. A successful
build can therefore be mistaken for a successful design delivery, and the
worker may miss visual hierarchy, state coverage, responsive behavior, or
runtime evidence.

## Decision

Add a governed `repository:product-design` Skill with a `product_design`
focus. Skill policy focus is metadata, not a model decision: the runtime
selects it only when the task text contains a deterministic interface/design
signal. General Skills remain applicable to all tasks; focused Skills do not
pollute unrelated work.

The Skill is read-only and low risk. It gives planning, implementation,
testing, and review a shared design contract: user intent, hierarchy, states,
responsive rules, accessibility, and rendered/runtime evidence. It does not
invent a visual identity or grant permission to mutate files by itself.

## Consequences

- UI Tasks receive a reusable design protocol without adding a second agent
  role or a provider-specific prompt.
- The catalog and evaluation harness can prove both positive design matching
  and backend exclusion.
- Runtime screenshots/browser checks remain evidence collected by the worker;
  this layer does not pretend static checks can prove visual fidelity.
- Future design domains can add another focus value without hard-coding a
  qualified Skill name into the runtime.
