import type { AgentProviderId } from "./types.js";

export type ModelPricing = {
  inputCostPerM: number;
  outputCostPerM: number;
};

/**
 * Provider Economics: Model pricing table and cost estimation logic.
 * Per-model pricing per 1 Million (1M) tokens in USD.
 */
export const MODEL_PRICING_TABLE: Record<string, ModelPricing> = {
  // Claude models
  "claude-3-5-sonnet": { inputCostPerM: 3.0, outputCostPerM: 15.0 },
  "claude-3-7-sonnet": { inputCostPerM: 3.0, outputCostPerM: 15.0 },
  "claude-3-5-haiku": { inputCostPerM: 0.8, outputCostPerM: 4.0 },
  "claude": { inputCostPerM: 3.0, outputCostPerM: 15.0 },

  // Codex / OpenAI models
  "gpt-4o": { inputCostPerM: 2.5, outputCostPerM: 10.0 },
  "gpt-4o-mini": { inputCostPerM: 0.15, outputCostPerM: 0.6 },
  "o1": { inputCostPerM: 15.0, outputCostPerM: 60.0 },
  "o3-mini": { inputCostPerM: 1.1, outputCostPerM: 4.4 },
  "codex": { inputCostPerM: 2.5, outputCostPerM: 10.0 },

  // Antigravity / Gemini models
  "gemini-2.0-flash": { inputCostPerM: 0.1, outputCostPerM: 0.4 },
  "gemini-1.5-pro": { inputCostPerM: 1.25, outputCostPerM: 5.0 },
  "gemini-2.0-flash-thinking": { inputCostPerM: 0.1, outputCostPerM: 0.4 },
  "gemini-3.6-flash": { inputCostPerM: 0.1, outputCostPerM: 0.4 },
  "antigravity": { inputCostPerM: 0.1, outputCostPerM: 0.4 }
};

export const DEFAULT_PROVIDER_MODELS: Record<AgentProviderId, string> = {
  codex: "codex",
  claude: "claude",
  antigravity: "antigravity"
};

export function resolveModelForProvider(provider?: string | null, model?: string | null): string {
  if (model && model.trim()) {
    const normalized = model.trim().toLowerCase();
    if (MODEL_PRICING_TABLE[normalized]) return normalized;
    // Check partial prefix matches
    for (const key of Object.keys(MODEL_PRICING_TABLE)) {
      if (normalized.includes(key)) return key;
    }
    return normalized;
  }
  const prov = (provider ?? "").toLowerCase();
  if (prov === "claude") return "claude";
  if (prov === "codex") return "codex";
  if (prov === "antigravity") return "antigravity";
  return "default";
}

export function getPricingForModel(provider?: string | null, model?: string | null): ModelPricing {
  const resolved = resolveModelForProvider(provider, model);
  if (MODEL_PRICING_TABLE[resolved]) {
    return MODEL_PRICING_TABLE[resolved];
  }
  const prov = (provider ?? "").toLowerCase();
  if (prov.includes("claude")) return MODEL_PRICING_TABLE["claude"];
  if (prov.includes("codex")) return MODEL_PRICING_TABLE["codex"];
  if (prov.includes("antigravity")) return MODEL_PRICING_TABLE["antigravity"];
  return { inputCostPerM: 1.0, outputCostPerM: 3.0 };
}

export function calculateCostUsd(
  provider: string | undefined | null,
  model: string | undefined | null,
  inputTokens: number,
  outputTokens: number
): number {
  if ((!inputTokens || inputTokens <= 0) && (!outputTokens || outputTokens <= 0)) {
    return 0;
  }
  const pricing = getPricingForModel(provider, model);
  const inputCost = (Math.max(0, inputTokens) / 1_000_000) * pricing.inputCostPerM;
  const outputCost = (Math.max(0, outputTokens) / 1_000_000) * pricing.outputCostPerM;
  const total = inputCost + outputCost;
  return Math.round(total * 1_000_000) / 1_000_000;
}

export function formatCurrencyUsd(amount: number, options?: { decimals?: number }): string {
  const decimals = options?.decimals ?? 2;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals
  }).format(amount);
}
