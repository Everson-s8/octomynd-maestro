import Database from "better-sqlite3";
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
  | "failed";

export type FeatureRecord = {
  id: number;
  projectId: number;
  projectKey: string;
  projectName: string;
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
  name: string;
  objective: string;
  branchName: string;
  worktreePath: string;
  pullRequestUrl: string;
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
      project_id, name, objective, status, branch_name, worktree_path,
      pull_request_url, reviewer_provider, review_summary, reviewed_head_sha,
      last_error, merged_at, created_at, updated_at
    )
    VALUES (
      @projectId, @name, @objective, 'draft', @branchName, @worktreePath,
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
  const addFeatureItemStatement = db.prepare(`
    INSERT INTO feature_items (
      feature_id, task_id, pull_request_url, branch_name, status, created_at, updated_at
    )
    VALUES (@featureId, @taskId, @pullRequestUrl, @branchName, 'included', @now, @now)
  `);
  const updateFeatureItemStatusStatement = db.prepare(`
    UPDATE feature_items SET status = @status, updated_at = @now WHERE id = @id
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
      if (!name || !objective || !branchName || !pullRequestUrl) {
        throw new Error("Feature requires name, objective, branch, worktree and pull request.");
      }
      const existing = this.findFeatureByPullRequestUrl(pullRequestUrl);
      if (existing) return existing;
      const now = new Date().toISOString();
      const result = createFeatureStatement.run({
        projectId: project.id,
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
  `);

  addColumnIfMissing(db, "tasks", "project_id", "INTEGER REFERENCES projects(id)");
  addColumnIfMissing(db, "tasks", "branch_name", "TEXT");
  addColumnIfMissing(db, "tasks", "worktree_path", "TEXT");
  addColumnIfMissing(db, "goal_runs", "commit_sha", "TEXT");
  addColumnIfMissing(db, "goal_runs", "pull_request_url", "TEXT");
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
