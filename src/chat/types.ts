import type { ProjectRecord } from "../db.js";
import type { AgentProviderSnapshot } from "../agents/registry.js";
import type { AgentProviderId } from "../agents/types.js";

export type OperationalChatSurface = "dashboard" | "telegram";
export type OperationalChatSenderRole = "user" | "orchestrator" | "system";

export type ChatEvidenceTaskFact = {
  id: number;
  text: string;
  status: string;
  source: string;
  branchName: string | null;
  worktreePrepared: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ChatEvidenceGoalFact = {
  runId: number;
  taskId: number;
  phase: string;
  status: string;
  stepCount: number;
  latestStepSummary: string | null;
  error: string | null;
  updatedAt: string;
};

export type ChatEvidenceFeaturePlanFact = {
  id: number;
  objective: string;
  status: string;
  priority: number;
  revision: number;
  eligibility: {
    eligible: boolean;
    reason: string;
    blockedByPaused: boolean;
    blockedByStatus: boolean;
    blockedDependencies: Array<{ id: number; status: string }>;
    blockedByActiveProjectPlan: { id: number; status: string } | null;
  } | null;
  cancelReason: string | null;
  taskCount: number;
  createdAt: string;
};

export type ChatEvidenceReviewFact = {
  id: number;
  taskId: number;
  provider: string;
  status: string;
  content: string | null;
  error: string | null;
  createdAt: string;
};

export type ChatEvidenceOutboxFact = {
  id: number;
  channel: string;
  status: string;
  eventType: string;
  text: string;
  error: string | null;
  createdAt: string;
};

export type ChatEvidenceWorkGraphFact = {
  id: number;
  runId: number;
  status: string;
  phase: string;
  activeNodes: number;
  failedNodes: number;
};

export type ChatEvidenceContext = {
  project: ProjectRecord;
  tasks: ChatEvidenceTaskFact[];
  goals: ChatEvidenceGoalFact[];
  featurePlans: ChatEvidenceFeaturePlanFact[];
  reviews: ChatEvidenceReviewFact[];
  providers: AgentProviderSnapshot[];
  outbox: ChatEvidenceOutboxFact[];
  workGraphs: ChatEvidenceWorkGraphFact[];
  summaryText: string;
};

export type GovernedChatActionType =
  | "unblock_provider"
  | "retry_task"
  | "resume_goal"
  | "rerun_review"
  | "resume_feature_plan"
  | "retry_feature_plan"
  | "cancel_feature_plan"
  | "cancel_task";

export type GovernedChatAction = {
  id: string;
  type: GovernedChatActionType;
  label: string;
  description: string;
  targetId: string | number;
  payload?: Record<string, unknown>;
};

export type OperationalChatMessageRecord = {
  id: number;
  projectKey: string;
  surface: OperationalChatSurface;
  senderRole: OperationalChatSenderRole;
  messageText: string;
  evidenceJson: string | null;
  actionTaken: string | null;
  createdAt: string;
};

export type OperationalChatMessageInput = {
  projectKey: string;
  surface: OperationalChatSurface;
  senderRole: OperationalChatSenderRole;
  messageText: string;
  evidenceJson?: string | null;
  actionTaken?: string | null;
  createdAt?: string;
};

export type OperationalChatRequest = {
  projectKey: string;
  surface: OperationalChatSurface;
  message: string;
  userId?: string | null;
  username?: string | null;
};

export type OperationalChatResponse = {
  messageId: number;
  projectKey: string;
  surface: OperationalChatSurface;
  explanation: string;
  evidence: ChatEvidenceContext;
  actions: GovernedChatAction[];
  providerId: AgentProviderId | "deterministic_engine";
  createdAt: string;
};

export type OperationalChatActionRequest = {
  projectKey: string;
  surface: OperationalChatSurface;
  action: GovernedChatAction;
  userId?: string | null;
  username?: string | null;
};

export type OperationalChatActionResponse = {
  success: boolean;
  actionTaken: string;
  resultSummary: string;
  updatedEvidence?: Partial<ChatEvidenceContext>;
};

export type ChatActionExecutor = {
  retryTask?(taskId: number): void;
  resumeGoal?(taskId: number): void;
  cancelTask?(taskId: number): void;
  rerunReview?(taskId: number): void;
};
