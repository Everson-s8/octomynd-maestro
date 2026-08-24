import { useEffect, useState } from "react";
import { decideHumanReview, HumanReviewDecision, ReviewQueueItem } from "../api";
import { changeSafetyGateClass, changeSafetyGateLabel } from "../helpers";
import { isOpenableExternalUrl, openExternalUrl } from "../external-links";
import { EmptyState } from "./EmptyState";
import { Icon } from "./Icon";
import { SectionHeader } from "./SectionHeader";

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
    message: "Verificacao de segredos concluida sem alertas."
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
      setError(requestError instanceof Error ? requestError.message : "A decisão não foi registrada.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="panel human-review-queue" id="reviews" aria-labelledby="reviews-title">
      <SectionHeader eyebrow="Human gate" title="Aguardando revisão" meta={`${reviews.length} pendente(s)`} />
      {reviews.length === 0 ? (
        <EmptyState icon="shield" title="Nenum PR esperando" text="Novos draft PRs revisados pelos agentes aparecem aqui." />
      ) : (
        <div className="review-workbench">
          <div className="review-inbox" role="list" aria-label="Pull requests aguardando revisão">
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
                  {item.changedFiles.length} arquivo(s) · {item.agents.join(" + ") || "sem agente"}
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
                  <span>Projeto</span>
                  <strong>@{selected.projectKey}</strong>
                </div>
                <div>
                  <span>Agentes</span>
                  <strong>{selected.agents.join(", ") || "nenhum"}</strong>
                </div>
                <div>
                  <span>Commit</span>
                  <strong>{selected.commitSha?.slice(0, 8) ?? "pendente"}</strong>
                </div>
                <div>
                  <span>Testes</span>
                  <strong>{selected.tests.length} etapa(s)</strong>
                </div>
              </div>
              <div className="review-evidence-grid">
                <div>
                  <h4>Arquivos alterados</h4>
                  <ul>
                    {selected.changedFiles.length > 0 ? (
                      selected.changedFiles.map((file) => (
                        <li key={file}>
                          <code>{file}</code>
                        </li>
                      ))
                    ) : (
                      <li>Nenhum arquivo identificado.</li>
                    )}
                  </ul>
                </div>
                <div>
                  <h4>Testes executados</h4>
                  <ul>
                    {selected.tests.length > 0 ? (
                      selected.tests.map((test, index) => (
                        <li key={`${test.provider}-${index}`}>
                          <strong>{test.status}</strong> · {test.summary}
                        </li>
                      ))
                    ) : (
                      <li>Nenhuma etapa de teste registrada.</li>
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
                <ReviewExternalLink url={selected.diffUrl} label="Abrir diff" />
                <ReviewExternalLink url={selected.pullRequestUrl} label="Abrir PR no GitHub" />
              </div>
              <label className="review-note">
                Justificativa da decisão
                <textarea
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  minLength={4}
                  maxLength={1200}
                  placeholder="Registre por que aprovar, ajustar ou rejeitar."
                />
              </label>
              {error ? <p className="review-decision-error">{error}</p> : null}
              <div className="review-decision-actions">
                <button
                  className="decision-reject"
                  disabled={busy !== null || note.trim().length < 4 || !hasGitHubPullRequest}
                  onClick={() => void decide("rejected")}
                >
                  Rejeitar
                </button>
                <button
                  className="decision-changes"
                  disabled={busy !== null || note.trim().length < 4 || !hasGitHubPullRequest}
                  onClick={() => void decide("changes_requested")}
                >
                  Solicitar ajustes
                </button>
                <button
                  className="decision-approve"
                  disabled={busy !== null || note.trim().length < 4 || !isChangeSafetyPassed || !hasGitHubPullRequest}
                  title={!hasGitHubPullRequest
                    ? "Não há PR no GitHub para esta execução. Instale/autentique o GitHub CLI e execute a entrega novamente."
                    : !isChangeSafetyPassed
                    ? changeSafetyGate.message
                    : undefined}
                  onClick={() => void decide("approved")}
                >
                  {busy === "approved" ? "Aprovando..." : "Aprovar para merge"}
                </button>
              </div>
              <small className="review-merge-note">
                {hasGitHubPullRequest
                  ? "A aprovação prepara e mergeia o PR no GitHub. Solicitar ajustes devolve o PR para draft."
                  : "Esta execução ficou somente na branch local: não existe PR no GitHub para aprovar ou solicitar ajustes."}
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
        title="Este trabalho não criou um PR no GitHub nesta execução; a entrega ficou apenas na branch local."
      >
        {label} indisponível
      </span>
    );
  }
  return (
    <button type="button" className="review-link-button" onClick={() => openExternalUrl(url)}>
      {label} <Icon name="arrow" />
    </button>
  );
}
