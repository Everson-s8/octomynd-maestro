export type TaskStatus =
  | "queued"
  | "planning"
  | "implementing"
  | "testing"
  | "reviewing"
  | "changes_requested"
  | "awaiting_human"
  | "ready_to_merge"
  | "rejected"
  | "waiting_quota"
  | "waiting_provider"
  | "waiting_dependency"
  | "blocked"
  | "failed"
  | "cancelled"
  | "done";

export type WorkIntakeCategory =
  | "tiny_fix"
  | "documentation"
  | "audit"
  | "multi_deliverable_feature"
  | "dependent_work"
  | "parallel_safe_work"
  | "ambiguous_request"
  | "explicit_override";

export type WorkIntakeMode =
  | "single_agent"
  | "feature_plan"
  | "work_graph"
  | "needs_clarification";

export type WorkIntakeClassification = {
  id?: number;
  taskId: number;
  category: WorkIntakeCategory;
  decisionMode: WorkIntakeMode;
  actualMode: WorkIntakeMode;
  overrideMode?: WorkIntakeMode | null;
  score: number;
  reasons: string[];
  estimatedOverheadMs: number;
  priorWorkflowOverheadMs: number;
  overrideApplied: boolean;
  createdAt?: string;
  updatedAt?: string;
};

export type WorkIntakeMetrics = {
  totalClassifications: number;
  categoryCounts: Record<WorkIntakeCategory, number>;
  modeCounts: Record<WorkIntakeMode, number>;
  overrideCount: number;
  averageOverheadMs: number;
  averagePriorWorkflowOverheadMs: number;
  overheadReductionRatio: number;
};

export type DashboardTask = {
  id: number;
  projectKey: string | null;
  projectName: string | null;
  text: string;
  status: TaskStatus;
  source: string;
  branchName: string | null;
  worktreePrepared: boolean;
  intakeClassification?: WorkIntakeClassification | null;
  createdAt: string;
  updatedAt: string;
};

export type FeatureStatus =
  | "draft"
  | "waiting_checks"
  | "reviewing"
  | "waiting_provider"
  | "changes_requested"
  | "merging"
  | "completed"
  | "failed"
  | "cancelled";

export type DashboardFeature = {
  id: number;
  projectKey: string;
  featurePlanId: number | null;
  name: string;
  objective: string;
  status: FeatureStatus;
  branchName: string;
  pullRequestUrl: string;
  reviewerProvider: string | null;
  reviewSummary: string | null;
  lastError: string | null;
  itemCount: number;
  mergedAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  cancellable: boolean;
  createdAt: string;
  updatedAt: string;
};

export type FeaturePlanQueueStatus =
  | "queued"
  | "admitted"
  | "active"
  | "waiting_review"
  | "waiting_merge"
  | "blocked"
  | "completed"
  | "cancelled";

export type FeaturePlanStatus = FeaturePlanQueueStatus | "planned";
export type FeaturePlanLifecycleStatus = "active" | "completed" | "cancelled";

export type FeaturePlanIntegrationSummary = {
  status: "preparing" | "integrating" | "verifying" | "completed" | "failed";
  checkpoint: string;
  lastError: string | null;
};

export type FeaturePlanTaskSummary = {
  id: number;
  position: number;
  text: string;
  status: TaskStatus;
  objective: string;
  acceptanceCriteria: string[];
  excludedScope: string[];
  dependsOnTaskIds: number[];
  mutationScope: string[];
  parallelMode: "serial" | "parallel";
};

export type FeatureTaskContractInput = {
  taskId: number;
  objective?: string;
  acceptanceCriteria?: string[];
  excludedScope?: string[];
  dependsOnTaskIds?: number[];
  mutationScope?: string[];
  parallelMode?: "serial" | "parallel";
};

export type FeaturePlanFeatureSummary = {
  id: number;
  status: FeatureStatus;
  pullRequestUrl: string;
};

