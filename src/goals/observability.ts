import { MaestroDatabase, GoalRunRecord, GoalWaitReason } from "../db.js";
import { classifyFailure, failureCategoryLabel, FailureCategory, isRetryableFailureCategory } from "../agents/failure.js";
import { redactSensitiveText } from "../security/redaction.js";

export type GoalObservabilitySnapshot = {
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

const WAIT_REASON_LABELS: Record<string, string> = {
  quota: "cota do provedor esgotada",
  auth_required: "autenticacao necessaria",
  timeout: "tempo limite excedido",
  output_limit: "limite de output do provedor atingido",
  offline: "provedor indisponivel",
  capacity: "nenhum provedor com capacidade disponivel",
  runtime_restart: "reinicio do runtime Maestro",
  budget_exhausted: "orcamento de etapas da Goal esgotado",
  small_task_failure_limit: "falha repetida em task pequena; escopo deve ser reduzido",
  task_split_required: "falhas consecutivas; task deve ser dividida em sub-tasks menores",
  prompt_too_large: "tamanho do prompt excedido (ENAMETOOLONG/E2BIG)",
  unknown: "erro desconhecido do provedor"
};

export function formatReasonLabel(reason: string): string {
  return WAIT_REASON_LABELS[reason] ?? failureCategoryLabel(reason as FailureCategory);
}

export function buildGoalObservability(
  database: MaestroDatabase,
  goal: GoalRunRecord
): GoalObservabilitySnapshot {
  const latestCheckpoint = database.getLatestGoalCheckpoint(goal.id);
  const events = database.listEvents(100).filter((e) => e.taskId === goal.taskId);
  const fallbackEvent = events.find((e) => e.type === "goal.provider_fallback" && e.metadata?.runId === goal.id);
  const waitEvent = events.find((e) => e.type === "goal.waiting_provider" && e.metadata?.runId === goal.id);
  const terminalEvent = events.find((e) => (e.type === "goal.blocked" || e.type === "goal.failed") && e.metadata?.runId === goal.id);

  const rawReason = goal.waitReason
    ?? (fallbackEvent?.metadata?.failureCategory as string)
    ?? (waitEvent?.metadata?.waitReason as string)
    ?? (terminalEvent?.metadata?.failureCategory as string)
    ?? (goal.lastError ? classifyFailure(goal.lastError) : null);

  const classifiedReason = rawReason ?? null;
  const classifiedReasonLabel = classifiedReason ? formatReasonLabel(classifiedReason) : null;

  const sourceProvider = classifiedReason === "budget_exhausted" ? null : (fallbackEvent?.metadata?.fromProvider as string | undefined)
    ?? (waitEvent?.metadata?.fromProvider as string | undefined)
    ?? (terminalEvent?.metadata?.lastProvider as string | undefined)
    ?? goal.lastProvider
    ?? null;

  const terminal = goal.status === "blocked"
    || goal.status === "failed"
    || goal.status === "completed"
    || goal.status === "cancelled";
  const nextProvider = terminal
    ? null
    : (fallbackEvent?.metadata?.toProvider as string | undefined)
      ?? (waitEvent?.metadata?.toProvider as string | undefined)
      ?? (waitEvent?.metadata?.provider as string | undefined)
      ?? null;

  const checkpointId = latestCheckpoint?.id
    ?? (fallbackEvent?.metadata?.resumeCheckpointId as number)
    ?? (waitEvent?.metadata?.resumeCheckpointId as number)
    ?? (terminalEvent?.metadata?.resumeCheckpointId as number)
    ?? null;

  const preservedFiles = latestCheckpoint?.changedFiles
    ?? (fallbackEvent?.metadata?.preservedFiles as string[])
    ?? (waitEvent?.metadata?.preservedFiles as string[])
    ?? (terminalEvent?.metadata?.preservedFiles as string[])
    ?? [];

  const preservedChanges = preservedFiles.length > 0 || Boolean(latestCheckpoint);

  const retryable = goal.status === "waiting_provider"
    || Boolean(fallbackEvent?.metadata?.retryable)
    || (classifiedReason === "budget_exhausted"
      ? false
      : classifiedReason ? isRetryableFailureCategory(classifiedReason as FailureCategory) : false);

  const nextAction = determineNextAction({
    status: goal.status,
    waitReason: classifiedReason,
    nextRetryAt: goal.nextRetryAt ?? null,
    nextProvider,
    retryable,
    fromProvider: sourceProvider
  });

  return {
    classifiedReason,
    classifiedReasonLabel,
    sourceProvider,
    nextProvider,
    preservedChanges,
    preservedFiles,
    checkpointId,
    retryable,
    nextAction
  };
}

function determineNextAction(input: {
  status: string;
  waitReason: string | null;
  nextRetryAt: string | null;
  nextProvider: string | null;
  retryable: boolean;
  fromProvider: string | null;
}): string {
  if (input.status === "completed") {
    return "Goal concluida com sucesso.";
  }
  if (input.status === "cancelled") {
    return "Goal cancelada pelo usuario.";
  }
  if (input.status === "running") {
    if (input.fromProvider && input.nextProvider && input.fromProvider !== input.nextProvider) {
      return `Handoff automatico de ${input.fromProvider} para ${input.nextProvider}.`;
    }
    return "Executando o proximo passo da goal.";
  }
  if (input.status === "waiting_provider") {
    if (input.nextRetryAt) {
      const timeStr = formatRetryTime(input.nextRetryAt);
      return `Retomada automatica agendada para ${timeStr}.`;
    }
    if (input.nextProvider) {
      return `Aguardando liberacao do provedor ${input.nextProvider}.`;
    }
    return "Aguardando liberacao de cota ou capacidade do provedor.";
  }
  if (input.retryable) {
    return "Falha transitoria detectada. Maestro agendou nova tentativa.";
  }
  if (input.waitReason === "budget_exhausted") {
    return "O trabalho preservado atingiu o limite de etapas da Goal. Continue a Goal a partir do checkpoint ou aumente o budget apos revisar o escopo.";
  }
  return "Interrupcao definitiva. Requer intervencao manual ou alteracao de politicas de provider.";
}

function formatRetryTime(nextRetryAt: string): string {
  const date = new Date(nextRetryAt);
  if (!Number.isFinite(date.getTime())) return nextRetryAt;
  return date.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
