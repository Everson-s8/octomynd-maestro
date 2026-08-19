// Quota / rate-limit usage indicator.
//
// Ported from the Orca rate-limit layer for the providers the Maestro uses
// (gemini/antigravity, claude, codex). Reads, per provider, the *remaining*
// quota (%) and when it resets, so the Analytics page can show "consumo
// disponível" instead of only the cost distribution.
//
// IMPORTANT (secrets): every token/credential value is read from the provider's
// own credential store at request time and is NEVER logged, persisted, or
// committed. This module only emits normalized percentages and reset times.

export type QuotaWindowKind = "5h" | "weekly" | "daily" | "unknown";

export type QuotaBucket = {
  provider: string;
  modelId: string | null;
  usedPercent: number | null; // 0-100
  remainingPercent: number | null; // 0-100
  resetsAt: string | null; // ISO
  windowMinutes: number | null;
  windowKind: QuotaWindowKind;
  planType: string | null;
  detail?: string;
};

export type QuotaResult = {
  provider: string;
  status: "ok" | "unavailable" | "error";
  updatedAt: string;
  buckets: QuotaBucket[];
  error: string | null;
};

// What a quota provider's fetcher must produce: a list of normalized buckets.
export type QuotaFetcher = () => Promise<QuotaResult>;

// Normalize a raw 0..1 remaining fraction into the bucket shape.
export function remainingFractionToBucket(raw: {
  provider: string;
  modelId: string | null;
  remainingFraction: number | null; // 0..1
  resetTime: string | null;
  windowKind: QuotaWindowKind;
  windowMinutes: number | null;
  planType?: string | null;
}): QuotaBucket {
  const rem = raw.remainingFraction == null ? null : Math.round(raw.remainingFraction * 100);
  return {
    provider: raw.provider,
    modelId: raw.modelId,
    usedPercent: rem == null ? null : 100 - rem,
    remainingPercent: rem,
    resetsAt: raw.resetTime,
    windowMinutes: raw.windowMinutes,
    windowKind: raw.windowKind,
    planType: raw.planType ?? null
  };
}

// Normalize a used/limit pair into a bucket.
export function usedLimitToBucket(raw: {
  provider: string;
  modelId: string | null;
  used: number | null;
  limit: number | null;
  resetsAt: string | null;
  windowKind: QuotaWindowKind;
  windowMinutes: number | null;
  planType?: string | null;
}): QuotaBucket {
  const usedPct =
    raw.used != null && raw.limit && raw.limit > 0 ? Math.round((raw.used / raw.limit) * 100) : null;
  return {
    provider: raw.provider,
    modelId: raw.modelId,
    usedPercent: usedPct,
    remainingPercent: usedPct == null ? null : Math.max(0, 100 - usedPct),
    resetsAt: raw.resetsAt,
    windowMinutes: raw.windowMinutes,
    windowKind: raw.windowKind,
    planType: raw.planType ?? null
  };
}

// Orchestration: run the fetchers for the providers the Maestro has (returns a
// result per provider, best-effort; a failed/unavailable provider yields a
// status bucket rather than throwing).
export async function fetchAllQuota(fetchers: Record<string, QuotaFetcher>): Promise<QuotaResult[]> {
  const providers = Object.keys(fetchers);
  const results = await Promise.allSettled(
    providers.map(async (provider) => await fetchers[provider]())
  );
  return providers.map((provider, i) => {
    const r = results[i];
    if (r.status === "fulfilled") return r.value;
    return {
      provider,
      status: "error" as const,
      updatedAt: new Date().toISOString(),
      buckets: [],
      error: r.reason instanceof Error ? r.reason.message : "quota_fetch_failed"
    };
  });
}

// Convenience: a provider with no usable credentials -> status unavailable.
export function buildEmptyUnavailable(provider: string, detail: string): QuotaResult {
  return { provider, status: "unavailable", updatedAt: new Date().toISOString(), buckets: [], error: detail };
}

// Convenience: wrap a thrown error -> status error.
export function buildError(provider: string, error: unknown): QuotaResult {
  return {
    provider,
    status: "error",
    updatedAt: new Date().toISOString(),
    buckets: [],
    error: error instanceof Error ? error.message : "quota_fetch_failed"
  };
}
