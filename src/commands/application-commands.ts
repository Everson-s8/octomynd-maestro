import fs from "node:fs";
import path from "node:path";
import { MaestroDatabase, ProjectRecord, TaskRecord } from "../db.js";
import { createGitWorktree, createWorktreePlan, validateGitProject } from "../git.js";
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

export type PrepareTaskOutcome = {
  task: TaskRecord;
  branchName: string;
  worktreePath: string;
};

export class ApplicationCommands {
  constructor(private readonly database: MaestroDatabase) {}

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
}
