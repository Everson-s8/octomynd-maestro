import type { AgentCapability, AgentProviderId } from "./types.js";

export type ProviderMode = "enabled" | "paused" | "disabled";

export type ProviderControl = {
  providerId: AgentProviderId;
  mode: ProviderMode;
  fallbackEnabled: boolean;
  model?: string | null;
  updatedAt: string | null;
};

export type CapabilityRoutingPolicy = {
  capability: AgentCapability;
  order: AgentProviderId[];
  requiredProviderId: AgentProviderId | null;
  preferredModel?: string | null;
  updatedAt: string | null;
};

export type ProviderPolicySnapshot = {
  controls: ProviderControl[];
  capabilities: CapabilityRoutingPolicy[];
  models?: Record<AgentProviderId, string[]>;
};

export type ProviderControlUpdate = Pick<ProviderControl, "providerId" | "mode" | "fallbackEnabled"> & {
  model?: string | null;
};
export type CapabilityRoutingUpdate = Pick<CapabilityRoutingPolicy, "capability" | "order" | "requiredProviderId"> & {
  preferredModel?: string | null;
};

export interface ProviderPolicyStore {
  getProviderPolicySnapshot(): ProviderPolicySnapshot;
  updateProviderControl(input: ProviderControlUpdate): ProviderControl;
  updateProviderControls(inputs: ProviderControlUpdate[]): ProviderControl[];
  updateCapabilityRouting(input: CapabilityRoutingUpdate): CapabilityRoutingPolicy;
}

export const DEFAULT_ROUTING_ORDER: Record<AgentCapability, AgentProviderId[]> = {
  planning: ["antigravity", "claude", "codex"],
  coding: ["antigravity", "codex", "claude"],
  testing: ["antigravity", "codex", "claude"],
  reviewing: ["claude", "antigravity", "codex"],
  improvement_reviewing: ["antigravity", "claude", "codex"],
  research: ["antigravity", "claude", "codex"],
  conversation: ["antigravity", "claude", "codex"]
};

export function resolveProviderOrder(
  capability: AgentCapability,
  snapshot: ProviderPolicySnapshot,
  registeredProviderIds?: AgentProviderId[]
): AgentProviderId[] {
  const controls = new Map(snapshot.controls.map((control) => [control.providerId, control]));
  const routing = snapshot.capabilities.find((item) => item.capability === capability);
  const configuredOrder = routing?.order.length ? routing.order : DEFAULT_ROUTING_ORDER[capability];
  const extra = registeredProviderIds ?? [];
  const completeOrder = [...new Set([...configuredOrder, ...DEFAULT_ROUTING_ORDER[capability], ...extra])];
  const allowed = completeOrder.filter((providerId) => {
    const mode = controls.get(providerId)?.mode ?? "enabled";
    return mode === "enabled";
  });

  if (routing?.requiredProviderId) {
    return allowed.includes(routing.requiredProviderId) ? [routing.requiredProviderId] : [];
  }
  const first = allowed[0];
  if (first && controls.get(first)?.fallbackEnabled === false) return [first];
  return allowed;
}

export function defaultProviderPolicySnapshot(): ProviderPolicySnapshot {
  return {
    controls: [],
    capabilities: Object.entries(DEFAULT_ROUTING_ORDER).map(([capability, order]) => ({
      capability: capability as AgentCapability,
      order,
      requiredProviderId: null,
      preferredModel: null,
      updatedAt: null
    }))
  };
}
