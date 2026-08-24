import { DashboardData } from "../api";
import { Icon } from "../components/Icon";
import { ImprovementLab } from "../components/ImprovementLab";
import { OperationalChatConsole } from "../components/OperationalChatConsole";
import { SectionHeader } from "../components/SectionHeader";
import { TelegramConnectCard } from "../components/TelegramConnectCard";
import { LanguageSelector } from "../components/LanguageSelector";
import { translate } from "../i18n";

export interface SettingsPageProps {
  data: DashboardData;
  onRefresh: () => Promise<unknown>;
}

export function SettingsPage({ data, onRefresh }: SettingsPageProps) {
  return (
    <div className="settings-page-grid" style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
      <div className="panel" style={{ padding: "20px" }}>
        <SectionHeader eyebrow={translate("Language preference")} title={translate("Language")} meta={translate("English")} />
        <LanguageSelector />
      </div>
      <TelegramConnectCard agents={data.agents} onChanged={onRefresh} />

      <div className="panel settings-autopilot-card" style={{ padding: "20px" }}>
        <SectionHeader eyebrow={translate("Autonomy")} title={translate("Autopilot settings")} meta={`${translate("state")}: ${data.autopilot.state}`} />
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: "16px", marginTop: "16px" }}>
          <div style={{ padding: "16px", background: "rgba(255,255,255,0.02)", borderRadius: "8px", border: "1px solid #2e323e" }}>
            <span style={{ fontSize: "12px", color: "#a0a5b5", textTransform: "uppercase" }}>{translate("Autopilot status")}</span>
            <div style={{ display: "flex", alignItems: "center", gap: "10px", marginTop: "6px" }}>
              <span className={`sync-dot ${data.autopilot.enabled ? "" : "is-offline"}`} />
              <strong style={{ color: "#fff", fontSize: "18px" }}>
                {data.autopilot.enabled ? translate("Enabled") : translate("Disabled")}
              </strong>
            </div>
            <p style={{ fontSize: "13px", color: "#808595", marginTop: "8px", marginBottom: 0 }}>
              {data.autopilot.enabled
                ? translate("Maestro automatically selects and advances eligible tasks from the queue.")
                : translate("Waiting for manual goal activation from the panel.")}
            </p>
          </div>

          <div style={{ padding: "16px", background: "rgba(255,255,255,0.02)", borderRadius: "8px", border: "1px solid #2e323e" }}>
            <span style={{ fontSize: "12px", color: "#a0a5b5", textTransform: "uppercase" }}>{translate("Daemon access mode")}</span>
            <div style={{ display: "flex", alignItems: "center", gap: "10px", marginTop: "6px" }}>
              <Icon name="shield" />
              <strong style={{ color: "#fff", fontSize: "18px" }}>
                {data.daemon.access === "restricted" ? translate("Restricted access (local sandbox)") : translate("Full access")}
              </strong>
            </div>
            <p style={{ fontSize: "13px", color: "#808595", marginTop: "8px", marginBottom: 0 }}>
              {translate("Worktrees isolate script execution and prevent mutations without confirmation.")}
            </p>
          </div>
        </div>
      </div>

      <OperationalChatConsole projects={data.projects} onChanged={onRefresh} />

      <ImprovementLab improvements={data.improvements} onChanged={onRefresh} />
    </div>
  );
}
