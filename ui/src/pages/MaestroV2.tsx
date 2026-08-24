import React, { FormEvent, useEffect, useMemo, useState } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { DashboardData, fetchProviderPolicy, updateProviderControl, updateProviderControls, updateCapabilityRouting, ProviderPolicySnapshot, AgentProviderId, ProviderMode, connectTelegram, createImprovement, decideImprovement, decideHumanReview, testProviderConnection, ProviderConnectionResult, fetchQuota, QuotaBucket, QuotaResult } from "../api";
import { TaskDetail } from "../components/TaskDetail";
import { OctoMark } from "../components/OctoMark";
import { Icon } from "../components/Icon";
import { NervousSystem } from "../components/NervousSystem";
import { taskStatusLabel, statusProgress, formatRelative } from "../helpers";
import { ProvidersPage } from "./ProvidersPage";
import { TaskLogViewerPage } from "./TaskLogViewerPage";
import { ReviewPage } from "./ReviewPage";
import { AnalyticsPage } from "./AnalyticsPage";
import { SettingsPage } from "./SettingsPage";
import { OperationalChatConsole } from "../components/OperationalChatConsole";
import { LanguageSelector } from "../components/LanguageSelector";
import { translate, useI18n } from "../i18n";

function PageTop({ title, eyebrow, action }: { title: string; eyebrow: string; action?: React.ReactNode }) {
  return <div className="top"><div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1></div>{action}</div>;
}

function AppSidebar({ pending }: { pending: number }) {
  const { locale } = useI18n();
  void locale;
  const routes = [
    { to: "/", label: translate("Overview"), icon: "grid", end: true },
    { to: "/chat", label: translate("Chat"), icon: "chat", end: true },
    { to: "/backlog", label: translate("Task flow"), icon: "pulse" },
    { to: "/reviews", label: translate("Awaiting review"), icon: "hand" },
    { to: "/projects", label: translate("Projects"), icon: "folder" },
    { to: "/providers", label: translate("Providers"), icon: "spark" },
    { to: "/analytics", label: translate("Analytics & Usage"), icon: "timeline" },
    { to: "/settings", label: translate("Settings"), icon: "settings" }
  ];
  return <aside>
    <NavLink className="brand" to="/" aria-label="Octomynd Maestro"><OctoMark /><div className="txt"><b>octomynd</b><span>Maestro</span></div></NavLink>
    <nav>
      {routes.map((item, index) => <React.Fragment key={item.to}>
        {index === 2 && <div className="nav-div" />}
        <NavLink to={item.to} end={item.end} className="nav-i"><Icon name={item.icon} />{item.label}{item.to === "/reviews" && pending > 0 ? <span className="badge-n">{pending}</span> : null}</NavLink>
      </React.Fragment>)}
    </nav>
    <div className="localfirst"><div className="pin" /><div><b>Local-first</b><span>127.0.0.1 · {translate("private access")}</span></div></div>
  </aside>;
}

function V2Header({ onRefresh, onCreate, refreshing }: { onRefresh: () => void; onCreate: () => void; refreshing: boolean }) {
  return <div className="top"><div><div className="eyebrow">{translate("Operation center")}</div><h1>{translate("Good morning.")}</h1></div><div className="top-actions"><div className="sync"><span className="d" /> {translate("Synced now")}</div><button className="icon-btn" onClick={onRefresh} aria-label={translate("Refresh")}>{refreshing ? "…" : "↻"}</button><button className="btn-new" onClick={onCreate}>{translate("+ New task")}</button></div></div>;
}

