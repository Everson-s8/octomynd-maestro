import { useEffect, useMemo, useState } from "react";
import {
  cancelProviderAuth,
  deleteProvider,
  discoverProviderModels,
  fetchProviderAuth,
  fetchProviderPresets,
  ProviderAuthSession,
  ProviderConnectionMode,
  ProviderPreset,
  registerProvider,
  RegisteredCustomProvider,
  DashboardData,
  startProviderAuth,
  testProviderConnection
} from "../api";

type ProviderFilter = "all" | "account" | "api" | "local";
type ConnectionState = "idle" | "testing" | "discovering" | "saving" | "deleting";

type ProviderDraft = {
  id: string;
  label: string;
  command: string;
  args: string;
  model: string;
  models: string[];
  connectionMode: ProviderConnectionMode;
  endpointUrl: string;
  apiKey: string;
  apiKeyEnv: string;
};

const EMPTY_DRAFT: ProviderDraft = {
  id: "",
  label: "",
  command: "opencode",
  args: "run {prompt} -m {model}",
  model: "",
  models: [],
  connectionMode: "custom",
  endpointUrl: "",
  apiKey: "",
  apiKeyEnv: ""
};

export function ProviderManager({
  agents,
  onChanged
}: {
  agents: DashboardData["agents"];
  onChanged?: () => void;
}) {
  const [presets, setPresets] = useState<ProviderPreset[]>([]);
  const [registered, setRegistered] = useState<RegisteredCustomProvider[]>([]);
  const [selectedPreset, setSelectedPreset] = useState<ProviderPreset | null>(null);
  const [editingProvider, setEditingProvider] = useState<RegisteredCustomProvider | null>(null);
  const [draft, setDraft] = useState<ProviderDraft>(EMPTY_DRAFT);
  const [filter, setFilter] = useState<ProviderFilter>("all");
  const [query, setQuery] = useState("");
  const [state, setState] = useState<ConnectionState>("idle");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [connectionDetail, setConnectionDetail] = useState("");
  const [showCatalog, setShowCatalog] = useState(false);
  const [customModalOpen, setCustomModalOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<RegisteredCustomProvider | null>(null);
  const [authSession, setAuthSession] = useState<ProviderAuthSession | null>(null);

  const load = async () => {
    try {
      const data = await fetchProviderPresets();
      setPresets(data.presets);
      setRegistered(data.registered);
    } catch (cause) {
      setError(readError(cause, "Nao foi possivel carregar os providers."));
    }
  };

  useEffect(() => { void load(); }, []);

  useEffect(() => {
    if (!authSession || authSession.state !== "waiting") return;
    const timer = window.setInterval(() => {
      void fetchProviderAuth(authSession.id).then((session) => {
        setAuthSession(session);
        if (session.state === "connected") setConnectionDetail(session.detail);
        if (session.state === "failed") setError(session.detail);
      }).catch((cause) => setError(readError(cause, "Nao foi possivel acompanhar a autenticacao.")));
    }, 1_200);
    return () => window.clearInterval(timer);
  }, [authSession?.id, authSession?.state]);

  const visiblePresets = useMemo(() => presets.filter((preset) => {
    if (filter !== "all" && preset.category !== filter) return false;
    const haystack = `${preset.label} ${preset.description} ${preset.id}`.toLowerCase();
    return haystack.includes(query.trim().toLowerCase());
  }), [filter, presets, query]);

  const closeModal = () => {
    if (authSession?.state === "waiting") void cancelProviderAuth(authSession.id).catch(() => undefined);
    setSelectedPreset(null);
    setEditingProvider(null);
    setCustomModalOpen(false);
    setDraft(EMPTY_DRAFT);
    setState("idle");
    setError("");
    setConnectionDetail("");
    setAuthSession(null);
  };

  const openPreset = (preset: ProviderPreset) => {
    setSelectedPreset(preset);
    setEditingProvider(null);
    setCustomModalOpen(false);
    setDraft({
      id: preset.id,
      label: preset.label,
      command: preset.command,
      args: preset.args.join(" "),
      model: preset.models[0] ?? "",
      models: preset.models,
      connectionMode: preset.connectionHint,
      endpointUrl: preset.defaultEndpoint ?? "",
      apiKey: "",
      apiKeyEnv: preset.apiKeyEnv ?? preset.envKeys[0] ?? ""
    });
    setError("");
    setConnectionDetail("");
  };

  const openCustom = () => {
    setSelectedPreset(null);
    setEditingProvider(null);
    setCustomModalOpen(true);
    setDraft({ ...EMPTY_DRAFT });
    setError("");
    setConnectionDetail("");
  };

  const openEdit = (provider: RegisteredCustomProvider) => {
    const preset = presets.find((item) => item.id === provider.presetId) ?? null;
    setSelectedPreset(preset);
    setEditingProvider(provider);
    setCustomModalOpen(false);
    setDraft({
      id: provider.id,
      label: provider.label,
      command: provider.command,
      args: provider.args?.join(" ") ?? "",
      model: provider.model ?? provider.models?.[0] ?? "",
      models: provider.models ?? [],
      connectionMode: provider.connectionMode ?? preset?.connectionHint ?? "local",
      endpointUrl: provider.endpointUrl ?? preset?.defaultEndpoint ?? "",
      apiKey: "",
      apiKeyEnv: provider.apiKeyEnv ?? preset?.apiKeyEnv ?? ""
    });
    setError("");
    setConnectionDetail("");
  };

  const testConnection = async () => {
    if (!draft.command.trim() && !draft.endpointUrl.trim()) {
      return setError("Informe o comando CLI ou o endpoint usado pelo provider.");
    }
    setState("testing");
    setError("");
    setConnectionDetail("");
    try {
      const result = await testProviderConnection({
        command: draft.command.trim(),
        args: [],
        presetId: selectedPreset?.id,
        endpointUrl: draft.endpointUrl.trim(),
        apiKey: draft.apiKey,
        apiKeyEnv: draft.apiKeyEnv
      });
      if (!result.ok) throw new Error(result.detail);
      const models = result.models ?? [];
      if (models.length) {
        setDraft((current) => ({
          ...current,
          models,
          model: models.includes(current.model) ? current.model : models[0]
        }));
      }
      setConnectionDetail(result.detail || "Provider conectado e pronto para uso.");
    } catch (cause) {
      setError(readError(cause, "Nao foi possivel validar o provider."));
    } finally {
      setState("idle");
    }
  };

  const discoverModels = async () => {
    if (!draft.endpointUrl.trim() && selectedPreset?.modelDiscovery !== "cli") {
      return setError("Informe um endpoint compativel para descobrir modelos.");
    }
    setState("discovering");
    setError("");
    try {
      const models = await discoverProviderModels({
        presetId: selectedPreset?.id,
        endpointUrl: draft.endpointUrl,
        apiKey: draft.apiKey,
        apiKeyEnv: draft.apiKeyEnv
      });
      if (!models.length) throw new Error("O endpoint respondeu, mas nao anunciou modelos.");
      setDraft((current) => ({ ...current, models, model: models.includes(current.model) ? current.model : models[0] }));
      setConnectionDetail(`${models.length} modelo(s) encontrado(s).`);
    } catch (cause) {
      setError(readError(cause, "Nao foi possivel descobrir os modelos."));
    } finally {
      setState("idle");
    }
  };

  const connectAccount = async () => {
    if (!selectedPreset || selectedPreset.authFlow === "none") return;
    setState("testing");
    setError("");
    setConnectionDetail("");
    try {
      setAuthSession(await startProviderAuth(selectedPreset.id));
    } catch (cause) {
      setError(readError(cause, "Nao foi possivel iniciar a autenticacao."));
    } finally {
      setState("idle");
    }
  };

  const save = async () => {
    if (selectedPreset?.builtIn) {
      setNotice(`${selectedPreset.label} ja faz parte do runtime. Use o painel de prioridade para ativar ou pausar.`);
      closeModal();
      return;
    }
    if (!draft.command.trim()) return setError("Informe o comando usado para executar o provider.");
    const id = sanitizeId(draft.id || draft.label || draft.command);
    if (!id) return setError("Informe um nome valido para o provider.");
    if (draft.connectionMode === "api_key" && !draft.apiKey && !draft.apiKeyEnv) {
      return setError("Informe a API key ou o nome da variavel de ambiente que ja contem a chave.");
    }
    setState("saving");
    setError("");
    try {
      const result = await registerProvider({
        id,
        label: draft.label || id,
        command: draft.command.trim(),
        args: splitArguments(draft.args),
        model: draft.model || null,
        models: draft.models,
        presetId: selectedPreset?.id,
        connectionMode: draft.connectionMode,
        endpointUrl: draft.endpointUrl || null,
        apiKey: draft.apiKey,
        apiKeyEnv: draft.apiKeyEnv
      });
      setRegistered(result.providers);
      setNotice(`${draft.label || id} foi conectado e ativado sem reiniciar o Maestro.`);
      onChanged?.();
      closeModal();
    } catch (cause) {
      setError(readError(cause, "Nao foi possivel salvar o provider."));
    } finally {
      setState("idle");
    }
  };

  const remove = async () => {
    if (!confirmDelete) return;
    setState("deleting");
    setError("");
    try {
      const providers = await deleteProvider(confirmDelete.id);
      setRegistered(providers);
      setNotice(`${confirmDelete.label} foi desconectado. Rotas e fallbacks dependentes foram reparados.`);
      setConfirmDelete(null);
      onChanged?.();
    } catch (cause) {
      setError(readError(cause, "Nao foi possivel remover o provider."));
    } finally {
      setState("idle");
    }
  };

  const modalOpen = Boolean(selectedPreset || editingProvider || customModalOpen);
  const connectedProviders = useMemo(() => {
    const builtIns = presets.filter((preset) => preset.builtIn).map((preset) => {
      const runtimeId = preset.id === "gemini-antigravity" ? "antigravity" : preset.id;
      const agent = agents.find((item) => item.id === runtimeId);
      return {
        key: `preset:${preset.id}`,
        label: preset.label,
        detail: agent?.detail || (agent?.state === "offline" ? "indisponivel" : "CLI disponivel"),
        type: "cloud",
        model: "Padrao do provider",
        active: agent?.state !== "offline",
        color: providerColor(preset.id),
        open: () => openPreset(preset)
      };
    });
    const custom = registered.map((provider) => {
      const preset = presets.find((item) => item.id === provider.presetId);
      const local = preset?.category === "local" || provider.connectionMode === "local";
      return {
        key: `registered:${provider.id}`,
        label: provider.label,
        detail: local ? provider.endpointUrl || "endpoint local" : "conectado",
        type: local ? "local" : "custom",
        model: provider.model || "Padrao do provider",
        active: true,
        color: providerColor(provider.id),
        open: () => openEdit(provider)
      };
    });
    return [...builtIns, ...custom];
  }, [agents, presets, registered]);

  const groupedProviders = {
    Nuvem: connectedProviders.filter((provider) => provider.type === "cloud"),
    Local: connectedProviders.filter((provider) => provider.type === "local"),
    Personalizado: connectedProviders.filter((provider) => provider.type === "custom")
  };

  return (
    <section className="provider-manager">
      {error ? <div className="provider-feedback error" role="alert">{error}</div> : null}
      {notice ? <div className="provider-feedback success">{notice}</div> : null}
      {(["Nuvem", "Local", "Personalizado"] as const).map((group) => groupedProviders[group].length ? (
        <div key={group}>
          <div className="prov-group-lbl">{group}</div>
          {groupedProviders[group].map((provider) => (
            <button type="button" className="prov-card provider-card-button" key={provider.key} onClick={provider.open}>
              <div className="head">
                <div className="av" style={{ background: provider.color }}>{provider.label.slice(0, 1).toUpperCase()}</div>
                <div><b>{provider.label}</b><span><i className="st-dot" />{provider.detail}</span></div>
                <span className="type-tag">{provider.type}</span>
                <span className="pc-chev" aria-hidden="true">›</span>
              </div>
              <div className="prov-uso">
                <div className="prov-uso-l"><div className={`toggle${provider.active ? " on" : ""}`}><i /></div><label>{provider.active ? "ativo" : "indisponivel"}</label></div>
                <span className="model-badge">{provider.model}</span>
              </div>
            </button>
          ))}
        </div>
      ) : null)}
      <button type="button" className="add-provider" onClick={() => setShowCatalog(true)}>
        <div className="plus">+</div><b>Conectar provider</b><span>Local, OpenAI-compatible, ou endpoint próprio</span>
      </button>

      {showCatalog ? (
        <div className="modal-overlay active" onMouseDown={(event) => { if (event.currentTarget === event.target) setShowCatalog(false); }}>
        <div className="modal provider-catalog-panel">
          <div className="provider-catalog-toolbar">
            <div><div className="eyebrow">Novo braço</div><h2>Conectar provider</h2><p>Escolha como o Maestro vai acessar o modelo.</p></div>
            <button type="button" className="modal-close" onClick={() => setShowCatalog(false)} aria-label="Fechar catálogo">×</button>
          </div>
          <div className="provider-search-row">
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar Claude, OpenRouter, Ollama..." />
            <div className="provider-filter-tabs" role="tablist" aria-label="Filtrar providers">
              {(["all", "account", "api", "local"] as ProviderFilter[]).map((item) => (
                <button type="button" className={filter === item ? "active" : ""} onClick={() => setFilter(item)} key={item}>
                  {item === "all" ? "Todos" : item === "account" ? "Contas" : item === "api" ? "API keys" : "Locais"}
                </button>
              ))}
            </div>
          </div>
          <div className="provider-option-list">
            {visiblePresets.map((preset) => (
              <button type="button" className="provider-option" onClick={() => openPreset(preset)} key={preset.id}>
                <span className="provider-option-mark">{preset.label.slice(0, 1)}</span>
                <span className="provider-option-copy"><strong>{preset.label}</strong><small>{preset.description}</small></span>
                <span className="provider-option-method">{preset.builtIn ? "Integrado" : preset.category === "account" ? "Conta" : preset.category === "api" ? "API key" : "Local"}</span>
                <span aria-hidden="true">→</span>
              </button>
            ))}
            {filter === "all" || filter === "local" ? (
              <button type="button" className="provider-option custom" onClick={openCustom}>
                <span className="provider-option-mark">+</span>
                <span className="provider-option-copy"><strong>Endpoint OpenAI-compatible</strong><small>Ollama, vLLM, llama.cpp, proxy ou endpoint proprio.</small></span>
                <span className="provider-option-method">Custom</span>
                <span aria-hidden="true">→</span>
              </button>
            ) : null}
          </div>
        </div></div>
      ) : null}

      {modalOpen ? (
        <div className="provider-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) closeModal(); }}>
          <div className="provider-modal" role="dialog" aria-modal="true" aria-labelledby="provider-modal-title">
            <div className="provider-modal-head">
              <div className="provider-mark large">{(draft.label || "C").slice(0, 1).toUpperCase()}</div>
              <div><span>{editingProvider ? "Configurar provider" : "Nova conexao"}</span><h3 id="provider-modal-title">{draft.label || "Endpoint customizado"}</h3></div>
              <button type="button" className="provider-close" onClick={closeModal} aria-label="Fechar">×</button>
            </div>

            {selectedPreset?.description ? <p className="provider-modal-description">{selectedPreset.description}</p> : null}
            {error ? <div className="provider-feedback error" role="alert">{error}</div> : null}
            {connectionDetail ? <div className="provider-feedback success">{connectionDetail}</div> : null}

            {selectedPreset?.builtIn ? (
              <div className="provider-built-in-note">
                <strong>Provider integrado ao Maestro</strong>
                <p>Ele ja aparece no controle de prioridade. Use as instrucoes abaixo apenas para autenticar o CLI neste computador.</p>
              </div>
            ) : null}

            {draft.connectionMode === "account" ? (
              <div className="provider-setup-block">
                <span className="provider-field-label">Conectar por conta</span>
                <p>O Maestro abre o fluxo oficial e acompanha a autorizacao. As credenciais continuam sob controle do CLI.</p>
                {authSession ? <AuthSessionPanel session={authSession} /> : null}
                <div className="provider-inline-actions">
                  {!authSession && selectedPreset?.authFlow !== "none" ? <button type="button" className="btn-new" onClick={() => void connectAccount()} disabled={state !== "idle"}>{state === "testing" ? "Abrindo..." : "Conectar conta"}</button> : null}
                  {!authSession && selectedPreset?.setupCommand ? <CommandBox command={selectedPreset.setupCommand} /> : null}
                  {!authSession && selectedPreset?.docsUrl ? <a href={selectedPreset.docsUrl} target="_blank" rel="noreferrer" className="btn-ghost">Documentacao oficial</a> : null}
                </div>
              </div>
            ) : null}

            {draft.connectionMode === "api_key" ? (
              <div className="provider-form-grid">
                <label className="provider-field full"><span>API key</span><input type="password" autoComplete="off" value={draft.apiKey} onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })} placeholder={editingProvider ? "Deixe vazio para manter a chave atual" : "Cole a chave aqui"} /></label>
                <label className="provider-field"><span>Variavel protegida</span><input value={draft.apiKeyEnv} onChange={(event) => setDraft({ ...draft, apiKeyEnv: event.target.value.toUpperCase() })} placeholder="PROVIDER_API_KEY" /></label>
                <label className="provider-field"><span>Endpoint</span><input value={draft.endpointUrl} onChange={(event) => setDraft({ ...draft, endpointUrl: event.target.value })} placeholder="https://api.exemplo.com/v1" /></label>
                {selectedPreset?.docsUrl ? <a className="provider-help-link full" href={selectedPreset.docsUrl} target="_blank" rel="noreferrer">Onde obter a API key →</a> : null}
              </div>
            ) : null}

            {draft.connectionMode === "local" || draft.connectionMode === "custom" ? (
              <div className="provider-form-grid">
                <label className="provider-field"><span>Nome</span><input value={draft.label} onChange={(event) => setDraft({ ...draft, label: event.target.value })} placeholder="Meu provider" /></label>
                <label className="provider-field"><span>ID interno</span><input value={draft.id} disabled={Boolean(editingProvider)} onChange={(event) => setDraft({ ...draft, id: sanitizeId(event.target.value) })} placeholder="meu-provider" /></label>
                <label className="provider-field full"><span>Endpoint OpenAI-compatible</span><input value={draft.endpointUrl} onChange={(event) => setDraft({ ...draft, endpointUrl: event.target.value })} placeholder="http://127.0.0.1:11434" /></label>
                <label className="provider-field"><span>Comando CLI</span><input value={draft.command} onChange={(event) => setDraft({ ...draft, command: event.target.value })} placeholder="opencode" /></label>
                <label className="provider-field"><span>Argumentos</span><input value={draft.args} onChange={(event) => setDraft({ ...draft, args: event.target.value })} placeholder="run {prompt} -m {model}" /></label>
              </div>
            ) : null}

            {selectedPreset?.modelDiscovery !== "manual" || !selectedPreset?.builtIn ? (
              <div className="provider-model-block">
                <div className="provider-model-head"><div><span className="provider-field-label">Modelo</span><p>{selectedPreset?.modelDiscovery === "manual" ? "Este CLI nao publica um catalogo confiavel. Use Auto ou informe um ID suportado." : "Catalogo consultado diretamente no provider; nenhum modelo e inventado pelo Maestro."}</p></div>{selectedPreset?.modelDiscovery !== "manual" ? <button type="button" className="btn-ghost" onClick={() => void discoverModels()} disabled={state !== "idle"}>{state === "discovering" ? "Buscando..." : "Buscar modelos reais"}</button> : null}</div>
                {draft.models.length ? (
                  <select value={draft.model} onChange={(event) => setDraft({ ...draft, model: event.target.value })}>{draft.models.map((model) => <option value={model} key={model}>{model}</option>)}</select>
                ) : (
                  <input value={draft.model} onChange={(event) => setDraft({ ...draft, model: event.target.value })} placeholder="Auto ou ID do modelo" />
                )}
              </div>
            ) : null}

            <div className="provider-modal-actions">
              <button type="button" className="btn-ghost" onClick={closeModal}>Cancelar</button>
              {!selectedPreset?.builtIn ? <button type="button" className="btn-ghost" onClick={() => void testConnection()} disabled={state !== "idle"}>{state === "testing" ? "Testando..." : "Testar conexão"}</button> : null}
              <button type="button" className="btn-new" onClick={() => void save()} disabled={state !== "idle"}>{state === "saving" ? "Salvando..." : selectedPreset?.builtIn ? "Entendi" : editingProvider ? "Salvar alteracoes" : "Conectar provider"}</button>
            </div>
          </div>
        </div>
      ) : null}

      {confirmDelete ? (
        <div className="provider-modal-backdrop">
          <div className="provider-confirm-dialog" role="alertdialog" aria-modal="true">
            <div className="provider-mark large">{confirmDelete.label.slice(0, 1)}</div>
            <h3>Desconectar {confirmDelete.label}?</h3>
            <p>O provider sera removido do runtime e de todas as prioridades e fallbacks. Trabalho ativo impede a remocao para evitar perda de progresso.</p>
            <div className="provider-modal-actions"><button type="button" className="btn-ghost" onClick={() => setConfirmDelete(null)}>Cancelar</button><button type="button" className="btn-new danger" onClick={() => void remove()} disabled={state === "deleting"}>{state === "deleting" ? "Removendo..." : "Desconectar"}</button></div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function CommandBox({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(command);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_500);
  };
  return <div className="provider-command-box"><code>$ {command}</code><button type="button" onClick={() => void copy()}>{copied ? "Copiado" : "Copiar"}</button></div>;
}

function AuthSessionPanel({ session }: { session: ProviderAuthSession }) {
  const title = session.state === "waiting"
    ? "Aguardando sua autorizacao"
    : session.state === "connected"
      ? "Conta conectada"
      : session.state === "cancelled"
        ? "Autorizacao cancelada"
        : "Falha na autenticacao";
  return (
    <div className={`provider-auth-session ${session.state}`}>
      <div className="provider-auth-state"><span className="provider-auth-spinner" aria-hidden="true" /><strong>{title}</strong></div>
      <p>{session.detail}</p>
      {session.userCode ? (
        <div className="provider-device-code" aria-label={`Codigo ${session.userCode}`}>
          {session.userCode.split("").map((character, index) => <span className={character === "-" ? "separator" : ""} key={`${character}-${index}`}>{character}</span>)}
        </div>
      ) : null}
      {session.verificationUrl ? <a href={session.verificationUrl} target="_blank" rel="noreferrer" className="provider-help-link">Reabrir pagina de verificacao</a> : null}
    </div>
  );
}

function splitArguments(value: string): string[] {
  return value.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((item) => item.replace(/^"|"$/g, "")) ?? [];
}

function sanitizeId(value: string): string {
  return value.toLowerCase().trim().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

function readError(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback;
}

function providerColor(providerId: string): string {
  if (providerId.includes("claude")) return "#c4622d";
  if (providerId.includes("gemini") || providerId.includes("antigravity")) return "#6f8f6a";
  if (providerId.includes("ollama")) return "#5c6f8f";
  if (providerId.includes("openrouter")) return "#8a6dab";
  if (providerId.includes("openai")) return "#4d7a8c";
  return "#7c634a";
}
