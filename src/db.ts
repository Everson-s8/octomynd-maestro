import Database from "better-sqlite3";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { buildFeatureCompletionEvidencePack } from "./improvements/evidence.js";
import { redactSensitiveText, sanitizePublicMetadata } from "./security/redaction.js";
import {
  CompletionReviewClaimInput,
  CompletionReviewFinishStatus,
  CompletionReviewRecord,
  CompletionReviewSubjectType,
  CompletionReviewStatus
} from "./improvements/types.js";
import { createSkillPersistence, migrateSkillPersistence } from "./skills/persistence.js";
import { createWorkGraphPersistence, migrateWorkGraphPersistence } from "./work-graphs/persistence.js";
import {
  createProviderPolicyPersistence,
  migrateProviderPolicyPersistence
} from "./agents/policy-persistence.js";
import {
  FeatureTaskContract,
  FeatureTaskContractInput,
  legacyFeatureTaskContract,
  normalizeFeatureTaskContracts
} from "./features/task-graph.js";
export type {
  GoalSkillInvocationMode,
  GoalSkillPinRecord,
  SkillArchiveActor,
  SkillEvaluationCheck,
  SkillEvaluationComparison,
  SkillEvaluationInput,
  SkillEvaluationRecord,
  SkillProposalInput,
  SkillProposalRecord,
  SkillProposalStatus,
  SkillRecord,
  SkillUsageRecord,
  SkillUsageSummary,
  SkillVersionLifecycleStatus,
  SkillVersionRecord,
  SkillVersionRegistrationInput
} from "./skills/persistence.js";
export type { SkillOwner, SkillRisk, SkillScope } from "./skills/types.js";

export type TaskStatus =
  | "queued"
  | "planning"
  | "implementing"
  | "testing"
  | "reviewing"
  | "changes_requested"
  | "awaiting_human"
  | "ready_to_merge"
  | "rejected"
  | "waiting_quota"
  | "waiting_provider"
  | "waiting_dependency"
  | "blocked"
  | "failed"
  | "cancelled"
  | "done";

export type ProjectRecord = {
  id: number;
  key: string;
  name: string;
  path: string;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
};

export type ProjectInput = {
  key: string;
  name?: string;
  path: string;
  defaultBranch?: string;
};

