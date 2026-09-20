import { useCallback, useEffect, useState } from "react";
import {
  AgentCapability,
  AgentProviderId,
  DashboardData,
  fetchProviderPolicy,
  ProviderPolicySnapshot,
  ReasoningEffort,
  updateCapabilityRouting,
} from "../api";
import { capabilityLabel } from "../helpers";
import { translate } from "../i18n";
import { ProviderMascot, ProviderMascotState } from "./ProviderMascot";

export function AgentDock({ agents, policy: externalPolicy, onPolicyChanged }: {
  agents: DashboardData["agents"];
  policy?: ProviderPolicySnapshot | null;
  onPolicyChanged?: () => void;
}) {
  const [localPolicy, setLocalPolicy] = useState<ProviderPolicySnapshot | null>(null);
  const policy = externalPolicy !== undefined ? externalPolicy : localPolicy;
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedCapability, setSelectedCapability] = useState<AgentCapability>("planning");

  // Only route to connected providers: paused/disabled are excluded from the
  // Control plane (they're connected but not routable) and don't appear as an
  // option or the selected "first" for any capability.
  const providers = (agents.filter((agent): agent is typeof agent & { id: AgentProviderId } => agent.id !== "telegram"))
    .filter((agent) => agent.state === "ready" || agent.state === "working")
    .filter((agent) => {
      if (!policy) return true; // policy not loaded yet — show all providers
      const mode = policy.controls.find((c) => c.providerId === agent.id)?.mode ?? "enabled";
      return mode === "enabled";
    });

  const loadPolicy = useCallback(async () => {
    try {
      const data = await fetchProviderPolicy();
      setLocalPolicy(data);
      setError(null);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : translate("Unable to load providers."));
    }
  }, []);

  useEffect(() => {
    if (externalPolicy === undefined) void loadPolicy();
  }, [loadPolicy, externalPolicy]);

  const changeRouting = async (
    capability: AgentCapability,
    primary: AgentProviderId,
    requiredProviderId: AgentProviderId | null,
    preferredModel?: string | null,
    preferredEffort?: ReasoningEffort | null
  ) => {
    const current = (policy?.capabilities ?? []).find((item) => item.capability === capability);
    if (!current) return;
    setBusy(`capability:${capability}`);
    try {
      const targetPreferredModel = preferredModel !== undefined ? preferredModel : current.preferredModel;
      const targetPreferredEffort = preferredEffort !== undefined ? preferredEffort : current.preferredEffort;
      await updateCapabilityRouting(capability, {
        order: [primary, ...current.order.filter((item) => item !== primary)],
        requiredProviderId,
        preferredModel: targetPreferredModel,
        preferredEffort: targetPreferredEffort
      });
      await loadPolicy();
      onPolicyChanged?.();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : translate("Unable to update routing."));
    } finally {
      setBusy(null);
    }
  };

  const routings = policy?.capabilities ?? [];
  const selectedRouting = routings.find((item) => item.capability === selectedCapability) ?? routings[0];

  if (!selectedRouting) {
    return (
      <section className="panel provider-routing" id="provider-routing">
        <div className="panel-head"><div><div className="lbl">{translate("Control plane")}</div><h3>{translate("Priority by function")}</h3></div><span>{translate("persistent")}</span></div>
        {error ? <p className="provider-error">{error}</p> : null}
        <p className="provider-routing-copy">{translate("Choose the first provider, preferred model, and fallback rule.")}</p>
      </section>
    );
  }

  // Resolve the effective "first" to an actually-eligible provider. The
  // configured order may still reference a paused or removed provider.
  const eligible = providers.map((provider) => String(provider.id));
  const firstStr = String(selectedRouting.order[0]);
  const primaryProviderId = eligible.includes(firstStr) ? firstStr : eligible[0] ?? "";
  const primaryProvider = providers.find((provider) => provider.id === primaryProviderId);
  const availableModels = primaryProvider?.models?.length
    ? primaryProvider.models
    : policy?.models?.[primaryProviderId] ?? [];
  const modelOptions = [...new Set([
    ...availableModels,
    ...(selectedRouting.preferredModel ? [selectedRouting.preferredModel] : [])
  ])];
  const selectedModel = selectedRouting.preferredModel && modelOptions.includes(selectedRouting.preferredModel)
    ? selectedRouting.preferredModel
    : "";
  const availableEfforts = primaryProvider?.reasoningEfforts ?? [];
  const effortOptions = [...new Set([
    ...availableEfforts,
    ...(selectedRouting.preferredEffort ? [selectedRouting.preferredEffort] : [])
  ])];
  const selectedEffort = selectedRouting.preferredEffort && effortOptions.includes(selectedRouting.preferredEffort)
    ? selectedRouting.preferredEffort
    : "";
  const primaryAgent = agents.find((agent) => agent.id === primaryProviderId);
  const mascotState: ProviderMascotState = primaryAgent?.state === "working" ? "processing" : "ready";
  const mascotColor = providerColor(primaryProviderId);

  return (
    <section className="panel provider-routing" id="provider-routing">
      <div className="routing-layout">
        <div className="routing-overview">
          <div className="lbl">{translate("Routing by function")}</div>
          <h2>{capabilityLabel(selectedRouting.capability)}</h2>
          <p>{capabilityDescription(selectedRouting.capability)}</p>
        </div>
        <div className="routing-editor">
          <div className="routing-editor-head">
            <div><div className="lbl">{translate("Control plane")}</div><p>{translate("Choose the first provider, preferred model, and fallback rule.")}</p></div>
            <span>{translate("persistent")}</span>
          </div>
          {error ? <p className="provider-error">{error}</p> : null}
          <div className="routing-function-row">
            <label className="routing-editor-field routing-function-field">
              <span className="field-lbl">{translate("Function")}</span>
              <select className="sel routing-function-select" value={selectedRouting.capability} disabled={busy !== null} onChange={(event) => setSelectedCapability(event.target.value as AgentCapability)}>
                {routings.map((routing) => <option value={routing.capability} key={routing.capability}>{capabilityLabel(routing.capability)}</option>)}
              </select>
            </label>
            <span className="routing-help">ⓘ {translate("How routing works?")}</span>
          </div>
          <div className="routing-editor-grid">
            <label className="routing-editor-field routing-provider-field">
              <span className="field-lbl">{translate("Provider")}</span>
              <span className="routing-provider-control">
                <span className="routing-provider-mascot" style={{ color: mascotColor }} aria-hidden="true"><ProviderMascot color={mascotColor} state={mascotState} capability={selectedRouting.capability} /></span>
                <select className="sel" value={primaryProviderId} disabled={busy !== null} onChange={(event) => void changeRouting(selectedRouting.capability, event.target.value as AgentProviderId, selectedRouting.requiredProviderId, event.target.value === primaryProviderId ? selectedRouting.preferredModel : null, event.target.value === primaryProviderId ? selectedRouting.preferredEffort : null)}>
                  {providers.map((provider) => <option value={provider.id} key={provider.id}>{provider.label}</option>)}
                </select>
              </span>
            </label>
            <label className="routing-editor-field">
              <span className="field-lbl">{translate("Model")}</span>
              <select className="sel" value={selectedModel} disabled={busy !== null || modelOptions.length === 0} onChange={(event) => void changeRouting(selectedRouting.capability, primaryProviderId as AgentProviderId, selectedRouting.requiredProviderId, event.target.value || null)}>
                <option value="" title={translate("Provider default")}>{translate("Default")}</option>
                {modelOptions.map((model) => <option value={model} key={model}>{model}</option>)}
              </select>
            </label>
            <label className="routing-editor-field">
              <span className="field-lbl">{translate("Effort")}</span>
              <select className="sel" value={selectedEffort} disabled={busy !== null || effortOptions.length === 0} onChange={(event) => void changeRouting(selectedRouting.capability, primaryProviderId as AgentProviderId, selectedRouting.requiredProviderId, selectedModel || null, (event.target.value || null) as ReasoningEffort | null)}>
                <option value="" title={translate("Provider default")}>{translate("Default")}</option>
                {effortOptions.map((effort) => <option value={effort} key={effort}>{effortLabel(effort)}</option>)}
              </select>
            </label>
            <label className="routing-editor-field">
              <span className="field-lbl">{translate("Rule")}</span>
              <select className="sel" value={selectedRouting.requiredProviderId ?? "auto"} disabled={busy !== null} onChange={(event) => void changeRouting(selectedRouting.capability, primaryProviderId as AgentProviderId, event.target.value === "auto" ? null : event.target.value as AgentProviderId, selectedModel || null, (selectedEffort || null) as ReasoningEffort | null)}>
                <option value="auto">{translate("Automatic fallback")}</option>
                {providers.map((provider) => <option value={provider.id} key={provider.id}>{translate("Only {provider}", { provider: provider.label })}</option>)}
              </select>
            </label>
          </div>
          <div className="routing-info">ⓘ {primaryProvider?.label ?? translate("Provider")} {translate("will be used for {function} tasks.", { function: capabilityLabel(selectedRouting.capability) })}</div>
        </div>
      </div>
    </section>
  );
}

