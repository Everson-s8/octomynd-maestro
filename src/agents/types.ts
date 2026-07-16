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

export type AgentProviderId = "codex" | "claude";
export type AgentCapability =
  | "planning"
  | "coding"
  | "testing"
  | "reviewing"
  | "improvement_reviewing"
  | "research"
  | "conversation";
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
  artifactsRoot: string;
  deadlineAt?: number;
  signal?: AbortSignal;
};

export type AgentExecutionResult = {
  outcome: AgentOutcome;
  summary: string;
  output: string;
  error: string | null;
  durationMs: number;
  retryable: boolean;
  retryAfterMs?: number;
  processRuntime?: {
    breakerReason: AgentProcessBreakerReason | null;
    outputStats: AgentProcessResult["outputStats"];
  };
};

export interface AgentProvider {
  id: AgentProviderId;
  label: string;
  capabilities: ReadonlySet<AgentCapability>;
  health(): Promise<AgentHealth>;
  execute(request: AgentExecutionRequest): Promise<AgentExecutionResult>;
  reviewImprovements?(request: ImprovementReviewExecutionRequest): Promise<ImprovementReviewExecutionResult>;
}
