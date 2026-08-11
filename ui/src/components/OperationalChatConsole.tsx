import { FormEvent, useCallback, useEffect, useState } from "react";
import {
  DashboardProject,
  executeChatAction,
  fetchChatMessages,
  GovernedChatAction,
  OperationalChatMessage,
  sendChatMessage
} from "../api";
import { formatRelative } from "../helpers";
import { Icon } from "./Icon";
import { SectionHeader } from "./SectionHeader";

export function OperationalChatConsole({
  projects,
  onChanged
}: {
  projects: DashboardProject[];
  onChanged?: () => void;
}) {
  const [selectedProjectKey, setSelectedProjectKey] = useState<string>(
    projects.length > 0 ? projects[0].key : ""
  );
  const [messages, setMessages] = useState<OperationalChatMessage[]>([]);
  const [inputText, setInputText] = useState("");
  const [loading, setLoading] = useState(false);
  const [actionExecuting, setActionExecuting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadHistory = useCallback(async (projectKey: string) => {
    if (!projectKey) return;
    try {
      setError(null);
      const history = await fetchChatMessages(projectKey);
      setMessages(history);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao carregar histórico.");
    }
  }, []);

  useEffect(() => {
    if (selectedProjectKey) {
      void loadHistory(selectedProjectKey);
    }
  }, [selectedProjectKey, loadHistory]);

  const handleSend = async (e: FormEvent) => {
    e.preventDefault();
    if (!inputText.trim() || !selectedProjectKey || loading) return;

    const userText = inputText.trim();
    setInputText("");
    setLoading(true);
    setError(null);

    const tempUserMsg: OperationalChatMessage = {
      id: Date.now(),
      projectKey: selectedProjectKey,
      surface: "dashboard",
      senderRole: "user",
      messageText: userText,
      createdAt: new Date().toISOString()
    };
    setMessages((prev) => [...prev, tempUserMsg]);

    try {
      await sendChatMessage(selectedProjectKey, userText);
      await loadHistory(selectedProjectKey);
      if (onChanged) onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao enviar mensagem.");
    } finally {
      setLoading(false);
    }
  };

  const handleAction = async (action: GovernedChatAction) => {
    if (!selectedProjectKey || actionExecuting) return;

    const requiresConfirmation = [
      "cancel_task",
      "cancel_feature_plan",
      "resume_goal",
      "unblock_provider"
    ].includes(action.type);
    if (requiresConfirmation) {
      const confirmed = window.confirm(
        `${action.label}\n\n${action.description}\n\nDeseja realmente executar esta ação?`
      );
      if (!confirmed) return;
    }

    setActionExecuting(action.id);
    setError(null);

    try {
      await executeChatAction(selectedProjectKey, action);
      await loadHistory(selectedProjectKey);
      if (onChanged) onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao executar ação governada.");
    } finally {
      setActionExecuting(null);
    }
  };

  return (
    <section className="chat-console panel" id="chat" aria-labelledby="chat-title">
      <SectionHeader
        eyebrow="Orquestrador unificado"
        title="Chat Operacional"
        meta={selectedProjectKey ? `@${selectedProjectKey}` : "Selecione um projeto"}
      />

      <div className="chat-toolbar" style={{ display: "flex", gap: "12px", alignItems: "center", marginBottom: "16px" }}>
        <label htmlFor="chat-project-select" style={{ fontSize: "14px", fontWeight: "600", color: "#a0a5b5" }}>
          Projeto:
        </label>
        <select
          id="chat-project-select"
          value={selectedProjectKey}
          onChange={(e) => setSelectedProjectKey(e.target.value)}
          style={{
            padding: "8px 12px",
            borderRadius: "6px",
            background: "#181a20",
            color: "#fff",
            border: "1px solid #2e323e",
            fontSize: "14px"
          }}
        >
          {projects.map((p) => (
            <option key={p.key} value={p.key}>
              @{p.key} ({p.name})
            </option>
          ))}
        </select>
      </div>

      {error ? <div className="error-banner" style={{ marginBottom: "16px", color: "#ff6b6b" }}>{error}</div> : null}

      <div
        className="chat-log"
        style={{
          maxHeight: "380px",
          overflowY: "auto",
          display: "flex",
          flexDirection: "column",
          gap: "12px",
          marginBottom: "16px",
          paddingRight: "8px"
        }}
      >
        {messages.length === 0 ? (
          <div
            className="chat-empty"
            style={{
              padding: "24px",
              textAlign: "center",
              color: "#808595",
              background: "#13151a",
              borderRadius: "8px"
            }}
          >
            <p style={{ margin: 0, fontWeight: "600" }}>Nenhuma mensagem ainda neste projeto.</p>
            <small>Pergunte ao orquestrador por que tasks, goals ou feature plans estão bloqueados.</small>
          </div>
        ) : (
          messages.map((msg) => {
            const isUser = msg.senderRole === "user";
            const isSystem = msg.senderRole === "system";
            let actions: GovernedChatAction[] = [];
            if (msg.actionTaken) {
              try {
                actions = JSON.parse(msg.actionTaken);
              } catch (_) {}
            }

            return (
              <div
                key={msg.id}
                className={`chat-message ${
                  isUser ? "user-message" : isSystem ? "system-message" : "orchestrator-message"
                }`}
                style={{
                  padding: "12px 16px",
                  borderRadius: "8px",
                  background: isUser ? "#1e293b" : isSystem ? "#2d1f3d" : "#172033",
                  border: isUser ? "1px solid #334155" : isSystem ? "1px solid #5b21b6" : "1px solid #1e3a8a",
                  alignSelf: isUser ? "flex-end" : "flex-start",
                  maxWidth: "92%"
                }}
              >
                <div
                  className="chat-message-header"
                  style={{ display: "flex", justifyContent: "space-between", marginBottom: "6px", fontSize: "12px", color: "#94a3b8" }}
                >
                  <strong style={{ color: isUser ? "#38bdf8" : isSystem ? "#c084fc" : "#60a5fa" }}>
                    {isUser ? "Você" : isSystem ? "Sistema" : "Maestro Orchestrator"}
                  </strong>
                  <span>
                    {formatRelative(msg.createdAt)} · {msg.surface}
                  </span>
                </div>
                <div className="chat-message-body">
                  <pre style={{ margin: 0, whiteSpace: "pre-wrap", fontFamily: "inherit", fontSize: "14px", color: "#e2e8f0" }}>
                    {msg.messageText}
                  </pre>
                </div>

                {actions.length > 0 && !isUser ? (
                  <div
                    className="chat-actions"
                    style={{ marginTop: "12px", paddingTop: "8px", borderTop: "1px solid rgba(255,255,255,0.1)" }}
                  >
                    <span style={{ fontSize: "12px", fontWeight: "600", color: "#a7f3d0", display: "block", marginBottom: "8px" }}>
                      Ações governadas recomendadas:
                    </span>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
                      {actions.map((act) => (
                        <button
                          key={act.id}
                          className="action-button"
                          disabled={actionExecuting === act.id}
                          onClick={() => handleAction(act)}
                          style={{
                            padding: "6px 12px",
                            borderRadius: "6px",
                            background: "#059669",
                            color: "#ffffff",
                            border: "none",
                            fontSize: "13px",
                            fontWeight: "600",
                            cursor: actionExecuting === act.id ? "wait" : "pointer"
                          }}
                        >
                          {actionExecuting === act.id ? "Executando..." : act.label}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            );
          })
        )}
      </div>

      <form className="chat-input-form" onSubmit={handleSend} style={{ display: "flex", gap: "10px" }}>
        <input
          type="text"
          placeholder={
            loading
              ? "Orquestrador analisando evidências..."
              : "Pergunte ao Maestro (ex: Por que a Task #12 está bloqueada?)..."
          }
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          disabled={loading || !selectedProjectKey}
          style={{
            flex: 1,
            padding: "10px 14px",
            borderRadius: "6px",
            background: "#181a20",
            border: "1px solid #2e323e",
            color: "#fff",
            fontSize: "14px"
          }}
        />
        <button
          type="submit"
          disabled={loading || !inputText.trim() || !selectedProjectKey}
          className="primary-action"
          style={{ padding: "10px 18px" }}
        >
          <Icon name="send" />
          Enviar
        </button>
      </form>
    </section>
  );
}
