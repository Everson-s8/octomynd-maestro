import { spawnSync } from "node:child_process";
import path from "node:path";
import { GoalRunRecord, ProjectRecord, TaskRecord } from "../db.js";
import { GitCommandResult, runGit } from "../git.js";
import { formatSecretScanFinding, scanWorktreePathsForSecrets } from "../security/secrets.js";

export type GoalDeliveryResult = {
  commitSha: string;
  pullRequestUrl: string;
  branchName: string;
};

export type GoalDeliveryHandler = (
  task: TaskRecord,
  project: ProjectRecord,
  run: GoalRunRecord
) => Promise<GoalDeliveryResult>;

export type GoalPublisher = (
  task: TaskRecord,
  project: ProjectRecord,
  commitSha: string
) => Promise<string>;

export const deliverGoalToDraftPullRequest = createGoalDeliveryHandler();

export function createGoalDeliveryHandler(
  publisher: GoalPublisher = publishGoalBranch
): GoalDeliveryHandler {
  return async (task, project, run) => {
    if (!task.worktreePath || !task.branchName) {
      throw new Error(`Task #${task.id} has no prepared worktree or branch.`);
    }

    const message = `Task #${task.id}: ${singleLine(task.text).slice(0, 120)}`;
    const changedFiles = listChangedFiles(task.worktreePath);
    if (changedFiles.length > 0) {
      const secretFindings = scanGoalChangesForSecrets(task.worktreePath, changedFiles);
      if (secretFindings.length > 0) {
        throw new Error(`Secret guard blocked delivery: ${secretFindings.join(", ")}`);
      }

      requireGit(runGitSafe(["add", "--all"], task.worktreePath), "stage goal changes");
      requireGit(runGitSafe(["diff", "--cached", "--check"], task.worktreePath), "validate staged diff");
      const staged = runGitSafe(["diff", "--cached", "--quiet"], task.worktreePath);
      if (staged.exitCode === 0) {
        throw new Error(`Goal #${run.id} has no staged changes to deliver.`);
      }
      if (staged.exitCode !== 1) requireGit(staged, "inspect staged changes");
      requireGit(runGitSafe([
        "-c", "user.name=Octomynd Maestro",
        "-c", "user.email=octomynd-maestro@users.noreply.github.com",
        "commit", "-m", message
      ], task.worktreePath), "commit goal changes");
    } else {
      const lastSubject = requireGit(
        runGitSafe(["log", "-1", "--pretty=%s"], task.worktreePath),
        "inspect existing delivery commit"
      ).stdout.trim();
      if (lastSubject !== message) {
        throw new Error(`Goal #${run.id} produced no files to deliver.`);
      }
    }
    const commitSha = requireGit(
      runGitSafe(["rev-parse", "HEAD"], task.worktreePath),
      "read delivery commit"
    ).stdout.trim();

    const pullRequestUrl = await publisher(task, project, commitSha);
    return { commitSha, pullRequestUrl, branchName: task.branchName };
  };
}

export function scanGoalChangesForSecrets(worktreePath: string, relativePaths: string[]): string[] {
  return scanWorktreePathsForSecrets(worktreePath, relativePaths).map(formatSecretScanFinding);
}

function listChangedFiles(worktreePath: string): string[] {
  const tracked = requireGit(
    runGitSafe(["diff", "--name-only", "-z", "HEAD"], worktreePath),
    "list tracked changes"
  ).stdout;
  const untracked = requireGit(
    runGitSafe(["ls-files", "--others", "--exclude-standard", "-z"], worktreePath),
    "list untracked changes"
  ).stdout;
  return [...new Set([...splitNull(tracked), ...splitNull(untracked)])];
}

async function publishGoalBranch(task: TaskRecord, project: ProjectRecord): Promise<string> {
  const pushResult = runGitSafe(["push", "-u", "origin", task.branchName!], task.worktreePath!);
  // If remote origin is not configured (or offline in local mode), push warning is ignored
  const existing = runGh([
    "pr", "list", "--head", task.branchName!, "--json", "url", "--jq", ".[0].url"
  ], task.worktreePath!);
  if (!existing.ok) {
    if (isGhMissing(existing)) {
      return `local://${task.branchName}`;
    }
    throw new Error(`Cannot inspect pull requests: ${existing.stderr || existing.stdout}`);
  }
  const existingUrl = existing.stdout.trim();
  if (existingUrl) return existingUrl;

  const title = `Task #${task.id}: ${singleLine(task.text).slice(0, 100)}`;
  const body = [
    `Automated delivery for Maestro goal task #${task.id}.`,
    "",
    "The goal completed planning, implementation, testing, and review.",
    "This pull request is intentionally a draft; merge remains a human decision."
  ].join("\n");
  const created = runGh([
    "pr", "create", "--draft", "--base", task.baseBranch || project.defaultBranch, "--head", task.branchName!,
    "--title", title, "--body", body
  ], task.worktreePath!);
  if (!created.ok) {
    if (isGhMissing(created)) {
      return `local://${task.branchName}`;
    }
    throw new Error(`Cannot create draft pull request: ${created.stderr || created.stdout}`);
  }
  const url = created.stdout.trim().split(/\r?\n/).find((line) => /^https:\/\/github\.com\//.test(line));
  if (!url) throw new Error("GitHub CLI did not return a pull request URL.");
  return url;
}

function runGitSafe(args: string[], cwd: string): GitCommandResult {
  return runGit(["-c", `safe.directory=${path.resolve(cwd)}`, ...args], cwd);
}

function runGh(args: string[], cwd: string): GitCommandResult {
  const executable = process.platform === "win32" ? "gh.exe" : "gh";
  const result = spawnSync(executable, args, { cwd, encoding: "utf8", windowsHide: true });
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? "",
    stderr: [result.stderr, result.error?.message].filter(Boolean).join("\n"),
    exitCode: result.status
  };
}

function isGhMissing(result: GitCommandResult): boolean {
  return !result.ok && /ENOENT|not found|is not recognized|command not found/i.test(result.stderr + result.stdout);
}

function requireGit(result: GitCommandResult, operation: string): GitCommandResult {
  if (!result.ok) throw new Error(`Cannot ${operation}: ${result.stderr || result.stdout}`);
  return result;
}

function splitNull(value: string): string[] {
  return value.split("\0").map((item) => item.trim()).filter(Boolean);
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
