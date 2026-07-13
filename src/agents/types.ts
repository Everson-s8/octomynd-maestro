import type { GoalPhase, GoalStepRecord, ProjectRecord, TaskRecord } from "../db.js";
import type { TokenEfficientHandoffStep } from "../runtime/compression.js";
import type { RtkDetection } from "../runtime/rtk.js";

export type AgentProviderId = "codex" | "claude";
export type AgentCapability = "planning" | "coding" | "testing" | "reviewing" | "research" | "conversation";
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
  artifactsRoot: string;
  signal?: AbortSignal;
};

export type AgentExecutionResult = {
  outcome: AgentOutcome;
  summary: string;
  output: string;
  error: string | null;
  durationMs: number;
  retryable: boolean;
};

export interface AgentProvider {
  id: AgentProviderId;
  label: string;
  capabilities: ReadonlySet<AgentCapability>;
  health(): Promise<AgentHealth>;
  execute(request: AgentExecutionRequest): Promise<AgentExecutionResult>;
}
