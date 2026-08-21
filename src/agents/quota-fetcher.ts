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
  /** True when the values are the last successful reading, not this poll. */
  stale?: boolean;
  /** Timestamp of the last successful reading when this result is stale. */
  lastSuccessfulAt?: string;
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
const QUOTA_CACHE_TTL_MS = 10_000;
const QUOTA_FETCH_TIMEOUT_MS = 3_000;

type QuotaCache = {
  fetchedAt: number;
  results: QuotaResult[];
  lastSuccessfulByProvider: Map<string, QuotaResult>;
  inFlight: Promise<QuotaResult[]> | null;
};

// Keep this cache in the process, rather than in the UI. It prevents a fast
// dashboard poll (and a route refresh) from starting the same external OAuth
// calls over and over, while still allowing a fresh reading every few seconds.
const quotaCaches = new Map<string, QuotaCache>();

function cloneResults(results: QuotaResult[]): QuotaResult[] {
  return results.map((result) => ({ ...result, buckets: result.buckets.map((bucket) => ({ ...bucket })) }));
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("quota_fetch_timeout")), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

export async function fetchAllQuota(fetchers: Record<string, QuotaFetcher>): Promise<QuotaResult[]> {
  const providers = Object.keys(fetchers);
  const cacheKey = providers.slice().sort().join(",") || "none";
  const cache = quotaCaches.get(cacheKey) ?? {
    fetchedAt: 0,
    results: [],
    lastSuccessfulByProvider: new Map<string, QuotaResult>(),
    inFlight: null
  } satisfies QuotaCache;
  quotaCaches.set(cacheKey, cache);

  if (cache.results.length > 0 && Date.now() - cache.fetchedAt < QUOTA_CACHE_TTL_MS) {
    return cloneResults(cache.results);
  }
  if (cache.inFlight) {
    return cache.results.length > 0 ? cloneResults(cache.results) : cache.inFlight;
  }

  cache.inFlight = (async () => {
    const results = await Promise.allSettled(
      providers.map((provider) => withTimeout(fetchers[provider](), QUOTA_FETCH_TIMEOUT_MS))
    );
    return providers.map((provider, i) => {
      const outcome = results[i];
      const current: QuotaResult = outcome.status === "fulfilled"
        ? outcome.value
        : {
            provider,
            status: "error",
            updatedAt: new Date().toISOString(),
            buckets: [],
            error: outcome.reason instanceof Error ? outcome.reason.message : "quota_fetch_failed"
          };
      const isUsable = current.status === "ok" && current.buckets.length > 0;
      if (isUsable) {
        cache.lastSuccessfulByProvider.set(provider, current);
        return { ...current, stale: false, lastSuccessfulAt: current.updatedAt };
      }

      const lastSuccessful = cache.lastSuccessfulByProvider.get(provider);
      if (lastSuccessful) {
        return {
          ...lastSuccessful,
          stale: true,
          error: current.error || "quota_refresh_unavailable",
          lastSuccessfulAt: lastSuccessful.lastSuccessfulAt ?? lastSuccessful.updatedAt
        };
      }
      return current;
    });
  })();

  try {
    const results = await cache.inFlight;
    cache.results = results;
    cache.fetchedAt = Date.now();
    return cloneResults(results);
  } finally {
    cache.inFlight = null;
  }
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
