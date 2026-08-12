import { DashboardData } from "../api";
import { agentStateLabel, heroAgentChip } from "../agentPresentation";
import { Icon } from "../components/Icon";
import { AgentProviderBar } from "../components/ProviderChip";
import { TaskCard } from "../components/TaskCard";
import { CostDisplay, calculateDashboardCost } from "../components/CostDisplay";
import { FeatureBoard } from "../components/FeatureBoard";
import { SectionHeader } from "../components/SectionHeader";
import { EmptyState } from "../components/EmptyState";
import { NervousSystem } from "../components/NervousSystem";
import { taskStatusLabels } from "../helpers";

export function HeroConsole({ data }: { data: DashboardData }) {
  const leadTask = data.tasks.find((task) => !["done", "failed", "rejected", "cancelled"].includes(task.status));
  const codexChip = heroAgentChip(data.agents, "codex", "Codex");
  const claudeChip = heroAgentChip(data.agents, "claude", "Claude");
  return (
    <section className="hero-console panel" aria-labelledby="hero-title">
      <div className="hero-grid" aria-hidden="true" />
      <div className="hero-copy">
        <span className="eyebrow">
          <span /> sistema vivo
        </span>
        <h2 id="hero-title">
          Um cérebro.
          <br />
          <em>Braços que decidem.</em>
        </h2>
        <p>
          Dois terços dos neurônios de um polvo vivem nos braços. Cada agente provou o próprio trabalho — e você mantém
          a decisão final enquanto Claude e Codex entram no fluxo.
        </p>
        <div className="hero-chips">
          <span>{data.summary.activeTasks} tasks ativas</span>
          <span>{data.summary.projects} projetos locais</span>
          <span>acesso {data.daemon.access === "restricted" ? "restrito" : "aberto"}</span>
          <span>autopilot {data.autopilot.enabled ? data.autopilot.state : "desligado"}</span>
          {data.runtimeUpdate && (
            <span className={`runtime-update-chip status-${data.runtimeUpdate.status}`} title={data.runtimeUpdate.error ?? undefined}>
              self-update: {data.runtimeUpdate.status} ({data.runtimeUpdate.targetCommit.slice(0, 7)})
            </span>
          )}
        </div>
      </div>
      <div className="hero-visual">
        <NervousSystem agents={data.agents} />
        <span className="agent-satellite satellite-codex">
          {codexChip.label}
          <small>{agentStateLabel(codexChip.state)}</small>
        </span>
        <span className="agent-satellite satellite-claude">
          {claudeChip.label}
          <small>{agentStateLabel(claudeChip.state)}</small>
        </span>
        <span className="agent-satellite satellite-telegram">
          Telegram<small>live</small>
        </span>
      </div>
      <div className="hero-now">
        <span>Agora no Maestro</span>
        <strong>{leadTask ? `#${leadTask.id} · ${leadTask.text}` : "Fila livre para a próxima missão"}</strong>
        <small>
          {leadTask
            ? `${leadTask.projectKey ?? "sem projeto"} · ${taskStatusLabels[leadTask.status]}`
            : data.autopilot.enabled
            ? "Autopilot aguardando a próxima task válida"
            : "Crie uma task pelo painel ou Telegram"}
        </small>
      </div>
    </section>
  );
}

export function SummaryStrip({ data }: { data: DashboardData }) {
  const cards = [
    ["Projetos", data.summary.projects, "pink", "folder"],
    ["Em movimento", data.summary.activeTasks, "cyan", "pulse"],
    ["Na fila", data.summary.queuedTasks, "lime", "queue"],
    ["Sua decisão", data.summary.humanGates, "violet", "hand"]
  ];
  return (
    <section className="summary-strip" aria-label="Resumo operacional">
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
        <SectionHeader eyebrow="Status do Sistema" title="Status dos Providers" meta="Status em tempo real" />
        <AgentProviderBar agents={data.agents} />
      </div>

      <CostDisplay costToday={costToday} estimatedTokens={totalTokens} />

      <HeroConsole data={data} />

      <SummaryStrip data={data} />

      <section className="panel task-board" id="tasks" aria-labelledby="tasks-title">
        <SectionHeader eyebrow="Execução" title="Tasks Ativas" meta={`${activeTasks.length} ativas`} />
        <div className="task-list">
          {activeTasks.length === 0 ? (
            <EmptyState icon="spark" title="Tudo em ordem" text="Nenhuma task ativa neste momento." />
          ) : (
            activeTasks.slice(0, 8).map((task) => <TaskCard task={task} key={task.id} onOpen={() => onOpenTask(task.id)} />)
          )}
        </div>
      </section>

      <FeatureBoard features={data.features} onChanged={onRefresh} />
    </div>
  );
}
