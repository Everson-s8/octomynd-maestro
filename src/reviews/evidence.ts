import path from "node:path";
import { MaestroDatabase, GoalRunRecord, HumanReviewRecord } from "../db.js";
import { runGit } from "../git.js";
import { redactSensitiveText } from "../security/redaction.js";
import { scanWorktreePathsForSecrets, SecretScanFinding } from "../security/secrets.js";

export type ReviewSecurityAlert = {
  severity: "info" | "warning" | "high";
  code: string;
  message: string;
  file: string | null;
};

export type ChangeSafetyGateStatus = "passed" | "blocked" | "unavailable";

export type ChangeSafetyGate = {
  status: ChangeSafetyGateStatus;
  code: string;
  message: string;
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
  changeSafetyGate: ChangeSafetyGate;
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
      database.getTask(run.taskId).status === "awaiting_human" &&
      !database.findFeatureByTaskId(run.taskId)
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
  const changedFilesResult = inspectChangedFiles(task.worktreePath, task.baseBranch || project.defaultBranch);
  const changedFiles = changedFilesResult.status === "available" ? changedFilesResult.files : [];
  const changeSafety = inspectChangeSafety(task.worktreePath, changedFilesResult);
  const reviewSummary = [...steps].reverse().find((step) => step.phase === "reviewing")?.summary;

  return {
    runId: run.id,
    taskId: task.id,
    projectKey: project.key,
    projectName: project.name,
    demand: redactSensitiveText(task.text),
    status: latestDecision,
    summary: redactSensitiveText(reviewSummary || `Goal completed in ${run.stepCount} steps.`),
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
    changeSafetyGate: changeSafety.gate,
    securityAlerts: changeSafety.alerts,
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

type ChangedFilesInspection =
  | { status: "available"; files: string[] }
  | { status: "unavailable"; code: string; message: string };

function inspectChangedFiles(worktreePath: string | null, baseBranch: string): ChangedFilesInspection {
  if (!worktreePath) {
    return {
      status: "unavailable",
      code: "worktree_unavailable",
      message: "Worktree unavailable for a new verification."
    };
  }
  const safeDirectory = `safe.directory=${path.resolve(worktreePath)}`;
  const candidates = [`origin/${baseBranch}`, baseBranch];
  for (const base of candidates) {
    const result = runGit(["-c", safeDirectory, "diff", "--name-only", "-z", `${base}...HEAD`], worktreePath);
    if (result.ok) {
      return {
        status: "available",
        files: splitNull(result.stdout).map(normalizeRelativePath)
      };
    }
  }
  const fallback = runGit(["-c", safeDirectory, "show", "--pretty=", "--name-only", "-z", "HEAD"], worktreePath);
  if (fallback.ok) {
    return {
      status: "available",
      files: splitNull(fallback.stdout).map(normalizeRelativePath)
    };
  }
  return {
    status: "unavailable",
    code: "changed_files_unavailable",
    message: "Nao foi possivel inspecionar o diff local para segredos."
  };
}

function inspectChangeSafety(
  worktreePath: string | null,
  changedFilesResult: ChangedFilesInspection
): { gate: ChangeSafetyGate; alerts: ReviewSecurityAlert[] } {
  if (changedFilesResult.status === "unavailable") {
    const gate = {
      status: "unavailable" as const,
      code: changedFilesResult.code,
      message: changedFilesResult.message
    };
    return {
      gate,
      alerts: [{
        severity: "warning",
        code: changedFilesResult.code,
        message: changedFilesResult.message,
        file: null
      }]
    };
  }

  if (!worktreePath) {
    const gate = {
      status: "unavailable" as const,
      code: "worktree_unavailable",
      message: "Worktree unavailable for a new verification."
    };
    return {
      gate,
      alerts: [{
        severity: "warning",
        code: gate.code,
        message: gate.message,
        file: null
      }]
    };
  }

  const findings = scanWorktreePathsForSecrets(worktreePath, changedFilesResult.files);
  if (findings.length === 0) {
    const gate = {
      status: "passed" as const,
      code: "secret_scan_passed",
      message: "Secret scan completed without alerts."
    };
    return {
      gate,
      alerts: [{
        severity: "info",
        code: gate.code,
        message: gate.message,
        file: null
      }]
    };
  }

  return {
    gate: {
      status: "blocked",
      code: "sensitive_change",
      message: "Changed files require a security review before approval."
    },
    alerts: findings.map(secretFindingToAlert)
  };
}

function secretFindingToAlert(finding: SecretScanFinding): ReviewSecurityAlert {
  return {
    severity: "high",
    code: "sensitive_change",
    message: "Changed files require a security review before approval.",
    file: normalizeRelativePath(finding.relativePath)
  };
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
