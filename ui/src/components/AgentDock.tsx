import { useCallback, useEffect, useState } from "react";
import { agentStateLabel } from "../agentPresentation";
import {
  AgentCapability,
  AgentProviderId,
  DashboardData,
  fetchProviderPolicy,
  ProviderMode,
  ProviderPolicySnapshot,
  updateCapabilityRouting,
  updateProviderControl,
  updateProviderControls
} from "../api";
import { capabilityLabel } from "../helpers";
import { Icon } from "./Icon";
import { SectionHeader } from "./SectionHeader";

export function AgentDock({
  agents,
  environments
}: {
  agents: DashboardData["agents"];
  environments: DashboardData["environments"];
}) {
  const [policy, setPolicy] = useState<ProviderPolicySnapshot | null>(null);
  const [availableModels, setAvailableModels] = useState<Record<string, string[]>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const providers = agents.filter((agent): agent is typeof agent & { id: AgentProviderId } => agent.id !== "telegram");

  const loadPolicy = useCallback(async () => {
    try {
      const data = await fetchProviderPolicy();
      setPolicy(data);
      if (data.models || data.availableModels) {
        setAvailableModels(data.models || data.availableModels || {});
      }
      setError(null);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Falha ao carregar providers.");
    }
  }, []);

  useEffect(() => {
    void loadPolicy();
  }, [loadPolicy]);

  const controlFor = (providerId: AgentProviderId) =>
    policy?.controls.find((item) => item.providerId === providerId) ?? {
      providerId,
      mode: "enabled" as ProviderMode,
      fallbackEnabled: true,
      model: null,
      updatedAt: null
    };

  const changeControl = async (
    providerId: AgentProviderId,
    mode: ProviderMode,
    fallbackEnabled: boolean,
    model?: string | null
  ) => {
    setBusy(`provider:${providerId}`);
    try {
      const current = controlFor(providerId);
      const targetModel = model !== undefined ? model : current.model;
      await updateProviderControl(providerId, { mode, fallbackEnabled, model: targetModel });
      await loadPolicy();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Falha ao atualizar provider.");
    } finally {
      setBusy(null);
    }
  };

  const useOnly = async (providerId: AgentProviderId) => {
    setBusy("only");
    try {
      await updateProviderControls(
        providers.map((provider) => {
          const current = controlFor(provider.id);
          return {
            mode: provider.id === providerId ? "enabled" : "paused",
            providerId: provider.id,
            fallbackEnabled: provider.id === providerId ? false : true,
            model: current.model
          };
        })
      );
      await loadPolicy();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Falha ao aplicar provider exclusivo.");
    } finally {
      setBusy(null);
    }
  };

  const changeRouting = async (
    capability: AgentCapability,
    primary: AgentProviderId,
    requiredProviderId: AgentProviderId | null,
    preferredModel?: string | null
  ) => {
    const current = policy?.capabilities.find((item) => item.capability === capability);
    if (!current) return;
    setBusy(`capability:${capability}`);
    try {
      const targetPreferredModel = preferredModel !== undefined ? preferredModel : current.preferredModel;
      await updateCapabilityRouting(capability, {
        order: [primary, ...current.order.filter((item) => item !== primary)],
        requiredProviderId,
        preferredModel: targetPreferredModel
      });
      await loadPolicy();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Falha ao atualizar roteamento.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="panel agent-dock" id="providers" aria-labelledby="agents-title">
      <SectionHeader eyebrow="Control plane" title="Providers e roteamento" meta="controle persistente de modelos e fases" />
      {error ? <p className="provider-error">{error}</p> : null}
      <div className="provider-layout">
        <div className="agent-list">
          {providers.map((agent) => {
            const control = controlFor(agent.id);
            const models = availableModels[agent.id] ?? [];
            return (
              <article className={`agent-card agent-${agent.id}`} key={agent.id}>
                <div className="agent-avatar">{agent.label.slice(0, 1)}</div>
                <div>
                  <strong>{agent.label}</strong>
                  <small>{agent.detail}</small>
                </div>
                <span className={`agent-state state-${agent.state}`}>{agentStateLabel(agent.state)}</span>
                <div className="provider-controls">
                  <label>
                    Uso
                    <select
                      value={control.mode}
                      disabled={busy !== null}
                      onChange={(event) => void changeControl(agent.id, event.target.value as ProviderMode, control.fallbackEnabled, control.model)}
                    >
                      <option value="enabled">Ativo</option>
                      <option value="paused">Pausado</option>
                      <option value="disabled">Desativado</option>
                    </select>
                  </label>
                  <label>
                    Modelo
                    <select
                      value={control.model ?? "default"}
                      disabled={busy !== null}
                      onChange={(event) =>
                        void changeControl(
                          agent.id,
                          control.mode,
                          control.fallbackEnabled,
                          event.target.value === "default" ? null : event.target.value
                        )
                      }
                    >
                      <option value="default">Padrão do Provider</option>
                      {models.map((m) => (
                        <option value={m} key={m}>
                          {m}
                        </option>
                      ))}
                      {control.model && !models.includes(control.model) ? (
                        <option value={control.model}>{control.model}</option>
                      ) : null}
                    </select>
                  </label>
                  <label className="provider-check">
                    <input
                      type="checkbox"
                      checked={control.fallbackEnabled}
                      disabled={busy !== null}
                      onChange={(event) => void changeControl(agent.id, control.mode, event.target.checked, control.model)}
                    />{" "}
                    fallback
                  </label>
                  <button disabled={busy !== null} onClick={() => void useOnly(agent.id)}>
                    Usar somente este
                  </button>
                </div>
              </article>
            );
          })}
          {environments.map((environment) => (
            <article className="agent-card agent-environment" key={`environment-${environment.projectKey}`}>
              <div className="agent-avatar">
                <Icon name="pulse" />
              </div>
              <div>
                <strong>Ambiente @{environment.projectKey}</strong>
                <small>{environment.status === "ready" ? environment.summary : environment.recommendedAction}</small>
              </div>
              <span className={`agent-state state-${environment.status === "ready" ? "ready" : "attention"}`}>
                {environment.status === "ready" ? "pronto" : "atencao"}
              </span>
            </article>
          ))}
        </div>
        <div className="routing-table">
          <div className="routing-heading">
            <strong>Prioridade por funcao</strong>
            <small>Escolha o primeiro provider, modelo preferido e regra de fallback.</small>
          </div>
          {policy?.capabilities.map((routing) => {
            const primaryProviderId = routing.order[0];
            const primaryModels = availableModels[primaryProviderId] ?? [];
            return (
              <div className="routing-row" key={routing.capability}>
                <strong>{capabilityLabel(routing.capability)}</strong>
                <label>
                  Primeiro
                  <select
                    value={primaryProviderId}
                    disabled={busy !== null}
                    onChange={(event) =>
                      void changeRouting(
                        routing.capability,
                        event.target.value as AgentProviderId,
                        routing.requiredProviderId,
                        routing.preferredModel
                      )
                    }
                  >
                    {providers.map((provider) => (
                      <option value={provider.id} key={provider.id}>
                        {provider.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Modelo
                  <select
                    value={routing.preferredModel ?? "auto"}
                    disabled={busy !== null}
                    onChange={(event) =>
                      void changeRouting(
                        routing.capability,
                        routing.order[0],
                        routing.requiredProviderId,
                        event.target.value === "auto" ? null : event.target.value
                      )
                    }
                  >
                    <option value="auto">Auto (Default)</option>
                    {primaryModels.map((m) => (
                      <option value={m} key={m}>
                        {m}
                      </option>
                    ))}
                    {routing.preferredModel && !primaryModels.includes(routing.preferredModel) ? (
                      <option value={routing.preferredModel}>{routing.preferredModel}</option>
                    ) : null}
                  </select>
                </label>
                <label>
                  Regra
                  <select
                    value={routing.requiredProviderId ?? "auto"}
                    disabled={busy !== null}
                    onChange={(event) =>
                      void changeRouting(
                        routing.capability,
                        routing.order[0],
                        event.target.value === "auto" ? null : (event.target.value as AgentProviderId),
                        routing.preferredModel
                      )
                    }
                  >
                    <option value="auto">Fallback automatico</option>
                    {providers.map((provider) => (
                      <option value={provider.id} key={provider.id}>
                        Somente {provider.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
