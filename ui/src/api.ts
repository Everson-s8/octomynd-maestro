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

export type DashboardTask = {
  id: number;
  projectKey: string | null;
  projectName: string | null;
  text: string;
  status: TaskStatus;
  source: string;
  branchName: string | null;
  worktreePrepared: boolean;
  parentTaskId: number | null;
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

export type DashboardRuntimeUpdate = {
  id: number;
  featureId: number | null;
  targetCommit: string;
  previousCommit: string;
  status: "pending" | "in_progress" | "completed" | "failed" | "rolled_back";
  error: string | null;
  createdAt: string;
  updatedAt: string;
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
    providersConnected: number;
    activeTasks: number;
    queuedTasks: number;
    humanGates: number;
    improvementCandidates: number;
    plannedFeaturePlans: number;
    activeGoals: number;
    completedTasks: number;
  };
  costSummary?: {
    todayTotalUsd: number;
    todayInputTokens: number;
    todayOutputTokens: number;
    byProvider: Array<{
      provider: string;
      costUsd: number;
      inputTokens: number;
      outputTokens: number;
    }>;
    byProject: Array<{
      projectKey: string;
      costUsd: number;
      inputTokens: number;
      outputTokens: number;
    }>;
  };
  projects: DashboardProject[];
  tasks: DashboardTask[];
  events: DashboardEvent[];
  improvements: ImprovementProposal[];
  goals: GoalRun[];
  features: DashboardFeature[];
  featurePlans: DashboardFeaturePlan[];
  workGraphs: DashboardWorkGraph[];
  environments: EnvironmentDoctorReport[];
  reviewQueue: ReviewQueueItem[];
  runtimeUpdate?: DashboardRuntimeUpdate | null;
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

export type AgentProviderId = "codex" | "claude" | "antigravity" | (string & {});
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
  model?: string | null;
  updatedAt: string | null;
};
export type CapabilityRoutingPolicy = {
  capability: AgentCapability;
  order: AgentProviderId[];
  requiredProviderId: AgentProviderId | null;
  preferredModel?: string | null;
  updatedAt: string | null;
};
export type ProviderPolicySnapshot = {
  controls: ProviderControl[];
  capabilities: CapabilityRoutingPolicy[];
  models?: Record<string, string[]>;
};

export async function fetchProviderPolicy(): Promise<ProviderPolicySnapshot & { availableModels?: Record<string, string[]> }> {
  const response = await fetch("/api/provider-policy");
  const payload = await response.json() as { policy?: ProviderPolicySnapshot; models?: Record<string, string[]>; error?: string };
  if (!response.ok || !payload.policy) throw new Error(payload.error || "Nao foi possivel carregar os providers.");
  const controls = Array.isArray(payload.policy.controls) ? payload.policy.controls : [];
  const capabilities = Array.isArray(payload.policy.capabilities) ? payload.policy.capabilities : [];
  return {
    ...payload.policy,
    controls,
    capabilities,
    models: payload.models ?? payload.policy.models,
    availableModels: payload.models ?? payload.policy.models
  };
}

export async function updateProviderControl(
  providerId: AgentProviderId,
  input: Pick<ProviderControl, "mode" | "fallbackEnabled"> & { model?: string | null }
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
  controls: Array<Pick<ProviderControl, "providerId" | "mode" | "fallbackEnabled"> & { model?: string | null }>
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

export interface ProviderConnectionResult {
  ok: boolean;
  detail: string;
  executable: string | null;
  models?: string[];
}

/** Probe whether a provider CLI or endpoint is reachable without persisting it. */
export async function testProviderConnection(input: {
  command?: string;
  args?: string[];
  presetId?: string;
  endpointUrl?: string;
  apiKey?: string;
  apiKeyEnv?: string;
}): Promise<ProviderConnectionResult> {
  const response = await fetch("/api/providers/test-connection", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });
  const payload = await response.json() as ProviderConnectionResult & { error?: string };
  if (!response.ok) throw new Error(payload.detail || payload.error || "Nao foi possivel testar a conexao.");
  return payload;
}

