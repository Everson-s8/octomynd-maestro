import { FormEvent, useEffect, useState } from "react";
import { DashboardProject, previewWorkIntake, submitWorkIntake, WorkIntakePreviewResult } from "../api";

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
      const result = await submitWorkIntake({
        projectKey,
        objective: text,
        explicitOverride: override === "automatic" ? null : override
      });
      if (result.status === "needs_clarification" || result.createdType === "none") {
        // Only reachable with an explicit "Necessita clarificação" override
        // since F2: automatic classification always creates something now.
        setPreview({ decision: result.decision, explanation: result.explanation });
        setError(
          `Nada foi cadastrado: ${result.explanation} Troque a classificação em Opções avançadas para cadastrar.`
        );
        return;
      }
      setText("");
      setPreview(null);
      setOverride("automatic");
      await onCreated();
      onClose();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Não foi possível submeter a demanda.");
    } finally {
      setSubmitting(false);
    }
  }

  // Same centered-modal contract as ProjectModal (modal-overlay > modal >
  // modal-head/modal-body), so task creation matches the dashboard structure.
  if (!open) return null;
  return (
    <div
      className={`modal-overlay ${open ? "active" : ""}`}
      aria-hidden={!open}
      id="modal-task-composer"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="composer-title">
        <button type="button" className="modal-close" onClick={onClose} aria-label="Fechar">
          <svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" /></svg>
        </button>

        <div className="modal-head">
          <div className="modal-eyebrow">Nova missão</div>
          <h3 id="composer-title">O que colocamos em movimento?</h3>
          <p>
            Crie uma demanda local. O Maestro classifica o Work Intake, organiza a fila e mantém o projeto isolado.
          </p>
        </div>

        <form className="modal-body" onSubmit={submit}>
          {error && (
            <div
              style={{
                padding: "12px 14px",
                borderRadius: "var(--r-sm)",
                background: "var(--err-bg)",
                border: "1px solid rgba(177, 80, 60, 0.3)",
                color: "var(--err)",
                fontSize: "13px",
                marginBottom: "16px"
              }}
              role="alert"
            >
              {error}
            </div>
          )}

          <div className="mfield">
            <label htmlFor="composer-project">Projeto</label>
            <select
              id="composer-project"
              value={projectKey}
              onChange={(event) => setProjectKey(event.target.value)}
              required
            >
              {projects.map((project) => (
                <option value={project.key} key={project.key}>
                  @{project.key} · {project.name}
                </option>
              ))}
            </select>
          </div>

          <div className="mfield">
            <label htmlFor="composer-demand">Demanda</label>
            <textarea
              id="composer-demand"
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
          </div>

          <button
            type="button"
            className="btn-ghost"
            onClick={handleAnalyze}
            disabled={analyzing || !projectKey || text.trim().length < 4}
            style={{ alignSelf: "flex-start", marginBottom: "12px" }}
          >
            {analyzing ? "Analisando..." : "Analisar Work Intake"}
          </button>

          {preview ? (
            <div className="hint-box" role="status">
              <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" /><path d="M12 8v5M12 16h.01" /></svg>
              <span>
                Classificação: <code>{preview.decision.classification}</code> ({Math.round(preview.decision.confidence * 100)}% confiança) — {preview.explanation}
              </span>
            </div>
          ) : null}

          <details style={{ marginBottom: "12px", fontSize: "13px", color: "var(--text-2)" }}>
            <summary style={{ cursor: "pointer", userSelect: "none" }}>Opções avançadas</summary>
            <div className="mfield" style={{ marginTop: "10px" }}>
              <label htmlFor="composer-override">
                Classificação do Work Intake <span className="opt">padrão: automático</span>
              </label>
              <select
                id="composer-override"
                value={override}
                onChange={(e) => setOverride(e.target.value as typeof override)}
              >
                <option value="automatic">Automático</option>
                <option value="direct_task">Tarefa direta</option>
                <option value="feature_plan">Plano de funcionalidade</option>
                <option value="needs_clarification">Necessita clarificação</option>
              </select>
            </div>
          </details>

          <div className="hint-box">
            <svg viewBox="0 0 24 24"><path d="M12 2l8 4v6c0 5-3.4 8.6-8 10-4.6-1.4-8-5-8-10V6z" /></svg>
            <span>O Maestro classifica e isola cada demanda na fila governada.</span>
          </div>

          <div className="modal-actions">
            <button type="button" className="btn-ghost" onClick={onClose} disabled={submitting}>
              Cancelar
            </button>
            <button type="submit" className="btn-new" disabled={submitting || !projectKey || text.trim().length < 4}>
              {submitting ? "Criando..." : "Criar Demanda"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
