import { describe, expect, it } from "vitest";
import { AgentRegistry } from "../src/agents/registry.js";
import { defaultProviderPolicySnapshot, ProviderPolicyStore } from "../src/agents/policy.js";
import { AgentCapability, AgentExecutionResult, AgentProvider, AgentProviderId } from "../src/agents/types.js";

describe("agent registry leases", () => {
  it("prefers the subscription provider for general work and Claude for final review", async () => {
    const registry = new AgentRegistry([
      provider("codex", ["coding", "reviewing"]),
      provider("claude", ["coding", "reviewing"]),
      provider("antigravity", ["coding", "reviewing"])
    ]);

    expect((await registry.acquire("coding"))?.provider.id).toBe("antigravity");
    expect((await registry.acquire("reviewing"))?.provider.id).toBe("claude");
  });

  it("routes concurrent work to another provider and releases capacity", async () => {
    const claude = provider("claude", ["planning"]);
    const codex = provider("codex", ["planning"]);
    const registry = new AgentRegistry([codex, claude]);

    const first = await registry.acquire("planning");
    const second = await registry.acquire("planning");
    const third = await registry.acquire("planning");

    expect(first?.provider.id).toBe("claude");
    expect(second?.provider.id).toBe("codex");
    expect(third).toBeNull();
    expect(registry.activeCount("claude")).toBe(1);
    first?.release();
    first?.release();
    expect(registry.activeCount("claude")).toBe(0);
    expect((await registry.acquire("planning"))?.provider.id).toBe("claude");
    second?.release();
  });

  it("reports working state while a provider lease is active", async () => {
    const registry = new AgentRegistry([provider("claude", ["planning"])]);
    const lease = await registry.acquire("planning");

    expect((await registry.snapshot())[0]).toMatchObject({
      id: "claude",
      state: "working",
      activeCount: 1,
      cooldownUntil: null
    });

    lease?.release();
    expect((await registry.snapshot())[0]).toMatchObject({ state: "ready", activeCount: 0 });
  });

  it("skips a provider during retry cooldown and restores it after expiry", async () => {
    let now = 1_000;
    const claude = provider("claude", ["planning"]);
    const codex = provider("codex", ["planning"]);
    const registry = new AgentRegistry([claude, codex], undefined, () => now);
    const lease = await registry.acquire("planning");

    lease?.release({
      retryable: true,
      retryAfterMs: 30_000,
      summary: "Claude timed out.",
      failureCategory: "timeout"
    });

    expect((await registry.snapshot()).find((item) => item.id === "claude")).toMatchObject({
      state: "cooldown",
      activeCount: 0,
      detail: "Claude timed out."
    });
    expect((await registry.acquire("planning"))?.provider.id).toBe("codex");

    now += 30_001;
    expect((await registry.acquire("planning"))?.provider.id).toBe("claude");
  });

  it("chooses the earliest provider recovery instead of the last failure delay", async () => {
    let now = 1_000;
    const registry = new AgentRegistry(
      [provider("claude", ["coding"]), provider("codex", ["coding"])],
      undefined,
      () => now
    );
    const codex = await registry.acquire("coding");
    codex?.release({
      retryable: true,
      retryAfterMs: 15_000,
      summary: "Codex inactivity timeout.",
      failureCategory: "timeout"
    });
    const claude = await registry.acquire("coding");
    claude?.release({
      retryable: true,
      retryAfterMs: 10 * 60_000,
      summary: "Claude session limit.",
      failureCategory: "quota"
    });

    expect(await registry.nextAvailability("coding")).toEqual({
      reason: "timeout",
      retryAfterMs: 15_000,
      provider: "codex"
    });

    now += 15_001;
    expect((await registry.acquire("coding"))?.provider.id).toBe("codex");
  });

  it("honors persisted provider modes, priorities and strict routing", async () => {
    const policy = policyStore();
    policy.updateProviderControl({ providerId: "antigravity", mode: "paused", fallbackEnabled: true });
    policy.updateCapabilityRouting({
      capability: "coding",
      order: ["claude", "codex", "antigravity"],
      requiredProviderId: null
    });
    const registry = new AgentRegistry([
      provider("codex", ["coding"]),
      provider("claude", ["coding"]),
      provider("antigravity", ["coding"])
    ], undefined, Date.now, policy);

    expect((await registry.acquire("coding"))?.provider.id).toBe("claude");
    policy.updateProviderControl({ providerId: "claude", mode: "enabled", fallbackEnabled: false });
    expect(await registry.acquire("coding")).toBeNull();
    policy.updateCapabilityRouting({
      capability: "coding",
      order: ["codex", "claude", "antigravity"],
      requiredProviderId: "codex"
    });
    expect((await registry.acquire("coding"))?.provider.id).toBe("codex");
  });

  it("resolves model preference hierarchically: capability > provider control > provider default", async () => {
    const policy = policyStore();
    const codex = provider("codex", ["coding"], "codex-default", ["gpt-4o", "o3-mini"]);
    const registry = new AgentRegistry([codex], undefined, Date.now, policy);

    // 1. Provider default model
    let lease = await registry.acquire("coding");
    expect(lease?.model).toBe("codex-default");
    lease?.release();

    // 2. Provider control override
    policy.updateProviderControl({ providerId: "codex", mode: "enabled", fallbackEnabled: true, model: "gpt-4o" });
    lease = await registry.acquire("coding");
    expect(lease?.model).toBe("gpt-4o");
    lease?.release();

    // 3. Capability preferred model override
    policy.updateCapabilityRouting({
      capability: "coding",
      order: ["codex"],
      requiredProviderId: null,
      preferredModel: "o3-mini"
    });
    lease = await registry.acquire("coding");
    expect(lease?.model).toBe("o3-mini");
    lease?.release();

    // Check snapshot contains models and currentModel
    const snapshot = await registry.snapshot();
    expect(snapshot[0].models).toEqual(["gpt-4o", "o3-mini"]);
    expect(snapshot[0].currentModel).toBe("gpt-4o");

    const available = await registry.getAvailableModels();
    expect(available.codex).toEqual(["gpt-4o", "o3-mini"]);
  });
});

