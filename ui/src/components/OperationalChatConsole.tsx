import { FormEvent, KeyboardEvent, MouseEvent, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  DashboardProject,
  executeChatAction,
  fetchChatMessages,
  fetchChatThreads,
  GovernedChatAction,
  OperationalChatMessage,
  OperationalChatThread,
  ChatAccessMode,
  GLOBAL_CHAT_PROJECT_KEY,
  createChatThread,
  deleteChatThread,
  sendChatMessage
} from "../api";
import { formatRelative } from "../helpers";
import { Icon } from "./Icon";

export function OperationalChatConsole({
  projects,
  onChanged
}: {
  projects: DashboardProject[];
  onChanged?: () => void;
}) {
  const [selectedProjectKey, setSelectedProjectKey] = useState<string>(
    projects.length > 0 ? projects[0].key : GLOBAL_CHAT_PROJECT_KEY
  );
  const [threads, setThreads] = useState<OperationalChatThread[]>([]);
  const [selectedThreadId, setSelectedThreadId] = useState<number | null>(null);
  const [messages, setMessages] = useState<OperationalChatMessage[]>([]);
  const [inputText, setInputText] = useState("");
  const [loading, setLoading] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [threadBusy, setThreadBusy] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  const [actionExecuting, setActionExecuting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [accessMode, setAccessMode] = useState<ChatAccessMode>("standard");
  const chatBodyRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const deleteConfirmTimer = useRef<number | null>(null);

  useEffect(() => {
    setSelectedProjectKey((current) => {
      if (projects.length === 0) return GLOBAL_CHAT_PROJECT_KEY;
      return current === GLOBAL_CHAT_PROJECT_KEY || projects.some((project) => project.key === current) ? current : projects[0].key;
    });
  }, [projects]);

  const loadThreads = useCallback(async (projectKey: string) => {
    if (!projectKey) return;
    try {
      setError(null);
      let nextThreads = await fetchChatThreads(projectKey);
      if (nextThreads.length === 0) {
        nextThreads = [await createChatThread(projectKey)];
      }
      setThreads(nextThreads);
      setSelectedThreadId((current) => nextThreads.some((thread) => thread.id === current) ? current : nextThreads[0].id);
      const selected = nextThreads.find((thread) => thread.id === selectedThreadId) ?? nextThreads[0];
      setAccessMode(selected.accessMode);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao carregar as conversas.");
    }
  }, []);

  useEffect(() => {
    if (selectedProjectKey) {
      setSelectedThreadId(null);
      setMessages([]);
      void loadThreads(selectedProjectKey);
    }
  }, [selectedProjectKey, loadThreads]);

  const loadHistory = useCallback(async (projectKey: string, threadId: number) => {
    try {
      setHistoryLoading(true);
      setError(null);
      setMessages(await fetchChatMessages(projectKey, 100, threadId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao carregar o histórico.");
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  useEffect(() => {
    if (selectedProjectKey && selectedThreadId !== null) {
      void loadHistory(selectedProjectKey, selectedThreadId);
    }
  }, [selectedProjectKey, selectedThreadId, loadHistory]);

  useLayoutEffect(() => {
    const element = chatBodyRef.current;
    if (!element) return;
    const frame = window.requestAnimationFrame(() => {
      element.scrollTop = element.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [messages, loading, historyLoading, selectedThreadId]);

  useEffect(() => () => {
    if (deleteConfirmTimer.current !== null) window.clearTimeout(deleteConfirmTimer.current);
  }, []);

  const selectedThread = threads.find((thread) => thread.id === selectedThreadId) ?? null;

  useEffect(() => {
    if (selectedThread) setAccessMode(selectedThread.accessMode);
  }, [selectedThread]);

  const projectLabel = selectedProjectKey === GLOBAL_CHAT_PROJECT_KEY
    ? "Maestro (geral)"
    : `@${selectedProjectKey}`;

  const handleNewChat = async () => {
    if (!selectedProjectKey || threadBusy) return;
    setThreadBusy(true);
    setError(null);
    try {
      const thread = await createChatThread(selectedProjectKey, "Nova conversa", accessMode);
      setThreads((current) => [thread, ...current]);
      setSelectedThreadId(thread.id);
      setMessages([]);
      setAccessMode(thread.accessMode);
      window.setTimeout(() => inputRef.current?.focus(), 0);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao criar uma nova conversa.");
    } finally {
      setThreadBusy(false);
    }
  };

  const handleDeleteChat = async (event: MouseEvent | KeyboardEvent, thread: OperationalChatThread) => {
    event.stopPropagation();
    if (confirmDeleteId !== thread.id) {
      setConfirmDeleteId(thread.id);
      if (deleteConfirmTimer.current !== null) window.clearTimeout(deleteConfirmTimer.current);
      deleteConfirmTimer.current = window.setTimeout(() => setConfirmDeleteId(null), 2500);
      return;
    }

    setThreadBusy(true);
    setError(null);
    try {
      await deleteChatThread(selectedProjectKey, thread.id);
      const remaining = threads.filter((item) => item.id !== thread.id);
      setThreads(remaining);
      if (selectedThreadId === thread.id) {
        setSelectedThreadId(remaining[0]?.id ?? null);
        setMessages([]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao excluir a conversa.");
    } finally {
      setConfirmDeleteId(null);
      setThreadBusy(false);
    }
  };

  const handleSend = async (e: FormEvent) => {
    e.preventDefault();
    if (!inputText.trim() || !selectedProjectKey || !selectedThreadId || loading) return;

    const userText = inputText.trim();
    setInputText("");
    setLoading(true);
    setError(null);

    const tempUserMsg: OperationalChatMessage = {
      id: Date.now(),
      threadId: selectedThreadId,
      projectKey: selectedProjectKey,
      surface: "dashboard",
      senderRole: "user",
      messageText: userText,
      createdAt: new Date().toISOString()
    };
    setMessages((prev) => [...prev, tempUserMsg]);

    try {
      await sendChatMessage(selectedProjectKey, userText, selectedThreadId, accessMode);
      await Promise.all([
        loadHistory(selectedProjectKey, selectedThreadId),
        loadThreads(selectedProjectKey)
      ]);
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
      "create_task",
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
      if (!selectedThreadId) return;
      await executeChatAction(selectedProjectKey, action, selectedThreadId, accessMode);
      await loadHistory(selectedProjectKey, selectedThreadId);
      if (onChanged) onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao executar ação governada.");
    } finally {
      setActionExecuting(null);
    }
  };

  return (
    <section className="chat-page" id="chat" aria-labelledby="chat-title">
      <div className="chat-page-top">
        <div>
          <div className="chat-eyebrow">Orquestrador unificado</div>
          <h1 id="chat-title">Chat</h1>
        </div>
        <label className="chat-project-picker" htmlFor="chat-project-select">
          <span>Contexto</span>
          <select id="chat-project-select" value={selectedProjectKey} onChange={(e) => setSelectedProjectKey(e.target.value)}>
            <option value={GLOBAL_CHAT_PROJECT_KEY}>Maestro (geral)</option>
            {projects.map((p) => (
              <option key={p.key} value={p.key}>@{p.key}</option>
            ))}
          </select>
        </label>
        <label className="chat-access-picker" htmlFor="chat-access-select">
          <span>Acesso</span>
          <select id="chat-access-select" value={accessMode} onChange={(e) => setAccessMode(e.target.value as ChatAccessMode)}>
            <option value="read_only">Somente leitura</option>
            <option value="standard">Standard</option>
            <option value="full">Full Access</option>
          </select>
        </label>
      </div>

      <div className="chat-workspace">
        <aside className="chat-threads" aria-label="Conversas">
          <div className="chat-threads-header">
            <span>Conversas</span>
            <button type="button" className="chat-new-button" onClick={() => void handleNewChat()} disabled={!selectedProjectKey || threadBusy} title="Novo chat" aria-label="Criar novo chat">
              <Icon name="plus" />
            </button>
          </div>
          <div className="chat-thread-list">
            {threads.map((thread) => (
              <div
                className={`chat-thread ${thread.id === selectedThreadId ? "is-active" : ""}`}
                key={thread.id}
              >
                <button type="button" className="chat-thread-select" onClick={() => setSelectedThreadId(thread.id)}>
                  <span className="chat-thread-info">
                    <strong>{thread.title}</strong>
                    <small>{formatRelative(thread.updatedAt)}</small>
                  </span>
                </button>
                <button
                  type="button"
                  className={`chat-thread-delete ${confirmDeleteId === thread.id ? "is-confirm" : ""}`}
                  title={confirmDeleteId === thread.id ? "Clique novamente para confirmar" : "Excluir conversa"}
                  aria-label={confirmDeleteId === thread.id ? "Confirmar exclusão" : "Excluir conversa"}
                  onClick={(event) => void handleDeleteChat(event, thread)}
                >
                  <Icon name={confirmDeleteId === thread.id ? "check" : "trash"} />
                </button>
              </div>
            ))}
          </div>
          {threads.length === 0 ? <div className="chat-thread-empty">Clique em + para iniciar uma conversa.</div> : null}
        </aside>

        <div className="chat-main-panel">
          <header className="chat-main-header">
            <div>
              <strong>{selectedThread?.title ?? "Nenhuma conversa"}</strong>
              <span>{projectLabel} · Maestro</span>
            </div>
            <span className="chat-context-badge">
              {accessMode === "read_only" ? "somente leitura" : accessMode === "full" ? "acesso amplo governado" : "acesso padrão"}
            </span>
          </header>

          {error ? <div className="chat-error" role="alert">{error}</div> : null}

          <div className="chat-body" ref={chatBodyRef} aria-busy={loading || historyLoading}>
            {historyLoading ? (
              <div className="chat-loading-history"><span className="chat-spinner" /> Carregando conversa…</div>
            ) : messages.length === 0 ? (
              <div className="chat-empty-state">
                <div className="chat-empty-icon"><Icon name="chat" /></div>
                <h2>Nova conversa</h2>
                <p>{selectedProjectKey === GLOBAL_CHAT_PROJECT_KEY
                  ? "Converse com o Maestro sobre providers, projetos e execução."
                  : "Pergunte sobre este projeto, uma task bloqueada ou qualquer dúvida de implementação."}</p>
              </div>
            ) : (
              messages.map((msg) => {
                const isUser = msg.senderRole === "user";
                const isSystem = msg.senderRole === "system";
                let actions: GovernedChatAction[] = [];
                if (msg.actionTaken && accessMode !== "read_only") {
                  try {
                    const parsed: unknown = JSON.parse(msg.actionTaken);
                    actions = Array.isArray(parsed) ? parsed as GovernedChatAction[] : [];
                    if (accessMode === "standard") {
                      actions = actions.filter((action) => !["cancel_task", "cancel_feature_plan"].includes(action.type));
                    }
                  } catch (_) { /* legacy action text */ }
                }

                return (
                  <div key={msg.id} className={`chat-message ${isUser ? "is-user" : isSystem ? "is-system" : "is-maestro"}`}>
                    <div className="chat-avatar"><Icon name={isUser ? "hand" : isSystem ? "shield" : "ghost"} /></div>
                    <div className="chat-message-content">
                      <span className="chat-message-label">{isUser ? "Você" : isSystem ? "Sistema" : "Maestro"}</span>
                      <div className="chat-bubble">{msg.messageText}</div>
                      {actions.length > 0 && !isUser ? (
                        <div className="chat-actions">
                          <span>Ações disponíveis</span>
                          <div>
                            {actions.map((act) => (
                              <button key={act.id} type="button" disabled={actionExecuting === act.id} onClick={() => void handleAction(act)}>
                                {actionExecuting === act.id ? "Executando…" : act.label}
                              </button>
                            ))}
                          </div>
                        </div>
                      ) : null}
                    </div>
                  </div>
                );
              })
            )}

            {loading ? (
              <div className="chat-thinking" role="status" aria-live="polite">
                <div className="chat-avatar"><Icon name="ghost" /></div>
                <div className="chat-thinking-card">
                  <span>Maestro está respondendo</span>
                  <div className="chat-thinking-dots"><i /><i /><i /></div>
                </div>
              </div>
            ) : null}
          </div>

          <div className="chat-suggestions" aria-label="Sugestões">
            {["O que está acontecendo no projeto?", "Por que uma task parou?", "Quais providers estão ativos?"] .map((suggestion) => (
              <button type="button" key={suggestion} onClick={() => setInputText(suggestion)}>{suggestion}</button>
            ))}
          </div>

          <form className="chat-input" onSubmit={handleSend}>
            <input
              ref={inputRef}
              type="text"
              placeholder={loading ? "Maestro está respondendo…" : "Pergunte ao Maestro…"}
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              disabled={loading || historyLoading || !selectedThreadId}
              aria-label="Mensagem para o Maestro"
            />
            <button type="submit" disabled={loading || historyLoading || !inputText.trim() || !selectedThreadId} title="Enviar mensagem" aria-label="Enviar mensagem">
              <Icon name="send" />
            </button>
          </form>
        </div>
      </div>
    </section>
  );
}