export type TaskRecord = {
  id: number;
  projectId: number | null;
  projectKey: string | null;
  projectName: string | null;
  text: string;
  status: TaskStatus;
  source: string;
  branchName: string | null;
  worktreePath: string | null;
  baseBranch?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type TaskWorktreeUpdate = {
  id: number;
  status: TaskStatus;
  branchName: string;
  worktreePath: string;
  baseBranch?: string | null;
};

export type EventRecord = {
  id: number;
  source: string;
  type: string;
  text: string;
  userId: string | null;
  username: string | null;
  taskId: number | null;
  createdAt: string;
  metadata: Record<string, unknown>;
};

export type EventInput = {
  source: string;
  type: string;
  text: string;
  userId?: string | null;
  username?: string | null;
  taskId?: number | null;
  metadata?: Record<string, unknown>;
};

export type TaskReviewStatus = "completed" | "auth_required" | "failed";

export type TaskReviewRecord = {
  id: number;
  taskId: number;
  provider: string;
  status: TaskReviewStatus;
  content: string;
  error: string | null;
  createdAt: string;
};

export type TaskReviewInput = {
  taskId: number;
  provider: string;
  status: TaskReviewStatus;
  content?: string;
  error?: string | null;
};

export type ImprovementCategory = "skill" | "memory" | "routing" | "policy" | "integration";
export type ImprovementRisk = "low" | "medium" | "high";
export type ImprovementStatus = "candidate" | "approved" | "rejected";

export type ImprovementProposalRecord = {
  id: number;
  category: ImprovementCategory;
  title: string;
  rationale: string;
  proposedChange: string;
  evidence: string[];
  risk: ImprovementRisk;
  source: string;
  projectKey: string | null;
  targets: string[];
  confidence: number | null;
  fingerprint: string | null;
  provenance: Record<string, unknown>;
  status: ImprovementStatus;
  decisionNote: string | null;
  createdAt: string;
  decidedAt: string | null;
  taskId: number | null;
  featurePlanId: number | null;
};

export type ImprovementProposalInput = {
  category: ImprovementCategory;
  title: string;
  rationale: string;
  proposedChange: string;
  evidence: string[];
  risk: ImprovementRisk;
  source?: string;
  projectKey?: string | null;
  targets?: string[];
  confidence?: number | null;
  fingerprint?: string | null;
  provenance?: Record<string, unknown>;
};

export type GoalRunStatus = "running" | "waiting_provider" | "completed" | "blocked" | "failed" | "cancelled";
export type GoalPhase = "planning" | "implementing" | "testing" | "reviewing";
export type GoalStepStatus = "running" | "completed" | "changes_requested" | "blocked" | "failed" | "cancelled";
export type GoalWaitReason =
  | "quota"
  | "auth_required"
  | "timeout"
  | "output_limit"
  | "offline"
  | "capacity"
  | "runtime_restart"
  | "unknown";

export type GoalRunRecord = {
  id: number;
  taskId: number;
  status: GoalRunStatus;
  currentPhase: GoalPhase;
  stepCount: number;
  maxSteps: number;
  lastError: string | null;
  waitReason?: GoalWaitReason | null;
  nextRetryAt?: string | null;
  lastProvider?: string | null;
  commitSha: string | null;
  pullRequestUrl: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
};

export type GoalCheckpointStatus = "completed" | "interrupted";

export type GoalCheckpointRecord = {
  id: number;
  runId: number;
  stepId: number;
  phase: GoalPhase;
  provider: string;
  status: GoalCheckpointStatus;
  summary: string;
  workspaceFingerprint: string | null;
  changedFiles: string[];
  artifactKeys: string[];
  createdAt: string;
};

export type GoalCheckpointInput = Omit<GoalCheckpointRecord, "id" | "createdAt">;

export type GoalStepRecord = {
  id: number;
  runId: number;
  phase: GoalPhase;
  provider: string;
  status: GoalStepStatus;
  summary: string;
  output: string;
  error: string | null;
  durationMs: number | null;
  createdAt: string;
  finishedAt: string | null;
};

export type HumanReviewDecision = "approved" | "changes_requested" | "rejected";

export type HumanReviewRecord = {
  id: number;
  runId: number;
  taskId: number;
  decision: HumanReviewDecision;
  note: string;
  source: string;
  createdAt: string;
};

export type FeatureStatus =
  | "draft"
  | "waiting_checks"
  | "reviewing"
  | "waiting_provider"
  | "changes_requested"
  | "merging"
  | "completed"
  | "failed"
  | "cancelled";

export type FeatureRecord = {
  id: number;
  projectId: number;
  projectKey: string;
  projectName: string;
  featurePlanId: number | null;
  name: string;
  objective: string;
  status: FeatureStatus;
  branchName: string;
  worktreePath: string;
  pullRequestUrl: string;
  reviewerProvider: string | null;
  reviewSummary: string | null;
  reviewedHeadSha: string | null;
  lastError: string | null;
  mergedAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  createdAt: string;
  updatedAt: string;
};

export type FeatureItemStatus = "included" | "completed" | "cleanup_pending";

export type FeatureItemRecord = {
  id: number;
  featureId: number;
  taskId: number;
  pullRequestUrl: string;
  branchName: string;
  status: FeatureItemStatus;
  createdAt: string;
  updatedAt: string;
};

export type FeatureInput = {
  projectKey: string;
  featurePlanId?: number | null;
  name: string;
  objective: string;
  branchName: string;
  worktreePath: string;
  pullRequestUrl: string;
};

export type FeaturePlanQueueStatus =
  | "queued"
  | "admitted"
  | "active"
  | "waiting_review"
  | "waiting_merge"
  | "blocked"
  | "completed"
  | "cancelled";

export type FeaturePlanStatus = FeaturePlanQueueStatus | "planned";

export type FeaturePlanRecord = {
  id: number;
  projectId: number;
  projectKey: string;
  projectName: string;
  objective: string;
  acceptanceCriteria: string[];
  status: FeaturePlanQueueStatus;
  priority: number;
  isPaused: boolean;
  pausedAt: string | null;
  pauseReason: string | null;
  blockedAt: string | null;
  blockedReason: string | null;
  admittedAt: string | null;
  completedAt: string | null;
  source: string;
  createdByUserId: string | null;
  createdByUsername: string | null;
  revision: number;
  cancelledAt: string | null;
  cancelReason: string | null;
  createdAt: string;
  updatedAt: string;
};

export type FeaturePlanDependencyRecord = {
  id: number;
  featurePlanId: number;
  dependsOnFeaturePlanId: number;
  createdAt: string;
};

export type FeaturePlanHistoryRecord = {
  id: number;
  featurePlanId: number;
  fromStatus: FeaturePlanQueueStatus | null;
  toStatus: FeaturePlanQueueStatus;
  action: string;
  reason: string | null;
  actorUserId: string | null;
  actorUsername: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type FeaturePlanEligibilityResult = {
  featurePlanId: number;
  projectKey: string;
  eligible: boolean;
  reason: string;
  blockedByPaused: boolean;
  blockedByStatus: boolean;
  blockedDependencies: Array<{ id: number; status: FeaturePlanQueueStatus }>;
  blockedByActiveProjectPlan: { id: number; status: FeaturePlanQueueStatus } | null;
};

export type FeaturePlanTaskRecord = {
  id: number;
  featurePlanId: number;
  taskId: number;
  taskText: string;
  taskStatus: TaskStatus;
  position: number;
  contract: FeatureTaskContract;
  createdAt: string;
};

export type FeaturePlanDetails = {
  plan: FeaturePlanRecord;
  tasks: FeaturePlanTaskRecord[];
};

export type FeaturePlanWriteResult = FeaturePlanDetails & {
  applied: boolean;
};

export type RuntimeUpdateStatus = "pending" | "in_progress" | "completed" | "failed" | "rolled_back";

export type RuntimeUpdateRecord = {
  id: number;
  featureId: number | null;
  targetCommit: string;
  previousCommit: string;
  status: RuntimeUpdateStatus;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};

export type GitHubIssueSubjectType = "feature_plan" | "task";

export type GitHubIssueLinkRecord = {
  id: number;
  subjectType: GitHubIssueSubjectType;
  subjectId: number;
  issueNumber: number;
  createdAt: string;
};

export type FeaturePlanIssueLinks = {
  featureIssueNumber: number | null;
  taskIssueNumbers: Record<number, number>;
};

export type FeaturePlanInput = {
  projectKey: string;
  objective: string;
  acceptanceCriteria: string[];
  taskIds: number[];
  taskContracts?: FeatureTaskContractInput[];
  priority?: number;
  dependsOnFeaturePlanIds?: number[];
  featureIssueNumber?: number | null;
  taskIssueNumbers?: Record<number, number>;
  source?: string;
  createdByUserId?: string | null;
  createdByUsername?: string | null;
  idempotencyKey?: string | null;
};

export type FeaturePlanReplanInput = {
  id: number;
  objective: string;
  acceptanceCriteria: string[];
  taskIds: number[];
  taskContracts?: FeatureTaskContractInput[];
  idempotencyKey?: string | null;
};

export type FeaturePlanIntegrationStatus =
  | "preparing"
  | "integrating"
  | "verifying"
  | "completed"
  | "failed";

export type FeaturePlanIntegrationCheckpoint =
  | "created"
  | "validated"
  | "base_fetched"
  | "worktree_created"
  | "integrating"
  | "commits_integrated"
  | "secret_scan_passed"
  | "diff_check_passed"
  | "completed"
  | "failed";

export type FeaturePlanIntegrationRecord = {
  id: number;
  featurePlanId: number;
  projectId: number;
  projectKey: string;
  projectName: string;
  planRevision: number;
  status: FeaturePlanIntegrationStatus;
  checkpoint: FeaturePlanIntegrationCheckpoint;
  branchName: string;
  worktreePath: string;
  baseSha: string | null;
  headSha: string | null;
  lastError: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type FeaturePlanIntegrationItemStatus = "pending" | "integrated" | "failed";

export type FeaturePlanIntegrationItemRecord = {
  id: number;
  integrationId: number;
  featurePlanId: number;
  taskId: number;
  taskText: string;
  taskStatus: TaskStatus;
  position: number;
  commitSha: string;
  pullRequestUrl: string;
  branchName: string;
  status: FeaturePlanIntegrationItemStatus;
  appliedCommitSha: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

export type FeaturePlanIntegrationDetails = {
  integration: FeaturePlanIntegrationRecord;
  items: FeaturePlanIntegrationItemRecord[];
};

export type FeaturePlanIntegrationInput = {
  featurePlanId: number;
  projectId: number;
  planRevision: number;
  branchName: string;
  worktreePath: string;
};

export type FeaturePlanIntegrationUpdate = {
  id: number;
  status?: FeaturePlanIntegrationStatus;
  checkpoint?: FeaturePlanIntegrationCheckpoint;
  baseSha?: string | null;
  headSha?: string | null;
  lastError?: string | null;
  completedAt?: string | null;
};

export type FeaturePlanIntegrationItemInput = {
  integrationId: number;
  featurePlanId: number;
  taskId: number;
  position: number;
  commitSha: string;
  pullRequestUrl: string;
  branchName: string;
};

export type FeaturePlanIntegrationItemUpdate = {
  id: number;
  status: FeaturePlanIntegrationItemStatus;
  appliedCommitSha?: string | null;
  lastError?: string | null;
};

export type MaestroDatabase = ReturnType<typeof createDatabase>;

export function createDatabase(databasePath: string) {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });

  const db = new Database(databasePath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  migrateProviderPolicyPersistence(db);
  const skillPersistence = createSkillPersistence(db);
  const workGraphPersistence = createWorkGraphPersistence(db);
  const providerPolicyPersistence = createProviderPolicyPersistence(db);

  const createTaskStatement = db.prepare(`
    INSERT INTO tasks (project_id, text, status, source, branch_name, worktree_path, created_at, updated_at)
    VALUES (@projectId, @text, 'queued', @source, NULL, NULL, @now, @now)
  `);
  const addEventStatement = db.prepare(`
    INSERT INTO events (source, type, text, user_id, username, task_id, created_at, metadata_json)
    VALUES (@source, @type, @text, @userId, @username, @taskId, @now, @metadataJson)
  `);
  const upsertProjectStatement = db.prepare(`
    INSERT INTO projects (key, name, path, default_branch, created_at, updated_at)
    VALUES (@key, @name, @path, @defaultBranch, @now, @now)
    ON CONFLICT(key) DO UPDATE SET
      name = excluded.name,
      path = excluded.path,
      default_branch = excluded.default_branch,
      updated_at = excluded.updated_at
  `);
  const updateTaskWorktreeStatement = db.prepare(`
    UPDATE tasks
    SET status = @status,
        branch_name = @branchName,
        worktree_path = @worktreePath,
        base_branch = @baseBranch,
        updated_at = @now
    WHERE id = @id
  `);
  const addTaskReviewStatement = db.prepare(`
    INSERT INTO task_reviews (task_id, provider, status, content, error, created_at)
    VALUES (@taskId, @provider, @status, @content, @error, @now)
  `);
  const addImprovementProposalStatement = db.prepare(`
    INSERT INTO improvement_proposals (
      category, title, rationale, proposed_change, evidence_json, risk, source,
      project_key, targets_json, confidence, fingerprint, provenance_json,
      status, decision_note, created_at, decided_at, task_id, feature_plan_id
    )
    VALUES (
      @category, @title, @rationale, @proposedChange, @evidenceJson, @risk, @source,
      @projectKey, @targetsJson, @confidence, @fingerprint, @provenanceJson,
      'candidate', NULL, @now, NULL, NULL, NULL
    )
  `);
  const decideImprovementProposalStatement = db.prepare(`
    UPDATE improvement_proposals
    SET status = @status,
        decision_note = @decisionNote,
        decided_at = @now
    WHERE id = @id AND status = 'candidate'
  `);
  const attachImprovementActivationStatement = db.prepare(`
    UPDATE improvement_proposals
    SET task_id = @taskId, feature_plan_id = @featurePlanId
    WHERE id = @id AND status = 'approved'
  `);
  const updateTaskStatusStatement = db.prepare(`
    UPDATE tasks SET status = @status, updated_at = @now WHERE id = @id
  `);
  const deleteTaskStatement = db.prepare("DELETE FROM tasks WHERE id = ?");
  const createGoalRunStatement = db.prepare(`
    INSERT INTO goal_runs (
      task_id, status, current_phase, step_count, max_steps, last_error,
      wait_reason, next_retry_at, last_provider, created_at, updated_at, finished_at
    )
    VALUES (@taskId, 'running', 'planning', 0, @maxSteps, NULL, NULL, NULL, NULL, @now, @now, NULL)
  `);
  const updateGoalRunStatement = db.prepare(`
    UPDATE goal_runs
    SET status = @status,
        current_phase = @currentPhase,
        step_count = @stepCount,
        last_error = @lastError,
        wait_reason = @waitReason,
        next_retry_at = @nextRetryAt,
        last_provider = @lastProvider,
        updated_at = @now,
        finished_at = @finishedAt
    WHERE id = @id
  `);
  const updateGoalDeliveryStatement = db.prepare(`
    UPDATE goal_runs
    SET commit_sha = @commitSha,
        pull_request_url = @pullRequestUrl,
        updated_at = @now
    WHERE id = @id
  `);
  const createGoalStepStatement = db.prepare(`
    INSERT INTO goal_steps (
      run_id, phase, provider, status, summary, output, error, duration_ms,
      created_at, finished_at
    )
    VALUES (@runId, @phase, @provider, 'running', '', '', NULL, NULL, @now, NULL)
  `);
  const finishGoalStepStatement = db.prepare(`
    UPDATE goal_steps
    SET status = @status,
        summary = @summary,
        output = @output,
        error = @error,
        duration_ms = @durationMs,
        finished_at = @now
    WHERE id = @id
  `);
  const createGoalCheckpointStatement = db.prepare(`
    INSERT INTO goal_checkpoints (
      run_id, step_id, phase, provider, status, summary, workspace_fingerprint,
      changed_files_json, artifact_keys_json, created_at
    )
    VALUES (
      @runId, @stepId, @phase, @provider, @status, @summary, @workspaceFingerprint,
      @changedFilesJson, @artifactKeysJson, @now
    )
  `);
  const addHumanReviewStatement = db.prepare(`
    INSERT INTO human_reviews (run_id, task_id, decision, note, source, created_at)
    VALUES (@runId, @taskId, @decision, @note, @source, @now)
  `);
  const reopenGoalRunStatement = db.prepare(`
    UPDATE goal_runs
    SET status = 'running',
        current_phase = 'implementing',
        max_steps = MAX(max_steps, step_count + 4),
        last_error = NULL,
        updated_at = @now,
        finished_at = NULL
    WHERE id = @id AND status = 'completed'
  `);
  const createFeatureStatement = db.prepare(`
    INSERT INTO features (
      project_id, feature_plan_id, name, objective, status, branch_name, worktree_path,
      pull_request_url, reviewer_provider, review_summary, reviewed_head_sha,
      last_error, merged_at, created_at, updated_at
    )
    VALUES (
      @projectId, @featurePlanId, @name, @objective, 'draft', @branchName, @worktreePath,
      @pullRequestUrl, NULL, NULL, NULL, NULL, NULL, @now, @now
    )
  `);
  const updateFeatureStatement = db.prepare(`
    UPDATE features
    SET status = @status,
        reviewer_provider = @reviewerProvider,
        review_summary = @reviewSummary,
        reviewed_head_sha = @reviewedHeadSha,
        last_error = @lastError,
        merged_at = @mergedAt,
        updated_at = @now
    WHERE id = @id
  `);
  const cancelFeatureStatement = db.prepare(`
    UPDATE features
    SET status = 'cancelled',
        cancelled_at = @now,
        cancel_reason = @cancelReason,
        updated_at = @now
    WHERE id = @id AND status NOT IN ('completed', 'merging', 'cancelled')
  `);
  const addFeatureItemStatement = db.prepare(`
    INSERT INTO feature_items (
      feature_id, task_id, pull_request_url, branch_name, status, created_at, updated_at
    )
    VALUES (@featureId, @taskId, @pullRequestUrl, @branchName, 'included', @now, @now)
  `);
  const updateFeatureItemStatusStatement = db.prepare(`
    UPDATE feature_items SET status = @status, updated_at = @now WHERE id = @id
  `);
  const createFeaturePlanStatement = db.prepare(`
    INSERT INTO feature_plans (
      project_id, objective, acceptance_criteria_json, status, priority, is_paused, source,
      created_by_user_id, created_by_username, revision,
      cancelled_at, cancel_reason, created_at, updated_at
    )
    VALUES (
      @projectId, @objective, @acceptanceCriteriaJson, 'queued', @priority, 0, @source,
      @createdByUserId, @createdByUsername, 1,
      NULL, NULL, @now, @now
    )
  `);
  const addFeaturePlanTaskStatement = db.prepare(`
    INSERT INTO feature_plan_tasks (feature_plan_id, task_id, position, contract_json, created_at)
    VALUES (@featurePlanId, @taskId, @position, @contractJson, @now)
  `);
  const addGitHubIssueLinkStatement = db.prepare(`
    INSERT INTO github_issue_links (subject_type, subject_id, issue_number, created_at)
    VALUES (@subjectType, @subjectId, @issueNumber, @now)
    ON CONFLICT(subject_type, subject_id) DO UPDATE SET
      issue_number = excluded.issue_number
  `);
  const cancelFeaturePlanStatement = db.prepare(`
    UPDATE feature_plans
    SET status = 'cancelled',
        cancelled_at = @now,
        cancel_reason = @cancelReason,
        updated_at = @now
    WHERE id = @id AND status NOT IN ('completed', 'cancelled')
  `);
  const replanFeaturePlanStatement = db.prepare(`
    UPDATE feature_plans
    SET objective = @objective,
        acceptance_criteria_json = @acceptanceCriteriaJson,
        revision = revision + 1,
        updated_at = @now
    WHERE id = @id AND status NOT IN ('completed', 'cancelled')
  `);
  const updateFeaturePlanPriorityStatement = db.prepare(`
    UPDATE feature_plans
    SET priority = @priority,
        updated_at = @now
    WHERE id = @id
  `);
  const pauseFeaturePlanStatement = db.prepare(`
    UPDATE feature_plans
    SET is_paused = 1,
        paused_at = @now,
        pause_reason = @pauseReason,
        updated_at = @now
    WHERE id = @id
  `);
  const resumeFeaturePlanStatement = db.prepare(`
    UPDATE feature_plans
    SET is_paused = 0,
        paused_at = NULL,
        pause_reason = NULL,
        updated_at = @now
    WHERE id = @id
  `);
  const updateFeaturePlanQueueStatusStatement = db.prepare(`
    UPDATE feature_plans
    SET status = @status,
        admitted_at = CASE WHEN @status = 'admitted' THEN COALESCE(admitted_at, @now) ELSE admitted_at END,
        blocked_at = CASE WHEN @status = 'blocked' THEN @now WHEN @status = 'queued' THEN NULL ELSE blocked_at END,
        blocked_reason = CASE WHEN @status = 'blocked' THEN @blockedReason WHEN @status = 'queued' THEN NULL ELSE blocked_reason END,
        completed_at = CASE WHEN @status = 'completed' THEN COALESCE(completed_at, @now) ELSE completed_at END,
        cancelled_at = CASE WHEN @status = 'cancelled' THEN COALESCE(cancelled_at, @now) ELSE cancelled_at END,
        cancel_reason = CASE WHEN @status = 'cancelled' THEN COALESCE(@blockedReason, cancel_reason) ELSE cancel_reason END,
        updated_at = @now
    WHERE id = @id
  `);
  const addFeaturePlanDependencyStatement = db.prepare(`
    INSERT INTO feature_plan_dependencies (feature_plan_id, depends_on_feature_plan_id, created_at)
    VALUES (@featurePlanId, @dependsOnFeaturePlanId, @now)
  `);
  const deleteFeaturePlanDependencyStatement = db.prepare(`
    DELETE FROM feature_plan_dependencies
    WHERE feature_plan_id = ? AND depends_on_feature_plan_id = ?
  `);
  const addFeaturePlanHistoryStatement = db.prepare(`
    INSERT INTO feature_plan_history (
      feature_plan_id, from_status, to_status, action, reason,
      actor_user_id, actor_username, metadata_json, created_at
    )
    VALUES (
      @featurePlanId, @fromStatus, @toStatus, @action, @reason,
      @actorUserId, @actorUsername, @metadataJson, @now
    )
  `);
  const deleteFeaturePlanTasksStatement = db.prepare("DELETE FROM feature_plan_tasks WHERE feature_plan_id = ?");
  const addFeaturePlanOperationStatement = db.prepare(`
    INSERT INTO feature_plan_operations (
      feature_plan_id, operation_type, idempotency_key, request_hash, created_at
    )
    VALUES (@featurePlanId, @operationType, @idempotencyKey, @requestHash, @now)
  `);
  const createFeaturePlanIntegrationStatement = db.prepare(`
    INSERT INTO feature_plan_integrations (
      feature_plan_id, project_id, plan_revision, status, checkpoint,
      branch_name, worktree_path, base_sha, head_sha, last_error,
      completed_at, created_at, updated_at
    )
    VALUES (
      @featurePlanId, @projectId, @planRevision, 'preparing', 'created',
      @branchName, @worktreePath, NULL, NULL, NULL,
      NULL, @now, @now
    )
  `);
  const updateFeaturePlanIntegrationStatement = db.prepare(`
    UPDATE feature_plan_integrations
    SET status = @status,
        checkpoint = @checkpoint,
        base_sha = @baseSha,
        head_sha = @headSha,
        last_error = @lastError,
        completed_at = @completedAt,
        updated_at = @now
    WHERE id = @id
  `);
  const addFeaturePlanIntegrationItemStatement = db.prepare(`
    INSERT INTO feature_plan_integration_items (
      integration_id, feature_plan_id, task_id, position, commit_sha,
      pull_request_url, branch_name, status, applied_commit_sha,
      last_error, created_at, updated_at
    )
    VALUES (
      @integrationId, @featurePlanId, @taskId, @position, @commitSha,
      @pullRequestUrl, @branchName, 'pending', NULL,
      NULL, @now, @now
    )
  `);
  const updateFeaturePlanIntegrationItemStatement = db.prepare(`
    UPDATE feature_plan_integration_items
    SET status = @status,
        applied_commit_sha = @appliedCommitSha,
        last_error = @lastError,
        updated_at = @now
    WHERE id = @id
  `);
  const enqueueCompletionReviewStatement = db.prepare(`
    INSERT INTO completion_review_outbox (
      subject_type, subject_id, completion_version, status,
      evidence_json, available_at, created_at, updated_at
    )
    VALUES (
      @subjectType, @subjectId, @completionVersion, 'pending',
      @evidenceJson, @now, @now, @now
    )
    ON CONFLICT(subject_type, subject_id, completion_version) DO NOTHING
  `);
  const enqueueRuntimeUpdateStatement = db.prepare(`
    INSERT INTO runtime_updates (feature_id, target_commit, previous_commit, status, error, created_at, updated_at)
    VALUES (@featureId, @targetCommit, @previousCommit, 'pending', NULL, @now, @now)
  `);
  const updateRuntimeUpdateStatement = db.prepare(`
    UPDATE runtime_updates
    SET status = @status, error = @error, updated_at = @now
    WHERE id = @id
  `);

  return {
    close: () => db.close(),

    ...skillPersistence,
    ...workGraphPersistence,
    ...providerPolicyPersistence,

    withTransaction<T>(fn: () => T): T {
      return db.transaction(fn)();
    },

    registerProject(input: ProjectInput): ProjectRecord {
      const now = new Date().toISOString();
      const project = normalizeProjectInput(input);
      upsertProjectStatement.run({ ...project, now });
      return this.getProjectByKey(project.key);
    },

    getProjectByKey(key: string): ProjectRecord {
      const row = db.prepare("SELECT * FROM projects WHERE key = ?").get(key) as ProjectRow | undefined;
      if (!row) {
        throw new Error(`Project not found: ${key}`);
      }
      return mapProject(row);
    },

    findProjectByKey(key: string): ProjectRecord | null {
      const row = db.prepare("SELECT * FROM projects WHERE key = ?").get(key) as ProjectRow | undefined;
      return row ? mapProject(row) : null;
    },

    getDefaultProject(): ProjectRecord | null {
      const row = db
        .prepare("SELECT * FROM projects ORDER BY id ASC LIMIT 1")
        .get() as ProjectRow | undefined;
      return row ? mapProject(row) : null;
    },

    listProjects(limit = 20): ProjectRecord[] {
      const rows = db
        .prepare("SELECT * FROM projects ORDER BY key ASC LIMIT ?")
        .all(limit) as ProjectRow[];
      return rows.map(mapProject);
    },

    createTask(text: string, source = "telegram", projectKey?: string | null): TaskRecord {
      const now = new Date().toISOString();
      const project = projectKey ? this.getProjectByKey(projectKey) : this.getDefaultProject();
      const result = createTaskStatement.run({ projectId: project?.id ?? null, text, source, now });
      return this.getTask(Number(result.lastInsertRowid));
    },

    getTask(id: number): TaskRecord {
      const row = db.prepare(taskSelectSql("WHERE tasks.id = ?")).get(id) as TaskRow | undefined;
      if (!row) {
        throw new Error(`Task not found: ${id}`);
      }
      return mapTask(row);
    },

    updateTaskWorktree(input: TaskWorktreeUpdate): TaskRecord {
      const now = new Date().toISOString();
      updateTaskWorktreeStatement.run({ ...input, baseBranch: input.baseBranch ?? null, now });
      return this.getTask(input.id);
    },

    updateTaskStatus(id: number, status: TaskStatus): TaskRecord {
      this.getTask(id);
      updateTaskStatusStatement.run({ id, status, now: new Date().toISOString() });
      return this.getTask(id);
    },

    deleteTask(id: number): TaskRecord {
      const task = this.getTask(id);
      if (task.worktreePath) {
        throw new Error(`Task #${id} has a prepared worktree and cannot be deleted. Cancel it instead.`);
      }
      const goalCount = db.prepare("SELECT COUNT(*) AS count FROM goal_runs WHERE task_id = ?").get(id) as { count: number };
      if (goalCount.count > 0) {
        throw new Error(`Task #${id} has execution history and cannot be deleted. Cancel it instead.`);
      }
      const featurePlanLink = db
        .prepare("SELECT feature_plan_id FROM feature_plan_tasks WHERE task_id = ? ORDER BY feature_plan_id ASC LIMIT 1")
        .get(id) as { feature_plan_id: number } | undefined;
      if (featurePlanLink) {
        throw new Error(`Task #${id} is associated with Feature Plan #${featurePlanLink.feature_plan_id} and cannot be deleted.`);
      }
      if (!["queued", "cancelled"].includes(task.status)) {
        throw new Error(`Task #${id} must be queued or cancelled before deletion.`);
      }
      db.transaction(() => {
        db.prepare("DELETE FROM task_reviews WHERE task_id = ?").run(id);
        db.prepare("DELETE FROM events WHERE task_id = ?").run(id);
        deleteTaskStatement.run(id);
      })();
      return task;
    },

    listTasks(limit = 10): TaskRecord[] {
      const rows = db
        .prepare(taskSelectSql("ORDER BY tasks.id DESC LIMIT ?"))
        .all(limit) as TaskRow[];
      return rows.map(mapTask);
    },

    listTasksByProject(projectKey: string, limit = 10): TaskRecord[] {
      const rows = db
        .prepare(taskSelectSql("WHERE projects.key = ? ORDER BY tasks.id DESC LIMIT ?"))
        .all(projectKey, limit) as TaskRow[];
      return rows.map(mapTask);
    },

    countTasksByStatus(): Record<string, number> {
      const rows = db
        .prepare("SELECT status, COUNT(*) as count FROM tasks GROUP BY status")
        .all() as Array<{ status: string; count: number }>;
      return Object.fromEntries(rows.map((row) => [row.status, row.count]));
    },

    addEvent(input: EventInput): EventRecord {
      const now = new Date().toISOString();
      const result = addEventStatement.run({
        source: input.source,
        type: input.type,
        text: input.text,
        userId: input.userId ?? null,
        username: input.username ?? null,
        taskId: input.taskId ?? null,
        now,
        metadataJson: JSON.stringify(input.metadata ?? {})
      });
      return this.getEvent(Number(result.lastInsertRowid));
    },

    getEvent(id: number): EventRecord {
      const row = db.prepare("SELECT * FROM events WHERE id = ?").get(id) as EventRow | undefined;
      if (!row) {
        throw new Error(`Event not found: ${id}`);
      }
      return mapEvent(row);
    },

    getLastEvent(): EventRecord | null {
      const row = db
        .prepare("SELECT * FROM events ORDER BY id DESC LIMIT 1")
        .get() as EventRow | undefined;
      return row ? mapEvent(row) : null;
    },

    listEvents(limit = 40): EventRecord[] {
      const rows = db
        .prepare("SELECT * FROM events ORDER BY id DESC LIMIT ?")
        .all(limit) as EventRow[];
      return rows.map(mapEvent);
    },

    listEventsAfter(id: number, limit = 100): EventRecord[] {
      const rows = db
        .prepare("SELECT * FROM events WHERE id > ? ORDER BY id ASC LIMIT ?")
        .all(id, limit) as EventRow[];
      return rows.map(mapEvent);
    },

    findLatestEventByType(type: string): EventRecord | null {
      const row = db
        .prepare("SELECT * FROM events WHERE type = ? ORDER BY id DESC LIMIT 1")
        .get(type) as EventRow | undefined;
      return row ? mapEvent(row) : null;
    },

    hasEventForSource(type: string, sourceEventId: number): boolean {
      const row = db.prepare(`
        SELECT 1 FROM events
        WHERE type = ?
          AND CAST(json_extract(metadata_json, '$.sourceEventId') AS INTEGER) = ?
        LIMIT 1
      `).get(type, sourceEventId);
      return Boolean(row);
    },

    hasFeaturePlanEvent(
      type: string,
      featurePlanId: number,
      revision: number,
      eventType?: string | null
    ): boolean {
      const row = db.prepare(`
        SELECT 1
        FROM events
        WHERE type = ?
          AND CAST(json_extract(metadata_json, '$.featurePlanId') AS INTEGER) = ?
          AND CAST(json_extract(metadata_json, '$.revision') AS INTEGER) = ?
          AND (? IS NULL OR json_extract(metadata_json, '$.eventType') = ?)
        LIMIT 1
      `).get(type, featurePlanId, revision, eventType ?? null, eventType ?? null);
      return Boolean(row);
    },

    addTaskReview(input: TaskReviewInput): TaskReviewRecord {
      const result = addTaskReviewStatement.run({
        taskId: input.taskId,
        provider: input.provider,
        status: input.status,
        content: input.content ?? "",
        error: input.error ?? null,
        now: new Date().toISOString()
      });
      return this.getTaskReview(Number(result.lastInsertRowid));
    },

    getTaskReview(id: number): TaskReviewRecord {
      const row = db.prepare("SELECT * FROM task_reviews WHERE id = ?").get(id) as TaskReviewRow | undefined;
      if (!row) {
        throw new Error(`Task review not found: ${id}`);
      }
      return mapTaskReview(row);
    },

    listTaskReviews(taskId: number, limit = 10): TaskReviewRecord[] {
      const rows = db
        .prepare("SELECT * FROM task_reviews WHERE task_id = ? ORDER BY id DESC LIMIT ?")
        .all(taskId, limit) as TaskReviewRow[];
      return rows.map(mapTaskReview);
    },

    createImprovementProposal(input: ImprovementProposalInput): ImprovementProposalRecord {
      const proposal = normalizeImprovementProposal(input);
      if (proposal.fingerprint) {
        const existing = this.findImprovementProposalByFingerprint(proposal.fingerprint);
        if (existing) return existing;
      }
      const result = addImprovementProposalStatement.run({
        ...proposal,
        evidenceJson: JSON.stringify(proposal.evidence),
        targetsJson: JSON.stringify(proposal.targets),
        provenanceJson: JSON.stringify(proposal.provenance),
        now: new Date().toISOString()
      });
      return this.getImprovementProposal(Number(result.lastInsertRowid));
    },

    findImprovementProposalByFingerprint(fingerprint: string): ImprovementProposalRecord | null {
      const row = db.prepare("SELECT * FROM improvement_proposals WHERE fingerprint = ?")
        .get(fingerprint.trim()) as ImprovementProposalRow | undefined;
      return row ? mapImprovementProposal(row) : null;
    },

    listImprovementFingerprints(): string[] {
      const rows = db.prepare("SELECT fingerprint FROM improvement_proposals WHERE fingerprint IS NOT NULL")
        .all() as Array<{ fingerprint: string }>;
      return rows.map((row) => row.fingerprint);
    },

    getImprovementProposal(id: number): ImprovementProposalRecord {
      const row = db
        .prepare("SELECT * FROM improvement_proposals WHERE id = ?")
        .get(id) as ImprovementProposalRow | undefined;
      if (!row) {
        throw new Error(`Improvement proposal not found: ${id}`);
      }
      return mapImprovementProposal(row);
    },

    listImprovementProposals(limit = 40): ImprovementProposalRecord[] {
      const rows = db
        .prepare("SELECT * FROM improvement_proposals ORDER BY id DESC LIMIT ?")
        .all(limit) as ImprovementProposalRow[];
      return rows.map(mapImprovementProposal);
    },

    countImprovementProposalsByStatus(): Record<string, number> {
      const rows = db
        .prepare("SELECT status, COUNT(*) as count FROM improvement_proposals GROUP BY status")
        .all() as Array<{ status: string; count: number }>;
      return Object.fromEntries(rows.map((row) => [row.status, row.count]));
    },

    decideImprovementProposal(
      id: number,
      status: Exclude<ImprovementStatus, "candidate">,
      decisionNote?: string | null
    ): ImprovementProposalRecord {
      this.getImprovementProposal(id);
      const result = decideImprovementProposalStatement.run({
        id,
        status,
        decisionNote: decisionNote ? redactSensitiveText(decisionNote.trim()).slice(0, 2_000) || null : null,
        now: new Date().toISOString()
      });
      if (result.changes === 0) {
        throw new Error(`Improvement proposal ${id} is no longer awaiting a decision.`);
      }
      return this.getImprovementProposal(id);
    },

    attachImprovementActivation(id: number, taskId: number, featurePlanId: number): ImprovementProposalRecord {
      this.getTask(taskId);
      this.getFeaturePlan(featurePlanId);
      const result = attachImprovementActivationStatement.run({ id, taskId, featurePlanId });
      if (result.changes !== 1) throw new Error(`Improvement proposal ${id} is not approved.`);
      return this.getImprovementProposal(id);
    },

    createGoalRun(taskId: number, maxSteps = 12): GoalRunRecord {
      this.getTask(taskId);
      const active = db
        .prepare("SELECT * FROM goal_runs WHERE task_id = ? AND status IN ('running', 'waiting_provider') ORDER BY id DESC LIMIT 1")
        .get(taskId) as GoalRunRow | undefined;
      if (active) {
        throw new Error(`Task #${taskId} already has an active goal run.`);
      }
      const now = new Date().toISOString();
      const result = createGoalRunStatement.run({ taskId, maxSteps, now });
      return this.getGoalRun(Number(result.lastInsertRowid));
    },

    getGoalRun(id: number): GoalRunRecord {
      const row = db.prepare("SELECT * FROM goal_runs WHERE id = ?").get(id) as GoalRunRow | undefined;
      if (!row) {
        throw new Error(`Goal run not found: ${id}`);
      }
      return mapGoalRun(row);
    },

    listGoalRuns(limit = 30): GoalRunRecord[] {
      const rows = db.prepare("SELECT * FROM goal_runs ORDER BY id DESC LIMIT ?").all(limit) as GoalRunRow[];
      return rows.map(mapGoalRun);
    },

    listActiveGoalRuns(): GoalRunRecord[] {
      const rows = db
        .prepare("SELECT * FROM goal_runs WHERE status IN ('running', 'waiting_provider') ORDER BY id ASC")
        .all() as GoalRunRow[];
      return rows.map(mapGoalRun);
    },

    updateGoalRun(input: {
      id: number;
      status: GoalRunStatus;
      currentPhase: GoalPhase;
      stepCount: number;
      lastError?: string | null;
      waitReason?: GoalWaitReason | null;
      nextRetryAt?: string | null;
      lastProvider?: string | null;
    }): GoalRunRecord {
      const existing = this.getGoalRun(input.id);
      const now = new Date().toISOString();
      const waiting = input.status === "waiting_provider";
      updateGoalRunStatement.run({
        ...input,
        lastError: input.lastError ?? null,
        waitReason: waiting ? input.waitReason ?? existing.waitReason : null,
        nextRetryAt: waiting ? input.nextRetryAt ?? existing.nextRetryAt : null,
        lastProvider: input.lastProvider ?? existing.lastProvider,
        now,
        finishedAt: ["running", "waiting_provider"].includes(input.status) ? null : now
      });
      return this.getGoalRun(input.id);
    },

    createGoalCheckpoint(input: GoalCheckpointInput): GoalCheckpointRecord {
      this.getGoalRun(input.runId);
      this.getGoalStep(input.stepId);
      const result = createGoalCheckpointStatement.run({
        ...input,
        summary: redactSensitiveText(input.summary).slice(0, 2_000),
        changedFilesJson: JSON.stringify(input.changedFiles),
        artifactKeysJson: JSON.stringify(input.artifactKeys),
        now: new Date().toISOString()
      });
      return this.getGoalCheckpoint(Number(result.lastInsertRowid));
    },

    getGoalCheckpoint(id: number): GoalCheckpointRecord {
      const row = db.prepare("SELECT * FROM goal_checkpoints WHERE id = ?").get(id) as GoalCheckpointRow | undefined;
      if (!row) throw new Error(`Goal checkpoint not found: ${id}`);
      return mapGoalCheckpoint(row);
    },

    listGoalCheckpoints(runId: number): GoalCheckpointRecord[] {
      const rows = db
        .prepare("SELECT * FROM goal_checkpoints WHERE run_id = ? ORDER BY id ASC")
        .all(runId) as GoalCheckpointRow[];
      return rows.map(mapGoalCheckpoint);
    },

    getLatestGoalCheckpoint(runId: number): GoalCheckpointRecord | null {
      const row = db
        .prepare("SELECT * FROM goal_checkpoints WHERE run_id = ? ORDER BY id DESC LIMIT 1")
        .get(runId) as GoalCheckpointRow | undefined;
      return row ? mapGoalCheckpoint(row) : null;
    },

    updateGoalDelivery(input: {
      id: number;
      commitSha: string;
      pullRequestUrl: string | null;
    }): GoalRunRecord {
      this.getGoalRun(input.id);
      updateGoalDeliveryStatement.run({
        ...input,
        now: new Date().toISOString()
      });
      return this.getGoalRun(input.id);
    },

    reopenGoalRun(id: number): GoalRunRecord {
      this.getGoalRun(id);
      const result = reopenGoalRunStatement.run({ id, now: new Date().toISOString() });
      if (result.changes === 0) {
        throw new Error(`Goal #${id} is not completed and cannot be reopened.`);
      }
      return this.getGoalRun(id);
    },

    createGoalStep(runId: number, phase: GoalPhase, provider: string): GoalStepRecord {
      this.getGoalRun(runId);
      const result = createGoalStepStatement.run({
        runId,
        phase,
        provider,
        now: new Date().toISOString()
      });
      return this.getGoalStep(Number(result.lastInsertRowid));
    },

    getGoalStep(id: number): GoalStepRecord {
      const row = db.prepare("SELECT * FROM goal_steps WHERE id = ?").get(id) as GoalStepRow | undefined;
      if (!row) {
        throw new Error(`Goal step not found: ${id}`);
      }
      return mapGoalStep(row);
    },

    finishGoalStep(input: {
      id: number;
      status: Exclude<GoalStepStatus, "running">;
      summary: string;
      output?: string;
      error?: string | null;
      durationMs: number;
    }): GoalStepRecord {
      this.getGoalStep(input.id);
      finishGoalStepStatement.run({
        ...input,
        output: input.output ?? "",
        error: input.error ?? null,
        now: new Date().toISOString()
      });
      return this.getGoalStep(input.id);
    },

    listGoalSteps(runId: number): GoalStepRecord[] {
      const rows = db
        .prepare("SELECT * FROM goal_steps WHERE run_id = ? ORDER BY id ASC")
        .all(runId) as GoalStepRow[];
      return rows.map(mapGoalStep);
    },

    addHumanReview(input: {
      runId: number;
      decision: HumanReviewDecision;
      note: string;
      source?: string;
    }): HumanReviewRecord {
      const run = this.getGoalRun(input.runId);
      const note = input.note.trim();
      if (!note) throw new Error("Human review justification is required.");
      if (!["approved", "changes_requested", "rejected"].includes(input.decision)) {
        throw new Error(`Unsupported human review decision: ${input.decision}`);
      }
      const result = addHumanReviewStatement.run({
        runId: run.id,
        taskId: run.taskId,
        decision: input.decision,
        note,
        source: input.source?.trim() || "dashboard",
        now: new Date().toISOString()
      });
      return this.getHumanReview(Number(result.lastInsertRowid));
    },

    getHumanReview(id: number): HumanReviewRecord {
      const row = db.prepare("SELECT * FROM human_reviews WHERE id = ?").get(id) as HumanReviewRow | undefined;
      if (!row) throw new Error(`Human review not found: ${id}`);
      return mapHumanReview(row);
    },

    listHumanReviews(runId?: number, limit = 50): HumanReviewRecord[] {
      const rows = runId === undefined
        ? db.prepare("SELECT * FROM human_reviews ORDER BY id DESC LIMIT ?").all(limit)
        : db.prepare("SELECT * FROM human_reviews WHERE run_id = ? ORDER BY id DESC LIMIT ?").all(runId, limit);
      return (rows as HumanReviewRow[]).map(mapHumanReview);
    },

    getLatestHumanReview(runId: number): HumanReviewRecord | null {
      const row = db
        .prepare("SELECT * FROM human_reviews WHERE run_id = ? ORDER BY id DESC LIMIT 1")
        .get(runId) as HumanReviewRow | undefined;
      return row ? mapHumanReview(row) : null;
    },

    createFeature(input: FeatureInput): FeatureRecord {
      const project = this.getProjectByKey(input.projectKey);
      const name = input.name.trim();
      const objective = input.objective.trim();
      const branchName = input.branchName.trim();
      const worktreePath = path.resolve(input.worktreePath.trim());
      const pullRequestUrl = input.pullRequestUrl.trim();
      const featurePlanId = input.featurePlanId ?? null;
      if (!name || !objective || !branchName || !pullRequestUrl) {
        throw new Error("Feature requires name, objective, branch, worktree and pull request.");
      }
      const existing = this.findFeatureByPullRequestUrl(pullRequestUrl);
      if (existing) return existing;
      if (featurePlanId !== null) {
        const existingForPlan = this.findFeatureByFeaturePlanId(featurePlanId);
        if (existingForPlan) return existingForPlan;
        this.getFeaturePlan(featurePlanId);
      }
      const now = new Date().toISOString();
      const result = createFeatureStatement.run({
        projectId: project.id,
        featurePlanId,
        name,
        objective,
        branchName,
        worktreePath,
        pullRequestUrl,
        now
      });
      return this.getFeature(Number(result.lastInsertRowid));
    },

    getFeature(id: number): FeatureRecord {
      const row = db.prepare(featureSelectSql("WHERE features.id = ?")).get(id) as FeatureRow | undefined;
      if (!row) throw new Error(`Feature not found: ${id}`);
      return mapFeature(row);
    },

    findFeatureByPullRequestUrl(pullRequestUrl: string): FeatureRecord | null {
      const row = db
        .prepare(featureSelectSql("WHERE features.pull_request_url = ?"))
        .get(pullRequestUrl) as FeatureRow | undefined;
      return row ? mapFeature(row) : null;
    },

    findFeatureByFeaturePlanId(featurePlanId: number): FeatureRecord | null {
      const row = db
        .prepare(featureSelectSql("WHERE features.feature_plan_id = ?"))
        .get(featurePlanId) as FeatureRow | undefined;
      return row ? mapFeature(row) : null;
    },

    findFeatureByTaskId(taskId: number): FeatureRecord | null {
      const itemRow = db
        .prepare("SELECT feature_id FROM feature_items WHERE task_id = ? ORDER BY id DESC LIMIT 1")
        .get(taskId) as { feature_id: number } | undefined;
      if (itemRow) {
        try {
          return this.getFeature(itemRow.feature_id);
        } catch {
          // ignore if feature deleted
        }
      }
      return null;
    },

    findFeatureByTarget(target: string): FeatureRecord | null {
      const trimmed = target.trim();
      if (!trimmed) return null;

      if (trimmed.startsWith("http://") || trimmed.startsWith("https://") || trimmed.includes("github.com")) {
        return this.findFeatureByPullRequestUrl(trimmed);
      }

      const id = parseInt(trimmed, 10);
      if (Number.isNaN(id)) {
        return this.findFeatureByPullRequestUrl(trimmed);
      }

      try {
        const feature = this.getFeature(id);
        if (feature) return feature;
      } catch {
        // Not found by feature ID directly
      }

      const byTask = this.findFeatureByTaskId(id);
      if (byTask) return byTask;

      const plan = this.findFeaturePlanDetailsByTask(id);
      if (plan) {
        const feature = this.findFeatureByFeaturePlanId(plan.plan.id);
        if (feature) return feature;
      }

      return null;
    },

    listFeatures(limit = 30): FeatureRecord[] {
      const rows = db
        .prepare(featureSelectSql("ORDER BY features.id DESC LIMIT ?"))
        .all(limit) as FeatureRow[];
      return rows.map(mapFeature);
    },

    updateFeature(input: {
      id: number;
      status: FeatureStatus;
      reviewerProvider?: string | null;
      reviewSummary?: string | null;
      reviewedHeadSha?: string | null;
      lastError?: string | null;
      mergedAt?: string | null;
    }): FeatureRecord {
      const feature = this.getFeature(input.id);
      updateFeatureStatement.run({
        id: feature.id,
        status: input.status,
        reviewerProvider: input.reviewerProvider === undefined ? feature.reviewerProvider : input.reviewerProvider,
        reviewSummary: input.reviewSummary === undefined ? feature.reviewSummary : input.reviewSummary,
        reviewedHeadSha: input.reviewedHeadSha === undefined ? feature.reviewedHeadSha : input.reviewedHeadSha,
        lastError: input.lastError === undefined ? feature.lastError : input.lastError,
        mergedAt: input.mergedAt === undefined ? feature.mergedAt : input.mergedAt,
        now: new Date().toISOString()
      });
      return this.getFeature(feature.id);
    },

    enqueueFeatureCompletionReview(featureId: number): CompletionReviewRecord {
      const feature = this.getFeature(featureId);
      const now = new Date().toISOString();
      const evidence = buildFeatureCompletionEvidencePack(feature, now);
      enqueueCompletionReviewStatement.run({
        subjectType: evidence.subject.type,
        subjectId: evidence.subject.id,
        completionVersion: evidence.subject.completionVersion,
        evidenceJson: JSON.stringify(evidence),
        now
      });
      return this.findCompletionReview(
        evidence.subject.type,
        evidence.subject.id,
        evidence.subject.completionVersion
      )!;
    },

    findCompletionReview(
      subjectType: CompletionReviewSubjectType,
      subjectId: string,
      completionVersion: string
    ): CompletionReviewRecord | null {
      const row = db.prepare(`
        SELECT * FROM completion_review_outbox
        WHERE subject_type = ? AND subject_id = ? AND completion_version = ?
      `).get(subjectType, subjectId, completionVersion) as CompletionReviewRow | undefined;
      return row ? mapCompletionReview(row) : null;
    },

    getCompletionReview(id: number): CompletionReviewRecord {
      const row = db.prepare("SELECT * FROM completion_review_outbox WHERE id = ?")
        .get(id) as CompletionReviewRow | undefined;
      if (!row) throw new Error(`Completion review not found: ${id}`);
      return mapCompletionReview(row);
    },

    listCompletionReviews(limit = 100): CompletionReviewRecord[] {
      const rows = db.prepare("SELECT * FROM completion_review_outbox ORDER BY id ASC LIMIT ?")
        .all(limit) as CompletionReviewRow[];
      return rows.map(mapCompletionReview);
    },

    claimCompletionReview(input: CompletionReviewClaimInput): CompletionReviewRecord | null {
      const workerId = input.workerId.trim();
      if (!workerId) throw new Error("Completion review worker id is required.");
      if (!Number.isInteger(input.leaseMs) || input.leaseMs < 1_000) {
        throw new Error("Completion review lease must be at least 1000ms.");
      }
      const referenceTime = input.now ?? new Date();
      const now = referenceTime.toISOString();
      const leaseExpiresAt = new Date(referenceTime.getTime() + input.leaseMs).toISOString();
      return db.transaction(() => {
        const candidate = db.prepare(`
          SELECT id FROM completion_review_outbox
          WHERE (status = 'pending' AND available_at <= @now)
             OR (status = 'running' AND lease_expires_at <= @now)
          ORDER BY available_at ASC, id ASC
          LIMIT 1
        `).get({ now }) as { id: number } | undefined;
        if (!candidate) return null;
        const result = db.prepare(`
          UPDATE completion_review_outbox
          SET status = 'running',
              attempt_count = attempt_count + 1,
              lease_owner = @workerId,
              lease_expires_at = @leaseExpiresAt,
              updated_at = @now,
              started_at = COALESCE(started_at, @now),
              finished_at = NULL
          WHERE id = @id
            AND ((status = 'pending' AND available_at <= @now)
              OR (status = 'running' AND lease_expires_at <= @now))
        `).run({ id: candidate.id, workerId, leaseExpiresAt, now });
        return result.changes === 1 ? this.getCompletionReview(candidate.id) : null;
      })();
    },

    finishCompletionReview(
      id: number,
      workerId: string,
      status: CompletionReviewFinishStatus,
      error?: string | null
    ): CompletionReviewRecord {
      const now = new Date().toISOString();
      const result = db.prepare(`
        UPDATE completion_review_outbox
        SET status = @status,
            lease_owner = NULL,
            lease_expires_at = NULL,
            last_error = @lastError,
            updated_at = @now,
            finished_at = CASE WHEN @status IN ('succeeded', 'failed') THEN @now ELSE NULL END
        WHERE id = @id AND status = 'running' AND lease_owner = @workerId
          AND lease_expires_at > @now
      `).run({
        id,
        workerId: workerId.trim(),
        status,
        lastError: error ? redactSensitiveText(error.trim()).slice(0, 2_000) || null : null,
        now
      });
      if (result.changes !== 1) throw new Error(`Completion review #${id} is not claimed by worker ${workerId}.`);
      return this.getCompletionReview(id);
    },

    retryCompletionReview(id: number, availableAt = new Date().toISOString()): CompletionReviewRecord {
      const result = db.prepare(`
        UPDATE completion_review_outbox
        SET status = 'pending', available_at = @availableAt,
            lease_owner = NULL, lease_expires_at = NULL,
            updated_at = @now, finished_at = NULL
        WHERE id = @id AND status IN ('waiting_provider', 'failed')
      `).run({ id, availableAt, now: new Date().toISOString() });
      if (result.changes !== 1) throw new Error(`Completion review #${id} is not retryable.`);
      return this.getCompletionReview(id);
    },

    cancelFeature(id: number, reason?: string | null): FeatureRecord {
      const feature = this.getFeature(id);
      if (feature.status === "cancelled") return feature;
      if (["completed", "merging"].includes(feature.status)) {
        throw new Error(`Feature #${id} cannot be cancelled from status ${feature.status}.`);
      }
      const result = cancelFeatureStatement.run({
        id,
        cancelReason: reason?.trim() || null,
        now: new Date().toISOString()
      });
      if (result.changes === 0) {
        throw new Error(`Feature #${id} cannot be cancelled from status ${feature.status}.`);
      }
      return this.getFeature(id);
    },

    addFeatureItem(input: {
      featureId: number;
      taskId: number;
      pullRequestUrl: string;
      branchName: string;
    }): FeatureItemRecord {
      this.getFeature(input.featureId);
      this.getTask(input.taskId);
      const existing = db.prepare(
        "SELECT * FROM feature_items WHERE feature_id = ? AND task_id = ?"
      ).get(input.featureId, input.taskId) as FeatureItemRow | undefined;
      if (existing) return mapFeatureItem(existing);
      const now = new Date().toISOString();
      const result = addFeatureItemStatement.run({ ...input, now });
      return this.getFeatureItem(Number(result.lastInsertRowid));
    },

    getFeatureItem(id: number): FeatureItemRecord {
      const row = db.prepare("SELECT * FROM feature_items WHERE id = ?").get(id) as FeatureItemRow | undefined;
      if (!row) throw new Error(`Feature item not found: ${id}`);
      return mapFeatureItem(row);
    },

    listFeatureItems(featureId: number): FeatureItemRecord[] {
      const rows = db
        .prepare("SELECT * FROM feature_items WHERE feature_id = ? ORDER BY id ASC")
        .all(featureId) as FeatureItemRow[];
      return rows.map(mapFeatureItem);
    },

    updateFeatureItemStatus(id: number, status: FeatureItemStatus): FeatureItemRecord {
      this.getFeatureItem(id);
      updateFeatureItemStatusStatement.run({ id, status, now: new Date().toISOString() });
      return this.getFeatureItem(id);
    },

    createFeaturePlan(input: FeaturePlanInput): FeaturePlanWriteResult {
      const normalized = normalizeFeaturePlanInput(input);
      const project = this.getProjectByKey(normalized.projectKey);
      validateFeaturePlanTasks(project.id, normalized.taskIds, (id) => this.getTask(id));
      const taskContracts = normalizeFeatureTaskContracts(
        normalized.taskIds,
        normalized.taskContracts,
        (taskId) => this.getTask(taskId).text
      );
      const requestHash = hashFeaturePlanOperation("create", {
        projectId: project.id,
        objective: normalized.objective,
        acceptanceCriteria: normalized.acceptanceCriteria,
        taskIds: normalized.taskIds,
        taskContracts: [...taskContracts.entries()],
        priority: normalized.priority,
        dependsOnFeaturePlanIds: normalized.dependsOnFeaturePlanIds,
        featureIssueNumber: normalized.featureIssueNumber,
        taskIssueNumbers: normalized.taskIssueNumbers
      });
      const existingOperation = normalized.idempotencyKey
        ? findFeaturePlanOperation(db, normalized.idempotencyKey)
        : null;
      if (existingOperation) {
        validateFeaturePlanOperationReuse(existingOperation, "create", requestHash);
        return { ...this.getFeaturePlanDetails(existingOperation.feature_plan_id), applied: false };
      }
      validateFeaturePlanTaskAvailability(db, normalized.taskIds);

      const now = new Date().toISOString();
      const planId = db.transaction(() => {
        const result = createFeaturePlanStatement.run({
          projectId: project.id,
          objective: normalized.objective,
          acceptanceCriteriaJson: JSON.stringify(normalized.acceptanceCriteria),
          priority: normalized.priority,
          source: normalized.source,
          createdByUserId: normalized.createdByUserId,
          createdByUsername: normalized.createdByUsername,
          now
        });
        const featurePlanId = Number(result.lastInsertRowid);
        insertFeaturePlanTasks(
          addFeaturePlanTaskStatement,
          featurePlanId,
          normalized.taskIds,
          taskContracts,
          now
        );
        for (const depId of normalized.dependsOnFeaturePlanIds) {
          if (depId === featurePlanId) {
            throw new Error(`Self-dependencies are not allowed: Feature Plan #${featurePlanId} cannot depend on itself.`);
          }
          const depPlan = this.getFeaturePlan(depId);
          if (depPlan.projectId !== project.id) {
            throw new Error(
              `Cross-project dependencies are not allowed: Feature Plan #${featurePlanId} and #${depId} belong to different projects.`
            );
          }
          checkDependencyCycle(db, featurePlanId, depId);
          addFeaturePlanDependencyStatement.run({ featurePlanId, dependsOnFeaturePlanId: depId, now });
        }
        addFeaturePlanHistoryStatement.run({
          featurePlanId,
          fromStatus: null,
          toStatus: "queued",
          action: "create",
          reason: null,
          actorUserId: normalized.createdByUserId,
          actorUsername: normalized.createdByUsername,
          metadataJson: JSON.stringify({ priority: normalized.priority }),
          now
        });
        if (normalized.featureIssueNumber !== null) {
          addGitHubIssueLinkStatement.run({
            subjectType: "feature_plan",
            subjectId: featurePlanId,
            issueNumber: normalized.featureIssueNumber,
            now
          });
        }
        for (const [taskId, issueNumber] of Object.entries(normalized.taskIssueNumbers)) {
          addGitHubIssueLinkStatement.run({
            subjectType: "task",
            subjectId: Number(taskId),
            issueNumber,
            now
          });
        }
        if (normalized.idempotencyKey) {
          addFeaturePlanOperationStatement.run({
            featurePlanId,
            operationType: "create",
            idempotencyKey: normalized.idempotencyKey,
            requestHash,
            now
          });
        }
        return featurePlanId;
      })();

      return { ...this.getFeaturePlanDetails(planId), applied: true };
    },

    pauseFeaturePlan(id: number, reason?: string | null, actorUserId?: string | null, actorUsername?: string | null): FeaturePlanDetails {
      const plan = this.getFeaturePlan(id);
      if (plan.isPaused) return this.getFeaturePlanDetails(id);
      if (["completed", "cancelled"].includes(plan.status)) {
        throw new Error(`Feature plan #${id} is ${plan.status} and cannot be paused.`);
      }
      const now = new Date().toISOString();
      db.transaction(() => {
        pauseFeaturePlanStatement.run({ id, pauseReason: reason?.trim() || null, now });
        addFeaturePlanHistoryStatement.run({
          featurePlanId: id,
          fromStatus: plan.status,
          toStatus: plan.status,
          action: "pause",
          reason: reason?.trim() || null,
          actorUserId: actorUserId || null,
          actorUsername: actorUsername || null,
          metadataJson: "{}",
          now
        });
      })();
      return this.getFeaturePlanDetails(id);
    },

    resumeFeaturePlan(id: number, actorUserId?: string | null, actorUsername?: string | null): FeaturePlanDetails {
      const plan = this.getFeaturePlan(id);
      if (!plan.isPaused) return this.getFeaturePlanDetails(id);
      const now = new Date().toISOString();
      db.transaction(() => {
        resumeFeaturePlanStatement.run({ id, now });
        addFeaturePlanHistoryStatement.run({
          featurePlanId: id,
          fromStatus: plan.status,
          toStatus: plan.status,
          action: "resume",
          reason: null,
          actorUserId: actorUserId || null,
          actorUsername: actorUsername || null,
          metadataJson: "{}",
          now
        });
      })();
      return this.getFeaturePlanDetails(id);
    },

    updateFeaturePlanPriority(id: number, priority: number, actorUserId?: string | null, actorUsername?: string | null): FeaturePlanDetails {
      const plan = this.getFeaturePlan(id);
      if (!Number.isInteger(priority)) throw new Error("Feature plan priority must be an integer.");
      if (plan.priority === priority) return this.getFeaturePlanDetails(id);
      const now = new Date().toISOString();
      db.transaction(() => {
        updateFeaturePlanPriorityStatement.run({ id, priority, now });
        addFeaturePlanHistoryStatement.run({
          featurePlanId: id,
          fromStatus: plan.status,
          toStatus: plan.status,
          action: "set_priority",
          reason: null,
          actorUserId: actorUserId || null,
          actorUsername: actorUsername || null,
          metadataJson: JSON.stringify({ previousPriority: plan.priority, priority }),
          now
        });
      })();
      return this.getFeaturePlanDetails(id);
    },

    addFeaturePlanDependency(featurePlanId: number, dependsOnFeaturePlanId: number, actorUserId?: string | null, actorUsername?: string | null): FeaturePlanDetails {
      if (featurePlanId === dependsOnFeaturePlanId) {
        throw new Error(`Self-dependencies are not allowed: Feature Plan #${featurePlanId} cannot depend on itself.`);
      }
      const plan = this.getFeaturePlan(featurePlanId);
      const depPlan = this.getFeaturePlan(dependsOnFeaturePlanId);
      if (plan.projectId !== depPlan.projectId) {
        throw new Error(
          `Cross-project dependencies are not allowed: Feature Plan #${featurePlanId} and #${dependsOnFeaturePlanId} belong to different projects.`
        );
      }
      checkDependencyCycle(db, featurePlanId, dependsOnFeaturePlanId);

      const now = new Date().toISOString();
      db.transaction(() => {
        addFeaturePlanDependencyStatement.run({ featurePlanId, dependsOnFeaturePlanId, now });
        addFeaturePlanHistoryStatement.run({
          featurePlanId,
          fromStatus: plan.status,
          toStatus: plan.status,
          action: "add_dependency",
          reason: null,
          actorUserId: actorUserId || null,
          actorUsername: actorUsername || null,
          metadataJson: JSON.stringify({ dependsOnFeaturePlanId }),
          now
        });
      })();
      return this.getFeaturePlanDetails(featurePlanId);
    },

    removeFeaturePlanDependency(featurePlanId: number, dependsOnFeaturePlanId: number, actorUserId?: string | null, actorUsername?: string | null): FeaturePlanDetails {
      const plan = this.getFeaturePlan(featurePlanId);
      const now = new Date().toISOString();
      db.transaction(() => {
        deleteFeaturePlanDependencyStatement.run(featurePlanId, dependsOnFeaturePlanId);
        addFeaturePlanHistoryStatement.run({
          featurePlanId,
          fromStatus: plan.status,
          toStatus: plan.status,
          action: "remove_dependency",
          reason: null,
          actorUserId: actorUserId || null,
          actorUsername: actorUsername || null,
          metadataJson: JSON.stringify({ dependsOnFeaturePlanId }),
          now
        });
      })();
      return this.getFeaturePlanDetails(featurePlanId);
    },

    listFeaturePlanDependencies(featurePlanId: number): FeaturePlanDependencyRecord[] {
      const rows = db.prepare("SELECT * FROM feature_plan_dependencies WHERE feature_plan_id = ? ORDER BY id ASC")
        .all(featurePlanId) as FeaturePlanDependencyRow[];
      return rows.map(mapFeaturePlanDependency);
    },

    updateFeaturePlanQueueStatus(id: number, toStatus: FeaturePlanQueueStatus, reason?: string | null, actorUserId?: string | null, actorUsername?: string | null): FeaturePlanDetails {
      const plan = this.getFeaturePlan(id);
      if (plan.status === toStatus) return this.getFeaturePlanDetails(id);

      const validTransitions: Record<string, string[]> = {
        queued: ["admitted", "blocked", "cancelled"],
        admitted: ["active", "blocked", "cancelled"],
        active: ["waiting_review", "blocked", "cancelled"],
        waiting_review: ["waiting_merge", "blocked", "cancelled"],
        waiting_merge: ["completed", "blocked", "cancelled"],
        blocked: ["queued", "cancelled"],
        completed: [],
        cancelled: []
      };

      const allowed = validTransitions[plan.status] || [];
      if (!allowed.includes(toStatus)) {
        throw new Error(`Invalid Feature Plan status transition from '${plan.status}' to '${toStatus}'.`);
      }

      const now = new Date().toISOString();
      db.transaction(() => {
        updateFeaturePlanQueueStatusStatement.run({
          id,
          status: toStatus,
          blockedReason: reason?.trim() || null,
          now
        });
        addFeaturePlanHistoryStatement.run({
          featurePlanId: id,
          fromStatus: plan.status,
          toStatus,
          action: "status_changed",
          reason: reason?.trim() || null,
          actorUserId: actorUserId || null,
          actorUsername: actorUsername || null,
          metadataJson: "{}",
          now
        });
      })();
      return this.getFeaturePlanDetails(id);
    },

    admitFeaturePlan(id: number, actorUserId?: string | null, actorUsername?: string | null): FeaturePlanDetails {
      const eligibility = this.evaluateFeaturePlanEligibility(id);
      if (!eligibility.eligible) {
        throw new Error(`Cannot admit Feature Plan #${id}: ${eligibility.reason}`);
      }
      return this.updateFeaturePlanQueueStatus(id, "admitted", "Admitted to project writer lease", actorUserId, actorUsername);
    },

    getFeaturePlanHistory(featurePlanId: number): FeaturePlanHistoryRecord[] {
      const rows = db.prepare("SELECT * FROM feature_plan_history WHERE feature_plan_id = ? ORDER BY id ASC")
        .all(featurePlanId) as FeaturePlanHistoryRow[];
      return rows.map(mapFeaturePlanHistory);
    },

    evaluateFeaturePlanEligibility(featurePlanId: number): FeaturePlanEligibilityResult {
      const plan = this.getFeaturePlan(featurePlanId);
      if (plan.status !== "queued") {
        return {
          featurePlanId,
          projectKey: plan.projectKey,
          eligible: false,
          reason: `Feature Plan is in status '${plan.status}', expected 'queued'`,
          blockedByPaused: false,
          blockedByStatus: true,
          blockedDependencies: [],
          blockedByActiveProjectPlan: null
        };
      }

      if (plan.isPaused) {
        return {
          featurePlanId,
          projectKey: plan.projectKey,
          eligible: false,
          reason: plan.pauseReason ? `Feature Plan is paused: ${plan.pauseReason}` : "Feature Plan is paused",
          blockedByPaused: true,
          blockedByStatus: false,
          blockedDependencies: [],
          blockedByActiveProjectPlan: null
        };
      }

      const deps = this.listFeaturePlanDependencies(featurePlanId);
      const blockedDependencies: Array<{ id: number; status: FeaturePlanQueueStatus }> = [];
      for (const dep of deps) {
        const depPlan = this.getFeaturePlan(dep.dependsOnFeaturePlanId);
        if (depPlan.status !== "completed") {
          blockedDependencies.push({ id: depPlan.id, status: depPlan.status });
        }
      }
      if (blockedDependencies.length > 0) {
        return {
          featurePlanId,
          projectKey: plan.projectKey,
          eligible: false,
          reason: `Waiting on predecessor Feature Plan #${blockedDependencies[0].id} (status: ${blockedDependencies[0].status})`,
          blockedByPaused: false,
          blockedByStatus: false,
          blockedDependencies,
          blockedByActiveProjectPlan: null
        };
      }

      const activeProjectRow = db.prepare(`
        SELECT id, status FROM feature_plans
        WHERE project_id = ? AND id <> ? AND status IN ('admitted', 'active', 'waiting_review', 'waiting_merge')
        LIMIT 1
      `).get(plan.projectId, plan.id) as { id: number; status: FeaturePlanQueueStatus } | undefined;

      if (activeProjectRow) {
        return {
          featurePlanId,
          projectKey: plan.projectKey,
          eligible: false,
          reason: `Project '${plan.projectKey}' already has an active Feature Plan #${activeProjectRow.id} (status: ${activeProjectRow.status})`,
          blockedByPaused: false,
          blockedByStatus: false,
          blockedDependencies: [],
          blockedByActiveProjectPlan: { id: activeProjectRow.id, status: activeProjectRow.status }
        };
      }

      return {
        featurePlanId,
        projectKey: plan.projectKey,
        eligible: true,
        reason: "Eligible for admission",
        blockedByPaused: false,
        blockedByStatus: false,
        blockedDependencies: [],
        blockedByActiveProjectPlan: null
      };
    },

    listFeaturePlanQueue(projectKey?: string): FeaturePlanDetails[] {
      const suffix = projectKey?.trim()
        ? `WHERE projects.key = ? AND feature_plans.status IN ('queued', 'admitted', 'active', 'waiting_review', 'waiting_merge', 'blocked') ORDER BY feature_plans.is_paused ASC, feature_plans.priority DESC, feature_plans.created_at ASC, feature_plans.id ASC`
        : `WHERE feature_plans.status IN ('queued', 'admitted', 'active', 'waiting_review', 'waiting_merge', 'blocked') ORDER BY feature_plans.is_paused ASC, feature_plans.priority DESC, feature_plans.created_at ASC, feature_plans.id ASC`;
      const rows = projectKey?.trim()
        ? (db.prepare(featurePlanSelectSql(suffix)).all(projectKey.trim().toLowerCase()) as FeaturePlanRow[])
        : (db.prepare(featurePlanSelectSql(suffix)).all() as FeaturePlanRow[]);
      return rows.map((row) => this.getFeaturePlanDetails(row.id));
    },

    getFeaturePlan(id: number): FeaturePlanRecord {
      const row = db.prepare(featurePlanSelectSql("WHERE feature_plans.id = ?")).get(id) as FeaturePlanRow | undefined;
      if (!row) throw new Error(`Feature plan not found: ${id}`);
      return mapFeaturePlan(row);
    },

    getFeaturePlanDetails(id: number): FeaturePlanDetails {
      const plan = this.getFeaturePlan(id);
      return { plan, tasks: this.listFeaturePlanTasks(plan.id) };
    },

    listFeaturePlans(limit = 30): FeaturePlanRecord[] {
      const rows = db
        .prepare(featurePlanSelectSql("ORDER BY feature_plans.id DESC LIMIT ?"))
        .all(limit) as FeaturePlanRow[];
      return rows.map(mapFeaturePlan);
    },

    listFeaturePlansByProject(projectKey: string, limit = 30): FeaturePlanRecord[] {
      const rows = db
        .prepare(featurePlanSelectSql("WHERE projects.key = ? ORDER BY feature_plans.id DESC LIMIT ?"))
        .all(projectKey, limit) as FeaturePlanRow[];
      return rows.map(mapFeaturePlan);
    },

    listFeaturePlanTasks(featurePlanId: number): FeaturePlanTaskRecord[] {
      const rows = db
        .prepare(featurePlanTasksSelectSql("WHERE feature_plan_tasks.feature_plan_id = ? ORDER BY feature_plan_tasks.position ASC"))
        .all(featurePlanId) as FeaturePlanTaskRow[];
      return rows.map((row, index) => mapFeaturePlanTask(row, parseFeatureTaskContract(
        row.contract_json,
        row,
        rows[index - 1]?.task_id
      )));
    },

    findFeaturePlanDetailsByTask(taskId: number): FeaturePlanDetails | null {
      const row = db.prepare(`
        SELECT feature_plan_tasks.feature_plan_id
        FROM feature_plan_tasks
        JOIN feature_plans ON feature_plans.id = feature_plan_tasks.feature_plan_id
        WHERE feature_plan_tasks.task_id = ? AND feature_plans.status NOT IN ('completed', 'cancelled')
        ORDER BY feature_plan_tasks.id DESC
        LIMIT 1
      `).get(taskId) as { feature_plan_id: number } | undefined;
      return row ? this.getFeaturePlanDetails(row.feature_plan_id) : null;
    },

    getFeaturePlanIssueLinks(featurePlanId: number): FeaturePlanIssueLinks {
      const plan = this.getFeaturePlan(featurePlanId);
      const tasks = this.listFeaturePlanTasks(plan.id);
      const featureLink = db.prepare(`
        SELECT issue_number FROM github_issue_links
        WHERE subject_type = 'feature_plan' AND subject_id = ?
      `).get(plan.id) as { issue_number: number } | undefined;
      const taskIssueNumbers: Record<number, number> = {};
      const statement = db.prepare(`
        SELECT issue_number FROM github_issue_links
        WHERE subject_type = 'task' AND subject_id = ?
      `);
      for (const task of tasks) {
        const row = statement.get(task.taskId) as { issue_number: number } | undefined;
        if (row) taskIssueNumbers[task.taskId] = row.issue_number;
      }
      return {
        featureIssueNumber: featureLink?.issue_number ?? null,
        taskIssueNumbers
      };
    },

    countFeaturePlansByStatus(): Record<string, number> {
      const rows = db
        .prepare("SELECT status, COUNT(*) as count FROM feature_plans GROUP BY status")
        .all() as Array<{ status: string; count: number }>;
      return Object.fromEntries(rows.map((row) => [row.status, row.count]));
    },

    cancelFeaturePlan(id: number, reason?: string | null): FeaturePlanWriteResult {
      const plan = this.getFeaturePlan(id);
      if (plan.status === "cancelled") {
        return { ...this.getFeaturePlanDetails(id), applied: false };
      }
      if (plan.status === "completed") {
        throw new Error(`Feature plan #${id} cannot be cancelled from status completed.`);
      }
      assertFeaturePlanIntegrationNotStarted(db, id);
      const now = new Date().toISOString();
      const result = db.transaction(() => {
        const res = cancelFeaturePlanStatement.run({
          id,
          cancelReason: reason?.trim() || null,
          now
        });
        if (res.changes > 0) {
          addFeaturePlanHistoryStatement.run({
            featurePlanId: id,
            fromStatus: plan.status,
            toStatus: "cancelled",
            action: "cancel",
            reason: reason?.trim() || null,
            actorUserId: null,
            actorUsername: null,
            metadataJson: "{}",
            now
          });
        }
        return res;
      })();
      if (result.changes === 0) {
        throw new Error(`Feature plan #${id} cannot be cancelled from status ${plan.status}.`);
      }
      return { ...this.getFeaturePlanDetails(id), applied: true };
    },

    replanFeaturePlan(input: FeaturePlanReplanInput): FeaturePlanWriteResult {
      const plan = this.getFeaturePlan(input.id);
      const normalized = normalizeFeaturePlanInput({
        projectKey: plan.projectKey,
        objective: input.objective,
        acceptanceCriteria: input.acceptanceCriteria,
        taskIds: input.taskIds,
        taskContracts: input.taskContracts,
        idempotencyKey: input.idempotencyKey
      });
      const taskContracts = normalizeFeatureTaskContracts(
        normalized.taskIds,
        normalized.taskContracts,
        (taskId) => this.getTask(taskId).text
      );
      const requestHash = hashFeaturePlanOperation("replan", {
        featurePlanId: plan.id,
        objective: normalized.objective,
        acceptanceCriteria: normalized.acceptanceCriteria,
        taskIds: normalized.taskIds,
        taskContracts: [...taskContracts.entries()]
      });
      const existingOperation = normalized.idempotencyKey
        ? findFeaturePlanOperation(db, normalized.idempotencyKey)
        : null;
      if (existingOperation) {
        validateFeaturePlanOperationReuse(existingOperation, "replan", requestHash, plan.id);
        return { ...this.getFeaturePlanDetails(existingOperation.feature_plan_id), applied: false };
      }
      if (["completed", "cancelled"].includes(plan.status)) {
        throw new Error(`Feature plan #${plan.id} cannot be replanned from status ${plan.status}.`);
      }
      assertFeaturePlanIntegrationNotStarted(db, plan.id);
      validateFeaturePlanTasks(plan.projectId, normalized.taskIds, (id) => this.getTask(id));
      validateFeaturePlanTaskAvailability(db, normalized.taskIds, plan.id);

      const now = new Date().toISOString();
      db.transaction(() => {
        const result = replanFeaturePlanStatement.run({
          id: plan.id,
          objective: normalized.objective,
          acceptanceCriteriaJson: JSON.stringify(normalized.acceptanceCriteria),
          now
        });
        if (result.changes === 0) {
          throw new Error(`Feature plan #${plan.id} cannot be replanned from status ${plan.status}.`);
        }
        deleteFeaturePlanTasksStatement.run(plan.id);
        insertFeaturePlanTasks(
          addFeaturePlanTaskStatement,
          plan.id,
          normalized.taskIds,
          taskContracts,
          now
        );
        addFeaturePlanHistoryStatement.run({
          featurePlanId: plan.id,
          fromStatus: plan.status,
          toStatus: plan.status,
          action: "replan",
          reason: null,
          actorUserId: null,
          actorUsername: null,
          metadataJson: JSON.stringify({ revision: plan.revision + 1 }),
          now
        });
        if (normalized.idempotencyKey) {
          addFeaturePlanOperationStatement.run({
            featurePlanId: plan.id,
            operationType: "replan",
            idempotencyKey: normalized.idempotencyKey,
            requestHash,
            now
          });
        }
      })();

      return { ...this.getFeaturePlanDetails(plan.id), applied: true };
    },

    createFeaturePlanIntegration(input: FeaturePlanIntegrationInput): FeaturePlanIntegrationRecord {
      const plan = this.getFeaturePlan(input.featurePlanId);
      if (plan.projectId !== input.projectId) {
        throw new Error(`Feature Plan #${input.featurePlanId} does not belong to project #${input.projectId}.`);
      }
      const existing = this.findFeaturePlanIntegrationByFeaturePlan(input.featurePlanId);
      if (existing) {
        if (
          existing.projectId !== input.projectId
          || existing.planRevision !== input.planRevision
          || existing.branchName !== input.branchName.trim()
          || existing.worktreePath !== path.resolve(input.worktreePath.trim())
        ) {
          throw new Error(`Feature Plan #${input.featurePlanId} already has a different integration checkpoint.`);
        }
        return existing;
      }
      const branchName = input.branchName.trim();
      const worktreePathInput = input.worktreePath.trim();
      if (!branchName || !worktreePathInput) {
        throw new Error("Feature Plan integration requires branch and worktree path.");
      }
      const worktreePath = path.resolve(worktreePathInput);
      const now = new Date().toISOString();
      const result = createFeaturePlanIntegrationStatement.run({
        featurePlanId: input.featurePlanId,
        projectId: input.projectId,
        planRevision: input.planRevision,
        branchName,
        worktreePath,
        now
      });
      return this.getFeaturePlanIntegration(Number(result.lastInsertRowid));
    },

    getFeaturePlanIntegration(id: number): FeaturePlanIntegrationRecord {
      const row = db
        .prepare(featurePlanIntegrationSelectSql("WHERE feature_plan_integrations.id = ?"))
        .get(id) as FeaturePlanIntegrationRow | undefined;
      if (!row) throw new Error(`Feature Plan integration not found: ${id}`);
      return mapFeaturePlanIntegration(row);
    },

    findFeaturePlanIntegrationByFeaturePlan(featurePlanId: number): FeaturePlanIntegrationRecord | null {
      const row = db
        .prepare(featurePlanIntegrationSelectSql("WHERE feature_plan_integrations.feature_plan_id = ?"))
        .get(featurePlanId) as FeaturePlanIntegrationRow | undefined;
      return row ? mapFeaturePlanIntegration(row) : null;
    },

    getFeaturePlanIntegrationDetails(id: number): FeaturePlanIntegrationDetails {
      const integration = this.getFeaturePlanIntegration(id);
      return { integration, items: this.listFeaturePlanIntegrationItems(integration.id) };
    },

    getFeaturePlanIntegrationDetailsByFeaturePlan(featurePlanId: number): FeaturePlanIntegrationDetails | null {
      const integration = this.findFeaturePlanIntegrationByFeaturePlan(featurePlanId);
      return integration ? { integration, items: this.listFeaturePlanIntegrationItems(integration.id) } : null;
    },

    listFeaturePlanIntegrationItems(integrationId: number): FeaturePlanIntegrationItemRecord[] {
      const rows = db
        .prepare(featurePlanIntegrationItemsSelectSql(
          "WHERE feature_plan_integration_items.integration_id = ? ORDER BY feature_plan_integration_items.position ASC"
        ))
        .all(integrationId) as FeaturePlanIntegrationItemRow[];
      return rows.map(mapFeaturePlanIntegrationItem);
    },

    ensureFeaturePlanIntegrationItem(input: FeaturePlanIntegrationItemInput): FeaturePlanIntegrationItemRecord {
      this.getFeaturePlanIntegration(input.integrationId);
      this.getTask(input.taskId);
      const normalized = normalizeFeaturePlanIntegrationItemInput(input);
      const existing = db
        .prepare("SELECT * FROM feature_plan_integration_items WHERE integration_id = ? AND task_id = ?")
        .get(normalized.integrationId, normalized.taskId) as FeaturePlanIntegrationItemBaseRow | undefined;
      if (existing) {
        if (
          existing.feature_plan_id !== normalized.featurePlanId
          || existing.position !== normalized.position
          || existing.commit_sha !== normalized.commitSha
          || existing.pull_request_url !== normalized.pullRequestUrl
          || existing.branch_name !== normalized.branchName
        ) {
          throw new Error(`Task #${normalized.taskId} already has a different integration item checkpoint.`);
        }
        return this.getFeaturePlanIntegrationItem(existing.id);
      }
      const result = addFeaturePlanIntegrationItemStatement.run({
        ...normalized,
        now: new Date().toISOString()
      });
      return this.getFeaturePlanIntegrationItem(Number(result.lastInsertRowid));
    },

    getFeaturePlanIntegrationItem(id: number): FeaturePlanIntegrationItemRecord {
      const row = db
        .prepare(featurePlanIntegrationItemsSelectSql("WHERE feature_plan_integration_items.id = ?"))
        .get(id) as FeaturePlanIntegrationItemRow | undefined;
      if (!row) throw new Error(`Feature Plan integration item not found: ${id}`);
      return mapFeaturePlanIntegrationItem(row);
    },

    updateFeaturePlanIntegration(input: FeaturePlanIntegrationUpdate): FeaturePlanIntegrationRecord {
      const integration = this.getFeaturePlanIntegration(input.id);
      updateFeaturePlanIntegrationStatement.run({
        id: integration.id,
        status: input.status ?? integration.status,
        checkpoint: input.checkpoint ?? integration.checkpoint,
        baseSha: input.baseSha === undefined ? integration.baseSha : input.baseSha,
        headSha: input.headSha === undefined ? integration.headSha : input.headSha,
        lastError: input.lastError === undefined ? integration.lastError : input.lastError,
        completedAt: input.completedAt === undefined ? integration.completedAt : input.completedAt,
        now: new Date().toISOString()
      });
      return this.getFeaturePlanIntegration(integration.id);
    },

    updateFeaturePlanIntegrationItem(input: FeaturePlanIntegrationItemUpdate): FeaturePlanIntegrationItemRecord {
      const item = this.getFeaturePlanIntegrationItem(input.id);
      updateFeaturePlanIntegrationItemStatement.run({
        id: item.id,
        status: input.status,
        appliedCommitSha: input.appliedCommitSha === undefined ? item.appliedCommitSha : input.appliedCommitSha,
        lastError: input.lastError === undefined ? item.lastError : input.lastError,
        now: new Date().toISOString()
      });
      return this.getFeaturePlanIntegrationItem(item.id);
    },

    findLatestCompletedGoalRunForTask(taskId: number): GoalRunRecord | null {
      const row = db
        .prepare(`
          SELECT *
          FROM goal_runs
          WHERE task_id = ?
            AND status = 'completed'
          ORDER BY id DESC
          LIMIT 1
        `)
        .get(taskId) as GoalRunRow | undefined;
      return row ? mapGoalRun(row) : null;
    },

    enqueueRuntimeUpdate(input: {
      featureId?: number | null;
      targetCommit: string;
      previousCommit: string;
    }): RuntimeUpdateRecord {
      if (input.featureId !== undefined && input.featureId !== null) {
        const existingRow = db
          .prepare("SELECT * FROM runtime_updates WHERE feature_id = ?")
          .get(input.featureId) as RuntimeUpdateRow | undefined;
        if (existingRow) return mapRuntimeUpdate(existingRow);
      }
      const now = new Date().toISOString();
      const result = enqueueRuntimeUpdateStatement.run({
        featureId: input.featureId ?? null,
        targetCommit: input.targetCommit,
        previousCommit: input.previousCommit,
        now
      });
      return this.getRuntimeUpdate(Number(result.lastInsertRowid));
    },

    updateRuntimeUpdate(input: {
      id: number;
      status: RuntimeUpdateStatus;
      error?: string | null;
    }): RuntimeUpdateRecord {
      const now = new Date().toISOString();
      updateRuntimeUpdateStatement.run({
        id: input.id,
        status: input.status,
        error: input.error ?? null,
        now
      });
      return this.getRuntimeUpdate(input.id);
    },

    getRuntimeUpdate(id: number): RuntimeUpdateRecord {
      const row = db.prepare("SELECT * FROM runtime_updates WHERE id = ?").get(id) as RuntimeUpdateRow | undefined;
      if (!row) throw new Error(`Runtime update not found: ${id}`);
      return mapRuntimeUpdate(row);
    },

    listRuntimeUpdates(limit = 30): RuntimeUpdateRecord[] {
      const rows = db.prepare("SELECT * FROM runtime_updates ORDER BY id DESC LIMIT ?").all(limit) as RuntimeUpdateRow[];
      return rows.map(mapRuntimeUpdate);
    },

    getLatestRuntimeUpdate(): RuntimeUpdateRecord | null {
      const row = db.prepare("SELECT * FROM runtime_updates ORDER BY id DESC LIMIT 1").get() as RuntimeUpdateRow | undefined;
      return row ? mapRuntimeUpdate(row) : null;
    }
  };
}

function migrate(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      path TEXT NOT NULL,
      default_branch TEXT NOT NULL DEFAULT 'main',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER,
      text TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      source TEXT NOT NULL,
      branch_name TEXT,
      worktree_path TEXT,
      base_branch TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id)
    );

    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      type TEXT NOT NULL,
      text TEXT NOT NULL,
      user_id TEXT,
      username TEXT,
      task_id INTEGER,
      created_at TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      FOREIGN KEY (task_id) REFERENCES tasks(id)
    );

    CREATE TABLE IF NOT EXISTS task_reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      provider TEXT NOT NULL,
      status TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      error TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (task_id) REFERENCES tasks(id)
    );

    CREATE TABLE IF NOT EXISTS improvement_proposals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT NOT NULL,
      title TEXT NOT NULL,
      rationale TEXT NOT NULL,
      proposed_change TEXT NOT NULL,
      evidence_json TEXT NOT NULL DEFAULT '[]',
      risk TEXT NOT NULL,
      source TEXT NOT NULL,
      project_key TEXT,
      targets_json TEXT NOT NULL DEFAULT '[]',
      confidence REAL,
      fingerprint TEXT,
      provenance_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'candidate',
      decision_note TEXT,
      created_at TEXT NOT NULL,
      decided_at TEXT,
      task_id INTEGER,
      feature_plan_id INTEGER
    );

    CREATE TABLE IF NOT EXISTS goal_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      status TEXT NOT NULL,
      current_phase TEXT NOT NULL,
      step_count INTEGER NOT NULL DEFAULT 0,
      max_steps INTEGER NOT NULL DEFAULT 12,
      last_error TEXT,
      commit_sha TEXT,
      pull_request_url TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      finished_at TEXT,
      FOREIGN KEY (task_id) REFERENCES tasks(id)
    );

    CREATE TABLE IF NOT EXISTS goal_steps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL,
      phase TEXT NOT NULL,
      provider TEXT NOT NULL,
      status TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      output TEXT NOT NULL DEFAULT '',
      error TEXT,
      duration_ms INTEGER,
      created_at TEXT NOT NULL,
      finished_at TEXT,
      FOREIGN KEY (run_id) REFERENCES goal_runs(id)
    );

    CREATE TABLE IF NOT EXISTS goal_checkpoints (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL,
      step_id INTEGER NOT NULL,
      phase TEXT NOT NULL,
      provider TEXT NOT NULL,
      status TEXT NOT NULL,
      summary TEXT NOT NULL,
      workspace_fingerprint TEXT,
      changed_files_json TEXT NOT NULL DEFAULT '[]',
      artifact_keys_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      FOREIGN KEY (run_id) REFERENCES goal_runs(id),
      FOREIGN KEY (step_id) REFERENCES goal_steps(id)
    );

    CREATE TABLE IF NOT EXISTS human_reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL,
      task_id INTEGER NOT NULL,
      decision TEXT NOT NULL,
      note TEXT NOT NULL,
      source TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (run_id) REFERENCES goal_runs(id),
      FOREIGN KEY (task_id) REFERENCES tasks(id)
    );

    CREATE TABLE IF NOT EXISTS features (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      objective TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      branch_name TEXT NOT NULL,
      worktree_path TEXT NOT NULL,
      pull_request_url TEXT NOT NULL UNIQUE,
      reviewer_provider TEXT,
      review_summary TEXT,
      reviewed_head_sha TEXT,
      last_error TEXT,
      merged_at TEXT,
      cancelled_at TEXT,
      cancel_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id)
    );

    CREATE TABLE IF NOT EXISTS feature_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      feature_id INTEGER NOT NULL,
      task_id INTEGER NOT NULL,
      pull_request_url TEXT NOT NULL,
      branch_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'included',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(feature_id, task_id),
      FOREIGN KEY (feature_id) REFERENCES features(id),
      FOREIGN KEY (task_id) REFERENCES tasks(id)
    );

    CREATE TABLE IF NOT EXISTS feature_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      objective TEXT NOT NULL,
      acceptance_criteria_json TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'queued',
      priority INTEGER NOT NULL DEFAULT 0,
      is_paused INTEGER NOT NULL DEFAULT 0,
      paused_at TEXT,
      pause_reason TEXT,
      blocked_at TEXT,
      blocked_reason TEXT,
      admitted_at TEXT,
      completed_at TEXT,
      source TEXT NOT NULL,
      created_by_user_id TEXT,
      created_by_username TEXT,
      revision INTEGER NOT NULL DEFAULT 1,
      cancelled_at TEXT,
      cancel_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id)
    );

    CREATE TABLE IF NOT EXISTS feature_plan_dependencies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      feature_plan_id INTEGER NOT NULL,
      depends_on_feature_plan_id INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(feature_plan_id, depends_on_feature_plan_id),
      FOREIGN KEY (feature_plan_id) REFERENCES feature_plans(id),
      FOREIGN KEY (depends_on_feature_plan_id) REFERENCES feature_plans(id)
    );

    CREATE TABLE IF NOT EXISTS feature_plan_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      feature_plan_id INTEGER NOT NULL,
      from_status TEXT,
      to_status TEXT NOT NULL,
      action TEXT NOT NULL,
      reason TEXT,
      actor_user_id TEXT,
      actor_username TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      FOREIGN KEY (feature_plan_id) REFERENCES feature_plans(id)
    );

    CREATE TABLE IF NOT EXISTS feature_plan_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      feature_plan_id INTEGER NOT NULL,
      task_id INTEGER NOT NULL,
      position INTEGER NOT NULL,
      contract_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      UNIQUE(feature_plan_id, task_id),
      FOREIGN KEY (feature_plan_id) REFERENCES feature_plans(id),
      FOREIGN KEY (task_id) REFERENCES tasks(id)
    );

    CREATE TABLE IF NOT EXISTS github_issue_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subject_type TEXT NOT NULL CHECK(subject_type IN ('feature_plan', 'task')),
      subject_id INTEGER NOT NULL,
      issue_number INTEGER NOT NULL CHECK(issue_number > 0),
      created_at TEXT NOT NULL,
      UNIQUE(subject_type, subject_id)
    );

    CREATE TABLE IF NOT EXISTS feature_plan_operations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      feature_plan_id INTEGER NOT NULL,
      operation_type TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      request_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (feature_plan_id) REFERENCES feature_plans(id)
    );

    CREATE TABLE IF NOT EXISTS feature_plan_integrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      feature_plan_id INTEGER NOT NULL UNIQUE,
      project_id INTEGER NOT NULL,
      plan_revision INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'preparing',
      checkpoint TEXT NOT NULL DEFAULT 'created',
      branch_name TEXT NOT NULL,
      worktree_path TEXT NOT NULL,
      base_sha TEXT,
      head_sha TEXT,
      last_error TEXT,
      completed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (feature_plan_id) REFERENCES feature_plans(id),
      FOREIGN KEY (project_id) REFERENCES projects(id)
    );

    CREATE TABLE IF NOT EXISTS feature_plan_integration_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      integration_id INTEGER NOT NULL,
      feature_plan_id INTEGER NOT NULL,
      task_id INTEGER NOT NULL,
      position INTEGER NOT NULL,
      commit_sha TEXT NOT NULL,
      pull_request_url TEXT NOT NULL,
      branch_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      applied_commit_sha TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(integration_id, task_id),
      UNIQUE(integration_id, commit_sha),
      FOREIGN KEY (integration_id) REFERENCES feature_plan_integrations(id),
      FOREIGN KEY (feature_plan_id) REFERENCES feature_plans(id),
      FOREIGN KEY (task_id) REFERENCES tasks(id)
    );

    CREATE TABLE IF NOT EXISTS completion_review_outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subject_type TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      completion_version TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending', 'running', 'succeeded', 'waiting_provider', 'failed')),
      evidence_json TEXT NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      available_at TEXT NOT NULL,
      lease_owner TEXT,
      lease_expires_at TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      UNIQUE(subject_type, subject_id, completion_version)
    );

    CREATE TABLE IF NOT EXISTS runtime_updates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      feature_id INTEGER UNIQUE,
      target_commit TEXT NOT NULL,
      previous_commit TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending', 'in_progress', 'completed', 'failed', 'rolled_back')),
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_feature_plan_tasks_task_id
      ON feature_plan_tasks(task_id);
    CREATE INDEX IF NOT EXISTS idx_github_issue_links_issue_number
      ON github_issue_links(issue_number);
    CREATE INDEX IF NOT EXISTS idx_feature_plan_operations_plan_id
      ON feature_plan_operations(feature_plan_id);
    CREATE INDEX IF NOT EXISTS idx_feature_plan_integrations_plan_id
      ON feature_plan_integrations(feature_plan_id);
    CREATE INDEX IF NOT EXISTS idx_feature_plan_integration_items_integration_id
      ON feature_plan_integration_items(integration_id);
    CREATE INDEX IF NOT EXISTS idx_feature_plan_integration_items_task_id
      ON feature_plan_integration_items(task_id);
    CREATE INDEX IF NOT EXISTS idx_completion_review_outbox_claim
      ON completion_review_outbox(status, available_at, lease_expires_at, id);
    CREATE INDEX IF NOT EXISTS idx_goal_checkpoints_run_id
      ON goal_checkpoints(run_id, id);
    CREATE INDEX IF NOT EXISTS idx_runtime_updates_feature_id
      ON runtime_updates(feature_id);
    CREATE INDEX IF NOT EXISTS idx_runtime_updates_status
      ON runtime_updates(status);
  `);

  migrateSkillPersistence(db);
  migrateWorkGraphPersistence(db);

  addColumnIfMissing(db, "tasks", "project_id", "INTEGER REFERENCES projects(id)");
  addColumnIfMissing(db, "tasks", "branch_name", "TEXT");
  addColumnIfMissing(db, "tasks", "worktree_path", "TEXT");
  addColumnIfMissing(db, "tasks", "base_branch", "TEXT");
  addColumnIfMissing(db, "goal_runs", "commit_sha", "TEXT");
  addColumnIfMissing(db, "goal_runs", "pull_request_url", "TEXT");
  addColumnIfMissing(db, "goal_runs", "wait_reason", "TEXT");
  addColumnIfMissing(db, "goal_runs", "next_retry_at", "TEXT");
  addColumnIfMissing(db, "goal_runs", "last_provider", "TEXT");
  addColumnIfMissing(db, "feature_plans", "revision", "INTEGER NOT NULL DEFAULT 1");
  addColumnIfMissing(db, "feature_plans", "priority", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "feature_plans", "is_paused", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "feature_plans", "paused_at", "TEXT");
  addColumnIfMissing(db, "feature_plans", "pause_reason", "TEXT");
  addColumnIfMissing(db, "feature_plans", "blocked_at", "TEXT");
  addColumnIfMissing(db, "feature_plans", "blocked_reason", "TEXT");
  addColumnIfMissing(db, "feature_plans", "admitted_at", "TEXT");
  addColumnIfMissing(db, "feature_plans", "completed_at", "TEXT");
  addColumnIfMissing(db, "feature_plans", "cancel_reason", "TEXT");
  db.exec("UPDATE feature_plans SET status = 'queued' WHERE status = 'planned'");
  addColumnIfMissing(db, "feature_plan_tasks", "contract_json", "TEXT NOT NULL DEFAULT '{}'");
  addColumnIfMissing(db, "features", "feature_plan_id", "INTEGER REFERENCES feature_plans(id)");
  addColumnIfMissing(db, "features", "cancelled_at", "TEXT");
  addColumnIfMissing(db, "features", "cancel_reason", "TEXT");
  addColumnIfMissing(db, "improvement_proposals", "project_key", "TEXT");
  addColumnIfMissing(db, "improvement_proposals", "targets_json", "TEXT NOT NULL DEFAULT '[]'");
  addColumnIfMissing(db, "improvement_proposals", "confidence", "REAL");
  addColumnIfMissing(db, "improvement_proposals", "fingerprint", "TEXT");
  addColumnIfMissing(db, "improvement_proposals", "provenance_json", "TEXT NOT NULL DEFAULT '{}'");
  addColumnIfMissing(db, "improvement_proposals", "task_id", "INTEGER");
  addColumnIfMissing(db, "improvement_proposals", "feature_plan_id", "INTEGER");
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_features_feature_plan_id
      ON features(feature_plan_id) WHERE feature_plan_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_improvement_proposals_fingerprint
      ON improvement_proposals(fingerprint) WHERE fingerprint IS NOT NULL;
  `);
}

