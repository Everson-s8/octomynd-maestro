import React, { FormEvent, useEffect, useState } from "react";
import { registerProject } from "../api";

export interface ProjectModalProps {
  open: boolean;
  onClose: () => void;
  onCreated: () => Promise<void> | void;
}

export type OriginMode = "github" | "localremote" | "local";

export function ProjectModal({ open, onClose, onCreated }: ProjectModalProps) {
  const [mode, setMode] = useState<OriginMode>("github");
  const [name, setName] = useState("");
  const [remoteUrl, setRemoteUrl] = useState("");
  const [localPath, setLocalPath] = useState("");
  const [defaultBranch, setDefaultBranch] = useState("");
  const [key, setKey] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) {
      setName("");
      setRemoteUrl("");
      setLocalPath("");
      setDefaultBranch("");
      setKey("");
      setDescription("");
      setError(null);
      setLoading(false);
      setMode("github");
    }
  }, [open]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && open) {
        onClose();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  function deriveKeyAndNameFromUrl(url: string) {
    const trimmed = url.trim();
    if (!trimmed) return;
    const match = /(?:https?:\/\/|git@)(?:www\.)?github\.com[:/](?:[^/]+\/)?([^/]+?)(?:\.git)?\/?$/.exec(trimmed);
    if (match && match[1]) {
      const slug = match[1].toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
      if (!key) setKey(`@${slug}`);
      if (!name) setName(match[1]);
    }
  }

  function deriveKeyAndNameFromPath(p: string) {
    const trimmed = p.trim();
    if (!trimmed) return;
    const parts = trimmed.replace(/\\/g, "/").split("/").filter(Boolean);
    const lastPart = parts[parts.length - 1];
    if (lastPart) {
      const slug = lastPart.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
      if (!key) setKey(`@${slug}`);
      if (!name) setName(lastPart);
    }
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);

    let cleanKey = key.trim().replace(/^@+/, "").toLowerCase();

    // Auto-derive key if empty
    if (!cleanKey) {
      if (mode === "github" && remoteUrl.trim()) {
        const match = /(?:https?:\/\/|git@)(?:www\.)?github\.com[:/](?:[^/]+\/)?([^/]+?)(?:\.git)?\/?$/.exec(remoteUrl.trim());
        if (match && match[1]) {
          cleanKey = match[1].toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
        }
      } else if (localPath.trim()) {
        const parts = localPath.trim().replace(/\\/g, "/").split("/").filter(Boolean);
        const lastPart = parts[parts.length - 1];
        if (lastPart) {
          cleanKey = lastPart.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
        }
      }
    }

    if (!cleanKey) {
      setError("Identificador do projeto (@handle) é obrigatório.");
      return;
    }

    if (!/^[a-z0-9][a-z0-9_-]{1,48}$/.test(cleanKey)) {
      setError("O identificador (@handle) deve ter 2-49 caracteres: letras minúsculas, números, '_' ou '-'.");
      return;
    }

    if (mode === "github" && !remoteUrl.trim()) {
      setError("URL do repositório é obrigatória para clonagem do GitHub.");
      return;
    }

    if ((mode === "localremote" || mode === "local") && !localPath.trim()) {
      setError("Caminho local é obrigatório.");
      return;
    }

    setLoading(true);
    try {
      await registerProject({
        key: cleanKey,
        name: name.trim() || cleanKey,
        path: (mode === "localremote" || mode === "local") ? localPath.trim() : undefined,
        remoteUrl: (mode === "github" || (mode === "localremote" && remoteUrl.trim())) ? remoteUrl.trim() : undefined,
        defaultBranch: defaultBranch.trim() || undefined,
        description: description.trim() || undefined,
        mode
      });
      await onCreated();
      onClose();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Falha ao registrar o projeto.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      className="modal-overlay active"
      id="modal-project"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal" role="dialog" aria-labelledby="modal-project-title">
        <button
          type="button"
          className="modal-close"
          onClick={onClose}
          aria-label="Fechar"
        >
          <svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" /></svg>
        </button>

        <div className="modal-head">
          <div className="modal-eyebrow">Novo habitat</div>
          <h3 id="modal-project-title">Registrar projeto</h3>
          <p>
            Escolha a origem. O Maestro cria worktrees isoladas para cada task — seu diretório principal nunca é tocado diretamente.
          </p>
        </div>

        <form className="modal-body" onSubmit={handleSubmit}>
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
            <label htmlFor="field-project-name">Nome do projeto</label>
            <input
              id="field-project-name"
              type="text"
              placeholder="Ex: Boo Voice Assistant"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={loading}
            />
          </div>

          <div className="mfield">
            <label>Origem</label>
            <div className="origin-tabs">
              <div
                className={`origin-tab ${mode === "github" ? "active" : ""}`}
                onClick={() => setMode("github")}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") setMode("github"); }}
              >
                <svg viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.1 3.29 9.4 7.86 10.93.57.1.79-.25.79-.55v-2.1c-3.2.7-3.87-1.36-3.87-1.36-.53-1.34-1.29-1.7-1.29-1.7-1.05-.72.08-.7.08-.7 1.17.08 1.78 1.2 1.78 1.2 1.03 1.77 2.71 1.26 3.38.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.7 0-1.26.45-2.29 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11 11 0 015.79 0c2.2-1.49 3.18-1.18 3.18-1.18.63 1.6.23 2.76.11 3.05.74.8 1.19 1.83 1.19 3.09 0 4.43-2.7 5.4-5.27 5.69.42.36.78 1.07.78 2.16v3.2c0 .3.21.66.8.55A10.52 10.52 0 0023.5 12c0-6.35-5.15-11.5-11.5-11.5z" />
                </svg>
                <span>Link do GitHub</span>
              </div>
              <div
                className={`origin-tab ${mode === "localremote" ? "active" : ""}`}
                onClick={() => setMode("localremote")}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") setMode("localremote"); }}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <path d="M3 7a2 2 0 012-2h5l2 2h7a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
                  <path d="M14 15l4-4m0 0h-3m3 0v3" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <span>Local + remoto</span>
              </div>
              <div
                className={`origin-tab ${mode === "local" ? "active" : ""}`}
                onClick={() => setMode("local")}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") setMode("local"); }}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <path d="M3 7a2 2 0 012-2h5l2 2h7a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
                </svg>
                <span>Só local</span>
              </div>
            </div>
          </div>

          {/* MODO A: Link GitHub */}
          {mode === "github" && (
            <div className="origin-fields" id="origin-github">
              <div className="mfield">
                <label htmlFor="field-gitremote-a">URL do repositório</label>
                <input
                  id="field-gitremote-a"
                  type="text"
                  placeholder="https://github.com/usuario/repositorio"
                  value={remoteUrl}
                  onChange={(e) => {
                    setRemoteUrl(e.target.value);
                    deriveKeyAndNameFromUrl(e.target.value);
                  }}
                  disabled={loading}
                />
              </div>
              <div className="hint-box">
                <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" /><path d="M12 8v5M12 16h.01" /></svg>
                <span>Clonado com <code>git clone</code> para <code>worktrees/projects/&lt;key&gt;</code>. Branch default detectada automaticamente.</span>
              </div>
            </div>
          )}

          {/* MODO B: Local + vincular remoto */}
          {mode === "localremote" && (
            <div className="origin-fields" id="origin-localremote">
              <div className="mfield">
                <label htmlFor="field-localpath-b">Caminho local</label>
                <div className="path-input">
                  <svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 012-2h5l2 2h7a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" /></svg>
                  <input
                    id="field-localpath-b"
                    type="text"
                    placeholder="/Users/everson/projetos/boo-voice"
                    value={localPath}
                    onChange={(e) => {
                      setLocalPath(e.target.value);
                      deriveKeyAndNameFromPath(e.target.value);
                    }}
                    disabled={loading}
                  />
                </div>
              </div>
              <div className="mfield">
                <label htmlFor="field-gitremote-b">
                  URL remota <span className="opt">opcional</span>
                </label>
                <input
                  id="field-gitremote-b"
                  type="text"
                  placeholder="https://github.com/usuario/repositorio"
                  value={remoteUrl}
                  onChange={(e) => setRemoteUrl(e.target.value)}
                  disabled={loading}
                />
              </div>
              <div className="hint-box">
                <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" /><path d="M12 8v5M12 16h.01" /></svg>
                <span>Se o repositório local não tiver <code>origin</code>, o Maestro adiciona com essa URL. Se já tiver, usa o existente.</span>
              </div>
            </div>
          )}

          {/* MODO C: Só local */}
          {mode === "local" && (
            <div className="origin-fields" id="origin-local">
              <div className="mfield">
                <label htmlFor="field-localpath-c">Caminho local</label>
                <div className="path-input">
                  <svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 012-2h5l2 2h7a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" /></svg>
                  <input
                    id="field-localpath-c"
                    type="text"
                    placeholder="/Users/everson/projetos/boo-voice"
                    value={localPath}
                    onChange={(e) => {
                      setLocalPath(e.target.value);
                      deriveKeyAndNameFromPath(e.target.value);
                    }}
                    disabled={loading}
                  />
                </div>
              </div>
              <div className="hint-box">
                <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" /><path d="M12 8v5M12 16h.01" /></svg>
                <span>Sem remoto configurado. Delivery cai em <code>local://branch</code>.</span>
              </div>
            </div>
          )}

          <div className="mfield-row">
            <div className="mfield">
              <label htmlFor="field-default-branch">Branch padrão <span className="opt">opcional</span></label>
              <input
                id="field-default-branch"
                type="text"
                placeholder="Detectar automaticamente (main, master...)"
                value={defaultBranch}
                onChange={(e) => setDefaultBranch(e.target.value)}
                disabled={loading}
              />
            </div>
            <div className="mfield">
              <label htmlFor="field-project-key">
                Identificador <span className="opt">@handle</span>
              </label>
              <input
                id="field-project-key"
                type="text"
                placeholder="@boo"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                disabled={loading}
              />
            </div>
          </div>

          <div className="mfield">
            <label htmlFor="field-project-desc">
              Descrição <span className="opt">opcional</span>
            </label>
            <textarea
              id="field-project-desc"
              placeholder="Do que se trata este projeto?"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              disabled={loading}
            />
          </div>

          <div className="route-preview">
            <svg viewBox="0 0 24 24" fill="none">
              <path d="M9 11V6a3 3 0 016 0v5m-9 0h12l-1 9H7z" stroke="#e8967a" strokeWidth="1.8" />
            </svg>
            <div className="txt">
              <b>Acesso restrito por padrão</b>
              <span>worktrees isolam execução · nenhuma mutação sem confirmação</span>
            </div>
          </div>

          <div className="modal-actions">
            <button
              type="button"
              className="btn-ghost"
              onClick={onClose}
              disabled={loading}
            >
              Cancelar
            </button>
            <button
              type="submit"
              className="btn-new"
              disabled={loading}
            >
              {loading ? "Registrando..." : "Registrar projeto"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
