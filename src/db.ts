import Database from "better-sqlite3";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

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
  createdAt: string;
  updatedAt: string;
};

export type TaskWorktreeUpdate = {
  id: number;
  status: TaskStatus;
  branchName: string;
  worktreePath: string;
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
  status: ImprovementStatus;
  decisionNote: string | null;
  createdAt: string;
  decidedAt: string | null;
};

export type ImprovementProposalInput = {
  category: ImprovementCategory;
  title: string;
  rationale: string;
  proposedChange: string;
  evidence: string[];
  risk: ImprovementRisk;
  source?: string;
};

export type GoalRunStatus = "running" | "waiting_provider" | "completed" | "blocked" | "failed" | "cancelled";
export type GoalPhase = "planning" | "implementing" | "testing" | "reviewing";
export type GoalStepStatus = "running" | "completed" | "changes_requested" | "blocked" | "failed" | "cancelled";

export type GoalRunRecord = {
  id: number;
  taskId: number;
  status: GoalRunStatus;
  currentPhase: GoalPhase;
  stepCount: number;
  maxSteps: number;
  lastError: string | null;
  commitSha: string | null;
  pullRequestUrl: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
};

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

export type FeaturePlanStatus = "planned" | "cancelled";

export type FeaturePlanRecord = {
  id: number;
  projectId: number;
  projectKey: string;
  projectName: string;
  objective: string;
  acceptanceCriteria: string[];
  status: FeaturePlanStatus;
  source: string;
  createdByUserId: string | null;
  createdByUsername: string | null;
  revision: number;
  cancelledAt: string | null;
  cancelReason: string | null;
  createdAt: string;
  updatedAt: string;
};

export type FeaturePlanTaskRecord = {
  id: number;
  featurePlanId: number;
  taskId: number;
  taskText: string;
  taskStatus: TaskStatus;
  position: number;
  createdAt: string;
};

export type FeaturePlanDetails = {
  plan: FeaturePlanRecord;
  tasks: FeaturePlanTaskRecord[];
};

export type FeaturePlanWriteResult = FeaturePlanDetails & {
  applied: boolean;
};

