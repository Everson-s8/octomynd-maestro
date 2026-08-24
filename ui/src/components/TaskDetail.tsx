import { FormEvent, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  cancelTask,
  createFollowUpTask,
  deleteTask,
  DashboardTask,
  fetchTaskReviews,
  GoalRun,
  prepareTask,
  requestClaudeReview,
  resumeGoal,
  startTaskGoal,
  TaskReview
} from "../api";
import { formatRelative } from "../helpers";
import { isOpenableExternalUrl } from "../external-links";
import { Icon } from "./Icon";
import { StatusPill } from "./StatusBadge";
import { translate } from "../i18n";

export function TaskDetail({
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
  const [followUpText, setFollowUpText] = useState("");
  const [followUpBusy, setFollowUpBusy] = useState(false);
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
      .then((items) => {
        if (active) setReviews(items);
      })
      .catch(() => {
        if (active) setReviews([]);
      });
    return () => {
      active = false;
    };
  }, [task]);

  if (!task) return null;
  const taskId = task.id;

  async function handlePrepare() {
    setPreparing(true);
    setError(null);
    try {
      await prepareTask(taskId);
      // Prepare alone leaves the task parked in "planning" with no provider
      // attached — users reported it as "nothing happens". Fire the goal right
      // away so the flow actually starts; a failure here is non-fatal because
      // the user can still press "Iniciar goal" manually.
      try {
        await startTaskGoal(taskId);
      } catch (goalError) {
        setError(
          goalError instanceof Error
            ? `${translate("Worktree prepared, but execution did not start")}: ${goalError.message} ${translate("Check that a provider is connected in Providers.")}`
            : translate("Worktree prepared, but execution did not start. Check that a provider is connected.")
        );
      }
      await onPrepared();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : translate("Unable to prepare the task."));
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
      setError(requestError instanceof Error ? requestError.message : translate("Claude review failed."));
      setReviews(await fetchTaskReviews(taskId).catch(() => []));
    } finally {
      setReviewing(false);
    }
  }

  async function handleStartGoal() {
    setStartingGoal(true);
    setError(null);
    try {
      if (goal && ["blocked", "failed"].includes(goal.status)) {
        await resumeGoal(goal.id);
      } else {
        await startTaskGoal(taskId);
      }
      await onPrepared();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : translate("The goal could not be started."));
    } finally {
      setStartingGoal(false);
    }
  }

  async function handleFollowUpSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = followUpText.trim();
    if (!text) return;
    setFollowUpBusy(true);
    setError(null);
    try {
      await createFollowUpTask(taskId, text);
      setFollowUpText("");
      await onPrepared();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : translate("Unable to create the follow-up task."));
    } finally {
      setFollowUpBusy(false);
    }
  }

  async function handleCancel() {
    if (!window.confirm(translate("Cancel task #{id}? The agent will be interrupted.", { id: taskId }))) return;
    setLifecycleBusy("cancel");
    setError(null);
    try {
      await cancelTask(taskId);
      await onPrepared();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : translate("Unable to cancel task."));
    } finally {
      setLifecycleBusy(null);
    }
  }

  async function handleDelete() {
    if (!window.confirm(translate("Permanently delete task #{id}? This action cannot be undone.", { id: taskId }))) return;
    setLifecycleBusy("delete");
    setError(null);
    try {
      await deleteTask(taskId);
      await onDeleted();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : translate("Unable to delete task."));
    } finally {
      setLifecycleBusy(null);
    }
  }

  const canPrepare = task.status === "queued" && !task.worktreePrepared;
  const canCancel = !["done", "failed", "rejected", "cancelled"].includes(task.status);
  const canDelete = !task.worktreePrepared && ["queued", "cancelled"].includes(task.status);
  const canResumeGoal = Boolean(goal && ["blocked", "failed"].includes(goal.status));

  return (
    <div
      className="detail-backdrop is-open"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <aside className="task-detail" role="dialog" aria-modal="true" aria-labelledby="task-detail-title">
        <button className="composer-close" onClick={onClose} aria-label={translate("Close details")}>
          <Icon name="close" />
        </button>
        <span className="task-detail-id">task #{String(task.id).padStart(2, "0")}</span>
        <StatusPill status={task.status} />
        <h2 id="task-detail-title">{task.title || task.text}</h2>
        {task.title && task.title !== task.text ? <p className="task-original-request">{translate("Original request")}: {task.text}</p> : null}
        <div className="detail-project">
          <span>@{task.projectKey ?? "inbox"}</span>
          <strong>{task.projectName ?? translate("No project")}</strong>
        </div>

        <dl className="detail-metadata">
          <div>
            <dt>{translate("Origin")}</dt>
            <dd>{task.source}</dd>
          </div>
          <div>
            <dt>{translate("Created")}</dt>
            <dd>{formatRelative(task.createdAt)}</dd>
          </div>
          <div>
            <dt>Branch</dt>
            <dd>{task.branchName ?? translate("not created yet")}</dd>
          </div>
          <div>
            <dt>Worktree</dt>
            <dd>{task.worktreePrepared ? translate("isolated and prepared") : translate("waiting for preparation")}</dd>
          </div>
        </dl>

        <div className="detail-flow">
          <span className="is-done">
            01 <strong>{translate("Captured")}</strong>
          </span>
          <span className={task.status !== "queued" ? "is-done" : "is-current"}>
            02 <strong>{translate("Prepared")}</strong>
          </span>
          <span className={task.status === "implementing" ? "is-current" : ""}>
            03 <strong>{translate("Running")}</strong>
          </span>
          <span className={task.status === "done" ? "is-done" : ""}>
            04 <strong>{translate("Completed")}</strong>
          </span>
        </div>

        {error ? <p className="detail-error">{error}</p> : null}
        <button className="detail-primary" disabled={!canPrepare || preparing} onClick={() => void handlePrepare()}>
          <span>
            {preparing
              ? translate("Preparing…")
              : canPrepare
              ? translate("Prepare worktree")
              : task.worktreePrepared
              ? translate("Worktree prepared")
              : translate("Action unavailable")}
          </span>
          <Icon name={canPrepare ? "arrow" : "shield"} />
        </button>
        <p className="detail-footnote">
          {translate("Preparation creates an isolated branch and directory. No agent executes code in this step.")}
        </p>

        <div className="goal-section">
          <div>
            <span>{translate("Persistent execution")}</span>
            <strong>{translate("Autonomous goal")}</strong>
          </div>
          <p>
            {translate("Maestro plans, implements, tests, and reviews. If review requests changes, it returns to implementation without manually updating the task.")}
          </p>
          <Link
            to={`/tasks/${task.id}/logs`}
            className="detail-logs-link-btn"
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              width: "100%",
              padding: "10px 14px",
              marginBottom: "12px",
              borderRadius: "10px",
              background: "#1c1712",
              border: "1px solid #372c20",
              color: "#f3ece1",
              textDecoration: "none",
              fontSize: "13px",
              fontWeight: 600
            }}
          >
            <span>{translate("View detailed execution logs")}</span>
            <Icon name="arrow" />
          </Link>
          <form className="task-follow-up" onSubmit={(event) => void handleFollowUpSubmit(event)}>
            <div>
              <span>{translate("Task continuation")}</span>
              <strong>{translate("Create a linked follow-up")}</strong>
            </div>
            <p>
              {translate("Record an improvement or fix without changing the original task evidence. The new task remains linked to this execution.")}
            </p>
            {task.parentTaskId ? <small>{translate("This task continues Task")} #{task.parentTaskId}.</small> : null}
            <textarea
              value={followUpText}
              onChange={(event) => setFollowUpText(event.target.value)}
              placeholder={translate("Example: fix the issues found in review…")}
              rows={3}
              aria-label={translate("Describe the follow-up task adjustment")}
            />
            <button type="submit" className="goal-action" disabled={!followUpText.trim() || followUpBusy}>
              {followUpBusy ? translate("Creating follow-up…") : translate("Create follow-up task")}
            </button>
          </form>
          <button
            className="goal-action"
            disabled={
              !task.worktreePrepared ||
              ["running", "waiting_provider"].includes(goal?.status ?? "") ||
              startingGoal ||
              ["done", "awaiting_human", "ready_to_merge", "rejected", "cancelled"].includes(task.status)
            }
            onClick={() => void handleStartGoal()}
          >
            {startingGoal
              ? canResumeGoal
              ? translate("Resuming goal…")
              : translate("Starting goal…")
              : goal?.status === "running"
              ? `${translate("Running {phase} · {steps} steps", { phase: goal.currentPhase, steps: goal.stepCount })}`
              : goal?.status === "waiting_provider"
              ? translate("Waiting for provider · {steps} steps", { steps: goal.stepCount })
              : task.status === "awaiting_human" && goal?.pullRequestUrl
              ? translate("Draft PR awaiting merge")
              : canResumeGoal
              ? translate("Resume goal from checkpoint")
              : task.worktreePrepared
              ? translate("Start goal")
              : translate("Prepare the worktree first")}
            <Icon name="pulse" />
          </button>
          {goal ? (
            <div className={`goal-state goal-${goal.status}`}>
              <span>
                goal #{goal.id} · {goal.status}
              </span>
              <strong>
                {goal.currentPhase} · {goal.stepCount} {translate("steps executed")}
              </strong>
              {goal.observability ? (
                <small className="goal-observability">
                  {goal.observability.classifiedReasonLabel
                    ? `${translate("Reason")}: ${goal.observability.classifiedReasonLabel}`
                    : goal.waitReason
                    ? `${translate("Reason")}: ${goal.waitReason}`
                    : ""}
                  {goal.observability.sourceProvider
                    ? ` · ${translate("Source")}: ${goal.observability.sourceProvider}`
                    : goal.lastProvider
                    ? ` · ${translate("Source")}: ${goal.lastProvider}`
                    : ""}
                  {goal.observability.nextProvider ? ` · ${translate("Next")}: ${goal.observability.nextProvider}` : ""}
                  {goal.observability.checkpointId ? ` · Checkpoint: #${goal.observability.checkpointId}` : ""}
                  {` · ${translate("Preserved")}: ${goal.observability.preservedChanges ? translate("yes") : translate("no")}`}
                  {` · ${translate("Resumable")}: ${goal.observability.retryable ? translate("yes") : translate("no")}`}
                  {goal.observability.nextAction ? ` · ${translate("Action")}: ${goal.observability.nextAction}` : ""}
                </small>
              ) : goal.status === "waiting_provider" && goal.waitReason ? (
                  <small>
                  {translate("Reason")}: {goal.waitReason}
                  {goal.lastProvider ? ` · provider: ${goal.lastProvider}` : ""}
                  {goal.nextRetryAt ? ` · ${translate("next retry")}: ${new Date(goal.nextRetryAt).toLocaleTimeString()}` : ""}
                </small>
              ) : null}
              {goal.lastError ? <small>{goal.lastError}</small> : null}
              {goal.pullRequestUrl ? (
                isOpenableExternalUrl(goal.pullRequestUrl) ? (
                  <a href={goal.pullRequestUrl} target="_blank" rel="noreferrer">
                    {translate("Open draft PR")}
                  </a>
                ) : (
                  <span title={translate("This execution did not create a GitHub PR; delivery stayed on the local branch.")}>
                    {translate("GitHub PR unavailable (local branch)")}
                  </span>
                )
              ) : null}
            </div>
          ) : null}
        </div>

        <div className="review-section">
          <div>
            <span>{translate("External review")}</span>
            <strong>{translate("Claude design review")}</strong>
          </div>
          <button
            className="review-action"
            disabled={!task.worktreePrepared || reviewing}
            onClick={() => void handleClaudeReview()}
          >
            {reviewing ? translate("Claude is reviewing…") : task.worktreePrepared ? translate("Request review") : translate("Prepare the worktree first")}
            <Icon name="spark" />
          </button>
          {reviews.map((review) => (
            <article className={`review-card review-${review.status}`} key={review.id}>
              <header>
                <span>Claude · #{review.id}</span>
                <time>{formatRelative(review.createdAt)}</time>
              </header>
              <strong>
                {review.status === "completed"
                  ? translate("Review completed")
                  : review.status === "auth_required"
                  ? translate("Authentication required")
                  : translate("Review failed")}
              </strong>
              <p>{review.content || review.error}</p>
            </article>
          ))}
        </div>

        <div className="task-danger-zone">
          <div>
            <span>{translate("Task controls")}</span>
            <strong>{translate("Cancel or delete")}</strong>
          </div>
          <p>{translate("Cancel interrupts execution and preserves history. Deletion is allowed only without a worktree and goal history.")}</p>
          <div className="task-danger-actions">
            <button disabled={!canCancel || lifecycleBusy !== null} onClick={() => void handleCancel()}>
              {lifecycleBusy === "cancel" ? translate("Cancelling…") : translate("Cancel task")}
            </button>
            <button disabled={!canDelete || lifecycleBusy !== null} onClick={() => void handleDelete()}>
              {lifecycleBusy === "delete" ? translate("Deleting…") : translate("Delete task")}
            </button>
          </div>
        </div>
      </aside>
    </div>
  );
}
