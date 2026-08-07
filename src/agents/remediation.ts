import { AgentHealthState, AgentProviderId } from "./types.js";

type RemediableProviderId = "codex" | "claude";

const INSTALL_COMMANDS: Record<RemediableProviderId, string> = {
  codex: "npm install -g @openai/codex",
  claude: "npm install -g @anthropic-ai/claude-code"
};

const LOGIN_COMMANDS: Record<RemediableProviderId, string> = {
  codex: "codex login",
  claude: "claude login"
};

function isRemediableProvider(providerId: AgentProviderId): providerId is RemediableProviderId {
  return providerId === "codex" || providerId === "claude";
}

export function remediationHint(providerId: AgentProviderId, state: AgentHealthState): string | null {
  if (!isRemediableProvider(providerId)) return null;
  if (state === "offline") {
    return `Instale com "${INSTALL_COMMANDS[providerId]}" e depois autentique com "${LOGIN_COMMANDS[providerId]}".`;
  }
  if (state === "auth_required") {
    return `Autentique com "${LOGIN_COMMANDS[providerId]}".`;
  }
  if (state === "quota") {
    return "Aguarde a renovacao da cota do provider antes de tentar novamente.";
  }
  return null;
}

export function withRemediation(providerId: AgentProviderId, state: AgentHealthState, detail: string): string {
  const hint = remediationHint(providerId, state);
  return hint ? `${detail} ${hint}` : detail;
}
