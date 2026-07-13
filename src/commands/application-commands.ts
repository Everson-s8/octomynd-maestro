import fs from "node:fs";
import path from "node:path";
import {
  FeaturePlanIntegrationDetails,
  FeaturePlanDetails,
  FeaturePlanWriteResult,
  FeatureRecord,
  MaestroDatabase,
  ProjectRecord,
  TaskRecord
} from "../db.js";
import { FeatureGitHubGateway, GhFeatureGateway } from "../features/github.js";
import { FeatureIntegrationBuilder, WorkPullRequestGateway } from "../features/integration.js";
import { createGitWorktree, createWorktreePlan, validateGitProject } from "../git.js";
import { redactSensitiveText } from "../security/redaction.js";
import { conflictError, notFoundError, validationError } from "./errors.js";
import { CommandOrigin } from "./types.js";

export type RegisterProjectInput = {
  key: string;
  path: string;
  name?: string;
  defaultBranch?: string;
};

export type RegisterProjectOutcome = {
  project: ProjectRecord;
  warnings: string[];
};

export type CreateTaskInput = {
  text: string;
  projectKey?: string | null;
};

export type CreateFeaturePlanInput = {
  projectKey: string;
  objective: string;
  acceptanceCriteria: string[];
  taskIds: number[];
  idempotencyKey?: string | null;
};

export type ReplanFeaturePlanInput = {
  objective: string;
  acceptanceCriteria: string[];
  taskIds: number[];
  idempotencyKey?: string | null;
};

export type PrepareTaskOutcome = {
  task: TaskRecord;
  branchName: string;
  worktreePath: string;
};

export class ApplicationCommands {
  constructor(
    private readonly database: MaestroDatabase,
    private readonly featureGithub: FeatureGitHubGateway = new GhFeatureGateway()
  ) {}

  registerProject(origin: CommandOrigin, input: RegisterProjectInput): RegisterProjectOutcome {
    const warnings: string[] = [];
    const projectPath = path.resolve(input.path.trim());

    if (!fs.existsSync(projectPath)) {
      throw validationError(`Path does not exist: ${projectPath}`);
    }
    if (!fs.statSync(projectPath).isDirectory()) {
      throw validationError(`Path is not a directory: ${projectPath}`);
    }
    if (!fs.existsSync(path.join(projectPath, ".git"))) {
      warnings.push("Path exists, but .git was not found. Future Git automation will be blocked.");
    }

    let project: ProjectRecord;
    try {
      project = this.database.registerProject({
        key: input.key,
        name: input.name,
        path: projectPath,
        defaultBranch: input.defaultBranch
      });
    } catch (error) {
      throw validationError(error instanceof Error ? error.message : "Unknown project error.");
    }

    this.database.addEvent({
      source: origin.channel,
      type: "project.registered",
      text: project.key,
      userId: origin.userId ?? null,
      username: origin.username ?? null,
      metadata: { projectKey: project.key, defaultBranch: project.defaultBranch, warnings }
    });

    return { project, warnings };
  }

  createTask(origin: CommandOrigin, input: CreateTaskInput): TaskRecord {
    const text = input.text.trim();
    if (!text) {
      throw validationError("Task text is required.");
    }

    const projectKey = input.projectKey?.trim().toLowerCase() || null;
    const project = projectKey ? this.database.findProjectByKey(projectKey) : this.database.getDefaultProject();

    if (projectKey && !project) {
      throw notFoundError(`Project not found: ${projectKey}`);
    }
    if (!project) {
      throw notFoundError("No project registered.");
    }

    const task = this.database.createTask(text, origin.channel, project.key);

    this.database.addEvent({
      source: origin.channel,
      type: "task.created",
      text,
      userId: origin.userId ?? null,
      username: origin.username ?? null,
      taskId: task.id,
      metadata: { projectKey: project.key }
    });

    return task;
  }

