import { FormEvent, useState } from "react";
import { createImprovement, decideImprovement, ImprovementCategory, ImprovementProposal, ImprovementRisk } from "../api";
import { EmptyState } from "./EmptyState";
import { Icon } from "./Icon";
import { SectionHeader } from "./SectionHeader";
import { translate } from "../i18n";

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
      setError(requestError instanceof Error ? requestError.message : translate("Unable to record the proposal."));
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
      setError(requestError instanceof Error ? requestError.message : translate("Unable to decide on the proposal."));
    } finally {
      setBusyId(null);
    }
  }

  const candidates = improvements.filter((item) => item.status === "candidate");
  return (
    <section className="panel improvement-lab" id="learning" aria-labelledby="learning-title">
      <SectionHeader eyebrow={translate("Safe evolution")} title={translate("Learning lab")} meta={`${candidates.length} ${translate("awaiting decision")}`} />
      <div className="improvement-layout">
        <form className="improvement-form" onSubmit={submit}>
          <strong>{translate("Propose improvement")}</strong>
          <p>{translate("Maestro records the hypothesis and evidence. Approval does not automatically change code, prompts, or skills.")}</p>
          <div className="improvement-fields two-columns">
            <label>
              {translate("Category")}
              <select value={category} onChange={(event) => setCategory(event.target.value as ImprovementCategory)}>
                <option value="skill">skill</option>
                <option value="memory">{translate("memory")}</option>
                <option value="routing">{translate("routing")}</option>
                <option value="policy">{translate("policy")}</option>
                <option value="integration">{translate("integration")}</option>
              </select>
            </label>
            <label>
              {translate("Risk")}
              <select value={risk} onChange={(event) => setRisk(event.target.value as ImprovementRisk)}>
                <option value="low">{translate("low")}</option>
                <option value="medium">{translate("medium")}</option>
                <option value="high">{translate("high")}</option>
              </select>
            </label>
          </div>
          <label>
            {translate("Title")}
            <input value={title} onChange={(event) => setTitle(event.target.value)} minLength={4} required />
          </label>
          <label>
            {translate("Why change?")}
            <textarea value={rationale} onChange={(event) => setRationale(event.target.value)} minLength={8} required />
          </label>
          <label>
            {translate("Proposed change")}
            <textarea value={proposedChange} onChange={(event) => setProposedChange(event.target.value)} minLength={8} required />
          </label>
          <label>
            {translate("Evidence, one per line")}
            <textarea value={evidence} onChange={(event) => setEvidence(event.target.value)} minLength={4} required />
          </label>
          {error ? <p className="improvement-error">{error}</p> : null}
          <button type="submit" disabled={busyId !== null}>
            {translate("Record candidate")} <Icon name="arrow" />
          </button>
        </form>
        <div className="improvement-queue">
          {improvements.length === 0 ? (
            <EmptyState
              icon="spark"
              title={translate("No proposal yet")}
              text={translate("Learnings appear here before any persistent mutation.")}
            />
          ) : (
            improvements.slice(0, 8).map((item) => (
              <article className={`improvement-card improvement-${item.status}`} key={item.id}>
                <header>
                  <span>
                    #{item.id} · {item.category}
                  </span>
                  <span className={`risk-${item.risk}`}>{translate("risk")} {translate(item.risk)}</span>
                </header>
                <strong>{item.title}</strong>
                <p>{item.rationale}</p>
                <small>
                  {item.evidence.length} {translate("evidence(s)")} · {translate("source")} {item.source}
                  {item.confidence === null ? "" : ` · ${translate("confidence")} ${Math.round(item.confidence * 100)}%`}
                </small>
                {item.status === "candidate" ? (
                  <div className="improvement-actions">
                    <button onClick={() => void decide(item.id, "rejected")} disabled={busyId !== null}>
                      {translate("Reject")}
                    </button>
                    <button onClick={() => void decide(item.id, "approved")} disabled={busyId !== null}>
                      {translate("Approve for implementation")}
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
