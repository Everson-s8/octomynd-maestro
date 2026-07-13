# Octomynd Maestro

Octomynd Maestro coordinates durable work across projects, agents and human gates.

## Language

**Feature**:
A complete user-valued delivery composed of one or more Tasks and represented by one Feature PR.
_Avoid_: Integration bundle, overnight batch

**Task**:
A bounded unit of work that contributes to a Feature or stands alone.
_Avoid_: Feature, Goal

**Goal**:
One persistent agent execution lifecycle for a Task.
_Avoid_: Task, Feature

**Work PR**:
A Task-level pull request retained as isolated evidence while its changes are integrated into a Feature PR.
_Avoid_: Final PR, merge candidate

**Feature PR**:
The single pull request that integrates every Work PR belonging to a Feature and is the only merge candidate for that Feature.
_Avoid_: Integration PR, batch PR

**Final Review**:
The read-only review of the complete Feature PR diff after the user marks it Ready for review.
_Avoid_: Task review, human approval
