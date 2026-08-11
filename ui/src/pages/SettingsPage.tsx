import { DashboardData } from "../api";
import { ImprovementLab } from "../components/ImprovementLab";
import { OperationalChatConsole } from "../components/OperationalChatConsole";
import { SectionHeader } from "../components/SectionHeader";
import { Icon } from "../components/Icon";

export interface SettingsPageProps {
  data: DashboardData;
  onRefresh: () => Promise<unknown>;
}

export function SettingsPage({ data, onRefresh }: SettingsPageProps) {
  return (
    <div className="settings-page-grid" style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
      <div className="panel settings-autopilot-card" style={{ padding: "20px" }}>
        <SectionHeader eyebrow="Autonomia" title="Configuração do Autopilot" meta={`Estado: ${data.autopilot.state}`} />
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: "16px", marginTop: "16px" }}>
          <div style={{ padding: "16px", background: "rgba(255,255,255,0.02)", borderRadius: "8px", border: "1px solid #2e323e" }}>
            <span style={{ fontSize: "12px", color: "#a0a5b5", textTransform: "uppercase" }}>Autopilot Status</span>
            <div style={{ display: "flex", alignItems: "center", gap: "10px", marginTop: "6px" }}>
              <span className={`sync-dot ${data.autopilot.enabled ? "" : "is-offline"}`} />
              <strong style={{ color: "#fff", fontSize: "18px" }}>
                {data.autopilot.enabled ? "Ativo (Habilitado)" : "Desabilitado"}
              </strong>
            </div>
            <p style={{ fontSize: "13px", color: "#808595", marginTop: "8px", marginBottom: 0 }}>
              {data.autopilot.enabled
                ? "O Maestro seleciona e avança automaticamente tasks elegíveis da fila."
                : "Aguardando ativação manual de goals pelo painel."}
            </p>
          </div>

          <div style={{ padding: "16px", background: "rgba(255,255,255,0.02)", borderRadius: "8px", border: "1px solid #2e323e" }}>
            <span style={{ fontSize: "12px", color: "#a0a5b5", textTransform: "uppercase" }}>Modo de Acesso do Daemon</span>
            <div style={{ display: "flex", alignItems: "center", gap: "10px", marginTop: "6px" }}>
              <Icon name="shield" />
              <strong style={{ color: "#fff", fontSize: "18px" }}>
                {data.daemon.access === "restricted" ? "Acesso Restrito (Sandbox local)" : "Acesso Completo"}
              </strong>
            </div>
            <p style={{ fontSize: "13px", color: "#808595", marginTop: "8px", marginBottom: 0 }}>
              As worktrees isolam a execução de scripts e previnem mutações sem confirmação.
            </p>
          </div>
        </div>
      </div>

      <OperationalChatConsole projects={data.projects} onChanged={onRefresh} />

      <ImprovementLab improvements={data.improvements} onChanged={onRefresh} />
    </div>
  );
}
