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

export type AgentLease = RoutedAgent & {
  release(): void;
};

export class AgentRegistry {
  private readonly providers = new Map<AgentProviderId, AgentProvider>();
  private readonly activeLeases = new Map<AgentProviderId, number>();

  constructor(
    providers: AgentProvider[],
    private readonly providerLimits: Partial<Record<AgentProviderId, number>> = { codex: 1, claude: 1 }
  ) {
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

  async acquire(
    capability: AgentCapability,
    excluded: ReadonlySet<AgentProviderId> = new Set()
  ): Promise<AgentLease | null> {
    for (const providerId of ROUTING_ORDER[capability]) {
      if (excluded.has(providerId)) continue;
      const provider = this.providers.get(providerId);
      if (!provider || !provider.capabilities.has(capability)) continue;
      const limit = Math.max(1, this.providerLimits[providerId] ?? 1);
      if ((this.activeLeases.get(providerId) ?? 0) >= limit) continue;
      const health = await provider.health();
      if (health.state !== "ready") continue;
      this.activeLeases.set(providerId, (this.activeLeases.get(providerId) ?? 0) + 1);
      let released = false;
      return {
        provider,
        health,
        release: () => {
          if (released) return;
          released = true;
          const remaining = Math.max(0, (this.activeLeases.get(providerId) ?? 1) - 1);
          if (remaining === 0) this.activeLeases.delete(providerId);
          else this.activeLeases.set(providerId, remaining);
        }
      };
    }
    return null;
  }

  activeCount(providerId: AgentProviderId): number {
    return this.activeLeases.get(providerId) ?? 0;
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
