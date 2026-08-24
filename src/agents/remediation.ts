import { AgentHealthState, AgentProviderId } from "./types.js";

type RemediableProviderId = "codex" | "claude";

export const INSTALL_COMMANDS: Record<RemediableProviderId, string> = {
  codex: "npm install -g @openai/codex",
  claude: "npm install -g @anthropic-ai/claude-code"
};

export const LOGIN_COMMANDS: Record<RemediableProviderId, string> = {
  codex: "codex login",
  claude: "claude login"
};

function isRemediableProvider(providerId: AgentProviderId): providerId is RemediableProviderId {
  return providerId === "codex" || providerId === "claude";
}

export function remediationHint(providerId: AgentProviderId, state: AgentHealthState): string | null {
  if (!isRemediableProvider(providerId)) return null;
  if (state === "offline") {
    return `Install with "${INSTALL_COMMANDS[providerId]}" and then authenticate with "${LOGIN_COMMANDS[providerId]}".`;
  }
  if (state === "auth_required") {
    return `Authenticate with "${LOGIN_COMMANDS[providerId]}".`;
  }
  if (state === "quota") {
    return "Wait for the provider quota to renew before trying again.";
  }
  return null;
}

export function withRemediation(providerId: AgentProviderId, state: AgentHealthState, detail: string): string {
  const hint = remediationHint(providerId, state);
  if (!hint) return detail;
  const separator = /[.!?]$/.test(detail.trim()) ? " " : ". ";
  return `${detail}${separator}${hint}`;
}
