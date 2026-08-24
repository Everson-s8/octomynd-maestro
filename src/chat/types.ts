import type { ProjectRecord } from "../db.js";
import type { AgentProviderSnapshot } from "../agents/registry.js";
import type { AgentProviderId } from "../agents/types.js";

export type OperationalChatSurface = "dashboard" | "telegram";
export type OperationalChatSenderRole = "user" | "orchestrator" | "system";
export type ChatAccessMode = "read_only" | "standard" | "full";
export type ChatLocale = "en" | "pt-BR";

/** Sentinel used for conversations that are not attached to a project. */
export const GLOBAL_CHAT_PROJECT_KEY = "__maestro__";

export type OperationalChatThreadRecord = {
  id: number;
  projectKey: string;
  title: string;
  accessMode: ChatAccessMode;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
};

export type OperationalChatThreadInput = {
  projectKey: string;
  title?: string | null;
  accessMode?: ChatAccessMode | null;
  locale?: ChatLocale | null;
};

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
  | "create_task"
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
  threadId: number;
  projectKey: string;
  surface: OperationalChatSurface;
  senderRole: OperationalChatSenderRole;
  messageText: string;
  evidenceJson: string | null;
  actionTaken: string | null;
  createdAt: string;
};

export type OperationalChatMessageInput = {
  threadId?: number | null;
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
  threadId?: number | null;
  surface: OperationalChatSurface;
  message: string;
  userId?: string | null;
  username?: string | null;
  accessMode?: ChatAccessMode | null;
  locale?: ChatLocale | null;
};

export type OperationalChatResponse = {
  messageId: number;
  threadId: number;
  projectKey: string;
  surface: OperationalChatSurface;
  explanation: string;
  evidence: ChatEvidenceContext;
  actions: GovernedChatAction[];
  providerId: AgentProviderId | "deterministic_engine";
  accessMode: ChatAccessMode;
  createdAt: string;
};

export type OperationalChatActionRequest = {
  projectKey: string;
  threadId?: number | null;
  surface: OperationalChatSurface;
  action: GovernedChatAction;
  userId?: string | null;
  username?: string | null;
  accessMode?: ChatAccessMode | null;
  locale?: ChatLocale | null;
};

export type OperationalChatActionResponse = {
  success: boolean;
  actionTaken: string;
  resultSummary: string;
  updatedEvidence?: Partial<ChatEvidenceContext>;
};

export type ChatActionExecutor = {
  taskCreated?(taskId: number): void | Promise<void>;
  retryTask?(taskId: number): void;
  resumeGoal?(runId: number): void;
  cancelTask?(taskId: number): void;
  rerunReview?(taskId: number): void;
};
