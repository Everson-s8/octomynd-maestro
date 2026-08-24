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

    const message = `Task #${task.id}: ${singleLine(task.title || task.text).slice(0, 120)}`;
    const changedFiles = listChangedFiles(task.worktreePath);
    if (changedFiles.length > 0) {
      const secretFindings = scanGoalChangesForSecrets(task.worktreePath, changedFiles);
      if (secretFindings.length > 0) {
        throw new Error(`Secret guard blocked delivery: ${secretFindings.join(", ")}`);
      }

      requireGit(runGitSafe(["add", "--all"], task.worktreePath), "stage goal changes");
      validateStagedDiffWhitespace(task.worktreePath);
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

/**
 * Markdown uses two trailing spaces for an intentional hard line break. Keep
 * Git's whitespace guard for source files while allowing that documented
 * Markdown syntax through the delivery gate.
 */
export function validateStagedDiffWhitespace(worktreePath: string): void {
  const result = runGitSafe(["diff", "--cached", "--check"], worktreePath);
  if (result.ok) return;

  const violations = [result.stdout, result.stderr]
    .filter(Boolean)
    .join("\n")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    // Git diff check prints the offending added line on the following line;
    // only the location line is needed for the file extension filter.
    .filter((line) => /^.+?:\d+(?::\d+)?:\s/.test(line))
    .filter((line) => {
      const file = line.match(/^(.+?):\d+:\d+:/)?.[1] ?? line.match(/^(.+?):\d+:/)?.[1] ?? line;
      return !/\.mdx?$/i.test(file);
    });
  if (violations.length > 0) {
    throw new Error(["Cannot validate staged diff:", violations.join("\n")].join(" "));
  }
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
  const remote = runGitSafe(["remote", "get-url", "origin"], task.worktreePath!);
  if (!remote.ok) {
    // A local-only project has no meaningful GitHub PR target. Preserve the
    // branch delivery result without pretending that a remote PR exists.
    return `local://${task.branchName}`;
  }

  const pushResult = runGitSafe(["push", "-u", "origin", task.branchName!], task.worktreePath!);
  if (!pushResult.ok) {
    throw new Error(`Nao foi possivel publicar a branch '${task.branchName}' no GitHub: ${pushResult.stderr || pushResult.stdout}`);
  }

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

  const title = buildPullRequestTitle(task, project);
  const body = [
    "## Resumo",
    `Implementa: ${task.title || pullRequestSummary(task.text)}.`,
    "",
    "## Objetivo original",
    singleLine(task.text),
    "",
    "## Controle",
    `- Task do Maestro: #${task.id}`,
    `- Branch: \`${task.branchName}\``,
    "- PR criado como draft; a revisão e o merge continuam sendo decisões humanas."
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

export function pullRequestSummary(taskText: string): string {
  const original = singleLine(taskText);
  const withoutFraming = original
    .replace(/^(?:eu\s+)?(?:quero\s+)?(?:crie|criar|cadastre|cadastrar|abra|abrir|faca|faça)\b[\s\S]*?\btask\b\s*[:\-,]?\s*/i, "")
    .replace(/^(?:eu\s+)?quero\s+criar\s+(?:um|uma)\s+/i, "")
    .replace(/^(?:a ideia inicial é|a ideia e|objetivo:?)\s*/i, "")
    .replace(/\s+(?:faça|faca)\.?$/i, "")
    .trim();
  const firstSentence = withoutFraming.split(/(?<=[.!?])\s+/)[0] || withoutFraming;
  const firstClause = firstSentence.split(/,\s+|\s+\b(?:mas|porém|porem)\b\s+/i)[0].trim();
  const summary = firstClause || original;
  return summary.length <= 92 ? summary : `${summary.slice(0, 89).trim()}…`;
}

export function buildPullRequestTitle(task: TaskRecord, project: ProjectRecord): string {
  const text = singleLine(task.title || task.text);
  const kind = /\b(corrij|conser|bug|fix|falha|erro)\b/i.test(text)
    ? "fix"
    : /\b(refator|refactor|reorganiz|melhor)\b/i.test(text)
      ? "refactor"
      : /\b(document|readme|docs?)\b/i.test(text)
        ? "docs"
        : "feat";
  return `${kind}(${project.key}): ${pullRequestSummary(text)}`.slice(0, 120);
}
