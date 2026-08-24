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
import { translate } from "../i18n";

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
    if (!window.confirm(translate("Cancel Feature Plan #{id} before integration? The history will be preserved.", { id: plan.id }))) return;
    setBusyId(plan.id);
    setError(null);
    try {
      await cancelFeaturePlan(plan.id, translate("Cancelled from the dashboard."));
      await onChanged();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : translate("Unable to cancel the Feature Plan."));
    } finally {
      setBusyId(null);
    }
  }

  async function handlePause(plan: DashboardFeaturePlan) {
    const reason = window.prompt(translate("Pause reason for Feature Plan #{id}:", { id: plan.id }), translate("Manual pause by operator"));
    if (reason === null) return;
    setBusyId(plan.id);
    setError(null);
    try {
      await pauseFeaturePlan(plan.id, reason);
      await onChanged();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : translate("Unable to pause the Feature Plan."));
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
      setError(requestError instanceof Error ? requestError.message : translate("Unable to resume the Feature Plan."));
    } finally {
      setBusyId(null);
    }
  }

  async function handleRetry(plan: DashboardFeaturePlan) {
    const reason = window.prompt(
      translate("Retry reason for Feature Plan #{id}:", { id: plan.id }),
      translate("Manual retry by operator")
    );
    if (reason === null) return;
    setBusyId(plan.id);
    setError(null);
    try {
      await retryFeaturePlan(plan.id, reason);
      await onChanged();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : translate("Unable to retry the Feature Plan."));
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
      setError(requestError instanceof Error ? requestError.message : translate("Unable to update priority."));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="panel feature-plan-board" id="feature-plans" aria-labelledby="feature-plans-title">
      <SectionHeader
        eyebrow={translate("Planning")}
        title="Feature Plans"
        meta={`${featurePlans.filter((plan) => plan.lifecycleStatus === "active").length} ${translate("active")}`}
      />
      {featurePlans.some((plan) => plan.lifecycleStatus !== "active") ? (
        <button className="row-action" onClick={() => setShowHistory((current) => !current)}>
          {showHistory ? translate("Hide history") : translate("View history")}
        </button>
      ) : null}
      {error ? <p className="detail-error">{error}</p> : null}
      <div className="feature-plan-list">
        {sortedPlans.length === 0 ? (
          <EmptyState
            icon="spark"
            title={translate("No Feature Plan")}
            text={translate("Plans grouping multiple tasks into one consolidated PR appear here.")}
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
                    <span className="status-pill paused-pill" title={plan.pauseReason || translate("paused")}>
                      {translate("paused")}
                    </span>
                  ) : null}
                  {plan.lifecycleStatus === "active" ? (
                    <span className={`status-pill eligibility-${plan.eligible ? "ready" : "blocked"}`}>
                      {plan.eligible ? translate("eligible for integration") : translate("waiting")}
                    </span>
                  ) : null}
                </div>
                <strong>{plan.objective}</strong>
                <small>
                  {plan.taskCount} {translate("task(s) in block")} - {translate("revision")} {plan.revision}
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
                        `${translate("Depends on")}: ${
                          task.dependsOnTaskIds.length ? task.dependsOnTaskIds.map((id) => `#${id}`).join(", ") : translate("none")
                        }`,
                        `${translate("Scope")}: ${task.mutationScope.length ? task.mutationScope.join(", ") : translate("read-only")}`,
                        `${translate("Mode")}: ${task.parallelMode}`,
                        `${translate("Acceptance")}: ${task.acceptanceCriteria.join(" | ")}`,
                        `${translate("Out of scope")}: ${task.excludedScope.join(", ") || translate("not specified")}`
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
                  <small className="feature-plan-integration-error">{translate("Blocked:")} {plan.blockedReason}</small>
                ) : null}
                <small className="feature-plan-next-action">
                  {translate("Next action:")}{" "}
                  {plan.status === "blocked"
                    ? translate("Resolve the blocker and click Retry.")
                    : plan.isPaused
                    ? translate("Click Resume to send the plan back to the queue.")
                    : plan.status === "queued" && plan.eligible
                    ? translate("Plan is eligible and waiting for tasks to start.")
                    : plan.status === "queued"
                    ? translate("Waiting for dependencies or project access to be released.")
                    : translate("Tasks are in progress with the agent.")}
                </small>
                {plan.integration ? (
                  <small className={plan.integration.status === "failed" ? "feature-plan-integration-error" : ""}>
                    {translate("Integration:")} {plan.integration.status} ({plan.integration.checkpoint})
                    {plan.integration.lastError ? ` - ${plan.integration.lastError}` : ""}
                  </small>
                ) : null}
                {plan.cancelReason ? <small>{translate("Cancelled:")} {plan.cancelReason}</small> : null}
              </div>
              <div className="feature-plan-actions">
                {plan.cancellable ? (
                  <div className="priority-actions">
                    <button
                      className="row-action"
                      disabled={busyId !== null}
                      onClick={() => void handlePriority(plan, 5)}
                      title={translate("Increase priority (+5)")}
                    >
                      ▲
                    </button>
                    <button
                      className="row-action"
                      disabled={busyId !== null || (plan.priority ?? 0) <= 0}
                      onClick={() => void handlePriority(plan, -5)}
                      title={translate("Decrease priority (-5)")}
                    >
                      ▼
                    </button>
                  </div>
                ) : null}
                {plan.status === "blocked" ? (
                  <button className="row-action row-action-accent" disabled={busyId !== null} onClick={() => void handleRetry(plan)}>
                    {busyId === plan.id ? "..." : translate("Retry")}
                  </button>
                ) : null}
                {plan.cancellable && !plan.isPaused ? (
                  <button className="row-action" disabled={busyId !== null} onClick={() => void handlePause(plan)}>
                    {busyId === plan.id ? "..." : translate("Pause")}
                  </button>
                ) : null}
                {plan.cancellable && plan.isPaused ? (
                  <button className="row-action" disabled={busyId !== null} onClick={() => void handleResume(plan)}>
                    {busyId === plan.id ? "..." : translate("Resume")}
                  </button>
                ) : null}
                {plan.cancellable ? (
                  <button className="row-action row-action-danger" disabled={busyId !== null} onClick={() => void handleCancel(plan)}>
                    {busyId === plan.id ? "..." : translate("Cancel plan")}
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
