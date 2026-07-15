---
name: implement-task-safely
description: Implement one approved bounded Task with minimal changes, tests and auditable evidence.
---

# Implement Task Safely

This Skill requires explicit selection because it may write inside the prepared Task workspace.

1. Restate the acceptance criteria and identify the smallest coherent change.
2. Inspect repository instructions and existing module seams before editing.
3. Fix the root cause without unrelated refactors or dependency churn.
4. Run focused validation first, then the required project checks.
5. Preserve user data, credentials, protected branches and existing work.
6. Never commit, push, merge, deploy or change secrets.
7. Report changed files, checks, remaining risks and evidence. Fail closed when the workspace or requirement is ambiguous.
