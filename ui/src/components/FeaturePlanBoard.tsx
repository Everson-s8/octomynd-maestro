import { useState } from "react";
import {
  cancelFeaturePlan,
  DashboardFeaturePlan,
  pauseFeaturePlan,
  resumeFeaturePlan,
  retryFeaturePlan,
  updateFeaturePlanPriority
} from "../api";
import { featureStatusLabels } from "../helpers";
import { EmptyState } from "./EmptyState";
import { SectionHeader } from "./SectionHeader";

export function FeaturePlanBoard({
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
  const sortedPlans = [...visiblePlans].sort(
    (left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime()
  );

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

  async function handlePause(plan: DashboardFeaturePlan) {
    const reason = window.prompt(`Motivo da pausa para o Feature Plan #${plan.id}:`, "Pausa manual pelo operador");
    if (reason === null) return;
    setBusyId(plan.id);
    setError(null);
    try {
      await pauseFeaturePlan(plan.id, reason);
      await onChanged();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Nao foi possivel pausar o Feature Plan.");
    } finally {
      setBusyId(null);
    }
  }

  async function handleResume(plan: DashboardFeaturePlan) {
    setBusyId(plan.id);
    setError(null);
    try {
      await resumeFeaturePlan(plan.id);
      await onChanged();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Nao foi possivel retomar o Feature Plan.");
    } finally {
      setBusyId(null);
    }
  }

  async function handleRetry(plan: DashboardFeaturePlan) {
    const reason = window.prompt(
      `Motivo da nova tentativa para o Feature Plan #${plan.id}:`,
      "Reinicio manual pelo operador"
    );
    if (reason === null) return;
    setBusyId(plan.id);
    setError(null);
    try {
      await retryFeaturePlan(plan.id, reason);
      await onChanged();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Nao foi possivel tentar novamente o Feature Plan.");
    } finally {
      setBusyId(null);
    }
  }

  async function handlePriority(plan: DashboardFeaturePlan, delta: number) {
    const current = plan.priority ?? 0;
    const newPriority = Math.max(0, current + delta);
    if (newPriority === current && delta < 0) return;
    setBusyId(plan.id);
    setError(null);
    try {
      await updateFeaturePlanPriority(plan.id, newPriority);
      await onChanged();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Nao foi possivel atualizar a prioridade.");
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
          <EmptyState
            icon="spark"
            title="Nenhum Feature Plan"
            text="Planos agrupando varias tasks em um unico PR consolidado aparecem aqui."
          />
        ) : (
          sortedPlans.slice(0, 6).map((plan) => (
            <article className={`feature-plan-row plan-${plan.lifecycleStatus}`} key={plan.id}>
              <div className="feature-plan-copy">
                <div>
                  <span className="project-tag">@{plan.projectKey}</span>
                  <span className={`status-pill plan-status-${plan.status}`}>{plan.status}</span>
                  <span className="status-pill priority-pill">prio: {plan.priority ?? 0}</span>
                  {plan.isPaused ? (
                    <span className="status-pill paused-pill" title={plan.pauseReason || "Pausado"}>
                      pausado
                    </span>
                  ) : null}
                  {plan.lifecycleStatus === "active" ? (
                    <span className={`status-pill eligibility-${plan.eligible ? "ready" : "blocked"}`}>
                      {plan.eligible ? "elegivel para integrar" : "aguardando"}
                    </span>
                  ) : null}
                </div>
                <strong>{plan.objective}</strong>
                <small>
                  {plan.taskCount} task(s) no bloco - revisao {plan.revision}
                  {plan.dependsOnFeaturePlanIds && plan.dependsOnFeaturePlanIds.length > 0
                    ? ` · depende de: ${plan.dependsOnFeaturePlanIds.map((id) => `#${id}`).join(", ")}`
                    : ""}
                </small>
                <div className="feature-plan-tasks">
                  {plan.tasks.map((task) => (
                    <span
                      className={`status-pill status-${task.status}`}
                      key={task.id}
                      title={[
                        task.objective,
                        `Depende de: ${
                          task.dependsOnTaskIds.length ? task.dependsOnTaskIds.map((id) => `#${id}`).join(", ") : "nenhuma"
                        }`,
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
                    {plan.blockers.map((blocker, index) => (
                      <li key={index}>{blocker}</li>
                    ))}
                  </ul>
                ) : null}
                {plan.blockedReason ? (
                  <small className="feature-plan-integration-error">Bloqueio: {plan.blockedReason}</small>
                ) : null}
                <small className="feature-plan-next-action">
                  Proxima acao:{" "}
                  {plan.status === "blocked"
                    ? "Resolva o motivo do bloqueio e clique em Tentar novamente."
                    : plan.isPaused
                    ? "Clique em Retomar para reenviar o plano para a fila."
                    : plan.status === "queued" && plan.eligible
                    ? "Plano elegivel, aguardando inicio das tasks."
                    : plan.status === "queued"
                    ? "Aguardando liberacao de dependencias ou do projeto."
                    : "Tasks em andamento pelo agente."}
                </small>
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
                  <div className="priority-actions">
                    <button
                      className="row-action"
                      disabled={busyId !== null}
                      onClick={() => void handlePriority(plan, 5)}
                      title="Aumentar prioridade (+5)"
                    >
                      ▲
                    </button>
                    <button
                      className="row-action"
                      disabled={busyId !== null || (plan.priority ?? 0) <= 0}
                      onClick={() => void handlePriority(plan, -5)}
                      title="Reduzir prioridade (-5)"
                    >
                      ▼
                    </button>
                  </div>
                ) : null}
                {plan.status === "blocked" ? (
                  <button className="row-action row-action-accent" disabled={busyId !== null} onClick={() => void handleRetry(plan)}>
                    {busyId === plan.id ? "..." : "Tentar novamente"}
                  </button>
                ) : null}
                {plan.cancellable && !plan.isPaused ? (
                  <button className="row-action" disabled={busyId !== null} onClick={() => void handlePause(plan)}>
                    {busyId === plan.id ? "..." : "Pausar"}
                  </button>
                ) : null}
                {plan.cancellable && plan.isPaused ? (
                  <button className="row-action" disabled={busyId !== null} onClick={() => void handleResume(plan)}>
                    {busyId === plan.id ? "..." : "Retomar"}
                  </button>
                ) : null}
                {plan.cancellable ? (
                  <button className="row-action row-action-danger" disabled={busyId !== null} onClick={() => void handleCancel(plan)}>
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
          ))
        )}
      </div>
    </section>
  );
}
