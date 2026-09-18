import { buildAgentGoalPrompt, buildConversationPrompt } from "./goal-prompt.js";
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
    // F02: this adapter is a bare chat-completions bridge — it has no tool
    // executor, file editor, or command runner. It cannot honestly claim to
    // implement code or run tests, so drop those capabilities and keep only
    // the text-only ones the bridge can actually satisfy. A chat endpoint that
    // replies with prose is not a coding agent.
    const TEXT_ONLY_CAPABILITIES: ReadonlySet<AgentCapability> = new Set<AgentCapability>([
      "conversation",
      "research",
      "reviewing",
      "improvement_reviewing"
    ]);
    this.capabilities = new Set(
      config.capabilities.filter((capability) => TEXT_ONLY_CAPABILITIES.has(capability))
    );
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
      health = { state: "offline", detail: `${this.label}: endpoint not configured`, checkedAt: new Date().toISOString() };
    } else if (!key) {
      health = { state: "auth_required", detail: `${this.label}: API key (${this.apiKeyEnv ?? "?"}) not configured`, checkedAt: new Date().toISOString() };
    } else {
      // F03: presence of a URL and key proves the adapter is *configured*, not
      // that the endpoint is reachable or the credential is valid. Reporting
      // "ready" here would let a dead endpoint masquerade as an executable
      // agent. "configured" is surfaced as offline-with-detail so the UI never
      // claims live capability without a verified probe, and a real failure
      // surfaces the truth after the first execute.
      health = { state: "offline", detail: `${this.label}: endpoint configured but not yet verified`, checkedAt: new Date().toISOString() };
    }
    this.healthExpiresAt = Date.now() + 30_000;
    this.cachedHealth = health;
    return health;
  }

  async execute(request: AgentExecutionRequest): Promise<AgentExecutionResult> {
    const startedAt = Date.now();
    // F03: honour a pre-aborted signal before any side effect. A cancelled
    // request must never fire an HTTP call and report "completed".
    if (request.signal?.aborted) {
      return {
        outcome: "cancelled",
        summary: `${this.label}: request already cancelled.`,
        structuredPayload: null,
        failureCategory: "user_cancelled",
        retryable: false,
        retryAfterMs: undefined,
        artifactsProduced: [],
        output: "",
        error: null,
        durationMs: 0,
        tokenUsage: undefined,
        model: request.model ?? this.model ?? undefined
      };
    }
    const selectedModel = request.model ?? this.model ?? this.config.models?.[0] ?? this.id;
    const endpoint = this.defaultEndpoint?.replace(/\/+$/, "");
    const key = this.apiKeyEnv ? process.env[this.apiKeyEnv]?.trim() ?? "" : "";

    if (!endpoint || !key) {
      const errorText = !endpoint
        ? "Endpoint is not configured for this provider."
        : `API key (${this.apiKeyEnv}) is not configured. Configure it in Providers.`;
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

    const conversation = request.capability === "conversation";
    const prompt = conversation ? buildConversationPrompt(request) : buildAgentGoalPrompt(request);
    const messages = [
      {
        role: "system",
        content: conversation
          ? "You are the conversational assistant inside Octomynd Maestro. Reply naturally and directly to the user. Do not turn casual conversation into a task report."
          : "You are an autonomous agent executing a structured goal. Follow the instructions in the user message exactly and output a clear final result."
      },
      { role: "user", content: prompt }
    ];

    try {
      // F03: combine the inbound cancellation signal with the provider timeout
      // and the phase deadline so a cancel or deadline aborts the in-flight
      // request (and reports 'cancelled'/'timed out') instead of a fixed 10-min
      // timeout that ignores cancellation.
      const timeoutSignal = AbortSignal.timeout(600_000);
      const signal = request.signal
        ? AbortSignal.any([request.signal, timeoutSignal])
        : timeoutSignal;
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
        signal
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        const errorText = `Endpoint ${endpoint} returned HTTP ${response.status}: ${body.slice(0, 300)}`;
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

      // F02: an empty completion is not "completed" — it is no result at all.
      // Surface it as a failure so fallback/routing can react, instead of
      // marking the phase done with no evidence.
      if (!content) {
        const errorText = `${this.label}: empty completion from ${endpoint} (model ${selectedModel}).`;
        this.cacheHealth("ready", `${this.label}: endpoint authenticated`);
        return {
          outcome: "failed", summary: errorText, structuredPayload: null,
          failureCategory: "invalid_output", retryable: true,
          retryAfterMs: 15_000, artifactsProduced: [],
          output: "", error: errorText, durationMs: Date.now() - startedAt,
          tokenUsage, model: selectedModel
        };
      }

      this.cacheHealth("ready", `${this.label}: endpoint authenticated`);
      return {
        outcome: "completed", summary: `${this.label} completed the ${request.phase} phase.`,
        structuredPayload: { phase: request.phase }, artifactsProduced: [],
        output: content, error: null, durationMs: Date.now() - startedAt,
        retryable: false, tokenUsage, model: selectedModel
      };
    } catch (cause) {
      const errorText = cause instanceof Error ? cause.message : String(cause);
      const aborted = request.signal?.aborted || errorText.toLowerCase().includes("abort");
      const timedOut = !aborted && (errorText.toLowerCase().includes("timeout"));
      const category = classifyFailure(errorText, { provider: this.id, phase: request.phase, exitCode: 0, timedOut, aborted, breakerReason: null, spawnErrorCode: null });
      return {
        outcome: aborted ? "cancelled" : "failed",
        summary: errorText, structuredPayload: null,
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