export type DashboardFeaturePlan = {
  id: number;
  projectKey: string;
  projectName: string;
  objective: string;
  acceptanceCriteria: string[];
  status: FeaturePlanQueueStatus;
  priority?: number;
  isPaused?: boolean;
  pausedAt?: string | null;
  pauseReason?: string | null;
  blockedAt?: string | null;
  blockedReason?: string | null;
  admittedAt?: string | null;
  completedAt?: string | null;
  lifecycleStatus: FeaturePlanLifecycleStatus;
  source: string;
  revision: number;
  taskIds: number[];
  taskCount: number;
  dependsOnFeaturePlanIds?: number[];
  tasks: FeaturePlanTaskSummary[];
  eligible: boolean;
  blockers: string[];
  feature: FeaturePlanFeatureSummary | null;
  integration: FeaturePlanIntegrationSummary | null;
  cancellable: boolean;
  cancelledAt: string | null;
  cancelReason: string | null;
  createdAt: string;
  updatedAt: string;
};

export type WorkGraphStatus =
  | "draft"
  | "validated"
  | "running"
  | "waiting_provider"
  | "completed"
  | "blocked"
  | "cancelled";

export type DashboardWorkGraph = {
  id: number;
  runId: number;
  taskId: number;
  projectKey: string | null;
  objective: string;
  status: WorkGraphStatus;
  maxParallelReaders: number;
  artifactCount: number;
  artifactBytes: number;
  cancellable: boolean;
  adoption: {
    mode: string;
    decision: string;
    reason: string;
    executionMode: string;
    automaticFanOut: boolean;
    telemetry: unknown;
  } | null;
  artifacts: Array<{
    nodeId: number;
    key: string;
    kind: string;
    summary: string;
    contentHash: string | null;
    bytes: number;
  }>;
  canary: {
    durationMs: number;
    estimatedTokens: number;
    attempts: number;
    fallbacks: number;
    conflicts: number;
    quality: "passed" | "degraded" | "blocked" | "cancelled" | "pending";
  };
  nodes: Array<{
    id: number;
    key: string;
    role: string;
    mode: "read_only" | "writer";
    capability: string;
    status: string;
    attemptCount: number;
    maxAttempts: number;
    deadlineMs: number;
    outputChars: number;
    dependsOn: string[];
    writeScope: string[];
    lastError: string | null;
    fallbackCount: number;
    attempts: Array<{
      attemptNumber: number;
      provider: string;
      status: string;
      durationMs: number | null;
      summary: string;
      error: string | null;
      createdAt: string;
      finishedAt: string | null;
    }>;
  }>;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
};

export type FeaturePlanTask = {
  id: number;
  featurePlanId: number;
  taskId: number;
  taskText: string;
  taskStatus: TaskStatus;
  position: number;
  contract: {
    objective: string;
    acceptanceCriteria: string[];
    excludedScope: string[];
    mutationScope: string[];
    dependsOnTaskIds: number[];
    parallelMode: "serial" | "parallel";
  };
  createdAt: string;
};

export type FeaturePlanDetails = {
  plan: DashboardFeaturePlan & {
    createdByUserId?: string | null;
    createdByUsername?: string | null;
  };
  tasks: FeaturePlanTask[];
  applied?: boolean;
};

