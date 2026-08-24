import { Link } from "react-router-dom";
import { useState } from "react";
import { DashboardTask, cancelTask } from "../api";
import { statusProgress, taskStatusLabel, formatRelative } from "../helpers";
import { StatusBadge } from "./StatusBadge";
import { Icon } from "./Icon";
import { translate } from "../i18n";

export function TaskCard({ task, onOpen }: { task: DashboardTask; onOpen: () => void }) {
  const [cancelling, setCancelling] = useState(false);
  const cancellable = !["done", "failed", "rejected", "cancelled"].includes(task.status);

  async function handleCancel(event: React.MouseEvent) {
    event.stopPropagation();
    if (!window.confirm(`${translate("Cancel task")} #${task.id}? ${translate("Any current execution will be interrupted.")}`)) return;
    setCancelling(true);
    try {
      await cancelTask(task.id);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : `${translate("Unable to cancel task")} #${task.id}.`);
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
        aria-label={`${translate("Open task details")} ${task.id}`}
        onClick={onOpen}
      >
        <span className="task-id">#{String(task.id).padStart(2, "0")}</span>
        <span className="task-copy">
          <span>
            <span className="project-tag">@{task.projectKey ?? "inbox"}</span>
            <StatusBadge status={task.status} />
          </span>
          <strong>{task.title || task.text}</strong>
          {task.title && task.title !== task.text ? <small className="task-original-request">{translate("Request:")} {task.text}</small> : null}
          <small>{task.branchName ?? `${translate("created")} ${formatRelative(task.createdAt)}`}</small>
        </span>
        <span className="task-progress" aria-label={`${translate("Status")}: ${taskStatusLabel(task.status)}`}>
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
            title={cancelling ? translate("Cancelling…") : translate("Cancel task #{id}", { id: task.id })}
            aria-label={translate("Cancel task #{id}", { id: task.id })}
            disabled={cancelling}
            onClick={(event) => void handleCancel(event)}
          >
            {cancelling ? "…" : "✕"}
          </button>
        ) : null}
        <Link
          to={`/tasks/${task.id}/logs`}
          className="task-log-badge-action"
          title={translate("View logs for task #{id}", { id: task.id })}
          aria-label={translate("View logs for task #{id}", { id: task.id })}
        >
          <Icon name="timeline" />
          <span>Logs</span>
        </Link>
        <button className="row-action" aria-label={translate("Open task {id}", { id: task.id })} onClick={onOpen}>
          <Icon name="arrow" />
        </button>
      </div>
    </article>
  );
}

export function TaskRow({ task, onOpen }: { task: DashboardTask; onOpen: () => void }) {
  return <TaskCard task={task} onOpen={onOpen} />;
}
