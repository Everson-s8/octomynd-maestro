---
name: implement-task-safely
description: Implement approved Tasks with bounded evidence.
---

# Implement Task Safely

## Introduction

Implement one approved bounded Task with minimal changes and evidence. This Skill does not commit, push or merge.

## When to Use

Use only for an approved Task with a prepared workspace.

## Prerequisites

Read repository instructions, acceptance criteria and the existing module seams.

## How to Run

Select this Skill explicitly before writing inside the prepared Task workspace; it requires explicit selection.

## Quick Reference

Smallest coherent change, focused validation, protected data and auditable evidence.

## Procedure

1. Restate the acceptance criteria and identify the smallest coherent change.
2. Inspect repository instructions and existing module seams before editing.
3. Fix the root cause without unrelated refactors or dependency churn.
4. Run focused validation first, then the required project checks.
5. Preserve user data, credentials, protected branches and existing work.
6. Never commit, push, merge, deploy or change secrets.
7. Report changed files, checks, remaining risks and evidence. Fail closed when the workspace or requirement is ambiguous.

## Pitfalls

Do not expand scope, change secrets or hide a failed check behind unrelated refactoring.

## Verification

Run focused validation followed by required typecheck, tests, build and secret scan.
