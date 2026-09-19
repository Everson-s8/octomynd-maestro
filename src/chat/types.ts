import type { ProjectRecord } from "../db.js";
import type { AgentProviderSnapshot } from "../agents/registry.js";
import type { AgentProviderId, AgentReasoningEffort } from "../agents/types.js";
import type { RepositoryState } from "../projects/repository-service.js";
import type { ChatProjectFileFact, ChatProjectGitContext } from "./project-context.js";
import type { ChatCommandEvidence } from "./project-command.js";

export type OperationalChatSurface = "dashboard" | "telegram";
export type OperationalChatSenderRole = "user" | "orchestrator" | "system";
export type ChatAccessMode = "read_only" | "standard" | "approval" | "full";
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
  providerId: AgentProviderId | null;
  model: string | null;
  effort: AgentReasoningEffort | null;
};

export type OperationalChatThreadInput = {
  projectKey: string;
  title?: string | null;
  accessMode?: ChatAccessMode | null;
  /** UI language for labels and governed system messages; not conversation language. */
  uiLocale?: ChatLocale | null;
  providerId?: AgentProviderId | null;
  model?: string | null;
  effort?: AgentReasoningEffort | null;
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

export type ChatEvidenceMemoryFact = {
  id: number;
  text: string;
  kind: "decision" | "preference" | "constraint";
  sourceThreadId: number | null;
  createdAt: string;
  updatedAt: string;
};

export type ChatProjectProcessFact = {
  id: string;
  projectKey: string;
  command: string;
  pid: number | null;
  status: "running" | "exited" | "stopped" | "failed";
  startedAt: string;
  endedAt: string | null;
  exitCode: number | null;
  log: string;
  url: string | null;
};

export type OperationalChatMemoryRecord = ChatEvidenceMemoryFact;

export type ChatEvidenceContext = {
  project: ProjectRecord;
  tasks: ChatEvidenceTaskFact[];
  goals: ChatEvidenceGoalFact[];
  featurePlans: ChatEvidenceFeaturePlanFact[];
  reviews: ChatEvidenceReviewFact[];
  providers: AgentProviderSnapshot[];
  outbox: ChatEvidenceOutboxFact[];
  workGraphs: ChatEvidenceWorkGraphFact[];
  files: ChatProjectFileFact[];
  git: ChatProjectGitContext;
  commands: ChatCommandEvidence[];
  processes: ChatProjectProcessFact[];
  memories: ChatEvidenceMemoryFact[];
  warnings: string[];
  repositoryState?: RepositoryState | null;
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
  | "cancel_task"
  | "code_change_worktree"
  | "code_change_task"
  | "approve_command"
  | "start_project"
  | "list_project_processes"
  | "show_project_process_log"
  | "stop_project_process"
  | "open_project_browser";

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
  providerId: AgentProviderId | "deterministic_engine" | null;
  model: string | null;
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
  providerId?: AgentProviderId | "deterministic_engine" | null;
  model?: string | null;
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
  /** UI language for labels and governed system messages; the model observes the user's message language. */
  uiLocale?: ChatLocale | null;
  /** @deprecated Use uiLocale. Kept for clients from before the language split. */
  locale?: ChatLocale | null;
  /** Explicit selection for this request; omitted means use the thread selection. */
  providerId?: AgentProviderId | null;
  model?: string | null;
  effort?: AgentReasoningEffort | null;
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
  model: string | null;
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
  uiLocale?: ChatLocale | null;
  /** @deprecated Use uiLocale. */
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
