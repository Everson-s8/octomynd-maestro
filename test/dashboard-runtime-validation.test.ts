import { describe, expect, it } from "vitest";
import { loadConfig, validateRuntimeConfig } from "../src/config.js";

describe("dashboard runtime validation", () => {
  it("does not require Telegram credentials for the dashboard server", () => {
    const config = loadConfig(process.cwd(), {});

    expect(validateRuntimeConfig(config, {}, { requireTelegram: false })).not.toContain(
      "TELEGRAM_BOT_TOKEN is missing. Set it in .env.local."
    );
  });
});
