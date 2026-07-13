import { MaestroConfig } from "../config.js";
import { MaestroDatabase, TaskRecord } from "../db.js";
import { listReviewQueue } from "../reviews/evidence.js";
import { redactSensitiveText, sanitizePublicMetadata, truncateForDisplay } from "../security/redaction.js";
import { BacklogAutopilotSnapshot } from "../backlog/autopilot.js";

export type AgentPresence = {
  id: "codex" | "claude" | "telegram";
  label: string;
  state: "ready" | "working" | "attention" | "offline";
  detail: string;
  taskId?: number;
  projectKey?: string;
  phase?: string;
};

const EVENT_TEXT_MAX_LENGTH = 500;

export function buildDashboardSnapshot(
  config: MaestroConfig,
  database: MaestroDatabase,
  agents?: AgentPresence[],
  autopilot?: BacklogAutopilotSnapshot
) {
  const projects = database.listProjects();
  const tasks = database.listTasks(80);
  const events = database.listEvents(40);
  const improvements = database.listImprovementProposals(40);
  const goals = database.listGoalRuns(30);
  const counts = database.countTasksByStatus();
  const improvementCounts = database.countImprovementProposalsByStatus();
  const featurePlanCounts = database.countFeaturePlansByStatus();
  const reviewQueue = listReviewQueue(database);
  const features = database.listFeatures(30);
  const featurePlans = database.listFeaturePlans(30);

  return {
    generatedAt: new Date().toISOString(),
    daemon: {
      name: config.projectName,
      state: "online" as const,
      access: config.telegram.allowedUserId ? "restricted" : "unrestricted",
      dashboardHost: config.dashboard.host
    },
    autopilot: autopilot ?? {
      enabled: config.autopilot.enabled,
      state: config.autopilot.enabled ? "idle" as const : "disabled" as const,
      maxConcurrentGoals: config.autopilot.maxConcurrentGoals,
      pollIntervalMs: config.autopilot.pollIntervalMs,
      runningGoals: goals.filter((goal) => goal.status === "running").length,
      waitingProviderGoals: goals.filter((goal) => goal.status === "waiting_provider").length,
      queuedTasks: counts.queued ?? 0,
      lastAction: "snapshot_only",
      lastTickAt: null
    },
    summary: {
      projects: projects.length,
      activeTasks: tasks.filter(isActiveTask).length,
      queuedTasks: counts.queued ?? 0,
      humanGates: reviewQueue.length + (counts.ready_to_merge ?? 0) + (improvementCounts.candidate ?? 0),
      improvementCandidates: improvementCounts.candidate ?? 0,
      plannedFeaturePlans: featurePlanCounts.planned ?? 0,
      activeGoals: goals.filter((goal) => ["running", "waiting_provider"].includes(goal.status)).length,
      completedTasks: counts.done ?? 0
    },
    projects: projects.map((project) => {
      const projectTasks = tasks.filter((task) => task.projectKey === project.key);
      const currentWork = goals.flatMap((goal) => {
        const task = tasks.find((item) => item.id === goal.taskId);
        if (task?.projectKey !== project.key || !["running", "waiting_provider"].includes(goal.status)) return [];
        const step = database.listGoalSteps(goal.id).at(-1);
        return [{ taskId: task.id, phase: goal.currentPhase, provider: step?.provider ?? null }];
      });
      return {
        id: project.id,
        key: project.key,
        name: project.name,
        defaultBranch: project.defaultBranch,
        taskCount: projectTasks.length,
        activeTaskCount: projectTasks.filter(isActiveTask).length,
        workingAgents: [...new Set(currentWork.map((item) => item.provider).filter(Boolean))],
        currentWork
      };
    }),
    tasks: tasks.map((task) => ({
      id: task.id,
      projectKey: task.projectKey,
      projectName: task.projectName,
      text: redactSensitiveText(task.text),
      status: task.status,
      source: task.source,
      branchName: task.branchName ? redactSensitiveText(task.branchName) : null,
      worktreePrepared: Boolean(task.worktreePath),
      createdAt: task.createdAt,
      updatedAt: task.updatedAt
    })),
    events: events.map((event) => ({
      id: event.id,
      source: event.source,
      type: event.type,
      text: truncateForDisplay(redactSensitiveText(event.text), EVENT_TEXT_MAX_LENGTH),
      taskId: event.taskId,
      createdAt: event.createdAt,
      metadata: sanitizePublicMetadata(event.metadata)
    })),
    improvements: improvements.map((item) => ({
      ...item,
      title: redactSensitiveText(item.title),
      rationale: redactSensitiveText(item.rationale),
      proposedChange: redactSensitiveText(item.proposedChange),
      evidence: item.evidence.map(redactSensitiveText),
      decisionNote: item.decisionNote ? redactSensitiveText(item.decisionNote) : null
    })),
    goals: goals.map((goal) => ({
      ...goal,
      lastError: goal.lastError
        ? truncateForDisplay(redactSensitiveText(goal.lastError), EVENT_TEXT_MAX_LENGTH)
        : null
    })),
    features: features.map((feature) => ({
      id: feature.id,
      projectKey: feature.projectKey,
      featurePlanId: feature.featurePlanId,
      name: redactSensitiveText(feature.name),
      objective: truncateForDisplay(redactSensitiveText(feature.objective), EVENT_TEXT_MAX_LENGTH),
      status: feature.status,
      branchName: redactSensitiveText(feature.branchName),
      pullRequestUrl: feature.pullRequestUrl,
      reviewerProvider: feature.reviewerProvider,
      reviewSummary: feature.reviewSummary
        ? truncateForDisplay(redactSensitiveText(feature.reviewSummary), EVENT_TEXT_MAX_LENGTH)
        : null,
      lastError: feature.lastError
        ? truncateForDisplay(redactSensitiveText(feature.lastError), EVENT_TEXT_MAX_LENGTH)
        : null,
      itemCount: database.listFeatureItems(feature.id).length,
      mergedAt: feature.mergedAt,
      createdAt: feature.createdAt,
      updatedAt: feature.updatedAt
    })),
    featurePlans: featurePlans.map((plan) => ({
      id: plan.id,
      projectKey: plan.projectKey,
      projectName: plan.projectName,
      objective: truncateForDisplay(redactSensitiveText(plan.objective), EVENT_TEXT_MAX_LENGTH),
      acceptanceCriteria: plan.acceptanceCriteria.map((item) => (
        truncateForDisplay(redactSensitiveText(item), EVENT_TEXT_MAX_LENGTH)
      )),
      status: plan.status,
      source: plan.source,
      revision: plan.revision,
      taskIds: database.listFeaturePlanTasks(plan.id).map((task) => task.taskId),
      taskCount: database.listFeaturePlanTasks(plan.id).length,
      cancelledAt: plan.cancelledAt,
      cancelReason: plan.cancelReason
        ? truncateForDisplay(redactSensitiveText(plan.cancelReason), EVENT_TEXT_MAX_LENGTH)
        : null,
      createdAt: plan.createdAt,
      updatedAt: plan.updatedAt
    })),
    reviewQueue,
    agents: agents ?? defaultAgentPresence(config, database, tasks, goals)
  };
}

