import { FormEvent, useEffect, useState } from "react";
import { DashboardProject, previewWorkIntake, submitWorkIntake, WorkIntakePreviewResult } from "../api";
import { Icon } from "./Icon";

export function TaskComposer({
  open,
  projects,
  onClose,
  onCreated
}: {
  open: boolean;
  projects: DashboardProject[];
  onClose: () => void;
  onCreated: () => Promise<void>;
}) {
  const [projectKey, setProjectKey] = useState("");
  const [text, setText] = useState("");
  const [override, setOverride] = useState<"automatic" | "direct_task" | "feature_plan" | "needs_clarification">("automatic");
  const [preview, setPreview] = useState<WorkIntakePreviewResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open && !projectKey && projects.length > 0) setProjectKey(projects[0].key);
  }, [open, projectKey, projects]);

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [open, onClose]);

  async function handleAnalyze() {
    if (!text.trim() || text.trim().length < 4) return;
    setAnalyzing(true);
    setError(null);
    try {
      const res = await previewWorkIntake({
        projectKey,
        objective: text,
        explicitOverride: override === "automatic" ? null : override
      });
      setPreview(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não foi possível analisar a demanda.");
    } finally {
      setAnalyzing(false);
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await submitWorkIntake({
        projectKey,
        objective: text,
        explicitOverride: override === "automatic" ? null : override
      });
      setText("");
      setPreview(null);
      setOverride("automatic");
      await onCreated();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Não foi possível submeter a demanda.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className={`composer-backdrop ${open ? "is-open" : ""}`}
      aria-hidden={!open}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <aside className="task-composer" role="dialog" aria-modal="true" aria-labelledby="composer-title">
        <button className="composer-close" onClick={onClose} aria-label="Fechar">
          <Icon name="close" />
        </button>
        <span className="eyebrow">
          <span /> nova missão
        </span>
        <h2 id="composer-title">
          O que colocamos
          <br />
          em movimento?
        </h2>
        <p>Crie uma demanda local. O Maestro classifica o Work Intake, organiza a fila e mantém o projeto isolado.</p>
        <form onSubmit={submit}>
          <label>
            Projeto
            <select value={projectKey} onChange={(event) => setProjectKey(event.target.value)} required>
              {projects.map((project) => (
                <option value={project.key} key={project.key}>
                  @{project.key} · {project.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Demanda
            <textarea
              value={text}
              onChange={(event) => {
                setText(event.target.value);
                if (preview) setPreview(null);
              }}
              placeholder="Ex.: revisar a integração de voz e propor testes de latência"
              minLength={4}
              maxLength={2000}
              required
            />
          </label>
          <div style={{ display: "flex", gap: "8px", alignItems: "center", marginBottom: "12px" }}>
            <button
              type="button"
              className="composer-analyze-btn"
              onClick={handleAnalyze}
              disabled={analyzing || !projectKey || text.trim().length < 4}
              style={{
                padding: "6px 12px",
                background: "var(--surface-2)",
                color: "var(--text-1)",
                border: "1px solid var(--border-color)",
                borderRadius: "4px",
                cursor: "pointer"
              }}
            >
              {analyzing ? "Analisando..." : "Analisar Work Intake"}
            </button>
            <label style={{ margin: 0, fontSize: "0.85rem" }}>
              Sobrescrita:
              <select
                value={override}
                onChange={(e) => setOverride(e.target.value as typeof override)}
                style={{ marginLeft: "6px", padding: "4px 8px" }}
              >
                <option value="automatic">Automático</option>
                <option value="direct_task">Tarefa Direta (direct_task)</option>
                <option value="feature_plan">Plano de Funcionalidade (feature_plan)</option>
                <option value="needs_clarification">Necessita Clarificação (needs_clarification)</option>
              </select>
            </label>
          </div>
          {preview ? (
            <div
              className="work-intake-preview-card"
              style={{
                padding: "12px",
                background: "var(--surface-2)",
                borderRadius: "6px",
                marginBottom: "12px",
                border: "1px solid var(--border-color)"
              }}
            >
              <div style={{ fontWeight: 600, fontSize: "0.9rem", marginBottom: "4px" }}>
                Classificação: <code>{preview.decision.classification}</code> (
                {Math.round(preview.decision.confidence * 100)}% confiança)
              </div>
              <p style={{ margin: 0, fontSize: "0.85rem", color: "var(--text-2)" }}>{preview.explanation}</p>
            </div>
          ) : null}
          <div className="composer-hint">
            <Icon name="shield" />
            <span>O Maestro classifica e isola cada demanda na fila governada.</span>
          </div>
          {error ? <p className="form-error">{error}</p> : null}
          <button className="composer-submit" disabled={submitting || !projectKey || text.trim().length < 4}>
            {submitting ? "Criando..." : "Criar Demanda"}
            <Icon name="arrow" />
          </button>
        </form>
      </aside>
    </div>
  );
}
