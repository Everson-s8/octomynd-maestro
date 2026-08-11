import { TaskStatus, FeatureStatus, AgentCapability, ReviewQueueItem } from "./api";

export const taskStatusLabels: Record<TaskStatus, string> = {
  queued: "na fila",
  planning: "planejando",
  implementing: "construindo",
  testing: "testando",
  reviewing: "revisando",
  changes_requested: "ajustes pedidos",
  awaiting_human: "aprovação humana",
  ready_to_merge: "pronta para merge",
  rejected: "rejeitada",
  waiting_quota: "aguardando cota",
  waiting_provider: "aguardando provider",
  waiting_dependency: "aguardando dependencia",
  blocked: "bloqueada",
  failed: "falhou",
  cancelled: "cancelada",
  done: "concluída"
};

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
  reviewing: "review final",
  waiting_provider: "sem provider",
  changes_requested: "ajustes",
  merging: "merge",
  completed: "concluida",
  failed: "falhou",
  cancelled: "cancelada"
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
  if (seconds < 10) return "agora";
  if (seconds < 60) return `há ${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `há ${minutes}min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `há ${hours}h`;
  return new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "short" }).format(new Date(value));
}

export function humanizeEvent(value: string): string {
  const labels: Record<string, string> = {
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
  return labels[value] ?? value.replaceAll(".", " · ").replaceAll("_", " ");
}

export function capabilityLabel(capability: AgentCapability): string {
  return ({
    planning: "Planejamento",
    coding: "Implementacao",
    testing: "Testes",
    reviewing: "Review final",
    improvement_reviewing: "Auto-melhoria",
    research: "Pesquisa",
    conversation: "Conversa"
  } as Record<AgentCapability, string>)[capability];
}

export function changeSafetyGateClass(status: ReviewQueueItem["changeSafetyGate"]["status"]): string {
  return {
    passed: "is-safe",
    blocked: "is-danger",
    unavailable: "is-warning"
  }[status];
}

export function changeSafetyGateLabel(status: ReviewQueueItem["changeSafetyGate"]["status"]): string {
  return {
    passed: "guard passou",
    blocked: "alerta de segurança",
    unavailable: "verificação indisponível"
  }[status];
}
