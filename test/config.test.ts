import { describe, expect, it } from "vitest";
import { loadConfig, validateRuntimeConfig } from "../src/config.js";

describe("config", () => {
  it("loads defaults without exposing a token", () => {
    const config = loadConfig(process.cwd(), {});

    expect(config.projectName).toBe("octomynd-maestro");
    expect(config.telegram.botToken).toBe("");
    expect(config.telegram.allowedUserId).toBeNull();
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
});
