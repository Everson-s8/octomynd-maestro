import { Link } from "react-router-dom";
import { DashboardTask } from "../api";
import { statusProgress, taskStatusLabels, formatRelative } from "../helpers";
import { StatusBadge } from "./StatusBadge";
import { Icon } from "./Icon";

export function TaskCard({ task, onOpen }: { task: DashboardTask; onOpen: () => void }) {
  return (
    <article
      className="task-row"
      role="button"
      tabIndex={0}
      aria-label={`Abrir detalhes da task ${task.id}`}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen();
        }
      }}
    >
      <span className={`status-rail status-${task.status}`} />
      <div className="task-id">#{String(task.id).padStart(2, "0")}</div>
      <div className="task-copy">
        <div>
          <span className="project-tag">@{task.projectKey ?? "inbox"}</span>
          <StatusBadge status={task.status} />
        </div>
        <strong>{task.text}</strong>
        <small>{task.branchName ?? `criada ${formatRelative(task.createdAt)}`}</small>
      </div>
      <div className="task-progress" aria-label={`Status: ${taskStatusLabels[task.status]}`}>
        <span>
          <i style={{ width: `${statusProgress(task.status)}%` }} />
        </span>
        <small>{statusProgress(task.status)}%</small>
      </div>
      <div className="task-row-actions-group" style={{ display: "flex", alignItems: "center", gap: "8px" }}>
        <Link
          to={`/tasks/${task.id}/logs`}
          className="task-log-badge-action"
          title={`Ver logs da task #${task.id}`}
          aria-label={`Ver logs da task #${task.id}`}
          onClick={(e) => e.stopPropagation()}
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
