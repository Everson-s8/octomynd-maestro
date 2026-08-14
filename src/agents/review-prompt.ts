import type { ProjectRecord, TaskRecord } from "../db.js";

/**
 * Acceptance-review prompting — single home for "what does reviewing a task
 * mean" regardless of which provider is routed to the review.
 *
 * The prompt is defined by ROLE (acceptance reviewer) and PHASE (reviewing),
 * never by provider. Claude, Antigravity, Codex and any custom CLI all receive
 * the same acceptance contract; the only per-provider variation is the output
 * shape (a FINAL_REVIEW_DECISION line for text providers, an `outcome` field
 * for JSON providers), which is injected by the caller.
 *
 * Two framings share the same rules here:
 *  - buildReviewPhaseInstruction: the concise instruction embedded into the
 *    goal-loop worker prompt (planning/implementing/testing/reviewing).
 *  - buildReviewPrompt: the standalone one-shot review prompt used by the
 *    manual "review this task" endpoint.
 */

export const TEXT_REVIEW_VERDICT =
  "Finish with one exact line: FINAL_REVIEW_DECISION: approved OR FINAL_REVIEW_DECISION: changes_requested.";

/** Canonical acceptance rules — the single source of truth for the review. */
const REVIEW_RULES = [
  "You are the acceptance reviewer for this task. Read-only: do not edit files or run commands.",
  "Evaluate the diff and evidence against the task contract (objective + acceptance criteria + mutation scope).",
  "APPROVE when the objective is implemented, the required tests pass, and no required criterion failed.",
  "REQUEST CHANGES only when a required criterion is unmet, a required test fails, or there is a concrete critical/high defect.",
  "Optional suggestions (naming, cosmetic refactor, out-of-scope UX) do NOT justify changes_requested; list them as non-blocking.",
  "Do not invent a fixed number of improvements and do not apply a UX/visual rubric to backend work with no UI in scope.",
  "If evidence for a criterion is missing, request changes citing which criterion and which evidence is absent."
];

/**
 * Concise reviewing-phase instruction, embedded into the shared goal prompt.
 * `verdictLine` is provider-specific: text providers use TEXT_REVIEW_VERDICT,
 * JSON providers substitute their own outcome-field instruction.
 */
export function buildReviewPhaseInstruction(verdictLine: string): string {
  return [...REVIEW_RULES, verdictLine].join(" ");
}

/**
 * Standalone one-shot review prompt for the manual review endpoint.
 * Provider-agnostic: the same prompt is sent regardless of which agent the
 * user routed the review to.
 */
export function buildReviewPrompt(
  task: TaskRecord,
  project: ProjectRecord,
  verdictLine: string = TEXT_REVIEW_VERDICT
): string {
  return [
    "You are the acceptance reviewer for Octomynd Maestro.",
    "Work in read-only mode. Do not edit files and do not run commands.",
    `Project: ${project.name} (@${project.key})`,
    `Task #${task.id}: ${task.text}`,
    "",
    "Your only approval authority is the task objective and its acceptance criteria.",
    "Evaluate the current repository state against that contract and answer in Portuguese:",
    "1. criteria met, with concrete evidence for each (file/test/line);",
    "2. criteria NOT met or concrete defects (critical/high), if any;",
    "3. optional non-blocking suggestions, without requiring a fixed number of improvements;",
    "4. a single exact verdict on its own line.",
    ...REVIEW_RULES,
    verdictLine,
    "Style/UX/cosmetic-refactor suggestions do NOT block approval unless they are in the task scope.",
    "If docs/VISUAL_IDENTITY.md exists, use it as a visual contract only when the scope involves UI."
  ].join("\n");
}