type ProjectRow = {
  id: number;
  key: string;
  name: string;
  path: string;
  default_branch: string;
  created_at: string;
  updated_at: string;
};

type TaskRow = {
  id: number;
  project_id: number | null;
  project_key: string | null;
  project_name: string | null;
  text: string;
  status: TaskStatus;
  source: string;
  branch_name: string | null;
  worktree_path: string | null;
  base_branch: string | null;
  created_at: string;
  updated_at: string;
};

type EventRow = {
  id: number;
  source: string;
  type: string;
  text: string;
  user_id: string | null;
  username: string | null;
  task_id: number | null;
  created_at: string;
  metadata_json: string;
};

type TaskReviewRow = {
  id: number;
  task_id: number;
  provider: string;
  status: TaskReviewStatus;
  content: string;
  error: string | null;
  created_at: string;
};

type ImprovementProposalRow = {
  id: number;
  category: ImprovementCategory;
  title: string;
  rationale: string;
  proposed_change: string;
  evidence_json: string;
  risk: ImprovementRisk;
  source: string;
  project_key: string | null;
  targets_json: string;
  confidence: number | null;
  fingerprint: string | null;
  provenance_json: string;
  status: ImprovementStatus;
  decision_note: string | null;
  created_at: string;
  decided_at: string | null;
  task_id: number | null;
  feature_plan_id: number | null;
};

