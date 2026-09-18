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
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.test.local/v1/chat/completions");
    expect(init.headers.Authorization).toBe("Bearer sk-test");
    const body = JSON.parse(init.body);
    expect(body.model).toBe("m1");
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

  it("does not advertise coding/testing capabilities it cannot actually execute (F02)", () => {
    const provider = new OpenAICompatibleProvider(baseConfig);
    expect(provider.capabilities.has("coding")).toBe(false);
    expect(provider.capabilities.has("testing")).toBe(false);
    expect(provider.capabilities.has("planning")).toBe(false);
    expect(provider.capabilities.has("conversation")).toBe(true);
  });

  it("returns failed (not completed) on an empty completion (F02)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: "" } }] })
    }));
    const provider = new OpenAICompatibleProvider(baseConfig);
    const result = await provider.execute({ ...request(), capability: "conversation" });
    expect(result.outcome).toBe("failed");
    expect(result.failureCategory).toBe("invalid_output");
  });

  it("returns cancelled without calling the endpoint when the signal is already aborted (F03)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    controller.abort();
    const provider = new OpenAICompatibleProvider(baseConfig);
    const result = await provider.execute({ ...request(), signal: controller.signal });
    expect(result.outcome).toBe("cancelled");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("probes the endpoint before reporting it ready (F03)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
    const provider = new OpenAICompatibleProvider(baseConfig);
    const health = await provider.health();
    expect(health.state).toBe("ready");
    expect(health.detail).toContain("authenticated");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.test.local/v1/models",
      expect.objectContaining({
        method: "GET",
        headers: { Authorization: "Bearer sk-test" }
      })
    );
  });

  it("classifies a rejected health probe as authentication required (F03)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => "invalid key"
    }));
    const provider = new OpenAICompatibleProvider(baseConfig);
    await expect(provider.health()).resolves.toMatchObject({ state: "auth_required" });
  });

  it("uses the phase deadline when composing the request abort signal (F03)", async () => {
    const fetchMock = vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("deadline", "TimeoutError")), { once: true });
    }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new OpenAICompatibleProvider(baseConfig);
    const result = await provider.execute({ ...request(), capability: "conversation", deadlineAt: Date.now() + 5 });
    expect(result.outcome).toBe("failed");
    expect(result.failureCategory).toBe("timeout");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("does not turn an internal timeout into user cancellation (F03)", async () => {
    const fetchMock = vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("This operation was aborted", "AbortError")), { once: true });
    }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new OpenAICompatibleProvider(baseConfig);
    const result = await provider.execute({ ...request(), capability: "conversation", deadlineAt: Date.now() + 5 });
    expect(result.outcome).toBe("failed");
    expect(result.failureCategory).toBe("timeout");
  });
});
