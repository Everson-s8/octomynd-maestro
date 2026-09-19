---
name: improvement-reviewing
description: Judge improvement proposals from bounded evidence.
---

# Improvement Reviewing

## Introduction

> **Iron Law: NO PROPOSAL WITHOUT TRACEABLE EVIDENCE AND A REVERSIBLE CHANGE.**

Judge candidate improvements produced by Maestro's restricted background
reviewer. This Skill decides whether an observed pattern justifies a bounded
proposal; it does not edit files, approve a proposal, activate a Skill, change
routing, or persist anything. The reviewer is an evidence-to-draft boundary,
not an autonomous maintainer.

## When to Use

Use with the `improvement_reviewing` capability when the coordinator supplies
an `ImprovementEvidencePack`. Use it to reject weak, duplicate, unsafe, or
unverifiable proposals and to shape a useful draft for later human/governed
review. Do not use it for normal Feature review or direct implementation.

## Prerequisites

- Treat the evidence pack as the complete allowed input; do not fetch more
  context, browse the network, or inspect unlisted secrets.
- Know the exact evidence IDs, candidate schema, category (`skill`, `memory`,
  `routing`, `policy`, `integration`), risk, and confidence bounds.
- Preserve the read-only contract in `improvements/reviewer.ts`: every
  `evidenceRefs` entry must exist, output must be exact JSON, and no candidate
  may authorize its own activation.

## How to Run

Review the bounded pack once, compare each proposed change with its evidence,
and return only schema-valid drafts. If evidence is insufficient, return an
empty candidate list. Keep the proposal small enough for a later evaluator to
test and keep the evidence IDs stable enough to audit.

## Quick Reference

- Evidence ID before conclusion.
- Repeated observation before systemic proposal.
- One bounded target before broad cleanup.
- Confidence reflects evidence, not eloquence.
- Draft only; approval and activation remain governed operations.

## Procedure

1. Check the pack is bounded and safe. If it contains sensitive material,
   duplicate IDs, unbounded text, or no evidence, stop; the coordinator should
   fail closed before provider execution.
2. For each candidate, trace `rationale` and `proposedChange` to at least one
   existing `evidenceRef`. Do not invent a missing test, log, provider result,
   or user preference.
3. Prefer a repeated Maestro-specific signal over a generic best practice. A
   proposal about the F01 validation budget, a provider adapter's false
   `completed`, or a silent Skill curator gate is actionable only when the pack
   names the corresponding evidence.
4. Reject proposals that would make the background reviewer mutate the system,
   activate a Skill, loosen `writeScopes`, bypass confirmation, expose a
   credential, or turn an unverified provider into `ready`.
5. Keep targets concrete and small. A proposal to “improve reliability” is not
   reviewable; a proposal naming a module, behavior, evidence, and testable
   acceptance condition is.
6. Set risk and confidence from the pack. High-impact changes need stronger
   evidence and should remain drafts for human review; confidence is not a
   license to apply them.
7. Return exact JSON matching `buildImprovementReviewSchema`. If the pack does
   not support a defensible candidate, return `{"candidates":[]}` rather than
   padding the result with generic advice.

## Pitfalls

### Red Flags — STOP

- A candidate cites an evidence ID that is not in the pack.
- The reviewer proposes a fix without a reproducible observation.
- A skill proposal asks to activate itself or silently changes policy.
- A generic “add more tests” draft has no Maestro module, behavior, or evidence.
- The output contains markdown, extra JSON keys, secrets, or unsupported risk.
- A provider failure is turned into a routing change without evidence that the
  alternate provider or failure category was verified.

The read-only restriction is part of the quality contract. A plausible draft
that bypasses it is a failed review, not a useful shortcut.

## Common Rationalizations

- **“The evidence is thin, but this improvement is obviously good.”** Return
  no candidate until an existing evidence ID supports the proposal.
- **“I can fix the issue while reviewing it.”** The coordinator deliberately
  uses a restricted provider; propose a draft and leave application to the
  governed lifecycle.
- **“The provider completed, so add a routing rule.”** F02–F04 distinguish
  completion, failure, permission denial, and verification; do not infer a
  system change from an adapter label.
- **“A broad cleanup will solve several possible causes.”** Targets and
  proposed changes must remain bounded and testable; split unrelated causes.
- **“A skill proposal can be active immediately because it is low risk.”**
  Skill versions still require evaluation, approval, and activation through
  the existing lifecycle.

## Verification

Confirm every candidate has real evidence IDs, a bounded target, explicit
risk/confidence, and a reversible proposed change. Confirm exact schema output,
read-only behavior, and no persistence or activation side effect. Confirm an
empty result is used when the pack cannot support a defensible proposal.
