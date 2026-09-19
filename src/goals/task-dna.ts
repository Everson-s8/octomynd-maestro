/**
 * Task DNA — Self-dimensioning workflow configuration.
 *
 * Each task receives a "DNA" at creation time that defines:
 * - Which phases to execute (trivial tasks skip planning/review)
 * - Max provider calls per phase (not global)
 * - Whether review/tests are required
 * - Whether iteration is allowed
 *
 * This replaces the rigid 4-phase pipeline with an adaptive process
 * proportional to task complexity.
 */

import type { WorkIntakeDecision } from "../intake/types.js";

export type TaskComplexity = "trivial" | "small" | "medium" | "large";

export type GoalPhase = "planning" | "implementing" | "testing" | "reviewing";

export type PhaseBudget = Partial<Record<GoalPhase, number>>;

export type TaskDNA = {
  /** Complexity level determines which phases run and resource limits. */
  complexity: TaskComplexity;
  /** Ordered list of phases to execute. Trivial tasks may only have ["implementing"]. */
  phases: GoalPhase[];
  /** Max provider calls allowed per phase. */
  phaseBudgets: PhaseBudget;
  /** Whether a review phase is required before completion. */
  requireReview: boolean;
  /** Whether automated testing is required. */
  requireTests: boolean;
  /** Whether the reviewer can request changes (reviewing → implementing loop). */
  allowIteration: boolean;
  /** Human-readable reason for this DNA configuration. */
  rationale: string;
  /** Criteria extracted during semantic sizing; absent when no useful criteria exist. */
  acceptanceCriteria?: string[];
};

/**
 * Compute TaskDNA from a WorkIntakeDecision.
 *
 * Uses existing classification signals:
 * - estimatedFileTouchCount → how many files will be touched
 * - estimatedWorkstreamCount → parallel workstreams
 * - dependsOnCount → external dependencies
 * - acceptanceCriteria.length → complexity of requirements
 * - classification → direct_task vs feature_plan
 */
export function computeTaskDNA(input: WorkIntakeDecision): TaskDNA {
  const {
    classification,
    costEstimate,
    coordination,
    acceptanceCriteria,
  } = input;

  const files = costEstimate.estimatedFileTouchCount;
  const workstreams = costEstimate.estimatedWorkstreamCount;
  const deps = coordination.dependsOnCount;
  const criteria = acceptanceCriteria.length;

  // ── TRIVIAL ──────────────────────────────────────────────
  // 1-2 files, no dependencies, single bounded objective
  // Process: implement only. No planning, no review, no tests.
  // Example: fix a typo, rename a variable, update a config value.
  if (
    files <= 2 &&
    deps === 0 &&
    classification === "direct_task" &&
    criteria <= 1
  ) {
    return {
      complexity: "trivial",
      phases: ["implementing"],
      phaseBudgets: { implementing: 2 },
      requireReview: false,
      requireTests: false,
      allowIteration: false,
      rationale: `Trivial: ${files} file(s), ${criteria} criteria, no dependencies. Implement only.`,
    };
  }

  // ── SMALL ────────────────────────────────────────────────
  // ≤5 files, no dependencies, clear objective
  // Process: implement → test. No planning, no review.
  // Example: add a utility function, fix a bug, refactor a module.
  if (
    files <= 5 &&
    deps === 0 &&
    workstreams <= 1 &&
    classification === "direct_task"
  ) {
    return {
      complexity: "small",
      phases: ["implementing", "testing"],
      phaseBudgets: { implementing: 3, testing: 2 },
      requireReview: false,
      requireTests: true,
      allowIteration: false,
      rationale: `Small: ${files} file(s), ${criteria} criteria, 1 workstream. Implement + test.`,
    };
  }

  // ── MEDIUM ───────────────────────────────────────────────
  // ≤10 files, ≤2 workstreams, some coordination
  // Process: plan → implement → test → review. Reviewer can request changes.
  // Example: add a feature, refactor a subsystem, integrate an API.
  if (workstreams <= 2 && files <= 10) {
    return {
      complexity: "medium",
      phases: ["planning", "implementing", "testing", "reviewing"],
      phaseBudgets: { planning: 2, implementing: 5, testing: 3, reviewing: 4 },
      requireReview: true,
      requireTests: true,
      allowIteration: true,
      rationale: `Medium: ${files} file(s), ${workstreams} workstream(s), ${criteria} criteria. Full pipeline with iteration.`,
    };
  }

  // ── LARGE ────────────────────────────────────────────────
  // >10 files OR >2 workstreams OR feature_plan with many criteria
  // Process: plan → implement → test → review. Extended budgets.
  // Example: new feature, major refactor, multi-system integration.
  return {
    complexity: "large",
    phases: ["planning", "implementing", "testing", "reviewing"],
    phaseBudgets: { planning: 3, implementing: 8, testing: 5, reviewing: 6 },
    requireReview: true,
    requireTests: true,
    allowIteration: true,
    rationale: `Large: ${files} file(s), ${workstreams} workstream(s), ${criteria} criteria, ${deps} deps. Extended pipeline.`,
  };
}

/**
 * Compute TaskDNA from raw task text when WorkIntake is not available.
 * Uses heuristic signals from the task description.
 */