type GoalRunRow = {
  id: number;
  task_id: number;
  status: GoalRunStatus;
  current_phase: GoalPhase;
  step_count: number;
  max_steps: number;
  last_error: string | null;
  wait_reason: GoalWaitReason | null;
  next_retry_at: string | null;
  last_provider: string | null;
  commit_sha: string | null;
  pull_request_url: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
};

type GoalCheckpointRow = {
  id: number;
  run_id: number;
  step_id: number;
  phase: GoalPhase;
  provider: string;
  status: GoalCheckpointStatus;
  summary: string;
  workspace_fingerprint: string | null;
  changed_files_json: string;
  artifact_keys_json: string;
  created_at: string;
};

type GoalStepRow = {
  id: number;
  run_id: number;
  phase: GoalPhase;
  provider: string;
  status: GoalStepStatus;
  summary: string;
  output: string;
  error: string | null;
  duration_ms: number | null;
  created_at: string;
  finished_at: string | null;
};

type HumanReviewRow = {
  id: number;
  run_id: number;
  task_id: number;
  decision: HumanReviewDecision;
  note: string;
  source: string;
  created_at: string;
};

type FeatureRow = {
  id: number;
  project_id: number;
  project_key: string;
  project_name: string;
  feature_plan_id: number | null;
  name: string;
  objective: string;
  status: FeatureStatus;
  branch_name: string;
  worktree_path: string;
  pull_request_url: string;
  reviewer_provider: string | null;
  review_summary: string | null;
  reviewed_head_sha: string | null;
  last_error: string | null;
  merged_at: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
  created_at: string;
  updated_at: string;
};

