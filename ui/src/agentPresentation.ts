import type { DashboardData } from "./api.js";

export type AgentPresenceEntry = DashboardData["agents"][number];
export type AgentDisplayState = AgentPresenceEntry["state"];

const STATE_LABELS: Record<AgentDisplayState, string> = {
  working: "trabalhando",
  ready: "pronto",
  attention: "atenção",
  offline: "offline"
};

export function agentStateLabel(state: AgentDisplayState): string {
  return STATE_LABELS[state] ?? STATE_LABELS.offline;
}

export function heroAgentChip(
  agents: AgentPresenceEntry[],
  id: AgentPresenceEntry["id"],
  fallbackLabel: string
): { label: string; state: AgentDisplayState } {
  const agent = agents.find((item) => item.id === id);
  if (!agent) return { label: fallbackLabel, state: "offline" };
  return { label: agent.label, state: agent.state };
}