export async function updateCapabilityRouting(
  capability: AgentCapability,
  input: Pick<CapabilityRoutingPolicy, "order" | "requiredProviderId"> & { preferredModel?: string | null }
): Promise<CapabilityRoutingPolicy> {
  const response = await fetch(`/api/provider-policy/capabilities/${capability}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });
  const payload = await response.json() as { routing?: CapabilityRoutingPolicy; error?: string };
  if (!response.ok || !payload.routing) throw new Error(payload.error || "Nao foi possivel atualizar a regra de roteamento.");
  return payload.routing;
}

export type ProviderConnectionMode = "account" | "api_key" | "local" | "custom";

export type ProviderPreset = {
  id: string;
  label: string;
  command: string;
  args: string[];
  envKeys: string[];
  description: string;
  models: string[];
  connectionHint: ProviderConnectionMode;
  category: "account" | "api" | "local";
  docsUrl: string;
  setupCommand: string | null;
  apiKeyEnv: string | null;
  defaultEndpoint: string | null;
  builtIn: boolean;
  authFlow: "device_code" | "terminal" | "none";
  authArgs: string[];
  authStatusArgs: string[];
  modelDiscovery: "cli" | "endpoint" | "ollama" | "manual";
};

export type ProviderAuthSession = {
  id: string;
  presetId: string;
  state: "waiting" | "connected" | "failed" | "cancelled";
  verificationUrl: string | null;
  userCode: string | null;
  detail: string;
  startedAt: string;
  completedAt: string | null;
};

export type RegisteredCustomProvider = {
  id: string;
  label: string;
  command: string;
  args?: string[];
  envKeys?: string[];
  model?: string | null;
  models?: string[];
  presetId?: string;
  connectionMode?: ProviderConnectionMode;
  endpointUrl?: string | null;
  apiKeyEnv?: string | null;
  docsUrl?: string | null;
  setupCommand?: string | null;
};

export type RegisterProviderInput = {
  id: string;
  label?: string;
  command: string;
  args?: string[];
  model?: string | null;
  envKeys?: string[];
  presetId?: string;
  connectionMode?: ProviderConnectionMode;
  endpointUrl?: string | null;
  apiKey?: string;
  apiKeyEnv?: string;
  models?: string[];
};

export type RegisterProviderResult = {
  provider?: RegisteredCustomProvider;
  envPath: string;
  providers: RegisteredCustomProvider[];
  error?: string;
};

export async function fetchProviderPresets(): Promise<{ presets: ProviderPreset[]; registered: RegisteredCustomProvider[] }> {
  const response = await fetch("/api/providers/presets");
  const payload = await response.json() as { presets?: ProviderPreset[]; registered?: RegisteredCustomProvider[]; error?: string };
  if (!response.ok) throw new Error(payload.error || "Nao foi possivel carregar presets de providers.");
  return { presets: payload.presets ?? [], registered: payload.registered ?? [] };
}

export async function fetchRegisteredProviders(): Promise<RegisteredCustomProvider[]> {
  const response = await fetch("/api/providers/registered");
  const payload = await response.json() as { providers?: RegisteredCustomProvider[]; error?: string };
  if (!response.ok) throw new Error(payload.error || "Nao foi possivel carregar providers registrados.");
  return payload.providers ?? [];
}

export async function registerProvider(input: RegisterProviderInput): Promise<RegisterProviderResult> {
  const response = await fetch("/api/providers/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });
  const payload = await response.json() as RegisterProviderResult;
  if (!response.ok) throw new Error(payload.error || "Nao foi possivel registrar o provider.");
  return payload;
}

export async function deleteProvider(providerId: string): Promise<RegisteredCustomProvider[]> {
  const response = await fetch(`/api/providers/${encodeURIComponent(providerId)}`, { method: "DELETE" });
  const payload = await response.json() as { removed?: boolean; providers?: RegisteredCustomProvider[]; error?: string };
  if (!response.ok) throw new Error(payload.error || "Nao foi possivel remover o provider.");
  return payload.providers ?? [];
}

export async function discoverProviderModels(input: {
  presetId?: string;
  endpointUrl?: string;
  apiKey?: string;
  apiKeyEnv?: string;
}): Promise<string[]> {
  const response = await fetch("/api/providers/discover-models", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });
  const payload = await response.json() as { models?: string[]; error?: string; detail?: string };
  if (!response.ok) throw new Error(payload.detail || payload.error || "Nao foi possivel descobrir os modelos.");
  return payload.models ?? [];
}

export async function startProviderAuth(presetId: string): Promise<ProviderAuthSession> {
  const response = await fetch("/api/providers/auth/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ presetId })
  });
  const payload = await response.json() as { session?: ProviderAuthSession; error?: string };
  if (!response.ok || !payload.session) throw new Error(payload.error || "Nao foi possivel iniciar a autenticacao.");
  return payload.session;
}

export async function fetchProviderAuth(sessionId: string): Promise<ProviderAuthSession> {
  const response = await fetch(`/api/providers/auth/${encodeURIComponent(sessionId)}`);
  const payload = await response.json() as { session?: ProviderAuthSession; error?: string };
  if (!response.ok || !payload.session) throw new Error(payload.error || "Sessao de autenticacao nao encontrada.");
  return payload.session;
}

export async function cancelProviderAuth(sessionId: string): Promise<ProviderAuthSession> {
  const response = await fetch(`/api/providers/auth/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
  const payload = await response.json() as { session?: ProviderAuthSession; error?: string };
  if (!response.ok || !payload.session) throw new Error(payload.error || "Nao foi possivel cancelar a autenticacao.");
  return payload.session;
}

export type ConnectTelegramInput = {
  botToken: string;
  allowedUserId?: string;
};

export type ConnectTelegramResult = {
  ok: boolean;
  botInfo?: { id: number; username: string; first_name: string };
  allowedUserId?: string | null;
  envPath?: string;
  botRestarted?: boolean;
};

export async function connectTelegram(input: ConnectTelegramInput): Promise<ConnectTelegramResult> {
  const response = await fetch("/api/telegram/connect", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });
  const payload = (await response.json()) as {
    ok?: boolean;
    botInfo?: { id: number; username: string; first_name: string };
    allowedUserId?: string | null;
    envPath?: string;
    botRestarted?: boolean;
    error?: string;
    message?: string;
  };
  if (!response.ok || !payload.ok) {
    throw new Error(payload.message || payload.error || "Falha ao conectar Telegram bot.");
  }
  return {
    ok: true,
    botInfo: payload.botInfo,
    allowedUserId: payload.allowedUserId,
    envPath: payload.envPath,
    botRestarted: payload.botRestarted
  };
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

export type GoalRunStatus = "running" | "waiting_provider" | "completed" | "blocked" | "failed" | "cancelled";

export type GoalRun = {
  id: number;
  taskId: number;
  status: GoalRunStatus;
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
  let response: Response | null = null;
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      response = await fetch("/api/dashboard", { signal, cache: "no-store" });
      if (response.ok || (response.status < 500 && response.status !== 429)) break;
    } catch (error) {
      if (signal?.aborted) throw error;
      lastError = error;
    }
    if (attempt < 2) {
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    }
  }
  if (!response) {
    throw lastError instanceof Error ? lastError : new Error("Dashboard indisponível.");
  }
  if (!response.ok) {
    throw new Error(`Dashboard indisponível (${response.status}).`);
  }
  const payload = await response.json() as Partial<DashboardData> | null;
  if (!payload || typeof payload !== "object") {
    throw new Error("O dashboard retornou uma resposta inválida.");
  }

  const costSummary = payload.costSummary;
  return {
    ...payload,
    generatedAt: payload.generatedAt ?? new Date().toISOString(),
    daemon: payload.daemon ?? {
      name: "octomynd-maestro",
      state: "online",
      access: "restricted",
      dashboardHost: "127.0.0.1"
    },
    autopilot: payload.autopilot ?? {
      enabled: false,
      state: "disabled",
      maxConcurrentGoals: 0,
      pollIntervalMs: 0,
      runningGoals: 0,
      waitingProviderGoals: 0,
      queuedTasks: 0,
      lastAction: "",
      lastTickAt: null
    },
    summary: payload.summary ?? {
      projects: 0,
      providersConnected: 0,
      activeTasks: 0,
      queuedTasks: 0,
      humanGates: 0,
      improvementCandidates: 0,
      plannedFeaturePlans: 0,
      activeGoals: 0,
      completedTasks: 0
    },
    costSummary: {
      todayTotalUsd: costSummary?.todayTotalUsd ?? 0,
      todayInputTokens: costSummary?.todayInputTokens ?? 0,
      todayOutputTokens: costSummary?.todayOutputTokens ?? 0,
      byProvider: Array.isArray(costSummary?.byProvider) ? costSummary.byProvider : [],
      byProject: Array.isArray(costSummary?.byProject) ? costSummary.byProject : []
    },
    projects: Array.isArray(payload.projects) ? payload.projects : [],
    tasks: Array.isArray(payload.tasks) ? payload.tasks : [],
    events: Array.isArray(payload.events) ? payload.events : [],
    improvements: Array.isArray(payload.improvements) ? payload.improvements : [],
    goals: Array.isArray(payload.goals) ? payload.goals : [],
    features: Array.isArray(payload.features) ? payload.features : [],
    featurePlans: Array.isArray(payload.featurePlans)
      ? payload.featurePlans.map((plan) => ({
          ...plan,
          taskIds: Array.isArray(plan.taskIds) ? plan.taskIds : [],
          tasks: Array.isArray(plan.tasks) ? plan.tasks : [],
          blockers: Array.isArray(plan.blockers) ? plan.blockers : [],
          dependsOnFeaturePlanIds: Array.isArray(plan.dependsOnFeaturePlanIds)
            ? plan.dependsOnFeaturePlanIds
            : []
        }))
      : [],
    workGraphs: Array.isArray(payload.workGraphs) ? payload.workGraphs : [],
    environments: Array.isArray(payload.environments) ? payload.environments : [],
    reviewQueue: Array.isArray(payload.reviewQueue) ? payload.reviewQueue : [],
    agents: Array.isArray(payload.agents) ? payload.agents : []
  } as DashboardData;
}

