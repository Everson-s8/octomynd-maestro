import { MaestroConfig } from "../config.js";
import { MaestroDatabase, TaskRecord } from "../db.js";

export type AgentPresence = {
  id: "codex" | "claude" | "telegram";
  label: string;
  state: "ready" | "attention" | "offline";
  detail: string;
};

export function buildDashboardSnapshot(
  config: MaestroConfig,
  database: MaestroDatabase,
  agents: AgentPresence[] = defaultAgentPresence(config)
) {
  const projects = database.listProjects();
  const tasks = database.listTasks(80);
  const events = database.listEvents(40);
  const counts = database.countTasksByStatus();

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
      humanGates: counts.awaiting_human ?? 0,
      completedTasks: counts.done ?? 0
    },
    projects: projects.map((project) => ({
      id: project.id,
      key: project.key,
      name: project.name,
      path: project.path,
      defaultBranch: project.defaultBranch,
      taskCount: tasks.filter((task) => task.projectKey === project.key).length,
      activeTaskCount: tasks.filter(
        (task) => task.projectKey === project.key && isActiveTask(task)
      ).length
    })),
    tasks: tasks.map((task) => ({
      id: task.id,
      projectKey: task.projectKey,
      projectName: task.projectName,
      text: task.text,
      status: task.status,
      source: task.source,
      branchName: task.branchName,
      worktreePath: task.worktreePath,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt
    })),
    events: events.map((event) => ({
      id: event.id,
      source: event.source,
      type: event.type,
      text: event.text,
      taskId: event.taskId,
      createdAt: event.createdAt,
      metadata: event.metadata
    })),
    agents
  };
}

function defaultAgentPresence(config: MaestroConfig): AgentPresence[] {
  return [
    {
      id: "codex",
      label: "Codex",
      state: "ready",
      detail: "CLI local disponivel para delegacao"
    },
    {
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
  return !["done", "failed", "blocked"].includes(task.status);
}
