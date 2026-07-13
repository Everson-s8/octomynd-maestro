import { MaestroConfig } from "../config.js";
import { MaestroDatabase, TaskRecord } from "../db.js";
import { listReviewQueue } from "../reviews/evidence.js";
import { redactSensitiveText, sanitizePublicMetadata } from "../security/redaction.js";

export type AgentPresence = {
  id: "codex" | "claude" | "telegram";
  label: string;
  state: "ready" | "working" | "attention" | "offline";
  detail: string;
  taskId?: number;
  projectKey?: string;
  phase?: string;
};

export function buildDashboardSnapshot(
  config: MaestroConfig,
  database: MaestroDatabase,
  agents?: AgentPresence[]
) {
  const projects = database.listProjects();
  const tasks = database.listTasks(80);
  const events = database.listEvents(40);
  const improvements = database.listImprovementProposals(40);
  const goals = database.listGoalRuns(30);
  const counts = database.countTasksByStatus();
  const improvementCounts = database.countImprovementProposalsByStatus();
  const reviewQueue = listReviewQueue(database);

  return {
    generatedAt: new Date().toISOString(),
    daemon: {
      name: config.projectName,
      state: "online" as const,
      access: config.telegram.allowedUserId ? "restricted" : "unrestricted",
      dashboardHost: config.dashboard.host
    },
    summary: {
      projects: projects.length,
      activeTasks: tasks.filter(isActiveTask).length,
      queuedTasks: counts.queued ?? 0,
      humanGates: reviewQueue.length + (counts.ready_to_merge ?? 0) + (improvementCounts.candidate ?? 0),
      improvementCandidates: improvementCounts.candidate ?? 0,
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
      text: redactSensitiveText(event.text),
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
    goals: goals.map((goal) => ({ ...goal, lastError: goal.lastError ? redactSensitiveText(goal.lastError) : null })),
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
  return !["done", "failed", "blocked", "rejected"].includes(task.status);
}
