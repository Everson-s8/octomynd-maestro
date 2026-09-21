import { describe, expect, it } from "vitest";
import { runChatAgentLoop } from "../src/chat/agent-loop.js";

describe("chat agent loop", () => {
  it("returns to the provider after a tool call and stops when the provider says final", async () => {
    const prompts: string[] = [];
    const tools: string[] = [];
    const result = await runChatAgentLoop({
      userMessage: "verifique o projeto e crie uma task se fizer sentido",
      initialPrompt: "Return JSON using the available tools.",
      providerId: "fake",
      model: "fake-model",
      effort: "low",
      budget: { maxIterations: 4, maxToolCalls: 4 },
      signal: new AbortController().signal,
      invoke: async ({ prompt, iteration }) => {
        prompts.push(prompt);
        return iteration === 1
          ? { output: JSON.stringify({ type: "tool_call", name: "inspect_project", arguments: {}, rationale: "I need project evidence." }) }
          : { output: JSON.stringify({ type: "final", response: "Analisei o projeto e concluí o trabalho." }) };
      },
      executeTool: async ({ name }) => {
        tools.push(name);
        return { ok: true, content: "PROJECT EVIDENCE: tests exist and the repository is registered." };
      }
    });

    expect(result.response).toContain("concluí");
    expect(result.iterations).toBe(2);
    expect(result.toolCalls).toBe(1);
    expect(result.toolsUsed).toEqual(["inspect_project"]);
    expect(tools).toEqual(["inspect_project"]);
    expect(prompts[1]).toContain("TOOL RESULT");
    expect(result.stopReason).toBe("model_finished");
  });

  it("stops honestly at the explicit budget instead of inventing completion", async () => {
    const result = await runChatAgentLoop({
      userMessage: "investigue",
      initialPrompt: "Return a tool call.",
      providerId: "fake",
      model: null,
      effort: null,
      budget: { maxIterations: 2, maxToolCalls: 1 },
      signal: new AbortController().signal,
      invoke: async () => ({ output: JSON.stringify({ type: "tool_call", name: "project_state", arguments: {} }) }),
      executeTool: async () => ({ ok: true, content: "state" })
    });

    expect(result.stopReason).toBe("budget_exhausted");
    expect(result.iterations).toBe(2);
    expect(result.toolCalls).toBe(1);
    expect(result.response).toContain("reasoning budget");
  });

  it("propagates cancellation before another provider call", async () => {
    const controller = new AbortController();
    let calls = 0;
    await expect(runChatAgentLoop({
      userMessage: "investigue",
      initialPrompt: "Return a tool call.",
      providerId: "fake",
      model: null,
      effort: null,
      budget: { maxIterations: 4, maxToolCalls: 4 },
      signal: controller.signal,
      invoke: async () => {
        calls += 1;
        controller.abort();
        return { output: JSON.stringify({ type: "tool_call", name: "read_memory", arguments: {} }) };
      },
      executeTool: async () => ({ ok: true, content: "should not execute" })
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toBe(1);
  });

  it("supports the complete Maestro tool surface in one bounded investigation", async () => {
    const toolNames = ["inspect_project", "project_state", "read_memory", "run_command", "governed_action"] as const;
    const executed: string[] = [];
    const result = await runChatAgentLoop({
      userMessage: "investigue e execute o próximo passo governado",
      initialPrompt: "Use the tools and then finish.",
      providerId: "fake",
      model: null,
      effort: null,
      budget: { maxIterations: 7, maxToolCalls: 5 },
      signal: new AbortController().signal,
      invoke: async ({ iteration }) => iteration <= toolNames.length
        ? { output: JSON.stringify({ type: "tool_call", name: toolNames[iteration - 1], arguments: {} }) }
        : { output: JSON.stringify({ type: "final", response: "Concluído com evidência." }) },
      executeTool: async ({ name }) => {
        executed.push(name);
        return { ok: true, content: `${name} evidence` };
      }
    });

    expect(executed).toEqual(toolNames);
    expect(result.toolsUsed).toEqual(toolNames);
    expect(result.iterations).toBe(6);
    expect(result.stopReason).toBe("model_finished");
  });

  it("does not expose malformed JSON as a final answer", async () => {
    const prompts: string[] = [];
    const result = await runChatAgentLoop({
      userMessage: "crie a task correta",
      initialPrompt: "Return one valid JSON turn.",
      providerId: "fake",
      model: null,
      effort: null,
      budget: { maxIterations: 3, maxToolCalls: 1 },
      signal: new AbortController().signal,
      invoke: async ({ prompt, iteration }) => {
        prompts.push(prompt);
        return iteration === 1
          ? { output: '{"type":"tool_call","name":"unknown_tool"' }
          : { output: JSON.stringify({ type: "final", response: "Corrigi o formato e concluí." }) };
      },
      executeTool: async () => ({ ok: true, content: "should not execute" })
    });

    expect(result.response).toContain("Corrigi");
    expect(result.iterations).toBe(2);
    expect(prompts[1]).toContain("MODEL OUTPUT INVALID");
  });
});
