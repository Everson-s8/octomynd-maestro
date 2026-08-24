import { DashboardData } from "../api";
import { Icon } from "../components/Icon";
import { AgentProviderBar } from "../components/ProviderChip";
import { TaskCard } from "../components/TaskCard";
import { CostDisplay, calculateDashboardCost } from "../components/CostDisplay";
import { FeatureBoard } from "../components/FeatureBoard";
import { SectionHeader } from "../components/SectionHeader";
import { EmptyState } from "../components/EmptyState";
import { NervousSystem } from "../components/NervousSystem";
import { taskStatusLabels } from "../helpers";
import { translate } from "../i18n";

export function HeroConsole({ data }: { data: DashboardData }) {
  const leadTask = data.tasks.find((task) => !["done", "failed", "rejected", "cancelled"].includes(task.status));
  return (
    <section className="hero-console panel" aria-labelledby="hero-title">
      <div className="hero-grid" aria-hidden="true" />
      <div className="hero-copy">
        <span className="eyebrow">
          <span /> {translate("Live system")}
        </span>
        <h2 id="hero-title">
          {translate("A brain.")}
          <br />
          <em>{translate("Arms that decide.")}</em>
        </h2>
        <p>
          {translate("Two thirds of an octopus's neurons live in its arms. Each agent proves its own work — and you keep the final decision.")}
        </p>
        <div className="hero-chips">
          <span>{data.summary.activeTasks} {translate("active tasks")}</span>
          <span>{data.summary.projects} {translate("local projects")}</span>
          <span>{translate("Access")} {data.daemon.access === "restricted" ? translate("restricted") : translate("open")}</span>
          <span>autopilot {data.autopilot.enabled ? data.autopilot.state : translate("Disabled")}</span>
          {data.runtimeUpdate && (
            <span className={`runtime-update-chip status-${data.runtimeUpdate.status}`} title={data.runtimeUpdate.error ?? undefined}>
              self-update: {data.runtimeUpdate.status} ({data.runtimeUpdate.targetCommit.slice(0, 7)})
            </span>
          )}
        </div>
      </div>
      <div className="hero-visual">
        <NervousSystem agents={data.agents} />
      </div>
      <div className="hero-now">
        <span>{translate("Now in Maestro")}</span>
        <strong>{leadTask ? `#${leadTask.id} · ${leadTask.text}` : translate("Queue is open for the next mission")}</strong>
        <small>
          {leadTask
            ? `${leadTask.projectKey ?? translate("no project")} · ${taskStatusLabels[leadTask.status]}`
            : data.autopilot.enabled
            ? translate("Autopilot is waiting for the next eligible task")
            : translate("Create a task from the dashboard or Telegram")}
        </small>
      </div>
    </section>
  );
}

export function SummaryStrip({ data }: { data: DashboardData }) {
  const cards = [
    [translate("Projects"), data.summary.projects, "pink", "folder"],
    [translate("moving"), data.summary.activeTasks, "cyan", "pulse"],
    [translate("queued"), data.summary.queuedTasks, "lime", "queue"],
    [translate("Your decision"), data.summary.humanGates, "violet", "hand"]
  ];
  return (
    <section className="summary-strip" aria-label={translate("Operational summary")}>
      {cards.map(([label, value, tone, icon]) => (
        <article className={`metric-card tone-${tone}`} key={String(label)}>
          <div className="metric-icon">
            <Icon name={String(icon)} />
          </div>
          <span>{label}</span>
          <strong>{value}</strong>
        </article>
      ))}
    </section>
  );
}

export interface DashboardPageProps {
  data: DashboardData;
  activeTasks: DashboardData["tasks"];
  onOpenTask: (taskId: number) => void;
  onRefresh: () => Promise<unknown>;
}

export function DashboardPage({ data, activeTasks, onOpenTask, onRefresh }: DashboardPageProps) {
  const { costToday, totalTokens } = calculateDashboardCost(data);

  return (
    <div className="dashboard-grid" id="overview">
      <div className="panel provider-status-panel" style={{ padding: "16px 20px" }}>
        <SectionHeader eyebrow={translate("System status")} title={translate("Provider status")} meta={translate("Real-time status")} />
        <AgentProviderBar agents={data.agents} />
      </div>

      <CostDisplay costToday={costToday} estimatedTokens={totalTokens} />

      <HeroConsole data={data} />

      <SummaryStrip data={data} />

      <section className="panel task-board" id="tasks" aria-labelledby="tasks-title">
        <SectionHeader eyebrow={translate("Execution")} title={translate("Active tasks")} meta={`${activeTasks.length} ${translate("active")}`} />
        <div className="task-list">
          {activeTasks.length === 0 ? (
            <EmptyState icon="spark" title={translate("Everything is fine")} text={translate("No active task right now.")} />
          ) : (
            activeTasks.slice(0, 8).map((task) => <TaskCard task={task} key={task.id} onOpen={() => onOpenTask(task.id)} />)
          )}
        </div>
      </section>

      <FeatureBoard features={data.features} onChanged={onRefresh} />
    </div>
  );
}
