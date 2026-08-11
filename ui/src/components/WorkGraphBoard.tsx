import { useState } from "react";
import { cancelWorkGraph, DashboardWorkGraph } from "../api";
import { formatWorkGraphDuration, isWorkGraphCancellable } from "../workGraphs";
import { EmptyState } from "./EmptyState";
import { SectionHeader } from "./SectionHeader";

export function WorkGraphBoard({
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
          <EmptyState
            icon="spark"
            title="Nenhum Work Graph"
            text="Tasks complexas poderao aparecer aqui como DAGs governados."
          />
        ) : (
          workGraphs.slice(0, 6).map((graph) => (
            <article className={`work-graph-card status-${graph.status}`} key={graph.id}>
              <header>
                <div>
                  <span>
                    @{graph.projectKey ?? "inbox"} · task #{graph.taskId}
                  </span>
                  <strong>
                    Graph #{graph.id} · {graph.status}
                  </strong>
                </div>
                <small>
                  {graph.artifactCount} artefatos · {Math.ceil(graph.artifactBytes / 1024)} KB
                </small>
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
                    <small>
                      {node.mode === "writer" ? "WRITE" : "READ"} · {node.attemptCount}/{node.maxAttempts}
                    </small>
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
                ) : (
                  <small>Historico preservado</small>
                )}
              </footer>
            </article>
          ))
        )}
      </div>
    </section>
  );
}
