import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OpenAICompatibleProvider } from "../src/agents/openai-compatible.js";
import type { AgentCapability } from "../src/agents/types.js";

const baseConfig = {
  id: "opencode-go",
  label: "OpenCode Go",
  command: "opencode",
  capabilities: ["planning", "coding", "testing", "reviewing", "research", "conversation"] as AgentCapability[],
  endpointUrl: "https://api.test.local/v1",
  apiKeyEnv: "TEST_API_KEY",
  models: ["m1", "m2"]
};

const phase = "testing" as const;

describe("OpenAICompatibleProvider", () => {
  beforeEach(() => {
    process.env.TEST_API_KEY = "sk-test";
  });
  afterEach(() => {
    delete process.env.TEST_API_KEY;
    vi.restoreAllMocks();
  });

  function request() {
    return {
      runId: 1,
      stepNumber: 1,
      phase,
      capability: "coding" as const,
      task: { id: 1, text: "t", projectKey: "p" } as any,
      project: { path: "/p" } as any,
      previousSteps: [],
      artifactsRoot: "/tmp/arts"
    } as any;
  }

  it("calls the endpoint with the bearer key and returns the content", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: "DONE" } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 }
      })
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OpenAICompatibleProvider(baseConfig);
    const result = await provider.execute(request());

    expect(result.outcome).toBe("completed");
    expect(result.output).toBe("DONE");
    expect(result.tokenUsage).toEqual({ inputTokens: 10, outputTokens: 5 });
    // check the request
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.test.local/v1/chat/completions");
    expect(init.headers.Authorization).toBe("Bearer sk-test");
    const body = JSON.parse(init.body);
    expect(body.model).toBe("m1");
    // the goal prompt carries the task text into the user message
    expect(body.messages[1].content.length).toBeGreaterThan(50);
  });

  it("returns auth_required failure when the key env is missing", async () => {
    delete process.env.TEST_API_KEY;
    const provider = new OpenAICompatibleProvider(baseConfig);
    const result = await provider.execute(request());
    expect(result.outcome).toBe("failed");
    expect(result.failureCategory).toBe("auth_required");
  });

  it("surfaces a non-2xx endpoint response as failed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => "invalid key"
    }));
    const provider = new OpenAICompatibleProvider(baseConfig);
    const result = await provider.execute(request());
    expect(result.outcome).toBe("failed");
    expect(result.error).toContain("401");
  });

  it("uses request.model when provided", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: "OK" } }] })
    }));
    const provider = new OpenAICompatibleProvider(baseConfig);
    await provider.execute({ ...request(), model: "m2" });
    const [, init] = (fetch as any).mock.calls[0];
    expect(JSON.parse(init.body).model).toBe("m2");
  });
});
