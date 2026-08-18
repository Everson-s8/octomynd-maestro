import { useCallback, useEffect, useState } from "react";
import { DashboardData, fetchProviderPolicy, ProviderPolicySnapshot } from "../api";
import { AgentDock } from "../components/AgentDock";
import { ProviderManager } from "../components/ProviderManager";

export interface ProvidersPageProps {
  data: DashboardData;
}

export function ProvidersPage({ data }: ProvidersPageProps) {
  const [policy, setPolicy] = useState<ProviderPolicySnapshot | null>(null);

  const refreshPolicy = useCallback(async () => {
    try {
      setPolicy(await fetchProviderPolicy());
    } catch {
      // keep last known policy on transient failure
    }
  }, []);

  useEffect(() => {
    void refreshPolicy();
  }, [refreshPolicy]);

  return (
    <div className="providers-page">
      <div className="top">
        <div>
          <div className="eyebrow">AI Routing</div>
          <h1>Providers</h1>
        </div>
      </div>
      <p className="desc">
        Conecte quantos providers quiser — modelos de nuvem, locais ou endpoints customizados — e
        defina a ordem de prioridade por função.
      </p>
      <div className="prov-grid">
        <ProviderManager agents={data.agents} externalPolicy={policy} policyVersion={policy?.controls.map((c) => `${c.providerId}:${c.mode}`).join("|") ?? ""} setPolicy={setPolicy} onPolicyChanged={refreshPolicy} />
        <AgentDock agents={data.agents} policy={policy} onPolicyChanged={refreshPolicy} />
      </div>
    </div>
  );
}
