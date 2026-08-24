import { describe, expect, it } from "vitest";
import { agentStateLabel, AgentPresenceEntry, heroAgentChip } from "../ui/src/agentPresentation.js";

function agent(overrides: Partial<AgentPresenceEntry> = {}): AgentPresenceEntry {
  return {
    id: "codex",
    label: "Codex",
    state: "ready",
    detail: "Codex CLI disponivel",
    ...overrides
  };
}

describe("agentStateLabel", () => {
  it("maps every dashboard state to the same labels used across the panels", () => {
    expect(agentStateLabel("ready")).toBe("Ready");
    expect(agentStateLabel("working")).toBe("Working");
    expect(agentStateLabel("attention")).toBe("Attention");
    expect(agentStateLabel("offline")).toBe("Offline");
  });
});

describe("heroAgentChip", () => {
  it("reflects the real state of a present agent", () => {
    const agents = [
      agent({ id: "codex", state: "working" }),
      agent({ id: "claude", label: "Claude", state: "attention" })
    ];

    expect(heroAgentChip(agents, "codex", "Codex")).toEqual({ label: "Codex", state: "working" });
    expect(heroAgentChip(agents, "claude", "Claude")).toEqual({ label: "Claude", state: "attention" });
  });

  it("never fabricates readiness when the agent snapshot is missing", () => {
    const agents = [agent({ id: "claude", state: "ready" })];

    expect(heroAgentChip(agents, "codex", "Codex")).toEqual({ label: "Codex", state: "offline" });
  });

  it("renders an offline provider honestly instead of defaulting to ready", () => {
    const agents = [agent({ id: "codex", state: "offline" })];

    expect(heroAgentChip(agents, "codex", "Codex")).toEqual({ label: "Codex", state: "offline" });
  });
});