function Overview({ data, onCreate, onRefresh, refreshing }: { data: DashboardData; onCreate: () => void; onRefresh: () => void; refreshing: boolean }) {
  const navigate = useNavigate();
  const active = data.tasks.filter(t => !["done", "failed", "rejected", "cancelled"].includes(t.status));
  const recent = data.features.slice(0, 4);
  const costs = data.costSummary?.byProvider ?? [];
  const maxProviderCost = Math.max(...costs.map(item => item.costUsd), 0.0001);
  const events = data.events.slice(0, 3);
  return <div className="view active">
    <V2Header onRefresh={onRefresh} onCreate={onCreate} refreshing={refreshing} />
    {data.agents.filter(agent => agent.id !== "telegram").every(agent => agent.state === "offline") ? (
      <div className="panel" style={{ border: "1px solid rgba(196, 98, 45, 0.45)", marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <div>
            <div className="lbl" style={{ color: "#e8967a" }}>{translate("Mandatory first step")}</div>
            <h3 style={{ margin: "4px 0" }}>{translate("No provider connected — tasks are paused until you connect one")}</h3>
            <p style={{ margin: 0, color: "var(--text-2)", fontSize: 13 }}>
              {translate("Connect Claude, Codex, or Gemini Antigravity in Providers. Maestro never executes anything without at least one active agent.")}
            </p>
          </div>
          <button className="btn-new" onClick={() => navigate("/providers")}>{translate("Connect a provider now")}</button>
        </div>
      </div>
    ) : null}
    <div className="hero"><div className="hero-left"><div className="live-tag"><span className="d" /> {translate("Live system")}</div><h2>{translate("A brain.")}<br /><span>{translate("Arms that decide.")}</span></h2><p>{translate("Two thirds of an octopus's neurons live in its arms. Each agent proves its own work — and you keep the final decision.")}</p><div className="hero-chips"><span><b>{active.length}</b> {translate("active tasks")}</span><span><b>{data.summary.projects}</b> {translate("local projects")}</span><span>{translate("Access")} <b>{data.daemon.access === "restricted" ? translate("restricted") : translate("open")}</b></span><span>autopilot <b>{data.autopilot.state}</b></span></div></div><div className="nerve"><NervousSystem agents={data.agents} /></div></div>
    <div className="metrics"><Metric label={translate("Providers")} value={data.summary.providersConnected ?? data.agents.length} icon="✧" onClick={() => navigate("/providers")} /><Metric label={translate("moving")} value={data.summary.activeTasks} icon="⌁" onClick={() => navigate("/backlog")} /><Metric label={translate("queued")} value={data.summary.queuedTasks} icon="=" onClick={() => navigate("/backlog")} /><Metric label={translate("Your decision")} value={data.summary.humanGates} icon="♧" onClick={() => navigate("/reviews")} /></div>
    <div className="cols"><section className="panel"><PanelHead eyebrow={translate("Feature runtime")} title={translate("Recent flow")} meta={`${data.features.length} ${translate("registered")}`} />{recent.length ? recent.map(f => <FeatureLine key={f.id} feature={f} />) : <InlineEmpty text={translate("No feature recorded.")} />}</section><section className="panel"><PanelHead eyebrow={translate("Cost distribution")} title={translate("Today")} meta={`$${(data.costSummary?.todayTotalUsd ?? 0).toFixed(2)}`} />{costs.length ? costs.map((item, index) => <div className="costrow" key={item.provider}><span className="dot" style={{ background: ["#6f8f6a", "#c4622d", "#8a7c68", "#5c6f8f"][index % 4] }} /><div className="lbl">{item.provider}<small>{item.inputTokens + item.outputTokens} tokens</small></div><div className="track"><i style={{ width: `${Math.max(4, item.costUsd / maxProviderCost * 100)}%` }} /></div><span className="amt">${item.costUsd.toFixed(2)}</span></div>) : <InlineEmpty text={translate("No usage recorded today.")} />}<div className="divider" /><PanelHead eyebrow={translate("Telemetry")} title={translate("System pulse")} meta={`${events.length} events`} />{events.length ? events.map(event => <div className="pulse-item" key={event.id}><span className="pd" /><div className="pt"><b>{event.text}</b><span>{event.source} · {event.type}</span></div><span className="tm">{formatRelative(event.createdAt)}</span></div>) : <InlineEmpty text={translate("No recent events.")} />}</section></div>
  </div>;
}

function Metric({ label, value, icon, onClick }: { label: string; value: number; icon: string; onClick?: () => void }) { return <button type="button" className="metric" onClick={onClick} disabled={!onClick}><div className="ico">{icon}</div><div className="k">{label}</div><div className="v">{value}</div></button>; }
function PanelHead({ eyebrow, title, meta }: { eyebrow: string; title: string; meta: string }) { return <div className="panel-head"><div><div className="lbl">{eyebrow}</div><h3>{title}</h3></div><div className="count">{meta}</div></div>; }
function InlineEmpty({ text }: { text: string }) { return <div className="inline-empty">{text}</div>; }
function FeatureLine({ feature }: { feature: DashboardData["features"][number] }) { const status = feature.status === "completed" ? "ok" : feature.status === "failed" ? "err" : "run"; const label = feature.status === "completed" ? translate("Completed") : feature.status === "failed" ? translate("Failed") : translate("Running"); return <div className="task"><span className="id">#{String(feature.id).padStart(2, "0")}</span><span className={`st ${status}`}>{label}</span><div className="body"><b>{feature.name}</b><span>{feature.branchName}</span></div><div className="fiber"><svg viewBox="0 0 80 14"><path d="M2 7h76" stroke="#372c20" strokeWidth="2" /><path d={`M2 7h${feature.status === "completed" ? 76 : feature.status === "failed" ? 50 : 38}`} stroke={feature.status === "failed" ? "#b1503c" : feature.status === "completed" ? "#6f8f6a" : "#c4622d"} strokeWidth="2" /><circle cx={feature.status === "completed" ? 78 : feature.status === "failed" ? 52 : 40} cy="7" r="3" fill="#e8967a" /></svg></div><span className="arr">→</span></div>; }
function TaskLine({ task, onOpen }: { task: DashboardData["tasks"][number]; onOpen?: () => void }) {
  return (
    <div
      className="task"
      onClick={onOpen}
      style={onOpen ? { cursor: "pointer" } : undefined}
    >
      <span className="id">#{String(task.id).padStart(2, "0")}</span>
      <span className={`st ${task.status === "failed" ? "err" : task.status === "done" ? "ok" : "run"}`}>
        {taskStatusLabel(task.status)}
      </span>
      <div className="body">
        <b>{task.title || task.text}</b>
        <span>{task.branchName ?? `${translate("created")} ${formatRelative(task.createdAt)}`}</span>
      </div>
      <div className="fiber">
        <svg viewBox="0 0 80 14">
          <path d="M2 7h76" stroke="#372c20" strokeWidth="2" />
          <path
            d={`M2 7h${Math.max(8, statusProgress(task.status) * 0.76)}`}
            stroke={task.status === "failed" ? "#b1503c" : task.status === "done" ? "#6f8f6a" : "#c4622d"}
            strokeWidth="2"
          />
          <circle cx={Math.max(8, statusProgress(task.status) * 0.76)} cy="7" r="3" fill="#e8967a" />
        </svg>
      </div>
      <NavLink
        to={`/tasks/${task.id}/logs`}
        className="task-log-btn-link"
        title={translate("View task logs")}
        onClick={(e) => e.stopPropagation()}
      >
        Logs
      </NavLink>
      {onOpen ? (
        <button
          type="button"
          className="arr task-log-arrow"
          title={translate("Open task details (start goal, cancel, etc.)")}
          aria-label={`${translate("Open task details")} ${task.id}`}
          onClick={(event) => {
            event.stopPropagation();
            onOpen();
          }}
          style={{ background: "none", border: "none", cursor: "pointer", fontSize: "inherit" }}
        >
          →
        </button>
      ) : (
        <span className="arr task-log-arrow" aria-hidden="true">→</span>
      )}
    </div>
  );
}

function Flow({ data, onCreate }: { data: DashboardData; onCreate: () => void }) { const queued = data.tasks.filter(t => t.status === "queued").slice(0, 12); const active = data.tasks.filter(t => !["queued", "done", "failed", "rejected", "cancelled"].includes(t.status)); return <div className="view active"><PageTop eyebrow={translate("Prioritization")} title={translate("Task flow")} action={<div className="top-actions"><select className="sel"><option>{translate("All projects")}</option></select><button className="btn-new" onClick={onCreate}>{translate("+ New task")}</button></div>} /><section className="panel"><PanelHead eyebrow={translate("In progress")} title={translate("Tasks in progress")} meta={`${active.length} ${translate("active")}`} />{active.length ? active.map(t => <TaskLine key={t.id} task={t} />) : <div className="empty"><div className="ico">ϟ</div><h4>{translate("No task in progress")}</h4><p>{translate("Queued tasks will start automatically.")}</p></div>}</section><section className="panel"><PanelHead eyebrow={translate("Queue")} title={translate("Tasks in queue (Queued)")} meta={`${queued.length} ${translate("waiting")}`} />{queued.length ? queued.map(t => <TaskLine key={t.id} task={t} />) : <div className="empty"><div className="ico">=</div><h4>{translate("Empty queue")}</h4><p>{translate("Add new requests to put the agents to work.")}</p></div>}</section><section className="panel"><PanelHead eyebrow={translate("Planning")} title="Feature Plans" meta={`${data.featurePlans.length} ${translate("registered")}`} /><div className="empty"><div className="ico">▤</div><h4>Feature Plans</h4><p>{translate("Feature plans grouping multiple tasks into one consolidated PR appear here.")}</p></div></section></div>; }

function FlowFiltered({ data, onCreate }: { data: DashboardData; onCreate: () => void }) {
  const [projectKey, setProjectKey] = useState("all");
  // Deep-link from the Task Log Viewer ("Ir ao detalhe da task").
  const [detailTaskId, setDetailTaskId] = useState<number | null>(() => {
    const stored = window.sessionStorage.getItem("maestro:open-task");
    if (stored) {
      window.sessionStorage.removeItem("maestro:open-task");
      const parsed = Number(stored);
      return Number.isInteger(parsed) ? parsed : null;
    }
    return null;
  });
  const visibleTasks = projectKey === "all" ? data.tasks : data.tasks.filter(task => task.projectKey === projectKey);
  const queued = visibleTasks.filter(task => task.status === "queued").slice(0, 12);
  const active = visibleTasks.filter(task => !["queued", "done", "failed", "rejected", "cancelled"].includes(task.status));
  const history = visibleTasks.filter(task => ["done", "failed", "rejected", "cancelled"].includes(task.status)).slice(0, 20);
  const detailTask = detailTaskId != null ? data.tasks.find(task => task.id === detailTaskId) ?? null : null;
  const detailGoal = detailTaskId != null
    ? data.goals.filter(goal => goal.taskId === detailTaskId).slice(-1)[0] ?? null
    : null;
  const openDetail = (id: number) => setDetailTaskId(id);
  return <div className="view active"><PageTop eyebrow={translate("Prioritization")} title={translate("Task flow")} action={<div className="top-actions"><select className="sel" value={projectKey} onChange={event => setProjectKey(event.target.value)}><option value="all">{translate("All projects")}</option>{data.projects.map(project => <option value={project.key} key={project.key}>@{project.key}</option>)}</select><button className="btn-new" onClick={onCreate}>{translate("+ New task")}</button></div>} /><section className="panel"><PanelHead eyebrow={translate("In progress")} title={translate("Tasks in progress")} meta={`${active.length} ${translate("active")}`} />{active.length ? active.map(task => <TaskLine key={task.id} task={task} onOpen={() => openDetail(task.id)} />) : <div className="empty compact"><div className="ico">ϟ</div><h4>{translate("No task in progress")}</h4><p>{translate("No active work right now.")}</p></div>}</section><section className="panel"><PanelHead eyebrow={translate("Queue")} title={translate("Tasks in queue")} meta={`${queued.length} ${translate("waiting")}`} />{queued.length ? queued.map(task => <TaskLine key={task.id} task={task} onOpen={() => openDetail(task.id)} />) : <div className="empty compact"><div className="ico">=</div><h4>{translate("Empty queue")}</h4><p>{translate("Add a request to start work.")}</p></div>}</section><section className="panel"><PanelHead eyebrow={translate("History") } title={translate("Recent tasks")} meta={`${history.length} ${translate("displayed of")} ${visibleTasks.length}`} />{history.map(task => <TaskLine key={task.id} task={task} onOpen={() => openDetail(task.id)} />)}</section>
    <TaskDetail
      task={detailTask}
      goal={detailGoal}
      onClose={() => setDetailTaskId(null)}
      onPrepared={async () => { /* data refreshes via the 5s poll */ }}
      onDeleted={async () => { setDetailTaskId(null); }}
    />
  </div>;
}

function Reviews({ data }: { data: DashboardData }) { const [items, setItems] = useState(data.reviewQueue); const [busy, setBusy] = useState<number | null>(null); async function decide(runId: number, decision: "approved" | "changes_requested" | "rejected") { setBusy(runId); try { const updated = await decideHumanReview(runId, decision, decision === "changes_requested" ? "Ajustes solicitados pelo usuário" : "Decisão tomada no dashboard"); setItems(current => current.map(item => item.runId === runId ? updated : item)); } finally { setBusy(null); } } return <div className="view active"><PageTop eyebrow="Governança humana (Human Gate)" title="Aguardando revisão" action={<div className="chip"><b>{items.filter(item => item.status === "pending").length}</b> PRs pendentes</div>} /><p className="desc">Revise evidências, verificações de segurança e aprove ou solicite alterações antes do merge final.</p>{items.filter(item => item.status === "pending").length ? items.filter(item => item.status === "pending").map(item => <div className="pr-card" key={item.runId}><div><span className="pr-tag">Human gate</span><h4>{item.demand}</h4><p>{item.projectName} · {item.changedFiles.length} arquivos · {item.changeSafetyGate.status}</p><div className="pr-actions"><a className="pr-btn" href={item.pullRequestUrl} target="_blank" rel="noreferrer">Ver diff</a><button className="pr-btn reject" disabled={busy === item.runId} onClick={() => void decide(item.runId, "changes_requested")}>Solicitar alterações</button><button className="pr-btn" disabled={busy === item.runId} onClick={() => void decide(item.runId, "rejected")}>Rejeitar</button></div></div><div><button className="seal" disabled={busy === item.runId} onClick={() => void decide(item.runId, "approved")}>✓</button><div className="seal-lbl">Aprovar</div></div></div>) : <section className="panel"><div className="empty"><div className="ico">✓</div><h4>Nenhum PR aguardando revisão</h4><p>Quando um agente entregar trabalho, ele aparecerá aqui.</p></div></section>}</div>; }

function Projects({ data, onRegisterProject }: { data: DashboardData; onRegisterProject?: () => void }) { return <div className="view active"><PageTop eyebrow={translate("Workspace")} title={translate("Projects")} action={<button className="btn-ghost" onClick={onRegisterProject}>+ {translate("Register project")}</button>} /><div className="panel-head"><div><div className="lbl">{translate("Diagnostics")}</div><h3>{translate("Registered project health")}</h3></div><div className="count">{data.projects.length} {translate("repositories")}</div></div><div className="proj-grid">{data.projects.map(p => <div className="proj-status" key={p.key}><span className="tag ok">{translate("ready")}</span><b>@{p.key}</b><p>{translate("Execution environment ready.")}</p></div>)}</div><div className="panel-head" style={{ marginTop: 30 }}><div><div className="lbl">{translate("Workspace")}</div><h3>{translate("Local projects")}</h3></div><div className="count">{data.projects.length} {translate("registered")}</div></div><div className="proj-grid">{data.projects.map(p => <div className="proj-card" key={p.key}><div className="head"><div className="ic">{p.key[0]?.toUpperCase()}</div><div><span>@{p.key}</span><b>{p.name}</b></div></div><div className="proj-stats"><div><b>{data.tasks.filter(t => t.projectKey === p.key && !["done", "failed", "cancelled"].includes(t.status)).length}</b><span>{translate("active")}</span></div><div><b>{data.tasks.filter(t => t.projectKey === p.key).length}</b><span>{translate("total")}</span></div><div><b>main</b><span>{translate("branch")}</span></div></div><div className="proj-note">{translate("No agent working right now")}</div><div className="proj-foot">{translate("Protected local repository")}</div></div>)}</div></div>; }

function Providers({ data }: { data: DashboardData }) {
  const [policy, setPolicy] = useState<ProviderPolicySnapshot | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [connCommand, setConnCommand] = useState("");
  const [connArgs, setConnArgs] = useState("");
  const [connResult, setConnResult] = useState<ProviderConnectionResult | null>(null);
  const [connBusy, setConnBusy] = useState(false);
  async function testConn(event: FormEvent) {
    event.preventDefault();
    if (!connCommand.trim()) return;
    setConnBusy(true); setError(""); setConnResult(null);
    try {
      const result = await testProviderConnection({ command: connCommand.trim(), args: connArgs.split(/\s+/).filter(Boolean) });
      setConnResult(result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível testar a conexão.");
    } finally { setConnBusy(false); }
  }
  useEffect(() => { void fetchProviderPolicy().then(setPolicy).catch(cause => setError(cause instanceof Error ? cause.message : "Não foi possível carregar as políticas.")); }, []);
  const controls = policy?.controls ?? [];
  const providerAgents = data.agents.filter(agent => agent.id !== "telegram") as Array<DashboardData["agents"][number] & { id: AgentProviderId }>;
  async function changeControl(providerId: AgentProviderId, mode: ProviderMode, fallbackEnabled: boolean) { setBusy(providerId); setError(""); try { const control = await updateProviderControl(providerId, { mode, fallbackEnabled }); setPolicy(current => current ? { ...current, controls: current.controls.map(item => item.providerId === providerId ? control : item) } : current); } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível atualizar o provider."); } finally { setBusy(null); } }
  async function useOnly(providerId: AgentProviderId) { setBusy(providerId); setError(""); try { const next = controls.map(control => ({ providerId: control.providerId, mode: control.providerId === providerId ? "enabled" as const : "paused" as const, fallbackEnabled: control.providerId === providerId })); const updated = await updateProviderControls(next); setPolicy(current => current ? { ...current, controls: updated } : current); } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível aplicar o provider exclusivo."); } finally { setBusy(null); } }
  const capabilities: Array<[string, "planning" | "coding" | "testing" | "reviewing" | "conversation"]> = [["Planejamento", "planning"], ["Implementação", "coding"], ["Testes", "testing"], ["Review final", "reviewing"], ["Conversa", "conversation"]];
  async function changeRouting(capability: typeof capabilities[number][1], providerId: AgentProviderId) { const current = (policy?.capabilities ?? []).find(item => item.capability === capability); if (!current) return; setBusy(capability); try { const updated = await updateCapabilityRouting(capability, { order: [providerId, ...current.order.filter(item => item !== providerId)], requiredProviderId: current.requiredProviderId }); setPolicy(state => state ? { ...state, capabilities: state.capabilities.map(item => item.capability === capability ? updated : item) } : state); } finally { setBusy(null); } }
  async function changeRequired(capability: typeof capabilities[number][1], value: string) { const current = (policy?.capabilities ?? []).find(item => item.capability === capability); if (!current) return; setBusy(capability); setError(""); try { const updated = await updateCapabilityRouting(capability, { order: current.order, requiredProviderId: value === "fallback" ? null : value as AgentProviderId }); setPolicy(state => state ? { ...state, capabilities: state.capabilities.map(item => item.capability === capability ? updated : item) } : state); } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível atualizar a regra."); } finally { setBusy(null); } }
  return <div className="view active"><PageTop eyebrow="AI Routing" title="Providers" /><p className="desc">Conecte providers de nuvem, locais ou endpoints customizados e defina a prioridade por função.</p>{error ? <div className="action-error" role="alert">{error}</div> : null}<div className="prov-grid"><div><div className="prov-group-lbl">Conectados</div>{providerAgents.map(agent => { const control = controls.find(item => item.providerId === agent.id); const mode = control?.mode ?? "enabled"; const fallback = control?.fallbackEnabled ?? false; const toggle = () => void changeControl(agent.id, mode === "enabled" ? "paused" : "enabled", fallback); return <div className="prov-card" key={agent.id}><div className="head"><div className="av">{agent.label[0]}</div><div><b>{agent.label}</b><span><span className="st-dot" />{agentState(agent.state)}</span></div><span className="type-tag">cloud</span></div><div className="prov-uso"><div className="prov-uso-l"><div className={`toggle ${mode === "enabled" ? "on" : ""}`} role="switch" aria-label={`${mode === "enabled" ? "Pausar" : "Ativar"} ${agent.label}`} aria-checked={mode === "enabled"} tabIndex={0} onClick={toggle} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); toggle(); } }}><i /></div><label>{mode === "enabled" ? "ativo" : mode === "paused" ? "pausado" : "desativado"}</label></div><label className="provider-fallback"><input type="checkbox" checked={fallback} disabled={busy === agent.id} onChange={event => void changeControl(agent.id, mode, event.target.checked)} /> fallback</label><button className="btn-ghost provider-only" disabled={busy === agent.id} onClick={() => void useOnly(agent.id)}>usar somente este</button></div></div>; })}<button type="button" className="add-provider" onClick={() => setConnResult({ ok: false, detail: "", executable: null })}><div className="plus">+</div><b>Conectar provider</b><span>Local, OpenAI-compatible, ou endpoint próprio — digite o comando abaixo e teste a conexão</span></button>{connBusy || connResult ? <form className="provider-connect-form" onSubmit={testConn}><div className="field"><label>Comando do provider (CLI)</label><input value={connCommand} onChange={event => setConnCommand(event.target.value)} placeholder="Ex: opencode, claude, codex, ollama, node meu-provider.js" disabled={connBusy} /></div><div className="field"><label>Argumentos (ex: -m modelo) — opcional</label><input value={connArgs} onChange={event => setConnArgs(event.target.value)} placeholder="Ex: -m opencode/deepseek-v4-flash" disabled={connBusy} /></div><button className="btn-new" type="submit" disabled={connBusy || !connCommand.trim()}>{connBusy ? "Testando conexão..." : "Testar conexão"}</button>{connResult ? <div className={`conn-badge ${connResult.ok ? "ok" : "fail"}`}>{connResult.ok ? "✓ Conectado" : "✗ Falha na conexão"}<span>{connResult.detail}</span></div> : null}</form> : null}</div><section className="panel provider-routing"><PanelHead eyebrow="Control plane" title="Prioridade por função" meta="persistente" />{capabilities.map(([name, capability]) => { const route = (policy?.capabilities ?? []).find(item => item.capability === capability); const first = route?.order[0]; return <div className="routing-row" key={capability}><div className="rname">{name}</div><div><div className="field-lbl">Primeiro</div><select className="sel" value={first ?? ""} disabled={!route || busy === capability} onChange={event => void changeRouting(capability, event.target.value as AgentProviderId)}>{providerAgents.map(agent => <option value={agent.id} key={agent.id}>{agent.label}</option>)}</select></div><div><div className="field-lbl">Regra</div><select className="sel" value={route?.requiredProviderId ?? "fallback"} disabled={!route || busy === capability} onChange={event => void changeRequired(capability, event.target.value)}><option value="fallback">Fallback automático</option>{providerAgents.map(agent => <option value={agent.id} key={agent.id}>Somente {agent.label}</option>)}</select></div></div>; })}</section></div></div>;
}
function agentState(state: string) { return state === "working" ? "trabalhando" : state === "ready" ? "pronto" : state; }

function Analytics({ data }: { data: DashboardData }) {
  const [quota, setQuota] = useState<QuotaResult[] | null>(null);
  const [quotaError, setQuotaError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    const refreshQuota = async () => {
      if (cancelled || inFlight) return;
      inFlight = true;
      try {
        const results = await fetchQuota();
        if (!cancelled) {
          const stale = results.find((result) => result.stale);
          setQuotaError(stale ? `Exibindo a última leitura estável. Atualização: ${stale.error ?? "provider temporariamente indisponível"}.` : null);
          setQuota(results);
        }
      } catch (error) {
        if (!cancelled) {
          setQuota((current) => current ?? []);
          setQuotaError(error instanceof Error ? error.message : "Não foi possível atualizar as cotas.");
        }
      } finally {
        inFlight = false;
      }
    };
    void refreshQuota();
    const timer = window.setInterval(() => void refreshQuota(), 15_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);
  const tokenProviders = (data.costSummary?.byProvider ?? []).filter((provider) => provider.inputTokens + provider.outputTokens > 0);
  const totalTokens = tokenProviders.reduce((sum, provider) => sum + provider.inputTokens + provider.outputTokens, 0);
  const maxProviderTokens = Math.max(...tokenProviders.map((provider) => provider.inputTokens + provider.outputTokens), 1);
  const quotaBuckets = quota?.filter((result) => result.status === "ok").flatMap((result) => result.buckets) ?? [];
  const quotaStatus = quota?.filter((result) => result.status !== "ok" || result.buckets.length === 0) ?? [];

  return <div className="view active"><PageTop eyebrow="Métricas operacionais" title="Analytics & Consumo" /><svg width="0" height="0" style={{ position: "absolute" }}><defs><clipPath id="tentClip" clipPathUnits="objectBoundingBox"><path d="M0.02,0.5 C0.02,0.2 0.08,0.14 0.2,0.18 C0.45,0.22 0.7,0.32 0.9,0.43 C0.96,0.46 0.98,0.5 0.98,0.5 C0.98,0.5 0.96,0.54 0.9,0.57 C0.7,0.68 0.45,0.78 0.2,0.82 C0.08,0.86 0.02,0.8 0.02,0.5 Z" /></clipPath></defs></svg><div className="metrics" style={{ gridTemplateColumns: "repeat(3,1fr)" }}><Metric label="Tokens hoje" value={totalTokens} icon="⌁" /><Metric label="Taxa de conclusão" value={data.summary.completedTasks} icon="✓" /><Metric label="Work graphs executados" value={data.workGraphs?.length ?? 0} icon="⌘" /></div><div className="cols"><section className="chartbox"><PanelHead eyebrow="Consumo de tokens" title="Token Usage" meta={totalTokens ? `${totalTokens.toLocaleString()} tokens registrados hoje` : "sem leitura real do provider"} />{tokenProviders.length ? <><div className="bar-chart token-usage-chart">{tokenProviders.map((provider) => { const total = provider.inputTokens + provider.outputTokens; const height = Math.max(5, Math.round((total / maxProviderTokens) * 100)); const inputHeight = Math.round((provider.inputTokens / total) * 100); const color = QUOTA_ALIASES[provider.provider]?.color ?? "#c4622d"; return <div className="token-bar-column" key={provider.provider}><div className="token-bar-value">{total.toLocaleString()}</div><div className="token-bar-stack" style={{ height: `${height}%` }}><i className="token-bar-input" style={{ height: `${inputHeight}%`, background: color }} title={`${provider.provider}: ${provider.inputTokens.toLocaleString()} input`} /><i className="token-bar-output" style={{ height: `${100 - inputHeight}%`, background: color }} title={`${provider.provider}: ${provider.outputTokens.toLocaleString()} output`} /></div><span>{provider.provider}</span></div>; })}</div><div className="token-chart-legend"><span><i className="legend-input" /> input</span><span><i className="legend-output" /> output</span></div></> : <div className="empty token-empty"><div className="ico">◌</div><h4>Nenhum token medido hoje</h4><p>Os providers CLI conectados não retornaram contadores de input/output. O Maestro não estima nem inventa esses valores.</p></div>}</section><section className="chartbox" style={{ marginBottom: 0 }}><PanelHead eyebrow="Consumo disponível" title="Por provider" meta="% restante · próximo reset" />{quota === null ? <div className="empty"><div className="ico">…</div><h4>Carregando cotas…</h4></div> : <><div className="quota-refresh-warning">{quotaError ?? ""}</div>{quotaBuckets.length ? <QuotaGroups buckets={quotaBuckets} /> : <div className="empty"><div className="ico">◌</div><h4>Nenhuma leitura de cota disponível</h4><p>O provider pode estar conectado sem expor uma cota legível, ou a sessão local necessária pode estar inativa.</p></div>}{quotaStatus.map((result) => <div className="quota-status" key={result.provider}><b>{quotaLabel(result.provider)}</b><span>{quotaStatusMessage(result)}</span></div>)}</>}</section></div><section className="panel" style={{ marginTop: 20 }}><PanelHead eyebrow="Multi-agent" title="Work Graphs" meta={`${data.workGraphs?.length ?? 0} ativo(s)`} />{data.workGraphs?.length ? data.workGraphs.map(graph => <div className="work-graph-card" key={graph.id}><header><div><strong>{graph.objective}</strong><span>{graph.projectKey ?? "sem projeto"}</span></div><small>{graph.status}</small></header><p>{graph.artifactCount} artifacts · até {graph.maxParallelReaders} readers</p></div>) : <div className="empty"><div className="ico">⌘</div><h4>Nenhum Work Graph</h4><p>Tasks complexas aparecem aqui como DAGs governados.</p></div>}</section></div>;
}

// Provider display metadata (color + human label).
const QUOTA_ALIASES: Record<string, { label: string; color: string }> = {
  codex: { label: "Codex", color: "#7c634a" },
  antigravity: { label: "Gemini Antigravity", color: "#6f8f6a" },
  claude: { label: "Claude", color: "#c4622d" },
  "opencode-go": { label: "OpenCode Go", color: "#4d7a8c" },
  openrouter: { label: "OpenRouter", color: "#8a6dab" },
  openai: { label: "OpenAI", color: "#4d7a8c" },
  gemini: { label: "Gemini", color: "#6f8f6a" },
  "gemini-api": { label: "Gemini API", color: "#6f8f6a" },
  ollama: { label: "Ollama", color: "#5c6f8f" }
};

function quotaLabel(provider: string): string {
  return QUOTA_ALIASES[provider]?.label ?? provider;
}

// PT-BR copy per machine-readable reason. The server sends `reasonCode`;
// free-text `error` is only the fallback for older payloads.
const QUOTA_REASON_MESSAGES: Record<string, string> = {
  not_installed: "CLI não instalada neste computador — conecte o provider para ver a cota.",
  not_authenticated: "Provider instalado, mas sem login concluído.",
  session_down: "CLI autenticada, mas a sessão local do Antigravity não está ativa para consultar o RPC de cota.",
  transient_error: "Falha temporária ao consultar a cota. Tente atualizar novamente.",
  no_data: "Conexão validada; este provider não expõe uma fração de cota."
};

function quotaStatusMessage(result: QuotaResult): string {
  if (result.reasonCode && QUOTA_REASON_MESSAGES[result.reasonCode]) {
    return QUOTA_REASON_MESSAGES[result.reasonCode];
  }
  const detail = result.error ?? "sem leitura disponível";
  return detail;
}

// Renders all buckets grouped by provider with the tentacle-bar design.
function QuotaGroups({ buckets }: { buckets: QuotaBucket[] }) {
  const byProvider = new Map<string, QuotaBucket[]>();
  for (const b of buckets) {
    if (!byProvider.has(b.provider)) byProvider.set(b.provider, []);
    byProvider.get(b.provider)!.push(b);
  }
  return <>{Array.from(byProvider.entries()).map(([provider, bs]) => {
    const meta = QUOTA_ALIASES[provider] ?? { label: provider, color: "#8a7c68" };
    return (
      <div className="quota-group" key={provider} style={byProvider.size > 1 ? undefined : undefined}>
        <div className="quota-provider-head"><span className="epic-dot" style={{ background: meta.color }} /><b>{meta.label}</b></div>
        {bs.length === 0
          ? <div className="quota-row"><span className="quota-window">local</span><span className="quota-nolimit">sem limite · roda na sua máquina</span></div>
          : bs.map((b, i) => <QuotaBar bucket={b} color={meta.color} key={provider + i} />
          )}
      </div>
    );
  })}</>;
}

const WINDOW_LABELS: Record<string, string> = {
  "gemini-weekly": "gemini · semanal",
  "gemini-5h": "gemini · 5h",
  "claude_gpt-weekly": "claude (gpt) · semanal",
  "claude_gpt-5h": "claude (gpt) · 5h",
  "claude-weekly": "semanal",
  "claude-5h": "5h",
  "opencode-rolling": "janela rolante",
  "opencode-weekly": "semanal",
  "opencode-monthly": "mensal",
  weekly: "semanal",
  "5h": "5h"
};

function QuotaBar({ bucket, color }: { bucket: QuotaBucket; color: string }) {
  const remaining = bucket.remainingPercent;
  const pct = remaining == null ? 0 : Math.max(0, Math.min(100, remaining));
  const pctClass = pct <= 10 ? "err" : pct <= 40 ? "warn" : "ok";
  const reset = bucket.resetsAt ? `reset ${resetLabel(bucket.resetsAt)}` : "—";
  const windowLabel = WINDOW_LABELS[bucket.modelId ?? ""] ?? bucket.modelId ?? "padrão";
  return (
    <div className="quota-row">
      <span className="quota-window">{windowLabel}</span>
      <svg className="tentacle-bar" viewBox="0 0 100 14" preserveAspectRatio="none">
        <path d="M2,7 C2,2.8 8,2 20,2.5 C45,3 70,4.5 90,6 C95,6.5 98,7 98,7 C98,7 95,7.5 90,8 C70,9.5 45,11 20,11.5 C8,12 2,11.2 2,7 Z" fill="#2a2219" />
        <rect x="0" y="0" width={pct} height="14" fill={color} clipPath="url(#tentClip)" />
      </svg>
      <span className={`quota-pct ${pctClass}`}>{remaining == null ? "n/d" : `${remaining}%`}</span>
      <span className="quota-reset">{reset}</span>
    </div>
  );
}
function resetLabel(iso: string): string {
  const diffMs = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(diffMs)) return "";
  const mins = Math.max(0, Math.round(diffMs / 60000));
  return mins >= 60 ? `${Math.round(mins / 60)}h` : `${mins}min`;
}
function Settings({ data }: { data: DashboardData }) {
  const [botToken, setBotToken] = useState("");
  const [allowedUserId, setAllowedUserId] = useState("");
  const [telegramStatus, setTelegramStatus] = useState("");
  const [labTitle, setLabTitle] = useState("");
  const [labRationale, setLabRationale] = useState("");
  const [labItems, setLabItems] = useState(data.improvements);
  async function saveTelegram(event: FormEvent) { event.preventDefault(); try { const result = await connectTelegram({ botToken, allowedUserId: allowedUserId || undefined }); setTelegramStatus(`Conectado como @${result.botInfo?.username ?? "bot"}`); setBotToken(""); } catch (error) { setTelegramStatus(error instanceof Error ? error.message : "Falha ao conectar."); } }
  async function addProposal(event: FormEvent) { event.preventDefault(); if (!labTitle.trim()) return; const proposal = await createImprovement({ category: "policy", title: labTitle, rationale: labRationale, proposedChange: labTitle, evidence: ["Proposta criada pelo dashboard"], risk: "medium" }); setLabItems(items => [proposal, ...items]); setLabTitle(""); setLabRationale(""); }
  async function decide(id: number, status: "approved" | "rejected") { const updated = await decideImprovement(id, status, `Decision from Maestro dashboard`); setLabItems(items => items.map(item => item.id === id ? updated : item)); }
  return <div className="view active"><PageTop eyebrow={translate("Settings")} title={translate("System")} /><div className="cfg-block"><PanelHead eyebrow={translate("Language preference")} title={translate("Language")} meta={translate("English")} /><LanguageSelector /></div><div className="cfg-block"><PanelHead eyebrow={translate("Telegram integration")} title={translate("Telegram bot connection")} meta={translate("configurable bot")} /><div className="cfg-status"><span className="d" /> {telegramStatus || translate("Configure the bot and restrict access to your user")}</div><form onSubmit={saveTelegram}><div className="field"><label>HTTP API Bot Token (@BotFather)</label><input value={botToken} onChange={event => setBotToken(event.target.value)} placeholder="Example: 123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ" type="password" required /></div><div className="field"><label>Telegram User ID (@userinfobot) — optional</label><input value={allowedUserId} onChange={event => setAllowedUserId(event.target.value)} placeholder={translate("Example: 987654321 (leave blank for open access)")} inputMode="numeric" /></div><button className="btn-new" type="submit">{translate("Update bot token")}</button></form></div><div className="cfg-block"><PanelHead eyebrow={translate("Autonomy")} title={translate("Autopilot settings")} meta={`${translate("state")}: ${data.autopilot.state}`} /><div className="toggle-panel"><div className="tp"><div className="k">{translate("Autopilot status")}</div><div className="v"><span className="d" />{data.autopilot.enabled ? translate("Enabled") : translate("Disabled")}</div><p>{translate("Maestro automatically selects and advances eligible tasks from the queue.")}</p></div><div className="tp"><div className="k">{translate("Daemon access mode")}</div><div className="v"><span className="d" />{data.daemon.access === "restricted" ? translate("Restricted access (local sandbox)") : translate("Full access")}</div><p>{translate("Worktrees isolate script execution and prevent mutations without confirmation.")}</p></div></div></div><div className="cfg-block"><PanelHead eyebrow={translate("Safe evolution")} title={translate("Learning lab")} meta={`${labItems.filter(item => item.status === "candidate").length} ${translate("awaiting decision")}`} /><form className="improvement-form" onSubmit={addProposal}><strong>{translate("New governed proposal")}</strong><p>{translate("Proposals wait for a decision before any persistent mutation.")}</p><input value={labTitle} onChange={event => setLabTitle(event.target.value)} placeholder={translate("Proposal title")} /><textarea value={labRationale} onChange={event => setLabRationale(event.target.value)} placeholder={translate("Evidence and rationale")} /><button type="submit">{translate("Record proposal")}</button></form><div className="improvement-queue">{labItems.map(item => <article className="improvement-card" key={item.id}><header><span>{item.category}</span><span>{item.status}</span></header><strong>{item.title}</strong><p>{item.rationale}</p>{item.status === "candidate" && <div className="improvement-actions"><button onClick={() => void decide(item.id, "rejected")}>{translate("Reject")}</button><button onClick={() => void decide(item.id, "approved")}>{translate("Approve")}</button></div>}</article>)}</div></div></div>;
}

export function MaestroV2({ data, onRefresh, onCreate, onRegisterProject, refreshing }: { data: DashboardData; onRefresh: () => void | Promise<void>; onCreate: () => void; onRegisterProject?: () => void; refreshing: boolean }) {
  const location = useLocation();
  // Refetch fresh data whenever the user navigates between views (and on first
  // mount) so a screen never renders against stale data (the periodic poll is a
  // safety net; this makes navigation feel immediate instead of showing the last
  // polled snapshot).
  useEffect(() => {
    onRefresh();
  }, [location.pathname, onRefresh]);
  const pending = data.features.filter(f => ["reviewing", "waiting_checks", "changes_requested"].includes(f.status)).length;
  const page = location.pathname;
  const taskLogsMatch = location.pathname.match(/^\/tasks\/(\d+)\/logs\/?$/);

  return (
    <div className="app">
      <AppSidebar pending={pending} />
      <main>
        <div className="inner">
          {taskLogsMatch ? (
            <TaskLogViewerPage taskIdParam={taskLogsMatch[1]} onBack={() => window.history.back()} />
          ) : page === "/chat" ? (
            <div className="view active"><OperationalChatConsole projects={data.projects} onChanged={() => { void onRefresh(); }} /></div>
          ) : page === "/backlog" ? (
            <FlowFiltered data={data} onCreate={onCreate} />
          ) : page === "/reviews" ? (
            <ReviewPage data={data} onRefresh={async () => { await onRefresh(); }} />
          ) : page === "/projects" ? (
            <Projects data={data} onRegisterProject={onRegisterProject} />
          ) : page === "/providers" ? (
            <ProvidersPage data={data} onRefresh={onRefresh} />
          ) : page === "/analytics" ? (
            <AnalyticsPage data={data} onRefresh={async () => { await onRefresh(); }} />
          ) : page === "/settings" ? (
            <SettingsPage data={data} onRefresh={async () => { await onRefresh(); }} />
          ) : (
            <Overview data={data} onCreate={onCreate} onRefresh={onRefresh} refreshing={refreshing} />
          )}
        </div>
      </main>
    </div>
  );
}
