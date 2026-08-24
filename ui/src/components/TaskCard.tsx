import { Link } from "react-router-dom";
import { useState } from "react";
import { DashboardTask, cancelTask } from "../api";
import { statusProgress, taskStatusLabels, formatRelative } from "../helpers";
import { StatusBadge } from "./StatusBadge";
import { Icon } from "./Icon";

export function TaskCard({ task, onOpen }: { task: DashboardTask; onOpen: () => void }) {
  const [cancelling, setCancelling] = useState(false);
  const cancellable = !["done", "failed", "rejected", "cancelled"].includes(task.status);

  async function handleCancel(event: React.MouseEvent) {
    event.stopPropagation();
    if (!window.confirm(`Cancelar a task #${task.id}? Qualquer execução em curso será interrompida.`)) return;
    setCancelling(true);
    try {
      await cancelTask(task.id);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : `Não foi possível cancelar a task #${task.id}.`);
    } finally {
      setCancelling(false);
    }
  }

  return (
    <article className="task-row">
      <span className={`status-rail status-${task.status}`} />
      <button
        type="button"
        className="task-row-main"
        aria-label={`Abrir detalhes da task ${task.id}`}
        onClick={onOpen}
      >
        <span className="task-id">#{String(task.id).padStart(2, "0")}</span>
        <span className="task-copy">
          <span>
            <span className="project-tag">@{task.projectKey ?? "inbox"}</span>
            <StatusBadge status={task.status} />
          </span>
          <strong>{task.title || task.text}</strong>
          {task.title && task.title !== task.text ? <small className="task-original-request">Pedido: {task.text}</small> : null}
          <small>{task.branchName ?? `criada ${formatRelative(task.createdAt)}`}</small>
        </span>
        <span className="task-progress" aria-label={`Status: ${taskStatusLabels[task.status]}`}>
          <span>
            <i style={{ width: `${statusProgress(task.status)}%` }} />
          </span>
          <small>{statusProgress(task.status)}%</small>
        </span>
      </button>
      <div className="task-row-actions-group" style={{ display: "flex", alignItems: "center", gap: "8px" }}>
        {cancellable ? (
          <button
            type="button"
            className="row-action"
            title={cancelling ? "Cancelando..." : `Cancelar task #${task.id}`}
            aria-label={`Cancelar task ${task.id}`}
            disabled={cancelling}
            onClick={(event) => void handleCancel(event)}
          >
            {cancelling ? "…" : "✕"}
          </button>
        ) : null}
        <Link
          to={`/tasks/${task.id}/logs`}
          className="task-log-badge-action"
          title={`Ver logs da task #${task.id}`}
          aria-label={`Ver logs da task #${task.id}`}
        >
          <Icon name="timeline" />
          <span>Logs</span>
        </Link>
        <button className="row-action" aria-label={`Abrir task ${task.id}`} onClick={onOpen}>
          <Icon name="arrow" />
        </button>
      </div>
    </article>
  );
}

export function TaskRow({ task, onOpen }: { task: DashboardTask; onOpen: () => void }) {
  return <TaskCard task={task} onOpen={onOpen} />;
}
