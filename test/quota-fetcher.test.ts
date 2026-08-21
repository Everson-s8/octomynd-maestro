import { describe, expect, it, vi } from "vitest";
import {
  QuotaResult,
  buildError,
  buildEmptyUnavailable,
  fetchAllQuota,
  remainingFractionToBucket,
  usedLimitToBucket
} from "../src/agents/quota-fetcher.js";

describe("quota normalizers", () => {
  it("converts a remaining fraction (0..1) into used% / remaining%", () => {
    const b = remainingFractionToBucket({
      provider: "gemini",
      modelId: "gemini-3.7",
      remainingFraction: 0.72,
      resetTime: "2026-08-19T18:00:00Z",
      windowKind: "unknown",
      windowMinutes: null
    });
    expect(b.remainingPercent).toBe(72);
    expect(b.usedPercent).toBe(28);
    expect(b.resetsAt).toBe("2026-08-19T18:00:00Z");
  });

  it("converts a used/limit pair into used% / remaining%", () => {
    const b = usedLimitToBucket({
      provider: "codex",
      modelId: null,
      used: 25,
      limit: 100,
      resetsAt: null,
      windowKind: "5h",
      windowMinutes: 300
    });
    expect(b.usedPercent).toBe(25);
    expect(b.remainingPercent).toBe(75);
  });

  it("handles a null limit gracefully (no division by zero)", () => {
    const b = usedLimitToBucket({
      provider: "codex",
      modelId: null,
      used: 10,
      limit: null,
      resetsAt: null,
      windowKind: "5h",
      windowMinutes: 300
    });
    expect(b.usedPercent).toBeNull();
    expect(b.remainingPercent).toBeNull();
  });
});

describe("fetchAllQuota orchestration", () => {
  it("returns per-provider results and captures thrown fetchers as error", async () => {
    const results = await fetchAllQuota({
      ok: async (): Promise<QuotaResult> => buildEmptyUnavailable("ok", "no credential"),
      boom: async (): Promise<QuotaResult> => {
        throw new Error("boom");
      }
    });
    expect(results).toHaveLength(2);
    const ok = results.find((r) => r.provider === "ok");
    expect(ok?.status).toBe("unavailable");
    const boom = results.find((r) => r.provider === "boom");
    expect(boom?.status).toBe("error");
    expect(boom?.error).toBe("boom");
  });

  it("serves the last successful reading when a later refresh fails", async () => {
    vi.useFakeTimers();
    const provider = `quota-stale-${Date.now()}`;
    let calls = 0;

    try {
      const first = await fetchAllQuota({
        [provider]: async (): Promise<QuotaResult> => {
          calls += 1;
          return {
            provider,
            status: "ok",
            updatedAt: "2026-08-21T12:00:00.000Z",
            buckets: [{
              provider,
              modelId: "test-model",
              windowKind: "5h",
              windowMinutes: 300,
              usedPercent: 20,
              remainingPercent: 80,
              resetsAt: null,
              planType: null
            }],
            error: null
          };
        }
      });
      expect(first[0]?.stale).toBe(false);

      await vi.advanceTimersByTimeAsync(10_001);
      const second = await fetchAllQuota({
        [provider]: async (): Promise<QuotaResult> => {
          calls += 1;
          throw new Error("provider offline");
        }
      });

      expect(calls).toBe(2);
      expect(second[0]?.stale).toBe(true);
      expect(second[0]?.buckets[0]?.remainingPercent).toBe(80);
      expect(second[0]?.error).toBe("provider offline");
    } finally {
      vi.useRealTimers();
    }
  });

  it("buildError and buildEmptyUnavailable produce the expected shapes", () => {
    expect(buildError("codex", new Error("x")).status).toBe("error");
    expect(buildError("codex", new Error("x")).error).toBe("x");
    expect(buildEmptyUnavailable("codex", "why").status).toBe("unavailable");
    expect(buildEmptyUnavailable("codex", "why").error).toBe("why");
  });
});
