import { DashboardData } from "../api";
import { AgentDock } from "../components/AgentDock";
import { ProviderManager } from "../components/ProviderManager";
import { SectionHeader } from "../components/SectionHeader";

export interface ProvidersPageProps {
  data: DashboardData;
}

export function ProvidersPage({ data }: ProvidersPageProps) {
  return (
    <div className="providers-page-grid" style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
      <div className="panel providers-header-banner" style={{ padding: "20px" }}>
        <SectionHeader eyebrow="AI Routing" title="Gestão de Providers e Modelos" meta="Governança Multi-Provider" />
        <p style={{ color: "#a0a5b5", marginTop: "8px", marginBottom: 0, fontSize: "14px" }}>
          Configure a ordem de prioridade de cada provider (Codex, Claude, Antigravity) para planejamento, coding, testes e review. Alterne entre modos ativas, pausadas ou fallback exclusivo.
        </p>
      </div>

      <AgentDock agents={data.agents} environments={data.environments} />
      <ProviderManager />
    </div>
  );
}
