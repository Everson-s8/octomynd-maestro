import { describe, expect, it } from "vitest";
import { calculateCostUsd, formatCurrencyUsd, getPricingForModel, MODEL_PRICING_TABLE, resolveModelForProvider } from "../src/agents/economics.js";
import { parseTokenUsageFromOutput } from "../src/agents/process.js";
import { createDatabase } from "../src/db.js";
import { buildDashboardSnapshot } from "../src/dashboard/snapshot.js";
import { MaestroConfig } from "../src/config.js";

describe("Provider Economics - Economics & Pricing Table", () => {
  it("resolves model pricing correctly for known models", () => {
    const claudePricing = getPricingForModel("claude", "claude-3-5-sonnet");
    expect(claudePricing.inputCostPerM).toBe(3.0);
    expect(claudePricing.outputCostPerM).toBe(15.0);

    const codexPricing = getPricingForModel("codex", "gpt-4o-mini");
    expect(codexPricing.inputCostPerM).toBe(0.15);
    expect(codexPricing.outputCostPerM).toBe(0.6);

    const antigravityPricing = getPricingForModel("antigravity", "gemini-2.0-flash");
    expect(antigravityPricing.inputCostPerM).toBe(0.1);
    expect(antigravityPricing.outputCostPerM).toBe(0.4);
  });

  it("calculates cost in USD accurately", () => {
    // 1,000,000 input tokens + 1,000,000 output tokens for claude-3-5-sonnet = $3.00 + $15.00 = $18.00
    const costClaude = calculateCostUsd("claude", "claude-3-5-sonnet", 1_000_000, 1_000_000);
    expect(costClaude).toBe(18.0);

    // 100,000 in + 50,000 out for gpt-4o ($2.50/1M in, $10.00/1M out) = $0.25 + $0.50 = $0.75
    const costCodex = calculateCostUsd("codex", "gpt-4o", 100_000, 50_000);
    expect(costCodex).toBe(0.75);

    // 0 tokens = $0.00
    expect(calculateCostUsd("antigravity", "gemini-2.0-flash", 0, 0)).toBe(0);
  });
});

describe("Provider Economics - Currency Formatter", () => {
  it("formats numbers to USD currency with default 2 decimals", () => {
    expect(formatCurrencyUsd(0)).toBe("$0.00");
    expect(formatCurrencyUsd(1.5)).toBe("$1.50");
    expect(formatCurrencyUsd(1234.567)).toBe("$1,234.57");
  });

  it("formats numbers to USD currency with custom decimals", () => {
    expect(formatCurrencyUsd(0, { decimals: 4 })).toBe("$0.0000");
    expect(formatCurrencyUsd(0.75, { decimals: 4 })).toBe("$0.7500");
    expect(formatCurrencyUsd(0.12345, { decimals: 4 })).toBe("$0.1235");
    expect(formatCurrencyUsd(1.2, { decimals: 0 })).toBe("$1");
  });
});

describe("Provider Economics - Token Usage Parser", () => {
  it("parses JSON payload from output", () => {
    const jsonOutput = JSON.stringify({
      usage: {
        input_tokens: 1200,
        output_tokens: 450
      }
    });
    const parsed = parseTokenUsageFromOutput(jsonOutput, "");
    expect(parsed).toEqual({ inputTokens: 1200, outputTokens: 450 });
  });

  it("parses CLI text output for Codex / Claude / Antigravity", () => {
    // Format: "1,234 input, 567 output"
    const text1 = "Execution complete. 1,234 input, 567 output tokens used.";
    expect(parseTokenUsageFromOutput(text1, "")).toEqual({ inputTokens: 1234, outputTokens: 567 });

    // Format: "Tokens: 1000 in / 200 out"
    const text2 = "Tokens: 1,000 in / 200 out";
    expect(parseTokenUsageFromOutput(text2, "")).toEqual({ inputTokens: 1000, outputTokens: 200 });

    // Format: "Prompt tokens: 500, Completion tokens: 150"
    const text3 = "Prompt tokens: 500, Completion tokens: 150";
    expect(parseTokenUsageFromOutput(text3, "")).toEqual({ inputTokens: 500, outputTokens: 150 });
  });

  it("falls back safely to 0 on unparseable output without throwing", () => {
    const garbage = "Random process log without any token metrics.";
    const result = parseTokenUsageFromOutput(garbage, "some error");
    expect(result).toEqual({ inputTokens: 0, outputTokens: 0 });
  });
});

describe("Provider Economics - Database & Snapshot Integration", () => {
  it("stores token usage per step and computes cost summary", () => {
    const db = createDatabase(":memory:");
    const project = db.registerProject({ key: "test-proj", name: "Test Project", defaultBranch: "main", path: "/tmp/test" });
    const task = db.createTask("Test Task", "telegram", project.key);
    const run = db.createGoalRun(task.id);
    const step = db.createGoalStep(run.id, "implementing", "codex");

    const record = db.recordTokenUsage({
      runId: run.id,
      stepId: step.id,
      provider: "codex",
      model: "gpt-4o",
      inputTokens: 100_000,
      outputTokens: 50_000
    });

    expect(record.runId).toBe(run.id);
    expect(record.stepId).toBe(step.id);
    expect(record.provider).toBe("codex");
    expect(record.model).toBe("gpt-4o");
    expect(record.inputTokens).toBe(100_000);
    expect(record.outputTokens).toBe(50_000);
    expect(record.costUsd).toBe(0.75);

    const summary = db.getCostSummary();
    expect(summary.todayTotalUsd).toBe(0.75);
    expect(summary.todayInputTokens).toBe(100_000);
    expect(summary.todayOutputTokens).toBe(50_000);
    expect(summary.byProvider).toContainEqual({
      provider: "codex",
      costUsd: 0.75,
      inputTokens: 100_000,
      outputTokens: 50_000
    });
    expect(summary.byProject).toContainEqual({
      projectKey: "test-proj",
      costUsd: 0.75,
      inputTokens: 100_000,
      outputTokens: 50_000
    });
  });

  it("includes costSummary in dashboard snapshot", () => {
    const db = createDatabase(":memory:");
    const mockConfig: MaestroConfig = {
      projectName: "octomynd-maestro",
      databasePath: ":memory:",
      worktreesPath: "/tmp/worktrees",
      execution: {} as any,
      dashboard: { enabled: true, host: "127.0.0.1", port: 4787 },
      autopilot: { enabled: false, pollIntervalMs: 30000, maxConcurrentGoals: 1 },
      runtime: { tokenEfficient: true },
      workGraph: { adoptionMode: "shadow" },
      skills: { enabled: true, catalogPath: "", versionsPath: "", projectKey: "", curator: { staleDays: 30, autoArchiveEnabled: false, pollIntervalMs: 3600000 } },
      telegram: { botToken: "", allowedUserId: null }
    };

    const snapshot = buildDashboardSnapshot(mockConfig, db);
    expect(snapshot.costSummary).toBeDefined();
    expect(snapshot.costSummary?.todayTotalUsd).toBe(0);
  });
});
