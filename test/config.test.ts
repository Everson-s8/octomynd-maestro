import { describe, expect, it } from "vitest";
import { loadConfig, validateRuntimeConfig } from "../src/config.js";

describe("config", () => {
  it("loads defaults without exposing a token", () => {
    const config = loadConfig(process.cwd(), {});

    expect(config.projectName).toBe("octomynd-maestro");
    expect(config.telegram.botToken).toBe("");
    expect(config.telegram.allowedUserId).toBeNull();
    expect(config.dashboard).toEqual({
      enabled: true,
      host: "127.0.0.1",
      port: 4787
    });
    expect(config.autopilot).toEqual({
      enabled: true,
      pollIntervalMs: 30_000,
      maxConcurrentGoals: 1
    });
    expect(config.runtime).toEqual({
      tokenEfficient: true
    });
  });

  it("validates missing token", () => {
    const config = loadConfig(process.cwd(), {});

    expect(validateRuntimeConfig(config)).toContain("TELEGRAM_BOT_TOKEN is missing. Set it in .env.local.");
  });

  it("validates allowed user id", () => {
    const config = loadConfig(process.cwd(), {
      TELEGRAM_BOT_TOKEN: "configured",
      TELEGRAM_ALLOWED_USER_ID: "not-a-number"
    });

    expect(validateRuntimeConfig(config)).toContain("TELEGRAM_ALLOWED_USER_ID must contain only digits.");
  });

  it("keeps the dashboard bound to the local machine", () => {
    const config = loadConfig(process.cwd(), {
      TELEGRAM_BOT_TOKEN: "configured",
      MAESTRO_DASHBOARD_HOST: "0.0.0.0"
    });

    expect(validateRuntimeConfig(config)).toContain(
      "MAESTRO_DASHBOARD_HOST must stay local: use 127.0.0.1 or localhost."
    );
  });

  it("allows conservative autopilot tuning", () => {
    const config = loadConfig(process.cwd(), {
      MAESTRO_AUTOPILOT_ENABLED: "false",
      MAESTRO_AUTOPILOT_POLL_MS: "5000",
      MAESTRO_AUTOPILOT_MAX_CONCURRENT: "2"
    });

    expect(config.autopilot).toEqual({
      enabled: false,
      pollIntervalMs: 5_000,
      maxConcurrentGoals: 2
    });
  });

  it("allows disabling the token-efficient runtime adapter", () => {
    const config = loadConfig(process.cwd(), {
      MAESTRO_TOKEN_RUNTIME_ENABLED: "false"
    });

    expect(config.runtime.tokenEfficient).toBe(false);
  });
});
