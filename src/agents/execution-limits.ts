export type ProviderExecutionLimits = {
  inactivityTimeoutMs: number;
  maxRuntimeMs?: number;
};

export const DEFAULT_CODEX_INACTIVITY_TIMEOUT_MS = 10 * 60_000;
export const DEFAULT_CLAUDE_INACTIVITY_TIMEOUT_MS = 30 * 60_000;
export function normalizeProviderExecutionLimits(
  input: number | Partial<ProviderExecutionLimits> | undefined,
  defaultInactivityTimeoutMs: number
): ProviderExecutionLimits {
  if (typeof input === "number") {
    return { inactivityTimeoutMs: positiveDuration(input, defaultInactivityTimeoutMs) };
  }
  return {
    inactivityTimeoutMs: positiveDuration(input?.inactivityTimeoutMs, defaultInactivityTimeoutMs),
    maxRuntimeMs: optionalPositiveDuration(input?.maxRuntimeMs)
  };
}

function positiveDuration(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value! > 0 ? Math.floor(value!) : fallback;
}

function optionalPositiveDuration(value: number | undefined): number | undefined {
  return Number.isFinite(value) && value! > 0 ? Math.floor(value!) : undefined;
}
