import { describe, expect, it } from "vitest";
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

  it("buildError and buildEmptyUnavailable produce the expected shapes", () => {
    expect(buildError("codex", new Error("x")).status).toBe("error");
    expect(buildError("codex", new Error("x")).error).toBe("x");
    expect(buildEmptyUnavailable("codex", "why").status).toBe("unavailable");
    expect(buildEmptyUnavailable("codex", "why").error).toBe("why");
  });
});
