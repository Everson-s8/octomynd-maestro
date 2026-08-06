import { describe, expect, it } from "vitest";
import { AgentRegistry } from "../src/agents/registry.js";
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
});

function provider(id: AgentProviderId, capabilities: AgentCapability[]): AgentProvider {
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
    health: async () => ({ state: "ready", detail: "test", checkedAt: new Date().toISOString() }),
    execute: async () => completed
  };
}
