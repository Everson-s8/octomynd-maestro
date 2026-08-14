import type { GoalPhase, GoalStepRecord, ProjectRecord, TaskRecord } from "../db.js";
import type { TokenEfficientHandoffStep } from "../runtime/compression.js";
import type { RtkDetection } from "../runtime/rtk.js";
import type { AgentProcessBreakerReason, AgentProcessResult } from "./process.js";
import type { SkillExecutionContext } from "../skills/types.js";
import type { WorkerExecutionContext } from "../work-graphs/types.js";
import type {
  ImprovementReviewExecutionRequest,
  ImprovementReviewExecutionResult
} from "../improvements/reviewer.js";
import type { FailureCategory } from "./failure.js";
import type { FeatureTaskContract } from "../features/task-graph.js";

export type AgentProviderId = "codex" | "claude" | "antigravity" | (string & {});
export type AgentCapability =
  | "planning"
  | "coding"
  | "testing"
  | "reviewing"
  | "improvement_reviewing"
  | "research"
  | "conversation";

export type CustomCliProviderConfig = {
  id: string;
  label: string;
  command: string;
  args?: string[];
  envKeys?: string[];
  capabilities: AgentCapability[];
  healthProbe?: boolean;
  model?: string | null;
  models?: string[];
};
export type AgentHealthState = "ready" | "quota" | "auth_required" | "offline";
export type AgentOutcome = "completed" | "changes_requested" | "blocked" | "failed" | "cancelled";

export type AgentHealth = {
  state: AgentHealthState;
  detail: string;
  checkedAt: string;
};

export type AgentExecutionRequest = {
  runId: number;
  stepNumber: number;
  phase: GoalPhase;
  capability: AgentCapability;
  task: TaskRecord;
  project: ProjectRecord;
  previousSteps: GoalStepRecord[];
  previousStepHandoff?: TokenEfficientHandoffStep[];
  tokenRuntime?: {
    enabled: boolean;
    rtk: RtkDetection;
  };
  humanFeedback?: string | null;
  skillContext?: SkillExecutionContext;
  workerContext?: WorkerExecutionContext;
  resumeContext?: string;
  featureTaskContract?: FeatureTaskContract;
  artifactsRoot: string;
  deadlineAt?: number;
  signal?: AbortSignal;
  model?: string | null;
};

export type NormalizedResult = {
  outcome: AgentOutcome;
  summary: string;
  structuredPayload?: Record<string, unknown> | null;
  failureCategory?: FailureCategory;
  retryable: boolean;
  retryAfterMs?: number;
  artifactsProduced?: string[];
};

export type AgentExecutionResult = NormalizedResult & {
  output: string;
  error: string | null;
  durationMs: number;
  processRuntime?: {
    breakerReason: AgentProcessBreakerReason | null;
    outputStats: AgentProcessResult["outputStats"];
  };
  tokenUsage?: {
    inputTokens: number;
    outputTokens: number;
  };
  model?: string;
};

export interface ProviderAdapter {
  id: AgentProviderId;
  label: string;
  capabilities: ReadonlySet<AgentCapability>;
  model?: string | null;
  health(): Promise<AgentHealth>;
  execute(request: AgentExecutionRequest): Promise<AgentExecutionResult>;
  reviewImprovements?(request: ImprovementReviewExecutionRequest): Promise<ImprovementReviewExecutionResult>;
  models?(): Promise<string[]>;
}

export type AgentProvider = ProviderAdapter;
