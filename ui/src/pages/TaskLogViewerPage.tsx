import React, { useEffect, useMemo, useState, useCallback } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  fetchTaskLogs,
  TaskLogs,
  TaskLogRun,
  TaskLogStep,
  prepareTask,
  startTaskGoal
} from "../api";
import { OctoMark } from "../components/OctoMark";
import { Icon } from "../components/Icon";
import { formatRelative, taskStatusLabels } from "../helpers";

export interface TaskLogViewerPageProps {
  taskIdParam?: number | string;
  onBack?: () => void;
}

type TabType = "stream" | "terminal" | "tools" | "files" | "events" | "reviews";

export function TaskLogViewerPage({ taskIdParam, onBack }: TaskLogViewerPageProps) {
  const params = useParams<{ taskId?: string }>();
  const navigate = useNavigate();
  const rawId = taskIdParam ?? params.taskId;
  const taskId = Number(rawId);

  const [logs, setLogs] = useState<TaskLogs | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [activeTab, setActiveTab] = useState<TabType>("stream");
  const [selectedRunId, setSelectedRunId] = useState<number | "all">("all");
  const [phaseFilter, setPhaseFilter] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [copied, setCopied] = useState(false);
  const [wrapLines, setWrapLines] = useState(true);
  const [actionBusy, setActionBusy] = useState(false);

  const loadLogs = useCallback(async (silent = false) => {
    if (!Number.isInteger(taskId) || taskId <= 0) {
      setError("ID de task inválido.");
      setLoading(false);
      return;
    }
    if (!silent) setRefreshing(true);
    try {
      const data = await fetchTaskLogs(taskId);
      setLogs(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao carregar logs da task.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [taskId]);

  useEffect(() => {
    void loadLogs(false);
  }, [loadLogs]);

  // Polling when active
  useEffect(() => {
    if (!autoRefresh) return;
    const isRunning = logs?.telemetry.isRunning ?? false;
    if (!isRunning && logs !== null) return;

    const interval = setInterval(() => {
      void loadLogs(true);
    }, 2500);
    return () => clearInterval(interval);
  }, [autoRefresh, logs?.telemetry.isRunning, logs, loadLogs]);

  const selectedRun = useMemo(() => {
    if (!logs || selectedRunId === "all") return null;
    return logs.runs.find((r) => r.id === selectedRunId) ?? null;
  }, [logs, selectedRunId]);

  const activeRuns = useMemo(() => {
    if (!logs) return [];
    if (selectedRunId === "all") return logs.runs;
    return logs.runs.filter((r) => r.id === selectedRunId);
  }, [logs, selectedRunId]);

  const allSteps = useMemo(() => {
    return activeRuns.flatMap((r) => r.steps);
  }, [activeRuns]);

  const filteredSteps = useMemo(() => {
    return allSteps.filter((step) => {
      if (phaseFilter !== "all" && step.phase !== phaseFilter) return false;
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const matchesSummary = step.summary.toLowerCase().includes(q);
        const matchesOutput = step.output.toLowerCase().includes(q);
        const matchesProvider = step.provider.toLowerCase().includes(q);
        const matchesPhase = step.phase.toLowerCase().includes(q);
        const matchesError = (step.error ?? "").toLowerCase().includes(q);
        return matchesSummary || matchesOutput || matchesProvider || matchesPhase || matchesError;
      }
      return true;
    });
  }, [allSteps, phaseFilter, searchQuery]);

  const extractedTools = useMemo(() => {
    const tools: Array<{
      stepId: number;
      phase: string;
      provider: string;
      toolName: string;
      command?: string;
      details?: string;
      status: "ok" | "err" | "info";
      time: string;
    }> = [];

    for (const run of activeRuns) {
      for (const cp of run.checkpoints) {
        if (Array.isArray(cp.testsRun)) {
          for (const test of cp.testsRun) {
            tools.push({
              stepId: cp.stepId,
              phase: cp.phase,
              provider: cp.provider,
              toolName: "test_execution",
              command: test.command,
              details: test.result,
              status: test.result.includes("FAIL") || test.result.includes("failed") ? "err" : "ok",
              time: cp.createdAt
            });
          }
        }
      }
      for (const step of run.steps) {
        const text = step.output;
        const toolRegex = /(?:call:default_api:([a-z_]+)\{([^}]+)\}|`([^`]+)`|(?:run_command|spawn|exec):\s*([^\n\r]+))/gi;
        let match: RegExpExecArray | null;
        while ((match = toolRegex.exec(text)) !== null) {
          const name = match[1] || (match[4] ? "run_command" : "command");
          const details = match[2] || match[3] || match[4] || "";
          if (details.trim().length > 3) {
            tools.push({
              stepId: step.id,
              phase: step.phase,
              provider: step.provider,
              toolName: name,
              command: details.slice(0, 300),
              status: step.status === "failed" ? "err" : "ok",
              time: step.createdAt
            });
          }
        }
      }
    }
    return tools;
  }, [activeRuns]);

  const filteredTools = useMemo(() => {
    if (phaseFilter === "all") return extractedTools;
    return extractedTools.filter((tool) => tool.phase === phaseFilter);
  }, [extractedTools, phaseFilter]);

  const allCheckpoints = useMemo(() => {
    return activeRuns.flatMap((r) => r.checkpoints);
  }, [activeRuns]);

  const changedFiles = useMemo(() => {
    const set = new Set<string>();
    for (const cp of allCheckpoints) {
      if (Array.isArray(cp.changedFiles)) {
        for (const f of cp.changedFiles) {
          if (f && typeof f === "string") set.add(f);
        }
      }
    }
    if (logs?.telemetry.changedFiles) {
      for (const f of logs.telemetry.changedFiles) {
        if (f) set.add(f);
      }
    }
    return Array.from(set);
  }, [allCheckpoints, logs]);

  const copyAllLogs = () => {
    if (!logs) return;
    const exportData = {
      task: logs.task,
      telemetry: logs.telemetry,
      runs: logs.runs.map((r) => ({
        id: r.id,
        status: r.status,
        currentPhase: r.currentPhase,
        steps: r.steps.map((s) => ({
          phase: s.phase,
          provider: s.provider,
          status: s.status,
          summary: s.summary,
          output: s.output,
          error: s.error,
          durationMs: s.durationMs,
          tokenUsage: s.tokenUsage
        })),
        checkpoints: r.checkpoints,
        tokenUsage: r.tokenUsage
      })),
      events: logs.events,
      reviews: logs.reviews
    };
    navigator.clipboard.writeText(JSON.stringify(exportData, null, 2)).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const handlePrepare = async () => {
    if (!logs) return;
    setActionBusy(true);
    try {
      await prepareTask(logs.task.id);
      await loadLogs(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao preparar worktree.");
    } finally {
      setActionBusy(false);
    }
  };

  const handleStartGoal = async () => {
    if (!logs) return;
    setActionBusy(true);
    try {
      await startTaskGoal(logs.task.id);
      await loadLogs(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao iniciar goal.");
    } finally {
      setActionBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="task-log-page">
        <div className="task-log-loading" role="status" aria-live="polite">
          <OctoMark large />
          <div className="task-log-loading-text">
            <b>Sincronizando task #{taskId}</b>
            <span>Buscando telemetria e eventos locais…</span>
          </div>
          <div className="task-log-loading-rail" aria-hidden="true"><i /></div>
        </div>
      </div>
    );
  }

  if (error && !logs) {
    return (
      <div className="task-log-page">
        <div className="task-log-top-nav">
          <button type="button" className="btn-ghost" onClick={() => onBack ? onBack() : navigate(-1)}>
            ← Voltar
          </button>
        </div>
        <div className="task-log-error-card">
          <OctoMark />
          <h3>Não foi possível carregar os logs</h3>
          <p>{error}</p>
          <button type="button" className="btn-new" onClick={() => void loadLogs(false)}>
            Tentar novamente
          </button>
        </div>
      </div>
    );
  }

  if (!logs) return null;

  const { task, telemetry, runs, events, reviews } = logs;
  const isRunning = runs.length > 0 && telemetry.isRunning;
  const activeRun = runs.find((r) => r.id === telemetry.activeRunId) ?? runs[runs.length - 1] ?? null;

  return (
    <div className="task-log-page view active">
      {/* Header bar with Octomynd mascot and live telemetry indicator */}
      <header className="task-log-header">
        <div className="task-log-header-left">
          <button
            type="button"
            className="task-log-back-btn"
            title="Voltar ao fluxo de tasks"
            onClick={() => onBack ? onBack() : navigate("/backlog")}
          >
            ← Voltar
          </button>
          <div className="task-log-brand-badge">
            <OctoMark />
            <div className="task-log-brand-text">
              <span className="task-log-tag">Task Log Viewer</span>
              <span className="task-log-sub">Octomynd Neon Control Room</span>
            </div>
          </div>
        </div>

        <div className="task-log-header-right">
          <div className={`live-pulse-badge ${isRunning ? "is-live" : "is-persisted"}`}>
            <span className="live-dot" />
            <span>{isRunning ? "AO VIVO" : "PERSISTIDO"}</span>
          </div>
          <button
            type="button"
            className={`btn-ghost btn-sm ${autoRefresh ? "active" : ""}`}
            title={autoRefresh ? "Pausar atualização automática" : "Ativar atualização automática"}
            onClick={() => setAutoRefresh(!autoRefresh)}
          >
            {autoRefresh ? "Auto-sync ON" : "Auto-sync OFF"}
          </button>
          <button
            type="button"
            className="icon-btn"
            title="Recarregar logs agora"
            onClick={() => void loadLogs(false)}
            disabled={refreshing}
          >
            {refreshing ? "…" : "↻"}
          </button>
          <button
            type="button"
            className="btn-ghost btn-sm"
            onClick={copyAllLogs}
            title="Copiar JSON com todo o histórico de logs"
          >
            {copied ? "✓ Copiado!" : "Copiar Logs"}
          </button>
          {activeRun?.pullRequestUrl && (
            <a
              href={activeRun.pullRequestUrl}
              target="_blank"
              rel="noreferrer"
              className="btn-new btn-sm"
              title="Ver Pull Request associado a esta task"
            >
              Abrir PR ↗
            </a>
          )}
        </div>
      </header>

      {/* Task Identification Hero Card */}
      <section className="task-log-hero panel">
        <div className="task-log-title-row">
          <div className="task-log-id-pill">#{String(task.id).padStart(2, "0")}</div>
          <span className={`st st-${task.status}`}>
            {taskStatusLabels[task.status] ?? task.status}
          </span>
          <span className="task-log-project-pill">@{task.projectKey ?? "inbox"}</span>
          {task.branchName && (
            <span className="task-log-branch-pill">
              <Icon name="code" /> {task.branchName}
            </span>
          )}
        </div>
        <h2 className="task-log-heading">{task.text}</h2>
        <div className="task-log-meta-strip">
          <span>Criada {formatRelative(task.createdAt)}</span>
          <span>·</span>
          <span>Origem: <b>{task.source}</b></span>
          {task.worktreePrepared && <span>· Worktree isolada</span>}
          {runs.length > 0 && <span>· <b>{runs.length}</b> ciclo(s) de goal</span>}
        </div>
      </section>

      {/* Phase Progression Stepper */}
      <section className="task-log-stepper panel">
        <div className="stepper-track">
          <StepperItem
            step="01"
            label="Capturada"
            state="done"
          />
          <StepperItem
            step="02"
            label="Worktree"
            state={task.worktreePrepared ? "done" : task.status === "queued" ? "current" : "pending"}
          />
          <StepperItem
            step="03"
            label="Planejamento"
            state={
              task.status === "planning"
                ? "current"
                : ["implementing", "testing", "reviewing", "done", "ready_to_merge", "awaiting_human"].includes(task.status)
                ? "done"
                : "pending"
            }
          />
          <StepperItem
            step="04"
            label="Implementação"
            state={
              task.status === "implementing"
                ? "current"
                : ["testing", "reviewing", "done", "ready_to_merge", "awaiting_human"].includes(task.status)
                ? "done"
                : "pending"
            }
          />
          <StepperItem
            step="05"
            label="Validação / Testes"
            state={
              task.status === "testing"
                ? "current"
                : ["reviewing", "done", "ready_to_merge", "awaiting_human"].includes(task.status)
                ? "done"
                : "pending"
            }
          />
          <StepperItem
            step="06"
            label="Revisão & Entrega"
            state={
              ["reviewing", "awaiting_human"].includes(task.status)
                ? "current"
                : ["done", "ready_to_merge"].includes(task.status)
                ? "done"
                : task.status === "failed"
                ? "error"
                : "pending"
            }
          />
        </div>
      </section>

      {/* Key Telemetry Metrics Cards */}
      <section className="task-log-metrics">
        <div className="metric-card-v2">
          <div className="metric-icon-v2">✧</div>
          <div className="metric-k">Provedor Ativo</div>
          <div className="metric-v-v2">{activeRun?.lastProvider ?? (runs.length > 0 ? "Multi-provider" : "Nenhum")}</div>
          <span className="metric-sub">{activeRun ? `Fase: ${activeRun.currentPhase}` : "Aguardando disparo"}</span>
        </div>

        <div className="metric-card-v2">
          <div className="metric-icon-v2">⌁</div>
          <div className="metric-k">Etapas de Execução</div>
          <div className="metric-v-v2">{telemetry.totalSteps}</div>
          <span className="metric-sub">{runs.length} run(s) de goal</span>
        </div>

        <div className="metric-card-v2">
          <div className="metric-icon-v2">⏱</div>
          <div className="metric-k">Tempo de Execução</div>
          <div className="metric-v-v2">{formatDuration(telemetry.totalDurationMs)}</div>
          <span className="metric-sub">{telemetry.totalDurationMs > 0 ? "auditado por etapa" : "tempo estimado"}</span>
        </div>

        <div className="metric-card-v2">
          <div className="metric-icon-v2">$</div>
          <div className="metric-k">Consumo & Tokens</div>
          <div className="metric-v-v2">${telemetry.totalCostUsd.toFixed(4)}</div>
          <span className="metric-sub">{(telemetry.totalInputTokens + telemetry.totalOutputTokens).toLocaleString()} tokens</span>
        </div>

        <div className="metric-card-v2">
          <div className="metric-icon-v2">📁</div>
          <div className="metric-k">Arquivos Alterados</div>
          <div className="metric-v-v2">{changedFiles.length}</div>
          <span className="metric-sub">{changedFiles.length > 0 ? "verificados em checkpoint" : "sem modificações"}</span>
        </div>
      </section>

      {/* Runs Selector (if multiple goal runs exist) */}
      {runs.length > 1 && (
        <section className="task-log-run-selector">
          <span className="run-selector-label">Ciclos de Execução (Goal Runs):</span>
          <div className="run-selector-tabs">
            <button
              type="button"
              className={`run-tab ${selectedRunId === "all" ? "active" : ""}`}
              onClick={() => setSelectedRunId("all")}
            >
              Todos os ciclos ({runs.length})
            </button>
            {runs.map((r) => (
              <button
                type="button"
                key={r.id}
                className={`run-tab ${selectedRunId === r.id ? "active" : ""}`}
                onClick={() => setSelectedRunId(r.id)}
              >
                Run #{r.id} ({r.currentPhase}) {r.id === activeRun?.id ? "● Atual" : ""}
              </button>
            ))}
          </div>
        </section>
      )}

      {/* Main Inspection Tabs */}
      <div className="task-log-nav-tabs">
        <button
          type="button"
          className={`tab-btn ${activeTab === "stream" ? "active" : ""}`}
          onClick={() => setActiveTab("stream")}
        >
          <Icon name="pulse" />
          <span>Linha do Tempo ({allSteps.length})</span>
        </button>
        <button
          type="button"
          className={`tab-btn ${activeTab === "terminal" ? "active" : ""}`}
          onClick={() => setActiveTab("terminal")}
        >
          <Icon name="code" />
          <span>Saída dos Agentes / Terminal</span>
        </button>
        <button
          type="button"
          className={`tab-btn ${activeTab === "tools" ? "active" : ""}`}
          onClick={() => setActiveTab("tools")}
        >
          <Icon name="spark" />
          <span>Tool Calls & Comandos ({filteredTools.length})</span>
        </button>
        <button
          type="button"
          className={`tab-btn ${activeTab === "files" ? "active" : ""}`}
          onClick={() => setActiveTab("files")}
        >
          <Icon name="folder" />
          <span>Arquivos Alterados ({changedFiles.length})</span>
        </button>
        <button
          type="button"
          className={`tab-btn ${activeTab === "events" ? "active" : ""}`}
          onClick={() => setActiveTab("events")}
        >
          <Icon name="timeline" />
          <span>Eventos do Sistema ({events.length})</span>
        </button>
        <button
          type="button"
          className={`tab-btn ${activeTab === "reviews" ? "active" : ""}`}
          onClick={() => setActiveTab("reviews")}
        >
          <Icon name="hand" />
          <span>Revisões ({reviews.length})</span>
        </button>
      </div>

      {/* Filter and Search Bar */}
      <div className="task-log-filter-bar">
        <div className="task-log-search-input">
          <span className="search-icon">🔍</span>
          <input
            type="text"
            placeholder="Filtrar logs, saídas de agente, comandos ou erros..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
          {searchQuery && (
            <button type="button" className="search-clear" onClick={() => setSearchQuery("")}>
              ✕
            </button>
          )}
        </div>

        {(activeTab === "stream" || activeTab === "terminal" || activeTab === "tools") && (
          <div className="task-log-phase-filters">
            {["all", "planning", "implementing", "testing", "reviewing"].map((phase) => (
              <button
                key={phase}
                type="button"
                className={`phase-chip ${phaseFilter === phase ? "active" : ""}`}
                onClick={() => setPhaseFilter(phase)}
              >
                {phase === "all" ? "Todas as fases" : phase}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Tab 1: Execution Stream */}
      {activeTab === "stream" && (
        <section className="task-log-stream-section">
          {runs.length === 0 ? (
            <div className="panel empty-log-card">
              <OctoMark />
              <h3>Nenhuma execução iniciada ainda</h3>
              <p>
                Esta task está no estado <b>{taskStatusLabels[task.status] ?? task.status}</b>.
                {!task.worktreePrepared
                  ? " O primeiro passo é preparar a worktree isolada."
                  : " A worktree está pronta. Você pode iniciar a Goal autônoma."}
              </p>
              <div className="empty-log-actions">
                {!task.worktreePrepared && (
                  <button type="button" className="btn-new" onClick={handlePrepare} disabled={actionBusy}>
                    {actionBusy ? "Preparando..." : "Preparar Worktree"}
                  </button>
                )}
                {task.worktreePrepared && (
                  <button type="button" className="btn-new" onClick={handleStartGoal} disabled={actionBusy}>
                    {actionBusy ? "Iniciando..." : "Iniciar Goal Autônoma"}
                  </button>
                )}
              </div>
            </div>
          ) : filteredSteps.length === 0 ? (
            <div className="panel empty-search">
              <p>Nenhuma etapa corresponde aos filtros selecionados.</p>
            </div>
          ) : (
            <div className="task-steps-timeline">
              {filteredSteps.map((step, idx) => (
                <StepAccordionCard key={step.id} step={step} index={idx + 1} />
              ))}
            </div>
          )}
        </section>
      )}

      {/* Tab 2: Terminal / Raw Output */}
      {activeTab === "terminal" && (
        <section className="task-log-terminal-section panel">
          <div className="terminal-header">
            <div className="terminal-dots">
              <span className="dot red" />
              <span className="dot yellow" />
              <span className="dot green" />
              <span className="terminal-title">maestro-agent-stream // task #{task.id}</span>
            </div>
            <div className="terminal-actions">
              <label className="terminal-toggle">
                <input
                  type="checkbox"
                  checked={wrapLines}
                  onChange={(e) => setWrapLines(e.target.checked)}
                />
                Quebra de linha
              </label>
              <button
                type="button"
                className="btn-ghost btn-sm"
                onClick={() => {
                  const text = filteredSteps.map((s) => `=== [${s.phase.toUpperCase()}] ${s.provider} (status: ${s.status}) ===\nSummary: ${s.summary}\n\nOutput:\n${s.output}\n${s.error ? `\nError: ${s.error}` : ""}`).join("\n\n----------------------------------------\n\n");
                  navigator.clipboard.writeText(text);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                }}
              >
                {copied ? "✓ Copiado" : "Copiar Saída"}
              </button>
            </div>
          </div>

          <div className={`terminal-body ${wrapLines ? "wrap-lines" : "no-wrap"}`}>
            {filteredSteps.length === 0 ? (
              <div className="terminal-empty">Nenhum output registrado para os filtros atuais.</div>
            ) : (
              filteredSteps.map((step) => (
                <div className="terminal-step-block" key={step.id}>
                  <div className="terminal-step-banner">
                    <span className="t-banner-phase">[{step.phase}]</span>
                    <span className="t-banner-provider">{step.provider}</span>
                    <span className={`t-banner-status status-${step.status}`}>{step.status}</span>
                    <span className="t-banner-time">{new Date(step.createdAt).toLocaleTimeString("pt-BR")}</span>
                  </div>
                  <div className="terminal-step-summary">&gt; {step.summary}</div>
                  {step.output && (
                    <pre className="terminal-code-content">{step.output}</pre>
                  )}
                  {step.error && (
                    <pre className="terminal-error-content">{step.error}</pre>
                  )}
                </div>
              ))
            )}
          </div>
        </section>
      )}

      {/* Tab 3: Tool Calls & Commands */}
      {activeTab === "tools" && (
        <section className="task-log-tools-section panel">
          <div className="panel-head">
            <div>
              <div className="lbl">Execução de Ferramentas</div>
              <h3>Tool Calls & Comandos Executados</h3>
            </div>
            <div className="count">{filteredTools.length} chamadas capturadas</div>
          </div>

          {filteredTools.length === 0 ? (
            <div className="empty compact">
              <p>
                {extractedTools.length === 0
                  ? "Nenhuma chamada de ferramenta explícita registrada nesta task."
                  : "Nenhuma chamada de ferramenta corresponde à fase selecionada."}
              </p>
            </div>
          ) : (
            <div className="tools-grid">
              {filteredTools.map((tool, i) => (
                <div className={`tool-card tool-${tool.status}`} key={`${tool.stepId}-${i}`}>
                  <div className="tool-card-head">
                    <span className="tool-name">⚡ {tool.toolName}</span>
                    <span className="tool-phase">{tool.phase}</span>
                    <span className="tool-provider">{tool.provider}</span>
                    <span className="tool-time">{formatRelative(tool.time)}</span>
                  </div>
                  {tool.command && (
                    <pre className="tool-command">{tool.command}</pre>
                  )}
                  {tool.details && (
                    <div className="tool-details">
                      <span className="tool-details-lbl">Resultado:</span>
                      <pre className="tool-details-content">{tool.details}</pre>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {/* Tab 4: Changed Files & Checkpoints */}
      {activeTab === "files" && (
        <section className="task-log-files-section panel">
          <div className="panel-head">
            <div>
              <div className="lbl">Worktree Audit</div>
              <h3>Arquivos Alterados & Checkpoints</h3>
            </div>
            <div className="count">{changedFiles.length} arquivos</div>
          </div>

          {changedFiles.length === 0 ? (
            <div className="empty compact">
              <p>Nenhum arquivo alterado foi detectado nos checkpoints desta task.</p>
            </div>
          ) : (
            <div className="files-list">
              {changedFiles.map((file, i) => (
                <div className="file-item" key={file}>
                  <span className="file-idx">#{i + 1}</span>
                  <span className="file-icon">📄</span>
                  <span className="file-path">{file}</span>
                  <span className="file-status-tag">modificado</span>
                </div>
              ))}
            </div>
          )}

          {allCheckpoints.length > 0 && (
            <>
              <div className="divider" style={{ margin: "24px 0" }} />
              <div className="panel-head">
                <div>
                  <div className="lbl">Snapshots de Worktree</div>
                  <h3>Checkpoints Salvos</h3>
                </div>
                <div className="count">{allCheckpoints.length} checkpoints</div>
              </div>
              <div className="checkpoints-timeline">
                {allCheckpoints.map((cp) => (
                  <div className="checkpoint-card" key={cp.id}>
                    <div className="cp-head">
                      <b>Checkpoint #{cp.id}</b>
                      <span className="cp-phase">{cp.phase}</span>
                      <span className="cp-status">{cp.status}</span>
                      <span className="cp-time">{formatRelative(cp.createdAt)}</span>
                    </div>
                    <p className="cp-summary">{cp.summary}</p>
                    {cp.changedFiles && cp.changedFiles.length > 0 && (
                      <div className="cp-files-chip-row">
                        {cp.changedFiles.map((f) => (
                          <span className="cp-file-chip" key={f}>
                            {f}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
        </section>
      )}

      {/* Tab 5: Database Events */}
      {activeTab === "events" && (
        <section className="task-log-events-section panel">
          <div className="panel-head">
            <div>
              <div className="lbl">Auditoria Completa</div>
              <h3>Eventos do Sistema (Audit Log)</h3>
            </div>
            <div className="count">{events.length} eventos</div>
          </div>

          {events.length === 0 ? (
            <div className="empty compact">
              <p>Nenhum evento registrado especificamente para esta task.</p>
            </div>
          ) : (
            <div className="events-stream">
              {events.map((event) => (
                <div className="event-row-card" key={event.id}>
                  <div className="event-dot" />
                  <div className="event-body">
                    <div className="event-header-row">
                      <b className="event-text">{event.text}</b>
                      <span className="event-time">{formatRelative(event.createdAt)}</span>
                    </div>
                    <div className="event-tags">
                      <span className="event-source">{event.source}</span>
                      <span className="event-type">{event.type}</span>
                    </div>
                    {event.metadata && Object.keys(event.metadata).length > 0 && (
                      <details className="event-meta-details">
                        <summary>Metadados sanitizados</summary>
                        <pre className="event-meta-json">
                          {JSON.stringify(event.metadata, null, 2)}
                        </pre>
                      </details>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {/* Tab 6: Reviews */}
      {activeTab === "reviews" && (
        <section className="task-log-reviews-section panel">
          <div className="panel-head">
            <div>
              <div className="lbl">Revisões de Design & Código</div>
              <h3>Histórico de Revisões</h3>
            </div>
            <div className="count">{reviews.length} revisões</div>
          </div>

          {reviews.length === 0 ? (
            <div className="empty compact">
              <p>Nenhuma revisão formal foi submetida ainda para esta task.</p>
            </div>
          ) : (
            <div className="reviews-list">
              {reviews.map((rev) => (
                <article className={`review-log-card review-${rev.status}`} key={rev.id}>
                  <div className="review-head">
                    <div className="review-author">
                      <span className="rev-icon">✦</span>
                      <b>{rev.provider} Reviewer</b>
                      <span className="rev-id">#{rev.id}</span>
                    </div>
                    <span className={`rev-status status-${rev.status}`}>{rev.status}</span>
                    <span className="rev-time">{formatRelative(rev.createdAt)}</span>
                  </div>
                  <div className="review-content">
                    {rev.content ? (
                      <pre className="review-text-content">{rev.content}</pre>
                    ) : (
                      <p className="review-error">{rev.error ?? "Sem conteúdo adicional."}</p>
                    )}
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}

function StepperItem({
  step,
  label,
  state
}: {
  step: string;
  label: string;
  state: "done" | "current" | "pending" | "error";
}) {
  return (
    <div className={`stepper-node state-${state}`}>
      <div className="stepper-circle">
        {state === "done" ? "✓" : state === "error" ? "✕" : step}
      </div>
      <span className="stepper-label">{label}</span>
    </div>
  );
}

function StepAccordionCard({ step, index }: { step: TaskLogStep; index: number }) {
  const [open, setOpen] = useState(true);

  return (
    <div className={`step-card step-status-${step.status}`}>
      <header className="step-card-header" onClick={() => setOpen(!open)}>
        <div className="step-badge-index">#{String(index).padStart(2, "0")}</div>
        <span className={`step-phase-pill phase-${step.phase}`}>{step.phase}</span>
        <span className="step-provider-pill">{step.provider}</span>
        <span className={`step-status-pill status-${step.status}`}>{step.status}</span>
        <strong className="step-summary-title">{step.summary}</strong>
        <div className="step-header-meta">
          {step.durationMs ? <span className="step-duration">{step.durationMs}ms</span> : null}
          {step.tokenUsage ? (
            <span className="step-cost" title={`Model: ${step.tokenUsage.model}`}>
              ${step.tokenUsage.costUsd.toFixed(4)}
            </span>
          ) : null}
          <span className="accordion-arrow">{open ? "▾" : "▸"}</span>
        </div>
      </header>

      {open && (
        <div className="step-card-body">
          {step.checkpoint && (
            <div className="step-checkpoint-box">
              <div className="cp-box-title">
                <span>Checkpoint #{step.checkpoint.id}</span>
                <span className="cp-box-fp">{step.checkpoint.workspaceFingerprint ?? "sem hash"}</span>
              </div>
              {step.checkpoint.changedFiles && step.checkpoint.changedFiles.length > 0 && (
                <div className="cp-box-files">
                  <b>Arquivos tocados:</b> {step.checkpoint.changedFiles.join(", ")}
                </div>
              )}
            </div>
          )}

          {step.output && (
            <div className="step-output-box">
              <div className="box-title">Saída do Agente</div>
              <pre className="step-output-text">{step.output}</pre>
            </div>
          )}

          {step.error && (
            <div className="step-error-box">
              <div className="box-title">Erro Registrado</div>
              <pre className="step-error-text">{step.error}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function formatDuration(ms: number): string {
  if (!ms || ms <= 0) return "0s";
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const remainingAfterHours = totalSeconds % 3600;
  const minutes = Math.floor(remainingAfterHours / 60);
  const seconds = remainingAfterHours % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}
