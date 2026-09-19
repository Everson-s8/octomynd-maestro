---
name: diagnose-goal-failure
description: Diagnose failed Goals from bounded evidence.
---

# Diagnose Goal Failure

## Introduction

Diagnose failed Goals from bounded evidence. This Skill does not change code or retry work.

## When to Use

Use when a Goal is failed, blocked or stalled.

## Prerequisites

Read the Goal record, compact handoffs, provider telemetry, validation report and bounded runtime artifacts.

## How to Run

Run the diagnosis in the prepared workspace with no write access.

## Quick Reference

Classify the cause, cite evidence, choose a reversible recovery and state missing evidence.

## Procedure

1. Classify the primary cause as environment, provider auth/quota, timeout, validation, code defect or orchestration.
2. Cite concrete evidence and distinguish facts from hypotheses.
3. Prefer the smallest reversible recovery action.
4. Do not edit files, retry providers, change status, mutate policy or expose private paths and credentials.
5. If evidence is insufficient, fail closed and state exactly which artifact is missing.

Return a short diagnosis, evidence list, recovery action and recurrence-prevention note.

## Pitfalls

Do not infer a cause from an absent artifact or expose private paths and credentials.

## Verification

Confirm every claim is supported by a bounded artifact and fail closed when evidence is missing.
