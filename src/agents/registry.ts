import {
  AgentCapability,
  AgentExecutionResult,
  AgentHealth,
  AgentProvider,
  AgentProviderId
} from "./types.js";

const ROUTING_ORDER: Record<AgentCapability, AgentProviderId[]> = {
  planning: ["claude", "codex"],
  coding: ["codex", "claude"],
  testing: ["codex", "claude"],
  reviewing: ["claude", "codex"],
  improvement_reviewing: ["claude", "codex"],
  research: ["claude", "codex"],
  conversation: ["claude", "codex"]
};

export type RoutedAgent = {
  provider: AgentProvider;
  health: AgentHealth;
};

export type AgentLease = RoutedAgent & {
  release(feedback?: Pick<AgentExecutionResult, "retryable" | "summary"> & {
    retryAfterMs?: number;
  }): void;
};

export type AgentOperationalState = AgentHealth["state"] | "working" | "cooldown";

export type AgentProviderSnapshot = {
  id: AgentProviderId;
  label: string;
  capabilities: AgentCapability[];
  health: AgentHealth;
  state: AgentOperationalState;
  activeCount: number;
  cooldownUntil: string | null;
  detail: string;
};

type ProviderCooldown = {
  until: number;
  detail: string;
};

export class AgentRegistry {
  private readonly providers = new Map<AgentProviderId, AgentProvider>();
  private readonly activeLeases = new Map<AgentProviderId, number>();
  private readonly cooldowns = new Map<AgentProviderId, ProviderCooldown>();

  constructor(
    providers: AgentProvider[],
    private readonly providerLimits: Partial<Record<AgentProviderId, number>> = { codex: 1, claude: 1 },
    private readonly now: () => number = Date.now
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
      if (this.activeCooldown(providerId)) continue;
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
      if (this.activeCooldown(providerId)) continue;
      const provider = this.providers.get(providerId);
      if (!provider || !provider.capabilities.has(capability)) continue;
      const limit = Math.max(1, this.providerLimits[providerId] ?? 1);
      if ((this.activeLeases.get(providerId) ?? 0) >= limit) continue;
      const health = await provider.health();
      if (health.state !== "ready") continue;
      if ((this.activeLeases.get(providerId) ?? 0) >= limit) continue;
      this.activeLeases.set(providerId, (this.activeLeases.get(providerId) ?? 0) + 1);
      let released = false;
      return {
        provider,
        health,
        release: (feedback) => {
          if (released) return;
          released = true;
          const remaining = Math.max(0, (this.activeLeases.get(providerId) ?? 1) - 1);
          if (remaining === 0) this.activeLeases.delete(providerId);
          else this.activeLeases.set(providerId, remaining);
          if (feedback?.retryable && feedback.retryAfterMs) {
            const retryAfterMs = Math.max(1_000, feedback.retryAfterMs);
            this.cooldowns.set(providerId, {
              until: this.now() + retryAfterMs,
              detail: feedback.summary || "Provider em cooldown apos falha transitoria."
            });
          }
        }
      };
    }
    return null;
  }

  activeCount(providerId: AgentProviderId): number {
    return this.activeLeases.get(providerId) ?? 0;
  }

  async snapshot(): Promise<AgentProviderSnapshot[]> {
    return Promise.all(this.list().map(async (provider) => {
      const health = await provider.health();
      const activeCount = this.activeCount(provider.id);
      const cooldown = this.activeCooldown(provider.id);
      const state: AgentOperationalState = health.state !== "ready"
        ? health.state
        : activeCount > 0
          ? "working"
          : cooldown
            ? "cooldown"
            : "ready";
      return {
        id: provider.id,
        label: provider.label,
        capabilities: [...provider.capabilities],
        health,
        state,
        activeCount,
        cooldownUntil: cooldown ? new Date(cooldown.until).toISOString() : null,
        detail: cooldown?.detail ?? health.detail
      };
    }));
  }

  private activeCooldown(providerId: AgentProviderId): ProviderCooldown | null {
    const cooldown = this.cooldowns.get(providerId);
    if (!cooldown) return null;
    if (cooldown.until <= this.now()) {
      this.cooldowns.delete(providerId);
      return null;
    }
    return cooldown;
  }
}
