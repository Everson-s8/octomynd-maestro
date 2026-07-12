export type TaskStatus =
  | "queued"
  | "planning"
  | "implementing"
  | "testing"
  | "reviewing"
  | "changes_requested"
  | "awaiting_human"
  | "waiting_quota"
  | "blocked"
  | "failed"
  | "done";

export type DashboardTask = {
  id: number;
  projectKey: string | null;
  projectName: string | null;
  text: string;
  status: TaskStatus;
  source: string;
  branchName: string | null;
  worktreePath: string | null;
  createdAt: string;
  updatedAt: string;
};

export type DashboardProject = {
  id: number;
  key: string;
  name: string;
  path: string;
  defaultBranch: string;
  taskCount: number;
  activeTaskCount: number;
};

export type DashboardEvent = {
  id: number;
  source: string;
  type: string;
  text: string;
  taskId: number | null;
  createdAt: string;
  metadata: Record<string, unknown>;
};

export type DashboardData = {
  generatedAt: string;
  daemon: {
    name: string;
    state: "online";
    access: "restricted" | "unrestricted";
    dashboardHost: string;
  };
  summary: {
    projects: number;
    activeTasks: number;
    queuedTasks: number;
    humanGates: number;
    improvementCandidates: number;
    activeGoals: number;
    completedTasks: number;
  };
  projects: DashboardProject[];
  tasks: DashboardTask[];
  events: DashboardEvent[];
  improvements: ImprovementProposal[];
  goals: GoalRun[];
  agents: Array<{
    id: "codex" | "claude" | "telegram";
    label: string;
    state: "ready" | "attention" | "offline";
    detail: string;
  }>;
};

export type GoalRun = {
  id: number;
  taskId: number;
  status: "running" | "waiting_provider" | "completed" | "blocked" | "failed";
  currentPhase: "planning" | "implementing" | "testing" | "reviewing";
  stepCount: number;
  maxSteps: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
};

export type ImprovementCategory = "skill" | "memory" | "routing" | "policy" | "integration";
export type ImprovementRisk = "low" | "medium" | "high";
export type ImprovementStatus = "candidate" | "approved" | "rejected";

export type ImprovementProposal = {
  id: number;
  category: ImprovementCategory;
  title: string;
  rationale: string;
  proposedChange: string;
  evidence: string[];
  risk: ImprovementRisk;
  source: string;
  status: ImprovementStatus;
  decisionNote: string | null;
  createdAt: string;
  decidedAt: string | null;
};

export type TaskReview = {
  id: number;
  taskId: number;
  provider: string;
  status: "completed" | "auth_required" | "failed";
  content: string;
  error: string | null;
  createdAt: string;
};

export async function fetchDashboard(signal?: AbortSignal): Promise<DashboardData> {
  const response = await fetch("/api/dashboard", { signal });
  if (!response.ok) {
    throw new Error(`Dashboard indisponível (${response.status}).`);
  }
  return response.json() as Promise<DashboardData>;
}

export async function createTask(input: { projectKey: string; text: string }) {
  const response = await fetch("/api/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(payload.error || `Não foi possível criar a task (${response.status}).`);
  }
  return response.json() as Promise<{ task: DashboardTask }>;
}

export async function prepareTask(taskId: number) {
  const response = await fetch(`/api/tasks/${taskId}/prepare`, { method: "POST" });
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as {
      error?: string;
      details?: string[];
    };
    throw new Error(payload.details?.join(" ") || payload.error || "Não foi possível preparar a task.");
  }
  return response.json() as Promise<{ task: DashboardTask }>;
}

export async function fetchTaskReviews(taskId: number): Promise<TaskReview[]> {
  const response = await fetch(`/api/tasks/${taskId}/reviews`);
  if (!response.ok) {
    throw new Error("Não foi possível carregar as revisões da task.");
  }
  const payload = await response.json() as { reviews: TaskReview[] };
  return payload.reviews;
}

export async function requestClaudeReview(taskId: number): Promise<TaskReview> {
  const response = await fetch(`/api/tasks/${taskId}/reviews/claude`, { method: "POST" });
  const payload = await response.json() as { review?: TaskReview; error?: string };
  if (!response.ok) {
    throw new Error(payload.review?.error || payload.error || "A revisão do Claude falhou.");
  }
  if (!payload.review) {
    throw new Error("Claude não retornou uma revisão válida.");
  }
  return payload.review;
}

export async function createImprovement(input: {
  category: ImprovementCategory;
  title: string;
  rationale: string;
  proposedChange: string;
  evidence: string[];
  risk: ImprovementRisk;
}): Promise<ImprovementProposal> {
  const response = await fetch("/api/improvements", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });
  const payload = await response.json() as { improvement?: ImprovementProposal; error?: string; details?: string };
  if (!response.ok || !payload.improvement) {
    throw new Error(payload.details || payload.error || "Nao foi possivel registrar a proposta.");
  }
  return payload.improvement;
}

export async function decideImprovement(
  improvementId: number,
  status: Extract<ImprovementStatus, "approved" | "rejected">,
  decisionNote = ""
): Promise<ImprovementProposal> {
  const response = await fetch(`/api/improvements/${improvementId}/decision`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status, decisionNote })
  });
  const payload = await response.json() as { improvement?: ImprovementProposal; error?: string; details?: string };
  if (!response.ok || !payload.improvement) {
    throw new Error(payload.details || payload.error || "Nao foi possivel decidir a proposta.");
  }
  return payload.improvement;
}

export async function startTaskGoal(taskId: number, maxSteps = 12): Promise<GoalRun> {
  const response = await fetch(`/api/tasks/${taskId}/goal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ maxSteps })
  });
  const payload = await response.json() as { run?: GoalRun; error?: string; details?: string };
  if (!response.ok || !payload.run) {
    throw new Error(payload.details || payload.error || "Nao foi possivel iniciar a goal.");
  }
  return payload.run;
}