export type PreviewWorkIntakeInput = {
  projectKey?: string;
  objective: string;
  acceptanceCriteria?: string[];
  coordination?: {
    dependsOnCount?: number;
    parallelWorkstreamCount?: number;
    requiresMultipleReviewGates?: boolean;
  };
  costEstimate?: {
    estimatedFileTouchCount?: number;
    estimatedWorkstreamCount?: number;
  };
  explicitOverride?: "direct_task" | "feature_plan" | "needs_clarification" | null;
};

export type WorkIntakePreviewResult = {
  decision: {
    id: string;
    projectKey: string | null;
    objective: string;
    classification: "direct_task" | "feature_plan" | "needs_clarification";
    reasonCode: string;
    confidence: number;
    policyVersion: number;
    acceptanceCriteria: string[];
    explicitOverride: "direct_task" | "feature_plan" | "needs_clarification" | null;
  };
  explanation: string;
};

export type SubmitWorkIntakeInput = PreviewWorkIntakeInput & {
  intakeId?: string;
};

export type SubmitWorkIntakeResult = {
  status: "created" | "already_created" | "needs_clarification";
  createdType: "task" | "feature_plan" | "none";
  task?: DashboardTask;
  featurePlan?: unknown;
  decision: WorkIntakePreviewResult["decision"];
  explanation: string;
};

