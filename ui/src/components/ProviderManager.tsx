import { useEffect, useMemo, useState } from "react";
import {
  AgentProviderId,
  cancelProviderAuth,
  deleteProvider,
  fetchProviderAuth,
  fetchProviderPresets,
  fetchProviderPolicy,
  ProviderAuthFlowId,
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
import { translate } from "../i18n";

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
  externalPolicy,
  policyVersion,
  setPolicy,
  onPolicyChanged,
  onChanged
}: {
  agents: DashboardData["agents"];
  externalPolicy?: (ProviderPolicySnapshot & { availableModels?: Record<string, string[]> }) | null;
  policyVersion?: string;
  setPolicy?: (p: (ProviderPolicySnapshot & { availableModels?: Record<string, string[]> }) | null) => void;
  onPolicyChanged?: () => void;
  onChanged?: () => void;
}) {
  const [presets, setPresets] = useState<ProviderPreset[]>([]);
  const [registered, setRegistered] = useState<RegisteredCustomProvider[]>([]);
  // If a shared policy is provided via props (elevated state), use it; otherwise
  // fall back to a local copy. This keeps ProviderManager reactive to changes made
  // elsewhere (e.g. AgentDock) without needing a page reload.
  const [localPolicy, setLocalPolicy] = useState<(ProviderPolicySnapshot & { availableModels?: Record<string, string[]> }) | null>(null);
  const policy = externalPolicy !== undefined ? externalPolicy : localPolicy;
  const updatePolicy = (p: (ProviderPolicySnapshot & { availableModels?: Record<string, string[]> }) | null) => {
    if (setPolicy) setPolicy(p);
    else setLocalPolicy(p);
  };
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const [detailKey, setDetailKey] = useState<string | null>(null);
  const [modelQuery, setModelQuery] = useState("");
  const [dangerConfirm, setDangerConfirm] = useState(false);
  const [detailBusy, setDetailBusy] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

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
  // Which login flow the user picked on the account step (e.g. codex offers
  // browser / device code / verify existing terminal login).
  const [authFlowId, setAuthFlowId] = useState<ProviderAuthFlowId | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied">("idle");

  const load = async () => {
    try {
      const [presetData, policyData] = await Promise.all([fetchProviderPresets(), fetchProviderPolicy()]);
      setPresets(presetData.presets);
      setRegistered(presetData.registered);
      updatePolicy(policyData);
    } catch (cause) {
      setError(readError(cause, translate("Unable to load providers.")));
    }
  };

  useEffect(() => { void load(); }, []);

  // When the shared policy changes externally (e.g. AgentDock paused a provider,
  // or another tab), reload presets/registered so cards and the detail modal stay
  // in sync without a page refresh.
  useEffect(() => {
    if (policy === undefined || policyVersion === undefined) return;
    void fetchProviderPresets()
      .then((presetData) => {
        setPresets(presetData.presets);
        setRegistered(presetData.registered);
      })
      .catch(() => {});
  }, [policyVersion]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!authSession || authSession.state !== "waiting") return;
    const timer = window.setInterval(() => {
      void fetchProviderAuth(authSession.id).then((session) => {
        setAuthSession(session);
        if (session.state === "failed") setError(session.detail);
      }).catch((cause) => setError(readError(cause, translate("Unable to monitor authentication."))));
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
    // A paused built-in can be re-enabled from the Connect provider flow.
    const builtIns = presets
      .filter((preset) => preset.builtIn)
      .map((preset) => {
        const runtimeId =
          preset.id === "gemini" || preset.id === "gemini-antigravity" ? "antigravity" : preset.id;
        const agent = agents.find((item) => item.id === runtimeId);
        const control = policy?.controls.find((item) => item.providerId === runtimeId);
        const models = policy?.availableModels?.[runtimeId] ?? preset.models ?? [];
        const activeModel = control?.model || models[0] || "";
        // The list is a runtime view, but an installed CLI that still needs
        // authentication must remain visible so the user can understand why
        // the top count is larger than the ready count. Offline/missing CLIs
        // stay out of the connected list and remain available through the
        // wizard.
        // Until the policy request finishes, an authenticated provider should
        // remain visible. An absent control means the runtime default (enabled),
        // not that the provider was removed.
        const paused = control ? control.mode !== "enabled" : false;
        const connected = isProviderConnected(agent?.state);
        return {
          key: `preset:${preset.id}`,
          providerId: runtimeId,
          label: preset.label,
          detail: paused
            ? translate("Paused — reactivate it with the ACCOUNT button or Connect provider")
            : agent?.detail || translate("Connection not verified on this machine"),
          type: (preset.category === "api" ? "api" : preset.category === "local" ? "local" : "account") as "account" | "api" | "local",
          model: activeModel || translate("Provider default"),
          active: connected && !paused,
          connected,
          paused,
          color: providerColor(preset.id),
          models,
          registeredProvider: null
        };
      })
      .filter((p) => !p.paused && agents.some((agent) => agent.id === p.providerId && agent.state !== "offline"));
    const custom = registered.map((provider) => {
      const preset = presets.find((item) => item.id === provider.presetId);
      const local = preset?.category === "local" || provider.connectionMode === "local";
      const category = preset?.category ?? (local ? "local" : "api");
      const agent = agents.find((item) => item.id === provider.id);
      const control = policy?.controls.find((item) => item.providerId === provider.id);
      const models = policy?.availableModels?.[provider.id] ?? provider.models ?? [];
      const activeModel = control?.model || provider.model || models[0] || "";
      return {
        key: `registered:${provider.id}`,
        providerId: provider.id,
        label: provider.label,
        detail: agent?.detail || (local ? provider.endpointUrl || translate("Local endpoint") : translate("Connection not verified on this machine")),
        type: (category === "local" ? "local" : category === "account" ? "account" : "api") as "account" | "api" | "local",
        model: activeModel || translate("Provider default"),
        active: isProviderConnected(agent?.state),
        connected: isProviderConnected(agent?.state),
        paused: control ? control.mode !== "enabled" : false,
        color: providerColor(provider.id),
        models,
        registeredProvider: provider
      };
    });
    return [...builtIns, ...custom].filter((provider) => (
      !provider.paused
      && (provider.connected || agents.some((agent) => agent.id === provider.providerId && agent.state === "attention"))
    ));
  }, [agents, presets, registered, policy]);

  const groupedProviders = {
    Account: connectedProviders.filter((provider) => provider.type === "account"),
    API: connectedProviders.filter((provider) => provider.type === "api"),
    Local: connectedProviders.filter((provider) => provider.type === "local")
  };

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
      onPolicyChanged?.();
    } catch (cause) {
      setError(readError(cause, translate("Unable to update the model.")));
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
        setNotice(translate("{provider} disconnected. Dependent routes and fallbacks were repaired.", { provider: detailProvider.label }));
      } else {
        const control = policy?.controls.find((item) => item.providerId === detailProvider.providerId);
        await updateProviderControl(detailProvider.providerId, {
          mode: "disabled",
          fallbackEnabled: control?.fallbackEnabled ?? false
        });
        setNotice(translate("{provider} was paused and removed from routing.", { provider: detailProvider.label }));
        await load();
      }
      onChanged?.();
      onPolicyChanged?.();
      closeDetail();
    } catch (cause) {
      setError(readError(cause, translate("Unable to disconnect the provider.")));
    } finally {
      setDetailBusy(false);
    }
  };

  // Quick toggle directly on the card: pause (connected but not routable) or
  // re-enable the provider without opening the detail modal. Uses stopPropagation
  // so the card's openDetail click doesn't fire.
  const toggleProvider = async (provider: ConnectedProvider, event: { stopPropagation: () => void; preventDefault: () => void }) => {
    event.stopPropagation();
    event.preventDefault();
    const control = policy?.controls.find((item) => item.providerId === provider.providerId);
    const nextMode = control?.mode === "enabled" ? "paused" : "enabled";
    setBusyId(provider.providerId);
    setError("");
    try {
      await updateProviderControl(provider.providerId, {
        mode: nextMode,
        fallbackEnabled: control?.fallbackEnabled ?? false
      });
      await load();
      onChanged?.();
      onPolicyChanged?.();
      setNotice(nextMode === "paused" ? translate("{provider} paused (connected but not routable).", { provider: provider.label }) : translate("{provider} enabled.", { provider: provider.label }));
    } catch (cause) {
      setError(readError(cause, translate("Unable to toggle the provider.")));
    } finally {
      setBusyId(null);
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
    setAuthFlowId(null);
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
      setNotice(translate("{provider} is already part of the runtime. Use the priority panel to enable or pause it.", { provider: preset.label }));
      closeWizard();
      return;
    }
    if (!apiKeyValue.trim()) return setError(translate("Enter the API key."));
    const label = preset?.label ?? (customLabel.trim() || translate("Custom endpoint"));
    const id = sanitizeId(preset?.id ?? customLabel ?? label);
    if (!id) return setError(translate("Enter a valid provider name."));
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
      setNotice(translate("{provider} connected and enabled without restarting Maestro.", { provider: label }));
      await load();
      onChanged?.();
      onPolicyChanged?.();
      closeWizard();
    } catch (cause) {
      setError(readError(cause, translate("Unable to connect the provider.")));
    } finally {
      setWizardBusy(false);
    }
  };

  const confirmAccountLogin = async () => {
    const preset = wizardPreset;
    if (!preset) return;
    // Built-in providers (e.g. gemini/antigravity) can't be re-registered, but
    // "I already logged in" should also activate the provider when it was paused/
    // disabled, re-enable it so it shows up on the screen again. Otherwise the
    // message would say "pronto" but the card would stay hidden (inconsistent).
    if (preset.builtIn) {
      setWizardBusy(true);
      setError("");
      try {
        const testResult = await testProviderConnection({
          command: preset.command,
          args: preset.authStatusArgs && preset.authStatusArgs.length > 0 ? preset.authStatusArgs : [],
          presetId: preset.id
        });
        if (!testResult.ok) throw new Error(testResult.detail || translate("CLI not found or not authenticated."));
        // Re-activate the built-in provider (it may have been paused/disabled).
        const control = policy?.controls.find((item) => item.providerId === preset.id || item.providerId === "antigravity");
        const targetId = preset.id === "gemini" || preset.id === "gemini-antigravity" ? "antigravity" : preset.id;
        if (control?.mode !== "enabled") {
          await updateProviderControl(targetId as AgentProviderId, {
            mode: "enabled",
            fallbackEnabled: control?.fallbackEnabled ?? false
          });
        }
        setNotice(`${preset.label} foi ativado. Use o painel de prioridade para definir a ordem.`);
        await load();
        onChanged?.();
        onPolicyChanged?.();
        closeWizard();
      } catch (cause) {
        setError(readError(cause, translate("Unable to confirm the connection.")));
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
      // The wrong command fails with a generic CLI error. Use authStatusArgs.
      // (e.g. gh auth status) which actually confirms the logged-in account.
      const testResult = await testProviderConnection({
        command: preset.command,
        args: preset.authStatusArgs && preset.authStatusArgs.length > 0 ? preset.authStatusArgs : preset.args,
        presetId: preset.id
      });
      if (!testResult.ok) throw new Error(testResult.detail || translate("Login not detected yet. Check the terminal and try again."));
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
      onPolicyChanged?.();
      closeWizard();
    } catch (cause) {
      setError(readError(cause, translate("Unable to confirm the login.")));
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
    const flows = preset.authFlows ?? [];
    if (flows.length > 0) {
      // Multi-flow presets always go through the broker with the chosen flow
      // (verify_only resolves immediately server-side). Once connected, finish
      // like the single-flow path does.
      if (authSession?.state === "waiting") return;
      if (authSession?.state !== "connected") {
        setWizardBusy(true);
        setError("");
        try {
          setAuthSession(await startProviderAuth(preset.id, authFlowId ?? flows.find((f) => f.recommended)?.id ?? flows[0].id));
        } catch (cause) {
          setError(readError(cause, translate("Unable to start authentication.")));
        } finally {
          setWizardBusy(false);
        }
        return;
      }
      await confirmAccountLogin();
      return;
    }
    if (hasAutoLogin && (!authSession || authSession.state !== "connected")) {
      if (authSession?.state === "waiting") return;
      setWizardBusy(true);
      setError("");
      try {
        setAuthSession(await startProviderAuth(preset.id));
      } catch (cause) {
        setError(readError(cause, translate("Unable to start authentication.")));
      } finally {
        setWizardBusy(false);
      }
      return;
    }
    await confirmAccountLogin();
  };

  const accountPrimaryLabel = () => {
    if (!wizardPreset) return translate("I already logged in");
    const flows = wizardPreset.authFlows ?? [];
    if (flows.length > 0) {
      if (authSession?.state === "waiting") return translate("Waiting for authorization…");
      if (authSession?.state === "connected") return wizardBusy ? translate("Finishing…") : translate("Finish connection");
      if (authSession?.state === "failed") return translate("Try again");
      return wizardBusy ? translate("Opening…") : translate("Sign in");
    }
    const hasAutoLogin = wizardPreset.authFlow && wizardPreset.authFlow !== "none" && (wizardPreset.authArgs?.length ?? 0) > 0;
    if (hasAutoLogin) {
      if (!authSession) return wizardBusy ? translate("Opening…") : translate("Connect account");
      if (authSession.state === "waiting") return translate("Waiting for authorization…");
      if (authSession.state === "connected") return wizardBusy ? translate("Finishing…") : translate("Finish connection");
      return translate("Try again");
    }
    return wizardBusy ? translate("Verifying…") : translate("I already logged in");
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
        return { title: translate("Connect provider"), desc: translate("How do you want to authenticate? The connection method depends on the selected provider.") };
      case "list-apikey":
        return { title: translate("Via API key"), desc: translate("Choose the provider you want to connect with an API key.") };
      case "list-account":
        return { title: translate("Via account (CLI)"), desc: translate("Choose a provider — sign-in happens through its official CLI.") };
      case "apikey": {
        const name = wizardPreset?.label ?? translate("Custom endpoint");
        return { title: name, desc: translate("Paste the API key to connect {provider}.", { provider: name }) };
      }
      case "account": {
        const name = wizardPreset?.label ?? translate("this provider");
        const autoLogin = wizardPreset?.authFlow && wizardPreset.authFlow !== "none" && (wizardPreset.authArgs?.length ?? 0) > 0;
        const desc = autoLogin
          ? translate("{provider} will be authenticated automatically when its official CLI is installed: click Connect account and finish sign-in in the browser or terminal.", { provider: name })
          : wizardPreset?.id === "gemini"
            ? translate("To use Antigravity in Maestro, install the agy CLI and sign in with your Google account in the terminal. When ready, click I already logged in to confirm and enable it.")
            : translate("{provider} signs in through its own CLI. Run the terminal command, then return and select I already logged in.", { provider: name });
        return { title: translate("Sign in with {provider}", { provider: name }), desc };
      }
    }
  };

  const { title: wizardTitle, desc: wizardDesc } = wizardCopy();

  return (
    <section className="provider-manager">
      {error ? <div className="provider-feedback error" role="alert">{error}</div> : null}
      {notice ? <div className="provider-feedback success">{notice}</div> : null}
      {(["Account", "API", "Local"] as const).map((group) => groupedProviders[group].length ? (
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
                <div className="prov-uso-l">
                  {(() => {
                    const control = policy?.controls.find((item) => item.providerId === provider.providerId);
                    const mode = control?.mode ?? (provider.registeredProvider ? "enabled" : provider.active ? "enabled" : "paused");
                    const on = provider.connected && mode === "enabled";
                    return (
                      <span
                        className={`toggle${on ? " on" : ""}${provider.connected ? "" : " unavailable"}`}
                        role="switch"
                        aria-checked={on}
                        aria-disabled={!provider.connected}
                        tabIndex={0}
                        onClick={(event) => { if (provider.connected) void toggleProvider(provider, event); }}
                        onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); event.stopPropagation(); if (provider.connected) void toggleProvider(provider, event); } }}
                        title={provider.connected ? (on ? translate("Pause {provider} (connected but not routable)", { provider: provider.label }) : translate("Enable {provider}", { provider: provider.label })) : translate("{provider} is not connected on this machine", { provider: provider.label })}
                      >
                        <i />
                      </span>
                    );
                  })()}
                  <label>{!provider.connected ? translate("not connected") : provider.active && (policy?.controls.find((item) => item.providerId === provider.providerId)?.mode ?? "enabled") !== "paused" ? translate("active") : translate("paused")}</label>
                </div>
                {provider.connected ? <span className="model-badge">{provider.model}</span> : null}
              </div>
            </button>
          ))}
        </div>
      ) : null)}
      <button type="button" className="add-provider" onClick={openWizard}>
        <div className="plus">+</div><b>{translate("Connect provider")}</b><span>{translate("Local, OpenAI-compatible, or custom endpoint")}</span>
      </button>

      {detailProvider ? (
        <div className="modal-overlay active" onMouseDown={(event) => { if (event.currentTarget === event.target) closeDetail(); }}>
          <div className="modal" onClick={(event) => event.stopPropagation()}>
            <button type="button" className="modal-close" onClick={closeDetail} aria-label={translate("Close")}><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" /></svg></button>
            <div className="modal-head">
              <div className="modal-eyebrow">{detailProvider.type === "account" ? translate("Account") : detailProvider.type === "local" ? translate("Local") : "API"}</div>
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
                  <div className="pd-section-lbl">{translate("Active model")}</div>
                  {detailProvider.models.length > 6 ? (
                    <div className="model-search">
                      <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></svg>
                      <input type="text" value={modelQuery} onChange={(event) => setModelQuery(event.target.value)} placeholder={translate("Search model…")} />
                      <span className="count">{filteredModels.length} {translate("of")} {detailProvider.models.length}</span>
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
                        {model === detailProvider.models[0] ? <span className="default-tag">{translate("default")}</span> : null}
                      </div>
                    )) : <div className="model-empty">{translate("No model found")}</div>}
                  </div>
                </>
              ) : (
                <div className="pd-unconfigured">
                  {detailProvider.type === "account"
                    ? translate("Install and authenticate this provider's official CLI to choose a model.")
                    : translate("Connect a valid API key to choose this provider's model.")}
                </div>
              )}

              <div className="danger-zone">
                <button type="button" className="danger-trigger" onClick={() => setDangerConfirm(true)}>
                  <svg viewBox="0 0 24 24"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0l-1 14a2 2 0 01-2 2H7a2 2 0 01-2-2L4 6" /></svg>
                  {translate("Disconnect provider")}
                </button>
                <div className={`danger-confirm${dangerConfirm ? " show" : ""}`}>
                  <p>{translate("This removes")} <b>{detailProvider.label}</b> {translate("from your routes. Running tasks with automatic fallback move to the next provider in the queue.")}</p>
                  <div className="row">
                    <button type="button" className="btn-ghost" onClick={() => setDangerConfirm(false)}>{translate("Cancel")}</button>
                    <button type="button" className="btn-danger" onClick={() => void removeProvider()} disabled={detailBusy}>
                      {detailBusy ? translate("Removing…") : detailProvider.registeredProvider ? translate("Remove connection") : translate("Pause provider")}
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
            <button type="button" className={`modal-back${wizardHistory.length ? " show" : ""}`} onClick={backStep} aria-label={translate("Back")}><svg viewBox="0 0 24 24"><path d="M15 18l-6-6 6-6" /></svg></button>
            <button type="button" className="modal-close" onClick={closeWizard} aria-label={translate("Close")}><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" /></svg></button>

            <div className={`modal-head${wizardHistory.length ? " with-back" : ""}`}>
              <div className="modal-eyebrow">{translate("New agent arm")}</div>
              <h3>{wizardTitle}</h3>
              <p>{wizardDesc}</p>
            </div>

            <div className="modal-body">
              {error ? <div className="provider-feedback error" role="alert">{error}</div> : null}

              <div className={`cp-step${wizardStep === "method" ? " active" : ""}`}>
                <div className="method-grid">
                  <div className="method-card" onClick={() => gotoStep("list-apikey")}>
                    <div className="ico"><svg viewBox="0 0 24 24"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 11-7.778 7.778 5.5 5.5 0 017.778-7.778zm0 0L15.5 7.5m0 0L19 4m-3.5 3.5L19 4" /></svg></div>
                    <b>{translate("Via API key")}</b>
                    <p>{translate("Paste an API key. Works with OpenAI, Anthropic API, or any compatible endpoint.")}</p>
                  </div>
                  <div className="method-card" onClick={() => gotoStep("list-account")}>
                    <div className="ico"><svg viewBox="0 0 24 24"><path d="M4 17l6-6-6-6M12 19h8" /></svg></div>
                    <b>{translate("Via account (CLI)")}</b>
                    <p>{translate("Sign in through the provider's official CLI. No key is stored by Octomynd.")}</p>
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
                  <div className="tx"><b>{translate("Custom endpoint")}</b><span>{translate("OpenAI-compatible · URL + key")}</span></div>
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
                <div className="apikey-hint">{translate("The key is stored locally and never leaves your machine — Octomynd is local-first.")}</div>
                {wizardCustomEndpoint ? (
                  <div className="mfield">
                    <label>{translate("Name")}</label>
                    <input value={customLabel} onChange={(event) => setCustomLabel(event.target.value)} placeholder={translate("My endpoint")} />
                  </div>
                ) : null}
                <div className="mfield">
                  <label>API key</label>
                  <input type="password" value={apiKeyValue} onChange={(event) => setApiKeyValue(event.target.value)} placeholder="sk-••••••••••••••••••••••••" />
                </div>
                <div className="mfield" style={{ display: wizardCustomEndpoint ? "block" : "none" }}>
                  <label>{translate("Base URL")}</label>
                  <input type="text" value={baseUrlValue} onChange={(event) => setBaseUrlValue(event.target.value)} placeholder="https://api.exemplo.com/v1" />
                </div>
                <div className="cp-foot">
                  <button type="button" className="btn-ghost" onClick={closeWizard}>{translate("Cancel")}</button>
                  <button type="button" className="btn-new" onClick={() => void connectApiKey()} disabled={wizardBusy}>{wizardBusy ? translate("Connecting…") : translate("Connect")}</button>
                </div>
              </div>

              <div className={`cp-step${wizardStep === "account" ? " active" : ""}`}>
                {wizardPreset?.setupCommand ? (
                  <div className="term-box">
                    <div className="cmd"><span className="dollar">$</span> <span className="arg">{wizardPreset.setupCommand}</span></div>
                    <button type="button" className={`copy-btn${copyState === "copied" ? " copied" : ""}`} onClick={() => void copyCommand(wizardPreset.setupCommand!)}>
                      {copyState === "copied" ? `${translate("Copied")} ✓` : translate("Copy")}
                    </button>
                  </div>
                ) : null}
                {(wizardPreset?.authFlows?.length ?? 0) > 0 && !authSession ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: "8px", marginBottom: "12px" }}>
                    {wizardPreset!.authFlows!.map((flow) => {
                      const selected = (authFlowId ?? wizardPreset!.authFlows!.find((f) => f.recommended)?.id ?? wizardPreset!.authFlows![0].id) === flow.id;
                      return (
                        <button
                          type="button"
                          key={flow.id}
                          onClick={() => { setAuthFlowId(flow.id); setAuthSession(null); }}
                          style={{
                            textAlign: "left",
                            padding: "10px 12px",
                            borderRadius: "var(--r-sm)",
                            border: `1px solid ${selected ? "var(--accent, #c4622d)" : "var(--border-color)"}`,
                            background: selected ? "var(--surface-2)" : "transparent",
                            color: "var(--text-1)",
                            cursor: "pointer"
                          }}
                        >
                          <b style={{ display: "block", fontSize: "13px" }}>{flow.label}{flow.recommended ? " · recomendado" : ""}</b>
                          {flow.description ? (
                            <span style={{ display: "block", fontSize: "12px", color: "var(--text-2)", marginTop: "2px" }}>{flow.description}</span>
                          ) : null}
                        </button>
                      );
                    })}
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
                  <button type="button" className="btn-ghost" onClick={closeWizard}>{translate("Cancel")}</button>
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
    ? translate("Waiting for your authorization")
    : session.state === "connected"
      ? translate("Account connected")
      : session.state === "cancelled"
        ? translate("Authorization cancelled")
        : translate("Authentication failed");
  return (
    <div className={`provider-auth-session ${session.state}`}>
      <div className="provider-auth-state"><span className="provider-auth-spinner" aria-hidden="true" /><strong>{title}</strong></div>
      <p>{session.detail}</p>
      {session.userCode ? (
        <div className="provider-device-code" aria-label={`${translate("Code")} ${session.userCode}`}>
          {session.userCode.split("").map((character, index) => <span className={character === "-" ? "separator" : ""} key={`${character}-${index}`}>{character}</span>)}
        </div>
      ) : null}
      {session.verificationUrl ? <a href={session.verificationUrl} target="_blank" rel="noreferrer" className="provider-help-link">{translate("Reopen verification page")}</a> : null}
    </div>
  );
}

function sanitizeId(value: string): string {
  return value.toLowerCase().trim().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

function readError(cause: unknown, fallback: string): string {
  const message = cause instanceof Error ? cause.message : fallback;
  const missingCli = message.match(/^provider_cli_not_found(?::(.+))?$/);
  return missingCli
    ? translate("The {cli} CLI is not installed on this machine. Install it and try again.", { cli: missingCli[1] || "official" })
    : message;
}

function isProviderConnected(state: DashboardData["agents"][number]["state"] | undefined): boolean {
  return state === "ready" || state === "working";
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
