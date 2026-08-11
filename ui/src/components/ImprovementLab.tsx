import { FormEvent, useState } from "react";
import { createImprovement, decideImprovement, ImprovementCategory, ImprovementProposal, ImprovementRisk } from "../api";
import { EmptyState } from "./EmptyState";
import { Icon } from "./Icon";
import { SectionHeader } from "./SectionHeader";

export function ImprovementLab({
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
            <label>
              Categoria
              <select value={category} onChange={(event) => setCategory(event.target.value as ImprovementCategory)}>
                <option value="skill">skill</option>
                <option value="memory">memoria</option>
                <option value="routing">roteamento</option>
                <option value="policy">politica</option>
                <option value="integration">integracao</option>
              </select>
            </label>
            <label>
              Risco
              <select value={risk} onChange={(event) => setRisk(event.target.value as ImprovementRisk)}>
                <option value="low">baixo</option>
                <option value="medium">medio</option>
                <option value="high">alto</option>
              </select>
            </label>
          </div>
          <label>
            Titulo
            <input value={title} onChange={(event) => setTitle(event.target.value)} minLength={4} required />
          </label>
          <label>
            Por que mudar?
            <textarea value={rationale} onChange={(event) => setRationale(event.target.value)} minLength={8} required />
          </label>
          <label>
            Mudanca proposta
            <textarea value={proposedChange} onChange={(event) => setProposedChange(event.target.value)} minLength={8} required />
          </label>
          <label>
            Evidencias, uma por linha
            <textarea value={evidence} onChange={(event) => setEvidence(event.target.value)} minLength={4} required />
          </label>
          {error ? <p className="improvement-error">{error}</p> : null}
          <button type="submit" disabled={busyId !== null}>
            Registrar candidata <Icon name="arrow" />
          </button>
        </form>
        <div className="improvement-queue">
          {improvements.length === 0 ? (
            <EmptyState
              icon="spark"
              title="Nenhuma proposta ainda"
              text="Aprendizados entram aqui antes de qualquer mutacao persistente."
            />
          ) : (
            improvements.slice(0, 8).map((item) => (
              <article className={`improvement-card improvement-${item.status}`} key={item.id}>
                <header>
                  <span>
                    #{item.id} · {item.category}
                  </span>
                  <span className={`risk-${item.risk}`}>risco {item.risk}</span>
                </header>
                <strong>{item.title}</strong>
                <p>{item.rationale}</p>
                <small>
                  {item.evidence.length} evidencia(s) · origem {item.source}
                  {item.confidence === null ? "" : ` · confiança ${Math.round(item.confidence * 100)}%`}
                </small>
                {item.status === "candidate" ? (
                  <div className="improvement-actions">
                    <button onClick={() => void decide(item.id, "rejected")} disabled={busyId !== null}>
                      Rejeitar
                    </button>
                    <button onClick={() => void decide(item.id, "approved")} disabled={busyId !== null}>
                      Aprovar para implementar
                    </button>
                  </div>
                ) : (
                  <span className={`improvement-decision decision-${item.status}`}>
                    {item.status}
                    {item.featurePlanId ? ` · Feature Plan #${item.featurePlanId}` : ""}
                    {item.taskId ? ` · Task #${item.taskId}` : ""}
                  </span>
                )}
              </article>
            ))
          )}
        </div>
      </div>
    </section>
  );
}