type FeatureItemRow = {
  id: number;
  feature_id: number;
  task_id: number;
  pull_request_url: string;
  branch_name: string;
  status: FeatureItemStatus;
  created_at: string;
  updated_at: string;
};

type FeaturePlanRow = {
  id: number;
  project_id: number;
  project_key: string;
  project_name: string;
  objective: string;
  acceptance_criteria_json: string;
  status: FeaturePlanStatus;
  priority?: number;
  is_paused?: number;
  paused_at?: string | null;
  pause_reason?: string | null;
  blocked_at?: string | null;
  blocked_reason?: string | null;
  admitted_at?: string | null;
  completed_at?: string | null;
  source: string;
  created_by_user_id: string | null;
  created_by_username: string | null;
  revision: number;
  cancelled_at: string | null;
  cancel_reason: string | null;
  created_at: string;
  updated_at: string;
};

type FeaturePlanDependencyRow = {
  id: number;
  feature_plan_id: number;
  depends_on_feature_plan_id: number;
  created_at: string;
};

type FeaturePlanHistoryRow = {
  id: number;
  feature_plan_id: number;
  from_status: string | null;
  to_status: FeaturePlanQueueStatus;
  action: string;
  reason: string | null;
  actor_user_id: string | null;
  actor_username: string | null;
  metadata_json: string;
  created_at: string;
};

