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

**Provider**:
An external execution adapter, currently Codex or Claude, that can satisfy one or more agent capabilities.
A Provider is not a specialist role and is not a Skill.
_Avoid_: Agent, Subagent, Skill

**Skill**:
A versioned, reusable operating procedure with discovery metadata, instructions and optional vetted
resources or deterministic scripts. A Skill guides how work is performed; it does not own a Goal.
_Avoid_: Prompt, Provider, permission grant

**Skill Version**:
An immutable snapshot of a Skill selected and pinned for a Goal. Activation moves a pointer to a
version; it never mutates the version already used by a running Goal.
_Avoid_: Latest mutable skill

**Work Graph**:
A bounded dependency graph inside one Goal. It decomposes a Task into specialist Worker Nodes with
explicit inputs, outputs, budgets and mutation scopes.
_Avoid_: Feature Plan, Task backlog

**Worker Node**:
One bounded unit in a Work Graph executed by a Provider under a specialist role and optional Skills.
Worker Nodes may run in parallel only when their dependencies and mutation scopes do not conflict.
_Avoid_: Task, autonomous project owner
