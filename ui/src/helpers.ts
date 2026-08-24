import { TaskStatus, FeatureStatus, AgentCapability, ReviewQueueItem } from "./api";
import { getLocale, statusLabel, translate } from "./i18n";

export const taskStatusLabels: Record<TaskStatus, string> = {
  queued: "Queued",
  planning: "Planning",
  implementing: "Implementing",
  testing: "Testing",
  reviewing: "Reviewing",
  changes_requested: "Changes requested",
  awaiting_human: "Awaiting human approval",
  ready_to_merge: "Ready to merge",
  rejected: "Rejected",
  waiting_quota: "Waiting for quota",
  waiting_provider: "Waiting for provider",
  waiting_dependency: "Waiting for dependency",
  blocked: "Blocked",
  failed: "Failed",
  cancelled: "Cancelled",
  done: "Completed"
};

export function taskStatusLabel(status: TaskStatus): string {
  return statusLabel(status);
}

export const statusOrder: TaskStatus[] = [
  "implementing",
  "testing",
  "reviewing",
  "planning",
  "queued",
  "awaiting_human",
  "ready_to_merge",
  "waiting_quota",
  "waiting_provider",
  "waiting_dependency",
  "changes_requested",
  "blocked",
  "failed",
  "rejected",
  "cancelled",
  "done"
];

export const featureStatusLabels: Record<FeatureStatus, string> = {
  draft: "draft",
  waiting_checks: "checks",
  reviewing: "Final review",
  waiting_provider: "No provider",
  changes_requested: "Changes requested",
  merging: "merge",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled"
};

export const featureStatusOrder: FeatureStatus[] = [
  "reviewing",
  "merging",
  "waiting_provider",
  "waiting_checks",
  "changes_requested",
  "draft",
  "failed",
  "completed",
  "cancelled"
];

export function statusProgress(status: TaskStatus): number {
  return {
    queued: 10,
    planning: 24,
    implementing: 48,
    testing: 68,
    reviewing: 82,
    changes_requested: 58,
    awaiting_human: 90,
    ready_to_merge: 96,
    waiting_quota: 36,
    waiting_provider: 36,
    waiting_dependency: 16,
    blocked: 42,
    failed: 100,
    rejected: 100,
    cancelled: 100,
    done: 100
  }[status];
}

export function featureProgress(status: FeatureStatus): number {
  return {
    draft: 12,
    waiting_checks: 34,
    reviewing: 58,
    waiting_provider: 48,
    changes_requested: 30,
    merging: 86,
    completed: 100,
    failed: 100,
    cancelled: 100
  }[status];
}

export function formatRelative(value: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 10) return translate("just now");
  if (seconds < 60) return getLocale() === "pt-BR" ? `há ${seconds}s` : `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return getLocale() === "pt-BR" ? `há ${minutes}min` : `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return getLocale() === "pt-BR" ? `há ${hours}h` : `${hours}h ago`;
  return new Intl.DateTimeFormat(getLocale() === "pt-BR" ? "pt-BR" : "en-US", { day: "2-digit", month: "short" }).format(new Date(value));
}

export function humanizeEvent(value: string): string {
  const labels: Record<string, string> = {
    "task.created": "Task created",
    "task.prepared": "Worktree prepared",
    "task.prepare_failed": "Preparation failed",
    "task.validation_passed": "Validation passed",
    "project.registered": "Project registered",
    "command.status": "Status checked",
    "command.projects": "Projects checked",
    "command.queue": "Queue checked",
    "command.start": "Bot started",
    "feedback.received": "Feedback received",
    "task.reviewed": "Claude review completed",
    "task.review_failed": "Claude review failed"
  };
  const portugueseLabels: Record<string, string> = {
    "task.created": "Task criada",
    "task.prepared": "Worktree preparada",
    "task.prepare_failed": "Preparação falhou",
    "task.validation_passed": "Validação passou",
    "project.registered": "Projeto registrado",
    "command.status": "Status consultado",
    "command.projects": "Projetos consultados",
    "command.queue": "Fila consultada",
    "command.start": "Bot iniciado",
    "feedback.received": "Feedback recebido",
    "task.reviewed": "Revisão do Claude concluída",
    "task.review_failed": "Revisão do Claude falhou"
  };
  return getLocale() === "pt-BR" ? (portugueseLabels[value] ?? value.replaceAll(".", " · ").replaceAll("_", " ")) : (labels[value] ?? value.replaceAll(".", " · ").replaceAll("_", " "));
}

export function capabilityLabel(capability: AgentCapability): string {
  const labels = ({
    planning: "Planning",
    coding: "Implementation",
    testing: "Testing",
    reviewing: "Final review",
    improvement_reviewing: "Self-improvement",
    research: "Research",
    conversation: "Conversation"
  } as Record<AgentCapability, string>)[capability];
  return translate(labels);
}

export function changeSafetyGateClass(status: ReviewQueueItem["changeSafetyGate"]["status"]): string {
  return {
    passed: "is-safe",
    blocked: "is-danger",
    unavailable: "is-warning"
  }[status];
}

export function changeSafetyGateLabel(status: ReviewQueueItem["changeSafetyGate"]["status"]): string {
  const label = {
    passed: "Guard passed",
    blocked: "Security warning",
    unavailable: "Verification unavailable"
  }[status];
  return translate(label);
}
