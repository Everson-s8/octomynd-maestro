import { FormEvent, ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import {
  cancelFeature,
  cancelFeaturePlan,
  cancelTask,
  cancelWorkGraph,
  createImprovement,
  createTask,
  deleteTask,
  decideHumanReview,
  decideImprovement,
  DashboardData,
  DashboardEvent,
  DashboardFeature,
  DashboardFeaturePlan,
  DashboardProject,
  DashboardTask,
  DashboardWorkGraph,
  FeatureStatus,
  fetchProviderPolicy,
  fetchTaskReviews,
  fetchDashboard,
  GoalRun,
  HumanReviewDecision,
  ImprovementCategory,
  ImprovementProposal,
  ImprovementRisk,
  prepareTask,
  ProviderPolicySnapshot,
  ProviderMode,
  AgentProviderId,
  AgentCapability,
  requestClaudeReview,
  ReviewQueueItem,
  startTaskGoal,
  TaskReview,
  TaskStatus,
  updateCapabilityRouting,
  updateProviderControl,
  updateProviderControls
} from "./api";
import { formatWorkGraphDuration, isWorkGraphCancellable } from "./workGraphs";
import { agentStateLabel, heroAgentChip } from "./agentPresentation";

const taskStatusLabels: Record<TaskStatus, string> = {
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

const statusOrder: TaskStatus[] = [
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

const featureStatusLabels: Record<FeatureStatus, string> = {
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

const featureStatusOrder: FeatureStatus[] = [
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

export default function App() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [activeView, setActiveView] = useState("overview");
  const [taskPanelOpen, setTaskPanelOpen] = useState(false);
  const [selectedTaskId, setSelectedTaskId] = useState<number | null>(null);

  const refresh = useCallback(async (showActivity = false) => {
    const controller = new AbortController();
    if (showActivity) setIsRefreshing(true);
    try {
      const nextData = await fetchDashboard(controller.signal);
      setData(nextData);
      setError(null);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Falha ao carregar a central.");
    } finally {
      setIsRefreshing(false);
    }
    return () => controller.abort();
  }, []);

  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(interval);
  }, [refresh]);

  const activeTasks = useMemo(() => {
    if (!data) return [];
    return [...data.tasks]
      .filter((task) => !["done", "failed", "rejected", "cancelled"].includes(task.status))
      .sort((left, right) => statusOrder.indexOf(left.status) - statusOrder.indexOf(right.status));
  }, [data]);
  const selectedTask = data?.tasks.find((task) => task.id === selectedTaskId) ?? null;
  const selectedGoal = data?.goals.find((goal) => goal.taskId === selectedTaskId) ?? null;

  if (!data && !error) {
    return <LoadingScreen />;
  }

  return (
    <div className="app-shell">
      <Sidebar activeView={activeView} onChange={setActiveView} />
      <main className="control-room">
        <Topbar
          data={data}
          isRefreshing={isRefreshing}
          onRefresh={() => void refresh(true)}
          onCreateTask={() => setTaskPanelOpen(true)}
        />

        {error ? <ErrorBanner message={error} onRetry={() => void refresh(true)} /> : null}

        {data ? (
          <div className="dashboard-grid" id="overview">
            <HeroConsole data={data} />
            <SummaryStrip data={data} />
            <HumanReviewQueue reviews={data.reviewQueue} onChanged={() => refresh(true)} />
            <FeaturePlanBoard featurePlans={data.featurePlans} onChanged={() => refresh(true)} />
            <FeatureBoard features={data.features} onChanged={() => refresh(true)} />
            <WorkGraphBoard workGraphs={data.workGraphs} onChanged={() => refresh(true)} />
            <TaskBoard tasks={activeTasks} onOpenTask={setSelectedTaskId} />
            <AgentDock agents={data.agents} environments={data.environments} />
            <ProjectDeck projects={data.projects} />
            <ImprovementLab improvements={data.improvements} onChanged={() => refresh(true)} />
            <EventStream events={data.events} />
          </div>
        ) : null}
      </main>

      <TaskComposer
        open={taskPanelOpen}
        projects={data?.projects ?? []}
        onClose={() => setTaskPanelOpen(false)}
        onCreated={async () => {
          setTaskPanelOpen(false);
          await refresh(true);
        }}
      />
      <TaskDetail
        task={selectedTask}
        goal={selectedGoal}
        onClose={() => setSelectedTaskId(null)}
        onPrepared={async () => {
          await refresh(true);
        }}
        onDeleted={async () => {
          setSelectedTaskId(null);
          await refresh(true);
        }}
      />
    </div>
  );
}

function Sidebar({ activeView, onChange }: { activeView: string; onChange: (view: string) => void }) {
  const links = [
    ["overview", "Visão geral", "grid"],
    ["tasks", "Fluxo de tasks", "pulse"],
    ["reviews", "Aguardando revisão", "hand"],
    ["projects", "Projetos", "folder"],
    ["providers", "Providers", "spark"],
    ["learning", "Aprendizado", "spark"],
    ["events", "Eventos", "timeline"]
  ];

  return (
    <aside className="sidebar">
      <a className="brand" href="#overview" aria-label="Octomynd Maestro">
        <OctoMark />
        <span><strong>octo</strong>mynd<small>maestro</small></span>
      </a>

      <nav aria-label="Navegação principal">
        {links.map(([id, label, icon]) => (
          <a
            href={`#${id}`}
            className={activeView === id ? "is-active" : ""}
            key={id}
            aria-label={label}
            aria-current={activeView === id ? "page" : undefined}
            onClick={() => onChange(id)}
          >
            <Icon name={icon} />
            <span>{label}</span>
          </a>
        ))}
      </nav>

      <div className="sidebar-note">
        <span className="live-orb" />
        <div><strong>Local-first</strong><small>127.0.0.1 · acesso privado</small></div>
      </div>
    </aside>
  );
}

function Topbar({
  data,
  isRefreshing,
  onRefresh,
  onCreateTask
}: {
  data: DashboardData | null;
  isRefreshing: boolean;
  onRefresh: () => void;
  onCreateTask: () => void;
}) {
  return (
    <header className="topbar">
      <div>
        <span className="topbar-kicker">Central de operação</span>
        <h1>Bom dia, Everson.</h1>
      </div>
      <div className="topbar-actions">
        <span className="sync-stamp">
          <span className={data ? "sync-dot" : "sync-dot is-offline"} />
          {data ? `sincronizado ${formatRelative(data.generatedAt)}` : "sem conexão"}
        </span>
        <button className="icon-button" onClick={onRefresh} aria-label="Atualizar painel">
          <Icon name="refresh" className={isRefreshing ? "is-spinning" : ""} />
        </button>
        <button className="primary-action" onClick={onCreateTask}>
          <Icon name="plus" />
          Nova task
        </button>
      </div>
    </header>
  );
}

function HeroConsole({ data }: { data: DashboardData }) {
  const leadTask = data.tasks.find((task) => !["done", "failed", "rejected", "cancelled"].includes(task.status));
  const codexChip = heroAgentChip(data.agents, "codex", "Codex");
  const claudeChip = heroAgentChip(data.agents, "claude", "Claude");
  return (
    <section className="hero-console panel" aria-labelledby="hero-title">
      <div className="hero-grid" aria-hidden="true" />
      <div className="hero-copy">
        <span className="eyebrow"><span /> sistema vivo</span>
        <h2 id="hero-title">Seus agentes,<br /><em>um só ritmo.</em></h2>
        <p>
          Telegram recebe. Maestro organiza. Worktrees isolam cada missão — e você mantém a
          decisão final enquanto Codex e Claude entram no fluxo.
        </p>
        <div className="hero-chips">
          <span>{data.summary.activeTasks} tasks ativas</span>
          <span>{data.summary.projects} projetos locais</span>
          <span>acesso {data.daemon.access === "restricted" ? "restrito" : "aberto"}</span>
          <span>autopilot {data.autopilot.enabled ? data.autopilot.state : "desligado"}</span>
        </div>
      </div>
      <div className="hero-visual">
        <div className="orbit orbit-a" />
        <div className="orbit orbit-b" />
        <div className="mascot-core"><OctoMark large /></div>
        <span className="agent-satellite satellite-codex">{codexChip.label}<small>{agentStateLabel(codexChip.state)}</small></span>
        <span className="agent-satellite satellite-claude">{claudeChip.label}<small>{agentStateLabel(claudeChip.state)}</small></span>
        <span className="agent-satellite satellite-telegram">Telegram<small>live</small></span>
      </div>
      <div className="hero-now">
        <span>Agora no Maestro</span>
        <strong>{leadTask ? `#${leadTask.id} · ${leadTask.text}` : "Fila livre para a próxima missão"}</strong>
        <small>{leadTask
          ? `${leadTask.projectKey ?? "sem projeto"} · ${taskStatusLabels[leadTask.status]}`
          : data.autopilot.enabled
            ? "Autopilot aguardando a próxima task válida"
            : "Crie uma task pelo painel ou Telegram"}</small>
      </div>
    </section>
  );
}

function SummaryStrip({ data }: { data: DashboardData }) {
  const cards = [
    ["Projetos", data.summary.projects, "pink", "folder"],
    ["Em movimento", data.summary.activeTasks, "cyan", "pulse"],
    ["Na fila", data.summary.queuedTasks, "lime", "queue"],
    ["Sua decisão", data.summary.humanGates, "violet", "hand"]
  ];
  return (
    <section className="summary-strip" aria-label="Resumo operacional">
      {cards.map(([label, value, tone, icon]) => (
        <article className={`metric-card tone-${tone}`} key={label}>
          <div className="metric-icon"><Icon name={String(icon)} /></div>
          <span>{label}</span>
          <strong>{value}</strong>
        </article>
      ))}
    </section>
  );
}

function HumanReviewQueue({
  reviews,
  onChanged
}: {
  reviews: ReviewQueueItem[];
  onChanged: () => Promise<unknown>;
}) {
  const [selectedRunId, setSelectedRunId] = useState<number | null>(reviews[0]?.runId ?? null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<HumanReviewDecision | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (reviews.length === 0) setSelectedRunId(null);
    else if (!reviews.some((item) => item.runId === selectedRunId)) setSelectedRunId(reviews[0].runId);
  }, [reviews, selectedRunId]);

  const selected = reviews.find((item) => item.runId === selectedRunId) ?? reviews[0] ?? null;
  const changeSafetyGate = selected?.changeSafetyGate ?? {
    status: "passed" as const,
    code: "secret_scan_passed",
    message: "Verificacao de segredos concluida sem alertas."
  };
  const isChangeSafetyPassed = changeSafetyGate.status === "passed";

  async function decide(decision: HumanReviewDecision) {
    if (!selected || note.trim().length < 4) return;
    setBusy(decision);
    setError(null);
    try {
      await decideHumanReview(selected.runId, decision, note.trim());
      setNote("");
      await onChanged();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "A decisão não foi registrada.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="panel human-review-queue" id="reviews" aria-labelledby="reviews-title">
      <SectionHeader eyebrow="Human gate" title="Aguardando revisão" meta={`${reviews.length} pendente(s)`} />
      {reviews.length === 0 ? (
        <EmptyState icon="shield" title="Nenhum PR esperando" text="Novos draft PRs revisados pelos agentes aparecem aqui." />
      ) : (
        <div className="review-workbench">
          <div className="review-inbox" role="list" aria-label="Pull requests aguardando revisão">
            {reviews.map((item) => (
              <button
                className={`review-inbox-item ${item.runId === selected?.runId ? "is-selected" : ""}`}
                key={item.runId}
                onClick={() => { setSelectedRunId(item.runId); setNote(""); setError(null); }}
              >
                <span>@{item.projectKey} · task #{item.taskId}</span>
                <strong>{item.demand}</strong>
                <small>{item.changedFiles.length} arquivo(s) · {item.agents.join(" + ") || "sem agente"}</small>
              </button>
            ))}
          </div>
          {selected ? (
            <article className="review-evidence">
              <header>
                <div><span>Goal #{selected.runId}</span><h3>{selected.demand}</h3></div>
                <span className={`review-security-state ${changeSafetyGateClass(changeSafetyGate.status)}`}>
                  {changeSafetyGateLabel(changeSafetyGate.status)}
                </span>
              </header>
              <p className="review-summary">{selected.summary}</p>
              <div className="review-facts">
                <div><span>Projeto</span><strong>@{selected.projectKey}</strong></div>
                <div><span>Agentes</span><strong>{selected.agents.join(", ") || "nenhum"}</strong></div>
                <div><span>Commit</span><strong>{selected.commitSha?.slice(0, 8) ?? "pendente"}</strong></div>
                <div><span>Testes</span><strong>{selected.tests.length} etapa(s)</strong></div>
              </div>
              <div className="review-evidence-grid">
                <div>
                  <h4>Arquivos alterados</h4>
                  <ul>{selected.changedFiles.length > 0
                    ? selected.changedFiles.map((file) => <li key={file}><code>{file}</code></li>)
                    : <li>Nenhum arquivo identificado.</li>}</ul>
                </div>
                <div>
                  <h4>Testes executados</h4>
                  <ul>{selected.tests.length > 0
                    ? selected.tests.map((test, index) => <li key={`${test.provider}-${index}`}><strong>{test.status}</strong> · {test.summary}</li>)
                    : <li>Nenhuma etapa de teste registrada.</li>}</ul>
                </div>
              </div>
              <div className="review-alerts">
                {selected.securityAlerts.map((alert, index) => (
                  <div className={`review-alert alert-${alert.severity}`} key={`${alert.code}-${index}`}>
                    <Icon name={alert.severity === "info" ? "shield" : "warning"} />
                    <span><strong>{alert.message}</strong>{alert.file ? <code>{alert.file}</code> : null}</span>
                  </div>
                ))}
              </div>
              <div className="review-links">
                <a href={selected.diffUrl} target="_blank" rel="noreferrer">Abrir diff <Icon name="arrow" /></a>
                <a href={selected.pullRequestUrl} target="_blank" rel="noreferrer">Abrir PR no GitHub <Icon name="arrow" /></a>
              </div>
              <label className="review-note">
                Justificativa da decisão
                <textarea value={note} onChange={(event) => setNote(event.target.value)} minLength={4} maxLength={1200} placeholder="Registre por que aprovar, ajustar ou rejeitar." />
              </label>
              {error ? <p className="review-decision-error">{error}</p> : null}
              <div className="review-decision-actions">
                <button className="decision-reject" disabled={busy !== null || note.trim().length < 4} onClick={() => void decide("rejected")}>Rejeitar</button>
                <button className="decision-changes" disabled={busy !== null || note.trim().length < 4} onClick={() => void decide("changes_requested")}>Solicitar ajustes</button>
                <button
                  className="decision-approve"
                  disabled={busy !== null || note.trim().length < 4 || !isChangeSafetyPassed}
                  title={!isChangeSafetyPassed ? changeSafetyGate.message : undefined}
                  onClick={() => void decide("approved")}
                >
                  {busy === "approved" ? "Aprovando..." : "Aprovar para merge"}
                </button>
              </div>
              <small className="review-merge-note">A aprovação marca o PR como pronto. O Maestro nunca executa o merge automaticamente.</small>
            </article>
          ) : null}
        </div>
      )}
    </section>
  );
}

function TaskBoard({ tasks, onOpenTask }: { tasks: DashboardTask[]; onOpenTask: (taskId: number) => void }) {
  return (
    <section className="panel task-board" id="tasks" aria-labelledby="tasks-title">
      <SectionHeader eyebrow="Execução" title="Fluxo de tasks" meta={`${tasks.length} visíveis`} />
      <div className="task-list">
        {tasks.length === 0 ? (
          <EmptyState icon="spark" title="Tudo em ordem" text="Nenhuma task ativa neste momento." />
        ) : tasks.slice(0, 8).map((task) => <TaskRow task={task} key={task.id} onOpen={() => onOpenTask(task.id)} />)}
      </div>
    </section>
  );
}

function WorkGraphBoard({
  workGraphs,
  onChanged
}: {
  workGraphs: DashboardWorkGraph[];
  onChanged: () => Promise<unknown>;
}) {
  const [busyId, setBusyId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const active = workGraphs.filter((graph) => !["completed", "cancelled"].includes(graph.status));

  async function handleCancel(graph: DashboardWorkGraph) {
    if (!window.confirm(`Cancelar o Work Graph #${graph.id}? Artefatos e historico serao preservados.`)) return;
    setBusyId(graph.id);
    setError(null);
    try {
      await cancelWorkGraph(graph.id, "Cancelado pelo dashboard.");
      await onChanged();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Nao foi possivel cancelar o Work Graph.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="panel work-graph-board" id="work-graphs" aria-labelledby="work-graphs-title">
      <SectionHeader eyebrow="Multi-agent" title="Work Graphs" meta={`${active.length} ativo(s)`} />
      {error ? <p className="detail-error">{error}</p> : null}
      <div className="work-graph-list">
        {workGraphs.length === 0 ? (
          <EmptyState icon="spark" title="Nenhum Work Graph" text="Tasks complexas poderao aparecer aqui como DAGs governados." />
        ) : workGraphs.slice(0, 6).map((graph) => (
          <article className={`work-graph-card status-${graph.status}`} key={graph.id}>
            <header>
              <div>
                <span>@{graph.projectKey ?? "inbox"} · task #{graph.taskId}</span>
                <strong>Graph #{graph.id} · {graph.status}</strong>
              </div>
              <small>{graph.artifactCount} artefatos · {Math.ceil(graph.artifactBytes / 1024)} KB</small>
            </header>
            <p>{graph.objective}</p>
            <div className="work-graph-evidence">
              <span>
                Adocao <strong>{graph.adoption?.decision ?? "sem evento"}</strong>
                {graph.adoption ? ` - ${graph.adoption.reason}` : ""}
              </span>
              <span>
                Canario <strong>{graph.canary.quality}</strong> - {formatWorkGraphDuration(graph.canary.durationMs)} -
                {` ${graph.canary.attempts} attempts - ${graph.canary.fallbacks} fallbacks - ${graph.canary.conflicts} conflitos - ~${graph.canary.estimatedTokens} tokens`}
              </span>
            </div>
            <div className="worker-node-strip">
              {graph.nodes.map((node) => (
                <div className={`worker-node status-${node.status}`} key={node.id} title={node.lastError ?? node.key}>
                  <span>{node.role}</span>
                  <strong>{node.key}</strong>
                  <small>{node.mode === "writer" ? "WRITE" : "READ"} · {node.attemptCount}/{node.maxAttempts}</small>
                  {node.fallbackCount ? <small>{node.fallbackCount} fallback(s)</small> : null}
                  {node.attempts.map((attempt) => (
                    <small className="worker-attempt" key={attempt.attemptNumber} title={attempt.error ?? attempt.summary}>
                      #{attempt.attemptNumber} {attempt.provider} - {attempt.status} - {formatWorkGraphDuration(attempt.durationMs)}
                    </small>
                  ))}
                </div>
              ))}
            </div>
            {graph.artifacts.length ? (
              <div className="work-graph-artifacts">
                {graph.artifacts.slice(0, 5).map((artifact) => (
                  <span key={`${artifact.nodeId}-${artifact.key}`} title={artifact.summary}>
                    {artifact.kind} - {artifact.key} - {artifact.bytes} bytes
                  </span>
                ))}
              </div>
            ) : null}
            <footer>
              <span>Paralelo: {graph.maxParallelReaders} readers</span>
              {isWorkGraphCancellable(graph) ? (
                <button disabled={busyId !== null} onClick={() => void handleCancel(graph)}>
                  {busyId === graph.id ? "Cancelando..." : "Cancelar graph"}
                </button>
              ) : <small>Historico preservado</small>}
            </footer>
          </article>
        ))}
      </div>
    </section>
  );
}

function FeatureBoard({ features, onChanged }: { features: DashboardFeature[]; onChanged: () => Promise<unknown> }) {
  const [busyId, setBusyId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sortedFeatures = [...features].sort((left, right) => {
    const statusDelta = featureStatusOrder.indexOf(left.status) - featureStatusOrder.indexOf(right.status);
    if (statusDelta !== 0) return statusDelta;
    return new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime();
  });
  const counts = features.reduce<Record<FeatureStatus, number>>((accumulator, feature) => {
    accumulator[feature.status] += 1;
    return accumulator;
  }, {
    draft: 0,
    waiting_checks: 0,
    reviewing: 0,
    waiting_provider: 0,
    changes_requested: 0,
    merging: 0,
    completed: 0,
    failed: 0,
    cancelled: 0
  });

  async function handleCancel(feature: DashboardFeature) {
    if (!window.confirm(`Cancelar a Feature #${feature.id} (${feature.name}) antes do merge? O historico e o PR consolidado sao preservados para auditoria.`)) return;
    setBusyId(feature.id);
    setError(null);
    try {
      await cancelFeature(feature.id, "Cancelada pelo dashboard.");
      await onChanged();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Nao foi possivel cancelar a Feature.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="panel feature-board" id="features" aria-labelledby="features-title">
      <SectionHeader eyebrow="Feature PRs" title="Runtime de features" meta={`${features.length} registradas`} />
      <div className="feature-status-strip" aria-label="Estados de feature">
        {featureStatusOrder.map((status) => (
          <span className={`feature-status-count status-${status}`} key={status}>
            <strong>{counts[status]}</strong>{featureStatusLabels[status]}
          </span>
        ))}
      </div>
      {error ? <p className="detail-error">{error}</p> : null}
      <div className="feature-list">
        {sortedFeatures.length === 0 ? (
          <EmptyState icon="folder" title="Nenhuma Feature PR" text="Features registradas aparecem aqui durante checks, review final e merge." />
        ) : sortedFeatures.slice(0, 6).map((feature) => (
          <article className={`feature-row status-${feature.status}`} key={feature.id}>
            <span className={`status-rail status-${feature.status}`} />
            <div className="feature-copy">
              <div><span className="project-tag">@{feature.projectKey}</span><FeatureStatusPill status={feature.status} /></div>
              <strong>{feature.name}</strong>
              <p>{feature.lastError ?? feature.reviewSummary ?? feature.objective}</p>
              <small>{feature.itemCount} Work PR(s) - {feature.branchName}</small>
              {feature.status === "cancelled" && feature.cancelReason ? <small>Cancelada: {feature.cancelReason}</small> : null}
            </div>
            <div className="feature-progress" aria-label={`Status: ${featureStatusLabels[feature.status]}`}>
              <span><i style={{ width: `${featureProgress(feature.status)}%` }} /></span>
              <small>{featureProgress(feature.status)}%</small>
            </div>
            <div className="feature-row-actions">
              {feature.cancellable ? (
                <button
                  className="row-action row-action-danger"
                  aria-label={`Cancelar Feature ${feature.id}`}
                  disabled={busyId !== null}
                  onClick={() => void handleCancel(feature)}
                >
                  {busyId === feature.id ? "..." : "Cancelar"}
                </button>
              ) : null}
              <a className="row-action" href={feature.pullRequestUrl} target="_blank" rel="noreferrer" aria-label={`Abrir Feature PR ${feature.id}`}>
                <Icon name="arrow" />
              </a>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function FeaturePlanBoard({
  featurePlans,
  onChanged
}: {
  featurePlans: DashboardFeaturePlan[];
  onChanged: () => Promise<unknown>;
}) {
  const [busyId, setBusyId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const visiblePlans = featurePlans.filter((plan) => showHistory || plan.lifecycleStatus === "active");
  const sortedPlans = [...visiblePlans].sort((left, right) => (
    new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime()
  ));

  async function handleCancel(plan: DashboardFeaturePlan) {
    if (!window.confirm(`Cancelar o Feature Plan #${plan.id} antes da integracao? O historico sera preservado.`)) return;
    setBusyId(plan.id);
    setError(null);
    try {
      await cancelFeaturePlan(plan.id, "Cancelado pelo dashboard.");
      await onChanged();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Nao foi possivel cancelar o Feature Plan.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="panel feature-plan-board" id="feature-plans" aria-labelledby="feature-plans-title">
      <SectionHeader
        eyebrow="Planejamento"
        title="Feature Plans"
        meta={`${featurePlans.filter((plan) => plan.lifecycleStatus === "active").length} ativo(s)`}
      />
      {featurePlans.some((plan) => plan.lifecycleStatus !== "active") ? (
        <button className="row-action" onClick={() => setShowHistory((current) => !current)}>
          {showHistory ? "Ocultar historico" : "Ver historico"}
        </button>
      ) : null}
      {error ? <p className="detail-error">{error}</p> : null}
      <div className="feature-plan-list">
        {sortedPlans.length === 0 ? (
          <EmptyState icon="spark" title="Nenhum Feature Plan" text="Planos agrupando varias tasks em um unico PR consolidado aparecem aqui." />
        ) : sortedPlans.slice(0, 6).map((plan) => (
          <article className={`feature-plan-row plan-${plan.lifecycleStatus}`} key={plan.id}>
            <div className="feature-plan-copy">
              <div>
                <span className="project-tag">@{plan.projectKey}</span>
                <span className={`status-pill plan-status-${plan.lifecycleStatus}`}>
                  {plan.lifecycleStatus === "active" ? "ativo" : plan.lifecycleStatus === "completed" ? "concluido" : "cancelado"}
                </span>
                {plan.lifecycleStatus === "active" ? (
                  <span className={`status-pill eligibility-${plan.eligible ? "ready" : "blocked"}`}>
                    {plan.eligible ? "elegivel para integrar" : "aguardando tasks"}
                  </span>
                ) : null}
              </div>
              <strong>{plan.objective}</strong>
              <small>{plan.taskCount} task(s) no bloco - revisao {plan.revision}</small>
              <div className="feature-plan-tasks">
                {plan.tasks.map((task) => (
                  <span
                    className={`status-pill status-${task.status}`}
                    key={task.id}
                    title={[
                      task.objective,
                      `Depende de: ${task.dependsOnTaskIds.length ? task.dependsOnTaskIds.map((id) => `#${id}`).join(", ") : "nenhuma"}`,
                      `Escopo: ${task.mutationScope.length ? task.mutationScope.join(", ") : "somente leitura"}`,
                      `Modo: ${task.parallelMode}`,
                      `Aceite: ${task.acceptanceCriteria.join(" | ")}`,
                      `Fora de escopo: ${task.excludedScope.join(", ") || "nao especificado"}`
                    ].join("\n")}
                  >
                    #{task.id} {task.status}
                  </span>
                ))}
              </div>
              {plan.blockers.length > 0 ? (
                <ul className="feature-plan-blockers">
                  {plan.blockers.map((blocker, index) => <li key={index}>{blocker}</li>)}
                </ul>
              ) : null}
              {plan.integration ? (
                <small className={plan.integration.status === "failed" ? "feature-plan-integration-error" : ""}>
                  Integracao: {plan.integration.status} ({plan.integration.checkpoint})
                  {plan.integration.lastError ? ` - ${plan.integration.lastError}` : ""}
                </small>
              ) : null}
              {plan.cancelReason ? <small>Cancelado: {plan.cancelReason}</small> : null}
            </div>
            <div className="feature-plan-actions">
              {plan.cancellable ? (
                <button
                  className="row-action row-action-danger"
                  disabled={busyId !== null}
                  onClick={() => void handleCancel(plan)}
                >
                  {busyId === plan.id ? "..." : "Cancelar plano"}
                </button>
              ) : null}
              {plan.feature ? (
                <a className="feature-plan-linked" href={plan.feature.pullRequestUrl} target="_blank" rel="noreferrer">
                  Feature #{plan.feature.id} - {featureStatusLabels[plan.feature.status]}
                </a>
              ) : null}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function TaskRow({ task, onOpen }: { task: DashboardTask; onOpen: () => void }) {
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
        <div><span className="project-tag">@{task.projectKey ?? "inbox"}</span><StatusPill status={task.status} /></div>
        <strong>{task.text}</strong>
        <small>{task.branchName ?? `criada ${formatRelative(task.createdAt)}`}</small>
      </div>
      <div className="task-progress" aria-label={`Status: ${taskStatusLabels[task.status]}`}>
        <span><i style={{ width: `${statusProgress(task.status)}%` }} /></span>
        <small>{statusProgress(task.status)}%</small>
      </div>
      <button className="row-action" aria-label={`Abrir task ${task.id}`} onClick={onOpen}><Icon name="arrow" /></button>
    </article>
  );
}

function AgentDock({
  agents,
  environments
}: {
  agents: DashboardData["agents"];
  environments: DashboardData["environments"];
}) {
  const [policy, setPolicy] = useState<ProviderPolicySnapshot | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const providers = agents.filter((agent): agent is typeof agent & { id: AgentProviderId } => agent.id !== "telegram");

  const loadPolicy = useCallback(async () => {
    try {
      setPolicy(await fetchProviderPolicy());
      setError(null);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Falha ao carregar providers.");
    }
  }, []);

  useEffect(() => { void loadPolicy(); }, [loadPolicy]);

  const controlFor = (providerId: AgentProviderId) => policy?.controls.find((item) => item.providerId === providerId)
    ?? { providerId, mode: "enabled" as ProviderMode, fallbackEnabled: true, updatedAt: null };

  const changeControl = async (providerId: AgentProviderId, mode: ProviderMode, fallbackEnabled: boolean) => {
    setBusy(`provider:${providerId}`);
    try {
      await updateProviderControl(providerId, { mode, fallbackEnabled });
      await loadPolicy();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Falha ao atualizar provider.");
    } finally {
      setBusy(null);
    }
  };

  const useOnly = async (providerId: AgentProviderId) => {
    setBusy("only");
    try {
      await updateProviderControls(providers.map((provider) => ({
        mode: provider.id === providerId ? "enabled" : "paused",
        providerId: provider.id,
        fallbackEnabled: provider.id === providerId ? false : true
      })));
      await loadPolicy();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Falha ao aplicar provider exclusivo.");
    } finally {
      setBusy(null);
    }
  };

  const changeRouting = async (
    capability: AgentCapability,
    primary: AgentProviderId,
    requiredProviderId: AgentProviderId | null
  ) => {
    const current = policy?.capabilities.find((item) => item.capability === capability);
    if (!current) return;
    setBusy(`capability:${capability}`);
    try {
      await updateCapabilityRouting(capability, {
        order: [primary, ...current.order.filter((item) => item !== primary)],
        requiredProviderId
      });
      await loadPolicy();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Falha ao atualizar roteamento.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="panel agent-dock" id="providers" aria-labelledby="agents-title">
      <SectionHeader eyebrow="Control plane" title="Providers e roteamento" meta="controle persistente" />
      {error ? <p className="provider-error">{error}</p> : null}
      <div className="provider-layout">
        <div className="agent-list">
        {providers.map((agent) => {
          const control = controlFor(agent.id);
          return (
          <article className={`agent-card agent-${agent.id}`} key={agent.id}>
            <div className="agent-avatar">{agent.label.slice(0, 1)}</div>
            <div><strong>{agent.label}</strong><small>{agent.detail}</small></div>
            <span className={`agent-state state-${agent.state}`}>{agentStateLabel(agent.state)}</span>
            <div className="provider-controls">
              <label>Uso
                <select
                  value={control.mode}
                  disabled={busy !== null}
                  onChange={(event) => void changeControl(agent.id, event.target.value as ProviderMode, control.fallbackEnabled)}
                >
                  <option value="enabled">Ativo</option>
                  <option value="paused">Pausado</option>
                  <option value="disabled">Desativado</option>
                </select>
              </label>
              <label className="provider-check">
                <input
                  type="checkbox"
                  checked={control.fallbackEnabled}
                  disabled={busy !== null}
                  onChange={(event) => void changeControl(agent.id, control.mode, event.target.checked)}
                /> fallback
              </label>
              <button disabled={busy !== null} onClick={() => void useOnly(agent.id)}>Usar somente este</button>
            </div>
          </article>
          );
        })}
        {environments.map((environment) => (
          <article className="agent-card agent-environment" key={`environment-${environment.projectKey}`}>
            <div className="agent-avatar"><Icon name="pulse" /></div>
            <div>
              <strong>Ambiente @{environment.projectKey}</strong>
              <small>{environment.status === "ready" ? environment.summary : environment.recommendedAction}</small>
            </div>
            <span className={`agent-state state-${environment.status === "ready" ? "ready" : "attention"}`}>
              {environment.status === "ready" ? "pronto" : "atencao"}
            </span>
          </article>
        ))}
        </div>
        <div className="routing-table">
          <div className="routing-heading"><strong>Prioridade por funcao</strong><small>Escolha o primeiro provider e, quando preciso, torne-o obrigatorio.</small></div>
          {policy?.capabilities.map((routing) => (
            <div className="routing-row" key={routing.capability}>
              <strong>{capabilityLabel(routing.capability)}</strong>
              <label>Primeiro
                <select
                  value={routing.order[0]}
                  disabled={busy !== null}
                  onChange={(event) => void changeRouting(routing.capability, event.target.value as AgentProviderId, routing.requiredProviderId)}
                >
                  {providers.map((provider) => <option value={provider.id} key={provider.id}>{provider.label}</option>)}
                </select>
              </label>
              <label>Regra
                <select
                  value={routing.requiredProviderId ?? "auto"}
                  disabled={busy !== null}
                  onChange={(event) => void changeRouting(
                    routing.capability,
                    routing.order[0],
                    event.target.value === "auto" ? null : event.target.value as AgentProviderId
                  )}
                >
                  <option value="auto">Fallback automatico</option>
                  {providers.map((provider) => <option value={provider.id} key={provider.id}>Somente {provider.label}</option>)}
                </select>
              </label>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function capabilityLabel(capability: AgentCapability) {
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

function ProjectDeck({ projects }: { projects: DashboardProject[] }) {
  return (
    <section className="panel project-deck" id="projects" aria-labelledby="projects-title">
      <SectionHeader eyebrow="Workspace" title="Projetos locais" meta={`${projects.length} registrados`} />
      <div className="project-grid">
        {projects.map((project, index) => (
          <article className={`project-card project-tone-${index % 3}`} key={project.key}>
            <div className="project-icon"><Icon name={project.key === "boo" ? "ghost" : "folder"} /></div>
            <div className="project-title"><span>@{project.key}</span><strong>{project.name}</strong></div>
            <div className="project-stats">
              <span><strong>{project.activeTaskCount}</strong> ativas</span>
              <span><strong>{project.taskCount}</strong> total</span>
              <span><strong>{project.defaultBranch}</strong> branch</span>
            </div>
            <div className="project-live-status">
              {project.currentWork.length > 0
                ? project.currentWork.map((work) => <span key={`${work.taskId}-${work.phase}`}>{work.provider ?? "Maestro"} · task #{work.taskId} · {work.phase}</span>)
                : <span>Nenhum agente trabalhando agora</span>}
            </div>
            <small className="project-path">Repositório local protegido</small>
          </article>
        ))}
      </div>
    </section>
  );
}

function ImprovementLab({
  improvements,
  onChanged
}: {
  improvements: ImprovementProposal[];
  onChanged: () => Promise<unknown>;
}) {
  const [category, setCategory] = useState<ImprovementCategory>("skill");
  const [risk, setRisk] = useState<ImprovementRisk>("low");
  const [title, setTitle] = useState("");
  const [rationale, setRationale] = useState("");
  const [proposedChange, setProposedChange] = useState("");
  const [evidence, setEvidence] = useState("");
  const [busyId, setBusyId] = useState<number | "create" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusyId("create");
    setError(null);
    try {
      await createImprovement({
        category,
        risk,
        title,
        rationale,
        proposedChange,
        evidence: evidence.split("\n").map((item) => item.trim()).filter(Boolean)
      });
      setTitle("");
      setRationale("");
      setProposedChange("");
      setEvidence("");
      await onChanged();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Falha ao registrar proposta.");
    } finally {
      setBusyId(null);
    }
  }

  async function decide(id: number, status: "approved" | "rejected") {
    setBusyId(id);
    setError(null);
    try {
      await decideImprovement(id, status);
      await onChanged();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Falha ao decidir proposta.");
    } finally {
      setBusyId(null);
    }
  }

  const candidates = improvements.filter((item) => item.status === "candidate");
  return (
    <section className="panel improvement-lab" id="learning" aria-labelledby="learning-title">
      <SectionHeader eyebrow="Evolucao segura" title="Laboratorio de aprendizado" meta={`${candidates.length} aguardando decisao`} />
      <div className="improvement-layout">
        <form className="improvement-form" onSubmit={submit}>
          <strong>Propor melhoria</strong>
          <p>O Maestro registra a hipotese e a evidencia. Aprovar nao altera codigo, prompt ou skill automaticamente.</p>
          <div className="improvement-fields two-columns">
            <label>Categoria<select value={category} onChange={(event) => setCategory(event.target.value as ImprovementCategory)}>
              <option value="skill">skill</option><option value="memory">memoria</option>
              <option value="routing">roteamento</option><option value="policy">politica</option>
              <option value="integration">integracao</option>
            </select></label>
            <label>Risco<select value={risk} onChange={(event) => setRisk(event.target.value as ImprovementRisk)}>
              <option value="low">baixo</option><option value="medium">medio</option><option value="high">alto</option>
            </select></label>
          </div>
          <label>Titulo<input value={title} onChange={(event) => setTitle(event.target.value)} minLength={4} required /></label>
          <label>Por que mudar?<textarea value={rationale} onChange={(event) => setRationale(event.target.value)} minLength={8} required /></label>
          <label>Mudanca proposta<textarea value={proposedChange} onChange={(event) => setProposedChange(event.target.value)} minLength={8} required /></label>
          <label>Evidencias, uma por linha<textarea value={evidence} onChange={(event) => setEvidence(event.target.value)} minLength={4} required /></label>
          {error ? <p className="improvement-error">{error}</p> : null}
          <button type="submit" disabled={busyId !== null}>Registrar candidata <Icon name="arrow" /></button>
        </form>
        <div className="improvement-queue">
          {improvements.length === 0 ? (
            <EmptyState icon="spark" title="Nenhuma proposta ainda" text="Aprendizados entram aqui antes de qualquer mutacao persistente." />
          ) : improvements.slice(0, 8).map((item) => (
            <article className={`improvement-card improvement-${item.status}`} key={item.id}>
              <header><span>#{item.id} · {item.category}</span><span className={`risk-${item.risk}`}>risco {item.risk}</span></header>
              <strong>{item.title}</strong>
              <p>{item.rationale}</p>
              <small>
                {item.evidence.length} evidencia(s) · origem {item.source}
                {item.confidence === null ? "" : ` · confiança ${Math.round(item.confidence * 100)}%`}
              </small>
              {item.status === "candidate" ? (
                <div className="improvement-actions">
                  <button onClick={() => void decide(item.id, "rejected")} disabled={busyId !== null}>Rejeitar</button>
                  <button onClick={() => void decide(item.id, "approved")} disabled={busyId !== null}>Aprovar para implementar</button>
                </div>
              ) : (
                <span className={`improvement-decision decision-${item.status}`}>
                  {item.status}
                  {item.featurePlanId ? ` · Feature Plan #${item.featurePlanId}` : ""}
                  {item.taskId ? ` · Task #${item.taskId}` : ""}
                </span>
              )}
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

function EventStream({ events }: { events: DashboardEvent[] }) {
  return (
    <section className="panel event-stream" id="events" aria-labelledby="events-title">
      <SectionHeader eyebrow="Telemetria" title="Pulso do sistema" meta="ao vivo" />
      <div className="event-list">
        {events.slice(0, 12).map((event) => (
          <article className="event-row" key={event.id}>
            <span className={`event-node event-${event.source}`} />
            <div><strong>{humanizeEvent(event.type)}</strong><p>{event.text}</p></div>
            <time dateTime={event.createdAt}>{formatRelative(event.createdAt)}</time>
          </article>
        ))}
      </div>
    </section>
  );
}

function TaskComposer({
  open,
  projects,
  onClose,
  onCreated
}: {
  open: boolean;
  projects: DashboardProject[];
  onClose: () => void;
  onCreated: () => Promise<void>;
}) {
  const [projectKey, setProjectKey] = useState("");
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open && !projectKey && projects.length > 0) setProjectKey(projects[0].key);
  }, [open, projectKey, projects]);

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [open, onClose]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await createTask({ projectKey, text });
      setText("");
      await onCreated();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Não foi possível criar a task.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className={`composer-backdrop ${open ? "is-open" : ""}`} aria-hidden={!open} onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <aside className="task-composer" role="dialog" aria-modal="true" aria-labelledby="composer-title">
        <button className="composer-close" onClick={onClose} aria-label="Fechar"><Icon name="close" /></button>
        <span className="eyebrow"><span /> nova missão</span>
        <h2 id="composer-title">O que colocamos<br />em movimento?</h2>
        <p>Crie uma task local. O Maestro registra a origem, organiza a fila e mantém o projeto isolado.</p>
        <form onSubmit={submit}>
          <label>
            Projeto
            <select value={projectKey} onChange={(event) => setProjectKey(event.target.value)} required>
              {projects.map((project) => <option value={project.key} key={project.key}>@{project.key} · {project.name}</option>)}
            </select>
          </label>
          <label>
            Demanda
            <textarea
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder="Ex.: revisar a integração de voz e propor testes de latência"
              minLength={4}
              maxLength={2000}
              required
            />
          </label>
          <div className="composer-hint"><Icon name="shield" /><span>A task será criada como <strong>queued</strong>. Execução exige uma etapa explícita.</span></div>
          {error ? <p className="form-error">{error}</p> : null}
          <button className="composer-submit" disabled={submitting || !projectKey || text.trim().length < 4}>
            {submitting ? "Criando..." : "Criar task"}<Icon name="arrow" />
          </button>
        </form>
      </aside>
    </div>
  );
}

function TaskDetail({
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
      .then((items) => { if (active) setReviews(items); })
      .catch(() => { if (active) setReviews([]); });
    return () => { active = false; };
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
    <div className="detail-backdrop is-open" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <aside className="task-detail" role="dialog" aria-modal="true" aria-labelledby="task-detail-title">
        <button className="composer-close" onClick={onClose} aria-label="Fechar detalhes"><Icon name="close" /></button>
        <span className="task-detail-id">task #{String(task.id).padStart(2, "0")}</span>
        <StatusPill status={task.status} />
        <h2 id="task-detail-title">{task.text}</h2>
        <div className="detail-project"><span>@{task.projectKey ?? "inbox"}</span><strong>{task.projectName ?? "Sem projeto"}</strong></div>

        <dl className="detail-metadata">
          <div><dt>Origem</dt><dd>{task.source}</dd></div>
          <div><dt>Criada</dt><dd>{formatRelative(task.createdAt)}</dd></div>
          <div><dt>Branch</dt><dd>{task.branchName ?? "ainda não criada"}</dd></div>
          <div><dt>Worktree</dt><dd>{task.worktreePrepared ? "isolada e preparada" : "aguardando preparo"}</dd></div>
        </dl>

        <div className="detail-flow">
          <span className="is-done">01 <strong>Capturada</strong></span>
          <span className={task.status !== "queued" ? "is-done" : "is-current"}>02 <strong>Preparada</strong></span>
          <span className={task.status === "implementing" ? "is-current" : ""}>03 <strong>Executando</strong></span>
          <span className={task.status === "done" ? "is-done" : ""}>04 <strong>Concluída</strong></span>
        </div>

        {error ? <p className="detail-error">{error}</p> : null}
        <button className="detail-primary" disabled={!canPrepare || preparing} onClick={() => void handlePrepare()}>
          <span>{preparing ? "Preparando..." : canPrepare ? "Preparar worktree" : task.worktreePrepared ? "Worktree preparada" : "Ação indisponível"}</span>
          <Icon name={canPrepare ? "arrow" : "shield"} />
        </button>
        <p className="detail-footnote">A preparação cria branch e diretório isolados. Nenhum agente executa código nesta etapa.</p>

        <div className="goal-section">
          <div><span>Execucao persistente</span><strong>Goal autonoma</strong></div>
          <p>O Maestro planeja, implementa, testa e revisa. Se a revisao pedir ajustes, ele volta para implementacao sem atualizar a task manualmente.</p>
          <button
            className="goal-action"
            disabled={!task.worktreePrepared || ["running", "waiting_provider"].includes(goal?.status ?? "") || startingGoal || ["done", "awaiting_human", "ready_to_merge", "rejected", "cancelled"].includes(task.status)}
            onClick={() => void handleStartGoal()}
          >
            {startingGoal
              ? "Iniciando goal..."
              : goal?.status === "running"
                ? `Rodando ${goal.currentPhase} · ${goal.stepCount}/${goal.maxSteps}`
                : goal?.status === "waiting_provider"
                  ? `Aguardando provider · ${goal.stepCount}/${goal.maxSteps}`
                : task.status === "awaiting_human" && goal?.pullRequestUrl
                  ? "Draft PR aguardando merge"
                : task.worktreePrepared
                    ? "Iniciar goal"
                  : "Prepare a worktree primeiro"}
            <Icon name="pulse" />
          </button>
          {goal ? (
            <div className={`goal-state goal-${goal.status}`}>
              <span>goal #{goal.id} · {goal.status}</span>
              <strong>{goal.currentPhase} · passo {goal.stepCount}/{goal.maxSteps}</strong>
              {goal.observability ? (
                <small className="goal-observability">
                  {goal.observability.classifiedReasonLabel ? `Motivo: ${goal.observability.classifiedReasonLabel}` : goal.waitReason ? `Motivo: ${goal.waitReason}` : ""}
                  {goal.observability.sourceProvider ? ` · Origem: ${goal.observability.sourceProvider}` : goal.lastProvider ? ` · Origem: ${goal.lastProvider}` : ""}
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
                <a href={goal.pullRequestUrl} target="_blank" rel="noreferrer">Abrir draft PR</a>
              ) : null}
            </div>
          ) : null}
        </div>

        <div className="review-section">
          <div><span>Revisão externa</span><strong>Claude design review</strong></div>
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
              <header><span>Claude · #{review.id}</span><time>{formatRelative(review.createdAt)}</time></header>
              <strong>{review.status === "completed" ? "Revisão concluída" : review.status === "auth_required" ? "Autenticação necessária" : "Revisão falhou"}</strong>
              <p>{review.content || review.error}</p>
            </article>
          ))}
        </div>

        <div className="task-danger-zone">
          <div><span>Controle da task</span><strong>Cancelar ou apagar</strong></div>
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

function SectionHeader({ eyebrow, title, meta }: { eyebrow: string; title: string; meta?: string }) {
  return <header className="section-header"><div><span>{eyebrow}</span><h2>{title}</h2></div>{meta ? <small>{meta}</small> : null}</header>;
}

function changeSafetyGateClass(status: ReviewQueueItem["changeSafetyGate"]["status"]): string {
  return {
    passed: "is-safe",
    blocked: "is-danger",
    unavailable: "is-warning"
  }[status];
}

function changeSafetyGateLabel(status: ReviewQueueItem["changeSafetyGate"]["status"]): string {
  return {
    passed: "guard passou",
    blocked: "alerta de segurança",
    unavailable: "verificação indisponível"
  }[status];
}

function StatusPill({ status }: { status: TaskStatus }) {
  return <span className={`status-pill status-${status}`}>{taskStatusLabels[status]}</span>;
}

function FeatureStatusPill({ status }: { status: FeatureStatus }) {
  return <span className={`status-pill status-${status}`}>{featureStatusLabels[status]}</span>;
}

function EmptyState({ icon, title, text }: { icon: string; title: string; text: string }) {
  return <div className="empty-state"><Icon name={icon} /><strong>{title}</strong><p>{text}</p></div>;
}

function ErrorBanner({ message, onRetry }: { message: string; onRetry: () => void }) {
  return <div className="error-banner" role="alert"><Icon name="warning" /><span>{message}</span><button onClick={onRetry}>Tentar novamente</button></div>;
}

function LoadingScreen() {
  return <div className="loading-screen"><OctoMark large /><span>acordando o maestro</span><i /></div>;
}

function OctoMark({ large = false }: { large?: boolean }) {
  return (
    <svg className={large ? "octo-mark is-large" : "octo-mark"} viewBox="0 0 96 96" role="img" aria-label="Octomynd">
      <defs><linearGradient id="octoBody" x1="20" y1="8" x2="78" y2="86"><stop stopColor="#ff47d3" /><stop offset="1" stopColor="#d60eb2" /></linearGradient></defs>
      <path fill="url(#octoBody)" d="M24 39C24 19 38 8 55 11C73 14 82 29 76 46C72 58 65 63 60 66C68 66 76 70 76 78C76 85 67 87 61 80C56 74 54 69 50 69C47 69 48 79 42 83C35 88 28 82 31 75C33 70 38 67 34 65C30 63 27 73 19 74C11 75 9 66 15 61C20 57 27 56 29 52C26 49 24 44 24 39Z" />
      <path fill="#ff8be9" d="M28 26C21 19 25 10 33 13C39 15 38 23 32 29Z" />
      <circle cx="58" cy="35" r="15" fill="#fff" /><circle cx="63" cy="35" r="9" fill="#25e6ff" /><circle cx="66" cy="34" r="5" fill="#101018" /><circle cx="63" cy="31" r="2" fill="#fff" />
      <path d="M35 49C42 55 51 55 57 49" fill="none" stroke="#64124f" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

function Icon({ name, className = "" }: { name: string; className?: string }) {
  const paths: Record<string, ReactNode> = {
    grid: <><rect x="3" y="3" width="7" height="7" rx="2" /><rect x="14" y="3" width="7" height="7" rx="2" /><rect x="3" y="14" width="7" height="7" rx="2" /><rect x="14" y="14" width="7" height="7" rx="2" /></>,
    pulse: <path d="M3 12h4l2-7 4 14 2-7h6" />,
    folder: <path d="M3 6h7l2 2h9v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />,
    timeline: <><path d="M6 4v16" /><circle cx="6" cy="7" r="2" /><circle cx="6" cy="16" r="2" /><path d="M10 7h10M10 16h7" /></>,
    refresh: <><path d="M20 11a8 8 0 1 0-2 5" /><path d="M20 4v7h-7" /></>,
    plus: <path d="M12 5v14M5 12h14" />,
    queue: <><path d="M5 6h14M5 12h14M5 18h9" /><circle cx="3" cy="6" r=".5" /><circle cx="3" cy="12" r=".5" /><circle cx="3" cy="18" r=".5" /></>,
    hand: <path d="M7 11V7a2 2 0 0 1 4 0v3-5a2 2 0 0 1 4 0v5-3a2 2 0 0 1 4 0v6c0 5-3 8-7 8S5 18 4 15l-1-3a2 2 0 0 1 4-1Z" />,
    arrow: <><path d="m9 18 6-6-6-6" /><path d="M4 12h11" /></>,
    send: <><path d="m22 2-7 20-4-9-9-4Z" /><path d="M22 2 11 13" /></>,
    ghost: <path d="M5 20V10a7 7 0 0 1 14 0v10l-3-2-4 2-4-2-3 2Z" />,
    spark: <path d="m12 3 1.7 5.3L19 10l-5.3 1.7L12 17l-1.7-5.3L5 10l5.3-1.7Z" />,
    shield: <path d="M12 22S20 18 20 10V5l-8-3-8 3v5c0 8 8 12 8 12Z" />,
    close: <path d="m6 6 12 12M18 6 6 18" />,
    warning: <><path d="M12 3 2 21h20Z" /><path d="M12 9v5M12 18h.01" /></>
  };
  return <svg className={`icon ${className}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] ?? paths.spark}</svg>;
}

function statusProgress(status: TaskStatus): number {
  return { queued: 10, planning: 24, implementing: 48, testing: 68, reviewing: 82, changes_requested: 58, awaiting_human: 90, ready_to_merge: 96, waiting_quota: 36, waiting_provider: 36, waiting_dependency: 16, blocked: 42, failed: 100, rejected: 100, cancelled: 100, done: 100 }[status];
}

function featureProgress(status: FeatureStatus): number {
  return { draft: 12, waiting_checks: 34, reviewing: 58, waiting_provider: 48, changes_requested: 30, merging: 86, completed: 100, failed: 100, cancelled: 100 }[status];
}

function formatRelative(value: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 10) return "agora";
  if (seconds < 60) return `há ${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `há ${minutes}min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `há ${hours}h`;
  return new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "short" }).format(new Date(value));
}

function humanizeEvent(value: string): string {
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