type FeaturePlanTaskRow = {
  id: number;
  feature_plan_id: number;
  task_id: number;
  task_text: string;
  task_status: TaskStatus;
  position: number;
  contract_json: string;
  created_at: string;
};

type FeaturePlanOperationRow = {
  id: number;
  feature_plan_id: number;
  operation_type: "create" | "replan";
  idempotency_key: string;
  request_hash: string;
  created_at: string;
};

type FeaturePlanIntegrationRow = {
  id: number;
  feature_plan_id: number;
  project_id: number;
  project_key: string;
  project_name: string;
  plan_revision: number;
  status: FeaturePlanIntegrationStatus;
  checkpoint: FeaturePlanIntegrationCheckpoint;
  branch_name: string;
  worktree_path: string;
  base_sha: string | null;
  head_sha: string | null;
  last_error: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
};

type FeaturePlanIntegrationItemBaseRow = {
  id: number;
  integration_id: number;
  feature_plan_id: number;
  task_id: number;
  position: number;
  commit_sha: string;
  pull_request_url: string;
  branch_name: string;
  status: FeaturePlanIntegrationItemStatus;
  applied_commit_sha: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

type FeaturePlanIntegrationItemRow = FeaturePlanIntegrationItemBaseRow & {
  task_text: string;
  task_status: TaskStatus;
};

type CompletionReviewRow = {
  id: number;
  subject_type: CompletionReviewSubjectType;
  subject_id: string;
  completion_version: string;
  status: CompletionReviewStatus;
  evidence_json: string;
  attempt_count: number;
  available_at: string;
  lease_owner: string | null;
  lease_expires_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
};

function addColumnIfMissing(db: Database.Database, table: string, column: string, definition: string) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((item) => item.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function normalizeProjectInput(input: ProjectInput) {
  const key = input.key.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{1,48}$/.test(key)) {
    throw new Error("Project key must use 2-49 chars: lowercase letters, numbers, underscore or dash.");
  }

  return {
    key,
    name: input.name?.trim() || key,
    path: path.resolve(input.path.trim()),
    defaultBranch: input.defaultBranch?.trim() || "main"
  };
}

function normalizeImprovementProposal(input: ImprovementProposalInput) {
  const category = input.category;
  const risk = input.risk;
  if (!["skill", "memory", "routing", "policy", "integration"].includes(category)) {
    throw new Error(`Unsupported improvement category: ${category}`);
  }
  if (!["low", "medium", "high"].includes(risk)) {
    throw new Error(`Unsupported improvement risk: ${risk}`);
  }

  const title = redactSensitiveText(input.title.trim());
  const rationale = redactSensitiveText(input.rationale.trim());
  const proposedChange = redactSensitiveText(input.proposedChange.trim());
  const evidence = input.evidence.map((item) => redactSensitiveText(item.trim())).filter(Boolean);
  const targets = (input.targets ?? []).map((item) => redactSensitiveText(item.trim())).filter(Boolean);
  if (title.length < 4 || title.length > 160 || rationale.length < 8 || rationale.length > 4_000
    || proposedChange.length < 8 || proposedChange.length > 4_000
    || evidence.length === 0 || evidence.length > 20
    || evidence.some((item) => item.length > 1_000)
    || targets.length > 8 || targets.some((item) => item.length > 160)) {
    throw new Error("Improvement proposals require a title, rationale, proposed change and evidence.");
  }
  const confidence = input.confidence ?? null;
  if (confidence !== null && (!Number.isFinite(confidence) || confidence < 0 || confidence > 1)) {
    throw new Error("Improvement confidence must be between 0 and 1.");
  }
  const fingerprint = input.fingerprint?.trim() || null;
  if (fingerprint && (fingerprint.length > 128 || !/^[a-zA-Z0-9:._-]+$/.test(fingerprint))) {
    throw new Error("Improvement fingerprint is invalid.");
  }

  return {
    category,
    title,
    rationale,
    proposedChange,
    evidence,
    risk,
    source: input.source?.trim() || "dashboard",
    projectKey: input.projectKey?.trim().toLowerCase() || null,
    targets,
    confidence,
    fingerprint,
    provenance: sanitizePublicMetadata(input.provenance ?? {}) as Record<string, unknown>
  };
}

type NormalizedFeaturePlanInput = Required<Omit<
  FeaturePlanInput,
  "featureIssueNumber" | "taskIssueNumbers" | "taskContracts" | "priority" | "dependsOnFeaturePlanIds"
>> & {
  priority: number;
  dependsOnFeaturePlanIds: number[];
  featureIssueNumber: number | null;
  taskIssueNumbers: Record<number, number>;
  taskContracts?: FeatureTaskContractInput[];
};

function normalizeFeaturePlanInput(input: FeaturePlanInput): NormalizedFeaturePlanInput {
  const projectKey = input.projectKey.trim().toLowerCase();
  if (!projectKey) throw new Error("Feature plan project is required.");

  const objective = input.objective.trim();
  const acceptanceCriteria = input.acceptanceCriteria
    .map((item) => item.trim())
    .filter(Boolean);
  const taskIds = uniqueTaskIds(input.taskIds);
  const priority = input.priority !== undefined && Number.isInteger(input.priority)
    ? input.priority
    : 0;
  const dependsOnFeaturePlanIds = uniquePlanIds(input.dependsOnFeaturePlanIds ?? []);
  const source = input.source?.trim() || "dashboard";
  const idempotencyKey = input.idempotencyKey?.trim() || null;
  const featureIssueNumber = normalizeIssueNumber(input.featureIssueNumber, "Feature");
  const taskIssueNumbers: Record<number, number> = {};
  for (const [rawTaskId, rawIssueNumber] of Object.entries(input.taskIssueNumbers ?? {})) {
    const taskId = Number(rawTaskId);
    if (!taskIds.includes(taskId)) {
      throw new Error(`GitHub issue link references Task #${rawTaskId} outside the Feature Plan.`);
    }
    taskIssueNumbers[taskId] = normalizeIssueNumber(rawIssueNumber, `Task #${taskId}`)!;
  }

  if (objective.length < 8) {
    throw new Error("Feature plan objective must be at least 8 characters.");
  }
  if (acceptanceCriteria.length === 0) {
    throw new Error("Feature plan requires at least one acceptance criterion.");
  }
  if (taskIds.length === 0) {
    throw new Error("Feature plan requires at least one explicit task association.");
  }
  if (idempotencyKey && idempotencyKey.length > 120) {
    throw new Error("Feature plan idempotency key must be 120 characters or fewer.");
  }

  return {
    projectKey,
    objective,
    acceptanceCriteria,
    taskIds,
    priority,
    dependsOnFeaturePlanIds,
    taskContracts: input.taskContracts,
    source,
    createdByUserId: input.createdByUserId?.trim() || null,
    createdByUsername: input.createdByUsername?.trim() || null,
    idempotencyKey,
    featureIssueNumber,
    taskIssueNumbers
  };
}

function uniquePlanIds(planIds: number[]): number[] {
  const seen = new Set<number>();
  const normalized: number[] = [];
  for (const id of planIds) {
    if (!Number.isInteger(id) || id <= 0) {
      throw new Error("Feature plan dependency ids must be positive integers.");
    }
    if (!seen.has(id)) {
      seen.add(id);
      normalized.push(id);
    }
  }
  return normalized;
}

function checkDependencyCycle(
  db: Database.Database,
  featurePlanId: number,
  dependsOnFeaturePlanId: number
): void {
  const visited = new Set<number>();
  const queue = [dependsOnFeaturePlanId];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current === featurePlanId) {
      throw new Error(
        `Cyclic dependency detected: Feature Plan #${featurePlanId} cannot depend on #${dependsOnFeaturePlanId}.`
      );
    }
    if (visited.has(current)) continue;
    visited.add(current);

    const rows = db.prepare(
      "SELECT depends_on_feature_plan_id FROM feature_plan_dependencies WHERE feature_plan_id = ?"
    ).all(current) as Array<{ depends_on_feature_plan_id: number }>;

    for (const row of rows) {
      if (!visited.has(row.depends_on_feature_plan_id)) {
        queue.push(row.depends_on_feature_plan_id);
      }
    }
  }
}

