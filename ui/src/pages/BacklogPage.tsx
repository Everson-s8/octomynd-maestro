import { useState } from "react";
import { DashboardData, DashboardTask } from "../api";
import { FeaturePlanBoard } from "../components/FeaturePlanBoard";
import { SectionHeader } from "../components/SectionHeader";
import { TaskCard } from "../components/TaskCard";
import { EmptyState } from "../components/EmptyState";
import { Icon } from "../components/Icon";
import { statusOrder } from "../helpers";
import { translate } from "../i18n";

export interface BacklogPageProps {
  data: DashboardData;
  onOpenTask: (taskId: number) => void;
  onRefresh: () => Promise<unknown>;
  onCreateTask: () => void;
}

export function BacklogPage({ data, onOpenTask, onRefresh, onCreateTask }: BacklogPageProps) {
  const [filterProject, setFilterProject] = useState<string>("all");

  const sortedTasks = [...data.tasks]
    .filter((task) => filterProject === "all" || task.projectKey === filterProject)
    .sort((left, right) => statusOrder.indexOf(left.status) - statusOrder.indexOf(right.status));

  const queuedTasks = sortedTasks.filter((t) => t.status === "queued");
  const activeTasks = sortedTasks.filter((t) => !["queued", "done", "failed", "rejected", "cancelled"].includes(t.status));
  const completedTasks = sortedTasks.filter((t) => ["done", "failed", "rejected", "cancelled"].includes(t.status));

  return (
    <div className="backlog-page-grid" style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
      <div className="panel backlog-controls" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "16px 20px" }}>
        <SectionHeader eyebrow={translate("Prioritization")} title={translate("Prioritized task queue")} meta={`${sortedTasks.length} ${translate("total")}`} />
        <div style={{ display: "flex", gap: "12px", alignItems: "center" }}>
          <select
            value={filterProject}
            onChange={(e) => setFilterProject(e.target.value)}
            style={{
              padding: "8px 12px",
              borderRadius: "6px",
              background: "#181a20",
              color: "#fff",
              border: "1px solid #2e323e",
              fontSize: "14px"
            }}
          >
            <option value="all">{translate("All projects")}</option>
            {data.projects.map((p) => (
              <option value={p.key} key={p.key}>
                @{p.key} ({p.name})
              </option>
            ))}
          </select>
          <button className="primary-action" onClick={onCreateTask}>
            <Icon name="plus" />
            {translate("+ New task")}
          </button>
        </div>
      </div>

      <FeaturePlanBoard featurePlans={data.featurePlans} onChanged={onRefresh} />

      <section className="panel task-board" id="backlog-active" aria-labelledby="active-tasks-title">
        <SectionHeader eyebrow={translate("In progress")} title={translate("Tasks in progress")} meta={`${activeTasks.length} ${translate("active")}`} />
        <div className="task-list">
          {activeTasks.length === 0 ? (
            <EmptyState icon="spark" title={translate("No task in progress")} text={translate("Queued tasks will start automatically.")} />
          ) : (
            activeTasks.map((task) => <TaskCard task={task} key={task.id} onOpen={() => onOpenTask(task.id)} />)
          )}
        </div>
      </section>

      <section className="panel task-board" id="backlog-queued" aria-labelledby="queued-tasks-title">
        <SectionHeader eyebrow={translate("Queue")} title={translate("Tasks in queue (Queued)")} meta={`${queuedTasks.length} ${translate("waiting")}`} />
        <div className="task-list">
          {queuedTasks.length === 0 ? (
            <EmptyState icon="queue" title={translate("Empty queue")} text={translate("Add new requests to put the agents to work.")} />
          ) : (
            queuedTasks.map((task) => <TaskCard task={task} key={task.id} onOpen={() => onOpenTask(task.id)} />)
          )}
        </div>
      </section>

      {completedTasks.length > 0 && (
        <section className="panel task-board" id="backlog-completed" aria-labelledby="completed-tasks-title">
        <SectionHeader eyebrow={translate("History")} title={translate("Completed or closed tasks")} meta={`${completedTasks.length} ${translate("finished")}`} />
          <div className="task-list">
            {completedTasks.slice(0, 10).map((task) => (
              <TaskCard task={task} key={task.id} onOpen={() => onOpenTask(task.id)} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