function capabilityDescription(capability: AgentCapability): string {
  return translate({
    planning: "Define the approach and break the work into a clear plan.",
    coding: "Implement the planned changes directly in the project.",
    testing: "Run checks and validate that the implementation works.",
    reviewing: "Inspect the final result for quality, safety, and regressions.",
    improvement_reviewing: "Find opportunities to improve the project and its workflow.",
    research: "Investigate the project and gather the context needed to decide.",
    conversation: "Answer questions and keep the project conversation moving."
  }[capability]);
}

function providerColor(providerId: string): string {
  if (providerId.includes("claude")) return "#c4622d";
  if (providerId.includes("gemini") || providerId.includes("antigravity")) return "#6f8f6a";
  if (providerId.includes("ollama")) return "#5c6f8f";
  if (providerId.includes("openrouter")) return "#8a6dab";
  if (providerId.includes("openai") || providerId.includes("qwen")) return "#4d7a8c";
  if (providerId.includes("mistral")) return "#8a6dab";
  return "#7c634a";
}

function effortLabel(effort: ReasoningEffort): string {
  return translate({
    minimal: "Minimal",
    low: "Low",
    medium: "Medium",
    high: "High",
    extra_high: "Extra high",
    max: "Max",
    ultra: "Ultra"
  }[effort]);
}
