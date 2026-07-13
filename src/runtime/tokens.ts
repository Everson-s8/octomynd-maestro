export type TokenUsageEstimate = {
  bytes: number;
  tokens: number;
};

export type TokenUsageComparison = {
  baseline: TokenUsageEstimate;
  compact: TokenUsageEstimate;
  savedBytes: number;
  savedTokens: number;
  savingsRatio: number;
};

const APPROX_BYTES_PER_TOKEN = 4;

export function estimateTokenUsage(value: string): TokenUsageEstimate {
  const bytes = Buffer.byteLength(value, "utf8");
  return {
    bytes,
    tokens: bytes === 0 ? 0 : Math.max(1, Math.ceil(bytes / APPROX_BYTES_PER_TOKEN))
  };
}

export function compareTokenUsage(baselineText: string, compactText: string): TokenUsageComparison {
  const baseline = estimateTokenUsage(baselineText);
  const compact = estimateTokenUsage(compactText);
  const savedBytes = Math.max(0, baseline.bytes - compact.bytes);
  const savedTokens = Math.max(0, baseline.tokens - compact.tokens);
  return {
    baseline,
    compact,
    savedBytes,
    savedTokens,
    savingsRatio: baseline.tokens === 0 ? 0 : savedTokens / baseline.tokens
  };
}