export type DashboardProject = {
  id: number;
  key: string;
  name: string;
  defaultBranch: string;
  taskCount: number;
  activeTaskCount: number;
  workingAgents: string[];
  currentWork: Array<{ taskId: number; phase: string; provider: string | null }>;
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

export type EnvironmentDoctorReport = {
  status: "ready" | "environment_blocked" | "auth_required" | "quota" | "offline";
  summary: string;
  recommendedAction: string;
  checkedAt: string;
  projectKey: string;
  taskId: number | null;
  fingerprintId: string;
  checks: Array<{
    name: string;
    status: "passed" | "warning" | "failed" | "skipped";
    summary: string;
  }>;
};

export type DashboardData = {
  generatedAt: string;
  daemon: {
    name: string;
    state: "online";
    access: "restricted" | "unrestricted";
    dashboardHost: string;
  };
  autopilot: {
    enabled: boolean;
    state: "disabled" | "idle" | "working" | "waiting_provider" | "at_capacity";
    maxConcurrentGoals: number;
    pollIntervalMs: number;
    runningGoals: number;
    waitingProviderGoals: number;
    queuedTasks: number;
    lastAction: string;
    lastTickAt: string | null;
  };
  summary: {
    projects: number;
    activeTasks: number;
    queuedTasks: number;
    humanGates: number;
    improvementCandidates: number;
    plannedFeaturePlans: number;
    activeGoals: number;
    completedTasks: number;
  };
  projects: DashboardProject[];
  tasks: DashboardTask[];
  events: DashboardEvent[];
  improvements: ImprovementProposal[];
  goals: GoalRun[];
  features: DashboardFeature[];
  featurePlans: DashboardFeaturePlan[];
  workGraphs: DashboardWorkGraph[];
  intakeMetrics?: WorkIntakeMetrics;
  intakeClassifications?: WorkIntakeClassification[];
  environments: EnvironmentDoctorReport[];
  reviewQueue: ReviewQueueItem[];
  agents: Array<{
    id: "codex" | "claude" | "antigravity" | "telegram";
    label: string;
    state: "ready" | "working" | "attention" | "offline";
    detail: string;
    taskId?: number;
    projectKey?: string;
    phase?: string;
  }>;
};

export type AgentProviderId = "codex" | "claude" | "antigravity";
export type AgentCapability =
  | "planning"
  | "coding"
  | "testing"
  | "reviewing"
  | "improvement_reviewing"
  | "research"
  | "conversation";
export type ProviderMode = "enabled" | "paused" | "disabled";
export type ProviderControl = {
  providerId: AgentProviderId;
  mode: ProviderMode;
  fallbackEnabled: boolean;
  updatedAt: string | null;
};
export type CapabilityRoutingPolicy = {
  capability: AgentCapability;
  order: AgentProviderId[];
  requiredProviderId: AgentProviderId | null;
  updatedAt: string | null;
};
export type ProviderPolicySnapshot = {
  controls: ProviderControl[];
  capabilities: CapabilityRoutingPolicy[];
};

export async function fetchProviderPolicy(): Promise<ProviderPolicySnapshot> {
  const response = await fetch("/api/provider-policy");
  const payload = await response.json() as { policy?: ProviderPolicySnapshot; error?: string };
  if (!response.ok || !payload.policy) throw new Error(payload.error || "Nao foi possivel carregar os providers.");
  return payload.policy;
}

export async function updateProviderControl(
  providerId: AgentProviderId,
  input: Pick<ProviderControl, "mode" | "fallbackEnabled">
): Promise<ProviderControl> {
  const response = await fetch(`/api/provider-policy/providers/${providerId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });
  const payload = await response.json() as { control?: ProviderControl; error?: string };
  if (!response.ok || !payload.control) throw new Error(payload.error || "Nao foi possivel atualizar o provider.");
  return payload.control;
}

export async function updateProviderControls(
  controls: Array<Pick<ProviderControl, "providerId" | "mode" | "fallbackEnabled">>
): Promise<ProviderControl[]> {
  const response = await fetch("/api/provider-policy/providers", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ controls })
  });
  const payload = await response.json() as { controls?: ProviderControl[]; error?: string };
  if (!response.ok || !payload.controls) throw new Error(payload.error || "Nao foi possivel atualizar os providers.");
  return payload.controls;
}

export async function updateCapabilityRouting(
  capability: AgentCapability,
  input: Pick<CapabilityRoutingPolicy, "order" | "requiredProviderId">
): Promise<CapabilityRoutingPolicy> {
  const response = await fetch(`/api/provider-policy/capabilities/${capability}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });
  const payload = await response.json() as { routing?: CapabilityRoutingPolicy; error?: string };
  if (!response.ok || !payload.routing) throw new Error(payload.error || "Nao foi possivel atualizar o roteamento.");
  return payload.routing;
}

export type GoalObservability = {
  classifiedReason: string | null;
  classifiedReasonLabel: string | null;
  sourceProvider: string | null;
  nextProvider: string | null;
  preservedChanges: boolean;
  preservedFiles: string[];
  checkpointId: number | null;
  retryable: boolean;
  nextAction: string;
};

