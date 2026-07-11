import fs from "node:fs";
import path from "node:path";
import { MaestroDatabase, ProjectRecord, TaskRecord } from "./db.js";
import { createGitWorktree, createWorktreePlan, validateGitProject } from "./git.js";

export type RegisterProjectResult =
  | { ok: true; project: ProjectRecord; warnings: string[] }
  | { ok: false; errors: string[] };

export type PrepareTaskResult =
  | { ok: true; task: TaskRecord; branchName: string; worktreePath: string }
  | { ok: false; errors: string[] };

export function registerProject(
  database: MaestroDatabase,
  input: { key: string; path: string; name?: string; defaultBranch?: string }
): RegisterProjectResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const projectPath = path.resolve(input.path.trim());

  if (!fs.existsSync(projectPath)) {
    errors.push(`Path does not exist: ${projectPath}`);
  } else if (!fs.statSync(projectPath).isDirectory()) {
    errors.push(`Path is not a directory: ${projectPath}`);
  } else if (!fs.existsSync(path.join(projectPath, ".git"))) {
    warnings.push("Path exists, but .git was not found. Future Git automation will be blocked.");
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  try {
    const project = database.registerProject({
      key: input.key,
      name: input.name,
      path: projectPath,
      defaultBranch: input.defaultBranch
    });
    return { ok: true, project, warnings };
  } catch (error) {
    return { ok: false, errors: [error instanceof Error ? error.message : "Unknown project error."] };
  }
}

export function createProjectTask(database: MaestroDatabase, text: string, projectKey?: string | null): TaskRecord {
  return database.createTask(text, "telegram", projectKey);
}

export function prepareTask(database: MaestroDatabase, taskId: number, worktreesRoot: string): PrepareTaskResult {
  let task: TaskRecord;

  try {
    task = database.getTask(taskId);
  } catch (error) {
    return { ok: false, errors: [error instanceof Error ? error.message : "Task not found."] };
  }

  if (!task.projectKey) {
    return { ok: false, errors: [`Task #${task.id} has no project.`] };
  }

  if (task.branchName || task.worktreePath) {
    return {
      ok: false,
      errors: [`Task #${task.id} already has a worktree.`]
    };
  }

  const project = database.getProjectByKey(task.projectKey);
  const validationErrors = validateGitProject(project);
  if (validationErrors.length > 0) {
    return { ok: false, errors: validationErrors };
  }

  const plan = createWorktreePlan(project, task, worktreesRoot);
  const result = createGitWorktree(project, plan);
  if (!result.ok) {
    return { ok: false, errors: [result.stderr || result.stdout || "git worktree failed."] };
  }

  const updatedTask = database.updateTaskWorktree({
    id: task.id,
    status: "planning",
    branchName: plan.branchName,
    worktreePath: plan.worktreePath
  });

  return {
    ok: true,
    task: updatedTask,
    branchName: plan.branchName,
    worktreePath: plan.worktreePath
  };
}

export function parseProjectTaskInput(input: string): { projectKey: string | null; text: string } {
  const trimmed = input.trim();
  const match = trimmed.match(/^@([a-z0-9][a-z0-9_-]{1,48})\s+(.+)$/i);

  if (!match) {
    return { projectKey: null, text: trimmed };
  }

  return {
    projectKey: match[1].toLowerCase(),
    text: match[2].trim()
  };
}
