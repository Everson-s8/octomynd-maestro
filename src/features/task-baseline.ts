import fs from "node:fs";
import path from "node:path";
import type { MaestroDatabase, ProjectRecord, TaskRecord } from "../db.js";
import { runGit } from "../git.js";
import { transitiveDependencyIds } from "./task-graph.js";

export type FeatureTaskBaseline = {
  baseRef: string;
  baseBranch: string;
  dependencyTaskIds: number[];
};

export function prepareFeatureTaskBaseline(
  database: MaestroDatabase,
  task: TaskRecord,
  project: ProjectRecord,
  worktreesRoot: string,
  canonicalBase?: { baseRef: string; baseBranch: string }
): FeatureTaskBaseline {
  const details = database.findFeaturePlanDetailsByTask(task.id);
  if (!details) return defaultBaseline(project, canonicalBase);
  const dependencyTaskIds = transitiveDependencyIds(details.tasks, task.id);
  if (dependencyTaskIds.length === 0) return defaultBaseline(project, canonicalBase);

  const commits = dependencyTaskIds.map((dependencyTaskId) => {
    const dependency = database.getTask(dependencyTaskId);
    if (!["awaiting_human", "ready_to_merge", "done"].includes(dependency.status)) {
      throw new Error(`Task #${task.id} dependency #${dependencyTaskId} is not delivered and validated.`);
    }
    const run = database.findLatestCompletedGoalRunForTask(dependencyTaskId);
    if (!run?.commitSha || !/^[a-f0-9]{40}$/i.test(run.commitSha)) {
      throw new Error(`Task #${task.id} dependency #${dependencyTaskId} has no exact delivery commit.`);
    }
    if (!dependency.branchName) {
      throw new Error(`Task #${task.id} dependency #${dependencyTaskId} has no delivery branch.`);
    }
    return { taskId: dependencyTaskId, commitSha: run.commitSha, branchName: dependency.branchName };
  });

  const baseBranch = `maestro/feature-plan-${details.plan.id}-task-${task.id}-base-r${details.plan.revision}`;
  const baselineRoot = path.resolve(worktreesRoot, project.key, "feature-task-bases");
  const baselinePath = path.resolve(baselineRoot, `task-${task.id}`);
  assertManagedPath(baselineRoot, baselinePath);

  const canonicalRef = canonicalBase?.baseRef ?? `origin/${project.defaultBranch}`;
  requireGit(runGit(["fetch", "origin", project.defaultBranch], project.path), `fetch origin/${project.defaultBranch}`);
  const remoteExists = runGit(["ls-remote", "--exit-code", "--heads", "origin", baseBranch], project.path).ok;
  if (remoteExists) {
    requireGit(runGit(["fetch", "origin", baseBranch], project.path), `fetch ${baseBranch}`);
    const isUpToDate = runGit(
      ["merge-base", "--is-ancestor", canonicalRef, `origin/${baseBranch}`],
      project.path
    ).ok;
    if (isUpToDate) {
      validateBaselineEvidence(project.path, `origin/${baseBranch}`, commits);
      return { baseRef: `origin/${baseBranch}`, baseBranch, dependencyTaskIds };
    }
    runGit(["push", "origin", "--delete", baseBranch], project.path);
    runGit(["branch", "-D", baseBranch], project.path);
  }

  if (fs.existsSync(baselinePath)) {
    runGit(["worktree", "remove", "--force", baselinePath], project.path);
    if (fs.existsSync(baselinePath)) {
      fs.rmSync(baselinePath, { recursive: true, force: true });
    }
  }
  fs.mkdirSync(path.dirname(baselinePath), { recursive: true });
  requireGit(
    runGit(["worktree", "add", "-b", baseBranch, baselinePath, canonicalRef], project.path),
    `create Feature baseline for Task #${task.id}`
  );
  try {
    for (const commit of commits) {
      ensureCommitAvailable(project, baselinePath, commit);
      requireGit(
        runGit(["cherry-pick", "-x", commit.commitSha], baselinePath),
        `integrate dependency Task #${commit.taskId} into Task #${task.id} baseline`
      );
    }
    requireGit(runGit(["push", "-u", "origin", baseBranch], baselinePath), `publish ${baseBranch}`);
  } catch (error) {
    runGit(["cherry-pick", "--abort"], baselinePath);
    throw error;
  } finally {
    const status = runGit(["status", "--porcelain"], baselinePath);
    if (status.ok && !status.stdout.trim()) {
      runGit(["worktree", "remove", baselinePath], project.path);
      runGit(["branch", "-D", baseBranch], project.path);
    }
  }

  requireGit(runGit(["fetch", "origin", baseBranch], project.path), `refresh ${baseBranch}`);
  validateBaselineEvidence(project.path, `origin/${baseBranch}`, commits);
  return { baseRef: `origin/${baseBranch}`, baseBranch, dependencyTaskIds };
}

function defaultBaseline(
  project: ProjectRecord,
  canonicalBase?: { baseRef: string; baseBranch: string }
): FeatureTaskBaseline {
  return {
    baseRef: canonicalBase?.baseRef ?? project.defaultBranch,
    baseBranch: canonicalBase?.baseBranch ?? project.defaultBranch,
    dependencyTaskIds: []
  };
}

function ensureCommitAvailable(
  project: ProjectRecord,
  worktreePath: string,
  commit: { taskId: number; commitSha: string; branchName: string }
): void {
  if (runGit(["cat-file", "-e", `${commit.commitSha}^{commit}`], worktreePath).ok) return;
  requireGit(
    runGit(["fetch", "origin", commit.branchName], project.path),
    `fetch dependency branch for Task #${commit.taskId}`
  );
  if (!runGit(["cat-file", "-e", `${commit.commitSha}^{commit}`], worktreePath).ok) {
    throw new Error(`Dependency commit ${commit.commitSha.slice(0, 8)} for Task #${commit.taskId} is unavailable.`);
  }
}

function validateBaselineEvidence(
  cwd: string,
  ref: string,
  commits: Array<{ taskId: number; commitSha: string }>
): void {
  const log = requireGit(runGit(["log", "--format=%B", ref], cwd), `inspect ${ref}`).stdout.toLowerCase();
  for (const commit of commits) {
    if (!log.includes(commit.commitSha.toLowerCase())) {
      throw new Error(
        `Existing Feature baseline ${ref} does not contain dependency Task #${commit.taskId} checkpoint.`
      );
    }
  }
}

function assertManagedPath(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Feature baseline path escapes managed worktrees root: ${candidate}`);
  }
}

function requireGit(result: ReturnType<typeof runGit>, operation: string) {
  if (!result.ok) throw new Error(`Cannot ${operation}: ${result.stderr || result.stdout}`);
  return result;
}
