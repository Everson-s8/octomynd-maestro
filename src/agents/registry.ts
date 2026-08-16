import {
  AgentCapability,
  AgentExecutionResult,
  AgentHealth,
  AgentProvider,
  AgentProviderId
} from "./types.js";
import type { FailureCategory } from "./failure.js";
import {
  ProviderPolicySnapshot,
  ProviderPolicyStore,
  defaultProviderPolicySnapshot,
  resolveProviderOrder
} from "./policy.js";


export type RoutedAgent = {
  provider: AgentProvider;
  health: AgentHealth;
  model?: string | null;
};

export type AgentLease = RoutedAgent & {
  release(feedback?: Pick<AgentExecutionResult, "retryable" | "summary" | "failureCategory"> & {
    retryAfterMs?: number;
  }): void;
};

export type ProviderAvailabilityWait = {
  reason: FailureCategory;
  retryAfterMs: number;
  provider: AgentProviderId | null;
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
  models?: string[];
  currentModel?: string | null;
  control: {
    mode: "enabled" | "paused" | "disabled";
    fallbackEnabled: boolean;
    model?: string | null;
  };
};

type ProviderCooldown = {
  until: number;
  detail: string;
  reason: FailureCategory;
};

export class AgentRegistry {
  private readonly providers = new Map<AgentProviderId, AgentProvider>();
  private readonly activeLeases = new Map<AgentProviderId, number>();
  private readonly cooldowns = new Map<AgentProviderId, ProviderCooldown>();

  constructor(
    providers: AgentProvider[],
    private readonly providerLimits: Partial<Record<AgentProviderId, number>> = {
      codex: 1,
      claude: 1,
      antigravity: 1
    },
    private readonly now: () => number = Date.now,
    private readonly policyStore?: ProviderPolicyStore
  ) {
    for (const provider of providers) {
      this.registerProvider(provider);
    }
  }

  registerProvider(provider: AgentProvider, limit = 1): void {
    if (this.providers.has(provider.id)) {
      throw new Error(`Duplicate agent provider: ${provider.id}`);
    }
    this.providers.set(provider.id, provider);
    this.providerLimits[provider.id] = Math.max(1, limit);
  }

  replaceProvider(provider: AgentProvider, limit = 1): void {
    if (!this.providers.has(provider.id)) {
      throw new Error(`Provider ${provider.id} is not registered.`);
    }
    if ((this.activeLeases.get(provider.id) ?? 0) > 0) {
      throw new Error(`Provider ${provider.id} has active work and cannot be updated.`);
    }
    this.providers.set(provider.id, provider);
    this.providerLimits[provider.id] = Math.max(1, limit);
    this.cooldowns.delete(provider.id);
  }

  unregisterProvider(providerId: AgentProviderId): ProviderPolicySnapshot {
    if ((this.activeLeases.get(providerId) ?? 0) > 0) {
      throw new Error(`Provider ${providerId} has active work and cannot be removed.`);
    }
    if (!this.providers.delete(providerId)) {
      throw new Error(`Provider ${providerId} is not registered.`);
    }
    this.cooldowns.delete(providerId);
    delete this.providerLimits[providerId];
    return this.policyStore?.removeProvider(providerId) ?? defaultProviderPolicySnapshot();
  }

  list(): AgentProvider[] {
    return [...this.providers.values()];
  }

  async route(
    capability: AgentCapability,
    excluded: ReadonlySet<AgentProviderId> = new Set()
  ): Promise<RoutedAgent | null> {
    for (const providerId of this.providerOrder(capability)) {
      if (excluded.has(providerId)) continue;
      if (this.activeCooldown(providerId)) continue;
      const provider = this.providers.get(providerId);
      if (!provider || !provider.capabilities.has(capability)) continue;
      const health = await provider.health();
      if (health.state === "ready") {
        const model = this.resolveModelForExecution(providerId, capability);
        return { provider, health, model };
      }
    }
    return null;
  }