export async function previewWorkIntake(input: PreviewWorkIntakeInput): Promise<WorkIntakePreviewResult> {
  const response = await fetch("/api/work-intake/preview", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(payload.error || `Não foi possível analisar a demanda (${response.status}).`);
  }
  return response.json();
}

export async function submitWorkIntake(input: SubmitWorkIntakeInput): Promise<SubmitWorkIntakeResult> {
  const response = await fetch("/api/work-intake", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(payload.error || `Não foi possível submeter a demanda (${response.status}).`);
  }
  return response.json();
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

export async function createFollowUpTask(taskId: number, text: string) {
  const response = await fetch(`/api/tasks/${taskId}/follow-up`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text })
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as { error?: string; details?: string[] | string };
    const details = Array.isArray(payload.details) ? payload.details.join(" ") : payload.details;
    throw new Error(details || payload.error || "Não foi possível criar a task de continuidade.");
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

export type GovernedChatAction = {
  id: string;
  type: string;
  label: string;
  description: string;
  targetId: string | number;
  payload?: Record<string, any>;
};

export type OperationalChatMessage = {
  id: number;
  projectKey: string;
  surface: "dashboard" | "telegram";
  senderRole: "user" | "orchestrator" | "system";
  messageText: string;
  evidenceJson?: string | null;
  actionTaken?: string | null;
  createdAt: string;
};

export type OperationalChatResponse = {
  messageId: number;
  projectKey: string;
  surface: "dashboard" | "telegram";
  explanation: string;
  evidence: any;
  actions: GovernedChatAction[];
  providerId?: string;
  createdAt: string;
};

export type OperationalChatActionResult = {
  success: boolean;
  actionTaken: string;
  resultSummary: string;
  updatedEvidence?: any;
};

export async function fetchChatMessages(projectKey: string, limit = 50): Promise<OperationalChatMessage[]> {
  const response = await fetch(`/api/chat/messages?projectKey=${encodeURIComponent(projectKey)}&limit=${limit}`);
  const payload = await response.json() as { messages?: OperationalChatMessage[]; error?: string };
  if (!response.ok || !payload.messages) {
    throw new Error(payload.error || "Nao foi possivel carregar o historico de chat.");
  }
  return payload.messages;
}

export async function sendChatMessage(projectKey: string, message: string): Promise<OperationalChatResponse> {
  const response = await fetch("/api/chat/ask", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projectKey, message, surface: "dashboard" })
  });
  const payload = await response.json() as OperationalChatResponse & { error?: string; details?: string };
  if (!response.ok || !payload.explanation) {
    throw new Error(payload.details || payload.error || "Falha no envio da mensagem.");
  }
  return payload;
}