function normalizeIssueNumber(value: number | null | undefined, label: string): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} GitHub issue number must be a positive integer.`);
  }
  return value;
}

function uniqueTaskIds(taskIds: number[]): number[] {
  const seen = new Set<number>();
  const normalized: number[] = [];
  for (const taskId of taskIds) {
    if (!Number.isInteger(taskId) || taskId <= 0) {
      throw new Error("Feature plan task ids must be positive integers.");
    }
    if (seen.has(taskId)) {
      throw new Error(`Feature plan task #${taskId} was provided more than once.`);
    }
    seen.add(taskId);
    normalized.push(taskId);
  }
  return normalized;
}

function validateFeaturePlanTasks(
  projectId: number,
  taskIds: number[],
  getTask: (id: number) => TaskRecord
): void {
  for (const taskId of taskIds) {
    const task = getTask(taskId);
    if (task.projectId !== projectId) {
      throw new Error(`Task #${taskId} does not belong to the Feature Plan project.`);
    }
  }
}

function validateFeaturePlanTaskAvailability(
  db: Database.Database,
  taskIds: number[],
  currentFeaturePlanId?: number
): void {
  for (const taskId of taskIds) {
    const row = db.prepare(`
      SELECT feature_plans.id AS feature_plan_id
      FROM feature_plan_tasks
      JOIN feature_plans ON feature_plans.id = feature_plan_tasks.feature_plan_id
      WHERE feature_plan_tasks.task_id = ?
        AND feature_plans.status NOT IN ('completed', 'cancelled')
        AND feature_plans.id <> ?
      ORDER BY feature_plans.id ASC
      LIMIT 1
    `).get(taskId, currentFeaturePlanId ?? -1) as { feature_plan_id: number } | undefined;
    if (row) {
      throw new Error(`Task #${taskId} is already associated with active Feature Plan #${row.feature_plan_id}.`);
    }
  }
}