function defaultAgentPresence(
  config: MaestroConfig,
  database: MaestroDatabase,
  tasks: TaskRecord[],
  goals: ReturnType<MaestroDatabase["listGoalRuns"]>
): AgentPresence[] {
  const working = new Map<string, AgentPresence>();
  for (const goal of goals.filter((item) => item.status === "running")) {
    const task = tasks.find((item) => item.id === goal.taskId);
    const step = database.listGoalSteps(goal.id).at(-1);
    if (!task || !step || step.status !== "running") continue;
    working.set(step.provider, {
      id: step.provider as "codex" | "claude",
      label: step.provider === "codex" ? "Codex" : "Claude",
      state: "working",
      detail: `@${task.projectKey ?? "inbox"} · task #${task.id} · ${goal.currentPhase}`,
      taskId: task.id,
      projectKey: task.projectKey ?? undefined,
      phase: goal.currentPhase
    });
  }
  return [
    working.get("codex") ?? {
      id: "codex",
      label: "Codex",
      state: "ready",
      detail: "CLI local disponivel para delegacao"
    },
    working.get("claude") ?? {
      id: "claude",
      label: "Claude",
      state: "attention",
      detail: "CLI detectado; autenticacao precisa de revisao"
    },
    {
      id: "telegram",
      label: "Telegram",
      state: config.telegram.botToken ? "ready" : "offline",
      detail: config.telegram.allowedUserId ? "Bot restrito ao usuario autorizado" : "Restricao pendente"
    }
  ];
}

function isActiveTask(task: TaskRecord): boolean {
  return !["done", "failed", "blocked", "rejected", "cancelled"].includes(task.status);
}
