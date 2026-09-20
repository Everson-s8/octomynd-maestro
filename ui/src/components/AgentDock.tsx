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

  return (
    <section className="panel provider-routing" id="provider-routing">
      <div className="panel-head">
        <div><div className="lbl">Control plane</div><h3>{translate("Priority by function")}</h3></div>
        <span>{translate("persistent")}</span>
      </div>
      {error ? <p className="provider-error">{error}</p> : null}
      <p className="provider-routing-copy">{translate("Choose the first provider, preferred model, and fallback rule.")}</p>
          {(policy?.capabilities ?? []).map((routing) => {
            // Resolve the effective "first" to an actually-eligible provider (the
            // configured order may still reference a paused/removed provider).
            const eligible = providers.map((p) => String(p.id));
            const firstStr = String(routing.order[0]);
            const primaryProviderId: string =
              eligible.includes(firstStr) ? firstStr : eligible[0] ?? "";
            const primaryProvider = providers.find((provider) => provider.id === primaryProviderId);
            const availableModels = primaryProvider?.models?.length
              ? primaryProvider.models
              : policy?.models?.[primaryProviderId] ?? [];
            const modelOptions = [...new Set([
              ...availableModels,
              ...(routing.preferredModel ? [routing.preferredModel] : [])
            ])];
            const selectedModel = routing.preferredModel && modelOptions.includes(routing.preferredModel)
              ? routing.preferredModel
              : "";
            const availableEfforts = primaryProvider?.reasoningEfforts ?? [];
            const effortOptions = [...new Set([
              ...availableEfforts,
              ...(routing.preferredEffort ? [routing.preferredEffort] : [])
            ])];
            const selectedEffort = routing.preferredEffort && effortOptions.includes(routing.preferredEffort)
              ? routing.preferredEffort
              : "";
            const primaryAgent = agents.find((agent) => agent.id === primaryProviderId);
            const mascotState: ProviderMascotState = primaryAgent?.state === "working" ? "processing" : "ready";
            const mascotColor = providerColor(primaryProviderId);
            return (
              <div className="routing-row" key={routing.capability}>
                <div className="rname">
                  <span className="routing-mascot" style={{ color: mascotColor }} aria-hidden="true">
                    <ProviderMascot color={mascotColor} state={mascotState} capability={routing.capability} />
                  </span>
                  <span>{capabilityLabel(routing.capability)}</span>
                </div>
                <div><div className="field-lbl">{translate("First")}</div>
                  <select className="sel"
                    value={primaryProviderId}
                    disabled={busy !== null}
                    onChange={(event) =>
                      void changeRouting(
                        routing.capability,
                        event.target.value as AgentProviderId,
                        routing.requiredProviderId,
                        event.target.value === primaryProviderId ? routing.preferredModel : null,
                        event.target.value === primaryProviderId ? routing.preferredEffort : null
                      )
                    }
                  >
                    {providers.map((provider) => (
                      <option value={provider.id} key={provider.id}>
                        {provider.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div><div className="field-lbl">{translate("Model")}</div>
                  <select
                    className="sel"
                    value={selectedModel}
                    disabled={busy !== null || modelOptions.length === 0}
                    onChange={(event) =>
                      void changeRouting(
                        routing.capability,
                        primaryProviderId as AgentProviderId,
                        routing.requiredProviderId,
                        event.target.value || null
                      )
                    }
                  >
                    <option value="" title={translate("Provider default")}>{translate("Default")}</option>
                    {modelOptions.map((model) => <option value={model} key={model}>{model}</option>)}
                  </select>
                </div>
                <div><div className="field-lbl">{translate("Effort")}</div>
                  <select
                    className="sel"
                    value={selectedEffort}
                    disabled={busy !== null || effortOptions.length === 0}
                    onChange={(event) =>
                      void changeRouting(
                        routing.capability,
                        primaryProviderId as AgentProviderId,
                        routing.requiredProviderId,
                        selectedModel || null,
                        (event.target.value || null) as ReasoningEffort | null
                      )
                    }
                  >
                    <option value="" title={translate("Provider default")}>{translate("Default")}</option>
                    {effortOptions.map((effort) => <option value={effort} key={effort}>{effortLabel(effort)}</option>)}
                  </select>
                </div>
                <div><div className="field-lbl">{translate("Rule")}</div><select className="sel"
                    value={routing.requiredProviderId ?? "auto"}
                    disabled={busy !== null}
                    onChange={(event) =>
                      void changeRouting(
                        routing.capability,
                        primaryProviderId as AgentProviderId,
                        event.target.value === "auto" ? null : (event.target.value as AgentProviderId),
                        selectedModel || null,
                        (selectedEffort || null) as ReasoningEffort | null
                      )
                    }
                  >
                    <option value="auto">{translate("Automatic fallback")}</option>
                    {providers.map((provider) => (
                      <option value={provider.id} key={provider.id}>
                        {translate("Only {provider}", { provider: provider.label })}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            );
          })}
    </section>
  );
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
