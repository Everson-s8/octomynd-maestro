---
name: diagnose-goal-failure
description: Diagnose a failed, blocked or stalled Goal from bounded artifacts before retrying work.
---

# Diagnose Goal Failure

Use only the Goal record, compact handoffs, provider telemetry, validation report and bounded runtime artifacts.

1. Classify the primary cause as environment, provider auth/quota, timeout, validation, code defect or orchestration.
2. Cite concrete evidence and distinguish facts from hypotheses.
3. Prefer the smallest reversible recovery action.
4. Do not edit files, retry providers, change status, mutate policy or expose private paths and credentials.
5. If evidence is insufficient, fail closed and state exactly which artifact is missing.

Return a short diagnosis, evidence list, recovery action and recurrence-prevention note.