export async function executeChatAction(projectKey: string, action: GovernedChatAction): Promise<OperationalChatActionResult> {
  const response = await fetch("/api/chat/action", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projectKey, action, surface: "dashboard" })
  });
  const payload = await response.json() as OperationalChatActionResult & { error?: string; details?: string };
  if (!response.ok || payload.success === undefined) {
    throw new Error(payload.details || payload.error || "Falha na execucao da acao governada.");
  }
  return payload;
}

export type RegisterProjectInput = {
  key: string;
  path?: string;
  remoteUrl?: string;
  name?: string;
  defaultBranch?: string;
  description?: string;
  mode?: "github" | "localremote" | "local";
};

export type RegisterProjectResult = {
  project: {
    id: number;
    key: string;
    name: string;
    path: string;
    defaultBranch: string;
    createdAt: string;
    updatedAt: string;
  };
  warnings: string[];
};

export async function registerProject(input: RegisterProjectInput): Promise<RegisterProjectResult> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 120_000);
  let response: Response;
  try {
    response = await fetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
      signal: controller.signal
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error("O registro do projeto demorou mais de 2 minutos. Verifique o Git e tente novamente.");
    }
    throw new Error("Não foi possível manter a conexão com o Maestro. Confirme que o HG está ativo e tente novamente.");
  } finally {
    window.clearTimeout(timeout);
  }
  const payload = await response.json().catch(() => ({})) as RegisterProjectResult & { error?: string; details?: string[] | string };
  if (!response.ok || !payload.project) {
    const detailMsg = Array.isArray(payload.details)
      ? payload.details.join(", ")
      : payload.details || payload.error || "Falha ao registrar projeto.";
    throw new Error(detailMsg);
  }
  return payload;
}

// ---- Quota / rate-limit usage indicator ----

export type QuotaWindowKind = "5h" | "weekly" | "daily" | "unknown";

