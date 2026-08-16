import { DashboardData } from "../api";
import { AgentDock } from "../components/AgentDock";
import { ProviderManager } from "../components/ProviderManager";

export interface ProvidersPageProps {
  data: DashboardData;
}

export function ProvidersPage({ data }: ProvidersPageProps) {
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
        <ProviderManager agents={data.agents} />
        <AgentDock agents={data.agents} />
      </div>
    </div>
  );
}
