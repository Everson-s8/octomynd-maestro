import { useEffect, useMemo, useState } from "react";
import {
  cancelProviderAuth,
  deleteProvider,
  fetchProviderAuth,
  fetchProviderPresets,
  fetchProviderPolicy,
  ProviderAuthSession,
  ProviderPolicySnapshot,
  ProviderPreset,
  registerProvider,
  RegisteredCustomProvider,
  DashboardData,
  startProviderAuth,
  testProviderConnection,
  updateProviderControl
} from "../api";

type ConnectStep = "method" | "list-apikey" | "list-account" | "apikey" | "account";

type ConnectedProvider = {
  key: string;
  providerId: string;
  label: string;
  detail: string;
  type: "account" | "api" | "local";
  model: string;
  active: boolean;
  connected: boolean;
  paused: boolean;
  color: string;
  models: string[];
  registeredProvider: RegisteredCustomProvider | null;
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
  const [policy, setPolicy] = useState<(ProviderPolicySnapshot & { availableModels?: Record<string, string[]> }) | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const [detailKey, setDetailKey] = useState<string | null>(null);
  const [modelQuery, setModelQuery] = useState("");
  const [dangerConfirm, setDangerConfirm] = useState(false);
  const [detailBusy, setDetailBusy] = useState(false);

  const [wizardOpen, setWizardOpen] = useState(false);
  const [wizardStep, setWizardStep] = useState<ConnectStep>("method");
  const [wizardHistory, setWizardHistory] = useState<ConnectStep[]>([]);
  const [wizardPreset, setWizardPreset] = useState<ProviderPreset | null>(null);
  const [wizardCustomEndpoint, setWizardCustomEndpoint] = useState(false);
  const [apiKeyValue, setApiKeyValue] = useState("");
  const [baseUrlValue, setBaseUrlValue] = useState("");
  const [customLabel, setCustomLabel] = useState("");
  const [wizardBusy, setWizardBusy] = useState(false);
  const [authSession, setAuthSession] = useState<ProviderAuthSession | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied">("idle");

  const load = async () => {
    try {
      const [presetData, policyData] = await Promise.all([fetchProviderPresets(), fetchProviderPolicy()]);
      setPresets(presetData.presets);
      setRegistered(presetData.registered);
      setPolicy(policyData);
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
        if (session.state === "failed") setError(session.detail);
      }).catch((cause) => setError(readError(cause, "Nao foi possivel acompanhar a autenticacao.")));
    }, 1_200);
    return () => window.clearInterval(timer);
  }, [authSession?.id, authSession?.state]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      if (wizardOpen) closeWizard();
      else if (detailKey) closeDetail();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wizardOpen, detailKey]);

  const connectedProviders = useMemo<ConnectedProvider[]>(() => {
    // Built-in providers that are paused (control.mode === "disabled") are hidden
    // from the list — a removed/paused provider disappears instead of showing as
    // "indisponivel". Paused built-ins can be re-enabled via "Conectar provider".
    const builtIns = presets
      .filter((preset) => preset.builtIn)
      .map((preset) => {
        const runtimeId =
          preset.id === "gemini" || preset.id === "gemini-antigravity" ? "antigravity" : preset.id;
        const agent = agents.find((item) => item.id === runtimeId);
        const control = policy?.controls.find((item) => item.providerId === runtimeId);
        const models = policy?.availableModels?.[runtimeId] ?? preset.models ?? [];
        const activeModel = control?.model || models[0] || "";
        const paused = control?.mode === "disabled";
        return {
          key: `preset:${preset.id}`,
          providerId: runtimeId,
          label: preset.label,
          detail: agent?.detail || (agent?.state === "offline" ? "indisponivel" : "CLI disponivel"),
          type: (preset.category === "api" ? "api" : preset.category === "local" ? "local" : "account") as "account" | "api" | "local",
          model: activeModel || "Padrao do provider",
          active: !paused && agent?.state !== "offline",
          connected: models.length > 0,
          paused,
          color: providerColor(preset.id),
          models,
          registeredProvider: null
        };
      })
      .filter((p) => !p.paused);
    const custom = registered.map((provider) => {
      const preset = presets.find((item) => item.id === provider.presetId);
      const local = preset?.category === "local" || provider.connectionMode === "local";
      const category = preset?.category ?? (local ? "local" : "api");
      const control = policy?.controls.find((item) => item.providerId === provider.id);
      const models = policy?.availableModels?.[provider.id] ?? provider.models ?? [];
      const activeModel = control?.model || provider.model || models[0] || "";
      return {
        key: `registered:${provider.id}`,
        providerId: provider.id,
        label: provider.label,
        detail: local ? provider.endpointUrl || "endpoint local" : "conectado",
        type: (category === "local" ? "local" : category === "account" ? "account" : "api") as "account" | "api" | "local",
        model: activeModel || "Padrao do provider",
        active: true,
        connected: models.length > 0,
        paused: false,
        color: providerColor(provider.id),
        models,
        registeredProvider: provider
      };
    });
    return [...builtIns, ...custom];
  }, [agents, presets, registered, policy]);

  const groupedProviders = {
    Conta: connectedProviders.filter((provider) => provider.type === "account"),
    API: connectedProviders.filter((provider) => provider.type === "api"),
    Local: connectedProviders.filter((provider) => provider.type === "local")
  };
  const groupLabels: Record<string, "Conta" | "API" | "Local"> = { Conta: "Conta", API: "API", Local: "Local" };

  const detailProvider = connectedProviders.find((provider) => provider.key === detailKey) ?? null;

  const filteredModels = useMemo(() => {
    if (!detailProvider) return [];
    const q = modelQuery.trim().toLowerCase();
    return q ? detailProvider.models.filter((model) => model.toLowerCase().includes(q)) : detailProvider.models;
  }, [detailProvider, modelQuery]);

  const openDetail = (key: string) => {
    setDetailKey(key);
    setModelQuery("");
    setDangerConfirm(false);
    setError("");
  };

  const closeDetail = () => {
    setDetailKey(null);
    setDangerConfirm(false);
    setModelQuery("");
  };

  const selectModel = async (model: string) => {
    if (!detailProvider) return;
    setDetailBusy(true);
    setError("");
    try {
      const control = policy?.controls.find((item) => item.providerId === detailProvider.providerId);
      await updateProviderControl(detailProvider.providerId, {
        mode: control?.mode ?? "enabled",
        fallbackEnabled: control?.fallbackEnabled ?? true,
        model
      });
      await load();
      onChanged?.();
    } catch (cause) {
      setError(readError(cause, "Nao foi possivel atualizar o modelo."));
    } finally {
      setDetailBusy(false);
    }
  };

  const removeProvider = async () => {
    if (!detailProvider) return;
    setDetailBusy(true);
    setError("");
    try {
      if (detailProvider.registeredProvider) {
        const providers = await deleteProvider(detailProvider.registeredProvider.id);
        setRegistered(providers);
        setNotice(`${detailProvider.label} foi desconectado. Rotas e fallbacks dependentes foram reparados.`);
      } else {
        const control = policy?.controls.find((item) => item.providerId === detailProvider.providerId);
        await updateProviderControl(detailProvider.providerId, {
          mode: "disabled",
          fallbackEnabled: control?.fallbackEnabled ?? false
        });
        setNotice(`${detailProvider.label} foi pausado e removido das rotas.`);
        await load();
      }
      onChanged?.();
      closeDetail();
    } catch (cause) {
      setError(readError(cause, "Nao foi possivel desconectar o provider."));
    } finally {
      setDetailBusy(false);
    }
  };

  const resetWizard = () => {
    setWizardStep("method");
    setWizardHistory([]);
    setWizardPreset(null);
    setWizardCustomEndpoint(false);
    setApiKeyValue("");
    setBaseUrlValue("");
    setCustomLabel("");
    setAuthSession(null);
    setCopyState("idle");
    setError("");
  };

  const openWizard = () => {
    resetWizard();
    setWizardOpen(true);
  };

  const closeWizard = () => {
    if (authSession?.state === "waiting") void cancelProviderAuth(authSession.id).catch(() => undefined);
    setWizardOpen(false);
    resetWizard();
  };

  const gotoStep = (step: ConnectStep) => {
    setWizardHistory((history) => [...history, wizardStep]);
    setWizardStep(step);
  };

  const backStep = () => {
    setWizardHistory((history) => {
      if (!history.length) return history;
      setWizardStep(history[history.length - 1]);
      return history.slice(0, -1);
    });
  };

  const openApiKeyPreset = (preset: ProviderPreset) => {
    setWizardPreset(preset);
    setWizardCustomEndpoint(false);
    setApiKeyValue("");
    setBaseUrlValue(preset.defaultEndpoint ?? "");
    gotoStep("apikey");
  };

  const openApiKeyCustom = () => {
    setWizardPreset(null);
    setWizardCustomEndpoint(true);
    setApiKeyValue("");
    setBaseUrlValue("");
    setCustomLabel("");
    gotoStep("apikey");
  };

  const openAccountPreset = (preset: ProviderPreset) => {
    setWizardPreset(preset);
    setAuthSession(null);
    setCopyState("idle");
    gotoStep("account");
  };

  const connectApiKey = async () => {
    const preset = wizardPreset;
    if (preset?.builtIn) {
      setNotice(`${preset.label} ja faz parte do runtime. Use o painel de prioridade para ativar ou pausar.`);
      closeWizard();
      return;
    }
    if (!apiKeyValue.trim()) return setError("Informe a API key.");
    const label = preset?.label ?? (customLabel.trim() || "Endpoint customizado");
    const id = sanitizeId(preset?.id ?? customLabel ?? label);
    if (!id) return setError("Informe um nome valido para o provider.");
    setWizardBusy(true);
    setError("");
    try {
      const result = await registerProvider({
        id,
        label,
        command: preset?.command ?? "opencode",
        args: preset?.args ?? [],
        model: preset?.models?.[0] ?? null,
        presetId: preset?.id,
        connectionMode: "api_key",
        endpointUrl: baseUrlValue.trim() || preset?.defaultEndpoint || null,
        apiKey: apiKeyValue,
        apiKeyEnv: preset?.apiKeyEnv ?? undefined
      });
      setRegistered(result.providers);
      setNotice(`${label} foi conectado e ativado sem reiniciar o Maestro.`);
      await load();
      onChanged?.();
      closeWizard();
    } catch (cause) {
      setError(readError(cause, "Nao foi possivel conectar o provider."));
    } finally {
      setWizardBusy(false);
    }
  };

  const confirmAccountLogin = async () => {
    const preset = wizardPreset;
    if (!preset) return;
    // Built-in providers (e.g. gemini/antigravity) can't be re-registered, but
    // we still confirm the CLI is present/authenticated and show a success
    // state — otherwise the button does nothing visible and confuses the user.
    if (preset.builtIn) {
      setWizardBusy(true);
      setError("");
      try {
        const testResult = await testProviderConnection({
          command: preset.command,
          args: preset.authStatusArgs && preset.authStatusArgs.length > 0 ? preset.authStatusArgs : [],
          presetId: preset.id
        });
        if (!testResult.ok) throw new Error(testResult.detail || "CLI nao encontrado ou nao autenticado.");
        setNotice(`${preset.label} esta pronto. Use o painel de prioridade para definir a ordem (ja faz parte do runtime).`);
        await load();
        onChanged?.();
        closeWizard();
      } catch (cause) {
        setError(readError(cause, "Nao foi possivel confirmar a conexao."));
      } finally {
        setWizardBusy(false);
      }
      return;
    }
    setWizardBusy(true);
    setError("");
    try {
      // Probe the CLI's authentication status, not its execution args. Using
      // preset.args (e.g. copilot's ["copilot","suggest","{prompt}"]) would run a
      // wrong command and fail with "Falha ao executar gh". Use authStatusArgs
      // (e.g. gh auth status) which actually confirms the logged-in account.
      const testResult = await testProviderConnection({
        command: preset.command,
        args: preset.authStatusArgs && preset.authStatusArgs.length > 0 ? preset.authStatusArgs : preset.args,
        presetId: preset.id
      });
      if (!testResult.ok) throw new Error(testResult.detail || "Login ainda nao detectado. Verifique o terminal e tente novamente.");
      const result = await registerProvider({
        id: preset.id,
        label: preset.label,
        command: preset.command,
        args: preset.args,
        model: testResult.models?.[0] ?? preset.models[0] ?? null,
        models: testResult.models ?? preset.models,
        presetId: preset.id,
        connectionMode: "account"
      });
      setRegistered(result.providers);
      setNotice(`${preset.label} foi conectado e ativado sem reiniciar o Maestro.`);
      await load();
      onChanged?.();
      closeWizard();
    } catch (cause) {
      setError(readError(cause, "Nao foi possivel confirmar o login."));
    } finally {
      setWizardBusy(false);
    }
  };

  const handleAccountPrimary = async () => {
    const preset = wizardPreset;
    if (!preset) return;
    // Providers with a real CLI login flow (device-code or terminal with auth
    // args) automate the login through the backend broker: spawn the CLI, open
    // the browser/terminal, poll until connected. Providers whose CLI has no
    // login subcommand (e.g. gemini/antigravity, which authenticates on its own)
    // skip the automated login and fall back to a probe + register.
    const hasAutoLogin = preset.authFlow && preset.authFlow !== "none" && (preset.authArgs?.length ?? 0) > 0;
    if (hasAutoLogin && (!authSession || authSession.state !== "connected")) {
      if (authSession?.state === "waiting") return;
      setWizardBusy(true);
      setError("");
      try {
        setAuthSession(await startProviderAuth(preset.id));
      } catch (cause) {
        setError(readError(cause, "Nao foi possivel iniciar a autenticacao."));
      } finally {
        setWizardBusy(false);
      }
      return;
    }
    await confirmAccountLogin();
  };

  const accountPrimaryLabel = () => {
    if (!wizardPreset) return "Ja fiz login";
    const hasAutoLogin = wizardPreset.authFlow && wizardPreset.authFlow !== "none" && (wizardPreset.authArgs?.length ?? 0) > 0;
    if (hasAutoLogin) {
      if (!authSession) return wizardBusy ? "Abrindo..." : "Conectar conta";
      if (authSession.state === "waiting") return "Aguardando autorizacao...";
      if (authSession.state === "connected") return wizardBusy ? "Concluindo..." : "Concluir conexao";
      return "Tentar novamente";
    }
    return wizardBusy ? "Verificando..." : "Ja fiz login";
  };

  const copyCommand = async (command: string) => {
    try {
      await navigator.clipboard.writeText(command);
      setCopyState("copied");
      window.setTimeout(() => setCopyState("idle"), 1_800);
    } catch {
      /* clipboard unavailable */
    }
  };

  const wizardCopy = (): { title: string; desc: string } => {
    switch (wizardStep) {
      case "method":
        return { title: "Conectar provider", desc: "Como voce quer autenticar? A forma de conexao depende do provider escolhido." };
      case "list-apikey":
        return { title: "Via chave de API", desc: "Escolha o provider que voce quer conectar com API key." };
      case "list-account":
        return { title: "Via conta (CLI)", desc: "Escolha o provider — o login acontece pela CLI oficial dele." };
      case "apikey": {
        const name = wizardPreset?.label ?? "Endpoint customizado";
        return { title: name, desc: `Cole a chave de API para conectar ${name}.` };
      }
      case "account": {
        const name = wizardPreset?.label ?? "este provider";
        const autoLogin = wizardPreset?.authFlow && wizardPreset.authFlow !== "none" && (wizardPreset.authArgs?.length ?? 0) > 0;
        const desc = autoLogin
          ? `${name} sera autenticado automaticamente: clique em "Conectar conta", a CLI oficial sera iniciada e o navegador/terminal abrira para voce concluir o login.`
          : wizardPreset?.id === "gemini"
            ? 'Para usar o Antigravity no Maestro e necessario ter o CLI agy baixado e ja conectado com a sua conta Google no terminal. Se voce ja tem, clique em "Ja fiz login" para confirmar e ativar.'
            : `${name} faz login pela propria CLI. Rode o comando no terminal e depois volte e selecione "Ja fiz login".`;
        return { title: `Entrar com ${name}`, desc };
      }
    }
  };

  const { title: wizardTitle, desc: wizardDesc } = wizardCopy();

  return (
    <section className="provider-manager">
      {error ? <div className="provider-feedback error" role="alert">{error}</div> : null}
      {notice ? <div className="provider-feedback success">{notice}</div> : null}
      {(["Conta", "API", "Local"] as const).map((group) => groupedProviders[group].length ? (
        <div key={group}>
          <div className="prov-group-lbl">{group}</div>
          {groupedProviders[group].map((provider) => (
            <button type="button" className="prov-card" key={provider.key} onClick={() => openDetail(provider.key)}>
              <div className="head">
                <div className="av" style={{ background: provider.color }}>{provider.label.slice(0, 1).toUpperCase()}</div>
                <div><b>{provider.label}</b><span><i className="st-dot" />{provider.detail}</span></div>
                <span className="type-tag">{provider.type}</span>
                <svg className="pc-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 6l6 6-6 6" /></svg>
              </div>
              <div className="prov-uso">
                <div className="prov-uso-l"><div className={`toggle${provider.active ? " on" : ""}`}><i /></div><label>{provider.active ? "ativo" : "indisponivel"}</label></div>
                {provider.connected ? <span className="model-badge">{provider.model}</span> : null}
              </div>
            </button>
          ))}
        </div>
      ) : null)}
      <button type="button" className="add-provider" onClick={openWizard}>
        <div className="plus">+</div><b>Conectar provider</b><span>Local, OpenAI-compatible, ou endpoint próprio</span>
      </button>

      {detailProvider ? (
        <div className="modal-overlay active" onMouseDown={(event) => { if (event.currentTarget === event.target) closeDetail(); }}>
          <div className="modal" onClick={(event) => event.stopPropagation()}>
            <button type="button" className="modal-close" onClick={closeDetail} aria-label="Fechar"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" /></svg></button>
            <div className="modal-head">
              <div className="modal-eyebrow">{detailProvider.type === "account" ? "Conta" : detailProvider.type === "local" ? "Local" : "API"}</div>
              <div className="pd-head-row">
                <div className="pd-av" style={{ background: detailProvider.color }}>{detailProvider.label.slice(0, 1).toUpperCase()}</div>
                <div>
                  <div className="pd-name">{detailProvider.label}</div>
                  <div className="pd-status"><span className="st-dot" style={detailProvider.active ? undefined : { background: "var(--warn)" }} />{detailProvider.detail}</div>
                </div>
              </div>
            </div>
            <div className="modal-body">
              {detailProvider.connected ? (
                <>
                  <div className="pd-section-lbl">Modelo ativo</div>
                  {detailProvider.models.length > 6 ? (
                    <div className="model-search">
                      <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></svg>
                      <input type="text" value={modelQuery} onChange={(event) => setModelQuery(event.target.value)} placeholder="Buscar modelo..." />
                      <span className="count">{filteredModels.length} de {detailProvider.models.length}</span>
                    </div>
                  ) : null}
                  <div className="model-list-scroll">
                    {filteredModels.length ? filteredModels.map((model) => (
                      <div
                        className={`model-row${model === detailProvider.model ? " active" : ""}`}
                        key={model}
                        onClick={() => { if (!detailBusy) void selectModel(model); }}
                      >
                        <div className="radio" />
                        <div className="tx"><b>{model}</b></div>
                        {model === detailProvider.models[0] ? <span className="default-tag">padrão</span> : null}
                      </div>
                    )) : <div className="model-empty">Nenhum modelo encontrado</div>}
                  </div>
                </>
              ) : (
                <div className="pd-unconfigured">Conecte uma chave de API válida para escolher o modelo deste provider.</div>
              )}

              <div className="danger-zone">
                <button type="button" className="danger-trigger" onClick={() => setDangerConfirm(true)}>
                  <svg viewBox="0 0 24 24"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0l-1 14a2 2 0 01-2 2H7a2 2 0 01-2-2L4 6" /></svg>
                  Desconectar provider
                </button>
                <div className={`danger-confirm${dangerConfirm ? " show" : ""}`}>
                  <p>Isso remove <b>{detailProvider.label}</b> das suas rotas. Tasks em andamento com fallback automático migram para o próximo da fila.</p>
                  <div className="row">
                    <button type="button" className="btn-ghost" onClick={() => setDangerConfirm(false)}>Cancelar</button>
                    <button type="button" className="btn-danger" onClick={() => void removeProvider()} disabled={detailBusy}>
                      {detailBusy ? "Removendo..." : detailProvider.registeredProvider ? "Remover conexão" : "Pausar provider"}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {wizardOpen ? (
        <div className="modal-overlay active" onMouseDown={(event) => { if (event.currentTarget === event.target) closeWizard(); }}>
          <div className="modal" onClick={(event) => event.stopPropagation()}>
            <button type="button" className={`modal-back${wizardHistory.length ? " show" : ""}`} onClick={backStep} aria-label="Voltar"><svg viewBox="0 0 24 24"><path d="M15 18l-6-6 6-6" /></svg></button>
            <button type="button" className="modal-close" onClick={closeWizard} aria-label="Fechar"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" /></svg></button>

            <div className={`modal-head${wizardHistory.length ? " with-back" : ""}`}>
              <div className="modal-eyebrow">Novo braço</div>
              <h3>{wizardTitle}</h3>
              <p>{wizardDesc}</p>
            </div>

            <div className="modal-body">
              {error ? <div className="provider-feedback error" role="alert">{error}</div> : null}

              <div className={`cp-step${wizardStep === "method" ? " active" : ""}`}>
                <div className="method-grid">
                  <div className="method-card" onClick={() => gotoStep("list-apikey")}>
                    <div className="ico"><svg viewBox="0 0 24 24"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 11-7.778 7.778 5.5 5.5 0 017.778-7.778zm0 0L15.5 7.5m0 0L19 4m-3.5 3.5L19 4" /></svg></div>
                    <b>Via chave de API</b>
                    <p>Cole uma API key. Bom para OpenAI, Anthropic API, ou qualquer endpoint compatível.</p>
                  </div>
                  <div className="method-card" onClick={() => gotoStep("list-account")}>
                    <div className="ico"><svg viewBox="0 0 24 24"><path d="M4 17l6-6-6-6M12 19h8" /></svg></div>
                    <b>Via conta (CLI)</b>
                    <p>Login pela CLI oficial do provider. Nenhuma chave fica salva no Octomynd.</p>
                  </div>
                </div>
              </div>

              <div className={`cp-step${wizardStep === "list-apikey" ? " active" : ""}`}>
                {presets.filter((preset) => preset.category === "api").map((preset) => (
                  <div className="pick-row" key={preset.id} onClick={() => openApiKeyPreset(preset)}>
                    <div className="av" style={{ background: providerColor(preset.id) }}>{preset.label.slice(0, 1).toUpperCase()}</div>
                    <div className="tx"><b>{preset.label}</b><span>{preset.description}</span></div>
                    <svg className="go" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
                  </div>
                ))}
                <div className="pick-row" onClick={openApiKeyCustom}>
                  <div className="av" style={{ background: "#5c5347" }}>+</div>
                  <div className="tx"><b>Endpoint customizado</b><span>compatível com OpenAI · URL + chave</span></div>
                  <svg className="go" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
                </div>
              </div>

              <div className={`cp-step${wizardStep === "list-account" ? " active" : ""}`}>
                {presets.filter((preset) => preset.category === "account").map((preset) => (
                  <div className="pick-row" key={preset.id} onClick={() => openAccountPreset(preset)}>
                    <div className="av" style={{ background: providerColor(preset.id) }}>{preset.label.slice(0, 1).toUpperCase()}</div>
                    <div className="tx"><b>{preset.label}</b><span>login via CLI oficial</span></div>
                    <svg className="go" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
                  </div>
                ))}
              </div>

              <div className={`cp-step${wizardStep === "apikey" ? " active" : ""}`}>
                <div className="apikey-hint">A chave é armazenada localmente e nunca sai da sua máquina — o Octomynd é local-first.</div>
                {wizardCustomEndpoint ? (
                  <div className="mfield">
                    <label>Nome</label>
                    <input value={customLabel} onChange={(event) => setCustomLabel(event.target.value)} placeholder="Meu endpoint" />
                  </div>
                ) : null}
                <div className="mfield">
                  <label>API key</label>
                  <input type="password" value={apiKeyValue} onChange={(event) => setApiKeyValue(event.target.value)} placeholder="sk-••••••••••••••••••••••••" />
                </div>
                <div className="mfield" style={{ display: wizardCustomEndpoint ? "block" : "none" }}>
                  <label>Base URL</label>
                  <input type="text" value={baseUrlValue} onChange={(event) => setBaseUrlValue(event.target.value)} placeholder="https://api.exemplo.com/v1" />
                </div>
                <div className="cp-foot">
                  <button type="button" className="btn-ghost" onClick={closeWizard}>Cancelar</button>
                  <button type="button" className="btn-new" onClick={() => void connectApiKey()} disabled={wizardBusy}>{wizardBusy ? "Conectando..." : "Conectar"}</button>
                </div>
              </div>

              <div className={`cp-step${wizardStep === "account" ? " active" : ""}`}>
                {wizardPreset?.setupCommand ? (
                  <div className="term-box">
                    <div className="cmd"><span className="dollar">$</span> <span className="arg">{wizardPreset.setupCommand}</span></div>
                    <button type="button" className={`copy-btn${copyState === "copied" ? " copied" : ""}`} onClick={() => void copyCommand(wizardPreset.setupCommand!)}>
                      {copyState === "copied" ? "Copiado ✓" : "Copiar"}
                    </button>
                  </div>
                ) : null}
                {(wizardPreset?.authFlow && wizardPreset.authFlow !== "none" && (wizardPreset.authArgs?.length ?? 0) > 0) && authSession ? <AuthSessionPanel session={authSession} /> : null}
                {wizardPreset?.docsUrl ? (
                  <a href={wizardPreset.docsUrl} className="docs-link" target="_blank" rel="noreferrer">
                    <svg viewBox="0 0 24 24"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6M15 3h6v6M10 14L21 3" /></svg>
                    <span>{wizardPreset?.label} docs</span>
                  </a>
                ) : null}
                <div className="cp-foot">
                  <button type="button" className="btn-ghost" onClick={closeWizard}>Cancelar</button>
                  <button type="button" className="btn-new" onClick={() => void handleAccountPrimary()} disabled={wizardBusy || authSession?.state === "waiting"}>
                    {accountPrimaryLabel()}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
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
  if (providerId.includes("qwen")) return "#4d7a8c";
  if (providerId.includes("mistral")) return "#8a6dab";
  return "#7c634a";
}
