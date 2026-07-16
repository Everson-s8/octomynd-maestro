import type { AgentCapability, AgentOutcome, AgentProviderId } from "../agents/types.js";

export type WorkGraphStatus =
  | "draft"
  | "validated"
  | "running"
  | "waiting_provider"
  | "completed"
  | "blocked"
  | "cancelled";

export type WorkerRole = "researcher" | "planner" | "implementer" | "tester" | "reviewer";
export type WorkerMode = "read_only" | "writer";
export type WorkerNodeStatus =
  | "pending"
  | "ready"
  | "running"
  | "waiting_provider"
  | "completed"
  | "blocked"
  | "failed"
  | "cancelled";
export type WorkerAttemptStatus = "running" | AgentOutcome;
export type WorkerArtifactKind = "handoff" | "report" | "patch" | "test" | "log";

export type WorkerBudget = {
  maxAttempts: number;
  deadlineMs: number;
  outputChars: number;
};

export type WorkerNodeInput = {
  key: string;
  role: WorkerRole;
  objective: string;
  capability: AgentCapability;
  dependsOn?: string[];
  inputArtifacts?: string[];
  outputContract: string;
  skillVersions?: string[];
  mode: WorkerMode;
  writeScope?: string[];
  budget: WorkerBudget;
};

export type WorkGraphInput = {
  runId: number;
  objective: string;
  maxParallelReaders?: number;
  nodes: WorkerNodeInput[];
};

export type WorkGraphRecord = {
  id: number;
  runId: number;
  objective: string;
  status: WorkGraphStatus;
  maxParallelReaders: number;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
};

export type WorkerNodeRecord = {
  id: number;
  graphId: number;
  key: string;
  position: number;
  role: WorkerRole;
  objective: string;
  capability: AgentCapability;
  dependsOn: string[];
  inputArtifacts: string[];
  outputContract: string;
  skillVersions: string[];
  mode: WorkerMode;
  writeScope: string[];
  maxAttempts: number;
  deadlineMs: number;
  outputChars: number;
  status: WorkerNodeStatus;
  attemptCount: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};

export type WorkerAttemptRecord = {
  id: number;
  nodeId: number;
  attemptNumber: number;
  provider: AgentProviderId;
  status: WorkerAttemptStatus;
  summary: string;
  error: string | null;
  durationMs: number | null;
  createdAt: string;
  finishedAt: string | null;
};

export type WorkerArtifactRecord = {
  id: number;
  graphId: number;
  nodeId: number;
  attemptId: number | null;
  key: string;
  kind: WorkerArtifactKind;
  summary: string;
  contentHash: string | null;
  bytes: number;
  createdAt: string;
};

export type WorkGraphDetails = WorkGraphRecord & {
  nodes: WorkerNodeRecord[];
};

export type WorkerExecutionContext = {
  graphId: number;
  nodeId: number;
  key: string;
  role: WorkerRole;
  objective: string;
  outputContract: string;
  mode: WorkerMode;
  writeScope: string[];
  inputArtifacts: Array<{ key: string; summary: string }>;
};
