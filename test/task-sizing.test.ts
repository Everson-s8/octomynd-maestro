import { describe, expect, it } from "vitest";
import { AgentRegistry } from "../src/agents/registry.js";
import type { AgentProvider, AgentExecutionRequest } from "../src/agents/types.js";
import { computeTaskDNAFromText } from "../src/goals/task-dna.js";
import { sizeTaskWithModel } from "../src/goals/task-sizing.js";
import type { ProjectRecord, TaskRecord } from "../src/db.js";

const project: ProjectRecord = {
  id: 1,
  key: "demo",
  name: "Demo",
  path: "C:\\demo",
  defaultBranch: "main",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString()
};

const task: TaskRecord = {
  id: 7,
  projectId: 1,
  projectKey: "demo",
  projectName: "Demo",
  text: "muda a cor do botão para azul",
  status: "queued",
  source: "test",
  branchName: null,
  worktreePath: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString()
};

function provider(output: string, onExecute?: (request: AgentExecutionRequest) => void): AgentProvider {
  return {
    id: "claude",
    label: "Claude",
    capabilities: new Set(["planning"]),
    health: async () => ({ state: "ready", detail: "test", checkedAt: new Date().toISOString() }),
    execute: async (request) => {
      onExecute?.(request);
      return {
        outcome: "completed",
        summary: "structured sizing",
        output,
        error: null,
        durationMs: 1,
        retryable: false,
        model: request.model ?? "claude-sonnet"
      };
    }
  };
}

describe("language-independent task sizing", () => {
  it("keeps the offline safety net cheaper for the five Portuguese examples", () => {
    const examples = [
      "arruma o bug do login",
      "muda a cor do botão para azul",
      "troca o texto Entrar por Acessar",
      "adiciona um campo de telefone",
      "o site está lento ao carregar a lista"
    ];
    const result = examples.map((text) => computeTaskDNAFromText(text));
    expect(result.map((dna) => dna.complexity)).not.toContain("medium");
    expect(result.map((dna) => Object.values(dna.phaseBudgets).reduce((sum, value) => sum + value, 0)))
      .toEqual([2, 5, 2, 2, 5]);
    expect(result.every((dna) => dna.rationale.startsWith("Offline estimate:"))).toBe(true);
  });

  it("uses one selected provider/model call and feeds its structured understanding into TaskDNA", async () => {
    let calls = 0;
    let prompt = "";
    const registry = new AgentRegistry([provider(
      '{"classification":"direct_task","estimatedFileTouchCount":1,"estimatedWorkstreamCount":1,"dependsOnCount":0,"requiresMultipleReviewGates":false,"acceptanceCriteria":["change one visual value"],"confidence":0.98}',
      (request) => { calls += 1; prompt = request.humanFeedback ?? ""; }
    )]);

    const result = await sizeTaskWithModel(registry, task, project, { providerId: "claude", model: "claude-sonnet" });

    expect(calls).toBe(1);
    expect(result.source).toBe("model");
    expect(result.providerId).toBe("claude");
    expect(result.model).toBe("claude-sonnet");
    expect(result.dna.complexity).toBe("trivial");
    expect(prompt).toContain("regardless of language");
  });

  it("sizes a large request written in a language outside the UI locales", async () => {
    const registry = new AgentRegistry([provider(
      '{"classification":"feature_plan","estimatedFileTouchCount":18,"estimatedWorkstreamCount":3,"dependsOnCount":2,"requiresMultipleReviewGates":true,"acceptanceCriteria":["one","two","three","four"],"confidence":0.91}'
    )]);
    const result = await sizeTaskWithModel(registry, { ...task, text: "ユーザー管理、請求、通知を統合する大規模な機能を作成してください" }, project);
    expect(result.source).toBe("model");
    expect(result.dna.complexity).toBe("large");
    expect(result.dna.phaseBudgets.implementing).toBe(8);
  });

  it("does not call a provider when offline sizing is preferred", async () => {
    let calls = 0;
    const registry = new AgentRegistry([provider("{}", () => { calls += 1; })]);
    const result = await sizeTaskWithModel(registry, task, project, { offline: true });
    expect(calls).toBe(0);
    expect(result.source).toBe("offline_estimate");
    expect(result.warning).toContain("offline heuristic");
  });
});