export type GoalRun = {
  id: number;
  taskId: number;
  status: "running" | "waiting_provider" | "completed" | "blocked" | "failed" | "cancelled";
  currentPhase: "planning" | "implementing" | "testing" | "reviewing";
  stepCount: number;
  maxSteps: number;
  lastError: string | null;
  waitReason: "quota" | "auth_required" | "timeout" | "output_limit" | "offline" | "capacity" | "runtime_restart" | "unknown" | null;
  nextRetryAt: string | null;
  lastProvider: string | null;
  commitSha: string | null;
  pullRequestUrl: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
  observability?: GoalObservability;
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
  projectKey: string | null;
  targets: string[];
  confidence: number | null;
  fingerprint: string | null;
  taskId: number | null;
  featurePlanId: number | null;
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

export type HumanReviewDecision = "approved" | "changes_requested" | "rejected";

export type ChangeSafetyGate = {
  status: "passed" | "blocked" | "unavailable";
  code: string;
  message: string;
};

export type HumanReview = {
  id: number;
  runId: number;
  taskId: number;
  decision: HumanReviewDecision;
  note: string;
  source: string;
  createdAt: string;
};

export type ReviewQueueItem = {
  runId: number;
  taskId: number;
  projectKey: string;
  projectName: string;
  demand: string;
  status: "pending" | HumanReviewDecision;
  summary: string;
  agents: string[];
  changedFiles: string[];
  tests: Array<{ provider: string; status: string; summary: string; durationMs: number | null }>;
  changeSafetyGate: ChangeSafetyGate;
  securityAlerts: Array<{
    severity: "info" | "warning" | "high";
    code: string;
    message: string;
    file: string | null;
  }>;
  pullRequestUrl: string;
  diffUrl: string;
  commitSha: string | null;
  createdAt: string;
  updatedAt: string;
  decisions: HumanReview[];
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

export async function cancelTask(taskId: number) {
  const response = await fetch(`/api/tasks/${taskId}/cancel`, { method: "POST" });
  const payload = await response.json() as { task?: DashboardTask; error?: string; details?: string };
  if (!response.ok || !payload.task) {
    throw new Error(payload.details || payload.error || "Nao foi possivel cancelar a task.");
  }
  return payload.task;
}

export async function cancelWorkGraph(workGraphId: number, reason = ""): Promise<DashboardWorkGraph> {
  const response = await fetch(`/api/work-graphs/${workGraphId}/cancel`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reason })
  });
  const payload = await response.json() as {
    workGraph?: DashboardWorkGraph;
    error?: string;
    details?: string | string[];
  };
  if (!response.ok || !payload.workGraph) {
    const details = Array.isArray(payload.details) ? payload.details.join(" ") : payload.details;
    throw new Error(details || payload.error || "Nao foi possivel cancelar o Work Graph.");
  }
  return payload.workGraph;
}

export async function deleteTask(taskId: number) {
  const response = await fetch(`/api/tasks/${taskId}`, { method: "DELETE" });
  const payload = await response.json() as { task?: DashboardTask; error?: string; details?: string };
  if (!response.ok || !payload.task) {
    throw new Error(payload.details || payload.error || "Nao foi possivel apagar a task.");
  }
  return payload.task;
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

export async function cancelFeature(featureId: number, reason = ""): Promise<DashboardFeature> {
  const response = await fetch(`/api/features/${featureId}/cancel`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reason })
  });
  const payload = await response.json() as { feature?: DashboardFeature; error?: string; details?: string[] };
  if (!response.ok || !payload.feature) {
    throw new Error(payload.details?.join(" ") || payload.error || "Nao foi possivel cancelar a Feature.");
  }
  return payload.feature;
}

export async function fetchFeaturePlan(featurePlanId: number): Promise<FeaturePlanDetails> {
  const response = await fetch(`/api/feature-plans/${featurePlanId}`);
  const payload = await response.json() as FeaturePlanDetails & { error?: string; details?: string[] };
  if (!response.ok || !payload.plan) {
    throw new Error(payload.details?.join(" ") || payload.error || "Nao foi possivel carregar o plano.");
  }
  return payload;
}