  async acquire(
    capability: AgentCapability,
    excluded: ReadonlySet<AgentProviderId> = new Set()
  ): Promise<AgentLease | null> {
    for (const providerId of this.providerOrder(capability)) {
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
      const model = this.resolveModelForExecution(providerId, capability);
      return {
        provider,
        health,
        model,
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
              detail: feedback.summary || "Provider em cooldown apos falha transitoria.",
              reason: feedback.failureCategory ?? "unknown"
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

  async nextAvailability(
    capability: AgentCapability,
    excluded: ReadonlySet<AgentProviderId> = new Set()
  ): Promise<ProviderAvailabilityWait> {
    const candidates: ProviderAvailabilityWait[] = [];
    for (const providerId of this.providerOrder(capability)) {
      if (excluded.has(providerId)) continue;
      const provider = this.providers.get(providerId);
      if (!provider || !provider.capabilities.has(capability)) continue;
      const cooldown = this.activeCooldown(providerId);
      if (cooldown) {
        candidates.push({
          reason: cooldown.reason,
          retryAfterMs: Math.max(1_000, cooldown.until - this.now()),
          provider: providerId
        });
        continue;
      }
      const limit = Math.max(1, this.providerLimits[providerId] ?? 1);
      if ((this.activeLeases.get(providerId) ?? 0) >= limit) {
        candidates.push({ reason: "capacity", retryAfterMs: 5_000, provider: providerId });
        continue;
      }
      const health = await provider.health();
      if (health.state === "ready") {
        candidates.push({ reason: "capacity", retryAfterMs: 1_000, provider: providerId });
      } else if (health.state === "quota") {
        candidates.push({ reason: "quota", retryAfterMs: 10 * 60_000, provider: providerId });
      } else if (health.state === "auth_required") {
        candidates.push({ reason: "auth_required", retryAfterMs: 10 * 60_000, provider: providerId });
      } else {
        candidates.push({ reason: "offline", retryAfterMs: 60_000, provider: providerId });
      }
    }
    return candidates.sort((left, right) => left.retryAfterMs - right.retryAfterMs)[0]
      ?? { reason: "offline", retryAfterMs: 60_000, provider: null };
  }

  async snapshot(): Promise<AgentProviderSnapshot[]> {
    const policy = this.policySnapshot();
    const controls = new Map(policy.controls.map((control) => [control.providerId, control]));
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
      const availableModels = provider.models ? await provider.models() : [];
      const configuredModel = controls.get(provider.id)?.model ?? provider.model ?? null;
      return {
        id: provider.id,
        label: provider.label,
        capabilities: [...provider.capabilities],
        health,
        state,
        activeCount,
        cooldownUntil: cooldown ? new Date(cooldown.until).toISOString() : null,
        detail: cooldown?.detail ?? health.detail,
        models: availableModels,
        currentModel: configuredModel,
        control: {
          mode: controls.get(provider.id)?.mode ?? "enabled",
          fallbackEnabled: controls.get(provider.id)?.fallbackEnabled ?? true,
          model: configuredModel
        }
      };
    }));
  }

  async getAvailableModels(): Promise<Record<AgentProviderId, string[]>> {
    const result: Record<string, string[]> = {};
    let catalogModels: Record<string, string[]> | null = null;
    for (const provider of this.list()) {
      // models.dev is the primary source of model ids per provider (mirrors
      // Hermes); fall back to the provider's own discovery/curated list.
      let models: string[] = [];
      if (catalogModels === null) {
        try {
          const { availableModelsFor } = await import("./models-catalog.js");
          catalogModels = {};
          const seen = new Set<string>();
          const list = this.list();
          for (const p of list) {
            const m = await availableModelsFor(p.id, (p as { defaultEndpoint?: string | null }).defaultEndpoint ?? (p as unknown as { config?: { endpointUrl?: string | null } }).config?.endpointUrl ?? null);
            if (m.length > 0) {
              catalogModels[p.id] = m;
              seen.add(p.id);
            }
          }
        } catch {
          catalogModels = {};
        }
      }
      models = catalogModels[provider.id] ?? [];
      if (models.length === 0) {
        models = provider.models ? await provider.models() : [];
      }
      result[provider.id] = models;
    }
    return result;
  }

  policySnapshot(): ProviderPolicySnapshot {
    return this.policyStore?.getProviderPolicySnapshot() ?? defaultProviderPolicySnapshot();
  }

  updateProviderControl(...args: Parameters<ProviderPolicyStore["updateProviderControl"]>) {
    if (!this.policyStore) throw new Error("Provider policy store is unavailable.");
    return this.policyStore.updateProviderControl(...args);
  }

  updateProviderControls(...args: Parameters<ProviderPolicyStore["updateProviderControls"]>) {
    if (!this.policyStore) throw new Error("Provider policy persistence is unavailable.");
    return this.policyStore.updateProviderControls(...args);
  }

  updateCapabilityRouting(...args: Parameters<ProviderPolicyStore["updateCapabilityRouting"]>) {
    if (!this.policyStore) throw new Error("Provider policy store is unavailable.");
    return this.policyStore.updateCapabilityRouting(...args);
  }

  private resolveModelForExecution(providerId: AgentProviderId, capability?: AgentCapability): string | null {
    const policy = this.policySnapshot();
    if (capability) {
      const capabilityRouting = policy.capabilities.find((c) => c.capability === capability);
      if (capabilityRouting?.preferredModel) {
        return capabilityRouting.preferredModel;
      }
    }
    const control = policy.controls.find((c) => c.providerId === providerId);
    if (control?.model) {
      return control.model;
    }
    const provider = this.providers.get(providerId);
    return provider?.model ?? null;
  }

  private providerOrder(capability: AgentCapability): AgentProviderId[] {
    return resolveProviderOrder(capability, this.policySnapshot(), [...this.providers.keys()]);
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