function assertFeaturePlanIntegrationNotStarted(db: Database.Database, featurePlanId: number): void {
  const row = db
    .prepare("SELECT id FROM feature_plan_integrations WHERE feature_plan_id = ? LIMIT 1")
    .get(featurePlanId) as { id: number } | undefined;
  if (row) {
    throw new Error(`Feature plan #${featurePlanId} already has integration checkpoint #${row.id}.`);
  }
}

function insertFeaturePlanTasks(
  statement: Database.Statement,
  featurePlanId: number,
  taskIds: number[],
  contracts: Map<number, FeatureTaskContract>,
  now: string
): void {
  taskIds.forEach((taskId, index) => {
    statement.run({
      featurePlanId,
      taskId,
      position: index + 1,
      contractJson: JSON.stringify(contracts.get(taskId)),
      now
    });
  });
}

function normalizeFeaturePlanIntegrationItemInput(
  input: FeaturePlanIntegrationItemInput
): FeaturePlanIntegrationItemInput {
  const commitSha = input.commitSha.trim();
  const pullRequestUrl = input.pullRequestUrl.trim();
  const branchName = input.branchName.trim();
  if (!Number.isInteger(input.position) || input.position <= 0) {
    throw new Error("Feature Plan integration item position must be a positive integer.");
  }
  if (!/^[a-f0-9]{40}$/i.test(commitSha)) {
    throw new Error(`Feature Plan integration item for task #${input.taskId} has an invalid commit SHA.`);
  }
  if (!/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+\/?$/i.test(pullRequestUrl)) {
    throw new Error(`Feature Plan integration item for task #${input.taskId} has an invalid Work PR URL.`);
  }
  if (!branchName) {
    throw new Error(`Feature Plan integration item for task #${input.taskId} requires a branch name.`);
  }

  return {
    integrationId: input.integrationId,
    featurePlanId: input.featurePlanId,
    taskId: input.taskId,
    position: input.position,
    commitSha: commitSha.toLowerCase(),
    pullRequestUrl,
    branchName
  };
}

function findFeaturePlanOperation(
  db: Database.Database,
  idempotencyKey: string
): FeaturePlanOperationRow | null {
  const row = db
    .prepare("SELECT * FROM feature_plan_operations WHERE idempotency_key = ?")
    .get(idempotencyKey) as FeaturePlanOperationRow | undefined;
  return row ?? null;
}

function validateFeaturePlanOperationReuse(
  operation: FeaturePlanOperationRow,
  operationType: "create" | "replan",
  requestHash: string,
  expectedFeaturePlanId?: number
): void {
  if (
    operation.operation_type !== operationType
    || operation.request_hash !== requestHash
    || (expectedFeaturePlanId !== undefined && operation.feature_plan_id !== expectedFeaturePlanId)
  ) {
    throw new Error("Feature plan idempotency key was already used for a different operation.");
  }
}

function hashFeaturePlanOperation(operationType: "create" | "replan", payload: Record<string, unknown>): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify({ operationType, ...payload }))
    .digest("hex");
}

function mapProject(row: ProjectRow): ProjectRecord {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    path: row.path,
    defaultBranch: row.default_branch,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapTask(row: TaskRow): TaskRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    projectKey: row.project_key,
    projectName: row.project_name,
    text: row.text,
    status: row.status,
    source: row.source,
    branchName: row.branch_name,
    worktreePath: row.worktree_path,
    baseBranch: row.base_branch,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapEvent(row: EventRow): EventRecord {
  return {
    id: row.id,
    source: row.source,
    type: row.type,
    text: row.text,
    userId: row.user_id,
    username: row.username,
    taskId: row.task_id,
    createdAt: row.created_at,
    metadata: JSON.parse(row.metadata_json || "{}") as Record<string, unknown>
  };
}

function mapTaskReview(row: TaskReviewRow): TaskReviewRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    provider: row.provider,
    status: row.status,
    content: row.content,
    error: row.error,
    createdAt: row.created_at
  };
}

function mapImprovementProposal(row: ImprovementProposalRow): ImprovementProposalRecord {
  return {
    id: row.id,
    category: row.category,
    title: row.title,
    rationale: row.rationale,
    proposedChange: row.proposed_change,
    evidence: JSON.parse(row.evidence_json || "[]") as string[],
    risk: row.risk,
    source: row.source,
    projectKey: row.project_key,
    targets: JSON.parse(row.targets_json || "[]") as string[],
    confidence: row.confidence,
    fingerprint: row.fingerprint,
    provenance: JSON.parse(row.provenance_json || "{}") as Record<string, unknown>,
    status: row.status,
    decisionNote: row.decision_note,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
    taskId: row.task_id,
    featurePlanId: row.feature_plan_id
  };
}

function mapGoalRun(row: GoalRunRow): GoalRunRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    status: row.status,
    currentPhase: row.current_phase,
    stepCount: row.step_count,
    maxSteps: row.max_steps,
    lastError: row.last_error,
    waitReason: row.wait_reason,
    nextRetryAt: row.next_retry_at,
    lastProvider: row.last_provider,
    commitSha: row.commit_sha,
    pullRequestUrl: row.pull_request_url,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at
  };
}

function mapGoalCheckpoint(row: GoalCheckpointRow): GoalCheckpointRecord {
  return {
    id: row.id,
    runId: row.run_id,
    stepId: row.step_id,
    phase: row.phase,
    provider: row.provider,
    status: row.status,
    summary: row.summary,
    workspaceFingerprint: row.workspace_fingerprint,
    changedFiles: JSON.parse(row.changed_files_json || "[]") as string[],
    artifactKeys: JSON.parse(row.artifact_keys_json || "[]") as string[],
    createdAt: row.created_at
  };
}

function mapGoalStep(row: GoalStepRow): GoalStepRecord {
  return {
    id: row.id,
    runId: row.run_id,
    phase: row.phase,
    provider: row.provider,
    status: row.status,
    summary: row.summary,
    output: row.output,
    error: row.error,
    durationMs: row.duration_ms,
    createdAt: row.created_at,
    finishedAt: row.finished_at
  };
}

function mapHumanReview(row: HumanReviewRow): HumanReviewRecord {
  return {
    id: row.id,
    runId: row.run_id,
    taskId: row.task_id,
    decision: row.decision,
    note: row.note,
    source: row.source,
    createdAt: row.created_at
  };
}

function mapFeature(row: FeatureRow): FeatureRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    projectKey: row.project_key,
    projectName: row.project_name,
    featurePlanId: row.feature_plan_id,
    name: row.name,
    objective: row.objective,
    status: row.status,
    branchName: row.branch_name,
    worktreePath: row.worktree_path,
    pullRequestUrl: row.pull_request_url,
    reviewerProvider: row.reviewer_provider,
    reviewSummary: row.review_summary,
    reviewedHeadSha: row.reviewed_head_sha,
    lastError: row.last_error,
    mergedAt: row.merged_at,
    cancelledAt: row.cancelled_at,
    cancelReason: row.cancel_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapFeatureItem(row: FeatureItemRow): FeatureItemRecord {
  return {
    id: row.id,
    featureId: row.feature_id,
    taskId: row.task_id,
    pullRequestUrl: row.pull_request_url,
    branchName: row.branch_name,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

type RuntimeUpdateRow = {
  id: number;
  feature_id: number | null;
  target_commit: string;
  previous_commit: string;
  status: RuntimeUpdateStatus;
  error: string | null;
  created_at: string;
  updated_at: string;
};

function mapRuntimeUpdate(row: RuntimeUpdateRow): RuntimeUpdateRecord {
  return {
    id: row.id,
    featureId: row.feature_id,
    targetCommit: row.target_commit,
    previousCommit: row.previous_commit,
    status: row.status,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapFeaturePlan(row: FeaturePlanRow): FeaturePlanRecord {
  const status: FeaturePlanQueueStatus = (row.status as string) === "planned"
    ? "queued"
    : (row.status as FeaturePlanQueueStatus);

  return {
    id: row.id,
    projectId: row.project_id,
    projectKey: row.project_key,
    projectName: row.project_name,
    objective: row.objective,
    acceptanceCriteria: parseStringArrayJson(row.acceptance_criteria_json),
    status,
    priority: row.priority ?? 0,
    isPaused: Boolean(row.is_paused),
    pausedAt: row.paused_at ?? null,
    pauseReason: row.pause_reason ?? null,
    blockedAt: row.blocked_at ?? null,
    blockedReason: row.blocked_reason ?? null,
    admittedAt: row.admitted_at ?? null,
    completedAt: row.completed_at ?? null,
    source: row.source,
    createdByUserId: row.created_by_user_id,
    createdByUsername: row.created_by_username,
    revision: row.revision,
    cancelledAt: row.cancelled_at,
    cancelReason: row.cancel_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapFeaturePlanDependency(row: FeaturePlanDependencyRow): FeaturePlanDependencyRecord {
  return {
    id: row.id,
    featurePlanId: row.feature_plan_id,
    dependsOnFeaturePlanId: row.depends_on_feature_plan_id,
    createdAt: row.created_at
  };
}

function mapFeaturePlanHistory(row: FeaturePlanHistoryRow): FeaturePlanHistoryRecord {
  return {
    id: row.id,
    featurePlanId: row.feature_plan_id,
    fromStatus: (row.from_status as FeaturePlanQueueStatus) || null,
    toStatus: row.to_status,
    action: row.action,
    reason: row.reason,
    actorUserId: row.actor_user_id,
    actorUsername: row.actor_username,
    metadata: parseJsonObject(row.metadata_json),
    createdAt: row.created_at
  };
}

function parseJsonObject(value: string | null): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value || "{}") as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function parseStringArrayJson(value: string | null): string[] {
  try {
    const parsed = JSON.parse(value || "[]") as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function mapFeaturePlanTask(
  row: FeaturePlanTaskRow,
  contract: FeatureTaskContract
): FeaturePlanTaskRecord {
  return {
    id: row.id,
    featurePlanId: row.feature_plan_id,
    taskId: row.task_id,
    taskText: row.task_text,
    taskStatus: row.task_status,
    position: row.position,
    contract,
    createdAt: row.created_at
  };
}

function parseFeatureTaskContract(
  value: string,
  row: FeaturePlanTaskRow,
  previousTaskId?: number
): FeatureTaskContract {
  try {
    const parsed = JSON.parse(value || "{}") as Partial<FeatureTaskContract>;
    if (
      typeof parsed.objective === "string"
      && Array.isArray(parsed.acceptanceCriteria)
      && Array.isArray(parsed.excludedScope)
      && Array.isArray(parsed.mutationScope)
      && Array.isArray(parsed.dependsOnTaskIds)
      && (parsed.parallelMode === "serial" || parsed.parallelMode === "parallel")
    ) {
      return { ...parsed, workGraphRequest: parsed.workGraphRequest ?? null } as FeatureTaskContract;
    }
  } catch {
    // Legacy rows are migrated to the safe serial contract below.
  }
  return legacyFeatureTaskContract(row.task_id, row.task_text, previousTaskId);
}

function mapFeaturePlanIntegration(row: FeaturePlanIntegrationRow): FeaturePlanIntegrationRecord {
  return {
    id: row.id,
    featurePlanId: row.feature_plan_id,
    projectId: row.project_id,
    projectKey: row.project_key,
    projectName: row.project_name,
    planRevision: row.plan_revision,
    status: row.status,
    checkpoint: row.checkpoint,
    branchName: row.branch_name,
    worktreePath: row.worktree_path,
    baseSha: row.base_sha,
    headSha: row.head_sha,
    lastError: row.last_error,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapFeaturePlanIntegrationItem(
  row: FeaturePlanIntegrationItemRow
): FeaturePlanIntegrationItemRecord {
  return {
    id: row.id,
    integrationId: row.integration_id,
    featurePlanId: row.feature_plan_id,
    taskId: row.task_id,
    taskText: row.task_text,
    taskStatus: row.task_status,
    position: row.position,
    commitSha: row.commit_sha,
    pullRequestUrl: row.pull_request_url,
    branchName: row.branch_name,
    status: row.status,
    appliedCommitSha: row.applied_commit_sha,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapCompletionReview(row: CompletionReviewRow): CompletionReviewRecord {
  return {
    id: row.id,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    completionVersion: row.completion_version,
    status: row.status,
    evidence: JSON.parse(row.evidence_json) as CompletionReviewRecord["evidence"],
    attemptCount: row.attempt_count,
    availableAt: row.available_at,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at
  };
}

function featureSelectSql(suffix = ""): string {
  return `
    SELECT features.*,
           projects.key AS project_key,
           projects.name AS project_name
    FROM features
    JOIN projects ON projects.id = features.project_id
    ${suffix}
  `;
}

function featurePlanSelectSql(suffix = ""): string {
  return `
    SELECT feature_plans.*,
           projects.key AS project_key,
           projects.name AS project_name
    FROM feature_plans
    JOIN projects ON projects.id = feature_plans.project_id
    ${suffix}
  `;
}

function featurePlanTasksSelectSql(suffix = ""): string {
  return `
    SELECT feature_plan_tasks.*,
           tasks.text AS task_text,
           tasks.status AS task_status
    FROM feature_plan_tasks
    JOIN tasks ON tasks.id = feature_plan_tasks.task_id
    ${suffix}
  `;
}

function featurePlanIntegrationSelectSql(suffix = ""): string {
  return `
    SELECT feature_plan_integrations.*,
           projects.key AS project_key,
           projects.name AS project_name
    FROM feature_plan_integrations
    JOIN projects ON projects.id = feature_plan_integrations.project_id
    ${suffix}
  `;
}

function featurePlanIntegrationItemsSelectSql(suffix = ""): string {
  return `
    SELECT feature_plan_integration_items.*,
           tasks.text AS task_text,
           tasks.status AS task_status
    FROM feature_plan_integration_items
    JOIN tasks ON tasks.id = feature_plan_integration_items.task_id
    ${suffix}
  `;
}

function taskSelectSql(suffix: string): string {
  return `
    SELECT
      tasks.*,
      projects.key as project_key,
      projects.name as project_name
    FROM tasks
    LEFT JOIN projects ON projects.id = tasks.project_id
    ${suffix}
  `;
}
