---
name: final-feature-review
description: Review consolidated Feature PRs before merge.
---

# Final Feature Review

## Introduction

> **Iron Law: DO NOT APPROVE WHAT THE ADAPTER OR CHECKS DID NOT PROVE.**

Review only the consolidated Feature PR against its objective, integrated Task
evidence, behavior, security, and validation. This is the final judgment gate;
it does not merge, edit, or approve its own work. A green provider status is an
input, not evidence that the adapter actually performed the requested work.
Do not edit files during this review; fail closed when evidence is missing.

## When to Use

Use for a consolidated Feature PR after its Tasks and deterministic validation
evidence are available. Do not use it to review an isolated support PR as if it
were the final Feature, or to repair files during review.

## Prerequisites

Have the Feature objective and acceptance criteria, integrated diff, Task and
checkpoint evidence, provider outcomes, deterministic validation report, and
platform CI results. Know which claims are automated and which require human
judgment.

## How to Run

Run in read-only review mode. Compare claims to the actual diff and evidence.
For every finding give the file, approximate line, concrete behavior, evidence,
and minimum correction. If evidence is absent or stale, request it rather than
assuming success.

## Quick Reference

- F02: text-only OpenAI-compatible adapters cannot claim coding/testing tools;
  empty output is `failed`.
- F03: abort before HTTP, combine cancellation with timeout, and call
  URL-plus-key health `offline ... not yet verified` until probed.
- F04: Antigravity permission denial with exit 0 is `blocked` with
  `failureCategory: permission_denied`.
- Seven local checks cover deterministic repository hygiene; they do not prove
  intent, integration, or an honest provider outcome.
- State confidence and explicitly name what the evidence does not prove.

## Procedure

1. Verify the Feature objective, acceptance criteria, integrated Tasks, and
   final diff. Confirm the Feature is the unit being judged, not a convenient
   subset of its branches.
2. Check the seven deterministic results from `validation/runner.ts`:
   `diff_check`, `secret_scan`, `typecheck_backend`, `typecheck_ui`,
   `tests_focused`, `tests_full`, and `build_ui`. Do not spend provider tokens
   reproducing these local checks; inspect their scope, freshness, and output.
3. Inspect F02. In `agents/openai-compatible.ts`, a bridge with no tools must
   advertise only text capabilities (`conversation`, `research`, `reviewing`,
   `improvement_reviewing`). Empty completion output is not a successful
   response, and a route that truly executes code must not be described as a
   text-only bridge without evidence.
4. Inspect F03. A pre-aborted signal must prevent the HTTP request; the
   cancellation signal and timeout must be combined; URL plus key alone is
   not health proof. Look for an actual probe before accepting `ready`.
5. Inspect F04. An Antigravity exit code of 0 is not enough. Permission-denied
   markers in stdout/stderr must produce `blocked` and
   `failureCategory: permission_denied`, while a legitimate response that
   merely discusses permission must not be misclassified.
6. Judge what automation cannot prove: requirement intent, changed behavior,
   scope boundaries, cross-module integration, whether a reported artifact is
   real, and whether residual risks are acceptable. A passing typecheck cannot
   prove a provider wrote the requested files; a passing build cannot prove the
   PR is correctly scoped.
7. Reject or request changes for concrete blockers only. Include confidence,
   evidence references, and an explicit “not proved” list. Approve only when
   no blocker remains and the human-equivalent judgment is supported.

## Pitfalls

### Red Flags — STOP

- `completed` is accepted solely because a CLI exited 0.
- A text bridge advertises coding or testing despite having no tool path.
- `health()` reports `ready` from configuration fields without a live probe.
- The review repeats the seven checks but never inspects their freshness or
  whether the diff's behavior is covered.
- A large diff is called safe because its tests are green, without checking
  objective scope and integration.
- Missing evidence is converted into “no issue found”.

Violating the letter of the evidence gate violates its purpose: a review should
reduce false approvals, not turn a provider's optimistic label into a fact.

## Common Rationalizations

- **“Exit 0 means the provider did the work.”** F02/F04 require semantic output
  inspection; empty output and soft permission denial are not completion.
- **“The URL and API key are configured, so health is ready.”** F03 says that
  is only configuration. Accept readiness after the actual health probe.
- **“CI is green, so no human judgment is needed.”** CI covers its checks, not
  intent, scope, provider honesty, or integration gaps.
- **“The word permission appears, therefore it is a denial.”** F04's narrow
  denial markers and surrounding action semantics matter; avoid false positives.
- **“No finding in the checked files means the Feature is safe.”** Review the
  consolidated diff and state what was not exercised, rather than treating an
  inspection boundary as proof.

## Verification

Confirm the objective, diff, seven deterministic checks, provider semantics,
and platform evidence were actually inspected. Confirm every blocker has a
file, line, behavior, and evidence reference. Confirm confidence and the
limits of proof are declared. Approve only when the remaining risks are
understood and no adapter claim outruns its evidence.