  createFeaturePlan(origin: CommandOrigin, input: CreateFeaturePlanInput): FeaturePlanWriteResult {
    try {
      const result = this.database.createFeaturePlan({
        projectKey: input.projectKey,
        objective: input.objective,
        acceptanceCriteria: input.acceptanceCriteria,
        taskIds: input.taskIds,
        idempotencyKey: input.idempotencyKey,
        source: origin.channel,
        createdByUserId: origin.userId ?? null,
        createdByUsername: origin.username ?? null
      });

      if (result.applied) {
        this.database.addEvent({
          source: origin.channel,
          type: "feature_plan.created",
          text: result.plan.objective,
          userId: origin.userId ?? null,
          username: origin.username ?? null,
          metadata: {
            featurePlanId: result.plan.id,
            projectKey: result.plan.projectKey,
            taskIds: result.tasks.map((task) => task.taskId),
            acceptanceCriteriaCount: result.plan.acceptanceCriteria.length,
            revision: result.plan.revision
          }
        });
      }

      return result;
    } catch (error) {
      throw this.toFeaturePlanCommandError(error);
    }
  }

  getFeaturePlan(featurePlanId: number): FeaturePlanDetails {
    try {
      return this.database.getFeaturePlanDetails(featurePlanId);
    } catch (error) {
      throw notFoundError(error instanceof Error ? error.message : `Feature plan not found: ${featurePlanId}`);
    }
  }

  listFeaturePlans(projectKey?: string | null, limit = 30): FeaturePlanDetails[] {
    const plans = projectKey?.trim()
      ? this.database.listFeaturePlansByProject(projectKey.trim().toLowerCase(), limit)
      : this.database.listFeaturePlans(limit);
    return plans.map((plan) => this.database.getFeaturePlanDetails(plan.id));
  }

  async integrateFeaturePlan(
    _origin: CommandOrigin,
    featurePlanId: number,
    worktreesRoot: string,
    github?: WorkPullRequestGateway
  ): Promise<FeaturePlanIntegrationDetails> {
    try {
      return await new FeatureIntegrationBuilder(this.database, worktreesRoot, github).build(featurePlanId);
    } catch (error) {
      throw this.toFeaturePlanCommandError(error);
    }
  }

  cancelFeaturePlan(origin: CommandOrigin, featurePlanId: number, reason?: string | null): FeaturePlanWriteResult {
    try {
      const result = this.database.cancelFeaturePlan(featurePlanId, reason);
      if (result.applied) {
        this.database.addEvent({
          source: origin.channel,
          type: "feature_plan.cancelled",
          text: result.plan.cancelReason || `Feature Plan #${result.plan.id} cancelled.`,
          userId: origin.userId ?? null,
          username: origin.username ?? null,
          metadata: {
            featurePlanId: result.plan.id,
            projectKey: result.plan.projectKey,
            taskIds: result.tasks.map((task) => task.taskId),
            revision: result.plan.revision
          }
        });
      }
      return result;
    } catch (error) {
      throw this.toFeaturePlanCommandError(error);
    }
  }

  async cancelFeature(origin: CommandOrigin, featureId: number, reason?: string | null): Promise<FeatureRecord> {
    try {
      const before = this.database.getFeature(featureId);
      if (before.status === "cancelled") return before;
      if (["completed", "merging"].includes(before.status)) {
        throw new Error(`Feature #${featureId} cannot be cancelled from status ${before.status}.`);
      }
      const pullRequest = await this.featureGithub.inspect(before.pullRequestUrl);
      if (pullRequest.state === "MERGED") {
        throw new Error(`Feature #${featureId} cannot be cancelled because its pull request is already merged.`);
      }
      const feature = this.database.cancelFeature(featureId, reason);
      if (pullRequest.state === "OPEN") {
        try {
          await this.featureGithub.close(
            before.pullRequestUrl,
            `Feature #${featureId} cancelled before merge. History preserved for audit.`
          );
        } catch (error) {
          this.database.addEvent({
            source: origin.channel,
            type: "feature.cancel_close_failed",
            text: redactSensitiveText(
              error instanceof Error ? error.message : "Unknown GitHub close error."
            ),
            userId: origin.userId ?? null,
            username: origin.username ?? null,
            metadata: { featureId: feature.id, pullRequestUrl: feature.pullRequestUrl }
          });
        }
      }
      this.database.addEvent({
        source: origin.channel,
        type: "feature.cancelled",
        text: feature.cancelReason || `Feature #${feature.id} cancelled before merge.`,
        userId: origin.userId ?? null,
        username: origin.username ?? null,
        metadata: {
          featureId: feature.id,
          featurePlanId: feature.featurePlanId,
          projectKey: feature.projectKey,
          previousStatus: before.status,
          pullRequestUrl: feature.pullRequestUrl
        }
      });
      return feature;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown feature cancellation error.";
      if (/not found/i.test(message)) throw notFoundError(message);
      if (/cannot be cancelled|already merged/i.test(message)) throw conflictError(message);
      throw validationError(message);
    }
  }

