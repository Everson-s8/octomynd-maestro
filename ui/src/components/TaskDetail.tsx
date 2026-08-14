import { useEffect, useState } from "react";
import {
  cancelTask,
  deleteTask,
  DashboardTask,
  fetchTaskReviews,
  GoalRun,
  prepareTask,
  requestClaudeReview,
  startTaskGoal,
  TaskReview
} from "../api";
import { formatRelative } from "../helpers";
import { Icon } from "./Icon";
import { StatusPill } from "./StatusBadge";

export function TaskDetail({
  task,
  goal,
  onClose,
  onPrepared,
  onDeleted
}: {
  task: DashboardTask | null;
  goal: GoalRun | null;
  onClose: () => void;
  onPrepared: () => Promise<void>;
  onDeleted: () => Promise<void>;
}) {
  const [preparing, setPreparing] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [startingGoal, setStartingGoal] = useState(false);
  const [lifecycleBusy, setLifecycleBusy] = useState<"cancel" | "delete" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reviews, setReviews] = useState<TaskReview[]>([]);
  const open = task !== null;

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);

  useEffect(() => {
    if (!task) return;
    let active = true;
    void fetchTaskReviews(task.id)
      .then((items) => {
        if (active) setReviews(items);
      })
      .catch(() => {
        if (active) setReviews([]);
      });
    return () => {
      active = false;
    };
  }, [task]);

  if (!task) return null;
  const taskId = task.id;

  async function handlePrepare() {
    setPreparing(true);
    setError(null);
    try {
      await prepareTask(taskId);
      await onPrepared();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Não foi possível preparar a task.");
    } finally {
      setPreparing(false);
    }
  }

  async function handleClaudeReview() {
    setReviewing(true);
    setError(null);
    try {
      await requestClaudeReview(taskId);
      setReviews(await fetchTaskReviews(taskId));
      await onPrepared();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "A revisão do Claude falhou.");
      setReviews(await fetchTaskReviews(taskId).catch(() => []));
    } finally {
      setReviewing(false);
    }
  }

  async function handleStartGoal() {
    setStartingGoal(true);
    setError(null);
    try {
      await startTaskGoal(taskId);
      await onPrepared();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "A goal nao pode ser iniciada.");
    } finally {
      setStartingGoal(false);
    }
  }

  async function handleCancel() {
    if (!window.confirm(`Cancelar a task #${taskId}? O agente em execucao sera interrompido.`)) return;
    setLifecycleBusy("cancel");
    setError(null);
    try {
      await cancelTask(taskId);
      await onPrepared();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Nao foi possivel cancelar a task.");
    } finally {
      setLifecycleBusy(null);
    }
  }

  async function handleDelete() {
    if (!window.confirm(`Apagar permanentemente a task #${taskId}? Esta acao nao pode ser desfeita.`)) return;
    setLifecycleBusy("delete");
    setError(null);
    try {
      await deleteTask(taskId);
      await onDeleted();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Nao foi possivel apagar a task.");
    } finally {
      setLifecycleBusy(null);
    }
  }

  const canPrepare = task.status === "queued" && !task.worktreePrepared;
  const canCancel = !["done", "failed", "rejected", "cancelled"].includes(task.status);
  const canDelete = !task.worktreePrepared && ["queued", "cancelled"].includes(task.status);

  return (
    <div
      className="detail-backdrop is-open"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <aside className="task-detail" role="dialog" aria-modal="true" aria-labelledby="task-detail-title">
        <button className="composer-close" onClick={onClose} aria-label="Fechar detalhes">
          <Icon name="close" />
        </button>
        <span className="task-detail-id">task #{String(task.id).padStart(2, "0")}</span>
        <StatusPill status={task.status} />
        <h2 id="task-detail-title">{task.text}</h2>
        <div className="detail-project">
          <span>@{task.projectKey ?? "inbox"}</span>
          <strong>{task.projectName ?? "Sem projeto"}</strong>
        </div>

        <dl className="detail-metadata">
          <div>
            <dt>Origem</dt>
            <dd>{task.source}</dd>
          </div>
          <div>
            <dt>Criada</dt>
            <dd>{formatRelative(task.createdAt)}</dd>
          </div>
          <div>
            <dt>Branch</dt>
            <dd>{task.branchName ?? "ainda não criada"}</dd>
          </div>
          <div>
            <dt>Worktree</dt>
            <dd>{task.worktreePrepared ? "isolada e preparada" : "aguardando preparo"}</dd>
          </div>
        </dl>

        <div className="detail-flow">
          <span className="is-done">
            01 <strong>Capturada</strong>
          </span>
          <span className={task.status !== "queued" ? "is-done" : "is-current"}>
            02 <strong>Preparada</strong>
          </span>
          <span className={task.status === "implementing" ? "is-current" : ""}>
            03 <strong>Executando</strong>
          </span>
          <span className={task.status === "done" ? "is-done" : ""}>
            04 <strong>Concluída</strong>
          </span>
        </div>

        {error ? <p className="detail-error">{error}</p> : null}
        <button className="detail-primary" disabled={!canPrepare || preparing} onClick={() => void handlePrepare()}>
          <span>
            {preparing
              ? "Preparando..."
              : canPrepare
              ? "Preparar worktree"
              : task.worktreePrepared
              ? "Worktree preparada"
              : "Ação indisponível"}
          </span>
          <Icon name={canPrepare ? "arrow" : "shield"} />
        </button>
        <p className="detail-footnote">
          A preparação cria branch e diretório isolados. Nenhum agente executa código nesta etapa.
        </p>

        <div className="goal-section">
          <div>
            <span>Execucao persistente</span>
            <strong>Goal autonoma</strong>
          </div>
          <p>
            O Maestro planeja, implementa, testa e revisa. Se a revisao pedir ajustes, ele volta para implementacao sem
            atualizar a task manualmente.
          </p>
          <button
            className="goal-action"
            disabled={
              !task.worktreePrepared ||
              ["running", "waiting_provider"].includes(goal?.status ?? "") ||
              startingGoal ||
              ["done", "awaiting_human", "ready_to_merge", "rejected", "cancelled"].includes(task.status)
            }
            onClick={() => void handleStartGoal()}
          >
            {startingGoal
              ? "Iniciando goal..."
              : goal?.status === "running"
              ? `Rodando ${goal.currentPhase} · ${goal.stepCount} etapas`
              : goal?.status === "waiting_provider"
              ? `Aguardando provider · ${goal.stepCount} etapas`
              : task.status === "awaiting_human" && goal?.pullRequestUrl
              ? "Draft PR aguardando merge"
              : task.worktreePrepared
              ? "Iniciar goal"
              : "Prepare a worktree primeiro"}
            <Icon name="pulse" />
          </button>
          {goal ? (
            <div className={`goal-state goal-${goal.status}`}>
              <span>
                goal #{goal.id} · {goal.status}
              </span>
              <strong>
                {goal.currentPhase} · {goal.stepCount} etapas executadas
              </strong>
              {goal.observability ? (
                <small className="goal-observability">
                  {goal.observability.classifiedReasonLabel
                    ? `Motivo: ${goal.observability.classifiedReasonLabel}`
                    : goal.waitReason
                    ? `Motivo: ${goal.waitReason}`
                    : ""}
                  {goal.observability.sourceProvider
                    ? ` · Origem: ${goal.observability.sourceProvider}`
                    : goal.lastProvider
                    ? ` · Origem: ${goal.lastProvider}`
                    : ""}
                  {goal.observability.nextProvider ? ` · Próximo: ${goal.observability.nextProvider}` : ""}
                  {goal.observability.checkpointId ? ` · Checkpoint: #${goal.observability.checkpointId}` : ""}
                  {` · Preservado: ${goal.observability.preservedChanges ? "sim" : "não"}`}
                  {` · Retomável: ${goal.observability.retryable ? "sim" : "não"}`}
                  {goal.observability.nextAction ? ` · Ação: ${goal.observability.nextAction}` : ""}
                </small>
              ) : goal.status === "waiting_provider" && goal.waitReason ? (
                <small>
                  Motivo: {goal.waitReason}
                  {goal.lastProvider ? ` · provider: ${goal.lastProvider}` : ""}
                  {goal.nextRetryAt ? ` · nova tentativa: ${new Date(goal.nextRetryAt).toLocaleTimeString("pt-BR")}` : ""}
                </small>
              ) : null}
              {goal.lastError ? <small>{goal.lastError}</small> : null}
              {goal.pullRequestUrl ? (
                <a href={goal.pullRequestUrl} target="_blank" rel="noreferrer">
                  Abrir draft PR
                </a>
              ) : null}
            </div>
          ) : null}
        </div>

        <div className="review-section">
          <div>
            <span>Revisão externa</span>
            <strong>Claude design review</strong>
          </div>
          <button
            className="review-action"
            disabled={!task.worktreePrepared || reviewing}
            onClick={() => void handleClaudeReview()}
          >
            {reviewing ? "Claude está analisando..." : task.worktreePrepared ? "Pedir revisão" : "Prepare a worktree primeiro"}
            <Icon name="spark" />
          </button>
          {reviews.map((review) => (
            <article className={`review-card review-${review.status}`} key={review.id}>
              <header>
                <span>Claude · #{review.id}</span>
                <time>{formatRelative(review.createdAt)}</time>
              </header>
              <strong>
                {review.status === "completed"
                  ? "Revisão concluída"
                  : review.status === "auth_required"
                  ? "Autenticação necessária"
                  : "Revisão falhou"}
              </strong>
              <p>{review.content || review.error}</p>
            </article>
          ))}
        </div>

        <div className="task-danger-zone">
          <div>
            <span>Controle da task</span>
            <strong>Cancelar ou apagar</strong>
          </div>
          <p>Cancelar interrompe a execucao e preserva o historico. Apagar so e permitido sem worktree e sem historico de goal.</p>
          <div className="task-danger-actions">
            <button disabled={!canCancel || lifecycleBusy !== null} onClick={() => void handleCancel()}>
              {lifecycleBusy === "cancel" ? "Cancelando..." : "Cancelar task"}
            </button>
            <button disabled={!canDelete || lifecycleBusy !== null} onClick={() => void handleDelete()}>
              {lifecycleBusy === "delete" ? "Apagando..." : "Apagar task"}
            </button>
          </div>
        </div>
      </aside>
    </div>
  );
}
