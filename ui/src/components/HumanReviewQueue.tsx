import { useEffect, useState } from "react";
import { decideHumanReview, HumanReviewDecision, ReviewQueueItem } from "../api";
import { changeSafetyGateClass, changeSafetyGateLabel } from "../helpers";
import { isOpenableExternalUrl, openExternalUrl } from "../external-links";
import { EmptyState } from "./EmptyState";
import { Icon } from "./Icon";
import { SectionHeader } from "./SectionHeader";
import { translate } from "../i18n";

export function HumanReviewQueue({
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
    message: translate("Secret scan completed without alerts.")
  };
  const isChangeSafetyPassed = changeSafetyGate.status === "passed";
  const hasGitHubPullRequest = selected ? isOpenableExternalUrl(selected.pullRequestUrl) : false;

  async function decide(decision: HumanReviewDecision) {
    if (!selected || note.trim().length < 4 || !hasGitHubPullRequest) return;
    setBusy(decision);
    setError(null);
    try {
      await decideHumanReview(selected.runId, decision, note.trim(), decision === "approved");
      setNote("");
      await onChanged();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : translate("The decision was not recorded."));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="panel human-review-queue" id="reviews" aria-labelledby="reviews-title">
      <SectionHeader eyebrow="Human gate" title={translate("Awaiting review")} meta={`${reviews.length} ${translate("pending")}`} />
      {reviews.length === 0 ? (
        <EmptyState icon="shield" title={translate("No PR awaiting review")} text={translate("New draft PRs reviewed by agents appear here.")} />
      ) : (
        <div className="review-workbench">
          <div className="review-inbox" role="list" aria-label={translate("Pull requests awaiting review")}>
            {reviews.map((item) => (
              <button
                className={`review-inbox-item ${item.runId === selected?.runId ? "is-selected" : ""}`}
                key={item.runId}
                onClick={() => {
                  setSelectedRunId(item.runId);
                  setNote("");
                  setError(null);
                }}
              >
                <span>
                  @{item.projectKey} · task #{item.taskId}
                </span>
                <strong>{item.demand}</strong>
                <small>
                  {item.changedFiles.length} {translate("file(s)")} · {item.agents.join(" + ") || translate("no agent")}
                </small>
              </button>
            ))}
          </div>
          {selected ? (
            <article className="review-evidence">
              <header>
                <div>
                  <span>Goal #{selected.runId}</span>
                  <h3>{selected.demand}</h3>
                </div>
                <span className={`review-security-state ${changeSafetyGateClass(changeSafetyGate.status)}`}>
                  {changeSafetyGateLabel(changeSafetyGate.status)}
                </span>
              </header>
              <p className="review-summary">{selected.summary}</p>
              <div className="review-facts">
                <div>
                  <span>{translate("Project")}</span>
                  <strong>@{selected.projectKey}</strong>
                </div>
                <div>
                  <span>{translate("Agents")}</span>
                  <strong>{selected.agents.join(", ") || translate("none")}</strong>
                </div>
                <div>
                  <span>Commit</span>
                  <strong>{selected.commitSha?.slice(0, 8) ?? translate("pending")}</strong>
                </div>
                <div>
                  <span>{translate("Tests")}</span>
                  <strong>{selected.tests.length} {translate("step(s)")}</strong>
                </div>
              </div>
              <div className="review-evidence-grid">
                <div>
                  <h4>{translate("Changed files")}</h4>
                  <ul>
                    {selected.changedFiles.length > 0 ? (
                      selected.changedFiles.map((file) => (
                        <li key={file}>
                          <code>{file}</code>
                        </li>
                      ))
                    ) : (
                      <li>{translate("No files identified.")}</li>
                    )}
                  </ul>
                </div>
                <div>
                  <h4>{translate("Executed tests")}</h4>
                  <ul>
                    {selected.tests.length > 0 ? (
                      selected.tests.map((test, index) => (
                        <li key={`${test.provider}-${index}`}>
                          <strong>{test.status}</strong> · {test.summary}
                        </li>
                      ))
                    ) : (
                      <li>{translate("No test step recorded.")}</li>
                    )}
                  </ul>
                </div>
              </div>
              <div className="review-alerts">
                {selected.securityAlerts.map((alert, index) => (
                  <div className={`review-alert alert-${alert.severity}`} key={`${alert.code}-${index}`}>
                    <Icon name={alert.severity === "info" ? "shield" : "warning"} />
                    <span>
                      <strong>{alert.message}</strong>
                      {alert.file ? <code>{alert.file}</code> : null}
                    </span>
                  </div>
                ))}
              </div>
              <div className="review-links">
                <ReviewExternalLink url={selected.diffUrl} label={translate("Open diff")} />
                <ReviewExternalLink url={selected.pullRequestUrl} label={translate("Open PR on GitHub")} />
              </div>
              <label className="review-note">
                {translate("Decision rationale")}
                <textarea
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  minLength={4}
                  maxLength={1200}
                  placeholder={translate("Explain why to approve, request changes, or reject.")}
                />
              </label>
              {error ? <p className="review-decision-error">{error}</p> : null}
              <div className="review-decision-actions">
                <button
                  className="decision-reject"
                  disabled={busy !== null || note.trim().length < 4 || !hasGitHubPullRequest}
                  onClick={() => void decide("rejected")}
                >
                  {translate("Reject")}
                </button>
                <button
                  className="decision-changes"
                  disabled={busy !== null || note.trim().length < 4 || !hasGitHubPullRequest}
                  onClick={() => void decide("changes_requested")}
                >
                  {translate("Request changes")}
                </button>
                <button
                  className="decision-approve"
                  disabled={busy !== null || note.trim().length < 4 || !isChangeSafetyPassed || !hasGitHubPullRequest}
                  title={!hasGitHubPullRequest
                    ? translate("No GitHub PR exists for this run. Install/authenticate GitHub CLI and run delivery again.")
                    : !isChangeSafetyPassed
                    ? changeSafetyGate.message
                    : undefined}
                  onClick={() => void decide("approved")}
                >
                  {busy === "approved" ? translate("Approving…") : translate("Approve for merge")}
                </button>
              </div>
              <small className="review-merge-note">
                {hasGitHubPullRequest
                  ? translate("Approval prepares and merges the PR on GitHub. Requesting changes returns the PR to draft.")
                  : translate("This execution stayed on the local branch: there is no GitHub PR to approve or revise.")}
              </small>
            </article>
          ) : null}
        </div>
      )}
    </section>
  );
}

function ReviewExternalLink({ url, label }: { url: string; label: string }) {
  const canOpen = isOpenableExternalUrl(url);
  if (!canOpen) {
    return (
      <span
        className="review-link-disabled"
        title={translate("This run did not create a GitHub PR; delivery stayed on the local branch.")}
      >
        {label} {translate("unavailable")}
      </span>
    );
  }
  return (
    <button type="button" className="review-link-button" onClick={() => openExternalUrl(url)}>
      {label} <Icon name="arrow" />
    </button>
  );
}