function policyStore(): ProviderPolicyStore {
  let snapshot = defaultProviderPolicySnapshot();
  return {
    getProviderPolicySnapshot: () => snapshot,
    updateProviderControl: (input) => {
      const control = { ...input, updatedAt: new Date().toISOString() };
      snapshot = {
        ...snapshot,
        controls: [...snapshot.controls.filter((item) => item.providerId !== input.providerId), control]
      };
      return control;
    },
    updateProviderControls: (inputs) => inputs.map((input) => {
      const control = { ...input, updatedAt: new Date().toISOString() };
      snapshot = {
        ...snapshot,
        controls: [...snapshot.controls.filter((item) => item.providerId !== input.providerId), control]
      };
      return control;
    }),
    updateCapabilityRouting: (input) => {
      const routing = { ...input, updatedAt: new Date().toISOString() };
      snapshot = {
        ...snapshot,
        capabilities: snapshot.capabilities.map((item) => item.capability === input.capability ? routing : item)
      };
      return routing;
    }
  };
}

function provider(
  id: AgentProviderId,
  capabilities: AgentCapability[],
  model?: string,
  modelsList?: string[]
): AgentProvider {
  const completed: AgentExecutionResult = {
    outcome: "completed",
    summary: "done",
    output: "done",
    error: null,
    durationMs: 1,
    retryable: false
  };
  return {
    id,
    label: id,
    capabilities: new Set(capabilities),
    ...(model !== undefined ? { model } : {}),
    ...(modelsList ? { models: async () => modelsList } : {}),
    health: async () => ({ state: "ready", detail: "test", checkedAt: new Date().toISOString() }),
    execute: async () => completed
  };
}
