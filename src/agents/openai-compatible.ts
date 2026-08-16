import { buildAgentGoalPrompt } from "./goal-prompt.js";
import { classifyFailure, isRetryableFailureCategory, retryAfterMsForFailure, type FailureCategory } from "./failure.js";
import type {
  AgentCapability,
  AgentExecutionRequest,
  AgentExecutionResult,
  AgentHealth,
  AgentProvider,
  CustomCliProviderConfig
} from "./types.js";

/**
 * OpenAI-compatible chat-completions provider.
 *
 * Some providers are reached over an HTTP API endpoint with a bearer API key
 * rather than a local CLI (e.g. opencode.ai/zen/go/v1, OpenRouter, DeepSeek
 * direct, any OpenAI-compatible gateway). This provider calls
 * `<baseUrl>/chat/completions` with `Authorization: Bearer <key>` and the goal
 * prompt as the user message — mirroring how the Hermes agent consumes such
 * providers — so the account's credits are actually used.
 *
 * Config fields it reads from `CustomCliProviderConfig`:
 *   - model / models        selected and discoverable model ids
 *   - apiKeyEnv             env var holding the bearer key (e.g. OPENCODE_GO_API_KEY)
 *   - endpointUrl           base URL of the OpenAI-compatible endpoint
 */
export class OpenAICompatibleProvider implements AgentProvider {
  readonly id: AgentProviderIdLike;
  readonly label: string;
  readonly capabilities: ReadonlySet<AgentCapability>;
  readonly model: string | null;
  private readonly config: CustomCliProviderConfig;
  private readonly defaultEndpoint: string | null;
  private readonly apiKeyEnv: string | null;
  private cachedHealth: AgentHealth | null = null;
  private healthExpiresAt = 0;

  constructor(config: CustomCliProviderConfig) {
    this.config = config;
    this.id = config.id;
    this.label = config.label || config.id;
    this.capabilities = new Set(config.capabilities);
    this.model = config.model?.trim() || null;
    this.defaultEndpoint = config.endpointUrl ?? null;
    this.apiKeyEnv = config.apiKeyEnv ?? null;
  }

  async models(): Promise<string[]> {
    if (this.config.models && this.config.models.length > 0) return this.config.models;
    return this.model ? [this.model] : [this.id];
  }

  async health(): Promise<AgentHealth> {
    if (this.cachedHealth && Date.now() < this.healthExpiresAt) return this.cachedHealth;
    const endpoint = this.defaultEndpoint?.replace(/\/+$/, "");
    const key = this.apiKeyEnv ? process.env[this.apiKeyEnv]?.trim() ?? "" : "";
    let health: AgentHealth;
    if (!endpoint) {
      health = { state: "offline", detail: `${this.label}: endpoint nao configurado`, checkedAt: new Date().toISOString() };
    } else if (!key) {
      health = { state: "auth_required", detail: `${this.label}: chave de API (${this.apiKeyEnv ?? "?"}) nao configurada`, checkedAt: new Date().toISOString() };
    } else {
      health = { state: "ready", detail: `${this.label}: endpoint pronto (${endpoint})`, checkedAt: new Date().toISOString() };
    }
    this.healthExpiresAt = Date.now() + 30_000;
    this.cachedHealth = health;
    return health;
  }

  async execute(request: AgentExecutionRequest): Promise<AgentExecutionResult> {
    const startedAt = Date.now();
    const selectedModel = request.model ?? this.model ?? this.config.models?.[0] ?? this.id;
    const endpoint = this.defaultEndpoint?.replace(/\/+$/, "");
    const key = this.apiKeyEnv ? process.env[this.apiKeyEnv]?.trim() ?? "" : "";

    if (!endpoint || !key) {
      const errorText = !endpoint
        ? "Endpoint nao configurado para este provider."
        : `API key (${this.apiKeyEnv}) nao configurada. Configure-a na pagina de Providers.`;
      const category: FailureCategory = key ? "unknown" : "auth_required";
      this.cacheHealth(category === "auth_required" ? "auth_required" : "offline", errorText);
      return {
        outcome: "failed", summary: errorText, structuredPayload: null,
        failureCategory: category, retryable: isRetryableFailureCategory(category),
        retryAfterMs: retryAfterMsForFailure(category), artifactsProduced: [],
        output: "", error: errorText, durationMs: Date.now() - startedAt,
        tokenUsage: undefined, model: selectedModel
      };
    }

    const prompt = buildAgentGoalPrompt(request);
    const messages = [
      { role: "system", content: "You are an autonomous agent executing a structured goal. Follow the instructions in the user message exactly and output a clear final result." },
      { role: "user", content: prompt }
    ];

    try {
      const response = await fetch(`${endpoint}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key}`
        },
        body: JSON.stringify({
          model: selectedModel,
          messages,
          temperature: 0.2,
          max_tokens: 4096
        }),
        signal: AbortSignal.timeout(600_000)
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        const errorText = `Endpoint ${endpoint} respondeu HTTP ${response.status}: ${body.slice(0, 300)}`;
        const category = classifyFailure(errorText, { provider: this.id, phase: request.phase, exitCode: response.status, timedOut: false, aborted: false, breakerReason: null, spawnErrorCode: null });
        return {
          outcome: "failed", summary: errorText, structuredPayload: null,
          failureCategory: category, retryable: isRetryableFailureCategory(category),
          retryAfterMs: retryAfterMsForFailure(category), artifactsProduced: [],
          output: "", error: errorText, durationMs: Date.now() - startedAt,
          tokenUsage: undefined, model: selectedModel
        };
      }

      const payload = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const content = payload.choices?.[0]?.message?.content?.trim() ?? "";
      const tokenUsage = payload.usage
        ? { inputTokens: payload.usage.prompt_tokens ?? 0, outputTokens: payload.usage.completion_tokens ?? 0 }
        : undefined;

      this.cacheHealth("ready", `${this.label}: endpoint autenticado`);
      return {
        outcome: "completed", summary: `${this.label} concluiu a fase ${request.phase}.`,
        structuredPayload: { phase: request.phase }, artifactsProduced: [],
        output: content, error: null, durationMs: Date.now() - startedAt,
        retryable: false, tokenUsage, model: selectedModel
      };
    } catch (cause) {
      const errorText = cause instanceof Error ? cause.message : String(cause);
      const timedOut = errorText.toLowerCase().includes("abort") || errorText.toLowerCase().includes("timeout");
      const category = classifyFailure(errorText, { provider: this.id, phase: request.phase, exitCode: 0, timedOut, aborted: false, breakerReason: null, spawnErrorCode: null });
      return {
        outcome: "failed", summary: errorText, structuredPayload: null,
        failureCategory: category, retryable: isRetryableFailureCategory(category),
        retryAfterMs: retryAfterMsForFailure(category), artifactsProduced: [],
        output: "", error: errorText, durationMs: Date.now() - startedAt,
        tokenUsage: undefined, model: selectedModel
      };
    }
  }

  private cacheHealth(state: "ready" | "auth_required" | "offline" | "quota", detail: string) {
    this.cachedHealth = { state, detail, checkedAt: new Date().toISOString() };
    this.healthExpiresAt = Date.now() + 30_000;
  }
}

// Minimal structural type to avoid importing the full union.
type AgentProviderIdLike = string;