export function computeTaskDNAFromText(taskText: string): TaskDNA {
  const text = taskText.toLowerCase();
  const length = taskText.length;
  const wordCount = taskText.trim() ? taskText.trim().split(/\s+/).length : 0;
  const lineCount = taskText.split(/\r?\n/).length;

  // Structural evidence comes before vocabulary. This keeps the offline path
  // from treating translated large requests as cheap merely because their
  // English action keywords are absent.
  const hasMultipleStructuralClauses = /[,;:]/.test(taskText);
  if (lineCount > 3 || (wordCount >= 10 && length >= 60 && (wordCount <= 11 || hasMultipleStructuralClauses))) {
    return {
      complexity: "large",
      phases: ["planning", "implementing", "testing", "reviewing"],
      phaseBudgets: { planning: 3, implementing: 8, testing: 5, reviewing: 6 },
      requireReview: true,
      requireTests: true,
      allowIteration: true,
      rationale: `Offline estimate: large structural signal (length=${length}, words=${wordCount}, lines=${lineCount}).`,
    };
  }

  // Heuristic signals
  const mentionsFeature = /\b(feature|implement|add|create|build|new)\b/i.test(text);
  const mentionsFix = /\b(fix|bug|patch|typo|rename|update config)\b/i.test(text);
  const mentionsMultiple = /\b(and|also|plus|additionally|multi|with)\b/i.test(text);
  const mentionsArchitecture = /\b(architecture|refactor|restructure|redesign)\b/i.test(text);

  // Count distinct action keywords (more keywords = more complex)
  const actionWords = text.match(/\b(implement|add|create|build|fix|refactor|update|remove|test|document|migrate|integrate|support|design)\b/gi);
  const actionCount = actionWords ? actionWords.length : 0;

  // Short text + fix keywords = trivial
  if (length < 100 && mentionsFix && !mentionsMultiple) {
    return {
      complexity: "trivial",
      phases: ["implementing"],
      phaseBudgets: { implementing: 2 },
      requireReview: false,
      requireTests: false,
      allowIteration: false,
      rationale: "Offline estimate: short task text with a bounded fix shape.",
    };
  }

  // Long text OR many action words OR feature + multiple = large
  if (length > 400 || actionCount >= 5 || (mentionsFeature && mentionsMultiple && length > 250)) {
    return {
      complexity: "large",
      phases: ["planning", "implementing", "testing", "reviewing"],
      phaseBudgets: { planning: 3, implementing: 8, testing: 5, reviewing: 6 },
      requireReview: true,
      requireTests: true,
      allowIteration: true,
      rationale: `Offline estimate: large structural signal (length=${length}, actions=${actionCount}, feature=${mentionsFeature}, multiple=${mentionsMultiple}).`,
    };
  }

  // Feature with moderate complexity = small
  if (mentionsFeature && !mentionsArchitecture && length < 300 && !mentionsMultiple) {
    return {
      complexity: "small",
      phases: ["implementing", "testing"],
      phaseBudgets: { implementing: 3, testing: 2 },
      requireReview: false,
      requireTests: true,
      allowIteration: false,
      rationale: "Offline estimate: compact feature-shaped request.",
    };
  }

  // Architecture or multi-part = medium
  if (mentionsArchitecture || mentionsMultiple) {
    return {
      complexity: "medium",
      phases: ["planning", "implementing", "testing", "reviewing"],
      phaseBudgets: { planning: 2, implementing: 5, testing: 3, reviewing: 4 },
      requireReview: true,
      requireTests: true,
      allowIteration: true,
      rationale: "Offline estimate: architecture or multi-part shape.",
    };
  }

  // Language-independent structural fallback. This is deliberately cheaper
  // than the old medium default: uncertainty must not spend the customer's
  // expensive budget. Model sizing is the normal path; this is only offline
  // safety net behavior.
  if (lineCount === 1 && wordCount <= 6 && length < 80) {
    return {
      complexity: "trivial",
      phases: ["implementing"],
      phaseBudgets: { implementing: 2 },
      requireReview: false,
      requireTests: false,
      allowIteration: false,
      rationale: "Offline estimate: one short bounded request."
    };
  }

  if (lineCount <= 2 && wordCount <= 14 && length < 220 && !mentionsMultiple) {
    return {
      complexity: "small",
      phases: ["implementing", "testing"],
      phaseBudgets: { implementing: 3, testing: 2 },
      requireReview: false,
      requireTests: true,
      allowIteration: false,
      rationale: "Offline estimate: compact request with no structural evidence of multiple workstreams."
    };
  }

  // Default: small (cheap uncertainty fallback)
  return {
    complexity: "small",
    phases: ["implementing", "testing"],
    phaseBudgets: { implementing: 3, testing: 2 },
    requireReview: false,
    requireTests: true,
    allowIteration: false,
    rationale: "Offline estimate: uncertain scope uses the cheaper small budget; model sizing should replace this when available.",
  };
}

/**
 * Compatibility fallback for coordinators created without the production
 * semantic sizing callback (for example older integrations and test hosts).
 * The runtime entrypoint always supplies sizeTaskWithModel, but preserving the
 * previous medium default here avoids changing an existing caller's phase
 * contract merely because it has not adopted the new callback yet.
 */
export function computeLegacyTaskDNAFromText(taskText: string): TaskDNA {
  const dna = computeTaskDNAFromText(taskText);
  if (!dna.rationale.startsWith("Offline estimate: one short")
    && !dna.rationale.startsWith("Offline estimate: compact request")
    && !dna.rationale.startsWith("Offline estimate: uncertain scope")) {
    return dna;
  }
  return {
    complexity: "medium",
    phases: ["planning", "implementing", "testing", "reviewing"],
    phaseBudgets: { planning: 2, implementing: 5, testing: 3, reviewing: 4 },
    requireReview: true,
    requireTests: true,
    allowIteration: true,
    rationale: "Compatibility estimate: legacy caller did not provide semantic sizing."
  };
}
