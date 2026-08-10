import { performance } from "node:perf_hooks";
import {
  WorkIntakeCategory,
  WorkIntakeClassification,
  WorkIntakeInput,
  WorkIntakeMode
} from "./types.js";

const PRIOR_WORKFLOW_OVERHEAD_MS = 4000.0;

export function parseOverrideFromText(text: string): { cleanedText: string; overrideMode: WorkIntakeMode | null } {
  const modeMatch = text.match(/--(?:mode|override)=(single_agent|feature_plan|work_graph|needs_clarification)\b/i);
  if (modeMatch) {
    const overrideMode = modeMatch[1].toLowerCase() as WorkIntakeMode;
    const cleanedText = text.replace(modeMatch[0], "").replace(/\s+/g, " ").trim();
    return { cleanedText, overrideMode };
  }
  return { cleanedText: text.trim(), overrideMode: null };
}

export function classifyWorkIntake(input: WorkIntakeInput): WorkIntakeClassification {
  const startTime = performance.now();
  const { cleanedText, overrideMode: parsedOverride } = parseOverrideFromText(input.text);
  const explicitOverrideMode = input.overrideMode || parsedOverride;
  const textLower = cleanedText.toLowerCase();

  const reasons: string[] = [];
  let category: WorkIntakeCategory = "multi_deliverable_feature";
  let decisionMode: WorkIntakeMode = "feature_plan";
  let score = 0.5;

  // 1. Ambiguous Request Check
  const ambiguousPhrases = [
    "make it better",
    "fix it",
    "do something",
    "update codebase",
    "change code",
    "refactor everything",
    "make changes",
    "fix bug",
    "help me"
  ];
  const isTooShort = cleanedText.length < 12 && !/^(fix|add|update|docs|remove|test)\s+\w+/i.test(cleanedText);
  const matchesAmbiguous = ambiguousPhrases.some((phrase) => textLower === phrase || textLower === `${phrase}.`);

  if (isTooShort || matchesAmbiguous) {
    category = "ambiguous_request";
    decisionMode = "needs_clarification";
    score = 0.90;
    reasons.push("Demand request lacks sufficient detail or actionability.");
  }
  // 2. Tiny Fix Check
  else if (
    /\b(typo|spelling|one-line|quick fix|minor fix|small fix|rename variable|fix syntax|fix typo|tweak styling)\b/i.test(cleanedText)
  ) {
    category = "tiny_fix";
    decisionMode = "single_agent";
    score = 0.15;
    reasons.push("Bounded low-complexity single file or minor inline edit.");
  }
  // 3. Documentation Check
  else if (
    /\b(readme|doc|docs|documentation|docstring|user guide|changelog|adr|comments)\b/i.test(cleanedText) &&
    !/\b(backend|frontend|ui|migration|database|schema)\b/i.test(cleanedText)
  ) {
    category = "documentation";
    decisionMode = "single_agent";
    score = 0.20;
    reasons.push("Documentation update without mutating runtime product logic.");
  }
  // 4. Audit Check
  else if (
    /\b(audit|security review|vulnerability scan|compliance check|codebase audit|dependency audit|onboarding audit)\b/i.test(cleanedText)
  ) {
    category = "audit";
    decisionMode = "single_agent";
    score = 0.30;
    reasons.push("Read-only audit, review, or diagnostic evaluation.");
  }
  // 5. Dependent Work Check
  else if (
    /\b(depends on|prerequisite|after feature|successor|stacked feature|requires task|after plan)\b/i.test(cleanedText)
  ) {
    category = "dependent_work";
    decisionMode = "feature_plan";
    score = 0.75;
    reasons.push("Sequential dependency declared requiring ordered Feature Plan admission.");
  }
  // 6. Parallel-Safe Work Check
  else if (
    /\b(independent worker|parallel-safe|parallel execution|concurrent worker|isolated background|non-conflicting|work graph)\b/i.test(cleanedText)
  ) {
    category = "parallel_safe_work";
    decisionMode = "work_graph";
    score = 0.65;
    reasons.push("Decoupled workers eligible for parallel Work Graph execution.");
  }
  // 7. Multi-Deliverable Feature (Default for complex work)
  else {
    category = "multi_deliverable_feature";
    decisionMode = "feature_plan";
    score = 0.85;
    reasons.push("Multi-file deliverable requiring Feature Plan integration and consolidated review.");
  }

  const overrideApplied = Boolean(explicitOverrideMode);
  let actualMode = decisionMode;
  let finalCategory: WorkIntakeCategory = category;

  if (overrideApplied && explicitOverrideMode) {
    actualMode = explicitOverrideMode;
    finalCategory = "explicit_override";
    reasons.unshift(`Explicit operator override applied: mode forced to '${explicitOverrideMode}'.`);
  }

  const endTime = performance.now();
  const estimatedOverheadMs = Number((endTime - startTime).toFixed(3));

  return {
    taskId: input.taskId ?? 0,
    category: finalCategory,
    decisionMode,
    actualMode,
    overrideMode: explicitOverrideMode ?? null,
    score,
    reasons,
    estimatedOverheadMs,
    priorWorkflowOverheadMs: PRIOR_WORKFLOW_OVERHEAD_MS,
    overrideApplied
  };
}
