import { formatLegacyPreviousSteps, formatTokenEfficientPreviousSteps } from "../runtime/compression.js";
import { formatSkillPromptContext } from "../skills/prompt.js";
import type { AgentExecutionRequest } from "./types.js";

/**
 * Provider-specific output contract. The phase prompt itself is shared by every
 * provider — one prompt per phase/role, regardless of which AI is routed to it.
 * Only the output shape differs: text providers emit a FINAL_REVIEW_DECISION
 * line, JSON providers set an `outcome` field.
 */
export type GoalPromptOutputFormat = {
  /** Closing instruction describing the required output shape. */
  output: string;
  /** How the reviewer reports its verdict in the reviewing phase. */
  reviewingVerdict: string;
};

export const TEXT_GOAL_PROMPT_OUTPUT: GoalPromptOutputFormat = {
  output: "Answer in Portuguese with changed files, tests, blockers and evidence.",
  reviewingVerdict: "Finish with one exact line: FINAL_REVIEW_DECISION: approved OR FINAL_REVIEW_DECISION: changes_requested."
};

export function buildAgentGoalPrompt(
  request: AgentExecutionRequest,
  outputFormat: GoalPromptOutputFormat = TEXT_GOAL_PROMPT_OUTPUT
): string {
  const previous = request.previousStepHandoff
    ? formatTokenEfficientPreviousSteps(request.previousStepHandoff)
    : formatLegacyPreviousSteps(request.previousSteps);
  const phaseInstruction = {
    planning: "Inspect the repository and produce an executable plan. Do not edit files.",
    implementing: "Fully implement the task in the workspace. Preserve scope.",
    testing: request.workerContext?.mode === "read_only"
      ? "Run the relevant tests and report failures. Do not edit files."
      : "Run the relevant tests. Fix only failures caused by the task and validate again.",
    reviewing: [
      "You are the acceptance reviewer for this task. Read-only: do not edit files or run commands.",
      "Evaluate the diff and evidence against the task contract (objective + acceptance criteria + mutation scope).",
      "APPROVE when the objective is implemented, the required tests pass, and no required criterion failed.",
      "REQUEST CHANGES only when a required criterion is unmet, a required test fails, or there is a concrete critical/high defect.",
      "Optional suggestions (naming, cosmetic refactor, out-of-scope UX) do NOT justify changes_requested; list them as non-blocking.",
      "Do not invent a fixed number of improvements and do not apply a UX/visual rubric to backend work with no UI in scope.",
      "If evidence for a criterion is missing, request changes citing which criterion and which evidence is absent.",
      outputFormat.reviewingVerdict
    ].join(" ")
  }[request.phase];

  return [
    "You are an Octomynd Maestro worker executing a persistent goal.",
    "Work autonomously on this step without asking for manual task updates.",
    "Use structured, terse responses in internal handoffs.",
    "Do not use Caveman-style phrasing in security decisions, final reviews, merges, or important messages to the user.",
    "Never commit, push, merge, deploy, change credentials, or leave the workspace.",
    `Project: ${request.project.name} (@${request.project.key})`,
    `Task #${request.task.id}: ${request.task.text}`,
    `Phase: ${request.phase}`,
    phaseInstruction,
    ...formatFeatureTaskContract(request.featureTaskContract),
    ...formatWorkerContext(request.workerContext),
    "",
    "Summarized step history:",
    previous,
    ...(request.resumeContext ? ["", "Resume checkpoint:", request.resumeContext] : []),
    ...formatSkillPromptContext(request.skillContext),
    ...(request.humanFeedback ? ["", "Adjustments requested by the responsible person:", request.humanFeedback] : []),
    "",
    outputFormat.output
  ].join("\n");
}

export function parseFinalReviewDecision(content: string): "approved" | "changes_requested" | null {
  const matches = [...content.matchAll(/FINAL_REVIEW_DECISION:\s*[`"*]*\s*(approved|changes_requested)\b/gi)];
  if (matches.length !== 1) return null;
  return matches[0][1].toLowerCase() as "approved" | "changes_requested";
}

function formatFeatureTaskContract(contract: AgentExecutionRequest["featureTaskContract"]): string[] {
  if (!contract) return [];
  return [
    "",
    "This task's contract in the Feature:",
    `Objective: ${contract.objective}`,
    `Dependencies: ${contract.dependsOnTaskIds.length ? contract.dependsOnTaskIds.map((id) => `#${id}`).join(", ") : "none"}`,
    `Mutation scope: ${contract.mutationScope.length ? contract.mutationScope.join(", ") : "read-only"}`,
    `Out of scope: ${contract.excludedScope.length ? contract.excludedScope.join(", ") : "not specified"}`,
    "Acceptance criteria:",
    ...contract.acceptanceCriteria.map((criterion) => `- ${criterion}`),
    "Do not expand scope without blocking with concrete evidence."
  ];
}

function formatWorkerContext(context: AgentExecutionRequest["workerContext"]): string[] {
  if (!context) return [];
  return [
    "",
    `Worker ${context.key} (${context.role}, ${context.mode})`,
    `Worker objective: ${context.objective}`,
    `Output contract: ${context.outputContract}`,
    `Write scope: ${context.writeScope.length > 0 ? context.writeScope.join(", ") : "none"}`,
    "Input artifacts:",
    ...(context.inputArtifacts.length > 0
      ? context.inputArtifacts.map((artifact) => `- artifact:${artifact.key} - ${artifact.summary}`)
      : ["- none"]),
    "Fulfill only this contract; do not absorb other Workers' responsibilities."
  ];
}