export type QuotaBucket = {
  provider: string;
  modelId: string | null;
  usedPercent: number | null;
  remainingPercent: number | null;
  resetsAt: string | null;
  windowMinutes: number | null;
  windowKind: QuotaWindowKind;
  planType: string | null;
  detail?: string;
};

export type QuotaResult = {
  provider: string;
  status: "ok" | "unavailable" | "error";
  updatedAt: string;
  buckets: QuotaBucket[];
  error: string | null;
  stale?: boolean;
  lastSuccessfulAt?: string;
};

export async function fetchQuota(): Promise<QuotaResult[]> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 20_000);
  let response: Response;
  try {
    response = await fetch("/api/quota", { signal: controller.signal, cache: "no-store" });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error("A leitura de cotas demorou demais; exibindo a última leitura disponível.");
    }
    throw error instanceof Error ? error : new Error("Quota indisponível.");
  } finally {
    window.clearTimeout(timeout);
  }
  if (!response.ok) {
    throw new Error(`Quota indisponível (${response.status}).`);
  }
  const payload = (await response.json()) as { quota?: QuotaResult[] };
  return payload.quota ?? [];
}

// ---- Task Logs ----

export type TaskLogStep = {
  id: number;
  runId: number;
  phase: string;
  provider: string;
  status: "running" | "completed" | "changes_requested" | "failed" | "cancelled";
  summary: string;
  output: string;
  error: string | null;
  durationMs: number | null;
  createdAt: string;
  finishedAt: string | null;
  tokenUsage?: {
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    model: string;
  } | null;
  checkpoint?: {
    id: number;
    runId: number;
    stepId: number;
    phase: string;
    provider: string;
    status: string;
    summary: string;
    objective?: string;
    done?: string[];
    decisions?: string[];
    testsRun?: Array<{ command: string; result: string }>;
    knownFailures?: string[];
    remaining?: string[];
    workspaceFingerprint: string | null;
    changedFiles: string[];
    artifactKeys: string[];
    createdAt: string;
  } | null;
};

export type TaskLogRun = {
  id: number;
  taskId: number;
  status: GoalRunStatus;
  currentPhase: string;
  stepCount: number;
  maxSteps: number;
  lastError: string | null;
  failureCategory?: string | null;
  waitReason?: string | null;
  nextRetryAt?: string | null;
  lastProvider?: string | null;
  commitSha: string | null;
  pullRequestUrl: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
  steps: TaskLogStep[];
  checkpoints: Array<{
    id: number;
    runId: number;
    stepId: number;
    phase: string;
    provider: string;
    status: string;
    summary: string;
    objective?: string;
    done?: string[];
    decisions?: string[];
    testsRun?: Array<{ command: string; result: string }>;
    knownFailures?: string[];
    remaining?: string[];
    workspaceFingerprint: string | null;
    changedFiles: string[];
    artifactKeys: string[];
    createdAt: string;
  }>;
  tokenUsage: Array<{
    id: number;
    runId: number;
    stepId: number;
    provider: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    createdAt: string;
  }>;
  skillPins: Array<{
    id: number;
    runId: number;
    skillVersionRecordId: number;
    triggerReason: string;
    pinnedAt: string;
    unpinnedAt: string | null;
  }>;
  workGraph?: DashboardWorkGraph | null;
};

export type TaskLogsTelemetry = {
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalDurationMs: number;
  totalSteps: number;
  changedFiles: string[];
  activeRunId: number | null;
  isRunning: boolean;
  isFinished: boolean;
};

export type TaskLogs = {
  task: DashboardTask;
  runs: TaskLogRun[];
  events: DashboardEvent[];
  reviews: TaskReview[];
  workGraphs: DashboardWorkGraph[];
  telemetry: TaskLogsTelemetry;
};

export async function fetchTaskLogs(taskId: number): Promise<TaskLogs> {
  const response = await fetch(`/api/tasks/${taskId}/logs`);
  if (!response.ok) {
    if (response.status === 404) {
      throw new Error(`Task #${taskId} não encontrada.`);
    }
    throw new Error(`Falha ao carregar logs da task #${taskId} (${response.status}).`);
  }
  const payload = await response.json() as { logs: TaskLogs };
    return payload.logs;
}
