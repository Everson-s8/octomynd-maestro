import { describe, expect, it } from "vitest";
import { runProviderReview } from "../src/agents/review-runner.js";
import type { AgentProvider } from "../src/agents/types.js";
import { AgentRegistry } from "../src/agents/registry.js";
import type { ProjectRecord, TaskRecord } from "../src/db.js";

function project(): ProjectRecord {
  return {
    id: 1,
    key: "maestro",
    name: "Octomynd Maestro",
    path: "C:/repo/maestro",
    defaultBranch: "main",
    createdAt: "now",
    updatedAt: "now"
  };
}

function task(): TaskRecord {
  return {
    id: 9,
    projectId: 1,
    projectKey: "maestro",
    projectName: "Octomynd Maestro",
    text: "revisar",
    status: "reviewing",
    source: "dashboard",
    branchName: "maestro/task-9",
    worktreePath: "C:/worktrees/task-9",
    createdAt: "now",
    updatedAt: "now"
  };
}

function reviewingProvider(id: string, label: string, captured: { phase: string[] }): AgentProvider {
  return {
    id,
    label,
    capabilities: new Set(["reviewing"]),
    health: async () => ({ state: "ready", detail: "test", checkedAt: new Date().toISOString() }),
    execute: async (request) => {
      captured.phase.push(request.phase);
      return {
        outcome: "completed",
        summary: "ok",
        output: "aprovado",
        error: null,
        durationMs: 5,
        retryable: false
      };
    }
  };
}

describe("runProviderReview", () => {
  it("routes the review through the policy-selected provider, not Claude", async () => {
    const captured = { phase: [] as string[] };
    // Only CODE X is registered — no claude provider at all.
    const registry = new AgentRegistry([reviewingProvider("codex", "Codex", captured)]);

    const result = await runProviderReview(registry, task(), project());

    expect(result.provider).toBe("codex");
    expect(result.status).toBe("completed");
    expect(result.content).toBe("aprovado");
    expect(captured.phase).toEqual(["reviewing"]);
  });

  it("honours the routing order when multiple providers are enabled", async () => {
    const captured = { phase: [] as string[] };
    const registry = new AgentRegistry([
      reviewingProvider("claude", "Claude", captured),
      reviewingProvider("codex", "Codex", captured)
    ]);

    await runProviderReview(registry, task(), project());

    // Default reviewing order is ["claude", "antigravity", "codex"].
    expect(captured.phase).toEqual(["reviewing"]);
  });

  it("reports a failure when no reviewing provider is ready", async () => {
    const offline = reviewingProvider("codex", "Codex", { phase: [] });
    offline.health = async () => ({ state: "offline", detail: "desconectado", checkedAt: new Date().toISOString() });
    const registry = new AgentRegistry([offline]);

    const result = await runProviderReview(registry, task(), project());

    expect(result.status).toBe("failed");
    expect(result.provider).toBe("maestro");
    expect(result.error).toContain("Nenhum provider");
  });
});
