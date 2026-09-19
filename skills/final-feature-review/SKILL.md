---
name: final-feature-review
description: Review consolidated Feature PRs before merge.
---

# Final Feature Review

## Introduction

Review only the consolidated Feature PR against requirements, evidence, tests and security. This Skill does not merge or approve its own work.

## When to Use

Use for the final consolidated Feature PR review.

## Prerequisites

Have the objective, acceptance criteria, integrated Tasks, final diff and validation evidence.

## How to Run

Run in read-only review mode against the consolidated Feature PR.

## Quick Reference

Find concrete correctness, security, regression or maintainability blockers only.

## Procedure

1. Verify objective, acceptance criteria, integrated Tasks and final diff.
2. Check typecheck, tests, build, smoke, secret scan and platform CI evidence.
3. Identify only concrete correctness, security, regression or maintainability blockers.
4. Do not edit files, approve your own work, merge, close branches or weaken checks.
5. If evidence is missing or stale, request changes and fail closed.

Return one final decision with concise findings, validation evidence and residual risks.

## Pitfalls

Do not treat supporting Work PRs as independent merge candidates or accept stale evidence.

## Verification

Confirm typecheck, tests, build, smoke, secret scan and platform CI evidence before deciding.