export async function createFeaturePlan(input: {
  projectKey: string;
  objective: string;
  acceptanceCriteria: string[];
  taskIds: number[];
  taskContracts?: FeatureTaskContractInput[];
  idempotencyKey?: string | null;
}): Promise<FeaturePlanDetails> {
  const response = await fetch("/api/feature-plans", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });
  const payload = await response.json() as FeaturePlanDetails & { error?: string; details?: string[] };
  if (!response.ok || !payload.plan) {
    throw new Error(payload.details?.join(" ") || payload.error || "Nao foi possivel criar o plano.");
  }
  return payload;
}

export async function cancelFeaturePlan(featurePlanId: number, reason = ""): Promise<FeaturePlanDetails> {
  const response = await fetch(`/api/feature-plans/${featurePlanId}/cancel`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reason })
  });
  const payload = await response.json() as FeaturePlanDetails & { error?: string; details?: string[] };
  if (!response.ok || !payload.plan) {
    throw new Error(payload.details?.join(" ") || payload.error || "Nao foi possivel cancelar o plano.");
  }
  return payload;
}

export async function replanFeaturePlan(
  featurePlanId: number,
  input: {
    objective: string;
    acceptanceCriteria: string[];
    taskIds: number[];
    taskContracts?: FeatureTaskContractInput[];
    idempotencyKey?: string | null;
  }
): Promise<FeaturePlanDetails> {
  const response = await fetch(`/api/feature-plans/${featurePlanId}/replan`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });
  const payload = await response.json() as FeaturePlanDetails & { error?: string; details?: string[] };
  if (!response.ok || !payload.plan) {
    throw new Error(payload.details?.join(" ") || payload.error || "Nao foi possivel replanejar.");
  }
  return payload;
}

export async function pauseFeaturePlan(featurePlanId: number, reason = ""): Promise<FeaturePlanDetails> {
  const response = await fetch(`/api/feature-plans/${featurePlanId}/pause`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reason })
  });
  const payload = await response.json() as FeaturePlanDetails & { error?: string; details?: string[] };
  if (!response.ok || !payload.plan) {
    throw new Error(payload.details?.join(" ") || payload.error || "Nao foi possivel pausar o plano.");
  }
  return payload;
}

export async function resumeFeaturePlan(featurePlanId: number): Promise<FeaturePlanDetails> {
  const response = await fetch(`/api/feature-plans/${featurePlanId}/resume`, {
    method: "POST",
    headers: { "Content-Type": "application/json" }
  });
  const payload = await response.json() as FeaturePlanDetails & { error?: string; details?: string[] };
  if (!response.ok || !payload.plan) {
    throw new Error(payload.details?.join(" ") || payload.error || "Nao foi possivel retomar o plano.");
  }
  return payload;
}

export async function updateFeaturePlanPriority(featurePlanId: number, priority: number): Promise<FeaturePlanDetails> {
  const response = await fetch(`/api/feature-plans/${featurePlanId}/priority`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ priority })
  });
  const payload = await response.json() as FeaturePlanDetails & { error?: string; details?: string[] };
  if (!response.ok || !payload.plan) {
    throw new Error(payload.details?.join(" ") || payload.error || "Nao foi possivel atualizar a prioridade.");
  }
  return payload;
}

export async function retryFeaturePlan(featurePlanId: number, reason = ""): Promise<FeaturePlanDetails> {
  const response = await fetch(`/api/feature-plans/${featurePlanId}/retry`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reason })
  });
  const payload = await response.json() as FeaturePlanDetails & { error?: string; details?: string[] };
  if (!response.ok || !payload.plan) {
    throw new Error(payload.details?.join(" ") || payload.error || "Nao foi possivel tentar novamente o plano.");
  }
  return payload;
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

export async function decideHumanReview(
  runId: number,
  decision: HumanReviewDecision,
  note: string
): Promise<ReviewQueueItem> {
  const response = await fetch(`/api/review-queue/${runId}/decision`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ decision, note })
  });
  const payload = await response.json() as {
    item?: ReviewQueueItem;
    error?: string;
    details?: string;
  };
  if (!response.ok || !payload.item) {
    throw new Error(payload.details || payload.error || "Nao foi possivel registrar a decisao.");
  }
  return payload.item;
}
