import { useCallback, useEffect, useState } from "react";
import {
  AgentCapability,
  AgentProviderId,
  DashboardData,
  fetchProviderPolicy,
  ProviderPolicySnapshot,
  updateCapabilityRouting,
} from "../api";
import { capabilityLabel } from "../helpers";
import { translate } from "../i18n";

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
    preferredModel?: string | null
  ) => {
    const current = (policy?.capabilities ?? []).find((item) => item.capability === capability);
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
            return (
              <div className="routing-row" key={routing.capability}>
                <div className="rname">{capabilityLabel(routing.capability)}</div>
                <div><div className="field-lbl">{translate("First")}</div>
                  <select className="sel"
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
                </div>
                <div><div className="field-lbl">{translate("Rule")}</div><select className="sel"
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
