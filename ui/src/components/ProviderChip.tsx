import { agentStateLabel, heroAgentChip, AgentDisplayState } from "../agentPresentation";
import { DashboardData } from "../api";

export function ProviderChip({
  label,
  state,
  providerId
}: {
  label: string;
  state: AgentDisplayState;
  providerId: string;
}) {
  return (
    <span className={`agent-satellite satellite-${providerId}`}>
      {label}
      <small>{agentStateLabel(state)}</small>
    </span>
  );
}

export function AgentProviderBar({ agents }: { agents: DashboardData["agents"] }) {
  const codexChip = heroAgentChip(agents, "codex", "Codex");
  const claudeChip = heroAgentChip(agents, "claude", "Claude");

  return (
    <div className="provider-status-bar" style={{ display: "flex", gap: "12px", flexWrap: "wrap", alignItems: "center" }}>
      <ProviderChip label={codexChip.label} state={codexChip.state} providerId="codex" />
      <ProviderChip label={claudeChip.label} state={claudeChip.state} providerId="claude" />
      <ProviderChip label="Telegram" state="ready" providerId="telegram" />
    </div>
  );
}