export type FeaturePlanInput = {
  projectKey: string;
  objective: string;
  acceptanceCriteria: string[];
  taskIds: number[];
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
      status, decision_note, created_at, decided_at
    )
    VALUES (
      @category, @title, @rationale, @proposedChange, @evidenceJson, @risk, @source,
      'candidate', NULL, @now, NULL
    )
  `);
  const decideImprovementProposalStatement = db.prepare(`
    UPDATE improvement_proposals
    SET status = @status,
        decision_note = @decisionNote,
        decided_at = @now
    WHERE id = @id AND status = 'candidate'
  `);
  const updateTaskStatusStatement = db.prepare(`
    UPDATE tasks SET status = @status, updated_at = @now WHERE id = @id
  `);
  const deleteTaskStatement = db.prepare("DELETE FROM tasks WHERE id = ?");
  const createGoalRunStatement = db.prepare(`
    INSERT INTO goal_runs (
      task_id, status, current_phase, step_count, max_steps, last_error,
      created_at, updated_at, finished_at
    )
    VALUES (@taskId, 'running', 'planning', 0, @maxSteps, NULL, @now, @now, NULL)
  `);
  const updateGoalRunStatement = db.prepare(`
    UPDATE goal_runs
    SET status = @status,
        current_phase = @currentPhase,
        step_count = @stepCount,
        last_error = @lastError,
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
      project_id, objective, acceptance_criteria_json, status, source,
      created_by_user_id, created_by_username, revision,
      cancelled_at, cancel_reason, created_at, updated_at
    )
    VALUES (
      @projectId, @objective, @acceptanceCriteriaJson, 'planned', @source,
      @createdByUserId, @createdByUsername, 1,
      NULL, NULL, @now, @now
    )
  `);
  const addFeaturePlanTaskStatement = db.prepare(`
    INSERT INTO feature_plan_tasks (feature_plan_id, task_id, position, created_at)
    VALUES (@featurePlanId, @taskId, @position, @now)
  `);
  const cancelFeaturePlanStatement = db.prepare(`
    UPDATE feature_plans
    SET status = 'cancelled',
        cancelled_at = @now,
        cancel_reason = @cancelReason,
        updated_at = @now
    WHERE id = @id AND status = 'planned'
  `);
  const replanFeaturePlanStatement = db.prepare(`
    UPDATE feature_plans
    SET objective = @objective,
        acceptance_criteria_json = @acceptanceCriteriaJson,
        revision = revision + 1,
        updated_at = @now
    WHERE id = @id AND status = 'planned'
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

  return {
    close: () => db.close(),

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
      updateTaskWorktreeStatement.run({ ...input, now });
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
      const result = addImprovementProposalStatement.run({
        ...proposal,
        evidenceJson: JSON.stringify(proposal.evidence),
        now: new Date().toISOString()
      });
      return this.getImprovementProposal(Number(result.lastInsertRowid));
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
        decisionNote: decisionNote?.trim() || null,
        now: new Date().toISOString()
      });
      if (result.changes === 0) {
        throw new Error(`Improvement proposal ${id} is no longer awaiting a decision.`);
      }
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

    updateGoalRun(input: {
      id: number;
      status: GoalRunStatus;
      currentPhase: GoalPhase;
      stepCount: number;
      lastError?: string | null;
    }): GoalRunRecord {
      this.getGoalRun(input.id);
      const now = new Date().toISOString();
      updateGoalRunStatement.run({
        ...input,
        lastError: input.lastError ?? null,
        now,
        finishedAt: ["running", "waiting_provider"].includes(input.status) ? null : now
      });
      return this.getGoalRun(input.id);
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
      const requestHash = hashFeaturePlanOperation("create", {
        projectId: project.id,
        objective: normalized.objective,
        acceptanceCriteria: normalized.acceptanceCriteria,
        taskIds: normalized.taskIds
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
          source: normalized.source,
          createdByUserId: normalized.createdByUserId,
          createdByUsername: normalized.createdByUsername,
          now
        });
        const featurePlanId = Number(result.lastInsertRowid);
        insertFeaturePlanTasks(addFeaturePlanTaskStatement, featurePlanId, normalized.taskIds, now);
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
      return rows.map(mapFeaturePlanTask);
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
      assertFeaturePlanIntegrationNotStarted(db, id);
      const result = cancelFeaturePlanStatement.run({
        id,
        cancelReason: reason?.trim() || null,
        now: new Date().toISOString()
      });
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
        idempotencyKey: input.idempotencyKey
      });
      const requestHash = hashFeaturePlanOperation("replan", {
        featurePlanId: plan.id,
        objective: normalized.objective,
        acceptanceCriteria: normalized.acceptanceCriteria,
        taskIds: normalized.taskIds
      });
      const existingOperation = normalized.idempotencyKey
        ? findFeaturePlanOperation(db, normalized.idempotencyKey)
        : null;
      if (existingOperation) {
        validateFeaturePlanOperationReuse(existingOperation, "replan", requestHash, plan.id);
        return { ...this.getFeaturePlanDetails(existingOperation.feature_plan_id), applied: false };
      }
      if (plan.status !== "planned") {
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
        insertFeaturePlanTasks(addFeaturePlanTaskStatement, plan.id, normalized.taskIds, now);
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
      status TEXT NOT NULL DEFAULT 'candidate',
      decision_note TEXT,
      created_at TEXT NOT NULL,
      decided_at TEXT
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
      status TEXT NOT NULL DEFAULT 'planned',
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

    CREATE TABLE IF NOT EXISTS feature_plan_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      feature_plan_id INTEGER NOT NULL,
      task_id INTEGER NOT NULL,
      position INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(feature_plan_id, task_id),
      FOREIGN KEY (feature_plan_id) REFERENCES feature_plans(id),
      FOREIGN KEY (task_id) REFERENCES tasks(id)
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

    CREATE INDEX IF NOT EXISTS idx_feature_plan_tasks_task_id
      ON feature_plan_tasks(task_id);
    CREATE INDEX IF NOT EXISTS idx_feature_plan_operations_plan_id
      ON feature_plan_operations(feature_plan_id);
    CREATE INDEX IF NOT EXISTS idx_feature_plan_integrations_plan_id
      ON feature_plan_integrations(feature_plan_id);
    CREATE INDEX IF NOT EXISTS idx_feature_plan_integration_items_integration_id
      ON feature_plan_integration_items(integration_id);
    CREATE INDEX IF NOT EXISTS idx_feature_plan_integration_items_task_id
      ON feature_plan_integration_items(task_id);
  `);

  addColumnIfMissing(db, "tasks", "project_id", "INTEGER REFERENCES projects(id)");
  addColumnIfMissing(db, "tasks", "branch_name", "TEXT");
  addColumnIfMissing(db, "tasks", "worktree_path", "TEXT");
  addColumnIfMissing(db, "goal_runs", "commit_sha", "TEXT");
  addColumnIfMissing(db, "goal_runs", "pull_request_url", "TEXT");
  addColumnIfMissing(db, "feature_plans", "revision", "INTEGER NOT NULL DEFAULT 1");
  addColumnIfMissing(db, "feature_plans", "cancel_reason", "TEXT");
  addColumnIfMissing(db, "features", "feature_plan_id", "INTEGER REFERENCES feature_plans(id)");
  addColumnIfMissing(db, "features", "cancelled_at", "TEXT");
  addColumnIfMissing(db, "features", "cancel_reason", "TEXT");
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_features_feature_plan_id
      ON features(feature_plan_id) WHERE feature_plan_id IS NOT NULL;
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
  status: ImprovementStatus;
  decision_note: string | null;
  created_at: string;
  decided_at: string | null;
};

type GoalRunRow = {
  id: number;
  task_id: number;
  status: GoalRunStatus;
  current_phase: GoalPhase;
  step_count: number;
  max_steps: number;
  last_error: string | null;
  commit_sha: string | null;
  pull_request_url: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
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
  source: string;
  created_by_user_id: string | null;
  created_by_username: string | null;
  revision: number;
  cancelled_at: string | null;
  cancel_reason: string | null;
  created_at: string;
  updated_at: string;
};

type FeaturePlanTaskRow = {
  id: number;
  feature_plan_id: number;
  task_id: number;
  task_text: string;
  task_status: TaskStatus;
  position: number;
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

function normalizeImprovementProposal(input: ImprovementProposalInput): ImprovementProposalInput & { source: string } {
  const category = input.category;
  const risk = input.risk;
  if (!["skill", "memory", "routing", "policy", "integration"].includes(category)) {
    throw new Error(`Unsupported improvement category: ${category}`);
  }
  if (!["low", "medium", "high"].includes(risk)) {
    throw new Error(`Unsupported improvement risk: ${risk}`);
  }

  const title = input.title.trim();
  const rationale = input.rationale.trim();
  const proposedChange = input.proposedChange.trim();
  const evidence = input.evidence.map((item) => item.trim()).filter(Boolean);
  if (title.length < 4 || rationale.length < 8 || proposedChange.length < 8 || evidence.length === 0) {
    throw new Error("Improvement proposals require a title, rationale, proposed change and evidence.");
  }

  return {
    category,
    title,
    rationale,
    proposedChange,
    evidence,
    risk,
    source: input.source?.trim() || "dashboard"
  };
}

function normalizeFeaturePlanInput(input: FeaturePlanInput): Required<FeaturePlanInput> {
  const projectKey = input.projectKey.trim().toLowerCase();
  if (!projectKey) throw new Error("Feature plan project is required.");

  const objective = input.objective.trim();
  const acceptanceCriteria = input.acceptanceCriteria
    .map((item) => item.trim())
    .filter(Boolean);
  const taskIds = uniqueTaskIds(input.taskIds);
  const source = input.source?.trim() || "dashboard";
  const idempotencyKey = input.idempotencyKey?.trim() || null;

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
    source,
    createdByUserId: input.createdByUserId?.trim() || null,
    createdByUsername: input.createdByUsername?.trim() || null,
    idempotencyKey
  };
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
        AND feature_plans.status = 'planned'
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
  now: string
): void {
  taskIds.forEach((taskId, index) => {
    statement.run({ featurePlanId, taskId, position: index + 1, now });
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
    status: row.status,
    decisionNote: row.decision_note,
    createdAt: row.created_at,
    decidedAt: row.decided_at
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
    commitSha: row.commit_sha,
    pullRequestUrl: row.pull_request_url,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at
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

function mapFeaturePlan(row: FeaturePlanRow): FeaturePlanRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    projectKey: row.project_key,
    projectName: row.project_name,
    objective: row.objective,
    acceptanceCriteria: parseStringArrayJson(row.acceptance_criteria_json),
    status: row.status,
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

function mapFeaturePlanTask(row: FeaturePlanTaskRow): FeaturePlanTaskRecord {
  return {
    id: row.id,
    featurePlanId: row.feature_plan_id,
    taskId: row.task_id,
    taskText: row.task_text,
    taskStatus: row.task_status,
    position: row.position,
    createdAt: row.created_at
  };
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
