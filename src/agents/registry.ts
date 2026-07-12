import {
  AgentCapability,
  AgentHealth,
  AgentProvider,
  AgentProviderId
} from "./types.js";

const ROUTING_ORDER: Record<AgentCapability, AgentProviderId[]> = {
  planning: ["claude", "codex"],
  coding: ["codex", "claude"],
  testing: ["codex", "claude"],
  reviewing: ["claude", "codex"],
  research: ["claude", "codex"],
  conversation: ["claude", "codex"]
};

export type RoutedAgent = {
  provider: AgentProvider;
  health: AgentHealth;
};

export class AgentRegistry {
  private readonly providers = new Map<AgentProviderId, AgentProvider>();

  constructor(providers: AgentProvider[]) {
    for (const provider of providers) {
      if (this.providers.has(provider.id)) {
        throw new Error(`Duplicate agent provider: ${provider.id}`);
      }
      this.providers.set(provider.id, provider);
    }
  }

  list(): AgentProvider[] {
    return [...this.providers.values()];
  }

  async route(
    capability: AgentCapability,
    excluded: ReadonlySet<AgentProviderId> = new Set()
  ): Promise<RoutedAgent | null> {
    for (const providerId of ROUTING_ORDER[capability]) {
      if (excluded.has(providerId)) continue;
      const provider = this.providers.get(providerId);
      if (!provider || !provider.capabilities.has(capability)) continue;
      const health = await provider.health();
      if (health.state === "ready") {
        return { provider, health };
      }
    }
    return null;
  }

  async snapshot(): Promise<Array<{
    id: AgentProviderId;
    label: string;
    capabilities: AgentCapability[];
    health: AgentHealth;
  }>> {
    return Promise.all(this.list().map(async (provider) => ({
      id: provider.id,
      label: provider.label,
      capabilities: [...provider.capabilities],
      health: await provider.health()
    })));
  }
}
