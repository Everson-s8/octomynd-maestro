import { FormEvent, KeyboardEvent, MouseEvent, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  DashboardProject,
  executeChatAction,
  fetchChatMessages,
  fetchChatProviders,
  fetchChatThreads,
  GovernedChatAction,
  OperationalChatMessage,
  OperationalChatThread,
  ChatAccessMode,
  GLOBAL_CHAT_PROJECT_KEY,
  ReasoningEffort,
  OperationalChatActivity,
  OperationalChatActivityEvent,
  cancelChat,
  createChatThread,
  deleteChatThread,
  fetchChatActivity,
  fetchChatActivityEvents,
  selectChatProvider,
  sendChatMessage
} from "../api";
import { openExternalUrl } from "../external-links";
import { formatRelative } from "../helpers";
import { Icon } from "./Icon";
import { translate, useI18n } from "../i18n";

export function OperationalChatConsole({
  projects,
  onChanged
}: {
  projects: DashboardProject[];
  onChanged?: () => void;
}) {
  const { locale } = useI18n();
  const [selectedProjectKey, setSelectedProjectKey] = useState<string>(
    projects.length > 0 ? projects[0].key : GLOBAL_CHAT_PROJECT_KEY
  );
  const [threads, setThreads] = useState<OperationalChatThread[]>([]);
  const [selectedThreadId, setSelectedThreadId] = useState<number | null>(null);
  const [messages, setMessages] = useState<OperationalChatMessage[]>([]);
  const [inputText, setInputText] = useState("");
  const [loading, setLoading] = useState(false);
  const [chatActivity, setChatActivity] = useState<OperationalChatActivity>(idleChatActivity());
  const [activityEvents, setActivityEvents] = useState<OperationalChatActivityEvent[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [threadBusy, setThreadBusy] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  const [actionExecuting, setActionExecuting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [accessMode, setAccessMode] = useState<ChatAccessMode>("standard");
  const [chatProviders, setChatProviders] = useState<import("../api").ChatProviderOption[]>([]);
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(null);
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const [selectedEffort, setSelectedEffort] = useState<ReasoningEffort | null>(null);
  const chatBodyRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const deleteConfirmTimer = useRef<number | null>(null);

  useEffect(() => {
    void fetchChatProviders().then(setChatProviders).catch(() => setChatProviders([]));
  }, []);

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
      const nextThreads = await fetchChatThreads(projectKey);
      setThreads(nextThreads);
      setSelectedThreadId((current) => nextThreads.some((thread) => thread.id === current) ? current : nextThreads[0]?.id ?? null);
      const selected = nextThreads[0];
      if (selected) {
        setAccessMode(selected.accessMode);
        setSelectedProviderId(selected.providerId);
        setSelectedModel(selected.model);
        setSelectedEffort(selected.effort);
      } else {
        setSelectedThreadId(null);
        setChatActivity(idleChatActivity());
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : translate("Unable to load conversations."));
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
      setError(err instanceof Error ? err.message : translate("Unable to load chat history."));
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  useEffect(() => {
    if (selectedProjectKey && selectedThreadId !== null) {
      void loadHistory(selectedProjectKey, selectedThreadId);
    }
  }, [selectedProjectKey, selectedThreadId, loadHistory]);

  useEffect(() => {
    let cancelled = false;
    if (!selectedProjectKey || selectedThreadId === null) {
      setChatActivity(idleChatActivity());
      setActivityEvents([]);
      return;
    }

    const refreshActivity = async () => {
      try {
        const [activity, events] = await Promise.all([
          fetchChatActivity(selectedProjectKey, selectedThreadId),
          fetchChatActivityEvents(selectedProjectKey, selectedThreadId, 80)
        ]);
        if (!cancelled) {
          setChatActivity(activity);
          setActivityEvents(events);
        }
      } catch {
        // The history remains usable if an older server does not expose status yet.
      }
    };

    void refreshActivity();
    const timer = window.setInterval(() => void refreshActivity(), 1500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [selectedProjectKey, selectedThreadId]);

  useLayoutEffect(() => {
    const element = chatBodyRef.current;
    if (!element) return;
    const frame = window.requestAnimationFrame(() => {
      element.scrollTop = element.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [messages, loading, historyLoading, activityEvents, selectedThreadId]);

  useLayoutEffect(() => {
    const element = inputRef.current;
    if (!element) return;
    element.style.height = "auto";
    if (element.value) {
      element.style.height = `${Math.min(element.scrollHeight, 180)}px`;
    }
  }, [inputText, selectedThreadId]);

  useEffect(() => () => {
    if (deleteConfirmTimer.current !== null) window.clearTimeout(deleteConfirmTimer.current);
  }, []);

  const selectedThread = threads.find((thread) => thread.id === selectedThreadId) ?? null;
  const isResponding = loading || chatActivity.active;

  const handleCancelChat = async () => {
    if (!selectedThreadId || !chatActivity.active) return;
    try {
      setChatActivity((current) => ({ ...current, phase: "cancelled", detail: translate("Cancellation requested…") }));
      await cancelChat(selectedProjectKey, selectedThreadId);
    } catch (err) {
      setError(err instanceof Error ? err.message : translate("Unable to cancel chat execution."));
    }
  };

  useEffect(() => {
    if (selectedThread) {
      setAccessMode(selectedThread.accessMode);
      setSelectedProviderId(selectedThread.providerId);
      setSelectedModel(selectedThread.model);
      setSelectedEffort(selectedThread.effort);
    }
  }, [selectedThread]);

  const projectLabel = selectedProjectKey === GLOBAL_CHAT_PROJECT_KEY
    ? translate("Maestro (general)")
    : `@${selectedProjectKey}`;

  const handleNewChat = async () => {
    if (!selectedProjectKey || threadBusy) return;
    setThreadBusy(true);
    setError(null);
    try {
      const thread = await createChatThread(selectedProjectKey, translate("New conversation"), accessMode);
      setThreads((current) => [thread, ...current]);
      setSelectedThreadId(thread.id);
      setMessages([]);
      setAccessMode(thread.accessMode);
      window.setTimeout(() => inputRef.current?.focus(), 0);
    } catch (err) {
      setError(err instanceof Error ? err.message : translate("Unable to create a new conversation."));
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
      setError(err instanceof Error ? err.message : translate("Unable to delete the conversation."));
    } finally {
      setConfirmDeleteId(null);
      setThreadBusy(false);
    }
  };

  const handleSend = async (e: FormEvent) => {
    e.preventDefault();
    if (!inputText.trim() || !selectedProjectKey || isResponding) return;

    const userText = inputText.trim();
    setInputText("");
    setLoading(true);
    setError(null);

    let activeThreadId = selectedThreadId;

    try {
      if (activeThreadId === null) {
        const thread = await createChatThread(selectedProjectKey, translate("New conversation"), accessMode);
        activeThreadId = thread.id;
        setThreads((current) => [thread, ...current]);
        setSelectedThreadId(thread.id);
        setAccessMode(thread.accessMode);
        setSelectedProviderId(thread.providerId);
        setSelectedModel(thread.model);
      }

      const tempUserMsg: OperationalChatMessage = {
        id: Date.now(),
        threadId: activeThreadId,
        projectKey: selectedProjectKey,
        surface: "dashboard",
        senderRole: "user",
        messageText: userText,
        createdAt: new Date().toISOString()
      };
      setMessages((prev) => [...prev, tempUserMsg]);

      const chatResponse = await sendChatMessage(selectedProjectKey, userText, activeThreadId, accessMode, locale, selectedProviderId, selectedModel, selectedEffort);
      const startedProjectCommand = accessMode === "full" && (chatResponse.evidence?.commands ?? []).some((command: { command?: string; status?: string }) => (
        command.status === "completed" && /\bnpm(?:\.cmd)?\s+run\s+(?:dev|start|serve|preview)\b/i.test(command.command ?? "")
      ));
      if (startedProjectCommand) {
        const runningProcess = (chatResponse.evidence?.processes ?? []).find((process: { status?: string; url?: string | null }) => process.status === "running" && process.url);
        if (runningProcess?.url) openExternalUrl(runningProcess.url, true);
      }
      await Promise.all([
        loadHistory(selectedProjectKey, activeThreadId),
        loadThreads(selectedProjectKey)
      ]);
      if (onChanged) onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : translate("Unable to send the message."));
    } finally {
      setLoading(false);
      setChatActivity(idleChatActivity());
    }
  };

  const handleProviderSelection = async (providerId: string) => {
    if (!selectedThreadId || threadBusy) return;
    const nextProviderId = providerId || null;
    const provider = chatProviders.find((item) => item.id === nextProviderId);
    const nextModel = nextProviderId ? provider?.currentModel ?? provider?.models?.[0] ?? null : null;
    const nextEffort = nextProviderId ? provider?.control.effort ?? null : null;
    setThreadBusy(true);
    setError(null);
    try {
      const thread = await selectChatProvider(selectedProjectKey, selectedThreadId, nextProviderId, nextModel, nextEffort);
      setThreads((current) => current.map((item) => item.id === thread.id ? thread : item));
      setSelectedProviderId(thread.providerId);
      setSelectedModel(thread.model);
      setSelectedEffort(thread.effort);
    } catch (err) {
      setError(err instanceof Error ? err.message : translate("Unable to select the chat provider."));
    } finally {
      setThreadBusy(false);
    }
  };

  const handleAccessModeSelection = (nextMode: ChatAccessMode) => {
    if (nextMode === "full" && accessMode !== "full") {
      const accepted = window.confirm(
        translate("Full Access lets Maestro execute project commands without asking each time. It does not grant Windows administrator rights, and you can switch back at any time. Continue?")
      );
      if (!accepted) return;
    }
    setAccessMode(nextMode);
  };

  const handleModelSelection = async (model: string) => {
    if (!selectedThreadId || !selectedProviderId || threadBusy) return;
    setThreadBusy(true);
    setError(null);
    try {
      const thread = await selectChatProvider(selectedProjectKey, selectedThreadId, selectedProviderId, model || null, selectedEffort);
      setThreads((current) => current.map((item) => item.id === thread.id ? thread : item));
      setSelectedModel(thread.model);
      setSelectedEffort(thread.effort);
    } catch (err) {
      setError(err instanceof Error ? err.message : translate("Unable to select the chat model."));
    } finally {
      setThreadBusy(false);
    }
  };

  const handleEffortSelection = async (effort: string) => {
    if (!selectedThreadId || !selectedProviderId || threadBusy) return;
    const nextEffort = (effort || null) as ReasoningEffort | null;
    setThreadBusy(true);
    setError(null);
    try {
      const thread = await selectChatProvider(selectedProjectKey, selectedThreadId, selectedProviderId, selectedModel, nextEffort);
      setThreads((current) => current.map((item) => item.id === thread.id ? thread : item));
      setSelectedEffort(thread.effort);
    } catch (err) {
      setError(err instanceof Error ? err.message : translate("Unable to select the reasoning effort."));
    } finally {
      setThreadBusy(false);
    }
  };

  const handleAction = async (action: GovernedChatAction) => {
    if (!selectedProjectKey || actionExecuting) return;

    const requiresConfirmation = [
      "create_task",
      "cancel_task",
      "cancel_feature_plan",
      "resume_goal",
      "unblock_provider",
      "code_change_worktree",
      "code_change_task"
    ].includes(action.type);
    if (requiresConfirmation) {
      const confirmed = window.confirm(
        `${action.label}\n\n${action.description}\n\n${translate("Do you really want to run this action?")}`
      );
      if (!confirmed) return;
    }

    setActionExecuting(action.id);
    setError(null);

    try {
      if (!selectedThreadId) return;
      const actionResult = await executeChatAction(selectedProjectKey, action, selectedThreadId, accessMode, locale);
      if (actionResult.success && action.type === "open_project_browser" && typeof action.payload?.url === "string" && isLocalProjectUrl(action.payload.url)) {
        openExternalUrl(action.payload.url, true);
      }
      await loadHistory(selectedProjectKey, selectedThreadId);
      if (onChanged) onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : translate("Unable to execute the governed action."));
    } finally {
      setActionExecuting(null);
    }
  };

  return (
    <section className="chat-page" id="chat" aria-labelledby="chat-title">
      <div className="chat-page-top">
        <div>
          <div className="chat-eyebrow">{translate("Unified orchestrator")}</div>
          <h1 id="chat-title">{translate("Chat")}</h1>
        </div>
        <label className="chat-project-picker" htmlFor="chat-project-select">
          <span>{translate("Context")}</span>
          <select id="chat-project-select" value={selectedProjectKey} onChange={(e) => setSelectedProjectKey(e.target.value)}>
            <option value={GLOBAL_CHAT_PROJECT_KEY}>{translate("Maestro (general)")}</option>
            {projects.map((p) => (
              <option key={p.key} value={p.key}>@{p.key}</option>
            ))}
          </select>
        </label>
        <label className="chat-access-picker" htmlFor="chat-access-select">
          <span>{translate("Access")}</span>
          <select id="chat-access-select" value={accessMode} onChange={(e) => handleAccessModeSelection(e.target.value as ChatAccessMode)}>
            <option value="read_only">{translate("Read-only")}</option>
            <option value="standard">{translate("Standard")}</option>
            <option value="approval">{translate("Approval per command")}</option>
            <option value="full">{translate("Full Access")}</option>
          </select>
        </label>
        <label className="chat-access-picker" htmlFor="chat-provider-select">
          <span>{translate("Provider")}</span>
          <select id="chat-provider-select" value={selectedProviderId ?? ""} onChange={(e) => void handleProviderSelection(e.target.value)} disabled={!selectedThreadId || threadBusy}>
            <option value="">{translate("Automatic routing")}</option>
            {chatProviders.filter((provider) => provider.capabilities.includes("conversation")).map((provider) => (
              <option key={provider.id} value={provider.id} disabled={provider.health.state !== "ready" || provider.control.mode !== "enabled"}>
                {provider.label} · {provider.health.state === "ready" && provider.control.mode === "enabled" ? translate("ready") : provider.health.state}
              </option>
            ))}
          </select>
        </label>
        {selectedProviderId ? (
          <label className="chat-access-picker" htmlFor="chat-model-select">
            <span>{translate("Model")}</span>
            <select id="chat-model-select" value={selectedModel ?? ""} onChange={(e) => void handleModelSelection(e.target.value)} disabled={threadBusy}>
              <option value="">{translate("Provider default")}</option>
              {(chatProviders.find((provider) => provider.id === selectedProviderId)?.models ?? []).map((model) => (
                <option key={model} value={model}>{model}</option>
              ))}
            </select>
            {selectedModel ? <small className="chat-model-profile">{translate("Model family")}: {translate(modelProcessingLabel(selectedModel))}</small> : null}
          </label>
        ) : null}
        {selectedProviderId && (chatProviders.find((provider) => provider.id === selectedProviderId)?.reasoningEfforts?.length ?? 0) > 0 ? (
          <label className="chat-access-picker" htmlFor="chat-effort-select">
            <span>{translate("Effort")}</span>
            <select id="chat-effort-select" value={selectedEffort ?? ""} onChange={(e) => void handleEffortSelection(e.target.value)} disabled={threadBusy}>
              <option value="">{translate("Provider default")}</option>
              {(chatProviders.find((provider) => provider.id === selectedProviderId)?.reasoningEfforts ?? []).map((effort) => (
                <option key={effort} value={effort}>{effortLabel(effort)}</option>
              ))}
            </select>
          </label>
        ) : null}
      </div>

      <div className="chat-workspace">
          <aside className="chat-threads" aria-label={translate("Conversations")}>
          <div className="chat-threads-header">
            <span>{translate("Conversations")}</span>
            <button type="button" className="chat-new-button" onClick={() => void handleNewChat()} disabled={!selectedProjectKey || threadBusy} title={translate("New chat")} aria-label={translate("Create a new chat")}>
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
                  title={confirmDeleteId === thread.id ? translate("Click again to confirm") : translate("Delete conversation")}
                  aria-label={confirmDeleteId === thread.id ? translate("Confirm deletion") : translate("Delete conversation")}
                  onClick={(event) => void handleDeleteChat(event, thread)}
                >
                  <Icon name={confirmDeleteId === thread.id ? "check" : "trash"} />
                </button>
              </div>
            ))}
          </div>
          {threads.length === 0 ? <div className="chat-thread-empty">{translate("Your first message will create the conversation.")}</div> : null}
        </aside>

        <div className="chat-main-panel">
          <header className="chat-main-header">
            <div>
              <strong>{selectedThread?.title ?? translate("No conversation")}</strong>
              <span>{projectLabel} · {translate("Maestro")}</span>
            </div>
            <span className="chat-context-badge">
              {accessMode === "read_only" ? translate("read-only") : accessMode === "full" ? translate("governed full access") : accessMode === "approval" ? translate("approval per command") : translate("standard access")}
            </span>
          </header>

          {error ? <div className="chat-error" role="alert">{error}</div> : null}

          <div className="chat-body" ref={chatBodyRef} aria-busy={isResponding || historyLoading}>
            {historyLoading ? (
              <div className="chat-loading-history"><span className="chat-spinner" /> {translate("Loading conversation…")}</div>
            ) : messages.length === 0 ? (
              <div className="chat-empty-state">
                <div className="chat-empty-icon"><Icon name="chat" /></div>
                <h2>{translate("New conversation")}</h2>
                <p>{selectedProjectKey === GLOBAL_CHAT_PROJECT_KEY
                  ? translate("Talk to Maestro about providers, projects, and execution.")
                  : translate("Ask about this project, a blocked task, or any implementation question.")} {translate("Type below to start; you do not need to create a chat first.")}</p>
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
                      <span className="chat-message-label">{isUser ? translate("You") : isSystem ? translate("System") : msg.providerId && msg.providerId !== "deterministic_engine" ? `${msg.providerId}${msg.model ? ` · ${msg.model}` : ""}` : translate("Maestro")}</span>
                      <div className="chat-bubble">{msg.messageText}</div>
                      {actions.length > 0 && !isUser ? (
                        <div className="chat-actions">
                          <span>{translate("Available actions")}</span>
                          <div>
                            {actions.map((act) => (
                              <button key={act.id} type="button" disabled={actionExecuting === act.id} onClick={() => void handleAction(act)}>
                                {actionExecuting === act.id ? translate("Executing…") : act.label}
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

            {isResponding ? (
              <div className="chat-thinking" role="status" aria-live="polite">
                <div className="chat-avatar"><Icon name="ghost" /></div>
                <div className="chat-thinking-card">
                  <div>
                    <strong>{chatActivity.phase === "tool" ? translate("Maestro is checking the project") : translate("Maestro is reasoning")}</strong>
                    <small>{chatActivity.detail || translate("Studying the conversation and project evidence…")}</small>
                    <small>{translate("Iteration")} {chatActivity.iteration}/{chatActivity.maxIterations} · {translate("Tools")} {chatActivity.toolCalls}/{chatActivity.maxToolCalls}</small>
                  </div>
                  <div className="chat-thinking-dots"><i /><i /><i /></div>
                  <button type="button" className="chat-cancel-button" onClick={() => void handleCancelChat()} disabled={chatActivity.phase === "cancelled"}>{translate("Cancel")}</button>
                </div>
              </div>
            ) : null}
            {activityEvents.length > 0 ? (
              <div className="chat-process-timeline" aria-label={translate("Maestro process") }>
                <div className="chat-process-title">{translate("Process")}</div>
                {activityEvents.slice(-8).map((event) => (
                  <div className={`chat-process-event phase-${event.phase}`} key={event.id}>
                    <span className="chat-process-dot" aria-hidden="true" />
                    <span>{event.toolName ? `${activityPhaseLabel(event.phase, locale)}: ${event.toolName}` : activityPhaseLabel(event.phase, locale)}</span>
                    <small>{event.detail || translate("State updated")}</small>
                  </div>
                ))}
              </div>
            ) : null}
          </div>

          <div className="chat-suggestions" aria-label={translate("Suggestions")}>
            {[translate("What is happening in the project?"), translate("Why did a task stop?"), translate("Which providers are active?")] .map((suggestion) => (
              <button type="button" key={suggestion} onClick={() => setInputText(suggestion)}>{suggestion}</button>
            ))}
          </div>

          <form className="chat-input" onSubmit={handleSend}>
            <textarea
              ref={inputRef}
              rows={1}
              placeholder={isResponding ? translate("Maestro is responding") : translate("Ask Maestro…")}
              value={inputText}
              onChange={(e) => {
                setInputText(e.target.value);
                e.currentTarget.style.height = "auto";
                e.currentTarget.style.height = `${Math.min(e.currentTarget.scrollHeight, 180)}px`;
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  e.currentTarget.form?.requestSubmit();
                }
              }}
              disabled={isResponding || historyLoading}
              aria-label={translate("Message Maestro")}
            />
            <button type="submit" disabled={isResponding || historyLoading || !inputText.trim()} title={translate("Send message")} aria-label={translate("Send message")}>
              <Icon name="send" />
            </button>
          </form>
        </div>
      </div>
    </section>
  );
}

function idleChatActivity(): OperationalChatActivity {
  return { active: false, startedAt: null, phase: "idle", iteration: 0, maxIterations: 10, toolCalls: 0, maxToolCalls: 14, toolName: null, detail: null };
}

function activityPhaseLabel(phase: OperationalChatActivityEvent["phase"], locale: string): string {
  if (locale !== "pt-BR") return phase;
  const labels: Record<OperationalChatActivityEvent["phase"], string> = {
    idle: "ocioso",
    thinking: "raciocinando",
    tool: "ferramenta",
    finished: "concluído",
    cancelled: "cancelado",
    budget_exhausted: "limite atingido"
  };
  return labels[phase];
}

function isLocalProjectUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && ["localhost", "127.0.0.1", "0.0.0.0"].includes(url.hostname);
  } catch {
    return false;
  }
}

function modelProcessingLabel(model: string): "Fast" | "Balanced" | "Deep" {
  const normalized = model.toLowerCase();
  if (/(?:opus|astra|pro|thinking|reasoning|high)(?:[-_]|$)/.test(normalized)) return "Deep";
  if (/(?:nano|mini|haiku|flash|luna)(?:[-_]|$)/.test(normalized)) return "Fast";
  return "Balanced";
}

function effortLabel(effort: ReasoningEffort): string {
  const labels: Record<ReasoningEffort, string> = {
    minimal: "Minimal",
    low: "Low",
    medium: "Medium",
    high: "High",
    extra_high: "Extra high",
    max: "Max",
    ultra: "Ultra"
  };
  return labels[effort];
}