  replanFeaturePlan(
    origin: CommandOrigin,
    featurePlanId: number,
    input: ReplanFeaturePlanInput
  ): FeaturePlanWriteResult {
    let before: FeaturePlanDetails | null = null;
    try {
      before = this.database.getFeaturePlanDetails(featurePlanId);
      const result = this.database.replanFeaturePlan({
        id: featurePlanId,
        objective: input.objective,
        acceptanceCriteria: input.acceptanceCriteria,
        taskIds: input.taskIds,
        idempotencyKey: input.idempotencyKey
      });
      if (result.applied) {
        this.database.addEvent({
          source: origin.channel,
          type: "feature_plan.replanned",
          text: result.plan.objective,
          userId: origin.userId ?? null,
          username: origin.username ?? null,
          metadata: {
            featurePlanId: result.plan.id,
            projectKey: result.plan.projectKey,
            previousRevision: before.plan.revision,
            revision: result.plan.revision,
            previousTaskIds: before.tasks.map((task) => task.taskId),
            taskIds: result.tasks.map((task) => task.taskId),
            acceptanceCriteriaCount: result.plan.acceptanceCriteria.length
          }
        });
      }
      return result;
    } catch (error) {
      throw this.toFeaturePlanCommandError(error);
    }
  }

  prepareTask(origin: CommandOrigin, taskId: number, worktreesRoot: string): PrepareTaskOutcome {
    let task: TaskRecord;
    try {
      task = this.database.getTask(taskId);
    } catch (error) {
      throw notFoundError(error instanceof Error ? error.message : `Task not found: ${taskId}`);
    }

    if (!task.projectKey) {
      const failure = validationError(`Task #${task.id} has no project.`);
      this.recordPrepareFailure(origin, task.id, failure.details);
      throw failure;
    }

    if (task.branchName || task.worktreePath) {
      const failure = conflictError(`Task #${task.id} already has a worktree.`);
      this.recordPrepareFailure(origin, task.id, failure.details);
      throw failure;
    }

    const project = this.database.getProjectByKey(task.projectKey);
    const validationErrors = validateGitProject(project);
    if (validationErrors.length > 0) {
      const failure = validationError(validationErrors.join("\n"), validationErrors);
      this.recordPrepareFailure(origin, task.id, failure.details);
      throw failure;
    }

    const plan = createWorktreePlan(project, task, worktreesRoot);
    const result = createGitWorktree(project, plan);
    if (!result.ok) {
      const failure = conflictError(result.stderr || result.stdout || "git worktree failed.");
      this.recordPrepareFailure(origin, task.id, failure.details);
      throw failure;
    }

    const updatedTask = this.database.updateTaskWorktree({
      id: task.id,
      status: "planning",
      branchName: plan.branchName,
      worktreePath: plan.worktreePath
    });

    this.database.addEvent({
      source: origin.channel,
      type: "task.prepared",
      text: plan.branchName,
      userId: origin.userId ?? null,
      username: origin.username ?? null,
      taskId: updatedTask.id,
      metadata: { branchName: plan.branchName, worktreePath: plan.worktreePath }
    });

    return { task: updatedTask, branchName: plan.branchName, worktreePath: plan.worktreePath };
  }

  private recordPrepareFailure(origin: CommandOrigin, taskId: number, errors: string[]) {
    this.database.addEvent({
      source: origin.channel,
      type: "task.prepare_failed",
      text: errors.join("\n"),
      userId: origin.userId ?? null,
      username: origin.username ?? null,
      taskId
    });
  }

  private toFeaturePlanCommandError(error: unknown): never {
    const message = error instanceof Error ? error.message : "Unknown feature plan error.";
    if (/not found/i.test(message)) throw notFoundError(message);
    if (/already associated|already used|cannot be|cancelled|conflict|dirty|cherry-pick|secret guard|diff whitespace|checkpoint|changed after/i.test(message)) {
      throw conflictError(message);
    }
    throw validationError(message);
  }
}
