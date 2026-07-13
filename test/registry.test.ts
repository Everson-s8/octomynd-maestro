import { describe, expect, it } from "vitest";
import { AgentRegistry } from "../src/agents/registry.js";
import { AgentCapability, AgentExecutionResult, AgentProvider, AgentProviderId } from "../src/agents/types.js";

describe("agent registry leases", () => {
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
