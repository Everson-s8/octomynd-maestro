import path from "node:path";
import { MaestroDatabase, GoalRunRecord, HumanReviewRecord } from "../db.js";
import { runGit } from "../git.js";
import { scanGoalChangesForSecrets } from "../goals/delivery.js";
import { redactSensitiveText } from "../security/redaction.js";

export type ReviewSecurityAlert = {
  severity: "info" | "warning" | "high";
  code: string;
  message: string;
  file: string | null;
};

export type ReviewQueueItem = {
  runId: number;
  taskId: number;
  projectKey: string;
  projectName: string;
  demand: string;
  status: "pending" | "approved" | "changes_requested" | "rejected";
  summary: string;
  agents: string[];
  changedFiles: string[];
  tests: Array<{ provider: string; status: string; summary: string; durationMs: number | null }>;
  securityAlerts: ReviewSecurityAlert[];
  pullRequestUrl: string;
  diffUrl: string;
  commitSha: string | null;
  createdAt: string;
  updatedAt: string;
  decisions: HumanReviewRecord[];
};

export function listReviewQueue(database: MaestroDatabase): ReviewQueueItem[] {
  return database
    .listGoalRuns(100)
    .filter((run) => (
      run.pullRequestUrl &&
      run.status === "completed" &&
      database.getTask(run.taskId).status === "awaiting_human"
    ))
    .map((run) => buildReviewQueueItem(database, run))
    .filter((item) => !["approved", "rejected"].includes(item.status));
}

export function buildReviewQueueItem(
  database: MaestroDatabase,
  runOrId: GoalRunRecord | number
): ReviewQueueItem {
  const run = typeof runOrId === "number" ? database.getGoalRun(runOrId) : runOrId;
  const task = database.getTask(run.taskId);
  if (!task.projectKey || !run.pullRequestUrl) {
    throw new Error(`Goal #${run.id} has no reviewable project or pull request.`);
  }
  const project = database.getProjectByKey(task.projectKey);
  const steps = database.listGoalSteps(run.id);
  const decisions = database.listHumanReviews(run.id);
  const latestDecision = decisions[0]?.decision ?? "pending";
  const changedFiles = task.worktreePath
    ? listChangedFiles(task.worktreePath, project.defaultBranch)
    : [];
  const securityAlerts = inspectSecurity(task.worktreePath, changedFiles);
  const reviewSummary = [...steps].reverse().find((step) => step.phase === "reviewing")?.summary;

  return {
    runId: run.id,
    taskId: task.id,
    projectKey: project.key,
    projectName: project.name,
    demand: redactSensitiveText(task.text),
    status: latestDecision,
    summary: redactSensitiveText(reviewSummary || `Goal concluida em ${run.stepCount} passos.`),
    agents: [...new Set(steps.map((step) => step.provider))],
    changedFiles,
    tests: steps
      .filter((step) => step.phase === "testing")
      .map((step) => ({
        provider: step.provider,
        status: step.status,
        summary: redactSensitiveText(step.summary),
        durationMs: step.durationMs
      })),
    securityAlerts,
    pullRequestUrl: run.pullRequestUrl,
    diffUrl: `${run.pullRequestUrl.replace(/\/$/, "")}/files`,
    commitSha: run.commitSha,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    decisions: decisions.map((decision) => ({
      ...decision,
      note: redactSensitiveText(decision.note)
    }))
  };
}

function listChangedFiles(worktreePath: string, defaultBranch: string): string[] {
  const safeDirectory = `safe.directory=${path.resolve(worktreePath)}`;
  const candidates = [`origin/${defaultBranch}`, defaultBranch];
  for (const base of candidates) {
    const result = runGit(["-c", safeDirectory, "diff", "--name-only", "-z", `${base}...HEAD`], worktreePath);
    if (result.ok) return splitNull(result.stdout).map(normalizeRelativePath);
  }
  const fallback = runGit(["-c", safeDirectory, "show", "--pretty=", "--name-only", "-z", "HEAD"], worktreePath);
  return fallback.ok ? splitNull(fallback.stdout).map(normalizeRelativePath) : [];
}

function inspectSecurity(worktreePath: string | null, changedFiles: string[]): ReviewSecurityAlert[] {
  if (!worktreePath) {
    return [{ severity: "warning", code: "worktree_unavailable", message: "Worktree indisponivel para nova verificacao.", file: null }];
  }
  const findings = scanGoalChangesForSecrets(worktreePath, changedFiles);
  if (findings.length === 0) {
    return [{ severity: "info", code: "secret_scan_passed", message: "Verificacao de segredos concluida sem alertas.", file: null }];
  }
  return findings.map((finding) => {
    const [file] = finding.split(":", 1);
    return {
      severity: "high" as const,
      code: "sensitive_change",
      message: "Arquivo alterado requer revisao de seguranca antes da aprovacao.",
      file: normalizeRelativePath(file)
    };
  });
}

function splitNull(value: string): string[] {
  return value.split("\0").map((item) => item.trim()).filter(Boolean);
}

function normalizeRelativePath(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "");
  return normalized.startsWith("../") || path.isAbsolute(normalized)
    ? "[REDACTED_PATH]"
    : redactSensitiveText(normalized);
}
