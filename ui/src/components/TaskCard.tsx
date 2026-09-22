import { Link } from "react-router-dom";
import { useState } from "react";
import { DashboardTask, cancelTask } from "../api";
import { statusProgress, taskStatusLabel, formatRelative } from "../helpers";
import { StatusBadge } from "./StatusBadge";
import { Icon } from "./Icon";
import { translate } from "../i18n";
import { ActionModal } from "./ActionModal";

export function TaskCard({ task, onOpen, onChanged }: { task: DashboardTask; onOpen: () => void; onChanged?: () => Promise<unknown> }) {
  const [cancelling, setCancelling] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancellable = !["done", "failed", "rejected", "cancelled"].includes(task.status);

  async function handleCancel(event: React.MouseEvent) {
    event.stopPropagation();
    setConfirming(true);
  }

  async function confirmCancel() {
    setCancelling(true);
    setConfirming(false);
    setError(null);
    try {
      await cancelTask(task.id);
      await onChanged?.();
    } catch (error) {
      setError(error instanceof Error ? error.message : `${translate("Unable to cancel task")} #${task.id}.`);
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
      {error ? <p className="detail-error">{error}</p> : null}
      {confirming ? (
        <ActionModal
          title={translate("Cancel this task?")}
          description={translate("The active execution will stop and its history will be preserved.")}
          cancelLabel={translate("Keep task")}
          confirmLabel={translate("Cancel task")}
          busy={cancelling}
          onCancel={() => setConfirming(false)}
          onConfirm={() => void confirmCancel()}
        />
      ) : null}
    </article>
  );
}

export function TaskRow({ task, onOpen, onChanged }: { task: DashboardTask; onOpen: () => void; onChanged?: () => Promise<unknown> }) {
  return <TaskCard task={task} onOpen={onOpen} onChanged={onChanged} />;
}
