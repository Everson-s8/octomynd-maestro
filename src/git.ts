import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ProjectRecord, TaskRecord } from "./db.js";

export type WorktreePlan = {
  branchName: string;
  worktreePath: string;
  baseRef?: string;
  baseBranch?: string;
};

export type GitCommandResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
};

export function createWorktreePlan(
  project: ProjectRecord,
  task: TaskRecord,
  worktreesRoot: string,
  base?: { baseRef: string; baseBranch: string }
): WorktreePlan {
  return {
    branchName: `maestro/task-${task.id}-${slugify(task.text)}`,
    worktreePath: path.join(worktreesRoot, project.key, `task-${task.id}`),
    ...(base ?? {})
  };
}

export function validateGitProject(project: ProjectRecord): string[] {
  const errors: string[] = [];

  if (!fs.existsSync(project.path)) {
    errors.push(`Project path does not exist: ${project.path}`);
    return errors;
  }

  if (!fs.existsSync(path.join(project.path, ".git"))) {
    errors.push(`Project is not a Git repository: ${project.path}`);
  }

  const status = runGit(["status", "--porcelain"], project.path);
  if (!status.ok) {
    errors.push(`Cannot read Git status: ${status.stderr || status.stdout}`);
  } else if (status.stdout.trim()) {
    errors.push("Project Git working tree is dirty. Commit, stash or clean it before preparing a Maestro task.");
  }

  return errors;
}

export function createGitWorktree(project: ProjectRecord, plan: WorktreePlan): GitCommandResult {
  fs.mkdirSync(path.dirname(plan.worktreePath), { recursive: true });

  if (fs.existsSync(plan.worktreePath)) {
    return {
      ok: false,
      stdout: "",
      stderr: `Worktree path already exists: ${plan.worktreePath}`,
      exitCode: 1
    };
  }

  return runGit([
    "worktree",
    "add",
    "-b",
    plan.branchName,
    plan.worktreePath,
    plan.baseRef ?? project.defaultBranch
  ], project.path);
}

export function runGit(args: string[], cwd: string): GitCommandResult {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true
  });

  return {
    ok: result.status === 0,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    exitCode: result.status
  };
}

function slugify(text: string): string {
  const slug = text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");

  return slug || "task";
}
